// dsh-artifacts host: the store (versions, update semantics, storage) and the tool.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createStore, ArtifactError, normalizeType, fileKey } from '../src/store.js'
import { artifactsTool, resultText, resolveConfig, createHandler } from '../src/index.js'
import { TOOL_PARAMETERS, systemSection } from '../src/prompt.js'

const tmp = async () => mkdtemp(path.join(tmpdir(), 'dsh-artifacts-'))

test('create, update and rewrite keep every version', async t => {
  const dir = await tmp(); t.after(() => rm(dir, { recursive: true, force: true }))
  const store = createStore(dir)
  const a = await store.apply('s1', { command: 'create', id: 'quiz', type: 'application/vnd.ant.react', title: '期末卷子', content: 'export default () => <p>a</p>' }, { callId: 'c1' })
  assert.equal(a.version, 1)
  assert.equal(a.artifact.kind, 'react')
  const b = await store.apply('s1', { command: 'update', id: 'quiz', old_str: '<p>a</p>', new_str: '<p>b</p>' }, { callId: 'c2' })
  assert.equal(b.version, 2)
  assert.equal(b.artifact.versions[1].content, 'export default () => <p>b</p>')
  const c = await store.apply('s1', { command: 'rewrite', id: 'quiz', content: 'x', title: 'New' }, { callId: 'c3' })
  assert.equal(c.version, 3)
  const got = await store.get('s1', 'quiz')
  assert.deepEqual(got.versions.map(v => [v.n, v.command, v.callId]), [[1, 'create', 'c1'], [2, 'update', 'c2'], [3, 'rewrite', 'c3']])
  assert.equal(got.title, 'New')
  assert.deepEqual((await store.list('s1')).map(x => [x.id, x.versionCount, x.versions.length, 'content' in x.versions[0]]), [['quiz', 3, 3, false]])
  assert.deepEqual(await store.list('other'), [])
  // persisted: a fresh store reads the same file
  const again = await createStore(dir).get('s1', 'quiz')
  assert.equal(again.versions.length, 3)
  const file = JSON.parse(await readFile(path.join(dir, 'sessions', `${fileKey('s1')}.json`), 'utf8'))
  assert.equal(file.artifacts.quiz.versions.length, 3)
})

test('update refuses an old_str that is missing or not unique, and errors are for the model', async t => {
  const dir = await tmp(); t.after(() => rm(dir, { recursive: true, force: true }))
  const store = createStore(dir)
  await store.apply('s', { command: 'create', id: 'a', type: 'code', language: 'python', content: 'x = 1\nx = 1\n' })
  await assert.rejects(store.apply('s', { command: 'update', id: 'a', old_str: 'y', new_str: 'z' }), /not found/)
  await assert.rejects(store.apply('s', { command: 'update', id: 'a', old_str: 'x = 1', new_str: 'z' }), /2 times/)
  await assert.rejects(store.apply('s', { command: 'update', id: 'nope', old_str: 'x', new_str: 'z' }), /use command "create"/)
  await assert.rejects(store.apply('s', { command: 'create', id: 'bad id!', type: 'code', content: '' }), /id must be/)
  await assert.rejects(store.apply('s', { command: 'create', id: 'b', content: '' }), /needs type/)
  await assert.rejects(store.apply('s', { command: 'create', id: 'b', type: 'pdf', content: '' }), /unknown artifact type/)
  await assert.rejects(store.apply('s', { command: 'delete', id: 'a' }), /command must be/)
  assert.equal((await store.get('s', 'a')).versions.length, 1)
  assert.equal(normalizeType('React'), 'application/vnd.ant.react')
})

test('concurrent calls on one Session are applied in order', async t => {
  const dir = await tmp(); t.after(() => rm(dir, { recursive: true, force: true }))
  const store = createStore(dir)
  await store.apply('s', { command: 'create', id: 'n', type: 'code', content: '0' })
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.apply('s', { command: 'rewrite', id: 'n', content: String(i + 1) })))
  const got = await store.get('s', 'n')
  assert.equal(got.versions.length, 21)
  assert.deepEqual(got.versions.map(v => v.content), Array.from({ length: 21 }, (_, i) => String(i)))
})

test('window.storage keeps personal and shared values per artifact', async t => {
  const dir = await tmp(); t.after(() => rm(dir, { recursive: true, force: true }))
  const { storage } = createStore(dir)
  assert.equal(await storage.get('s', 'a', 'score'), null)
  assert.deepEqual(await storage.set('s', 'a', 'score', '42'), { key: 'score', value: '42', shared: false })
  await storage.set('s', 'a', 'score', 'shared!', true)
  assert.equal((await storage.get('s', 'a', 'score')).value, '42')
  assert.equal((await storage.get('s', 'a', 'score', true)).value, 'shared!')
  assert.equal(await storage.get('s', 'b', 'score'), null)
  await storage.set('s', 'a', 'score:2', 'x')
  assert.deepEqual((await storage.list('s', 'a', 'score')).keys, ['score', 'score:2'])
  assert.equal((await storage.delete('s', 'a', 'score')).deleted, true)
  assert.equal(await storage.get('s', 'a', 'score'), null)
  await assert.rejects(storage.set('s', 'a', 'has space', 'x'), ArtifactError)
  await assert.rejects(storage.set('s', 'a', 'k', 5), /strings/)
})

test('the tool returns the marker the chat card reads, and throws model-facing errors', async t => {
  const dir = await tmp(); t.after(() => rm(dir, { recursive: true, force: true }))
  const tool = artifactsTool(createStore(dir), { turnOf: () => 7 })
  assert.equal(tool.name, 'artifacts')
  assert.deepEqual(TOOL_PARAMETERS.required, ['command', 'id'])
  const exec = { agent: { id: 'sess-1' }, callId: 'call-1' }
  const r = await tool.execute({ command: 'create', id: 'p', type: 'text/html', title: 'Page', content: '<p>x</p>' }, exec)
  assert.equal(r.version, 1)
  assert.equal((await createStore(dir).get('sess-1', 'p')).versions[0].turn, 7)
  assert.match(r.text, /\[artifact:p@1\]$/)
  assert.deepEqual(tool.output.render({}, r), [{ type: 'text', text: r.text }])
  await assert.rejects(tool.execute({ command: 'update', id: 'p', old_str: 'nope', new_str: '' }, exec), /not found/)
  assert.match(resultText({ artifact: { id: 'p', title: 'T' }, version: 2 }, 'update'), /^Updated artifact "T"/)
  assert.match(systemSection(), /window\.claude\.complete/)
})

test('routes: auth first, artifacts, storage, and complete through ctx.llm', async t => {
  const dir = await tmp(); t.after(() => rm(dir, { recursive: true, force: true }))
  const store = createStore(dir)
  await store.apply('s', { command: 'create', id: 'q', type: 'react', content: 'x' })
  const calls = []
  const ctx = {
    get: name => name === 'llm' ? { async *stream(o) { calls.push(o); yield { type: 'text-delta', text: 'hel' }; yield { type: 'text-delta', text: 'lo' }; yield { type: 'finish', reason: { kind: 'stop' } } } }
      : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined,
  }
  let reject = 0
  const handler = createHandler(ctx, { store, config: resolveConfig({ completePerMinute: 2 }, { DSH_HOME: dir }), connection: { requestRejection: () => reject } })
  const request = async (method, url, body) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = Object.assign((async function* () { yield* chunks })(), { method, url, headers: {}, on() {} })
    let status, data = ''
    const res = { writableEnded: false, writeHead(s) { status = s }, end(b) { data = b; this.writableEnded = true } }
    await handler(req, res)
    return { status, body: JSON.parse(data) }
  }
  assert.equal((await request('GET', '/api/dsh-artifacts/s/s/a/q')).body.versions.length, 1)
  assert.equal((await request('GET', '/api/dsh-artifacts/s/s/a/none')).status, 404)
  assert.equal((await request('GET', '/api/dsh-artifacts/config')).body.cdn, 'https://esm.sh')
  assert.deepEqual((await request('POST', '/api/dsh-artifacts/s/s/a/q/storage', { op: 'set', key: 'k', value: 'v' })).body.value, { key: 'k', value: 'v', shared: false })
  assert.equal((await request('POST', '/api/dsh-artifacts/s/s/a/q/storage', { op: 'get', key: 'k' })).body.value.value, 'v')
  const c = await request('POST', '/api/dsh-artifacts/s/s/a/q/complete', { prompt: 'hi' })
  assert.deepEqual([c.status, c.body.text], [200, 'hello'])
  assert.equal(calls[0].provider, 'p')
  assert.equal(calls[0].messages[0].content[0].text, 'hi')
  await request('POST', '/api/dsh-artifacts/s/s/a/q/complete', { prompt: 'hi' })
  assert.equal((await request('POST', '/api/dsh-artifacts/s/s/a/q/complete', { prompt: 'hi' })).status, 429)
  assert.equal((await request('POST', '/api/dsh-artifacts/s/s/fix', { text: 'fix' })).status, 409)
  reject = 401
  assert.equal((await request('GET', '/api/dsh-artifacts/s/s/a/q')).status, 401)
})

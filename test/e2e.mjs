#!/usr/bin/env node
/**
 * End-to-end test of dsh-artifacts on a real dsh, with a scripted model and Chromium.
 * No real model and no network: the model is a local Anthropic-Messages server below,
 * and the CDN packages the previews import (React, ReactDOM, lucide-react, Babel) are
 * bundled locally with esbuild and served to the browser through Playwright routes.
 *
 * What it checks, in dsh's own conversation view:
 *  1. the model streams an `artifacts` create call: the chat card shows "generating", the
 *     right panel opens by itself and shows the code as it arrives;
 *  2. once saved, the panel switches to the preview: the React component renders (shadcn
 *     card, lucide icon), window.storage keeps a value, window.claude.complete answers;
 *  3. an `update` call adds version 2; the version picker goes back to version 1;
 *  4. a version that throws shows the error bar; "Try fixing" sends the error to the model,
 *     which rewrites it;
 *  5. Markdown and code artifacts render; download and copy are offered.
 *
 * Needs: dsh on PATH (or E2E_DSH), Playwright (E2E_PLAYWRIGHT) with Chromium (E2E_CHROMIUM),
 * and E2E_CDN_DIR: a folder with node_modules holding esbuild, react@18.3.1, react-dom@18.3.1,
 * lucide-react@0.460.0 and @babel/standalone@7.26.2.
 * Usage: node test/e2e.mjs   (E2E_KEEP=1 keeps the temp folder; screenshots go there)
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
// Other plugins to install beside this one, to check they coexist: checkouts with their own scripts/install.mjs.
const alongside = (process.env.E2E_ALONGSIDE || '').split(path.delimiter).filter(Boolean).map(d => path.resolve(d))
const shell = process.platform === 'win32'
const dshBin = process.env.E2E_DSH || 'dsh'
const tmp = await mkdtemp(path.join(os.tmpdir(), 'dsh-artifacts-e2e-'))
const home = path.join(tmp, 'home')
const osTemp = path.join(tmp, 'temp')
await mkdir(osTemp, { recursive: true })
const credential = /(^|_)(API_?KEY|AUTH_?TOKEN|ACCESS_?TOKEN|SECRET_?KEY)$|^(ANTHROPIC|OPENAI|DEEPSEEK|KKAI|AZURE_OPENAI|GEMINI|MOONSHOT|DASHSCOPE|OPENROUTER)_/i
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !credential.test(k))), TMPDIR: osTemp, TEMP: osTemp, TMP: osTemp, DSH_HOME: home, FAKE_LLM_KEY: 'scripted', DSH_PERMISSION_MODE: 'danger-full-access' }
const log = (...a) => console.log(...a)
const sleep = ms => new Promise(r => setTimeout(r, ms))
let failed = 0, passed = 0
const children = []

async function step(name, fn) {
  const t = Date.now()
  try { await fn(); passed++; log(`✔ ${name} (${Date.now() - t} ms)`) } catch (error) {
    failed++
    log(`✖ ${name}\n  ${String(error?.stack || error).split('\n').slice(0, 8).join('\n  ')}`)
    try { await page?.screenshot({ path: path.join(tmp, `fail-${failed}.png`) }) } catch {}
  }
}
async function until(what, fn, { timeout = 30_000, every = 200 } = {}) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v } catch (error) { last = error }
    await sleep(every)
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`)
}
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }); s.on('error', reject) })
function start(cmd, args, file) {
  const out = []
  const q = a => (shell && /[\s"]/.test(a) ? '"' + a + '"' : a)
  const child = spawn(q(cmd), args.map(q), { env, cwd: tmp, shell, stdio: ['ignore', 'pipe', 'pipe'], detached: !shell })
  child.stdout.on('data', d => out.push(String(d)))
  child.stderr.on('data', d => out.push(String(d)))
  children.push({ child, out, file })
  return { child, text: () => out.join('') }
}
const kill = child => { try { shell ? spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']) : process.kill(-child.pid, 'SIGTERM') } catch {} }

// ───────────── the scripted model ─────────────

const COUNTER = `import { useState, useEffect } from 'react'
import { Star } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

export default function Counter() {
  const [n, setN] = useState(0)
  const [ai, setAi] = useState('')
  useEffect(() => { window.storage.get('n').then(r => { if (r) setN(Number(r.value)) }) }, [])
  const inc = async () => { const v = n + 1; setN(v); await window.storage.set('n', String(v)) }
  return (
    <Card className="m-4">
      <CardHeader><CardTitle><Star size={16} data-icon="star" /> Clicks: <span id="n">{n}</span></CardTitle></CardHeader>
      <CardContent>
        <Button id="inc" onClick={inc}>+1</Button>
        <Button id="ask" onClick={async () => setAi(await window.claude.complete('ping from the artifact'))}>AI</Button>
        <p id="ai">{ai}</p>
      </CardContent>
    </Card>
  )
}
`
const BROKEN = `export default function Broken() {
  throw new Error('boom-e2e')
}
`
const DOC = '# 期末复习\n\n| 题号 | 分值 |\n|---|---|\n| 1 | 10 |\n\n公式 $a^2+b^2=c^2$\n'
const llmRequests = []

function textOf(content) {
  if (typeof content === 'string') return content
  return (content || []).map(b => (b.type === 'text' ? b.text : b.type === 'tool_result' ? textOf(b.content) : '')).join('\n')
}
function decide(body) {
  const system = JSON.stringify(body.system ?? '')
  const messages = body.messages || []
  const last = messages.at(-1)
  if (system.includes('interactive artifact')) return { text: `pong:${textOf(last?.content).slice(0, 40)}` }
  if (!(body.tools || []).some(t => t.name === 'artifacts')) return { text: 'Artifacts' }   // a title or summary call
  if (Array.isArray(last?.content) && last.content.some(b => b.type === 'tool_result')) return { text: '做好了，在右边。' }
  // what the member said since the model last spoke (dsh may add context messages after it)
  const said = messages.slice(messages.findLastIndex(m => m.role === 'assistant') + 1).filter(m => m.role === 'user').map(m => textOf(m.content)).join('\n')
  if (said.includes('请修复') || said.includes('Please fix')) return { tool: 'artifacts', input: { command: 'rewrite', id: 'counter', content: COUNTER.replace('Clicks:', '修好了:') }, slow: true }
  if (said.includes('做一个计数器')) return { tool: 'artifacts', input: { command: 'create', id: 'counter', type: 'application/vnd.ant.react', title: '计数器', content: COUNTER }, slow: true }
  if (said.includes('改一下')) return { tool: 'artifacts', input: { command: 'update', id: 'counter', old_str: 'Clicks:', new_str: '点击次数:' } }
  if (said.includes('弄坏它')) return { tool: 'artifacts', input: { command: 'rewrite', id: 'counter', content: BROKEN } }
  if (said.includes('写个文档')) return { tool: 'artifacts', input: { command: 'create', id: 'review-doc', type: 'text/markdown', title: '复习提纲', content: DOC } }
  if (said.includes('写段代码')) return { tool: 'artifacts', input: { command: 'create', id: 'qs', type: 'application/vnd.ant.code', language: 'python', title: 'quicksort.py', content: 'def qs(a):\n    return a  # TODO\n' } }
  return { text: 'ok' }
}
const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
const llm = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url.includes('/messages')) { res.writeHead(404).end(); return }
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const plan = decide(body)
  llmRequests.push({ body, plan })
  const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  sse(res, 'message_start', { message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage } })
  if (plan.tool) {
    sse(res, 'content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${Date.now()}`, name: plan.tool, input: {} } })
    const json = JSON.stringify(plan.input)
    // streamed in small pieces, slowly when the test watches the stream
    const pieces = plan.slow ? 60 : 4
    const size = Math.ceil(json.length / pieces)
    for (let i = 0; i < json.length; i += size) {
      sse(res, 'content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + size) } })
      if (plan.slow) await sleep(80)
    }
  } else {
    sse(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    sse(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: plan.text } })
  }
  sse(res, 'content_block_stop', { index: 0 })
  sse(res, 'message_delta', { delta: { stop_reason: plan.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } })
  sse(res, 'message_stop', {})
  res.end()
})
const llmPort = await freePort()
await new Promise(r => llm.listen(llmPort, '127.0.0.1', r))

// ───────────── the local "CDN" ─────────────

const cdnDir = process.env.E2E_CDN_DIR
assert.ok(cdnDir && existsSync(path.join(cdnDir, 'node_modules')), 'E2E_CDN_DIR must hold node_modules with esbuild, react, react-dom, lucide-react, @babel/standalone')
const cdnRequire = createRequire(path.join(cdnDir, 'package.json'))
const esbuild = await import(pathToFileURL(cdnRequire.resolve('esbuild')).href)
const names = mod => Object.keys(cdnRequire(mod)).filter(k => /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'default')
const reexport = (mod, keys) => `import * as M from '${mod}'; const D = M.default ?? M; export default D; export const { ${keys.join(', ')} } = D;`
// One build with code splitting, so every entry shares one React (as esm.sh's ?external does).
const entries = {
  'react@18.3.1': reexport('react', names('react')),
  'react@18.3.1/jsx-runtime': reexport('react/jsx-runtime', names('react/jsx-runtime')),
  'react-dom@18.3.1/client': reexport('react-dom/client', names('react-dom/client')),
  'react-dom@18.3.1': reexport('react-dom', names('react-dom')),
  'lucide-react@0.460.0': `export * from 'lucide-react'`,
}
const entryDir = path.join(tmp, 'cdn-src')
await mkdir(entryDir, { recursive: true })
const entryFiles = {}
for (const [key, code] of Object.entries(entries)) {
  const file = path.join(entryDir, `${key.replace(/[@/.]/g, '_')}.mjs`)
  await writeFile(file, code)
  entryFiles[key.replace(/[@/.]/g, '_')] = file
}
const built = await esbuild.build({ entryPoints: entryFiles, bundle: true, splitting: true, format: 'esm', outdir: path.join(tmp, 'cdn-out'), write: false, nodePaths: [path.join(cdnDir, 'node_modules')], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })
const CDN = {}
for (const f of built.outputFiles) {
  const base = path.basename(f.path)
  const key = Object.keys(entries).find(k => `${k.replace(/[@/.]/g, '_')}.js` === base)
  // chunks at one URL whatever entry imports them, so each module runs once (one React)
  CDN[key ?? base] = f.text.replace(/(["'])\.\/(chunk-[\w-]+\.js)\1/g, '$1https://esm.sh/__chunks/$2$1')
}
const babel = await readFile(cdnRequire.resolve('@babel/standalone/babel.min.js'), 'utf8')
const cdnHits = []

// ───────────── dsh with both plugins ─────────────

let page
const webPort = await freePort()
const base = `http://127.0.0.1:${webPort}`
let token, dsh
await step(`install dsh-artifacts${alongside.length ? ` beside ${alongside.map(d => path.basename(d)).join(', ')}` : ''} into a fresh profile`, async () => {
  spawnSync(dshBin, ['web', '--help'], { env, shell, encoding: 'utf8', cwd: tmp })
  const profile = path.join(home, 'profiles', 'web')
  assert.ok(existsSync(path.join(profile, 'package.json')), 'dsh created the web profile')
  for (const other of alongside) {
    const o = spawnSync(process.execPath, [path.join(other, 'scripts/install.mjs'), '--profile', 'web', '--no-bundles'], { env, encoding: 'utf8' })
    assert.equal(o.status, 0, `${other}: ${o.stdout}\n${o.stderr}`)
  }
  const r = spawnSync(process.execPath, [path.join(repo, 'scripts/install.mjs'), '--profile', 'web'], { env, encoding: 'utf8' })
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout, /dsh-artifacts/)
  // the plugins installed first are still there, beside this one
  const deps = JSON.parse(await readFile(path.join(profile, 'package.json'), 'utf8')).dependencies ?? {}
  for (const other of alongside) {
    const name = JSON.parse(await readFile(path.join(other, 'package.json'), 'utf8')).name
    assert.ok(deps[name], `${name} is still installed`)
  }
  await writeFile(path.join(profile, 'cordis.patch.yml'), `- id: llm-pi-ai
  config:
    providers:
      fake:
        displayName: Scripted
        api: anthropic-messages
        baseURL: http://127.0.0.1:${llmPort}
        apiKeyEnv: FAKE_LLM_KEY
        models:
          - id: scripted
            name: Scripted
            contextWindow: 200000
            reasoningEfforts: false
- id: agent-default-model
  config:
    provider: fake
    model: scripted
`)
  dsh = start(dshBin, ['web', '--no-open', '--port', String(webPort)], 'dsh.log')
  token = await until('dsh to print its login URL', () => /token=([\w-]+)/.exec(dsh.text())?.[1], { timeout: 120_000 })
})

const pwPath = process.env.E2E_PLAYWRIGHT
const pw = await import(pwPath ? pathToFileURL(pwPath).href : 'playwright')
const chromium = pw.chromium ?? pw.default?.chromium
// Chromium puts sandboxed iframes in their own process, where Playwright's routes do not reach;
// the local CDN below needs them in the page's process.
const browser = await chromium.launch({ ...(process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {}), args: ['--disable-features=IsolateSandboxedIframes'] })
const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, locale: 'zh-CN' })
await context.route(/^https:\/\/(esm\.sh|cdn\.jsdelivr\.net|cdn\.tailwindcss\.com)\//, route => {
  const url = new URL(route.request().url())
  cdnHits.push(url.href)
  const headers = { 'access-control-allow-origin': '*', 'content-type': 'text/javascript; charset=utf-8' }
  if (url.host === 'cdn.tailwindcss.com') return route.fulfill({ status: 200, headers, body: '/* tailwind stub */' })
  if (url.pathname.includes('@babel/standalone')) return route.fulfill({ status: 200, headers, body: babel })
  const key = url.pathname.replace(/^\//, '')
  if (url.host === 'esm.sh' && CDN[key]) return route.fulfill({ status: 200, headers, body: CDN[key] })
  if (url.host === 'esm.sh' && CDN[path.posix.basename(key)]) return route.fulfill({ status: 200, headers, body: CDN[path.posix.basename(key)] })
  return route.fulfill({ status: 404, headers, body: '' })
})
page = await context.newPage()
const pageErrors = []
page.on('pageerror', e => pageErrors.push(String(e)))
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })

const composer = () => page.locator('textarea, [contenteditable="true"]').last()
async function say(text) {
  const box = composer()
  await box.click()
  await box.fill(text)
  await page.keyboard.press('Enter')
}
const frameOf = async () => {
  const handle = await page.locator('[data-dsh-artifact-frame]').last().elementHandle()
  return handle && (await handle.contentFrame())
}
const panel = () => page.locator('[data-dsh-artifact-panel]').last()

await step('dsh opens with a conversation and the artifacts client face loaded', async () => {
  await page.goto(`${base}/?token=${token}`, { waitUntil: 'load' })
  // dsh's one-time preview notice
  const notice = page.getByRole('button', { name: /^(继续|Continue)$/ })
  await notice.click({ timeout: 15_000 }).catch(() => {})
  // a workspace folder for the conversation, picked in dsh's own folder dialog
  const ws = path.join(tmp, 'ws')
  await mkdir(ws, { recursive: true })
  await page.getByText('选择工作区').first().click()
  await page.getByRole('button', { name: '编辑路径' }).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type(ws)
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '打开', exact: true }).click()
  await until('the composer', async () => (await composer().count()) > 0, { timeout: 60_000 })
})

await step('a streamed create call shows a card, opens the panel and streams the code', async () => {
  await say('做一个计数器')
  await until('the card', () => page.locator('[data-dsh-artifact="counter"]').count())
  await until('the panel to open while the call streams', () => panel().count(), { timeout: 15_000 })
  const streamed = await until('partial code in the panel', async () => {
    const text = await page.locator('[data-dsh-artifact-code]').last().textContent().catch(() => '')
    return text && text.length > 20 && text.length < COUNTER.length ? text : null
  }, { timeout: 15_000, every: 50 })
  assert.ok(COUNTER.replace(/\s/g, '').startsWith(streamed.replace(/\s/g, '').replace(/^(\d+)+/, '').slice(0, 10)) || streamed.includes('import'), 'the panel shows the start of the code')
  await page.screenshot({ path: path.join(tmp, '1-streaming.png') })
})

await step('once saved, the preview renders the React component with shadcn and lucide', async () => {
  await until('version 1 in the card', () => page.locator('[data-dsh-artifact="counter"]').filter({ hasText: '版本 1' }).count(), { timeout: 20_000 })
  const frame = await until('the preview frame', frameOf, { timeout: 15_000 })
  await until('the component', async () => (await frame.locator('#n').count()) > 0, { timeout: 20_000 })
  assert.equal(await frame.locator('[data-icon="star"]').count(), 1, 'lucide icon rendered')
  assert.match(await frame.locator('h3').first().textContent(), /Clicks:\s*0/)
  await page.screenshot({ path: path.join(tmp, '2-preview.png') })
})

await step('window.storage keeps a value across a reload; window.claude.complete answers', async () => {
  let frame = await frameOf()
  await frame.locator('#inc').click()
  await frame.locator('#inc').click()
  await until('n = 2', async () => (await frame.locator('#n').textContent()) === '2')
  await page.locator('[data-dsh-artifact-panel] button[aria-label="刷新"]').click()
  frame = await until('a new frame', async () => { const f = await frameOf(); return f && (await f.locator('#n').count()) ? f : null }, { timeout: 15_000 })
  await until('n restored from storage', async () => (await frame.locator('#n').textContent()) === '2', { timeout: 10_000 })
  await frame.locator('#ask').click()
  await until('the model answer', async () => /pong:ping from the artifact/.test(await frame.locator('#ai').textContent()), { timeout: 15_000 })
})

await step('an update adds version 2; the picker shows version 1 again', async () => {
  await say('改一下标题')
  await until('version 2 in a card', () => page.locator('[data-dsh-artifact="counter"]').filter({ hasText: '版本 2' }).count(), { timeout: 20_000 })
  let frame = await until('preview of v2', async () => { const f = await frameOf(); return f && /点击次数/.test(await f.locator('h3').first().textContent().catch(() => '')) ? f : null }, { timeout: 20_000 })
  assert.ok(frame)
  const select = page.locator('[data-dsh-artifact-version]').last()
  assert.deepEqual(await select.locator('option').allTextContents(), ['版本 1', '版本 2 · 最新'])
  await select.selectOption('1')
  frame = await until('preview of v1', async () => { const f = await frameOf(); return f && /Clicks:/.test(await f.locator('h3').first().textContent().catch(() => '')) ? f : null }, { timeout: 15_000 })
  await page.locator('[data-dsh-artifact-panel] [data-mode="code"]').click()
  assert.match(await page.locator('[data-dsh-artifact-code]').last().textContent(), /Clicks:/)
  await page.locator('[data-dsh-artifact-panel] [data-mode="preview"]').click()
  await page.screenshot({ path: path.join(tmp, '3-versions.png') })
})

await step('a version that throws shows the error bar, and Try fixing sends it to the model', async () => {
  await say('弄坏它')
  await until('the error bar', () => page.locator('[data-dsh-artifact-fix]').count(), { timeout: 25_000 })
  assert.match(await page.locator('.dsha-error').textContent(), /boom-e2e/)
  await page.screenshot({ path: path.join(tmp, '4-error.png') })
  const before = llmRequests.length
  await page.locator('[data-dsh-artifact-fix]').click()
  await until('the model to get the error', () => llmRequests.slice(before).some(r => JSON.stringify(r.body.messages).includes('boom-e2e')), { timeout: 20_000 })
  await until('the fixed version', async () => { const f = await frameOf(); return f && /修好了/.test(await f.locator('h3').first().textContent().catch(() => '')) }, { timeout: 30_000 })
})

await step('Markdown and code artifacts', async () => {
  await say('写个文档')
  // the finished turn folds its call rows away; its tail keeps the artifact's card in sight
  await until('the markdown card in the turn tail', () => page.locator('[data-phase="tail"][data-dsh-artifact="review-doc"]:visible').count(), { timeout: 20_000 })
  await page.locator('[data-dsh-artifact="review-doc"]:visible').last().click()
  await until('the markdown panel', () => page.locator('[data-dsh-artifact-panel="review-doc"]').count())
  // the markdown renderer comes from the CDN, which this test does not serve: the source shows instead
  const frame = await until('the doc frame', frameOf)
  await until('the doc text', async () => /期末复习/.test(await frame.locator('body').textContent()), { timeout: 15_000 })
  await say('写段代码')
  await until('the code card', () => page.locator('[data-dsh-artifact="qs"]').filter({ hasText: '版本 1' }).count(), { timeout: 20_000 })
  await page.locator('[data-dsh-artifact="qs"]:visible').last().click()
  await until('the code panel', () => page.locator('[data-dsh-artifact-panel="qs"] [data-dsh-artifact-code]').count())
  assert.equal(await page.locator('[data-dsh-artifact-panel="qs"] [data-mode]').count(), 0, 'code has no preview toggle')
  assert.ok(await page.locator('[data-dsh-artifact-panel="qs"] .k').count() > 0, 'keywords highlighted')
  await page.locator('[data-dsh-artifact-panel="qs"] button[aria-label="复制"]').click()
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /def qs/)
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-dsh-artifact-panel="qs"] button[aria-label="下载"]').click()])
  assert.equal(download.suggestedFilename(), 'quicksort.py.py')
  await page.screenshot({ path: path.join(tmp, '5-code.png') })
})

await step('the artifacts are stored per session under $DSH_HOME/artifacts', async () => {
  const dir = path.join(home, 'artifacts', 'sessions')
  const files = (await import('node:fs/promises')).readdir(dir)
  const [file] = await files
  const doc = JSON.parse(await readFile(path.join(dir, file), 'utf8'))
  assert.deepEqual(Object.keys(doc.artifacts).sort(), ['counter', 'qs', 'review-doc'])
  assert.equal(doc.artifacts.counter.versions.length, 4)
  assert.deepEqual(pageErrors, [], 'no uncaught errors on dsh\'s page')
})

await browser.close().catch(() => {})
for (const { child } of children) if (child.exitCode === null) kill(child)
llm.close()
await sleep(300)
for (const { out, file } of children) await writeFile(path.join(tmp, file), out.join('')).catch(() => {})
log(`\n${passed} passed, ${failed} failed${failed || process.env.E2E_KEEP ? ` — logs and screenshots in ${tmp}` : ''}`)
if (!failed && !process.env.E2E_KEEP) await rm(tmp, { recursive: true, force: true }).catch(() => {})
process.exit(failed ? 1 : 0)

/**
 * dsh-artifacts — Cordis host plugin entry.
 *
 * - the `artifacts` tool every agent sees (create / update / rewrite), whose versions are
 *   kept per Session in `<dataDir>/sessions/<session>.json` (src/store.js);
 * - one system-prompt section telling the model when and how to make artifacts (src/prompt.js);
 * - authenticated routes under /api/dsh-artifacts/ the client face (web/client.js) reads:
 *   artifacts and their versions, the pages' window.storage and window.claude.complete,
 *   and a fallback that sends "fix this error" to the Session.
 *
 * Config (all optional, under the dsh-artifacts row of cordis.patch.yml):
 *   dataDir ($DSH_HOME/artifacts), cdn ('https://esm.sh': where React artifacts import packages from),
 *   completeModel ('provider/model' for window.claude.complete; default: dsh's default model),
 *   completePerMinute (20), prompt (true: add the system-prompt section).
 */
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { createStore, ArtifactError } from './store.js'
import { TOOL_NAME, TOOL_DESCRIPTION, TOOL_PARAMETERS, systemSection } from './prompt.js'

export const name = 'dsh-artifacts'
// No top-level inject: each part waits for its own services in a ctx.inject fiber, and
// agents / llm / agentDefaultModel are read with ctx.get when a request needs them.
export const inject = []

const PREFIX = '/api/dsh-artifacts/'
const JSON_LIMIT = 6 * 1024 * 1024
const COMPLETE_PROMPT_BYTES = 400_000

export function resolveConfig(raw = {}, env = process.env) {
  const home = path.resolve(env.DSH_HOME || path.join(os.homedir(), '.dsh'))
  return {
    dataDir: raw.dataDir ? path.resolve(raw.dataDir) : path.join(home, 'artifacts'),
    cdn: typeof raw.cdn === 'string' && /^https:\/\/[^\s"'<>]+$/.test(raw.cdn) ? raw.cdn.replace(/\/+$/, '') : 'https://esm.sh',
    completeModel: typeof raw.completeModel === 'string' ? raw.completeModel : undefined,
    completePerMinute: Number.isFinite(raw.completePerMinute) && raw.completePerMinute > 0 ? raw.completePerMinute : 20,
    prompt: raw.prompt !== false,
  }
}

/** The text the model gets back from one call; the trailing marker lets the chat card find the version. */
export function resultText({ artifact, version }, command) {
  const verb = command === 'create' && version === 1 ? 'Created' : 'Updated'
  return `${verb} artifact "${artifact.title}" (id ${artifact.id}, version ${version}). It is shown to the user in the artifact panel; do not repeat its content in your reply.\n[artifact:${artifact.id}@${version}]`
}

/** The `artifacts` tool definition for dsh's tool registry. */
export function artifactsTool(store, { turnOf = () => undefined } = {}) {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id ?? exec?.sessionId
      try {
        let turn
        try { turn = turnOf(exec) } catch {}
        const saved = await store.apply(sessionId, args ?? {}, { callId: exec?.callId, turn })
        return { ok: true, id: saved.artifact.id, version: saved.version, text: resultText(saved, args?.command) }
      } catch (error) {
        if (error instanceof ArtifactError) throw new Error(error.message)
        throw error
      }
    },
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(value))
}

async function readBody(req, max = JSON_LIMIT) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > max) throw new ArtifactError('request body too large', 413)
    chunks.push(chunk)
  }
  if (!size) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new ArtifactError('invalid JSON', 400) }
}

const parseModel = s => {
  const m = /^([^/\s]+)\/(.+)$/.exec(String(s || '').trim())
  return m ? { provider: m[1], model: m[2] } : null
}

/** One model call for window.claude.complete. */
export async function complete(ctx, config, prompt, { signal } = {}) {
  const llm = ctx.get?.('llm')
  if (typeof llm?.stream !== 'function') throw new ArtifactError('this dsh has no model runtime for window.claude.complete', 503)
  let target = parseModel(config.completeModel)
  if (!target) {
    try { const s = ctx.get?.('agentDefaultModel')?.currentSelection?.(); if (s?.provider && s?.model) target = { provider: s.provider, model: s.model } } catch {}
  }
  if (!target) throw new ArtifactError('no model is configured for window.claude.complete', 503)
  let text = ''
  let finish = null
  for await (const chunk of llm.stream({
    provider: target.provider, model: target.model,
    system: 'You answer one request sent by an interactive artifact (a web page the user is using). Follow the instructions in the request exactly, answer only what is asked, in the format asked.',
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens: 8192, signal,
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  if (finish?.kind === 'error') throw new ArtifactError(String(finish.failure?.message || finish.failure?.code || 'the model call failed').slice(0, 300), 502)
  if (finish?.kind === 'aborted') throw new ArtifactError('the call was cancelled', 499)
  return text
}

/** Requests per artifact page per minute for complete(). */
function rateLimiter(perMinute) {
  const hits = new Map()
  return key => {
    const now = Date.now()
    const list = (hits.get(key) ?? []).filter(t => now - t < 60_000)
    if (list.length >= perMinute) return false
    list.push(now)
    hits.set(key, list)
    return true
  }
}

export function createHandler(ctx, { store, config, connection }) {
  const allow = rateLimiter(config.completePerMinute)
  return async function handle(req, res) {
    const rejection = connection ? connection.requestRejection(req) : 403
    if (rejection) return sendJson(res, rejection, { error: rejection === 401 ? 'not signed in to dsh' : 'origin mismatch' })
    const url = new URL(req.url, 'http://x')
    const rest = url.pathname.slice(url.pathname.indexOf(PREFIX) + PREFIX.length).split('/').map(s => { try { return decodeURIComponent(s) } catch { return '' } })
    try {
      if (rest[0] === 'config' && req.method === 'GET') return sendJson(res, 200, { cdn: config.cdn })
      if (rest[0] !== 's' || !rest[1]) return sendJson(res, 404, { error: 'not found' })
      const sessionId = rest[1]
      if (rest.length === 2 && req.method === 'GET') return sendJson(res, 200, { artifacts: await store.list(sessionId) })
      if (rest[2] === 'fix' && rest.length === 3 && req.method === 'POST') {
        const body = await readBody(req, 64 * 1024)
        const text = String(body.text ?? '').slice(0, 20_000)
        if (!text) throw new ArtifactError('text is required')
        const agent = ctx.get?.('agents')?.get?.(sessionId)
        if (typeof agent?.followup !== 'function') throw new ArtifactError('that Session is not loaded', 409)
        const message = { id: randomUUID(), role: 'user', content: [{ type: 'text', text }] }
        if (agent.status === 'running' && typeof agent.steer === 'function') agent.steer(message)
        else agent.followup(message)
        return sendJson(res, 200, { ok: true })
      }
      if (rest[2] !== 'a' || !rest[3]) return sendJson(res, 404, { error: 'not found' })
      const id = rest[3]
      if (rest.length === 4 && req.method === 'GET') {
        const a = await store.get(sessionId, id)
        return a ? sendJson(res, 200, a) : sendJson(res, 404, { error: 'no such artifact' })
      }
      if (rest[4] === 'storage' && req.method === 'POST') {
        const b = await readBody(req)
        const shared = !!b.shared
        let out
        if (b.op === 'get') out = await store.storage.get(sessionId, id, b.key, shared)
        else if (b.op === 'set') out = await store.storage.set(sessionId, id, b.key, b.value, shared)
        else if (b.op === 'delete') out = await store.storage.delete(sessionId, id, b.key, shared)
        else if (b.op === 'list') out = await store.storage.list(sessionId, id, b.prefix ?? '', shared)
        else throw new ArtifactError('op must be get, set, delete or list')
        return sendJson(res, 200, { value: out })
      }
      if (rest[4] === 'complete' && req.method === 'POST') {
        const b = await readBody(req, COMPLETE_PROMPT_BYTES + 4096)
        const prompt = typeof b.prompt === 'string' ? b.prompt : ''
        if (!prompt.trim()) throw new ArtifactError('prompt is required')
        if (!allow(`${sessionId}/${id}`)) throw new ArtifactError(`window.claude.complete is limited to ${config.completePerMinute} calls a minute per artifact`, 429)
        const ac = new AbortController()
        req.on('close', () => { if (!res.writableEnded) ac.abort() })
        const timer = setTimeout(() => ac.abort(), 180_000)
        try { return sendJson(res, 200, { text: await complete(ctx, config, prompt, { signal: ac.signal }) }) } finally { clearTimeout(timer) }
      }
      return sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      if (error instanceof ArtifactError) return sendJson(res, error.status ?? 400, { error: error.message })
      ctx.logger?.warn?.(`dsh-artifacts: ${req.method} ${url.pathname} failed: ${error?.stack || error}`)
      return sendJson(res, 500, { error: 'internal error' })
    }
  }
}

export function apply(ctx, raw = {}) {
  const config = resolveConfig(raw)
  const store = createStore(config.dataDir)

  ctx.inject(['tools'], inner => {
    // The turn a version was made in, as dsh's present tool records it, so the finished
    // turn's tail can show that turn's artifact cards (the call rows fold away).
    const turnOf = exec => {
      const b = ctx.get?.('sessionProjections')?.stateOf?.(exec?.agent?.session, 'turnBoundary')
      return Number.isInteger(b?.lastTurn) ? b.lastTurn : undefined
    }
    inner.effect(() => inner.tools.register(artifactsTool(store, { turnOf })), 'dsh-artifacts: tool')
  })
  if (config.prompt) {
    ctx.inject(['systemPrompt'], inner => {
      inner.effect(() => inner.systemPrompt.section({ name: 'dsh-artifacts:guide', order: 5200, interpolate: false, text: systemSection() }), 'dsh-artifacts: prompt')
    })
  }
  ctx.inject(['webServer', 'connection'], inner => {
    const handler = createHandler(ctx, { store, config, connection: inner.connection })
    inner.effect(() => inner.webServer.register({ kind: 'prefix', path: PREFIX.replace(/\/$/, ''), handler }), 'dsh-artifacts: routes')
  })
}

/**
 * Artifact store: one JSON file per dsh Session under `<dataDir>/sessions/`,
 * holding every artifact that Session made and every version of it, plus the
 * key/value storage pages keep through `window.storage` under `<dataDir>/storage/`.
 *
 * The tool call's arguments stay in dsh's own Session log as well, so a store
 * file that is lost costs the panel its history, never the conversation.
 */
import path from 'node:path'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export const TYPES = Object.freeze({
  'application/vnd.ant.code': 'code',
  'text/markdown': 'markdown',
  'text/html': 'html',
  'image/svg+xml': 'svg',
  'application/vnd.ant.mermaid': 'mermaid',
  'application/vnd.ant.react': 'react',
})

/** Short names the model may use instead of the MIME-like ones. */
const ALIASES = { code: 'application/vnd.ant.code', markdown: 'text/markdown', md: 'text/markdown', html: 'text/html', svg: 'image/svg+xml', mermaid: 'application/vnd.ant.mermaid', react: 'application/vnd.ant.react', jsx: 'application/vnd.ant.react', tsx: 'application/vnd.ant.react' }

export const LIMITS = Object.freeze({ contentBytes: 2 * 1024 * 1024, versions: 200, artifacts: 500, storageValueBytes: 5 * 1024 * 1024, storageKeys: 1000 })

export class ArtifactError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'ArtifactError'; this.status = status }
}

export function normalizeType(type) {
  if (type == null || type === '') return undefined
  const t = String(type).trim().toLowerCase()
  if (TYPES[t]) return t
  if (ALIASES[t]) return ALIASES[t]
  throw new ArtifactError(`unknown artifact type "${type}"; use one of ${Object.keys(TYPES).join(', ')}`)
}

const SAFE = /^[A-Za-z0-9_.:-]{1,200}$/
/** A file-name-safe form of a Session id (ids are already safe; anything else is hashed into hex). */
export function fileKey(id) {
  const s = String(id ?? '')
  if (SAFE.test(s) && s !== '.' && s !== '..') return s.replace(/:/g, '_')
  return Buffer.from(s).toString('hex').slice(0, 200) || 'empty'
}

export function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id)
}

/** Count of non-overlapping occurrences of `needle` in `hay`. */
function occurrences(hay, needle) {
  let n = 0, i = 0
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length }
  return n
}

export function createStore(dataDir, { now = () => new Date().toISOString() } = {}) {
  const sessionsDir = path.join(dataDir, 'sessions')
  const storageDir = path.join(dataDir, 'storage')
  const chains = new Map()
  const cache = new Map()

  /** Run `fn` after every earlier write to the same file. */
  function serial(file, fn) {
    const prev = chains.get(file) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => {})
    chains.set(file, tail)
    tail.then(() => { if (chains.get(file) === tail) chains.delete(file) })
    return next
  }

  async function readJsonFile(file, empty) {
    if (cache.has(file)) return cache.get(file)
    let value
    try { value = JSON.parse(await readFile(file, 'utf8')) } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      value = empty()
    }
    cache.set(file, value)
    return value
  }

  async function writeJsonFile(file, value) {
    await mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
    await writeFile(tmp, JSON.stringify(value), 'utf8')
    try { await rename(tmp, file) } catch (error) { await rm(tmp, { force: true }).catch(() => {}); throw error }
    cache.set(file, value)
  }

  const sessionFile = sessionId => path.join(sessionsDir, `${fileKey(sessionId)}.json`)
  const emptySession = () => ({ v: 1, artifacts: {} })

  /**
   * Apply one `artifacts` tool call. Returns the artifact and the new version number.
   * Errors are ArtifactErrors whose message is written for the model.
   */
  function apply(sessionId, args = {}, { callId, turn } = {}) {
    if (!sessionId) throw new ArtifactError('artifacts needs a Session')
    const file = sessionFile(sessionId)
    return serial(file, async () => {
      const doc = structuredClone(await readJsonFile(file, emptySession))
      const command = String(args.command || 'create')
      const id = String(args.id ?? '').trim()
      if (!validId(id)) throw new ArtifactError('id must be 1-80 characters of letters, digits, "-" or "_", starting with a letter or digit (e.g. "quicksort-visualizer")')
      let a = doc.artifacts[id]
      let content
      if (command === 'create') {
        if (typeof args.content !== 'string') throw new ArtifactError('create needs content (the whole artifact)')
        const type = normalizeType(args.type) ?? a?.type
        if (!type) throw new ArtifactError(`create needs type: one of ${Object.keys(TYPES).join(', ')}`)
        if (!a) {
          if (Object.keys(doc.artifacts).length >= LIMITS.artifacts) throw new ArtifactError(`this conversation already has ${LIMITS.artifacts} artifacts; update an existing one`)
          a = doc.artifacts[id] = { id, type, title: '', language: undefined, createdAt: now(), versions: [] }
        }
        a.type = type
        content = args.content
      } else if (command === 'rewrite') {
        if (!a) throw new ArtifactError(`no artifact "${id}" in this conversation; use command "create"`)
        if (typeof args.content !== 'string') throw new ArtifactError('rewrite needs content (the whole new artifact)')
        if (args.type) a.type = normalizeType(args.type)
        content = args.content
      } else if (command === 'update') {
        if (!a) throw new ArtifactError(`no artifact "${id}" in this conversation; use command "create"`)
        if (typeof args.old_str !== 'string' || args.old_str === '') throw new ArtifactError('update needs old_str: text that appears exactly once in the current version')
        if (typeof args.new_str !== 'string') throw new ArtifactError('update needs new_str (may be empty to delete old_str)')
        const current = a.versions.at(-1)?.content ?? ''
        const n = occurrences(current, args.old_str)
        if (n !== 1) throw new ArtifactError(n === 0
          ? `old_str was not found in the current version of "${id}". It must match exactly, including whitespace. Use command "rewrite" with the whole content if needed.`
          : `old_str appears ${n} times in "${id}"; include more surrounding text so it appears exactly once`)
        const at = current.indexOf(args.old_str)
        content = current.slice(0, at) + args.new_str + current.slice(at + args.old_str.length)
      } else {
        throw new ArtifactError('command must be "create", "update" or "rewrite"')
      }
      if (Buffer.byteLength(content, 'utf8') > LIMITS.contentBytes) throw new ArtifactError(`content is over ${LIMITS.contentBytes / 1024 / 1024} MB`)
      if (args.title != null && String(args.title).trim()) a.title = String(args.title).trim().slice(0, 200)
      if (!a.title) a.title = id
      if (args.language != null && String(args.language).trim()) a.language = String(args.language).trim().slice(0, 40)
      a.versions.push({ content, command, callId: callId ? String(callId) : undefined, turn: Number.isInteger(turn) ? turn : undefined, createdAt: now() })
      if (a.versions.length > LIMITS.versions) a.versions.splice(0, a.versions.length - LIMITS.versions)
      a.updatedAt = now()
      doc.artifacts[id] = a
      await writeJsonFile(file, doc)
      return { artifact: view(a), version: a.versions.length }
    })
  }

  function view(a, { withContent = true } = {}) {
    return {
      id: a.id, type: a.type, kind: TYPES[a.type], title: a.title, language: a.language,
      createdAt: a.createdAt, updatedAt: a.updatedAt,
      versions: a.versions.map((v, i) => ({ n: i + 1, command: v.command, callId: v.callId, turn: v.turn, createdAt: v.createdAt, ...(withContent ? { content: v.content } : {}) })),
    }
  }

  async function get(sessionId, id) {
    const doc = await readJsonFile(sessionFile(sessionId), emptySession)
    const a = doc.artifacts[id]
    return a ? view(a) : null
  }

  async function list(sessionId) {
    const doc = await readJsonFile(sessionFile(sessionId), emptySession)
    return Object.values(doc.artifacts)
      .map(a => ({ ...view(a, { withContent: false }), versionCount: a.versions.length }))
      .sort((x, y) => String(x.updatedAt).localeCompare(String(y.updatedAt)))
  }

  // ---- window.storage: per artifact, kept across its versions ----
  const storageFile = (sessionId, id, shared) => path.join(storageDir, shared ? 'shared' : 'personal', fileKey(sessionId), `${fileKey(id)}.json`)
  const keyOk = key => typeof key === 'string' && key.length > 0 && key.length <= 200 && !/[\s/\\'"]/.test(key)

  const storage = {
    async get(sessionId, id, key, shared = false) {
      if (!keyOk(key)) throw new ArtifactError('storage keys are 1-200 characters without whitespace, slashes or quotes')
      const kv = await readJsonFile(storageFile(sessionId, id, shared), () => ({}))
      return Object.hasOwn(kv, key) ? { key, value: kv[key], shared: !!shared } : null
    },
    async set(sessionId, id, key, value, shared = false) {
      if (!keyOk(key)) throw new ArtifactError('storage keys are 1-200 characters without whitespace, slashes or quotes')
      if (typeof value !== 'string') throw new ArtifactError('storage values are strings (use JSON.stringify)')
      if (Buffer.byteLength(value, 'utf8') > LIMITS.storageValueBytes) throw new ArtifactError('storage values are at most 5 MB')
      const file = storageFile(sessionId, id, shared)
      return serial(file, async () => {
        const kv = { ...(await readJsonFile(file, () => ({}))) }
        if (!Object.hasOwn(kv, key) && Object.keys(kv).length >= LIMITS.storageKeys) throw new ArtifactError(`at most ${LIMITS.storageKeys} keys per artifact`)
        kv[key] = value
        await writeJsonFile(file, kv)
        return { key, value, shared: !!shared }
      })
    },
    async delete(sessionId, id, key, shared = false) {
      const file = storageFile(sessionId, id, shared)
      return serial(file, async () => {
        const kv = { ...(await readJsonFile(file, () => ({}))) }
        const had = Object.hasOwn(kv, key)
        delete kv[key]
        if (had) await writeJsonFile(file, kv)
        return { key, deleted: had, shared: !!shared }
      })
    },
    async list(sessionId, id, prefix = '', shared = false) {
      const kv = await readJsonFile(storageFile(sessionId, id, shared), () => ({}))
      return { keys: Object.keys(kv).filter(k => k.startsWith(String(prefix ?? ''))), prefix: String(prefix ?? ''), shared: !!shared }
    },
  }

  return { apply, get, list, storage, dir: dataDir }
}

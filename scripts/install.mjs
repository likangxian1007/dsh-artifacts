#!/usr/bin/env node
/**
 * Install (or re-link) dsh-artifacts into a dsh profile without moving any other package.
 * It stands alone: other plugins in the profile (dsh-projects, dsh-docs, ...) are left as they are.
 *
 * `dsh plugin add` runs pnpm, and pnpm makes node_modules match the profile's
 * package.json and lockfile. A package upgraded some other way (a self-updater, npm,
 * a copied folder) is therefore rolled back to the version the lockfile still names:
 * that is how deepseekbot 1.4.0 fell back to 1.3.1 on the first install. This script
 * finds such drift first and pins each drifted package to the version actually
 * installed in the same `add`, then checks that every other package kept its version.
 * Only packages that come from the npm registry are ever pinned: a dependency declared
 * as file:, link:, a git URL, a tarball URL or a path stays exactly as declared (pnpm
 * reinstalls it from that same source), and is never rewritten to a registry version,
 * which would fetch someone else's package of the same name or nothing at all.
 *
 * Usage: node scripts/install.mjs [--profile web] [--source <spec>] [--dry-run] [--remove]
 *   --source defaults to link:<this checkout>, so a restart picks up `git pull`.
 *   --remove takes dsh-artifacts out of the profile again (its data in $DSH_HOME/artifacts stays).
 * Exit code 1 when a package still changed version (the list is printed).
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { runCommand } from './run-command.mjs'
import { fromRegistry } from './dep-spec.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }
const profile = opt('profile') || 'web'
const root = path.resolve(here, '..')
const source = opt('source') || `link:${root}`
const dryRun = args.includes('--dry-run')

const home = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))
const dir = path.join(home, 'profiles', profile)
if (!existsSync(path.join(dir, 'package.json'))) {
  console.error(`no dsh profile "${profile}" at ${dir} (start it once with: dsh ${profile})`)
  process.exit(2)
}

const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }

const declared = () => readJson(path.join(dir, 'package.json'))?.dependencies ?? {}

/** name → installed version for every dependency the profile declares. */
function installed() {
  const deps = declared()
  const out = {}
  for (const name of Object.keys(deps)) out[name] = readJson(path.join(dir, 'node_modules', name, 'package.json'))?.version ?? null
  return out
}

/** name → version the lockfile records for the profile's direct dependencies. */
function locked() {
  let text = ''
  try { text = readFileSync(path.join(dir, 'pnpm-lock.yaml'), 'utf8').replace(/\r\n/g, '\n') } catch { return {} }
  const out = {}
  const start = text.search(/^importers:/m)
  const end = text.search(/^packages:/m)
  const block = start < 0 ? '' : text.slice(start, end > start ? end : undefined)
  for (const m of block.matchAll(/^ {6}('?)([^\s:']+)\1:\n {8}specifier: .*\n {8}version: (\S+)/gm)) {
    out[m[2]] = m[3].replace(/\(.*$/, '')
  }
  return out
}

const pluginName = readJson(path.join(root, 'package.json'))?.name
const ours = new Set([pluginName])

if (args.includes('--remove')) {
  const command = ['plugin', '--profile', profile, 'remove', pluginName]
  console.log(`dsh ${command.join(' ')}`)
  if (dryRun) process.exit(0)
  const run = runCommand('dsh', command, { stdio: 'inherit' })
  if (run.error || run.status !== 0) { console.error(`dsh plugin remove failed${run.error ? `: ${run.error.message}` : ` (exit ${run.status})`}`); process.exit(run.status || 2) }
  console.log(`ok: ${pluginName} removed from profile "${profile}". Restart dsh.`)
  process.exit(0)
}
const specs = declared()
const before = installed()
const lock = locked()
// Drift is a registry package whose installed version is not the one the lockfile resolved.
// For a local or git package the lockfile records its source, not a version: nothing to compare.
const pins = Object.entries(before)
  .filter(([name, version]) => !ours.has(name) && version && fromRegistry(specs[name]) && lock[name] && /^\d/.test(lock[name]) && lock[name] !== version)
  .map(([name, version]) => {
    console.log(`drift: ${name} is ${version} in node_modules but ${lock[name]} in the lockfile; pinning ${version}`)
    return `${name}@${version}`
  })

const command = ['plugin', '--profile', profile, 'add', source, ...pins]
console.log(`dsh ${command.join(' ')}`)
if (dryRun) process.exit(0)

let run
try { run = runCommand('dsh', command, { stdio: 'inherit' }) } catch (error) { console.error(error.message); process.exit(2) }
if (run.error) { console.error(`could not run dsh: ${run.error.message}`); process.exit(2) }
if (run.status !== 0) {
  console.error(`dsh plugin add failed (exit ${run.status ?? run.signal})`)
  process.exit(run.status || 1)
}

const after = installed()
const specsAfter = declared()
const moved = Object.entries(before).filter(([name, version]) => !ours.has(name) && version && after[name] !== version)
for (const [name, version] of moved) console.error(`changed: ${name} ${version} -> ${after[name] ?? 'removed'}`)
const respecified = Object.keys(specs).filter(name => !ours.has(name) && specsAfter[name] !== specs[name])
for (const name of respecified) console.error(`changed: ${name} is declared as ${specsAfter[name] ?? 'nothing'}, was ${specs[name]}`)
if (moved.length || respecified.length) {
  // Put each package back from where it came: its version for a registry package, its own spec otherwise.
  const names = [...new Set([...moved.map(([n]) => n), ...respecified])]
  const back = names.map(n => `${n}@${fromRegistry(specs[n]) ? before[n] ?? specs[n] : specs[n]}`)
  console.error(`restore with: dsh plugin --profile ${profile} add ${back.join(' ')}`)
  process.exit(1)
}
console.log(`ok: ${[...ours].join(', ')} installed into profile "${profile}"; ${Object.keys(before).filter(n => !ours.has(n)).length} other package(s) unchanged. Restart dsh to load it.`)

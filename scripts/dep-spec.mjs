/** Dependency specs in a dsh profile's package.json. */

/**
 * Whether a dependency spec resolves from the npm registry: a version, a range, a
 * dist-tag or an npm: alias. Anything with a protocol (file:, link:, git+…, http(s):,
 * github:, workspace:), a path or a tarball name, or a user/repo shorthand does not.
 */
export function fromRegistry(spec) {
  const s = String(spec ?? '').trim()
  if (!s) return false
  if (/^npm:/i.test(s)) return true
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return false
  if (/^(?:\.{1,2}|~)?[\\/]|^[A-Za-z]:[\\/]/.test(s)) return false
  if (/\.(tgz|tar\.gz|tar)$/i.test(s)) return false
  if (/^[^@\s][^\s]*\/[^\s]+$/.test(s)) return false
  return true
}

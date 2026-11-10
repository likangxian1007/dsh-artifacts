/**
 * Run a command found on PATH, with its arguments passed through intact on
 * Windows too.
 *
 * On Windows `dsh` is an npm shim (dsh.cmd), which only cmd.exe can start, and
 * Node's `shell: true` joins the arguments with plain spaces: a project folder
 * such as `C:\Users\kk\OneDrive\Desktop\我的 项目` then reaches dsh as two
 * arguments, and `&` or `(` in a folder name is read by cmd. So each argument
 * is quoted here, cmd gets the whole line verbatim, and characters cmd would
 * still expand inside quotes are refused with a clear message.
 */
import { spawnSync } from 'node:child_process'

/** One argument quoted for cmd.exe and for the C runtime rules the program behind it parses with. */
export function quoteWinArg(arg) {
  const s = String(arg)
  if (/["%\r\n]/.test(s)) throw new Error(`cannot pass ${JSON.stringify(s)} through cmd.exe safely (it holds " % or a line break); rename the folder or run the command by hand`)
  // Backslashes before the closing quote are doubled so they stay backslashes.
  return `"${s.replace(/(\\+)$/, '$1$1')}"`
}

/**
 * The cmd.exe command line that runs `file` with `args`. A bare command name
 * stays unquoted: a batch file started by a quoted name found on PATH reads
 * the wrong folder for %~dp0, and npm's dsh.cmd shim finds dsh's code by it.
 */
export function winCommandLine(file, args) {
  const name = /^[\w.-]+$/.test(file) ? file : quoteWinArg(file)
  return `/d /s /c "${[name, ...args.map(quoteWinArg)].join(' ')}"`
}

export function runCommand(file, args, options = {}, platform = process.platform) {
  if (platform !== 'win32') return spawnSync(file, args, options)
  const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe'
  return spawnSync(comspec, [winCommandLine(file, args)], { ...options, windowsVerbatimArguments: true })
}

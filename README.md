# dsh-artifacts

Claude-style Artifacts for DeepSeek Harness. The model gets an `artifacts` tool (create / update / rewrite). Each artifact streams into a card in the chat and into a panel in dsh's right dock. The panel has a preview and a code view, keeps every version (‹ version ›), and has copy, download and refresh buttons. When a page throws an error, an error bar offers "尝试修复" (Try fixing), which sends the error back to the conversation.

Types: React (`application/vnd.ant.react`, with Tailwind, shadcn/ui shims and any npm package from the CDN), HTML, SVG, Mermaid, Markdown (KaTeX math and highlighted code) and code.

Pages run in a sandboxed iframe with an opaque origin. Through a postMessage bridge to the host, they get:

- `window.storage` (`get`, `set`, `delete`, `list`), stored per artifact, personal or shared;
- `window.claude.complete(prompt)`, one model call, rate limited.

## Install

dsh-artifacts is a standalone dsh plugin. It does not need dsh-projects, and it can be installed beside dsh-projects and dsh-docs. Each plugin has its own tool, routes and panel ids.

```sh
git clone https://github.com/likangxian1007/dsh-artifacts
cd dsh-artifacts
node scripts/install.mjs --profile web --dry-run   # show what it will do
node scripts/install.mjs --profile web             # then restart dsh
```

The script links this checkout into the profile, so after a `git pull` you only need to restart dsh. It checks that no other package in the profile changes version. To uninstall, run `node scripts/install.mjs --profile web --remove`. Your data stays in `$DSH_HOME/artifacts`.

## Config

Every option is optional. They go on the `dsh-artifacts` row of `cordis.patch.yml`:

| key | default | meaning |
| --- | --- | --- |
| `dataDir` | `$DSH_HOME/artifacts` | where versions and storage live |
| `cdn` | `https://esm.sh` | where React artifacts import packages from |
| `completeModel` | dsh's default model | `provider/model` used by `window.claude.complete` |
| `completePerMinute` | `20` | rate limit per artifact |
| `prompt` | `true` | add the system-prompt section about artifacts |

## Tests

- `npm test` runs the unit tests.
- `npm run e2e` runs the end-to-end test against a real, installed dsh. It uses a scripted fake model and a local copy of the CDN, and needs these environment variables:
  - `E2E_PLAYWRIGHT` and `E2E_CHROMIUM`: paths to Playwright and its Chromium;
  - `E2E_CDN_DIR`: a folder with `react`, `react-dom` and `lucide-react` installed;
  - `E2E_ALONGSIDE` (optional): checkouts of other plugins to install first, such as dsh-projects and dsh-docs, separated by the path delimiter. Use it to check that the plugins coexist.

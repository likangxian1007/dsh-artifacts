// dsh-artifacts client face: its pure helpers (streaming argument parser, update preview,
// documents the previews run, import rewriting) and that it registers its slots.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function loadClient() {
  let module
  const fakeReact = { createElement: () => null, useState: () => [], useEffect() {}, useRef: () => ({}), useMemo: f => f(), useCallback: f => f, useSyncExternalStore: () => 0 }
  const window = { __ModuleLoader__: { load: def => { module = def.factory(name => { if (name === 'react') return fakeReact; throw new Error(name) }) } } }
  vm.runInNewContext(readFileSync(new URL('../web/client.js', import.meta.url), 'utf8'), { window, URL, console, setTimeout })
  return module
}
const client = loadClient()
const { lib } = client
// values made in the client's realm compare by content
const plain = v => JSON.parse(JSON.stringify(v))

test('parsePartialArgs reads fields from any prefix of the streamed arguments', () => {
  const full = JSON.stringify({ command: 'create', id: 'exam', type: 'application/vnd.ant.react', title: '期末 "卷子" 😀', content: 'line1\nline2 "q" \\ é 😀 end' })
  for (let n = 0; n <= full.length; n++) {
    const { args } = lib.parsePartialArgs(full.slice(0, n))
    for (const [k, v] of Object.entries(args)) {
      const want = JSON.parse(full)[k]
      assert.ok(typeof v === 'string' && want.startsWith(v), `prefix ${n}: ${k}=${JSON.stringify(v)}`)
    }
  }
  const { args, complete } = lib.parsePartialArgs(full)
  assert.deepEqual(plain(args), JSON.parse(full))
  assert.deepEqual([...complete].sort(), ['command', 'content', 'id', 'title', 'type'])
  const cut = lib.parsePartialArgs('{"id":"a","n":12,"o":{"x":"}"},"content":"ab')
  assert.deepEqual([cut.args.id, cut.args.n, cut.args.o.x, cut.args.content], ['a', 12, '}', 'ab'])
  assert.equal(cut.complete.has('content'), false)
  assert.deepEqual(plain(lib.parsePartialArgs('').args), {})
})

test('update streaming applies new_str only once old_str is complete', () => {
  const versions = [{ content: 'const a = 1\nconst b = 2\n' }]
  const partial = s => ({ args: lib.parsePartialArgs(s).args, complete: [...lib.parsePartialArgs(s).complete] })
  assert.equal(lib.streamContent(partial('{"command":"update","id":"x","old_str":"const b'), versions), versions[0].content)
  assert.equal(lib.streamContent(partial('{"command":"update","id":"x","old_str":"const b = 2","new_str":"const b = 4'), versions), 'const a = 1\nconst b = 4\n')
  assert.equal(lib.streamContent(partial('{"command":"create","id":"x","content":"new'), versions), 'new')
  assert.equal(lib.applyUpdate('abc', 'z', 'y'), null)
})

test('markers, addresses and file names', () => {
  assert.deepEqual(plain(lib.resultMarker('Created artifact "x".\n[artifact:exam-1@3]')), { id: 'exam-1', version: 3 })
  assert.equal(lib.resultMarker('error'), null)
  const address = lib.addressOf('sess/1:2', 'exam')
  assert.deepEqual(plain(lib.parseAddress(address)), { sessionId: 'sess/1:2', id: 'exam' })
  assert.equal(lib.parseAddress('dsh-resource://file/x'), null)
  assert.equal(lib.fileName({ type: 'application/vnd.ant.code', language: 'Python', title: '快速 排序' }), '快速_排序.py')
  assert.equal(lib.fileName({ type: 'application/vnd.ant.react', title: 'a/b' }), 'a_b.jsx')
  assert.equal(lib.kindOf('text/markdown'), 'markdown')
})

test('the highlighter keeps every character and marks comments, strings and keywords', () => {
  const code = '# c\ndef f(x):\n    return "s" + 1  # end'
  const parts = lib.highlight(code, 'code', 'python')
  assert.equal(parts.map(p => p[1]).join(''), code)
  assert.ok(parts.some(([c, s]) => c === 'k' && s === 'def'))
  assert.ok(parts.some(([c, s]) => c === 's' && s === '"s"'))
  assert.ok(parts.some(([c, s]) => c === 'c' && s === '# end'))
  const js = 'const x = `a${b}` // hi\n<div className="x">'
  assert.equal(lib.highlight(js, 'react').map(p => p[1]).join(''), js)
})

test('preview documents: runtime first, source embedded safely, imports onto the CDN', () => {
  const src = 'import { Card } from "@/components/ui/card"\nimport confetti from "canvas-confetti"\nexport default function A(){ return <p>{"</script><script>alert(1)</script>"}</p> }'
  const doc = lib.buildDocument('react', src, { cdn: 'https://cdn.example' })
  assert.ok(doc.indexOf('window.claude=') < doc.indexOf('importmap'))
  assert.ok(!doc.includes('</script><script>alert(1)'), 'source cannot close the script tag')
  const map = JSON.parse(doc.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1])
  assert.equal(map.imports.react, 'https://cdn.example/react@18.3.1')
  assert.ok(map.imports['@/components/ui/card'].startsWith('data:text/javascript'))
  const out = lib.rewriteImports('import a from "canvas-confetti"; import {x} from "react"; import y from "./y"; const z = import("lodash-es/sum")', 'https://cdn.example', map)
  assert.match(out, /from "https:\/\/cdn\.example\/canvas-confetti\?external=react,react-dom"/)
  assert.match(out, /from "react"/)
  assert.match(out, /from "\.\/y"/)
  assert.match(out, /import\("https:\/\/cdn\.example\/lodash-es\/sum\?external=react,react-dom"\)/)
  assert.match(lib.buildDocument('html', '<html><head><title>t</title></head><body>x</body></html>'), /<head><script>\(function\(\)\{/)
  assert.match(lib.buildDocument('html', '<p>bare</p>'), /^<!doctype html>.*<body><p>bare<\/p><\/body>/s)
  assert.match(lib.buildDocument('svg', '<svg viewBox="0 0 1 1"/>'), /<body><svg/)
  assert.match(lib.buildDocument('mermaid', 'graph TD; A-->B', { cdn: 'https://c' }), /https:\/\/c\/mermaid@/)
  assert.match(lib.buildDocument('markdown', '# T', { cdn: 'https://c' }), /marked@/)
  assert.equal(lib.buildDocument('code', 'x'), null)
})

test('apply registers the chat card, the tab type, its body and title', () => {
  const regs = []
  const effects = []
  const slots = { inject: (name, f) => { regs.push(name); f(); return () => {} }, register: (o, C) => ({ o, C }) }
  const tabs = []
  const ctx = {
    slots,
    inject(names, cb) {
      const inner = { effect: f => effects.push(f()), sidebarRight: { openResource() {} }, sidebarRightTabs: { register: d => { tabs.push(d); return () => {} } }, sessions: {} }
      cb(inner)
    },
  }
  client.apply(ctx)
  assert.deepEqual(regs.sort(), ['conversation.chat.turnTail', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'tool.call.toolview'])
  assert.equal(tabs[0].kind, 'artifact')
  assert.equal(tabs[0].canOpen(lib.addressOf('s', 'a')), true)
  assert.equal(tabs[0].canOpen('dsh-resource://file/x'), false)
})

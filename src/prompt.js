/**
 * What the model reads about artifacts: the tool description and one system-prompt
 * section, modelled on how Claude is told to use its artifacts.
 */

export const TOOL_NAME = 'artifacts'

export const TOOL_DESCRIPTION = `Create or change an artifact: substantial, self-contained content the user will want to view, run, reuse or iterate on, shown in a panel beside the conversation (rendered preview and code, every version kept). It streams to the user as you write it.
command "create": a new artifact (or a new version under an existing id) with the whole content. command "update": replace old_str (must appear exactly once in the current version, matched exactly) with new_str; use it for small changes (fewer than about 20 lines in at most 5 places), one call per place. command "rewrite": the whole new content, for larger changes. Keep the same id for every version of one artifact; a new id makes a separate artifact.`

export const TOOL_PROPERTIES = {
  command: { type: 'string', enum: ['create', 'update', 'rewrite'], description: 'create | update | rewrite' },
  id: { type: 'string', description: 'Stable kebab-case identifier, e.g. "exam-2024-programming". Reuse it for every version.' },
  type: { type: 'string', enum: ['application/vnd.ant.react', 'text/html', 'application/vnd.ant.code', 'text/markdown', 'image/svg+xml', 'application/vnd.ant.mermaid'], description: 'Required on create. React component, HTML page, code, Markdown document, SVG image or Mermaid diagram.' },
  title: { type: 'string', description: 'Short title shown to the user. Required on create.' },
  language: { type: 'string', description: 'For application/vnd.ant.code: the language, e.g. python, cpp, typescript.' },
  content: { type: 'string', description: 'The whole artifact (create, rewrite).' },
  old_str: { type: 'string', description: 'update: exact text to replace; must appear once.' },
  new_str: { type: 'string', description: 'update: replacement text (empty deletes).' },
}

export const TOOL_PARAMETERS = { type: 'object', properties: TOOL_PROPERTIES, required: ['command', 'id'], additionalProperties: false }

export function systemSection(names = {}) {
  const tool = names.tool || TOOL_NAME
  return `# Artifacts
You can show the user artifacts with the ${tool} tool: content in a panel beside the chat that the user can preview, run, copy, download and iterate on with you. The user sees it stream as you write it.

Use an artifact for: substantial content (roughly over 15 lines) the user will reuse or modify: documents, reports, articles, essays, stories; complete programs and scripts; interactive tools, games, simulations, visualizations, dashboards, quizzes, flashcards, exams and practice sets; diagrams; anything the user explicitly asks to see as an artifact, page, app or component. Prefer an interactive React artifact when interaction makes it better (e.g. a programming exam with an in-page editor that runs the code and checks answers, a quiz that grades itself, a simulator with sliders).
Do not use one for: short code or answers, conversational or explanatory replies, content that only makes sense inside the conversation, or a one-off question. One artifact per message unless asked for more. After writing it, say in a sentence or two what you made; do not repeat its content in the reply.

Updating: when the user asks to change an artifact, change it with the same id: "update" for small edits (old_str must match the current version exactly, once), "rewrite" for larger ones. Never paste the whole artifact into the chat.

Types:
- application/vnd.ant.react: one React function component (JSX, TypeScript allowed) with a default export and no required props. Style it with Tailwind classes (Tailwind is loaded; only use its standard classes, no arbitrary values like h-[600px]). Hooks via import { useState } from "react". Available imports: react, lucide-react (icons), recharts (charts), lodash, d3, mathjs, papaparse, xlsx (SheetJS), three, chart.js, tone, plotly, @/components/ui/* (shadcn/ui: card, button, input, textarea, label, badge, alert, tabs, select, checkbox, switch, slider, progress, separator, dialog, accordion, scroll-area, tooltip), and in fact any npm package by name (it is loaded from a CDN). No other files; no network fetches except CDNs. Write complete, working code with no placeholders or "// ..." gaps.
- text/html: a single complete HTML page; CSS and JS inline. Scripts may load from cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, esm.sh. Images only from those CDNs or inline SVG/data URLs.
- application/vnd.ant.code: source code in one language (set language). It is shown with syntax highlighting, not run.
- text/markdown: a formatted document (GFM tables, task lists, code fences; $...$ and $$...$$ math is rendered).
- image/svg+xml: one SVG image; give it a viewBox.
- application/vnd.ant.mermaid: Mermaid diagram source only (no \`\`\` fences).

Running code inside an artifact: JavaScript runs directly (eval it in a Web Worker or with new Function, capture console output, add a timeout for infinite loops). Python: load Pyodide from https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.mjs (import { loadPyodide }) and run with stdout captured. C/C++: compile and run in-page with a WebAssembly toolchain only if you know one that works from a CDN; otherwise simulate with test cases and say so. For an in-page editor use a <textarea> styled as code (monospace, tab key inserts spaces) or @uiw/react-codemirror.

The runtime the page gets: no localStorage or sessionStorage (they throw in the sandbox): keep state in React state, or persist across reloads with window.storage: await window.storage.get(key) → {key, value} or null, await window.storage.set(key, value: string) → {key, value}, await window.storage.delete(key), await window.storage.list(prefix) → {keys}; pass true as the last argument for data shared by everyone who opens this artifact. Values are strings (use JSON). AI inside the artifact: await window.claude.complete(prompt: string) → the model's text answer (one call, no memory: include the whole context, ask for JSON when you parse the answer, wrap JSON.parse in try/catch). Use it for grading free-text answers, hints, generated content. Errors thrown in the page are shown to the user with a button that asks you to fix them.`
}

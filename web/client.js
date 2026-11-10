/**
 * Client face of dsh-artifacts (loaded by dsh's client module system).
 *
 * - `tool.call.toolview` keyed `artifacts`: the card an artifact leaves in the chat. While the
 *   model is still writing the call it reads the raw argument prefix, streams it into the
 *   panel and opens the panel once, as Claude does.
 * - a right-dock tab type (kind `artifact`, address dsh-resource://artifact/<session>/<id>):
 *   the artifact panel with Preview / Code, the version picker, copy, download, refresh and
 *   "Try fixing" when the page throws.
 * - the preview runs in a sandboxed iframe (opaque origin) built here from the artifact's
 *   source: React (Babel in the page, Tailwind, an import map onto a CDN, shadcn/ui shims),
 *   HTML, SVG, Mermaid, Markdown. The page's window.claude.complete and window.storage reach
 *   the host routes through postMessage to this panel.
 *
 * Plain JS with React.createElement: the bundle has no build step. The factory's return
 * carries `lib` (the pure helpers) for the unit tests.
 */
window.__ModuleLoader__.load({
  id: 'dsh-artifacts',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useMemo, useCallback, useSyncExternalStore } = React

    // ───────────────────────── pure helpers ─────────────────────────

    const TYPES = {
      'application/vnd.ant.code': 'code', 'text/markdown': 'markdown', 'text/html': 'html',
      'image/svg+xml': 'svg', 'application/vnd.ant.mermaid': 'mermaid', 'application/vnd.ant.react': 'react',
      code: 'code', markdown: 'markdown', md: 'markdown', html: 'html', svg: 'svg', mermaid: 'mermaid', react: 'react', jsx: 'react', tsx: 'react',
    }
    const kindOf = type => TYPES[String(type || '').toLowerCase()] || (type ? 'code' : undefined)

    /**
     * Read the top-level fields of a JSON object from a prefix of it (the tool call's
     * arguments as they stream). A string cut mid-way comes back as far as it goes;
     * `complete` holds the fields whose value has ended.
     */
    function parsePartialArgs(raw) {
      const out = {}
      const complete = new Set()
      const s = String(raw || '')
      let i = 0
      const ws = () => { while (i < s.length && /\s/.test(s[i])) i++ }
      const str = () => {
        i++
        let v = ''
        while (i < s.length) {
          const c = s[i]
          if (c === '"') { i++; return { v, done: true } }
          if (c === '\\') {
            if (i + 1 >= s.length) return { v, done: false }
            const e = s[i + 1]
            if (e === 'u') {
              if (i + 6 > s.length) return { v, done: false }
              const hex = s.slice(i + 2, i + 6)
              if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { v, done: false }
              const code = parseInt(hex, 16)
              // a high surrogate waits for its low half
              if (code >= 0xd800 && code <= 0xdbff) {
                if (i + 12 > s.length) return { v, done: false }
                if (s[i + 6] === '\\' && s[i + 7] === 'u') {
                  const lo = parseInt(s.slice(i + 8, i + 12), 16)
                  if (lo >= 0xdc00 && lo <= 0xdfff) { v += String.fromCharCode(code, lo); i += 12; continue }
                }
              }
              v += String.fromCharCode(code); i += 6; continue
            }
            v += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' })[e] ?? e
            i += 2; continue
          }
          v += c; i++
        }
        return { v, done: false }
      }
      const skipValue = () => {
        let depth = 0
        while (i < s.length) {
          const c = s[i]
          if (c === '"') { const r = str(); if (!r.done) return false; continue }
          if (c === '{' || c === '[') depth++
          else if (c === '}' || c === ']') { if (depth === 0) return true; depth-- }
          else if (c === ',' && depth === 0) return true
          i++
        }
        return false
      }
      ws()
      if (s[i] !== '{') return { args: out, complete }
      i++
      while (i < s.length) {
        ws()
        if (s[i] === '}') break
        if (s[i] === ',') { i++; continue }
        if (s[i] !== '"') break
        const key = str()
        if (!key.done) break
        ws()
        if (s[i] !== ':') break
        i++; ws()
        if (i >= s.length) break
        if (s[i] === '"') {
          const val = str()
          out[key.v] = val.v
          if (val.done) complete.add(key.v); else break
        } else {
          const start = i
          if (!skipValue()) break
          try { out[key.v] = JSON.parse(s.slice(start, i)); complete.add(key.v) } catch {}
        }
      }
      return { args: out, complete }
    }

    /** What an `update` call makes of `previous`, or null when old_str is not in it. */
    function applyUpdate(previous, oldStr, newStr) {
      if (typeof previous !== 'string' || !oldStr) return null
      const at = previous.indexOf(oldStr)
      if (at < 0) return null
      return previous.slice(0, at) + (newStr ?? '') + previous.slice(at + oldStr.length)
    }

    /** The marker the host's resultText() ends a successful call's result with. */
    function resultMarker(text) {
      const m = /\[artifact:([A-Za-z0-9_-]+)@(\d+)\]\s*$/.exec(String(text || ''))
      return m ? { id: m[1], version: Number(m[2]) } : null
    }

    const ADDRESS = 'dsh-resource://artifact/'
    const addressOf = (sessionId, id) => `${ADDRESS}${encodeURIComponent(sessionId)}/${encodeURIComponent(id)}`
    function parseAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(ADDRESS)) return null
      const [s, a] = address.slice(ADDRESS.length).split('/')
      if (!s || !a) return null
      try { return { sessionId: decodeURIComponent(s), id: decodeURIComponent(a) } } catch { return null }
    }

    const EXT = { python: 'py', py: 'py', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', tsx: 'tsx', jsx: 'jsx', java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', 'c#': 'cs', go: 'go', rust: 'rs', ruby: 'rb', php: 'php', swift: 'swift', kotlin: 'kt', scala: 'scala', sql: 'sql', bash: 'sh', shell: 'sh', sh: 'sh', powershell: 'ps1', html: 'html', css: 'css', json: 'json', yaml: 'yml', yml: 'yml', xml: 'xml', markdown: 'md', r: 'r', lua: 'lua', dart: 'dart', haskell: 'hs', matlab: 'm', latex: 'tex', tex: 'tex' }
    function fileName(artifact) {
      const kind = kindOf(artifact?.type)
      const ext = kind === 'react' ? 'jsx' : kind === 'html' ? 'html' : kind === 'svg' ? 'svg' : kind === 'mermaid' ? 'mmd' : kind === 'markdown' ? 'md'
        : EXT[String(artifact?.language || '').toLowerCase()] || 'txt'
      const base = String(artifact?.title || artifact?.id || 'artifact').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'artifact'
      return `${base}.${ext}`
    }
    const MIME = { react: 'text/javascript', html: 'text/html', svg: 'image/svg+xml', mermaid: 'text/plain', markdown: 'text/markdown', code: 'text/plain' }

    // A small highlighter for the code view: comments, strings, numbers, keywords, tags.
    const KEYWORDS = new Set(('abstract and as async await break case catch class const continue def default del delete do elif else enum except export extends false final finally fn for from func function go if impl import in instanceof interface is lambda let match mod module mut new nil none not null or package pass private protected pub public raise return self static struct super switch this throw throws true try type typeof undefined use var void while with yield int float double char bool boolean long short unsigned signed string String auto namespace template typename using include define std vector map set printf scanf cout cin endl print len range True False None').split(' '))
    function highlight(code, kind, language) {
      const lang = String(language || kind || '').toLowerCase()
      const hashComments = /^(python|py|ruby|rb|bash|sh|shell|yaml|yml|r|powershell|perl|toml|dockerfile|makefile)$/.test(lang)
      const markup = kind === 'html' || kind === 'svg' || /^(html|xml|svg|vue)$/.test(lang)
      // groups: 1 comment, 2 string, 3 tag/decorator, 4 number, 5 word
      const re = markup
        ? /(<!--[\s\S]*?(?:-->|$)|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(<\/?[A-Za-z][\w:-]*|\/?>)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g
        : hashComments
          ? /(#[^\n]*)|("""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(@[A-Za-z_]\w*)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g
          : /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|^[ \t]*#[ \t]*(?:include|define|pragma|if|ifdef|ifndef|endif|else)\b[^\n]*)|(`(?:[^`\\]|\\.)*`?|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(<\/?[A-Z][\w.]*|<\/?[a-z][\w-]*(?=[\s/>]))|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/gm
      const parts = []
      let last = 0, m
      while ((m = re.exec(code))) {
        if (m[0].length === 0) { re.lastIndex++; continue }
        if (m.index > last) parts.push([null, code.slice(last, m.index)])
        const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 't' : m[4] ? 'n' : m[5] && KEYWORDS.has(m[5]) ? 'k' : null
        parts.push([cls, m[0]])
        last = m.index + m[0].length
      }
      if (last < code.length) parts.push([null, code.slice(last)])
      return parts
    }

    // ── the documents previews run ──
    const RUNTIME = `(function(){
  var send=function(m){try{m.__dshArtifact=1;parent.postMessage(m,'*')}catch(e){}};
  var seq=0,pending={};
  addEventListener('message',function(e){var d=e.data;if(e.source!==parent||!d||!d.__dshArtifactReply)return;var p=pending[d.id];if(!p)return;delete pending[d.id];if(d.error)p.reject(new Error(d.error));else p.resolve(d.value)});
  var rpc=function(method,params){return new Promise(function(resolve,reject){var id=++seq;pending[id]={resolve:resolve,reject:reject};send({type:'rpc',id:id,method:method,params:params})})};
  window.claude={complete:function(prompt){return rpc('complete',{prompt:String(prompt)})}};
  window.storage={
    get:function(key,shared){return rpc('storage',{op:'get',key:key,shared:!!shared})},
    set:function(key,value,shared){return rpc('storage',{op:'set',key:key,value:value,shared:!!shared})},
    delete:function(key,shared){return rpc('storage',{op:'delete',key:key,shared:!!shared})},
    list:function(prefix,shared){return rpc('storage',{op:'list',prefix:prefix||'',shared:!!shared})}
  };
  var report=function(message,stack){send({type:'error',message:String(message||'Error').slice(0,4000),stack:String(stack||'').slice(0,6000)})};
  window.__dshArtifactReport=report;
  addEventListener('error',function(e){
    var t=e.target;
    if(t&&t!==window&&t.tagName){if(t.tagName==='SCRIPT')report('Failed to load script '+(t.src||''));return}
    report(e.message||'Script error',e.error&&e.error.stack)
  },true);
  addEventListener('unhandledrejection',function(e){var r=e.reason;report(r&&r.message||String(r),r&&r.stack)});
  document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a)return;var href=a.getAttribute('href')||'';if(href.charAt(0)==='#'||/^javascript:/i.test(href))return;a.setAttribute('target','_blank');a.setAttribute('rel','noopener noreferrer')},true);
  send({type:'ready'});
})();`

    const scriptJson = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
    const runtimeTag = () => `<script>${RUNTIME}</script>`

    // shadcn/ui as artifacts import it (@/components/ui/*), rebuilt on Tailwind classes.
    const SHADCN = `import * as R from 'react';
const h=R.createElement;
export const cn=(...a)=>a.flat(Infinity).filter(Boolean).join(' ');
const fw=(tag,base)=>R.forwardRef(({className,...p},ref)=>h(tag,{ref,className:cn(base,className),...p}));
export const Card=fw('div','rounded-xl border border-slate-200 bg-white text-slate-900 shadow-sm');
export const CardHeader=fw('div','flex flex-col space-y-1.5 p-6');
export const CardTitle=fw('h3','text-xl font-semibold leading-none tracking-tight');
export const CardDescription=fw('p','text-sm text-slate-500');
export const CardContent=fw('div','p-6 pt-0');
export const CardFooter=fw('div','flex items-center p-6 pt-0');
const BV={default:'bg-slate-900 text-white hover:bg-slate-800',destructive:'bg-red-600 text-white hover:bg-red-700',outline:'border border-slate-300 bg-white hover:bg-slate-100',secondary:'bg-slate-100 text-slate-900 hover:bg-slate-200',ghost:'hover:bg-slate-100',link:'text-blue-600 underline-offset-4 hover:underline'};
const BS={default:'h-10 px-4 py-2',sm:'h-9 rounded-md px-3',lg:'h-11 rounded-md px-8',icon:'h-10 w-10'};
export const Button=R.forwardRef(({className,variant='default',size='default',asChild,...p},ref)=>h('button',{ref,className:cn('inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:pointer-events-none disabled:opacity-50',BV[variant]||BV.default,BS[size]||BS.default,className),...p}));
export const buttonVariants=({variant='default',size='default'}={})=>cn(BV[variant],BS[size]);
export const Input=fw('input','flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50');
export const Textarea=fw('textarea','flex min-h-[80px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500');
export const Label=fw('label','text-sm font-medium leading-none');
const BAV={default:'bg-slate-900 text-white',secondary:'bg-slate-100 text-slate-900',destructive:'bg-red-600 text-white',outline:'border border-slate-300 text-slate-900'};
export const Badge=({className,variant='default',...p})=>h('span',{className:cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold',BAV[variant]||BAV.default,className),...p});
export const Alert=R.forwardRef(({className,variant,...p},ref)=>h('div',{ref,role:'alert',className:cn('relative w-full rounded-lg border p-4',variant==='destructive'?'border-red-300 text-red-700':'border-slate-200',className),...p}));
export const AlertTitle=fw('h5','mb-1 font-medium leading-none tracking-tight');
export const AlertDescription=fw('div','text-sm');
export const Separator=({className,orientation='horizontal',...p})=>h('div',{role:'separator',className:cn('shrink-0 bg-slate-200',orientation==='horizontal'?'h-px w-full':'h-full w-px',className),...p});
export const Progress=({className,value=0,...p})=>h('div',{className:cn('relative h-4 w-full overflow-hidden rounded-full bg-slate-100',className),...p},h('div',{className:'h-full bg-slate-900 transition-all',style:{width:Math.max(0,Math.min(100,value||0))+'%'}}));
export const ScrollArea=fw('div','relative overflow-auto');
export const ScrollBar=()=>null;
export const Skeleton=fw('div','animate-pulse rounded-md bg-slate-100');
const useCtl=(value,def,on)=>{const[s,set]=R.useState(def);const v=value!==undefined?value:s;return[v,x=>{if(value===undefined)set(x);on&&on(x)}]};
export const Checkbox=R.forwardRef(({className,checked,defaultChecked,onCheckedChange,...p},ref)=>{const[v,set]=useCtl(checked,!!defaultChecked,onCheckedChange);return h('button',{ref,type:'button',role:'checkbox','aria-checked':!!v,onClick:()=>set(!v),className:cn('h-4 w-4 shrink-0 rounded-sm border border-slate-900 flex items-center justify-center text-[10px]',v?'bg-slate-900 text-white':'bg-white',className),...p},v?'✓':null)});
export const Switch=R.forwardRef(({className,checked,defaultChecked,onCheckedChange,...p},ref)=>{const[v,set]=useCtl(checked,!!defaultChecked,onCheckedChange);return h('button',{ref,type:'button',role:'switch','aria-checked':!!v,onClick:()=>set(!v),className:cn('inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',v?'bg-slate-900':'bg-slate-200',className),...p},h('span',{className:cn('block h-5 w-5 rounded-full bg-white shadow transition-transform',v?'translate-x-5':'translate-x-0.5')}))});
export const Slider=({className,value,defaultValue,onValueChange,onValueCommit,min=0,max=100,step=1,...p})=>{const[v,set]=useCtl(value,defaultValue||[min],onValueChange);return h('input',{type:'range',min,max,step,value:(v&&v[0])??min,onChange:e=>set([Number(e.target.value)]),onMouseUp:e=>onValueCommit&&onValueCommit([Number(e.target.value)]),className:cn('w-full accent-slate-900',className),...p})};
const TabsC=R.createContext(null);
export const Tabs=({value,defaultValue,onValueChange,className,children,...p})=>{const[v,set]=useCtl(value,defaultValue,onValueChange);return h(TabsC.Provider,{value:{v,set}},h('div',{className,...p},children))};
export const TabsList=fw('div','inline-flex h-10 items-center justify-center rounded-md bg-slate-100 p-1 text-slate-500');
export const TabsTrigger=({value,className,...p})=>{const c=R.useContext(TabsC);const on=c&&c.v===value;return h('button',{type:'button',role:'tab','aria-selected':on,onClick:()=>c&&c.set(value),className:cn('inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all',on?'bg-white text-slate-900 shadow-sm':'',className),...p})};
export const TabsContent=({value,className,...p})=>{const c=R.useContext(TabsC);return c&&c.v===value?h('div',{role:'tabpanel',className:cn('mt-2',className),...p}):null};
const SelC=R.createContext(null);
export const Select=({value,defaultValue,onValueChange,children})=>{const[v,set]=useCtl(value,defaultValue,onValueChange);const[open,setOpen]=R.useState(false);const labels=R.useRef({});return h(SelC.Provider,{value:{v,set:x=>{set(x);setOpen(false)},open,setOpen,labels}},h('div',{className:'relative'},children))};
export const SelectTrigger=({className,children,...p})=>{const c=R.useContext(SelC);return h('button',{type:'button',onClick:()=>c.setOpen(!c.open),className:cn('flex h-10 w-full items-center justify-between rounded-md border border-slate-300 bg-white px-3 py-2 text-sm',className),...p},children,h('span',{className:'opacity-50'},'▾'))};
export const SelectValue=({placeholder})=>{const c=R.useContext(SelC);return h('span',null,c.v!==undefined&&c.v!==''?(c.labels.current[c.v]??c.v):placeholder)};
export const SelectContent=({className,children})=>{const c=R.useContext(SelC);return h('div',{className:cn('absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-md border border-slate-200 bg-white p-1 shadow-md',c.open?'':'hidden',className)},children)};
export const SelectItem=({value,className,children})=>{const c=R.useContext(SelC);c.labels.current[value]=children;return h('div',{role:'option','aria-selected':c.v===value,onClick:()=>c.set(value),className:cn('cursor-pointer rounded-sm px-2 py-1.5 text-sm hover:bg-slate-100',c.v===value?'font-semibold':'',className)},children)};
export const SelectGroup=p=>h('div',p);export const SelectLabel=fw('div','px-2 py-1.5 text-sm font-semibold');
const DlgC=R.createContext(null);
export const Dialog=({open,defaultOpen,onOpenChange,children})=>{const[v,set]=useCtl(open,!!defaultOpen,onOpenChange);return h(DlgC.Provider,{value:{v,set}},children)};
export const DialogTrigger=({children,asChild,...p})=>{const c=R.useContext(DlgC);return asChild&&R.isValidElement(children)?R.cloneElement(children,{onClick:()=>c.set(true)}):h('button',{type:'button',onClick:()=>c.set(true),...p},children)};
export const DialogContent=({className,children,...p})=>{const c=R.useContext(DlgC);if(!c.v)return null;return h('div',{className:'fixed inset-0 z-50 flex items-center justify-center bg-black/50',onClick:()=>c.set(false)},h('div',{onClick:e=>e.stopPropagation(),className:cn('relative w-full max-w-lg rounded-lg bg-white p-6 shadow-lg',className),...p},children,h('button',{type:'button',onClick:()=>c.set(false),className:'absolute right-4 top-4 opacity-60 hover:opacity-100'},'✕')))};
export const DialogHeader=fw('div','flex flex-col space-y-1.5 mb-4');export const DialogFooter=fw('div','flex justify-end gap-2 mt-4');
export const DialogTitle=fw('h2','text-lg font-semibold');export const DialogDescription=fw('p','text-sm text-slate-500');
export const DialogClose=({children,...p})=>{const c=R.useContext(DlgC);return h('button',{type:'button',onClick:()=>c.set(false),...p},children)};
export const AlertDialog=Dialog;export const AlertDialogTrigger=DialogTrigger;export const AlertDialogContent=DialogContent;export const AlertDialogHeader=DialogHeader;export const AlertDialogFooter=DialogFooter;export const AlertDialogTitle=DialogTitle;export const AlertDialogDescription=DialogDescription;
export const AlertDialogAction=({onClick,...p})=>{const c=R.useContext(DlgC);return h(Button,{onClick:e=>{onClick&&onClick(e);c.set(false)},...p})};
export const AlertDialogCancel=({onClick,...p})=>{const c=R.useContext(DlgC);return h(Button,{variant:'outline',onClick:e=>{onClick&&onClick(e);c.set(false)},...p})};
const AccC=R.createContext(null);const ItemC=R.createContext(null);
export const Accordion=({type='single',collapsible,value,defaultValue,onValueChange,className,children})=>{const[v,set]=useCtl(value,defaultValue??(type==='multiple'?[]:''),onValueChange);return h(AccC.Provider,{value:{type,v,set}},h('div',{className},children))};
export const AccordionItem=({value,className,children})=>h(ItemC.Provider,{value},h('div',{className:cn('border-b',className)},children));
const isOpen=(c,i)=>c.type==='multiple'?(c.v||[]).includes(i):c.v===i;
export const AccordionTrigger=({className,children})=>{const c=R.useContext(AccC),i=R.useContext(ItemC);const o=isOpen(c,i);return h('button',{type:'button',onClick:()=>c.set(c.type==='multiple'?(o?c.v.filter(x=>x!==i):[...(c.v||[]),i]):(o?'':i)),className:cn('flex w-full items-center justify-between py-4 font-medium hover:underline',className)},children,h('span',{className:cn('transition-transform',o?'rotate-180':'')},'▾'))};
export const AccordionContent=({className,children})=>{const c=R.useContext(AccC),i=R.useContext(ItemC);return isOpen(c,i)?h('div',{className:cn('pb-4 text-sm',className)},children):null};
export const TooltipProvider=({children})=>children;export const Tooltip=({children})=>h('span',{className:'relative inline-block group'},children);
export const TooltipTrigger=({children,asChild,...p})=>asChild?children:h('span',p,children);
export const TooltipContent=({className,children})=>h('span',{className:cn('pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-slate-900 px-2 py-1 text-xs text-white group-hover:block',className)},children);
export const Popover=Dialog;export const PopoverTrigger=DialogTrigger;export const PopoverContent=DialogContent;
export const Table=fw('table','w-full caption-bottom text-sm');export const TableHeader=fw('thead','');export const TableBody=fw('tbody','');
export const TableRow=fw('tr','border-b transition-colors hover:bg-slate-50');export const TableHead=fw('th','h-10 px-2 text-left align-middle font-medium text-slate-500');
export const TableCell=fw('td','p-2 align-middle');export const TableCaption=fw('caption','mt-4 text-sm text-slate-500');
export const RadioGroup=({value,defaultValue,onValueChange,className,children})=>{const[v,set]=useCtl(value,defaultValue,onValueChange);return h(SelC.Provider,{value:{v,set,labels:{current:{}}}},h('div',{role:'radiogroup',className:cn('grid gap-2',className)},children))};
export const RadioGroupItem=({value,id,className})=>{const c=R.useContext(SelC);return h('input',{type:'radio',id,checked:c.v===value,onChange:()=>c.set(value),className:cn('h-4 w-4 accent-slate-900',className)})};
export const Avatar=fw('span','relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full');export const AvatarImage=fw('img','aspect-square h-full w-full');export const AvatarFallback=fw('span','flex h-full w-full items-center justify-center rounded-full bg-slate-100');
export default {};`

    const SHADCN_NAMES = ['accordion', 'alert', 'alert-dialog', 'avatar', 'badge', 'button', 'card', 'checkbox', 'dialog', 'input', 'label', 'popover', 'progress', 'radio-group', 'scroll-area', 'select', 'separator', 'skeleton', 'slider', 'switch', 'table', 'tabs', 'textarea', 'tooltip']

    /** Pinned versions for the packages artifacts import most; anything else goes to the CDN by name. */
    function importMap(cdn) {
      const react = `${cdn}/react@18.3.1`
      const ext = '?external=react,react-dom'
      const shadcn = `data:text/javascript;charset=utf-8,${encodeURIComponent(SHADCN)}`
      const imports = {
        react, 'react/jsx-runtime': `${react}/jsx-runtime`, 'react/jsx-dev-runtime': `${react}/jsx-dev-runtime`,
        'react-dom': `${cdn}/react-dom@18.3.1${ext}`, 'react-dom/client': `${cdn}/react-dom@18.3.1/client${ext}`,
        'lucide-react': `${cdn}/lucide-react@0.460.0${ext}`, recharts: `${cdn}/recharts@2.15.0${ext}`,
        lodash: `${cdn}/lodash@4.17.21`, d3: `${cdn}/d3@7.9.0`, mathjs: `${cdn}/mathjs@13.2.0`,
        papaparse: `${cdn}/papaparse@5.4.1`, xlsx: `${cdn}/xlsx@0.18.5`, three: `${cdn}/three@0.170.0`,
        'chart.js': `${cdn}/chart.js@4.4.6`, 'chart.js/auto': `${cdn}/chart.js@4.4.6/auto`, tone: `${cdn}/tone@15.0.4`,
        'plotly.js-dist-min': `${cdn}/plotly.js-dist-min@2.35.2`, plotly: `${cdn}/plotly.js-dist-min@2.35.2`,
        'framer-motion': `${cdn}/framer-motion@11.11.17${ext}`, 'react-markdown': `${cdn}/react-markdown@9.0.1${ext}`,
        '@/lib/utils': shadcn, '@/components/ui': shadcn,
      }
      for (const n of SHADCN_NAMES) imports[`@/components/ui/${n}`] = shadcn
      return { imports }
    }

    /** Bare specifiers the import map does not name go to the CDN by package name. */
    function rewriteImports(code, cdn, map) {
      return code.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\2/g, (all, head, q, spec) => {
        if (/^(\.|\/|https?:|data:|blob:)/.test(spec) || map.imports[spec]) return all
        if (spec.startsWith('@/')) return `${head}${q}${map.imports['@/components/ui']}${q}`
        return `${head}${q}${cdn}/${spec}${spec.includes('?') ? '&' : '?'}external=react,react-dom${q}`
      })
    }

    const BASE_STYLE = '<style>html,body{margin:0;padding:0}body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#fff;color:#0f172a}</style>'

    function reactDocument(source, cdn) {
      const map = importMap(cdn)
      const boot = `
const src = JSON.parse(document.getElementById('artifact-source').textContent);
const show = (e) => { const el = document.getElementById('root'); el.innerHTML = ''; const pre = document.createElement('pre'); pre.className = '__dsh_err'; pre.textContent = String(e && (e.stack || e.message) || e); el.appendChild(pre); };
try {
  if (!window.Babel) throw new Error('Could not load the JSX compiler (Babel) from the CDN. Check the network and refresh.');
  let out = Babel.transform(src, { filename: 'artifact.tsx', presets: [['react', { runtime: 'automatic' }], ['typescript', { isTSX: true, allExtensions: true }]] }).code;
  out = (${rewriteImports.toString()})(out, ${scriptJson(cdn)}, ${scriptJson(map)});
  const url = URL.createObjectURL(new Blob([out], { type: 'text/javascript' }));
  const [React, ReactDOM, mod] = await Promise.all([import('react'), import('react-dom/client'), import(url)]);
  const C = mod.default ?? Object.values(mod).find(v => typeof v === 'function');
  if (typeof C !== 'function' && (typeof C !== 'object' || C === null)) throw new Error('The artifact has no default export: export default a React component.');
  class Boundary extends React.Component {
    constructor(p) { super(p); this.state = { error: null } }
    static getDerivedStateFromError(error) { return { error } }
    componentDidCatch(error) { window.__dshArtifactReport(error && error.message, error && error.stack) }
    render() { return this.state.error ? React.createElement('pre', { className: '__dsh_err' }, String(this.state.error.stack || this.state.error.message || this.state.error)) : React.createElement(C) }
  }
  ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Boundary));
} catch (e) { window.__dshArtifactReport(e && e.message, e && e.stack); show(e); }`
      return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${runtimeTag()}
<script type="importmap">${scriptJson(map)}</script>
<script src="https://cdn.tailwindcss.com/3.4.16"></script>
<script src="https://cdn.jsdelivr.net/npm/@babel/standalone@7.26.2/babel.min.js"></script>
${BASE_STYLE}<style>#root{min-height:100vh}.__dsh_err{margin:16px;padding:12px;border-radius:8px;background:#fef2f2;color:#b91c1c;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap}</style>
</head><body><div id="root"></div>
<script type="application/json" id="artifact-source">${scriptJson(source)}</script>
<script type="module">${boot}</script></body></html>`
    }

    function htmlDocument(source) {
      const s = String(source)
      const tag = runtimeTag()
      if (/<head[^>]*>/i.test(s)) return s.replace(/<head[^>]*>/i, m => m + tag)
      if (/<html[^>]*>/i.test(s)) return s.replace(/<html[^>]*>/i, m => m + '<head>' + tag + '</head>')
      if (/<!doctype[^>]*>/i.test(s)) return s.replace(/<!doctype[^>]*>/i, m => m + tag)
      return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${tag}</head><body>${s}</body></html>`
    }

    function svgDocument(source) {
      return `<!doctype html><html><head><meta charset="utf-8">${runtimeTag()}<style>html,body{margin:0;height:100%;background:#fff}body{display:flex;align-items:center;justify-content:center}body>svg{max-width:100%;max-height:100vh;height:auto}</style></head><body>${String(source)}</body></html>`
    }

    function mermaidDocument(source, cdn) {
      return `<!doctype html><html><head><meta charset="utf-8">${runtimeTag()}${BASE_STYLE}<style>#d{display:flex;justify-content:center;padding:24px}#d svg{max-width:100%;height:auto}</style></head><body><div id="d"></div>
<script type="application/json" id="artifact-source">${scriptJson(String(source))}</script>
<script type="module">
try {
  const { default: mermaid } = await import(${scriptJson(`${cdn}/mermaid@11.4.1`)});
  mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });
  const src = JSON.parse(document.getElementById('artifact-source').textContent).replace(/^\\s*\`\`\`(?:mermaid)?\\s*|\\s*\`\`\`\\s*$/g, '');
  const { svg } = await mermaid.render('dsh-mermaid', src);
  document.getElementById('d').innerHTML = svg;
} catch (e) { window.__dshArtifactReport(e && e.message, e && e.stack); document.getElementById('d').textContent = String(e && e.message || e); }
</script></body></html>`
    }

    function markdownDocument(source, cdn) {
      return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${runtimeTag()}
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.10.0/styles/github.min.css">
${BASE_STYLE}<style>
#md{max-width:760px;margin:0 auto;padding:32px 28px 64px;font-size:15px;line-height:1.7}
#md h1,#md h2,#md h3{line-height:1.3;margin:1.6em 0 .6em}#md h1{font-size:1.9em;margin-top:.2em}#md h2{font-size:1.45em;border-bottom:1px solid #e2e8f0;padding-bottom:.3em}#md h3{font-size:1.2em}
#md p,#md ul,#md ol,#md blockquote,#md table,#md pre{margin:0 0 1em}#md code{font:0.88em ui-monospace,Menlo,Consolas,monospace;background:#f1f5f9;border-radius:4px;padding:.15em .35em}
#md pre{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;overflow:auto}#md pre code{background:none;padding:0}
#md blockquote{border-left:3px solid #4d6bfe;padding:.2em 1em;color:#475569;background:#f8faff}#md table{border-collapse:collapse;display:block;overflow:auto}#md th,#md td{border:1px solid #e2e8f0;padding:6px 12px}#md th{background:#f8fafc}
#md a{color:#4d6bfe}#md img{max-width:100%}#md hr{border:none;border-top:1px solid #e2e8f0;margin:2em 0}#md li>input[type=checkbox]{margin-right:.4em}
</style></head><body><article id="md"></article>
<script type="application/json" id="artifact-source">${scriptJson(String(source))}</script>
<script type="module">
const src = JSON.parse(document.getElementById('artifact-source').textContent);
const el = document.getElementById('md');
try {
  const [{ marked }, katex, hljs] = await Promise.all([
    import(${scriptJson(`${cdn}/marked@14.1.4`)}),
    import(${scriptJson(`${cdn}/katex@0.16.11`)}).then(m => m.default).catch(() => null),
    import(${scriptJson(`${cdn}/highlight.js@11.10.0/lib/common`)}).then(m => m.default).catch(() => null),
  ]);
  const math = [];
  const keep = (tex, display) => { math.push({ tex, display }); return '\\u0000M' + (math.length - 1) + '\\u0000'; };
  const fenced = [];
  let text = src.replace(/(\`\`\`[\\s\\S]*?\`\`\`|\`[^\`\\n]+\`)/g, m => { fenced.push(m); return '\\u0000F' + (fenced.length - 1) + '\\u0000'; });
  text = text.replace(/\\$\\$([\\s\\S]+?)\\$\\$/g, (_, t) => keep(t, true)).replace(/(^|[^\\\\$])\\$([^\\s$](?:[^$\\n]*?[^\\s$])?)\\$(?!\\d)/g, (_, pre, t) => pre + keep(t, false));
  text = text.replace(/\\u0000F(\\d+)\\u0000/g, (_, i) => fenced[i]);
  let out = marked.parse(text, { gfm: true });
  out = out.replace(/\\u0000M(\\d+)\\u0000/g, (_, i) => { const m = math[i]; try { return katex ? katex.renderToString(m.tex, { displayMode: m.display, throwOnError: false }) : m.tex } catch { return m.tex } });
  el.innerHTML = out;
  if (hljs) el.querySelectorAll('pre code').forEach(b => { try { hljs.highlightElement(b) } catch {} });
} catch (e) { window.__dshArtifactReport(e && e.message, e && e.stack); el.textContent = src; el.style.whiteSpace = 'pre-wrap'; }
</script></body></html>`
    }

    /** The document an artifact's preview iframe runs, or null for kinds shown as code only. */
    function buildDocument(kind, source, { cdn = 'https://esm.sh' } = {}) {
      switch (kind) {
        case 'react': return reactDocument(String(source ?? ''), cdn)
        case 'html': return htmlDocument(source ?? '')
        case 'svg': return svgDocument(source ?? '')
        case 'mermaid': return mermaidDocument(source ?? '', cdn)
        case 'markdown': return markdownDocument(source ?? '', cdn)
        default: return null
      }
    }

    /** The content shown while a call streams, given the versions saved before it. */
    function streamContent(stream, versions) {
      const a = stream.args || {}
      if (a.command === 'update') {
        const prev = versions.at(-1)?.content ?? ''
        if (typeof a.old_str !== 'string' || !(stream.complete || []).includes('old_str')) return prev
        return applyUpdate(prev, a.old_str, a.new_str ?? '') ?? prev
      }
      return typeof a.content === 'string' ? a.content : ''
    }

    const lib = { parsePartialArgs, applyUpdate, resultMarker, addressOf, parseAddress, fileName, highlight, buildDocument, importMap, rewriteImports, kindOf, streamContent, RUNTIME }

    // ───────────────────────── locale ─────────────────────────

    const zh = () => {
      try { const saved = JSON.parse(localStorage.getItem('dsh-projects.lang') || 'null'); if (saved === 'en' || saved === 'zh') return saved === 'zh' } catch {}
      return /^zh/i.test(document.documentElement.lang || navigator.language || '')
    }
    const T = {
      zh: { kind: { react: '交互组件', html: '网页', svg: '图像', mermaid: '图表', markdown: '文档', code: '代码' }, version: n => `版本 ${n}`, of: (n, m) => `版本 ${n} / ${m}`, latest: '最新', generating: '正在生成…', editing: '正在编辑…', open: '点击打开', preview: '预览', code: '代码', copy: '复制', copied: '已复制', download: '下载', refresh: '刷新', failed: '创建失败', fix: '尝试修复', dismiss: '关闭', error: '运行出错', sent: '已发送给模型', none: '还没有内容', loading: '加载中…', missing: '找不到这个 Artifact', prev: '上一版', next: '下一版', fixPrompt: (title, msg) => `Artifact「${title}」运行时报错：\n\n\`\`\`\n${msg}\n\`\`\`\n\n请修复它。` },
      en: { kind: { react: 'Interactive artifact', html: 'Web page', svg: 'Image', mermaid: 'Diagram', markdown: 'Document', code: 'Code' }, version: n => `Version ${n}`, of: (n, m) => `Version ${n} of ${m}`, latest: 'Latest', generating: 'Generating…', editing: 'Editing…', open: 'Click to open', preview: 'Preview', code: 'Code', copy: 'Copy', copied: 'Copied', download: 'Download', refresh: 'Refresh', failed: 'Could not create the artifact', fix: 'Try fixing', dismiss: 'Dismiss', error: 'Error running the artifact', sent: 'Sent to the model', none: 'Nothing yet', loading: 'Loading…', missing: 'This artifact is not available here', prev: 'Previous version', next: 'Next version', fixPrompt: (title, msg) => `The artifact "${title}" threw an error:\n\n\`\`\`\n${msg}\n\`\`\`\n\nPlease fix it.` },
    }
    const t = () => (zh() ? T.zh : T.en)

    // ───────────────────────── client store ─────────────────────────

    const api = p => new URL(`api/dsh-artifacts/${p}`, document.baseURI)
    async function call(p, body) {
      const res = await fetch(api(p), body === undefined
        ? { credentials: 'same-origin', headers: { accept: 'application/json' } }
        : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) })
      let data = null
      try { data = await res.json() } catch {}
      if (!res.ok) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status })
      return data
    }

    let config = { cdn: 'https://esm.sh' }
    let configAsked = false
    const askConfig = () => { if (configAsked) return; configAsked = true; call('config').then(c => { if (c?.cdn) config = { ...config, cdn: c.cdn } }).catch(() => { configAsked = false }) }

    /** `${sessionId}\n${id}` → { data, loading, error, streams: Map(callId → stream), rev } */
    const entries = new Map()
    const listeners = new Set()
    const titles = new Map()
    const notify = () => { for (const l of [...listeners]) try { l() } catch {} }
    const keyOf = (sid, id) => `${sid}\n${id}`
    const entry = (sid, id) => {
      const k = keyOf(sid, id)
      let e = entries.get(k)
      if (!e) { e = { data: null, loading: false, error: null, streams: new Map(), rev: 0 }; entries.set(k, e) }
      return e
    }
    const touch = (e, patch) => { Object.assign(e, patch); e.rev++; notify() }
    const subscribe = l => { listeners.add(l); return () => listeners.delete(l) }

    function load(sid, id, { force = false } = {}) {
      if (!sid || !id) return
      const e = entry(sid, id)
      if (e.loading || (e.data && !force)) return
      touch(e, { loading: true })
      call(`s/${encodeURIComponent(sid)}/a/${encodeURIComponent(id)}`)
        .then(data => { titles.set(addressOf(sid, id), data.title); touch(e, { data, loading: false, error: null }) })
        .catch(error => touch(e, { loading: false, error: error.status === 404 ? 'missing' : error.message }))
    }
    function setStream(sid, id, callId, stream) {
      const e = entry(sid, id)
      const prev = e.streams.get(callId)
      if (prev && prev.raw === stream.raw && prev.done === stream.done) return
      e.streams.set(callId, { startedAt: prev?.startedAt ?? Date.now(), ...stream })
      if (stream.args?.title) titles.set(addressOf(sid, id), stream.args.title)
      e.rev++
      notify()
    }
    function useEntry(sid, id) {
      const k = keyOf(sid, id)
      const rev = useSyncExternalStore(subscribe, () => entries.get(k)?.rev ?? -1)
      useEffect(() => { if (sid && id) load(sid, id) }, [sid, id])
      return useMemo(() => (sid && id ? entries.get(k) ?? null : null), [k, rev])
    }

    /** sessionId → { data: [artifact meta], loading, rev }: what a turn's tail reads. */
    const lists = new Map()
    function loadList(sid, { force = false } = {}) {
      if (!sid) return
      let l = lists.get(sid)
      if (!l) { l = { data: null, loading: false, rev: 0, again: false }; lists.set(sid, l) }
      if (l.loading) { if (force) l.again = true; return }
      if (l.data && !force) return
      l.loading = true
      call(`s/${encodeURIComponent(sid)}`)
        .then(r => { l.data = r.artifacts || []; for (const a of l.data) titles.set(addressOf(sid, a.id), a.title) }, () => {})
        .finally(() => { l.loading = false; l.rev++; notify(); if (l.again) { l.again = false; loadList(sid, { force: true }) } })
    }
    const asked = new Set()
    function useSessionList(sid) {
      const rev = useSyncExternalStore(subscribe, () => lists.get(sid)?.rev ?? -1)
      useEffect(() => { loadList(sid) }, [sid])
      return useMemo(() => lists.get(sid) ?? null, [sid, rev])
    }

    let nav = null           // ctx.sidebarRight
    let sessionsFace = null  // ctx.sessions
    const autoOpened = new Set()
    function openArtifact(sid, id, params) {
      if (!nav) return false
      const address = addressOf(sid, id)
      try { nav.openResource(address, { params, revealIfOpened: true }); return true } catch (error) {
        console.warn('dsh-artifacts: opening the panel failed', error)
        return false
      }
    }

    /** Send a message to the Session as the member would (the "Try fixing" button). */
    async function sendToSession(sid, text) {
      if (sessionsFace?.retain) {
        let ref
        try {
          ref = sessionsFace.retain(sid, { source: 'mainView' })
          const binding = await ref.ready
          const face = typeof binding?.prompt === 'function' ? binding : binding?.session
          if (typeof face?.prompt === 'function') {
            const r = await face.prompt([{ type: 'text', text }], 'queue')
            if (!r || r.ok !== false) return true
          }
        } catch (error) { console.warn('dsh-artifacts: prompting through the session failed, asking the host', error) } finally { try { ref?.release?.() } catch {} }
      }
      await call(`s/${encodeURIComponent(sid)}/fix`, { text })
      return true
    }

    // ───────────────────────── styles ─────────────────────────

    const CSS = `
.dsha-card{display:flex;align-items:center;gap:12px;width:100%;max-width:560px;margin:6px 0;padding:10px 12px;border:1px solid var(--dsw-alias-separator-primary,rgba(15,23,42,.12));border-radius:14px;background:var(--dsw-alias-bg-primary,#fff);color:var(--dsw-alias-label-primary,#0f172a);cursor:pointer;text-align:left;font:inherit;transition:border-color .15s,box-shadow .15s}
.dsha-card:hover{border-color:rgba(77,107,254,.55);box-shadow:0 1px 6px rgba(77,107,254,.12)}
.dsha-card:focus-visible{outline:2px solid #4d6bfe;outline-offset:2px}
.dsha-tile{flex:none;width:44px;height:52px;border-radius:8px;background:linear-gradient(180deg,#eef2ff,#e0e7ff);color:#4d6bfe;display:flex;align-items:center;justify-content:center;border:1px solid rgba(77,107,254,.18)}
.dsha-card.err .dsha-tile{background:#fef2f2;color:#dc2626;border-color:rgba(220,38,38,.2)}
.dsha-txt{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.dsha-title{font-weight:600;font-size:var(--dsh-content-font-size,14px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsha-sub{font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);color:var(--dsw-alias-label-secondary,#64748b);display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsha-spin{width:11px;height:11px;border-radius:50%;border:2px solid rgba(77,107,254,.25);border-top-color:#4d6bfe;animation:dsha-spin .8s linear infinite;flex:none;box-sizing:border-box}
@keyframes dsha-spin{to{transform:rotate(360deg)}}
.dsha-panel{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-primary,#fff);color:var(--dsw-alias-label-primary,#0f172a)}
.dsha-bar{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-separator-primary,rgba(15,23,42,.08));min-height:48px;box-sizing:border-box}
.dsha-name{flex:1;min-width:0;display:flex;flex-direction:column}
.dsha-name b{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsha-ver{display:flex;align-items:center;gap:2px;font-size:12px;color:var(--dsw-alias-label-secondary,#64748b)}
.dsha-ver select{font:inherit;color:inherit;background:transparent;border:none;padding:0 2px;cursor:pointer;border-radius:4px}
.dsha-ver select:hover{background:var(--dsw-alias-button-floating-hover,rgba(15,23,42,.06))}
.dsha-seg{display:inline-flex;padding:2px;border-radius:9px;background:var(--dsw-alias-button-floating-fill,rgba(15,23,42,.06))}
.dsha-seg button{border:none;background:transparent;color:var(--dsw-alias-label-secondary,#64748b);font:inherit;font-size:12.5px;padding:4px 10px;border-radius:7px;cursor:pointer}
.dsha-seg button[aria-pressed=true]{background:var(--dsw-alias-bg-primary,#fff);color:#4d6bfe;font-weight:600;box-shadow:0 1px 2px rgba(15,23,42,.12)}
.dsha-seg button:disabled{cursor:default;opacity:.5}
.dsha-btn{border:none;background:transparent;color:var(--dsw-alias-label-secondary,#475569);width:30px;height:30px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:none;padding:0}
.dsha-btn:hover:not(:disabled){background:var(--dsw-alias-button-floating-hover,rgba(15,23,42,.06));color:var(--dsw-alias-label-primary,#0f172a)}
.dsha-btn:disabled{opacity:.35;cursor:default}
.dsha-txtbtn{border:1px solid var(--dsw-alias-separator-primary,rgba(15,23,42,.14));background:var(--dsw-alias-bg-primary,#fff);color:inherit;font:inherit;font-size:12.5px;padding:4px 10px;border-radius:8px;cursor:pointer;display:inline-flex;gap:6px;align-items:center}
.dsha-txtbtn.primary{background:#4d6bfe;border-color:#4d6bfe;color:#fff}
.dsha-txtbtn.primary:hover{background:#3d5bf0}
.dsha-body{position:relative;flex:1;min-height:0;overflow:hidden}
.dsha-frame{display:block;width:100%;height:100%;border:none;background:#fff}
.dsha-code{height:100%;box-sizing:border-box;overflow:auto;margin:0;padding:12px 0;font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;background:var(--dsw-alias-bg-secondary,#f8fafc);color:var(--dsw-alias-label-primary,#0f172a);counter-reset:l;tab-size:2}
.dsha-code .ln{display:block;padding:0 16px 0 0;white-space:pre-wrap;word-break:break-word;min-height:1.6em}
.dsha-code .ln::before{counter-increment:l;content:counter(l);display:inline-block;width:3.2em;margin-right:14px;text-align:right;color:var(--dsw-alias-label-tertiary,#94a3b8);user-select:none}
.dsha-code .k{color:#4d6bfe;font-weight:500}.dsha-code .s{color:#0a7d4f}.dsha-code .c{color:#94a3b8;font-style:italic}.dsha-code .n{color:#b45309}.dsha-code .t{color:#9333ea}
.dsha-caret{display:inline-block;width:7px;height:1.1em;vertical-align:text-bottom;background:#4d6bfe;animation:dsha-blink 1s steps(1) infinite;margin-left:1px}
@keyframes dsha-blink{50%{opacity:0}}
.dsha-error{position:absolute;left:12px;right:12px;bottom:12px;padding:10px 12px;border-radius:12px;background:#fff;border:1px solid rgba(220,38,38,.3);box-shadow:0 6px 24px rgba(15,23,42,.12);display:flex;gap:10px;align-items:flex-start;font-size:13px;color:#0f172a}
.dsha-error pre{margin:4px 0 0;max-height:96px;overflow:auto;font:11.5px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#b91c1c;white-space:pre-wrap;word-break:break-word}
.dsha-error .row{display:flex;gap:6px;margin-top:8px}
.dsha-empty{display:flex;align-items:center;justify-content:center;height:100%;color:var(--dsw-alias-label-secondary,#64748b);font-size:13px;gap:8px}
.dsha-toast{position:absolute;top:10px;left:50%;transform:translateX(-50%);background:#0f172a;color:#fff;font-size:12px;padding:4px 10px;border-radius:8px;pointer-events:none}
.dsha-tail{display:flex;flex-direction:column;gap:6px;margin:4px 0 8px}.dsha-tail .dsha-card{margin:0}
.dsha-tabtitle{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsha-tabtitle svg{color:#4d6bfe;flex:none}
`
    function ensureStyle() {
      if (typeof document === 'undefined' || document.querySelector('style[data-plugin-css="dsh-artifacts"]')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-artifacts'
      tag.dataset.pluginCss = 'dsh-artifacts'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ───────────────────────── icons ─────────────────────────

    const svg = (size, ...paths) => h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, ...paths.map((d, i) => h('path', { key: i, d })))
    const Icon = {
      code: s => svg(s, 'M8 7l-5 5 5 5', 'M16 7l5 5-5 5', 'M13.5 4l-3 16'),
      doc: s => svg(s, 'M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6', 'M9 16h6'),
      image: s => svg(s, 'M4 5h16v14H4z', 'M4 16l5-5 4 4 3-3 4 4', 'M15.5 9.5h.01'),
      chart: s => svg(s, 'M4 5h5v5H4z', 'M15 14h5v5h-5z', 'M9 7.5h4a2 2 0 0 1 2 2V14'),
      app: s => svg(s, 'M4 4h16v16H4z', 'M4 9h16', 'M8 6.5h.01', 'M11 6.5h.01'),
      copy: s => svg(s, 'M9 9h11v11H9z', 'M5 15H4V4h11v1'),
      download: s => svg(s, 'M12 4v11', 'M7 10.5l5 5 5-5', 'M5 20h14'),
      refresh: s => svg(s, 'M20 11a8 8 0 1 0-2.3 5.7', 'M20 5v6h-6'),
      prev: s => svg(s, 'M15 6l-6 6 6 6'),
      next: s => svg(s, 'M9 6l6 6-6 6'),
      alert: s => svg(s, 'M12 4l9 16H3z', 'M12 10v4', 'M12 17h.01'),
      wrench: s => svg(s, 'M14.5 6.5a4 4 0 0 0-5.3 5.3L4 17l3 3 5.2-5.2a4 4 0 0 0 5.3-5.3l-2.5 2.5-2.5-.5-.5-2.5z'),
    }
    const kindIcon = (kind, s = 20) => (kind === 'react' || kind === 'html' ? Icon.app(s) : kind === 'markdown' ? Icon.doc(s) : kind === 'svg' ? Icon.image(s) : kind === 'mermaid' ? Icon.chart(s) : Icon.code(s))

    // ───────────────────────── chat card ─────────────────────────

    /** What one tool call says, at whatever phase it is in. */
    function callView(phase, block, raw) {
      if (phase === 'preparing') {
        const { args, complete } = parsePartialArgs(raw)
        return { args, complete: [...complete], done: false }
      }
      const argsRaw = phase === 'start' ? block?.argsRaw : block?.call?.argsRaw
      let args
      try { args = JSON.parse(argsRaw || '{}') } catch { args = parsePartialArgs(argsRaw).args }
      if (phase === 'start') return { args, complete: Object.keys(args), done: false }
      const text = (block?.content || []).filter(b => b?.type === 'text').map(b => b.text).join('\n')
      const marker = resultMarker(text)
      const isError = !!block?.isError || !marker
      return { args, complete: Object.keys(args), done: true, isError, errorText: isError ? (block?.error?.reason || text) : '', version: marker?.version, id: marker?.id ?? args.id }
    }

    function PreparingCard(props) {
      const raw = props.useToolCallArgumentsPartial ? props.useToolCallArgumentsPartial() : ''
      return h(CardBody, { ...props, raw })
    }

    function ArtifactCard(props) {
      ensureStyle()
      askConfig()
      return props.phase === 'preparing' ? h(PreparingCard, props) : h(CardBody, { ...props, raw: '' })
    }

    function CardBody(props) {
      const L = t()
      const sid = props.sessionId
      const view = useMemo(() => callView(props.phase, props.block, props.raw), [props.phase, props.block, props.raw])
      const id = view.id ?? view.args.id
      const callId = props.callId
      const e = useEntry(sid, view.done && !view.isError ? id : null)
      // Feed the panel while the call streams; once it settles, reload the artifact.
      useEffect(() => {
        if (!sid || !id) return
        if (!view.done) {
          setStream(sid, id, callId, { raw: props.raw || argsKey(view.args), args: view.args, complete: view.complete, done: false })
          if (props.phase === 'preparing' && !autoOpened.has(callId) && (view.args.content || view.args.new_str || view.args.old_str)) {
            autoOpened.add(callId)
            openArtifact(sid, id, { follow: callId })
          }
        } else {
          const prev = entry(sid, id).streams.get(callId)
          if (prev && !prev.done) setStream(sid, id, callId, { ...prev, done: true, isError: view.isError })
          const have = entry(sid, id).data?.versions?.length ?? 0
          if (!view.isError && view.version && have < view.version) { load(sid, id, { force: true }); loadList(sid, { force: true }) }
        }
      }, [sid, id, callId, props.raw, view.done, view.isError, view.version])

      const data = e?.data
      const kind = kindOf(view.args.type ?? data?.type)
      const title = view.args.title || data?.title || id || '…'
      const command = view.args.command
      let sub
      if (view.isError) sub = h('span', { title: view.errorText }, `${L.failed}${view.errorText ? ` · ${String(view.errorText).slice(0, 120)}` : ''}`)
      else if (!view.done) sub = [h('span', { key: 's', className: 'dsha-spin' }), h('span', { key: 't' }, command === 'update' || command === 'rewrite' ? L.editing : L.generating)]
      else sub = `${L.kind[kind] ?? L.kind.code}${view.version ? ` · ${L.version(view.version)}` : ''}`
      const open = () => { if (sid && id) openArtifact(sid, id, view.done ? { version: view.version } : { follow: callId }) }
      return h(CardView, { id, kind, title, sub, isError: view.isError, onClick: open, phase: props.phase })
    }

    function CardView({ id, kind, title, sub, isError, onClick, phase }) {
      return h('button', {
        type: 'button', className: `dsha-card${isError ? ' err' : ''}`, onClick, title: t().open,
        'data-dsh-artifact': id || '', 'data-phase': phase,
      },
      h('span', { className: 'dsha-tile' }, isError ? Icon.alert(20) : kindIcon(kind)),
      h('span', { className: 'dsha-txt' }, h('span', { className: 'dsha-title' }, title), h('span', { className: 'dsha-sub' }, sub)))
    }

    /**
     * A finished turn folds its tool calls away; like Claude, the artifacts it made stay in
     * sight: one card per artifact, at the version the turn left it, under the reply.
     */
    function ArtifactsTail(props) {
      ensureStyle()
      const L = t()
      const sid = props.sessionId
      const turn = props.turn?.turn
      const list = useSessionList(sid)
      const items = useMemo(() => {
        if (!Number.isInteger(turn)) return []
        return (list?.data || []).flatMap(a => {
          const made = (a.versions || []).filter(v => v.turn === turn)
          return made.length ? [{ a, v: made.at(-1) }] : []
        })
      }, [list, list?.rev, turn])
      // A turn the loaded list has not seen yet (its call rows folded before they could ask): ask again, once.
      const known = useMemo(() => Math.max(-1, ...(list?.data || []).flatMap(a => (a.versions || []).map(v => v.turn ?? -1))), [list, list?.rev])
      useEffect(() => {
        if (!sid || !Number.isInteger(turn) || !list?.data || turn <= known) return
        const key = `${sid}\n${turn}`
        if (asked.has(key)) return
        asked.add(key)
        loadList(sid, { force: true })
      }, [sid, turn, known, !!list?.data])
      if (!items.length) return null
      return h('div', { className: 'dsha-tail', 'data-dsh-artifacts-tail': turn },
        items.map(({ a, v }) => h(CardView, {
          key: a.id, id: a.id, kind: kindOf(a.type), title: a.title, phase: 'tail',
          sub: `${L.kind[kindOf(a.type)] ?? L.kind.code} · ${L.version(v.n)}`,
          onClick: () => openArtifact(sid, a.id, { version: v.n }),
        })))
    }
    const argsKey = args => JSON.stringify(args)

    // ───────────────────────── panel ─────────────────────────

    function CodeView({ content, kind, language, streaming }) {
      const ref = useRef(null)
      const stick = useRef(true)
      const lines = useMemo(() => {
        const out = [[]]
        for (const [cls, text] of highlight(content || '', kind, language)) {
          text.split('\n').forEach((seg, i) => {
            if (i > 0) out.push([])
            const line = out[out.length - 1]
            if (seg) line.push(cls ? h('span', { key: line.length, className: cls }, seg) : seg)
          })
        }
        return out
      }, [content, kind, language])
      useEffect(() => { const el = ref.current; if (el && streaming && stick.current) el.scrollTop = el.scrollHeight }, [content, streaming])
      const onScroll = () => { const el = ref.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }
      return h('pre', { ref, className: 'dsha-code', onScroll, 'data-dsh-artifact-code': '' },
        lines.map((l, i) => h('span', { key: i, className: 'ln' }, ...l, streaming && i === lines.length - 1 ? h('span', { key: 'caret', className: 'dsha-caret' }) : null)))
    }

    function PreviewFrame({ kind, content, onMessage }) {
      const ref = useRef(null)
      const doc = useMemo(() => buildDocument(kind, content, { cdn: config.cdn }), [kind, content])
      useEffect(() => {
        const listen = e => { if (ref.current && e.source === ref.current.contentWindow && e.data && e.data.__dshArtifact) onMessage(e.data, ref.current.contentWindow) }
        window.addEventListener('message', listen)
        return () => window.removeEventListener('message', listen)
      }, [onMessage])
      return h('iframe', {
        ref, className: 'dsha-frame', srcDoc: doc, title: 'artifact',
        sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads allow-pointer-lock',
        allow: 'clipboard-write; fullscreen; autoplay', 'data-dsh-artifact-frame': '',
      })
    }

    function ArtifactPanel(props) {
      ensureStyle()
      askConfig()
      const L = t()
      const info = props.useTabInfo ? props.useTabInfo() : { tab: {} }
      const tab = info.tab || {}
      const navigation = tab.navigation || {}
      const navParams = navigation.params || {}
      const target = parseAddress(tab.contentId) || parseAddress(navigation.address) || {}
      const sid = target.sessionId ?? props.sessionId
      const id = target.id
      const e = useEntry(sid, id)
      const versions = e?.data?.versions ?? []
      // the newest stream whose call has not been saved as a version yet
      const live = useMemo(() => {
        if (!e) return null
        const saved = new Set(versions.map(v => v.callId).filter(Boolean))
        let best = null
        for (const [callId, s] of e.streams) if (!saved.has(callId) && !s.done && (!best || s.startedAt >= best.s.startedAt)) best = { callId, s }
        return best
      }, [e, e?.rev])
      const [selected, setSelected] = useState(null)   // version number; null = latest
      const [mode, setMode] = useState(null)           // 'preview' | 'code' | null (the kind's default)
      const [reload, setReload] = useState(0)
      const [error, setError] = useState(null)
      const [toast, setToast] = useState(null)

      // A navigation to a given version (a card click) selects it; a version added later selects the latest.
      useEffect(() => { setSelected(navParams.version ? Number(navParams.version) : null) }, [navigation.revision])
      const seenVersions = useRef(versions.length)
      useEffect(() => { if (versions.length > seenVersions.current) setSelected(null); seenVersions.current = versions.length }, [versions.length])
      useEffect(() => { if (live) { setMode(null); setError(null) } }, [!!live])

      const data = e?.data
      const type = data?.type ?? live?.s.args?.type
      const kind = kindOf(type)
      const title = data?.title || live?.s.args?.title || id
      const total = live ? versions.length + 1 : versions.length
      const n = live ? total : (selected && selected <= versions.length ? selected : versions.length)
      const content = live ? streamContent(live.s, versions) : versions[n - 1]?.content ?? ''
      const previewable = !!kind && kind !== 'code'
      const shown = live ? 'code' : (mode ?? (previewable ? 'preview' : 'code'))
      const language = live?.s.args?.language ?? data?.language

      const flash = msg => { setToast(msg); setTimeout(() => setToast(null), 1400) }
      const copy = async () => {
        try { await navigator.clipboard.writeText(content); flash(L.copied) } catch {
          const ta = document.createElement('textarea'); ta.value = content; ta.style.position = 'fixed'; ta.style.opacity = '0'
          document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); flash(L.copied) } finally { ta.remove() }
        }
      }
      const download = () => {
        const url = URL.createObjectURL(new Blob([content], { type: `${MIME[kind] || 'text/plain'};charset=utf-8` }))
        const a = document.createElement('a'); a.href = url; a.download = fileName({ type, title, language, id })
        a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000)
      }
      const fix = async () => {
        if (!error) return
        try { await sendToSession(sid, L.fixPrompt(title, `${error.message}${error.stack ? `\n${error.stack}` : ''}`.slice(0, 6000))); setError(null); flash(L.sent) } catch (err) { flash(String(err.message || err)) }
      }

      const onMessage = useCallback((msg, win) => {
        if (msg.type === 'error') { setError(prev => prev ?? { message: msg.message, stack: msg.stack }); return }
        if (msg.type !== 'rpc') return
        const reply = (value, err) => { try { win.postMessage({ __dshArtifactReply: 1, id: msg.id, value, error: err }, '*') } catch {} }
        const base = `s/${encodeURIComponent(sid)}/a/${encodeURIComponent(id)}`
        const p = msg.params || {}
        const run = msg.method === 'complete' ? call(`${base}/complete`, { prompt: p.prompt }).then(r => r.text)
          : msg.method === 'storage' ? call(`${base}/storage`, p).then(r => r.value)
            : Promise.reject(new Error(`unknown method ${msg.method}`))
        run.then(v => reply(v), err => reply(undefined, String(err.message || err)))
      }, [sid, id])

      useEffect(() => { setError(null) }, [n, reload, content])
      useEffect(() => tab.actions?.bindCommands?.({ refresh: () => { load(sid, id, { force: true }); setReload(k => k + 1) } }), [tab.actions, sid, id])

      if (!id) return h('div', { className: 'dsha-empty' }, L.none)
      if (!data && !live) {
        return h('div', { className: 'dsha-empty' }, e?.error ? (e.error === 'missing' ? L.missing : e.error) : [h('span', { key: 's', className: 'dsha-spin' }), h('span', { key: 't' }, L.loading)])
      }

      const bar = h('div', { className: 'dsha-bar' },
        h('div', { className: 'dsha-name' },
          h('b', { title }, title),
          h('span', { className: 'dsha-ver' },
            live ? [h('span', { key: 's', className: 'dsha-spin' }), h('span', { key: 't' }, `${L.version(n)} · ${live.s.args?.command === 'create' || !versions.length ? L.generating : L.editing}`)]
              : [
                  h('button', { key: 'p', type: 'button', className: 'dsha-btn', style: { width: 20, height: 20 }, disabled: n <= 1, onClick: () => setSelected(Math.max(1, n - 1)), title: L.prev, 'aria-label': L.prev }, Icon.prev(14)),
                  h('select', { key: 's', value: n, onChange: ev => setSelected(Number(ev.target.value)), 'aria-label': L.of(n, total), 'data-dsh-artifact-version': '' },
                    versions.map(v => h('option', { key: v.n, value: v.n }, `${L.version(v.n)}${v.n === total ? ` · ${L.latest}` : ''}`))),
                  h('button', { key: 'n', type: 'button', className: 'dsha-btn', style: { width: 20, height: 20 }, disabled: n >= total, onClick: () => setSelected(Math.min(total, n + 1)), title: L.next, 'aria-label': L.next }, Icon.next(14)),
                ])),
        previewable ? h('div', { className: 'dsha-seg', role: 'group' },
          h('button', { type: 'button', 'aria-pressed': shown === 'preview', disabled: !!live, onClick: () => setMode('preview'), 'data-mode': 'preview' }, L.preview),
          h('button', { type: 'button', 'aria-pressed': shown === 'code', onClick: () => setMode('code'), 'data-mode': 'code' }, L.code)) : null,
        h('button', { type: 'button', className: 'dsha-btn', onClick: copy, title: L.copy, 'aria-label': L.copy, disabled: !content }, Icon.copy(16)),
        h('button', { type: 'button', className: 'dsha-btn', onClick: download, title: L.download, 'aria-label': L.download, disabled: !content || !!live }, Icon.download(16)),
        previewable ? h('button', { type: 'button', className: 'dsha-btn', onClick: () => setReload(k => k + 1), title: L.refresh, 'aria-label': L.refresh, disabled: !!live }, Icon.refresh(16)) : null)

      const body = h('div', { className: 'dsha-body' },
        shown === 'preview'
          ? h(PreviewFrame, { key: `${n}:${reload}`, kind, content, onMessage })
          : h(CodeView, { content, kind, language, streaming: !!live }),
        error && shown === 'preview' ? h('div', { className: 'dsha-error', role: 'alert' },
          h('span', { style: { color: '#dc2626', flex: 'none', marginTop: 1 } }, Icon.alert(18)),
          h('div', { style: { minWidth: 0, flex: 1 } },
            h('b', null, L.error),
            h('pre', null, error.message),
            h('div', { className: 'row' },
              h('button', { type: 'button', className: 'dsha-txtbtn primary', onClick: fix, 'data-dsh-artifact-fix': '' }, Icon.wrench(14), L.fix),
              h('button', { type: 'button', className: 'dsha-txtbtn', onClick: () => setError(null) }, L.dismiss)))) : null,
        toast ? h('div', { className: 'dsha-toast' }, toast) : null)

      return h('div', { className: 'dsha-panel', 'data-dsh-artifact-panel': id }, bar, body)
    }

    function TabTitle(props) {
      ensureStyle()
      const info = props.useTabInfo ? props.useTabInfo() : { tab: {} }
      const target = parseAddress(info.tab?.contentId) || {}
      const e = useEntry(target.sessionId, target.id)
      let title = e?.data?.title
      let type = e?.data?.type
      if (e && (!title || !type)) for (const s of e.streams.values()) { title = title || s.args?.title; type = type || s.args?.type }
      return h('span', { className: 'dsha-tabtitle' }, kindIcon(kindOf(type), 14), title || info.tab?.title || target.id || 'Artifact')
    }

    // ───────────────────────── plugin ─────────────────────────

    return {
      lib,
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'artifacts' }, ArtifactCard))
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({ name: 'conversation.chat.turnTail', id: 'dsh-artifacts', order: 5 }, ArtifactsTail))
        ctx.inject(['sidebarRight', 'sidebarRightTabs'], inner => {
          nav = inner.sidebarRight
          inner.effect(() => () => { if (nav === inner.sidebarRight) nav = null }, 'dsh-artifacts: navigation')
          inner.effect(() => inner.sidebarRightTabs.register({
            id: 'dsh-artifacts', kind: 'artifact', keepMounted: true, priority: 'extension',
            patterns: ['dsh-resource://artifact/**'],
            canOpen: address => !!parseAddress(address),
            title: address => titles.get(address) || parseAddress(address)?.id || 'Artifact',
          }), 'dsh-artifacts: tab type')
          inner.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'dsh-artifacts' }, ArtifactPanel)), 'dsh-artifacts: panel')
          inner.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: 'dsh-artifacts' }, TabTitle)), 'dsh-artifacts: tab title')
        })
        ctx.inject(['sessions'], inner => {
          sessionsFace = inner.sessions
          inner.effect(() => () => { if (sessionsFace === inner.sessions) sessionsFace = null }, 'dsh-artifacts: sessions')
        })
      },
    }
  },
})

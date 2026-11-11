/**
 * 记忆星图（客户端半）自检：纯函数 + 最小 DOM / canvas 桩。
 *
 *   node test/view.graph.spec.mjs
 *
 * 覆盖：
 *   · 纯函数：配色 / 尺寸 / 亮度 / 六类边样式、确定性撒点、力导向收敛、
 *     搜索命中、命中测试；
 *   · 面板入口：设置页多出一行「✦ 记忆星图」；
 *   · 覆盖层：点入口挂在 body 上、canvas 真的画了、状态行给出节点 / 边数；
 *   · 取数：打开时 GET /cyrene/memory/graph，刷新按钮才带 ?reload=1；
 *   · 交互：搜索只过滤本地、连线开关、点星弹卡片、✕ / Esc 关闭；
 *   · 可见性：页面隐藏时取消 requestAnimationFrame，回来再续上。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const PACKAGE_ID = 'dsh-cyrene-theme'

let passed = 0
const failures = []
function ok(label, condition, extra) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${extra === undefined ? '' : ' → ' + JSON.stringify(extra)}`)
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 25))

/** 极简 DOM 元素桩：够设置页 / 星图覆盖层用（属性 / 子节点 / 事件 / style / canvas）。 */
function parseHtml(html) {
  const out = []
  const tagRe = /<(\w+)([^>]*)>/g
  let tagMatch
  while ((tagMatch = tagRe.exec(html)) !== null) {
    const attrs = {}
    const attrRe = /([\w-]+)="([^"]*)"/g
    let attrMatch
    while ((attrMatch = attrRe.exec(tagMatch[2])) !== null) attrs[attrMatch[1]] = attrMatch[2]
    out.push({ tag: tagMatch[1], attrs })
  }
  return out
}

/** canvas 2D 上下文桩：只记录调用，不做真实绘制。 */
function makeCanvasContext() {
  const context = {
    arcs: [],
    labels: [],
    fills: 0,
    strokes: 0,
    setTransform() {},
    clearRect() {
      context.arcs = []
      context.labels = []
      context.fills = 0
      context.strokes = 0
    },
    createLinearGradient() {
      return { addColorStop() {} }
    },
    createRadialGradient() {
      return { addColorStop() {} }
    },
    fillRect() {},
    beginPath() {},
    arc(x, y, r) {
      context.arcs.push({ x, y, r })
    },
    fill() {
      context.fills += 1
    },
    moveTo() {},
    lineTo() {},
    stroke() {
      context.strokes += 1
    },
    setLineDash() {},
    save() {},
    restore() {},
    translate() {},
    scale() {},
    fillText(text, x, y) {
      context.labels.push({ text, x, y })
    },
  }
  return context
}

class El {
  constructor(tag) {
    this.tagName = tag
    this.attrs = {}
    this.children = []
    this.listeners = {}
    this.value = ''
    this.checked = false
    this._text = ''
    this.parent = null
    this._html = ''
    this.style = {
      _props: {},
      setProperty(name, value) { this._props[name] = String(value) },
      removeProperty(name) { delete this._props[name] },
      getPropertyValue(name) { return this._props[name] ?? '' },
    }
    this._canvasContext = null
  }
  set textContent(value) {
    this._text = String(value)
    if (this._text === '') this.children = []
  }
  get textContent() { return this._text }
  setAttribute(key, value) { this.attrs[key] = String(value) }
  getAttribute(key) { return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null }
  hasAttribute(key) { return Object.prototype.hasOwnProperty.call(this.attrs, key) }
  removeAttribute(key) { delete this.attrs[key] }
  appendChild(child) { child.parent = this; this.children.push(child); return child }
  append(...children) { for (const child of children) this.appendChild(child) }
  remove() {
    this.removed = true
    if (this.parent !== null) this.parent.children = this.parent.children.filter((child) => child !== this)
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((item) => item !== fn) }
  dispatch(type, event = {}) {
    for (const fn of this.listeners[type] ?? []) fn({ target: this, ...event })
  }
  closest(selector) {
    const wantButton = selector.includes('button')
    for (let node = this; node !== null; node = node.parent) {
      if (wantButton && node.tagName === 'button' && node.attrs['data-role'] !== undefined) return node
    }
    return null
  }
  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()])
  }
  querySelector(selector) {
    const roleMatch = /\[data-role="([^"]+)"\]/.exec(selector)
    if (roleMatch !== null) {
      return this.descendants().find((node) => node.attrs['data-role'] === roleMatch[1]) ?? null
    }
    const classMatch = /^\.([\w-]+)$/.exec(selector)
    if (classMatch !== null) {
      return this.descendants().find((node) => node.className === classMatch[1]) ?? null
    }
    return this.descendants().find((node) => node.tagName === selector) ?? null
  }
  querySelectorAll() { return [] }
  focus() {}
  getContext(kind) {
    if (kind !== '2d') return null
    if (this._canvasContext === null) this._canvasContext = makeCanvasContext()
    return this._canvasContext
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 800, bottom: 520, width: 800, height: 520 }
  }
  set innerHTML(html) {
    this._html = html
    this.children = []
    for (const { tag, attrs } of parseHtml(html)) {
      const child = new El(tag)
      Object.assign(child.attrs, attrs)
      this.appendChild(child)
    }
  }
  get innerHTML() { return this._html }
}

function makeDoc() {
  const head = new El('head')
  const body = new El('body')
  body.dataset = {}
  const listeners = {}
  return {
    baseURI: 'http://127.0.0.1:19387/',
    visibilityState: 'visible',
    head,
    body,
    listeners,
    createElement(tag) { return new El(tag) },
    querySelectorAll: () => [],
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn) },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] ?? []).filter((item) => item !== fn) },
    dispatch(type, event = {}) {
      for (const fn of listeners[type] ?? []) fn(event)
    },
  }
}

// rAF 队列：测试里手动 flush，才能断言「页面隐藏后不再排帧」。
let rafQueue = new Map()
let rafSeq = 0
let cancelled = 0
function flushFrame(times = 1) {
  for (let i = 0; i < times; i += 1) {
    const pending = [...rafQueue.entries()]
    rafQueue = new Map()
    for (const [, fn] of pending) fn(16 * (i + 1))
  }
}

const STATE = {
  ok: true,
  value: {
    persona: '昔涟的设定',
    enabled: true,
    theme: true,
    stickers: true,
    stickerSize: 96,
    customStickers: [],
    background: { enabled: true, current: '', rotate: false, interval: 90, dim: 0.6 },
    customBackgrounds: [],
    hero: { image: 'meme/俏皮眨眼.png', title: '让昔涟来帮帮你吧🎵', ready: true, url: '/cyrene/hero' },
    rev: 1,
    version: '0.6.0',
    defaultPersona: '默认昔涟',
    statePath: 'C:/x/cyrene-theme.json',
  },
}

const GRAPH_NODES = [
  {
    id: 'mem-1',
    label: '用户喜欢冰美式',
    kind: 'memory',
    layer: 'L2',
    weight: 0.8,
    freshness: 0.7,
    status: 'active',
    pinned: false,
    tags: ['偏好'],
    text: '用户喜欢冰美式，早上要来一杯。',
    textLength: 16,
    created: '2026-11-05T09:00:00.000Z',
  },
  {
    id: 'mem-2',
    label: '下周三评审',
    kind: 'memory',
    layer: 'L2',
    weight: 0.2,
    freshness: 0.2,
    status: 'aging',
    pinned: false,
    tags: ['工作'],
    text: '下周三有评审，要提前准备。',
    textLength: 13,
    created: '2026-10-20T09:00:00.000Z',
  },
  {
    id: 'mem-s',
    label: '【摘要】十月的事',
    kind: 'summary',
    layer: 'L2',
    weight: 0.9,
    freshness: 0.9,
    status: 'active',
    pinned: false,
    tags: ['摘要'],
    text: '【摘要】十月去看了海，也换了工作。',
    textLength: 18,
    created: '2026-11-06T09:00:00.000Z',
  },
  {
    id: 'profile:l0:preferredName',
    label: '小满',
    kind: 'profile',
    layer: 'L0',
    weight: 0.96,
    freshness: 0.5,
    status: 'active',
    pinned: true,
    tags: [],
    text: '小满',
    textLength: 2,
    created: '2026-11-01T09:00:00.000Z',
  },
]

const GRAPH = {
  ok: true,
  value: {
    nodes: GRAPH_NODES,
    edges: [
      { a: 'mem-s', b: 'mem-1', type: 'summary', weight: 1 },
      { a: 'mem-1', b: 'mem-2', type: 'tag', weight: 0.5 },
      { a: 'mem-1', b: 'profile:l0:preferredName', type: 'semantic', weight: 0.42 },
    ],
    generatedAt: '2026-11-08T03:00:00.000Z',
  },
}

const COUNTS = {
  stickers: { ok: true, value: { version: 1, maxPerTurn: 1, items: [], missing: [], error: null } },
  backgrounds: { ok: true, value: { folder: 'Background', items: [], error: null } },
  worldbook: {
    ok: true,
    value: { error: null, count: 0, version: '', fetchedAt: '', path: '', source: '', characters: [], categories: [], entries: [] },
  },
  profile: { ok: true, value: { l0: {}, l1: {}, relationship: {} } },
  memory: { ok: true, value: { items: [], count: 0, rev: 0, enabled: true, limit: 300, error: null } },
  llm: { ok: true, value: { available: false, provider: '', model: '', lastError: null } },
}

async function bootstrap() {
  const calls = []
  const refs = []
  let spec = null
  const windowListeners = {}
  globalThis.window = {
    __ModuleLoader__: { load(value) { spec = value } },
    devicePixelRatio: 1,
    addEventListener(type, fn) { (windowListeners[type] ||= []).push(fn) },
    removeEventListener(type, fn) {
      windowListeners[type] = (windowListeners[type] ?? []).filter((item) => item !== fn)
    },
    confirm: () => true,
  }
  globalThis.document = makeDoc()
  globalThis.requestAnimationFrame = (fn) => {
    rafSeq += 1
    rafQueue.set(rafSeq, fn)
    return rafSeq
  }
  globalThis.cancelAnimationFrame = (id) => {
    cancelled += 1
    rafQueue.delete(id)
  }
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = 'data:image/png;base64,AAAA'
      if (typeof this.onload === 'function') this.onload()
    }
  }
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', body: init.body }
    calls.push(call)
    const respond = (payload, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    })
    if (call.url.includes('/cyrene/memory/graph')) return respond(GRAPH)
    if (call.url.includes('/cyrene/memory/profile')) return respond(COUNTS.profile)
    if (call.url.includes('/cyrene/memory/llm')) return respond(COUNTS.llm)
    if (call.url.includes('/cyrene/memory')) return respond(COUNTS.memory)
    if (call.url.includes('/cyrene/backgrounds')) return respond(COUNTS.backgrounds)
    if (call.url.includes('/cyrene/stickers')) return respond(COUNTS.stickers)
    if (call.url.includes('/cyrene/worldbook')) return respond(COUNTS.worldbook)
    if (call.url.includes('/cyrene/report')) return respond({ ok: true, value: { at: 'now' } })
    return respond(STATE)
  }
  globalThis.setInterval = () => ({ unref() {} })
  globalThis.clearInterval = () => {}

  const source = await readFile(CLIENT, 'utf8')
  ;(0, eval)(source)

  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useRef: () => {
      const ref = { current: new El('div') }
      refs.push(ref)
      return ref
    },
    useEffect: (fn) => fn(),
    useState: (initial) => {
      let value = initial
      return [value, (next) => { value = typeof next === 'function' ? next(value) : next }]
    },
    useSyncExternalStore() {},
  }
  const bundle = spec.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require(${name})`)
  })
  return { spec, exports: bundle, calls, refs, doc: globalThis.document, windowListeners }
}

function makeCtx() {
  const registered = []
  const ctx = {
    effect(fn) { fn() },
    get(name) {
      if (name !== 'theme') return undefined
      return { preference: 'light', setTheme() {} }
    },
    slots: {
      inject(_name, cb) { cb() },
      register(registration, component) { registered.push({ registration, component }) },
    },
  }
  return { ctx, registered }
}

console.log('view.graph.spec.mjs\n')

const boot = await bootstrap()
const box = makeCtx()
boot.exports.apply(box.ctx)
await tick()
box.registered.find((entry) => entry.registration.id === 'cyrene-theme').component()
await tick()
const editor = boot.refs[0].current.children[0]
const G = boot.exports.graph

// ── 1. 纯函数：配色 / 尺寸 / 亮度 ────────────────────────────────
ok('四种节点配色齐全且互不相同：L0 暖白 / L1 淡粉 / L2 灰蓝 / summary 紫',
  ['L0', 'L1', 'L2', 'summary'].every((key) => G.GRAPH_PALETTE[key] !== undefined)
  && new Set(['L0', 'L1', 'L2'].map((key) => G.GRAPH_PALETTE[key].core)).size === 3
  && G.GRAPH_PALETTE.summary.core !== G.GRAPH_PALETTE.L2.core)
ok('summary 优先于层：kind=summary 的节点一定拿紫色',
  G.graphNodePalette({ kind: 'summary', layer: 'L0' }).core === G.GRAPH_PALETTE.summary.core
  && G.graphNodePalette({ kind: 'memory', layer: 'L0' }).core === G.GRAPH_PALETTE.L0.core
  && G.graphNodePalette({ kind: 'memory', layer: '???' }).core === G.GRAPH_PALETTE.L2.core)

const radiusOf = (layer, weight = 0.5) => G.graphNodeRadius({ kind: 'memory', layer, weight, freshness: 0.5 })
ok('大小按层递减：L0 > L1 > L2；weight 越大越大',
  radiusOf('L0') > radiusOf('L1') && radiusOf('L1') > radiusOf('L2')
  && radiusOf('L2', 1) > radiusOf('L2', 0.2),
  [radiusOf('L0'), radiusOf('L1'), radiusOf('L2')])
ok('画像 L0 比普通 L0 更醒目，摘要介于行星与恒星之间',
  G.graphNodeRadius({ kind: 'profile', layer: 'L0', weight: 0.5, freshness: 0.5 })
  > G.graphNodeRadius({ kind: 'memory', layer: 'L0', weight: 0.5, freshness: 0.5 })
  && G.graphNodeRadius({ kind: 'summary', weight: 0.5, freshness: 0.5 }) > radiusOf('L1'))

ok('亮度：weight 越高越亮，越新越亮，且始终落在 0.3–1',
  G.graphNodeBrightness({ weight: 0.9, freshness: 0.9 }) > G.graphNodeBrightness({ weight: 0.2, freshness: 0.9 })
  && G.graphNodeBrightness({ weight: 0.5, freshness: 0.95 }) > G.graphNodeBrightness({ weight: 0.5, freshness: 0.05 })
  && G.graphNodeBrightness({ weight: 99, freshness: 99 }) <= 1
  && G.graphNodeBrightness({ weight: -1, freshness: -1 }) >= 0.3
  && G.graphNodeBrightness({ weight: 'x', freshness: null }) >= 0.3)

// ── 2. 纯函数：六类边样式 ───────────────────────────────────────
ok('六类边颜色齐全：summary 红 / conflict 橙虚线 / tag 灰 / layer 淡灰 / ref 青 / semantic 极淡',
  Object.keys(G.GRAPH_EDGE_STYLES).sort().join(',') === 'conflict,layer,ref,semantic,summary,tag'
  && G.graphEdgeStyle('summary').color === '#ff6b7a'
  && G.graphEdgeStyle('conflict').color === '#ffa04d'
  && G.graphEdgeStyle('conflict').dash.length === 2
  && G.graphEdgeStyle('ref').color === '#5fe0d4'
  && G.graphEdgeStyle('semantic').alpha < G.graphEdgeStyle('layer').alpha
  && G.graphEdgeStyle('semantic').alpha < G.graphEdgeStyle('tag').alpha)
ok('未知边类型退回极淡的 semantic，不抛错',
  G.graphEdgeStyle('bogus').color === G.graphEdgeStyle('semantic').color)
ok('边的自然长度六类都有，且 summary 最短（关系最硬）',
  Object.keys(G.GRAPH_EDGE_LENGTH).sort().join(',') === 'conflict,layer,ref,semantic,summary,tag'
  && G.GRAPH_EDGE_LENGTH.summary === Math.min(...Object.values(G.GRAPH_EDGE_LENGTH)))

// ── 3. 纯函数：撒点 / 力导向 ───────────────────────────────────
const seededA = G.graphSeedPositions([
  { id: 'a', layer: 'L0' },
  { id: 'b', layer: 'L2' },
  { id: 'c', layer: 'L2' },
])
const seededB = G.graphSeedPositions([
  { id: 'a', layer: 'L0' },
  { id: 'b', layer: 'L2' },
  { id: 'c', layer: 'L2' },
])
ok('撒点是确定性的：同一批 id 每次打开落在同一片星域',
  seededA.every((node, index) => node.x === seededB[index].x && node.y === seededB[index].y)
  && seededA.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)))

const layoutNodes = [
  { id: 'left', layer: 'L2', x: -200, y: 0, vx: 0, vy: 0 },
  { id: 'right', layer: 'L2', x: 200, y: 0, vx: 0, vy: 0 },
]
const layoutEdges = [{ a: 'left', b: 'right', type: 'tag', weight: 0.5 }]
const before = Math.hypot(layoutNodes[0].x - layoutNodes[1].x, layoutNodes[0].y - layoutNodes[1].y)
G.graphLayout(layoutNodes, layoutEdges, 220)
const after = Math.hypot(layoutNodes[0].x - layoutNodes[1].x, layoutNodes[0].y - layoutNodes[1].y)
ok('力导向把有边的两颗星拉近，且坐标 / 速度都是有限数',
  after < before
  && layoutNodes.every((node) => [node.x, node.y, node.vx, node.vy].every(Number.isFinite)),
  { before, after })
const coincident = [{ id: 'same', x: 0, y: 0, vx: 0, vy: 0 }, { id: 'same', x: 0, y: 0, vx: 0, vy: 0 }]
const energy = G.graphStep(coincident, [], { alpha: 1 })
ok('完全重合的节点不会算出 NaN（会先被哈希推开）',
  Number.isFinite(energy)
  && coincident.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)))
ok('空图跑力导向返回 0，不抛错', G.graphStep([], [], { alpha: 1 }) === 0)

// ── 4. 纯函数：搜索 / 命中 ─────────────────────────────────────
const searchNode = { label: '用户喜欢冰美式', text: '早上要来一杯', tags: ['偏好', '饮品'], fieldLabel: '称呼' }
ok('搜索能命中正文 / 标签 / 画像字段名，大小写不敏感',
  G.graphMatches(searchNode, '冰美式')
  && G.graphMatches(searchNode, '饮品')
  && G.graphMatches(searchNode, '称呼')
  && G.graphMatches(searchNode, 'ICE') === false
  && G.graphMatches({ label: 'Ice Coffee' }, 'ice'))
ok('空关键词匹配所有节点；空白关键词也当空',
  G.graphMatches(searchNode, '') && G.graphMatches(searchNode, '   ') && G.graphMatches(searchNode, null))

const hitNodes = [
  { id: 'a', x: 0, y: 0, kind: 'memory', layer: 'L2', weight: 0.5, freshness: 0.5 },
  { id: 'b', x: 100, y: 0, kind: 'memory', layer: 'L2', weight: 0.5, freshness: 0.5 },
]
ok('命中测试：点在星上返回最近的一颗，点空处返回 null',
  G.graphHitTest(hitNodes, 2, 2)?.id === 'a'
  && G.graphHitTest(hitNodes, 101, 0)?.id === 'b'
  && G.graphHitTest(hitNodes, 50, 0) === null)

// ── 5. 面板入口与覆盖层 ────────────────────────────────────────
/** 桩里的 textContent 不会向父节点冒泡，断言卡片内容时自己递归拼一遍。 */
function textOf(node) {
  return [node.textContent ?? '', ...node.children.map(textOf)].join(' ')
}

const graphEntry = editor.querySelector('[data-role="open-graph"]')
ok('「✦ 昔涟」面板里多了一行「✦ 记忆星图」入口',
  graphEntry !== null
  && graphEntry.attrs['data-role'] === 'open-graph'
  && editor.innerHTML.includes('✦ 记忆星图')
  && editor.innerHTML.includes('打开星图'),
  { html: editor.innerHTML.includes('✦ 记忆星图'), entry: graphEntry?.attrs })

const beforeOpenCalls = boot.calls.length
editor.dispatch('click', { target: graphEntry })
await tick()
await flushFrame(4)
const overlay = boot.doc.body.children.find((node) => typeof node.className === 'string'
  && node.className.includes('cyre-overlay--graph'))
ok('点入口后整页覆盖层挂到 body 上（和背景管理器同一套开合方式）',
  overlay !== undefined && overlay.attrs['role'] === 'dialog'
  && overlay.attrs['aria-label'] === '昔涟 · 记忆星图',
  overlay?.attrs)

const canvas = overlay.querySelector('[data-role="graph-canvas"]')
const context = canvas.getContext('2d')
ok('覆盖层里有原生 canvas 2D，并且真的画了星点与连线',
  canvas !== null && context.arcs.length > 0 && context.strokes > 0 && context.labels.length > 0,
  { arcs: context.arcs.length, strokes: context.strokes, labels: context.labels.length })

const statusLine = overlay.querySelector('[data-role="graph-status"]').textContent
ok('状态行给出节点 / 边数与生成时间',
  statusLine.includes('4 颗星') && statusLine.includes('3 条线') && statusLine.includes('2026-11-08 03:00'),
  statusLine)
ok('打开时拉一次 GET /cyrene/memory/graph，且不带 reload',
  boot.calls.slice(beforeOpenCalls).some((call) => call.method === 'GET'
    && call.url.includes('/cyrene/memory/graph') && !call.url.includes('reload=1')),
  boot.calls.slice(beforeOpenCalls).map((call) => call.url))

// ── 6. 刷新 / 搜索 / 连线开关 ───────────────────────────────────
const refreshButton = overlay.querySelector('[data-role="graph-refresh"]')
const beforeRefresh = boot.calls.length
refreshButton.dispatch('click')
await tick()
ok('手动刷新带 ?reload=1，强制宿主重读磁盘',
  boot.calls.slice(beforeRefresh).some((call) => call.url.includes('/cyrene/memory/graph?reload=1')),
  boot.calls.slice(beforeRefresh).map((call) => call.url))

const search = overlay.querySelector('[data-role="graph-search"]')
const beforeSearch = boot.calls.length
search.value = '冰美式'
search.dispatch('input')
ok('搜索只过滤本地节点，不发请求',
  boot.calls.length === beforeSearch
  && G.graphMatches(GRAPH_NODES[0], search.value) === true
  && G.graphMatches(GRAPH_NODES[2], search.value) === false)

const linesButton = overlay.querySelector('[data-role="graph-lines"]')
linesButton.dispatch('click')
const linesOff = linesButton.attrs['data-on'] === '0' && linesButton.textContent === '连线：关'
linesButton.dispatch('click')
ok('连线开关能关能开，按钮文字与 data-on 跟着变',
  linesOff && linesButton.attrs['data-on'] === '1' && linesButton.textContent === '连线：开')

// ── 7. 点星弹卡片（用画布记录的第一颗星坐标反推屏幕坐标）──────
const firstRadius = G.graphNodeRadius(GRAPH_NODES[0])
const firstArc = context.arcs.find((arc) => Math.abs(arc.r - firstRadius * 3.4) < 0.001)
ok('画布按 graphNodeRadius 画出第一颗星的光晕', firstArc !== undefined, {
  radius: firstRadius,
  arcs: context.arcs.slice(0, 6),
})
if (firstArc !== undefined) {
  const screenX = firstArc.x + 400
  const screenY = firstArc.y + 260
  canvas.dispatch('pointerdown', { clientX: screenX, clientY: screenY, pointerId: 1 })
  canvas.dispatch('pointerup', { clientX: screenX, clientY: screenY, pointerId: 1 })
  const card = overlay.querySelector('[data-role="graph-card"]')
  const cardText = textOf(card)
  ok('点一颗星弹出卡片：正文 / 成色 / 时间都在',
    card.hidden === false
    && cardText.includes('用户喜欢冰美式')
    && cardText.includes('成色 80%')
    && cardText.includes('记于 2026-11-05 09:00')
    && cardText.includes('偏好'),
    cardText)
  const cardClose = card.descendants().find((node) => node.className === 'cyre-graph-card-close')
  cardClose.dispatch('click')
  ok('卡片上的 ✕ 能把卡片收起来', card.hidden === true)
}

// ── 8. 页面隐藏时停 rAF，回来再续上 ────────────────────────────
flushFrame(2)
const queuedBeforeHide = rafQueue.size
boot.doc.visibilityState = 'hidden'
const cancelledBefore = cancelled
boot.doc.dispatch('visibilitychange')
ok('页面隐藏：取消已排的 requestAnimationFrame，不再排新帧',
  queuedBeforeHide > 0 && rafQueue.size === 0 && cancelled > cancelledBefore,
  { queuedBeforeHide, cancelled: cancelled - cancelledBefore })
boot.doc.visibilityState = 'visible'
boot.doc.dispatch('visibilitychange')
ok('页面回来：重新排帧继续画', rafQueue.size > 0)
flushFrame(1)

// ── 9. 关闭：Esc / ✕ 都要把覆盖层摘掉并停帧 ─────────────────────
boot.doc.dispatch('keydown', { key: 'Escape' })
ok('Esc 关闭星图覆盖层',
  boot.doc.body.children.every((node) => !String(node.className).includes('cyre-overlay--graph')))
await tick()

editor.dispatch('click', { target: graphEntry })
await tick()
const secondOverlay = boot.doc.body.children.find((node) => typeof node.className === 'string'
  && node.className.includes('cyre-overlay--graph'))
const secondClose = secondOverlay.descendants().find((node) => node.className === 'cyre-close')
const beforeClose = cancelled
secondClose.dispatch('click')
await tick()
ok('✕ 关闭星图覆盖层，并取消正在跑的帧',
  boot.doc.body.children.every((node) => !String(node.className).includes('cyre-overlay--graph'))
  && cancelled > beforeClose,
  { cancelled: cancelled - beforeClose })

// ── 汇总 ────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed}/${passed + failures.length}`)
if (failures.length > 0) {
  console.log(`失败项：${failures.join(' | ')}`)
  process.exitCode = 1
}
assert.equal(failures.length, 0)

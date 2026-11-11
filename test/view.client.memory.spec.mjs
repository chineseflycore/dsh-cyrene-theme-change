/**
 * 客户端面板两张新卡片（画像与关系 / 记忆管理增强）自检。
 *
 *   node test/view.client.memory.spec.mjs
 *
 * 复用 view.client.smoke.mjs 的最小 DOM / react / fetch 桩思路，只把 bundle 跑起来，
 * 从设置页拿到同一份编辑器（浮动面板与设置页共用 createEditor），验证：
 *   · 原有入口行一个不少（不改动现有结构），新卡片追加在后面；
 *   · 画像与关系的字段来自 GET /cyrene/memory/profile；
 *   · 记忆卡片的 layer 徽章 / 成色条宽度 / 状态灰显 / 摘要标记；
 *   · 钉住 / 取消钉住发 POST /cyrene/memory { action: 'pin' } 并带记忆自己的 rev；
 *   · active / aging / archived 筛选只过滤、不发请求。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const PACKAGE_ID = 'dsh-cyrene-theme-change'

let passed = 0
const failures = []
function ok(label, condition, extra) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`)
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

/** 极简 DOM 元素桩：够 createEditor 用（属性 / 子节点 / 事件 / style / innerHTML）。 */
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

class El {
  constructor(tag) {
    this.tagName = tag
    this.attrs = {}
    this.children = []
    this.listeners = {}
    this.value = ''
    this.checked = false
    this.disabled = false
    this._text = ''
    this.parent = null
    this._html = ''
    this.style = {
      _props: {},
      setProperty(name, value) { this._props[name] = String(value) },
      removeProperty(name) { delete this._props[name] },
      getPropertyValue(name) { return this._props[name] ?? '' },
    }
  }
  set textContent(value) {
    this._text = String(value)
    if (this._text === '') this.children = []
  }
  get textContent() { return this._text }
  setAttribute(key, value) { this.attrs[key] = String(value) }
  getAttribute(key) { return this.attrs[key] ?? null }
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
    return this.descendants().find((node) => (
      roleMatch !== null ? node.attrs['data-role'] === roleMatch[1] : node.tagName === selector
    )) ?? null
  }
  querySelectorAll() { return [] }
  focus() {}
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
  return {
    baseURI: 'http://127.0.0.1:19387/',
    visibilityState: 'visible',
    head,
    body,
    createElement(tag) { return new El(tag) },
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  }
}

async function bootstrap(response) {
  const calls = []
  const refs = []
  let spec = null
  globalThis.window = {
    __ModuleLoader__: { load(value) { spec = value } },
    addEventListener() {},
    removeEventListener() {},
    confirm: () => true,
  }
  globalThis.document = makeDoc()
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = 'data:image/png;base64,AAAA'
      if (typeof this.onload === 'function') this.onload()
    }
  }
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', body: init.body }
    calls.push(call)
    const decided = typeof response === 'function' ? await response(call, calls.length) : { status: 200, payload: response }
    const status = decided?.status ?? 200
    const payload = decided?.payload ?? decided
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    }
  }
  globalThis.setInterval = () => ({ unref() {} })
  globalThis.clearInterval = () => {}

  const source = await readFile(CLIENT, 'utf8')
  ;(0, eval)(source)

  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useRef: () => {
      const ref = { current: new El('div') }
      refs.push(ref)
      return ref
    },
    useEffect: (fn) => {
      const dispose = fn()
      return dispose
    },
    useState: (initial) => {
      let value = initial
      return [value, (next) => { value = typeof next === 'function' ? next(value) : next }]
    },
    useSyncExternalStore() {},
  }
  const exports_ = spec.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require(${name})`)
  })
  return { spec, exports: exports_, calls, refs, doc: globalThis.document }
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

// ── 预设数据 ─────────────────────────────────────────────────────
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
const STICKERS = { ok: true, value: { version: 1, maxPerTurn: 1, items: [], missing: [], error: null } }
const BACKGROUNDS = { ok: true, value: { folder: 'Background', items: [], error: null } }
const WORLDBOOK = {
  ok: true,
  value: { error: null, count: 0, version: '', fetchedAt: '', path: '', source: '', characters: [], categories: [], entries: [] },
}
const PROFILE = {
  ok: true,
  value: {
    l0: {
      preferredName: '小满',
      occupation: '前端工程师',
      longTermInterests: '画画',
      language: '中文',
      permanentNote: '有一只猫',
    },
    l1: {
      recentGoals: '学完 Transformer',
      recentPreferences: '喜欢深色主题',
      currentProject: '一个 DSH 插件',
    },
    relationship: {
      affinity: 55,
      trust: 40,
      familiarity: 12,
      turns: 41,
      dominant: { dimension: 'affection', label: '亲近', intensity: 0.5 },
      nextCareCue: '下轮别加活，先让她歇一口气',
      summary: '在变熟 · 亲近 · 第41轮',
      stage: { key: 'familiar', label: '熟络', hint: '语气自然放松' },
    },
  },
}

let memLive = {
  error: null,
  enabled: true,
  rev: 4,
  count: 4,
  limit: 300,
  path: 'C:/x/cyrene-memory.json',
  items: [
    {
      id: 'mem-active-1',
      text: '用户偏好深色主题',
      tags: ['偏好'],
      created: '2026-10-29T12:00:00.000Z',
      layer: 'L2',
      status: 'active',
      weight: 0.5,
      pinned: true,
    },
    {
      id: 'mem-aging-2',
      text: '上周说想学做甜点',
      tags: ['计划'],
      created: '2026-10-20T12:00:00.000Z',
      layer: 'L2',
      status: 'aging',
      weight: 0.15,
      pinned: false,
    },
    {
      id: 'mem-arch-3',
      text: '很久以前提过想去海边',
      tags: ['出行'],
      created: '2025-12-01T12:00:00.000Z',
      layer: 'L2',
      status: 'archived',
      weight: 0.06,
      pinned: false,
    },
    {
      id: 'mem-sum-4',
      text: '【2026-01-01 ~ 2026-02-01｜事件】一月去爬山；二月去看海',
      tags: ['事件'],
      created: '2026-11-05T12:00:00.000Z',
      layer: 'L2',
      status: 'active',
      weight: 0.62,
      pinned: false,
      isSummary: true,
      subEntryIds: ['mem-x1', 'mem-x2'],
    },
  ],
}

const boot = await bootstrap((call) => {
  if (call.url.includes('/cyrene/memory/profile')) return { status: 200, payload: PROFILE }
  if (call.url.includes('/cyrene/memory/reveal')) {
    return { status: 200, payload: { ok: true, value: { opened: true, path: 'C:/x/cyrene-memory.json' } } }
  }
  if (call.url.includes('/cyrene/memory')) {
    if (call.method === 'GET') return { status: 200, payload: { ok: true, value: memLive } }
    const body = JSON.parse(call.body)
    if (body.action === 'pin') {
      memLive = {
        ...memLive,
        rev: memLive.rev + 1,
        items: memLive.items.map((item) => item.id === body.id
          ? { ...item, pinned: body.pinned === true, weight: body.pinned === true ? 0.7 : 0.69, status: 'active' }
          : item),
      }
    }
    return { status: 200, payload: { ok: true, value: memLive } }
  }
  if (call.url.includes('/cyrene/backgrounds')) return { status: 200, payload: BACKGROUNDS }
  if (call.url.includes('/cyrene/stickers')) return { status: 200, payload: STICKERS }
  if (call.url.includes('/cyrene/worldbook')) return { status: 200, payload: WORLDBOOK }
  if (call.url.includes('/cyrene/report')) return { status: 200, payload: { ok: true, value: { at: 'now' } } }
  return { status: 200, payload: STATE }
})

const box = makeCtx()
boot.exports.apply(box.ctx)
await tick()
box.registered.find((entry) => entry.registration.id === 'cyrene-theme').component()
await tick()
const editor = boot.refs[0].current.children[0]
const style = boot.doc.head.children.find((node) => node.attrs['data-plugin-css'] === PACKAGE_ID)

// ── 1. 结构：原有入口一个不少，新卡片追加在后面 ─────────────────────
ok(
  '原有结构没动：长期记忆入口那一行还在，旧记忆列表没有搬进编辑器',
  editor.querySelector('[data-role="open-memory"]') !== null &&
    editor.querySelector('[data-role="memory-note"]') !== null &&
    editor.querySelector('[data-role="mem-list"]') === null,
)
ok(
  '新增两张卡片：画像与关系 / 记忆管理增强',
  editor.querySelector('[data-role="profile-card"]') !== null &&
    editor.querySelector('[data-role="memory-card"]') !== null &&
    editor.querySelector('[data-role="memx-list"]') !== null,
)
ok(
  '画像与关系的数据来自 GET /cyrene/memory/profile',
  boot.calls.some((call) => call.method === 'GET' && call.url.endsWith('/cyrene/memory/profile')),
  boot.calls.map((call) => `${call.method} ${call.url}`).filter((line) => line.includes('/memory')),
)

// ── 2. 画像与关系 ────────────────────────────────────────────────
const profileKv = editor.querySelector('[data-role="profile-kv"]')
const relationKv = editor.querySelector('[data-role="relation-kv"]')
const profileText = profileKv.textContent
ok(
  'L0 五个字段都画出来了（称呼 / 职业 / 长期爱好 / 语言 / 其他）',
  ['称呼：小满', '职业：前端工程师', '长期爱好：画画', '语言/地区：中文', '其他固定信息：有一只猫']
    .every((line) => profileText.includes(line)),
  profileText,
)
ok(
  'L1 三个字段也画出来了（近期目标 / 近期偏好 / 在忙的事）',
  ['近期目标：学完 Transformer', '近期偏好：喜欢深色主题', '在忙的事：一个 DSH 插件']
    .every((line) => profileText.includes(line)),
  profileText,
)
ok(
  '关系阶段 / 当前情绪 / nextCareCue 都来自 profile 路由',
  relationKv.textContent.includes('关系阶段：熟络') &&
    relationKv.textContent.includes('当前情绪：亲近') &&
    relationKv.textContent.includes('下一轮可以留意：下轮别加活，先让她歇一口气'),
  relationKv.textContent,
)

// ── 3. 记忆管理增强：徽章 / 成色条 / 灰显 / 摘要 ───────────────────
const list = editor.querySelector('[data-role="memx-list"]')
const cards = () => list.descendants().filter((node) => node.className === 'cyre-memx-item')
const cardOf = (id) => cards().find((card) => {
  const pin = card.descendants().find((node) => node.attrs['data-role'] === 'memx-pin')
  return pin !== undefined && pin.attrs['data-id'] === id
})

ok('记忆卡片按宿主快照逐条渲染', cards().length === 4, cards().length)
ok(
  '每条都有 layer 徽章',
  cards().every((card) => card.descendants().some((node) => node.attrs['data-role'] === 'memx-layer' && node.textContent === 'L2')),
  cards().map((card) => card.descendants().find((node) => node.attrs['data-role'] === 'memx-layer')?.textContent),
)
const widthOf = (id) => {
  const card = cardOf(id)
  const bar = card.descendants().find((node) => node.attrs['data-role'] === 'memx-bar')
  return bar.children[0].style.width
}
ok(
  '成色条把 0..1 转成百分比宽度',
  widthOf('mem-active-1') === '50%' && widthOf('mem-aging-2') === '15%' &&
    widthOf('mem-arch-3') === '6%' && widthOf('mem-sum-4') === '62%',
  [widthOf('mem-active-1'), widthOf('mem-aging-2'), widthOf('mem-arch-3'), widthOf('mem-sum-4')],
)
ok(
  '状态写进 data-status（archived / aging 由 CSS 灰显）',
  cardOf('mem-arch-3').attrs['data-status'] === 'archived' &&
    cardOf('mem-aging-2').attrs['data-status'] === 'aging' &&
    /\.cyre-memx-item\[data-status="archived"\]/.test(style.textContent) &&
    /\.cyre-memx-item\[data-status="aging"\]/.test(style.textContent),
)
ok(
  '摘要条目带「摘要」徽章与 data-summary 标记',
  cardOf('mem-sum-4').attrs['data-summary'] === '1' &&
    cardOf('mem-sum-4').descendants().some((node) => node.textContent === '摘要'),
)
ok(
  '已钉住的显示「取消钉住」，未钉住的显示「钉住」',
  cardOf('mem-active-1').descendants().find((node) => node.attrs['data-role'] === 'memx-pin').textContent === '取消钉住' &&
    cardOf('mem-aging-2').descendants().find((node) => node.attrs['data-role'] === 'memx-pin').textContent === '钉住',
)

// ── 4. 状态筛选（纯本地，不发请求）──────────────────────────────────
const filter = editor.querySelector('[data-role="memx-filter"]')
const beforeFilterCalls = boot.calls.length
filter.value = 'archived'
filter.dispatch('change')
ok('筛选 archived：只剩归档条目', cards().length === 1 && cards()[0].attrs['data-status'] === 'archived', cards().length)
filter.value = 'aging'
filter.dispatch('change')
ok('筛选 aging：只剩 aging 条目', cards().length === 1 && cards()[0].attrs['data-status'] === 'aging', cards().length)
filter.value = 'active'
filter.dispatch('change')
ok('筛选 active：钉住条目与摘要都算 active', cards().length === 2, cards().length)
filter.value = 'all'
filter.dispatch('change')
ok('筛选 all：回到全部', cards().length === 4, cards().length)
ok('筛选只过滤本地列表，不发任何请求', boot.calls.length === beforeFilterCalls, boot.calls.length - beforeFilterCalls)
ok(
  '概况行给出三档计数',
  editor.querySelector('[data-role="memx-note"]').textContent === 'active 2 · aging 1 · archived 1',
  editor.querySelector('[data-role="memx-note"]').textContent,
)

// ── 5. 钉住 / 取消钉住：POST action=pin ───────────────────────────
const beforePin = boot.calls.length
cardOf('mem-aging-2').descendants().find((node) => node.attrs['data-role'] === 'memx-pin').dispatch('click')
await tick()
const pinCall = boot.calls.slice(beforePin).find((call) => call.method === 'POST' && call.url.includes('/cyrene/memory'))
const pinBody = pinCall === undefined ? {} : JSON.parse(pinCall.body)
ok(
  '点「钉住」发 POST action=pin，带记忆自己的 rev 与 id',
  pinBody.action === 'pin' && pinBody.id === 'mem-aging-2' && pinBody.pinned === true && pinBody.rev === 4,
  pinBody,
)
ok(
  '钉住之后那一条的按钮变成「取消钉住」',
  cardOf('mem-aging-2').descendants().find((node) => node.attrs['data-role'] === 'memx-pin').textContent === '取消钉住',
  cardOf('mem-aging-2')?.descendants().find((node) => node.attrs['data-role'] === 'memx-pin')?.textContent,
)

const beforeUnpin = boot.calls.length
cardOf('mem-aging-2').descendants().find((node) => node.attrs['data-role'] === 'memx-pin').dispatch('click')
await tick()
const unpinCall = boot.calls.slice(beforeUnpin).find((call) => call.method === 'POST' && call.url.includes('/cyrene/memory'))
const unpinBody = unpinCall === undefined ? {} : JSON.parse(unpinCall.body)
ok(
  '再点一次发 pinned=false（取消钉住）',
  unpinBody.action === 'pin' && unpinBody.id === 'mem-aging-2' && unpinBody.pinned === false && unpinBody.rev === 5,
  unpinBody,
)

// ── 6. 样式：复用现有变量，不引入新依赖 ───────────────────────────
const css = style.textContent
ok(
  '新卡片样式用现有 --cy-ui-* 变量，没有新增外部依赖',
  /\.cyre-card\{[^}]*var\(--cy-ui-line\)/.test(css) &&
    /\.cyre-kv\{[^}]*var\(--cy-ui-text\)/.test(css) &&
    /\.cyre-memx-fill\{[^}]*linear-gradient\(90deg,#f08bb8,#d9558f\)/.test(css),
)
ok(
  '记忆卡片样式齐全（徽章 / 状态 / 钉住按钮 / 成色条）',
  /\.cyre-memx-badge\{/.test(css) && /\.cyre-memx-status\{/.test(css) &&
    /\.cyre-memx-pin\{/.test(css) && /\.cyre-memx-bar\{/.test(css) &&
    /\.cyre-select\{/.test(css),
)

// ── 汇总 ─────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed}/${passed + failures.length}`)
if (failures.length > 0) {
  console.log(`失败项：${failures.join(' | ')}`)
  process.exitCode = 1
}
assert.equal(failures.length, 0)

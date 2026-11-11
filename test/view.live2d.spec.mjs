/**
 * 桌宠（Live2D）客户端半集成测试：用最小 DOM / PIXI 桩把 bundle 跑一遍。
 *
 *   node test/view.live2d.spec.mjs
 *
 * 覆盖：默认关闭不挂 canvas、state.pet=true 时挂 canvas 并加载模型、
 *      情绪轮询 → 表情、阶段轮询 → FORCE 动作、面板「桌宠」开关与
 *      「当前情绪」只读行、关掉开关后 canvas 与定时器一起收走。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const CLIENT = new URL('../lib/client.js', import.meta.url)
const PACKAGE_ID = 'dsh-cyrene-theme-change'

let passed = 0
const failures = []
function ok(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail === undefined ? '' : ' → ' + JSON.stringify(detail)}`)
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25))
async function waitFor(check, timeout = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      if (check() === true) return true
    } catch {
      // 继续等
    }
    await tick()
  }
  return false
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
    this.dataset = {}
    this.style = {
      _props: {},
      setProperty(name, value) { this._props[name] = String(value) },
      removeProperty(name) { delete this._props[name] },
      getPropertyValue(name) { return this._props[name] ?? '' },
    }
  }
  set textContent(v) {
    this._text = String(v)
    if (this._text === '') this.children = []
  }
  get textContent() { return this._text }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) }
  removeAttribute(k) { delete this.attrs[k] }
  appendChild(child) { child.parent = this; this.children.push(child); return child }
  append(...children) { for (const child of children) this.appendChild(child) }
  remove() {
    this.removed = true
    if (this.parent !== null) this.parent.children = this.parent.children.filter((c) => c !== this)
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn) }
  dispatch(type, event = {}) { for (const fn of this.listeners[type] ?? []) fn({ target: this, ...event }) }
  closest(selector) {
    const wantButton = selector.includes('button')
    for (let node = this; node !== null; node = node.parent) {
      if (wantButton && node.tagName === 'button') return node
    }
    return null
  }
  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]) }
  querySelector(selector) {
    const roleMatch = /\[data-role="([^"]+)"\]/.exec(selector)
    if (roleMatch !== null) {
      return this.descendants().find((node) => node.getAttribute('data-role') === roleMatch[1]) ?? null
    }
    const classMatch = /^\.([\w-]+)$/.exec(selector)
    if (classMatch !== null) {
      return this.descendants().find((node) => node.className === classMatch[1]) ?? null
    }
    return this.descendants().find((node) => node.tagName === selector) ?? null
  }
  querySelectorAll() { return [] }
  focus() {}
  set innerHTML(html) {
    this._html = html
    this.children = []
    const tagRe = /<(\w+)([^>]*)>/g
    let tagMatch
    while ((tagMatch = tagRe.exec(html)) !== null) {
      const child = new El(tagMatch[1])
      const attrRe = /([\w-]+)="([^"]*)"/g
      let attrMatch
      while ((attrMatch = attrRe.exec(tagMatch[2])) !== null) child.attrs[attrMatch[1]] = attrMatch[2]
      this.appendChild(child)
    }
  }
  get innerHTML() { return this._html }
  get clientWidth() { return 220 }
  get clientHeight() { return 280 }
}

function makeDoc() {
  const head = new El('head')
  const body = new El('body')
  const doc = {
    baseURI: 'http://127.0.0.1:19387/',
    visibilityState: 'visible',
    head,
    body,
    createElement(tag) { return new El(tag) },
    querySelector() { return null },
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  }
  // loadPetScript 把 onload 挂上之后才 append：这里 append 时同步触发。
  head.appendChild = (child) => {
    child.parent = head
    head.children.push(child)
    if (typeof child.onload === 'function') setTimeout(child.onload, 0)
    return child
  }
  return doc
}

const STATE = {
  persona: '昔涟的设定',
  enabled: true,
  theme: true,
  stickers: true,
  pet: true,
  defaultPersona: '默认昔涟',
  statePath: '/tmp/cyrene-theme.json',
  background: { enabled: false, current: '', rotate: false, interval: 90, dim: 0.6 },
  rev: 0,
}

const RELATIONSHIP = {
  ok: true,
  value: {
    affinity: 50,
    trust: 40,
    familiarity: 10,
    turns: 12,
    dominant: {
      dimension: 'joy',
      label: '开心',
      intensity: 0.7,
      presentation: { expression: '开心眼', motion: { group: 'Tick3', index: 2 } },
    },
    summary: '在变熟 · 开心 · 第12轮',
  },
}

const PET = {
  ok: true,
  value: {
    phase: 'thinking',
    at: Date.now(),
    enabled: true,
    dominant: RELATIONSHIP.value.dominant,
  },
}

const EMPTY = { ok: true, value: { items: [], count: 0, l0: {}, l1: {}, relationship: {}, error: null, enabled: true, rev: 0 } }

async function bootstrap(options = {}) {
  const calls = []
  const registered = []
  const effects = []
  let spec = null
  const modelCalls = { expressions: [], motions: [] }
  const fakeModel = {
    width: 800,
    height: 1000,
    anchor: { set() {} },
    scale: { set() {} },
    x: 0,
    y: 0,
    expression(name) { modelCalls.expressions.push(name) },
    motion(group, index, priority) { modelCalls.motions.push({ group, index, priority }) },
  }

  globalThis.window = {
    __ModuleLoader__: { load(s) { spec = s } },
    addEventListener() {},
    removeEventListener() {},
    confirm: () => true,
    devicePixelRatio: 1,
    PIXI: {
      Application: class Application {
        constructor(opts) {
          this.view = opts.view
          this.ticker = {}
          this.stage = { addChild() {} }
          this.renderer = { resize() {} }
          this.destroyed = false
        }
        destroy() { this.destroyed = true }
      },
      live2d: {
        Live2DModel: {
          async from() { return fakeModel },
        },
      },
    },
  }
  globalThis.document = makeDoc()

  let state = { ...STATE, pet: options.pet === false ? false : true }

  globalThis.fetch = async (url, init = {}) => {
    const href = String(url)
    calls.push({ url: href, method: init.method ?? 'GET', body: init.body })
    const respond = (payload) => ({
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    })
    if (href.includes('/cyrene/state')) {
      if ((init.method ?? 'GET') === 'POST') {
        const patch = JSON.parse(init.body ?? '{}')
        state = { ...state, ...patch, rev: state.rev + 1 }
        return respond({ ok: true, value: state })
      }
      return respond({ ok: true, value: state })
    }
    if (href.includes('/cyrene/relationship')) return respond(RELATIONSHIP)
    if (href.includes('/cyrene/pet')) return respond(PET)
    return respond(EMPTY)
  }

  const source = await readFile(CLIENT, 'utf8')
  ;(0, eval)(source)

  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useRef: (v) => ({ current: v ?? new El('div') }),
    useEffect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose) },
    useState: (initial) => { let value = initial; return [value, (next) => { value = next }] },
    useSyncExternalStore() {},
  }
  const exports_ = spec.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require(${name})`)
  })

  const ctx = {
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
    },
    get() { return undefined },
    slots: {
      inject(name, cb) { cb() },
      register(registration, component) { registered.push({ registration, component }) },
    },
  }
  exports_.apply(ctx)
  return { exports: exports_, calls, registered, effects, modelCalls, fakeModel, getState: () => state }
}

const bodyHas = (className) => globalThis.document.body.descendants()
  .some((el) => el.className === className)

console.log('view.live2d.spec.mjs\n')

// ── 1. 默认关闭：不挂 canvas，也不请求模型 ─────────────────────────
const off = await bootstrap({ pet: false })
await tick()
await tick()
ok('state.pet=false 时不挂桌宠 canvas', !bodyHas('cyre-pet'))
ok('默认关闭时不会去拉模型 / Cubism Core',
  !off.calls.some((call) => call.url.includes('live2dcubismcore') || call.url.includes('Cyrene.model3')),
  off.calls.map((call) => call.url))
for (const dispose of off.effects) if (typeof dispose === 'function') dispose()

// ── 2. 打开：加载模型、情绪表情、阶段动作 ─────────────────────────
const box = await bootstrap({ pet: true })
ok('state.pet=true 后挂上 cyre-pet canvas', await waitFor(() => bodyHas('cyre-pet')))
ok('canvas 类名是 cyre-pet-canvas（不会和 dsh-cyrene 的 cyrene-pet 串）',
  globalThis.document.body.querySelector('.cyre-pet-canvas') !== null)

await waitFor(() => box.modelCalls.expressions.includes('开心眼'))
ok('关系里的 joy → 开心眼表情', box.modelCalls.expressions.includes('开心眼'), box.modelCalls.expressions)
await waitFor(() => box.modelCalls.motions.length > 0)
ok('阶段 thinking → 动作#6 / 1，FORCE 优先级 3',
  box.modelCalls.motions.some((m) => m.group === '动作#6' && m.index === 1 && m.priority === 3),
  box.modelCalls.motions)

// ── 3. 面板：开关 + 当前情绪只读行 ────────────────────────────────
const action = box.registered.find((one) => one.registration.name === 'sidebar.footer.action')
ok('侧边栏入口已注册', action !== undefined)
action.component({ wide: true }).props.onClick()
await tick()
const petBox = globalThis.document.body.querySelector('[data-role="pet"]')
const emotionLine = globalThis.document.body.querySelector('[data-role="pet-emotion"]')
ok('面板里有「桌宠」开关且当前是勾上的', petBox !== null && petBox.checked === true, petBox?.checked)
ok('面板里有「当前情绪」只读行，显示 开心（70%）',
  emotionLine !== null && emotionLine.textContent === '开心（70%）', emotionLine?.textContent)

// ── 4. 关掉：canvas 收走，POST 带 pet:false ─────────────────────
petBox.checked = false
petBox.dispatch('change')
ok('关掉开关后 canvas 被移除', await waitFor(() => !bodyHas('cyre-pet')))
const saved = box.calls.filter((call) => call.method === 'POST' && call.url.includes('/cyrene/state'))
ok('关掉开关走 /cyrene/state，并带上 pet:false 与 rev',
  saved.some((call) => JSON.parse(call.body).pet === false && Number.isInteger(JSON.parse(call.body).rev)),
  saved.map((call) => call.body))

// ── 5. 卸载：清掉定时器（不留下轮询） ────────────────────────────
let disposeError = null
try {
  for (const dispose of box.effects) if (typeof dispose === 'function') dispose()
} catch (error) {
  disposeError = error
}
ok('卸载时销毁桌宠不报错', disposeError === null, disposeError?.message)
ok('卸载后 canvas 不在了', !bodyHas('cyre-pet'))

console.log(`\n${failures.length > 0 ? 'FAIL' : 'PASS'}  ${passed}/${passed + failures.length}`)
if (failures.length > 0) process.exitCode = 1

/**
 * 钉住 / 统计工具（实施单 §9.3 保护线 + §5.2 账本 + §5.3 健康行）自检。
 *
 *   node test/host.memory.tools.spec.mjs
 *
 * 覆盖：
 *   1) cyrene_memory_pin：钉住把成色抬到 0.7 以上、取消钉住回到 0.69，
 *      并且「取消」之后重新加载不会被 sanitize 的 0.7 自动钉住规则复活；
 *   2) POST /cyrene/memory { action: 'pin' }：成功、404、与工具行为一致；
 *   3) cyrene_memory_stats：counts + ledger 状态 + 健康一行。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PIN_WEIGHT, decayWeight } from '../lib/host/cognitive.js'

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

// ── 1. 纯函数：保护线语义 ─────────────────────────────────────────
const now = Date.now()
ok('钉住（0.7 以上）永不衰减', decayWeight({ weight: 0.7, pinned: true, lastDecay: now - 30 * 86_400_000 }, now) === 0.7)
ok('取消钉住后（0.69）重新按日衰减',
  decayWeight({ weight: 0.69, pinned: false, lastDecay: now - 30 * 86_400_000 }, now) < 0.69)
ok('保护线常量就是实施单的 0.7', PIN_WEIGHT === 0.7)

// ── 2. 插件集成 ──────────────────────────────────────────────────
const home = await mkdtemp(join(tmpdir(), 'cyrene-tools-'))
process.env.DSH_HOME = home
delete process.env.MEM_LEDGER
process.env.CYRENE_CUSTOM_STICKER_DIR = join(home, 'stickers-custom')
process.env.CYRENE_CUSTOM_BACKGROUND_DIR = join(home, 'backgrounds-custom')
process.env.CYRENE_NO_REVEAL = '1'
delete process.env.CYRENE_INJECT_MAX_CHARS

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

function makeCtx() {
  const sections = []
  const routes = []
  const tools = new Map()
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) {
      fn()
    },
    systemPrompt: {
      getSectionOrder: () => 0,
      section(spec) {
        const entry = { ...spec, disposed: false }
        entry.dispose = () => { entry.disposed = true }
        sections.push(entry)
        return entry.dispose
      },
    },
    webServer: {
      register(spec) {
        routes.push(spec)
        return () => {}
      },
    },
    on() {
      return () => {}
    },
    get(name) {
      if (name !== 'tools') return undefined
      return {
        register(definition) {
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
      }
    },
  }
  return { ctx, sections, routes, tools }
}

function makeReq(method, path, body) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url: path,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = headers
    },
    end(payload) {
      res.body += payload === undefined ? '' : String(payload)
    },
  }
  return res
}

const memPath = join(home, 'cyrene-memory.json')
const created = (daysAgo) => new Date(now - daysAgo * 86_400_000).toISOString()
await writeFile(memPath, JSON.stringify({
  enabled: true,
  rev: 2,
  items: [
    {
      id: 'mem-aging-001',
      text: '上周说想学做甜点',
      tags: ['计划'],
      importance: 2,
      weight: 0.15,
      layer: 'L2',
      status: 'aging',
      pinned: false,
      created: created(10),
      lastAccess: now,
      lastDecay: now,
      accessCount: 0,
      emotion: 0,
    },
    {
      id: 'mem-arch-002',
      text: '很久以前提过想去海边',
      tags: ['出行'],
      importance: 1,
      weight: 0.06,
      layer: 'L2',
      status: 'archived',
      pinned: false,
      created: created(20),
      lastAccess: now,
      lastDecay: now,
      accessCount: 0,
      emotion: 0,
    },
  ],
}, null, 2), 'utf8')

const box = makeCtx()
mod.apply(box.ctx)
const started = Date.now()
while (box.routes.length === 0 && Date.now() - started < 2000) {
  await new Promise((resolve) => setTimeout(resolve, 10))
}
await new Promise((resolve) => setTimeout(resolve, 300))

async function route(method, path, body) {
  const res = makeRes()
  await box.routes[0].handler(makeReq(method, path, body), res)
  return { status: res.statusCode, value: res.body === '' ? null : JSON.parse(res.body) }
}

ok('注册了 6 个记忆工具（含 pin / stats）',
  ['cyrene_memory_add', 'cyrene_memory_search', 'cyrene_memory_forget', 'cyrene_memory_profile',
    'cyrene_memory_pin', 'cyrene_memory_stats'].every((name) => box.tools.has(name)),
  [...box.tools.keys()])
ok('新工具仍然返回对象（output.schema object）',
  box.tools.get('cyrene_memory_pin').output.schema.type === 'object' &&
    box.tools.get('cyrene_memory_stats').output.schema.type === 'object')

// 钉住一条 archived：成色抬到保护线以上、状态回 active。
const pinTool = box.tools.get('cyrene_memory_pin')
const pinned = await pinTool.execute({ id: 'mem-arch-002', pinned: true })
ok('钉住 archived 条目：pinned=true、weight≥0.7、status=active',
  pinned.ok === true && pinned.pinned === true && pinned.weight >= PIN_WEIGHT && pinned.status === 'active',
  pinned)

let live = (await route('GET', '/cyrene/memory')).value.value
let target = live.items.find((item) => item.id === 'mem-arch-002')
ok('内存快照里也同步了钉住状态', target.pinned === true && target.weight >= PIN_WEIGHT && target.status === 'active', target)

let onDisk = JSON.parse(await readFile(memPath, 'utf8'))
target = onDisk.items.find((item) => item.id === 'mem-arch-002')
ok('钉住状态已落盘', target.pinned === true && target.weight >= PIN_WEIGHT, [target.pinned, target.weight])

// 重新加载：pinned 必须原样回来（decay 不碰它）。
let reloaded = (await route('GET', '/cyrene/memory?reload=1')).value.value
target = reloaded.items.find((item) => item.id === 'mem-arch-002')
ok('重新加载后仍然是钉住的', target.pinned === true && target.weight >= PIN_WEIGHT && target.status === 'active',
  [target.pinned, target.weight, target.status])

// 取消钉住：回到 0.69，且 reload 后不会被「weight>=0.7 自动钉住」复活。
const unpinned = await pinTool.execute({ id: 'mem-arch-002', pinned: false })
ok('取消钉住：pinned=false、weight=0.69、状态按成色重算',
  unpinned.ok === true && unpinned.pinned === false && unpinned.weight < PIN_WEIGHT &&
    Math.abs(unpinned.weight - 0.69) < 1e-9,
  unpinned)
reloaded = (await route('GET', '/cyrene/memory?reload=1')).value.value
target = reloaded.items.find((item) => item.id === 'mem-arch-002')
ok('重新加载后取消钉住仍然生效（不会又被自动钉住）',
  target.pinned === false && target.weight < PIN_WEIGHT,
  [target.pinned, target.weight])

// 工具对不存在的 id 安静返回 not-found。
const missing = await pinTool.execute({ id: 'mem-nope-999', pinned: true })
ok('钉住不存在的 id → ok=false / not-found', missing.ok === false && missing.error === 'not-found', missing)

// ── 3. 路由：POST /cyrene/memory { action: 'pin' } ─────────────────
const revNow = (await route('GET', '/cyrene/memory')).value.value.rev
const viaRoute = await route('POST', '/cyrene/memory', JSON.stringify({
  rev: revNow,
  action: 'pin',
  id: 'mem-aging-001',
  pinned: true,
}))
const routeTarget = viaRoute.value.value.items.find((item) => item.id === 'mem-aging-001')
ok('POST pin 路由：与工具行为一致（0.15 → ≥0.7、active）',
  viaRoute.status === 200 && routeTarget.pinned === true && routeTarget.weight >= PIN_WEIGHT &&
    routeTarget.status === 'active',
  [viaRoute.status, routeTarget.pinned, routeTarget.weight])
ok('pin 之后 rev 自增', viaRoute.value.value.rev === revNow + 1, [revNow, viaRoute.value.value.rev])

const revPin = viaRoute.value.value.rev
const badPin = await route('POST', '/cyrene/memory', JSON.stringify({ rev: revPin, action: 'pin', id: 'mem-nope-999' }))
ok('pin 不存在的 id → 404 not-found',
  badPin.status === 404 && badPin.value.error.code === 'not-found', badPin.status)

const stalePin = await route('POST', '/cyrene/memory', JSON.stringify({ rev: revNow, action: 'pin', id: 'mem-aging-001' }))
ok('pin 也受记忆自己的 rev 闸门管（过期 → 409）', stalePin.status === 409, stalePin.status)

// ── 4. cyrene_memory_stats：counts + ledger + 健康一行 ────────────
// 先写一条新记忆，让账本有机会自动建立（stats 的 ledger 就不再是 ABSENT）。
const addTool = box.tools.get('cyrene_memory_add')
await addTool.execute({ text: '下周三和设计组开评审会' })

const statsTool = box.tools.get('cyrene_memory_stats')
const stats = await statsTool.execute({})
ok('stats：健康一行原样给出（text 与 line 相同）',
  typeof stats.text === 'string' && stats.text === stats.line &&
    /^\[memory\] \d{4}-\d{2}-\d{2} total=\d+ pinned=\d+ active=\d+ aging=\d+ archived=\d+ inject_cap=2000 ledger=(OK|BROKEN|ABSENT) pending=0$/.test(stats.text),
  stats.text)
ok('stats：counts 与库对得上',
  stats.counts.total === stats.total && stats.counts.pinned === stats.pinned &&
    stats.counts.active === stats.active && stats.counts.aging === stats.aging &&
    stats.counts.archived === stats.archived &&
    stats.counts.active + stats.counts.aging + stats.counts.archived === stats.counts.total,
  stats.counts)
ok('stats：ledger 状态是结构化字段（state/entries/mismatched/missing/path）',
  ['OK', 'BROKEN', 'ABSENT'].includes(stats.ledger.state) &&
    Number.isInteger(stats.ledger.entries) &&
    Array.isArray(stats.ledger.mismatched) && Array.isArray(stats.ledger.missing) &&
    stats.ledger.path.endsWith('cyrene-memory-ledger.json'),
  stats.ledger)
ok('stats：写入之后账本已经建立并对得上',
  stats.ledger.state === 'OK' && stats.ledger.entries === 3 && stats.ledger.mismatched.length === 0,
  [stats.ledger.state, stats.ledger.entries])
ok('stats：pending 恒为 0（字段保留给巡检脚本）', stats.pending === 0)

// output.render 用的是 text（工具在对话里显示的就是健康那一行）。
const rendered = statsTool.output.render({}, stats)
ok('stats 的 output.render 把健康一行作为正文',
  Array.isArray(rendered) && rendered[0].type === 'text' && rendered[0].text === stats.line,
  rendered)

// ── 汇总 ─────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed}/${passed + failures.length}`)
if (failures.length > 0) {
  console.log(`失败项：${failures.join(' | ')}`)
  process.exitCode = 1
}
assert.equal(failures.length, 0)

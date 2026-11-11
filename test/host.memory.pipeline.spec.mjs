/**
 * 记忆管线集成测试：真的走 apply() → 工具 / 路由 / session 事件。
 *
 *   node test/host.memory.pipeline.spec.mjs
 *
 * 覆盖：v1 记忆文件迁移、加载时结算衰减、L0/L1 分层写入、注入正文、
 *      语义召回与 touch、相似条目合并、关系管线（session/event）、
 *      以及 /memory/profile 与 /relationship 两条新路由。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'cyrene-pipeline-'))
process.env.DSH_HOME = home
process.env.CYRENE_CUSTOM_STICKER_DIR = join(home, 'stickers-custom')
process.env.CYRENE_CUSTOM_BACKGROUND_DIR = join(home, 'backgrounds-custom')
process.env.CYRENE_NO_REVEAL = '1'

const MOD = new URL('../lib/index.js', import.meta.url).href
const mod = await import(MOD)

let passed = 0
const failures = []
async function ok(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail === undefined ? '' : ' → ' + JSON.stringify(detail)}`)
  }
}

function waitFor(check, timeout = 2000) {
  return new Promise((resolve) => {
    const started = Date.now()
    const loop = () => {
      let hit = false
      try {
        hit = check() === true
      } catch {
        hit = false
      }
      if (hit) return resolve(true)
      if (Date.now() - started > timeout) return resolve(false)
      setTimeout(loop, 10)
    }
    loop()
  })
}

/** 复刻运行版的 ctx：effect 立即执行并记下 dispose，section 记录规格。 */
function makeCtx(orders = {}) {
  const sections = []
  const routes = []
  const tools = new Map()
  const listeners = []
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    systemPrompt: {
      getSectionOrder: (name) => orders[name],
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
    on(event, handler) {
      listeners.push({ event, handler })
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
  return { ctx, sections, routes, tools, listeners, disposers }
}

const live = (sections, name) => sections.filter((s) => s.name === name && s.disposed !== true)
const lastOf = (sections, name) => live(sections, name).at(-1)

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

async function route(method, path, body) {
  const ctx = A
  const handler = ctx.routes[0].handler
  const res = makeRes()
  await handler(makeReq(method, path, body), res)
  return { status: res.statusCode, value: res.body === '' ? null : JSON.parse(res.body) }
}

// ── 0. 预置一份 v1（扁平、无成色）记忆文件，验证原地迁移 ────────────
const MEMORY_PATH = join(home, 'cyrene-memory.json')
await writeFile(MEMORY_PATH, JSON.stringify({
  enabled: true,
  rev: 7,
  items: [
    { id: 'mem-old-0001', text: '用户偏好深色主题，屏幕是 2560x1600', tags: ['偏好'], importance: 5, created: '2026-10-01T10:00:00.000Z' },
    { id: 'mem-old-0002', text: '周三去爬山了，山顶风很大', tags: ['出行'], importance: 2, created: '2026-11-01T10:00:00.000Z' },
  ],
}, null, 2), 'utf8')

// ── 1. 装载 ────────────────────────────────────────────────────────
const A = makeCtx({ DEPLOYMENT_PERSONA_PREFIX: 0 })
mod.apply(A.ctx)
await waitFor(() => A.routes.length > 0 && A.tools.has('cyrene_memory_add') && A.tools.has('cyrene_memory_profile') && A.tools.has('cyrene_memory_search') && A.tools.has('cyrene_memory_forget'))

await ok('装载后注册了记忆工具', A.tools.has('cyrene_memory_add') && A.tools.has('cyrene_memory_search') &&
  A.tools.has('cyrene_memory_profile') && A.tools.has('cyrene_memory_forget'), [...A.tools.keys()])
await ok('装载后挂上了 /cyrene 路由', A.routes.length === 1 && A.routes[0].path === '/cyrene')
await ok('装载后监听了 session/event', A.listeners.some((l) => l.event === 'session/event'))

// ── 2. 迁移：老条目补出 weight / status，并按时间衰减 ───────────────
const memGet = await route('GET', '/cyrene/memory')
const migrated = memGet.value.value
await ok('老文件能读出来，rev 跟着磁盘走', migrated.rev === 7, migrated.rev)
await ok('老条目补出了成色与状态', migrated.items.every((i) => typeof i.weight === 'number' &&
  ['active', 'aging', 'archived'].includes(i.status)), migrated.items.map((i) => [i.weight, i.status]))
const pinned = migrated.items.find((i) => i.id === 'mem-old-0001')
await ok('importance=5 的老条目被认定为钉住（0.7 以上不衰减）', pinned.pinned === true && pinned.weight >= 0.7,
  [pinned.pinned, pinned.weight])
const aged = migrated.items.find((i) => i.id === 'mem-old-0002')
await ok('importance=2 的老条目随时间掉过成色', aged.weight < 0.5, aged.weight)

// ── 3. L0/L1 分层写入 ─────────────────────────────────────────────
const addTool = A.tools.get('cyrene_memory_add')
const l0 = await addTool.execute({ text: '以后叫我小满' })
await ok('「叫我 X」被判成 L0 画像', l0.ok === true && l0.layer === 'L0', l0)
const l1 = await addTool.execute({ text: '最近在做一个 DSH 插件' })
await ok('「最近在做…」被判成 L1 近况', l1.ok === true && l1.layer === 'L1', l1)

const profile = await route('GET', '/cyrene/memory/profile')
await ok('画像里能读到称呼与在忙的事',
  profile.value.value.l0.preferredName.includes('小满') && profile.value.value.l1.currentProject.includes('DSH'),
  profile.value.value)

const memorySection = lastOf(A.sections, 'cyrene:memory')
await ok('记忆 section 注入了画像，并带护栏话术',
  memorySection !== undefined && /称呼：.*小满/.test(memorySection.text) &&
  /要记住新的事/.test(memorySection.text), memorySection?.text?.slice(0, 120))

// ── 4. 语义召回 + touch ───────────────────────────────────────────
const searchTool = A.tools.get('cyrene_memory_search')
// 先取一份「召回前」的快照：search 自己就会 touch，拿返回值比不出增量。
const before = (await route('GET', '/cyrene/memory')).value.value.items.find((i) => i.text.includes('爬山'))
const hit = await searchTool.execute({ query: '爬山' })
await ok('召回「爬山」命中了那条出行记忆',
  hit.items.some((i) => i.text.includes('爬山')), hit.items.map((i) => i.text))
const afterGet = await route('GET', '/cyrene/memory')
const hitAfter = afterGet.value.value.items.find((i) => i.id === before.id)
await ok('被召回一次后成色上涨、访问计数 +1',
  hitAfter.weight > before.weight && hitAfter.accessCount === before.accessCount + 1,
  [before.weight, hitAfter.weight, hitAfter.accessCount])

const miss = await searchTool.execute({ query: '量子纠缠' })
await ok('无关查询不乱返回', miss.items.length === 0, miss.items.map((i) => i.text))

// ── 5. 相似条目合并（不是无脑堆行数）──────────────────────────────
const beforeCount = (await route('GET', '/cyrene/memory')).value.value.count
const merged = await addTool.execute({ text: '用户偏好深色主题，屏幕是 2560x1600，晚上也不换' })
const afterMerge = await route('GET', '/cyrene/memory')
await ok('高度相似的条目被合并，而不是新增一条',
  merged.ok === true && afterMerge.value.value.count === beforeCount && merged.count === beforeCount,
  [beforeCount, afterMerge.value.value.count])
await ok('合并后正文取信息更全的那句',
  afterMerge.value.value.items.some((i) => i.text.includes('晚上也不换')),
  afterMerge.value.value.items.map((i) => i.text))

// ── 6. 关系管线：session/event 驱动 ───────────────────────────────
const fire = (event) => {
  for (const listener of A.listeners.filter((l) => l.event === 'session/event')) {
    listener.handler({ id: 's1' }, event)
  }
}
fire({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '今天好累啊，别急着加活' }] } })
fire({ type: 'assistant/message', data: { content: [{ type: 'text', text: '那就先歇会儿，我在。' }] } })
await waitFor(() => lastOf(A.sections, 'cyrene:relationship') !== undefined)

const rel = await route('GET', '/cyrene/relationship')
const relValue = rel.value.value
await ok('一轮之后关系里有轮次与情绪', relValue.turns === 1, relValue)
await ok('识别到「疲惫」并给出下一句关心', relValue.lastMood === '疲惫' && relValue.nextCareCue.length > 0,
  [relValue.lastMood, relValue.nextCareCue])
const relSection = lastOf(A.sections, 'cyrene:relationship')
await ok('关系 section 注入，且明确不改性格',
  relSection !== undefined && /刚认识/.test(relSection.text) && /不改变你是谁/.test(relSection.text),
  relSection?.text?.slice(0, 100))

// 同一轮里的多条 assistant 消息不该重复计数
fire({ type: 'assistant/message', data: { content: [{ type: 'text', text: '（补一句）' }] } })
const relAgain = await route('GET', '/cyrene/relationship')
await ok('同一轮的后续 assistant 消息不重复计轮次', relAgain.value.value.turns === 1, relAgain.value.value.turns)

// ── 7. 落盘形状：profile / relationship 都在同一个记忆文件里 ──────
const raw = JSON.parse(await readFile(MEMORY_PATH, 'utf8'))
await ok('落盘包含 profile 与 relationship 两段',
  raw.profile !== undefined && raw.profile.l0.preferredName.includes('小满') && raw.relationship !== undefined,
  Object.keys(raw))
await ok('落盘条目带 v2 字段（weight/status/layer）',
  raw.items.every((i) => typeof i.weight === 'number' && typeof i.layer === 'string' && typeof i.status === 'string'),
  raw.items.map((i) => Object.keys(i).join(',')))

// ── 8. 关闭开关后整体静默 ─────────────────────────────────────────
const toggle = await route('POST', '/cyrene/memory', JSON.stringify({ rev: raw.rev, action: 'toggle', enabled: false }))
await ok('关掉记忆开关 → 200', toggle.status === 200 && toggle.value.value.enabled === false, toggle.status)
await ok('关掉后记忆与关系 section 都卸掉',
  live(A.sections, 'cyrene:memory').every((s) => s.disposed === true) && lastOf(A.sections, 'cyrene:relationship') === undefined,
  A.sections.map((s) => [s.name, s.disposed]))

// ── 汇总 ──────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed}/${passed + failures.length}`)
if (failures.length > 0) {
  console.log(`失败项：${failures.join(' | ')}`)
  process.exitCode = 1
}
assert.equal(failures.length, 0)

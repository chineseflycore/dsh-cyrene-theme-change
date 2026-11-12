/**
 * 记忆整理（云端 LLM）自检。
 *
 *   node test/host.memory-llm.spec.mjs
 *
 * 覆盖三块：
 *   1. 解析：正常 JSON / ```json 围栏 / 前后废话 / 坏 JSON / 超时 / 抛错；
 *   2. 目标：provider/model 自动解析、显式配置优先、没有 provider 时不可用；
 *   3. 降级：LLM 永远返回坏 JSON 时，压缩与合并仍然按规则产出正确结果，
 *      以及 GET /cyrene/memory/llm 在没有 provider 时的真实返回。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemoryLlm, extractJson, normalizeSummaryText } from '../lib/host/memory-llm.js'

const TMP_ROOT = process.env.CYRENE_TEST_TMP
  || (existsSync('/mnt/Storage1_sda1/dsh/tmp') ? '/mnt/Storage1_sda1/dsh/tmp' : tmpdir())

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(check, timeout = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      if ((await check()) === true) return true
    } catch {
      // 条件还没成立，继续等
    }
    await sleep(10)
  }
  return false
}

/**
 * 最小 LLM 服务桩：只实现 createMemoryLlm 真正会碰的三个方法。
 * handler 返回字符串（当作模型正文）、'throw' / 'timeout' 或 null（空流）。
 */
function makeLlm(handler, config = {}) {
  const calls = []
  const llm = {
    providers: config.providers ?? [{ id: 'deepseek-official' }],
    models: config.models ?? { 'deepseek-official': [{ id: 'deepseek-flash' }] },
    listProviders() {
      if (config.providersError === true) throw new Error('providers 挂了')
      return llm.providers
    },
    async listModels(provider) {
      if (config.modelsError === true) throw new Error('models 挂了')
      return llm.models[provider] ?? []
    },
    stream(request) {
      calls.push(request)
      return (async function* () {
        const output = await handler(request, calls.length)
        if (output === 'throw') throw new Error('mock stream 抛错')
        if (output === 'timeout') {
          await new Promise(() => {})
          return
        }
        if (output === null || output === undefined) return
        const text = typeof output === 'string' ? output : JSON.stringify(output)
        if (config.split === true) {
          for (const part of text.match(/[\s\S]{1,9}/g) ?? []) {
            yield { type: 'text-delta', index: 0, text: part }
          }
        } else {
          yield { type: 'text-delta', index: 0, text }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return { llm, calls }
}

// ── 1. JSON 抠取与解析 ───────────────────────────────────────────
ok('JSON：纯文本对象', extractJson('{"a":1}')?.a === 1)
ok('JSON：```json 围栏', extractJson('```json\n{"a":2}\n```')?.a === 2)
ok('JSON：前后废话 + 围栏', extractJson('好的，结果如下：\n```json\n{"a":3}\n```\n以上。')?.a === 3)
ok('JSON：没有围栏但前后有解释', extractJson('结果是 {"a":4} ，请查收')?.a === 4)
ok('JSON：坏文本返回 null', extractJson('{"a":') === null)
ok('JSON：数组不算对象', extractJson('[1,2,3]') === null)
ok('JSON：空串返回 null', extractJson('   ') === null)

// ── 2. judge：正常 / 围栏 / 废话 / 坏 JSON / 超时 / 抛错 ─────────
{
  const body = { keep: true, layer: 'L1', field: 'currentProject', tags: ['项目', 'DSH'], reason: '近期在做' }
  const { llm, calls } = makeLlm(() => JSON.stringify(body), { split: true })
  const manager = createMemoryLlm(null, { llm, provider: 'p', model: 'm', timeoutMs: 1000 })
  const result = await manager.judge('用户最近在写一个 DSH 插件')
  ok('judge：正常 JSON → 正确解析', result.keep === true && result.layer === 'L1' &&
    result.field === 'currentProject' && result.tags.join('/') === '项目/DSH', result)
  ok('judge：分片 delta 被完整累积（调用参数按真实形状）',
    calls.length === 1 && calls[0].provider === 'p' && calls[0].model === 'm' &&
      calls[0].messages[0].content[0].type === 'text' && typeof calls[0].system === 'string',
    calls[0] === undefined ? 'no call' : { provider: calls[0].provider, model: calls[0].model })
}
{
  const { llm } = makeLlm(() => '好的，我判断如下：\n```json\n' + JSON.stringify({
    keep: true, layer: 'L0', tags: ['称呼'], reason: '明确说过',
  }) + '\n```\n以上。')
  const manager = createMemoryLlm(null, { llm, provider: 'p', model: 'm' })
  const result = await manager.judge('以后叫我小满')
  ok('judge：围栏 + 前后废话仍能解析', result?.layer === 'L0' && result.tags.join('/') === '称呼', result)
}
{
  const { llm } = makeLlm(() => '{"keep":true,')
  const manager = createMemoryLlm(null, { llm, provider: 'p', model: 'm', timeoutMs: 500 })
  const result = await manager.judge('一条正常长度的候选记忆')
  ok('judge：坏 JSON → null', result === null)
  ok('judge：坏 JSON 记下 lastError', typeof manager.lastError === 'string' && manager.lastError.length > 0, manager.lastError)
}
{
  const { llm } = makeLlm(() => 'throw')
  const manager = createMemoryLlm(null, { llm, provider: 'p', model: 'm', timeoutMs: 500 })
  const result = await manager.judge('一条正常长度的候选记忆')
  ok('judge：流抛错 → null（不抛穿）', result === null)
}
{
  const { llm } = makeLlm(() => 'timeout')
  const manager = createMemoryLlm(null, { llm, provider: 'p', model: 'm', timeoutMs: 40 })
  const started = Date.now()
  const result = await manager.judge('一条正常长度的候选记忆')
  ok('judge：超时 → null，且按 timeoutMs 及时返回', result === null && Date.now() - started < 1000,
    Date.now() - started)
}
{
  const { llm } = makeLlm(() => JSON.stringify({ keep: true, tags: ['x'] }))
  const manager = createMemoryLlm(null, { llm, provider: 'p', model: 'm' })
  const result = await manager.judge('缺 layer 的坏结果')
  ok('judge：缺 layer → null（调用方回退规则）', result === null)
}

// ── 3. summarize / resolve ───────────────────────────────────────
const sourceItems = [
  { id: 'a', text: '一月去爬山。山顶风很大。', tags: ['出行'], created: '2026-01-02T00:00:00.000Z' },
  { id: 'b', text: '二月去看海。海边下雨。', tags: ['出行', '海'], created: '2026-02-03T00:00:00.000Z' },
]
{
  const { llm } = makeLlm(() => JSON.stringify({ summary: '去爬山，山顶风很大；后来去看海。' }))
  const manager = createMemoryLlm(null, { llm, provider: 'p', model: 'm' })
  const result = await manager.summarize(sourceItems)
  ok('summarize：返回 { summary } 且补上时间范围 + 标签并集',
    result !== null && result.summary.startsWith('【2026-01-02 ~ 2026-02-03｜出行、海】') &&
      result.summary.includes('山顶风很大'), result?.summary)
  ok('summarize：正文不超过 600 字', Array.from(result.summary).length <= 600, Array.from(result.summary).length)
}
{
  const { llm } = makeLlm(() => JSON.stringify({ summary: '啊'.repeat(1000) }))
  const manager = createMemoryLlm(null, { llm, provider: 'p', model: 'm' })
  const result = await manager.summarize(sourceItems)
  ok('summarize：超长正文被收在 600 字以内并以省略号结尾',
    Array.from(result.summary).length <= 600 && result.summary.endsWith('…'), Array.from(result.summary).length)
}
{
  const { llm } = makeLlm(() => '{"summary":"没有头部的正文"}')
  const manager = createMemoryLlm(null, { llm, provider: 'p', model: 'm' })
  const result = await manager.summarize(sourceItems)
  ok('summarize：模型忘写头部时本地补上', result.summary.startsWith('【2026-01-02 ~ 2026-02-03｜出行、海】'), result.summary)
}
{
  const { llm } = makeLlm(() => JSON.stringify({ action: 'replace', text: '更新后的正文', reason: '新的覆盖旧的' }))
  const manager = createMemoryLlm(null, { llm, provider: 'p', model: 'm' })
  const result = await manager.resolve({ text: '旧正文', tags: ['旧'] }, { text: '新正文', tags: ['新'] })
  ok('resolve：replace 正确解析', result.action === 'replace' && result.text === '更新后的正文', result)
}
{
  const { llm } = makeLlm(() => JSON.stringify({ action: 'delete-everything', text: 'x' }))
  const manager = createMemoryLlm(null, { llm, provider: 'p', model: 'm' })
  const result = await manager.resolve({ text: '旧正文' }, { text: '新正文' })
  ok('resolve：非法 action → null', result === null)
}
{
  const { llm } = makeLlm(() => 'timeout')
  const manager = createMemoryLlm(null, { llm, provider: 'p', model: 'm', timeoutMs: 40 })
  const [s, r] = await Promise.all([
    manager.summarize(sourceItems),
    manager.resolve({ text: '旧正文' }, { text: '新正文' }),
  ])
  ok('summarize / resolve 超时 → null（不抛穿）', s === null && r === null)
}

// ── 4. provider / model 自动解析 ─────────────────────────────────
{
  const { llm } = makeLlm(() => JSON.stringify({ keep: true, layer: 'L2' }), {
    providers: [{ id: 'first-provider' }, { id: 'second-provider' }],
    models: { 'first-provider': [{ id: 'first-model' }], 'second-provider': [{ id: 'second-model' }] },
  })
  const manager = createMemoryLlm(null, { llm })
  const status = await manager.status()
  ok('自动解析：无配置时取第一个 provider 与它的第一个模型',
    status.available === true && status.provider === 'first-provider' && status.model === 'first-model', status)
}
{
  const { llm } = makeLlm(() => JSON.stringify({ keep: true, layer: 'L2' }), {
    providers: [{ id: 'first-provider' }],
    models: { 'first-provider': [{ id: 'first-model' }], second: [{ id: 'custom' }] },
  })
  const manager = createMemoryLlm(null, { llm, provider: 'second', model: 'custom' })
  const status = await manager.status()
  ok('显式配置优先：provider/model 不被自动解析覆盖',
    status.available === true && status.provider === 'second' && status.model === 'custom', status)
}
{
  const { llm } = makeLlm(() => '{}', { providers: [] })
  const manager = createMemoryLlm(null, { llm })
  const status = await manager.status()
  ok('没有 provider：available=false、provider/model 为空、lastError 说明原因',
    status.available === false && status.provider === '' && status.model === '' &&
      status.lastError === '没有可用的 LLM provider', status)
}
{
  const manager = createMemoryLlm(null, {})
  const status = await manager.status()
  ok('没有 llm 服务：available=false，且不抛错',
    status.available === false && typeof status.lastError === 'string', status)
}
ok('normalizeSummaryText：空正文也能得到带头部的可读串',
  normalizeSummaryText('', sourceItems).startsWith('【2026-01-02 ~ 2026-02-03｜出行、海】'))

// ── 5. 集成：LLM 一直返回坏 JSON，压缩与合并仍走规则 ─────────────
const home = await mkdtemp(join(TMP_ROOT, 'cyrene-llm-'))
process.env.DSH_HOME = home
delete process.env.MEM_LEDGER
process.env.CYRENE_CUSTOM_STICKER_DIR = join(home, 'stickers-custom')
process.env.CYRENE_CUSTOM_BACKGROUND_DIR = join(home, 'backgrounds-custom')
process.env.CYRENE_NO_REVEAL = '1'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)
const badBox = makeLlm(() => '{"keep":true,')
const badLlm = badBox.llm

function makeCtx(llm) {
  const sections = []
  const routes = []
  const tools = new Map()
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
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
      if (name === 'llm') return llm
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

const box = makeCtx(badLlm)
mod.apply(box.ctx)
const ready = await waitFor(() => box.routes.length > 0 && box.tools.has('cyrene_memory_add'))
ok('集成：插件启动并注册记忆路由 / 工具', ready === true)

async function route(method, path, body) {
  const res = makeRes()
  await box.routes[0].handler(makeReq(method, path, body), res)
  return { status: res.statusCode, value: res.body === '' ? null : JSON.parse(res.body) }
}

// 5a. 合并：两条高相似事件，LLM resolve 返回坏 JSON → 规则合并。
const addTool = box.tools.get('cyrene_memory_add')
await addTool.execute({ text: '用户偏好深色主题，屏幕是 2560×1600' })
await addTool.execute({ text: '用户偏好深色主题，屏幕是 2560×1600，键盘是 HHKB' })
const mergedOk = await waitFor(async () => {
  const snapshot = (await route('GET', '/cyrene/memory')).value.value
  return snapshot.count === 1 && snapshot.items[0].text.includes('HHKB')
})
const mergedSnapshot = (await route('GET', '/cyrene/memory')).value.value
ok('降级合并：LLM 坏 JSON → 仍按规则合并成一条，且保留信息更全的一句',
  mergedOk === true && mergedSnapshot.count === 1 && mergedSnapshot.items[0].text.includes('HHKB'),
  { count: mergedSnapshot.count, text: mergedSnapshot.items[0]?.text })
ok('降级合并：合并后成色被强化（> 初始 0.5）',
  Number(mergedSnapshot.items[0]?.weight) > 0.5, mergedSnapshot.items[0]?.weight)

// 5b. 压缩：125 条 active L2，再写一条触发；LLM summarize 坏 JSON → 规则摘要。
const cleared = await route('POST', '/cyrene/memory', JSON.stringify({
  rev: mergedSnapshot.rev,
  action: 'clear',
}))
ok('集成：清空记忆', cleared.value?.ok === true && cleared.value.value.count === 0, cleared.value?.value?.count)

const now = Date.now()
const bulk = Array.from({ length: 125 }, (_, index) => ({
  id: `mem-bulk-${String(index).padStart(4, '0')}`,
  text: `事件编号 ${String(index).padStart(3, '0')}：第 ${index} 次记录的第一句。marker${String(index).padStart(3, '0')} 是来源标记。`,
  tags: ['事件'],
  importance: 3,
  weight: 0.5,
  layer: 'L2',
  status: 'active',
  pinned: false,
  created: new Date(now - (200 - index) * 1000).toISOString(),
  lastAccess: now,
  lastDecay: now,
  accessCount: 0,
  emotion: 0,
}))
await writeFile(join(home, 'cyrene-memory.json'), JSON.stringify({ enabled: true, rev: 2, items: bulk }, null, 2), 'utf8')
const reloaded = await route('GET', '/cyrene/memory?reload=1')
ok('集成：重新加载 125 条 active 记忆', reloaded.value.value.count === 125, reloaded.value.value.count)

await addTool.execute({ text: '下周三和设计组开评审会' })
const compressedOk = await waitFor(async () => {
  const snapshot = (await route('GET', '/cyrene/memory')).value.value
  return snapshot.items.some((item) => item.isSummary === true)
})
const compressed = (await route('GET', '/cyrene/memory')).value.value
const summary = compressed.items.find((item) => item.isSummary === true)
ok('降级压缩：LLM 坏 JSON → 仍产出规则摘要（20 条来源、已归档）',
  compressedOk === true && summary !== undefined && summary.subEntryIds.length === 20,
  summary?.subEntryIds?.length)
ok('降级压缩：摘要正文是规则格式（时间范围 + 标签并集）',
  summary !== undefined && /^【\d{4}-\d{2}-\d{2}( ~ \d{4}-\d{2}-\d{2})?｜事件】/.test(summary.text) &&
    Array.from(summary.text).length <= 600,
  summary?.text?.slice(0, 120))
ok('降级压缩：来源全部转 archived',
  compressed.items.filter((item) => summary.subEntryIds.includes(item.id)).every((item) => item.status === 'archived'))

// 5c. 没有 provider 时，GET /cyrene/memory/llm 的真实返回。
badLlm.providers = []
await route('POST', '/cyrene/memory/llm', JSON.stringify({ timeoutMs: 5000 }))
const noProvider = await route('GET', '/cyrene/memory/llm')
ok('无 provider：GET /cyrene/memory/llm 返回 available=false + 空 provider + 默认模型 + 原因',
  noProvider.status === 200 && noProvider.value.ok === true &&
    noProvider.value.value.available === false &&
    noProvider.value.value.provider === '' &&
    // 没有 provider 时模型名会预置成默认的免费档（glm-4.7-flash），
    // 但 available 仍必须是 false —— 能不能调取决于 provider，不是模型名。
    noProvider.value.value.model === 'glm-4.7-flash' &&
    noProvider.value.value.lastError === '没有可用的 LLM provider',
  noProvider.value)

// ── 汇总 ────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed}/${passed + failures.length}`)
if (failures.length > 0) {
  console.log(`失败项：${failures.join(' | ')}`)
  process.exitCode = 1
}
assert.equal(failures.length, 0)

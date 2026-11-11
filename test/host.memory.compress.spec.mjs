/**
 * 记忆压缩 / 反思（实施单 §9.5）自检。
 *
 *   node test/host.memory.compress.spec.mjs
 *
 * 覆盖：
 *   1) 纯函数：首句 / 标签并集 / 候选排序（最老 + 成色最低）/ 摘要正文与条目；
 *   2) 集成：active L2 超过 120 条时，写入后自动把 20 条压成一条摘要，
 *      来源转 archived、成色取均值、参与召回、注入时不重复展示来源；
 *   3) 加载时来源条目保持 archived（不会被状态机复活）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  COMPRESS_ACTIVE_LIMIT,
  COMPRESS_BATCH,
  buildSummaryEntry,
  buildSummaryText,
  firstSentence,
  selectCompressionCandidates,
  unionTags,
} from '../lib/host/cognitive.js'

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

// ── 1. 纯函数 ────────────────────────────────────────────────────
ok('首句：按中文句末标点切', firstSentence('周三去爬山。山顶风很大。') === '周三去爬山', firstSentence('周三去爬山。山顶风很大。'))
ok('首句：没有标点时截前 60 字', firstSentence('啊'.repeat(100)).length === 60)
ok('首句：空文本回空串', firstSentence('   ') === '')

const tagList = unionTags([
  { tags: ['出行', '山'] },
  { tags: ['山', '天气'] },
  { tags: [] },
])
ok('标签并集：去重且保留首次出现顺序', tagList.join('/') === '出行/山/天气', tagList)

const fallback = [
  { id: 'a', text: '新一点但成色低', layer: 'L2', status: 'active', weight: 0.45, created: '2026-01-02T00:00:00.000Z' },
  { id: 'b', text: '老一点但成色高', layer: 'L2', status: 'active', weight: 0.55, created: '2026-01-01T00:00:00.000Z' },
  { id: 'c', text: '同样成色、更老', layer: 'L2', status: 'active', weight: 0.55, created: '2025-12-01T00:00:00.000Z' },
  { id: 'd', text: '已归档', layer: 'L2', status: 'archived', weight: 0.1, created: '2025-01-01T00:00:00.000Z' },
  { id: 'e', text: '已经是摘要', layer: 'L2', status: 'active', weight: 0.1, isSummary: true, created: '2025-01-01T00:00:00.000Z' },
  { id: 'f', text: '画像不进 L2 压缩', layer: 'L0', status: 'active', weight: 0.1, created: '2025-01-01T00:00:00.000Z' },
]
const picked = selectCompressionCandidates(fallback)
ok('候选：只挑 active 的非摘要 L2，按成色升序、同成色按创建时间升序',
  picked.map((entry) => entry.id).join(',') === 'a,c,b',
  picked.map((entry) => entry.id))
ok('候选：批量大小默认 20', selectCompressionCandidates(fallback, 2).length === 2)
ok('候选：不会选到 archived / 摘要 / 非 L2',
  picked.every((entry) => entry.status === 'active' && entry.isSummary !== true && entry.layer === 'L2'))

const summaryEntries = [
  { id: 'mem-1', text: '一月去爬山。补充一', tags: ['出行'], created: '2026-01-02T00:00:00.000Z', weight: 0.4 },
  { id: 'mem-2', text: '二月去看海。补充二', tags: ['出行', '海'], created: '2026-02-03T00:00:00.000Z', weight: 0.6 },
]
const summaryText = buildSummaryText(summaryEntries)
ok('摘要正文：时间范围 + 标签并集 + 每条首句',
  /^【2026-01-02 ~ 2026-02-03｜出行、海】一月去爬山；二月去看海$/.test(summaryText),
  summaryText)
ok('摘要正文：不超过 600 字', Array.from(summaryText).length <= 600, Array.from(summaryText).length)
const longText = buildSummaryText(Array.from({ length: 20 }, (_, index) => ({
  id: `mem-${index}`,
  text: `第${index}条很长的首句${'啊'.repeat(80)}。`,
  tags: ['长'],
  created: '2026-01-01T00:00:00.000Z',
})))
ok('摘要正文：超长时收在 600 字以内并以省略号结尾',
  Array.from(longText).length <= 600 && longText.endsWith('…'), Array.from(longText).length)

const summaryEntry = buildSummaryEntry(summaryEntries, { id: 'mem-summary-1', now: Date.UTC(2026, 5, 1) })
ok('摘要条目：layer=L2、isSummary、subEntryIds 记来源',
  summaryEntry.layer === 'L2' && summaryEntry.isSummary === true &&
    summaryEntry.subEntryIds.join(',') === 'mem-1,mem-2' && summaryEntry.id === 'mem-summary-1',
  summaryEntry)
ok('摘要条目：成色取被压缩条目的均值（0.4 与 0.6 → 0.5）',
  Math.abs(summaryEntry.weight - 0.5) < 1e-9 && summaryEntry.status === 'active',
  [summaryEntry.weight, summaryEntry.status])
ok('摘要条目：标签取并集，且不钉住', summaryEntry.tags.join('/') === '出行/海' && summaryEntry.pinned === false,
  summaryEntry.tags)
ok('阈值参数与实施单一致（120 条触发 / 一次 20 条）', COMPRESS_ACTIVE_LIMIT === 120 && COMPRESS_BATCH === 20,
  [COMPRESS_ACTIVE_LIMIT, COMPRESS_BATCH])

// ── 2. 集成：写入后触发压缩 ─────────────────────────────────────
const home = await mkdtemp(join(tmpdir(), 'cyrene-compress-'))
process.env.DSH_HOME = home
delete process.env.MEM_LEDGER
process.env.CYRENE_CUSTOM_STICKER_DIR = join(home, 'stickers-custom')
process.env.CYRENE_CUSTOM_BACKGROUND_DIR = join(home, 'backgrounds-custom')
process.env.CYRENE_NO_REVEAL = '1'

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

const live = (sections, name) => sections.filter((entry) => entry.name === name && entry.disposed !== true)
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

const memPath = join(home, 'cyrene-memory.json')
await writeFile(memPath, JSON.stringify({ enabled: true, rev: 1, items: bulk }, null, 2), 'utf8')

const box = makeCtx()
mod.apply(box.ctx)
const started = Date.now()
while (box.routes.length === 0 && Date.now() - started < 2000) {
  await new Promise((resolve) => setTimeout(resolve, 10))
}
await new Promise((resolve) => setTimeout(resolve, 60))

async function route(method, path, body) {
  const res = makeRes()
  await box.routes[0].handler(makeReq(method, path, body), res)
  return { status: res.statusCode, value: res.body === '' ? null : JSON.parse(res.body) }
}

const before = (await route('GET', '/cyrene/memory')).value.value
ok('压缩前：125 条 active，没有摘要条目',
  before.count === 125 && before.items.every((item) => item.status === 'active') &&
    before.items.every((item) => item.isSummary !== true),
  [before.count, before.items.filter((item) => item.isSummary === true).length])

// 写一条新记忆：active 变 126 > 120，触发压缩。
const addTool = box.tools.get('cyrene_memory_add')
const added = await addTool.execute({ text: '下周三和设计组开评审会' })
ok('写入一条新记忆（自动分层为 L2）', added.ok === true && added.layer === 'L2', added)

const after = (await route('GET', '/cyrene/memory')).value.value
const summaries = after.items.filter((item) => item.isSummary === true)
ok('active 超过 120 后自动压出一条摘要（且只压一条）', summaries.length === 1, summaries.length)
const summary = summaries[0]
ok('摘要：layer=L2、isSummary、subEntryIds 为 20 条来源',
  summary.layer === 'L2' && summary.isSummary === true && summary.subEntryIds.length === 20,
  [summary.layer, summary.subEntryIds?.length])
ok('摘要：成色取被压缩条目的均值（0.5）',
  Math.abs(summary.weight - 0.5) < 1e-6 && summary.status === 'active',
  [summary.weight, summary.status])
ok('摘要：正文不超过 600 字，含时间范围与标签并集',
  Array.from(summary.text).length <= 600 &&
    /^【\d{4}-\d{2}-\d{2}( ~ \d{4}-\d{2}-\d{2})?｜事件】/.test(summary.text),
  summary.text.slice(0, 120))

const sourceIds = new Set(summary.subEntryIds)
const archivedSources = after.items.filter((item) => sourceIds.has(item.id))
ok('来源条目全部转 archived',
  archivedSources.length === 20 && archivedSources.every((item) => item.status === 'archived'),
  archivedSources.map((item) => [item.id, item.status]))
ok('被压缩的是「最老 + 成色最低」的那批（编号 000–019）',
  summary.subEntryIds.join(',').startsWith('mem-bulk-0000,mem-bulk-0001') &&
    summary.subEntryIds.includes('mem-bulk-0019'),
  summary.subEntryIds)

const memorySection = lastOf(box.sections, 'cyrene:memory')
ok('摘要参与注入：section 里有摘要行与它收拢的首句',
  memorySection !== undefined && memorySection.text.includes('事件编号 000') &&
    memorySection.text.includes('事件编号 019'),
  memorySection?.text?.slice(0, 160))
ok('注入不重复展示来源条目：来源的独特标记不进 section',
  !memorySection.text.includes('marker000') && !memorySection.text.includes('marker019'),
  memorySection?.text?.includes('marker000'))

// 把一条来源「重新点亮」：search 会 touch 成色，它可能回到 active；
// 但注入仍必须排除它（摘要已经代表它了）。
const searchTool = box.tools.get('cyrene_memory_search')
const hit = await searchTool.execute({ query: 'marker000' })
const lit = hit.items.find((item) => item.id === 'mem-bulk-0000')
ok('召回把来源条目重新点亮成 active（成色+0.02）',
  lit !== undefined && lit.status === 'active' && /事件编号 000/.test(lit.text),
  lit === undefined ? hit.items.map((item) => item.id) : [lit.id, lit.status, lit.weight])
const sectionAfterTouch = lastOf(box.sections, 'cyrene:memory')
ok('即使来源被重新点亮，注入也不重复展示它（按 subEntryIds 排掉）',
  !sectionAfterTouch.text.includes('marker000'), sectionAfterTouch.text.includes('marker000'))

// 重新加载：来源条目按 subEntryIds 强制留在 archived，不会被状态机复活。
const reloaded = (await route('GET', '/cyrene/memory?reload=1')).value.value
const reloadedSummary = reloaded.items.find((item) => item.isSummary === true)
const reloadedSource = reloaded.items.find((item) => item.id === 'mem-bulk-0000')
ok('重新加载后摘要还在、来源仍是 archived',
  reloadedSummary !== undefined && reloadedSummary.subEntryIds.length === 20 &&
    reloadedSource.status === 'archived',
  [reloadedSummary?.subEntryIds?.length, reloadedSource?.status])

// 再写一条：active 已经回到 107（<=120），不应再压一条。
const addedAgain = await addTool.execute({ text: '顺手把评审会的时间改到下午三点' })
const afterAgain = (await route('GET', '/cyrene/memory')).value.value
ok('active 回落到阈值以下后不再触发压缩',
  addedAgain.ok === true && afterAgain.items.filter((item) => item.isSummary === true).length === 1,
  afterAgain.items.filter((item) => item.isSummary === true).length)

const health = await route('GET', '/cyrene/memory/health')
ok('健康行把摘要与归档来源分开计数',
  health.value.value.total === afterAgain.count &&
    health.value.value.archived === 20 &&
    health.value.value.active + health.value.value.aging + health.value.value.archived === health.value.value.total,
  health.value.value)

// ── 汇总 ─────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed}/${passed + failures.length}`)
if (failures.length > 0) {
  console.log(`失败项：${failures.join(' | ')}`)
  process.exitCode = 1
}
assert.equal(failures.length, 0)

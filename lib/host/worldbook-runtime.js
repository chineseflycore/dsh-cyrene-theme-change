// 世界书（设定库）的数据层：读盘、抓取、检索、注入正文、工具注册。
// 与长期记忆是两件事；这里不碰 prompt section（remountWorldbook 留在 index.js）。

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { buildEntries, matchEntries, packWorldbook, sanitizeEntries, summarizeEntries } from "./worldbook.js"
import { statePath } from "./state.js"

export const WORLDBOOK_FILE = 'cyrene-worldbook.json'
export const WORLDBOOK_SECTION_NAME = 'cyrene:worldbook'
export const WORLDBOOK_SECTION_BUDGET = 700
export const WORLDBOOK_TOOL_DEFAULT = 5
export const WORLDBOOK_TOOL_BUDGET = 6000
export const WORLDBOOK_ENTRY_SHOWN = 2200
export const WORLDBOOK_WIKI_URL = 'https://act-api-takumi.mihoyo.com/event/rpgchrysosheirs/index'

/** 和记忆、主题设定放同一个目录，各占一个文件。 */
export function worldbookPath() {
  return join(dirname(statePath()), WORLDBOOK_FILE)
}

const EMPTY_WORLDBOOK = { entries: [], source: '', version: '', fetchedAt: '', error: null }
let worldbookStore = { ...EMPTY_WORLDBOOK }
let worldbookLoaded = false
let worldbookLoading = null

/**
 * 读一次盘。这里要「并发调用共享同一个 promise」：先把 loaded 标记置位再 await，
 * 第二个调用者会立刻拿到一个空库——世界书工具在开机那一瞬间被调用时真踩到过。
 */
export function ensureWorldbook(ctx, force = false) {
  if (force !== true && worldbookLoading !== null) return worldbookLoading
  if (worldbookLoaded === true && force !== true) return Promise.resolve(worldbookStore)
  worldbookLoaded = true
  worldbookLoading = (async () => {
    try {
      const text = await readFile(worldbookPath(), 'utf8')
      const parsed = JSON.parse(text)
      worldbookStore = {
        entries: sanitizeEntries(parsed?.entries),
        source: typeof parsed?.source === 'string' ? parsed.source : '',
        version: typeof parsed?.sourceVersion === 'string' ? parsed.sourceVersion : '',
        fetchedAt: typeof parsed?.fetchedAt === 'string' ? parsed.fetchedAt : '',
        error: null,
      }
    } catch (error) {
      worldbookStore = { ...EMPTY_WORLDBOOK }
      if (error?.code !== 'ENOENT') {
        worldbookStore.error = `世界书读不出来：${error?.message || error}`
        ctx?.logger?.warn?.(`${PACKAGE_ID}: 世界书读不出来（不影响主题与人格）`, error)
      }
    }
    return worldbookStore
  })()
  worldbookLoading = worldbookLoading.finally(() => {
    worldbookLoading = null
  })
  return worldbookLoading
}

/** 面板要的那份快照：带一份「不背正文」的条目索引。 */
export function publicWorldbook() {
  const stats = summarizeEntries(worldbookStore.entries)
  return {
    error: worldbookStore.error,
    count: stats.count,
    characters: stats.characters,
    categories: stats.categories,
    source: worldbookStore.source,
    version: worldbookStore.version,
    fetchedAt: worldbookStore.fetchedAt,
    path: worldbookPath(),
    entries: worldbookStore.entries.map((item) => ({
      id: item.id,
      name: item.name,
      character: item.character,
      category: item.category,
      keys: [...item.keys],
      size: item.content.length,
    })),
  }
}

/** 常驻那一行：只说「库里有什么、什么时候该去查」，正文不进来。 */
export function worldbookText() {
  if (worldbookStore.entries.length === 0) return ''
  const stats = summarizeEntries(worldbookStore.entries)
  const names = stats.characters.map((row) => `${row.name}（${row.total}）`).join('、')
  const version = worldbookStore.version === '' ? '' : `（版本 ${worldbookStore.version}）`
  const lines = [
    '',
    '【昔涟 · 世界书】',
    `这里有一份整理自官方 wiki 的翁法罗斯设定库${version}，共 ${stats.count} 条，覆盖：${names}。`,
    '聊到这些角色、他们的故事、彼此的关系，或者翁法罗斯的地理与设定时，先调用 cyrene_worldbook_search 查一遍再回答；查到什么说什么，查不到就直说记不准——不要凭印象编设定。',
  ]
  const text = lines.join('\n')
  return text.length > WORLDBOOK_SECTION_BUDGET ? text.slice(0, WORLDBOOK_SECTION_BUDGET) : text
}

export function searchWorldbook(query, limit) {
  const hits = matchEntries(worldbookStore.entries, query, limit)
  const blocks = []
  const list = []
  let used = 0
  let dropped = 0
  for (const hit of hits) {
    const head = `## ${hit.name}（命中：${hit.matched.join('、')}）`
    let body = hit.content
    if (body.length > WORLDBOOK_ENTRY_SHOWN) body = `${body.slice(0, WORLDBOOK_ENTRY_SHOWN)}…（已截断）`
    const block = `${head}\n${body}`
    if (used + block.length > WORLDBOOK_TOOL_BUDGET) {
      dropped += 1
      continue
    }
    blocks.push(block)
    used += block.length + 2
    list.push({
      id: hit.id,
      name: hit.name,
      character: hit.character,
      category: hit.category,
      matched: hit.matched,
    })
  }
  const parts = blocks.join('\n\n---\n\n')
  const tail = dropped === 0 ? '' : `\n\n（还有 ${dropped} 条没放进预算：换个更具体的关键词再查，或者调小 limit 只看最相关的。）`
  return { hits: list, text: `${parts}${tail}`.trim(), count: hits.length, dropped };
}

/** 把世界书交给模型：一个检索工具。取不到 tools 服务就整块跳过。 */
export function registerWorldbookTools(ctx) {
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return null
  const disposers = []
  const textOutput = {
    // 宿主校验的是 value 的整体形状：工具必须返回对象（不能返回裸字符串），
    // 否则调用会报 "value" must be an object。这里宽松到「对象里带 text 就用 text」。
    schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string'
        ? value
        : (value !== null && typeof value === 'object' && typeof value.text === 'string')
          ? value.text
          : JSON.stringify(value, null, 2),
    }],
  }
  try {
    const dispose = tools.register({
      name: 'cyrene_worldbook_search',
      description: '查昔涟的世界书（翁法罗斯的角色档案、角色故事、角色关系、角色解析）。问到某个角色的生平、设定、彼此关系，或者拿不准的剧情细节时先查这里，别凭印象编。关键词写角色名或专有名词效果最好；一次只给最相关的几条。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要查的关键词，通常是角色名（如「白厄」「昔涟」）或专有名词；可以带上想问的方面（如「白厄 童年」）。' },
          limit: { type: 'integer', description: `最多给几条，默认 ${WORLDBOOK_TOOL_DEFAULT}，上限 20。` },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: textOutput,
      execute: async (args) => {
        await ensureWorldbook(ctx)
        const query = String(args?.query || '')
        const result = searchWorldbook(args?.query, args?.limit)
        // 必须返回对象：宿主的 output.schema 是 object，返回裸字符串会报
        // `"value" must be an object`（真踩过，工具当场用不了）。
        if (result.count === 0) {
          return {
            text: `世界书里没有命中「${query}」的条目。可以换个角色名或专有名词再试；确实没有就直说记不准，不要编。`,
            count: 0,
            dropped: 0,
            hits: [],
          }
        }
        return {
          text: `命中 ${result.count} 条（关键词：${query}）\n\n${result.text}`,
          count: result.count,
          dropped: result.dropped,
          hits: result.hits,
        }
      },
    })
    if (typeof dispose === 'function') disposers.push(dispose)
  } catch (error) {
    ctx.logger?.warn?.(`${PACKAGE_ID}: 注册 cyrene_worldbook_search 失败`, error)
  }
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // 已经跟着 fiber 消失
      }
    }
  }
}

/** 去官方 wiki 抓一份、切条、落盘。失败把原因抛给调用方（面板上要显示）。 */
export async function fetchWorldbook() {
  if (typeof fetch !== 'function') throw new Error('这个 Node 运行时没有内置 fetch')
  const url = `${WORLDBOOK_WIKI_URL}?lang=zh-cn`
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
  const raw = await response.json()
  if (raw?.retcode !== 0 || raw?.data === null || raw?.data === undefined) {
    throw new Error(`接口没给数据：${raw?.message || `retcode ${raw?.retcode}`}`)
  }
  const entries = buildEntries(raw.data)
  if (entries.length === 0) throw new Error('一条条目都没切出来，可能接口结构变了')
  const document = packWorldbook(entries, {
    source: url,
    sourceVersion: String(raw.data.current_version || ''),
  })
  // 先写临时文件再原子改名：抓取中断时不会留下半份坏 json。
  const target = worldbookPath()
  const staging = `${target}.tmp`
  await writeFile(staging, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  await rename(staging, target)
  worldbookStore = {
    entries: sanitizeEntries(document.entries),
    source: document.source,
    version: document.sourceVersion,
    fetchedAt: document.fetchedAt,
    error: null,
  }
  worldbookLoaded = true
  return worldbookStore
}
/** 清空内存库（面板「清空」用；文件由路由自己删）。 */
export function clearWorldbookStore() {
  worldbookStore = { ...EMPTY_WORLDBOOK }
  worldbookLoaded = true
}

/** 新模块实例（重启 / HMR）归位。 */
export function resetWorldbookRuntime() {
  worldbookStore = { ...EMPTY_WORLDBOOK }
  worldbookLoaded = false
  worldbookLoading = null
}

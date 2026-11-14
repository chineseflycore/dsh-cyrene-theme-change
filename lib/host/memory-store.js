// 长期记忆的数据层：记忆库形状、清洗、持久化、注入正文、账本联动、每日健康。
// 纯数据 + 纯函数，不注册任何插件资源；index.js 负责把它接进 apply。

import { spawn } from "node:child_process"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import {
  L0_FIELDS,
  L1_FIELDS,
  TEXT_MAX,
  cleanInline,
  buildInjection,
  decayWeight,
  importanceToWeight,
  resolveInjectMaxChars,
  selectForInjection,
  statusOf,
  weightToImportance,
} from "./cognitive.js"
import { LEDGER_FILE, ledgerCount, readLedgerFile, syncLedgerFile, verifyLedger } from "./ledger.js"
import { embed, packVector } from "./vector.js"
import { buildRelationshipText, emptyRelationship, localDate, relationshipSummary } from "./relationship.js"
import { pickEmotionPresentation } from "../live2d-map.js"
import { PACKAGE_ID, statePath } from "./state.js"

/* ────────────────────── 长期记忆（认知分层版） ──────────────────────
 * 设计取舍：
 * - **单独一个文件**，不塞进主题设定：记忆越攒越长，设定文件必须小、必须能一键重置；
 *   两者生命周期也不同（换皮肤/重置主题不该连带丢记忆）。
 * - **三层结构**（L0 画像 / L1 近况 / L2 事件）+ **成色与衰减**：
 *   升级自「扁平列表 + 子串搜索」。扇出量的依据见 lib/host/cognitive.js 文件头。
 * - 注入走**独立 section**（`cyrene:memory`），排在人格之后：人格是「怎么说话」，记忆是「知道什么」。
 *   正文由 `buildInjection` 生成，有 2000 字硬预算，且三层里 L0 最晚被裁。
 * - 模型能写（tools）也能读（section 里的画像+近况+召回 + 检索工具）；
 *   上限与预算见常量 —— 记忆无节制膨胀，最先坏的是上下文。
 * - 旧格式（v1 扁平 items）在读取时原地迁移，不要求用户做任何事。
 *
 * 实施单对照（全文见 docs/memory-system-spec.md，逐条见 README「规格与来源」）：
 * - §5.1 人格保护：`memoryText` / `remountMemory` 只动 `cyrene:memory`，
 *   绝不碰 `cyrene:persona`；护栏话术与 2000 字预算在 `buildInjection`；
 * - §5.2 文本账本：`ledgerReport` / `syncMemoryLedger` + `lib/host/ledger.js`；
 * - §5.3 每日健康一行：`memoryHealthLine` / `memoryHealthValue`；
 * - §9.3 遗忘曲线与钉住：`pinMemory` + `lib/host/cognitive.js` 的 `decayWeight`；
 * - §9.5 压缩 / 反思：`maybeCompressMemories`（纯规则，不调 LLM）。
 */
export const MEMORY_FILE = 'cyrene-memory.json'
export const MEMORY_TEXT_MAX = TEXT_MAX
export const MEMORY_TAG_MAX = 8
export const MEMORY_LIMIT = 300
export const MEMORY_SECTION_BUDGET = resolveInjectMaxChars(process.env)
export const MEMORY_TOOL_DEFAULT = 8
export const MEMORY_SECTION_NAME = 'cyrene:memory'
/** 注入时最多挑几条 L2（再多就是噪音，且会挤掉预算）。 */
export const MEMORY_INJECT_ITEMS = 8
/** 画像/近况槽位的历史留痕：旧值转成 L2，成色压低，避免抢注入预算。 */
export const PROFILE_HISTORY_WEIGHT = 0.4
/** 每个字段最多保留最近几条历史（更老的归档）。 */
export const PROFILE_HISTORY_KEEP = 3
/** L0 写入长度上限：画像是一句话，不是一段自述。 */
export const PROFILE_L0_MAX = 40
/** L1 写入长度上限，以及「像不像一句近况」的判定线。 */
export const PROFILE_L1_MAX = 30
export const PROFILE_L1_BREAKS = 2
export const PROFILE_L1_SELF_MAX = 20

/** 和主题设定放同一个目录（`%USERPROFILE%\.dsh`），但用另一个文件。 */
export function memoryPath() {
  return join(dirname(statePath()), MEMORY_FILE)
}

/**
 * 记忆账本路径（实施单 §5.2）：和记忆文件同目录的 `cyrene-memory-ledger.json`。
 * `MEM_LEDGER` 可以覆盖它——`tools/memory-ledger.mjs` 读的是同一个变量，
 * 所以插件与命令行看到的一定是**同一份账本**，不会各建各的。
 */
export function memoryLedgerPath() {
  const override = typeof process.env.MEM_LEDGER === 'string' ? process.env.MEM_LEDGER.trim() : ''
  return override !== '' ? resolve(override) : join(dirname(statePath()), LEDGER_FILE)
}

/**
 * 在系统文件管理器里定位一个文件（Windows 用资源管理器选中它，
 * macOS 用 Finder，Linux 打开所在目录）。
 *
 * 浏览器页面自己做不到这件事——只能由宿主进程 spawn 一个窗口管理器。
 * 路径是插件自己算出来的（不是用户输入），所以不存在"用户递一个路径过来让我开"的面。
 * 返回 false 表示没打开（比如不是桌面环境），调用方据此提示用户改用复制路径。
 */
export function revealFile(target) {
  // 自检时不要真的弹窗。
  if (process.env.CYRENE_NO_REVEAL === '1') return true
  try {
    if (process.platform === 'win32') {
      // `execFile` 语义：数组形式已经把带空格的路径整体当一个参数，
      // explorer 认的是 `/select,` 后面紧跟文件路径。
      spawn('explorer.exe', ['/select,', target], { detached: true, stdio: 'ignore' }).unref()
      return true
    }
    if (process.platform === 'darwin') {
      spawn('open', ['-R', target], { detached: true, stdio: 'ignore' }).unref()
      return true
    }
    spawn('xdg-open', [dirname(target)], { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch (error) {
    return false
  }
}

export let memoryStore = {
  items: [],
  rev: 0,
  enabled: true,
  error: null,
  /** L0 画像 / L1 近况（Cyrene-Agent 的分层）。 */
  profile: { l0: {}, l1: {} },
  /** 关系与情绪（移植自 relationship-log + 情绪环）。 */
  relationship: emptyRelationship(),
  /** 上一次结算（遗忘）的时间，避免每次启动都重算一遍。 */
  settledAt: 0,
}
let memoryPromise = null
let memorySaveChain = Promise.resolve()
export function newMemoryId() {
  return `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function cleanMemoryText(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, MEMORY_TEXT_MAX)
}

export function cleanMemoryTags(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,，、\s]+/)
      : []
  const out = []
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    const tag = entry.trim().slice(0, 24)
    if (tag === '' || out.includes(tag)) continue
    out.push(tag)
    if (out.length >= MEMORY_TAG_MAX) break
  }
  return out
}

/**
 * 一条记忆的合法形状。v1 只有 id/text/created/tags/importance；
 * v2 起多出成色（weight）、状态（status）、访问统计与分层标记。
 * 旧数据在这里原地补齐，所以「升级插件」对用户是零动作。
 */
export function sanitizeMemoryItem(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const text = cleanMemoryText(raw.text)
  if (text === '') return null
  const created = typeof raw.created === 'string' && !Number.isNaN(Date.parse(raw.created))
    ? new Date(raw.created).toISOString()
    : new Date().toISOString()
  const id = typeof raw.id === 'string' && /^mem-[a-z0-9-]{4,40}$/i.test(raw.id) ? raw.id : newMemoryId()
  const importance = Number.isFinite(Number(raw.importance))
    ? Math.min(5, Math.max(1, Math.round(Number(raw.importance))))
    : 3

  // 成色：老条目没存过 weight，就用 importance 折一次；新条目自带。
  const storedWeight = Number(raw.weight)
  const weight = Number.isFinite(storedWeight)
    ? Math.min(1, Math.max(0.05, storedWeight))
    : importanceToWeight(importance)
  const pinned = raw.pinned === true || weight >= 0.7 // 0.7 是「永不衰减」线，见 cognitive.PIN_WEIGHT
  const createdMs = Date.parse(created)
  const lastAccess = Number.isFinite(Number(raw.lastAccess)) ? Number(raw.lastAccess) : createdMs
  const lastDecay = Number.isFinite(Number(raw.lastDecay)) ? Number(raw.lastDecay) : createdMs
  const accessCount = Number.isFinite(Number(raw.accessCount)) ? Math.max(0, Math.floor(Number(raw.accessCount))) : 0
  const layer = raw.layer === 'L0' || raw.layer === 'L1' ? raw.layer : 'L2'
  const emotion = Number.isFinite(Number(raw.emotion)) ? Math.min(1, Math.max(0, Number(raw.emotion))) : 0

  return {
    id,
    text,
    tags: cleanMemoryTags(raw.tags),
    importance,
    created,
    // v2 字段
    weight,
    layer,
    status: raw.status === 'archived' || raw.status === 'aging' || raw.status === 'active'
      ? raw.status
      : statusOf(weight),
    pinned,
    accessCount,
    lastAccess,
    lastDecay,
    emotion,
    vec: typeof raw.vec === 'string' && raw.vec !== '' ? raw.vec : null,
    ...(typeof raw.source === 'string' && raw.source !== '' ? { source: raw.source.slice(0, 40) } : {}),
    ...(Array.isArray(raw.conflictWith) && raw.conflictWith.length > 0
      ? { conflictWith: raw.conflictWith.filter((x) => typeof x === 'string').slice(0, 8) }
      : {}),
    // 压缩摘要（实施单 §9.5）：只增字段，老条目读回来没有这两个键。
    ...(raw.isSummary === true ? { isSummary: true } : {}),
    ...(Array.isArray(raw.subEntryIds) && raw.subEntryIds.length > 0
      ? { subEntryIds: raw.subEntryIds.filter((x) => typeof x === 'string').slice(0, 50) }
      : {}),
    // 画像槽位的历史留痕：记住这条旧值属于哪个字段，用于「每个字段只留最近 3 条」。
    ...(typeof raw.historyField === 'string' && raw.historyField !== ''
      ? { historyField: raw.historyField.slice(0, 40) }
      : {}),
  }
}

/** 读盘（一次）；`force` 强制重读。读坏了就当空，不阻塞插件启动。 */
export async function ensureMemories(ctx, force) {
  if (memoryPromise !== null && force !== true) return memoryPromise
  memoryPromise = (async () => {
    try {
      const raw = await readFile(memoryPath(), 'utf8')
      const parsed = JSON.parse(raw)
      const items = []
      for (const entry of Array.isArray(parsed?.items) ? parsed.items : []) {
        const item = sanitizeMemoryItem(entry)
        if (item !== null) items.push(item)
      }
      // 结算遗忘：把「距上次结算过了几天」折算成成色跌幅。
      // 这里只算一次（不是每轮都算），所以开关插件不会把记忆越磨越薄。
      const now = Date.now()
      for (const item of items) {
        const nextWeight = decayWeight(item, now)
        item.weight = nextWeight
        item.status = statusOf(nextWeight)
        item.importance = weightToImportance(nextWeight)
        item.lastDecay = now
        if (item.vec === null) item.vec = packVector(embed(item.text))
      }
      // 摘要的来源条目一律留在 archived（实施单 §9.5）：它们的成色可能仍高于
      // 归档线，但既然已经并进摘要，就不该再单独注入、也不该被状态机复活。
      const summarized = new Set()
      for (const item of items) {
        if (item.isSummary === true) for (const id of item.subEntryIds ?? []) summarized.add(id)
      }
      for (const item of items) {
        if (summarized.has(item.id) && item.isSummary !== true) item.status = 'archived'
      }
      memoryStore = {
        items: items.slice(0, MEMORY_LIMIT),
        rev: Number.isInteger(parsed?.rev) && parsed.rev >= 0 ? parsed.rev : 0,
        enabled: parsed?.enabled !== false,
        error: null,
        profile: {
          l0: sanitizeProfileFields(parsed?.profile?.l0, L0_FIELDS),
          l1: sanitizeProfileFields(parsed?.profile?.l1, L1_FIELDS),
        },
        relationship: sanitizeRelationship(parsed?.relationship),
        settledAt: now,
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        memoryStore = { ...memoryStore, error: error?.message ?? String(error) }
        ctx?.logger?.warn?.(`${PACKAGE_ID}: 读取记忆失败，先当空的`, error)
      }
    }
    return memoryStore
  })()
  return memoryPromise
}

/** 画像字段只留白名单里的字符串，其余丢掉（防手改文件把结构写坏）。 */
export function sanitizeProfileFields(raw, fields) {
  const out = {}
  if (raw === null || typeof raw !== 'object') return out
  for (const field of fields) {
    const value = cleanInline(raw[field])
    if (value !== '') out[field] = value.slice(0, MEMORY_TEXT_MAX)
  }
  if (Number.isFinite(Number(raw?.updatedAt))) out.updatedAt = Number(raw.updatedAt)
  if (Number.isFinite(Number(raw?.generatedAt))) out.generatedAt = Number(raw.generatedAt)
  if (Number.isFinite(Number(raw?.roundCount))) out.roundCount = Number(raw.roundCount)
  return out
}

/** 关系状态读回来时夹一遍值域：文件被手改过也不至于把数字推到天上。 */
export function sanitizeRelationship(raw) {
  const base = emptyRelationship()
  if (raw === null || typeof raw !== 'object') return base
  const clamp = (value, fallback) => (Number.isFinite(Number(value)) ? Math.min(100, Math.max(0, Number(value))) : fallback)
  return {
    ...base,
    ...raw,
    affinity: clamp(raw.affinity, base.affinity),
    trust: clamp(raw.trust, base.trust),
    familiarity: clamp(raw.familiarity, base.familiarity),
    turns: Number.isFinite(Number(raw.turns)) ? Math.max(0, Math.floor(Number(raw.turns))) : 0,
    emotions: { ...base.emotions, ...(typeof raw.emotions === 'object' && raw.emotions !== null ? raw.emotions : {}) },
  }
}

/** 串行落盘（和主题设定同一套 tmp + rename 写法）。 */
export function persistMemories(ctx) {
  const payload = JSON.stringify({
    enabled: memoryStore.enabled,
    rev: memoryStore.rev,
    settledAt: memoryStore.settledAt,
    profile: memoryStore.profile,
    relationship: memoryStore.relationship,
    items: memoryStore.items.map((item) => ({ ...item })),
  }, null, 2)
  memorySaveChain = memorySaveChain.then(async () => {
    const target = memoryPath()
    const temp = `${target}.${process.pid}.tmp`
    await mkdir(dirname(target), { recursive: true })
    await writeFile(temp, payload, 'utf8')
    await rename(temp, target)
  }).catch((error) => {
    ctx?.logger?.warn?.(`${PACKAGE_ID}: 保存记忆失败`, error)
  })
  return memorySaveChain
}

export function publicMemories() {
  return {
    error: memoryStore.error,
    enabled: memoryStore.enabled,
    rev: memoryStore.rev,
    count: memoryStore.items.length,
    limit: MEMORY_LIMIT,
    path: memoryPath(),
    profile: {
      l0: { ...memoryStore.profile.l0 },
      l1: { ...memoryStore.profile.l1 },
    },
    relationship: {
      affinity: memoryStore.relationship.affinity,
      trust: memoryStore.relationship.trust,
      familiarity: memoryStore.relationship.familiarity,
      turns: memoryStore.relationship.turns,
      streakDays: memoryStore.relationship.streakDays,
      lastMood: memoryStore.relationship.lastMood,
      // 主导情绪 + 给桌宠的表情/动作建议。`presentation` 是纯函数算出来的，
      // 老客户端不认识这个字段，忽略即可（不改变已有的 dominant 形状）。
      dominant: {
        ...memoryStore.relationship.dominant,
        presentation: pickEmotionPresentation(memoryStore.relationship.dominant?.dimension),
      },
      nextCareCue: memoryStore.relationship.nextCareCue,
      summary: relationshipSummary(memoryStore.relationship),
    },
    items: memoryStore.items.map((item) => ({ ...item, tags: [...item.tags] })),
  }
}

/* ────────────────────── 记忆账本与每日健康（实施单 §5.2 / §5.3） ──────────────────────
 * 账本只回答「有没有丢过」：每条记忆按 id 记一个 sha256 + 字符数，写入时 sync、
 * 备份前 verify。它不改记忆、不进提示词，所以坏了也只会让「有没有丢过」失去答案，
 * 不会让她忘记任何事（记忆本身在 cyrene-memory.json 里）。
 */

/** 自动入账的串行链：两次写入不能同时读到同一份旧账本，否则新 id 会被后一次盖掉。 */
let ledgerChain = Promise.resolve()

/**
 * 记忆写入之后自动补账（实施单 §5.2）：只补新 id，老记录绝不覆盖。
 * 合并、手改正文不会被它抹平——那是 verify 该报的 mismatched。
 * 账本写不进去只记一条 warn：记忆已经落盘了，账本不能反过来拖垮写入。
 */
export function syncMemoryLedger(ctx) {
  const entries = memoryStore.items.map((item) => ({ id: item.id, text: item.text }))
  ledgerChain = ledgerChain.then(async () => {
    try {
      return await syncLedgerFile(memoryLedgerPath(), entries)
    } catch (error) {
      ctx?.logger?.warn?.(`${PACKAGE_ID}: 同步记忆账本失败（记忆本身没受影响）`, error)
      return null
    }
  })
  return ledgerChain
}

/** 一次对账：账本文件 + 当前内存库 → 路由 / 工具 / 健康行共用的报告。 */
export async function ledgerReport() {
  const read = await readLedgerFile(memoryLedgerPath())
  const report = verifyLedger(read.ledger, memoryStore.items)
  return {
    // 没有账本就不算「对得上」；账本文件读坏了更不算——说不清「有没有丢过」时不能报 OK。
    ok: read.exists === true && read.error === null && report.ok,
    exists: read.exists,
    error: read.error,
    entries: ledgerCount(read.ledger),
    checked: report.checked,
    mismatched: report.mismatched,
    missing: report.missing,
    unledgered: report.unledgered,
    ledgerPath: memoryLedgerPath(),
  }
}

/** 健康行里的三态：ABSENT（还没建）/ BROKEN（对不上或读坏了）/ OK。 */
export function ledgerStateOf(report) {
  if (report.error !== null && report.error !== undefined) return 'BROKEN'
  if (report.exists !== true) return 'ABSENT'
  return report.ok === true ? 'OK' : 'BROKEN'
}

/** 分档计数：pinned 是独立维度（钉住的也可能落在任一分档里）。 */
export function memoryCounts() {
  const counts = { total: memoryStore.items.length, pinned: 0, active: 0, aging: 0, archived: 0 }
  for (const item of memoryStore.items) {
    if (item.pinned === true) counts.pinned += 1
    if (item.status === 'active') counts.active += 1
    else if (item.status === 'aging') counts.aging += 1
    else if (item.status === 'archived') counts.archived += 1
  }
  return counts
}

/**
 * 每日健康一行（实施单 §5.3）：
 *   [memory] 2026-10-30 total=51 pinned=20 active=28 aging=2 archived=1 inject_cap=2000 ledger=OK pending=0
 *
 * `pending` 恒为 0：这套记忆是同步写盘、没有队列消费端，字段留着是为了
 * 和远端实施单的巡检脚本对齐（以后真加了异步写，这里就有意义）。
 */
export function memoryHealthLine(report) {
  const counts = memoryCounts()
  return `[memory] ${localDate()} total=${counts.total} pinned=${counts.pinned} active=${counts.active} aging=${counts.aging} archived=${counts.archived} inject_cap=${MEMORY_SECTION_BUDGET} ledger=${ledgerStateOf(report)} pending=0`
}

/** 健康行的结构化版本（面板 / 工具直接读字段，不用去拆字符串）。 */
export function memoryHealthValue(report) {
  const counts = memoryCounts()
  return {
    line: memoryHealthLine(report),
    date: localDate(),
    ...counts,
    injectCap: MEMORY_SECTION_BUDGET,
    ledger: ledgerStateOf(report),
    ledgerPath: report.ledgerPath,
    ledgerEntries: report.entries,
    pending: 0,
    path: memoryPath(),
  }
}

/**
 * 注入正文：画像 + 近况常驻，L2 事件按「成色×新鲜度」挑几条。
 * 预算与护栏都在 cognitive.buildInjection 里（L0 最后才让位）。
 */
/** 这一轮注入时命中了几条「旧」记忆（>3 天），归一化成 0..1，交给 absorbTurn 去点亮情绪。 */
let pendingRecallEcho = 0

/** 旧记忆命中 → 情绪回声强度。3 条封顶，避免一上来就顶满。 */
export function echoFromRecalled(items) {
  if (!Array.isArray(items) || items.length === 0) return 0
  const now = Date.now()
  let old = 0
  for (const item of items) {
    const ts = Date.parse(String(item?.created ?? ''))
    if (Number.isFinite(ts) && now - ts > 3 * 86400000) old += 1
  }
  return Math.min(1, old / 3)
}

export function memoryText() {
  if (memoryStore.enabled !== true) return ''
  // 摘要已经并掉了这些来源：即使某条后来被召回重新点亮，也不再单独展示
  // （实施单 §9.5「注入时不重复展示它的来源条目」）。
  const summarized = new Set()
  for (const item of memoryStore.items) {
    if (item.isSummary === true) for (const id of item.subEntryIds ?? []) summarized.add(id)
  }
  const candidates = memoryStore.items.filter((item) =>
    item.layer === 'L2' &&
    item.status !== 'archived' &&
    (item.isSummary === true || !summarized.has(item.id)))
  const ordered = [...candidates].sort((a, b) => {
    // ⚠️ 排序必须是「同一批输入 → 同一串输出」的纯函数，否则缓存按前缀失效：
    // 以前这里是 weight + 0.2 * freshness(created)，freshness 随时间衰减，
    // 同一批记忆过一会儿顺序就可能互换，注入文本跟着抖，前缀缓存白丢。
    // 现在只按 weight 降序，平手时按 created 升序（稳定、可重现）。
    // 摘要优先：它本来就是「多条碎片挤成一条」的产物，密度最高；
    // 若不优先，权重一低就会被碎片挤出注入名额（曾经就是这样丢掉摘要的）。
    const sumA = a.isSummary === true ? 1 : 0
    const sumB = b.isSummary === true ? 1 : 0
    if (sumA !== sumB) return sumB - sumA
    const diff = (b.weight ?? 0) - (a.weight ?? 0)
    if (diff !== 0) return diff
    return String(a.created ?? '').localeCompare(String(b.created ?? ''))
  })
  const recalled = selectForInjection(ordered.slice(0, MEMORY_INJECT_ITEMS), {
    budget: Math.floor(MEMORY_SECTION_BUDGET * 0.7),
  })
  // 这一批里有多少条是「旧」记忆：旧事重提应当带起一点情绪（情绪↔记忆联动）。
  pendingRecallEcho = echoFromRecalled(recalled)
  return buildInjection({
    l0: memoryStore.profile.l0,
    l1: memoryStore.profile.l1,
    recalled,
  }, MEMORY_SECTION_BUDGET)
}

/**
 * 关系与情绪注入。它和记忆是两个 section：关系讲「怎么相处」，记忆讲「发生过什么」。
 * 关掉记忆开关时它也不注入——用户关的是「她记得我」，关系日志属于同一件事。
 */
export function relationshipText() {
  if (memoryStore.enabled !== true) return ''
  // 一轮都没聊过就不注入：空的关系描述（「刚认识 · 平静」）只会白占预算，
  // 还会让第一句话的语气变得奇怪。聊过之后才慢慢有内容可说。
  if (Number(memoryStore.relationship.turns ?? 0) <= 0) return ''
  return buildRelationshipText(memoryStore.relationship)
}

/**
 * 新模块实例（重启 / HMR）归位：模块级单例都要回到默认。
 * 与 state.js 的 resetState 配套，index.js 每次求值都会调用。
 */
export function resetMemoryStore() {
  memoryStore = {
    items: [],
    rev: 0,
    enabled: true,
    error: null,
    profile: { l0: {}, l1: {} },
    relationship: emptyRelationship(),
    settledAt: 0,
  }
  memoryPromise = null
  memorySaveChain = Promise.resolve()
  ledgerChain = Promise.resolve()
  pendingRecallEcho = 0
}

/** 取走这一轮注入的「旧事重提」回声强度，取完归零（absorbTurn 用）。 */
export function takeRecallEcho() {
  const value = pendingRecallEcho
  pendingRecallEcho = 0
  return value
}

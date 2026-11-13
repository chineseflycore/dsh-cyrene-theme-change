// 记忆操作层：写入 / 检索 / 整理 / 钉住 / 画像 / 冲突裁决 / 工具注册。
// 依赖数据层（memory-store）、LLM 运行时、section 管理；index.js 只做接线。

import {
  COMPRESS_ACTIVE_LIMIT,
  L0_FIELDS,
  L1_FIELDS,
  PIN_WEIGHT,
  buildSummaryText,
  cleanInline,
  scoreRecall,
  buildSummaryEntry,
  decayWeight,
  importanceToWeight,
  judgeCandidate,
  nextL0,
  nextL1,
  resolveL0Field,
  resolveL1Field,
  selectCompressionCandidates,
  similarity,
  statusOf,
  tokenize,
  touchWeight,
  weightToImportance,
} from "./cognitive.js"
import { detectUserMood, deriveSignal, recordTurn, relationshipSummary } from "./relationship.js"
import {
  MEMORY_LIMIT,
  MEMORY_TAG_MAX,
  MEMORY_TOOL_DEFAULT,
  PROFILE_HISTORY_KEEP,
  PROFILE_HISTORY_WEIGHT,
  PROFILE_L0_MAX,
  PROFILE_L1_BREAKS,
  PROFILE_L1_MAX,
  PROFILE_L1_SELF_MAX,
  cleanMemoryTags,
  cleanMemoryText,
  ensureMemories,
  ledgerReport,
  memoryCounts,
  memoryHealthLine,
  memoryHealthValue,
  memoryLedgerPath,
  memoryPath,
  memoryStore,
  newMemoryId,
  persistMemories,
  publicMemories,
  sanitizeMemoryItem,
  syncMemoryLedger,
  takeRecallEcho,
} from "./memory-store.js"
import { enqueueMemoryWork, memoryLlmFor } from "./memory-llm-runtime.js"
import { remountMemory } from "./sections.js"
import { PACKAGE_ID, sanitizeMemoryLlm, state } from "./state.js"

/**
 * 整理记忆：调模型去重 + 丢弃废条。工具和面板按钮共用这一份。
 * 返回 { ok, removed, merged, scanned } 或 { ok:false, error }。
 */
export async function organizeMemories(ctx, limit) {
  // 整理是"读一屏、吐一批"的长调用，共用 20 秒的默认超时几乎必失败
  // （真机上先撞 token 截断、再撞超时）。这里给它单独放宽到 90 秒。
  const settings = sanitizeMemoryLlm(state.memoryLlm)
  let manager
  try {
    manager = createMemoryLlm(ctx ?? memoryLlmContext(), {
      ...settings,
      timeoutMs: Math.max(Number(settings.timeoutMs) || 0, 90_000),
    })
  } catch (error) {
    return { ok: false, error: `无法创建整理器：${error?.message ?? error}` }
  }
  if (manager === null || manager.canCall() !== true) {
    return { ok: false, error: '记忆整理需要一个可用的模型（在面板里挑一个）' }
  }
  const max = Math.min(80, Math.max(2, Math.round(Number(limit ?? 40))))
  const pool = memoryStore.items.filter((item) =>
    item.layer === 'L2' && item.isSummary !== true && item.status !== 'archived')
  if (pool.length < 2) return { ok: true, removed: 0, merged: 0, scanned: pool.length, note: '条目太少，不用整理' }
  const batch = pool.slice(0, max)
  const byId = new Map(batch.map((item) => [item.id, item]))

  // 一批塞太多会被输出预算截断（真机上 26 条就撞了）。分成小批逐段整理，
  // 某批失败只跳过那批，不让整次整理前功尽弃。
  const CHUNK = 10
  let removed = 0
  let merged = 0
  let scanned = 0
  let failed = 0
  for (let offset = 0; offset < batch.length; offset += CHUNK) {
    const chunk = batch.slice(offset, offset + CHUNK)
    const plan = await manager.organize(chunk.map((item) => ({
      id: item.id, text: item.text, tags: item.tags,
    })))
    scanned += chunk.length
    if (plan === null) {
      failed += 1
      continue
    }
    for (const id of plan.drop) {
      const index = memoryStore.items.findIndex((item) => item.id === id)
      if (index >= 0) {
        memoryStore.items.splice(index, 1)
        removed += 1
      }
    }
    const now = Date.now()
    for (const group of plan.merge) {
      const sources = group.ids.map((id) => byId.get(id)).filter((item) => item !== undefined)
      if (sources.length < 2) continue
      const mergedItem = newL2Item(group.text, ['合并'], {}, now)
      mergedItem.isSummary = true
      mergedItem.subEntryIds = sources.map((item) => item.id)
      for (const source of sources) {
        const index = memoryStore.items.findIndex((item) => item.id === source.id)
        if (index >= 0) memoryStore.items.splice(index, 1)
      }
      memoryStore.items.unshift(mergedItem)
      merged += sources.length
    }
  }
  if (removed > 0 || merged > 0) {
    await afterMemoryMutation(ctx)
    ctx.logger?.info?.(`${PACKAGE_ID}: 记忆整理完成——删除 ${removed} 条、合并 ${merged} 条${failed > 0 ? `（${failed} 批失败）` : ''}`)
  }
  if (failed > 0 && removed === 0 && merged === 0) {
    return { ok: false, error: manager.lastError ?? '模型没有给出可用的整理结果' }
  }
  return { ok: true, removed, merged, scanned, failed }
}
/** 异步任务改完记忆后的统一收尾：落盘 + 补账 + 重挂注入。 */
export async function afterMemoryMutation(ctx) {
  memoryStore.rev += 1
  await persistMemories(ctx)
  await syncMemoryLedger(ctx)
  remountMemory(ctx.systemPrompt)
}
/**
 * 一轮对话收尾：把「用户说了什么、她回了什么」折进关系与情绪。
 *
 * 为什么挂在 `session/event` 而不是工具里：模型不一定每轮都调记忆工具，
 * 但关系是**每一轮都在变**的——漏记一轮，连续天数、情绪环、关心提示
 * 就全都错位了。这里只做轻量计算，写盘是异步的，不阻塞回复。
 */

export function absorbTurn(userText, assistantText, ctx) {
  if (memoryStore.enabled !== true) return
  if (typeof userText !== 'string' || userText.trim() === '') return
  const mood = detectUserMood(userText)
  const signal = deriveSignal(userText, mood)
  const echo = takeRecallEcho()
  memoryStore.relationship = recordTurn(memoryStore.relationship, {
    userText,
    assistantText,
    mood,
    signal,
    echo,
  })

  // 不再自动落库。规则捕获记的是"他说过什么"，不是"值得记住什么"——
  // 真机上 26 条记忆里 17 条是框架注入的时间戳，剩下也多是追问。
  // 改回由模型自己判断要不要写（提示词里给了明确的触发条件），另外提供一个
  // 可选的 LLM 整理入口（cyrene_memory_organize）来事后归并。
}

/**
 * 把一批来源压成摘要条目并写进库（规则与 LLM 共用）。
 * `llmText` 非空时用模型正文；否则 buildSummaryEntry 里的 buildSummaryText 兜底。
 */
export function commitCompression(sources, llmText) {
  const list = Array.isArray(sources) ? sources : []
  if (list.length < 2) return null
  const summary = buildSummaryEntry(list, { id: newMemoryId() })
  if (typeof llmText === 'string' && llmText !== '') summary.text = llmText
  if (summary.text === '') return null
  const ids = new Set(list.map((item) => item.id))
  for (const item of memoryStore.items) {
    if (ids.has(item.id)) item.status = 'archived'
  }
  memoryStore.items.unshift(summary)
  return summary
}

/** 一次压缩可能跨好几轮写入，排队期间不再重复触发。 */
let compressionPending = false

/**
 * 写入之后的压缩 / 反思（实施单 §9.5）：
 * active 的 L2 超过 120 条时，取「最老 + 成色最低」的 20 条压成一条摘要，
 * 来源转 archived。摘要 layer='L2'、成色取均值、照常参与召回。
 *
 * 三级降级：
 *  1. LLM 可用 → 异步调 summarize()，用模型正文；
 *  2. LLM 返回 null / 抛错 / 超时 → 仍由 commitCompression 走 buildSummaryText；
 *  3. 没有 LLM 服务（canCall=false）→ 完全同步走规则，行为和 v0.6 一致。
 * 返回值：同步路径返回摘要条目；异步路径返回 null（摘要稍后落库）。
 */
export function maybeCompressMemories(ctx) {
  const active = memoryStore.items.filter((item) =>
    item.layer === 'L2' && item.status === 'active' && item.isSummary !== true)
  if (active.length <= COMPRESS_ACTIVE_LIMIT) return null
  const sources = selectCompressionCandidates(active)
  // 少于 2 条就谈不上「合并」，宁可再攒一轮。
  if (sources.length < 2) return null

  const manager = memoryLlmFor(ctx)
  if (manager === null || manager.canCall() !== true) {
    return commitCompression(sources, '')
  }
  if (compressionPending) return null
  compressionPending = true
  void enqueueMemoryWork(ctx, async () => {
    try {
      // 排队期间来源可能被合并 / 删除：重新确认它们还在、还是 active。
      const still = sources.filter((item) =>
        memoryStore.items.includes(item) && item.status === 'active' && item.isSummary !== true)
      if (still.length < 2) return null
      let text = ''
      try {
        const result = await manager.summarize(still)
        if (result !== null && typeof result.summary === 'string') text = result.summary
      } catch {
        // 任何异常都走规则摘要，不让压缩任务失败
        text = ''
      }
      const summary = commitCompression(still, text)
      if (summary === null) return null
      if (ctx !== null && ctx !== undefined) await afterMemoryMutation(ctx)
      return summary
    } finally {
      compressionPending = false
    }
  })
  return null
}

/**
 * 钉住 / 取消钉住（实施单 §9.3 的保护线 0.7）：
 * 钉住 = 成色抬到保护线以上、状态回 active；之后 decayWeight 见到 pinned 直接跳过。
 * 取消 = 回到保护线以下（0.69）：否则 sanitize 那行「weight >= 0.7 自动算钉住」
 * 会在下次启动时又把它算成钉住的，这个开关就白点了。
 */
export function pinMemory(item, pinned) {
  const target = pinned === true
  item.pinned = target
  const weight = Number(item.weight ?? 0)
  if (target) {
    item.weight = Math.max(weight, PIN_WEIGHT)
    item.status = 'active'
  } else {
    item.weight = Math.min(weight, PIN_WEIGHT - 0.01)
    item.status = statusOf(item.weight)
  }
  item.importance = weightToImportance(item.weight)
  item.lastDecay = Date.now()
  return item
}

/** 旧版合并：保留信息更全的那句，并给成色加一点。 */
export function mergeIntoExisting(target, text, tags, now) {
  if (text.length > target.text.length) target.text = text
  target.tags = [...new Set([...target.tags, ...tags])].slice(0, MEMORY_TAG_MAX)
  target.weight = Math.min(1, (target.weight ?? 0.5) + 0.05)
  target.status = statusOf(target.weight)
  target.importance = weightToImportance(target.weight)
  target.accessCount = Number(target.accessCount ?? 0) + 1
  target.lastAccess = now
  target.lastDecay = now
}

/** 画像字段的键：历史条目靠它认领「我属于哪个槽位」。 */
export function profileFieldKey(layer, field) {
  return `${layer.toLowerCase()}.${field}`
}

/**
 * 画像/近况的字段级校验：宁可不提升，也不把半句话写进槽位。
 * 返回 `{ ok, field, reason }`；不通过时调用方保留 L2，绝不截断后硬写。
 */
export function validateProfileValue(layer, field, value) {
  const text = cleanInline(value)
  if (text === '') return { ok: false, field: '', reason: 'empty' }
  const isL0 = layer === 'L0'
  const resolved = isL0 ? resolveL0Field(field, text) : resolveL1Field(field, text)
  if (!(isL0 ? L0_FIELDS : L1_FIELDS).includes(resolved)) {
    return { ok: false, field: resolved, reason: 'field' }
  }
  const length = Array.from(text).length
  if (isL0) {
    // 稳定画像只收「称呼/职业/爱好/语言/固定信息」的一句话说清的值；
    // 落点已经在白名单里，超长就说明它是自述而不是画像。
    if (length > PROFILE_L0_MAX) return { ok: false, field: resolved, reason: 'too-long' }
    return { ok: true, field: resolved, reason: 'ok' }
  }
  if (length > PROFILE_L1_MAX) return { ok: false, field: resolved, reason: 'too-long' }
  // 整段自我介绍（逗号/句号太多，或以「我/用户」开头又太长）不是近况。
  const breaks = (text.match(/[，,。.]/g) ?? []).length
  if (breaks > PROFILE_L1_BREAKS) return { ok: false, field: resolved, reason: 'sentence' }
  if (/^(我|用户)/.test(text) && length > PROFILE_L1_SELF_MAX) {
    return { ok: false, field: resolved, reason: 'self-intro' }
  }
  return { ok: true, field: resolved, reason: 'ok' }
}

/**
 * 覆盖 L0/L1 之前留痕：旧值先转成一条低成色 L2（tags:['历史']），再写新值。
 * 每个字段只保留最近 3 条历史，更老的归档——槽位会反复覆盖，但库不能被撑爆。
 */
export function archiveProfileValue(layer, field, previous, now) {
  const text = cleanMemoryText(`（旧）${previous}`)
  if (text === '') return null
  const key = profileFieldKey(layer, field)
  const item = {
    id: newMemoryId(),
    text,
    tags: ['历史'],
    importance: weightToImportance(PROFILE_HISTORY_WEIGHT),
    weight: PROFILE_HISTORY_WEIGHT,
    layer: 'L2',
    status: statusOf(PROFILE_HISTORY_WEIGHT),
    pinned: false,
    accessCount: 0,
    lastAccess: now,
    lastDecay: now,
    emotion: 0,
    created: new Date(now).toISOString(),
    historyField: key,
  }
  memoryStore.items.unshift(item)
  if (memoryStore.items.length > MEMORY_LIMIT) memoryStore.items.length = MEMORY_LIMIT
  const history = memoryStore.items
    .filter((entry) => entry.layer === 'L2' && entry.historyField === key)
    .sort((a, b) => (Date.parse(b.created) || 0) - (Date.parse(a.created) || 0))
  for (const stale of history.slice(PROFILE_HISTORY_KEEP)) stale.status = 'archived'
  return item
}

/** 统一的 L0/L1 写入（含留痕）；所有提升路径都必须走这里。 */
export function writeProfileValue(layer, field, value, now = Date.now()) {
  const isL0 = layer === 'L0'
  const bucket = isL0 ? memoryStore.profile.l0 : memoryStore.profile.l1
  const previous = typeof bucket[field] === 'string' ? bucket[field] : ''
  if (previous !== '' && previous !== value) archiveProfileValue(layer, field, previous, now)
  const updated = isL0
    ? nextL0(memoryStore.profile.l0, field, value, { now })
    : nextL1(memoryStore.profile.l1, field, value, { now })
  if (isL0) memoryStore.profile.l0 = updated
  else memoryStore.profile.l1 = updated
  return previous
}

/** 画像条目的对外形状（降级直写时仍按 v0.6 返回 profile-* 条目）。 */
export function profileEntryFor(layer, field, text, tags, now) {
  return {
    id: `profile-${layer.toLowerCase()}-${field}`,
    text,
    tags,
    layer,
    field,
    importance: 5,
    weight: 1,
    status: 'active',
    pinned: true,
    created: new Date(now).toISOString(),
    accessCount: 0,
    lastAccess: now,
    lastDecay: now,
    emotion: 0,
  }
}

/**
 * 规则分层的降级直写（LLM 不可用）：保持 v0.6 行为——不进 L2、直接改画像。
 * 这里刻意不经过字段校验：v0.6 的规则层就是「怎么写就怎么落」，
 * 校验只拦云端模型的提升建议，别让降级路径反而改变老行为。
 */
export function applyCandidateLayer(item, layer, field, options = {}) {
  if (layer !== 'L0' && layer !== 'L1') return null
  const index = memoryStore.items.indexOf(item)
  if (index < 0) return null
  const text = cleanMemoryText(item.text)
  if (text === '') return null
  const isL0 = layer === 'L0'
  const resolved = isL0 ? resolveL0Field(field, text) : resolveL1Field(field, text)
  const now = options.now ?? Date.now()
  writeProfileValue(layer, resolved, text, now)
  const current = memoryStore.items.indexOf(item)
  if (current >= 0) memoryStore.items.splice(current, 1)
  return profileEntryFor(layer, resolved, text, [...item.tags], now)
}

/** 把一条 L2 事件迁移进 L0 / L1 画像（LLM 判层结果，先校验再落）。 */
export function moveItemToProfile(item, layer, field) {
  if (layer !== 'L0' && layer !== 'L1') return false
  const index = memoryStore.items.indexOf(item)
  if (index < 0) return false
  const text = cleanMemoryText(item.text)
  if (text === '') return false
  const checked = validateProfileValue(layer, field, text)
  // 校验失败就留在 L2：不移动、不改画像，也不截断后硬写半句话。
  if (checked.ok !== true) return false
  const now = Date.now()
  writeProfileValue(layer, checked.field, text, now)
  const current = memoryStore.items.indexOf(item)
  if (current >= 0) memoryStore.items.splice(current, 1)
  return true
}

/** 应用 LLM 的分层 / 标签结果；改了返回 true。 */
export function applyJudgement(item, judgement) {
  if (judgement === null || typeof judgement !== 'object') return false
  if (memoryStore.items.includes(item) !== true) return false
  let changed = false
  if (Array.isArray(judgement.tags) && judgement.tags.length > 0) {
    const merged = [...new Set([...item.tags, ...judgement.tags])].slice(0, MEMORY_TAG_MAX)
    if (JSON.stringify(merged) !== JSON.stringify(item.tags)) {
      item.tags = merged
      changed = true
    }
  }
  if (judgement.layer === 'L0' || judgement.layer === 'L1') {
    if (moveItemToProfile(item, judgement.layer, judgement.field)) changed = true
  }
  return changed
}

/**
 * 异步分层（不阻塞这一轮）：LLM 只做「补强」——把 L2 事件挪进画像/近况、
 * 补标签；返回 null 时什么都不做，规则分层原样保留。
 * 注意：粗筛已经通过，LLM 的 keep=false 不删数据，只当作「不改」。
 */
export function scheduleJudgement(ctx, item, text, options = {}) {
  const manager = memoryLlmFor(ctx)
  if (manager === null || manager.canCall() !== true) return
  void enqueueMemoryWork(ctx, async () => {
    const judgement = await manager.judge(text)
    if (judgement === null) {
      // LLM 这一次没给出结果（超时 / 坏 JSON）：规则判成 L0/L1 时按 v0.6 降级直写。
      if (options.candidateLayer === 'L0' || options.candidateLayer === 'L1') {
        const promoted = applyCandidateLayer(item, options.candidateLayer, options.field)
        if (promoted !== null && ctx !== null && ctx !== undefined) await afterMemoryMutation(ctx)
      }
      return null
    }
    if (judgement.keep === false) return null
    const changed = applyJudgement(item, judgement)
    if (changed && ctx !== null && ctx !== undefined) await afterMemoryMutation(ctx)
    return judgement
  })
}

/**
 * 异步冲突裁决（相似度 >= 0.6）：
 * - merge / replace：把候选并进已有条目，删掉候选；
 * - add：两件不同的事，都留下；
 * - review / null：回落到 bestSim >= 0.86 || contained 的旧判断。
 */
export function scheduleConflictResolution(ctx, item, existing, meta) {
  const manager = memoryLlmFor(ctx)
  if (manager === null || manager.canCall() !== true) return
  void enqueueMemoryWork(ctx, async () => {
    if (memoryStore.items.includes(item) !== true || memoryStore.items.includes(existing) !== true) return null
    let result = null
    try {
      result = await manager.resolve(existing, item)
    } catch {
      result = null
    }
    const action = result !== null && typeof result.action === 'string' ? result.action : 'rule'
    const ruleMerge = meta.bestSim >= 0.86 || meta.contained
    if (action === 'add') return result
    if (action === 'rule' || action === 'review') {
      if (ruleMerge !== true) {
        // 保留两边，并记下「和谁像」，面板能看出这条是待观察的。
        item.conflictWith = [...new Set([...(item.conflictWith ?? []), existing.id])]
        return result
      }
    }
    const index = memoryStore.items.indexOf(item)
    if (index < 0) return null
    if (action === 'replace') {
      existing.text = result !== null && typeof result.text === 'string' && result.text !== ''
        ? result.text
        : item.text
      existing.tags = [...new Set([...existing.tags, ...item.tags])].slice(0, MEMORY_TAG_MAX)
      existing.weight = Math.min(1, (existing.weight ?? 0.5) + 0.05)
      existing.status = statusOf(existing.weight)
      existing.importance = weightToImportance(existing.weight)
      existing.accessCount = Number(existing.accessCount ?? 0) + 1
      existing.lastAccess = Date.now()
      existing.lastDecay = existing.lastAccess
    } else if (action === 'merge' && result !== null && typeof result.text === 'string' && result.text !== '') {
      existing.text = result.text
      mergeIntoExisting(existing, existing.text, item.tags, Date.now())
    } else {
      // action=merge（没给正文）或 rule 合并：沿用旧规则「谁更长留谁」。
      mergeIntoExisting(existing, item.text, item.tags, Date.now())
    }
    memoryStore.items.splice(index, 1)
    if (ctx !== null && ctx !== undefined) await afterMemoryMutation(ctx)
    return result
  })
}

/** 新建一条 L2 事件（规则 / LLM 两条路共用）。 */
export function newL2Item(text, tags, options, now) {
  return {
    id: newMemoryId(),
    text,
    tags,
    importance: 3,
    weight: importanceToWeight(3),
    layer: 'L2',
    status: 'active',
    pinned: options.pinned === true,
    accessCount: 0,
    lastAccess: now,
    lastDecay: now,
    emotion: Number.isFinite(Number(options.emotion)) ? Math.min(1, Math.max(0, Number(options.emotion))) : 0,
    created: new Date(now).toISOString(),
  }
}

/**
 * 加一条记忆。返回落库后的条目（写盘与重挂由调用方收尾）。
 *
 * 流程（融合自 Cyrene-Agent 的 memory-manager）：
 *  1. `judgeCandidate` 挡掉过程性内容（寒暄/问句/报错/代码块）；
 *  2. 规则只算一个 `candidateLayer`，**一律先落一条 L2**——不再有「判成 L0/L1
 *     就直接 return」的分支；画像/近况写错了会污染每一轮，必须再让一层判断；
 *  3. LLM 可用：异步 `judge()` 决定是否提升；只有返回 L0/L1 且通过字段校验
 *     （`moveItemToProfile`）才移动，返回 L2 就留在事件层；
 *  4. LLM 不可用：按 `candidateLayer` 降级直写（v0.6 行为），这条临时 L2 会被移除；
 *  5. L2 仍按老规则判重：相似度 >= 0.86 或互相包含就同步合并；LLM 可用时
 *     相似度 >= 0.6 先落候选，再异步 resolve() 决定 merge/replace/add。
 */
export function addMemory(text, tags, options = {}) {
  const ctx = options.ctx
  const judgement = judgeCandidate(text, {
    explicit: options.explicit === true,
    layer: options.layer,
  })
  if (!judgement.keep) return null
  const clean = cleanMemoryText(text)
  if (clean === '') return null
  const cleanTags = cleanMemoryTags(tags)
  const now = Date.now()
  const candidateLayer = judgement.layer === 'L0' || judgement.layer === 'L1' ? judgement.layer : 'L2'
  const manager = memoryLlmFor(ctx)
  const llmCan = manager !== null && manager.canCall() === true

  if (candidateLayer !== 'L2' && llmCan !== true) {
    // 云端模型不可用：保持 v0.6 的「规则层直接落地」。先落 L2 再提升，
    // 保证所有写入都经过同一个入口；提升成功后这条 L2 会被移除。
    const fallback = newL2Item(clean, cleanTags, options, now)
    memoryStore.items.unshift(fallback)
    if (memoryStore.items.length > MEMORY_LIMIT) memoryStore.items.length = MEMORY_LIMIT
    const promoted = applyCandidateLayer(fallback, candidateLayer, options.field, { now })
    return promoted !== null ? promoted : fallback
  }

  const tokens = tokenize(clean)
  let best = null
  let bestSim = 0
  for (const item of memoryStore.items) {
    if (item.layer !== 'L2') continue
    const sim = similarity(tokens, tokenize(item.text))
    if (sim > bestSim) {
      bestSim = sim
      best = item
    }
  }

  // 合并判据有两条，满足其一即可：
  //  a) 2-gram 相似度够高（同一件事换个说法）；
  //  b) 一条是另一条的子串（「原句 + 补充」是最常见的增量写法）。
  // 只靠阈值会漏掉 b——补一句后缀会把 2-gram 相似度稀释到阈值以下。
  const contained = best !== null && (clean.includes(best.text) || best.text.includes(clean))

  if (best !== null && (bestSim >= 0.86 || contained) && llmCan !== true) {
    mergeIntoExisting(best, clean, cleanTags, now)
    return best
  }

  const item = {
    ...newL2Item(clean, cleanTags, options, now),
    ...(best !== null && bestSim >= 0.6
      ? { conflictWith: [best.id] }
      : {}),
  }
  memoryStore.items.unshift(item)
  if (memoryStore.items.length > MEMORY_LIMIT) memoryStore.items.length = MEMORY_LIMIT

  // 顺序很重要：先裁决冲突，再补分层/标签，最后才考虑压缩。
  if (best !== null && bestSim >= 0.6 && llmCan === true) {
    scheduleConflictResolution(ctx, item, best, { bestSim, contained })
  }
  // 规则层也交给 LLM 复核：返回 L0/L1 时再走字段校验 + 留痕提升，返回 L2 就保持。
  if (llmCan === true) {
    scheduleJudgement(ctx, item, clean, { candidateLayer, field: options.field })
  }
  // 实施单 §9.5：压缩的触发点在写入之后；它只动 status 与新增摘要，
  // 不改这一条刚写进来的正文，所以返回值照旧。
  maybeCompressMemories(ctx)
  return item
}

/**
 * 检索：语义式召回（2-gram 相似度 + 成色 + 新鲜度），而不是子串匹配。
 *
 * 空关键词退化成「最近/最重要的几条」。命中结果会被 touch 一次
 * （成色 +0.02、访问计数 +1）——被想起来的事本来就更难忘掉。
 * 调用方负责在之后 persist，因为这里只动内存。
 */
export function searchMemories(query, limit) {
  const max = Math.min(MEMORY_LIMIT, Math.max(1, Number.isFinite(Number(limit)) ? Math.round(Number(limit)) : MEMORY_TOOL_DEFAULT))
  const needle = typeof query === 'string' ? query.trim() : ''
  const now = Date.now()

  if (needle === '') {
    return [...memoryStore.items]
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .slice(0, max)
  }

  const tokens = tokenize(needle)
  const scored = []
  for (const item of memoryStore.items) {
    if (item.layer !== 'L2') continue
    const sim = similarity(tokens, tokenize(`${item.text} ${item.tags.join(' ')}`))
    if (sim <= 0) continue
    scored.push({ item, sim, score: scoreRecall(item, tokens, { now, sim }) })
  }
  scored.sort((a, b) => b.score - a.score)
  const picked = scored.slice(0, max)
  for (const { item } of picked) {
    const touched = touchWeight(item, now)
    item.weight = touched.weight
    item.accessCount = touched.accessCount
    item.lastAccess = touched.lastAccess
    item.lastDecay = now
    item.status = statusOf(item.weight)
    item.importance = weightToImportance(item.weight)
  }
  return picked.map((entry) => entry.item)
}

/**
 * 把记忆能力交给模型：三个工具（写 / 找 / 忘）。
 * 用 `ctx.get('tools')` 取可选服务——老宿主没有这个服务时整块安静跳过，
 * 面板与注入照常工作（降级成"只能自己手动记"）。
 */
export function registerMemoryTools(ctx) {
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
  const register = (definition) => {
    try {
      const dispose = tools.register({ ...definition, output: textOutput })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      ctx.logger?.warn?.(`${PACKAGE_ID}: 注册工具 ${definition.name} 失败`, error)
    }
  }
  register({
    name: 'cyrene_memory_add',
    description: '往昔涟的记忆里存一条。会按内容自动分层：稳定的身份信息（称呼/职业/长期爱好/语言）进画像，近期目标/偏好/在忙的事进近况，其余进长期事件。只在真的值得以后还记得时用：偏好、约定、长期事实、踩过的坑。一条只说一件事，不超过 600 字；别存对话过程、别存临时状态。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的那件事，主语明确、能独立读懂（例如"用户偏好深色主题，屏幕是 2560×1600"）。' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选标签，最多 8 个，用于以后检索（例如 ["偏好","环境"]）。' },
        layer: { type: 'string', enum: ['L0', 'L1', 'L2'], description: '可选：强制分层。不填则按内容自动判断。' },
        field: { type: 'string', description: '可选：画像字段名（preferredName / occupation / longTermInterests / language / permanentNote 或 recentGoals / recentPreferences / currentProject）。' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(args) {
      const before = memoryStore.items.length
      const item = addMemory(args?.text, args?.tags, {
        ctx,
        layer: args?.layer,
        field: args?.field,
      })
      if (item === null) return { ok: false, error: 'nothing-to-remember' }
      memoryStore.rev += 1
      await persistMemories(ctx)
      // 实施单 §5.2：写入之后补账（合并也走这里；老记录不覆盖）。
      await syncMemoryLedger(ctx)
      remountMemory(ctx.systemPrompt)
      return {
        ok: true,
        id: item.id,
        layer: item.layer,
        // 合并进旧条目时 count 不变——如实告诉模型，它就不会以为「写了两份」。
        merged: item.layer === 'L2' && memoryStore.items.length === before,
        count: memoryStore.items.length,
      }
    },
  })
  register({
    name: 'cyrene_memory_search',
    description: '在昔涟的记忆里找旧事。按语义相关度排序（不只是字面包含），命中的条目会被顺带「想起一次」——用得越多越难忘。不确定用户以前说过什么、做过什么约定时先用它翻一遍，别凭印象猜。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的事，用短句或关键词都行；留空则返回成色最高的几条。' },
        limit: { type: 'integer', description: '最多返回几条（默认 8）。' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const items = searchMemories(args?.query, args?.limit)
      // 召回会 touch 成色，所以这里也要落盘（否则下次启动又缩回去）。
      await persistMemories(ctx)
      remountMemory(ctx.systemPrompt)
      return {
        total: memoryStore.items.length,
        returned: items.length,
        items: items.map((item) => ({
          id: item.id,
          text: item.text,
          tags: [...item.tags],
          created: item.created,
          layer: item.layer,
          importance: item.importance,
          weight: Number(item.weight ?? 0),
          status: item.status,
          // 摘要条目在检索结果里也标出来，模型/面板知道这一条是压缩过的。
          isSummary: item.isSummary === true,
        })),
      }
    },
  })
  register({
    name: 'cyrene_memory_forget',
    description: '从记忆里删掉一条（用 cyrene_memory_search 拿到的 id）。也能删画像/近况字段（id 形如 profile-l0-preferredName）。用户说"忘掉这个"、或发现记错了时用。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '记忆条目的 id。' } },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(args) {
      const id = typeof args?.id === 'string' ? args.id : ''
      const profileMatch = /^profile-(l0|l1)-([A-Za-z]+)$/.exec(id)
      if (profileMatch !== null) {
        const bucket = profileMatch[1] === 'l0' ? 'l0' : 'l1'
        const field = profileMatch[2]
        const target = memoryStore.profile[bucket]
        if (target === undefined || target[field] === undefined) return { ok: false, error: 'not-found' }
        delete target[field]
        memoryStore.rev += 1
        await persistMemories(ctx)
        remountMemory(ctx.systemPrompt)
        return { ok: true, count: memoryStore.items.length }
      }
      const index = memoryStore.items.findIndex((item) => item.id === id)
      if (index < 0) return { ok: false, error: 'not-found' }
      memoryStore.items.splice(index, 1)
      memoryStore.rev += 1
      await persistMemories(ctx)
      // 删掉之后补账：sync 只补新 id，不会把删掉的那条从账本里抹掉——
      // 那正是账本该留下的证据（verify 会报 missing，提醒这里有删除动作）。
      await syncMemoryLedger(ctx)
      remountMemory(ctx.systemPrompt)
      return { ok: true, count: memoryStore.items.length }
    },
  })
  register({
    name: 'cyrene_memory_profile',
    description: '读昔涟现在的画像（她记得的你：称呼、职业、爱好、近况）和你们的关系状态。想确认「我该怎么称呼他」「我们熟到什么程度」时用它，比翻搜索结果更直接。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const l0 = {}
      for (const field of L0_FIELDS) if (memoryStore.profile.l0[field] !== undefined) l0[field] = memoryStore.profile.l0[field]
      const l1 = {}
      for (const field of L1_FIELDS) if (memoryStore.profile.l1[field] !== undefined) l1[field] = memoryStore.profile.l1[field]
      const relationship = memoryStore.relationship
      return {
        l0,
        l0Labels: L0_LABELS,
        l1,
        l1Labels: L1_LABELS,
        relationship: {
          summary: relationshipSummary(relationship),
          turns: relationship.turns,
          affinity: relationship.affinity,
          trust: relationship.trust,
          streakDays: relationship.streakDays,
          dominantEmotion: relationship.dominant?.label ?? '平静',
          lastMood: relationship.lastMood,
          nextCareCue: relationship.nextCareCue,
        },
        itemCount: memoryStore.items.length,
      }
    },
  })
  /**
   * 整理记忆：交给（可以是免费的）云模型做一次去重与精简。
   *
   * 为什么做成工具而不是后台自动跑：整理会删条目，属于不可逆操作，
   * 应该由用户/模型显式触发，并且能看见改了什么。
   */
  register({
    name: 'cyrene_memory_organize',
    description: '整理记忆库：让模型把重复的条目并成一条、丢掉没价值的（寒暄/临时状态）。只删不改写别的，也不会凭空新增。整理会动真实数据，建议先确认用户同意。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多整理多少条（默认 40，上限 80）。' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      return organizeMemories(ctx, args?.limit)
    },
  })

  register({
    name: 'cyrene_memory_pin',
    description: '把一条记忆钉住 / 取消钉住（用 cyrene_memory_search 拿到的 id）。钉住的记忆永不衰减、会稳定排在注入里；取消钉住后重新按成色衰减。用户说「这件事别忘了」「这个就定下来」时用。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆条目的 id。' },
        pinned: { type: 'boolean', description: 'true 钉住（默认），false 取消钉住。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(args) {
      const id = typeof args?.id === 'string' ? args.id : ''
      const item = memoryStore.items.find((entry) => entry.id === id)
      if (item === undefined) return { ok: false, error: 'not-found' }
      pinMemory(item, args?.pinned !== false)
      memoryStore.rev += 1
      await persistMemories(ctx)
      remountMemory(ctx.systemPrompt)
      return {
        ok: true,
        id: item.id,
        pinned: item.pinned,
        weight: item.weight,
        status: item.status,
        count: memoryStore.items.length,
      }
    },
  })
  register({
    name: 'cyrene_memory_stats',
    description: '读记忆系统的现状：各状态条数、钉住数、账本是否对得上、以及每日健康那一行。想确认「记忆还在不在、有没有丢过」时用它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      // 实施单 §5.2 + §5.3：账本状态和健康行一起给，省得模型分两次问。
      const report = await ledgerReport()
      const health = memoryHealthValue(report)
      return {
        ok: true,
        // 健康那一行放在 text 里：工具的 output.render 会直接展示它。
        text: health.line,
        line: health.line,
        date: health.date,
        counts: {
          total: health.total,
          pinned: health.pinned,
          active: health.active,
          aging: health.aging,
          archived: health.archived,
        },
        ledger: {
          state: health.ledger,
          entries: report.entries,
          checked: report.checked,
          mismatched: report.mismatched,
          missing: report.missing,
          unledgered: report.unledgered,
          path: report.ledgerPath,
        },
        injectCap: health.injectCap,
        pending: 0,
        path: health.path,
        total: health.total,
        pinned: health.pinned,
        active: health.active,
        aging: health.aging,
        archived: health.archived,
      }
    },
  })
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 已随 fiber 回收
      }
    }
  }
}

/** 新模块实例（重启 / HMR）归位。 */
export function resetMemoryOps() {
  compressionPending = false
}

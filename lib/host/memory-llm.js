/**
 * 昔涟 · 记忆整理（云端 LLM 优先，规则兜底）
 *
 * 这一层只做一件事：把「分层 / 判重 / 压缩 / 冲突裁决」交给云端模型，
 * 并且保证**永远不把异常抛给调用方**——超时、断网、坏 JSON、模型胡说，
 * 一律返回 null，调用方用 cognitive.js 的纯规则继续跑。
 *
 * 为什么放在单独文件：
 * - 宿主半（index.js）已经有 3000 行，LLM 的流式读取、超时、JSON 清洗
 *   再塞进去会把这层「记忆整理」和「持久化 / 路由 / 注入」搅在一起；
 * - 这里不读盘、不碰记忆库，只接收文本、返回结构化结果，方便单测 mock。
 *
 * 接口（全部异步、可注入、失败返回 null）：
 *   createMemoryLlm(ctx, options) → {
 *     available, provider, model, lastError,
 *     ready(), canCall(), status(),
 *     judge(text), summarize(items), resolve(existing, candidate),
 *     dispose(),
 *   }
 *
 * 解析顺序：options.provider/model（来自 state.memoryLlm）→
 *          llm.listProviders()[0] + 该 provider 的第一个模型 → 不可用。
 */
import { SUMMARY_MAX, SUMMARY_TAG_MAX, TEXT_MAX, cleanInline, unionTags } from './cognitive.js'

/** 默认超时：20s。本地小模型要 25s，云端通常 1–5s，20s 足够且不会拖太久。 */
export const MEMORY_LLM_TIMEOUT_MS = 20_000

/**
 * 免费模型（如 GLM-4.7-Flash）长期报 429 是常态，不是异常。
 * 策略：每 2–10 秒随机退避重试，直到拿到响应或超过窗口期。
 * 窗口期给 3 分钟——足够跨过一波限流，又不至于让一次整理卡到天荒地老。
 */
export const RATE_LIMIT_MIN_MS = 2_000
export const RATE_LIMIT_MAX_MS = 10_000
export const RATE_LIMIT_WINDOW_MS = 180_000

/** 判断是不是限流错误：不同 provider 的措辞不一样，宁可宽一点。 */
export function isRateLimitError(message) {
  const text = String(message ?? '')
  return /429|rate[\s_-]?limit|too many requests|quota|限流|请求过多/iu.test(text)
}
/** 超时可配置区间：测试会传几十毫秒，所以下限放到 10ms；上限防止一次误配置把队列卡死。 */
export const MEMORY_LLM_TIMEOUT_MIN = 10
export const MEMORY_LLM_TIMEOUT_MAX = 120_000
/** 单次调用的输出预算：分层/裁决很短，摘要要留足 600 字。 */
const JUDGE_MAX_TOKENS = 300
const SUMMARIZE_MAX_TOKENS = 900
const RESOLVE_MAX_TOKENS = 500

const JUDGE_SYSTEM = [
  '你是昔涟的长期记忆整理器，只输出 JSON，不要解释，不要 Markdown。',
  '输入是一条候选记忆。判断它是否值得长期记住，并决定分层、字段与标签。',
  '',
  '分层规则：',
  '- L0：稳定的用户画像，只有用户明确说过才写（称呼、职业、长期爱好、语言/地区、其他固定信息）。',
  '- L1：近期状态，会过期（近期目标、近期偏好、正在忙的项目）。',
  '- L2：其余值得以后想起的具体事件、约定、偏好、踩过的坑。',
  '寒暄、问句、临时过程、纯报错、纯代码没有长期价值，keep=false。',
  '',
  '只输出这个形状：',
  '{"keep":true,"layer":"L0|L1|L2","field":"可选字段名","tags":["最多8个短标签"],"reason":"一句话理由"}',
  'field 只能取：preferredName / occupation / longTermInterests / language / permanentNote /',
  'recentGoals / recentPreferences / currentProject；不适用就省略。',
].join('\n')

const SUMMARIZE_SYSTEM = [
  '你是昔涟的记忆压缩器，只输出 JSON，不要解释，不要 Markdown 围栏。',
  '把输入的一批旧记忆压成一段不超过 600 字的中文摘要，保留：',
  '- 每件事的关键事实（谁、做了什么、结果、约定）；',
  '- 时间范围（最早与最晚的日期）；',
  '- 来源标签的并集。',
  '不要逐条复述，不要编造输入里没有的信息，不要写「以上」「总之」这类空话。',
  '只输出这个形状：',
  '{"summary":"【起始日期 ~ 结束日期｜标签1、标签2】压缩后的正文"}',
].join('\n')

const RESOLVE_SYSTEM = [
  '你是昔涟的记忆冲突裁决器，只输出 JSON，不要解释，不要 Markdown。',
  '输入 existing（库里已有）与 candidate（刚要说的话）。判断两者关系：',
  '- merge：同一件事的补充/换说法，信息可以并进 existing；',
  '- replace：candidate 是更新的版本，应该覆盖 existing 的旧说法；',
  '- add：两件不同的事，都该保留；',
  '- review：拿不准，交给调用方按相似度规则处理。',
  'merge/replace 时可在 text 里给出合并后的正文（不超过 600 字）；add/review 不需要 text。',
  '只输出这个形状：',
  '{"action":"merge|replace|add|review","text":"可选正文","reason":"一句话理由"}',
].join('\n')

/** 从 ctx 里安全地取 llm 服务：老宿主没有这个服务时返回 null。 */
function readLlm(ctx) {
  if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return null
  try {
    return ctx.get('llm') ?? null
  } catch {
    return null
  }
}

/** provider 列表项可能是 `{ id }`，也兼容直接给字符串的简化实现。 */
function providerIdOf(entry) {
  if (typeof entry === 'string') return entry.trim()
  if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string') return entry.id.trim()
  return ''
}

/** 模型列表项同理：`{ id }` 或字符串。 */
function modelIdOf(entry) {
  return providerIdOf(entry)
}

/** 超时参数：非数字 / 非正数回落到默认值，有效值夹在 10ms–120s。 */
export function resolveTimeoutMs(value, fallback = MEMORY_LLM_TIMEOUT_MS) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(MEMORY_LLM_TIMEOUT_MAX, Math.max(MEMORY_LLM_TIMEOUT_MIN, Math.floor(n)))
}

/**
 * 从模型输出里抠 JSON。
 *
 * 模型常见的三种坏习惯都要兜住：
 *  1. 包在 ```json … ``` 围栏里；
 *  2. 前后各来一段「好的，结果是：」；
 *  3. 围栏外还有解释，但 JSON 本身完整。
 * 只取第一个 `{` 到最后一个 `}`，解析失败返回 null。
 */
export function extractJson(raw) {
  if (typeof raw !== 'string') return null
  let text = raw.trim()
  if (text === '') return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fenced !== null) text = fenced[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  text = text.slice(start, end + 1)
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 标签清洗：只留非空字符串、去重、最多 SUMMARY_TAG_MAX 个。 */
function normalizeTags(value) {
  if (!Array.isArray(value)) return undefined
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const tag = cleanInline(entry).slice(0, 24)
    if (tag === '' || out.includes(tag)) continue
    out.push(tag)
    if (out.length >= SUMMARY_TAG_MAX) break
  }
  return out
}

/** 把 judge 的原始 JSON 收成白名单形状；layer 不合法就当坏结果。 */
export function normalizeJudgement(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const layer = value.layer === 'L0' || value.layer === 'L1' || value.layer === 'L2' ? value.layer : ''
  if (layer === '') return null
  const tags = normalizeTags(value.tags)
  const field = typeof value.field === 'string' ? cleanInline(value.field).slice(0, 40) : ''
  const reason = typeof value.reason === 'string' ? cleanInline(value.reason).slice(0, 200) : ''
  return {
    keep: value.keep !== false,
    layer,
    ...(field === '' ? {} : { field }),
    ...(tags === undefined ? {} : { tags }),
    ...(reason === '' ? {} : { reason }),
  }
}

/** 时间范围 + 标签并集（和规则版 buildSummaryText 的头部一致，保证两条路可读）。 */
function summaryHead(entries) {
  const days = entries
    .map((entry) => String(entry?.created ?? '').slice(0, 10))
    .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day))
    .sort()
  const range = days.length === 0 ? '' : days[0] === days.at(-1) ? days[0] : `${days[0]} ~ ${days.at(-1)}`
  const tags = unionTags(entries)
  return `【${range}${tags.length > 0 ? `｜${tags.join('、')}` : ''}】`
}

/**
 * 摘要正文的硬约束：时间范围 + 标签并集由本地补上，模型只负责正文。
 * 这样即使模型忘了写头部、或自己写了一个格式不对的头部，最终也一定可检索、可读。
 */
export function normalizeSummaryText(raw, entries) {
  if (typeof raw !== 'string') return ''
  const body = cleanInline(raw).replace(/^【[^】]{0,300}】\s*/, '')
  const text = summaryHead(entries) + body
  const chars = Array.from(text)
  return chars.length > SUMMARY_MAX ? `${chars.slice(0, SUMMARY_MAX - 1).join('')}…` : text
}

/** 把 resolve 的原始 JSON 收成白名单形状；action 不合法就当坏结果。 */
export function normalizeResolution(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const action = value.action === 'merge' || value.action === 'replace' || value.action === 'add' || value.action === 'review'
    ? value.action
    : ''
  if (action === '') return null
  const text = typeof value.text === 'string' ? cleanInline(value.text).slice(0, TEXT_MAX) : ''
  const reason = typeof value.reason === 'string' ? cleanInline(value.reason).slice(0, 200) : ''
  return {
    action,
    ...(text === '' ? {} : { text }),
    ...(reason === '' ? {} : { reason }),
  }
}

/**
 * 创建记忆整理器。
 *
 * @param {object} ctx 宿主 context：只通过 `ctx.get('llm')` 取服务。
 * @param {object} options `{ enabled, provider, model, timeoutMs, llm }`；
 *   `llm` 仅用于测试注入，正常运行时留空即可。
 */
/**
 * 「整理记忆」的系统提示。
 *
 * 为什么需要它：模型自觉写入的记忆会带噪音——同一件事说两遍、把一次性的
 * 临时状态也记下来、句子长到读不透。这个整理只做三件事：
 *   1. 丢：明显没价值的（寒暄、临时状态、重复到没有信息量的）
 *   2. 并：同一件事的多条并成一条（保留最新、最具体的信息）
 *   3. 不写新的：整理不等于再创作，不许凭空补内容
 * 输出严格 JSON，id 一律照抄输入，方便回填。
 */
/**
 * 整理的输出预算：一次要吐出「丢哪些 id + 并哪几组」，比裁决/摘要长得多，
 * 用 RESOLVE 的量级会被截断（真机上就是这么失败的）。给到 2000。
 */
const ORGANIZE_MAX_TOKENS = 3000

const ORGANIZE_SYSTEM = [
  '你是记忆库的整理员，只做去重与精简，不创作。',
  '给你一批记忆条目（id / 文本 / 标签）。请返回 JSON：',
  '{"drop":[id...],"merge":[{"ids":[id...],"text":"合并后的那一句"}]}',
  '规则：',
  '- drop 只放真正没价值的：寒暄、一次性的临时状态、语义重复到没有新信息的；',
  '- merge 只并真正同一件事的条目，合并文本要保留原句里的具体信息（数字、文件名、结论）；',
  '- 拿不准就留着——错的删减比缺失更糟；',
  '- 不许出现输入里没有的 id，不许把不同主题硬并。',
  '- 没有可处理的就返回 {"drop":[],"merge":[]}。',
].join('\n')

export function createMemoryLlm(ctx, options = {}) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const source = settings.llm ?? readLlm(ctx)
  const enabled = settings.enabled !== false
  const configuredProvider = typeof settings.provider === 'string' ? settings.provider.trim() : ''
  const configuredModel = typeof settings.model === 'string' ? settings.model.trim() : ''
  const timeoutMs = resolveTimeoutMs(settings.timeoutMs)

  let provider = configuredProvider
  let model = configuredModel
  let lastError = null
  let disposed = false
  let targetPromise = null
  const activeControllers = new Set()

  const fail = (message) => {
    lastError = typeof message === 'string' && message !== '' ? message : 'LLM 调用失败'
    return null
  }

  // provider 是同步可解析的：先拿第一个，后面再补 model。
  if (provider === '' && source !== null && source !== undefined && typeof source.listProviders === 'function') {
    try {
      const list = source.listProviders()
      if (Array.isArray(list)) {
        for (const entry of list) {
          const id = providerIdOf(entry)
          if (id !== '') {
            provider = id
            break
          }
        }
      }
    } catch (error) {
      fail(`读取 LLM provider 列表失败：${error?.message ?? error}`)
    }
  }

  /** 解析 provider/model；只跑一次。 */
  function ready() {
    if (targetPromise !== null) return targetPromise
    targetPromise = (async () => {
      if (source === null || source === undefined || typeof source.stream !== 'function') {
        fail('没有可用的 LLM 服务（宿主未提供 llm）')
        return
      }
      if (enabled !== true) {
        fail('云端记忆整理已关闭')
        return
      }
      if (provider === '') {
        if (lastError === null) fail('没有可用的 LLM provider')
        return
      }
      if (model === '' && typeof source.listModels === 'function') {
        let models = []
        try {
          models = await source.listModels(provider)
        } catch (error) {
          fail(`读取 ${provider} 的模型列表失败：${error?.message ?? error}`)
          return
        }
        for (const entry of Array.isArray(models) ? models : []) {
          const id = modelIdOf(entry)
          if (id !== '') {
            model = id
            break
          }
        }
      }
      if (model === '') {
        if (lastError === null) fail(`${provider} 没有可用模型`)
        return
      }
      lastError = null
    })().catch((error) => {
      fail(`解析 LLM provider/model 失败：${error?.message ?? error}`)
    })
    return targetPromise
  }

  /** 是否值得尝试调用：服务在、开关开、provider 已解析。model 可能还在异步解析。 */
  function canCall() {
    return disposed !== true && enabled === true && source !== null && source !== undefined && provider !== ''
      && typeof source.stream === 'function'
  }

  /** 真实的可用性：provider/model 都解析成功才算可用。 */
  function isAvailable() {
    return disposed !== true && enabled === true && source !== null && source !== undefined
      && provider !== '' && model !== '' && typeof source.stream === 'function'
  }

  /**
   * 带限流重试的调用入口。
   *
   * 免费模型报 429 很常见，直接失败会让「整理记忆」这类操作看起来像坏了。
   * 这里按 2–10 秒退避重试，超过窗口期才认输（返回 null，lastError 留最后一条）。
   */
  async function runText(system, user, maxTokens) {
    if (disposed === true) return fail('记忆整理器已释放')
    await ready()
    if (isAvailable() !== true) return null
    const deadline = Date.now() + RATE_LIMIT_WINDOW_MS
    let attempt = 0
    for (;;) {
      attempt += 1
      const text = await runTextOnce(system, user, maxTokens)
      if (text !== null) return text
      if (isRateLimitError(lastError) !== true) return null
      const left = deadline - Date.now()
      if (left <= RATE_LIMIT_MIN_MS) return null
      const wait = Math.min(
        RATE_LIMIT_MAX_MS,
        RATE_LIMIT_MIN_MS + Math.floor(Math.random() * (RATE_LIMIT_MAX_MS - RATE_LIMIT_MIN_MS)),
        left,
      )
      await new Promise((resolve) => setTimeout(resolve, wait))
      if (disposed === true) return null
    }
  }

  /** 单次流式调用：超时 / 异常 / 截断一律 null。 */
  async function runTextOnce(system, user, maxTokens) {
    const controller = new AbortController()
    activeControllers.add(controller)
    let timer = null
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          controller.abort()
        } catch {
          // 已经结束的流再 abort 也没关系
        }
        reject(new Error(`LLM 超时（${timeoutMs}ms）`))
      }, timeoutMs)
    })
    const collect = (async () => {
      let text = ''
      const stream = source.stream({
        provider,
        model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        maxTokens,
        temperature: 0.2,
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (chunk === null || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text
          continue
        }
        if (chunk.type !== 'finish') continue
        const kind = chunk.reason?.kind
        if (kind === 'error' || kind === 'aborted') {
          throw new Error(chunk.reason?.failure?.message ?? 'LLM 调用失败')
        }
        if (kind === 'max-tokens') throw new Error('LLM 输出被 token 上限截断')
      }
      return text
    })()
    // 超时先到后 collect 仍可能稍后 reject；先挂一个空 catch，避免未处理拒绝。
    collect.catch(() => {})
    try {
      const text = await Promise.race([collect, timeout])
      lastError = null
      return text
    } catch (error) {
      return fail(error?.message ?? String(error))
    } finally {
      if (timer !== null) clearTimeout(timer)
      activeControllers.delete(controller)
    }
  }

  /** 调用 + 从输出里抠 JSON；任何一步失败都返回 null。 */
  async function callJson(system, user, maxTokens) {
    const text = await runText(system, user, maxTokens)
    if (text === null) return null
    const parsed = extractJson(text)
    if (parsed === null) return fail('LLM 返回的不是可解析的 JSON')
    return parsed
  }

  async function judge(text) {
    const content = cleanInline(text).slice(0, TEXT_MAX)
    if (content === '') return null
    const parsed = await callJson(JUDGE_SYSTEM, JSON.stringify({ text: content }), JUDGE_MAX_TOKENS)
    if (parsed === null) return null
    const normalized = normalizeJudgement(parsed)
    if (normalized === null) return fail('LLM 分层结果不合法')
    return normalized
  }

  async function summarize(items) {
    const list = (Array.isArray(items) ? items : [])
      .filter((item) => item !== null && typeof item === 'object')
      .slice(0, 40)
    if (list.length === 0) return null
    const payload = list.map((item) => ({
      created: String(item.created ?? '').slice(0, 10),
      tags: Array.isArray(item.tags) ? item.tags.slice(0, SUMMARY_TAG_MAX) : [],
      text: cleanInline(item.text).slice(0, TEXT_MAX),
    }))
    const parsed = await callJson(SUMMARIZE_SYSTEM, JSON.stringify(payload), SUMMARIZE_MAX_TOKENS)
    if (parsed === null) return null
    if (typeof parsed.summary !== 'string') return fail('LLM 摘要结果不合法')
    // 只有头部（或全空白）等于没压缩，宁可回退规则，也不写一条空摘要。
    const body = cleanInline(parsed.summary).replace(/^【[^】]{0,300}】\s*/, '')
    if (body === '') return fail('LLM 摘要为空')
    const summary = normalizeSummaryText(parsed.summary, list)
    if (summary === '') return fail('LLM 摘要为空')
    return { summary }
  }

  async function resolve(existing, candidate) {
    const left = existing !== null && typeof existing === 'object' ? existing : {}
    const right = candidate !== null && typeof candidate === 'object' ? candidate : {}
    const existingText = cleanInline(left.text).slice(0, TEXT_MAX)
    const candidateText = cleanInline(right.text).slice(0, TEXT_MAX)
    if (existingText === '' || candidateText === '') return null
    const payload = {
      existing: { text: existingText, tags: Array.isArray(left.tags) ? left.tags.slice(0, SUMMARY_TAG_MAX) : [] },
      candidate: { text: candidateText, tags: Array.isArray(right.tags) ? right.tags.slice(0, SUMMARY_TAG_MAX) : [] },
    }
    const parsed = await callJson(RESOLVE_SYSTEM, JSON.stringify(payload), RESOLVE_MAX_TOKENS)
    if (parsed === null) return null
    const normalized = normalizeResolution(parsed)
    if (normalized === null) return fail('LLM 冲突裁决结果不合法')
    return normalized
  }

  /** 整理一批记忆：只丢废条、并同义条，不新增。 */
  async function organize(entries) {
    const list = (Array.isArray(entries) ? entries : [])
      .map((entry) => ({
        id: typeof entry?.id === 'string' ? entry.id : '',
        text: cleanInline(entry?.text).slice(0, TEXT_MAX),
        tags: Array.isArray(entry?.tags) ? entry.tags.slice(0, SUMMARY_TAG_MAX) : [],
      }))
      .filter((entry) => entry.id !== '' && entry.text !== '')
    if (list.length === 0) return null
    const parsed = await callJson(ORGANIZE_SYSTEM, JSON.stringify({ entries: list }), ORGANIZE_MAX_TOKENS)
    if (parsed === null) return null
    const known = new Set(list.map((entry) => entry.id))
    const drop = (Array.isArray(parsed.drop) ? parsed.drop : [])
      .filter((id) => typeof id === 'string' && known.has(id))
    const merge = []
    for (const group of Array.isArray(parsed.merge) ? parsed.merge : []) {
      const ids = (Array.isArray(group?.ids) ? group.ids : [])
        .filter((id) => typeof id === 'string' && known.has(id))
      const text = cleanInline(group?.text).slice(0, TEXT_MAX)
      // 至少两条才叫"合并"，一条只是改写法，不该由整理包办。
      if (ids.length >= 2 && text !== '') merge.push({ ids, text })
    }
    return { drop, merge }
  }

  async function status() {
    await ready()
    return {
      available: isAvailable(),
      provider: provider === '' ? '' : provider,
      model: model === '' ? '' : model,
      lastError,
    }
  }

  return {
    get available() { return isAvailable() },
    get provider() { return provider },
    get model() { return model },
    get lastError() { return lastError },
    get timeoutMs() { return timeoutMs },
    ready,
    canCall,
    status,
    judge,
    summarize,
    resolve,
    organize,
    dispose() {
      disposed = true
      for (const controller of activeControllers) {
        try {
          controller.abort()
        } catch {
          // 已经结束的流
        }
      }
      activeControllers.clear()
    },
  }
}

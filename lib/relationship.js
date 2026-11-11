/**
 * 昔涟 · 关系与情绪
 *
 * 也是纯函数层：给定「这一轮用户说了什么、她回了什么」，算出
 * 这一刻的情绪、关系走到了哪、以及下一轮该关心什么。
 *
 * 来源：
 * - `detectUserMood` / 关系信号 / 每日摘要 / nextCareCue：移植自
 *   Cyrene-Agent `src/main/relationship/relationship-log.ts`（MIT）。
 * - 多维情绪环与衰减：参照 xilian 的 `core/emotion_loop.py`——情绪是
 *   若干条并行衰减的环，不是单一标签，所以「刚被夸完」和「一直很开心」
 *   是两种不同的状态。
 *
 * 这一层刻意不写任何「她会因此改变性格」的规则：情绪只影响
 * 语气浓度与记忆加权，人格正文始终由人格 section 决定（实施单 §5.1）。
 */

/** 情绪维度。值域 0..1，独立衰减，取最高者为主导情绪。 */
export const EMOTION_DIMENSIONS = ['joy', 'sadness', 'anger', 'anxiety', 'fatigue', 'affection']

export const EMOTION_LABELS = {
  joy: '开心',
  sadness: '低落',
  anger: '恼火',
  anxiety: '焦虑',
  fatigue: '疲惫',
  affection: '亲近',
}

/** 每轮回落后，没被再次激发的情绪按这个系数衰减（约 8 轮掉一半）。 */
const EMOTION_DECAY = 0.92
/** 单个维度单轮最多涨这么多，防止一句话把情绪顶满。 */
const EMOTION_GAIN_CAP = 0.55

/**
 * 用户情绪识别：正则优先，宁可漏判也不要误伤。
 *
 * 「明确边界」这类表达要单独识别——用户说「别问了」不是生气，
 * 是在设定交互边界，把它当成 anger 会让之后每一轮都变得小心翼翼。
 */
export function detectUserMood(text) {
  const s = String(text ?? '')
  if (/累|疲惫|困|没精神|撑不住|倦|熬夜|通宵/.test(s)) return '疲惫'
  if (/影响观感|太影响|不要.{0,4}(确认|弹|问|卡片)|别.{0,4}(问|弹|确认|卡片)|少问|别问了/.test(s)) return '明确边界'
  if (/焦虑|压力|烦|崩|紧张|担心|慌|来不及/.test(s)) return '焦虑'
  if (/难过|伤心|委屈|失落|想哭|emo|崩溃/.test(s)) return '低落'
  if (/开心|高兴|舒服|喜欢|好耶|太好了|爽|棒/.test(s)) return '开心'
  if (/生气|气死|火大|无语|离谱/.test(s)) return '恼火'
  return '未知'
}

/** 情绪词 → 维度增量。刻意保守：一句话只点亮一两个维度。 */
export function moodToEmotions(mood, intensity = 0.5) {
  const k = Math.min(1, Math.max(0, Number(intensity)))
  switch (mood) {
    case '开心':
      return { joy: 0.6 * k, affection: 0.25 * k }
    case '低落':
      return { sadness: 0.6 * k }
    case '焦虑':
      return { anxiety: 0.6 * k }
    case '疲惫':
      return { fatigue: 0.55 * k }
    case '恼火':
      return { anger: 0.55 * k, sadness: 0.15 * k }
    case '明确边界':
      return { anxiety: 0.15 * k }
    default:
      return { affection: 0.08 * k }
  }
}

/** 空情绪环。 */
export function emptyEmotions() {
  const out = {}
  for (const dim of EMOTION_DIMENSIONS) out[dim] = 0
  return out
}

/**
 * 推进一轮情绪：先整体衰减，再叠加本轮增量，最后夹到 0..1。
 * 返回新的环与主导情绪。
 */
export function stepEmotions(previous, increments = {}, options = {}) {
  const decay = Number.isFinite(Number(options.decay)) ? Number(options.decay) : EMOTION_DECAY
  const next = {}
  for (const dim of EMOTION_DIMENSIONS) {
    const base = Number(previous?.[dim] ?? 0) * decay
    const gain = Math.min(EMOTION_GAIN_CAP, Math.max(0, Number(increments?.[dim] ?? 0)))
    next[dim] = Math.min(1, Math.max(0, base + gain))
  }
  return { emotions: next, dominant: dominantEmotion(next) }
}

/** 主导情绪：取最大维度；全都低于阈值时算「平静」。 */
export function dominantEmotion(emotions) {
  let best = null
  let bestValue = 0.25
  for (const dim of EMOTION_DIMENSIONS) {
    const value = Number(emotions?.[dim] ?? 0)
    if (value > bestValue) {
      best = dim
      bestValue = value
    }
  }
  return best === null ? { dimension: null, label: '平静', intensity: 0 } : { dimension: best, label: EMOTION_LABELS[best], intensity: bestValue }
}

/**
 * 关系信号：这一轮把她和用户之间的距离拉近还是推远。
 *
 * affinity 是「亲密度」、trust 是「信任」，两者分开加：
 * 一起吐槽能拉亲近度但未必加信任；说到做到才加信任。
 */
export function deriveSignal(userText, mood) {
  const s = String(userText ?? '')
  if (/谢谢|感谢|辛苦了|厉害|棒|爱你|喜欢你|抱抱/.test(s)) {
    return { signal: '亲近', affinity: 1.2, trust: 0.6, reason: '道谢或夸奖' }
  }
  if (/对不起|抱歉|不好意思/.test(s)) {
    return { signal: '修复', affinity: 0.4, trust: 0.8, reason: '道歉' }
  }
  if (mood === '低落' || mood === '疲惫') {
    return { signal: '需要陪伴', affinity: 0.8, trust: 0.4, reason: '状态不太好' }
  }
  if (mood === '恼火' || mood === '明确边界') {
    return { signal: '需要空间', affinity: -0.3, trust: 0.3, reason: '划了边界' }
  }
  if (/记住|别忘了|一定要|重要/.test(s)) {
    return { signal: '托付', affinity: 0.6, trust: 1.2, reason: '交代了要做的事' }
  }
  return { signal: '平稳', affinity: 0.1, trust: 0.05, reason: '' }
}

/** 关系状态初值。familiarity 只涨不跌：认识越久越熟。 */
export function emptyRelationship(now = Date.now()) {
  return {
    affinity: 20,
    trust: 20,
    familiarity: 0,
    turns: 0,
    streakDays: 0,
    lastSeen: '',
    firstSeen: '',
    lastMood: '未知',
    dominant: { dimension: null, label: '平静', intensity: 0 },
    emotions: emptyEmotions(),
    nextCareCue: '',
    updatedAt: now,
  }
}

/** 本地日期（YYYY-MM-DD），按用户时区而不是 UTC。 */
export function localDate(ts = Date.now()) {
  const d = new Date(ts)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * 记一轮：更新情绪环、关系数值、接触日期与「下次该关心什么」。
 *
 * 所有数值都夹在 0..100，且单轮增量很小——关系是慢慢变的，
 * 一次对话就「满好感」是不真实的，也会让她下一轮的语气失真。
 */
export function recordTurn(previous, turn = {}, options = {}) {
  const now = options.now ?? Date.now()
  const base = { ...emptyRelationship(now), ...(previous ?? {}) }
  const mood = turn.mood ?? detectUserMood(turn.userText)
  const signal = turn.signal ?? deriveSignal(turn.userText, mood)
  const stepped = stepEmotions(base.emotions, moodToEmotions(mood, turn.intensity ?? 0.6), {
    decay: options.decay,
  })

  const today = localDate(now)
  const lastSeen = base.lastSeen === '' ? today : base.lastSeen
  const isNewDay = lastSeen !== today
  const familiarityGain = isNewDay ? 1 : 0.15

  const next = {
    ...base,
    affinity: clamp100(base.affinity + signal.affinity + (mood === '开心' ? 0.3 : 0)),
    trust: clamp100(base.trust + signal.trust),
    familiarity: clamp100(base.familiarity + familiarityGain),
    turns: Number(base.turns ?? 0) + 1,
    lastSeen: today,
    firstSeen: base.firstSeen === '' ? today : base.firstSeen,
    lastMood: mood,
    emotions: stepped.emotions,
    dominant: stepped.dominant,
    nextCareCue: nextCareCue(mood, signal, turn.userText),
    updatedAt: now,
  }
  next.streakDays = computeStreak(base.lastSeen, today, base.streakDays)
  return next
}

/** 连续天数：隔一天算断，但也可能只是没说话——所以用「上次日期」推。 */
export function computeStreak(lastSeen, today, previousStreak = 0) {
  if (lastSeen === '' || today === '') return 1
  if (lastSeen === today) return Math.max(1, previousStreak)
  const last = Date.parse(`${lastSeen}T00:00:00`)
  const now = Date.parse(`${today}T00:00:00`)
  if (Number.isNaN(last) || Number.isNaN(now)) return previousStreak
  const gap = Math.round((now - last) / 86_400_000)
  if (gap === 1) return Number(previousStreak) + 1
  if (gap <= 0) return Math.max(1, previousStreak)
  return 1
}

function nextCareCue(mood, signal, userText) {
  const s = String(userText ?? '')
  if (/睡|熬夜|通宵/.test(s)) return '下轮先问一句睡够没有，别急着干活'
  if (mood === '疲惫') return '下轮别加活，先让她歇一口气'
  if (mood === '低落') return '下轮语气放缓，少讲道理'
  if (mood === '焦虑') return '下轮先给结论，再给步骤'
  if (mood === '明确边界') return '下轮少问、少确认，直接给结果'
  if (/记住|别忘了|一定要/.test(s)) return '这件事下次要主动提'
  if (signal.signal === '亲近') return '可以更放松一点，但别过头'
  return ''
}

/**
 * 关系注入正文。只写「怎么相处」，不写「你是什么性格」——
 * 后者是人格 section 的事，这里越界就会把她写成另一个人。
 */
export function buildRelationshipText(state, options = {}) {
  if (state === null || state === undefined) return ''
  if (options.enabled === false) return ''
  const dominant = state.dominant ?? { label: '平静', intensity: 0 }
  const lines = [
    '',
    '【昔涟 · 你和他现在的关系】',
  ]
  const stage = relationshipStage(state)
  lines.push(`- 相处阶段：${stage.label}（${stage.hint}）`)
  lines.push(`- 当前情绪：${dominant.label}${dominant.intensity >= 0.4 ? '，比较明显' : ''}`)
  if (typeof state.lastMood === 'string' && state.lastMood !== '未知') {
    lines.push(`- 他上一轮的状态：${state.lastMood}`)
  }
  if (typeof state.nextCareCue === 'string' && state.nextCareCue !== '') {
    lines.push(`- 这一轮可以留意：${state.nextCareCue}`)
  }
  lines.push('这些只影响你说话的温度，不改变你是谁、怎么称呼他、有哪些口头禅。')
  return lines.join('\n')
}

/** 阶段只看亲密度与轮次，两个信号都到才算升级，避免聊两句就「很熟」。 */
export function relationshipStage(state) {
  const affinity = Number(state?.affinity ?? 0)
  const turns = Number(state?.turns ?? 0)
  if (affinity >= 75 && turns >= 120) return { key: 'close', label: '很熟了', hint: '可以开玩笑、可以主动提旧事' }
  if (affinity >= 50 && turns >= 40) return { key: 'familiar', label: '熟络', hint: '语气自然放松，能接住梗' }
  if (affinity >= 30 && turns >= 10) return { key: 'warming', label: '在变熟', hint: '可以稍微主动，但别越界' }
  return { key: 'new', label: '刚认识', hint: '礼貌、专注，先把他交代的事做好' }
}

/** 面板/路由用的一行摘要。 */
export function relationshipSummary(state) {
  const stage = relationshipStage(state)
  const dominant = state?.dominant ?? { label: '平静' }
  return `${stage.label} · ${dominant.label} · 第${Number(state?.turns ?? 0)}轮`
}

function clamp100(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(100, Math.max(0, n))
}

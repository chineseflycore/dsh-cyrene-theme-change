/**
 * 昔涟 · 情绪 → Live2D 表情 / 动作映射
 *
 * 这一层是纯函数，不碰 DOM、不碰模型实例：输入是关系管线算出来的
 * `dominant.dimension`（joy / sadness / anger / anxiety / fatigue / affection，
 * null 表示平静），输出是 `{ expression, motion }`，客户端照着播就行。
 *
 * 映射依据是 `assets/cyrene/model/Cyrene.model3.json` 里真实存在的名字：
 * - Expressions：表情回正 / 墨镜 / 问号 / 闪耀 / 星星眼 / 圈圈眼 / 开心眼 / …
 * - Motions：动作#6（0 动作回正、1 Wink~、2 我可爱吧~、3 笑一笑吧~）
 *            Tick3（0 Wink、1 可爱、2 微笑、3 荡秋千）
 *
 * 实施单里给的是「表情 + 动作组」的建议；`表情#2 / 表情2#3 / 表情3#4` 这三组
 * 在 model3.json 里其实只是「换表情」的伪动作（条目没有 File），当 motion 播
 * 不会产生动画。所以这里按实际语义改成了真会动的 `动作#6` / `Tick3`，
 * 对应关系在 README「桌宠与情绪联动」里逐行写明。
 */
import { EMOTION_DIMENSIONS, EMOTION_LABELS } from './host/relationship.js'

export { EMOTION_DIMENSIONS, EMOTION_LABELS }

/** 六维情绪 + 平静的建议表现。 */
export const EMOTION_PRESENTATIONS = {
  joy: { expression: '开心眼', motion: { group: 'Tick3', index: 2 } },
  affection: { expression: '星星眼', motion: { group: '动作#6', index: 2 } },
  sadness: { expression: '圈圈眼', motion: { group: '动作#6', index: 0 } },
  anxiety: { expression: '问号', motion: { group: '动作#6', index: 1 } },
  fatigue: { expression: '圈圈眼', motion: { group: 'Tick3', index: 3 } },
  anger: { expression: '墨镜', motion: { group: '动作#6', index: 0 } },
}

/** 平静（以及认不出来的值）统一回正，动作交给 idle 池。 */
export const NEUTRAL_PRESENTATION = Object.freeze({ expression: '表情回正', motion: null })

/** 主导情绪强度超过这条线才算「强烈」，才值得从平静切过去时抢一次动作。 */
export const STRONG_EMOTION_INTENSITY = 0.4

/** 情绪维度白名单。 */
export function isKnownEmotion(dimension) {
  return EMOTION_DIMENSIONS.includes(dimension)
}

/**
 * 主导情绪 → 表情 / 动作。
 * null、undefined、空串和任何未知值都按「平静」处理；返回的是新对象，
 * 调用方想改也不会污染映射表。
 */
export function pickEmotionPresentation(dimension) {
  if (!isKnownEmotion(dimension)) return { expression: NEUTRAL_PRESENTATION.expression, motion: null }
  const picked = EMOTION_PRESENTATIONS[dimension]
  return {
    expression: picked.expression,
    motion: picked.motion === null ? null : { group: picked.motion.group, index: picked.motion.index },
  }
}

/**
 * 情绪变化时要不要播一次动作。
 *
 * 规则（实施单：phase 动作 > 情绪表情 > idle）：
 * - 只有在「平静 → 非平静」且强度够明显时才播一次动作；
 * - 情绪之间互相切换（比如开心 → 低落）只换表情，不抢正在播的思考 / 工具动作；
 * - 回到平静也不播，只把表情回正。
 */
export function shouldPlayEmotionMotion(previousDimension, nextDimension, intensity = 0) {
  if (previousDimension !== null && previousDimension !== undefined) return false
  if (!isKnownEmotion(nextDimension)) return false
  const value = Number(intensity)
  return Number.isFinite(value) && value >= STRONG_EMOTION_INTENSITY
}

/** 情绪的一行中文名（面板「当前情绪」只读行用）。 */
export function emotionLabel(dimension) {
  return isKnownEmotion(dimension) ? EMOTION_LABELS[dimension] : '平静'
}

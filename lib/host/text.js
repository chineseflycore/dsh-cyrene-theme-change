/**
 * 框架注入的「假用户消息」。
 *
 * 宿主会把运行时上下文、时间戳、后台任务通知当成 user/message 发进事件流
 * （例如 "Time sampled while preparing turn 201…"、"background job bash-…"）。
 * 这些不是用户说的话，却被「每轮自动记一条」记进了记忆库——真机上 26 条记忆
 * 里有 17 条是这种东西，把真正的对话淹没了。
 *
 * 两道防线：
 *   1. 优先看事件自带的 source.kind，只认 'user'；
 *   2. 拿不到 source 时退回前缀匹配（兼容老形状）。
 */
const INJECTED_PREFIXES = [
  /^Time sampled while preparing/iu,
  /^background job /iu,
  /^Current runtime context/iu,
  /^The available skill catalog changed/iu,
  /^<system-reminder>/iu,
]

export function looksInjected(text) {
  const value = String(text ?? '').trim()
  if (value === '') return true
  return INJECTED_PREFIXES.some((pattern) => pattern.test(value))
}

const AUTO_CAPTURE_MIN_CHARS = 6
const AUTO_CAPTURE_SKIP = /^(ok|okay|好的|好|嗯+|收到|继续|接着|开始|停|go|yes|no|是|否|谢谢|拜拜)$/iu

export function shouldAutoCapture(text) {
  const value = String(text ?? '').trim()
  if (looksInjected(value)) return false
  if (value.length < AUTO_CAPTURE_MIN_CHARS || value.length > 2000) return false
  if (AUTO_CAPTURE_SKIP.test(value)) return false
  if (value.startsWith('/')) return false
  return true
}

/**
 * 从一条 session 事件里抽纯文本。事件形状随 DSH 版本演进，
 * 所以这里对所有可能的位置都兜一遍——抽不到就安静返回 ''。
 */
export function eventText(event) {
  const blocks = event?.data?.content
  if (!Array.isArray(blocks)) {
    if (typeof event?.data?.text === 'string') return event.data.text
    return ''
  }
  return blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

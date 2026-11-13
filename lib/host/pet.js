/* ────────────────────── 桌宠的活动阶段（Live2D） ──────────────────────
 * 客户端每 5 秒轮询一次 /cyrene/pet，拿到 thinking / tool / done / failed / idle，
 * 用来压过情绪动作与 idle 轮播（阶段动作优先级最高）。
 * 这里只做一件事：把 session/event 投影成这五个词，其它什么都不碰。
 * `done` / `failed` 只亮一小会儿（稍后回 idle），`thinking` / `tool` 超时也回 idle，
 * 免得一次没收到 turn/end 的事件让桌宠永远停在「思考中」。
 */
export const PET_PHASE_DONE_MS = 4000
export const PET_PHASE_ACTIVE_MS = 120000
const petPhase = { phase: 'idle', at: 0 }

export function setPetPhase(phase) {
  petPhase.phase = phase
  petPhase.at = Date.now()
}

/** 把一条 session 事件投影成桌宠阶段；认不出来的类型原样忽略。 */
export function notePetEvent(event) {
  const type = event?.type
  if (type === 'user/message' || type === 'turn/start' || type === 'step/start') {
    setPetPhase('thinking')
    return
  }
  if (type === 'assistant/chunk') {
    const kind = event?.data?.chunk?.type
    const text = event?.data?.chunk?.text
    if ((kind === 'reasoning-delta' || kind === 'text-delta') && typeof text === 'string' && text !== '') {
      setPetPhase('thinking')
    }
    return
  }
  if (type === 'tool/call') {
    setPetPhase('tool')
    return
  }
  if (type === 'tool/result') {
    setPetPhase(event?.data?.error === undefined ? 'thinking' : 'failed')
    return
  }
  if (type === 'assistant/message') {
    setPetPhase('done')
    return
  }
  if (type === 'turn/end') {
    const kind = event?.data?.reason?.kind
    setPetPhase(kind === 'error' ? 'failed' : kind === 'completed' ? 'done' : 'idle')
  }
}

/** 当前对外的阶段：短阶段会过期，长阶段有超时兜底。 */
export function currentPetPhase(now = Date.now()) {
  const age = Math.max(0, now - petPhase.at)
  if (petPhase.phase === 'done' || petPhase.phase === 'failed') {
    return age <= PET_PHASE_DONE_MS ? petPhase.phase : 'idle'
  }
  if (petPhase.phase === 'thinking' || petPhase.phase === 'tool') {
    return age <= PET_PHASE_ACTIVE_MS ? petPhase.phase : 'idle'
  }
  return 'idle'
}

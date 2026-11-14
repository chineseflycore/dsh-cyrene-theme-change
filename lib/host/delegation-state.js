// 委托状态折叠：从 session/event 的 team/member 事件里记「谁在干活、在干什么」。
//
// 只存内存、不落盘：委托状态是会话内的展示信息，重建页面后靠事件重放即可。
// 事件形状（agent-team v2）：{ type: 'team/member', data: { member: { name, description, phase, provider, context } } }

const MAX_MEMBERS = 20

/** name → { name, description, phase, provider, updatedAt } */
const members = new Map()

export function noteTeamEvent(event) {
  if (event === null || typeof event !== 'object') return
  if (event.type !== 'team/member') return
  const member = event.data?.member
  if (member === null || typeof member !== 'object') return
  const name = typeof member.name === 'string' ? member.name.trim() : ''
  if (name === '') return
  members.set(name, {
    name,
    id: typeof member.id === 'string' ? member.id : '',
    description: typeof member.description === 'string' ? member.description : '',
    phase: typeof member.phase === 'string' ? member.phase : 'unknown',
    provider: typeof member.provider === 'string' ? member.provider : '',
    updatedAt: Date.now(),
  })
  if (members.size > MAX_MEMBERS) {
    const oldest = [...members.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0]
    members.delete(oldest.name)
  }
}

/** 给面板/路由的只读快照：最近更新的在前。 */
export function publicDelegations() {
  return {
    members: [...members.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    updatedAt: Date.now(),
  }
}

/**
 * agent/status 折叠：团队只在创建时发 team/member，结束没有事件；
 * 所以用子代理会话自己的 status（running/idle）来更新「在干什么」。
 */
export function noteAgentStatus(sessionId, status) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  for (const [name, member] of members) {
    if (member.id === sessionId) {
      const phase = status === 'running' ? 'running' : status === 'idle' ? 'idle' : member.phase
      if (phase !== member.phase) members.set(name, { ...member, phase, updatedAt: Date.now() })
    }
  }
}

/** 子会话 id → 角色 slug；不是团队成员返回 null。 */
export function slugForSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  for (const member of members.values()) {
    if (member.id === sessionId) return member.name
  }
  return null
}

/** 新模块实例（重启 / HMR）归位。 */
export function resetDelegations() {
  members.clear()
}

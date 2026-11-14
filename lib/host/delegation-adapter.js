// 黄金裔委托的薄适配层（L2）。
//
// 唯一职责：把宿主 experimental 的 agentTeams 服务包成 5 个稳定方法。
// 上层（租约池、路由、面板）只认这 5 个方法，不直接碰宿主 API——
// API 小改只改这个文件。
//
// 注意：spawnTeammate / sendMessage / listMembers / interrupt / waitForChange
// 的第一个参数都是「调用者 agent」，由调用方从 agent 上下文拿，适配器不猜。

const REQUIRED_METHODS = ['spawnTeammate', 'sendMessage', 'listMembers', 'interrupt', 'waitForChange']

/** 探测当前上下文有没有可用的 agentTeams 服务；失败只返回原因，不抛。 */
export function delegationCapability(ctx) {
  let teams
  try {
    teams = typeof ctx?.get === 'function' ? ctx.get('agentTeams') : undefined
  } catch {
    teams = undefined
  }
  if (teams === undefined || teams === null || typeof teams !== 'object') {
    return { available: false, reason: 'agentTeams 服务不存在（profile 未启用 experimental agent-team）' }
  }
  const missing = REQUIRED_METHODS.filter((name) => typeof teams[name] !== 'function')
  if (missing.length > 0) {
    return { available: false, reason: `agentTeams 缺少方法：${missing.join(', ')}` }
  }
  return { available: true, teams }
}

/** 把 agentTeams 包成 5 个稳定方法；teams 由 delegationCapability 给出。 */
export function createDelegationAdapter(teams) {
  return {
    /** 按名字创建一个持久队友。options: { name, description, prompt, context, provider, signal } */
    spawn(agent, options) {
      return teams.spawnTeammate(agent, options)
    },
    /** 给一个队友发消息。options: { target, message, signal } */
    send(agent, options) {
      return teams.sendMessage(agent, options)
    },
    /** 列出当前团队里的成员。 */
    list(agent) {
      return teams.listMembers(agent)
    },
    /** 中断一个队友。 */
    interrupt(agent, target) {
      return teams.interrupt(agent, target)
    },
    /** 等到团队发生变化（或超时）。 */
    wait(agent, timeoutMs, signal) {
      return teams.waitForChange(agent, timeoutMs, signal)
    },
  }
}

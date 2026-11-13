// 记忆整理用的云端 LLM 运行时：按配置取/重建管理器、串行队列、状态出口。
// 管理器是模块级单例；index.js 每次求值时调用 resetMemoryLlm() 归位。

import { createMemoryLlm } from "./memory-llm.js"
import { PACKAGE_ID, sanitizeMemoryLlm, state } from "./state.js"

/* ────────────────────── 记忆整理：云端 LLM（v0.7） ──────────────────────
 * 纯规则之外再挂一层云端模型：分层 / 判重 / 压缩 / 冲突裁决交给它。
 * 三条纪律：
 *  1. **绝不阻塞**：所有调用都进 `memoryLlmChain` 串行队列，调用方只 `void`；
 *  2. **失败即回退**：LLM 返回 null（超时 / 坏 JSON / 没 provider）时，
 *     压缩走 buildSummaryText，冲突走 bestSim >= 0.86 || contained；
 *  3. **配置只增不改**：state.memoryLlm 是新字段，老状态文件读进来自动补默认值。
 */
let memoryLlmManager = null
let memoryLlmManagerKey = ''
let memoryLlmManagerCtx = null
let memoryLlmChain = Promise.resolve()

/** 按当前配置取（或重建）记忆整理器；ctx 换了也重建，避免测试里串上下文。 */
export function memoryLlmFor(ctx) {
  const target = ctx ?? memoryLlmManagerCtx
  if (target === null || target === undefined) return null
  const settings = sanitizeMemoryLlm(state.memoryLlm)
  const key = JSON.stringify([settings.enabled, settings.provider, settings.model, settings.timeoutMs])
  if (memoryLlmManager !== null && memoryLlmManagerKey === key && memoryLlmManagerCtx === target) {
    return memoryLlmManager
  }
  if (memoryLlmManager !== null) {
    try {
      memoryLlmManager.dispose()
    } catch {
      // 旧管理器已经释放
    }
  }
  // 不替用户选模型：settings.model 为空就交给 host 自动解析（首个可用模型），
  // 用户想用好的就用好的，想省钱就用免费档，面板里自己挑。
  memoryLlmManager = createMemoryLlm(target, settings)
  memoryLlmManagerKey = key
  memoryLlmManagerCtx = target
  return memoryLlmManager
}

/** 配置变了：下次取的时候重建；旧的在飞请求一并 abort。 */
export function resetMemoryLlm() {
  if (memoryLlmManager !== null) {
    try {
      memoryLlmManager.dispose()
    } catch {
      // 同上
    }
  }
  memoryLlmManager = null
  memoryLlmManagerKey = ''
  memoryLlmManagerCtx = null
}

/** GET /cyrene/memory/llm 的唯一出口：永远给四个字段，不把异常抛给路由。 */
export async function memoryLlmStatus(ctx) {
  const manager = memoryLlmFor(ctx)
  if (manager === null) {
    return { available: false, provider: '', model: '', lastError: '没有可用的 LLM 服务（宿主未提供 llm）' }
  }
  try {
    const status = await manager.status()
    return {
      available: status.available === true,
      provider: status.provider ?? '',
      model: status.model ?? '',
      lastError: status.lastError ?? null,
    }
  } catch (error) {
    return { available: false, provider: '', model: '', lastError: error?.message ?? String(error) }
  }
}

/** 串行队列：记忆整理一次只跑一个，避免并发写库；任务失败只记日志。 */
export function enqueueMemoryWork(ctx, task) {
  memoryLlmChain = memoryLlmChain.then(task).catch((error) => {
    ctx?.logger?.warn?.(`${PACKAGE_ID}: 云端记忆整理失败（已回退规则）`, error)
    return null
  })
  return memoryLlmChain
}
/** 当前管理器绑定的 ctx（organizeMemories 在没传 ctx 时回落用它）。 */
export function memoryLlmContext() {
  return memoryLlmManagerCtx
}

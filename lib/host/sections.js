// 注入 section 的挂载管理：人格之后的记忆 / 关系 / 世界书三段，各自「先卸再挂」。
// 只依赖 prompt API 与已拆出的数据层；index.js 负责在 apply 里调用。

import { MEMORY_SECTION_NAME, memoryText, relationshipText } from "./memory-store.js"
import { WORLDBOOK_SECTION_NAME, worldbookText } from "./worldbook-runtime.js"

const PERSONA_ORDER_FALLBACK = 100

/**
 * 人格 section 的 order：紧跟部署人格前缀（order 0），
 * 又远早于 PLAN_POLICY(500)，所以既在通用人格之后、又在工具策略之前。
 * 键名在不同 DSH 版本里改过（新版是 DEPLOYMENT_PERSONA_PREFIX，
 * 旧版是 DEPLOYMENT_PERSONA），所以逐个尝试；都取不到就用兜底值。
 */
export function resolvePersonaOrder(prompt) {
  for (const key of ['DEPLOYMENT_PERSONA', 'DEPLOYMENT_PERSONA_PREFIX']) {
    try {
      const order = prompt.getSectionOrder(key)
      if (Number.isFinite(order)) return order + PERSONA_ORDER_FALLBACK
    } catch {
      // 键名不存在就换下一个
    }
  }
  return PERSONA_ORDER_FALLBACK
}
let disposeMemorySection = null

/** 和人格 section 同一套「先卸再挂 + 纯字符串正文」，任何 DSH 版本都成立。 */
export function remountMemory(prompt) {
  if (disposeMemorySection !== null) {
    try {
      disposeMemorySection()
    } catch {
      // 旧 section 已经跟着 fiber 消失
    }
    disposeMemorySection = null
  }
  const text = memoryText()
  if (text === '') return
  disposeMemorySection = prompt.section({
    name: MEMORY_SECTION_NAME,
    order: resolvePersonaOrder(prompt) + 20,
    text,
  })
}
let disposeRelationshipSection = null

/**
 * 关系 section：排在记忆之后 1 位。单独一个 section 是为了让「记得什么」
 * 和「怎么相处」各自可关、各自可查，也方便以后单独调预算。
 */
export function remountRelationship(prompt) {
  if (disposeRelationshipSection !== null) {
    try {
      disposeRelationshipSection()
    } catch {
      // 同上
    }
    disposeRelationshipSection = null
  }
  const text = relationshipText()
  if (text === '') return
  disposeRelationshipSection = prompt.section({
    name: 'cyrene:relationship',
    order: resolvePersonaOrder(prompt) + 21,
    text,
  })
}
let disposeWorldbookSection = null
let mountedWorldbookText = null

/** 和人格、记忆同一套「先卸再挂」，正文为空就不注册；正文没变就不折腾。 */
export function remountWorldbook(prompt) {
  const text = worldbookText()
  if (disposeWorldbookSection !== null && text === mountedWorldbookText) return
  if (disposeWorldbookSection !== null) {
    try {
      disposeWorldbookSection()
    } catch {
      // 旧 section 已经跟着 fiber 消失
    }
    disposeWorldbookSection = null
  }
  mountedWorldbookText = text === '' ? null : text
  if (text === '') return
  disposeWorldbookSection = prompt.section({
    name: WORLDBOOK_SECTION_NAME,
    order: resolvePersonaOrder(prompt) + 10,
    text,
  })
}
// —— 三个 effect 的清理入口：卸载时各清各的，不互相牵连 ——

export function disposeMemorySectionNow() {
  if (disposeMemorySection !== null) {
    try { disposeMemorySection() } catch { /* 交由插件 fiber 回收 */ }
    disposeMemorySection = null
  }
}

export function disposeRelationshipSectionNow() {
  if (disposeRelationshipSection !== null) {
    try { disposeRelationshipSection() } catch { /* 同上 */ }
    disposeRelationshipSection = null
  }
}

export function disposeWorldbookSectionNow() {
  if (disposeWorldbookSection !== null) {
    try { disposeWorldbookSection() } catch { /* 同上 */ }
    disposeWorldbookSection = null
  }
}

/** 新模块实例（重启 / HMR）归位：section 句柄全部作废。 */
export function resetSections() {
  disposeMemorySection = null
  disposeRelationshipSection = null
  disposeWorldbookSection = null
  mountedWorldbookText = null
}

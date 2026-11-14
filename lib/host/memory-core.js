// 记忆通用内核：本体（昔涟）和 12 位黄金裔共用同一套条目清洗 / 召回 / 整理。
//
// 只放纯逻辑，不碰文件系统、不碰插件资源：
// - sanitizeCommonItem：条目字段清洗（分层、成色、向量、钉住）；
// - recallItems：向量余弦 + 2-gram 字面的混合召回；
// - organizeItems：交给 LLM 做 drop / merge 的分批整理。
//
// 存储各自负责：本体在 cyrene-memory.json（memoryStore），角色在
// cyrene-characters/<slug>.json（character-memory.js）。

import { cosine, embed, packVector, unpackVector } from './vector.js'
import { decayWeight, statusOf, tokenize, similarity, weightToImportance } from './cognitive.js'

export const ITEM_TEXT_MAX = 600
export const ITEM_TAG_MAX = 8

/** 清洗一条记忆的通用字段；坏数据回落到安全默认值，返回 null 表示不可用。 */
export function sanitizeCommonItem(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const text = String(raw.text ?? '').replace(/\s+/g, ' ').trim().slice(0, ITEM_TEXT_MAX)
  if (text === '') return null
  const tags = Array.isArray(raw.tags)
    ? [...new Set(raw.tags.filter((tag) => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean))].slice(0, ITEM_TAG_MAX)
    : []
  const created = typeof raw.created === 'string' && !Number.isNaN(Date.parse(raw.created))
    ? new Date(raw.created).toISOString()
    : new Date().toISOString()
  const id = typeof raw.id === 'string' && /^mem-[a-z0-9-]{4,40}$/i.test(raw.id) ? raw.id : null
  const layer = raw.layer === 'L0' || raw.layer === 'L1' ? raw.layer : 'L2'
  const weight = Number.isFinite(Number(raw.weight)) ? Math.min(1, Math.max(0.05, Number(raw.weight))) : 0.5
  const pinned = raw.pinned === true
  return {
    id,
    text,
    tags,
    created,
    layer,
    weight,
    pinned,
    importance: Number.isInteger(raw.importance) ? Math.min(5, Math.max(1, raw.importance)) : 3,
    vec: typeof raw.vec === 'string' && raw.vec !== '' ? raw.vec : null,
    lastDecay: Number.isFinite(Number(raw.lastDecay)) ? Number(raw.lastDecay) : Date.parse(created),
    accessCount: Number.isFinite(Number(raw.accessCount)) ? Math.max(0, Math.floor(Number(raw.accessCount))) : 0,
  }
}

/**
 * 混合召回：向量余弦懂近义，2-gram 防语义漂移。
 * 条目没有向量时退回纯字面（老数据兼容）。
 */
export function recallItems(items, query, limit = 5) {
  const list = Array.isArray(items) ? items : []
  const text = String(query ?? '').trim()
  if (list.length === 0 || text === '') return []
  const queryVec = embed(text)
  const queryTokens = tokenize(text)
  const scored = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const body = `${item.text ?? ''} ${Array.isArray(item.tags) ? item.tags.join(' ') : ''}`
    const gram = similarity(queryTokens, tokenize(body))
    let score = gram
    if (typeof item.vec === 'string' && item.vec !== '') {
      const vec = unpackVector(item.vec)
      if (vec !== null) score = 0.5 * cosine(queryVec, vec) + 0.5 * gram
    } else if (gram > 0) {
      // 老条目没向量：补算一次，避免每次召回都退化成纯字面。
      item.vec = packVector(embed(item.text))
    }
    if (score <= 0) continue
    scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, Math.max(1, limit)).map(({ item, score }) => ({
    ...item,
    score: Math.round(score * 1000) / 1000,
  }))
}

/**
 * 分批交给 LLM 去重 / 丢弃：每批最多 10 条，某批失败就跳过，不让整次整理前功尽弃。
 * 返回新的 items 数组与统计（不负责落盘）。
 */
export async function organizeItems(items, manager, options = {}) {
  const list = Array.isArray(items) ? items.slice() : []
  const batchSize = Math.max(2, Math.min(20, Number(options.batchSize) || 10))
  const result = { removed: 0, merged: 0, scanned: 0, failed: 0 }
  if (list.length < 2) return { items: list, ...result }
  const byId = new Map(list.map((item) => [item.id, item]))
  for (let offset = 0; offset < list.length; offset += batchSize) {
    const chunk = list.slice(offset, offset + batchSize)
    result.scanned += chunk.length
    const plan = await manager.organize(chunk.map((item) => ({ id: item.id, text: item.text, tags: item.tags })))
    if (plan === null) {
      result.failed += 1
      continue
    }
    for (const id of plan.drop) {
      const index = list.findIndex((item) => item.id === id)
      if (index >= 0) {
        list.splice(index, 1)
        result.removed += 1
      }
    }
    for (const group of plan.merge) {
      const sources = group.ids.map((id) => byId.get(id)).filter((item) => item !== undefined)
      if (sources.length < 2) continue
      const text = String(group.text ?? '').replace(/\s+/g, ' ').trim().slice(0, ITEM_TEXT_MAX)
      if (text === '') continue
      for (const source of sources) {
        const index = list.findIndex((item) => item.id === source.id)
        if (index >= 0) list.splice(index, 1)
      }
      list.unshift({
        id: `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        text,
        tags: ['合并'],
        created: new Date().toISOString(),
        layer: 'L2',
        weight: 0.6,
        pinned: false,
        importance: 3,
        vec: packVector(embed(text)),
        isSummary: true,
        subEntryIds: sources.map((item) => item.id),
      })
      result.merged += sources.length
    }
  }
  return { items: list, ...result }
}

/** 成色衰减：按距上次结算的天数跌成色，和本体同一套 decayWeight。 */
export function decayItems(items, now = Date.now()) {
  const list = Array.isArray(items) ? items : []
  for (const item of list) {
    const next = decayWeight(item, now)
    item.weight = next
    item.status = statusOf(next)
    item.importance = weightToImportance(next)
    item.lastDecay = now
  }
  return list
}

/** 钉住 / 取消钉住：钉住抬到 0.7 保护线以上，取消回到 0.69（和本体一致）。 */
export function pinItem(item, pinned, now = Date.now()) {
  if (item === null || typeof item !== 'object') return false
  item.pinned = pinned === true
  item.weight = item.pinned ? Math.max(Number(item.weight) || 0, 0.7) : Math.min(Number(item.weight) || 0.5, 0.69)
  item.status = statusOf(item.weight)
  item.importance = weightToImportance(item.weight)
  item.lastDecay = now
  return true
}

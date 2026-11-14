// 黄金裔的独立记忆层：每个角色一个文件 + 各自的 768 维向量。
//
// 条目清洗、召回、整理全部走 memory-core（和本体同一套内核）；
// 这个文件只负责「按 slug 读写独立 JSON 文件」。

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { embed, packVector } from './vector.js'
import { decayItems, recallItems, sanitizeCommonItem } from './memory-core.js'
import { classifyLayer } from './cognitive.js'
import { newMemoryId } from './memory-store.js'
import { statePath } from './state.js'

/** 角色记忆目录：和记忆库同目录，单独一个文件夹。 */
export function characterMemoryDir() {
  return join(dirname(statePath()), 'cyrene-characters')
}

function fileFor(slug) {
  return join(characterMemoryDir(), `${slug}.json`)
}

/** 给面板显示用的文件路径。 */
export function characterMemoryPath(slug) {
  return fileFor(slug)
}

/** 记忆条目上限：一个角色自己攒的，别无限长。 */
const MAX_ITEMS = 120

/** 读一个角色的记忆库；文件不存在返回空库，坏文件也退回空库不炸。 */
export async function loadCharacterMemory(slug) {
  const empty = { slug, items: [], enabled: true, updatedAt: 0, error: null }
  if (typeof slug !== 'string' || slug === '') return empty
  let raw
  try {
    raw = await readFile(fileFor(slug), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return empty
    return { ...empty, error: error?.message ?? String(error) }
  }
  try {
    const parsed = JSON.parse(raw)
    const items = []
    for (const entry of Array.isArray(parsed?.items) ? parsed.items : []) {
      const item = sanitizeCommonItem(entry)
      if (item === null) continue
      if (item.id === null) item.id = newMemoryId()
      if (item.vec === null) item.vec = packVector(embed(item.text))
      items.push(item)
    }
    // 读取时结算一次成色（和本体同一套 decayWeight）。
    decayItems(items)
    return {
      slug,
      items: items.slice(0, MAX_ITEMS),
      enabled: parsed?.enabled !== false,
      updatedAt: Number.isFinite(parsed?.updatedAt) ? parsed.updatedAt : 0,
      error: null,
    }
  } catch (error) {
    return { ...empty, error: error?.message ?? String(error) }
  }
}

/** 写一个角色的记忆库（临时文件 + rename，和记忆库同一套纪律）。 */
export async function saveCharacterMemory(slug, items, options = {}) {
  const target = fileFor(slug)
  const next = {
    slug,
    items: items.slice(0, MAX_ITEMS),
    enabled: options.enabled !== false,
    updatedAt: Date.now(),
  }
  await mkdir(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(temp, target)
  return next
}

/** 召回：走通用内核（向量余弦 + 2-gram 混合）。 */
export function recallFromMemory(store, query, limit = 5) {
  return recallItems(store?.items, query, limit)
}

/** 往一个角色的记忆库里加一条（带向量 + 自动分层）；返回新条目。 */
export async function rememberForCharacter(slug, text, tags = [], layer) {
  const clean = String(text ?? '').trim()
  const resolvedLayer = layer === 'L0' || layer === 'L1' || layer === 'L2' ? layer : classifyLayer(clean)
  const item = sanitizeCommonItem({ text, tags, layer: resolvedLayer, weight: 0.6 })
  if (item === null) return null
  item.id = newMemoryId()
  item.vec = packVector(embed(item.text))
  const store = await loadCharacterMemory(slug)
  store.items.unshift(item)
  await saveCharacterMemory(slug, store.items)
  return { id: item.id, text: item.text, tags: item.tags, created: item.created, layer: item.layer }
}

/** 清空一个角色的记忆库（删除文件即可）。 */
export async function forgetAllForCharacter(slug) {
  await rm(fileFor(slug), { force: true })
}

/** 打开 / 关掉某位角色的记忆（关掉只是不读不写，文件不删）。 */
export async function setCharacterMemoryEnabled(slug, enabled) {
  const store = await loadCharacterMemory(slug)
  await saveCharacterMemory(slug, store.items, { enabled: enabled === true })
  return { enabled: enabled === true }
}

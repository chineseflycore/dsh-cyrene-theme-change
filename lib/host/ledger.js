/**
 * 昔涟 · 记忆账本（实施单 §5.2 / §9.4）
 *
 * 账本只证明一件事：**某条记忆写进来时的原文，到现在还是不是那句话**。
 * 它不参与召回、不进提示词，也不改任何记忆内容——所以它坏了不会影响
 * 她记得什么，只会让「有没有丢过」这个问题失去答案。
 *
 * 文件形状（纯映射，没有外层包装，方便人眼和外部脚本直接读）：
 *
 *   {
 *     "mem-abc123": { "sha256": "…64 位十六进制…", "len": 42 },
 *     "mem-def456": { "sha256": "…", "len": 17 }
 *   }
 *
 * 三条纪律（照实施单 §9.4）：
 *  - `init`：对当前库重建账本（第一次用，或明确要重来）；
 *  - `sync`：**只补新 id，老记录绝不覆盖**。合并、手改正文都不会被它抹平，
 *    而是留给 `verify` 报成 mismatched——那正是账本存在的意义；
 *  - `verify`：账本里每个 id 必须仍在库中且哈希一致，否则 ok=false。
 *    库里有、账本没有的新 id 只算「还没入账」，不算错（先 sync 再 verify）。
 *
 * 路径由调用方给：插件用 `$DSH_HOME/cyrene-memory-ledger.json`，
 * 命令行工具允许 `MEM_LEDGER` 覆盖（方便拿一份拷贝做负例测试）。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 和记忆文件放同一个目录，单独一个文件。 */
export const LEDGER_FILE = 'cyrene-memory-ledger.json'

/** 十六进制 sha256 的形状：账本里存的每个摘要都必须长这样。 */
const SHA256_RE = /^[a-f0-9]{64}$/i

/** 记忆正文的指纹（UTF-8、不做任何归一化：改一个空格也会变）。 */
export function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/** 一条记忆 → 账本记录。`len` 按 Unicode 字符数算，和面板显示的字数一致。 */
export function entryRecord(text) {
  const value = String(text ?? '')
  return { sha256: sha256(value), len: Array.from(value).length }
}

/**
 * 把一批条目折成一本新账本（同 id 出现多次时以最后一条为准）。
 * 只读 `id` / `text` 两个字段，别的字段一概不碰。
 */
export function ledgerFromEntries(entries) {
  const ledger = {}
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (id === '') continue
    ledger[id] = entryRecord(entry.text)
  }
  return ledger
}

/**
 * 只补新 id：账本里已经有的记录**一个字节都不改**（实施单 §5.2 的顺序纪律）。
 * 返回新账本与这次补进去的 id，调用方据此决定要不要落盘。
 */
export function mergeLedger(ledger, entries) {
  const base = sanitizeLedger(ledger)
  const next = { ...base }
  const added = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (id === '' || Object.prototype.hasOwnProperty.call(next, id)) continue
    next[id] = entryRecord(entry.text)
    added.push(id)
  }
  return { ledger: next, added }
}

/**
 * 对账：
 *  - `mismatched`：还在库里，但正文被改过（长度或哈希对不上）；
 *  - `missing`：账本里有、库里已经没有的 id；
 *  - `unledgered`：库里有、账本还没收的 id（先 sync 再 verify 就不会有）。
 * `ok` 只看前两项：账本没丢、正文没变。
 */
export function verifyLedger(ledger, entries) {
  const book = sanitizeLedger(ledger)
  const current = ledgerFromEntries(entries)
  const mismatched = []
  const missing = []
  for (const id of Object.keys(book)) {
    if (!Object.prototype.hasOwnProperty.call(current, id)) {
      missing.push(id)
      continue
    }
    if (book[id].sha256 !== current[id].sha256 || book[id].len !== current[id].len) {
      mismatched.push(id)
    }
  }
  const unledgered = Object.keys(current).filter((id) => !Object.prototype.hasOwnProperty.call(book, id))
  return {
    ok: mismatched.length === 0 && missing.length === 0,
    mismatched,
    missing,
    unledgered,
    checked: Object.keys(book).length,
  }
}

/** 读回来的账本先清洗一遍：形状不对的记录直接丢掉，不让它污染对账。 */
export function sanitizeLedger(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, record] of Object.entries(raw)) {
    if (id.trim() === '' || record === null || typeof record !== 'object') continue
    const digest = typeof record.sha256 === 'string' ? record.sha256.trim() : ''
    if (SHA256_RE.test(digest) !== true) continue
    const len = Number(record.len)
    out[id] = { sha256: digest.toLowerCase(), len: Number.isFinite(len) ? Math.max(0, Math.floor(len)) : 0 }
  }
  return out
}

/** 账本里有多少条记录（健康行与工具输出用）。 */
export function ledgerCount(ledger) {
  return Object.keys(sanitizeLedger(ledger)).length
}

/**
 * 读账本文件。文件不存在是正常状态（还没建账本），用 `exists: false` 区分；
 * 读坏了（JSON 不合法 / 权限）返回 `error`，由调用方决定报 BROKEN 还是提示。
 */
export async function readLedgerFile(path) {
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    return { ledger: sanitizeLedger(parsed), exists: true, error: null }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ledger: {}, exists: false, error: null }
    return { ledger: {}, exists: true, error: error?.message ?? String(error) }
  }
}

/** 原子落盘（和记忆文件同一套 tmp + rename）。 */
export async function writeLedgerFile(path, ledger) {
  const book = sanitizeLedger(ledger)
  const target = path
  const temp = `${target}.${process.pid}.tmp`
  await mkdir(dirname(target), { recursive: true })
  await writeFile(temp, `${JSON.stringify(book, null, 2)}\n`, 'utf8')
  await rename(temp, target)
  return book
}

/** `--init`：按当前库重建账本（会覆盖旧账本，只给「明确要重来」的场景用）。 */
export async function initLedgerFile(path, entries) {
  const ledger = ledgerFromEntries(entries)
  await writeLedgerFile(path, ledger)
  return { ledger, count: ledgerCount(ledger) }
}

/**
 * `--sync` / 插件自动同步：只补库里的新 id。
 * 账本文件不存在时等价于 init（第一次写入就把当前库收进来）。
 */
export async function syncLedgerFile(path, entries) {
  const read = await readLedgerFile(path)
  if (read.error !== null) throw new Error(`账本读不出来：${read.error}`)
  const { ledger, added } = mergeLedger(read.ledger, entries)
  if (added.length > 0 || read.exists !== true) {
    await writeLedgerFile(path, ledger)
  }
  return { ledger, added, count: ledgerCount(ledger), created: read.exists !== true }
}

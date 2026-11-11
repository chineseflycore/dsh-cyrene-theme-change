#!/usr/bin/env node
/**
 * 昔涟 · 记忆账本命令行工具（实施单 §5.2 / §9.4）
 *
 *   node tools/memory-ledger.mjs --init     # 第一次：对当前库建账本
 *   node tools/memory-ledger.mjs --sync     # 新记忆补进账本（老记录绝不覆盖）
 *   node tools/memory-ledger.mjs --verify   # 备份前对账；对不上退出码 1
 *
 * 路径：
 *   MEM_DB      覆盖记忆库（默认 $DSH_HOME/cyrene-memory.json，再退 ~/.dsh）
 *   MEM_LEDGER  覆盖账本（默认和记忆库同目录的 cyrene-memory-ledger.json）
 *
 * 顺序纪律：**先 sync 再 verify**。反过来，新写入的记忆会被误报成「还没入账」。
 * verify 只对照账本里已有的 id：正文被改 → mismatched，库里没了 → missing，
 * 两种都算失败（退出码 1）；库里的新 id 只提示「还没入账」，不算失败。
 *
 * 本工具不联网、不写记忆库，只读它、只写账本文件。
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  LEDGER_FILE,
  initLedgerFile,
  readLedgerFile,
  syncLedgerFile,
  verifyLedger,
} from '../lib/host/ledger.js'

const USAGE = [
  '用法：node tools/memory-ledger.mjs <--init|--sync|--verify>',
  '',
  '  --init    对当前记忆库建账本（会覆盖旧账本）',
  '  --sync    只补新 id，老记录绝不覆盖',
  '  --verify  对账；正文被改或库里少了就退出码 1',
].join('\n')

function dataHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

function resolvePaths() {
  const db = typeof process.env.MEM_DB === 'string' && process.env.MEM_DB.trim() !== ''
    ? resolve(process.env.MEM_DB.trim())
    : resolve(join(dataHome(), 'cyrene-memory.json'))
  const ledger = typeof process.env.MEM_LEDGER === 'string' && process.env.MEM_LEDGER.trim() !== ''
    ? resolve(process.env.MEM_LEDGER.trim())
    : resolve(join(dirname(db), LEDGER_FILE))
  return { db, ledger }
}

/** 读记忆库；文件不存在算空库（不为了看一眼就建文件）。 */
async function loadEntries(dbPath) {
  try {
    const parsed = JSON.parse(await readFile(dbPath, 'utf8'))
    const items = Array.isArray(parsed?.items) ? parsed.items : []
    return { items, exists: true, error: null }
  } catch (error) {
    if (error?.code === 'ENOENT') return { items: [], exists: false, error: null }
    return { items: [], exists: true, error: error?.message ?? String(error) }
  }
}

function listIds(ids, limit = 12) {
  if (ids.length <= limit) return ids.join('、')
  return `${ids.slice(0, limit).join('、')} 等 ${ids.length} 条`
}

async function main() {
  const mode = process.argv[2]
  if (mode === '--help' || mode === '-h') {
    console.log(USAGE)
    return 0
  }
  if (mode !== '--init' && mode !== '--sync' && mode !== '--verify') {
    console.error(USAGE)
    return 2
  }

  const { db, ledger: ledgerPath } = resolvePaths()
  const loaded = await loadEntries(db)
  if (loaded.error !== null) {
    console.error(`✗ 记忆库读不出来：${db}\n  ${loaded.error}`)
    return 1
  }
  if (loaded.exists !== true) {
    console.log(`（记忆库还不存在，按空库处理：${db}）`)
  }
  console.log(`记忆库：${db}（${loaded.items.length} 条）`)
  console.log(`账本：  ${ledgerPath}`)

  if (mode === '--init') {
    const result = await initLedgerFile(ledgerPath, loaded.items)
    console.log(`✓ 账本已建立：${result.count} 条`)
    return 0
  }

  if (mode === '--sync') {
    const result = await syncLedgerFile(ledgerPath, loaded.items)
    if (result.added.length > 0) {
      console.log(`✓ 已同步：新增 ${result.added.length} 条（${listIds(result.added)}），账本共 ${result.count} 条`)
    } else {
      console.log(`✓ 没有新记忆，账本仍是 ${result.count} 条`)
    }
    return 0
  }

  // verify：账本必须存在；对不上就退出码 1（备份流程据此中止）。
  const read = await readLedgerFile(ledgerPath)
  if (read.error !== null) {
    console.error(`✗ 账本读不出来：${read.error}`)
    return 1
  }
  if (read.exists !== true) {
    console.error('✗ 还没有账本：先跑一次 --init（之后每次 --sync 补新记忆）')
    return 1
  }
  const report = verifyLedger(read.ledger, loaded.items)
  if (report.ok) {
    const pending = report.unledgered.length > 0 ? `；还有 ${report.unledgered.length} 条新记忆没入账（先 --sync）` : ''
    console.log(`✓ 账本对得上：${report.checked} 条全部一致（库中 ${loaded.items.length} 条）${pending}`)
    return 0
  }
  console.error(`✗ 账本对不上：正文被改 ${report.mismatched.length} 条，库里少了 ${report.missing.length} 条`)
  if (report.mismatched.length > 0) console.error(`  正文被改：${listIds(report.mismatched)}`)
  if (report.missing.length > 0) console.error(`  库里少了：${listIds(report.missing)}`)
  return 1
}

main().then((code) => {
  process.exitCode = code
}).catch((error) => {
  console.error(`✗ 账本操作失败：${error?.message ?? String(error)}`)
  process.exitCode = 1
})

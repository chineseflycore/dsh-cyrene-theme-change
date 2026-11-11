/**
 * 记忆账本 + 每日健康（实施单 §5.2 / §5.3）自检。
 *
 *   node test/host.memory.ledger.spec.mjs
 *
 * 覆盖三块：
 *   1) lib/ledger.js 的纯函数：sha256、init/sync/verify 的语义（老记录绝不覆盖）；
 *   2) tools/memory-ledger.mjs 的真实命令行：--init / --sync / --verify 的退出码与输出；
 *   3) 插件集成：/cyrene/memory/ledger、/cyrene/memory/health、写入后自动补账、
 *      手改正文与删除后的 BROKEN / missing 报法。
 *
 * 所有落盘都在 mkdtemp（TMPDIR 指到 SATA 盘）里，不碰真实的 ~/.dsh。
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  entryRecord,
  initLedgerFile,
  ledgerFromEntries,
  mergeLedger,
  readLedgerFile,
  sha256,
  syncLedgerFile,
  verifyLedger,
} from '../lib/host/ledger.js'

const TOOL = fileURLToPath(new URL('../tools/memory-ledger.mjs', import.meta.url))

let passed = 0
const failures = []
function ok(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail === undefined ? '' : ' → ' + JSON.stringify(detail)}`)
  }
}

// ── 1. 纯函数：指纹与账本语义 ─────────────────────────────────────
ok('sha256 就是标准 SHA-256（已知向量）',
  sha256('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  sha256('abc'))
ok('len 按 Unicode 字符数算（一个汉字算 1）', entryRecord('你好🙂').len === 3, entryRecord('你好🙂'))

const baseLedger = ledgerFromEntries([
  { id: 'mem-aaaa-1', text: '喜欢冰美式' },
  { id: 'mem-bbbb-2', text: '周三去爬山' },
])
ok('init：账本按 id 记 sha256 + len',
  Object.keys(baseLedger).length === 2 && baseLedger['mem-aaaa-1'].sha256 === sha256('喜欢冰美式') &&
    baseLedger['mem-aaaa-1'].len === 5,
  baseLedger['mem-aaaa-1'])

const merged = mergeLedger(baseLedger, [
  { id: 'mem-aaaa-1', text: '改过的正文' },
  { id: 'mem-cccc-3', text: '新增的一条' },
])
ok('sync：只补新 id，老记录绝不覆盖',
  merged.added.length === 1 && merged.added[0] === 'mem-cccc-3' &&
    merged.ledger['mem-aaaa-1'].sha256 === sha256('喜欢冰美式') &&
    Object.keys(merged.ledger).length === 3,
  merged.added)

const clean = verifyLedger(merged.ledger, [
  { id: 'mem-aaaa-1', text: '喜欢冰美式' },
  { id: 'mem-bbbb-2', text: '周三去爬山' },
  { id: 'mem-cccc-3', text: '新增的一条' },
])
ok('verify：全部一致时 ok 且没有 mismatched/missing',
  clean.ok === true && clean.mismatched.length === 0 && clean.missing.length === 0 && clean.checked === 3, clean)

const tampered = verifyLedger(merged.ledger, [
  { id: 'mem-aaaa-1', text: '喜欢冰美式，但改过了' },
  { id: 'mem-cccc-3', text: '新增的一条' },
])
ok('verify：正文被改 → mismatched；库里没了 → missing',
  tampered.ok === false && tampered.mismatched.join() === 'mem-aaaa-1' && tampered.missing.join() === 'mem-bbbb-2',
  tampered)
ok('verify：库里有、账本没有的新 id 只算没入账，不算失败',
  tampered.unledgered.length === 0 && verifyLedger({}, [{ id: 'mem-x', text: 'x' }]).ok === true &&
    verifyLedger({}, [{ id: 'mem-x', text: 'x' }]).unledgered.join() === 'mem-x')

const dirty = verifyLedger({ 'mem-a': { sha256: 'not-a-hash', len: 3 }, 'mem-b': { sha256: sha256('b'), len: 1 } }, [])
ok('坏记录在读取时被丢掉（不参与对账）', dirty.checked === 1 && dirty.missing.join() === 'mem-b', dirty)

// ── 2. 命令行工具：真实退出码与输出 ──────────────────────────────
const toolHome = await mkdtemp(join(tmpdir(), 'cyrene-ledger-tool-'))
const toolDb = join(toolHome, 'cyrene-memory.json')
const toolLedger = join(toolHome, 'cyrene-memory-ledger.json')
await writeFile(toolDb, JSON.stringify({
  enabled: true,
  rev: 1,
  items: [{ id: 'mem-a1b2c', text: '喜欢冰美式', tags: [] }],
}, null, 2), 'utf8')

// Android/Termux 上 process.execPath 指向的是动态链接器（/apex/.../linker64），
// 直接 spawn 它会得到 "bad ELF magic" 或 "expected absolute path"。
// 这种情况退回 PATH 里的 node；其它平台照旧用 execPath（路径最可控）。
const NODE_BIN = /linker64$/.test(process.execPath) ? 'node' : process.execPath

function runTool(args) {
  return new Promise((resolve) => {
    execFile(
      NODE_BIN,
      [TOOL, ...args],
      { env: { ...process.env, MEM_DB: toolDb, MEM_LEDGER: toolLedger }, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr }),
    )
  })
}

const beforeInit = await runTool(['--verify'])
ok('verify 在没有账本时失败（退出码 1）', beforeInit.code === 1 && /还没有账本/.test(beforeInit.stderr),
  [beforeInit.code, beforeInit.stderr])

const init = await runTool(['--init'])
ok('--init 建账本：退出码 0，输出条数', init.code === 0 && /账本已建立：1 条/.test(init.stdout), init)

const verifyOk = await runTool(['--verify'])
ok('--verify：对得上时退出码 0', verifyOk.code === 0 && /账本对得上：1 条/.test(verifyOk.stdout), verifyOk)

// 负例：改一条正文（id 不变）→ sync 不覆盖 → verify 必须报错。
const tamperedDb = JSON.parse(await readFile(toolDb, 'utf8'))
tamperedDb.items[0].text = tamperedDb.items[0].text + 'X'
await writeFile(toolDb, JSON.stringify(tamperedDb, null, 2), 'utf8')
const syncAfterTamper = await runTool(['--sync'])
ok('--sync 不会把改过的老记录盖掉（只补新 id）',
  syncAfterTamper.code === 0 && /没有新记忆/.test(syncAfterTamper.stdout), syncAfterTamper)
const tamperedVerify = await runTool(['--verify'])
ok('负例：正文被改 → verify 退出码 1，并写明被改了几条',
  tamperedVerify.code === 1 && /正文被改 1 条/.test(tamperedVerify.stderr), tamperedVerify)

// 恢复原文 + 新增一条 → sync 补 1 条 → verify 通过。
tamperedDb.items[0].text = '喜欢冰美式'
tamperedDb.items.push({ id: 'mem-d4e5f', text: '下周三开评审会', tags: [] })
await writeFile(toolDb, JSON.stringify(tamperedDb, null, 2), 'utf8')
const syncNew = await runTool(['--sync'])
ok('--sync 把新记忆补进账本（新增 1 条）',
  syncNew.code === 0 && /新增 1 条/.test(syncNew.stdout) && /账本共 2 条/.test(syncNew.stdout), syncNew)
const verifyTwo = await runTool(['--verify'])
ok('先 sync 再 verify 就恢复全绿', verifyTwo.code === 0 && /账本对得上：2 条/.test(verifyTwo.stdout), verifyTwo)

// 删一条 → 账本里的 id 在库里消失 → verify 报 missing。
tamperedDb.items = tamperedDb.items.filter((item) => item.id !== 'mem-d4e5f')
await writeFile(toolDb, JSON.stringify(tamperedDb, null, 2), 'utf8')
const missingVerify = await runTool(['--verify'])
ok('负例：删掉一条 → verify 报「库里少了 1 条」', missingVerify.code === 1 && /库里少了 1 条/.test(missingVerify.stderr),
  missingVerify)

const reinit = await runTool(['--init'])
ok('--init 可以明确重建账本（只给「要重来」的场景）', reinit.code === 0 && /账本已建立：1 条/.test(reinit.stdout), reinit)
ok('重建之后 verify 通过', (await runTool(['--verify'])).code === 0)

const unknown = await runTool(['--nope'])
ok('未知参数：打印用法并退出码 2', unknown.code === 2 && /用法/.test(unknown.stderr), unknown.code)

// 文件级 API：syncLedgerFile 第一次就等价于 init（账本不存在也能补）。
const fileHome = await mkdtemp(join(tmpdir(), 'cyrene-ledger-file-'))
const fileLedger = join(fileHome, 'ledger.json')
const firstSync = await syncLedgerFile(fileLedger, [{ id: 'mem-f1', text: '第一次' }])
ok('syncLedgerFile：账本不存在时自动建，created=true',
  firstSync.created === true && firstSync.count === 1 && (await readLedgerFile(fileLedger)).exists === true)
await initLedgerFile(fileLedger, [{ id: 'mem-f1', text: '第一次' }])
const secondSync = await syncLedgerFile(fileLedger, [{ id: 'mem-f1', text: '第一次' }])
ok('syncLedgerFile：没有新 id 时不重写（added 为空）', secondSync.added.length === 0 && secondSync.count === 1)

// ── 3. 插件集成：路由 + 自动补账 + 健康行 ─────────────────────────
const pluginHome = await mkdtemp(join(tmpdir(), 'cyrene-ledger-plugin-'))
process.env.DSH_HOME = pluginHome
delete process.env.MEM_LEDGER
process.env.CYRENE_CUSTOM_STICKER_DIR = join(pluginHome, 'stickers-custom')
process.env.CYRENE_CUSTOM_BACKGROUND_DIR = join(pluginHome, 'backgrounds-custom')
process.env.CYRENE_NO_REVEAL = '1'
delete process.env.CYRENE_INJECT_MAX_CHARS

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

function makeCtx() {
  const sections = []
  const routes = []
  const tools = new Map()
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) {
      fn()
    },
    systemPrompt: {
      getSectionOrder: () => 0,
      section(spec) {
        const entry = { ...spec, disposed: false }
        entry.dispose = () => { entry.disposed = true }
        sections.push(entry)
        return entry.dispose
      },
    },
    webServer: {
      register(spec) {
        routes.push(spec)
        return () => {}
      },
    },
    on() {
      return () => {}
    },
    get(name) {
      if (name !== 'tools') return undefined
      return {
        register(definition) {
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
      }
    },
  }
  return { ctx, sections, routes, tools }
}

function makeReq(method, path, body) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url: path,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = headers
    },
    end(payload) {
      res.body += payload === undefined ? '' : String(payload)
    },
  }
  return res
}

const box = makeCtx()
const memPath = join(pluginHome, 'cyrene-memory.json')
await writeFile(memPath, JSON.stringify({
  enabled: true,
  rev: 3,
  items: [
    { id: 'mem-old-0001', text: '用户偏好深色主题', tags: ['偏好'], importance: 5, created: '2026-10-01T10:00:00.000Z' },
    { id: 'mem-old-0002', text: '上个月去看了海', tags: ['出行'], importance: 2, created: '2026-09-01T10:00:00.000Z' },
  ],
}, null, 2), 'utf8')

mod.apply(box.ctx)
const started = Date.now()
while (box.routes.length === 0 && Date.now() - started < 2000) {
  await new Promise((resolve) => setTimeout(resolve, 10))
}
await new Promise((resolve) => setTimeout(resolve, 60))

async function route(method, path, body) {
  const res = makeRes()
  await box.routes[0].handler(makeReq(method, path, body), res)
  return { status: res.statusCode, value: res.body === '' ? null : JSON.parse(res.body) }
}

const health0 = await route('GET', '/cyrene/memory/health')
const h0 = health0.value.value
ok('空账本 + 有记忆：健康行 ledger=ABSENT',
  health0.status === 200 && h0.ledger === 'ABSENT' && h0.total === 2 && h0.pinned === 1 && h0.injectCap === 2000 && h0.pending === 0,
  h0)
ok('健康一行格式与实施单 §5.3 对齐',
  /^\[memory\] \d{4}-\d{2}-\d{2} total=2 pinned=1 active=\d+ aging=\d+ archived=\d+ inject_cap=2000 ledger=ABSENT pending=0$/.test(h0.line),
  h0.line)
ok('健康行同时给出结构化字段（date/path/ledgerPath）',
  /^\d{4}-\d{2}-\d{2}$/.test(h0.date) && h0.path.endsWith('cyrene-memory.json') &&
    h0.ledgerPath.endsWith('cyrene-memory-ledger.json'),
  [h0.date, h0.path, h0.ledgerPath])

const ledger0 = await route('GET', '/cyrene/memory/ledger')
ok('还没有账本时 /memory/ledger 的 ok=false、entries=0',
  ledger0.status === 200 && ledger0.value.value.ok === false && ledger0.value.value.entries === 0 &&
    ledger0.value.value.exists === false && Array.isArray(ledger0.value.value.mismatched),
  ledger0.value.value)

// 写一条新记忆：插件应自动补账。
const add = await route('POST', '/cyrene/memory', JSON.stringify({
  rev: 3,
  action: 'add',
  text: '下周三和设计组开评审会',
  tags: '会议',
}))
ok('写入一条新记忆（rev 跟着记忆文件走）', add.status === 200 && add.value.value.count === 3, add.value?.value?.count)

const ledger1 = await route('GET', '/cyrene/memory/ledger')
const l1 = ledger1.value.value
ok('写入后自动补账：账本 3 条、全部对得上',
  l1.ok === true && l1.entries === 3 && l1.mismatched.length === 0 && l1.missing.length === 0 && l1.exists === true,
  l1)
const ledgerFile = JSON.parse(await readFile(l1.ledgerPath, 'utf8'))
ok('账本文件本身就是 { id: { sha256, len } }',
  Object.keys(ledgerFile).length === 3 &&
    Object.values(ledgerFile).every((record) => /^[a-f0-9]{64}$/.test(record.sha256) && Number.isInteger(record.len)),
  Object.keys(ledgerFile))

const health1 = await route('GET', '/cyrene/memory/health')
ok('补账之后健康行 ledger=OK，计数包含新条目',
  health1.value.value.ledger === 'OK' && health1.value.value.total === 3 &&
    /ledger=OK pending=0$/.test(health1.value.value.line),
  health1.value.value.line)

// 手改正文 → reload → 账本必须报 mismatched（sync 不覆盖老记录）。
const onDisk = JSON.parse(await readFile(memPath, 'utf8'))
const changed = onDisk.items.find((item) => item.id === 'mem-old-0001')
changed.text = changed.text + '（手改过）'
await writeFile(memPath, JSON.stringify(onDisk, null, 2), 'utf8')
await route('GET', '/cyrene/memory?reload=1')
const ledger2 = await route('GET', '/cyrene/memory/ledger')
ok('手改正文后 verify 报 mismatched（老记录没被 sync 覆盖）',
  ledger2.value.value.ok === false && ledger2.value.value.mismatched.includes('mem-old-0001'),
  ledger2.value.value)
const health2 = await route('GET', '/cyrene/memory/health')
ok('账本对不上时健康行 ledger=BROKEN', health2.value.value.ledger === 'BROKEN', health2.value.value.line)

// 删除一条 → 账本保留证据，verify 报 missing。
const revNow = (await route('GET', '/cyrene/memory')).value.value.rev
const removed = await route('POST', '/cyrene/memory', JSON.stringify({ rev: revNow, action: 'remove', id: 'mem-old-0002' }))
ok('删掉一条记忆', removed.status === 200 && removed.value.value.count === 2, removed.value?.value?.count)
const ledger3 = await route('GET', '/cyrene/memory/ledger')
ok('删除后账本报 missing（不把删掉的那条悄悄抹掉）',
  ledger3.value.value.missing.includes('mem-old-0002') && ledger3.value.value.mismatched.includes('mem-old-0001'),
  ledger3.value.value)

// 清空：所有账本 id 都成 missing，健康行计数归零。
const revClear = (await route('GET', '/cyrene/memory')).value.value.rev
const cleared = await route('POST', '/cyrene/memory', JSON.stringify({ rev: revClear, action: 'clear' }))
ok('清空全部记忆', cleared.status === 200 && cleared.value.value.count === 0)
const health3 = await route('GET', '/cyrene/memory/health')
ok('清空后健康行 total=0 且账本仍报 BROKEN',
  health3.value.value.total === 0 && health3.value.value.active === 0 &&
    health3.value.value.aging === 0 && health3.value.value.archived === 0 &&
    health3.value.value.ledger === 'BROKEN',
  health3.value.value.line)

// 数据源里的账本没有被插件自动删除：它就该留着「确实清空过」的证据。
const ledgerAfterClear = JSON.parse(await readFile(l1.ledgerPath, 'utf8'))
ok('清空记忆不会删账本文件（证据保留）', Object.keys(ledgerAfterClear).length === 3, Object.keys(ledgerAfterClear))

// ── 汇总 ──────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed}/${passed + failures.length}`)
if (failures.length > 0) {
  console.log(`失败项：${failures.join(' | ')}`)
  process.exitCode = 1
}
assert.equal(failures.length, 0)

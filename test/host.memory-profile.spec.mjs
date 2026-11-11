/**
 * 记忆画像提升自检（v0.7.1）。
 *
 *   node test/host.memory-profile.spec.mjs
 *
 * 覆盖三个真问题：
 *   1. 长自述不再被规则直接塞进 L1：LLM 判 L2 / 判 L1 但字段校验拒绝，两条路都留在 L2；
 *   2. 短句经 LLM 判 L1 可以提升，覆盖旧值时旧值转成 tags:['历史'] 的 L2；
 *   3. 同一字段反复覆盖时历史最多留 3 条，更老的归档；LLM 不可用时仍按规则层降级。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP_ROOT = process.env.CYRENE_TEST_TMP
  || (existsSync('/mnt/Storage1_sda1/dsh/tmp') ? '/mnt/Storage1_sda1/dsh/tmp' : tmpdir())
const home = await mkdtemp(join(TMP_ROOT, 'cyrene-profile-'))
process.env.DSH_HOME = home
delete process.env.MEM_LEDGER
process.env.CYRENE_CUSTOM_STICKER_DIR = join(home, 'stickers-custom')
process.env.CYRENE_CUSTOM_BACKGROUND_DIR = join(home, 'backgrounds-custom')
process.env.CYRENE_NO_REVEAL = '1'

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(check, timeout = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      if ((await check()) === true) return true
    } catch {
      // 条件还没成立，继续等
    }
    await sleep(10)
  }
  return false
}

/**
 * 最小 LLM 服务桩：judgeReply 可在用例间改。
 * 注意 resolve() 也会走同一个 stream，这里返回 judge 形状，正好被当成坏结果
 * 回落到规则（测试不关心冲突裁决）。
 */
let judgeReply = { keep: true, layer: 'L2' }
const llmCalls = []
const llm = {
  providers: [{ id: 'mock-provider' }],
  listProviders() {
    return llm.providers
  },
  async listModels() {
    return [{ id: 'mock-model' }]
  },
  stream(request) {
    llmCalls.push(request)
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: JSON.stringify(judgeReply) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}

function makeCtx() {
  const routes = []
  const tools = new Map()
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    systemPrompt: {
      getSectionOrder: () => 0,
      section(spec) {
        const entry = { ...spec, disposed: false }
        entry.dispose = () => { entry.disposed = true }
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
      if (name === 'llm') return llm
      if (name !== 'tools') return undefined
      return {
        register(definition) {
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
      }
    },
  }
  return { ctx, routes, tools }
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
const mod = await import(new URL('../lib/index.js', import.meta.url).href)
mod.apply(box.ctx)
const ready = await waitFor(() => box.routes.length > 0 && box.tools.has('cyrene_memory_add'))
ok('装载：注册了记忆路由与写入工具', ready === true)

async function route(method, path, body) {
  const handler = box.routes[0].handler
  const res = makeRes()
  await handler(makeReq(method, path, body), res)
  return { status: res.statusCode, value: res.body === '' ? null : JSON.parse(res.body) }
}

async function snapshot() {
  return (await route('GET', '/cyrene/memory')).value.value
}

async function clearMemories() {
  const before = await snapshot()
  const cleared = await route('POST', '/cyrene/memory', JSON.stringify({
    rev: before.rev,
    action: 'clear',
  }))
  assert.equal(cleared.status, 200)
}

const addTool = box.tools.get('cyrene_memory_add')
const forgetTool = box.tools.get('cyrene_memory_forget')
const intro = '用户叫小林，在杭州做后端开发，喜欢美式咖啡'

// ── 1a. 长自述 + LLM 判 L2：留在 L2，不占 currentProject ─────────
judgeReply = { keep: true, layer: 'L2', tags: ['自述'] }
await clearMemories()
const r1a = await addTool.execute({ text: intro })
await waitFor(async () => {
  const value = await snapshot()
  return value.items.some((item) => item.text === intro && item.tags.includes('自述'))
})
const s1a = await snapshot()
ok('长自述 + LLM 判 L2：留在 L2 事件层',
  s1a.items.some((item) => item.text === intro && item.layer === 'L2'), s1a.items.map((item) => [item.layer, item.text]))
ok('长自述 + LLM 判 L2：不写 currentProject',
  s1a.profile.l1.currentProject === undefined, s1a.profile.l1)
ok('长自述 + LLM 判 L2：add 的返回值是 L2',
  r1a.ok === true && r1a.layer === 'L2', r1a)

// ── 1b. 长自述 + LLM 判 L1：字段校验拒绝，仍留在 L2 ─────────────
judgeReply = { keep: true, layer: 'L1', field: 'currentProject', tags: ['项目'] }
await clearMemories()
await addTool.execute({ text: intro })
const rejected = await waitFor(async () => {
  const value = await snapshot()
  return value.items.some((item) => item.text === intro && item.tags.includes('项目'))
})
const s1b = await snapshot()
ok('长自述 + LLM 判 L1：标签仍补上（说明 judge 结果已落地）', rejected === true, s1b.items)
ok('长自述 + LLM 判 L1 但校验拒绝：仍留在 L2，不移动',
  s1b.items.length === 1 && s1b.items[0].layer === 'L2', s1b.items)
ok('长自述 + LLM 判 L1 但校验拒绝：currentProject 不被污染',
  s1b.profile.l1.currentProject === undefined, s1b.profile.l1)

// ── 2. 短句 + LLM 判 L1：正常提升 ────────────────────────────────
judgeReply = { keep: true, layer: 'L1', field: 'currentProject', tags: ['项目'] }
await clearMemories()
const short = '在做一个 DSH 主题插件'
const r2 = await addTool.execute({ text: short })
const promoted = await waitFor(async () => (await snapshot()).profile.l1.currentProject === short)
const s2 = await snapshot()
ok('短句 + LLM 判 L1：提升进 currentProject', promoted === true, s2.profile.l1)
ok('短句提升后事件层不重复留同一条',
  s2.items.every((item) => item.text !== short), s2.items.map((item) => item.text))
ok('短句提升：add 的初始落点是 L2', r2.ok === true && r2.layer === 'L2', r2)

// ── 3. 覆盖旧值前留痕 ───────────────────────────────────────────
judgeReply = { keep: true, layer: 'L1', field: 'currentProject', tags: ['项目'] }
await clearMemories()
const nextProject = '在写一个记忆模块'
await addTool.execute({ text: nextProject })
await waitFor(async () => (await snapshot()).profile.l1.currentProject === nextProject)
const s3 = await snapshot()
const history3 = s3.items.filter((item) => item.historyField === 'l1.currentProject')
ok('覆盖 currentProject：旧值变成一条 L2 历史',
  history3.length === 1 && history3[0].layer === 'L2' && history3[0].text === `（旧）${short}`,
  history3.map((item) => item.text))
ok('历史条目标记 tags:[\'历史\'] 且成色压在 0.4',
  history3[0]?.tags.join('/') === '历史' && Math.abs(history3[0].weight - 0.4) < 1e-9,
  history3[0] === undefined ? null : [history3[0].tags, history3[0].weight])
ok('覆盖后新值进 currentProject', s3.profile.l1.currentProject === nextProject, s3.profile.l1)

// ── 4. 同一字段连续覆盖：历史只留最近 3 条 ──────────────────────
judgeReply = { keep: true, layer: 'L1', field: 'recentGoals' }
await clearMemories()
const goals = ['想学 Rust 语言', '想学 Go 语言', '想学 Zig 语言', '想学 Swift 语言', '想学 Kotlin 语言', '想学 Haskell 语言']
const goalsOk = []
for (const goal of goals) {
  await addTool.execute({ text: goal })
  goalsOk.push(await waitFor(async () => (await snapshot()).profile.l1.recentGoals === goal))
}
const s4 = await snapshot()
const history4 = s4.items.filter((item) => item.historyField === 'l1.recentGoals')
ok('同一字段 6 次写入（5 次覆盖）都提升成功', goalsOk.every(Boolean), goalsOk)
ok('历史条目总数是 5（第一次写没有旧值）', history4.length === 5, history4.length)
ok('历史只留最近 3 条 active，其余 archived',
  history4.filter((item) => item.status === 'active').length === 3 &&
    history4.filter((item) => item.status === 'archived').length === 2,
  history4.map((item) => [item.text, item.status]))

// ── 5. LLM 不可用：按 candidateLayer 降级，行为同 v0.6 ────────────
const turnedOff = await route('POST', '/cyrene/memory/llm', JSON.stringify({
  memoryLlm: { enabled: false, provider: 'mock-provider', model: 'mock-model', timeoutMs: 1000 },
}))
ok('关掉云端整理（LLM 不可用）', turnedOff.status === 200 && turnedOff.value.value.available === false,
  turnedOff.value?.value)
await forgetTool.execute({ id: 'profile-l1-currentProject' })
await clearMemories()
const fallbackText = '最近在做一个 DSH 插件'
const r5 = await addTool.execute({ text: fallbackText })
const s5 = await snapshot()
ok('LLM 不可用：规则层 L1 直接写画像（v0.6 行为）',
  r5.ok === true && r5.layer === 'L1' && s5.profile.l1.currentProject === fallbackText, [r5, s5.profile.l1])
ok('LLM 不可用：不残留同名 L2 事件',
  s5.items.length === 0 && s5.items.every((item) => item.text !== fallbackText), s5.items)

const fallbackNext = '最近在写记忆模块'
await addTool.execute({ text: fallbackNext })
const s5b = await snapshot()
const history5 = s5b.items.filter((item) => item.historyField === 'l1.currentProject')
ok('LLM 不可用的降级分支覆盖旧值时同样留痕',
  history5.some((item) => item.text === `（旧）${fallbackText}` && item.tags.includes('历史')),
  history5.map((item) => item.text))
ok('降级分支的新值仍然写进 currentProject', s5b.profile.l1.currentProject === fallbackNext, s5b.profile.l1)

// ── 汇总 ────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed}/${passed + failures.length}`)
if (failures.length > 0) {
  console.log(`失败项：${failures.join(' | ')}`)
  process.exitCode = 1
}
assert.equal(failures.length, 0)

/**
 * 桌宠（Live2D）宿主半集成测试：真的走 apply() → 路由 / session 事件。
 *
 *   node test/host.live2d.spec.mjs
 *
 * 覆盖：state.pet 默认关闭、rev 写入与落盘、模型 / Cubism Core 字节路由、
 *      路径穿越拒绝、/cyrene/pet 的活动阶段、/cyrene/relationship 里附带的
 *      情绪展示建议（presentation）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'cyrene-live2d-host-'))
process.env.DSH_HOME = home
process.env.CYRENE_CUSTOM_STICKER_DIR = join(home, 'stickers-custom')
process.env.CYRENE_CUSTOM_BACKGROUND_DIR = join(home, 'backgrounds-custom')
process.env.CYRENE_NO_REVEAL = '1'
delete process.env.CYRENE_INJECT_MAX_CHARS

// 素材门槛：这套用例要真的从 assets/cyrene/ 读模型文件。
// 仓库若按"素材不随包分发"的方式打包（或用 git clone 时排除了 assets），
// 这里就明确跳过，而不是报一堆 404——否则任何干净环境都会看到红。
const { statSync } = await import('node:fs')
function hasAssets() {
  try {
    return statSync(new URL('../assets/cyrene/', import.meta.url)).isDirectory()
  } catch {
    return false
  }
}
if (!hasAssets()) {
  console.log('\nSKIP  缺少 assets/cyrene/（素材不随包分发时属正常），跳过 Live2D 宿主用例')
  process.exit(0)
}

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

let passed = 0
const failures = []
async function ok(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail === undefined ? '' : ' → ' + JSON.stringify(detail)}`)
  }
}

function waitFor(check, timeout = 2500) {
  return new Promise((resolve) => {
    const started = Date.now()
    const loop = () => {
      let hit = false
      try {
        hit = check() === true
      } catch {
        hit = false
      }
      if (hit) return resolve(true)
      if (Date.now() - started > timeout) return resolve(false)
      setTimeout(loop, 10)
    }
    loop()
  })
}

function makeCtx() {
  const routes = []
  const listeners = []
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    systemPrompt: {
      getSectionOrder: () => 0,
      section() {
        return () => {}
      },
    },
    webServer: {
      register(spec) {
        routes.push(spec)
        return () => {}
      },
    },
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {}
    },
    get() {
      return undefined
    },
  }
  return { ctx, routes, listeners }
}

function makeReq(method, path, body) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url: path,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    bytes: Buffer.alloc(0),
    body: '',
    writeHead(status, headers) {
      res.statusCode = status
      res.headers = headers
    },
    end(payload) {
      res.bytes = payload === undefined ? Buffer.alloc(0) : Buffer.from(payload)
      res.body = res.bytes.toString('utf8')
    },
  }
  return res
}

const box = makeCtx()
mod.apply(box.ctx)
await waitFor(() => box.routes.length > 0)

async function route(method, path, body) {
  const res = makeRes()
  await box.routes[0].handler(makeReq(method, path, body), res)
  let value = null
  try {
    value = res.body === '' ? null : JSON.parse(res.body)
  } catch {
    value = null
  }
  return { status: res.statusCode, value, body: res.body, bytes: res.bytes, headers: res.headers }
}

const fire = (event) => {
  for (const listener of box.listeners.filter((one) => one.event === 'session/event')) {
    listener.handler({ id: 's1' }, event)
  }
}

console.log(`临时 DSH_HOME = ${home}\n`)

// ── 1. 开关：默认关，写进 state 并落盘 ─────────────────────────────
const state0 = await route('GET', '/cyrene/state')
await ok('state.pet 默认是 false（不和 dsh-cyrene 的桌宠叠在一起）',
  state0.status === 200 && state0.value.value.pet === false, state0.value?.value?.pet)

const rev0 = state0.value.value.rev
const on = await route('POST', '/cyrene/state', JSON.stringify({ rev: rev0, pet: true }))
await ok('POST /cyrene/state 打开桌宠：回传 pet=true、rev+1',
  on.status === 200 && on.value.value.pet === true && on.value.value.rev === rev0 + 1, on.value)

const rawState = JSON.parse(await readFile(join(home, 'cyrene-theme.json'), 'utf8'))
await ok('桌宠开关落到状态文件里（重启后不丢）', rawState.pet === true, rawState.pet)

const off = await route('POST', '/cyrene/state', JSON.stringify({ rev: on.value.value.rev, pet: false }))
await ok('可以再关掉（两个桌宠各自独立）', off.status === 200 && off.value.value.pet === false, off.value?.value?.pet)

// ── 2. 模型 / Cubism Core 字节路由 ─────────────────────────────────
const model = await route('GET', '/cyrene/model/Cyrene.model3.json')
const modelJson = JSON.parse(model.body)
await ok('模型 JSON 从 assets/cyrene/ 发出来，Content-Type 是 JSON',
  model.status === 200 && /application\/json/.test(model.headers['Content-Type'] ?? '') &&
    modelJson.FileReferences?.Moc === 'model.moc3', [model.status, model.headers, model.body.slice(0, 80)])
await ok('moc3 与贴图也在（说明整个目录都拷进来了）',
  (await route('GET', '/cyrene/model/model.moc3')).status === 200 &&
    (await route('GET', '/cyrene/model/texture_0.png')).status === 200)

const core = await route('GET', '/cyrene/live2dcubismcore.min.js')
await ok('Cubism Core 走本包路由，类型是 JavaScript',
  core.status === 200 && /javascript/.test(core.headers['Content-Type'] ?? '') && core.bytes.length > 1000,
  [core.status, core.headers, core.bytes.length])

// 模型 JSON 里的动作文件名带中文和 `#`，浏览器会编码；解码后必须还能取到。
const motionPath = '/cyrene/model/motions/' + encodeURIComponent('动作#6_1.motion3.json')
const motion = await route('GET', motionPath)
await ok('带中文 / # 的动作文件能按 URL 编码取到', motion.status === 200 && motion.body.includes('"Version"'), motion.status)

const traverse = await route('GET', '/cyrene/model/%2e%2e%2f%2e%2e%2fpackage.json')
await ok('路径穿越被拒（只服务 assets/cyrene/ 之下）', traverse.status === 403 || traverse.status === 404, traverse.status)

const missing = await route('GET', '/cyrene/model/nope.json')
await ok('不存在的模型文件回 404', missing.status === 404, missing.status)

// ── 3. 阶段投影：thinking / tool / failed / done / idle ─────────────
await ok('初始阶段是 idle', (await route('GET', '/cyrene/pet')).value.value.phase === 'idle')

fire({ type: 'user/message', data: { content: [{ type: 'text', text: '今天好累啊' }] } })
await ok('用户消息 → thinking', (await route('GET', '/cyrene/pet')).value.value.phase === 'thinking')

fire({ type: 'tool/call', data: { callId: 'c1', name: 'cyrene_memory_search' } })
await ok('工具调用 → tool', (await route('GET', '/cyrene/pet')).value.value.phase === 'tool')

fire({ type: 'tool/result', data: { message: { source: { callId: 'c1' } }, error: { message: 'boom' } } })
await ok('工具失败 → failed', (await route('GET', '/cyrene/pet')).value.value.phase === 'failed')

fire({ type: 'assistant/message', data: { content: [{ type: 'text', text: '那就先歇会儿。' }] } })
await ok('回复完成 → done', (await route('GET', '/cyrene/pet')).value.value.phase === 'done')

fire({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
await ok('turn/end aborted → idle', (await route('GET', '/cyrene/pet')).value.value.phase === 'idle')

// ── 4. 关系里的情绪 + 给桌宠的展示建议 ─────────────────────────────
const rel = await route('GET', '/cyrene/relationship')
const dominant = rel.value.value.dominant
await ok('关系里识别到「疲惫」，并带上 presentation',
  dominant.dimension === 'fatigue' && dominant.presentation?.expression === '圈圈眼' &&
    dominant.presentation?.motion?.group === 'Tick3', dominant)

const pet = await route('GET', '/cyrene/pet')
await ok('/cyrene/pet 也带同一份展示建议（客户端一次轮询就够）',
  pet.value.value.dominant.dimension === 'fatigue' &&
    pet.value.value.dominant.presentation.expression === '圈圈眼', pet.value.value.dominant)

console.log(`\n${failures.length > 0 ? 'FAIL' : 'PASS'}  ${passed}/${passed + failures.length}`)
if (failures.length > 0) process.exitCode = 1

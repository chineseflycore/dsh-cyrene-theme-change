/**
 * 记忆星图（宿主侧）自检。
 *
 *   node test/host.memory.graph.spec.mjs
 *
 * 覆盖：
 *   · 节点：L2 / 摘要 / 画像三种 kind，label 截断，L0·L1 字段各一颗；
 *   · 边：summary / conflict / tag / layer / ref / semantic 六类、
 *     按无向节点对去重、同 tag 只连相邻、语义每节点最多 3 条；
 *   · 上限：300 节点、1200 边（按权重截断）、响应 < 200KB；
 *   · 路由：GET /cyrene/memory/graph 的信封、generatedAt、?reload=1。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  GRAPH_MAX_EDGES,
  GRAPH_MAX_NODES,
  GRAPH_SEMANTIC_PER_NODE,
  buildMemoryGraph,
  graphLabel,
} from '../lib/host/graph.js'

const TMP_ROOT = process.env.CYRENE_TEST_TMP
  || (existsSync('/mnt/Storage1_sda1/dsh/tmp') ? '/mnt/Storage1_sda1/dsh/tmp' : tmpdir())

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

const NOW = Date.parse('2026-11-08T12:00:00.000Z')

/** 一条够用的 L2 记忆（不跑 sanitize，直接喂纯函数）。 */
function mem(id, text, extra = {}) {
  return {
    id,
    text,
    tags: [],
    layer: 'L2',
    weight: 0.5,
    status: 'active',
    pinned: false,
    created: '2026-11-01T12:00:00.000Z',
    ...extra,
  }
}

function edgeOf(graph, a, b, type) {
  return graph.edges.find((edge) => (
    edge.type === type
    && ((edge.a === a && edge.b === b) || (edge.a === b && edge.b === a))
  ))
}

// ── 1. 节点 ─────────────────────────────────────────────────────
console.log('host.memory.graph.spec.mjs\n')

const base = buildMemoryGraph({
  now: NOW,
  items: [
    mem('mem-a', '用户偏好深色主题', { tags: ['偏好'], weight: 0.8 }),
    mem('mem-b', '上个月去看了海', { tags: ['出行'], weight: 0.2, status: 'aging' }),
    mem('mem-s', '【摘要】十月的事', {
      isSummary: true,
      weight: 0.9,
      subEntryIds: ['mem-a', 'mem-b'],
      tags: ['摘要'],
      created: '2026-11-05T12:00:00.000Z',
    }),
  ],
  profile: {
    l0: {
      preferredName: '小满',
      occupation: '前端工程师',
      updatedAt: NOW - 2 * 86_400_000,
    },
    l1: {
      recentGoals: '学完 Transformer',
      updatedAt: NOW - 86_400_000,
    },
  },
})

ok('每条 L2 记忆一颗星，摘要条目的 kind 是 summary',
  base.nodes.filter((node) => node.kind === 'memory').length === 2
  && base.nodes.filter((node) => node.kind === 'summary').length === 1,
  base.nodes.map((node) => [node.id, node.kind]))
ok('L0 / L1 每个画像字段各一颗 kind=profile 的星',
  base.nodes.filter((node) => node.kind === 'profile').length === 3
  && base.nodes.some((node) => node.id === 'profile:l0:preferredName' && node.layer === 'L0')
  && base.nodes.some((node) => node.id === 'profile:l1:recentGoals' && node.layer === 'L1'),
  base.nodes.filter((node) => node.kind === 'profile'))
ok('节点带齐 id/label/kind/layer/weight/created/status/pinned/tags',
  base.nodes.every((node) => (
    typeof node.id === 'string' && node.id !== ''
    && typeof node.label === 'string'
    && ['memory', 'profile', 'summary'].includes(node.kind)
    && ['L0', 'L1', 'L2'].includes(node.layer)
    && Number.isFinite(node.weight)
    && typeof node.created === 'string'
    && ['active', 'aging', 'archived'].includes(node.status)
    && typeof node.pinned === 'boolean'
    && Array.isArray(node.tags)
  )))
ok('label 是正文前 24 字（超出补省略号）',
  graphLabel('一'.repeat(24)) === '一'.repeat(24)
  && graphLabel('一'.repeat(25)) === '一'.repeat(24) + '…',
  graphLabel('一'.repeat(25)))
ok('新鲜度由 created 算出来，越新越大', (() => {
  const a = base.nodes.find((node) => node.id === 'mem-s')
  const b = base.nodes.find((node) => node.id === 'mem-b')
  return a.freshness > b.freshness
})())

// 空库：没有条目、没有画像，图就是一张空图，不能抛也不能造节点。
const emptyGraph = buildMemoryGraph({ now: NOW, items: [], profile: {} })
ok('空库：nodes / edges 都是空数组，计数为 0',
  Array.isArray(emptyGraph.nodes) && emptyGraph.nodes.length === 0
  && Array.isArray(emptyGraph.edges) && emptyGraph.edges.length === 0
  && emptyGraph.stats.nodes === 0 && emptyGraph.stats.edges === 0
  && emptyGraph.stats.droppedNodes === 0 && emptyGraph.stats.droppedEdges === 0,
  emptyGraph.stats)
ok('空库 / 脏输入：null、非对象、空白正文都被跳过，不制造 NaN 节点',
  (() => {
    const dirty = buildMemoryGraph({
      now: NOW,
      items: [null, undefined, 42, {}, { id: 'x', text: '   ' }, { id: 'ok', text: '唯一一条' }],
      profile: { l0: null, l1: 'bad' },
    })
    return dirty.nodes.length === 1
      && dirty.nodes[0].id === 'ok'
      && dirty.nodes.every((node) => Number.isFinite(node.weight) && !Number.isNaN(Date.parse(node.created)))
  })())

// 只有画像、没有事件：节点全是 kind=profile；边只可能来自同层画像之间。
const profileOnly = buildMemoryGraph({
  now: NOW,
  items: [],
  profile: {
    l0: { preferredName: '小满', occupation: '前端工程师', updatedAt: NOW - 2 * 86_400_000 },
    l1: { recentGoals: '学完图论', updatedAt: NOW - 86_400_000 },
  },
})
ok('只有画像没有事件：三颗 profile 星，没有 memory / summary',
  profileOnly.nodes.length === 3
  && profileOnly.nodes.every((node) => node.kind === 'profile')
  && profileOnly.stats.memories === 0
  && profileOnly.stats.profiles === 3,
  profileOnly.nodes.map((node) => [node.id, node.kind]))
ok('只有画像没有事件：只保留同层相邻的 layer 边，不凭空生成 tag / summary / semantic',
  profileOnly.edges.length === 1
  && profileOnly.edges[0].type === 'layer'
  && profileOnly.edges[0].a === 'profile:l0:occupation'
  && profileOnly.edges[0].b === 'profile:l0:preferredName',
  profileOnly.edges)

// ── 2. 六类边 ───────────────────────────────────────────────────
ok('summary 边：摘要连回每一条来源', (() => {
  const first = edgeOf(base, 'mem-s', 'mem-a', 'summary')
  const second = edgeOf(base, 'mem-s', 'mem-b', 'summary')
  return first !== undefined && second !== undefined && first.weight === 1
})(), base.edges)

const conflict = buildMemoryGraph({
  now: NOW,
  items: [
    mem('mem-c1', '用户住在杭州', { conflictWith: ['mem-c2'] }),
    mem('mem-c2', '用户住在南京'),
  ],
})
ok('conflict 边：conflictWith 指向的一对连橙色虚线（客户端按 type 上色）',
  edgeOf(conflict, 'mem-c1', 'mem-c2', 'conflict') !== undefined,
  conflict.edges)

const tags = buildMemoryGraph({
  now: NOW,
  items: [
    mem('mem-t1', '周一开会', { tags: ['工作'], created: '2026-10-01T12:00:00.000Z' }),
    mem('mem-t2', '周二写文档', { tags: ['工作'], created: '2026-10-02T12:00:00.000Z' }),
    mem('mem-t3', '周三评审', { tags: ['工作'], created: '2026-10-03T12:00:00.000Z' }),
  ],
})
ok('tag 边：同标签按 created 只连相邻两条（3 颗星 2 根，不是全连接 3 根）',
  tags.edges.filter((edge) => edge.type === 'tag').length === 2
  && edgeOf(tags, 'mem-t1', 'mem-t2', 'tag') !== undefined
  && edgeOf(tags, 'mem-t2', 'mem-t3', 'tag') !== undefined
  && edgeOf(tags, 'mem-t1', 'mem-t3', 'tag') === undefined,
  tags.edges)

const layers = buildMemoryGraph({
  now: NOW,
  items: [
    mem('mem-l1', '同层相近 A', { created: '2026-10-01T12:00:00.000Z' }),
    mem('mem-l2', '同层相近 B', { created: '2026-10-04T12:00:00.000Z' }),
    mem('mem-l3', '同层很远 C', { created: '2026-10-20T12:00:00.000Z' }),
  ],
})
ok('layer 边：同层且 created 相差 ≤7 天才连，超过 7 天不连',
  edgeOf(layers, 'mem-l1', 'mem-l2', 'layer') !== undefined
  && edgeOf(layers, 'mem-l2', 'mem-l3', 'layer') === undefined,
  layers.edges)

const refs = buildMemoryGraph({
  now: NOW,
  items: [
    mem('mem-r1', '那天是 10-04，我们一起看了海', { created: '2026-01-01T12:00:00.000Z' }),
    mem('mem-r2', '十月四日看海', { created: '2026-10-04T12:00:00.000Z' }),
    mem('mem-r3', '2026-10-09 的评审要准备', { created: '2026-01-02T12:00:00.000Z' }),
    mem('mem-r4', '评审文档', { created: '2026-10-09T12:00:00.000Z' }),
  ],
})
ok('ref 边：正文里的 MM-DD 命中另一条的 created 日期',
  edgeOf(refs, 'mem-r1', 'mem-r2', 'ref') !== undefined,
  refs.edges)
ok('ref 边：YYYY-MM-DD 同样命中', edgeOf(refs, 'mem-r3', 'mem-r4', 'ref') !== undefined, refs.edges)

const semantic = buildMemoryGraph({
  now: NOW,
  items: [
    mem('mem-x1', '项目评审会议记录：界面方案、交互细节、时间安排和风险清单都写在文档里', { created: '2026-01-01T12:00:00.000Z' }),
    mem('mem-x2', '项目评审会议记录：界面方案、交互细节、时间安排和风险清单都写在附件里', { created: '2026-06-01T12:00:00.000Z' }),
    mem('mem-x3', '今天天气不错，去公园散步看到一只橘猫在晒太阳', { created: '2026-09-01T12:00:00.000Z' }),
  ],
})
ok('semantic 边：2-gram 相似度 ≥0.35 且没有更高优先级关系时连弱线',
  edgeOf(semantic, 'mem-x1', 'mem-x2', 'semantic') !== undefined
  && edgeOf(semantic, 'mem-x1', 'mem-x3', 'semantic') === undefined,
  semantic.edges)

const dedupe = buildMemoryGraph({
  now: NOW,
  items: [
    mem('mem-d1', '同一个标签，也有冲突', { tags: ['共同'], conflictWith: ['mem-d2'] }),
    mem('mem-d2', '另一个说法', { tags: ['共同'] }),
  ],
})
ok('去重：同一对节点只保留优先级更高的一条边（conflict 赢 tag）',
  dedupe.edges.filter((edge) => (
    (edge.a === 'mem-d1' && edge.b === 'mem-d2') || (edge.a === 'mem-d2' && edge.b === 'mem-d1')
  )).length === 1
  && edgeOf(dedupe, 'mem-d1', 'mem-d2', 'conflict') !== undefined,
  dedupe.edges)

const perNode = buildMemoryGraph({
  now: NOW,
  items: [
    mem('mem-p0', '共同前缀：项目评审会议记录界面方案交互细节时间安排风险清单甲'),
    mem('mem-p1', '共同前缀：项目评审会议记录界面方案交互细节时间安排风险清单乙'),
    mem('mem-p2', '共同前缀：项目评审会议记录界面方案交互细节时间安排风险清单丙'),
    mem('mem-p3', '共同前缀：项目评审会议记录界面方案交互细节时间安排风险清单丁'),
    mem('mem-p4', '共同前缀：项目评审会议记录界面方案交互细节时间安排风险清单戊'),
  ],
})
ok('semantic 边：每颗星最多 3 条',
  [...perNode.nodes].every((node) => (
    perNode.edges.filter((edge) => edge.type === 'semantic' && (edge.a === node.id || edge.b === node.id)).length
    <= GRAPH_SEMANTIC_PER_NODE
  )),
  perNode.edges.filter((edge) => edge.type === 'semantic'))

// ── 3. 上限与响应大小 ───────────────────────────────────────────
const manyItems = Array.from({ length: 310 }, (_, index) => mem(
  `mem-many-${index}`,
  `第 ${index} 条记忆：${'这是一段用来检查节点上限的正文'.repeat(24)}`,
  { tags: ['批量', `t${index % 5}`], created: new Date(NOW - index * 3600_000).toISOString() },
))
const many = buildMemoryGraph({
  now: NOW,
  items: manyItems,
  profile: { l0: { preferredName: '小满', occupation: '工程师' }, l1: { currentProject: '星图' } },
})
ok('节点上限 300：画像字段优先保留，其余给权重最高的 L2',
  many.nodes.length === GRAPH_MAX_NODES
  && many.nodes.filter((node) => node.kind === 'profile').length === 3
  && many.stats.droppedNodes > 0,
  { nodes: many.nodes.length, dropped: many.stats.droppedNodes })
ok('300 节点时响应仍 <200KB（正文按预算自动收短）',
  many.stats.bytes < 200 * 1024
  && Buffer.byteLength(JSON.stringify({ nodes: many.nodes, edges: many.edges })) < 200 * 1024,
  many.stats.bytes)
ok('节点正文超长时被收短，但 textLength 保留原长度',
  many.nodes.filter((node) => node.kind === 'memory').every((node) => (
    node.text.length <= 160 && node.textLength > node.text.length
  )))

const capItems = []
for (let i = 0; i < 20; i += 1) {
  capItems.push(mem(`mem-cap-sum-${i}`, `摘要 ${i}`, {
    isSummary: true,
    weight: 1,
    status: 'active',
    subEntryIds: Array.from({ length: 50 }, (_, j) => `mem-cap-src-${j}`),
    created: new Date(NOW - 1000).toISOString(),
  }))
}
for (let j = 0; j < 280; j += 1) {
  capItems.push(mem(`mem-cap-src-${j}`, `来源记忆 ${j}`, {
    tags: ['同标签'],
    created: new Date(NOW - j * 1000).toISOString(),
  }))
}
const capped = buildMemoryGraph({ now: NOW, items: capItems })
ok('边总数上限 1200：超出时按权重从低到高截断，并给出 droppedEdges',
  capped.edges.length === GRAPH_MAX_EDGES && capped.stats.droppedEdges > 0,
  { edges: capped.edges.length, dropped: capped.stats.droppedEdges })
ok('权重高的 summary 边优先于低权重的 tag 边保留',
  capped.edges.filter((edge) => edge.type === 'summary').length === 1000
  && capped.edges.filter((edge) => edge.type === 'tag').length === 200,
  {
    summary: capped.edges.filter((edge) => edge.type === 'summary').length,
    tag: capped.edges.filter((edge) => edge.type === 'tag').length,
  })

// ── 4. 路由契约 ─────────────────────────────────────────────────
const home = await mkdtemp(join(TMP_ROOT, 'cyrene-graph-'))
process.env.DSH_HOME = home
delete process.env.MEM_LEDGER
process.env.CYRENE_CUSTOM_STICKER_DIR = join(home, 'stickers-custom')
process.env.CYRENE_CUSTOM_BACKGROUND_DIR = join(home, 'backgrounds-custom')
process.env.CYRENE_NO_REVEAL = '1'

const memPath = join(home, 'cyrene-memory.json')
await writeFile(memPath, JSON.stringify({
  enabled: true,
  rev: 2,
  items: [
    mem('mem-route-1', '路由测试：喜欢冰美式', { tags: ['偏好'] }),
    mem('mem-route-2', '路由测试：下周三评审', { tags: ['工作'] }),
  ],
  profile: {
    l0: { preferredName: '小满', updatedAt: NOW - 1000 },
    l1: { recentGoals: '学完图论', updatedAt: NOW - 2000 },
  },
}, null, 2), 'utf8')

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

function makeCtx() {
  const routes = []
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) {
      fn()
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
    on() {
      return () => {}
    },
    get(name) {
      if (name !== 'tools') return undefined
      return { register() { return () => {} } }
    },
  }
  return { ctx, routes }
}

function makeReq(method, path) {
  return {
    method,
    url: path,
    async *[Symbol.asyncIterator]() {},
  }
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(payload) {
      this.body += payload === undefined ? '' : String(payload)
    },
  }
}

const box = makeCtx()
mod.apply(box.ctx)
const started = Date.now()
while (box.routes.length === 0 && Date.now() - started < 2000) {
  await new Promise((resolve) => setTimeout(resolve, 10))
}
await new Promise((resolve) => setTimeout(resolve, 80))

async function route(path) {
  const res = makeRes()
  await box.routes[0].handler(makeReq('GET', path), res)
  return { status: res.statusCode, headers: res.headers, body: res.body, value: res.body === '' ? null : JSON.parse(res.body) }
}

const first = await route('/cyrene/memory/graph')
ok('GET /cyrene/memory/graph 返回 {ok:true, value:{nodes,edges,generatedAt}}',
  first.status === 200
  && first.value.ok === true
  && Array.isArray(first.value.value.nodes)
  && Array.isArray(first.value.value.edges)
  && !Number.isNaN(Date.parse(first.value.value.generatedAt)),
  first.value)
ok('路由响应带 JSON + no-store 响应头',
  /application\/json/.test(String(first.headers['Content-Type'] ?? first.headers['content-type']))
  && String(first.headers['Cache-Control'] ?? first.headers['cache-control']).includes('no-store'),
  first.headers)
ok('路由把画像字段也画成节点',
  first.value.value.nodes.some((node) => node.kind === 'profile' && node.id === 'profile:l0:preferredName'),
  first.value.value.nodes)
ok('路由响应 <200KB', Buffer.byteLength(first.body) < 200 * 1024, Buffer.byteLength(first.body))

await writeFile(memPath, JSON.stringify({
  enabled: true,
  rev: 3,
  items: [
    mem('mem-route-1', '路由测试：喜欢冰美式', { tags: ['偏好'] }),
    mem('mem-route-2', '路由测试：下周三评审', { tags: ['工作'] }),
    mem('mem-route-3', '新写入的一条：周末去爬山', { tags: ['出行'] }),
  ],
}, null, 2), 'utf8')
const reloaded = await route('/cyrene/memory/graph?reload=1')
ok('?reload=1 强制重读磁盘，新记忆立刻出现在图里',
  reloaded.status === 200
  && reloaded.value.value.nodes.some((node) => node.id === 'mem-route-3'),
  reloaded.value.value.nodes.map((node) => node.id))

// ── 汇总 ────────────────────────────────────────────────────────
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed}/${passed + failures.length}`)
if (failures.length > 0) {
  console.log(`失败项：${failures.join(' | ')}`)
  process.exitCode = 1
}
assert.equal(failures.length, 0)

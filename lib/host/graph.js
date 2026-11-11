/**
 * 昔涟 · 记忆星图（宿主侧纯函数）
 *
 * 设计思路参考 dsh-xingxi（作者 Yuuyuko-uu，插件许可 1.1）：
 *   https://github.com/Yuuyuko-uu/dsh-xingxi
 * 仅参考其「把记忆组织成星图」的设计与交互思路，**没有拷贝参考项目的任何代码**；
 * 成图规则、边类型与预算裁剪均按本项目风格自行实现。参考项目的源码与许可
 * 不随本项目分发，来源与许可状态见 NOTICE。
 *
 * 这一层不读盘、不写盘、不碰 ctx：输入是 publicMemories 里那套条目与画像，
 * 输出是 `{ nodes, edges }`。路由 /cyrene/memory/graph 负责取数据与包信封。
 */
import {
  L0_FIELDS,
  L0_LABELS,
  L1_FIELDS,
  L1_LABELS,
  freshness,
  similarity,
  statusOf,
  tokenize,
} from './cognitive.js'

/** 单次最多画这么多节点（画像字段优先保留，剩下的名额给权重最高的 L2）。 */
export const GRAPH_MAX_NODES = 300
/** 边总数上限：超出按权重从低到高截断。 */
export const GRAPH_MAX_EDGES = 1200
/** 语义边阈值（2-gram 余弦相似度）。 */
export const GRAPH_SEMANTIC_THRESHOLD = 0.35
/** 每条记忆最多牵几根语义线，避免「一条中心记忆把全图吸过来」。 */
export const GRAPH_SEMANTIC_PER_NODE = 3
/** 节点正文的初始上限；响应超预算时还会继续收。 */
export const GRAPH_TEXT_MAX = 160
/** 响应目标：< 200KB（给外层信封与 generatedAt 留一点余量）。 */
export const GRAPH_RESPONSE_MAX_BYTES = 190 * 1024
/** 同层「时间相近」的窗口。 */
const GRAPH_LAYER_WINDOW_MS = 7 * 86_400_000

/** 边类型的截断优先级：数字越小越先保留（权重相同时按它排）。 */
export const GRAPH_EDGE_ORDER = ['summary', 'conflict', 'tag', 'layer', 'ref', 'semantic']


function clamp01(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

function round(value, digits = 3) {
  const base = 10 ** digits
  return Math.round(Number(value) * base) / base
}

/**
 * 正文前 24 字（空白折成一个空格）。太长时补一个省略号，让画布上的标签
 * 一眼能看出「这里还有下文」。
 */
export function graphLabel(text, max = 24) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (value.length <= max) return value
  return value.slice(0, max) + '…'
}

/** 时间戳 → ISO；解析不了就退回 now（不制造 NaN 节点）。 */
function graphCreated(value, now) {
  const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''))
  return new Date(Number.isFinite(ms) ? ms : now).toISOString()
}

/** 一条 L2 记忆 → 一颗星（kind 由 isSummary 决定）。 */
function memoryNode(item, now) {
  const text = String(item?.text ?? '')
  const created = graphCreated(item?.created, now)
  const weight = clamp01(item?.weight)
  const fresh = freshness(Date.parse(created), now)
  const status = item?.status === 'archived' || item?.status === 'aging' || item?.status === 'active'
    ? item.status
    : statusOf(weight)
  const tags = Array.isArray(item?.tags)
    ? item.tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '').slice(0, 8)
    : []
  return {
    id: String(item?.id ?? ''),
    label: graphLabel(text),
    kind: item?.isSummary === true ? 'summary' : 'memory',
    layer: item?.layer === 'L0' || item?.layer === 'L1' ? item.layer : 'L2',
    weight: round(weight),
    freshness: round(fresh),
    created,
    status,
    pinned: item?.pinned === true,
    tags,
    text: text.slice(0, GRAPH_TEXT_MAX),
    textLength: text.length,
  }
}

/** L0/L1 的画像字段 → 一颗 kind:'profile' 的星（每个字段一颗）。 */
function profileNodes(profile, now) {
  const nodes = []
  for (const [layer, fields, labels, weight] of [
    ['L0', L0_FIELDS, L0_LABELS, 0.96],
    ['L1', L1_FIELDS, L1_LABELS, 0.78],
  ]) {
    const bucket = profile?.[layer.toLowerCase()]
    if (bucket === null || typeof bucket !== 'object') continue
    const created = graphCreated(bucket.updatedAt, now)
    const fresh = freshness(Date.parse(created), now)
    for (const field of fields) {
      const value = typeof bucket[field] === 'string' ? bucket[field].trim() : ''
      if (value === '') continue
      nodes.push({
        id: `profile:${layer.toLowerCase()}:${field}`,
        label: graphLabel(value),
        kind: 'profile',
        layer,
        weight,
        freshness: round(fresh),
        created,
        status: 'active',
        pinned: layer === 'L0',
        tags: [],
        text: value.slice(0, GRAPH_TEXT_MAX),
        textLength: value.length,
        field,
        fieldLabel: labels[field] ?? field,
      })
    }
  }
  return nodes
}

/** 节点权重的排序分：成色为主，新鲜度与钉住各加一点。 */
function nodeScore(node) {
  return node.weight + 0.2 * node.freshness + (node.pinned ? 0.15 : 0)
}

function edgeKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/**
 * 把记忆整理成星图。
 *
 * 边按优先级生成并**按无向节点对去重**：summary（摘要来源）→ conflict
 * （冲突对）→ tag（同标签相邻连）→ layer（同层 7 天内相邻）→ ref（正文
 * 提到别的记忆的日期）→ semantic（2-gram 相似，每节点最多 3 条）。
 * 同一条边只保留先出现的那一类，所以「摘要 + 冲突」不会画两根。
 *
 * @param {object} input
 * @param {Array} input.items memoryStore.items
 * @param {object} input.profile memoryStore.profile（{ l0, l1 }）
 * @param {number} [input.now]
 * @returns {{nodes:Array, edges:Array, stats:object}}
 */
export function buildMemoryGraph(input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now()
  const items = Array.isArray(input.items) ? input.items : []
  const profiles = profileNodes(input.profile, now)
  const memories = []
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue
    const text = String(item.text ?? '').trim()
    if (text === '') continue
    memories.push(memoryNode(item, now))
  }
  memories.sort((a, b) => nodeScore(b) - nodeScore(a) || (a.created < b.created ? -1 : 1))

  // 画像字段优先保留，剩下的名额给权重最高的 L2。
  const room = Math.max(0, GRAPH_MAX_NODES - profiles.length)
  const keptMemories = memories.slice(0, room)
  const nodes = [...keptMemories, ...profiles]
  const byId = new Map(nodes.map((node) => [node.id, node]))

  const edges = []
  const used = new Set()
  function addEdge(a, b, type, weight) {
    if (typeof a !== 'string' || typeof b !== 'string' || a === b) return false
    if (!byId.has(a) || !byId.has(b)) return false
    const key = edgeKey(a, b)
    if (used.has(key)) return false
    used.add(key)
    edges.push({ a, b, type, weight: round(weight) })
    return true
  }

  // 1) summary：摘要 ←→ 被折叠的来源（红色系，表示「这些被并进来了」）。
  for (const item of items) {
    if (item?.isSummary !== true) continue
    for (const sourceId of Array.isArray(item.subEntryIds) ? item.subEntryIds : []) {
      addEdge(String(item.id ?? ''), String(sourceId), 'summary', 1)
    }
  }

  // 2) conflict：正文互相矛盾的一对（橙色虚线）。
  for (const item of items) {
    for (const otherId of Array.isArray(item?.conflictWith) ? item.conflictWith : []) {
      addEdge(String(item.id ?? ''), String(otherId), 'conflict', 0.9)
    }
  }

  // 3) tag：同一个标签内按 created 排序后只连相邻两条，避免全连接爆炸。
  const byTag = new Map()
  for (const node of nodes) {
    for (const tag of node.tags) {
      if (!byTag.has(tag)) byTag.set(tag, [])
      byTag.get(tag).push(node)
    }
  }
  for (const [, group] of byTag) {
    group.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id.localeCompare(b.id)))
    for (let i = 1; i < group.length; i += 1) {
      addEdge(group[i - 1].id, group[i].id, 'tag', 0.5)
    }
  }

  // 4) layer：同层里时间相邻且不超过 7 天的两条连一根淡线。
  const byLayer = new Map()
  for (const node of nodes) {
    if (!byLayer.has(node.layer)) byLayer.set(node.layer, [])
    byLayer.get(node.layer).push(node)
  }
  for (const [, group] of byLayer) {
    group.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id.localeCompare(b.id)))
    for (let i = 1; i < group.length; i += 1) {
      const prev = Date.parse(group[i - 1].created)
      const next = Date.parse(group[i].created)
      if (!Number.isFinite(prev) || !Number.isFinite(next)) continue
      if (Math.abs(next - prev) <= GRAPH_LAYER_WINDOW_MS) {
        addEdge(group[i - 1].id, group[i].id, 'layer', 0.18)
      }
    }
  }

  // 5) ref（星汐那条「正文里写了日期」的规则）：正文提到 MM-DD / YYYY-MM-DD，
  //    而另一条记忆正好是那天创建的，就连过去。每条最多连 4 根。
  const byDate = new Map()
  for (const node of nodes) {
    const day = node.created.slice(0, 10)
    if (!byDate.has(day)) byDate.set(day, [])
    byDate.get(day).push(node.id)
    if (!byDate.has(day.slice(5))) byDate.set(day.slice(5), [])
    byDate.get(day.slice(5)).push(node.id)
  }
  for (const node of nodes) {
    const mentioned = new Set()
    const pattern = /(?:(\d{4})-)?(\d{2})-(\d{2})(?!\d)/g
    for (const match of node.text.matchAll(pattern)) {
      if (mentioned.size >= 4) break
      const full = match[1] === undefined ? null : `${match[1]}-${match[2]}-${match[3]}`
      const short = `${match[2]}-${match[3]}`
      for (const targetId of byDate.get(full ?? short) ?? []) {
        if (targetId === node.id) continue
        if (addEdge(node.id, targetId, 'ref', 0.3)) mentioned.add(targetId)
        if (mentioned.size >= 4) break
      }
    }
  }

  // 6) semantic：2-gram 余弦相似度 ≥ 0.35，且不是上面任何一类关系。
  //    每颗星只保留最像的 3 条；先收集再按分数统一放，避免「数组顺序决定谁连」。
  const tokens = new Map(nodes.map((node) => [node.id, tokenize(node.text)]))
  const candidates = new Map(nodes.map((node) => [node.id, []]))
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const left = nodes[i]
      const right = nodes[j]
      if (used.has(edgeKey(left.id, right.id))) continue
      if (left.textLength < 16 || right.textLength < 16) continue
      const score = similarity(tokens.get(left.id), tokens.get(right.id))
      if (score < GRAPH_SEMANTIC_THRESHOLD) continue
      candidates.get(left.id).push({ id: right.id, score })
      candidates.get(right.id).push({ id: left.id, score })
    }
  }
  const semanticDegree = new Map(nodes.map((node) => [node.id, 0]))
  for (const node of nodes) {
    const ranked = candidates.get(node.id).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    for (const candidate of ranked) {
      if (semanticDegree.get(node.id) >= GRAPH_SEMANTIC_PER_NODE) break
      const target = byId.get(candidate.id)
      if (target === undefined) continue
      if (used.has(edgeKey(node.id, target.id))) continue
      if (semanticDegree.get(target.id) >= GRAPH_SEMANTIC_PER_NODE) continue
      if (addEdge(node.id, target.id, 'semantic', candidate.score)) {
        semanticDegree.set(node.id, semanticDegree.get(node.id) + 1)
        semanticDegree.set(target.id, semanticDegree.get(target.id) + 1)
      }
    }
  }

  // 边太多：按权重从低到高截断；权重一样时先丢 semantic / ref / layer。
  let droppedEdges = 0
  if (edges.length > GRAPH_MAX_EDGES) {
    const order = (type) => {
      const index = GRAPH_EDGE_ORDER.indexOf(type)
      return index === -1 ? GRAPH_EDGE_ORDER.length : index
    }
    edges.sort((a, b) => b.weight - a.weight || order(a.type) - order(b.type))
    droppedEdges = edges.length - GRAPH_MAX_EDGES
    edges.length = GRAPH_MAX_EDGES
  }

  const fitted = fitGraphBudget(nodes, edges)
  return {
    nodes: fitted.nodes,
    edges: fitted.edges,
    stats: {
      nodes: fitted.nodes.length,
      edges: fitted.edges.length,
      memories: keptMemories.length,
      profiles: profiles.length,
      droppedNodes: memories.length - keptMemories.length + fitted.droppedNodes,
      droppedEdges: droppedEdges + fitted.droppedEdges,
      bytes: fitted.bytes,
    },
  }
}

function bytesOf(value) {
  return Buffer.byteLength(JSON.stringify(value))
}

/**
 * 响应体积保险：目标是 <200KB。先逐级收正文（160 → 120 → 80 → 48 → 24 → 0），
 * 还不够再按权重丢边，最后才丢节点（画像字段永远留着）。
 * 返回的是同一批节点 / 边的引用，调用方拿到的就是最终要发出去的那份。
 */
export function fitGraphBudget(nodes, edges, maxBytes = GRAPH_RESPONSE_MAX_BYTES) {
  let bytes = bytesOf({ nodes, edges })
  if (bytes <= maxBytes) return { nodes, edges, bytes, droppedEdges: 0, droppedNodes: 0 }

  for (const cap of [120, 80, 48, 24, 0]) {
    for (const node of nodes) {
      if (node.text.length > cap) node.text = node.text.slice(0, cap)
    }
    bytes = bytesOf({ nodes, edges })
    if (bytes <= maxBytes) return { nodes, edges, bytes, droppedEdges: 0, droppedNodes: 0 }
  }

  // 节点只剩骨架时仍然超：先丢最轻的边（保留 summary / conflict 到最后一刻）。
  const order = (type) => {
    const index = GRAPH_EDGE_ORDER.indexOf(type)
    return index === -1 ? GRAPH_EDGE_ORDER.length : index
  }
  const ranked = edges
    .map((edge, index) => ({ edge, index }))
    .sort((a, b) => a.edge.weight - b.edge.weight || order(b.edge.type) - order(a.edge.type))
  // 二分「要丢多少根最轻的边」：一次比一次少猜，不让 1200 根边逐根序列化。
  const withoutLowest = (count) => {
    const removed = new Set(ranked.slice(0, count).map((entry) => entry.index))
    return edges.filter((_, index) => !removed.has(index))
  }
  let droppedEdges = 0
  if (bytes > maxBytes) {
    let low = 0
    let high = edges.length
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      const next = withoutLowest(mid)
      if (bytesOf({ nodes, edges: next }) <= maxBytes) high = mid
      else low = mid + 1
    }
    edges = withoutLowest(low)
    droppedEdges = low
    bytes = bytesOf({ nodes, edges })
  }

  // 最后兜底：丢最轻的 L2 节点（画像节点不丢），边跟着引用一起过滤。
  let droppedNodes = 0
  if (bytes > maxBytes) {
    const rankedNodes = nodes
      .map((node, index) => ({ node, index }))
      .sort((a, b) => nodeScore(a.node) - nodeScore(b.node))
    while (bytes > maxBytes) {
      const victim = rankedNodes.find((entry) => entry.node.kind !== 'profile' && nodes.includes(entry.node))
      if (victim === undefined) break
      nodes = nodes.filter((node) => node !== victim.node)
      edges = edges.filter((edge) => edge.a !== victim.node.id && edge.b !== victim.node.id)
      droppedNodes += 1
      bytes = bytesOf({ nodes, edges })
    }
  }

  return { nodes, edges, bytes, droppedEdges, droppedNodes }
}

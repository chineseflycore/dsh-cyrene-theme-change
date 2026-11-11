// lib/host/vector.js — 记忆的向量表示（768 维，零依赖、确定性）
//
// 为什么要有这一层：
//   现在的召回靠 2-gram 重合度，中文短句区分度太低（「编译失败」与「部署成功」
//   在 2-gram 上很像）。向量层给出一个**固定长度、可存储、可比较**的表示，
//   让「同一主题反复出现」这种判断有统一入口。
//
// 为什么现在是哈希投影而不是模型：
//   DSH 没有 embedding 服务，本机也跑不动小模型。这层用 hashed n-gram 投影到
//   768 维（Johnson–Lindenstrauss 那套），好处是：
//     · 确定性：同样的文本永远得到同样的向量，可测试、可复现；
//     · 零依赖：不需要 torch / onnx / 网络；
//     · 接口稳定：将来有真模型时，只要换掉 embed()，上层逻辑一行不动。
//   它的语义能力**不高于**直接算 n-gram 余弦（投影保距离，不增信息），
//   所以别指望它凭空变聪明；它的价值在「统一表示 + 可落盘 + 可换实现」。
//
// 768 维是常见 embedding 模型的输出宽度，选它只是为了将来对齐。

export const DIM = 768

/** FNV-1a：短字符串上分布够均匀，实现三行。 */
function hash32(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * 切词：中文按「单字 + 相邻双字」，西文按单词。
 * 和 cognitive.js 的 tokenize 保持同一套口径，避免两处相似度不可比。
 */
export function gramTokens(text) {
  const source = String(text ?? '').toLowerCase()
  const tokens = []
  const words = source.match(/[a-z0-9_]+/gu) ?? []
  for (const word of words) tokens.push(`w:${word}`)
  const cjk = source.replace(/[^\u3400-\u9fff]/gu, '')
  for (let i = 0; i < cjk.length; i += 1) {
    tokens.push(`c:${cjk[i]}`)
    if (i + 1 < cjk.length) tokens.push(`b:${cjk[i]}${cjk[i + 1]}`)
  }
  return tokens
}

/**
 * 文本 → 768 维单位向量（Float32Array）。
 * 归一化到长度 1，因此点积即余弦相似度。
 */
export function embed(text) {
  const vector = new Float32Array(DIM)
  for (const token of gramTokens(text)) {
    const h = hash32(token)
    const index = h % DIM
    const sign = (h >>> 31) === 1 ? -1 : 1
    vector[index] += sign
  }
  let norm = 0
  for (let i = 0; i < DIM; i += 1) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm)
  if (norm > 1e-9) {
    for (let i = 0; i < DIM; i += 1) vector[i] /= norm
  }
  return vector
}

/** 余弦相似度（两个都已归一化时就是点积）。 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na < 1e-9 || nb < 1e-9) return 0
  return dot / Math.sqrt(na * nb)
}

/** 便捷函数：两段文本的直接相似度。 */
export function similarityOfText(a, b) {
  return cosine(embed(a), embed(b))
}

/**
 * 向量压成可落盘的短串（int8 量化 + base64）。
 * 768 byte/条；只在需要跨会话复用向量时才存，默认内存里直接算。
 */
export function packVector(vector) {
  const bytes = new Uint8Array(vector.length)
  for (let i = 0; i < vector.length; i += 1) {
    const v = Math.max(-1, Math.min(1, vector[i]))
    bytes[i] = Math.round(v * 127) & 0xff
  }
  return Buffer.from(bytes).toString('base64')
}

/** 解包；长度或格式不对就当没有向量（返回 null），调用方回退到实时计算。 */
export function unpackVector(packed, dim = DIM) {
  if (typeof packed !== 'string' || packed === '') return null
  let buffer
  try {
    buffer = Buffer.from(packed, 'base64')
  } catch {
    return null
  }
  if (buffer.length !== dim) return null
  const vector = new Float32Array(dim)
  for (let i = 0; i < dim; i += 1) {
    const signed = buffer[i] > 127 ? buffer[i] - 256 : buffer[i]
    vector[i] = signed / 127
  }
  return vector
}
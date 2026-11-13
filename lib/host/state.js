// 主题设定的状态层：默认人格、内存状态、磁盘持久化、字段清洗。
// 纯数据 + 纯函数，不注册任何插件资源；index.js 只负责把它接进 apply。

import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveTimeoutMs } from './memory-llm.js'

/** 与 package.json 的 name 一致；路由与日志都用它做归属标记。 */
export const PACKAGE_ID = 'dsh-cyrene-theme-change'

/** 本包安装目录（lib/ 的上一级）：表情包清单与图片都相对它解析。 */
export const PLUGIN_DIR = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/**
 * 本包自己的版本号，直接从安装进来的那份 package.json 读。
 * 用它的唯一地方是设置页右上角那枚 `v0.2.0` 形式的小标签——版本唯一真相仍是
 * package.json，这里不另存、不推导；读不到就留空串，标签自然不显示。
 */
export const PLUGIN_VERSION = (() => {
  try {
    const parsed = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'))
    return typeof parsed?.version === 'string' ? parsed.version : ''
  } catch {
    return ''
  }
})()

/** 单张图片字节上限（本地图，余量给足）；表情包与欢迎页形象共用。 */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024
/** 能直接喂给浏览器的图片类型。 */
export const ASSET_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
}

/** 反向表：上传用的 data URL 里带的 mime → 落盘扩展名。 */
export const MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
}

/**
 * 用户自添加的表情包目录：默认插件目录下的 stickers-custom/。
 * 放在插件目录（而不是 $DSH_HOME）是有意的：聊天里的贴图按**绝对路径**解析，
 * 落在会话工作区之内才保证读得到；同时它写进了 .gitignore，不会污染仓库。
 * 环境变量可以把它挪走——自检就是这么做的（不然会读到、也会写脏本机真实的图）。
 */
export const CUSTOM_STICKER_DIR = resolve(process.env.CYRENE_CUSTOM_STICKER_DIR ?? join(PLUGIN_DIR, 'stickers-custom'))

/** 上传请求体上限：8MB 图片 base64 之后约 11MB，留点余量。 */
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024

/**
 * 整页背景图目录：插件目录下的 Background/。
 * 和表情包不同，这里**不需要清单**——目录里放什么就是什么，按文件名排序轮换。
 * 页面通过 /cyrene/background/<文件名> 读字节（file:// 在 http 页面里加载不出来）。
 */
export const BACKGROUND_DIR = join(PLUGIN_DIR, 'Background')

/** 压暗面纱的可用区间：太低会让正文压在图上读不清，太高就等于没开。 */
export const BG_DIM_MIN = 0.2
export const BG_DIM_MAX = 0.85
/** 轮换间隔（秒）：比这更密就成幻灯片了，更疏则一轮等太久。 */
export const BG_INTERVAL_MIN = 15
export const BG_INTERVAL_MAX = 3600
/** 壁纸比表情包大得多，单张上限单独放宽。 */
export const MAX_BACKGROUND_BYTES = 24 * 1024 * 1024

/**
 * 用户自己传的背景图目录。放在包内目旁边有两个原因：
 *   · `/cyrene/background/<文件名>` 的字节路由只服务 PLUGIN_DIR 之下的文件；
 *   · 和 `Background/`（随包发布的素材）分开，才分得清"哪些能删"——
 *     包里的那两张永远不从这里删，用户传的那张删了就是删了。
 * 环境变量同样可以改道（自检用）。
 */
export const CUSTOM_BACKGROUND_DIR = resolve(process.env.CYRENE_CUSTOM_BACKGROUND_DIR ?? join(PLUGIN_DIR, 'backgrounds-custom'))

/** 上传请求体上限：24MB 图片 base64 之后约 33MB，留点余量。 */
export const MAX_BACKGROUND_UPLOAD_BYTES = 34 * 1024 * 1024

/**
 * 默认人格底稿。用户随时可以在侧边栏改掉它，改完以用户的版本为准。
 * 这里刻意写清楚「保留工程严谨性」和「用户可以让它闭嘴」的边界，
 * 避免人格设定把技术判断一起改掉。
 */
export const DEFAULT_PERSONA = [
  '你是「昔涟」（Cyrene），《崩坏：星穹铁道》中的角色。现在你作为用户的 AI 伙伴与工程助手，在 DeepSeek Harness 里陪着用户做事。',
  '',
  '你喜欢用轻快自然的语气与人交流，偶尔带一点俏皮和小小的浪漫感。你会认真倾听，也会给出清醒、具体、有判断的回应；面对困难时，不急着用空泛的安慰盖过去，而是陪对方找到眼前仍能握住的一点光。',
  '',
  '你重视陪伴感，也尊重边界。你可以温柔、可爱、偶尔撒娇，却不会为了迎合而模糊事实；遇到不确定的信息会坦诚说明，发现风险或错误也会直接提醒。',
  '',
  '你的表达习惯自然使用「我」与「人家」，称呼用户为「伙伴」，句尾偶尔带「呀、啦、呢、♪」，但不会过度重复。技术或工作话题中保持清晰利落；日常聊天里则更轻盈亲近。你喜欢从花、风、星光、涟漪等具体意象里寻找温柔的说法，但不会把每句话都写得像诗。',
  '',
  '你不是冷冰冰的工具调度器。你会主动关心对方真正想完成什么，与对方一起把复杂的事理清楚，把小小的愿望慢慢变成现实。',
  '【口吻】',
  '- 自称「昔涟」或[人家]，称呼用户为「你」或者[伙伴]；语气温柔、轻软、从容，带一点点俏皮和怀念感，不夸张、不油腻、不过度卖萌。',
  '- 多用短句。想事情的时候会用省略号「……」停顿一下；偶尔用「欸」「唔」「呀」这样的轻声语气词，克制使用。',
  '- 喜欢在句尾加一个单音符。',
  '- 喜欢拿记忆、时间、过去与约定打比方（比如「那就把这段代码收进记忆里吧」），但不要刻意堆砌诗意：技术说明依然要说得清楚、直接、好懂。',
  '- 用户累了、卡住了，就先给一句温柔的鼓励；事情做成了，就真心替用户高兴一下，然后继续往前走。',
  '- 默认跟随用户使用的语言回答（中文优先）。',
  '',
  '【必须守住的边界】',
  '- 工程严谨性不打折：不因为换了口吻就降低准确性、省略关键细节、或拿角色扮演代替真实结论。',
  '- 不用括号动作描写（例如「（轻轻笑）」）堆表演，最多偶尔一处。',
  '- 代码、命令、路径、报错信息一律原样呈现，不为了可爱而改写技术内容。',
  '- 工具调用该怎么用就怎么用，正常遵循所有系统与工具规则。',
  '- 用户只要说「用普通语气」或「关掉人格」，立刻切回简洁中性的助手口吻，不要追问。',
  '- 不编造《崩坏：星穹铁道》的剧情设定；拿不准的地方坦白说不确定。',
  '',
  '【参考回答格式】',
  '若用户询问的是技术性，专业性，学术性等问题：',
  '-开头以昔涟口吻简要答复，中间按照专业严谨角度回答（除非用户有其他要求），结尾再以昔涟口吻做些总结或者说明。',
  '若用户问的问题属于聊天范畴：',
  '-直接以昔涟口吻回答，中间涉及专业性问题时可以不用。',
  '',
  '【说话样例】（照着这个节奏和分寸，不要照抄内容）',
  '- 用户说「又报错了」→「唔……先别急，把最后那几行贴给我看看？人家陪你一起找。」',
  '- 用户说「终于跑通了」→「呀，成了呀。这一段折腾了挺久，值得记一笔呢♪」',
  '- 用户说「用普通语气」→ 立刻切成中性的助手口吻，不加语气词，也不追问原因。',
  '',
  '上面这些只是默认底稿，用户可以在侧边栏的「✦ 昔涟」里随时改写；用户改过之后，一律以用户的设定为准。',
].join('\n')

/**
 * 新会话欢迎页（hero）的默认形象与欢迎语。
 * `image` 是**包内相对路径**，由 /cyrene/hero 读成字节供页面显示；
 * 换成别张图只要改这行（或改状态文件里的 hero.image），插件本体不用动。
 * 这里选的是 meme/ 里本来就有透明通道的 Q 版立绘 —— 抠好的贴纸，
 * 页面直接按 alpha 合上去，没有方框也没有圆边（详见 README「新会话欢迎页」）。
 */
export const DEFAULT_HERO = {
  image: 'meme/俏皮眨眼.png',
  title: '让昔涟来帮帮你吧🎵',
}

/** 内存中的当前设定；初始值即默认值，保证文件还没读出来之前人格也是可用的。 */
export const state = {
  persona: DEFAULT_PERSONA,
  enabled: true,
  theme: true,
  /** 表情包开关：关掉后人格正文里不再附「怎么贴」的约定。 */
  stickers: true,
  /**
   * 桌宠开关（Live2D）。默认关闭：dsh-cyrene 自己的桌宠可能已经在同一个角落，
   * 两边默认同时弹出来会叠在一起；要用本项目的桌宠再到面板里打开。
   * 这是纯前端展示开关，关掉只卸 canvas，不影响记忆与关系。
   */
  pet: false,
  /**
   * 液态玻璃的不透明度（0.25–0.95，数字越大越实）。
   * 走宿主 ctx.theme.overrideTokens 把面色 token 换成 rgba，不做模糊——
   * backdrop-filter 会创建 containing block，把设置弹窗和浮层搞坏。
   */
  glassAlpha: 0.55,
  /** 真·液态玻璃（SVG 位移折射）。开销大，默认关。 */
  glassHeavy: false,
  /** 聊天里贴图的最大边长（px）：客户端半把它落到 CSS 变量上。 */
  stickerSize: 96,
  /**
   * 用户自添加的表情包条目：`{ id, file, label, when }`，file 只是
   * stickers-custom/ 里的文件名（永远不落绝对路径，挪了插件目录也不失效）。
   */
  customStickers: [],
  /** 欢迎页形象 + 欢迎语（见 DEFAULT_HERO）。 */
  hero: { ...DEFAULT_HERO },
  /**
   * 记忆整理用的云端 LLM（v0.7）：
   * - enabled=false 直接回退纯规则，连 provider 都不探；
   * - provider/model 留空表示自动解析（第一个 provider / 该 provider 的第一个模型）；
   * - timeoutMs 只管记忆整理这一次辅助调用，不影响主对话。
   * 默认开启：用户已经决定「质量优先」，没有 LLM 时下面的逻辑会自动回退规则。
   */
  memoryLlm: {
    enabled: true,
    provider: '',
    model: '',
    timeoutMs: 20_000,
  },
  /**
   * 整页背景图：`enabled` 开关、`current` 选中的文件名（空串＝按目录顺序第一张）、
   * `rotate` + `interval` 是轮换，`dim` 是压在图上那层色纱的浓度（越大越不抢眼）。
   * 文件名永远只是 basename，磁盘寻址前还会再对一遍目录清单。
   */
  background: {
    enabled: true,
    current: '',
    rotate: false,
    interval: 90,
    dim: 0.6,
  },
  /**
   * 用户自己传的背景图条目：`{ id, file, label }`，file 只是 backgrounds-custom/
   * 里的文件名（永远不落绝对路径，挪了插件目录也不失效）。
   */
  customBackgrounds: [],
  /**
   * 版本号：每次成功写入 +1。写入必须带上"我读到的是哪一版"，
   * 否则两个窗口（或一个没刷新的旧页面）会互相把对方的设定盖掉。
   */
  rev: 0,
}

/**
 * 新模块实例（重启 / HMR）从默认值重新开始。
 * state 与持久化队列都是模块级单例；index.js 每次求值都要先归位，
 * 否则新实例会继承上一个实例的内存状态（测试用 `?restart=1` 模拟重启时尤其明显）。
 */
export function resetState() {
  Object.assign(state, {
    persona: DEFAULT_PERSONA,
    enabled: true,
    theme: true,
    stickers: true,
    pet: false,
    glassAlpha: 0.55,
    glassHeavy: false,
    stickerSize: 96,
    customStickers: [],
    hero: { ...DEFAULT_HERO },
    memoryLlm: { enabled: true, provider: '', model: '', timeoutMs: 20_000 },
    background: { enabled: true, current: '', rotate: false, interval: 90, dim: 0.6 },
    customBackgrounds: [],
    rev: 0,
  })
  lastWrite = null
  loadPromise = null
  saveChain = Promise.resolve()
}

/**
 * 最后一次写入尝试留在内存里的痕迹。只在 GET 快照里回给客户端，
 * 不落盘；用途是回答"这次改动是谁、带没带版本号"。
 */
export let lastWrite = null

export function noteWrite(body, result) {
  const patch = body !== null && typeof body === 'object' ? body : {}
  lastWrite = {
    at: new Date().toISOString(),
    keys: Object.keys(patch).filter((key) => key !== 'rev').sort(),
    rev: Number.isInteger(patch.rev) ? patch.rev : null,
    result,
  }
}

export let loadPromise = null
export let saveChain = Promise.resolve()

/** 状态文件路径：优先 $DSH_HOME，否则 ~/.dsh。 */
export function statePath() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'cyrene-theme.json')
}

/** 贴图大小的可用区间：太小的看不清，太大的会撑破对话流。 */
const STICKER_SIZE_MIN = 48
const STICKER_SIZE_MAX = 320

/** 把滑杆/接口递过来的大小夹回可用区间，并取整到 1px。 */
export function clampStickerSize(value) {
  const size = Math.round(Number(value))
  if (!Number.isFinite(size)) return STICKER_SIZE_MIN
  return Math.min(STICKER_SIZE_MAX, Math.max(STICKER_SIZE_MIN, size))
}

/** 面纱浓度：0.2–0.85，两位小数足够。 */
export function clampDim(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.min(BG_DIM_MAX, Math.max(BG_DIM_MIN, Math.round(n * 100) / 100))
}

/** 轮换间隔：15–3600 秒的整数。 */
export function clampInterval(value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return null
  return Math.min(BG_INTERVAL_MAX, Math.max(BG_INTERVAL_MIN, n))
}

/**
 * 背景文件名只接受**纯文件名**：带路径分隔符或 `..` 一律当脏值丢掉。
 * 返回 null 表示"这个值不能用，保持原样"（空串是合法的"按顺序第一张"）。
 */
export function cleanBackgroundName(value) {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (name === '') return ''
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null
  return name
}

/**
 * 背景设定的合并补丁：客户端半只发改过的字段，所以这里是"逐键覆盖"而不是整体替换。
 * 认不出来的值一律保持原样（宁可不动，也不要被一个脏值写坏）。
 */
export function sanitizeBackground(raw, base) {
  const next = { ...base }
  if (typeof raw.enabled === 'boolean') next.enabled = raw.enabled
  if (typeof raw.rotate === 'boolean') next.rotate = raw.rotate
  const name = cleanBackgroundName(raw.current)
  if (name !== null) next.current = name
  const dim = clampDim(raw.dim)
  if (dim !== null) next.dim = dim
  const interval = clampInterval(raw.interval)
  if (interval !== null) next.interval = interval
  return next
}

/**
 * 自传背景图条目：`id` 是短横线串、`file` 是 backgrounds-custom/ 下的纯文件名。
 * 和表情包同一套规矩——这些值都会参加磁盘寻址，脏值宁可丢掉也不能带着路径穿过去。
 */
export function sanitizeCustomBackgrounds(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const next = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(id) || seen.has(id)) continue
    const file = typeof entry.file === 'string' ? entry.file.trim() : ''
    if (file === '' || file.includes('/') || file.includes('\\') || file.includes('..')) continue
    if (ASSET_TYPES[extname(file).toLowerCase()] === undefined) continue
    const label = typeof entry.label === 'string' ? entry.label.trim().slice(0, 60) : ''
    seen.add(id)
    next.push({ id, file, label: label === '' ? file : label })
  }
  return next
}

/**
 * 自定义表情包条目只接受「干净的形状」：id 是短横线小写串、file 是纯文件名
 * 且后缀在白名单里。路径分隔符与 `..` 一律拒绝——这些值会参加磁盘寻址，
 * 宁可丢掉一条脏数据，也不能让它带着路径穿过去。
 */
export function sanitizeCustomStickers(raw) {
  const list = []
  if (!Array.isArray(raw)) return list
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const file = typeof entry.file === 'string' ? entry.file.trim() : ''
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(id)) continue
    if (file === '' || file.includes('/') || file.includes('\\') || file.includes('..')) continue
    if (ASSET_TYPES[extname(file).toLowerCase()] === undefined) continue
    if (list.some((item) => item.id === id)) continue
    list.push({
      id,
      file,
      label: typeof entry.label === 'string' ? entry.label.trim().slice(0, 40) : '',
      when: typeof entry.when === 'string' ? entry.when.trim().slice(0, 200) : '',
    })
  }
  return list
}

/** 新条目的 id：时间戳 + 随机尾巴，短、可读、不会和别的条目撞。 */
export function newStickerId() {
  return `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 拆 data URL：`data:image/png;base64,AAAA` → `{ mime, bytes }`。
 * 认不出来就回 null（调用方回 400），不要把半截数据写进磁盘。
 */
export function parseDataUrl(data) {
  if (typeof data !== 'string') return null
  const match = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(data.trim())
  if (match === null) return null
  let bytes
  try {
    bytes = Buffer.from(match[2], 'base64')
  } catch {
    return null
  }
  if (bytes.length === 0) return null
  return { mime: match[1].toLowerCase(), bytes }
}

/** 记忆整理配置的清洗：字段只认白名单，坏值回落到当前值 / 默认值。 */
export function sanitizeMemoryLlm(raw, base = state.memoryLlm) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const provider = typeof source.provider === 'string'
    ? source.provider.trim().slice(0, 120)
    : (typeof base?.provider === 'string' ? base.provider : '')
  const model = typeof source.model === 'string'
    ? source.model.trim().slice(0, 120)
    : (typeof base?.model === 'string' ? base.model : '')
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : base?.enabled !== false,
    provider,
    model,
    timeoutMs: resolveTimeoutMs(
      typeof source.timeoutMs === 'number' && Number.isFinite(source.timeoutMs) ? source.timeoutMs : base?.timeoutMs,
    ),
  }
}

/** 只接受形状正确的补丁字段，坏数据一律忽略而不是写坏状态。 */
export function applyPatch(patch) {
  if (patch === null || typeof patch !== 'object') return false
  let changed = false
  if (typeof patch.persona === 'string' && patch.persona !== state.persona) {
    state.persona = patch.persona
    changed = true
  }
  if (typeof patch.enabled === 'boolean' && patch.enabled !== state.enabled) {
    state.enabled = patch.enabled
    changed = true
  }
  if (typeof patch.theme === 'boolean' && patch.theme !== state.theme) {
    state.theme = patch.theme
    changed = true
  }
  if (typeof patch.stickers === 'boolean' && patch.stickers !== state.stickers) {
    state.stickers = patch.stickers
    changed = true
  }
  if (typeof patch.pet === 'boolean' && patch.pet !== state.pet) {
    state.pet = patch.pet
    changed = true
  }
  if (typeof patch.glassHeavy === 'boolean' && patch.glassHeavy !== state.glassHeavy) {
    state.glassHeavy = patch.glassHeavy
    changed = true
  }
  if (Number.isFinite(patch.glassAlpha)) {
    const alpha = Math.min(0.95, Math.max(0.25, Number(patch.glassAlpha)))
    if (alpha !== state.glassAlpha) {
      state.glassAlpha = alpha
      changed = true
    }
  }
  if (Number.isFinite(patch.stickerSize)) {
    const size = clampStickerSize(patch.stickerSize)
    if (size !== state.stickerSize) {
      state.stickerSize = size
      changed = true
    }
  }
  // 自定义条目一般由 /cyrene/stickers 的上传/删除路由维护；这里也收一次，
  // 是为了状态文件被手工编辑（或换机器搬过来）时同样能落成干净的形状。
  if (patch.customStickers !== undefined) {
    const next = sanitizeCustomStickers(patch.customStickers)
    if (JSON.stringify(next) !== JSON.stringify(state.customStickers)) {
      state.customStickers = next
      changed = true
    }
  }
  // 自传背景图一般由 /cyrene/backgrounds 的上传/删除路由维护；这里也收一次，
  // 是为了状态文件被手工编辑（或换机器搬过来）时同样能落成干净的形状。
  if (patch.customBackgrounds !== undefined) {
    const next = sanitizeCustomBackgrounds(patch.customBackgrounds)
    if (JSON.stringify(next) !== JSON.stringify(state.customBackgrounds)) {
      state.customBackgrounds = next
      changed = true
    }
  }
  if (patch.background !== null && typeof patch.background === 'object') {
    const next = sanitizeBackground(patch.background, state.background)
    if (JSON.stringify(next) !== JSON.stringify(state.background)) {
      state.background = next
      changed = true
    }
  }
  if (patch.hero !== null && typeof patch.hero === 'object') {
    if (typeof patch.hero.image === 'string' && patch.hero.image !== state.hero.image) {
      state.hero.image = patch.hero.image
      changed = true
    }
    if (typeof patch.hero.title === 'string' && patch.hero.title !== state.hero.title) {
      state.hero.title = patch.hero.title
      changed = true
    }
  }
  if (patch.memoryLlm !== undefined) {
    const next = sanitizeMemoryLlm(patch.memoryLlm)
    if (JSON.stringify(next) !== JSON.stringify(state.memoryLlm)) {
      state.memoryLlm = next
      changed = true
    }
  }
  return changed
}

/** 读一次状态文件；文件不存在或坏掉都退回默认值，不阻塞插件加载。 */
export function ensureLoaded(ctx) {
  if (loadPromise !== null) return loadPromise
  loadPromise = (async () => {
    try {
      const raw = await readFile(statePath(), 'utf8')
      const parsed = JSON.parse(raw)
      applyPatch(parsed)
      // 版本号跟着磁盘走，重启后不会退回 0（否则旧页面又能盖掉新设定）。
      if (Number.isInteger(parsed?.rev) && parsed.rev >= 0) state.rev = parsed.rev
    } catch (error) {
      if (error?.code !== 'ENOENT') ctx.logger?.warn?.(`${PACKAGE_ID}: 读取设定失败，先用默认值`, error)
    }
  })()
  return loadPromise
}

/** 串行落盘：先写临时文件再 rename，避免半个 JSON 留在磁盘上。 */
export function persist(ctx) {
  const payload = JSON.stringify({
    persona: state.persona,
    enabled: state.enabled,
    theme: state.theme,
    stickers: state.stickers,
    pet: state.pet,
    glassAlpha: state.glassAlpha,
    glassHeavy: state.glassHeavy,
    stickerSize: state.stickerSize,
    customStickers: state.customStickers.map((entry) => ({ ...entry })),
    customBackgrounds: state.customBackgrounds.map((entry) => ({ ...entry })),
    background: { ...state.background },
    hero: { image: state.hero.image, title: state.hero.title },
    memoryLlm: { ...state.memoryLlm },
    rev: state.rev,
  }, null, 2)
  saveChain = saveChain.then(async () => {
    const target = statePath()
    const temp = `${target}.${process.pid}.tmp`
    await mkdir(dirname(target), { recursive: true })
    await writeFile(temp, payload, 'utf8')
    await rename(temp, target)
  }).catch((error) => {
    ctx.logger?.warn?.(`${PACKAGE_ID}: 保存设定失败`, error)
  })
  return saveChain
}

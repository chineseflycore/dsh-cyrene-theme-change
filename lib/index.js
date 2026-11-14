/**
 * dsh-cyrene-theme — 宿主半（Host half）。
 *
 * 职责只有三件事，互不耦合：
 *  1. 人格：把一个 section（名字是本包自己的 `cyrene:persona`，order 落在
 *     部署人格前缀之后、工具策略之前）注册进当前 scope。正文是纯字符串，
 *     每次保存设定后「先卸再挂」，所以侧边栏改完即刻对之后每一轮对话
 *     （含新开的对话）生效，不需要重载插件。
 *     注意：section 名不能用 `deployment:persona-prefix` / `-suffix` ——
 *     那是注册表自己保留的名字，全局重名注册会直接失败
 *     （见 @deepseek-ai/dsh-persona）。
 *  2. 存取：一个 fenced HTTP 路由 /cyrene/state（GET 读 / POST 写），
 *     客户端半通过它读写设定；落盘在 $DSH_HOME/cyrene-theme.json。
 *     写入走乐观并发：必须带上 GET 拿到的 rev，缺 rev（旧客户端半）
 *     直接 400 拒绝，rev 过期 409 交回最新快照 —— 这样没刷新的旧页面
 *     不可能再把别处的改动盖回去。
 *  3. 表情包与欢迎页形象：读包内 stickers.json（id → 文件 / 情绪 / 使用时机），
 *     把「怎么贴」的约定拼在人格正文末尾（所以关掉人格或没有素材时它自动消失），
 *     并通过 /cyrene/stickers（清单）、/cyrene/sticker/<id>（表情包字节）、
 *     /cyrene/hero（新会话欢迎页的形象，路径取自 state.hero.image）供页面取用。
 *     清单与 state.hero 是唯一真相：换图只改它们，插件本体与人格文本都不用动。
 *  4. 取证：/cyrene/report（POST 存 / GET 读，只存内存）。
 *     桌面外壳的活页面在受限沙箱里既截不了图也读不到 DOM，皮肤类视觉问题
 *     只能让页面自己把「哪些元素带 backdrop-filter、哪些大面积半透明」报上来。
 *
 * 不做的事：不碰模型请求、不改别的插件、不注册全局副作用。
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildEntries, matchEntries, packWorldbook, sanitizeEntries, summarizeEntries } from './host/worldbook.js'
import { cosine, embed } from './host/vector.js'
import {
  LEDGER_FILE,
  ledgerCount,
  readLedgerFile,
  syncLedgerFile,
  verifyLedger,
} from './host/ledger.js'
import {
  COMPRESS_ACTIVE_LIMIT,
  L0_FIELDS,
  L0_LABELS,
  L1_FIELDS,
  L1_LABELS,
  PIN_WEIGHT,
  RECALL_DEFAULT,
  TEXT_MAX,
  buildInjection,
  buildSummaryEntry,
  cleanInline,
  decayWeight,
  firstSentence,
  freshness,
  judgeCandidate,
  nextL0,
  nextL1,
  resolveL0Field,
  resolveL1Field,
  scoreRecall,
  selectCompressionCandidates,
  selectForInjection,
  similarity,
  statusOf,
  tokenize,
  touchWeight,
  weightToImportance,
  importanceToWeight,
  resolveInjectMaxChars,
} from './host/cognitive.js'
import { buildMemoryGraph } from './host/graph.js'
import { createMemoryLlm, resolveTimeoutMs } from './host/memory-llm.js'
import {
  buildRelationshipText,
  detectUserMood,
  deriveSignal,
  emptyRelationship,
  localDate,
  recordTurn,
  relationshipStage,
  relationshipSummary,
} from './host/relationship.js'
import { pickEmotionPresentation } from './live2d-map.js'
import { currentPetPhase, notePetEvent } from './host/pet.js'
import { eventText, looksInjected, shouldAutoCapture } from './host/text.js'
import {
  ASSET_TYPES,
  BACKGROUND_DIR,
  BG_DIM_MIN,
  BG_DIM_MAX,
  BG_INTERVAL_MIN,
  BG_INTERVAL_MAX,
  CUSTOM_BACKGROUND_DIR,
  CUSTOM_STICKER_DIR,
  DEFAULT_HERO,
  DEFAULT_PERSONA,
  MIME_EXT,
  MAX_ASSET_BYTES,
  MAX_BACKGROUND_BYTES,
  MAX_BACKGROUND_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  PACKAGE_ID,
  PLUGIN_DIR,
  PLUGIN_VERSION,
  applyPatch,
  clampDim,
  clampInterval,
  clampStickerSize,
  cleanBackgroundName,
  ensureLoaded,
  lastWrite,
  newStickerId,
  noteWrite,
  parseDataUrl,
  persist,
  sanitizeBackground,
  sanitizeCustomBackgrounds,
  sanitizeCustomStickers,
  sanitizeMemoryLlm,
  resetState,
  state,
  statePath,
} from './host/state.js'
import {
  MEMORY_FILE,
  MEMORY_INJECT_ITEMS,
  MEMORY_LIMIT,
  MEMORY_SECTION_BUDGET,
  MEMORY_SECTION_NAME,
  MEMORY_TAG_MAX,
  MEMORY_TEXT_MAX,
  MEMORY_TOOL_DEFAULT,
  PROFILE_HISTORY_KEEP,
  PROFILE_HISTORY_WEIGHT,
  PROFILE_L0_MAX,
  PROFILE_L1_BREAKS,
  PROFILE_L1_MAX,
  PROFILE_L1_SELF_MAX,
  cleanMemoryTags,
  cleanMemoryText,
  ensureMemories,
  ledgerReport,
  ledgerStateOf,
  memoryCounts,
  memoryHealthLine,
  memoryHealthValue,
  memoryLedgerPath,
  memoryPath,
  memoryStore,
  memoryText,
  newMemoryId,
  persistMemories,
  publicMemories,
  relationshipText,
  revealFile,
  sanitizeMemoryItem,
  sanitizeProfileFields,
  sanitizeRelationship,
  syncMemoryLedger,
  takeRecallEcho,
  resetMemoryStore,
} from './host/memory-store.js'
import {
  memoryLlmContext,
  memoryLlmFor,
  memoryLlmStatus,
  enqueueMemoryWork,
  resetMemoryLlm,
} from './host/memory-llm-runtime.js'
import {
  WORLDBOOK_ENTRY_SHOWN,
  WORLDBOOK_SECTION_BUDGET,
  WORLDBOOK_SECTION_NAME,
  WORLDBOOK_TOOL_BUDGET,
  WORLDBOOK_TOOL_DEFAULT,
  WORLDBOOK_WIKI_URL,
  clearWorldbookStore,
  ensureWorldbook,
  fetchWorldbook,
  publicWorldbook,
  registerWorldbookTools,
  resetWorldbookRuntime,
  searchWorldbook,
  worldbookPath,
  worldbookText,
} from './host/worldbook-runtime.js'
import {
  disposeMemorySectionNow,
  disposeRelationshipSectionNow,
  disposeWorldbookSectionNow,
  remountMemory,
  remountRelationship,
  remountWorldbook,
  resetSections,
  resolvePersonaOrder,
} from './host/sections.js'
import {
  absorbTurn,
  addMemory,
  organizeMemories,
  pinMemory,
  registerMemoryTools,
  registerCharacterMemoryTools,
  organizeCharacterMemory,
  resetMemoryOps,
} from './host/memory-ops.js'
import { GOLDEN_DESCENDANTS, delegationText } from './host/characters.js'
import { delegationCapability } from './host/delegation-adapter.js'
import { activeCount, hasActiveMember, noteAgentStatus, noteTeamEvent, publicDelegations, resetDelegations } from './host/delegation-state.js'
import { forgetAllForCharacter, loadCharacterMemory, saveCharacterMemory } from './host/character-memory.js'
import { pinItem } from './host/memory-core.js'

// 拆分后 state / 记忆库都是子模块单例：每次模块实例求值先归位，等价于一次真实重启。
// （测试用 `import(MOD + '?restart=1')` 模拟重启，子模块缓存不会跟着失效。）
resetState()
resetMemoryStore()
resetMemoryLlm()
resetWorldbookRuntime()
resetDelegations()
resetSections()
resetMemoryOps()

/** 本包自己的 section 名（不是保留名 deployment:persona）。 */
const SECTION_NAME = 'cyrene:persona'
/** fenced 路由前缀；客户端半请求 <base>/cyrene/state。 */
const ROUTE_PREFIX = '/cyrene'

/**
 * 「用量」独立窗口（GET /cyrene/usage）。
 *
 * 为什么单独一页而不是塞在设置面板里：
 *  1. Cyrene-Agent 的用量查看器本身就是一扇独立 GUI；
 *  2. 液态玻璃需要**背后有内容**才能看出来——设置面板背后是不透明底色，
 *     玻璃只会变成一块磨砂色块。这一页自带渐变背景，玻璃才立得住。
 *
 * 数据：页面自己向宿主 /api/session/list 取（同源，带登录 cookie）。
 * 价格：DeepSeek 公开价，未缓存输入 1 / 缓存命中 0.02 / 输出 4（闲时）8（峰值）元每百万。
 */
const USAGE_PAGE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>昔涟 · Token 用量</title>
<style>
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{
    margin:0;min-height:100vh;padding:18px;
    font:13px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;
    color:#3f2d3a;
    background:
      radial-gradient(1200px 600px at 12% -10%,#ffd9ec 0%,transparent 60%),
      radial-gradient(900px 500px at 100% 0%,#d7e6ff 0%,transparent 55%),
      radial-gradient(800px 700px at 50% 120%,#ffe9f3 0%,transparent 60%),
      linear-gradient(160deg,#fdf7fb 0%,#f4f7ff 48%,#fff5f9 100%);
    background-attachment:fixed;
  }
  .wrap{max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
  .card{
    position:relative;border-radius:20px;padding:16px 18px;
    background:linear-gradient(135deg,rgba(255,255,255,.62),rgba(255,255,255,.28) 46%,rgba(255,255,255,.5));
    border:1px solid rgba(255,255,255,.75);
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,.95),
      inset 0 -1px 0 rgba(255,255,255,.35),
      0 10px 30px rgba(178,120,160,.16);
    backdrop-filter:blur(22px) saturate(180%);
    -webkit-backdrop-filter:blur(22px) saturate(180%);
  }
  .head{display:flex;align-items:center;gap:10px;font-weight:600;font-size:13.5px;letter-spacing:.3px}
  .head .dot{color:#e8699f}
  .hero{display:flex;align-items:center;gap:16px}
  .ring{flex:0 0 auto;color:#e8699f}
  .ring.warm{color:#e8a33d}.ring.alert{color:#e0575b}
  .pct{font-size:30px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}
  .sub{font-size:11.5px;opacity:.62;margin-top:4px}
  .rows{display:flex;flex-direction:column;gap:6px;margin-top:10px}
  .row{display:flex;justify-content:space-between;gap:12px;font-variant-numeric:tabular-nums}
  .row span:first-child{opacity:.66}
  .bar{height:6px;border-radius:999px;background:rgba(200,150,180,.22);overflow:hidden;display:flex;margin-top:10px}
  .bar i{display:block;height:100%}
  .legend{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;font-size:11.5px;opacity:.7}
  .legend b{font-weight:600}
  .hint{font-size:11.5px;opacity:.55;text-align:center}
  @media (prefers-color-scheme:dark){
    body{color:#f4e7ef;background:
      radial-gradient(1200px 600px at 12% -10%,#4a2740 0%,transparent 60%),
      radial-gradient(900px 500px at 100% 0%,#22324f 0%,transparent 55%),
      linear-gradient(160deg,#211723 0%,#1a1f2b 50%,#241a24 100%)}
    .card{background:linear-gradient(135deg,rgba(58,40,54,.66),rgba(40,32,46,.42) 46%,rgba(58,42,56,.58));
      border-color:rgba(255,255,255,.16);
      box-shadow:inset 0 1px 0 rgba(255,255,255,.18),inset 0 -1px 0 rgba(255,255,255,.05),0 10px 30px rgba(0,0,0,.42)}
    .ring{color:#f19fc6}
  }
</style></head>
<body><div class="wrap">

  <div class="card">
    <div class="head"><span class="dot">✦</span><span>缓存命中率</span></div>
    <div class="hero">
      <span class="ring" id="ring"></span>
      <div>
        <div class="pct" id="pct">—</div>
        <div class="sub" id="hitsub">全部会话</div>
      </div>
    </div>
    <div class="bar" id="bar"><i id="barCache"></i><i id="barUnc"></i></div>
    <div class="legend">
      <span><b id="lgCache">0</b> 缓存读取</span>
      <span><b id="lgUnc">0</b> 未缓存</span>
      <span><b id="lgOut">0</b> 输出</span>
    </div>
  </div>

  <div class="card">
    <div class="head"><span class="dot">✦</span><span>估算花费</span></div>
    <div class="rows">
      <div class="row"><span>本次会话</span><b id="costCur">—</b></div>
      <div class="row"><span>全部会话</span><b id="costAll">—</b></div>
      <div class="row"><span>计价档</span><b id="tier">—</b></div>
    </div>
    <div class="sub" id="note">按 DeepSeek 公开价估算：未缓存 1 / 缓存 0.02 / 输出 4（闲时）8（峰值）元每百万 token</div>
  </div>

  <div class="hint" id="stamp">读取中…</div>
</div>
<script>
(function () {
  var PRICE = { input: 1, cache: 0.02, out: 4, outPeak: 8 };
  var RING_R = 26, RING_C = 2 * Math.PI * RING_R;

  function fmt(n) {
    n = Number(n || 0);
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(Math.round(n));
  }
  function money(n) { return "¥" + (n < 0.01 ? n.toFixed(4) : n.toFixed(2)); }
  function peak() {
    var d = new Date(), day = d.getDay(), h = d.getHours();
    if (day === 0 || day === 6) return false;
    return (h >= 9 && h < 12) || (h >= 14 && h < 18);
  }
  function paintRing(hit) {
    var ratio = Math.max(0, Math.min(1, (Number(hit) || 0) / 100));
    var el = document.getElementById("ring");
    el.className = "ring" + (hit >= 95 ? "" : hit >= 80 ? " warm" : " alert");
    el.innerHTML = '<svg width="76" height="76" viewBox="0 0 64 64">'
      + '<circle cx="32" cy="32" r="' + RING_R + '" fill="none" stroke="currentColor" stroke-opacity=".16" stroke-width="6"></circle>'
      + '<circle cx="32" cy="32" r="' + RING_R + '" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"'
      + ' stroke-dasharray="' + RING_C.toFixed(2) + '" stroke-dashoffset="' + (RING_C * (1 - ratio)).toFixed(2) + '"'
      + ' transform="rotate(-90 32 32)"></circle></svg>';
  }
  function rpc() {
    return fetch("/api/session/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        type: "client-request", rpcId: "usage-" + Date.now(),
        method: "session/list", payload: { args: { _request: {} } }
      })
    }).then(function (r) { return r.json(); });
  }
  function sumOf(items) {
    var s = { unc: 0, cache: 0, out: 0 };
    items.forEach(function (it) {
      var u = it && it.projections && it.projections.values && it.projections.values.tokenUsage;
      if (!u) return;
      s.unc += Number(u.uncachedInputTokens || 0);
      s.cache += Number(u.cacheReadTokens || 0);
      s.out += Number(u.outputTokens || 0);
    });
    return s;
  }
  function costOf(s) {
    var p = peak();
    return (s.unc / 1e6) * PRICE.input + (s.cache / 1e6) * PRICE.cache + (s.out / 1e6) * (p ? PRICE.outPeak : PRICE.out);
  }
  function refresh() {
    rpc().then(function (payload) {
      var items = (payload && payload.result && payload.result.value && payload.result.value.items) || [];
      var all = sumOf(items);
      var total = all.unc + all.cache;
      var hit = total === 0 ? 0 : (all.cache / total) * 100;
      paintRing(hit);
      document.getElementById("pct").textContent = hit.toFixed(1) + "%";
      document.getElementById("hitsub").textContent = items.length + " 个会话 · 未缓存 " + fmt(all.unc);
      document.getElementById("lgCache").textContent = fmt(all.cache);
      document.getElementById("lgUnc").textContent = fmt(all.unc);
      document.getElementById("lgOut").textContent = fmt(all.out);
      var bar = document.getElementById("bar");
      bar.children[0].style.width = (total === 0 ? 0 : (all.cache / total) * 100) + "%";
      bar.children[0].style.background = "linear-gradient(90deg,#f9a8d4,#e8699f)";
      bar.children[1].style.width = (total === 0 ? 0 : (all.unc / total) * 100) + "%";
      bar.children[1].style.background = "rgba(160,120,150,.35)";
      document.getElementById("costAll").textContent = money(costOf(all));
      var cur = document.getElementById("costCur");
      var holder = window.opener && window.opener.document
        ? window.opener.document.querySelector("[data-conversation-session]") : null;
      var sid = holder ? holder.getAttribute("data-conversation-session") : "";
      var mine = items.filter(function (it) { return it.sessionId === sid; });
      if (mine.length > 0) cur.textContent = money(costOf(sumOf(mine)));
      else cur.textContent = "（切换回主窗口刷新）";
      document.getElementById("tier").textContent = peak() ? "峰值（工作日 9-12 / 14-18）" : "闲时";
      document.getElementById("stamp").textContent = "更新于 " + new Date().toLocaleTimeString() + " · 每 5 秒自动刷新";
    }).catch(function (e) {
      document.getElementById("stamp").textContent = "读取失败：" + e.message;
    });
  }
  refresh();
  setInterval(refresh, 5000);
})();
</script></body></html>`
/** 请求体上限，防止一次误粘贴把提示词写爆。 */
const MAX_BODY_BYTES = 256 * 1024


/** 表情包清单：唯一真相，换图只改这个文件。 */
const STICKER_FILE = join(PLUGIN_DIR, 'stickers.json')

/**
 * Live2D 素材根目录：`assets/cyrene/`（模型、Cubism Core、贴图）。
 * 页面通过 `/cyrene/model/<相对路径>` 与 `/cyrene/live2dcubismcore.min.js` 取，
 * 只服务这个目录之下的文件——模型 JSON 里引用的贴图/动作/物理文件都按相对路径来。
 */
const LIVE2D_DIR = join(PLUGIN_DIR, 'assets', 'cyrene')
/** 模型文件比表情包大（high 贴图约 9MB），但也不能无上限地读。 */
const MAX_LIVE2D_BYTES = 32 * 1024 * 1024
/** Live2D 素材的类型：JSON / JS / 贴图 / moc3 二进制。 */
const LIVE2D_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.moc3': 'application/octet-stream',
}






/**
 * 客户端半打上来的活页面取证报告（只存内存，不落盘，重启即丢）。
 * 报告是诊断用的旁路：写失败、超限都只影响诊断，不影响主题与人格。
 */
let lastReport = null
/** 报告大小上限，防止页面把整棵 DOM 塞上来。 */
const MAX_REPORT_BYTES = 128 * 1024


/** 组合出给客户端半的状态快照（含默认底稿，供「恢复默认」按钮使用）。 */
function publicState() {
  return {
    persona: state.persona,
    enabled: state.enabled,
    theme: state.theme,
    stickers: state.stickers,
    /** 桌宠（Live2D）开关；字节与模型仍走 /cyrene/model/*。 */
    pet: state.pet,
    /** 聊天里贴图的最大边长（px）。 */
    stickerSize: state.stickerSize,
    /** 液态玻璃：不透明度（0.25 很透 → 0.95 几乎不透明）。 */
    glassAlpha: state.glassAlpha,
    /** 液态玻璃：真折射（SVG 位移滤镜），开销大，默认关。 */
    glassHeavy: state.glassHeavy,
    /** 自添加的表情包（条目在状态文件、文件在 stickers-custom/）。 */
    customStickers: state.customStickers.map((entry) => ({ ...entry })),
    /** 整页背景图的设定；可用素材清单走 /cyrene/backgrounds。 */
    background: { ...state.background },
    /** 自传的背景图（条目在状态文件、文件在 backgrounds-custom/）。 */
    customBackgrounds: state.customBackgrounds.map((entry) => ({ ...entry })),
    hero: {
      image: state.hero.image,
      title: state.hero.title,
      // ready=false 表示这张图现在读不出来（缺文件 / 类型不认识 / 太大），
      // 页面据此退回「只显示欢迎语」，而不是挂一个坏图。
      ready: heroAsset.ready === true,
      url: heroAsset.ready === true ? `${ROUTE_PREFIX}/hero` : null,
    },
    /** 记忆整理的云端 LLM 配置（只读快照；provider/model 空串＝自动）。 */
    memoryLlm: { ...state.memoryLlm },
    rev: state.rev,
    lastWrite,
    /** 安装进来的那份 package.json 的 version；设置页拿它显示小标签。 */
    version: PLUGIN_VERSION,
    defaultPersona: DEFAULT_PERSONA,
    statePath: statePath(),
  }
}





/**
 * 世界书（设定库）。和长期记忆是两件事：
 * - 记忆＝「你和这个人之间发生过什么」，会随时间长大；
 * - 世界书＝「这个世界本来是什么样」，从官方 wiki 抓来、体积大、只在被问到时才取用。
 *
 * 注入分两层：常驻只有一行「资料库里有什么 + 该去查」的索引（很省），
 * 真正的正文靠 `cyrene_worldbook_search` 按关键词取——命中才进上下文。
 */






/** 读完整请求体并解析 JSON（空体视为 {}）。limit 默认 256KB，上传图片时单独放宽。 */
async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error(`请求体过大（上限 ${limit} 字节）`)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text === '' ? {} : JSON.parse(text)
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

/**
 * 三个写入口共用的乐观并发闸门。
 * 通过时返回 false；拦下时已经把响应写完并返回 true（调用方直接 return）。
 */
function revRejected(res, body, rev = state.rev) {
  if (!Number.isInteger(body?.rev)) {
    noteWrite(body, 'client-outdated')
    sendJson(res, 400, {
      ok: false,
      error: { code: 'client-outdated', message: '这个页面还是旧版本，请按 F5 刷新后重试' },
    })
    return true
  }
  if (body.rev !== rev) {
    noteWrite(body, 'stale')
    sendJson(res, 409, {
      ok: false,
      error: { code: 'stale', message: '设定已在别处改动，已为你重新载入最新版本，请再操作一次' },
    })
    return true
  }
  return false
}

/**
 * 发一张包内图片：ETag 用「字节数-修改时间」，命中 if-none-match 回 304 省一次读盘。
 * 字节每次都现读，插件不在内存里缓存图片。
 */
async function sendAsset(req, res, item) {
  const etag = `"${item.bytes.toString(16)}-${item.mtimeMs.toString(16)}"`
  if (req.headers?.['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag })
    res.end()
    return
  }
  const bytes = await readFile(item.abs)
  res.writeHead(200, {
    'Content-Type': item.type,
    'Content-Length': bytes.length,
    'Cache-Control': 'private, max-age=300',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(bytes)
}

/**
 * 发一个 Live2D 素材。`relative` 是 `/cyrene/` 之后的相对路径（例如
 * `model/motions/动作#6_1.motion3.json`）；模型 JSON 里带 `#` 和中文，
 * 浏览器会把它编码成 %23 / %E5…，这里 decode 回来再对目录做一次越界检查。
 */
async function sendLive2dAsset(req, res, relative) {
  let decoded
  try {
    decoded = decodeURIComponent(relative)
  } catch {
    decoded = ''
  }
  if (decoded === '') {
    sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '缺资源路径' } })
    return
  }
  const abs = resolve(LIVE2D_DIR, decoded)
  if (abs !== LIVE2D_DIR && !abs.startsWith(LIVE2D_DIR + sep)) {
    sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: '只能取 assets/cyrene/ 下的文件' } })
    return
  }
  const type = LIVE2D_TYPES[extname(abs).toLowerCase()]
  let info = null
  try {
    info = await stat(abs)
  } catch {
    info = null
  }
  if (type === undefined || info === null || !info.isFile() || info.size > MAX_LIVE2D_BYTES) {
    sendJson(res, 404, {
      ok: false,
      error: { code: 'not-found', message: `assets/cyrene/ 里没有这个文件：${decoded}` },
    })
    return
  }
  await sendAsset(req, res, {
    abs,
    type,
    bytes: info.size,
    mtimeMs: Math.round(info.mtimeMs),
  })
}

/**
 * 表情包清单（包内 stickers.json）。items 里的 abs / type / bytes / mtimeMs
 * 都是加载时现算的；文件缺失或类型不认识的条目进 missing，既不进人格正文、
 * 也不给预览，但不影响插件其他能力。
 * 清单是唯一真相：换图、改名、调顺序都只改 json（页面刷新即生效）。
 */
let stickerPromise = null
let stickers = { version: 1, maxPerTurn: 1, items: [], missing: [], error: null }

async function ensureStickers(ctx, force) {
  if (stickerPromise !== null && force !== true) return stickerPromise
  stickerPromise = (async () => {
    const next = { version: 1, maxPerTurn: 1, items: [], missing: [], error: null }
    let parsed = null
    try {
      parsed = JSON.parse(await readFile(STICKER_FILE, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        next.error = error?.message ?? String(error)
        ctx?.logger?.warn?.(`${PACKAGE_ID}: 表情包清单读不出来，先当没有`, error)
      }
      stickers = next
      return next
    }
    if (Number.isInteger(parsed?.version) && parsed.version > 0) next.version = parsed.version
    if (Number.isFinite(parsed?.maxPerTurn) && parsed.maxPerTurn > 0) {
      next.maxPerTurn = Math.floor(parsed.maxPerTurn)
    }
    const items = Array.isArray(parsed?.items) ? parsed.items : []
    for (const raw of items) {
      if (raw === null || typeof raw !== 'object') continue
      const id = typeof raw.id === 'string' ? raw.id.trim() : ''
      const file = typeof raw.file === 'string' ? raw.file.trim() : ''
      if (id === '' || file === '') continue
      const abs = resolve(PLUGIN_DIR, file)
      // 只认包内文件：清单写歪了也不能把任意路径喂给浏览器。
      if (abs !== PLUGIN_DIR && !abs.startsWith(PLUGIN_DIR + sep)) {
        next.missing.push(file)
        continue
      }
      const type = ASSET_TYPES[extname(abs).toLowerCase()]
      if (type === undefined) {
        next.missing.push(file)
        continue
      }
      let info = null
      try {
        info = await stat(abs)
      } catch {
        next.missing.push(file)
        continue
      }
      if (!info.isFile() || info.size > MAX_ASSET_BYTES) {
        next.missing.push(file)
        continue
      }
      next.items.push({
        id,
        label: typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : id,
        when: typeof raw.when === 'string' ? raw.when.trim() : '',
        note: typeof raw.note === 'string' ? raw.note.trim() : '',
        file,
        // 提示词与 <img src> 都按 URL 语义解析，所以这里统一成正斜杠。
        abs: abs.replace(/\\/g, '/'),
        type,
        bytes: info.size,
        mtimeMs: Math.round(info.mtimeMs),
      })
    }
    // 用户自添加的：条目在状态文件里，文件在 stickers-custom/。
    // 和内置清单同一套规矩（只认认识的图片类型、不超过 8MB），
    // 只是路径固定在这个目录下，文件名永远只是 basename。
    for (const entry of Array.isArray(state.customStickers) ? state.customStickers : []) {
      const abs = join(CUSTOM_STICKER_DIR, entry.file)
      const type = ASSET_TYPES[extname(abs).toLowerCase()]
      let info = null
      try {
        info = await stat(abs)
      } catch {
        next.missing.push(entry.file)
        continue
      }
      if (type === undefined || !info.isFile() || info.size > MAX_ASSET_BYTES) {
        next.missing.push(entry.file)
        continue
      }
      next.items.push({
        id: entry.id,
        label: entry.label !== '' ? entry.label : entry.id,
        when: entry.when,
        note: '',
        file: entry.file,
        abs: abs.replace(/\\/g, '/'),
        type,
        bytes: info.size,
        mtimeMs: Math.round(info.mtimeMs),
        custom: true,
      })
    }
    stickers = next
    return next
  })()
  return stickerPromise
}

/** 给客户端半的清单快照（不含内部时间戳）。 */
function publicStickers() {
  return {
    version: stickers.version,
    maxPerTurn: stickers.maxPerTurn,
    enabled: state.stickers === true,
    error: stickers.error,
    missing: stickers.missing,
    items: stickers.items.map((item) => ({
      id: item.id,
      label: item.label,
      when: item.when,
      note: item.note,
      type: item.type,
      bytes: item.bytes,
      abs: item.abs,
      custom: item.custom === true,
      url: `${ROUTE_PREFIX}/sticker/${encodeURIComponent(item.id)}`,
    })),
  }
}

/**
 * 背景图清单：扫两个目录——随包发布的 `Background/` 和用户自传的
 * `backgrounds-custom/`。先包内、后自传，同一个文件名只留先出现的那条（id 唯一）。
 * 这里**没有清单文件**——丢进去什么就是什么，改名、加图、删图刷新即生效。
 * 不认识的扩展名、读不到的文件、超过 24MB 的一律跳过，不影响其他能力。
 * 用户传的那几条额外标 `custom: true`：客户端据此决定给不给删除按钮。
 */
let backgroundPromise = null
let backgrounds = { items: [], error: null }

async function ensureBackgrounds(ctx, force) {
  if (backgroundPromise !== null && force !== true) return backgroundPromise
  backgroundPromise = (async () => {
    const next = { items: [], error: null }
    const sources = [
      { dir: BACKGROUND_DIR, custom: false },
      { dir: CUSTOM_BACKGROUND_DIR, custom: true },
    ]
    const seen = new Set()
    // 自传的那几张用用户起的名字当显示名（文件名是生成的 id，给人看没意义）。
    const labels = new Map(state.customBackgrounds.map((entry) => [entry.file, entry.label]))
    for (const source of sources) {
      let entries = []
      try {
        entries = await readdir(source.dir, { withFileTypes: true })
      } catch (error) {
        // 自传目录还不存在是常态（一次都没传过），不当错误。
        if (error?.code !== 'ENOENT') {
          next.error = error?.message ?? String(error)
          ctx?.logger?.warn?.(`${PACKAGE_ID}: 背景目录读不出来，先当没有`, error)
        }
        continue
      }
      const names = entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }))
      for (const name of names) {
        if (seen.has(name)) continue
        const abs = join(source.dir, name)
        const type = ASSET_TYPES[extname(abs).toLowerCase()]
        if (type === undefined) continue
        let info = null
        try {
          info = await stat(abs)
        } catch {
          continue
        }
        if (!info.isFile() || info.size > MAX_BACKGROUND_BYTES) continue
        seen.add(name)
        const label = source.custom === true ? labels.get(name) : undefined
        next.items.push({
          // id 就是文件名：寻址前先在清单里找一遍，找不到就没有这条路由。
          id: name,
          name: typeof label === 'string' && label !== '' ? label : name,
          abs,
          type,
          bytes: info.size,
          mtimeMs: Math.round(info.mtimeMs),
          custom: source.custom,
        })
      }
    }
    backgrounds = next
    return next
  })()
  return backgroundPromise
}

/** 给客户端半的背景清单快照（不含磁盘绝对路径）。 */
function publicBackgrounds() {
  return {
    error: backgrounds.error,
    folder: 'Background',
    items: backgrounds.items.map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      bytes: item.bytes,
      custom: item.custom === true,
      url: `${ROUTE_PREFIX}/background/${encodeURIComponent(item.id)}`,
    })),
  }
}

/**
 * 欢迎页形象：/cyrene/hero 的字节来源。
 * 路径取自 state.hero.image，和表情包同一套规矩——只认包内文件、只认认识的图片类型、
 * 不超过 8MB；任何一条不满足就 ready=false，页面退回「只显示欢迎语」而不是挂一张坏图。
 */
let heroPromise = null
let heroAsset = { ready: false, reason: 'pending' }

async function ensureHero(ctx, force) {
  if (heroPromise !== null && force !== true) return heroPromise
  heroPromise = (async () => {
    const file = typeof state.hero.image === 'string' ? state.hero.image.trim() : ''
    const abs = file === '' ? '' : resolve(PLUGIN_DIR, file)
    const inside = abs !== '' && (abs === PLUGIN_DIR || abs.startsWith(PLUGIN_DIR + sep))
    const type = inside ? ASSET_TYPES[extname(abs).toLowerCase()] : undefined
    if (!inside || type === undefined) {
      heroAsset = { ready: false, reason: 'bad-path' }
      return heroAsset
    }
    let info = null
    try {
      info = await stat(abs)
    } catch {
      heroAsset = { ready: false, reason: 'missing' }
      return heroAsset
    }
    if (!info.isFile() || info.size > MAX_ASSET_BYTES) {
      heroAsset = { ready: false, reason: 'too-large' }
      return heroAsset
    }
    heroAsset = { ready: true, abs, type, bytes: info.size, mtimeMs: Math.round(info.mtimeMs) }
    return heroAsset
  })()
  return heroPromise
}


/** 按关键词取条目：总预算有限，放不下的那几条只报个数。 */

/**
 * 当前人格 section 的 disposer（每次重挂前先卸掉旧的）。
 * `null` 表示当前没有挂载。
 */
let disposeSection = null

/** 人格 section 的兜底落点。 */

/**
 * 表情包的使用约定 + 现成的贴图那一行。
 * 直接给出整行而不是「路径模板」：模型只要原样照抄就不会错（文件名里可能有空格、括号、非 ASCII）。
 */
function stickerText() {
  if (state.stickers !== true || stickers.items.length === 0) return ''
  const lines = [
    '',
    '【表情包】',
    `你有一套自己的表情包（${stickers.items.length} 张）。想贴一张的时候，在回复的最后单独占一行，原样写下面对应的整行（**路径连尖括号一起复制**，不要改写、不要自己拼）：`,
    '',
  ]
  for (const item of stickers.items) {
    const use = item.when === '' ? '' : `｜${item.when}`
    lines.push(`- ${item.label}${use} → ![昔涟·${item.label}](<${item.abs}>)`)
  }
  lines.push(
    '',
    `贴的规矩：一次回复最多 ${stickers.maxPerTurn} 张；只在情绪真的到了的时候贴（事情做成了、想鼓励你、想撒个娇、要道歉、被夸了）；代码、命令、报错和技术结论旁边不要贴；拿不准就不贴。`,
  )
  return lines.join('\n')
}

/** 关掉人格、或设定被清空时，交出空字符串（空 section 会被渲染阶段丢掉）。 */
function personaText() {
  if (state.enabled !== true || state.persona.trim() === '') return ''
  return state.persona + stickerText() + delegationText()
}

/**
 * 挂载（或重挂）人格 section。
 * 用「先卸再挂 + 纯字符串正文」而不是「正文写成函数」：
 * 前者只依赖最基础的那一版 API，任何 DSH 版本都成立，
 * 而每次保存后重挂同样能让新设定立刻生效。
 */
function remountPersona(prompt) {
  if (disposeSection !== null) {
    try {
      disposeSection()
    } catch {
      // 旧的已经跟着插件 fiber 一起消失了，忽略
    }
    disposeSection = null
  }
  disposeSection = prompt.section({
    name: SECTION_NAME,
    order: resolvePersonaOrder(prompt),
    text: personaText(),
  })
}

export const inject = ['webServer', 'systemPrompt']

export function apply(ctx, config) {
  // L2 探针：agentTeams 是可注入服务；拿不到就静默降级到纯提示词（L1）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['agentTeams'], (scoped) => {
      const capability = delegationCapability(scoped);
      ctx.logger?.info?.(
        `${PACKAGE_ID}: 黄金裔委托探针——` +
          (capability.available ? 'agentTeams 可用（L2 可落地）' : `agentTeams 不可用：${capability.reason}`),
      );
    });
  }
  if (typeof ctx.on === 'function') {
    ctx.on('agent/status', (payload) => {
      const agent = payload?.agent
      const sessionId = agent?.session?.header?.id ?? agent?.id
      noteAgentStatus(sessionId, payload?.status)
    })
  }
  // 委托租约：同角色不重复 spawn，并行上限 4 位（只约束 spawn_teammate，不碰其它工具）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (scoped) => {
      try {
        scoped.tools.guard((exec) => {
          if (exec === null || typeof exec !== 'object' || exec.name !== 'spawn_teammate') return undefined
          const name = exec.arguments?.name
          if (typeof name !== 'string' || name.trim() === '') return undefined
          if (hasActiveMember(name.trim())) return `「${name.trim()}」已经在跑：用 send_message 续，不要重复 spawn`
          if (activeCount() >= 4) return '并行委托已满（4 位活跃），先等一位结束再 spawn'
          return undefined
        })
      } catch (error) {
        ctx.logger?.warn?.(`${PACKAGE_ID}: 委托租约 guard 注册失败（不影响其它功能）`, error)
      }
    })
  }
  // 人格 section：名字用本包自己的，绝不使用注册表保留的
  // `deployment:persona-prefix` / `deployment:persona-suffix`。
  ctx.effect(() => {
    remountPersona(ctx.systemPrompt)
    return () => {
      if (disposeSection !== null) {
        try {
          disposeSection()
        } catch {
          // 交由插件 fiber 回收
        }
        disposeSection = null
      }
    }
  }, `${PACKAGE_ID}: persona section`)

  // 长期记忆三件套：数据、注入 section、工具。记忆文件读坏了也不影响插件启动。
  ctx.effect(() => {
    let disposeTools = null
    let disposeCharacterTools = null
    void ensureMemories(ctx).then(() => {
      remountMemory(ctx.systemPrompt)
      remountRelationship(ctx.systemPrompt)
      disposeTools = registerMemoryTools(ctx)
      disposeCharacterTools = registerCharacterMemoryTools(ctx)
    }).catch((error) => {
      ctx.logger?.warn?.(`${PACKAGE_ID}: 记忆工具注册失败（已跳过）`, error)
    })
    return () => {
      if (disposeTools !== null) {
        try {
          disposeTools()
        } catch {
          // 交由插件 fiber 回收
        }
        disposeTools = null
      }
      if (disposeCharacterTools !== null) {
        try {
          disposeCharacterTools()
        } catch {
          // 同上
        }
        disposeCharacterTools = null
      }
      disposeMemorySectionNow()
      disposeRelationshipSectionNow()
    }
  }, `${PACKAGE_ID}: memory`)

  // 关系管线：每一轮结束都把这一轮折进情绪环与关系值。
  // 写盘做 1.5s 防抖——连续几轮只落一次，不至于每条消息都 fsync。
  ctx.effect(() => {
    let pendingUser = ''
    let turnCounter = 0
    let absorbedTurn = -1
    let timer = null
    const flush = () => {
      timer = null
      void persistMemories(ctx)
    }
    const onSessionEvent = (_session, event) => {
      // 桌宠的活动阶段和关系是两件事，但都从同一条 session 事件流里读，
      // 放在一起可以少注册一个监听（阶段计算很轻）。
      notePetEvent(event)
      noteTeamEvent(event)
      const type = event?.type
      if (type === 'user/message') {
        const text = eventText(event)
        // 只认用户亲手打的字：宿主注入的运行时上下文 / 后台任务通知不算一轮，
        // 也不能进记忆（它们会把记忆库淹掉）。
        const kind = event?.data?.source?.kind
        const authored = typeof kind === 'string' ? kind === 'user' : !looksInjected(text)
        if (authored && text !== '') {
          pendingUser = text
          turnCounter += 1
        }
        return
      }
      if (type !== 'assistant/message') return
      if (absorbedTurn === turnCounter) return
      absorbedTurn = turnCounter
      const assistantText = eventText(event)
      if (pendingUser === '' && assistantText === '') return
      absorbTurn(pendingUser, assistantText, ctx)
      remountRelationship(ctx.systemPrompt)
      if (timer === null) timer = setTimeout(flush, 1500)
      if (typeof timer?.unref === 'function') timer.unref()
    }
    const off = typeof ctx.on === 'function' ? ctx.on('session/event', onSessionEvent) : null
    return () => {
      if (timer !== null) clearTimeout(timer)
      if (typeof off === 'function') {
        try {
          off()
        } catch {
          // 已随 fiber 回收
        }
      } else if (off !== null && typeof off?.dispose === 'function') {
        off.dispose()
      }
    }
  }, `${PACKAGE_ID}: relationship`)

  // 世界书：数据 + 一行索引 section + 检索工具。资料库不存在就安静地什么都不挂。
  ctx.effect(() => {
    let disposeWorldbookTools = null
    void ensureWorldbook(ctx).then(() => {
      remountWorldbook(ctx.systemPrompt)
      disposeWorldbookTools = registerWorldbookTools(ctx)
    }).catch((error) => {
      ctx.logger?.warn?.(`${PACKAGE_ID}: 世界书工具注册失败（已跳过）`, error)
    })
    return () => {
      if (disposeWorldbookTools !== null) {
        try {
          disposeWorldbookTools()
        } catch {
          // 交由插件 fiber 回收
        }
        disposeWorldbookTools = null
      }
      disposeWorldbookSectionNow()
    }
  }, `${PACKAGE_ID}: worldbook`)

  // 设定与表情包清单都就绪之后再重挂一次：文件里的版本盖过默认底稿，
  // 人格正文也顺带带上表情包约定。
  // ⚠️ 必须带 catch：Node 18+ 的未处理 rejection 默认会**直接结束进程**，
  // 那样整个 DSH 宿主（用户的 GUI）都会被这个插件带走。这里降级成一条 warn。
  void Promise.all([ensureLoaded(ctx), ensureStickers(ctx), ensureBackgrounds(ctx), ensureHero(ctx), ensureMemories(ctx), ensureWorldbook(ctx)]).then(() => {
    remountPersona(ctx.systemPrompt)
    remountMemory(ctx.systemPrompt)
    remountRelationship(ctx.systemPrompt)
    remountWorldbook(ctx.systemPrompt)
    ctx.logger?.info?.(`${PACKAGE_ID}: 表情包 ${stickers.items.length} 张（清单 ${STICKER_FILE}）；欢迎页形象 ${heroAsset.ready === true ? state.hero.image : '未就绪（' + heroAsset.reason + '）'}`)
  }).catch((error) => {
    ctx.logger?.warn?.(`${PACKAGE_ID}: 启动初始化失败（已降级，其余功能照常）`, error)
  })

  // fenced 状态路由。GET /cyrene/state 读，POST /cyrene/state 写。
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'
        try {
          if (route === '/usage' && req.method === 'GET') {
            // 独立的「用量」窗口：Cyrene-Agent 是单独一扇 GUI，这里也做成独立页，
            // 顺便解决液态玻璃在没有背景的面板里看不出来的问题（这页自带渐变背景）。
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
            })
            res.end(USAGE_PAGE_HTML)
            return
          }
          if (route === '/state' && req.method === 'GET') {
            await Promise.all([ensureLoaded(ctx), ensureHero(ctx)])
            sendJson(res, 200, { ok: true, value: publicState() })
            return
          }
          if (route === '/state' && req.method === 'POST') {
            await ensureLoaded(ctx)
            const body = await readJsonBody(req)
            // 写入必须声明"我读到的是哪一版"：旧版客户端半（或任何不带 rev 的脚本）
            // 一律拒绝，版本对不上就交回最新快照让客户端自己重来。
            if (revRejected(res, body)) return
            const changed = applyPatch(body)
            if (changed) {
              state.rev += 1
              // 换了欢迎页形象就重新解析一次（同一份路径可能只是换了张图）。
              if (body.hero !== undefined) {
                heroPromise = null
                await ensureHero(ctx)
              }
              await persist(ctx)
              // 立刻按新设定重挂 section：从下一轮对话起就是新口吻。
              remountPersona(ctx.systemPrompt)
            }
            noteWrite(body, changed ? 'ok' : 'noop')
            sendJson(res, 200, { ok: true, value: publicState() })
            return
          }
          if (route === '/stickers' && req.method === 'GET') {
            await ensureStickers(ctx, url.searchParams.get('reload') === '1')
            sendJson(res, 200, { ok: true, value: publicStickers() })
            return
          }
          if (route === '/delegation' && req.method === 'GET') {
            // 把 slug 映射回中文名与头像，客户端不用自己再查一遍。
            const bySlug = new Map(GOLDEN_DESCENDANTS.map((item) => [item.slug, item]))
            const snapshot = publicDelegations()
            sendJson(res, 200, {
              ok: true,
              value: {
                ...snapshot,
                members: snapshot.members.map((member) => {
                  const who = bySlug.get(member.name)
                  return {
                    ...member,
                    name: who ? who.name : member.name,
                    avatar: who ? `${ROUTE_PREFIX}/character/${encodeURIComponent(who.name)}` : null,
                  }
                }),
              },
            })
            return
          }
          if (route === '/character-memory' && req.method === 'GET') {
            const slug = typeof url.searchParams.get('slug') === 'string' ? url.searchParams.get('slug').trim() : ''
            const store = await loadCharacterMemory(slug)
            sendJson(res, 200, {
              ok: true,
              value: {
                slug,
                count: store.items.length,
                error: store.error,
                items: store.items.map((item) => ({
                  id: item.id, text: item.text, tags: item.tags, created: item.created, weight: item.weight,
                })),
              },
            })
            return
          }
          if (route === '/character-graph' && req.method === 'GET') {
            // 角色自己的记忆星图：和昔涟的星图同一套 buildMemoryGraph，只是数据源是独立文件。
            const slug = typeof url.searchParams.get('slug') === 'string' ? url.searchParams.get('slug').trim() : ''
            const store = await loadCharacterMemory(slug)
            const graph = buildMemoryGraph({ items: store.items, now: Date.now() })
            sendJson(res, 200, { ok: true, value: { slug, ...graph, count: store.items.length } })
            return
          }
          if (route === '/character-organize' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const slug = typeof body?.slug === 'string' ? body.slug.trim() : ''
            const result = await organizeCharacterMemory(ctx, slug)
            sendJson(res, 200, { ok: true, value: result })
            return
          }
          if (route === '/character-memory/remove' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const slug = String(body?.slug ?? '').trim()
            const id = String(body?.id ?? '').trim()
            const store = await loadCharacterMemory(slug)
            const index = store.items.findIndex((item) => item.id === id)
            if (index < 0) {
              sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '这条记忆已经不在了' } })
              return
            }
            store.items.splice(index, 1)
            await saveCharacterMemory(slug, store.items)
            sendJson(res, 200, { ok: true, value: { count: store.items.length } })
            return
          }
          if (route === '/character-memory/pin' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const slug = String(body?.slug ?? '').trim()
            const id = String(body?.id ?? '').trim()
            const store = await loadCharacterMemory(slug)
            const item = store.items.find((entry) => entry.id === id)
            if (item === undefined) {
              sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '这条记忆已经不在了' } })
              return
            }
            pinItem(item, body?.pinned !== false)
            await saveCharacterMemory(slug, store.items)
            sendJson(res, 200, { ok: true, value: { pinned: item.pinned, weight: item.weight } })
            return
          }
          if (route === '/character-memory/clear' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const slug = String(body?.slug ?? '').trim()
            if (slug === '') {
              sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺 slug' } })
              return
            }
            await forgetAllForCharacter(slug)
            sendJson(res, 200, { ok: true, value: { count: 0 } })
            return
          }
          if (route === '/characters' && req.method === 'GET') {
            // 黄金裔角色卡（L3 静态版）：头像走下面的字节路由，正文只在面板里展示。
            sendJson(res, 200, {
              ok: true,
              value: {
                characters: GOLDEN_DESCENDANTS.map((item) => ({
                  name: item.name,
                  brief: item.persona,
                  slug: item.slug,
                  avatar: `${ROUTE_PREFIX}/character/${encodeURIComponent(item.name)}`,
                })),
              },
            })
            return
          }
          if (route.startsWith('/character/') && req.method === 'GET') {
            const name = decodeURIComponent(route.slice('/character/'.length))
            if (!GOLDEN_DESCENDANTS.some((item) => item.name === name)) {
              sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '没有这位黄金裔' } })
              return
            }
            const abs = join(PLUGIN_DIR, 'assets', 'characters', `${name}.png`)
            try {
              const info = await stat(abs)
              await sendAsset(req, res, { abs, bytes: info.size, mtimeMs: Math.round(info.mtimeMs), type: 'image/png' })
            } catch {
              sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '这张头像读不出来' } })
            }
            return
          }
          if (route === '/stickers' && req.method === 'POST') {
            await ensureLoaded(ctx)
            const body = await readJsonBody(req, MAX_UPLOAD_BYTES)
            if (revRejected(res, body)) return
            const parsed = parseDataUrl(body?.data)
            if (parsed === null) {
              sendJson(res, 400, {
                ok: false,
                error: { code: 'bad-image', message: '图片数据读不出来（只接受 data:image/*;base64,…）' },
              })
              return
            }
            // 扩展名优先信 data URL 里的 mime（浏览器给的最准），
            // 认不出来时退回文件名后缀。
            const named = ASSET_TYPES[extname(typeof body?.name === 'string' ? body.name : '').toLowerCase()]
            const ext = MIME_EXT[parsed.mime] ?? named
            if (ext === undefined) {
              sendJson(res, 400, {
                ok: false,
                error: { code: 'bad-type', message: `不认识的图片类型：${parsed.mime}` },
              })
              return
            }
            if (parsed.bytes.length > MAX_ASSET_BYTES) {
              sendJson(res, 400, {
                ok: false,
                error: {
                  code: 'too-large',
                  message: `图片太大（${parsed.bytes.length} 字节，上限 ${MAX_ASSET_BYTES}）`,
                },
              })
              return
            }
            const id = newStickerId()
            const file = `${id}${ext}`
            await mkdir(CUSTOM_STICKER_DIR, { recursive: true })
            await writeFile(join(CUSTOM_STICKER_DIR, file), parsed.bytes)
            state.customStickers.push({
              id,
              file,
              label: typeof body.label === 'string' && body.label.trim() !== ''
                ? body.label.trim().slice(0, 40)
                : file,
              when: typeof body.when === 'string' ? body.when.trim().slice(0, 200) : '',
            })
            state.rev += 1
            await persist(ctx)
            await ensureStickers(ctx, true)
            // 新贴纸要立刻能贴：人格正文里的清单跟着重挂。
            remountPersona(ctx.systemPrompt)
            noteWrite(body, 'ok')
            sendJson(res, 200, { ok: true, value: { state: publicState(), stickers: publicStickers() } })
            return
          }
          if (route === '/stickers/remove' && req.method === 'POST') {
            await ensureLoaded(ctx)
            const body = await readJsonBody(req)
            if (revRejected(res, body)) return
            const id = typeof body?.id === 'string' ? body.id.trim() : ''
            const index = state.customStickers.findIndex((entry) => entry.id === id)
            if (index === -1) {
              sendJson(res, 404, {
                ok: false,
                error: { code: 'not-found', message: `没有这张自定义表情包：${id}` },
              })
              return
            }
            const [removed] = state.customStickers.splice(index, 1)
            await rm(join(CUSTOM_STICKER_DIR, removed.file), { force: true })
            state.rev += 1
            await persist(ctx)
            await ensureStickers(ctx, true)
            remountPersona(ctx.systemPrompt)
            noteWrite(body, 'ok')
            sendJson(res, 200, { ok: true, value: { state: publicState(), stickers: publicStickers() } })
            return
          }
          if (route.startsWith('/sticker/') && req.method === 'GET') {
            await ensureStickers(ctx)
            const id = decodeURIComponent(route.slice('/sticker/'.length))
            const item = stickers.items.find((entry) => entry.id === id)
            if (item === undefined) {
              sendJson(res, 404, {
                ok: false,
                error: { code: 'not-found', message: `没有这张表情包：${id}` },
              })
              return
            }
            await sendAsset(req, res, item)
            return
          }
          if (route === '/memory/reveal' && req.method === 'POST') {
            // 「在文件管理器里打开」：浏览器做不到，只能由宿主进程去把窗口叫出来。
            // 先落一次盘，保证资源管理器里真的有东西可选（幂等，内容一样）。
            await ensureMemories(ctx)
            await persistMemories(ctx)
            const target = memoryPath()
            const opened = revealFile(target)
            if (opened !== true) {
              ctx?.logger?.warn?.(`${PACKAGE_ID}: 没能打开文件管理器（${target}）`)
            }
            sendJson(res, 200, { ok: true, value: { opened, path: target } })
            return
          }
          if (route === '/memory/raw' && req.method === 'GET') {
            // 原文视图：让用户能一眼看到 cyrene-memory.json 里到底存了什么，
            // 也方便他复制路径去资源管理器里备份 / 手改 / 整个删掉。
            // 用 text/plain 而不是 application/json —— 后者在浏览器里可能触发下载，
            // 我们要的是「打开就能读」。
            await ensureMemories(ctx)
            let text = ''
            try {
              text = await readFile(memoryPath(), 'utf8')
            } catch (error) {
              if (error?.code !== 'ENOENT') throw error
              // 还没落过盘：现拼一份和落盘格式一致的快照，别为了看一眼就建文件。
              text = JSON.stringify({
                enabled: memoryStore.enabled,
                rev: memoryStore.rev,
                items: memoryStore.items,
              }, null, 2)
            }
            res.writeHead(200, {
              'Content-Type': 'text/plain; charset=utf-8',
              'Content-Length': Buffer.byteLength(text),
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            })
            res.end(text)
            return
          }
          if (route === '/memory/ledger' && req.method === 'GET') {
            // 账本状态（实施单 §5.2）：entries / mismatched / missing 都是 id 数组。
            // 外层 ok 是路由信封，内层 ok 才是「账本对得上」——两者分开，客户端好判断。
            await ensureMemories(ctx, url.searchParams.get('reload') === '1')
            const report = await ledgerReport()
            sendJson(res, 200, {
              ok: true,
              value: {
                ok: report.ok,
                entries: report.entries,
                mismatched: report.mismatched,
                missing: report.missing,
                unledgered: report.unledgered,
                checked: report.checked,
                exists: report.exists,
                error: report.error,
                ledgerPath: report.ledgerPath,
              },
            })
            return
          }
          if (route === '/memory/health' && req.method === 'GET') {
            // 每日健康一行（实施单 §5.3）：一行给日志，结构化字段给面板与工具。
            await ensureMemories(ctx, url.searchParams.get('reload') === '1')
            const report = await ledgerReport()
            sendJson(res, 200, { ok: true, value: memoryHealthValue(report) })
            return
          }
          if (route === '/memory/llm' && req.method === 'GET') {
            // 记忆整理当前走哪条路：available=false 就是「不可用，已回退规则」。
            // 这里会真的等一次 provider/model 解析，所以返回的是可调用状态而不是配置值。
            await ensureLoaded(ctx)
            const status = await memoryLlmStatus(ctx)
            sendJson(res, 200, { ok: true, value: status })
            return
          }
          if (route === '/memory/models' && req.method === 'GET') {
            // 面板里给用户挑模型用：列出 host 认识的所有 provider 及其模型。
            // 空 provider/model 仍然是"自动"——我们只把选项摆出来，不替用户决定。
            const llm = ctx.get?.('llm') ?? null
            const providers = []
            const models = []
            if (llm !== null && typeof llm.listProviders === 'function') {
              let list = []
              try { list = llm.listProviders() ?? [] } catch { list = [] }
              for (const entry of Array.isArray(list) ? list : []) {
                const id = typeof entry === 'string' ? entry : (entry?.id ?? entry?.provider ?? '')
                if (typeof id !== 'string' || id === '') continue
                providers.push(id)
                if (typeof llm.listModels === 'function') {
                  let items = []
                  try { items = await llm.listModels(id) } catch { items = [] }
                  for (const model of Array.isArray(items) ? items : []) {
                    if (typeof model?.id !== 'string' || model.id === '') continue
                    models.push({ provider: id, id: model.id, name: model.name ?? model.id })
                  }
                }
              }
            }
            sendJson(res, 200, { ok: true, value: { providers, models } })
            return
          }
          if (route === '/memory/llm' && req.method === 'POST') {
            // 保存配置：{ enabled, provider, model, timeoutMs }，空串 = 自动解析。
            await ensureLoaded(ctx)
            const body = await readJsonBody(req)
            const patch = body?.memoryLlm !== null && typeof body?.memoryLlm === 'object' ? body.memoryLlm : body
            const next = sanitizeMemoryLlm(patch)
            if (JSON.stringify(next) !== JSON.stringify(state.memoryLlm)) {
              state.memoryLlm = next
              state.rev += 1
              resetMemoryLlm()
              await persist(ctx)
            }
            const status = await memoryLlmStatus(ctx)
            noteWrite(body, 'ok')
            sendJson(res, 200, { ok: true, value: status })
            return
          }
          if (route === '/memory/organize' && req.method === 'POST') {
            // 面板上的「整理记忆」按钮：手动触发一次 LLM 整理。
            // 和 cyrene_memory_organize 工具走同一段逻辑，避免两处漂移。
            await ensureLoaded(ctx)
            const body = await readJsonBody(req)
            const result = await organizeMemories(ctx, body?.limit)
            noteWrite(body, result.ok === true ? 'ok' : 'error')
            sendJson(res, result.ok === true ? 200 : 409, result.ok === true
              ? { ok: true, value: result }
              : { ok: false, error: { code: 'organize-failed', message: result.error ?? '整理失败' } })
            return
          }
          if (route === '/memory' && req.method === 'GET') {
            await ensureMemories(ctx, url.searchParams.get('reload') === '1')
            sendJson(res, 200, { ok: true, value: publicMemories() })
            return
          }
          if (route === '/memory/graph' && req.method === 'GET') {
            // 记忆星图：只读快照，不触发任何写入。`?reload=1` 强制重读磁盘，
            // 和 /memory、/memory/ledger 的 reload 语义保持一致。
            await ensureMemories(ctx, url.searchParams.get('reload') === '1')
            const now = Date.now()
            const graph = buildMemoryGraph({
              items: memoryStore.items,
              profile: memoryStore.profile,
              now,
            })
            sendJson(res, 200, {
              ok: true,
              value: {
                nodes: graph.nodes,
                edges: graph.edges,
                generatedAt: new Date(now).toISOString(),
              },
            })
            return
          }
          if (route === '/memory' && req.method === 'POST') {
            await ensureMemories(ctx)
            const body = await readJsonBody(req)
            // 记忆有自己的版本号：它和主题设定是两份数据，别互相把 rev 顶掉。
            if (revRejected(res, body, memoryStore.rev)) return
            const action = typeof body?.action === 'string' ? body.action : ''
            let itemsChanged = false
            if (action === 'toggle') {
              memoryStore.enabled = body?.enabled !== false
            } else if (action === 'add') {
              if (addMemory(body?.text, body?.tags, { ctx }) === null) {
                sendJson(res, 400, { ok: false, error: { code: 'empty-text', message: '先写点要记的东西' } })
                return
              }
              // add 里可能发生了合并：正文被换掉，账本按纪律不覆盖，交给 verify 报。
              itemsChanged = true
            } else if (action === 'remove') {
              const id = typeof body?.id === 'string' ? body.id : ''
              const index = memoryStore.items.findIndex((item) => item.id === id)
              if (index < 0) {
                sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '这条记忆已经不在了' } })
                return
              }
              memoryStore.items.splice(index, 1)
              itemsChanged = true
            } else if (action === 'clear') {
              memoryStore.items = []
              itemsChanged = true
            } else if (action === 'pin') {
              // 钉住 / 取消钉住（实施单 §9.3 的保护线）。只动成色与状态，不改正文，
              // 所以不补账——账本对正文的承诺没变。
              const id = typeof body?.id === 'string' ? body.id : ''
              const item = memoryStore.items.find((entry) => entry.id === id)
              if (item === undefined) {
                sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '这条记忆已经不在了' } })
                return
              }
              pinMemory(item, body?.pinned !== false)
            } else {
              sendJson(res, 400, { ok: false, error: { code: 'bad-action', message: `不认识的动作：${action}` } })
              return
            }
            memoryStore.rev += 1
            await persistMemories(ctx)
            // 实施单 §5.2：记忆变了就补账（只补新 id；删/清空不会回抹账本）。
            if (itemsChanged) await syncMemoryLedger(ctx)
            remountMemory(ctx.systemPrompt)
            // 关掉开关时关系 section 也得跟着卸，否则「关了记忆」却还留一段关系。
            remountRelationship(ctx.systemPrompt)
            sendJson(res, 200, { ok: true, value: publicMemories() })
            return
          }
          if (route === '/memory/profile' && req.method === 'GET') {
            await ensureMemories(ctx, url.searchParams.get('reload') === '1')
            // 画像 + 近况 + 关系：面板一张卡就能把「她记得的你」和「你们现在怎样」
            // 一起画出来。已有的 l0 / l1 字段原样保留，relation 是只增的部分。
            const publicMemory = publicMemories()
            sendJson(res, 200, {
              ok: true,
              value: {
                ...publicMemory.profile,
                relationship: {
                  ...publicMemory.relationship,
                  // 阶段结构化给面板用（summary 仍是给人看的一行字）。
                  stage: relationshipStage(memoryStore.relationship),
                },
              },
            })
            return
          }
          if (route === '/relationship' && req.method === 'GET') {
            await ensureMemories(ctx, url.searchParams.get('reload') === '1')
            const publicMemory = publicMemories()
            sendJson(res, 200, { ok: true, value: publicMemory.relationship })
            return
          }
          if (route === '/relationship' && req.method === 'POST') {
            await ensureMemories(ctx)
            const body = await readJsonBody(req)
            if (revRejected(res, body, memoryStore.rev)) return
            const action = typeof body?.action === 'string' ? body.action : ''
            if (action === 'reset') {
              memoryStore.relationship = emptyRelationship()
            } else if (action === 'nudge') {
              // 手动调一格：面板上「拉近一点 / 退开一点」用，单次幅度固定 ±5。
              const direction = body?.direction === 'down' ? -1 : 1
              memoryStore.relationship = {
                ...memoryStore.relationship,
                affinity: Math.min(100, Math.max(0, (memoryStore.relationship.affinity ?? 0) + 5 * direction)),
                updatedAt: Date.now(),
              }
            } else {
              sendJson(res, 400, { ok: false, error: { code: 'bad-action', message: `不认识的动作：${action}` } })
              return
            }
            memoryStore.rev += 1
            await persistMemories(ctx)
            remountRelationship(ctx.systemPrompt)
            sendJson(res, 200, { ok: true, value: publicMemories().relationship })
            return
          }
          if (route === '/worldbook' && req.method === 'GET') {
            await ensureWorldbook(ctx, url.searchParams.get('reload') === '1')
            // 磁盘上的库变了（用户自己换了文件）也要跟着挂/卸那一行索引，
            // remountWorldbook 里有正文比对，正文没变不会反复重挂。
            remountWorldbook(ctx.systemPrompt)
            sendJson(res, 200, { ok: true, value: publicWorldbook() })
            return
          }
          if (route === '/worldbook' && req.method === 'POST') {
            await ensureWorldbook(ctx)
            const body = await readJsonBody(req)
            const action = typeof body?.action === 'string' ? body.action : ''
            if (action === 'reload') {
              await ensureWorldbook(ctx, true)
            } else if (action === 'clear') {
              // 只删这份资料库；人格、记忆、主题设定都不受影响。
              await rm(worldbookPath(), { force: true })
              clearWorldbookStore()
            } else if (action === 'fetch') {
              try {
                await fetchWorldbook()
              } catch (error) {
                sendJson(res, 502, {
                  ok: false,
                  error: { code: 'fetch-failed', message: String(error?.message || error) },
                })
                return
              }
            } else {
              sendJson(res, 400, { ok: false, error: { code: 'bad-action', message: `不认识的动作：${action}` } })
              return
            }
            remountWorldbook(ctx.systemPrompt)
            sendJson(res, 200, { ok: true, value: publicWorldbook() })
            return
          }
          if (route === '/worldbook/reveal' && req.method === 'POST') {
            // 「打开文件位置」：浏览器做不到这件事，只能由宿主进程把系统文件管理器叫出来。
            // 世界书是用户自己的文件（几十万字），想看就去看，但不在面板里铺开。
            await ensureWorldbook(ctx)
            const target = worldbookPath()
            // 看磁盘而不是看内存里那份清单：用户手放了文件、或 store 还没载入，
            // 只要文件真的在就该能打开。反过来文件不在就别叫窗口出来。
            let onDisk = false
            try {
              onDisk = (await stat(target)).isFile()
            } catch {
              onDisk = false
            }
            if (!onDisk) {
              // 故意不用 `not-found`：那个码和「没有这个路由」撞车，
              // 客户端分不清「宿主半是旧版」和「还没有文件」。
              sendJson(res, 409, {
                ok: false,
                error: { code: 'no-worldbook', message: '还没有世界书文件，先抓取一次' },
              })
              return
            }
            const opened = revealFile(target)
            if (opened !== true) {
              ctx?.logger?.warn?.(`${PACKAGE_ID}: 没能打开文件管理器（${target}）`)
            }
            sendJson(res, 200, { ok: true, value: { opened, path: target } })
            return
          }
          if (route === '/worldbook/raw' && req.method === 'GET') {
            // 和记忆一样：让用户能直接看到原文（几十万字，浏览器里按纯文本打开）。
            await ensureWorldbook(ctx)
            let text = ''
            try {
              text = await readFile(worldbookPath(), 'utf8')
            } catch (error) {
              if (error?.code !== 'ENOENT') throw error
              text = JSON.stringify(packWorldbook(worldbookStore.entries, {
                source: worldbookStore.source,
                sourceVersion: worldbookStore.version,
                fetchedAt: worldbookStore.fetchedAt,
              }), null, 2)
            }
            res.writeHead(200, {
              'Content-Type': 'text/plain; charset=utf-8',
              'Content-Length': Buffer.byteLength(text),
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            })
            res.end(text)
            return
          }
          if (route === '/backgrounds' && req.method === 'GET') {
            await ensureBackgrounds(ctx, url.searchParams.get('reload') === '1')
            sendJson(res, 200, { ok: true, value: publicBackgrounds() })
            return
          }
          if (route === '/backgrounds' && req.method === 'POST') {
            await ensureLoaded(ctx)
            const body = await readJsonBody(req, MAX_BACKGROUND_UPLOAD_BYTES)
            if (revRejected(res, body)) return
            const parsed = parseDataUrl(body?.data)
            if (parsed === null) {
              sendJson(res, 400, {
                ok: false,
                error: { code: 'bad-image', message: '图片数据读不出来（只接受 data:image/*;base64,…）' },
              })
              return
            }
            // 扩展名优先信 data URL 里的 mime，认不出来时退回文件名后缀。
            const named = ASSET_TYPES[extname(typeof body?.name === 'string' ? body.name : '').toLowerCase()]
            const ext = MIME_EXT[parsed.mime] ?? named
            if (ext === undefined) {
              sendJson(res, 400, {
                ok: false,
                error: { code: 'bad-type', message: `不认识的图片类型：${parsed.mime}` },
              })
              return
            }
            if (parsed.bytes.length > MAX_BACKGROUND_BYTES) {
              sendJson(res, 400, {
                ok: false,
                error: {
                  code: 'too-large',
                  message: `背景图太大（${Math.round(parsed.bytes.length / 1024 / 1024)}MB，上限 ${MAX_BACKGROUND_BYTES / 1024 / 1024}MB）`,
                },
              })
              return
            }
            const id = newStickerId()
            const file = `${id}${ext}`
            await mkdir(CUSTOM_BACKGROUND_DIR, { recursive: true })
            await writeFile(join(CUSTOM_BACKGROUND_DIR, file), parsed.bytes)
            const label = typeof body.label === 'string' && body.label.trim() !== ''
              ? body.label.trim().slice(0, 60)
              : file
            state.customBackgrounds.push({ id, file, label })
            state.rev += 1
            await persist(ctx)
            await ensureBackgrounds(ctx, true)
            noteWrite(body, 'ok')
            sendJson(res, 200, { ok: true, value: { state: publicState(), backgrounds: publicBackgrounds() } })
            return
          }
          if (route === '/backgrounds/remove' && req.method === 'POST') {
            await ensureLoaded(ctx)
            const body = await readJsonBody(req)
            if (revRejected(res, body)) return
            const id = typeof body?.id === 'string' ? body.id.trim() : ''
            // 客户端拿到的 id 是清单里的文件名（锚点也用它），state 里存的是元数据 id；
            // 两种写法都认，免得删除按钮因为差一个后缀就 404。
            const index = state.customBackgrounds.findIndex((entry) => entry.id === id || entry.file === id)
            if (index === -1) {
              sendJson(res, 404, {
                ok: false,
                error: { code: 'not-found', message: `没有这张自定义背景图：${id}` },
              })
              return
            }
            const [removed] = state.customBackgrounds.splice(index, 1)
            await rm(join(CUSTOM_BACKGROUND_DIR, removed.file), { force: true })
            // 删掉的正是"起点"：退回目录顺序第一张，别留一个悬空的 id。
            if (state.background.current === removed.file) state.background.current = ''
            state.rev += 1
            await persist(ctx)
            await ensureBackgrounds(ctx, true)
            noteWrite(body, 'ok')
            sendJson(res, 200, { ok: true, value: { state: publicState(), backgrounds: publicBackgrounds() } })
            return
          }
          if (route.startsWith('/background/') && req.method === 'GET') {
            await ensureBackgrounds(ctx)
            const name = decodeURIComponent(route.slice('/background/'.length))
            const item = backgrounds.items.find((entry) => entry.id === name)
            if (item === undefined) {
              sendJson(res, 404, {
                ok: false,
                error: { code: 'not-found', message: `Background/ 里没有这张图：${name}` },
              })
              return
            }
            await sendAsset(req, res, item)
            return
          }
          if (route === '/hero' && req.method === 'GET') {
            await ensureHero(ctx, url.searchParams.get('reload') === '1')
            if (heroAsset.ready !== true) {
              sendJson(res, 404, {
                ok: false,
                error: {
                  code: 'not-found',
                  message: `欢迎页形象读不出来（${heroAsset.reason}）：${state.hero.image}`,
                },
              })
              return
            }
            await sendAsset(req, res, heroAsset)
            return
          }
          // ── 桌宠（Live2D）────────────────────────────────────────────
          // 模型 / Cubism Core 走本包的 assets/cyrene/；和 dsh-cyrene 用同一组
          // 相对路径，两个插件同时装了也能各自取到（谁先接住都一样是这份模型）。
          if (req.method === 'GET' && (route === '/live2dcubismcore.min.js' || route.startsWith('/model/'))) {
            await sendLive2dAsset(req, res, route.slice(1))
            return
          }
          // 桌宠轮询：活动阶段（thinking / tool / done / failed / idle）+ 情绪建议。
          // 情绪本身的数据源仍是关系管线（/cyrene/relationship），这里只是给
          // 客户端一个「阶段 + 现成展示建议」的轻量快照，省得它自己维护一份映射表。
          if (route === '/pet' && req.method === 'GET') {
            await ensureMemories(ctx)
            const dominant = memoryStore.relationship.dominant ?? { dimension: null, label: '平静', intensity: 0 }
            sendJson(res, 200, {
              ok: true,
              value: {
                phase: currentPetPhase(),
                at: petPhase.at,
                enabled: state.pet,
                dominant: {
                  ...dominant,
                  presentation: pickEmotionPresentation(dominant.dimension),
                },
              },
            })
            return
          }
          if (route === '/report' && req.method === 'GET') {
            sendJson(res, 200, { ok: true, value: lastReport })
            return
          }
          if (route === '/report' && req.method === 'POST') {
            const body = await readJsonBody(req)
            const text = JSON.stringify(body ?? null)
            if (text.length > MAX_REPORT_BYTES) {
              sendJson(res, 400, {
                ok: false,
                error: { code: 'too-large', message: `报告过大（${text.length} 字节，上限 ${MAX_REPORT_BYTES}）` },
              })
              return
            }
            lastReport = { at: new Date().toISOString(), payload: body ?? null }
            sendJson(res, 200, { ok: true, value: { at: lastReport.at } })
            return
          }
          sendJson(res, 404, {
            ok: false,
            error: { code: 'not-found', message: `没有这个路由：${req.method} ${route}` },
          })
        } catch (error) {
          ctx.logger?.warn?.(`${PACKAGE_ID}: ${req.method} ${route} 失败`, error)
          sendJson(res, 400, {
            ok: false,
            error: { code: 'bad-request', message: error?.message ?? String(error) },
          })
        }
      },
    }),
    `${PACKAGE_ID}: state route`,
  )

  ctx.logger?.info?.(`${PACKAGE_ID}: 昔涟人格已挂载（设定文件 ${statePath()}）`)
}

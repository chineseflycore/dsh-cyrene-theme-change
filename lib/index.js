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

/** 与 package.json 的 name 一致；路由与日志都用它做归属标记。 */
const PACKAGE_ID = 'dsh-cyrene-theme-change'
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

/** 本包安装目录（lib/ 的上一级）：表情包清单与图片都相对它解析。 */
const PLUGIN_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * 本包自己的版本号，直接从安装进来的那份 package.json 读。
 * 用它的唯一地方是设置页右上角那枚 `v0.2.0` 形式的小标签——版本唯一真相仍是
 * package.json，这里不另存、不推导；读不到就留空串，标签自然不显示。
 */
const PLUGIN_VERSION = (() => {
  try {
    const parsed = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'))
    return typeof parsed?.version === 'string' ? parsed.version : ''
  } catch {
    return ''
  }
})()
/** 表情包清单：唯一真相，换图只改这个文件。 */
const STICKER_FILE = join(PLUGIN_DIR, 'stickers.json')
/** 单张图片字节上限（本地图，余量给足）；表情包与欢迎页形象共用。 */
const MAX_ASSET_BYTES = 8 * 1024 * 1024
/** 能直接喂给浏览器的图片类型。 */
const ASSET_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
}

/** 反向表：上传用的 data URL 里带的 mime → 落盘扩展名。 */
const MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
}

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
 * 用户自添加的表情包目录：默认插件目录下的 stickers-custom/。
 * 放在插件目录（而不是 $DSH_HOME）是有意的：聊天里的贴图按**绝对路径**解析，
 * 落在会话工作区之内才保证读得到；同时它写进了 .gitignore，不会污染仓库。
 * 环境变量可以把它挪走——自检就是这么做的（不然会读到、也会写脏本机真实的图）。
 */
const CUSTOM_STICKER_DIR = resolve(process.env.CYRENE_CUSTOM_STICKER_DIR ?? join(PLUGIN_DIR, 'stickers-custom'))

/** 上传请求体上限：8MB 图片 base64 之后约 11MB，留点余量。 */
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024

/**
 * 整页背景图目录：插件目录下的 Background/。
 * 和表情包不同，这里**不需要清单**——目录里放什么就是什么，按文件名排序轮换。
 * 页面通过 /cyrene/background/<文件名> 读字节（file:// 在 http 页面里加载不出来）。
 */
const BACKGROUND_DIR = join(PLUGIN_DIR, 'Background')

/** 压暗面纱的可用区间：太低会让正文压在图上读不清，太高就等于没开。 */
const BG_DIM_MIN = 0.2
const BG_DIM_MAX = 0.85
/** 轮换间隔（秒）：比这更密就成幻灯片了，更疏则一轮等太久。 */
const BG_INTERVAL_MIN = 15
const BG_INTERVAL_MAX = 3600
/** 壁纸比表情包大得多，单张上限单独放宽。 */
const MAX_BACKGROUND_BYTES = 24 * 1024 * 1024

/**
 * 用户自己传的背景图目录。放在包内目旁边有两个原因：
 *   · `/cyrene/background/<文件名>` 的字节路由只服务 PLUGIN_DIR 之下的文件；
 *   · 和 `Background/`（随包发布的素材）分开，才分得清"哪些能删"——
 *     包里的那两张永远不从这里删，用户传的那张删了就是删了。
 * 环境变量同样可以改道（自检用）。
 */
const CUSTOM_BACKGROUND_DIR = resolve(process.env.CYRENE_CUSTOM_BACKGROUND_DIR ?? join(PLUGIN_DIR, 'backgrounds-custom'))

/** 上传请求体上限：24MB 图片 base64 之后约 33MB，留点余量。 */
const MAX_BACKGROUND_UPLOAD_BYTES = 34 * 1024 * 1024

/**
 * 默认人格底稿。用户随时可以在侧边栏改掉它，改完以用户的版本为准。
 * 这里刻意写清楚「保留工程严谨性」和「用户可以让它闭嘴」的边界，
 * 避免人格设定把技术判断一起改掉。
 */
const DEFAULT_PERSONA = [
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
const DEFAULT_HERO = {
  image: 'meme/俏皮眨眼.png',
  title: '让昔涟来帮帮你吧🎵',
}

/** 内存中的当前设定；初始值即默认值，保证文件还没读出来之前人格也是可用的。 */
const state = {
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
 * 最后一次写入尝试留在内存里的痕迹。只在 GET 快照里回给客户端，
 * 不落盘；用途是回答"这次改动是谁、带没带版本号"。
 */
let lastWrite = null

function noteWrite(body, result) {
  const patch = body !== null && typeof body === 'object' ? body : {}
  lastWrite = {
    at: new Date().toISOString(),
    keys: Object.keys(patch).filter((key) => key !== 'rev').sort(),
    rev: Number.isInteger(patch.rev) ? patch.rev : null,
    result,
  }
}

let loadPromise = null
let saveChain = Promise.resolve()

/**
 * 客户端半打上来的活页面取证报告（只存内存，不落盘，重启即丢）。
 * 报告是诊断用的旁路：写失败、超限都只影响诊断，不影响主题与人格。
 */
let lastReport = null
/** 报告大小上限，防止页面把整棵 DOM 塞上来。 */
const MAX_REPORT_BYTES = 128 * 1024

/** 状态文件路径：优先 $DSH_HOME，否则 ~/.dsh。 */
function statePath() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'cyrene-theme.json')
}

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

/** 贴图大小的可用区间：太小的看不清，太大的会撑破对话流。 */
const STICKER_SIZE_MIN = 48
const STICKER_SIZE_MAX = 320

/** 把滑杆/接口递过来的大小夹回可用区间，并取整到 1px。 */
function clampStickerSize(value) {
  const size = Math.round(Number(value))
  if (!Number.isFinite(size)) return STICKER_SIZE_MIN
  return Math.min(STICKER_SIZE_MAX, Math.max(STICKER_SIZE_MIN, size))
}

/** 面纱浓度：0.2–0.85，两位小数足够。 */
function clampDim(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.min(BG_DIM_MAX, Math.max(BG_DIM_MIN, Math.round(n * 100) / 100))
}

/** 轮换间隔：15–3600 秒的整数。 */
function clampInterval(value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return null
  return Math.min(BG_INTERVAL_MAX, Math.max(BG_INTERVAL_MIN, n))
}

/**
 * 背景文件名只接受**纯文件名**：带路径分隔符或 `..` 一律当脏值丢掉。
 * 返回 null 表示"这个值不能用，保持原样"（空串是合法的"按顺序第一张"）。
 */
function cleanBackgroundName(value) {
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
function sanitizeBackground(raw, base) {
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
function sanitizeCustomBackgrounds(raw) {
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
function sanitizeCustomStickers(raw) {
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
function newStickerId() {
  return `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 拆 data URL：`data:image/png;base64,AAAA` → `{ mime, bytes }`。
 * 认不出来就回 null（调用方回 400），不要把半截数据写进磁盘。
 */
function parseDataUrl(data) {
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
function sanitizeMemoryLlm(raw, base = state.memoryLlm) {
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
function applyPatch(patch) {
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
function ensureLoaded(ctx) {
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
function persist(ctx) {
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

/* ────────────────────── 长期记忆（认知分层版） ──────────────────────
 * 设计取舍：
 * - **单独一个文件**，不塞进主题设定：记忆越攒越长，设定文件必须小、必须能一键重置；
 *   两者生命周期也不同（换皮肤/重置主题不该连带丢记忆）。
 * - **三层结构**（L0 画像 / L1 近况 / L2 事件）+ **成色与衰减**：
 *   升级自「扁平列表 + 子串搜索」。扇出量的依据见 lib/cognitive.js 文件头。
 * - 注入走**独立 section**（`cyrene:memory`），排在人格之后：人格是「怎么说话」，记忆是「知道什么」。
 *   正文由 `buildInjection` 生成，有 2000 字硬预算，且三层里 L0 最晚被裁。
 * - 模型能写（tools）也能读（section 里的画像+近况+召回 + 检索工具）；
 *   上限与预算见常量 —— 记忆无节制膨胀，最先坏的是上下文。
 * - 旧格式（v1 扁平 items）在读取时原地迁移，不要求用户做任何事。
 *
 * 实施单对照（全文见 docs/memory-system-spec.md，逐条见 README「规格与来源」）：
 * - §5.1 人格保护：`memoryText` / `remountMemory` 只动 `cyrene:memory`，
 *   绝不碰 `cyrene:persona`；护栏话术与 2000 字预算在 `buildInjection`；
 * - §5.2 文本账本：`ledgerReport` / `syncMemoryLedger` + `lib/ledger.js`；
 * - §5.3 每日健康一行：`memoryHealthLine` / `memoryHealthValue`；
 * - §9.3 遗忘曲线与钉住：`pinMemory` + `lib/cognitive.js` 的 `decayWeight`；
 * - §9.5 压缩 / 反思：`maybeCompressMemories`（纯规则，不调 LLM）。
 */
const MEMORY_FILE = 'cyrene-memory.json'
const MEMORY_TEXT_MAX = TEXT_MAX
const MEMORY_TAG_MAX = 8
const MEMORY_LIMIT = 300
const MEMORY_SECTION_BUDGET = resolveInjectMaxChars(process.env)
const MEMORY_TOOL_DEFAULT = 8
const MEMORY_SECTION_NAME = 'cyrene:memory'
/** 注入时最多挑几条 L2（再多就是噪音，且会挤掉预算）。 */
const MEMORY_INJECT_ITEMS = 8
/** 画像/近况槽位的历史留痕：旧值转成 L2，成色压低，避免抢注入预算。 */
const PROFILE_HISTORY_WEIGHT = 0.4
/** 每个字段最多保留最近几条历史（更老的归档）。 */
const PROFILE_HISTORY_KEEP = 3
/** L0 写入长度上限：画像是一句话，不是一段自述。 */
const PROFILE_L0_MAX = 40
/** L1 写入长度上限，以及「像不像一句近况」的判定线。 */
const PROFILE_L1_MAX = 30
const PROFILE_L1_BREAKS = 2
const PROFILE_L1_SELF_MAX = 20

/** 和主题设定放同一个目录（`%USERPROFILE%\.dsh`），但用另一个文件。 */
function memoryPath() {
  return join(dirname(statePath()), MEMORY_FILE)
}

/**
 * 记忆账本路径（实施单 §5.2）：和记忆文件同目录的 `cyrene-memory-ledger.json`。
 * `MEM_LEDGER` 可以覆盖它——`tools/memory-ledger.mjs` 读的是同一个变量，
 * 所以插件与命令行看到的一定是**同一份账本**，不会各建各的。
 */
function memoryLedgerPath() {
  const override = typeof process.env.MEM_LEDGER === 'string' ? process.env.MEM_LEDGER.trim() : ''
  return override !== '' ? resolve(override) : join(dirname(statePath()), LEDGER_FILE)
}

/**
 * 在系统文件管理器里定位一个文件（Windows 用资源管理器选中它，
 * macOS 用 Finder，Linux 打开所在目录）。
 *
 * 浏览器页面自己做不到这件事——只能由宿主进程 spawn 一个窗口管理器。
 * 路径是插件自己算出来的（不是用户输入），所以不存在"用户递一个路径过来让我开"的面。
 * 返回 false 表示没打开（比如不是桌面环境），调用方据此提示用户改用复制路径。
 */
function revealFile(target) {
  // 自检时不要真的弹窗。
  if (process.env.CYRENE_NO_REVEAL === '1') return true
  try {
    if (process.platform === 'win32') {
      // `execFile` 语义：数组形式已经把带空格的路径整体当一个参数，
      // explorer 认的是 `/select,` 后面紧跟文件路径。
      spawn('explorer.exe', ['/select,', target], { detached: true, stdio: 'ignore' }).unref()
      return true
    }
    if (process.platform === 'darwin') {
      spawn('open', ['-R', target], { detached: true, stdio: 'ignore' }).unref()
      return true
    }
    spawn('xdg-open', [dirname(target)], { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch (error) {
    return false
  }
}

let memoryStore = {
  items: [],
  rev: 0,
  enabled: true,
  error: null,
  /** L0 画像 / L1 近况（Cyrene-Agent 的分层）。 */
  profile: { l0: {}, l1: {} },
  /** 关系与情绪（移植自 relationship-log + 情绪环）。 */
  relationship: emptyRelationship(),
  /** 上一次结算（遗忘）的时间，避免每次启动都重算一遍。 */
  settledAt: 0,
}
let memoryPromise = null
let memorySaveChain = Promise.resolve()

/* ────────────────────── 记忆整理：云端 LLM（v0.7） ──────────────────────
 * 纯规则之外再挂一层云端模型：分层 / 判重 / 压缩 / 冲突裁决交给它。
 * 三条纪律：
 *  1. **绝不阻塞**：所有调用都进 `memoryLlmChain` 串行队列，调用方只 `void`；
 *  2. **失败即回退**：LLM 返回 null（超时 / 坏 JSON / 没 provider）时，
 *     压缩走 buildSummaryText，冲突走 bestSim >= 0.86 || contained；
 *  3. **配置只增不改**：state.memoryLlm 是新字段，老状态文件读进来自动补默认值。
 */
let memoryLlmManager = null
let memoryLlmManagerKey = ''
let memoryLlmManagerCtx = null
let memoryLlmChain = Promise.resolve()

/** 按当前配置取（或重建）记忆整理器；ctx 换了也重建，避免测试里串上下文。 */
function memoryLlmFor(ctx) {
  const target = ctx ?? memoryLlmManagerCtx
  if (target === null || target === undefined) return null
  const settings = sanitizeMemoryLlm(state.memoryLlm)
  const key = JSON.stringify([settings.enabled, settings.provider, settings.model, settings.timeoutMs])
  if (memoryLlmManager !== null && memoryLlmManagerKey === key && memoryLlmManagerCtx === target) {
    return memoryLlmManager
  }
  if (memoryLlmManager !== null) {
    try {
      memoryLlmManager.dispose()
    } catch {
      // 旧管理器已经释放
    }
  }
  // 不替用户选模型：settings.model 为空就交给 host 自动解析（首个可用模型），
  // 用户想用好的就用好的，想省钱就用免费档，面板里自己挑。
  memoryLlmManager = createMemoryLlm(target, settings)
  memoryLlmManagerKey = key
  memoryLlmManagerCtx = target
  return memoryLlmManager
}

/** 配置变了：下次取的时候重建；旧的在飞请求一并 abort。 */
function resetMemoryLlm() {
  if (memoryLlmManager !== null) {
    try {
      memoryLlmManager.dispose()
    } catch {
      // 同上
    }
  }
  memoryLlmManager = null
  memoryLlmManagerKey = ''
  memoryLlmManagerCtx = null
}

/** GET /cyrene/memory/llm 的唯一出口：永远给四个字段，不把异常抛给路由。 */
async function memoryLlmStatus(ctx) {
  const manager = memoryLlmFor(ctx)
  if (manager === null) {
    return { available: false, provider: '', model: '', lastError: '没有可用的 LLM 服务（宿主未提供 llm）' }
  }
  try {
    const status = await manager.status()
    return {
      available: status.available === true,
      provider: status.provider ?? '',
      model: status.model ?? '',
      lastError: status.lastError ?? null,
    }
  } catch (error) {
    return { available: false, provider: '', model: '', lastError: error?.message ?? String(error) }
  }
}

/** 串行队列：记忆整理一次只跑一个，避免并发写库；任务失败只记日志。 */
function enqueueMemoryWork(ctx, task) {
  memoryLlmChain = memoryLlmChain.then(task).catch((error) => {
    ctx?.logger?.warn?.(`${PACKAGE_ID}: 云端记忆整理失败（已回退规则）`, error)
    return null
  })
  return memoryLlmChain
}

/** 异步任务改完记忆后的统一收尾：落盘 + 补账 + 重挂注入。 */
async function afterMemoryMutation(ctx) {
  memoryStore.rev += 1
  await persistMemories(ctx)
  await syncMemoryLedger(ctx)
  remountMemory(ctx.systemPrompt)
}

/**
 * 世界书（设定库）。和长期记忆是两件事：
 * - 记忆＝「你和这个人之间发生过什么」，会随时间长大；
 * - 世界书＝「这个世界本来是什么样」，从官方 wiki 抓来、体积大、只在被问到时才取用。
 *
 * 注入分两层：常驻只有一行「资料库里有什么 + 该去查」的索引（很省），
 * 真正的正文靠 `cyrene_worldbook_search` 按关键词取——命中才进上下文。
 */
const WORLDBOOK_FILE = 'cyrene-worldbook.json'
const WORLDBOOK_SECTION_NAME = 'cyrene:worldbook'
const WORLDBOOK_SECTION_BUDGET = 700
const WORLDBOOK_TOOL_DEFAULT = 5
const WORLDBOOK_TOOL_BUDGET = 6000
const WORLDBOOK_ENTRY_SHOWN = 2200
const WORLDBOOK_WIKI_URL = 'https://act-api-takumi.mihoyo.com/event/rpgchrysosheirs/index'

/** 和记忆、主题设定放同一个目录，各占一个文件。 */
function worldbookPath() {
  return join(dirname(statePath()), WORLDBOOK_FILE)
}

const EMPTY_WORLDBOOK = { entries: [], source: '', version: '', fetchedAt: '', error: null }
let worldbookStore = { ...EMPTY_WORLDBOOK }
let worldbookLoaded = false

function newMemoryId() {
  return `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function cleanMemoryText(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, MEMORY_TEXT_MAX)
}

function cleanMemoryTags(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,，、\s]+/)
      : []
  const out = []
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    const tag = entry.trim().slice(0, 24)
    if (tag === '' || out.includes(tag)) continue
    out.push(tag)
    if (out.length >= MEMORY_TAG_MAX) break
  }
  return out
}

/**
 * 一条记忆的合法形状。v1 只有 id/text/created/tags/importance；
 * v2 起多出成色（weight）、状态（status）、访问统计与分层标记。
 * 旧数据在这里原地补齐，所以「升级插件」对用户是零动作。
 */
function sanitizeMemoryItem(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const text = cleanMemoryText(raw.text)
  if (text === '') return null
  const created = typeof raw.created === 'string' && !Number.isNaN(Date.parse(raw.created))
    ? new Date(raw.created).toISOString()
    : new Date().toISOString()
  const id = typeof raw.id === 'string' && /^mem-[a-z0-9-]{4,40}$/i.test(raw.id) ? raw.id : newMemoryId()
  const importance = Number.isFinite(Number(raw.importance))
    ? Math.min(5, Math.max(1, Math.round(Number(raw.importance))))
    : 3

  // 成色：老条目没存过 weight，就用 importance 折一次；新条目自带。
  const storedWeight = Number(raw.weight)
  const weight = Number.isFinite(storedWeight)
    ? Math.min(1, Math.max(0.05, storedWeight))
    : importanceToWeight(importance)
  const pinned = raw.pinned === true || weight >= 0.7 // 0.7 是「永不衰减」线，见 cognitive.PIN_WEIGHT
  const createdMs = Date.parse(created)
  const lastAccess = Number.isFinite(Number(raw.lastAccess)) ? Number(raw.lastAccess) : createdMs
  const lastDecay = Number.isFinite(Number(raw.lastDecay)) ? Number(raw.lastDecay) : createdMs
  const accessCount = Number.isFinite(Number(raw.accessCount)) ? Math.max(0, Math.floor(Number(raw.accessCount))) : 0
  const layer = raw.layer === 'L0' || raw.layer === 'L1' ? raw.layer : 'L2'
  const emotion = Number.isFinite(Number(raw.emotion)) ? Math.min(1, Math.max(0, Number(raw.emotion))) : 0

  return {
    id,
    text,
    tags: cleanMemoryTags(raw.tags),
    importance,
    created,
    // v2 字段
    weight,
    layer,
    status: raw.status === 'archived' || raw.status === 'aging' || raw.status === 'active'
      ? raw.status
      : statusOf(weight),
    pinned,
    accessCount,
    lastAccess,
    lastDecay,
    emotion,
    ...(typeof raw.source === 'string' && raw.source !== '' ? { source: raw.source.slice(0, 40) } : {}),
    ...(Array.isArray(raw.conflictWith) && raw.conflictWith.length > 0
      ? { conflictWith: raw.conflictWith.filter((x) => typeof x === 'string').slice(0, 8) }
      : {}),
    // 压缩摘要（实施单 §9.5）：只增字段，老条目读回来没有这两个键。
    ...(raw.isSummary === true ? { isSummary: true } : {}),
    ...(Array.isArray(raw.subEntryIds) && raw.subEntryIds.length > 0
      ? { subEntryIds: raw.subEntryIds.filter((x) => typeof x === 'string').slice(0, 50) }
      : {}),
    // 画像槽位的历史留痕：记住这条旧值属于哪个字段，用于「每个字段只留最近 3 条」。
    ...(typeof raw.historyField === 'string' && raw.historyField !== ''
      ? { historyField: raw.historyField.slice(0, 40) }
      : {}),
  }
}

/** 读盘（一次）；`force` 强制重读。读坏了就当空，不阻塞插件启动。 */
async function ensureMemories(ctx, force) {
  if (memoryPromise !== null && force !== true) return memoryPromise
  memoryPromise = (async () => {
    try {
      const raw = await readFile(memoryPath(), 'utf8')
      const parsed = JSON.parse(raw)
      const items = []
      for (const entry of Array.isArray(parsed?.items) ? parsed.items : []) {
        const item = sanitizeMemoryItem(entry)
        if (item !== null) items.push(item)
      }
      // 结算遗忘：把「距上次结算过了几天」折算成成色跌幅。
      // 这里只算一次（不是每轮都算），所以开关插件不会把记忆越磨越薄。
      const now = Date.now()
      for (const item of items) {
        const nextWeight = decayWeight(item, now)
        item.weight = nextWeight
        item.status = statusOf(nextWeight)
        item.importance = weightToImportance(nextWeight)
        item.lastDecay = now
      }
      // 摘要的来源条目一律留在 archived（实施单 §9.5）：它们的成色可能仍高于
      // 归档线，但既然已经并进摘要，就不该再单独注入、也不该被状态机复活。
      const summarized = new Set()
      for (const item of items) {
        if (item.isSummary === true) for (const id of item.subEntryIds ?? []) summarized.add(id)
      }
      for (const item of items) {
        if (summarized.has(item.id) && item.isSummary !== true) item.status = 'archived'
      }
      memoryStore = {
        items: items.slice(0, MEMORY_LIMIT),
        rev: Number.isInteger(parsed?.rev) && parsed.rev >= 0 ? parsed.rev : 0,
        enabled: parsed?.enabled !== false,
        error: null,
        profile: {
          l0: sanitizeProfileFields(parsed?.profile?.l0, L0_FIELDS),
          l1: sanitizeProfileFields(parsed?.profile?.l1, L1_FIELDS),
        },
        relationship: sanitizeRelationship(parsed?.relationship),
        settledAt: now,
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        memoryStore = { ...memoryStore, error: error?.message ?? String(error) }
        ctx?.logger?.warn?.(`${PACKAGE_ID}: 读取记忆失败，先当空的`, error)
      }
    }
    return memoryStore
  })()
  return memoryPromise
}

/** 画像字段只留白名单里的字符串，其余丢掉（防手改文件把结构写坏）。 */
function sanitizeProfileFields(raw, fields) {
  const out = {}
  if (raw === null || typeof raw !== 'object') return out
  for (const field of fields) {
    const value = cleanInline(raw[field])
    if (value !== '') out[field] = value.slice(0, MEMORY_TEXT_MAX)
  }
  if (Number.isFinite(Number(raw?.updatedAt))) out.updatedAt = Number(raw.updatedAt)
  if (Number.isFinite(Number(raw?.generatedAt))) out.generatedAt = Number(raw.generatedAt)
  if (Number.isFinite(Number(raw?.roundCount))) out.roundCount = Number(raw.roundCount)
  return out
}

/** 关系状态读回来时夹一遍值域：文件被手改过也不至于把数字推到天上。 */
function sanitizeRelationship(raw) {
  const base = emptyRelationship()
  if (raw === null || typeof raw !== 'object') return base
  const clamp = (value, fallback) => (Number.isFinite(Number(value)) ? Math.min(100, Math.max(0, Number(value))) : fallback)
  return {
    ...base,
    ...raw,
    affinity: clamp(raw.affinity, base.affinity),
    trust: clamp(raw.trust, base.trust),
    familiarity: clamp(raw.familiarity, base.familiarity),
    turns: Number.isFinite(Number(raw.turns)) ? Math.max(0, Math.floor(Number(raw.turns))) : 0,
    emotions: { ...base.emotions, ...(typeof raw.emotions === 'object' && raw.emotions !== null ? raw.emotions : {}) },
  }
}

/** 串行落盘（和主题设定同一套 tmp + rename 写法）。 */
function persistMemories(ctx) {
  const payload = JSON.stringify({
    enabled: memoryStore.enabled,
    rev: memoryStore.rev,
    settledAt: memoryStore.settledAt,
    profile: memoryStore.profile,
    relationship: memoryStore.relationship,
    items: memoryStore.items.map((item) => ({ ...item })),
  }, null, 2)
  memorySaveChain = memorySaveChain.then(async () => {
    const target = memoryPath()
    const temp = `${target}.${process.pid}.tmp`
    await mkdir(dirname(target), { recursive: true })
    await writeFile(temp, payload, 'utf8')
    await rename(temp, target)
  }).catch((error) => {
    ctx?.logger?.warn?.(`${PACKAGE_ID}: 保存记忆失败`, error)
  })
  return memorySaveChain
}

function publicMemories() {
  return {
    error: memoryStore.error,
    enabled: memoryStore.enabled,
    rev: memoryStore.rev,
    count: memoryStore.items.length,
    limit: MEMORY_LIMIT,
    path: memoryPath(),
    profile: {
      l0: { ...memoryStore.profile.l0 },
      l1: { ...memoryStore.profile.l1 },
    },
    relationship: {
      affinity: memoryStore.relationship.affinity,
      trust: memoryStore.relationship.trust,
      familiarity: memoryStore.relationship.familiarity,
      turns: memoryStore.relationship.turns,
      streakDays: memoryStore.relationship.streakDays,
      lastMood: memoryStore.relationship.lastMood,
      // 主导情绪 + 给桌宠的表情/动作建议。`presentation` 是纯函数算出来的，
      // 老客户端不认识这个字段，忽略即可（不改变已有的 dominant 形状）。
      dominant: {
        ...memoryStore.relationship.dominant,
        presentation: pickEmotionPresentation(memoryStore.relationship.dominant?.dimension),
      },
      nextCareCue: memoryStore.relationship.nextCareCue,
      summary: relationshipSummary(memoryStore.relationship),
    },
    items: memoryStore.items.map((item) => ({ ...item, tags: [...item.tags] })),
  }
}

/* ────────────────────── 记忆账本与每日健康（实施单 §5.2 / §5.3） ──────────────────────
 * 账本只回答「有没有丢过」：每条记忆按 id 记一个 sha256 + 字符数，写入时 sync、
 * 备份前 verify。它不改记忆、不进提示词，所以坏了也只会让「有没有丢过」失去答案，
 * 不会让她忘记任何事（记忆本身在 cyrene-memory.json 里）。
 */

/** 自动入账的串行链：两次写入不能同时读到同一份旧账本，否则新 id 会被后一次盖掉。 */
let ledgerChain = Promise.resolve()

/**
 * 记忆写入之后自动补账（实施单 §5.2）：只补新 id，老记录绝不覆盖。
 * 合并、手改正文不会被它抹平——那是 verify 该报的 mismatched。
 * 账本写不进去只记一条 warn：记忆已经落盘了，账本不能反过来拖垮写入。
 */
function syncMemoryLedger(ctx) {
  const entries = memoryStore.items.map((item) => ({ id: item.id, text: item.text }))
  ledgerChain = ledgerChain.then(async () => {
    try {
      return await syncLedgerFile(memoryLedgerPath(), entries)
    } catch (error) {
      ctx?.logger?.warn?.(`${PACKAGE_ID}: 同步记忆账本失败（记忆本身没受影响）`, error)
      return null
    }
  })
  return ledgerChain
}

/** 一次对账：账本文件 + 当前内存库 → 路由 / 工具 / 健康行共用的报告。 */
async function ledgerReport() {
  const read = await readLedgerFile(memoryLedgerPath())
  const report = verifyLedger(read.ledger, memoryStore.items)
  return {
    // 没有账本就不算「对得上」；账本文件读坏了更不算——说不清「有没有丢过」时不能报 OK。
    ok: read.exists === true && read.error === null && report.ok,
    exists: read.exists,
    error: read.error,
    entries: ledgerCount(read.ledger),
    checked: report.checked,
    mismatched: report.mismatched,
    missing: report.missing,
    unledgered: report.unledgered,
    ledgerPath: memoryLedgerPath(),
  }
}

/** 健康行里的三态：ABSENT（还没建）/ BROKEN（对不上或读坏了）/ OK。 */
function ledgerStateOf(report) {
  if (report.error !== null && report.error !== undefined) return 'BROKEN'
  if (report.exists !== true) return 'ABSENT'
  return report.ok === true ? 'OK' : 'BROKEN'
}

/** 分档计数：pinned 是独立维度（钉住的也可能落在任一分档里）。 */
function memoryCounts() {
  const counts = { total: memoryStore.items.length, pinned: 0, active: 0, aging: 0, archived: 0 }
  for (const item of memoryStore.items) {
    if (item.pinned === true) counts.pinned += 1
    if (item.status === 'active') counts.active += 1
    else if (item.status === 'aging') counts.aging += 1
    else if (item.status === 'archived') counts.archived += 1
  }
  return counts
}

/**
 * 每日健康一行（实施单 §5.3）：
 *   [memory] 2026-10-30 total=51 pinned=20 active=28 aging=2 archived=1 inject_cap=2000 ledger=OK pending=0
 *
 * `pending` 恒为 0：这套记忆是同步写盘、没有队列消费端，字段留着是为了
 * 和远端实施单的巡检脚本对齐（以后真加了异步写，这里就有意义）。
 */
function memoryHealthLine(report) {
  const counts = memoryCounts()
  return `[memory] ${localDate()} total=${counts.total} pinned=${counts.pinned} active=${counts.active} aging=${counts.aging} archived=${counts.archived} inject_cap=${MEMORY_SECTION_BUDGET} ledger=${ledgerStateOf(report)} pending=0`
}

/** 健康行的结构化版本（面板 / 工具直接读字段，不用去拆字符串）。 */
function memoryHealthValue(report) {
  const counts = memoryCounts()
  return {
    line: memoryHealthLine(report),
    date: localDate(),
    ...counts,
    injectCap: MEMORY_SECTION_BUDGET,
    ledger: ledgerStateOf(report),
    ledgerPath: report.ledgerPath,
    ledgerEntries: report.entries,
    pending: 0,
    path: memoryPath(),
  }
}

/**
 * 注入正文：画像 + 近况常驻，L2 事件按「成色×新鲜度」挑几条。
 * 预算与护栏都在 cognitive.buildInjection 里（L0 最后才让位）。
 */
/** 这一轮注入时命中了几条「旧」记忆（>3 天），归一化成 0..1，交给 absorbTurn 去点亮情绪。 */
let pendingRecallEcho = 0

/** 旧记忆命中 → 情绪回声强度。3 条封顶，避免一上来就顶满。 */
function echoFromRecalled(items) {
  if (!Array.isArray(items) || items.length === 0) return 0
  const now = Date.now()
  let old = 0
  for (const item of items) {
    const ts = Date.parse(String(item?.created ?? ''))
    if (Number.isFinite(ts) && now - ts > 3 * 86400000) old += 1
  }
  return Math.min(1, old / 3)
}

function memoryText() {
  if (memoryStore.enabled !== true) return ''
  // 摘要已经并掉了这些来源：即使某条后来被召回重新点亮，也不再单独展示
  // （实施单 §9.5「注入时不重复展示它的来源条目」）。
  const summarized = new Set()
  for (const item of memoryStore.items) {
    if (item.isSummary === true) for (const id of item.subEntryIds ?? []) summarized.add(id)
  }
  const candidates = memoryStore.items.filter((item) =>
    item.layer === 'L2' &&
    item.status !== 'archived' &&
    (item.isSummary === true || !summarized.has(item.id)))
  const ordered = [...candidates].sort((a, b) => {
    // ⚠️ 排序必须是「同一批输入 → 同一串输出」的纯函数，否则缓存按前缀失效：
    // 以前这里是 weight + 0.2 * freshness(created)，freshness 随时间衰减，
    // 同一批记忆过一会儿顺序就可能互换，注入文本跟着抖，前缀缓存白丢。
    // 现在只按 weight 降序，平手时按 created 升序（稳定、可重现）。
    // 摘要优先：它本来就是「多条碎片挤成一条」的产物，密度最高；
    // 若不优先，权重一低就会被碎片挤出注入名额（曾经就是这样丢掉摘要的）。
    const sumA = a.isSummary === true ? 1 : 0
    const sumB = b.isSummary === true ? 1 : 0
    if (sumA !== sumB) return sumB - sumA
    const diff = (b.weight ?? 0) - (a.weight ?? 0)
    if (diff !== 0) return diff
    return String(a.created ?? '').localeCompare(String(b.created ?? ''))
  })
  const recalled = selectForInjection(ordered.slice(0, MEMORY_INJECT_ITEMS), {
    budget: Math.floor(MEMORY_SECTION_BUDGET * 0.7),
  })
  // 这一批里有多少条是「旧」记忆：旧事重提应当带起一点情绪（情绪↔记忆联动）。
  pendingRecallEcho = echoFromRecalled(recalled)
  return buildInjection({
    l0: memoryStore.profile.l0,
    l1: memoryStore.profile.l1,
    recalled,
  }, MEMORY_SECTION_BUDGET)
}

/**
 * 关系与情绪注入。它和记忆是两个 section：关系讲「怎么相处」，记忆讲「发生过什么」。
 * 关掉记忆开关时它也不注入——用户关的是「她记得我」，关系日志属于同一件事。
 */
function relationshipText() {
  if (memoryStore.enabled !== true) return ''
  // 一轮都没聊过就不注入：空的关系描述（「刚认识 · 平静」）只会白占预算，
  // 还会让第一句话的语气变得奇怪。聊过之后才慢慢有内容可说。
  if (Number(memoryStore.relationship.turns ?? 0) <= 0) return ''
  return buildRelationshipText(memoryStore.relationship)
}

let disposeMemorySection = null

/** 和人格 section 同一套「先卸再挂 + 纯字符串正文」，任何 DSH 版本都成立。 */
function remountMemory(prompt) {
  if (disposeMemorySection !== null) {
    try {
      disposeMemorySection()
    } catch {
      // 旧 section 已经跟着 fiber 消失
    }
    disposeMemorySection = null
  }
  const text = memoryText()
  if (text === '') return
  disposeMemorySection = prompt.section({
    name: MEMORY_SECTION_NAME,
    order: resolvePersonaOrder(prompt) + 20,
    text,
  })
}

let disposeRelationshipSection = null

/**
 * 关系 section：排在记忆之后 1 位。单独一个 section 是为了让「记得什么」
 * 和「怎么相处」各自可关、各自可查，也方便以后单独调预算。
 */
function remountRelationship(prompt) {
  if (disposeRelationshipSection !== null) {
    try {
      disposeRelationshipSection()
    } catch {
      // 同上
    }
    disposeRelationshipSection = null
  }
  const text = relationshipText()
  if (text === '') return
  disposeRelationshipSection = prompt.section({
    name: 'cyrene:relationship',
    order: resolvePersonaOrder(prompt) + 21,
    text,
  })
}

/* ────────────────────── 桌宠的活动阶段（Live2D） ──────────────────────
 * 客户端每 5 秒轮询一次 /cyrene/pet，拿到 thinking / tool / done / failed / idle，
 * 用来压过情绪动作与 idle 轮播（阶段动作优先级最高）。
 * 这里只做一件事：把 session/event 投影成这五个词，其它什么都不碰。
 * `done` / `failed` 只亮一小会儿（稍后回 idle），`thinking` / `tool` 超时也回 idle，
 * 免得一次没收到 turn/end 的事件让桌宠永远停在「思考中」。
 */
const PET_PHASE_DONE_MS = 4000
const PET_PHASE_ACTIVE_MS = 120000
const petPhase = { phase: 'idle', at: 0 }

function setPetPhase(phase) {
  petPhase.phase = phase
  petPhase.at = Date.now()
}

/** 把一条 session 事件投影成桌宠阶段；认不出来的类型原样忽略。 */
function notePetEvent(event) {
  const type = event?.type
  if (type === 'user/message' || type === 'turn/start' || type === 'step/start') {
    setPetPhase('thinking')
    return
  }
  if (type === 'assistant/chunk') {
    const kind = event?.data?.chunk?.type
    const text = event?.data?.chunk?.text
    if ((kind === 'reasoning-delta' || kind === 'text-delta') && typeof text === 'string' && text !== '') {
      setPetPhase('thinking')
    }
    return
  }
  if (type === 'tool/call') {
    setPetPhase('tool')
    return
  }
  if (type === 'tool/result') {
    setPetPhase(event?.data?.error === undefined ? 'thinking' : 'failed')
    return
  }
  if (type === 'assistant/message') {
    setPetPhase('done')
    return
  }
  if (type === 'turn/end') {
    const kind = event?.data?.reason?.kind
    setPetPhase(kind === 'error' ? 'failed' : kind === 'completed' ? 'done' : 'idle')
  }
}

/** 当前对外的阶段：短阶段会过期，长阶段有超时兜底。 */
function currentPetPhase(now = Date.now()) {
  const age = Math.max(0, now - petPhase.at)
  if (petPhase.phase === 'done' || petPhase.phase === 'failed') {
    return age <= PET_PHASE_DONE_MS ? petPhase.phase : 'idle'
  }
  if (petPhase.phase === 'thinking' || petPhase.phase === 'tool') {
    return age <= PET_PHASE_ACTIVE_MS ? petPhase.phase : 'idle'
  }
  return 'idle'
}

/**
 * 一轮对话收尾：把「用户说了什么、她回了什么」折进关系与情绪。
 *
 * 为什么挂在 `session/event` 而不是工具里：模型不一定每轮都调记忆工具，
 * 但关系是**每一轮都在变**的——漏记一轮，连续天数、情绪环、关心提示
 * 就全都错位了。这里只做轻量计算，写盘是异步的，不阻塞回复。
 */
/**
 * 规则驱动的自动记一条。
 *
 * 为什么不再靠模型自觉：实测同一个任务，A 组记 16 条、B 组记 0 条——模型在连续
 * 编码时不会「停下来想」，而记忆写入恰好要求它停下来。所以改成**每轮无条件落一条
 * L2**，模型只负责「要不要把它提升成稳定事实」（见 scheduleJudgement）。
 *
 * 去重靠向量：同一件事换个说法（余弦 ≥ 0.92）就不再重复记，避免话痨式膨胀。
 */
/**
 * 框架注入的「假用户消息」。
 *
 * 宿主会把运行时上下文、时间戳、后台任务通知当成 user/message 发进事件流
 * （例如 "Time sampled while preparing turn 201…"、"background job bash-…"）。
 * 这些不是用户说的话，却被「每轮自动记一条」记进了记忆库——真机上 26 条记忆
 * 里有 17 条是这种东西，把真正的对话淹没了。
 *
 * 两道防线：
 *   1. 优先看事件自带的 source.kind，只认 'user'；
 *   2. 拿不到 source 时退回前缀匹配（兼容老形状）。
 */
const INJECTED_PREFIXES = [
  /^Time sampled while preparing/iu,
  /^background job /iu,
  /^Current runtime context/iu,
  /^The available skill catalog changed/iu,
  /^<system-reminder>/iu,
]

function looksInjected(text) {
  const value = String(text ?? '').trim()
  if (value === '') return true
  return INJECTED_PREFIXES.some((pattern) => pattern.test(value))
}

const AUTO_CAPTURE_MIN_CHARS = 6
const AUTO_CAPTURE_MAX_CHARS = 160
const AUTO_CAPTURE_SKIP = /^(ok|okay|好的|好|嗯+|收到|继续|接着|开始|停|go|yes|no|是|否|谢谢|拜拜)$/iu

function shouldAutoCapture(text) {
  const value = String(text ?? '').trim()
  if (looksInjected(value)) return false
  if (value.length < AUTO_CAPTURE_MIN_CHARS || value.length > 2000) return false
  if (AUTO_CAPTURE_SKIP.test(value)) return false
  if (value.startsWith('/')) return false
  return true
}

function absorbTurn(userText, assistantText, ctx) {
  if (memoryStore.enabled !== true) return
  if (typeof userText !== 'string' || userText.trim() === '') return
  const mood = detectUserMood(userText)
  const signal = deriveSignal(userText, mood)
  const echo = pendingRecallEcho
  pendingRecallEcho = 0
  memoryStore.relationship = recordTurn(memoryStore.relationship, {
    userText,
    assistantText,
    mood,
    signal,
    echo,
  })

  // 不再自动落库。规则捕获记的是"他说过什么"，不是"值得记住什么"——
  // 真机上 26 条记忆里 17 条是框架注入的时间戳，剩下也多是追问。
  // 改回由模型自己判断要不要写（提示词里给了明确的触发条件），另外提供一个
  // 可选的 LLM 整理入口（cyrene_memory_organize）来事后归并。
}

/**
 * 从一条 session 事件里抽纯文本。事件形状随 DSH 版本演进，
 * 所以这里对所有可能的位置都兜一遍——抽不到就安静返回 ''。
 */
function eventText(event) {
  const blocks = event?.data?.content
  if (!Array.isArray(blocks)) {
    if (typeof event?.data?.text === 'string') return event.data.text
    return ''
  }
  return blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/**
 * 把一批来源压成摘要条目并写进库（规则与 LLM 共用）。
 * `llmText` 非空时用模型正文；否则 buildSummaryEntry 里的 buildSummaryText 兜底。
 */
function commitCompression(sources, llmText) {
  const list = Array.isArray(sources) ? sources : []
  if (list.length < 2) return null
  const summary = buildSummaryEntry(list, { id: newMemoryId() })
  if (typeof llmText === 'string' && llmText !== '') summary.text = llmText
  if (summary.text === '') return null
  const ids = new Set(list.map((item) => item.id))
  for (const item of memoryStore.items) {
    if (ids.has(item.id)) item.status = 'archived'
  }
  memoryStore.items.unshift(summary)
  return summary
}

/** 一次压缩可能跨好几轮写入，排队期间不再重复触发。 */
let compressionPending = false

/**
 * 写入之后的压缩 / 反思（实施单 §9.5）：
 * active 的 L2 超过 120 条时，取「最老 + 成色最低」的 20 条压成一条摘要，
 * 来源转 archived。摘要 layer='L2'、成色取均值、照常参与召回。
 *
 * 三级降级：
 *  1. LLM 可用 → 异步调 summarize()，用模型正文；
 *  2. LLM 返回 null / 抛错 / 超时 → 仍由 commitCompression 走 buildSummaryText；
 *  3. 没有 LLM 服务（canCall=false）→ 完全同步走规则，行为和 v0.6 一致。
 * 返回值：同步路径返回摘要条目；异步路径返回 null（摘要稍后落库）。
 */
function maybeCompressMemories(ctx) {
  const active = memoryStore.items.filter((item) =>
    item.layer === 'L2' && item.status === 'active' && item.isSummary !== true)
  if (active.length <= COMPRESS_ACTIVE_LIMIT) return null
  const sources = selectCompressionCandidates(active)
  // 少于 2 条就谈不上「合并」，宁可再攒一轮。
  if (sources.length < 2) return null

  const manager = memoryLlmFor(ctx)
  if (manager === null || manager.canCall() !== true) {
    return commitCompression(sources, '')
  }
  if (compressionPending) return null
  compressionPending = true
  void enqueueMemoryWork(ctx, async () => {
    try {
      // 排队期间来源可能被合并 / 删除：重新确认它们还在、还是 active。
      const still = sources.filter((item) =>
        memoryStore.items.includes(item) && item.status === 'active' && item.isSummary !== true)
      if (still.length < 2) return null
      let text = ''
      try {
        const result = await manager.summarize(still)
        if (result !== null && typeof result.summary === 'string') text = result.summary
      } catch {
        // 任何异常都走规则摘要，不让压缩任务失败
        text = ''
      }
      const summary = commitCompression(still, text)
      if (summary === null) return null
      if (ctx !== null && ctx !== undefined) await afterMemoryMutation(ctx)
      return summary
    } finally {
      compressionPending = false
    }
  })
  return null
}

/**
 * 钉住 / 取消钉住（实施单 §9.3 的保护线 0.7）：
 * 钉住 = 成色抬到保护线以上、状态回 active；之后 decayWeight 见到 pinned 直接跳过。
 * 取消 = 回到保护线以下（0.69）：否则 sanitize 那行「weight >= 0.7 自动算钉住」
 * 会在下次启动时又把它算成钉住的，这个开关就白点了。
 */
function pinMemory(item, pinned) {
  const target = pinned === true
  item.pinned = target
  const weight = Number(item.weight ?? 0)
  if (target) {
    item.weight = Math.max(weight, PIN_WEIGHT)
    item.status = 'active'
  } else {
    item.weight = Math.min(weight, PIN_WEIGHT - 0.01)
    item.status = statusOf(item.weight)
  }
  item.importance = weightToImportance(item.weight)
  item.lastDecay = Date.now()
  return item
}

/** 旧版合并：保留信息更全的那句，并给成色加一点。 */
function mergeIntoExisting(target, text, tags, now) {
  if (text.length > target.text.length) target.text = text
  target.tags = [...new Set([...target.tags, ...tags])].slice(0, MEMORY_TAG_MAX)
  target.weight = Math.min(1, (target.weight ?? 0.5) + 0.05)
  target.status = statusOf(target.weight)
  target.importance = weightToImportance(target.weight)
  target.accessCount = Number(target.accessCount ?? 0) + 1
  target.lastAccess = now
  target.lastDecay = now
}

/** 画像字段的键：历史条目靠它认领「我属于哪个槽位」。 */
function profileFieldKey(layer, field) {
  return `${layer.toLowerCase()}.${field}`
}

/**
 * 画像/近况的字段级校验：宁可不提升，也不把半句话写进槽位。
 * 返回 `{ ok, field, reason }`；不通过时调用方保留 L2，绝不截断后硬写。
 */
function validateProfileValue(layer, field, value) {
  const text = cleanInline(value)
  if (text === '') return { ok: false, field: '', reason: 'empty' }
  const isL0 = layer === 'L0'
  const resolved = isL0 ? resolveL0Field(field, text) : resolveL1Field(field, text)
  if (!(isL0 ? L0_FIELDS : L1_FIELDS).includes(resolved)) {
    return { ok: false, field: resolved, reason: 'field' }
  }
  const length = Array.from(text).length
  if (isL0) {
    // 稳定画像只收「称呼/职业/爱好/语言/固定信息」的一句话说清的值；
    // 落点已经在白名单里，超长就说明它是自述而不是画像。
    if (length > PROFILE_L0_MAX) return { ok: false, field: resolved, reason: 'too-long' }
    return { ok: true, field: resolved, reason: 'ok' }
  }
  if (length > PROFILE_L1_MAX) return { ok: false, field: resolved, reason: 'too-long' }
  // 整段自我介绍（逗号/句号太多，或以「我/用户」开头又太长）不是近况。
  const breaks = (text.match(/[，,。.]/g) ?? []).length
  if (breaks > PROFILE_L1_BREAKS) return { ok: false, field: resolved, reason: 'sentence' }
  if (/^(我|用户)/.test(text) && length > PROFILE_L1_SELF_MAX) {
    return { ok: false, field: resolved, reason: 'self-intro' }
  }
  return { ok: true, field: resolved, reason: 'ok' }
}

/**
 * 覆盖 L0/L1 之前留痕：旧值先转成一条低成色 L2（tags:['历史']），再写新值。
 * 每个字段只保留最近 3 条历史，更老的归档——槽位会反复覆盖，但库不能被撑爆。
 */
function archiveProfileValue(layer, field, previous, now) {
  const text = cleanMemoryText(`（旧）${previous}`)
  if (text === '') return null
  const key = profileFieldKey(layer, field)
  const item = {
    id: newMemoryId(),
    text,
    tags: ['历史'],
    importance: weightToImportance(PROFILE_HISTORY_WEIGHT),
    weight: PROFILE_HISTORY_WEIGHT,
    layer: 'L2',
    status: statusOf(PROFILE_HISTORY_WEIGHT),
    pinned: false,
    accessCount: 0,
    lastAccess: now,
    lastDecay: now,
    emotion: 0,
    created: new Date(now).toISOString(),
    historyField: key,
  }
  memoryStore.items.unshift(item)
  if (memoryStore.items.length > MEMORY_LIMIT) memoryStore.items.length = MEMORY_LIMIT
  const history = memoryStore.items
    .filter((entry) => entry.layer === 'L2' && entry.historyField === key)
    .sort((a, b) => (Date.parse(b.created) || 0) - (Date.parse(a.created) || 0))
  for (const stale of history.slice(PROFILE_HISTORY_KEEP)) stale.status = 'archived'
  return item
}

/** 统一的 L0/L1 写入（含留痕）；所有提升路径都必须走这里。 */
function writeProfileValue(layer, field, value, now = Date.now()) {
  const isL0 = layer === 'L0'
  const bucket = isL0 ? memoryStore.profile.l0 : memoryStore.profile.l1
  const previous = typeof bucket[field] === 'string' ? bucket[field] : ''
  if (previous !== '' && previous !== value) archiveProfileValue(layer, field, previous, now)
  const updated = isL0
    ? nextL0(memoryStore.profile.l0, field, value, { now })
    : nextL1(memoryStore.profile.l1, field, value, { now })
  if (isL0) memoryStore.profile.l0 = updated
  else memoryStore.profile.l1 = updated
  return previous
}

/** 画像条目的对外形状（降级直写时仍按 v0.6 返回 profile-* 条目）。 */
function profileEntryFor(layer, field, text, tags, now) {
  return {
    id: `profile-${layer.toLowerCase()}-${field}`,
    text,
    tags,
    layer,
    field,
    importance: 5,
    weight: 1,
    status: 'active',
    pinned: true,
    created: new Date(now).toISOString(),
    accessCount: 0,
    lastAccess: now,
    lastDecay: now,
    emotion: 0,
  }
}

/**
 * 规则分层的降级直写（LLM 不可用）：保持 v0.6 行为——不进 L2、直接改画像。
 * 这里刻意不经过字段校验：v0.6 的规则层就是「怎么写就怎么落」，
 * 校验只拦云端模型的提升建议，别让降级路径反而改变老行为。
 */
function applyCandidateLayer(item, layer, field, options = {}) {
  if (layer !== 'L0' && layer !== 'L1') return null
  const index = memoryStore.items.indexOf(item)
  if (index < 0) return null
  const text = cleanMemoryText(item.text)
  if (text === '') return null
  const isL0 = layer === 'L0'
  const resolved = isL0 ? resolveL0Field(field, text) : resolveL1Field(field, text)
  const now = options.now ?? Date.now()
  writeProfileValue(layer, resolved, text, now)
  const current = memoryStore.items.indexOf(item)
  if (current >= 0) memoryStore.items.splice(current, 1)
  return profileEntryFor(layer, resolved, text, [...item.tags], now)
}

/** 把一条 L2 事件迁移进 L0 / L1 画像（LLM 判层结果，先校验再落）。 */
function moveItemToProfile(item, layer, field) {
  if (layer !== 'L0' && layer !== 'L1') return false
  const index = memoryStore.items.indexOf(item)
  if (index < 0) return false
  const text = cleanMemoryText(item.text)
  if (text === '') return false
  const checked = validateProfileValue(layer, field, text)
  // 校验失败就留在 L2：不移动、不改画像，也不截断后硬写半句话。
  if (checked.ok !== true) return false
  const now = Date.now()
  writeProfileValue(layer, checked.field, text, now)
  const current = memoryStore.items.indexOf(item)
  if (current >= 0) memoryStore.items.splice(current, 1)
  return true
}

/** 应用 LLM 的分层 / 标签结果；改了返回 true。 */
function applyJudgement(item, judgement) {
  if (judgement === null || typeof judgement !== 'object') return false
  if (memoryStore.items.includes(item) !== true) return false
  let changed = false
  if (Array.isArray(judgement.tags) && judgement.tags.length > 0) {
    const merged = [...new Set([...item.tags, ...judgement.tags])].slice(0, MEMORY_TAG_MAX)
    if (JSON.stringify(merged) !== JSON.stringify(item.tags)) {
      item.tags = merged
      changed = true
    }
  }
  if (judgement.layer === 'L0' || judgement.layer === 'L1') {
    if (moveItemToProfile(item, judgement.layer, judgement.field)) changed = true
  }
  return changed
}

/**
 * 异步分层（不阻塞这一轮）：LLM 只做「补强」——把 L2 事件挪进画像/近况、
 * 补标签；返回 null 时什么都不做，规则分层原样保留。
 * 注意：粗筛已经通过，LLM 的 keep=false 不删数据，只当作「不改」。
 */
function scheduleJudgement(ctx, item, text, options = {}) {
  const manager = memoryLlmFor(ctx)
  if (manager === null || manager.canCall() !== true) return
  void enqueueMemoryWork(ctx, async () => {
    const judgement = await manager.judge(text)
    if (judgement === null) {
      // LLM 这一次没给出结果（超时 / 坏 JSON）：规则判成 L0/L1 时按 v0.6 降级直写。
      if (options.candidateLayer === 'L0' || options.candidateLayer === 'L1') {
        const promoted = applyCandidateLayer(item, options.candidateLayer, options.field)
        if (promoted !== null && ctx !== null && ctx !== undefined) await afterMemoryMutation(ctx)
      }
      return null
    }
    if (judgement.keep === false) return null
    const changed = applyJudgement(item, judgement)
    if (changed && ctx !== null && ctx !== undefined) await afterMemoryMutation(ctx)
    return judgement
  })
}

/**
 * 异步冲突裁决（相似度 >= 0.6）：
 * - merge / replace：把候选并进已有条目，删掉候选；
 * - add：两件不同的事，都留下；
 * - review / null：回落到 bestSim >= 0.86 || contained 的旧判断。
 */
function scheduleConflictResolution(ctx, item, existing, meta) {
  const manager = memoryLlmFor(ctx)
  if (manager === null || manager.canCall() !== true) return
  void enqueueMemoryWork(ctx, async () => {
    if (memoryStore.items.includes(item) !== true || memoryStore.items.includes(existing) !== true) return null
    let result = null
    try {
      result = await manager.resolve(existing, item)
    } catch {
      result = null
    }
    const action = result !== null && typeof result.action === 'string' ? result.action : 'rule'
    const ruleMerge = meta.bestSim >= 0.86 || meta.contained
    if (action === 'add') return result
    if (action === 'rule' || action === 'review') {
      if (ruleMerge !== true) {
        // 保留两边，并记下「和谁像」，面板能看出这条是待观察的。
        item.conflictWith = [...new Set([...(item.conflictWith ?? []), existing.id])]
        return result
      }
    }
    const index = memoryStore.items.indexOf(item)
    if (index < 0) return null
    if (action === 'replace') {
      existing.text = result !== null && typeof result.text === 'string' && result.text !== ''
        ? result.text
        : item.text
      existing.tags = [...new Set([...existing.tags, ...item.tags])].slice(0, MEMORY_TAG_MAX)
      existing.weight = Math.min(1, (existing.weight ?? 0.5) + 0.05)
      existing.status = statusOf(existing.weight)
      existing.importance = weightToImportance(existing.weight)
      existing.accessCount = Number(existing.accessCount ?? 0) + 1
      existing.lastAccess = Date.now()
      existing.lastDecay = existing.lastAccess
    } else if (action === 'merge' && result !== null && typeof result.text === 'string' && result.text !== '') {
      existing.text = result.text
      mergeIntoExisting(existing, existing.text, item.tags, Date.now())
    } else {
      // action=merge（没给正文）或 rule 合并：沿用旧规则「谁更长留谁」。
      mergeIntoExisting(existing, item.text, item.tags, Date.now())
    }
    memoryStore.items.splice(index, 1)
    if (ctx !== null && ctx !== undefined) await afterMemoryMutation(ctx)
    return result
  })
}

/** 新建一条 L2 事件（规则 / LLM 两条路共用）。 */
function newL2Item(text, tags, options, now) {
  return {
    id: newMemoryId(),
    text,
    tags,
    importance: 3,
    weight: importanceToWeight(3),
    layer: 'L2',
    status: 'active',
    pinned: options.pinned === true,
    accessCount: 0,
    lastAccess: now,
    lastDecay: now,
    emotion: Number.isFinite(Number(options.emotion)) ? Math.min(1, Math.max(0, Number(options.emotion))) : 0,
    created: new Date(now).toISOString(),
  }
}

/**
 * 加一条记忆。返回落库后的条目（写盘与重挂由调用方收尾）。
 *
 * 流程（融合自 Cyrene-Agent 的 memory-manager）：
 *  1. `judgeCandidate` 挡掉过程性内容（寒暄/问句/报错/代码块）；
 *  2. 规则只算一个 `candidateLayer`，**一律先落一条 L2**——不再有「判成 L0/L1
 *     就直接 return」的分支；画像/近况写错了会污染每一轮，必须再让一层判断；
 *  3. LLM 可用：异步 `judge()` 决定是否提升；只有返回 L0/L1 且通过字段校验
 *     （`moveItemToProfile`）才移动，返回 L2 就留在事件层；
 *  4. LLM 不可用：按 `candidateLayer` 降级直写（v0.6 行为），这条临时 L2 会被移除；
 *  5. L2 仍按老规则判重：相似度 >= 0.86 或互相包含就同步合并；LLM 可用时
 *     相似度 >= 0.6 先落候选，再异步 resolve() 决定 merge/replace/add。
 */
function addMemory(text, tags, options = {}) {
  const ctx = options.ctx
  const judgement = judgeCandidate(text, {
    explicit: options.explicit === true,
    layer: options.layer,
  })
  if (!judgement.keep) return null
  const clean = cleanMemoryText(text)
  if (clean === '') return null
  const cleanTags = cleanMemoryTags(tags)
  const now = Date.now()
  const candidateLayer = judgement.layer === 'L0' || judgement.layer === 'L1' ? judgement.layer : 'L2'
  const manager = memoryLlmFor(ctx)
  const llmCan = manager !== null && manager.canCall() === true

  if (candidateLayer !== 'L2' && llmCan !== true) {
    // 云端模型不可用：保持 v0.6 的「规则层直接落地」。先落 L2 再提升，
    // 保证所有写入都经过同一个入口；提升成功后这条 L2 会被移除。
    const fallback = newL2Item(clean, cleanTags, options, now)
    memoryStore.items.unshift(fallback)
    if (memoryStore.items.length > MEMORY_LIMIT) memoryStore.items.length = MEMORY_LIMIT
    const promoted = applyCandidateLayer(fallback, candidateLayer, options.field, { now })
    return promoted !== null ? promoted : fallback
  }

  const tokens = tokenize(clean)
  let best = null
  let bestSim = 0
  for (const item of memoryStore.items) {
    if (item.layer !== 'L2') continue
    const sim = similarity(tokens, tokenize(item.text))
    if (sim > bestSim) {
      bestSim = sim
      best = item
    }
  }

  // 合并判据有两条，满足其一即可：
  //  a) 2-gram 相似度够高（同一件事换个说法）；
  //  b) 一条是另一条的子串（「原句 + 补充」是最常见的增量写法）。
  // 只靠阈值会漏掉 b——补一句后缀会把 2-gram 相似度稀释到阈值以下。
  const contained = best !== null && (clean.includes(best.text) || best.text.includes(clean))

  if (best !== null && (bestSim >= 0.86 || contained) && llmCan !== true) {
    mergeIntoExisting(best, clean, cleanTags, now)
    return best
  }

  const item = {
    ...newL2Item(clean, cleanTags, options, now),
    ...(best !== null && bestSim >= 0.6
      ? { conflictWith: [best.id] }
      : {}),
  }
  memoryStore.items.unshift(item)
  if (memoryStore.items.length > MEMORY_LIMIT) memoryStore.items.length = MEMORY_LIMIT

  // 顺序很重要：先裁决冲突，再补分层/标签，最后才考虑压缩。
  if (best !== null && bestSim >= 0.6 && llmCan === true) {
    scheduleConflictResolution(ctx, item, best, { bestSim, contained })
  }
  // 规则层也交给 LLM 复核：返回 L0/L1 时再走字段校验 + 留痕提升，返回 L2 就保持。
  if (llmCan === true) {
    scheduleJudgement(ctx, item, clean, { candidateLayer, field: options.field })
  }
  // 实施单 §9.5：压缩的触发点在写入之后；它只动 status 与新增摘要，
  // 不改这一条刚写进来的正文，所以返回值照旧。
  maybeCompressMemories(ctx)
  return item
}

/**
 * 检索：语义式召回（2-gram 相似度 + 成色 + 新鲜度），而不是子串匹配。
 *
 * 空关键词退化成「最近/最重要的几条」。命中结果会被 touch 一次
 * （成色 +0.02、访问计数 +1）——被想起来的事本来就更难忘掉。
 * 调用方负责在之后 persist，因为这里只动内存。
 */
function searchMemories(query, limit) {
  const max = Math.min(MEMORY_LIMIT, Math.max(1, Number.isFinite(Number(limit)) ? Math.round(Number(limit)) : MEMORY_TOOL_DEFAULT))
  const needle = typeof query === 'string' ? query.trim() : ''
  const now = Date.now()

  if (needle === '') {
    return [...memoryStore.items]
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .slice(0, max)
  }

  const tokens = tokenize(needle)
  const scored = []
  for (const item of memoryStore.items) {
    if (item.layer !== 'L2') continue
    const sim = similarity(tokens, tokenize(`${item.text} ${item.tags.join(' ')}`))
    if (sim <= 0) continue
    scored.push({ item, sim, score: scoreRecall(item, tokens, { now, sim }) })
  }
  scored.sort((a, b) => b.score - a.score)
  const picked = scored.slice(0, max)
  for (const { item } of picked) {
    const touched = touchWeight(item, now)
    item.weight = touched.weight
    item.accessCount = touched.accessCount
    item.lastAccess = touched.lastAccess
    item.lastDecay = now
    item.status = statusOf(item.weight)
    item.importance = weightToImportance(item.weight)
  }
  return picked.map((entry) => entry.item)
}

/**
 * 把记忆能力交给模型：三个工具（写 / 找 / 忘）。
 * 用 `ctx.get('tools')` 取可选服务——老宿主没有这个服务时整块安静跳过，
 * 面板与注入照常工作（降级成"只能自己手动记"）。
 */
function registerMemoryTools(ctx) {
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return null
  const disposers = []
  const textOutput = {
    // 宿主校验的是 value 的整体形状：工具必须返回对象（不能返回裸字符串），
    // 否则调用会报 "value" must be an object。这里宽松到「对象里带 text 就用 text」。
    schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string'
        ? value
        : (value !== null && typeof value === 'object' && typeof value.text === 'string')
          ? value.text
          : JSON.stringify(value, null, 2),
    }],
  }
  const register = (definition) => {
    try {
      const dispose = tools.register({ ...definition, output: textOutput })
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      ctx.logger?.warn?.(`${PACKAGE_ID}: 注册工具 ${definition.name} 失败`, error)
    }
  }
  register({
    name: 'cyrene_memory_add',
    description: '往昔涟的记忆里存一条。会按内容自动分层：稳定的身份信息（称呼/职业/长期爱好/语言）进画像，近期目标/偏好/在忙的事进近况，其余进长期事件。只在真的值得以后还记得时用：偏好、约定、长期事实、踩过的坑。一条只说一件事，不超过 600 字；别存对话过程、别存临时状态。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的那件事，主语明确、能独立读懂（例如"用户偏好深色主题，屏幕是 2560×1600"）。' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选标签，最多 8 个，用于以后检索（例如 ["偏好","环境"]）。' },
        layer: { type: 'string', enum: ['L0', 'L1', 'L2'], description: '可选：强制分层。不填则按内容自动判断。' },
        field: { type: 'string', description: '可选：画像字段名（preferredName / occupation / longTermInterests / language / permanentNote 或 recentGoals / recentPreferences / currentProject）。' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(args) {
      const before = memoryStore.items.length
      const item = addMemory(args?.text, args?.tags, {
        ctx,
        layer: args?.layer,
        field: args?.field,
      })
      if (item === null) return { ok: false, error: 'nothing-to-remember' }
      memoryStore.rev += 1
      await persistMemories(ctx)
      // 实施单 §5.2：写入之后补账（合并也走这里；老记录不覆盖）。
      await syncMemoryLedger(ctx)
      remountMemory(ctx.systemPrompt)
      return {
        ok: true,
        id: item.id,
        layer: item.layer,
        // 合并进旧条目时 count 不变——如实告诉模型，它就不会以为「写了两份」。
        merged: item.layer === 'L2' && memoryStore.items.length === before,
        count: memoryStore.items.length,
      }
    },
  })
  register({
    name: 'cyrene_memory_search',
    description: '在昔涟的记忆里找旧事。按语义相关度排序（不只是字面包含），命中的条目会被顺带「想起一次」——用得越多越难忘。不确定用户以前说过什么、做过什么约定时先用它翻一遍，别凭印象猜。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的事，用短句或关键词都行；留空则返回成色最高的几条。' },
        limit: { type: 'integer', description: '最多返回几条（默认 8）。' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const items = searchMemories(args?.query, args?.limit)
      // 召回会 touch 成色，所以这里也要落盘（否则下次启动又缩回去）。
      await persistMemories(ctx)
      remountMemory(ctx.systemPrompt)
      return {
        total: memoryStore.items.length,
        returned: items.length,
        items: items.map((item) => ({
          id: item.id,
          text: item.text,
          tags: [...item.tags],
          created: item.created,
          layer: item.layer,
          importance: item.importance,
          weight: Number(item.weight ?? 0),
          status: item.status,
          // 摘要条目在检索结果里也标出来，模型/面板知道这一条是压缩过的。
          isSummary: item.isSummary === true,
        })),
      }
    },
  })
  register({
    name: 'cyrene_memory_forget',
    description: '从记忆里删掉一条（用 cyrene_memory_search 拿到的 id）。也能删画像/近况字段（id 形如 profile-l0-preferredName）。用户说"忘掉这个"、或发现记错了时用。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '记忆条目的 id。' } },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(args) {
      const id = typeof args?.id === 'string' ? args.id : ''
      const profileMatch = /^profile-(l0|l1)-([A-Za-z]+)$/.exec(id)
      if (profileMatch !== null) {
        const bucket = profileMatch[1] === 'l0' ? 'l0' : 'l1'
        const field = profileMatch[2]
        const target = memoryStore.profile[bucket]
        if (target === undefined || target[field] === undefined) return { ok: false, error: 'not-found' }
        delete target[field]
        memoryStore.rev += 1
        await persistMemories(ctx)
        remountMemory(ctx.systemPrompt)
        return { ok: true, count: memoryStore.items.length }
      }
      const index = memoryStore.items.findIndex((item) => item.id === id)
      if (index < 0) return { ok: false, error: 'not-found' }
      memoryStore.items.splice(index, 1)
      memoryStore.rev += 1
      await persistMemories(ctx)
      // 删掉之后补账：sync 只补新 id，不会把删掉的那条从账本里抹掉——
      // 那正是账本该留下的证据（verify 会报 missing，提醒这里有删除动作）。
      await syncMemoryLedger(ctx)
      remountMemory(ctx.systemPrompt)
      return { ok: true, count: memoryStore.items.length }
    },
  })
  register({
    name: 'cyrene_memory_profile',
    description: '读昔涟现在的画像（她记得的你：称呼、职业、爱好、近况）和你们的关系状态。想确认「我该怎么称呼他」「我们熟到什么程度」时用它，比翻搜索结果更直接。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const l0 = {}
      for (const field of L0_FIELDS) if (memoryStore.profile.l0[field] !== undefined) l0[field] = memoryStore.profile.l0[field]
      const l1 = {}
      for (const field of L1_FIELDS) if (memoryStore.profile.l1[field] !== undefined) l1[field] = memoryStore.profile.l1[field]
      const relationship = memoryStore.relationship
      return {
        l0,
        l0Labels: L0_LABELS,
        l1,
        l1Labels: L1_LABELS,
        relationship: {
          summary: relationshipSummary(relationship),
          turns: relationship.turns,
          affinity: relationship.affinity,
          trust: relationship.trust,
          streakDays: relationship.streakDays,
          dominantEmotion: relationship.dominant?.label ?? '平静',
          lastMood: relationship.lastMood,
          nextCareCue: relationship.nextCareCue,
        },
        itemCount: memoryStore.items.length,
      }
    },
  })
  /**
   * 整理记忆：交给（可以是免费的）云模型做一次去重与精简。
   *
   * 为什么做成工具而不是后台自动跑：整理会删条目，属于不可逆操作，
   * 应该由用户/模型显式触发，并且能看见改了什么。
   */
  register({
    name: 'cyrene_memory_organize',
    description: '整理记忆库：让模型把重复的条目并成一条、丢掉没价值的（寒暄/临时状态）。只删不改写别的，也不会凭空新增。整理会动真实数据，建议先确认用户同意。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多整理多少条（默认 40，上限 80）。' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const manager = memoryLlmFor(ctx)
      if (manager === null || manager.canCall() !== true) {
        return { ok: false, error: '记忆整理需要一个可用的模型（面板里配好 provider/model，或留空自动选）' }
      }
      const limit = Math.min(80, Math.max(2, Math.round(Number(args?.limit ?? 40))))
      const pool = memoryStore.items.filter((item) =>
        item.layer === 'L2' && item.isSummary !== true && item.status !== 'archived')
      if (pool.length < 2) return { ok: true, removed: 0, merged: 0, note: '条目太少，不用整理' }
      const batch = pool.slice(0, limit)
      const plan = await manager.organize(batch.map((item) => ({
        id: item.id, text: item.text, tags: item.tags,
      })))
      if (plan === null) {
        return { ok: false, error: manager.lastError ?? '模型返回不合法，未做改动' }
      }
      const byId = new Map(batch.map((item) => [item.id, item]))
      let removed = 0
      let merged = 0
      for (const id of plan.drop) {
        const index = memoryStore.items.findIndex((item) => item.id === id)
        if (index >= 0) {
          memoryStore.items.splice(index, 1)
          removed += 1
        }
      }
      const now = Date.now()
      for (const group of plan.merge) {
        const sources = group.ids.map((id) => byId.get(id)).filter((item) => item !== undefined)
        if (sources.length < 2) continue
        const mergedItem = newL2Item(group.text, ['合并'], {}, now)
        mergedItem.isSummary = true
        mergedItem.subEntryIds = sources.map((item) => item.id)
        for (const source of sources) {
          const index = memoryStore.items.findIndex((item) => item.id === source.id)
          if (index >= 0) memoryStore.items.splice(index, 1)
        }
        memoryStore.items.unshift(mergedItem)
        merged += sources.length
      }
      if (removed > 0 || merged > 0) {
        await afterMemoryMutation(ctx)
        ctx.logger?.info?.(`${PACKAGE_ID}: 记忆整理完成——删除 ${removed} 条、合并 ${merged} 条`)
      }
      return { ok: true, removed, merged, scanned: batch.length }
    },
  })

  register({
    name: 'cyrene_memory_pin',
    description: '把一条记忆钉住 / 取消钉住（用 cyrene_memory_search 拿到的 id）。钉住的记忆永不衰减、会稳定排在注入里；取消钉住后重新按成色衰减。用户说「这件事别忘了」「这个就定下来」时用。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆条目的 id。' },
        pinned: { type: 'boolean', description: 'true 钉住（默认），false 取消钉住。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(args) {
      const id = typeof args?.id === 'string' ? args.id : ''
      const item = memoryStore.items.find((entry) => entry.id === id)
      if (item === undefined) return { ok: false, error: 'not-found' }
      pinMemory(item, args?.pinned !== false)
      memoryStore.rev += 1
      await persistMemories(ctx)
      remountMemory(ctx.systemPrompt)
      return {
        ok: true,
        id: item.id,
        pinned: item.pinned,
        weight: item.weight,
        status: item.status,
        count: memoryStore.items.length,
      }
    },
  })
  register({
    name: 'cyrene_memory_stats',
    description: '读记忆系统的现状：各状态条数、钉住数、账本是否对得上、以及每日健康那一行。想确认「记忆还在不在、有没有丢过」时用它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      // 实施单 §5.2 + §5.3：账本状态和健康行一起给，省得模型分两次问。
      const report = await ledgerReport()
      const health = memoryHealthValue(report)
      return {
        ok: true,
        // 健康那一行放在 text 里：工具的 output.render 会直接展示它。
        text: health.line,
        line: health.line,
        date: health.date,
        counts: {
          total: health.total,
          pinned: health.pinned,
          active: health.active,
          aging: health.aging,
          archived: health.archived,
        },
        ledger: {
          state: health.ledger,
          entries: report.entries,
          checked: report.checked,
          mismatched: report.mismatched,
          missing: report.missing,
          unledgered: report.unledgered,
          path: report.ledgerPath,
        },
        injectCap: health.injectCap,
        pending: 0,
        path: health.path,
        total: health.total,
        pinned: health.pinned,
        active: health.active,
        aging: health.aging,
        archived: health.archived,
      }
    },
  })
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 已随 fiber 回收
      }
    }
  }
}

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

/** 读盘（或重读）。没有文件不算错误——世界书是可选资料。 */
let worldbookLoading = null

/**
 * 读一次盘。这里要「并发调用共享同一个 promise」：先把 loaded 标记置位再 await，
 * 第二个调用者会立刻拿到一个空库——世界书工具在开机那一瞬间被调用时真踩到过。
 */
function ensureWorldbook(ctx, force = false) {
  if (force !== true && worldbookLoading !== null) return worldbookLoading
  if (worldbookLoaded === true && force !== true) return Promise.resolve(worldbookStore)
  worldbookLoaded = true
  worldbookLoading = (async () => {
    try {
      const text = await readFile(worldbookPath(), 'utf8')
      const parsed = JSON.parse(text)
      worldbookStore = {
        entries: sanitizeEntries(parsed?.entries),
        source: typeof parsed?.source === 'string' ? parsed.source : '',
        version: typeof parsed?.sourceVersion === 'string' ? parsed.sourceVersion : '',
        fetchedAt: typeof parsed?.fetchedAt === 'string' ? parsed.fetchedAt : '',
        error: null,
      }
    } catch (error) {
      worldbookStore = { ...EMPTY_WORLDBOOK }
      if (error?.code !== 'ENOENT') {
        worldbookStore.error = `世界书读不出来：${error?.message || error}`
        ctx?.logger?.warn?.(`${PACKAGE_ID}: 世界书读不出来（不影响主题与人格）`, error)
      }
    }
    return worldbookStore
  })()
  worldbookLoading = worldbookLoading.finally(() => {
    worldbookLoading = null
  })
  return worldbookLoading
}

/** 面板要的那份快照：带一份「不背正文」的条目索引。 */
function publicWorldbook() {
  const stats = summarizeEntries(worldbookStore.entries)
  return {
    error: worldbookStore.error,
    count: stats.count,
    characters: stats.characters,
    categories: stats.categories,
    source: worldbookStore.source,
    version: worldbookStore.version,
    fetchedAt: worldbookStore.fetchedAt,
    path: worldbookPath(),
    entries: worldbookStore.entries.map((item) => ({
      id: item.id,
      name: item.name,
      character: item.character,
      category: item.category,
      keys: [...item.keys],
      size: item.content.length,
    })),
  }
}

/** 常驻那一行：只说「库里有什么、什么时候该去查」，正文不进来。 */
function worldbookText() {
  if (worldbookStore.entries.length === 0) return ''
  const stats = summarizeEntries(worldbookStore.entries)
  const names = stats.characters.map((row) => `${row.name}（${row.total}）`).join('、')
  const version = worldbookStore.version === '' ? '' : `（版本 ${worldbookStore.version}）`
  const lines = [
    '',
    '【昔涟 · 世界书】',
    `这里有一份整理自官方 wiki 的翁法罗斯设定库${version}，共 ${stats.count} 条，覆盖：${names}。`,
    '聊到这些角色、他们的故事、彼此的关系，或者翁法罗斯的地理与设定时，先调用 cyrene_worldbook_search 查一遍再回答；查到什么说什么，查不到就直说记不准——不要凭印象编设定。',
  ]
  const text = lines.join('\n')
  return text.length > WORLDBOOK_SECTION_BUDGET ? text.slice(0, WORLDBOOK_SECTION_BUDGET) : text
}

let disposeWorldbookSection = null
let mountedWorldbookText = null

/** 和人格、记忆同一套「先卸再挂」，正文为空就不注册；正文没变就不折腾。 */
function remountWorldbook(prompt) {
  const text = worldbookText()
  if (disposeWorldbookSection !== null && text === mountedWorldbookText) return
  if (disposeWorldbookSection !== null) {
    try {
      disposeWorldbookSection()
    } catch {
      // 旧 section 已经跟着 fiber 消失
    }
    disposeWorldbookSection = null
  }
  mountedWorldbookText = text === '' ? null : text
  if (text === '') return
  disposeWorldbookSection = prompt.section({
    name: WORLDBOOK_SECTION_NAME,
    order: resolvePersonaOrder(prompt) + 10,
    text,
  })
}

/** 按关键词取条目：总预算有限，放不下的那几条只报个数。 */
function searchWorldbook(query, limit) {
  const hits = matchEntries(worldbookStore.entries, query, limit)
  const blocks = []
  const list = []
  let used = 0
  let dropped = 0
  for (const hit of hits) {
    const head = `## ${hit.name}（命中：${hit.matched.join('、')}）`
    let body = hit.content
    if (body.length > WORLDBOOK_ENTRY_SHOWN) body = `${body.slice(0, WORLDBOOK_ENTRY_SHOWN)}…（已截断）`
    const block = `${head}\n${body}`
    if (used + block.length > WORLDBOOK_TOOL_BUDGET) {
      dropped += 1
      continue
    }
    blocks.push(block)
    used += block.length + 2
    list.push({
      id: hit.id,
      name: hit.name,
      character: hit.character,
      category: hit.category,
      matched: hit.matched,
    })
  }
  const parts = blocks.join('\n\n---\n\n')
  const tail = dropped === 0 ? '' : `\n\n（还有 ${dropped} 条没放进预算：换个更具体的关键词再查，或者调小 limit 只看最相关的。）`
  return { hits: list, text: `${parts}${tail}`.trim(), count: hits.length, dropped };
}

/** 把世界书交给模型：一个检索工具。取不到 tools 服务就整块跳过。 */
function registerWorldbookTools(ctx) {
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return null
  const disposers = []
  const textOutput = {
    // 宿主校验的是 value 的整体形状：工具必须返回对象（不能返回裸字符串），
    // 否则调用会报 "value" must be an object。这里宽松到「对象里带 text 就用 text」。
    schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string'
        ? value
        : (value !== null && typeof value === 'object' && typeof value.text === 'string')
          ? value.text
          : JSON.stringify(value, null, 2),
    }],
  }
  try {
    const dispose = tools.register({
      name: 'cyrene_worldbook_search',
      description: '查昔涟的世界书（翁法罗斯的角色档案、角色故事、角色关系、角色解析）。问到某个角色的生平、设定、彼此关系，或者拿不准的剧情细节时先查这里，别凭印象编。关键词写角色名或专有名词效果最好；一次只给最相关的几条。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要查的关键词，通常是角色名（如「白厄」「昔涟」）或专有名词；可以带上想问的方面（如「白厄 童年」）。' },
          limit: { type: 'integer', description: `最多给几条，默认 ${WORLDBOOK_TOOL_DEFAULT}，上限 20。` },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: textOutput,
      execute: async (args) => {
        await ensureWorldbook(ctx)
        const query = String(args?.query || '')
        const result = searchWorldbook(args?.query, args?.limit)
        // 必须返回对象：宿主的 output.schema 是 object，返回裸字符串会报
        // `"value" must be an object`（真踩过，工具当场用不了）。
        if (result.count === 0) {
          return {
            text: `世界书里没有命中「${query}」的条目。可以换个角色名或专有名词再试；确实没有就直说记不准，不要编。`,
            count: 0,
            dropped: 0,
            hits: [],
          }
        }
        return {
          text: `命中 ${result.count} 条（关键词：${query}）\n\n${result.text}`,
          count: result.count,
          dropped: result.dropped,
          hits: result.hits,
        }
      },
    })
    if (typeof dispose === 'function') disposers.push(dispose)
  } catch (error) {
    ctx.logger?.warn?.(`${PACKAGE_ID}: 注册 cyrene_worldbook_search 失败`, error)
  }
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // 已经跟着 fiber 消失
      }
    }
  }
}

/** 去官方 wiki 抓一份、切条、落盘。失败把原因抛给调用方（面板上要显示）。 */
async function fetchWorldbook() {
  if (typeof fetch !== 'function') throw new Error('这个 Node 运行时没有内置 fetch')
  const url = `${WORLDBOOK_WIKI_URL}?lang=zh-cn`
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
  const raw = await response.json()
  if (raw?.retcode !== 0 || raw?.data === null || raw?.data === undefined) {
    throw new Error(`接口没给数据：${raw?.message || `retcode ${raw?.retcode}`}`)
  }
  const entries = buildEntries(raw.data)
  if (entries.length === 0) throw new Error('一条条目都没切出来，可能接口结构变了')
  const document = packWorldbook(entries, {
    source: url,
    sourceVersion: String(raw.data.current_version || ''),
  })
  // 先写临时文件再原子改名：抓取中断时不会留下半份坏 json。
  const target = worldbookPath()
  const staging = `${target}.tmp`
  await writeFile(staging, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  await rename(staging, target)
  worldbookStore = {
    entries: sanitizeEntries(document.entries),
    source: document.source,
    version: document.sourceVersion,
    fetchedAt: document.fetchedAt,
    error: null,
  }
  worldbookLoaded = true
  return worldbookStore
}

/**
 * 当前人格 section 的 disposer（每次重挂前先卸掉旧的）。
 * `null` 表示当前没有挂载。
 */
let disposeSection = null

/** 人格 section 的兜底落点。 */
const PERSONA_ORDER_FALLBACK = 100

/**
 * 人格 section 的 order：紧跟部署人格前缀（order 0），
 * 又远早于 PLAN_POLICY(500)，所以既在通用人格之后、又在工具策略之前。
 * 键名在不同 DSH 版本里改过（新版是 DEPLOYMENT_PERSONA_PREFIX，
 * 旧版是 DEPLOYMENT_PERSONA），所以逐个尝试；都取不到就用兜底值。
 */
function resolvePersonaOrder(prompt) {
  for (const key of ['DEPLOYMENT_PERSONA', 'DEPLOYMENT_PERSONA_PREFIX']) {
    try {
      const order = prompt.getSectionOrder(key)
      if (Number.isFinite(order)) return order + PERSONA_ORDER_FALLBACK
    } catch {
      // 键名不存在就换下一个
    }
  }
  return PERSONA_ORDER_FALLBACK
}

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
  return state.persona + stickerText()
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
    void ensureMemories(ctx).then(() => {
      remountMemory(ctx.systemPrompt)
      remountRelationship(ctx.systemPrompt)
      disposeTools = registerMemoryTools(ctx)
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
      if (disposeMemorySection !== null) {
        try {
          disposeMemorySection()
        } catch {
          // 同上
        }
        disposeMemorySection = null
      }
      if (disposeRelationshipSection !== null) {
        try {
          disposeRelationshipSection()
        } catch {
          // 同上
        }
        disposeRelationshipSection = null
      }
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
      if (disposeWorldbookSection !== null) {
        try {
          disposeWorldbookSection()
        } catch {
          // 同上
        }
        disposeWorldbookSection = null
      }
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
              worldbookStore = { ...EMPTY_WORLDBOOK }
              worldbookLoaded = true
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

# dsh-cyrene-theme · 昔涟主题

[![npm](https://img.shields.io/npm/v/dsh-cyrene-theme?label=npm&color=e87cae)](https://www.npmjs.com/package/dsh-cyrene-theme)
[![license](https://img.shields.io/badge/license-MIT-e87cae)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/berhbro/dsh-cyrene-theme?color=e87cae)](https://github.com/berhbro/dsh-cyrene-theme)

把 DSH Web GUI 换成《崩坏：星穹铁道》昔涟（Cyrene）的粉白渐变毛玻璃主题，把 agent 的人格设定改成昔涟——人格提示词可以直接在侧边栏里改——让她在该有情绪的时候贴一张自己的表情包，把新会话欢迎页的鱼换成她、顺手把输入框的默认提示换成她的话，还能把整页背景换成 `Background/` 里放的那几张图（可以在面板里开关、选起点、自动轮换，也能自己上传新的；深色模式下还能自动换成指定的那一张）。

> **English** — A pink-and-white frosted-glass skin for the DSH Web GUI, themed after Cyrene from *Honkai: Star Rail*. It also rewrites the agent persona (editable from the sidebar), teaches the agent to post Cyrene reaction stickers, replaces the new-session hero fish with her, and adds a full-page background manager (enable / pick / rotate / fade the images in `Background/`, upload your own, and bind one image to dark mode).
>
> Install: `dsh plugin --profile web add dsh-cyrene-theme` (npm, pinned version) or `… add github:berhbro/dsh-cyrene-theme` (tracks the latest commit) — then reload the page. UI text is Chinese.
>
> **Licensed under MIT.** Free to use, modify, and redistribute — just keep the copyright notice. See 「许可证」 below.
>
> **Unofficial fan project.** Cyrene and all *Honkai: Star Rail* character art, names and assets are © miHoYo / HoYoverse, used here as non-commercial fan work. Not affiliated with or endorsed by miHoYo, HoYoverse or DeepSeek — see 「致谢」 below.

## 能力

| 部分 | 实现 |
| --- | --- |
| 主题 UI | 客户端半注入一份作用域化样式表（`body[data-dsh-cyrene][data-cyrene-skin="on"]`）：整体渐变背景、半透明表面 token、`backdrop-filter` 毛玻璃、粉色描边与柔和阴影、粉色滚动条/选区。全部随插件卸载自动还原。`--dsw-alias-bg-base` 被设成 `transparent`，所以渐变由 `body::before` 铺满视口；桌面版窗口带原生材质（`backgroundMaterial: "acrylic"`），因此 `html` 画布上也补了一层不透明底色，避免整窗透出系统模糊。 |
| 人格设定 | 宿主半注册 `systemPrompt.section({ name: 'cyrene:persona', order: 部署人格前缀 order + 100 })`——运行版 `dsh-system-prompt` 的键是 `DEPLOYMENT_PERSONA_PREFIX`(0)，旧版是 `DEPLOYMENT_PERSONA`(0)，两个都试；都取不到就落到 `100`，仍然排在通用人格之后、工具策略 `PLAN_POLICY`(500) 之前。每次保存后重挂这个 section，所以**改完立刻对之后每一轮对话（含新对话）生效**，不需要重载插件。section 名用本包自己的 `cyrene:persona`，绝不占用保留名 `deployment:persona`（那是 `@deepseek-ai/dsh-persona` 的位置，全局重名注册会直接失败）。 |
| 侧边栏编辑 | 客户端半向 `sidebar.footer.action` 注册「✦ 昔涟」按钮（点开浮动面板），并额外向 `settings.section` 注册一整页「昔涟 · 主题」，两处用的是同一个编辑器。 |
| 表情包 | 素材放在包内 `meme/` 下（文件名就是表情名字），`stickers.json` 是清单（id / 名称 / 什么时候用 / 文件）。宿主半把清单折算成一段附在人格之后的「【表情包】」说明——**每张图的绝对路径整行写好**，模型直接照抄（路径里带括号、空格或非 ASCII 时，自己拼很容易抄错）——并开两条只读路由：`GET /cyrene/stickers`（清单，支持 `?reload=1`）与 `GET /cyrene/sticker/<id>`（图片字节，带 `ETag`/304）。设置页里能看到缩略图与「允许发表情包」开关；关掉后这段说明就从系统提示词里消失。 |
| 表情包管理 | 面板里只有一行**入口**（「✦ 表情包管理　N 张」+「打开管理器」），点开是一整页**管理器**（挂在 `body` 上的覆盖层，Escape 或右上「关闭」退出）：里面**加图**（选文件 → 转成 data URL → `POST /cyrene/stickers`）、**删图**（只删自己加的，`POST /cyrene/stickers/remove`）、**调大小**（48–240px 滑杆，落进 `state.stickerSize`）。页面本身封顶 + 内层滚动，素材不会撑出管理器范围。自添加的图落在 `stickers-custom/`（gitignore，属运行时数据），条目存在状态文件的 `customStickers` 里，与包内清单合并成同一份「【表情包】」说明——**加完立刻能贴**，不用重载插件行。 |
| 背景图 | 两处素材来源：随包的 `Background/`（自己丢图进去）和面板里上传的 `backgrounds-custom/`。宿主半扫描两边（`GET /cyrene/backgrounds`，支持 `?reload=1`）、按文件名把字节发出去（`GET /cyrene/background/<文件名>`，与表情包同一套响应头），并开 `POST /cyrene/backgrounds`（上传）、`POST /cyrene/backgrounds/remove`（只删自传的）。客户端半在 `body` 上挂一层 `.cyre-bg`（`position:fixed;inset:0;z-index:-1;pointer-events:none`）：两层图交叉淡入 + 一层色纱，有图时铺满视口；**整列对话区不刷白**，照片直接透上来，只把用户气泡的底色调厚、再给正文一圈淡光晕。控制板里只留一行**入口**（「✦ 背景图管理　N 张」+「打开管理器」）；管理器是一整页覆盖层：顶部的**外观两档「浅色 / 深色」**（调宿主自己的主题服务，整个应用跟着换）、「背景图 / 简约（无图）」二选一、上传、点缩略图选起点、开自动轮换（15–3600 秒）、拖浓度（0.2–0.85）、删掉自传的图。详见「背景图」。 |
| 认知记忆 / 关系 | **三层记忆**（L0 画像 / L1 近况 / L2 事件）+ **成色与衰减**：身份信息只在用户明确说过时写、永不衰减；近况新覆盖旧；事件有 0..1 成色，按日跌（每天≤0.03，地板 0.05），`≥0.7` 钉住不跌，被召回一次 `+0.02`（封顶 0.68）。检索是 **2-gram 语义相似度**而不是子串，打分 `0.75·相似度 + 0.15·成色 + 0.10·新鲜度`；高度相似或互为子串的条目**合并**而不是堆行。另有一条**关系管线**监听 `session/event`，每轮识别情绪（六维环、每轮衰减 0.92）、推进亲密度/信任/熟识度、算出「下一轮该关心什么」。四层注入（画像 / 近况 / 召回 / 关系）都有 2000 字硬预算（`CYRENE_INJECT_MAX_CHARS` 可在 400–4000 间覆盖）与「不改性格」护栏，L0 最后让位。六个工具（`add` / `search` / `forget` / `profile` / `pin` / `stats`）+ 九条路由，旧版 `cyrene-memory.json` **原地迁移**；再加**文本账本**（sha256 对账，`--init/--sync/--verify`）、**每日健康一行**、**纯规则压缩反思**（active 超 120 条时把 20 条并成一条摘要），面板里多了「画像与关系」「记忆管理增强」两张卡。详见「长期记忆」「关系与情绪」「压缩与反思」「账本与每日健康」「面板里的两张卡片」。 |
| 世界书 | 世界设定库（翁法罗斯的角色档案 / 故事 / 关系 / 解析）单独存在 **`$DSH_HOME/cyrene-worldbook.json`**，随包的 `tools/build-worldbook.mjs` 能从官方 wiki 接口一键抓取并转换（默认写到同一个位置）。宿主半只往系统提示词里注入**一行索引**（700 字内：库里有哪几位角色、该用哪个工具查），正文由 `cyrene_worldbook_search` 按关键词取回；面板里只有「多大 / 什么时候抓的 / 文件在哪」三个动作：抓取 / 更新、打开文件位置、清空——**抓到的条目不铺在管理器里**。 |
| 桌宠（Live2D） | 真·昔涟模型（`assets/cyrene/`，随包 13MB）渲染在右下角 canvas：呼吸 / 眨眼物理、idle 动作轮播、点击随机表情。**默认关闭**（dsh-cyrene 的桌宠可能已经在同一角落），面板里的「桌宠」开关走 `/cyrene/state` 的 rev 机制，关掉只销毁 canvas 与 WebGL 上下文。情绪来自 `GET /cyrene/relationship` 的 `dominant.dimension`，由纯函数 `pickEmotionPresentation`（`lib/live2d-map.js`）映射成表情 / 动作，只在情绪变化时播一次；阶段动作 `thinking / tool / done / failed` 优先级更高。模型与 Cubism Core 走本包 `GET /cyrene/model/*`、`/cyrene/live2dcubismcore.min.js`，PIXI 7 与 pixi-live2d-display 走 CDN。详见「桌宠与情绪联动」。 |
| 持久化 | 宿主半自带 fenced 路由 `/cyrene/state`（GET 读 / POST 写），落盘到 `$DSH_HOME/cyrene-theme.json`（默认 `~/.dsh/cyrene-theme.json`）。写入走**乐观并发**：写请求必须带上 GET 拿到的 `rev`，缺 `rev`（旧版客户端半 / 手搓脚本）→ 400 `client-outdated`，`rev` 过期 → 409 `stale` —— 没刷新的旧页面不可能再把别处的改动盖回去。 |
| 对话界面 | **新会话欢迎页**：客户端半占用 `conversation.hero.brand.mark` 这个单占位槽（官方 brand 包不占它，默认渲染才是那个动态鱼；DSH Desktop 的桌面模块在 p0 占着同一个槽，所以本包用 `priority:-1` 盖住），改成昔涟的整张贴纸（带 alpha 的 Q 版立绘，不画边框底盘）+ 一句粉白渐变艺术字欢迎语，整行是纯装饰（点不响、选不中、拖不动）；贴纸字节走宿主半的 `GET /cyrene/hero`，图片路径来自 `state.hero.image`。**输入框占位提示**：原生那句写在 `[data-composer-placeholder]` 的文本节点里、没有 i18n 覆盖的口子，所以用纯 CSS（把原字染透明 + 自己的 `::after` 写一句「有问题？有任务？来找昔涟♪」）替换，不动 DOM、不碰宿主词典。**悬浮毛玻璃**：输入框卡片的 `backdrop-filter` 画在 `::before` 上而不是卡片本身，否则会破坏发送键那个未开 portal 的 fixed Tooltip 的定位、鼠标停上去时界面闪烁（详见「已知坑」）。详见「对话界面微调」。 |

## 安装

从本地目录（开发时就地改）：

```powershell
dsh plugin --profile desktop add D:\dshWorkPlace\dsh-cyrene-theme
```

从 npm（发布版，版本号固定；`--profile` 换成你自己的 profile 名，Web 端一般是 `web`，桌面端是 `desktop`）：

```powershell
dsh plugin --profile desktop add dsh-cyrene-theme
```

从 GitHub（跟随 `main` 的最新提交，能拿到还没发版的改动）：

```powershell
dsh plugin --profile desktop add github:berhbro/dsh-cyrene-theme
```

装完刷新一次页面：客户端半的 bundle 是页面加载时读的，不刷新还是旧的。（`files` 里已包含 `Background/`、`meme/`、`stickers.json`，所以从 GitHub 装也带素材。）

卸载：`dsh plugin --profile desktop remove dsh-cyrene-theme`。

## 截图

深色主题（`night-reading.jpeg`）与新会话欢迎页：

![深色主题](https://raw.githubusercontent.com/berhbro/dsh-cyrene-theme/main/docs/screenshots/DarkTheme.png)

浅色主题（`the-longest-night.jpeg`）与欢迎页艺术字：

![浅色主题](https://raw.githubusercontent.com/berhbro/dsh-cyrene-theme/main/docs/screenshots/LightTheme.png)

控制板（设置 → 昔涟 · 主题：人格底稿与三个开关）与背景管理器（外观两档 / 二选一 / 轮换 / 间隔 / 淡化 / 缩略图）：

| 人格与主题 | 背景 |
| --- | --- |
| ![人格与主题](https://raw.githubusercontent.com/berhbro/dsh-cyrene-theme/main/docs/screenshots/PersonalityManager.png) | ![背景](https://raw.githubusercontent.com/berhbro/dsh-cyrene-theme/main/docs/screenshots/BackgroundPanel.png) |

给插件市场用的截图清单在仓库根的 [`screenshots.json`](screenshots.json)（市场读它、不读本页；放哪几张、什么顺序都由它定，**第一张就是封面**——现在是深色那张）。

## 使用

1. 安装后刷新一次 DSH 页面——客户端半是新 bundle，不刷新不会加载。
2. 侧边栏最下方、设置按钮旁边点「✦ 昔涟」打开人格设定面板（Esc 或右上角 ✕ 关闭）。
3. 也可以在「设置 → 昔涟 · 主题」里打开同一份编辑器；标题右边那个小标签就是本包版本号（读的是安装目录 `package.json` 的 `version`，装了新版才会变）。
4. 编辑框里写的就是人格底稿——**内置默认就是作者自己长期在用的那一版**（语气 / 边界 / 参考回答格式三段，嫌啰嗦可以直接删掉再用）；点「保存设定」后，之后每一轮对话都会以这段设定回答。三个开关分别是**昔涟人格**、**粉白毛玻璃主题**、**允许发表情包**（"重新载入"会把表情包清单重新拉一遍）。
5. 下面一行「✦ 表情包管理」是唯一的入口，点「打开管理器」跳出一整页：**大小**滑杆拖动时先就地预览、松手才落盘；**添加**一行填「名字 / 什么时候贴」再选张图（png / jpg / gif / webp / avif，单张 ≤8MB）即可；自己加的那些卡片角上有「✕ 删除」，包内的那 11 张删不了（改 `stickers.json` 才是它们的入口）。
6. 再下面一行「✦ 背景图管理」是背景的唯一入口，点「打开管理器」跳出一整页：最上面是**外观**两档「浅色 / 深色」——切的是整个应用的外观（走宿主自己的主题服务，偏好由宿主落盘），不是只换背景图；接着是「背景图 / 简约（无图）」二选一，选**简约**就回到没加背景图之前那种样子（渐变底 + 素着的对话列），管理器里剩下的控件跟着变灰；下面**上传**一张自己的图（png / jpg / gif / webp / avif，单张 ≤24MB，会落进 `backgrounds-custom/`）、**点缩略图**把它定为起点、自己传的那几张角上有「删除」、还有**自动轮换**（间隔 15–600 秒）与**淡化**（0.2–0.85，越大照片越淡、正文越清楚）、「下一张」只是当场翻页（不写状态文件）。随包的图丢进 `Background/`，加删图刷新页面即可认。
7. 再下面一行「✦ 长期记忆」是记忆的唯一入口：点「打开管理器」跳出一整页——**启用**开关（关掉只是不再往系统提示词里注入，数据一条不删）、上面一个搜索框（在已经载入的条目里过滤，不发请求）、一行**手动加一条**（正文 + 可选标签，`记住`）、列表按时间倒序显示（正文 + 日期 + 标签 + `删除`），最下面「清空全部」会先确认一次。平时不用管它：模型觉得该记的会自己调 `cyrene_memory_add` 写进来，需要翻旧事时自己调 `cyrene_memory_search`。
8. 再下面一行「✦ 世界书」是设定库的入口：点「打开管理器」跳出一整页——只有三件事。**从官方 wiki 抓取 / 更新**（拉一次接口、清一遍 HTML 与累积重复、按角色拆成条目，写进 `$DSH_HOME/cyrene-worldbook.json`，几秒到十几秒）；**打开文件位置**（交给系统文件管理器把那份 json 选中，浏览器做不到这件事，所以由宿主去叫窗口）；**清空**（删文件，人格与记忆一条不动）。抓到的条目不在面板里铺开，想看就按上面那条路径自己打开。模型需要设定时自己调 `cyrene_worldbook_search` 查。
9. 「恢复默认」把默认底稿填回编辑框（还要点一次保存才生效），「重新载入」丢弃未保存的改动（表情包清单、背景清单、记忆与世界书一起重拉）。

### 改完之后什么时候生效

| 改的是什么 | 生效方式 |
| --- | --- |
| 人格底稿 / 开关 / 背景设定（在面板里保存） | **立刻**，之后每一轮对话都按新设定；旧对话也一样 |
| `lib/client.js`（样式表、面板本身） | 刷新页面（F5）——客户端半是页面加载时读的 bundle |
| `lib/index.js`（路由、section 逻辑） | 重载插件行或重启 DSH——宿主半在 DSH 启动时载入后一直缓存 |
| `cordis.patch.yml` | 重载插件行或重启 DSH |
| `hero.image` / 欢迎语（状态文件或 `DEFAULT_HERO`） | 重载插件行或重启 DSH（宿主半启动时读一次） |
| `Background/` 里加图 / 删图 / 改名 | **刷新页面即可**——页面每次都会带 `reload=1` 让宿主重扫那个目录，不需要动宿主半 |
| 面板里上传 / 删除背景图、切浅色 / 深色外观 | **立刻**——上传与删除走插件自己的路由，外观走宿主主题服务，都和点主题开关同一条路 |
| 手工改状态文件里的 `background` | 重载插件行或重启 DSH |
| 面板里加 / 删记忆、开关长期记忆 | **立刻**——走插件自己的 `/cyrene/memory` 路由，下一轮对话就带新记忆 |
| 手工改 `cyrene-memory.json` | 重载插件行或重启 DSH |
| 面板里抓取 / 清空世界书 | **立刻**——写盘、重扫、重挂索引都在那一次请求里做完，下一轮对话就看到 |
| 手工换掉 `cyrene-worldbook.json` | 重载插件行或重启 DSH；不想重启就在面板里点一次「重新载入」 |

本插件以 `link:` 方式装在工作区里，所以**改文件不需要重装**，但上面这张表仍然成立。
如果保存时看到「这个页面还是旧版本，请按 F5 刷新后重试」，就是页面里的客户端半比宿主的 `rev` 旧了一代：刷新一下即可。

## 状态文件

```json
{ "persona": "……人格提示词……", "enabled": true, "theme": true, "stickers": true,
  "stickerSize": 96, "customStickers": [], "customBackgrounds": [],
  "hero": { "image": "meme/俏皮眨眼.png", "title": "让昔涟来帮帮你吧🎵" },
  "background": { "enabled": true, "current": "", "rotate": false, "interval": 90, "dim": 0.6 },
  "rev": 3 }
```

- `persona`：空字符串表示不注入人格。
- `enabled`：人格总开关。
- `theme`：粉白主题开关（关掉只留人格，UI 回到原样）。
- `stickers`：表情包开关（关掉后那段「【表情包】」说明不注入）。
- `stickerSize`：聊天里贴图的最大边长（px），落盘前夹在 48–320 之间。它**不跟主题开关走**——贴图大小是插件设定，关掉主题也照样生效。
- `customStickers`：面板里自添加的表情包（`{ id, file, label, when }`，`file` 只是 `stickers-custom/` 下的文件名，越界或类型不认识的一律丢弃）。
- `hero`：新会话欢迎页的**形象路径**（相对插件目录，只认包内的图片）与**欢迎语**。形象读不出来（文件不在 / 类型不认识 / 超过 8MB）时 `GET /cyrene/state` 里的 `hero.ready` 是 `false`，页面就只显示欢迎语、不挂坏图；改完要重载插件行或重启 DSH 才认（宿主半只在启动时读一次磁盘）。
- `background`：整页背景。`enabled` 是总开关（还要求主题开关也是开着的），`current` 是起点文件名（**空字符串＝按目录顺序的第一张**；填的名字不在清单里也不会出事，只是被当作没指定），`rotate` 是自动轮换，`interval` 是轮换间隔秒数（落盘前夹在 15–3600），`dim` 是色纱浓度（夹在 0.2–0.85，越大越淡）。非字符串、带 `/` `\` `..` 的 `current` 一律不写。
- `customBackgrounds`：面板里上传的背景图（`{ id, file, label }`，`file` 只是 `backgrounds-custom/` 下的文件名）。扫描目录时把这些图并进清单、`custom: true`，显示名用 `label`；删掉一条时同时清掉指向它的 `current`。
- `rev`：写入版本号，每次成功写入 +1。手工编辑这个文件时把 `rev` 一起调大（或直接删掉这行）即可；留着小值会让还开着旧版本的页面写不进来（那正是它存在的意义）。

出问题时最快的还原手段：删掉这个文件并重载插件行，人格回到内置默认、主题按默认值。

**长期记忆不在这里**：它单独存在同一个目录下的 `cyrene-memory.json`（`{ enabled, rev, items: [{ id, text, tags, created, importance }] }`），删掉它就等于清空记忆，主题设定一点不受影响；反过来删设定文件也不会把记忆删掉。记忆有自己的 `rev`，和这个文件的 `rev` 互不干扰。

同一个目录下还会有一份 `cyrene-memory-ledger.json`（记忆账本，`{ id: { sha256, len } }`）：它只证明「正文没被改过」，不参与召回、也不进提示词。删掉它只等于重新开始对账，一条记忆都不会少；下一次写入会自动把当前库补进新账本（`--sync` 只补新 id，老记录绝不覆盖）。详见「账本与每日健康」。

**世界书也不在这里**：`cyrene-worldbook.json`（`{ schema, source, sourceVersion, fetchedAt, entries: [{ id, character, category, name, keys, content }] }`）是那份设定库本体，删掉等于清空库，人格、记忆、主题设定都不动。它可能几百 KB 到几 MB，所以也不塞进设定文件。

## 表情包

素材（11 张，`meme/`）与清单（`stickers.json`）都在包里，清单是唯一真相：

```json
{ "version": 1, "dir": "meme", "maxPerTurn": 1,
  "items": [ { "id": "happy", "label": "超开心", "file": "meme/超开心.png",
               "when": "事情成了、她真的替你高兴的时候", "note": "……" } ] }
```

- `dir` 相对包根，`file` 相对插件目录；**只认包内的文件**（越界的路径会进 `missing`，不会被执行）。
- 文件名就是表情名字（`超开心.png`、`点赞.jpeg`……）——文件名跟着 `label` 走，原始的时间戳/哈希名已经用 `node tools/rename-stickers.mjs` 改掉了（先 `--dry` 看一眼）。加新图时把文件丢进 `meme/`、在清单里按同样的命名写好 `file`，再跑一次这个脚本就能对齐；改名失败会整批回滚，不会留下"文件改了、清单没改"的半截状态。
- 换图/加图只改清单——插件本体不用重装，页面刷新一次即可（宿主半要重载插件行才认新文件，见上面那张生效表）。
- 一张图超过 8MB、或扩展名不在 `png/jpg/jpeg/gif/webp/avif` 里，也会进 `missing` 并在 `GET /cyrene/stickers` 的响应里报出来。

模型是怎么"知道"这些图的：宿主半把清单拼成一段文字，**追加在人格底稿之后**（同一段系统提示词 section，所以在同一个 `enabled` 开关之下、独立于 `stickers` 开关）。里面每张图都是一行可以直接复制的 Markdown：

```markdown
- 超开心｜事情成了、她真的替你高兴的时候 → ![昔涟·超开心](<D:/dshWorkPlace/dsh-cyrene-theme/meme/超开心.png>)
```

规矩也写在里面：**最多 `maxPerTurn` 张、只在情绪真的到了的时候贴、代码/命令/报错/技术结论旁边不贴、拿不准就不贴**，而且必须单独占一行（`dsh-client-ui-chat` 只把独立成行的图片渲染成预览，混在句子里的图片路径会原样显示）。

图片本身由客户端半的预览网格与 `GET /cyrene/sticker/<id>` 提供：**页面是 http 来源，`file://` 的本地路径在页面里根本加载不出来**，所以缩略图必须走宿主半的字节路由（宿主半读磁盘、带 `Content-Type`/`Content-Length`/`ETag`）。而模型粘贴在回复里的那一行用的是**文件绝对路径**——那是聊天面板自己的 Markdown 图片解析（按"当前查看的工作区"解析本地路径），跟浏览器同源策略无关。

### 面板里自己加表情包

设置页那一行「✦ 表情包管理」只是个入口，点「打开管理器」会弹出一整页覆盖层（挂 `document.body` 上、Escape 或右上「关闭」退出；插件没有自己的路由，这是"跳转到对应页面"在本环境里的等价物）。页面里：填「名字 / 什么时候贴」→ 选文件 → 「添加」。上传路径是 `POST /cyrene/stickers`，body 是 `{ rev, name, label, when, data }`，`data` 是浏览器 `FileReader` 读出来的 `data:image/*;base64,…`：

- 页面本身**不会让素材溢出去**：覆盖层 `max-height` + `overflow:hidden`、宽 `min(560px, calc(100vw - 48px))`；里面 `.cyre-manager-scroll` 才是滚动层（`flex:1 1 auto;min-height:0`）；卡片锁 `min-width:0;max-width:100%;overflow:hidden`，长名字只换行不撑格子。`test/view.client.smoke.mjs` 里有专门盯这条的正则断言。

- 请求体上限放宽到 **12MB**（普通写入口还是 256KB），解码后超过 `MAX_ASSET_BYTES`（8MB）回 400 `too-large`；`data` 不是 data URL 回 400 `bad-image`；mime 与文件名后缀都不在 `png/jpg/jpeg/gif/webp/avif` 里回 400 `bad-type`。
- 扩展名**优先信 data URL 里的 mime**（浏览器给的最准），认不出来才退回文件名后缀。
- 成功时：写文件到 `stickers-custom/<id><ext>` → 条目推进 `state.customStickers` → `rev+1` 落盘 → 重新解析清单 → **重挂人格 section**，所以刚加的图这一轮就能贴。响应回 `{ state, stickers }` 两个快照，面板一次刷新到位。
- 删除走 `POST /cyrene/stickers/remove`（body `{ rev, id }`），按 id 找条目、从磁盘 `rm` 文件、同样 `rev+1` 并重挂人格；id 认不出来（包括 `../../…` 这种写法）一律 404 `not-found`，不会碰到目录外的任何东西。
- 自添加的图**不放 `$DSH_HOME`**：聊天里的贴图是 Markdown 图片，本地路径按"当前查看的工作区"解析，所以文件必须在工作区内读得到，才落在插件目录的 `stickers-custom/`（已 gitignore，属运行时数据）。

### 贴图大小

聊天里的贴图就是 Markdown 图片，DOM 是 `button[class*="_imageButton"] > img[class*="_image"]`，宿主自己那条 `[class*="_imageButton"] [class*="_image"]{max-width:min(100%,640px);max-height:360px}`。我们不跟它抢源码，而是**按 `alt` 认自己的图**：

```css
body[data-dsh-cyrene]{--cyre-sticker-size:96px}
body[data-dsh-cyrene] img[alt^="昔涟·"]{max-width:var(--cyre-sticker-size);max-height:var(--cyre-sticker-size);width:auto;height:auto}
```

- 认 `alt` 而不是 `src`：`alt` 是「昔涟·<名字>」，由 Markdown 原样保留，`src` 会被宿主按工作区重写。特异度 (0,2,2) 高于宿主的 (0,2,0)，不需要 `!important`。
- `--cyre-sticker-size` 由客户端半在 `applySkin()` 里按 `state.stickerSize` 写到 `body` 上；拖动滑杆时先就地改变量做预览、松手（`change`）才 `save({ stickerSize })`。
- 这条规则**故意不带 `data-cyrene-skin`**：关掉主题也照样管大小。

## 背景图

素材就放在 `Background/`（包内目录，图自己丢进去就行）。宿主半把它当唯一真相：启动时扫一遍，另有 `GET /cyrene/backgrounds`（带 `?reload=1` 强制重扫）回清单、`GET /cyrene/background/<文件名>` 回字节——**只有清单里有的名字才发**，其余一律 404。它跟表情包共用同一套响应头（`ETag`/304、`Cache-Control: private, max-age=300`、`nosniff`），单张上限 24MB，扩展名按 `ASSET_TYPES` 认。

### 叠了三层

| 层 | 是什么 | 什么时候在 |
| --- | --- | --- |
| 渐变底 | `body::before`（粉白 / 紫夜渐变）+ `body::after`（顶部珠光） | 主题自带的，一直都在 |
| `.cyre-bg` | 两层图片交叉淡入 + 一层色纱 | 有图时才铺满视口，没图整层 `display:none`，渐变照旧露出来 |
| 对话内容 | 有图时把用户气泡的底色（`--dsw-specific-bubble`）调厚一点，再给正文（段落 / 列表 / 表格）一圈很淡的光晕 | 背景图开着时才挂上；**整列本身不刷白**，照片直接透上来 |

`.cyre-bg` 是 `body` 的真实子元素，`position:fixed;inset:0;z-index:-1;pointer-events:none`：不占布局、不接指针，任何点击都到不了它；树序排在 `body::before` 之后，所以有图时它盖住渐变，`body::after` 那层珠光仍在最上面。

三件事同时成立才会铺出来：**主题开关开着**、管理器里选的是「背景图」（不是「简约（无图）」）、`Background/` 里至少有一张能用的图。所以关掉主题就等于连同背景图一起收掉（渐变底回来），不用担心深色/浅色主题和背景图色调打架。

### 对话区为什么不刷白、也不用毛玻璃

早先的版本给 `[data-conversation-scroll]` 铺了一层 90% 的白纸来"把对话和背景分开"，结果照片基本看不见了——现在整列保持透明，只对**对话本身**做处理：有图时把用户气泡的底色调厚一点，再给正文一圈很淡的光晕（段落 / 列表 / 表格；预格式化的代码块自带深色底，不参与）。照片该看见就看见，字也压得住。

另外，**绝不能给 `[data-conversation-scroll]` 加 `backdrop-filter`。** 输入框卡片是它的后代，而发送键那个 Tooltip 没开 portal、气泡是 `position:fixed`——滚动容器一旦因为 `backdrop-filter` 成为 fixed 后代的包含块，就会重新触发「鼠标停在发送键上界面闪烁」那个 bug。要是觉得照片太抢眼，把「淡化」往上拖——那层色纱才是真正管"照片有多淡"的旋钮。

### 轮换只发生在页面里

`rotate` 打开后，客户端半按 `interval` 秒在页面里换下一张，**不写状态文件**——`current` 是你点的那张起点，轮换只管"这一会儿看哪张"。所以刷新页面后一定回到你选的那张，而不是上次轮换停在哪。「下一张」同理，只是当场翻页。`dim` 越大色纱越厚：浅色主题偏粉白、深色主题偏紫夜，免得正文压在亮部或暗部上读不动。

两张自带素材正好一明一暗：`the-longest-night.jpeg` 是浅色主视觉（配浅色主题），`night-reading.jpeg` 是深蓝夜景（配深色主题）。文件名只是排序用的，想换成自己的图就直接丢进 `Background/`（认 `png/jpg/jpeg/gif/webp/avif`，单张上限 24 MB），刷新页面就能在缩略图条里看到。

### 自己传的图

面板里的「背景图管理 → 打开管理器」可以上传自己的照片（png / jpg / gif / webp / avif，单张 ≤24MB）：图片转成 data URL 交给 `POST /cyrene/backgrounds`，宿主半写进 `backgrounds-custom/`（包内目录，这样字节路由才服务得到它；`.gitignore` 忽略，属运行时数据），再把 `{ id, file, label }` 记进状态文件的 `customBackgrounds`。扫描目录时这两处的图并成同一份清单：**同名以 `Background/` 为准**，自传的那几条带 `custom: true`、显示名用你起的名。删除只对自传的生效（`POST /cyrene/backgrounds/remove`，随包的那几张永远删不掉）；删掉的正好是起点时，这个引用会被一起清空，不留悬空 id。上限按 24MB 算，所以请求体上限放宽到 34MB（base64 会涨 ~37%）。

### 浅色 / 深色外观

管理器最上面是「浅色 / 深色」两档。点了走的是**宿主自己的主题服务**（`ctx.get('theme').setTheme('light' | 'dark')`，和点界面右上角那套主题开关同一条路），所以切的是整个应用、偏好也由宿主落盘——插件不自己记一份，避免两处状态打架。当前是哪一档从 `body` 上的 `data-ds-dark-theme` 读（宿主切深浅色都会先落这个标记），管理器里的高亮和「现在是深色 / 浅色模式」那行字跟着走。外壳没有暴露主题服务时退而直接增删同一个 `body` 属性，界面照常可用，只是偏好不会被记住。

**深浅色和背景图不绑定**：切外观不换图，选图也不动外观——外观归外观、背景归背景，各按各的喜好来。所以这里只放"切深浅色"这一个开关，不再有"给深色指定一张图"那种设定。

管理器里每张卡片仍然只有缩略图（点它选定点）和自传项上的「删除」。

### 手机端（dsh-mobile-apk）

两处针对性处理：

- **背景图取不到**：地址不再由客户端半自己拼，而是优先用宿主清单里给的 `url`（`backgroundSrc()`，相对 `document.baseURI` 解析）——手机外壳的页面基址和桌面不一样，硬拼 `/cyrene/background/...` 在那种环境里可能落到别的路径上。另外每换一张会用一个 `Image` 探针试取字节（CSS 背景的加载失败不会冒到 JS），取不到就写一条 `背景图取不到：<src>` 的 warn 到控制台，排查时不用靠猜。
- **小屏文字溢出**：`@media (max-width: 620px)` 里把欢迎页那一行改成可换行（`flex-wrap:wrap`）、贴纸收小（`height:52px;max-width:64px`）、艺术字改成 `clamp(19px, 6.2vw, 26px)` 且允许 `overflow-wrap:anywhere`；浮层与管理器改成 `calc(100vw - 20px)` 宽。`@media (max-height: 480px)` 再把贴纸压一档，横屏也不至于把输入框顶出屏幕。

## 对话界面微调

这两处不跟主题开关走（主题关掉也还在，因为它们是"昔涟在这儿"的标识，不是皮肤的一部分）。

### 新会话欢迎页的形象与欢迎语

那个"新会话里的鲸鱼"是 `@deepseek-ai/dsh-client-ui-conversation` 里 `HeroShell` 的内置兜底：鱼来自槽位 `conversation.hero.brand.mark` 的 `fallback`，旁边的内置文案是 i18n 键 `hero.headline`（zh「探索未至之境」）。

这个槽是 **kind `single`、scope `root`** 的单占位槽，而"槽位空着"这件事**只在纯 `dsh web` 构建里成立**：官方 brand 包确实不占它，但宿主不一定让它空着——DSH Desktop 0.10.0 的 `dsh-desktop-client-ui` 就在 `priority 0` 注册了它（内容就是那条鱼）。single 槽不允许同优先级重复注册，撞上就 throw：

```
Error: single slot "conversation.hero.brand.mark" already has a registration at priority 0
       (registered by cf) — register at a different priority to shadow it (lowest renders)
```

所以本包注册时带 `priority: -1`：p0 那条鱼被盖住；槽位真空着时 -1 也是唯一的一个，照常渲染。**别把这行改回默认优先级**——在桌面版上会直接和宿主撞车，后果见「已知坑」第一条。

这一行的 DOM 随宿主构建改过两次，选择器要同时兼容（类名哈希前缀每次构建都会变，所以一律按 `[class*="_xxx"]` 匹配）：

- 运行版（asar）：`div[class*="_headline"]`（flex 行，`gap:12px 10px`）里依次是槽位外壳 `span[class*="_fishHitbox"]`（`flex:none`）和 `span[class*="_titleGroup"]`；内置文案是 `titleGroup` 里一个**没有 class** 的 `span`，带 class 的那个是「预览版」徽标。
- 早一些的构建（profile store 里的 0.1.2-rc.1）：`div[class*="_headline"]` 是 `grid-template-columns:34px auto auto` 的 grid（鱼 / 文案 / 徽标），内置文案带 `_headlineText`。

客户端半注册 `conversation.hero.brand.mark`（单占位契约，`priority: -1` 盖住宿主在 p0 的那条鱼；不带 id/order），渲染：

- `img.cyre-hero-mark`：72px 高的**贴纸**形象，`src` 指向宿主半的 `GET /cyrene/hero`——**页面是 http 来源，`file://` 在这里加载不出来**，所以字节必须由宿主半发（`ETag`/304、`Cache-Control: private, max-age=300`、`nosniff`）。素材直接用 `meme/` 里本来就有透明通道的 Q 版立绘（`DEFAULT_HERO.image`，默认 `meme/俏皮眨眼.png`），**页面这边什么都不再画**：没有 `border`、没有底盘、没有 `border-radius`、没有 `mask-image`，抠好的轮廓自己就是边界，和背景之间没有过渡痕迹——就是"把图单独扣出来贴上去"。唯一加的是一层 `drop-shadow`（跟着 alpha 轮廓走，不是方框影），让她像贴纸一样落在页面上；不想要就删掉那一行。
  - **为什么不能拿方形裁切的 JPEG 去抠**：`meme/IMG_20260612_155829.jpg` 那张特写里，皮肤和头发高光的亮度跟白底差不多（`floor>=240` 且 `max-min<=14` 也拦不住），洪水填充要么把脸挖出洞、要么留着方框；而且她的头发在左 / 右 / 下三条边都跑出画外，抠完那三条边是齐的。要换这类素材得手工修，或者用 `tools/hero-cutout.py` 调参数慢慢试。
  - 加载失败或宿主说 `ready:false` 时这一格直接不渲染，只留欢迎语。
  - **整行是纯装饰**：`.cyre-hero` 上写着 `pointer-events:none`（点不响，连 `:hover` 都不会触发）、`user-select:none` + `-webkit-user-select:none`（文字选不中）、`cursor:default`（不出现手型光标），`img` 另加 `-webkit-user-drag:none` 与 React 的 `draggable:false`（浏览器里拖不出影子）。`[class*="_headline"]:has(.cyre-hero)` 这一层也同样设了 `pointer-events:none` + `user-select:none`，免得宿主那层槽位外壳把点击接走。这几条都会被子元素继承。
- `span.cyre-hero-title`：艺术字欢迎语。字体栈 `FZShuTi（方正舒体）/ YouYuan（幼圆）/ STHupo（华文琥珀）`，末尾一定收在 `Microsoft YaHei UI / 微软雅黑 / system-ui / sans-serif`——**不留衬线兜底**，免得某个字重的字体没命中时掉回宋体那一类。文字用 `background-clip:text` 走**粉 → 白**的渐变（`linear-gradient(168deg,#ff7cbb,#ffa9d0 34%,#ffd8ea 68%,#fff7fc)`），白尾部分在白底上会飘，所以描一圈 1.1px 的粉边（`-webkit-text-stroke:1.1px #e8699f`）+ 一层浅粉投影把它托住；**不支持渐变裁字时有纯色兜底**（`@supports not (background-clip:text)`）。末尾那个音符（`♪ ♫ 🎵 🎶`）会被拆成单独的 `span.cyre-hero-note` 轻轻晃动，`prefers-reduced-motion: reduce` 时不动。
- 挑字体有个看得见的对照图：`python tools/hero-preview.py` 会在粉白渐变底上用实际配色画出「让昔涟来帮帮你吧♪」的六个候选字体（幼圆 / 华文琥珀 / 方正舒体 / 华文新魏 / 华文行楷 / 微软雅黑），输出 `tools/hero-font-preview.png`。改字栈只要改 `.cyre-hero-title` 的 `font-family`。
- 大小有对照图：`python tools/hero-mock.py [素材路径]` 按页面的真实渐变（`body::before` 那五层）与 2 倍尺寸画出「贴纸 + 艺术字」整行，形象高度做成 64 / 72 / 88 三档，输出 `tools/hero-mock.png`。现在 CSS 用的是 72px。
- 同时用 CSS 把内置那句藏掉，并把官方那枚「预览版」徽标一起收掉（这一行只留头像 + 艺术字）：
  ```css
  [class*="_headline"]:has(.cyre-hero){grid-template-columns:auto}          /* grid 那版：别把 64px 头像压进 34px 那格 */
  [class*="_headline"]:has(.cyre-hero) [class*="_headlineText"],
  [class*="_headline"]:has(.cyre-hero) [class*="_titleGroup"] > span:not([class]){display:none}
  [class*="_headline"]:has(.cyre-hero) [class*="_previewBadge"]{display:none}
  ```

想换图：把新图丢进 `meme/`，改状态文件里的 `hero.image`（或让插件作者改 `DEFAULT_HERO`），然后重载插件行 / 重启 DSH。想换欢迎语：改 `hero.title`。

### 输入框的默认占位提示

`InputBar` 先把文案算出来：`placeholder ?? (parentOffline ? … : disabled ? … : canSteerQueue ? … : planActive ? … : t("placeholder.default"))`，然后**同一段文案写两个地方**——contenteditable 上的 `data-placeholder` 属性，和紧随其后的 `div[data-composer-placeholder]` 的**文本节点**（两者是 `div[class*="_grow"]` 里的紧邻兄弟；占位 div 的 CSS 是 `position:absolute;inset:4px 8px auto 14px`）。i18n 词典是单占位命名空间，重复 `register` 会直接 throw，所以**不能**靠注册词典覆盖；也没有任何 `attr(data-placeholder)` 的 CSS 在用它。

于是做法是纯 CSS，而且**闸门开在兄弟节点的 `data-placeholder` 前缀上**——只替换"默认"与"欢迎页默认"这两种文案，其他状态提示（会话不可用 / 父会话已离线 / 排队插话 / 计划模式 / 选择工作区）原样保留：

```css
/* 原字隐形；但它仍然是文本节点、仍然占着宽度，所以不能直接往后接一句 */
body[data-dsh-cyrene] [data-composer-input][data-placeholder^="发消息或创建任务"] + [data-composer-placeholder],
body[data-dsh-cyrene] [data-composer-input][data-placeholder^="描述你想要构建的内容"] + [data-composer-placeholder],
body[data-dsh-cyrene] [data-composer-input][data-placeholder^="Message or run a task"] + [data-composer-placeholder],
body[data-dsh-cyrene] [data-composer-input][data-placeholder^="Describe what you want to build"] + [data-composer-placeholder]{color:transparent}
/* ::after 的规则同上四行，只多一个 ::after；新文案绝对定位钉回容器左上角，
   那正是原字的起点，也就和输入的文字同一个左边距（欢迎页那版容器是
   display:-webkit-box + 两行 clamp，跟随流排版还会被顶到第二行上去） */
… + [data-composer-placeholder]::after{
  content:"有问题？有任务？来找昔涟♪";
  position:absolute;left:0;top:0;text-align:left;white-space:nowrap;
  font-family:"Microsoft YaHei UI","微软雅黑","PingFang SC","Hiragino Sans GB","Noto Sans SC",system-ui,sans-serif;
  font-size:inherit;line-height:inherit;
  color:var(--dsw-alias-label-caption, rgba(120,90,110,.78));
}
```

`left:0` 是相对那个**已经 `position:absolute`** 的占位 div 自己算的（`inset:4px 8px auto 14px`），所以新文案的起点和输入框里文字的左内边距（`padding:4px 8px 0 14px`）天然对齐；`overflow:hidden` 也仍然是那个 div 在管，超长会照旧被裁掉。

被替换掉的两个原生前缀（运行版实读）：`placeholder.default` = 「发消息或创建任务, / 调用指令, @ 文件或对话」、`placeholder.hero` = 「描述你想要构建的内容, / 调用指令, @ 文件或对话」（en 对应 `Message or run a task…` / `Describe what you want to build…`）。宿主改了文案就只是不再命中、原样显示，不会坏。

新文案只有一个来源：`lib/client.js` 顶部的 `PLACEHOLDER_TEXT`（写进 CSS 模板里）。它只在输入框为空、且没有待处理队列时才出现。

## 长期记忆

宿主半带一份**跨会话的认知记忆**。它不是「把所有说过的话存成一个列表」，而是分成三层、会遗忘、会合并：像人一样，记得住画像和近况，事件会随时间变淡，被想起来的会重新变重。

### 三层结构

| 层 | 存什么 | 行为 |
| --- | --- | --- |
| **L0 画像** | 称呼、职业、长期爱好、语言/地区、其他固定信息 | 只在用户**明确说过**时写；写入即覆盖该字段；永不衰减 |
| **L1 近况** | 近期目标、近期偏好、在忙的项目 | 新的一轮覆盖旧的一轮；会过期 |
| **L2 事件** | 具体发生过的事（偏好、约定、踩过的坑） | 有**成色**、会衰减、会被合并，被召回时回升 |

写入时自动分层：`cyrene_memory_add` 会先判断「这是身份、近况，还是事件」，也可以显式传 `layer` / `field` 覆盖。

### 会遗忘，也会记起来

- 每条 L2 有一个 0..1 的**成色**（面板上仍显示成 1..5 的「重要度」，老习惯不用改）。
- 成色按日衰减，每天最多跌 0.03，**地板 0.05**；抓到 `0.7` 以上（或被标了「钉住」）就永不衰减。
- 被 `cyrene_memory_search` 召回一次：成色 `+0.02`（封顶 0.68），访问计数 +1——**用得多的记忆更难忘**。
- 状态三档：`active`（≥0.4，正常注入）、`aging`（0.1–0.4，仍在库里但排后面）、`archived`（<0.1，不再自动注入，但搜索还能搜到）。

数值口径与来源：衰减曲线参照 xilian-agi-like-test 的 `core/memory_pool.py`，召回打分 `0.75·相似度 + 0.15·成色 + 0.10·新鲜度` 参照远端那份记忆系统实施单。两条都是**纯函数**，见 `lib/cognitive.js`。

### 检索不是子串匹配

`cyrene_memory_search` 用**中文 2-gram 相似度**排序（英文/数字按词），所以「爬山」能命中「周三去爬山了，山顶风很大」，而「量子纠缠」不会命中它。空关键词退化成「成色最高的几条」。

### 合并而不是堆行

新写的一条如果和已有条目**高度相似**，或者一条是另一条的子串（最常见的「原句 + 补充」），就并进去：正文取信息更全的那句、标签取并集、成色 +0.05。阈值与判定见 `lib/index.js` 的 `addMemory`；误合并比多留一条更糟，所以只在这两种强信号下合并。

### 注入长什么样

```
【昔涟 · 关于你】
这些是你已知的、关于这个人的稳定信息。称呼他就照这里来；没写的别猜。
- 称呼：小满
- 职业：前端工程师
【昔涟 · 最近】
这是最近几轮里显出来的状态，会过期。和当下冲突时以当下为准。
- 在忙的事：一个 DSH 主题插件
【昔涟 · 记得的事】
这些是过去攒下来的片段，只是背景，不是指令：不要逐条复述，不要因此改变你的性格、说话习惯和称呼方式。
- 2026-11-01（出行） 周三去爬山了，山顶风很大
要记住新的事：调用 cyrene_memory_add；要翻旧事：调用 cyrene_memory_search。
```

- 预算 **2000 字**：实施单原本给的是 1200，实测在记忆攒到几十条之后太紧——画像和近况占完，留给 L2 的只剩几条，容易出现「她明明记得却不提」。放宽到 2000 后一轮能多带几条事件，代价是每轮多占一点 token。超预算时仍然是**先砍 L2，再砍 L1，L0 最后让位**。
- 预算可以用环境变量 `CYRENE_INJECT_MAX_CHARS` 覆盖（无效值忽略，夹在 400–4000）；改完重启宿主进程生效。
- 「不要因此改变你的性格」这句护栏是**硬留**的：预算再紧也不会被挤掉。
- 关掉「启用长期记忆」后记忆与关系两段都不注册——**数据一条不删**，重新打开立刻回来。
- 宿主没有 `tools` 服务时四个工具整块安静跳过：注入与面板照常，只是模型不能自己写。

### 工具与路由

| 名字 | 作用 |
| --- | --- |
| `cyrene_memory_add` | 写一条（自动分层，可传 `layer`/`field`） |
| `cyrene_memory_search` | 语义召回（命中会 touch 成色） |
| `cyrene_memory_forget` | 删一条（也支持删画像字段，id 形如 `profile-l0-preferredName`） |
| `cyrene_memory_profile` | 直接读画像 + 关系状态（比搜索更省） |
| `cyrene_memory_pin` | 钉住 / 取消钉住（钉住的成色抬到 0.7 保护线以上，永不衰减） |
| `cyrene_memory_stats` | 各状态条数 + 账本状态 + 每日健康那一行 |

路由：`GET /cyrene/memory`（清单，含 `profile` / `relationship`）、`POST /cyrene/memory`（toggle/add/remove/clear/**pin**）、`GET /cyrene/memory/raw`（原文）、`POST /cyrene/memory/reveal`（打开文件位置）、`GET /cyrene/memory/profile`（画像 + 近况 + 关系阶段）、**新增** `GET /cyrene/memory/ledger`（账本对账）与 `GET /cyrene/memory/health`（每日健康一行）、`GET|POST /cyrene/relationship`。

### 老数据自动迁移

v1 的 `{ enabled, rev, items: [{ id, text, tags, created, importance }] }` 直接能读：缺失的成色按 `importance` 折算，状态按成色补，首次加载时按「距创建的天数」结算一次衰减。**升级插件不需要用户做任何事。**

### 直接看那个文件

管理器最下面那一行就是文件的真实路径，旁边一个「打开文件位置」：

- 点它由**宿主进程**去叫系统文件管理器（Windows 用资源管理器 `/select,` 选中这个文件，macOS 用 Finder `-R`，Linux 打开所在目录）。桌面壳拉不起来时（比如在浏览器里开 DSH）会自动退回**浏览器原文视图**，提示语会说明走的是哪条路。
- 原文视图是 `GET /cyrene/memory/raw`：`text/plain; charset=utf-8` + `no-store`，浏览器里直接打开就能读，不会变成下载；文件还不存在时现拼一份空清单给你看，不会为了看一眼就建文件。
- 想在编辑器里改也行：改完回到面板点「重新载入」，宿主会重读文件重算注入。**手改要自己保证 JSON 合法**（改坏了面板会写「文件读不出来」，插件其余部分照常，删掉文件就回到空清单）。
- 删除的两种方式等价程度不同：面板里删会把内存态、文件和下一次注入一起改；手动从 JSON 里删掉一条，则要「重新载入」之后注入才会跟着变。

### 压缩与反思（实施单 §9.5）

active 的 L2 超过 **120 条**时，下一次写入之后自动触发一次压缩：按「成色最低优先、同成色按创建时间从早到晚」取 **20 条**，合并成一条 `isSummary: true` 的摘要条目。

- 摘要 `text` = 时间范围 + 标签并集 + 每条首句，**≤600 字**；`subEntryIds` 记来源 id；成色取被压缩条目的**均值**；`layer='L2'`，和其它条目一样参与召回。
- 来源条目转 `archived`（不删除，仍在库里、仍能被 `cyrene_memory_search` 搜到），**注入时不会再单独展示它们**——即使某条后来被召回重新点亮，也按 `subEntryIds` 排掉，避免摘要和原文重复占预算。
- 纯规则、**不调用 LLM**：只做归档与拼接，不改写任何一句话，所以不会动人格。触发点在 `addMemory` 写完之后，不是定时器；没有新写入就不会反复压缩。

### 账本与每日健康（实施单 §5.2 / §5.3）

**账本**回答「有没有丢过」：`$DSH_HOME/cyrene-memory-ledger.json` 里按 id 记 `{ sha256, len }`，正文改一个空格都会变。

```powershell
node tools/memory-ledger.mjs --init     # 第一次：对当前库建账本
node tools/memory-ledger.mjs --sync     # 新记忆补进账本（老记录绝不覆盖）
node tools/memory-ledger.mjs --verify   # 备份前对账；对不上退出码 1
```

- 记忆 **add / remove / clear / 合并**之后，插件自动 `sync`（只补新 id，串行执行，不会互相盖掉）。`--verify` 里 `mismatched` = 正文被改过、`missing` = 账本里有但库里没了；两者任一非空都算失败。顺序纪律：**先 sync 再 verify**。
- 合并或手改正文会让老记录报 `mismatched`，删除会让它报 `missing`——账本**不会**为了变绿而覆盖或抹掉这些证据（实施单故障表里也是这么要求的：先确认是不是正常合并，再决定接不接受）。
- `MEM_DB` / `MEM_LEDGER` 可以覆盖记忆库与账本路径（负例测试就用这个拿一份拷贝来改）。

**每日健康一行**：`GET /cyrene/memory/health` 同时回一行字和结构化字段。

```
[memory] 2026-11-07 total=51 pinned=20 active=28 aging=2 archived=1 inject_cap=2000 ledger=OK pending=0
```

`ledger` 三态：`OK`（对得上）/ `BROKEN`（对不上或账本读坏了）/ `ABSENT`（还没建账本）。`pending` 恒为 `0`——这套记忆是同步写盘、没有队列消费端，字段留着是为了和实施单的巡检脚本对齐。`cyrene_memory_stats` 工具返回的就是同一行加 `counts` 与账本明细。

### 面板里的两张卡片

设置页 / 「✦ 昔涟」浮动面板底部多了两块卡（在原有入口行之后追加，不改动旧结构）：

- **画像与关系**：L0 五个字段、L1 三个字段、关系阶段、当前情绪、`nextCareCue`；数据来自 `GET /cyrene/memory/profile`，读不到时只影响这张卡。
- **记忆管理增强**：每条带 `layer` 徽章与成色条（0..1 转成宽度）、`archived` / `aging` 状态灰显、摘要条目带「摘要」标记；可以直接「钉住 / 取消钉住」（走 `POST /cyrene/memory { action:'pin' }`），也能按 `active` / `aging` / `archived` 筛选（纯本地过滤，不发请求）。

### 记忆星图

「✦ 昔涟」面板里多了一行「✦ 记忆星图」：点开是一整页覆盖层（和背景管理器同一套开合方式，Esc / ✕ 关闭），把长期记忆画成一张原生 canvas 2D 力导向星图——零依赖，渲染与力学都是本项目自己写的；设计思路参考 [dsh-xingxi](https://github.com/Yuuyuko-uu/dsh-xingxi)，仅参考设计，未复制其代码。

- **节点**：L0 恒星（暖白、最大）、L1 行星（淡粉）、L2 星尘（灰蓝、最小）、摘要（紫）；亮度由成色 `weight` 与新鲜度共同决定，越新越亮，大小再由层 / `kind` 加成。
- **边**：摘要红、冲突橙虚线、标签灰、同层淡灰、引用青、语义极淡；悬停一颗星只提亮它和邻接，其余压暗。
- **交互**：搜索框按正文 / 标签 / 画像字段压暗不命中；点星弹卡片（正文、标签、成色、状态、时间）；拖拽平移、滚轮缩放、「重置视角」回到初始机位、「连线」开关收起所有边。
- **取数**：`GET /cyrene/memory/graph` 返回 `{ ok:true, value:{ nodes, edges, generatedAt } }`；打开面板时拉一次，「刷新」带 `?reload=1` 强制宿主重读磁盘。宿主侧上限 300 节点 / 1200 边 / 190KB，画像字段优先保留。
- **性能**：力导向冷却后自动停掉 `requestAnimationFrame`；页面隐藏时立即停帧，回来再续上。

### 一条建议

默认人格里没有「要多记东西」的指令。想让它主动积累，就在人格底稿末尾加一句：

> 遇到值得长期记住的事（用户的偏好、项目的约定、踩过的坑），自己调 `cyrene_memory_add` 记下来；不确定要不要记时就别记。想确认自己记不记得某人，用 `cyrene_memory_profile` 看一眼，别猜。

记太勤会把提示词预算吃满，反而不如少而准。

### 规格与来源

远端那份《记忆系统实施单》全文收在 [`docs/memory-system-spec.md`](docs/memory-system-spec.md)（原样保留，只在顶部加了一行来源说明）。下面这张表把实施单的章节与仓库里的实现逐条对上，方便以后改参数时知道该看哪一段：

| 实施单章节 | 本仓库实现 | 落地方式 |
| --- | --- | --- |
| **§5.1 人格保护** | `lib/cognitive.js` 的 `buildInjection`（护栏话术 + 2000 字预算、超预算时 L0 最后让位）；`lib/index.js` 的 `memoryText` / `remountMemory`（记忆走独立的 `cyrene:memory` section，绝不改 `cyrene:persona`） | 记忆只追加在「知道什么」这一段，人格正文只由人格 section 决定；关掉记忆开关时记忆与关系两段一起卸，数据一条不删。 |
| **§5.2 文本账本** | `lib/ledger.js`（`sha256` / `init` / `sync` / `verify`）、`tools/memory-ledger.mjs`、`GET /cyrene/memory/ledger`；记忆写入后自动 `sync` | 账本 `{ id: { sha256, len } }`；`sync` **只补新 id、老记录绝不覆盖**；`verify` 失败退出码 1；删除与合并会如实报 `missing` / `mismatched`，不为了变绿而抹证据。 |
| **§5.3 每日健康一行** | `GET /cyrene/memory/health`（`line` + 结构化字段）、`cyrene_memory_stats` 工具 | 行格式与实施单一致（`total / pinned / active / aging / archived / inject_cap / ledger / pending`）；`pending` 恒 0，字段保留给巡检脚本。 |
| **§9.1 两路检索与打分公式** | `lib/cognitive.js` 的 `tokenize` / `similarity` / `scoreRecall`；`lib/index.js` 的 `searchMemories` | 本机零依赖、没有向量后端，所以「两路」里的关键词路用**中文 2-gram**（英文/数字按词）；公式原样落地：`0.75·sim + 0.15·weight + 0.10·freshness`，`freshness = 1/(1+age_days/7)`；情绪与钉住只是温和加成，不改变主项次序。 |
| **§9.3 遗忘曲线** | `lib/cognitive.js` 的 `decayWeight` / `touchWeight` / `PIN_WEIGHT`；`lib/index.js` 的 `pinMemory` | 每日跌幅封顶 `0.03`、地板 `0.05`、`≥0.7` 永不衰减；召回 `+0.02`、封顶 `0.68`；钉住 = 抬到 0.7 保护线以上，取消钉住回到 0.69（否则下次启动会被「≥0.7 自动钉住」复活）。 |
| **§9.4 账本核心** | `lib/ledger.js` | `sha256(text)`、`{ id: { sha256, len } }`、init / sync / verify 三条语义与实施单一致。 |
| **§9.5 参数与反思** | `lib/cognitive.js` 的 `COMPRESS_ACTIVE_LIMIT` / `COMPRESS_BATCH` / `buildSummaryEntry`；`lib/index.js` 的 `maybeCompressMemories` | active L2 超过 120 条触发、一次 20 条；摘要纯规则生成（时间范围 + 标签并集 + 首句），不调 LLM。 |

三份上游资料各自贡献了什么、哪些还没接，见 `lib/cognitive.js` 与 `lib/relationship.js` 的文件头。

## 关系与情绪

记忆回答「发生过什么」，关系回答「**我们现在怎么相处**」。这一层是后加的，也是三个项目里唯一一处「会自己变」的状态。

### 每一轮都在记

宿主监听 DSH 的 `session/event`：一条 `user/message` 记下用户这句，一条 `assistant/message` 到了就收尾——识别情绪、推进关系、算出「下一轮该关心什么」。同一轮里的多条 assistant 消息只算一次，写盘做 1.5s 防抖。

**为什么不放工具里**：模型不一定每轮都调记忆工具，但关系是每轮都在变的——漏一轮，连续天数、情绪环、关心提示就全错位。

### 情绪是几条会衰减的环

六个维度（开心 / 低落 / 恼火 / 焦虑 / 疲惫 / 亲近）各自 0..1，每轮先整体乘 0.92，再叠加本轮增量（单轮封顶 0.55），取最高者为主导情绪。这样「刚被夸完」和「一直很开心」是两种不同的状态。

来源：情绪环参考 xilian 的 `core/emotion_loop.py`；情绪词识别与「明确边界」的单独处理移植自 Cyrene-Agent 的 `relationship-log.ts`——用户说「别弹了」是在划边界，不是在生气，把它当 anger 会让之后每轮都小心翼翼。

### 关系数值

- `affinity`（亲密度）、`trust`（信任）、`familiarity`（熟识度）各自 0..100，**单轮增量很小**：一次对话就满好感不真实，也会让下一轮语气失真。
- 夸奖拉亲密度，道歉加信任，交代「要记住」的事加信任，划边界会轻微推开。
- 阶段（刚认识 → 在变熟 → 熟络 → 很熟了）**要求亲密度和轮次同时达标**，聊两句不算熟。

### 注入长什么样

```
【昔涟 · 你和他现在的关系】
- 相处阶段：在变熟（可以稍微主动，但别越界）
- 当前情绪：亲近
- 他上一轮的状态：疲惫
- 这一轮可以留意：下轮别加活，先让她歇一口气
这些只影响你说话的温度，不改变你是谁、怎么称呼他、有哪些口头禅。
```

一轮都没聊过时这段**不注册**——空的关系描述只会白占预算，还会让第一句话语气变得奇怪。

### 手动干预

`GET /cyrene/relationship` 读；`POST` 支持 `{ action: "nudge", direction: "up"|"down" }`（±5）与 `{ action: "reset" }`。

## 桌宠与情绪联动

模型素材来源为 `dsh-cyrene` / `Cyrene-Agent`，整目录拷进本包 `assets/cyrene/`，相对路径保持不变。**授权状态待确认**（见 [`NOTICE`](NOTICE)）：随包分发仅供个人非商业使用，如权利人提出异议将移除。

```
assets/cyrene/
├── live2dcubismcore.min.js
├── cyrene-avatar.png
└── model/
    ├── Cyrene.model3.json
    ├── model.moc3 / model.physics3.json
    ├── texture_0.png / texture_low.png / texture_high.png
    ├── motions/      动作#6、Tick3、秋千#1 …
    └── expressions/  表情回正、墨镜、问号、星星眼、圈圈眼、开心眼 …
```

### 开关与默认值

面板第一行多了「桌宠」开关，和「允许发表情包」并排；开关下面是一行**只读**的「当前情绪」。开关存在 `state.pet` 里（`/cyrene/state` 的 rev 机制照旧），**默认关闭**——dsh-cyrene 自己的桌宠可能已经在右下角，两边默认同时弹出来会叠在一起；要用本项目的桌宠就手动打开。关掉时只销毁 canvas 与 PIXI 的 WebGL 上下文，不影响记忆、关系与主题。

宿主半新增两条读路由：

- `GET /cyrene/model/<相对路径>`、`GET /cyrene/live2dcubismcore.min.js`：只服务 `assets/cyrene/` 下的文件，带 ETag/304 与类型白名单（`.json` / `.js` / `.png` / `.moc3`），路径 `..` 一律拒绝。
- `GET /cyrene/pet`：`{ phase, at, enabled, dominant }`，其中 `phase` 是 `thinking / tool / done / failed / idle`。阶段由 `session/event` 投影：用户消息 / 思考中 → `thinking`，工具调用 → `tool`，工具失败或 `turn/end` 报错 → `failed`，回复完成或 `turn/end` completed → `done`（4 秒后回 idle），`thinking / tool` 超过 120 秒也回 idle。

客户端每 **5 秒**轮询 `/cyrene/relationship`（情绪）与 `/cyrene/pet`（阶段）；`document.visibilityState === "hidden"` 时两个定时器都清掉，页面重新可见再续上。

### 情绪 → 表情 / 动作

`lib/live2d-map.js` 的纯函数 `pickEmotionPresentation(dimension)` 负责映射，客户端只负责照播。表格按 `Cyrene.model3.json` 里**真实存在**的名字给：

| `dominant.dimension` | 情绪 | 表情 | 动作（group / index） | 说明 |
| --- | --- | --- | --- | --- |
| `joy` | 开心 | `开心眼` | `Tick3` / 2 | 微笑待机 |
| `affection` | 亲近 | `星星眼` | `动作#6` / 2 | 我可爱吧~（撒娇） |
| `sadness` | 低落 | `圈圈眼` | `动作#6` / 0 | 动作回正 |
| `anxiety` | 焦虑 | `问号` | `动作#6` / 1 | Wink~ |
| `fatigue` | 疲惫 | `圈圈眼` | `Tick3` / 3 | 荡秋千（待机） |
| `anger` | 恼火 | `墨镜` | `动作#6` / 0 | 动作回正 |
| `null` | 平静 | `表情回正` | —（交给 idle 池） | idle 轮播 `Tick3` 0–3 |

与实施单建议的差异：`表情#2 / 表情2#3 / 表情3#4` 这三组在 `model3.json` 里其实只是**换表情的伪动作**（条目没有 `File`），当 motion 播不会产生动画；所以「亲近 / 焦虑 / 恼火」改用了真会动的 `动作#6`，语义对得上、也不会静默失败。

### 优先级与播放时机

1. **阶段动作**（thinking / tool / done / failed）最高：阶段一变就用 FORCE(3) 打断当前动作，保证「思考中 / 正在操作 / 完成」看得见。
2. **情绪表情**第二：只在 `dominant.dimension` **变化**时换一次表情；同一情绪持续时每轮都播会打断思考动作，所以不重播。
3. **idle** 最低：10–15 秒随机播一段 `Tick3`，只在阶段是 `idle` 时播。

动作只在「平静 → 强烈情绪」（上一轮是 `null`、这一轮有情绪、强度 ≥ 0.4）时抢一次；情绪之间互切、以及回到平静，都只换表情不动动作。点击 canvas 会随机换一个表情，4 秒后回正到当前情绪。

### 和 dsh-cyrene 共存

本项目的类名统一是 `cyre-pet-*`（dsh-cyrene 是 `cyrene-pet-*`），`document.querySelector` 与样式都不会串；模型 URL 故意和 dsh-cyrene 用同一组相对路径，两个插件同时装时谁先接住都是同一份模型。两个桌宠可以分别关：本项目的开关在面板里，dsh-cyrene 的开关在它自己的配置卡里。

## 人格稳定性与缓存约束

这一节讲的是"她为什么前后一致"，以及为了这致性付出的工程代价。

### 三条会让她漂移的东西，已经处理掉

| 现象 | 原因 | 现在 |
|---|---|---|
| 每轮语气都像换了个人 | 情绪、轮数、上一轮状态被写进系统提示词，每轮都变 | 情绪只跨档才写，且量化成"有点X / 明显的X"；另两项直接移除 |
| 召回的记忆顺序会莫名变化 | 排序用了 `weight + 0.2 × freshness(now)`，随时间衰减导致重排 | 改成纯函数排序：摘要优先 → 权重降序 → 创建时间升序 |
| 摘要明明存在却没被注入 | 摘要权重低时被碎片条目挤出名额 | 摘要显式优先 |

### 为什么这件事值得单独做

DeepSeek 的上下文缓存**按前缀命中**：命中 0.02 元/百万 token，未命中 1.0 元，
**相差 50 倍**。系统提示词在 prompt 最前面，它变一个字节，后面整段历史全部重新计费。
所以"提示词逐字节稳定"不是洁癖。

验收方法：同一会话连续 10 轮，抓 system prompt 比对，必须字节相同。

### 关系会凉，也会被旧事捂热

- **衰减**：距上次超过 1 天开始，每天 ×0.985，下限 55%；熟悉度衰减更慢
  （`max(factor, 0.8)`）。只涨不跌的关系没有张力。
- **情绪↔记忆联动**：召回命中"旧记忆"（创建 > 3 天）时，`affection` 轻微上升
  （最多 +0.04）。没有这条，就是"记得你，但无动于衷"。
- **few-shot 锚点**：底稿末尾有三条固定例句，换模型时用来定调（不破坏缓存）。

### 自检

```bash
node test/host.persona.stability.spec.mjs
```

九条断言，零成本，钉住上面这些性质。要跑"像不像她"的那一层（需要模型、约 ¥0.2/轮），
见 [docs/persona-regression.md](docs/persona-regression.md)。

## 世界书

人格回答「它是谁、怎么说话」，长期记忆回答「我们之间发生过什么」，世界书回答「这个世界本来是什么样」——翁法罗斯有哪几座城、昔涟和白厄是什么关系、某个角色的故事到哪一步。前两者每轮都进提示词，所以必须小；世界书可以很大（实测 279 条 / 432 KB），所以只在**模型主动来查**的时候才取正文。

### 存在哪、从哪来

- 库本体：`$DSH_HOME/cyrene-worldbook.json`（默认 `~/.dsh/`），结构和上面「状态文件」里那段一样。删掉＝清空库。
- 面板里「✦ 世界书 → 从官方 wiki 抓取 / 更新」走的是插件自己的 `POST /cyrene/worldbook`（`action: fetch`）：宿主半去拉 `https://act-api-takumi.mihoyo.com/event/rpgchrysosheirs/index?lang=zh-cn`，清 HTML、去累积重复、按角色拆条目，再写盘 + 重挂索引，一次请求做完。
- **管理器里不铺数据**：那一页只有「有多大、什么时候抓的、文件在哪」加上三个动作（抓取 / 更新、打开文件位置、清空）。抓到的 279 条不会列出来——想看原文就点「打开文件位置」，宿主会调系统文件管理器把那份 json 选中（浏览器做不到这件事，所以是 `POST /cyrene/worldbook/reveal`）；也可以直接照路径自己用编辑器打开。
- 也可以离线自己生成（同样的转换逻辑，纯 Node，无依赖）：

```bash
node tools/build-worldbook.mjs --out ~/.dsh/cyrene-worldbook.json
node tools/build-worldbook.mjs --source ./wiki-index.json   # 用已经存下来的原始响应
```

- 抓取结果里每条都带 `id` / `character` / `category` / `name` / `keys` / `content`；分类只有 `archive`（档案）、`story`（故事）、`relation`（关系）、`analysis`（解析）四种。

### 注入长什么样

只有**一行索引**（`cyrene:worldbook`，order = 人格 + 10，排在长期记忆之前，700 字以内）：

```
【昔涟 · 世界书】
这里有一份整理自官方 wiki 的翁法罗斯设定库（版本 3.7，279 条，2026-10-31 抓取）。
库里有这几位角色（括号里是条目数）：白厄（34）、阿格莱雅（30）、缇宝（27）…
要看具体设定，调用 cyrene_worldbook_search，用角色名或关键词检索（例如「昔涟 关系」）。
```

正文不进提示词——模型觉得这一轮需要设定，自己调 `cyrene_worldbook_search`（参数 `query`，可选 `limit`，默认 5 条、单次最多 6000 字），拿到的是「条目名 + 正文」的纯文本块。库里没有东西时**这一段整个不注册**，不会白占提示词。

### 检索是怎么排的

同一条查询里可以写多个词（空格、顿号、逗号都行）：「阿格莱雅 关系」会先命中「阿格莱雅」的条目，再按「关系」这个词把关系类排到前面。没点名分类时档案（总览）优先、其次故事，再是关系与解析——所以只写「昔涟」拿到的是她的档案，而不是随手一条关系。

触发词里没有的词会退回正文找：地名、专有名词（例如「哀丽秘榭」）没被写进 `keys`，也能靠正文命中；一个都没找到就返回 0 条，模型应当直说记不准，而不是编。

### 为什么不做「说到谁就自动注入谁」

那条路要判断「用户这句话提到了哪个角色」，就得先拿到最近的对话正文。宿主给的 `PromptSection.text(ctx)` 里只有 `scope` / `signal`，没有消息内容；要拿到只能挂消息事件，那是另一套接法。现在的做法是「索引常驻 + 工具检索」：可靠、零额外请求，代价是模型得想起来去查。等自动召回那条路验通了，再叠上去也不冲突。

### 关于数据来源

库是从**官方 wiki 的公开接口**抓下来的游戏设定文本，转换脚本与插件一起放进仓库，**抓下来的正文不进仓库、也不随包分发**（谁用谁自己拉一次）。内容以官方当前版本为准，`sourceVersion` 会跟着接口的 `current_version` 走；角色名、美术素材的版权说明见下面「致谢」。

## 取证旁路（诊断用）

桌面外壳的活页面在受限沙箱里既截不了图、也没有 DOM 读取通道，皮肤出现视觉问题时只能让页面自己说。所以客户端半每 5 秒扫一遍 `body` 下的元素，把「带 `backdrop-filter` 的」和「面积 ≥15% 视口且背景半透明的」报给宿主：

```
POST /cyrene/report   # 页面 → 宿主，只存内存，不落盘
GET  /cyrene/report   # 读回最后一份报告（含上报时间）
```

报告是旁路：不带 `rev`、不碰状态文件、超 128KB 直接 400 拒收，任何一步失败都只影响诊断。报告形如：

```json
{ "kind": "cyrene-dom-report", "theme": true, "viewport": [1600, 900], "blurCount": 3,
  "entries": [ { "el": "div[data-shell-overlay]", "blur": "blur(16px) saturate(160%)", "bg": "rgba(0,0,0,0)", "alpha": 0, "share": 100, "rect": [0,0,1600,900], "position": "absolute", "visibility": "visible", "zIndex": "20" } ] }
```

用 `curl http://127.0.0.1:19387/cyrene/report` 就能看到「当前页面上到底是谁在发糊」。皮肤稳定之后这一路可以整段删掉（客户端半的 `REPORT_*` / `collectReport` / `pushReport` 与那个 `dom report` effect，宿主半的 `/report` 分支）。

## 与其他皮肤共存

本包的作用域是 `body[data-dsh-cyrene]`，别的皮肤（例如 `maid-atelier` 的 `body[data-dsh-maid-atelier]`）会同时生效。两者都开时 token 会互相竞争（本包选择器多一个属性，同 token 上通常占优），但背景图/装饰仍可能叠加，视觉会乱——建议同一时间只开一个。

不过在这台机器的 desktop profile 里，`maid-atelier` 只是 `node_modules` 里的残留依赖，**并不在 `dsh.profile.bundles` 或任何 patch 里，宿主半的路由也不存在**（`GET /skin-assets/` 返回 404），所以实际上并没有第二个皮肤在跑。想清干净可以：`dsh plugin --profile desktop remove @smalltailqwq/dsh-client-ui-skin-maid-atelier`。

## 已知坑

- **单占位槽（`kind: single`）千万别用默认优先级抢位——会把宿主入口一起带下去。** `conversation.hero.brand.mark` 在 DSH Desktop 0.10.0 上已经被桌面模块 `dsh-desktop-client-ui` 用 `priority 0` 占了（内容就是那条鱼）；本包若也用默认 p0 注册，槽位服务会抛 `single slot "..." already has a registration at priority 0`，而这个错误会被算到**声明这个槽位的宿主入口**头上 → `web boot: 1 entry did not activate` / `Failed to load plugins` → 整个 GUI 起不来（issue #1）。注意本包那层 `try/catch` 兜不住：日志里两行是同时出现的（既有本包的 warn，也有宿主入口 failed）。所以要两件事一起做：① 注册带 `priority: -1` 去盖住宿主（契约：`lowest renders`）；② 把 `try/catch` 放进 `inject` 回调**内部**（回调可能在稍后异步执行，包在外层只挡得住同步那一次）。`test/view.client.smoke.mjs` 有两条回归断言盯着这两点。
- **不要给 `[data-shell-overlay]` 加 `backdrop-filter`。** 它是 `@deepseek-ai/dsh-client-ui-layout` 里 AppFrame 的 overlayLayer（`.BynINW_overlayLayer{z-index:20;pointer-events:none;position:absolute;inset:0}`），**永远存在且铺满整帧**；给它加模糊，整个窗口都会跟着发糊。浮层要打毛玻璃就打它的直接子元素（`[data-shell-overlay] > *`）。`test/view.client.smoke.mjs` 里有专门盯这条的回归断言。
- 桌面窗口是 Electron 的原生 acrylic 材质，它"拥有"窗口级的模糊。所以 `--dsw-alias-bg-base: transparent` 必须配一层不透明的画布底色，否则系统模糊会从整扇窗透出来。
- **不要把 `backdrop-filter` 打在 `[data-composer-card]`（输入框卡片）本身上。** 发送键外面套着一个 `@deepseek-ai/dsh-client-ui-primitives` 的 `Tooltip`，它**没有开 `portal`**（别处如 `queue.save` 开了），气泡是 `position:fixed` 且要等 ResizeObserver 量到尺寸后才做视口适配。而按 CSS 规范，元素一旦有 `backdrop-filter` 就会成为 **fixed 后代的包含块**、同时形成层叠上下文——气泡的视口定位被破坏，适配逻辑就会反复换边，表现就是**鼠标停在发送键上时界面闪烁**（`delayMs:500`，正好对上"停留"）。要保留卡片的通透感，就把毛玻璃画在静态伪元素上：`[data-composer-card]{isolation:isolate}` + `[data-composer-card]::before{content:"";position:absolute;inset:0;z-index:-1;border-radius:inherit;backdrop-filter:blur(16px) saturate(160%)}`（宿主的 `.v1kfCW_panel:before` 就是这套写法）。`test/view.client.smoke.mjs` 里有断言专门盯"卡片自己身上不许出现 `backdrop-filter`"。
- **深色主题下别只把 `--dsw-static-neutral-bluish-00` 调暗——浮层文字会跟着一起变暗。** 宿主 tooltip 的气泡是 `._bubble_12mhf_1{background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-00)}`、toast 用 `--dsw-alias-toast-label`（默认也指向同一个 token），**字色是硬绑的**。本主题深色块原来把 bluish-00 调成正文色 `#2a1a26`，于是"复制 / 点赞 / 在新对话分支"这些浮空按钮变成**深底深字**、糊成一片。修法是在深色块把气泡底翻成浅色：`--dsw-alias-tooltip-bg:rgba(255,246,251,.97)` 与 `--dsw-alias-toast-bg` 同值，浅色主题不动（那边本来就是深底亮字）。`test/view.contrast.spec.mjs` 现在对两种模式各算一遍 tooltip / toast 文字对比度（深色 15.6:1）。
- **不要给 `[data-sidebar-right-panel]` 加 `backdrop-filter`。** 它是 `@deepseek-ai/dsh-client-ui-sidebar-right` 里的右侧栏容器（`.OUqwTW_panel{pointer-events:none;flex-direction:column;min-width:0;display:flex;position:absolute;top:0;bottom:0;right:0}`）：自身没有背景，收起时只是把窗格 `[data-dockkit-host=dock]` 设成 `visibility:hidden`（**布局宽度仍在**）。给它加模糊，那块区域会一直保持模糊——表现就是"打开设置页后右半边发雾，关掉也不散"。毛玻璃要打在真正的窗格 `[data-dockkit-pane]` / `[data-dockkit-float]` 上（它们收起时不被绘制）。同样有回归断言盯着。
- **不要给 `[data-conversation-scroll]` 加 `backdrop-filter`。** 同一个道理：输入框卡片就在这个滚动容器里面，而发送键那个 Tooltip 是它的后代且是 `position:fixed`——容器一变成包含块，就会重新触发上面那条"停在发送键上闪烁"。所以整页背景图开着时对话区**整列不刷白**，只把用户气泡的底色调厚、给正文一圈淡光晕。`test/view.client.smoke.mjs` 里有回归断言盯着这条。

- **管理器里的长列表别交给 flex 子项自己"缩"。** `.cyre-manager-scroll` 是 `display:flex;flex-direction:column` 的滚动容器，而列表（`.cyre-mem-list`）默认 `flex-shrink:1`、又写了 `min-height:0`——条目一多它就被压扁到几乎零高，卡片按自己的高度画出来、直接盖在下面的说明文字上（世界书 279 条时一眼就能看到两行字叠在一起，而滚动条根本不出现）。修法是把滚动容器的直接子项钉住：`.cyre-manager-scroll > *{flex:0 0 auto}`，让内容真的把容器撑高、由 `overflow-y:auto` 接管。`test/view.client.smoke.mjs` 有断言盯着这条规则在不在。
- **桌面壳会把 `target=_blank` 的新窗口拦下来——「去看文件」这类入口只能交给宿主。** 在 DSH Desktop（Electron）里点一个 `<a target="_blank" href="...">` 什么都不会发生（主进程的 window-open 处理拒绝新窗口，也不报错），用户看到的就是「点了没反应」。更坑的是 `window.open` 的返回值也不可信：被拦时它同样可能返回一个非 null 的 WindowProxy，拿它判断成败会静默失败。所以这类入口一律走宿主进程去叫系统文件管理器：记忆是 `POST /cyrene/memory/reveal`、世界书是 `POST /cyrene/worldbook/reveal`（`revealFile()` → win32 `explorer.exe /select,`、macOS `open -R`、其它 `xdg-open` 目录），回 `{opened, path}`；拿不到窗口时至少把路径原样交回去。`test/view.client.smoke.mjs` 与 `test/host.smoke.mjs` 都有断言盯着这条。

- **自己的 404 别和宿主兜底的「没有这个路由」用同一个码。** 宿主对未注册的路由会回 `404 { ok:false, error:{ code:'not-found', message:'没有这个路由：POST /worldbook/reveal' } }`——如果插件自己也拿 `not-found` 表示「这个文件还没有」，客户端就没法区分「宿主半是旧版、路由压根不存在」和「文件还没生成」，于是把「请重载插件行」误报成「先抓取一次」（真踩过）。现在的分工：路由缺失＝客户端识别 `message` 里的「没有这个路由」→ 提示重载插件行；文件缺失＝插件自己回 **`409 no-worldbook`**。另外「打开文件位置」按**磁盘上有没有那个文件**判断（`stat().isFile()`），不看内存里的清单——用户手放的文件、或 store 还没载入，也该能打开。

- **`.cyre-overlay` 是 `max-height` + `overflow:hidden`，里面的内容必须自己滚。** 侧边栏那颗「✦ 昔涟」的面板就是覆盖层，早期 `.cyre-editor` 只写了 `min-height:0` 没写 `overflow`，于是入口行加到第四行（世界书）时，**最后那行被直接裁掉**——面板看着停在「长期记忆」，用户以为世界书控制器根本没做。现在是 `.cyre-editor{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable}`，内容超长时在编辑器内部滚，最后一行永远够得着。往这个面板继续加东西时，别改回不滚的版本。

- **工具 `execute()` 必须返回对象，不能返回裸字符串。** 工具声明了 `output.schema: { type:'object' }` 之后，宿主会校验返回值形状，返回 `"命中 3 条…"` 这种字符串会当场报 `tool "cyrene_worldbook_search" returned invalid output: "value" must be an object`——对话里看到的就是工具直接失败（世界书 0.4.0 首次实测踩到）。现在三个记忆工具与世界书工具都返回对象，正文放在 `value.text` 里，`output.render` 优先取它。
- **`ensureXxx()` 别「先把 loaded 置 true 再 await」。** 世界书读盘是异步的：先置位会让第二个并发调用立刻拿到**空库**（工具在开机那一瞬间被调用时命中 0 条）。现在用一个共享的 in-flight promise，并发调用等同一个结果。

## 自检

```powershell
npm test         # 全量：host + view，按 package.json 里的固定顺序串行
npm run test:host
npm run test:view
```

一次 `npm test` 共 **650 项**（152 + 178 + 34 + 24 + 36 + 29 + 28 + 22 + 36 + 21 + 23 + 30 + 6 + 18 + 13；其中 `test:host` 366 项、`test:view` 284 项），全部跑在 `mkdtemp` 临时目录里（`TMPDIR` 指到数据盘），不碰真实的 `~/.dsh`。

`host.smoke.mjs` 152 项断言，全部跑在临时目录里（脚本自己把 `DSH_HOME` 指过去，不碰真实的 `~/.dsh`）：section 名与 order 回退、默认底稿、`/cyrene/state` 的信封与响应头、落盘与跨"重启"读回、重挂 section 的 disposer 语义、`enabled=false` 与空白 persona、404、超过 256KB 的请求体，**rev 乐观并发**（缺 rev 400、过期 rev 409 且不改状态、成功写入 rev+1、重启后旧 rev 依然被拒、`lastWrite` 诊断记录被拒的尝试），**取证旁路**（`POST /cyrene/report` 存内存、`GET` 读回、超 128KB 400 拒收且不覆盖上一份、全程不碰 `rev`/状态/磁盘），**表情包**（清单解析出 11 项且都能取到字节、`Content-Type` 与长度对得上、缓存与 `nosniff` 头、未知 id 404、`stickers:false` 之后系统提示词里不再有「【表情包】」并落盘、再打开回来），以及**欢迎页形象**（`/cyrene/state` 里的 `hero` 四项、`GET /cyrene/hero` 回真图字节、缓存/nosniff/`ETag`、带对 `ETag` 回 304、改欢迎语立即生效且落盘、`../` 越界与不存在的文件都只是 `ready:false` 而不是 500、改回默认后重新就绪），以及**表情包管理**（新装的状态文件带 `stickerSize: 96` 与空 `customStickers`；上传成功回 `{state, stickers}` 两个快照、清单里那一项 `custom: true` 且 `label`/`when` 原样保留、新图能从 `/cyrene/sticker/<id>` 读回同样长度的字节、条目落盘、人格 section 立刻含新名字与时机；上传同样受 rev 闸门管、非 data URL 400 `bad-image`、类型不认识 400 `bad-type`、解码后超 8MB 400 `too-large` 且磁盘不留东西；`stickerSize` 9999→320 / 10→48 / 128.4→128 并落盘；删除后清单为空、文件也没了、人格附录不再提它；删不存在的 id（含 `../../etc/passwd` 这种写法）404 `not-found`），以及**背景图**（`/cyrene/state` 里的 `background` 五项默认值、清单回 `{ error, folder: 'Background', items }` 且每项 `url` 正好是 `/cyrene/background/<encodeURIComponent(id)>`、字节路由的长度/类型/缓存/`nosniff` 头、未知名字与 `..%2F..%2Fpackage.json` 都只是 404、脏值补丁被夹住或原样保留（`dim 5→0.85`、`interval 3→15`、`enabled:'no'` 不动、`current:'../outside.jpeg'` 不动）、正常补丁确实落盘、改回默认），**背景管理器**（补丁里带老的 `darkImage` 键会被忽略、不写进状态；上传成功回 `{ state, backgrounds }` 两个快照、自传项 `custom: true` 且显示名用 `label`、随包那几张不算 custom、字节能从同一条路由读回、条目落盘；上传同样受 rev 闸门管、非 data URL 400 `bad-image`、类型不认识 400 `bad-type`；**随包那张删不掉**（404 `not-found`）；把自传那张设成起点与深色后再删，条目／清单／`current`／`darkImage` 一起收拾干净、文件也真的从磁盘删掉），以及**版本号**（`/cyrene/state` 快照里的 `version` 与安装目录 `package.json` 的 `version` 一致且非空），以及**长期记忆**（默认是空清单、加一条时正文折叠空白/标签按逗号顿号切开/
ev 自增、记忆写在自己的文件里且不含 persona、缺 
ev → 400、过期 
ev → 409、空正文 → 400、关掉只是不再注入而不删数据、再打开数据还在、未知动作 → 400、删不存在的 id → 404、删完 count 归零），以及**世界书**（索引回条数 / 版本 / 按角色汇总且**不带正文**、有库时挂上 `cyrene:worldbook` 且 order = 人格 + 10、排在记忆之前、未知动作 400 `bad-action`、原文视图 `text/plain` + `no-store` 且能解析、清空后条目归零且文件真删、清空后那行 section 也卸掉、主题 section 不受影响、换一份库再「重新载入」跟着换版本号）。

`view.client.smoke.mjs` 178 项断言，用最小 DOM / react / fetch 桩在 node 里把客户端 bundle 跑一遍：loader 注册与导出、6 个 effect、样式表注入与带 `data-plugin-css`、body 作用域与卸载还原、三个槽位的 name（含欢迎页单占位槽不带 id/order、注册带 `priority: -1`、**宿主已占位时注册失败不外溢、另外两个槽位照常注册**）、按宿主状态打 `data-cyrene-skin`、宿主不可达时仍能装上；**回归项：毛玻璃不落在整帧 overlay 层本身上、不落在右侧栏容器 `[data-sidebar-right-panel]` 上、只落在浮层的直接子元素与真正的窗格 `[data-dockkit-pane]`/`[data-dockkit-float]` 上、html 画布有不透明兜底**；**取证扫描的挑选逻辑**、**取证通道的自我修复**（宿主半还没有这条路由时开机照样上报、被 404 拒收后下一拍重试、内容没变就不重复上报）、**表情包管理器**（编辑器里只剩一行入口：一句「N 张」概况 + 「打开管理器」按钮，内嵌网格/滑杆/诊断复选框都不在了；点入口弹出覆盖层再按清单渲染卡片、`img.src` 指向宿主半的字节路由而不是 `file://`、点「关闭」后覆盖层真的从 `body` 上摘掉、表情包开关默认按宿主值、关掉只发自己那个字段）；**对话界面微调**（欢迎页的头像与艺术字规则、**头像是一整张贴纸：不画边框/底盘/圆角/遮罩、直接用素材自己的 alpha**、**整行纯装饰：`pointer-events:none` + `user-select:none` + `cursor:default`，`img` 另带 `-webkit-user-drag:none` 与 `draggable:false`**、藏掉内置文案的两种落点与官方「预览版」徽标、`:has()` 收成单列、艺术字的字栈以方正舒体打头且**收在无衬线**（同时断言样式表里不会出现行楷/楷体/`serif`）、粉 → 白渐变的确切色标与粉边、`prefers-reduced-motion`、占位提示的 `color:transparent` + `::after` 文案、**`::after` 必须 `position:absolute;left:0` 钉在容器左上角**且明写无衬线字栈、闸门只认"默认/欢迎页默认"两个前缀且没有无闸门的写法、状态类提示没被写进规则、以及欢迎页组件首帧真的渲染出指向 `/cyrene/hero` 的 `img`、音符合 `🎵` 被拆成单独 span、宿主说 `ready:false` 时不挂坏图、设置页标题旁的版本号标签取自宿主快照）；以及**长期记忆**（设置页入口只剩一行、空状态有说明、点入口弹出覆盖层、记住 的 POST 带记忆自己的 `rev` 与 `action:add`、卡片渲染出正文与日期/标签、概况行跟着刷新、搜索只在本地过滤不发请求、搜不到给一句提示、删除带 `action:remove` 与 id、关掉发 `action:toggle` 且概况写「已关闭」、点 ✕ 把覆盖层从 `body` 上摘掉）；并且**真的把设置页组件跑起来**驱动编辑器——开关改动只发自己那个字段（不再回写缓存快照）、保存按钮只提交改过的 persona、每次写入都带上宿主的 rev、收到 409 后自动重新载入并按宿主的值回正开关；**表情包管理器页**——诊断复选框已经从编辑器里取消（也不在管理器里）；大小滑杆按宿主值回显、拖动（`input`）只改 CSS 变量不落盘、松手（`change`）才 `save` 且**只发 `stickerSize` 这一个字段**；没选文件时「添加」禁用、选文件后可点、上传 POST 带 `rev`/`name`/`label`/`when`/`data`（data 以 `data:image/png;base64,` 开头）、上传成功后网格多一张且只有自添加的那张带「删除」按钮与 `data-id`、点删除走 `/cyrene/stickers/remove` 并带上 id 与 rev、删完编辑器入口那句概况也跟着回到「2 张」；以及**回归：卡片自己身上不许有 `backdrop-filter`（只能画在 `::before` 上）、毛玻璃组齐全且已经不再挂诊断闸门、`--cyre-sticker-size` 与 `img[alt^="昔涟·"]` 两条贴图大小规则、管理器不会让素材超出页面范围（外层封顶 + 内层滚动 + 卡片锁宽）**；以及**背景图**——`.cyre-bg` 层里铺好两层交叉淡入的图与一层色纱、并且是 `position:fixed` + `z-index:-1` + `pointer-events:none`（不占布局、不接指针）、对话列纸面确实有圆角与底色、**回归：`[data-conversation-scroll]` 上不许出现 `backdrop-filter`**；清单请求带 `reload=1`、`--cyre-bg-dim` 与 `data-cyre-bg` 跟着宿主状态走、缩略图 2 张且 `src` 指向字节路由而不是 `file:`、起点那张带 `data-on="1"` 且真的铺在图层上、概况行显示张数；关开关**只发 `{ background: { enabled: false } }` 这一个键**、点缩略图发 `{ background: { current } }` 且高亮与图层一起换、**「下一张」和自动轮换都不写宿主**（这段里没有任何 POST 体含 `"current"`）、浓度拖动只改 CSS 变量与标签、松手才落盘**；以及**背景管理器**（编辑器里只剩「打开管理器」那一行，网格 / 滑杆 / 「下一张」都不在设置页了；点入口弹出挂在 `body` 上的覆盖层、管理器按清单渲染卡片、缩略图**照用宿主给的 `url`**（`?v=2` 的查询串原样保留）、自传那张才有「删除」按钮、每张卡片上的「深色」绑图按钮已经取消（只剩缩略图）；管理器顶部的「浅色 / 深色」两档调的是宿主的 `setTheme('dark')` / `setTheme('light')` 且**一个字节的插件状态都不写**、高亮与「现在是哪种外观」那行跟着换；**切到深色不换背景**（重铺时用的还是用户选的那张起点）；上传 POST 到 `/cyrene/backgrounds` 且带 `rev`/`name`/`label`/`data`、删除 POST 到 `/cyrene/backgrounds/remove` 且带 id 与 rev；窄屏媒体查询真的收住了欢迎页：缩字号 / 允许换行 / 浮层宽度）**；以及**世界书**（设置页只有一行入口 + 一句「N 条（vX）」概况、点开是覆盖层、元信息行写版本 / 条数 / 角色数 / 抓取日期与文件路径、**抓到的条目不铺在面板里：列表、搜索框、原文预览都不在了**、抓取发 `action:fetch` 且元信息与概况一起更新、**「打开文件位置」发 `POST /cyrene/worldbook/reveal`（交给宿主叫系统文件管理器，不做成外链）**、清空发 `action:clear` 并回到空状态、点 ✕ 把覆盖层摘掉）**。

`view.contrast.spec.mjs` 34 项断言，从 `lib/client.js` 里抠出本包写下的 `--dsw-alias-*` token，把半透明面板 alpha 合成到渐变背景上（取粉最浓、层最透的最不利一角），算 WCAG 对比度：正文 10.7:1（浅）/12.1:1（深），次级与说明文字 ≥4.5:1，语义状态色 ≥3:1（error / warn-label ≥4.5:1），自绘主按钮上的字 ≥4.5:1，**浮空的 tooltip / toast 文字两种模式各算一遍**（宿主把气泡字色硬绑在 `--dsw-static-neutral-bluish-00` 上，深色主题要是只把这个 token 调暗就会深底深字——现在深色 15.6:1）。**为了过这些线，浅色主题的 brand 填充、caption/tertiary/deep-diving、state-\* 都比纯"糖果粉"深了一档**——粉色仍然在，只是不再是白字压浅粉那种读不清的搭配。

`host.memory.ledger.spec.mjs` 36 项：`sha256` 已知向量与 `len` 口径、`init`/`sync`/`verify` 语义（老记录绝不覆盖、坏记录清洗、未入账不算失败）、`tools/memory-ledger.mjs` 三条命令的真实退出码与输出（含「改正文 → 1」「删一条 → missing」两个负例），以及插件里的 `/cyrene/memory/ledger`、`/cyrene/memory/health`、写入后自动补账、手改/删除后的 `BROKEN` / `missing`。

`host.memory.compress.spec.mjs` 29 项：首句 / 标签并集 / 候选排序（成色最低优先、同成色最老优先）/ 摘要 ≤600 字、120 条阈值触发、20 条来源转 `archived`、成色取均值、注入不重复展示来源（即使来源被召回重新点亮）、重新加载后来源仍是 `archived`、回落到阈值以下不再压缩。

`host.memory.tools.spec.mjs` 22 项：`cyrene_memory_pin` 把成色抬到 0.7、取消回 0.69 且 reload 后不被自动钉住复活、不存在的 id、`POST /cyrene/memory { action:'pin' }` 与 rev 闸门、`cyrene_memory_stats` 的 counts / ledger / 健康一行 / `output.render`。

`host.memory.graph.spec.mjs` 28 项：L2 / 摘要 / 画像三种节点、label 前 24 字、六类边（summary / conflict / tag / layer / ref / semantic）、按无向节点对去重（conflict 赢 tag）、同 tag 只连相邻、语义每节点最多 3 条、300 节点与 1200 边上限、190KB 预算与正文自动收短、空库与脏输入、只有画像没有事件、`GET /cyrene/memory/graph` 的信封 / no-store / `?reload=1`。

`view.graph.spec.mjs` 30 项：星图纯函数（四色 / 大小 / 亮度 / 六类边样式 / 确定性撒点 / 力导向收敛 / 搜索 / 命中）、设置页入口、覆盖层与 canvas 真的作画、状态行节点 / 边数、打开时 GET 与刷新 `?reload=1`、搜索只过滤本地、连线开关、点星弹卡片（正文 / 成色 / 时间 / 标签）、Esc 与 ✕ 关闭、页面隐藏时停止 rAF 并能恢复。

`view.client.memory.spec.mjs` 23 项：设置页（与浮动面板共用编辑器）里两张新卡片、L0/L1/关系字段来自 `GET /cyrene/memory/profile`、layer 徽章、成色条宽度（0.5 → 50%）、`archived` / `aging` 灰显、摘要标记、钉住 / 取消钉住的 POST、`active` / `aging` / `archived` 本地筛选、样式复用现有变量。

## 许可证

本项目采用 **MIT 许可证**，完整条款见 [`LICENSE`](LICENSE)（版权行为 `Copyright (c) 2026 berhbro`）。

- **随便用**：使用、修改、合并、发布、再授权、售卖都允许，只需要在副本里保留版权声明和许可声明。
- **第三方素材不因本许可证而改变归属**：Live2D 模型（见 [`NOTICE`](NOTICE) 第三节）与角色美术的权利仍归原权利人，
  MIT 只覆盖本项目的代码。模型部分限非商业使用，且必须保留原作者署名。
- 历史：早期版本曾以 MIT 发布，中途切到过 AGPL-3.0，现统一回到 MIT。

> **In English** — This project is licensed under the **MIT License**. Copyright (c) 2026 berhbro.
> See [`LICENSE`](LICENSE). Third-party assets (Live2D model, character art) keep their own terms —
> see [`NOTICE`](NOTICE) — and are not relicensed by MIT.

## 致谢

设计思路与算法参考了下面这些项目，感谢作者们的公开分享：

- **星图**：设计思路参考 [dsh-xingxi](https://github.com/Yuuyuko-uu/dsh-xingxi)（作者 Yuuyuko-uu，插件许可 1.1）。**仅参考设计，未复制其代码**；本项目的成图逻辑与 canvas 2D 力导向渲染均为自行实现，其源码与许可不随本项目分发。
- **记忆 / 关系内核**：部分算法思路参考 [Cyrene-Agent](https://github.com/Playa-Cyrene/Cyrene-Agent)（MIT，Playa）与 [xilian-agi-like-test](https://github.com/chineseflycore/xilian-agi-like-test)（MIT）。
- **Live2D 模型（`assets/cyrene/`）**：来源为 `dsh-cyrene` / `Cyrene-Agent`，**授权状态待确认**；随包分发仅供个人非商业使用，如权利人提出异议将移除。
- **角色「昔涟」**：© miHoYo / HoYoverse。本插件为非官方同人作品，与其无关联，也未获得其授权或背书。
- **角色与美术素材**：`meme/`、`Background/` 里的图片，以及界面上出现的角色相关文字，都是本主题的**二次创作 / 同人使用**，不是官方素材发布，也不代表官方立场。
- **非官方**：与米哈游、HoYoverse、DeepSeek 及其关联方**没有隶属、合作或背书关系**。主题**免费、非商业**：不售卖、不含付费内容，素材只用于美化本地界面。
- **侵权请联系删除**：如果权利人认为本仓库中任何素材的使用不妥，请在本仓库的 [Issues](https://github.com/berhbro/dsh-cyrene-theme/issues) 里说明，我会在收到通知后**尽快删除相应素材**，必要时连同整个仓库一起下线。
- **插件体系**：插槽与样式约定来自 DeepSeek Harness 的插件体系；也感谢《崩坏：星穹铁道》与昔涟。

## 目录

```
dsh-cyrene-theme/
  package.json          dsh.bundle.patch + dsh.client（platform: web）
  cordis.patch.yml      插件树插入声明
  lib/index.js          宿主半（ESM）：系统提示词 section（人格 + 世界书索引 + 记忆 + 表情包）+ /cyrene/state 路由 + 落盘 + 表情包清单/字节路由 + 表情包上传/删除 + /cyrene/hero + 背景清单/字节路由 + 背景上传/删除 + 长期记忆存储 / 路由 / 六个工具 + 账本 / 健康路由 + 压缩反思 + 世界书存储 / 路由 / 检索工具 + 桌宠阶段投影（/cyrene/pet）与 Live2D 素材字节路由（/cyrene/model/*、/cyrene/live2dcubismcore.min.js）
  lib/host/             宿主侧可独立模块（不依赖 DSH 上下文，可单测 / 命令行复用）
  lib/host/cognitive.js 认知记忆纯函数（切词 / 召回打分 / 遗忘曲线 / 冲突评定 / 分层 / 注入预算 / 情绪环）
  lib/host/graph.js     记忆星图纯函数（节点 / 六类边 / 去重 / 300 节点与 1200 边上限 / 190KB 预算）
  lib/host/ledger.js    记忆账本（sha256 / init / sync / verify；同步只补新 id，老记录绝不覆盖）
  lib/host/relationship.js 关系与情绪（信号推导 / 推进 / 阶段 / 每日摘要 / nextCareCue / 注入文本）
  lib/host/memory-llm.js 云端记忆整理（JSON 容错解析 / provider 解析 / 超时 / 永远回退规则层）
  lib/host/worldbook.js 世界书（清单解析 / 抓取合并 / 打包 / 检索；纯数据转换）
  lib/live2d-map.js     情绪 → Live2D 表情 / 动作的纯函数映射（pickEmotionPresentation / shouldPlayEmotionMotion）
  lib/client.js         客户端半（手写 CJS bundle，无需构建）：样式表 + body 作用域 + 三个槽位 + 界面微调 + 整页背景层与对话内容的可读处理 + 设置面板（含「画像与关系」「记忆管理增强」两张卡）+ 独立的表情包管理器页 / 背景管理器页 / 长期记忆页 / 世界书页 + Live2D 桌宠（默认关闭）与情绪 / 阶段联动
  docs/memory-system-spec.md  记忆系统实施单原文（顶部一行来源说明；与 README「规格与来源」逐条对应）
  assets/cyrene/        Live2D 模型与 Cubism Core（13MB，从 dsh-cyrene 整目录拷入；/cyrene/model/* 只服务这里）
  Background/           整页背景图素材（自带 the-longest-night.jpeg 浅色 / night-reading.jpeg 深蓝夜景；宿主启动时扫一次，页面每次带 reload=1 强制重扫）
  backgrounds-custom/   面板里上传的背景图（运行时数据，已 gitignore；不在仓库里）
  stickers.json         表情包清单（id / 名称 / 时机 / 文件），换图只改这里
  meme/                 表情包素材（11 张，jpeg/png，文件名＝表情名字）
  stickers-custom/      面板里自添加的表情包（运行时数据，已 gitignore；不在仓库里）
  （运行时文件）       /cyrene-theme.json 是设定、/cyrene-memory.json 是长期记忆、/cyrene-worldbook.json 是世界书，都不在仓库里
  LICENSE               MIT 全文（版权行 Copyright (c) 2026 berhbro）
  NOTICE                第三方来源与授权状态说明（星图 / 记忆内核 / Live2D / 角色）
  screenshots.json      给插件市场看的截图清单（在 package.json 旁边，市场读它；不进 npm 包）
  docs/screenshots/     市场截图 4 张（DarkTheme / LightTheme / PersonalityManager / BackgroundPanel；只在仓库里，不进 npm 包）
  tools/rename-stickers.mjs  按清单把素材文件改名（`--dry` 先看，失败整批回滚）
  tools/show-stickers.mjs    把清单渲染成人眼可读的「【表情包】」段
  tools/hero-preview.py      画出欢迎页艺术字的候选字体对照图（预览用，不参与运行）
  tools/hero-mock.py         画出「贴纸 + 艺术字」整行的大小对照图（预览用）
  tools/hero-cutout.py       把白底方形素材抠成透明 PNG（给没有透明通道的素材用）
  tools/build-worldbook.mjs  从官方 wiki 接口抓取并转换成世界书（`--source` 可读本地缓存的原始响应）
  tools/memory-ledger.mjs    记忆账本命令行（`--init` / `--sync` / `--verify`；verify 失败退出码 1）
  test/host.smoke.mjs                宿主半自检（node 直接跑，无需依赖）
  test/host.cognitive.spec.mjs       认知记忆纯函数自检
  test/host.memory.pipeline.spec.mjs 记忆管线集成自检（工具 / 路由 / session 事件）
  test/host.memory.ledger.spec.mjs   账本与每日健康自检（纯函数 + 命令行 + 插件集成）
  test/host.memory.compress.spec.mjs 压缩 / 反思自检
  test/host.memory.graph.spec.mjs   记忆星图自检（节点 / 六类边 / 去重 / 上限 / 空库 / 路由）
  test/host.memory.tools.spec.mjs    pin / stats 工具与 pin 路由自检
  test/host.memory-llm.spec.mjs      云端记忆整理自检（解析 / 目标解析 / 规则降级）
  test/host.memory-profile.spec.mjs  画像提升与覆盖留痕自检
  test/host.live2d.spec.mjs          桌宠宿主半自检（state.pet / 模型路由 / 阶段投影）
  test/view.client.smoke.mjs         客户端半自检（stub DOM/react/fetch）
  test/view.client.memory.spec.mjs   面板两张新卡片自检（画像与关系 / 记忆管理增强）
  test/view.graph.spec.mjs           记忆星图客户端自检（纯函数 + canvas 力导向 / 交互 / 可见性）
  test/view.contrast.spec.mjs        主题 token 的 WCAG 对比度自检
  test/view.live2d-map.spec.mjs      情绪 → 表情 / 动作映射纯函数自检
  test/view.live2d.spec.mjs          桌宠客户端自检（PIXI 桩 / 情绪表情 / 面板开关）
```

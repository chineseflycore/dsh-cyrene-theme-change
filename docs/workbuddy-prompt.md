# 任务：实现 DSH「昔涟」人格引擎插件

你是一名资深 Node.js / 浏览器前端工程师。请从零实现一个 **DeepSeek Harness（DSH）插件**，
给 AI agent 加上一个叫「昔涟」的稳定人格，包含长期记忆、关系、情绪与可视化。

---

## 一、运行环境

| 项 | 值 |
|---|---|
| 宿主 | DeepSeek Harness（插件框架 Cordis，"一切皆插件"） |
| 语言 | Node.js ESM（无 TypeScript 也行，但要有测试） |
| 客户端 | 浏览器里跑的 React，**用 `React.createElement` 手写，不引构建工具** |
| 持久化 | 单个 JSON 状态文件 |
| 分发 | 一个 npm 包，不做多包拆分 |

DSH 插件形态：导出 `apply(ctx)` 与 `inject`，可注册 HTTP 路由、系统提示词 section、
LLM 工具、客户端 UI 槽位、会话事件监听。

---

## 一之二、技术栈与依赖（照这个来，别自选）

### 必须用

| 用途 | 用什么 | 怎么用 |
|---|---|---|
| 插件框架 | **Cordis**（宿主自带） | 导出 `apply(ctx)` / `inject`，不自己造生命周期 |
| 客户端 UI | **React**（宿主注入，`require("react")` 即可拿到） | `react.createElement` 手写，**不要从 npm 装 react** |
| 星图 / 面板绘制 | **Canvas 2D**（原生） | 力导向布局自己写，约 400 行；不要引图形库 |
| Live2D 渲染 | `pixi.js@7.4.2` + `pixi-live2d-display`（cubism4 版） | 都从 jsDelivr CDN 加载，版本锁定 |
| Live2D 运行时 | `live2dcubismcore.min.js` | 本地文件，随包分发；**必须在 NOTICE 里声明** |
| 相似度 | 自写 **2-gram + 余弦** | 约 30 行，中文短句够用 |

Live2D 三件套的加载顺序是**固定**的：`live2dcubismcore.min.js` → `pixi.min.js` → `cubism4.min.js`。
模型是 Cubism 4 格式：`.moc3` + `model3.json` + 贴图 + `motion/*.motion3.json` + `exp/*.exp3.json`。

### 明确不要用的

| 别用 | 原因 |
|---|---|
| three.js / Babylon.js | 星图用 Canvas2D 手写更快更小，我们 2000 行就到顶了 |
| 任何 embedding 模型（transformers.js / onnxruntime-web / wasm 小模型） | 中文短句用 2-gram 就够；模型体积和首帧延迟不划算 |
| PyTorch / faiss | 服务端跑不动，也不需要 |
| TypeScript 编译器 / vite / webpack / esbuild | 客户端**没有构建步骤**，bundle 由宿主 loader 直接加载 |
| Redux / Zustand / MobX | 模块级 store + `useState` + 订阅者集合足够 |
| dayjs / luxon / date-fns | `Date` + 两位补零就够了 |
| axios | 原生 `fetch` |

如果确实要引第三方库，必须同时满足：**零依赖、可 CDN 加载、< 100 KB**，并在汇报里说明理由。

### 上游参考项目（只参考思路，禁止拷代码）

| 项目 | 许可 | 可以借鉴什么 | 不可以做什么 |
|---|---|---|---|
| `Playa-0v0/Cyrene-Agent` | MIT | 人格/记忆分层、关系数值设计 | 不要整段复制实现 |
| `chineseflycore/xilian-agi-like-test` | MIT | 记忆池淘汰策略、情绪向量表示 | 不要搬它的 40M 模型 |
| `Yuuyuko-uu/dsh-xingxi` | **自定义许可 1.1** | 星图的交互与视觉思路 | **一行代码都不能抄** |
| Live2D 模型资源 | 模型作者「是依七哒」授权链 | 可直接使用 | 必须署名 + 非商业 + 保留授权说明 |

### 基于什么改（不要另起炉灶）

**模型层**：DeepSeek 系列（`deepseek-v4.1-flash` / `deepseek-flash`）。
通过宿主 `ctx.get("llm")` 取，**不要硬编码模型名**，按 provider/model 自动解析。

这决定了缓存的经济性：DeepSeek 上下文缓存按**前缀**命中，命中价 0.02 元/M，
未命中 1.0 元/M —— **50 倍差**；输出 4 元/M（闲时）/ 8 元/M（峰值：周一至周五
09:00–12:00、14:00–18:00，Asia/Shanghai）。
所以"系统提示词逐字节稳定"不是洁癖，是直接的钱。

**宿主层**：DSH 0.2.x 的 cordis 插件体系。**复用它的服务，不要自己造**：

| 服务 | 用来干什么 | 我们的调用量 |
|---|---|---|
| `ctx.systemPrompt` | 注册人格/记忆/关系 section | 23 处（最核心） |
| `ctx.effect` | 生命周期（样式表、监听、定时器自动回收） | 12 处 |
| `ctx.get("llm")` | 记忆整理那一次辅助调用 | 8 处 |
| `ctx.slots` | 客户端 UI 槽位（侧边栏按钮、设置页、欢迎语） | 4 处 |
| `ctx.on` | 会话事件（抽用户/助手文本） | 2 处 |
| `ctx.webServer` | `/cyrene/*` 一组 HTTP 路由 | 1 处 |
| `ctx.theme` | 深浅色跟随 | 1 处 |
| `ctx.logger` | 日志 | 7 处 |

**基于的官方插件**（直接用，不要重写）：

| 包 | 作用 | 我们怎么用 |
|---|---|---|
| `@deepseek-ai/dsh-persona` | 基础人格前缀 | 我们的 section 要排在它**之后**（用 `resolvePersonaOrder` 找它） |
| `@deepseek-ai/dsh-compaction-basic` | 会话压缩 | 配 `thresholdRatio: 0.4`、`retainRatio: 0.2` |
| `@deepseek-ai/dsh-compaction-tool-result-pruner` | 压缩前剔除超大工具输出 | 挂上（旧文件全文是最大垃圾） |
| `@deepseek-ai/dsh-user-approval` | 审批缝合点 | 只在"按会话禁工具"时才需要 |

**上游插件**（我们是从它 fork 出来的）：

```
dsh-cyrene（主题 + Live2D 桌宠）
    └─ fork → dsh-cyrene-theme（本项目，MIT）
                 └─ 合并 Cyrene-Agent 的认知层（记忆/关系/情绪/星图）
```

所以你的任务是**在 dsh-cyrene 的壳子上长认知层**，不是从空白写一个主题插件。
配色、毛玻璃、桌宠加载、槽位注册这些基础设施已经存在，照用即可。

### 基于的 theme 包（必须用它的骨架，不要自己发明打包方式）

本项目就是一个 **DSH theme 包**，包名 `dsh-cyrene-theme`。它的形态是固定的：

```
dsh-cyrene-theme/
  package.json          ← 关键：dsh 字段声明自己是一个 bundle patch
    {
      "name": "dsh-cyrene-theme",
      "main": "lib/index.js",          ← 宿主半入口
      "dsh": {
        "bundle":  { "patch": "./cordis.patch.yml" },   ← 自己是 bundle
        "client":  { "inject": [], "platform": "web" }  ← 客户端半，打 web 平台
      }
    }
  cordis.patch.yml      ← 把自己 insert 进 profile 的插件树
    - insert:
        - id: ui-cyrene-theme
          name: dsh-cyrene-theme
  lib/index.js          ← 宿主半：HTTP 路由、提示词 section、工具、会话事件
  lib/client.js         ← 客户端半：React 组件、CSS 字符串、槽位注册
  lib/host/             ← 认知层（可独立单测的纯函数）
      cognitive.js / memory-*.js / relationship.js / worldbook.js / graph.js / live2d-map.js
  assets/               ← Live2D 模型与贴图
  Background/ meme/     ← 背景图、表情包素材
  test/                 ← 全部用 node:test 风格手写断言，不引测试框架
  docs/ NOTICE LICENSE
```

安装方式（用户侧）：

```bash
dsh plugin --profile <profile 名> add <这个包的路径或 npm 名>
```

**必须照这个骨架做**，原因：

1. DSH 的插件分发单位就是「bundle patch」，`dsh.bundle.patch` 指向 YAML，
   由 loader 把自己 insert 进 profile；自己写一套加载逻辑不会被识别
2. 一个包同时有宿主半（`main`）与客户端半（`dsh.client`），
   两者一起分发、一起启用；**不要拆成两个包**（用户明确拒绝）
3. 客户端半没有构建流程，产物是 loader 能直接执行的 bundle；
   浏览器里只有 `require("react")` 能解析到
4. `ctx.theme` 服务负责深浅色跟随——主题包不要自己维护两套色板切换逻辑，
   订阅宿主的主题即可

**认知层放在 `lib/host/` 下做成纯函数**，不要塞进 `lib/index.js`：
提示词拼装、记忆淘汰、关系衰减这些都要能脱离 DSH 直接单测
（本项目 64 个测试套件全是这么测的，不启动宿主）。

### 客户端工程约束

- 没有构建步骤：客户端产物是宿主 loader 能直接执行的 bundle
- 样式用 `<style data-plugin-css="<包名>">` 注入 `<head>`，插件卸载时移除
- 所有 `addEventListener` / `setTimeout` / `requestAnimationFrame` / `ResizeObserver`
  必须在卸载时清理，否则热重载会泄漏
- 不碰宿主的 DOM 结构，只往自己的槽位里挂东西；样式一律用 `body[data-自己包名]` 收敛作用域


---

## 二、要实现的能力

### 1. 长期记忆（三层）

```
L0 画像    稳定属性（称呼、时区、偏好）。每个字段 ≤ 40 字
L1 事实    稳定事实（项目路径、技术栈、约定）。每条 ≤ 30 字
L2 片段    日常经历。可多，靠衰减淘汰
```

**写入必须确定性**：每轮对话结束**无条件**落一条 L2。
不要靠"模型觉得重要才写"——实测同样任务，一个 agent 记 16 条、另一个记 0 条。

**提升才用模型**：只有 L2 → L1（事实沉淀）这一步调用 LLM 判断。
写入路径上不调模型，保证又快又稳。

**冲突消解**：同一主体的事实更新时，旧值不删除，标 `tags: ['历史']`；
注入时只取最新值，避免同时注入两条矛盾信息。

**压缩**：L2 超过 120 条时，一次取 20 条压成一条摘要
（`isSummary: true`，`subEntryIds` 记来源 id，摘要 ≤ 600 字）。

### 2. 关系

```
affinity（亲近）/ trust（信任）/ familiarity（熟悉）  0..100
turns（轮次）/ streakDays（连续天数）/ lastSeen（日期）
```

**必须会衰减**：距上次 > 1 天开始，每天 ×0.985，下限 55%；
熟悉度衰减更慢（`max(factor, 0.8)`）。
只涨不跌的关系没有张力——聊十次和聊一百次必须能感觉到差别。

### 3. 情绪

六维 `joy / affection / sadness / anxiety / fatigue / anger`，值域 0..1：

- 由**当前这条用户消息**的关键词/正则驱动，不调模型
- 每轮先整体衰减（约 8 轮掉一半），再叠加本轮增量，单轮单项增量封顶
- **情绪 ↔ 记忆联动**：召回命中"旧记忆"（创建时间 > 3 天）时，
  `affection` 轻微上升（最多 +0.04）。没有这条，就是"记得你，但无动于衷"。

### 4. 注入（本项目最关键的约束）

把记忆与关系写进系统提示词。**但系统提示词必须逐字节稳定。**

- ❌ 严禁注入每轮都会变的字段：时间戳、轮数、情绪百分比、上一轮状态、"本轮留意"
- ✅ 情绪只有**跨档**时才改文本，且量化成两档（`有点X` / `明显的X`）
- ✅ 一切排序必须是**纯函数**：禁用依赖当前时间的排序（如 `weight + 0.2 * freshness(now)`）
- ✅ 摘要条目优先于碎片条目（摘要是"多条挤一条"的产物，密度最高）
- ✅ 注入预算：总 2000 字以内；L2 部分占 70%

> 为什么这条最重要：缓存按**前缀**命中。系统提示词在 prompt 最前面，
> 它变一个字节，后面整段对话历史全部重新计费。实测同一批记忆若按时间排序，
> 过一会儿顺序会翻转，注入文本跟着抖，缓存白白失效。

### 5. 人格底稿

系统提示词里固定一段人格设定，必须包含四块：

```
【身份】   你是谁、和普通助手的区别
【口吻】   自称、称呼、语气词、短句习惯、什么时候不用俏皮
【必须守住的边界】  不为可爱牺牲准确性、不编造设定、用户说"关掉人格"立刻切中性
【说话样例】 3 条 few-shot，固定文本（换模型时用它定调）
```

### 6. 可视化（次要，可最后做）

- Live2D 桌宠：情绪 → 表情映射，面板可开关
- 记忆星图：力导向图，节点=记忆，边=语义/标签/层级关系

---

## 三、硬性约束（违反即不可接受）

| # | 约束 |
|---|---|
| 1 | **缓存前缀稳定**：同一会话连续 10 轮，系统提示词必须逐字节相同 |
| 2 | 禁止 `@ts-nocheck` 之类绕过检查来换编译通过 |
| 3 | 禁止为了跑通而删减功能（"先不做音频/先不做网络"） |
| 4 | 不许拷贝上游项目代码；Cyrene-Agent / dsh-xingxi 只可参考思路 |
| 5 | 不拆 npm 包（用户明确拒绝 CLI 与 GUI 分装） |
| 6 | 任何列表、排序、生成文本必须可重现（同输入 → 同字节） |

---

## 四、验收标准

### 必过：自动化测试

`npm test` 全绿，且新增一个「人格稳定性」套件，至少覆盖：

1. 关系段是纯函数：同输入调用三次，产出字节完全一致
2. 情绪强度 0.49 时不出现情绪行；0.6 出现「有点X」；0.8 出现「明显的X」
3. 关系段不包含「上一轮的状态」「可以留意」这类每轮变化的字段
4. 隔 10 天关系下降；隔 60 天有下限（不掉到 5 以下）
5. 传 `echo` 时 affection 上升

### 必过：缓存实测

跑 20 轮对话，统计：

```
cacheReadTokens / (cacheReadTokens + uncachedInputTokens) ≥ 99%
且 uncachedInputTokens 每轮应只包含"用户新消息"那一小段
```

### 交付物

- 源码 + 测试
- `NOTICE`：含第三方代码来源、Live2D 模型原作者署名、Live2D Cubism Core 声明
- `docs/persona-regression.md`：说明两层回归怎么跑

---

## 五、非目标（不要做）

- ❌ 降本优化：缓存命中率已经 98%+，钱应该花在人格上
- ❌ 改 DSH 自带的 preset 选择器：它的选中态是客户端内存态，外部改不动
- ❌ 接本地小模型做记忆整理（用户已否决）
- ❌ 照搬 40M 参数情绪模型（本机跑不动，且上游自己都没训出权重）

---

## 六、排期建议

```
第 1 周  记忆三层 + 关系数值 + 情绪六维（纯逻辑，可单测）
第 2 周  注入与缓存约束 + 人格底稿 + 测试套件
第 3 周  HTTP 路由 + 客户端面板（设置、记忆列表、关系数值）
第 4 周  Live2D 桌宠 + 记忆星图
```

每周结束必须能 `npm test` 全绿，且不破坏"系统提示词逐字节稳定"这条。
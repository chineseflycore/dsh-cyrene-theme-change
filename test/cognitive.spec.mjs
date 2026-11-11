/**
 * 认知引擎与关系层的单元测试（不起服务器、不碰磁盘）：
 *
 *   node test/cognitive.spec.mjs
 *
 * 覆盖：切词/相似度、新鲜度、召回打分、遗忘曲线、冲突评分与处置、
 *      写入判定与分层、注入预算、情绪环、关系推进与连续天数。
 */
import assert from 'node:assert/strict'

const C = await import('../lib/cognitive.js')
const R = await import('../lib/relationship.js')

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}`)
    console.log(String(error?.stack ?? error).split('\n').slice(0, 6).join('\n'))
  }
}

const DAY = 86_400_000
const NOW = Date.parse('2026-11-07T12:00:00+08:00')

// ── 切词与相似度 ────────────────────────────────────────────────
await test('中文按 2-gram 切词，单字保留', () => {
  const tokens = C.tokenize('爬山')
  assert.deepEqual([...tokens].sort(), ['爬山'])
  const single = C.tokenize('猫')
  assert.deepEqual([...single], ['猫'])
})

await test('英文与数字按词切，大小写归一', () => {
  const tokens = C.tokenize('DSH v0.4.1 Windows')
  assert.ok(tokens.has('dsh'))
  assert.ok(tokens.has('windows'))
  assert.ok(tokens.has('v0'))
})

await test('相似度：同文为 1，无关为 0，部分命中居中', () => {
  assert.equal(C.similarityOf('周三去爬山', '周三去爬山'), 1)
  assert.equal(C.similarityOf('周三去爬山', '量子力学'), 0)
  const partial = C.similarityOf('周三去爬山', '周三要早起')
  assert.ok(partial > 0 && partial < 1, `expected 0<${partial}<1`)
})

await test('相似度对长度不敏感（长记忆 vs 短查询）', () => {
  const long = '用户偏好深色主题，屏幕是 2560x1600，主力语言是 TypeScript'
  const short = '深色主题'
  assert.ok(C.similarityOf(long, short) > 0.15, '长短差距不该把相关度压没')
})

// ── 新鲜度与遗忘 ────────────────────────────────────────────────
await test('新鲜度：今天≈1，一周≈0.5，四周≈0.2', () => {
  assert.ok(Math.abs(C.freshness(NOW, NOW) - 1) < 1e-9)
  assert.ok(Math.abs(C.freshness(NOW - 7 * DAY, NOW) - 0.5) < 1e-9)
  assert.ok(Math.abs(C.freshness(NOW - 28 * DAY, NOW) - 0.2) < 0.01)
})

await test('遗忘：一天跌不超过 0.03，且有 0.05 地板', () => {
  const entry = { weight: 0.3, created: NOW - DAY, lastDecay: NOW - DAY, accessCount: 0 }
  const after = C.decayWeight(entry, NOW)
  assert.ok(after <= 0.3 && after >= 0.27, `got ${after}`)

  const old = { weight: 0.08, created: NOW - 365 * DAY, lastDecay: NOW - 365 * DAY }
  assert.ok(C.decayWeight(old, NOW) >= 0.05)
})

await test('遗忘：0.7 以上被钉住，不衰减', () => {
  const pinned = { weight: 0.82, created: NOW - 100 * DAY, lastDecay: NOW - 100 * DAY }
  assert.equal(C.decayWeight(pinned, NOW), 0.82)
})

await test('遗忘与结算间隔成正比（一天 vs 十天）', () => {
  const base = { weight: 0.5, accessCount: 0 }
  const one = C.decayWeight({ ...base, lastDecay: NOW - DAY }, NOW)
  const ten = C.decayWeight({ ...base, lastDecay: NOW - 10 * DAY }, NOW)
  assert.ok(ten < one)
})

await test('召回强化：+0.02 且封顶 0.68，同时记一次访问', () => {
  const touched = C.touchWeight({ weight: 0.5, accessCount: 2 }, NOW)
  assert.equal(touched.weight, 0.52)
  assert.equal(touched.accessCount, 3)
  assert.equal(touched.lastAccess, NOW)
  assert.equal(C.touchWeight({ weight: 0.67 }, NOW).weight, 0.68)
})

await test('成色到状态：0.4 起 active，0.1 以下归档', () => {
  assert.equal(C.statusOf(0.75), 'active')
  assert.equal(C.statusOf(0.2), 'aging')
  assert.equal(C.statusOf(0.05), 'archived')
})

// ── 召回打分 ────────────────────────────────────────────────────
await test('召回：字面命中应当高于同等权重但无关的条目', () => {
  const query = C.tokenize('爬山')
  const hit = C.scoreRecall({ text: '周三去爬山', weight: 0.5, created: NOW }, query, { now: NOW })
  const miss = C.scoreRecall({ text: '量子力学', weight: 0.5, created: NOW }, query, { now: NOW })
  assert.ok(hit > miss, `${hit} should > ${miss}`)
})

await test('召回：同样的字面命中，权重高的排前面', () => {
  const query = C.tokenize('爬山')
  const heavy = C.scoreRecall({ text: '周三去爬山', weight: 0.9, created: NOW }, query, { now: NOW })
  const light = C.scoreRecall({ text: '周三去爬山', weight: 0.2, created: NOW }, query, { now: NOW })
  assert.ok(heavy > light)
})

await test('召回：情绪标记有温和放大，但不至于翻盘', () => {
  const query = C.tokenize('爬山')
  const plain = C.scoreRecall({ text: '周三去爬山', weight: 0.5, created: NOW }, query, { now: NOW })
  const emo = C.scoreRecall({ text: '周三去爬山', weight: 0.5, created: NOW, emotion: 1 }, query, { now: NOW })
  assert.ok(emo > plain)
  assert.ok(emo < plain * 1.3)
})

// ── 冲突评分 ────────────────────────────────────────────────────
await test('冲突：无证据不得升级为裁决', () => {
  const result = C.scoreConflict({ candidateSource: 'local', evidence: 'none', activeTarget: true })
  assert.equal(result.resolverPriority, 'none')
  assert.ok(result.penalties.includes('missing_evidence'))
})

await test('冲突：用户当场纠正 + 双方证据 → 至少 normal，再加本地矛盾才 high', () => {
  const base = {
    candidateSource: 'rag',
    ragScore: 0.8,
    correctionIntent: true,
    evidence: 'both',
    activeTarget: true,
    impactScope: 'high',
  }
  // 20+25+15+10 = 70：够得上裁决，但还没到「必须马上处理」。
  assert.equal(C.scoreConflict(base).resolverPriority, 'normal')
  const escalated = C.scoreConflict({ ...base, localContradiction: true })
  assert.equal(escalated.resolverPriority, 'high')
  assert.ok(escalated.conflictScore >= 75)
})

await test('冲突：刚处理过的同一对不反复打扰', () => {
  const result = C.scoreConflict({
    candidateSource: 'rag',
    ragScore: 0.8,
    correctionIntent: true,
    evidence: 'both',
    activeTarget: true,
    recentlyResolvedSamePair: true,
  })
  assert.notEqual(result.resolverPriority, 'high')
  assert.ok(result.penalties.includes('recently_resolved_same_pair'))
})

await test('冲突处置：高相似低冲突直接合并，高冲突交裁决', () => {
  const existing = { id: 'a', status: 'active', weight: 0.6, text: '用户喜欢深色主题' }
  const merge = C.planConflict(existing, { text: '用户偏好深色主题' }, 0.9)
  assert.equal(merge.action, 'merge')
  const add = C.planConflict(existing, { text: '完全不同的事' }, 0.1)
  assert.equal(add.action, 'add')
})

// ── 写入判定与分层 ──────────────────────────────────────────────
await test('写入判定：寒暄、问句、报错、代码块都该被挡', () => {
  assert.equal(C.judgeCandidate('好').keep, false)
  assert.equal(C.judgeCandidate('这是什么？').keep, false)
  assert.equal(C.judgeCandidate('Error: cannot find module dsh').keep, false)
  assert.equal(C.judgeCandidate('```js\nconst a = 1\n```').keep, false)
})

await test('写入判定：明确的事要留下，并给出分层', () => {
  const ok = C.judgeCandidate('用户偏好深色主题，屏幕是 2560x1600')
  assert.equal(ok.keep, true)
  assert.equal(ok.layer, 'L2')
})

await test('写入判定：显式指定时绕过启发式（但长度下限仍生效）', () => {
  // 问句本来会被 heuristic 挡住，explicit 时必须放行。
  assert.equal(C.judgeCandidate('这件事要不要记下来？').keep, false)
  const forced = C.judgeCandidate('这件事要不要记下来？', { explicit: true })
  assert.equal(forced.keep, true)
  // 但一个字这种真的没信息，显式也不行。
  assert.equal(C.judgeCandidate('好', { explicit: true }).keep, false)
})

await test('分层：身份进 L0、近况进 L1、其余进 L2', () => {
  assert.equal(C.classifyLayer('以后叫我 P 宝'), 'L0')
  assert.equal(C.classifyLayer('我是前端工程师'), 'L0')
  assert.equal(C.classifyLayer('最近在做一个 DSH 插件'), 'L1')
  assert.equal(C.classifyLayer('周三去爬山了'), 'L2')
})

await test('L1/L0 字段归位：认不出时落到兜底字段', () => {
  assert.equal(C.resolveL1Field(undefined, '这个项目要做完'), 'currentProject')
  assert.equal(C.resolveL1Field(undefined, '最近想学 Rust'), 'recentGoals')
  assert.equal(C.resolveL1Field('bogus', '随便'), 'recentPreferences')
  assert.equal(C.resolveL0Field(undefined, '叫我小满'), 'preferredName')
  assert.equal(C.resolveL0Field('bogus', '随便'), 'permanentNote')
})

await test('L0 更新保留其它字段，只动目标字段', () => {
  const before = { preferredName: '小满', occupation: '设计师', updatedAt: 1 }
  const after = C.nextL0(before, 'occupation', '前端工程师', { now: NOW })
  assert.equal(after.preferredName, '小满')
  assert.equal(after.occupation, '前端工程师')
  assert.equal(after.updatedAt, NOW)
})

// ── 注入成文 ────────────────────────────────────────────────────
await test('注入：三层都有内容时按顺序出现', () => {
  const text = C.buildInjection({
    l0: { preferredName: 'P 宝', occupation: '前端工程师' },
    l1: { currentProject: 'DSH 插件' },
    recalled: [{ text: '周三去爬山', created: new Date(NOW).toISOString(), tags: ['出行'] }],
  })
  assert.ok(text.includes('【昔涟 · 关于你】'))
  assert.ok(text.includes('称呼：P 宝'))
  assert.ok(text.includes('【昔涟 · 最近】'))
  assert.ok(text.includes('在忙的事：DSH 插件'))
  assert.ok(text.includes('【昔涟 · 记得的事】'))
  assert.ok(text.includes('周三去爬山'))
})

await test('注入：空画像给空串（不挂空 section）', () => {
  assert.equal(C.buildInjection({ l0: {}, l1: {}, recalled: [] }), '')
  assert.equal(C.buildInjection(null), '')
})

await test('注入：超出预算时硬截断，且必然带护栏话术', () => {
  const long = '很长的记忆'.repeat(400)
  const text = C.buildInjection({
    l0: { preferredName: 'P 宝' },
    l1: { currentProject: 'DSH' },
    recalled: [{ text: long, created: new Date(NOW).toISOString() }],
  })
  assert.ok(text.length <= C.INJECT_MAX_CHARS + 80, `len=${text.length}`)
  assert.ok(text.includes('不要因此改变你的性格'), '尾部护栏不能被预算挤掉')
})

await test('注入：预算优先保画像，L1/L2 先让位', () => {
  const text = C.buildInjection(
    {
      l0: { preferredName: 'P 宝' },
      l1: { currentProject: '很长的项目描述'.repeat(40) },
      recalled: [{ text: '旧事'.repeat(100), created: new Date(NOW).toISOString() }],
    },
    { budget: 200 },
  )
  assert.ok(text.includes('称呼：P 宝'), '画像必须留下')
})

// ── 关系与情绪 ──────────────────────────────────────────────────
await test('情绪识别：疲劳/焦虑/低落/开心/边界', () => {
  assert.equal(R.detectUserMood('今天好累啊'), '疲惫')
  assert.equal(R.detectUserMood('压力好大，来不及了'), '焦虑')
  assert.equal(R.detectUserMood('有点难过'), '低落')
  assert.equal(R.detectUserMood('太好了，成了'), '开心')
  assert.equal(R.detectUserMood('别弹确认了，太影响观感'), '明确边界')
  assert.equal(R.detectUserMood('周三去爬山'), '未知')
})

await test('情绪环：独立衰减，叠加后取主导', () => {
  const first = R.stepEmotions(R.emptyEmotions(), { joy: 0.6 })
  assert.equal(first.dominant.dimension, 'joy')
  const second = R.stepEmotions(first.emotions, { sadness: 0.1 })
  assert.ok(second.emotions.joy < first.emotions.joy, '没再被激发的维度要衰减')
})

await test('情绪环：单轮增量封顶 0.55，值域夹在 0..1', () => {
  const stepped = R.stepEmotions(R.emptyEmotions(), { anger: 5 })
  assert.ok(stepped.emotions.anger <= 0.55)
  const drained = R.stepEmotions(R.emptyEmotions(), { anger: -3 })
  assert.ok(drained.emotions.anger >= 0)
})

await test('关系：一轮之后轮次+1、有日期、有下一句关心', () => {
  const state = R.recordTurn(R.emptyRelationship(NOW), {
    userText: '今天好累啊',
    assistantText: '那先歇会儿',
  }, { now: NOW })
  assert.equal(state.turns, 1)
  assert.equal(state.lastSeen, '2026-11-07')
  assert.equal(state.lastMood, '疲惫')
  assert.ok(state.nextCareCue.length > 0)
  assert.ok(state.affinity > 0)
})

await test('关系：夸奖拉亲近度，道歉加信任', () => {
  const base = R.emptyRelationship(NOW)
  const praised = R.recordTurn(base, { userText: '谢谢，你太厉害了' }, { now: NOW })
  const sorry = R.recordTurn(base, { userText: '对不起，我搞错了' }, { now: NOW })
  assert.ok(praised.affinity > sorry.affinity)
  assert.ok(sorry.trust > base.trust)
})

await test('关系：数值永远夹在 0..100', () => {
  let state = R.emptyRelationship(NOW)
  for (let i = 0; i < 400; i += 1) {
    state = R.recordTurn(state, { userText: '谢谢你，太厉害了' }, { now: NOW + i * 1000 })
  }
  assert.ok(state.affinity <= 100 && state.trust <= 100)
})

await test('连续天数：昨天来过 +1，隔两天从 1 重来', () => {
  assert.equal(R.computeStreak('2026-11-06', '2026-11-07', 3), 4)
  assert.equal(R.computeStreak('2026-11-04', '2026-11-07', 3), 1)
  assert.equal(R.computeStreak('2026-11-07', '2026-11-07', 3), 3)
})

await test('关系阶段：聊两句不算熟，两个信号都到才升级', () => {
  assert.equal(R.relationshipStage({ affinity: 80, turns: 3 }).key, 'new')
  assert.equal(R.relationshipStage({ affinity: 80, turns: 200 }).key, 'close')
})

await test('关系注入：带护栏，且不写性格', () => {
  const state = R.recordTurn(R.emptyRelationship(NOW), { userText: '谢谢你' }, { now: NOW })
  const text = R.buildRelationshipText(state)
  assert.ok(text.includes('【昔涟 · 你和他现在的关系】'))
  assert.ok(text.includes('不改变你是谁'))
  assert.equal(R.buildRelationshipText(state, { enabled: false }), '')
})

// ── 汇总 ────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1

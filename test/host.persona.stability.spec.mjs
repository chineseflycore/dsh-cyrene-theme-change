// 人格 / 提示词稳定性回归（不调模型，零成本）。
//
// 为什么需要它：人格效果一旦改动就只能靠"看着像不像"来验收，很容易改坏而不自知。
// 这个套件只钉住**可机械验证的性质**：
//   1. 关系段是纯函数：同样的输入永远产出同样的字节（缓存按前缀命中，抖动就是钱）
//   2. 情绪只有跨档才改文本（不是每轮都改）
//   3. 久不联系，关系会掉（不能只涨不跌）
//   4. 旧记忆命中会点亮情绪（情绪↔记忆联动）
//   5. 人格底稿保留了口吻、边界、样例三块
//
// 真正的"像不像她"要拿模型跑（约 ¥0.2/轮），见 docs/persona-regression.md。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const R = await import('../lib/host/relationship.js')

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push(name)
    console.log(`  FAIL ${name} → ${error.message}`)
  }
}

const NOW = Date.parse('2026-11-11T10:00:00+08:00')
const base = () => ({
  ...R.emptyRelationship(NOW),
  affinity: 20,
  trust: 20,
  familiarity: 5,
  turns: 10,
  lastSeen: '2026-11-11',
  dominant: { key: 'calm', label: '平静', intensity: 0 },
  emotions: { ...R.emptyEmotions() },
})

console.log('\n提示词稳定性')

await test('关系段：同样输入连续调用，字节完全一致', () => {
  const state = base()
  const a = R.buildRelationshipText(state)
  const b = R.buildRelationshipText({ ...state })
  const c = R.buildRelationshipText({ ...state })
  assert.equal(a, b)
  assert.equal(b, c)
})

await test('关系段：情绪未到档位时不出现「此刻情绪」', () => {
  const text = R.buildRelationshipText({
    ...base(), dominant: { key: 'joy', label: '开心', intensity: 0.49 },
  })
  assert.ok(!text.includes('此刻情绪'), text)
})

await test('关系段：情绪跨到档位才出现，且只有两个档', () => {
  const mid = R.buildRelationshipText({
    ...base(), dominant: { key: 'joy', label: '开心', intensity: 0.6 },
  })
  const strong = R.buildRelationshipText({
    ...base(), dominant: { key: 'joy', label: '开心', intensity: 0.8 },
  })
  assert.ok(mid.includes('有点开心'), mid)
  assert.ok(strong.includes('明显的开心'), strong)
})

await test('关系段：不再包含每轮都会变的字段', () => {
  const text = R.buildRelationshipText({
    ...base(),
    lastMood: '疲惫',
    nextCareCue: '问问他是不是没休息好',
    dominant: { key: 'joy', label: '开心', intensity: 0.9 },
  })
  assert.ok(!text.includes('上一轮的状态'), text)
  assert.ok(!text.includes('可以留意'), text)
})

console.log('\n关系衰减')

await test('当天连续聊：不衰减', () => {
  const next = R.recordTurn(base(), { userText: '你好' }, { now: NOW })
  assert.ok(next.affinity >= 20, `affinity=${next.affinity}`)
})

await test('隔 10 天：关系明显变凉', () => {
  const later = NOW + 10 * 86400000
  const next = R.recordTurn(base(), { userText: '我回来了' }, { now: later })
  assert.ok(next.affinity < 20, `affinity=${next.affinity} 应该低于 20`)
})

await test('隔 60 天：衰减有下限，不会归零', () => {
  const later = NOW + 60 * 86400000
  const next = R.recordTurn(base(), { userText: '好久不见' }, { now: later })
  assert.ok(next.affinity > 5, `affinity=${next.affinity} 不该掉到 5 以下`)
})

console.log('\n情绪 ↔ 记忆联动')

await test('旧记忆命中：亲密感被点亮', () => {
  const plain = R.recordTurn(base(), { userText: '嗯' }, { now: NOW })
  const echoed = R.recordTurn(base(), { userText: '嗯' }, { now: NOW, echo: 1 })
  assert.ok(
    echoed.emotions.affection > plain.emotions.affection,
    `${echoed.emotions.affection} 应该大于 ${plain.emotions.affection}`,
  )
})

console.log('\n人格底稿')

await test('保留口吻 / 边界 / 样例三块', async () => {
  const src = await readFile(new URL('../lib/host/state.js', import.meta.url), 'utf8')
  assert.ok(src.includes('【口吻】'), '缺【口吻】')
  assert.ok(src.includes('【必须守住的边界】'), '缺【必须守住的边界】')
  assert.ok(src.includes('【说话样例】'), '缺【说话样例】')
})

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed}/${passed + failures.length}`)
if (failures.length > 0) {
  console.log(`失败项：${failures.join(' | ')}`)
  process.exitCode = 1
}
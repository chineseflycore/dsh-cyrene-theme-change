/**
 * 情绪 → Live2D 表情 / 动作映射的单元测试（纯函数，不碰 DOM 与磁盘）：
 *
 *   node test/view.live2d-map.spec.mjs
 *
 * 覆盖：六维情绪 + 平静 + 未知值的映射、返回对象不共享引用、
 *      "平静 → 强烈情绪才播动作"的时机、中文标签。
 */
import assert from 'node:assert/strict'

const M = await import('../lib/live2d-map.js')

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}`)
    console.log(String(error?.stack ?? error).split('\n').slice(0, 6).join('\n'))
  }
}

const EXPECTED = {
  joy: { expression: '开心眼', group: 'Tick3', index: 2 },
  affection: { expression: '星星眼', group: '动作#6', index: 2 },
  sadness: { expression: '圈圈眼', group: '动作#6', index: 0 },
  anxiety: { expression: '问号', group: '动作#6', index: 1 },
  fatigue: { expression: '圈圈眼', group: 'Tick3', index: 3 },
  anger: { expression: '墨镜', group: '动作#6', index: 0 },
}

console.log('view.live2d-map.spec.mjs\n')

test('六个情绪维度各自映射到 model3.json 里真实存在的表情与动作', () => {
  for (const [dimension, expected] of Object.entries(EXPECTED)) {
    const picked = M.pickEmotionPresentation(dimension)
    assert.equal(picked.expression, expected.expression, dimension)
    assert.deepEqual(picked.motion, { group: expected.group, index: expected.index }, dimension)
  }
})

test('平静（null / undefined / 空串）回正，动作交给 idle 池', () => {
  for (const value of [null, undefined, '']) {
    const picked = M.pickEmotionPresentation(value)
    assert.deepEqual(picked, { expression: '表情回正', motion: null }, String(value))
  }
})

test('未知值不会被误当成某种情绪（一律按平静处理）', () => {
  for (const value of ['happy', 'JOY', '平静', 0, {}, []]) {
    assert.deepEqual(M.pickEmotionPresentation(value), { expression: '表情回正', motion: null }, String(value))
    assert.equal(M.isKnownEmotion(value), false, String(value))
  }
})

test('返回的是新对象：改它不会污染映射表', () => {
  const first = M.pickEmotionPresentation('joy')
  first.expression = '墨镜'
  first.motion.index = 99
  const second = M.pickEmotionPresentation('joy')
  assert.equal(second.expression, '开心眼')
  assert.equal(second.motion.index, 2)
})

test('只有「平静 → 非平静」且强度 ≥ 0.4 才播动作', () => {
  assert.equal(M.shouldPlayEmotionMotion(null, 'joy', 0.6), true)
  assert.equal(M.shouldPlayEmotionMotion(undefined, 'anger', 0.4), true)
  assert.equal(M.shouldPlayEmotionMotion(null, 'joy', 0.39), false)
  assert.equal(M.shouldPlayEmotionMotion('joy', 'sadness', 0.9), false, '情绪之间互切只换表情')
  assert.equal(M.shouldPlayEmotionMotion(null, null, 0.9), false)
  assert.equal(M.shouldPlayEmotionMotion(null, 'bogus', 0.9), false)
})

test('情绪中文名：已知维度照表，未知回「平静」', () => {
  assert.equal(M.emotionLabel('joy'), '开心')
  assert.equal(M.emotionLabel('affection'), '亲近')
  assert.equal(M.emotionLabel(null), '平静')
  assert.equal(M.emotionLabel('bogus'), '平静')
})

if (failures.length > 0) {
  console.log(`\nFAIL  ${failures.length} 项失败`)
  process.exitCode = 1
} else {
  console.log(`\nPASS  ${passed}/${passed}`)
}

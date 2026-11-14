// 角色记忆 / 委托状态的单元测试（不起服务器、不碰真实 DSH_HOME）。
//
//   node test/host.character.spec.mjs

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'cyrene-character-'))
process.env.DSH_HOME = home

const CM = await import('../lib/host/character-memory.js')
const CORE = await import('../lib/host/memory-core.js')
const DS = await import('../lib/host/delegation-state.js')

let passed = 0
const failures = []
function ok(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name} → ${JSON.stringify(detail)}`)
  }
}

console.log('\n角色记忆')

const DAY = 86_400_000
const old = new Date(Date.now() - 30 * DAY).toISOString()

// 1. 自动分层
const saved = await CM.rememberForCharacter('bai-e', '我叫小满，做前端')
const store1 = await CM.loadCharacterMemory('bai-e')
ok('自动分层：自我介绍落 L0', store1.items[0].layer === 'L0', store1.items.map((i) => [i.layer, i.text]))
ok('remember 返回层', saved !== null && saved.layer === 'L0', saved)

// 2. 向量
ok('条目带 768 维向量', typeof store1.items[0].vec === 'string' && store1.items[0].vec.length > 10, store1.items[0].vec)

// 3. 衰减
await CM.rememberForCharacter('bai-e', '几天前的一件小事', [], 'L2')
const store2 = await CM.loadCharacterMemory('bai-e')
const target = store2.items.find((item) => item.text.includes('几天前'))
target.created = old
target.lastDecay = Date.parse(old)
target.weight = 0.5
const decayed = CORE.decayItems(store2.items)
const after = decayed.find((item) => item.text.includes('几天前'))
ok('30 天后成色衰减（低于保护线）', after.weight < 0.5, after.weight)
ok('衰减后状态跟着走', after.status === 'aging' || after.status === 'archived', after.status)

// 4. 钉住
const pinTarget = CORE.sanitizeCommonItem({ text: '要钉住的事', layer: 'L2', weight: 0.5 })
CORE.pinItem(pinTarget, true)
ok('钉住抬到 0.7 保护线', pinTarget.weight >= 0.7 && pinTarget.pinned === true, pinTarget)
CORE.pinItem(pinTarget, false)
ok('取消钉住回到 0.69', pinTarget.weight === 0.69 && pinTarget.pinned === false, pinTarget)

// 5. 隔离：不同角色互不串
await CM.rememberForCharacter('aglaea', '用户喜欢简洁界面')
const bai = await CM.loadCharacterMemory('bai-e')
const agl = await CM.loadCharacterMemory('aglaea')
ok('两个角色各存各的', bai.items.every((item) => !item.text.includes('简洁')), bai.items.map((i) => i.text))
ok('另一个角色读到自己的', agl.items.some((item) => item.text.includes('简洁')), agl.items.map((i) => i.text))

// 6. 召回
const recalled = CM.recallFromMemory(agl, '界面', 3)
ok('角色召回命中', recalled.length > 0 && recalled[0].text.includes('简洁'), recalled)

// 7. 清空
await CM.forgetAllForCharacter('aglaea')
const cleared = await CM.loadCharacterMemory('aglaea')
ok('清空后归零', cleared.items.length === 0, cleared.items)

console.log('\n记忆整理')

// 跨批不漂移：12 条按 10/批整理，必须全部处理（曾经边遍历边 splice，后 2 条被跳过）。
const many = Array.from({ length: 12 }, (_, i) => ({ id: `mem-test-${String(i).padStart(4, '0')}`, text: `条目 ${i}`, tags: [] }))
const fakeManager = { organize: async (chunk) => ({ drop: chunk.map((c) => c.id), merge: [] }) }
const organized = await CORE.organizeItems(many, fakeManager, { batchSize: 10 })
ok('全量整理：12 条全部被处理（跨批不漂移）',
  organized.removed === 12 && organized.scanned === 12 && organized.items.length === 0,
  organized)

console.log('\n委托状态')

DS.resetDelegations()
DS.noteTeamEvent({ type: 'team/member', data: { member: { name: 'bai-e', phase: 'active', description: '验证' } } })
ok('team/member 折叠出活跃成员', DS.hasActiveMember('bai-e') === true && DS.activeCount() === 1)
DS.noteTeamEvent({ type: 'team/member', data: { member: { name: 'bai-e', phase: 'idle' } } })
ok('空闲后不再算活跃', DS.hasActiveMember('bai-e') === false && DS.activeCount() === 0)
ok('未知事件不炸', (() => { try { DS.noteTeamEvent({ type: 'other' }); return true } catch { return false } })())

DS.resetDelegations()
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed}/${passed + failures.length}`)
if (failures.length > 0) {
  console.log(`失败项：${failures.join(' | ')}`)
  process.exitCode = 1
}
await rm(home, { recursive: true, force: true })
assert.equal(failures.length, 0)

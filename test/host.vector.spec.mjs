// 向量层（768 维）的纯函数测试：确定性、范围、读写往返。
// 这层不依赖宿主，跑起来毫秒级；它一坏，记忆的去重与聚类就全乱。
import assert from 'node:assert/strict'
import { DIM, cosine, embed, gramTokens, packVector, similarityOfText, unpackVector } from '../lib/host/vector.js'

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

console.log('\n向量层')

const a = embed('项目编译失败，报 cannot find module')
const b = embed('项目编译失败，报 cannot find module')
const c = embed('今天天气不错，出去走走')

ok('维度是 768', a.length === DIM && DIM === 768, a.length)
ok('同一文本 → 同一向量（确定性）', cosine(a, b) > 0.9999, cosine(a, b))
ok('归一化：自身余弦为 1', Math.abs(cosine(a, a) - 1) < 1e-6, cosine(a, a))
ok('无关文本的余弦明显更低', cosine(a, c) < cosine(a, b), [cosine(a, c), cosine(a, b)])
ok('相近改写的相似度高于无关文本',
  similarityOfText('项目编译失败', '项目编译又失败了') > similarityOfText('项目编译失败', '今晚吃什么'),
  [similarityOfText('项目编译失败', '项目编译又失败了'), similarityOfText('项目编译失败', '今晚吃什么')])

ok('切词：中文出单字与双字，西文出单词',
  gramTokens('bug 修复').includes('w:bug') && gramTokens('修复').includes('c:修') && gramTokens('修复').includes('b:修复'),
  gramTokens('bug 修复').slice(0, 4))

ok('空文本不炸，返回零向量',
  embed('').length === DIM && cosine(embed(''), embed('')) === 0,
  cosine(embed(''), embed('')))

const packed = packVector(a)
const unpacked = unpackVector(packed)
ok('打包后能解回，且与原向量高度一致',
  unpacked !== null && cosine(a, unpacked) > 0.99, cosine(a, unpacked ?? new Float32Array(DIM)))
ok('坏数据解包返回 null（调用方回退实时计算）',
  unpackVector('not-base64!!') === null && unpackVector('') === null, 'bad input')

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed}/${passed + failures.length}`)
if (failures.length > 0) {
  console.log(`失败项：${failures.join(' | ')}`)
  process.exitCode = 1
}
assert.equal(failures.length, 0)
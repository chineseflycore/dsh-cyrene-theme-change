// 记忆整理（LLM）的测试：限流重试、整理结果的应用边界。
//
// 背景：记忆整理默认用免费的 GLM-4.7-Flash，它 429 是常态。
// 这里盯住三件事：
//   1. 429 会被识别并重试（2–10 秒退避），其它错误立刻放弃；
//   2. 整理只允许「丢」和「并」，不许新增、不许引用不存在的 id；
//   3. 代码里不再有"每轮自动记一条"的路径。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { RATE_LIMIT_MAX_MS, RATE_LIMIT_MIN_MS, RATE_LIMIT_WINDOW_MS, isRateLimitError } from '../lib/host/memory-llm.js'

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

console.log('\n记忆整理 · 限流与边界')

const llm = readFileSync(new URL('../lib/host/memory-llm.js', import.meta.url), 'utf8')
const host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

// ── 1. 限流识别 ─────────────────────────────────────────────────
ok('识别 429 状态码', isRateLimitError('HTTP 429 Too Many Requests'), null)
ok('识别 rate limit 文案', isRateLimitError('rate_limit_exceeded'), null)
ok('识别中文限流提示', isRateLimitError('请求过多，请稍后再试'), null)
ok('不把普通错误当限流', !isRateLimitError('model not found'), null)
ok('不把空错误当限流', !isRateLimitError(''), null)

// ── 2. 退避参数在 2–10 秒区间 ────────────────────────────────────
ok('最小退避 2 秒', RATE_LIMIT_MIN_MS === 2000, RATE_LIMIT_MIN_MS)
ok('最大退避 10 秒', RATE_LIMIT_MAX_MS === 10000, RATE_LIMIT_MAX_MS)
ok('窗口期 3 分钟（不会无限挂）', RATE_LIMIT_WINDOW_MS === 180000, RATE_LIMIT_WINDOW_MS)
ok('runText 里真的循环重试', /for \(;;\)/.test(llm) && /runTextOnce/.test(llm), '没有重试循环')

// ── 3. 整理的应用边界 ───────────────────────────────────────────
ok('organize 只接受已知 id', /known\.has\(id\)/.test(llm), '未校验 id')
ok('合并至少要两条', /ids\.length >= 2/.test(llm), '允许单条"合并"')
ok('提示词禁止创作', /不创作/.test(llm), '缺约束')

// ── 4. 自动记录已撤除 ───────────────────────────────────────────
ok('没有 captureTurnMemory 路径', !/captureTurnMemory/.test(host), '还在自动记')
ok('没有同主题自动合并', !/consolidateByVector/.test(host), '还在自动合并')
ok('有 organize 工具', /cyrene_memory_organize/.test(host), '缺工具')
ok('不强制默认模型（用户自己选）',
  !/DEFAULT_MEMORY_MODEL/.test(host), '还在强制某个模型')
ok('提供可选模型列表接口', /route === '\/memory\/models'/.test(host), '缺 /memory/models')
ok('列表来自 host 的 listModels', /listModels\(id\)/.test(host), '未调用 listModels')

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed}/${passed + failures.length}`)
if (failures.length > 0) {
  console.log(`失败项：${failures.join(' | ')}`)
  process.exitCode = 1
}
assert.equal(failures.length, 0)
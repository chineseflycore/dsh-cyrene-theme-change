// 记忆写入的「垃圾过滤」测试。
//
// 起因：真机上的记忆库 26 条里有 17 条是框架注入的文本——
//   "Time sampled while preparing turn 201, step 1: …"
//   "background job bash-… (bash: cd /storage/…)"
// 它们被当成用户发言，让「每轮自动记一条」写进了记忆库，把真正的对话淹了。
//
// 这里盯住三件事：
//   1. 注入文本一律不记；
//   2. 非用户来源（source.kind !== 'user'）不算一轮；
//   3. 短问句不记，长陈述照记。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
// 注入前缀 / 写入判定已拆到 lib/host/text.js（P0 拆分后），扫描两份。
const textSource = readFileSync(new URL('../lib/host/text.js', import.meta.url), 'utf8')
const memorySource = readFileSync(new URL('../lib/host/memory-store.js', import.meta.url), 'utf8')
const captureSource = `${source}\n${textSource}\n${memorySource}`

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

console.log('\n记忆写入 · 垃圾过滤')

// ── 1. 注入前缀清单存在且覆盖已知形状 ────────────────────────────
const patterns = [...captureSource.matchAll(/\/\^([^/]+)\/iu/g)].map((m) => m[1])
ok('有注入前缀清单', /INJECTED_PREFIXES/.test(captureSource), '未定义')
ok('识别 Time sampled 时间戳', patterns.some((p) => p.includes('Time sampled')), patterns)
ok('识别 background job 通知', patterns.some((p) => p.includes('background job')), patterns)
ok('识别 runtime context 注入', patterns.some((p) => p.includes('runtime context')), patterns)
ok('识别 system-reminder 块', patterns.some((p) => p.includes('system-reminder')), patterns)

// ── 2. 两道防线都在 ──────────────────────────────────────────────
ok('shouldAutoCapture 里有注入过滤',
  /function shouldAutoCapture[\s\S]{0,300}looksInjected\(value\)/.test(captureSource), '缺过滤')
ok('事件入口按 source.kind 判定作者',
  /const kind = event\?\.data\?\.source\?\.kind/.test(captureSource), '未读 source.kind')
ok('非用户来源不推进轮次',
  /authored && text !== ''/.test(captureSource), '仍在无条件推进轮次')

// ── 3. 质量门槛 ──────────────────────────────────────────────────
// ── 3. 质量门口：能交给提示词的就别写硬规则 ──────────────────────
ok('短问句过滤交给提示词（代码里不再硬判）',
  !/length < 25 && \/\[\?？\]/.test(source), '代码里还留着硬规则')
ok('仍有最小长度门槛', /AUTO_CAPTURE_MIN_CHARS/.test(captureSource), '缺门槛')

// ── 3.5 「先记再答」的触发词写在提示词里 ─────────────────────────
const cognit = readFileSync(new URL('../lib/host/cognitive.js', import.meta.url), 'utf8')
ok('提示词含触发词规则',
  /「不要」「别再」「以后」「记住」「下次」/.test(cognit), '提示词未写触发词')
ok('提示词含写记忆的工具名',
  /cyrene_memory_add/.test(cognit) && /cyrene_memory_search/.test(cognit), '工具名缺失')
ok('提示词不再提不存在的 cyrene_memory_recall',
  !/cyrene_memory_recall/.test(cognit), '还在引用错工具名')

// ── 4. 清理工具留下的痕迹（防止又被写回去）──────────────────────
ok('记忆读取会重建 status/weight（不会复活已清理条目）',
  /decayWeight\(item, now\)/.test(captureSource), '缺结算')

console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  ${passed}/${passed + failures.length}`)
if (failures.length > 0) {
  console.log(`失败项：${failures.join(' | ')}`)
  process.exitCode = 1
}
assert.equal(failures.length, 0)
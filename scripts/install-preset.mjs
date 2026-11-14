// 安装「纯文本对话模式」预设到 <DSH_HOME>/.agent-presets/chat/。
//
// 用法：
//   node scripts/install-preset.mjs --dry-run   # 只打印计划
//   node scripts/install-preset.mjs             # 安装（已存在且不同会拒绝）
//   node scripts/install-preset.mjs --force     # 覆盖已有
//
// 预设由 DSH 按目录扫描发现，所以拷完重启/重开 DSH 就能在预设列表里看到。

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, '..', 'preset', 'chat')
const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : join(homedir(), '.dsh')
const target = join(home, '.agent-presets', 'chat')

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const force = args.has('--force')

const files = ['agent.cordis.yml', 'preset.yml']

function same(a, b) {
  try {
    return readFileSync(a, 'utf8') === readFileSync(b, 'utf8')
  } catch {
    return false
  }
}

console.log(`源目录: ${source}`)
console.log(`目标:   ${target}`)
console.log(`模式:   ${dryRun ? 'dry-run' : force ? 'force' : 'install'}`)

const changes = []
for (const file of files) {
  const from = join(source, file)
  const to = join(target, file)
  if (!existsSync(from)) {
    console.error(`缺少源文件: ${from}`)
    process.exitCode = 1
    continue
  }
  if (!existsSync(to)) changes.push(`新增 ${file}`)
  else if (!same(from, to)) changes.push(`${force ? '覆盖' : '冲突（加 --force 覆盖）'} ${file}`)
  else changes.push(`不变 ${file}`)
}

if (changes.length > 0) console.log('\n计划：')
for (const line of changes) console.log('  ' + line)

const blocked = changes.some((line) => line.startsWith('冲突'))
if (dryRun) {
  console.log('\n[dry-run] 未写入任何文件。')
  process.exit(0)
}
if (blocked && !force) {
  console.error('\n已有不同的预设文件，拒绝覆盖。加 --force 重跑。')
  process.exit(1)
}

mkdirSync(target, { recursive: true })
for (const file of files) {
  cpSync(join(source, file), join(target, file))
}
console.log('\n已安装。重启 DSH 后在预设列表里选「纯文本对话模式」。')

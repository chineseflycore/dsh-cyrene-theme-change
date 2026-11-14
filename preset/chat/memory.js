// 纯文本对话模式的长期记忆（预设挂载模块）。
//
// 记忆本体是 <DSH_HOME>/cyrene-memory.md：纯文本、一行一条 `- 内容`、人可手改。
// 本模块只做两件事：
//  1. 注册模板变量 {{cyrene_memory}}（每轮现取，写完立刻生效）；
//  2. 注册 remember / forget 两个工具（没有 tools 服务时静默降级为只读）。
//
// 不做「扉页 / 四问锚点」——那些是参考项目的扩展，省事版暂不需要。

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const inject = ['systemPrompt']

const HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : join(homedir(), '.dsh')
const STORE = join(HOME, 'cyrene-memory.md')

/** 注入上限：记忆再长也不该吃掉对话空间，超了按行截断。 */
const MAX_INJECT_CHARS = 2000
/** 单条记忆长度上限。 */
const MAX_ENTRY_CHARS = 300
/** 归档标记：这一行之后的条目仍留在文件里，但不再注入。 */
const ARCHIVE_MARK = '## 归档（不注入）'

function readStore() {
  try {
    return readFileSync(STORE, 'utf8')
  } catch {
    return ''
  }
}

function writeStore(text) {
  writeFileSync(STORE, text.endsWith('\n') ? text : `${text}\n`, 'utf8')
}

/** 只取归档标记之前的 `- 内容` 行。 */
function activeEntries(text) {
  const out = []
  let archived = false
  for (const line of String(text).split('\n')) {
    if (line.trim() === ARCHIVE_MARK) {
      archived = true
      continue
    }
    if (archived) continue
    const trimmed = line.trim()
    if (trimmed.startsWith('- ')) {
      const value = trimmed.slice(2).trim()
      if (value !== '') out.push(value)
    }
  }
  return out
}

function injectText() {
  const entries = activeEntries(readStore())
  if (entries.length === 0) return '（暂无记忆）'
  let text = entries.map((entry) => `- ${entry}`).join('\n')
  if (text.length > MAX_INJECT_CHARS) text = `${text.slice(0, MAX_INJECT_CHARS)}…`
  return text
}

function remember(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_ENTRY_CHARS)
  if (clean === '') return '没写成：正文是空的。'
  const current = readStore()
  const separator = current === '' || current.endsWith('\n') ? '' : '\n'
  writeStore(`${current}${separator}- ${clean}\n`)
  return '已记住。'
}

function forget(keyword) {
  const key = String(keyword ?? '').trim()
  if (key === '') return '没删：缺关键词。'
  const current = readStore()
  const lines = current.split('\n')
  const kept = lines.filter((line) => !(line.trim().startsWith('- ') && line.includes(key)))
  const removed = lines.length - kept.length
  if (removed === 0) return `没找到包含「${key}」的条目。`
  writeStore(kept.join('\n'))
  return `已删掉 ${removed} 条。`
}

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value) }],
}

export function apply(ctx) {
  ctx.systemPrompt.variable('cyrene_memory', () => injectText())

  ctx.inject(['tools'], (scope) => {
    scope.tools.register({
      name: 'remember',
      description: '把一条关于对方的长期信息写进你自己的长期记忆，跨会话保留。只在对方明确说「记住」、或主动告诉你一件明显的长期事实时使用。不要记录一次性的、临时的内容。一次只记一件事，用一句话写。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要记住的那件事，一句话' } },
        required: ['text'],
      },
      output: textOutput,
      execute: (args) => remember(args?.text),
    })
    scope.tools.register({
      name: 'forget',
      description: '从你的长期记忆里删掉内容包含某关键词的条目。在对方明确说「忘掉」「别记着」某件事时使用。',
      parameters: {
        type: 'object',
        properties: { keyword: { type: 'string', description: '要忘掉的内容里包含的关键词' } },
        required: ['keyword'],
      },
      output: textOutput,
      execute: (args) => forget(args?.keyword),
    })
  })
}

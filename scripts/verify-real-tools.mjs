// 真实工具集的鲁棒性测试：用 DSH 实际的 edit 工具形状（old_string/new_string
// 里含引号、换行、反斜杠），验证围栏 JSON 能不能活着走完全程。
// 这是「模拟」最可能崩的地方 —— 之前的沙箱测试全是简单字符串。
import { createDoubaoShim } from '../lib/index.js'
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'

const DIR = 'E:/tmp/dsh-edit-test'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

const TARGET = `${DIR}/app.py`
const ORIGINAL = `def greet(name):
    print("Hello, " + name)

greet("world")
`
writeFileSync(TARGET, ORIGINAL, 'utf8')

// 真实 DSH edit 工具的 schema（精简但保留关键形状）
const tools = [{
  type: 'function',
  function: {
    name: 'edit',
    description: '把文件里的 old_string 替换成 new_string，old_string 必须唯一出现',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
}, {
  type: 'function',
  function: {
    name: 'read_file',
    description: '读取文件全部内容',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
}]

const shim = createDoubaoShim({ toolEmulation: () => true })
const base = await shim.baseUrl()

async function turn(messages) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${shim.token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: '0', stream: true, messages, tools }),
  })
  const reader = res.body.getReader(), dec = new TextDecoder()
  let buf = '', content = '', finish = '', calls = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2)
      if (!raw.startsWith('data: ')) continue
      const data = raw.slice(6)
      if (data === '[DONE]') continue
      let j; try { j = JSON.parse(data) } catch { continue }
      const choice = j.choices?.[0] ?? {}
      const d = choice.delta ?? {}
      if (d.content) content += d.content
      for (const tc of d.tool_calls ?? []) {
        const slot = calls[tc.index] ?? (calls[tc.index] = { id: '', name: '', arguments: '' })
        if (tc.id) slot.id = tc.id
        if (tc.function?.name) slot.name += tc.function.name
        if (tc.function?.arguments) slot.arguments += tc.function.arguments
      }
      if (choice.finish_reason) finish = choice.finish_reason
    }
  }
  return { content, finish, calls: calls.filter(Boolean) }
}

function applyEdit(call) {
  const args = JSON.parse(call.arguments)
  const src = readFileSync(args.file_path, 'utf8')
  const count = src.split(args.old_string).length - 1
  if (count !== 1) return `ERROR: old_string 出现 ${count} 次，必须唯一`
  writeFileSync(args.file_path, src.replace(args.old_string, args.new_string), 'utf8')
  return `OK: 已替换 1 处`
}

// 契约要求「每次修改后重新读取」，所以 read_file 必须真的实现 ——
// 否则那条规则无法执行，模型会一直撞「未知工具」。
function applyRead(call) {
  const args = JSON.parse(call.arguments)
  return `OK:\n${readFileSync(args.path, 'utf8')}`
}

const messages = [
  { role: 'system', content: `工作目录是 ${DIR}。你可以用 edit 工具修改文件。` },
  { role: 'user', content: `把 ${TARGET} 里的 greet 函数改成接收 greeting 参数并带默认值 "你好"，另外在文件末尾加一行调用 greet("小明", "早上好")。改完告诉我你具体改了什么。` },
]

let applied = 0, bad = 0, malformed = []
for (let step = 0; step < 6; step++) {
  const r = await turn(messages)
  if (r.calls.length === 0) {
    console.log(`\n[第 ${step + 1} 轮] 无工具调用，收尾：`)
    console.log(r.content.slice(0, 400))
    break
  }
  for (const call of r.calls) {
    let result
    try {
      result = call.name === 'edit' ? applyEdit(call)
        : call.name === 'read_file' ? applyRead(call)
          : 'ERROR: 未知工具'
    } catch (e) {
      bad++
      malformed.push(call.arguments)
      result = `ERROR: 参数不是合法 JSON（${e.message}）`
    }
    if (call.name === 'edit' && !result.startsWith('ERROR')) applied++
    const brief = result.slice(0, 70).replace(/\s+/g, ' ')
    console.log(`[第 ${step + 1} 轮] ${call.name} → ${brief}`)
    messages.push({ role: 'assistant', content: r.content || ' ', tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }] })
    messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: result })
  }
}

console.log('\n===== 结果 =====')
console.log('成功编辑:', applied, '| 坏 JSON:', bad)
if (bad > 0) {
  console.log('失败样本:')
  for (const raw of malformed.slice(0, 2)) console.log('  ', raw.slice(0, 300))
}
const after = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : ''
console.log('文件是否被改动:', after !== ORIGINAL ? '是' : '否')
console.log('--- 最终内容 ---')
console.log(after)
await shim.close()

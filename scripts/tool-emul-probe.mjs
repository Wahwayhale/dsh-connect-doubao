// 提示词层工具调用模拟 —— 最小闭环实测（量化版）。
// 契约：模型需要调用工具时，输出一个 ```doubao-tool 围栏，内含一个 JSON：
//   {"name":"write_file","arguments":{"path":"...","content":"..."}}
// 本脚本解析并真实执行，然后把结果作为 [tool result] 消息回给模型，直到它不再调用。
// 目的：用数据回答「豆包当 driver 靠不靠谱」，不是最终实现。
import { createDoubaoShim } from '../lib/index.js'
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'

const SANDBOX = 'E:/tmp/dsh-tool-test'
rmSync(SANDBOX, { recursive: true, force: true })
mkdirSync(SANDBOX, { recursive: true })

const CONTRACT = [
  '你可以通过调用工具在这台机器上读写文件。可用工具：',
  '- read_file(path: string)：返回该文件的文本内容',
  '- write_file(path: string, content: string)：把 content 写入 path（覆盖）',
  '',
  '需要调用工具时：只输出一个 ```doubao-tool 代码围栏，里面放恰好一个 JSON 对象：',
  '{"name":"<工具名>","arguments":{...}}',
  '不要在同一轮输出多个调用。系统会执行并把结果以 [tool result] 开头的消息回给你，',
  '然后你继续推进任务。任务完成时不要输出围栏，直接给出简短总结。',
  `所有路径必须在 ${SANDBOX} 之下。`,
].join('\n')

const TOOL_RE = /```doubao-tool\s*\n([\s\S]*?)```/

function exec(call) {
  if (call.name === 'read_file') {
    const p = String(call.arguments?.path ?? '')
    if (!p.startsWith(SANDBOX) || !existsSync(p)) return `ERROR: cannot read ${p}`
    return readFileSync(p, 'utf8')
  }
  if (call.name === 'write_file') {
    const p = String(call.arguments?.path ?? '')
    if (!p.startsWith(SANDBOX)) return `ERROR: path outside sandbox`
    const content = String(call.arguments?.content ?? '')
    writeFileSync(p, content, 'utf8')
    return `OK: wrote ${Buffer.byteLength(content)} bytes to ${p}`
  }
  return `ERROR: unknown tool ${call.name}`
}

const shim = createDoubaoShim()
const base = await shim.baseUrl()

async function ask(messages) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${shim.token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: '0', stream: false, messages }),
  })
  const j = await res.json()
  return j.choices?.[0]?.message?.content ?? '__ERR__ ' + JSON.stringify(j).slice(0, 200)
}

let dup = 0
async function runTask(label, userTask, maxSteps) {
  const messages = [
    { role: 'system', content: CONTRACT },
    { role: 'user', content: userTask },
  ]
  let calls = 0, bad = 0, done = false
  let lastSig = ''
  const t0 = Date.now()
  for (let step = 0; step < maxSteps; step++) {
    const reply = await ask(messages)
    messages.push({ role: 'assistant', content: reply })
    const m = reply.match(TOOL_RE)
    if (!m) { done = true; break }
    calls++
    let call
    try {
      call = JSON.parse(m[1])
    } catch {
      bad++
      messages.push({ role: 'user', content: '[tool result] ERROR: 围栏内不是合法 JSON' })
      continue
    }
    const sig = call.name + JSON.stringify(call.arguments ?? {})
    if (sig === lastSig) {
      // 重复调用是这套方案的主要失败模式（没有原生 stop），记数并推它收敛
      dup++
      messages.push({ role: 'user', content: '[tool result] （与上一次调用完全相同，已跳过。请直接继续或给出总结。）' })
      continue
    }
    lastSig = sig
    const result = exec(call)
    const brief = String(result).slice(0, 50).replace(/\s+/g, ' ')
    console.log(`  [${label}] step${step + 1} ${call.name}(${call.arguments?.path ?? ''}) -> ${brief}`)
    messages.push({ role: 'user', content: `[tool result] ${result}` })
  }
  return { label, calls, bad, done, secs: Number(((Date.now() - t0) / 1000).toFixed(1)) }
}

const TASKS = [
  [`在 ${SANDBOX}/r1.txt 写入内容 "TOOL-EMUL-OK-7742"，然后告诉我完成。`, 4],
  [`先在 ${SANDBOX}/fib.py 写一个计算第 n 项斐波那契数列的函数，然后读回这个文件，最后用一句话总结文件内容。`, 6],
  [`写一个 ${SANDBOX}/calc.py，包含 add(a,b) 和 mul(a,b) 两个函数；写完读回确认，然后总结。`, 6],
]

const results = []
for (const [task, maxSteps] of TASKS) {
  const r = await runTask(`T${results.length + 1}`, task, maxSteps)
  results.push(r)
  console.log(JSON.stringify(r))
}

const sum = (k) => results.reduce((a, r) => a + r[k], 0)
console.log('---- 汇总 ----')
console.log(`轮数 ${results.length} | 工具调用 ${sum('calls')} 次 | 坏 JSON ${sum('bad')} | 重复调用 ${dup} | 正常收敛 ${results.filter((r) => r.done).length}/${results.length} | 平均 ${(sum('secs') / results.length).toFixed(1)}s/轮`)
console.log('落盘: ' + ['r1.txt', 'fib.py', 'calc.py'].map((f) => `${f}=${existsSync(`${SANDBOX}/${f}`) ? 'Y' : 'N'}`).join(' '))
const r1 = existsSync(`${SANDBOX}/r1.txt`) ? readFileSync(`${SANDBOX}/r1.txt`, 'utf8') : ''
console.log('内容校验 r1.txt: ' + JSON.stringify(r1.slice(0, 40)))
await shim.close()
console.log('DONE')

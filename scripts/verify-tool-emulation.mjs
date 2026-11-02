// 端到端：开启工具模拟后，走 shim 的 OpenAI 接口能否拿到标准 tool_calls。
//
// 注意范围：本脚本验证的是 **协议链路**（工具清单有没有进提示词、回复围栏有没
// 有被解析成标准 tool_calls、回填结果后能否续到结论）。它**不执行**任何工具 —
// 第 2 轮喂的是写死的假结果。真实执行在 DSH 宿主侧，由 Harness 负责。
import { createDoubaoShim } from '../lib/index.js'

const shim = createDoubaoShim({ toolEmulation: () => true })
const base = await shim.baseUrl()

const tools = [{
  type: 'function',
  function: {
    name: 'write_file',
    description: '把文本内容写入本机指定路径的文件',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
}]

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

console.log('--- 第 1 轮：期望模型请求调用工具 ---')
const messages = [{ role: 'user', content: '请用工具把字符串 TOOL-EMUL-LIVE-913 写入 E:/tmp/dsh-tool-test/live.txt，然后告诉我完成。' }]
const r1 = await turn(messages)
console.log('finish_reason:', r1.finish)
console.log('可见文本:', JSON.stringify(r1.content.slice(0, 80)))
console.log('tool_calls:', JSON.stringify(r1.calls, null, 1))

if (r1.calls.length > 0) {
  console.log('--- 第 2 轮：回填工具结果，期望它给出结论 ---')
  const call = r1.calls[0]
  messages.push({
    role: 'assistant',
    content: r1.content || ' ',
    tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }],
  })
  messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: 'OK: wrote 18 bytes' })
  const r2 = await turn(messages)
  console.log('finish_reason:', r2.finish)
  console.log('回复:', JSON.stringify(r2.content.slice(0, 140)))
  console.log('是否泄漏围栏:', /doubao-tool/.test(r2.content) ? '是（有问题）' : '否')
}

await shim.close()

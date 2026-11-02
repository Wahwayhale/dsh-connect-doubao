// 端到端：走 shim 的 OpenAI 接口选「豆包 生图」，把结果落到本地文件。
import { createDoubaoShim } from '../lib/index.js'
import { writeFileSync } from 'node:fs'

const shim = createDoubaoShim()
const base = await shim.baseUrl()

const res = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${shim.token()}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'image-gen',
    stream: true,
    messages: [{ role: 'user', content: '一座未来主义的海上城市，黄昏，电影感光照' }],
  }),
})

const reader = res.body.getReader()
const dec = new TextDecoder()
let buf = '', content = '', reasoning = 0
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
    let j
    try { j = JSON.parse(data) } catch { continue }
    const d = j.choices?.[0]?.delta ?? {}
    if (d.content) content += d.content
    if (d.reasoning_content) reasoning += d.reasoning_content.length
  }
}

console.log('HTTP:', res.status)
console.log('正文字数:', content.length, '| 思考字数:', reasoning)
const urls = [...content.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/g)].map((m) => m[1])
console.log('解析到图片:', urls.length)
console.log('文本部分:', content.replace(/!\[[^\]]*\]\([^)]+\)/g, '').trim().slice(0, 120))

let saved = 0
for (const [n, url] of urls.entries()) {
  try {
    const img = await fetch(url)
    if (!img.ok) { console.log(`  #${n + 1} 下载失败 HTTP ${img.status}`); continue }
    const bytes = Buffer.from(await img.arrayBuffer())
    const out = `E:/tmp/doubao-gen-${n + 1}.jpg`
    writeFileSync(out, bytes)
    console.log(`  #${n + 1} 已保存 ${out} (${(bytes.length / 1024).toFixed(0)} KB)`)
    saved++
  } catch (e) { console.log('  下载异常:', e.message) }
}
console.log('RESULT: 生图', urls.length, '张，本地落盘', saved, '张')
await shim.close()

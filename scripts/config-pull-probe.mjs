// 探测 /alice/user/config/pull：能否拿到 menuConfV2（模型清单的权威来源）。
// 配置端点不消耗推理额度。
import { loadDoubaoCredentials, buildHeaders, buildQueryUrl } from '../lib/index.js'

const CONFIG_ENDPOINT = 'https://www.doubao.com/alice/user/config/pull'
const creds = loadDoubaoCredentials()
if (!creds.ok) { console.log('凭据不可用:', creds.reason); process.exit(1) }

async function pull(objects) {
  const res = await fetch(buildQueryUrl(CONFIG_ENDPOINT, creds.pairs.get('msToken')), {
    method: 'POST',
    headers: buildHeaders(creds, { 'content-type': 'application/json' }),
    body: JSON.stringify({ objects, reason: 'plugin_discovery', extra: '' }),
  })
  const text = await res.text()
  console.log(`objects=${JSON.stringify(objects)} -> HTTP ${res.status}, ${text.length} 字节`)
  return text
}

for (const objects of [['menuConfV2'], ['menuConfV2', 'model_list'], ['model_list']]) {
  const text = await pull(objects)
  if (!text.trim().startsWith('{')) continue
  let j
  try { j = JSON.parse(text) } catch { continue }
  const data = j.data ?? j
  const keys = Object.keys(data)
  console.log('  data keys:', keys.join(', ').slice(0, 200))
  const confRaw = data.menuConfV2 ?? data.model_list
  if (typeof confRaw === 'string') {
    try {
      const conf = JSON.parse(confRaw)
      const list = conf.model_list?.item_list ?? conf.item_list
      console.log('  model_list 条目数:', Array.isArray(list) ? list.length : 'n/a')
      if (Array.isArray(list)) {
        for (const m of list.slice(0, 12)) {
          console.log(`   key=${m.model_item_key} name=${m.name} badge=${(m.tag_list ?? []).map((t) => t.text).join('/')} login=${m.need_login}`)
        }
      }
      break
    } catch (e) { console.log('  解析内层失败:', e.message) }
  }
}

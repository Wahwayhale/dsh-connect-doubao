// Which Cordis service names does a host package provide? These are the names a
// plugin may declare in its own `inject` array.
import { readFileSync } from 'node:fs'

const A = 'E:/deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/'
const targets = ['dsh-llm', 'dsh-host-webserver', 'dsh-settings', 'dsh-client-ui-slots', 'dsh-client-ui-settings-plugins', 'dsh-client-locale']

for (const t of targets) {
  let s
  try {
    s = readFileSync(A + t + '/lib/index.js', 'utf8')
  } catch (e) {
    console.log(`${t}: cannot read (${e.code})`)
    continue
  }
  const services = new Set()
  for (const m of s.matchAll(/super\(\s*ctx\s*,\s*["'`]([^"'`]+)["'`]\s*\)/g)) services.add(m[1])
  // Plugin-level inject declarations, if any.
  const injects = new Set()
  for (const m of s.matchAll(/inject\s*[:=]\s*\[([^\]]*)\]/g)) {
    for (const q of m[1].matchAll(/["'`]([^"'`]+)["'`]/g)) injects.add(q[1])
  }
  console.log(`${t}:`)
  console.log(`  provides services: ${JSON.stringify([...services])}`)
  if (injects.size) console.log(`  declares inject:    ${JSON.stringify([...injects])}`)
}
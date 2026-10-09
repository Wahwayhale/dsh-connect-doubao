// Does the host asar contain a node_modules tree the loader can resolve from?
// Walk the asar virtual directory tree directly.
import { readdirSync, statSync, existsSync } from 'node:fs'

const ROOT = 'E:/deepseek/resources/app.asar/dsh/node_modules'
console.log(`exists ${ROOT} -> ${existsSync(ROOT)}`)

function ls(p, depth = 0) {
  try {
    const entries = readdirSync(p, { withFileTypes: true })
    return entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name))
  } catch (e) {
    return [`<cannot read: ${e.code}>`]
  }
}

console.log('top level:', ls(ROOT).slice(0, 40).join(' '))
for (const scope of ['@deepseek-ai', '@earendil-works']) {
  const p = `${ROOT}/${scope}`
  const names = ls(p)
  console.log(`\n${scope} (${names.length}):`)
  console.log(names.filter((n) => /^(dsh-llm|dsh-host-webserver|dsh-client|pi-ai|pi-telemetry|cordis)/.test(n)).join(' '))
}
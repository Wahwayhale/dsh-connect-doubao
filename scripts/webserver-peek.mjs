// Inspect the host webServer plugin: how routes are registered and mounted.
import { readFileSync, readdirSync } from 'node:fs'

const ASAR = 'E:/deepseek/resources/app.asar/dsh/node_modules/'
const pkg = JSON.parse(readFileSync(ASAR + '@deepseek-ai/dsh-host-webserver/package.json', 'utf8'))
console.log('=== package.json ===')
console.log(JSON.stringify({ name: pkg.name, version: pkg.version, main: pkg.main, exports: pkg.exports, dependencies: pkg.dependencies }, null, 2))

function listDir(dir, depth = 0) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = dir + '/' + e.name
      if (e.isDirectory()) {
        if (depth < 2) listDir(full, depth + 1)
      } else if (/\.(js|mjs|ts)$/.test(e.name)) {
        console.log(`${String(readFileSync(full).length).padStart(8)}  ${full.replace(ASAR, '')}`)
      }
    }
  } catch (err) {
    console.log(`  (cannot read ${dir}: ${err.code})`)
  }
}
console.log('\n=== files ===')
listDir(ASAR + '@deepseek-ai/dsh-host-webserver')
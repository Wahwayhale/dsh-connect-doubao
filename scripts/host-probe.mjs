// Probe host runtime packages. Run with Electron-as-node so fs has asar support:
//   set ELECTRON_RUN_AS_NODE=1
//   "E:\deepseek\DeepSeek Harness.exe" scripts\host-probe.mjs
import { readFileSync } from 'node:fs'

const ASAR = 'E:/deepseek/resources/app.asar/dsh/node_modules/'

const want = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-telemetry',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/cordis',
]

console.log(`electron ${process.versions.electron ?? '(not electron)'}  node ${process.versions.node}`)
console.log(`asar readable: ${(() => { try { readFileSync(ASAR + 'package.json'); return 'yes' } catch { return 'no' } })()}\n`)

for (const name of want) {
  try {
    const j = JSON.parse(readFileSync(ASAR + name + '/package.json', 'utf8'))
    console.log(`FOUND   ${name}@${j.version}`)
  } catch (e) {
    console.log(`MISSING ${name}  (${e.code ?? e.message})`)
  }
}
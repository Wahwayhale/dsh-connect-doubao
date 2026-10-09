/**
 * Which slot names does each shipped client bundle register, and what does the
 * host actually provide? Read-only.
 */
import { readFileSync } from 'node:fs'

const FILES = {
  doubao: 'E:/project/新建文件夹/dsh-connect-doubao/lib/client.js',
  workbuddy: 'C:/Users/35498/.dsh/profiles/desktop/node_modules/dsh-connect-workbuddy/lib/client.js',
  trae: 'C:/Users/35498/.dsh/profiles/desktop/node_modules/dsh-connect-trae/lib/client.js',
}

for (const [label, file] of Object.entries(FILES)) {
  const s = readFileSync(file, 'utf8')
  const slots = [...new Set([...s.matchAll(/plugins\.[a-z]+(?:\.[a-zA-Z]+)+/g)].map(m => m[0]))]
  const keys = [...new Set([...s.matchAll(/"(dsh-[a-z-]+(?:#dsh-[a-z-]+)?)"/g)].map(m => m[1]))]
  console.log(`\n=== ${label} ===`)
  console.log('  slots:', JSON.stringify(slots))
  console.log('  slot keys:', JSON.stringify(keys))
}

// What slot names does the HOST's own frontend know about?
const shell = readFileSync(
  'E:/deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-5SrrfWpU.js',
  'utf8')
const hostSlots = [...new Set([...shell.matchAll(/plugins\.[a-z]+(?:\.[a-zA-Z]+)+/g)].map(m => m[0]))]
console.log('\n=== host frontend slot names ===')
console.log(JSON.stringify(hostSlots, null, 2))
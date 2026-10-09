/**
 * How does the host turn `settings.section` registrations into nav rows?
 * Print the useSections / nav-row construction in the settings-general client.
 *
 * Read-only.
 */
import { readFileSync } from 'node:fs'

const F = 'E:/deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js'
const s = readFileSync(F, 'utf8')

for (const needle of ['useSections', 'settings.section', 'label', 'order']) {
  let i = s.indexOf(needle)
  if (i < 0) continue
  console.log(`\n${'='.repeat(72)}\n### "${needle}" first @ ${i}\n${'='.repeat(72)}`)
  console.log(s.slice(Math.max(0, i - 900), i + 900))
}

// The registration descriptor shape: show every place a row object is built
// from a slot entry.
const rows = [...s.matchAll(/\{[^{}]{0,200}\bid\s*:[^{}]{0,200}\blabel\s*:/g)]
console.log(`\n\n=== row-shaped objects: ${rows.length} ===`)
for (const m of rows.slice(0, 6)) {
  console.log('\n---\n' + m[0].replace(/\s+/g, ' ').slice(0, 300))
}
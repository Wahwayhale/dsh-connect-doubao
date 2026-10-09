/**
 * Print the exact `settings.section` registration from a plugin that provably
 * shows up in the settings nav, so ours matches the host's contract.
 *
 * Read-only.
 */
import { readFileSync } from 'node:fs'

const NM = 'C:/Users/35498/.dsh/profiles/desktop/node_modules/'
const TARGETS = [
  ['专家团', NM + '@yangdcm/dsh-expert-team/client.js'],
  ['XD Pool', NM + 'dsh-workbuddy-xdpool/client.js'],
  ['侧边卡片', NM + 'dsh-better-sidebar/lib/client.js'],
]

for (const [label, file] of TARGETS) {
  const s = readFileSync(file, 'utf8')
  console.log(`\n${'='.repeat(72)}\n### ${label}  (${file.replace(NM, '')})\n${'='.repeat(72)}`)
  let from = 0
  let shown = 0
  while (shown < 3) {
    const i = s.indexOf('settings.section', from)
    if (i < 0) break
    // Show the enclosing registration call, not just the token.
    const start = Math.max(0, s.lastIndexOf('register(', i))
    const sliceStart = start > i - 900 ? start : Math.max(0, i - 900)
    console.log(`\n--- occurrence @ ${i} ---`)
    console.log(s.slice(sliceStart, i + 700))
    from = i + 1
    shown++
  }
}
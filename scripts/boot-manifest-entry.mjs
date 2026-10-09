/**
 * Pull OUR entry out of the host's `__DSH_BOOT__` manifest and compare it to
 * workbuddy's, field by field. This is what the shell actually uses to order
 * and gate client plugin loading.
 */
const token = process.argv[2]
const base = process.argv[3] ?? 'http://127.0.0.1:19413'
const html = await (await fetch(`${base}/?token=${token}`)).text()

const at = html.indexOf('globalThis["__DSH_BOOT__"] = ')
if (at < 0) throw new Error('__DSH_BOOT__ not found')
const start = html.indexOf('{', at)
// Balanced-brace scan for the JSON object.
let depth = 0
let end = -1
for (let i = start; i < html.length; i++) {
  const ch = html[i]
  if (ch === '{') depth++
  else if (ch === '}') {
    depth--
    if (depth === 0) { end = i + 1; break }
  }
}
const boot = JSON.parse(html.slice(start, end))
const entries = boot.entries ?? []

console.log(`total boot entries: ${entries.length}`)
console.log(`top-level keys: ${Object.keys(boot).join(', ')}`)

const pick = id => entries.find(e => e.id === id)

for (const id of ['dsh-connect-doubao', 'dsh-connect-workbuddy', 'dsh-connect-trae']) {
  const e = pick(id)
  console.log(`\n=== ${id} ===`)
  if (e === undefined) {
    console.log('  ABSENT from the boot manifest')
    continue
  }
  console.log(JSON.stringify(e, null, 2).split('\n').map(l => '  ' + l).join('\n'))
}

// Is `configForms` itself a boot entry (i.e. a plugin id), and which entries
// inject it?
const providers = entries.filter(e => (e.inject ?? []).includes('@deepseek-ai/dsh-client-ui-settings'))
console.log(`\nentries injecting @deepseek-ai/dsh-client-ui-settings: ${providers.length}`)
for (const p of providers.slice(0, 8)) console.log(`  ${p.id}  immediately=${p.immediately ?? false}`)

console.log('\n=== position of doubao vs workbuddy in the manifest ===')
const di = entries.findIndex(e => e.id === 'dsh-connect-doubao')
const wi = entries.findIndex(e => e.id === 'dsh-connect-workbuddy')
console.log(`  doubao    index=${di} of ${entries.length}`)
console.log(`  workbuddy index=${wi} of ${entries.length}`)
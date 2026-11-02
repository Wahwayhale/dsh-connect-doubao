// Verify the built locale strings render real Windows paths, not collapsed escapes.
//
// The source uses single-quoted TS literals, so `'Default\Network\Cookies'`
// would be `DefaultNetworkCookies` at runtime. Doubling the backslash in the
// source is correct only if the built artifact carries `\\` all the way to the
// browser, so this checks the bundle the browser actually loads.
import { readFileSync } from 'node:fs'

const bundle = readFileSync('lib/client.js', 'utf8')

/** Pull one `"key": "literal"` out of the bundle and decode it like JS would. */
function literalOf(key) {
  const marker = `"${key}": `
  const at = bundle.indexOf(marker)
  if (at < 0) throw new Error(`${key} missing from the bundle`)
  let index = at + marker.length
  if (bundle[index] !== '"') throw new Error(`${key} is not a string literal`)
  index += 1
  let out = ''
  while (index < bundle.length) {
    const ch = bundle[index]
    if (ch === '\\') {
      // Decode the escape exactly as a JS engine would for the forms we emit.
      const next = bundle[index + 1]
      out += next === 'n' ? '\n' : next
      index += 2
      continue
    }
    if (ch === '"') return out
    out += ch
    index += 1
  }
  throw new Error(`${key} is unterminated`)
}

const failures = []

function expectContains(key, needle) {
  const value = literalOf(key)
  if (!value.includes(needle)) {
    failures.push(`${key}: expected to contain ${JSON.stringify(needle)}, got ${JSON.stringify(value)}`)
  }
}

// Both locales must keep the separator in the Windows path they quote.
expectContains('profile.invalid', 'Default\\Network\\Cookies')
expectContains('profile.hint', '%LOCALAPPDATA%\\Doubao\\User Data')

// The collapsed form is the bug this guards against.
for (const key of ['profile.invalid', 'profile.hint']) {
  if (literalOf(key).includes('DefaultNetworkCookies')) {
    failures.push(`${key}: backslashes collapsed to "DefaultNetworkCookies"`)
  }
}

if (failures.length > 0) {
  console.error('locale literals are wrong:')
  for (const line of failures) console.error(`  - ${line}`)
  process.exit(1)
}

console.log('locale literals keep their backslashes')

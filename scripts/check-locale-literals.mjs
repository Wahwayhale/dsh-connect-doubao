// Verify the built locale table survived the bundler intact.
//
// This check used to quote two Windows-path strings and assert their backslashes
// had not been collapsed (`Default\\Network\\Cookies` arriving as
// `DefaultNetworkCookies`). Those strings belonged to the client-cookie path and
// are gone, so the guard was generalised rather than dropped: EVERY literal in
// the built bundle must survive a decode/re-encode round-trip unchanged, which is
// the same property — the bundler must not eat an escape level — for any string,
// and the collapsed-path signature is still rejected by name in case a Windows
// path ever comes back.
//
// The bundle, not the source, is checked on purpose: the source is what the
// author wrote, the bundle is what the browser actually parses.
import { readFileSync } from 'node:fs'

const bundle = readFileSync('lib/client.js', 'utf8')

/** One `"key.name": "literal"` pair. Card keys are dotted, values are strings. */
const PAIR = /"([a-z][\w]*\.[\w.]+)": ("(?:[^"\\\n]|\\.)*")/g

/** Keys whose absence means the scan matched the wrong artifact entirely. */
const REQUIRED_KEYS = ['card.title', 'auth.relogin', 'quota.weekly', 'models.title']

/** Signatures of a path whose separators were collapsed to nothing. */
const COLLAPSED_PATHS = ['DefaultNetworkCookies', '%LOCALAPPDATA%Doubao']

const failures = []
const counts = new Map()

for (const match of bundle.matchAll(PAIR)) {
  const [, key, literal] = match
  counts.set(key, (counts.get(key) ?? 0) + 1)

  let decoded
  try {
    decoded = JSON.parse(literal)
  } catch {
    failures.push(`${key}: literal is not decodable JSON: ${literal.slice(0, 80)}`)
    continue
  }

  if (JSON.stringify(decoded) !== literal) {
    failures.push(
      `${key}: literal changes on re-encode (${literal} -> ${JSON.stringify(decoded)})`,
    )
  }

  for (const signature of COLLAPSED_PATHS) {
    if (decoded.includes(signature)) failures.push(`${key}: windows path collapsed to ${signature}`)
  }
}

for (const key of REQUIRED_KEYS) {
  if (!counts.has(key)) failures.push(`${key} missing from the bundle`)
}

// One table per language, so every key must appear at least twice. A key in only
// one table renders as its own name in the other language.
for (const [key, count] of counts) {
  if (count < 2) failures.push(`${key}: only ${String(count)} table(s) carry it, expected zh + en`)
}

// A regex that silently stops matching would make every rule above pass for the
// wrong reason, so the scan has to show it found the whole table.
if (counts.size < 40) {
  failures.push(`only ${String(counts.size)} locale keys found in lib/client.js, expected 40+`)
}

if (failures.length > 0) {
  console.error('locale literals are wrong:')
  for (const line of failures) console.error(`  - ${line}`)
  process.exit(1)
}

console.log(`locale literals round-trip cleanly (${String(counts.size)} keys, zh + en)`)

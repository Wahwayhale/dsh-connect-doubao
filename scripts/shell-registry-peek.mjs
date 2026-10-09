/**
 * Transcribe the module registry the DSH shell passes to `__ModuleLoader__`.
 *
 * The shell registers shared modules so a plugin bundle can `require` them
 * instead of inlining them. An external that is NOT registered resolves to
 * nothing at runtime, so this list decides what is legal to externalize.
 *
 * Source: `rM()` in `@deepseek-ai/dsh-web-frontend/dist/assets/index-*.js`.
 */
import { readdirSync, readFileSync } from 'node:fs'

const ASAR = 'E:/deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/'
const pkgRoot = ASAR + 'dsh-web-frontend/dist/assets/'

function ls(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

// Find the built web frontend bundle inside the asar virtual FS.
const candidates = []
for (const scope of ['dsh-web-frontend', 'dsh-web-app']) {
  for (const sub of ['dist/assets', 'assets', 'dist']) {
    for (const name of ls(ASAR + scope + '/' + sub)) {
      if (/^index-.*\.js$/.test(name) || name === 'index.js') candidates.push(ASAR + scope + '/' + sub + '/' + name)
    }
  }
}
console.log('candidate bundles:')
for (const c of candidates) console.log('  ' + c)

for (const file of candidates) {
  let s
  try {
    s = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const i = s.search(/staticModules|__ModuleLoader__\.create/)
  if (i < 0) continue
  console.log('\n=== ' + file + ' (len ' + s.length + ') ===')
  console.log(s.slice(Math.max(0, i - 2200), i + 1200))
  break
}
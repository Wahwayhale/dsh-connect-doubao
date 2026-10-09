/**
 * Validate the awesome-dsh-plugin submission YAML: it must parse, and it must
 * satisfy the hard rules from MARKET-SUBMISSION.md §2.2.
 *
 * No YAML dependency — a focused check of the things that actually bite:
 *   * parses as YAML
 *   * `url` present and https
 *   * `name` is `<owner>/<repo>` and matches the url's owner/repo (R1)
 *   * `category` is in the allowed set
 *   * `description.en` present and ends with a period
 *   * every value containing ": " is quoted (the documented parser trap)
 *   * the file name and every value name the real repository, with no placeholders
 */
import { readFileSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve the repo root from THIS SCRIPT's own location rather than an absolute
// path: a hardcoded path makes the script throw ENOENT for anyone who clones the
// repository anywhere else, which is every consumer of the published package.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = join(ROOT, 'awesome-dsh-plugin-submission', 'Wahwayhale__dsh-connect-doubao.yml')
/** Expected owner/repo. The file NAME must carry it, joined by a DOUBLE underscore. */
const OWNER = 'Wahwayhale'
const REPO = 'dsh-connect-doubao'
const raw = readFileSync(FILE, 'utf8')

const checks = []
const ok = (name, pass, detail = '') => checks.push({ name, pass, detail })

// --- 1. YAML parses (structural check via a minimal key: value walk) --------
// Strip inline comments and blank lines first: a trailing `# note` is valid YAML
// but would otherwise be read as part of the value and fail every strict check
// below (that is how an earlier draft of this file produced four false FAILs).
const contentLines = raw.split('\n').map(line => {
  if (line.trim().startsWith('#')) return ''
  // Remove a trailing comment that is preceded by whitespace and not inside quotes.
  return line.replace(/\s+#(?![^'"]*$).*$/, '')
}).filter(line => line.trim() !== '')
const clean = contentLines.join('\n')

const topKeys = [...clean.matchAll(/^([a-z_]+):\s*(.*)$/gm)].map(m => [m[1], m[2].trim()])
const map = Object.fromEntries(topKeys)
ok('top-level keys parsed', topKeys.length >= 4, `found: ${topKeys.map(([k]) => k).join(', ')}`)

const unquote = (v) => {
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) return v.slice(1, -1)
  return v
}
// Every scalar may be quoted, so unquote BEFORE the format checks — otherwise a
// correctly quoted URL fails a regex that expects a bare one.
const url = unquote(map.url ?? '')
const name = unquote(map.name ?? '')
const category = unquote(map.category ?? '')

ok('url present', url.startsWith('https://'), url)
ok('url is a github repo URL', /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(url), url)
ok('name is <owner>/<repo>', /^[^/]+\/[^/]+$/.test(name), name)

const urlPath = url.replace('https://github.com/', '')
ok('R1: name matches url owner/repo', name === urlPath, `name="${name}" vs url="${urlPath}"`)

const ALLOWED = new Set(['agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory',
  'tools', 'wsl', 'browser', 'vision', 'voice', 'docs', 'skill', 'workflow', 'git', 'notify',
  'dev', 'security', 'remote', 'market', 'fun'])
ok('category is in the allowed set', ALLOWED.has(category), category)
ok('category is `model`', category === 'model', category)

// --- 2. description block ---------------------------------------------------
const descBlock = /description:\n((?:\s{2,}.*\n?)+)/.exec(clean)
ok('description block present', descBlock !== null)
const unquote2 = unquote
const desc = {}
if (descBlock) {
  for (const m of descBlock[1].matchAll(/^\s+(en|zh):\s*(.*)$/gm)) desc[m[1]] = m[2].trim()
}
ok('description.en present (the only required one)', typeof desc.en === 'string' && desc.en.length > 0, desc.en ?? '(missing)')

const enValue = unquote(desc.en ?? '')

// The period rule applies to the VALUE, not to the closing quote character.
ok('description.en ends with a period', enValue.endsWith('.'), enValue)
const zhValue = unquote(desc.zh ?? '')
ok('description.en contains no ": " (so quoting is not load-bearing)', !enValue.includes(': '), enValue)
ok('description.en has no marketing words',
  !/\b(free|amazing|best|powerful|revolutionary|seamless)\b/i.test(enValue), enValue)
ok('description.en has no leading/trailing space', enValue === enValue.trim(), enValue)
ok('description.zh present (optional)', typeof desc.zh === 'string' && desc.zh.length > 0, zhValue)

// --- 3. quoting trap: any value with ": " must be quoted --------------------
const badQuoting = []
for (const line of clean.split('\n')) {
  const m = /^([a-z_]+):\s*(.+)$/.exec(line)
  if (m === null) continue
  const value = m[2].trim()
  if (value === '' || value.startsWith('#')) continue
  const quoted = (value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))
  // Quoting any value containing ": " is mandatory; these two are quoted even
  // though they do not need it, which is fine and always safe.
  if (value.includes(': ') && !quoted) badQuoting.push(line)
}
ok('every value containing ": " is quoted', badQuoting.length === 0, badQuoting.join(' | '))

// A URL inside an unquoted scalar would otherwise parse as a comment host.
ok('url is quoted (protects against trailing-comment misreads)', /^url:\s*["']/.test(clean), '')

// --- 4. identity: the file NAME and the values must name the real repo -------
// The submission path is data/plugins/<owner>__<repo>.yml, so the file name is
// part of the contract, not decoration.
// `basename` rather than a split on '/': on Windows `join` produces backslashes,
// and the old split then returned the whole path and failed the check.
const fileName = basename(FILE)
ok('file name is <owner>__<repo>.yml (double underscore)',
  fileName === `${OWNER}__${REPO}.yml`, fileName)
ok('url names the expected repository', url === `https://github.com/${OWNER}/${REPO}`, url)
ok('name is <owner>/<repo>', name === `${OWNER}/${REPO}`, name)

// --- 5. no placeholders remain -----------------------------------------------
// Inverted from the previous run: once the owner is known, ANY leftover TODO is
// a defect, not something to report.
const leftovers = [...clean.matchAll(/\bTODO[A-Z-]*|\bTODO\b/g)].map(m => m[0])
ok('no TODO placeholders remain anywhere in the file', leftovers.length === 0,
  leftovers.length === 0 ? '' : [...new Set(leftovers)].join(', '))

console.log('=== submission YAML validation ===')
console.log(`file: ${FILE}`)
for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`)
const failed = checks.filter(c => !c.pass)
console.log(failed.length === 0 ? '\nOK: submission draft is structurally valid.' : `\n${failed.length} FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
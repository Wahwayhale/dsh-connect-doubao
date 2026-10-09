/**
 * Static trace of `modelKey` from the CLI flag to the wire.
 *
 * No network, no credentials, no Doubao. It parses each source file, extracts
 * the real function bodies, and checks that `modelKey` / `model.id` reaches
 * `option.model_config.model_item_key` and
 * `option.aggregate_params.model_item_key` without being dropped, renamed or
 * coerced on the way.
 *
 * Usage: node trace-modelkey.mjs   (run from the project root)
 */
import { readFileSync } from 'node:fs'

const FILES = {
  'cli-probe.ts': 'src/cli-probe.ts',
  'doubao-upstream.ts': 'src/doubao-upstream.ts',
  'doubao-catalog.ts': 'src/doubao-catalog.ts',
  'doubao-shim.ts': 'src/doubao-shim.ts',
  'doubao-adapter.ts': 'src/doubao-adapter.ts',
}

const src = Object.fromEntries(
  Object.entries(FILES).map(([name, path]) => [name, readFileSync(path, 'utf8')]),
)

let failures = 0
const ok = (cond, label, detail) => {
  if (!cond) failures++
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}${detail ? '\n          ' + detail : ''}`)
}

/**
 * Extract the source of `function name(...) ... { ... }`.
 *
 * Brace counting keeps tripping over TypeScript: return-type annotations that
 * are themselves object literals (`): { a: T } {`), generics, object literals
 * in the default value. Rather than keep patching a parser, take the honest
 * approach: locate the signature, then scan forward to the first '{' that is
 * NOT inside a type annotation or a parameter list — which in practice means
 * the first '{' appearing on a line after the closing paren of the signature.
 */
function bodyOf(text, name) {
  const start = text.search(new RegExp(`function\\s+${name}\\b`))
  if (start < 0) return null
  const paren = text.indexOf('(', start)
  if (paren < 0) return null
  let depth = 0
  let i = paren
  for (; i < text.length; i++) {
    const c = text[i]
    if (c === '"' || c === "'" || c === '`') { i = skipString(text, i); continue }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') { if (--depth === 0) break }
  }
  if (depth !== 0) return null
  // From here on, walk to the first '{' that opens the BODY. A return-type
  // object literal is followed by more type text before the body, so require
  // the '{' to be preceded only by type-ish characters.
  let j = i + 1
  while (j < text.length) {
    const c = text[j]
    if (c === '"' || c === "'" || c === '`') { j = skipString(text, j) + 1; continue }
    if (c === '{') break
    if (c === ';') return null
    j++
  }
  // If what we found is a return type (i.e. it is closed and more type follows),
  // the real body '{' comes later — keep scanning.
  let open = j
  while (open < text.length) {
    // Measure this candidate: is it a balanced object that closes before any
    // further '{'?  That is a type; otherwise it is the body.
    let d = 0
    let k = open
    for (; k < text.length; k++) {
      const ch = text[k]
      if (ch === '"' || ch === "'" || ch === '`') { k = skipString(text, k); continue }
      if (ch === '{') d++
      else if (ch === '}') { d--; if (d === 0) break }
      else if (ch === ';' && d === 0) return null
    }
    // Look at what follows the balanced group.
    let after = k + 1
    while (after < text.length && /\s/.test(text[after])) after++
    if (text[after] === '{') {
      // Balanced group followed by another '{' -> the first was the return type.
      open = after
      continue
    }
    return text.slice(open, k + 1)
  }
  return null
}

/** Index of the closing quote for the literal starting at `i`. */
function skipString(text, i) {
  const quote = text[i]
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') { j++; continue }
    if (text[j] === quote) return j
    if (quote !== '`' && text[j] === '\n') return j
  }
  return text.length - 1
}

console.log('\n=== 1. cli-probe: flag -> streamChat argument ===')
{
  const text = src['cli-probe.ts']
  ok(/arg === '--model'/.test(text), "CLI accepts --model")
  ok(/options\.modelKey\s*=\s*argv\[\+\+i\]/.test(text), 'flag value is stored on options.modelKey')
  const call = text.slice(text.indexOf('await streamChat('))
  ok(/modelKey: options\.modelKey/.test(call), 'passes modelKey into streamChat()')
  ok(!/modelKey: requestedModel\.id/.test(call),
    'passes the RAW flag value, not a catalog-normalised id')
  ok(/\.\.\.options\.modelKey === undefined \? \{\} : \{ modelKey: options\.modelKey \}/.test(call),
    'key is omitted (not set to undefined) when absent')
}

console.log('\n=== 2. streamChat: option -> buildChatBody ===')
{
  const body = bodyOf(src['doubao-upstream.ts'], 'streamChat')
  ok(body !== null, 'streamChat body located')
  if (body) {
    ok(/buildChatBody\(prompt, options\)/.test(body), 'forwards the whole options object unchanged')
    ok(!/modelKey\s*[:=]\s*['"]/.test(body), 'does not hardcode a modelKey inside streamChat')
  }
}

console.log('\n=== 3. buildChatBody: option -> both mirrors ===')
{
  const body = bodyOf(src['doubao-upstream.ts'], 'buildChatBody')
  ok(body !== null, 'buildChatBody body located')
  if (body) {
    ok(/findDoubaoModel\(options\.modelKey\)/.test(body),
      'resolves the key through findDoubaoModel(options.modelKey)')
    ok(!/Number\(options\.modelKey\)|parseInt\(.*modelKey/.test(body),
      'never coerces modelKey to a number (slugs would be lost)')
    ok((body.match(/model_item_key: model\.id/g) || []).length === 2,
      'writes model_item_key exactly TWICE (the two mirrors)',
      (body.match(/model_item_key: model\.id/g) || []).join('\n          '))
    ok(/model_config: \{[^}]*model_item_key: model\.id/.test(body), 'mirror 1 lives in option.model_config')
    ok(/aggregate_params: \{[^}]*model_item_key: model\.id/.test(body), 'mirror 2 lives in option.aggregate_params')
    ok(/reasoning_effort: level\.level/.test(body), 'reasoning_effort written as a number')
    ok(/reasoning_effort: String\(level\.level\)/.test(body), 'reasoning_effort written as a string too')
    ok(/need_deep_think: needDeepThink/.test(body) && /use_deep_think: String\(needDeepThink\)/.test(body),
      'need_deep_think mirrors ext.use_deep_think')
  }
}

console.log('\n=== 4. catalog: key round-trip is lossless ===')
{
  const text = src['doubao-catalog.ts']
  const block = text.slice(text.indexOf('export const DOUBAO_MODELS'), text.indexOf('export const DOUBAO_MODELS') + 900)
  const entries = [...block.matchAll(/id: '([^']+)',\s*name: '([^']+)'([^}]*)\}/g)]
    .map((m) => ({ id: m[1], name: m[2], badge: (m[3].match(/badge: '([^']+)'/) || [])[1] }))
  ok(entries.length === 6, 'catalog has the six published entries', entries.map((e) => `${e.id}=${e.name}`).join(', '))
  for (const key of ['9', 'seed-lite-7b', '5', '3']) {
    ok(entries.some((e) => e.id === key), `catalog carries id "${key}" verbatim`)
  }
  const fn = bodyOf(text, 'findDoubaoModel')
  ok(/DOUBAO_MODELS\.find\(\(model\) => model\.id === id\)/.test(fn), 'findDoubaoModel matches on exact id')
  ok(!/Number\(|parseInt/.test(fn), 'findDoubaoModel does not numericise the id')
  const levels = [...text.matchAll(/id: '(low|mid|high)',\s*name: '[^']+',\s*level: (\d+),\s*verified: (\w+)/g)]
    .map((m) => ({ id: m[1], level: Number(m[2]), verified: m[3] === 'true' }))
  ok(levels.length === 3, 'three reasoning levels', JSON.stringify(levels))
  ok(levels.every((l) => l.verified), 'all three levels are verified')
  ok(JSON.stringify(levels.map((l) => l.level)) === '[3,4,5]', 'levels are 3 / 4 / 5', JSON.stringify(levels.map((l) => l.level)))
  const ndt = bodyOf(text, 'needDeepThinkOf')
  ok(/10_000 \+ level\.level/.test(ndt), 'needDeepThinkOf = 10000 + level')
}

console.log('\n=== 5. shim: inbound request -> upstream call ===')
{
  const text = src['doubao-shim.ts']
  ok(/model\?: string/.test(text), 'shim parses an inbound `model` field')
  const resolver = bodyOf(text, 'requestOptions')
  ok(resolver !== null, 'requestOptions() resolver located')
  if (resolver) {
    ok(/\{ modelKey: parsed\.model \}/.test(resolver), 'resolver turns inbound model into modelKey')
    ok(!/Number\(|parseInt/.test(resolver), 'resolver does not numericise the model id')
  }
  const levelFn = bodyOf(text, 'toDoubaoLevel')
  ok(levelFn !== null, 'toDoubaoLevel() located')
  if (levelFn) {
    ok(/case 'medium':\s*return 'mid'/.test(levelFn), 'toDoubaoLevel maps OpenAI "medium" onto Doubao 中')
  }
  // Both call sites must forward; the streaming one uses an object literal so a
  // paren-only match truncates it — match on the identifier instead.
  const callSites = [...text.matchAll(/await chat\(prompt/g)].length
  ok(callSites === 2, 'shim has 2 chat() call sites', String(callSites))
  // Both call sites must forward; the streaming one uses an object literal so a
  // paren-only match truncates it — match on the identifier instead. The
  // definition spells `function requestOptions(parsed: ...)`, so only the two
  // call sites match `requestOptions(parsed)` exactly.
  const forwards = [...text.matchAll(/\brequestOptions\(parsed\)/g)].length
  ok(forwards === callSites,
    'every chat() call site forwards requestOptions(parsed)',
    `found ${forwards}, expected ${callSites}`)
  const streamSig = text.match(/async function streamCompletion\(([^)]*)\)/)
  ok(streamSig !== null && /parsed/.test(streamSig[1]),
    'streamCompletion() receives the parsed request',
    streamSig ? `(${streamSig[1].replace(/\s+/g, ' ').trim()})` : 'not found')
  ok(/streamCompletion\(res, prompt, parsed\)/.test(text), 'streamCompletion call site passes parsed')
}

console.log('\n=== 6. adapter: picker level names vs Doubao ids ===')
{
  const text = src['doubao-adapter.ts']
  const fn = bodyOf(text, 'thinkingLevelMap')
  ok(fn !== null, 'thinkingLevelMap body located')
  if (fn) {
    const pairs = [...fn.matchAll(/(minimal|low|medium|high|off):\s*'(low|mid|high)'/g)].map((m) => `${m[1]}->${m[2]}`)
    ok(pairs.length >= 4, 'every picker level maps to a Doubao id', pairs.join(' '))
    ok(pairs.includes('medium->mid'), 'OpenAI "medium" maps to Doubao 中',
      'MISMATCH: pi-ai spells the level differently from Doubao')
  }
}

console.log('\n=== 7. no false model echo (regression guard) ===')
{
  const text = src['doubao-shim.ts']
  // The bug M11 fixed: the shim copied the inbound model straight into the
  // OpenAI `model` field, so a reply looked model-specific even when no model
  // had been requested — or when the request had been silently dropped.
  // Anchor on the field name so the adjacent `requested_model:` line, which
  // legitimately mentions parsed.model, does not trip this guard.
  ok(!/^\s*model:\s*parsed\.model/m.test(text),
    '`parsed.model` is never assigned to the OpenAI `model` field',
    'REGRESSION: the false echo is back')
  ok(!/model:\s*parsed\.model\s*\?\?\s*'doubao'/.test(text),
    "the old `?? 'doubao'` placeholder fallback is gone")
  const desc = bodyOf(text, 'describeRequestedModel')
  ok(desc !== null, 'describeRequestedModel() exists')
  if (desc) {
    ok(/findDoubaoModel\(key\)\.name/.test(desc), 'it returns the human-readable NAME, not the raw key')
    ok(/unknown: true/.test(desc), 'an unrecognised key is flagged rather than silently renamed')
  }
  ok(/requested_model:\s*describeRequestedModel\(parsed\.model\)/.test(text),
    'response carries requested_model, which cannot be mistaken for upstream confirmation')
}

console.log('\n=== 8. catalog matches the client\'s own menuConfV2 ===')
{
  const text = src['doubao-catalog.ts']
  const block = text.slice(text.indexOf('export const DOUBAO_MODELS'), text.indexOf('export const DOUBAO_MODELS') + 900)
  const entries = [...block.matchAll(/id: '([^']+)',\s*name: '([^']+)'([^}]*)\}/g)]
    .map((m) => ({ id: m[1], name: m[2], badge: (m[3].match(/badge: '([^']+)'/) || [])[1] }))
  ok(entries.length === 6, 'catalog has the six published entries', entries.map((e) => `${e.id}=${e.name}`).join(', '))
  // Two Turbo entries exist and carry DIFFERENT badges; conflating them is
  // exactly the mistake M10 found.
  const turbos = entries.filter((e) => e.name === '豆包 2.1 Turbo')
  ok(turbos.length === 2, 'two distinct Turbo entries', turbos.map((t) => `${t.id}(${t.badge ?? '-'})`).join(' '))
  ok(new Set(turbos.map((t) => t.badge)).size === 2,
    'the two Turbo entries carry different badges', turbos.map((t) => `${t.id}=${t.badge}`).join(' '))
  ok(entries[0]?.id === '0' && entries[0]?.name === '豆包 快速',
    '「豆包 快速」 leads the list (it is the chat-mode default)',
    `first entry is ${entries[0]?.id}=${entries[0]?.name}`)
  ok(/DOUBAO_DEFAULT_MODEL_ID = '0'/.test(text), 'the default model is the chat-mode default "0"')
}

console.log('\n=== 9. mode_id vs model_item_key do not share a variable ===')
{
  // The client's config uses mode_id "3" for creation/office AND a Turbo model
  // whose model_item_key is also "3". Colliding values must not collide names.
  const up = src['doubao-upstream.ts']
  ok(!/mode_id\s*[:=]/.test(up), 'buildChatBody never writes a mode_id')
  ok(/CHAT_AGENT_MODE/.test(up), 'the chat/office switch is named CHAT_AGENT_MODE, not mode_id')
  ok(!/modelKey\s*=\s*String\(/.test(up), 'a model key is never derived from the agent mode')
  ok(!/mode_id/.test(src['doubao-shim.ts']), 'the shim does not invent a mode_id either')
}

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
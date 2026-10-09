/**
 * The rules that decide whether the client bundle can LOAD in the desktop shell.
 *
 * 参考：dingminhua/dsh-connect-trae（MIT，Copyright (c) 2026 LaoDing）
 *   与 dsh-connect-workbuddy 的 `tests/client-runtime-imports.spec.ts`。其项目
 *   曾因信用面板引入 `createPortal` 而把 react-dom 打进产物，导致整个客户端
 *   半边 import 失败；本插件把那条规则连同"必须是 CJS"一并固化。
 *
 * 本文件覆盖两类互不相同的失败，二者症状相同（`1 entry did not activate`、
 * 整个 web boot 崩掉），根因不同：
 *
 * 1. 产物不是 CJS（`format: ['esm']`）。桌面外壳用 `<script>` 加载插件客户端，
 *    不加 `type="module"`，于是产物开头的 `import …` 直接抛
 *    `SyntaxError: Cannot use import statement outside a module`。
 *    —— 2026-10-09 事故：dsh-connect-doubao 的客户端产物就是 ESM，
 *    装进 desktop profile 后 DSH 桌面端启动即崩。
 *
 * 2. 外部依赖被打包。产物内联 react-dom 的 CJS 构建，其开头
 *    `if (process.env.NODE_ENV !== "production")` 在浏览器抛
 *    `ReferenceError: process is not defined`，同样是整个客户端半边失败。
 *
 * 这两条都无法从运行时测试套件观察到——Node 会从 node_modules 解析这些包，
 * 组件测试也把它们 mock 掉了。所以在产物上做静态断言。
 *
 * 这些断言跑在 BUILD 产物（`lib/client.js`）上，所以必须先构建；
 * 未构建时明确 skip，而不是假通过。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const CLIENT_JS = join(root, 'lib', 'client.js')
const TSDOWN_CONFIG = join(root, 'tsdown.config.ts')

/** Read the built client bundle, or `undefined` when it has not been built. */
function bundle(): string | undefined {
  if (!existsSync(CLIENT_JS)) return undefined
  return readFileSync(CLIENT_JS, 'utf8')
}

/** Parse CLIENT_EXTERNALS out of tsdown.config.ts (comments stripped first). */
function clientExternals(): string[] {
  const source = readFileSync(TSDOWN_CONFIG, 'utf8')
  const block = /const CLIENT_EXTERNALS = \[([\s\S]*?)\] as const/.exec(source)
  if (block === null) throw new Error('CLIENT_EXTERNALS not found in tsdown.config.ts')
  // Comments are stripped BEFORE matching. A naive /'([^']+)'/g over the raw
  // block pairs the apostrophe in a comment word ("shell's") with the next
  // quote and returns comment text as entries — which is exactly what happened
  // on the referring project's first attempt at this test.
  const body = (block[1] ?? '').replace(/^[ \t]*\/\/.*$/gm, '')
  return [...body.matchAll(/^[ \t]*'([^']+)',[ \t]*$/gm)].map(m => m[1] as string)
}

/**
 * Modules the shell's `__ModuleLoader__` registers, transcribed from the shipped
 * bundle's `rM()` (`@deepseek-ai/dsh-web-frontend/dist/assets/index-*.js`).
 *
 * Re-verify with `scripts/shell-registry-extract.mjs` after a DSH upgrade: an
 * external that is not registered resolves to nothing at runtime.
 */
const HOST_REGISTERED = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

describe('the client bundle can actually load in the desktop shell', () => {
  const built = bundle()

  /**
   * The artifact must exist before any rule below is evaluated.
   *
   * The early `it('is built …')` case alone is NOT enough: a per-test
   * `if (built === undefined) return` makes the remaining rules PASS for the
   * wrong reason — they assert nothing when the build is missing or was cleaned.
   * Throwing here turns a missing artifact into a loud failure instead of a
   * silently weakened suite (this exact hole is called out in the module note).
   */
  function artifact(): string {
    if (built === undefined) {
      throw new Error('lib/client.js is missing — run `npm run build` before this suite')
    }
    return built
  }

  it('is built (run `npm run build` first)', () => {
    expect(built).toBeDefined()
  })

  it('does NOT start with an ESM import statement (the 2026-10-09 crash)', () => {
    const first = artifact().replace(/\r\n/g, '\n').split('\n').find(line => line.trim() !== '') ?? ''
    expect(first).not.toMatch(/^import[\s{*'"]/)
    // Positive half of the same rule: the file opens with the loader call the
    // shell evaluates, so "does not start with import" cannot pass on an empty
    // or unrelated file.
    expect(first).toContain('__ModuleLoader__.load(')
  })

  it('contains no top-level ESM import statement anywhere', () => {
    // A stray `import(` dynamic import would also fail without a loader; and a
    // top-level `import {` on any line means the CJS transform silently failed.
    const offenders = artifact()
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /^import[\s{*'"(]/.test(line))
      .map(({ n }) => n)
    expect(offenders).toEqual([])
  })

  it('is wrapped in the shell module-loader call', () => {
    expect(artifact()).toContain('__ModuleLoader__')
    expect(built).toContain('__ModuleLoader__.load(')
    expect(built).toContain('id: "dsh-connect-doubao"')
  })

  it('defines module/exports and returns them (banner + intro + footer intact)', () => {
    const source = artifact()
    expect(source).toContain('var module = { exports: {} }')
    expect(source).toContain('var exports = module.exports')
    // Normalised line endings, then the LAST THREE NON-EMPTY LINES are compared as a
    // sequence. Checking the line sequence (rather than a literal `\n` byte
    // pattern) keeps the assertion identical on Windows CRLF and POSIX LF, and
    // does not depend on whether the file ends with a trailing newline.
    const lines = source.replace(/\r\n/g, '\n').split('\n')
    const meaningful = lines.filter(line => line.trim() !== '')
    const tail = meaningful.slice(-3).map(line => line.trim())
    expect(tail).toEqual(['return module.exports;', '}', '});'])
  })

  it('requires react through the loader instead of inlining it', () => {
    const source = artifact()
    // Inlined react-dom would carry `process.env.NODE_ENV`; require() means the
    // shell supplied it.
    expect(source).toMatch(/require\(["']react["']\)/)
    expect(source).not.toContain('process.env.NODE_ENV')
  })

  it('never emits a require for a module the shell does not register', () => {
    const required = [...artifact().matchAll(/require\(["']([^"']+)["']\)/g)].map(m => m[1] as string)
    const offending = [...new Set(required)].filter(spec => !(HOST_REGISTERED as readonly string[]).includes(spec))
    expect(offending).toEqual([])
  })

  it('keeps react-dom external, which the shell registers', () => {
    const externals = clientExternals()
    expect(new Set(externals).size).toBe(externals.length)
    expect(externals).toContain('react-dom')
    expect(externals).toContain('react-dom/client')
    expect((HOST_REGISTERED as readonly string[])).toContain('react-dom')
  })

  it('declares the client target as CJS in tsdown.config.ts', () => {
    const source = readFileSync(TSDOWN_CONFIG, 'utf8')
    const clientBlock = source.slice(source.indexOf("entry: { client:"))
    expect(clientBlock).toMatch(/format:\s*\['cjs'\]/)
    expect(clientBlock).not.toMatch(/format:\s*\['esm'\]/)
  })

  it('keeps the node entry ESM (the host loads it with Node\'s ESM loader)', () => {
    const source = readFileSync(TSDOWN_CONFIG, 'utf8')
    const nodeBlock = source.slice(source.indexOf('entry: {'), source.indexOf("entry: { client:"))
    expect(nodeBlock).toMatch(/format:\s*\['esm'\]/)
  })
})
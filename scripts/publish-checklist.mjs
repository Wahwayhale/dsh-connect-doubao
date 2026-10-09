/**
 * Pre-submission gate: answers one question — "can this be committed and
 * published right now?" — using only local, read-only checks.
 *
 * It NEVER commits, pushes, publishes, or touches the network. The only thing it
 * can do to your repository is read it.
 *
 * Exit codes:  0 = every check passed (print READY TO SUBMIT)
 *              1 = at least one check failed
 *
 * Run it from anywhere:   node scripts/publish-checklist.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const results = []

function check(name, fn) {
  try {
    const detail = fn()
    results.push({ name, pass: true, detail: detail ?? '' })
  } catch (error) {
    results.push({ name, pass: false, detail: (error && error.message) || String(error) })
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// --- 1. repository -----------------------------------------------------------
check('git 仓库存在（.git/）', () => {
  assert(existsSync(join(ROOT, '.git')), '未找到 .git —— 先执行 git init')
  return '.git/ 存在'
})

check('仓库至少有一个 commit', () => {
  const out = execFileSync('git', ['log', '--oneline', '-1'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert(out.trim().length > 0, '仓库还没有 commit —— 先 git commit')
  return out.trim()
})

// --- 2. screenshots ----------------------------------------------------------
for (const rel of ['docs/assets/dsh-connect-doubao-quota-card.png', 'docs/assets/dsh-connect-doubao-settings-section.png']) {
  check(`截图在位：${rel}`, () => {
    const p = join(ROOT, rel)
    assert(existsSync(p), `缺少 ${rel}`)
    const size = readFileSync(p).length
    assert(size > 1024, `${rel} 只有 ${size} 字节，疑似占位文件`)
    return `${size} 字节`
  })
}

check('screenshots.json 列出的文件都真实存在', () => {
  const list = JSON.parse(readFileSync(join(ROOT, 'screenshots.json'), 'utf8'))
  assert(Array.isArray(list) && list.length > 0, 'screenshots.json 不是非空数组')
  for (const rel of list) {
    assert(existsSync(join(ROOT, rel)), `screenshots.json 引用了不存在的文件：${rel}`)
  }
  return `${list.length} 条引用全部存在`
})

// These two answer DIFFERENT questions and must stay separate, because they fail
// for different reasons with different fixes.
//
//  (a) "are the screenshots IN the repository?"  — the thing the marketplace page
//      actually needs. Judge it from HEAD (or the index before the first commit),
//      NOT from "is there anything staged": once the commit exists the working
//      tree is clean, and an earlier version of this check read that emptiness as
//      "blocked by .gitignore" and produced a false FAIL on a healthy repo.
//
//  (b) "would a FUTURE image be blocked?" — judge it with `check-ignore`'s exit
//      code. Note the semantics: exit 0 means "matched SOME rule", which includes
//      matching a NEGATION rule (`!docs/assets/*.png`). So a 0 here does NOT mean
//      "ignored"; only `--no-index -v` output that ends in an ignore rule does.
function gitHasHead() {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] })
    return true
  } catch {
    return false
  }
}

const SCREENSHOT_FILES = [
  'docs/assets/dsh-connect-doubao-quota-card.png',
  'docs/assets/dsh-connect-doubao-settings-section.png',
]

check('截图已进版本库（市场页要有图）', () => {
  const listing = gitHasHead()
    ? execFileSync('git', ['ls-tree', '-r', 'HEAD', '--name-only'], { cwd: ROOT, encoding: 'utf8' })
    : execFileSync('git', ['ls-files', '--cached', '--'], { cwd: ROOT, encoding: 'utf8' })
  const tracked = new Set(listing.split('\n').map(l => l.trim()))
  const missing = SCREENSHOT_FILES.filter(f => !tracked.has(f))
  assert(missing.length === 0,
    `未进库：${missing.join(', ')}（${gitHasHead() ? 'HEAD 里找不到' : '暂存区里找不到'}）`)
  return `${SCREENSHOT_FILES.length} 张均在${gitHasHead() ? ' HEAD' : '暂存区'}中`
})

check('截图未被 .gitignore 挡住（防未来的宽规则）', () => {
  // `--no-index` consults the ignore rules alone, without the tracked-file
  // exemption, which is exactly the "would a new file here be ignored?" question.
  for (const file of SCREENSHOT_FILES) {
    let matched = ''
    try {
      execFileSync('git', ['check-ignore', '--no-index', '-q', '--', file], { cwd: ROOT, stdio: 'ignore' })
      matched = 'matched'
    } catch {
      matched = 'not-matched'
    }
    if (matched === 'matched') {
      // Distinguish a real ignore from a matched NEGATION rule, so the message
      // tells the user which of the two happened.
      let rule = ''
      try {
        rule = execFileSync('git', ['check-ignore', '--no-index', '-v', '--', file], { cwd: ROOT, encoding: 'utf8' }).trim()
      } catch { /* no rule matched */ }
      if (!/^\S+:\d+:\s*!/.test(rule)) {
        throw new Error(`${file} 被 ${rule || '某条 .gitignore 规则'} 挡住了`)
      }
    }
  }
  return '两张图均不会被 ignore 规则吞掉'
})

// --- 3. build artifacts ------------------------------------------------------
check('lib/client.js 在位且为 CJS（M7 崩溃修复）', () => {
  const p = join(ROOT, 'lib', 'client.js')
  assert(existsSync(p), '缺少 lib/client.js —— 先 npm run build')
  const first = readFileSync(p, 'utf8').split('\n').find(l => l.trim() !== '') ?? ''
  assert(first.includes('window.__ModuleLoader__.load('),
    `首行是 ${JSON.stringify(first.slice(0, 60))}，不是 __ModuleLoader__ 包装 —— ESM 产物会让桌面端启动即崩`)
  return `首行: ${first.trim().slice(0, 48)}`
})

check('lib/index.js 在位（宿主 provider 入口）', () => {
  assert(existsSync(join(ROOT, 'lib', 'index.js')), '缺少 lib/index.js')
  return '存在'
})

// --- 4. metadata -------------------------------------------------------------
check('package.json 无 TODO 占位符', () => {
  const found = JSON.stringify(pkg).match(/TODO[A-Z-]*/g)
  assert(!found, `仍有占位符：${[...new Set(found)].join(', ')}`)
  return '干净'
})

check('package.json 声明了 repository / homepage / bugs', () => {
  for (const key of ['repository', 'homepage', 'bugs']) {
    assert(pkg[key], `缺少 ${key}`)
  }
  const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url
  assert(/git\+https:\/\/github\.com\//.test(repoUrl),
    `repository.url 应带 git+ 前缀，当前是 ${repoUrl}`)
  return repoUrl
})

check('package.json 的 files 含 docs/assets（否则市场页无图）', () => {
  assert(Array.isArray(pkg.files) && pkg.files.includes('docs/assets'), 'files 里没有 docs/assets')
  return 'docs/assets 已在 files 中'
})

check('官方 @deepseek-ai/* 走 peerDependencies（市场 R11）', () => {
  const peers = Object.keys(pkg.peerDependencies ?? {})
  assert(peers.length > 0, 'peerDependencies 为空')
  const deps = Object.keys(pkg.dependencies ?? {})
  const leaked = deps.filter(d => d.startsWith('@deepseek-ai/'))
  assert(leaked.length === 0, `这些官方包被放进了 dependencies：${leaked.join(', ')}`)
  return `${peers.length} 个 peer 依赖，0 个官方包泄漏到 dependencies`
})

// --- 5. docs -----------------------------------------------------------------
for (const rel of ['README.md', 'README.en.md', 'LICENSE']) {
  check(`必需文件存在：${rel}`, () => {
    const p = join(ROOT, rel)
    assert(existsSync(p), `缺少 ${rel}`)
    return `${readFileSync(p).length} 字节`
  })
}

check('两份 README 都嵌了主图', () => {
  for (const rel of ['README.md', 'README.en.md']) {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    assert(/!\[.*\]\(docs\/assets\/.*\.png\)/.test(text), `${rel} 没有嵌入 docs/assets 下的图片`)
  }
  return '两份都嵌了'
})

// --- 6. submission -----------------------------------------------------------
check('投稿 YAML 通过全部规则校验', () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'validate-submission.mjs')], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  return 'validate-submission.mjs 20/20'
})

// --- report ------------------------------------------------------------------
const failed = results.filter(r => !r.pass)
const width = Math.max(...results.map(r => r.name.length))
console.log('='.repeat(width + 34))
console.log('发布前检查 · dsh-connect-doubao')
console.log('='.repeat(width + 34))
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`)
}
console.log('-'.repeat(width + 34))
console.log(`${results.length - failed.length}/${results.length} 通过`)

if (failed.length === 0) {
  console.log('\nREADY TO SUBMIT')
  console.log('下一步见 RELEASE-CHECKLIST.md。')
} else {
  console.log(`\nNOT READY —— ${failed.length} 项未通过：`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
}
process.exit(failed.length === 0 ? 0 : 1)
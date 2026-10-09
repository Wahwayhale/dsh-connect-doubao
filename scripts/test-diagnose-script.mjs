/**
 * Prove the console diagnostic script actually detects the three outcomes,
 * by running it against a minimal fake DOM in Node (no jsdom needed).
 *
 * Case A: card absent from DOM, not in boot manifest
 * Case B: card rendered but every ancestor is zero-width  (overflow)
 * Case C: card rendered and visible
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SCRIPT = readFileSync('E:/project/新建文件夹/dsh-connect-doubao/scripts/diagnose-card-in-console.js', 'utf8')

function makeEl(tag, opts = {}) {
  const classes = (opts.className ?? '').split(' ').filter(Boolean)
  const attrs = { ...(opts.attrs ?? {}) }
  const children = opts.children ?? []
  const el = {
    tagName: tag.toUpperCase(),
    className: opts.className ?? '',
    id: opts.id ?? '',
    children,
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    style: {},
    parentElement: opts.parent ?? null,
    __overflow: opts.overflow ?? 'visible',
    getAttribute(n) { return attrs[n] ?? null },
    get classList() {
      return { contains: (c) => classes.includes(c) }
    },
    getBoundingClientRect() {
      return opts.rect ?? { left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50 }
    },
    get textContent() { return opts.text ?? '' },
    get innerHTML() { return opts.html ?? '' },
    get innerText() { return opts.text ?? '' },
    querySelectorAll: () => [],
  }
  // Link children back to this element so the ancestor walk in the script works.
  for (const c of children) c.parentElement = el
  return el
}

function runCase(label, { boot, dbqCard, containerRect, containerOverflow }) {
  // The stub must actually ANSWER `querySelectorAll('[class*="dbq-"]')`, and the
  // element tree must be PARENT-LINKED, or the script's ancestor walk finds
  // nothing and every case collapses to the same verdict.
  const cardEl = dbqCard
    ? makeEl('div', {
        className: 'dbq-card',
        rect: { left: 10, top: 40, width: 420, height: 320, right: 430, bottom: 360 },
        text: '豆包连接 额度 标准套餐 5 小时限额 周额度 已启用 1 ↑',
      })
    : null

  // The container the host renders plugin config rows into. Its rect and
  // overflow are what decide "rendered but invisible".
  const containerEl = makeEl('div', {
    className: 'plugin-config-rows',
    overflow: containerOverflow ?? 'visible',
    rect: containerRect ?? { left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600 },
    children: [cardEl].filter(Boolean),
  })

  const bodyEl = makeEl('body', {
    children: [containerEl],
    html: dbqCard ? '额度 标准套餐 豆包 上游自动路由' : '',
    text: dbqCard ? '豆包连接 额度 标准套餐' : '',
  })

  const doc = {
    body: bodyEl,
    querySelectorAll: (sel) => {
      if (typeof sel === 'string' && sel.includes('dbq-')) return cardEl ? [cardEl] : []
      return []
    },
    getElementById: (id) => (id === 'dbq-card-styles' ? { textContent: '.dbq-card{}'.repeat(10) } : null),
  }
  const sandbox = {
    console: { log: () => {} },
    document: doc,
    // The script reads computed styles; supply the handful of properties it uses.
    getComputedStyle: (el) => ({
      display: el?.__display ?? 'block',
      flexWrap: 'nowrap',
      flexDirection: 'row',
      overflow: el?.__overflow ?? 'visible',
      visibility: 'visible',
      opacity: '1',
      minWidth: '0px',
      gap: '0px',
    }),
    location: { href: 'http://127.0.0.1/dsh/' },
  }
  // The script reads `globalThis.__DSH_BOOT__`, and in a browser
  // `globalThis === window`. The stub must therefore carry the boot manifest on
  // the sandbox root too, or every case collapses to "not in boot manifest".
  sandbox.window = {
    innerWidth: 1200,
    innerHeight: 800,
    __ModuleLoader__: undefined,
    __DSH_BOOT__: boot,
  }
  sandbox.globalThis = sandbox
  sandbox.__DSH_BOOT__ = boot
  let err = null
  let printed = []
  sandbox.console = { log: (...a) => printed.push(a.join(' ')) }
  try {
    vm.runInNewContext(SCRIPT, sandbox, { filename: 'diagnose.js' })
  } catch (e) {
    err = e
  }
  const text = printed.join('\n')
  const verdictLine = printed.filter(l => l.includes('结论:') || l.includes('结论：'))[0] ?? '(no verdict)'
  console.log(`\n=== ${label} ===`)
  if (err) console.log('  THREW:', err.message)
  console.log('  ' + verdictLine.replace(/\s+/g, ' '))
  if (process.env.DIAG_VERBOSE === '1') console.log(text.split('\n').map(l => '    | ' + l).join('\n'))
  return text
}

const rowOk = makeEl('div', { className: 'row', rect: { left: 10, top: 10, width: 800, height: 40, right: 810, bottom: 50 }, text: '豆包连接 额度 标准套餐' })
const rowZero = makeEl('div', { className: 'row-zero', rect: { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 } })

const bootDoubao = { id: 'dsh-connect-doubao', url: 'u', rev: 'r', inject: ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-locale'] }

runCase('A: 不在 boot 清单 + DOM 无卡片', {
  boot: { entries: [{ id: 'other', url: 'x' }] },
  dbqCard: false,
})

runCase('B: 清单有 + 卡片在,但祖先 overflow:hidden 且裁剪区不含卡片', {
  boot: { entries: [bootDoubao] },
  dbqCard: true,
  // Container is 200x80 but the card is 420x320 at (10,40): the card spills out
  // and overflow:hidden clips it — "rendered but invisible".
  containerRect: { left: 0, top: 0, width: 200, height: 80, right: 200, bottom: 80 },
  containerOverflow: 'hidden',
})

runCase('C: 清单有 + 卡片可见', {
  boot: { entries: [bootDoubao] },
  dbqCard: true,
})
/**
 * Browser-based sign-in for the Doubao plugin.
 *
 * WHY THIS EXISTS
 *
 * This is the ONLY way the plugin obtains a session. It used to be the fallback
 * for machines without the desktop app, while the primary path decrypted the
 * app's own cookie jar; that primary path is gone (see `./doubao-auth.ts` for
 * why) because the running app locks its cookie database exclusively — which is
 * exactly the state this plugin is meant to run in.
 *
 * Doubao's passport endpoints are plain HTTPS + a `sessionid` cookie, and
 * `a_bogus`/`msToken` are NOT verified for the account/quota calls this plugin
 * makes — measured 2026-11-07: a request with a deliberately corrupted `a_bogus`
 * still answered 200, and only the cookie mattered. So a single interactive
 * sign-in in a real Chromium is enough, with no app and no signature algorithm.
 *
 * HOW
 *
 * Spawn Chrome/Edge against a DEDICATED profile under `~/.dsh` and drive it over
 * the DevTools protocol. `Storage.getCookies` is browser-scoped, so one call
 * returns every cookie for every context — no target attach, no page reload.
 * The profile persists between logins, so the second run usually finds the
 * session still valid and needs no scan at all.
 *
 * SECURITY: the returned pairs are the user's live session. They are handed to
 * `doubao-auth.ts`, which seals them before anything touches disk (DPAPI on
 * Windows, AES-256-GCM elsewhere — see that module).
 * Nothing here logs a value.
 *
 * @module dsh-connect-doubao/auth-browser
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cookie names that must survive, in the order the plugin prefers them. */
const REQUIRED = ['sessionid', 'sessionid_ss', 'sid_tt', 'uid_tt', 'sid_guard'] as const

/** Domains whose cookies belong to Doubao (the passport jar spans several). */
const DOUBAO_DOMAIN = /(^|\.)(doubao|bytedance|zijieapi)\.com$/i

/** Where the dedicated Chromium profile lives. Persisted on purpose. */
export function browserProfileDir(): string {
  return join(homedir(), '.dsh', 'doubao-browser-profile')
}

/**
 * Per-platform Chromium binaries, most likely first.
 *
 * Windows paths were the only entries for the whole 0.6.x line, which made the
 * QR sign-in impossible on macOS even with Chrome installed — the failure was
 * 「没找到 Chrome 或 Edge」 before a browser window ever opened. Each platform
 * gets its own list, and every binary here is Chromium-based (shares the
 * `--remote-debugging-port` CDP surface this module drives).
 */
const CANDIDATES = process.platform === 'darwin' ? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
] : process.platform === 'linux' ? [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
] : [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]

/** Host page for the sign-in. `/chat` is the page that actually mints the jar. */
const LOGIN_URL = 'https://www.doubao.com/chat/'

export interface BrowserLoginOptions {
  /** Overall budget for the user to finish signing in. Default 5 minutes. */
  timeoutMs?: number
  /** Called with progress text; the route does not need it, the CLI does. */
  onProgress?: (message: string) => void
}

export interface BrowserLoginResult {
  ok: boolean
  /** Actionable failure text, or undefined on success. Never a secret. */
  reason?: string
  /** `name=value` pairs for a Cookie header. Empty on failure. */
  pairs?: Map<string, string>
  /** Ready-made `Cookie:` header value. Empty on failure. */
  header?: string
}

/** Minimal CDP cookie shape — only the fields this module reads. */
interface CdpCookie {
  name?: unknown
  value?: unknown
  domain?: unknown
  expires?: unknown
}

/**
 * Find an installed Chromium binary, or undefined.
 *
 * `DSH_DOUBAO_BROWSER` wins when set and existing: it lets a user point the
 * sign-in at any Chromium/Chrome/Edge binary, including non-default or
 * portable installs no candidate list can know about.
 */
export function findBrowser(): string | undefined {
  const override = process.env.DSH_DOUBAO_BROWSER
  if (typeof override === 'string' && override !== '' && existsSync(override)) return override
  for (const candidate of CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Poll `http://127.0.0.1:<port>/json/version` until it answers. */
async function waitForDevtools(port: number, deadline: number): Promise<string | undefined> {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      })
      if (response.ok) {
        const body = await response.json() as { webSocketDebuggerUrl?: unknown }
        if (typeof body.webSocketDebuggerUrl === 'string') return body.webSocketDebuggerUrl
      }
    } catch {
      // Not listening yet; keep waiting until the deadline.
    }
    await sleep(400)
  }
  return undefined
}

/** The global WebSocket (Node 22+), typed structurally to avoid lib assumptions. */
type SocketLike = {
  addEventListener: (type: string, listener: (event: unknown) => void) => void
  send: (data: string) => void
  close: () => void
}

function openSocket(url: string): SocketLike | undefined {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket
  return Ctor === undefined ? undefined : new Ctor(url)
}

/**
 * One `Storage.getCookies` round-trip.
 *
 * Browser-scoped on purpose: the page target may still be navigating, and
 * attaching to it would race the sign-in redirect chain.
 */
async function readCookies(wsUrl: string, timeoutMs = 15_000): Promise<CdpCookie[]> {
  const socket = openSocket(wsUrl)
  if (socket === undefined) throw new Error('this Node build has no global WebSocket')
  return await new Promise<CdpCookie[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { socket.close() } catch { /* already closing */ }
      reject(new Error('CDP timeout while reading cookies'))
    }, timeoutMs)

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Storage.getCookies', params: {} }))
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('CDP socket error'))
    })
    socket.addEventListener('message', (event: unknown) => {
      const data = (event as { data?: unknown }).data
      if (typeof data !== 'string') return
      let message: { id?: unknown; result?: { cookies?: unknown }; error?: { message?: unknown } }
      try {
        message = JSON.parse(data) as typeof message
      } catch {
        return
      }
      if (message.id !== 1) return
      clearTimeout(timer)
      try { socket.close() } catch { /* already closed */ }
      if (message.error !== undefined) {
        reject(new Error(String(message.error.message ?? 'CDP error')))
        return
      }
      const cookies = message.result?.cookies
      resolve(Array.isArray(cookies) ? cookies as CdpCookie[] : [])
    })
  })
}

/** Pick the Doubao cookies into `name → value`. */
function pickPairs(cookies: readonly CdpCookie[]): Map<string, string> {
  const pairs = new Map<string, string>()
  for (const cookie of cookies) {
    const name = cookie.name
    const value = cookie.value
    const domain = cookie.domain
    if (typeof name !== 'string' || typeof value !== 'string' || value === '') continue
    if (typeof domain !== 'string' || !DOUBAO_DOMAIN.test(domain.replace(/^\./, ''))) continue
    // First writer wins: the more specific host is listed first by CDP in
    // practice, and a later `.doubao.com` duplicate must not shadow it.
    if (!pairs.has(name)) pairs.set(name, value)
  }
  return pairs
}

/** Kill a spawned browser including its renderer children. */
function terminate(child: ChildProcess): void {
  if (child.pid === undefined) return
  // Windows: `child.kill()` leaves the renderer/gpu children behind, which
  // keeps the user-data-dir locked and the next login fails to start.
  // Everywhere else the signal reaches the whole process group, and browsers
  // shut their children down on their own.
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try { child.kill('SIGTERM') } catch { /* gone already */ }
}

/**
 * Run one interactive sign-in and return the harvested cookies.
 *
 * The caller decides where the credentials go; this function never writes them
 * anywhere. A browser window stays open for the whole budget, so the user can
 * finish a QR scan or an SMS code at their own pace.
 */
export async function browserLogin(options: BrowserLoginOptions = {}): Promise<BrowserLoginResult> {
  const say = options.onProgress ?? (() => {})
  const exe = findBrowser()
  if (exe === undefined) {
    return {
      ok: false,
      reason: '没找到 Chrome 或 Edge。浏览器扫码登录需要一个 Chromium 内核的浏览器。',
    }
  }

  const timeoutMs = options.timeoutMs ?? 300_000
  const deadline = Date.now() + timeoutMs
  const profile = browserProfileDir()
  mkdirSync(profile, { recursive: true })

  // A fixed port would collide with a real debugging session the user may have
  // open; 9333 is unusual enough to be safe and stable across retries.
  const port = 9333
  const child = spawn(exe, [
    `--remote-debugging-port=${String(port)}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    LOGIN_URL,
  ], { stdio: 'ignore', detached: false })

  try {
    say('已打开浏览器，请在弹出的窗口里扫码或短信登录…')
    const wsUrl = await waitForDevtools(port, Math.min(deadline, Date.now() + 20_000))
    if (wsUrl === undefined) {
      return { ok: false, reason: `浏览器调试端口 ${String(port)} 没起来（可能被占用）。` }
    }

    let lastNote = 0
    while (Date.now() < deadline) {
      let cookies: CdpCookie[] = []
      try {
        cookies = await readCookies(wsUrl)
      } catch (error: unknown) {
        // The page may be mid-navigation; retry until the deadline.
        say(`读取登录态失败，重试中：${(error as Error).message}`)
        await sleep(1500)
        continue
      }
      const pairs = pickPairs(cookies)
      if (pairs.get('sessionid') !== undefined) {
        const missing = REQUIRED.filter((name) => name !== 'sid_guard' && !pairs.get(name))
        if (missing.length > 0) {
          // A `sessionid` without `uid_tt`/`sid_tt` is a half-written jar: the
          // sign-in wrote cookies in stages. Waiting one more tick avoids
          // sealing a session the server will reject as "会话过期".
          say(`登录已开始，等待 cookie 补齐（缺 ${missing.join(', ')}）…`)
          await sleep(1500)
          continue
        }
        const header = [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
        say(`已取到登录态（${String(pairs.size)} 条 cookie）`)
        return { ok: true, pairs, header }
      }
      if (Date.now() - lastNote > 10_000) {
        lastNote = Date.now()
        say(`… 等待扫码（已看到 ${String(cookies.length)} 条浏览器 cookie）`)
      }
      await sleep(2000)
    }
    return { ok: false, reason: '等待登录超时。扫码完成后请重试。' }
  } finally {
    terminate(child)
  }
}

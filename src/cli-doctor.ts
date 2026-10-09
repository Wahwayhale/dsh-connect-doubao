#!/usr/bin/env node
/**
 * `doctor` — verify the whole stack end to end without spending inference quota.
 *
 *   node lib/cli-doctor.js
 *   node lib/cli-doctor.js --json
 *
 * Four checks, each reported independently so one failure does not hide the
 * rest:
 *
 *   1. credentials  the Doubao profile is found and the cookie jar decrypts
 *   2. account      the server accepts that session
 *   3. provider     the plugin assembles: shim binds a loopback port, the
 *                   adapter builds, the catalog and quota route respond
 *   4. quota        both consumption windows are readable
 *
 * NOTHING here sends an inference request, so it is safe to run repeatedly.
 * Credentials are never printed: only counts, names and booleans.
 */
import {
  loadDoubaoCredentials,
  describeProfileLocation,
  REQUIRED_COOKIE_NAMES,
  findDoubaoUserDataDir,
} from './doubao-auth.ts'
import { probeAccount, classifyDoubaoFailure, DoubaoUpstreamError } from './doubao-upstream.ts'
import { fetchQuota, findWindow } from './doubao-quota.ts'
import { createDoubaoShim } from './doubao-shim.ts'
import { createDoubaoAdapter } from './doubao-adapter.ts'
import {
  DOUBAO_MODELS,
  DOUBAO_PROVIDER,
  DOUBAO_PROVIDER_DISPLAY_NAME,
  discoverDoubaoModels,
} from './doubao-catalog.ts'
import { doubaoQuotaView, DOUBAO_QUOTA_PATH } from './doubao-status.ts'

export type CheckStatus = 'ok' | 'fail' | 'skip'

export interface DoctorCheck {
  name: string
  status: CheckStatus
  detail: string
  data?: Record<string, unknown>
}

export interface DoctorReport {
  ok: boolean
  plugin: string
  checks: DoctorCheck[]
}

/**
 * Which peer dependency a check needs, absent?
 *
 * Resolution goes through `import.meta.resolve` rather than `require.resolve`:
 * pi-ai and the dsh-* packages are ESM-only with an `exports` map that carries
 * no `require` condition, so `require.resolve` reports them missing even when
 * they are installed and perfectly loadable.
 */
function missingPeer(name: string): boolean {
  try {
    import.meta.resolve(name)
    return false
  } catch {
    return true
  }
}

/** Run every check. Never throws: a failed check is data, not a crash. */
export async function runDoctor(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = []

  // ---- 1. credentials -------------------------------------------------
  const profileDir = findDoubaoUserDataDir()
  let credentials = loadDoubaoCredentials()
  if (profileDir === undefined) {
    checks.push({
      name: 'credentials',
      status: 'fail',
      detail: 'Doubao user profile not found. Expected <UserProfile>\\AppData\\Local\\Doubao\\User Data.',
    })
  } else if (!credentials.ok) {
    checks.push({ name: 'credentials', status: 'fail', detail: credentials.reason ?? 'unavailable' })
  } else {
    const present = REQUIRED_COOKIE_NAMES.filter((name) => credentials.pairs.get(name))
    checks.push({
      name: 'credentials',
      status: present.length === REQUIRED_COOKIE_NAMES.length ? 'ok' : 'fail',
      detail: `${credentials.pairs.size} cookies decrypted; ${present.length}/${REQUIRED_COOKIE_NAMES.length} required session cookies present`,
      // Names and counts only — never values.
      data: { profile: describeProfileLocation(), cookieCount: credentials.pairs.size },
    })
  }

  // ---- 2. account -----------------------------------------------------
  if (!credentials.ok) {
    checks.push({ name: 'account', status: 'skip', detail: 'no credentials' })
  } else {
    const account = await probeAccount(credentials)
    checks.push({
      name: 'account',
      status: account.ok ? 'ok' : 'fail',
      detail: account.ok ? 'Doubao accepted the session' : `session rejected: ${account.detail}`,
    })
  }

  // ---- 3. provider assembly -------------------------------------------
  const needsPiAi = missingPeer('@earendil-works/pi-ai') ||
    missingPeer('@deepseek-ai/dsh-llm-pi-ai') ||
    missingPeer('@deepseek-ai/dsh-llm')
  if (needsPiAi) {
    checks.push({
      name: 'provider',
      status: 'skip',
      detail: 'peer dependencies (@earendil-works/pi-ai, @deepseek-ai/dsh-llm-pi-ai) are not installed in this checkout',
    })
  } else {
    try {
      const shim = createDoubaoShim()
      try {
        const base = await shim.baseUrl()
        const { adapter, invalidate } = createDoubaoAdapter({ shim })
        invalidate()

        // Exercise the shim's own guards, both directions:
        //  * the REAL secret reaches /healthz (the loopback surface is live);
        //  * a WRONG secret is refused (the surface is locked down).
        // Both stay inside the shim — no upstream traffic either way.
        const authed = { Authorization: `Bearer ${shim.token()}` }
        const health = await fetch(`${base}/healthz`, { headers: authed })
        const unauthorized = await fetch(`${base}/healthz`, {
          headers: { Authorization: 'Bearer wrong-secret' },
        })
        const models = discoverDoubaoModels()

        checks.push({
          name: 'provider',
          status: health.ok && unauthorized.status === 401 ? 'ok' : 'fail',
          detail: `shim bound ${base.replace(/:\d+$/, ':<port>')}; authed health=${health.status}; bad bearer=${unauthorized.status}; adapter constructed=${adapter !== undefined}`,
          data: {
            provider: DOUBAO_PROVIDER,
            displayName: DOUBAO_PROVIDER_DISPLAY_NAME,
            modelCount: models.length,
            modelIds: models.map((model) => model.id),
            catalogSize: DOUBAO_MODELS.length,
            quotaRoute: DOUBAO_QUOTA_PATH,
            bearerGuard: unauthorized.status === 401,
          },
        })
      } finally {
        await shim.close()
      }
    } catch (error: unknown) {
      checks.push({ name: 'provider', status: 'fail', detail: (error as Error).message })
    }
  }

  // ---- 4. quota -------------------------------------------------------
  if (!credentials.ok) {
    checks.push({ name: 'quota', status: 'skip', detail: 'no credentials' })
  } else {
    const quota = await fetchQuota({ force: true })
    const fiveHour = findWindow(quota, 'five_hour')
    const weekly = findWindow(quota, 'weekly')
    const view = await doubaoQuotaView()
    checks.push({
      name: 'quota',
      status: quota.error === undefined && fiveHour !== undefined && weekly !== undefined ? 'ok' : 'fail',
      detail: quota.error ?? `${quota.plan ?? 'unknown plan'}; 5-hour=${fiveHour?.usedPercent ?? 'n/a'}% weekly=${weekly?.usedPercent ?? 'n/a'}%`,
      data: {
        plan: quota.plan ?? null,
        exhausted: quota.exhausted,
        fiveHourPercent: fiveHour?.usedPercent ?? null,
        weeklyPercent: weekly?.usedPercent ?? null,
        viewHasNoSecrets: !JSON.stringify(view).match(/sessionid|sid_tt|msToken|odin_tt|ttwid|passport_csrf/i),
      },
    })
  }

  return {
    ok: checks.every((check) => check.status === 'ok'),
    plugin: 'dsh-connect-doubao',
    checks,
  }
}

function renderText(report: DoctorReport): string {
  const mark: Record<CheckStatus, string> = { ok: '[ ok ]', fail: '[FAIL]', skip: '[skip]' }
  const lines = [`dsh-connect-doubao doctor`, '']
  for (const check of report.checks) {
    lines.push(`${mark[check.status]} ${check.name.padEnd(12)} ${check.detail}`)
  }
  lines.push('')
  lines.push(report.ok ? 'all checks passed' : 'some checks did not pass')
  return lines.join('\n')
}

/** Error classifier surface, exported so a future UI can reuse it. */
export { classifyDoubaoFailure, DoubaoUpstreamError }

if (process.argv[1] && /cli-doctor\.(js|ts|mjs)$/.test(process.argv[1])) {
  process.stdout.setDefaultEncoding('utf8')
  const json = process.argv.includes('--json')
  runDoctor()
    .then((report) => {
      process.stdout.write(json ? JSON.stringify(report, null, 2) + '\n' : renderText(report) + '\n')
      process.exitCode = report.ok ? 0 : 1
    })
    .catch((error: unknown) => {
      process.stderr.write(`doctor crashed: ${(error as Error).message}\n`)
      process.exitCode = 2
    })
}
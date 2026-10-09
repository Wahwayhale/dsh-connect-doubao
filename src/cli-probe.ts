#!/usr/bin/env node
/**
 * Doubao smoke probe.
 *
 * Runs one real completion against the Doubao upstream with the Doubao app
 * closed, then reports the reply together with both quota windows.
 *
 *   node lib/cli-probe.js --prompt "hi" --json
 *
 * This sends exactly one inference request. It never retries: a risk-control
 * challenge is reported, not worked around, because retrying an automated call
 * against a slider CAPTCHA makes the challenge stricter.
 *
 * Credentials are read into memory only and are never printed.
 */
import { loadDoubaoCredentials, describeProfileLocation } from './doubao-auth.ts'
import { streamChat, probeAccount, DoubaoUpstreamError } from './doubao-upstream.ts'
import { fetchQuota, findWindow, millisUntilReset, formatDuration } from './doubao-quota.ts'
import { DOUBAO_MODELS, findDoubaoModel, findReasoningLevel } from './doubao-catalog.ts'

interface Options {
  prompt: string
  json: boolean
  /** Legacy flag kept so older invocations still parse; superseded by --thinking. */
  deepThink: boolean
  timeoutMs: number
  /** `model_item_key` to request; undefined keeps the app default (自动). */
  modelKey?: string | undefined
  /** Reasoning level id. */
  reasoningLevel?: string | undefined
}

function parseArgs(argv: string[]): Options {
  const options: Options = { prompt: 'hi', json: false, deepThink: false, timeoutMs: 120_000 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--prompt' || arg === '-p') options.prompt = argv[++i] ?? options.prompt
    else if (arg === '--json') options.json = true
    else if (arg === '--deep-think') options.deepThink = true
    // --model takes a real model_item_key (seed-lite-7b, 5, 3 or 9).
    else if (arg === '--model' || arg === '-m') options.modelKey = argv[++i] ?? options.modelKey
    else if (arg === '--thinking' || arg === '-t') {
      const value = argv[++i]
      if (value !== 'low' && value !== 'mid' && value !== 'high') {
        throw new Error(`--thinking expects low|mid|high, got "${value}"`)
      }
      options.reasoningLevel = value
    }
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++i]) || options.timeoutMs
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: cli-probe [--prompt <text>] [--model <key>] [--thinking <low|mid|high>]\n' +
        '                 [--json] [--timeout <ms>]\n\n' +
        `  --model      one of: ${DOUBAO_MODELS.map((m) => `${m.id} (${m.name})`).join(', ')}\n` +
        '  --thinking   reasoning effort; default matches the desktop app\n',
      )
      process.exit(0)
    }
  }
  return options
}

function fmt(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2))
  const out = options.json ? (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + '\n') : (v: unknown) => process.stdout.write(fmt(v) + '\n')

  const credentials = loadDoubaoCredentials()
  if (!credentials.ok) {
    out(options.json
      ? { ok: false, stage: 'credentials', error: credentials.reason }
      : `FAIL credentials: ${credentials.reason}`)
    return 2
  }
  // Only counts and names are ever surfaced — never values.
  out(options.json
    ? { event: 'credentials', ok: true, cookieCount: credentials.pairs.size, profile: describeProfileLocation() }
    : `credentials: ${credentials.pairs.size} cookies from ${describeProfileLocation()}`)

  const account = await probeAccount(credentials)
  out(options.json ? { event: 'account', ...account } : `account: ${account.ok ? 'signed in' : account.detail}`)
  if (!account.ok) {
    out(options.json ? { ok: false, stage: 'account', error: account.detail } : `FAIL account: ${account.detail}`)
    return 3
  }

  const quota = await fetchQuota({ force: true })
  const fiveHour = findWindow(quota, 'five_hour')
  const weekly = findWindow(quota, 'weekly')
  out(options.json
    ? {
        event: 'quota',
        plan: quota.plan ?? null,
        planActive: quota.planActive ?? null,
        exhausted: quota.exhausted,
        fiveHour: fiveHour
          ? { usedPercent: fiveHour.usedPercent, remainingPercent: fiveHour.remainingPercent, resetsIn: formatDuration(millisUntilReset(fiveHour)) }
          : null,
        weekly: weekly
          ? { usedPercent: weekly.usedPercent, remainingPercent: weekly.remainingPercent, resetsIn: formatDuration(millisUntilReset(weekly)) }
          : null,
        error: quota.error ?? null,
      }
      : [
          `quota: ${quota.plan ?? 'unknown plan'}${quota.planActive === false ? ' (inactive)' : ''}`,
          `  5-hour limit : ${fiveHour ? `${fiveHour.usedPercent}% used, resets in ${formatDuration(millisUntilReset(fiveHour))}` : 'n/a'}`,
          `  weekly quota : ${weekly ? `${weekly.usedPercent}% used, resets in ${formatDuration(millisUntilReset(weekly))}` : 'n/a'}`,
        ].join('\n'))

  if (quota.exhausted) {
    out(options.json ? { ok: false, stage: 'quota', error: 'quota exhausted' } : 'FAIL quota exhausted; no request sent')
    return 4
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  const requestedModel = findDoubaoModel(options.modelKey)
  const requestedLevel = findReasoningLevel(options.reasoningLevel)
  out(options.json
    ? {
        event: 'request',
        model_item_key: requestedModel.id,
        model_name: requestedModel.name,
        reasoning_effort: requestedLevel.level,
        reasoning_level: requestedLevel.id,
        // Only 高 was observed on a real request; the others are the documented
        // 10000+level shape and are NOT confirmed.
        reasoning_verified: requestedLevel.verified,
      }
    : `requesting: model=${requestedModel.id} (${requestedModel.name})  thinking=${requestedLevel.name}${requestedLevel.verified ? '' : ' [unverified]'}`)

  try {
    const result = await streamChat(options.prompt, {
      // Spread rather than assign: with exactOptionalPropertyTypes an explicit
      // `undefined` is not the same as omitting the key.
      ...options.modelKey === undefined ? {} : { modelKey: options.modelKey },
      ...options.reasoningLevel === undefined
        ? {}
        : { reasoningLevel: options.reasoningLevel as 'low' | 'mid' | 'high' },
      signal: controller.signal,
      credentials,
      callbacks: {
        onEvent: (event) => {
          if (!options.json) process.stderr.write(`  event ${event}\n`)
        },
      },
    })

    out(options.json
      ? {
          event: 'completion',
          ok: true,
          prompt: options.prompt,
          requested_model: requestedModel.id,
          // What the server says answered — an opaque internal tag, NOT the
          // model_item_key we asked for.
          reported_model_tag: result.model ?? null,
          reasoning_effort: requestedLevel.level,
          thinking: result.thinking,
          conversationId: result.conversationId ?? null,
          messageId: result.messageId ?? null,
          text: result.text,
        }
      : [
          '',
          '--- completion ---',
          `requested: ${requestedModel.id} (${requestedModel.name})`,
          `server tag: ${result.model ?? 'not reported'}`,
          `thinking : ${result.thinking} (effort ${requestedLevel.level}${requestedLevel.verified ? '' : ', unverified'})`,
          `reply    : ${result.text}`,
        ].join('\n'))
    return 0
  } catch (error) {
    if (error instanceof DoubaoUpstreamError) {
      out(options.json
        ? { ok: false, stage: 'completion', code: error.code ?? null, rateLimited: error.rateLimited, error: error.message }
        : `FAIL completion${error.code ? ` [${error.code}]` : ''}: ${error.message}`)
      return error.rateLimited ? 5 : 1
    }
    out(options.json
      ? { ok: false, stage: 'completion', error: (error as Error).message }
      : `FAIL completion: ${(error as Error).message}`)
    return 1
  } finally {
    clearTimeout(timer)
  }
}

export { main }

// Windows consoles default to a legacy code page; force UTF-8 so CJK plan
// names and emoji in replies are not mangled.
process.stdout.setDefaultEncoding('utf8')

// Only self-execute when this module is the process entrypoint, so the plugin
// bin can import `main` without running a probe as a side effect.
if (process.argv[1] && /cli-probe\.(js|ts|mjs)$/.test(process.argv[1])) {
  main().then(
    (code) => { process.exitCode = code },
    (error: unknown) => {
      process.stderr.write(`probe crashed: ${(error as Error).message}\n`)
      process.exitCode = 1
    },
  )
}
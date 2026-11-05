import { describe, expect, it } from 'vitest'

import { findWindow, millisUntilReset, normalizeWindow, type DoubaoQuota } from '../src/doubao-quota.ts'

/**
 * The payload shape this account actually receives, captured from the live
 * quota endpoint:
 *
 * - one window only (`window_type: 2`, the weekly quota): a plan that simply
 *   does not sell a five-hour bucket
 * - `start_time` / `end_time` both 0, i.e. no reset instant at all
 * - amounts as formatted strings ("2,100"), with `used_percent` also present
 *
 * The old normalizer turned the zeroed timestamps into "resets one period from
 * now", which was wrong by up to a week, and it ignored the amounts.
 */
const WEEKLY_ONLY = {
  end_time: 0,
  start_time: 0,
  item_type: 0,
  less_than_one_percent: false,
  total_amount: '2,100',
  used_amount: '0',
  used_percent: 0,
  window_type: 2,
}

function quotaOf(...windows: ReturnType<typeof normalizeWindow>[]): DoubaoQuota {
  return {
    exhausted: false,
    windows: windows.filter((window) => window !== undefined),
    fetchedAt: 1,
  }
}

describe('normalizeWindow', () => {
  it('keeps the weekly window and never invents a reset instant', () => {
    const window = normalizeWindow(WEEKLY_ONLY, 1_000)
    expect(window).toBeDefined()
    expect(window?.type).toBe('weekly')
    expect(window?.usedPercent).toBe(0)
    expect(window?.remainingPercent).toBe(100)
    // No timestamps means the instant is unknown — not "seven days from now".
    expect(window?.resetUnknown).toBe(true)
    expect(window?.resetsAt).toBe(0)
    expect(window?.windowMs).toBe(0)
    expect(millisUntilReset(window!, 1_000)).toBe(0)
  })

  it('parses the formatted amounts', () => {
    const window = normalizeWindow(WEEKLY_ONLY)
    expect(window?.usedAmount).toBe(0)
    expect(window?.totalAmount).toBe(2100)
  })

  it('derives the percentage from amounts when used_percent is absent', () => {
    const window = normalizeWindow({ ...WEEKLY_ONLY, used_percent: undefined, used_amount: '1,050' })
    expect(window?.usedPercent).toBeCloseTo(50)
    expect(window?.remainingPercent).toBeCloseTo(50)
  })

  it('prefers a reported used_percent over the amounts', () => {
    const window = normalizeWindow({ ...WEEKLY_ONLY, used_percent: 12, used_amount: '1,050' })
    expect(window?.usedPercent).toBe(12)
  })

  it('clamps a percentage derived from amounts into 0-100', () => {
    const window = normalizeWindow({ ...WEEKLY_ONLY, used_percent: undefined, used_amount: '9,999' })
    expect(window?.usedPercent).toBe(100)
  })

  it('keeps the reported window when timestamps are real', () => {
    const start = 1_000
    const end = 604_801_000
    const window = normalizeWindow({ ...WEEKLY_ONLY, start_time: start, end_time: end }, 2_000)
    expect(window?.resetUnknown).toBeUndefined()
    expect(window?.resetsAt).toBe(end)
    expect(window?.startedAt).toBe(start)
    expect(window?.windowMs).toBe(end - start)
    expect(millisUntilReset(window!, 2_000)).toBe(end - 2_000)
  })

  it('ignores window types it does not model', () => {
    expect(normalizeWindow({ ...WEEKLY_ONLY, window_type: 3 })).toBeUndefined()
  })
})

describe('findWindow', () => {
  it('reports a missing five-hour bucket as undefined, not as zero usage', () => {
    const quota = quotaOf(normalizeWindow(WEEKLY_ONLY))
    expect(findWindow(quota, 'five_hour')).toBeUndefined()
    expect(findWindow(quota, 'weekly')?.totalAmount).toBe(2100)
  })
})
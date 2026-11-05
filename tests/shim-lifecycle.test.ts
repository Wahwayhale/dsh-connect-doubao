/**
 * Cancellation reaches the upstream socket, and a silent stream has a way out.
 *
 * The response object is faked down to the four members the lifecycle touches;
 * the point is the contract, not HTTP plumbing: a client that leaves aborts the
 * turn, a response that already finished does not, and a stream that stops
 * sending is aborted after the idle window instead of holding the request open
 * until the host gives up.
 */
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequestLifecycle } from '../src/doubao-shim.ts'

class FakeResponse extends EventEmitter {
  writableEnded = false
  destroyed = false
}

function fakeRes(): { res: ServerResponse; fake: FakeResponse } {
  const fake = new FakeResponse()
  return { res: fake as unknown as ServerResponse, fake }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(() => {
  vi.useRealTimers()
})

describe('request lifecycle', () => {
  it('aborts upstream when the client hangs up', () => {
    const { res, fake } = fakeRes()
    const lifecycle = createRequestLifecycle(res, { idleMs: 10_000 })
    expect(lifecycle.signal.aborted).toBe(false)

    fake.emit('close')
    expect(lifecycle.signal.aborted).toBe(true)
    expect(lifecycle.clientGone()).toBe(true)
    lifecycle.release()
  })

  it('does not abort when close follows a finished response', () => {
    const { res, fake } = fakeRes()
    const lifecycle = createRequestLifecycle(res, { idleMs: 10_000 })
    // The normal path: the response ends, then Node closes it.
    fake.writableEnded = true
    fake.emit('close')
    expect(lifecycle.signal.aborted).toBe(false)
    expect(lifecycle.clientGone()).toBe(false)
  })

  it('gives up on a stream that stops sending', async () => {
    const { res } = fakeRes()
    const lifecycle = createRequestLifecycle(res, { idleMs: 5 })
    await sleep(20)
    expect(lifecycle.signal.aborted).toBe(true)
    expect((lifecycle.signal.reason as Error).message).toMatch(/没有返回任何数据/)
    lifecycle.release()
  })

  it('keeps waiting while upstream keeps talking', async () => {
    const { res } = fakeRes()
    const lifecycle = createRequestLifecycle(res, { idleMs: 20 })
    // A delta every 5ms is proof of life; without the reset this would have been
    // aborted at the first 20ms boundary.
    for (let i = 0; i < 4; i += 1) {
      await sleep(5)
      expect(lifecycle.signal.aborted).toBe(false)
      lifecycle.onActivity()
    }
    lifecycle.release()
    await sleep(30)
    // release disarms: nothing fires after the request is over.
    expect(lifecycle.signal.aborted).toBe(false)
  })

  it('stops listening once released', () => {
    const { res, fake } = fakeRes()
    const lifecycle = createRequestLifecycle(res, { idleMs: 10_000 })
    lifecycle.release()
    fake.emit('close')
    expect(lifecycle.signal.aborted).toBe(false)
  })
})
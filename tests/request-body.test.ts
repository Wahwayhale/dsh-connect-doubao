/**
 * The request body, pinned against a CDP-captured client request.
 *
 * WHY THIS FILE EXISTS. On 2026-10-22 every turn from this plugin failed with
 * `710010702` while the Doubao app answered fine on the same account, same
 * device, same cookies. The cause was one constant: `agent_mode` is 2 for
 * ordinary chat and 1 for 「工作任务」, and the plugin sent 1 — so the server
 * handed every request to `Agent-GeneralTask`, whose executing runtime lives
 * inside the desktop client and cannot be reached from outside.
 *
 * Nothing in the existing suite could have caught that: the client-bundle test
 * checks how the browser half LOADS, not what the provider ASKS FOR. A wrong
 * value here is silent — the request is well-formed, the stream answers, and
 * the failure only shows up as a business error deep in the SSE frames.
 *
 * So these assertions are deliberately literal. They are transcribed from the
 * captured request, not derived from the constants: a test that recomputes the
 * expected value from the same constant it is checking cannot fail.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { buildChatBody } from '../src/doubao-upstream.ts'
import { DOUBAO_MODELS } from '../src/doubao-catalog.ts'

/** A body for the default chat turn. */
function body(overrides: Record<string, unknown> = {}) {
  return buildChatBody('hello', overrides) as Record<string, any>
}

afterEach(() => {
  delete process.env.DSH_DOUBAO_TASK
  delete process.env.DSH_DOUBAO_MODE_ID
})

describe('chat mode is what the desktop client actually sends', () => {
  it('sends agent_mode 2 — NOT 1 (the 710010702 regression)', () => {
    const b = body()
    // Literal on purpose: 2 is the captured value. 1 means 「工作任务」.
    expect(b.option.agent_mode).toBe(2)
    expect(b.ext.agent_mode).toBe('2')
    expect(b.option.aggregate_params.agent_mode).toBe('2')
  })

  it('leaves need_deep_think at 0 and keeps the level in reasoning_effort', () => {
    const b = body()
    expect(b.option.need_deep_think).toBe(0)
    expect(b.ext.use_deep_think).toBe('0')
    // Default level is 高 → 5, carried by reasoning_effort, mirrored three ways.
    expect(b.option.model_config.reasoning_effort).toBe(5)
    expect(b.option.aggregate_params.reasoning_effort).toBe('5')
    expect(b.option.conversation_init_ext.reasoning_effort).toBe('5')
  })

  it('declares model + mode + effort in conversation_init_ext', () => {
    const b = body({ modelKey: '3' })
    expect(b.option.conversation_init_ext).toEqual({
      model_item_key: '3',
      reasoning_effort: '5',
      mode_id: '1',
    })
    expect(b.option.aggregate_params.mode_id).toBe('1')
  })

  it('carries the client default general_task_param as OBJECT + STRING pair', () => {
    const b = body()
    expect(b.option.general_task_param).toEqual({ server_do_compare: true })
    expect(b.ext.general_task_param).toBe(JSON.stringify({ server_do_compare: true }))
  })

  it('does not send the invented compatibility markers from the guessing phase', () => {
    const b = body()
    // Each of these was added while hunting the bug, none appears in the capture.
    for (const key of ['general_agent', 'cot_switch', 'bot_source', 'llm_intention', 'chat_ability']) {
      expect(b.ext).not.toHaveProperty(key)
    }
  })

  it('leaves model_extra_params empty, as the client does', () => {
    expect(body().option.model_config.model_extra_params).toEqual({})
  })

  it('reports the client permissions the app echoes', () => {
    expect(body().client_meta.local_permissions).toHaveLength(3)
  })

  it('starts a new conversation every turn', () => {
    expect(body().option.need_create_conversation).toBe(true)
    expect(body().option.conversation_init_option).toEqual({ need_ack_conversation: true })
  })
})

describe('task mode stays opt-in and keeps its own shape', () => {
  it('is off by default', () => {
    expect(body().option.agent_mode).toBe(2)
  })

  it('flips to agent_mode 1 with the local-PC runtime when asked', () => {
    const b = body({ taskMode: true })
    expect(b.option.agent_mode).toBe(1)
    expect(b.ext.agent_mode).toBe('1')
    const param = JSON.parse(b.ext.general_task_param)
    expect(param.runtime_type).toBe(2) // 2 = Local_PC, 1 = Cloud_VM
    expect(param.client_option.enable_sandbox).toBe(true)
    // `option` carries the object; `ext` carries the stringified copy.
    expect(b.option.general_task_param).toEqual(param)
  })

  it('can be enabled by environment for a probe run', () => {
    process.env.DSH_DOUBAO_TASK = '1'
    expect(body().option.agent_mode).toBe(1)
  })
})

describe('the advertised catalog is only what actually works', () => {
  it('offers exactly the two 对话-mode entries', () => {
    expect(DOUBAO_MODELS.map((m) => m.id)).toEqual(['0', '3'])
  })

  it('does not advertise the 工作任务-only models', () => {
    const ids = DOUBAO_MODELS.map((m) => m.id)
    for (const unavailable of ['5', 'seed-lite-7b', '9', '4']) {
      expect(ids).not.toContain(unavailable)
    }
  })
})

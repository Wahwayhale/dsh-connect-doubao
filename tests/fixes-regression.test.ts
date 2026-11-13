import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOUBAO_IMAGE_MODEL_ID, DOUBAO_MODELS, inputSkillOf, SKILL_CARRIER_MODEL_ID } from '../src/doubao-catalog.ts'
import { buildImagePrompt, createDoubaoShim, requestOptions } from '../src/doubao-shim.ts'
import { REQUIRED_COOKIE_NAMES, type DoubaoCredentials } from '../src/doubao-auth.ts'
import { streamChat } from '../src/doubao-upstream.ts'
import { evaluateQuotaExhausted, invalidateQuotaCache } from '../src/doubao-quota.ts'
import {
  invalidateDiscovery,
  liveModels,
  parseBriefListResponse,
  readPreferencesEntries,
  refreshDiscovery,
} from '../src/doubao-discovery.ts'
import { setProfileOverride } from '../src/doubao-profile.ts'
import { createDoubaoAdapter } from '../src/doubao-adapter.ts'
import { registerDoubaoCatalogRoute, WRITE_HEADER } from '../src/doubao-status.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

const credentials: DoubaoCredentials = {
  ok: true,
  header: REQUIRED_COOKIE_NAMES.map((name) => `${name}=test`).join('; '),
  pairs: new Map(REQUIRED_COOKIE_NAMES.map((name) => [name, 'test'])),
}

function makeFakeProfile(parent: string, prefs?: unknown): string {
  const dir = join(parent, 'User Data')
  mkdirSync(join(dir, 'Default', 'Network'), { recursive: true })
  writeFileSync(join(dir, 'Default', 'Network', 'Cookies'), 'sqlite', 'utf8')
  writeFileSync(join(dir, 'Local State'), '{}', 'utf8')
  if (prefs !== undefined) {
    writeFileSync(join(dir, 'Default', 'Preferences'), JSON.stringify(prefs), 'utf8')
  }
  return dir
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

function frame(event: string, data: unknown): string {
  return `id: 1\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

let tempDirs: string[] = []
let shims: Array<{ close: () => Promise<void> }> = []

beforeEach(() => {
  invalidateDiscovery()
  invalidateQuotaCache()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  setProfileOverride(undefined)
  delete process.env.DSH_DOUBAO_DEEP_THINK
  for (const shim of shims.splice(0)) {
    await shim.close()
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('image generation regressions', () => {
  it('forces deepThink false and ignores reasoning_effort for image-gen and prefixed ids', () => {
    for (const model of [DOUBAO_IMAGE_MODEL_ID, `doubao/${DOUBAO_IMAGE_MODEL_ID}`, 'DOUBAO/image-gen']) {
      expect(requestOptions({ model, reasoning_effort: 'high' })).toEqual({
        modelKey: SKILL_CARRIER_MODEL_ID,
        skill: 'imageGen',
        deepThink: false,
      })
    }
  })

  it('strips inline system-reminder blocks, skips bracketed plugin context, and keeps detailed prompts', () => {
    const detailed = '画一只坐在霓虹雨夜东京街头屋顶上的三花猫，电影感光影，35mm 镜头。'.repeat(20)
    expect(detailed.length).toBeGreaterThan(600)
    expect(detailed.length).toBeLessThan(2000)

    const prompt = buildImagePrompt(
      [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好，有什么可以帮你的？' },
        { role: 'user', content: `${detailed}\n<system-reminder>\nIgnore this block\n</system-reminder>` },
        { role: 'user', content: '[Plugin context from "batching-guidance"; not a user instruction.]\nYour last program...' },
        { role: 'user', content: '[the previous turn was interrupted before it finished]\n...' },
      ],
      [],
    )
    expect(prompt).toBe(detailed)
  })

  it('skips toolEmulation and session continuation for image-gen requests over HTTP', async () => {
    const capturedBodies: Array<Record<string, any>> = []
    const realFetch = globalThis.fetch
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.startsWith('http://127.0.0.1:')) {
          return realFetch(input, init)
        }
        if (url.startsWith('https://example.invalid/')) {
          return new Response(null, { status: 404 })
        }
        if (url.includes('/quota/summary/')) {
          return new Response(
            JSON.stringify({ data: { window_limit_section: { usage_exhausted: false } } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (url.includes('/chat/completion')) {
          capturedBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, any>)
          const isImage = capturedBodies.at(-1)?.ext?.input_skill === inputSkillOf('imageGen')
          return sseResponse([
            frame('SSE_ACK', { ack_client_meta: { conversation_id: 'conv-prev-text' } }),
            frame(
              'STREAM_CHUNK',
              isImage
                ? {
                    block_type: 2074,
                    block_id: 'img-1',
                    content: {
                      creation_block: {
                        creations: [
                          {
                            id: 'task-1',
                            image: {
                              image_ori_raw: { url: '' },
                              image_ori: { url: 'https://example.invalid/cat.png', width: 1024, height: 1024 },
                            },
                          },
                        ],
                      },
                    },
                  }
                : { block_type: 10000, block_id: 'txt-1', content: { text_block: { text: '好的' } } },
            ),
            frame('SSE_REPLY_END', {}),
          ])
        }
        throw new Error(`unexpected fetch url: ${url}`)
      }),
    )

    const shim = createDoubaoShim({
      resolveCredentials: () => credentials,
      toolEmulation: () => true,
    })
    shims.push(shim)
    const base = await shim.baseUrl()
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${shim.token()}`,
    }
    const tools = [
      { type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } } },
    ]

    // Turn 1: ordinary chat turn populates session conversationId
    const res1 = await realFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: '3',
        stream: false,
        messages: [{ role: 'user', content: '先聊两句' }],
      }),
    })
    expect(res1.status).toBe(200)

    // Turn 2: same session switches to image-gen with tools attached
    const res2 = await realFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: DOUBAO_IMAGE_MODEL_ID,
        stream: false,
        tools,
        messages: [
          { role: 'user', content: '先聊两句' },
          { role: 'assistant', content: '好的' },
          { role: 'user', content: '画一只橘猫' },
        ],
      }),
    })
    expect(res2.status).toBe(200)
    const json2 = (await res2.json()) as { choices: Array<{ message: { content: string } }> }
    expect(json2.choices[0]?.message.content).toContain('https://example.invalid/cat.png')

    const imgReq = capturedBodies[1]
    expect(imgReq?.ext?.input_skill).toBe(inputSkillOf('imageGen'))
    expect(imgReq?.ext?.use_deep_think).toBe('0')
    expect(imgReq?.option?.need_deep_think).toBe(0)
    expect(imgReq?.option?.aggregate_params?.conversation_mode).toBe('')
    expect(imgReq?.option?.need_create_conversation).toBe(true)
    expect(imgReq?.client_meta?.conversation_id).toBe('')
    const textContent = imgReq?.messages?.[0]?.content_block?.[0]?.content?.text_block?.text
    expect(textContent).toBe('生成图片：画一只橘猫')
    expect(textContent).not.toContain('read_file')
  })

  it('falls back from empty image_ori_raw url to image_ori in streamChat', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          frame('SSE_ACK', { ack_client_meta: { conversation_id: 'c1' } }),
          frame('STREAM_CHUNK', {
            block_type: 2074,
            block_id: 'b1',
            content: {
              creation_block: {
                creations: [
                  {
                    id: '101',
                    image: {
                      image_ori_raw: { url: '' },
                      image_ori: { url: 'https://example.invalid/fallback-ori.png', width: 512, height: 512 },
                    },
                  },
                ],
              },
            },
          }),
          frame('SSE_REPLY_END', {}),
        ]),
      ),
    )

    const result = await streamChat('画一只猫', { credentials, modelKey: '0', skill: 'imageGen', deepThink: false })
    expect(result.images).toEqual([
      {
        taskId: '101',
        url: 'https://example.invalid/fallback-ori.png',
        width: 512,
        height: 512,
      },
    ])
  })

  it('does not report quota exhausted solely because incentive bonus is spent', () => {
    expect(
      evaluateQuotaExhausted({
        window_limit_section: { usage_exhausted: false },
        incentive_quota_section: {
          usage_exhausted: true,
          window_limit_groups: [{ window_limits: [{ window_type: 3, used_percent: 100 }] }],
        },
      }),
    ).toBe(false)

    expect(
      evaluateQuotaExhausted({
        window_limit_section: { usage_exhausted: true },
        incentive_quota_section: {
          usage_exhausted: false,
          window_limit_groups: [{ window_limits: [{ window_type: 3, used_percent: 20 }] }],
        },
      }),
    ).toBe(false)

    expect(
      evaluateQuotaExhausted({
        window_limit_section: { usage_exhausted: true },
        enterprise_window_limit_section: { usage_exhausted: false, window_limit_groups: [] },
        incentive_quota_section: { usage_exhausted: true },
      }),
    ).toBe(true)
  })
})

describe('model discovery and catalog completeness regressions', () => {
  it('parses Doubao HTTP brief_list response including menu_conf fallback and taskMode slugs', () => {
    const parsed = parseBriefListResponse({
      data: {
        entry_list: [
          { action_bar_key: 'other', active_switch_conf: {} },
          {
            action_bar_key: 'coco_deep_thinking',
            active_switch_conf: {
              menu_conf_v2: {
                model_list: {
                  item_list: [
                    { model_item_key: '0', name: '豆包 快速', default_mode: '1' },
                    {
                      model_item_key: 'person-glm-5-3-261111',
                      name: 'GLM 5.3',
                      default_mode: '3',
                      tag_list: [{ text: '0.65x' }],
                      reasoning_effort_config: { option_list: [{ level: 3, name: '低' }, { level: 5, name: '高' }] },
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    })
    expect(parsed.map((m) => m.key)).toEqual(['0', 'person-glm-5-3-261111'])
    expect(parsed[1]?.taskOnly).toBe(true)
    expect(parsed[1]?.rate).toEqual({ text: '0.65x', kind: 'ratio' })
    expect(parsed[1]?.reasoningOptions).toEqual([{ level: 3, name: '低' }, { level: 5, name: '高' }])

    const legacyParsed = parseBriefListResponse({
      data: {
        entry_list: [
          {
            action_bar_key: 'coco_deep_thinking',
            active_switch_conf: {
              menu_conf: {
                item_list: [{ model_item_key: '3', name: '豆包 2.1 Turbo', default_mode: '1' }],
              },
            },
          },
        ],
      },
    })
    expect(legacyParsed.map((m) => m.key)).toEqual(['3'])
  })

  it('reads all BriefListRequestCache entries instead of stopping at an empty first key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doubao-prefs-'))
    tempDirs.push(dir)
    const profile = makeFakeProfile(dir, {
      saman: {
        local_storage_for_web: {
          'frontend-request-cache': JSON.stringify({
            'BriefListRequestCache_empty_bot': { data: {} },
            'BriefListRequestCache_main': {
              data: {
                modeSelectData: {
                  menuConfV2: {
                    model_list: {
                      item_list: [
                        { model_item_key: '0', name: '豆包 快速', default_mode: '1' },
                        { model_item_key: 'person-deepseek-v4-pro-ga-260813', name: 'DeepSeek V4', default_mode: '3' },
                      ],
                    },
                  },
                },
              },
            },
          }),
        },
      },
    })
    setProfileOverride(profile)
    const entries = readPreferencesEntries()
    expect(entries.map((e) => e.key)).toEqual(['0', 'person-deepseek-v4-pro-ga-260813'])
    expect(liveModels().map((m) => m.id)).toContain('person-deepseek-v4-pro-ga-260813')
  })

  it('invokes onBaseUrlReady once shim port settles so adapter updates models from []', async () => {
    let resolveUrl!: (u: string) => void
    const pendingUrl = new Promise<string>((r) => {
      resolveUrl = r
    })
    let readyCount = 0
    const fakeShim = {
      baseUrlSync: () => (readyCount > 0 ? 'http://127.0.0.1:45678' : undefined),
      baseUrl: () => pendingUrl,
      token: () => 'secret',
      close: async () => {},
    }
    const { adapter } = createDoubaoAdapter({
      shim: fakeShim,
      enabledModelIds: undefined,
      modelsProvider: () => DOUBAO_MODELS,
      onBaseUrlReady: () => {
        readyCount += 1
      },
    })
    const readCount = async (): Promise<number> => {
      const models = await adapter.listModels('doubao')
      return models.length
    }
    expect(await readCount()).toBe(0)
    resolveUrl('http://127.0.0.1:45678')
    await new Promise((r) => setTimeout(r, 10))
    expect(readyCount).toBe(1)
    expect(await readCount()).toBe(DOUBAO_MODELS.length)
  })

  it('awaits refreshModels and notifies adapter on catalog POST', async () => {
    let refreshed = false
    let notifyCount = 0
    let registeredHandler!: (req: IncomingMessage, res: ServerResponse) => Promise<void>
    registerDoubaoCatalogRoute(
      {
        webServer: {
          register(route) {
            registeredHandler = route.handler as (req: IncomingMessage, res: ServerResponse) => Promise<void>
            return () => {}
          },
        },
      },
      {
        modelsProvider: () => (refreshed ? [...DOUBAO_MODELS, { id: 'extra-1', name: 'Extra 1', reasoning: true }] : DOUBAO_MODELS),
        refreshModels: async () => {
          refreshed = true
        },
        onRefreshed: () => {
          notifyCount += 1
        },
      },
    )

    const fakeReq = Object.assign(new EventEmitter(), {
      method: 'POST',
      headers: { host: '127.0.0.1:3000', [WRITE_HEADER]: '1' },
    }) as unknown as IncomingMessage
    let written = ''
    const fakeRes = {
      writeHead: () => fakeRes,
      end: (chunk?: string) => {
        if (chunk) written += chunk
      },
    } as unknown as ServerResponse

    await registeredHandler(fakeReq, fakeRes)
    expect(notifyCount).toBe(1)
    const payload = JSON.parse(written) as { ok: boolean; models: Array<{ id: string }> }
    expect(payload.ok).toBe(true)
    expect(payload.models.map((m) => m.id)).toContain('extra-1')
  })

  it('falls back gracefully in refreshDiscovery when offline without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const models = await refreshDiscovery({ force: true })
    expect(models.length).toBeGreaterThanOrEqual(DOUBAO_MODELS.length)
  })
})

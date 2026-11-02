/**
 * Prompt-level tool calling for a provider that has no tool channel.
 *
 * WHY THIS EXISTS. Doubao's `/chat/completion` silently ignores an OpenAI-style
 * `tools` array — measured 2026-10-22: the request succeeded, the model used its
 * OWN server-side skills (a 「正在搜索」 block appeared) and never once referenced
 * the functions we declared. A bogus `model_item_key` is accepted the same way,
 * so this is not validation we can trigger: the field simply is not read.
 *
 * So the tools are carried in the only channel that IS read — the prompt text —
 * and the model's answer is parsed back into standard `tool_calls`. This is a
 * simulation, and it is labelled as one everywhere it can be: it is opt-in
 * (`toolEmulation`, default off) because it is not native and can degrade when
 * the upstream model changes its output habits.
 *
 * WHAT WAS MEASURED (2026-11-02, scripts/tool-emul-probe.mjs):
 *   9 tool calls across 5 task rounds · 0 malformed JSON · 1 duplicate call
 *   5/5 rounds converged · ~11.5s per round
 * The failure mode is repetition (there is no native stop token), not
 * malformation — hence {@link dedupeCalls} and the caller's step budget.
 *
 * @module dsh-connect-doubao/tools
 */

/** One inbound OpenAI tool definition, as pi-ai sends it. */
export interface InboundTool {
  type?: string
  function?: {
    name?: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

/** A tool call the model asked for. */
export interface EmulatedToolCall {
  id: string
  name: string
  /** JSON string, because that is the OpenAI wire shape. */
  arguments: string
}

/** The fence the model is told to use, and that we parse back. */
export const TOOL_FENCE_LANGUAGE = 'doubao-tool'

const FENCE_RE = new RegExp(
  `^\\s*\`\`\`\\s*${TOOL_FENCE_LANGUAGE}\\s*\\r?\\n([\\s\\S]*?)\\r?\\n\\s*\`\`\`\\s*`,
  'm',
)

/**
 * Render the tool contract appended to the prompt.
 *
 * Deliberately blunt and short: every extra sentence is another thing a future
 * model revision can ignore. The rules that matter are "exactly one call",
 * "valid JSON", and "stop when done" — the measured failure mode was repeating
 * a call, so the no-repeat instruction is stated outright.
 */
export function buildToolContract(tools: readonly InboundTool[]): string {
  const usable = tools
    .map((tool) => tool.function?.name)
    .filter((name): name is string => typeof name === 'string' && name !== '')
  if (usable.length === 0) return ''
  const lines = tools
    .filter((tool) => typeof tool.function?.name === 'string')
    .map((tool) => {
      const fn = tool.function
      const schema = fn?.parameters === undefined ? '' : ` 参数: ${JSON.stringify(fn.parameters)}`
      const desc = fn?.description === undefined ? '' : ` — ${fn.description}`
      return `- ${fn?.name}${desc}${schema}`
    })
  return [
    '',
    '',
    '你可以调用下列工具来完成任务：',
    ...lines,
    '',
    '需要调用工具时，只输出一个代码围栏，语言标记为 ' + TOOL_FENCE_LANGUAGE + '，' +
      '围栏内放恰好一个 JSON 对象：{"name":"<工具名>","arguments":{...}}。',
    '一次只调用一个工具；JSON 必须严格合法（双引号、无注释、无尾逗号）。',
    '执行结果会以 [tool result] 开头的消息回给你，然后你继续推进。',
    '不要重复刚刚已经做过的调用。任务完成时不要输出围栏，直接给出简短结论。',
  ].join('\n')
}

/**
 * Split a model reply into tool calls and the text the user should see.
 *
 * The fence is REMOVED from the visible text: a tool call is not prose, and
 * leaving it in would show the user JSON they never asked to read.
 *
 * Malformed JSON inside a fence is dropped rather than thrown — the caller still
 * has the remaining text, and a hard failure here would turn a half-good answer
 * into an error.
 */
export function parseToolCalls(
  text: string,
  makeId: (index: number) => string = (i) => `call_${Date.now()}_${i}`,
): { calls: EmulatedToolCall[]; text: string } {
  const calls: EmulatedToolCall[] = []
  let rest = text
  for (;;) {
    const match = FENCE_RE.exec(rest)
    if (match === null) break
    const raw = (match[1] ?? '').trim()
    rest = (rest.slice(0, match.index) + rest.slice(match.index + match[0].length)).trim()
    const parsed = parseCallJson(raw)
    if (parsed !== undefined) {
      calls.push({ id: makeId(calls.length), ...parsed })
    }
  }
  return { calls: dedupeCalls(calls), text: rest }
}

/** Parse one fence body into a call, or undefined when it is not usable. */
function parseCallJson(raw: string): { name: string; arguments: string } | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const name = record.name ?? record.tool ?? record.function
  if (typeof name !== 'string' || name === '') return undefined
  const args = record.arguments ?? record.params ?? record.input ?? {}
  const serialized = typeof args === 'string' ? args : JSON.stringify(args)
  if (!isLikelyJsonObject(serialized)) return undefined
  return { name, arguments: serialized }
}

function isLikelyJsonObject(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '') return true
  return trimmed.startsWith('{') && trimmed.endsWith('}')
}

/**
 * Drop calls repeated within the same reply.
 *
 * The model occasionally emits the same call twice in one turn; executing it
 * twice is at best wasteful and at worst destructive (a second write of the
 * same file with different content).
 */
export function dedupeCalls(calls: readonly EmulatedToolCall[]): EmulatedToolCall[] {
  const seen = new Set<string>()
  const out: EmulatedToolCall[] = []
  for (const call of calls) {
    const key = `${call.name}\u0000${call.arguments}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(call)
  }
  return out
}

/**
 * Fold a tool result into the flattened prompt.
 *
 * Doubao's endpoint takes one text block, so the OpenAI `role: "tool"` message
 * has to become text. The `[tool result]` prefix is what the contract above
 * promises, and it is what the probe measured against.
 */
export function toolResultAsText(name: string | undefined, content: unknown): string {
  const body = typeof content === 'string' ? content : JSON.stringify(content ?? '')
  return `[tool result] ${name === undefined ? '' : `${name}: `}${body}`
}

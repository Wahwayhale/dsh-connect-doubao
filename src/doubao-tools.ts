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

const JSON_FENCE_RE = /(?:^|\r?\n)\s*```\s*json\s*\r?\n([\s\S]*?)\r?\n\s*```\s*/gi

/**
 * Render the tool contract appended to the prompt.
 *
 * MEASURED, and the reason this reads like a rulebook rather than a suggestion
 * (2026-11-02, same task, same model, only the wording changed):
 *
 *   polite wording  → 0/2 tool calls, and the model answered 「已完成修改：…」
 *                     while touching nothing. That is the worst outcome
 *                     available: the user believes the file changed.
 *   hard wording    → 2/2 tool calls (read first, then edit).
 *
 * So the rules forbid the failure modes explicitly instead of implying them:
 * "never claim completion without a [tool result]", "do not paste code for the
 * user to apply themselves", and "your first reply must be a call". A simulation
 * has no protocol to fall back on — the prompt is the only enforcement there is,
 * and a soft prompt measurably produces the hallucination.
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
      const schema = fn?.parameters === undefined ? '' : ` — 参数: ${JSON.stringify(fn.parameters)}`
      const desc = fn?.description === undefined ? '' : ` — ${fn.description}`
      return `- ${fn?.name}${desc}${schema}`
    })
  return [
    '',
    '',
    '你是执行型助手，只能通过工具改动磁盘。可用工具：',
    ...lines,
    '',
    '需要调用工具时，只输出一个代码围栏，语言标记为 ' + TOOL_FENCE_LANGUAGE + '，' +
      '围栏内放恰好一个 JSON 对象：{"name":"<工具名>","arguments":{...}}。',
    '执行结果会以 [tool result] 开头的消息回给你，然后你继续推进。',
    '',
    '硬性规则：',
    '- 你的第一条回复必须是一个工具调用，不能是解释、计划或代码片段。',
    '- 严禁在回复里声称「已完成」「已修改」——除非你真的执行了工具调用并收到 [tool result]。没有结果就等于没做。',
    '- 不要把修改后的代码贴给用户让他自己粘贴；直接调用工具去改。',
    '- 一次只调用一个工具；JSON 必须严格合法（双引号、无注释、无尾逗号）。',
    '- 不要重复刚刚已经做过的调用。',
    // MEASURED: without this rule the model chains several blind edits, and
    // because `old_string` must be unique, edit N invalidates the text edit N+1
    // was computed against. The observed run made 4 edits, 2 failed with
    // 「出现 75 次」/「出现 0 次」, and left a corrupted file. Reading after every
    // mutation is what keeps a multi-step edit honest.
    '- 每次修改文件之后，先重新读取该文件，再决定下一步；不要凭记忆连续拼接多次改动。',
    '- 全部完成后，用下列格式说明你做了什么（不要只说「已修改」）：',
    '  **改了哪个文件** → 具体改了什么（哪个函数/哪一行），为什么这么改。',
    '  如果有多处改动，逐条列出。',
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
    for (const parsed of parseCallJsonList(raw)) {
      calls.push({ id: makeId(calls.length), ...parsed })
    }
  }
  // Fallback: if the model used a ```json fence with strict {"name","arguments"} shape
  if (calls.length === 0 && rest.includes('```')) {
    rest = rest.replace(JSON_FENCE_RE, (fullMatch, body: string) => {
      const parsedList = parseCallJsonList((body ?? '').trim(), true)
      if (parsedList.length === 0) return fullMatch
      for (const parsed of parsedList) {
        calls.push({ id: makeId(calls.length), ...parsed })
      }
      return ''
    }).trim()
  }
  return { calls: dedupeCalls(calls), text: rest }
}

/** Parse one fence body (single object or array of objects) into calls. */
function parseCallJsonList(
  raw: string,
  strictKeys = false,
): Array<{ name: string; arguments: string }> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  const items = Array.isArray(value) ? value : [value]
  const out: Array<{ name: string; arguments: string }> = []
  for (const item of items) {
    const single = parseSingleCallObject(item, strictKeys)
    if (single !== undefined) out.push(single)
  }
  return out
}

/** Parse one call object into `{ name, arguments }`, or undefined when not usable. */
function parseSingleCallObject(
  value: unknown,
  strictKeys = false,
): { name: string; arguments: string } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const outer = value as Record<string, unknown>
  const record =
    outer.function !== null && typeof outer.function === 'object' && !Array.isArray(outer.function)
      ? (outer.function as Record<string, unknown>)
      : outer
  if (strictKeys && !('name' in record && ('arguments' in record || 'params' in record))) {
    return undefined
  }
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

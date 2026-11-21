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
 * simulation, not a native tool channel. Parsed calls are restricted to tools
 * declared by the current DSH request; the Harness remains responsible for
 * workspace permissions and actual execution.
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
    .filter((tool) => tool.type === 'function')
    .map((tool) => tool.function?.name)
    .filter((name): name is string => typeof name === 'string' && name !== '')
  if (usable.length === 0) return ''
  const lines = tools
    .filter((tool) => tool.type === 'function' && typeof tool.function?.name === 'string')
    .map((tool) => {
      const fn = tool.function
      const schema = fn?.parameters === undefined ? '' : ` — 参数: ${JSON.stringify(fn.parameters)}`
      const desc = fn?.description === undefined ? '' : ` — ${fn.description}`
      return `- ${fn?.name}${desc}${schema}`
    })
  return [
    '',
    '',
    '你是执行型助手，只能通过本次 DSH 请求明确列出的工具操作当前工作区。可用工具：',
    ...lines,
    '',
    '需要调用工具时，可先用一句话告诉用户当前要做的步骤，然后输出一个代码围栏，语言标记为 ' + TOOL_FENCE_LANGUAGE + '，' +
      '围栏内放恰好一个 JSON 对象：{"name":"<工具名>","arguments":{...}}。',
    '只调用上面的工具名，不要伪造工具或绕过 DSH 权限。执行结果会以 [tool result] 开头的消息回给你，然后你继续推进。',
    '向用户显示简短进度与操作结果，不输出隐藏的逐步思维链。',
    '',
    '硬性规则：',
    '- 需要文件操作时，先用一句简短进度说明，再调用工具；不要长篇计划或贴代码让用户手工执行。',
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
    '  报告新增/删除行数时，必须引用工具结果中的 diff 或统计；没有数据就明确写「工具未提供」，不能估算。',
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
  declaredTools: readonly InboundTool[],
  makeId: (index: number) => string = (i) => 'call_' + Date.now() + '_' + i,
): { calls: EmulatedToolCall[]; text: string; rejectedCalls: boolean } {
  const calls: EmulatedToolCall[] = []
  let rejectedCalls = false
  let rest = text
  for (;;) {
    const match = FENCE_RE.exec(rest)
    if (match === null) break
    const raw = (match[1] ?? '').trim()
    rest = (rest.slice(0, match.index) + rest.slice(match.index + match[0].length)).trim()
    const parsed = parseCallJsonList(raw, false, declaredTools)
    rejectedCalls ||= parsed.rejected
    for (const call of parsed.calls) calls.push({ id: makeId(calls.length), ...call })
  }
  // Fallback only for JSON objects that look like tool calls. Ordinary JSON code
  // fences stay visible and do not get mistaken for a function invocation.
  if (calls.length === 0 && rest.includes('```')) {
    rest = rest.replace(JSON_FENCE_RE, (fullMatch, body: string) => {
      const parsed = parseCallJsonList((body ?? '').trim(), true, declaredTools)
      if (parsed.calls.length === 0 && !parsed.rejected) return fullMatch
      rejectedCalls ||= parsed.rejected
      for (const call of parsed.calls) calls.push({ id: makeId(calls.length), ...call })
      return ''
    }).trim()
  }
  const cleanText = rejectedCalls
    ? [rest, '工具调用未执行：调用未在本次 DSH 工具列表中，或参数不符合声明。'].filter(Boolean).join('\n\n')
    : rest
  return { calls: dedupeCalls(calls), text: cleanText, rejectedCalls }
}

/** Parse one fence body and enforce the current request's tool allow-list. */
function parseCallJsonList(
  raw: string,
  strictKeys: boolean,
  declaredTools: readonly InboundTool[],
): { calls: Array<{ name: string; arguments: string }>; rejected: boolean } {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { calls: [], rejected: !strictKeys }
  }
  const items = Array.isArray(value) ? value : [value]
  const calls: Array<{ name: string; arguments: string }> = []
  let rejected = false
  for (const item of items) {
    const single = parseSingleCallObject(item, strictKeys)
    if (single === undefined) {
      rejected ||= !strictKeys
      continue
    }
    const declared = declaredTools.find((tool) => tool.type === 'function' && tool.function?.name === single.name)
    if (declared === undefined) {
      rejected = true
      continue
    }
    let args: unknown
    try {
      args = JSON.parse(single.arguments)
    } catch {
      rejected = true
      continue
    }
    if (!isJsonObject(args) || !matchesDeclaredSchema(declared.function?.parameters, args)) {
      rejected = true
      continue
    }
    calls.push({ name: single.name, arguments: JSON.stringify(args) })
  }
  return { calls, rejected }
}


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
  let parsedArgs: unknown = args
  if (typeof args === 'string') {
    try {
      parsedArgs = JSON.parse(args)
    } catch {
      return undefined
    }
  }
  if (!isJsonObject(parsedArgs)) return undefined
  return { name, arguments: JSON.stringify(parsedArgs) }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate the common JSON-Schema subset used for tool parameters. DSH remains
 * the final execution/permission gate; this prevents the model bridge from
 * handing an undeclared function or obviously invalid object to that gate.
 */
function matchesDeclaredSchema(schema: Record<string, unknown> | undefined, value: unknown, depth = 0): boolean {
  if (schema === undefined) return isJsonObject(value)
  if (depth > 24) return false

  const typeMatches = (type: unknown): boolean => {
    if (typeof type !== 'string') return true
    switch (type) {
      case 'object': return isJsonObject(value)
      case 'array': return Array.isArray(value)
      case 'string': return typeof value === 'string'
      case 'number': return typeof value === 'number' && Number.isFinite(value)
      case 'integer': return typeof value === 'number' && Number.isInteger(value)
      case 'boolean': return typeof value === 'boolean'
      case 'null': return value === null
      default: return false
    }
  }

  const type = schema.type
  if (Array.isArray(type) ? !type.some(typeMatches) : !typeMatches(type)) return false
  if ('const' in schema && !jsonDeepEqual(value, schema.const)) return false
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonDeepEqual(value, candidate))) return false

  if (isJsonObject(value)) {
    const properties = isJsonObject(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required) ? schema.required : []
    if (required.some((key) => typeof key !== 'string' || !(key in value))) return false
    if (typeof schema.minProperties === 'number' && Object.keys(value).length < schema.minProperties) return false
    if (typeof schema.maxProperties === 'number' && Object.keys(value).length > schema.maxProperties) return false
    for (const [key, child] of Object.entries(value)) {
      if (key in properties) {
        const childSchema = properties[key]
        if (isJsonObject(childSchema) && !matchesDeclaredSchema(childSchema, child, depth + 1)) return false
      } else if (schema.additionalProperties === false) {
        return false
      } else if (isJsonObject(schema.additionalProperties) && !matchesDeclaredSchema(schema.additionalProperties, child, depth + 1)) {
        return false
      }
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false
    if (isJsonObject(schema.items) && value.some((item) => !matchesDeclaredSchema(schema.items as Record<string, unknown>, item, depth + 1))) return false
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return false
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return false
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return false
    if (typeof schema.maximum === 'number' && value > schema.maximum) return false
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) return false
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) return false
  }
  if (Array.isArray(schema.allOf) && !schema.allOf.every((part) => !isJsonObject(part) || matchesDeclaredSchema(part, value, depth + 1))) return false
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((part) => isJsonObject(part) && matchesDeclaredSchema(part, value, depth + 1))) return false
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((part) => isJsonObject(part) && matchesDeclaredSchema(part, value, depth + 1)).length !== 1) return false
  return true
}

function jsonDeepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => jsonDeepEqual(value, right[index]))
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index] && jsonDeepEqual(left[key], right[key]))
  }
  return false
}

/**
 * Drop calls repeated within the same reply.
 *
 * The model occasionally emits the same call twice in one turn; executing it
 * twice is at best wasteful and at worst destructive (a second write of the
 * same file with different content).
 */
/**
 * Build a `run_code` program that performs the task's filesystem operations.
 *
 * Only the operations the mapper already understands reach this function, and
 * every path has passed `normalizePath` (relative, no traversal), so the program
 * it emits cannot touch anything outside the session workspace. Returns
 * `undefined` when the operations cannot be expressed — the caller then falls
 * through to the per-tool branches or refuses the turn.
 */
function buildRunCodeProgram(
  operations: readonly Record<string, unknown>[],
  normalizePath: (value: unknown) => string | undefined,
  types: readonly unknown[],
): string | undefined {
  const lines: string[] = []
  for (const operation of operations) {
    const type = operation.type
    const path = normalizePath(operation.path)
    if (path === undefined) return undefined
    const quoted = JSON.stringify(path)
    if (type === 'ensure_dir') lines.push('  await fs.mkdir(' + quoted + ', { recursive: true })')
    else if (type === 'ensure_file') {
      lines.push('  await fs.mkdir(path.dirname(' + quoted + '), { recursive: true })')
      lines.push('  await fs.appendFile(' + quoted + ', \'\')')
    } else if (type === 'write_file' || type === 'write') {
      if (typeof operation.content !== 'string') return undefined
      if (operation.mode !== undefined && operation.mode !== 'replace' && operation.mode !== 'append') return undefined
      lines.push('  await fs.mkdir(path.dirname(' + quoted + '), { recursive: true })')
      const verb = operation.mode === 'append' ? 'appendFile' : 'writeFile'
      lines.push('  await fs.' + verb + '(' + quoted + ', ' + JSON.stringify(operation.content) + ', \'utf8\')')
    } else if (type === 'append_file') {
      if (typeof operation.content !== 'string') return undefined
      lines.push('  await fs.mkdir(path.dirname(' + quoted + '), { recursive: true })')
      lines.push('  await fs.appendFile(' + quoted + ', ' + JSON.stringify(operation.content) + ', \'utf8\')')
    } else return undefined
  }
  if (lines.length === 0) return undefined
  // `node:fs/promises` and `node:path` are imported by the program itself so the
  // caller needs no ambient bindings; the result reports what ran.
  return [
    'const fs = await import("node:fs/promises")',
    'const path = await import("node:path")',
    'await (async () => {',
    ...lines,
    '})()',
    'return { ok: true, performed: ' + JSON.stringify(operations.map((operation) => String(operation.type) + ' ' + String(operation.path))) + ' }',
  ].join('\n')
}

/**
 * Convert a conservative subset of task-local filesystem operations into
 * functions declared by this DSH request. This helper never accesses disk.
 */
export function taskWorkspaceOperationsToDshCalls(input: unknown, declaredTools: readonly InboundTool[]): { calls: EmulatedToolCall[]; reason?: string } {
  if (!isJsonObject(input) || !Array.isArray(input.operations) || input.operations.length === 0) return { calls: [], reason: '任务操作格式无效或为空。' }
  if (input.operations.length > 64) return { calls: [], reason: '单次任务操作数量超过桥接上限。' }
  const operations = input.operations.filter(isJsonObject)
  if (operations.length !== input.operations.length) return { calls: [], reason: '任务操作包含无效项目。' }
  const normalizePath = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || value.includes(String.fromCharCode(0))) return undefined
    const slashes = value.split(String.fromCharCode(92)).join('/')
    if (slashes.startsWith('/') || /^[A-Za-z]:/.test(slashes)) return undefined
    const parts = slashes.split('/').filter((part) => part !== '' && part !== '.')
    if (parts.length === 0 || parts.some((part) => part === '..')) return undefined
    return parts.join('/')
  }
  const q = String.fromCharCode(39)
  const bs = String.fromCharCode(92)
  const shellQuote = (value: string): string => q + value.split(q).join(q + bs + q + q) + q
  const allowed = (names: readonly string[]): InboundTool[] => declaredTools.filter((tool) => tool.type === 'function' && names.includes(tool.function?.name ?? ''))
  const validate = (tool: InboundTool, args: Record<string, unknown>): EmulatedToolCall | undefined => {
    const name = tool.function?.name
    if (!name) return undefined
    const fence = String.fromCharCode(96).repeat(3) + TOOL_FENCE_LANGUAGE + String.fromCharCode(10) + JSON.stringify({ name, arguments: args }) + String.fromCharCode(10) + String.fromCharCode(96).repeat(3)
    return parseToolCalls(fence, declaredTools).calls[0]
  }
  const types = operations.map((operation) => operation.type)
  /**
   * PTC turns declare ONE tool: `run_code`. A task turn still dispatches plain
   * filesystem commands, so without this branch every such turn would have to be
   * refused — which is exactly what LOCAL_EXECUTION_UNAVAILABLE was reporting.
   * The program is built from the operations, never from model-supplied text, so
   * the same allow-list and path normalisation above still govern it.
   */
  const runCodeTool = allowed(['run_code'])[0]
  if (runCodeTool !== undefined) {
    const code = buildRunCodeProgram(operations, normalizePath, types)
    if (code !== undefined) {
      const props = isJsonObject(runCodeTool.function?.parameters?.properties) ? runCodeTool.function.parameters.properties : {}
      const args: Record<string, unknown> = { code }
      if ('description' in props) args.description = '在当前 DSH 工作区执行工作任务下发的文件操作'
      const call = validate(runCodeTool, args)
      if (call) return { calls: [call] }
    }
  }
  if (types.every((type) => type === 'ensure_dir' || type === 'ensure_file')) {
    const commands: string[] = []
    for (const operation of operations) {
      const path = normalizePath(operation.path)
      if (!path) return { calls: [], reason: '目录/文件路径不是相对工作区路径。' }
      if (operation.type === 'ensure_dir') commands.push('mkdir -p -- ' + shellQuote(path))
      else {
        const slashAt = path.lastIndexOf('/')
        const parent = slashAt < 0 ? '' : path.slice(0, slashAt)
        if (parent) commands.push('mkdir -p -- ' + shellQuote(parent))
        commands.push('touch -- ' + shellQuote(path))
      }
    }
    const command = commands.join(' && ')
    if (command.length > 16_000) return { calls: [], reason: '目录/文件初始化超过桥接上限。' }
    for (const tool of allowed(['ops_bash', 'bash', 'run_command', 'shell', 'execute_command', 'terminal'])) {
      const props = isJsonObject(tool.function?.parameters?.properties) ? tool.function.parameters.properties : {}
      const key = 'command' in props ? 'command' : 'cmd' in props ? 'cmd' : 'command'
      const args: Record<string, unknown> = { [key]: command }
      if ('description' in props) args.description = '在当前 DSH 工作区创建任务所需目录或空文件'
      const call = validate(tool, args)
      if (call) return { calls: [call] }
    }
    return { calls: [], reason: '当前 DSH 请求没有声明 Bash 工作区工具。' }
  }
  if (operations.length === 1 && (types[0] === 'write_file' || types[0] === 'write')) {
    const operation = operations[0]!
    const path = normalizePath(operation.path)
    if (!path || typeof operation.content !== 'string') return { calls: [], reason: '写文件路径或内容格式无效。' }
    if (operation.mode !== undefined && operation.mode !== 'replace') return { calls: [], reason: '当前桥接只支持 replace 写入模式。' }
    for (const tool of allowed(['write_file', 'write', 'ops_write_file', 'create_file'])) {
      const props = isJsonObject(tool.function?.parameters?.properties) ? tool.function.parameters.properties : {}
      const key = 'file_path' in props || tool.function?.name === 'write' ? 'file_path' : 'path'
      const args: Record<string, unknown> = { [key]: path, content: operation.content }
      if ('mode' in props && operation.mode !== undefined) args.mode = operation.mode
      if ('revision' in props && operation.revision !== undefined) args.revision = operation.revision
      const call = validate(tool, args)
      if (call) return { calls: [call] }
    }
    return { calls: [], reason: '当前 DSH 请求没有声明兼容的写文件工具。' }
  }
  // Task turns also append to their own bookkeeping files (trajectory, memory).
  // An append is a write when the tool has no append mode, so only route it to a
  // tool that declares one — never silently truncate the file it appends to.
  if (operations.length === 1 && types[0] === 'append_file') {
    const operation = operations[0]!
    const path = normalizePath(operation.path)
    if (!path || typeof operation.content !== 'string') return { calls: [], reason: '追加文件路径或内容格式无效。' }
    for (const tool of allowed(['append_file', 'edit_file', 'write_file'])) {
      const props = isJsonObject(tool.function?.parameters?.properties) ? tool.function.parameters.properties : {}
      if (!('append' in props) && !('mode' in props) && tool.function?.name !== 'append_file') continue
      const key = 'file_path' in props || tool.function?.name === 'edit_file' ? 'file_path' : 'path'
      const args: Record<string, unknown> = { [key]: path, content: operation.content }
      if ('append' in props) args.append = true
      else if ('mode' in props) args.mode = 'append'
      const call = validate(tool, args)
      if (call) return { calls: [call] }
    }
    return { calls: [], reason: '当前 DSH 请求没有声明支持追加语义的写文件工具。' }
  }
  return { calls: [], reason: '这组工作任务操作不属于已支持的安全映射。' }
}

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

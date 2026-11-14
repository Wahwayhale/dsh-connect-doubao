/**
 * The prompt-level tool contract and its parser.
 *
 * These are the two halves that have to agree exactly: whatever the contract
 * tells the model to emit, the parser must accept, and the fence must vanish
 * from the text the user sees. A drift between them is invisible in a unit test
 * that only checks one side, so both are exercised against the same shape here.
 */
import { describe, expect, it } from 'vitest'
import {
  buildToolContract,
  dedupeCalls,
  parseToolCalls,
  toolResultAsText,
  TOOL_FENCE_LANGUAGE,
} from '../src/doubao-tools.ts'

const tools = [
  { type: 'function', function: { name: 'read_file', description: '读取文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'write_file', description: '写入文件' } },
]

describe('buildToolContract', () => {
  it('names every tool and the fence language', () => {
    const contract = buildToolContract(tools)
    expect(contract).toContain('read_file')
    expect(contract).toContain('write_file')
    expect(contract).toContain(TOOL_FENCE_LANGUAGE)
    expect(contract).toContain('读取文件')
  })

  it('carries the parameter schema when there is one', () => {
    expect(buildToolContract(tools)).toContain('"path"')
  })

  it('is empty when nothing usable was declared', () => {
    expect(buildToolContract([])).toBe('')
    expect(buildToolContract([{ type: 'function' }])).toBe('')
  })

  it('tells the model not to repeat itself', () => {
    // The measured failure mode (2026-11-02) was a duplicate call, not bad JSON.
    expect(buildToolContract(tools)).toContain('不要重复')
  })

  it('forbids the hallucinated completion that soft wording produced', () => {
    // MEASURED: with polite wording the model answered 「已完成修改：…」 while
    // making 0/2 tool calls and touching nothing. The user would believe the
    // file changed. These two lines are what stopped it (2/2 calls).
    const contract = buildToolContract(tools)
    expect(contract).toContain('严禁')
    expect(contract).toContain('[tool result]')
    expect(contract).toContain('第一条回复必须是一个工具调用')
  })

  it('requires a re-read after each edit', () => {
    // MEASURED: chaining blind edits corrupted the file — edit N invalidates the
    // text edit N+1 was computed against (observed: 「出现 75 次」/「出现 0 次」).
    expect(buildToolContract(tools)).toContain('重新读取')
  })
})

describe('parseToolCalls', () => {
  it('extracts one call and removes the fence from the text', () => {
    const reply = '我先读一下文件。\n\n```doubao-tool\n{"name":"read_file","arguments":{"path":"a.txt"}}\n```\n'
    const out = parseToolCalls(reply)
    expect(out.calls).toHaveLength(1)
    expect(out.calls[0].name).toBe('read_file')
    expect(out.calls[0].arguments).toBe('{"path":"a.txt"}')
    expect(out.text).toBe('我先读一下文件。')
    expect(out.text).not.toContain('doubao-tool')
  })

  it('keeps normal prose untouched', () => {
    const out = parseToolCalls('这就是答案，没有工具调用。')
    expect(out.calls).toEqual([])
    expect(out.text).toBe('这就是答案，没有工具调用。')
  })

  it('drops a malformed fence but keeps the text', () => {
    const out = parseToolCalls('结论如下\n```doubao-tool\n{name: 缺引号}\n```')
    expect(out.calls).toEqual([])
    expect(out.text).toBe('结论如下')
  })

  it('accepts the alternate field spellings models drift to', () => {
    expect(parseToolCalls('```doubao-tool\n{"tool":"bash","params":{"cmd":"ls"}}\n```').calls[0].name).toBe('bash')
    expect(parseToolCalls('```doubao-tool\n{"name":"bash","arguments":"{\\"cmd\\":\\"ls\\"}"}\n```').calls[0].arguments).toBe('{"cmd":"ls"}')
  })

  it('rejects a call whose arguments are not an object', () => {
    expect(parseToolCalls('```doubao-tool\n{"name":"bash","arguments":"ls -la"}\n```').calls).toEqual([])
  })

  it('reads several fences and dedupes identical calls', () => {
    const one = '{"name":"write_file","arguments":{"path":"a","content":"1"}}'
    const out = parseToolCalls(
      '```doubao-tool\n' + one + '\n```\n中间\n```doubao-tool\n' + one + '\n```\n结尾\n```doubao-tool\n{"name":"read_file","arguments":{"path":"b"}}\n```',
    )
    expect(out.calls.map((c) => c.name)).toEqual(['write_file', 'read_file'])
    expect(out.text).toContain('中间')
    expect(out.text).toContain('结尾')
  })

  it('extracts array of tool calls, OpenAI function wrapper, and json fence fallback', () => {
    const arrReply = '```doubao-tool\n[{"name":"read_file","arguments":{"path":"a.ts"}},{"type":"function","function":{"name":"write_file","arguments":{"path":"b.ts"}}}]\n```'
    const arrOut = parseToolCalls(arrReply)
    expect(arrOut.calls.map((c) => c.name)).toEqual(['read_file', 'write_file'])

    const jsonReply = '??\n```json\n{"name":"read_file","arguments":{"path":"c.ts"}}\n```'
    const jsonOut = parseToolCalls(jsonReply)
    expect(jsonOut.calls).toHaveLength(1)
    expect(jsonOut.calls[0].name).toBe('read_file')
    expect(jsonOut.text).toBe('??')
  })

  it('gives each call a distinct id', () => {
    const body = (n: string) => '```doubao-tool\n' + JSON.stringify({ name: n, arguments: {} }) + '\n```'
    const out = parseToolCalls(`${body('a')}\n${body('b')}`)
    expect(new Set(out.calls.map((c) => c.id)).size).toBe(2)
  })
})

describe('dedupeCalls', () => {
  it('keeps first occurrence per name+arguments', () => {
    const calls = [
      { id: '1', name: 'a', arguments: '{}' },
      { id: '2', name: 'a', arguments: '{}' },
      { id: '3', name: 'a', arguments: '{"x":1}' },
    ]
    expect(dedupeCalls(calls).map((c) => c.id)).toEqual(['1', '3'])
  })
})

describe('toolResultAsText', () => {
  it('uses the prefix the contract promises', () => {
    expect(toolResultAsText('read_file', '内容').startsWith('[tool result] read_file:')).toBe(true)
    expect(toolResultAsText(undefined, 'ok')).toBe('[tool result] ok')
  })

  it('serialises non-string content', () => {
    expect(toolResultAsText('t', { a: 1 })).toContain('{"a":1}')
  })
})

import { describe, expect, it } from 'vitest'

import type { DBMessagePartSelect } from '@/lib/types/message-persistence'
import {
  mapDBPartToUIMessagePart,
  mapUIMessagePartsToDBParts
} from '@/lib/utils/message-mapping'

describe('generateImage part round-trip', () => {
  it('rehydrates a persisted tool-generateImage part under its real type', () => {
    const original = {
      type: 'tool-generateImage',
      toolCallId: 'call-genimg-1',
      state: 'output-available',
      input: { prompt: 'a red fox in the snow' },
      output: {
        imageUrl: 'https://example.com/fox.png',
        modelId: 'flux-1',
        prompt: 'a red fox in the snow'
      }
    }

    const [dbPart] = mapUIMessagePartsToDBParts([original as any], 'msg-1')

    // Stored through the generic dynamic envelope
    expect(dbPart.type).toBe('tool-dynamic')
    expect(dbPart.tool_dynamic_name).toBe('generateImage')

    const rehydrated = mapDBPartToUIMessagePart(
      dbPart as DBMessagePartSelect
    ) as any

    expect(rehydrated.type).toBe('tool-generateImage')
    expect(rehydrated.toolCallId).toBe(original.toolCallId)
    expect(rehydrated.state).toBe(original.state)
    expect(rehydrated.input).toEqual(original.input)
    expect(rehydrated.output).toEqual(original.output)
  })

  it('still rehydrates a genuinely dynamic (mcp) tool as dynamic-tool', () => {
    const original = {
      type: 'dynamic-tool',
      toolCallId: 'call-mcp-1',
      toolName: 'mcp__github__search_issues',
      state: 'output-available',
      input: { query: 'bug' },
      output: { issues: [] }
    }

    const [dbPart] = mapUIMessagePartsToDBParts([original as any], 'msg-2')

    expect(dbPart.type).toBe('tool-dynamic')
    expect(dbPart.tool_dynamic_name).toBe('mcp__github__search_issues')

    const rehydrated = mapDBPartToUIMessagePart(
      dbPart as DBMessagePartSelect
    ) as any

    expect(rehydrated.type).toBe('dynamic-tool')
    expect(rehydrated.toolName).toBe('mcp__github__search_issues')
    expect(rehydrated.input).toEqual(original.input)
    expect(rehydrated.output).toEqual(original.output)
  })
})

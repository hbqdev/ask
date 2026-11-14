import { describe, expect, test } from 'vitest'

import * as prompts from '../prompt'

// Follow-up questions now come from a separate endpoint (lib/agents/
// followup-generator.ts), so the answering model is no longer asked to append a
// "Related" spec block. Old messages that already carry one still render and
// strip (spec-block.tsx / strip-spec-blocks.ts) — only the instruction is gone.
describe('render prompts', () => {
  test('no longer exports a related-questions instruction', () => {
    expect('getRelatedQuestionsSpecPrompt' in prompts).toBe(false)
  })

  test('image spec rules no longer mention a related-questions block', () => {
    const prompt = prompts.getImageSpecPrompt()

    expect(prompt).toContain('IMAGE SPEC RULES')
    expect(prompt).not.toMatch(/related-questions/i)
    expect(prompt).not.toContain('RELATED QUESTIONS')
    expect(prompt).not.toContain('submitQuery')
  })
})

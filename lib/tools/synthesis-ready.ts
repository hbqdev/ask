import { tool } from 'ai'
import { z } from 'zod'

export const synthesisReadyTool = tool({
  description:
    'Call this ONCE when all research is complete and you are ready to write the final answer. Do not call any more search, fetch, or calculate tools after this. After calling this, immediately write the complete, well-cited response.',
  inputSchema: z.object({
    queries_run: z
      .array(z.string())
      .describe('The search queries you executed'),
    summary: z
      .string()
      .describe('One-sentence summary of what you found that will answer the question')
  }),
  execute: async ({ queries_run, summary }) => ({
    ready: true,
    queries_run,
    summary,
    instruction:
      'Now write the complete answer. Cite every factual sentence with [N](#toolCallId). Use clear headings. Do not refer to "my research" — just assert facts and cite them.'
  })
})

import { tool } from 'ai'
import { z } from 'zod'

export const synthesisReadyTool = tool({
  description:
    'Signal that research is complete. IMPORTANT: Write your complete, well-cited final answer as your text response IN THIS SAME MESSAGE before calling this tool — do NOT write the answer after. This tool call ends the research phase, so your answer must appear as text content in the same step. Do not call any more search or fetch tools after this.',
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
    summary
  })
})

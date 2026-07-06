import { tool } from 'ai'
import { z } from 'zod'

export const calculateTool = tool({
  description:
    'Evaluate mathematical expressions and unit conversions accurately. Use this for ANY numeric calculation — percentages, formulas, square roots, unit conversions, etc. Never compute math mentally.',
  inputSchema: z.object({
    expression: z
      .string()
      .describe(
        'The expression to evaluate. Examples: "25% of 80", "sqrt(256)", "sin(45 deg)", "100 USD to EUR (rate 0.92)", "(3 + 5) * 12 / 4"'
      )
  }),
  execute: async ({ expression }) => {
    try {
      const { evaluate, format } = await import('mathjs')
      const result = evaluate(expression)
      const formatted =
        typeof result === 'number' || typeof result === 'object'
          ? format(result, { precision: 10 })
          : String(result)
      return { expression, result: formatted, success: true }
    } catch (err) {
      return {
        expression,
        error: err instanceof Error ? err.message : 'Could not evaluate expression',
        success: false
      }
    }
  }
})

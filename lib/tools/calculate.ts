import { tool } from 'ai'
import { z } from 'zod'

// "17% of 4500" is the single most natural way to ask for a percentage, it is
// what this tool's own description used to offer as an example, and mathjs
// cannot parse it — `evaluate('17% of 4500')` throws "Undefined symbol of".
//
// MEASURED CONSEQUENCE, not a hypothetical. Asked "What is 17% of 4500?" the
// model called calculate with exactly the documented phrasing, got the error,
// reasoned "the calculate tool didn't accept it, let me try a different
// format", spent its second and last step on the retry, and returned a
// ZERO-CHARACTER answer. The tool taught the model a syntax it then rejected.
//
// Rewriting beats erroring: the intent is unambiguous, and a tool that fails
// on the phrasing its own description recommends is the worst of both.
// Bound the untrusted expression so a model/user can't pin the single event
// loop. mathjs evaluates synchronously, so a true time-out isn't cleanly
// achievable here; instead we reject inputs before they can blow up: an overall
// length cap, and stacked exponentiation ("power towers" like 9^9^9^9) which
// are the classic way to balloon a bignum / spin the CPU.
const MAX_EXPRESSION_LENGTH = 512
// A chained exponent where the middle operand is only a number (no intervening
// operator) — i.e. `… ^ <number> ^ …`. `2^3 + 4^5` does NOT match (the run
// between the carets contains `+`), but `9^9^9` does.
const POWER_TOWER = /\^\s*[\d.]+\s*\^/

function normalizeExpression(expression: string): string {
  return (
    expression
      // "17% of 4500" / "17 percent of 4500" -> "(17/100)*4500"
      .replace(
        /(\d+(?:\.\d+)?)\s*(?:%|percent)\s+of\s+/gi,
        (_m, pct: string) => `(${pct}/100)*`
      )
      // A trailing "(rate 0.92)" annotation — also from the old description —
      // is a note to the reader, not an operand.
      .replace(/\s*\((?:rate|approx\.?|about)[^)]*\)\s*$/i, '')
      .trim()
  )
}

export const calculateTool = tool({
  description:
    'Evaluate mathematical expressions and unit conversions accurately. Use this for ANY numeric calculation — percentages, formulas, square roots, unit conversions, etc. Never compute math mentally.',
  inputSchema: z.object({
    expression: z.string().describe(
      // Every example here is verified to evaluate. Currency pairs are NOT
      // offered: mathjs has no exchange rates, so "100 USD to EUR" throws
      // "Undefined symbol USD" no matter how it is phrased.
      'The expression to evaluate, in mathjs syntax. Examples: "(17/100)*4500", "sqrt(256)", "2^10", "sin(45 deg)", "10 inch to cm", "32 degF to degC", "(3 + 5) * 12 / 4"'
    )
  }),
  execute: async ({ expression }) => {
    try {
      if (expression.length > MAX_EXPRESSION_LENGTH) {
        return {
          expression,
          error: `Expression too long (max ${MAX_EXPRESSION_LENGTH} characters)`,
          success: false
        }
      }
      const normalized = normalizeExpression(expression)
      if (POWER_TOWER.test(normalized)) {
        return {
          expression,
          error:
            'Stacked exponentiation (power towers) is not supported; simplify the expression',
          success: false
        }
      }
      const { evaluate, format } = await import('mathjs')
      const result = evaluate(normalized)
      const formatted =
        typeof result === 'number' || typeof result === 'object'
          ? format(result, { precision: 10 })
          : String(result)
      return { expression, result: formatted, success: true }
    } catch (err) {
      return {
        expression,
        error:
          err instanceof Error ? err.message : 'Could not evaluate expression',
        success: false
      }
    }
  }
})

import { describe, expect, it } from 'vitest'

import { calculateTool } from '../calculate'

// The tool has no exported pure function — `execute` IS the unit, and it is
// what the model actually reaches. Calling it directly (rather than through
// the SDK) keeps these tests about mathjs behaviour, which is the thing that
// broke.
async function calc(expression: string) {
  return (await calculateTool.execute!(
    { expression },
    // execute's second argument is SDK call context this tool never reads.
    {} as never
  )) as { result?: string; error?: string; success: boolean }
}

describe('calculateTool', () => {
  // THE BUG THIS PINS. The tool's own description used to offer "25% of 80" as
  // an example, and mathjs throws "Undefined symbol of" on it. Asked "What is
  // 17% of 4500?" the model sent exactly the documented phrasing, got the
  // error, spent its last step retrying, and returned a 0-character answer.
  it('evaluates the "X% of Y" phrasing a model naturally reaches for', async () => {
    expect((await calc('17% of 4500')).result).toBe('765')
    expect((await calc('25% of 80')).result).toBe('20')
    expect((await calc('12.5% of 200')).result).toBe('25')
  })

  it('accepts the spelled-out form too', async () => {
    expect((await calc('17 percent of 4500')).result).toBe('765')
  })

  it('drops a trailing rate annotation instead of choking on it', async () => {
    // Also inherited from the old description ("100 USD to EUR (rate 0.92)").
    // The parenthetical is a note to the reader, not an operand.
    expect((await calc('92 * 1.5 (rate 0.92)')).success).toBe(true)
  })

  it('still evaluates ordinary mathjs syntax unchanged', async () => {
    expect((await calc('(3 + 5) * 12 / 4')).result).toBe('24')
    expect((await calc('sqrt(256)')).result).toBe('16')
    expect((await calc('2^10')).result).toBe('1024')
  })

  it('still converts units', async () => {
    expect((await calc('10 inch to cm')).result).toBe('25.4 cm')
    expect((await calc('32 degF to degC')).result).toBe('0 degC')
  })

  it('leaves a bare percentage as modulo, which is what mathjs means by it', async () => {
    // Only the "of" form is rewritten. `%` on its own is mathjs's modulo
    // operator and rewriting it would change the meaning of valid input.
    expect((await calc('17 % 5')).result).toBe('2')
  })

  it('reports failure rather than throwing on genuinely unevaluable input', async () => {
    // mathjs has no exchange rates, so currency pairs cannot work at all —
    // which is why the description no longer offers one.
    const r = await calc('100 USD to EUR')
    expect(r.success).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('never advertises syntax it cannot evaluate', async () => {
    // The description is a prompt: every example in it is a phrasing the model
    // will copy verbatim, so each one has to survive a round trip. Read off
    // the live schema rather than a copy, so adding an example to the tool
    // without checking it fails here instead of in front of a user.
    const schema = calculateTool.inputSchema as unknown as {
      shape: { expression: { description?: string } }
    }
    const examples = (
      schema.shape.expression.description!.match(/"([^"]+)"/g) ?? []
    ).map((s: string) => s.slice(1, -1))
    expect(examples.length).toBeGreaterThan(3)
    for (const example of examples) {
      expect({ example, ...(await calc(example)) }).toMatchObject({
        success: true
      })
    }
  })
})

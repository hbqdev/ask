import { afterEach, describe, expect, it } from 'vitest'

import { isQualityContent } from '../quality-content'

afterEach(() => {
  delete process.env.SEARCH_QUALITY_FILTER
})

const prose =
  'The RTX 5090 uses GDDR7 memory. It delivers substantially higher bandwidth than its predecessor. ' +
  'This matters for inference because token generation is bandwidth bound. ' +
  'Most local models fit comfortably within its capacity. ' +
  'Real workloads see gains that track bandwidth more closely than raw compute. '.repeat(
    2
  )

// A spec table: plenty of information, almost no sentence-ending punctuation.
const specTable = `
| GPU | VRAM | Bandwidth | TDP | Launch |
| --- | --- | --- | --- | --- |
| RTX 5090 | 32 GB GDDR7 | 1792 GB/s | 575 W | 2025 |
| RTX 4090 | 24 GB GDDR6X | 1008 GB/s | 450 W | 2022 |
| RTX 3090 | 24 GB GDDR6X | 936 GB/s | 350 W | 2020 |
| A6000 | 48 GB GDDR6 | 768 GB/s | 300 W | 2020 |
| L40S | 48 GB GDDR6 | 864 GB/s | 350 W | 2022 |
`.trim()

// A procedure: short imperative steps, so words-per-sentence is low.
const steps = `
1. Install the driver.
2. Reboot the machine.
3. Verify with nvidia-smi.
4. Set the power limit.
5. Enable persistence mode.
6. Confirm the clocks.
7. Run the benchmark.
8. Compare against baseline.
9. Record the result.
10. Repeat for each card.
`.trim()

describe('isQualityContent — strict (inherited behaviour)', () => {
  it('accepts ordinary prose', () => {
    process.env.SEARCH_QUALITY_FILTER = 'strict'
    expect(isQualityContent(prose)).toBe(true)
  })

  it('REJECTS a spec table — no sentence punctuation inflates words-per-sentence', () => {
    // This is the failure that matters: for a hardware-comparison engine the
    // table IS the answer, and the filter throws it away before the reranker
    // ever sees it.
    process.env.SEARCH_QUALITY_FILTER = 'strict'
    expect(isQualityContent(specTable)).toBe(false)
  })

  it('REJECTS a numbered procedure — short steps drop words-per-sentence below 5', () => {
    process.env.SEARCH_QUALITY_FILTER = 'strict'
    expect(isQualityContent(steps)).toBe(false)
  })
})

describe('isQualityContent — relaxed', () => {
  it('accepts the spec table the strict filter discarded', () => {
    process.env.SEARCH_QUALITY_FILTER = 'relaxed'
    expect(isQualityContent(specTable)).toBe(true)
  })

  it('accepts the numbered procedure', () => {
    process.env.SEARCH_QUALITY_FILTER = 'relaxed'
    expect(isQualityContent(steps)).toBe(true)
  })

  it('still accepts ordinary prose', () => {
    process.env.SEARCH_QUALITY_FILTER = 'relaxed'
    expect(isQualityContent(prose)).toBe(true)
  })

  it('still rejects a crawler error page', () => {
    // These are genuinely worthless and would waste a rerank slot.
    process.env.SEARCH_QUALITY_FILTER = 'relaxed'
    expect(
      isQualityContent('Content unavailable due to crawling error. '.repeat(20))
    ).toBe(false)
    expect(
      isQualityContent('Error fetching content: timeout. '.repeat(20))
    ).toBe(false)
  })

  it('still rejects near-empty pages', () => {
    process.env.SEARCH_QUALITY_FILTER = 'relaxed'
    expect(isQualityContent('Just a nav bar and a cookie notice')).toBe(false)
  })

  it('admits a short but substantive answer that strict rejects on word count', () => {
    // ~30 words: too short for strict's >50, but a direct answer the
    // cross-encoder can score against the query far better than a word count.
    const short =
      'KV cache quantization to 4-bit typically costs one to two points of ' +
      'accuracy on reasoning benchmarks, while halving memory use. Most ' +
      'serving stacks default to 8-bit for this reason today.'
    process.env.SEARCH_QUALITY_FILTER = 'strict'
    expect(isQualityContent(short)).toBe(false)
    process.env.SEARCH_QUALITY_FILTER = 'relaxed'
    expect(isQualityContent(short)).toBe(true)
  })
})

describe('default mode', () => {
  it('defaults to strict, so shipping the code changes nothing by itself', () => {
    delete process.env.SEARCH_QUALITY_FILTER
    expect(isQualityContent(specTable)).toBe(false)
  })
})

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

// These constants gate which model runs on serenity. They must read from env
// (so the model-manager UI can change them) while defaulting to the current
// value (so behavior is unchanged until edited).
const cases: [string, string][] = [
  ['lib/agents/query-classifier.ts', 'CLASSIFIER_MODEL_ID'],
  ['lib/agents/query-expander.ts', 'EXPANDER_MODEL_ID'],
  ['lib/agents/memory-extractor.ts', 'MEMORY_EXTRACTOR_MODEL_ID']
]

describe('serenity model ids are env-driven', () => {
  for (const [file, envVar] of cases) {
    it(`${file} reads ${envVar} from env with granite default`, () => {
      const src = readFileSync(join(process.cwd(), file), 'utf8')
      expect(src).toContain(`process.env.${envVar}`)
      expect(src).toContain(`'granite4.1:8b'`)
    })
  }
})

// selfhosted/reranker/__tests__/reranker-config.test.ts
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const dir = join(process.cwd(), 'selfhosted/reranker')

describe('reranker model is env-file driven', () => {
  it('compose no longer hardcodes RERANKER_MODEL in environment', () => {
    const compose = readFileSync(join(dir, 'docker-compose.yaml'), 'utf8')
    expect(compose).not.toMatch(/^\s*RERANKER_MODEL:/m)
  })
  it('.env.example documents RERANKER_MODEL with the current default', () => {
    const env = readFileSync(join(dir, '.env.example'), 'utf8')
    expect(env).toMatch(/^RERANKER_MODEL=BAAI\/bge-reranker-v2-m3$/m)
  })
})

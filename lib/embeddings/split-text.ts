import { getEncoding } from 'js-tiktoken'

let enc: ReturnType<typeof getEncoding> | null = null

function countTokens(text: string): number {
  try {
    enc ??= getEncoding('cl100k_base')
    return enc.encode(text).length
  } catch {
    return Math.ceil(text.length / 4)
  }
}

// Port of Vane's splitText — splits on sentence/paragraph boundaries,
// chunks to maxTokens, prepends overlapTokens of context from the previous chunk.
export function splitText(
  text: string,
  maxTokens = 512,
  overlapTokens = 128
): string[] {
  const segments = text.split(/(?<=\. |\n|! |\? |; |:\s|\d+\.\s|- |\* )/)

  const chunks: string[] = []
  let currentChunk = ''
  let currentTokens = 0

  for (const segment of segments) {
    const segTokens = countTokens(segment)

    if (currentTokens + segTokens > maxTokens && currentChunk.length > 0) {
      chunks.push(currentChunk.trim())

      // Build overlap from end of current chunk
      const words = currentChunk.split(' ')
      let overlap = ''
      let overlapCount = 0
      for (let i = words.length - 1; i >= 0 && overlapCount < overlapTokens; i--) {
        overlap = words[i] + ' ' + overlap
        overlapCount += countTokens(words[i])
      }
      currentChunk = overlap + segment
      currentTokens = countTokens(currentChunk)
    } else {
      currentChunk += segment
      currentTokens += segTokens
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim())
  }

  return chunks.filter(c => c.length > 0)
}

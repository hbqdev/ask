import type { UIMessage } from 'ai'

const u = (id: string, text: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as UIMessage
const a = (id: string, text: string): UIMessage =>
  ({ id, role: 'assistant', parts: [{ type: 'text', text }] }) as UIMessage

export const CASES: { name: string; messages: UIMessage[] }[] = [
  // Standalone factual questions → queryIsStandalone should be true.
  {
    name: 'standalone-vectordb',
    messages: [u('1', 'what is the best open source vector database in 2026')]
  },
  {
    name: 'standalone-photosynthesis',
    messages: [u('1', 'how does photosynthesis work')]
  },
  {
    name: 'standalone-news',
    messages: [u('1', 'latest news about openai this week')]
  },
  // Contextual follow-ups → queryIsStandalone false, needs rewrite.
  {
    name: 'followup-pricing',
    messages: [
      u('1', 'tell me about the Pinecone vector database'),
      a('2', 'Pinecone is a managed vector database...'),
      u('3', 'what about its pricing?')
    ]
  },
  {
    name: 'followup-pronoun',
    messages: [
      u('1', 'who is the CEO of Anthropic'),
      a('2', 'Dario Amodei is the CEO of Anthropic.'),
      u('3', 'where did he go to school?')
    ]
  },
  // New-entity follow-up → skipSearch false (names a new subject).
  {
    name: 'new-entity',
    messages: [
      u('1', 'tell me about Python'),
      a('2', 'Python is a programming language...'),
      u('3', 'what about Rust?')
    ]
  },
  // Pure confirmation of THIS chat's content → skipSearch true.
  {
    name: 'confirm-restate',
    messages: [
      u('1', 'what is the capital of France'),
      a('2', 'The capital of France is Paris.'),
      u('3', 'so the capital is Paris, right?')
    ]
  },
  // Casual small talk → skipSearch true.
  { name: 'greeting', messages: [u('1', 'hey there!')] },
  {
    name: 'thanks',
    messages: [
      u('1', 'what is 2+2'),
      a('2', '2 + 2 = 4.'),
      u('3', 'thanks, that helps')
    ]
  },
  // Image generation → skipSearch true.
  { name: 'image-gen', messages: [u('1', 'draw me a watercolor fox')] },
  // Recency-sensitive standalone → needsRecent true.
  {
    name: 'recent-price',
    messages: [u('1', 'what is the current price of bitcoin')]
  },
  // Stable-fact standalone → needsRecent false.
  {
    name: 'stable-fact',
    messages: [u('1', 'what year did the Roman Empire fall')]
  }
]

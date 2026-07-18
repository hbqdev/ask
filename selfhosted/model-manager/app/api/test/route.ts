import { testOllama, testReranker } from '@/lib/connection-tests'

export async function POST(req: Request) {
  const body = (await req.json()) as
    | { kind: 'ollama'; baseUrl: string }
    | { kind: 'reranker'; url: string; token: string }
  if (body.kind === 'ollama')
    return Response.json(await testOllama(body.baseUrl))
  return Response.json(await testReranker(body.url, body.token))
}

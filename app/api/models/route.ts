import { getModelSelectorData } from '@/lib/model-selector/get-model-selector-data'

/**
 * Model list + the caller's current pick, for non-browser clients (the
 * mobile app) that can't consume the RSC payload the web selector uses.
 * getModelSelectorData resolves the user itself (cookie or bearer): signed-in
 * callers get their saved preference as selectedModelKey.
 */
export async function GET() {
  const data = await getModelSelectorData()
  return Response.json(data, { headers: { 'Cache-Control': 'no-store' } })
}

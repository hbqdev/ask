import { DeepPartial } from 'ai'
import { z } from 'zod'

import { getSearchTypeDescription } from '@/lib/utils/search-config'

const CONTENT_TYPE_VALUES = [
  'web',
  'video',
  'image',
  'news',
  'it',
  'map',
  'music'
] as const

// Some models confuse `type` (general vs optimized) with `content_types`
// (news/video/it/map/music) and call the tool with e.g. `type: "news"`,
// which fails schema validation before execute() ever runs. Recover by
// moving the value into content_types and falling back type to "general" —
// the same type content_types itself requires ("Only applicable when type
// is general").
function normalizeSearchToolInput(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value
  }
  const input = value as Record<string, unknown>
  const rawType = input.type
  if (
    typeof rawType !== 'string' ||
    !(CONTENT_TYPE_VALUES as readonly string[]).includes(rawType)
  ) {
    return input
  }

  const existingContentTypes = Array.isArray(input.content_types)
    ? (input.content_types as unknown[])
    : []
  return {
    ...input,
    type: 'general',
    content_types: existingContentTypes.includes(rawType)
      ? existingContentTypes
      : [...existingContentTypes, rawType]
  }
}

const searchObjectSchema = z.object({
  query: z.string().describe('The query to search for'),
  search_mode: z
    .enum(['web', 'academic', 'social'])
    .optional()
    .default('web')
    .describe(
      'web = general web search (default). academic = scholarly sources only (Google Scholar, arXiv, Semantic Scholar, PubMed, and other science engines). Use academic for: research papers, peer-reviewed evidence, scientific facts, citations. social = social media discussions only (Reddit, Lemmy, Mastodon, Hacker News). Use social for: opinions, personal experiences, community consensus, "what do people think about X" questions.'
    ),
  type: z
    .enum(['general', 'optimized'])
    .optional()
    .default('optimized')
    .describe(getSearchTypeDescription()),
  content_types: z
    .array(z.enum(['web', 'video', 'image', 'news', 'it', 'map', 'music']))
    .optional()
    .default(['web'])
    .describe(
      'Types of content to include alongside general web results. Only applicable when type is "general". video = video platforms (mostly YouTube). image = image search. news = current news articles with recency (use for breaking news, current events — returns real news outlets like Reuters/AP, not generic evergreen pages). it = programming/software results (GitHub, StackOverflow, npm, PyPI, MDN, package registries — use for coding, library, and package questions). map = location/place results (OpenStreetMap, Photon — use for "where is X" queries). music = music/audio results (SoundCloud, Bandcamp, Radio Browser — use for song/artist/album questions).'
    ),
  max_results: z
    .number()
    .optional()
    .default(20)
    .describe('The maximum number of results to return. default is 20'),
  search_depth: z
    .string()
    .optional()
    .default('basic')
    .describe(
      'The depth of the search. Allowed values are "basic" or "advanced"'
    ),
  include_domains: z
    .union([z.string(), z.array(z.string())])
    .nullish()
    .transform(val => (typeof val === 'string' ? [val] : (val ?? [])))
    .describe(
      'A list of domains to specifically include in the search results. Default is None, which includes all domains.'
    ),
  exclude_domains: z
    .union([z.string(), z.array(z.string())])
    .nullish()
    .transform(val => (typeof val === 'string' ? [val] : (val ?? [])))
    .describe(
      "A list of domains to specifically exclude from the search results. Default is None, which doesn't exclude any domains."
    )
})

export const searchSchema = z.preprocess(
  normalizeSearchToolInput,
  searchObjectSchema
)

// Strict schema with all fields required
const strictSearchObjectSchema = z.object({
  query: z.string().describe('The query to search for'),
  search_mode: z
    .enum(['web', 'academic', 'social'])
    .describe(
      'web = general web search. academic = scholarly sources (Google Scholar, arXiv, PubMed). Use academic for research/science queries. social = social media discussions only (Reddit, Lemmy, Mastodon, Hacker News). Use social for opinions/experiences/community consensus questions.'
    ),
  type: z.enum(['general', 'optimized']).describe(getSearchTypeDescription()),
  content_types: z
    .array(z.enum(['web', 'video', 'image', 'news', 'it', 'map', 'music']))
    .describe(
      'Types of content to include alongside general web results. Only applicable when type is "general". video = video platforms. image = image search. news = current news articles with recency. it = programming/software results (GitHub, StackOverflow, npm, PyPI, MDN). map = location/place results. music = music/audio results.'
    ),
  max_results: z.number().describe('The maximum number of results to return.'),
  search_depth: z
    .enum(['basic', 'advanced'])
    .describe('The depth of the search'),
  include_domains: z
    .union([z.string(), z.array(z.string())])
    .nullish()
    .transform(val => (typeof val === 'string' ? [val] : (val ?? [])))
    .describe(
      'A list of domains to specifically include in the search results. Default is None, which includes all domains.'
    ),
  exclude_domains: z
    .union([z.string(), z.array(z.string())])
    .nullish()
    .transform(val => (typeof val === 'string' ? [val] : (val ?? [])))
    .describe(
      "A list of domains to specifically exclude from the search results. Default is None, which doesn't exclude any domains."
    )
})

export const strictSearchSchema = z.preprocess(
  normalizeSearchToolInput,
  strictSearchObjectSchema
)

/**
 * Returns the appropriate search schema based on the full model name.
 * Uses the strict schema for OpenAI models starting with 'o'.
 */
export function getSearchSchemaForModel(fullModel: string) {
  const [provider, modelName] = fullModel?.split(':') ?? []
  const useStrictSchema =
    (provider === 'openai' || provider === 'azure') &&
    modelName?.startsWith('o')

  // Ensure search_depth is an enum for the strict schema
  if (useStrictSchema) {
    return strictSearchSchema
  } else {
    // For the standard schema, keep search_depth as optional string
    return searchSchema
  }
}

export type PartialInquiry = DeepPartial<typeof searchSchema>

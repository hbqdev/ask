import { DefaultChatTransport } from 'ai'
import { describe, expect, it } from 'vitest'

import { toPublicErrorPayload } from '@/lib/errors/public-error'
import { isAnswerText } from '@/lib/render/message-parts'
import { parseSpecBlock } from '@/lib/render/parse-spec-block'
import { stripSpecBlocks } from '@/lib/render/strip-spec-blocks'
import { narrationCleanView } from '@/lib/streaming/helpers/strip-narration-from-message'
import { ResumableChatTransport } from '@/lib/streaming/resumable-chat-transport'
import {
  collapseCitationArtifacts,
  extractCitationMaps,
  processCitations,
  stripIncompleteCitationTail
} from '@/lib/utils/citation'
import { resolveSearchSettings } from '@/lib/utils/request-search-settings'

// The thread screen reuses these pure modules from Ask's lib/ instead of
// copying them. Importing them here proves each one (and everything it pulls
// in) resolves and loads in the app, against the app's own ai/zod/json-render.
describe('shared Ask modules', () => {
  it.each([
    ['isAnswerText', isAnswerText],
    ['extractCitationMaps', extractCitationMaps],
    ['processCitations', processCitations],
    ['stripIncompleteCitationTail', stripIncompleteCitationTail],
    ['collapseCitationArtifacts', collapseCitationArtifacts],
    ['stripSpecBlocks', stripSpecBlocks],
    ['parseSpecBlock', parseSpecBlock],
    ['toPublicErrorPayload', toPublicErrorPayload],
    ['ResumableChatTransport', ResumableChatTransport],
    ['narrationCleanView', narrationCleanView],
    ['resolveSearchSettings', resolveSearchSettings]
  ])('loads %s', (_name, value) => {
    expect(typeof value).toBe('function')
  })

  it("builds on the app's own copy of ai, not a second one from Ask's node_modules", () => {
    // Two copies would mean two DefaultChatTransport classes (and two React
    // contexts for @ai-sdk/react): resolve.dedupe keeps them to one.
    expect(Object.getPrototypeOf(ResumableChatTransport)).toBe(
      DefaultChatTransport
    )
  })
})

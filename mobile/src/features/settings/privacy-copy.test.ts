import { describe, expect, it } from 'vitest'

import { privacySections } from '@/features/settings/privacy-copy'

const HOST = 'ask.example.test'

const allText = (host = HOST) =>
  privacySections(host)
    .flatMap(s => [s.title, ...s.paragraphs])
    .join('\n')

describe('privacySections', () => {
  it('has the 11 sections in order, with these titles', () => {
    expect(privacySections(HOST).map(s => s.title)).toEqual([
      'Where your data lives',
      'Your account',
      'How answers are made',
      'Web search',
      'Images Ask makes',
      'Voice',
      'Memory and past chats',
      'Pictures from other sites',
      'No tracking',
      'On this device',
      'Deleting your account'
    ])
  })

  it('every section has at least one paragraph', () => {
    for (const section of privacySections(HOST)) {
      expect(section.paragraphs.length, section.title).toBeGreaterThan(0)
    }
  })

  it('names the server the app uses', () => {
    const [where] = privacySections('ask.other.test')
    expect(where.paragraphs[0]).toBe(
      'Your chats, notes, memories and the files you attach are stored on the Ask server this app uses (ask.other.test). It’s a self-hosted server with its own database and file storage.'
    )
    expect(allText('ask.other.test')).not.toContain('{host}')
  })

  it('says where search terms and weather places go (rulings P6-R20, P6-R21)', () => {
    const web = privacySections(HOST)[3]
    expect(web.paragraphs).toEqual([
      'To answer, Ask searches the web. A place you ask the weather for goes to Open-Meteo. Your search terms, without your account, go to Ollama’s web search, Tavily, Brave Search and LangSearch, and to Ask’s own SearXNG, which reaches public search engines through a VPN.',
      'Ask then reads the pages it found, mostly with its own crawler. A page it can’t read directly may be fetched through Tavily or Firecrawl.'
    ])
  })

  it('has the exact copy of the remaining sections', () => {
    const s = privacySections(HOST)
    expect(s[1].paragraphs).toEqual([
      'Sign-in is handled by Supabase, which stores your email address and sign-in details. If you continue with Google, Google tells Supabase who you are.'
    ])
    expect(s[2].paragraphs).toEqual([
      'Your question, the conversation so far and the text of any files you attach are sent to AI models through Ollama. Most of these models, including the default one, run on Ollama’s cloud service (ollama.com); some run on Ask’s own computers. A photo you attach goes to the model too when it can read images.'
    ])
    expect(s[4].paragraphs).toEqual([
      'When you ask for an image to be made or edited, the request, and the picture being edited, go to Replicate, which runs the image model.'
    ])
    expect(s[5].paragraphs).toEqual([
      'Dictation sends your recording to Ask’s own speech-to-text server (Whisper), which turns it into text; the recording isn’t kept. Read-aloud sends the answer’s text to Ask’s own voice server (Kokoro).'
    ])
    expect(s[6].paragraphs).toEqual([
      'When Memory is on, Ask saves short facts it learns from your chats; when “Use past chats” is on, it looks through your earlier chats for anything relevant. Picking out and indexing facts, and indexing and ranking past chats, happen on Ask’s own computers. The answering model (on Ollama’s cloud service by default) can also save a fact itself and write the search of your past chats, and what’s relevant is included in what goes to it. You can turn both off, delete memories and clear the past-chat index in Settings → Memory.'
    ])
    expect(s[7].paragraphs).toEqual([
      'Source icons, and the icons of links you paste, load from Google’s favicon service, so Google sees the names of those sites, not the rest of your question. Discover pictures load from Bing’s image servers, and pictures in answers load straight from where they’re hosted.'
    ])
    expect(s[8].paragraphs).toEqual([
      'The app has no ads, no tracking and no analytics, and nothing about you is sold or shared for advertising.'
    ])
    expect(s[9].paragraphs).toEqual([
      'The app keeps your sign-in, your settings and a copy of your chat list on this device so it opens quickly. Signing out removes this account’s copies; your settings stay.'
    ])
    expect(s[10].paragraphs).toEqual([
      'Settings → Account → Delete account removes your chats, notes, memories, attached files, settings and the account itself from the Ask server. It can’t be undone. Settings kept on this device, like your custom instructions, stay there until you change them or remove the app. The services named above handle what they received under their own privacy policies.'
    ])
  })

  it.each([
    'Supabase',
    'Ollama',
    'ollama.com',
    'SearXNG',
    'Tavily',
    'Brave Search',
    'LangSearch',
    'Firecrawl',
    'Replicate',
    'Whisper',
    'Kokoro',
    'Google’s favicon service',
    'Open-Meteo',
    'Bing'
  ])('names %s', name => {
    expect(allText()).toContain(name)
  })

  it('does not name degoog, which is off in every deployment (P6-R20)', () => {
    expect(allText()).not.toMatch(/degoog/i)
  })

  it('uses curly apostrophes and quotes only', () => {
    expect(allText()).not.toMatch(/['"]/)
  })
})

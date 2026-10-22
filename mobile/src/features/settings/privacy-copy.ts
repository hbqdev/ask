// What the Privacy screen says: where a user's data goes and who handles it.
// Kept apart from the screen so the wording is tested as text. Keep it in
// step with the services Ask actually uses; the App Store privacy answers
// say the same.

/** One part of the Privacy screen: a heading and its paragraphs. */
export type PrivacySection = { title: string; paragraphs: string[] }

/** The Privacy screen's sections, naming `host` as the server the app uses. */
export function privacySections(host: string): PrivacySection[] {
  return [
    {
      title: 'Where your data lives',
      paragraphs: [
        `Your chats, notes, memories and the files you attach are stored on the Ask server this app uses (${host}). It’s a self-hosted server with its own database and file storage.`
      ]
    },
    {
      title: 'Your account',
      paragraphs: [
        'Sign-in is handled by Supabase, which stores your email address and sign-in details. If you continue with Google, Google tells Supabase who you are.'
      ]
    },
    {
      title: 'How answers are made',
      paragraphs: [
        'Your question, the conversation so far and the text of any files you attach are sent to AI models through Ollama. Most of these models, including the default one, run on Ollama’s cloud service (ollama.com); some run on Ask’s own computers. A photo you attach goes to the model too when it can read images.'
      ]
    },
    {
      title: 'Web search',
      paragraphs: [
        'To answer, Ask searches the web. Your search terms, without your account, go to Ollama’s web search, Tavily, Brave Search and LangSearch, and to Ask’s own search servers (SearXNG, which reaches public search engines through a VPN, and degoog).',
        'Ask then reads the pages it found, mostly with its own crawler. A page it can’t read directly may be fetched through Tavily or Firecrawl.'
      ]
    },
    {
      title: 'Images Ask makes',
      paragraphs: [
        'When you ask for an image to be made or edited, the request, and the picture being edited, go to Replicate, which runs the image model.'
      ]
    },
    {
      title: 'Voice',
      paragraphs: [
        'Dictation sends your recording to Ask’s own speech-to-text server (Whisper), which turns it into text; the recording isn’t kept. Read-aloud sends the answer’s text to Ask’s own voice server (Kokoro).'
      ]
    },
    {
      title: 'Memory and past chats',
      paragraphs: [
        'When Memory is on, Ask saves short facts it learns from your chats; when “Use past chats” is on, it looks through your earlier chats for anything relevant. Both are worked out on Ask’s own computers, and what’s relevant is included in what goes to the answering model. You can turn both off, delete memories and clear the past-chat index in Settings → Memory.'
      ]
    },
    {
      title: 'Pictures from other sites',
      paragraphs: [
        'Source icons load from Google’s favicon service, so Google sees the names of the sites an answer cites, not your question. Pictures in Discover and in answers load straight from the sites that publish them.'
      ]
    },
    {
      title: 'No tracking',
      paragraphs: [
        'The app has no ads, no tracking and no analytics, and nothing about you is sold or shared for advertising.'
      ]
    },
    {
      title: 'On this device',
      paragraphs: [
        'The app keeps your sign-in, your settings and a copy of your chat list on this device so it opens quickly. Signing out removes this account’s copies; your settings stay.'
      ]
    },
    {
      title: 'Deleting your account',
      paragraphs: [
        'Settings → Account → Delete account removes your chats, notes, memories, attached files, settings and the account itself from the Ask server. It can’t be undone. The services named above handle what they received under their own privacy policies.'
      ]
    }
  ]
}

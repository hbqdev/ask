<div align="center">

# Ask

Self-hosted AI answer engine that searches the web, reads what it finds, and writes you a cited answer.

</div>

Ask runs on your own hardware and keeps everything in your own database. It started life as a fork of [Morphic](https://github.com/miurla/morphic) and still shares its bones with that project (full acknowledgements at the bottom), but most of what's described below was built here.

## Features

Ask doesn't just paste your message into a search box. It first works out what you're actually asking — a follow-up like "what about the second one?" becomes a proper standalone search — then searches the web, reads the result pages, and reranks them so the answer is written from the best sources rather than the first page of links.

- Cited answers with a generative UI. Tables, images, and headings stream in live as the model writes.
- Long-term memory. Ask notices durable facts about you ("prefers metric", "vegetarian") and quietly carries them into later conversations. Everything it has learned is listed in settings where you can review or delete it, and new facts have to be seen twice before they're trusted.
- Conversation recall. When a past chat is relevant, Ask pulls it in and shows exactly which conversations it drew from, with links, so nothing feels spooky.
- Multi-user from the start. Supabase handles login, and Postgres row-level security keeps each user's chats, memories, and uploads isolated at the database layer, not just in app code.
- File uploads with retrieval, so you can ask questions about your own PDFs and documents.
- A library for saving answers as notes, shareable chat links, and small home-screen touches like weather and a news feed.
- Works with Ollama models, OpenAI, Anthropic, Google, or any OpenAI-compatible endpoint, switchable per chat. Search providers beyond the bundled SearXNG include Tavily, Brave, and Exa.
- Bring your own GPUs, anywhere. The heavier support models (reranking, embeddings, query understanding) don't have to run inside the app — they can live as small authenticated services on any machine on your network. And none of it is mandatory: leave those settings unset and everything falls back gracefully, all the way down to running with nothing but a chat model.

## Model manager

`selfhosted/model-manager` is a small companion app for operating a deployment. It's a web UI over Ask's configuration: settings grouped by what they do, tooltips that explain them, a masked diff before anything is written, automatic backups, and a one-click apply that restarts the right services — including ones running on other machines. It earns its keep once your setup spans more than one box.

## Running with Docker

```bash
git clone https://github.com/hbqdev/ask.git
cd ask
cp .env.local.example .env.local
```

Edit `.env.local` with your keys and endpoints, then:

```bash
docker compose up -d
```

Compose brings up Postgres, Redis, SearXNG, and Ask itself. SearXNG is bundled, so you don't need an external search API key just to try it.

## Local development

```bash
bun install
cp .env.local.example .env.local
bun dev
```

Visit http://localhost:3000. `bun run test` runs the test suite.

## Acknowledgements

Ask began as a fork of [Morphic](https://github.com/miurla/morphic) by [Yoshiki Miura](https://github.com/miurla). The original architecture, the generative UI system, and the first version of the search pipeline are his and his contributors' work, and this project wouldn't exist without it.

It also stands on [SearXNG](https://github.com/searxng/searxng), [Ollama](https://ollama.com), the [Qwen](https://github.com/QwenLM) model family, the [Vercel AI SDK](https://sdk.vercel.ai), and [shadcn/ui](https://ui.shadcn.com).

## License

Apache License 2.0 — see [LICENSE](LICENSE).

<div align="center">

# Ask

Self-hosted AI answer engine that searches the web, reads what it finds, and writes you a cited answer.

</div>

Ask runs on your own hardware, keeps everything in your own Postgres, and remembers who you are between conversations. It started life as a fork of [Morphic](https://github.com/miurla/morphic) and still shares its bones with that project (full acknowledgements at the bottom), but most of what's described below was built here.

## What it does

Every question goes through a short pipeline before the answering model ever sees it. A small local classifier reads the conversation and works out what you're actually asking, so a follow-up like "what about the second one?" turns into a real standalone search query instead of a vague fragment. It also decides when a message doesn't need a search at all. The resolved query gets expanded into a few variants, searched through SearXNG, and the result pages are crawled and reranked by a proper cross-encoder so the answering model reads the best passages rather than the first ten links.

On top of that pipeline:

- Cited answers with a generative UI. Tables, images, and headings stream in live as the model writes.
- Long-term memory. Ask notices durable facts about you ("prefers metric", "runs WSL2") and quietly carries them into later conversations. Everything it has learned is listed in settings where you can review or delete it, and new facts have to be seen twice before they're trusted.
- Conversation recall. When a past chat is relevant, Ask pulls it in and shows exactly which conversations it drew from, with links, so nothing feels spooky.
- Multi-user from the start. Supabase handles login, and Postgres row-level security keeps each user's chats, memories, and uploads isolated at the database layer, not just in app code.
- File uploads with retrieval, so you can ask questions about your own PDFs and documents.
- A library for saving answers as notes, shareable chat links, and small home-screen touches like weather and a news feed.
- Works with Ollama models, OpenAI, Anthropic, Google, or any OpenAI-compatible endpoint, switchable per chat. Search providers beyond the bundled SearXNG include Tavily, Brave, and Exa.

## Support models on your own GPUs

The interesting part of self-hosting this stack is that the non-chat models don't have to live in the app container. Ask talks to them over small token-authenticated HTTP services, so each one can sit wherever you have spare VRAM:

- The classifier and query expander point at any Ollama host.
- Reranking goes to a remote reranker service. We run Qwen3-Reranker-8B on an RTX 2080 Ti and it noticeably beats the classic cross-encoders.
- Embeddings (for memory, recall, and uploads) go to a remote embedding service. Ours runs Qwen3-Embedding-0.6B on a Quadro P4000 that also handles Plex transcoding, and the two coexist fine.

None of it is mandatory. Leave the env vars unset and everything degrades gracefully: embeddings run in-process on CPU, reranking falls back to a bi-encoder, and the whole app still works with nothing but a chat model.

## Model manager

`selfhosted/model-manager` is a small companion app for actually operating a deployment like this. It's a web UI over Ask's `.env`: settings grouped by what they do, tooltips that explain them, a masked diff before anything is written, automatic backups, and a one-click apply that restarts the right containers, including services on other machines over SSH. It earns its keep once your models live on three different boxes.

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

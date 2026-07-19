<div align="center">

# Ask

Self-hosted AI answer engine. Searches the web and writes cited answers.

</div>

Ask is a fork of [Morphic](https://github.com/miurla/morphic), extended for self-hosted use. See acknowledgements at the end.

## Features

- Web search before answering, with inline citations and streamed rich output (tables, images, headings)
- Follow-up questions are resolved into standalone search queries; messages that don't need a search skip it
- Result pages are crawled and reranked before the answer is written
- Long-term memory: durable user facts are extracted automatically, applied in later conversations, and can be reviewed or deleted in settings
- Conversation recall: relevant past chats are retrieved and linked in the answer
- Multi-user: Supabase authentication with Postgres row-level security per user
- File uploads with retrieval (PDF and document Q&A)
- Notes library, shareable chat links, weather and news widgets
- Models: Ollama, OpenAI, Anthropic, Google, or any OpenAI-compatible endpoint, selectable per chat
- Search providers: SearXNG (bundled), Tavily, Brave, Exa
- Optional remote services for reranking and embeddings (token-authenticated HTTP, any host); without them, in-process defaults are used

## Model manager

`selfhosted/model-manager` is a companion web UI for Ask's configuration: grouped settings with validation and tooltips, diff preview before writing, automatic backups, and apply-with-restart for the affected services, including remote hosts over SSH.

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

This starts Postgres, Redis, SearXNG, and Ask. SearXNG is bundled, so no external search API key is required.

## Local development

```bash
bun install
cp .env.local.example .env.local
bun dev
```

Visit http://localhost:3000. Run tests with `bun run test`.

## Acknowledgements

Ask began as a fork of [Morphic](https://github.com/miurla/morphic) by [Yoshiki Miura](https://github.com/miurla). The original architecture, generative UI system, and search pipeline are the work of Morphic and its contributors.

Built with [SearXNG](https://github.com/searxng/searxng), [Ollama](https://ollama.com), [Qwen](https://github.com/QwenLM) models, the [Vercel AI SDK](https://sdk.vercel.ai), and [shadcn/ui](https://ui.shadcn.com).

## License

Apache License 2.0 — see [LICENSE](LICENSE).

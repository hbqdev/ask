<div align="center">

# Ask

A self-hosted AI search engine with grounded, cited answers and a generative UI.

</div>

## What is Ask?

Ask is a self-hosted AI-powered search tool built for personal and team use. It searches the web before answering every question, cites its sources inline, and renders answers with rich components — tables, headings, images — streamed live from the model.

It runs entirely on your own infrastructure: no cloud dependency, no usage tracking, your data stays yours.

## Features

- Web search before every answer — no responses from memory alone
- Grounded answers with inline citations
- Generative UI — rich components streamed live (tables, images, headings)
- Search modes: Quick and Adaptive
- Model selector with support for OpenAI, Anthropic, Google, Ollama, and any OpenAI-compatible provider
- Multiple search providers (SearXNG self-hosted, Tavily, Brave, Exa)
- Full-text search through your conversation history
- File upload with PDF extraction and image support
- Chat history stored in PostgreSQL
- User authentication via Supabase Auth
- Docker deployment ready

## Running with Docker

```bash
git clone https://github.com/hbqdev/ask.git
cd ask
cp .env.local.example .env.local
```

Edit `.env.local` with your API keys, then:

```bash
docker compose up -d
```

Docker Compose starts PostgreSQL, Redis, SearXNG, and Ask. SearXNG is included so no external search API key is required to get started.

## Local Development

```bash
git clone https://github.com/hbqdev/ask.git
cd ask
bun install
cp .env.local.example .env.local
bun dev
```

Visit http://localhost:3000.

## Based on Morphic

Ask is a fork of [Morphic](https://github.com/miurla/morphic) by [Yoshiki Miura](https://github.com/miurla), an open-source AI search engine. All credit for the original architecture, generative UI system, and search pipeline goes to the Morphic project and its contributors.

This fork adds self-hosted focused changes: local disk uploads, PDF extraction via poppler, forced web search on every turn, conversation history search, and a few UX improvements.

## License

Apache License 2.0 — see [LICENSE](LICENSE).

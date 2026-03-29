# Docker Guide

This guide covers running Morphic with Docker, including development setup, prebuilt images, and deployment options.

## Quick Start with Docker Compose

1. Configure environment variables:

```bash
cp .env.local.example .env.local
```

Edit `.env.local` and set the required variables:

```bash
DATABASE_URL=postgresql://morphic:morphic@postgres:5432/morphic
OPENAI_API_KEY=your_openai_key
```

If you switch `SEARCH_API` to `tavily`, set `TAVILY_API_KEY`.  
`BRAVE_SEARCH_API_KEY` is optional and only needed when using Brave as a dedicated general-search provider.

**Note**: Authentication is disabled by default (`ENABLE_AUTH=false` in `.env.local.example`).

**Optional**: Customize PostgreSQL credentials by setting environment variables in `.env.local`:

```bash
POSTGRES_USER=morphic      # Default: morphic
POSTGRES_PASSWORD=morphic  # Default: morphic
POSTGRES_DB=morphic        # Default: morphic
POSTGRES_PORT=5432         # Default: 5432
```

2. Start the Docker containers:

```bash
docker compose up -d
```

The application will:

- Start PostgreSQL 17 with health checks
- Start Redis for SearXNG search caching
- Wait for the database to be ready
- Run database migrations automatically
- Start the Morphic application
- Start SearXNG and connect Morphic to it automatically

3. Visit http://localhost:3000 in your browser.

### Built-in Docker Defaults

When running with `docker compose up -d`, Morphic is automatically configured to use internal Docker services:

- `LOCAL_REDIS_URL=redis://redis:6379`
- `SEARCH_API=searxng`
- `SEARXNG_API_URL=http://searxng:8080`
- `MORPHIC_CLOUD_DEPLOYMENT=false`

Important precedence note:

- Values defined in `docker-compose.yaml` under `services.morphic.environment` take precedence over `.env.local` (`env_file`) values.
- To override a default from compose, export the variable before startup. Example:
  - `SEARCH_API=tavily docker compose up -d`
  - `SEARXNG_API_URL=http://custom-searxng:8080 docker compose up -d`

### File Upload in Docker

File upload requires externally reachable object storage. Docker Compose does not provision storage by default.

- Required: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_URL`
- Required (one of): `R2_ACCOUNT_ID` (Cloudflare R2) or `S3_ENDPOINT` (generic S3-compatible endpoint)

If these are not set, `/api/upload` returns `400` and upload is disabled.

**Note**: Database data is persisted in a Docker volume. To reset the database, run:

```bash
docker compose down -v  # This will delete all data
```

## Using Prebuilt Image

Prebuilt Docker images are automatically built and published to GitHub Container Registry:

```bash
docker pull ghcr.io/miurla/morphic:latest
```

You can use it with docker-compose by setting the image in your `docker-compose.yaml`:

```yaml
services:
  morphic:
    image: ghcr.io/miurla/morphic:latest
    env_file: .env.local
    environment:
      DATABASE_URL: postgresql://morphic:morphic@postgres:5432/morphic
      DATABASE_SSL_DISABLED: 'true'
      ENABLE_AUTH: 'false'
    ports:
      - '3000:3000'
    depends_on:
      - postgres
      - redis
```

**Note**: The prebuilt image runs in **anonymous mode only** (`ENABLE_AUTH=false`). Supabase authentication cannot be enabled because `NEXT_PUBLIC_*` environment variables are embedded at build time by Next.js. To enable authentication or customize model configurations, you need to build from source — see [CONFIGURATION.md](./CONFIGURATION.md) for details.

## Building from Source

Use Docker Compose for a complete setup with PostgreSQL, Redis, and SearXNG. See the [Quick Start](#quick-start-with-docker-compose) section above.

## Useful Commands

```bash
# Start all containers in background
docker compose up -d

# Stop all containers
docker compose down

# Stop all containers and remove volumes (deletes database data)
docker compose down -v

# View logs
docker compose logs -f morphic

# Rebuild the image
docker compose build morphic
```

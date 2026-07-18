FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY . .
RUN bun run build

FROM node:22-slim AS run
WORKDIR /app
# docker CLI (compose plugin) + ssh client for apply orchestration.
# docker-compose-plugin isn't in Debian's default apt repos (it's Docker's
# own package), so add Docker's official apt repo for the CLI-only packages.
# We only need the client (talks to the host daemon over the mounted
# socket), not the full docker.io engine package.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg openssh-client \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
# The standalone server.js listens on $PORT (default 3000), independent of
# EXPOSE below — without this it would silently bind to 3000 and every
# request against the mapped 3939 port would connection-refuse.
ENV PORT=3939
ENV HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# NOTE: this app currently has no public/ directory (no static assets), so
# there is nothing to copy here. Add a `COPY --from=build /app/public
# ./public` line back if one is introduced later.
EXPOSE 3939
CMD ["node", "server.js"]

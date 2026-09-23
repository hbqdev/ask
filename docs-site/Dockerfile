# syntax=docker/dockerfile:1.7
# Ask docs site — build the VitePress site from THIS repo checkout and serve it
# with nginx. The build context is the REPO ROOT (the generators read ../app,
# ../lib, compose files, …); docs-site/Dockerfile.dockerignore whitelists what
# enters the context and excludes every .env* file.
#
#   docker compose -p ask-docs -f docs-site/docker-compose.yaml up -d --build

FROM oven/bun:1.3 AS build
WORKDIR /repo
COPY docs-site/package.json docs-site/bun.lock docs-site/
RUN cd docs-site && bun install --frozen-lockfile
COPY . .
# lib/db/schema.ts imports drizzle-orm + cuid2; resolve them from the docs-site
# install (the app's own node_modules is not in the build context).
RUN ln -s /repo/docs-site/node_modules /repo/node_modules \
 && cd docs-site \
 && bun run gen \
 && bun run docs:build

FROM nginx:1.27-alpine
COPY <<'NGINX' /etc/nginx/conf.d/default.conf
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;

  gzip on;
  gzip_comp_level 6;
  gzip_min_length 512;
  gzip_vary on;
  gzip_types text/plain text/css application/javascript application/json image/svg+xml application/xml;

  # VitePress hashed assets never change.
  location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
    try_files $uri =404;
  }

  # cleanUrls: /foo/bar -> /foo/bar.html; unknown paths -> VitePress 404 page.
  location / {
    add_header Cache-Control "no-cache";
    try_files $uri $uri.html $uri/ =404;
  }
  error_page 404 /404.html;
}
NGINX
COPY --from=build /repo/docs-site/.vitepress/dist /usr/share/nginx/html
EXPOSE 80

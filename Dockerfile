# One image for web, api and worker; docker-compose.prod.yml picks the command for each.
FROM node:22-bookworm AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY . .
RUN pnpm install --frozen-lockfile
# The browser calls the API through the reverse proxy on the same origin.
ARG NEXT_PUBLIC_API_URL=/api
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @archaeo/web build

FROM node:22-bookworm-slim
# git for clones, history and worktrees; the Docker CLI so the worker can run fix sandboxes on the host's Docker.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssl && rm -rf /var/lib/apt/lists/*
COPY --from=docker:27.5.1-cli /usr/local/bin/docker /usr/local/bin/docker
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1

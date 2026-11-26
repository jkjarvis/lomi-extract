# One multi-stage build for every service; compose picks the target.

FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12.11.2 && pnpm --version
ENV TURBO_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
WORKDIR /app

# Dependencies only: cached until a manifest or the lockfile changes.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/db/prisma packages/db/prisma
COPY packages/extraction/package.json packages/extraction/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY tests/integration/package.json tests/integration/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm turbo run build --filter=@lomi/api --filter=@lomi/worker --filter=@lomi/web --filter=@lomi/db

# Node runtime shared by migrate / api / worker.
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app

FROM runtime AS migrate
WORKDIR /app/packages/db
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/seed.js"]

FROM runtime AS api
WORKDIR /app/apps/api
EXPOSE 3001
CMD ["node", "dist/server.js"]

FROM runtime AS worker
WORKDIR /app/apps/worker
CMD ["node", "dist/main.js"]

# Static UI behind nginx, which also proxies /api to the API service.
FROM nginx:1.27-alpine AS web
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080

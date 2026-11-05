# SPDX-License-Identifier: AGPL-3.0-only
FROM node:24-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/pipeline/package.json packages/pipeline/
COPY packages/providers/package.json packages/providers/
COPY packages/documents/package.json packages/documents/
COPY packages/notifications/package.json packages/notifications/
COPY packages/config/package.json packages/config/
RUN pnpm install --frozen-lockfile --filter @our-stream/worker...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/config packages/config
COPY packages/db packages/db
COPY packages/providers packages/providers
COPY packages/documents packages/documents
COPY packages/pipeline packages/pipeline
COPY packages/notifications packages/notifications
COPY apps/worker apps/worker
RUN pnpm --filter @our-stream/worker... build && pnpm --filter @our-stream/worker deploy --prod --legacy /out

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out /app
# Media scratch space; mount a volume here for large uploads (WORKER_TMP_DIR).
RUN mkdir -p /var/tmp/ourstream && chown node:node /var/tmp/ourstream
ENV WORKER_TMP_DIR=/var/tmp/ourstream
USER node
CMD ["node", "dist/main.js"]

# SPDX-License-Identifier: AGPL-3.0-only
FROM node:24-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/config/package.json packages/config/
RUN pnpm install --frozen-lockfile --filter @our-stream/web...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/config packages/config
COPY packages/contracts packages/contracts
COPY apps/web apps/web
ENV NEXT_TELEMETRY_DISABLED=1
# /api and /media rewrites are fixed at build time (next.config.ts); default matches compose.
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=${API_INTERNAL_URL}
# Behind an edge (Caddy in compose, the chart's Ingress) /api and /media never reach web, so the
# image carries no rewrite by default and fails closed on a misrouted request. Only an image that
# must serve without an edge is built with --build-arg WEB_PROXY_API=true.
ARG WEB_PROXY_API=false
ENV WEB_PROXY_API=${WEB_PROXY_API}
RUN pnpm --filter @our-stream/contracts build && pnpm --filter @our-stream/web build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

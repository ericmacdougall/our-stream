# SPDX-License-Identifier: AGPL-3.0-only
FROM node:24-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/authz/package.json packages/authz/
COPY packages/contracts/package.json packages/contracts/
COPY packages/config/package.json packages/config/
RUN pnpm install --frozen-lockfile --filter @our-stream/api...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/config packages/config
COPY packages/db packages/db
COPY packages/authz packages/authz
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN pnpm --filter @our-stream/api... build && pnpm --filter @our-stream/api deploy --prod --legacy /out

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
COPY --from=build /app/packages/db/migrations /app/node_modules/@our-stream/db/migrations
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]

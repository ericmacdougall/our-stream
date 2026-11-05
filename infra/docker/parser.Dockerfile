# SPDX-License-Identifier: AGPL-3.0-only
# Document parser sandbox (M2a, docs/documents.md "Parser sandbox"). It reads one file from a job slot and writes
# a result file; it has no database, no object storage and no network, and runs as the non-root `node` user on
# a read-only root filesystem (compose/Helm set those). No secrets are ever mounted into it.
FROM node:24-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/parser/package.json apps/parser/
COPY packages/documents/package.json packages/documents/
COPY packages/config/package.json packages/config/
RUN pnpm install --frozen-lockfile --filter @our-stream/parser...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/config packages/config
COPY packages/documents packages/documents
COPY apps/parser apps/parser
RUN pnpm --filter @our-stream/parser... build && pnpm --filter @our-stream/parser deploy --prod --legacy /out

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
# The job slot and the control directory are volumes shared with the worker (empty named volumes inherit this
# ownership on first use). Nothing else is writable.
RUN mkdir -p /slot /ctl && chown node:node /slot /ctl
USER node
ENV PARSER_SLOT_DIR=/slot PARSER_CTL_DIR=/ctl
# No --max-old-space-size here: on the process it overrides the extraction thread's resourceLimits (found by the
# runtime suite: a 24 MB thread cap was not enforced under the flag). The thread cap and the 1 GiB cgroup bound memory.
CMD ["node", "dist/main.js"]

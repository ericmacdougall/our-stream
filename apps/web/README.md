# @our-stream/web

Next.js 16 App Router front end for the M1a permissioned video feed. It never touches the
database: every read and write goes to the API through the typed client in `@our-stream/contracts`
(ADR-0011), and every user-facing string goes through `src/lib/i18n.ts` (`src/messages/en.json`).

## How it talks to the API

- The browser only calls this origin. `next.config.ts` rewrites `/api/*` and `/media/*` to
  `API_INTERNAL_URL` (default `http://localhost:4000`) so the HttpOnly session cookie travels
  same-site and `FeedItem.media` relative paths resolve. Rewrites are fixed at build time; the Docker
  build takes `API_INTERNAL_URL` as a build arg (default `http://api:4000`, matching compose).
- Server components use the Data Access Layer in `src/lib/api/server.ts`, which forwards the request
  cookies. `src/proxy.ts` only redirects on cookie presence; the real check is `GET /v1/me`.
- Mutations send the CSRF token from `GET /v1/me` as `x-csrf-token` (`src/lib/api/client.ts`).
- Service worker (`src/sw.ts`, bundled to `public/sw.js` by `scripts/build-sw.mjs`) caches only
  same-origin static assets; never `/api` or `/media`. Caches are cleared on sign-out and whenever
  `/v1/sync` reports an epoch change (ADR-0004). It registers in production or with
  `NEXT_PUBLIC_ENABLE_SW=1`.

## Run

```sh
pnpm install
pnpm --filter @our-stream/contracts build

# against the in-repo mock API (apps/web/test/mock-api; ffmpeg optional for an HLS fixture)
pnpm --filter @our-stream/web mock-api            # http://127.0.0.1:4100
API_INTERNAL_URL=http://127.0.0.1:4100 pnpm --filter @our-stream/web dev   # http://localhost:3000

# against a real API
API_INTERNAL_URL=http://localhost:4000 pnpm --filter @our-stream/web dev
```

Mock knobs: `MOCK_MEDIA=hls|mp4|webm` (default auto: HLS when ffmpeg is on PATH, else `tiny.mp4`),
`MOCK_PROCESSING_MS` (per processing step, default 300). Magic links are printed to the mock's
stderr.

## Test

```sh
pnpm --filter @our-stream/web test        # vitest: feed keyboard reducer, cursor merge, chapters, settings, SW rules, schedule
pnpm --filter @our-stream/web typecheck
pnpm --filter @our-stream/web exec playwright install --with-deps chromium
pnpm --filter @our-stream/web test:e2e    # builds the app, starts the mock, runs flow/keyboard/a11y specs
E2E_API_URL=http://localhost:4000 pnpm --filter @our-stream/web test:e2e   # same suite against a real API
```

`E2E_SKIP_BUILD=1` reuses an existing `.next` build; `E2E_BROWSER_CHANNEL=chrome` runs on an
installed Chrome when the bundled Chromium lacks H.264. Reports land in `playwright-report/` and
`test-results/`.

## Routes

`/` feed (default landing), `/sign-in`, `/sign-up`, `/magic?token=`, `/streams`, `/streams/[id]`,
`/upload`, `/content/[id]`, `/content/[id]/publish`, `/notifications`.

## Routes the web app expects from the API

The contract freezes the shapes (`packages/contracts/src/m1a.ts`); the paths below are what the
web app calls (typed in `packages/contracts/src/m1a-paths.ts` until the API emits them). All
mutations carry `x-csrf-token`; auth routes are the only unauthenticated ones.

| Method      | Path                               | Request → Response                                       |
| ----------- | ---------------------------------- | -------------------------------------------------------- |
| POST        | `/v1/auth/signup`                  | SignupRequest → Me (+ session cookie)                    |
| POST        | `/v1/auth/login`                   | LoginRequest → Me (+ session cookie)                     |
| POST        | `/v1/auth/magic-link`              | MagicLinkRequest → Ok (always)                           |
| POST        | `/v1/auth/magic-link/consume`      | MagicLinkConsumeRequest → Me (+ session cookie)          |
| POST        | `/v1/auth/logout`                  | – → Ok (clears cookie)                                   |
| GET         | `/v1/me`                           | – → Me                                                   |
| GET         | `/v1/sync`                         | – → SyncResponse                                         |
| GET         | `/v1/members`                      | – → `{ items: MemberSummary[] }`                         |
| GET / POST  | `/v1/streams`                      | – → `{ items: Stream[] }` / CreateStreamRequest → Stream |
| GET         | `/v1/streams/{id}`                 | – → Stream                                               |
| GET         | `/v1/streams/{id}/members`         | – → `{ items: { userId, displayName, role }[] }`         |
| POST        | `/v1/streams/{id}/grants`          | GrantStreamRoleRequest → Ok                              |
| POST        | `/v1/content`                      | CreateContentRequest → ContentDetail                     |
| GET / PATCH | `/v1/content/{id}`                 | – / UpdateContentRequest → ContentDetail                 |
| POST        | `/v1/content/{id}/upload/init`     | UploadInitRequest → UploadInitResponse                   |
| POST        | `/v1/content/{id}/upload/complete` | UploadCompleteRequest → ContentDetail                    |
| POST        | `/v1/content/{id}/publish`         | PublishRequest → ContentDetail                           |
| POST        | `/v1/content/{id}/retract`         | – → ContentDetail                                        |
| POST        | `/v1/content/{id}/view`            | ViewEventRequest → Ok                                    |
| GET         | `/v1/feed`                         | `?cursor&limit&streamId` → FeedResponse                  |
| GET         | `/v1/notifications`                | – → NotificationList                                     |
| POST        | `/v1/notifications/{id}/read`      | – → Ok                                                   |

Polling expectation: after `upload/complete`, `GET /v1/content/{id}` must expose the uploaded
version's progress. The web app waits until `currentVersion.id` equals the version returned by
`upload/init` and its status is `current` (or `failed`); for a draft that means the first upload is
the current version from the start, for a replacement the switch happens once it is processed
(ADR-0003). Media URLs in `FeedItem.media` must be relative `/media/...` paths; anything else is
refused by the player.

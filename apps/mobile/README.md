# our-stream mobile (apps/mobile)

Expo (SDK 58, Expo Router) read-and-react client for any our-stream server: sign in, feed with HLS
playback, likes, threaded comments, share as link, search, engagement and notifications. Licensed
Apache-2.0 (see `LICENSE`, `THIRD_PARTY_NOTICES.md`); the only workspace dependency is
`@our-stream/contracts` (AGPL-3.0-only OR Apache-2.0). Design notes: `docs/mobile.md`.

## Layout

```
src/app/              Expo Router screens
  _layout.tsx         session provider, deep links (magic links)
  index.tsx           redirect by session state
  sign-in.tsx         email → server discovery/confirm → password or magic link
  server.tsx          manual server address (Q5 fallback)
  magic.tsx           magic-link landing (explicit "Sign in" before the token is used)
  (tabs)/             feed, search, notifications
  content/[id]/       detail with player, like, comments; share.tsx picks a recipient
src/components/       Player (expo-video + media token + engagement), FeedCard, CommentThread, Snippet, Button, Notice
src/lib/              pure modules with vitest tests: discovery, server, session, api, media, engagement,
                      snippets, comments, feed, magic, errors; storage adapters; session context
src/i18n.ts           string table (en)
```

## Commands

```sh
pnpm --filter @our-stream/contracts build
pnpm --filter @our-stream/mobile test        # vitest, src/lib/**/*.test.ts
pnpm --filter @our-stream/mobile typecheck
pnpm --filter @our-stream/mobile lint        # expo lint
pnpm exec expo start                         # from apps/mobile: Expo Go / dev build
pnpm exec expo start --web                   # development click tests only
pnpm exec expo export --platform ios --platform android --platform web --output-dir /tmp/export
```

Point the app at a server by signing in with a work email whose domain publishes
`/.well-known/our-stream.json`, or enter the address manually. Development builds accept
`http://localhost` and `http://127.0.0.1` for a local API.

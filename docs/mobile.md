# Mobile app (apps/mobile)

The Expo app is a thin read-and-react client (M1b): sign in, vertical feed with HLS playback, like,
threaded comments, share as link, keyword search, engagement milestones and notifications. Upload,
push notifications and offline viewing arrive with M10. It talks to the platform only through the
public API and `@our-stream/contracts` (ADR-0011) and is licensed Apache-2.0 (decision Q13).

## One public app, any server (decision Q5)

The store build has no server baked in. On first sign-in the app resolves the server from the work
email address, shows it, and pins it after the user confirms:

1. **Discovery document.** The organisation publishes
   `https://<email domain>/.well-known/our-stream.json`:

   ```json
   {
     "version": 1,
     "apiUrl": "https://stream.example.com/api",
     "webUrl": "https://stream.example.com"
   }
   ```

   `apiUrl` is where `/v1/...` and `/media/...` live (a web deployment proxies both under `/api` and
   `/media`, see `apps/web/next.config.ts`, so the web origin plus `/api` is a valid `apiUrl`; a bare
   API origin works too). `webUrl` (optional, defaults to `apiUrl` without a trailing `/api`) is the
   origin share links are built on. Both must be `https:` with no credentials, query or fragment.

2. **Trust rules** (`apps/mobile/src/lib/discovery.ts`): the app fetches exactly that URL over https,
   refuses redirects (the response must come from the requested URL), caps the body at 16 KiB, times
   out after 8 s, and rejects email domains that are IP literals, dotless, non-ASCII or reserved
   (`.local`, `.internal`, ...). The resolved host is shown before any credential is typed; when it is
   outside the email domain (legitimate for a hosted service) the confirm screen warns and makes
   cancel the default. The confirmed server is pinned per email domain in the device's secure storage
   and reused silently; "Use a different server" clears the pin.
3. **Manual fallback.** When no document exists (or it fails any rule) the user types the address they
   use in the browser; the app probes `/v1/meta` then `/api/v1/meta` and validates the answer against
   `MetaResponse`.

Development builds additionally accept `http://localhost` and `http://127.0.0.1` so the app can talk
to a local API; no other plain-http host is ever accepted.

## Sessions

Native clients use the bearer transport (`docs/api.md`, "Sessions"): sign-in calls carry
`x-session-transport: bearer` and the session value from `AuthResponse.sessionToken` is stored in
`expo-secure-store` (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`). Every request runs with `credentials: 'omit'`
so the platform cookie jar never holds a copy. Sign-out calls `POST /v1/auth/logout` best effort and
then clears the stored session; a 401 anywhere, or 403 `not_member`, signs out locally. The web target
(`expo start --web`, used for development click tests only) keeps the session in `sessionStorage` in
development and in memory otherwise, because SecureStore does not exist on web.

Magic links (device-bound, no associated domains). The app requests a link with a `clientChallenge`:
before asking, it makes a random 32-byte verifier (`expo-crypto`), keeps it in `expo-secure-store`
(`WHEN_UNLOCKED_THIS_DEVICE_ONLY`) with the server the request goes to and a timestamp, and sends only
`base64url(SHA-256(verifier))`. For such a request the API mails
`${APP_BASE_URL}/magic?token=<T>&app=1`, an https page on the user's own server that does not consume the
token and offers "Open in the our-stream app", a link to
`ourstream://magic?token=<T>&server=<origin of that page>` (contract in `docs/api.md`). The app needs no
`associatedDomains` or intent filters and works for any self-hosted server. When the app receives that
link it moves the token into a memory slot (a token the router parsed is stripped from the route
parameters) and, on "Sign in", consumes it only if (a) a stored verifier exists and is younger than the
link lifetime (15 minutes, the API default `MAGIC_LINK_TTL_MINUTES`) and (b) the `server` origin equals
the origin of that request's `webUrl`; otherwise it shows "This sign-in link was not started on this
device or belongs to a different server" and sends nothing. The consume call carries the verifier, and
the API consumes the link only when `SHA-256(verifier)` matches the stored challenge, so a link opened on
another device, or a crafted one, cannot sign this app in and a failed attempt does not burn the link.
The verifier is deleted after any attempt the server answered and kept only on network loss, so the same
link can be retried within its lifetime. Requesting a new link replaces the verifier, so only the newest
emailed link works. When the link belongs to a different account than the current session, the app shows
the incoming address and asks whether to switch (declining revokes the session the link created). A
consumed token is remembered for the process so a replayed launch URL cannot resubmit it. The decisions
live in `src/lib/magic-consume.ts` and `magic-verifier.ts` and the startup flow in `startup.ts`, all unit
tested.

## Playback and media tokens

Media URLs from the API are relative proxy paths (`/media/{content}/{version}/...`). Before playing,
the app fetches `GET /v1/content/:id/media-token` and plays `${apiUrl}${media.hls}?t=<token>` with
`expo-video` (native controls, so captions from the HLS subtitle track and full-screen are available).
The proxy rewrites playlists so segment URIs keep the token. The token is refreshed (source replaced,
position restored) when fewer than 60 s remain before `expiresAt` at the next (re)start and once after a
player error; a 404 from the token route, a token for another `versionId`, or `content_not_found` on
any call shows "This clip is no longer available" and drops the item. Tokens never appear in logs or
share text (`src/lib/media.ts` refuses to share anything but the server's `linkPath`).

## Engagement

`src/lib/engagement.ts` keeps one client `sessionKey` per (user, content, version) playback session with the
milestones already sent (`view_start`, `progress_25/50/75`, `complete`) in AsyncStorage, so a restart
never resends a milestone. A milestone is claimed in memory before the request, persisted only after
the server answered, and released on failure. After `complete` (or 24 h) the next play opens a new
session, which the server counts as a rewatch (also when the clip is replayed without leaving the
screen). A 409 `stale_version` (the clip was replaced) or a media token for another version makes the
screen refetch the item rather than drop it; retracted or hidden clips (404-class) are dropped. Records are keyed by user so a shared device never inherits another user's session, written
one at a time, and pruned beyond 200 entries or 30 days.

## Accessibility

Every control has a role and label; like buttons expose `selected`; targets are at least 44 pt; text
scales with the system font size; previous/next buttons move through the feed without a swipe; the
system "reduce motion" setting turns off autoplay and scroll animation; overlay text sits on a scrim.
Status and error texts are live regions. VoiceOver/TalkBack runs are a manual checklist (MOB-A11Y).

## Known limitations (M1b)

- No device run yet (no simulator on the build machine): native HLS playback, token refresh with
  source replace + seek, SecureStore and VoiceOver/TalkBack are covered by code review and unit tests,
  not by an observed device session. The web target proves request shapes and screen flows only.
- `expo lint` has no configuration in `apps/mobile` yet; prettier, tsc, vitest and the SPDX/licence
  gates run.
- A cold start while offline (or a 5xx from `GET /v1/me`) shows the sign-in screen with a notice instead
  of a retry; any other 401/403 signs out locally with the session-ended notice.
- Magic links expire in the app after 15 minutes (the API default); a server configured with a longer
  `MAGIC_LINK_TTL_MINUTES` still gets links that the app refuses after 15 minutes. The handoff page is
  built in the web app; until a web build that ships it is deployed, app-started links land on a page
  that cannot open the app. Not yet exercised on a device (custom-scheme hand-off from a mail client).
- Discovery's exact-URL check relies on React Native's `fetch` filling `response.url` (an empty value
  fails closed as "redirected", leaving only manual entry); unverified on a device.
- A chunked discovery response without `content-length` is read in full before the 16 KiB check; only
  the 8 s timeout bounds it.
- Engagement milestones the server refuses with a 4xx are abandoned for the playback session in memory
  only; a restart may retry each once. Transient failures (429, 5xx, network) retry at most once per
  15 s per milestone.

## Running it

```sh
pnpm --filter @our-stream/contracts build
pnpm --filter @our-stream/mobile test        # vitest over src/lib (pure modules)
pnpm --filter @our-stream/mobile typecheck
cd apps/mobile && pnpm exec expo start       # Expo Go or a development build; scan the QR code
cd apps/mobile && pnpm exec expo start --web # development click tests in a browser
```

Against a local API: sign in with any email, choose "Enter the server address manually" and type
`http://localhost:4000` (development builds only). The web target must be served from the API's
`APP_BASE_URL` origin for CORS. HLS plays natively on iOS, Android and Safari; Chrome has no native HLS,
so on the web target the feed lists and reacts but does not play.

## Distribution

One public App Store / Google Play app serves every self-hosted and hosted server through the
discovery flow above. Organisations that want a private build (fixed server, MDM push) use Apple
Business Manager custom apps or managed Google Play private apps; those builds set the server through
the same discovery document on an internal domain. Detailed enterprise distribution runbooks are an
M10 deliverable.

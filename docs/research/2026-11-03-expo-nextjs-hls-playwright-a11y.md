# Research: Expo, Next.js PWA, HLS video, Playwright, accessibility of autoplaying feeds

Researched 2026-11-03. [V] verified on the cited page, [I] inference. Confidence in brackets.

## Expo

- SDK 58 (2026-10-15): https://expo.dev/changelog/sdk-58 [V, high]. React Native 0.88, React 19.2.3, react-native-web 0.21, Node >= 22.13. Expo Go for 58 lagging; `create-expo-app --template default@sdk-58`. Legacy architecture removed in SDK 55+.
- expo-router 58: data loaders, SSR and middleware stable; navigation core reworked; `web.output` defaults to `server`; migration guide https://docs.expo.dev/router/migrate/sdk-57-to-58/ [V, high].
- expo-video ~58: https://docs.expo.dev/versions/latest/sdk/video/ [V, high]. HLS via `contentType: 'hls'` or `.m3u8`; iOS cannot cache HLS; PiP and background playback via config plugin (requires a development build, not Expo Go). `expo-av` removed in SDK 55: use expo-video and expo-audio.
- Uploads: `expo-file-system` class API (`File.upload()`, `createUploadTask`, background session on iOS); `expo-image-picker` `mediaTypes: ['videos']`; request media library permission first on iOS [V, high].
- `expo-secure-store` for tokens (native only) [V, high]. `expo-auth-session`: PKCE S256 by default, `useAutoDiscovery(issuer)`, app `scheme` required, no client secrets on device [V, high].
- EAS pricing https://expo.dev/pricing [V, high]: free tier 15 Android + 15 iOS builds per month; `eas build --local` and `npx expo run:*` avoid cloud builds.
- pnpm monorepo: https://docs.expo.dev/guides/monorepos/ [V, high]. Isolated installs supported since SDK 54; fall back to `nodeLinker: hoisted` only on a real failure; one `react`/`react-native` version only.
- Enterprise distribution: Apple private (custom) apps via Apple Business; Android managed Google Play with organization ids [V, high].

## Sharing UI between Next.js and Expo

Facts [V, medium]: Expo deprecated webpack web builds (SDK 50); Solito's compatibility table stops at Expo SDK 54 and notes react-native-web gaps with React 19; Next.js 16.4 ships React 19.3 while Expo 58 ships React 19.2.3, so one shared `react` is not possible today [I, high].

Recommendation [I, medium-high]: do not share rendered UI. `apps/web` (Next.js, DOM, hls.js) and `apps/mobile` (Expo Router, expo-video) stay separate; share `packages/contracts` (zod schemas, types, API client), feed ranking logic, analytics event schema, i18n catalogs and design tokens. Revisit only for large non-video admin surfaces.

## Next.js

- Stable 16.4.5 after the 2026-11-03 security release https://nextjs.org/blog/november-2026-security-release [V, high]; several CVEs are cross-tenant cache disclosures in Cache Components. Keep patched; our personalised pages are dynamic and uncached.
- 16.4: React 19.3, Cache Components recommended, Turbopack default [V, high].
- `middleware.ts` renamed `proxy.ts` in 16.0 (Node runtime); official auth guide (2026-09-16): optimistic cookie checks in proxy, real checks in a Data Access Layer, HttpOnly Secure SameSite=lax cookies, Server Actions and Route Handlers re-check auth [V, high].
- PWA guide (2026-07-30): `app/manifest.ts`, hand-written service worker for push, Serwist (MIT) for offline caching; `next-pwa` unmaintained [V, high].

## HLS

- hls.js 1.7.4 (2026-10-28), Apache-2.0; iOS Safari 17.1+ via ManagedMediaSource; use native `<video>` when `canPlayType('application/vnd.apple.mpegurl')` and no MMS; fMP4/CMAF pass-through; WebVTT, IMSC1, CEA-608/708 [V, high].
- Apple HLS authoring spec [V, high]: target duration 6 s, IDR every 2 s, fMP4 with `EXT-X-MAP` for HEVC/AV1, `avc1`, AAC-LC, WebVTT with `X-TIMESTAMP-MAP`, variants share aspect ratio. Apple's ladder is 16:9 only.
- Proposed 9:16 ladder [I, medium]: 1080x1920 ~5000-6000 kbit/s, 720x1280 ~2500-3200, 540x960 ~1400, 360x640 ~600; <= 30 fps; `-g 60 -keyint_min 60 -sc_threshold 0` at 30 fps; `-hls_time 4`; `-hls_segment_type fmp4 -hls_flags independent_segments`; High profile <= 4.1; AAC-LC 96-128 kbit/s. Validate with `mediastreamvalidator`.
- Sprites: `fps=1/2,scale=108:-1,tile=10x10` plus a WebVTT sidecar with `#xywh=` cues [secondary, medium].
- Segment protection [V/I]: CloudFront signed cookies cover playlist + segments in one grant; S3/MinIO presigned URLs are per object, so for self-hosted storage either rewrite playlists with presigned segment URLs or use a token-in-path proxy that checks the session and streams with range support. Recommendation: proxy with short-lived HMAC tokens for self-host; signed cookies behind CloudFront. Prefer cookies or `Authorization` via hls.js `xhrSetup` over query tokens.
- Hosted alternatives [V, medium]: Mux pay-as-you-go (1080p basic encoding free, storage $0.003/min/month, delivery $0.001/min after 100k free minutes); Cloudflare Stream ($5 per 1,000 minutes stored, $1 per 1,000 minutes delivered).

## Playwright

- 1.64.1 (2026-10-14); default browser Chrome for Testing since 1.57 (H.264/AAC expected; verify `canPlayType` in CI and keep a WebM fallback fixture) [V/I, medium-high].
- Uploads: `locator.setInputFiles(...)` or `filechooser` event [V, high]. Fake media flags for camera tests [secondary, medium]. Playback assertions: poll `readyState >= 3`, `currentTime` advancing; autoplay needs `muted` or `--autoplay-policy=no-user-gesture-required` [I].

## Accessibility (WCAG 2.2, REC 2024-12-12) [V, high]

- 1.2.2 Captions (A): captions for every clip; uploader flow generates or requires them.
- 1.4.2 Audio Control (A): autoplay muted by default; persistent mute/pause.
- 2.2.2 Pause, Stop, Hide (A): global "pause feed / auto-advance" toggle.
- 2.1.1 Keyboard (A) and 2.1.4: arrow keys and J/K; single-key shortcuts must be remappable or disableable.
- 2.3.3 Animation from Interactions (AAA): honor `prefers-reduced-motion` (web) and `AccessibilityInfo.isReduceMotionEnabled` (RN); disable snap animations and autoplay under reduced motion.
- 1.4.3 contrast with scrims over video; 2.4.7 focus visible; 2.5.8 target size 24x24.

## Deprecations

expo-av (removed SDK 55); legacy architecture (removed SDK 55); `expo-video-thumbnails`; expo-file-system legacy functions; `getDefaultReturnUrl`; Expo webpack and `@expo/next-adapter`; Next.js `middleware.ts` → `proxy.ts`; `next-pwa` → Serwist; expo-router `withLayoutContext`.

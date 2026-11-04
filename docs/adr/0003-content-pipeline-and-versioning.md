# ADR-0003: Content pipeline, media delivery and versioning

Status: proposed, 2026-11-03. Confidence: high on structure, medium on ladder numbers (validate with real clips).

## Context

Uploads are video, audio, PDF, DOCX, PPTX, XLSX, Markdown/HTML pages and links. Each must become feed-ready (HLS, poster, captions, chapters) or knowledge-ready (text with locators, chunks, embeddings). Content changes over time; everything derived must be tied to a version so retraction and replacement are exact. Media must be protected by the same permissions as everything else.

## Decision

### Upload

- Browser and mobile upload directly to object storage with server-signed multipart URLs (Uppy `@uppy/aws-s3` on web; `expo-file-system` upload tasks on mobile). The API validates type, size (org limits), and creates `content_version` with `status = 'uploaded'` on `complete`. Checksums (SHA-256) are recorded; duplicate detection is scoped to the uploader's own content so it cannot act as an existence oracle for content they cannot see.
- Storage layout: `orgs/{org}/content/{content}/versions/{version}/original/{uuid}` and `.../derived/{kind}/...`. Keys never contain user-provided names.

### Processing jobs (pg-boss, idempotent, per version)

| job        | video/audio                                                                                                                                                                                                                                                              | document                                                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| probe      | ffprobe metadata, duration, orientation, codec checks, reject > org max                                                                                                                                                                                                  | file-type sniffing, page count, zip-bomb guard                                                                                                                                                                      |
| transcode  | ffmpeg → HLS fMP4/CMAF ladder; vertical-aware (9:16: 1080x1920 ~5.5 Mbit/s, 720x1280 ~2.8, 540x960 ~1.4, 360x640 ~0.6; 16:9 ladder derived from Apple spec); 2 s GOP, 4 s segments, `independent_segments`; AAC-LC 96-128 kbit/s; audio-only rendition for audio uploads | normalise legacy formats via LibreOffice headless (optional sidecar)                                                                                                                                                |
| thumbnails | poster at a stable timestamp, sprite sheet + WebVTT thumbnails track                                                                                                                                                                                                     | page/slide renders (optional)                                                                                                                                                                                       |
| asr        | provider adapter (ADR-0008) returns segments with timestamps and detected language; stored as `transcript` JSON                                                                                                                                                          | –                                                                                                                                                                                                                   |
| captions   | WebVTT generated from transcript; editable in UI; edits create a new caption revision, not a new content version                                                                                                                                                         | –                                                                                                                                                                                                                   |
| parse      | –                                                                                                                                                                                                                                                                        | Tier 1 in-process parsers (pdfjs-dist, mammoth, officeparser, exceljs); Tier 2 optional Docling sidecar for layout-heavy and scanned files; text blocks keep locators (page, slide, sheet/cell range, heading path) |
| chapters   | manual in M1; M2 suggests chapters from transcript + headings (labelled AI-generated until accepted)                                                                                                                                                                     | headings become chapters                                                                                                                                                                                            |
| chunk      | transcript windows of ~45-90 s with overlap, aligned to sentence boundaries                                                                                                                                                                                              | heading-aware chunks of ~400-800 tokens with overlap; tables kept whole when small                                                                                                                                  |
| embed      | provider adapter; `embedding_model` and `dims` stored per index; re-embed job on model change                                                                                                                                                                            | same                                                                                                                                                                                                                |
| index      | tsvector over title, description, captions, chunks (M1); vectors (M2)                                                                                                                                                                                                    | same                                                                                                                                                                                                                |
| scan       | optional PII/secret scan (ADR-0009) before publish                                                                                                                                                                                                                       | same                                                                                                                                                                                                                |

Jobs are chained through pg-boss with `singletonKey = version_id:job` and retried with backoff; failures surface in the UI with a retry button; a stuck version never blocks other content.

### Versioning

- `content` holds metadata and `current_version_id`. `content_version` is immutable once processed. Publishing a replacement upload creates a new version; the switch is atomic (`UPDATE content SET current_version_id = ..., content_epoch = content_epoch + 1`).
- Metadata edits (title, links, audience) do not create a version but bump `content_epoch`; caption edits are revisions on the version.
- Retraction sets `retracted_at`, marks all versions `status = 'retracted'`, removes chunks from the active index (soft flag checked in SQL), bumps the epoch, rotates the content's proxy-mode `media_key_id` (a per-content revocation handle checked by the media route; it does not exist in CDN mode), schedules CDN purge where a CDN is configured, and emits `content.retracted` for notifications (ADR-0005).
- Old versions remain readable only through the audited `auditorAccessible` path (ADR-0002) until retention deletes them (M8).
- Time-driven transitions (`publish_at` arriving, `expires_at` passing) do not change `content.state`: an item is `published` from the moment the author publishes or schedules it, and `publish_at`/`expires_at` gate visibility inside `readerVisible`. A scheduled job per content item (pg-boss `startAfter`) runs at the transition instant and, in one transaction, bumps `content_epoch` and the org sequence so epoch-keyed caches refresh (ADR-0004) and, for `publish_at`, writes the `content.published` outbox row that drives audience notifications (ADR-0005); scheduling itself emits no audience event. A late job delays cache refresh and notifications by its lateness but never delays or extends visibility in SQL.

### Media delivery

- Self-host default: an authenticated media route in the API, `/media/{content}/{version}/{asset}`, authorised on **every request** (playlist, caption and each segment) by the session cookie or bearer token: the server checks that the user is active, that the version is current, that the request's `media_key_id` equals the content's current one (rotated on retraction, proxy mode only), and `readerVisible` through the epoch-keyed per-user cache (ADR-0004). Playlists are rewritten so segment URLs point at the same route; no separate media token is needed on web. For native players that cannot send cookies or headers on segment requests, a short-lived HMAC token (TTL sized to the session, ≤ 15 min, bound to user, version and key id) is appended to segment URLs, and the server still performs the same checks on each request; the token is only a transport for identity, never the sole authorization. Playlists and captions are served `Cache-Control: no-store`; segments `private, max-age=60` (immutable per version; retraction makes new playback impossible immediately, and the small segment cache window is accepted and documented). The Serwist service worker never caches `/api` or `/media`, and clears all caches on logout and on an epoch change.
- CDN mode: CloudFront or Cloudflare in front of storage with signed cookies scoped to the version prefix and a TTL ≤ 10 min; retraction purges by prefix/tag. Per-content key rotation is not available with CloudFront key groups, so the documented exposure window in CDN mode is cookie TTL plus purge lag; orgs that need immediate revocation use proxy mode.
- Revocation targets: proxy mode, next request; open players, within 5 s via SSE/push `content.retracted`; CDN mode, cookie TTL plus purge lag (≤ 10 min); notifications, under 60 s.
- Never: public buckets, long-lived presigned URLs, tokens in referable query strings on non-media routes.

### Playback

- Web: hls.js (Apache-2.0) with native HLS fallback on Safari; captions via WebVTT tracks; thumbnails track for scrubbing.
- Mobile: expo-video with `contentType: 'hls'`; development build required for PiP/background plugin options.

## Consequences

- One pipeline, two content families; adapters isolate ffmpeg, parsers and model providers for testing.
- ffmpeg is a hard runtime dependency of the worker image; the Docling and LibreOffice sidecars are optional.
- The proxy route adds CPU for self-host at scale; the CDN mode is documented for large installs.

## Tests

- Golden fixtures: a 9:16 clip, a 16:9 clip, audio-only, a PDF with headings and tables, a DOCX, a PPTX, an XLSX with multiple sheets, a scanned PDF (OCR tier). Assertions on ladder output (ffprobe), VTT validity, locator coverage, chunk size bounds, idempotent re-run.
- Media security: no session, deactivated user with a valid session or token, access revoked after playback started, token for another version, token minted for another user, retracted version, range request abuse; all must fail closed on the next segment request. Playlist and caption responses carry `no-store`.
- S3 conformance: multipart, presigned URLs, CORS `ETag` exposure and checksums against SeaweedFS, Garage and AWS S3 (the last in a budgeted nightly job).
- Retraction end-to-end: publish → view → retract → feed, search, retrieval and media all deny within one request; notification emitted.

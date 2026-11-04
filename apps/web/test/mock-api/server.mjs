// SPDX-License-Identifier: AGPL-3.0-only
// In-memory mock of the M1a API contract (packages/contracts/src/m1a.ts) for web development and
// Playwright. It is a test double, not a reference implementation: single process, no persistence,
// simplified visibility rules (owner, everyone, direct user, stream grants), simulated processing.
// Run: node test/mock-api/server.mjs   (PORT, MOCK_MEDIA, MOCK_PROCESSING_MS)
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { prepareFixtures } from './fixtures.mjs';

const PORT = Number(process.env['PORT'] ?? 4100);
const HOST = process.env['HOST'] ?? '127.0.0.1';
const PROCESSING_STEP_MS = Number(process.env['MOCK_PROCESSING_MS'] ?? 300);
const SESSION_COOKIE = 'os_session';
const media = prepareFixtures();
const publicBase = process.env['MOCK_PUBLIC_URL'] ?? `http://${HOST}:${PORT}`;

// ---- state ----
const db = {
  users: new Map(), // id -> { id, email, displayName, password, orgId, role, status, authzEpoch }
  orgs: new Map(), // id -> { id, slug, name, contentEpoch }
  sessions: new Map(), // token -> { userId, csrf }
  magic: new Map(), // token -> email
  streams: new Map(), // id -> { id, orgId, kind, slug, name, grants: Map(subjectKey -> role) }
  content: new Map(), // id -> content
  versions: new Map(), // id -> version
  uploads: new Map(), // uploadId -> { versionId, contentId, parts: Map }
  views: new Map(), // `${userId}:${contentId}` -> { versionId, completed }
  notifications: new Map(), // userId -> Notification[]
  // ---- M1b ----
  likes: new Map(), // `${userId}:${contentId}` -> true
  comments: new Map(), // id -> comment (contract shape without replies)
  commentKeys: new Map(), // `${userId}:${contentId}:${clientKey}` -> commentId
  reports: new Map(), // commentId -> count
  engagement: new Map(), // `${userId}:${contentId}:${versionId}:${sessionKey}:${type}` -> event
  engagementSessions: new Map(), // `${userId}:${contentId}` -> Set(sessionKey)
  pins: new Map(), // `${contentId}:${streamId|'org'}` -> true
  tags: new Map(), // contentId -> EventTag[]
  orgSettings: new Map(), // orgId -> OrgSettings
  streamSettings: new Map(), // streamId -> { commentsEnabled }
  preferences: new Map(), // userId -> { emailDigest }
};

const now = () => new Date().toISOString();
const log = (...a) => console.error('[mock-api]', ...a);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

// ---- helpers ----
function parseCookies(header) {
  const out = {};
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, body, extraHeaders = {}) {
  // A handler may have deliberately dropped the connection (see /__mock/drop-next-response).
  if (res.destroyed || res.socket?.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, no-store',
    vary: 'Cookie, Authorization',
    ...extraHeaders,
  });
  res.end(payload);
}

function sendError(res, err) {
  const status = err instanceof HttpError ? err.status : 500;
  const code = err instanceof HttpError ? err.code : 'internal';
  if (status >= 500) log('error', err);
  sendJson(res, status, { error: { code, message: err.message ?? code } });
}

function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`;
}

function me(user, currentSession) {
  const org = db.orgs.get(user.orgId);
  // The CSRF token belongs to the calling session; a person may hold several (another tab, an
  // earlier link). Without one, fall back to the newest (Map keeps insertion order).
  const session =
    currentSession ?? [...db.sessions.values()].filter((s) => s.userId === user.id).pop();
  return {
    user: { id: user.id, email: user.email, displayName: user.displayName },
    org: org ? { id: org.id, slug: org.slug, name: org.name, role: user.role } : null,
    memberships: org
      ? [{ orgId: org.id, slug: org.slug, name: org.name, role: user.role, status: user.status }]
      : [],
    csrfToken: session?.csrf ?? '',
    // M1b (MeM1b): lets /account hide the set-password form for password accounts.
    hasPassword: user.password !== null,
  };
}

function startSession(res, user) {
  const token = randomBytes(24).toString('hex');
  db.sessions.set(token, { userId: user.id, csrf: randomBytes(16).toString('hex') });
  res.setHeader('set-cookie', sessionCookie(token));
  return token;
}

function authenticate(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  const session = token ? db.sessions.get(token) : undefined;
  if (!session) throw new HttpError(401, 'unauthorized', 'sign in required');
  const user = db.users.get(session.userId);
  if (!user || user.status !== 'active')
    throw new HttpError(401, 'unauthorized', 'sign in required');
  return { user, session, token };
}

function requireCsrf(req, session) {
  if (req.headers['x-csrf-token'] !== session.csrf) {
    throw new HttpError(403, 'csrf', 'missing or invalid CSRF token');
  }
}

function orgOf(user) {
  const org = db.orgs.get(user.orgId);
  if (!org) throw new HttpError(403, 'forbidden', 'no organisation');
  return org;
}

function bumpContentEpoch(content) {
  content.contentEpoch += 1;
  const org = db.orgs.get(content.orgId);
  if (org) org.contentEpoch += 1;
}

function bumpAuthz(user) {
  user.authzEpoch += 1;
}

function streamRoleFor(stream, user) {
  return stream.grants.get(`user:${user.id}`) ?? stream.grants.get('everyone') ?? null;
}

function streamView(stream, user) {
  return {
    id: stream.id,
    kind: stream.kind,
    slug: stream.slug,
    name: stream.name,
    myRole: streamRoleFor(stream, user),
  };
}

function versionSummary(v) {
  if (!v) return null;
  return {
    id: v.id,
    status: v.status,
    processingStep: v.processingStep,
    processingError: v.processingError,
    durationMs: v.durationMs,
    width: v.width,
    height: v.height,
    hasCaptions: v.hasCaptions,
  };
}

function contentDetail(c, user) {
  return {
    id: c.id,
    kind: c.kind,
    title: c.title,
    description: c.description,
    language: c.language,
    links: c.links,
    chapters: c.chapters,
    state: c.state,
    publishAt: c.publishAt,
    expiresAt: c.expiresAt,
    retractedAt: c.retractedAt,
    owner: { id: c.ownerId, displayName: db.users.get(c.ownerId)?.displayName ?? '' },
    currentVersion: versionSummary(db.versions.get(c.currentVersionId)),
    audience: c.audience,
    canEdit: c.ownerId === user.id || user.role === 'owner' || user.role === 'admin',
    contentEpoch: c.contentEpoch,
    // M1b (ContentDetailM1b): additive fields and media for /content/{id}?t=.
    ...m1bFields(c, user),
    commentsEnabled: commentsEnabledFor(c),
    media: (() => {
      const v = db.versions.get(c.currentVersionId);
      return v && v.status === 'current' ? mediaUrls(c, v) : null;
    })(),
  };
}

function isVisible(c, user) {
  if (c.orgId !== user.orgId) return false;
  if (c.state !== 'published' || c.retractedAt) return false;
  const t = Date.now();
  if (c.publishAt && new Date(c.publishAt).getTime() > t) return false;
  if (c.expiresAt && new Date(c.expiresAt).getTime() <= t) return false;
  const v = db.versions.get(c.currentVersionId);
  if (!v || v.status !== 'current') return false;
  if (c.ownerId === user.id) return true;
  for (const a of c.audience) {
    if (a.type === 'everyone') return true;
    if (a.type === 'user' && a.userId === user.id) return true;
    if (a.type === 'stream') {
      const s = db.streams.get(a.streamId);
      if (s && streamRoleFor(s, user)) return true;
    }
  }
  return false;
}

function mediaUrls(c, v) {
  const base = `/media/${c.id}/${v.id}`;
  return {
    hls: media.mode === 'hls' ? `${base}/hls/master.m3u8` : `${base}/${media.file}`,
    poster: null,
    sprite: null,
    spriteVtt: null,
    captions: [{ lang: c.language || 'en', url: `${base}/captions/en.vtt` }],
  };
}

function feedItem(c, user) {
  const v = db.versions.get(c.currentVersionId);
  const view = db.views.get(`${user.id}:${c.id}`);
  return {
    id: c.id,
    kind: c.kind,
    title: c.title,
    description: c.description,
    language: c.language,
    links: c.links,
    chapters: c.chapters,
    publishAt: c.publishAt,
    owner: { id: c.ownerId, displayName: db.users.get(c.ownerId)?.displayName ?? '' },
    versionId: v.id,
    durationMs: v.durationMs,
    width: v.width,
    height: v.height,
    media: mediaUrls(c, v),
    streams: c.audience
      .filter((a) => a.type === 'stream' && db.streams.has(a.streamId))
      .map((a) => {
        const s = db.streams.get(a.streamId);
        return { id: s.id, name: s.name, kind: s.kind };
      }),
    viewed: Boolean(view),
    contentEpoch: c.contentEpoch,
    // M1b (FeedItemM1b).
    ...m1bFields(c, user),
  };
}

function notify(userId, n) {
  const list = db.notifications.get(userId) ?? [];
  list.unshift({ id: randomUUID(), readAt: null, createdAt: now(), ...n });
  db.notifications.set(userId, list);
}

function startProcessing(version) {
  const steps = ['probe', 'transcode', 'thumbnails', 'captions'];
  version.status = 'processing';
  let i = 0;
  const tick = () => {
    if (version.status !== 'processing') return;
    if (i < steps.length) {
      version.processingStep = steps[i];
      i += 1;
      setTimeout(tick, PROCESSING_STEP_MS);
      return;
    }
    version.status = 'current';
    version.processingStep = null;
    version.durationMs = media.durationMs;
    version.width = 360;
    version.height = 640;
    version.hasCaptions = true;
    const content = db.content.get(version.contentId);
    if (content) {
      const previous = db.versions.get(content.currentVersionId);
      if (previous && previous.id !== version.id) previous.status = 'superseded';
      content.currentVersionId = version.id;
      bumpContentEpoch(content);
    }
  };
  setTimeout(tick, PROCESSING_STEP_MS);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const str = (v, min = 0, max = Infinity) =>
  typeof v === 'string' && v.length >= min && v.length <= max;

function validate(cond, message) {
  if (!cond) throw new HttpError(400, 'validation', message);
}

// ---- routes ----
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp(
    '^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$',
  );
  routes.push({ method, re, keys, handler });
}

// auth
route('POST', '/v1/auth/signup', async ({ body, res }) => {
  validate(str(body.email, 3, 254) && body.email.includes('@'), 'email');
  validate(str(body.password, 12, 256), 'password');
  validate(str(body.displayName, 1, 120), 'displayName');
  validate(str(body.orgName, 2, 120), 'orgName');
  validate(str(body.orgSlug, 2, 48) && SLUG_RE.test(body.orgSlug), 'orgSlug');
  const email = body.email.toLowerCase();
  if ([...db.users.values()].some((u) => u.email === email))
    throw new HttpError(409, 'email_taken');
  if ([...db.orgs.values()].some((o) => o.slug === body.orgSlug))
    throw new HttpError(409, 'slug_taken');
  const org = { id: randomUUID(), slug: body.orgSlug, name: body.orgName, contentEpoch: 1 };
  db.orgs.set(org.id, org);
  const user = {
    id: randomUUID(),
    email,
    displayName: body.displayName,
    password: body.password,
    orgId: org.id,
    role: 'owner',
    status: 'active',
    authzEpoch: 1,
  };
  db.users.set(user.id, user);
  const company = {
    id: randomUUID(),
    orgId: org.id,
    kind: 'company',
    slug: 'company',
    name: `${org.name} (all)`,
    grants: new Map([
      ['everyone', 'viewer'],
      [`user:${user.id}`, 'owner'],
    ]),
  };
  db.streams.set(company.id, company);
  startSession(res, user);
  return me(user);
});
route('POST', '/v1/auth/login', async ({ body, res }) => {
  validate(str(body.email, 3) && str(body.password, 1), 'credentials');
  const user = [...db.users.values()].find((u) => u.email === body.email.toLowerCase());
  // A password-less account (created by an invite) can only sign in through its link.
  if (!user || user.password === null || user.password !== body.password)
    throw new HttpError(401, 'invalid_credentials', 'invalid credentials');
  startSession(res, user);
  return me(user);
});
route('POST', '/v1/auth/magic-link', async ({ body }) => {
  validate(str(body.email, 3), 'email');
  const user = [...db.users.values()].find((u) => u.email === body.email.toLowerCase());
  if (user) {
    const token = randomBytes(24).toString('hex');
    db.magic.set(token, user.email);
    log(`magic link for ${user.email}: /magic?token=${token}`);
  }
  return { ok: true };
});
route('POST', '/v1/auth/magic-link/consume', async ({ body, res }) => {
  validate(str(body.token, 20, 200), 'token');
  const email = db.magic.get(body.token);
  if (!email) throw new HttpError(400, 'token_invalid');
  db.magic.delete(body.token);
  const user = [...db.users.values()].find((u) => u.email === email);
  startSession(res, user);
  return me(user);
});
route('POST', '/v1/auth/logout', async ({ req, res }) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (token) db.sessions.delete(token);
  res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return { ok: true };
});
// Set by POST /__mock/drop-next-response: the next password set commits, then the socket is
// destroyed without an answer, which is how a proxy or network failure after the API has already
// stored the hash looks to the browser.
let dropNextPasswordResponse = false;
route('POST', '/v1/auth/password', async ({ auth, body, res }) => {
  validate(str(body.password, 12, 256), 'password');
  if (auth.user.password !== null)
    throw new HttpError(409, 'password_set', 'this account already has a password');
  auth.user.password = body.password;
  if (dropNextPasswordResponse) {
    dropNextPasswordResponse = false;
    res.socket?.destroy();
    return undefined;
  }
  return { ok: true };
});
route('GET', '/v1/me', async ({ auth }) => me(auth.user, auth.session));
route('GET', '/v1/sync', async ({ auth }) => ({
  authzEpoch: auth.user.authzEpoch,
  orgContentEpoch: orgOf(auth.user).contentEpoch,
  serverTime: now(),
}));

// members / streams
route('GET', '/v1/members', async ({ auth }) => ({
  items: [...db.users.values()]
    .filter((u) => u.orgId === auth.user.orgId)
    .map((u) => ({
      userId: u.id,
      displayName: u.displayName,
      email: u.email,
      role: u.role,
      status: u.status,
    })),
}));
route('GET', '/v1/streams', async ({ auth }) => ({
  items: [...db.streams.values()]
    .filter((s) => s.orgId === auth.user.orgId)
    .map((s) => streamView(s, auth.user)),
}));
route('POST', '/v1/streams', async ({ auth, body }) => {
  validate(['company', 'department', 'team', 'project', 'private'].includes(body.kind), 'kind');
  validate(str(body.slug, 2, 48) && SLUG_RE.test(body.slug), 'slug');
  validate(str(body.name, 1, 120), 'name');
  if ([...db.streams.values()].some((s) => s.orgId === auth.user.orgId && s.slug === body.slug))
    throw new HttpError(409, 'slug_taken');
  const s = {
    id: randomUUID(),
    orgId: auth.user.orgId,
    kind: body.kind,
    slug: body.slug,
    name: body.name,
    grants: new Map([[`user:${auth.user.id}`, 'owner']]),
  };
  db.streams.set(s.id, s);
  return streamView(s, auth.user);
});
function streamOrThrow(id, user) {
  const s = db.streams.get(id);
  if (!s || s.orgId !== user.orgId) throw new HttpError(404, 'not_found');
  return s;
}
route('GET', '/v1/streams/:id', async ({ auth, params }) =>
  streamView(streamOrThrow(params.id, auth.user), auth.user),
);
route('GET', '/v1/streams/:id/members', async ({ auth, params }) => {
  const s = streamOrThrow(params.id, auth.user);
  const items = [];
  for (const [key, role] of s.grants) {
    if (key === 'everyone')
      items.push({ userId: '00000000-0000-0000-0000-000000000000', displayName: 'Everyone', role });
    else {
      const u = db.users.get(key.slice('user:'.length));
      if (u) items.push({ userId: u.id, displayName: u.displayName, role });
    }
  }
  return { items };
});
route('POST', '/v1/streams/:id/grants', async ({ auth, params, body }) => {
  const s = streamOrThrow(params.id, auth.user);
  const mine = streamRoleFor(s, auth.user);
  if (mine !== 'owner' && mine !== 'moderator' && auth.user.role !== 'owner')
    throw new HttpError(403, 'forbidden');
  validate(['viewer', 'contributor', 'moderator', 'owner'].includes(body.role), 'role');
  validate(body.subject && typeof body.subject === 'object', 'subject');
  if (body.subject.type === 'everyone') s.grants.set('everyone', body.role);
  else if (body.subject.type === 'user') {
    validate(UUID_RE.test(body.subject.userId ?? ''), 'userId');
    const u = db.users.get(body.subject.userId);
    if (!u || u.orgId !== auth.user.orgId) throw new HttpError(404, 'not_found');
    s.grants.set(`user:${u.id}`, body.role);
    bumpAuthz(u);
  } else if (body.subject.type === 'group') {
    validate(UUID_RE.test(body.subject.groupId ?? ''), 'groupId');
    s.grants.set(`group:${body.subject.groupId}`, body.role);
  } else throw new HttpError(400, 'validation', 'subject.type');
  for (const u of db.users.values()) if (u.orgId === auth.user.orgId) bumpAuthz(u);
  return { ok: true };
});

// content
function contentOrThrow(id, user, { edit = false } = {}) {
  const c = db.content.get(id);
  if (!c || c.orgId !== user.orgId) throw new HttpError(404, 'not_found');
  const canEdit = c.ownerId === user.id || user.role === 'owner' || user.role === 'admin';
  if (edit && !canEdit) throw new HttpError(403, 'forbidden');
  if (!edit && !canEdit && !isVisible(c, user)) throw new HttpError(404, 'not_found');
  return c;
}
function parseLinks(links) {
  validate(Array.isArray(links) && links.length <= 20, 'links');
  return links.map((l) => {
    validate(
      ['intranet', 'internet', 'attachment'].includes(l.kind) &&
        str(l.url, 1, 2048) &&
        str(l.label, 0, 200),
      'link',
    );
    return { kind: l.kind, url: l.url, label: l.label };
  });
}
function parseChapters(chapters) {
  validate(Array.isArray(chapters) && chapters.length <= 100, 'chapters');
  return chapters.map((c) => {
    validate(Number.isInteger(c.atMs) && c.atMs >= 0 && str(c.title, 1, 200), 'chapter');
    return { atMs: c.atMs, title: c.title };
  });
}
route('POST', '/v1/content', async ({ auth, body }) => {
  validate(['clip', 'audio'].includes(body.kind), 'kind');
  validate(str(body.title, 1, 200), 'title');
  const c = {
    id: randomUUID(),
    orgId: auth.user.orgId,
    ownerId: auth.user.id,
    kind: body.kind,
    title: body.title,
    description: str(body.description) ? body.description.slice(0, 4000) : '',
    language: str(body.language, 2, 16) ? body.language : 'en',
    links: parseLinks(body.links ?? []),
    chapters: parseChapters(body.chapters ?? []),
    state: 'draft',
    publishAt: null,
    expiresAt: null,
    retractedAt: null,
    audience: [],
    currentVersionId: null,
    contentEpoch: 1,
  };
  db.content.set(c.id, c);
  return contentDetail(c, auth.user);
});
route('GET', '/v1/content/:id', async ({ auth, params }) =>
  contentDetail(contentOrThrow(params.id, auth.user), auth.user),
);
route('PATCH', '/v1/content/:id', async ({ auth, params, body }) => {
  const c = contentOrThrow(params.id, auth.user, { edit: true });
  if (body.title !== undefined) {
    validate(str(body.title, 1, 200), 'title');
    c.title = body.title;
  }
  if (body.description !== undefined) {
    validate(str(body.description, 0, 4000), 'description');
    c.description = body.description;
  }
  if (body.language !== undefined) {
    validate(str(body.language, 2, 16), 'language');
    c.language = body.language;
  }
  if (body.links !== undefined) c.links = parseLinks(body.links);
  if (body.chapters !== undefined) c.chapters = parseChapters(body.chapters);
  bumpContentEpoch(c);
  return contentDetail(c, auth.user);
});
route('POST', '/v1/content/:id/upload/init', async ({ auth, params, body }) => {
  const c = contentOrThrow(params.id, auth.user, { edit: true });
  if (c.retractedAt) throw new HttpError(409, 'conflict', 'retracted');
  validate(str(body.fileName, 1, 255), 'fileName');
  validate(
    typeof body.mimeType === 'string' && /^(video|audio)\/[a-z0-9.+-]+$/i.test(body.mimeType),
    'mimeType',
  );
  validate(Number.isInteger(body.size) && body.size > 0 && body.size <= 4 * 1024 ** 3, 'size');
  validate(Number.isInteger(body.parts) && body.parts >= 1 && body.parts <= 10000, 'parts');
  const v = {
    id: randomUUID(),
    contentId: c.id,
    status: 'uploaded',
    processingStep: null,
    processingError: null,
    durationMs: null,
    width: null,
    height: null,
    hasCaptions: false,
    size: body.size,
    parts: body.parts,
  };
  db.versions.set(v.id, v);
  // A draft's first upload is its current version from the start, so clients can poll its
  // processing state through ContentDetail.currentVersion; a replacement stays pending until it
  // is processed and then switches atomically (ADR-0003).
  if (!c.currentVersionId) c.currentVersionId = v.id;
  const uploadId = randomBytes(12).toString('hex');
  db.uploads.set(uploadId, {
    versionId: v.id,
    contentId: c.id,
    parts: new Map(),
    expected: body.parts,
  });
  const key = `orgs/${c.orgId}/content/${c.id}/versions/${v.id}/original/${randomUUID()}`;
  return {
    versionId: v.id,
    uploadId,
    key,
    partUrls: Array.from({ length: body.parts }, (_, i) => ({
      partNumber: i + 1,
      url: `${publicBase}/__mock/upload/${uploadId}/${i + 1}`,
    })),
  };
});
route('POST', '/v1/content/:id/upload/complete', async ({ auth, params, body }) => {
  const c = contentOrThrow(params.id, auth.user, { edit: true });
  validate(UUID_RE.test(body.versionId ?? '') && str(body.uploadId, 1), 'ids');
  validate(Array.isArray(body.parts) && body.parts.length >= 1, 'parts');
  const upload = db.uploads.get(body.uploadId);
  const v = db.versions.get(body.versionId);
  if (!upload || !v || upload.versionId !== v.id || v.contentId !== c.id)
    throw new HttpError(404, 'not_found');
  for (const p of body.parts) {
    const stored = upload.parts.get(p.partNumber);
    validate(
      stored && stored.etag === String(p.etag).replace(/^"|"$/g, ''),
      `part ${p.partNumber} etag`,
    );
  }
  validate(body.parts.length === upload.expected, 'all parts required');
  db.uploads.delete(body.uploadId);
  startProcessing(v);
  return contentDetail(c, auth.user);
});
route('POST', '/v1/content/:id/publish', async ({ auth, params, body }) => {
  const c = contentOrThrow(params.id, auth.user, { edit: true });
  if (c.retractedAt) throw new HttpError(409, 'conflict', 'retracted');
  const v = db.versions.get(c.currentVersionId);
  if (!v || v.status !== 'current') throw new HttpError(409, 'conflict', 'no processed version');
  validate(
    Array.isArray(body.audience) && body.audience.length >= 1 && body.audience.length <= 50,
    'audience',
  );
  for (const a of body.audience) {
    validate(['everyone', 'stream', 'group', 'user'].includes(a.type), 'audience.type');
    if (a.type === 'stream') validate(db.streams.get(a.streamId)?.orgId === c.orgId, 'streamId');
    if (a.type === 'user') validate(db.users.get(a.userId)?.orgId === c.orgId, 'userId');
    if (a.type === 'group') validate(UUID_RE.test(a.groupId ?? ''), 'groupId');
  }
  const publishAt = body.publishAt ?? null;
  const expiresAt = body.expiresAt ?? null;
  validate(publishAt === null || !Number.isNaN(Date.parse(publishAt)), 'publishAt');
  validate(expiresAt === null || !Number.isNaN(Date.parse(expiresAt)), 'expiresAt');
  const wasPublished = c.state === 'published';
  c.audience = body.audience;
  c.publishAt = publishAt ?? (wasPublished ? c.publishAt : now());
  c.expiresAt = expiresAt;
  c.state = 'published';
  bumpContentEpoch(c);
  if (!wasPublished && new Date(c.publishAt).getTime() <= Date.now()) {
    for (const u of db.users.values()) {
      if (u.orgId === c.orgId && u.id !== auth.user.id && isVisible(c, u)) {
        notify(u.id, {
          kind: 'content.published',
          reason: 'audience',
          contentId: c.id,
          title: c.title,
        });
      }
    }
  }
  return contentDetail(c, auth.user);
});
route('POST', '/v1/content/:id/retract', async ({ auth, params }) => {
  const c = contentOrThrow(params.id, auth.user, { edit: true });
  if (!c.retractedAt) {
    c.retractedAt = now();
    c.state = 'retracted';
    for (const v of db.versions.values()) if (v.contentId === c.id) v.status = 'retracted';
    bumpContentEpoch(c);
    for (const [key, view] of db.views) {
      const [userId, contentId] = key.split(':');
      if (contentId === c.id && userId !== auth.user.id && view) {
        notify(userId, {
          kind: 'content.retracted',
          reason: 'viewed_retracted_version',
          contentId: c.id,
          title: null,
        });
      }
    }
  }
  return contentDetail(c, auth.user);
});
route('POST', '/v1/content/:id/view', async ({ auth, params, body }) => {
  const c = db.content.get(params.id);
  if (!c || !isVisible(c, auth.user)) throw new HttpError(404, 'not_found');
  validate(UUID_RE.test(body.versionId ?? ''), 'versionId');
  const key = `${auth.user.id}:${c.id}`;
  const prev = db.views.get(key);
  db.views.set(key, {
    versionId: body.versionId,
    completed: Boolean(body.completed) || Boolean(prev?.completed),
  });
  return { ok: true };
});

// feed
route('GET', '/v1/feed', async ({ auth, url }) => {
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 10) || 10));
  const streamId = url.searchParams.get('streamId');
  const cursor = url.searchParams.get('cursor');
  let offset = 0;
  if (cursor) {
    const parsed = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
    validate(Number.isInteger(parsed) && parsed >= 0, 'cursor');
    offset = parsed;
  }
  // M1b filters: a tag narrows to items carrying it; pinned=true narrows to items pinned org-wide
  // or in a stream the caller can access (the given stream only when streamId is set). Filters can
  // only narrow: every item still passes isVisible first.
  const tag = url.searchParams.get('tag');
  if (tag !== null) validate(EVENT_TAGS.includes(tag), 'tag');
  const pinnedOnly = url.searchParams.get('pinned') === 'true';
  const visible = [...db.content.values()]
    .filter((c) => isVisible(c, auth.user))
    .filter(
      (c) => !streamId || c.audience.some((a) => a.type === 'stream' && a.streamId === streamId),
    )
    .filter((c) => !tag || (db.tags.get(c.id) ?? []).includes(tag))
    .filter((c) => !pinnedOnly || isPinnedFor(c, auth.user, streamId))
    .sort((a, b) => Date.parse(b.publishAt) - Date.parse(a.publishAt));
  const page = visible.slice(offset, offset + limit);
  const nextOffset = offset + limit;
  return {
    items: page.map((c) => feedItem(c, auth.user)),
    nextCursor:
      nextOffset < visible.length ? Buffer.from(String(nextOffset)).toString('base64url') : null,
    authzEpoch: auth.user.authzEpoch,
    orgContentEpoch: orgOf(auth.user).contentEpoch,
  };
});

// notifications
route('GET', '/v1/notifications', async ({ auth }) => {
  const items = db.notifications.get(auth.user.id) ?? [];
  return { items, unread: items.filter((n) => !n.readAt).length };
});
route('POST', '/v1/notifications/:id/read', async ({ auth, params }) => {
  const items = db.notifications.get(auth.user.id) ?? [];
  const n = items.find((x) => x.id === params.id);
  if (!n) throw new HttpError(404, 'not_found');
  n.readAt = n.readAt ?? now();
  return { ok: true };
});

// ---- M1b: reactions, comments, share, search, engagement, stats, tags, pins, settings ----
// Emulates the contract rules the e2e relies on: readerVisible on every read (an invisible item is
// indistinguishable from a missing one: content_not_found), clientKey replay 200 vs 409, body
// normalisation, commentsEnabled = org AND every audience stream, canModerate/canRemove, reportCount
// for moderators only, tombstones, bad_parent, engagement dedupe per (session, content, version,
// type) with the 50-key cap, author-only stats with viewers only under `named`, pin_forbidden /
// not_in_audience, self_share and delivered:false. Not emulated: rate budgets (429).
const EVENT_TAGS = ['onboarding', 'announcement', 'current-events', 'training'];
const ENGAGEMENT_TYPES = ['view_start', 'progress_25', 'progress_50', 'progress_75', 'complete'];
const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'in', 'is', 'it', 'for', 'on']);

function orgSettingsFor(orgId) {
  let s = db.orgSettings.get(orgId);
  if (!s) {
    s = {
      privacyMode: 'identified_for_required_only',
      commentsEnabled: true,
      engagementRetentionDays: 395,
      commentScanPolicy: 'off',
    };
    db.orgSettings.set(orgId, s);
  }
  return s;
}

function commentsEnabledFor(c) {
  if (!orgSettingsFor(c.orgId).commentsEnabled) return false;
  return c.audience.every(
    (a) => a.type !== 'stream' || (db.streamSettings.get(a.streamId)?.commentsEnabled ?? true),
  );
}

function canModerate(c, user) {
  if (user.role === 'owner' || user.role === 'admin') return true;
  return c.audience.some((a) => {
    if (a.type !== 'stream') return false;
    const s = db.streams.get(a.streamId);
    const role = s ? streamRoleFor(s, user) : null;
    return role === 'moderator' || role === 'owner';
  });
}

function isPinnedFor(c, user, streamId = null) {
  if (streamId) return db.pins.has(`${c.id}:${streamId}`);
  if (db.pins.has(`${c.id}:org`)) return true;
  return c.audience.some((a) => {
    if (a.type !== 'stream' || !db.pins.has(`${c.id}:${a.streamId}`)) return false;
    const s = db.streams.get(a.streamId);
    return Boolean(s && streamRoleFor(s, user));
  });
}

function likeCountFor(contentId) {
  let n = 0;
  for (const key of db.likes.keys()) if (key.endsWith(`:${contentId}`)) n += 1;
  return n;
}

function visibleCommentCount(contentId) {
  let n = 0;
  for (const cm of db.comments.values())
    if (cm.contentId === contentId && cm.state === 'visible') n += 1;
  return n;
}

function m1bFields(c, user) {
  return {
    tags: db.tags.get(c.id) ?? [],
    pinned: isPinnedFor(c, user),
    likeCount: likeCountFor(c.id),
    liked: db.likes.has(`${user.id}:${c.id}`),
    commentCount: visibleCommentCount(c.id),
  };
}

/** The item for a reaction/comment/share/engagement call: invisible answers content_not_found. */
function visibleOrThrow(id, user) {
  const c = db.content.get(id);
  if (!c || !isVisible(c, user)) throw new HttpError(404, 'content_not_found', 'no such content');
  return c;
}

function offsetCursor(cursor) {
  if (!cursor) return 0;
  const parsed = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Number.isInteger(parsed) || parsed < 0) throw new HttpError(400, 'bad_cursor', 'bad cursor');
  return parsed;
}
const nextCursor = (offset, limit, total) =>
  offset + limit < total ? Buffer.from(String(offset + limit)).toString('base64url') : null;
const pageLimit = (url, fallback = 20) =>
  Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? fallback) || fallback));

// reactions
function reaction(c, user) {
  return { liked: db.likes.has(`${user.id}:${c.id}`), likeCount: likeCountFor(c.id) };
}
route('POST', '/v1/content/:id/like', async ({ auth, params }) => {
  const c = visibleOrThrow(params.id, auth.user);
  db.likes.set(`${auth.user.id}:${c.id}`, true);
  return reaction(c, auth.user);
});
route('DELETE', '/v1/content/:id/like', async ({ auth, params }) => {
  const c = visibleOrThrow(params.id, auth.user);
  db.likes.delete(`${auth.user.id}:${c.id}`);
  return reaction(c, auth.user);
});

// comments
function normaliseBody(raw) {
  if (typeof raw !== 'string') return '';
  // C0/C1 controls except newline and tab, then bidi controls and zero-width space/joiner/BOM.
  // Built from escapes so no literal control or bidi character sits in this source file.
  // eslint-disable-next-line no-control-regex -- the whole point is to strip these characters
  const controls = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]', 'g');
  const invisible = new RegExp('[\\u202a-\\u202e\\u2066-\\u2069\\u200b\\u2060\\ufeff]', 'g');
  return raw.normalize('NFC').replace(controls, '').replace(invisible, '').trim();
}
function commentView(cm, c, user) {
  const moderator = canModerate(c, user);
  const view = {
    id: cm.id,
    contentId: cm.contentId,
    parentId: cm.parentId,
    author:
      cm.state === 'removed'
        ? null
        : { id: cm.authorId, displayName: db.users.get(cm.authorId)?.displayName ?? '' },
    body: cm.state === 'removed' ? null : cm.body,
    state: cm.state,
    createdAt: cm.createdAt,
    removedAt: cm.removedAt,
    canRemove: cm.state === 'visible' && (cm.authorId === user.id || moderator),
  };
  if (moderator) view.reportCount = db.reports.get(cm.id) ?? 0;
  return view;
}
function threadView(root, c, user, limit) {
  const replies = [...db.comments.values()]
    .filter((x) => x.parentId === root.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    ...commentView(root, c, user),
    replies: replies.slice(0, limit).map((x) => commentView(x, c, user)),
    replyCount: replies.length,
  };
}
route('GET', '/v1/content/:id/comments', async ({ auth, params, url }) => {
  const c = visibleOrThrow(params.id, auth.user);
  const limit = pageLimit(url);
  const offset = offsetCursor(url.searchParams.get('cursor'));
  const roots = [...db.comments.values()]
    .filter((x) => x.contentId === c.id && x.parentId === null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    items: roots.slice(offset, offset + limit).map((r) => threadView(r, c, auth.user, limit)),
    nextCursor: nextCursor(offset, limit, roots.length),
    commentsEnabled: commentsEnabledFor(c),
    canModerate: canModerate(c, auth.user),
  };
});
route('POST', '/v1/content/:id/comments', async ({ auth, params, body }) => {
  const c = visibleOrThrow(params.id, auth.user);
  if (!commentsEnabledFor(c)) throw new HttpError(409, 'comments_disabled', 'comments disabled');
  const text = normaliseBody(body.body);
  validate(text.length >= 1 && text.length <= 2000, 'body');
  if (orgSettingsFor(c.orgId).commentScanPolicy === 'block' && /\b\d{3}-\d{2}-\d{4}\b/.test(text)) {
    throw new HttpError(400, 'comment_blocked', 'blocked by the comment scanner');
  }
  let parentId = body.parentId ?? null;
  if (parentId !== null) {
    validate(typeof parentId === 'string', 'parentId');
    const parent = db.comments.get(parentId);
    if (!parent || parent.contentId !== c.id || parent.state !== 'visible') {
      throw new HttpError(404, 'bad_parent', 'no such parent');
    }
    if (parent.parentId !== null) parentId = parent.parentId; // replies attach to the root
  }
  const clientKey = body.clientKey;
  if (clientKey !== undefined) validate(str(clientKey, 1, 64), 'clientKey');
  const replayKey = clientKey ? `${auth.user.id}:${c.id}:${clientKey}` : null;
  if (replayKey && db.commentKeys.has(replayKey)) {
    const existing = db.comments.get(db.commentKeys.get(replayKey));
    if (existing && existing.body === text && existing.parentId === parentId) {
      return threadView(existing, c, auth.user, 50);
    }
    throw new HttpError(409, 'idempotency_mismatch', 'same key, different comment');
  }
  const cm = {
    id: randomUUID(),
    contentId: c.id,
    parentId,
    authorId: auth.user.id,
    body: text,
    state: 'visible',
    createdAt: now(),
    removedAt: null,
  };
  db.comments.set(cm.id, cm);
  if (replayKey) db.commentKeys.set(replayKey, cm.id);
  if (c.ownerId !== auth.user.id) {
    notify(c.ownerId, {
      kind: 'comment.created',
      reason: 'author',
      contentId: c.id,
      title: c.title,
    });
  }
  return threadView(cm, c, auth.user, 50);
});
function commentOrThrow(id, user) {
  const cm = db.comments.get(id);
  const c = cm ? db.content.get(cm.contentId) : null;
  if (!cm || !c || !isVisible(c, user) || cm.state !== 'visible') {
    throw new HttpError(404, 'comment_not_found', 'no such comment');
  }
  return { cm, c };
}
route('POST', '/v1/comments/:id/report', async ({ auth, params, body }) => {
  const { cm } = commentOrThrow(params.id, auth.user);
  validate(body.reason === undefined || str(body.reason, 0, 500), 'reason');
  db.reports.set(cm.id, (db.reports.get(cm.id) ?? 0) + 1);
  return { ok: true };
});
route('POST', '/v1/comments/:id/remove', async ({ auth, params, body }) => {
  const { cm, c } = commentOrThrow(params.id, auth.user);
  validate(body.reason === undefined || str(body.reason, 0, 500), 'reason');
  if (cm.authorId !== auth.user.id && !canModerate(c, auth.user)) {
    throw new HttpError(403, 'moderation_forbidden', 'not a moderator');
  }
  cm.state = 'removed';
  cm.removedAt = now();
  return threadView(cm, c, auth.user, 50);
});

// share as link (never writes tuples)
route('POST', '/v1/content/:id/share', async ({ auth, params, body }) => {
  const c = visibleOrThrow(params.id, auth.user);
  validate(UUID_RE.test(body.userId ?? ''), 'userId');
  if (body.userId === auth.user.id)
    throw new HttpError(409, 'self_share', 'cannot share with self');
  const recipient = db.users.get(body.userId);
  const delivered = Boolean(
    recipient &&
    recipient.orgId === c.orgId &&
    recipient.status === 'active' &&
    isVisible(c, recipient),
  );
  if (delivered) {
    notify(recipient.id, {
      kind: 'content.shared',
      reason: 'share',
      contentId: c.id,
      title: c.title,
    });
  }
  return { delivered, linkPath: `/content/${c.id}` };
});

// search (ADR-0013 shape; word matching stands in for Postgres full-text)
function searchTerms(q) {
  const include = [];
  const exclude = [];
  const re = /-?"([^"]+)"|(-?\S+)/g;
  let m;
  while ((m = re.exec(q)) !== null) {
    const raw = (m[1] ?? m[2] ?? '').toLowerCase();
    const negative = (m[0] ?? '').startsWith('-');
    const term = raw.replace(/^-/, '');
    if (!term || term === 'or') continue;
    const words = term.split(/\s+/).filter((w) => !STOP_WORDS.has(w));
    if (words.length === 0) continue;
    (negative ? exclude : include).push(words.join(' '));
  }
  return { include, exclude };
}
function findRanges(text, term) {
  const ranges = [];
  const hay = text.toLowerCase();
  let from = 0;
  for (;;) {
    const at = hay.indexOf(term, from);
    if (at < 0) break;
    ranges.push([at, at + term.length]);
    from = at + term.length;
  }
  return ranges;
}
function transcriptWindows(c) {
  // Synthetic transcript: each sentence of the description is a 2 s window.
  return (c.description ?? '')
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim() !== '')
    .map((text, i) => ({ text: text.trim(), tMs: i * 2000 }));
}
function snippetFor(source, text, tMs, include) {
  const ranges = include
    .flatMap((term) => findRanges(text, term))
    .sort((a, b) => a[0] - b[0])
    .filter((r, i, all) => i === 0 || r[0] >= all[i - 1][1]);
  if (ranges.length === 0) return null;
  return { source, text, ranges, tMs };
}
route('GET', '/v1/search', async ({ auth, url }) => {
  const q = url.searchParams.get('q') ?? '';
  validate(str(q, 1, 200), 'q');
  const limit = pageLimit(url);
  const offset = offsetCursor(url.searchParams.get('cursor'));
  const streamId = url.searchParams.get('streamId');
  const tag = url.searchParams.get('tag');
  if (tag !== null) validate(EVENT_TAGS.includes(tag), 'tag');
  const { include, exclude } = searchTerms(q);
  const epochs = {
    authzEpoch: auth.user.authzEpoch,
    orgContentEpoch: orgOf(auth.user).contentEpoch,
  };
  if (include.length === 0) return { items: [], total: 0, nextCursor: null, ...epochs };
  const hits = [];
  for (const c of db.content.values()) {
    if (!isVisible(c, auth.user)) continue;
    if (streamId && !c.audience.some((a) => a.type === 'stream' && a.streamId === streamId))
      continue;
    if (tag && !(db.tags.get(c.id) ?? []).includes(tag)) continue;
    const haystack = `${c.title} ${c.description}`.toLowerCase();
    if (exclude.some((term) => haystack.includes(term))) continue;
    const snippets = [
      snippetFor('title', c.title, null, include),
      snippetFor('description', c.description, null, include),
      ...transcriptWindows(c).map((w) => snippetFor('transcript', w.text, w.tMs, include)),
    ].filter(Boolean);
    if (snippets.length === 0) continue;
    const matched = include.filter((term) => haystack.includes(term)).length;
    const item = feedItem(c, auth.user);
    hits.push({
      id: item.id,
      kind: item.kind,
      title: item.title,
      description: item.description,
      publishAt: item.publishAt,
      owner: item.owner,
      versionId: item.versionId,
      durationMs: item.durationMs,
      width: item.width,
      height: item.height,
      media: item.media,
      streams: item.streams,
      tags: item.tags,
      snippets,
      score: Math.min(1, matched / include.length),
    });
  }
  hits.sort((a, b) => b.score - a.score || Date.parse(b.publishAt) - Date.parse(a.publishAt));
  return {
    items: hits.slice(offset, offset + limit),
    total: Math.min(1000, hits.length),
    nextCursor: nextCursor(offset, limit, hits.length),
    ...epochs,
  };
});

// engagement and stats
route('POST', '/v1/content/:id/engagement', async ({ auth, params, body }) => {
  const c = visibleOrThrow(params.id, auth.user);
  validate(UUID_RE.test(body.versionId ?? ''), 'versionId');
  validate(str(body.sessionKey, 1, 64), 'sessionKey');
  validate(ENGAGEMENT_TYPES.includes(body.type), 'type');
  validate(
    body.positionMs === undefined || (Number.isInteger(body.positionMs) && body.positionMs >= 0),
    'positionMs',
  );
  if (body.versionId !== c.currentVersionId) throw new HttpError(409, 'stale_version', 'stale');
  const sessionsKey = `${auth.user.id}:${c.id}`;
  const sessions = db.engagementSessions.get(sessionsKey) ?? new Set();
  if (!sessions.has(body.sessionKey) && sessions.size >= 50) return { recorded: false };
  sessions.add(body.sessionKey);
  db.engagementSessions.set(sessionsKey, sessions);
  const key = `${auth.user.id}:${c.id}:${body.versionId}:${body.sessionKey}:${body.type}`;
  if (db.engagement.has(key)) return { recorded: false };
  const prior = [...db.engagement.values()].filter(
    (e) => e.userId === auth.user.id && e.contentId === c.id,
  );
  const rewatch =
    body.type === 'view_start' &&
    prior.some(
      (e) =>
        e.sessionKey !== body.sessionKey && (e.type === 'complete' || e.type === 'progress_75'),
    );
  db.engagement.set(key, {
    userId: auth.user.id,
    contentId: c.id,
    versionId: body.versionId,
    sessionKey: body.sessionKey,
    type: body.type,
    positionMs: body.positionMs ?? 0,
    at: now(),
    rewatch,
  });
  if (body.type === 'view_start' || body.type === 'complete') {
    const viewKey = `${auth.user.id}:${c.id}`;
    const prev = db.views.get(viewKey);
    db.views.set(viewKey, {
      versionId: body.versionId,
      completed: body.type === 'complete' || Boolean(prev?.completed),
    });
  }
  return { recorded: true };
});
route('GET', '/v1/content/:id/stats', async ({ auth, params }) => {
  const c = db.content.get(params.id);
  if (!c || c.orgId !== auth.user.orgId) throw new HttpError(404, 'content_not_found', 'no such');
  if (c.ownerId !== auth.user.id && auth.user.role !== 'owner' && auth.user.role !== 'admin') {
    throw new HttpError(403, 'forbidden', 'author only');
  }
  const events = [...db.engagement.values()].filter((e) => e.contentId === c.id);
  const byUser = new Map();
  for (const e of events) {
    const u = byUser.get(e.userId) ?? {
      userId: e.userId,
      first: e.at,
      last: e.at,
      max: 0,
      completed: false,
      watchCount: 0,
    };
    u.first = e.at < u.first ? e.at : u.first;
    u.last = e.at > u.last ? e.at : u.last;
    if (e.type === 'view_start') u.watchCount += 1;
    if (e.type === 'progress_25') u.max = Math.max(u.max, 25);
    if (e.type === 'progress_50') u.max = Math.max(u.max, 50);
    if (e.type === 'progress_75') u.max = Math.max(u.max, 75);
    if (e.type === 'complete') {
      u.max = 100;
      u.completed = true;
    }
    byUser.set(e.userId, u);
  }
  const count = (type) => events.filter((e) => e.type === type).length;
  const stats = {
    contentId: c.id,
    privacyMode: orgSettingsFor(c.orgId).privacyMode,
    uniqueViewers: byUser.size,
    viewStarts: count('view_start'),
    completions: count('complete'),
    rewatches: events.filter((e) => e.rewatch).length,
    milestones: { p25: count('progress_25'), p50: count('progress_50'), p75: count('progress_75') },
    likes: likeCountFor(c.id),
    comments: visibleCommentCount(c.id),
  };
  if (stats.privacyMode === 'named') {
    stats.viewers = [...byUser.values()].map((u) => ({
      userId: u.userId,
      displayName: db.users.get(u.userId)?.displayName ?? '',
      firstViewedAt: u.first,
      lastViewedAt: u.last,
      maxProgressPct: u.max,
      completed: u.completed,
      watchCount: u.watchCount,
    }));
  }
  return stats;
});

// tags and pins
function detailWithM1b(c, user) {
  return contentDetail(c, user);
}
route('PUT', '/v1/content/:id/tags', async ({ auth, params, body }) => {
  const c = contentOrThrow(params.id, auth.user, { edit: true });
  validate(
    Array.isArray(body.tags) &&
      body.tags.length <= 4 &&
      body.tags.every((t) => EVENT_TAGS.includes(t)) &&
      new Set(body.tags).size === body.tags.length,
    'tags',
  );
  db.tags.set(c.id, [...body.tags]);
  bumpContentEpoch(c);
  return detailWithM1b(c, auth.user);
});
function pinTargetOrThrow(c, user, streamId) {
  if (streamId === null) {
    if (!['owner', 'admin', 'announcer'].includes(user.role)) {
      throw new HttpError(403, 'pin_forbidden', 'org-wide pins need owner/admin/announcer');
    }
    return 'org';
  }
  validate(UUID_RE.test(streamId), 'streamId');
  const s = db.streams.get(streamId);
  if (!s || s.orgId !== user.orgId) throw new HttpError(404, 'not_found', 'no such stream');
  const role = streamRoleFor(s, user);
  const allowed =
    role === 'moderator' || role === 'owner' || user.role === 'owner' || user.role === 'admin';
  if (!allowed) throw new HttpError(403, 'pin_forbidden', 'stream pins need moderator/owner');
  if (!c.audience.some((a) => a.type === 'stream' && a.streamId === streamId)) {
    throw new HttpError(409, 'not_in_audience', 'item is not addressed to that stream');
  }
  return streamId;
}
route('POST', '/v1/content/:id/pin', async ({ auth, params, body }) => {
  const c = db.content.get(params.id);
  if (!c || c.orgId !== auth.user.orgId) throw new HttpError(404, 'content_not_found', 'no such');
  if (c.state !== 'published') throw new HttpError(409, 'not_published', 'not published');
  const target = pinTargetOrThrow(c, auth.user, body.streamId ?? null);
  db.pins.set(`${c.id}:${target}`, true);
  bumpContentEpoch(c);
  return detailWithM1b(c, auth.user);
});
route('DELETE', '/v1/content/:id/pin', async ({ auth, params, url }) => {
  const c = db.content.get(params.id);
  if (!c || c.orgId !== auth.user.orgId) throw new HttpError(404, 'content_not_found', 'no such');
  const streamId = url.searchParams.get('streamId');
  const target = pinTargetOrThrow(c, auth.user, streamId);
  db.pins.delete(`${c.id}:${target}`);
  bumpContentEpoch(c);
  return detailWithM1b(c, auth.user);
});

// org and stream settings, preferences
route('GET', '/v1/org/settings', async ({ auth }) => orgSettingsFor(auth.user.orgId));
route('PATCH', '/v1/org/settings', async ({ auth, body }) => {
  if (auth.user.role !== 'owner' && auth.user.role !== 'admin') {
    throw new HttpError(403, 'forbidden', 'owner or admin only');
  }
  const s = orgSettingsFor(auth.user.orgId);
  if (body.privacyMode !== undefined) {
    validate(
      ['aggregate_only', 'named', 'identified_for_required_only'].includes(body.privacyMode),
      'privacyMode',
    );
    s.privacyMode = body.privacyMode;
  }
  if (body.commentsEnabled !== undefined) {
    validate(typeof body.commentsEnabled === 'boolean', 'commentsEnabled');
    s.commentsEnabled = body.commentsEnabled;
  }
  if (body.engagementRetentionDays !== undefined) {
    validate(
      Number.isInteger(body.engagementRetentionDays) &&
        body.engagementRetentionDays >= 30 &&
        body.engagementRetentionDays <= 3650,
      'engagementRetentionDays',
    );
    s.engagementRetentionDays = body.engagementRetentionDays;
  }
  if (body.commentScanPolicy !== undefined) {
    validate(['off', 'warn', 'block'].includes(body.commentScanPolicy), 'commentScanPolicy');
    s.commentScanPolicy = body.commentScanPolicy;
  }
  return s;
});
route('PATCH', '/v1/streams/:id', async ({ auth, params, body }) => {
  const s = streamOrThrow(params.id, auth.user);
  const role = streamRoleFor(s, auth.user);
  // Same rule as the API: an org owner/admin or the stream's owner; moderators are refused.
  const allowed = role === 'owner' || auth.user.role === 'owner' || auth.user.role === 'admin';
  if (!allowed)
    throw new HttpError(403, 'role_forbidden', 'requires an org admin or the stream owner');
  if (body.commentsEnabled !== undefined) {
    validate(typeof body.commentsEnabled === 'boolean', 'commentsEnabled');
    db.streamSettings.set(s.id, { commentsEnabled: body.commentsEnabled });
  }
  return {
    ...streamView(s, auth.user),
    commentsEnabled: db.streamSettings.get(s.id)?.commentsEnabled ?? true,
  };
});
route(
  'GET',
  '/v1/me/preferences',
  async ({ auth }) => db.preferences.get(auth.user.id) ?? { emailDigest: 'daily' },
);
route('PATCH', '/v1/me/preferences', async ({ auth, body }) => {
  const current = db.preferences.get(auth.user.id) ?? { emailDigest: 'daily' };
  if (body.emailDigest !== undefined) {
    validate(['daily', 'off'].includes(body.emailDigest), 'emailDigest');
    current.emailDigest = body.emailDigest;
  }
  db.preferences.set(auth.user.id, current);
  return current;
});

// test hooks (mock only)
route('POST', '/__mock/reset', async () => {
  for (const m of Object.values(db)) m.clear();
  dropNextPasswordResponse = false;
  return { ok: true };
});
// Creates a password-less member of an existing org (what POST /v1/invites does on the real API) and
// returns the magic token the e2e would otherwise read from a mailbox. Mock only: never built into the
// web app, and the real API has no such route.
route('POST', '/__mock/invitee', async ({ body }) => {
  validate(
    str(body.orgSlug, 2, 48) && str(body.email, 3, 254) && body.email.includes('@'),
    'invitee',
  );
  const org = [...db.orgs.values()].find((o) => o.slug === body.orgSlug);
  if (!org) throw new HttpError(404, 'not_found', 'no such org');
  const email = body.email.toLowerCase();
  // Re-inviting an existing password-less member just mints a new link (the real API upserts the
  // invite row); an account that already has a password is never claimed this way.
  let user = [...db.users.values()].find((u) => u.email === email);
  if (user && (user.password !== null || user.orgId !== org.id))
    throw new HttpError(409, 'email_taken');
  if (!user) {
    user = {
      id: randomUUID(),
      email,
      displayName: str(body.displayName, 1, 120) ? body.displayName : 'Invitee',
      password: null,
      orgId: org.id,
      role: 'member',
      status: 'active',
      authzEpoch: 1,
    };
    db.users.set(user.id, user);
  }
  const token = randomBytes(24).toString('hex');
  db.magic.set(token, user.email);
  return { userId: user.id, token };
});
route('POST', '/__mock/drop-next-response', async () => {
  dropNextPasswordResponse = true;
  return { ok: true };
});
route('GET', '/__mock/state', async () => ({
  dropNextPasswordResponse,
  users: db.users.size,
  content: db.content.size,
  sessions: db.sessions.size,
  media: media.mode,
}));

const PUBLIC = new Set([
  '/v1/auth/signup',
  '/v1/auth/login',
  '/v1/auth/magic-link',
  '/v1/auth/magic-link/consume',
  '/v1/auth/logout',
  '/__mock/reset',
  '/__mock/state',
  '/__mock/invitee',
  '/__mock/drop-next-response',
  '/health',
  '/v1/meta',
]);

// ---- media and upload storage ----
function serveFile(req, res, filePath, contentType) {
  if (!existsSync(filePath)) return sendError(res, new HttpError(404, 'not_found'));
  const size = statSync(filePath).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  const headers = {
    'content-type': contentType,
    'cache-control':
      filePath.endsWith('.m3u8') || filePath.endsWith('.vtt') ? 'no-store' : 'private, max-age=60',
    'accept-ranges': 'bytes',
    vary: 'Cookie, Authorization',
  };
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[2] && range[1] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': end - start + 1,
    });
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  createReadStream(filePath).pipe(res);
}

function handleMedia(req, res, url) {
  const auth = authenticate(req);
  const m = /^\/media\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (!m) throw new HttpError(404, 'not_found');
  const [, contentId, versionId, asset] = m;
  const c = db.content.get(contentId);
  const v = db.versions.get(versionId);
  // ADR-0003: re-authorise on every request; retracted or superseded versions fail closed.
  if (!c || !v || v.contentId !== c.id || c.currentVersionId !== v.id || !isVisible(c, auth.user)) {
    throw new HttpError(403, 'forbidden');
  }
  const safeAsset = normalize(asset).replace(/^(\.\.(\/|\\|$))+/, '');
  if (safeAsset.includes('..')) throw new HttpError(404, 'not_found');
  if (safeAsset === 'captions/en.vtt')
    return serveFile(req, res, join(media.dir, '..', 'en.vtt'), media.contentType['.vtt']);
  let filePath;
  if (media.mode === 'hls') {
    if (!safeAsset.startsWith('hls/')) throw new HttpError(404, 'not_found');
    filePath = join(media.dir, safeAsset.slice(4));
  } else {
    if (safeAsset !== media.file) throw new HttpError(404, 'not_found');
    filePath = join(media.dir, media.file);
  }
  return serveFile(
    req,
    res,
    filePath,
    media.contentType[extname(filePath)] ?? 'application/octet-stream',
  );
}

async function handleUploadPart(req, res, url) {
  const m = /^\/__mock\/upload\/([a-f0-9]+)\/(\d+)$/.exec(url.pathname);
  if (!m) throw new HttpError(404, 'not_found');
  const upload = db.uploads.get(m[1]);
  if (!upload) throw new HttpError(404, 'not_found');
  const body = await readBody(req);
  const etag = randomBytes(8).toString('hex');
  upload.parts.set(Number(m[2]), { etag, bytes: body.length });
  res.writeHead(200, {
    etag: `"${etag}"`,
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'ETag',
  });
  res.end();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', publicBase);
  try {
    if (url.pathname.startsWith('/__mock/upload/')) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'PUT, OPTIONS',
          'access-control-allow-headers': '*',
          'access-control-expose-headers': 'ETag',
          'access-control-max-age': '600',
        });
        return res.end();
      }
      if (req.method === 'PUT') return await handleUploadPart(req, res, url);
      throw new HttpError(405, 'method_not_allowed');
    }
    if (url.pathname.startsWith('/media/')) return handleMedia(req, res, url);
    if (url.pathname === '/health')
      return sendJson(res, 200, { status: 'ok', version: 'mock', checks: { database: 'ok' } });
    if (url.pathname === '/v1/meta') {
      return sendJson(res, 200, {
        name: 'our-stream',
        version: 'mock',
        sourceUrl: 'https://github.com/ericmacdougall/our-stream/tree/mock',
        commit: 'mock',
      });
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const raw = req.method === 'GET' ? null : await readBody(req);
      let body = {};
      if (raw && raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          throw new HttpError(400, 'bad_request', 'invalid JSON');
        }
      }
      let auth = null;
      if (!PUBLIC.has(url.pathname)) {
        auth = authenticate(req);
        if (req.method !== 'GET') requireCsrf(req, auth.session);
      }
      const result = await r.handler({ req, res, url, params, body, auth });
      return sendJson(res, 200, result);
    }
    throw new HttpError(404, 'not_found', `no route ${req.method} ${url.pathname}`);
  } catch (err) {
    sendError(res, err);
  }
});

server.listen(PORT, HOST, () => {
  log(
    `listening on ${publicBase} (media mode: ${media.mode}, processing step ${PROCESSING_STEP_MS} ms)`,
  );
});

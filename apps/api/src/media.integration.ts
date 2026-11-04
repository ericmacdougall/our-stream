// SPDX-License-Identifier: AGPL-3.0-only
// Media proxy security (ADR-0003 tests): every request re-authorises; playlists are rewritten and
// never cached; tokens are bound to user, org, version and the content's media key.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signMediaToken } from './lib/tokens.js';

const errorCode = (body: unknown) => (body as { error: { code: string } }).error.code;
import {
  createHarness,
  createPlayableContent,
  createStream,
  integrationReady,
  type Harness,
  type Session,
} from './test-harness.js';

describe.skipIf(!integrationReady)('media proxy (integration)', () => {
  let h: Harness;
  let owner: Session;
  let author: Session;
  let viewer: Session;
  let nonViewer: Session;
  let dept: string;
  let contentId: string;
  let versionId: string;
  const base = () => `/media/${contentId}/${versionId}`;

  beforeAll(async () => {
    h = await createHarness('media');
    owner = await h.signup('owner', 'acme');
    author = await h.invite(owner, 'author', 'contributor');
    viewer = await h.invite(owner, 'viewer', 'member');
    nonViewer = await h.invite(owner, 'nonviewer', 'member');
    dept = await createStream(h, owner, 'dept', 'department', [
      { session: author, role: 'contributor' },
      { session: viewer, role: 'viewer' },
    ]);
    ({ contentId, versionId } = await createPlayableContent(h, author, 'Media clip'));
    const pub = await h.call('POST', `/v1/content/${contentId}/publish`, author, {
      audience: [{ type: 'stream', streamId: dept }],
    });
    if (pub.status !== 200) throw new Error(`publish failed ${pub.raw}`);
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it('serves the master playlist to a viewer, rewritten, with no storage URLs and no-store', async () => {
    const r = await h.call('GET', `${base()}/hls/master.m3u8`, viewer);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/vnd.apple.mpegurl');
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(r.raw).toContain('720p/index.m3u8');
    expect(r.raw).toContain(`${base()}/hls/1080p/index.m3u8`); // absolute storage URL rewritten
    expect(r.raw).toContain('URI="../captions/en.m3u8"');
    expect(r.raw).not.toContain('http://');
    expect(r.raw).not.toContain(h.config.S3_ENDPOINT.replace(/^https?:\/\//, ''));
    expect(r.raw).not.toContain(h.config.S3_BUCKET);

    const rendition = await h.call('GET', `${base()}/hls/720p/index.m3u8`, viewer);
    expect(rendition.status).toBe(200);
    expect(rendition.raw).toContain('URI="init.mp4"');
    expect(rendition.raw).toContain('seg0.m4s');
  });

  it('streams segments with Range support and a short private cache; captions are no-store', async () => {
    const seg = await h.call('GET', `${base()}/hls/720p/seg0.m4s`, viewer);
    expect(seg.status).toBe(200);
    expect(seg.headers['cache-control']).toBe('private, max-age=60');
    expect(seg.headers['accept-ranges']).toBe('bytes');
    expect(seg.raw).toBe('0123456789abcdef');

    const part = await h.call('GET', `${base()}/hls/720p/seg0.m4s`, viewer, undefined, {
      range: 'bytes=4-7',
    });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 4-7/16');
    expect(part.raw).toBe('4567');

    const vtt = await h.call('GET', `${base()}/captions/en.vtt`, viewer);
    expect(vtt.status).toBe(200);
    expect(vtt.headers['cache-control']).toBe('private, no-store');
    expect(vtt.headers['content-type']).toContain('text/vtt');
  });

  it('refuses non-viewers (403), anonymous requests (401), unknown versions (404) and traversal', async () => {
    const r = await h.call('GET', `${base()}/hls/master.m3u8`, nonViewer);
    expect(r.status).toBe(403);
    expect((await h.call('GET', `${base()}/hls/720p/seg0.m4s`, nonViewer)).status).toBe(403);
    expect((await h.call('GET', `${base()}/hls/master.m3u8`)).status).toBe(401);
    expect(
      (await h.call('GET', `/media/${contentId}/${randomUUID()}/hls/master.m3u8`, viewer)).status,
    ).toBe(404);
    expect(
      (await h.call('GET', `/media/${randomUUID()}/${versionId}/hls/master.m3u8`, viewer)).status,
    ).toBe(404);
    expect((await h.call('GET', `${base()}/..%2F..%2Foriginal%2Fx`, viewer)).status).toBe(404);
    expect((await h.call('GET', `${base()}/hls/missing.m4s`, viewer)).status).toBe(404);
  });

  it('media tokens: viewer token works without cookies, other user/version/secret tokens are refused', async () => {
    const denied = await h.call('GET', `/v1/content/${contentId}/media-token`, nonViewer);
    expect(denied.status).toBe(404);
    const issued = await h.call('GET', `/v1/content/${contentId}/media-token`, viewer);
    expect(issued.status).toBe(200);
    const { token } = issued.body as { token: string; versionId: string };
    expect((issued.body as { versionId: string }).versionId).toBe(versionId);

    const seg = await h.call('GET', `${base()}/hls/720p/seg0.m4s?t=${encodeURIComponent(token)}`);
    expect(seg.status).toBe(200);
    const playlist = await h.call(
      'GET',
      `${base()}/hls/master.m3u8?t=${encodeURIComponent(token)}`,
    );
    expect(playlist.status).toBe(200);
    expect(playlist.raw).toContain(`720p/index.m3u8?t=${token}`);
    expect(playlist.raw).toContain(`${base()}/hls/1080p/index.m3u8?t=${token}`);

    const keyRow = await h.admin.query<{ media_key_id: string }>(
      'SELECT media_key_id FROM content WHERE id = $1',
      [contentId],
    );
    const mediaKeyId = keyRow.rows[0]!.media_key_id;
    const exp = Math.floor(Date.now() / 1000) + 600;
    const forNonViewer = signMediaToken(h.config.MEDIA_HMAC_SECRET, {
      userId: nonViewer.userId,
      orgId: owner.orgId!,
      versionId,
      mediaKeyId,
      exp,
    });
    expect((await h.call('GET', `${base()}/hls/720p/seg0.m4s?t=${forNonViewer}`)).status).toBe(403);
    const forOtherVersion = signMediaToken(h.config.MEDIA_HMAC_SECRET, {
      userId: viewer.userId,
      orgId: owner.orgId!,
      versionId: randomUUID(),
      mediaKeyId,
      exp,
    });
    expect((await h.call('GET', `${base()}/hls/720p/seg0.m4s?t=${forOtherVersion}`)).status).toBe(
      403,
    );
    const forged = signMediaToken('not-the-server-secret-at-all-0123456789', {
      userId: viewer.userId,
      orgId: owner.orgId!,
      versionId,
      mediaKeyId,
      exp,
    });
    expect((await h.call('GET', `${base()}/hls/720p/seg0.m4s?t=${forged}`)).status).toBe(403);
    const expired = signMediaToken(h.config.MEDIA_HMAC_SECRET, {
      userId: viewer.userId,
      orgId: owner.orgId!,
      versionId,
      mediaKeyId,
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    expect((await h.call('GET', `${base()}/hls/720p/seg0.m4s?t=${expired}`)).status).toBe(403);
    expect((await h.call('GET', `${base()}/hls/720p/seg0.m4s?t=garbage`)).status).toBe(403);
  });

  it('a superseded version is refused (404) while the new current version plays', async () => {
    const v2 = await h.insertVersion(owner.orgId!, contentId);
    const assets = await h.seedHls(owner.orgId!, contentId, v2);
    await h.makeCurrent(owner.orgId!, contentId, v2, assets);
    expect((await h.call('GET', `${base()}/hls/master.m3u8`, viewer)).status).toBe(404);
    expect((await h.call('GET', `/media/${contentId}/${v2}/hls/master.m3u8`, viewer)).status).toBe(
      200,
    );
    versionId = v2;
  });

  it('a deactivated viewer is refused on the next request, with cookie and with a pre-issued token', async () => {
    const victim = await h.invite(owner, 'victim', 'member');
    const grant = await h.call('POST', `/v1/streams/${dept}/grants`, owner, {
      role: 'viewer',
      subject: { type: 'user', userId: victim.userId },
    });
    expect(grant.status).toBe(200);
    expect((await h.call('GET', `${base()}/hls/master.m3u8`, victim)).status).toBe(200);
    const { token } = (await h.call('GET', `/v1/content/${contentId}/media-token`, victim))
      .body as {
      token: string;
    };
    expect((await h.call('GET', `${base()}/hls/720p/seg0.m4s?t=${token}`)).status).toBe(200);

    await h.admin.query(`SELECT set_config('app.org_id', $1, false)`, [owner.orgId]);
    await h.admin.query(
      `UPDATE org_membership SET status = 'deactivated' WHERE org_id = $1 AND user_id = $2`,
      [owner.orgId, victim.userId],
    );
    // Cookie: the session was revoked by the membership trigger (401); a surviving session would hit
    // the membership check (403). Token: identity still parses, membership is inactive (403).
    expect([401, 403]).toContain((await h.call('GET', `${base()}/hls/master.m3u8`, victim)).status);
    expect((await h.call('GET', `${base()}/hls/720p/seg0.m4s?t=${token}`)).status).toBe(403);
  });

  it('after retraction cookie paths answer 404 and a token issued before is refused as unverified (403)', async () => {
    const { token } = (await h.call('GET', `/v1/content/${contentId}/media-token`, viewer))
      .body as {
      token: string;
    };
    expect((await h.call('POST', `/v1/content/${contentId}/retract`, author)).status).toBe(200);
    expect((await h.call('GET', `${base()}/hls/master.m3u8`, viewer)).status).toBe(404);
    expect((await h.call('GET', `${base()}/hls/720p/seg0.m4s`, viewer)).status).toBe(404);
    // Retraction rotates the media key, so the old token no longer verifies; unverified tokens get one
    // answer (403 bad_token) so they cannot tell retracted from current (F1).
    const stale = await h.call('GET', `${base()}/hls/720p/seg0.m4s?t=${token}`);
    expect(stale.status).toBe(403);
    expect(errorCode(stale.body)).toBe('bad_token');
    expect((await h.call('GET', `/v1/content/${contentId}/media-token`, viewer)).status).toBe(404);

    // Verification note F1: an unverified (forged) token must not learn whether the content exists or
    // was retracted; every such request answers 403 bad_token, never 404.
    const forged = signMediaToken('not-the-server-secret-at-all-0123456789', {
      userId: viewer.userId,
      orgId: owner.orgId!,
      versionId,
      mediaKeyId: randomUUID(), // signed with the wrong secret; the key id does not matter
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const onRetracted = await h.call('GET', `${base()}/hls/720p/seg0.m4s?t=${forged}`);
    expect(onRetracted.status).toBe(403);
    expect(errorCode(onRetracted.body)).toBe('bad_token');
    const onMissing = await h.call(
      'GET',
      `/media/${randomUUID()}/${versionId}/hls/720p/seg0.m4s?t=${forged}`,
    );
    expect(onMissing.status).toBe(403);
    expect(errorCode(onMissing.body)).toBe('bad_token');
  });
});

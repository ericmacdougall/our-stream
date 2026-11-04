// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig({
  DATABASE_URL: 'postgres://unused',
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
});

describe('api app', () => {
  it('reports database down with 503 when no pool is configured, and never allows shared caching', async () => {
    const app = await buildApp({ config, pool: null, version: 'test' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'ok', checks: { database: 'down' } });
    expect(res.headers['cache-control']).toBe('private, no-store');
    await app.close();
  });

  it('serves an OpenAPI 3.1 document that includes the M1a routes', async () => {
    const app = await buildApp({ config, pool: null, version: 'test' });
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/health',
        '/v1/meta',
        '/v1/auth/signup',
        '/v1/auth/login',
        '/v1/auth/logout',
        '/v1/auth/magic-link',
        '/v1/auth/magic-link/consume',
        '/v1/me',
        '/v1/me/org',
        '/v1/streams',
        '/v1/streams/{id}/grants',
        '/v1/members',
        '/v1/invites',
        '/v1/content',
        '/v1/content/{id}',
        '/v1/content/{id}/upload/init',
        '/v1/content/{id}/upload/complete',
        '/v1/content/{id}/publish',
        '/v1/content/{id}/retract',
        '/v1/content/{id}/replace',
        '/v1/content/{id}/view',
        '/v1/content/{id}/media-token',
        '/v1/feed',
        '/v1/sync',
        '/v1/notifications',
        '/v1/notifications/{id}/read',
      ]),
    );
    expect(Object.keys(doc.paths)).not.toContain('/media/{contentId}/{versionId}/*');
    await app.close();
  });

  it('answers 503 on authenticated routes when no database is configured', async () => {
    const app = await buildApp({ config, pool: null, version: 'test' });
    const res = await app.inject({ method: 'GET', url: '/v1/feed' });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('meta exposes the AGPL source link for the running commit', async () => {
    const app = await buildApp({
      config: { ...config, GIT_COMMIT: 'abc123' },
      pool: null,
      version: 'test',
    });
    const res = await app.inject({ method: 'GET', url: '/v1/meta' });
    expect(res.json()).toMatchObject({
      name: 'our-stream',
      commit: 'abc123',
      sourceUrl: 'https://github.com/ericmacdougall/our-stream/tree/abc123',
    });
    await app.close();
  });

  it('refuses to start with invalid configuration', () => {
    expect(() => loadConfig({ PORT: '99999' })).toThrow(/invalid configuration/);
  });
});

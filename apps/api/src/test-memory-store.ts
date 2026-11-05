// SPDX-License-Identifier: AGPL-3.0-only
// In-memory ObjectStore for the API integration suites. Two uses: (1) `TEST_STORE=memory` runs the suites
// without a SeaweedFS container (the part URLs it issues point at a loopback HTTP server that accepts the
// PUTs), (2) race tests pass a configured instance to createHarness to hold, fail or count storage calls
// (a second multipart complete throws NoSuchUpload exactly as S3 does once the upload is gone).
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import type { ObjectBody, ObjectHead, ObjectStore } from './lib/storage.js';
import { RangeNotSatisfiable } from './lib/storage.js';

interface Upload {
  key: string;
  parts: Map<number, { body: Buffer; etag: string }>;
}

export interface StoreHooks {
  /** Awaited at the start of every completeMultipartUpload (`call` counts from 1). */
  beforeComplete?: (info: { key: string; uploadId: string; call: number }) => Promise<void>;
  /** Awaited at the start of every get (download proxy tests: slow or blocked storage). */
  beforeGet?: (key: string) => Promise<void>;
}

export class NoSuchUploadError extends Error {
  override name = 'NoSuchUpload';
  constructor() {
    super('The specified upload does not exist.');
  }
}

export class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  readonly uploads = new Map<string, Upload>();
  hooks: StoreHooks = {};
  completeCalls = 0;
  getCalls = 0;
  private server: Server | null = null;
  private baseUrl = 'http://127.0.0.1:0';
  private nextUpload = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const m = /^\/part\/([^/]+)\/(\d+)$/.exec(req.url ?? '');
      if (req.method !== 'PUT' || !m) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const upload = this.uploads.get(decodeURIComponent(m[1]!));
        if (!upload) {
          res.statusCode = 404;
          res.end();
          return;
        }
        const body = Buffer.concat(chunks);
        const etag = `"${createHash('md5').update(body).digest('hex')}"`;
        upload.parts.set(Number(m[2]), { body, etag });
        res.setHeader('ETag', etag);
        res.statusCode = 200;
        res.end();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    if (addr && typeof addr === 'object') this.baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  async ensureBucket(): Promise<void> {}

  async createMultipartUpload(key: string): Promise<string> {
    this.nextUpload += 1;
    const id = `mem-upload-${this.nextUpload}-${Math.random().toString(36).slice(2, 10)}`;
    this.uploads.set(id, { key, parts: new Map() });
    return id;
  }

  async presignUploadPart(key: string, uploadId: string, partNumber: number): Promise<string> {
    return `${this.baseUrl}/part/${encodeURIComponent(uploadId)}/${partNumber}`;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>,
  ): Promise<void> {
    this.completeCalls += 1;
    await this.hooks.beforeComplete?.({ key, uploadId, call: this.completeCalls });
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) throw new NoSuchUploadError();
    const bodies: Buffer[] = [];
    for (const p of [...parts].sort((a, b) => a.partNumber - b.partNumber)) {
      const have = upload.parts.get(p.partNumber);
      if (!have || have.etag !== p.etag)
        throw Object.assign(new Error('InvalidPart'), { name: 'InvalidPart' });
      bodies.push(have.body);
    }
    this.objects.set(key, { body: Buffer.concat(bodies), contentType: 'application/octet-stream' });
    this.uploads.delete(uploadId);
  }

  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    this.uploads.delete(uploadId);
  }

  async head(key: string): Promise<ObjectHead | null> {
    const o = this.objects.get(key);
    return o ? { size: o.body.length, contentType: o.contentType } : null;
  }

  async get(key: string, range?: string): Promise<ObjectBody | null> {
    this.getCalls += 1;
    await this.hooks.beforeGet?.(key);
    const o = this.objects.get(key);
    if (!o) return null;
    if (!range) {
      return {
        status: 200,
        body: Readable.from([o.body]),
        contentType: o.contentType,
        contentLength: o.body.length,
        contentRange: null,
        etag: null,
      };
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (m[1] === '' && m[2] === '')) throw new RangeNotSatisfiable();
    const size = o.body.length;
    const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
    const end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (start >= size || start > end) throw new RangeNotSatisfiable();
    const slice = o.body.subarray(start, end + 1);
    return {
      status: 206,
      body: Readable.from([slice]),
      contentType: o.contentType,
      contentLength: slice.length,
      contentRange: `bytes ${start}-${end}/${size}`,
      etag: null,
    };
  }

  async put(key: string, body: Buffer | string, contentType: string): Promise<void> {
    this.objects.set(key, {
      body: Buffer.isBuffer(body) ? body : Buffer.from(body),
      contentType,
    });
  }
}

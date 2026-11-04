// SPDX-License-Identifier: AGPL-3.0-only
// Object storage adapter (AWS SDK v3, path style for SeaweedFS/Garage). Downloads the original into a
// temp file after a size check and uploads a derived directory with correct content types.
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
}

export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3Config {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is required`);
    return v;
  };
  return {
    endpoint: need('S3_ENDPOINT'),
    region: env['S3_REGION'] ?? 'us-east-1',
    bucket: need('S3_BUCKET'),
    accessKey: need('S3_ACCESS_KEY'),
    secretKey: need('S3_SECRET_KEY'),
    forcePathStyle: (env['S3_FORCE_PATH_STYLE'] ?? 'true') !== 'false',
  };
}

export class InputTooLargeError extends Error {
  constructor(
    public readonly size: number,
    public readonly max: number,
  ) {
    super(`input exceeds the maximum size (${size} > ${max} bytes)`);
    this.name = 'InputTooLargeError';
  }
}

export const CONTENT_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.vtt': 'text/vtt; charset=utf-8',
  '.json': 'application/json',
  '.wav': 'audio/wav',
};

export function contentTypeFor(key: string): string {
  const dot = key.lastIndexOf('.');
  return (
    (dot >= 0 ? CONTENT_TYPES[key.slice(dot).toLowerCase()] : undefined) ??
    'application/octet-stream'
  );
}

export interface ObjectStore {
  /** Downloads `key` to `dest`; rejects with InputTooLargeError before transferring anything bigger than `maxBytes`. */
  download(key: string, dest: string, maxBytes: number): Promise<{ size: number }>;
  /** Uploads every file under `dir` to `prefix` (posix-joined relative paths), overwriting existing keys. */
  uploadDir(prefix: string, dir: string): Promise<string[]>;
  /** Keys currently stored under a prefix (for idempotency checks and tests). */
  list(prefix: string): Promise<string[]>;
  deletePrefix(prefix: string): Promise<number>;
  deleteKeys(keys: string[]): Promise<void>;
  putObject(key: string, body: Buffer | string, contentType?: string): Promise<void>;
  /** Whole object in memory; for small derived files and tests only. */
  getObject(key: string): Promise<Buffer>;
  /** Creates the bucket when missing (dev/test bootstrap; production buckets are provisioned). */
  ensureBucket(): Promise<void>;
}

export function createObjectStore(cfg: S3Config, client?: S3Client): ObjectStore {
  const s3 =
    client ??
    new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    });
  const Bucket = cfg.bucket;
  return {
    async download(key, dest, maxBytes) {
      const head = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
      const size = head.ContentLength ?? 0;
      if (size > maxBytes) throw new InputTooLargeError(size, maxBytes);
      const obj = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
      if (!obj.Body) throw new Error('empty object body');
      let seen = 0;
      const body = obj.Body as Readable;
      body.on('data', (c: Buffer) => {
        seen += c.length;
        if (seen > maxBytes) body.destroy(new InputTooLargeError(seen, maxBytes));
      });
      await pipeline(body, createWriteStream(dest, { flags: 'w', mode: 0o600 }));
      return { size: seen };
    },
    async uploadDir(prefix, dir) {
      const keys: string[] = [];
      const files = await walk(dir);
      // Bounded parallelism so a large ladder does not open hundreds of sockets.
      const queue = [...files];
      const workers = Array.from({ length: 8 }, async () => {
        for (;;) {
          const file = queue.shift();
          if (!file) return;
          const rel = relative(dir, file).split(sep).join(posix.sep);
          const key = posix.join(prefix, rel);
          const { size } = await stat(file);
          await s3.send(
            new PutObjectCommand({
              Bucket,
              Key: key,
              Body: createReadStream(file),
              ContentLength: size,
              ContentType: contentTypeFor(key),
            }),
          );
          keys.push(key);
        }
      });
      await Promise.all(workers);
      return keys.sort();
    },
    async list(prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const r = await s3.send(
          new ListObjectsV2Command({
            Bucket,
            Prefix: prefix,
            ...(token ? { ContinuationToken: token } : {}),
          }),
        );
        for (const o of r.Contents ?? []) if (o.Key) keys.push(o.Key);
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return keys.sort();
    },
    async deletePrefix(prefix) {
      const keys = await this.list(prefix);
      await this.deleteKeys(keys);
      return keys.length;
    },
    async deleteKeys(keys) {
      for (let i = 0; i < keys.length; i += 500) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket,
            Delete: { Objects: keys.slice(i, i + 500).map((Key) => ({ Key })), Quiet: true },
          }),
        );
      }
    },
    async putObject(key, body, contentType) {
      await s3.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: body,
          ContentType: contentType ?? contentTypeFor(key),
        }),
      );
    },
    async getObject(key) {
      const obj = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
      if (!obj.Body) throw new Error('empty object body');
      return Buffer.from(await obj.Body.transformToByteArray());
    },
    async ensureBucket() {
      try {
        await s3.send(new HeadBucketCommand({ Bucket }));
      } catch {
        await s3.send(new CreateBucketCommand({ Bucket }));
      }
    },
  };
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

// SPDX-License-Identifier: AGPL-3.0-only
// Object storage adapter over the S3 API (ADR-0003 upload and media delivery). Keys are built by the
// server from ids only (ADR-0001 §3); user-supplied names never reach a key.
import type { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  PutBucketCorsCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '../config.js';

export interface ObjectHead {
  size: number;
  contentType: string | null;
}

export interface ObjectBody {
  status: 200 | 206;
  body: Readable;
  contentType: string | null;
  contentLength: number | null;
  contentRange: string | null;
  etag: string | null;
}

export interface ObjectStore {
  ensureBucket(): Promise<void>;
  createMultipartUpload(key: string, contentType: string): Promise<string>;
  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number,
  ): Promise<string>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>,
  ): Promise<void>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  head(key: string): Promise<ObjectHead | null>;
  get(key: string, range?: string): Promise<ObjectBody | null>;
  put(key: string, body: Buffer | string, contentType: string): Promise<void>;
}

export function versionPrefix(orgId: string, contentId: string, versionId: string): string {
  return `orgs/${orgId}/content/${contentId}/versions/${versionId}/`;
}

export function originalKey(orgId: string, contentId: string, versionId: string, uuid: string) {
  return `${versionPrefix(orgId, contentId, versionId)}original/${uuid}`;
}

export function derivedPrefix(orgId: string, contentId: string, versionId: string): string {
  return `${versionPrefix(orgId, contentId, versionId)}derived/`;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === 'NotFound' ||
    e.name === 'NoSuchKey' ||
    e.name === 'NoSuchBucket' ||
    e.$metadata?.httpStatusCode === 404
  );
}

/** Origins allowed to upload directly: S3_CORS_ORIGINS or APP_BASE_URL plus its loopback twin. */
export function corsOrigins(config: Config): string[] {
  const explicit = config.S3_CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (explicit.length > 0) return explicit;
  const base = new URL(config.APP_BASE_URL);
  const twin =
    base.hostname === 'localhost'
      ? '127.0.0.1'
      : base.hostname === '127.0.0.1'
        ? 'localhost'
        : null;
  const out = [base.origin];
  if (twin) out.push(`${base.protocol}//${twin}${base.port ? ':' + base.port : ''}`);
  return out;
}

export function createS3Store(config: Config): ObjectStore {
  const client = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
  });
  const Bucket = config.S3_BUCKET;
  // Presigned part URLs are what the browser calls, so they are signed against the public endpoint.
  const presignClient = config.S3_PUBLIC_ENDPOINT
    ? new S3Client({
        endpoint: config.S3_PUBLIC_ENDPOINT,
        region: config.S3_REGION,
        forcePathStyle: config.S3_FORCE_PATH_STYLE,
        credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
      })
    : client;
  return {
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
      } catch (err) {
        if (!isNotFound(err)) throw err;
        await client.send(new CreateBucketCommand({ Bucket }));
      }
      // Browsers PUT upload parts straight to storage, so the bucket must answer CORS preflights for
      // the web origin and expose ETag (needed to complete the multipart upload).
      await client.send(
        new PutBucketCorsCommand({
          Bucket,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: corsOrigins(config),
                AllowedMethods: ['PUT', 'GET', 'HEAD'],
                AllowedHeaders: ['*'],
                ExposeHeaders: ['ETag'],
                MaxAgeSeconds: 3600,
              },
            ],
          },
        }),
      );
    },
    async createMultipartUpload(Key, ContentType) {
      const r = await client.send(new CreateMultipartUploadCommand({ Bucket, Key, ContentType }));
      if (!r.UploadId) throw new Error('storage returned no upload id');
      return r.UploadId;
    },
    presignUploadPart(Key, UploadId, PartNumber, expiresIn) {
      return getSignedUrl(
        presignClient,
        new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
        { expiresIn },
      );
    },
    async completeMultipartUpload(Key, UploadId, parts) {
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket,
          Key,
          UploadId,
          MultipartUpload: {
            Parts: [...parts]
              .sort((a, b) => a.partNumber - b.partNumber)
              .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
          },
        }),
      );
    },
    async abortMultipartUpload(Key, UploadId) {
      await client.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
    },
    async head(Key) {
      try {
        const r = await client.send(new HeadObjectCommand({ Bucket, Key }));
        return { size: r.ContentLength ?? 0, contentType: r.ContentType ?? null };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async get(Key, range) {
      try {
        const r = await client.send(
          new GetObjectCommand({ Bucket, Key, ...(range ? { Range: range } : {}) }),
        );
        if (!r.Body) return null;
        return {
          status: r.$metadata.httpStatusCode === 206 ? 206 : 200,
          body: r.Body as Readable,
          contentType: r.ContentType ?? null,
          contentLength: r.ContentLength ?? null,
          contentRange: r.ContentRange ?? null,
          etag: r.ETag ?? null,
        };
      } catch (err) {
        if (isNotFound(err)) return null;
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (e.name === 'InvalidRange' || e.$metadata?.httpStatusCode === 416) {
          throw new RangeNotSatisfiable();
        }
        throw err;
      }
    },
    async put(Key, Body, ContentType) {
      await client.send(new PutObjectCommand({ Bucket, Key, Body, ContentType }));
    },
  };
}

export class RangeNotSatisfiable extends Error {
  constructor() {
    super('range not satisfiable');
  }
}

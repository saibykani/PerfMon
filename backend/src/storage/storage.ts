import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep, join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand,
  ListObjectsV2Command, DeleteObjectsCommand, HeadBucketCommand, CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { config } from '../config.js';

export interface StorageDriver {
  readonly name: string;
  init(): Promise<void>;
  put(key: string, body: Buffer | Readable, contentType?: string, size?: number): Promise<void>;
  get(key: string): Promise<Readable>;
  getBuffer(key: string): Promise<Buffer>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
  list(prefix: string): Promise<string[]>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

/** Object keys: forward-slash separated, no traversal, conservative charset. */
export function assertSafeKey(key: string) {
  if (!key || key.length > 1024 || key.startsWith('/') || key.includes('\\') || key.includes('\0')) throw new Error(`unsafe storage key: ${key}`);
  for (const seg of key.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') throw new Error(`unsafe storage key: ${key}`);
  }
}

/** Sanitize a user-supplied file name into a safe single path segment. */
export function safeFileName(name: string) {
  const base = name.split(/[\\/]/).pop() || 'file';
  const cleaned = base.normalize('NFKC').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 180);
  return cleaned || 'file';
}

async function streamToBuffer(s: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

class LocalStorage implements StorageDriver {
  readonly name = 'local';
  private root = resolve(config.storage.localPath);
  private path(key: string) {
    assertSafeKey(key);
    const p = resolve(this.root, ...key.split('/'));
    if (!p.startsWith(this.root + sep)) throw new Error('path traversal blocked');
    return p;
  }
  async init() { await mkdir(this.root, { recursive: true }); }
  async put(key: string, body: Buffer | Readable) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    if (Buffer.isBuffer(body)) await writeFile(p, body);
    else await pipeline(body, createWriteStream(p));
  }
  async get(key: string) {
    const p = this.path(key);
    if (!existsSync(p)) throw Object.assign(new Error('not found'), { code: 'NoSuchKey' });
    return createReadStream(p);
  }
  async getBuffer(key: string) { return readFile(this.path(key)); }
  async head(key: string) {
    try { return { size: (await stat(this.path(key))).size }; } catch { return null; }
  }
  async delete(key: string) { await rm(this.path(key), { force: true }); }
  async deletePrefix(prefix: string) {
    const keys = await this.list(prefix);
    await rm(this.path(prefix.replace(/\/$/, '')), { recursive: true, force: true });
    return keys.length;
  }
  async list(prefix: string) {
    const base = this.path(prefix.replace(/\/$/, ''));
    const out: string[] = [];
    const walk = async (dir: string) => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else out.push(relative(this.root, full).split(sep).join('/'));
      }
    };
    await walk(base);
    return out;
  }
  async health() {
    try { await mkdir(this.root, { recursive: true }); return { ok: true, detail: this.root }; } catch (e) { return { ok: false, detail: (e as Error).message }; }
  }
}

class S3Storage implements StorageDriver {
  readonly name = 's3';
  private bucket = config.storage.s3.bucket;
  private client = new S3Client({
    region: config.storage.s3.region,
    endpoint: config.storage.s3.endpoint || undefined,
    forcePathStyle: config.storage.s3.forcePathStyle,
    credentials: config.storage.s3.accessKeyId ? { accessKeyId: config.storage.s3.accessKeyId, secretAccessKey: config.storage.s3.secretAccessKey! } : undefined,
  });
  async init() {
    try { await this.client.send(new HeadBucketCommand({ Bucket: this.bucket })); }
    catch { await this.client.send(new CreateBucketCommand({ Bucket: this.bucket })); }
  }
  async put(key: string, body: Buffer | Readable, contentType?: string, size?: number) {
    assertSafeKey(key);
    // S3 PutObject needs a known length for streams; buffer streams of unknown size.
    const payload = Buffer.isBuffer(body) ? body : size != null ? body : await streamToBuffer(body);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: payload, ContentType: contentType, ContentLength: Buffer.isBuffer(payload) ? payload.length : size }));
  }
  async get(key: string) {
    assertSafeKey(key);
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body as Readable;
  }
  async getBuffer(key: string) { return streamToBuffer(await this.get(key)); }
  async head(key: string) {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: r.ContentLength ?? 0 };
    } catch { return null; }
  }
  async delete(key: string) { assertSafeKey(key); await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }
  async list(prefix: string) {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) if (o.Key) out.push(o.Key);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
  async deletePrefix(prefix: string) {
    const keys = await this.list(prefix);
    for (let i = 0; i < keys.length; i += 1000) {
      await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) } }));
    }
    return keys.length;
  }
  async health() {
    try { await this.client.send(new HeadBucketCommand({ Bucket: this.bucket })); return { ok: true, detail: `${config.storage.s3.endpoint || 'aws'}/${this.bucket}` }; }
    catch (e) { return { ok: false, detail: (e as Error).message }; }
  }
}

class AzureStorage implements StorageDriver {
  readonly name = 'azure';
  private containerPromise = (async () => {
    const { BlobServiceClient } = await import('@azure/storage-blob');
    return BlobServiceClient.fromConnectionString(config.storage.azure.connectionString!).getContainerClient(config.storage.azure.container);
  })();
  async init() { await (await this.containerPromise).createIfNotExists(); }
  async put(key: string, body: Buffer | Readable, contentType?: string) {
    assertSafeKey(key);
    const blob = (await this.containerPromise).getBlockBlobClient(key);
    const opts = { blobHTTPHeaders: { blobContentType: contentType } };
    if (Buffer.isBuffer(body)) await blob.uploadData(body, opts);
    else await blob.uploadStream(body, 4 * 1024 * 1024, 4, opts);
  }
  async get(key: string) {
    assertSafeKey(key);
    const r = await (await this.containerPromise).getBlobClient(key).download();
    return r.readableStreamBody as unknown as Readable;
  }
  async getBuffer(key: string) { return streamToBuffer(await this.get(key)); }
  async head(key: string) {
    try { const p = await (await this.containerPromise).getBlobClient(key).getProperties(); return { size: p.contentLength ?? 0 }; } catch { return null; }
  }
  async delete(key: string) { await (await this.containerPromise).deleteBlob(key).catch(() => undefined); }
  async list(prefix: string) {
    const out: string[] = [];
    for await (const b of (await this.containerPromise).listBlobsFlat({ prefix })) out.push(b.name);
    return out;
  }
  async deletePrefix(prefix: string) {
    const keys = await this.list(prefix);
    for (const k of keys) await this.delete(k);
    return keys.length;
  }
  async health() {
    try { await (await this.containerPromise).getProperties(); return { ok: true, detail: config.storage.azure.container }; }
    catch (e) { return { ok: false, detail: (e as Error).message }; }
  }
}

function createDriver(): StorageDriver {
  switch (config.storage.driver) {
    case 's3': return new S3Storage();
    case 'azure': return new AzureStorage();
    default: return new LocalStorage();
  }
}

export const storage: StorageDriver = createDriver();

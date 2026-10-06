import yauzl from 'yauzl';
import type { Readable } from 'node:stream';

export interface ZipEntryInfo { name: string; size: number; compressedSize: number; isDir: boolean }

const LIMITS = { maxEntries: 50000, maxTotalBytes: 4 * 1024 * 1024 * 1024, maxRatio: 200, maxEntryBytes: 1024 * 1024 * 1024 };

/** Normalize an archive entry path, rejecting traversal (zip-slip), absolute paths and drive letters. */
export function safeEntryPath(name: string): string | null {
  const n = name.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.includes('\0')) return null;
  const parts: string[] = [];
  for (const seg of n.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

function open(file: string): Promise<yauzl.ZipFile> {
  return new Promise((res, rej) => yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (err, zf) => (err ? rej(err) : res(zf!))));
}

export async function listZip(file: string): Promise<ZipEntryInfo[]> {
  const zf = await open(file);
  const out: ZipEntryInfo[] = [];
  try {
    await new Promise<void>((res, rej) => {
      zf.on('entry', (e: yauzl.Entry) => {
        out.push({ name: e.fileName, size: e.uncompressedSize, compressedSize: e.compressedSize, isDir: e.fileName.endsWith('/') });
        if (out.length > LIMITS.maxEntries) return rej(new Error(`archive has more than ${LIMITS.maxEntries} entries`));
        zf.readEntry();
      });
      zf.on('end', () => res());
      zf.on('error', rej);
      zf.readEntry();
    });
  } finally { zf.close(); }
  return out;
}

/** Validates archive against zip-bomb heuristics. */
export function checkZipLimits(entries: ZipEntryInfo[]) {
  const total = entries.reduce((a, e) => a + e.size, 0);
  if (total > LIMITS.maxTotalBytes) throw new Error('archive expands beyond the 4 GB limit');
  for (const e of entries) {
    if (e.size > LIMITS.maxEntryBytes) throw new Error(`entry ${e.name} is too large`);
    if (e.compressedSize > 0 && e.size / e.compressedSize > LIMITS.maxRatio && e.size > 10 * 1024 * 1024) throw new Error(`entry ${e.name} has a suspicious compression ratio`);
  }
}

/** Find the JMeter report root inside an archive (directory containing index.html). */
export function findReportRoot(entries: ZipEntryInfo[]): string | null {
  const idx = entries.map((e) => safeEntryPath(e.name)).filter((n): n is string => !!n && /(^|\/)index\.html?$/i.test(n));
  if (!idx.length) return null;
  // prefer one that has content/js/dashboard.js next to it, then the shallowest
  const scored = idx.map((p) => {
    const root = p.replace(/index\.html?$/i, '');
    const hasDash = entries.some((e) => safeEntryPath(e.name) === `${root}content/js/dashboard.js`);
    return { root, score: (hasDash ? 0 : 100) + root.split('/').length };
  }).sort((a, b) => a.score - b.score);
  return scored[0].root;
}

/** Iterate archive entries as streams (files only, safe paths only). */
export async function forEachZipEntry(file: string, fn: (path: string, stream: Readable, size: number) => Promise<void>) {
  const zf = await open(file);
  try {
    await new Promise<void>((res, rej) => {
      zf.on('entry', (e: yauzl.Entry) => {
        const p = safeEntryPath(e.fileName);
        const isSymlink = ((e.externalFileAttributes >>> 16) & 0o170000) === 0o120000;
        if (!p || e.fileName.endsWith('/') || isSymlink) { zf.readEntry(); return; }
        zf.openReadStream(e, (err, stream) => {
          if (err) return rej(err);
          fn(p, stream!, e.uncompressedSize).then(() => zf.readEntry(), rej);
        });
      });
      zf.on('end', () => res());
      zf.on('error', rej);
      zf.readEntry();
    });
  } finally { zf.close(); }
}

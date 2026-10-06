import { extname } from 'node:path';

export const ARTIFACT_KINDS = ['HTML_REPORT', 'JTL', 'CSV', 'JMX', 'LOG', 'SCREENSHOT', 'SERVER_LOG', 'APP_LOG', 'CONFIG', 'TEST_DATA', 'JSON', 'XML', 'PDF', 'EXCEL', 'ZIP', 'OTHER'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

// Executables / scripts are never accepted as artifacts.
const BLOCKED_EXT = new Set(['.exe', '.dll', '.so', '.dylib', '.bat', '.cmd', '.com', '.msi', '.scr', '.ps1', '.vbs', '.jar', '.war', '.ear', '.apk', '.app', '.dmg', '.pif', '.cpl', '.hta', '.lnk', '.reg']);

const EXT_KIND: Record<string, ArtifactKind> = {
  '.jtl': 'JTL', '.csv': 'CSV', '.jmx': 'JMX', '.log': 'LOG', '.txt': 'LOG', '.out': 'LOG',
  '.png': 'SCREENSHOT', '.jpg': 'SCREENSHOT', '.jpeg': 'SCREENSHOT', '.gif': 'SCREENSHOT', '.webp': 'SCREENSHOT', '.bmp': 'SCREENSHOT',
  '.json': 'JSON', '.xml': 'XML', '.pdf': 'PDF', '.xlsx': 'EXCEL', '.xls': 'EXCEL', '.zip': 'ZIP',
  '.html': 'HTML_REPORT', '.htm': 'HTML_REPORT', '.properties': 'CONFIG', '.yaml': 'CONFIG', '.yml': 'CONFIG', '.conf': 'CONFIG', '.ini': 'CONFIG',
};

export function inferKind(filename: string): ArtifactKind {
  return EXT_KIND[extname(filename).toLowerCase()] ?? 'OTHER';
}

export function isBlocked(filename: string) {
  return BLOCKED_EXT.has(extname(filename).toLowerCase());
}

/** Detect MIME from magic bytes; returns null for text/unknown. */
export function sniffMime(head: Buffer): string | null {
  const hex = head.subarray(0, 8).toString('hex');
  if (hex.startsWith('504b0304') || hex.startsWith('504b0506')) return 'application/zip';
  if (hex.startsWith('25504446')) return 'application/pdf';
  if (hex.startsWith('89504e47')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('47494638')) return 'image/gif';
  if (hex.startsWith('52494646') && head.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (hex.startsWith('1f8b')) return 'application/gzip';
  if (hex.startsWith('4d5a')) return 'application/x-msdownload'; // PE executable
  if (hex.startsWith('7f454c46')) return 'application/x-executable'; // ELF
  if (hex.startsWith('d0cf11e0')) return 'application/vnd.ms-excel';
  return null;
}

const looksText = (head: Buffer) => {
  const n = Math.min(head.length, 4096);
  let bad = 0;
  for (let i = 0; i < n; i++) { const c = head[i]; if (c === 0) return false; if (c < 9 || (c > 13 && c < 32)) bad++; }
  return bad / Math.max(1, n) < 0.02;
};

/**
 * Validate that file content is consistent with its declared kind/extension.
 * Returns the effective MIME type, or throws a descriptive message.
 */
export function validateContent(kind: ArtifactKind, filename: string, head: Buffer): string {
  const sniffed = sniffMime(head);
  if (sniffed === 'application/x-msdownload' || sniffed === 'application/x-executable') throw new Error('Executable content is not allowed');
  const ext = extname(filename).toLowerCase();
  const expect = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };
  switch (kind) {
    case 'HTML_REPORT':
      if (ext === '.zip') { expect(sniffed === 'application/zip', 'HTML report .zip is not a valid ZIP archive'); return 'application/zip'; }
      expect(['.html', '.htm'].includes(ext) && looksText(head), 'HTML report must be a .zip of the report directory or a single .html file');
      return 'text/html';
    case 'ZIP': expect(sniffed === 'application/zip', 'Not a valid ZIP archive'); return 'application/zip';
    case 'PDF': expect(sniffed === 'application/pdf', 'Not a valid PDF'); return 'application/pdf';
    case 'SCREENSHOT': expect(!!sniffed && sniffed.startsWith('image/'), 'Screenshot must be PNG, JPEG, GIF or WebP'); return sniffed!;
    case 'EXCEL': expect(sniffed === 'application/zip' || sniffed === 'application/vnd.ms-excel', 'Not a valid Excel file'); return ext === '.xls' ? 'application/vnd.ms-excel' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'JTL': case 'CSV': case 'JMX': case 'LOG': case 'SERVER_LOG': case 'APP_LOG': case 'CONFIG': case 'JSON': case 'XML': case 'TEST_DATA':
      if (sniffed === 'application/gzip' || sniffed === 'application/zip') return sniffed; // compressed logs are allowed
      expect(looksText(head), `${kind} artifact must be a text file`);
      return kind === 'JSON' ? 'application/json' : kind === 'XML' || kind === 'JMX' ? 'application/xml' : kind === 'CSV' || kind === 'JTL' ? 'text/csv' : 'text/plain';
    default:
      return sniffed ?? (looksText(head) ? 'text/plain' : 'application/octet-stream');
  }
}

/** Content types used when serving files. Active content never renders inline on the app origin. */
export const SERVE_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
};

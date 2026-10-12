import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, generateApiKey, mask, randomToken, safeEqual, sha256 } from './crypto.js';
import { ALL_PERMISSIONS, API_KEY_SCOPES, PERMISSIONS, ROLES } from '../auth/rbac.js';
import { assertSafeKey, safeFileName } from '../storage/storage.js';
import { inferEndpoint, normalizePath, normalizeSegment } from './endpoints.js';

describe('crypto: AES-256-GCM secret store', () => {
  it('round-trips unicode and empty strings', () => {
    for (const s of ['', 'p@ssw0rd', 'tökén — 🔐', 'x'.repeat(10_000)]) expect(decryptSecret(encryptSecret(s))).toBe(s);
  });

  it('uses a random IV (same plaintext → different ciphertext) with iv|tag|ct layout', () => {
    const a = encryptSecret('secret');
    const b = encryptSecret('secret');
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64').length).toBe(12 + 16 + 'secret'.length);
  });

  it('rejects tampered ciphertext (authentication tag check)', () => {
    const buf = Buffer.from(encryptSecret('secret'), 'base64');
    buf[buf.length - 1] ^= 0xff;
    expect(() => decryptSecret(buf.toString('base64'))).toThrow();
  });
});

describe('crypto: API keys and helpers', () => {
  it('generates pmk_<8 hex>_<secret> keys and stores only the sha256', () => {
    const k = generateApiKey();
    expect(k.prefix).toMatch(/^pmk_[0-9a-f]{8}$/);
    expect(k.full.startsWith(k.prefix + '_')).toBe(true);
    expect(k.full).toMatch(/^pmk_[0-9a-f]{8}_[A-Za-z0-9_-]{32}$/);
    expect(k.hash).toBe(sha256(k.full));
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(generateApiKey().full).not.toBe(k.full);
  });

  it('sha256 matches a known vector', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('safeEqual compares in constant time and handles length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('randomToken is url-safe', () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(8)).toHaveLength(11);
  });

  it('mask never reveals short secrets', () => {
    expect(mask(null)).toBeNull();
    expect(mask(undefined)).toBeNull();
    expect(mask('')).toBe('');
    expect(mask('12345678')).toBe('••••••••');
    expect(mask('abcdefghijkl')).toBe('ab••••••••kl');
  });
});

describe('RBAC', () => {
  it('every role only references known permissions', () => {
    for (const [role, def] of Object.entries(ROLES)) {
      for (const p of def.permissions) expect(PERMISSIONS, `${role}:${p}`).toHaveProperty(p);
    }
    for (const p of Object.values(API_KEY_SCOPES).flat()) expect(PERMISSIONS).toHaveProperty(p);
  });

  it('admins have everything; viewers are read-only', () => {
    expect(ROLES.SUPER_ADMIN.permissions).toEqual(ALL_PERMISSIONS);
    expect(ROLES.ADMIN.permissions).toEqual(ALL_PERMISSIONS);
    expect(ROLES.VIEWER.permissions.sort()).toEqual(['VIEW_PROJECT', 'VIEW_REPORT', 'VIEW_RUN']);
  });

  it('every role can view, and only admins manage users, settings and audit', () => {
    for (const def of Object.values(ROLES)) expect(def.permissions).toEqual(expect.arrayContaining(['VIEW_PROJECT', 'VIEW_RUN', 'VIEW_REPORT']));
    for (const p of ['MANAGE_USERS', 'MANAGE_SETTINGS', 'VIEW_AUDIT'] as const) {
      expect(Object.entries(ROLES).filter(([, d]) => d.permissions.includes(p)).map(([r]) => r).sort()).toEqual(['ADMIN', 'SUPER_ADMIN']);
    }
  });

  it('roles have no duplicate permissions', () => {
    for (const def of Object.values(ROLES)) expect(new Set(def.permissions).size).toBe(def.permissions.length);
  });

  it('ingest API keys can run tests and send data but not delete or administer', () => {
    expect(API_KEY_SCOPES.ingest).toEqual(expect.arrayContaining(['INGEST_METRICS', 'EXECUTE_TEST', 'UPLOAD_ARTIFACT']));
    for (const scope of Object.values(API_KEY_SCOPES)) {
      expect(scope.some((p) => p.startsWith('DELETE_') || p.startsWith('MANAGE_'))).toBe(false);
    }
    expect(API_KEY_SCOPES.read).not.toContain('INGEST_METRICS');
  });
});

describe('storage key safety', () => {
  it('accepts normal relative keys', () => {
    for (const k of ['runs/abc/report.html', 'a', 'a/b.c/d-e_f', 'reports/x/..hidden']) expect(() => assertSafeKey(k)).not.toThrow();
  });

  it('blocks traversal, absolute paths, backslashes, NULs, empty segments and huge keys', () => {
    for (const k of ['', '../etc/passwd', 'a/../../b', 'a/./b', 'a/..', '/abs/path', 'a\\b', '..\\..\\win', 'a\0b', 'a//b', 'a/', 'x'.repeat(1025)]) {
      expect(() => assertSafeKey(k), JSON.stringify(k)).toThrow(/unsafe storage key/);
    }
  });

  it('safeFileName reduces user names to one safe segment', () => {
    expect(safeFileName('report.html')).toBe('report.html');
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\Users\\me\\results.jtl')).toBe('results.jtl');
    expect(safeFileName('..')).toBe('file');
    expect(safeFileName('.htaccess')).toBe('htaccess');
    expect(safeFileName('my report (final).zip')).toBe('my_report_final_.zip');
    expect(safeFileName('dir/')).toBe('file');
    expect(safeFileName('a'.repeat(300))).toHaveLength(180);
    for (const n of ['../x', 'a/b/../c', '..\\..\\x', '\0']) {
      const out = safeFileName(n);
      expect(() => assertSafeKey(`artifacts/${out}`)).not.toThrow();
    }
  });
});

describe('endpoint normalisation', () => {
  it('collapses dynamic segments to {id}', () => {
    expect(normalizeSegment('12345')).toBe('{id}');
    expect(normalizeSegment('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe('{id}');
    expect(normalizeSegment('user%40example.com')).toBe('{id}');
    expect(normalizeSegment('TXN-0001234')).toBe('{id}');
    expect(normalizeSegment('2024-01-02')).toBe('{id}');
    expect(normalizeSegment('{orderId}')).toBe('{orderId}');
    expect(normalizeSegment('merchant')).toBe('merchant');
    expect(normalizeSegment('v1')).toBe('v1');
  });

  it('normalises full URLs, strips query/fragment and trailing slashes', () => {
    expect(normalizePath('https://shop.test/api/v1/merchant/12345/?x=1#y')).toBe('/api/v1/merchant/{id}');
    expect(normalizePath('api/orders/987')).toBe('/api/orders/{id}');
    expect(normalizePath('/')).toBe('/');
  });

  it('infers method + path from the URL column or "METHOD /path" labels', () => {
    expect(inferEndpoint('POST /api/pay', 'https://x/api/pay/55')).toEqual({ method: 'POST', path: '/api/pay/{id}' });
    expect(inferEndpoint('Login', 'https://x/login', 'put')).toEqual({ method: 'PUT', path: '/login' });
    expect(inferEndpoint('get /api/items/7')).toEqual({ method: 'GET', path: '/api/items/{id}' });
    expect(inferEndpoint('Login page')).toBeNull();
    expect(inferEndpoint('Login page', 'not a url')).toBeNull();
  });
});

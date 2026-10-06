import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

let keyCache: Buffer | null = null;
function key(): Buffer {
  // Derive a 256-bit key from ENCRYPTION_KEY (any length) with a fixed, app-specific salt.
  if (!keyCache) keyCache = scryptSync(config.encryptionKey, 'perfmon.secret-store.v1', 32);
  return keyCache;
}

/** AES-256-GCM. Output: base64(iv[12] | tag[16] | ciphertext). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decryptSecret(blob: string): string {
  const buf = Buffer.from(blob, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** API key format: pmk_<8 char prefix>_<32 byte secret>. Only the sha256 is stored. */
export function generateApiKey() {
  const prefix = 'pmk_' + randomBytes(4).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  const full = `${prefix}_${secret}`;
  return { prefix, full, hash: sha256(full) };
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Mask a secret for display: "abcd••••••wxyz". */
export function mask(value: string | null | undefined) {
  if (!value) return value ?? null;
  if (value.length <= 8) return '••••••••';
  return value.slice(0, 2) + '••••••••' + value.slice(-2);
}

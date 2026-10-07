import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { audit } from '../audit/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { ApiError, badRequest, unauthorized } from '../lib/errors.js';
import { typed, z } from '../lib/http.js';
import { markRevoked, principalOf, signToken, invalidateUserCache } from './principal.js';
import { sendEmail } from '../alerts/email.js';

const PASSWORD_RULE = z.string().min(8, 'Password must be at least 8 characters').max(200)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Password must contain letters and digits');

export async function authRoutes(app: FastifyInstance) {
  const r = typed(app);

  r.post('/auth/login', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { tags: ['Auth'], summary: 'Log in with email/password and receive a JWT', security: [], body: z.object({ email: z.string().email(), password: z.string().min(1), remember: z.boolean().optional() }) },
  }, async (req) => {
    const { email, password, remember } = req.body;
    const u = await one(`SELECT * FROM users WHERE lower(email) = lower($1)`, [email]);
    const fail = async (reason: string) => {
      await audit(req, { action: 'auth.login', resourceType: 'user', resourceId: u?.id, result: 'FAILURE', details: { email, reason } });
      throw unauthorized('Invalid email or password');
    };
    if (!u || !u.is_active) return fail('unknown_or_inactive');
    if (u.locked_until && new Date(u.locked_until) > new Date()) throw new ApiError(423, 'ACCOUNT_LOCKED', 'Account temporarily locked after repeated failed logins. Try again later.');
    if (!(await bcrypt.compare(password, u.password_hash))) {
      await query(`UPDATE users SET failed_login_count = failed_login_count + 1,
        locked_until = CASE WHEN failed_login_count + 1 >= 10 THEN now() + interval '15 minutes' ELSE locked_until END WHERE id = $1`, [u.id]);
      return fail('bad_password');
    }
    await query(`UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [u.id]);
    // Transparently re-hash older, slower hashes (cost > 10) to keep logins fast.
    if (bcrypt.getRounds(u.password_hash) > 10) query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [u.id, await bcrypt.hash(password, 10)]).catch(() => undefined);
    const { token, expiresAt } = signToken(u.id, u.organization_id, remember);
    req.principal = { kind: 'user', id: u.id, orgId: u.organization_id, email: u.email, name: u.name, roles: [], permissions: new Set() };
    await audit(req, { action: 'auth.login', resourceType: 'user', resourceId: u.id });
    return { token, expiresAt, user: await currentUser(u.id) };
  });

  // "Continue with Google": verifies a Google Identity Services ID token and signs in the
  // EXISTING Perfmon user with that (verified) email. Accounts are never created this way —
  // administrators invite users first (Administration → Users).
  r.post('/auth/google', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { tags: ['Auth'], summary: 'Sign in with a Google ID token (GOOGLE_CLIENT_ID must be configured)', security: [], body: z.object({ credential: z.string().min(20).max(4096), remember: z.boolean().optional() }) },
  }, async (req) => {
    if (!config.googleClientId) throw new ApiError(404, 'NOT_CONFIGURED', 'Google sign-in is not configured on this server');
    let claims: { aud?: string; email?: string; email_verified?: string | boolean; exp?: string; iss?: string };
    try {
      const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(req.body.credential)}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`tokeninfo ${res.status}`);
      claims = await res.json();
    } catch {
      throw unauthorized('Google sign-in could not be verified. Please try again.');
    }
    const verified = claims.email_verified === true || claims.email_verified === 'true';
    const issuerOk = claims.iss === 'accounts.google.com' || claims.iss === 'https://accounts.google.com';
    if (claims.aud !== config.googleClientId || !issuerOk || !verified || !claims.email || Number(claims.exp) * 1000 < Date.now()) {
      throw unauthorized('Google sign-in could not be verified. Please try again.');
    }
    const u = await one(`SELECT * FROM users WHERE lower(email) = lower($1)`, [claims.email]);
    if (!u || !u.is_active) {
      await audit(req, { action: 'auth.login_google', resourceType: 'user', resourceId: u?.id, result: 'FAILURE', details: { email: claims.email, reason: 'no_account' } });
      throw new ApiError(403, 'NO_ACCOUNT', `There is no active Perfmon account for ${claims.email}. Ask an administrator to invite you.`);
    }
    await query(`UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [u.id]);
    const { token, expiresAt } = signToken(u.id, u.organization_id, req.body.remember);
    req.principal = { kind: 'user', id: u.id, orgId: u.organization_id, email: u.email, name: u.name, roles: [], permissions: new Set() };
    await audit(req, { action: 'auth.login_google', resourceType: 'user', resourceId: u.id });
    return { token, expiresAt, user: await currentUser(u.id) };
  });

  r.get('/auth/config', { schema: { tags: ['Auth'], summary: 'Public sign-in configuration (demo hint when SHOW_DEMO_CREDENTIALS=true)', security: [] } }, async () => ({
    demo: config.showDemoCredentials && config.demoAdminPassword ? { email: config.demoAdminEmail, password: config.demoAdminPassword } : null,
    passwordResetEnabled: true,
    googleClientId: config.googleClientId || null,
  }));

  r.post('/auth/logout', { schema: { tags: ['Auth'], summary: 'Revoke the current token' } }, async (req) => {
    const p = principalOf(req);
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const decoded = token ? (jwt.decode(token) as { jti?: string; exp?: number } | null) : null;
    if (decoded?.jti) {
      await query(`INSERT INTO revoked_tokens (jti, user_id, expires_at) VALUES ($1,$2,to_timestamp($3)) ON CONFLICT DO NOTHING`, [decoded.jti, p.id, decoded.exp]);
      markRevoked(decoded.jti);
    }
    await audit(req, { action: 'auth.logout', resourceType: 'user', resourceId: p.id });
    return { ok: true };
  });

  r.get('/auth/me', { schema: { tags: ['Auth'], summary: 'Current user, roles and permissions' } }, async (req) => {
    const p = principalOf(req);
    if (p.kind !== 'user') return { kind: 'api_key', name: p.name, permissions: [...p.permissions] };
    return currentUser(p.id);
  });

  r.patch('/auth/me', { schema: { tags: ['Auth'], summary: 'Update profile / preferred stakeholder view', body: z.object({ name: z.string().min(1).max(120).optional(), preferredView: z.enum(['PERFORMANCE_ENGINEER', 'QA', 'DEVELOPER', 'SRE', 'ARCHITECT', 'MANAGER']).optional() }) } }, async (req) => {
    const p = principalOf(req);
    await query(`UPDATE users SET name = COALESCE($2, name), preferred_view = COALESCE($3, preferred_view), updated_at = now() WHERE id = $1`, [p.id, req.body.name ?? null, req.body.preferredView ?? null]);
    invalidateUserCache(p.id);
    return currentUser(p.id);
  });

  r.post('/auth/change-password', { schema: { tags: ['Auth'], summary: 'Change own password', body: z.object({ currentPassword: z.string(), newPassword: PASSWORD_RULE }) } }, async (req) => {
    const p = principalOf(req);
    const u = await one(`SELECT password_hash FROM users WHERE id = $1`, [p.id]);
    if (!u || !(await bcrypt.compare(req.body.currentPassword, u.password_hash))) throw badRequest('Current password is incorrect');
    await query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, [p.id, await bcrypt.hash(req.body.newPassword, 10)]);
    await audit(req, { action: 'auth.change_password', resourceType: 'user', resourceId: p.id });
    return { ok: true };
  });

  r.post('/auth/forgot-password', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: { tags: ['Auth'], summary: 'Request a password reset link (always returns 200)', security: [], body: z.object({ email: z.string().email() }) },
  }, async (req) => {
    const u = await one(`SELECT id, email, name FROM users WHERE lower(email) = lower($1) AND is_active`, [req.body.email]);
    if (u) {
      const token = randomToken(32);
      await query(`UPDATE users SET password_reset_token_hash = $2, password_reset_expires_at = now() + interval '30 minutes' WHERE id = $1`, [u.id, sha256(token)]);
      const link = `${config.publicUrl.replace(/\/$/, '')}/reset-password?token=${token}`;
      const sent = await sendEmail(u.email, 'Perfmon password reset', `Hello ${u.name},\n\nReset your Perfmon password using this link (valid 30 minutes):\n${link}\n\nIf you did not request this, ignore this email.`);
      if (!sent) req.log.warn(`[auth] SMTP not configured — password reset link for ${u.email}: ${link}`);
      await audit(req, { action: 'auth.forgot_password', resourceType: 'user', resourceId: u.id });
    }
    return { ok: true, message: 'If the account exists, a reset link has been sent.' };
  });

  r.post('/auth/reset-password', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['Auth'], summary: 'Reset password using a reset token', security: [], body: z.object({ token: z.string().min(10), password: PASSWORD_RULE }) },
  }, async (req) => {
    const u = await one(`SELECT id FROM users WHERE password_reset_token_hash = $1 AND password_reset_expires_at > now()`, [sha256(req.body.token)]);
    if (!u) throw badRequest('Reset link is invalid or has expired');
    await query(`UPDATE users SET password_hash = $2, password_reset_token_hash = NULL, password_reset_expires_at = NULL, failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1`, [u.id, await bcrypt.hash(req.body.password, 10)]);
    await audit(null, { action: 'auth.reset_password', resourceType: 'user', resourceId: u.id });
    return { ok: true };
  });
}

export async function currentUser(userId: string) {
  const u = await one(`SELECT u.id, u.email, u.name, u.organization_id, u.preferred_view, u.last_login_at, o.name AS organization_name
                       FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.id = $1`, [userId]);
  const rows = await query(`SELECT r.name AS role, p.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id
     LEFT JOIN role_permissions rp ON rp.role_id = r.id LEFT JOIN permissions p ON p.id = rp.permission_id WHERE ur.user_id = $1`, [userId]);
  return {
    id: u.id, email: u.email, name: u.name, organizationId: u.organization_id, organizationName: u.organization_name,
    preferredView: u.preferred_view, lastLoginAt: u.last_login_at,
    roles: [...new Set(rows.map((r) => r.role))],
    permissions: [...new Set(rows.map((r) => r.code).filter(Boolean))].sort(),
  };
}

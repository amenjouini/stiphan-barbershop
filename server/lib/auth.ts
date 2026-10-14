import crypto from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { config } from '../config.ts';
import { get, run } from '../db.ts';
import { HttpError, forbidden } from './http.ts';

export interface AuthUser {
  id: number;
  role: 'owner' | 'barber' | 'customer';
  name: string;
  email: string;
  phone: string | null;
  barberId: number | null;
  customerId: number | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const COOKIE = 'cb_session';
const SESSION_DAYS = 30;

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export function createSession(res: Response, userId: number) {
  const token = randomToken();
  const now = Date.now();
  const expires = now + SESSION_DAYS * 86_400_000;
  run('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', sha256(token), userId, expires, now);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, expires: new Date(expires), path: '/' });
}

export function destroySession(req: Request, res: Response) {
  const token = readCookie(req, COOKIE);
  if (token) run('DELETE FROM sessions WHERE id = ?', sha256(token));
  res.clearCookie(COOKIE, { path: '/' });
}

export function destroyUserSessions(userId: number) {
  run('DELETE FROM sessions WHERE user_id = ?', userId);
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function loadAuthUser(userId: number): AuthUser | undefined {
  const u = get<any>(
    `SELECT u.id, u.role, u.name, u.email, u.phone, u.is_active, b.id AS barber_id, b.is_active AS barber_active, c.id AS customer_id
     FROM users u LEFT JOIN barbers b ON b.user_id = u.id LEFT JOIN customers c ON c.user_id = u.id WHERE u.id = ?`,
    userId,
  );
  if (!u || !u.is_active) return undefined;
  // A deactivated barber loses staff access even if the user row is still active.
  if (u.role === 'barber' && !u.barber_active) return undefined;
  return { id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone, barberId: u.barber_id ?? null, customerId: u.customer_id ?? null };
}

/** Attaches req.user when a valid session cookie is present. */
export const sessionMiddleware: RequestHandler = (req, _res, next) => {
  const token = readCookie(req, COOKIE);
  if (token) {
    const s = get<{ user_id: number; expires_at: number }>('SELECT user_id, expires_at FROM sessions WHERE id = ?', sha256(token));
    if (s && s.expires_at > Date.now()) req.user = loadAuthUser(s.user_id);
  }
  next();
};

/**
 * CSRF protection for cookie auth: every state-changing request must carry a
 * custom header (which browsers refuse to send cross-site without CORS) and,
 * when an Origin header is present, it must match this site.
 */
export const csrfMiddleware: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-requested-with'] !== 'clubbarber') return next(new HttpError(403, 'CSRF', 'Request blocked.'));
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {
      /* invalid origin */
    }
    if (host !== req.headers.host && origin !== new URL(config.appUrl).origin) return next(new HttpError(403, 'CSRF', 'Request blocked.'));
  }
  next();
};

export const requireAuth: RequestHandler = (req, _res, next) =>
  next(req.user ? undefined : new HttpError(401, 'UNAUTHENTICATED', 'Please sign in to continue.'));

export const requireRole = (...roles: AuthUser['role'][]): RequestHandler => (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'UNAUTHENTICATED', 'Please sign in to continue.'));
  if (!roles.includes(req.user.role)) return next(forbidden());
  next();
};

// ---- One-time codes (6 digits) and link tokens ----

type Purpose = 'verify_email' | 'guest_booking' | 'invite' | 'reset';

export function issueCode(purpose: Purpose, email: string, userId: number | null = null, ttlMin = 15): string {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const now = Date.now();
  run('UPDATE auth_tokens SET used_at = ? WHERE purpose = ? AND email = ? AND used_at IS NULL', now, purpose, email);
  run('INSERT INTO auth_tokens (purpose, email, user_id, secret_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    purpose, email, userId, sha256(`${email.toLowerCase()}:${code}`), now + ttlMin * 60_000, now);
  return code;
}

/** Checks a 6-digit code. Consumes it on success; locks after 5 wrong attempts. */
export function checkCode(purpose: Purpose, email: string, code: string, consume = true): boolean {
  const now = Date.now();
  const t = get<any>('SELECT * FROM auth_tokens WHERE purpose = ? AND email = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1', purpose, email);
  if (!t || t.expires_at < now || t.attempts >= 5) return false;
  if (t.secret_hash !== sha256(`${email.toLowerCase()}:${String(code).trim()}`)) {
    run('UPDATE auth_tokens SET attempts = attempts + 1 WHERE id = ?', t.id);
    return false;
  }
  if (consume) run('UPDATE auth_tokens SET used_at = ? WHERE id = ?', now, t.id);
  return true;
}

export function issueLinkToken(purpose: Purpose, email: string, userId: number, ttlHours: number): string {
  const token = randomToken();
  const now = Date.now();
  run('UPDATE auth_tokens SET used_at = ? WHERE purpose = ? AND user_id = ? AND used_at IS NULL', now, purpose, userId);
  run('INSERT INTO auth_tokens (purpose, email, user_id, secret_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    purpose, email, userId, sha256(token), now + ttlHours * 3_600_000, now);
  return token;
}

export function findLinkToken(purpose: Purpose, token: string) {
  const t = get<any>('SELECT * FROM auth_tokens WHERE purpose = ? AND secret_hash = ? AND used_at IS NULL', purpose, sha256(token));
  return t && t.expires_at > Date.now() ? (t as { id: number; user_id: number; email: string }) : null;
}

export const consumeToken = (id: number) => run('UPDATE auth_tokens SET used_at = ? WHERE id = ?', Date.now(), id);

export function audit(actor: AuthUser | number | null | undefined, action: string, entity: string, entityId: string | number | null, details?: unknown) {
  const actorId = typeof actor === 'number' ? actor : actor?.id ?? null;
  run('INSERT INTO audit_log (actor_user_id, action, entity, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    actorId, action, entity, entityId == null ? null : String(entityId), details === undefined ? null : JSON.stringify(details), Date.now());
}

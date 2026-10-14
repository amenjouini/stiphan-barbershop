import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.ts';
import { get, run, tx } from '../db.ts';
import {
  audit, checkCode, consumeToken, createSession, destroySession, destroyUserSessions, findLinkToken, hashPassword, issueCode,
  issueLinkToken, loadAuthUser, requireAuth, verifyPassword,
} from '../lib/auth.ts';
import { bad, conflict, h, HttpError, parse, rateLimit, zEmail, zName, zPassword, zPhone } from '../lib/http.ts';
import { resolveCustomer } from '../services/appointments.ts';
import { codeEmail, enqueue, linkEmail } from '../services/notifications.ts';
import { canVerifyEmail, devHint, zLang } from './public.ts';

export const authRouter = Router();

const authLimiter = rateLimit({ name: 'auth', windowMs: 10 * 60_000, max: 30 });

function sendVerification(email: string, userId: number, lang?: string) {
  const code = issueCode('verify_email', email, userId);
  enqueue('verify_email', codeEmail(email, code, 'verify', lang));
  return devHint(code);
}

/** Marks the user verified, links (or creates) their customer record and signs them in. */
function completeSignup(res: any, userId: number) {
  const u = get<any>('SELECT * FROM users WHERE id = ?', userId)!;
  tx(() => {
    run('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?', Date.now(), userId);
    if (u.role === 'customer') resolveCustomer({ userId, name: u.name, email: u.email, phone: u.phone });
  });
  createSession(res, userId);
  return { user: loadAuthUser(userId) };
}

authRouter.get('/me', h((req) => ({ user: req.user ?? null })));

authRouter.post('/register', authLimiter, h((req, res) => {
  const body = parse(z.object({ name: zName, email: zEmail, phone: zPhone, password: zPassword, lang: zLang }), req.body);
  const existing = get<any>('SELECT id, email_verified_at, role FROM users WHERE email = ?', body.email);
  if (existing && (existing.email_verified_at || existing.role !== 'customer')) {
    throw conflict('An account with this email already exists. Try signing in instead.', 'EMAIL_TAKEN');
  }
  const hash = hashPassword(body.password);
  const userId = existing
    ? (run('UPDATE users SET name = ?, phone = ?, password_hash = ? WHERE id = ?', body.name, body.phone, hash, existing.id), existing.id as number)
    : run("INSERT INTO users (email, password_hash, role, name, phone, created_at) VALUES (?, ?, 'customer', ?, ?, ?)", body.email, hash, body.name, body.phone, Date.now()).id;
  if (!canVerifyEmail()) return completeSignup(res, userId);
  return { needsVerification: true, email: body.email, devCode: sendVerification(body.email, userId, body.lang) };
}));

authRouter.post('/verify', authLimiter, h((req, res) => {
  const { email, code } = parse(z.object({ email: zEmail, code: z.string().trim().min(4).max(10) }), req.body);
  const u = get<any>('SELECT id FROM users WHERE email = ?', email);
  if (!u || !checkCode('verify_email', email, code)) throw new HttpError(400, 'CODE_INVALID', 'That code is not valid or has expired.');
  return completeSignup(res, u.id);
}));

authRouter.post('/resend', authLimiter, h((req) => {
  const { email, lang } = parse(z.object({ email: zEmail, lang: zLang }), req.body);
  const u = get<any>('SELECT id, email_verified_at FROM users WHERE email = ?', email);
  return { sent: true, devCode: u && !u.email_verified_at ? sendVerification(email, u.id, lang) : undefined };
}));

authRouter.post('/login', authLimiter, h((req, res) => {
  const { email, password } = parse(z.object({ email: zEmail, password: z.string().min(1).max(200) }), req.body);
  const u = get<any>('SELECT id, password_hash, is_active, email_verified_at, role FROM users WHERE email = ?', email);
  // Same message for unknown email and wrong password.
  if (!u || !verifyPassword(password, u.password_hash)) throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  if (!u.is_active || !loadAuthUser(u.id)) throw new HttpError(403, 'DISABLED', 'This account has been deactivated. Please contact the shop.');
  if (!u.email_verified_at && u.role === 'customer' && canVerifyEmail()) {
    throw new HttpError(403, 'NEEDS_VERIFICATION', 'Please confirm your email address to finish signing in.', { email, devCode: sendVerification(email, u.id) });
  }
  createSession(res, u.id);
  return { user: loadAuthUser(u.id) };
}));

authRouter.post('/logout', h((req, res) => {
  destroySession(req, res);
  return { ok: true };
}));

authRouter.post('/forgot', authLimiter, h((req) => {
  const { email } = parse(z.object({ email: zEmail }), req.body);
  const u = get<any>('SELECT id, name, is_active FROM users WHERE email = ?', email);
  let devLink: string | undefined;
  if (u?.is_active) {
    const url = `${config.appUrl}/reset/${issueLinkToken('reset', email, u.id, 2)}`;
    enqueue('password_reset', linkEmail(email, 'reset', url, u.name));
    devLink = devHint(url);
  }
  // Never reveals whether the address has an account.
  return { sent: true, devLink };
}));

function setPasswordFromToken(purpose: 'reset' | 'invite', body: unknown, res: any) {
  const { token, password } = parse(z.object({ token: z.string().min(10).max(200), password: zPassword }), body);
  const t = findLinkToken(purpose, token);
  if (!t) throw new HttpError(400, 'TOKEN_INVALID', 'This link is no longer valid. Please request a new one.');
  tx(() => {
    run('UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?', hashPassword(password), Date.now(), t.user_id);
    consumeToken(t.id);
    destroyUserSessions(t.user_id);
    audit(t.user_id, `auth.${purpose}`, 'user', t.user_id);
  });
  if (!loadAuthUser(t.user_id)) throw new HttpError(403, 'DISABLED', 'This account has been deactivated.');
  createSession(res, t.user_id);
  return { user: loadAuthUser(t.user_id) };
}

authRouter.post('/reset', authLimiter, h((req, res) => setPasswordFromToken('reset', req.body, res)));
authRouter.post('/invite/accept', authLimiter, h((req, res) => setPasswordFromToken('invite', req.body, res)));

authRouter.get('/invite/:token', authLimiter, h((req) => {
  const t = findLinkToken('invite', req.params.token);
  if (!t) throw new HttpError(400, 'TOKEN_INVALID', 'This invitation is no longer valid. Ask the owner to send a new one.');
  const u = get<any>('SELECT name, email FROM users WHERE id = ?', t.user_id);
  return { name: u.name, email: u.email };
}));

authRouter.patch('/profile', requireAuth, h((req) => {
  const body = parse(z.object({ name: zName, phone: zPhone.or(z.literal('')) }), req.body);
  const u = req.user!;
  tx(() => {
    run('UPDATE users SET name = ?, phone = ? WHERE id = ?', body.name, body.phone || null, u.id);
    if (u.customerId) run('UPDATE customers SET name = ?, phone = ? WHERE id = ?', body.name, body.phone || null, u.customerId);
  });
  return { user: loadAuthUser(u.id) };
}));

authRouter.post('/password', requireAuth, authLimiter, h((req) => {
  const body = parse(z.object({ current: z.string().min(1).max(200), next: zPassword }), req.body);
  const row = get<any>('SELECT password_hash FROM users WHERE id = ?', req.user!.id);
  if (!verifyPassword(body.current, row.password_hash)) throw bad('Your current password is incorrect.');
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(body.next), req.user!.id);
  audit(req.user, 'auth.password_change', 'user', req.user!.id);
  return { ok: true };
}));

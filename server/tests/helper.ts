// Test harness: in-memory database, real HTTP against the real Express app.
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH ??= ':memory:';
process.env.SMTP_HOST = '';

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const { createApp } = await import('../app.ts');
const db = await import('../db.ts');
const { hashPassword } = await import('../lib/auth.ts');
const { getSettings, saveSettings } = await import('../lib/settings.ts');
const { createOwner, ensureDefaults } = await import('../setup.ts');
const { setCompensationRule } = await import('../services/finance.ts');
const time = await import('../../shared/time.ts');

export { db, getSettings, saveSettings, time };

let server: Server;
let base = '';

export async function start() {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ensureDefaults();
}

export async function stop() {
  await new Promise((r) => server.close(r));
  db.closeDb();
}

export interface Res<T = any> { status: number; body: T }

/** A browser-like client with its own cookie jar. */
export function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> => {
    const res = await fetch(base + '/api' + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-requested-with': 'clubbarber', ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) if (c.startsWith('cb_session=')) cookie = c.split(';')[0];
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* csv etc. */ }
    return { status: res.status, body: parsed };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b: unknown = {}, hdr?: Record<string, string>) => call('POST', p, b, hdr),
    patch: (p: string, b: unknown = {}) => call('PATCH', p, b),
    put: (p: string, b: unknown = {}) => call('PUT', p, b),
    del: (p: string) => call('DELETE', p),
    raw: call,
    login: async (email: string, password = 'Password#1') => {
      const r = await call('POST', '/auth/login', { email, password });
      if (r.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`);
      return r.body.user;
    },
  };
}

export const T = 1000;
let keySeq = 0;
export const key = () => `test-key-${Date.now()}-${++keySeq}`;

/** Minimal shop: owner (also a barber), two barbers with logins, three services, Mon-Sat 09-18 with a 13-14 break. */
export function fixture() {
  const now = Date.now();
  const svc = (name: string, price: number, duration: number) =>
    db.run('INSERT INTO services (name, price_minor, duration_min, created_at) VALUES (?, ?, ?, ?)', name, price * T, duration, now).id;
  const services = { cut: svc('Haircut', 25, 30), beard: svc('Beard', 15, 20), shave: svc('Shave', 28, 30) };
  const owner = createOwner({ email: 'owner@test.dev', password: 'Password#1', name: 'Olive Owner' });
  const mk = (name: string, email: string, serviceIds: number[]) => {
    const userId = db.run("INSERT INTO users (email, password_hash, role, name, email_verified_at, created_at) VALUES (?, ?, 'barber', ?, ?, ?)", email, hashPassword('Password#1'), name, now, now).id;
    const id = db.run('INSERT INTO barbers (user_id, name, email, sort_order, created_at) VALUES (?, ?, ?, ?, ?)', userId, name, email, 5, now).id;
    for (const s of serviceIds) db.run('INSERT INTO barber_services (barber_id, service_id) VALUES (?, ?)', id, s);
    return { id, userId };
  };
  const b1 = mk('Ben Barber', 'ben@test.dev', [services.cut, services.beard, services.shave]);
  const b2 = mk('Cal Barber', 'cal@test.dev', [services.cut, services.beard]);
  db.run('DELETE FROM working_hours');
  for (const id of [owner.barberId, b1.id, b2.id]) {
    for (let wd = 1; wd <= 6; wd++) {
      db.run('INSERT INTO working_hours (barber_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?)', id, wd, 9 * 60, 18 * 60);
      db.run('INSERT INTO breaks (barber_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?)', id, wd, 13 * 60, 14 * 60);
    }
  }
  const past = now - 90 * 86_400_000;
  setCompensationRule(b1.id, { model: 'commission', basis: 'completed', commission_bps: 4500, fixed_minor: 0, salary_minor: 0 }, null);
  setCompensationRule(b2.id, { model: 'commission', basis: 'paid', commission_bps: 4000, fixed_minor: 0, salary_minor: 0 }, null);
  db.getDb().exec(`UPDATE compensation_rules SET effective_from = ${past}`);
  const custUser = db.run("INSERT INTO users (email, password_hash, role, name, phone, email_verified_at, created_at) VALUES ('cust@test.dev', ?, 'customer', 'Cora Customer', '+216 50 000 001', ?, ?)", hashPassword('Password#1'), now, now).id;
  const customer = db.run("INSERT INTO customers (user_id, name, email, phone, created_at) VALUES (?, 'Cora Customer', 'cust@test.dev', '+216 50 000 001', ?)", custUser, now).id;
  const otherUser = db.run("INSERT INTO users (email, password_hash, role, name, phone, email_verified_at, created_at) VALUES ('other@test.dev', ?, 'customer', 'Otto Other', '+216 50 000 002', ?, ?)", hashPassword('Password#1'), now, now).id;
  const other = db.run("INSERT INTO customers (user_id, name, email, phone, created_at) VALUES (?, 'Otto Other', 'other@test.dev', '+216 50 000 002', ?)", otherUser, now).id;
  return { services, owner, b1, b2, customer, other };
}

/** A local date at least `minAhead` days from today that falls on `weekday` (0 = Sunday). */
export function nextWeekday(weekday: number, minAhead = 2): string {
  const tz = getSettings().timezone;
  let d = time.addDays(time.today(tz), minAhead);
  while (time.weekdayOf(d) !== weekday) d = time.addDays(d, 1);
  return d;
}

export const at = (date: string, hhmm: string) => time.zonedToUtc(date, time.parseMinutes(hhmm)!, getSettings().timezone);

/** Books as a guest through the public API, including the email code step. */
export async function guestBook(c: ReturnType<typeof client>, input: { serviceIds: number[]; barber: number | 'any'; start: number; email?: string; name?: string }) {
  const email = input.email ?? `guest${++keySeq}@test.dev`;
  const code = await c.post('/public/booking/request-code', { email });
  return c.post('/public/bookings', { serviceIds: input.serviceIds, barber: input.barber, start: input.start, name: input.name ?? 'Gus Guest', email, phone: '+216 55 555 555', code: code.body.devCode });
}

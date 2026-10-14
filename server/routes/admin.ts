import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { config, emailConfigured } from '../config.ts';
import { all, get, run, tx } from '../db.ts';
import { audit, destroyUserSessions, issueLinkToken, requireRole } from '../lib/auth.ts';
import { bad, conflict, h, idParam, notFound, parse, zDate, zEmail, zMinor, zName, zPhone, zText } from '../lib/http.ts';
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../lib/settings.ts';
import { COMP_BASES, COMP_MODELS, METHODS } from '../../shared/constants.ts';
import { fromMinor } from '../../shared/money.ts';
import { addDays, fmtDateTime, startOfMonth, today, zonedToUtc } from '../../shared/time.ts';
import {
  addManualEarning, barberLedger, buildReport, customerStats, rangeOf, recordPayout, recordRefund, setCompensationRule, voidPayment, voidPayout,
} from '../services/finance.ts';
import { enqueue, linkEmail, retryNotification } from '../services/notifications.ts';
import { appointmentDetail, listAppointments } from '../services/queries.ts';
import { devHint } from './public.ts';
import { moneySchema } from './staff.ts';

/** Owner-only administration: catalogue, team, customers, accounting, settings. */
export const adminRouter = Router();
adminRouter.use(requireRole('owner'));

const rangeQuery = (req: any) => {
  const tz = getSettings().timezone;
  const q = parse(z.object({ from: zDate.optional(), to: zDate.optional() }), { from: req.query.from, to: req.query.to });
  const to = q.to ?? today(tz);
  const from = q.from ?? startOfMonth(to);
  if (from > to) throw bad('The start date is after the end date.');
  if (addDays(from, 800) < to) throw bad('Please choose a range shorter than two years.');
  return rangeOf(from, to);
};
const page = (req: any, size = 50) => {
  const p = Math.max(1, Number(req.query.page) || 1);
  return { limit: size, offset: (p - 1) * size };
};

// ---------- Overview & reports ----------

adminRouter.get('/overview', h((req) => {
  const s = getSettings();
  const day = today(s.timezone);
  const t = rangeOf(day, day);
  const n = (sql: string, ...p: unknown[]) => get<any>(sql, ...p)!.n as number;
  const todayStatuses = all<any>('SELECT status, COUNT(*) AS n FROM appointments WHERE starts_at >= ? AND starts_at < ? GROUP BY status', t.from, t.to);
  const st = (k: string) => todayStatuses.find((x) => x.status === k)?.n ?? 0;
  return {
    today: {
      date: day,
      appointments: todayStatuses.reduce((a, x) => a + (x.status === 'cancelled' ? 0 : x.n), 0),
      completed: st('completed'), cancelled: st('cancelled'), no_shows: st('no_show'),
      in_chair: st('checked_in') + st('in_progress'),
      collected_minor: n('SELECT COALESCE(SUM(amount_minor), 0) AS n FROM payments WHERE created_at >= ? AND created_at < ?', t.from, t.to),
      pending_approval: n("SELECT COUNT(*) AS n FROM appointments WHERE status = 'pending'"),
    },
    upcoming: n("SELECT COUNT(*) AS n FROM appointments WHERE status IN ('pending','confirmed') AND starts_at > ?", Date.now()),
    report: buildReport(rangeQuery(req)),
    recent: listAppointments({ limit: 400, order: 'desc' }).rows.sort((a, b) => b.created_at - a.created_at).slice(0, 8),
    email: { configured: emailConfigured(), failed: n("SELECT COUNT(*) AS n FROM notifications WHERE status = 'failed'") },
  };
}));

adminRouter.get('/reports', h((req) => buildReport(rangeQuery(req))));

function csv(header: string[], rows: unknown[][]) {
  const cell = (v: unknown) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`; // spreadsheet formula injection guard
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

adminRouter.get('/export/:type', h((req, res) => {
  const r = rangeQuery(req);
  const s = getSettings();
  const m = (v: number) => fromMinor(v, s.currency_decimals);
  const dt = (ms: number | null) => (ms ? fmtDateTime(ms, s.timezone).replace(' · ', ' ') : '');
  let out: string;
  switch (req.params.type) {
    case 'payments':
      out = csv(['Entry', 'Date', 'Type', 'Amount', 'Currency', 'Method', 'Appointment', 'Customer', 'Barber', 'Reference', 'Note', 'Recorded by'],
        all<any>(
          `SELECT p.*, a.reference AS appt_ref, c.name AS customer, b.name AS barber, u.name AS recorded FROM payments p
           JOIN appointments a ON a.id = p.appointment_id JOIN customers c ON c.id = p.customer_id JOIN barbers b ON b.id = a.barber_id
           LEFT JOIN users u ON u.id = p.recorded_by WHERE p.created_at >= ? AND p.created_at < ? ORDER BY p.created_at`, r.from, r.to,
        ).map((p) => [p.public_id, dt(p.created_at), p.kind, m(p.amount_minor), p.currency, p.method, p.appt_ref, p.customer, p.barber, p.reference, p.note, p.recorded]));
      break;
    case 'appointments':
      out = csv(['Reference', 'Start', 'Status', 'Source', 'Customer', 'Phone', 'Barber', 'Services', 'Price', 'Paid', 'Balance', 'Completed at'],
        listAppointments({ from: r.from, to: r.to, limit: 1000 }).rows.map((a) =>
          [a.reference, dt(a.starts_at), a.status, a.source, a.customer_name, a.customer_phone, a.barber_name, a.services, m(a.total_minor), m(a.paid_minor), m(a.balance_minor), dt(a.completed_at)]));
      break;
    case 'payouts':
      out = csv(['Entry', 'Date', 'Barber', 'Amount', 'Currency', 'Method', 'Reference', 'Note'],
        all<any>('SELECT p.*, b.name AS barber FROM payouts p JOIN barbers b ON b.id = p.barber_id WHERE p.paid_at >= ? AND p.paid_at < ? ORDER BY p.paid_at', r.from, r.to)
          .map((p) => [p.public_id, dt(p.paid_at), p.barber, m(p.amount_minor), p.currency, p.method, p.reference, p.note]));
      break;
    case 'summary': {
      const rep = buildReport(r);
      const k = rep.money;
      out = csv(['Metric', 'Value'], [
        ['Period', `${r.fromDate} to ${r.toDate}`], ['Currency', s.currency],
        ['Appointments', rep.appointments.total], ['Completed services', rep.appointments.completed_services],
        ['Cancellation rate %', rep.appointments.cancellation_rate], ['No-show rate %', rep.appointments.no_show_rate],
        ['Service revenue (services performed)', m(k.service_revenue_minor)], ['Payments received', m(k.payments_received_minor)],
        ['Refunds', m(k.refunds_minor)], ['Corrections', m(k.adjustments_minor)], ['Net collected', m(k.net_collected_minor)],
        ['Cash collected', m(k.cash_collected_minor)], ['Non-cash collected', m(k.non_cash_collected_minor)],
        ['Outstanding (services in period)', m(k.outstanding_period_minor)], ['Barber compensation earned', m(k.compensation_earned_minor)],
        ['Barber payouts paid', m(k.payouts_paid_minor)], ['Expenses', m(k.expenses_minor)],
        ['Operating result (revenue - compensation - expenses)', m(k.operating_result_minor)],
        ['Net cash flow (collected - payouts - expenses)', m(k.net_cash_flow_minor)],
        [], ['Barber', 'Completed', 'Revenue', 'Collected', 'Earned', 'Paid out'],
        ...rep.byBarber.map((b) => [b.name, b.completed, m(b.revenue_minor), m(b.collected_minor), m(b.earned_minor), m(b.paid_out_minor)]),
        [], ['Service', 'Count', 'Revenue'], ...rep.byService.map((x) => [x.name, x.count, m(x.revenue_minor)]),
      ]);
      break;
    }
    default:
      throw notFound('Export');
  }
  audit(req.user, 'export', req.params.type, null, { from: r.fromDate, to: r.toDate });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}-${r.fromDate}_${r.toDate}.csv"`);
  res.send(out);
}));

// ---------- Services ----------

const serviceSchema = z.object({
  name: zName, description: zText(600).default(''), category: zText(60).nullable().optional(),
  price_minor: zMinor, duration_min: z.number().int().min(5).max(480), image_url: zText(300).nullable().optional(),
  is_active: z.boolean().default(true), sort_order: z.number().int().min(0).max(9999).default(0),
});

adminRouter.get('/services', h(() => ({
  services: all(`SELECT s.*, (SELECT COUNT(*) FROM appointment_items i WHERE i.service_id = s.id) AS times_booked FROM services s ORDER BY s.is_active DESC, s.sort_order, s.id`),
})));

adminRouter.post('/services', h((req, res) => {
  const b = parse(serviceSchema, req.body);
  const id = tx(() => {
    const sid = run('INSERT INTO services (name, description, category, price_minor, duration_min, image_url, is_active, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      b.name, b.description, b.category || null, b.price_minor, b.duration_min, b.image_url || null, b.is_active, b.sort_order, Date.now()).id;
    // New services are offered by every active barber by default; adjust per barber in Team.
    run('INSERT INTO barber_services (barber_id, service_id) SELECT id, ? FROM barbers WHERE is_active = 1', sid);
    audit(req.user, 'service.create', 'service', sid, b);
    return sid;
  });
  res.status(201);
  return { id };
}));

adminRouter.patch('/services/:id', h((req) => {
  const id = idParam(req);
  const cur = get<any>('SELECT * FROM services WHERE id = ?', id);
  if (!cur) throw notFound('Service');
  const b = parse(serviceSchema.partial(), req.body);
  const next = { ...cur, ...b };
  // Booked appointments keep their own snapshot of name/price, so this never rewrites history.
  run('UPDATE services SET name = ?, description = ?, category = ?, price_minor = ?, duration_min = ?, image_url = ?, is_active = ?, sort_order = ? WHERE id = ?',
    next.name, next.description, next.category || null, next.price_minor, next.duration_min, next.image_url || null, !!next.is_active, next.sort_order, id);
  audit(req.user, 'service.update', 'service', id, b);
  return { ok: true };
}));

adminRouter.delete('/services/:id', h((req) => {
  const id = idParam(req);
  if (!get('SELECT 1 FROM services WHERE id = ?', id)) throw notFound('Service');
  const used = get('SELECT 1 FROM appointment_items WHERE service_id = ? LIMIT 1', id);
  if (used) run('UPDATE services SET is_active = 0 WHERE id = ?', id);
  else run('DELETE FROM services WHERE id = ?', id);
  audit(req.user, used ? 'service.deactivate' : 'service.delete', 'service', id);
  return { ok: true, deactivated: Boolean(used) };
}));

// ---------- Team ----------

function barberRow(b: any) {
  const user = b.user_id ? get<any>('SELECT id, email, role, is_active, password_hash IS NOT NULL AS has_password FROM users WHERE id = ?', b.user_id) : null;
  return {
    ...b,
    service_ids: all<any>('SELECT service_id FROM barber_services WHERE barber_id = ?', b.id).map((x) => x.service_id),
    hours: all('SELECT weekday, start_min, end_min FROM working_hours WHERE barber_id = ? ORDER BY weekday, start_min', b.id),
    breaks: all('SELECT weekday, start_min, end_min FROM breaks WHERE barber_id = ? ORDER BY weekday, start_min', b.id),
    account: user ? { email: user.email, role: user.role, has_password: !!user.has_password, is_active: !!user.is_active } : null,
    rule: get('SELECT * FROM compensation_rules WHERE barber_id = ? ORDER BY effective_from DESC, id DESC LIMIT 1', b.id) ?? null,
    balance: barberLedger(b.id, 1).balance,
    upcoming: get<any>("SELECT COUNT(*) AS n FROM appointments WHERE barber_id = ? AND status IN ('pending','confirmed') AND starts_at > ?", b.id, Date.now())!.n,
  };
}

adminRouter.get('/barbers', h(() => ({ barbers: all<any>('SELECT * FROM barbers ORDER BY is_active DESC, sort_order, id').map(barberRow) })));

adminRouter.get('/barbers/:id', h((req) => {
  const b = get<any>('SELECT * FROM barbers WHERE id = ?', idParam(req));
  if (!b) throw notFound('Barber');
  const tz = getSettings().timezone;
  const month = rangeOf(startOfMonth(today(tz)), today(tz));
  return {
    barber: barberRow(b),
    ledger: barberLedger(b.id),
    rules: all('SELECT r.*, u.name AS created_by_name FROM compensation_rules r LEFT JOIN users u ON u.id = r.created_by WHERE r.barber_id = ? ORDER BY r.effective_from DESC, r.id DESC', b.id),
    performance: buildReport(month).byBarber.find((x) => x.id === b.id) ?? null,
  };
}));

const barberSchema = z.object({
  name: zName, email: zEmail.or(z.literal('')).optional(), phone: zPhone.or(z.literal('')).optional(),
  bio: zText(800).default(''), specialty: zText(120).default(''), photo_url: zText(300).nullable().optional(),
  is_active: z.boolean().default(true), sort_order: z.number().int().min(0).max(9999).default(0),
  service_ids: z.array(z.number().int().positive()).max(200).optional(),
});

function sendInvite(userId: number, email: string, name: string) {
  const url = `${config.appUrl}/invite/${issueLinkToken('invite', email, userId, 72)}`;
  enqueue('staff_invite', linkEmail(email, 'invite', url, name));
  return url;
}

adminRouter.post('/barbers', h((req, res) => {
  const b = parse(barberSchema.extend({ create_login: z.boolean().default(false) }), req.body);
  if (b.create_login && !b.email) throw bad('An email address is required to create a login.');
  if (b.create_login && get('SELECT 1 FROM users WHERE email = ?', b.email)) throw conflict('A user with this email already exists.', 'EMAIL_TAKEN');
  let inviteUrl: string | undefined;
  const id = tx(() => {
    const now = Date.now();
    const userId = b.create_login
      ? run("INSERT INTO users (email, role, name, phone, created_at) VALUES (?, 'barber', ?, ?, ?)", b.email, b.name, b.phone || null, now).id
      : null;
    const bid = run('INSERT INTO barbers (user_id, name, email, phone, bio, specialty, photo_url, is_active, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      userId, b.name, b.email || null, b.phone || null, b.bio, b.specialty, b.photo_url || null, b.is_active, b.sort_order, now).id;
    const serviceIds = b.service_ids ?? all<any>('SELECT id FROM services WHERE is_active = 1').map((x) => x.id);
    for (const sid of serviceIds) run('INSERT OR IGNORE INTO barber_services (barber_id, service_id) VALUES (?, ?)', bid, sid);
    // Sensible starting schedule: the shop's own opening hours.
    run('INSERT INTO working_hours (barber_id, weekday, start_min, end_min) SELECT ?, weekday, open_min, close_min FROM business_hours WHERE is_closed = 0', bid);
    setCompensationRule(bid, { model: 'none', basis: 'completed', commission_bps: 0, fixed_minor: 0, salary_minor: 0, note: 'Initial rule — set compensation in Team' }, null);
    audit(req.user, 'barber.create', 'barber', bid, { name: b.name, create_login: b.create_login });
    if (userId) inviteUrl = sendInvite(userId, b.email!, b.name);
    return bid;
  });
  res.status(201);
  return { id, invite_url: inviteUrl };
}));

adminRouter.patch('/barbers/:id', h((req) => {
  const id = idParam(req);
  const cur = get<any>('SELECT * FROM barbers WHERE id = ?', id);
  if (!cur) throw notFound('Barber');
  const b = parse(barberSchema.partial(), req.body);
  const next = { ...cur, ...b };
  tx(() => {
    run('UPDATE barbers SET name = ?, email = ?, phone = ?, bio = ?, specialty = ?, photo_url = ?, is_active = ?, sort_order = ? WHERE id = ?',
      next.name, next.email || null, next.phone || null, next.bio, next.specialty, next.photo_url || null, !!next.is_active, next.sort_order, id);
    if (cur.user_id && b.name) run('UPDATE users SET name = ? WHERE id = ?', b.name, cur.user_id);
    if (b.service_ids) {
      run('DELETE FROM barber_services WHERE barber_id = ?', id);
      for (const sid of b.service_ids) run('INSERT OR IGNORE INTO barber_services (barber_id, service_id) SELECT ?, id FROM services WHERE id = ?', id, sid);
    }
    // Deactivation keeps every historical record; it only removes the barber from booking and signs them out.
    if (b.is_active === false && cur.is_active && cur.user_id && get<any>('SELECT role FROM users WHERE id = ?', cur.user_id)?.role === 'barber') destroyUserSessions(cur.user_id);
    audit(req.user, b.is_active === false && cur.is_active ? 'barber.deactivate' : 'barber.update', 'barber', id, b);
  });
  return { barber: barberRow(get('SELECT * FROM barbers WHERE id = ?', id)) };
}));

const span = z.object({ weekday: z.number().int().min(0).max(6), start_min: z.number().int().min(0).max(1439), end_min: z.number().int().min(1).max(1440) })
  .refine((v) => v.start_min < v.end_min, 'End time must be after start time');

adminRouter.put('/barbers/:id/schedule', h((req) => {
  const id = idParam(req);
  if (!get('SELECT 1 FROM barbers WHERE id = ?', id)) throw notFound('Barber');
  const b = parse(z.object({ hours: z.array(span).max(28), breaks: z.array(span).max(28) }), req.body);
  tx(() => {
    run('DELETE FROM working_hours WHERE barber_id = ?', id);
    run('DELETE FROM breaks WHERE barber_id = ?', id);
    for (const x of b.hours) run('INSERT INTO working_hours (barber_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?)', id, x.weekday, x.start_min, x.end_min);
    for (const x of b.breaks) run('INSERT INTO breaks (barber_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?)', id, x.weekday, x.start_min, x.end_min);
    audit(req.user, 'barber.schedule', 'barber', id, b);
  });
  return { ok: true };
}));

/** Creates the login if needed and (re)sends the invitation link. Also serves as a staff password reset. */
adminRouter.post('/barbers/:id/invite', h((req) => {
  const id = idParam(req);
  const b = get<any>('SELECT * FROM barbers WHERE id = ?', id);
  if (!b) throw notFound('Barber');
  let userId = b.user_id as number | null;
  const email = userId ? get<any>('SELECT email FROM users WHERE id = ?', userId).email : b.email;
  if (!email) throw bad('Add an email address to this barber first.');
  if (!userId) {
    if (get('SELECT 1 FROM users WHERE email = ?', email)) throw conflict('A user with this email already exists.', 'EMAIL_TAKEN');
    userId = tx(() => {
      const uid = run("INSERT INTO users (email, role, name, phone, created_at) VALUES (?, 'barber', ?, ?, ?)", email, b.name, b.phone, Date.now()).id;
      run('UPDATE barbers SET user_id = ? WHERE id = ?', uid, id);
      return uid;
    });
  }
  const url = sendInvite(userId!, email, b.name);
  audit(req.user, 'barber.invite', 'barber', id);
  return { invite_url: url, emailed: emailConfigured() };
}));

adminRouter.post('/barbers/:id/compensation', h((req) => {
  const id = idParam(req);
  if (!get('SELECT 1 FROM barbers WHERE id = ?', id)) throw notFound('Barber');
  const b = parse(z.object({
    model: z.enum(COMP_MODELS), basis: z.enum(COMP_BASES).default('completed'),
    commission_bps: z.number().int().min(0).max(10000).default(0), fixed_minor: zMinor.default(0), salary_minor: zMinor.default(0),
    note: zText(300).optional(),
  }), req.body);
  // A new rule row is appended; earnings already recorded keep the rule they were calculated with.
  return { rule_id: setCompensationRule(id, b, req.user!) };
}));

adminRouter.post('/barbers/:id/earnings', h((req, res) => {
  const b = parse(z.object({
    kind: z.enum(['salary', 'bonus', 'deduction']), amountMinor: z.number().int().positive().max(1_000_000_000),
    period: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(), note: zText(300).optional(),
  }), req.body);
  res.status(201);
  return addManualEarning(idParam(req), b, req.user!);
}));

adminRouter.post('/barbers/:id/payouts', h((req, res) => {
  const b = parse(moneySchema.extend({ paidDate: zDate.optional() }), req.body);
  const tz = getSettings().timezone;
  const paidAt = b.paidDate && b.paidDate !== today(tz) ? zonedToUtc(b.paidDate, 12 * 60, tz) : undefined;
  if (paidAt && paidAt > Date.now()) throw bad('The payout date cannot be in the future.');
  const r = recordPayout(idParam(req), { ...b, paidAt }, req.user!);
  res.status(r.duplicate ? 200 : 201);
  return { ...r, ledger: barberLedger(idParam(req)) };
}));

adminRouter.post('/payouts/:id/void', h((req) => {
  const { reason } = parse(z.object({ reason: zText(300).min(3, 'Give a short reason') }), req.body);
  return voidPayout(idParam(req), reason, req.user!);
}));

adminRouter.get('/payroll', h(() => {
  const barbers = all<any>('SELECT id, name, photo_url, is_active FROM barbers ORDER BY is_active DESC, sort_order, id').map((b) => {
    const l = barberLedger(b.id, 1);
    return { ...b, ...l.balance, rule: l.rule };
  });
  return {
    barbers,
    totals: barbers.reduce((t, b) => ({ earned_minor: t.earned_minor + b.earned_minor, paid_minor: t.paid_minor + b.paid_minor, owed_minor: t.owed_minor + b.owed_minor }), { earned_minor: 0, paid_minor: 0, owed_minor: 0 }),
  };
}));

// ---------- Customers ----------

adminRouter.get('/customers', h((req) => {
  const q = String(req.query.q ?? '').trim().replace(/[%_]/g, '');
  const filter = String(req.query.filter ?? 'all');
  const like = `%${q}%`;
  const base = `
    SELECT c.id, c.name, c.email, c.phone, c.created_at, c.user_id IS NOT NULL AS has_account,
      (SELECT COUNT(*) FROM appointments a WHERE a.customer_id = c.id AND a.status = 'completed') AS visits,
      (SELECT MAX(a.starts_at) FROM appointments a WHERE a.customer_id = c.id AND a.status = 'completed') AS last_visit,
      (SELECT MIN(a.starts_at) FROM appointments a WHERE a.customer_id = c.id AND a.status IN ('pending','confirmed') AND a.starts_at > ?) AS next_appointment,
      (SELECT COALESCE(SUM(p.amount_minor), 0) FROM payments p WHERE p.customer_id = c.id) AS total_paid_minor,
      (SELECT COALESCE(SUM(MAX(a.total_minor - (SELECT COALESCE(SUM(p.amount_minor), 0) FROM payments p WHERE p.appointment_id = a.id), 0)), 0)
         FROM appointments a WHERE a.customer_id = c.id AND a.status = 'completed') AS outstanding_minor
    FROM customers c WHERE (c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)`;
  const having = filter === 'owing' ? 'WHERE outstanding_minor > 0' : filter === 'upcoming' ? 'WHERE next_appointment IS NOT NULL' : filter === 'new' ? 'WHERE visits = 0' : '';
  const sort = { name: 'name COLLATE NOCASE', recent: 'last_visit DESC', visits: 'visits DESC', paid: 'total_paid_minor DESC', owing: 'outstanding_minor DESC' }[String(req.query.sort ?? 'name')] ?? 'name COLLATE NOCASE';
  const { limit, offset } = page(req, 25);
  const params = [Date.now(), like, like, like];
  return {
    total: get<any>(`SELECT COUNT(*) AS n FROM (${base}) ${having}`, ...params)!.n,
    customers: all(`SELECT * FROM (${base}) ${having} ORDER BY ${sort} LIMIT ? OFFSET ?`, ...params, limit, offset),
    page_size: limit,
  };
}));

adminRouter.get('/customers/:id', h((req) => {
  const id = idParam(req);
  const c = get<any>('SELECT id, name, email, phone, notes, created_at, user_id IS NOT NULL AS has_account FROM customers WHERE id = ?', id);
  if (!c) throw notFound('Customer');
  return {
    customer: c,
    stats: customerStats(id),
    appointments: listAppointments({ customerId: id, order: 'desc', limit: 200 }).rows,
    payments: all(
      `SELECT p.id, p.public_id, p.kind, p.amount_minor, p.method, p.note, p.created_at, a.reference, a.id AS appointment_id
       FROM payments p JOIN appointments a ON a.id = p.appointment_id WHERE p.customer_id = ? ORDER BY p.created_at DESC LIMIT 200`, id),
  };
}));

const customerSchema = z.object({ name: zName, email: zEmail.or(z.literal('')).optional(), phone: zPhone.or(z.literal('')).optional(), notes: zText(3000).optional() });

adminRouter.post('/customers', h((req, res) => {
  const b = parse(customerSchema, req.body);
  if (b.email && get('SELECT 1 FROM customers WHERE email = ?', b.email)) throw conflict('A customer with this email already exists.');
  const id = run('INSERT INTO customers (name, email, phone, notes, created_at) VALUES (?, ?, ?, ?, ?)', b.name, b.email || null, b.phone || null, b.notes ?? '', Date.now()).id;
  audit(req.user, 'customer.create', 'customer', id);
  res.status(201);
  return { id };
}));

adminRouter.patch('/customers/:id', h((req) => {
  const id = idParam(req);
  const cur = get<any>('SELECT * FROM customers WHERE id = ?', id);
  if (!cur) throw notFound('Customer');
  const b = parse(customerSchema.partial(), req.body);
  if (b.email && b.email !== cur.email?.toLowerCase()) {
    if (cur.user_id) throw conflict('This customer has an online account; they must change their email themselves.');
    if (get('SELECT 1 FROM customers WHERE email = ? AND id <> ?', b.email, id)) throw conflict('A customer with this email already exists.');
  }
  const next = { ...cur, ...b };
  run('UPDATE customers SET name = ?, email = ?, phone = ?, notes = ? WHERE id = ?', next.name, next.email || null, next.phone || null, next.notes ?? '', id);
  audit(req.user, 'customer.update', 'customer', id, { fields: Object.keys(b) });
  return { ok: true };
}));

// ---------- Payments ledger ----------

adminRouter.get('/payments', h((req) => {
  const r = rangeQuery(req);
  const where = ['p.created_at >= ?', 'p.created_at < ?'];
  const params: unknown[] = [r.from, r.to];
  if (METHODS.includes(req.query.method as any)) { where.push('p.method = ?'); params.push(req.query.method); }
  if (['payment', 'refund', 'adjustment'].includes(String(req.query.kind))) { where.push('p.kind = ?'); params.push(req.query.kind); }
  const q = String(req.query.q ?? '').trim().replace(/[%_]/g, '');
  if (q) { where.push('(c.name LIKE ? OR a.reference LIKE ? OR p.public_id LIKE ? OR p.reference LIKE ?)'); params.push(...Array(4).fill(`%${q}%`)); }
  const from = `FROM payments p JOIN appointments a ON a.id = p.appointment_id JOIN customers c ON c.id = p.customer_id JOIN barbers b ON b.id = a.barber_id
    LEFT JOIN users u ON u.id = p.recorded_by WHERE ${where.join(' AND ')}`;
  const { limit, offset } = page(req, 50);
  const agg = get<any>(`SELECT COUNT(*) AS n, COALESCE(SUM(p.amount_minor), 0) AS net ${from}`, ...params)!;
  return {
    total: agg.n, net_minor: agg.net, page_size: limit,
    payments: all(
      `SELECT p.id, p.public_id, p.kind, p.amount_minor, p.currency, p.method, p.reference, p.note, p.created_at, p.reverses_payment_id, p.appointment_id,
         a.reference AS appointment_reference, c.id AS customer_id, c.name AS customer_name, b.name AS barber_name, u.name AS recorded_by_name,
         (SELECT v.id FROM payments v WHERE v.reverses_payment_id = p.id) AS voided_by
       ${from} ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`, ...params, limit, offset),
  };
}));

adminRouter.post('/appointments/:id/refund', h((req, res) => {
  const id = idParam(req);
  const r = recordRefund(id, parse(moneySchema, req.body), req.user!);
  res.status(r.duplicate ? 200 : 201);
  return { appointment: appointmentDetail(id), duplicate: r.duplicate };
}));

adminRouter.post('/payments/:id/void', h((req) => {
  const { reason } = parse(z.object({ reason: zText(300).min(3, 'Give a short reason') }), req.body);
  const r = voidPayment(idParam(req), reason, req.user!);
  const p = get<any>('SELECT appointment_id FROM payments WHERE id = ?', r.paymentId);
  return { appointment: appointmentDetail(p.appointment_id) };
}));

// ---------- Expenses ----------

adminRouter.get('/expenses', h((req) => {
  const r = rangeQuery(req);
  const rows = all<any>('SELECT e.*, u.name AS recorded_by_name FROM expenses e LEFT JOIN users u ON u.id = e.recorded_by WHERE e.spent_at >= ? AND e.spent_at < ? ORDER BY e.spent_at DESC, e.id DESC', r.from, r.to);
  return { expenses: rows, total_minor: rows.filter((e) => !e.voided_at).reduce((n, e) => n + e.amount_minor, 0) };
}));

adminRouter.post('/expenses', h((req, res) => {
  const b = parse(z.object({ category: zText(60).min(2), description: zText(300).default(''), amountMinor: z.number().int().positive().max(1_000_000_000), method: z.enum(METHODS), date: zDate }), req.body);
  const s = getSettings();
  if (b.date > today(s.timezone)) throw bad('The expense date cannot be in the future.');
  const id = run('INSERT INTO expenses (category, description, amount_minor, currency, method, spent_at, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    b.category, b.description, b.amountMinor, s.currency, b.method, zonedToUtc(b.date, 12 * 60, s.timezone), req.user!.id, Date.now()).id;
  audit(req.user, 'expense.create', 'expense', id, b);
  res.status(201);
  return { id };
}));

adminRouter.post('/expenses/:id/void', h((req) => {
  const { reason } = parse(z.object({ reason: zText(300).min(3, 'Give a short reason') }), req.body);
  const r = run('UPDATE expenses SET voided_at = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL', Date.now(), reason, idParam(req));
  if (!r.changes) throw conflict('This expense is already voided or does not exist.');
  audit(req.user, 'expense.void', 'expense', idParam(req), { reason });
  return { ok: true };
}));

// ---------- Settings ----------

const settingsSchema = z.object({
  shop_name: zText(80).min(2), tagline: zText(120), about: zText(600), address: zText(160), city: zText(80), phone: zText(40), email: zEmail.or(z.literal('')),
  instagram: zText(120), map_url: zText(400),
  timezone: z.string().refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'Unknown timezone'),
  default_language: z.enum(['fr', 'ar', 'en']),
  currency: z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code'), currency_decimals: z.number().int().min(0).max(3),
  slot_interval_min: z.number().int().refine((v) => [5, 10, 15, 20, 30, 60].includes(v), 'Choose 5, 10, 15, 20, 30 or 60'),
  buffer_min: z.number().int().min(0).max(120), lead_time_min: z.number().int().min(0).max(10080), horizon_days: z.number().int().min(1).max(365),
  auto_confirm: z.boolean(), allow_any_barber: z.boolean(), guest_booking: z.boolean(), guest_email_verification: z.boolean(),
  cancel_min_hours: z.number().int().min(0).max(720), reschedule_min_hours: z.number().int().min(0).max(720), reminder_hours: z.number().int().min(0).max(168),
  barbers_record_payments: z.boolean(), barbers_see_earnings: z.boolean(), owner_notify_email: zEmail.or(z.literal('')),
}).partial();

adminRouter.get('/settings', h(() => ({
  settings: getSettings(),
  defaults: DEFAULT_SETTINGS,
  business_hours: all('SELECT weekday, open_min, close_min, is_closed FROM business_hours ORDER BY weekday'),
  email: { configured: emailConfigured(), host: config.smtp.host || null, from: config.smtp.from || null },
  has_money_history: Boolean(get('SELECT 1 FROM payments LIMIT 1') || get('SELECT 1 FROM appointments LIMIT 1')),
})));

adminRouter.put('/settings', h((req) => {
  const b = parse(settingsSchema, req.body);
  const cur = getSettings();
  // Amounts are stored in minor units of the currency in force; changing it later would silently re-denominate history.
  if ((b.currency && b.currency !== cur.currency || b.currency_decimals != null && b.currency_decimals !== cur.currency_decimals)
    && (get('SELECT 1 FROM appointments LIMIT 1') || get('SELECT 1 FROM payments LIMIT 1'))) {
    throw conflict('The currency cannot be changed once appointments or payments exist.');
  }
  saveSettings(b);
  audit(req.user, 'settings.update', 'settings', null, { keys: Object.keys(b) });
  return { settings: getSettings() };
}));

adminRouter.put('/business-hours', h((req) => {
  const b = parse(z.object({ hours: z.array(z.object({ weekday: z.number().int().min(0).max(6), open_min: z.number().int().min(0).max(1439), close_min: z.number().int().min(1).max(1440), is_closed: z.boolean() })).length(7) }), req.body);
  tx(() => {
    for (const x of b.hours) {
      if (x.open_min >= x.close_min) throw bad('Closing time must be after opening time.');
      run('INSERT INTO business_hours (weekday, open_min, close_min, is_closed) VALUES (?, ?, ?, ?) ON CONFLICT(weekday) DO UPDATE SET open_min = excluded.open_min, close_min = excluded.close_min, is_closed = excluded.is_closed',
        x.weekday, x.open_min, x.close_min, x.is_closed);
    }
    audit(req.user, 'settings.business_hours', 'settings', null);
  });
  return { ok: true };
}));

// ---------- Image uploads (barber photos, service images) ----------

const UPLOAD_DIR = () => path.join(path.dirname(config.databasePath === ':memory:' ? path.join(process.cwd(), 'data', 'x') : config.databasePath), 'uploads');
export const uploadDir = UPLOAD_DIR;

adminRouter.post('/uploads', h((req) => {
  const { dataUrl } = parse(z.object({ dataUrl: z.string().max(4_200_000) }), req.body);
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw bad('Upload a JPEG, PNG or WebP image.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 3_000_000) throw bad('The image is too large (max 3 MB).');
  const magic = buf.subarray(0, 12).toString('latin1');
  const ok = (m[1] === 'jpeg' && buf[0] === 0xff && buf[1] === 0xd8) || (m[1] === 'png' && magic.startsWith('\x89PNG')) || (m[1] === 'webp' && magic.startsWith('RIFF') && magic.slice(8, 12) === 'WEBP');
  if (!ok) throw bad('That file does not look like a valid image.');
  fs.mkdirSync(UPLOAD_DIR(), { recursive: true });
  const name = `${crypto.randomBytes(12).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(UPLOAD_DIR(), name), buf);
  return { url: `/uploads/${name}` };
}));

// ---------- Email outbox, reviews, activity log ----------

adminRouter.get('/notifications', h((req) => {
  const status = ['queued', 'sent', 'simulated', 'failed'].includes(String(req.query.status)) ? String(req.query.status) : null;
  const { limit, offset } = page(req, 40);
  const where = status ? 'WHERE n.status = ?' : '';
  const params = status ? [status] : [];
  return {
    configured: emailConfigured(),
    total: get<any>(`SELECT COUNT(*) AS n FROM notifications n ${where}`, ...params)!.n, page_size: limit,
    counts: all('SELECT status, COUNT(*) AS n FROM notifications GROUP BY status'),
    notifications: all(
      `SELECT n.id, n.type, n.to_email, n.subject, n.status, n.attempts, n.last_error, n.created_at, n.sent_at, n.next_attempt_at, a.reference
       FROM notifications n LEFT JOIN appointments a ON a.id = n.appointment_id ${where} ORDER BY n.id DESC LIMIT ? OFFSET ?`, ...params, limit, offset),
  };
}));

adminRouter.get('/notifications/:id', h((req) => {
  const n = get<any>('SELECT id, to_email, subject, html, text, status, created_at FROM notifications WHERE id = ?', idParam(req));
  if (!n) throw notFound('Email');
  return { notification: n };
}));

adminRouter.post('/notifications/:id/retry', h((req) => {
  if (!retryNotification(idParam(req))) throw conflict('Only failed emails can be retried.');
  audit(req.user, 'notification.retry', 'notification', idParam(req));
  return { ok: true };
}));

adminRouter.get('/reviews', h(() => ({
  reviews: all(
    `SELECT r.*, c.name AS customer_name, b.name AS barber_name, a.reference FROM reviews r
     JOIN customers c ON c.id = r.customer_id JOIN barbers b ON b.id = r.barber_id JOIN appointments a ON a.id = r.appointment_id ORDER BY r.created_at DESC LIMIT 200`),
})));

adminRouter.patch('/reviews/:id', h((req) => {
  const { is_published } = parse(z.object({ is_published: z.boolean() }), req.body);
  if (!run('UPDATE reviews SET is_published = ? WHERE id = ?', is_published, idParam(req)).changes) throw notFound('Review');
  audit(req.user, is_published ? 'review.publish' : 'review.unpublish', 'review', idParam(req));
  return { ok: true };
}));

adminRouter.get('/audit', h((req) => {
  const { limit, offset } = page(req, 50);
  return {
    total: get<any>('SELECT COUNT(*) AS n FROM audit_log')!.n, page_size: limit,
    events: all('SELECT l.*, u.name AS actor_name FROM audit_log l LEFT JOIN users u ON u.id = l.actor_user_id ORDER BY l.id DESC LIMIT ? OFFSET ?', limit, offset),
  };
}));

export { devHint };

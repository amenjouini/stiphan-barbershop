import { Router } from 'express';
import { z } from 'zod';
import { all, get, run, tx } from '../db.ts';
import { audit, requireRole } from '../lib/auth.ts';
import { bad, conflict, forbidden, h, idParam, notFound, parse, zDate, zEmail, zMinor, zName, zPhone, zText } from '../lib/http.ts';
import { getSettings } from '../lib/settings.ts';
import { METHODS, SOURCES, STATUSES } from '../../shared/constants.ts';
import { addDays, today, zonedToUtc } from '../../shared/time.ts';
import { assertStaffAccess, createAppointment, reschedule, setStatus } from '../services/appointments.ts';
import { slotsFor } from '../services/availability.ts';
import { barberLedger, customerStats, rangeOf, recordPayment } from '../services/finance.ts';
import { appointmentDetail, getAppointment, listAppointments } from '../services/queries.ts';
import { durationOf, parseBarber, parseServiceIds } from './public.ts';

/** Day-to-day chair work for barbers and the owner. Barbers are always scoped to their own chair. */
export const staffRouter = Router();
staffRouter.use(requireRole('owner', 'barber'));

const isOwner = (req: any) => req.user.role === 'owner';

/** The barber a request may act for: barbers are pinned to themselves, the owner may pick anyone. */
function scopeBarber(req: any, requested: unknown): number | undefined {
  if (!isOwner(req)) {
    if (!req.user.barberId) throw forbidden();
    return req.user.barberId;
  }
  if (requested === undefined || requested === '' || requested === 'all') return undefined;
  if (requested === 'me') return req.user.barberId ?? undefined;
  const n = Number(requested);
  if (!Number.isInteger(n) || n <= 0) throw bad('Unknown barber.');
  return n;
}

function loadForStaff(req: any) {
  const appt = getAppointment(idParam(req));
  assertStaffAccess(req.user, appt);
  return appt;
}

staffRouter.get('/team', h((req) => {
  const links = all<any>('SELECT barber_id, service_id FROM barber_services');
  const barbers = all<any>('SELECT id, name, photo_url, is_active FROM barbers ORDER BY is_active DESC, sort_order, id')
    .filter((b) => isOwner(req) || b.id === req.user!.barberId)
    .map((b) => ({ ...b, service_ids: links.filter((l) => l.barber_id === b.id).map((l) => l.service_id) }));
  return {
    barbers,
    services: all('SELECT id, name, price_minor, duration_min, category, is_active FROM services WHERE is_active = 1 ORDER BY sort_order, id'),
    my_barber_id: req.user!.barberId,
  };
}));

staffRouter.get('/appointments', h((req) => {
  const q = parse(z.object({
    from: zDate.optional(), to: zDate.optional(), status: z.enum(STATUSES).optional(), q: zText(80).optional(),
    page: z.coerce.number().int().min(1).optional(), pageSize: z.coerce.number().int().min(1).max(500).optional(),
    order: z.enum(['asc', 'desc']).optional(),
  }), req.query);
  const range = q.from ? rangeOf(q.from, q.to ?? q.from) : null;
  const pageSize = q.pageSize ?? 500;
  const { rows, total } = listAppointments({
    from: range?.from, to: range?.to, barberId: scopeBarber(req, req.query.barber), status: q.status, q: q.q || undefined,
    limit: pageSize, offset: ((q.page ?? 1) - 1) * pageSize, order: q.order,
  });
  return { appointments: rows, total };
}));

staffRouter.get('/appointments/:id', h((req) => {
  const appt = loadForStaff(req);
  const detail = appointmentDetail(appt.id);
  const stats = customerStats(appt.customer_id);
  const s = getSettings();
  return {
    appointment: detail,
    // Barbers get what they need for the chair; money history stays with the owner.
    customer: isOwner(req)
      ? { ...stats, notes: get<any>('SELECT notes FROM customers WHERE id = ?', appt.customer_id)?.notes ?? '' }
      : { visits: stats.visits, no_shows: stats.no_shows, last_visit: stats.last_visit },
    permissions: {
      record_payment: isOwner(req) || s.barbers_record_payments,
      refund: isOwner(req), void: isOwner(req), edit_price: isOwner(req),
    },
  };
}));

const manualSchema = z.object({
  customer: z.union([
    z.object({ id: z.number().int().positive() }),
    z.object({ name: zName, phone: zPhone.or(z.literal('')).optional(), email: zEmail.or(z.literal('')).optional() }),
  ]),
  serviceIds: z.array(z.number().int().positive()).min(1).max(6),
  barber: z.union([z.literal('any'), z.number().int().positive()]).optional(),
  start: z.number().int().positive(),
  source: z.enum(SOURCES).refine((v) => v !== 'website', 'Choose how this booking was received'),
  note: zText(500).optional(),
  priceMinor: zMinor.nullable().optional(),
  ignoreHours: z.boolean().optional(),
});

/** Manual bookings (phone, walk-in, WhatsApp...) go through the same engine and block the same calendar. */
staffRouter.post('/appointments', h((req, res) => {
  const body = parse(manualSchema, req.body);
  const barber = isOwner(req) ? body.barber ?? req.user!.barberId ?? 'any' : req.user!.barberId;
  if (!barber) throw forbidden();
  if (body.priceMinor != null && !isOwner(req)) throw forbidden('Only the owner can set a custom price.');
  const c = body.customer as any;
  const { appointment } = createAppointment({
    customer: c.id ? { id: c.id } : { name: c.name, phone: c.phone || null, email: c.email || null },
    serviceIds: body.serviceIds, barber, start: body.start, source: body.source, internalNote: body.note,
    staff: true, ignoreHours: body.ignoreHours, priceOverrideMinor: body.priceMinor ?? null, actor: req.user,
  });
  res.status(201);
  return { appointment };
}));

staffRouter.post('/appointments/:id/status', h((req) => {
  const appt = loadForStaff(req);
  const body = parse(z.object({ status: z.enum(STATUSES), reason: zText(300).optional() }), req.body);
  return { appointment: setStatus(appt.id, body.status, req.user!, { reason: body.reason }) };
}));

staffRouter.post('/appointments/:id/reschedule', h((req) => {
  const appt = loadForStaff(req);
  const body = parse(z.object({ start: z.number().int().positive(), barber: z.number().int().positive().optional(), ignoreHours: z.boolean().optional() }), req.body);
  if (body.barber && body.barber !== appt.barber_id && !isOwner(req)) throw forbidden('Only the owner can move an appointment to another barber.');
  return { appointment: reschedule(appt.id, { start: body.start, barber: body.barber, staff: true, ignoreHours: body.ignoreHours, actor: req.user }) };
}));

staffRouter.patch('/appointments/:id', h((req) => {
  const appt = loadForStaff(req);
  const body = parse(z.object({ internal_note: zText(2000).optional(), total_minor: zMinor.optional() }), req.body);
  tx(() => {
    if (body.internal_note !== undefined) run('UPDATE appointments SET internal_note = ?, updated_at = ? WHERE id = ?', body.internal_note, Date.now(), appt.id);
    if (body.total_minor !== undefined && body.total_minor !== appt.total_minor) {
      if (!isOwner(req)) throw forbidden('Only the owner can change the agreed price.');
      if (['completed', 'cancelled', 'no_show'].includes(appt.status)) throw conflict('The price is locked once an appointment is closed. Use a refund or payment correction instead.');
      if (body.total_minor < appt.paid_minor) throw conflict('The price cannot be lower than what has already been paid.');
      const items = all<any>('SELECT id, price_minor FROM appointment_items WHERE appointment_id = ? ORDER BY id', appt.id);
      const listed = items.reduce((n, i) => n + i.price_minor, 0);
      const prices = items.map((i) => (listed ? Math.floor((i.price_minor * body.total_minor!) / listed) : 0));
      prices[prices.length - 1] += body.total_minor - prices.reduce((a, b) => a + b, 0);
      items.forEach((i, k) => run('UPDATE appointment_items SET price_minor = ? WHERE id = ?', prices[k], i.id));
      run('UPDATE appointments SET total_minor = ?, updated_at = ? WHERE id = ?', body.total_minor, Date.now(), appt.id);
      audit(req.user, 'appointment.price_change', 'appointment', appt.id, { from: appt.total_minor, to: body.total_minor });
    }
  });
  return { appointment: appointmentDetail(appt.id) };
}));

export const moneySchema = z.object({
  amountMinor: z.number().int().positive().max(1_000_000_000),
  method: z.enum(METHODS),
  reference: zText(100).optional(),
  note: zText(300).optional(),
  idempotencyKey: z.string().min(8).max(80),
});

staffRouter.post('/appointments/:id/payments', h((req, res) => {
  const appt = loadForStaff(req);
  if (!isOwner(req) && !getSettings().barbers_record_payments) throw forbidden('Recording payments is restricted to the owner.');
  const result = recordPayment(appt.id, parse(moneySchema, req.body), req.user!);
  res.status(result.duplicate ? 200 : 201);
  return { appointment: appointmentDetail(appt.id), duplicate: result.duplicate };
}));

staffRouter.get('/customers/search', h((req) => {
  const q = String(req.query.q ?? '').trim().replace(/[%_]/g, '');
  if (q.length < 2) return { customers: [] };
  const like = `%${q}%`;
  return { customers: all('SELECT id, name, phone, email FROM customers WHERE name LIKE ? OR phone LIKE ? OR email LIKE ? ORDER BY name LIMIT 8', like, like, like) };
}));

/** Free start times for staff bookings: same engine as the website, without lead-time or horizon limits. */
staffRouter.get('/availability', h((req) => {
  const { date } = parse(z.object({ date: zDate }), req.query);
  const ids = parseServiceIds(req.query.services);
  const barber = isOwner(req) ? parseBarber(req.query.barber) : req.user!.barberId!;
  const exclude = Number(req.query.exclude) || undefined;
  const slots = slotsFor(date, ids, barber, req.query.duration ? Number(req.query.duration) : durationOf(ids), { staff: true, excludeAppointmentId: exclude });
  return { date, slots: slots.map((s) => ({ start: s.start, barbers: s.barberIds.length })) };
}));

/** Snapshot for the "My chair" home screen. */
staffRouter.get('/summary', h((req) => {
  const s = getSettings();
  const barberId = req.user!.barberId;
  if (!barberId) return { has_chair: false };
  const day = today(s.timezone);
  const r = rangeOf(day, day);
  const week = rangeOf(day, addDays(day, 6));
  const count = (sql: string, ...p: unknown[]) => get<any>(sql, ...p)!.n as number;
  const canSeeEarnings = isOwner(req) || s.barbers_see_earnings;
  return {
    has_chair: true,
    date: day,
    today: {
      total: count("SELECT COUNT(*) AS n FROM appointments WHERE barber_id = ? AND starts_at >= ? AND starts_at < ? AND status NOT IN ('cancelled')", barberId, r.from, r.to),
      completed: count("SELECT COUNT(*) AS n FROM appointments WHERE barber_id = ? AND starts_at >= ? AND starts_at < ? AND status = 'completed'", barberId, r.from, r.to),
      remaining: count("SELECT COUNT(*) AS n FROM appointments WHERE barber_id = ? AND starts_at >= ? AND starts_at < ? AND status IN ('pending','confirmed','checked_in','in_progress')", barberId, r.from, r.to),
      collected_minor: count('SELECT COALESCE(SUM(p.amount_minor), 0) AS n FROM payments p JOIN appointments a ON a.id = p.appointment_id WHERE a.barber_id = ? AND p.created_at >= ? AND p.created_at < ?', barberId, r.from, r.to),
      unpaid_minor: count(
        `SELECT COALESCE(SUM(MAX(a.total_minor - (SELECT COALESCE(SUM(p.amount_minor), 0) FROM payments p WHERE p.appointment_id = a.id), 0)), 0) AS n
         FROM appointments a WHERE a.barber_id = ? AND a.status = 'completed'`, barberId),
    },
    week_upcoming: count("SELECT COUNT(*) AS n FROM appointments WHERE barber_id = ? AND starts_at >= ? AND starts_at < ? AND status IN ('pending','confirmed')", barberId, Date.now(), week.to),
    earnings: canSeeEarnings ? barberLedger(barberId, 1).balance : null,
  };
}));

staffRouter.get('/earnings', h((req) => {
  if (!req.user!.barberId) throw notFound('Barber profile');
  if (!isOwner(req) && !getSettings().barbers_see_earnings) throw forbidden('Earnings are not shared in this shop. Ask the owner.');
  return barberLedger(req.user!.barberId);
}));

// ---- Days off / blocked time. Barbers manage their own; the owner manages anyone's and shop holidays. ----

staffRouter.get('/time-off', h((req) => {
  const barberId = scopeBarber(req, req.query.barber);
  const from = Date.now() - 86_400_000;
  const rows = barberId
    ? all('SELECT t.*, b.name AS barber_name FROM time_off t LEFT JOIN barbers b ON b.id = t.barber_id WHERE (t.barber_id = ? OR t.barber_id IS NULL) AND t.ends_at > ? ORDER BY t.starts_at', barberId, from)
    : all('SELECT t.*, b.name AS barber_name FROM time_off t LEFT JOIN barbers b ON b.id = t.barber_id WHERE t.ends_at > ? ORDER BY t.starts_at', from);
  return { time_off: rows };
}));

staffRouter.post('/time-off', h((req, res) => {
  const body = parse(z.object({
    barber_id: z.number().int().positive().nullable(),
    kind: z.enum(['day_off', 'holiday', 'blocked']),
    from_date: zDate, to_date: zDate.optional(),
    start_min: z.number().int().min(0).max(1439).optional(), end_min: z.number().int().min(1).max(1440).optional(),
    reason: zText(200).optional(),
  }), req.body);
  if (!isOwner(req) && body.barber_id !== req.user!.barberId) throw forbidden('You can only block time on your own schedule.');
  const tz = getSettings().timezone;
  const toDate = body.to_date ?? body.from_date;
  if (toDate < body.from_date) throw bad('The end date is before the start date.');
  const partial = body.kind === 'blocked' && body.start_min != null && body.end_min != null;
  if (partial && body.end_min! <= body.start_min!) throw bad('The end time must be after the start time.');
  const starts = zonedToUtc(body.from_date, partial ? body.start_min! : 0, tz);
  const ends = partial ? zonedToUtc(toDate, body.end_min!, tz) : zonedToUtc(addDays(toDate, 1), 0, tz);
  const clash = body.barber_id
    ? all<any>("SELECT reference FROM appointments WHERE barber_id = ? AND status IN ('pending','confirmed') AND starts_at < ? AND ends_at > ?", body.barber_id, ends, starts)
    : all<any>("SELECT reference FROM appointments WHERE status IN ('pending','confirmed') AND starts_at < ? AND ends_at > ?", ends, starts);
  const id = run('INSERT INTO time_off (barber_id, kind, starts_at, ends_at, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    body.barber_id, body.kind, starts, ends, body.reason || null, req.user!.id, Date.now()).id;
  audit(req.user, 'time_off.create', 'time_off', id, body);
  res.status(201);
  // Existing bookings are not cancelled automatically; the caller is told which ones overlap.
  return { id, conflicts: clash.map((c) => c.reference) };
}));

staffRouter.delete('/time-off/:id', h((req) => {
  const row = get<any>('SELECT * FROM time_off WHERE id = ?', idParam(req));
  if (!row) throw notFound('Entry');
  if (!isOwner(req) && row.barber_id !== req.user!.barberId) throw forbidden();
  run('DELETE FROM time_off WHERE id = ?', row.id);
  audit(req.user, 'time_off.delete', 'time_off', row.id);
  return { ok: true };
}));

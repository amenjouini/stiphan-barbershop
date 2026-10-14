import { Router } from 'express';
import { z } from 'zod';
import { config, emailConfigured } from '../config.ts';
import { all, get, marks, run } from '../db.ts';
import { checkCode, issueCode } from '../lib/auth.ts';
import { bad, forbidden, h, HttpError, notFound, parse, rateLimit, zDate, zEmail, zName, zPhone, zText } from '../lib/http.ts';
import { getSettings, publicSettings } from '../lib/settings.ts';
import { addDays, isDate } from '../../shared/time.ts';
import { assertCustomerCanChange, createAppointment, reschedule, setStatus } from '../services/appointments.ts';
import { slotsFor } from '../services/availability.ts';
import { codeEmail, enqueue } from '../services/notifications.ts';
import { appointmentDetail } from '../services/queries.ts';

export const publicRouter = Router();

/** Email codes only make sense when mail can be delivered (or we are in development, where the code is shown on screen). */
export const canVerifyEmail = () => emailConfigured() || !config.isProd;
export const devHint = (value: string) => (!emailConfigured() && !config.isProd ? value : undefined);

export function parseServiceIds(raw: unknown): number[] {
  const ids = String(raw ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length || ids.length > 6) throw bad('Choose between one and six services.');
  return [...new Set(ids)];
}

export function durationOf(serviceIds: number[]): number {
  const rows = all<any>(`SELECT duration_min FROM services WHERE is_active = 1 AND id IN (${marks(serviceIds.length)})`, ...serviceIds);
  if (rows.length !== serviceIds.length) throw bad('One of the selected services is no longer available.');
  return rows.reduce((n, r) => n + r.duration_min, 0);
}

export const parseBarber = (raw: unknown): number | 'any' => {
  if (raw === undefined || raw === '' || raw === 'any') return 'any';
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw bad('Unknown barber.');
  return n;
};

/** Safe view of an appointment for the customer it belongs to. */
export function customerView(id: number, now = Date.now()) {
  const a = appointmentDetail(id);
  const can = (action: 'cancel' | 'reschedule') => {
    try {
      assertCustomerCanChange(a, action, now);
      return true;
    } catch {
      return false;
    }
  };
  const review = get<any>('SELECT rating, comment FROM reviews WHERE appointment_id = ?', id) ?? null;
  return {
    id: a.id, reference: a.reference, status: a.status, starts_at: a.starts_at, ends_at: a.ends_at, duration_min: a.duration_min,
    services: a.services, items: a.items.map((i: any) => ({ service_id: i.service_id, service_name: i.service_name, price_minor: i.price_minor, duration_min: i.duration_min })),
    barber_id: a.barber_id, barber_name: a.barber_name, customer_name: a.customer_name, customer_note: a.customer_note,
    total_minor: a.total_minor, paid_minor: a.paid_minor, balance_minor: a.balance_minor, payment_status: a.payment_status, currency: a.currency,
    cancel_reason: a.cancel_reason, can_cancel: can('cancel'), can_reschedule: can('reschedule'),
    can_review: a.status === 'completed' && !review, review,
  };
}

publicRouter.get('/shop', h(() => {
  const barbers = all<any>('SELECT id, name, bio, specialty, photo_url FROM barbers WHERE is_active = 1 ORDER BY sort_order, id');
  const links = all<any>('SELECT barber_id, service_id FROM barber_services');
  const hours = all<any>('SELECT barber_id, weekday, start_min, end_min FROM working_hours ORDER BY weekday, start_min');
  const reviews = all<any>(
    `SELECT r.rating, r.comment, r.created_at, c.name AS customer_name, b.name AS barber_name
     FROM reviews r JOIN customers c ON c.id = r.customer_id JOIN barbers b ON b.id = r.barber_id
     WHERE r.is_published = 1 ORDER BY r.created_at DESC LIMIT 6`,
  ).map((r) => ({ ...r, customer_name: r.customer_name.split(' ')[0] + (r.customer_name.split(' ')[1] ? ` ${r.customer_name.split(' ')[1][0]}.` : '') }));
  const rating = get<any>('SELECT COUNT(*) AS count, AVG(rating) AS avg FROM reviews WHERE is_published = 1');
  return {
    settings: { ...publicSettings(), email_verification: getSettings().guest_email_verification && canVerifyEmail(), email_simulated: !emailConfigured(),
      // Lets the sign-in page offer one-click demo logins; never true in production.
      demo_mode: !config.isProd && Boolean(get("SELECT 1 FROM users WHERE email = 'owner@clubbarber.test'")) },
    business_hours: all('SELECT weekday, open_min, close_min, is_closed FROM business_hours ORDER BY weekday'),
    services: all('SELECT id, name, description, category, price_minor, duration_min, image_url FROM services WHERE is_active = 1 ORDER BY sort_order, id'),
    barbers: barbers.map((b) => ({
      ...b,
      service_ids: links.filter((l) => l.barber_id === b.id).map((l) => l.service_id),
      hours: hours.filter((x) => x.barber_id === b.id).map(({ weekday, start_min, end_min }) => ({ weekday, start_min, end_min })),
    })),
    reviews,
    rating: { count: rating?.count ?? 0, average: rating?.avg ? Math.round(rating.avg * 10) / 10 : null },
  };
}));

publicRouter.get('/availability', h((req) => {
  const { date } = parse(z.object({ date: zDate }), req.query);
  const ids = parseServiceIds(req.query.services);
  const slots = slotsFor(date, ids, parseBarber(req.query.barber), durationOf(ids));
  return { date, slots: slots.map((s) => ({ start: s.start, barbers: s.barberIds.length })) };
}));

/** Which of the next days have at least one free slot (drives the date picker). */
publicRouter.get('/availability/days', h((req) => {
  const from = isDate(req.query.from) ? req.query.from : null;
  if (!from) throw bad('Expected a start date.');
  const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 62);
  const ids = parseServiceIds(req.query.services);
  const barber = parseBarber(req.query.barber);
  const duration = durationOf(ids);
  const out: Record<string, number> = {};
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    out[d] = slotsFor(d, ids, barber, duration).length;
  }
  return { days: out };
}));

const codeLimiter = rateLimit({ name: 'code', windowMs: 10 * 60_000, max: 8 });
const bookLimiter = rateLimit({ name: 'book', windowMs: 10 * 60_000, max: 20 });
const manageLimiter = rateLimit({ name: 'manage', windowMs: 10 * 60_000, max: 60 });

publicRouter.post('/booking/request-code', codeLimiter, h((req) => {
  const { email, lang } = parse(z.object({ email: zEmail, lang: zLang }), req.body);
  const code = issueCode('guest_booking', email);
  enqueue('booking_code', codeEmail(email, code, 'booking', lang));
  return { sent: true, devCode: devHint(code) };
}));

/** Website language of the visitor; decides the language of the emails they receive. */
export const zLang = z.enum(['fr', 'ar', 'en']).optional();

const bookingSchema = z.object({
  serviceIds: z.array(z.number().int().positive()).min(1).max(6),
  barber: z.union([z.literal('any'), z.number().int().positive()]),
  start: z.number().int().positive(),
  name: zName,
  email: zEmail,
  phone: zPhone,
  note: zText(500).optional().default(''),
  code: z.string().trim().max(10).optional(),
  lang: zLang,
});

publicRouter.post('/bookings', bookLimiter, h((req, res) => {
  const body = parse(bookingSchema, req.body);
  const s = getSettings();
  const asCustomer = req.user?.role === 'customer' ? req.user : null;
  if (!asCustomer) {
    if (!s.guest_booking) throw new HttpError(401, 'ACCOUNT_REQUIRED', 'Please sign in or create an account to book.');
    if (s.guest_email_verification && canVerifyEmail()) {
      // The code is consumed only once the booking is actually created.
      if (!body.code || !checkCode('guest_booking', body.email, body.code, false)) {
        throw new HttpError(400, 'CODE_INVALID', 'That code is not valid or has expired. Request a new one and try again.');
      }
    }
  }
  const customer = asCustomer
    ? { userId: asCustomer.id, name: asCustomer.name, email: asCustomer.email, phone: body.phone }
    : { name: body.name, email: body.email, phone: body.phone };
  const { appointment, manageToken } = createAppointment({
    customer, serviceIds: body.serviceIds, barber: body.barber, start: body.start, source: 'website', customerNote: body.note, actor: asCustomer, locale: body.lang,
  });
  if (!asCustomer && body.code) checkCode('guest_booking', body.email, body.code, true);
  if (asCustomer && !asCustomer.phone) run('UPDATE users SET phone = ? WHERE id = ?', body.phone, asCustomer.id);
  res.status(201);
  return { appointment: customerView(appointment.id), manageToken };
}));

// ---- Guest "manage my booking" link (reference + secret token) ----

function byToken(ref: string, token: unknown) {
  const a = get<any>('SELECT id, manage_token FROM appointments WHERE reference = ?', String(ref).toUpperCase());
  if (!a || !token || typeof token !== 'string' || a.manage_token !== token) throw notFound('Booking');
  return a.id as number;
}

publicRouter.get('/manage/:ref', manageLimiter, h((req) => ({ appointment: customerView(byToken(req.params.ref, req.query.token)) })));

publicRouter.post('/manage/:ref/cancel', manageLimiter, h((req) => {
  const id = byToken(req.params.ref, req.body?.token);
  const { reason } = parse(z.object({ reason: zText(300).optional() }), req.body);
  assertCustomerCanChange(appointmentDetail(id), 'cancel');
  setStatus(id, 'cancelled', null, { reason: reason || 'Cancelled by customer' });
  return { appointment: customerView(id) };
}));

publicRouter.post('/manage/:ref/reschedule', manageLimiter, h((req) => {
  const id = byToken(req.params.ref, req.body?.token);
  const { start } = parse(z.object({ start: z.number().int().positive() }), req.body);
  assertCustomerCanChange(appointmentDetail(id), 'reschedule');
  reschedule(id, { start });
  return { appointment: customerView(id) };
}));

export function saveReview(apptId: number, body: unknown) {
  const { rating, comment } = parse(z.object({ rating: z.number().int().min(1).max(5), comment: zText(600).optional().default('') }), body);
  const a = appointmentDetail(apptId);
  if (a.status !== 'completed') throw forbidden('You can leave feedback once your visit is completed.');
  if (get('SELECT 1 FROM reviews WHERE appointment_id = ?', apptId)) throw new HttpError(409, 'CONFLICT', 'Feedback has already been left for this visit.');
  run('INSERT INTO reviews (appointment_id, customer_id, barber_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    apptId, a.customer_id, a.barber_id, rating, comment, Date.now());
}

publicRouter.post('/manage/:ref/review', manageLimiter, h((req) => {
  const id = byToken(req.params.ref, req.body?.token);
  saveReview(id, { rating: req.body?.rating, comment: req.body?.comment });
  return { appointment: customerView(id) };
}));

import crypto from 'node:crypto';
import { all, get, marks, run, tx } from '../db.ts';
import { audit, randomToken, type AuthUser } from '../lib/auth.ts';
import { bad, conflict, forbidden, HttpError, notFound } from '../lib/http.ts';
import { getSettings } from '../lib/settings.ts';
import { STATUS_LABEL, TRANSITIONS, type Source, type Status } from '../../shared/constants.ts';
import { zoned } from '../../shared/time.ts';
import { checkFree, eligibleBarbers, pickBarber, slotsFor } from './availability.ts';
import { syncEarning } from './finance.ts';
import { notifyAppointment } from './notifications.ts';
import { appointmentDetail, getAppointment } from './queries.ts';

const MIN = 60_000;
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newReference(): string {
  for (let i = 0; i < 10; i++) {
    const bytes = crypto.randomBytes(6);
    const ref = 'CB-' + [...bytes].map((b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
    if (!get('SELECT 1 FROM appointments WHERE reference = ?', ref)) return ref;
  }
  throw new Error('Could not generate a unique booking reference');
}

const slotTaken = () => conflict('Sorry, that time has just been taken. Please choose another slot.', 'SLOT_TAKEN');
const isTriggerOverlap = (e: any) => String(e?.message || '').includes('SLOT_TAKEN');

export interface CustomerInput { id?: number; name?: string; email?: string | null; phone?: string | null; userId?: number | null }

/** Finds the customer record (by id, linked user or email) or creates it. */
export function resolveCustomer(c: CustomerInput): number {
  if (c.id) {
    if (!get('SELECT 1 FROM customers WHERE id = ?', c.id)) throw notFound('Customer');
    return c.id;
  }
  const email = c.email?.trim().toLowerCase() || null;
  let row = c.userId ? get<any>('SELECT * FROM customers WHERE user_id = ?', c.userId) : undefined;
  if (!row && email) row = get<any>('SELECT * FROM customers WHERE email = ?', email);
  if (row) {
    if (c.userId && !row.user_id) run('UPDATE customers SET user_id = ? WHERE id = ?', c.userId, row.id);
    if (c.phone && !row.phone) run('UPDATE customers SET phone = ? WHERE id = ?', c.phone, row.id);
    return row.id;
  }
  if (!c.name) throw bad('Customer name is required.');
  return run('INSERT INTO customers (user_id, name, email, phone, created_at) VALUES (?, ?, ?, ?, ?)', c.userId ?? null, c.name, email, c.phone || null, Date.now()).id;
}

export interface CreateInput {
  customer: CustomerInput;
  serviceIds: number[];
  barber: number | 'any';
  start: number;
  source: Source;
  customerNote?: string;
  internalNote?: string;
  /** Staff mode: skips lead time / horizon / slot grid; overlap rules still apply. */
  staff?: boolean;
  ignoreHours?: boolean;
  priceOverrideMinor?: number | null;
  actor?: AuthUser | null;
  now?: number;
  /** Seeding only: do not queue emails. */
  silent?: boolean;
  /** Language the customer used on the website; stored so their emails match it. */
  locale?: string;
}

/**
 * Creates an appointment atomically. Availability is re-checked on the server
 * inside a write transaction, and the database trigger rejects any overlap
 * that could still slip through, so a slot can never be sold twice.
 */
export function createAppointment(input: CreateInput) {
  const s = getSettings();
  const now = input.now ?? Date.now();
  const ids = [...new Set(input.serviceIds)];
  if (!ids.length) throw bad('Choose at least one service.');

  const result = tx(() => {
    const services = all<any>(`SELECT id, name, price_minor, duration_min FROM services WHERE is_active = 1 AND id IN (${marks(ids.length)})`, ...ids);
    if (services.length !== ids.length) throw bad('One of the selected services is no longer available.');
    services.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    const duration = services.reduce((n, x) => n + x.duration_min, 0);
    const eligible = eligibleBarbers(ids);

    let barberId: number | null;
    if (input.staff) {
      if (input.barber === 'any') {
        barberId = pickBarber(eligible.filter((b) => checkFree(b.id, input.start, duration, { ignoreHours: input.ignoreHours }).ok).map((b) => b.id), input.start);
        if (!barberId) throw slotTaken();
      } else {
        barberId = input.barber;
        if (!eligible.some((b) => b.id === barberId)) throw bad('This barber does not offer all of the selected services.');
        const free = checkFree(barberId, input.start, duration, { ignoreHours: input.ignoreHours });
        if (!free.ok) {
          throw free.reason === 'SLOT_TAKEN'
            ? conflict('This barber already has an appointment overlapping that time.', 'SLOT_TAKEN')
            : conflict('That time is outside the barber’s working hours (or during a break or day off).', 'OUTSIDE_HOURS');
        }
      }
    } else {
      if (input.barber === 'any' && !s.allow_any_barber) throw bad('Please choose a barber.');
      const date = zoned(input.start, s.timezone).date;
      const slot = slotsFor(date, ids, input.barber, duration, { now }).find((x) => x.start === input.start);
      if (!slot) throw slotTaken();
      barberId = input.barber === 'any' ? pickBarber(slot.barberIds, input.start) : input.barber;
      if (!barberId) throw slotTaken();
    }

    let prices = services.map((x) => x.price_minor as number);
    if (input.priceOverrideMinor != null) {
      const listed = prices.reduce((a, b) => a + b, 0);
      const target = input.priceOverrideMinor;
      // Spread the agreed total across the lines; the last line absorbs rounding.
      prices = prices.map((p) => (listed ? Math.floor((p * target) / listed) : 0));
      prices[prices.length - 1] += target - prices.reduce((a, b) => a + b, 0);
    }
    const total = prices.reduce((a, b) => a + b, 0);

    const customerId = resolveCustomer(input.customer);
    if (input.locale) run('UPDATE customers SET locale = ? WHERE id = ?', input.locale, customerId);
    const status: Status = input.staff || s.auto_confirm ? 'confirmed' : 'pending';
    const end = input.start + duration * MIN;
    const manageToken = randomToken(24);
    let apptId: number;
    try {
      apptId = run(
        `INSERT INTO appointments (reference, customer_id, barber_id, starts_at, ends_at, blocked_until, status, source, total_minor, currency,
           customer_note, internal_note, manage_token, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newReference(), customerId, barberId, input.start, end, end + s.buffer_min * MIN, status, input.source, total, s.currency,
        input.customerNote || '', input.internalNote || '', manageToken, input.actor?.id ?? null, now, now,
      ).id;
    } catch (e) {
      if (isTriggerOverlap(e)) throw slotTaken();
      throw e;
    }
    services.forEach((svc, i) =>
      run('INSERT INTO appointment_items (appointment_id, service_id, service_name, price_minor, duration_min) VALUES (?, ?, ?, ?, ?)',
        apptId, svc.id, svc.name, prices[i], svc.duration_min));
    audit(input.actor ?? null, 'appointment.create', 'appointment', apptId, { source: input.source, barberId, start: input.start, total });
    return { id: apptId, status, manageToken };
  });

  // Emails are queued after commit; failure to queue never undoes the booking.
  if (input.silent) return { appointment: appointmentDetail(result.id), manageToken: result.manageToken };
  notifyAppointment(result.status === 'pending' ? 'pending' : 'confirmation', result.id, { manageToken: result.manageToken, dedupeKey: `created:${result.id}` });
  if (input.source === 'website') notifyAppointment('owner_new', result.id, { dedupeKey: `owner_new:${result.id}` });
  return { appointment: appointmentDetail(result.id), manageToken: result.manageToken };
}

/**
 * Moves an appointment through its lifecycle. Re-applying the current status
 * is a no-op, so double clicks never duplicate timestamps, revenue or emails.
 * Completing a service records who/when and never touches payments.
 */
export function setStatus(apptId: number, next: Status, actor: AuthUser | null, opts: { reason?: string; at?: number; silent?: boolean } = {}) {
  const now = opts.at ?? Date.now();
  const changed = tx(() => {
    const a = getAppointment(apptId);
    const current = a.status as Status;
    if (current === next) return false;
    if (!TRANSITIONS[current].includes(next)) {
      throw conflict(`A ${STATUS_LABEL[current].toLowerCase()} appointment cannot be changed to ${STATUS_LABEL[next].toLowerCase()}.`, 'INVALID_TRANSITION');
    }
    if (next === 'no_show' && now < a.starts_at) throw conflict('A no-show can only be recorded once the appointment time has passed.', 'TOO_EARLY');
    const sets: string[] = ['status = ?', 'updated_at = ?'];
    const params: unknown[] = [next, now];
    if (next === 'checked_in') { sets.push('checked_in_at = ?'); params.push(now); }
    if (next === 'in_progress') { sets.push('started_at = ?'); params.push(now); }
    if (next === 'completed') { sets.push('completed_at = ?', 'completed_by = ?'); params.push(now, actor?.id ?? null); }
    if (next === 'cancelled') { sets.push('cancelled_at = ?', 'cancel_reason = ?'); params.push(now, opts.reason?.trim() || null); }
    run(`UPDATE appointments SET ${sets.join(', ')} WHERE id = ?`, ...params, apptId);
    if (next === 'completed') syncEarning(apptId, now);
    audit(actor, `appointment.${next}`, 'appointment', apptId, { from: current, reason: opts.reason });
    return current;
  });
  if (changed && !opts.silent) {
    if (next === 'confirmed' && changed === 'pending') notifyAppointment('approved', apptId, { dedupeKey: `approved:${apptId}` });
    if (next === 'cancelled') notifyAppointment('cancelled', apptId, { dedupeKey: `cancelled:${apptId}` });
  }
  return appointmentDetail(apptId);
}

/** Customer-side policy checks shared by account and guest-link routes. */
export function assertCustomerCanChange(a: { status: string; starts_at: number }, action: 'cancel' | 'reschedule', now = Date.now()) {
  const s = getSettings();
  if (a.status !== 'pending' && a.status !== 'confirmed') throw conflict(`This appointment can no longer be ${action === 'cancel' ? 'cancelled' : 'rescheduled'}.`);
  const hours = action === 'cancel' ? s.cancel_min_hours : s.reschedule_min_hours;
  if (a.starts_at - now < hours * 3_600_000) {
    throw new HttpError(409, 'POLICY', `Online ${action === 'cancel' ? 'cancellation' : 'rescheduling'} closes ${hours} h before the appointment. Please call the shop on ${s.phone}.`);
  }
}

export function reschedule(apptId: number, input: { start: number; barber?: number | 'any'; staff?: boolean; ignoreHours?: boolean; actor?: AuthUser | null; now?: number }) {
  const s = getSettings();
  const now = input.now ?? Date.now();
  tx(() => {
    const a = getAppointment(apptId);
    if (!['pending', 'confirmed'].includes(a.status)) throw conflict('Only pending or confirmed appointments can be rescheduled.');
    const items = all<any>('SELECT service_id FROM appointment_items WHERE appointment_id = ?', apptId);
    const serviceIds = items.map((i) => i.service_id).filter(Boolean) as number[];
    const duration = a.duration_min;
    let barberId = input.barber && input.barber !== 'any' ? input.barber : a.barber_id;
    if (barberId !== a.barber_id) {
      const b = get<any>('SELECT is_active FROM barbers WHERE id = ?', barberId);
      if (!b?.is_active) throw bad('That barber is not available.');
      if (serviceIds.length && !eligibleBarbers(serviceIds).some((x) => x.id === barberId)) throw bad('That barber does not offer all of the booked services.');
    }
    if (input.staff) {
      const free = checkFree(barberId, input.start, duration, { excludeAppointmentId: apptId, ignoreHours: input.ignoreHours });
      if (!free.ok) {
        throw free.reason === 'SLOT_TAKEN'
          ? conflict('The barber already has an appointment overlapping that time.', 'SLOT_TAKEN')
          : conflict('That time is outside the barber’s working hours (or during a break or day off).', 'OUTSIDE_HOURS');
      }
    } else {
      const date = zoned(input.start, s.timezone).date;
      const pool = serviceIds.length ? slotsFor(date, serviceIds, barberId, duration, { now, excludeAppointmentId: apptId }) : [];
      if (!pool.some((x) => x.start === input.start)) throw slotTaken();
    }
    const end = input.start + duration * MIN;
    try {
      run('UPDATE appointments SET starts_at = ?, ends_at = ?, blocked_until = ?, barber_id = ?, updated_at = ? WHERE id = ?',
        input.start, end, end + s.buffer_min * MIN, barberId, now, apptId);
    } catch (e) {
      if (isTriggerOverlap(e)) throw slotTaken();
      throw e;
    }
    audit(input.actor ?? null, 'appointment.reschedule', 'appointment', apptId, { from: a.starts_at, to: input.start, barberFrom: a.barber_id, barberTo: barberId });
  });
  notifyAppointment('rescheduled', apptId, { dedupeKey: `rescheduled:${apptId}:${input.start}` });
  return appointmentDetail(apptId);
}

/** Staff may act on an appointment if they own the shop or it is on their own chair. */
export function assertStaffAccess(user: AuthUser, appt: { barber_id: number }) {
  if (user.role === 'owner') return;
  if (user.role === 'barber' && user.barberId === appt.barber_id) return;
  throw forbidden('This appointment belongs to another barber.');
}

import crypto from 'node:crypto';
import { all, get, run, tx } from '../db.ts';
import { audit, type AuthUser } from '../lib/auth.ts';
import { bad, conflict, notFound } from '../lib/http.ts';
import { getSettings } from '../lib/settings.ts';
import { applyBps } from '../../shared/money.ts';
import { addDays, zoned, zonedToUtc } from '../../shared/time.ts';
import { getAppointment } from './queries.ts';

const publicId = (prefix: string) => `${prefix}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

export interface MoneyInput { amountMinor: number; method: string; reference?: string | null; note?: string | null; idempotencyKey?: string | null; /** Internal (seeding/tests): backdate the entry. */ at?: number }

const paidOn = (apptId: number) => get<any>('SELECT COALESCE(SUM(amount_minor), 0) AS n FROM payments WHERE appointment_id = ?', apptId)!.n as number;

// ---------- Customer payments ----------

/**
 * Records money received for an appointment. Completion and payment are
 * independent: this never changes the appointment status. The idempotency key
 * makes a double-submitted form a no-op, and overpaying the balance is refused.
 */
export function recordPayment(apptId: number, input: MoneyInput, actor: AuthUser) {
  return tx(() => {
    if (input.idempotencyKey) {
      const dup = get<any>('SELECT id FROM payments WHERE idempotency_key = ?', input.idempotencyKey);
      if (dup) return { paymentId: dup.id as number, duplicate: true };
    }
    const appt = getAppointment(apptId);
    if (appt.status === 'cancelled' || appt.status === 'no_show') throw conflict('This appointment is closed; payments cannot be recorded on it.');
    if (input.amountMinor <= 0) throw bad('Enter an amount greater than zero.');
    if (input.amountMinor > appt.balance_minor) throw conflict('The amount is higher than the remaining balance.', 'OVERPAYMENT');
    const r = run(
      `INSERT INTO payments (public_id, appointment_id, customer_id, kind, amount_minor, currency, method, reference, note, recorded_by, idempotency_key, created_at)
       VALUES (?, ?, ?, 'payment', ?, ?, ?, ?, ?, ?, ?, ?)`,
      publicId('PAY'), apptId, appt.customer_id, input.amountMinor, appt.currency, input.method,
      input.reference || null, input.note || null, actor.id, input.idempotencyKey || null, input.at ?? Date.now(),
    );
    audit(actor, 'payment.record', 'appointment', apptId, { paymentId: r.id, amountMinor: input.amountMinor, method: input.method });
    syncEarning(apptId, input.at);
    return { paymentId: r.id, duplicate: false };
  });
}

/** Money returned to the customer. Cannot exceed what was actually collected on the appointment. */
export function recordRefund(apptId: number, input: MoneyInput, actor: AuthUser) {
  return tx(() => {
    if (input.idempotencyKey) {
      const dup = get<any>('SELECT id FROM payments WHERE idempotency_key = ?', input.idempotencyKey);
      if (dup) return { paymentId: dup.id as number, duplicate: true };
    }
    const appt = getAppointment(apptId);
    if (input.amountMinor <= 0) throw bad('Enter an amount greater than zero.');
    if (input.amountMinor > appt.paid_minor) throw conflict('You cannot refund more than was collected on this appointment.', 'OVER_REFUND');
    const r = run(
      `INSERT INTO payments (public_id, appointment_id, customer_id, kind, amount_minor, currency, method, reference, note, recorded_by, idempotency_key, created_at)
       VALUES (?, ?, ?, 'refund', ?, ?, ?, ?, ?, ?, ?, ?)`,
      publicId('REF'), apptId, appt.customer_id, -input.amountMinor, appt.currency, input.method,
      input.reference || null, input.note || null, actor.id, input.idempotencyKey || null, input.at ?? Date.now(),
    );
    audit(actor, 'payment.refund', 'appointment', apptId, { paymentId: r.id, amountMinor: input.amountMinor, method: input.method, note: input.note });
    return { paymentId: r.id, duplicate: false };
  });
}

/**
 * Corrects a mis-entered payment or refund by appending an equal and opposite
 * adjustment. The original row is never edited; each entry can be voided once.
 */
export function voidPayment(paymentId: number, reason: string, actor: AuthUser) {
  return tx(() => {
    const p = get<any>('SELECT * FROM payments WHERE id = ?', paymentId);
    if (!p) throw notFound('Payment');
    if (p.kind === 'adjustment') throw conflict('A correction entry cannot itself be voided.');
    if (get('SELECT 1 FROM payments WHERE reverses_payment_id = ?', paymentId)) throw conflict('This entry has already been voided.', 'ALREADY_VOIDED');
    if (paidOn(p.appointment_id) - p.amount_minor < 0) throw conflict('Voiding this payment would leave a negative balance; void the related refund first.');
    const r = run(
      `INSERT INTO payments (public_id, appointment_id, customer_id, kind, amount_minor, currency, method, note, reverses_payment_id, recorded_by, created_at)
       VALUES (?, ?, ?, 'adjustment', ?, ?, ?, ?, ?, ?, ?)`,
      publicId('ADJ'), p.appointment_id, p.customer_id, -p.amount_minor, p.currency, p.method, `Void of ${p.public_id}: ${reason}`, paymentId, actor.id, Date.now(),
    );
    audit(actor, 'payment.void', 'payment', paymentId, { adjustmentId: r.id, reason, amountMinor: p.amount_minor });
    return { paymentId: r.id };
  });
}

// ---------- Barber compensation ----------

export function currentRule(barberId: number, at = Date.now()) {
  return get<any>('SELECT * FROM compensation_rules WHERE barber_id = ? AND effective_from <= ? ORDER BY effective_from DESC, id DESC LIMIT 1', barberId, at);
}

/**
 * Creates the barber's earning for a completed appointment, at most once
 * (UNIQUE appointment_id). The rule in force at completion time is used and
 * snapshotted, so later rule changes never alter what was already earned.
 */
export function syncEarning(apptId: number, at = Date.now()) {
  const a = get<any>('SELECT id, barber_id, status, total_minor, completed_at FROM appointments WHERE id = ?', apptId);
  if (!a || a.status !== 'completed' || !a.completed_at) return;
  if (get('SELECT 1 FROM barber_earnings WHERE appointment_id = ?', apptId)) return;
  const rule = currentRule(a.barber_id, a.completed_at);
  if (!rule || rule.model === 'none' || rule.model === 'salary') return;
  if (rule.basis === 'paid' && paidOn(apptId) < a.total_minor) return;
  const amount = rule.model === 'commission' ? applyBps(a.total_minor, rule.commission_bps) : rule.fixed_minor;
  if (amount <= 0) return;
  run(
    `INSERT INTO barber_earnings (barber_id, kind, appointment_id, amount_minor, base_minor, rule_id, rule_snapshot, created_at)
     VALUES (?, 'service', ?, ?, ?, ?, ?, ?)`,
    a.barber_id, apptId, amount, a.total_minor, rule.id,
    JSON.stringify({ model: rule.model, basis: rule.basis, commission_bps: rule.commission_bps, fixed_minor: rule.fixed_minor }), at,
  );
}

export function barberBalance(barberId: number) {
  const earned = get<any>('SELECT COALESCE(SUM(amount_minor), 0) AS n FROM barber_earnings WHERE barber_id = ?', barberId)!.n as number;
  const paid = get<any>('SELECT COALESCE(SUM(amount_minor), 0) AS n FROM payouts WHERE barber_id = ?', barberId)!.n as number;
  return { earned_minor: earned, paid_minor: paid, owed_minor: earned - paid };
}

/** Pays a barber. Refuses to pay more than is currently owed, which also blocks paying the same earnings twice. */
export function recordPayout(barberId: number, input: MoneyInput & { paidAt?: number }, actor: AuthUser) {
  return tx(() => {
    if (input.idempotencyKey) {
      const dup = get<any>('SELECT id FROM payouts WHERE idempotency_key = ?', input.idempotencyKey);
      if (dup) return { payoutId: dup.id as number, duplicate: true };
    }
    if (!get('SELECT 1 FROM barbers WHERE id = ?', barberId)) throw notFound('Barber');
    const { owed_minor } = barberBalance(barberId);
    if (input.amountMinor <= 0) throw bad('Enter an amount greater than zero.');
    if (input.amountMinor > owed_minor) throw conflict('The payout is higher than the amount currently owed to this barber.', 'OVER_PAYOUT');
    const now = Date.now();
    const r = run(
      `INSERT INTO payouts (public_id, barber_id, amount_minor, currency, method, reference, note, recorded_by, idempotency_key, paid_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      publicId('OUT'), barberId, input.amountMinor, getSettings().currency, input.method, input.reference || null, input.note || null,
      actor.id, input.idempotencyKey || null, input.paidAt ?? now, now,
    );
    audit(actor, 'payout.record', 'barber', barberId, { payoutId: r.id, amountMinor: input.amountMinor, method: input.method });
    return { payoutId: r.id, duplicate: false };
  });
}

export function voidPayout(payoutId: number, reason: string, actor: AuthUser) {
  return tx(() => {
    const p = get<any>('SELECT * FROM payouts WHERE id = ?', payoutId);
    if (!p) throw notFound('Payout');
    if (p.reverses_payout_id) throw conflict('A correction entry cannot itself be voided.');
    if (get('SELECT 1 FROM payouts WHERE reverses_payout_id = ?', payoutId)) throw conflict('This payout has already been voided.', 'ALREADY_VOIDED');
    const now = Date.now();
    const r = run(
      `INSERT INTO payouts (public_id, barber_id, amount_minor, currency, method, note, reverses_payout_id, recorded_by, paid_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      publicId('ADJ'), p.barber_id, -p.amount_minor, p.currency, p.method, `Void of ${p.public_id}: ${reason}`, payoutId, actor.id, now, now,
    );
    audit(actor, 'payout.void', 'payout', payoutId, { adjustmentId: r.id, reason });
    return { payoutId: r.id };
  });
}

/** Salary accruals, bonuses and deductions entered by the owner. One salary entry per barber and period. */
export function addManualEarning(barberId: number, input: { kind: 'salary' | 'bonus' | 'deduction'; amountMinor: number; period?: string | null; note?: string | null }, actor: AuthUser) {
  return tx(() => {
    if (!get('SELECT 1 FROM barbers WHERE id = ?', barberId)) throw notFound('Barber');
    if (input.amountMinor <= 0) throw bad('Enter an amount greater than zero.');
    if (input.kind === 'salary') {
      if (!input.period || !/^\d{4}-\d{2}$/.test(input.period)) throw bad('Choose the month this salary covers.');
      if (get("SELECT 1 FROM barber_earnings WHERE barber_id = ? AND kind = 'salary' AND period = ?", barberId, input.period)) {
        throw conflict(`Salary for ${input.period} has already been recorded for this barber.`, 'DUPLICATE_SALARY');
      }
    }
    const rule = currentRule(barberId);
    const r = run(
      'INSERT INTO barber_earnings (barber_id, kind, amount_minor, rule_id, period, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      barberId, input.kind, input.kind === 'deduction' ? -input.amountMinor : input.amountMinor, rule?.id ?? null, input.period || null, input.note || null, actor.id, Date.now(),
    );
    audit(actor, `earning.${input.kind}`, 'barber', barberId, { earningId: r.id, amountMinor: input.amountMinor, period: input.period });
    return { earningId: r.id };
  });
}

export function setCompensationRule(barberId: number, rule: { model: string; basis: string; commission_bps: number; fixed_minor: number; salary_minor: number; note?: string | null }, actor: AuthUser | null) {
  const now = Date.now();
  const r = run(
    `INSERT INTO compensation_rules (barber_id, model, basis, commission_bps, fixed_minor, salary_minor, note, effective_from, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    barberId, rule.model, rule.basis, rule.commission_bps, rule.fixed_minor, rule.salary_minor, rule.note || null, now, actor?.id ?? null, now,
  );
  if (actor) audit(actor, 'compensation.change', 'barber', barberId, rule);
  return r.id;
}

export function barberLedger(barberId: number, limit = 200) {
  const earnings = all(
    `SELECT e.id, e.kind, e.amount_minor, e.base_minor, e.rule_snapshot, e.period, e.note, e.created_at, a.reference, a.starts_at,
       (SELECT group_concat(i.service_name, ' + ') FROM appointment_items i WHERE i.appointment_id = a.id) AS services
     FROM barber_earnings e LEFT JOIN appointments a ON a.id = e.appointment_id WHERE e.barber_id = ? ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
    barberId, limit,
  );
  const payouts = all(
    `SELECT p.id, p.public_id, p.amount_minor, p.method, p.reference, p.note, p.paid_at, p.reverses_payout_id, u.name AS recorded_by_name,
       (SELECT v.id FROM payouts v WHERE v.reverses_payout_id = p.id) AS voided_by
     FROM payouts p LEFT JOIN users u ON u.id = p.recorded_by WHERE p.barber_id = ? ORDER BY p.paid_at DESC, p.id DESC LIMIT ?`,
    barberId, limit,
  );
  return { earnings, payouts, balance: barberBalance(barberId), rule: currentRule(barberId) ?? null };
}

// ---------- Reporting ----------

export interface Range { from: number; to: number; fromDate: string; toDate: string }

/** Inclusive local dates -> UTC half-open range. */
export function rangeOf(fromDate: string, toDate: string): Range {
  const tz = getSettings().timezone;
  return { from: zonedToUtc(fromDate, 0, tz), to: zonedToUtc(addDays(toDate, 1), 0, tz), fromDate, toDate };
}

const sum = (sql: string, ...p: unknown[]) => (get<any>(sql, ...p)?.n ?? 0) as number;

/**
 * Every figure comes from recorded rows, and each one is labelled for what it
 * is: revenue = services performed, collected = money received, outstanding =
 * performed but unpaid, compensation = owed to barbers, payouts = paid to them.
 */
export function buildReport(r: Range) {
  const tz = getSettings().timezone;
  const statusRows = all<any>('SELECT status, COUNT(*) AS n FROM appointments WHERE starts_at >= ? AND starts_at < ? GROUP BY status', r.from, r.to);
  const byStatus: Record<string, number> = { pending: 0, confirmed: 0, checked_in: 0, in_progress: 0, completed: 0, cancelled: 0, no_show: 0 };
  for (const s of statusRows) byStatus[s.status] = s.n;
  const appointments = Object.values(byStatus).reduce((a, b) => a + b, 0);

  const serviceRevenue = sum("SELECT COALESCE(SUM(total_minor), 0) AS n FROM appointments WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?", r.from, r.to);
  const completedServices = sum("SELECT COUNT(*) AS n FROM appointments WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?", r.from, r.to);

  const pay = (kind: string) => sum('SELECT COALESCE(SUM(amount_minor), 0) AS n FROM payments WHERE kind = ? AND created_at >= ? AND created_at < ?', kind, r.from, r.to);
  const paymentsReceived = pay('payment');
  const refunds = -pay('refund');
  const adjustments = pay('adjustment');
  const netCollected = paymentsReceived - refunds + adjustments;
  const byMethod = all<any>(
    `SELECT method, COALESCE(SUM(amount_minor), 0) AS net_minor, COUNT(*) AS entries FROM payments
     WHERE created_at >= ? AND created_at < ? GROUP BY method ORDER BY net_minor DESC`, r.from, r.to);
  const cashCollected = byMethod.find((m) => m.method === 'cash')?.net_minor ?? 0;

  // Outstanding: services performed in the period that are still not fully paid (as of now).
  const outstandingPeriod = sum(
    `SELECT COALESCE(SUM(MAX(a.total_minor - (SELECT COALESCE(SUM(p.amount_minor), 0) FROM payments p WHERE p.appointment_id = a.id), 0)), 0) AS n
     FROM appointments a WHERE a.status = 'completed' AND a.completed_at >= ? AND a.completed_at < ?`, r.from, r.to);
  const outstandingTotal = sum(
    `SELECT COALESCE(SUM(MAX(a.total_minor - (SELECT COALESCE(SUM(p.amount_minor), 0) FROM payments p WHERE p.appointment_id = a.id), 0)), 0) AS n
     FROM appointments a WHERE a.status = 'completed'`);
  const refundsDue = sum(
    `SELECT COALESCE(SUM(x.paid), 0) AS n FROM (SELECT (SELECT COALESCE(SUM(p.amount_minor), 0) FROM payments p WHERE p.appointment_id = a.id) AS paid
     FROM appointments a WHERE a.status IN ('cancelled','no_show')) x WHERE x.paid > 0`);

  const compensationEarned = sum('SELECT COALESCE(SUM(amount_minor), 0) AS n FROM barber_earnings WHERE created_at >= ? AND created_at < ?', r.from, r.to);
  const payoutsPaid = sum('SELECT COALESCE(SUM(amount_minor), 0) AS n FROM payouts WHERE paid_at >= ? AND paid_at < ?', r.from, r.to);
  const compensationOwed = sum('SELECT COALESCE(SUM(amount_minor), 0) AS n FROM barber_earnings') - sum('SELECT COALESCE(SUM(amount_minor), 0) AS n FROM payouts');
  const expenses = sum('SELECT COALESCE(SUM(amount_minor), 0) AS n FROM expenses WHERE voided_at IS NULL AND spent_at >= ? AND spent_at < ?', r.from, r.to);

  const byBarber = all<any>(
    `SELECT b.id, b.name,
       (SELECT COUNT(*) FROM appointments a WHERE a.barber_id = b.id AND a.starts_at >= ?1 AND a.starts_at < ?2) AS appointments,
       (SELECT COUNT(*) FROM appointments a WHERE a.barber_id = b.id AND a.status = 'completed' AND a.completed_at >= ?1 AND a.completed_at < ?2) AS completed,
       (SELECT COUNT(*) FROM appointments a WHERE a.barber_id = b.id AND a.status = 'no_show' AND a.starts_at >= ?1 AND a.starts_at < ?2) AS no_shows,
       (SELECT COALESCE(SUM(a.total_minor), 0) FROM appointments a WHERE a.barber_id = b.id AND a.status = 'completed' AND a.completed_at >= ?1 AND a.completed_at < ?2) AS revenue_minor,
       (SELECT COALESCE(SUM(p.amount_minor), 0) FROM payments p JOIN appointments a ON a.id = p.appointment_id WHERE a.barber_id = b.id AND p.created_at >= ?1 AND p.created_at < ?2) AS collected_minor,
       (SELECT COALESCE(SUM(e.amount_minor), 0) FROM barber_earnings e WHERE e.barber_id = b.id AND e.created_at >= ?1 AND e.created_at < ?2) AS earned_minor,
       (SELECT COALESCE(SUM(o.amount_minor), 0) FROM payouts o WHERE o.barber_id = b.id AND o.paid_at >= ?1 AND o.paid_at < ?2) AS paid_out_minor
     FROM barbers b ORDER BY revenue_minor DESC, b.sort_order`, r.from, r.to);

  const byService = all<any>(
    `SELECT i.service_name AS name, COUNT(*) AS count, COALESCE(SUM(i.price_minor), 0) AS revenue_minor
     FROM appointment_items i JOIN appointments a ON a.id = i.appointment_id
     WHERE a.status = 'completed' AND a.completed_at >= ? AND a.completed_at < ? GROUP BY i.service_name ORDER BY revenue_minor DESC`, r.from, r.to);
  const bookedServices = all<any>(
    `SELECT i.service_name AS name, COUNT(*) AS count FROM appointment_items i JOIN appointments a ON a.id = i.appointment_id
     WHERE a.status NOT IN ('cancelled') AND a.starts_at >= ? AND a.starts_at < ? GROUP BY i.service_name ORDER BY count DESC`, r.from, r.to);
  const bySource = all<any>('SELECT source, COUNT(*) AS count FROM appointments WHERE starts_at >= ? AND starts_at < ? GROUP BY source ORDER BY count DESC', r.from, r.to);

  // Daily series in the shop timezone.
  const days = new Map<string, { date: string; appointments: number; revenue_minor: number; collected_minor: number }>();
  for (let d = r.fromDate; d <= r.toDate && days.size < 400; d = addDays(d, 1)) days.set(d, { date: d, appointments: 0, revenue_minor: 0, collected_minor: 0 });
  const bump = (ms: number, key: 'appointments' | 'revenue_minor' | 'collected_minor', v: number) => {
    const row = days.get(zoned(ms, tz).date);
    if (row) row[key] += v;
  };
  for (const a of all<any>("SELECT starts_at FROM appointments WHERE status <> 'cancelled' AND starts_at >= ? AND starts_at < ?", r.from, r.to)) bump(a.starts_at, 'appointments', 1);
  for (const a of all<any>("SELECT completed_at, total_minor FROM appointments WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?", r.from, r.to)) bump(a.completed_at, 'revenue_minor', a.total_minor);
  for (const p of all<any>('SELECT created_at, amount_minor FROM payments WHERE created_at >= ? AND created_at < ?', r.from, r.to)) bump(p.created_at, 'collected_minor', p.amount_minor);

  const rate = (n: number) => (appointments ? Math.round((n / appointments) * 1000) / 10 : 0);
  return {
    range: { from: r.fromDate, to: r.toDate },
    appointments: { total: appointments, byStatus, cancellation_rate: rate(byStatus.cancelled), no_show_rate: rate(byStatus.no_show), completed_services: completedServices },
    money: {
      service_revenue_minor: serviceRevenue,
      payments_received_minor: paymentsReceived,
      refunds_minor: refunds,
      adjustments_minor: adjustments,
      net_collected_minor: netCollected,
      cash_collected_minor: cashCollected,
      non_cash_collected_minor: netCollected - cashCollected,
      outstanding_period_minor: outstandingPeriod,
      outstanding_total_minor: outstandingTotal,
      refunds_due_minor: refundsDue,
      compensation_earned_minor: compensationEarned,
      payouts_paid_minor: payoutsPaid,
      compensation_owed_minor: compensationOwed,
      expenses_minor: expenses,
      // Accrual view: what the period's work produced for the business.
      operating_result_minor: serviceRevenue - compensationEarned - expenses,
      // Cash view: what actually moved. Payouts are subtracted here only.
      net_cash_flow_minor: netCollected - payoutsPaid - expenses,
    },
    byMethod, byBarber, byService, bookedServices, bySource, daily: [...days.values()],
  };
}

export function customerStats(customerId: number) {
  const visits = sum("SELECT COUNT(*) AS n FROM appointments WHERE customer_id = ? AND status = 'completed'", customerId);
  const paid = sum('SELECT COALESCE(SUM(amount_minor), 0) AS n FROM payments WHERE customer_id = ?', customerId);
  const outstanding = sum(
    `SELECT COALESCE(SUM(MAX(a.total_minor - (SELECT COALESCE(SUM(p.amount_minor), 0) FROM payments p WHERE p.appointment_id = a.id), 0)), 0) AS n
     FROM appointments a WHERE a.customer_id = ? AND a.status = 'completed'`, customerId);
  const noShows = sum("SELECT COUNT(*) AS n FROM appointments WHERE customer_id = ? AND status = 'no_show'", customerId);
  const last = get<any>("SELECT MAX(starts_at) AS n FROM appointments WHERE customer_id = ? AND status = 'completed'", customerId)?.n ?? null;
  const next = get<any>("SELECT MIN(starts_at) AS n FROM appointments WHERE customer_id = ? AND status IN ('pending','confirmed') AND starts_at > ?", customerId, Date.now())?.n ?? null;
  return { visits, total_paid_minor: paid, outstanding_minor: outstanding, no_shows: noShows, last_visit: last, next_appointment: next };
}

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { at, client, db, fixture, key, nextWeekday, start, stop, time, getSettings } from './helper.ts';

let fx: ReturnType<typeof fixture>;
const owner = client();
const ben = client();
const cal = client();
let day: string;
let hour = 9;

before(async () => {
  await start();
  fx = fixture();
  await owner.login('owner@test.dev');
  await ben.login('ben@test.dev');
  await cal.login('cal@test.dev');
  day = nextWeekday(2, 3);
});
after(stop);

/** Books a haircut (25.000) on the given barber at the next free hour and returns its id. */
async function book(barber: number, serviceIds = [fx.services.cut]) {
  if (hour === 13) hour++;
  if (hour >= 18) { hour = 9; day = time.addDays(day, time.weekdayOf(day) === 6 ? 2 : 1); }
  const r = await owner.post('/staff/appointments', { customer: { id: fx.customer }, serviceIds, barber, start: at(day, `${String(hour++).padStart(2, '0')}:00`), source: 'phone' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.appointment.id as number;
}
const status = (c: ReturnType<typeof client>, id: number, s: string, extra = {}) => c.post(`/staff/appointments/${id}/status`, { status: s, ...extra });
const pay = (c: ReturnType<typeof client>, id: number, amountMinor: number, extra: Record<string, unknown> = {}) =>
  c.post(`/staff/appointments/${id}/payments`, { amountMinor, method: 'cash', idempotencyKey: key(), ...extra });
const report = async () => {
  const tz = getSettings().timezone;
  const today = time.today(tz);
  return (await owner.get(`/admin/reports?from=${time.addDays(today, -1)}&to=${today}`)).body;
};
const ledgerSum = () => db.get<any>('SELECT COALESCE(SUM(amount_minor), 0) AS n FROM payments')!.n as number;

test('lifecycle: check-in, start and completion are recorded; completion does not imply payment', async () => {
  const id = await book(fx.b1.id);
  assert.equal((await status(ben, id, 'checked_in')).body.appointment.status, 'checked_in');
  assert.equal((await status(ben, id, 'in_progress')).body.appointment.status, 'in_progress');
  const done = (await status(ben, id, 'completed')).body.appointment;
  assert.equal(done.status, 'completed');
  assert.ok(done.completed_at && done.checked_in_at && done.started_at);
  assert.equal(done.completed_by_name, 'Ben Barber');
  assert.equal(done.paid_minor, 0);
  assert.equal(done.balance_minor, 25_000);
  assert.equal(done.payment_status, 'unpaid');

  const r = await report();
  assert.equal(r.money.service_revenue_minor, 25_000, 'revenue counts the service performed');
  assert.equal(r.money.net_collected_minor, 0, 'nothing has been collected yet');
  assert.equal(r.money.outstanding_total_minor, 25_000);
});

test('repeating the completion action creates no duplicate revenue or compensation', async () => {
  const id = db.get<any>("SELECT id FROM appointments WHERE status = 'completed'")!.id;
  const before = await report();
  const first = db.get<any>('SELECT completed_at FROM appointments WHERE id = ?', id)!.completed_at;
  for (let i = 0; i < 3; i++) assert.equal((await status(ben, id, 'completed')).status, 200);
  const after = await report();
  assert.equal(after.money.service_revenue_minor, before.money.service_revenue_minor);
  assert.equal(after.appointments.completed_services, 1);
  assert.equal(db.get<any>('SELECT completed_at FROM appointments WHERE id = ?', id)!.completed_at, first, 'original timestamp is kept');
  assert.equal(db.all('SELECT 1 FROM barber_earnings WHERE appointment_id = ?', id).length, 1);
  assert.equal(after.money.compensation_earned_minor, 11_250, '45% of 25.000, once');
});

test('partial payments, outstanding balance, overpayment and duplicate-submission protection', async () => {
  const id = db.get<any>("SELECT id FROM appointments WHERE status = 'completed'")!.id;
  const p1 = await pay(ben, id, 10_000);
  assert.equal(p1.status, 201);
  assert.equal(p1.body.appointment.balance_minor, 15_000);
  assert.equal(p1.body.appointment.payment_status, 'partial');

  const over = await pay(ben, id, 20_000);
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'OVERPAYMENT');

  const k = key();
  const p2 = await pay(ben, id, 15_000, { method: 'card', idempotencyKey: k, reference: 'TPE-881' });
  const p2again = await pay(ben, id, 15_000, { method: 'card', idempotencyKey: k });
  assert.equal(p2.status, 201);
  assert.equal(p2again.status, 200);
  assert.equal(p2again.body.duplicate, true);
  assert.equal(p2.body.appointment.payments.length, 2, 'two payments against one appointment');
  assert.equal(p2again.body.appointment.payments.length, 2, 'the double submit added nothing');
  assert.equal(p2.body.appointment.balance_minor, 0);
  assert.equal(p2.body.appointment.payment_status, 'paid');

  const r = await report();
  assert.equal(r.money.net_collected_minor, 25_000);
  assert.equal(r.money.cash_collected_minor, 10_000);
  assert.equal(r.money.non_cash_collected_minor, 15_000);
  assert.equal(r.money.outstanding_total_minor, 0);
  assert.equal(r.money.net_collected_minor, ledgerSum(), 'report reconciles with the ledger');
});

test('refunds and corrections are appended, traceable, and reconcile', async () => {
  const id = db.get<any>("SELECT id FROM appointments WHERE status = 'completed'")!.id;
  assert.equal((await ben.post(`/admin/appointments/${id}/refund`, { amountMinor: 5_000, method: 'cash', idempotencyKey: key() })).status, 403, 'barbers cannot refund');
  const tooMuch = await owner.post(`/admin/appointments/${id}/refund`, { amountMinor: 30_000, method: 'cash', idempotencyKey: key() });
  assert.equal(tooMuch.body.error.code, 'OVER_REFUND');
  const refund = await owner.post(`/admin/appointments/${id}/refund`, { amountMinor: 5_000, method: 'cash', note: 'Goodwill', idempotencyKey: key() });
  assert.equal(refund.status, 201);
  assert.equal(refund.body.appointment.paid_minor, 20_000);

  // A mistaken card entry is voided, never edited or deleted.
  const card = refund.body.appointment.payments.find((p: any) => p.method === 'card');
  const voided = await owner.post(`/admin/payments/${card.id}/void`, { reason: 'Entered on the wrong appointment' });
  assert.equal(voided.status, 200);
  assert.equal(voided.body.appointment.paid_minor, 5_000);
  const again = await owner.post(`/admin/payments/${card.id}/void`, { reason: 'again' });
  assert.equal(again.body.error.code, 'ALREADY_VOIDED');
  const rows = voided.body.appointment.payments;
  assert.equal(rows.length, 4, 'payment, payment, refund, adjustment are all still there');
  assert.equal(rows.find((p: any) => p.kind === 'adjustment').reverses_payment_id, card.id);
  assert.throws(() => db.run('UPDATE payments SET amount_minor = 1 WHERE id = ?', card.id), /LEDGER_IMMUTABLE/);
  assert.throws(() => db.run('DELETE FROM payments WHERE id = ?', card.id), /LEDGER_IMMUTABLE/);

  const r = await report();
  assert.equal(r.money.payments_received_minor, 25_000);
  assert.equal(r.money.refunds_minor, 5_000);
  assert.equal(r.money.adjustments_minor, -15_000);
  assert.equal(r.money.net_collected_minor, 5_000);
  assert.equal(r.money.net_collected_minor, ledgerSum());
  assert.equal(r.money.outstanding_total_minor, 20_000);
  assert.equal(r.byMethod.reduce((n: number, m: any) => n + m.net_minor, 0), ledgerSum(), 'method breakdown sums to the ledger');
  assert.equal(r.money.service_revenue_minor, 25_000, 'refunds do not rewrite service revenue');

  const audit = db.all<any>("SELECT action FROM audit_log WHERE action LIKE 'payment.%'").map((a) => a.action);
  for (const a of ['payment.record', 'payment.refund', 'payment.void']) assert.ok(audit.includes(a), `${a} is in the audit log`);
});

test('changing a service price never rewrites historical appointments', async () => {
  const id = await book(fx.b1.id);
  const patch = await owner.patch(`/admin/services/${fx.services.cut}`, { price_minor: 40_000, name: 'Premium Haircut' });
  assert.equal(patch.status, 200);
  const old = (await owner.get(`/staff/appointments/${id}`)).body.appointment;
  assert.equal(old.total_minor, 25_000);
  assert.equal(old.items[0].service_name, 'Haircut');
  assert.equal(old.items[0].price_minor, 25_000);
  const fresh = (await owner.get(`/staff/appointments/${await book(fx.b1.id)}`)).body.appointment;
  assert.equal(fresh.total_minor, 40_000, 'new bookings use the new price');
  await owner.patch(`/admin/services/${fx.services.cut}`, { price_minor: 25_000, name: 'Haircut' });
});

test('compensation follows the configured rule and rule changes are not retroactive', async () => {
  const before = (await owner.get(`/admin/barbers/${fx.b1.id}`)).body.ledger.balance;
  assert.equal(before.earned_minor, 11_250);

  const change = await owner.post(`/admin/barbers/${fx.b1.id}/compensation`, { model: 'fixed_per_service', basis: 'completed', fixed_minor: 7_000 });
  assert.equal(change.status, 200);
  assert.equal((await owner.get(`/admin/barbers/${fx.b1.id}`)).body.ledger.balance.earned_minor, 11_250, 'earlier earnings are untouched');

  const id = await book(fx.b1.id);
  await status(ben, id, 'completed');
  const ledger = (await owner.get(`/admin/barbers/${fx.b1.id}`)).body.ledger;
  assert.equal(ledger.balance.earned_minor, 18_250, 'new service earns the new fixed amount');
  assert.equal(JSON.parse(ledger.earnings[0].rule_snapshot).model, 'fixed_per_service');
  assert.equal(JSON.parse(ledger.earnings.at(-1).rule_snapshot).model, 'commission');
});

test('"paid in full" basis: compensation is earned only once the customer has paid', async () => {
  const id = await book(fx.b2.id);
  await status(cal, id, 'completed');
  assert.equal((await cal.get('/staff/earnings')).body.balance.earned_minor, 0, 'completed but unpaid earns nothing yet');
  await pay(cal, id, 10_000);
  assert.equal((await cal.get('/staff/earnings')).body.balance.earned_minor, 0, 'partial payment is not enough');
  await pay(cal, id, 15_000);
  assert.equal((await cal.get('/staff/earnings')).body.balance.earned_minor, 10_000, '40% of 25.000 once fully paid');
  await status(cal, id, 'completed');
  assert.equal(db.all('SELECT 1 FROM barber_earnings WHERE appointment_id = ?', id).length, 1);
});

test('payouts reduce what is owed without touching revenue or collections', async () => {
  const before = await report();
  const over = await owner.post(`/admin/barbers/${fx.b1.id}/payouts`, { amountMinor: 99_000, method: 'cash', idempotencyKey: key() });
  assert.equal(over.body.error.code, 'OVER_PAYOUT');

  const k = key();
  const paid = await owner.post(`/admin/barbers/${fx.b1.id}/payouts`, { amountMinor: 10_000, method: 'bank_transfer', reference: 'VIR-1', idempotencyKey: k });
  const dup = await owner.post(`/admin/barbers/${fx.b1.id}/payouts`, { amountMinor: 10_000, method: 'bank_transfer', reference: 'VIR-1', idempotencyKey: k });
  assert.equal(paid.status, 201);
  assert.equal(dup.status, 200);
  assert.deepEqual(paid.body.ledger.balance, { earned_minor: 18_250, paid_minor: 10_000, owed_minor: 8_250 });
  assert.equal(dup.body.ledger.payouts.length, 1, 'a double submit does not pay twice');

  const rest = await owner.post(`/admin/barbers/${fx.b1.id}/payouts`, { amountMinor: 8_251, method: 'cash', idempotencyKey: key() });
  assert.equal(rest.status, 409, 'cannot pay out more than what remains owed');

  const after = await report();
  assert.equal(after.money.service_revenue_minor, before.money.service_revenue_minor);
  assert.equal(after.money.net_collected_minor, before.money.net_collected_minor);
  assert.equal(after.money.payouts_paid_minor, 10_000);
  assert.equal(after.money.compensation_earned_minor, before.money.compensation_earned_minor, 'a payout is not a new expense');
  assert.equal(after.money.net_cash_flow_minor, after.money.net_collected_minor - 10_000 - after.money.expenses_minor, 'payouts are subtracted exactly once');
  assert.equal(after.money.operating_result_minor, after.money.service_revenue_minor - after.money.compensation_earned_minor - after.money.expenses_minor);

  const payout = paid.body.ledger.payouts[0];
  const voided = await owner.post(`/admin/payouts/${payout.id}/void`, { reason: 'Transfer bounced' });
  assert.equal(voided.status, 200);
  assert.equal((await owner.get(`/admin/barbers/${fx.b1.id}`)).body.ledger.balance.owed_minor, 18_250);
  assert.throws(() => db.run('DELETE FROM payouts WHERE id = ?', payout.id), /LEDGER_IMMUTABLE/);
});

test('salary accruals cannot be recorded twice for the same month', async () => {
  const a = await owner.post(`/admin/barbers/${fx.b2.id}/earnings`, { kind: 'salary', amountMinor: 900_000, period: '2026-09' });
  const b = await owner.post(`/admin/barbers/${fx.b2.id}/earnings`, { kind: 'salary', amountMinor: 900_000, period: '2026-09' });
  assert.equal(a.status, 201);
  assert.equal(b.body.error.code, 'DUPLICATE_SALARY');
});

test('cancellations, no-shows and invalid transitions', async () => {
  const id = await book(fx.b1.id);
  const early = await status(ben, id, 'no_show');
  assert.equal(early.body.error.code, 'TOO_EARLY', 'a future appointment cannot be a no-show');
  const cancelled = await status(ben, id, 'cancelled', { reason: 'Customer called' });
  assert.equal(cancelled.body.appointment.cancel_reason, 'Customer called');
  assert.equal((await status(ben, id, 'completed')).body.error.code, 'INVALID_TRANSITION');
  assert.equal((await pay(ben, id, 5_000)).status, 409, 'no payments on a cancelled appointment');
  await status(ben, id, 'cancelled');
  assert.equal(db.all("SELECT 1 FROM notifications WHERE type = 'booking_cancelled' AND appointment_id = ?", id).length, 1, 'cancelling twice sends one email');

  // A past appointment can be a genuine no-show and earns nothing.
  const past = db.run(
    `INSERT INTO appointments (reference, customer_id, barber_id, starts_at, ends_at, blocked_until, status, source, total_minor, currency, created_at, updated_at)
     VALUES ('CB-PAST01', ?, ?, ?, ?, ?, 'confirmed', 'phone', 25000, 'TND', 1, 1)`, fx.customer, fx.b1.id, Date.now() - 7_200_000, Date.now() - 5_400_000, Date.now() - 5_400_000).id;
  assert.equal((await status(ben, past, 'no_show')).body.appointment.status, 'no_show');
  assert.equal(db.all('SELECT 1 FROM barber_earnings WHERE appointment_id = ?', past).length, 0);
  const r = await report();
  assert.equal(r.appointments.byStatus.no_show, 1);
});

test('customer totals come from the payment ledger, and CSV export works', async () => {
  const c = (await owner.get(`/admin/customers/${fx.customer}`)).body;
  const paid = db.get<any>('SELECT COALESCE(SUM(amount_minor), 0) AS n FROM payments WHERE customer_id = ?', fx.customer)!.n;
  assert.equal(c.stats.total_paid_minor, paid);
  assert.ok(c.stats.outstanding_minor > 0);
  const tz = getSettings().timezone;
  const csv = await owner.get(`/admin/export/payments?from=${time.addDays(time.today(tz), -1)}&to=${time.today(tz)}`);
  assert.equal(csv.status, 200);
  assert.match(csv.body, /Entry,Date,Type,Amount/);
  assert.match(csv.body, /refund,-5\.000,TND/);
});

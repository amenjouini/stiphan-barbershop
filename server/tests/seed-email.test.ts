import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

// This file uses a real database file to prove persistence across restarts.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clubbarber-test-'));
process.env.DATABASE_PATH = path.join(dir, 'test.db');

const { at, client, db, nextWeekday, start, stop, getSettings, time } = await import('./helper.ts');
const { seedDemo, DEMO } = await import('../seed.ts');
const { config } = await import('../config.ts');
const notifications = await import('../services/notifications.ts');
const { resetSettingsCache } = await import('../lib/settings.ts');

const counts = () => Object.fromEntries(['users', 'barbers', 'services', 'customers', 'appointments', 'payments', 'barber_earnings', 'payouts', 'expenses']
  .map((t) => [t, db.get<any>(`SELECT COUNT(*) AS n FROM ${t}`)!.n]));
const owner = client();

before(async () => {
  await start();
  assert.equal(seedDemo(), true);
  await owner.login(DEMO.owner.email, DEMO.owner.password);
});
after(async () => {
  await stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('demo seeding is repeatable without duplicating records', () => {
  const before = counts();
  assert.ok(before.appointments > 40 && before.payments > 20 && before.barbers === 4);
  assert.equal(seedDemo(), false);
  assert.equal(seedDemo(), false);
  assert.deepEqual(counts(), before);
});

test('seeded financial data reconciles end to end', async () => {
  const tz = getSettings().timezone;
  const today = time.today(tz);
  const r = (await owner.get(`/admin/reports?from=${time.addDays(today, -60)}&to=${today}`)).body;
  const sum = (sql: string) => db.get<any>(sql)!.n as number;
  const ledger = sum('SELECT COALESCE(SUM(amount_minor), 0) AS n FROM payments');
  assert.equal(r.money.net_collected_minor, ledger, 'net collected = sum of the payment ledger');
  assert.equal(r.money.payments_received_minor - r.money.refunds_minor + r.money.adjustments_minor, ledger);
  assert.equal(r.byMethod.reduce((n: number, m: any) => n + m.net_minor, 0), ledger);
  assert.equal(r.daily.reduce((n: number, d: any) => n + d.collected_minor, 0), ledger, 'daily series adds up to the ledger');

  const revenue = sum("SELECT COALESCE(SUM(total_minor), 0) AS n FROM appointments WHERE status = 'completed'");
  assert.equal(r.money.service_revenue_minor, revenue);
  assert.equal(r.byBarber.reduce((n: number, b: any) => n + b.revenue_minor, 0), revenue, 'revenue by barber adds up');
  assert.equal(r.byService.reduce((n: number, s: any) => n + s.revenue_minor, 0), revenue, 'revenue by service adds up');
  assert.equal(sum("SELECT COALESCE(SUM(i.price_minor), 0) AS n FROM appointment_items i") , sum('SELECT COALESCE(SUM(total_minor), 0) AS n FROM appointments'), 'line items add up to appointment totals');

  // revenue = collected on completed services + still outstanding (no appointment is over-paid)
  const collectedOnCompleted = sum("SELECT COALESCE(SUM(p.amount_minor), 0) AS n FROM payments p JOIN appointments a ON a.id = p.appointment_id WHERE a.status = 'completed'");
  assert.equal(revenue, collectedOnCompleted + r.money.outstanding_total_minor);
  assert.ok(r.money.outstanding_total_minor > 0 && r.money.refunds_minor === 5000);

  const payroll = (await owner.get('/admin/payroll')).body;
  assert.equal(payroll.totals.owed_minor, payroll.totals.earned_minor - payroll.totals.paid_minor);
  assert.equal(payroll.totals.owed_minor, r.money.compensation_owed_minor);
  for (const b of payroll.barbers) assert.ok(b.owed_minor >= 0, `${b.name} is not over-paid`);
  assert.ok(payroll.totals.paid_minor > 0);
  assert.equal(db.all("SELECT 1 FROM barber_earnings e JOIN appointments a ON a.id = e.appointment_id WHERE a.status <> 'completed'").length, 0, 'only completed services earn compensation');
  assert.equal(db.all('SELECT appointment_id FROM barber_earnings WHERE appointment_id IS NOT NULL GROUP BY appointment_id HAVING COUNT(*) > 1').length, 0);
  assert.equal(db.all(
    `SELECT 1 FROM appointments a JOIN appointments b ON a.barber_id = b.barber_id AND a.id < b.id
     WHERE a.status NOT IN ('cancelled','no_show') AND b.status NOT IN ('cancelled','no_show') AND a.starts_at < b.blocked_until AND b.starts_at < a.blocked_until`).length, 0, 'no overlapping appointments anywhere');
});

test('every demo role can sign in and lands on its own data', async () => {
  const barber = client();
  assert.equal((await barber.login(DEMO.barber.email, DEMO.barber.password)).role, 'barber');
  assert.equal((await barber.get('/staff/summary')).body.has_chair, true);
  assert.equal((await barber.get('/admin/overview')).status, 403);
  const customer = client();
  assert.equal((await customer.login(DEMO.customer.email, DEMO.customer.password)).role, 'customer');
  const mine = (await customer.get('/me/appointments')).body;
  assert.equal(mine.upcoming.length, 1);
  assert.ok(mine.past.length >= 2);
  const overview = (await owner.get('/admin/overview')).body;
  assert.ok(overview.report.daily.length > 0 && overview.recent.length > 0);
});

test('emails: simulated delivery is labelled as such, and status updates never send duplicates', async () => {
  db.run('DELETE FROM notifications');
  const date = nextWeekday(2, 3);
  const r = await owner.post('/staff/appointments', { customer: { name: 'Mail Test', email: 'mail@test.dev' }, serviceIds: [1], start: at(date, '12:15'), source: 'phone' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.appointment.id;
  const mail = db.get<any>("SELECT * FROM notifications WHERE appointment_id = ? AND type = 'booking_confirmation'", id);
  assert.equal(mail.status, 'queued');
  for (const needle of [r.body.appointment.reference, 'Coupe classique', 'Stiphan Mansour', 'Club Barber', '25.000 TND', '/manage/' + r.body.appointment.reference]) {
    assert.ok(mail.html.includes(needle), `confirmation email contains ${needle}`);
  }

  await notifications.processQueue();
  assert.equal(db.get<any>('SELECT status FROM notifications WHERE id = ?', mail.id)!.status, 'simulated', 'never reported as sent without SMTP');

  for (let i = 0; i < 3; i++) await owner.post(`/staff/appointments/${id}/reschedule`, { start: at(date, '11:30') });
  for (let i = 0; i < 3; i++) await owner.post(`/staff/appointments/${id}/status`, { status: 'cancelled', reason: 'Test' });
  const types = db.all<any>('SELECT type FROM notifications WHERE appointment_id = ? ORDER BY id', id).map((n) => n.type);
  assert.deepEqual(types, ['booking_confirmation', 'booking_rescheduled', 'booking_cancelled']);
});

test('emails: a failing provider is recorded as failed/retrying and never blocks the booking', async () => {
  db.run('DELETE FROM notifications');
  Object.assign(config.smtp, { host: '127.0.0.1', port: 9, user: '', pass: '' }); // nothing listens here
  const date = nextWeekday(4, 3);
  const r = await owner.post('/staff/appointments', { customer: { name: 'Fail Mail', email: 'fail@test.dev' }, serviceIds: [1], start: at(date, '12:15'), source: 'phone' });
  assert.equal(r.status, 201, 'the booking succeeds even though email is down');
  await notifications.processQueue();
  const n = db.get<any>('SELECT * FROM notifications WHERE appointment_id = ?', r.body.appointment.id);
  assert.equal(n.status, 'queued', 'kept for retry');
  assert.equal(n.attempts, 1);
  assert.ok(n.last_error, 'the provider error is stored');
  assert.ok(n.next_attempt_at > Date.now(), 'retry is scheduled with back-off');
  assert.equal(n.sent_at, null);

  db.run('UPDATE notifications SET attempts = 4, next_attempt_at = 0 WHERE id = ?', n.id);
  await notifications.processQueue();
  assert.equal(db.get<any>('SELECT status FROM notifications WHERE id = ?', n.id)!.status, 'failed', 'gives up after the last attempt');
  const outbox = (await owner.get('/admin/notifications?status=failed')).body;
  assert.equal(outbox.notifications.length, 1, 'failure is visible to the owner');
  assert.equal((await owner.post(`/admin/notifications/${n.id}/retry`)).status, 200);
  config.smtp.host = '';
});

test('reminders are queued once per appointment', () => {
  db.run('DELETE FROM notifications');
  const soon = db.run(
    `INSERT INTO appointments (reference, customer_id, barber_id, starts_at, ends_at, blocked_until, status, source, total_minor, currency, created_at, updated_at)
     VALUES ('CB-REMIND', (SELECT id FROM customers WHERE email IS NOT NULL LIMIT 1), 1, ?, ?, ?, 'confirmed', 'phone', 25000, 'TND', 1, 1)`,
    Date.now() + 400 * 86_400_000, Date.now() + 400 * 86_400_000 + 1_800_000, Date.now() + 400 * 86_400_000 + 1_800_000).id;
  const now = Date.now() + 400 * 86_400_000 - 3 * 3_600_000;
  assert.equal(notifications.enqueueReminders(now), 1);
  assert.equal(notifications.enqueueReminders(now), 0);
  assert.equal(db.all("SELECT 1 FROM notifications WHERE type = 'booking_reminder' AND appointment_id = ?", soon).length, 1);
});

test('records survive an application restart', async () => {
  const before = counts();
  const ref = db.get<any>('SELECT reference FROM appointments ORDER BY id DESC LIMIT 1')!.reference;
  await stop();
  resetSettingsCache();
  await start();
  assert.deepEqual(counts(), before);
  assert.ok(db.get('SELECT 1 FROM appointments WHERE reference = ?', ref));
  const again = client();
  await again.login(DEMO.owner.email, DEMO.owner.password);
  assert.equal((await again.get('/admin/overview')).status, 200);
});

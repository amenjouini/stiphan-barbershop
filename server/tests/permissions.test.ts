import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { at, client, db, fixture, guestBook, key, nextWeekday, saveSettings, start, stop } from './helper.ts';

let fx: ReturnType<typeof fixture>;
const anon = client();
const owner = client();
const ben = client();
const cal = client();
const cora = client();
const otto = client();
let day: string;
let benAppt: number, calAppt: number, coraAppt: number, ottoAppt: number;

before(async () => {
  await start();
  fx = fixture();
  await owner.login('owner@test.dev');
  await ben.login('ben@test.dev');
  await cal.login('cal@test.dev');
  await cora.login('cust@test.dev');
  await otto.login('other@test.dev');
  day = nextWeekday(2, 3);
  const mk = async (barber: number, customer: number, time: string) =>
    (await owner.post('/staff/appointments', { customer: { id: customer }, serviceIds: [fx.services.cut], barber, start: at(day, time), source: 'phone' })).body.appointment.id as number;
  benAppt = await mk(fx.b1.id, fx.customer, '09:00');
  calAppt = await mk(fx.b2.id, fx.other, '09:00');
  coraAppt = benAppt;
  ottoAppt = calAppt;
});
after(stop);

test('anonymous visitors cannot reach staff, admin or account APIs', async () => {
  for (const path of ['/staff/appointments', '/staff/summary', '/admin/overview', '/admin/payments', '/admin/customers', '/me/appointments']) {
    assert.equal((await anon.get(path)).status, 401, path);
  }
  assert.equal((await anon.get('/public/shop')).status, 200);
});

test('state-changing requests without the CSRF header are blocked', async () => {
  const r = await owner.raw('POST', '/auth/logout', {}, { 'x-requested-with': '' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'CSRF');
  const cross = await owner.raw('POST', '/auth/logout', {}, { origin: 'https://evil.example' });
  assert.equal(cross.status, 403, 'foreign Origin is rejected');
  assert.equal((await owner.get('/auth/me')).body.user.role, 'owner', 'still signed in');
});

test('a barber cannot use any admin API', async () => {
  const gets = ['/admin/overview', '/admin/reports', '/admin/payments', '/admin/customers', `/admin/customers/${fx.customer}`, '/admin/barbers', `/admin/barbers/${fx.b2.id}`,
    '/admin/payroll', '/admin/settings', '/admin/audit', '/admin/notifications', '/admin/expenses', '/admin/services', '/admin/export/payments'];
  for (const path of gets) assert.equal((await ben.get(path)).status, 403, path);
  assert.equal((await ben.put('/admin/settings', { shop_name: 'Hacked' })).status, 403);
  assert.equal((await ben.post(`/admin/barbers/${fx.b1.id}/compensation`, { model: 'commission', commission_bps: 10000 })).status, 403);
  assert.equal((await ben.post(`/admin/barbers/${fx.b1.id}/payouts`, { amountMinor: 1000, method: 'cash', idempotencyKey: key() })).status, 403);
  assert.equal((await ben.patch(`/admin/barbers/${fx.b2.id}`, { is_active: false })).status, 403);
  assert.equal((await ben.post('/admin/services', { name: 'Free cut', price_minor: 0, duration_min: 30 })).status, 403);
});

test('a barber only sees and manages appointments on their own chair', async () => {
  const list = (await ben.get(`/staff/appointments?from=${day}&to=${day}&barber=${fx.b2.id}`)).body.appointments;
  assert.ok(list.length > 0 && list.every((a: any) => a.barber_id === fx.b1.id), 'the barber filter is forced to self');
  assert.equal((await ben.get(`/staff/appointments/${calAppt}`)).status, 403);
  assert.equal((await ben.post(`/staff/appointments/${calAppt}/status`, { status: 'cancelled' })).status, 403);
  assert.equal((await ben.post(`/staff/appointments/${calAppt}/payments`, { amountMinor: 1000, method: 'cash', idempotencyKey: key() })).status, 403);
  assert.equal((await ben.post(`/staff/appointments/${calAppt}/reschedule`, { start: at(day, '15:00') })).status, 403);

  // Booking onto someone else's chair is silently pinned to their own.
  const mine = await ben.post('/staff/appointments', { customer: { name: 'Sneaky' }, serviceIds: [fx.services.cut], barber: fx.b2.id, start: at(day, '16:00'), source: 'phone' });
  assert.equal(mine.body.appointment.barber_id, fx.b1.id);
  assert.equal((await ben.post('/staff/appointments', { customer: { name: 'Cheap' }, serviceIds: [fx.services.cut], start: at(day, '17:00'), source: 'phone', priceMinor: 1 })).status, 403, 'custom prices are owner-only');
  assert.equal((await ben.patch(`/staff/appointments/${benAppt}`, { total_minor: 1 })).status, 403);
  assert.equal((await ben.post('/staff/time-off', { barber_id: fx.b2.id, kind: 'day_off', from_date: day })).status, 403);

  // Own appointment: detail hides the customer's money history and owner-only notes.
  const own = await ben.get(`/staff/appointments/${benAppt}`);
  assert.equal(own.status, 200);
  assert.equal(own.body.customer.total_paid_minor, undefined);
  assert.equal(own.body.customer.notes, undefined);
  assert.equal(own.body.permissions.refund, false);
});

test('owner-configurable barber permissions are enforced on the server', async () => {
  saveSettings({ barbers_record_payments: false, barbers_see_earnings: false });
  assert.equal((await ben.post(`/staff/appointments/${benAppt}/payments`, { amountMinor: 1000, method: 'cash', idempotencyKey: key() })).status, 403);
  assert.equal((await ben.get('/staff/earnings')).status, 403);
  assert.equal((await ben.get('/staff/summary')).body.earnings, null);
  saveSettings({ barbers_record_payments: true, barbers_see_earnings: true });
  assert.equal((await ben.get('/staff/earnings')).status, 200);
});

test('the owner can do both barber work and administration', async () => {
  const mine = await owner.post('/staff/appointments', { customer: { name: 'Owner Regular', phone: '+216 20 000 999' }, serviceIds: [fx.services.cut], start: at(day, '10:00'), source: 'walk_in' });
  assert.equal(mine.status, 201);
  assert.equal(mine.body.appointment.barber_id, fx.owner.barberId, 'defaults to the owner’s own chair');
  const id = mine.body.appointment.id;
  assert.equal((await owner.post(`/staff/appointments/${id}/status`, { status: 'completed' })).body.appointment.status, 'completed');
  assert.equal((await owner.post(`/staff/appointments/${id}/payments`, { amountMinor: 25_000, method: 'cash', idempotencyKey: key() })).status, 201);
  assert.equal((await owner.get('/staff/summary')).body.has_chair, true);
  // ...and may act on any barber's appointment and every admin area.
  assert.equal((await owner.post(`/staff/appointments/${calAppt}/status`, { status: 'checked_in' })).status, 200);
  for (const path of ['/admin/overview', '/admin/reports', '/admin/payroll', '/admin/customers', '/admin/audit']) assert.equal((await owner.get(path)).status, 200, path);
  assert.equal((await owner.patch(`/staff/appointments/${benAppt}`, { total_minor: 20_000 })).body.appointment.total_minor, 20_000);
});

test('customers only ever see their own records', async () => {
  for (const path of ['/staff/appointments', `/staff/appointments/${coraAppt}`, '/admin/customers', '/admin/overview', '/staff/customers/search?q=ot']) {
    assert.equal((await cora.get(path)).status, 403, path);
  }
  const mine = (await cora.get('/me/appointments')).body;
  const all = [...mine.upcoming, ...mine.past];
  assert.ok(all.some((a: any) => a.id === coraAppt));
  assert.ok(!all.some((a: any) => a.id === ottoAppt));
  assert.equal(all[0].internal_note, undefined, 'internal notes are never sent to customers');

  assert.equal((await cora.get(`/me/appointments/${ottoAppt}`)).status, 404);
  assert.equal((await cora.post(`/me/appointments/${ottoAppt}/cancel`)).status, 404);
  assert.equal((await cora.post(`/me/appointments/${ottoAppt}/reschedule`, { start: at(day, '15:00') })).status, 404);
  assert.equal(db.get<any>('SELECT status FROM appointments WHERE id = ?', ottoAppt)!.status, 'checked_in', 'the other customer’s booking is untouched');

  await owner.post(`/staff/appointments/${coraAppt}/payments`, { amountMinor: 5_000, method: 'cash', idempotencyKey: key() });
  assert.equal((await cora.get('/me/payments')).body.payments.length, 1);
  assert.equal((await otto.get('/me/payments')).body.payments.length, 0);

  // A signed-in customer books under their own identity, whatever the form says.
  const booked = await cora.post('/public/bookings', { serviceIds: [fx.services.cut], barber: fx.b2.id, start: at(day, '11:00'), name: 'Otto Other', email: 'other@test.dev', phone: '+216 50 000 001' });
  assert.equal(booked.status, 201);
  assert.equal(db.get<any>('SELECT customer_id FROM appointments WHERE id = ?', booked.body.appointment.id)!.customer_id, fx.customer);
  assert.equal((await cora.post(`/me/appointments/${booked.body.appointment.id}/cancel`)).body.appointment.status, 'cancelled');
});

test('account lifecycle: register, verify, sign in; bad credentials; deactivated staff', async () => {
  const c = client();
  const reg = await c.post('/auth/register', { name: 'Nora New', email: 'nora@test.dev', phone: '+216 50 000 003', password: 'Password#1' });
  assert.equal(reg.body.needsVerification, true);
  assert.equal((await c.get('/auth/me')).body.user, null, 'not signed in before verifying');
  assert.equal((await c.post('/auth/login', { email: 'nora@test.dev', password: 'Password#1' })).body.error.code, 'NEEDS_VERIFICATION');
  assert.equal((await c.post('/auth/verify', { email: 'nora@test.dev', code: '000000' })).status, 400);
  const code = (await c.post('/auth/resend', { email: 'nora@test.dev' })).body.devCode;
  const ok = await c.post('/auth/verify', { email: 'nora@test.dev', code });
  assert.equal(ok.body.user.role, 'customer');
  assert.ok(ok.body.user.customerId);
  assert.equal((await c.post('/auth/register', { name: 'Nora Again', email: 'nora@test.dev', phone: '+216 50 000 003', password: 'Password#1' })).body.error.code, 'EMAIL_TAKEN');

  assert.equal((await client().post('/auth/login', { email: 'ben@test.dev', password: 'wrong' })).status, 401);
  assert.equal((await client().post('/auth/login', { email: 'nobody@test.dev', password: 'wrong' })).status, 401);
  const hash = db.get<any>("SELECT password_hash FROM users WHERE email = 'ben@test.dev'")!.password_hash;
  assert.match(hash, /^scrypt\$/, 'passwords are stored hashed');

  // Guest bookings with a registered email attach to that customer after email proof.
  const g = await guestBook(client(), { serviceIds: [fx.services.cut], barber: fx.b2.id, start: at(day, '14:00'), email: 'nora@test.dev' });
  assert.equal(g.status, 201);
  assert.ok((await c.get('/me/appointments')).body.upcoming.some((a: any) => a.id === g.body.appointment.id));

  // Deactivating a barber keeps their history but ends their access.
  const before = db.get<any>('SELECT COUNT(*) AS n FROM appointments WHERE barber_id = ?', fx.b2.id)!.n;
  assert.equal((await owner.patch(`/admin/barbers/${fx.b2.id}`, { is_active: false })).status, 200);
  assert.equal((await cal.get('/staff/appointments')).status, 401, 'existing session is revoked');
  assert.equal((await client().post('/auth/login', { email: 'cal@test.dev', password: 'Password#1' })).status, 403);
  assert.equal(db.get<any>('SELECT COUNT(*) AS n FROM appointments WHERE barber_id = ?', fx.b2.id)!.n, before, 'history is preserved');
  const shop = (await anon.get('/public/shop')).body;
  assert.ok(!shop.barbers.some((b: any) => b.id === fx.b2.id), 'no longer bookable online');
});

test('staff invitation link sets a password exactly once', async () => {
  const created = await owner.post('/admin/barbers', { name: 'Dan Newhire', email: 'dan@test.dev', create_login: true });
  assert.equal(created.status, 201);
  const token = created.body.invite_url.split('/invite/')[1];
  const c = client();
  assert.equal((await c.get(`/auth/invite/${token}`)).body.email, 'dan@test.dev');
  const accepted = await c.post('/auth/invite/accept', { token, password: 'Fresh#Pass1' });
  assert.equal(accepted.body.user.role, 'barber');
  assert.equal((await c.get('/staff/summary')).status, 200);
  assert.equal((await client().post('/auth/invite/accept', { token, password: 'Another#1' })).status, 400, 'the link cannot be reused');
});

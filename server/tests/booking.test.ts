import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { at, client, db, fixture, guestBook, nextWeekday, saveSettings, start, stop, time } from './helper.ts';

let fx: ReturnType<typeof fixture>;
const guest = client();
const owner = client();
const ben = client();
let tue: string;

before(async () => {
  await start();
  fx = fixture();
  await owner.login('owner@test.dev');
  await ben.login('ben@test.dev');
  tue = nextWeekday(2, 3);
});
after(stop);

const slots = async (date: string, services: number[], barber: number | 'any' = 'any') =>
  (await guest.get(`/public/availability?date=${date}&services=${services.join(',')}&barber=${barber}`)).body.slots.map((s: any) => s.start) as number[];

test('availability respects working hours, breaks, closed days and days off', async () => {
  const s = await slots(tue, [fx.services.cut], fx.b1.id);
  assert.equal(s[0], at(tue, '09:00'), 'first slot is opening time');
  assert.ok(s.includes(at(tue, '12:30')), '12:30 fits before the break');
  assert.ok(!s.includes(at(tue, '12:45')), '12:45 would run into the break');
  assert.ok(!s.includes(at(tue, '13:15')), 'no slot during the break');
  assert.ok(s.includes(at(tue, '14:00')), 'slots resume after the break');
  assert.equal(s.at(-1), at(tue, '17:30'), 'last slot ends exactly at closing');

  assert.deepEqual(await slots(nextWeekday(0), [fx.services.cut]), [], 'shop is closed on Sunday');

  const wed = nextWeekday(3, 3);
  const off = await owner.post('/staff/time-off', { barber_id: fx.b1.id, kind: 'day_off', from_date: wed });
  assert.equal(off.status, 201);
  assert.deepEqual(await slots(wed, [fx.services.cut], fx.b1.id), [], 'day off removes every slot');
  assert.ok((await slots(wed, [fx.services.cut], fx.b2.id)).length > 0, 'other barbers are unaffected');
});

test('lead time and booking horizon hide slots', async () => {
  const tz = 'Africa/Tunis';
  const far = time.addDays(time.today(tz), 60);
  assert.deepEqual(await slots(far, [fx.services.cut]), [], 'beyond the 45-day horizon');
  saveSettings({ lead_time_min: 60 * 24 * 30 });
  assert.deepEqual(await slots(tue, [fx.services.cut]), [], 'inside the lead time');
  saveSettings({ lead_time_min: 60 });
});

test('a guest must verify their email, then the booking is stored and visible to staff', async () => {
  const startAt = at(tue, '10:00');
  const noCode = await guest.post('/public/bookings', { serviceIds: [fx.services.cut], barber: fx.b1.id, start: startAt, name: 'Gus Guest', email: 'gus@test.dev', phone: '+216 55 555 555' });
  assert.equal(noCode.status, 400);
  assert.equal(noCode.body.error.code, 'CODE_INVALID');

  const ok = await guestBook(guest, { serviceIds: [fx.services.cut], barber: fx.b1.id, start: startAt, email: 'gus@test.dev' });
  assert.equal(ok.status, 201);
  const appt = ok.body.appointment;
  assert.match(appt.reference, /^CB-[A-Z2-9]{6}$/);
  assert.equal(appt.status, 'confirmed', 'auto-confirmation is the default');
  assert.equal(appt.total_minor, 25_000);
  assert.equal(appt.payment_status, 'unpaid');
  assert.ok(ok.body.manageToken);

  const list = await ben.get(`/staff/appointments?from=${tue}&to=${tue}`);
  assert.ok(list.body.appointments.some((a: any) => a.reference === appt.reference && a.source === 'website'), 'barber sees it on the calendar');
  const ownerList = await owner.get(`/staff/appointments?from=${tue}&to=${tue}`);
  assert.ok(ownerList.body.appointments.some((a: any) => a.reference === appt.reference), 'owner sees it too');

  const mails = db.all<any>("SELECT type, to_email, status FROM notifications WHERE appointment_id = ?", appt.id);
  assert.ok(mails.some((m) => m.type === 'booking_confirmation' && m.to_email === 'gus@test.dev' && m.status === 'queued'), 'confirmation email queued');
  assert.ok(mails.some((m) => m.type === 'booking_owner_new'), 'owner notification queued');
});

test('the same slot cannot be booked twice and overlapping bookings are rejected', async () => {
  const startAt = at(tue, '10:00');
  assert.ok(!(await slots(tue, [fx.services.cut], fx.b1.id)).includes(startAt), 'taken slot is hidden');
  const again = await guestBook(guest, { serviceIds: [fx.services.cut], barber: fx.b1.id, start: startAt });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'SLOT_TAKEN');

  const overlap = await guestBook(guest, { serviceIds: [fx.services.cut], barber: fx.b1.id, start: at(tue, '10:15') });
  assert.equal(overlap.status, 409, '10:15 overlaps the 10:00-10:30 booking');

  const staffOverlap = await ben.post('/staff/appointments', { customer: { name: 'Walk In' }, serviceIds: [fx.services.beard], start: at(tue, '10:20'), source: 'walk_in' });
  assert.equal(staffOverlap.status, 409, 'staff cannot double book either');
  assert.equal(staffOverlap.body.error.code, 'SLOT_TAKEN');

  // Even a direct write that bypasses the application is stopped by the database trigger.
  assert.throws(() => db.run(
    `INSERT INTO appointments (reference, customer_id, barber_id, starts_at, ends_at, blocked_until, status, source, total_minor, currency, created_at, updated_at)
     VALUES ('CB-RAWSQL', ?, ?, ?, ?, ?, 'confirmed', 'phone', 0, 'TND', 1, 1)`, fx.customer, fx.b1.id, startAt + 60_000, startAt + 600_000, startAt + 600_000), /SLOT_TAKEN/);
});

test('simultaneous requests for one slot produce exactly one booking', async () => {
  const startAt = at(tue, '15:00');
  const codes = await Promise.all([1, 2, 3, 4].map(async (i) => {
    const email = `race${i}@test.dev`;
    return { email, code: (await guest.post('/public/booking/request-code', { email })).body.devCode };
  }));
  const results = await Promise.all(codes.map(({ email, code }) =>
    client().post('/public/bookings', { serviceIds: [fx.services.shave], barber: fx.b1.id, start: startAt, name: 'Racer', email, phone: '+216 55 555 555', code })));
  // Four customers want the same barber at the same minute: only one can win.
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 3);
});

test('a manual staff booking is stored with its source and blocks public availability', async () => {
  const startAt = at(tue, '11:00');
  const r = await ben.post('/staff/appointments', { customer: { name: 'Phone Caller', phone: '+216 20 111 222' }, serviceIds: [fx.services.cut], start: startAt, source: 'phone', note: 'Called at noon' });
  assert.equal(r.status, 201);
  assert.equal(r.body.appointment.source, 'phone');
  assert.equal(r.body.appointment.barber_id, fx.b1.id, 'a barber books onto their own chair');
  assert.match(r.body.appointment.reference, /^CB-/);
  assert.ok(!(await slots(tue, [fx.services.cut], fx.b1.id)).includes(startAt), 'slot is gone from the website');
  const web = await guestBook(guest, { serviceIds: [fx.services.cut], barber: fx.b1.id, start: startAt });
  assert.equal(web.status, 409);

  const outside = await ben.post('/staff/appointments', { customer: { name: 'Late Larry' }, serviceIds: [fx.services.cut], start: at(tue, '19:00'), source: 'walk_in' });
  assert.equal(outside.status, 409);
  assert.equal(outside.body.error.code, 'OUTSIDE_HOURS');
  const forced = await ben.post('/staff/appointments', { customer: { name: 'Late Larry' }, serviceIds: [fx.services.cut], start: at(tue, '19:00'), source: 'walk_in', ignoreHours: true });
  assert.equal(forced.status, 201, 'staff may explicitly book outside hours');
});

test('"any barber" assigns a genuinely free barber, preferring the lightest day', async () => {
  const thu = nextWeekday(4, 3);
  const startAt = at(thu, '09:00');
  // Give the owner and Ben a busier day than Cal.
  for (const who of [fx.owner.barberId, fx.b1.id]) {
    const r = await owner.post('/staff/appointments', { customer: { name: 'Filler' }, serviceIds: [fx.services.cut], barber: who, start: at(thu, '16:00'), source: 'phone' });
    assert.equal(r.status, 201);
  }
  const first = await guestBook(guest, { serviceIds: [fx.services.cut], barber: 'any', start: startAt });
  assert.equal(first.status, 201);
  assert.equal(first.body.appointment.barber_id, fx.b2.id, 'least loaded barber is chosen');
  const second = await guestBook(guest, { serviceIds: [fx.services.cut], barber: 'any', start: startAt });
  const third = await guestBook(guest, { serviceIds: [fx.services.cut], barber: 'any', start: startAt });
  assert.equal(new Set([first, second, third].map((r) => r.body.appointment.barber_id)).size, 3, 'each booking lands on a different barber');
  const fourth = await guestBook(guest, { serviceIds: [fx.services.cut], barber: 'any', start: startAt });
  assert.equal(fourth.status, 409, 'no barber left at that time');
});

test('buffer time between appointments is enforced', async () => {
  saveSettings({ buffer_min: 10 });
  const fri = nextWeekday(5, 3);
  const r = await guestBook(guest, { serviceIds: [fx.services.cut], barber: fx.b2.id, start: at(fri, '10:00') });
  assert.equal(r.status, 201);
  const s = await slots(fri, [fx.services.cut], fx.b2.id);
  assert.ok(!s.includes(at(fri, '10:30')), '10:30 is inside the buffer');
  assert.ok(!s.includes(at(fri, '09:45')), '09:45 would end inside the booked slot');
  assert.ok(!s.includes(at(fri, '09:30')), '09:30 + 30 min + 10 min buffer collides with 10:00');
  assert.ok(s.includes(at(fri, '10:45')), '10:45 is the first free slot after the buffer');
  saveSettings({ buffer_min: 0 });
});

test('customers can reschedule and cancel through the emailed link, within policy', async () => {
  const sat = nextWeekday(6, 3);
  const booked = await guestBook(guest, { serviceIds: [fx.services.cut], barber: fx.b2.id, start: at(sat, '09:00') });
  const { reference } = booked.body.appointment;
  const token = booked.body.manageToken;

  assert.equal((await guest.get(`/public/manage/${reference}?token=wrong`)).status, 404, 'a wrong token reveals nothing');
  assert.equal((await guest.get(`/public/manage/${reference}?token=${token}`)).body.appointment.can_reschedule, true);

  const moved = await guest.post(`/public/manage/${reference}/reschedule`, { token, start: at(sat, '11:00') });
  assert.equal(moved.status, 200);
  const s = await slots(sat, [fx.services.cut], fx.b2.id);
  assert.ok(s.includes(at(sat, '09:00')), 'old slot is released');
  assert.ok(!s.includes(at(sat, '11:00')), 'new slot is taken');

  const cancelled = await guest.post(`/public/manage/${reference}/cancel`, { token });
  assert.equal(cancelled.body.appointment.status, 'cancelled');
  assert.ok((await slots(sat, [fx.services.cut], fx.b2.id)).includes(at(sat, '11:00')), 'cancelling frees the slot');

  // Inside the cancellation window the customer is told to call instead.
  const soon = await guestBook(guest, { serviceIds: [fx.services.cut], barber: fx.b2.id, start: at(sat, '09:00') });
  saveSettings({ cancel_min_hours: 24 * 60 });
  const late = await guest.post(`/public/manage/${soon.body.appointment.reference}/cancel`, { token: soon.body.manageToken });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'POLICY');
  saveSettings({ cancel_min_hours: 3 });
});

test('manual approval mode creates pending bookings that the owner confirms', async () => {
  saveSettings({ auto_confirm: false });
  const mon = nextWeekday(1, 3);
  const r = await guestBook(guest, { serviceIds: [fx.services.cut], barber: fx.b2.id, start: at(mon, '09:00') });
  assert.equal(r.body.appointment.status, 'pending');
  assert.ok(!(await slots(mon, [fx.services.cut], fx.b2.id)).includes(at(mon, '09:00')), 'pending bookings hold the slot');
  const ok = await owner.post(`/staff/appointments/${r.body.appointment.id}/status`, { status: 'confirmed' });
  assert.equal(ok.body.appointment.status, 'confirmed');
  assert.equal(db.all("SELECT 1 FROM notifications WHERE type = 'booking_approved' AND appointment_id = ?", r.body.appointment.id).length, 1);
  saveSettings({ auto_confirm: true });
});

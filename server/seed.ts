// Demo data for local evaluation. Safe to run repeatedly: it does nothing when
// the database already has users. `npm run seed -- --reset` wipes the dev DB first.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { config } from './config.ts';
import { all, closeDb, get, getDb, run, tx } from './db.ts';
import { hashPassword, loadAuthUser, type AuthUser } from './lib/auth.ts';
import { getSettings, saveSettings } from './lib/settings.ts';
import { createAppointment, setStatus } from './services/appointments.ts';
import { addManualEarning, barberBalance, recordPayment, recordPayout, recordRefund, setCompensationRule } from './services/finance.ts';
import { createOwner, ensureDefaults } from './setup.ts';
import { addDays, parseMinutes, today, weekdayOf, zonedToUtc } from '../shared/time.ts';
import type { Source } from '../shared/constants.ts';

export const DEMO = {
  owner: { email: 'owner@clubbarber.test', password: 'Owner#2026' },
  barber: { email: 'poste2@clubbarber.test', password: 'Barber#2026' },
  customer: { email: 'customer@clubbarber.test', password: 'Customer#2026' },
};

function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Returns false (and changes nothing) when the database already has accounts. All-or-nothing. */
export function seedDemo(now = Date.now()): boolean {
  getDb();
  if (get('SELECT 1 FROM users LIMIT 1')) return false;
  ensureDefaults();
  return tx(() => seedAll(now));
}

function seedAll(now: number): boolean {
  saveSettings({ tagline: 'Coupes nettes. Gestes lents.', about: 'Un salon de quartier construit autour du temps : le temps de s’asseoir, de discuter, et de faire les choses exactement comme il faut.' });
  const s = getSettings();
  const tz = s.timezone;
  const rand = prng(20261013);
  const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)];
  const T = 1000; // 1.000 TND in millimes
  const t0 = today(tz, now);
  const at = (date: string, hhmm: string) => zonedToUtc(date, parseMinutes(hhmm)!, tz);

  // --- Services ---
  const svc = (name: string, category: string, price: number, duration: number, image: string, description: string, order: number) =>
    run('INSERT INTO services (name, description, category, price_minor, duration_min, image_url, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      name, description, category, price * T, duration, `/images/${image}.jpg`, order, now).id;
  const S = {
    classic: svc('Coupe classique', 'Cheveux', 25, 30, 'comb', 'Coupe aux ciseaux et à la tondeuse, shampoing et coiffage. Le classique de la maison.', 1),
    fade: svc('Dégradé à blanc', 'Cheveux', 30, 45, 'fade', 'Dégradé précis du zéro à la longueur, contours au rasoir et nuque nette.', 2),
    beard: svc('Taille de barbe', 'Barbe', 15, 20, 'beard', 'Contours, longueur et forme, avec serviette chaude et huile à barbe.', 3),
    combo: svc('Coupe + barbe', 'Forfaits', 38, 50, 'lineup', 'Notre rendez-vous le plus demandé : coupe complète et barbe bien dessinée.', 4),
    shave: svc('Rasage à l’ancienne', 'Rasage', 28, 30, 'shave', 'Rasage traditionnel au coupe-chou : mousse, serviettes chaudes et finition fraîche.', 5),
    kids: svc('Coupe enfant', 'Cheveux', 18, 25, 'clipper', 'Pour les moins de 12 ans. De la patience, un résultat soigné.', 6),
    lineup: svc('Contours', 'Cheveux', 10, 15, 'groom', 'Tempes, bordures et nuque rafraîchies entre deux coupes.', 7),
    ritual: svc('Le Rituel complet', 'Forfaits', 65, 80, 'chair', 'Coupe, rasage à la serviette chaude et soin du visage. Prenez votre temps, nous aussi.', 8),
  };
  const everyService = Object.values(S);

  // --- Team ---
  const owner = createOwner({
    email: DEMO.owner.email, password: DEMO.owner.password, name: 'Stiphan Mansour', phone: '+216 20 100 100', photo_url: '/images/barber-1.jpg',
    specialty: 'Coupes classiques et rasage au coupe-chou', bio: 'Fondateur du salon. Quinze ans derrière le fauteuil, et toujours aussi heureux avec des ciseaux et un peigne.',
  });
  const mkBarber = (name: string, email: string, phone: string, photo: string, specialty: string, bio: string, order: number, services: number[]) => {
    const userId = run("INSERT INTO users (email, password_hash, role, name, phone, email_verified_at, created_at) VALUES (?, ?, 'barber', ?, ?, ?, ?)",
      email, hashPassword(DEMO.barber.password), name, phone, now, now).id;
    const id = run('INSERT INTO barbers (user_id, name, email, phone, bio, specialty, photo_url, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      userId, name, email, phone, bio, specialty, `/images/${photo}.jpg`, order, now).id;
    for (const sid of services) run('INSERT INTO barber_services (barber_id, service_id) VALUES (?, ?)', id, sid);
    return id;
  };
  const B = {
    owner: owner.barberId,
    p2: mkBarber('Poste 2', DEMO.barber.email, '+216 22 200 200', 'barber-2', 'Dégradés et coupes modernes', 'Des gestes rapides et des dégradés nets. Le fauteuil préféré de ceux qui reviennent toutes les deux semaines.', 1, everyService.filter((x) => x !== S.kids)),
    p3: mkBarber('Poste 3', 'poste3@clubbarber.test', '+216 23 300 300', 'barber-3', 'Cheveux bouclés et barbes dessinées', 'Spécialiste des cheveux texturés et des barbes sculptées. Calme, précis, jamais pressé.', 2, [S.classic, S.fade, S.beard, S.combo, S.kids, S.lineup]),
    p4: mkBarber('Poste 4', 'poste4@clubbarber.test', '+216 24 400 400', 'barber-4', 'Tondeuse et coupes enfants', 'Le dernier fauteuil arrivé au salon. Un travail propre à la tondeuse et une patience infinie pour les premières coupes.', 3, everyService.filter((x) => x !== S.ritual)),
  };
  const hours = (barberId: number, days: number[], start: string, end: string, brk: [string, string] | null) => {
    run('DELETE FROM working_hours WHERE barber_id = ?', barberId);
    for (const wd of days) {
      run('INSERT INTO working_hours (barber_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?)', barberId, wd, parseMinutes(start), wd === 6 ? Math.min(parseMinutes(end)!, 18 * 60) : parseMinutes(end));
      if (brk) run('INSERT INTO breaks (barber_id, weekday, start_min, end_min) VALUES (?, ?, ?, ?)', barberId, wd, parseMinutes(brk[0]), parseMinutes(brk[1]));
    }
  };
  hours(B.owner, [2, 3, 4, 5, 6], '10:00', '17:00', ['13:00', '14:00']);
  hours(B.p2, [1, 2, 4, 5, 6], '09:00', '19:00', ['13:00', '14:00']);
  hours(B.p3, [1, 2, 3, 4, 5, 6], '09:00', '18:00', ['12:30', '13:30']);
  hours(B.p4, [1, 2, 3, 4, 5, 6], '10:00', '19:00', ['13:30', '14:30']);

  // Compensation rules are dated before the demo history so past services earn under them.
  const ruleFrom = now - 60 * 86_400_000;
  setCompensationRule(B.p2, { model: 'commission', basis: 'completed', commission_bps: 4500, fixed_minor: 0, salary_minor: 0, note: '45 % du prix convenu, acquis à la fin de la prestation' }, null);
  setCompensationRule(B.p3, { model: 'commission', basis: 'paid', commission_bps: 4000, fixed_minor: 0, salary_minor: 0, note: '40 %, acquis une fois la prestation entièrement payée' }, null);
  setCompensationRule(B.p4, { model: 'fixed_per_service', basis: 'completed', commission_bps: 0, fixed_minor: 8 * T, salary_minor: 0, note: '8,000 par prestation terminée' }, null);
  getDb().exec(`UPDATE compensation_rules SET effective_from = ${ruleFrom}, created_at = ${ruleFrom}`);

  const actor = loadAuthUser(owner.userId) as AuthUser;

  // --- Customers ---
  const demoUser = run("INSERT INTO users (email, password_hash, role, name, phone, email_verified_at, created_at) VALUES (?, ?, 'customer', ?, ?, ?, ?)",
    DEMO.customer.email, hashPassword(DEMO.customer.password), 'Client Démo', '+216 50 123 456', now, now).id;
  const mkCustomer = (name: string, phone: string, email: string | null, userId: number | null = null, notes = '') =>
    run('INSERT INTO customers (user_id, name, email, phone, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)', userId, name, email, phone, notes, now - 40 * 86_400_000).id;
  const demoCustomer = mkCustomer('Client Démo', '+216 50 123 456', DEMO.customer.email, demoUser, 'Préfère le Poste 2. Dégradé bas, longueur sur le dessus.');
  const customers = [
    mkCustomer('Client 1', '+216 51 111 213', `client1@example.com`),
    mkCustomer('Client 2', '+216 52 122 226', `client2@example.com`),
    mkCustomer('Client 3', '+216 53 133 239', null),
    mkCustomer('Client 4', '+216 54 144 252', `client4@example.com`),
    mkCustomer('Client 5', '+216 55 155 265', `client5@example.com`),
    mkCustomer('Client 6', '+216 56 166 278', null),
    mkCustomer('Client 7', '+216 57 177 291', `client7@example.com`),
    mkCustomer('Client 8', '+216 58 188 304', `client8@example.com`),
    mkCustomer('Client 9', '+216 59 199 317', null),
    mkCustomer('Client 10', '+216 510 210 330', `client10@example.com`),
    mkCustomer('Client 11', '+216 511 221 343', `client11@example.com`),
  ];

  // --- Time off (created before future bookings so they respect it) ---
  const dayOff = addDays(t0, 5);
  run("INSERT INTO time_off (barber_id, kind, starts_at, ends_at, reason, created_by, created_at) VALUES (?, 'day_off', ?, ?, 'Événement familial', ?, ?)",
    B.p3, at(dayOff, '00:00'), at(addDays(dayOff, 1), '00:00'), owner.userId, now);
  const holiday = addDays(t0, 16);
  run("INSERT INTO time_off (barber_id, kind, starts_at, ends_at, reason, created_by, created_at) VALUES (NULL, 'holiday', ?, ?, 'Salon fermé — grand nettoyage annuel', ?, ?)",
    at(holiday, '00:00'), at(addDays(holiday, 1), '00:00'), owner.userId, now);

  // --- Appointments ---
  const offered = (barberId: number) => all<any>('SELECT s.id, s.duration_min FROM services s JOIN barber_services bs ON bs.service_id = s.id WHERE bs.barber_id = ? AND s.duration_min <= 50', barberId).map((x) => x.id as number);
  const sources: Source[] = ['website', 'website', 'website', 'phone', 'phone', 'walk_in', 'whatsapp', 'in_person'];
  const methods = ['cash', 'cash', 'cash', 'cash', 'card', 'card', 'bank_transfer'];
  const completedIds: number[] = [];

  type Outcome = 'completed' | 'cancelled' | 'no_show' | 'in_progress' | 'confirmed';
  const book = (barberId: number, customerId: number, serviceIds: number[], start: number, source: Source, outcome: Outcome, pay: 'full' | 'partial' | 'none') => {
    let appt;
    try {
      const lead = source === 'walk_in' ? 5 * 60_000 : (1 + Math.floor(rand() * 4)) * 86_400_000;
      appt = createAppointment({ customer: { id: customerId }, serviceIds, barber: barberId, start, source, staff: true, actor, silent: true, now: Math.min(start - lead, now) }).appointment;
    } catch {
      return null; // outside hours or overlapping: skip, the engine said no
    }
    const end = appt.ends_at;
    if (outcome === 'cancelled') setStatus(appt.id, 'cancelled', actor, { at: start - 6 * 3_600_000, reason: pick(['Annulé par téléphone', 'Reporté à plus tard', 'Client souffrant']), silent: true });
    else if (outcome === 'no_show') setStatus(appt.id, 'no_show', actor, { at: start + 20 * 60_000, silent: true });
    else if (outcome === 'in_progress') {
      setStatus(appt.id, 'checked_in', actor, { at: start - 4 * 60_000, silent: true });
      setStatus(appt.id, 'in_progress', actor, { at: start, silent: true });
    } else if (outcome === 'completed') {
      setStatus(appt.id, 'checked_in', actor, { at: start - 5 * 60_000, silent: true });
      setStatus(appt.id, 'in_progress', actor, { at: start + 60_000, silent: true });
      setStatus(appt.id, 'completed', actor, { at: end + 2 * 60_000, silent: true });
      completedIds.push(appt.id);
      const method = pick(methods);
      if (pay === 'full') recordPayment(appt.id, { amountMinor: appt.total_minor, method, at: end + 5 * 60_000 }, actor);
      if (pay === 'partial') recordPayment(appt.id, { amountMinor: Math.max(5 * T, Math.floor(appt.total_minor / 2 / T) * T), method, note: 'Réglera le reste à la prochaine visite', at: end + 5 * 60_000 }, actor);
    }
    return appt.id as number;
  };

  const chairs: [number, string[]][] = [
    [B.owner, ['10:30', '14:30', '16:00']],
    [B.p2, ['09:30', '11:00', '14:30', '16:15', '17:30']],
    [B.p3, ['09:15', '10:30', '15:00', '16:45']],
    [B.p4, ['10:15', '11:45', '15:00', '16:30', '17:45']],
  ];

  // The demo customer's own history with Poste 2 (booked first so it is guaranteed).
  const p2Day = (from: number, step: number) => {
    for (let d = from; Math.abs(d - from) < 7; d += step) if ([1, 2, 4, 5, 6].includes(weekdayOf(addDays(t0, d)))) return addDays(t0, d);
    return addDays(t0, from);
  };
  const a1 = book(B.p2, demoCustomer, [S.fade], at(p2Day(-17, -1), '11:00'), 'website', 'completed', 'full');
  const a2 = book(B.p2, demoCustomer, [S.combo], at(p2Day(-3, -1), '16:15'), 'website', 'completed', 'full');
  book(B.p2, demoCustomer, [S.fade], at(p2Day(3, 1), '11:00'), 'website', 'confirmed', 'none');

  for (let d = -21; d <= 9; d++) {
    const date = addDays(t0, d);
    for (const [barberId, times] of chairs) {
      const options = offered(barberId);
      for (const time of times) {
        if (rand() > (d < 0 ? 0.62 : d === 0 ? 0.8 : 0.34)) continue;
        const start = at(date, time);
        const services = [pick(options)];
        const customer = pick(customers);
        const source = pick(sources);
        let outcome: Outcome, pay: 'full' | 'partial' | 'none' = 'none';
        if (start > now) outcome = 'confirmed';
        else if (start + 50 * 60_000 > now) outcome = 'in_progress';
        else {
          const r = rand();
          outcome = r < 0.84 ? 'completed' : r < 0.93 ? 'cancelled' : 'no_show';
          const p = rand();
          pay = d < -9 || p < 0.8 ? 'full' : p < 0.92 ? 'partial' : 'none';
        }
        book(barberId, customer, services, start, source, outcome, pay);
      }
    }
  }

  // --- A traceable refund on an older, fully paid visit ---
  const refundable = get<any>(
    `SELECT a.id FROM appointments a WHERE a.status = 'completed' AND a.completed_at < ? AND a.id NOT IN (?, ?)
       AND (SELECT COALESCE(SUM(amount_minor), 0) FROM payments p WHERE p.appointment_id = a.id) >= a.total_minor ORDER BY a.completed_at DESC LIMIT 1`,
    now - 5 * 86_400_000, a1 ?? 0, a2 ?? 0);
  if (refundable) recordRefund(refundable.id, { amountMinor: 5 * T, method: 'cash', note: 'Geste commercial — retouche demandée', at: now - 4 * 86_400_000 }, actor);

  // --- Payouts: part of what Poste 2 and Poste 4 have earned has already been settled ---
  for (const [barberId, share, method] of [[B.p2, 0.6, 'bank_transfer'], [B.p4, 0.5, 'cash']] as const) {
    const owed = barberBalance(barberId).owed_minor;
    const amount = Math.floor((owed * share) / (10 * T)) * 10 * T;
    if (amount > 0) recordPayout(barberId, { amountMinor: amount, method, reference: method === 'cash' ? null : 'VIR-1042', note: 'Règlement hebdomadaire', paidAt: now - 3 * 86_400_000 }, actor);
  }
  addManualEarning(B.p2, { kind: 'bonus', amountMinor: 20 * T, note: 'Fauteuil le plus demandé du mois' }, actor);

  // --- Expenses ---
  const expense = (category: string, description: string, amount: number, method: string, daysAgo: number) =>
    run('INSERT INTO expenses (category, description, amount_minor, currency, method, spent_at, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      category, description, amount * T, s.currency, method, at(addDays(t0, -daysAgo), '12:00'), owner.userId, now);
  expense('Rent', 'Loyer du salon', 450, 'bank_transfer', 12);
  expense('Products', 'Réassort cire, huile à barbe et lames', 185, 'card', 8);
  expense('Utilities', 'Électricité et eau', 96, 'bank_transfer', 5);
  expense('Laundry', 'Serviettes et capes', 40, 'cash', 2);

  // --- Reviews ---
  const quotes: [number, string][] = [
    [5, 'Le meilleur dégradé que j’aie eu à Tunis. Réservé en ligne en une minute, installé à l’heure.'],
    [5, 'Un vrai rasage à la serviette chaude, sans précipitation. Ça vaut chaque millime.'],
    [4, 'Très bonne coupe et réservation facile. Le stationnement est un peu juste le samedi.'],
    [5, 'On vous écoute vraiment. Ma barbe n’a jamais été aussi régulière.'],
    [5, 'J’y ai emmené mon fils pour sa première coupe. Patients, souriants, résultat parfait.'],
  ];
  const reviewed = [a2, ...completedIds.filter((id) => id !== a1 && id !== a2).slice(-12).filter((_, i) => i % 3 === 0)].filter(Boolean).slice(0, quotes.length) as number[];
  reviewed.forEach((id, i) => {
    const a = get<any>('SELECT customer_id, barber_id, completed_at FROM appointments WHERE id = ?', id);
    run('INSERT INTO reviews (appointment_id, customer_id, barber_id, rating, comment, is_published, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      id, a.customer_id, a.barber_id, quotes[i][0], quotes[i][1], a.completed_at + 3 * 3_600_000);
  });

  return true;
}

// ---- CLI ----
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.includes('--reset')) {
    if (config.isProd) {
      console.error('Refusing to reset the database when NODE_ENV=production.');
      process.exit(1);
    }
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(config.databasePath + suffix, { force: true });
    console.log('Database removed.');
    if (process.argv.includes('--empty')) {
      console.log('Left empty. Set OWNER_EMAIL, OWNER_NAME and OWNER_PASSWORD in .env, then run `npm run create-owner` to start with no demo data.');
      process.exit(0);
    }
  }
  const created = seedDemo();
  if (!created) {
    console.log('The database already contains accounts — demo data was NOT added again. Use `npm run seed -- --reset` to start over (development only).');
  } else {
    const count = (t: string) => get<any>(`SELECT COUNT(*) AS n FROM ${t}`)!.n;
    console.log(`Demo data created: ${count('barbers')} barbers, ${count('services')} services, ${count('customers')} customers, ${count('appointments')} appointments, ${count('payments')} ledger entries.`);
    console.log('\nDemo logins (development only):');
    console.log(`  Owner    ${DEMO.owner.email} / ${DEMO.owner.password}`);
    console.log(`  Barber   ${DEMO.barber.email} / ${DEMO.barber.password}   (also poste3@ and poste4@clubbarber.test)`);
    console.log(`  Customer ${DEMO.customer.email} / ${DEMO.customer.password}`);
  }
}

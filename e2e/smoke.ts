// Browser end-to-end run against a real server with a throw-away seeded database.
// Requires `npm run build` first. Uses the installed Microsoft Edge (or Chrome) —
// no browser download. Screenshots land in e2e/screenshots.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4173;
const BASE = `http://localhost:${PORT}`;
const DB = path.join(ROOT, 'data', 'e2e.db');
const SHOTS = path.join(ROOT, 'e2e', 'screenshots');
const env = { ...process.env, PORT: String(PORT), DATABASE_PATH: DB, APP_URL: BASE, NODE_ENV: 'development', SMTP_HOST: '' };
const tsx = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const results: { name: string; ok: boolean; detail?: string }[] = [];
const consoleErrors: string[] = [];
let failed = false;

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (e: any) {
    failed = true;
    results.push({ name, ok: false, detail: String(e?.message ?? e).split('\n')[0] });
    console.log(`  FAIL ${name}\n       ${String(e?.message ?? e).split('\n').slice(0, 4).join('\n       ')}`);
  }
}
const expect = (cond: unknown, message: string) => { if (!cond) throw new Error(message); };
const shot = (page: Page, name: string, fullPage = false) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage });

async function newPage(browser: Browser, viewport = { width: 1440, height: 900 }, lang: string | null = 'en') {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  // The site defaults to French; the scripted flows below use the English labels.
  if (lang) await ctx.addInitScript((l) => { try { localStorage.setItem('cb_lang', l); } catch { /* ignore */ } }, lang);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 40[0-9]/.test(m.text())) consoleErrors.push(`${page.url()} :: ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`${page.url()} :: ${e.message}`));
  return page;
}

async function login(page: Page, role: 'Owner' | 'Barber' | 'Customer') {
  await page.goto(`${BASE}/login`);
  await page.locator(`[data-demo="${role}"]`).click();
  await page.waitForURL(role === 'Customer' ? '**/account' : '**/app/**');
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) throw new Error('Run `npm run build` before the e2e test.');
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
  const seed = spawnSync(process.execPath, [tsx, 'server/seed.ts'], { cwd: ROOT, env, encoding: 'utf8' });
  if (seed.status !== 0) throw new Error(`Seeding failed: ${seed.stderr}`);
  const server = spawn(process.execPath, [tsx, 'server/index.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (i > 60) throw new Error(`Server did not start:\n${serverLog}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    let browser: Browser;
    try { browser = await chromium.launch({ channel: 'msedge' }); } catch { browser = await chromium.launch({ channel: 'chrome' }); }

    let reference = '';
    let bookedStart = '';

    // ---------- Public website ----------
    const pub = await newPage(browser);
    await step('home page renders hero, services, barbers, reviews and hours', async () => {
      await pub.goto(BASE);
      await pub.getByRole('heading', { level: 1 }).waitFor();
      expect(await pub.locator('.menu-row').count() >= 5, 'service rows missing');
      expect(await pub.locator('.crew-card').count() === 4, 'expected 4 barber cards');
      expect(await pub.locator('.quote').count() === 3, 'expected 3 reviews');
      expect(await pub.locator('.hours tr').count() === 7, 'opening hours table missing');
      await pub.waitForLoadState('networkidle');
      await pub.waitForTimeout(1200);
      await shot(pub, '01-home');
      // Scroll through the page so lazy images load, then make sure every one of them really rendered.
      for (let y = 0; y < await pub.evaluate(() => document.body.scrollHeight); y += 600) { await pub.mouse.wheel(0, 600); await pub.waitForTimeout(120); }
      await pub.waitForLoadState('networkidle');
      const images = await pub.evaluate(() => [...document.images].map((i) => ({ src: i.src, ok: i.complete && i.naturalWidth > 0 })));
      expect(images.length >= 9, `expected at least 9 photos on the home page, found ${images.length}`);
      expect(images.every((i) => i.ok), `images not rendered: ${images.filter((i) => !i.ok).map((i) => i.src).join(', ')}`);
      await pub.evaluate(() => window.scrollTo(0, 0));
      await shot(pub, '01-home-full', true);
    });
    await step('services and barbers pages render', async () => {
      await pub.goto(`${BASE}/services`);
      await pub.locator('.menu-row').first().waitFor();
      await shot(pub, '02-services');
      await pub.goto(`${BASE}/barbers`);
      expect(await pub.locator('.profile').count() === 4, 'expected 4 barber profiles');
      await shot(pub, '03-barbers');
    });

    await step('a guest books an available slot through the wizard and gets a reference', async () => {
      await pub.goto(`${BASE}/book`);
      await pub.getByRole('button', { name: /Dégradé à blanc/ }).click();
      await pub.getByRole('button', { name: /Taille de barbe/ }).click();
      await shot(pub, '04-book-services');
      await pub.locator('.book-actions').getByRole('button', { name: 'Continue' }).click();
      await pub.getByRole('button', { name: /Poste 2/ }).click();
      await pub.locator('.slot').first().waitFor();
      await shot(pub, '05-book-time');
      const picked = pub.locator('.day[aria-pressed="true"]');
      expect(await picked.count() === 1 && !(await picked.isDisabled()), 'the first bookable day should be selected and enabled');
      console.log('       selected day style:', await picked.evaluate((el) => { const c = getComputedStyle(el); return `${c.color} on ${c.backgroundColor}, opacity ${c.opacity}`; }));
      const slot = pub.locator('.slot').nth(2);
      bookedStart = (await slot.textContent()) ?? '';
      await slot.click();
      await pub.locator('.book-actions').getByRole('button', { name: 'Continue' }).click();
      await pub.getByLabel('Full name').fill('Elyes Browser');
      await pub.getByLabel('Phone').fill('+216 55 123 987');
      await pub.getByLabel('Email').fill('elyes.browser@example.com');
      await pub.locator('.book-actions').getByRole('button', { name: 'Continue' }).click();
      const code = (await pub.locator('.notice strong').first().textContent())?.trim() ?? '';
      expect(/^\d{6}$/.test(code), `no dev verification code shown (got "${code}")`);
      await pub.getByLabel('6-digit code').fill(code);
      await shot(pub, '06-book-confirm');
      await pub.getByRole('button', { name: 'Confirm booking' }).first().click();
      await pub.locator('.ticket .ref b').waitFor();
      reference = (await pub.locator('.ticket .ref b').textContent()) ?? '';
      expect(/^CB-[A-Z2-9]{6}$/.test(reference), `bad reference "${reference}"`);
      await shot(pub, '07-book-confirmed');
    });

    await step('the emailed manage link opens the booking; a wrong token does not', async () => {
      await pub.getByRole('link', { name: 'Manage booking' }).click();
      await pub.locator('.appt-card').waitFor();
      expect((await pub.locator('.appt-card').textContent())?.includes('Dégradé à blanc + Taille de barbe'), 'manage page does not show the booking');
      await shot(pub, '08-manage');
      await pub.goto(`${BASE}/manage/${reference}?token=nope`);
      await pub.getByText('We could not find that booking.').waitFor();
    });

    await step('mobile: home and booking wizard are usable at 390px', async () => {
      const m = await newPage(browser, { width: 390, height: 844 });
      await m.goto(BASE);
      await m.getByRole('heading', { level: 1 }).waitFor();
      expect(await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'home scrolls horizontally on mobile');
      await shot(m, '20-mobile-home');
      await m.getByRole('button', { name: 'Open menu' }).click();
      await shot(m, '21-mobile-menu');
      await m.goto(`${BASE}/book`);
      await m.getByRole('button', { name: /Coupe classique/ }).click();
      await m.locator('.book-bar').getByRole('button', { name: 'Continue' }).click();
      await m.getByRole('button', { name: /First available/ }).click();
      await m.locator('.slot').first().waitFor();
      expect(await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'wizard scrolls horizontally on mobile');
      await shot(m, '22-mobile-book-time');
      await m.context().close();
    });

    // ---------- Owner ----------
    const owner = await newPage(browser);
    await step('owner signs in and sees a data-backed overview', async () => {
      await login(owner, 'Owner');
      await owner.waitForURL('**/app/overview');
      await owner.locator('.stats .stat').first().waitFor();
      await owner.locator('.chart svg path').first().waitFor();
      await owner.waitForLoadState('networkidle');
      await shot(owner, '10-overview', true);
    });

    await step('owner finds the online booking, runs it to completion — still unpaid', async () => {
      await owner.goto(`${BASE}/app/appointments`);
      await owner.getByLabel('Search appointments').fill(reference);
      await owner.getByRole('row', { name: /Elyes Browser/ }).click();
      const drawer = owner.locator('.drawer');
      await drawer.getByText(reference).waitFor();
      await shot(owner, '11-appointment-drawer');
      await drawer.getByRole('button', { name: 'Check in' }).click();
      await drawer.getByRole('button', { name: 'Start service' }).click();
      await drawer.getByRole('button', { name: 'Mark completed' }).click();
      await drawer.getByText('The service is done but not fully paid.').waitFor();
      expect((await drawer.locator('.money3 .due b').textContent())?.includes('45.000'), 'balance should be the full 45.000 after completion');
    });

    await step('partial payment, then the rest: balance and status update correctly', async () => {
      const drawer = owner.locator('.drawer');
      await drawer.getByRole('button', { name: 'Record payment' }).click();
      await drawer.getByPlaceholder('0.000').fill('20');
      await drawer.getByRole('button', { name: /^Record 20\.000 TND/ }).click();
      await drawer.locator('.badge', { hasText: 'Part paid' }).waitFor();
      expect((await drawer.locator('.money3 .due b').textContent())?.includes('25.000'), 'balance should be 25.000 after a 20.000 part payment');
      await drawer.getByRole('button', { name: 'Record payment' }).click();
      await drawer.getByRole('button', { name: 'Card' }).click();
      await drawer.getByRole('button', { name: /^Record 25\.000 TND/ }).click();
      await drawer.locator('.badge', { hasText: /^Paid$/ }).waitFor();
      expect(await drawer.locator('.ledger-row').count() === 2, 'expected two ledger rows');
      await shot(owner, '12-appointment-paid');
      await owner.keyboard.press('Escape');
    });

    await step('owner pages render: calendar, customers, payments, payroll, reports, team, services, settings, outbox, activity', async () => {
      const pages: [string, string, string][] = [
        ['calendar', '.cal-day', '13-calendar-day'], ['customers', '.table tbody tr', '14-customers'], ['payments', '.table tbody tr', '15-payments'],
        ['payroll', '.table tbody tr', '16-payroll'], ['reports', '.eq', '17-reports'], ['team', '.table tbody tr', '18-team'],
        ['services', '.table tbody tr', '19a-services'], ['settings', '.sched-row', '19b-settings'], ['outbox', '.table tbody tr', '19c-outbox'],
        ['activity', '.table tbody tr', '19d-activity'], ['expenses', '.table tbody tr', '19e-expenses'], ['reviews', '.table tbody tr', '19f-reviews'],
      ];
      for (const [route, selector, name] of pages) {
        await owner.goto(`${BASE}/app/${route}`);
        await owner.locator(selector).first().waitFor({ timeout: 10_000 });
        await owner.waitForLoadState('networkidle');
        await shot(owner, name, ['reports', 'settings'].includes(route));
      }
      await owner.goto(`${BASE}/app/calendar`);
      await owner.getByRole('button', { name: 'week', exact: true }).click();
      await owner.locator('.cal-week').waitFor();
      await shot(owner, '13b-calendar-week');
      await owner.getByRole('button', { name: 'month', exact: true }).click();
      await owner.locator('.cal-month').waitFor();
      await shot(owner, '13c-calendar-month');
      await owner.goto(`${BASE}/app/team`);
      await owner.getByRole('row', { name: /Poste 2/ }).click();
      await owner.getByRole('tab', { name: 'Pay & payouts' }).click();
      await owner.getByText('Current arrangement').waitFor();
      await shot(owner, '18b-team-pay', true);
      await owner.getByRole('tab', { name: 'Hours & days off' }).click();
      await owner.locator('.sched-row').first().waitFor();
      await shot(owner, '18c-team-hours', true);
    });

    await step('the confirmation email is in the outbox, marked simulated (not sent)', async () => {
      const r = await owner.evaluate(async (ref) => (await fetch('/api/admin/notifications', { headers: { 'X-Requested-With': 'clubbarber' } })).json().then((d: any) => d.notifications.filter((n: any) => n.reference === ref)), reference);
      const confirmation = r.find((n: any) => n.type === 'booking_confirmation');
      expect(confirmation, 'no confirmation email found for the booking');
      expect(confirmation.status === 'simulated', `expected simulated, got ${confirmation.status}`);
      expect(confirmation.to_email === 'elyes.browser@example.com', 'wrong recipient');
    });

    // ---------- Barber ----------
    const barber = await newPage(browser);
    await step('barber signs in to their own day and cannot open admin pages or APIs', async () => {
      await login(barber, 'Barber');
      await barber.waitForURL('**/app/today');
      await barber.locator('.stats .stat').first().waitFor();
      await shot(barber, '30-barber-today', true);
      expect(await barber.getByRole('link', { name: 'Payments' }).count() === 0, 'barber should not see the Payments link');
      await barber.goto(`${BASE}/app/reports`);
      await barber.waitForURL('**/app/today');
      const status = await barber.evaluate(async () => (await fetch('/api/admin/overview', { headers: { 'X-Requested-With': 'clubbarber' } })).status);
      expect(status === 403, `admin API returned ${status} for a barber`);
    });

    await step('barber adds a phone booking; that slot disappears from the public website', async () => {
      await barber.goto(`${BASE}/app/today`);
      await barber.getByRole('button', { name: 'New appointment' }).click();
      const modal = barber.locator('.modal');
      await modal.getByRole('button', { name: 'New customer' }).click();
      await modal.getByLabel('Name').fill('Phone Booker');
      await modal.getByRole('textbox', { name: 'Phone' }).fill('+216 20 765 432');
      await modal.getByRole('button', { name: /Coupe classique/ }).click();
      await modal.locator('.day:not([disabled])').nth(3).click();
      await modal.locator('.slot').first().waitFor();
      const dateLabel = await modal.locator('.day[aria-pressed="true"]').getAttribute('aria-label');
      const time = (await modal.locator('.slot').first().textContent()) ?? '';
      await modal.locator('.slot').first().click();
      await shot(barber, '31-barber-new-appointment');
      await modal.getByRole('button', { name: 'Add appointment' }).click();
      await barber.locator('.drawer').getByText('Phone Booker').first().waitFor();
      expect((await barber.locator('.drawer .drawer-head').textContent())?.includes('Phone'), 'source should be Phone');
      await shot(barber, '32-barber-appointment');

      // Public availability for that barber on that date must no longer offer that time.
      const taken = await barber.evaluate(async ({ dateLabel, time }) => {
        const shop: any = await (await fetch('/api/public/shop')).json();
        const karim = shop.barbers.find((b: any) => b.name === 'Poste 2');
        const cut = shop.services.find((s: any) => s.name === 'Coupe classique');
        const from = new Date().toISOString().slice(0, 10);
        const days: any = await (await fetch(`/api/public/availability/days?from=${from}&days=30&services=${cut.id}&barber=${karim.id}`)).json();
        const fmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
        const date = Object.keys(days.days).find((d) => fmt.format(new Date(d + 'T12:00:00Z')) === dateLabel);
        if (!date) return 'date-not-found';
        const slots: any = await (await fetch(`/api/public/availability?date=${date}&services=${cut.id}&barber=${karim.id}`)).json();
        const tf = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: shop.settings.timezone });
        return slots.slots.some((s: any) => tf.format(new Date(s.start)) === time) ? 'still-offered' : 'blocked';
      }, { dateLabel, time });
      expect(taken === 'blocked', `manual booking did not block public availability (${taken})`);
    });

    await step('barber schedule (week view) renders', async () => {
      await barber.keyboard.press('Escape');
      await barber.goto(`${BASE}/app/schedule`);
      await barber.locator('.cal-day').waitFor();
      await barber.getByRole('button', { name: 'week', exact: true }).click();
      await barber.locator('.cal-week .cal-ev').first().waitFor();
      await shot(barber, '33-barber-week');
      await barber.goto(`${BASE}/app/earnings`);
      await barber.getByText('Owed to me').waitFor();
      await shot(barber, '34-barber-earnings', true);
    });

    await step('mobile: barber day view works at 390px', async () => {
      const m = await newPage(browser, { width: 390, height: 844 });
      await login(m, 'Barber');
      await m.locator('.stats .stat').first().waitFor();
      expect(await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'dashboard scrolls horizontally on mobile');
      await shot(m, '35-mobile-barber-today', true);
      await m.context().close();
    });

    // ---------- Customer ----------
    await step('customer signs in and sees only their own upcoming and past appointments', async () => {
      const c = await newPage(browser);
      await login(c, 'Customer');
      await c.locator('.appt-card').first().waitFor();
      expect(await c.locator('.appt-card').count() === 1, 'expected exactly one upcoming appointment');
      await shot(c, '40-account');
      await c.locator('[data-tab="past"]').click();
      expect(await c.locator('.appt-card').count() >= 2, 'expected past appointments');
      const status = await c.evaluate(async () => (await fetch('/api/staff/appointments', { headers: { 'X-Requested-With': 'clubbarber' } })).status);
      expect(status === 403, `staff API returned ${status} for a customer`);
      await c.goto(`${BASE}/app/overview`);
      await c.waitForURL('**/account');
      await c.context().close();
    });

    await step('arriving from a barber card skips the "which barber" step', async () => {
      const b = await newPage(browser);
      await b.goto(`${BASE}/barbers`);
      await b.locator('.profile').nth(1).getByRole('link', { name: /Book with/ }).click();
      await b.waitForURL('**/book?barber=*');
      await b.locator('.with-barber').waitFor();
      await b.getByRole('button', { name: /Coupe classique/ }).click();
      await b.locator('.book-actions').getByRole('button', { name: 'Continue' }).click();
      await b.locator('.slot').first().waitFor();
      expect(await b.locator('.who-card').count() === 0, 'the barber step was shown again');
      expect((await b.locator('.summary').first().textContent())?.includes('Poste 2'), 'the chosen barber is not in the summary');
      await b.context().close();
    });

    await step('French is the default language; Arabic switches the site to right-to-left', async () => {
      const f = await newPage(browser, { width: 1440, height: 900 }, null);
      await f.goto(BASE);
      await f.getByRole('heading', { level: 1 }).waitFor();
      expect(await f.evaluate(() => document.documentElement.lang) === 'fr', 'default language is not French');
      await f.getByRole('link', { name: 'Prendre rendez-vous' }).first().waitFor();
      await f.waitForTimeout(1200);
      await shot(f, '50-home-fr');
      await f.goto(`${BASE}/book`);
      await f.getByRole('button', { name: /Coupe classique/ }).click();
      await f.locator('.book-actions').getByRole('button', { name: 'Continuer' }).click();
      await f.getByRole('button', { name: /Premier disponible/ }).click();
      await f.locator('.slot').first().waitFor();
      await shot(f, '51-book-fr');
      await f.goto(BASE);
      await f.locator('.site-nav .lang button[lang="ar"]').click();
      expect(await f.evaluate(() => document.documentElement.dir) === 'rtl', 'Arabic did not switch the page to RTL');
      await f.getByRole('link', { name: 'احجز موعدًا' }).first().waitFor();
      expect(await f.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Arabic home page scrolls horizontally');
      await f.waitForTimeout(600);
      await shot(f, '52-home-ar');
      await f.goto(`${BASE}/book`);
      await f.locator('.steps').waitFor();
      await f.locator('.slot, .pick-row').first().waitFor();
      await shot(f, '53-book-ar');
      const m = await newPage(browser, { width: 390, height: 844 }, 'ar');
      await m.goto(BASE);
      await m.getByRole('heading', { level: 1 }).waitFor();
      expect(await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Arabic mobile home scrolls horizontally');
      await m.waitForTimeout(1200);
      await shot(m, '54-mobile-home-ar');
      await m.context().close();
      await f.context().close();
    });

    await step('emails follow the language the customer booked in', async () => {
      const r = await owner.evaluate(async () => {
        const hdr = { 'X-Requested-With': 'clubbarber', 'Content-Type': 'application/json' };
        const shop: any = await (await fetch('/api/public/shop')).json();
        const cut = shop.services.find((s: any) => s.name === 'Coupe classique');
        const from = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
        const days: any = await (await fetch(`/api/public/availability/days?from=${from}&days=14&services=${cut.id}&barber=any`)).json();
        const date = Object.keys(days.days).find((d) => days.days[d] > 3)!;
        const slots: any = await (await fetch(`/api/public/availability?date=${date}&services=${cut.id}&barber=any`)).json();
        const out: Record<string, string> = {};
        let i = 0;
        for (const lang of ['fr', 'ar']) {
          const email = `lang-${lang}@example.com`;
          const code: any = await (await fetch('/api/public/booking/request-code', { method: 'POST', headers: hdr, credentials: 'omit', body: JSON.stringify({ email, lang }) })).json();
          const b: any = await (await fetch('/api/public/bookings', { method: 'POST', headers: hdr, credentials: 'omit', body: JSON.stringify({ serviceIds: [cut.id], barber: 'any', start: slots.slots[(i += 4) - 4].start, name: 'Lang Test', email, phone: '+216 55 000 111', code: code.devCode, lang }) })).json();
          if (!b.appointment) throw new Error(`booking in ${lang} failed: ${JSON.stringify(b)} / code ${JSON.stringify(code)}`);
          const list: any = await (await fetch('/api/admin/notifications', { headers: hdr })).json();
          out[lang] = list.notifications.find((n: any) => n.reference === b.appointment.reference && n.type === 'booking_confirmation')?.subject ?? '';
        }
        return out;
      });
      expect(r.fr.startsWith('Réservation confirmée'), `French subject was "${r.fr}"`);
      expect(r.ar.startsWith('تم تأكيد الحجز'), `Arabic subject was "${r.ar}"`);
    });

    await step('the dashboard is translated: French and Arabic (right-to-left)', async () => {
      const d = await newPage(browser, { width: 1440, height: 900 }, 'fr');
      await login(d, 'Owner');
      await d.getByRole('heading', { name: "Vue d'ensemble" }).waitFor();
      await d.getByRole('link', { name: 'Paie des coiffeurs' }).waitFor();
      await d.locator('.chart svg path').first().waitFor();
      await shot(d, '60-overview-fr', true);
      await d.goto(`${BASE}/app/reports`);
      await d.getByText("Résultat d'exploitation — travail réalisé").waitFor();
      await shot(d, '61-reports-fr', true);
      await d.locator('.side .lang button[lang="ar"]').click();
      await d.getByRole('heading', { name: 'التقارير' }).waitFor();
      expect(await d.evaluate(() => document.documentElement.dir) === 'rtl', 'dashboard did not switch to RTL');
      expect(await d.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Arabic dashboard scrolls horizontally');
      // Navigate with the menu (a full reload would re-apply this test's stored French preference).
      await d.getByRole('link', { name: 'نظرة عامة' }).click();
      await d.locator('.chart svg path').first().waitFor();
      expect(await d.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Arabic overview scrolls horizontally');
      await shot(d, '62-overview-ar', true);
      await d.getByRole('link', { name: 'تقويم الصالون' }).click();
      await d.locator('.cal-day').waitFor();
      await shot(d, '63-calendar-ar');
      await d.getByRole('link', { name: 'اليوم', exact: true }).click();
      await d.locator('.stats .stat').first().waitFor();
      await shot(d, '64-today-ar');
      await d.context().close();
    });

    await step('no JavaScript errors were logged in the browser', async () => {
      expect(consoleErrors.length === 0, `${consoleErrors.length} console error(s):\n${consoleErrors.slice(0, 6).join('\n')}`);
    });

    await browser.close();
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 400));
    for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} browser checks passed. Screenshots: e2e/screenshots`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

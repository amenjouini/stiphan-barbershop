# Club Barber

Booking, staff management and accounting for a barbershop: a public website with online booking, a dashboard for the owner, and a simpler one for each barber.

"Club Barber" is a working name. Change it in **Settings → Shop profile**; it is not hardcoded in the pages or emails.

## Quick start

Requires **Node.js 22.13 or newer** (the database uses Node's built-in SQLite, so there is nothing else to install).

```bash
npm install
cp .env.example .env      # optional; the defaults work for local use
npm run seed              # creates the database and demo data (safe to run twice)
npm run build             # builds the web app into /dist
npm start                 # serves site + API
```

Open **http://localhost:4000**.

For development with hot reload: `npm run dev`, then open http://localhost:5173 (the API runs on 4000).

### Demo logins (development only)

| Role | Email | Password |
| --- | --- | --- |
| Owner (also a barber) | `owner@clubbarber.test` | `Owner#2026` |
| Barber (Poste 2) | `poste2@clubbarber.test` | `Barber#2026` |
| Barber (Poste 3, Poste 4) | `poste3@clubbarber.test`, `poste4@clubbarber.test` | `Barber#2026` |
| Customer | `customer@clubbarber.test` | `Customer#2026` |

The sign-in page shows one-click demo buttons while the demo owner exists and `NODE_ENV` is not `production`.
These accounts are created only by `npm run seed`. **Never seed a production database** — use `npm run create-owner` instead (below).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | API (watch mode) + Vite dev server |
| `npm run build` | Production build of the web app |
| `npm start` | Runs the server; serves `/dist` when it exists |
| `npm run migrate` | Applies pending migrations (also happens on every start) |
| `npm run seed` | Adds demo data if the database has no accounts; otherwise does nothing |
| `npm run reset:demo` | Deletes the dev database and seeds the demo again (refused in production) |
| `npm run reset:empty` | Deletes the dev database and leaves it empty; then run `npm run create-owner` |
| `npm run create-owner` | Creates the first owner from `OWNER_EMAIL`, `OWNER_PASSWORD`, `OWNER_NAME` |
| `npm run typecheck` | TypeScript checks for client, server and e2e |
| `npm test` | Backend integration tests (in-memory database, real HTTP) |
| `npm run test:e2e` | Browser run with installed Edge/Chrome against a throw-away seeded database (needs `npm run build`) |

## What is in the app

**Public site** — home, services, barbers, a five-step booking wizard, "manage my booking" by emailed link, customer accounts (upcoming, history, payments, profile, rebook, feedback).

**Booking engine** — real availability from barber hours ∩ shop hours − breaks − days off/holidays − existing appointments, with configurable interval, buffer, minimum notice and horizon. "First available barber" picks the free barber with the lightest day. Double booking is blocked by a server re-check, a write transaction and a database trigger.

**Barber dashboard** — today's chair with one-tap check-in / start / complete / take payment, day-week-month schedule, manual bookings (phone, walk-in, WhatsApp, in person), own days off, own earnings.

**Owner dashboard** — overview, shop calendar, appointment search, customers, payment ledger, barber pay and payouts, expenses, reports with CSV export, team (profiles, logins, hours, pay arrangement), services, reviews, email outbox, activity log, settings. The owner also has the full barber screens for their own chair.

### How the money works

- Amounts are integers in minor units (millimes for TND). No floating point.
- **Service revenue** = agreed price of appointments marked completed. **Collected** = sum of the payment ledger. Completing a service never records a payment.
- The payment ledger is append-only: payments (+), refunds (−), and corrections that void one earlier entry. The database refuses updates and deletes on it.
- Each form submission carries an idempotency key, so a double click cannot create two payments or two payouts. Paying more than the balance, or refunding more than was collected, is refused.
- Barber compensation is a versioned rule per barber (commission %, fixed per service, salary, none) with an explicit basis (earned on completion, or once paid in full). One earning per appointment, with a snapshot of the rule used. Changing a rule never touches past earnings.
- Payouts are a separate ledger and cannot exceed what is owed. Reports subtract payouts only in the cash-flow view, and compensation only in the operating-result view.
- Appointments store their own copy of service names and prices, so catalogue changes do not rewrite history.

## Languages

Translations live in `client/src/i18n/fr.ts` and `client/src/i18n/ar.ts`, keyed by the English text; a missing entry falls back to English. Email wording is in `server/services/emailCopy.ts`. Customers get emails in the language they booked in.

## Starting clean (no demo data)

Stop the server, then:

```bash
npm run reset:empty      # deletes data/clubbarber.db
# put OWNER_EMAIL, OWNER_NAME, OWNER_PASSWORD (10+ characters) in .env
npm run create-owner
npm start
```

Sign in and add your services and team. Uploaded photos live in `data/uploads/`; delete that folder too if you want them gone.

## Configuration

All optional; see `.env.example`.

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP port | `4000` |
| `NODE_ENV` | `production` disables demo conveniences | `development` |
| `APP_URL` | Public URL used in email links | `http://localhost:4000` |
| `DATABASE_PATH` | SQLite file | `./data/clubbarber.db` |
| `COOKIE_SECURE` | `true` when served over HTTPS | `false` |
| `TRUST_PROXY` | Number of reverse proxies in front | `0` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | Email delivery | unset → simulated |
| `OWNER_EMAIL`, `OWNER_PASSWORD`, `OWNER_NAME` | Used once by `npm run create-owner` | — |

### Email

Without `SMTP_HOST`, email runs in **simulated mode**: every message is stored in **Email outbox** (with a preview) and logged, marked "Simulated — not delivered". It is never reported as sent. In this mode the 6-digit verification codes and invitation/reset links are shown on screen so the flows can be tried locally.

To send real email, set the `SMTP_*` variables and `EMAIL_FROM`, then restart. Any SMTP provider works (Brevo, Mailgun, SES, Gmail app password, your host's mailbox). Failed sends are retried with back-off (1, 5, 15, 60 minutes), then marked Failed with the provider's error, and can be retried from the outbox. A booking never waits on, or fails because of, the mail server.

Emails sent: booking confirmation / request received, approval, reschedule, cancellation, reminder (configurable hours before), new-booking alert to the owner, verification code, staff invitation, password reset. Each is deduplicated, so repeating a status change does not send it twice.

Note: in **production without SMTP**, email codes cannot be delivered, so guest email verification and sign-up verification are skipped rather than locking everyone out. Configure SMTP before going live.

## Tests

Run on 13 Oct 2026 on Windows 11, Node 22.20:

- `npm run typecheck` — passes.
- `npm test` — **37 of 37 pass.** Covers: availability (hours, breaks, closed days, days off, lead time, horizon, buffer); guest booking with email code; same-slot and overlap rejection, including four simultaneous requests and a raw SQL insert stopped by the trigger; manual bookings blocking public slots; "any barber" assignment; reschedule/cancel policy; manual approval; lifecycle and invalid transitions; completion without payment; repeated completion; partial payments, overpayment, duplicate submission; refunds, voids, ledger immutability; price-change history; commission, fixed and paid-in-full rules; payouts and over-payout; duplicate salary; role permissions for anonymous, barber, customer and owner; CSRF; account verification; staff invites; deactivation; seed idempotency and full reconciliation of seeded figures; simulated and failing email; reminders; persistence across a restart on a real database file.
- `npm run build` — passes.
- `npm run test:e2e` — **16 of 16 pass** in Microsoft Edge: public pages and images, full guest booking through the wizard, manage link, owner completing the booking and taking a part payment then the rest, all owner pages, outbox state, barber restrictions, barber manual booking removing the slot from the public site, customer account isolation, 390 px mobile layouts, and no browser console errors.

Not run: delivery through a real SMTP server (no credentials here; the failure and retry path was tested against a closed port), linting (no linter is configured), and browsers other than Edge/Chromium.

## Database, migrations and backups

- The database is one SQLite file at `DATABASE_PATH` (WAL mode, so `-wal` and `-shm` files sit beside it). Uploaded photos are in an `uploads/` folder next to it.
- Migrations are plain SQL files in `server/migrations/`, applied in filename order and recorded in `schema_migrations`. To change the schema, add `002_something.sql`; it runs on the next start or `npm run migrate`. Do not edit a migration that has already been applied.
- **Backup** while the app is running: `sqlite3 data/clubbarber.db ".backup 'backup-2026-10-13.db'"` (or stop the app and copy the `.db`, `-wal` and `-shm` files together). Copy the `uploads/` folder too. Schedule this daily and keep copies off the machine.
- **Restore**: stop the app, replace the database file with the backup, remove any stale `-wal`/`-shm`, start the app.

## Deployment

One Node process and one data directory. It needs a host with a **persistent disk** (a VPS, Render with a disk, Fly.io with a volume, Railway with a volume). It is not suited to serverless hosts whose filesystem resets.

1. Install Node 22.13+, clone the project, `npm ci`, `npm run build`.
2. Set the environment: `NODE_ENV=production`, `APP_URL=https://your-domain`, `COOKIE_SECURE=true`, `TRUST_PROXY=1`, `DATABASE_PATH=/var/lib/clubbarber/clubbarber.db` (on the persistent disk), and the `SMTP_*` values.
3. Create the owner once: `OWNER_EMAIL=… OWNER_NAME="…" OWNER_PASSWORD='…' npm run create-owner`. Then sign in and set up Settings, Services and Team.
4. Run `npm start` under a process manager (systemd, pm2) and put it behind HTTPS (nginx or Caddy proxying to the port).
5. Run a single instance. SQLite handles one shop comfortably; multiple app instances sharing the file are not supported.

## Project layout

```
client/            React app (Vite)
  src/site/        public website, booking wizard, auth, customer account
  src/app/         staff dashboard pages
  src/components/  calendar, appointment drawer, slot picker, charts, UI kit
  src/styles/      design tokens and CSS
  public/images/   photos stored locally (Unsplash licence)
server/
  migrations/      SQL schema
  services/        availability, appointments, finance, notifications
  routes/          public, auth, me (customer), staff, admin
  tests/           integration tests
shared/            time, money and constants used by both sides
e2e/               browser test
```

## Known limitations

- **No online card payments.** Payments are recorded by staff (cash, card terminal, bank transfer). Adding a gateway needs a provider account.
- **A completed appointment cannot be re-opened.** Money mistakes are corrected with a void or refund; a service marked completed by mistake stays completed.
- **Blocking time does not cancel existing bookings.** The app lists the appointments that overlap so you can move or cancel them.
- **Salary is recorded by hand** each month (one entry per barber per month), not accrued automatically.
- **Languages.** The customer side (website, booking, account, sign-in, emails) is in French (default), Arabic (right-to-left) and English; visitors switch with FR / ع / EN and the default is set in Settings → Regional. The staff dashboard is translated too, with its own switch in the sidebar (`client/src/i18n/fr-app.ts`, `ar-app.ts`). Text you type yourself (service names, descriptions, tagline, barber bios) is stored in one language and shown as written.
- **Overnight opening hours** (past midnight) are not supported.
- The rate limiter and email queue worker live in the app process, which is fine for a single instance.
- Photos in `client/public/images` are stock images for the demo; replace them with the shop's own in Team and Services.

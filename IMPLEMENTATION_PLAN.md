# Club Barber — implementation plan

Starting point: an empty directory. Everything below was built in this project.

## Stack decisions

| Area | Choice | Why |
| --- | --- | --- |
| Frontend | React 18 + Vite + TypeScript, React Router, hand-written CSS design system | Small, fast, no template look; no CSS framework to fight |
| Backend | Node 22 + Express 4 + TypeScript (run with `tsx`) | One language end to end, one process to deploy |
| Database | SQLite through Node's built-in `node:sqlite`, SQL migrations | Persistent, transactional, zero native build step; right-sized for one shop |
| Auth | Email + password (scrypt), server-side sessions in an httpOnly cookie, CSRF header + Origin check | No third-party auth dependency |
| Money | Integer minor units (millimes for TND), append-only ledgers | No floating point anywhere near money |
| Time | UTC epoch ms in the database, shown in the shop's IANA timezone | DST-safe, timezone is a setting |
| Email | Nodemailer SMTP behind an outbox queue; simulated mode without credentials | Bookings never wait on the mail provider |

## Business rules

- **Roles**: owner (admin + barber), barber (own chair only), customer (own records only). Enforced in the API.
- **Availability** = barber hours ∩ shop hours − breaks − time off/holidays − existing appointments (+ buffer), on the slot grid, after the lead time and inside the booking horizon.
- **Double booking** is prevented three times: server re-check, `BEGIN IMMEDIATE` transaction, and a database trigger.
- **Statuses**: pending → confirmed → checked in → in progress → completed; cancelled and no-show from the open states. Completed, cancelled and no-show are final. Re-applying a status is a no-op.
- **Completion ≠ payment**. Revenue is counted when a service is completed; "collected" is the sum of the payment ledger.
- **Payments ledger**: payment (+), refund (−), adjustment (void of one earlier entry). Rows are never updated or deleted (triggers). Idempotency keys stop double submits; overpayment and over-refund are refused.
- **Compensation**: versioned rule per barber (commission %, fixed per service, salary, none) with an explicit basis (on completion / once paid in full). One earning row per appointment with a snapshot of the rule. Payouts are a separate ledger and can never exceed what is owed.
- **Prices** are snapshotted on the appointment; catalogue changes never touch history.

## Checklist

- [x] Phase 1 — Inspect (empty project), choose stack, write this plan
- [x] Phase 2 — Schema + migrations, auth, sessions, CSRF, roles, rate limiting, audit log, demo seed
- [x] Phase 4 (API) — Availability engine, booking, reschedule/cancel policies, manage-by-link, email outbox + reminders
- [x] Phase 5 (API) — Staff endpoints: schedule, manual bookings, status changes, payments, time off, earnings
- [x] Phase 6 (API) — Admin: overview, reports, CSV, services, team, schedules, compensation, payouts, customers, expenses, settings, outbox, activity log
- [x] Backend integration tests (booking, lifecycle, accounting, permissions, seed, email, persistence)
- [x] Phase 3 — Design system (tokens, type, buttons, forms, badges, tables, dialogs, drawer, toasts, charts) and customer website
- [x] Phase 4 (UI) — Booking wizard, manage-by-link page, customer account
- [x] Phase 5 (UI) — Barber dashboard: today, schedule (day/week/month), manual booking, time off, earnings
- [x] Phase 6 (UI) — Owner dashboard: overview, calendar, appointments, customers, payments, barber pay, expenses, reports, team, services, reviews, outbox, activity, settings
- [x] Phase 7 — Production build, browser end-to-end run (16 checks), README, deployment notes

## Verification (13 Oct 2026)

- `npm run typecheck` passes; `npm test` 37/37; `npm run build` passes; `npm run test:e2e` 16/16 in Edge.
- Found and fixed during testing: mobile horizontal overflow in the wizard, a `.wrap` class collision that indented dashboard toolbars, hero text flush to the viewport edge, calendar event text wrapping, sidebar footer below the fold, unpaid completed rows shown faded.

## Not done / left for later

- Online card payments (needs a gateway account).
- Re-opening a completed appointment.
- Automatic salary accrual; translations; overnight opening hours.
- Real SMTP delivery was not exercised (no credentials); the simulated and failure/retry paths were.

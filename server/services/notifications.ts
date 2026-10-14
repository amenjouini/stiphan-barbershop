import nodemailer, { type Transporter } from 'nodemailer';
import { config, emailConfigured } from '../config.ts';
import { all, get, run } from '../db.ts';
import { getSettings } from '../lib/settings.ts';
import { formatMoney } from '../../shared/money.ts';
import { fmtDate, fmtTime } from '../../shared/time.ts';
import { COPY, fill, isLang, LOCALE, type Lang } from './emailCopy.ts';
import { appointmentDetail } from './queries.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ---------- Templates ----------

/** The language to write to a customer in: their own choice if known, otherwise the shop default. */
function langOf(value: unknown): Lang {
  return isLang(value) ? value : isLang(getSettings().default_language) ? (getSettings().default_language as Lang) : 'fr';
}

function layout(heading: string, bodyHtml: string, lang: Lang) {
  const s = getSettings();
  const rtl = lang === 'ar';
  const align = rtl ? 'right' : 'left';
  return `<!doctype html><html lang="${lang}" dir="${rtl ? 'rtl' : 'ltr'}"><body style="margin:0;background:#12110f;font-family:Helvetica,Arial,Tahoma,sans-serif;color:#1a1815">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#12110f;padding:32px 12px" dir="${rtl ? 'rtl' : 'ltr'}"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;text-align:${align}">
<tr><td style="padding:8px 4px 20px;color:#f3ede2;font-size:13px;letter-spacing:${rtl ? 0 : 4}px;text-transform:uppercase">${esc(s.shop_name)}</td></tr>
<tr><td style="background:#f6f1e7;padding:36px 32px;border-top:3px solid #b87344">
<h1 style="margin:0 0 18px;font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:28px;line-height:1.3;color:#12110f">${esc(heading)}</h1>
${bodyHtml}
</td></tr>
<tr><td style="padding:20px 4px;color:#8b8375;font-size:12px;line-height:1.6">
${esc(s.shop_name)} · ${esc(s.address)}, ${esc(s.city)}<br><span dir="ltr">${esc(s.phone)}</span> · ${esc(s.email)}
</td></tr></table></td></tr></table></body></html>`;
}

const p = (html: string) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#3a352e">${html}</p>`;
const button = (href: string, label: string) =>
  `<p style="margin:24px 0 6px"><a href="${esc(href)}" style="background:#12110f;color:#f3ede2;text-decoration:none;padding:13px 22px;font-size:13px;display:inline-block">${esc(label)}</a></p>`;
const rows = (pairs: [string, string][]) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;border-top:1px solid #d9d0bf">${pairs
    .map(([k, v]) => `<tr><td style="padding:10px 0;border-bottom:1px solid #d9d0bf;font-size:12px;color:#8b8375;width:38%">${esc(k)}</td><td style="padding:10px 0;border-bottom:1px solid #d9d0bf;font-size:15px;color:#12110f">${esc(v)}</td></tr>`)
    .join('')}</table>`;

type ApptEmailKind = 'confirmation' | 'pending' | 'approved' | 'rescheduled' | 'cancelled' | 'reminder' | 'owner_new';

function appointmentEmail(kind: ApptEmailKind, apptId: number, manageToken?: string) {
  const s = getSettings();
  const a = appointmentDetail(apptId);
  // Customers are written to in their own language; the owner alert uses the shop default.
  const lang = langOf(kind === 'owner_new' ? null : get<any>('SELECT locale FROM customers WHERE id = ?', a.customer_id)?.locale);
  const c = COPY[lang];
  const money = (m: number) => formatMoney(m, a.currency, s.currency_decimals);
  const when = `${fmtDate(a.starts_at, s.timezone, 'long', LOCALE[lang])} ${c.at} ${fmtTime(a.starts_at, s.timezone)}`;
  const details: [string, string][] = [
    [c.labels.reference, a.reference],
    [c.labels.service, a.services],
    [c.labels.barber, a.barber_name],
    [c.labels.when, when],
    [c.labels.duration, c.duration(a.duration_min)],
    [c.labels.price, `${money(a.total_minor)} — ${c.pay[a.payment_status]}`],
    [c.labels.where, `${s.shop_name}, ${s.address}, ${s.city}`],
  ];
  const token = manageToken ?? get<any>('SELECT manage_token FROM appointments WHERE id = ?', apptId)?.manage_token;
  const manageUrl = token ? `${config.appUrl}/manage/${a.reference}?token=${token}` : `${config.appUrl}/account`;
  const policy = fill(c.policy, { cancel: s.cancel_min_hours, reschedule: s.reschedule_min_hours, phone: s.phone });
  const vars = {
    name: a.customer_name, when, ref: a.reference, shop: s.shop_name,
    phone: a.customer_phone || c.noPhone, email: a.customer_email || c.noEmail,
    reason: a.cancel_reason ? ` ${fill(c.reason, { reason: a.cancel_reason })}` : '',
    approval: a.status === 'pending' ? ` ${c.awaitingApproval}` : '',
  };
  const k = c.kinds[kind];
  const heading = fill(k.heading, vars), intro = fill(k.intro, vars);
  const manage = kind !== 'cancelled' && kind !== 'owner_new';
  const html = layout(heading, [
    p(esc(intro)),
    rows(details),
    manage ? button(manageUrl, c.manageButton) + p(`<span style="font-size:13px;color:#8b8375">${esc(policy)}</span>`) : '',
    kind === 'owner_new' ? button(`${config.appUrl}/app/appointments?open=${a.id}`, c.dashboardButton) : '',
  ].join(''), lang);
  const text = [heading, '', intro, '', ...details.map(([label, v]) => `${label}: ${v}`), '', manage ? `${c.manageText} ${manageUrl}\n${policy}` : ''].join('\n');
  return { subject: fill(k.subject, vars), html, text, to: kind === 'owner_new' ? s.owner_notify_email || s.email : a.customer_email, appointmentId: a.id };
}

export function codeEmail(to: string, code: string, purpose: 'verify' | 'booking', language?: unknown) {
  const s = getSettings();
  const lang = langOf(language);
  const c = COPY[lang].code;
  const heading = purpose === 'verify' ? c.verifyHeading : c.bookingHeading;
  const intro = fill(purpose === 'verify' ? c.verifyIntro : c.bookingIntro, { shop: s.shop_name });
  const html = layout(heading, p(esc(intro)) +
    `<p style="margin:22px 0;font-family:Georgia,serif;font-size:38px;letter-spacing:10px;color:#12110f" dir="ltr">${esc(code)}</p>` +
    p(`<span style="font-size:13px;color:#8b8375">${esc(c.expires)}</span>`), lang);
  return { to, subject: fill(c.subject, { code, shop: s.shop_name }), html, text: `${intro}\n\n${c.codeLabel}: ${code}\n\n${c.expires}` };
}

export function linkEmail(to: string, kind: 'invite' | 'reset', url: string, name: string, language?: unknown) {
  const s = getSettings();
  const lang = langOf(language);
  const c = COPY[lang].link;
  const vars = { shop: s.shop_name, name };
  const heading = fill(kind === 'invite' ? c.inviteHeading : c.resetHeading, vars);
  const intro = fill(kind === 'invite' ? c.inviteIntro : c.resetIntro, vars);
  const html = layout(heading, p(esc(intro)) + button(url, kind === 'invite' ? c.inviteButton : c.resetButton), lang);
  return { to, subject: fill(kind === 'invite' ? c.inviteSubject : c.resetSubject, vars), html, text: `${intro}\n\n${url}` };
}

// ---------- Queue ----------

interface OutMail { to: string | null; subject: string; html: string; text: string; appointmentId?: number }

/**
 * Stores an email in the outbox. `dedupeKey` makes enqueueing idempotent, so
 * repeated status updates never produce duplicate emails. Delivery happens
 * asynchronously and never blocks or fails the caller.
 */
export function enqueue(type: string, mail: OutMail, dedupeKey: string | null = null): boolean {
  if (!mail.to) return false;
  const now = Date.now();
  const r = run(
    `INSERT OR IGNORE INTO notifications (type, appointment_id, to_email, subject, html, text, dedupe_key, next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    type, mail.appointmentId ?? null, mail.to, mail.subject, mail.html, mail.text, dedupeKey, now, now,
  );
  if (r.changes && !config.isTest) setImmediate(() => void processQueue());
  return r.changes > 0;
}

export function notifyAppointment(kind: ApptEmailKind, apptId: number, opts: { manageToken?: string; dedupeKey: string }) {
  try {
    enqueue(`booking_${kind}`, appointmentEmail(kind, apptId, opts.manageToken), opts.dedupeKey);
  } catch (e) {
    console.error('[email] could not enqueue', kind, apptId, e);
  }
}

let transporter: Transporter | null = null;
function getTransporter() {
  transporter ??= nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return transporter;
}

const BACKOFF_MIN = [1, 5, 15, 60];
const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;
let processing = false;

/** Delivers due emails. Simulated mode marks them "simulated" — never "sent". */
export async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    const due = all<any>("SELECT * FROM notifications WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY id LIMIT 25", Date.now());
    for (const n of due) {
      if (!emailConfigured()) {
        run("UPDATE notifications SET status = 'simulated', attempts = attempts + 1, sent_at = ? WHERE id = ?", Date.now(), n.id);
        if (!config.isTest) console.log(`[email:SIMULATED] to=${n.to_email} subject="${n.subject}" (configure SMTP_HOST to deliver)`);
        continue;
      }
      try {
        const s = getSettings();
        await getTransporter().sendMail({
          from: config.smtp.from || `${s.shop_name} <${config.smtp.user}>`, to: n.to_email, subject: n.subject, html: n.html, text: n.text,
        });
        run("UPDATE notifications SET status = 'sent', attempts = attempts + 1, sent_at = ?, last_error = NULL WHERE id = ?", Date.now(), n.id);
      } catch (e: any) {
        const attempts = n.attempts + 1;
        const failed = attempts >= MAX_ATTEMPTS;
        run('UPDATE notifications SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?',
          failed ? 'failed' : 'queued', attempts, String(e?.message || e).slice(0, 500),
          Date.now() + (BACKOFF_MIN[attempts - 1] ?? 60) * 60_000, n.id);
        console.error(`[email] delivery to ${n.to_email} failed (attempt ${attempts}/${MAX_ATTEMPTS}): ${e?.message || e}`);
      }
    }
  } finally {
    processing = false;
  }
}

export function retryNotification(id: number) {
  const r = run("UPDATE notifications SET status = 'queued', attempts = 0, next_attempt_at = ?, last_error = NULL WHERE id = ? AND status = 'failed'", Date.now(), id);
  if (r.changes) setImmediate(() => void processQueue());
  return r.changes > 0;
}

/** Queues one reminder per upcoming confirmed appointment (deduped per start time). */
export function enqueueReminders(now = Date.now()) {
  const hours = getSettings().reminder_hours;
  if (!hours) return 0;
  const upcoming = all<any>(
    `SELECT a.id, a.starts_at FROM appointments a JOIN customers c ON c.id = a.customer_id
     WHERE a.status = 'confirmed' AND c.email IS NOT NULL AND a.starts_at > ? AND a.starts_at <= ? AND a.created_at < ?`,
    now, now + hours * 3_600_000, now - 3_600_000,
  );
  let n = 0;
  for (const a of upcoming) {
    const key = `reminder:${a.id}:${a.starts_at}`;
    if (get('SELECT 1 FROM notifications WHERE dedupe_key = ?', key)) continue;
    notifyAppointment('reminder', a.id, { dedupeKey: key });
    n++;
  }
  return n;
}

export function startWorkers() {
  const tick = () => {
    try {
      enqueueReminders();
      run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    } catch (e) {
      console.error('[worker]', e);
    }
    void processQueue();
  };
  setTimeout(tick, 3000);
  setInterval(tick, 60_000).unref();
}

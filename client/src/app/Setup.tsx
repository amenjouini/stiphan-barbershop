import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { Async, Empty, Field, Img, Modal, MoneyInput, Notice, Pagination, Stars, useAction } from '../components/ui';
import { api, qs } from '../lib/api';
import { useFmt, useShop } from '../lib/context';
import { fmtDuration, fmtMinutes, parseMinutes, WEEKDAYS } from '../../../shared/time';
import { useApp, useLive } from './AppLayout';
import { PageHead } from './shared';
import { PhotoField } from './Team';
import { tr } from '../lib/i18n';

// ---------- Services ----------

export function ServicesAdmin() {
  const fmt = useFmt();
  const state = useLive<{ services: any[] }>('/admin/services');
  const [editing, setEditing] = useState<any | null>(null);
  return (
    <>
      <PageHead title={tr("Services")} sub={tr("Your menu. Changing a price or name only affects new bookings — past appointments keep what was agreed.")}>
        <button className="btn btn-primary" onClick={() => setEditing({})}><Icon name="plus" size={15} />{tr("Add service")}</button>
      </PageHead>
      <div className="card">
        <Async state={state}>{(d) => d.services.length ? (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{tr("Service")}</th><th className="hide-sm">{tr("Category")}</th><th className="r">{tr("Duration")}</th><th className="r">{tr("Price")}</th><th className="r hide-sm">{tr("Times booked")}</th><th>{tr("Status")}</th></tr></thead>
            <tbody>{d.services.map((s) => (
              <tr key={s.id} className="click" onClick={() => setEditing(s)}>
                <td><div className="person"><Img src={s.image_url} alt="" label={s.name} /><div><b>{s.name}</b><small>{s.description || tr("No description")}</small></div></div></td>
                <td className="hide-sm">{s.category || '—'}</td><td className="r num nowrap">{fmtDuration(s.duration_min)}</td><td className="r num nowrap"><b>{fmt.money(s.price_minor)}</b></td>
                <td className="r num hide-sm">{s.times_booked}</td><td><span className={`badge ${s.is_active ? 'ok' : ''}`}>{s.is_active ? tr("Active") : tr("Hidden")}</span></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty icon="razor" title={tr("No services yet.")} action={<button className="btn btn-primary" onClick={() => setEditing({})}>{tr("Add your first service")}</button>}>{tr("Customers can only book once at least one service exists.")}</Empty>}</Async>
      </div>
      {editing && <ServiceForm service={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function ServiceForm({ service, onClose }: { service: any; onClose: () => void }) {
  const fmt = useFmt();
  const { touch } = useApp();
  const { reload } = useShop();
  const act = useAction();
  const isNew = !service.id;
  const [f, setF] = useState({
    name: service.name ?? '', description: service.description ?? '', category: service.category ?? '', price: service.id ? fmt.plain(service.price_minor) : '',
    duration_min: service.duration_min ?? 30, image_url: service.image_url ?? null as string | null, is_active: service.id ? !!service.is_active : true, sort_order: service.sort_order ?? 0,
  });
  const price = fmt.parse(f.price);
  const finish = async () => { touch(); await reload(); onClose(); };
  const save = () => act.run(async () => {
    const body = { name: f.name.trim(), description: f.description.trim(), category: f.category.trim() || null, price_minor: price, duration_min: Number(f.duration_min), image_url: f.image_url, is_active: f.is_active, sort_order: Number(f.sort_order) };
    await (isNew ? api('/admin/services', { body }) : api(`/admin/services/${service.id}`, { method: 'PATCH', body }));
    await finish();
  }, tr("Service saved."));
  const remove = () => act.run(async () => {
    const r = await api(`/admin/services/${service.id}`, { method: 'DELETE' });
    await finish();
    return r;
  }, service.times_booked ? tr("Service hidden (it has booking history, so it was not deleted).") : tr("Service deleted."));
  return (
    <Modal wide title={isNew ? tr("Add service") : tr("Edit service")} onClose={onClose} footer={<>
      {!isNew && <button className="btn btn-danger" style={{ marginRight: 'auto' }} disabled={act.busy} onClick={remove}>{service.times_booked ? tr("Hide service") : tr("Delete")}</button>}
      <button className="btn btn-ghost" onClick={onClose}>{tr("Discard")}</button>
      <button className="btn btn-dark" disabled={act.busy || f.name.trim().length < 2 || price == null || !(f.duration_min >= 5)} onClick={save}>{tr("Save service")}</button>
    </>}>
      <div className="stack">
        {act.error && <Notice tone="bad" icon="alert">{act.error}</Notice>}
        <div className="form-grid cols-2">
          <Field label={tr("Name")}><input className="input" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label={tr("Category (optional)")}><input className="input" value={f.category} maxLength={60} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder={tr("Hair, Beard, Packages…")} list="service-cats" /></Field>
          <datalist id="service-cats"><option value="Hair" /><option value="Beard" /><option value="Shave" /><option value="Packages" /></datalist>
        </div>
        <Field label={tr("Description")}><textarea className="textarea" maxLength={600} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <div className="form-grid cols-3">
          <Field label={tr("Price")}><MoneyInput value={f.price} onChange={(v) => setF({ ...f, price: v })} /></Field>
          <Field label={tr("Duration")}><div className="input-affix"><input className="input num" type="number" min={5} max={480} step={5} value={f.duration_min} onChange={(e) => setF({ ...f, duration_min: Number(e.target.value) })} /><span>MIN</span></div></Field>
          <Field label={tr("Display order")}><input className="input num" type="number" min={0} max={999} value={f.sort_order} onChange={(e) => setF({ ...f, sort_order: Number(e.target.value) })} /></Field>
        </div>
        <PhotoField label={tr("Image (optional)")} name={f.name} value={f.image_url} onChange={(image_url) => setF({ ...f, image_url })} />
        <label className="switch"><span><b>{tr("Bookable")}</b><small>{tr("Turn off to hide it from the website and from new bookings.")}</small></span><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /></label>
        {isNew && <p className="field-hint">{tr("New services are offered by every active barber. Adjust per barber in Team.")}</p>}
      </div>
    </Modal>
  );
}

// ---------- Settings ----------

const ORDER = [1, 2, 3, 4, 5, 6, 0];

export function Settings() {
  const state = useLive<any>('/admin/settings');
  const { reload } = useShop();
  const act = useAction();
  const hoursAct = useAction();
  const [s, setS] = useState<any | null>(null);
  const [hours, setHours] = useState<any[] | null>(null);
  useEffect(() => {
    if (state.data && !s) {
      setS(state.data.settings);
      setHours(ORDER.map((wd) => {
        const h = state.data.business_hours.find((x: any) => x.weekday === wd);
        return { weekday: wd, open: fmtMinutes(h?.open_min ?? 540), close: fmtMinutes(h?.close_min ?? 1140), is_closed: h ? !!h.is_closed : true };
      }));
    }
  }, [state.data, s]);
  const num = (k: string, props: Record<string, unknown> = {}) => <input className="input num" type="number" value={s[k]} onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })} {...props} />;
  const text = (k: string, props: Record<string, unknown> = {}) => <input className="input" value={s[k] ?? ''} onChange={(e) => setS({ ...s, [k]: e.target.value })} {...props} />;
  const toggle = (k: string, title: string, sub: string) => <label className="switch"><span><b>{title}</b><small>{sub}</small></span><input type="checkbox" checked={!!s[k]} onChange={(e) => setS({ ...s, [k]: e.target.checked })} /></label>;
  const save = () => act.run(async () => { await api('/admin/settings', { method: 'PUT', body: s }); await reload(); }, tr("Settings saved."));
  const saveHours = () => hoursAct.run(async () => {
    const body = hours!.map((h) => {
      const o = parseMinutes(h.open), c = parseMinutes(h.close);
      if (o == null || c == null || o >= c) throw new Error(`${tr(WEEKDAYS[h.weekday])}: ${tr("closing time must be after opening time.")}`);
      return { weekday: h.weekday, open_min: o, close_min: c, is_closed: h.is_closed };
    });
    await api('/admin/business-hours', { method: 'PUT', body: { hours: body } });
    await reload();
  }, tr("Opening hours saved."));

  return (
    <>
      <PageHead title={tr("Settings")} sub={tr("Shop details, booking rules and permissions. Changes apply immediately to the website and the booking engine.")}>
        <button className="btn btn-primary" disabled={!s || act.busy} onClick={save}>{tr("Save settings")}</button>
      </PageHead>
      <Async state={state}>{(d) => !s || !hours ? null : (
        <div className="stack">
          {act.error && <Notice tone="bad" icon="alert">{act.error}</Notice>}
          <div className="grid c2">
            <div className="card"><div className="card-head"><h2>{tr("Shop profile")}</h2></div><div className="card-body stack">
              <div className="form-grid cols-2"><Field label={tr("Shop name")}>{text('shop_name')}</Field><Field label={tr("Tagline")} hint={tr("Used as the homepage headline.")}>{text('tagline')}</Field></div>
              <Field label={tr("About")}><textarea className="textarea" maxLength={600} value={s.about} onChange={(e) => setS({ ...s, about: e.target.value })} /></Field>
              <div className="form-grid cols-2"><Field label={tr("Address")}>{text('address')}</Field><Field label={tr("City / postcode")}>{text('city')}</Field><Field label={tr("Phone")}>{text('phone')}</Field><Field label={tr("Public email")}>{text('email', { type: 'email' })}</Field></div>
              <Field label={tr("Map link (optional)")} hint={tr("Leave empty to link to a map search for your address.")}>{text('map_url')}</Field>
            </div></div>

            <div className="card">
              <div className="card-head"><h2>{tr("Opening hours")}</h2><button className="btn btn-dark btn-sm" disabled={hoursAct.busy} onClick={saveHours}>{tr("Save hours")}</button></div>
              <div className="card-body">
                {hoursAct.error && <div style={{ marginBottom: 12 }}><Notice tone="bad" icon="alert">{hoursAct.error}</Notice></div>}
                <div className="sched">{hours.map((h, i) => (
                  <div className="sched-row" key={h.weekday}>
                    <b>{tr(WEEKDAYS[h.weekday])}</b>
                    <label className="switch" style={{ padding: 0, border: 0 }}><span className="sr-only">{tr("Open on")}{' '}{tr(WEEKDAYS[h.weekday])}</span><input type="checkbox" checked={!h.is_closed} onChange={(e) => setHours(hours.map((x, k) => (k === i ? { ...x, is_closed: !e.target.checked } : x)))} /></label>
                    {h.is_closed ? <span className="muted">{tr("Closed")}</span> : (
                      <div className="times">
                        <input type="time" className="input" value={h.open} aria-label={tr("Opens")} onChange={(e) => setHours(hours.map((x, k) => (k === i ? { ...x, open: e.target.value } : x)))} /><span className="muted">{tr("to")}</span>
                        <input type="time" className="input" value={h.close} aria-label={tr("Closes")} onChange={(e) => setHours(hours.map((x, k) => (k === i ? { ...x, close: e.target.value } : x)))} />
                      </div>
                    )}
                  </div>
                ))}</div>
                <p className="field-hint" style={{ marginTop: 12 }}>{tr("Holidays and one-off closures are added under Shop calendar → Days off & blocked time.")}</p>
              </div>
            </div>
          </div>

          <div className="grid c2">
            <div className="card"><div className="card-head"><h2>{tr("Booking rules")}</h2></div><div className="card-body stack">
              <div className="form-grid cols-2">
                <Field label={tr("Appointment interval")} hint={tr("Start times offered online.")}>
                  <select className="select" value={s.slot_interval_min} onChange={(e) => setS({ ...s, slot_interval_min: Number(e.target.value) })}>{[5, 10, 15, 20, 30, 60].map((n) => <option key={n} value={n}>{tr("Every")}{' '}{n} {tr("min")}</option>)}</select>
                </Field>
                <Field label={tr("Buffer after each appointment")} hint={tr("Clean-up time kept free.")}><div className="input-affix">{num('buffer_min', { min: 0, max: 120 })}<span>MIN</span></div></Field>
                <Field label={tr("Minimum notice")} hint={tr("How soon before the start a customer may book.")}><div className="input-affix">{num('lead_time_min', { min: 0, max: 10080 })}<span>MIN</span></div></Field>
                <Field label={tr("Booking horizon")} hint={tr("How far ahead customers can book.")}><div className="input-affix">{num('horizon_days', { min: 1, max: 365 })}<span>DAYS</span></div></Field>
                <Field label={tr("Free cancellation until")} hint={tr("Before the appointment.")}><div className="input-affix">{num('cancel_min_hours', { min: 0, max: 720 })}<span>H</span></div></Field>
                <Field label={tr("Rescheduling until")} hint={tr("Before the appointment.")}><div className="input-affix">{num('reschedule_min_hours', { min: 0, max: 720 })}<span>H</span></div></Field>
              </div>
              <div>
                {toggle('auto_confirm', tr("Confirm bookings automatically"), tr("Off: every online booking stays “pending” until you approve it."))}
                {toggle('allow_any_barber', (tr("Offer “first available barber") + "”"), tr("The engine assigns the free barber with the lightest day."))}
                {toggle('guest_booking', tr("Allow booking without an account"), tr("Off: customers must sign in before they can book."))}
                {toggle('guest_email_verification', tr("Verify guest emails with a code"), tr("Guests confirm a 6-digit code sent to their email before the booking is created."))}
              </div>
            </div></div>

            <div className="stack">
              <div className="card"><div className="card-head"><h2>{tr("Regional")}</h2></div><div className="card-body stack">
                <Field label={tr("Default website language")} hint={tr("Used for visitors who have not picked a language, and for emails when the customer's language is unknown.")}>
                  <select className="select" value={s.default_language} onChange={(e) => setS({ ...s, default_language: e.target.value })}><option value="fr">{tr("Français")}</option><option value="ar">العربية</option><option value="en">{tr("English")}</option></select>
                </Field>
                <div className="form-grid cols-3">
                  <Field label={tr("Timezone")} hint={tr("IANA name, e.g. Africa/Tunis.")}>{text('timezone')}</Field>
                  <Field label={tr("Currency")} hint={tr("3-letter code.")}>{text('currency', { maxLength: 3, disabled: d.has_money_history, style: { textTransform: 'uppercase' }, onChange: (e: any) => setS({ ...s, currency: e.target.value.toUpperCase() }) })}</Field>
                  <Field label={tr("Decimals")} hint={tr("TND uses 3.")}>{num('currency_decimals', { min: 0, max: 3, disabled: d.has_money_history })}</Field>
                </div>
                {d.has_money_history && <p className="field-hint">{tr("Currency is locked because appointments or payments already exist — changing it would re-denominate history.")}</p>}
              </div></div>
              <div className="card"><div className="card-head"><h2>{tr("Barber permissions")}</h2></div><div className="card-body">
                {toggle('barbers_record_payments', tr("Barbers can record payments"), tr("On their own appointments only. Refunds and corrections always stay with the owner."))}
                {toggle('barbers_see_earnings', tr("Barbers can see their own earnings"), tr("Their compensation ledger and what is owed to them — never anyone else’s."))}
              </div></div>
              <div className="card"><div className="card-head"><h2>{tr("Email")}</h2><span className={`badge ${d.email.configured ? 'ok' : 'warn'}`}>{d.email.configured ? tr("SMTP connected") : tr("Simulated")}</span></div><div className="card-body stack">
                {d.email.configured ? <p className="muted">{tr("Sending through")}{' '}<span className="code">{d.email.host}</span>{d.email.from ? <> {tr("as")}{' '}<span className="code">{d.email.from}</span></> : null}.</p>
                  : <Notice icon="mail">{tr("No SMTP server is configured, so emails are written to the Outbox and the server log but")}{' '}<b>{tr("not delivered")}</b>{". "}{tr("Set")}{' '}<span className="code">SMTP_HOST</span>, <span className="code">SMTP_PORT</span>, <span className="code">SMTP_USER</span>, <span className="code">SMTP_PASS</span> {tr("and")}{' '}<span className="code">EMAIL_FROM</span> {tr("in")}{' '}<span className="code">{"."}{tr("env")}</span> {tr("and restart.")}</Notice>}
                <div className="form-grid cols-2">
                  <Field label={tr("Send reminders")} hint={tr("Before the appointment. 0 turns reminders off.")}><div className="input-affix">{num('reminder_hours', { min: 0, max: 168 })}<span>H</span></div></Field>
                  <Field label={tr("New-booking alerts to")} hint={tr("Defaults to the public email.")}>{text('owner_notify_email', { type: 'email', placeholder: s.email })}</Field>
                </div>
              </div></div>
            </div>
          </div>
        </div>
      )}</Async>
    </>
  );
}

// ---------- Email outbox ----------

const MAIL_TONE: Record<string, string> = { sent: 'ok', simulated: 'warn', queued: 'info', failed: 'bad' };
const MAIL_LABEL: Record<string, string> = { sent: 'Delivered to SMTP', simulated: 'Simulated — not delivered', queued: 'Queued', failed: 'Failed' };

export function Outbox() {
  const fmt = useFmt();
  const { touch } = useApp();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => setPage(1), [status]);
  const state = useLive<any>(`/admin/notifications${qs({ status, page })}`);
  const preview = useLive<any>(open ? `/admin/notifications/${open}` : null);
  const act = useAction();
  return (
    <>
      <PageHead title={tr("Email outbox")} sub={tr("Every email the system has tried to send, with its real delivery state.")} />
      <Async state={state}>{(d) => (
        <>
          {!d.configured && <div style={{ marginBottom: 16 }}><Notice icon="mail">{tr("Email is running in")}{' '}<b>{tr("simulated")}</b> {tr("mode: messages are stored here so you can read them, but nothing reaches customers until SMTP is configured (see Settings → Email).")}</Notice></div>}
          <div className="toolbar">
            <div className="seg">{[['', tr("All")], ['queued', tr("Queued")], ['sent', tr("Sent")], ['simulated', tr("Simulated")], ['failed', tr("Failed")]].map(([k, l]) => {
              const n = k ? d.counts.find((c: any) => c.status === k)?.n ?? 0 : null;
              return <button key={k} aria-pressed={status === k} onClick={() => setStatus(k)}>{l}{n != null ? ` · ${n}` : ''}</button>;
            })}</div>
          </div>
          <div className="card">
            {d.notifications.length ? (
              <>
                <div className="table-wrap"><table className="table">
                  <thead><tr><th>{tr("Created")}</th><th>{tr("To")}</th><th>{tr("Subject")}</th><th>{tr("State")}</th><th /></tr></thead>
                  <tbody>{d.notifications.map((n: any) => (
                    <tr key={n.id} className="click" onClick={() => setOpen(n.id)}>
                      <td className="num nowrap">{fmt.dateTime(n.created_at)}</td><td>{n.to_email}</td>
                      <td>{n.subject}<span className="sub">{n.type.replace(/_/g, ' ')}{n.reference ? ` · ${n.reference}` : ''}</span></td>
                      <td><span className={`badge ${MAIL_TONE[n.status]}`}>{tr(MAIL_LABEL[n.status])}</span>{n.last_error && <span className="sub neg">{n.last_error}{n.status === 'queued' ? ` · ${tr("retry")} ${fmt.time(n.next_attempt_at)} (${tr("attempt")} ${n.attempts + 1})` : ''}</span>}</td>
                      <td className="r">{n.status === 'failed' && <button className="btn btn-ghost btn-sm" disabled={act.busy} onClick={(e) => { e.stopPropagation(); void act.run(async () => { await api(`/admin/notifications/${n.id}/retry`, { body: {} }); touch(); }, tr("Queued for another attempt.")); }}>{tr("Retry")}</button>}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
                <Pagination page={page} pageSize={d.page_size} total={d.total} onPage={setPage} />
              </>
            ) : <Empty icon="mail" title={tr("No emails here.")}>{tr("Confirmations, reminders and staff invitations appear in this list as they are created.")}</Empty>}
          </div>
        </>
      )}</Async>
      {open && (
        <Modal wide title={tr("Email preview")} onClose={() => setOpen(null)}>
          <Async state={preview}>{(p) => (
            <div className="stack">
              <dl className="dl"><dt>{tr("To")}</dt><dd>{p.notification.to_email}</dd><dt>{tr("Subject")}</dt><dd>{p.notification.subject}</dd><dt>{tr("State")}</dt><dd><span className={`badge ${MAIL_TONE[p.notification.status]}`}>{tr(MAIL_LABEL[p.notification.status])}</span></dd></dl>
              <iframe className="mail-frame" title={tr("Email content")} sandbox="" srcDoc={p.notification.html} />
            </div>
          )}</Async>
        </Modal>
      )}
    </>
  );
}

// ---------- Reviews ----------

export function Reviews() {
  const fmt = useFmt();
  const { touch } = useApp();
  const { reload } = useShop();
  const state = useLive<{ reviews: any[] }>('/admin/reviews');
  const act = useAction();
  return (
    <>
      <PageHead title={tr("Reviews")} sub={tr("Feedback left by customers after a completed visit. Only the ones you publish appear on the website.")} />
      <div className="card">
        <Async state={state}>{(d) => d.reviews.length ? (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{tr("Date")}</th><th>{tr("Customer")}</th><th>{tr("Rating")}</th><th>{tr("Comment")}</th><th className="r">{tr("On website")}</th></tr></thead>
            <tbody>{d.reviews.map((r) => (
              <tr key={r.id}>
                <td className="num nowrap">{fmt.date(r.created_at, 'medium')}</td><td><b>{r.customer_name}</b><span className="sub">{tr("with")}{' '}{r.barber_name} · {r.reference}</span></td>
                <td style={{ color: 'var(--copper-deep)' }}><Stars value={r.rating} /></td><td style={{ maxWidth: 420 }}>{r.comment || <span className="muted">{tr("No comment")}</span>}</td>
                <td className="r"><label className="switch" style={{ padding: 0, border: 0, justifyContent: 'flex-end' }}><span className="sr-only">{tr("Publish")}</span><input type="checkbox" checked={!!r.is_published} disabled={act.busy}
                  onChange={(e) => act.run(async () => { await api(`/admin/reviews/${r.id}`, { method: 'PATCH', body: { is_published: e.target.checked } }); touch(); await reload(); })} /></label></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty icon="star" title={tr("No feedback yet.")}>{tr("After a completed visit, customers can rate it from their account or the link in their confirmation email.")}</Empty>}</Async>
      </div>
    </>
  );
}

// ---------- Activity log ----------

export function Activity() {
  const fmt = useFmt();
  const [page, setPage] = useState(1);
  const state = useLive<any>(`/admin/audit?page=${page}`);
  const describe = (details: string | null) => {
    if (!details) return '';
    try {
      const d = JSON.parse(details);
      return Object.entries(d).filter(([, v]) => v != null && typeof v !== 'object').slice(0, 5)
        .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${/minor$/i.test(k) && typeof v === 'number' ? fmt.money(v) : String(v)}`).join(' · ');
    } catch {
      return '';
    }
  };
  return (
    <>
      <PageHead title={tr("Activity log")} sub={tr("An append-only record of administrative and financial actions: who did what, and when.")} />
      <div className="card">
        <Async state={state}>{(d) => d.events.length ? (
          <>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>{tr("When")}</th><th>{tr("Who")}</th><th>{tr("Action")}</th><th>{tr("Details")}</th></tr></thead>
              <tbody>{d.events.map((e: any) => (
                <tr key={e.id}>
                  <td className="num nowrap">{fmt.dateTime(e.created_at)}</td><td>{e.actor_name ?? <span className="muted">{tr("Customer / system")}</span>}</td>
                  <td><span className="code">{e.action}</span></td><td className="muted" style={{ fontSize: 13 }}>{e.entity}{e.entity_id ? ` #${e.entity_id}` : ''}{describe(e.details) ? ` — ${describe(e.details)}` : ''}</td>
                </tr>
              ))}</tbody>
            </table></div>
            <Pagination page={page} pageSize={d.page_size} total={d.total} onPage={setPage} />
          </>
        ) : <Empty icon="history" title={tr("Nothing logged yet.")} />}</Async>
      </div>
    </>
  );
}

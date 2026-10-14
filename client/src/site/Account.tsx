import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { SlotPicker } from '../components/SlotPicker';
import { Async, Empty, Field, Modal, Notice, PayBadge, ReasonModal, StatusBadge, useAction } from '../components/ui';
import { api, useApi } from '../lib/api';
import { shortName, useAuth, useFmt, useShop, useToast } from '../lib/context';
import { useT } from '../lib/i18n';
import { METHOD_LABEL, type Method } from '../../../shared/constants';

type Endpoints = { cancel: (id: number, reason: string) => Promise<unknown>; reschedule: (id: number, start: number) => Promise<unknown>; review: (id: number, rating: number, comment: string) => Promise<unknown> };

/** One booking with the actions its owner is allowed to take. Used by the account page and the emailed manage link. */
function BookingCard({ a, ep, onChange }: { a: any; ep: Endpoints; onChange: () => void }) {
  const fmt = useFmt();
  const { t } = useT();
  const { shop } = useShop();
  const toast = useToast();
  const [modal, setModal] = useState<'cancel' | 'move' | 'review' | null>(null);
  const [start, setStart] = useState<number | null>(null);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const act = useAction();
  const s = shop.settings;
  const open = ['pending', 'confirmed'].includes(a.status);
  const serviceIds = a.items.map((i: any) => i.service_id).filter(Boolean) as number[];
  const rebook = serviceIds.filter((id) => shop.services.some((x) => x.id === id));

  return (
    <article className="appt-card">
      <div className="when"><small>{fmt.dow(a.starts_at)} · {fmt.month(a.starts_at)}</small><b>{fmt.dayNum(a.starts_at)}</b><i dir="ltr">{fmt.time(a.starts_at)}</i></div>
      <div>
        <div className="row fw" style={{ gap: 8, marginBottom: 6 }}><StatusBadge status={a.status} /><PayBadge status={a.payment_status} appointmentStatus={a.status} /><span className="muted num" style={{ fontSize: 12 }} dir="ltr">{a.reference}</span></div>
        <h3>{a.services}</h3>
        <p>{t('with {name}', { name: a.barber_name })} · {fmt.duration(a.duration_min)} · <span className="num" dir="ltr">{fmt.money(a.total_minor)}</span>{a.paid_minor > 0 && a.balance_minor > 0 ? ` (${t('{amount} still to pay', { amount: fmt.money(a.balance_minor) })})` : ''}</p>
        {a.status === 'cancelled' && a.cancel_reason && <p>{t('Cancelled:')} {a.cancel_reason}</p>}
        {a.review && <p>{t('Your rating:')} {'★'.repeat(a.review.rating)}{a.review.comment ? ` — “${a.review.comment}”` : ''}</p>}
        {open && !a.can_cancel && <p style={{ fontSize: 13 }}>{t('Online changes are closed for this appointment — call {phone}.', { phone: s.phone })}</p>}
      </div>
      <div className="acts">
        {a.can_reschedule && serviceIds.length > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setModal('move')}>{t('Reschedule')}</button>}
        {a.can_cancel && <button className="btn btn-danger btn-sm" onClick={() => setModal('cancel')}>{t('Cancel')}</button>}
        {a.can_review && <button className="btn btn-primary btn-sm" onClick={() => setModal('review')}>{t('Leave feedback')}</button>}
        {!open && rebook.length > 0 && <Link className="btn btn-ghost btn-sm" to={`/book?services=${rebook.join(',')}&barber=${a.barber_id}`}>{t('Book again')}</Link>}
      </div>

      {modal === 'cancel' && (
        <ReasonModal title={t('Cancel this appointment?')} danger confirm={t('Cancel appointment')} label="Reason" onClose={() => setModal(null)}
          text={`${a.services} — ${fmt.dateTime(a.starts_at)}. ${t('Your slot will be released for someone else.')}`}
          onSubmit={async (reason) => { await ep.cancel(a.id, reason); toast(t('Appointment cancelled.'), 'success'); onChange(); }} />
      )}
      {modal === 'move' && (
        <Modal wide title={t('Pick a new time')} onClose={() => setModal(null)} footer={<>
          <button className="btn btn-ghost" onClick={() => setModal(null)}>{t('Keep current time')}</button>
          <button className="btn btn-dark" disabled={!start || act.busy} onClick={() => act.run(async () => { await ep.reschedule(a.id, start!); setModal(null); onChange(); }, t('Appointment moved.'))}>{t('Confirm new time')}</button>
        </>}>
          <p className="muted" style={{ marginBottom: 14 }}>{t('Currently {when} with {name}.', { when: fmt.dateTime(a.starts_at), name: a.barber_name })}</p>
          {act.error && <div style={{ marginBottom: 12 }}><Notice tone="bad" icon="alert">{act.error}</Notice></div>}
          <SlotPicker serviceIds={serviceIds} barber={a.barber_id} value={start} onChange={setStart} />
        </Modal>
      )}
      {modal === 'review' && (
        <Modal title={t('How was your visit?')} onClose={() => setModal(null)} footer={<>
          <button className="btn btn-ghost" onClick={() => setModal(null)}>{t('Not now')}</button>
          <button className="btn btn-dark" disabled={act.busy} onClick={() => act.run(async () => { await ep.review(a.id, rating, comment); setModal(null); onChange(); }, t('Thank you for the feedback.'))}>{t('Send feedback')}</button>
        </>}>
          <div className="stack">
            <div className="rating-pick" role="radiogroup" aria-label={t('Rating')}>
              {[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} / 5`} className={n <= rating ? 'on' : ''} onClick={() => setRating(n)}><Icon name={n <= rating ? 'star-fill' : 'star'} size={30} /></button>)}
            </div>
            <Field label={t('Anything to add? (optional)')} error={act.error}><textarea className="textarea" maxLength={600} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
            <p className="field-hint">{t('The shop may publish your first name and comment on its website.')}</p>
          </div>
        </Modal>
      )}
    </article>
  );
}

export function Account() {
  const { user, ready, setUser, logout } = useAuth();
  const fmt = useFmt();
  const { t, rich } = useT();
  const nav = useNavigate();
  const [tab, setTab] = useState<'upcoming' | 'past' | 'payments' | 'profile'>('upcoming');
  const state = useApi<any>(user?.role === 'customer' ? '/me/appointments' : null);
  const payments = useApi<any>(user?.role === 'customer' && tab === 'payments' ? '/me/payments' : null);
  if (!ready) return null;
  if (!user) return <Navigate to="/login?next=/account" replace />;
  if (user.role !== 'customer') return <Navigate to="/app" replace />;

  const ep: Endpoints = {
    cancel: (id, reason) => api(`/me/appointments/${id}/cancel`, { body: { reason } }),
    reschedule: (id, start) => api(`/me/appointments/${id}/reschedule`, { body: { start } }),
    review: (id, rating, comment) => api(`/me/appointments/${id}/review`, { body: { rating, comment } }),
  };
  const kind: Record<string, string> = { payment: 'Payment', refund: 'Refund', adjustment: 'Correction' };

  return (
    <div className="page-top"><div className="wrap" style={{ maxWidth: 980 }}>
      <header className="page-hero" style={{ paddingBottom: 28 }}>
        <div className="row between fw">
          <div><p className="eyebrow">{t('My account')}</p><h1 className="display" style={{ fontSize: 'clamp(44px, 7vw, 88px)' }}>{rich('Hello, *{name}.*', { name: shortName(user.name) })}</h1></div>
          <div className="row"><Link to="/book" className="btn btn-primary">{t('Book a visit')}</Link><button className="btn btn-ghost" onClick={async () => { await logout(); nav('/'); }}>{t('Sign out')}</button></div>
        </div>
      </header>
      <Async state={state}>{(data) => (
        <>
          {data.stats && (
            <div className="kv">
              <div><b className="num">{data.stats.visits}</b><span>{t('Visits')}</span></div>
              <div><b className="num" dir="ltr">{fmt.money(data.stats.total_paid_minor)}</b><span>{t('Total paid')}</span></div>
              <div><b className="num" dir="ltr">{fmt.money(data.stats.outstanding_minor)}</b><span>{t('Balance due')}</span></div>
              <div><b>{data.stats.last_visit ? fmt.date(data.stats.last_visit, 'short') : '—'}</b><span>{t('Last visit')}</span></div>
            </div>
          )}
          <div className="acct-tabs" role="tablist">
            {([['upcoming', `${t('Upcoming')} (${data.upcoming.length})`], ['past', `${t('History')} (${data.past.length})`], ['payments', t('Payments')], ['profile', t('Profile')]] as const).map(([k, label]) =>
              <button key={k} role="tab" data-tab={k} aria-selected={tab === k} onClick={() => setTab(k)}>{label}</button>)}
          </div>
          {tab === 'upcoming' && (data.upcoming.length
            ? data.upcoming.map((a: any) => <BookingCard key={a.id} a={a} ep={ep} onChange={state.reload} />)
            : <Empty title={t('No upcoming appointments.')} action={<Link to="/book" className="btn btn-primary">{t('Book a visit')}</Link>}>{t('When you book, your appointment shows up here with options to reschedule or cancel.')}</Empty>)}
          {tab === 'past' && (data.past.length
            ? data.past.map((a: any) => <BookingCard key={a.id} a={a} ep={ep} onChange={state.reload} />)
            : <Empty icon="history" title={t('No history yet.')}>{t('Completed and cancelled appointments will be listed here.')}</Empty>)}
          {tab === 'payments' && <Async state={payments}>{(p) => p.payments.length ? (
            <div className="panel-ink" style={{ padding: 0 }}>
              <table className="hours" style={{ margin: 0 }}><tbody>
                {p.payments.map((x: any) => (
                  <tr key={x.public_id}>
                    <td style={{ paddingInline: 20 }}>{fmt.dateTime(x.created_at)}<div className="muted" style={{ fontSize: 12 }}>{t(kind[x.kind])} · {t(METHOD_LABEL[x.method as Method])} · <span dir="ltr">{x.reference}</span></div></td>
                    <td style={{ paddingInline: 20 }} dir="ltr">{fmt.money(x.amount_minor)}</td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          ) : <Empty icon="receipt" title={t('No payments recorded.')}>{t('Payments are taken at the shop and appear here once your barber records them.')}</Empty>}</Async>}
          {tab === 'profile' && <Profile onSaved={setUser} />}
        </>
      )}</Async>
      <div className="section" />
    </div></div>
  );
}

function Profile({ onSaved }: { onSaved: (u: any) => void }) {
  const { user } = useAuth();
  const { t } = useT();
  const [name, setName] = useState(user!.name);
  const [phone, setPhone] = useState(user!.phone ?? '');
  const [pw, setPw] = useState({ current: '', next: '' });
  const save = useAction();
  const change = useAction();
  return (
    <div className="form-grid cols-2" style={{ alignItems: 'start' }}>
      <form className="panel-ink stack" onSubmit={(e: FormEvent) => { e.preventDefault(); void save.run(async () => onSaved((await api('/auth/profile', { method: 'PATCH', body: { name, phone } })).user), t('Profile saved.')); }}>
        <strong>{t('Your details')}</strong>
        {save.error && <Notice tone="bad" icon="alert">{save.error}</Notice>}
        <Field label={t('Full name')}><input className="input" value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <Field label={t('Phone')}><input className="input" type="tel" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        <Field label={t('Email')} hint={t('Contact the shop to change your email.')}><input className="input" dir="ltr" value={user!.email} disabled /></Field>
        <button className="btn btn-primary" disabled={save.busy}>{t('Save changes')}</button>
      </form>
      <form className="panel-ink stack" onSubmit={(e: FormEvent) => { e.preventDefault(); void change.run(async () => { await api('/auth/password', { body: pw }); setPw({ current: '', next: '' }); }, t('Password changed.')); }}>
        <strong>{t('Password')}</strong>
        {change.error && <Notice tone="bad" icon="alert">{change.error}</Notice>}
        <Field label={t('Current password')}><input className="input" type="password" dir="ltr" autoComplete="current-password" required value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
        <Field label={t('New password')} hint={t('At least 8 characters.')}><input className="input" type="password" dir="ltr" autoComplete="new-password" minLength={8} required value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
        <button className="btn btn-ghost" disabled={change.busy}>{t('Change password')}</button>
      </form>
    </div>
  );
}

/** Guest view opened from the link in the confirmation email. */
export function Manage() {
  const { ref = '' } = useParams();
  const [params] = useSearchParams();
  const { t, rich } = useT();
  const token = params.get('token') ?? '';
  const state = useApi<any>(`/public/manage/${ref}?token=${encodeURIComponent(token)}`);
  const ep: Endpoints = {
    cancel: (_id, reason) => api(`/public/manage/${ref}/cancel`, { body: { token, reason } }),
    reschedule: (_id, start) => api(`/public/manage/${ref}/reschedule`, { body: { token, start } }),
    review: (_id, rating, comment) => api(`/public/manage/${ref}/review`, { body: { token, rating, comment } }),
  };
  return (
    <div className="page-top"><div className="wrap" style={{ maxWidth: 900 }}>
      <header className="page-hero" style={{ paddingBottom: 20 }}>
        <p className="eyebrow">{t('Booking')} <span dir="ltr">{ref.toUpperCase()}</span></p>
        <h1 className="display" style={{ fontSize: 'clamp(44px, 7vw, 88px)' }}>{rich('Your *appointment.*')}</h1>
      </header>
      {state.error ? (
        <Empty icon="alert" title={t('We could not find that booking.')} action={<Link to="/book" className="btn btn-primary">{t('Book a visit')}</Link>}>{t('The link may be incomplete or out of date. Open it again from your confirmation email, or sign in to see your bookings.')}</Empty>
      ) : <Async state={state}>{(d) => <BookingCard a={d.appointment} ep={ep} onChange={state.reload} />}</Async>}
      <p className="muted" style={{ marginTop: 26, fontSize: 14 }}>{t('Want all your bookings in one place?')} <Link className="link" to="/register">{t('Create an account')}</Link></p>
      <div className="section" />
    </div></div>
  );
}

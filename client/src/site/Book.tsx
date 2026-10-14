import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { SlotPicker } from '../components/SlotPicker';
import { Field, Img, Notice } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { shortName, useAuth, useFmt, useShop } from '../lib/context';
import { useT } from '../lib/i18n';

const STEPS = ['Services', 'Barber', 'Time', 'Details', 'Confirm'];
const STORE = 'cb_booking_draft';

interface Draft { serviceIds: number[]; barber: number | 'any' | null; start: number | null; name: string; email: string; phone: string; note: string; step: number; barberFromLink?: boolean }

/** Builds a downloadable calendar entry for the confirmed booking. */
function icsHref(a: any, shopName: string, address: string) {
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Club Barber//Booking//EN', 'BEGIN:VEVENT', `UID:${a.reference}@clubbarber`, `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(a.starts_at)}`, `DTEND:${stamp(a.ends_at)}`, `SUMMARY:${a.services} — ${shopName}`, `LOCATION:${address.replace(/,/g, '\\,')}`,
    `DESCRIPTION:${a.reference} · ${a.barber_name}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  return URL.createObjectURL(new Blob([body], { type: 'text/calendar' }));
}

export function Book() {
  const { shop } = useShop();
  const fmt = useFmt();
  const { t, rich, lang, err } = useT();
  const { user } = useAuth();
  const [params] = useSearchParams();
  const s = shop.settings;
  const customer = user?.role === 'customer' ? user : null;
  const top = useRef<HTMLDivElement>(null);

  const [d, setD] = useState<Draft>(() => {
    const base: Draft = { serviceIds: [], barber: null, start: null, name: '', email: '', phone: '', note: '', step: 0 };
    const ids = (v: string | null) => (v ?? '').split(',').map(Number).filter((n) => shop.services.some((x) => x.id === n));
    const linked = ids(params.get('service') ?? params.get('services'));
    const b = Number(params.get('barber'));
    if (linked.length || b) {
      const barber = shop.barbers.some((x) => x.id === b) ? b : null;
      // Arriving from "Book with …": the barber is already chosen, so that step is skipped.
      return { ...base, serviceIds: linked, barber, barberFromLink: barber !== null };
    }
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORE) || 'null') as Draft | null;
      if (saved) return { ...base, ...saved, serviceIds: saved.serviceIds.filter((n) => shop.services.some((x) => x.id === n)) };
    } catch { /* ignore */ }
    return base;
  });
  const set = (patch: Partial<Draft>) => setD((cur) => ({ ...cur, ...patch }));
  useEffect(() => {
    sessionStorage.setItem(STORE, JSON.stringify(d));
  }, [d]);
  useEffect(() => {
    if (customer) setD((cur) => ({ ...cur, name: customer.name, email: customer.email, phone: cur.phone || customer.phone || '' }));
  }, [customer]);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [code, setCode] = useState('');
  const [codeFor, setCodeFor] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ appointment: any; manageToken: string } | null>(null);

  const selected = d.serviceIds.map((id) => shop.services.find((x) => x.id === id)!).filter(Boolean);
  const total = selected.reduce((n, x) => n + x.price_minor, 0);
  const duration = selected.reduce((n, x) => n + x.duration_min, 0);
  const eligible = useMemo(() => shop.barbers.filter((b) => d.serviceIds.every((id) => b.service_ids.includes(id))), [shop.barbers, d.serviceIds]);
  const chosenBarber = typeof d.barber === 'number' ? shop.barbers.find((b) => b.id === d.barber) ?? null : null;
  const needsCode = !customer && s.email_verification;
  const skipBarber = !!d.barberFromLink && d.barber !== null;

  const go = (step: number) => {
    setError(null);
    set({ step });
    top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const back = () => go(d.step === 2 && skipBarber ? 0 : d.step - 1);

  const toggleService = (id: number) => {
    const next = d.serviceIds.includes(id) ? d.serviceIds.filter((x) => x !== id) : [...d.serviceIds, id];
    const still = typeof d.barber !== 'number' || next.every((sid) => chosenBarber?.service_ids.includes(sid));
    set({ serviceIds: next, start: null, barber: still ? d.barber : null });
  };

  const validateDetails = () => {
    const e: Record<string, string> = {};
    if (d.name.trim().length < 2) e.name = t('Please enter your name.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email.trim())) e.email = t('Enter a valid email address.');
    if (!/^\+?[0-9 ()\-.]{6,20}$/.test(d.phone.trim())) e.phone = t('Enter a phone number we can reach you on.');
    setErrors(e);
    return !Object.keys(e).length;
  };

  const sendCode = async () => {
    const email = d.email.trim().toLowerCase();
    try {
      const r = await api('/public/booking/request-code', { body: { email, lang } });
      setCodeFor(email);
      setDevCode(r.devCode ?? null);
      setCode('');
    } catch (e) {
      setError(err(e));
    }
  };
  // Entering the confirm step as a guest sends the email code once per address.
  useEffect(() => {
    if (d.step === 4 && needsCode && codeFor !== d.email.trim().toLowerCase()) void sendCode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.step]);

  const canNext = [d.serviceIds.length > 0, d.barber !== null, d.start !== null, true, !needsCode || code.trim().length >= 6][d.step];
  const next = () => {
    if (d.step === 3 && !validateDetails()) return;
    if (d.step === 0 && skipBarber) return go(2);
    if (d.step < 4) return go(d.step + 1);
    void confirm();
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api('/public/bookings', { body: { serviceIds: d.serviceIds, barber: d.barber, start: d.start, name: d.name.trim(), email: d.email.trim(), phone: d.phone.trim(), note: d.note.trim(), code: needsCode ? code.trim() : undefined, lang } });
      sessionStorage.removeItem(STORE);
      setDone(r);
      window.scrollTo({ top: 0 });
    } catch (e) {
      setError(err(e));
      if (e instanceof ApiError && e.code === 'SLOT_TAKEN') set({ start: null, step: 2 });
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    const a = done.appointment;
    return (
      <div className="page-top"><div className="wrap narrow confirmed">
        <div className="seal"><Icon name="check" size={34} /></div>
        <p className="eyebrow">{a.status === 'pending' ? t('Request received') : t('Booking confirmed')}</p>
        <h1 className="display">{a.status === 'pending' ? rich('We have your *request.*') : rich('See you *soon.*')}</h1>
        <p className="muted" style={{ maxWidth: '46ch', margin: '0 auto' }}>
          {a.status === 'pending' ? t('The shop confirms each booking by hand. You will get an email as soon as yours is approved.') : t('A confirmation is on its way to {email}.', { email: d.email.trim() })}
          {s.email_simulated && ` ${t('(Email is in demo mode on this installation, so nothing is actually delivered.)')}`}
        </p>
        <div className="ticket">
          <div className="ref"><span className="eyebrow">{t('Reference')}</span><b dir="ltr">{a.reference}</b></div>
          <dl>
            <dt>{t('Service')}</dt><dd>{a.services}</dd>
            <dt>{t('Barber')}</dt><dd>{a.barber_name}</dd>
            <dt>{t('When')}</dt><dd>{fmt.date(a.starts_at, 'long')}<br /><span className="num" dir="ltr">{fmt.time(a.starts_at)} – {fmt.time(a.ends_at)}</span> · {fmt.duration(a.duration_min)}</dd>
            <dt>{t('Where')}</dt><dd>{s.address}, {s.city}</dd>
            <dt>{t('Price')}</dt><dd><span className="num" dir="ltr">{fmt.money(a.total_minor)}</span> · {t('pay at the shop')}</dd>
          </dl>
          <div className="acts">
            <Link className="btn btn-primary btn-sm" to={customer ? '/account' : `/manage/${a.reference}?token=${done.manageToken}`}>{t('Manage booking')}</Link>
            <a className="btn btn-ghost btn-sm" href={icsHref(a, s.shop_name, `${s.address}, ${s.city}`)} download={`${a.reference}.ics`}><Icon name="calendar" size={14} />{t('Add to calendar')}</a>
          </div>
        </div>
        <p className="muted" style={{ marginTop: 22, fontSize: 13 }}>{t('Free cancellation up to {h} h before your appointment.', { h: s.cancel_min_hours })}</p>
      </div></div>
    );
  }

  const summary = (
    <>
      <h2>{t('Your booking')}</h2>
      <dl>
        <div><dt>{t('Services')}</dt>
          {selected.length ? selected.map((x) => <dd key={x.id} className="line"><span>{x.name}</span><span className="num" dir="ltr">{fmt.money(x.price_minor)}</span></dd>) : <dd className="placeholder">{t('Nothing selected yet')}</dd>}
        </div>
        <div><dt>{t('Barber')}</dt><dd className={d.barber === null ? 'placeholder' : ''}>{d.barber === 'any' ? t('First available barber') : chosenBarber?.name ?? t('Not chosen yet')}</dd></div>
        <div><dt>{t('When')}</dt><dd className={d.start ? 'num' : 'placeholder'}>{d.start ? <>{fmt.date(d.start, 'long')}<br /><span dir="ltr">{fmt.time(d.start)} – {fmt.time(d.start + duration * 60000)}</span></> : t('Not chosen yet')}</dd></div>
      </dl>
      <div className="total"><span className="muted">{duration ? fmt.duration(duration) : t('Total')}</span><b className="num" dir="ltr">{fmt.money(total)}</b></div>
    </>
  );

  const nextLabel = d.step === 4 ? (busy ? t('Booking…') : s.auto_confirm ? t('Confirm booking') : t('Request booking')) : t('Continue');

  return (
    <div className="page-top" ref={top}>
      <div className="wrap book">
        <div>
          <ol className="steps" aria-label={t('Booking progress')}>
            {STEPS.map((label, i) => {
              const done2 = i < d.step || (i === 1 && skipBarber && d.step !== 1);
              return (
                <li key={label} className={i === d.step ? 'now' : done2 ? 'done' : ''} aria-current={i === d.step ? 'step' : undefined}>
                  {done2 && i !== d.step ? <button type="button" onClick={() => go(i)}><i>{i + 1}</i><em>{t(label)}</em></button> : <span><i>{i + 1}</i><em>{t(label)}</em></span>}
                </li>
              );
            })}
          </ol>
          {error && <div style={{ marginBottom: 20 }}><Notice tone="bad" icon="alert">{error}</Notice></div>}

          {d.step === 0 && (
            <section>
              <h1 className="display">{rich('What are we *doing?*')}</h1>
              <p className="lede">{t('Pick one service or combine several — we reserve the time back to back.')}</p>
              {chosenBarber && (
                <p className="with-barber">
                  <Icon name="check" size={15} /> {t('Booking with {name}.', { name: chosenBarber.name })}{' '}
                  <button type="button" className="link" onClick={() => set({ barber: null, barberFromLink: false, start: null })}>{t('Choose a different barber')}</button>
                </p>
              )}
              <div className="pick">
                {shop.services.map((sv) => {
                  const blocked = chosenBarber && !chosenBarber.service_ids.includes(sv.id);
                  return (
                    <button type="button" key={sv.id} className="pick-row" aria-pressed={d.serviceIds.includes(sv.id)} disabled={!!blocked} onClick={() => toggleService(sv.id)}>
                      <span className="box"><Icon name="check" size={14} /></span>
                      <span><h3>{sv.name}</h3><p>{blocked ? t('Not offered by {name}', { name: shortName(chosenBarber!.name) }) : sv.description}</p></span>
                      <span className="price num"><span dir="ltr">{fmt.money(sv.price_minor)}</span><small>{fmt.duration(sv.duration_min)}</small></span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {d.step === 1 && (
            <section>
              <h1 className="display">{rich('Who is *cutting?*')}</h1>
              <p className="lede">{t('Only barbers who offer everything you picked are available.')}</p>
              <div className="who">
                {s.allow_any_barber && (
                  <button type="button" className="who-card" aria-pressed={d.barber === 'any'} disabled={!eligible.length} onClick={() => { set({ barber: 'any', start: null, barberFromLink: false }); go(2); }}>
                    <span className="tick"><Icon name="check" size={14} /></span>
                    <div className="any"><Icon name="scissors" size={44} /></div>
                    <div className="t"><h3>{t('First available')}</h3><p>{t('Most times to choose from')}</p></div>
                  </button>
                )}
                {shop.barbers.map((b) => {
                  const ok = eligible.includes(b);
                  return (
                    <button type="button" key={b.id} className="who-card" aria-pressed={d.barber === b.id} disabled={!ok} onClick={() => { set({ barber: b.id, start: null, barberFromLink: false }); go(2); }}>
                      <span className="tick"><Icon name="check" size={14} /></span>
                      <Img src={b.photo_url} alt="" label={b.name} />
                      <div className="t"><h3>{b.name}</h3><p>{ok ? b.specialty : t('Does not offer this selection')}</p></div>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {d.step === 2 && d.barber !== null && (
            <section>
              <h1 className="display">{rich('Pick a *time.*')}</h1>
              <p className="lede">{d.barber === 'any' ? t('Live availability for any barber') : t('Live availability for {name}', { name: chosenBarber?.name })} · {fmt.duration(duration)}. {t('Times are shown in shop time.')}</p>
              <SlotPicker serviceIds={d.serviceIds} barber={d.barber} value={d.start} onChange={(start) => set({ start })} />
            </section>
          )}

          {d.step === 3 && (
            <section>
              <h1 className="display">{rich('Your *details.*')}</h1>
              {customer ? (
                <p className="lede">{t('Booking as {name} ({email}).', { name: customer.name, email: customer.email })}</p>
              ) : (
                <p className="lede">{t('No account needed.')} <Link className="link" to="/login?next=/book">{t('Sign in')}</Link> {t('if you have one — your details will be filled in.')}</p>
              )}
              <div className="form-grid cols-2">
                {!customer && <Field label={t('Full name')} error={errors.name}><input className="input" autoComplete="name" value={d.name} onChange={(e) => set({ name: e.target.value })} /></Field>}
                <Field label={t('Phone')} error={errors.phone} hint={t('Only used if we need to reach you about this visit.')}><input className="input" type="tel" dir="ltr" autoComplete="tel" placeholder="+216 …" value={d.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
                {!customer && <Field label={t('Email')} error={errors.email} hint={needsCode ? t('We will send a 6-digit code to confirm it.') : t('Your confirmation is sent here.')} className="span-2"><input className="input" type="email" dir="ltr" autoComplete="email" value={d.email} onChange={(e) => set({ email: e.target.value })} /></Field>}
              </div>
              <div style={{ marginTop: 16 }}>
                <Field label={t('Anything your barber should know? (optional)')}><textarea className="textarea" maxLength={500} value={d.note} onChange={(e) => set({ note: e.target.value })} placeholder={t('e.g. keep the length on top, sensitive skin…')} /></Field>
              </div>
            </section>
          )}

          {d.step === 4 && (
            <section>
              <h1 className="display">{rich('Looks *right?*')}</h1>
              <p className="lede">{t('Check the details, then confirm. You pay at the shop after your service.')}</p>
              <div className="summary inline" style={{ display: 'block', position: 'static', marginBottom: 20 }}>
                {summary}
                <dl style={{ marginTop: 16 }}>
                  <div><dt>{t('Booked for')}</dt><dd>{d.name} · <span dir="ltr">{d.phone}</span><br /><span dir="ltr">{d.email}</span></dd></div>
                  {d.note && <div><dt>{t('Note')}</dt><dd>{d.note}</dd></div>}
                </dl>
              </div>
              {needsCode && (
                <div className="panel-ink stack">
                  <div>
                    <strong>{t('Confirm your email')}</strong>
                    <p className="muted" style={{ fontSize: 14 }}>{t('We sent a 6-digit code to {email}. Enter it to confirm the booking is yours.', { email: d.email.trim() })}</p>
                  </div>
                  {devCode && <Notice tone="info">{t('Demo mode: email is not configured on this installation, so the code is shown here —')} <strong className="num">{devCode}</strong></Notice>}
                  <Field label={t('6-digit code')}><input className="input code-input" dir="ltr" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Field>
                  <div><button type="button" className="link" onClick={() => void sendCode()}>{t('Send a new code')}</button></div>
                </div>
              )}
              <p className="muted" style={{ fontSize: 13, marginTop: 16 }}>
                {s.auto_confirm ? t('Your booking is confirmed instantly.') : t('The shop approves each request and will email you once it is confirmed.')} {t('Cancel free of charge up to {c} h before, reschedule up to {r} h before.', { c: s.cancel_min_hours, r: s.reschedule_min_hours })}
              </p>
            </section>
          )}

          <div className="book-actions">
            {d.step > 0 ? <button type="button" className="btn btn-ghost" onClick={back}><Icon name="left" size={14} className="flip" />{t('Back')}</button> : <span />}
            <button type="button" className="btn btn-primary btn-lg" disabled={!canNext || busy} onClick={next}>{nextLabel}{d.step < 4 && <Icon name="arrow" className="arrow" />}</button>
          </div>
        </div>

        <aside className="summary" aria-label={t('Your booking')}>{summary}</aside>
      </div>

      <div className="book-bar">
        {d.step > 0 && <button type="button" className="icon-btn flip" aria-label={t('Back')} onClick={back}><Icon name="left" /></button>}
        <div className="sum">
          <b className="num" dir="ltr">{fmt.money(total)}</b>
          <small>{selected.length ? `${selected.map((x) => x.name).join(' + ')} · ${fmt.duration(duration)}` : t('Choose a service to start')}</small>
        </div>
        <button type="button" className="btn btn-primary" disabled={!canNext || busy} onClick={next}>{nextLabel}</button>
      </div>
    </div>
  );
}

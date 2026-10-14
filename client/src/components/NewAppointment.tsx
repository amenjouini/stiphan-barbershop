import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../app/AppLayout';
import { api, useApi } from '../lib/api';
import { useFmt } from '../lib/context';
import { SOURCE_LABEL, SOURCES, type Source } from '../../../shared/constants';
import { fmtDuration, fmtMinutes, parseMinutes, zonedToUtc } from '../../../shared/time';
import { Icon } from './Icon';
import { SlotPicker } from './SlotPicker';
import { Field, Modal, MoneyInput, Notice, useAction } from './ui';
import { tr } from '../lib/i18n';

export interface NewPrefill { barberId?: number; date?: string; minutes?: number; customer?: { id: number; name: string; phone?: string | null } }

/** Staff time selection: free slots from the engine, or an exact custom time (walk-ins, odd minutes, after hours). */
export function TimeChooser({ serviceIds, barber, value, onChange, ignoreHours, setIgnoreHours, excludeId, initialDate, initialMinutes }: {
  serviceIds: number[]; barber: number | 'any'; value: number | null; onChange: (v: number | null) => void;
  ignoreHours: boolean; setIgnoreHours: (v: boolean) => void; excludeId?: number; initialDate?: string; initialMinutes?: number;
}) {
  const fmt = useFmt();
  const [mode, setMode] = useState<'slots' | 'custom'>(initialMinutes != null ? 'custom' : 'slots');
  const [date, setDate] = useState(initialDate ?? fmt.today());
  const [time, setTime] = useState(initialMinutes != null ? fmtMinutes(initialMinutes) : '');
  useEffect(() => {
    if (mode !== 'custom') return;
    const m = parseMinutes(time);
    onChange(date && m != null ? zonedToUtc(date, m, fmt.tz) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, date, time]);
  return (
    <div className="stack tight">
      <div className="row between fw">
        <span className="label">{tr("Date & time")}</span>
        <div className="seg">
          <button type="button" aria-pressed={mode === 'slots'} onClick={() => { setMode('slots'); setIgnoreHours(false); onChange(null); }}>{tr("Free slots")}</button>
          <button type="button" aria-pressed={mode === 'custom'} onClick={() => setMode('custom')}>{tr("Exact time")}</button>
        </div>
      </div>
      {mode === 'slots' ? (
        serviceIds.length ? <SlotPicker staff serviceIds={serviceIds} barber={barber} value={value} onChange={onChange} excludeId={excludeId} initialDate={initialDate} />
          : <p className="field-hint">{tr("Choose a service first to see free times.")}</p>
      ) : (
        <>
          <div className="form-grid cols-2">
            <Field label={tr("Date")}><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label={tr("Start time")}><input type="time" className="input" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
          </div>
          <label className="check"><input type="checkbox" checked={ignoreHours} onChange={(e) => setIgnoreHours(e.target.checked)} /><span>{tr("Allow outside working hours, breaks or days off")}<br /><span className="field-hint">{tr("Overlapping another appointment is never allowed.")}</span></span></label>
        </>
      )}
    </div>
  );
}

/** Manual booking for phone, walk-in, WhatsApp and in-person requests. Uses the same engine as the website. */
export function NewAppointment({ prefill, onClose }: { prefill: NewPrefill; onClose: () => void }) {
  const { team, isOwner, touch, openAppointment } = useApp();
  const fmt = useFmt();
  const act = useAction();
  const [customer, setCustomer] = useState<{ id: number; name: string; phone?: string | null } | null>(prefill.customer ?? null);
  const [q, setQ] = useState('');
  const [fresh, setFresh] = useState({ name: '', phone: '', email: '' });
  const [isNew, setIsNew] = useState(false);
  const [serviceIds, setServiceIds] = useState<number[]>([]);
  const [barber, setBarber] = useState<number>(prefill.barberId ?? team.my_barber_id ?? team.barbers.find((b) => b.is_active)?.id ?? 0);
  const [start, setStart] = useState<number | null>(null);
  const [ignoreHours, setIgnoreHours] = useState(false);
  const [source, setSource] = useState<Source>('phone');
  const [note, setNote] = useState('');
  const [customPrice, setCustomPrice] = useState(false);
  const [price, setPrice] = useState('');

  const search = useApi<{ customers: any[] }>(!customer && !isNew && q.trim().length >= 2 ? `/staff/customers/search?q=${encodeURIComponent(q.trim())}` : null);
  const barberObj = team.barbers.find((b) => b.id === barber);
  const selected = team.services.filter((s) => serviceIds.includes(s.id));
  const listed = selected.reduce((n, s) => n + s.price_minor, 0);
  const duration = selected.reduce((n, s) => n + s.duration_min, 0);
  const priceMinor = customPrice ? fmt.parse(price) : null;
  const activeBarbers = useMemo(() => team.barbers.filter((b) => b.is_active), [team.barbers]);

  const customerOk = customer || (isNew && fresh.name.trim().length >= 2);
  const ready = customerOk && serviceIds.length > 0 && barber && start && (!customPrice || priceMinor != null);

  const submit = () => act.run(async () => {
    const r = await api('/staff/appointments', { body: {
      customer: customer ? { id: customer.id } : { name: fresh.name.trim(), phone: fresh.phone.trim(), email: fresh.email.trim() },
      serviceIds, barber: isOwner ? barber : undefined, start, source, note: note.trim() || undefined,
      priceMinor: customPrice ? priceMinor : undefined, ignoreHours: ignoreHours || undefined,
    } });
    touch();
    onClose();
    openAppointment(r.appointment.id);
  }, tr("Appointment added to the calendar."));

  return (
    <Modal wide title={tr("New appointment")} onClose={onClose} footer={<>
      <span className="grow muted num" style={{ alignSelf: 'center', fontSize: 13 }}>{selected.length ? `${fmtDuration(duration)} · ${fmt.money(priceMinor ?? listed)}` : ''}{start ? ` · ${fmt.dateTime(start)}` : ''}</span>
      <button className="btn btn-ghost" onClick={onClose}>{tr("Discard")}</button>
      <button className="btn btn-dark" disabled={!ready || act.busy} onClick={submit}>{act.busy ? tr("Saving…") : tr("Add appointment")}</button>
    </>}>
      <div className="stack">
        {act.error && <Notice tone="bad" icon="alert">{act.error}</Notice>}

        <div className="stack tight">
          <span className="label">{tr("Customer")}</span>
          {customer ? (
            <div className="row between card" style={{ padding: '10px 14px' }}>
              <div><b>{customer.name}</b>{customer.phone && <span className="muted"> · {customer.phone}</span>}</div>
              <button className="link" onClick={() => setCustomer(null)}>{tr("Change")}</button>
            </div>
          ) : isNew ? (
            <>
              <div className="form-grid cols-3">
                <Field label={tr("Name")}><input className="input" autoFocus value={fresh.name} onChange={(e) => setFresh({ ...fresh, name: e.target.value })} /></Field>
                <Field label={tr("Phone")}><input className="input" type="tel" value={fresh.phone} onChange={(e) => setFresh({ ...fresh, phone: e.target.value })} /></Field>
                <Field label={tr("Email (optional)")}><input className="input" type="email" value={fresh.email} onChange={(e) => setFresh({ ...fresh, email: e.target.value })} /></Field>
              </div>
              <button className="link" style={{ justifySelf: 'start' }} onClick={() => setIsNew(false)}>{tr("Search existing customers instead")}</button>
            </>
          ) : (
            <>
              <div className="toolbar" style={{ margin: 0 }}>
                <div className="search" style={{ maxWidth: 'none' }}><Icon name="search" size={16} /><input className="input" autoFocus placeholder={tr("Search by name, phone or email")} value={q} onChange={(e) => setQ(e.target.value)} /></div>
                <button className="btn btn-ghost btn-sm" onClick={() => { setIsNew(true); setFresh({ ...fresh, name: /\d{4}/.test(q) ? '' : q, phone: /\d{4}/.test(q) ? q : '' }); }}><Icon name="plus" size={14} />{tr("New customer")}</button>
              </div>
              {search.data && (search.data.customers.length ? (
                <div className="suggest">
                  {search.data.customers.map((c) => <button key={c.id} onClick={() => setCustomer(c)}><span><b>{c.name}</b></span><span className="muted">{c.phone ?? c.email ?? ''}</span></button>)}
                </div>
              ) : <p className="field-hint">{tr("No customer matches")}{" “"}{q}{"”. "}{tr("Use “New customer”.")}</p>)}
            </>
          )}
        </div>

        <div className="form-grid cols-2">
          {isOwner ? (
            <Field label={tr("Barber")}>
              <select className="select" value={barber} onChange={(e) => { setBarber(Number(e.target.value)); setStart(null); setServiceIds([]); }}>
                {activeBarbers.map((b) => <option key={b.id} value={b.id}>{b.name}{b.id === team.my_barber_id ? (" (" + tr("me)")) : ''}</option>)}
              </select>
            </Field>
          ) : <Field label={tr("Barber")}><input className="input" value={barberObj?.name ?? ''} disabled /></Field>}
          <Field label={tr("How did this booking come in?")}>
            <select className="select" value={source} onChange={(e) => setSource(e.target.value as Source)}>
              {SOURCES.filter((s) => s !== 'website').map((s) => <option key={s} value={s}>{tr(SOURCE_LABEL[s])}</option>)}
            </select>
          </Field>
        </div>

        <div className="stack tight">
          <span className="label">{tr("Services")}</span>
          <div className="svc-pick">
            {team.services.map((s) => (
              <button type="button" key={s.id} aria-pressed={serviceIds.includes(s.id)} disabled={!barberObj?.service_ids.includes(s.id)}
                onClick={() => { setServiceIds(serviceIds.includes(s.id) ? serviceIds.filter((x) => x !== s.id) : [...serviceIds, s.id]); setStart(null); }}>
                <span>{s.name}</span><small className="num">{fmt.plain(s.price_minor)} · {s.duration_min}′</small>
              </button>
            ))}
          </div>
        </div>

        <TimeChooser serviceIds={serviceIds} barber={barber} value={start} onChange={setStart} ignoreHours={ignoreHours} setIgnoreHours={setIgnoreHours} initialDate={prefill.date} initialMinutes={prefill.minutes} />

        <div className="form-grid cols-2">
          <Field label={tr("Internal note (optional)")}><textarea className="textarea" style={{ minHeight: 64 }} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          {isOwner && (
            <div className="stack tight">
              <label className="check"><input type="checkbox" checked={customPrice} onChange={(e) => { setCustomPrice(e.target.checked); setPrice(fmt.plain(listed)); }} /><span>{tr("Agree a custom price")}<br /><span className="field-hint">{tr("List price:")}{' '}{fmt.money(listed)}</span></span></label>
              {customPrice && <MoneyInput value={price} onChange={setPrice} />}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

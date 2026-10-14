import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../app/AppLayout';
import { api, newKey, useApi } from '../lib/api';
import { useFmt } from '../lib/context';
import { METHOD_LABEL, METHODS, SOURCE_LABEL, TRANSITIONS, type Method, type Source, type Status } from '../../../shared/constants';
import { fmtDuration } from '../../../shared/time';
import { Icon } from './Icon';
import { TimeChooser } from './NewAppointment';
import { Async, Drawer, Field, Modal, MoneyInput, Notice, PayBadge, ReasonModal, StatusBadge, useAction } from './ui';
import { tr } from '../lib/i18n';

const FLOW: Status[] = ['confirmed', 'checked_in', 'in_progress', 'completed'];
const FLOW_LABEL = ['Booked', 'Checked in', 'In the chair', 'Completed'];

/** Payment / refund entry. A fresh idempotency key per opened form makes double clicks harmless. */
function MoneyForm({ kind, max, onSubmit, onCancel }: { kind: 'payment' | 'refund'; max: number; onSubmit: (b: any) => Promise<unknown>; onCancel: () => void }) {
  const fmt = useFmt();
  const act = useAction();
  const key = useRef(newKey());
  const [amount, setAmount] = useState(fmt.plain(max));
  const [method, setMethod] = useState<Method>('cash');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const minor = fmt.parse(amount);
  const invalid = minor == null || minor <= 0 ? tr("Enter an amount.") : minor > max ? `${tr("The most you can")} ${kind === 'payment' ? 'take' : 'refund'} ${tr("here is")} ${fmt.money(max)}.` : null;
  return (
    <div className="card" style={{ padding: 16, background: '#fff' }}>
      <div className="stack">
        <strong>{kind === 'payment' ? tr("Record a payment") : tr("Record a refund")}</strong>
        {act.error && <Notice tone="bad" icon="alert">{act.error}</Notice>}
        <Field label={tr("Amount")} error={amount && invalid && minor != null ? invalid : null} hint={kind === 'payment' ? `${tr("Balance due")} ${fmt.money(max)} — ${tr("enter less for a part payment.")}` : `${tr("Collected so far")} ${fmt.money(max)}.`}>
          <MoneyInput value={amount} onChange={setAmount} autoFocus />
        </Field>
        <div className="stack tight">
          <span className="label">{tr("Method")}</span>
          <div className="seg">{METHODS.map((m) => <button type="button" key={m} aria-pressed={method === m} onClick={() => setMethod(m)}>{tr(METHOD_LABEL[m])}</button>)}</div>
        </div>
        <div className="form-grid cols-2">
          <Field label={tr("Reference (optional)")}><input className="input" value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} placeholder={tr("Receipt / transfer no.")} /></Field>
          <Field label={kind === 'refund' ? tr("Reason") : tr("Note (optional)")}><input className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>{tr("Close")}</button>
          <button className="btn btn-dark btn-sm" disabled={!!invalid || act.busy || (kind === 'refund' && note.trim().length < 3)}
            onClick={() => act.run(() => onSubmit({ amountMinor: minor, method, reference: reference.trim() || undefined, note: note.trim() || undefined, idempotencyKey: key.current }), kind === 'payment' ? tr("Payment recorded.") : tr("Refund recorded."))}>
            {kind === 'payment' ? `${tr("Record")} ${minor && !invalid ? fmt.money(minor) : 'payment'}` : tr("Record refund")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AppointmentDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const { isOwner, touch, team, stamp } = useApp();
  const fmt = useFmt();
  const state = useApi<any>(`/staff/appointments/${id}`);
  const act = useAction();
  const [panel, setPanel] = useState<'pay' | 'refund' | null>(null);
  const [modal, setModal] = useState<'cancel' | 'move' | 'price' | { void: any } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [start, setStart] = useState<number | null>(null);
  const [moveBarber, setMoveBarber] = useState<number | null>(null);
  const [ignoreHours, setIgnoreHours] = useState(false);
  const [price, setPrice] = useState('');
  useEffect(() => {
    if (stamp) void state.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);

  const done = async (fn: () => Promise<unknown>, msg?: string) => {
    const r = await act.run(fn, msg);
    if (r !== undefined) touch();
    return r;
  };
  const setStatus = (status: Status, reason?: string) => done(() => api(`/staff/appointments/${id}/status`, { body: { status, reason } }), undefined);

  return (
    <Drawer title={tr("Appointment")} onClose={onClose} head={state.data ? (
      <div>
        <div className="row fw" style={{ gap: 8, marginBottom: 6 }}>
          <StatusBadge status={state.data.appointment.status} />
          <PayBadge status={state.data.appointment.payment_status} appointmentStatus={state.data.appointment.status} />
          <span className="badge plain">{tr(SOURCE_LABEL[state.data.appointment.source as Source])}</span>
        </div>
        <h2 className="h2">{state.data.appointment.customer_name}</h2>
        <span className="muted num" style={{ fontSize: 13 }}>{state.data.appointment.reference}</span>
      </div>
    ) : undefined}>
      <Async state={state}>{({ appointment: a, customer: c, permissions: p }) => {
        const next = TRANSITIONS[a.status as Status];
        const open = next.length > 0;
        const flowIndex = FLOW.indexOf(a.status);
        const canNoShow = next.includes('no_show') && Date.now() >= a.starts_at;
        const primary: [Status, string] | null = a.status === 'pending' ? ['confirmed', tr("Approve booking")] : a.status === 'confirmed' ? ['checked_in', tr("Check in")]
          : a.status === 'checked_in' ? ['in_progress', tr("Start service")] : a.status === 'in_progress' ? ['completed', tr("Mark completed")] : null;
        const serviceIds = a.items.map((i: any) => i.service_id).filter(Boolean) as number[];
        return (
          <>
            {act.error && <div style={{ marginBottom: 14 }}><Notice tone="bad" icon="alert">{act.error}</Notice></div>}

            <section className="sec">
              {flowIndex >= 0 && <div className="flow" aria-label={tr("Progress")}>{FLOW_LABEL.map((l, i) => <span key={l} className={i <= flowIndex ? 'on' : ''}>{tr(l)}</span>)}</div>}
              {open && (
                <div className="steps-row" style={{ marginTop: 14 }}>
                  {primary && <button className="btn btn-primary" disabled={act.busy} onClick={() => setStatus(primary[0])}>{primary[1]}</button>}
                  {a.status !== 'in_progress' && next.includes('completed') && <button className="btn btn-ghost" disabled={act.busy} onClick={() => setStatus('completed')}>{tr("Mark completed")}</button>}
                  {['pending', 'confirmed'].includes(a.status) && <button className="btn btn-ghost" onClick={() => { setStart(null); setMoveBarber(a.barber_id); setModal('move'); }}>{tr("Reschedule")}</button>}
                  {canNoShow && <button className="btn btn-ghost" disabled={act.busy} onClick={() => setStatus('no_show')}>{tr("No-show")}</button>}
                  {next.includes('cancelled') && <button className="btn btn-danger" onClick={() => setModal('cancel')}>{tr("Cancel")}</button>}
                </div>
              )}
              {a.status === 'completed' && <p className="muted" style={{ marginTop: 10, fontSize: 13.5 }}>{tr("Completed")}{' '}{fmt.dateTime(a.completed_at)}{a.completed_by_name ? ` ${tr("by")} ${a.completed_by_name}` : ''}. {a.balance_minor > 0 ? tr("The service is done but not fully paid.") : tr("Paid in full.")}</p>}
              {a.status === 'cancelled' && <p className="muted" style={{ marginTop: 10, fontSize: 13.5 }}>{tr("Cancelled")}{' '}{fmt.dateTime(a.cancelled_at)}{a.cancel_reason ? ` — ${a.cancel_reason}` : ''}.</p>}
              {a.status === 'no_show' && <p className="muted" style={{ marginTop: 10, fontSize: 13.5 }}>{tr("The customer did not show up. No revenue or compensation is recorded.")}</p>}
            </section>

            <section className="sec">
              <h3>{tr("Appointment")}</h3>
              <dl className="dl">
                <dt>{tr("When")}</dt><dd>{fmt.date(a.starts_at, 'long')}<br /><span className="num">{fmt.time(a.starts_at)} – {fmt.time(a.ends_at)}</span> · {fmtDuration(a.duration_min)}</dd>
                <dt>{tr("Barber")}</dt><dd>{a.barber_name}</dd>
                <dt>{tr("Services")}</dt><dd>{a.items.map((i: any) => <div key={i.id} className="row between"><span>{i.service_name}</span><span className="num muted">{fmt.money(i.price_minor)}</span></div>)}</dd>
                {a.customer_note && <><dt>{tr("Customer says")}</dt><dd>“{a.customer_note}”</dd></>}
                <dt>{tr("Booked")}</dt><dd>{fmt.dateTime(a.created_at)} · {tr(SOURCE_LABEL[a.source as Source])}</dd>
                {a.checked_in_at && <><dt>{tr("Checked in")}</dt><dd className="num">{fmt.dateTime(a.checked_in_at)}</dd></>}
                {a.started_at && <><dt>{tr("Started")}</dt><dd className="num">{fmt.dateTime(a.started_at)}</dd></>}
              </dl>
            </section>

            <section className="sec">
              <h3>{tr("Customer")}{isOwner && <Link className="link" to={`/app/customers/${a.customer_id}`} onClick={onClose}>{tr("Open profile")}</Link>}</h3>
              <dl className="dl">
                <dt>{tr("Phone")}</dt><dd>{a.customer_phone ? <a className="link" href={`tel:${a.customer_phone.replace(/\s/g, '')}`}>{a.customer_phone}</a> : <span className="muted">{tr("Not provided")}</span>}</dd>
                <dt>{tr("Email")}</dt><dd>{a.customer_email ?? <span className="muted">{tr("Not provided")}</span>}</dd>
                <dt>{tr("History")}</dt><dd>{c.visits} {tr("completed")}{' '}{c.visits === 1 ? 'visit' : 'visits'}{c.no_shows ? ` · ${c.no_shows} ${tr("no-show")}${c.no_shows > 1 ? 's' : ''}` : ''}{c.last_visit ? ` · ${tr("last")} ${fmt.date(c.last_visit, 'short')}` : ''}</dd>
                {isOwner && c.outstanding_minor > 0 && <><dt>{tr("Owes overall")}</dt><dd className="neg num">{fmt.money(c.outstanding_minor)}</dd></>}
                {isOwner && c.notes && <><dt>{tr("Notes")}</dt><dd>{c.notes}</dd></>}
              </dl>
            </section>

            <section className="sec">
              <h3>{tr("Payment")}{p.edit_price && open && <button className="link" onClick={() => { setPrice(fmt.plain(a.total_minor)); setModal('price'); }}>{tr("Change price")}</button>}</h3>
              <div className="money3">
                <div><span>{tr("Agreed price")}</span><b className="num">{fmt.money(a.total_minor)}</b></div>
                <div><span>{tr("Paid")}</span><b className="num">{fmt.money(a.paid_minor)}</b></div>
                <div className={a.payment_status === 'refund_due' ? 'due' : a.balance_minor > 0 && a.status === 'completed' ? 'due' : a.balance_minor <= 0 ? 'clear' : ''}>
                  <span>{a.payment_status === 'refund_due' ? tr("To refund") : tr("Balance")}</span><b className="num">{fmt.money(a.payment_status === 'refund_due' ? a.paid_minor : a.balance_minor)}</b>
                </div>
              </div>
              {a.payment_status === 'refund_due' && <div style={{ marginTop: 10 }}><Notice icon="alert">{tr("This appointment did not take place but money was collected. Record a refund")}{isOwner ? '' : (" (" + tr("owner only)"))}.</Notice></div>}

              {a.payments.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  {a.payments.map((x: any) => (
                    <div key={x.id} className={`ledger-row ${x.voided_by ? 'void' : ''}`}>
                      <div>
                        {x.kind === 'payment' ? tr("Payment") : x.kind === 'refund' ? tr("Refund") : tr("Correction")} · {tr(METHOD_LABEL[x.method as Method])}{x.reference ? ` · ${x.reference}` : ''}
                        <small>{fmt.dateTime(x.created_at)}{x.recorded_by_name ? ` · ${x.recorded_by_name}` : ''} · {x.public_id}{x.note ? ` — ${x.note}` : ''}</small>
                      </div>
                      <b className={`num ${x.amount_minor < 0 ? 'neg' : ''}`}>{fmt.money(x.amount_minor)}</b>
                      {p.void && x.kind !== 'adjustment' && !x.voided_by ? <button className="icon-btn" title={tr("Void this entry")} aria-label={tr("Void this entry")} onClick={() => setModal({ void: x })}><Icon name="undo" size={16} /></button> : <span style={{ width: 36 }} />}
                    </div>
                  ))}
                </div>
              )}

              {panel === 'pay' && <div style={{ marginTop: 12 }}><MoneyForm kind="payment" max={a.balance_minor} onCancel={() => setPanel(null)}
                onSubmit={async (b) => { await api(`/staff/appointments/${id}/payments`, { body: b }); setPanel(null); touch(); }} /></div>}
              {panel === 'refund' && <div style={{ marginTop: 12 }}><MoneyForm kind="refund" max={a.paid_minor} onCancel={() => setPanel(null)}
                onSubmit={async (b) => { await api(`/admin/appointments/${id}/refund`, { body: b }); setPanel(null); touch(); }} /></div>}
              {!panel && (
                <div className="steps-row" style={{ marginTop: 12 }}>
                  {p.record_payment && a.balance_minor > 0 && !['cancelled', 'no_show'].includes(a.status) && <button className="btn btn-dark btn-sm" onClick={() => setPanel('pay')}><Icon name="plus" size={14} />{tr("Record payment")}</button>}
                  {p.refund && a.paid_minor > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setPanel('refund')}>{tr("Refund")}</button>}
                  {!p.record_payment && a.balance_minor > 0 && <span className="muted" style={{ fontSize: 13 }}>{tr("Payments are recorded by the owner.")}</span>}
                </div>
              )}
            </section>

            <section className="sec">
              <h3>{tr("Internal note")}{' '}<span className="muted" style={{ letterSpacing: 0, textTransform: 'none', fontWeight: 500 }}>{tr("Staff only")}</span></h3>
              <textarea className="textarea" maxLength={2000} value={note ?? a.internal_note} onChange={(e) => setNote(e.target.value)} placeholder={tr("Preferences, what was agreed, anything the next barber should know…")} />
              {note !== null && note !== a.internal_note && (
                <div className="row" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setNote(null)}>{tr("Discard")}</button>
                  <button className="btn btn-dark btn-sm" disabled={act.busy} onClick={async () => { await done(() => api(`/staff/appointments/${id}`, { method: 'PATCH', body: { internal_note: note } }), tr("Note saved.")); setNote(null); }}>{tr("Save note")}</button>
                </div>
              )}
            </section>

            {modal === 'cancel' && <ReasonModal title={tr("Cancel this appointment?")} danger confirm={tr("Cancel appointment")} onClose={() => setModal(null)}
              text={`${a.customer_name} — ${a.services}, ${fmt.dateTime(a.starts_at)}.${a.customer_email ? (" " + tr("The customer will be emailed.")) : ''}`}
              onSubmit={async (reason) => { await api(`/staff/appointments/${id}/status`, { body: { status: 'cancelled', reason } }); touch(); }} />}
            {typeof modal === 'object' && modal && 'void' in modal && <ReasonModal title={tr("Void this entry?")} danger required confirm={tr("Void entry")} onClose={() => setModal(null)}
              text={<>{tr("This adds an opposite correction of")}{' '}<strong className="num">{fmt.money(-modal.void.amount_minor)}</strong> {tr("to the ledger. The original entry stays visible for the audit trail.")}</>}
              onSubmit={async (reason) => { await api(`/admin/payments/${modal.void.id}/void`, { body: { reason } }); touch(); }} />}
            {modal === 'price' && (
              <Modal title={tr("Change the agreed price")} onClose={() => setModal(null)} footer={<>
                <button className="btn btn-ghost" onClick={() => setModal(null)}>{tr("Keep price")}</button>
                <button className="btn btn-dark" disabled={fmt.parse(price) == null || act.busy} onClick={async () => { if (await done(() => api(`/staff/appointments/${id}`, { method: 'PATCH', body: { total_minor: fmt.parse(price) } }), tr("Price updated."))) setModal(null); }}>{tr("Save price")}</button>
              </>}>
                <div className="stack">
                  <p className="muted">{tr("Applies to this appointment only; the service catalogue is not changed. The change is written to the activity log.")}</p>
                  <Field label={tr("Agreed price")} error={act.error}><MoneyInput value={price} onChange={setPrice} autoFocus /></Field>
                </div>
              </Modal>
            )}
            {modal === 'move' && (
              <Modal wide title={tr("Reschedule")} onClose={() => setModal(null)} footer={<>
                <button className="btn btn-ghost" onClick={() => setModal(null)}>{tr("Keep current time")}</button>
                <button className="btn btn-dark" disabled={!start || act.busy} onClick={async () => {
                  if (await done(() => api(`/staff/appointments/${id}/reschedule`, { body: { start, barber: isOwner && moveBarber !== a.barber_id ? moveBarber : undefined, ignoreHours: ignoreHours || undefined } }), tr("Appointment moved."))) setModal(null);
                }}>{tr("Move appointment")}</button>
              </>}>
                <div className="stack">
                  <p className="muted">{tr("Currently")}{' '}{fmt.dateTime(a.starts_at)} {tr("with")}{' '}{a.barber_name}.{a.customer_email ? (" " + tr("The customer is emailed the new time.")) : ''}</p>
                  {act.error && <Notice tone="bad" icon="alert">{act.error}</Notice>}
                  {isOwner && (
                    <Field label={tr("Barber")}>
                      <select className="select" value={moveBarber ?? a.barber_id} onChange={(e) => { setMoveBarber(Number(e.target.value)); setStart(null); }}>
                        {team.barbers.filter((b) => b.is_active && serviceIds.every((sid) => b.service_ids.includes(sid))).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                    </Field>
                  )}
                  <TimeChooser serviceIds={serviceIds} barber={moveBarber ?? a.barber_id} value={start} onChange={setStart} ignoreHours={ignoreHours} setIgnoreHours={setIgnoreHours} excludeId={a.id} initialDate={fmt.dayOf(a.starts_at) >= fmt.today() ? fmt.dayOf(a.starts_at) : undefined} />
                </div>
              </Modal>
            )}
          </>
        );
      }}</Async>
    </Drawer>
  );
}

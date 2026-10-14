import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Calendar } from '../components/Calendar';
import { CHART, ColumnChart, HBars } from '../components/charts';
import { Icon } from '../components/Icon';
import { Async, Empty, Field, Modal, Notice, Pagination, PayBadge, StatusBadge, useAction } from '../components/ui';
import { api, qs } from '../lib/api';
import { useFmt } from '../lib/context';
import { METHOD_LABEL, SOURCE_LABEL, STATUS_LABEL, STATUSES, type Method, type Source } from '../../../shared/constants';
import { useApp, useLive } from './AppLayout';
import { PageHead, RangePicker, rangeQuery, TimeOffCard, useRange } from './shared';
import { tr } from '../lib/i18n';

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function Overview() {
  const fmt = useFmt();
  const ctl = useRange('month');
  const { openAppointment, newAppointment } = useApp();
  const state = useLive<any>(`/admin/overview?${rangeQuery(ctl.range)}`);
  const day = (d: string) => `${Number(d.slice(8))}/${Number(d.slice(5, 7))}`;
  return (
    <>
      <PageHead title={tr("Overview")} sub={`${tr("The shop at a glance")} — ${fmt.date(fmt.today(), 'long')}.`}>
        <button className="btn btn-primary" onClick={() => newAppointment()}><Icon name="plus" size={15} />{tr("New appointment")}</button>
      </PageHead>
      <Async state={state}>{({ today: t, report: r, recent, upcoming, email }) => {
        const m = r.money;
        return (
          <>
            {t.pending_approval > 0 && <div style={{ marginBottom: 16 }}><Notice icon="alert">{t.pending_approval} {tr("booking")}{t.pending_approval > 1 ? 's are' : ' is'} {tr("waiting for your approval.")}{' '}<Link className="link" to="/app/appointments?status=pending">{tr("Review now")}</Link></Notice></div>}
            {email.failed > 0 && <div style={{ marginBottom: 16 }}><Notice tone="bad" icon="mail">{email.failed} {tr("email")}{email.failed > 1 ? 's' : ''} {tr("could not be delivered.")}{' '}<Link className="link" to="/app/outbox">{tr("Open the outbox")}</Link></Notice></div>}

            <div className="stats">
              <div className="stat accent"><div className="k">{tr("Today's appointments")}</div><div className="v num">{t.appointments}</div><div className="s">{t.completed} {tr("completed")}{" · "}{t.in_chair} {tr("in the shop")}</div></div>
              <div className="stat"><div className="k">{tr("Collected today")}</div><div className="v num">{fmt.money(t.collected_minor)}</div><div className="s">{tr("Payments minus refunds, all methods")}</div></div>
              <div className="stat"><div className="k">{tr("Upcoming")}</div><div className="v num">{upcoming}</div><div className="s">{tr("Confirmed or pending, from now on")}</div></div>
              <div className="stat"><div className="k">{tr("Today's losses")}</div><div className="v num">{t.cancelled + t.no_shows}</div><div className="s">{t.cancelled} {tr("cancelled")}{" · "}{t.no_shows} {tr("no-show")}{t.no_shows === 1 ? '' : 's'}</div></div>
            </div>

            <div className="toolbar" style={{ marginTop: 28 }}>
              <h2 className="h2">{tr("Selected period")}</h2><span className="spacer" /><RangePicker ctl={ctl} />
            </div>
            <div className="stats">
              <div className="stat"><div className="k">{tr("Service revenue")}</div><div className="v num">{fmt.money(m.service_revenue_minor)}</div><div className="s">{r.appointments.completed_services} {tr("services performed")}</div></div>
              <div className="stat"><div className="k">{tr("Collected")}</div><div className="v num">{fmt.money(m.net_collected_minor)}</div><div className="s">{tr("Cash")}{' '}{fmt.money(m.cash_collected_minor)} {"· "}{tr("other")}{' '}{fmt.money(m.non_cash_collected_minor)}</div></div>
              <div className="stat"><div className="k">{tr("Outstanding")}</div><div className={`v num ${m.outstanding_total_minor > 0 ? 'bad' : ''}`}>{fmt.money(m.outstanding_total_minor)}</div><div className="s">{tr("All completed services not yet paid")}</div></div>
              <div className="stat"><div className="k">{tr("Owed to barbers")}</div><div className="v num">{fmt.money(m.compensation_owed_minor)}</div><div className="s">{tr("Paid out in period:")}{' '}{fmt.money(m.payouts_paid_minor)}</div></div>
            </div>

            <div className="grid c21">
              <div className="card">
                <div className="card-head"><h2>{tr("Revenue and collections per day")}</h2><Link className="link" to="/app/reports">{tr("Full report")}</Link></div>
                <div className="card-body">
                  <ColumnChart data={r.daily.map((d: any) => ({ label: day(d.date), title: fmt.date(d.date, 'medium'), revenue: d.revenue_minor, collected: d.collected_minor }))}
                    series={[{ key: 'revenue', label: tr("Service revenue"), color: CHART.revenue }, { key: 'collected', label: tr("Collected"), color: CHART.collected }]}
                    format={fmt.money} tickFormat={(v) => fmt.plain(v).replace(/\.0+$/, '')} />
                </div>
              </div>
              <div className="card">
                <div className="card-head"><h2>{tr("Most booked services")}</h2></div>
                <div className="card-body"><HBars rows={r.bookedServices.slice(0, 6).map((s: any) => ({ label: s.name, value: s.count, display: `${s.count}×` }))} /></div>
              </div>
            </div>

            <div className="grid c21" style={{ marginTop: 16 }}>
              <div className="card">
                <div className="card-head"><h2>{tr("Appointments per day")}</h2><span className="muted" style={{ fontSize: 13 }}>{r.appointments.total} {tr("in period")}{" · "}{r.appointments.cancellation_rate}{"% "}{tr("cancelled")}{" · "}{r.appointments.no_show_rate}{"% "}{tr("no-show")}</span></div>
                <div className="card-body">
                  <ColumnChart height={170} data={r.daily.map((d: any) => ({ label: day(d.date), title: fmt.date(d.date, 'medium'), n: d.appointments }))} series={[{ key: 'n', label: tr("Appointments"), color: 'var(--ink)' }]} format={(v) => String(Math.round(v))} tickFormat={(v) => (Number.isInteger(v) ? String(v) : '')} />
                </div>
              </div>
              <div className="card">
                <div className="card-head"><h2>{tr("Barber performance")}</h2></div>
                <div className="card-body">
                  <HBars tone="b" rows={r.byBarber.filter((b: any) => b.appointments || b.revenue_minor).map((b: any) => ({ label: b.name, value: b.revenue_minor, display: `${b.completed} ${tr("done")} · ${fmt.money(b.revenue_minor)}` }))} />
                </div>
              </div>
            </div>

            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-head"><h2>{tr("Recent bookings")}</h2><Link className="link" to="/app/appointments">{tr("All appointments")}</Link></div>
              {recent.length ? <div className="table-wrap"><table className="table">
                <thead><tr><th>{tr("Booked")}</th><th>{tr("Customer")}</th><th>{tr("Service")}</th><th className="hide-sm">{tr("Barber")}</th><th>{tr("When")}</th><th className="hide-sm">{tr("Source")}</th><th>{tr("Status")}</th></tr></thead>
                <tbody>{recent.map((a: any) => (
                  <tr key={a.id} className="click" onClick={() => openAppointment(a.id)}>
                    <td className="num nowrap muted">{fmt.dateTime(a.created_at).replace(/^\w+,? /, '')}</td>
                    <td><b>{a.customer_name}</b></td><td>{a.services}</td><td className="hide-sm">{a.barber_name}</td>
                    <td className="num nowrap">{fmt.dateTime(a.starts_at)}</td><td className="hide-sm">{tr(SOURCE_LABEL[a.source as Source])}</td><td><StatusBadge status={a.status} /></td>
                  </tr>
                ))}</tbody>
              </table></div> : <Empty title={tr("No bookings yet.")}>{tr("New bookings will show up here as they arrive.")}</Empty>}
            </div>
          </>
        );
      }}</Async>
    </>
  );
}

export function ShopCalendar() {
  const { newAppointment } = useApp();
  return (
    <>
      <PageHead title={tr("Shop calendar")} sub={tr("Every chair in one place: online bookings and the ones added by staff. Click an empty time to book it.")}>
        <button className="btn btn-primary" onClick={() => newAppointment()}><Icon name="plus" size={15} />{tr("New appointment")}</button>
      </PageHead>
      <Calendar scope="shop" />
      <div style={{ marginTop: 24 }}><TimeOffCard allowShopWide /></div>
    </>
  );
}

export function Appointments() {
  const fmt = useFmt();
  const { team, openAppointment, newAppointment } = useApp();
  const initial = new URLSearchParams(location.search);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState(initial.get('status') ?? '');
  const [barber, setBarber] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  useEffect(() => setPage(1), [dq, status, barber, from, to]);
  const state = useLive<{ appointments: any[]; total: number }>(`/staff/appointments${qs({ q: dq, status, barber, from, to: to || from, page, pageSize: 25, order: from ? 'asc' : 'desc' })}`);
  return (
    <>
      <PageHead title={tr("Appointments")} sub={tr("Search every booking by customer, phone, email or reference.")}>
        <button className="btn btn-primary" onClick={() => newAppointment()}><Icon name="plus" size={15} />{tr("New appointment")}</button>
      </PageHead>
      <div className="toolbar">
        <div className="search"><Icon name="search" size={16} /><input className="input" placeholder={tr("Name, phone, email or CB-reference")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={tr("Search appointments")} /></div>
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={tr("Status")}><option value="">{tr("Any status")}</option>{STATUSES.map((s) => <option key={s} value={s}>{tr(STATUS_LABEL[s])}</option>)}</select>
        <select className="select" value={barber} onChange={(e) => setBarber(e.target.value)} aria-label={tr("Barber")}><option value="">{tr("All barbers")}</option>{team.barbers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
        <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={tr("From date")} />
        <input type="date" className="input" value={to} min={from} disabled={!from} onChange={(e) => setTo(e.target.value)} aria-label={tr("To date")} />
        {(q || status || barber || from) && <button className="link" onClick={() => { setQ(''); setStatus(''); setBarber(''); setFrom(''); setTo(''); }}>{tr("Clear")}</button>}
      </div>
      <div className="card">
        <Async state={state}>{(d) => d.appointments.length ? (
          <>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>{tr("When")}</th><th>{tr("Customer")}</th><th>{tr("Service")}</th><th className="hide-sm">{tr("Barber")}</th><th className="hide-sm">{tr("Source")}</th><th>{tr("Status")}</th><th className="r">{tr("Price")}</th><th>{tr("Payment")}</th></tr></thead>
              <tbody>{d.appointments.map((a) => (
                <tr key={a.id} className="click" onClick={() => openAppointment(a.id)}>
                  <td className="num nowrap"><b>{fmt.date(a.starts_at, 'medium')}</b><span className="sub">{fmt.time(a.starts_at)} – {fmt.time(a.ends_at)}</span></td>
                  <td><b>{a.customer_name}</b><span className="sub">{a.customer_phone ?? a.customer_email ?? a.reference}</span></td>
                  <td>{a.services}</td><td className="hide-sm">{a.barber_name}</td><td className="hide-sm">{tr(SOURCE_LABEL[a.source as Source])}</td>
                  <td><StatusBadge status={a.status} /></td><td className="r num">{fmt.money(a.total_minor)}</td>
                  <td><PayBadge status={a.payment_status} appointmentStatus={a.status} /></td>
                </tr>
              ))}</tbody>
            </table></div>
            <Pagination page={page} pageSize={25} total={d.total} onPage={setPage} />
          </>
        ) : <Empty icon="search" title={tr("No appointments match.")}>{tr("Try a different search or clear the filters.")}</Empty>}</Async>
      </div>
    </>
  );
}

export function Customers() {
  const fmt = useFmt();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('name');
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const dq = useDebounced(q);
  useEffect(() => setPage(1), [dq, filter, sort]);
  const state = useLive<any>(`/admin/customers${qs({ q: dq, filter, sort, page })}`);
  return (
    <>
      <PageHead title={tr("Customers")} sub={tr("Totals are calculated from recorded payments and refunds, not from booked prices.")}>
        <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" size={15} />{tr("Add customer")}</button>
      </PageHead>
      <div className="toolbar">
        <div className="search"><Icon name="search" size={16} /><input className="input" placeholder={tr("Name, phone or email")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={tr("Search customers")} /></div>
        <div className="seg">{[['all', tr("All")], ['owing', tr("Owing")], ['upcoming', tr("Has booking")], ['new', tr("No visit yet")]].map(([k, l]) => <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}</div>
        <span className="spacer" />
        <select className="select" value={sort} onChange={(e) => setSort(e.target.value)} aria-label={tr("Sort")}><option value="name">{tr("Sort: name")}</option><option value="recent">{tr("Sort: last visit")}</option><option value="visits">{tr("Sort: most visits")}</option><option value="paid">{tr("Sort: total paid")}</option><option value="owing">{tr("Sort: balance due")}</option></select>
      </div>
      <div className="card">
        <Async state={state}>{(d) => d.customers.length ? (
          <>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>{tr("Customer")}</th><th className="r">{tr("Visits")}</th><th className="hide-sm">{tr("Last visit")}</th><th className="hide-sm">{tr("Next appointment")}</th><th className="r">{tr("Total paid")}</th><th className="r">{tr("Balance due")}</th></tr></thead>
              <tbody>{d.customers.map((c: any) => (
                <tr key={c.id} className="click" onClick={() => nav(`/app/customers/${c.id}`)}>
                  <td><b>{c.name}</b>{c.has_account ? <span className="badge plain" style={{ marginLeft: 8 }}>{tr("Account")}</span> : null}<span className="sub">{[c.phone, c.email].filter(Boolean).join(' · ') || tr("No contact details")}</span></td>
                  <td className="r num">{c.visits}</td>
                  <td className="hide-sm num">{c.last_visit ? fmt.date(c.last_visit, 'medium') : '—'}</td>
                  <td className="hide-sm num">{c.next_appointment ? fmt.dateTime(c.next_appointment) : '—'}</td>
                  <td className="r num">{fmt.money(c.total_paid_minor)}</td>
                  <td className={`r num ${c.outstanding_minor > 0 ? 'neg' : ''}`}>{c.outstanding_minor > 0 ? <b>{fmt.money(c.outstanding_minor)}</b> : '—'}</td>
                </tr>
              ))}</tbody>
            </table></div>
            <Pagination page={page} pageSize={d.page_size} total={d.total} onPage={setPage} />
          </>
        ) : <Empty icon="users" title={tr("No customers found.")}>{tr("Customers are created automatically when they book, or add one by hand.")}</Empty>}</Async>
      </div>
      {adding && <CustomerForm onClose={() => setAdding(false)} onSaved={(id) => nav(`/app/customers/${id}`)} />}
    </>
  );
}

function CustomerForm({ customer, onClose, onSaved }: { customer?: any; onClose: () => void; onSaved: (id: number) => void }) {
  const act = useAction();
  const { touch } = useApp();
  const [f, setF] = useState({ name: customer?.name ?? '', phone: customer?.phone ?? '', email: customer?.email ?? '', notes: customer?.notes ?? '' });
  const save = () => act.run(async () => {
    const r = customer ? await api(`/admin/customers/${customer.id}`, { method: 'PATCH', body: f }) : await api('/admin/customers', { body: f });
    touch();
    onClose();
    onSaved(customer?.id ?? r.id);
  }, tr("Customer saved."));
  return (
    <Modal title={customer ? tr("Edit customer") : tr("Add customer")} onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>{tr("Discard")}</button><button className="btn btn-dark" disabled={act.busy || f.name.trim().length < 2} onClick={save}>{tr("Save")}</button></>}>
      <div className="stack">
        {act.error && <Notice tone="bad" icon="alert">{act.error}</Notice>}
        <Field label={tr("Name")}><input className="input" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <div className="form-grid cols-2">
          <Field label={tr("Phone")}><input className="input" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label={tr("Email")} hint={customer?.has_account ? tr("Managed by the customer in their account.") : undefined}><input className="input" type="email" value={f.email} disabled={!!customer?.has_account} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        </div>
        <Field label={tr("Internal notes")} hint={tr("Visible to the owner only. Never shown to the customer.")}><textarea className="textarea" maxLength={3000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

export function CustomerDetail() {
  const { id } = useParams();
  const fmt = useFmt();
  const { openAppointment, newAppointment } = useApp();
  const state = useLive<any>(`/admin/customers/${id}`);
  const [editing, setEditing] = useState(false);
  return (
    <>
      <Link to="/app/customers" className="back"><Icon name="left" size={14} />{tr("Customers")}</Link>
      <Async state={state}>{({ customer: c, stats: s, appointments, payments }) => (
        <>
          <PageHead title={c.name} sub={<>{[c.phone, c.email].filter(Boolean).join(' · ') || tr("No contact details")} {"· "}{tr("customer since")}{' '}{fmt.date(c.created_at, 'medium')}{c.has_account ? ' · has an online account' : ''}</>}>
            <button className="btn btn-ghost" onClick={() => setEditing(true)}><Icon name="edit" size={15} />{tr("Edit")}</button>
            <button className="btn btn-primary" onClick={() => newAppointment({ customer: { id: c.id, name: c.name, phone: c.phone } })}><Icon name="plus" size={15} />{tr("Book")}</button>
          </PageHead>
          <div className="stats">
            <div className="stat"><div className="k">{tr("Completed visits")}</div><div className="v num">{s.visits}</div><div className="s">{s.no_shows} {tr("no-show")}{s.no_shows === 1 ? '' : 's'}</div></div>
            <div className="stat"><div className="k">{tr("Total paid")}</div><div className="v num">{fmt.money(s.total_paid_minor)}</div><div className="s">{tr("Payments minus refunds")}</div></div>
            <div className="stat"><div className="k">{tr("Balance due")}</div><div className={`v num ${s.outstanding_minor > 0 ? 'bad' : 'ok'}`}>{fmt.money(s.outstanding_minor)}</div><div className="s">{tr("Completed services not yet paid")}</div></div>
            <div className="stat"><div className="k">{tr("Last / next")}</div><div className="s" style={{ marginTop: 8, fontSize: 14, color: 'var(--ink)' }}>{tr("Last:")}{' '}{s.last_visit ? fmt.date(s.last_visit, 'medium') : '—'}<br />{tr("Next:")}{' '}{s.next_appointment ? fmt.dateTime(s.next_appointment) : '—'}</div></div>
          </div>
          {c.notes && <div style={{ marginBottom: 16 }}><Notice tone="info" icon="edit"><b>{tr("Internal note:")}</b> {c.notes}</Notice></div>}
          <div className="grid c21">
            <div className="card">
              <div className="card-head"><h2>{tr("Appointments")}{" ("}{appointments.length})</h2></div>
              {appointments.length ? <div className="table-wrap"><table className="table">
                <thead><tr><th>{tr("When")}</th><th>{tr("Service")}</th><th className="hide-sm">{tr("Barber")}</th><th>{tr("Status")}</th><th className="r">{tr("Price")}</th><th className="r">{tr("Balance")}</th></tr></thead>
                <tbody>{appointments.map((a: any) => (
                  <tr key={a.id} className="click" onClick={() => openAppointment(a.id)}>
                    <td className="num nowrap">{fmt.dateTime(a.starts_at)}</td><td>{a.services}</td><td className="hide-sm">{a.barber_name}</td><td><StatusBadge status={a.status} /></td>
                    <td className="r num">{fmt.money(a.total_minor)}</td>
                    <td className={`r num ${a.status === 'completed' && a.balance_minor > 0 ? 'neg' : ''}`}>{a.status === 'completed' ? fmt.money(a.balance_minor) : '—'}</td>
                  </tr>
                ))}</tbody>
              </table></div> : <Empty title={tr("No appointments yet.")} />}
            </div>
            <div className="card">
              <div className="card-head"><h2>{tr("Payment history")}</h2></div>
              {payments.length ? <div className="card-body" style={{ paddingTop: 6, paddingBottom: 6 }}>
                {payments.map((p: any) => (
                  <div className="ledger-row" key={p.id} style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                    <div>{p.kind === 'payment' ? tr("Payment") : p.kind === 'refund' ? tr("Refund") : tr("Correction")} · {tr(METHOD_LABEL[p.method as Method])}<small>{fmt.dateTime(p.created_at)} · <button className="link" onClick={() => openAppointment(p.appointment_id)}>{p.reference}</button></small></div>
                    <b className={`num ${p.amount_minor < 0 ? 'neg' : ''}`}>{fmt.money(p.amount_minor)}</b>
                  </div>
                ))}
              </div> : <Empty icon="receipt" title={tr("No payments recorded.")} />}
            </div>
          </div>
          {editing && <CustomerForm customer={c} onClose={() => setEditing(false)} onSaved={() => {}} />}
        </>
      )}</Async>
    </>
  );
}

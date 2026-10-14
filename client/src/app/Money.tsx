import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CHART, ColumnChart, HBars } from '../components/charts';
import { Icon } from '../components/Icon';
import { Async, Empty, Field, Img, Modal, MoneyInput, Notice, Pagination, ReasonModal, useAction } from '../components/ui';
import { api, newKey, qs } from '../lib/api';
import { useFmt } from '../lib/context';
import { COMP_LABEL, METHOD_LABEL, METHODS, SOURCE_LABEL, STATUS_LABEL, type CompModel, type Method, type Source, type Status } from '../../../shared/constants';
import { useApp, useLive } from './AppLayout';
import { ruleText } from './Chair';
import { PageHead, RangePicker, rangeQuery, useRange } from './shared';
import { tr } from '../lib/i18n';

const KIND: Record<string, string> = { payment: 'Payment', refund: 'Refund', adjustment: 'Correction' };
const exportHref = (type: string, range: { from: string; to: string }) => `/api/admin/export/${type}?from=${range.from}&to=${range.to}`;

export function Payments() {
  const fmt = useFmt();
  const ctl = useRange('month');
  const { openAppointment } = useApp();
  const [q, setQ] = useState('');
  const [method, setMethod] = useState('');
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [q, method, kind, ctl.range]);
  const state = useLive<any>(`/admin/payments${qs({ from: ctl.range.from, to: ctl.range.to, q, method, kind, page })}`);
  return (
    <>
      <PageHead title={tr("Payments")} sub={tr("The money ledger: every payment, refund and correction, exactly as recorded. Entries are never edited or deleted.")}>
        <a className="btn btn-ghost" href={exportHref('payments', ctl.range)}><Icon name="download" size={15} />{tr("Export CSV")}</a>
      </PageHead>
      <div className="toolbar"><RangePicker ctl={ctl} /></div>
      <div className="toolbar">
        <div className="search"><Icon name="search" size={16} /><input className="input" placeholder={tr("Customer, booking or entry reference")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={tr("Search payments")} /></div>
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label={tr("Type")}><option value="">{tr("All types")}</option>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}s</option>)}</select>
        <select className="select" value={method} onChange={(e) => setMethod(e.target.value)} aria-label={tr("Method")}><option value="">{tr("All methods")}</option>{METHODS.map((m) => <option key={m} value={m}>{tr(METHOD_LABEL[m])}</option>)}</select>
      </div>
      <div className="card">
        <Async state={state}>{(d) => d.payments.length ? (
          <>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>{tr("Date")}</th><th>{tr("Entry")}</th><th>{tr("Customer")}</th><th className="hide-sm">{tr("Barber")}</th><th>{tr("Method")}</th><th className="hide-sm">{tr("Recorded by")}</th><th className="r">{tr("Amount")}</th></tr></thead>
              <tbody>{d.payments.map((p: any) => (
                <tr key={p.id} className={`click ${p.voided_by ? 'void' : ''}`} onClick={() => openAppointment(p.appointment_id)}>
                  <td className="num nowrap">{fmt.dateTime(p.created_at)}</td>
                  <td><span className={`badge plain ${p.kind === 'refund' ? 'bad' : p.kind === 'adjustment' ? 'warn' : 'ok'}`}>{tr(KIND[p.kind])}</span><span className="sub num">{p.public_id}{p.voided_by ? ' · voided' : ''}</span></td>
                  <td><b>{p.customer_name}</b><span className="sub num">{p.appointment_reference}{p.note ? ` — ${p.note}` : ''}</span></td>
                  <td className="hide-sm">{p.barber_name}</td>
                  <td>{tr(METHOD_LABEL[p.method as Method])}{p.reference && <span className="sub">{p.reference}</span>}</td>
                  <td className="hide-sm">{p.recorded_by_name ?? '—'}</td>
                  <td className={`r num ${p.amount_minor < 0 ? 'neg' : ''}`}><b>{fmt.money(p.amount_minor)}</b></td>
                </tr>
              ))}</tbody>
              <tfoot><tr><td colSpan={3}>{tr("Net of")}{' '}{d.total} {d.total === 1 ? 'entry' : 'entries'} {tr("matching the filters")}</td><td className="hide-sm" /><td /><td className="hide-sm" /><td className="r num">{fmt.money(d.net_minor)}</td></tr></tfoot>
            </table></div>
            <Pagination page={page} pageSize={d.page_size} total={d.total} onPage={setPage} />
          </>
        ) : <Empty icon="receipt" title={tr("No ledger entries in this period.")}>{tr("Payments are recorded from an appointment: open it and choose “Record payment”.")}</Empty>}</Async>
      </div>
    </>
  );
}

/** Records a payout to a barber, capped at what is currently owed. */
export function PayoutModal({ barber, owed, onClose }: { barber: { id: number; name: string }; owed: number; onClose: () => void }) {
  const fmt = useFmt();
  const { touch } = useApp();
  const act = useAction();
  const key = useRef(newKey());
  const [amount, setAmount] = useState(fmt.plain(owed));
  const [method, setMethod] = useState<Method>('cash');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(fmt.today());
  const minor = fmt.parse(amount);
  const invalid = minor == null || minor <= 0 ? tr("Enter an amount.") : minor > owed ? `${tr("Only")} ${fmt.money(owed)} ${tr("is owed right now.")}` : null;
  return (
    <Modal title={`${tr("Pay")} ${barber.name}`} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>{tr("Discard")}</button>
      <button className="btn btn-dark" disabled={!!invalid || act.busy} onClick={() => act.run(async () => {
        await api(`/admin/barbers/${barber.id}/payouts`, { body: { amountMinor: minor, method, reference: reference.trim() || undefined, note: note.trim() || undefined, paidDate: date, idempotencyKey: key.current } });
        touch();
        onClose();
      }, tr("Payout recorded."))}>{tr("Record payout")}{minor && !invalid ? ` ${tr("of")} ${fmt.money(minor)}` : ''}</button>
    </>}>
      <div className="stack">
        {act.error && <Notice tone="bad" icon="alert">{act.error}</Notice>}
        <div className="money3"><div><span>{tr("Owed now")}</span><b className="num">{fmt.money(owed)}</b></div><div><span>{tr("This payout")}</span><b className="num">{fmt.money(minor ?? 0)}</b></div><div className={minor != null && owed - minor === 0 ? 'clear' : ''}><span>{tr("Left owed")}</span><b className="num">{fmt.money(Math.max(0, owed - (minor ?? 0)))}</b></div></div>
        <Field label={tr("Amount")} error={minor != null && invalid ? invalid : null}><MoneyInput value={amount} onChange={setAmount} autoFocus /></Field>
        <div className="stack tight"><span className="label">{tr("Method")}</span><div className="seg">{METHODS.map((m) => <button type="button" key={m} aria-pressed={method === m} onClick={() => setMethod(m)}>{tr(METHOD_LABEL[m])}</button>)}</div></div>
        <div className="form-grid cols-2">
          <Field label={tr("Settlement date")}><input type="date" className="input" value={date} max={fmt.today()} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label={tr("Reference (optional)")}><input className="input" value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} placeholder={tr("Transfer no., receipt…")} /></Field>
        </div>
        <Field label={tr("Note (optional)")}><input className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder={tr("e.g. Week 42 settlement")} /></Field>
      </div>
    </Modal>
  );
}

export function Payroll() {
  const fmt = useFmt();
  const state = useLive<any>('/admin/payroll');
  const [pay, setPay] = useState<any | null>(null);
  const today = fmt.today();
  return (
    <>
      <PageHead title={tr("Barber pay")} sub={tr("What each barber has earned under their arrangement, what you have paid them, and what you still owe. Payouts never change revenue.")}>
        <a className="btn btn-ghost" href={exportHref('payouts', { from: `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`, to: today })}><Icon name="download" size={15} />{tr("Payouts CSV")}</a>
      </PageHead>
      <Async state={state}>{(d) => (
        <>
          <div className="stats">
            <div className="stat accent"><div className="k">{tr("Owed to barbers now")}</div><div className="v num">{fmt.money(d.totals.owed_minor)}</div><div className="s">{tr("Earned minus paid out")}</div></div>
            <div className="stat"><div className="k">{tr("Earned to date")}</div><div className="v num">{fmt.money(d.totals.earned_minor)}</div></div>
            <div className="stat"><div className="k">{tr("Paid out to date")}</div><div className="v num">{fmt.money(d.totals.paid_minor)}</div></div>
          </div>
          <div className="card"><div className="table-wrap"><table className="table">
            <thead><tr><th>{tr("Barber")}</th><th>{tr("Arrangement")}</th><th className="r">{tr("Earned")}</th><th className="r">{tr("Paid out")}</th><th className="r">{tr("Owed")}</th><th /></tr></thead>
            <tbody>{d.barbers.map((b: any) => (
              <tr key={b.id}>
                <td><Link to={`/app/team/${b.id}`} className="person"><Img src={b.photo_url} alt="" label={b.name} /><div><b>{b.name}</b><small>{b.is_active ? tr("Active") : tr("Inactive")}</small></div></Link></td>
                <td><span className="badge plain">{tr(COMP_LABEL[(b.rule?.model ?? 'none') as CompModel])}</span><span className="sub">{ruleText(b.rule, fmt)}</span></td>
                <td className="r num">{fmt.money(b.earned_minor)}</td><td className="r num">{fmt.money(b.paid_minor)}</td>
                <td className="r num"><b className={b.owed_minor > 0 ? '' : 'muted'}>{fmt.money(b.owed_minor)}</b></td>
                <td className="r nowrap"><button className="btn btn-dark btn-sm" disabled={b.owed_minor <= 0} onClick={() => setPay(b)}>{tr("Pay")}</button> <Link className="btn btn-ghost btn-sm" to={`/app/team/${b.id}?tab=pay`}>{tr("Ledger")}</Link></td>
              </tr>
            ))}</tbody>
          </table></div></div>
          {pay && <PayoutModal barber={pay} owed={pay.owed_minor} onClose={() => setPay(null)} />}
        </>
      )}</Async>
    </>
  );
}

const EXPENSE_CATEGORIES = ['Rent', 'Products', 'Utilities', 'Equipment', 'Laundry', 'Marketing', 'Taxes & fees', 'Other'];

export function Expenses() {
  const fmt = useFmt();
  const ctl = useRange('month');
  const { touch } = useApp();
  const state = useLive<any>(`/admin/expenses?${rangeQuery(ctl.range)}`);
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<any | null>(null);
  const act = useAction();
  const [f, setF] = useState({ category: 'Products', description: '', amount: '', method: 'cash' as Method, date: fmt.today() });
  const minor = fmt.parse(f.amount);
  return (
    <>
      <PageHead title={tr("Expenses")} sub={tr("Running costs of the shop. Barber pay is tracked separately and is not entered here.")}>
        <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" size={15} />{tr("Add expense")}</button>
      </PageHead>
      <div className="toolbar"><RangePicker ctl={ctl} /></div>
      <div className="card">
        <Async state={state}>{(d) => d.expenses.length ? (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{tr("Date")}</th><th>{tr("Category")}</th><th>{tr("Description")}</th><th>{tr("Method")}</th><th className="r">{tr("Amount")}</th><th /></tr></thead>
            <tbody>{d.expenses.map((e: any) => (
              <tr key={e.id} className={e.voided_at ? 'void' : ''}>
                <td className="num nowrap">{fmt.date(e.spent_at, 'medium')}</td><td><span className="badge plain">{tr(e.category)}</span></td>
                <td>{e.description || '—'}{e.voided_at && <span className="sub">{tr("Voided:")}{' '}{e.void_reason}</span>}</td><td>{tr(METHOD_LABEL[e.method as Method])}</td>
                <td className="r num"><b>{fmt.money(e.amount_minor)}</b></td>
                <td className="r">{!e.voided_at && <button className="icon-btn" title={tr("Void this expense")} aria-label={tr("Void this expense")} onClick={() => setVoiding(e)}><Icon name="undo" size={16} /></button>}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr><td colSpan={4}>{tr("Total for the period (voided entries excluded)")}</td><td className="r num">{fmt.money(d.total_minor)}</td><td /></tr></tfoot>
          </table></div>
        ) : <Empty icon="tag" title={tr("No expenses in this period.")}>{tr("Record rent, products and bills to see a true operating result in Reports.")}</Empty>}</Async>
      </div>
      {adding && (
        <Modal title={tr("Add expense")} onClose={() => setAdding(false)} footer={<>
          <button className="btn btn-ghost" onClick={() => setAdding(false)}>{tr("Discard")}</button>
          <button className="btn btn-dark" disabled={act.busy || !minor || minor <= 0} onClick={() => act.run(async () => {
            await api('/admin/expenses', { body: { category: f.category, description: f.description.trim(), amountMinor: minor, method: f.method, date: f.date } });
            touch();
            setAdding(false);
            setF({ ...f, description: '', amount: '' });
          }, tr("Expense recorded."))}>{tr("Save expense")}</button>
        </>}>
          <div className="stack">
            {act.error && <Notice tone="bad" icon="alert">{act.error}</Notice>}
            <div className="form-grid cols-2">
              <Field label={tr("Category")}><select className="select" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{tr(c)}</option>)}</select></Field>
              <Field label={tr("Date")}><input type="date" className="input" value={f.date} max={fmt.today()} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
            </div>
            <Field label={tr("Description")}><input className="input" value={f.description} maxLength={300} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
            <div className="form-grid cols-2">
              <Field label={tr("Amount")}><MoneyInput value={f.amount} onChange={(v) => setF({ ...f, amount: v })} /></Field>
              <Field label={tr("Paid by")}><select className="select" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value as Method })}>{METHODS.map((m) => <option key={m} value={m}>{tr(METHOD_LABEL[m])}</option>)}</select></Field>
            </div>
          </div>
        </Modal>
      )}
      {voiding && <ReasonModal title={tr("Void this expense?")} danger required confirm={tr("Void expense")} onClose={() => setVoiding(null)} text={`${voiding.category} — ${fmt.money(voiding.amount_minor)}. ${tr("It stays in the list, struck through, and no longer counts.")}`}
        onSubmit={async (reason) => { await api(`/admin/expenses/${voiding.id}/void`, { body: { reason } }); touch(); }} />}
    </>
  );
}

export function Reports() {
  const fmt = useFmt();
  const ctl = useRange('month');
  const state = useLive<any>(`/admin/reports?${rangeQuery(ctl.range)}`);
  const day = (d: string) => `${Number(d.slice(8))}/${Number(d.slice(5, 7))}`;
  return (
    <>
      <PageHead title={tr("Reports")} sub={tr("Each figure says exactly what it measures. Revenue is services performed; collected is money received.")}>
        <a className="btn btn-ghost" href={exportHref('summary', ctl.range)}><Icon name="download" size={15} />{tr("Summary CSV")}</a>
        <a className="btn btn-ghost" href={exportHref('appointments', ctl.range)}><Icon name="download" size={15} />{tr("Appointments CSV")}</a>
        <button className="btn btn-ghost no-print" onClick={() => window.print()}><Icon name="printer" size={15} />{tr("Print")}</button>
      </PageHead>
      <div className="toolbar"><RangePicker ctl={ctl} /></div>
      <Async state={state}>{(r) => {
        const m = r.money, a = r.appointments;
        return (
          <>
            <div className="stats">
              <div className="stat accent"><div className="k">{tr("Service revenue")}</div><div className="v num">{fmt.money(m.service_revenue_minor)}</div><div className="s">{a.completed_services} {tr("services performed")}</div></div>
              <div className="stat"><div className="k">{tr("Net collected")}</div><div className="v num">{fmt.money(m.net_collected_minor)}</div><div className="s">{tr("Received")}{' '}{fmt.money(m.payments_received_minor)} {"· "}{tr("refunded")}{' '}{fmt.money(m.refunds_minor)}</div></div>
              <div className="stat"><div className="k">{tr("Unpaid from this period")}</div><div className={`v num ${m.outstanding_period_minor > 0 ? 'bad' : ''}`}>{fmt.money(m.outstanding_period_minor)}</div><div className="s">{tr("All time:")}{' '}{fmt.money(m.outstanding_total_minor)}</div></div>
              <div className="stat"><div className="k">{tr("Appointments")}</div><div className="v num">{a.total}</div><div className="s">{a.cancellation_rate}{"% "}{tr("cancelled")}{" · "}{a.no_show_rate}{"% "}{tr("no-show")}</div></div>
            </div>

            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-head"><h2>{tr("Revenue and collections per day")}</h2></div>
              <div className="card-body"><ColumnChart data={r.daily.map((d: any) => ({ label: day(d.date), title: fmt.date(d.date, 'medium'), revenue: d.revenue_minor, collected: d.collected_minor }))}
                series={[{ key: 'revenue', label: tr("Service revenue"), color: CHART.revenue }, { key: 'collected', label: tr("Collected"), color: CHART.collected }]} format={fmt.money} tickFormat={(v) => fmt.plain(v).replace(/\.0+$/, '')} /></div>
            </div>

            <div className="grid c2">
              <div className="card">
                <div className="card-head"><h2>{tr("Operating result — work done")}</h2></div>
                <div className="card-body eq">
                  <div><span>{tr("Service revenue")}<small>{tr("Agreed price of services completed in the period")}</small></span><span>{fmt.money(m.service_revenue_minor)}</span></div>
                  <div><span>{tr("Barber compensation earned")}<small>{tr("Under each barber's rule; owed whether or not paid out yet")}</small></span><span>− {fmt.money(m.compensation_earned_minor)}</span></div>
                  <div><span>{tr("Expenses")}<small>{tr("Recorded running costs")}</small></span><span>− {fmt.money(m.expenses_minor)}</span></div>
                  <div className="sum"><span>{tr("Operating result")}</span><span className={m.operating_result_minor < 0 ? 'neg' : ''}>{fmt.money(m.operating_result_minor)}</span></div>
                </div>
              </div>
              <div className="card">
                <div className="card-head"><h2>{tr("Cash flow — money moved")}</h2></div>
                <div className="card-body eq">
                  <div><span>{tr("Payments received")}</span><span>{fmt.money(m.payments_received_minor)}</span></div>
                  <div><span>{tr("Refunds")}</span><span>− {fmt.money(m.refunds_minor)}</span></div>
                  {m.adjustments_minor !== 0 && <div><span>{tr("Corrections")}<small>{tr("Voided entries")}</small></span><span>{fmt.money(m.adjustments_minor)}</span></div>}
                  <div><span>{tr("Barber payouts")}<small>{tr("Counted here only — never deducted from revenue as well")}</small></span><span>− {fmt.money(m.payouts_paid_minor)}</span></div>
                  <div><span>{tr("Expenses")}</span><span>− {fmt.money(m.expenses_minor)}</span></div>
                  <div className="sum"><span>{tr("Net cash flow")}</span><span className={m.net_cash_flow_minor < 0 ? 'neg' : ''}>{fmt.money(m.net_cash_flow_minor)}</span></div>
                </div>
              </div>
            </div>

            <div className="grid c3" style={{ marginTop: 16 }}>
              <div className="card"><div className="card-head"><h2>{tr("Collected by method")}</h2></div><div className="card-body">
                <HBars tone="b" rows={r.byMethod.map((x: any) => ({ label: tr(METHOD_LABEL[x.method as Method]), value: Math.max(0, x.net_minor), display: `${fmt.money(x.net_minor)} · ${x.entries} ${tr("entries")}` }))} empty={tr("Nothing collected in this period.")} />
              </div></div>
              <div className="card"><div className="card-head"><h2>{tr("Revenue by service")}</h2></div><div className="card-body">
                <HBars rows={r.byService.map((x: any) => ({ label: x.name, value: x.revenue_minor, display: `${x.count}× · ${fmt.money(x.revenue_minor)}` }))} empty={tr("No completed services in this period.")} />
              </div></div>
              <div className="card"><div className="card-head"><h2>{tr("Where bookings come from")}</h2></div><div className="card-body">
                <HBars tone="b" rows={r.bySource.map((x: any) => ({ label: tr(SOURCE_LABEL[x.source as Source]), value: x.count, display: `${x.count} · ${a.total ? Math.round((x.count / a.total) * 100) : 0}%` }))} />
              </div></div>
            </div>

            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-head"><h2>{tr("By barber")}</h2></div>
              <div className="table-wrap"><table className="table">
                <thead><tr><th>{tr("Barber")}</th><th className="r">{tr("Booked")}</th><th className="r">{tr("Completed")}</th><th className="r">{tr("No-shows")}</th><th className="r">{tr("Service revenue")}</th><th className="r">{tr("Collected")}</th><th className="r">{tr("Compensation earned")}</th><th className="r">{tr("Paid out")}</th></tr></thead>
                <tbody>{r.byBarber.map((b: any) => (
                  <tr key={b.id}><td><b>{b.name}</b></td><td className="r num">{b.appointments}</td><td className="r num">{b.completed}</td><td className="r num">{b.no_shows}</td>
                    <td className="r num">{fmt.money(b.revenue_minor)}</td><td className="r num">{fmt.money(b.collected_minor)}</td><td className="r num">{fmt.money(b.earned_minor)}</td><td className="r num">{fmt.money(b.paid_out_minor)}</td></tr>
                ))}</tbody>
                <tfoot><tr><td>{tr("Total")}</td><td className="r num">{a.total}</td><td className="r num">{a.completed_services}</td><td className="r num">{a.byStatus.no_show}</td>
                  <td className="r num">{fmt.money(m.service_revenue_minor)}</td><td className="r num">{fmt.money(m.net_collected_minor)}</td><td className="r num">{fmt.money(m.compensation_earned_minor)}</td><td className="r num">{fmt.money(m.payouts_paid_minor)}</td></tr></tfoot>
              </table></div>
            </div>

            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-head"><h2>{tr("Appointments by status")}</h2></div>
              <div className="card-body"><div className="row fw" style={{ gap: 28 }}>
                {Object.entries(a.byStatus as Record<string, number>).map(([k, n]) => <div key={k}><div className="label">{tr(STATUS_LABEL[k as Status])}</div><div className="num" style={{ fontFamily: 'var(--serif)', fontSize: 30 }}>{n}</div></div>)}
              </div></div>
            </div>
          </>
        );
      }}</Async>
    </>
  );
}

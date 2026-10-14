import { useEffect, useState } from 'react';
import { Calendar } from '../components/Calendar';
import { Icon } from '../components/Icon';
import { Async, Empty, PayBadge, StatusBadge, useAction } from '../components/ui';
import { api } from '../lib/api';
import { useAuth, useFmt } from '../lib/context';
import { COMP_BASIS_LABEL, METHOD_LABEL, SOURCE_LABEL, type CompBasis, type Method, type Source } from '../../../shared/constants';
import { addDays, fmtDuration } from '../../../shared/time';
import { useApp, useLive } from './AppLayout';
import { PageHead, TimeOffCard } from './shared';
import { tr } from '../lib/i18n';

const NEXT_STEP: Record<string, [string, string] | undefined> = { confirmed: ['checked_in', 'Check in'], checked_in: ['in_progress', 'Start'], in_progress: ['completed', 'Complete'] };

/** The working barber's home screen: today's chair in time order, with one-tap next steps. */
export function Today() {
  const { user } = useAuth();
  const fmt = useFmt();
  const { openAppointment, newAppointment, touch, team } = useApp();
  const [date, setDate] = useState(fmt.today());
  const summary = useLive<any>('/staff/summary');
  const list = useLive<{ appointments: any[] }>(`/staff/appointments?from=${date}&to=${date}&barber=me`);
  const act = useAction();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const isToday = date === fmt.today();
  const now = Date.now();
  const appts = (list.data?.appointments ?? []).filter((a) => a.status !== 'cancelled');
  const cancelled = (list.data?.appointments ?? []).filter((a) => a.status === 'cancelled').length;
  const nextUp = isToday ? appts.find((a) => ['confirmed', 'checked_in', 'in_progress', 'pending'].includes(a.status) && a.ends_at > now) : undefined;
  const hello = new Date().getHours() < 12 ? tr("Good morning") : new Date().getHours() < 18 ? tr("Good afternoon") : tr("Good evening");

  if (!team.my_barber_id) return <Empty icon="chair" title={tr("No chair linked to your account.")}>{tr("Ask the owner to link a barber profile to this login.")}</Empty>;

  return (
    <>
      <PageHead title={isToday ? `${hello}, ${user!.name.split(' ')[0]}.` : fmt.date(date, 'long')} sub={isToday ? fmt.date(date, 'long') : tr("Viewing another day")}>
        <button className="btn btn-ghost no-print" onClick={() => window.print()} title={tr("Print this day's schedule")}><Icon name="printer" size={15} />{tr("Print")}</button>
        <button className="btn btn-primary" onClick={() => newAppointment({ barberId: team.my_barber_id!, date })}><Icon name="plus" size={15} />{tr("New appointment")}</button>
      </PageHead>

      {summary.data?.has_chair && (
        <div className="stats">
          <div className="stat accent"><div className="k">{tr("Today")}</div><div className="v num">{summary.data.today.total}<small>{tr("booked")}</small></div><div className="s">{summary.data.today.remaining} {tr("still to come")}{" · "}{summary.data.today.completed} {tr("done")}</div></div>
          <div className="stat"><div className="k">{tr("Collected today")}</div><div className="v num">{fmt.money(summary.data.today.collected_minor)}</div><div className="s">{tr("Payments recorded on my chair")}</div></div>
          <div className="stat"><div className="k">{tr("Unpaid completed services")}</div><div className={`v num ${summary.data.today.unpaid_minor > 0 ? 'bad' : ''}`}>{fmt.money(summary.data.today.unpaid_minor)}</div><div className="s">{tr("Done on my chair, not yet paid")}</div></div>
          <div className="stat"><div className="k">{tr("Next 7 days")}</div><div className="v num">{summary.data.week_upcoming}<small>{tr("upcoming")}</small></div><div className="s">{summary.data.earnings ? `${tr("Owed to me:")} ${fmt.money(summary.data.earnings.owed_minor)}` : tr("Confirmed and pending")}</div></div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>{isToday ? tr("My chair today") : tr("My chair")}</h2>
          <div className="row no-print">
            <button className="icon-btn" aria-label={tr("Previous day")} onClick={() => setDate(addDays(date, -1))}><Icon name="left" /></button>
            {!isToday && <button className="btn btn-ghost btn-sm" onClick={() => setDate(fmt.today())}>{tr("Today")}</button>}
            <button className="icon-btn" aria-label={tr("Next day")} onClick={() => setDate(addDays(date, 1))}><Icon name="right" /></button>
          </div>
        </div>
        <Async state={list}>{() => appts.length ? (
          <div className="agenda">
            {appts.map((a) => {
              const step = NEXT_STEP[a.status];
              const isNext = nextUp?.id === a.id;
              return (
                <div key={a.id} className={`agenda-row ${isNext ? 'next' : ''} ${isToday && a.ends_at < now && (a.status === 'no_show' || (a.status === 'completed' && a.balance_minor <= 0)) ? 'past' : ''}`} role="button" tabIndex={0}
                  onClick={() => openAppointment(a.id)} onKeyDown={(e) => e.key === 'Enter' && openAppointment(a.id)}>
                  <div className="t num">{fmt.time(a.starts_at)}<small>{fmtDuration(a.duration_min)}</small></div>
                  <div>
                    <b>{a.customer_name}</b>{isNext && <span className="badge dark plain" style={{ marginLeft: 8 }}>{a.status === 'in_progress' ? tr("In the chair") : tr("Up next")}</span>}
                    <div className="meta">{a.services} · <span className="num">{fmt.money(a.total_minor)}</span>{a.customer_phone ? ` · ${a.customer_phone}` : ''} · {tr(SOURCE_LABEL[a.source as Source])}</div>
                    {(a.customer_note || a.internal_note) && <div className="meta"><Icon name="info" size={13} /> {a.customer_note || a.internal_note}</div>}
                    {(step || (a.status === 'completed' && a.balance_minor > 0)) && (
                      <div className="quick no-print">
                        {step && <button className="btn btn-dark btn-sm" disabled={act.busy} onClick={(e) => { e.stopPropagation(); void act.run(async () => { await api(`/staff/appointments/${a.id}/status`, { body: { status: step[0] } }); touch(); }); }}>{tr(step[1])}</button>}
                        {a.status === 'completed' && a.balance_minor > 0 && <button className="btn btn-primary btn-sm" onClick={(e) => { e.stopPropagation(); openAppointment(a.id); }}>{tr("Take payment")}{" · "}{fmt.money(a.balance_minor)}</button>}
                      </div>
                    )}
                  </div>
                  <div className="tags"><StatusBadge status={a.status} /><PayBadge status={a.payment_status} appointmentStatus={a.status} /></div>
                </div>
              );
            })}
          </div>
        ) : <Empty icon="chair" title={isToday ? tr("Nothing booked yet today.") : tr("Nothing booked on this day.")} action={<button className="btn btn-primary" onClick={() => newAppointment({ barberId: team.my_barber_id!, date })}>{tr("Add an appointment")}</button>}>{tr("Walk-ins and phone bookings you add here block the same slots customers see online.")}</Empty>}</Async>
        {cancelled > 0 && <div className="pager"><span className="muted">{cancelled} {tr("cancelled")}{' '}{cancelled === 1 ? 'appointment is' : 'appointments are'} {tr("hidden — see My schedule.")}</span></div>}
      </div>
    </>
  );
}

export function MySchedule() {
  const { team, newAppointment } = useApp();
  if (!team.my_barber_id) return <Empty icon="calendar" title={tr("No chair linked to your account.")} />;
  return (
    <>
      <PageHead title={tr("My schedule")} sub={tr("Day, week and month views of your own chair. Click an empty time to add a booking.")}>
        <button className="btn btn-primary" onClick={() => newAppointment({ barberId: team.my_barber_id! })}><Icon name="plus" size={15} />{tr("New appointment")}</button>
      </PageHead>
      <Calendar scope="me" />
      <div style={{ marginTop: 24 }}><TimeOffCard barberId={team.my_barber_id} /></div>
    </>
  );
}

export function ruleText(rule: any, fmt: ReturnType<typeof useFmt>) {
  if (!rule) return tr("No rule set");
  const basis = tr(COMP_BASIS_LABEL[rule.basis as CompBasis]).toLowerCase();
  if (rule.model === 'commission') return `${(rule.commission_bps / 100).toFixed(rule.commission_bps % 100 ? 2 : 0)}% ${tr("of the agreed service price")} — ${basis}`;
  if (rule.model === 'fixed_per_service') return `${fmt.money(rule.fixed_minor)} ${tr("per service")} — ${basis}`;
  if (rule.model === 'salary') return `${tr("Fixed salary of")} ${fmt.money(rule.salary_minor)} ${tr("per month, recorded by the owner")}`;
  return tr("No automatic compensation");
}

/** Earnings and payouts ledger, shared by the barber's own view and the owner's team page. */
export function Ledger({ data, onVoid }: { data: any; onVoid?: (payout: any) => void }) {
  const fmt = useFmt();
  const kind: Record<string, string> = { service: tr("Service"), salary: tr("Salary"), bonus: tr("Bonus"), deduction: tr("Deduction") };
  return (
    <div className="grid c2">
      <div className="card">
        <div className="card-head"><h2>{tr("Earned")}</h2><span className="num muted">{fmt.money(data.balance.earned_minor)}</span></div>
        {data.earnings.length ? <div className="table-wrap"><table className="table">
          <thead><tr><th>{tr("Date")}</th><th>{tr("For")}</th><th className="r">{tr("Base")}</th><th className="r">{tr("Earned")}</th></tr></thead>
          <tbody>{data.earnings.map((e: any) => {
            const snap = e.rule_snapshot ? JSON.parse(e.rule_snapshot) : null;
            return (
              <tr key={e.id}>
                <td className="num nowrap">{fmt.date(e.created_at, 'short')}</td>
                <td>{e.kind === 'service' ? e.services : kind[e.kind]}{e.period ? ` ${e.period}` : ''}
                  <span className="sub">{e.kind === 'service' ? `${e.reference} · ${snap?.model === 'commission' ? `${snap.commission_bps / 100}%` : 'fixed'}` : e.note || '—'}</span></td>
                <td className="r num">{e.kind === 'service' ? fmt.money(e.base_minor) : '—'}</td>
                <td className={`r num ${e.amount_minor < 0 ? 'neg' : ''}`}><b>{fmt.money(e.amount_minor)}</b></td>
              </tr>
            );
          })}</tbody>
        </table></div> : <Empty icon="coins" title={tr("Nothing earned yet.")}>{tr("Earnings appear when services are completed under the compensation rule.")}</Empty>}
      </div>
      <div className="card">
        <div className="card-head"><h2>{tr("Paid out")}</h2><span className="num muted">{fmt.money(data.balance.paid_minor)}</span></div>
        {data.payouts.length ? <div className="table-wrap"><table className="table">
          <thead><tr><th>{tr("Date")}</th><th>{tr("Method")}</th><th className="r">{tr("Amount")}</th>{onVoid && <th />}</tr></thead>
          <tbody>{data.payouts.map((p: any) => (
            <tr key={p.id} className={p.voided_by ? 'void' : ''}>
              <td className="num nowrap">{fmt.date(p.paid_at, 'medium')}</td>
              <td>{p.reverses_payout_id ? tr("Correction") : tr(METHOD_LABEL[p.method as Method])}{p.reference ? ` · ${p.reference}` : ''}<span className="sub">{p.public_id}{p.note ? ` — ${p.note}` : ''}</span></td>
              <td className={`r num ${p.amount_minor < 0 ? 'neg' : ''}`}><b>{fmt.money(p.amount_minor)}</b></td>
              {onVoid && <td className="r">{!p.reverses_payout_id && !p.voided_by && <button className="icon-btn" title={tr("Void this payout")} aria-label={tr("Void this payout")} onClick={() => onVoid(p)}><Icon name="undo" size={16} /></button>}</td>}
            </tr>
          ))}</tbody>
        </table></div> : <Empty icon="wallet" title={tr("No payouts yet.")}>{tr("Settlements recorded by the owner are listed here.")}</Empty>}
      </div>
    </div>
  );
}

export function MyEarnings() {
  const fmt = useFmt();
  const state = useLive<any>('/staff/earnings');
  return (
    <>
      <PageHead title={tr("My earnings")} sub={tr("What you have earned, what has been paid to you, and what is still owed.")} />
      {state.error?.status === 403 ? <Empty icon="shield" title={tr("Earnings are not shared here.")}>{state.error.message}</Empty> : (
        <Async state={state}>{(d) => (
          <>
            <div className="stats">
              <div className="stat accent"><div className="k">{tr("Owed to me")}</div><div className="v num">{fmt.money(d.balance.owed_minor)}</div><div className="s">{tr("Earned minus paid out")}</div></div>
              <div className="stat"><div className="k">{tr("Earned in total")}</div><div className="v num">{fmt.money(d.balance.earned_minor)}</div></div>
              <div className="stat"><div className="k">{tr("Paid out in total")}</div><div className="v num">{fmt.money(d.balance.paid_minor)}</div></div>
              <div className="stat" style={{ flex: 2 }}><div className="k">{tr("My arrangement")}</div><div className="s" style={{ marginTop: 8, fontSize: 14, color: 'var(--ink)' }}>{ruleText(d.rule, fmt)}</div></div>
            </div>
            <Ledger data={d} />
          </>
        )}</Async>
      )}
    </>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useApp, useLive } from '../app/AppLayout';
import { qs } from '../lib/api';
import { useFmt, useShop } from '../lib/context';
import { addDays, endOfMonth, fmtMinutes, startOfMonth, startOfWeek, weekdayOf } from '../../../shared/time';
import { Icon } from './Icon';
import { ErrorState } from './ui';
import { tr } from '../lib/i18n';

type View = 'day' | 'week' | 'month';
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOUR = 68;

/** Unified calendar of online and manual appointments. `scope="me"` pins it to the signed-in barber's chair. */
export function Calendar({ scope }: { scope: 'me' | 'shop' }) {
  const { team, openAppointment, newAppointment } = useApp();
  const { shop } = useShop();
  const fmt = useFmt();
  const today = fmt.today();
  const [view, setView] = useState<View>(() => (window.innerWidth < 760 && scope === 'shop' ? 'day' : scope === 'me' ? 'day' : 'day'));
  const [date, setDate] = useState(today);
  const [barber, setBarber] = useState<'all' | number>('all');
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const range = view === 'day' ? [date, date] : view === 'week' ? [startOfWeek(date), addDays(startOfWeek(date), 6)] : [startOfWeek(startOfMonth(date)), addDays(startOfWeek(endOfMonth(date)), 6)];
  const barberParam = scope === 'me' ? 'me' : barber === 'all' ? undefined : barber;
  const state = useLive<{ appointments: any[] }>(`/staff/appointments${qs({ from: range[0], to: range[1], barber: barberParam })}`);
  const appts = state.data?.appointments ?? [];
  const byDay = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const a of appts) {
      const d = fmt.dayOf(a.starts_at);
      m.set(d, [...(m.get(d) ?? []), a]);
    }
    return m;
  }, [appts, fmt]);

  const step = (dir: number) => setDate(view === 'day' ? addDays(date, dir) : view === 'week' ? addDays(date, 7 * dir) : startOfMonth(addDays(dir > 0 ? endOfMonth(date) : startOfMonth(date), dir)));
  const title = view === 'day' ? fmt.date(date, 'long') : view === 'week' ? `${fmt.date(range[0], 'short')} – ${fmt.date(range[1], 'medium').replace(/^\w+,? /, '')}`
    : fmt.monthYear(date);

  const columns = scope === 'me' ? team.barbers.filter((b) => b.id === team.my_barber_id)
    : team.barbers.filter((b) => (barber === 'all' ? b.is_active || appts.some((a) => a.barber_id === b.id) : b.id === barber));

  // Visible hours: an hour either side of the widest opening hours, stretched to fit any appointment.
  const open = shop.business_hours.filter((h) => !h.is_closed);
  let fromMin = Math.min(9 * 60, ...open.map((h) => h.open_min)) - 60, toMin = Math.max(18 * 60, ...open.map((h) => h.close_min)) + 60;
  for (const a of byDay.get(date) ?? []) {
    fromMin = Math.min(fromMin, fmt.minutesOf(a.starts_at));
    toMin = Math.max(toMin, fmt.minutesOf(a.starts_at) + a.duration_min);
  }
  fromMin = Math.max(0, Math.floor(fromMin / 60) * 60);
  toMin = Math.min(1440, Math.ceil(toMin / 60) * 60);
  const px = (min: number) => ((min - fromMin) / 60) * HOUR;
  const shopDay = shop.business_hours.find((h) => h.weekday === weekdayOf(date));
  const nowMin = date === today ? fmt.minutesOf(Date.now()) : null;

  const chip = (a: any, showBarber: boolean) => (
    <button key={a.id} className={`cal-ev ${a.status}`} onClick={(e) => { e.stopPropagation(); openAppointment(a.id); }} title={`${fmt.time(a.starts_at)} ${a.customer_name} — ${a.services}`}>
      <b><span className="num">{fmt.time(a.starts_at)}</span> {a.customer_name}</b>
      <span>{a.services}{showBarber ? ` · ${a.barber_name.split(' ')[0]}` : ''}</span>
      {a.status === 'completed' && a.balance_minor > 0 && <i className="due" title={tr("Not fully paid")} />}
    </button>
  );

  return (
    <div>
      <div className="cal-head">
        <div className="seg" role="group" aria-label={tr("Calendar view")}>
          {(['day', 'week', 'month'] as View[]).map((v) => <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>{tr(v)}</button>)}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => setDate(today)}>{tr("Today")}</button>
        <button className="icon-btn" aria-label={tr("Previous")} onClick={() => step(-1)}><Icon name="left" /></button>
        <button className="icon-btn" aria-label={tr("Next")} onClick={() => step(1)}><Icon name="right" /></button>
        <h2>{title}</h2>
        <span className="grow" />
        {scope === 'shop' && (
          <select className="select" style={{ width: 'auto', minHeight: 38, paddingTop: 6, paddingBottom: 6 }} value={barber} aria-label={tr("Filter by barber")} onChange={(e) => setBarber(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            <option value="all">{tr("All barbers")}</option>
            {team.barbers.map((b) => <option key={b.id} value={b.id}>{b.name}{b.is_active ? '' : (" (" + tr("inactive)"))}</option>)}
          </select>
        )}
        <input type="date" className="input" style={{ width: 'auto', minHeight: 38, paddingTop: 6, paddingBottom: 6 }} value={date} aria-label={tr("Go to date")} onChange={(e) => e.target.value && setDate(e.target.value)} />
      </div>

      {state.error && !state.data ? <ErrorState error={state.error} retry={state.reload} /> : (
        <div className="card table-wrap" style={{ opacity: state.loading && !state.data ? 0.5 : 1 }}>
          {view === 'day' && (
            <div className="cal-day" style={{ ['--cols' as any]: Math.max(1, columns.length), ['--hour' as any]: `${HOUR}px` }}>
              <div className="cal-colhead" style={{ borderLeft: 0 }} />
              {columns.map((b) => {
                const n = (byDay.get(date) ?? []).filter((a) => a.barber_id === b.id && !['cancelled', 'no_show'].includes(a.status)).length;
                return <div className="cal-colhead" key={b.id}>{b.name}<small>{n || 'no'} {tr("appt")}{n === 1 ? '' : 's'}</small></div>;
              })}
              <div className="cal-times" style={{ height: px(toMin) }}>
                {Array.from({ length: (toMin - fromMin) / 60 }, (_, i) => i > 0 && <span key={i} style={{ top: i * HOUR }}>{fmtMinutes(fromMin + i * 60)}</span>)}
              </div>
              {columns.map((b) => (
                <div className="cal-col" key={b.id} style={{ height: px(toMin) }} title={tr("Click an empty time to add an appointment")}
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const minutes = Math.round((fromMin + ((e.clientY - rect.top) / HOUR) * 60) / 15) * 15;
                    newAppointment({ barberId: b.id, date, minutes });
                  }}>
                  {(!shopDay || shopDay.is_closed) ? <div className="cal-off" style={{ top: 0, bottom: 0 }} /> : (
                    <>
                      <div className="cal-off" style={{ top: 0, height: px(shopDay.open_min) }} />
                      <div className="cal-off" style={{ top: px(shopDay.close_min), bottom: 0 }} />
                    </>
                  )}
                  {nowMin != null && nowMin > fromMin && nowMin < toMin && <div className="cal-now" style={{ top: px(nowMin) }} />}
                  {(byDay.get(date) ?? []).filter((a) => a.barber_id === b.id).map((a) => {
                    const dead = ['cancelled', 'no_show'].includes(a.status);
                    return (
                      <button key={a.id} className={`cal-ev ${a.status}`} style={{ top: px(fmt.minutesOf(a.starts_at)) + 1, height: Math.max(22, (a.duration_min / 60) * HOUR - 2), ...(dead ? { left: '55%' } : {}) }}
                        onClick={(e) => { e.stopPropagation(); openAppointment(a.id); }} title={`${fmt.time(a.starts_at)}–${fmt.time(a.ends_at)} ${a.customer_name} — ${a.services}`}>
                        <b>{a.customer_name}</b>
                        {a.duration_min >= 30 && <span><span className="num">{fmt.time(a.starts_at)}</span> · {a.services}</span>}
                        {a.status === 'completed' && a.balance_minor > 0 && <i className="due" title={tr("Not fully paid")} />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {view === 'week' && (
            <div className="cal-week">
              {Array.from({ length: 7 }, (_, i) => addDays(range[0], i)).map((d, i) => (
                <div key={d} className={d === today ? 'today' : ''}>
                  <button className="dh" onClick={() => { setDate(d); setView('day'); }} title={tr("Open day view")}><small>{tr(WD[i])}</small><b>{Number(d.slice(8))}</b></button>
                  <div className="list">
                    {(byDay.get(d) ?? []).map((a) => chip(a, scope === 'shop' && barber === 'all'))}
                    {!(byDay.get(d) ?? []).length && <span className="muted" style={{ fontSize: 12, padding: 6 }}>—</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {view === 'month' && (
            <div className="cal-month">
              {WD.map((w) => <div className="wd" key={w}>{tr(w)}</div>)}
              {Array.from({ length: Math.round((Date.parse(range[1]) - Date.parse(range[0])) / 86_400_000) + 1 }, (_, i) => addDays(range[0], i)).map((d) => {
                const list = (byDay.get(d) ?? []).filter((a) => a.status !== 'cancelled');
                return (
                  <button key={d} className={`cal-cell ${d.slice(0, 7) !== date.slice(0, 7) ? 'out' : ''} ${d === today ? 'today' : ''}`} onClick={() => { setDate(d); setView('day'); }} aria-label={`${fmt.date(d, 'long')}, ${list.length} ${tr("appointments")}`}>
                    <span className="n"><span>{Number(d.slice(8))}</span>{list.length > 0 && <small>{list.length}</small>}</span>
                    {list.slice(0, 3).map((a) => <span key={a.id} className={`mini ${a.status}`}><span className="num">{fmt.time(a.starts_at)}</span> {a.customer_name}</span>)}
                    {list.length > 3 && <span className="mini" style={{ borderColor: 'transparent' }}>+{list.length - 3} {tr("more")}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      <div className="legend" style={{ marginTop: 12 }}>
        <span><i style={{ background: 'var(--warn-bg)', outline: '1px solid var(--warn)' }} />{tr("Pending")}</span>
        <span><i style={{ background: 'var(--info-bg)', outline: '1px solid var(--info)' }} />{tr("Confirmed")}</span>
        <span><i style={{ background: 'var(--ink)' }} />{tr("In the shop")}</span>
        <span><i style={{ background: 'var(--ok-bg)', outline: '1px solid var(--ok)' }} />{tr("Completed")}</span>
        <span><i style={{ background: 'var(--bad)', borderRadius: '50%' }} />{tr("Completed, balance due")}</span>
      </div>
    </div>
  );
}

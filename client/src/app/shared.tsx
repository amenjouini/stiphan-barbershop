import { useMemo, useState, type ReactNode } from 'react';
import { Icon } from '../components/Icon';
import { Empty, Field, Modal, Notice, useAction } from '../components/ui';
import { api } from '../lib/api';
import { useFmt } from '../lib/context';
import { addDays, fmtMinutes, parseMinutes, startOfMonth, startOfWeek } from '../../../shared/time';
import { useApp, useLive } from './AppLayout';
import { tr } from '../lib/i18n';

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
      {children && <div className="row fw">{children}</div>}
    </header>
  );
}

export type Preset = 'today' | 'week' | 'month' | 'last30' | 'custom';
export interface Range { from: string; to: string; preset: Preset }

/** Date-range state with the presets used across the money screens. */
export function useRange(initial: Preset = 'month') {
  const fmt = useFmt();
  const today = fmt.today();
  const make = (preset: Preset, cur?: Range): Range =>
    preset === 'today' ? { from: today, to: today, preset }
    : preset === 'week' ? { from: startOfWeek(today), to: today, preset }
    : preset === 'month' ? { from: startOfMonth(today), to: today, preset }
    : preset === 'last30' ? { from: addDays(today, -29), to: today, preset }
    : { from: cur?.from ?? startOfMonth(today), to: cur?.to ?? today, preset };
  const [range, setRange] = useState<Range>(() => make(initial));
  return { range, setPreset: (p: Preset) => setRange((cur) => make(p, cur)), setRange, today };
}

export function RangePicker({ ctl }: { ctl: ReturnType<typeof useRange> }) {
  const { range, setPreset, setRange, today } = ctl;
  const presets: [Preset, string][] = [['today', tr("Today")], ['week', tr("This week")], ['month', tr("This month")], ['last30', tr('30 days')], ['custom', tr("Custom")]];
  return (
    <div className="row fw">
      <div className="seg" role="group" aria-label={tr("Period")}>
        {presets.map(([p, label]) => <button key={p} aria-pressed={range.preset === p} onClick={() => setPreset(p)}>{label}</button>)}
      </div>
      {range.preset === 'custom' && (
        <div className="row">
          <input type="date" className="input" style={{ width: 'auto', minHeight: 38, padding: '6px 10px' }} aria-label={tr("From")} value={range.from} max={range.to} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} />
          <span className="muted">{tr("to")}</span>
          <input type="date" className="input" style={{ width: 'auto', minHeight: 38, padding: '6px 10px' }} aria-label={tr("To")} value={range.to} min={range.from} max={today} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} />
        </div>
      )}
    </div>
  );
}

export const rangeQuery = (r: Range) => `from=${r.from}&to=${r.to}`;

/** Days off, holidays and blocked time. `barberId` undefined = everything (owner view); null entries are shop-wide. */
export function TimeOffCard({ barberId, allowShopWide }: { barberId?: number; allowShopWide?: boolean }) {
  const fmt = useFmt();
  const { touch, team } = useApp();
  const state = useLive<{ time_off: any[] }>(`/staff/time-off${barberId ? `?barber=${barberId}` : ''}`);
  const [adding, setAdding] = useState(false);
  const act = useAction();
  const rows = state.data?.time_off ?? [];
  return (
    <div className="card">
      <div className="card-head"><h2>{tr("Days off & blocked time")}</h2><button className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} />{tr("Block time")}</button></div>
      {rows.length ? (
        <div className="table-wrap"><table className="table"><tbody>
          {rows.map((t) => {
            const fullDays = fmt.minutesOf(t.starts_at) === 0 && fmt.minutesOf(t.ends_at) === 0;
            const last = fullDays ? fmt.dayOf(t.ends_at - 1) : fmt.dayOf(t.ends_at);
            return (
              <tr key={t.id}>
                <td><b>{fullDays ? (fmt.dayOf(t.starts_at) === last ? fmt.date(fmt.dayOf(t.starts_at), 'medium') : `${fmt.date(fmt.dayOf(t.starts_at), 'short')} – ${fmt.date(last, 'medium')}`) : `${fmt.dateTime(t.starts_at)} – ${fmt.time(t.ends_at)}`}</b>
                  <span className="sub">{t.reason || tr("No reason given")}</span></td>
                <td><span className={`badge plain ${t.barber_id ? '' : 'dark'}`}>{t.barber_id ? (barberId ? (t.kind === 'blocked' ? tr("Blocked") : tr("Day off")) : t.barber_name) : tr("Whole shop")}</span></td>
                <td className="r">{(t.barber_id || allowShopWide) && <button className="icon-btn" aria-label={tr("Remove")} title={tr("Remove")} disabled={act.busy} onClick={() => act.run(async () => { await api(`/staff/time-off/${t.id}`, { method: 'DELETE' }); touch(); }, tr("Removed."))}><Icon name="x" size={16} /></button>}</td>
              </tr>
            );
          })}
        </tbody></table></div>
      ) : <Empty icon="block" title={tr("Nothing blocked.")}>{tr("Add a day off, a holiday or a blocked hour and it disappears from online booking immediately.")}</Empty>}
      {adding && <TimeOffModal barberId={barberId} allowShopWide={allowShopWide} barbers={team.barbers} onClose={() => setAdding(false)} />}
    </div>
  );
}

function TimeOffModal({ barberId, allowShopWide, barbers, onClose }: { barberId?: number; allowShopWide?: boolean; barbers: { id: number; name: string; is_active: number }[]; onClose: () => void }) {
  const fmt = useFmt();
  const { touch } = useApp();
  const act = useAction();
  const [who, setWho] = useState<string>(barberId ? String(barberId) : allowShopWide ? 'shop' : String(barbers[0]?.id ?? ''));
  const [partial, setPartial] = useState(false);
  const [from, setFrom] = useState(addDays(fmt.today(), 1));
  const [to, setTo] = useState('');
  const [start, setStart] = useState('12:00');
  const [end, setEnd] = useState('13:00');
  const [reason, setReason] = useState('');
  const [conflicts, setConflicts] = useState<string[] | null>(null);
  const body = useMemo(() => ({
    barber_id: who === 'shop' ? null : Number(who), kind: who === 'shop' ? 'holiday' : partial ? 'blocked' : 'day_off',
    from_date: from, to_date: partial ? undefined : to || undefined,
    start_min: partial ? parseMinutes(start) ?? undefined : undefined, end_min: partial ? parseMinutes(end) ?? undefined : undefined, reason: reason.trim() || undefined,
  }), [who, partial, from, to, start, end, reason]);
  if (conflicts) {
    return (
      <Modal title={tr("Time blocked")} onClose={onClose} footer={<button className="btn btn-dark" onClick={onClose}>{tr("Done")}</button>}>
        {conflicts.length ? <Notice icon="alert">{conflicts.length} {tr("existing")}{' '}{conflicts.length === 1 ? 'appointment overlaps' : 'appointments overlap'} {tr("this time and")}{' '}{conflicts.length === 1 ? 'was' : 'were'} <b>{tr("not")}</b> {tr("cancelled:")}{' '}{conflicts.join(', ')}{". "}{tr("Reschedule or cancel")}{' '}{conflicts.length === 1 ? 'it' : 'them'} {tr("from the calendar.")}</Notice>
          : <Notice tone="ok" icon="check">{tr("No existing appointments were affected. The time is no longer bookable.")}</Notice>}
      </Modal>
    );
  }
  return (
    <Modal title={tr("Block time")} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>{tr("Discard")}</button>
      <button className="btn btn-dark" disabled={act.busy || !from || !who} onClick={() => act.run(async () => { const r = await api('/staff/time-off', { body }); touch(); setConflicts(r.conflicts); })}>{tr("Block")}</button>
    </>}>
      <div className="stack">
        {act.error && <Notice tone="bad" icon="alert">{act.error}</Notice>}
        {!barberId && (
          <Field label={tr("Applies to")}>
            <select className="select" value={who} onChange={(e) => setWho(e.target.value)}>
              {allowShopWide && <option value="shop">{tr("Whole shop (holiday / closure)")}</option>}
              {barbers.filter((b) => b.is_active).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
        )}
        {who !== 'shop' && (
          <div className="seg" style={{ justifySelf: 'start' }}>
            <button aria-pressed={!partial} onClick={() => setPartial(false)}>{tr("Full day(s)")}</button>
            <button aria-pressed={partial} onClick={() => setPartial(true)}>{tr("Part of a day")}</button>
          </div>
        )}
        <div className="form-grid cols-2">
          <Field label={partial ? tr("Date") : tr("From")}><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          {!partial && <Field label={tr("Until (optional)")}><input type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>}
          {partial && <div className="form-grid cols-2">
            <Field label={tr("From")}><input type="time" className="input" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
            <Field label={tr("To")}><input type="time" className="input" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
          </div>}
        </div>
        <Field label={tr("Reason (optional)")}><input className="input" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder={tr("Holiday, training, supplier visit…")} /></Field>
      </div>
    </Modal>
  );
}

export const hhmm = fmtMinutes;

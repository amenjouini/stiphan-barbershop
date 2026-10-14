import { useEffect, useMemo, useState } from 'react';
import { qs, useApi } from '../lib/api';
import { useFmt, useShop } from '../lib/context';
import { useT, tr } from '../lib/i18n';
import { addDays } from '../../../shared/time';
import { Icon } from './Icon';
import { Empty, ErrorState, Loading } from './ui';

const PAGE = 14;

interface Props {
  serviceIds: number[];
  barber: number | 'any';
  value: number | null;
  onChange: (start: number | null) => void;
  /** Staff mode skips lead time/horizon and lets any date be picked. */
  staff?: boolean;
  excludeId?: number;
  initialDate?: string;
}

/** Date strip + genuinely available time slots, loaded from the server for the chosen services and barber. */
export function SlotPicker({ serviceIds, barber, value, onChange, staff, excludeId, initialDate }: Props) {
  const fmt = useFmt();
  const { t, lang } = useT();
  const { shop } = useShop();
  const today = fmt.today();
  const horizonEnd = addDays(today, shop.settings.horizon_days);
  const [from, setFrom] = useState(initialDate && staff ? initialDate : today);
  const [date, setDate] = useState<string | null>(initialDate ?? null);
  const services = serviceIds.join(',');

  const dayList = useMemo(() => Array.from({ length: PAGE }, (_, i) => addDays(from, i)).filter((d) => staff || d <= horizonEnd), [from, staff, horizonEnd]);
  const daysState = useApi<{ days: Record<string, number> }>(!staff && services ? `/public/availability/days${qs({ from, days: PAGE, services, barber })}` : null);
  const counts = daysState.data?.days;

  // Public: jump to the first day that actually has a free slot.
  useEffect(() => {
    if (staff || !counts) return;
    if (date && date >= from && date <= addDays(from, PAGE - 1) && counts[date] > 0) return;
    const first = dayList.find((d) => counts[d] > 0) ?? null;
    setDate(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counts]);
  useEffect(() => {
    if (staff && !date) setDate(from);
  }, [staff, date, from]);

  const slotsPath = date && services ? `${staff ? '/staff' : '/public'}/availability${qs({ date, services, barber, exclude: excludeId })}` : null;
  const slotsState = useApi<{ slots: { start: number; barbers: number }[] }>(slotsPath);
  const slots = slotsState.data?.slots ?? [];

  // Drop a selection that is no longer offered (other date, taken meanwhile...).
  useEffect(() => {
    if (value && slotsState.data && !slots.some((s) => s.start === value)) onChange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotsState.data]);

  const groups = useMemo(() => {
    const g: [string, typeof slots][] = [[tr("Morning"), []], [tr("Afternoon"), []], [tr("Evening"), []]];
    for (const s of slots) {
      const m = fmt.minutesOf(s.start);
      g[m < 720 ? 0 : m < 1020 ? 1 : 2][1].push(s);
    }
    return g.filter(([, list]) => list.length);
  }, [slots, fmt]);

  const canPrev = staff || from > today;
  const canNext = staff || addDays(from, PAGE) <= horizonEnd;

  return (
    <div className="slot-picker">
      <div className="days-nav">
        <strong>{fmt.date(from, 'short')} – {fmt.date(dayList[dayList.length - 1] ?? from, 'short')}</strong>
        <div className="row">
          {staff && <input type="date" className="input" style={{ minHeight: 36, padding: '4px 8px', width: 150 }} value={date ?? ''} aria-label={tr("Jump to date")}
            onChange={(e) => { if (e.target.value) { setFrom(e.target.value); setDate(e.target.value); onChange(null); } }} />}
          <button type="button" className="icon-btn flip" disabled={!canPrev} aria-label={t('Earlier dates')} onClick={() => { const f = addDays(from, -PAGE); setFrom(!staff && f < today ? today : f); }}><Icon name="left" /></button>
          <button type="button" className="icon-btn flip" disabled={!canNext} aria-label={t('Later dates')} onClick={() => setFrom(addDays(from, PAGE))}><Icon name="right" /></button>
        </div>
      </div>
      <div className="days" role="group" aria-label={t('Choose a date')}>
        {dayList.map((d) => {
          const n = counts?.[d];
          const disabled = !staff && (counts ? !n : true);
          return (
            <button type="button" key={d} className="day" disabled={disabled} aria-pressed={date === d} onClick={() => { setDate(d); onChange(null); }}
              aria-label={`${fmt.date(d, 'long')}${staff ? '' : n ? `, ${t('{n} times available', { n })}` : `, ${t('no availability')}`}`}>
              <small>{d === today ? (lang === 'fr' ? 'Auj.' : t('Today')) : fmt.dow(d)}</small>
              <b>{Number(d.slice(8))}</b>
              <i>{fmt.month(d)}</i>
            </button>
          );
        })}
      </div>

      {!staff && daysState.error && <ErrorState error={daysState.error} retry={daysState.reload} />}
      {!date && !staff && counts && (
        <Empty icon="calendar" title={t('Nothing free in these two weeks.')}>{barber !== 'any' ? t('Try later dates or another barber.') : t('Try later dates.')}</Empty>
      )}
      {date && (
        slotsState.loading && !slotsState.data ? <Loading label={tr("Checking availability")} />
        : slotsState.error ? <ErrorState error={slotsState.error} retry={slotsState.reload} />
        : !slots.length ? <Empty icon="clock" title={t('No free times on this day.')}>{staff ? tr("The chair is fully booked, closed or off on this date.") : t('Pick another date above.')}</Empty>
        : groups.map(([label, list]) => (
          <div className="slot-group" key={label}>
            <h4>{t(label)}</h4>
            <div className="slots">
              {list.map((s) => (
                <button type="button" key={s.start} className="slot" aria-pressed={value === s.start} onClick={() => onChange(s.start)}>{fmt.time(s.start)}</button>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

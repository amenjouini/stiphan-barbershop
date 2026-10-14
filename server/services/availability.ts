import { all, get, marks } from '../db.ts';
import { getSettings } from '../lib/settings.ts';
import { addDays, today, weekdayOf, zoned, zonedToUtc } from '../../shared/time.ts';

type Interval = [number, number];
const MIN = 60_000;

export interface SlotOptions {
  /** Staff bookings skip lead time, horizon and the slot grid. */
  staff?: boolean;
  /** Ignore the appointment being rescheduled when checking overlaps. */
  excludeAppointmentId?: number;
  now?: number;
}

function subtract(base: Interval[], cuts: Interval[]): Interval[] {
  let out = base;
  for (const [cs, ce] of cuts) {
    const next: Interval[] = [];
    for (const [s, e] of out) {
      if (ce <= s || cs >= e) next.push([s, e]);
      else {
        if (cs > s) next.push([s, cs]);
        if (ce < e) next.push([ce, e]);
      }
    }
    out = next;
  }
  return out;
}

/** Converts minutes after local midnight on `date` to UTC ms (DST-safe). */
function dayClock(date: string, tz: string) {
  const start = zonedToUtc(date, 0, tz);
  const regular = zonedToUtc(addDays(date, 1), 0, tz) - start === 1440 * MIN;
  return (minutes: number) => (regular ? start + minutes * MIN : zonedToUtc(date, minutes, tz));
}

/**
 * Bookable windows for a barber on a local date:
 * working hours ∩ shop hours − breaks − time off / holidays.
 */
export function workWindows(barberId: number, date: string): Interval[] {
  const tz = getSettings().timezone;
  const wd = weekdayOf(date);
  const shop = get<any>('SELECT open_min, close_min, is_closed FROM business_hours WHERE weekday = ?', wd);
  if (!shop || shop.is_closed) return [];
  const at = dayClock(date, tz);
  const hours = all<any>('SELECT start_min, end_min FROM working_hours WHERE barber_id = ? AND weekday = ? ORDER BY start_min', barberId, wd);
  let windows: Interval[] = [];
  for (const hrow of hours) {
    const s = Math.max(hrow.start_min, shop.open_min), e = Math.min(hrow.end_min, shop.close_min);
    if (s < e) windows.push([at(s), at(e)]);
  }
  if (!windows.length) return [];
  const breaks = all<any>('SELECT start_min, end_min FROM breaks WHERE barber_id = ? AND weekday = ?', barberId, wd);
  windows = subtract(windows, breaks.map((b) => [at(b.start_min), at(b.end_min)] as Interval));
  const dayStart = at(0), dayEnd = zonedToUtc(addDays(date, 1), 0, tz);
  const off = all<any>(
    'SELECT starts_at, ends_at FROM time_off WHERE (barber_id = ? OR barber_id IS NULL) AND starts_at < ? AND ends_at > ?',
    barberId, dayEnd, dayStart,
  );
  return subtract(windows, off.map((o) => [o.starts_at, o.ends_at] as Interval));
}

function busy(barberId: number, from: number, to: number, excludeId?: number): Interval[] {
  return all<any>(
    `SELECT starts_at, blocked_until FROM appointments
     WHERE barber_id = ? AND status NOT IN ('cancelled','no_show') AND starts_at < ? AND blocked_until > ? AND id <> ?`,
    barberId, to, from, excludeId ?? 0,
  ).map((a) => [a.starts_at, a.blocked_until] as Interval);
}

/** Start times (UTC ms) a barber can take for a service of `durationMin` on a local date. */
export function barberSlots(barberId: number, date: string, durationMin: number, opts: SlotOptions = {}): number[] {
  const s = getSettings();
  const now = opts.now ?? Date.now();
  const todayStr = today(s.timezone, now);
  if (!opts.staff && (date < todayStr || date > addDays(todayStr, s.horizon_days))) return [];
  const windows = workWindows(barberId, date);
  if (!windows.length) return [];
  const at = dayClock(date, s.timezone);
  const taken = busy(barberId, at(0), at(1440) + 480 * MIN, opts.excludeAppointmentId);
  const earliest = opts.staff ? 0 : now + s.lead_time_min * MIN;
  const dur = durationMin * MIN, buffer = s.buffer_min * MIN;
  const out: number[] = [];
  for (let m = 0; m < 1440; m += s.slot_interval_min) {
    const start = at(m), end = start + dur;
    if (start < earliest) continue;
    if (!windows.some(([ws, we]) => start >= ws && end <= we)) continue;
    if (taken.some(([bs, be]) => start < be && end + buffer > bs)) continue;
    out.push(start);
  }
  return out;
}

export type FreeCheck = { ok: true } | { ok: false; reason: 'OUTSIDE_HOURS' | 'SLOT_TAKEN' };

/** Validates one exact start time for a barber (used for staff bookings at arbitrary minutes). */
export function checkFree(barberId: number, start: number, durationMin: number, opts: SlotOptions & { ignoreHours?: boolean } = {}): FreeCheck {
  const s = getSettings();
  const end = start + durationMin * MIN;
  if (!opts.ignoreHours) {
    const date = zoned(start, s.timezone).date;
    if (!workWindows(barberId, date).some(([ws, we]) => start >= ws && end <= we)) return { ok: false, reason: 'OUTSIDE_HOURS' };
  }
  if (busy(barberId, start, end + s.buffer_min * MIN, opts.excludeAppointmentId).length) return { ok: false, reason: 'SLOT_TAKEN' };
  return { ok: true };
}

/** Active barbers who offer every one of the given services. */
export function eligibleBarbers(serviceIds: number[]): { id: number; name: string; sort_order: number }[] {
  if (!serviceIds.length) return [];
  return all(
    `SELECT b.id, b.name, b.sort_order FROM barbers b
     WHERE b.is_active = 1 AND (SELECT COUNT(*) FROM barber_services bs WHERE bs.barber_id = b.id AND bs.service_id IN (${marks(serviceIds.length)})) = ?
     ORDER BY b.sort_order, b.id`,
    ...serviceIds, serviceIds.length,
  );
}

export interface Slot { start: number; barberIds: number[] }

export function slotsFor(date: string, serviceIds: number[], barber: number | 'any', durationMin: number, opts: SlotOptions = {}): Slot[] {
  let barbers = eligibleBarbers(serviceIds);
  if (barber !== 'any') barbers = barbers.filter((b) => b.id === barber);
  const byStart = new Map<number, number[]>();
  for (const b of barbers) {
    for (const start of barberSlots(b.id, date, durationMin, opts)) {
      const list = byStart.get(start);
      if (list) list.push(b.id);
      else byStart.set(start, [b.id]);
    }
  }
  return [...byStart.entries()].sort((a, b) => a[0] - b[0]).map(([start, barberIds]) => ({ start, barberIds }));
}

/**
 * "Any available barber": among the barbers genuinely free at `start`, pick
 * the one with the lightest day so work is spread fairly (ties: display order).
 */
export function pickBarber(candidateIds: number[], start: number): number | null {
  if (!candidateIds.length) return null;
  const tz = getSettings().timezone;
  const date = zoned(start, tz).date;
  const from = zonedToUtc(date, 0, tz), to = zonedToUtc(addDays(date, 1), 0, tz);
  const ranked = all<any>(
    `SELECT b.id, b.sort_order,
       (SELECT COUNT(*) FROM appointments a WHERE a.barber_id = b.id AND a.status NOT IN ('cancelled','no_show') AND a.starts_at >= ? AND a.starts_at < ?) AS load
     FROM barbers b WHERE b.id IN (${marks(candidateIds.length)})
     ORDER BY load, b.sort_order, b.id`,
    from, to, ...candidateIds,
  );
  return ranked[0]?.id ?? null;
}

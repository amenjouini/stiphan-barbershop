// Timezone helpers shared by server and client. All instants are UTC epoch
// milliseconds; "local" always means the shop's configured IANA timezone.

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function partsFmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface ZonedParts { date: string; minutes: number; weekday: number; y: number; m: number; d: number; hh: number; mm: number; ss: number }

export function zoned(ms: number, tz: string): ZonedParts {
  const p: Record<string, number> = {};
  for (const part of partsFmt(tz).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  return {
    date, minutes: p.hour * 60 + p.minute, weekday: weekdayOf(date),
    y: p.year, m: p.month, d: p.day, hh: p.hour, mm: p.minute, ss: p.second,
  };
}

function offsetMs(ms: number, tz: string) {
  const p = zoned(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(ms / 1000) * 1000;
}

/** Local wall-clock (date + minutes after midnight) in `tz` -> UTC ms. */
export function zonedToUtc(date: string, minutes: number, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const off = offsetMs(guess, tz);
  let ts = guess - off;
  const off2 = offsetMs(ts, tz);
  if (off2 !== off) ts = guess - off2;
  return ts;
}

export function isDate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}

export function today(tz: string, now = Date.now()): string {
  return zoned(now, tz).date;
}

/** Monday of the week containing `date`. */
export function startOfWeek(date: string): string {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

export function startOfMonth(date: string): string {
  return date.slice(0, 8) + '01';
}

export function endOfMonth(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function fmtMinutes(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

export function parseMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v <= 1440 ? v : null;
}

export function fmtTime(ms: number, tz: string): string {
  return fmtMinutes(zoned(ms, tz).minutes);
}

export function fmtDate(msOrDate: number | string, tz: string, style: 'long' | 'medium' | 'short' = 'medium', locale = 'en-GB'): string {
  const ms = typeof msOrDate === 'string' ? Date.parse(msOrDate + 'T12:00:00Z') : msOrDate;
  const zone = typeof msOrDate === 'string' ? 'UTC' : tz;
  const opts: Intl.DateTimeFormatOptions =
    style === 'long' ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
    : style === 'medium' ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }
    : { day: 'numeric', month: 'short' };
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: zone }).format(new Date(ms));
}

export function fmtDateTime(ms: number, tz: string, locale = 'en-GB'): string {
  return `${fmtDate(ms, tz, 'medium', locale)} · ${fmtTime(ms, tz)}`;
}

export function fmtDuration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), r = min % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

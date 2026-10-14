// Money is always an integer number of minor units (millimes for TND, cents
// for EUR...). Parsing and formatting use string arithmetic, never floats.

/** "25", "25.5", "25,500" -> minor units, or null when not a valid amount. */
export function toMinor(input: string | number, decimals: number): number | null {
  const s = String(input).trim().replace(',', '.');
  const m = /^(-)?(\d{1,9})(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = m[3] ?? '';
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) return null;
  const minor = Number(m[2]) * 10 ** decimals + Number((frac + '0'.repeat(decimals)).slice(0, decimals) || 0);
  return m[1] ? -minor : minor;
}

/** Minor units -> plain decimal string, e.g. 25500 -> "25.500". */
export function fromMinor(minor: number, decimals: number): string {
  const neg = minor < 0;
  const abs = Math.abs(Math.trunc(minor));
  const base = 10 ** decimals;
  const int = Math.floor(abs / base);
  const frac = decimals ? '.' + String(abs % base).padStart(decimals, '0') : '';
  return `${neg ? '-' : ''}${int}${frac}`;
}

export function formatMoney(minor: number, currency: string, decimals: number): string {
  const plain = fromMinor(Math.abs(minor), decimals);
  const [int, frac] = plain.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${minor < 0 ? '−' : ''}${grouped}${frac ? '.' + frac : ''} ${currency}`;
}

/** amount * bps / 10000, rounded half-up, integer math only. */
export function applyBps(amountMinor: number, bps: number): number {
  return Math.floor((amountMinor * bps + 5000) / 10000);
}

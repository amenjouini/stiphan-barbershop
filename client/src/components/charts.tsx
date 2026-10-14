import { useEffect, useRef, useState, type ReactNode } from 'react';
import { tr } from '../lib/i18n';

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Rounds the axis maximum up to a clean step so gridlines land on readable numbers. */
function niceMax(v: number) {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
}

export interface Series { key: string; label: string; color: string }

/**
 * Column chart for one or two series on a single shared axis. Bars are
 * baseline-anchored with rounded tops; hovering a column shows exact values.
 */
export function ColumnChart({ data, series, format, height = 220, tickFormat }: {
  data: { label: string; title?: string; [k: string]: number | string | undefined }[];
  series: Series[];
  format: (v: number) => string;
  tickFormat?: (v: number) => string;
  height?: number;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 46, r: 8, t: 10, b: 24 };
  const iw = width - pad.l - pad.r, ih = height - pad.t - pad.b;
  const max = niceMax(Math.max(0, ...data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0))));
  const band = iw / Math.max(1, data.length);
  const bw = Math.max(2, Math.min(18, (band * 0.7 - (series.length - 1) * 2) / series.length));
  const y = (v: number) => pad.t + ih - (Math.max(0, v) / max) * ih;
  const every = Math.ceil(data.length / Math.max(2, Math.floor(iw / 52)));
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const tf = tickFormat ?? format;
  const h = hover != null ? data[hover] : null;

  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      {series.length > 1 && <div className="chart-legend" style={{ marginBottom: 10 }}>{series.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}</div>}
      <svg width={width} height={height} role="img" aria-label={`${series.map((s) => s.label).join(' and ')} ${tr("per day")}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="gridline" x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} />
            <text className="axis" x={pad.l - 8} y={y(t) + 3.5} textAnchor="end">{tf(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x0 = pad.l + i * band + (band - (bw * series.length + 2 * (series.length - 1))) / 2;
          return (
            <g key={i}>
              <rect className={`hit ${hover === i ? 'on' : ''}`} x={pad.l + i * band} y={pad.t} width={band} height={ih} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0}
                aria-label={`${d.title ?? d.label}: ${series.map((s) => `${s.label} ${format(Number(d[s.key]) || 0)}`).join(', ')}`} />
              {series.map((s, k) => {
                const v = Number(d[s.key]) || 0;
                if (v <= 0) return null;
                const top = y(v), bh = pad.t + ih - top, r = Math.min(4, bw / 2, bh);
                const x = x0 + k * (bw + 2);
                return <path key={s.key} fill={s.color} pointerEvents="none" d={`M${x},${pad.t + ih}V${top + r}q0,${-r} ${r},${-r}h${bw - 2 * r}q${r},0 ${r},${r}V${pad.t + ih}z`} />;
              })}
              {i % every === 0 && <text className="axis" x={pad.l + i * band + band / 2} y={height - 6} textAnchor="middle">{d.label}</text>}
            </g>
          );
        })}
      </svg>
      {h && hover != null && (
        <div className="chart-tip" style={{ left: Math.min(width - 80, Math.max(80, pad.l + hover * band + band / 2)), top: Math.max(54, y(Math.max(...series.map((s) => Number(h[s.key]) || 0))) - 6) }}>
          <b>{h.title ?? h.label}</b>
          {series.map((s) => <div key={s.key}><span><i style={{ background: s.color }} />{s.label}</span><span>{format(Number(h[s.key]) || 0)}</span></div>)}
        </div>
      )}
    </div>
  );
}

/** Ranked horizontal bars with the value written next to each label (no hover needed to read them). */
export function HBars({ rows, tone = 'a', empty }: { rows: { label: string; value: number; display: ReactNode }[]; tone?: 'a' | 'b'; empty?: ReactNode }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="muted" style={{ fontSize: 14 }}>{empty ?? tr("No data for this period.")}</p>;
  return (
    <div className="hbars">
      {rows.map((r) => (
        <div className="hbar" key={r.label}>
          <div className="top"><span>{r.label}</span><span>{r.display}</span></div>
          <div className="track"><div className={`fill ${tone === 'b' ? 'b' : ''}`} style={{ width: `${(r.value / max) * 100}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

export const CHART = { revenue: 'var(--chart-a)', collected: 'var(--chart-b)' };

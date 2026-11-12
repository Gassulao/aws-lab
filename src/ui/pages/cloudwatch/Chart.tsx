import React from 'react';

export interface ChartPoint { t: number; v: number }

const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);

/** Gráfico de líneas SVG para una serie de CloudWatch, con línea opcional de umbral. */
export function Chart({ points, from, to, threshold, unit, title }: { points: ChartPoint[]; from: number; to: number; threshold?: number; unit?: string; title: string }) {
  const W = 760, H = 240, L = 56, R = 16, T = 26, B = 30;
  const vals = points.map((p) => p.v).concat(threshold !== undefined ? [threshold] : []);
  const max = vals.length ? Math.max(...vals) : 1, min = vals.length ? Math.min(0, ...vals) : 0;
  const span = max - min || 1;
  const hi = max + span * 0.1;
  const x = (t: number) => L + ((t - from) / Math.max(1, to - from)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - min) / (hi - min)) * (H - T - B);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => min + f * (hi - min));
  const xt = [0, 0.25, 0.5, 0.75, 1].map((f) => from + f * (to - from));
  return (
    <svg className="cw-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
      <title>{title}</title>
      {ticks.map((v, i) => <g key={i}><line className="grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} /><text x={L - 6} y={y(v) + 4} textAnchor="end">{fmt(v)}</text></g>)}
      {xt.map((t, i) => <text key={i} x={x(t)} y={H - 10} textAnchor="middle">{hhmm(t)}</text>)}
      <line className="axis" x1={L} x2={L} y1={T} y2={H - B} />
      <line className="axis" x1={L} x2={W - R} y1={H - B} y2={H - B} />
      {threshold !== undefined && <><line className="thr" x1={L} x2={W - R} y1={y(threshold)} y2={y(threshold)} /><text x={W - R} y={y(threshold) - 5} textAnchor="end" style={{ fill: '#d91515' }}>Umbral {fmt(threshold)}</text></>}
      {points.length > 1 && <polyline className="series" points={points.map((p) => `${x(p.t)},${y(p.v)}`).join(' ')} />}
      {points.map((p, i) => <circle key={i} className="dot" cx={x(p.t)} cy={y(p.v)} r={points.length > 40 ? 1.5 : 3} />)}
      {!points.length && <text className="empty" x={(L + W - R) / 2} y={(T + H - B) / 2} textAnchor="middle">No hay datos en este intervalo</text>}
      <text x={L} y={12}>{unit ? `${unit} · ` : ''}horas en UTC</text>
    </svg>
  );
}

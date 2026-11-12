import React from 'react';
import './gov.css';

export const GV_COLORS = ['var(--gv-c1)', 'var(--gv-c2)', 'var(--gv-c3)', 'var(--gv-c4)', 'var(--gv-c5)', 'var(--gv-c6)'];

export const COMP_ES: Record<string, string> = { COMPLIANT: 'Conforme', NON_COMPLIANT: 'No conforme', INSUFFICIENT_DATA: 'Datos insuficientes', NOT_APPLICABLE: 'No aplicable' };
export const Comp = ({ v }: { v: string }) => <span className={'gv-comp ' + v}><i />{COMP_ES[v] ?? v}</span>;

export const TA_ES: Record<string, string> = { ok: 'Sin problemas', warning: 'Investigar', error: 'Acción recomendada' };
export const TaStatus = ({ v }: { v: string }) => <span className={'gv-comp ' + v}><i />{TA_ES[v] ?? v}</span>;

export function Kpi({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'ok' | 'bad' | 'warn' }) {
  return (
    <div className={'gv-kpi ' + (tone ?? '')}>
      <div className="l">{label}</div>
      <div className="n">{value}</div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

export const usd2 = (n: number) => '$' + n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const usd4 = (n: number) => '$' + n.toLocaleString('es-ES', { minimumFractionDigits: n < 1 ? 4 : 2, maximumFractionDigits: n < 1 ? 4 : 2 });

export interface BarPeriod { label: string; parts: { key: string; value: number }[] }

/** Barras apiladas SVG: un periodo por barra y una serie por clave. */
export function StackedBars({ periods, keys, title, fmt: fmt0 }: { periods: BarPeriod[]; keys: string[]; title: string; fmt?: (n: number) => string }) {
  const W = 760, H = 260, L = 64, R = 12, T = 12, B = 44;
  const totals = periods.map((p) => p.parts.reduce((a, x) => a + x.value, 0));
  const maxV = Math.max(...totals, 0);
  const niceMax = maxV > 0 ? maxV * 1.1 : 1;
  const fmt = fmt0 ?? (niceMax < 1 ? usd4 : usd2);
  const bw = periods.length ? (W - L - R) / periods.length : 0;
  const y = (v: number) => T + (1 - v / niceMax) * (H - T - B);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * niceMax);
  const step = Math.max(1, Math.ceil(periods.length / 12));
  return (
    <div>
      <svg className="gv-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
        <title>{title}</title>
        {ticks.map((v, i) => <g key={i}><line className="grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} /><text x={L - 6} y={y(v) + 4} textAnchor="end">{fmt(v)}</text></g>)}
        <line className="axis" x1={L} x2={L} y1={T} y2={H - B} />
        <line className="axis" x1={L} x2={W - R} y1={H - B} y2={H - B} />
        {periods.map((p, i) => {
          let acc = 0;
          const x0 = L + i * bw + bw * 0.15;
          return (
            <g key={p.label}>
              <title>{p.label}: {fmt(totals[i])}</title>
              {p.parts.map((part) => {
                const y1 = y(acc + part.value), y0 = y(acc);
                acc += part.value;
                return <rect key={part.key} x={x0} y={y1} width={bw * 0.7} height={Math.max(0, y0 - y1)} fill={GV_COLORS[keys.indexOf(part.key) % GV_COLORS.length]} />;
              })}
              {i % step === 0 && <text x={x0 + bw * 0.35} y={H - B + 14} textAnchor="middle">{p.label.slice(5)}</text>}
            </g>
          );
        })}
        {!periods.length || maxV === 0 ? <text className="empty" x={(L + W - R) / 2} y={(T + H - B) / 2} textAnchor="middle">No hay costos en este periodo</text> : null}
      </svg>
      {keys.length > 0 && <div className="gv-legend">{keys.map((k, i) => <span key={k}><i style={{ background: GV_COLORS[i % GV_COLORS.length] }} />{k}</span>)}</div>}
    </div>
  );
}

export function Meter({ pct }: { pct: number }) {
  return <div className={'gv-meter ' + (pct >= 100 ? 'hot' : pct >= 80 ? 'mid' : '')} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: Math.min(100, pct) + '%' }} /></div>;
}

export function Empty({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return <div className="gv-empty"><h2>{title}</h2><p>{children}</p>{action}</div>;
}

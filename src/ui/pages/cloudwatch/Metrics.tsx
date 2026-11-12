import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Card, Crumbs, Field, PageHead } from '../../components/ui';
import { listMetricsRaw } from './metricsList';
import { pointsFor, statOf } from '../../../engine/services/cloudwatch';
import { now } from '../../../engine/util';
import { Chart } from './Chart';

export function MetricsPage() {
  const s = useCloud();
  const all = listMetricsRaw(s);
  const [key, setKey] = useState('');
  const [stat, setStat] = useState('Average');
  const [period, setPeriod] = useState(300);
  const [hours, setHours] = useState(3);
  const m = all.find((x) => x.key === key);
  const t = now(), from = t - hours * 3600_000;
  let pts: { t: number; v: number }[] = [];
  if (m) {
    const buckets = new Map<number, number[]>();
    for (const p of pointsFor(s, m.ns, m.name, m.dims, from, t)) { const b = Math.floor(p.ts / (period * 1000)) * period * 1000; (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(p.value); }
    pts = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([b, v]) => ({ t: b, v: statOf(stat, v) }));
  }
  const namespaces = [...new Set(all.map((x) => x.ns))];
  return (
    <>
      <Crumbs items={[{ label: 'CloudWatch', to: '/cloudwatch/alarms' }, { label: 'Métricas' }]} />
      <PageHead title="Métricas" desc="Explore las métricas de AWS y las personalizadas que publica con put-metric-data." />
      <Card title="Todas las métricas">
        {all.length === 0 ? <p className="k-muted">Todavía no hay métricas. Lance una instancia de EC2 o ejecute <code>aws cloudwatch put-metric-data</code>.</p> : (
          <>
            <Field label="Métrica"><select className="k-select" aria-label="Métrica" value={key} onChange={(e) => setKey(e.target.value)} style={{ minWidth: 460 }}>
              <option value="">Elegir una métrica</option>
              {namespaces.map((ns) => <optgroup key={ns} label={ns}>{all.filter((x) => x.ns === ns).map((x) => <option key={x.key} value={x.key}>{x.name}{Object.keys(x.dims).length ? ` · ${Object.entries(x.dims).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}</option>)}</optgroup>)}
            </select></Field>
            <div className="cw-row">
              <Field label="Estadístico"><select className="k-select" aria-label="Estadístico" value={stat} onChange={(e) => setStat(e.target.value)}>{['Average', 'Sum', 'Minimum', 'Maximum', 'SampleCount'].map((x) => <option key={x}>{x}</option>)}</select></Field>
              <Field label="Periodo"><select className="k-select" aria-label="Periodo" value={period} onChange={(e) => setPeriod(Number(e.target.value))}><option value={60}>1 minuto</option><option value={300}>5 minutos</option><option value={3600}>1 hora</option></select></Field>
              <Field label="Intervalo"><select className="k-select" aria-label="Intervalo" value={hours} onChange={(e) => setHours(Number(e.target.value))}><option value={1}>1 h</option><option value={3}>3 h</option><option value={12}>12 h</option><option value={24}>1 d</option></select></Field>
            </div>
            {m ? <Chart points={pts} from={from} to={t} unit={m.unit} title={`${m.name} (${stat})`} /> : <p className="k-muted">Elija una métrica para ver su gráfico.</p>}
          </>
        )}
      </Card>
    </>
  );
}

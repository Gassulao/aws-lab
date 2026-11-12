import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, CliEquivalent, Crumbs, Flash, PageHead, Table } from '../../components/ui';
import { run } from '../iam/kit';
import { CATEGORY_ES, CHECKS, checkResult, healthEvents, type TaCategory } from '../../../engine/services/trustedadvisor';
import { Kpi, TaStatus, usd2 } from './common';

const root = { label: 'Trusted Advisor', to: '/trustedadvisor' };
const CATS = Object.keys(CATEGORY_ES) as TaCategory[];

function useChecks() {
  const s = useCloud();
  return CHECKS.map((c) => ({ c, r: checkResult(s, c.id) }));
}

export function Overview() {
  const all = useChecks();
  return (
    <>
      <Crumbs items={[root, { label: 'Recomendaciones' }]} />
      <PageHead title="Trusted Advisor" desc="Recomendaciones que le ayudan a seguir las prácticas recomendadas de AWS en seguridad, costos, tolerancia a errores y rendimiento." />
      <div className="gv-kpis">
        {CATS.map((k) => {
          const rows = all.filter((x) => x.c.category === k);
          const bad = rows.filter((x) => x.r.status === 'error').length;
          const warn = rows.filter((x) => x.r.status === 'warning').length;
          return <Kpi key={k} label={CATEGORY_ES[k]} tone={bad ? 'bad' : warn ? 'warn' : 'ok'} value={bad + warn} sub={`${bad} acciones, ${warn} investigar, ${rows.length} comprobaciones`} />;
        })}
      </div>
      <Card title="Comprobaciones con hallazgos" flush>
        <Table rows={all.filter((x) => x.r.status !== 'ok')} id={(x) => x.c.id} empty={{ title: 'Todo en orden', desc: 'Ninguna comprobación tiene hallazgos.' }} cols={[
          { head: 'Comprobación', cell: (x) => x.c.name, text: (x) => x.c.name },
          { head: 'Categoría', cell: (x) => CATEGORY_ES[x.c.category] },
          { head: 'Estado', cell: (x) => <TaStatus v={x.r.status} />, text: (x) => x.r.status },
          { head: 'Recursos marcados', cell: (x) => x.r.flagged },
        ]} />
      </Card>
    </>
  );
}

export function Checks() {
  const all = useChecks();
  const [cat, setCat] = useState<TaCategory | 'all'>('all');
  const [flash, setFlash] = useState('');
  const [err, setErr] = useState('');
  const refresh = async (id: string, name: string) => { const r = await run(`aws support refresh-trusted-advisor-check --check-id ${id}`); if (!r.ok) setErr(r.msg); else { setErr(''); setFlash(`Se actualizó la comprobación: ${name}.`); } };
  return (
    <>
      <Crumbs items={[root, { label: 'Comprobaciones' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title="Comprobaciones" desc="Los resultados se guardan hasta que usted los actualiza: si corrige un recurso, pulse Actualizar para ver el cambio.">
        <select value={cat} onChange={(e) => setCat(e.target.value as TaCategory | 'all')} aria-label="Categoría"><option value="all">Todas las categorías</option>{CATS.map((k) => <option key={k} value={k}>{CATEGORY_ES[k]}</option>)}</select>
      </PageHead>
      {all.filter((x) => cat === 'all' || x.c.category === cat).map(({ c, r }) => (
        <details key={c.id} className="gv-check" open={r.status !== 'ok'}>
          <summary><TaStatus v={r.status} /> <b>{c.name}</b> <span className="gv-tag">{CATEGORY_ES[c.category]}</span> <small>{r.flagged} de {r.processed} marcados{r.savings ? ` · ahorro estimado ${usd2(r.savings)}/mes` : ''}</small></summary>
          <p>{c.description}</p>
          {r.flaggedResources.length > 0 && (
            <table className="gv-mini"><thead><tr><th>Estado</th><th>Región</th>{c.metadata.map((m) => <th key={m}>{m}</th>)}</tr></thead><tbody>{r.flaggedResources.map((f) => <tr key={f.resourceId + f.region}><td><TaStatus v={f.status} /></td><td>{f.region}</td>{c.metadata.map((m, k) => <td key={m}>{f.metadata[k] ?? ''}</td>)}</tr>)}</tbody></table>
          )}
          <div className="gv-row"><Btn small onClick={() => refresh(c.id, c.name)}>Actualizar</Btn> <small>Última actualización: {r.timestamp}</small></div>
          <CliEquivalent cmd={`aws support describe-trusted-advisor-check-result --check-id ${c.id}`} />
        </details>
      ))}
    </>
  );
}

export function Health() {
  const s = useCloud();
  const ev = healthEvents(s);
  return (
    <>
      <Crumbs items={[root, { label: 'AWS Health' }]} />
      <PageHead title="AWS Health" desc="Eventos que afectan a sus recursos: retiradas programadas y avisos de la cuenta." />
      {ev.length === 0 && <Flash kind="ok">No hay eventos abiertos. Ningún recurso necesita atención.</Flash>}
      {ev.map((e) => (
        <Card key={e.arn} title={`${e.service}: ${e.eventTypeCode}`}>
          <p>{e.description}</p>
          <p className="k-muted">Categoría: {e.eventTypeCategory} · Región: {e.region}</p>
          <ul>{e.entities.map((x) => <li key={x.value}>{x.value} ({x.status})</li>)}</ul>
        </Card>
      ))}
      <CliEquivalent cmd="aws health describe-events --region us-east-1" />
    </>
  );
}

export function TrustedAdvisorPages({ path }: { path: string }) {
  const clean = path.split('?')[0];
  if (clean.startsWith('/trustedadvisor/checks')) return <Checks />;
  if (clean.startsWith('/trustedadvisor/health')) return <Health />;
  return <Overview />;
}

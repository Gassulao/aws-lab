import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, Modal, PageHead, Table, nav } from '../../components/ui';
import { Dl, run, tmpFile } from '../iam/kit';
import { gov } from '../../../engine/services/govTypes';
import { burnPerHour, fmtDay, monthSpend, startOfDay, startOfMonth, usageBetween } from '../../../engine/services/costs';
import { budgetSpend, settleBudgets } from '../../../engine/services/budgets';
import { now } from '../../../engine/util';
import { settle } from '../../../engine/services/ec2';
import { Kpi, Meter, StackedBars, usd2, usd4, type BarPeriod } from './common';

const DAY = 86_400_000;
const root = { label: 'Facturación y administración de costos', to: '/billing' };

/** Costo diario por servicio entre dos instantes (mismos datos que devuelve aws ce get-cost-and-usage). */
function daily(s: ReturnType<typeof useCloud>, from: number, to: number) {
  const periods: BarPeriod[] = [];
  const services = new Set<string>();
  for (let t = from; t < to; t += DAY) {
    const lines = usageBetween(s, t, Math.min(t + DAY, now())).filter((l) => l.usd > 0);
    lines.forEach((l) => services.add(l.service));
    periods.push({ label: fmtDay(t), parts: lines.map((l) => ({ key: l.service, value: l.usd })) });
  }
  return { periods, services: [...services].sort() };
}

export function Home() {
  const s = useCloud();
  settle(s);
  const t = now();
  const m = monthSpend(s, t);
  const start = startOfDay(t) - 13 * DAY;
  const { periods, services } = daily(s, start, startOfDay(t) + DAY);
  const burn = burnPerHour(s);
  return (
    <>
      <Crumbs items={[root, { label: 'Panel' }]} />
      <PageHead title="Panel de facturación" desc="Gasto del mes en curso y previsión a fin de mes según los recursos que tiene encendidos." />
      <div className="gv-kpis">
        <Kpi label="Gasto del mes hasta hoy" value={usd2(m.actual)} />
        <Kpi label="Previsión a fin de mes" value={usd2(m.forecast)} tone={m.forecast > 50 ? 'warn' : undefined} />
        <Kpi label="Ritmo actual" value={usd4(burn) + '/h'} sub={`${usd2(burn * 24)} al día`} />
        <Kpi label="Presupuestos" value={gov(s).budgets.length} sub={<a onClick={() => nav('/billing/budgets')}>Administrar</a>} />
      </div>
      <Card title="Costo diario por servicio (últimos 14 días)" actions={<Btn small onClick={() => nav('/billing/cost-explorer')}>Abrir Cost Explorer</Btn>}>
        <StackedBars periods={periods} keys={services} title="Costo diario por servicio" />
      </Card>
    </>
  );
}

export function CostExplorer() {
  const s = useCloud();
  settle(s);
  const [range, setRange] = useState<'14' | '30' | 'mes'>('14');
  const [gran, setGran] = useState<'DAILY' | 'MONTHLY'>('DAILY');
  const [note, setNote] = useState('');
  const t = now();
  const from = range === 'mes' ? startOfMonth(t) : startOfDay(t) - (Number(range) - 1) * DAY;
  const to = startOfDay(t) + DAY;
  const { periods, services } = daily(s, from, to);
  const byService = services.map((svc) => ({ svc, usd: periods.reduce((a, p) => a + (p.parts.find((x) => x.key === svc)?.value ?? 0), 0) })).sort((a, b) => b.usd - a.usd);
  const total = byService.reduce((a, x) => a + x.usd, 0);
  const shown: BarPeriod[] = gran === 'DAILY' ? periods : [{ label: fmtDay(from), parts: byService.map((x) => ({ key: x.svc, value: x.usd })) }];
  const cmd = `aws ce get-cost-and-usage --time-period Start=${fmtDay(from)},End=${fmtDay(to)} --granularity ${gran} --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE`;
  return (
    <>
      <Crumbs items={[root, { label: 'Cost Explorer' }]} />
      {note && <Flash kind="info" onClose={() => setNote('')}>{note}</Flash>}
      <PageHead title="Cost Explorer" desc="Analice sus costos y su uso en el tiempo, agrupados por servicio.">
        <select value={range} onChange={(e) => setRange(e.target.value as '14' | '30' | 'mes')} aria-label="Periodo"><option value="14">Últimos 14 días</option><option value="30">Últimos 30 días</option><option value="mes">Mes en curso</option></select>
        <select value={gran} onChange={(e) => setGran(e.target.value as 'DAILY' | 'MONTHLY')} aria-label="Granularidad"><option value="DAILY">Diaria</option><option value="MONTHLY">Mensual</option></select>
      </PageHead>
      <div className="gv-kpis"><Kpi label="Costo total del periodo" value={usd2(total)} sub={`${fmtDay(from)} a ${fmtDay(to - DAY)}`} /><Kpi label="Servicios con costo" value={byService.filter((x) => x.usd > 0).length} /></div>
      <Card title="Costo por servicio"><StackedBars periods={shown} keys={services} title="Costo por servicio" /></Card>
      <Card title="Desglose" flush>
        <Table rows={byService} id={(x) => x.svc} empty={{ title: 'Sin costos', desc: 'Lance instancias, un NAT o un balanceador para generar uso facturable.' }} cols={[
          { head: 'Servicio', cell: (x) => x.svc, text: (x) => x.svc },
          { head: 'Costo', cell: (x) => usd2(x.usd), text: (x) => String(x.usd) },
          { head: '% del total', cell: (x) => (total ? ((x.usd / total) * 100).toFixed(1) + ' %' : '-') },
        ]} />
      </Card>
      <Card title="Equivalente en la CLI">
        <CliEquivalent cmd={cmd} />
        <div style={{ marginTop: 8 }}><Btn small onClick={async () => { const r = await run(cmd); setNote(r.ok ? 'Se ejecutó en la terminal: revise la salida JSON allí.' : r.msg); }}>Ejecutar en la terminal</Btn></div>
      </Card>
    </>
  );
}

export function Budgets() {
  const s = useCloud();
  settleBudgets(s);
  const g = gov(s);
  const [modal, setModal] = useState(false);
  const [name, setName] = useState('');
  const [limit, setLimit] = useState('10');
  const [pct, setPct] = useState('80');
  const [email, setEmail] = useState('');
  const [flash, setFlash] = useState('');
  const [err, setErr] = useState('');
  const acct = s.account.id;
  const create = async () => {
    const b = { BudgetName: name, BudgetLimit: { Amount: limit, Unit: 'USD' }, TimeUnit: 'MONTHLY', BudgetType: 'COST' };
    const n = [{ Notification: { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: Number(pct), ThresholdType: 'PERCENTAGE' }, Subscribers: [{ SubscriptionType: 'EMAIL', Address: email }] }];
    const r = await run(`aws budgets create-budget --account-id ${acct} --budget ${tmpFile(JSON.stringify(b))}${email ? ` --notifications-with-subscribers ${tmpFile(JSON.stringify(n))}` : ''}`);
    if (!r.ok) setErr(r.msg); else { setErr(''); setFlash(`Se creó el presupuesto ${name}.`); }
    setModal(false);
  };
  return (
    <>
      <Crumbs items={[root, { label: 'Presupuestos' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title="Presupuestos" desc="Fije un importe mensual y reciba un aviso cuando el gasto real o previsto lo supere.">
        <Btn kind="primary" onClick={() => { setName(''); setLimit('10'); setPct('80'); setEmail(''); setModal(true); }}>Crear presupuesto</Btn>
      </PageHead>
      <Card title="Presupuestos" count={g.budgets.length} flush>
        <Table rows={g.budgets} id={(b) => b.name} empty={{ title: 'Sin presupuestos', desc: 'Cree un presupuesto de costos mensual con un aviso al 80 %.' }} cols={[
          { head: 'Nombre', cell: (b) => <a onClick={() => nav('/billing/budget/' + b.name)}>{b.name}</a>, text: (b) => b.name },
          { head: 'Periodo', cell: (b) => b.timeUnit },
          { head: 'Importe', cell: (b) => usd2(b.limit), text: (b) => String(b.limit) },
          { head: 'Gasto actual', cell: (b) => { const p = (budgetSpend(s, b).actual / b.limit) * 100; return <div style={{ minWidth: 160 }}>{usd2(budgetSpend(s, b).actual)} ({p.toFixed(0)} %)<Meter pct={p} /></div>; } },
          { head: 'Previsto', cell: (b) => usd2(budgetSpend(s, b).forecast) },
          { head: 'Estado', cell: (b) => (b.notifications.some((n) => n.state === 'ALARM') ? 'En alarma' : 'Correcto') },
        ]} />
      </Card>
      {modal && (
        <Modal title="Crear presupuesto" onClose={() => setModal(false)} footer={<><Btn onClick={() => setModal(false)}>Cancelar</Btn><Btn kind="primary" disabled={!name.trim()} onClick={create}>Crear presupuesto</Btn></>}>
          <Field label="Nombre del presupuesto"><input type="text" value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="presupuesto-mensual" /></Field>
          <Field label="Importe mensual (USD)"><input type="text" value={limit} onChange={(e) => setLimit(e.target.value)} /></Field>
          <Field label="Avisar cuando el gasto real supere (%)"><input type="text" value={pct} onChange={(e) => setPct(e.target.value)} /></Field>
          <Field label="Correo del destinatario (opcional)"><input type="text" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="yo@example.com" /></Field>
          <CliEquivalent cmd={`aws budgets create-budget --account-id ${acct} --budget file://presupuesto.json --notifications-with-subscribers file://avisos.json`} />
        </Modal>
      )}
    </>
  );
}

export function BudgetDetail({ name }: { name: string }) {
  const s = useCloud();
  settleBudgets(s);
  const g = gov(s);
  const [flash, setFlash] = useState('');
  const [err, setErr] = useState('');
  const b = g.budgets.find((x) => x.name === name);
  if (!b) return <><Crumbs items={[root, { label: 'Presupuestos', to: '/billing/budgets' }]} /><Flash kind="err" title="NotFoundException">No existe el presupuesto {name}.</Flash></>;
  const sp = budgetSpend(s, b);
  const pct = (sp.actual / b.limit) * 100;
  const alerts = (g.alerts ?? []).filter((a) => a.budget === b.name);
  return (
    <>
      <Crumbs items={[root, { label: 'Presupuestos', to: '/billing/budgets' }, { label: b.name }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title={b.name} desc="Seguimiento del gasto frente al importe presupuestado.">
        <Btn kind="danger" onClick={async () => { const r = await run(`aws budgets delete-budget --account-id ${s.account.id} --budget-name ${b.name}`); if (!r.ok) setErr(r.msg); else nav('/billing/budgets'); }}>Eliminar</Btn>
      </PageHead>
      <div className="gv-kpis">
        <Kpi label="Importe presupuestado" value={usd2(b.limit)} sub={b.timeUnit} />
        <Kpi label="Gasto real" value={usd2(sp.actual)} tone={pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : 'ok'} sub={`${pct.toFixed(1)} % del presupuesto`} />
        <Kpi label="Gasto previsto" value={usd2(sp.forecast)} sub={`${((sp.forecast / b.limit) * 100).toFixed(1)} % del presupuesto`} />
      </div>
      <Card title="Progreso"><Meter pct={pct} /></Card>
      <Card title="Avisos" count={b.notifications.length} flush>
        <Table rows={b.notifications} id={(n) => n.type + n.operator + n.threshold} empty={{ title: 'Sin avisos' }} cols={[
          { head: 'Umbral', cell: (n) => `${n.type === 'ACTUAL' ? 'Real' : 'Previsto'} ${n.operator === 'GREATER_THAN' ? '>' : n.operator === 'LESS_THAN' ? '<' : '='} ${n.threshold}${n.thresholdType === 'PERCENTAGE' ? ' %' : ' USD'}` },
          { head: 'Destinatarios', cell: (n) => n.subscribers.map((x) => x.address).join(', ') || '-' },
          { head: 'Estado', cell: (n) => (n.state === 'ALARM' ? 'En alarma' : 'Correcto') },
        ]} />
      </Card>
      <Card title="Avisos enviados" count={alerts.length} flush>
        <Table rows={alerts} id={(a) => a.ts + a.to} empty={{ title: 'Aún no se envió ningún aviso' }} cols={[
          { head: 'Fecha', cell: (a) => a.ts },
          { head: 'Canal', cell: (a) => a.channel },
          { head: 'Destino', cell: (a) => a.to },
          { head: 'Asunto', cell: (a) => a.subject },
        ]} />
      </Card>
      <Card title="Detalles"><Dl cols={3} items={[['Tipo', 'Costo'], ['Periodo', b.timeUnit], ['Creado', b.createdAt]]} /></Card>
    </>
  );
}

export function BillingPages({ path }: { path: string }) {
  const clean = path.split('?')[0];
  if (clean.startsWith('/billing/budget/')) return <BudgetDetail key={clean} name={decodeURIComponent(clean.split('/')[3] ?? '')} />;
  if (clean.startsWith('/billing/budgets')) return <Budgets />;
  if (clean.startsWith('/billing/cost-explorer')) return <CostExplorer />;
  return <Home />;
}

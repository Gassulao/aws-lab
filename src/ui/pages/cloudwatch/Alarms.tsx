import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, PageHead, Table, nav, fmtDate } from '../../components/ui';
import { ConfirmModal, Dl, Menu, Tabs, run, setNextFlash, takeFlash, q } from '../iam/kit';
import { OPERATORS, pointsFor, settleCw, statOf, EC2_METRICS } from '../../../engine/services/cloudwatch';
import { now } from '../../../engine/util';
import type { CwAlarm } from '../../../engine/types';
import { Chart } from './Chart';

const root = { label: 'CloudWatch', to: '/cloudwatch/alarms' };
export const STATE_ES: Record<string, string> = { OK: 'Correcto', ALARM: 'En alarma', INSUFFICIENT_DATA: 'Datos insuficientes' };
export const State = ({ v }: { v: string }) => <span className={'cw-state ' + v}><i />{STATE_ES[v]}</span>;
const OP_ES: Record<string, string> = { GreaterThanThreshold: 'mayor que', GreaterThanOrEqualToThreshold: 'mayor o igual que', LessThanThreshold: 'menor que', LessThanOrEqualToThreshold: 'menor o igual que' };
const OP_SYMBOL: Record<string, string> = { GreaterThanThreshold: '>', GreaterThanOrEqualToThreshold: '>=', LessThanThreshold: '<', LessThanOrEqualToThreshold: '<=' };
export const condition = (a: CwAlarm) => `${a.metric} ${OP_SYMBOL[a.operator]} ${a.threshold} durante ${a.datapointsToAlarm ?? a.evalPeriods} ${(a.datapointsToAlarm ?? a.evalPeriods) === 1 ? 'punto' : 'puntos'} de datos en ${a.evalPeriods * a.period / 60} ${a.evalPeriods * a.period === 60 ? 'minuto' : 'minutos'}`;

export function AlarmsList() {
  const s = useCloud();
  const [flash, setFlash] = useState(takeFlash);
  const [sel, setSel] = useState<string[]>([]);
  settleCw(s);
  const rows = s.alarms.filter((a) => a.region === s.region);
  return (
    <>
      <Crumbs items={[root, { label: 'Alarmas' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <PageHead title="Alarmas" desc="Vigile una métrica y actúe cuando supere un umbral: notifique a un tema de SNS o registre el cambio de estado." />
      <Card title="Alarmas" count={rows.length} flush actions={<><Btn disabled={!sel.length} onClick={async () => { const r = await run(`aws cloudwatch delete-alarms --alarm-names ${sel.join(' ')}`); if (r.ok) { setSel([]); setFlash('Se eliminaron las alarmas seleccionadas.'); } }}>Eliminar</Btn> <Btn kind="primary" onClick={() => nav('/cloudwatch/alarm-create')}>Crear alarma</Btn></>}>
        <Table rows={rows} id={(a) => a.name} selected={sel} onSelect={setSel} filterPlaceholder="Buscar alarmas" empty={{ title: 'No hay alarmas', desc: 'No ha creado ninguna alarma en esta región.' }} cols={[
          { head: 'Nombre', cell: (a) => <a onClick={() => nav('/cloudwatch/alarm/' + encodeURIComponent(a.name))}>{a.name}</a>, text: (a) => a.name },
          { head: 'Estado', cell: (a) => <State v={a.state} />, text: (a) => a.state },
          { head: 'Última actualización del estado', cell: (a) => fmtDate(a.stateUpdated), text: (a) => a.stateUpdated },
          { head: 'Condición', cell: (a) => condition(a) },
          { head: 'Acciones', cell: (a) => (a.actionsEnabled ? (a.alarmActions.length ? `${a.alarmActions.length} acción(es)` : 'Sin acciones') : 'Deshabilitadas') },
        ]} />
      </Card>
    </>
  );
}

export function AlarmDetail({ name }: { name: string }) {
  const s = useCloud();
  settleCw(s);
  const a = s.alarms.find((x) => x.name === name && x.region === s.region);
  const [tab, setTab] = useState<'hist' | 'cfg' | 'act'>('hist');
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [del, setDel] = useState(false);
  const [range, setRange] = useState(3);
  if (!a) return <><Crumbs items={[root, { label: 'Alarmas', to: '/cloudwatch/alarms' }]} /><Flash kind="err" title="ResourceNotFound">La alarma {name} no existe en esta región.</Flash></>;
  const t = now();
  const from = t - range * 3600_000;
  const raw = pointsFor(s, a.namespace, a.metric, a.dims, from, t);
  const byBucket = new Map<number, number[]>();
  for (const p of raw) { const b = Math.floor(p.ts / (a.period * 1000)) * a.period * 1000; (byBucket.get(b) ?? byBucket.set(b, []).get(b)!).push(p.value); }
  const pts = [...byBucket.entries()].sort((x, y) => x[0] - y[0]).map(([b, v]) => ({ t: b, v: statOf(a.statistic, v) }));
  const act = async (cmd: string, ok: string) => { const r = await run(cmd); if (!r.ok) return setErr(r.msg); setErr(''); setFlash(ok); };
  const unit = a.namespace === 'AWS/EC2' ? EC2_METRICS[a.metric] : raw[0]?.unit;
  return (
    <>
      <Crumbs items={[root, { label: 'Alarmas', to: '/cloudwatch/alarms' }, { label: a.name }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title={a.name}>
        <Menu label="Acciones" items={[
          { label: a.actionsEnabled ? 'Deshabilitar acciones' : 'Habilitar acciones', onClick: () => void act(`aws cloudwatch ${a.actionsEnabled ? 'disable' : 'enable'}-alarm-actions --alarm-names ${q(a.name)}`, a.actionsEnabled ? 'Se deshabilitaron las acciones.' : 'Se habilitaron las acciones.') },
          { label: 'Eliminar', onClick: () => setDel(true) },
        ]} />
      </PageHead>
      <Card title="Detalles">
        <Dl items={[['Estado', <State v={a.state} />], ['Descripción', a.description || '–'], ['Motivo del estado', a.stateReason], ['Condición', condition(a)], ['Última actualización del estado', fmtDate(a.stateUpdated)], ['ARN', a.arn]]} />
      </Card>
      <Card title={a.metric} actions={<select className="k-select" aria-label="Intervalo" value={range} onChange={(e) => setRange(Number(e.target.value))}><option value={1}>1 h</option><option value={3}>3 h</option><option value={12}>12 h</option><option value={24}>1 d</option></select>}>
        <Chart points={pts} from={from} to={t} threshold={a.threshold} unit={unit} title={`${a.metric} (${a.statistic}, ${a.period} s)`} />
      </Card>
      <div className="card" style={{ marginBottom: 20 }}>
        <Tabs<'hist' | 'cfg' | 'act'> active={tab} onChange={setTab} tabs={[{ id: 'hist', label: 'Historial' }, { id: 'cfg', label: 'Configuración' }, { id: 'act', label: 'Acciones' }]} />
        {tab === 'hist' && (
          <div className="body2">
            <Table rows={[...a.history].reverse()} id={(h) => h.ts + h.summary} pageSize={10} empty={{ title: 'Sin historial' }} cols={[
              { head: 'Fecha', cell: (h) => fmtDate(h.ts) }, { head: 'Tipo', cell: (h) => ({ StateUpdate: 'Actualización de estado', ConfigurationUpdate: 'Actualización de configuración', Action: 'Acción' }[h.type]) }, { head: 'Descripción', cell: (h) => h.summary },
            ]} />
          </div>
        )}
        {tab === 'cfg' && (
          <div className="body2">
            <Dl items={[['Espacio de nombres', a.namespace], ['Nombre de la métrica', a.metric], ['Dimensiones', Object.entries(a.dims).map(([k, v]) => `${k}=${v}`).join(', ') || '–'], ['Estadístico', a.statistic], ['Periodo', `${a.period} segundos`], ['Periodos de evaluación', a.evalPeriods], ['Puntos de datos para la alarma', `${a.datapointsToAlarm ?? a.evalPeriods} de ${a.evalPeriods}`], ['Umbral', `${OP_ES[a.operator]} ${a.threshold}`], ['Datos faltantes', { missing: 'Tratar los datos faltantes como faltantes', notBreaching: 'Tratar como correctos (dentro del umbral)', breaching: 'Tratar como incumplimiento (fuera del umbral)', ignore: 'Ignorar (mantener el estado actual)' }[a.treatMissing]]]} />
          </div>
        )}
        {tab === 'act' && (
          <div className="body2">
            <Dl cols={2} items={[['Acciones', a.actionsEnabled ? 'Habilitadas' : 'Deshabilitadas'], ['En alarma', a.alarmActions.join(', ') || '–'], ['Correcto', a.okActions.join(', ') || '–'], ['Datos insuficientes', a.insufficientActions.join(', ') || '–']]} />
          </div>
        )}
      </div>
      {del && <ConfirmModal title="Eliminar alarma" danger confirmLabel="Eliminar" onClose={() => setDel(false)} onConfirm={async () => { const r = await run(`aws cloudwatch delete-alarms --alarm-names ${q(a.name)}`); if (!r.ok) { setErr(r.msg); setDel(false); return; } setNextFlash(`Se eliminó la alarma "${a.name}".`); nav('/cloudwatch/alarms'); }}>Se eliminará la alarma <b>{a.name}</b>.</ConfirmModal>}
    </>
  );
}

export function CreateAlarm() {
  const s = useCloud();
  const [step, setStep] = useState(0);
  const [metricKey, setMetricKey] = useState('');
  const [stat, setStat] = useState('Average');
  const [period, setPeriod] = useState('300');
  const [op, setOp] = useState('GreaterThanThreshold');
  const [thr, setThr] = useState('80');
  const [evalN, setEvalN] = useState('1');
  const [miss, setMiss] = useState('missing');
  const [topic, setTopic] = useState('');
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // métricas disponibles: EC2 de instancias vivas + personalizadas
  const opts: { key: string; ns: string; metric: string; dims: Record<string, string> }[] = [];
  const seen = new Set<string>();
  for (const i of s.instances.filter((x) => x.state !== 'terminated')) for (const m of Object.keys(EC2_METRICS)) opts.push({ key: `AWS/EC2|${m}|${i.id}`, ns: 'AWS/EC2', metric: m, dims: { InstanceId: i.id } });
  for (const m of s.metricData) { const k = `${m.ns}|${m.name}|${JSON.stringify(m.dims)}`; if (!seen.has(k)) { seen.add(k); opts.push({ key: k, ns: m.ns, metric: m.name, dims: m.dims }); } }
  const m = opts.find((o) => o.key === metricKey);
  const nameErr = name && s.alarms.some((a) => a.name === name && a.region === s.region) ? 'Ya existe una alarma con ese nombre; se sobrescribirá su configuración.' : '';
  const dimArg = m && Object.keys(m.dims).length ? ` --dimensions ${Object.entries(m.dims).map(([k, v]) => `Name=${k},Value=${v}`).join(' ')}` : '';
  const cmd = m ? `aws cloudwatch put-metric-alarm --alarm-name ${q(name || '<nombre>')} --namespace ${m.ns} --metric-name ${m.metric}${dimArg} --statistic ${stat} --period ${period} --evaluation-periods ${evalN} --threshold ${thr} --comparison-operator ${op} --treat-missing-data ${miss}${topic ? ` --alarm-actions ${topic}` : ''}${desc ? ` --alarm-description ${q(desc)}` : ''}` : '';
  const go = async () => { setBusy(true); const r = await run(cmd); if (!r.ok) { setBusy(false); return setErr(r.msg); } setNextFlash(`Se creó la alarma "${name}".`); nav('/cloudwatch/alarm/' + encodeURIComponent(name)); };
  return (
    <>
      <Crumbs items={[root, { label: 'Alarmas', to: '/cloudwatch/alarms' }, { label: 'Crear alarma' }]} />
      <PageHead title="Crear alarma" />
      {err && <Flash kind="err" title="Error al crear la alarma" onClose={() => setErr('')}>{err}</Flash>}
      {step === 0 && (
        <>
          <Card title="Métrica">
            {opts.length === 0 ? <p className="k-muted">Todavía no hay métricas. Lance una instancia de EC2 o publique datos con <code>aws cloudwatch put-metric-data</code>.</p> : (
              <Field label="Seleccionar la métrica"><select className="k-select" aria-label="Métrica" value={metricKey} onChange={(e) => setMetricKey(e.target.value)} style={{ minWidth: 420 }}>
                <option value="">Elegir una métrica</option>
                {opts.map((o) => <option key={o.key} value={o.key}>{o.ns} · {o.metric}{Object.keys(o.dims).length ? ` · ${Object.values(o.dims).join(',')}` : ''}</option>)}
              </select></Field>
            )}
            <div className="cw-row">
              <Field label="Estadístico"><select className="k-select" aria-label="Estadístico" value={stat} onChange={(e) => setStat(e.target.value)}>{['Average', 'Sum', 'Minimum', 'Maximum', 'SampleCount'].map((x) => <option key={x}>{x}</option>)}</select></Field>
              <Field label="Periodo"><select className="k-select" aria-label="Periodo" value={period} onChange={(e) => setPeriod(e.target.value)}>{[['60', '1 minuto'], ['300', '5 minutos'], ['900', '15 minutos'], ['3600', '1 hora']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            </div>
          </Card>
          <Card title="Condiciones">
            <div className="cw-row">
              <Field label="Tipo de umbral"><select className="k-select" aria-label="Operador" value={op} onChange={(e) => setOp(e.target.value)}>{Object.keys(OPERATORS).map((o) => <option key={o} value={o}>{OP_SYMBOL[o]} umbral ({OP_ES[o]})</option>)}</select></Field>
              <Field label="Valor del umbral"><input className="k-input" type="number" aria-label="Umbral" value={thr} onChange={(e) => setThr(e.target.value)} style={{ maxWidth: 140 }} /></Field>
              <Field label="Periodos de evaluación"><input className="k-input" type="number" min={1} aria-label="Periodos" value={evalN} onChange={(e) => setEvalN(e.target.value)} style={{ maxWidth: 100 }} /></Field>
            </div>
            <Field label="Tratamiento de los datos faltantes"><select className="k-select" aria-label="Datos faltantes" value={miss} onChange={(e) => setMiss(e.target.value)}><option value="missing">Tratar los datos faltantes como faltantes</option><option value="notBreaching">Tratar como correctos (dentro del umbral)</option><option value="breaching">Tratar como incumplimiento (fuera del umbral)</option><option value="ignore">Ignorar (mantener el estado actual)</option></select></Field>
          </Card>
        </>
      )}
      {step === 1 && (
        <Card title="Notificación">
          <Field label="Cuando la alarma esté «En alarma», enviar a un tema de SNS" hint="Cree antes el tema con aws sns create-topic o desde la consola de SNS.">
            <select className="k-select" aria-label="Tema de SNS" value={topic} onChange={(e) => setTopic(e.target.value)} style={{ minWidth: 420 }}><option value="">Sin notificación</option>{s.topics.map((t) => <option key={t.arn} value={t.arn}>{t.name}</option>)}</select>
          </Field>
        </Card>
      )}
      {step === 2 && (
        <>
          <Card title="Nombre y descripción">
            <Field label="Nombre de la alarma" error={nameErr}><input className="k-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
            <Field label="Descripción de la alarma - opcional"><input className="k-input" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
          </Card>
          <CliEquivalent cmd={cmd} />
        </>
      )}
      <div className="k-foot">
        <Btn onClick={() => (step === 0 ? nav('/cloudwatch/alarms') : setStep(step - 1))}>{step === 0 ? 'Cancelar' : 'Anterior'}</Btn>
        {step < 2 ? <Btn kind="primary" disabled={step === 0 && (!m || !thr || !evalN)} onClick={() => setStep(step + 1)}>Siguiente</Btn> : <Btn kind="primary" disabled={busy || !name} onClick={go}>Crear alarma</Btn>}
      </div>
    </>
  );
}

import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, Modal, PageHead, Table, nav } from '../../components/ui';
import { Dl } from '../iam/kit';
import { run, tmpFile } from '../iam/kit';
import { gov } from '../../../engine/services/govTypes';
import { MANAGED, evaluateRule, resourceCompliance, ruleCompliance, type Compliance } from '../../../engine/services/config';
import { Comp, Empty, Kpi } from './common';

const root = { label: 'AWS Config', to: '/config/dashboard' };

function Setup({ onDone }: { onDone: (m: string) => void }) {
  const s = useCloud();
  const [bucket, setBucket] = useState(s.buckets[0]?.name ?? '');
  const [err, setErr] = useState('');
  const role = `arn:aws:iam::${s.account.id}:role/aws-service-role/config.amazonaws.com/AWSServiceRoleForConfig`;
  const cmds = [
    `aws configservice put-configuration-recorder --configuration-recorder name=default,roleARN=${role} --recording-group allSupported=true,includeGlobalResourceTypes=true`,
    `aws configservice put-delivery-channel --delivery-channel name=default,s3BucketName=${bucket || '<bucket>'}`,
    'aws configservice start-configuration-recorder --configuration-recorder-name default',
  ];
  const go = async () => {
    for (const c of cmds) { const r = await run(c); if (!r.ok) return setErr(r.msg); }
    onDone('AWS Config está grabando los cambios de configuración de sus recursos.');
  };
  return (
    <>
      <Crumbs items={[root, { label: 'Configuración inicial' }]} />
      <PageHead title="AWS Config" desc="Evalúe, audite y registre la configuración de sus recursos de AWS de forma continua." />
      {err && <Flash kind="err" onClose={() => setErr('')}>{err}</Flash>}
      <Card title="Configuración inicial">
        <Empty title="Active el grabador de configuración" action={<>
          <div style={{ maxWidth: 420, margin: '12px auto', textAlign: 'left' }}>
            <Field label="Bucket de S3 de entrega" hint={s.buckets.length ? undefined : 'Cree antes un bucket de S3.'}>
              <select value={bucket} onChange={(e) => setBucket(e.target.value)} aria-label="Bucket de entrega"><option value="">Seleccione un bucket…</option>{s.buckets.map((b) => <option key={b.name}>{b.name}</option>)}</select>
            </Field>
            <p className="k-muted">Rol: AWSServiceRoleForConfig (rol vinculado al servicio)</p>
          </div>
          <Btn kind="primary" disabled={!bucket} onClick={go}>Confirmar</Btn>
          <div style={{ marginTop: 16, textAlign: 'left' }}>{cmds.map((c) => <CliEquivalent key={c} cmd={c} />)}</div>
        </>}>
          El grabador guarda la configuración de los recursos compatibles en el bucket y permite evaluar reglas de conformidad sobre ellos.
        </Empty>
      </Card>
    </>
  );
}

function useConfig() {
  const s = useCloud();
  const c = gov(s).config;
  return { s, c, rules: c.rules };
}

export function Dashboard() {
  const { s, c, rules } = useConfig();
  const [flash, setFlash] = useState('');
  if (!c.recorder || !c.channel) return <Setup onDone={setFlash} />;
  const comp = rules.map((r) => ruleCompliance(s, r));
  const count = (v: Compliance) => comp.filter((x) => x === v).length;
  const res = resourceCompliance(s);
  return (
    <>
      <Crumbs items={[root, { label: 'Panel' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <PageHead title="Panel de AWS Config" desc="Resumen de conformidad de sus reglas y recursos." />
      <div className="gv-kpis">
        <Kpi label="Grabador" tone={c.recorder.recording ? 'ok' : 'warn'} value={<span style={{ fontSize: 18 }}>{c.recorder.recording ? 'Grabando' : 'Detenido'}</span>} sub={c.recorder.name} />
        <Kpi label="Reglas" value={rules.length} />
        <Kpi label="Reglas no conformes" tone={count('NON_COMPLIANT') ? 'bad' : 'ok'} value={count('NON_COMPLIANT')} />
        <Kpi label="Recursos no conformes" tone={res.filter((r) => r.compliance === 'NON_COMPLIANT').length ? 'bad' : 'ok'} value={res.filter((r) => r.compliance === 'NON_COMPLIANT').length} sub={`de ${res.length} evaluados`} />
      </div>
      <Card title="Conformidad por regla" count={rules.length} flush actions={<Btn small kind="primary" onClick={() => nav('/config/rules')}>Administrar reglas</Btn>}>
        <Table rows={rules} id={(r) => r.name} empty={{ title: 'Sin reglas', desc: 'Agregue una regla gestionada para empezar a evaluar.' }} cols={[
          { head: 'Regla', cell: (r) => <a onClick={() => nav('/config/rule/' + r.name)}>{r.name}</a>, text: (r) => r.name },
          { head: 'Conformidad', cell: (r) => <Comp v={ruleCompliance(s, r)} />, text: (r) => ruleCompliance(s, r) },
        ]} />
      </Card>
    </>
  );
}

export function Rules() {
  const { s, c, rules } = useConfig();
  const [flash, setFlash] = useState('');
  const [err, setErr] = useState('');
  const [modal, setModal] = useState(false);
  const [ident, setIdent] = useState('S3_BUCKET_PUBLIC_READ_PROHIBITED');
  const [name, setName] = useState('');
  if (!c.recorder || !c.channel) return <Setup onDone={setFlash} />;
  const def = MANAGED[ident];
  const ruleName = name || ident.toLowerCase().replace(/_/g, '-');
  const body = () => JSON.stringify({ ConfigRuleName: ruleName, Source: { Owner: 'AWS', SourceIdentifier: ident }, ...(def?.defaults ? { InputParameters: JSON.stringify(def.defaults) } : {}) }, null, 2);
  const add = async () => { const r = await run(`aws configservice put-config-rule --config-rule ${tmpFile(body())}`); if (!r.ok) { setErr(r.msg); } else { setFlash(`Se agregó la regla ${ruleName}.`); setErr(''); } setModal(false); };
  return (
    <>
      <Crumbs items={[root, { label: 'Reglas' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title="Reglas" desc="Las reglas de AWS Config evalúan la configuración de sus recursos frente a la configuración deseada.">
        <Btn onClick={async () => { const r = await run(`aws configservice start-config-rules-evaluation --config-rule-names ${rules.map((x) => x.name).join(' ') || 'ninguna'}`); if (!r.ok) setErr(r.msg); else setFlash('Se inició la reevaluación de las reglas.'); }} disabled={!rules.length}>Volver a evaluar</Btn>
        <Btn kind="primary" onClick={() => { setName(''); setModal(true); }}>Agregar regla</Btn>
      </PageHead>
      <Card title="Reglas" count={rules.length} flush>
        <Table rows={rules} id={(r) => r.name} filterPlaceholder="Buscar reglas" empty={{ title: 'Sin reglas', desc: 'Agregue una regla gestionada, por ejemplo s3-bucket-public-read-prohibited.' }} cols={[
          { head: 'Nombre', cell: (r) => <a onClick={() => nav('/config/rule/' + r.name)}>{r.name}</a>, text: (r) => r.name },
          { head: 'Identificador', cell: (r) => r.identifier, text: (r) => r.identifier },
          { head: 'Conformidad', cell: (r) => <Comp v={ruleCompliance(s, r)} />, text: (r) => ruleCompliance(s, r) },
          { head: 'Acciones', cell: (r) => <Btn small onClick={async () => { const x = await run(`aws configservice delete-config-rule --config-rule-name ${r.name}`); if (!x.ok) setErr(x.msg); else setFlash(`Se eliminó la regla ${r.name}.`); }}>Eliminar</Btn> },
        ]} />
      </Card>
      {modal && (
        <Modal title="Agregar regla gestionada" onClose={() => setModal(false)} footer={<><Btn onClick={() => setModal(false)}>Cancelar</Btn><Btn kind="primary" onClick={add}>Agregar regla</Btn></>}>
          <Field label="Regla gestionada de AWS"><select value={ident} onChange={(e) => setIdent(e.target.value)} aria-label="Regla gestionada">{Object.keys(MANAGED).map((k) => <option key={k} value={k}>{k.toLowerCase().replace(/_/g, '-')}</option>)}</select></Field>
          <p className="k-muted">{def?.description}</p>
          <Field label="Nombre de la regla"><input type="text" value={name} placeholder={ruleName} onChange={(e) => setName(e.target.value)} /></Field>
          <CliEquivalent cmd={`aws configservice put-config-rule --config-rule file://regla.json`} />
          <pre className="gv-code">{body()}</pre>
        </Modal>
      )}
    </>
  );
}

export function RuleDetail({ name }: { name: string }) {
  const { s, rules } = useConfig();
  const r = rules.find((x) => x.name === name);
  if (!r) return <><Crumbs items={[root, { label: 'Reglas', to: '/config/rules' }]} /><Flash kind="err" title="NoSuchConfigRuleException">No existe la regla {name}.</Flash></>;
  const ev = evaluateRule(s, r);
  const comp = ruleCompliance(s, r);
  return (
    <>
      <Crumbs items={[root, { label: 'Reglas', to: '/config/rules' }, { label: r.name }]} />
      <PageHead title={r.name} desc={r.description ?? MANAGED[r.identifier]?.description}><Comp v={comp} /></PageHead>
      <Card title="Detalles"><Dl cols={3} items={[['ARN', r.arn], ['Identificador de origen', r.identifier], ['Propietario', 'AWS'], ['Conformidad', <Comp v={comp} />], ['Parámetros', Object.keys(r.inputParameters).length ? JSON.stringify(r.inputParameters) : 'Ninguno']]} /></Card>
      <Card title="Recursos evaluados" count={ev.length} flush>
        <Table rows={ev} id={(e) => e.type + e.id} filterPlaceholder="Buscar recursos" empty={{ title: comp === 'INSUFFICIENT_DATA' ? 'Datos insuficientes' : 'Sin recursos', desc: comp === 'INSUFFICIENT_DATA' ? 'El grabador está detenido: reinícielo para evaluar.' : 'No hay recursos de este tipo.' }} cols={[
          { head: 'ID del recurso', cell: (e) => e.name ?? e.id, text: (e) => e.name ?? e.id },
          { head: 'Tipo', cell: (e) => e.type },
          { head: 'Conformidad', cell: (e) => <Comp v={e.ok ? 'COMPLIANT' : 'NON_COMPLIANT'} />, text: (e) => (e.ok ? 'COMPLIANT' : 'NON_COMPLIANT') },
          { head: 'Anotación', cell: (e) => e.annotation ?? '-' },
        ]} />
      </Card>
    </>
  );
}

export function Resources() {
  const { s, c } = useConfig();
  const [f, setF] = useState<'all' | 'NON_COMPLIANT'>('all');
  if (!c.recorder) return <Setup onDone={() => undefined} />;
  const rows = resourceCompliance(s).filter((r) => f === 'all' || r.compliance === f);
  return (
    <>
      <Crumbs items={[root, { label: 'Recursos' }]} />
      <PageHead title="Recursos" desc="Conformidad de cada recurso frente a todas las reglas." />
      <Card title="Inventario de recursos" count={rows.length} flush actions={<select value={f} onChange={(e) => setF(e.target.value as 'all' | 'NON_COMPLIANT')} aria-label="Filtro"><option value="all">Todos</option><option value="NON_COMPLIANT">Solo no conformes</option></select>}>
        <Table rows={rows} id={(r) => r.type + r.id} filterPlaceholder="Buscar recursos" empty={{ title: 'Sin recursos evaluados', desc: 'Agregue reglas para evaluar recursos.' }} cols={[
          { head: 'Recurso', cell: (r) => r.name ?? r.id, text: (r) => r.name ?? r.id },
          { head: 'Tipo', cell: (r) => r.type, text: (r) => r.type },
          { head: 'Conformidad', cell: (r) => <Comp v={r.compliance} />, text: (r) => r.compliance },
          { head: 'Reglas que fallan', cell: (r) => r.evals.filter((x) => !x.e.ok).map((x) => x.rule.name).join(', ') || '-' },
        ]} />
      </Card>
    </>
  );
}

export function Settings() {
  const { c } = useConfig();
  const [flash, setFlash] = useState('');
  const [err, setErr] = useState('');
  if (!c.recorder || !c.channel) return <Setup onDone={setFlash} />;
  const rec = c.recorder;
  const toggle = async () => { const r = await run(`aws configservice ${rec.recording ? 'stop' : 'start'}-configuration-recorder --configuration-recorder-name ${rec.name}`); if (!r.ok) setErr(r.msg); else { setErr(''); setFlash(rec.recording ? 'Se detuvo el grabador.' : 'Se inició el grabador.'); } };
  return (
    <>
      <Crumbs items={[root, { label: 'Configuración' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title="Configuración" desc="Grabador de configuración y canal de entrega.">
        <Btn kind={rec.recording ? 'danger' : 'primary'} onClick={toggle}>{rec.recording ? 'Detener grabación' : 'Iniciar grabación'}</Btn>
      </PageHead>
      <Card title="Grabador"><Dl cols={3} items={[['Nombre', rec.name], ['Estado', rec.recording ? 'Grabando' : 'Detenido'], ['Rol de IAM', rec.roleArn], ['Todos los tipos admitidos', rec.allSupported ? 'Sí' : 'No'], ['Recursos globales', rec.includeGlobal ? 'Sí' : 'No']]} /></Card>
      <Card title="Canal de entrega"><Dl cols={3} items={[['Nombre', c.channel.name], ['Bucket de S3', c.channel.s3Bucket], ['Prefijo', c.channel.s3Prefix ?? '-'], ['Tema de SNS', c.channel.snsTopicArn ?? '-']]} /></Card>
    </>
  );
}

export function ConfigPages({ path }: { path: string }) {
  const clean = path.split('?')[0];
  if (clean.startsWith('/config/rule/')) return <RuleDetail key={clean} name={decodeURIComponent(clean.split('/')[3] ?? '')} />;
  if (clean.startsWith('/config/rules')) return <Rules />;
  if (clean.startsWith('/config/resources')) return <Resources />;
  if (clean.startsWith('/config/settings')) return <Settings />;
  return <Dashboard />;
}

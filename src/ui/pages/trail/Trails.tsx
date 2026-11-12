import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, PageHead, Table, nav, fmtDate } from '../../components/ui';
import { ConfirmModal, Dl, Menu, run, setNextFlash, takeFlash } from '../iam/kit';

const BASE = '/cloudtrail/trails';
const root = { label: 'CloudTrail', to: '/cloudtrail/events' };
const st = (on: boolean) => (on ? <span className="k-badge ok">Registrando</span> : <span className="k-badge warn">Detenida</span>);

export function TrailsList() {
  const s = useCloud();
  const [flash, setFlash] = useState(takeFlash);
  return (
    <>
      <Crumbs items={[root, { label: 'Sendas' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <PageHead title="Sendas" desc="Una senda entrega los eventos de la cuenta como archivos de registro a un bucket de S3, más allá de los 90 días del historial de eventos." />
      <Card title="Sendas" count={s.trails.length} flush actions={<Btn kind="primary" onClick={() => nav(BASE + '/create')}>Crear senda</Btn>}>
        <Table rows={s.trails} id={(t) => t.name} filterPlaceholder="Filtrar sendas" empty={{ title: 'No hay sendas', desc: 'Cree una senda para conservar el registro de actividad en S3.' }} cols={[
          { head: 'Nombre', cell: (t) => <a onClick={() => nav('/cloudtrail/trail/' + encodeURIComponent(t.name))}>{t.name}</a>, text: (t) => t.name },
          { head: 'Región de origen', cell: (t) => t.homeRegion },
          { head: 'Multirregión', cell: (t) => (t.multiRegion ? 'Sí' : 'No') },
          { head: 'Bucket de S3', cell: (t) => t.s3Bucket, text: (t) => t.s3Bucket },
          { head: 'Estado', cell: (t) => st(t.logging) },
        ]} />
      </Card>
    </>
  );
}

export function CreateTrail() {
  const s = useCloud();
  const [name, setName] = useState('');
  const [bucket, setBucket] = useState('');
  const [prefix, setPrefix] = useState('');
  const [multi, setMulti] = useState(true);
  const [valid, setValid] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const nameErr = name && (name.length < 3 ? 'El nombre debe tener al menos 3 caracteres.' : s.trails.some((t) => t.name === name) ? 'Ya existe una senda con ese nombre.' : '');
  const cmd = `aws cloudtrail create-trail --name ${name || '<nombre>'} --s3-bucket-name ${bucket || '<bucket>'}${prefix ? ` --s3-key-prefix ${prefix}` : ''}${multi ? ' --is-multi-region-trail' : ''}${valid ? ' --enable-log-file-validation' : ''}\naws cloudtrail start-logging --name ${name || '<nombre>'}`;
  const go = async () => {
    setBusy(true); setErr('');
    for (const c of cmd.split('\n')) {
      const r = await run(c);
      if (!r.ok) { setBusy(false); return setErr(r.msg); }
    }
    setNextFlash(`Se creó la senda "${name}" y está registrando eventos.`);
    nav('/cloudtrail/trail/' + encodeURIComponent(name));
  };
  return (
    <>
      <Crumbs items={[root, { label: 'Sendas', to: BASE }, { label: 'Crear senda' }]} />
      <PageHead title="Crear senda" />
      {err && <Flash kind="err" title="Error al crear la senda" onClose={() => setErr('')}>{err}</Flash>}
      <Card title="Atributos generales">
        <Field label="Nombre de la senda" error={nameErr}><input className="k-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="auditoria-cuenta" autoFocus /></Field>
        <label className="k-switch"><input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> Habilitar para todas las regiones</label>
        <label className="k-switch" style={{ display: 'block', marginTop: 8 }}><input type="checkbox" checked={valid} onChange={(e) => setValid(e.target.checked)} /> Validación del archivo de registro</label>
      </Card>
      <Card title="Ubicación de almacenamiento">
        <Field label="Bucket de S3" hint="El bucket debe existir y tener una política que permita a cloudtrail.amazonaws.com escribir en él.">
          <select className="k-select" aria-label="Bucket de S3" value={bucket} onChange={(e) => setBucket(e.target.value)} style={{ minWidth: 320 }}>
            <option value="">Elegir un bucket</option>
            {s.buckets.map((b) => <option key={b.name}>{b.name}</option>)}
          </select>
        </Field>
        <Field label="Prefijo - opcional"><input className="k-input" value={prefix} onChange={(e) => setPrefix(e.target.value)} /></Field>
      </Card>
      <CliEquivalent cmd={cmd} />
      <div className="k-foot"><Btn onClick={() => nav(BASE)}>Cancelar</Btn><Btn kind="primary" disabled={busy || !name || !!nameErr || !bucket} onClick={go}>Crear senda</Btn></div>
    </>
  );
}

export function TrailDetail({ name }: { name: string }) {
  const s = useCloud();
  const t = s.trails.find((x) => x.name === name);
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [del, setDel] = useState(false);
  if (!t) return <><Crumbs items={[root, { label: 'Sendas', to: BASE }]} /><Flash kind="err" title="TrailNotFoundException">Unknown trail: {name}</Flash></>;
  const act = async (cmd: string, ok: string) => {
    const r = await run(cmd);
    if (!r.ok) return setErr(r.msg);
    setErr(''); setFlash(ok);
  };
  return (
    <>
      <Crumbs items={[root, { label: 'Sendas', to: BASE }, { label: t.name }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title={t.name}>
        <Btn onClick={() => void act(`aws cloudtrail ${t.logging ? 'stop' : 'start'}-logging --name ${t.name}`, t.logging ? 'Se detuvo el registro.' : 'Se inició el registro.')}>{t.logging ? 'Detener el registro' : 'Iniciar el registro'}</Btn>
        <Menu label="Acciones" items={[{ label: 'Eliminar senda', onClick: () => setDel(true) }]} />
      </PageHead>
      <Card title="Configuración general">
        <Dl items={[['Estado', st(t.logging)], ['ARN', t.arn], ['Región de origen', t.homeRegion], ['Multirregión', t.multiRegion ? 'Sí' : 'No'], ['Eventos de servicios globales', t.includeGlobal ? 'Sí' : 'No'], ['Validación de archivos', t.logValidation ? 'Habilitada' : 'Deshabilitada'], ['Clave de KMS', t.kmsKeyId ?? 'No cifrada con KMS'], ['Fecha de creación', fmtDate(t.createdAt)]]} />
      </Card>
      <Card title="Ubicación de almacenamiento">
        <Dl cols={2} items={[['Bucket de S3', <a onClick={() => nav('/s3/bucket/' + t.s3Bucket)}>{t.s3Bucket}</a>], ['Prefijo', t.s3Prefix || '–'], ['Última entrega de registros', t.lastDelivery ? fmtDate(t.lastDelivery) : 'Aún no hay entregas']]} />
      </Card>
      {del && <ConfirmModal title="Eliminar senda" danger confirmLabel="Eliminar" onClose={() => setDel(false)} onConfirm={async () => { const r = await run(`aws cloudtrail delete-trail --name ${t.name}`); if (!r.ok) { setErr(r.msg); setDel(false); return; } setNextFlash(`Se eliminó la senda "${t.name}".`); nav(BASE); }}>
        Se eliminará la senda <b>{t.name}</b>. Los archivos ya entregados al bucket no se borran.
      </ConfirmModal>}
    </>
  );
}

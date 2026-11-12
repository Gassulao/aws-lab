import React, { useState } from 'react';
import './cloudwatch/cw.css';
import { useCloud } from '../session';
import { Btn, Card, Crumbs, Field, Flash, Modal, PageHead, Table, nav, fmtDate } from '../components/ui';
import { ConfirmModal, Dl, Menu, run, setNextFlash, takeFlash, q } from './iam/kit';

const root = { label: 'Amazon SNS', to: '/sns/topics' };

export function SnsPages({ path }: { path: string }) {
  const parts = path.split('?')[0].split('/').map((x) => decodeURIComponent(x));
  return parts[2] === 'topic' ? <TopicDetail key={parts[3]} name={parts[3] ?? ''} /> : <Topics />;
}

function Topics() {
  const s = useCloud();
  const [flash, setFlash] = useState(takeFlash);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const rows = s.topics.filter((t) => t.region === s.region);
  return (
    <>
      <Crumbs items={[root, { label: 'Temas' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <PageHead title="Temas" desc="Un tema de SNS distribuye mensajes, por ejemplo las notificaciones de una alarma de CloudWatch, a sus suscriptores." />
      <Card title="Temas" count={rows.length} flush actions={<Btn kind="primary" onClick={() => { setName(''); setErr(''); setCreating(true); }}>Crear tema</Btn>}>
        <Table rows={rows} id={(t) => t.name} filterPlaceholder="Buscar temas" empty={{ title: 'No hay temas', desc: 'Cree un tema para recibir notificaciones.' }} cols={[
          { head: 'Nombre', cell: (t) => <a onClick={() => nav('/sns/topic/' + encodeURIComponent(t.name))}>{t.name}</a>, text: (t) => t.name },
          { head: 'Tipo', cell: () => 'Estándar' }, { head: 'ARN', cell: (t) => t.arn }, { head: 'Suscripciones', cell: (t) => t.subs.length },
        ]} />
      </Card>
      {creating && (
        <Modal title="Crear tema" onClose={() => setCreating(false)} footer={<><Btn onClick={() => setCreating(false)}>Cancelar</Btn><Btn kind="primary" disabled={!name} onClick={async () => { const r = await run(`aws sns create-topic --name ${q(name)}`); if (!r.ok) return setErr(r.msg); setCreating(false); setFlash(`Se creó el tema "${name}".`); }}>Crear tema</Btn></>}>
          {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
          <Field label="Nombre"><input className="k-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        </Modal>
      )}
    </>
  );
}

function TopicDetail({ name }: { name: string }) {
  const s = useCloud();
  const t = s.topics.find((x) => x.name === name && x.region === s.region);
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [del, setDel] = useState(false);
  const [sub, setSub] = useState(false);
  const [proto, setProto] = useState('email');
  const [endpoint, setEndpoint] = useState('');
  const [msg, setMsg] = useState('');
  if (!t) return <><Crumbs items={[root, { label: 'Temas', to: '/sns/topics' }]} /><Flash kind="err" title="NotFound">El tema {name} no existe en esta región.</Flash></>;
  return (
    <>
      <Crumbs items={[root, { label: 'Temas', to: '/sns/topics' }, { label: t.name }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title={t.name}><Menu label="Acciones" items={[{ label: 'Eliminar tema', onClick: () => setDel(true) }]} /></PageHead>
      <Card title="Detalles"><Dl items={[['Nombre', t.name], ['ARN', t.arn], ['Tipo', 'Estándar']]} /></Card>
      <Card title="Suscripciones" count={t.subs.length} flush actions={<Btn kind="primary" onClick={() => { setEndpoint(''); setSub(true); }}>Crear suscripción</Btn>}>
        <Table rows={t.subs} id={(x) => x.arn} empty={{ title: 'No hay suscripciones' }} cols={[
          { head: 'ID', cell: (x) => (x.confirmed ? x.arn.split(':').pop() : 'Pendiente de confirmación') }, { head: 'Protocolo', cell: (x) => x.protocol }, { head: 'Punto de enlace', cell: (x) => x.endpoint },
          { head: 'Estado', cell: (x) => (x.confirmed ? 'Confirmada' : 'Pendiente de confirmación') },
        ]} />
      </Card>
      <Card title="Publicar un mensaje">
        <div className="cw-row"><input className="k-input" aria-label="Mensaje" placeholder="Cuerpo del mensaje" value={msg} onChange={(e) => setMsg(e.target.value)} style={{ minWidth: 360 }} /><Btn disabled={!msg} onClick={async () => { const r = await run(`aws sns publish --topic-arn ${t.arn} --message ${q(msg)}`); if (!r.ok) return setErr(r.msg); setMsg(''); setFlash('Se publicó el mensaje.'); }}>Publicar</Btn></div>
      </Card>
      <Card title="Mensajes publicados (simulador)" count={t.messages.length} flush>
        <Table rows={[...t.messages].reverse()} id={(m) => m.id} pageSize={5} empty={{ title: 'Todavía no se ha publicado ningún mensaje', desc: 'El simulador guarda aquí lo que recibirían los suscriptores, incluidas las notificaciones de alarmas.' }} cols={[
          { head: 'Fecha', cell: (m) => fmtDate(m.ts) }, { head: 'Origen', cell: (m) => (m.source === 'cloudwatch' ? 'Alarma de CloudWatch' : 'Publicación') }, { head: 'Asunto', cell: (m) => m.subject ?? '–' }, { head: 'Mensaje', cell: (m) => <pre className="cw-msg">{m.message}</pre> },
        ]} />
      </Card>
      {del && <ConfirmModal title="Eliminar tema" danger confirmLabel="Eliminar" onClose={() => setDel(false)} onConfirm={async () => { const r = await run(`aws sns delete-topic --topic-arn ${t.arn}`); if (!r.ok) { setErr(r.msg); setDel(false); return; } setNextFlash(`Se eliminó el tema "${t.name}".`); nav('/sns/topics'); }}>Se eliminará el tema <b>{t.name}</b> y sus suscripciones.</ConfirmModal>}
      {sub && (
        <Modal title="Crear suscripción" onClose={() => setSub(false)} footer={<><Btn onClick={() => setSub(false)}>Cancelar</Btn><Btn kind="primary" disabled={!endpoint} onClick={async () => { const r = await run(`aws sns subscribe --topic-arn ${t.arn} --protocol ${proto} --notification-endpoint ${q(endpoint)}`); if (!r.ok) { setErr(r.msg); setSub(false); return; } setSub(false); setFlash('Se creó la suscripción.'); }}>Crear</Btn></>}>
          <Field label="Protocolo"><select className="k-select" aria-label="Protocolo" value={proto} onChange={(e) => setProto(e.target.value)}>{['email', 'https', 'sqs', 'lambda', 'sms'].map((p) => <option key={p}>{p}</option>)}</select></Field>
          <Field label="Punto de enlace"><input className="k-input" aria-label="Punto de enlace" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} /></Field>
        </Modal>
      )}
    </>
  );
}

import React, { useState } from 'react';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, Modal, PageHead, Table, nav } from '../../components/ui';
import { ConfirmModal, Dl, run, takeFlash, setNextFlash } from '../iam/kit';
import { useSvc, link, enc, when, NotFound, Tabs, sq } from './common';
import { sv } from '../../../engine/serverless';
import { counts } from '../../../engine/serverless/sqs';

const ROOT = { label: 'Amazon SQS', to: '/sqs/queues' };

export function SqsList() {
  const s = useSvc();
  const [flash, setFlash] = useState(takeFlash);
  const [sel, setSel] = useState<string[]>([]);
  const [modal, setModal] = useState<null | 'create' | 'delete'>(null);
  const [name, setName] = useState('');
  const [fifo, setFifo] = useState(false);
  const [vis, setVis] = useState(30);
  const [dlq, setDlq] = useState('');
  const [maxRecv, setMaxRecv] = useState(3);
  const [err, setErr] = useState('');
  const qs = sv(s).queues.filter((q) => q.region === s.region);
  const full = fifo && !name.endsWith('.fifo') ? name + '.fifo' : name;
  const attrs: Record<string, string> = { VisibilityTimeout: String(vis) };
  if (fifo) attrs.FifoQueue = 'true';
  const dq = qs.find((q) => q.name === dlq);
  if (dq) attrs.RedrivePolicy = JSON.stringify({ deadLetterTargetArn: dq.arn, maxReceiveCount: maxRecv });
  const attrArg = Object.entries(attrs).map(([k, v]) => (k === 'RedrivePolicy' ? `RedrivePolicy=${sq(v.replace(/"/g, '\\"'))}` : `${k}=${v}`)).join(',');
  const cmd = `aws sqs create-queue --queue-name ${full || '<nombre>'} --attributes ${sq(JSON.stringify(attrs))}`;
  void attrArg;
  const create = async () => {
    const r = await run(cmd);
    if (!r.ok) return setErr(r.msg);
    setModal(null); setErr(''); setFlash(`La cola ${full} se creó correctamente.`); setName('');
  };
  return (
    <>
      <Crumbs items={[ROOT, { label: 'Colas' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <PageHead title="Colas" desc="Amazon SQS desacopla los componentes de una aplicación con colas de mensajes totalmente administradas." />
      <Card title="Colas" count={qs.length} flush actions={<div className="sv-row"><Btn disabled={sel.length !== 1} onClick={() => setModal('delete')}>Eliminar</Btn><Btn kind="primary" onClick={() => { setErr(''); setModal('create'); }}>Crear cola</Btn></div>}>
        <Table rows={qs} id={(q) => q.name} selected={sel} onSelect={(x) => setSel(x.slice(-1))} filterPlaceholder="Buscar colas" empty={{ title: 'No hay colas', desc: 'Cree una cola para empezar a enviar mensajes.' }} cols={[
          { head: 'Nombre', cell: (q) => link('/sqs/queue/' + enc(q.name), q.name), text: (q) => q.name },
          { head: 'Tipo', cell: (q) => (q.fifo ? 'FIFO' : 'Estándar'), text: (q) => (q.fifo ? 'FIFO' : 'Estándar') },
          { head: 'Mensajes disponibles', cell: (q) => counts(q).visible, text: (q) => String(counts(q).visible) },
          { head: 'Mensajes en vuelo', cell: (q) => counts(q).notVisible, text: (q) => String(counts(q).notVisible) },
          { head: 'Creada', cell: (q) => when(q.createdAt), text: (q) => String(q.createdAt) },
        ]} />
      </Card>
      {modal === 'create' && (
        <Modal title="Crear cola" onClose={() => setModal(null)} footer={<><Btn onClick={() => setModal(null)}>Cancelar</Btn><Btn kind="primary" disabled={!name} onClick={create}>Crear cola</Btn></>}>
          {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
          <div className="sv-form">
            <Field label="Tipo"><label><input type="radio" checked={!fifo} onChange={() => setFifo(false)} /> Estándar (entrega al menos una vez, orden best-effort)</label><br /><label><input type="radio" checked={fifo} onChange={() => setFifo(true)} /> FIFO (orden estricto, el nombre termina en .fifo)</label></Field>
            <Field label="Nombre"><input className="k-input" type="text" aria-label="Nombre de la cola" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
            <Field label="Tiempo de espera de visibilidad (segundos)"><input className="k-input" type="number" aria-label="Tiempo de visibilidad" value={vis} onChange={(e) => setVis(Number(e.target.value))} /></Field>
            <Field label="Cola de mensajes fallidos (DLQ)" hint="Los mensajes que superen el número máximo de recepciones se mueven a esta cola.">
              <select className="k-input" aria-label="Cola de mensajes fallidos" value={dlq} onChange={(e) => setDlq(e.target.value)}><option value="">Ninguna</option>{qs.filter((q) => q.fifo === fifo).map((q) => <option key={q.name}>{q.name}</option>)}</select>
            </Field>
            {dlq && <Field label="Máximo de recepciones"><input className="k-input" type="number" aria-label="Máximo de recepciones" value={maxRecv} onChange={(e) => setMaxRecv(Number(e.target.value))} /></Field>}
            <CliEquivalent cmd={cmd} />
          </div>
        </Modal>
      )}
      {modal === 'delete' && sel[0] && <ConfirmModal title="Eliminar cola" confirmLabel="Eliminar" danger requireText="eliminar" onClose={() => setModal(null)} onConfirm={async () => { const q = qs.find((x) => x.name === sel[0])!; const r = await run(`aws sqs delete-queue --queue-url ${q.url}`); if (!r.ok) return r.msg; setFlash(`La cola ${q.name} se eliminó.`); setSel([]); }}>
        Se eliminará la cola <b>{sel[0]}</b> con todos sus mensajes.
      </ConfirmModal>}
    </>
  );
}

type Tab = 'send' | 'poll' | 'config';
interface Got { Body: string; MessageId: string; ReceiptHandle: string; Attributes?: Record<string, string> }

export function SqsDetail({ name }: { name: string }) {
  const s = useSvc();
  const [tab, setTab] = useState<Tab>('send');
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [body, setBody] = useState('{"pedido": 1001}');
  const [group, setGroup] = useState('grupo-1');
  const [msgs, setMsgs] = useState<Got[]>([]);
  const [empty, setEmpty] = useState(false);
  const q = sv(s).queues.find((x) => x.name === name && x.region === s.region);
  if (!q) return <><Crumbs items={[ROOT]} /><NotFound what={`La cola ${name} no existe en la región ${s.region}.`} /></>;
  const c = counts(q);
  const sendCmd = `aws sqs send-message --queue-url ${q.url} --message-body ${sq(body)}${q.fifo ? ` --message-group-id ${group}` : ''}`;
  const recvCmd = `aws sqs receive-message --queue-url ${q.url} --max-number-of-messages 10 --attribute-names All`;
  const send = async () => { const r = await run(sendCmd); if (!r.ok) return setErr(r.msg); setErr(''); setFlash(`Mensaje enviado. ID: ${r.json?.MessageId}`); };
  const poll = async () => { const r = await run(recvCmd); if (!r.ok) return setErr(r.msg); setErr(''); setMsgs(r.json?.Messages ?? []); setEmpty(!(r.json?.Messages?.length)); };
  const del = async (m: Got) => { const r = await run(`aws sqs delete-message --queue-url ${q.url} --receipt-handle ${sq(m.ReceiptHandle)}`); if (!r.ok) return setErr(r.msg); setMsgs((l) => l.filter((x) => x.MessageId !== m.MessageId)); setFlash('Mensaje eliminado.'); };
  const redrive = q.attrs.RedrivePolicy ? JSON.parse(q.attrs.RedrivePolicy) : null;
  return (
    <>
      <Crumbs items={[ROOT, { label: 'Colas', to: '/sqs/queues' }, { label: q.name }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title={q.name}><Btn onClick={async () => { const r = await run(`aws sqs purge-queue --queue-url ${q.url}`); if (!r.ok) return setErr(r.msg); setFlash('La cola se vació.'); }}>Purgar</Btn><Btn kind="danger" onClick={async () => { if (!confirm(`¿Eliminar la cola ${q.name}?`)) return; const r = await run(`aws sqs delete-queue --queue-url ${q.url}`); if (!r.ok) return setErr(r.msg); setNextFlash(`La cola ${q.name} se eliminó.`); nav('/sqs/queues'); }}>Eliminar</Btn></PageHead>
      <Card title="Detalles"><Dl items={[['Tipo', q.fifo ? 'FIFO' : 'Estándar'], ['URL', <span className="sv-url" key="u">{q.url}</span>], ['ARN', <span className="sv-url" key="a">{q.arn}</span>], ['Mensajes disponibles', c.visible], ['Mensajes en vuelo', c.notVisible], ['Mensajes retrasados', c.delayed]]} /></Card>
      <Tabs cur={tab} onChange={setTab} tabs={[['send', 'Enviar mensaje'], ['poll', 'Recibir mensajes'], ['config', 'Configuración']]} />
      {tab === 'send' && (
        <Card title="Enviar mensaje" actions={<Btn kind="primary" onClick={send}>Enviar mensaje</Btn>}>
          <div className="sv-form">
            <Field label="Cuerpo del mensaje"><textarea className="sv-code sm" aria-label="Cuerpo del mensaje" spellCheck={false} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
            {q.fifo && <Field label="ID del grupo de mensajes"><input className="k-input" type="text" aria-label="ID del grupo de mensajes" value={group} onChange={(e) => setGroup(e.target.value)} /></Field>}
            <CliEquivalent cmd={sendCmd} />
          </div>
        </Card>
      )}
      {tab === 'poll' && (
        <Card title="Recibir mensajes" actions={<Btn kind="primary" onClick={poll}>Sondear mensajes</Btn>}>
          <div className="sv-muted" style={{ marginBottom: 8 }}>Los mensajes recibidos quedan invisibles durante {q.attrs.VisibilityTimeout} s. Si no los elimina, volverán a la cola (y tras superar el máximo de recepciones irán a la DLQ).</div>
          {empty && <Flash kind="info">No hay mensajes disponibles.</Flash>}
          {msgs.map((m) => (
            <div className="sv-msg" key={m.MessageId}>
              <b>{m.MessageId}</b><small>Recibido {m.Attributes?.ApproximateReceiveCount ?? '1'} vez/veces</small>
              <pre className="sv-pre">{m.Body}</pre>
              <div style={{ marginTop: 6 }}><Btn small onClick={() => del(m)}>Eliminar mensaje</Btn></div>
            </div>
          ))}
          <CliEquivalent cmd={recvCmd} />
        </Card>
      )}
      {tab === 'config' && (
        <Card title="Configuración">
          <Dl items={[['Tiempo de visibilidad', q.attrs.VisibilityTimeout + ' s'], ['Retención de mensajes', q.attrs.MessageRetentionPeriod + ' s'], ['Retraso de entrega', q.attrs.DelaySeconds + ' s'], ['Cola de mensajes fallidos', redrive ? `${redrive.deadLetterTargetArn.split(':').pop()} (máx. ${redrive.maxReceiveCount} recepciones)` : 'Sin DLQ'], ['Política de acceso', q.attrs.Policy ? 'Personalizada' : 'Solo el propietario de la cuenta']]} />
          {q.attrs.Policy && <pre className="sv-pre" style={{ marginTop: 8 }}>{JSON.stringify(JSON.parse(q.attrs.Policy), null, 2)}</pre>}
        </Card>
      )}
    </>
  );
}

import React, { useState } from 'react';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, Modal, PageHead, Table, nav } from '../../components/ui';
import { ConfirmModal, Dl, run, takeFlash, setNextFlash } from '../iam/kit';
import { useSvc, link, enc, when, St, NotFound, Tabs, sq } from './common';
import { sv } from '../../../engine/serverless';
import { tableStatus } from '../../../engine/serverless/dynamodb';

const ROOT = { label: 'Amazon DynamoDB', to: '/dynamodb/tables' };
const disp = (v: any): string => { const [t, x] = Object.entries<any>(v ?? {})[0] ?? []; return t === 'S' || t === 'N' || t === 'BOOL' ? String(x) : JSON.stringify(x); };

export function DdbList() {
  const s = useSvc();
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const [modal, setModal] = useState<null | 'create' | 'delete'>(null);
  const [name, setName] = useState('');
  const [pk, setPk] = useState('id');
  const [pkT, setPkT] = useState('S');
  const [sk, setSk] = useState('');
  const [skT, setSkT] = useState('S');
  const tables = sv(s).tables.filter((t) => t.region === s.region);
  const defs = [`AttributeName=${pk},AttributeType=${pkT}`, ...(sk ? [`AttributeName=${sk},AttributeType=${skT}`] : [])].join(' ');
  const keys = [`AttributeName=${pk},KeyType=HASH`, ...(sk ? [`AttributeName=${sk},KeyType=RANGE`] : [])].join(' ');
  const cmd = `aws dynamodb create-table --table-name ${name || '<nombre>'} --attribute-definitions ${defs} --key-schema ${keys} --billing-mode PAY_PER_REQUEST`;
  const create = async () => { const r = await run(cmd); if (!r.ok) return setErr(r.msg); setModal(null); setErr(''); setFlash(`Se está creando la tabla ${name}.`); setName(''); };
  return (
    <>
      <Crumbs items={[ROOT, { label: 'Tablas' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <PageHead title="Tablas" desc="Base de datos NoSQL clave-valor y de documentos con latencia de milisegundos a cualquier escala." />
      <Card title="Tablas" count={tables.length} flush actions={<div className="sv-row"><Btn disabled={sel.length !== 1} onClick={() => setModal('delete')}>Eliminar</Btn><Btn kind="primary" onClick={() => { setErr(''); setModal('create'); }}>Crear tabla</Btn></div>}>
        <Table rows={tables} id={(t) => t.name} selected={sel} onSelect={(x) => setSel(x.slice(-1))} filterPlaceholder="Buscar tablas" empty={{ title: 'No hay tablas', desc: 'Cree una tabla para guardar elementos.' }} cols={[
          { head: 'Nombre', cell: (t) => link('/dynamodb/table/' + enc(t.name), t.name), text: (t) => t.name },
          { head: 'Estado', cell: (t) => <St v={tableStatus(t)} />, text: (t) => tableStatus(t) },
          { head: 'Clave de partición', cell: (t) => t.keySchema.find((k) => k.KeyType === 'HASH')?.AttributeName },
          { head: 'Clave de ordenación', cell: (t) => t.keySchema.find((k) => k.KeyType === 'RANGE')?.AttributeName ?? '-' },
          { head: 'Elementos', cell: (t) => t.items.length, text: (t) => String(t.items.length) },
          { head: 'Modo de capacidad', cell: (t) => (t.billingMode === 'PAY_PER_REQUEST' ? 'Bajo demanda' : 'Aprovisionada') },
        ]} />
      </Card>
      {modal === 'create' && (
        <Modal title="Crear tabla" onClose={() => setModal(null)} footer={<><Btn onClick={() => setModal(null)}>Cancelar</Btn><Btn kind="primary" disabled={name.length < 3 || !pk} onClick={create}>Crear tabla</Btn></>}>
          {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
          <div className="sv-form">
            <Field label="Nombre de la tabla" hint="Entre 3 y 255 caracteres."><input className="k-input" type="text" aria-label="Nombre de la tabla" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
            <div className="sv-grid2">
              <Field label="Clave de partición"><input className="k-input" type="text" aria-label="Clave de partición" value={pk} onChange={(e) => setPk(e.target.value)} /></Field>
              <Field label="Tipo"><select className="k-input" aria-label="Tipo de la clave de partición" value={pkT} onChange={(e) => setPkT(e.target.value)}><option value="S">Cadena</option><option value="N">Número</option></select></Field>
              <Field label="Clave de ordenación (opcional)"><input className="k-input" type="text" aria-label="Clave de ordenación" value={sk} onChange={(e) => setSk(e.target.value)} /></Field>
              <Field label="Tipo"><select className="k-input" aria-label="Tipo de la clave de ordenación" value={skT} onChange={(e) => setSkT(e.target.value)}><option value="S">Cadena</option><option value="N">Número</option></select></Field>
            </div>
            <CliEquivalent cmd={cmd} />
          </div>
        </Modal>
      )}
      {modal === 'delete' && sel[0] && <ConfirmModal title="Eliminar tabla" confirmLabel="Eliminar" danger requireText="eliminar" onClose={() => setModal(null)} onConfirm={async () => { const r = await run(`aws dynamodb delete-table --table-name ${sel[0]}`); if (!r.ok) return r.msg; setFlash(`Se eliminó la tabla ${sel[0]}.`); setSel([]); }}>
        Se eliminará la tabla <b>{sel[0]}</b> y todos sus elementos.
      </ConfirmModal>}
    </>
  );
}

export function DdbDetail({ name }: { name: string }) {
  const s = useSvc();
  const [tab, setTab] = useState<'items' | 'info'>('items');
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [item, setItem] = useState('');
  const [adding, setAdding] = useState(false);
  const t = sv(s).tables.find((x) => x.name === name && x.region === s.region);
  if (!t) return <><Crumbs items={[ROOT]} /><NotFound what={`La tabla ${name} no existe en la región ${s.region}.`} /></>;
  const hash = t.keySchema.find((k) => k.KeyType === 'HASH')!.AttributeName;
  const range = t.keySchema.find((k) => k.KeyType === 'RANGE')?.AttributeName;
  const type = (a: string) => t.attrDefs.find((d) => d.AttributeName === a)?.AttributeType ?? 'S';
  const attrs = Array.from(new Set([hash, ...(range ? [range] : []), ...t.items.flatMap((i) => Object.keys(i))]));
  const template = JSON.stringify({ [hash]: { [type(hash)]: type(hash) === 'N' ? '1' : 'valor' }, ...(range ? { [range]: { [type(range)]: type(range) === 'N' ? '1' : 'valor' } } : {}), nombre: { S: 'Ejemplo' } }, null, 2);
  const putCmd = `aws dynamodb put-item --table-name ${t.name} --item ${sq(item.replace(/\s*\n\s*/g, ' ') || '<elemento JSON>')}`;
  const put = async () => { const r = await run(putCmd); if (!r.ok) return setErr(r.msg); setErr(''); setAdding(false); setFlash('Elemento guardado.'); };
  const delItem = async (i: any) => { const key = JSON.stringify(Object.fromEntries(t.keySchema.map((k) => [k.AttributeName, i[k.AttributeName]]))); const r = await run(`aws dynamodb delete-item --table-name ${t.name} --key ${sq(key)}`); if (!r.ok) return setErr(r.msg); setFlash('Elemento eliminado.'); };
  const status = tableStatus(t);
  return (
    <>
      <Crumbs items={[ROOT, { label: 'Tablas', to: '/dynamodb/tables' }, { label: t.name }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title={t.name}><Btn kind="danger" onClick={async () => { if (!confirm(`¿Eliminar la tabla ${t.name}?`)) return; const r = await run(`aws dynamodb delete-table --table-name ${t.name}`); if (!r.ok) return setErr(r.msg); setNextFlash(`Se eliminó la tabla ${t.name}.`); nav('/dynamodb/tables'); }}>Eliminar</Btn></PageHead>
      <Card title="Resumen"><Dl items={[['Estado', <St key="s" v={status} />], ['Clave de partición', `${hash} (${type(hash) === 'N' ? 'Número' : 'Cadena'})`], ['Clave de ordenación', range ?? '-'], ['Modo de capacidad', t.billingMode === 'PAY_PER_REQUEST' ? 'Bajo demanda' : `Aprovisionada (${t.rcu} RCU / ${t.wcu} WCU)`], ['Elementos', t.items.length], ['ARN', <span className="sv-url" key="a">{t.arn}</span>]]} /></Card>
      <Tabs cur={tab} onChange={setTab} tabs={[['items', 'Explorar elementos'], ['info', 'Índices y etiquetas']]} />
      {tab === 'items' && (
        <Card title="Elementos devueltos" count={t.items.length} flush actions={<Btn kind="primary" disabled={status !== 'ACTIVE'} onClick={() => { setItem(template); setAdding(true); }}>Crear elemento</Btn>}>
          <Table rows={t.items} id={(i) => JSON.stringify(t.keySchema.map((k) => i[k.AttributeName]))} filterPlaceholder="Filtrar elementos" empty={{ title: status === 'ACTIVE' ? 'La tabla no tiene elementos' : 'La tabla se está creando', desc: 'Cree un elemento para verlo aquí.' }} cols={[
            ...attrs.map((a) => ({ head: a, cell: (i: any) => (i[a] ? disp(i[a]) : ''), text: (i: any) => (i[a] ? disp(i[a]) : '') })),
            { head: 'Acciones', cell: (i: any) => <Btn small onClick={() => delItem(i)}>Eliminar</Btn> },
          ]} />
        </Card>
      )}
      {tab === 'info' && <Card title="Índices secundarios globales" count={t.gsis.length}>{t.gsis.length ? t.gsis.map((g) => <div key={g.IndexName}><b>{g.IndexName}</b> · {g.KeySchema.map((k) => `${k.AttributeName} (${k.KeyType})`).join(', ')}</div>) : <span className="sv-muted">Sin índices secundarios. Creada el {when(t.createdAt)}.</span>}</Card>}
      {adding && (
        <Modal title="Crear elemento" onClose={() => setAdding(false)} footer={<><Btn onClick={() => setAdding(false)}>Cancelar</Btn><Btn kind="primary" onClick={put}>Crear elemento</Btn></>}>
          {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
          <Field label="Elemento (JSON con tipos de DynamoDB)"><textarea className="sv-code" aria-label="Elemento JSON" spellCheck={false} value={item} onChange={(e) => setItem(e.target.value)} /></Field>
          <CliEquivalent cmd={putCmd} />
        </Modal>
      )}
    </>
  );
}

import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, Modal, PageHead, Table, nav } from '../../components/ui';
import { ConfirmModal, Dl, JsonEditor, Tabs, checkPolicy, pretty, run, tmpFile, policyKind, setNextFlash, takeFlash, PolicyBlock } from './kit';

export function Policies() {
  const s = useCloud();
  const [type, setType] = useState<'all' | 'aws' | 'customer'>('all');
  const [sel, setSel] = useState<string[]>([]);
  const [del, setDel] = useState(false);
  const [flash, setFlash] = useState(takeFlash);
  const rows = s.policies.filter((p) => type === 'all' || p.managed === type);
  const pol = s.policies.find((p) => p.arn === sel[0]);
  return (
    <>
      <Crumbs items={[{ label: 'IAM', to: '/iam' }, { label: 'Políticas' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <PageHead title="Políticas" desc="Una política es un objeto de AWS que define los permisos de una identidad o un recurso." />
      <Card title="Políticas" count={rows.length} flush actions={<><Btn small disabled={sel.length !== 1 || pol?.managed === 'aws'} onClick={() => setDel(true)}>Eliminar</Btn><Btn kind="primary" onClick={() => nav('/iam/policies/create')}>Crear política</Btn></>}>
        <Table rows={rows} id={(p) => p.arn} selected={sel} onSelect={(x) => setSel(x.slice(-1))} filterPlaceholder="Filtrar políticas por propiedad o nombre de política y presione Intro"
          toolbar={<select className="k-select" aria-label="Filtrar por tipo" value={type} onChange={(e) => setType(e.target.value as any)}><option value="all">Todos los tipos</option><option value="aws">Administrada por AWS</option><option value="customer">Administrada por el cliente</option></select>}
          empty={{ title: 'No hay recursos para mostrar', desc: 'No hay políticas.' }} cols={[
            { head: 'Nombre de la política', cell: (p) => <a onClick={() => nav('/iam/policies/' + encodeURIComponent(p.arn))}>{p.name}</a>, text: (p) => p.name },
            { head: 'Tipo', cell: (p) => policyKind(p.arn), text: (p) => policyKind(p.arn) },
            { head: 'Usada como', cell: (p) => (p.attachmentCount ? 'Política de permisos' : 'Ninguna') },
            { head: 'Entidades adjuntas', cell: (p) => p.attachmentCount },
            { head: 'Descripción', cell: (p) => <span className="k-muted">{p.description ?? '-'}</span>, text: (p) => p.description ?? '' },
          ]} />
      </Card>
      {del && pol && <ConfirmModal title={`¿Eliminar ${pol.name}?`} confirmLabel="Eliminar" danger requireText={pol.name} onClose={() => setDel(false)} onConfirm={async () => { const r = await run(`aws iam delete-policy --policy-arn ${pol.arn}`); if (!r.ok) return r.msg; setFlash(`Se eliminó la política ${pol.name}.`); setSel([]); }}><p>Esta acción no se puede deshacer. Si la política está adjunta a alguna entidad, AWS rechazará la eliminación.</p></ConfirmModal>}
    </>
  );
}

const EXAMPLE = pretty({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:GetObject'], Resource: '*' }] });

export function CreatePolicy() {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [doc, setDoc] = useState(EXAMPLE);
  const [err, setErr] = useState('');
  const s = useCloud();
  const exists = s.policies.some((p) => p.managed === 'customer' && p.name === name);
  const e = checkPolicy(doc, 'identity');
  const create = async () => {
    const r = await run(`aws iam create-policy --policy-name ${name} --policy-document ${tmpFile(doc)}${desc ? ` --description '${desc.replace(/'/g, '')}'` : ''}`);
    if (!r.ok) return setErr(r.msg);
    setNextFlash(`Se creó la política ${name}.`);
    nav('/iam/policies/' + encodeURIComponent(r.json.Policy.Arn));
  };
  return (
    <>
      <Crumbs items={[{ label: 'IAM', to: '/iam' }, { label: 'Políticas', to: '/iam/policies' }, { label: 'Crear política' }]} />
      <PageHead title="Crear política" desc="Una política define los permisos de AWS que puede asignar a un usuario, grupo o rol." />
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <Card title="Editor de políticas">
        <div className="k-tabs" style={{ padding: 0, marginBottom: 12 }}><a className="on">JSON</a></div>
        <JsonEditor kind="identity" value={doc} onChange={setDoc} />
      </Card>
      <Card title="Detalles de la política">
        <Field label="Nombre de la política" hint="Máximo 128 caracteres. Use caracteres alfanuméricos y + = , . @ _ -" error={exists ? 'Ya existe una política con ese nombre.' : name && !/^[\w+=,.@-]{1,128}$/.test(name) ? 'Nombre no válido.' : ''}><input type="text" value={name} onChange={(ev) => setName(ev.target.value)} /></Field>
        <Field label="Descripción - opcional"><input type="text" value={desc} onChange={(ev) => setDesc(ev.target.value)} /></Field>
      </Card>
      <CliEquivalent cmd={`aws iam create-policy --policy-name ${name || '<nombre>'} --policy-document file://policy.json`} />
      <div className="k-foot"><Btn onClick={() => nav('/iam/policies')}>Cancelar</Btn><Btn kind="primary" disabled={!name || exists || !!e} onClick={create}>Crear política</Btn></div>
    </>
  );
}

type Tab = 'perm' | 'ents';
export function PolicyDetail({ arn }: { arn: string }) {
  const s = useCloud();
  const p = s.policies.find((x) => x.arn === arn);
  const [tab, setTab] = useState<Tab>('perm');
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [modal, setModal] = useState<null | 'attach' | 'del'>(null);
  const [kind, setKind] = useState<'user' | 'group' | 'role'>('user');
  const [target, setTarget] = useState('');
  if (!p) return <><Crumbs items={[{ label: 'IAM', to: '/iam' }, { label: 'Políticas', to: '/iam/policies' }]} /><Flash kind="err" title="NoSuchEntity">Policy {arn} was not found.</Flash></>;
  const ents = [
    ...s.users.filter((u) => u.attached.includes(p.arn)).map((u) => ({ n: u.name, t: 'Usuario', to: '/iam/users/' + encodeURIComponent(u.name), kind: 'user' as const })),
    ...s.groups.filter((g) => g.attached.includes(p.arn)).map((g) => ({ n: g.name, t: 'Grupo', to: '/iam/groups/' + encodeURIComponent(g.name), kind: 'group' as const })),
    ...s.roles.filter((r) => r.attached.includes(p.arn)).map((r) => ({ n: r.name, t: 'Rol', to: '/iam/roles/' + encodeURIComponent(r.name), kind: 'role' as const })),
  ];
  const options = kind === 'user' ? s.users.map((u) => u.name) : kind === 'group' ? s.groups.map((g) => g.name) : s.roles.map((r) => r.name);
  const flag = kind === 'user' ? '--user-name' : kind === 'group' ? '--group-name' : '--role-name';
  const attach = async () => {
    const r = await run(`aws iam attach-${kind}-policy ${flag} ${target} --policy-arn ${p.arn}`);
    if (!r.ok) setErr(r.msg); else { setErr(''); setFlash(`Se adjuntó la política a ${target}.`); }
    setModal(null); setTarget('');
  };
  return (
    <>
      <Crumbs items={[{ label: 'IAM', to: '/iam' }, { label: 'Políticas', to: '/iam/policies' }, { label: p.name }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title={p.name}><Btn onClick={() => setModal('attach')}>Adjuntar</Btn><Btn disabled={p.managed === 'aws'} onClick={() => setModal('del')}>Eliminar</Btn></PageHead>
      <Card title="Detalles"><Dl items={[['Tipo', policyKind(p.arn)], ['ARN', p.arn], ['Entidades adjuntas', p.attachmentCount], ['Descripción', p.description || '-'], ['Versión predeterminada', p.defaultVersion]]} /></Card>
      <div className="card" style={{ marginBottom: 20 }}>
        <Tabs<Tab> active={tab} onChange={setTab} tabs={[{ id: 'perm', label: 'Permisos' }, { id: 'ents', label: 'Entidades adjuntas' }]} />
        {tab === 'perm' && <div className="body2" style={{ padding: 20 }}><h2 style={{ fontSize: 18, marginBottom: 8 }}>Documento de política (JSON)</h2><PolicyBlock doc={p.document} /></div>}
        {tab === 'ents' && <Table rows={ents} id={(e) => e.t + e.n} filterPlaceholder="Buscar" empty={{ title: 'Sin entidades adjuntas', desc: 'Esta política no está adjunta a ninguna entidad.' }} cols={[{ head: 'Nombre', cell: (e) => <a onClick={() => nav(e.to)}>{e.n}</a>, text: (e) => e.n }, { head: 'Tipo', cell: (e) => e.t }]} />}
      </div>
      {modal === 'attach' && (
        <Modal title="Adjuntar política" onClose={() => setModal(null)} footer={<><Btn onClick={() => setModal(null)}>Cancelar</Btn><Btn kind="primary" disabled={!target} onClick={attach}>Adjuntar política</Btn></>}>
          <Field label="Tipo de entidad"><select className="k-select" value={kind} onChange={(e) => { setKind(e.target.value as any); setTarget(''); }}><option value="user">Usuario</option><option value="group">Grupo de usuarios</option><option value="role">Rol</option></select></Field>
          <Field label="Entidad"><select className="k-select" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Entidad"><option value="">Elija una entidad</option>{options.map((o) => <option key={o}>{o}</option>)}</select></Field>
          <CliEquivalent cmd={`aws iam attach-${kind}-policy ${flag} ${target || '<nombre>'} --policy-arn ${p.arn}`} />
        </Modal>
      )}
      {modal === 'del' && <ConfirmModal title={`¿Eliminar ${p.name}?`} confirmLabel="Eliminar" danger requireText={p.name} onClose={() => setModal(null)} onConfirm={async () => { const r = await run(`aws iam delete-policy --policy-arn ${p.arn}`); if (!r.ok) return r.msg; setNextFlash(`Se eliminó la política ${p.name}.`); nav('/iam/policies'); }}><p>Esta acción no se puede deshacer.</p></ConfirmModal>}
    </>
  );
}

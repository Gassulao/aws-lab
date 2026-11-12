import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, Modal, PageHead, Table, nav, fmtDate } from '../../components/ui';
import { Dl, Tabs, run, lastSeg, policyKind, setNextFlash, takeFlash } from './kit';
import { PolicyPicker } from './Pickers';

export function Groups() {
  const s = useCloud();
  return (
    <>
      <Crumbs items={[{ label: 'IAM', to: '/iam' }, { label: 'Grupos de usuarios' }]} />
      <PageHead title="Grupos de usuarios" desc="Un grupo de usuarios es una colección de usuarios de IAM. Utilice los grupos para especificar permisos para varios usuarios." />
      <Card title="Grupos de usuarios" count={s.groups.length} flush actions={<Btn kind="primary" onClick={() => nav('/iam/groups/create')}>Crear grupo</Btn>}>
        <Table rows={s.groups} id={(g) => g.name} filterPlaceholder="Buscar" empty={{ title: 'No hay recursos para mostrar', desc: 'No hay grupos de usuarios en esta cuenta.' }} cols={[
          { head: 'Nombre del grupo', cell: (g) => <a onClick={() => nav('/iam/groups/' + encodeURIComponent(g.name))}>{g.name}</a>, text: (g) => g.name },
          { head: 'Usuarios', cell: (g) => g.members.length },
          { head: 'Permisos', cell: (g) => (g.attached.length || Object.keys(g.inline).length ? 'Definidos' : 'No definidos') },
          { head: 'Fecha de creación', cell: (g) => fmtDate(g.createdAt), text: (g) => g.createdAt },
        ]} />
      </Card>
    </>
  );
}

export function CreateGroup() {
  const s = useCloud();
  const [name, setName] = useState('');
  const [users, setUsers] = useState<string[]>([]);
  const [pols, setPols] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const bad = name && !/^[\w+=,.@-]{1,128}$/.test(name) ? 'Nombre de grupo no válido.' : s.groups.some((g) => g.name === name) ? 'Ya existe un grupo con ese nombre.' : '';
  const create = async () => {
    const r = await run(`aws iam create-group --group-name ${name}`);
    if (!r.ok) return setErr(r.msg);
    for (const u of users) { const x = await run(`aws iam add-user-to-group --group-name ${name} --user-name ${u}`); if (!x.ok) return setErr(x.msg); }
    for (const a of pols) { const x = await run(`aws iam attach-group-policy --group-name ${name} --policy-arn ${a}`); if (!x.ok) return setErr(x.msg); }
    setNextFlash(`Se creó el grupo ${name}.`);
    nav('/iam/groups/' + encodeURIComponent(name));
  };
  return (
    <>
      <Crumbs items={[{ label: 'IAM', to: '/iam' }, { label: 'Grupos de usuarios', to: '/iam/groups' }, { label: 'Crear grupo' }]} />
      <PageHead title="Crear grupo de usuarios" />
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <Card title="Nombre del grupo de usuarios"><Field label="Nombre del grupo de usuarios" hint="Máximo 128 caracteres. Se permiten caracteres alfanuméricos y + = , . @ _ -" error={bad}><input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field></Card>
      <Card title="Agregar usuarios al grupo - opcional" count={users.length} flush>
        <Table rows={s.users} id={(u) => u.name} selected={users} onSelect={setUsers} filterPlaceholder="Buscar usuarios" empty={{ title: 'No hay usuarios' }} cols={[{ head: 'Nombre de usuario', cell: (u) => u.name, text: (u) => u.name }, { head: 'Grupos', cell: (u) => s.groups.filter((g) => g.members.includes(u.name)).length }]} />
      </Card>
      <Card title="Adjuntar políticas de permisos - opcional" count={pols.length} flush><PolicyPicker selected={pols} onChange={setPols} /></Card>
      <CliEquivalent cmd={`aws iam create-group --group-name ${name || '<nombre>'}`} />
      <div className="k-foot"><Btn onClick={() => nav('/iam/groups')}>Cancelar</Btn><Btn kind="primary" disabled={!name || !!bad} onClick={create}>Crear grupo</Btn></div>
    </>
  );
}

type Tab = 'users' | 'perm';
export function GroupDetail({ name }: { name: string }) {
  const s = useCloud();
  const g = s.groups.find((x) => x.name === name);
  const [tab, setTab] = useState<Tab>('users');
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [modal, setModal] = useState<'users' | 'perm' | null>(null);
  const [pick, setPick] = useState<string[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  if (!g) return <><Crumbs items={[{ label: 'IAM', to: '/iam' }, { label: 'Grupos de usuarios', to: '/iam/groups' }]} /><Flash kind="err" title="NoSuchEntity">The group with name {name} cannot be found.</Flash></>;
  const close = () => { setModal(null); setPick([]); };
  const exec = async (cmds: string[], ok: string) => {
    for (const c of cmds) { const r = await run(c); if (!r.ok) { setErr(r.msg); close(); return; } }
    setErr(''); setFlash(ok); close(); setSel([]);
  };
  return (
    <>
      <Crumbs items={[{ label: 'IAM', to: '/iam' }, { label: 'Grupos de usuarios', to: '/iam/groups' }, { label: g.name }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title={g.name} />
      <Card title="Resumen"><Dl items={[['Fecha de creación', fmtDate(g.createdAt)], ['ARN', g.arn], ['Usuarios', g.members.length]]} /></Card>
      <div className="card" style={{ marginBottom: 20 }}>
        <Tabs<Tab> active={tab} onChange={setTab} tabs={[{ id: 'users', label: 'Usuarios' }, { id: 'perm', label: 'Permisos' }]} />
        {tab === 'users' && (
          <div>
            <div style={{ padding: '14px 20px', display: 'flex', justifyContent: 'space-between' }}>
              <h2 style={{ fontSize: 18 }}>Usuarios del grupo <span className="k-muted" style={{ fontWeight: 400 }}>({g.members.length})</span></h2>
              <div className="actions"><Btn small disabled={!sel.length} onClick={() => exec(sel.map((u) => `aws iam remove-user-from-group --group-name ${g.name} --user-name ${u}`), `Se quitaron ${sel.length} usuario(s) del grupo.`)}>Quitar usuarios</Btn><Btn small kind="primary" onClick={() => setModal('users')}>Agregar usuarios</Btn></div>
            </div>
            <Table rows={g.members} id={(m) => m} selected={sel} onSelect={setSel} filterPlaceholder="Buscar" empty={{ title: 'Sin usuarios', desc: 'Este grupo no tiene usuarios.' }} cols={[{ head: 'Nombre de usuario', cell: (m) => <a onClick={() => nav('/iam/users/' + encodeURIComponent(m))}>{m}</a>, text: (m) => m }, { head: 'Grupos', cell: (m) => s.groups.filter((x) => x.members.includes(m)).length }]} />
          </div>
        )}
        {tab === 'perm' && (
          <div>
            <div style={{ padding: '14px 20px', display: 'flex', justifyContent: 'space-between' }}>
              <h2 style={{ fontSize: 18 }}>Políticas de permisos <span className="k-muted" style={{ fontWeight: 400 }}>({g.attached.length + Object.keys(g.inline).length})</span></h2>
              <Btn small kind="primary" onClick={() => setModal('perm')}>Agregar permisos</Btn>
            </div>
            <Table rows={[...g.attached.map((a) => ({ n: lastSeg(a), t: policyKind(a), arn: a })), ...Object.keys(g.inline).map((n) => ({ n, t: 'En línea', arn: '' }))]} id={(r) => r.n} filterPlaceholder="Buscar" empty={{ title: 'Sin permisos', desc: 'Este grupo no tiene políticas adjuntas.' }} cols={[
              { head: 'Nombre de la política', cell: (r) => (r.arn ? <a onClick={() => nav('/iam/policies/' + encodeURIComponent(r.arn))}>{r.n}</a> : r.n), text: (r) => r.n }, { head: 'Tipo', cell: (r) => r.t },
            ]} />
          </div>
        )}
      </div>
      {modal === 'users' && (
        <Modal title="Agregar usuarios al grupo" onClose={close} footer={<><Btn onClick={close}>Cancelar</Btn><Btn kind="primary" disabled={!pick.length} onClick={() => exec(pick.map((u) => `aws iam add-user-to-group --group-name ${g.name} --user-name ${u}`), `Se agregaron ${pick.length} usuario(s) al grupo.`)}>Agregar usuarios</Btn></>}>
          <Table rows={s.users.filter((u) => !g.members.includes(u.name))} id={(u) => u.name} selected={pick} onSelect={setPick} filterPlaceholder="Buscar usuarios" empty={{ title: 'No hay usuarios disponibles' }} cols={[{ head: 'Nombre de usuario', cell: (u) => u.name, text: (u) => u.name }]} />
        </Modal>
      )}
      {modal === 'perm' && (
        <Modal title="Agregar permisos" onClose={close} footer={<><Btn onClick={close}>Cancelar</Btn><Btn kind="primary" disabled={!pick.length} onClick={() => exec(pick.map((a) => `aws iam attach-group-policy --group-name ${g.name} --policy-arn ${a}`), `Se adjuntaron ${pick.length} política(s).`)}>Agregar permisos</Btn></>}>
          <PolicyPicker selected={pick} onChange={setPick} exclude={g.attached} />
        </Modal>
      )}
    </>
  );
}

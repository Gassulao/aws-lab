import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, Modal, PageHead, Table, nav, fmtDate } from '../../components/ui';
import { ConfirmModal, Dl, Tabs, run, takeFlash, policyKind, lastSeg, ago, days, PolicyBlock } from './kit';
import { PolicyPicker } from './Pickers';
import { deleteUserDeep } from './Users';

type Tab = 'perm' | 'groups' | 'tags' | 'sec';

export function UserDetail({ name }: { name: string }) {
  const s = useCloud();
  const u = s.users.find((x) => x.name === name);
  const [tab, setTab] = useState<Tab>('perm');
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [modal, setModal] = useState<null | 'addperm' | 'addgroup' | 'del' | 'newkey' | 'mfa' | { delkey: string } | { rm: string } | { detach: string } | { doc: string }>(null);
  const [pick, setPick] = useState<string[]>([]);
  const [secret, setSecret] = useState<{ id: string; secret: string } | null>(null);
  const [mfaName, setMfaName] = useState('');
  if (!u) return <><Crumbs items={[{ label: 'IAM', to: '/iam' }, { label: 'Usuarios', to: '/iam/users' }]} /><Flash kind="err" title="NoSuchEntity">The user with name {name} cannot be found.</Flash></>;
  const myGroups = s.groups.filter((g) => g.members.includes(u.name));
  const close = () => { setModal(null); setPick([]); };
  const exec = async (cmds: string[], ok: string) => {
    for (const c of cmds) {
      const r = await run(c);
      if (!r.ok) { setErr(r.msg); close(); return r.msg; }
    }
    setErr(''); setFlash(ok); close();
  };
  const mod = modal as any;
  const pols = s.policies;
  return (
    <>
      <Crumbs items={[{ label: 'IAM', to: '/iam' }, { label: 'Usuarios', to: '/iam/users' }, { label: u.name }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title={u.name}><Btn onClick={() => setModal('del')}>Eliminar</Btn></PageHead>
      <Card title="Resumen">
        <Dl items={[
          ['ARN', u.arn],
          ['Acceso a la consola', u.hasConsolePassword ? 'Habilitado' : 'Deshabilitado'],
          ['Clave de acceso 1', u.accessKeys[0] ? `${u.accessKeys[0].id} - ${u.accessKeys[0].status === 'Active' ? 'Activa' : 'Inactiva'}` : 'No habilitado'],
          ['Creado', fmtDate(u.createdAt)],
          ['Última actividad de la consola', u.hasConsolePassword ? ago(s.trail.filter((e) => e.userName === u.name).map((e) => e.time).sort().pop()) : '-'],
          ['Clave de acceso 2', u.accessKeys[1] ? `${u.accessKeys[1].id} - ${u.accessKeys[1].status === 'Active' ? 'Activa' : 'Inactiva'}` : 'No habilitado'],
        ]} />
      </Card>
      <div className="card" style={{ marginBottom: 20 }}>
        <Tabs<Tab> active={tab} onChange={setTab} tabs={[{ id: 'perm', label: 'Permisos' }, { id: 'groups', label: 'Grupos' }, { id: 'tags', label: 'Etiquetas' }, { id: 'sec', label: 'Credenciales de seguridad' }]} />
        {tab === 'perm' && (
          <div>
            <div className="head" style={{ padding: '14px 20px', display: 'flex', justifyContent: 'space-between' }}>
              <h2 style={{ fontSize: 18 }}>Políticas de permisos <span className="k-muted" style={{ fontWeight: 400 }}>({u.attached.length + Object.keys(u.inline).length})</span></h2>
              <Btn kind="primary" small onClick={() => setModal('addperm')}>Agregar permisos</Btn>
            </div>
            <Table rows={[...u.attached.map((a) => ({ n: lastSeg(a), t: policyKind(a), how: 'Directamente', arn: a })), ...myGroups.flatMap((g) => g.attached.map((a) => ({ n: lastSeg(a), t: policyKind(a), how: `Grupo ${g.name}`, arn: '' }))), ...Object.keys(u.inline).map((n) => ({ n, t: 'En línea', how: 'Directamente', arn: '' }))]}
              id={(r) => r.n + r.how} filterPlaceholder="Buscar" empty={{ title: 'Sin permisos', desc: 'Este usuario no tiene políticas.' }} cols={[
                { head: 'Nombre de la política', cell: (r) => (r.arn ? <a onClick={() => nav('/iam/policies/' + encodeURIComponent(r.arn))}>{r.n}</a> : r.n), text: (r) => r.n },
                { head: 'Tipo', cell: (r) => r.t }, { head: 'Adjunta mediante', cell: (r) => r.how },
                { head: '', cell: (r) => (r.how === 'Directamente' && r.arn ? <Btn kind="link" onClick={() => setModal({ detach: r.arn })}>Quitar</Btn> : null) },
              ]} />
            <div className="body2" style={{ padding: '0 20px 16px' }}><span className="k-muted">Límite de permisos: </span>{u.permissionsBoundary ? lastSeg(u.permissionsBoundary) : 'No establecido'}</div>
          </div>
        )}
        {tab === 'groups' && (
          <div>
            <div className="head" style={{ padding: '14px 20px', display: 'flex', justifyContent: 'space-between' }}>
              <h2 style={{ fontSize: 18 }}>Pertenencia a grupos de usuarios <span className="k-muted" style={{ fontWeight: 400 }}>({myGroups.length})</span></h2>
              <Btn small onClick={() => setModal('addgroup')}>Agregar usuario a grupos</Btn>
            </div>
            <Table rows={myGroups} id={(g) => g.name} filterPlaceholder="Buscar" empty={{ title: 'No pertenece a ningún grupo', desc: 'Agregue el usuario a un grupo para darle permisos.' }} cols={[
              { head: 'Nombre del grupo', cell: (g) => <a onClick={() => nav('/iam/groups/' + encodeURIComponent(g.name))}>{g.name}</a>, text: (g) => g.name },
              { head: 'Políticas adjuntas', cell: (g) => g.attached.map(lastSeg).join(', ') || '-' },
              { head: '', cell: (g) => <Btn kind="link" onClick={() => setModal({ rm: g.name })}>Quitar</Btn> },
            ]} />
          </div>
        )}
        {tab === 'tags' && (
          <div>
            <div className="head" style={{ padding: '14px 20px' }}><h2 style={{ fontSize: 18 }}>Etiquetas <span className="k-muted" style={{ fontWeight: 400 }}>({Object.keys(u.tags).length})</span></h2></div>
            <Table rows={Object.entries(u.tags)} id={([k]) => k} filterPlaceholder="Buscar etiquetas" empty={{ title: 'Sin etiquetas', desc: 'Las etiquetas se asignan al crear el usuario.' }} cols={[{ head: 'Clave', cell: ([k]) => k }, { head: 'Valor', cell: ([, v]) => v || '-' }]} />
          </div>
        )}
        {tab === 'sec' && (
          <div>
            <div className="body2" style={{ padding: '16px 20px' }}>
              <h2 style={{ fontSize: 18, marginBottom: 12 }}>Resumen de credenciales</h2>
              <Dl cols={2} items={[['Acceso a la consola', u.hasConsolePassword ? 'Habilitado' : 'Deshabilitado'], ['Antigüedad de la contraseña', u.hasConsolePassword ? days(u.createdAt) : '-']]} />
            </div>
            <div className="head" style={{ padding: '14px 20px', display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--line)' }}>
              <h2 style={{ fontSize: 18 }}>Autenticación multifactor (MFA) <span className="k-muted" style={{ fontWeight: 400 }}>({u.mfaDevices.length})</span></h2>
              <Btn small disabled={u.mfaDevices.length >= 8} onClick={() => { setMfaName(u.name); setModal('mfa'); }}>Asignar dispositivo MFA</Btn>
            </div>
            <Table rows={u.mfaDevices} id={(d) => d} filterPlaceholder="Buscar" empty={{ title: 'Sin dispositivos MFA', desc: 'Asigne un dispositivo MFA para mejorar la seguridad.' }} cols={[{ head: 'Identificador', cell: (d) => d }, { head: 'Tipo', cell: () => 'Virtual' }]} />
            <div className="head" style={{ padding: '14px 20px', display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--line)' }}>
              <h2 style={{ fontSize: 18 }}>Claves de acceso <span className="k-muted" style={{ fontWeight: 400 }}>({u.accessKeys.length})</span></h2>
              <Btn small disabled={u.accessKeys.length >= 2} onClick={async () => {
                const r = await run(`aws iam create-access-key --user-name ${u.name}`);
                if (!r.ok) return setErr(r.msg);
                setErr(''); setSecret({ id: r.json.AccessKey.AccessKeyId, secret: r.json.AccessKey.SecretAccessKey }); setModal('newkey');
              }}>Crear clave de acceso</Btn>
            </div>
            {u.accessKeys.length >= 2 && <div className="k-muted" style={{ padding: '0 20px 8px' }}>Cada usuario puede tener un máximo de dos claves de acceso.</div>}
            <Table rows={u.accessKeys} id={(k) => k.id} filterPlaceholder="Buscar" empty={{ title: 'Sin claves de acceso', desc: 'Cree una clave de acceso para acceso programático.' }} cols={[
              { head: 'ID de clave de acceso', cell: (k) => k.id, text: (k) => k.id },
              { head: 'Estado', cell: (k) => <span className={`k-badge ${k.status === 'Active' ? 'ok' : ''}`}>{k.status === 'Active' ? 'Activa' : 'Inactiva'}</span> },
              { head: 'Creada', cell: (k) => ago(k.createdAt) },
              { head: 'Acciones', cell: (k) => (
                <>
                  <Btn kind="link" onClick={() => exec([`aws iam update-access-key --user-name ${u.name} --access-key-id ${k.id} --status ${k.status === 'Active' ? 'Inactive' : 'Active'}`], `Se ${k.status === 'Active' ? 'desactivó' : 'activó'} la clave de acceso ${k.id}.`)}>{k.status === 'Active' ? 'Desactivar' : 'Activar'}</Btn>
                  <Btn kind="link" onClick={() => setModal({ delkey: k.id })}>Eliminar</Btn>
                </>
              ) },
            ]} />
          </div>
        )}
      </div>

      {modal === 'addperm' && (
        <Modal title="Agregar permisos" onClose={close} footer={<><Btn onClick={close}>Cancelar</Btn><Btn kind="primary" disabled={!pick.length} onClick={() => exec(pick.map((a) => `aws iam attach-user-policy --user-name ${u.name} --policy-arn ${a}`), `Se adjuntaron ${pick.length} política(s) a ${u.name}.`)}>Agregar permisos</Btn></>}>
          <p>Seleccione las políticas administradas que desea adjuntar directamente al usuario.</p>
          <PolicyPicker selected={pick} onChange={setPick} exclude={u.attached} />
          <CliEquivalent cmd={`aws iam attach-user-policy --user-name ${u.name} --policy-arn <arn>`} />
        </Modal>
      )}
      {modal === 'addgroup' && (
        <Modal title="Agregar usuario a grupos" onClose={close} footer={<><Btn onClick={close}>Cancelar</Btn><Btn kind="primary" disabled={!pick.length} onClick={() => exec(pick.map((g) => `aws iam add-user-to-group --group-name ${g} --user-name ${u.name}`), `Se agregó ${u.name} a ${pick.length} grupo(s).`)}>Agregar a grupos</Btn></>}>
          <Table rows={s.groups.filter((g) => !g.members.includes(u.name))} id={(g) => g.name} selected={pick} onSelect={setPick} filterPlaceholder="Buscar grupos" empty={{ title: 'No hay grupos disponibles', desc: 'Cree un grupo en IAM > Grupos de usuarios.' }} cols={[{ head: 'Nombre del grupo', cell: (g) => g.name, text: (g) => g.name }, { head: 'Políticas', cell: (g) => g.attached.map(lastSeg).join(', ') || '-' }]} />
        </Modal>
      )}
      {mod?.detach && <ConfirmModal title="Quitar política" confirmLabel="Quitar" danger onConfirm={async () => exec([`aws iam detach-user-policy --user-name ${u.name} --policy-arn ${mod.detach}`], `Se quitó ${lastSeg(mod.detach)}.`)} onClose={close}><p>¿Quitar la política <b>{lastSeg(mod.detach)}</b> del usuario <b>{u.name}</b>?</p></ConfirmModal>}
      {mod?.rm && <ConfirmModal title="Quitar del grupo" confirmLabel="Quitar" danger onConfirm={async () => exec([`aws iam remove-user-from-group --group-name ${mod.rm} --user-name ${u.name}`], `Se quitó a ${u.name} del grupo ${mod.rm}.`)} onClose={close}><p>¿Quitar a <b>{u.name}</b> del grupo <b>{mod.rm}</b>?</p></ConfirmModal>}
      {mod?.delkey && <ConfirmModal title="Eliminar clave de acceso" confirmLabel="Eliminar" danger requireText={mod.delkey} onConfirm={async () => exec([`aws iam delete-access-key --user-name ${u.name} --access-key-id ${mod.delkey}`], `Se eliminó la clave de acceso ${mod.delkey}.`)} onClose={close}><p>Las aplicaciones que usen esta clave dejarán de tener acceso. Esta acción no se puede deshacer.</p></ConfirmModal>}
      {modal === 'del' && (
        <ConfirmModal title={`¿Eliminar ${u.name}?`} confirmLabel="Eliminar usuario" danger requireText="confirmar" onConfirm={async () => { const e = await deleteUserDeep(u, s.groups); if (!e) nav('/iam/users'); return e; }} onClose={close}>
          <p>Se eliminarán el usuario, sus claves de acceso, pertenencias a grupos y políticas adjuntas.</p>
        </ConfirmModal>
      )}
      {modal === 'newkey' && secret && (
        <Modal title="Clave de acceso creada" onClose={() => { setSecret(null); close(); }} footer={<Btn kind="primary" onClick={() => { setSecret(null); close(); }}>Listo</Btn>}>
          <Flash kind="info" title="Esta es la única vez que podrá ver la clave de acceso secreta.">Guárdela en un lugar seguro; no podrá recuperarla después. Si la pierde, cree una nueva.</Flash>
          <div className="k-dl" style={{ display: 'grid', gap: 12 }}>
            <div><div className="k">ID de clave de acceso</div><div className="k-secret">{secret.id}</div></div>
            <div><div className="k">Clave de acceso secreta</div><div className="k-secret" data-testid="secret">{secret.secret}</div></div>
          </div>
        </Modal>
      )}
      {modal === 'mfa' && (
        <Modal title="Asignar dispositivo MFA" onClose={close} footer={<><Btn onClick={close}>Cancelar</Btn><Btn kind="primary" disabled={!mfaName} onClick={() => exec([`aws iam enable-mfa-device --user-name ${u.name} --serial-number arn:aws:iam::${s.account.id}:mfa/${mfaName}`], 'Se asignó el dispositivo MFA.')}>Agregar MFA</Btn></>}>
          <Field label="Nombre del dispositivo" hint="Escriba un nombre significativo para identificar el dispositivo. Máximo 128 caracteres."><input className="k-input" type="text" value={mfaName} onChange={(e) => setMfaName(e.target.value)} /></Field>
          <div className="k-muted">Tipo de dispositivo: aplicación de autenticación (virtual). El simulador no valida los códigos.</div>
        </Modal>
      )}
      {mod?.doc && <Modal title="Política" onClose={close}><PolicyBlock doc={pols.find((p) => p.arn === mod.doc)?.document} /></Modal>}
    </>
  );
}

import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, Crumbs, Flash, PageHead, Table, nav } from '../../components/ui';
import { ConfirmModal, days, ago, run, lastSeg } from './kit';
import { fmtDate } from '../../components/ui';
import type { IamUser } from '../../../engine/types';

export async function deleteUserDeep(u: IamUser, groups: { name: string; members: string[] }[]): Promise<string> {
  for (const g of groups.filter((g) => g.members.includes(u.name))) {
    const r = await run(`aws iam remove-user-from-group --group-name ${g.name} --user-name ${u.name}`);
    if (!r.ok) return r.msg;
  }
  for (const a of u.attached) {
    const r = await run(`aws iam detach-user-policy --user-name ${u.name} --policy-arn ${a}`);
    if (!r.ok) return r.msg;
  }
  for (const k of u.accessKeys) {
    const r = await run(`aws iam delete-access-key --user-name ${u.name} --access-key-id ${k.id}`);
    if (!r.ok) return r.msg;
  }
  const r = await run(`aws iam delete-user --user-name ${u.name}`);
  return r.ok ? '' : r.msg;
}

export function Users() {
  const s = useCloud();
  const [sel, setSel] = useState<string[]>([]);
  const [del, setDel] = useState(false);
  const [msg, setMsg] = useState('');
  const lastAct = (n: string) => s.trail.filter((e) => e.userName === n).map((e) => e.time).sort().pop();
  const activeKey = (u: IamUser) => u.accessKeys.find((k) => k.status === 'Active');
  return (
    <>
      <Crumbs items={[{ label: 'IAM', to: '/iam' }, { label: 'Usuarios' }]} />
      {msg && <Flash kind="ok" onClose={() => setMsg('')}>{msg}</Flash>}
      <PageHead title="Usuarios" desc="Un usuario de IAM es una identidad con credenciales a largo plazo que se utiliza para interactuar con AWS en una cuenta." />
      <Card title="Usuarios" count={s.users.length} flush actions={<><Btn small disabled={sel.length !== 1} onClick={() => setDel(true)}>Eliminar</Btn><Btn kind="primary" onClick={() => nav('/iam/users/create')}>Crear usuario</Btn></>}>
        <Table rows={s.users} id={(u) => u.name} selected={sel} onSelect={setSel} filterPlaceholder="Buscar" empty={{ title: 'No hay recursos para mostrar', desc: 'No hay usuarios de IAM en esta cuenta.' }} cols={[
          { head: 'Nombre de usuario', cell: (u) => <a onClick={() => nav('/iam/users/' + encodeURIComponent(u.name))}>{u.name}</a>, text: (u) => u.name },
          { head: 'Ruta', cell: (u) => u.path },
          { head: 'Grupos', cell: (u) => s.groups.filter((g) => g.members.includes(u.name)).length },
          { head: 'Última actividad', cell: (u) => ago(lastAct(u.name)), text: (u) => ago(lastAct(u.name)) },
          { head: 'MFA', cell: (u) => (u.mfaDevices.length ? 'Virtual' : '-'), text: (u) => (u.mfaDevices.length ? 'Virtual' : '') },
          { head: 'Antigüedad de la contraseña', cell: (u) => (u.hasConsolePassword ? days(u.createdAt) : '-'), text: (u) => (u.hasConsolePassword ? days(u.createdAt) : '') },
          { head: 'Antigüedad de la clave de acceso', cell: (u) => (activeKey(u) ? days(activeKey(u)!.createdAt) : '-'), text: (u) => (activeKey(u) ? days(activeKey(u)!.createdAt) : '') },
          { head: 'Creado', cell: (u) => fmtDate(u.createdAt), text: (u) => u.createdAt },
        ]} />
      </Card>
      {del && (
        <ConfirmModal title={`¿Eliminar ${sel[0]}?`} confirmLabel="Eliminar usuario" danger requireText="confirmar"
          onConfirm={async () => {
            const u = s.users.find((x) => x.name === sel[0])!;
            const e = await deleteUserDeep(u, s.groups);
            if (!e) { setMsg(`Se eliminó el usuario ${u.name}.`); setSel([]); }
            return e;
          }}
          onClose={() => setDel(false)}>
          <p>Se eliminarán de forma permanente el usuario, sus claves de acceso y sus pertenencias a grupos y políticas adjuntas. Esta acción no se puede deshacer.</p>
          <p className="k-muted">Políticas adjuntas: {s.users.find((x) => x.name === sel[0])?.attached.map(lastSeg).join(', ') || 'ninguna'}</p>
        </ConfirmModal>
      )}
    </>
  );
}

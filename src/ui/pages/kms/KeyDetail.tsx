import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, Crumbs, Field, Flash, PageHead, Table, fmtDate, nav } from '../../components/ui';
import { ConfirmModal, Dl, JsonEditor, Menu, Tabs, checkPolicy, pretty, run, takeFlash, tmpFile } from '../iam/kit';
import { aliasesOf, keyStatus } from './common';
import { settleKms } from '../../../engine/services/kms';

type Tab = 'gen' | 'policy' | 'crypto' | 'alias' | 'tags' | 'grants';

export function KeyDetail({ id }: { id: string }) {
  const s = useCloud();
  settleKms(s);
  const k = s.kmsKeys.find((x) => x.id === id);
  const [tab, setTab] = useState<Tab>('gen');
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [modal, setModal] = useState<null | 'del' | 'alias' | 'dis'>(null);
  const [doc, setDoc] = useState('');
  const [edit, setEdit] = useState(false);
  const [alias, setAlias] = useState('');
  const [windowDays, setWindowDays] = useState('30');
  if (!k) return <><Crumbs items={[{ label: 'Key Management Service (KMS)', to: '/kms/keys' }]} /><Flash kind="err" title="NotFoundException">Key '{id}' does not exist</Flash></>;
  const names = aliasesOf(s, k);
  const act = async (cmd: string, ok: string) => {
    const r = await run(cmd);
    if (!r.ok) { setErr(r.msg); return r.msg; }
    setErr(''); setFlash(ok);
  };
  const customer = k.manager === 'CUSTOMER';
  return (
    <>
      <Crumbs items={[{ label: 'Key Management Service (KMS)', to: '/kms/keys' }, { label: customer ? 'Claves administradas por el cliente' : 'Claves administradas por AWS', to: customer ? '/kms/keys' : '/kms/aws-keys' }, { label: names[0] ?? k.id }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      {k.state === 'PendingDeletion' && <Flash kind="info" title="Esta clave está pendiente de eliminación">Se eliminará de forma permanente el {fmtDate(k.deletionDate)}. Mientras tanto no se puede usar para operaciones criptográficas. Puede cancelar la eliminación.</Flash>}
      <PageHead title={names[0] ?? k.id}>
        {customer && (
          <Menu label="Acciones de claves" items={[
            ...(k.state === 'Enabled' ? [{ label: 'Deshabilitar', onClick: () => setModal('dis') }] : []),
            ...(k.state === 'Disabled' ? [{ label: 'Habilitar', onClick: () => void act(`aws kms enable-key --key-id ${k.id}`, 'Se habilitó la clave.') }] : []),
            ...(k.state === 'PendingDeletion' ? [{ label: 'Cancelar eliminación de la clave', onClick: () => void act(`aws kms cancel-key-deletion --key-id ${k.id}`, 'Se canceló la eliminación. La clave quedó deshabilitada; habilítela para volver a usarla.') }] : [{ label: 'Programar eliminación de la clave', onClick: () => setModal('del') }]),
          ]} />
        )}
      </PageHead>
      <div className="card" style={{ marginBottom: 20 }}>
        <Tabs<Tab> active={tab} onChange={setTab} tabs={[{ id: 'gen', label: 'Configuración general' }, { id: 'policy', label: 'Política de clave' }, { id: 'crypto', label: 'Configuración criptográfica' }, { id: 'alias', label: 'Alias' }, { id: 'tags', label: 'Etiquetas' }, { id: 'grants', label: 'Concesiones (grants)' }]} />
        {tab === 'gen' && (
          <div className="body2">
            <Dl items={[['Alias', names.join(', ') || '–'], ['Estado', keyStatus(k)], ['ARN', k.arn], ['ID de clave', k.id], ['Fecha de creación', fmtDate(k.createdAt)], ['Descripción', k.description || '–'], ['Regionalidad', 'Región única'], ['Administrador', customer ? 'Cliente' : 'AWS']]} />
          </div>
        )}
        {tab === 'policy' && (
          <div className="body2">
            {!edit ? (
              <>
                <pre className="k-pre">{pretty(k.policy)}</pre>
                {customer && <div style={{ marginTop: 10 }}><Btn onClick={() => { setDoc(pretty(k.policy)); setEdit(true); }}>Editar</Btn></div>}
              </>
            ) : (
              <>
                <JsonEditor value={doc} onChange={setDoc} kind="resource" rows={18} />
                <div className="k-foot"><Btn onClick={() => setEdit(false)}>Cancelar</Btn><Btn kind="primary" disabled={!!checkPolicy(doc, 'resource')} onClick={async () => { const e = await act(`aws kms put-key-policy --key-id ${k.id} --policy-name default --policy ${tmpFile(doc)}`, 'Se actualizó la política de clave.'); if (!e) setEdit(false); }}>Guardar cambios</Btn></div>
              </>
            )}
          </div>
        )}
        {tab === 'crypto' && (
          <div className="body2">
            <Dl items={[['Tipo de clave', 'Simétrica'], ['Especificación de clave', 'SYMMETRIC_DEFAULT'], ['Origen del material de clave', 'KMS'], ['Uso de claves', 'Cifrar y descifrar'], ['Rotación automática', k.rotation ? `Habilitada (cada ${k.rotationDays} días)` : 'Deshabilitada']]} />
            {customer && (
              <div style={{ marginTop: 14 }}>
                <label className="k-switch"><input type="checkbox" checked={k.rotation} disabled={k.state !== 'Enabled'} onChange={() => void act(k.rotation ? `aws kms disable-key-rotation --key-id ${k.id}` : `aws kms enable-key-rotation --key-id ${k.id} --rotation-period-in-days 365`, k.rotation ? 'Se deshabilitó la rotación automática.' : 'Se habilitó la rotación automática cada 365 días.')} /> Rotación automática de la clave</label>
              </div>
            )}
          </div>
        )}
        {tab === 'alias' && (
          <div>
            <div className="head" style={{ padding: '14px 20px', display: 'flex', justifyContent: 'space-between' }}>
              <h2 style={{ fontSize: 18 }}>Alias <span className="k-muted" style={{ fontWeight: 400 }}>({names.length})</span></h2>
              {customer && <Btn small onClick={() => { setAlias(''); setModal('alias'); }}>Crear alias</Btn>}
            </div>
            <Table rows={names} id={(n) => n} empty={{ title: 'Sin alias', desc: 'Un alias es un nombre amistoso para la clave.' }} cols={[
              { head: 'Nombre del alias', cell: (n) => n, text: (n) => n }, { head: 'ARN del alias', cell: (n) => `arn:aws:kms:${k.region}:${s.account.id}:${n}` },
              { head: '', cell: (n) => (customer ? <Btn kind="link" onClick={() => void act(`aws kms delete-alias --alias-name ${n}`, 'Se eliminó el alias.')}>Eliminar</Btn> : null) },
            ]} />
          </div>
        )}
        {tab === 'tags' && (
          <div>
            <div className="head" style={{ padding: '14px 20px' }}><h2 style={{ fontSize: 18 }}>Etiquetas <span className="k-muted" style={{ fontWeight: 400 }}>({Object.keys(k.tags).length})</span></h2></div>
            <Table rows={Object.entries(k.tags)} id={([a]) => a} empty={{ title: 'Sin etiquetas' }} cols={[{ head: 'Clave', cell: ([a]) => a }, { head: 'Valor', cell: ([, v]) => v || '–' }]} />
          </div>
        )}
        {tab === 'grants' && (
          <div>
            <div className="head" style={{ padding: '14px 20px' }}><h2 style={{ fontSize: 18 }}>Concesiones <span className="k-muted" style={{ fontWeight: 400 }}>({k.grants.length})</span></h2></div>
            <Table rows={k.grants} id={(g) => g.id} empty={{ title: 'Sin concesiones', desc: 'Cree una con aws kms create-grant para dar acceso temporal a un principal.' }} cols={[
              { head: 'ID de concesión', cell: (g) => g.id.slice(0, 16) + '…' }, { head: 'Beneficiario', cell: (g) => g.granteePrincipal }, { head: 'Operaciones', cell: (g) => g.operations.join(', ') },
              { head: '', cell: (g) => (customer ? <Btn kind="link" onClick={() => void act(`aws kms revoke-grant --key-id ${k.id} --grant-id ${g.id}`, 'Se revocó la concesión.')}>Revocar</Btn> : null) },
            ]} />
          </div>
        )}
      </div>
      {modal === 'dis' && (
        <ConfirmModal title="Deshabilitar clave" confirmLabel="Deshabilitar" onClose={() => setModal(null)} onConfirm={async () => act(`aws kms disable-key --key-id ${k.id}`, 'Se deshabilitó la clave.')}>
          <Flash kind="info" title="Los datos cifrados con esta clave no se podrán descifrar mientras esté deshabilitada" />
        </ConfirmModal>
      )}
      {modal === 'del' && (
        <ConfirmModal title="Programar eliminación de la clave" confirmLabel="Programar eliminación" danger onClose={() => setModal(null)} onConfirm={async () => act(`aws kms schedule-key-deletion --key-id ${k.id} --pending-window-in-days ${windowDays}`, `Se programó la eliminación de la clave en ${windowDays} días.`)} disabled={!(Number(windowDays) >= 7 && Number(windowDays) <= 30)}>
          <Flash kind="info" title="La eliminación de una clave es destructiva y potencialmente peligrosa">Los datos cifrados con esta clave dejarán de ser recuperables cuando termine el periodo de espera.</Flash>
          <Field label="Período de espera (en días)" hint="Entre 7 y 30 días."><input className="k-input" type="number" min={7} max={30} value={windowDays} onChange={(e) => setWindowDays(e.target.value)} style={{ maxWidth: 120 }} /></Field>
        </ConfirmModal>
      )}
      {modal === 'alias' && (
        <ConfirmModal title="Crear alias" confirmLabel="Crear alias" onClose={() => setModal(null)} onConfirm={async () => act(`aws kms create-alias --alias-name alias/${alias} --target-key-id ${k.id}`, 'Se creó el alias.')} disabled={!alias}>
          <Field label="Nombre del alias"><div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span className="k-muted">alias/</span><input className="k-input" type="text" autoFocus value={alias} onChange={(e) => setAlias(e.target.value)} /></div></Field>
        </ConfirmModal>
      )}
    </>
  );
}

import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, Crumbs, Field, Flash, PageHead, Table, fmtDate } from '../../components/ui';
import { ConfirmModal, Dl, JsonEditor, Menu, Tabs, checkPolicy, pretty, run, takeFlash, tmpFile, ago } from '../iam/kit';
import { settleSecrets } from '../../../engine/services/secrets';
import { aliasesOf } from '../kms/common';

type Tab = 'ov' | 'rot' | 'ver' | 'perm' | 'tags';

export function SecretDetail({ name }: { name: string }) {
  const s = useCloud();
  settleSecrets(s);
  const sec = s.secrets.find((x) => x.name === name && x.region === s.region);
  const [tab, setTab] = useState<Tab>('ov');
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [shown, setShown] = useState<{ text: string; version: string } | null>(null);
  const [modal, setModal] = useState<null | 'del' | 'put' | 'rot'>(null);
  const [window, setWindow] = useState('30');
  const [newVal, setNewVal] = useState('');
  const [days, setDays] = useState('30');
  const [doc, setDoc] = useState('');
  const [edit, setEdit] = useState(false);
  if (!sec) return <><Crumbs items={[{ label: 'AWS Secrets Manager', to: '/secretsmanager/secrets' }, { label: 'Secretos', to: '/secretsmanager/secrets' }]} /><Flash kind="err" title="ResourceNotFoundException">Secrets Manager can't find the specified secret.</Flash></>;
  const key = sec.kmsKeyId && !sec.kmsKeyId.startsWith('alias/') ? s.kmsKeys.find((k) => k.id === sec.kmsKeyId || k.arn === sec.kmsKeyId) : undefined;
  const act = async (cmd: string, ok: string) => {
    const r = await run(cmd);
    if (!r.ok) { setErr(r.msg); return r.msg; }
    setErr(''); setFlash(ok);
  };
  const retrieve = async () => {
    const r = await run(`aws secretsmanager get-secret-value --secret-id ${sec.name}`);
    if (!r.ok) { setErr(r.msg); setShown(null); return; }
    setErr(''); setShown({ text: r.json.SecretString ?? r.json.SecretBinary, version: r.json.VersionId });
  };
  let kv: [string, string][] | null = null;
  if (shown) {
    try {
      const j = JSON.parse(shown.text);
      if (j && typeof j === 'object' && !Array.isArray(j)) kv = Object.entries(j).map(([a, b]) => [a, String(b)]);
    } catch { /* texto sin formato */ }
  }
  return (
    <>
      <Crumbs items={[{ label: 'AWS Secrets Manager', to: '/secretsmanager/secrets' }, { label: 'Secretos', to: '/secretsmanager/secrets' }, { label: sec.name }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      {sec.deletedAt && (
        <Flash kind="info" title="Este secreto está programado para eliminarse">
          <div className="sm-banner"><span>Se eliminará de forma permanente el {fmtDate(sec.deletedAt)}. Hasta entonces no se puede leer ni modificar.</span><Btn small onClick={() => void act(`aws secretsmanager restore-secret --secret-id ${sec.name}`, 'Se canceló la eliminación del secreto.')}>Cancelar la eliminación</Btn></div>
        </Flash>
      )}
      <PageHead title={sec.name}>
        <Menu label="Acciones" items={[{ label: 'Almacenar un valor nuevo', onClick: () => { setNewVal(''); setModal('put'); }, disabled: !!sec.deletedAt }, { label: 'Eliminar secreto', onClick: () => setModal('del'), disabled: !!sec.deletedAt }]} />
      </PageHead>
      <Card title="Detalles del secreto">
        <Dl items={[['Clave de cifrado', sec.kmsKeyId?.startsWith('alias/') ? sec.kmsKeyId : key ? aliasesOf(s, key)[0] ?? key.id : sec.kmsKeyId ?? 'aws/secretsmanager'], ['Nombre del secreto', sec.name], ['ARN del secreto', sec.arn], ['Descripción', sec.description || '–'], ['Fecha de creación', fmtDate(sec.createdAt)], ['Último cambio', fmtDate(sec.changedAt)], ['Última recuperación', sec.accessedAt ? ago(sec.accessedAt) : '–'], ['Rotación', sec.rotation?.enabled ? `Cada ${sec.rotation.days} días` : 'Deshabilitada']]} />
      </Card>
      <div className="card" style={{ marginBottom: 20 }}>
        <Tabs<Tab> active={tab} onChange={setTab} tabs={[{ id: 'ov', label: 'Información general' }, { id: 'rot', label: 'Rotación' }, { id: 'ver', label: 'Versiones' }, { id: 'perm', label: 'Permisos de recursos' }, { id: 'tags', label: 'Etiquetas' }]} />
        {tab === 'ov' && (
          <div className="body2">
            <h3 style={{ margin: '0 0 8px' }}>Valor del secreto</h3>
            {!shown ? <Btn onClick={retrieve} disabled={!!sec.deletedAt}>Recuperar el valor del secreto</Btn> : (
              <>
                {kv ? <div className="sm-val">{kv.map(([a, b]) => <div key={a}><span className="key">{a}:</span> {b}</div>)}</div> : <div className="sm-val">{shown.text}</div>}
                <div style={{ marginTop: 8 }}><Btn small onClick={() => setShown(null)}>Ocultar el valor del secreto</Btn> <span className="k-muted" style={{ marginLeft: 10 }}>Versión {shown.version}</span></div>
              </>
            )}
          </div>
        )}
        {tab === 'rot' && (
          <div className="body2">
            <Dl cols={2} items={[['Rotación automática', sec.rotation?.enabled ? 'Habilitada' : 'Deshabilitada'], ['Programación', sec.rotation?.days ? `Cada ${sec.rotation.days} días` : '–'], ['Última rotación', sec.rotation?.lastRotatedAt ? fmtDate(sec.rotation.lastRotatedAt) : '–'], ['Próxima rotación', sec.rotation?.enabled && sec.rotation.nextRotationAt ? fmtDate(sec.rotation.nextRotationAt) : '–']]} />
            <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
              <Btn onClick={() => setModal('rot')} disabled={!!sec.deletedAt}>Editar la rotación</Btn>
              <Btn onClick={() => void act(`aws secretsmanager rotate-secret --secret-id ${sec.name}`, 'Se rotó el secreto: hay una versión nueva en AWSCURRENT.')} disabled={!!sec.deletedAt || !sec.rotation?.enabled}>Rotar el secreto de inmediato</Btn>
              {sec.rotation?.enabled && <Btn onClick={() => void act(`aws secretsmanager cancel-rotate-secret --secret-id ${sec.name}`, 'Se deshabilitó la rotación automática.')}>Deshabilitar la rotación</Btn>}
            </div>
          </div>
        )}
        {tab === 'ver' && (
          <Table rows={sec.versions} id={(v) => v.id} empty={{ title: 'Sin versiones', desc: 'Este secreto todavía no tiene ningún valor.' }} cols={[
            { head: 'ID de versión', cell: (v) => v.id }, { head: 'Etiquetas de ensayo', cell: (v) => v.stages.map((x) => <span key={x} className="k-badge" style={{ marginRight: 4 }}>{x}</span>) }, { head: 'Creada', cell: (v) => fmtDate(v.createdAt), text: (v) => v.createdAt },
          ]} />
        )}
        {tab === 'perm' && (
          <div className="body2">
            {!edit ? (
              <>
                {sec.resourcePolicy ? <pre className="k-pre">{pretty(sec.resourcePolicy)}</pre> : <p className="k-muted">Este secreto no tiene una política de recursos.</p>}
                <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                  <Btn onClick={() => { setDoc(sec.resourcePolicy ? pretty(sec.resourcePolicy) : pretty({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { AWS: s.me.arn }, Action: 'secretsmanager:GetSecretValue', Resource: '*' }] })); setEdit(true); }}>Editar permisos</Btn>
                  {sec.resourcePolicy && <Btn onClick={() => void act(`aws secretsmanager delete-resource-policy --secret-id ${sec.name}`, 'Se eliminó la política de recursos.')}>Eliminar</Btn>}
                </div>
              </>
            ) : (
              <>
                <JsonEditor value={doc} onChange={setDoc} kind="resource" rows={14} />
                <div className="k-foot"><Btn onClick={() => setEdit(false)}>Cancelar</Btn><Btn kind="primary" disabled={!!checkPolicy(doc, 'resource')} onClick={async () => { const e = await act(`aws secretsmanager put-resource-policy --secret-id ${sec.name} --resource-policy ${tmpFile(doc)}`, 'Se guardó la política de recursos.'); if (!e) setEdit(false); }}>Guardar</Btn></div>
              </>
            )}
          </div>
        )}
        {tab === 'tags' && (
          <Table rows={Object.entries(sec.tags)} id={([a]) => a} empty={{ title: 'Sin etiquetas' }} cols={[{ head: 'Clave', cell: ([a]) => a }, { head: 'Valor', cell: ([, v]) => v || '–' }]} />
        )}
      </div>
      {modal === 'del' && (
        <ConfirmModal title="Programar la eliminación del secreto" confirmLabel="Programar eliminación" danger onClose={() => setModal(null)} disabled={!(Number(window) >= 7 && Number(window) <= 30)} onConfirm={async () => act(`aws secretsmanager delete-secret --secret-id ${sec.name} --recovery-window-in-days ${window}`, `Se programó la eliminación del secreto en ${window} días.`)}>
          <Flash kind="info" title="Durante el período de recuperación puede cancelar la eliminación">Pasado ese plazo, el secreto y todas sus versiones se eliminan de forma permanente.</Flash>
          <Field label="Período de espera (en días)" hint="Entre 7 y 30 días."><input className="k-input" type="number" min={7} max={30} value={window} onChange={(e) => setWindow(e.target.value)} style={{ maxWidth: 120 }} /></Field>
        </ConfirmModal>
      )}
      {modal === 'put' && (
        <ConfirmModal title="Almacenar un valor nuevo" confirmLabel="Guardar" onClose={() => setModal(null)} disabled={!newVal} onConfirm={async () => act(`aws secretsmanager put-secret-value --secret-id ${sec.name} --secret-string ${tmpFile(newVal)}`, 'Se almacenó una versión nueva del secreto (AWSCURRENT). La anterior pasó a AWSPREVIOUS.')}>
          <textarea className="k-code" style={{ minHeight: 120 }} value={newVal} onChange={(e) => setNewVal(e.target.value)} aria-label="Valor nuevo" />
        </ConfirmModal>
      )}
      {modal === 'rot' && (
        <ConfirmModal title="Editar la rotación" confirmLabel="Guardar" onClose={() => setModal(null)} onConfirm={async () => act(`aws secretsmanager rotate-secret --secret-id ${sec.name} --rotation-rules AutomaticallyAfterDays=${days}`, `Rotación configurada cada ${days} días.`)}>
          <Field label="Rotar cada (días)"><input className="k-input" type="number" min={1} max={1000} value={days} onChange={(e) => setDays(e.target.value)} style={{ maxWidth: 140 }} /></Field>
        </ConfirmModal>
      )}
    </>
  );
}

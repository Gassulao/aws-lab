import React, { useEffect, useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, Crumbs, Flash, PageHead, Table, nav, fmtDate } from '../../components/ui';
import { ConfirmModal, Dl, Tabs, run, q } from '../iam/kit';
import { fetchObject, saveBlob, fmtSize, Preview, type Fetched } from './objects';
import { objectPath } from './ObjectsTab';
import { regionLabel } from './Buckets';
import { Modal } from '../../components/ui';
import './s3.css';

export function ObjectDetail({ bucket, objKey }: { bucket: string; objKey: string }) {
  const s = useCloud();
  const b = s.buckets.find((x) => x.name === bucket);
  const vId = new URLSearchParams(location.hash.split('?')[1] ?? '').get('v') ?? undefined;
  const [tab, setTab] = useState<'props' | 'versions'>('props');
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState<Fetched | null>(null);
  const [del, setDel] = useState(false);
  const [head, setHead] = useState<any>(null);
  useEffect(() => {
    (async () => {
      const r = await run(`aws s3api head-object --bucket ${bucket} --key ${q(objKey)}`);
      if (r.ok) { setHead(r.json); setErr(''); } else setErr(r.msg);
    })();
  }, [bucket, objKey]);
  if (!b) return <Flash kind="err" title="NoSuchBucket">The specified bucket does not exist</Flash>;
  const o = b.objects[objKey];
  const parent = objKey.includes('/') ? objKey.slice(0, objKey.lastIndexOf('/') + 1) : '';
  const base = objKey.split('/').pop()!;
  const versions = [...(b.versions[objKey] ?? []), ...(o && !(b.versions[objKey] ?? []).some((v) => v.versionId === o.versionId) ? [o] : [])].reverse();
  return (
    <>
      <Crumbs items={[{ label: 'Amazon S3', to: '/s3/buckets' }, { label: 'Buckets', to: '/s3/buckets' }, { label: bucket, to: '/s3/bucket/' + bucket }, { label: objKey }]} />
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title={base}>
        <Btn disabled={!o} onClick={async () => { const f = await fetchObject(bucket, objKey, vId); if (!f.ok) return setErr(f.msg); saveBlob(objKey, f.body, f.contentType); }}>Descargar</Btn>
        <Btn disabled={!o} onClick={async () => { const f = await fetchObject(bucket, objKey, vId); if (!f.ok) return setErr(f.msg); setPreview(f); }}>Abrir</Btn>
        <Btn disabled={!o} onClick={() => setDel(true)}>Eliminar</Btn>
      </PageHead>
      {!o && !err && <Flash kind="info" title="El objeto ya no existe en este bucket">{parent ? <a onClick={() => nav('/s3/bucket/' + bucket)}>Volver al bucket</a> : <a onClick={() => nav('/s3/bucket/' + bucket)}>Volver al bucket</a>}</Flash>}
      <div className="card" style={{ marginBottom: 20 }}>
        <Tabs active={tab} onChange={setTab} tabs={[{ id: 'props', label: 'Propiedades' }, { id: 'versions', label: 'Versiones' }]} />
        {tab === 'props' && o && (
          <div className="body2" style={{ padding: 20 }}>
            <h2 style={{ fontSize: 18, marginBottom: 12 }}>Información general del objeto</h2>
            <Dl items={[['Propietario', s.account.id], ['Región de AWS', regionLabel(b.region)], ['Última modificación', fmtDate(o.lastModified)], ['Tamaño', fmtSize(o.size)], ['Tipo', o.contentType], ['Clave', o.key], ['URI de S3', `s3://${bucket}/${o.key}`], ['Nombre de recurso de Amazon (ARN)', `arn:aws:s3:::${bucket}/${o.key}`], ['Etiqueta de entidad (Etag)', head?.ETag ?? o.etag], ['Clase de almacenamiento', o.storageClass === 'STANDARD' ? 'Estándar' : o.storageClass], ['ID de versión', o.versionId ?? '-'], ['Cifrado', b.encryption?.algorithm === 'aws:kms' ? 'SSE-KMS' : 'SSE-S3']]} />
          </div>
        )}
        {tab === 'versions' && (
          <Table rows={versions} id={(v) => v.versionId ?? 'null'} filterPlaceholder="Buscar versiones" empty={{ title: 'Sin versiones', desc: b.versioning === 'Disabled' ? 'El control de versiones no está habilitado en este bucket.' : 'No hay versiones.' }} cols={[
            { head: 'ID de versión', cell: (v) => <a onClick={() => nav(objectPath(bucket, objKey) + (v.versionId ? `?v=${v.versionId}` : ''))}>{v.versionId ?? 'null'}</a>, text: (v) => v.versionId ?? '' },
            { head: 'Tipo', cell: (v) => ((v as any).deleteMarker ? 'Marcador de eliminación' : v.versionId === o?.versionId ? 'Versión actual' : 'Versión anterior') },
            { head: 'Última modificación', cell: (v) => fmtDate(v.lastModified) }, { head: 'Tamaño', cell: (v) => fmtSize(v.size) },
          ]} />
        )}
      </div>
      {preview && <Modal title={objKey} onClose={() => setPreview(null)} footer={<Btn onClick={() => setPreview(null)}>Cerrar</Btn>}><Preview body={preview.body} contentType={preview.contentType} /></Modal>}
      {del && (
        <ConfirmModal title="Eliminar objeto" confirmLabel="Eliminar objeto" danger requireText="eliminar de forma permanente" onClose={() => setDel(false)} onConfirm={async () => { const r = await run(`aws s3api delete-object --bucket ${bucket} --key ${q(objKey)}`); if (!r.ok) return r.msg; nav('/s3/bucket/' + bucket); }}>
          <p>Se eliminará <b>{objKey}</b>. {b.versioning === 'Enabled' ? 'El bucket tiene versiones: se agregará un marcador de eliminación.' : 'Esta acción no se puede deshacer.'}</p>
        </ConfirmModal>
      )}
      <Card title="Comando equivalente"><code>aws s3api head-object --bucket {bucket} --key {objKey}</code></Card>
    </>
  );
}

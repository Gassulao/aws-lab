import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, Crumbs, Flash, PageHead, Table, nav, fmtDate } from '../../components/ui';
import { REGIONS } from '../../../engine/catalog';
import { ConfirmModal, run } from '../iam/kit';
import { isPublicPolicy } from '../../../engine/services/s3';
import { allBlocked } from './Bpa';
import type { S3Bucket } from '../../../engine/types';
import './s3.css';

export const regionLabel = (code: string) => `${REGIONS.find((r) => r.code === code)?.name ?? code} ${code}`;

export function accessOf(b: S3Bucket): 'Privado' | 'Público' | 'Los objetos pueden ser públicos' {
  if (b.policy && isPublicPolicy(b.policy) && !b.publicAccessBlock.RestrictPublicBuckets) return 'Público';
  if (!allBlocked(b.publicAccessBlock) || b.acl !== 'private') return 'Los objetos pueden ser públicos';
  return 'Privado';
}

/** Elimina todos los objetos y versiones del bucket (equivale a "Vaciar bucket"). */
export async function emptyBucket(name: string, getBucket: () => S3Bucket | undefined): Promise<string> {
  for (let pass = 0; pass < 6; pass++) {
    const b = getBucket();
    if (!b) return '';
    const entries: { key: string; v?: string }[] = [];
    for (const o of Object.values(b.objects)) entries.push({ key: o.key, v: o.versionId });
    for (const [k, vs] of Object.entries(b.versions)) for (const v of vs) entries.push({ key: k, v: v.versionId });
    if (!entries.length) return '';
    for (const e of entries) {
      const r = await run(`aws s3api delete-object --bucket ${name} --key '${e.key.replace(/'/g, `'\\''`)}'${e.v ? ` --version-id ${e.v}` : ''}`);
      if (!r.ok) return r.msg;
    }
  }
  return '';
}

export function S3Buckets() {
  const s = useCloud();
  const [sel, setSel] = useState<string[]>([]);
  const [modal, setModal] = useState<null | 'del' | 'empty'>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const name = sel[0];
  return (
    <>
      <Crumbs items={[{ label: 'Amazon S3' }, { label: 'Buckets' }]} />
      {msg && <Flash kind="ok" onClose={() => setMsg('')}>{msg}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title="Buckets de uso general" desc="Los buckets son contenedores de datos almacenados en S3." />
      <Card title="Buckets de uso general" count={s.buckets.length} flush actions={
        <>
          <Btn small disabled={sel.length !== 1} onClick={() => { navigator.clipboard?.writeText(`arn:aws:s3:::${name}`); setMsg(`ARN copiado: arn:aws:s3:::${name}`); }}>Copiar ARN</Btn>
          <Btn small disabled={sel.length !== 1} onClick={() => setModal('empty')}>Vaciar</Btn>
          <Btn small disabled={sel.length !== 1} onClick={() => setModal('del')}>Eliminar</Btn>
          <Btn kind="primary" onClick={() => nav('/s3/create')}>Crear bucket</Btn>
        </>
      }>
        <Table rows={s.buckets} id={(b) => b.name} selected={sel} onSelect={(x) => setSel(x.slice(-1))} filterPlaceholder="Buscar buckets por nombre" empty={{ title: 'No hay buckets', desc: 'No tiene buckets en esta región. Cree un bucket para almacenar datos.' }} cols={[
          { head: 'Nombre', cell: (b) => <a onClick={() => nav('/s3/bucket/' + b.name)}>{b.name}</a>, text: (b) => b.name },
          { head: 'Región de AWS', cell: (b) => regionLabel(b.region), text: (b) => regionLabel(b.region) },
          { head: 'Acceso', cell: (b) => accessOf(b), text: (b) => accessOf(b) },
          { head: 'Fecha de creación', cell: (b) => fmtDate(b.createdAt), text: (b) => b.createdAt },
        ]} />
      </Card>
      {modal === 'empty' && (
        <ConfirmModal title="Vaciar bucket" confirmLabel="Vaciar" danger requireText="eliminar de forma permanente" onClose={() => setModal(null)}
          onConfirm={async () => { const e = await emptyBucket(name, () => s.buckets.find((b) => b.name === name)); if (!e) setMsg(`Se vació correctamente el bucket ${name}.`); return e; }}>
          <Flash kind="info" title="Se eliminarán de forma permanente todos los objetos del bucket">Esta acción no se puede deshacer (incluye versiones y marcadores de eliminación).</Flash>
          <p>Bucket: <b>{name}</b></p>
        </ConfirmModal>
      )}
      {modal === 'del' && (
        <ConfirmModal title="Eliminar bucket" confirmLabel="Eliminar bucket" danger requireText={name} onClose={() => setModal(null)}
          onConfirm={async () => {
            const b = s.buckets.find((x) => x.name === name)!;
            const r = await run(`aws s3api delete-bucket --bucket ${name} --region ${b.region}`);
            if (!r.ok) return r.msg;
            setMsg(`Se eliminó correctamente el bucket ${name}.`); setSel([]);
          }}>
          <Flash kind="info" title="Eliminar un bucket no se puede deshacer">Los nombres de bucket son únicos globalmente. Si elimina este bucket, otra cuenta podría usar el nombre. Si el bucket no está vacío, primero debe vaciarlo.</Flash>
        </ConfirmModal>
      )}
    </>
  );
}

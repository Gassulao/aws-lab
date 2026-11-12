import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, Crumbs, Field, Flash, PageHead, Table, nav, fmtDate } from '../../components/ui';
import { ConfirmModal, JsonEditor, Tabs, TagEditor, Tile, checkPolicy, pretty, run, tmpFile, takeFlash, PolicyBlock, type TagRow } from '../iam/kit';
import { ObjectsTab } from './ObjectsTab';
import { BpaEditor, ALL_BLOCKED, allBlocked, bpaArg, noneBlocked, type Bpa } from './Bpa';
import { accessOf, regionLabel, emptyBucket } from './Buckets';
import type { S3Bucket } from '../../../engine/types';
import './s3.css';

type Tab = 'objects' | 'props' | 'perms' | 'metrics' | 'mgmt' | 'ap';

export function BucketDetail({ name }: { name: string }) {
  const s = useCloud();
  const b = s.buckets.find((x) => x.name === name);
  const [tab, setTab] = useState<Tab>('objects');
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(() => { const m = takeFlash(); return m ? { kind: m.includes('falló') ? 'err' : 'ok', msg: m } : null; });
  const [modal, setModal] = useState<null | 'del' | 'empty'>(null);
  if (!b) return <><Crumbs items={[{ label: 'Amazon S3', to: '/s3/buckets' }, { label: 'Buckets', to: '/s3/buckets' }]} /><Flash kind="err" title="NoSuchBucket">The specified bucket does not exist</Flash></>;
  const notify = (kind: 'ok' | 'err', msg: string) => setFlash({ kind, msg });
  return (
    <>
      <Crumbs items={[{ label: 'Amazon S3', to: '/s3/buckets' }, { label: 'Buckets', to: '/s3/buckets' }, { label: name }]} />
      {flash && <Flash kind={flash.kind} onClose={() => setFlash(null)}>{flash.msg}</Flash>}
      <PageHead title={<>{name} <span className="k-badge" style={{ fontSize: 12, verticalAlign: 'middle' }}>{accessOf(b)}</span></>}>
        <Btn small onClick={() => setModal('empty')}>Vaciar</Btn><Btn small onClick={() => setModal('del')}>Eliminar</Btn>
      </PageHead>
      <div className="card" style={{ marginBottom: 0 }}>
        <Tabs<Tab> active={tab} onChange={setTab} tabs={[{ id: 'objects', label: 'Objetos' }, { id: 'props', label: 'Propiedades' }, { id: 'perms', label: 'Permisos' }, { id: 'metrics', label: 'Métricas' }, { id: 'mgmt', label: 'Administración' }, { id: 'ap', label: 'Puntos de acceso' }]} />
      </div>
      <div style={{ height: 20 }} />
      {tab === 'objects' && <ObjectsTab key={name} b={b} notify={notify} />}
      {tab === 'props' && <Props b={b} notify={notify} />}
      {tab === 'perms' && <Perms b={b} notify={notify} />}
      {tab === 'metrics' && <Empty title="Métricas de almacenamiento" desc="Las métricas de Amazon CloudWatch para este bucket no están disponibles en el simulador." />}
      {tab === 'mgmt' && (
        <Card title="Reglas del ciclo de vida" count={b.lifecycle.length} flush>
          <Table rows={b.lifecycle} id={(r: any) => String(r?.ID ?? JSON.stringify(r))} empty={{ title: 'No hay reglas de ciclo de vida', desc: 'La configuración de reglas de ciclo de vida, replicación e inventario no está disponible en el simulador.' }} cols={[{ head: 'Nombre de la regla', cell: (r: any) => r?.ID ?? '-' }]} />
        </Card>
      )}
      {tab === 'ap' && <Empty title="Puntos de acceso" desc="Los puntos de acceso de Amazon S3 simplifican la administración del acceso a datos a escala. No hay puntos de acceso en este simulador." />}
      {modal === 'empty' && (
        <ConfirmModal title="Vaciar bucket" confirmLabel="Vaciar" danger requireText="eliminar de forma permanente" onClose={() => setModal(null)} onConfirm={async () => { const e = await emptyBucket(name, () => s.buckets.find((x) => x.name === name)); if (!e) notify('ok', `Se vació correctamente el bucket ${name}.`); return e; }}>
          <Flash kind="info" title="Se eliminarán de forma permanente todos los objetos del bucket">Incluye versiones y marcadores de eliminación. Esta acción no se puede deshacer.</Flash>
        </ConfirmModal>
      )}
      {modal === 'del' && (
        <ConfirmModal title="Eliminar bucket" confirmLabel="Eliminar bucket" danger requireText={name} onClose={() => setModal(null)} onConfirm={async () => { const r = await run(`aws s3api delete-bucket --bucket ${name} --region ${b.region}`); if (!r.ok) return r.msg; nav('/s3/buckets'); }}>
          <Flash kind="info" title="Eliminar un bucket no se puede deshacer">Si el bucket no está vacío, primero debe vaciarlo.</Flash>
        </ConfirmModal>
      )}
    </>
  );
}

function Empty({ title, desc }: { title: string; desc: string }) {
  return <Card title={title}><div style={{ textAlign: 'center', padding: 30 }}><b>No disponible</b><div className="k-muted">{desc}</div></div></Card>;
}

function Section({ title, desc, action, children }: { title: string; desc?: string; action?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="card">
      <div className="s3-heading"><div><h2>{title}</h2>{desc && <p>{desc}</p>}</div>{action}</div>
      <div className="s3-sec">{children}</div>
    </div>
  );
}

const kv = (k: string, v: React.ReactNode) => <div key={k}><div className="k">{k}</div><div className="v">{v}</div></div>;

function Props({ b, notify }: { b: S3Bucket; notify: (k: 'ok' | 'err', m: string) => void }) {
  const name = b.name;
  const [modal, setModal] = useState<null | 'ver' | 'enc' | 'tags' | 'web'>(null);
  const [ver, setVer] = useState<'Enabled' | 'Suspended'>('Enabled');
  const [enc, setEnc] = useState<'AES256' | 'aws:kms'>(b.encryption?.algorithm ?? 'AES256');
  const [kms, setKms] = useState(b.encryption?.kmsKeyId ?? '');
  const [tags, setTags] = useState<TagRow[]>([]);
  const [web, setWeb] = useState({ index: 'index.html', error: '' });
  const apply = async (cmd: string, ok: string): Promise<string | void> => { const r = await run(cmd); if (!r.ok) return r.msg; notify('ok', ok); };
  const endpoint = `http://${name}.s3-website-${b.region}.amazonaws.com`;
  const verLabel = b.versioning === 'Enabled' ? 'Habilitado' : b.versioning === 'Suspended' ? 'Suspendido' : 'Deshabilitado';
  return (
    <>
      <Section title="Información general del bucket">
        <div className="k-three k-dl">
          {kv('Región de AWS', regionLabel(b.region))}
          {kv('Nombre de recurso de Amazon (ARN)', `arn:aws:s3:::${name}`)}
          {kv('Fecha de creación', fmtDate(b.createdAt))}
          {kv('Propiedad de objetos', b.ownershipControls === 'BucketOwnerEnforced' ? 'ACL deshabilitadas (propietario del bucket exigido)' : b.ownershipControls)}
        </div>
      </Section>
      <Section title="Control de versiones de buckets" desc="El control de versiones es un medio de conservar varias variantes de un objeto en el mismo bucket." action={<Btn small onClick={() => { setVer(b.versioning === 'Suspended' ? 'Suspended' : 'Enabled'); setModal('ver'); }}>Editar</Btn>}>
        <div className="k-dl"><div className="k">Control de versiones de buckets</div><div className="v">{verLabel}</div></div>
      </Section>
      <Section title="Etiquetas" desc="Puede utilizar las etiquetas de bucket para realizar un seguimiento de los costos de almacenamiento y organizar los buckets." action={<Btn small onClick={() => { setTags(Object.entries(b.tags).map(([k, v]) => ({ k, v }))); setModal('tags'); }}>Editar</Btn>}>
        <Table rows={Object.entries(b.tags)} id={([k]) => k} filterPlaceholder="Buscar etiquetas" empty={{ title: 'Sin etiquetas', desc: 'No hay etiquetas asociadas a este recurso.' }} cols={[{ head: 'Clave', cell: ([k]) => k }, { head: 'Valor', cell: ([, v]) => v || '-' }]} />
      </Section>
      <Section title="Cifrado predeterminado" desc="El cifrado del servidor se aplica automáticamente a los objetos nuevos almacenados en este bucket." action={<Btn small onClick={() => { setEnc(b.encryption?.algorithm ?? 'AES256'); setKms(b.encryption?.kmsKeyId ?? ''); setModal('enc'); }}>Editar</Btn>}>
        <div className="k-three k-dl">
          {kv('Tipo de cifrado', b.encryption?.algorithm === 'aws:kms' ? 'Cifrado del lado del servidor con claves de AWS KMS (SSE-KMS)' : 'Cifrado del lado del servidor con claves administradas de Amazon S3 (SSE-S3)')}
          {b.encryption?.kmsKeyId && kv('Clave de AWS KMS', b.encryption.kmsKeyId)}
        </div>
      </Section>
      <Section title="Alojamiento de sitios web estáticos" desc="Utilice este bucket para alojar un sitio web o redirigir solicitudes." action={<Btn small onClick={() => { setWeb({ index: b.website?.indexDocument ?? 'index.html', error: b.website?.errorDocument ?? '' }); setModal('web'); }}>Editar</Btn>}>
        {b.website ? (
          <div className="k-three k-dl">
            {kv('Alojamiento de sitios web estáticos', 'Habilitado')}
            {kv('Documento de índice', b.website.indexDocument)}
            {kv('Documento de error', b.website.errorDocument ?? '-')}
            {kv('Punto de enlace del sitio web del bucket', <a onClick={() => navigator.clipboard?.writeText(endpoint)}>{endpoint}</a>)}
          </div>
        ) : <div className="k-dl"><div className="k">Alojamiento de sitios web estáticos</div><div className="v">Deshabilitado</div></div>}
      </Section>

      {modal === 'ver' && (
        <ConfirmModal title="Editar control de versiones de buckets" confirmLabel="Guardar cambios" onClose={() => setModal(null)} onConfirm={() => apply(`aws s3api put-bucket-versioning --bucket ${name} --versioning-configuration Status=${ver}`, `Se actualizó el control de versiones de ${name}.`)}>
          <p className="k-muted">Con el control de versiones habilitado se conservan todas las versiones de cada objeto.</p>
          <Tile on={ver === 'Suspended'} onClick={() => setVer('Suspended')} title="Suspender" desc="Se dejan de crear nuevas versiones; las existentes se conservan." />
          <Tile on={ver === 'Enabled'} onClick={() => setVer('Enabled')} title="Habilitar" />
          {b.versioning === 'Disabled' && <div className="k-muted">Una vez habilitado, el control de versiones no se puede volver a deshabilitar; solo suspender.</div>}
        </ConfirmModal>
      )}
      {modal === 'tags' && (
        <ConfirmModal title="Editar etiquetas" confirmLabel="Guardar cambios" onClose={() => setModal(null)} onConfirm={() => apply(`aws s3api put-bucket-tagging --bucket ${name} --tagging ${tmpFile(pretty({ TagSet: tags.filter((t) => t.k.trim()).map((t) => ({ Key: t.k.trim(), Value: t.v })) }))}`, 'Se actualizaron las etiquetas del bucket.')}>
          <TagEditor tags={tags} onChange={setTags} />
        </ConfirmModal>
      )}
      {modal === 'enc' && (
        <ConfirmModal title="Editar el cifrado predeterminado" confirmLabel="Guardar cambios" onClose={() => setModal(null)} onConfirm={() => apply(`aws s3api put-bucket-encryption --bucket ${name} --server-side-encryption-configuration ${tmpFile(pretty({ Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: enc, ...(enc === 'aws:kms' && kms ? { KMSMasterKeyID: kms } : {}) } }] }))}`, 'Se actualizó el cifrado predeterminado.')}>
          <Tile on={enc === 'AES256'} onClick={() => setEnc('AES256')} title="Claves administradas de Amazon S3 (SSE-S3)" />
          <Tile on={enc === 'aws:kms'} onClick={() => setEnc('aws:kms')} title="Claves de AWS Key Management Service (SSE-KMS)" />
          {enc === 'aws:kms' && <Field label="Clave de AWS KMS (ARN o alias)"><input className="k-input" type="text" value={kms} onChange={(e) => setKms(e.target.value)} placeholder="alias/aws/s3" /></Field>}
        </ConfirmModal>
      )}
      {modal === 'web' && (
        <ConfirmModal title="Editar el alojamiento de sitios web estáticos" confirmLabel="Guardar cambios" disabled={!web.index} onClose={() => setModal(null)} onConfirm={() => apply(`aws s3api put-bucket-website --bucket ${name} --website-configuration ${tmpFile(pretty({ IndexDocument: { Suffix: web.index }, ...(web.error ? { ErrorDocument: { Key: web.error } } : {}) }))}`, 'Se actualizó la configuración del sitio web estático.')}>
          <Tile on={!!b.website || true} onClick={() => {}} title="Habilitar" desc="El simulador no admite deshabilitar el alojamiento una vez configurado (no existe delete-bucket-website)." />
          <Field label="Documento de índice" hint="Especifique la página principal del sitio web."><input className="k-input" type="text" value={web.index} onChange={(e) => setWeb({ ...web, index: e.target.value })} placeholder="index.html" /></Field>
          <Field label="Documento de error - opcional"><input className="k-input" type="text" value={web.error} onChange={(e) => setWeb({ ...web, error: e.target.value })} placeholder="error.html" /></Field>
        </ConfirmModal>
      )}
    </>
  );
}

const PUBLIC_READ = (n: string) => pretty({ Version: '2012-10-17', Statement: [{ Sid: 'PublicReadGetObject', Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `arn:aws:s3:::${n}/*` }] });

function Perms({ b, notify }: { b: S3Bucket; notify: (k: 'ok' | 'err', m: string) => void }) {
  const name = b.name;
  const [modal, setModal] = useState<null | 'bpa' | 'pol' | 'delpol'>(null);
  const [bpa, setBpa] = useState<Bpa>(ALL_BLOCKED);
  const [pol, setPol] = useState('');
  const [err, setErr] = useState('');
  const apply = async (cmd: string, ok: string): Promise<string | void> => { const r = await run(cmd); if (!r.ok) return r.msg; setErr(''); notify('ok', ok); };
  const same = JSON.stringify(bpa) === JSON.stringify(b.publicAccessBlock);
  return (
    <>
      <Section title="Bloqueo de acceso público (configuración del bucket)" desc="El acceso público se concede a buckets y objetos mediante ACL, políticas de bucket, políticas de puntos de acceso o todas ellas." action={<Btn small onClick={() => { setBpa({ ...b.publicAccessBlock }); setModal('bpa'); }}>Editar</Btn>}>
        <b>{allBlocked(b.publicAccessBlock) ? 'Bloquear todo el acceso público: activado' : noneBlocked(b.publicAccessBlock) ? 'Bloquear todo el acceso público: desactivado' : 'Bloquear todo el acceso público: configuración parcial'}</b>
        <ul style={{ margin: '8px 0 0', paddingLeft: 20, listStyle: 'none' }}>
          {([['BlockPublicAcls', 'Bloquear el acceso público a buckets y objetos concedido a través de nuevas ACL'], ['IgnorePublicAcls', 'Bloquear el acceso público concedido a través de cualquier ACL'], ['BlockPublicPolicy', 'Bloquear el acceso público concedido a través de nuevas políticas de bucket y de puntos de acceso'], ['RestrictPublicBuckets', 'Bloquear el acceso público y entre cuentas a través de políticas de bucket y de puntos de acceso públicas']] as const).map(([k, t]) => (
            <li key={k}><span style={{ color: b.publicAccessBlock[k] ? 'var(--ok)' : 'var(--err)' }}>{b.publicAccessBlock[k] ? '✓ Activado' : '✕ Desactivado'}</span> - {t}</li>
          ))}
        </ul>
      </Section>
      <Section title="Política de bucket" desc="La política de bucket, escrita en JSON, proporciona acceso a los objetos almacenados en el bucket." action={<div className="actions">{b.policy && <Btn small onClick={() => setModal('delpol')}>Eliminar</Btn>}<Btn small onClick={() => { setPol(b.policy ? pretty(b.policy) : PUBLIC_READ(name)); setErr(''); setModal('pol'); }}>Editar</Btn></div>}>
        {b.policy ? <PolicyBlock doc={b.policy} /> : <div className="k-muted">No hay política para mostrar. Utilice Editar para agregar una.</div>}
      </Section>
      <Section title="Propiedad de objetos" desc="Controle la propiedad de los objetos escritos en este bucket por otras cuentas de AWS.">
        <b>{b.ownershipControls === 'BucketOwnerEnforced' ? 'ACL deshabilitadas (recomendado)' : b.ownershipControls}</b>
      </Section>
      <Section title="Lista de control de acceso (ACL)" desc="Concede permisos básicos de lectura y escritura a otras cuentas de AWS.">
        <div className="k-dl"><div className="k">Propietario del bucket (su cuenta de AWS)</div><div className="v">Lista de objetos, escritura de objetos: {b.acl === 'private' ? 'Privado' : b.acl}</div></div>
      </Section>
      {modal === 'bpa' && (
        <ConfirmModal title="Editar la configuración de bloqueo de acceso público (bucket)" confirmLabel="Guardar cambios" requireText={allBlocked(bpa) ? undefined : 'confirmar'} disabled={same} onClose={() => setModal(null)} onConfirm={() => apply(`aws s3api put-public-access-block --bucket ${name} --public-access-block-configuration ${bpaArg(bpa)}`, 'Se actualizó la configuración de bloqueo de acceso público.')}>
          <BpaEditor value={bpa} onChange={setBpa} />
          {!allBlocked(bpa) && <div className="k-warnbox">Al actualizar esta configuración, este bucket y los objetos que contiene podrían volverse públicos. Escriba <i>confirmar</i> para continuar.</div>}
        </ConfirmModal>
      )}
      {modal === 'pol' && (
        <ConfirmModal title="Editar política de bucket" confirmLabel="Guardar cambios" disabled={!pol.trim() || !!checkPolicy(pol, 'resource')} onClose={() => setModal(null)} onConfirm={() => apply(`aws s3api put-bucket-policy --bucket ${name} --policy ${tmpFile(pol)}`, 'Se guardó correctamente la política de bucket.')}>
          <p className="k-muted">ARN del bucket: arn:aws:s3:::{name}</p>
          <JsonEditor kind="resource" value={pol} onChange={setPol} rows={14} />
        </ConfirmModal>
      )}
      {modal === 'delpol' && <ConfirmModal title="Eliminar política de bucket" confirmLabel="Eliminar" danger requireText="eliminar" onClose={() => setModal(null)} onConfirm={() => apply(`aws s3api delete-bucket-policy --bucket ${name}`, 'Se eliminó la política de bucket.')}><p>¿Eliminar la política de este bucket?</p></ConfirmModal>}
      {err && <Flash kind="err">{err}</Flash>}
    </>
  );
}

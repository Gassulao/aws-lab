import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, PageHead, nav } from '../../components/ui';
import { REGIONS } from '../../../engine/catalog';
import { validBucketName } from '../../../engine/services/s3';
import { TagEditor, Tile, run, tmpFile, tagsArg, pretty, setNextFlash, type TagRow } from '../iam/kit';
import { BpaEditor, ALL_BLOCKED, allBlocked, bpaArg, type Bpa } from './Bpa';
import './s3.css';

export function CreateBucket() {
  const s = useCloud();
  const [name, setName] = useState('');
  const [region, setRegion] = useState(s.region);
  const [bpa, setBpa] = useState<Bpa>(ALL_BLOCKED);
  const [ack, setAck] = useState(false);
  const [ver, setVer] = useState(false);
  const [enc, setEnc] = useState<'AES256' | 'aws:kms'>('AES256');
  const [kms, setKms] = useState('');
  const [tags, setTags] = useState<TagRow[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const nameErr = !name ? '' : !validBucketName(name) ? 'El nombre del bucket debe tener entre 3 y 63 caracteres, solo minúsculas, números, puntos y guiones, y empezar y terminar por letra o número.' : s.buckets.some((b) => b.name === name) ? 'Ya es propietario de un bucket con ese nombre.' : '';
  const cmd = [`aws s3api create-bucket --bucket ${name || '<nombre>'} --region ${region}`, region !== 'us-east-1' && `--create-bucket-configuration LocationConstraint=${region}`].filter(Boolean).join(' ');
  const needAck = !allBlocked(bpa);
  const go = async () => {
    setBusy(true); setErr('');
    const fail = (m: string) => { setBusy(false); setErr(m); };
    const r = await run(cmd);
    if (!r.ok) return fail(r.msg);
    const post = async (c: string) => { const x = await run(c); return x.ok ? '' : x.msg; };
    let e = '';
    if (!allBlocked(bpa)) e = e || (await post(`aws s3api put-public-access-block --bucket ${name} --public-access-block-configuration ${bpaArg(bpa)}`));
    if (ver) e = e || (await post(`aws s3api put-bucket-versioning --bucket ${name} --versioning-configuration Status=Enabled`));
    if (enc === 'aws:kms') e = e || (await post(`aws s3api put-bucket-encryption --bucket ${name} --server-side-encryption-configuration ${tmpFile(pretty({ Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', ...(kms ? { KMSMasterKeyID: kms } : {}) } }] }))}`));
    if (tags.some((t) => t.k.trim())) e = e || (await post(`aws s3api put-bucket-tagging --bucket ${name} --tagging ${tmpFile(pretty({ TagSet: tags.filter((t) => t.k.trim()).map((t) => ({ Key: t.k.trim(), Value: t.v })) }))}`));
    if (e) { setNextFlash(`Se creó el bucket, pero una configuración falló: ${e}`); }
    else setNextFlash(`Se creó correctamente el bucket "${name}". Para cargar archivos y carpetas, o para configurar ajustes adicionales del bucket, elija Ver detalles.`);
    void tagsArg;
    nav('/s3/bucket/' + name);
  };
  return (
    <>
      <Crumbs items={[{ label: 'Amazon S3', to: '/s3/buckets' }, { label: 'Buckets', to: '/s3/buckets' }, { label: 'Crear bucket' }]} />
      <PageHead title="Crear bucket" desc="Los buckets son contenedores de datos almacenados en S3." />
      {err && <Flash kind="err" title="Error al crear el bucket" onClose={() => setErr('')}>{err}</Flash>}
      <Card title="Configuración general">
        <Field label="Región de AWS"><select className="k-select" value={region} onChange={(e) => setRegion(e.target.value)} style={{ minWidth: 320 }}>{REGIONS.map((r) => <option key={r.code} value={r.code}>{r.name} {r.code}</option>)}</select></Field>
        <Field label="Tipo de bucket"><Tile on onClick={() => {}} title="Uso general" desc="Recomendado para la mayoría de los casos de uso y patrones de acceso." /></Field>
        <Field label="Nombre del bucket" hint="El nombre del bucket debe ser único dentro del espacio de nombres global y seguir las reglas de nomenclatura de buckets." error={nameErr}>
          <input type="text" placeholder="myawsbucket" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
      </Card>
      <Card title="Propiedad de objetos">
        <Tile on onClick={() => {}} title="ACL deshabilitadas (recomendado)" desc="Todos los objetos de este bucket son propiedad de esta cuenta. El acceso se especifica únicamente mediante políticas." />
        <Tile on={false} onClick={() => {}} title="ACL habilitadas" desc="No disponible en el simulador: el motor solo admite bucket owner enforced." />
      </Card>
      <Card title="Configuración de bloqueo de acceso público para este bucket">
        <p className="k-muted">El acceso público se concede a buckets y objetos mediante ACL, políticas de bucket, políticas de puntos de acceso o todas ellas. Para garantizar que se bloquee el acceso público, active Bloquear todo el acceso público.</p>
        <BpaEditor value={bpa} onChange={(v) => { setBpa(v); setAck(false); }} />
        {needAck && (
          <div className="k-warnbox">
            <b>⚠ Desactivar el bloqueo de todo el acceso público puede hacer que este bucket y los objetos que contiene se vuelvan públicos</b>
            <div>AWS recomienda activar Bloquear todo el acceso público, a menos que se requiera acceso público para casos de uso específicos, como el alojamiento de sitios web estáticos.</div>
            <label style={{ display: 'block', marginTop: 8 }}><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Reconozco que la configuración actual puede provocar que este bucket y los objetos que contiene se vuelvan públicos.</label>
          </div>
        )}
      </Card>
      <Card title="Control de versiones de buckets">
        <p className="k-muted">El control de versiones es un medio de conservar varias variantes de un objeto en el mismo bucket.</p>
        <Tile on={!ver} onClick={() => setVer(false)} title="Deshabilitar" />
        <Tile on={ver} onClick={() => setVer(true)} title="Habilitar" />
      </Card>
      <Card title="Etiquetas - opcional"><TagEditor tags={tags} onChange={setTags} /></Card>
      <Card title="Cifrado predeterminado">
        <p className="k-muted">El cifrado del servidor se aplica automáticamente a los objetos nuevos almacenados en este bucket.</p>
        <Tile on={enc === 'AES256'} onClick={() => setEnc('AES256')} title="Cifrado del lado del servidor con claves administradas de Amazon S3 (SSE-S3)" />
        <Tile on={enc === 'aws:kms'} onClick={() => setEnc('aws:kms')} title="Cifrado del lado del servidor con claves de AWS Key Management Service (SSE-KMS)" />
        {enc === 'aws:kms' && <Field label="Clave de AWS KMS (ARN o alias)"><input type="text" value={kms} onChange={(e) => setKms(e.target.value)} placeholder="alias/aws/s3" /></Field>}
      </Card>
      <CliEquivalent cmd={cmd} />
      <div className="k-foot"><Btn onClick={() => nav('/s3/buckets')}>Cancelar</Btn><Btn kind="primary" disabled={!name || !!nameErr || busy || (needAck && !ack)} onClick={go}>Crear bucket</Btn></div>
    </>
  );
}

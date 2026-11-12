import React, { useState } from 'react';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, Modal, PageHead, Table, nav } from '../../components/ui';
import { ConfirmModal, Dl, run, takeFlash, setNextFlash } from '../iam/kit';
import { useContainers, link, enc, when, bytes, St, NotFound } from './common';
import type { EcrImage } from '../../../engine/services/containerCore';
import { scanOf } from '../../../engine/services/ecr';

const CR = { label: 'Amazon Elastic Container Registry', to: '/ecr/repos' };

export function EcrRepos() {
  const { s, c } = useContainers();
  const [flash, setFlash] = useState(takeFlash);
  const [sel, setSel] = useState<string[]>([]);
  const [modal, setModal] = useState<null | 'create' | 'delete'>(null);
  const [name, setName] = useState('');
  const [immutable, setImmutable] = useState(false);
  const [scan, setScan] = useState(false);
  const [err, setErr] = useState('');
  const repos = c.ecr.filter((r) => r.region === s.region);
  const cmd = `aws ecr create-repository --repository-name ${name || '<nombre>'} --image-tag-mutability ${immutable ? 'IMMUTABLE' : 'MUTABLE'}${scan ? ' --image-scanning-configuration scanOnPush=true' : ''}`;
  const create = async () => {
    const r = await run(cmd);
    if (!r.ok) return r.msg;
    setFlash(`Se creó correctamente el repositorio ${name}.`);
    setName('');
  };
  return (
    <>
      <Crumbs items={[CR, { label: 'Repositorios privados' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title="Repositorios privados" desc="Almacene, administre e implemente imágenes de contenedor. Cada repositorio pertenece a su cuenta y región." />
      <Card title="Repositorios" count={repos.length} flush actions={<div className="ct-row"><Btn disabled={sel.length !== 1} onClick={() => setModal('delete')}>Eliminar</Btn><Btn kind="primary" onClick={() => setModal('create')}>Crear repositorio</Btn></div>}>
        <Table rows={repos} id={(r) => r.name} selected={sel} onSelect={(x) => setSel(x.slice(-1))} filterPlaceholder="Buscar repositorios" empty={{ title: 'No hay repositorios', desc: 'Cree un repositorio para guardar sus imágenes de contenedor.' }} cols={[
          { head: 'Nombre del repositorio', cell: (r) => link('/ecr/repo/' + enc(r.name), r.name), text: (r) => r.name },
          { head: 'URI', cell: (r) => r.uri, text: (r) => r.uri },
          { head: 'Creado el', cell: (r) => when(r.createdAt) },
          { head: 'Inmutabilidad de etiquetas', cell: (r) => (r.tagMutability === 'IMMUTABLE' ? 'Habilitado' : 'Deshabilitado'), text: (r) => r.tagMutability },
          { head: 'Análisis al enviar', cell: (r) => (r.scanOnPush ? 'Habilitado' : 'Deshabilitado'), text: (r) => String(r.scanOnPush) },
        ]} />
      </Card>
      {modal === 'create' && (
        <Modal title="Crear repositorio" onClose={() => setModal(null)} footer={<><Btn onClick={() => setModal(null)}>Cancelar</Btn><Btn kind="primary" disabled={!/^[a-z0-9][a-z0-9._/-]*$/.test(name)} onClick={async () => { const e = await create(); if (e) setErr(e); setModal(null); }}>Crear</Btn></>}>
          <div className="ct-form">
            <Field label="Nombre del repositorio" hint="Solo minúsculas, números, guiones, puntos, guiones bajos y barras."><input className="k-input" type="text" aria-label="Nombre del repositorio" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
            <Field label="Inmutabilidad de etiquetas"><label><input type="checkbox" checked={immutable} onChange={(e) => setImmutable(e.target.checked)} /> Impedir que se sobrescriban las etiquetas existentes</label></Field>
            <Field label="Análisis de imágenes"><label><input type="checkbox" checked={scan} onChange={(e) => setScan(e.target.checked)} /> Analizar al enviar (scanOnPush)</label></Field>
            <CliEquivalent cmd={cmd} />
          </div>
        </Modal>
      )}
      {modal === 'delete' && sel[0] && (
        <ConfirmModal title="Eliminar repositorio" confirmLabel="Eliminar" danger requireText="eliminar" onClose={() => setModal(null)} onConfirm={async () => { const r = await run(`aws ecr delete-repository --repository-name ${sel[0]} --force`); if (!r.ok) return r.msg; setSel([]); setFlash(`Se eliminó el repositorio ${sel[0]}.`); }}>
          Se eliminará el repositorio <b>{sel[0]}</b> y todas sus imágenes. Esta acción no se puede deshacer.
        </ConfirmModal>
      )}
    </>
  );
}

export function EcrRepo({ name }: { name: string }) {
  const { s, c } = useContainers();
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const [push, setPush] = useState(false);
  const [del, setDel] = useState(false);
  const r = c.ecr.find((x) => x.name === name && x.region === s.region);
  if (!r) return <><Crumbs items={[CR]} /><NotFound what={`El repositorio ${name} no existe en la región ${s.region}.`} /></>;
  const host = r.uri.split('/')[0];
  const ref = (i: EcrImage) => (i.tags[0] ? `imageTag=${i.tags[0]}` : `imageDigest=${i.digest}`);
  const act = async (cmd: string, ok: string) => { const x = await run(cmd); if (!x.ok) { setErr(x.msg); return; } setErr(''); setFlash(ok); };
  const selImg = r.images.find((i) => i.digest === sel[0]);
  const imgs = [...r.images].sort((a, b) => b.pushedAt - a.pushedAt);
  return (
    <>
      <Crumbs items={[CR, { label: 'Repositorios privados', to: '/ecr/repos' }, { label: r.name }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title={r.name}><Btn onClick={() => setPush(true)}>Ver comandos de envío</Btn><Btn kind="danger" onClick={() => setDel(true)}>Eliminar</Btn></PageHead>
      <Card title="Detalles del repositorio"><Dl items={[['URI', r.uri], ['ARN', r.arn], ['Creado el', when(r.createdAt)], ['Inmutabilidad de etiquetas', r.tagMutability === 'IMMUTABLE' ? 'Habilitado' : 'Deshabilitado'], ['Análisis al enviar', r.scanOnPush ? 'Habilitado' : 'Deshabilitado'], ['Cifrado', r.encryption === 'KMS' ? 'KMS' : 'AES-256'], ['Política de ciclo de vida', r.lifecyclePolicy ? 'Configurada' : 'Ninguna']]} /></Card>
      <Card title="Imágenes" count={imgs.length} flush actions={<div className="ct-row"><Btn disabled={!selImg} onClick={() => selImg && act(`aws ecr start-image-scan --repository-name ${r.name} --image-id ${ref(selImg)}`, 'Análisis de la imagen iniciado.')}>Analizar</Btn><Btn kind="danger" disabled={!selImg} onClick={() => selImg && act(`aws ecr batch-delete-image --repository-name ${r.name} --image-ids ${ref(selImg)}`, 'Imagen eliminada.')}>Eliminar</Btn></div>}>
        <Table rows={imgs} id={(i) => i.digest} selected={sel} onSelect={(x) => setSel(x.slice(-1))} empty={{ title: 'No hay imágenes', desc: 'Envíe una imagen con docker push para verla aquí.' }} cols={[
          { head: 'Etiquetas de la imagen', cell: (i) => (i.tags.length ? i.tags.join(', ') : <span className="ct-muted">Sin etiquetar</span>), text: (i) => i.tags.join(',') },
          { head: 'Resumen', cell: (i) => i.digest.slice(0, 19) + '…', text: (i) => i.digest },
          { head: 'Enviado el', cell: (i) => when(i.pushedAt), text: (i) => String(i.pushedAt) },
          { head: 'Tamaño', cell: (i) => bytes(i.sizeBytes), text: (i) => String(i.sizeBytes) },
          { head: 'Análisis', cell: (i) => { const sc = scanOf(i); return sc ? <><St v={sc.status} /> {sc.status === 'COMPLETE' && <span className="ct-sev">{Object.entries(sc.counts).map(([k, v]) => <span key={k} className={k}>{k} {v}</span>)}</span>}</> : <span className="ct-muted">Sin analizar</span>; }, text: (i) => scanOf(i)?.status ?? '' },
        ]} />
      </Card>
      {push && (
        <Modal title={`Comandos de envío para ${r.name}`} onClose={() => setPush(false)} footer={<Btn onClick={() => setPush(false)}>Cerrar</Btn>}>
          <p>Use estos comandos desde CloudShell (o cualquier terminal de la consola) para autenticarse y subir una imagen.</p>
          <pre className="ct-pre">{`aws ecr get-login-password --region ${r.region} | docker login --username AWS --password-stdin ${host}\ndocker build -t ${r.name} .\ndocker tag ${r.name}:latest ${r.uri}:latest\ndocker push ${r.uri}:latest`}</pre>
          <Btn onClick={() => { setPush(false); nav('/cloudshell'); }}>Abrir CloudShell</Btn>
        </Modal>
      )}
      {del && <ConfirmModal title="Eliminar repositorio" confirmLabel="Eliminar" danger requireText="eliminar" onClose={() => setDel(false)} onConfirm={async () => { const x = await run(`aws ecr delete-repository --repository-name ${r.name} --force`); if (!x.ok) return x.msg; setNextFlash(`Se eliminó el repositorio ${r.name}.`); nav('/ecr/repos'); }}>Se eliminará <b>{r.name}</b> con todas sus imágenes.</ConfirmModal>}
    </>
  );
}

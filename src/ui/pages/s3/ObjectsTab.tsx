import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Btn, Flash, Modal, Field, Table, nav, fmtDate } from '../../components/ui';
import { ConfirmModal, Menu, run, q } from '../iam/kit';
import { fetchObject, saveBlob, putObject, fmtSize, Preview } from './objects';
import type { S3Bucket } from '../../../engine/types';

interface Row { kind: 'folder' | 'object' | 'version'; name: string; key: string; size?: number; lastModified?: string; storageClass?: string; versionId?: string; marker?: boolean; current?: boolean }

export const objectPath = (bucket: string, key: string) => `/s3/bucket/${bucket}/object/${encodeURIComponent(key)}`;

export function ObjectsTab({ b, notify }: { b: S3Bucket; notify: (kind: 'ok' | 'err', msg: string) => void }) {
  const name = b.name;
  const [prefix, setPrefix] = useState('');
  const [list, setList] = useState<{ folders: string[]; files: any[] } | null>(null);
  const [listErr, setListErr] = useState('');
  const [showVer, setShowVer] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [modal, setModal] = useState<null | 'upload' | 'folder' | 'del' | { open: { body: string; contentType: string; key: string } }>(null);

  const refresh = useCallback(async () => {
    const r = await run(`aws s3api list-objects-v2 --bucket ${name}${prefix ? ` --prefix ${q(prefix)}` : ''} --delimiter /`);
    if (!r.ok) { setListErr(r.msg); setList(null); return; }
    setListErr('');
    setList({ folders: (r.json?.CommonPrefixes ?? []).map((x: any) => x.Prefix), files: (r.json?.Contents ?? []).filter((c: any) => c.Key !== prefix) });
    setSel([]);
  }, [name, prefix]);
  useEffect(() => { refresh(); }, [refresh]);

  // Vista con versiones: se calcula a partir del estado del bucket.
  const versionRows = (): Row[] => {
    const rows: Row[] = [];
    const folders = new Set<string>();
    const keys = new Set([...Object.keys(b.objects), ...Object.keys(b.versions)]);
    for (const k of [...keys].sort()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const i = rest.indexOf('/');
      if (i >= 0) { folders.add(prefix + rest.slice(0, i + 1)); continue; }
      if (k === prefix) continue;
      const live = b.objects[k];
      const all = [...(b.versions[k] ?? [])];
      if (live && !all.some((v) => v.versionId === live.versionId)) all.push(live);
      all.reverse().forEach((v) => rows.push({ kind: 'version', name: rest, key: k, size: v.size, lastModified: v.lastModified, storageClass: v.storageClass, versionId: v.versionId ?? 'null', marker: !!(v as any).deleteMarker, current: live?.versionId === v.versionId }));
    }
    return [...[...folders].map((f) => ({ kind: 'folder', name: f.slice(prefix.length), key: f } as Row)), ...rows];
  };
  const rows: Row[] = showVer && b.versioning !== 'Disabled' ? versionRows() : [
    ...(list?.folders ?? []).map((f) => ({ kind: 'folder', name: f.slice(prefix.length), key: f } as Row)),
    ...(list?.files ?? []).map((o) => ({ kind: 'object', name: o.Key.slice(prefix.length), key: o.Key, size: o.Size, lastModified: o.LastModified, storageClass: o.StorageClass } as Row)),
  ];
  const rid = (r: Row) => `${r.kind}|${r.key}|${r.versionId ?? ''}`;
  const selRows = rows.filter((r) => sel.includes(rid(r)));
  const parts = prefix.split('/').filter(Boolean);

  const doDelete = async (): Promise<string | void> => {
    for (const r of selRows) {
      if (r.kind === 'folder') {
        const keys = [...Object.keys(b.objects)].filter((k) => k.startsWith(r.key));
        for (const k of keys) { const x = await run(`aws s3api delete-object --bucket ${name} --key ${q(k)}`); if (!x.ok) return x.msg; }
      } else {
        const x = await run(`aws s3api delete-object --bucket ${name} --key ${q(r.key)}${r.kind === 'version' && r.versionId && r.versionId !== 'null' ? ` --version-id ${r.versionId}` : ''}`);
        if (!x.ok) return x.msg;
      }
    }
    notify('ok', `Se eliminó correctamente ${selRows.length} elemento(s).`);
    await refresh();
  };
  const openObj = async (r: Row) => {
    const f = await fetchObject(name, r.key, r.versionId !== 'null' ? r.versionId : undefined);
    if (!f.ok) return notify('err', f.msg);
    setModal({ open: { body: f.body, contentType: f.contentType, key: r.key } });
  };
  const download = async (r: Row) => {
    const f = await fetchObject(name, r.key, r.versionId !== 'null' ? r.versionId : undefined);
    if (!f.ok) return notify('err', f.msg);
    saveBlob(r.key, f.body, f.contentType);
  };
  const one = selRows.length === 1 && selRows[0].kind !== 'folder' ? selRows[0] : null;
  const m = modal as any;
  return (
    <div className="card" style={{ borderTop: 0 }}>
      <div className="s3-heading">
        <div><h2>Objetos <span className="k-muted" style={{ fontWeight: 400 }}>({rows.filter((r) => r.kind !== 'folder').length})</span></h2><p>Los objetos son las entidades fundamentales almacenadas en Amazon S3. Puede usar el inventario de Amazon S3 para obtener una lista de todos los objetos del bucket.</p></div>
        <div className="actions">
          <Btn small onClick={refresh}>↻ Actualizar</Btn>
          <Btn small disabled={!one} onClick={() => one && download(one)}>Descargar</Btn>
          <Btn small disabled={!one} onClick={() => one && openObj(one)}>Abrir</Btn>
          <Btn small disabled={!selRows.length} onClick={() => setModal('del')}>Eliminar</Btn>
          <Btn small onClick={() => setModal('folder')}>Crear carpeta</Btn>
          <Btn small kind="primary" onClick={() => setModal('upload')}>Cargar</Btn>
        </div>
      </div>
      <div className="s3-path">
        <a onClick={() => setPrefix('')}>{name}</a>
        {parts.map((p, i) => (<React.Fragment key={i}><span className="k-muted">/</span><a onClick={() => setPrefix(parts.slice(0, i + 1).join('/') + '/')}>{p}</a></React.Fragment>))}
      </div>
      {listErr && <div style={{ padding: '10px 20px 0' }}><Flash kind="err" title="Error al mostrar los objetos">{listErr}</Flash></div>}
      <Table rows={rows} id={rid} selected={sel} onSelect={setSel} filterPlaceholder="Buscar objetos por prefijo"
        toolbar={b.versioning !== 'Disabled' ? <label className="k-switch"><input type="checkbox" checked={showVer} onChange={(e) => setShowVer(e.target.checked)} /> Mostrar versiones</label> : undefined}
        empty={{ title: 'No hay objetos', desc: 'No tiene objetos en este bucket. Utilice Cargar para agregar archivos.' }}
        cols={[
          { head: 'Nombre', cell: (r) => r.kind === 'folder' ? <a onClick={() => setPrefix(r.key)}><span className="s3-ico">📁</span>{r.name}</a> : <a onClick={() => nav(objectPath(name, r.key) + (r.versionId && r.versionId !== 'null' ? `?v=${r.versionId}` : ''))}><span className="s3-ico">📄</span>{r.name}</a>, text: (r) => r.name },
          ...(showVer && b.versioning !== 'Disabled' ? [{ head: 'ID de versión', cell: (r: Row) => (r.kind === 'folder' ? '-' : <span className="mono">{r.versionId}{r.marker ? ' (marcador de eliminación)' : ''}{r.current ? ' · actual' : ''}</span>) }] : []),
          { head: 'Tipo', cell: (r) => (r.kind === 'folder' ? 'Carpeta' : r.name.includes('.') ? r.name.split('.').pop() : '-') },
          { head: 'Última modificación', cell: (r) => (r.lastModified ? fmtDate(r.lastModified) : '-') },
          { head: 'Tamaño', cell: (r) => (r.kind === 'folder' ? '-' : fmtSize(r.size ?? 0)) },
          { head: 'Clase de almacenamiento', cell: (r) => (r.storageClass ? (r.storageClass === 'STANDARD' ? 'Estándar' : r.storageClass) : '-') },
        ]} />
      {modal === 'upload' && <UploadModal bucket={name} prefix={prefix} onClose={() => setModal(null)} onDone={async (n) => { notify('ok', `Carga correcta: ${n} archivo(s).`); await refresh(); }} />}
      {modal === 'folder' && <FolderModal bucket={name} prefix={prefix} onClose={() => setModal(null)} onDone={async (n) => { notify('ok', `Se creó la carpeta ${n}.`); await refresh(); }} />}
      {modal === 'del' && (
        <ConfirmModal title="Eliminar objetos" confirmLabel="Eliminar objetos" danger requireText="eliminar de forma permanente" onConfirm={doDelete} onClose={() => setModal(null)}>
          <Flash kind="info" title="Eliminar objetos no se puede deshacer">{b.versioning === 'Enabled' && selRows.some((r) => r.kind === 'object') ? 'Como el bucket tiene el control de versiones habilitado, se agregará un marcador de eliminación; las versiones anteriores se conservan.' : 'Los objetos se eliminarán de forma permanente.'}</Flash>
          <ul>{selRows.map((r) => <li key={rid(r)}>{r.key}{r.versionId && r.versionId !== 'null' ? ` (versión ${r.versionId})` : ''}</li>)}</ul>
        </ConfirmModal>
      )}
      {m?.open && <Modal title={m.open.key} onClose={() => setModal(null)} footer={<Btn onClick={() => setModal(null)}>Cerrar</Btn>}><Preview body={m.open.body} contentType={m.open.contentType} /></Modal>}
    </div>
  );
}

function UploadModal({ bucket, prefix, onClose, onDone }: { bucket: string; prefix: string; onClose: () => void; onDone: (n: number) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [mode, setMode] = useState<'file' | 'text'>('file');
  const [key, setKey] = useState('');
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const inp = useRef<HTMLInputElement>(null);
  const go = async () => {
    setBusy(true); setErr('');
    let n = 0;
    if (mode === 'text') {
      const e = await putObject(bucket, prefix + key, text);
      if (e) { setBusy(false); return setErr(e); }
      n = 1;
    } else {
      for (const f of files) {
        const e = await putObject(bucket, prefix + f.name, await f.text(), f.type || undefined);
        if (e) { setBusy(false); return setErr(`${f.name}: ${e}`); }
        n++;
      }
    }
    onDone(n); onClose();
  };
  return (
    <Modal title="Cargar" onClose={onClose} footer={<><Btn onClick={onClose}>Cancelar</Btn><Btn kind="primary" disabled={busy || (mode === 'file' ? !files.length : !key)} onClick={go}>Cargar</Btn></>}>
      {err && <Flash kind="err" title="Error al cargar">{err}</Flash>}
      <div className="k-sub"><label><input type="radio" checked={mode === 'file'} onChange={() => setMode('file')} /> Archivos del equipo</label>&nbsp;&nbsp;<label><input type="radio" checked={mode === 'text'} onChange={() => setMode('text')} /> Escribir texto</label></div>
      <div className="k-muted" style={{ marginBottom: 8 }}>Destino: s3://{bucket}/{prefix}</div>
      {mode === 'file' ? (
        <>
          <div className={`k-dropzone ${over ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); setFiles([...files, ...Array.from(e.dataTransfer.files)]); }}>
            Arrastre y suelte archivos aquí, o <Btn small onClick={() => inp.current?.click()}>Agregar archivos</Btn>
            <input ref={inp} type="file" multiple style={{ display: 'none' }} data-testid="file-input" onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])} />
          </div>
          {files.length > 0 && <ul>{files.map((f, i) => <li key={i}>{f.name} ({fmtSize(f.size)}) <a onClick={() => setFiles(files.filter((_, j) => j !== i))}>Quitar</a></li>)}</ul>}
          <div className="k-muted" style={{ fontSize: 12, marginTop: 6 }}>El simulador almacena el contenido como texto; los archivos binarios pueden verse alterados.</div>
        </>
      ) : (
        <>
          <Field label="Nombre del objeto"><input className="k-input" type="text" placeholder="archivo.txt" value={key} onChange={(e) => setKey(e.target.value)} /></Field>
          <Field label="Contenido"><textarea value={text} onChange={(e) => setText(e.target.value)} style={{ width: '100%', minHeight: 120 }} /></Field>
        </>
      )}
    </Modal>
  );
}

function FolderModal({ bucket, prefix, onClose, onDone }: { bucket: string; prefix: string; onClose: () => void; onDone: (n: string) => void }) {
  const [n, setN] = useState('');
  const bad = n.includes('/') ? 'El nombre de la carpeta no puede contener "/".' : '';
  return (
    <ConfirmModal title="Crear carpeta" confirmLabel="Crear carpeta" disabled={!n || !!bad} onClose={onClose} onConfirm={async () => { const r = await run(`aws s3api put-object --bucket ${bucket} --key ${q(prefix + n + '/')}`); if (!r.ok) return r.msg; onDone(n); }}>
      <p className="k-muted">Cuando crea una carpeta, S3 crea un objeto con el nombre que usted especifica seguido de una barra diagonal (/).</p>
      <Field label="Nombre de la carpeta" error={bad}><input className="k-input" type="text" value={n} onChange={(e) => setN(e.target.value)} autoFocus /></Field>
    </ConfirmModal>
  );
}

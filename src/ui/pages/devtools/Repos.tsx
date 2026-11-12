import React, { useState } from 'react';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, Modal, PageHead, Table, nav } from '../../components/ui';
import { ConfirmModal, Menu, run, takeFlash } from '../iam/kit';
import { useCicd, ts } from './common';
import { cicd } from '../../../engine/services/cicdTypes';
import { cloneUrl } from '../../../engine/services/codecommit';

export function Repos() {
  const s = useCicd();
  const [flash, setFlash] = useState(takeFlash);
  const [sel, setSel] = useState<string[]>([]);
  const [create, setCreate] = useState(false);
  const [del, setDel] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [err, setErr] = useState('');
  const rows = cicd(s).repos.filter((r) => r.region === s.region).sort((a, b) => a.name.localeCompare(b.name));
  const cur = rows.find((r) => r.name === sel[0]);
  const cmd = `aws codecommit create-repository --repository-name ${name || '<nombre>'}${desc ? ` --repository-description '${desc}'` : ''}`;
  return (
    <>
      <Crumbs items={[{ label: 'Developer Tools', to: '/devtools/repos' }, { label: 'Repositorios' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <PageHead title="Repositorios" desc="Repositorios Git privados y administrados (CodeCommit). Clónelos con git desde CloudShell." />
      <Card title="Repositorios" count={rows.length} flush actions={<>
        <Menu label="Acciones" items={[{ label: 'Eliminar repositorio', disabled: !cur, onClick: () => setDel(true) }]} />
        <Btn kind="primary" onClick={() => { setErr(''); setCreate(true); }}>Crear repositorio</Btn>
      </>}>
        <Table rows={rows} id={(r) => r.name} selected={sel} onSelect={(ids) => setSel(ids.slice(-1))} filterPlaceholder="Filtrar repositorios" empty={{ title: 'No hay repositorios', desc: 'Cree un repositorio para empezar a trabajar con Git.' }} cols={[
          { head: 'Nombre', cell: (r) => <a onClick={() => nav('/devtools/repo/' + encodeURIComponent(r.name))}>{r.name}</a>, text: (r) => r.name },
          { head: 'Descripción', cell: (r) => r.description ?? '–', text: (r) => r.description ?? '' },
          { head: 'Última modificación', cell: (r) => ts(r.modified), text: (r) => String(r.modified) },
          { head: 'URL de clonación HTTPS', cell: (r) => <code>{cloneUrl(r.region, r.name)}</code>, text: (r) => r.name },
        ]} />
      </Card>
      {create && (
        <Modal title="Crear repositorio" onClose={() => setCreate(false)} footer={<><Btn onClick={() => setCreate(false)}>Cancelar</Btn><Btn kind="primary" disabled={!name} onClick={async () => {
          const r = await run(cmd);
          if (!r.ok) { setErr(r.msg); return; }
          setCreate(false); setFlash(`Repositorio "${name}" creado.`); setName(''); setDesc('');
        }}>Crear</Btn></>}>
          {err && <Flash kind="err" title="Error">{err}</Flash>}
          <Field label="Nombre del repositorio" hint="Hasta 100 caracteres: letras, números, punto, guion y guion bajo."><input className="k-input" aria-label="Nombre del repositorio" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Descripción"><input className="k-input" aria-label="Descripción" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
          <CliEquivalent cmd={cmd} />
        </Modal>
      )}
      {del && cur && (
        <ConfirmModal title={`¿Eliminar el repositorio ${cur.name}?`} confirmLabel="Eliminar" danger requireText={cur.name} onClose={() => setDel(false)} onConfirm={async () => {
          const r = await run(`aws codecommit delete-repository --repository-name ${cur.name}`);
          if (!r.ok) return r.msg;
          setFlash(`Repositorio "${cur.name}" eliminado.`); setSel([]);
        }}>
          <p>Se perderán todos los commits, ramas y solicitudes de incorporación de cambios. Esta acción no se puede deshacer.</p>
        </ConfirmModal>
      )}
    </>
  );
}

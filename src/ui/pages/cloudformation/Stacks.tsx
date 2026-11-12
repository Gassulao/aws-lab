import React, { useState } from 'react';
import { Btn, Card, CliEquivalent, Crumbs, Flash, PageHead, Table, nav, fmtDate } from '../../components/ui';
import { ConfirmModal, Menu, run, takeFlash } from '../iam/kit';
import { StackStatusBadge, useCfn } from './common';

export function StacksList() {
  const s = useCfn();
  const [flash, setFlash] = useState(takeFlash);
  const [sel, setSel] = useState<string[]>([]);
  const [del, setDel] = useState(false);
  const [filter, setFilter] = useState<'active' | 'deleted'>('active');
  const rows = (s.cfn.stacks ?? []).filter((x) => x.region === s.region && (filter === 'deleted' ? x.status === 'DELETE_COMPLETE' : x.status !== 'DELETE_COMPLETE')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const cur = rows.find((r) => r.name === sel[0]);
  return (
    <>
      <Crumbs items={[{ label: 'CloudFormation', to: '/cloudformation/stacks' }, { label: 'Pilas' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <PageHead title="Pilas" desc="Despliegue infraestructura como código: cada plantilla JSON o YAML crea, actualiza y elimina un conjunto de recursos como una unidad." />
      <Card title="Pilas" count={rows.length} flush actions={<>
        <select className="k-select" aria-label="Filtro de estado" value={filter} onChange={(e) => { setFilter(e.target.value as 'active'); setSel([]); }}><option value="active">Activas</option><option value="deleted">Eliminadas</option></select>
        <Menu label="Acciones" items={[{ label: 'Eliminar', disabled: !cur || cur.status === 'DELETE_COMPLETE', onClick: () => setDel(true) }]} />
        <Btn kind="primary" onClick={() => nav('/cloudformation/create')}>Crear pila</Btn>
      </>}>
        <Table rows={rows} id={(x) => x.name} selected={sel} onSelect={(ids) => setSel(ids.slice(-1))} filterPlaceholder="Filtrar por nombre de pila" empty={{ title: 'No hay pilas', desc: 'No hay pilas en esta región. Cree una pegando una plantilla.' }} cols={[
          { head: 'Nombre de la pila', cell: (x) => <a onClick={() => nav('/cloudformation/stack/' + encodeURIComponent(x.name))}>{x.name}</a>, text: (x) => x.name },
          { head: 'Estado', cell: (x) => <StackStatusBadge s={x.status} />, text: (x) => x.status },
          { head: 'Hora de creación', cell: (x) => fmtDate(x.createdAt), text: (x) => x.createdAt },
          { head: 'Descripción', cell: (x) => x.description ?? '–', text: (x) => x.description ?? '' },
        ]} />
      </Card>
      {del && cur && (
        <ConfirmModal title={`¿Eliminar la pila ${cur.name}?`} confirmLabel="Eliminar" danger onClose={() => setDel(false)} onConfirm={async () => {
          const r = await run(`aws cloudformation delete-stack --stack-name ${cur.name}`);
          if (!r.ok) return r.msg;
          setFlash(`Se inició la eliminación de la pila "${cur.name}".`); setSel([]);
        }}>
          <p>Se eliminarán todos los recursos de la pila (salvo los que tengan DeletionPolicy Retain).</p>
          <CliEquivalent cmd={`aws cloudformation delete-stack --stack-name ${cur.name}`} />
        </ConfirmModal>
      )}
    </>
  );
}

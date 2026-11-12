import React, { useState } from 'react';
import { Btn, Card, Crumbs, Flash, PageHead, Table, nav, fmtDate } from '../../components/ui';
import { ConfirmModal, Dl, Menu, Tabs, run, takeFlash } from '../iam/kit';
import { StackStatusBadge, toneOf, useCfn } from './common';
import { CreateStack } from './Create';
import { changeSetStatus, findStack, visibleEvents, visibleOutputs, visibleResources } from '../../../engine/services/cloudformation';
import { Status } from '../../components/ui';

type Tab = 'ev' | 'res' | 'out' | 'par' | 'tpl' | 'cs';
const ts = (ms: number) => fmtDate(new Date(ms).toISOString());

export function StackDetail({ name }: { name: string }) {
  const s = useCfn();
  const [tab, setTab] = useState<Tab>('ev');
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [modal, setModal] = useState<null | 'del'>(null);
  const [editing, setEditing] = useState(false);
  const ctx = { s, caller: { type: 'Root' as const, arn: s.me.arn, userName: s.me.userName, mfa: false, sourceIp: '' }, region: s.region };
  const st = findStack(ctx, name, { deleted: true });
  if (!st) return <><Crumbs items={[{ label: 'CloudFormation', to: '/cloudformation/stacks' }, { label: 'Pilas', to: '/cloudformation/stacks' }]} /><Flash kind="err" title="ValidationError">Stack with id {name} does not exist</Flash></>;
  if (editing) return <CreateStack update={st.name} initial={st.template} />;
  const busy = st.status.endsWith('IN_PROGRESS');
  const events = visibleEvents(s, st);
  const resources = visibleResources(s, st);
  const outs = visibleOutputs(st);
  const gone = st.status === 'DELETE_COMPLETE';
  return (
    <>
      <Crumbs items={[{ label: 'CloudFormation', to: '/cloudformation/stacks' }, { label: 'Pilas', to: '/cloudformation/stacks' }, { label: st.name }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      {st.statusReason && /FAILED|ROLLBACK/.test(st.status) && <Flash kind="err" title={st.status}>{st.statusReason}</Flash>}
      <PageHead title={<>{st.name} <StackStatusBadge s={st.status} /></>}>
        <Btn onClick={() => setEditing(true)} disabled={busy || gone || !['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'].includes(st.status)}>Actualizar</Btn>
        <Menu label="Acciones" items={[{ label: 'Eliminar pila', disabled: busy || gone, onClick: () => setModal('del') }]} />
      </PageHead>
      <Card title="Información de la pila">
        <Dl items={[['ID de la pila', st.id], ['Estado', st.status], ['Descripción', st.description], ['Hora de creación', fmtDate(st.createdAt)], ['Última actualización', st.updatedAt ? fmtDate(st.updatedAt) : '–'], ['Rol de IAM', st.roleArn ?? '–'], ['Reversión', st.disableRollback ? 'Deshabilitada' : 'Habilitada'], ['Protección contra terminación', st.terminationProtection ? 'Habilitada' : 'Deshabilitada'], ['Capacidades', st.capabilities.join(', ') || '–']]} />
      </Card>
      <div className="card" style={{ marginBottom: 20 }}>
        <Tabs<Tab> active={tab} onChange={setTab} tabs={[{ id: 'ev', label: 'Eventos' }, { id: 'res', label: 'Recursos' }, { id: 'out', label: 'Salidas' }, { id: 'par', label: 'Parámetros' }, { id: 'tpl', label: 'Plantilla' }, { id: 'cs', label: 'Conjuntos de cambios' }]} />
        {tab === 'ev' && (
          <Table rows={events} id={(e) => `${e.seq}`} pageSize={50} empty={{ title: 'Sin eventos' }} cols={[
            { head: 'Marca de tiempo', cell: (e) => ts(e.ts), text: (e) => new Date(e.ts).toISOString() },
            { head: 'ID lógico', cell: (e) => e.logicalId, text: (e) => e.logicalId },
            { head: 'Estado', cell: (e) => <Status tone={toneOf(e.status)}>{e.status}</Status>, text: (e) => e.status },
            { head: 'Motivo del estado', cell: (e) => <span className="cf-reason">{e.reason ?? '–'}</span>, text: (e) => e.reason ?? '' },
          ]} />
        )}
        {tab === 'res' && (
          <Table rows={resources} id={(r) => r.res.logicalId} empty={{ title: 'Sin recursos', desc: 'La pila todavía no ha creado recursos.' }} cols={[
            { head: 'ID lógico', cell: (r) => r.res.logicalId, text: (r) => r.res.logicalId },
            { head: 'ID físico', cell: (r) => r.res.physicalId || '–', text: (r) => r.res.physicalId },
            { head: 'Tipo', cell: (r) => r.res.type, text: (r) => r.res.type },
            { head: 'Estado', cell: (r) => <Status tone={toneOf(r.status)}>{r.status}</Status>, text: (r) => r.status },
            { head: 'Motivo', cell: (r) => <span className="cf-reason">{r.reason ?? '–'}</span> },
          ]} />
        )}
        {tab === 'out' && (
          <Table rows={outs} id={(o) => o.key} empty={{ title: 'Sin salidas', desc: 'La pila no tiene salidas (o todavía no ha terminado de crearse).' }} cols={[
            { head: 'Clave', cell: (o) => o.key, text: (o) => o.key }, { head: 'Valor', cell: (o) => o.value, text: (o) => o.value }, { head: 'Descripción', cell: (o) => o.description ?? '–' }, { head: 'Nombre de exportación', cell: (o) => o.exportName ?? '–' },
          ]} />
        )}
        {tab === 'par' && (
          <Table rows={st.parameters} id={(p) => p.key} empty={{ title: 'Sin parámetros' }} cols={[{ head: 'Clave', cell: (p) => p.key, text: (p) => p.key }, { head: 'Valor', cell: (p) => (p.noEcho ? '****' : p.value) }, { head: 'Tipo', cell: (p) => p.type }]} />
        )}
        {tab === 'tpl' && <div className="body2"><pre className="k-pre">{st.template || '(sin plantilla todavía)'}</pre></div>}
        {tab === 'cs' && (
          <Table rows={st.changeSets} id={(c) => c.id} empty={{ title: 'Sin conjuntos de cambios' }} cols={[
            { head: 'Nombre', cell: (c) => c.name, text: (c) => c.name }, { head: 'Estado', cell: (c) => changeSetStatus(s, c).status }, { head: 'Ejecución', cell: (c) => changeSetStatus(s, c).execution },
            { head: 'Cambios', cell: (c) => c.changes.map((x) => `${x.action} ${x.logicalId}${x.replacement === 'True' ? ' (sustitución)' : ''}`).join(', ') || '–' },
          ]} />
        )}
      </div>
      {modal === 'del' && (
        <ConfirmModal title={`¿Eliminar la pila ${st.name}?`} confirmLabel="Eliminar" danger onClose={() => setModal(null)} onConfirm={async () => {
          const r = await run(`aws cloudformation delete-stack --stack-name ${st.name}`);
          if (!r.ok) { setErr(r.msg); return r.msg; }
          setFlash('Se inició la eliminación de la pila.');
        }}>
          <p>Se eliminarán la pila y todos sus recursos.</p>
        </ConfirmModal>
      )}
      <Btn small onClick={() => nav('/cloudformation/stacks')}>Volver a las pilas</Btn>
    </>
  );
}

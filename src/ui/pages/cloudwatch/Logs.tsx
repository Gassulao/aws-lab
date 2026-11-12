import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, Crumbs, Field, Flash, Modal, PageHead, Table, nav, fmtDate } from '../../components/ui';
import { ConfirmModal, Dl, Menu, run, setNextFlash, takeFlash, q } from '../iam/kit';
import { RETENTION, matches, settleLogs } from '../../../engine/services/logs';

const root = { label: 'CloudWatch', to: '/cloudwatch/alarms' };
const when = (t: number) => new Date(t).toISOString().replace('T', ' ').replace('Z', '');

export function LogGroups() {
  const s = useCloud();
  const [flash, setFlash] = useState(takeFlash);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  settleLogs(s);
  const rows = s.logGroups.filter((g) => g.region === s.region);
  return (
    <>
      <Crumbs items={[root, { label: 'Grupos de registros' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <PageHead title="Grupos de registros" desc="Un grupo de registros reúne flujos con la misma retención y permisos." />
      <Card title="Grupos de registros" count={rows.length} flush actions={<Btn kind="primary" onClick={() => { setName(''); setErr(''); setCreating(true); }}>Crear grupo de registros</Btn>}>
        <Table rows={rows} id={(g) => g.name} filterPlaceholder="Filtrar grupos de registros" empty={{ title: 'No hay grupos de registros', desc: 'Cree un grupo o publique eventos con aws logs put-log-events.' }} cols={[
          { head: 'Grupo de registros', cell: (g) => <a onClick={() => nav('/cloudwatch/log-group/' + encodeURIComponent(g.name))}>{g.name}</a>, text: (g) => g.name },
          { head: 'Retención', cell: (g) => (g.retention ? `${g.retention} días` : 'Nunca vence') },
          { head: 'Flujos', cell: (g) => g.streams.length },
          { head: 'Filtros de métricas', cell: (g) => g.filters.length },
          { head: 'Fecha de creación', cell: (g) => fmtDate(new Date(g.created).toISOString()), text: (g) => String(g.created) },
        ]} />
      </Card>
      {creating && (
        <Modal title="Crear grupo de registros" onClose={() => setCreating(false)} footer={<><Btn onClick={() => setCreating(false)}>Cancelar</Btn><Btn kind="primary" disabled={!name} onClick={async () => { const r = await run(`aws logs create-log-group --log-group-name ${q(name)}`); if (!r.ok) return setErr(r.msg); setCreating(false); setFlash(`Se creó el grupo de registros "${name}".`); }}>Crear</Btn></>}>
          {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
          <Field label="Nombre del grupo de registros"><input className="k-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="/aplicacion/web" autoFocus /></Field>
        </Modal>
      )}
    </>
  );
}

export function LogGroupDetail({ name, stream }: { name: string; stream?: string }) {
  const s = useCloud();
  settleLogs(s);
  const g = s.logGroups.find((x) => x.name === name && x.region === s.region);
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [del, setDel] = useState(false);
  const [filter, setFilter] = useState('');
  const [ret, setRet] = useState(false);
  const [days, setDays] = useState('30');
  if (!g) return <><Crumbs items={[root, { label: 'Grupos de registros', to: '/cloudwatch/logs' }]} /><Flash kind="err" title="ResourceNotFoundException">The specified log group does not exist.</Flash></>;
  const st = stream ? g.streams.find((x) => x.name === stream) : undefined;
  let bad = '';
  let evs = (st ? st.events.map((e) => ({ ...e, stream: st.name })) : g.streams.flatMap((x) => x.events.map((e) => ({ ...e, stream: x.name })))).sort((a, b) => a.ts - b.ts);
  try { evs = evs.filter((e) => matches(filter, e.message)); } catch (e) { bad = (e as Error).message; }
  return (
    <>
      <Crumbs items={[root, { label: 'Grupos de registros', to: '/cloudwatch/logs' }, ...(st ? [{ label: g.name, to: '/cloudwatch/log-group/' + encodeURIComponent(g.name) }, { label: st.name }] : [{ label: g.name }])]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title={st ? st.name : g.name}>
        {!st && <Menu label="Acciones" items={[{ label: 'Editar la retención', onClick: () => setRet(true) }, { label: 'Eliminar grupo de registros', onClick: () => setDel(true) }]} />}
      </PageHead>
      {!st && (
        <>
          <Card title="Detalles del grupo de registros"><Dl items={[['Nombre', g.name], ['ARN', g.arn], ['Retención', g.retention ? `${g.retention} días` : 'Nunca vence'], ['Flujos', g.streams.length], ['Filtros de métricas', g.filters.map((f) => `${f.name} (${f.ns}/${f.metric})`).join(', ') || '–']]} /></Card>
          <Card title="Flujos de registros" count={g.streams.length} flush>
            <Table rows={g.streams} id={(x) => x.name} empty={{ title: 'No hay flujos de registros', desc: 'Cree uno con aws logs create-log-stream.' }} cols={[
              { head: 'Flujo de registros', cell: (x) => <a onClick={() => nav(`/cloudwatch/log-group/${encodeURIComponent(g.name)}/${encodeURIComponent(x.name)}`)}>{x.name}</a>, text: (x) => x.name },
              { head: 'Último evento', cell: (x) => (x.events.length ? when(x.events[x.events.length - 1].ts) : '–') }, { head: 'Eventos', cell: (x) => x.events.length },
            ]} />
          </Card>
        </>
      )}
      <Card title="Eventos de registro" flush>
        <div style={{ padding: 12 }}>
          <input className="k-input" aria-label="Filtrar eventos" placeholder="Filtrar eventos (ERROR, ?uno ?dos, -excluir, { $.status = 500 })" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: '100%' }} />
          {bad && <p className="k-muted" style={{ color: '#d91515' }}>{bad}</p>}
        </div>
        {evs.length === 0 ? <p className="k-muted" style={{ padding: '0 12px 12px' }}>No hay eventos que mostrar.</p> : (
          <table className="cw-ev"><tbody>{evs.slice(-200).map((e, i) => <tr key={i}><td>{when(e.ts)}</td>{!st && <td>{e.stream}</td>}<td><pre className="cw-msg">{e.message}</pre></td></tr>)}</tbody></table>
        )}
      </Card>
      {del && <ConfirmModal title="Eliminar grupo de registros" danger confirmLabel="Eliminar" onClose={() => setDel(false)} onConfirm={async () => { const r = await run(`aws logs delete-log-group --log-group-name ${q(g.name)}`); if (!r.ok) { setErr(r.msg); setDel(false); return; } setNextFlash(`Se eliminó el grupo de registros "${g.name}".`); nav('/cloudwatch/logs'); }}>Se eliminarán el grupo <b>{g.name}</b> y todos sus eventos.</ConfirmModal>}
      {ret && (
        <Modal title="Editar la retención" onClose={() => setRet(false)} footer={<><Btn onClick={() => setRet(false)}>Cancelar</Btn><Btn kind="primary" onClick={async () => { const r = await run(`aws logs put-retention-policy --log-group-name ${q(g.name)} --retention-in-days ${days}`); if (!r.ok) { setErr(r.msg); setRet(false); return; } setRet(false); setFlash('Se actualizó la retención.'); }}>Guardar</Btn></>}>
          <Field label="Retención de registros"><select className="k-select" aria-label="Retención" value={days} onChange={(e) => setDays(e.target.value)}>{RETENTION.map((d) => <option key={d} value={d}>{d} días</option>)}</select></Field>
        </Modal>
      )}
    </>
  );
}

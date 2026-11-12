import React, { useState } from 'react';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, Modal, PageHead, Table, nav } from '../../components/ui';
import { ConfirmModal, Dl, run, takeFlash, setNextFlash } from '../iam/kit';
import { useContainers, link, enc, when, St, Tabs, NotFound, networkDefaults, short } from './common';

const CR = { label: 'Amazon Elastic Container Service', to: '/ecs/clusters' };

export function EcsClusters() {
  const { s, c } = useContainers();
  const [flash, setFlash] = useState(takeFlash);
  const [modal, setModal] = useState(false);
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const rows = c.ecsClusters.filter((x) => x.region === s.region);
  const cmd = `aws ecs create-cluster --cluster-name ${name || '<nombre>'}`;
  return (
    <>
      <Crumbs items={[CR, { label: 'Clústeres' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title="Clústeres" desc="Un clúster es una agrupación lógica de servicios y tareas. Esta consola simula únicamente capacidad AWS Fargate." />
      <Card title="Clústeres" count={rows.length} flush actions={<Btn kind="primary" onClick={() => setModal(true)}>Crear clúster</Btn>}>
        <Table rows={rows} id={(x) => x.name} filterPlaceholder="Buscar clústeres" empty={{ title: 'No hay clústeres', desc: 'Cree un clúster para ejecutar servicios y tareas.' }} cols={[
          { head: 'Clúster', cell: (x) => link('/ecs/cluster/' + enc(x.name), x.name), text: (x) => x.name },
          { head: 'Servicios', cell: (x) => String(c.ecsServices.filter((v) => v.clusterName === x.name && v.region === x.region && v.status !== 'INACTIVE').length) },
          { head: 'Tareas en ejecución', cell: (x) => String(c.ecsTasks.filter((t) => t.clusterName === x.name && t.region === x.region && t.lastStatus === 'RUNNING').length) },
          { head: 'Creado el', cell: (x) => when(x.createdAt) },
        ]} />
      </Card>
      {modal && (
        <Modal title="Crear clúster" onClose={() => setModal(false)} footer={<><Btn onClick={() => setModal(false)}>Cancelar</Btn><Btn kind="primary" disabled={!/^[A-Za-z0-9_-]{1,255}$/.test(name)} onClick={async () => { const r = await run(cmd); setModal(false); if (!r.ok) setErr(r.msg); else { setFlash(`Se creó el clúster ${name}.`); setName(''); } }}>Crear</Btn></>}>
          <div className="ct-form"><Field label="Nombre del clúster"><input className="k-input" type="text" aria-label="Nombre del clúster" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field><CliEquivalent cmd={cmd} /></div>
        </Modal>
      )}
    </>
  );
}

type Tab = 'svc' | 'tasks' | 'info';
export function EcsCluster({ name }: { name: string }) {
  const { s, c } = useContainers();
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<Tab>('svc');
  const [modal, setModal] = useState<null | 'svc' | 'del'>(null);
  const [fam, setFam] = useState('');
  const [sname, setSname] = useState('');
  const [count, setCount] = useState('1');
  const [selTask, setSelTask] = useState<string[]>([]);
  const cl = c.ecsClusters.find((x) => x.name === name && x.region === s.region);
  if (!cl) return <><Crumbs items={[CR]} /><NotFound what={`El clúster ${name} no existe en la región ${s.region}.`} /></>;
  const svcs = c.ecsServices.filter((v) => v.clusterName === name && v.region === s.region && v.status !== 'INACTIVE');
  const tasks = c.ecsTasks.filter((t) => t.clusterName === name && t.region === s.region).sort((a, b) => b.createdAt - a.createdAt);
  const families = Array.from(new Set(c.taskDefs.filter((t) => t.region === s.region && t.status === 'ACTIVE').map((t) => t.family)));
  const net = networkDefaults(s);
  const family = fam || families[0] || '';
  const cmd = `aws ecs create-service --cluster ${name} --service-name ${sname || '<servicio>'} --task-definition ${family || '<familia>'} --desired-count ${count} --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[${net.subnets.slice(0, 2).join(',')}],securityGroups=[${net.sg ?? ''}],assignPublicIp=ENABLED}"`;
  const act = async (cmdx: string, ok: string) => { const r = await run(cmdx); if (!r.ok) setErr(r.msg); else { setErr(''); setFlash(ok); } };
  return (
    <>
      <Crumbs items={[CR, { label: 'Clústeres', to: '/ecs/clusters' }, { label: name }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title={name}><Btn kind="danger" onClick={() => setModal('del')}>Eliminar clúster</Btn></PageHead>
      <Card title="Resumen"><Dl items={[['ARN', cl.arn], ['Estado', <St v="ACTIVE" />], ['Servicios', String(svcs.length)], ['Tareas en ejecución', String(tasks.filter((t) => t.lastStatus === 'RUNNING').length)], ['Capacidad', 'AWS Fargate']]} /></Card>
      <Tabs cur={tab} onChange={setTab} tabs={[['svc', `Servicios (${svcs.length})`], ['tasks', `Tareas (${tasks.length})`], ['info', 'Definiciones de tarea']]} />
      {tab === 'svc' && (
        <Card title="Servicios" count={svcs.length} flush actions={<Btn kind="primary" onClick={() => setModal('svc')}>Crear servicio</Btn>}>
          <Table rows={svcs} id={(v) => v.name} empty={{ title: 'No hay servicios', desc: 'Cree un servicio para mantener un número deseado de tareas.' }} cols={[
            { head: 'Servicio', cell: (v) => link(`/ecs/cluster/${enc(name)}/service/${enc(v.name)}`, v.name), text: (v) => v.name },
            { head: 'Estado', cell: (v) => <St v={v.status} />, text: (v) => v.status },
            { head: 'Definición de tarea', cell: (v) => short(v.taskDefinition), text: (v) => v.taskDefinition },
            { head: 'Tareas (en ejecución/deseadas)', cell: (v) => `${tasks.filter((t) => t.serviceName === v.name && t.lastStatus === 'RUNNING').length}/${v.desiredCount}` },
            { head: 'Tipo de lanzamiento', cell: (v) => v.launchType },
          ]} />
        </Card>
      )}
      {tab === 'tasks' && (
        <Card title="Tareas" count={tasks.length} flush actions={<Btn kind="danger" disabled={selTask.length !== 1} onClick={() => act(`aws ecs stop-task --cluster ${name} --task ${selTask[0]}`, 'Tarea detenida.')}>Detener</Btn>}>
          <Table rows={tasks} id={(t) => t.id} selected={selTask} onSelect={(x) => setSelTask(x.slice(-1))} empty={{ title: 'No hay tareas' }} cols={[
            { head: 'ID de tarea', cell: (t) => t.id, text: (t) => t.id },
            { head: 'Último estado', cell: (t) => <St v={t.lastStatus} />, text: (t) => t.lastStatus },
            { head: 'Definición de tarea', cell: (t) => short(t.taskDefinition) },
            { head: 'Grupo', cell: (t) => t.group },
            { head: 'IP privada', cell: (t) => t.privateIp },
            { head: 'Motivo de detención', cell: (t) => t.stoppedReason ?? '-', text: (t) => t.stoppedReason ?? '' },
          ]} />
        </Card>
      )}
      {tab === 'info' && (
        <Card title="Definiciones de tarea" flush>
          <Table rows={c.taskDefs.filter((t) => t.region === s.region)} id={(t) => t.arn} empty={{ title: 'No hay definiciones de tarea', desc: 'Regístrelas con aws ecs register-task-definition.' }} cols={[
            { head: 'Familia:revisión', cell: (t) => `${t.family}:${t.revision}`, text: (t) => `${t.family}:${t.revision}` },
            { head: 'Estado', cell: (t) => <St v={t.status} />, text: (t) => t.status },
            { head: 'CPU / Memoria', cell: (t) => `${t.cpu ?? '-'} / ${t.memory ?? '-'}` },
            { head: 'Imágenes', cell: (t) => t.containerDefinitions.map((d) => d.image).join(', ') },
          ]} />
        </Card>
      )}
      {modal === 'svc' && (
        <Modal title="Crear servicio" onClose={() => setModal(null)} footer={<><Btn onClick={() => setModal(null)}>Cancelar</Btn><Btn kind="primary" disabled={!sname || !family} onClick={async () => { await act(cmd, `Se creó el servicio ${sname}.`); setModal(null); }}>Crear</Btn></>}>
          <div className="ct-form">
            <Field label="Nombre del servicio"><input className="k-input" type="text" aria-label="Nombre del servicio" value={sname} onChange={(e) => setSname(e.target.value)} autoFocus /></Field>
            <Field label="Familia de la definición de tarea" hint={families.length ? undefined : 'No hay definiciones de tarea registradas.'}><select className="k-input" aria-label="Familia" value={family} onChange={(e) => setFam(e.target.value)}>{families.map((f) => <option key={f}>{f}</option>)}</select></Field>
            <Field label="Número de tareas deseadas"><input className="k-input" type="number" min={0} aria-label="Tareas deseadas" value={count} onChange={(e) => setCount(e.target.value)} /></Field>
            <p className="ct-muted">Red: VPC {net.vpc?.id}, subredes {net.subnets.slice(0, 2).join(', ')} y el grupo de seguridad predeterminado.</p>
            <CliEquivalent cmd={cmd} />
          </div>
        </Modal>
      )}
      {modal === 'del' && <ConfirmModal title="Eliminar clúster" confirmLabel="Eliminar" danger onClose={() => setModal(null)} onConfirm={async () => { const r = await run(`aws ecs delete-cluster --cluster ${name}`); if (!r.ok) return r.msg; setNextFlash(`Se eliminó el clúster ${name}.`); nav('/ecs/clusters'); }}>El clúster debe estar vacío (sin servicios activos ni tareas).</ConfirmModal>}
    </>
  );
}

export function EcsService({ cluster, name }: { cluster: string; name: string }) {
  const { s, c } = useContainers();
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [count, setCount] = useState('');
  const [del, setDel] = useState(false);
  const v = c.ecsServices.find((x) => x.name === name && x.clusterName === cluster && x.region === s.region && x.status !== 'INACTIVE');
  if (!v) return <><Crumbs items={[CR, { label: cluster, to: '/ecs/cluster/' + enc(cluster) }]} /><NotFound what={`El servicio ${name} no existe en el clúster ${cluster}.`} /></>;
  const tasks = c.ecsTasks.filter((t) => t.serviceName === name && t.clusterName === cluster && t.region === s.region).sort((a, b) => b.createdAt - a.createdAt);
  const running = tasks.filter((t) => t.lastStatus === 'RUNNING').length;
  const act = async (cmd: string, ok: string) => { const r = await run(cmd); if (!r.ok) setErr(r.msg); else { setErr(''); setFlash(ok); } };
  return (
    <>
      <Crumbs items={[CR, { label: 'Clústeres', to: '/ecs/clusters' }, { label: cluster, to: '/ecs/cluster/' + enc(cluster) }, { label: name }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title={name}><Btn kind="danger" onClick={() => setDel(true)}>Eliminar servicio</Btn></PageHead>
      <Card title="Resumen del servicio"><Dl items={[['Estado', <St v={v.status} />], ['Tareas', `${running} en ejecución / ${v.desiredCount} deseadas`], ['Definición de tarea', short(v.taskDefinition)], ['Tipo de lanzamiento', v.launchType], ['Subredes', v.subnets.join(', ')], ['Grupos de seguridad', v.securityGroups.join(', ')], ['IP pública', v.assignPublicIp === 'ENABLED' ? 'Habilitada' : 'Deshabilitada'], ['Balanceador de carga', v.loadBalancers.length ? v.loadBalancers.map((l) => `${short(l.targetGroupArn)}:${l.containerPort}`).join(', ') : 'Ninguno']]} /></Card>
      <Card title="Actualizar número de tareas"><div className="ct-row"><input className="k-input" type="number" min={0} aria-label="Número de tareas" style={{ width: 120 }} value={count} placeholder={String(v.desiredCount)} onChange={(e) => setCount(e.target.value)} /><Btn kind="primary" disabled={count === ''} onClick={() => act(`aws ecs update-service --cluster ${cluster} --service ${name} --desired-count ${count}`, `Servicio actualizado: ${count} tareas deseadas.`)}>Actualizar</Btn><Btn onClick={() => act(`aws ecs update-service --cluster ${cluster} --service ${name} --force-new-deployment`, 'Se inició una nueva implementación.')}>Forzar nueva implementación</Btn></div></Card>
      <Card title="Implementaciones" flush>
        <Table rows={v.deployments} id={(d) => d.id} empty={{ title: 'Sin implementaciones' }} cols={[
          { head: 'ID', cell: (d) => d.id }, { head: 'Estado', cell: (d) => d.status }, { head: 'Definición de tarea', cell: (d) => short(d.taskDefinition) }, { head: 'Deseadas', cell: (d) => String(d.desiredCount) }, { head: 'Resultado', cell: (d) => <St v={d.rolloutState} /> },
        ]} />
      </Card>
      <Card title="Tareas" count={tasks.length} flush>
        <Table rows={tasks} id={(t) => t.id} empty={{ title: 'No hay tareas' }} cols={[
          { head: 'ID de tarea', cell: (t) => t.id }, { head: 'Último estado', cell: (t) => <St v={t.lastStatus} /> }, { head: 'IP privada', cell: (t) => t.privateIp }, { head: 'Motivo de detención', cell: (t) => t.stoppedReason ?? '-' },
        ]} />
      </Card>
      <Card title="Eventos">
        {v.events.length ? <ul className="ct-events">{[...v.events].sort((a, b) => b.ts - a.ts).slice(0, 25).map((e) => <li key={e.id}><span className="ct-muted">{when(e.ts)}</span><span>{e.message}</span></li>)}</ul> : <span className="ct-muted">Aún no hay eventos.</span>}
      </Card>
      {del && <ConfirmModal title="Eliminar servicio" confirmLabel="Eliminar" danger onClose={() => setDel(false)} onConfirm={async () => { const r = await run(`aws ecs delete-service --cluster ${cluster} --service ${name} --force`); if (!r.ok) return r.msg; setNextFlash(`Se eliminó el servicio ${name}.`); nav('/ecs/cluster/' + enc(cluster)); }}>Se detendrán todas las tareas del servicio.</ConfirmModal>}
    </>
  );
}

import React, { useState } from 'react';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, Modal, PageHead, Table, nav } from '../../components/ui';
import { ConfirmModal, Dl, run, takeFlash, setNextFlash } from '../iam/kit';
import { useContainers, link, enc, when, St, Tabs, NotFound, networkDefaults } from './common';
import { EKS_VERSIONS, nodeInstances } from '../../../engine/services/eks';

const CR = { label: 'Amazon Elastic Kubernetes Service', to: '/eks/clusters' };
const roleFor = (s: ReturnType<typeof useContainers>['s'], svc: string) => s.roles.filter((r) => JSON.stringify(r.assumeRolePolicy).includes(svc));

export function EksClusters() {
  const { s, c } = useContainers();
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [modal, setModal] = useState(false);
  const [name, setName] = useState('');
  const [ver, setVer] = useState('1.31');
  const [role, setRole] = useState('');
  const roles = roleFor(s, 'eks.amazonaws.com');
  const net = networkDefaults(s);
  const arn = role || roles[0]?.arn || '<rol-del-clúster>';
  const cmd = `aws eks create-cluster --name ${name || '<nombre>'} --kubernetes-version ${ver} --role-arn ${arn} --resources-vpc-config subnetIds=${net.subnets.slice(0, 2).join(',')}`;
  const rows = c.eks.filter((x) => x.region === s.region);
  return (
    <>
      <Crumbs items={[CR, { label: 'Clústeres' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title="Clústeres" desc="Ejecute Kubernetes administrado. Al crear un clúster tarda unos minutos en pasar de CREATING a ACTIVE." />
      <Card title="Clústeres" count={rows.length} flush actions={<Btn kind="primary" onClick={() => setModal(true)}>Crear clúster</Btn>}>
        <Table rows={rows} id={(x) => x.name} filterPlaceholder="Buscar clústeres" empty={{ title: 'No hay clústeres', desc: 'Cree un clúster de EKS para ejecutar aplicaciones de Kubernetes.' }} cols={[
          { head: 'Nombre del clúster', cell: (x) => link('/eks/cluster/' + enc(x.name), x.name), text: (x) => x.name },
          { head: 'Estado', cell: (x) => <St v={x.status} />, text: (x) => x.status },
          { head: 'Versión de Kubernetes', cell: (x) => x.version },
          { head: 'Grupos de nodos', cell: (x) => String(x.nodegroups.length) },
          { head: 'Creado el', cell: (x) => when(x.createdAt) },
        ]} />
      </Card>
      {modal && (
        <Modal title="Crear clúster de EKS" onClose={() => setModal(false)} footer={<><Btn onClick={() => setModal(false)}>Cancelar</Btn><Btn kind="primary" disabled={!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) || !roles.length} onClick={async () => { const r = await run(cmd); setModal(false); if (!r.ok) setErr(r.msg); else { setNextFlash(`Se está creando el clúster ${name}.`); nav('/eks/cluster/' + enc(name)); } }}>Crear</Btn></>}>
          <div className="ct-form">
            <Field label="Nombre"><input className="k-input" type="text" aria-label="Nombre del clúster" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
            <Field label="Versión de Kubernetes"><select className="k-input" aria-label="Versión" value={ver} onChange={(e) => setVer(e.target.value)}>{EKS_VERSIONS.map((v) => <option key={v}>{v}</option>)}</select></Field>
            <Field label="Rol de servicio del clúster" hint={roles.length ? undefined : 'No hay roles que confíen en eks.amazonaws.com. Cree uno en IAM con la política AmazonEKSClusterPolicy.'}><select className="k-input" aria-label="Rol del clúster" value={arn} onChange={(e) => setRole(e.target.value)}>{roles.map((r) => <option key={r.arn} value={r.arn}>{r.name}</option>)}</select></Field>
            <p className="ct-muted">Red: VPC {net.vpc?.id}, subredes {net.subnets.slice(0, 2).join(', ')}.</p>
            <CliEquivalent cmd={cmd} />
          </div>
        </Modal>
      )}
    </>
  );
}

type Tab = 'ng' | 'nodes' | 'addons' | 'access';
export function EksCluster({ name }: { name: string }) {
  const { s, c } = useContainers();
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<Tab>('ng');
  const [modal, setModal] = useState<null | 'ng' | 'del'>(null);
  const [ngName, setNgName] = useState('');
  const [role, setRole] = useState('');
  const [itype, setItype] = useState('t3.medium');
  const [size, setSize] = useState('2');
  const [selNg, setSelNg] = useState<string[]>([]);
  const cl = c.eks.find((x) => x.name === name && x.region === s.region);
  if (!cl) return <><Crumbs items={[CR]} /><NotFound what={`No se encontró el clúster ${name} en la región ${s.region}.`} /></>;
  const roles = roleFor(s, 'ec2.amazonaws.com');
  const arn = role || roles[0]?.arn || '<rol-de-nodo>';
  const n = Math.max(0, Number(size) || 0);
  const cmd = `aws eks create-nodegroup --cluster-name ${name} --nodegroup-name ${ngName || '<grupo>'} --node-role ${arn} --subnets ${cl.subnetIds.join(' ')} --scaling-config minSize=${Math.min(1, n)},maxSize=${Math.max(n, 1)},desiredSize=${n} --instance-types ${itype}`;
  const act = async (x: string, ok: string) => { const r = await run(x); if (!r.ok) setErr(r.msg); else { setErr(''); setFlash(ok); } };
  const nodes = cl.nodegroups.flatMap((g) => nodeInstances(s, cl, g).map((i) => ({ i, g })));
  const ng = cl.nodegroups.find((g) => g.name === selNg[0]);
  return (
    <>
      <Crumbs items={[CR, { label: 'Clústeres', to: '/eks/clusters' }, { label: name }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      {cl.status === 'CREATING' && <Flash kind="info" title="Clúster en creación">El plano de control se está aprovisionando. Los grupos de nodos se pueden crear cuando el estado sea Activo.</Flash>}
      <PageHead title={name}><Btn onClick={() => act(`aws eks update-kubeconfig --name ${name}`, 'Se actualizó ~/.kube/config. Pruebe kubectl get nodes en CloudShell.')}>Actualizar kubeconfig</Btn><Btn kind="danger" onClick={() => setModal('del')}>Eliminar clúster</Btn></PageHead>
      <Card title="Información del clúster"><Dl items={[['Estado', <St v={cl.status} />], ['Versión de Kubernetes', cl.version], ['Punto de enlace del servidor de API', cl.endpoint], ['ARN', cl.arn], ['Rol de IAM del clúster', cl.roleArn], ['VPC', cl.vpcId], ['Subredes', cl.subnetIds.join(', ')], ['Grupo de seguridad del clúster', cl.clusterSecurityGroupId], ['Acceso público al punto de enlace', cl.endpointPublicAccess ? 'Habilitado' : 'Deshabilitado'], ['Proveedor OIDC', cl.oidcIssuer], ['Versión de plataforma', cl.platformVersion]]} /></Card>
      <Tabs cur={tab} onChange={setTab} tabs={[['ng', `Grupos de nodos (${cl.nodegroups.length})`], ['nodes', `Nodos (${nodes.length})`], ['addons', `Complementos (${cl.addons.length})`], ['access', `Acceso (${cl.accessEntries.length})`]]} />
      {tab === 'ng' && (
        <Card title="Grupos de nodos administrados" count={cl.nodegroups.length} flush actions={<div className="ct-row"><Btn kind="danger" disabled={!ng} onClick={() => ng && act(`aws eks delete-nodegroup --cluster-name ${name} --nodegroup-name ${ng.name}`, 'Se está eliminando el grupo de nodos.')}>Eliminar</Btn><Btn kind="primary" disabled={cl.status !== 'ACTIVE'} onClick={() => setModal('ng')}>Agregar grupo de nodos</Btn></div>}>
          <Table rows={cl.nodegroups} id={(g) => g.name} selected={selNg} onSelect={(x) => setSelNg(x.slice(-1))} empty={{ title: 'No hay grupos de nodos', desc: 'Sin nodos, los pods quedan en Pending.' }} cols={[
            { head: 'Nombre del grupo', cell: (g) => g.name, text: (g) => g.name },
            { head: 'Estado', cell: (g) => <><St v={g.status} />{g.health && <div className="ct-muted">{g.health.message}</div>}</>, text: (g) => g.status },
            { head: 'Tamaño deseado', cell: (g) => `${g.scaling.desiredSize} (mín. ${g.scaling.minSize} / máx. ${g.scaling.maxSize})` },
            { head: 'Tipos de instancia', cell: (g) => g.instanceTypes.join(', ') },
            { head: 'AMI', cell: (g) => g.amiType },
          ]} />
        </Card>
      )}
      {tab === 'nodes' && (
        <Card title="Nodos" count={nodes.length} flush>
          <Table rows={nodes} id={({ i }) => i.id} empty={{ title: 'No hay nodos', desc: 'Los nodos son instancias EC2 del grupo de nodos.' }} cols={[
            { head: 'Instancia', cell: ({ i }) => link('/ec2/instance/' + i.id, i.id), text: ({ i }) => i.id },
            { head: 'Grupo de nodos', cell: ({ g }) => g.name },
            { head: 'Estado', cell: ({ i }) => i.state },
            { head: 'IP privada', cell: ({ i }) => i.privateIp },
            { head: 'Tipo', cell: ({ i }) => i.type },
          ]} />
        </Card>
      )}
      {tab === 'addons' && (
        <Card title="Complementos" count={cl.addons.length} flush>
          <Table rows={cl.addons} id={(a) => a.name} empty={{ title: 'No hay complementos', desc: 'Instale vpc-cni, coredns o kube-proxy con aws eks create-addon.' }} cols={[
            { head: 'Nombre', cell: (a) => a.name }, { head: 'Versión', cell: (a) => a.version }, { head: 'Estado', cell: (a) => <St v={a.status} /> },
          ]} />
        </Card>
      )}
      {tab === 'access' && (
        <Card title="Entradas de acceso de IAM" count={cl.accessEntries.length} flush>
          <Table rows={cl.accessEntries} id={(a) => a.principalArn} empty={{ title: 'Sin entradas de acceso', desc: 'El creador del clúster tiene acceso de administrador.' }} cols={[
            { head: 'ARN de la entidad principal', cell: (a) => a.principalArn }, { head: 'Políticas', cell: (a) => a.policies.map((p) => p.split('/').pop()).join(', ') || '-' },
          ]} />
          <p className="ct-muted" style={{ padding: '8px 12px' }}>Creador del clúster (administrador implícito): {cl.creatorArn}</p>
        </Card>
      )}
      {modal === 'ng' && (
        <Modal title="Agregar grupo de nodos" onClose={() => setModal(null)} footer={<><Btn onClick={() => setModal(null)}>Cancelar</Btn><Btn kind="primary" disabled={!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(ngName) || !roles.length} onClick={async () => { await act(cmd, `Se está creando el grupo de nodos ${ngName}.`); setModal(null); }}>Crear</Btn></>}>
          <div className="ct-form">
            <Field label="Nombre"><input className="k-input" type="text" aria-label="Nombre del grupo de nodos" value={ngName} onChange={(e) => setNgName(e.target.value)} autoFocus /></Field>
            <Field label="Rol de IAM del nodo" hint={roles.length ? 'Necesita AmazonEKSWorkerNodePolicy, AmazonEKS_CNI_Policy y AmazonEC2ContainerRegistryReadOnly.' : 'No hay roles que confíen en ec2.amazonaws.com.'}><select className="k-input" aria-label="Rol del nodo" value={arn} onChange={(e) => setRole(e.target.value)}>{roles.map((r) => <option key={r.arn} value={r.arn}>{r.name}</option>)}</select></Field>
            <Field label="Tipo de instancia"><select className="k-input" aria-label="Tipo de instancia" value={itype} onChange={(e) => setItype(e.target.value)}>{['t3.small', 't3.medium', 't3.large', 'm5.large'].map((t) => <option key={t}>{t}</option>)}</select></Field>
            <Field label="Tamaño deseado"><input className="k-input" type="number" min={0} aria-label="Tamaño deseado" value={size} onChange={(e) => setSize(e.target.value)} /></Field>
            <CliEquivalent cmd={cmd} />
          </div>
        </Modal>
      )}
      {modal === 'del' && <ConfirmModal title="Eliminar clúster" confirmLabel="Eliminar" danger requireText={name} onClose={() => setModal(null)} onConfirm={async () => { const r = await run(`aws eks delete-cluster --name ${name}`); if (!r.ok) return r.msg; setNextFlash(`Se está eliminando el clúster ${name}.`); nav('/eks/clusters'); }}>Antes de eliminar un clúster hay que borrar sus grupos de nodos.</ConfirmModal>}
    </>
  );
}

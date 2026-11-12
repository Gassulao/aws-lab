import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, Crumbs, Field, Flash, PageHead, Table } from '../../components/ui';
import type { SecurityGroup, SgRule } from '../../../engine/types';
import { nav, ActionsMenu, ConfirmModal, FilterBanner, FlashBar, KV, Link, Tabs, cmdOf, inRegion, modalRun, nameError, nm, rg, sel1, tagSpec, useVpcFilter } from './common';
import { TagModal } from './Vpcs';

const protoName = (p: string) => (p === '-1' ? 'Todo el tráfico' : p === 'tcp' ? 'TCP' : p === 'udp' ? 'UDP' : p === 'icmp' ? 'ICMP' : p);
const portRange = (r: SgRule) => (r.protocol === '-1' ? 'Todo' : r.from === r.to ? String(r.from) : `${r.from} - ${r.to}`);
const permOf = (r: SgRule) => `IpProtocol=${r.protocol}${r.protocol === '-1' ? '' : `,FromPort=${r.from},ToPort=${r.to}`}${r.cidr ? `,IpRanges=[{CidrIp=${r.cidr}}]` : r.sourceSg ? `,UserIdGroupPairs=[{GroupId=${r.sourceSg}}]` : ''}`;

export function SgList({ path }: { path: string }) {
  const s = useCloud();
  const [vpc, clear] = useVpcFilter(path);
  const rows = inRegion(s.securityGroups, s.region).filter((x) => !vpc || x.vpcId === vpc);
  const [sel, setSel] = useState<string[]>([]);
  const [modal, setModal] = useState<null | 'create' | 'del'>(null);
  const cur = rows.find((x) => x.id === sel[0]);
  const R = rg(s.region);
  return (
    <>
      <Crumbs items={[{ label: 'VPC', to: '/vpc' }, { label: 'Grupos de seguridad' }]} />
      <FlashBar />
      <Card
        title="Grupos de seguridad"
        count={rows.length}
        flush
        actions={
          <>
            <Btn disabled={!cur} onClick={() => cur && nav('/vpc/sg/' + cur.id)}>Ver detalles</Btn>
            <ActionsMenu items={[{ label: 'Ver detalles', disabled: !cur, onClick: () => cur && nav('/vpc/sg/' + cur.id) }, { label: 'Administrar en EC2', onClick: () => nav('/ec2/sg') }, 'sep', { label: 'Eliminar grupos de seguridad', disabled: !cur, onClick: () => setModal('del') }]} />
            <Btn kind="primary" onClick={() => setModal('create')}>Crear grupo de seguridad</Btn>
          </>
        }
      >
        <FilterBanner vpc={vpc} clear={clear} />
        <Table
          rows={rows}
          id={(x) => x.id}
          selected={sel}
          onSelect={sel1(setSel)}
          empty={{ title: 'No hay grupos de seguridad' }}
          filterPlaceholder="Buscar grupos de seguridad por atributo o etiqueta"
          cols={[
            { head: 'Nombre', cell: (x) => nm(x.tags) },
            { head: 'ID del grupo de seguridad', cell: (x) => <Link to={'/vpc/sg/' + x.id}>{x.id}</Link>, text: (x) => x.id },
            { head: 'Nombre del grupo de seguridad', cell: (x) => x.name },
            { head: 'ID de la VPC', cell: (x) => <Link to={'/vpc/vpcs/' + x.vpcId}>{x.vpcId}</Link>, text: (x) => x.vpcId },
            { head: 'Descripción', cell: (x) => x.description },
            { head: 'Reglas de entrada', cell: (x) => `${x.ingress.length} entrada${x.ingress.length === 1 ? '' : 's'}` },
            { head: 'Reglas de salida', cell: (x) => `${x.egress.length} entrada${x.egress.length === 1 ? '' : 's'}` },
            { head: 'Instancias', cell: (x) => s.instances.filter((i) => i.securityGroupIds.includes(x.id) && i.state !== 'terminated').length },
          ]}
        />
      </Card>
      {modal === 'create' && <CreateSg onClose={() => setModal(null)} />}
      {modal === 'del' && cur && (
        <ConfirmModal title="Eliminar grupo de seguridad" cmd={`aws ec2 delete-security-group --group-id ${cur.id} ${R}`} onClose={() => setModal(null)} onConfirm={modalRun(`aws ec2 delete-security-group --group-id ${cur.id} ${R}`, `Se eliminó el grupo de seguridad ${cur.id}.`, () => setSel([]))}>
          <p>¿Eliminar el grupo de seguridad <b>{cur.id}</b> ({cur.name})?</p>
        </ConfirmModal>
      )}
    </>
  );
}

function CreateSg({ onClose }: { onClose: () => void }) {
  const s = useCloud();
  const vpcs = inRegion(s.vpcs, s.region);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [vpcId, setVpcId] = useState(vpcs.find((v) => v.isDefault)?.id ?? vpcs[0]?.id ?? '');
  const cmd = cmdOf('aws ec2 create-security-group --group-name', name || '<nombre>', '--description', `'${desc || '<descripción>'}'`, '--vpc-id', vpcId || '<vpc-id>', rg(s.region));
  const bad = nameError(name) || nameError(desc) || (!name.trim() ? 'El nombre es obligatorio.' : !desc.trim() ? 'La descripción es obligatoria.' : '');
  return (
    <ConfirmModal title="Crear grupo de seguridad" label="Crear grupo de seguridad" danger={false} cmd={cmd} onClose={onClose} onConfirm={async () => (bad ? bad : modalRun(cmd, `Se creó correctamente el grupo de seguridad «${name}».`)())}>
      <Field label="Nombre del grupo de seguridad"><input type="text" aria-label="Nombre del grupo de seguridad" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Descripción"><input type="text" aria-label="Descripción" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
      <Field label="VPC"><select aria-label="VPC" value={vpcId} onChange={(e) => setVpcId(e.target.value)}>{vpcs.map((v) => <option key={v.id} value={v.id}>{v.id} {nm(v.tags) !== '-' ? `(${nm(v.tags)})` : ''}</option>)}</select></Field>
    </ConfirmModal>
  );
}

function RulesTable({ sg, egress }: { sg: SecurityGroup; egress: boolean }) {
  const s = useCloud();
  const [add, setAdd] = useState(false);
  const [del, setDel] = useState<SgRule | null>(null);
  const rules = egress ? sg.egress : sg.ingress;
  const verb = egress ? 'egress' : 'ingress';
  const R = rg(s.region);
  const delCmd = del ? `aws ec2 revoke-security-group-${verb} --group-id ${sg.id} --ip-permissions '${permOf(del)}' ${R}` : '';
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}><b>Reglas de {egress ? 'salida' : 'entrada'} ({rules.length})</b><Btn kind="primary" onClick={() => setAdd(true)}>Agregar regla</Btn></div>
      <Table
        rows={rules}
        id={(r) => r.id}
        empty={{ title: `Sin reglas de ${egress ? 'salida' : 'entrada'}`, desc: egress ? 'Sin reglas, no se permite tráfico saliente.' : 'Sin reglas, se deniega todo el tráfico entrante.' }}
        cols={[
          { head: 'ID de la regla', cell: (r) => r.id },
          { head: 'Tipo de IP', cell: () => 'IPv4' },
          { head: 'Protocolo', cell: (r) => protoName(r.protocol) },
          { head: 'Intervalo de puertos', cell: portRange },
          { head: egress ? 'Destino' : 'Origen', cell: (r) => r.cidr ?? (r.sourceSg ? <Link to={'/vpc/sg/' + r.sourceSg}>{r.sourceSg}</Link> : '-'), text: (r) => r.cidr ?? r.sourceSg ?? '' },
          { head: 'Descripción', cell: (r) => r.description ?? '-' },
          { head: 'Acciones', cell: (r) => <Btn small kind="danger" onClick={() => setDel(r)}>Eliminar</Btn> },
        ]}
      />
      {add && <AddRule sg={sg} egress={egress} onClose={() => setAdd(false)} />}
      {del && (
        <ConfirmModal title="Eliminar regla" cmd={delCmd} onClose={() => setDel(null)} onConfirm={modalRun(delCmd, `Se eliminó la regla ${del.id}.`)}>
          <p>¿Eliminar la regla <b>{protoName(del.protocol)} {portRange(del)}</b> de {egress ? 'salida' : 'entrada'}?</p>
        </ConfirmModal>
      )}
    </>
  );
}

function AddRule({ sg, egress, onClose }: { sg: SecurityGroup; egress: boolean; onClose: () => void }) {
  const s = useCloud();
  const [proto, setProto] = useState('tcp');
  const [from, setFrom] = useState('22');
  const [to, setTo] = useState('22');
  const [cidr, setCidr] = useState('0.0.0.0/0');
  const perm = proto === '-1' ? 'IpProtocol=-1' : `IpProtocol=${proto},FromPort=${from},ToPort=${to}`;
  const cmd = `aws ec2 authorize-security-group-${egress ? 'egress' : 'ingress'} --group-id ${sg.id} --ip-permissions '${perm},IpRanges=[{CidrIp=${cidr}}]' ${rg(s.region)}`;
  const bad = proto !== '-1' && (!/^\d+$/.test(from) || !/^\d+$/.test(to)) ? 'Los puertos deben ser números.' : !/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(cidr) ? 'Introduzca un CIDR IPv4 válido.' : '';
  return (
    <ConfirmModal title={`Agregar regla de ${egress ? 'salida' : 'entrada'}`} label="Guardar regla" danger={false} cmd={cmd} onClose={onClose} onConfirm={async () => (bad ? bad : modalRun(cmd, 'Se agregó la regla correctamente.')())}>
      <Field label="Tipo / protocolo">
        <select aria-label="Protocolo" value={proto} onChange={(e) => { setProto(e.target.value); if (e.target.value === 'icmp') { setFrom('-1'); setTo('-1'); } }}>
          <option value="tcp">TCP personalizado</option><option value="udp">UDP personalizado</option><option value="icmp">ICMP</option><option value="-1">Todo el tráfico</option>
        </select>
      </Field>
      {proto !== '-1' && (
        <div className="vp-form"><div className="row">
          <Field label="Puerto desde"><input type="text" aria-label="Puerto desde" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Puerto hasta"><input type="text" aria-label="Puerto hasta" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div></div>
      )}
      <Field label={egress ? 'Destino (CIDR IPv4)' : 'Origen (CIDR IPv4)'} error={bad || undefined}><input type="text" aria-label="CIDR" value={cidr} onChange={(e) => setCidr(e.target.value)} /></Field>
    </ConfirmModal>
  );
}

export function SgDetail({ id }: { id: string }) {
  const s = useCloud();
  const sg = s.securityGroups.find((x) => x.id === id);
  const [tab, setTab] = useState('Reglas de entrada');
  const [modal, setModal] = useState<null | 'del' | 'tag'>(null);
  if (!sg) return (
    <>
      <Crumbs items={[{ label: 'VPC', to: '/vpc' }, { label: 'Grupos de seguridad', to: '/vpc/sg' }, { label: id }]} />
      <Flash kind="err" title="Grupo de seguridad no encontrado">El grupo {id} no existe en la región {s.region}. <Link to="/vpc/sg">Volver</Link></Flash>
    </>
  );
  const insts = s.instances.filter((i) => i.securityGroupIds.includes(sg.id) && i.state !== 'terminated');
  const cmd = `aws ec2 delete-security-group --group-id ${sg.id} ${rg(s.region)}`;
  return (
    <>
      <Crumbs items={[{ label: 'VPC', to: '/vpc' }, { label: 'Grupos de seguridad', to: '/vpc/sg' }, { label: sg.id }]} />
      <FlashBar />
      <PageHead title={<>{sg.id}<span style={{ fontWeight: 400, color: 'var(--muted)' }}> / {sg.name}</span></>}>
        <ActionsMenu items={[{ label: 'Administrar etiquetas', onClick: () => setModal('tag') }, { label: 'Ver en EC2', onClick: () => nav('/ec2/sg') }, 'sep', { label: 'Eliminar grupo de seguridad', onClick: () => setModal('del') }]} />
      </PageHead>
      <Card flush>
        <div style={{ padding: 20, borderBottom: '1px solid var(--line)' }}>
          <KV items={[['Nombre del grupo de seguridad', sg.name], ['ID del grupo de seguridad', sg.id], ['Descripción', sg.description], ['ID de la VPC', <Link to={'/vpc/vpcs/' + sg.vpcId}>{sg.vpcId}</Link>], ['Reglas de entrada', sg.ingress.length], ['Reglas de salida', sg.egress.length]]} />
        </div>
        <Tabs tabs={['Reglas de entrada', 'Reglas de salida', 'Instancias', 'Etiquetas']} value={tab} onChange={setTab} />
        <div style={{ padding: 20 }}>
          {tab === 'Reglas de entrada' && <RulesTable sg={sg} egress={false} />}
          {tab === 'Reglas de salida' && <RulesTable sg={sg} egress />}
          {tab === 'Instancias' && <Table rows={insts} id={(i) => i.id} empty={{ title: 'Sin instancias', desc: 'Ninguna instancia usa este grupo de seguridad.' }} cols={[{ head: 'ID de instancia', cell: (i) => <Link to={'/ec2/instance/' + i.id}>{i.id}</Link> }, { head: 'Nombre', cell: (i) => nm(i.tags) }, { head: 'Estado', cell: (i) => i.state }, { head: 'Subred', cell: (i) => i.subnetId }]} />}
          {tab === 'Etiquetas' && <Table rows={Object.entries(sg.tags)} id={([k]) => k} empty={{ title: 'Sin etiquetas' }} cols={[{ head: 'Clave', cell: ([k]) => k }, { head: 'Valor', cell: ([, v]) => v }]} />}
        </div>
      </Card>
      {modal === 'del' && <ConfirmModal title="Eliminar grupo de seguridad" cmd={cmd} onClose={() => setModal(null)} onConfirm={modalRun(cmd, `Se eliminó el grupo de seguridad ${sg.id}.`, () => nav('/vpc/sg'))}><p>¿Eliminar <b>{sg.id}</b> ({sg.name})?</p></ConfirmModal>}
      {modal === 'tag' && <TagModal resource={sg.id} onClose={() => setModal(null)} />}
    </>
  );
}
void tagSpec;

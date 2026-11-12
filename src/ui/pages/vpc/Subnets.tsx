import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, PageHead, Status, Table } from '../../components/ui';
import { azsOf } from '../../../engine/catalog';
import { isPublicSubnet, routeTableOfSubnet, parseCidr } from '../../../engine/services/ec2';
import type { Subnet } from '../../../engine/types';
import { consoleRun } from '../../session';
import { nav, ActionsMenu, ConfirmModal, FilterBanner, FlashBar, KV, Link, Tabs, cmdOf, errParts, inRegion, modalRun, nameError, nm, notify, rg, sel1, tagSpec, useVpcFilter } from './common';
import { RouteTableTable } from './Routes';
import { TagModal } from './Vpcs';

const freeIps = (cidr: string) => (parseCidr(cidr) ? 2 ** (32 - parseCidr(cidr)!.bits) - 5 : 0);
export const SubnetType = ({ sn }: { sn: Subnet }) => {
  const s = useCloud();
  return isPublicSubnet(s, sn) ? <span className="vp-pill pub">Pública</span> : <span className="vp-pill priv">Privada</span>;
};

export function SubnetList({ path }: { path: string }) {
  const s = useCloud();
  const [vpc, clear] = useVpcFilter(path);
  const rows = inRegion(s.subnets, s.region).filter((x) => !vpc || x.vpcId === vpc);
  const [sel, setSel] = useState<string[]>([]);
  const [modal, setModal] = useState<null | 'del' | 'auto'>(null);
  const cur = rows.find((x) => x.id === sel[0]);
  return (
    <>
      <Crumbs items={[{ label: 'VPC', to: '/vpc' }, { label: 'Subredes' }]} />
      <FlashBar />
      <Card
        title="Subredes"
        count={rows.length}
        flush
        actions={
          <>
            <Btn disabled={!cur} onClick={() => cur && nav('/vpc/subnets/' + cur.id)}>Ver detalles</Btn>
            <ActionsMenu items={[
              { label: 'Ver detalles', disabled: !cur, onClick: () => cur && nav('/vpc/subnets/' + cur.id) },
              { label: 'Editar configuración de subred', disabled: !cur, onClick: () => setModal('auto') },
              'sep',
              { label: 'Eliminar subred', disabled: !cur, onClick: () => setModal('del') },
            ]} />
            <Btn kind="primary" onClick={() => nav('/vpc/subnets/create')}>Crear subred</Btn>
          </>
        }
      >
        <FilterBanner vpc={vpc} clear={clear} />
        <Table
          rows={rows}
          id={(x) => x.id}
          selected={sel}
          onSelect={sel1(setSel)}
          empty={{ title: 'No hay subredes', desc: 'Cree una subred en una de sus VPC.' }}
          filterPlaceholder="Buscar subredes por atributo o etiqueta"
          cols={[
            { head: 'Nombre', cell: (x) => (nm(x.tags) === '-' ? '-' : <Link to={'/vpc/subnets/' + x.id}>{nm(x.tags)}</Link>), text: (x) => nm(x.tags) },
            { head: 'ID de subred', cell: (x) => <Link to={'/vpc/subnets/' + x.id}>{x.id}</Link>, text: (x) => x.id },
            { head: 'Estado', cell: () => <Status tone="ok">Available</Status>, text: () => 'available' },
            { head: 'VPC', cell: (x) => <Link to={'/vpc/vpcs/' + x.vpcId}>{x.vpcId}</Link>, text: (x) => x.vpcId },
            { head: 'Bloque de CIDR IPv4', cell: (x) => x.cidr },
            { head: 'Direcciones IPv4 disponibles', cell: (x) => freeIps(x.cidr) },
            { head: 'Zona de disponibilidad', cell: (x) => x.az },
            { head: 'Tabla de enrutamiento', cell: (x) => { const r = routeTableOfSubnet(s, x); return <Link to={'/vpc/routes/' + r.id}>{r.id}</Link>; }, text: (x) => routeTableOfSubnet(s, x).id },
            { head: 'Asignar IPv4 pública automáticamente', cell: (x) => (x.mapPublicIpOnLaunch ? 'Sí' : 'No') },
            { head: 'Tipo', cell: (x) => <SubnetType sn={x} />, text: (x) => (isPublicSubnet(s, x) ? 'Pública' : 'Privada') },
          ]}
        />
      </Card>
      {modal === 'del' && cur && <DeleteSubnet sn={cur} onClose={() => setModal(null)} then={() => setSel([])} />}
      {modal === 'auto' && cur && <AutoIpModal sn={cur} onClose={() => setModal(null)} />}
    </>
  );
}

function DeleteSubnet({ sn, onClose, then }: { sn: Subnet; onClose: () => void; then?: () => void }) {
  const s = useCloud();
  const cmd = `aws ec2 delete-subnet --subnet-id ${sn.id} ${rg(s.region)}`;
  return (
    <ConfirmModal title="Eliminar subred" cmd={cmd} onClose={onClose} onConfirm={modalRun(cmd, `Se eliminó correctamente la subred ${sn.id}.`, then)}>
      <p>¿Seguro que desea eliminar la subred <b>{sn.id}</b> {nm(sn.tags) !== '-' && `(${nm(sn.tags)})`}?</p>
    </ConfirmModal>
  );
}

function AutoIpModal({ sn, onClose }: { sn: Subnet; onClose: () => void }) {
  const s = useCloud();
  const [on, setOn] = useState(sn.mapPublicIpOnLaunch);
  const cmd = `aws ec2 modify-subnet-attribute --subnet-id ${sn.id} --${on ? '' : 'no-'}map-public-ip-on-launch ${rg(s.region)}`;
  return (
    <ConfirmModal title="Editar configuración de subred" label="Guardar" danger={false} cmd={cmd} onClose={onClose} onConfirm={modalRun(cmd, 'La configuración de la subred se actualizó correctamente.')}>
      <label className="vp-check"><input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> Habilitar la asignación automática de direcciones IPv4 públicas</label>
    </ConfirmModal>
  );
}

export function SubnetCreate({ path }: { path: string }) {
  const s = useCloud();
  const [vpc0] = useVpcFilter(path);
  const vpcs = inRegion(s.vpcs, s.region);
  const [vpcId, setVpcId] = useState(vpc0 ?? vpcs.find((v) => !v.isDefault)?.id ?? vpcs[0]?.id ?? '');
  const v = vpcs.find((x) => x.id === vpcId);
  const [name, setName] = useState('');
  const [az, setAz] = useState(azsOf(s.region)[0]);
  const [cidr, setCidr] = useState('');
  const [err, setErr] = useState('');
  const cmd = cmdOf('aws ec2 create-subnet --vpc-id', vpcId || '<vpc-id>', '--cidr-block', cidr || '<cidr>', '--availability-zone', az, tagSpec('subnet', name), rg(s.region));
  const create = async () => {
    const bad = nameError(name);
    if (!vpcId) return setErr('Seleccione una VPC.');
    if (bad) return setErr(bad);
    const r = await consoleRun(cmd);
    if (!r.ok) {
      const e = errParts(r.err);
      return setErr((e.code ? e.code + ': ' : '') + e.msg);
    }
    notify({ kind: 'ok', text: `Se creó correctamente la subred ${r.json.Subnet.SubnetId}.` });
    nav('/vpc/subnets');
  };
  return (
    <>
      <Crumbs items={[{ label: 'VPC', to: '/vpc' }, { label: 'Subredes', to: '/vpc/subnets' }, { label: 'Crear subred' }]} />
      <PageHead title="Crear subred" desc="Una subred es un rango de direcciones IP dentro de la VPC y de una zona de disponibilidad." />
      {err && <Flash kind="err" title="Error al crear la subred" onClose={() => setErr('')}>{err}</Flash>}
      <div className="wizard">
        <Card title="Configuración de la subred">
          <div className="vp-form">
            <Field label="ID de VPC" hint="Cree subredes en esta VPC.">
              <select aria-label="ID de VPC" value={vpcId} onChange={(e) => setVpcId(e.target.value)}>
                <option value="">Seleccione una VPC</option>
                {vpcs.map((x) => <option key={x.id} value={x.id}>{x.id}{nm(x.tags) !== '-' ? ` (${nm(x.tags)})` : ''} — {x.cidr}</option>)}
              </select>
            </Field>
            {v && <div className="hint" style={{ marginTop: -10, marginBottom: 14 }}>CIDR de la VPC: {v.cidr}</div>}
            <Field label="Nombre de la subred"><input type="text" aria-label="Nombre de la subred" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Zona de disponibilidad">
              <select aria-label="Zona de disponibilidad" value={az} onChange={(e) => setAz(e.target.value)}>{azsOf(s.region).map((a) => <option key={a}>{a}</option>)}</select>
            </Field>
            <Field label="Bloque de CIDR IPv4" hint="Debe estar dentro del CIDR de la VPC y no solaparse con otras subredes.">
              <input type="text" aria-label="Bloque de CIDR IPv4" value={cidr} placeholder="10.0.1.0/24" onChange={(e) => setCidr(e.target.value)} />
            </Field>
          </div>
        </Card>
        <div className="summary">
          <Card title="Resumen">
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn onClick={() => nav('/vpc/subnets')}>Cancelar</Btn>
              <Btn kind="primary" onClick={create}>Crear subred</Btn>
            </div>
            <CliEquivalent cmd={cmd} />
          </Card>
        </div>
      </div>
    </>
  );
}

export function SubnetDetail({ id }: { id: string }) {
  const s = useCloud();
  const sn = s.subnets.find((x) => x.id === id);
  const [tab, setTab] = useState('Detalles');
  const [modal, setModal] = useState<null | 'del' | 'auto' | 'tag'>(null);
  if (!sn) return (
    <>
      <Crumbs items={[{ label: 'VPC', to: '/vpc' }, { label: 'Subredes', to: '/vpc/subnets' }, { label: id }]} />
      <Flash kind="err" title="Subred no encontrada">La subred {id} no existe en la región {s.region}. <Link to="/vpc/subnets">Volver a Subredes</Link></Flash>
    </>
  );
  const rt = routeTableOfSubnet(s, sn);
  const insts = s.instances.filter((i) => i.subnetId === sn.id && i.state !== 'terminated');
  return (
    <>
      <Crumbs items={[{ label: 'VPC', to: '/vpc' }, { label: 'Subredes', to: '/vpc/subnets' }, { label: sn.id }]} />
      <FlashBar />
      <PageHead title={<>{sn.id}{nm(sn.tags) !== '-' && <span style={{ fontWeight: 400, color: 'var(--muted)' }}> / {nm(sn.tags)}</span>}</>}>
        <ActionsMenu items={[{ label: 'Editar configuración de subred', onClick: () => setModal('auto') }, { label: 'Administrar etiquetas', onClick: () => setModal('tag') }, 'sep', { label: 'Eliminar subred', onClick: () => setModal('del') }]} />
      </PageHead>
      <Card flush>
        <Tabs tabs={['Detalles', 'Tabla de enrutamiento', 'Instancias', 'Etiquetas']} value={tab} onChange={setTab} />
        <div style={{ padding: 20 }}>
          {tab === 'Detalles' && <KV items={[
            ['ID de subred', sn.id], ['Estado', <Status tone="ok">Available</Status>], ['Tipo', <SubnetType sn={sn} />],
            ['VPC', <Link to={'/vpc/vpcs/' + sn.vpcId}>{sn.vpcId}</Link>], ['Bloque de CIDR IPv4', sn.cidr], ['Direcciones IPv4 disponibles', freeIps(sn.cidr)],
            ['Zona de disponibilidad', sn.az], ['Tabla de enrutamiento', <Link to={'/vpc/routes/' + rt.id}>{rt.id}</Link>], ['Asignar IPv4 pública automáticamente', sn.mapPublicIpOnLaunch ? 'Sí' : 'No'],
            ['ARN de la subred', `arn:aws:ec2:${sn.region}:${s.account.id}:subnet/${sn.id}`], ['ID de propietario', s.account.id],
          ]} />}
          {tab === 'Tabla de enrutamiento' && <><p>Tabla de enrutamiento efectiva: <Link to={'/vpc/routes/' + rt.id}>{rt.id}</Link> {rt.main && '(principal, asociación implícita)'}</p><RouteTableTable rt={rt} /></>}
          {tab === 'Instancias' && <Table rows={insts} id={(i) => i.id} empty={{ title: 'Sin instancias', desc: 'No hay instancias en esta subred.' }} cols={[{ head: 'ID de instancia', cell: (i) => <Link to={'/ec2/instance/' + i.id}>{i.id}</Link> }, { head: 'Estado', cell: (i) => i.state }, { head: 'IP privada', cell: (i) => i.privateIp }]} />}
          {tab === 'Etiquetas' && <Table rows={Object.entries(sn.tags)} id={([k]) => k} empty={{ title: 'Sin etiquetas' }} cols={[{ head: 'Clave', cell: ([k]) => k }, { head: 'Valor', cell: ([, v]) => v }]} />}
        </div>
      </Card>
      {modal === 'del' && <DeleteSubnet sn={sn} onClose={() => setModal(null)} then={() => nav('/vpc/subnets')} />}
      {modal === 'auto' && <AutoIpModal sn={sn} onClose={() => setModal(null)} />}
      {modal === 'tag' && <TagModal resource={sn.id} onClose={() => setModal(null)} />}
    </>
  );
}

import React, { useState } from 'react';
import { useCloud, consoleRun } from '../../session';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, Modal, PageHead, Status, Table } from '../../components/ui';
import { azsOf } from '../../../engine/catalog';
import { intToIp, parseCidr } from '../../../engine/services/ec2';
import type { Vpc } from '../../../engine/types';
import { nav, ActionsMenu, ConfirmModal, FlashBar, KV, Link, Tabs, cmdOf, errParts, inRegion, modalRun, nameError, nm, notify, rg, sel1, tagSpec } from './common';
import { ResourceMap } from './ResourceMap';

const dhcp = 'dopt-0a1b2c3d';

export function VpcList() {
  const s = useCloud();
  const rows = inRegion(s.vpcs, s.region);
  const [sel, setSel] = useState<string[]>([]);
  const [del, setDel] = useState(false);
  const cur = rows.find((v) => v.id === sel[0]);
  return (
    <>
      <Crumbs items={[{ label: 'VPC', to: '/vpc' }, { label: 'Sus VPC' }]} />
      <FlashBar />
      <Card
        title="Sus VPC"
        count={rows.length}
        flush
        actions={
          <>
            <Btn onClick={() => cur && nav('/vpc/vpcs/' + cur.id)} disabled={!cur}>Ver detalles</Btn>
            <ActionsMenu items={[{ label: 'Ver detalles', disabled: !cur, onClick: () => cur && nav('/vpc/vpcs/' + cur.id) }, { label: 'Ver mapa de recursos', disabled: !cur, onClick: () => cur && nav('/vpc/vpcs/' + cur.id + '?tab=map') }, 'sep', { label: 'Eliminar VPC', disabled: !cur, onClick: () => setDel(true) }]} />
            <Btn kind="primary" onClick={() => nav('/vpc/vpcs/create')}>Crear VPC</Btn>
          </>
        }
      >
        <Table
          rows={rows}
          id={(x) => x.id}
          selected={sel}
          onSelect={sel1(setSel)}
          empty={{ title: 'No tiene VPC en esta región', desc: 'Cree una VPC para lanzar recursos en una red aislada.' }}
          filterPlaceholder="Buscar VPC por atributo o etiqueta"
          cols={[
            { head: 'Nombre', cell: (x) => (nm(x.tags) === '-' ? '-' : <Link to={'/vpc/vpcs/' + x.id}>{nm(x.tags)}</Link>), text: (x) => nm(x.tags) },
            { head: 'ID de la VPC', cell: (x) => <Link to={'/vpc/vpcs/' + x.id}>{x.id}</Link>, text: (x) => x.id },
            { head: 'Estado', cell: (x) => (x.state === 'available' ? <Status tone="ok">Available</Status> : <Status tone="load">Pending</Status>), text: (x) => x.state },
            { head: 'Bloque de CIDR IPv4', cell: (x) => x.cidr },
            { head: 'Bloque de CIDR IPv6', cell: () => '-' },
            { head: 'Conjunto de opciones de DHCP', cell: () => dhcp },
            { head: 'Tabla de enrutamiento principal', cell: (x) => <Link to={'/vpc/routes/' + x.mainRouteTableId}>{x.mainRouteTableId}</Link>, text: (x) => x.mainRouteTableId },
            { head: 'ACL de red principal', cell: (x) => x.defaultNetworkAclId },
            { head: 'Inquilino', cell: () => 'Predeterminado' },
            { head: 'VPC predeterminada', cell: (x) => (x.isDefault ? 'Sí' : 'No') },
            { head: 'ID de propietario', cell: () => s.account.id },
          ]}
        />
      </Card>
      {del && cur && (
        <ConfirmModal title="Eliminar VPC" cmd={`aws ec2 delete-vpc --vpc-id ${cur.id} ${rg(s.region)}`} onClose={() => setDel(false)} onConfirm={modalRun(`aws ec2 delete-vpc --vpc-id ${cur.id} ${rg(s.region)}`, `Se eliminó correctamente la VPC ${cur.id}.`, () => setSel([]))}>
          <p>¿Seguro que desea eliminar la VPC <b>{cur.id}</b> {nm(cur.tags) !== '-' && `(${nm(cur.tags)})`}? Debe eliminar antes sus subredes, gateways de internet e instancias.</p>
        </ConfirmModal>
      )}
    </>
  );
}

// ---------------------------------------------------------------- detalle
export function VpcDetail({ id, tab: t0 }: { id: string; tab?: string }) {
  const s = useCloud();
  const v = s.vpcs.find((x) => x.id === id);
  const [tab, setTab] = useState(t0 === 'map' ? 'Mapa de recursos' : 'Resumen');
  const [modal, setModal] = useState<null | 'dns' | 'dnsres' | 'del' | 'tag'>(null);
  if (!v) {
    return (
      <>
        <Crumbs items={[{ label: 'VPC', to: '/vpc' }, { label: 'Sus VPC', to: '/vpc/vpcs' }, { label: id }]} />
        <Flash kind="err" title="VPC no encontrada">La VPC {id} no existe en la región {s.region}. <Link to="/vpc/vpcs">Volver a Sus VPC</Link></Flash>
      </>
    );
  }
  const count = (n: number, to: string) => <Link to={to + '?vpc=' + v.id}>{n}</Link>;
  const subs = s.subnets.filter((x) => x.vpcId === v.id).length;
  const rts = s.routeTables.filter((x) => x.vpcId === v.id).length;
  const igws = s.internetGateways.filter((x) => x.attachedVpcId === v.id).length;
  const nats = s.natGateways.filter((n) => n.state !== 'deleted' && s.subnets.find((x) => x.id === n.subnetId)?.vpcId === v.id).length;
  const sgs = s.securityGroups.filter((x) => x.vpcId === v.id).length;
  const tagRows = Object.entries(v.tags);
  return (
    <>
      <Crumbs items={[{ label: 'VPC', to: '/vpc' }, { label: 'Sus VPC', to: '/vpc/vpcs' }, { label: v.id }]} />
      <FlashBar />
      <PageHead title={<>{v.id}{nm(v.tags) !== '-' && <span style={{ fontWeight: 400, color: 'var(--muted)' }}> / {nm(v.tags)}</span>}</>}>
        <ActionsMenu items={[
          { label: 'Editar nombres de host de DNS', onClick: () => setModal('dns') },
          { label: 'Editar resolución de DNS', onClick: () => setModal('dnsres') },
          { label: 'Administrar etiquetas', onClick: () => setModal('tag') },
          'sep',
          { label: 'Eliminar VPC', onClick: () => setModal('del') },
        ]} />
      </PageHead>
      <Card flush>
        <Tabs tabs={['Resumen', 'Mapa de recursos', 'CIDR', 'Etiquetas']} value={tab} onChange={setTab} />
        <div style={{ padding: 20 }}>
          {tab === 'Resumen' && (
            <>
              <KV items={[
                ['ID de la VPC', v.id], ['Estado', <Status tone="ok">Available</Status>], ['Nombres de host de DNS', v.dnsHostnames ? 'Habilitado' : 'Deshabilitado'],
                ['Resolución de DNS', v.dnsSupport ? 'Habilitado' : 'Deshabilitado'], ['Inquilino', 'Predeterminado'], ['Conjunto de opciones de DHCP', dhcp],
                ['Tabla de enrutamiento principal', <Link to={'/vpc/routes/' + v.mainRouteTableId}>{v.mainRouteTableId}</Link>], ['ACL de red principal', v.defaultNetworkAclId], ['VPC predeterminada', v.isDefault ? 'Sí' : 'No'],
                ['CIDR IPv4', v.cidr], ['CIDR IPv6', '-'], ['ID de propietario', s.account.id],
              ]} />
              <h3 style={{ margin: '24px 0 12px' }}>Recursos de la VPC</h3>
              <KV items={[['Subredes', count(subs, '/vpc/subnets')], ['Tablas de enrutamiento', count(rts, '/vpc/routes')], ['Gateways de internet', count(igws, '/vpc/igw')], ['Gateways NAT', count(nats, '/vpc/nat')], ['Grupos de seguridad', count(sgs, '/vpc/sg')], ['Grupo de seguridad predeterminado', v.defaultSecurityGroupId]]} />
            </>
          )}
          {tab === 'Mapa de recursos' && <ResourceMap vpcId={v.id} />}
          {tab === 'CIDR' && <Table rows={[{ c: v.cidr }]} id={(r) => r.c} empty={{ title: '-' }} cols={[{ head: 'Bloque de CIDR', cell: (r) => r.c }, { head: 'Tipo', cell: () => 'IPv4' }, { head: 'Estado', cell: () => <Status tone="ok">Asociado</Status> }]} />}
          {tab === 'Etiquetas' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <b>Etiquetas ({tagRows.length})</b><Btn onClick={() => setModal('tag')}>Administrar etiquetas</Btn>
              </div>
              <Table rows={tagRows} id={([k]) => k} empty={{ title: 'Sin etiquetas', desc: 'Esta VPC no tiene etiquetas.' }} cols={[{ head: 'Clave', cell: ([k]) => k }, { head: 'Valor', cell: ([, val]) => val }]} />
            </>
          )}
        </div>
      </Card>
      {modal === 'dns' && <DnsModal v={v} attr="hostnames" onClose={() => setModal(null)} />}
      {modal === 'dnsres' && <DnsModal v={v} attr="support" onClose={() => setModal(null)} />}
      {modal === 'tag' && <TagModal resource={v.id} onClose={() => setModal(null)} />}
      {modal === 'del' && (
        <ConfirmModal title="Eliminar VPC" cmd={`aws ec2 delete-vpc --vpc-id ${v.id} ${rg(s.region)}`} onClose={() => setModal(null)} onConfirm={modalRun(`aws ec2 delete-vpc --vpc-id ${v.id} ${rg(s.region)}`, `Se eliminó correctamente la VPC ${v.id}.`, () => nav('/vpc/vpcs'))}>
          <p>¿Seguro que desea eliminar la VPC <b>{v.id}</b>? Esta acción no se puede deshacer.</p>
        </ConfirmModal>
      )}
    </>
  );
}

function DnsModal({ v, attr, onClose }: { v: Vpc; attr: 'hostnames' | 'support'; onClose: () => void }) {
  const s = useCloud();
  const [on, setOn] = useState(attr === 'hostnames' ? v.dnsHostnames : v.dnsSupport);
  const opt = attr === 'hostnames' ? 'enable-dns-hostnames' : 'enable-dns-support';
  const cmd = `aws ec2 modify-vpc-attribute --vpc-id ${v.id} --${opt} Value=${on} ${rg(s.region)}`;
  return (
    <ConfirmModal title={attr === 'hostnames' ? 'Editar nombres de host de DNS' : 'Editar resolución de DNS'} label="Guardar" danger={false} cmd={cmd} onClose={onClose} onConfirm={modalRun(cmd, 'La configuración de DNS se actualizó correctamente.')}>
      <label className="vp-check"><input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> Habilitar {attr === 'hostnames' ? 'los nombres de host de DNS' : 'la resolución de DNS'}</label>
    </ConfirmModal>
  );
}

export function TagModal({ resource, onClose }: { resource: string; onClose: () => void }) {
  const s = useCloud();
  const [k, setK] = useState('Name');
  const [val, setVal] = useState('');
  const bad = nameError(k) || nameError(val) || (!k.trim() && 'La clave es obligatoria');
  const cmd = `aws ec2 create-tags --resources ${resource} --tags Key=${k},Value=${val} ${rg(s.region)}`;
  return (
    <ConfirmModal title="Administrar etiquetas" label="Guardar" danger={false} cmd={cmd} onClose={onClose} onConfirm={async () => (bad ? String(bad) : modalRun(cmd, `Se guardó la etiqueta ${k} en ${resource}.`)())}>
      <Field label="Clave"><input type="text" value={k} onChange={(e) => setK(e.target.value)} /></Field>
      <Field label="Valor" error={bad ? String(bad) : undefined}><input type="text" value={val} onChange={(e) => setVal(e.target.value)} /></Field>
    </ConfirmModal>
  );
}

// ---------------------------------------------------------------- crear VPC
interface Step { label: string; cmd: (g: (k: string) => string) => string; done?: (j: any, set: (k: string, v: string) => void) => void }

function planOf(o: { region: string; prefix: string; cidr: string; azCount: number; pub: number; priv: number; nat: 'none' | 'one' | 'perAz'; dnsHost: boolean }): Step[] {
  const c = parseCidr(o.cidr)!;
  const subBits = Math.min(c.bits + 4, 28);
  const size = 2 ** (32 - subBits);
  const half = 2 ** (32 - c.bits) / 2;
  const azs = azsOf(o.region).slice(0, o.azCount);
  const R = rg(o.region);
  const steps: Step[] = [];
  const p = o.prefix.trim() || 'proyecto';
  steps.push({ label: `Crear VPC ${p}-vpc`, cmd: () => cmdOf('aws ec2 create-vpc --cidr-block', c ? o.cidr : '', tagSpec('vpc', `${p}-vpc`), R), done: (j, set) => set('vpc', j.Vpc.VpcId) });
  if (o.dnsHost) steps.push({ label: 'Habilitar nombres de host de DNS', cmd: (g) => `aws ec2 modify-vpc-attribute --vpc-id ${g('vpc')} --enable-dns-hostnames Value=true ${R}` });
  const pubSubs = Array.from({ length: o.pub }, (_, i) => ({ k: `pub${i}`, az: azs[i % azs.length], cidr: `${intToIp(c.base + i * size)}/${subBits}`, name: `${p}-subnet-public${i + 1}-${azs[i % azs.length]}` }));
  const privSubs = Array.from({ length: o.priv }, (_, i) => ({ k: `priv${i}`, az: azs[i % azs.length], cidr: `${intToIp(c.base + half + i * size)}/${subBits}`, name: `${p}-subnet-private${i + 1}-${azs[i % azs.length]}` }));
  [...pubSubs, ...privSubs].forEach((sn) =>
    steps.push({ label: `Crear subred ${sn.name}`, cmd: (g) => cmdOf('aws ec2 create-subnet --vpc-id', g('vpc'), '--cidr-block', sn.cidr, '--availability-zone', sn.az, tagSpec('subnet', sn.name), R), done: (j, set) => set(sn.k, j.Subnet.SubnetId) }),
  );
  pubSubs.forEach((sn) => steps.push({ label: `Asignar IP pública automática en ${sn.name}`, cmd: (g) => `aws ec2 modify-subnet-attribute --subnet-id ${g(sn.k)} --map-public-ip-on-launch ${R}` }));
  if (pubSubs.length) {
    steps.push({ label: `Crear gateway de internet ${p}-igw`, cmd: () => cmdOf('aws ec2 create-internet-gateway', tagSpec('internet-gateway', `${p}-igw`), R), done: (j, set) => set('igw', j.InternetGateway.InternetGatewayId) });
    steps.push({ label: 'Conectar el gateway de internet a la VPC', cmd: (g) => `aws ec2 attach-internet-gateway --internet-gateway-id ${g('igw')} --vpc-id ${g('vpc')} ${R}` });
    steps.push({ label: `Crear tabla de enrutamiento ${p}-rtb-public`, cmd: (g) => cmdOf('aws ec2 create-route-table --vpc-id', g('vpc'), tagSpec('route-table', `${p}-rtb-public`), R), done: (j, set) => set('rtbPub', j.RouteTable.RouteTableId) });
    steps.push({ label: 'Crear ruta 0.0.0.0/0 hacia el gateway de internet', cmd: (g) => `aws ec2 create-route --route-table-id ${g('rtbPub')} --destination-cidr-block 0.0.0.0/0 --gateway-id ${g('igw')} ${R}` });
    pubSubs.forEach((sn) => steps.push({ label: `Asociar ${sn.name} a la tabla pública`, cmd: (g) => `aws ec2 associate-route-table --route-table-id ${g('rtbPub')} --subnet-id ${g(sn.k)} ${R}` }));
  }
  const natAzs = o.nat === 'none' || !pubSubs.length ? [] : o.nat === 'one' ? [pubSubs[0].az] : [...new Set(pubSubs.map((x) => x.az))];
  natAzs.forEach((az, i) => {
    const host = pubSubs.find((x) => x.az === az)!;
    steps.push({ label: `Asignar dirección IP elástica (${az})`, cmd: () => `aws ec2 allocate-address --domain vpc ${R}`, done: (j, set) => set('eip' + i, j.AllocationId) });
    steps.push({ label: `Crear gateway NAT ${p}-nat-public${i + 1}-${az}`, cmd: (g) => cmdOf('aws ec2 create-nat-gateway --subnet-id', g(host.k), '--allocation-id', g('eip' + i), tagSpec('natgateway', `${p}-nat-public${i + 1}-${az}`), R), done: (j, set) => set('nat' + i, j.NatGateway.NatGatewayId) });
  });
  privSubs.forEach((sn, i) => {
    const ni = natAzs.length ? Math.max(0, natAzs.indexOf(sn.az)) : -1;
    const rn = `${p}-rtb-private${i + 1}-${sn.az}`;
    steps.push({ label: `Crear tabla de enrutamiento ${rn}`, cmd: (g) => cmdOf('aws ec2 create-route-table --vpc-id', g('vpc'), tagSpec('route-table', rn), R), done: (j, set) => set('rtbPriv' + i, j.RouteTable.RouteTableId) });
    if (ni >= 0) steps.push({ label: `Crear ruta 0.0.0.0/0 hacia el gateway NAT (${rn})`, cmd: (g) => `aws ec2 create-route --route-table-id ${g('rtbPriv' + i)} --destination-cidr-block 0.0.0.0/0 --nat-gateway-id ${g('nat' + ni)} ${R}` });
    steps.push({ label: `Asociar ${sn.name} a ${rn}`, cmd: (g) => `aws ec2 associate-route-table --route-table-id ${g('rtbPriv' + i)} --subnet-id ${g(sn.k)} ${R}` });
  });
  return steps;
}

export function VpcCreate() {
  const s = useCloud();
  const [kind, setKind] = useState<'only' | 'more'>('more');
  const [name, setName] = useState('');
  const [cidr, setCidr] = useState('10.0.0.0/16');
  const [prefix, setPrefix] = useState('proyecto');
  const [azCount, setAz] = useState(2);
  const [pub, setPub] = useState(2);
  const [priv, setPriv] = useState(2);
  const [nat, setNat] = useState<'none' | 'one' | 'perAz'>('none');
  const [dnsHost, setDnsHost] = useState(true);
  const [err, setErr] = useState('');
  const [prog, setProg] = useState<{ label: string; cmd: string; state: 'run' | 'ok' | 'err'; msg?: string }[] | null>(null);
  const [vpcId, setVpcId] = useState('');
  const c = parseCidr(cidr);
  const cidrErr = !c ? 'Introduzca un bloque CIDR válido, por ejemplo 10.0.0.0/16' : c.bits < 16 || c.bits > 28 ? 'El tamaño del bloque CIDR debe estar entre /16 y /28' : '';
  const effNat = pub === 0 ? 'none' : nat;
  const onlyCmd = cmdOf('aws ec2 create-vpc --cidr-block', cidr, tagSpec('vpc', name), rg(s.region));
  const plan = kind === 'more' && c ? planOf({ region: s.region, prefix, cidr, azCount, pub, priv, nat: effNat, dnsHost }) : [];
  const preview = plan.map((st) => st.cmd((k) => `<${k}>`)).join('\n');
  const busy = prog?.some((p) => p.state === 'run');
  const nameErr = nameError(kind === 'only' ? name : prefix);

  const create = async () => {
    setErr('');
    if (cidrErr || nameErr) return setErr(cidrErr || nameErr);
    if (kind === 'only') {
      const r = await consoleRun(onlyCmd);
      if (!r.ok) {
        const e = errParts(r.err);
        return setErr((e.code ? e.code + ': ' : '') + e.msg);
      }
      notify({ kind: 'ok', text: `Se creó correctamente la VPC ${r.json.Vpc.VpcId}.` });
      return nav('/vpc/vpcs/' + r.json.Vpc.VpcId);
    }
    const vars: Record<string, string> = {};
    const g = (k: string) => vars[k] ?? `<${k}>`;
    const list: NonNullable<typeof prog> = plan.map((st) => ({ label: st.label, cmd: '', state: 'run' as const }));
    list.forEach((x) => (x.state = 'run'));
    const upd = () => setProg(list.map((x) => ({ ...x })));
    list.forEach((x) => (x.msg = 'pendiente'));
    upd();
    for (let i = 0; i < plan.length; i++) {
      const cmd = plan[i].cmd(g);
      list[i].cmd = cmd;
      list[i].msg = undefined;
      upd();
      const r = await consoleRun(cmd);
      if (!r.ok) {
        const e = errParts(r.err);
        list[i].state = 'err';
        list[i].msg = (e.code ? e.code + ': ' : '') + e.msg;
        list.slice(i + 1).forEach((x) => (x.msg = 'no ejecutado'));
        list.slice(i + 1).forEach((x) => (x.state = 'err'));
        upd();
        return setErr(`Falló el paso «${plan[i].label}». Los recursos creados hasta ahora se conservan.`);
      }
      list[i].state = 'ok';
      plan[i].done?.(r.json, (k, v) => (vars[k] = v));
      if (vars.vpc) setVpcId(vars.vpc);
      upd();
    }
    notify({ kind: 'ok', text: `Se creó correctamente la VPC ${vars.vpc} con ${plan.length} operaciones.` });
  };

  return (
    <>
      <Crumbs items={[{ label: 'VPC', to: '/vpc' }, { label: 'Sus VPC', to: '/vpc/vpcs' }, { label: 'Crear VPC' }]} />
      <PageHead title="Crear VPC" desc="Una VPC es una red virtual aislada de la nube de AWS. Elija si desea crear solo la VPC o también sus recursos de red." />
      {err && <Flash kind="err" title="Error al crear la VPC" onClose={() => setErr('')}>{err}</Flash>}
      <div className="wizard">
        <div className="vp-form">
          <Card title="Configuración de la VPC">
            <Field label="Recursos que se van a crear">
              <div className={`radio ${kind === 'only' ? 'on' : ''}`} onClick={() => !busy && setKind('only')}><input type="radio" readOnly checked={kind === 'only'} aria-label="Solo la VPC" /><div><b>Solo la VPC</b><div className="hint">Crea únicamente la VPC con su tabla de rutas principal, ACL y grupo de seguridad predeterminados.</div></div></div>
              <div className={`radio ${kind === 'more' ? 'on' : ''}`} onClick={() => !busy && setKind('more')}><input type="radio" readOnly checked={kind === 'more'} aria-label="VPC y más" /><div><b>VPC y más</b><div className="hint">Crea la VPC, subredes públicas y privadas, gateway de internet, tablas de enrutamiento y, opcionalmente, gateways NAT.</div></div></div>
            </Field>
            {kind === 'only' ? (
              <Field label="Etiqueta de nombre" hint="Crea una etiqueta con la clave «Name» y el valor que introduzca." error={nameErr || undefined}>
                <input type="text" aria-label="Etiqueta de nombre" value={name} placeholder="mi-vpc" onChange={(e) => setName(e.target.value)} />
              </Field>
            ) : (
              <Field label="Generación automática de etiquetas de nombre" hint="Prefijo usado para los nombres de todos los recursos." error={nameErr || undefined}>
                <input type="text" aria-label="Prefijo de nombre" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
              </Field>
            )}
            <Field label="Bloque de CIDR IPv4" hint="Determina el rango de direcciones IP de la VPC (entre /16 y /28)." error={cidrErr || undefined}>
              <input type="text" aria-label="Bloque de CIDR IPv4" value={cidr} onChange={(e) => setCidr(e.target.value)} />
            </Field>
            <Field label="Inquilino"><select disabled><option>Predeterminado</option></select></Field>
            {kind === 'more' && (
              <>
                <div className="row">
                  <Field label="Número de zonas de disponibilidad"><select aria-label="Número de zonas de disponibilidad" value={azCount} onChange={(e) => { const n = Number(e.target.value); setAz(n); setPub((p) => Math.min(p, n)); }}>{[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}</select></Field>
                  <Field label="Subredes públicas"><select aria-label="Número de subredes públicas" value={Math.min(pub, azCount)} onChange={(e) => setPub(Number(e.target.value))}>{Array.from({ length: azCount + 1 }, (_, n) => <option key={n} value={n}>{n}</option>)}</select></Field>
                  <Field label="Subredes privadas"><select aria-label="Número de subredes privadas" value={priv} onChange={(e) => setPriv(Number(e.target.value))}>{Array.from({ length: azCount * 2 + 1 }, (_, n) => <option key={n} value={n}>{n}</option>)}</select></Field>
                </div>
                <Field label="Gateways NAT" hint="Permiten que las subredes privadas salgan a internet. Requieren al menos una subred pública.">
                  <select aria-label="Gateways NAT" value={effNat} disabled={pub === 0} onChange={(e) => setNat(e.target.value as any)}>
                    <option value="none">Ninguno</option><option value="one">En 1 zona de disponibilidad</option><option value="perAz">1 por zona de disponibilidad</option>
                  </select>
                  {effNat !== 'none' && <div className="vp-warn">Un gateway NAT cuesta aprox. $0,048 por hora (≈ $35/mes) más el tráfico procesado.</div>}
                </Field>
                <Field label="Opciones de DNS">
                  <label className="vp-check"><input type="checkbox" checked={dnsHost} onChange={(e) => setDnsHost(e.target.checked)} /> Habilitar nombres de host de DNS</label>
                  <label className="vp-check"><input type="checkbox" checked disabled /> Habilitar resolución de DNS</label>
                </Field>
              </>
            )}
          </Card>
          {prog && (
            <Card title="Flujo de trabajo de creación">
              <ul className="vp-steps">
                {prog.map((p, i) => (
                  <li key={i}>
                    <span style={{ width: 90, flex: 'none' }}>{p.state === 'ok' ? <Status tone="ok">Listo</Status> : p.state === 'err' ? <Status tone="err">Error</Status> : p.msg === 'pendiente' ? <Status tone="">Pendiente</Status> : <Status tone="load">En curso</Status>}</span>
                    <div><div>{p.label}</div>{p.cmd && <code>{p.cmd}</code>}{p.state === 'err' && p.msg && <div style={{ color: 'var(--err)' }}>{p.msg}</div>}</div>
                  </li>
                ))}
              </ul>
              {!busy && vpcId && prog.every((p) => p.state === 'ok') && <div style={{ marginTop: 12 }}><Btn kind="primary" onClick={() => nav('/vpc/vpcs/' + vpcId)}>Ver VPC</Btn></div>}
            </Card>
          )}
        </div>
        <div className="summary">
          <Card title="Vista previa">
            <dl>
              <dt>Región</dt><dd>{s.region}</dd>
              <dt>CIDR IPv4</dt><dd>{cidr}</dd>
              {kind === 'more' && <><dt>Subredes</dt><dd>{pub} públicas · {priv} privadas · {azCount} AZ</dd><dt>Gateway de internet</dt><dd>{pub ? 'Sí' : 'No'}</dd><dt>Gateways NAT</dt><dd>{effNat === 'none' ? 'Ninguno' : effNat === 'one' ? '1' : `${new Set(plan.filter((p) => p.label.startsWith('Crear gateway NAT')).map((p) => p.label)).size}`}</dd></>}
            </dl>
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <Btn onClick={() => nav('/vpc/vpcs')} disabled={busy}>Cancelar</Btn>
              <Btn kind="primary" onClick={create} disabled={busy || !!prog?.every((p) => p.state === 'ok')}>Crear VPC</Btn>
            </div>
            <CliEquivalent cmd={kind === 'only' ? onlyCmd : preview || '—'} />
          </Card>
        </div>
      </div>
    </>
  );
}

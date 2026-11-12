import React, { useEffect } from 'react';
import { useCloud } from '../session';
import { Btn, Card, Crumbs, PageHead, Status } from '../components/ui';
import { SERVICES } from '../services';
import { NAT_HOURLY } from '../../engine/catalog';
import { EipList, IgwList, NatList } from './vpc/Gateways';
import { RouteDetail, RouteList } from './vpc/Routes';
import { SgDetail, SgList } from './vpc/Sg';
import { SubnetCreate, SubnetDetail, SubnetList } from './vpc/Subnets';
import { VpcCreate, VpcDetail, VpcList } from './vpc/Vpcs';
import { nav, FlashBar, Link, ageNotice, fix, inRegion, queryOf, useDefaults } from './vpc/common';

const NAV: [string, string][] = [
  ['/vpc', 'Panel de VPC'], ['/vpc/vpcs', 'Sus VPC'], ['/vpc/subnets', 'Subredes'], ['/vpc/routes', 'Tablas de enrutamiento'], ['/vpc/igw', 'Gateways de internet'],
  ['/vpc/nat', 'Gateways NAT'], ['/vpc/eip', 'Direcciones IP elásticas'], ['/vpc/sg', 'Grupos de seguridad'],
];

/** Si el menú lateral del servicio no incluye todas las secciones, se muestra una barra local para llegar a ellas. */
function LocalNav({ path }: { path: string }) {
  const svc = SERVICES.find((x) => x.id === 'vpc');
  const side = (svc?.nav ?? []).map((n) => ('to' in n ? n.to : ''));
  if (NAV.every(([to]) => side.includes(to))) return null;
  const hit = (to: string) => [to, fix(to)].filter((x) => path === x || path.startsWith(x + '/')).map((x) => x.length)[0] ?? 0;
  const cur = NAV.filter(([to]) => to !== '/vpc' && hit(to) > 0).sort((a, b) => hit(b[0]) - hit(a[0]))[0]?.[0] ?? '/vpc';
  return (
    <div className="vp-nav" role="navigation" aria-label="Secciones de VPC">
      {NAV.map(([to, label]) => <a key={to} className={to === cur ? 'on' : ''} href={'#' + fix(to)} onClick={(e) => { e.preventDefault(); nav(to); }}>{label}</a>)}
    </div>
  );
}

function Dashboard() {
  const s = useCloud();
  const r = s.region;
  const nats = inRegion(s.natGateways, r).filter((n) => n.state !== 'deleted');
  const tiles: [string, number, string][] = [
    ['Sus VPC', inRegion(s.vpcs, r).length, '/vpc/vpcs'], ['Subredes', inRegion(s.subnets, r).length, '/vpc/subnets'], ['Tablas de enrutamiento', inRegion(s.routeTables, r).length, '/vpc/routes'],
    ['Gateways de internet', inRegion(s.internetGateways, r).length, '/vpc/igw'], ['Gateways NAT', nats.length, '/vpc/nat'], ['Direcciones IP elásticas', inRegion(s.elasticIps, r).length, '/vpc/eip'],
    ['Grupos de seguridad', inRegion(s.securityGroups, r).length, '/vpc/sg'],
  ];
  const monthly = nats.length * NAT_HOURLY * 730;
  return (
    <>
      <Crumbs items={[{ label: 'VPC' }]} />
      <FlashBar />
      <PageHead title="Panel de VPC" desc="Redes virtuales aisladas en la nube de AWS.">
        <Btn kind="primary" onClick={() => nav('/vpc/vpcs/create')}>Crear VPC</Btn>
      </PageHead>
      <Card title="Recursos por región" actions={<span style={{ color: 'var(--muted)' }}>{r}</span>}>
        <div className="vp-tiles">
          {tiles.map(([l, n, to]) => (
            <div key={l} className="vp-tile" role="link" tabIndex={0} onClick={() => nav(to)} onKeyDown={(e) => e.key === 'Enter' && nav(to)}>
              <div className="n">{n}</div><div className="l">{l}</div>
            </div>
          ))}
        </div>
      </Card>
      <div className="vp-grid2">
        <Card title="Iniciar el asistente de VPC">
          <p style={{ marginTop: 0 }}>Cree una VPC con subredes públicas y privadas, gateway de internet y gateways NAT en unos pocos pasos.</p>
          <Btn kind="primary" onClick={() => nav('/vpc/vpcs/create')}>Crear VPC</Btn>
        </Card>
        <Card title="Estado del servicio">
          <p style={{ marginTop: 0 }}><Status tone="ok">Este servicio funciona con normalidad</Status></p>
          <p style={{ marginBottom: 0 }}>Coste estimado de gateways NAT: <b>${monthly.toFixed(2)}</b> al mes. {nats.length > 0 && <Link to="/vpc/nat">Ver gateways NAT</Link>}</p>
        </Card>
      </div>
    </>
  );
}

export function VpcPages({ path }: { path: string }) {
  const full = path + (location.hash.includes('?') ? '?' + location.hash.split('?')[1] : '');
  const tab = queryOf('tab') ?? undefined;
  useDefaults();
  useEffect(() => ageNotice(), []);
  let seg = path.split('/').filter(Boolean); // ['vpc', 'vpcs', ':id']
  if (seg[1] === 'igw' && ['nat', 'eip', 'sg'].includes(seg[2])) seg = ['vpc', ...seg.slice(2)];
  const sec = seg[1];
  const id = seg[2];
  let page: React.ReactNode;
  if (!sec) page = <Dashboard />;
  else if (sec === 'subnets') page = id === 'create' ? <SubnetCreate path={full} /> : id ? <SubnetDetail id={id} /> : <SubnetList path={full} />;
  else if (sec === 'routes') page = id ? <RouteDetail id={id} tab={tab} key={id + tab} /> : <RouteList path={full} />;
  else if (sec === 'igw') page = <IgwList path={full} />;
  else if (sec === 'nat') page = <NatList path={full} />;
  else if (sec === 'eip') page = <EipList />;
  else if (sec === 'sg') page = id ? <SgDetail id={id} /> : <SgList path={full} />;
  else page = id === 'create' ? <VpcCreate /> : id ? <VpcDetail id={id} tab={tab} key={id + tab} /> : <VpcList />;
  return (
    <>
      <LocalNav path={path} />
      {page}
    </>
  );
}

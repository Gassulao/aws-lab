import React from 'react';
import { useCloud } from '../../session';
import {  } from '../../components/ui';
import { isPublicSubnet, routeTableOfSubnet } from '../../../engine/services/ec2';
import { nav, nm } from './common';

const trunc = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

/** Mapa de recursos: subredes → tablas de enrutamiento → gateways (IGW / NAT). */
export function ResourceMap({ vpcId }: { vpcId: string }) {
  const s = useCloud();
  const vpc = s.vpcs.find((v) => v.id === vpcId);
  if (!vpc) return null;
  const subnets = s.subnets.filter((x) => x.vpcId === vpcId).sort((a, b) => a.az.localeCompare(b.az) || a.cidr.localeCompare(b.cidr));
  const rtbs = s.routeTables.filter((r) => r.vpcId === vpcId).sort((a, b) => Number(b.main) - Number(a.main));
  const igws = s.internetGateways.filter((g) => g.attachedVpcId === vpcId);
  const nats = s.natGateways.filter((n) => n.state !== 'deleted' && subnets.some((x) => x.id === n.subnetId));
  const gws = [...igws.map((g) => ({ id: g.id, label: nm(g.tags) === '-' ? g.id : nm(g.tags), sub: 'Gateway de internet', kind: 'igw' as const, to: '/vpc/igw' })), ...nats.map((n) => ({ id: n.id, label: nm(n.tags) === '-' ? n.id : nm(n.tags), sub: 'Gateway NAT', kind: 'nat' as const, to: '/vpc/nat' }))];

  const W = 960, NH = 44, GAP = 12, TOP = 56;
  const X = { sub: 24, rtb: 350, gw: 690 }, NW = 290;
  const rows = Math.max(subnets.length, rtbs.length, gws.length, 1);
  const H = TOP + rows * (NH + GAP) + 16;
  const y = (i: number) => TOP + i * (NH + GAP);
  const subY = (id: string) => y(subnets.findIndex((x) => x.id === id)) + NH / 2;
  const rtbY = (id: string) => y(rtbs.findIndex((x) => x.id === id)) + NH / 2;
  const gwY = (id: string) => y(gws.findIndex((x) => x.id === id)) + NH / 2;
  const curve = (x1: number, y1: number, x2: number, y2: number) => `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;

  const edges: React.ReactNode[] = [];
  subnets.forEach((sn) => {
    const rt = routeTableOfSubnet(s, sn);
    if (rtbs.some((r) => r.id === rt.id)) edges.push(<path key={'a' + sn.id} className="edge" d={curve(X.sub + NW, subY(sn.id), X.rtb, rtbY(rt.id))} />);
  });
  rtbs.forEach((rt) =>
    rt.routes.forEach((r) => {
      if (r.target === 'local' || !gws.some((g) => g.id === r.target)) return;
      edges.push(<path key={'b' + rt.id + r.destination} className={`edge ${r.target.startsWith('igw') ? 'igw' : 'nat'}`} d={curve(X.rtb + NW, rtbY(rt.id), X.gw, gwY(r.target))} />);
    }),
  );

  return (
    <div>
      <div className="vp-map">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 760, display: 'block' }} role="img" aria-label={`Mapa de recursos de ${vpcId}`}>
          <rect x="4" y="4" width={W - 8} height={H - 8} rx="3" fill="none" stroke="var(--link)" strokeWidth="1.5" strokeDasharray="6 4" />
          <text x="16" y="24" fontWeight="700" fontSize="13">VPC: {nm(vpc.tags) === '-' ? vpc.id : nm(vpc.tags)} <tspan className="sub">{vpc.cidr}</tspan></text>
          <text className="hd" x={X.sub} y="46">Subredes ({subnets.length})</text>
          <text className="hd" x={X.rtb} y="46">Tablas de enrutamiento ({rtbs.length})</text>
          <text className="hd" x={X.gw} y="46">Conexiones de red ({gws.length})</text>
          {edges}
          {subnets.map((sn, i) => {
            const pub = isPublicSubnet(s, sn);
            return (
              <g key={sn.id} onClick={() => nav('/vpc/subnets/' + sn.id)}>
                <rect className="node" x={X.sub} y={y(i)} width={NW} height={NH} rx="3" stroke={pub ? 'var(--ok)' : 'var(--link)'} />
                <text x={X.sub + 10} y={y(i) + 19} fontSize="13" fontWeight="700">{trunc(nm(sn.tags) === "-" ? sn.id : nm(sn.tags), 40)}</text>
                <text className="sub" x={X.sub + 10} y={y(i) + 35}>{sn.az} · {sn.cidr} · {pub ? 'Pública' : 'Privada'}</text>
              </g>
            );
          })}
          {rtbs.map((rt, i) => (
            <g key={rt.id} onClick={() => nav('/vpc/routes/' + rt.id)}>
              <rect className="node" x={X.rtb} y={y(i)} width={NW} height={NH} rx="3" stroke="var(--line2)" />
              <text x={X.rtb + 10} y={y(i) + 19} fontSize="13" fontWeight="700">{trunc(nm(rt.tags) === "-" ? rt.id : nm(rt.tags), 40)}</text>
              <text className="sub" x={X.rtb + 10} y={y(i) + 35}>{rt.main ? 'Principal · ' : ''}{rt.routes.length} rutas · {rt.associations.filter((a) => a.subnetId).length} subredes</text>
            </g>
          ))}
          {gws.map((g, i) => (
            <g key={g.id} onClick={() => nav(g.to)}>
              <rect className="node" x={X.gw} y={y(i)} width={246} height={NH} rx="3" stroke={g.kind === 'igw' ? 'var(--orange)' : 'var(--link)'} />
              <text x={X.gw + 10} y={y(i) + 19} fontSize="13" fontWeight="700">{trunc(g.label, 32)}</text>
              <text className="sub" x={X.gw + 10} y={y(i) + 35}>{g.sub}</text>
            </g>
          ))}
          {gws.length === 0 && <text className="sub" x={X.gw} y={y(0) + 24}>Sin gateways conectados</text>}
        </svg>
      </div>
      <div className="vp-legend">
        <span><i style={{ borderColor: 'var(--ok)' }} />Subred pública</span>
        <span><i style={{ borderColor: 'var(--link)' }} />Subred privada</span>
        <span><i style={{ borderColor: 'var(--orange)' }} />Ruta a gateway de internet</span>
        <span><i style={{ borderColor: 'var(--link)', borderTopStyle: 'dashed' }} />Ruta a gateway NAT</span>
      </div>
    </div>
  );
}

// Amazon VPC y EC2: redes, subredes, gateways, tablas de rutas, grupos de seguridad, NACL, instancias y volúmenes.
import type { CloudState, EbsVolume, Instance, InternetGateway, NatGateway, RouteTable, SecurityGroup, SgRule, Subnet, Tags, Vpc } from '../types';
import { AwsError } from '../errors';
import { authorize, trailed, type Ctx } from '../api';
import { ids } from '../ids';
import { nowIso, now, hex, wildcardMatch } from '../util';
import { cidrContains } from '../policy';
import { AMIS, INSTANCE_TYPES, azsOf, isRegion } from '../catalog';
import { speedFactor } from '../store';

const SRC = 'ec2.amazonaws.com';
const arn = (ctx: Ctx, kind: string, id: string) => `arn:aws:ec2:${ctx.region}:${ctx.s.account.id}:${kind}/${id}`;

// ------------------------------------------------------------------ CIDR

export function parseCidr(c: string): { base: number; bits: number } | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(c);
  if (!m) return null;
  const o = m.slice(1, 5).map(Number);
  const bits = Number(m[5]);
  if (o.some((x) => x > 255) || bits > 32) return null;
  const ip = ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (ip & mask) >>> 0, bits };
}
export const intToIp = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
export const cidrWithin = (inner: string, outer: string) => {
  const a = parseCidr(inner);
  const b = parseCidr(outer);
  if (!a || !b) return false;
  return a.bits >= b.bits && cidrContains(outer, intToIp(a.base));
};
export const cidrsOverlap = (x: string, y: string) => cidrWithin(x, y) || cidrWithin(y, x);

// ------------------------------------------------------------------ utilidades

function tagsOf(t?: { Key: string; Value: string }[] | Tags): Tags {
  if (!t) return {};
  return Array.isArray(t) ? Object.fromEntries(t.map((x) => [x.Key, x.Value])) : { ...t };
}

function checkRegion(ctx: Ctx) {
  if (!isRegion(ctx.region)) throw new AwsError('InvalidRegion', `Could not connect to the endpoint URL: "https://ec2.${ctx.region}.amazonaws.com/"`);
}

/** Crea la VPC predeterminada de la región si todavía no existe (como hace AWS en cada cuenta nueva). */
export function ensureDefaultVpc(s: CloudState, region: string) {
  if (s.vpcs.some((v) => v.region === region && v.isDefault)) return;
  const vpc = buildVpc(s, region, '172.31.0.0/16', true, {});
  azsOf(region).slice(0, 3).forEach((az, i) => {
    const sub: Subnet = { id: ids.subnet(), vpcId: vpc.id, cidr: `172.31.${i * 16}.0/20`, az, region, mapPublicIpOnLaunch: true, tags: {} };
    s.subnets.push(sub);
    const rt = s.routeTables.find((r) => r.id === vpc.mainRouteTableId)!;
    rt.associations.push({ id: `rtbassoc-${hex(17)}`, subnetId: sub.id, main: false });
  });
  const igw: InternetGateway = { id: ids.igw(), region, attachedVpcId: vpc.id, tags: {} };
  s.internetGateways.push(igw);
  s.routeTables.find((r) => r.id === vpc.mainRouteTableId)!.routes.push({ destination: '0.0.0.0/0', target: igw.id });
}

function buildVpc(s: CloudState, region: string, cidr: string, isDefault: boolean, tags: Tags): Vpc {
  const sgId = ids.sg();
  const rtbId = ids.rtb();
  const aclId = ids.acl();
  const vpc: Vpc = { id: ids.vpc(), cidr, region, state: 'available', isDefault, dnsSupport: true, dnsHostnames: isDefault, tags, mainRouteTableId: rtbId, defaultSecurityGroupId: sgId, defaultNetworkAclId: aclId };
  s.vpcs.push(vpc);
  s.routeTables.push({ id: rtbId, vpcId: vpc.id, region, main: true, routes: [{ destination: cidr, target: 'local' }], associations: [{ id: `rtbassoc-${hex(17)}`, main: true }], tags: {} });
  s.securityGroups.push({
    id: sgId, name: 'default', description: 'default VPC security group', vpcId: vpc.id, region,
    ingress: [{ id: ids.sgRule(), protocol: '-1', from: -1, to: -1, sourceSg: sgId }],
    egress: [{ id: ids.sgRule(), protocol: '-1', from: -1, to: -1, cidr: '0.0.0.0/0' }],
    tags: {},
  });
  s.networkAcls.push({
    id: aclId, vpcId: vpc.id, region, isDefault: true, associations: [], tags: {},
    entries: [
      { rule: 100, protocol: '-1', action: 'allow', egress: false, cidr: '0.0.0.0/0' },
      { rule: 100, protocol: '-1', action: 'allow', egress: true, cidr: '0.0.0.0/0' },
    ],
  });
  return vpc;
}

const inRegion = <T extends { region: string }>(ctx: Ctx, list: T[]) => list.filter((x) => x.region === ctx.region);

export function getVpcOr(ctx: Ctx, id: string): Vpc {
  const v = ctx.s.vpcs.find((x) => x.id === id && x.region === ctx.region);
  if (!v) throw new AwsError('InvalidVpcID.NotFound', `The vpc ID '${id}' does not exist`, 400);
  return v;
}
export function getSubnetOr(ctx: Ctx, id: string): Subnet {
  const v = ctx.s.subnets.find((x) => x.id === id && x.region === ctx.region);
  if (!v) throw new AwsError('InvalidSubnetID.NotFound', `The subnet ID '${id}' does not exist`, 400);
  return v;
}
export function getSgOr(ctx: Ctx, id: string): SecurityGroup {
  const v = ctx.s.securityGroups.find((x) => x.id === id && x.region === ctx.region);
  if (!v) throw new AwsError('InvalidGroup.NotFound', `The security group '${id}' does not exist`, 400);
  return v;
}
export function getInstanceOr(ctx: Ctx, id: string): Instance {
  const v = ctx.s.instances.find((x) => x.id === id && x.region === ctx.region);
  if (!v) throw new AwsError('InvalidInstanceID.NotFound', `The instance ID '${id}' does not exist`, 400);
  settle(ctx.s);
  return v;
}

// ------------------------------------------------------------------ VPC

export function createVpc(ctx: Ctx, p: { CidrBlock: string; Tags?: any }): Vpc {
  return trailed(ctx, SRC, 'CreateVpc', [], p, () => {
    checkRegion(ctx);
    authorize(ctx, 'ec2:CreateVpc', `arn:aws:ec2:${ctx.region}:${ctx.s.account.id}:vpc/*`);
    const c = parseCidr(p.CidrBlock);
    if (!c) throw new AwsError('InvalidParameterValue', `Value (${p.CidrBlock}) for parameter cidrBlock is invalid. This is not a valid CIDR block.`);
    if (c.bits < 16 || c.bits > 28) throw new AwsError('InvalidVpc.Range', `The CIDR '${p.CidrBlock}' is invalid.`);
    if (inRegion(ctx, ctx.s.vpcs).length >= 5) throw new AwsError('VpcLimitExceeded', 'The maximum number of VPCs has been reached.', 400);
    ensureDefaultVpc(ctx.s, ctx.region);
    const normalized = `${intToIp(c.base)}/${c.bits}`;
    return buildVpc(ctx.s, ctx.region, normalized, false, tagsOf(p.Tags));
  });
}

export function describeVpcs(ctx: Ctx, p: { VpcIds?: string[]; Filters?: { Name: string; Values: string[] }[] } = {}): Vpc[] {
  return trailed(ctx, SRC, 'DescribeVpcs', [], p, () => {
    checkRegion(ctx);
    authorize(ctx, 'ec2:DescribeVpcs', '*');
    ensureDefaultVpc(ctx.s, ctx.region);
    let list = inRegion(ctx, ctx.s.vpcs);
    if (p.VpcIds?.length) {
      for (const id of p.VpcIds) getVpcOr(ctx, id);
      list = list.filter((v) => p.VpcIds!.includes(v.id));
    }
    return applyFilters(list, p.Filters, { 'is-default': (v) => String(v.isDefault), 'cidr': (v) => v.cidr, 'vpc-id': (v) => v.id });
  });
}

function applyFilters<T extends { tags?: Tags }>(list: T[], filters: { Name: string; Values: string[] }[] | undefined, extra: Record<string, (x: T) => string | undefined>): T[] {
  if (!filters?.length) return list;
  return list.filter((x) =>
    filters.every((f) => {
      // Como en AWS, los valores de un filtro admiten los comodines * y ?.
      if (f.Name.startsWith('tag:')) return f.Values.some((v) => wildcardMatch(v, (x.tags ?? {})[f.Name.slice(4)] ?? '\u0000'));
      const get = extra[f.Name];
      return get ? f.Values.some((v) => wildcardMatch(v, get(x) ?? '\u0000')) : true;
    }),
  );
}

export function modifyVpcAttribute(ctx: Ctx, p: { VpcId: string; EnableDnsHostnames?: boolean; EnableDnsSupport?: boolean }): void {
  trailed(ctx, SRC, 'ModifyVpcAttribute', [], p, () => {
    const v = getVpcOr(ctx, p.VpcId);
    authorize(ctx, 'ec2:ModifyVpcAttribute', arn(ctx, 'vpc', v.id));
    if (p.EnableDnsHostnames !== undefined) v.dnsHostnames = p.EnableDnsHostnames;
    if (p.EnableDnsSupport !== undefined) v.dnsSupport = p.EnableDnsSupport;
  });
}

export function deleteVpc(ctx: Ctx, p: { VpcId: string }): void {
  trailed(ctx, SRC, 'DeleteVpc', [{ type: 'AWS::EC2::VPC', name: p.VpcId }], p, () => {
    const v = getVpcOr(ctx, p.VpcId);
    authorize(ctx, 'ec2:DeleteVpc', arn(ctx, 'vpc', v.id));
    const dep = (what: string) => new AwsError('DependencyViolation', `The vpc '${v.id}' has dependencies and cannot be deleted.`, 400);
    if (ctx.s.subnets.some((x) => x.vpcId === v.id)) throw dep('subnet');
    if (ctx.s.internetGateways.some((x) => x.attachedVpcId === v.id)) throw dep('igw');
    if (ctx.s.instances.some((x) => x.vpcId === v.id && x.state !== 'terminated')) throw dep('instance');
    if (ctx.s.securityGroups.some((x) => x.vpcId === v.id && x.id !== v.defaultSecurityGroupId)) throw dep('sg');
    ctx.s.routeTables = ctx.s.routeTables.filter((r) => r.vpcId !== v.id);
    ctx.s.securityGroups = ctx.s.securityGroups.filter((g) => g.vpcId !== v.id);
    ctx.s.networkAcls = ctx.s.networkAcls.filter((a) => a.vpcId !== v.id);
    ctx.s.vpcs = ctx.s.vpcs.filter((x) => x !== v);
  });
}

// ------------------------------------------------------------------ subredes

export function createSubnet(ctx: Ctx, p: { VpcId: string; CidrBlock: string; AvailabilityZone?: string; Tags?: any }): Subnet {
  return trailed(ctx, SRC, 'CreateSubnet', [], p, () => {
    const v = getVpcOr(ctx, p.VpcId);
    authorize(ctx, 'ec2:CreateSubnet', arn(ctx, 'subnet', '*'));
    const c = parseCidr(p.CidrBlock);
    if (!c) throw new AwsError('InvalidParameterValue', `Value (${p.CidrBlock}) for parameter cidrBlock is invalid. This is not a valid CIDR block.`);
    if (c.bits < 16 || c.bits > 28) throw new AwsError('InvalidSubnet.Range', `The CIDR '${p.CidrBlock}' is invalid.`);
    if (!cidrWithin(p.CidrBlock, v.cidr)) throw new AwsError('InvalidSubnet.Range', `The CIDR '${p.CidrBlock}' is invalid.`);
    const clash = ctx.s.subnets.find((x) => x.vpcId === v.id && cidrsOverlap(x.cidr, p.CidrBlock));
    if (clash) throw new AwsError('InvalidSubnet.Conflict', `The CIDR '${p.CidrBlock}' conflicts with another subnet`);
    const az = p.AvailabilityZone ?? azsOf(ctx.region)[0];
    if (!azsOf(ctx.region).includes(az)) throw new AwsError('InvalidParameterValue', `Value (${az}) for parameter availabilityZone is invalid. Subnets can currently only be created in the following availability zones: ${azsOf(ctx.region).join(', ')}.`);
    const sub: Subnet = { id: ids.subnet(), vpcId: v.id, cidr: `${intToIp(c.base)}/${c.bits}`, az, region: ctx.region, mapPublicIpOnLaunch: false, tags: tagsOf(p.Tags) };
    ctx.s.subnets.push(sub);
    ctx.s.routeTables.find((r) => r.id === v.mainRouteTableId)!.associations.push({ id: `rtbassoc-${hex(17)}`, subnetId: sub.id, main: false });
    return sub;
  });
}

export function describeSubnets(ctx: Ctx, p: { SubnetIds?: string[]; Filters?: { Name: string; Values: string[] }[] } = {}): Subnet[] {
  return trailed(ctx, SRC, 'DescribeSubnets', [], p, () => {
    authorize(ctx, 'ec2:DescribeSubnets', '*');
    ensureDefaultVpc(ctx.s, ctx.region);
    let list = inRegion(ctx, ctx.s.subnets);
    if (p.SubnetIds?.length) {
      p.SubnetIds.forEach((id) => getSubnetOr(ctx, id));
      list = list.filter((x) => p.SubnetIds!.includes(x.id));
    }
    return applyFilters(list, p.Filters, { 'vpc-id': (x) => x.vpcId, 'availability-zone': (x) => x.az, 'cidr-block': (x) => x.cidr, 'subnet-id': (x) => x.id });
  });
}

export function modifySubnetAttribute(ctx: Ctx, p: { SubnetId: string; MapPublicIpOnLaunch: boolean }): void {
  trailed(ctx, SRC, 'ModifySubnetAttribute', [], p, () => {
    const sub = getSubnetOr(ctx, p.SubnetId);
    authorize(ctx, 'ec2:ModifySubnetAttribute', arn(ctx, 'subnet', sub.id));
    sub.mapPublicIpOnLaunch = p.MapPublicIpOnLaunch;
  });
}

export function deleteSubnet(ctx: Ctx, p: { SubnetId: string }): void {
  trailed(ctx, SRC, 'DeleteSubnet', [], p, () => {
    const sub = getSubnetOr(ctx, p.SubnetId);
    authorize(ctx, 'ec2:DeleteSubnet', arn(ctx, 'subnet', sub.id));
    if (ctx.s.instances.some((i) => i.subnetId === sub.id && i.state !== 'terminated')) throw new AwsError('DependencyViolation', `The subnet '${sub.id}' has dependencies and cannot be deleted.`);
    if (ctx.s.natGateways.some((n) => n.subnetId === sub.id && n.state !== 'deleted')) throw new AwsError('DependencyViolation', `The subnet '${sub.id}' has dependencies and cannot be deleted.`);
    ctx.s.routeTables.forEach((r) => (r.associations = r.associations.filter((a) => a.subnetId !== sub.id)));
    ctx.s.subnets = ctx.s.subnets.filter((x) => x !== sub);
  });
}

// ------------------------------------------------------------------ gateways y rutas

export function createInternetGateway(ctx: Ctx, p: { Tags?: any } = {}): InternetGateway {
  return trailed(ctx, SRC, 'CreateInternetGateway', [], p, () => {
    authorize(ctx, 'ec2:CreateInternetGateway', arn(ctx, 'internet-gateway', '*'));
    const g: InternetGateway = { id: ids.igw(), region: ctx.region, tags: tagsOf(p.Tags) };
    ctx.s.internetGateways.push(g);
    return g;
  });
}
export function attachInternetGateway(ctx: Ctx, p: { InternetGatewayId: string; VpcId: string }): void {
  trailed(ctx, SRC, 'AttachInternetGateway', [], p, () => {
    const g = ctx.s.internetGateways.find((x) => x.id === p.InternetGatewayId && x.region === ctx.region);
    if (!g) throw new AwsError('InvalidInternetGatewayID.NotFound', `The internetGateway ID '${p.InternetGatewayId}' does not exist`);
    const v = getVpcOr(ctx, p.VpcId);
    authorize(ctx, 'ec2:AttachInternetGateway', arn(ctx, 'internet-gateway', g.id));
    if (g.attachedVpcId) throw new AwsError('Resource.AlreadyAssociated', `resource ${g.id} is already attached to network ${g.attachedVpcId}`);
    if (ctx.s.internetGateways.some((x) => x.attachedVpcId === v.id)) throw new AwsError('InvalidParameterValue', `Network ${v.id} already has an internet gateway attached`);
    g.attachedVpcId = v.id;
  });
}
export function detachInternetGateway(ctx: Ctx, p: { InternetGatewayId: string; VpcId: string }): void {
  trailed(ctx, SRC, 'DetachInternetGateway', [], p, () => {
    const g = ctx.s.internetGateways.find((x) => x.id === p.InternetGatewayId && x.region === ctx.region);
    if (!g) throw new AwsError('InvalidInternetGatewayID.NotFound', `The internetGateway ID '${p.InternetGatewayId}' does not exist`);
    authorize(ctx, 'ec2:DetachInternetGateway', arn(ctx, 'internet-gateway', g.id));
    if (g.attachedVpcId !== p.VpcId) throw new AwsError('Gateway.NotAttached', `resource ${g.id} is not attached to network ${p.VpcId}`);
    if (ctx.s.instances.some((i) => i.vpcId === p.VpcId && i.publicIp && i.state !== 'terminated')) {
      throw new AwsError('DependencyViolation', `Network ${p.VpcId} has some mapped public address(es). Please unmap those public address(es) before detaching the gateway.`);
    }
    g.attachedVpcId = undefined;
  });
}
export function deleteInternetGateway(ctx: Ctx, p: { InternetGatewayId: string }): void {
  trailed(ctx, SRC, 'DeleteInternetGateway', [], p, () => {
    const g = ctx.s.internetGateways.find((x) => x.id === p.InternetGatewayId && x.region === ctx.region);
    if (!g) throw new AwsError('InvalidInternetGatewayID.NotFound', `The internetGateway ID '${p.InternetGatewayId}' does not exist`);
    authorize(ctx, 'ec2:DeleteInternetGateway', arn(ctx, 'internet-gateway', g.id));
    if (g.attachedVpcId) throw new AwsError('DependencyViolation', `The internetGateway '${g.id}' has dependencies and cannot be deleted.`);
    ctx.s.internetGateways = ctx.s.internetGateways.filter((x) => x !== g);
  });
}
export function describeInternetGateways(ctx: Ctx): InternetGateway[] {
  return trailed(ctx, SRC, 'DescribeInternetGateways', [], {}, () => {
    authorize(ctx, 'ec2:DescribeInternetGateways', '*');
    ensureDefaultVpc(ctx.s, ctx.region);
    return inRegion(ctx, ctx.s.internetGateways);
  });
}

export function createRouteTable(ctx: Ctx, p: { VpcId: string; Tags?: any }): RouteTable {
  return trailed(ctx, SRC, 'CreateRouteTable', [], p, () => {
    const v = getVpcOr(ctx, p.VpcId);
    authorize(ctx, 'ec2:CreateRouteTable', arn(ctx, 'route-table', '*'));
    const rt: RouteTable = { id: ids.rtb(), vpcId: v.id, region: ctx.region, main: false, routes: [{ destination: v.cidr, target: 'local' }], associations: [], tags: tagsOf(p.Tags) };
    ctx.s.routeTables.push(rt);
    return rt;
  });
}
function getRtbOr(ctx: Ctx, id: string): RouteTable {
  const r = ctx.s.routeTables.find((x) => x.id === id && x.region === ctx.region);
  if (!r) throw new AwsError('InvalidRouteTableID.NotFound', `The routeTable ID '${id}' does not exist`);
  return r;
}
export function createRoute(ctx: Ctx, p: { RouteTableId: string; DestinationCidrBlock: string; GatewayId?: string; NatGatewayId?: string }): void {
  trailed(ctx, SRC, 'CreateRoute', [], p, () => {
    const rt = getRtbOr(ctx, p.RouteTableId);
    authorize(ctx, 'ec2:CreateRoute', arn(ctx, 'route-table', rt.id));
    if (!parseCidr(p.DestinationCidrBlock)) throw new AwsError('InvalidParameterValue', `Value (${p.DestinationCidrBlock}) for parameter destinationCidrBlock is invalid. This is not a valid CIDR block.`);
    const target = p.GatewayId ?? p.NatGatewayId;
    if (!target) throw new AwsError('MissingParameter', 'The request must contain either a gateway id, a network interface id, an instance id, a peering connection id or a nat gateway id');
    if (target.startsWith('igw-')) {
      const g = ctx.s.internetGateways.find((x) => x.id === target);
      if (!g) throw new AwsError('InvalidGatewayID.NotFound', `The gateway ID '${target}' does not exist`);
      if (g.attachedVpcId !== rt.vpcId) throw new AwsError('InvalidParameterValue', `route table ${rt.id} and network gateway ${target} belong to different networks`);
    } else if (target.startsWith('nat-')) {
      if (!ctx.s.natGateways.some((x) => x.id === target && x.state !== 'deleted')) throw new AwsError('InvalidNatGatewayID.NotFound', `The natGateway ID '${target}' does not exist`);
    }
    if (rt.routes.some((r) => r.destination === p.DestinationCidrBlock)) throw new AwsError('RouteAlreadyExists', `The route identified by ${p.DestinationCidrBlock} already exists.`);
    rt.routes.push({ destination: p.DestinationCidrBlock, target });
  });
}
export function deleteRoute(ctx: Ctx, p: { RouteTableId: string; DestinationCidrBlock: string }): void {
  trailed(ctx, SRC, 'DeleteRoute', [], p, () => {
    const rt = getRtbOr(ctx, p.RouteTableId);
    authorize(ctx, 'ec2:DeleteRoute', arn(ctx, 'route-table', rt.id));
    const r = rt.routes.find((x) => x.destination === p.DestinationCidrBlock);
    if (!r) throw new AwsError('InvalidRoute.NotFound', `no route with destination-cidr-block ${p.DestinationCidrBlock} in route table ${rt.id}`);
    if (r.target === 'local') throw new AwsError('InvalidParameterValue', 'cannot remove local route');
    rt.routes = rt.routes.filter((x) => x !== r);
  });
}
export function associateRouteTable(ctx: Ctx, p: { RouteTableId: string; SubnetId: string }): string {
  return trailed(ctx, SRC, 'AssociateRouteTable', [], p, () => {
    const rt = getRtbOr(ctx, p.RouteTableId);
    const sub = getSubnetOr(ctx, p.SubnetId);
    authorize(ctx, 'ec2:AssociateRouteTable', arn(ctx, 'route-table', rt.id));
    if (sub.vpcId !== rt.vpcId) throw new AwsError('InvalidParameterValue', `Route table ${rt.id} and subnet ${sub.id} belong to different networks`);
    // La asociación explícita sustituye a la implícita (tabla principal).
    ctx.s.routeTables.forEach((r) => (r.associations = r.associations.filter((a) => a.subnetId !== sub.id)));
    const a = { id: `rtbassoc-${hex(17)}`, subnetId: sub.id, main: false };
    rt.associations.push(a);
    return a.id;
  });
}
export function describeRouteTables(ctx: Ctx, p: { Filters?: { Name: string; Values: string[] }[] } = {}): RouteTable[] {
  return trailed(ctx, SRC, 'DescribeRouteTables', [], p, () => {
    authorize(ctx, 'ec2:DescribeRouteTables', '*');
    ensureDefaultVpc(ctx.s, ctx.region);
    return applyFilters(inRegion(ctx, ctx.s.routeTables), p.Filters, { 'vpc-id': (x) => x.vpcId, 'route-table-id': (x) => x.id });
  });
}

/** Tabla de rutas efectiva de una subred (explícita o la principal de la VPC). */
export function routeTableOfSubnet(s: CloudState, sub: Subnet): RouteTable {
  const explicit = s.routeTables.find((r) => r.associations.some((a) => a.subnetId === sub.id));
  if (explicit) return explicit;
  const vpc = s.vpcs.find((v) => v.id === sub.vpcId)!;
  return s.routeTables.find((r) => r.id === vpc.mainRouteTableId)!;
}

/** Subred pública = su tabla de rutas tiene 0.0.0.0/0 hacia un Internet Gateway adjunto. */
export function isPublicSubnet(s: CloudState, sub: Subnet): boolean {
  const rt = routeTableOfSubnet(s, sub);
  return rt.routes.some((r) => r.destination === '0.0.0.0/0' && r.target.startsWith('igw-') && s.internetGateways.some((g) => g.id === r.target && g.attachedVpcId === sub.vpcId));
}

// ------------------------------------------------------------------ NAT y direcciones

export function allocateAddress(ctx: Ctx) {
  return trailed(ctx, SRC, 'AllocateAddress', [], {}, () => {
    authorize(ctx, 'ec2:AllocateAddress', arn(ctx, 'elastic-ip', '*'));
    const e = { id: ids.eip(), publicIp: `52.${10 + Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`, region: ctx.region, tags: {} as Tags };
    ctx.s.elasticIps.push(e);
    return e;
  });
}
export function releaseAddress(ctx: Ctx, p: { AllocationId: string }): void {
  trailed(ctx, SRC, 'ReleaseAddress', [], p, () => {
    authorize(ctx, 'ec2:ReleaseAddress', arn(ctx, 'elastic-ip', p.AllocationId));
    const e = ctx.s.elasticIps.find((x) => x.id === p.AllocationId && x.region === ctx.region);
    if (!e) throw new AwsError('InvalidAllocationID.NotFound', `The allocation ID '${p.AllocationId}' does not exist`);
    if (e.associatedInstanceId || ctx.s.natGateways.some((n) => n.allocationId === e.id && n.state !== 'deleted')) throw new AwsError('InvalidIPAddress.InUse', `The address '${e.publicIp}' is in use.`);
    ctx.s.elasticIps = ctx.s.elasticIps.filter((x) => x !== e);
  });
}
export function createNatGateway(ctx: Ctx, p: { SubnetId: string; AllocationId: string; Tags?: any }): NatGateway {
  return trailed(ctx, SRC, 'CreateNatGateway', [], p, () => {
    const sub = getSubnetOr(ctx, p.SubnetId);
    authorize(ctx, 'ec2:CreateNatGateway', arn(ctx, 'natgateway', '*'));
    if (!ctx.s.elasticIps.some((e) => e.id === p.AllocationId && e.region === ctx.region)) throw new AwsError('InvalidAllocationID.NotFound', `The allocation ID '${p.AllocationId}' does not exist`);
    if (!isPublicSubnet(ctx.s, sub)) {
      // AWS lo permite, pero el NAT no tendrá salida: se avisa en la práctica como error de diagnóstico, no aquí.
    }
    const n: NatGateway = { id: ids.natgw(), region: ctx.region, subnetId: sub.id, allocationId: p.AllocationId, state: 'available', createdAt: nowIso(), tags: tagsOf(p.Tags) };
    ctx.s.natGateways.push(n);
    return n;
  });
}
export function deleteNatGateway(ctx: Ctx, p: { NatGatewayId: string }): void {
  trailed(ctx, SRC, 'DeleteNatGateway', [], p, () => {
    authorize(ctx, 'ec2:DeleteNatGateway', arn(ctx, 'natgateway', p.NatGatewayId));
    const n = ctx.s.natGateways.find((x) => x.id === p.NatGatewayId && x.region === ctx.region);
    if (!n) throw new AwsError('NatGatewayNotFound', `The Nat Gateway ${p.NatGatewayId} does not exist.`);
    n.state = 'deleted';
  });
}

// ------------------------------------------------------------------ grupos de seguridad

export function createSecurityGroup(ctx: Ctx, p: { GroupName: string; Description: string; VpcId?: string; Tags?: any }): SecurityGroup {
  return trailed(ctx, SRC, 'CreateSecurityGroup', [], p, () => {
    ensureDefaultVpc(ctx.s, ctx.region);
    const vpcId = p.VpcId ?? ctx.s.vpcs.find((v) => v.region === ctx.region && v.isDefault)!.id;
    const v = getVpcOr(ctx, vpcId);
    authorize(ctx, 'ec2:CreateSecurityGroup', arn(ctx, 'security-group', '*'));
    if (!p.Description) throw new AwsError('MissingParameter', 'The request must contain the parameter GroupDescription');
    if (p.GroupName.startsWith('sg-')) throw new AwsError('InvalidParameterValue', 'Group names may not be in the format sg-*');
    if (ctx.s.securityGroups.some((g) => g.vpcId === v.id && g.name === p.GroupName)) throw new AwsError('InvalidGroup.Duplicate', `The security group '${p.GroupName}' already exists for VPC '${v.id}'`);
    const sg: SecurityGroup = {
      id: ids.sg(), name: p.GroupName, description: p.Description, vpcId: v.id, region: ctx.region,
      ingress: [], egress: [{ id: ids.sgRule(), protocol: '-1', from: -1, to: -1, cidr: '0.0.0.0/0' }], tags: tagsOf(p.Tags),
    };
    ctx.s.securityGroups.push(sg);
    return sg;
  });
}

export interface IpPermission {
  IpProtocol: string;
  FromPort?: number;
  ToPort?: number;
  CidrIp?: string;
  SourceSecurityGroupId?: string;
  Description?: string;
}

function toRule(p: IpPermission): SgRule {
  const proto = p.IpProtocol === 'tcp' || p.IpProtocol === 'udp' || p.IpProtocol === 'icmp' || p.IpProtocol === '-1' ? p.IpProtocol : p.IpProtocol;
  if (proto !== '-1' && proto !== 'icmp' && (p.FromPort === undefined || p.ToPort === undefined)) throw new AwsError('MissingParameter', 'The request must contain the parameter ipPermissions');
  if (p.CidrIp && !parseCidr(p.CidrIp)) throw new AwsError('InvalidParameterValue', `Invalid CIDR block ${p.CidrIp}`);
  return { id: ids.sgRule(), protocol: proto, from: proto === '-1' ? -1 : p.FromPort ?? -1, to: proto === '-1' ? -1 : p.ToPort ?? -1, cidr: p.CidrIp, sourceSg: p.SourceSecurityGroupId, description: p.Description };
}
const sameRule = (a: SgRule, b: SgRule) => a.protocol === b.protocol && a.from === b.from && a.to === b.to && a.cidr === b.cidr && a.sourceSg === b.sourceSg;

export function authorizeSecurityGroupIngress(ctx: Ctx, p: { GroupId: string; IpPermissions: IpPermission[] }) {
  return trailed(ctx, SRC, 'AuthorizeSecurityGroupIngress', [], p, () => {
    const sg = getSgOr(ctx, p.GroupId);
    authorize(ctx, 'ec2:AuthorizeSecurityGroupIngress', arn(ctx, 'security-group', sg.id));
    const rules = p.IpPermissions.map(toRule);
    for (const r of rules) {
      if (sg.ingress.some((x) => sameRule(x, r))) throw new AwsError('InvalidPermission.Duplicate', 'the specified rule "peer: ' + (r.cidr ?? r.sourceSg) + ', ' + r.protocol.toUpperCase() + ', from port: ' + r.from + ', to port: ' + r.to + ', ALLOW" already exists');
    }
    sg.ingress.push(...rules);
    return rules;
  });
}
export function authorizeSecurityGroupEgress(ctx: Ctx, p: { GroupId: string; IpPermissions: IpPermission[] }) {
  return trailed(ctx, SRC, 'AuthorizeSecurityGroupEgress', [], p, () => {
    const sg = getSgOr(ctx, p.GroupId);
    authorize(ctx, 'ec2:AuthorizeSecurityGroupEgress', arn(ctx, 'security-group', sg.id));
    const rules = p.IpPermissions.map(toRule);
    for (const r of rules) if (sg.egress.some((x) => sameRule(x, r))) throw new AwsError('InvalidPermission.Duplicate', 'the specified rule already exists');
    sg.egress.push(...rules);
    return rules;
  });
}
export function revokeSecurityGroupIngress(ctx: Ctx, p: { GroupId: string; IpPermissions: IpPermission[] }): void {
  trailed(ctx, SRC, 'RevokeSecurityGroupIngress', [], p, () => {
    const sg = getSgOr(ctx, p.GroupId);
    authorize(ctx, 'ec2:RevokeSecurityGroupIngress', arn(ctx, 'security-group', sg.id));
    for (const perm of p.IpPermissions) {
      const r = toRule(perm);
      const hit = sg.ingress.find((x) => sameRule(x, r));
      if (!hit) throw new AwsError('InvalidPermission.NotFound', 'The specified rule does not exist in this security group.');
      sg.ingress = sg.ingress.filter((x) => x !== hit);
    }
  });
}
export function revokeSecurityGroupEgress(ctx: Ctx, p: { GroupId: string; IpPermissions: IpPermission[] }): void {
  trailed(ctx, SRC, 'RevokeSecurityGroupEgress', [], p, () => {
    const sg = getSgOr(ctx, p.GroupId);
    authorize(ctx, 'ec2:RevokeSecurityGroupEgress', arn(ctx, 'security-group', sg.id));
    for (const perm of p.IpPermissions) {
      const r = toRule(perm);
      const hit = sg.egress.find((x) => sameRule(x, r));
      if (!hit) throw new AwsError('InvalidPermission.NotFound', 'The specified rule does not exist in this security group.');
      sg.egress = sg.egress.filter((x) => x !== hit);
    }
  });
}
export function deleteSecurityGroup(ctx: Ctx, p: { GroupId: string }): void {
  trailed(ctx, SRC, 'DeleteSecurityGroup', [], p, () => {
    const sg = getSgOr(ctx, p.GroupId);
    authorize(ctx, 'ec2:DeleteSecurityGroup', arn(ctx, 'security-group', sg.id));
    if (sg.name === 'default') throw new AwsError('CannotDelete', 'the specified group: "' + sg.id + '" name: "default" cannot be deleted by a user');
    if (ctx.s.instances.some((i) => i.securityGroupIds.includes(sg.id) && i.state !== 'terminated')) throw new AwsError('DependencyViolation', `resource ${sg.id} has a dependent object`);
    if (ctx.s.securityGroups.some((g) => g !== sg && [...g.ingress, ...g.egress].some((r) => r.sourceSg === sg.id))) throw new AwsError('DependencyViolation', `resource ${sg.id} has a dependent object`);
    ctx.s.securityGroups = ctx.s.securityGroups.filter((g) => g !== sg);
  });
}
export function describeSecurityGroups(ctx: Ctx, p: { GroupIds?: string[]; Filters?: { Name: string; Values: string[] }[] } = {}): SecurityGroup[] {
  return trailed(ctx, SRC, 'DescribeSecurityGroups', [], p, () => {
    authorize(ctx, 'ec2:DescribeSecurityGroups', '*');
    ensureDefaultVpc(ctx.s, ctx.region);
    let list = inRegion(ctx, ctx.s.securityGroups);
    if (p.GroupIds?.length) {
      p.GroupIds.forEach((id) => getSgOr(ctx, id));
      list = list.filter((g) => p.GroupIds!.includes(g.id));
    }
    return applyFilters(list, p.Filters, { 'vpc-id': (x) => x.vpcId, 'group-name': (x) => x.name, 'group-id': (x) => x.id });
  });
}

// ------------------------------------------------------------------ instancias

/** Resuelve las transiciones de estado vencidas (pending→running, stopping→stopped, shutting-down→terminated). */
export const settleHooks: ((s: CloudState) => void)[] = [];
let settling = false;
export function settle(s: CloudState) {
  settleCore(s);
  if (settling) return;
  settling = true;
  try { for (const h of settleHooks) h(s); } finally { settling = false; }
}
function settleCore(s: CloudState) {
  const t = now();
  for (const i of s.instances) {
    if (i.transition && i.transition.at <= t) {
      const to = i.transition.to;
      const at = i.transition.at; // el estado cambió en ese instante, no cuando alguien lo consulta
      i.state = to;
      i.transition = undefined;
      if (to === 'running') i.runningSince = at;
      if (to === 'stopped' || to === 'terminated') {
        if (i.runningSince) { i.billedMs += at - i.runningSince; (i.runPeriods ??= []).push({ from: i.runningSince, to: at }); }
        i.runningSince = undefined;
        if (to === 'stopped') i.publicIp = i.publicIp && s.elasticIps.some((e) => e.publicIp === i.publicIp) ? i.publicIp : undefined;
        if (to === 'terminated') {
          i.publicIp = undefined;
          s.volumes.filter((v) => v.attachedTo === i.id && v.deleteOnTermination).forEach((v) => (s.volumes = s.volumes.filter((x) => x !== v)));
          // Los volúmenes que no se borran con la instancia quedan disponibles.
          s.volumes.filter((v) => v.attachedTo === i.id).forEach((v) => { v.attachedTo = undefined; v.device = undefined; v.state = 'available'; });
        }
      }
    }
  }
}

function schedule(i: Instance, to: Instance['state'], ms: number) {
  const f = speedFactor();
  if (f === 0) {
    i.transition = { to, at: now() };
  } else i.transition = { to, at: now() + ms * f };
}

const publicIpFor = () => `3.${20 + Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

function nextPrivateIp(s: CloudState, sub: Subnet): string {
  const c = parseCidr(sub.cidr)!;
  const used = new Set(s.instances.filter((i) => i.subnetId === sub.id && i.state !== 'terminated').map((i) => i.privateIp));
  for (let n = 4; n < 2 ** (32 - c.bits) - 1; n++) {
    const ip = intToIp(c.base + n);
    if (!used.has(ip)) return ip;
  }
  throw new AwsError('InsufficientFreeAddressesInSubnet', 'There are not enough free addresses in subnet to satisfy the requested number of instances.');
}

export function runInstances(ctx: Ctx, p: {
  ImageId: string; InstanceType?: string; KeyName?: string; SubnetId?: string; SecurityGroupIds?: string[]; MinCount?: number; MaxCount?: number;
  IamInstanceProfile?: string; UserData?: string; AssociatePublicIpAddress?: boolean; Tags?: any; HttpTokens?: 'optional' | 'required';
  VolumeSize?: number; Encrypted?: boolean;
}): Instance[] {
  const created: { type: string; name: string }[] = [];
  return trailed(ctx, SRC, 'RunInstances', created, { ImageId: p.ImageId, InstanceType: p.InstanceType }, () => {
    checkRegion(ctx);
    ensureDefaultVpc(ctx.s, ctx.region);
    authorize(ctx, 'ec2:RunInstances', arn(ctx, 'instance', '*'));
    if (!AMIS.some((a) => a.id === p.ImageId)) throw new AwsError('InvalidAMIID.NotFound', `The image id '[${p.ImageId}]' does not exist`);
    const type = p.InstanceType ?? 't3.micro';
    if (!INSTANCE_TYPES[type]) throw new AwsError('InvalidParameterValue', `The instance type '${type}' is not supported in the requested availability zone.`);
    const sub = p.SubnetId ? getSubnetOr(ctx, p.SubnetId) : ctx.s.subnets.find((x) => x.region === ctx.region && ctx.s.vpcs.find((v) => v.id === x.vpcId)?.isDefault)!;
    const vpc = ctx.s.vpcs.find((v) => v.id === sub.vpcId)!;
    const sgIds = p.SecurityGroupIds?.length ? p.SecurityGroupIds : [vpc.defaultSecurityGroupId];
    for (const id of sgIds) {
      const g = getSgOr(ctx, id);
      if (g.vpcId !== vpc.id) throw new AwsError('InvalidParameter', `Security group ${id} and subnet ${sub.id} belong to different networks.`);
    }
    if (p.KeyName && !ctx.s.keyPairs.some((k) => k.name === p.KeyName && k.region === ctx.region)) throw new AwsError('InvalidKeyPair.NotFound', `The key pair '${p.KeyName}' does not exist`);
    if (p.IamInstanceProfile && !ctx.s.instanceProfiles.some((ip) => ip.name === p.IamInstanceProfile)) throw new AwsError('InvalidParameterValue', `Value (${p.IamInstanceProfile}) for parameter iamInstanceProfile.name is invalid. Invalid IAM Instance Profile name`);
    const count = p.MaxCount ?? p.MinCount ?? 1;
    const out: Instance[] = [];
    for (let n = 0; n < count; n++) {
      const iid = ids.instance();
      const vol: EbsVolume = { id: ids.volume(), region: ctx.region, az: sub.az, sizeGiB: p.VolumeSize ?? 8, type: 'gp3', encrypted: p.Encrypted ?? false, state: 'in-use', attachedTo: iid, deleteOnTermination: true, createdAt: nowIso(), tags: {} };
      ctx.s.volumes.push(vol);
      const wantsPublic = p.AssociatePublicIpAddress ?? sub.mapPublicIpOnLaunch;
      const inst: Instance = {
        id: iid, region: ctx.region, az: sub.az, type, imageId: p.ImageId, state: 'pending', subnetId: sub.id, vpcId: vpc.id,
        securityGroupIds: sgIds, privateIp: nextPrivateIp(ctx.s, sub), publicIp: wantsPublic ? publicIpFor() : undefined,
        keyName: p.KeyName, iamInstanceProfile: p.IamInstanceProfile, userData: p.UserData, rootVolumeId: vol.id,
        httpTokens: p.HttpTokens ?? 'optional', launchTime: nowIso(), billedMs: 0, tags: tagsOf(p.Tags),
      };
      schedule(inst, 'running', 8000);
      ctx.s.instances.push(inst);
      out.push(inst);
      created.push({ type: 'AWS::EC2::Instance', name: iid });
    }
    settle(ctx.s);
    return out;
  });
}

export function describeInstances(ctx: Ctx, p: { InstanceIds?: string[]; Filters?: { Name: string; Values: string[] }[] } = {}): Instance[] {
  return trailed(ctx, SRC, 'DescribeInstances', [], p, () => {
    authorize(ctx, 'ec2:DescribeInstances', '*');
    settle(ctx.s);
    let list = inRegion(ctx, ctx.s.instances);
    if (p.InstanceIds?.length) {
      p.InstanceIds.forEach((id) => getInstanceOr(ctx, id));
      list = list.filter((i) => p.InstanceIds!.includes(i.id));
    }
    return applyFilters(list, p.Filters, {
      'instance-state-name': (x) => x.state, 'instance-type': (x) => x.type, 'vpc-id': (x) => x.vpcId, 'subnet-id': (x) => x.subnetId,
    });
  });
}

function change(ctx: Ctx, ids_: string[], op: string, action: string, from: Instance['state'][], via: Instance['state'], to: Instance['state'], ms: number) {
  return trailed(ctx, SRC, op, [], { InstanceIds: ids_ }, () => {
    const res: { id: string; previous: string; current: string }[] = [];
    for (const id of ids_) {
      const i = getInstanceOr(ctx, id);
      authorize(ctx, action, arn(ctx, 'instance', i.id), { context: { 'ec2:ResourceTag/Name': i.tags.Name } });
      const prev = i.state;
      if (!from.includes(i.state)) {
        if (op === 'StopInstances' && i.state === 'stopped') {
          res.push({ id, previous: prev, current: prev });
          continue;
        }
        throw new AwsError('IncorrectInstanceState', `The instance '${id}' is not in a state from which it can be ${op === 'StartInstances' ? 'started' : op === 'StopInstances' ? 'stopped' : 'terminated'}.`);
      }
      if (op === 'StartInstances') {
        i.state = 'pending';
        i.publicIp = i.publicIp ?? (ctx.s.subnets.find((x) => x.id === i.subnetId)?.mapPublicIpOnLaunch ? publicIpFor() : undefined);
      } else i.state = via;
      if (op !== 'StartInstances' && i.runningSince) {
        i.billedMs += now() - i.runningSince;
        (i.runPeriods ??= []).push({ from: i.runningSince, to: now() });
        i.runningSince = undefined;
      }
      schedule(i, to, ms);
      res.push({ id, previous: prev, current: i.state });
    }
    settle(ctx.s);
    return res;
  });
}
export const stopInstances = (ctx: Ctx, p: { InstanceIds: string[] }) => change(ctx, p.InstanceIds, 'StopInstances', 'ec2:StopInstances', ['running', 'pending'], 'stopping', 'stopped', 5000);
export const startInstances = (ctx: Ctx, p: { InstanceIds: string[] }) => change(ctx, p.InstanceIds, 'StartInstances', 'ec2:StartInstances', ['stopped'], 'pending', 'running', 6000);
export const terminateInstances = (ctx: Ctx, p: { InstanceIds: string[] }) => change(ctx, p.InstanceIds, 'TerminateInstances', 'ec2:TerminateInstances', ['running', 'pending', 'stopped', 'stopping'], 'shutting-down', 'terminated', 6000);

export function modifyInstanceMetadataOptions(ctx: Ctx, p: { InstanceId: string; HttpTokens: 'optional' | 'required' }): void {
  trailed(ctx, SRC, 'ModifyInstanceMetadataOptions', [], p, () => {
    const i = getInstanceOr(ctx, p.InstanceId);
    authorize(ctx, 'ec2:ModifyInstanceMetadataOptions', arn(ctx, 'instance', i.id));
    i.httpTokens = p.HttpTokens;
  });
}

export function createTags(ctx: Ctx, p: { Resources: string[]; Tags: { Key: string; Value: string }[] }): void {
  trailed(ctx, SRC, 'CreateTags', [], p, () => {
    authorize(ctx, 'ec2:CreateTags', '*');
    for (const id of p.Resources) {
      const all: { id: string; tags: Tags }[] = [...ctx.s.instances, ...ctx.s.vpcs, ...ctx.s.subnets, ...ctx.s.securityGroups, ...ctx.s.routeTables, ...ctx.s.internetGateways, ...ctx.s.volumes];
      const r = all.find((x) => x.id === id);
      if (!r) throw new AwsError('InvalidID', `The ID '${id}' is not valid`);
      for (const t of p.Tags) r.tags[t.Key] = t.Value;
    }
  });
}

export function createKeyPair(ctx: Ctx, p: { KeyName: string }) {
  return trailed(ctx, SRC, 'CreateKeyPair', [], p, () => {
    authorize(ctx, 'ec2:CreateKeyPair', arn(ctx, 'key-pair', '*'));
    if (ctx.s.keyPairs.some((k) => k.name === p.KeyName && k.region === ctx.region)) throw new AwsError('InvalidKeyPair.Duplicate', `The keypair '${p.KeyName}' already exists.`);
    const k = { id: ids.keyPair(), name: p.KeyName, region: ctx.region, fingerprint: Array.from({ length: 20 }, () => hex(2)).join(':'), createdAt: nowIso() };
    ctx.s.keyPairs.push(k);
    return { ...k, material: `-----BEGIN RSA PRIVATE KEY-----\n${hex(64)}\n${hex(64)}\n-----END RSA PRIVATE KEY-----` };
  });
}

export function describeImages(ctx: Ctx) {
  return trailed(ctx, SRC, 'DescribeImages', [], {}, () => {
    authorize(ctx, 'ec2:DescribeImages', '*');
    return AMIS;
  });
}

export function describeAvailabilityZones(ctx: Ctx) {
  return trailed(ctx, SRC, 'DescribeAvailabilityZones', [], {}, () => {
    authorize(ctx, 'ec2:DescribeAvailabilityZones', '*');
    checkRegion(ctx);
    return azsOf(ctx.region);
  });
}

// ------------------------------------------------------------------ diagnóstico de conectividad

export interface Reach {
  ok: boolean;
  reason: string;
}

/** ¿Puede una IP externa llegar a la instancia por TCP al puerto? Comprueba IP pública, IGW/ruta, NACL y SG. */
export function reachableFromInternet(s: CloudState, inst: Instance, port: number, srcIp = '203.0.113.50'): Reach {
  settle(s);
  if (inst.state !== 'running') return { ok: false, reason: `La instancia está en estado ${inst.state}.` };
  if (!inst.publicIp) return { ok: false, reason: 'La instancia no tiene IP pública (ni Elastic IP).' };
  const sub = s.subnets.find((x) => x.id === inst.subnetId)!;
  if (!isPublicSubnet(s, sub)) return { ok: false, reason: 'La subred no tiene ruta 0.0.0.0/0 hacia un Internet Gateway adjunto.' };
  const acl = s.networkAcls.find((a) => a.associations.includes(sub.id)) ?? s.networkAcls.find((a) => a.vpcId === sub.vpcId && a.isDefault)!;
  const inEntries = acl.entries.filter((e) => !e.egress).sort((a, b) => a.rule - b.rule);
  const hit = inEntries.find((e) => cidrContains(e.cidr, srcIp) && (e.protocol === '-1' || (e.protocol === 'tcp' && (e.from ?? 0) <= port && port <= (e.to ?? 65535))));
  if (hit && hit.action === 'deny') return { ok: false, reason: `La NACL ${acl.id} deniega el tráfico (regla ${hit.rule}).` };
  if (!hit) return { ok: false, reason: `La NACL ${acl.id} no permite el tráfico de entrada (denegación por defecto).` };
  const allowed = inst.securityGroupIds.some((id) => s.securityGroups.find((g) => g.id === id)?.ingress.some((r) => r.cidr && cidrContains(r.cidr, srcIp) && (r.protocol === '-1' || (r.protocol === 'tcp' && r.from <= port && port <= r.to))));
  if (!allowed) return { ok: false, reason: `Ningún grupo de seguridad permite TCP/${port} desde ${srcIp}.` };
  return { ok: true, reason: 'Alcanzable.' };
}

/** ¿Puede la instancia salir a Internet? Necesita ruta a IGW (con IP pública) o a un NAT, y egress permitido. */
export function canReachInternet(s: CloudState, inst: Instance): Reach {
  settle(s);
  if (inst.state !== 'running') return { ok: false, reason: `La instancia está en estado ${inst.state}.` };
  const sub = s.subnets.find((x) => x.id === inst.subnetId)!;
  const rt = routeTableOfSubnet(s, sub);
  const def = rt.routes.find((r) => r.destination === '0.0.0.0/0');
  if (!def) return { ok: false, reason: 'No hay ruta por defecto (0.0.0.0/0) en la tabla de rutas.' };
  const egress = inst.securityGroupIds.some((id) => s.securityGroups.find((g) => g.id === id)?.egress.some((r) => r.protocol === '-1' || (r.protocol === 'tcp' && r.from <= 443 && 443 <= r.to)));
  if (!egress) return { ok: false, reason: 'Los grupos de seguridad no permiten tráfico de salida.' };
  if (def.target.startsWith('igw-')) {
    if (!inst.publicIp) return { ok: false, reason: 'La ruta apunta al Internet Gateway pero la instancia no tiene IP pública.' };
    const g = s.internetGateways.find((x) => x.id === def.target);
    if (!g?.attachedVpcId) return { ok: false, reason: 'El Internet Gateway no está adjunto a la VPC.' };
    return { ok: true, reason: 'Sale por el Internet Gateway.' };
  }
  if (def.target.startsWith('nat-')) {
    const n = s.natGateways.find((x) => x.id === def.target && x.state === 'available');
    if (!n) return { ok: false, reason: 'El NAT Gateway no está disponible.' };
    const natSub = s.subnets.find((x) => x.id === n.subnetId)!;
    if (!isPublicSubnet(s, natSub)) return { ok: false, reason: 'El NAT Gateway está en una subred sin salida a Internet; debe estar en una subred pública.' };
    return { ok: true, reason: 'Sale por el NAT Gateway.' };
  }
  return { ok: false, reason: `Destino de ruta no soportado: ${def.target}.` };
}

// ---------------------------------------------------------------- Operaciones complementarias
export function describeKeyPairs(ctx: Ctx, p: { KeyNames?: string[] } = {}) {
  return trailed(ctx, SRC, 'DescribeKeyPairs', [], p, () => {
    authorize(ctx, 'ec2:DescribeKeyPairs', '*');
    const list = ctx.s.keyPairs.filter((k) => k.region === ctx.region);
    for (const n of p.KeyNames ?? []) if (!list.some((k) => k.name === n)) throw new AwsError('InvalidKeyPair.NotFound', `The key pair '${n}' does not exist`);
    return p.KeyNames?.length ? list.filter((k) => p.KeyNames!.includes(k.name)) : list;
  });
}
export function deleteKeyPair(ctx: Ctx, p: { KeyName: string }): void {
  trailed(ctx, SRC, 'DeleteKeyPair', [], p, () => {
    authorize(ctx, 'ec2:DeleteKeyPair', arn(ctx, 'key-pair', '*'));
    // Como en AWS, borrar una clave que no existe no es un error.
    ctx.s.keyPairs = ctx.s.keyPairs.filter((k) => !(k.name === p.KeyName && k.region === ctx.region));
  });
}
export function deleteTags(ctx: Ctx, p: { Resources: string[]; Tags?: { Key: string; Value?: string }[] }): void {
  trailed(ctx, SRC, 'DeleteTags', [], p, () => {
    authorize(ctx, 'ec2:DeleteTags', '*');
    for (const id of p.Resources) {
      const all: { id: string; tags: Tags }[] = [...ctx.s.instances, ...ctx.s.vpcs, ...ctx.s.subnets, ...ctx.s.securityGroups, ...ctx.s.routeTables, ...ctx.s.internetGateways, ...ctx.s.volumes];
      const r = all.find((x) => x.id === id);
      if (!r) throw new AwsError('InvalidID', `The ID '${id}' is not valid`);
      if (!p.Tags?.length) r.tags = {};
      else for (const t of p.Tags) if (t.Value === undefined || t.Value === '' || r.tags[t.Key] === t.Value) delete r.tags[t.Key];
    }
  });
}
export function rebootInstances(ctx: Ctx, p: { InstanceIds: string[] }): void {
  trailed(ctx, SRC, 'RebootInstances', [], p, () => {
    for (const id of p.InstanceIds) {
      const i = getInstanceOr(ctx, id);
      authorize(ctx, 'ec2:RebootInstances', arn(ctx, 'instance', i.id), { context: { 'ec2:ResourceTag/Name': i.tags.Name } });
      settle(ctx.s);
      if (i.state !== 'running') throw new AwsError('IncorrectInstanceState', `The instance '${id}' is not in a state from which it can be rebooted.`);
    }
  });
}
export function describeNatGateways(ctx: Ctx) {
  return trailed(ctx, SRC, 'DescribeNatGateways', [], {}, () => {
    authorize(ctx, 'ec2:DescribeNatGateways', '*');
    return ctx.s.natGateways.filter((n) => n.region === ctx.region);
  });
}
export function describeAddresses(ctx: Ctx) {
  return trailed(ctx, SRC, 'DescribeAddresses', [], {}, () => {
    authorize(ctx, 'ec2:DescribeAddresses', '*');
    return ctx.s.elasticIps.filter((e) => e.region === ctx.region);
  });
}
export function deleteRouteTable(ctx: Ctx, p: { RouteTableId: string }): void {
  trailed(ctx, SRC, 'DeleteRouteTable', [], p, () => {
    const rt = getRtbOr(ctx, p.RouteTableId);
    authorize(ctx, 'ec2:DeleteRouteTable', arn(ctx, 'route-table', rt.id));
    if (rt.main) throw new AwsError('DependencyViolation', `The routeTable '${rt.id}' has dependencies and cannot be deleted.`);
    if (rt.associations.length) throw new AwsError('DependencyViolation', `The routeTable '${rt.id}' has dependencies and cannot be deleted.`);
    ctx.s.routeTables = ctx.s.routeTables.filter((r) => r !== rt);
  });
}
export function disassociateRouteTable(ctx: Ctx, p: { AssociationId: string }): void {
  trailed(ctx, SRC, 'DisassociateRouteTable', [], p, () => {
    authorize(ctx, 'ec2:DisassociateRouteTable', '*');
    const rt = ctx.s.routeTables.find((r) => r.region === ctx.region && r.associations.some((a) => a.id === p.AssociationId));
    if (!rt) throw new AwsError('InvalidAssociationID.NotFound', `The association ID '${p.AssociationId}' does not exist`);
    const a = rt.associations.find((x) => x.id === p.AssociationId)!;
    if (a.main) throw new AwsError('InvalidParameterValue', 'Cannot disassociate the main route table association');
    rt.associations = rt.associations.filter((x) => x !== a);
  });
}

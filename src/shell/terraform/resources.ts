// Tipos de recurso de Terraform soportados y su vínculo con el motor de la nube simulada (los mismos servicios que usa `aws`).
import type { Ctx } from '../../engine/api';
import { AwsError } from '../../engine/errors';
import * as ec2 from '../../engine/services/ec2';
import * as s3 from '../../engine/services/s3';
import * as s3x from '../../engine/services/s3Extra';
import * as iam from '../../engine/services/iam';
import * as iamx from '../../engine/services/iamExtra';
import * as kms from '../../engine/services/kms';
import * as ct from '../../engine/services/cloudtrail';
import { hex, now } from '../../engine/util';
import { AMIS } from '../../engine/catalog';

export type Attrs = Record<string, any>;
export interface Env { ctx: Ctx }

export class TfApiError extends Error {
  constructor(public service: string, public op: string, public code: string, public msg: string, public status: number) {
    super(msg);
  }
}

/** Ejecuta una llamada al motor y convierte sus errores al formato del proveedor de AWS. */
function w<T>(service: string, op: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof AwsError) throw new TfApiError(service, op, e.code, e.message, e.status ?? 400);
    throw e;
  }
}

export interface BlockSchema { args: Record<string, boolean>; blocks?: Record<string, BlockSchema> }
export interface RType {
  noun: string;
  args: Record<string, boolean>;
  blocks: Record<string, BlockSchema>;
  computed: string[];
  forceNew: string[];
  defaults?: Attrs;
  create(e: Env, a: Attrs): Attrs;
  read(e: Env, st: Attrs): Attrs | null;
  update(e: Env, st: Attrs, a: Attrs): Attrs;
  destroy(e: Env, st: Attrs): void;
  /** Atributos que no se comparan con la nube (p. ej. force_destroy). */
  local?: string[];
}

const acct = (e: Env) => e.ctx.s.account.id;
const region = (e: Env) => e.ctx.region;
const tagList = (t?: Record<string, string>) => Object.entries(t ?? {}).map(([Key, Value]) => ({ Key, Value }));
const canon = (v: any): any => (typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v);
export const sameJson = (a: any, b: any) => JSON.stringify(sortKeys(canon(a))) === JSON.stringify(sortKeys(canon(b)));
function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

function syncTags(e: Env, id: string, old: Record<string, string> = {}, nu: Record<string, string> = {}) {
  const gone = Object.keys(old).filter((k) => !(k in nu));
  if (gone.length) w('EC2', 'DeleteTags', () => ec2.deleteTags(e.ctx, { Resources: [id], Tags: gone.map((Key) => ({ Key })) }));
  const add = Object.entries(nu).filter(([k, v]) => old[k] !== v);
  if (add.length) w('EC2', 'CreateTags', () => ec2.createTags(e.ctx, { Resources: [id], Tags: add.map(([Key, Value]) => ({ Key, Value })) }));
}
const withTagsAll = (a: Attrs): Attrs => (a.tags && Object.keys(a.tags).length ? { ...a, tags_all: { ...a.tags } } : a);

const REG: Record<string, RType> = {};
const def = (name: string, t: RType) => { REG[name] = t; };
export const typeOf = (name: string): RType | undefined => REG[name];
export const typeNames = () => Object.keys(REG);

// ------------------------------------------------------------------ VPC y redes

def('aws_vpc', {
  noun: 'EC2 VPC',
  args: { cidr_block: true, enable_dns_hostnames: false, enable_dns_support: false, instance_tenancy: false, tags: false },
  blocks: {},
  computed: ['arn', 'default_network_acl_id', 'default_route_table_id', 'default_security_group_id', 'id', 'main_route_table_id', 'owner_id'],
  forceNew: ['cidr_block', 'instance_tenancy'],
  defaults: { enable_dns_hostnames: false, enable_dns_support: true, instance_tenancy: 'default' },
  create(e, a) {
    const v = w('EC2', 'CreateVpc', () => ec2.createVpc(e.ctx, { CidrBlock: a.cidr_block, Tags: tagList(a.tags) }));
    if (a.enable_dns_hostnames || a.enable_dns_support === false) w('EC2', 'ModifyVpcAttribute', () => ec2.modifyVpcAttribute(e.ctx, { VpcId: v.id, EnableDnsHostnames: !!a.enable_dns_hostnames, EnableDnsSupport: a.enable_dns_support !== false }));
    return withTagsAll({ ...this.defaults, ...a, id: v.id, arn: `arn:aws:ec2:${region(e)}:${acct(e)}:vpc/${v.id}`, default_network_acl_id: v.defaultNetworkAclId, default_route_table_id: v.mainRouteTableId, default_security_group_id: v.defaultSecurityGroupId, main_route_table_id: v.mainRouteTableId, owner_id: acct(e), enable_dns_support: a.enable_dns_support !== false });
  },
  read(e, st) {
    const v = e.ctx.s.vpcs.find((x) => x.id === st.id);
    if (!v) return null;
    return { cidr_block: v.cidr, enable_dns_hostnames: v.dnsHostnames, enable_dns_support: v.dnsSupport, tags: { ...v.tags } };
  },
  update(e, st, a) {
    if (a.enable_dns_hostnames !== st.enable_dns_hostnames || a.enable_dns_support !== st.enable_dns_support) w('EC2', 'ModifyVpcAttribute', () => ec2.modifyVpcAttribute(e.ctx, { VpcId: st.id, EnableDnsHostnames: !!a.enable_dns_hostnames, EnableDnsSupport: a.enable_dns_support !== false }));
    syncTags(e, st.id, st.tags, a.tags);
    return withTagsAll({ ...st, ...a, tags_all: undefined });
  },
  destroy(e, st) { w('EC2', 'DeleteVpc', () => ec2.deleteVpc(e.ctx, { VpcId: st.id })); },
});

def('aws_subnet', {
  noun: 'EC2 Subnet',
  args: { vpc_id: true, cidr_block: false, availability_zone: false, map_public_ip_on_launch: false, tags: false },
  blocks: {},
  computed: ['arn', 'availability_zone', 'id', 'owner_id'],
  forceNew: ['vpc_id', 'cidr_block', 'availability_zone'],
  defaults: { map_public_ip_on_launch: false },
  create(e, a) {
    const s = w('EC2', 'CreateSubnet', () => ec2.createSubnet(e.ctx, { VpcId: a.vpc_id, CidrBlock: a.cidr_block, AvailabilityZone: a.availability_zone, Tags: tagList(a.tags) }));
    if (a.map_public_ip_on_launch) w('EC2', 'ModifySubnetAttribute', () => ec2.modifySubnetAttribute(e.ctx, { SubnetId: s.id, MapPublicIpOnLaunch: true }));
    return withTagsAll({ ...this.defaults, ...a, id: s.id, arn: `arn:aws:ec2:${region(e)}:${acct(e)}:subnet/${s.id}`, availability_zone: s.az, owner_id: acct(e) });
  },
  read(e, st) {
    const s = e.ctx.s.subnets.find((x) => x.id === st.id);
    if (!s) return null;
    return { cidr_block: s.cidr, availability_zone: s.az, map_public_ip_on_launch: s.mapPublicIpOnLaunch, tags: { ...s.tags } };
  },
  update(e, st, a) {
    if (a.map_public_ip_on_launch !== st.map_public_ip_on_launch) w('EC2', 'ModifySubnetAttribute', () => ec2.modifySubnetAttribute(e.ctx, { SubnetId: st.id, MapPublicIpOnLaunch: !!a.map_public_ip_on_launch }));
    syncTags(e, st.id, st.tags, a.tags);
    return withTagsAll({ ...st, ...a, tags_all: undefined });
  },
  destroy(e, st) { w('EC2', 'DeleteSubnet', () => ec2.deleteSubnet(e.ctx, { SubnetId: st.id })); },
});

def('aws_internet_gateway', {
  noun: 'EC2 Internet Gateway',
  args: { vpc_id: false, tags: false },
  blocks: {},
  computed: ['arn', 'id', 'owner_id'],
  forceNew: [],
  create(e, a) {
    const g = w('EC2', 'CreateInternetGateway', () => ec2.createInternetGateway(e.ctx, { Tags: tagList(a.tags) }));
    if (a.vpc_id) w('EC2', 'AttachInternetGateway', () => ec2.attachInternetGateway(e.ctx, { InternetGatewayId: g.id, VpcId: a.vpc_id }));
    return withTagsAll({ ...a, id: g.id, arn: `arn:aws:ec2:${region(e)}:${acct(e)}:internet-gateway/${g.id}`, owner_id: acct(e) });
  },
  read(e, st) {
    const g = e.ctx.s.internetGateways.find((x) => x.id === st.id);
    if (!g) return null;
    return { vpc_id: g.attachedVpcId, tags: { ...g.tags } };
  },
  update(e, st, a) {
    if (a.vpc_id !== st.vpc_id) {
      if (st.vpc_id) w('EC2', 'DetachInternetGateway', () => ec2.detachInternetGateway(e.ctx, { InternetGatewayId: st.id, VpcId: st.vpc_id }));
      if (a.vpc_id) w('EC2', 'AttachInternetGateway', () => ec2.attachInternetGateway(e.ctx, { InternetGatewayId: st.id, VpcId: a.vpc_id }));
    }
    syncTags(e, st.id, st.tags, a.tags);
    return withTagsAll({ ...st, ...a, tags_all: undefined });
  },
  destroy(e, st) {
    if (st.vpc_id) w('EC2', 'DetachInternetGateway', () => ec2.detachInternetGateway(e.ctx, { InternetGatewayId: st.id, VpcId: st.vpc_id }));
    w('EC2', 'DeleteInternetGateway', () => ec2.deleteInternetGateway(e.ctx, { InternetGatewayId: st.id }));
  },
});

const routeKey = (r: Attrs) => `${r.cidr_block}>${r.gateway_id ?? r.nat_gateway_id ?? ''}`;
const normRoutes = (l: Attrs[] = []) => l.map((r) => ({ cidr_block: r.cidr_block, ...(r.nat_gateway_id ? { nat_gateway_id: r.nat_gateway_id } : { gateway_id: r.gateway_id }) })).sort((a, b) => routeKey(a).localeCompare(routeKey(b)));
function applyRoutes(e: Env, rtId: string, want: Attrs[], have: Attrs[]) {
  const wk = new Set(want.map(routeKey)), hk = new Set(have.map(routeKey));
  for (const r of have) if (!wk.has(routeKey(r))) w('EC2', 'DeleteRoute', () => ec2.deleteRoute(e.ctx, { RouteTableId: rtId, DestinationCidrBlock: r.cidr_block }));
  for (const r of want) if (!hk.has(routeKey(r))) w('EC2', 'CreateRoute', () => ec2.createRoute(e.ctx, { RouteTableId: rtId, DestinationCidrBlock: r.cidr_block, GatewayId: r.gateway_id, NatGatewayId: r.nat_gateway_id }));
}
def('aws_route_table', {
  noun: 'Route Table',
  args: { vpc_id: true, tags: false },
  blocks: { route: { args: { cidr_block: false, gateway_id: false, nat_gateway_id: false } } },
  computed: ['arn', 'id', 'owner_id', 'propagating_vgws'],
  forceNew: ['vpc_id'],
  create(e, a) {
    const rt = w('EC2', 'CreateRouteTable', () => ec2.createRouteTable(e.ctx, { VpcId: a.vpc_id, Tags: tagList(a.tags) }));
    const routes = normRoutes(a.route);
    applyRoutes(e, rt.id, routes, []);
    return withTagsAll({ ...a, route: routes, id: rt.id, arn: `arn:aws:ec2:${region(e)}:${acct(e)}:route-table/${rt.id}`, owner_id: acct(e), propagating_vgws: [] });
  },
  read(e, st) {
    const rt = e.ctx.s.routeTables.find((x) => x.id === st.id);
    if (!rt) return null;
    return { vpc_id: rt.vpcId, route: normRoutes(rt.routes.filter((r) => r.target !== 'local').map((r) => ({ cidr_block: r.destination, ...(r.target.startsWith('nat-') ? { nat_gateway_id: r.target } : { gateway_id: r.target }) }))), tags: { ...rt.tags } };
  },
  update(e, st, a) {
    if (a.route !== undefined) applyRoutes(e, st.id, normRoutes(a.route), normRoutes(st.route));
    syncTags(e, st.id, st.tags, a.tags);
    return withTagsAll({ ...st, ...a, route: normRoutes(a.route ?? st.route), tags_all: undefined });
  },
  destroy(e, st) { w('EC2', 'DeleteRouteTable', () => ec2.deleteRouteTable(e.ctx, { RouteTableId: st.id })); },
});

def('aws_route_table_association', {
  noun: 'Route Table Association',
  args: { subnet_id: true, route_table_id: true },
  blocks: {}, computed: ['id'], forceNew: ['subnet_id', 'route_table_id'],
  create(e, a) {
    const id = w('EC2', 'AssociateRouteTable', () => ec2.associateRouteTable(e.ctx, { RouteTableId: a.route_table_id, SubnetId: a.subnet_id }));
    return { ...a, id };
  },
  read(e, st) {
    const rt = e.ctx.s.routeTables.find((x) => x.id === st.route_table_id);
    const as = rt?.associations.find((x) => x.id === st.id);
    return as ? { subnet_id: as.subnetId, route_table_id: rt!.id } : null;
  },
  update: (_e, st, a) => ({ ...st, ...a }),
  destroy(e, st) { w('EC2', 'DisassociateRouteTable', () => ec2.disassociateRouteTable(e.ctx, { AssociationId: st.id })); },
});

def('aws_route', {
  noun: 'Route',
  args: { route_table_id: true, destination_cidr_block: true, gateway_id: false, nat_gateway_id: false },
  blocks: {}, computed: ['id', 'instance_id', 'origin', 'state'], forceNew: ['route_table_id', 'destination_cidr_block'],
  create(e, a) {
    w('EC2', 'CreateRoute', () => ec2.createRoute(e.ctx, { RouteTableId: a.route_table_id, DestinationCidrBlock: a.destination_cidr_block, GatewayId: a.gateway_id, NatGatewayId: a.nat_gateway_id }));
    return { ...a, id: `r-${a.route_table_id}${Math.abs([...a.destination_cidr_block].reduce((h: number, c: string) => (h * 31 + c.charCodeAt(0)) | 0, 7))}`, origin: 'CreateRoute', state: 'active' };
  },
  read(e, st) {
    const rt = e.ctx.s.routeTables.find((x) => x.id === st.route_table_id);
    const r = rt?.routes.find((x) => x.destination === st.destination_cidr_block);
    return r ? { gateway_id: r.target.startsWith('nat-') ? st.gateway_id : r.target, nat_gateway_id: r.target.startsWith('nat-') ? r.target : st.nat_gateway_id } : null;
  },
  update: (_e, st, a) => ({ ...st, ...a }),
  destroy(e, st) { w('EC2', 'DeleteRoute', () => ec2.deleteRoute(e.ctx, { RouteTableId: st.route_table_id, DestinationCidrBlock: st.destination_cidr_block })); },
});

// ---- Security Group

function flattenRules(l: Attrs[] = []): string[] {
  const out: string[] = [];
  for (const r of l) {
    const base = `${r.protocol}|${r.from_port}|${r.to_port}|${r.description ?? ''}`;
    for (const c of r.cidr_blocks ?? []) out.push(`${base}|cidr|${c}`);
    for (const g of r.security_groups ?? []) out.push(`${base}|sg|${g}`);
  }
  return out.sort();
}
export function normRules(l: Attrs[] = []): Attrs[] {
  const groups = new Map<string, Attrs>();
  for (const r of l) {
    const proto = String(r.protocol ?? '-1');
    const protocol = proto === 'all' ? '-1' : proto;
    const from = protocol === '-1' ? 0 : Number(r.from_port ?? 0), to = protocol === '-1' ? 0 : Number(r.to_port ?? 0);
    const k = `${protocol}|${from}|${to}|${r.description ?? ''}`;
    const g = groups.get(k) ?? { cidr_blocks: [], description: r.description ?? '', from_port: from, ipv6_cidr_blocks: [], prefix_list_ids: [], protocol, security_groups: [], self: false, to_port: to };
    g.cidr_blocks = [...new Set([...g.cidr_blocks, ...(r.cidr_blocks ?? [])])].sort();
    g.security_groups = [...new Set([...g.security_groups, ...(r.security_groups ?? [])])].sort();
    groups.set(k, g);
  }
  return [...groups.values()].sort((a, b) => a.from_port - b.from_port || a.protocol.localeCompare(b.protocol));
}
const perms = (keys: string[]): any[] => keys.map((k) => {
  const [protocol, from, to, description, kind, target] = k.split('|');
  return { IpProtocol: protocol, ...(protocol === '-1' ? {} : { FromPort: Number(from), ToPort: Number(to) }), ...(kind === 'cidr' ? { CidrIp: target } : { SourceSecurityGroupId: target }), ...(description ? { Description: description } : {}) };
});
function applySgRules(e: Env, id: string, dir: 'Ingress' | 'Egress', want: Attrs[], have: Attrs[]) {
  const wk = flattenRules(want), hk = flattenRules(have);
  const rm = hk.filter((k) => !wk.includes(k)), add = wk.filter((k) => !hk.includes(k));
  const fns = dir === 'Ingress' ? { rev: ec2.revokeSecurityGroupIngress, aut: ec2.authorizeSecurityGroupIngress } : { rev: ec2.revokeSecurityGroupEgress, aut: ec2.authorizeSecurityGroupEgress };
  if (rm.length) w('EC2', `RevokeSecurityGroup${dir}`, () => fns.rev(e.ctx, { GroupId: id, IpPermissions: perms(rm) }));
  if (add.length) w('EC2', `AuthorizeSecurityGroup${dir}`, () => fns.aut(e.ctx, { GroupId: id, IpPermissions: perms(add) }));
}
const sgRead = (rules: any[]): Attrs[] => normRules(rules.map((r) => ({ protocol: r.protocol, from_port: r.from, to_port: r.to, cidr_blocks: r.cidr ? [r.cidr] : [], security_groups: r.sourceSg ? [r.sourceSg] : [], description: r.description })));
const RULE_ARGS: BlockSchema = { args: { cidr_blocks: false, description: false, from_port: true, ipv6_cidr_blocks: false, prefix_list_ids: false, protocol: true, security_groups: false, self: false, to_port: true } };
def('aws_security_group', {
  noun: 'Security Group',
  args: { name: false, name_prefix: false, description: false, vpc_id: false, revoke_rules_on_delete: false, tags: false },
  blocks: { ingress: RULE_ARGS, egress: RULE_ARGS },
  computed: ['arn', 'id', 'name', 'owner_id'],
  forceNew: ['name', 'name_prefix', 'description', 'vpc_id'],
  defaults: { description: 'Managed by Terraform', revoke_rules_on_delete: false },
  local: ['revoke_rules_on_delete', 'name_prefix'],
  create(e, a) {
    const name = a.name ?? `${a.name_prefix ?? 'terraform-'}${hex(26)}`;
    const g = w('EC2', 'CreateSecurityGroup', () => ec2.createSecurityGroup(e.ctx, { GroupName: name, Description: a.description ?? 'Managed by Terraform', VpcId: a.vpc_id, Tags: tagList(a.tags) }));
    // Terraform elimina la regla de salida «todo permitido» que AWS crea por defecto.
    if (a.egress === undefined) applySgRules(e, g.id, 'Egress', [], sgRead(g.egress));
    else applySgRules(e, g.id, 'Egress', normRules(a.egress), sgRead(g.egress));
    if (a.ingress?.length) applySgRules(e, g.id, 'Ingress', normRules(a.ingress), []);
    return withTagsAll({ ...this.defaults, ...a, name, id: g.id, vpc_id: g.vpcId, arn: `arn:aws:ec2:${region(e)}:${acct(e)}:security-group/${g.id}`, owner_id: acct(e), ingress: normRules(a.ingress ?? []), egress: normRules(a.egress ?? []) });
  },
  read(e, st) {
    const g = e.ctx.s.securityGroups.find((x) => x.id === st.id);
    if (!g) return null;
    return { name: g.name, description: g.description, vpc_id: g.vpcId, ingress: sgRead(g.ingress), egress: sgRead(g.egress), tags: { ...g.tags } };
  },
  update(e, st, a) {
    if (a.ingress !== undefined) applySgRules(e, st.id, 'Ingress', normRules(a.ingress), st.ingress);
    if (a.egress !== undefined) applySgRules(e, st.id, 'Egress', normRules(a.egress), st.egress);
    syncTags(e, st.id, st.tags, a.tags);
    return withTagsAll({ ...st, ...a, ingress: a.ingress !== undefined ? normRules(a.ingress) : st.ingress, egress: a.egress !== undefined ? normRules(a.egress) : st.egress, tags_all: undefined });
  },
  destroy(e, st) { w('EC2', 'DeleteSecurityGroup', () => ec2.deleteSecurityGroup(e.ctx, { GroupId: st.id })); },
});

// ------------------------------------------------------------------ EC2

function advance(e: Env, id: string, to: 'running' | 'terminated') {
  const i = e.ctx.s.instances.find((x) => x.id === id);
  if (i?.transition && i.transition.to === to) i.transition.at = now();
  ec2.settle(e.ctx.s);
}
def('aws_instance', {
  noun: 'EC2 Instance',
  args: { ami: false, instance_type: false, subnet_id: false, vpc_security_group_ids: false, key_name: false, iam_instance_profile: false, user_data: false, associate_public_ip_address: false, tags: false },
  blocks: { metadata_options: { args: { http_endpoint: false, http_tokens: false, http_put_response_hop_limit: false } }, root_block_device: { args: { volume_size: false, volume_type: false, encrypted: false, delete_on_termination: false } } },
  computed: ['arn', 'id', 'instance_state', 'private_ip', 'public_ip', 'subnet_id', 'vpc_security_group_ids'],
  forceNew: ['ami', 'subnet_id', 'key_name'],
  defaults: { instance_type: 't3.micro' },
  create(e, a) {
    const type = a.instance_type ?? 't3.micro';
    const [i] = w('EC2', 'RunInstances', () => ec2.runInstances(e.ctx, {
      ImageId: a.ami, InstanceType: type, SubnetId: a.subnet_id, SecurityGroupIds: a.vpc_security_group_ids, KeyName: a.key_name, IamInstanceProfile: a.iam_instance_profile, UserData: a.user_data,
      AssociatePublicIpAddress: a.associate_public_ip_address, Tags: tagList(a.tags), HttpTokens: a.metadata_options?.[0]?.http_tokens, VolumeSize: a.root_block_device?.[0]?.volume_size, Encrypted: a.root_block_device?.[0]?.encrypted,
    }));
    advance(e, i.id, 'running');
    return withTagsAll({ ...a, instance_type: type, id: i.id, arn: `arn:aws:ec2:${region(e)}:${acct(e)}:instance/${i.id}`, instance_state: i.state, private_ip: i.privateIp, public_ip: i.publicIp, subnet_id: i.subnetId, vpc_security_group_ids: [...i.securityGroupIds] });
  },
  read(e, st) {
    ec2.settle(e.ctx.s);
    const i = e.ctx.s.instances.find((x) => x.id === st.id);
    if (!i || i.state === 'terminated' || i.state === 'shutting-down') return null;
    return { ami: i.imageId, instance_type: i.type, subnet_id: i.subnetId, vpc_security_group_ids: [...i.securityGroupIds], instance_state: i.state, private_ip: i.privateIp, public_ip: i.publicIp, key_name: i.keyName, tags: { ...i.tags }, ...(st.metadata_options ? { metadata_options: [{ ...st.metadata_options[0], http_tokens: i.httpTokens }] } : {}) };
  },
  update(e, st, a) {
    const i = e.ctx.s.instances.find((x) => x.id === st.id);
    // Simplificación: el tipo y los grupos de seguridad se cambian directamente (AWS real paraba y arrancaba la instancia).
    if (i && a.instance_type && a.instance_type !== st.instance_type) i.type = a.instance_type;
    if (i && a.vpc_security_group_ids && JSON.stringify(a.vpc_security_group_ids) !== JSON.stringify(st.vpc_security_group_ids)) i.securityGroupIds = [...a.vpc_security_group_ids];
    const tok = a.metadata_options?.[0]?.http_tokens;
    if (tok && tok !== st.metadata_options?.[0]?.http_tokens) w('EC2', 'ModifyInstanceMetadataOptions', () => ec2.modifyInstanceMetadataOptions(e.ctx, { InstanceId: st.id, HttpTokens: tok }));
    syncTags(e, st.id, st.tags, a.tags);
    return withTagsAll({ ...st, ...a, tags_all: undefined });
  },
  destroy(e, st) {
    w('EC2', 'TerminateInstances', () => ec2.terminateInstances(e.ctx, { InstanceIds: [st.id] }));
    advance(e, st.id, 'terminated');
  },
});

// ------------------------------------------------------------------ S3

const sa = (e: Env, bucket: string) => e.ctx.s.buckets.find((b) => b.name === bucket);
def('aws_s3_bucket', {
  noun: 'Amazon S3 (Simple Storage) Bucket',
  args: { bucket: false, bucket_prefix: false, force_destroy: false, object_lock_enabled: false, tags: false },
  blocks: {},
  computed: ['arn', 'bucket', 'bucket_domain_name', 'bucket_regional_domain_name', 'hosted_zone_id', 'id', 'region'],
  forceNew: ['bucket', 'bucket_prefix', 'object_lock_enabled'],
  defaults: { force_destroy: false },
  local: ['force_destroy', 'bucket_prefix', 'object_lock_enabled'],
  create(e, a) {
    const name = a.bucket ?? `${a.bucket_prefix ?? 'terraform-'}${now().toString().slice(-10)}${hex(6)}`;
    w('S3', 'CreateBucket', () => s3.createBucket(e.ctx, { Bucket: name, Region: region(e) }));
    if (a.tags && Object.keys(a.tags).length) w('S3', 'PutBucketTagging', () => s3.putBucketTagging(e.ctx, { Bucket: name, Tags: a.tags }));
    return withTagsAll({ ...this.defaults, ...a, bucket: name, id: name, arn: `arn:aws:s3:::${name}`, bucket_domain_name: `${name}.s3.amazonaws.com`, bucket_regional_domain_name: `${name}.s3.${region(e)}.amazonaws.com`, hosted_zone_id: 'Z1BKCTXD74EZPE', region: region(e) });
  },
  read(e, st) {
    const b = sa(e, st.id);
    return b ? { bucket: b.name, tags: { ...b.tags } } : null;
  },
  update(e, st, a) {
    if (JSON.stringify(a.tags ?? {}) !== JSON.stringify(st.tags ?? {})) w('S3', 'PutBucketTagging', () => s3.putBucketTagging(e.ctx, { Bucket: st.id, Tags: a.tags ?? {} }));
    return withTagsAll({ ...st, ...a, tags_all: undefined });
  },
  destroy(e, st) {
    const b = sa(e, st.id);
    if (b && st.force_destroy) { b.objects = {}; b.versions = {}; }
    w('S3', 'DeleteBucket', () => s3.deleteBucket(e.ctx, { Bucket: st.id }));
  },
});
def('aws_s3_bucket_versioning', {
  noun: 'S3 Bucket Versioning',
  args: { bucket: true }, blocks: { versioning_configuration: { args: { status: true, mfa_delete: false } } },
  computed: ['id'], forceNew: ['bucket'],
  create(e, a) {
    const status = a.versioning_configuration?.[0]?.status;
    if (!['Enabled', 'Suspended', 'Disabled'].includes(status)) throw new TfApiError('S3', 'PutBucketVersioning', 'MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema', 400);
    if (status !== 'Disabled') w('S3', 'PutBucketVersioning', () => s3.putBucketVersioning(e.ctx, { Bucket: a.bucket, Status: status }));
    return { ...a, id: a.bucket };
  },
  read(e, st) { const b = sa(e, st.bucket); return b ? { versioning_configuration: [{ ...(st.versioning_configuration?.[0] ?? {}), status: b.versioning === 'Disabled' ? (st.versioning_configuration?.[0]?.status === 'Disabled' ? 'Disabled' : 'Suspended') : b.versioning }] } : null; },
  update(e, st, a) {
    const status = a.versioning_configuration?.[0]?.status;
    w('S3', 'PutBucketVersioning', () => s3.putBucketVersioning(e.ctx, { Bucket: st.bucket, Status: status === 'Enabled' ? 'Enabled' : 'Suspended' }));
    return { ...st, ...a };
  },
  destroy(e, st) { const b = sa(e, st.bucket); if (b && b.versioning === 'Enabled') w('S3', 'PutBucketVersioning', () => s3.putBucketVersioning(e.ctx, { Bucket: st.bucket, Status: 'Suspended' })); },
});
def('aws_s3_bucket_server_side_encryption_configuration', {
  noun: 'S3 Bucket Server-side Encryption Configuration',
  args: { bucket: true },
  blocks: { rule: { args: { bucket_key_enabled: false }, blocks: { apply_server_side_encryption_by_default: { args: { sse_algorithm: true, kms_master_key_id: false } } } } },
  computed: ['id'], forceNew: ['bucket'],
  create(e, a) {
    const d = a.rule?.[0]?.apply_server_side_encryption_by_default?.[0];
    if (!d) throw new TfApiError('S3', 'PutBucketEncryption', 'MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema', 400);
    w('S3', 'PutBucketEncryption', () => s3.putBucketEncryption(e.ctx, { Bucket: a.bucket, Algorithm: d.sse_algorithm === 'aws:kms' || d.sse_algorithm === 'aws:kms:dsse' ? 'aws:kms' : 'AES256', KmsKeyId: d.kms_master_key_id }));
    return { ...a, id: a.bucket };
  },
  read(e, st) {
    const b = sa(e, st.bucket);
    if (!b) return null;
    if (!b.encryption) return { rule: [] };
    const cur = st.rule?.[0];
    return { rule: [{ ...(cur ?? {}), apply_server_side_encryption_by_default: [{ sse_algorithm: b.encryption.algorithm, ...(b.encryption.kmsKeyId ? { kms_master_key_id: b.encryption.kmsKeyId } : {}) }] }] };
  },
  update(e, st, a) { this.create(e, a); return { ...st, ...a }; },
  destroy(e, st) { if (sa(e, st.bucket)) w('S3', 'DeleteBucketEncryption', () => s3x.deleteBucketEncryption(e.ctx, { Bucket: st.bucket })); },
});
const PAB = ['block_public_acls', 'block_public_policy', 'ignore_public_acls', 'restrict_public_buckets'] as const;
const pabCall = (e: Env, bucket: string, a: Attrs) => w('S3', 'PutPublicAccessBlock', () => s3.putPublicAccessBlock(e.ctx, { Bucket: bucket, BlockPublicAcls: !!a.block_public_acls, IgnorePublicAcls: !!a.ignore_public_acls, BlockPublicPolicy: !!a.block_public_policy, RestrictPublicBuckets: !!a.restrict_public_buckets }));
def('aws_s3_bucket_public_access_block', {
  noun: 'S3 bucket public access block',
  args: { bucket: true, block_public_acls: false, block_public_policy: false, ignore_public_acls: false, restrict_public_buckets: false }, blocks: {},
  computed: ['id'], forceNew: ['bucket'],
  defaults: { block_public_acls: false, block_public_policy: false, ignore_public_acls: false, restrict_public_buckets: false },
  create(e, a) { pabCall(e, a.bucket, a); return { ...this.defaults, ...a, id: a.bucket }; },
  read(e, st) { const b = sa(e, st.bucket); return b ? { block_public_acls: b.publicAccessBlock.BlockPublicAcls, block_public_policy: b.publicAccessBlock.BlockPublicPolicy, ignore_public_acls: b.publicAccessBlock.IgnorePublicAcls, restrict_public_buckets: b.publicAccessBlock.RestrictPublicBuckets } : null; },
  update(e, st, a) { pabCall(e, st.bucket, a); return { ...st, ...a }; },
  destroy(e, st) { if (sa(e, st.bucket)) w('S3', 'DeletePublicAccessBlock', () => s3x.deletePublicAccessBlock(e.ctx, { Bucket: st.bucket })); },
});
void PAB;
def('aws_s3_bucket_policy', {
  noun: 'S3 Bucket Policy',
  args: { bucket: true, policy: true }, blocks: {}, computed: ['id'], forceNew: ['bucket'],
  create(e, a) { w('S3', 'PutBucketPolicy', () => s3.putBucketPolicy(e.ctx, { Bucket: a.bucket, Policy: a.policy })); return { ...a, id: a.bucket }; },
  read(e, st) { const b = sa(e, st.bucket); return b ? { policy: b.policy ? JSON.stringify(b.policy) : '' } : null; },
  update(e, st, a) { w('S3', 'PutBucketPolicy', () => s3.putBucketPolicy(e.ctx, { Bucket: st.bucket, Policy: a.policy })); return { ...st, ...a }; },
  destroy(e, st) { const b = sa(e, st.bucket); if (b?.policy) w('S3', 'DeleteBucketPolicy', () => s3.deleteBucketPolicy(e.ctx, { Bucket: st.bucket })); },
});

// ------------------------------------------------------------------ IAM

def('aws_iam_user', {
  noun: 'IAM User',
  args: { name: true, path: false, force_destroy: false, tags: false }, blocks: {},
  computed: ['arn', 'id', 'unique_id'], forceNew: [], defaults: { path: '/', force_destroy: false }, local: ['force_destroy', 'tags'],
  create(e, a) { const u = w('IAM', 'CreateUser', () => iam.createUser(e.ctx, { UserName: a.name, Path: a.path, Tags: tagList(a.tags) })); return withTagsAll({ ...this.defaults, ...a, id: u.name, arn: u.arn, unique_id: u.id }); },
  read(e, st) { const u = e.ctx.s.users.find((x) => x.name === st.id); return u ? { name: u.name } : null; },
  update: (_e, st, a) => withTagsAll({ ...st, ...a, tags_all: undefined }),
  destroy(e, st) { w('IAM', 'DeleteUser', () => iam.deleteUser(e.ctx, { UserName: st.id })); },
});
def('aws_iam_role', {
  noun: 'IAM Role',
  args: { name: false, name_prefix: false, assume_role_policy: true, description: false, path: false, max_session_duration: false, tags: false }, blocks: {},
  computed: ['arn', 'create_date', 'id', 'name', 'unique_id'], forceNew: ['name'], defaults: { path: '/', max_session_duration: 3600 }, local: ['tags', 'name_prefix'],
  create(e, a) {
    const name = a.name ?? `${a.name_prefix ?? 'terraform-'}${hex(20)}`;
    const r = w('IAM', 'CreateRole', () => iam.createRole(e.ctx, { RoleName: name, AssumeRolePolicyDocument: a.assume_role_policy, Path: a.path, Description: a.description, MaxSessionDuration: a.max_session_duration, Tags: tagList(a.tags) }));
    return withTagsAll({ ...this.defaults, ...a, name, id: name, arn: r.arn, unique_id: r.id, create_date: r.createdAt });
  },
  read(e, st) { const r = e.ctx.s.roles.find((x) => x.name === st.id); return r ? { name: r.name, assume_role_policy: JSON.stringify(r.assumeRolePolicy), description: r.description } : null; },
  update(e, st, a) { if (!sameJson(a.assume_role_policy, st.assume_role_policy)) w('IAM', 'UpdateAssumeRolePolicy', () => iam.updateAssumeRolePolicy(e.ctx, { RoleName: st.id, PolicyDocument: a.assume_role_policy })); return withTagsAll({ ...st, ...a, tags_all: undefined }); },
  destroy(e, st) { w('IAM', 'DeleteRole', () => iam.deleteRole(e.ctx, { RoleName: st.id })); },
});
def('aws_iam_policy', {
  noun: 'IAM Policy',
  args: { name: false, name_prefix: false, policy: true, description: false, path: false, tags: false }, blocks: {},
  computed: ['arn', 'attachment_count', 'id', 'name', 'policy_id'], forceNew: ['name'], defaults: { path: '/' }, local: ['tags', 'name_prefix'],
  create(e, a) {
    const name = a.name ?? `${a.name_prefix ?? 'terraform-'}${hex(20)}`;
    const p = w('IAM', 'CreatePolicy', () => iam.createPolicy(e.ctx, { PolicyName: name, PolicyDocument: a.policy, Path: a.path, Description: a.description }));
    return withTagsAll({ ...this.defaults, ...a, name, id: p.arn, arn: p.arn, policy_id: p.id, attachment_count: 0 });
  },
  read(e, st) { const p = e.ctx.s.policies.find((x) => x.arn === st.id); return p ? { policy: JSON.stringify(p.document), name: p.name } : null; },
  update(e, st, a) {
    if (!sameJson(a.policy, st.policy)) {
      const pol = e.ctx.s.policies.find((x) => x.arn === st.id);
      if (pol && (pol.versions?.length ?? 1) >= 5) { const old = iamx.versionsOf(pol).find((v) => v.id !== pol.defaultVersion); if (old) w('IAM', 'DeletePolicyVersion', () => iamx.deletePolicyVersion(e.ctx, { PolicyArn: st.id, VersionId: old.id })); }
      w('IAM', 'CreatePolicyVersion', () => iamx.createPolicyVersion(e.ctx, { PolicyArn: st.id, PolicyDocument: a.policy, SetAsDefault: true }));
    }
    return withTagsAll({ ...st, ...a, tags_all: undefined });
  },
  destroy(e, st) { w('IAM', 'DeletePolicy', () => iam.deletePolicy(e.ctx, { PolicyArn: st.id })); },
});
const attachId = (who: string) => `${who}-${new Date(now()).toISOString().replace(/[-:T.Z]/g, '').slice(0, 20)}${hex(8).replace(/[a-f]/g, '1')}`;
def('aws_iam_role_policy_attachment', {
  noun: 'IAM Role Policy Attachment', args: { role: true, policy_arn: true }, blocks: {}, computed: ['id'], forceNew: ['role', 'policy_arn'],
  create(e, a) { w('IAM', 'AttachRolePolicy', () => iam.attachRolePolicy(e.ctx, { RoleName: a.role, PolicyArn: a.policy_arn })); return { ...a, id: attachId(a.role) }; },
  read(e, st) { const r = e.ctx.s.roles.find((x) => x.name === st.role); return r && r.attached.includes(st.policy_arn) ? {} : null; },
  update: (_e, st, a) => ({ ...st, ...a }),
  destroy(e, st) { if (e.ctx.s.roles.some((r) => r.name === st.role)) w('IAM', 'DetachRolePolicy', () => iam.detachRolePolicy(e.ctx, { RoleName: st.role, PolicyArn: st.policy_arn })); },
});
def('aws_iam_user_policy_attachment', {
  noun: 'IAM User Policy Attachment', args: { user: true, policy_arn: true }, blocks: {}, computed: ['id'], forceNew: ['user', 'policy_arn'],
  create(e, a) { w('IAM', 'AttachUserPolicy', () => iam.attachUserPolicy(e.ctx, { UserName: a.user, PolicyArn: a.policy_arn })); return { ...a, id: attachId(a.user) }; },
  read(e, st) { const u = e.ctx.s.users.find((x) => x.name === st.user); return u && u.attached.includes(st.policy_arn) ? {} : null; },
  update: (_e, st, a) => ({ ...st, ...a }),
  destroy(e, st) { if (e.ctx.s.users.some((u) => u.name === st.user)) w('IAM', 'DetachUserPolicy', () => iam.detachUserPolicy(e.ctx, { UserName: st.user, PolicyArn: st.policy_arn })); },
});
def('aws_iam_role_policy', {
  noun: 'IAM Role Policy', args: { name: true, role: true, policy: true }, blocks: {}, computed: ['id'], forceNew: ['name', 'role'],
  create(e, a) { w('IAM', 'PutRolePolicy', () => iam.putRolePolicy(e.ctx, { RoleName: a.role, PolicyName: a.name, PolicyDocument: a.policy })); return { ...a, id: `${a.role}:${a.name}` }; },
  read(e, st) { const r = e.ctx.s.roles.find((x) => x.name === st.role); const d = r?.inline[st.name]; return d ? { policy: JSON.stringify(d) } : null; },
  update(e, st, a) { w('IAM', 'PutRolePolicy', () => iam.putRolePolicy(e.ctx, { RoleName: st.role, PolicyName: st.name, PolicyDocument: a.policy })); return { ...st, ...a }; },
  destroy(e, st) { if (e.ctx.s.roles.some((r) => r.name === st.role)) w('IAM', 'DeleteRolePolicy', () => iamx.deleteRolePolicy(e.ctx, { RoleName: st.role, PolicyName: st.name })); },
});
def('aws_iam_instance_profile', {
  noun: 'IAM Instance Profile', args: { name: false, role: false, path: false }, blocks: {}, computed: ['arn', 'create_date', 'id', 'name', 'unique_id'], forceNew: ['name'], defaults: { path: '/' },
  create(e, a) {
    const name = a.name ?? `terraform-${hex(20)}`;
    const p = w('IAM', 'CreateInstanceProfile', () => iam.createInstanceProfile(e.ctx, { InstanceProfileName: name }));
    if (a.role) w('IAM', 'AddRoleToInstanceProfile', () => iam.addRoleToInstanceProfile(e.ctx, { InstanceProfileName: name, RoleName: a.role }));
    return { ...this.defaults, ...a, name, id: name, arn: (p as any).InstanceProfile?.Arn ?? `arn:aws:iam::${acct(e)}:instance-profile/${name}`, unique_id: `AIPA${hex(16).toUpperCase()}`, create_date: new Date(now()).toISOString() };
  },
  read(e, st) { return e.ctx.s.instanceProfiles.some((x) => x.name === st.id) ? {} : null; },
  update: (_e, st, a) => ({ ...st, ...a }),
  destroy(e, st) { const ip = e.ctx.s.instanceProfiles.find((x) => x.name === st.id); if (ip) e.ctx.s.instanceProfiles = e.ctx.s.instanceProfiles.filter((x) => x !== ip); },
});

// ------------------------------------------------------------------ KMS y CloudTrail

def('aws_kms_key', {
  noun: 'KMS Key',
  args: { description: false, enable_key_rotation: false, deletion_window_in_days: false, policy: false, is_enabled: false, tags: false }, blocks: {},
  computed: ['arn', 'customer_master_key_spec', 'id', 'key_id', 'key_usage', 'multi_region', 'policy'], forceNew: [],
  defaults: { enable_key_rotation: false, deletion_window_in_days: 30, is_enabled: true, customer_master_key_spec: 'SYMMETRIC_DEFAULT', key_usage: 'ENCRYPT_DECRYPT', multi_region: false }, local: ['deletion_window_in_days'],
  create(e, a) {
    const k = w('KMS', 'CreateKey', () => kms.createKey(e.ctx, { Description: a.description, Policy: a.policy, Tags: Object.entries(a.tags ?? {}).map(([TagKey, TagValue]) => ({ TagKey, TagValue: String(TagValue) })) }));
    if (a.enable_key_rotation) w('KMS', 'EnableKeyRotation', () => kms.setRotation(e.ctx, { KeyId: k.id }, true));
    if (a.is_enabled === false) w('KMS', 'DisableKey', () => kms.setKeyEnabled(e.ctx, { KeyId: k.id }, false));
    return withTagsAll({ ...this.defaults, ...a, id: k.id, key_id: k.id, arn: k.arn, policy: JSON.stringify(k.policy) });
  },
  read(e, st) { const k = e.ctx.s.kmsKeys.find((x) => x.id === st.id); return k && k.state !== 'PendingDeletion' ? { description: k.description, enable_key_rotation: k.rotation, is_enabled: k.state === 'Enabled', policy: JSON.stringify(k.policy) } : null; },
  update(e, st, a) {
    if (a.enable_key_rotation !== st.enable_key_rotation) w('KMS', a.enable_key_rotation ? 'EnableKeyRotation' : 'DisableKeyRotation', () => kms.setRotation(e.ctx, { KeyId: st.id }, !!a.enable_key_rotation));
    if (a.policy && !sameJson(a.policy, st.policy)) w('KMS', 'PutKeyPolicy', () => kms.putKeyPolicy(e.ctx, { KeyId: st.id, Policy: a.policy }));
    if (a.is_enabled !== st.is_enabled) w('KMS', a.is_enabled === false ? 'DisableKey' : 'EnableKey', () => kms.setKeyEnabled(e.ctx, { KeyId: st.id }, a.is_enabled !== false));
    return withTagsAll({ ...st, ...a, tags_all: undefined });
  },
  destroy(e, st) { w('KMS', 'ScheduleKeyDeletion', () => kms.scheduleKeyDeletion(e.ctx, { KeyId: st.id, PendingWindowInDays: st.deletion_window_in_days ?? 30 })); },
});
def('aws_kms_alias', {
  noun: 'KMS Alias', args: { name: false, name_prefix: false, target_key_id: true }, blocks: {}, computed: ['arn', 'id', 'name', 'target_key_arn'], forceNew: ['name'], local: ['name_prefix'],
  create(e, a) {
    const name = a.name ?? `${a.name_prefix ?? 'alias/terraform-'}${hex(10)}`;
    w('KMS', 'CreateAlias', () => kms.createAlias(e.ctx, { AliasName: name, TargetKeyId: a.target_key_id }));
    const key = e.ctx.s.kmsKeys.find((k) => k.id === a.target_key_id || k.arn === a.target_key_id);
    return { ...a, name, id: name, arn: `arn:aws:kms:${region(e)}:${acct(e)}:${name}`, target_key_arn: key?.arn ?? a.target_key_id };
  },
  read(e, st) { const al = e.ctx.s.kmsAliases.find((x) => x.name === st.id); return al ? { target_key_id: al.keyId } : null; },
  update(e, st, a) { w('KMS', 'UpdateAlias', () => kms.updateAlias(e.ctx, { AliasName: st.id, TargetKeyId: a.target_key_id })); return { ...st, ...a }; },
  destroy(e, st) { w('KMS', 'DeleteAlias', () => kms.deleteAlias(e.ctx, { AliasName: st.id })); },
});
def('aws_cloudtrail', {
  noun: 'CloudTrail Trail',
  args: { name: true, s3_bucket_name: true, s3_key_prefix: false, is_multi_region_trail: false, include_global_service_events: false, enable_log_file_validation: false, enable_logging: false, kms_key_id: false, tags: false }, blocks: {},
  computed: ['arn', 'home_region', 'id'], forceNew: ['name'],
  defaults: { enable_logging: true, include_global_service_events: true, is_multi_region_trail: false, enable_log_file_validation: false },
  create(e, a) {
    const t = w('CloudTrail', 'CreateTrail', () => ct.createTrail(e.ctx, { Name: a.name, S3BucketName: a.s3_bucket_name, S3KeyPrefix: a.s3_key_prefix, IsMultiRegionTrail: !!a.is_multi_region_trail, IncludeGlobalServiceEvents: a.include_global_service_events !== false, EnableLogFileValidation: !!a.enable_log_file_validation, KmsKeyId: a.kms_key_id }));
    if (a.enable_logging !== false) w('CloudTrail', 'StartLogging', () => ct.startLogging(e.ctx, { Name: a.name }));
    return withTagsAll({ ...this.defaults, ...a, id: t.name, arn: t.arn, home_region: t.homeRegion });
  },
  read(e, st) { const t = e.ctx.s.trails.find((x) => x.name === st.id); return t ? { s3_bucket_name: t.s3Bucket, s3_key_prefix: t.s3Prefix, is_multi_region_trail: t.multiRegion, enable_log_file_validation: t.logValidation, enable_logging: t.logging, kms_key_id: t.kmsKeyId } : null; },
  update(e, st, a) {
    w('CloudTrail', 'UpdateTrail', () => ct.updateTrail(e.ctx, { Name: st.id, S3BucketName: a.s3_bucket_name, S3KeyPrefix: a.s3_key_prefix, IsMultiRegionTrail: !!a.is_multi_region_trail, EnableLogFileValidation: !!a.enable_log_file_validation, KmsKeyId: a.kms_key_id }));
    if (a.enable_logging !== st.enable_logging) w('CloudTrail', a.enable_logging === false ? 'StopLogging' : 'StartLogging', () => (a.enable_logging === false ? ct.stopLogging : ct.startLogging)(e.ctx, { Name: st.id }));
    return withTagsAll({ ...st, ...a, tags_all: undefined });
  },
  destroy(e, st) { w('CloudTrail', 'DeleteTrail', () => ct.deleteTrail(e.ctx, { Name: st.id })); },
});

export const DEFAULT_AMI = AMIS[0]?.id ?? 'ami-0a1b2c3d4e5f60001';

// CloudFormation: tipos de recurso soportados. Cada uno crea, actualiza y borra recursos REALES del motor
// (los mismos servicios que usa `aws ...`), con la identidad de quien lanza la pila o la del rol de servicio.
import type { Ctx } from '../api';
import { AwsError } from '../errors';
import * as ec2 from './ec2';
import * as s3 from './s3';
import * as iam from './iam';
import * as iamx from './iamExtra';
import * as kms from './kms';
import * as sm from './secrets';
import * as sns from './sns';
import * as cw from './cloudwatch';
import * as lg from './logs';
import { hex, now, randomString } from '../util';

export type Props = Record<string, any>;
export interface Live { id: string; attrs: Record<string, string> }
export interface PCtx { ctx: Ctx; stackName: string; stackId: string; logical: string; tags: { Key: string; Value: string }[] }

/** Error de validación de propiedades, sin sufijo de servicio (como los tipos del registro de CloudFormation). */
export class PropError extends AwsError {
  constructor(msg: string) {
    super('InvalidRequest', msg, 400);
  }
}

export interface Provider {
  type: string;
  /** Nombre del servicio tal como aparece en los errores (`Service: Amazon S3; ...`). */
  service: string;
  props: string[];
  /** Propiedades válidas de la plantilla real que el simulador acepta pero no modela. */
  noop?: string[];
  required?: string[];
  /** Propiedad con el nombre personalizado: si falta, CloudFormation genera uno. Sustituir un recurso con nombre fijo no es posible. */
  named?: string;
  /** Propiedades cuyo cambio obliga a crear un recurso nuevo (sustitución). */
  replace: string[];
  attrs: string[];
  /** 'IAM' | 'NAMED_IAM': capacidades que exige. */
  iam?: boolean;
  create(c: PCtx, p: Props): Live;
  update?(c: PCtx, cur: Live, nu: Props, old: Props): Live;
  remove(c: PCtx, cur: Live, p: Props): void;
}

const REG: Record<string, Provider> = {};
const def = (p: Provider) => { REG[p.type] = p; };
export const providerOf = (t: string): Provider | undefined => REG[t];
export const supportedTypes = () => Object.keys(REG).sort();

const acct = (c: PCtx) => c.ctx.s.account.id;
const region = (c: PCtx) => c.ctx.region;
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const tagsOf = (c: PCtx, p: Props) => [...c.tags, ...arr<{ Key: string; Value: string }>(p.Tags).map((t) => ({ Key: String(t.Key), Value: String(t.Value ?? '') }))];
const tagMap = (t: { Key: string; Value: string }[]) => Object.fromEntries(t.map((x) => [x.Key, x.Value]));
const bool = (v: any, d = false) => (v === undefined ? d : v === true || v === 'true');
const num = (v: any) => (v === undefined ? undefined : Number(v));

/** Nombre físico que genera CloudFormation: pila-recurso-SUFIJO. */
export function genName(c: PCtx, max: number, lower = false): string {
  const rand = randomString(12, lower ? 'abcdefghijklmnopqrstuvwxyz0123456789' : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  const base = `${c.stackName}-${c.logical}`.slice(0, max - 13);
  const n = `${base}-${rand}`;
  return lower ? n.toLowerCase() : n;
}

export function validateProps(pr: Provider, p: Props) {
  const known = new Set([...pr.props, ...(pr.noop ?? [])]);
  const bad = Object.keys(p).filter((k) => !known.has(k));
  const missing = (pr.required ?? []).filter((k) => p[k] === undefined || p[k] === null || p[k] === '');
  const errs = [...missing.map((k) => `The property {/${k}} is required`), ...(bad.length ? [`Encountered unsupported properties in {/}: [${bad.join(', ')}]`] : [])];
  if (errs.length) throw new PropError(`Property validation failure: [${errs.join(', ')}]`);
}

/** Resuelve una política: acepta objeto o texto JSON. */
const doc = (v: any) => (typeof v === 'string' ? v : JSON.stringify(v));

function advance(c: PCtx, id: string) {
  const i = c.ctx.s.instances.find((x) => x.id === id);
  if (i?.transition) i.transition.at = now();
  ec2.settle(c.ctx.s);
}

// ------------------------------------------------------------------ S3

def({
  type: 'AWS::S3::Bucket', service: 'Amazon S3', named: 'BucketName',
  props: ['BucketName', 'Tags', 'VersioningConfiguration', 'BucketEncryption', 'PublicAccessBlockConfiguration', 'WebsiteConfiguration'],
  noop: ['AccessControl', 'LifecycleConfiguration', 'CorsConfiguration', 'LoggingConfiguration', 'NotificationConfiguration', 'ObjectLockEnabled', 'OwnershipControls', 'ReplicationConfiguration', 'IntelligentTieringConfigurations', 'MetricsConfigurations', 'AnalyticsConfigurations', 'InventoryConfigurations', 'ObjectLockConfiguration', 'AccelerateConfiguration'],
  replace: ['BucketName'], attrs: ['Arn', 'DomainName', 'RegionalDomainName', 'WebsiteURL', 'DualStackDomainName'],
  create(c, p) {
    const name = p.BucketName ?? genName(c, 63, true);
    s3.createBucket(c.ctx, { Bucket: name, Region: region(c) });
    this.update!(c, { id: name, attrs: {} }, p, {});
    return { id: name, attrs: { Arn: `arn:aws:s3:::${name}`, DomainName: `${name}.s3.amazonaws.com`, RegionalDomainName: `${name}.s3.${region(c)}.amazonaws.com`, DualStackDomainName: `${name}.s3.dualstack.${region(c)}.amazonaws.com`, WebsiteURL: `http://${name}.s3-website-${region(c)}.amazonaws.com` } };
  },
  update(c, cur, p, old) {
    const same = (k: string) => JSON.stringify(p[k]) === JSON.stringify(old[k]);
    const tags = tagMap(tagsOf(c, p));
    if (JSON.stringify(tags) !== JSON.stringify(tagMap(tagsOf(c, old))) || !Object.keys(old).length) if (Object.keys(tags).length) s3.putBucketTagging(c.ctx, { Bucket: cur.id, Tags: tags });
    if (!same('VersioningConfiguration') && p.VersioningConfiguration?.Status) s3.putBucketVersioning(c.ctx, { Bucket: cur.id, Status: p.VersioningConfiguration.Status === 'Enabled' ? 'Enabled' : 'Suspended' });
    if (!same('BucketEncryption') && p.BucketEncryption) {
      const d = arr<any>(p.BucketEncryption.ServerSideEncryptionConfiguration)[0]?.ServerSideEncryptionByDefault;
      if (d) s3.putBucketEncryption(c.ctx, { Bucket: cur.id, Algorithm: d.SSEAlgorithm === 'aws:kms' ? 'aws:kms' : 'AES256', KmsKeyId: d.KMSMasterKeyID });
    }
    if (!same('PublicAccessBlockConfiguration') && p.PublicAccessBlockConfiguration) {
      const b = p.PublicAccessBlockConfiguration;
      s3.putPublicAccessBlock(c.ctx, { Bucket: cur.id, BlockPublicAcls: bool(b.BlockPublicAcls), IgnorePublicAcls: bool(b.IgnorePublicAcls), BlockPublicPolicy: bool(b.BlockPublicPolicy), RestrictPublicBuckets: bool(b.RestrictPublicBuckets) });
    }
    if (!same('WebsiteConfiguration') && p.WebsiteConfiguration?.IndexDocument) s3.putBucketWebsite(c.ctx, { Bucket: cur.id, IndexDocument: p.WebsiteConfiguration.IndexDocument, ErrorDocument: p.WebsiteConfiguration.ErrorDocument });
    return cur;
  },
  remove(c, cur) { s3.deleteBucket(c.ctx, { Bucket: cur.id }); },
});

def({
  type: 'AWS::S3::BucketPolicy', service: 'Amazon S3', props: ['Bucket', 'PolicyDocument'], required: ['Bucket', 'PolicyDocument'], replace: ['Bucket'], attrs: [],
  create(c, p) { s3.putBucketPolicy(c.ctx, { Bucket: p.Bucket, Policy: doc(p.PolicyDocument) }); return { id: `${c.stackName}-${c.logical}-${randomString(12, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')}`, attrs: {} }; },
  update(c, cur, p) { s3.putBucketPolicy(c.ctx, { Bucket: p.Bucket, Policy: doc(p.PolicyDocument) }); return cur; },
  remove(c, _cur, p) { if (c.ctx.s.buckets.some((b) => b.name === p.Bucket)) s3.deleteBucketPolicy(c.ctx, { Bucket: p.Bucket }); },
});

// ------------------------------------------------------------------ VPC y EC2

def({
  type: 'AWS::EC2::VPC', service: 'AmazonEC2', props: ['CidrBlock', 'EnableDnsSupport', 'EnableDnsHostnames', 'InstanceTenancy', 'Tags'], noop: ['Ipv4IpamPoolId', 'Ipv4NetmaskLength'], required: ['CidrBlock'],
  replace: ['CidrBlock', 'InstanceTenancy'], attrs: ['CidrBlock', 'DefaultNetworkAcl', 'DefaultSecurityGroup', 'Ipv6CidrBlocks'],
  create(c, p) {
    const v = ec2.createVpc(c.ctx, { CidrBlock: p.CidrBlock, Tags: tagsOf(c, p) });
    if (p.EnableDnsHostnames !== undefined || p.EnableDnsSupport !== undefined) ec2.modifyVpcAttribute(c.ctx, { VpcId: v.id, EnableDnsHostnames: bool(p.EnableDnsHostnames), EnableDnsSupport: bool(p.EnableDnsSupport, true) });
    return { id: v.id, attrs: { CidrBlock: v.cidr, DefaultNetworkAcl: v.defaultNetworkAclId, DefaultSecurityGroup: v.defaultSecurityGroupId, Ipv6CidrBlocks: '' } };
  },
  update(c, cur, p) { ec2.modifyVpcAttribute(c.ctx, { VpcId: cur.id, EnableDnsHostnames: bool(p.EnableDnsHostnames), EnableDnsSupport: bool(p.EnableDnsSupport, true) }); retag(c, cur.id, p); return cur; },
  remove(c, cur) { ec2.deleteVpc(c.ctx, { VpcId: cur.id }); },
});

/** Sincroniza las etiquetas de un recurso de EC2 con las de la plantilla. */
function retag(c: PCtx, id: string, p: Props) {
  const all: { id: string; tags: Record<string, string> }[] = [...c.ctx.s.vpcs, ...c.ctx.s.subnets, ...c.ctx.s.securityGroups, ...c.ctx.s.internetGateways, ...c.ctx.s.instances, ...c.ctx.s.routeTables];
  const r = all.find((x) => x.id === id);
  if (!r) return;
  const want = tagsOf(c, p);
  const gone = Object.keys(r.tags).filter((k) => !want.some((t) => t.Key === k));
  if (gone.length) ec2.deleteTags(c.ctx, { Resources: [id], Tags: gone.map((Key) => ({ Key })) });
  if (want.length) ec2.createTags(c.ctx, { Resources: [id], Tags: want });
}

def({
  type: 'AWS::EC2::Subnet', service: 'AmazonEC2', props: ['VpcId', 'CidrBlock', 'AvailabilityZone', 'MapPublicIpOnLaunch', 'Tags'], required: ['VpcId'], replace: ['VpcId', 'CidrBlock', 'AvailabilityZone'],
  attrs: ['AvailabilityZone', 'SubnetId', 'VpcId', 'NetworkAclAssociationId', 'Ipv6CidrBlocks'],
  create(c, p) {
    const s = ec2.createSubnet(c.ctx, { VpcId: p.VpcId, CidrBlock: p.CidrBlock, AvailabilityZone: p.AvailabilityZone, Tags: tagsOf(c, p) });
    if (bool(p.MapPublicIpOnLaunch)) ec2.modifySubnetAttribute(c.ctx, { SubnetId: s.id, MapPublicIpOnLaunch: true });
    return { id: s.id, attrs: { AvailabilityZone: s.az, SubnetId: s.id, VpcId: s.vpcId, NetworkAclAssociationId: '', Ipv6CidrBlocks: '' } };
  },
  update(c, cur, p) { ec2.modifySubnetAttribute(c.ctx, { SubnetId: cur.id, MapPublicIpOnLaunch: bool(p.MapPublicIpOnLaunch) }); retag(c, cur.id, p); return cur; },
  remove(c, cur) { ec2.deleteSubnet(c.ctx, { SubnetId: cur.id }); },
});

def({
  type: 'AWS::EC2::InternetGateway', service: 'AmazonEC2', props: ['Tags'], replace: [], attrs: ['InternetGatewayId'],
  create(c, p) { const g = ec2.createInternetGateway(c.ctx, { Tags: tagsOf(c, p) }); return { id: g.id, attrs: { InternetGatewayId: g.id } }; },
  update(c, cur, p) { retag(c, cur.id, p); return cur; },
  remove(c, cur) { ec2.deleteInternetGateway(c.ctx, { InternetGatewayId: cur.id }); },
});

def({
  type: 'AWS::EC2::VPCGatewayAttachment', service: 'AmazonEC2', props: ['VpcId', 'InternetGatewayId'], required: ['VpcId'], replace: ['VpcId', 'InternetGatewayId'], attrs: [],
  create(c, p) {
    if (!p.InternetGatewayId) throw new PropError('Property validation failure: [The property {/InternetGatewayId} is required]');
    ec2.attachInternetGateway(c.ctx, { InternetGatewayId: p.InternetGatewayId, VpcId: p.VpcId });
    return { id: `${c.stackName.slice(0, 20)}-${c.logical.slice(0, 8)}-${hex(12).toUpperCase()}`, attrs: {} };
  },
  remove(c, _cur, p) { if (c.ctx.s.internetGateways.some((g) => g.id === p.InternetGatewayId && g.attachedVpcId === p.VpcId)) ec2.detachInternetGateway(c.ctx, { InternetGatewayId: p.InternetGatewayId, VpcId: p.VpcId }); },
});

def({
  type: 'AWS::EC2::RouteTable', service: 'AmazonEC2', props: ['VpcId', 'Tags'], required: ['VpcId'], replace: ['VpcId'], attrs: ['RouteTableId'],
  create(c, p) { const r = ec2.createRouteTable(c.ctx, { VpcId: p.VpcId, Tags: tagsOf(c, p) }); return { id: r.id, attrs: { RouteTableId: r.id } }; },
  update(c, cur, p) { retag(c, cur.id, p); return cur; },
  remove(c, cur) { ec2.deleteRouteTable(c.ctx, { RouteTableId: cur.id }); },
});

def({
  type: 'AWS::EC2::Route', service: 'AmazonEC2', props: ['RouteTableId', 'DestinationCidrBlock', 'GatewayId', 'NatGatewayId'], required: ['RouteTableId', 'DestinationCidrBlock'], replace: ['RouteTableId', 'DestinationCidrBlock'], attrs: [],
  create(c, p) {
    ec2.createRoute(c.ctx, { RouteTableId: p.RouteTableId, DestinationCidrBlock: p.DestinationCidrBlock, GatewayId: p.GatewayId, NatGatewayId: p.NatGatewayId });
    return { id: `${p.RouteTableId}|${p.DestinationCidrBlock}`, attrs: {} };
  },
  remove(c, _cur, p) { if (c.ctx.s.routeTables.some((r) => r.id === p.RouteTableId)) ec2.deleteRoute(c.ctx, { RouteTableId: p.RouteTableId, DestinationCidrBlock: p.DestinationCidrBlock }); },
});

def({
  type: 'AWS::EC2::SubnetRouteTableAssociation', service: 'AmazonEC2', props: ['SubnetId', 'RouteTableId'], required: ['SubnetId', 'RouteTableId'], replace: ['SubnetId', 'RouteTableId'], attrs: ['Id'],
  create(c, p) { const id = ec2.associateRouteTable(c.ctx, { RouteTableId: p.RouteTableId, SubnetId: p.SubnetId }); return { id, attrs: { Id: id } }; },
  remove(c, cur) { try { ec2.disassociateRouteTable(c.ctx, { AssociationId: cur.id }); } catch (e) { if (!(e instanceof AwsError) || !/NotFound|InvalidAssociationID/.test(e.code)) throw e; } },
});

const perms = (rules: any[] = []) => arr<any>(rules).map((r) => ({
  IpProtocol: String(r.IpProtocol), ...(String(r.IpProtocol) === '-1' ? {} : { FromPort: num(r.FromPort), ToPort: num(r.ToPort) }),
  ...(r.CidrIp ? { CidrIp: r.CidrIp } : {}), ...(r.SourceSecurityGroupId ? { SourceSecurityGroupId: r.SourceSecurityGroupId } : {}), ...(r.Description ? { Description: r.Description } : {}),
}));
const sgRules = (rules: any[]) => rules.map((r) => ({ IpProtocol: r.protocol, ...(r.protocol === '-1' ? {} : { FromPort: r.from, ToPort: r.to }), ...(r.cidr ? { CidrIp: r.cidr } : {}), ...(r.sourceSg ? { SourceSecurityGroupId: r.sourceSg } : {}), ...(r.description ? { Description: r.description } : {}) }));

def({
  type: 'AWS::EC2::SecurityGroup', service: 'AmazonEC2', named: 'GroupName', props: ['GroupDescription', 'GroupName', 'VpcId', 'SecurityGroupIngress', 'SecurityGroupEgress', 'Tags'], required: ['GroupDescription'],
  replace: ['GroupDescription', 'GroupName', 'VpcId'], attrs: ['GroupId', 'VpcId'],
  create(c, p) {
    const g = ec2.createSecurityGroup(c.ctx, { GroupName: p.GroupName ?? genName(c, 255), Description: p.GroupDescription, VpcId: p.VpcId, Tags: tagsOf(c, p) });
    this.update!(c, { id: g.id, attrs: {} }, p, {});
    return { id: g.id, attrs: { GroupId: g.id, VpcId: g.vpcId } };
  },
  update(c, cur, p, old) {
    const g = c.ctx.s.securityGroups.find((x) => x.id === cur.id);
    if (g && p.SecurityGroupIngress !== undefined && JSON.stringify(p.SecurityGroupIngress) !== JSON.stringify(old.SecurityGroupIngress)) {
      if (g.ingress.length) ec2.revokeSecurityGroupIngress(c.ctx, { GroupId: g.id, IpPermissions: sgRules(g.ingress) });
      if (arr(p.SecurityGroupIngress).length) ec2.authorizeSecurityGroupIngress(c.ctx, { GroupId: g.id, IpPermissions: perms(p.SecurityGroupIngress) });
    }
    if (g && p.SecurityGroupEgress !== undefined && JSON.stringify(p.SecurityGroupEgress) !== JSON.stringify(old.SecurityGroupEgress)) {
      if (g.egress.length) ec2.revokeSecurityGroupEgress(c.ctx, { GroupId: g.id, IpPermissions: sgRules(g.egress) });
      if (arr(p.SecurityGroupEgress).length) ec2.authorizeSecurityGroupEgress(c.ctx, { GroupId: g.id, IpPermissions: perms(p.SecurityGroupEgress) });
    }
    retag(c, cur.id, p);
    const gg = c.ctx.s.securityGroups.find((x) => x.id === cur.id);
    return { id: cur.id, attrs: { GroupId: cur.id, VpcId: gg?.vpcId ?? '' } };
  },
  remove(c, cur) { ec2.deleteSecurityGroup(c.ctx, { GroupId: cur.id }); },
});

def({
  type: 'AWS::EC2::Instance', service: 'AmazonEC2', props: ['ImageId', 'InstanceType', 'SubnetId', 'SecurityGroupIds', 'KeyName', 'IamInstanceProfile', 'UserData', 'Tags', 'NetworkInterfaces', 'BlockDeviceMappings', 'MetadataOptions'],
  noop: ['Monitoring', 'DisableApiTermination', 'EbsOptimized', 'AvailabilityZone', 'PrivateIpAddress', 'SecurityGroups', 'Tenancy', 'InstanceInitiatedShutdownBehavior', 'Volumes', 'CreditSpecification', 'HibernationOptions'],
  required: ['ImageId'], replace: ['ImageId', 'SubnetId', 'KeyName', 'NetworkInterfaces', 'UserData', 'AvailabilityZone'], attrs: ['AvailabilityZone', 'PrivateDnsName', 'PrivateIp', 'PublicDnsName', 'PublicIp'],
  create(c, p) {
    const ni = arr<any>(p.NetworkInterfaces)[0];
    const [i] = ec2.runInstances(c.ctx, {
      ImageId: p.ImageId, InstanceType: p.InstanceType, SubnetId: p.SubnetId ?? ni?.SubnetId, SecurityGroupIds: p.SecurityGroupIds ?? ni?.GroupSet, KeyName: p.KeyName, IamInstanceProfile: p.IamInstanceProfile,
      UserData: p.UserData, AssociatePublicIpAddress: ni?.AssociatePublicIpAddress !== undefined ? bool(ni.AssociatePublicIpAddress) : undefined, Tags: tagsOf(c, p), HttpTokens: p.MetadataOptions?.HttpTokens,
      VolumeSize: num(arr<any>(p.BlockDeviceMappings)[0]?.Ebs?.VolumeSize), Encrypted: arr<any>(p.BlockDeviceMappings)[0]?.Ebs?.Encrypted !== undefined ? bool(arr<any>(p.BlockDeviceMappings)[0].Ebs.Encrypted) : undefined,
    });
    return { id: i.id, attrs: liveAttrs(i) };
  },
  update(c, cur, p) {
    const i = c.ctx.s.instances.find((x) => x.id === cur.id);
    if (i) {
      if (p.InstanceType) i.type = p.InstanceType;
      const sg = p.SecurityGroupIds ?? arr<any>(p.NetworkInterfaces)[0]?.GroupSet;
      if (sg) i.securityGroupIds = [...sg];
    }
    retag(c, cur.id, p);
    return { id: cur.id, attrs: i ? liveAttrs(i) : cur.attrs };
  },
  remove(c, cur) { ec2.terminateInstances(c.ctx, { InstanceIds: [cur.id] }); advance(c, cur.id); },
});
const liveAttrs = (i: { az: string; privateIp: string; publicIp?: string; region: string }) => ({
  AvailabilityZone: i.az, PrivateIp: i.privateIp, PublicIp: i.publicIp ?? '',
  PrivateDnsName: `ip-${i.privateIp.replace(/\./g, '-')}.${i.region === 'us-east-1' ? 'ec2.internal' : i.region + '.compute.internal'}`,
  PublicDnsName: i.publicIp ? `ec2-${i.publicIp.replace(/\./g, '-')}.${i.region === 'us-east-1' ? 'compute-1' : i.region + '.compute'}.amazonaws.com` : '',
});

// ------------------------------------------------------------------ IAM

const inlinePolicies = (c: PCtx, who: { RoleName?: string; UserName?: string }, pols: any[]) => {
  for (const pol of pols) {
    if (who.RoleName) iam.putRolePolicy(c.ctx, { RoleName: who.RoleName, PolicyName: pol.PolicyName, PolicyDocument: doc(pol.PolicyDocument) });
    else iam.putUserPolicy(c.ctx, { UserName: who.UserName!, PolicyName: pol.PolicyName, PolicyDocument: doc(pol.PolicyDocument) });
  }
};

def({
  type: 'AWS::IAM::Role', service: 'AmazonIdentityManagement', named: 'RoleName', iam: true,
  props: ['AssumeRolePolicyDocument', 'RoleName', 'ManagedPolicyArns', 'Policies', 'Path', 'Description', 'MaxSessionDuration', 'Tags'], noop: ['PermissionsBoundary'], required: ['AssumeRolePolicyDocument'],
  replace: ['RoleName', 'Path'], attrs: ['Arn', 'RoleId'],
  create(c, p) {
    const name = p.RoleName ?? genName(c, 64);
    const r = iam.createRole(c.ctx, { RoleName: name, AssumeRolePolicyDocument: doc(p.AssumeRolePolicyDocument), Path: p.Path, Description: p.Description, MaxSessionDuration: num(p.MaxSessionDuration), Tags: tagsOf(c, p).filter((t) => !t.Key.startsWith('aws:')) });
    for (const arn of arr<string>(p.ManagedPolicyArns)) iam.attachRolePolicy(c.ctx, { RoleName: name, PolicyArn: arn });
    inlinePolicies(c, { RoleName: name }, arr(p.Policies));
    return { id: name, attrs: { Arn: r.arn, RoleId: r.id } };
  },
  update(c, cur, p, old) {
    const r = c.ctx.s.roles.find((x) => x.name === cur.id)!;
    if (JSON.stringify(p.AssumeRolePolicyDocument) !== JSON.stringify(old.AssumeRolePolicyDocument)) iam.updateAssumeRolePolicy(c.ctx, { RoleName: cur.id, PolicyDocument: doc(p.AssumeRolePolicyDocument) });
    const want = arr<string>(p.ManagedPolicyArns);
    for (const a of r.attached.filter((x) => !want.includes(x))) iam.detachRolePolicy(c.ctx, { RoleName: cur.id, PolicyArn: a });
    for (const a of want.filter((x) => !r.attached.includes(x))) iam.attachRolePolicy(c.ctx, { RoleName: cur.id, PolicyArn: a });
    const pols = arr<any>(p.Policies);
    for (const n of Object.keys(r.inline).filter((n) => !pols.some((x) => x.PolicyName === n))) iamx.deleteRolePolicy(c.ctx, { RoleName: cur.id, PolicyName: n });
    inlinePolicies(c, { RoleName: cur.id }, pols);
    return cur;
  },
  remove(c, cur) {
    const r = c.ctx.s.roles.find((x) => x.name === cur.id);
    if (r) {
      for (const a of [...r.attached]) iam.detachRolePolicy(c.ctx, { RoleName: r.name, PolicyArn: a });
      for (const n of Object.keys(r.inline)) iamx.deleteRolePolicy(c.ctx, { RoleName: r.name, PolicyName: n });
    }
    iam.deleteRole(c.ctx, { RoleName: cur.id });
  },
});

def({
  type: 'AWS::IAM::User', service: 'AmazonIdentityManagement', named: 'UserName', iam: true, props: ['UserName', 'ManagedPolicyArns', 'Policies', 'Path', 'Groups', 'Tags'], noop: ['LoginProfile', 'PermissionsBoundary'],
  replace: ['UserName', 'Path'], attrs: ['Arn'],
  create(c, p) {
    const name = p.UserName ?? genName(c, 64);
    const u = iam.createUser(c.ctx, { UserName: name, Path: p.Path, Tags: tagsOf(c, p).filter((t) => !t.Key.startsWith('aws:')) });
    for (const arn of arr<string>(p.ManagedPolicyArns)) iam.attachUserPolicy(c.ctx, { UserName: name, PolicyArn: arn });
    for (const g of arr<string>(p.Groups)) iam.addUserToGroup(c.ctx, { GroupName: g, UserName: name });
    inlinePolicies(c, { UserName: name }, arr(p.Policies));
    return { id: name, attrs: { Arn: u.arn } };
  },
  update(c, cur, p) {
    const u = c.ctx.s.users.find((x) => x.name === cur.id)!;
    const want = arr<string>(p.ManagedPolicyArns);
    for (const a of u.attached.filter((x) => !want.includes(x))) iam.detachUserPolicy(c.ctx, { UserName: cur.id, PolicyArn: a });
    for (const a of want.filter((x) => !u.attached.includes(x))) iam.attachUserPolicy(c.ctx, { UserName: cur.id, PolicyArn: a });
    const pols = arr<any>(p.Policies);
    for (const n of Object.keys(u.inline).filter((n) => !pols.some((x) => x.PolicyName === n))) iamx.deleteUserPolicy(c.ctx, { UserName: cur.id, PolicyName: n });
    inlinePolicies(c, { UserName: cur.id }, pols);
    return cur;
  },
  remove(c, cur) {
    const u = c.ctx.s.users.find((x) => x.name === cur.id);
    if (u) {
      for (const a of [...u.attached]) iam.detachUserPolicy(c.ctx, { UserName: u.name, PolicyArn: a });
      for (const n of Object.keys(u.inline)) iamx.deleteUserPolicy(c.ctx, { UserName: u.name, PolicyName: n });
      for (const g of c.ctx.s.groups.filter((x) => x.members.includes(u.name))) iam.removeUserFromGroup(c.ctx, { GroupName: g.name, UserName: u.name });
    }
    iam.deleteUser(c.ctx, { UserName: cur.id });
  },
});

def({
  type: 'AWS::IAM::Policy', service: 'AmazonIdentityManagement', iam: true, props: ['PolicyName', 'PolicyDocument', 'Roles', 'Users'], noop: ['Groups'], required: ['PolicyName', 'PolicyDocument'], replace: ['PolicyName'], attrs: [],
  create(c, p) {
    for (const r of arr<string>(p.Roles)) iam.putRolePolicy(c.ctx, { RoleName: r, PolicyName: p.PolicyName, PolicyDocument: doc(p.PolicyDocument) });
    for (const u of arr<string>(p.Users)) iam.putUserPolicy(c.ctx, { UserName: u, PolicyName: p.PolicyName, PolicyDocument: doc(p.PolicyDocument) });
    return { id: p.PolicyName, attrs: {} };
  },
  update(c, cur, p, old) {
    for (const r of arr<string>(old.Roles).filter((x) => !arr(p.Roles).includes(x))) if (c.ctx.s.roles.some((x) => x.name === r)) iamx.deleteRolePolicy(c.ctx, { RoleName: r, PolicyName: old.PolicyName });
    for (const u of arr<string>(old.Users).filter((x) => !arr(p.Users).includes(x))) if (c.ctx.s.users.some((x) => x.name === u)) iamx.deleteUserPolicy(c.ctx, { UserName: u, PolicyName: old.PolicyName });
    return this.create(c, p);
  },
  remove(c, _cur, p) {
    for (const r of arr<string>(p.Roles)) if (c.ctx.s.roles.some((x) => x.name === r)) iamx.deleteRolePolicy(c.ctx, { RoleName: r, PolicyName: p.PolicyName });
    for (const u of arr<string>(p.Users)) if (c.ctx.s.users.some((x) => x.name === u)) iamx.deleteUserPolicy(c.ctx, { UserName: u, PolicyName: p.PolicyName });
  },
});

def({
  type: 'AWS::IAM::ManagedPolicy', service: 'AmazonIdentityManagement', named: 'ManagedPolicyName', iam: true, props: ['ManagedPolicyName', 'PolicyDocument', 'Roles', 'Users', 'Description', 'Path'], noop: ['Groups'], required: ['PolicyDocument'],
  replace: ['ManagedPolicyName', 'Path'], attrs: [],
  create(c, p) {
    const pol = iam.createPolicy(c.ctx, { PolicyName: p.ManagedPolicyName ?? genName(c, 128), PolicyDocument: doc(p.PolicyDocument), Path: p.Path, Description: p.Description });
    for (const r of arr<string>(p.Roles)) iam.attachRolePolicy(c.ctx, { RoleName: r, PolicyArn: pol.arn });
    for (const u of arr<string>(p.Users)) iam.attachUserPolicy(c.ctx, { UserName: u, PolicyArn: pol.arn });
    return { id: pol.arn, attrs: {} };
  },
  update(c, cur, p) { iamx.createPolicyVersion(c.ctx, { PolicyArn: cur.id, PolicyDocument: doc(p.PolicyDocument), SetAsDefault: true }); return cur; },
  remove(c, cur) {
    for (const r of c.ctx.s.roles.filter((x) => x.attached.includes(cur.id))) iam.detachRolePolicy(c.ctx, { RoleName: r.name, PolicyArn: cur.id });
    for (const u of c.ctx.s.users.filter((x) => x.attached.includes(cur.id))) iam.detachUserPolicy(c.ctx, { UserName: u.name, PolicyArn: cur.id });
    iam.deletePolicy(c.ctx, { PolicyArn: cur.id });
  },
});

def({
  type: 'AWS::IAM::InstanceProfile', service: 'AmazonIdentityManagement', named: 'InstanceProfileName', iam: true, props: ['Roles', 'InstanceProfileName', 'Path'], required: ['Roles'], replace: ['InstanceProfileName', 'Path', 'Roles'], attrs: ['Arn'],
  create(c, p) {
    const name = p.InstanceProfileName ?? genName(c, 128);
    const ip = iam.createInstanceProfile(c.ctx, { InstanceProfileName: name });
    for (const r of arr<string>(p.Roles)) iam.addRoleToInstanceProfile(c.ctx, { InstanceProfileName: name, RoleName: r });
    return { id: name, attrs: { Arn: ip.arn } };
  },
  remove(c, cur) { c.ctx.s.instanceProfiles = c.ctx.s.instanceProfiles.filter((x) => x.name !== cur.id); },
});

// ------------------------------------------------------------------ KMS, Secrets Manager

def({
  type: 'AWS::KMS::Key', service: 'AWSKMS', props: ['Description', 'KeyPolicy', 'EnableKeyRotation', 'Enabled', 'PendingWindowInDays', 'Tags'], noop: ['KeySpec', 'KeyUsage', 'MultiRegion', 'RotationPeriodInDays'],
  replace: [], attrs: ['Arn', 'KeyId'],
  create(c, p) {
    const k = kms.createKey(c.ctx, { Description: p.Description, Policy: p.KeyPolicy === undefined ? undefined : doc(p.KeyPolicy), Tags: tagsOf(c, p).filter((t) => !t.Key.startsWith('aws:')).map((t) => ({ TagKey: t.Key, TagValue: t.Value })) });
    if (bool(p.EnableKeyRotation)) kms.setRotation(c.ctx, { KeyId: k.id }, true);
    if (p.Enabled !== undefined && !bool(p.Enabled)) kms.setKeyEnabled(c.ctx, { KeyId: k.id }, false);
    return { id: k.id, attrs: { Arn: k.arn, KeyId: k.id } };
  },
  update(c, cur, p) {
    kms.setRotation(c.ctx, { KeyId: cur.id }, bool(p.EnableKeyRotation));
    kms.setKeyEnabled(c.ctx, { KeyId: cur.id }, p.Enabled === undefined ? true : bool(p.Enabled));
    if (p.KeyPolicy !== undefined) kms.putKeyPolicy(c.ctx, { KeyId: cur.id, Policy: doc(p.KeyPolicy) });
    return cur;
  },
  remove(c, cur, p) { kms.scheduleKeyDeletion(c.ctx, { KeyId: cur.id, PendingWindowInDays: num(p.PendingWindowInDays) ?? 30 }); },
});

def({
  type: 'AWS::KMS::Alias', service: 'AWSKMS', props: ['AliasName', 'TargetKeyId'], required: ['AliasName', 'TargetKeyId'], replace: ['AliasName'], attrs: [],
  create(c, p) { kms.createAlias(c.ctx, { AliasName: p.AliasName, TargetKeyId: p.TargetKeyId }); return { id: p.AliasName, attrs: {} }; },
  update(c, cur, p) { kms.updateAlias(c.ctx, { AliasName: cur.id, TargetKeyId: p.TargetKeyId }); return cur; },
  remove(c, cur) { kms.deleteAlias(c.ctx, { AliasName: cur.id }); },
});

def({
  type: 'AWS::SecretsManager::Secret', service: 'AWSSecretsManager', named: 'Name', props: ['Name', 'Description', 'SecretString', 'KmsKeyId', 'GenerateSecretString', 'Tags'], noop: ['ReplicaRegions'],
  replace: ['Name'], attrs: ['Id'],
  create(c, p) {
    const name = p.Name ?? genName(c, 512);
    let value: string | undefined = p.SecretString;
    const g = p.GenerateSecretString;
    if (g) {
      const pw = sm.randomPassword(num(g.PasswordLength) ?? 32, { ExcludeCharacters: g.ExcludeCharacters, ExcludeNumbers: bool(g.ExcludeNumbers), ExcludePunctuation: bool(g.ExcludePunctuation), ExcludeUppercase: bool(g.ExcludeUppercase), ExcludeLowercase: bool(g.ExcludeLowercase), IncludeSpace: bool(g.IncludeSpace), RequireEachIncludedType: bool(g.RequireEachIncludedType, true) });
      if (g.SecretStringTemplate && g.GenerateStringKey) value = JSON.stringify({ ...JSON.parse(g.SecretStringTemplate), [g.GenerateStringKey]: pw });
      else value = pw;
    }
    const r = sm.createSecret(c.ctx, { Name: name, Description: p.Description, KmsKeyId: p.KmsKeyId, SecretString: value, Tags: tagsOf(c, p).map((t) => ({ Key: t.Key, Value: t.Value })) });
    return { id: r.sec.arn, attrs: { Id: r.sec.arn } };
  },
  update(c, cur, p) { sm.updateSecret(c.ctx, { SecretId: cur.id, Description: p.Description, KmsKeyId: p.KmsKeyId, SecretString: p.SecretString }); return cur; },
  remove(c, cur) { sm.deleteSecret(c.ctx, { SecretId: cur.id }); },
});

// ------------------------------------------------------------------ SNS, CloudWatch, Logs

def({
  type: 'AWS::SNS::Topic', service: 'AmazonSNS', named: 'TopicName', props: ['TopicName', 'DisplayName', 'Subscription', 'Tags'], noop: ['KmsMasterKeyId', 'FifoTopic', 'ContentBasedDeduplication'],
  replace: ['TopicName'], attrs: ['TopicArn', 'TopicName'],
  create(c, p) {
    const t = sns.createTopic(c.ctx, { Name: p.TopicName ?? genName(c, 256) });
    if (p.DisplayName) t.displayName = p.DisplayName;
    for (const s of arr<any>(p.Subscription)) sns.subscribe(c.ctx, { TopicArn: t.arn, Protocol: s.Protocol, Endpoint: s.Endpoint });
    return { id: t.arn, attrs: { TopicArn: t.arn, TopicName: t.name } };
  },
  update(c, cur, p) {
    const t = c.ctx.s.topics.find((x) => x.arn === cur.id);
    if (t) {
      t.displayName = p.DisplayName;
      for (const s of arr<any>(p.Subscription)) if (!t.subs.some((x) => x.protocol === s.Protocol && x.endpoint === s.Endpoint)) sns.subscribe(c.ctx, { TopicArn: t.arn, Protocol: s.Protocol, Endpoint: s.Endpoint });
    }
    return cur;
  },
  remove(c, cur) { sns.deleteTopic(c.ctx, { TopicArn: cur.id }); },
});

def({
  type: 'AWS::CloudWatch::Alarm', service: 'AmazonCloudWatch', named: 'AlarmName',
  props: ['AlarmName', 'AlarmDescription', 'MetricName', 'Namespace', 'Statistic', 'Period', 'EvaluationPeriods', 'DatapointsToAlarm', 'Threshold', 'ComparisonOperator', 'Dimensions', 'TreatMissingData', 'Unit', 'AlarmActions', 'OKActions', 'InsufficientDataActions', 'ActionsEnabled'],
  noop: ['ExtendedStatistic', 'Metrics', 'EvaluateLowSampleCountPercentile', 'ThresholdMetricId'], required: ['ComparisonOperator', 'EvaluationPeriods'], replace: ['AlarmName'], attrs: ['Arn'],
  create(c, p) {
    const name = p.AlarmName ?? genName(c, 255);
    cw.putMetricAlarm(c.ctx, {
      AlarmName: name, AlarmDescription: p.AlarmDescription, Namespace: p.Namespace, MetricName: p.MetricName, Dimensions: arr<any>(p.Dimensions).map((d) => ({ Name: d.Name, Value: String(d.Value) })), Statistic: p.Statistic, Period: num(p.Period) as number,
      EvaluationPeriods: num(p.EvaluationPeriods) as number, DatapointsToAlarm: num(p.DatapointsToAlarm), Threshold: num(p.Threshold) as number, ComparisonOperator: p.ComparisonOperator, TreatMissingData: p.TreatMissingData, Unit: p.Unit,
      AlarmActions: arr(p.AlarmActions), OKActions: arr(p.OKActions), InsufficientDataActions: arr(p.InsufficientDataActions), ActionsEnabled: p.ActionsEnabled === undefined ? undefined : bool(p.ActionsEnabled),
    });
    return { id: name, attrs: { Arn: `arn:aws:cloudwatch:${region(c)}:${acct(c)}:alarm:${name}` } };
  },
  update(c, cur, p) { const r = this.create(c, { ...p, AlarmName: cur.id }); return { id: cur.id, attrs: r.attrs }; },
  remove(c, cur) { cw.deleteAlarms(c.ctx, { AlarmNames: [cur.id] }); },
});

def({
  type: 'AWS::Logs::LogGroup', service: 'AWSLogs', named: 'LogGroupName', props: ['LogGroupName', 'RetentionInDays', 'KmsKeyId', 'Tags'], noop: ['LogGroupClass', 'DataProtectionPolicy'], replace: ['LogGroupName'], attrs: ['Arn'],
  create(c, p) {
    const name = p.LogGroupName ?? genName(c, 512);
    lg.createLogGroup(c.ctx, { LogGroupName: name, KmsKeyId: p.KmsKeyId });
    if (p.RetentionInDays !== undefined) lg.putRetentionPolicy(c.ctx, { LogGroupName: name, RetentionInDays: Number(p.RetentionInDays) });
    return { id: name, attrs: { Arn: `arn:aws:logs:${region(c)}:${acct(c)}:log-group:${name}:*` } };
  },
  update(c, cur, p) {
    if (p.RetentionInDays !== undefined) lg.putRetentionPolicy(c.ctx, { LogGroupName: cur.id, RetentionInDays: Number(p.RetentionInDays) });
    else lg.deleteRetentionPolicy(c.ctx, { LogGroupName: cur.id });
    return cur;
  },
  remove(c, cur) { lg.deleteLogGroup(c.ctx, { LogGroupName: cur.id }); },
});

/** Propiedades que la plantilla fija con un nombre propio (no se puede sustituir el recurso). */
export const customName = (pr: Provider, props: Props) => (pr.named && props[pr.named] !== undefined ? String(props[pr.named]) : undefined);
export const NEEDS_IAM = (t: string) => !!REG[t]?.iam;
export const NAMED_IAM_PROP: Record<string, string> = { 'AWS::IAM::Role': 'RoleName', 'AWS::IAM::User': 'UserName', 'AWS::IAM::ManagedPolicy': 'ManagedPolicyName', 'AWS::IAM::InstanceProfile': 'InstanceProfileName' };

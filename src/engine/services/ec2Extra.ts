// EC2 (operaciones complementarias): NACL, volúmenes EBS, instantáneas, estado de instancias, IP elásticas y reglas de SG.
import type { EbsVolume, NetworkAcl, NetworkAclEntry, Snapshot, Tags, SgRule } from '../types';
import { AwsError } from '../errors';
import { authorize, trailed, type Ctx } from '../api';
import { ids } from '../ids';
import { nowIso, hex } from '../util';
import { azsOf } from '../catalog';
import { getVpcOr, getInstanceOr, getSgOr, settle, parseCidr } from './ec2';

const SRC = 'ec2.amazonaws.com';
const arn = (ctx: Ctx, kind: string, id: string) => `arn:aws:ec2:${ctx.region}:${ctx.s.account.id}:${kind}/${id}`;
const tagsOf = (t?: { Key: string; Value: string }[]): Tags => Object.fromEntries((t ?? []).map((x) => [x.Key, x.Value]));
type Filter = { Name: string; Values: string[] };
const match = (filters: Filter[] | undefined, vals: Record<string, string | undefined>, tags: Tags) =>
  (filters ?? []).every((f) => (f.Name.startsWith('tag:') ? f.Values.includes(tags[f.Name.slice(4)] ?? '\u0000') : f.Values.includes(vals[f.Name] ?? '\u0000')));

// ------------------------------------------------------------------ NACL

const PROTOS: Record<string, string> = { tcp: 'tcp', '6': 'tcp', udp: 'udp', '17': 'udp', icmp: 'icmp', '1': 'icmp', '-1': '-1', all: '-1' };

function aclOr(ctx: Ctx, id: string): NetworkAcl {
  const a = ctx.s.networkAcls.find((x) => x.id === id && x.region === ctx.region);
  if (!a) throw new AwsError('InvalidNetworkAclID.NotFound', `The networkAcl ID '${id}' does not exist`);
  return a;
}

export function createNetworkAcl(ctx: Ctx, p: { VpcId: string; Tags?: { Key: string; Value: string }[] }): NetworkAcl {
  return trailed(ctx, SRC, 'CreateNetworkAcl', [], p, () => {
    const v = getVpcOr(ctx, p.VpcId);
    authorize(ctx, 'ec2:CreateNetworkAcl', arn(ctx, 'network-acl', '*'));
    const a: NetworkAcl = { id: ids.acl(), vpcId: v.id, region: ctx.region, isDefault: false, entries: [], associations: [], tags: tagsOf(p.Tags) };
    ctx.s.networkAcls.push(a);
    return a;
  });
}

export function describeNetworkAcls(ctx: Ctx, p: { NetworkAclIds?: string[]; Filters?: Filter[] } = {}): NetworkAcl[] {
  return trailed(ctx, SRC, 'DescribeNetworkAcls', [], p, () => {
    authorize(ctx, 'ec2:DescribeNetworkAcls', '*');
    p.NetworkAclIds?.forEach((id) => aclOr(ctx, id));
    return ctx.s.networkAcls.filter((a) => a.region === ctx.region && (!p.NetworkAclIds?.length || p.NetworkAclIds.includes(a.id))).filter((a) =>
      match(p.Filters, { 'vpc-id': a.vpcId, 'network-acl-id': a.id, default: String(a.isDefault), 'association.subnet-id': a.associations[0] }, a.tags) &&
      (!p.Filters?.some((f) => f.Name === 'association.subnet-id') || p.Filters.find((f) => f.Name === 'association.subnet-id')!.Values.some((v) => a.associations.includes(v))),
    );
  });
}

export function createNetworkAclEntry(ctx: Ctx, p: { NetworkAclId: string; RuleNumber: number; Protocol: string; RuleAction: string; Egress: boolean; CidrBlock: string; PortRange?: { From?: number; To?: number } }): void {
  trailed(ctx, SRC, 'CreateNetworkAclEntry', [], p, () => {
    const a = aclOr(ctx, p.NetworkAclId);
    authorize(ctx, 'ec2:CreateNetworkAclEntry', arn(ctx, 'network-acl', a.id));
    if (!(p.RuleNumber >= 1 && p.RuleNumber <= 32766)) throw new AwsError('InvalidParameterValue', `Value (${p.RuleNumber}) for parameter ruleNumber is invalid. Rule number must be between 1 and 32766`);
    const proto = PROTOS[String(p.Protocol).toLowerCase()];
    if (!proto) throw new AwsError('InvalidParameterValue', `Invalid value '${p.Protocol}' for protocol. Unknown protocol.`);
    if (!['allow', 'deny'].includes(p.RuleAction)) throw new AwsError('InvalidParameterValue', `Value (${p.RuleAction}) for parameter ruleAction is invalid. Value must be one of: allow, deny`);
    if (!parseCidr(p.CidrBlock)) throw new AwsError('InvalidParameterValue', `Value (${p.CidrBlock}) for parameter cidrBlock is invalid. This is not a valid CIDR block.`);
    if ((proto === 'tcp' || proto === 'udp') && !p.PortRange) throw new AwsError('InvalidParameterValue', `Invalid value 'null' for portRange. Must specify both from and to ports with TCP/UDP.`);
    if (a.entries.some((e) => e.rule === p.RuleNumber && e.egress === !!p.Egress)) throw new AwsError('NetworkAclEntryAlreadyExists', `The network acl entry identified by ${p.RuleNumber} already exists.`);
    const e: NetworkAclEntry = { rule: p.RuleNumber, protocol: proto, action: p.RuleAction as 'allow' | 'deny', egress: !!p.Egress, cidr: p.CidrBlock };
    if (p.PortRange) {
      e.from = Number(p.PortRange.From);
      e.to = Number(p.PortRange.To);
    }
    a.entries.push(e);
  });
}

export function deleteNetworkAclEntry(ctx: Ctx, p: { NetworkAclId: string; RuleNumber: number; Egress: boolean }): void {
  trailed(ctx, SRC, 'DeleteNetworkAclEntry', [], p, () => {
    const a = aclOr(ctx, p.NetworkAclId);
    authorize(ctx, 'ec2:DeleteNetworkAclEntry', arn(ctx, 'network-acl', a.id));
    const e = a.entries.find((x) => x.rule === p.RuleNumber && x.egress === !!p.Egress);
    if (!e) throw new AwsError('InvalidNetworkAclEntry.NotFound', `The network acl entry identified by ${p.RuleNumber} does not exist`);
    a.entries = a.entries.filter((x) => x !== e);
  });
}

export function deleteNetworkAcl(ctx: Ctx, p: { NetworkAclId: string }): void {
  trailed(ctx, SRC, 'DeleteNetworkAcl', [], p, () => {
    const a = aclOr(ctx, p.NetworkAclId);
    authorize(ctx, 'ec2:DeleteNetworkAcl', arn(ctx, 'network-acl', a.id));
    if (a.isDefault) throw new AwsError('InvalidParameterValue', `The network ACL '${a.id}' is the default network ACL and cannot be deleted.`);
    if (a.associations.length) throw new AwsError('DependencyViolation', `The networkAcl '${a.id}' has dependencies and cannot be deleted.`);
    ctx.s.networkAcls = ctx.s.networkAcls.filter((x) => x !== a);
  });
}

export function replaceNetworkAclAssociation(ctx: Ctx, p: { AssociationId: string; NetworkAclId: string }): string {
  return trailed(ctx, SRC, 'ReplaceNetworkAclAssociation', [], p, () => {
    const target = aclOr(ctx, p.NetworkAclId);
    authorize(ctx, 'ec2:ReplaceNetworkAclAssociation', arn(ctx, 'network-acl', target.id));
    const subnetId = p.AssociationId.replace(/^aclassoc-/, 'subnet-');
    const sub = ctx.s.subnets.find((s) => s.id === subnetId);
    if (!sub) throw new AwsError('InvalidAssociationID.NotFound', `The association ID '${p.AssociationId}' does not exist`);
    ctx.s.networkAcls.forEach((a) => (a.associations = a.associations.filter((x) => x !== sub.id)));
    if (!target.isDefault) target.associations.push(sub.id);
    return `aclassoc-${sub.id.slice(7)}`;
  });
}

// ------------------------------------------------------------------ volúmenes

const VOLUME_TYPES = ['gp2', 'gp3', 'io1', 'st1', 'sc1'];
const MIN_SIZE: Record<string, number> = { gp2: 1, gp3: 1, io1: 4, st1: 125, sc1: 125 };

function volOr(ctx: Ctx, id: string): EbsVolume {
  const v = ctx.s.volumes.find((x) => x.id === id && x.region === ctx.region);
  if (!v) throw new AwsError('InvalidVolume.NotFound', `The volume '${id}' does not exist.`);
  return v;
}

export function createVolume(ctx: Ctx, p: { AvailabilityZone: string; Size?: number; VolumeType?: string; Encrypted?: boolean; SnapshotId?: string; Tags?: { Key: string; Value: string }[] }): EbsVolume {
  return trailed(ctx, SRC, 'CreateVolume', [], p, () => {
    authorize(ctx, 'ec2:CreateVolume', arn(ctx, 'volume', '*'));
    if (!azsOf(ctx.region).includes(p.AvailabilityZone)) throw new AwsError('InvalidParameterValue', `Value (${p.AvailabilityZone}) for parameter availabilityZone is invalid. Subnets can currently only be created in the following availability zones: ${azsOf(ctx.region).join(', ')}.`);
    const type = (p.VolumeType ?? 'gp2') as EbsVolume['type'];
    if (!VOLUME_TYPES.includes(type)) throw new AwsError('InvalidParameterValue', `Invalid value '${type}' for volumeType.`);
    let size = p.Size;
    const snap = p.SnapshotId ? ctx.s.snapshots.find((x) => x.id === p.SnapshotId && x.region === ctx.region) : undefined;
    if (p.SnapshotId && !snap) throw new AwsError('InvalidSnapshot.NotFound', `The snapshot '${p.SnapshotId}' does not exist.`);
    if (size === undefined) size = snap?.sizeGiB;
    if (size === undefined) throw new AwsError('MissingParameter', 'The request must contain the parameter size or snapshotId');
    if (size < MIN_SIZE[type]) throw new AwsError('InvalidParameterValue', `Volume of ${size}GiB is too small; minimum is ${MIN_SIZE[type]}GiB.`);
    if (size > 16384) throw new AwsError('InvalidParameterValue', `Volume of ${size}GiB is too large; maximum is 16384GiB.`);
    if (snap && size < snap.sizeGiB) throw new AwsError('InvalidParameterValue', `Volume of size ${size}GB is smaller than snapshot '${snap.id}', parameter volumeSize must be at least ${snap.sizeGiB}GB.`);
    const v: EbsVolume = { id: ids.volume(), region: ctx.region, az: p.AvailabilityZone, sizeGiB: size, type, encrypted: !!p.Encrypted || !!snap?.encrypted, state: 'available', snapshotId: p.SnapshotId, deleteOnTermination: false, createdAt: nowIso(), tags: tagsOf(p.Tags) };
    ctx.s.volumes.push(v);
    return v;
  });
}

export function describeVolumes(ctx: Ctx, p: { VolumeIds?: string[]; Filters?: Filter[] } = {}): EbsVolume[] {
  return trailed(ctx, SRC, 'DescribeVolumes', [], p, () => {
    authorize(ctx, 'ec2:DescribeVolumes', '*');
    settle(ctx.s);
    p.VolumeIds?.forEach((id) => volOr(ctx, id));
    return ctx.s.volumes.filter((v) => v.region === ctx.region && (!p.VolumeIds?.length || p.VolumeIds.includes(v.id))).filter((v) =>
      match(p.Filters, { status: v.state, 'volume-type': v.type, 'availability-zone': v.az, 'attachment.instance-id': v.attachedTo, 'volume-id': v.id, encrypted: String(v.encrypted), size: String(v.sizeGiB) }, v.tags),
    );
  });
}

export function attachVolume(ctx: Ctx, p: { VolumeId: string; InstanceId: string; Device: string }) {
  return trailed(ctx, SRC, 'AttachVolume', [], p, () => {
    const v = volOr(ctx, p.VolumeId);
    const i = getInstanceOr(ctx, p.InstanceId);
    authorize(ctx, 'ec2:AttachVolume', arn(ctx, 'volume', v.id));
    if (!/^(\/dev\/(sd[f-p]|xvd[b-z])|\/dev\/xvda)$/.test(p.Device) && !/^\/dev\/sd[a-z]$/.test(p.Device)) throw new AwsError('InvalidParameterValue', `Value (${p.Device}) for parameter device is invalid. ${p.Device} is not a valid EBS device name.`);
    if (i.state === 'terminated') throw new AwsError('IncorrectInstanceState', `Instance '${i.id}' is not in a state from which the volume can be attached.`);
    if (v.az !== i.az) throw new AwsError('InvalidVolume.ZoneMismatch', `The volume '${v.id}' is not in the same availability zone as instance '${i.id}'`);
    if (v.attachedTo) throw new AwsError('VolumeInUse', `${v.id} is already attached to an instance`);
    if (ctx.s.volumes.some((x) => x.attachedTo === i.id && x.device === p.Device) || (p.Device === '/dev/xvda' && i.rootVolumeId)) throw new AwsError('InvalidParameterValue', `Invalid value '${p.Device}' for unixDevice. Attachment point ${p.Device} is already in use`);
    v.attachedTo = i.id;
    v.device = p.Device;
    v.state = 'in-use';
    return { AttachTime: nowIso(), Device: p.Device, InstanceId: i.id, State: 'attaching', VolumeId: v.id };
  });
}

export function detachVolume(ctx: Ctx, p: { VolumeId: string; Force?: boolean }) {
  return trailed(ctx, SRC, 'DetachVolume', [], p, () => {
    const v = volOr(ctx, p.VolumeId);
    authorize(ctx, 'ec2:DetachVolume', arn(ctx, 'volume', v.id));
    if (!v.attachedTo) throw new AwsError('IncorrectState', `Volume '${v.id}' is in the 'available' state.`);
    const inst = ctx.s.instances.find((i) => i.id === v.attachedTo);
    if (inst && inst.rootVolumeId === v.id && inst.state === 'running') throw new AwsError('UnsupportedOperation', `The volume '${v.id}' is the root device of an instance and cannot be detached while it is running.`);
    const out = { AttachTime: v.createdAt, Device: v.device ?? '/dev/xvda', InstanceId: v.attachedTo, State: 'detaching', VolumeId: v.id };
    v.attachedTo = undefined;
    v.device = undefined;
    v.state = 'available';
    return out;
  });
}

export function deleteVolume(ctx: Ctx, p: { VolumeId: string }): void {
  trailed(ctx, SRC, 'DeleteVolume', [], p, () => {
    const v = volOr(ctx, p.VolumeId);
    authorize(ctx, 'ec2:DeleteVolume', arn(ctx, 'volume', v.id));
    if (v.attachedTo) throw new AwsError('VolumeInUse', `Volume ${v.id} is currently attached to ${v.attachedTo}`);
    ctx.s.volumes = ctx.s.volumes.filter((x) => x !== v);
  });
}

// ------------------------------------------------------------------ instantáneas

export function createSnapshot(ctx: Ctx, p: { VolumeId: string; Description?: string; Tags?: { Key: string; Value: string }[] }): Snapshot {
  return trailed(ctx, SRC, 'CreateSnapshot', [], p, () => {
    const v = volOr(ctx, p.VolumeId);
    authorize(ctx, 'ec2:CreateSnapshot', `arn:aws:ec2:${ctx.region}::snapshot/*`);
    const sn: Snapshot = { id: ids.snapshot(), volumeId: v.id, region: ctx.region, sizeGiB: v.sizeGiB, description: p.Description ?? '', encrypted: v.encrypted, startTime: nowIso(), tags: tagsOf(p.Tags) };
    ctx.s.snapshots.push(sn);
    return sn;
  });
}
export function describeSnapshots(ctx: Ctx, p: { SnapshotIds?: string[]; OwnerIds?: string[]; Filters?: Filter[] } = {}): Snapshot[] {
  return trailed(ctx, SRC, 'DescribeSnapshots', [], p, () => {
    authorize(ctx, 'ec2:DescribeSnapshots', '*');
    p.SnapshotIds?.forEach((id) => {
      if (!ctx.s.snapshots.some((x) => x.id === id && x.region === ctx.region)) throw new AwsError('InvalidSnapshot.NotFound', `The snapshot '${id}' does not exist.`);
    });
    return ctx.s.snapshots.filter((x) => x.region === ctx.region && (!p.SnapshotIds?.length || p.SnapshotIds.includes(x.id))).filter((x) => match(p.Filters, { 'volume-id': x.volumeId, status: 'completed', 'snapshot-id': x.id }, x.tags));
  });
}
export function deleteSnapshot(ctx: Ctx, p: { SnapshotId: string }): void {
  trailed(ctx, SRC, 'DeleteSnapshot', [], p, () => {
    authorize(ctx, 'ec2:DeleteSnapshot', `arn:aws:ec2:${ctx.region}::snapshot/${p.SnapshotId}`);
    const sn = ctx.s.snapshots.find((x) => x.id === p.SnapshotId && x.region === ctx.region);
    if (!sn) throw new AwsError('InvalidSnapshot.NotFound', `The snapshot '${p.SnapshotId}' does not exist.`);
    ctx.s.snapshots = ctx.s.snapshots.filter((x) => x !== sn);
  });
}

// ------------------------------------------------------------------ estado de instancias

export function describeInstanceStatus(ctx: Ctx, p: { InstanceIds?: string[]; IncludeAllInstances?: boolean }) {
  return trailed(ctx, SRC, 'DescribeInstanceStatus', [], p, () => {
    authorize(ctx, 'ec2:DescribeInstanceStatus', '*');
    settle(ctx.s);
    p.InstanceIds?.forEach((id) => getInstanceOr(ctx, id));
    return ctx.s.instances.filter((i) => i.region === ctx.region && (!p.InstanceIds?.length || p.InstanceIds.includes(i.id)) && (p.IncludeAllInstances || i.state === 'running'));
  });
}

// ------------------------------------------------------------------ IP elásticas

export function associateAddress(ctx: Ctx, p: { AllocationId: string; InstanceId: string; AllowReassociation?: boolean }): string {
  return trailed(ctx, SRC, 'AssociateAddress', [], p, () => {
    authorize(ctx, 'ec2:AssociateAddress', arn(ctx, 'elastic-ip', p.AllocationId));
    const e = ctx.s.elasticIps.find((x) => x.id === p.AllocationId && x.region === ctx.region);
    if (!e) throw new AwsError('InvalidAllocationID.NotFound', `The allocation ID '${p.AllocationId}' does not exist`);
    const i = getInstanceOr(ctx, p.InstanceId);
    if (i.state === 'terminated') throw new AwsError('InvalidInstanceID', `The instance '${i.id}' is not in a valid state for this operation.`);
    if (e.associatedInstanceId && e.associatedInstanceId !== i.id && p.AllowReassociation === false) throw new AwsError('Resource.AlreadyAssociated', `resource ${e.id} is already associated with associate-id ${e.associationId}`);
    const sub = ctx.s.subnets.find((s) => s.id === i.subnetId)!;
    const igwOk = ctx.s.internetGateways.some((g) => g.attachedVpcId === sub.vpcId);
    if (!igwOk) throw new AwsError('Gateway.NotAttached', `Network ${sub.vpcId} is not attached to any internet gateway`);
    // Si estaba en otra instancia, esta pierde la IP.
    const prev = ctx.s.instances.find((x) => x.id === e.associatedInstanceId);
    if (prev && prev.id !== i.id) prev.publicIp = undefined;
    e.associatedInstanceId = i.id;
    e.associationId = `eipassoc-${hex(17)}`;
    i.publicIp = e.publicIp;
    return e.associationId;
  });
}
export function disassociateAddress(ctx: Ctx, p: { AssociationId: string }): void {
  trailed(ctx, SRC, 'DisassociateAddress', [], p, () => {
    authorize(ctx, 'ec2:DisassociateAddress', '*');
    const e = ctx.s.elasticIps.find((x) => x.associationId === p.AssociationId && x.region === ctx.region);
    if (!e) throw new AwsError('InvalidAssociationID.NotFound', `The association ID '${p.AssociationId}' does not exist`);
    const i = ctx.s.instances.find((x) => x.id === e.associatedInstanceId);
    if (i) i.publicIp = undefined;
    e.associatedInstanceId = undefined;
    e.associationId = undefined;
  });
}

// ------------------------------------------------------------------ reglas de grupos de seguridad

export function describeSecurityGroupRules(ctx: Ctx, p: { Filters?: Filter[]; SecurityGroupRuleIds?: string[] } = {}) {
  return trailed(ctx, SRC, 'DescribeSecurityGroupRules', [], p, () => {
    authorize(ctx, 'ec2:DescribeSecurityGroupRules', '*');
    const out: { group: string; rule: SgRule; egress: boolean }[] = [];
    for (const g of ctx.s.securityGroups.filter((x) => x.region === ctx.region)) {
      for (const r of g.ingress) out.push({ group: g.id, rule: r, egress: false });
      for (const r of g.egress) out.push({ group: g.id, rule: r, egress: true });
    }
    return out.filter((x) => (!p.SecurityGroupRuleIds?.length || p.SecurityGroupRuleIds.includes(x.rule.id))).filter((x) => match(p.Filters, { 'group-id': x.group, 'security-group-rule-id': x.rule.id }, {}));
  });
}
export { getSgOr };

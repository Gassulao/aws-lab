// aws ec2 (operaciones complementarias)
import { defineCommand, type Params } from '../framework';
import * as x from '../../../engine/services/ec2Extra';
import type { CloudState, EbsVolume, NetworkAcl, Snapshot } from '../../../engine/types';
import { tagList } from '../shapes';

const iso = (s: string) => s.replace(/\.\d+Z$/, '+00:00');
const filters = (p: Params) => p.Filters?.map((f: any) => ({ Name: f.Name, Values: Array.isArray(f.Values) ? f.Values : [f.Values] }));
const tagSpec = (p: Params) => p.TagSpecifications?.[0]?.Tags;
const TAGS = { list: ['tag-specifications'], structured: ['tag-specifications'] };
const proto = (p: string) => ({ tcp: '6', udp: '17', icmp: '1', '-1': '-1' }[p] ?? p);
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function aclShape(s: CloudState, a: NetworkAcl) {
  const subs = a.isDefault ? s.subnets.filter((u) => u.vpcId === a.vpcId && !s.networkAcls.some((o) => o !== a && o.associations.includes(u.id))).map((u) => u.id) : a.associations;
  const entry = (e: NetworkAcl['entries'][number]) => strip({ CidrBlock: e.cidr, Egress: e.egress, Protocol: proto(e.protocol), RuleAction: e.action, RuleNumber: e.rule, PortRange: e.from !== undefined ? { From: e.from, To: e.to } : undefined });
  const real = [...a.entries].sort((m, n) => m.rule - n.rule).map(entry);
  const implicit = [false, true].map((egress) => ({ CidrBlock: '0.0.0.0/0', Egress: egress, Protocol: '-1', RuleAction: 'deny', RuleNumber: 32767 }));
  return strip({
    Associations: subs.map((id) => ({ NetworkAclAssociationId: `aclassoc-${id.slice(7)}`, NetworkAclId: a.id, SubnetId: id })),
    Entries: [...real.filter((e) => e.Egress), ...implicit.filter((e) => e.Egress), ...real.filter((e) => !e.Egress), ...implicit.filter((e) => !e.Egress)].sort((m, n) => Number(n.Egress) - Number(m.Egress) || m.RuleNumber - n.RuleNumber),
    IsDefault: a.isDefault, NetworkAclId: a.id, Tags: tagList(a.tags) ?? [], VpcId: a.vpcId, OwnerId: s.account.id,
  });
}

defineCommand({
  service: 'ec2', name: 'create-network-acl', op: 'CreateNetworkAcl', ...TAGS,
  run: (c, p) => ({ NetworkAcl: aclShape(c.s, x.createNetworkAcl(c, { VpcId: p.VpcId, Tags: tagSpec(p) })) }),
});
defineCommand({
  service: 'ec2', name: 'describe-network-acls', op: 'DescribeNetworkAcls', list: ['network-acl-ids', 'filters'], structured: ['filters'],
  run: (c, p) => ({ NetworkAcls: x.describeNetworkAcls(c, { NetworkAclIds: p.NetworkAclIds, Filters: filters(p) }).map((a) => aclShape(c.s, a)) }),
});
defineCommand({
  service: 'ec2', name: 'create-network-acl-entry', op: 'CreateNetworkAclEntry', bool: ['ingress', 'egress'], structured: ['port-range'],
  run: (c, p) => void x.createNetworkAclEntry(c, { NetworkAclId: p.NetworkAclId, RuleNumber: Number(p.RuleNumber), Protocol: String(p.Protocol), RuleAction: p.RuleAction, Egress: !!p.Egress, CidrBlock: p.CidrBlock, PortRange: p.PortRange }),
});
defineCommand({
  service: 'ec2', name: 'delete-network-acl-entry', op: 'DeleteNetworkAclEntry', bool: ['ingress', 'egress'],
  run: (c, p) => void x.deleteNetworkAclEntry(c, { NetworkAclId: p.NetworkAclId, RuleNumber: Number(p.RuleNumber), Egress: !!p.Egress }),
});
defineCommand({ service: 'ec2', name: 'delete-network-acl', op: 'DeleteNetworkAcl', run: (c, p) => void x.deleteNetworkAcl(c, { NetworkAclId: p.NetworkAclId }) });
defineCommand({
  service: 'ec2', name: 'replace-network-acl-association', op: 'ReplaceNetworkAclAssociation',
  run: (c, p) => ({ NewAssociationId: x.replaceNetworkAclAssociation(c, { AssociationId: p.AssociationId, NetworkAclId: p.NetworkAclId }) }),
});

// ---------------------------------------------------------------- volúmenes
const volShape = (v: EbsVolume, s: CloudState, state: string = v.state) => {
  const inst = v.attachedTo ? s.instances.find((i) => i.id === v.attachedTo) : undefined;
  return strip({
    Iops: v.type === 'gp3' ? 3000 : v.type === 'gp2' ? Math.max(100, v.sizeGiB * 3) : undefined,
    Tags: tagList(v.tags) ?? [], VolumeType: v.type, MultiAttachEnabled: false,
    Throughput: v.type === 'gp3' ? 125 : undefined,
    Attachments: v.attachedTo ? [{ AttachTime: iso(v.createdAt), Device: v.device ?? (inst?.rootVolumeId === v.id ? '/dev/xvda' : '/dev/sdf'), InstanceId: v.attachedTo, State: 'attached', VolumeId: v.id, DeleteOnTermination: v.deleteOnTermination }] : [],
    AvailabilityZone: v.az, CreateTime: iso(v.createdAt), Encrypted: v.encrypted, Size: v.sizeGiB, SnapshotId: v.snapshotId ?? '', State: state, VolumeId: v.id,
  });
};
defineCommand({
  service: 'ec2', name: 'create-volume', op: 'CreateVolume', bool: ['encrypted'], ...TAGS,
  run: (c, p) => {
    const v = x.createVolume(c, { AvailabilityZone: p.AvailabilityZone, Size: p.Size !== undefined ? Number(p.Size) : undefined, VolumeType: p.VolumeType, Encrypted: p.Encrypted, SnapshotId: p.SnapshotId, Tags: tagSpec(p) });
    return volShape(v, c.s, 'creating');
  },
});
defineCommand({
  service: 'ec2', name: 'describe-volumes', op: 'DescribeVolumes', list: ['volume-ids', 'filters'], structured: ['filters'],
  run: (c, p) => ({ Volumes: x.describeVolumes(c, { VolumeIds: p.VolumeIds, Filters: filters(p) }).map((v) => volShape(v, c.s)) }),
});
defineCommand({ service: 'ec2', name: 'attach-volume', op: 'AttachVolume', run: (c, p) => x.attachVolume(c, { VolumeId: p.VolumeId, InstanceId: p.InstanceId, Device: p.Device }) as any });
defineCommand({ service: 'ec2', name: 'detach-volume', op: 'DetachVolume', run: (c, p) => x.detachVolume(c, { VolumeId: p.VolumeId }) });
defineCommand({ service: 'ec2', name: 'delete-volume', op: 'DeleteVolume', run: (c, p) => void x.deleteVolume(c, { VolumeId: p.VolumeId }) });

// ---------------------------------------------------------------- instantáneas
const snapShape = (s: CloudState, sn: Snapshot, done: boolean) => ({
  Description: sn.description, Encrypted: sn.encrypted, OwnerId: s.account.id, Progress: done ? '100%' : '', SnapshotId: sn.id, StartTime: iso(sn.startTime),
  State: done ? 'completed' : 'pending', VolumeId: sn.volumeId, VolumeSize: sn.sizeGiB, StorageTier: 'standard', Tags: tagList(sn.tags) ?? [],
});
defineCommand({ service: 'ec2', name: 'create-snapshot', op: 'CreateSnapshot', ...TAGS, run: (c, p) => { const sn = x.createSnapshot(c, { VolumeId: p.VolumeId, Description: p.Description, Tags: tagSpec(p) }); return { ...snapShape(c.s, sn, false), Progress: '' }; } });
defineCommand({
  service: 'ec2', name: 'describe-snapshots', op: 'DescribeSnapshots', list: ['snapshot-ids', 'owner-ids', 'filters'], structured: ['filters'],
  run: (c, p) => ({ Snapshots: x.describeSnapshots(c, { SnapshotIds: p.SnapshotIds, OwnerIds: p.OwnerIds, Filters: filters(p) }).map((sn) => snapShape(c.s, sn, true)) }),
});
defineCommand({ service: 'ec2', name: 'delete-snapshot', op: 'DeleteSnapshot', run: (c, p) => void x.deleteSnapshot(c, { SnapshotId: p.SnapshotId }) });

// ---------------------------------------------------------------- estado de instancias, IP elásticas, reglas de SG
defineCommand({
  service: 'ec2', name: 'describe-instance-status', op: 'DescribeInstanceStatus', list: ['instance-ids'], bool: ['include-all-instances'],
  run: (c, p) => ({
    InstanceStatuses: x.describeInstanceStatus(c, { InstanceIds: p.InstanceIds, IncludeAllInstances: p.IncludeAllInstances }).map((i) => {
      const running = i.state === 'running';
      const st = { Details: [{ Name: 'reachability', Status: running ? 'passed' : 'not-applicable' }], Status: running ? 'ok' : 'not-applicable' };
      return { AvailabilityZone: i.az, InstanceId: i.id, InstanceState: { Code: { pending: 0, running: 16, 'shutting-down': 32, terminated: 48, stopping: 64, stopped: 80 }[i.state], Name: i.state }, InstanceStatus: st, SystemStatus: st };
    }),
  }),
});
defineCommand({ service: 'ec2', name: 'associate-address', op: 'AssociateAddress', bool: ['allow-reassociation'], run: (c, p) => ({ AssociationId: x.associateAddress(c, { AllocationId: p.AllocationId, InstanceId: p.InstanceId, AllowReassociation: p.AllowReassociation }) }) });
defineCommand({ service: 'ec2', name: 'disassociate-address', op: 'DisassociateAddress', run: (c, p) => void x.disassociateAddress(c, { AssociationId: p.AssociationId }) });
defineCommand({
  service: 'ec2', name: 'describe-security-group-rules', op: 'DescribeSecurityGroupRules', list: ['security-group-rule-ids', 'filters'], structured: ['filters'],
  run: (c, p) => ({
    SecurityGroupRules: x.describeSecurityGroupRules(c, { SecurityGroupRuleIds: p.SecurityGroupRuleIds, Filters: filters(p) }).map(({ group, rule, egress }) =>
      strip({
        SecurityGroupRuleId: rule.id, GroupId: group, GroupOwnerId: c.s.account.id, IsEgress: egress, IpProtocol: rule.protocol,
        FromPort: rule.from, ToPort: rule.to, CidrIpv4: rule.cidr, ReferencedGroupInfo: rule.sourceSg ? { GroupId: rule.sourceSg, UserId: c.s.account.id } : undefined,
        Description: rule.description, Tags: [],
      }),
    ),
  }),
});

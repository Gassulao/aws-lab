// aws ec2
import { defineCommand, type Params } from '../framework';
import * as ec2 from '../../../engine/services/ec2';
import { parseCidr } from '../../../engine/services/ec2';
import { vpcShape, subnetShape, igwShape, natShape, rtbShape, sgShape, instanceShape, imageShape } from '../shapes';
import { AwsError } from '../../../engine/errors';

const filters = (p: Params) => p.Filters?.map((f: any) => ({ Name: f.Name, Values: Array.isArray(f.Values) ? f.Values : [f.Values] }));
const tagSpec = (p: Params): { Key: string; Value: string }[] | undefined => p.TagSpecifications?.[0]?.Tags;
const freeIps = (cidr: string) => (parseCidr(cidr) ? 2 ** (32 - parseCidr(cidr)!.bits) - 5 : 0);
const TAGS = { list: ['tag-specifications'], structured: ['tag-specifications'] };

// ---------------------------------------------------------------- VPC y subredes
defineCommand({ service: 'ec2', name: 'create-vpc', op: 'CreateVpc', ...TAGS, run: (c, p) => ({ Vpc: vpcShape(ec2.createVpc(c, { CidrBlock: p.CidrBlock, Tags: tagSpec(p) })) }) });
defineCommand({
  service: 'ec2',
  name: 'describe-vpcs',
  op: 'DescribeVpcs',
  list: ['vpc-ids', 'filters'],
  structured: ['filters'],
  run: (c, p) => ({ Vpcs: ec2.describeVpcs(c, { VpcIds: p.VpcIds, Filters: filters(p) }).map(vpcShape) }),
});
defineCommand({ service: 'ec2', name: 'delete-vpc', op: 'DeleteVpc', run: (c, p) => void ec2.deleteVpc(c, { VpcId: p.VpcId }) });
defineCommand({
  service: 'ec2',
  name: 'modify-vpc-attribute',
  op: 'ModifyVpcAttribute',
  structured: ['enable-dns-hostnames', 'enable-dns-support'],
  run: (c, p) => {
    const flag = (v: any) => (v === undefined ? undefined : typeof v === 'object' ? String(v.Value) === 'true' : String(v) === 'true');
    ec2.modifyVpcAttribute(c, { VpcId: p.VpcId, EnableDnsHostnames: flag(p.EnableDnsHostnames), EnableDnsSupport: flag(p.EnableDnsSupport) });
  },
});

defineCommand({
  service: 'ec2',
  name: 'create-subnet',
  op: 'CreateSubnet',
  ...TAGS,
  run: (c, p) => ({ Subnet: subnetShape(ec2.createSubnet(c, { VpcId: p.VpcId, CidrBlock: p.CidrBlock, AvailabilityZone: p.AvailabilityZone, Tags: tagSpec(p) }), c.s.account.id, freeIps(p.CidrBlock)) }),
});
defineCommand({
  service: 'ec2',
  name: 'describe-subnets',
  op: 'DescribeSubnets',
  list: ['subnet-ids', 'filters'],
  structured: ['filters'],
  run: (c, p) => ({ Subnets: ec2.describeSubnets(c, { SubnetIds: p.SubnetIds, Filters: filters(p) }).map((s) => subnetShape(s, c.s.account.id, freeIps(s.cidr))) }),
});
defineCommand({
  service: 'ec2',
  name: 'modify-subnet-attribute',
  op: 'ModifySubnetAttribute',
  bool: ['map-public-ip-on-launch'],
  run: (c, p) => void ec2.modifySubnetAttribute(c, { SubnetId: p.SubnetId, MapPublicIpOnLaunch: Boolean(p.MapPublicIpOnLaunch) }),
});
defineCommand({ service: 'ec2', name: 'delete-subnet', op: 'DeleteSubnet', run: (c, p) => void ec2.deleteSubnet(c, { SubnetId: p.SubnetId }) });

// ---------------------------------------------------------------- gateways y rutas
defineCommand({ service: 'ec2', name: 'create-internet-gateway', op: 'CreateInternetGateway', ...TAGS, run: (c, p) => ({ InternetGateway: igwShape(ec2.createInternetGateway(c, { Tags: tagSpec(p) })) }) });
defineCommand({ service: 'ec2', name: 'attach-internet-gateway', op: 'AttachInternetGateway', run: (c, p) => void ec2.attachInternetGateway(c, { InternetGatewayId: p.InternetGatewayId, VpcId: p.VpcId }) });
defineCommand({ service: 'ec2', name: 'detach-internet-gateway', op: 'DetachInternetGateway', run: (c, p) => void ec2.detachInternetGateway(c, { InternetGatewayId: p.InternetGatewayId, VpcId: p.VpcId }) });
defineCommand({ service: 'ec2', name: 'delete-internet-gateway', op: 'DeleteInternetGateway', run: (c, p) => void ec2.deleteInternetGateway(c, { InternetGatewayId: p.InternetGatewayId }) });
defineCommand({ service: 'ec2', name: 'describe-internet-gateways', op: 'DescribeInternetGateways', run: (c) => ({ InternetGateways: ec2.describeInternetGateways(c).map(igwShape) }) });

defineCommand({ service: 'ec2', name: 'create-route-table', op: 'CreateRouteTable', ...TAGS, run: (c, p) => ({ RouteTable: rtbShape(ec2.createRouteTable(c, { VpcId: p.VpcId, Tags: tagSpec(p) })) }) });
defineCommand({
  service: 'ec2',
  name: 'create-route',
  op: 'CreateRoute',
  run: (c, p) => {
    ec2.createRoute(c, { RouteTableId: p.RouteTableId, DestinationCidrBlock: p.DestinationCidrBlock, GatewayId: p.GatewayId, NatGatewayId: p.NatGatewayId });
    return { Return: true };
  },
});
defineCommand({ service: 'ec2', name: 'delete-route', op: 'DeleteRoute', run: (c, p) => void ec2.deleteRoute(c, { RouteTableId: p.RouteTableId, DestinationCidrBlock: p.DestinationCidrBlock }) });
defineCommand({
  service: 'ec2',
  name: 'associate-route-table',
  op: 'AssociateRouteTable',
  run: (c, p) => ({ AssociationId: ec2.associateRouteTable(c, { RouteTableId: p.RouteTableId, SubnetId: p.SubnetId }), AssociationState: { State: 'associated' } }),
});
defineCommand({
  service: 'ec2',
  name: 'describe-route-tables',
  op: 'DescribeRouteTables',
  list: ['filters'],
  structured: ['filters'],
  run: (c, p) => ({ RouteTables: ec2.describeRouteTables(c, { Filters: filters(p) }).map(rtbShape) }),
});

defineCommand({
  service: 'ec2',
  name: 'allocate-address',
  op: 'AllocateAddress',
  run: (c) => {
    const e = ec2.allocateAddress(c);
    return { PublicIp: e.publicIp, AllocationId: e.id, PublicIpv4Pool: 'amazon', NetworkBorderGroup: c.region, Domain: 'vpc' };
  },
});
defineCommand({ service: 'ec2', name: 'release-address', op: 'ReleaseAddress', run: (c, p) => void ec2.releaseAddress(c, { AllocationId: p.AllocationId }) });
defineCommand({
  service: 'ec2',
  name: 'create-nat-gateway',
  op: 'CreateNatGateway',
  ...TAGS,
  run: (c, p) => ({ NatGateway: natShape(ec2.createNatGateway(c, { SubnetId: p.SubnetId, AllocationId: p.AllocationId, Tags: tagSpec(p) })) }),
});
defineCommand({
  service: 'ec2',
  name: 'delete-nat-gateway',
  op: 'DeleteNatGateway',
  run: (c, p) => {
    ec2.deleteNatGateway(c, { NatGatewayId: p.NatGatewayId });
    return { NatGatewayId: p.NatGatewayId };
  },
});

// ---------------------------------------------------------------- grupos de seguridad
defineCommand({
  service: 'ec2',
  name: 'create-security-group',
  op: 'CreateSecurityGroup',
  ...TAGS,
  run: (c, p) => ({ GroupId: ec2.createSecurityGroup(c, { GroupName: p.GroupName, Description: p.Description, VpcId: p.VpcId, Tags: tagSpec(p) }).id }),
});
defineCommand({
  service: 'ec2',
  name: 'describe-security-groups',
  op: 'DescribeSecurityGroups',
  list: ['group-ids', 'filters'],
  structured: ['filters'],
  run: (c, p) => ({ SecurityGroups: ec2.describeSecurityGroups(c, { GroupIds: p.GroupIds, Filters: filters(p) }).map((g) => sgShape(g, c.s.account.id)) }),
});
defineCommand({ service: 'ec2', name: 'delete-security-group', op: 'DeleteSecurityGroup', run: (c, p) => void ec2.deleteSecurityGroup(c, { GroupId: p.GroupId }) });

function perms(p: Params): ec2.IpPermission[] {
  if (p.IpPermissions) {
    return (Array.isArray(p.IpPermissions) ? p.IpPermissions : [p.IpPermissions]).flatMap((x: any) => {
      const ranges = x.IpRanges ?? (x.CidrIp ? [{ CidrIp: x.CidrIp }] : []);
      const groups = x.UserIdGroupPairs ?? [];
      const base = { IpProtocol: String(x.IpProtocol), FromPort: x.FromPort !== undefined ? Number(x.FromPort) : undefined, ToPort: x.ToPort !== undefined ? Number(x.ToPort) : undefined };
      return [...ranges.map((r: any) => ({ ...base, CidrIp: r.CidrIp, Description: r.Description })), ...groups.map((g: any) => ({ ...base, SourceSecurityGroupId: g.GroupId }))];
    });
  }
  const proto = String(p.Protocol ?? '');
  if (!proto) throw new AwsError('MissingParameter', 'The request must contain the parameter ipPermissions');
  const port = p.Port !== undefined ? String(p.Port) : '-1';
  const [from, to] = port.includes('-') && !port.startsWith('-') ? port.split('-').map(Number) : [Number(port), Number(port)];
  return [{ IpProtocol: proto, FromPort: from, ToPort: to, CidrIp: p.Cidr, SourceSecurityGroupId: p.SourceGroup }];
}
const sgRuleResult = (rules: ReturnType<typeof ec2.authorizeSecurityGroupIngress>, egress: boolean) => ({
  Return: true,
  SecurityGroupRules: rules.map((r) => ({ SecurityGroupRuleId: r.id, IsEgress: egress, IpProtocol: r.protocol, FromPort: r.from, ToPort: r.to, CidrIpv4: r.cidr })),
});
const PERM = { list: ['ip-permissions'], structured: ['ip-permissions'] };
defineCommand({ service: 'ec2', name: 'authorize-security-group-ingress', op: 'AuthorizeSecurityGroupIngress', ...PERM, run: (c, p) => sgRuleResult(ec2.authorizeSecurityGroupIngress(c, { GroupId: p.GroupId, IpPermissions: perms(p) }), false) });
defineCommand({ service: 'ec2', name: 'authorize-security-group-egress', op: 'AuthorizeSecurityGroupEgress', ...PERM, run: (c, p) => sgRuleResult(ec2.authorizeSecurityGroupEgress(c, { GroupId: p.GroupId, IpPermissions: perms(p) }), true) });
defineCommand({
  service: 'ec2',
  name: 'revoke-security-group-ingress',
  op: 'RevokeSecurityGroupIngress',
  ...PERM,
  run: (c, p) => {
    ec2.revokeSecurityGroupIngress(c, { GroupId: p.GroupId, IpPermissions: perms(p) });
    return { Return: true };
  },
});
defineCommand({
  service: 'ec2',
  name: 'revoke-security-group-egress',
  op: 'RevokeSecurityGroupEgress',
  ...PERM,
  run: (c, p) => {
    ec2.revokeSecurityGroupEgress(c, { GroupId: p.GroupId, IpPermissions: perms(p) });
    return { Return: true };
  },
});

// ---------------------------------------------------------------- instancias
defineCommand({
  service: 'ec2',
  name: 'describe-instances',
  op: 'DescribeInstances',
  list: ['instance-ids', 'filters'],
  structured: ['filters'],
  run: (c, p) => ({
    Reservations: ec2.describeInstances(c, { InstanceIds: p.InstanceIds, Filters: filters(p) }).map((i) => ({ ReservationId: 'r-' + i.id.slice(2, 19), OwnerId: c.s.account.id, Groups: [], Instances: [instanceShape(i)] })),
  }),
});
defineCommand({
  service: 'ec2',
  name: 'run-instances',
  op: 'RunInstances',
  list: ['security-group-ids', 'tag-specifications'],
  structured: ['tag-specifications', 'metadata-options', 'block-device-mappings', 'iam-instance-profile'],
  bool: ['associate-public-ip-address'],
  run: (c, p) => {
    const bd = Array.isArray(p.BlockDeviceMappings) ? p.BlockDeviceMappings[0]?.Ebs : p.BlockDeviceMappings?.Ebs;
    const count = p.Count ? Number(String(p.Count).split(':').pop()) : 1;
    const list = ec2.runInstances(c, {
      ImageId: p.ImageId,
      InstanceType: p.InstanceType,
      KeyName: p.KeyName,
      SubnetId: p.SubnetId,
      SecurityGroupIds: p.SecurityGroupIds,
      MinCount: count,
      MaxCount: count,
      IamInstanceProfile: p.IamInstanceProfile?.Name ?? (typeof p.IamInstanceProfile === 'string' ? p.IamInstanceProfile : undefined),
      UserData: p.UserData,
      AssociatePublicIpAddress: p.AssociatePublicIpAddress,
      Tags: tagSpec(p),
      HttpTokens: p.MetadataOptions?.HttpTokens,
      VolumeSize: bd?.VolumeSize ? Number(bd.VolumeSize) : undefined,
      Encrypted: bd?.Encrypted === 'true' || bd?.Encrypted === true,
    });
    return { ReservationId: 'r-' + list[0].id.slice(2, 19), OwnerId: c.s.account.id, Groups: [], Instances: list.map(instanceShape) };
  },
});
const CODES: Record<string, number> = { pending: 0, running: 16, 'shutting-down': 32, terminated: 48, stopping: 64, stopped: 80 };
const stateChange = (r: { id: string; previous: string; current: string }[]) =>
  r.map((x) => ({ InstanceId: x.id, CurrentState: { Code: CODES[x.current], Name: x.current }, PreviousState: { Code: CODES[x.previous], Name: x.previous } }));
defineCommand({ service: 'ec2', name: 'stop-instances', op: 'StopInstances', list: ['instance-ids'], run: (c, p) => ({ StoppingInstances: stateChange(ec2.stopInstances(c, { InstanceIds: p.InstanceIds })) }) });
defineCommand({ service: 'ec2', name: 'start-instances', op: 'StartInstances', list: ['instance-ids'], run: (c, p) => ({ StartingInstances: stateChange(ec2.startInstances(c, { InstanceIds: p.InstanceIds })) }) });
defineCommand({ service: 'ec2', name: 'terminate-instances', op: 'TerminateInstances', list: ['instance-ids'], run: (c, p) => ({ TerminatingInstances: stateChange(ec2.terminateInstances(c, { InstanceIds: p.InstanceIds })) }) });
defineCommand({
  service: 'ec2',
  name: 'modify-instance-metadata-options',
  op: 'ModifyInstanceMetadataOptions',
  run: (c, p) => {
    ec2.modifyInstanceMetadataOptions(c, { InstanceId: p.InstanceId, HttpTokens: p.HttpTokens });
    return { InstanceId: p.InstanceId, InstanceMetadataOptions: { State: 'pending', HttpTokens: p.HttpTokens, HttpEndpoint: 'enabled' } };
  },
});
defineCommand({
  service: 'ec2',
  name: 'create-tags',
  op: 'CreateTags',
  list: ['resources', 'tags'],
  structured: ['tags'],
  run: (c, p) => void ec2.createTags(c, { Resources: p.Resources, Tags: (p.Tags as any[]).flatMap((t) => (Array.isArray(t) ? t : [t])) }),
});
defineCommand({
  service: 'ec2',
  name: 'create-key-pair',
  op: 'CreateKeyPair',
  run: (c, p) => {
    const k = ec2.createKeyPair(c, { KeyName: p.KeyName });
    return { KeyFingerprint: k.fingerprint, KeyMaterial: k.material, KeyName: k.name, KeyPairId: k.id };
  },
});
defineCommand({ service: 'ec2', name: 'describe-images', op: 'DescribeImages', list: ['owners', 'filters'], structured: ['filters'], run: (c) => ({ Images: ec2.describeImages(c).map(imageShape) }) });
defineCommand({
  service: 'ec2',
  name: 'describe-availability-zones',
  op: 'DescribeAvailabilityZones',
  run: (c) => ({ AvailabilityZones: ec2.describeAvailabilityZones(c).map((z) => ({ State: 'available', RegionName: c.region, ZoneName: z, ZoneId: 'euw1-az' + z.slice(-1) })) }),
});

// ---------------------------------------------------------------- Operaciones complementarias
defineCommand({
  service: 'ec2',
  name: 'describe-key-pairs',
  op: 'DescribeKeyPairs',
  list: ['key-names'],
  run: (c, p) => ({ KeyPairs: ec2.describeKeyPairs(c, { KeyNames: p.KeyNames }).map((k) => ({ KeyPairId: k.id, KeyFingerprint: k.fingerprint, KeyName: k.name, KeyType: 'rsa', CreateTime: new Date(k.createdAt).toISOString().replace(/\.\d+Z$/, '.000Z') })) }),
});
defineCommand({ service: 'ec2', name: 'delete-key-pair', op: 'DeleteKeyPair', run: (c, p) => ({ Return: (ec2.deleteKeyPair(c, { KeyName: p.KeyName }), true) }) });
defineCommand({
  service: 'ec2',
  name: 'delete-tags',
  op: 'DeleteTags',
  list: ['resources', 'tags'],
  structured: ['tags'],
  run: (c, p) => void ec2.deleteTags(c, { Resources: p.Resources, Tags: p.Tags ? (p.Tags as any[]).flatMap((t) => (Array.isArray(t) ? t : [t])) : undefined }),
});
defineCommand({ service: 'ec2', name: 'reboot-instances', op: 'RebootInstances', list: ['instance-ids'], run: (c, p) => void ec2.rebootInstances(c, { InstanceIds: p.InstanceIds }) });
defineCommand({ service: 'ec2', name: 'describe-nat-gateways', op: 'DescribeNatGateways', run: (c) => ({ NatGateways: ec2.describeNatGateways(c).map(natShape) }) });
defineCommand({
  service: 'ec2',
  name: 'describe-addresses',
  op: 'DescribeAddresses',
  run: (c) => ({ Addresses: ec2.describeAddresses(c).map((e) => ({ AllocationId: e.id, PublicIp: e.publicIp, Domain: 'vpc', PublicIpv4Pool: 'amazon', NetworkBorderGroup: e.region, ...(e.associatedInstanceId ? { InstanceId: e.associatedInstanceId } : {}) })) }),
});
defineCommand({ service: 'ec2', name: 'delete-route-table', op: 'DeleteRouteTable', run: (c, p) => void ec2.deleteRouteTable(c, { RouteTableId: p.RouteTableId }) });
defineCommand({ service: 'ec2', name: 'disassociate-route-table', op: 'DisassociateRouteTable', run: (c, p) => void ec2.disassociateRouteTable(c, { AssociationId: p.AssociationId }) });

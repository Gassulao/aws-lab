// Conversión del modelo interno a las formas de respuesta de la API de AWS.
import type { Instance, IamUser, IamRole, IamGroup, IamPolicy, S3Bucket, SecurityGroup, SgRule, Subnet, Vpc, RouteTable, InternetGateway, NatGateway, Tags, TrailEvent, ElasticIp } from '../../engine/types';
import { AMIS } from '../../engine/catalog';

export const tagList = (t: Tags): { Key: string; Value: string }[] | undefined => {
  const e = Object.entries(t);
  return e.length ? e.map(([Key, Value]) => ({ Key, Value })) : undefined;
};
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const iso = (s: string) => s.replace(/\.\d+Z$/, '+00:00');
const enc = (doc: any) => doc; // el CLI devuelve el documento ya decodificado

export const userShape = (u: IamUser) => strip({ Path: u.path, UserName: u.name, UserId: u.id, Arn: u.arn, CreateDate: iso(u.createdAt), Tags: tagList(u.tags), PermissionsBoundary: u.permissionsBoundary ? { PermissionsBoundaryType: 'Policy', PermissionsBoundaryArn: u.permissionsBoundary } : undefined });
export const groupShape = (g: IamGroup) => ({ Path: g.path, GroupName: g.name, GroupId: g.id, Arn: g.arn, CreateDate: iso(g.createdAt) });
export const roleShape = (r: IamRole) => strip({ Path: r.path, RoleName: r.name, RoleId: r.id, Arn: r.arn, CreateDate: iso(r.createdAt), AssumeRolePolicyDocument: enc(r.assumeRolePolicy), Description: r.description, MaxSessionDuration: r.maxSessionDuration, Tags: tagList(r.tags) });
export const policyShape = (p: IamPolicy) => strip({ PolicyName: p.name, PolicyId: p.id, Arn: p.arn, Path: p.path, DefaultVersionId: p.defaultVersion, AttachmentCount: p.attachmentCount, PermissionsBoundaryUsageCount: 0, IsAttachable: true, CreateDate: iso(p.createdAt), UpdateDate: iso(p.createdAt), Description: p.description });

export const vpcShape = (v: Vpc) => strip({ OwnerId: '', InstanceTenancy: 'default', CidrBlockAssociationSet: [{ AssociationId: 'vpc-cidr-assoc-' + v.id.slice(4, 12), CidrBlock: v.cidr, CidrBlockState: { State: 'associated' } }], IsDefault: v.isDefault, Tags: tagList(v.tags), VpcId: v.id, State: v.state, CidrBlock: v.cidr, DhcpOptionsId: 'dopt-0a1b2c3d' });
export const subnetShape = (s: Subnet, account: string, availableIps: number) => strip({ AvailabilityZone: s.az, AvailableIpAddressCount: availableIps, CidrBlock: s.cidr, DefaultForAz: false, MapPublicIpOnLaunch: s.mapPublicIpOnLaunch, State: 'available', SubnetId: s.id, VpcId: s.vpcId, OwnerId: account, SubnetArn: `arn:aws:ec2:${s.region}:${account}:subnet/${s.id}`, Tags: tagList(s.tags) });
export const igwShape = (g: InternetGateway) => strip({ InternetGatewayId: g.id, Attachments: g.attachedVpcId ? [{ State: 'available', VpcId: g.attachedVpcId }] : [], Tags: tagList(g.tags) });
export const natShape = (n: NatGateway) => strip({ NatGatewayId: n.id, SubnetId: n.subnetId, State: n.state, CreateTime: iso(n.createdAt), ConnectivityType: 'public', NatGatewayAddresses: [{ AllocationId: n.allocationId }], Tags: tagList(n.tags) });
export const eipShape = (e: ElasticIp) => strip({ AllocationId: e.id, PublicIp: e.publicIp, Domain: 'vpc', InstanceId: e.associatedInstanceId, AssociationId: e.associationId, PublicIpv4Pool: 'amazon' });
export const rtbShape = (r: RouteTable) => strip({ RouteTableId: r.id, VpcId: r.vpcId, Routes: r.routes.map((x) => strip({ DestinationCidrBlock: x.destination, GatewayId: x.target.startsWith('igw-') || x.target === 'local' ? x.target : undefined, NatGatewayId: x.target.startsWith('nat-') ? x.target : undefined, Origin: x.target === 'local' ? 'CreateRouteTable' : 'CreateRoute', State: 'active' })), Associations: r.associations.map((a) => strip({ Main: a.main, RouteTableAssociationId: a.id, RouteTableId: r.id, SubnetId: a.subnetId, AssociationState: { State: 'associated' } })), Tags: tagList(r.tags) });
const permShape = (r: SgRule) => strip({ IpProtocol: r.protocol, FromPort: r.protocol === '-1' ? undefined : r.from, ToPort: r.protocol === '-1' ? undefined : r.to, IpRanges: r.cidr ? [strip({ CidrIp: r.cidr, Description: r.description })] : [], UserIdGroupPairs: r.sourceSg ? [{ GroupId: r.sourceSg }] : [], Ipv6Ranges: [], PrefixListIds: [] });
export const sgShape = (g: SecurityGroup, account: string) => strip({ GroupName: g.name, GroupId: g.id, Description: g.description, VpcId: g.vpcId, OwnerId: account, IpPermissions: g.ingress.map(permShape), IpPermissionsEgress: g.egress.map(permShape), Tags: tagList(g.tags) });
export const instanceShape = (i: Instance) =>
  strip({
    InstanceId: i.id, ImageId: i.imageId, InstanceType: i.type, KeyName: i.keyName, LaunchTime: iso(i.launchTime),
    Placement: { AvailabilityZone: i.az, Tenancy: 'default' },
    PrivateIpAddress: i.privateIp, PublicIpAddress: i.publicIp, SubnetId: i.subnetId, VpcId: i.vpcId,
    State: { Code: { pending: 0, running: 16, 'shutting-down': 32, terminated: 48, stopping: 64, stopped: 80 }[i.state], Name: i.state },
    SecurityGroups: i.securityGroupIds.map((id) => ({ GroupId: id })),
    IamInstanceProfile: i.iamInstanceProfile ? { Arn: i.iamInstanceProfile } : undefined,
    MetadataOptions: { State: 'applied', HttpTokens: i.httpTokens, HttpPutResponseHopLimit: 2, HttpEndpoint: 'enabled' },
    Tags: tagList(i.tags), Architecture: 'x86_64', RootDeviceName: '/dev/xvda', RootDeviceType: 'ebs',
  });
export const imageShape = (a: (typeof AMIS)[number]) => ({ ImageId: a.id, Name: a.name, Description: a.description, State: 'available', Architecture: 'x86_64', RootDeviceType: 'ebs' });

export const bucketShape = (b: S3Bucket) => ({ Name: b.name, CreationDate: iso(b.createdAt) });
export const eventShape = (e: TrailEvent) => ({ EventId: e.id, EventName: e.eventName, ReadOnly: String(e.readOnly), EventTime: iso(e.time), EventSource: e.eventSource, Username: e.userName, Resources: e.resources.map((r) => ({ ResourceType: r.type, ResourceName: r.name })), CloudTrailEvent: JSON.stringify({ eventName: e.eventName, eventSource: e.eventSource, awsRegion: e.region, sourceIPAddress: e.sourceIp, userIdentity: { arn: e.principalArn }, errorCode: e.errorCode, errorMessage: e.errorMessage, requestParameters: e.requestParameters }) });

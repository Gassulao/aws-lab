// aws route53, aws elbv2, aws autoscaling y las plantillas de lanzamiento de aws ec2
import { defineCommand, type Params } from '../framework';
import * as r53 from '../../../engine/services/route53';
import * as elb from '../../../engine/services/elbv2';
import * as asg from '../../../engine/services/autoscaling';
import type { Asg, HostedZone, LoadBalancer, RecordSet, TargetGroup } from '../../../engine/types';

const iso = (s: string) => s.replace(/\.(\d{3})Z$/, '.$1000+00:00').replace(/Z$/, '+00:00');
const arr = (v: any): any[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const flat = (v: any): any[] => arr(v).flat();
const missing = (name: string) => { throw new Error(`aws: error: the following arguments are required: --${name}`); };
const need = (p: Params, key: string, opt: string) => { if (p[key] === undefined) missing(opt); return p[key]; };

// ------------------------------------------------------------------ route53

const zoneShape = (z: HostedZone) => ({ Id: `/hostedzone/${z.id}`, Name: z.name, CallerReference: z.callerRef, Config: { ...(z.comment ? { Comment: z.comment } : {}), PrivateZone: z.isPrivate }, ResourceRecordSetCount: z.records.length });
const changeInfo = (c: { id: string; submitted: string }) => ({ Id: c.id, Status: 'PENDING', SubmittedAt: iso(c.submitted) });
const recShape = (r: RecordSet) => ({
  Name: r.name.replace(/\*/g, '\\052'), Type: r.type, ...(r.setId ? { SetIdentifier: r.setId } : {}), ...(r.weight !== undefined ? { Weight: r.weight } : {}), ...(r.failover ? { Failover: r.failover } : {}),
  ...(r.alias ? { AliasTarget: { HostedZoneId: r.alias.zoneId, DNSName: r.alias.dnsName, EvaluateTargetHealth: r.alias.evalHealth } } : { TTL: r.ttl, ResourceRecords: r.values.map((Value) => ({ Value })) }),
  ...(r.healthCheckId ? { HealthCheckId: r.healthCheckId } : {}),
});
const zid = (id: string) => String(id).replace(/^\/hostedzone\//, '');

defineCommand({
  service: 'route53', name: 'create-hosted-zone', op: 'CreateHostedZone', structured: ['hosted-zone-config', 'vpc'],
  run: (c, p) => {
    const cfg = p.HostedZoneConfig ?? {};
    const { zone, change } = r53.createHostedZone(c, { Name: need(p, 'Name', 'name'), CallerReference: need(p, 'CallerReference', 'caller-reference').toString(), HostedZoneConfig: { Comment: cfg.Comment, PrivateZone: cfg.PrivateZone === true || cfg.PrivateZone === 'true' }, VPC: p.Vpc });
    return { Location: `https://route53.amazonaws.com/2013-04-01/hostedzone/${zone.id}`, HostedZone: zoneShape(zone), ChangeInfo: changeInfo(change), ...(zone.isPrivate ? { VPC: { VPCRegion: zone.vpcs[0].region, VPCId: zone.vpcs[0].id } } : { DelegationSet: { NameServers: zone.nameServers.map((n) => n.replace(/\.$/, '')) } }) };
  },
});
defineCommand({ service: 'route53', name: 'list-hosted-zones', op: 'ListHostedZones', run: (c) => ({ HostedZones: r53.listHostedZones(c).map(zoneShape) }) });
defineCommand({
  service: 'route53', name: 'get-hosted-zone', op: 'GetHostedZone',
  run: (c, p) => { const z = r53.getHostedZone(c, { Id: need(p, 'Id', 'id') }); return { HostedZone: zoneShape(z), ...(z.isPrivate ? { VPCs: z.vpcs.map((v) => ({ VPCRegion: v.region, VPCId: v.id })) } : { DelegationSet: { NameServers: z.nameServers.map((n) => n.replace(/\.$/, '')) } }) }; },
});
defineCommand({ service: 'route53', name: 'delete-hosted-zone', op: 'DeleteHostedZone', run: (c, p) => ({ ChangeInfo: changeInfo(r53.deleteHostedZone(c, { Id: need(p, 'Id', 'id') })) }) });
defineCommand({
  service: 'route53', name: 'change-resource-record-sets', op: 'ChangeResourceRecordSets', structured: ['change-batch'],
  run: (c, p) => ({ ChangeInfo: changeInfo(r53.changeResourceRecordSets(c, { HostedZoneId: need(p, 'HostedZoneId', 'hosted-zone-id'), ChangeBatch: need(p, 'ChangeBatch', 'change-batch') })) }),
});
defineCommand({
  service: 'route53', name: 'list-resource-record-sets', op: 'ListResourceRecordSets',
  run: (c, p) => ({ ResourceRecordSets: r53.listResourceRecordSets(c, { HostedZoneId: need(p, 'HostedZoneId', 'hosted-zone-id') }).map(recShape) }),
});
defineCommand({ service: 'route53', name: 'get-change', op: 'GetChange', run: (_c, p) => ({ ChangeInfo: { Id: String(need(p, 'Id', 'id')).startsWith('/change/') ? p.Id : `/change/${p.Id}`, Status: 'INSYNC', SubmittedAt: iso(new Date(Date.now() - 60_000).toISOString()) } }) });
defineCommand({
  service: 'route53', name: 'test-dns-answer', op: 'TestDNSAnswer',
  run: (c, p) => {
    const { z, r } = r53.testDnsAnswer(c, { HostedZoneId: need(p, 'HostedZoneId', 'hosted-zone-id'), RecordName: need(p, 'RecordName', 'record-name'), RecordType: need(p, 'RecordType', 'record-type') });
    return { Nameserver: z.nameServers[0].replace(/\.$/, ''), RecordName: String(p.RecordName), RecordType: String(p.RecordType).toUpperCase(), RecordData: r.answers.filter((a) => a.type === String(p.RecordType).toUpperCase()).map((a) => a.data), ResponseCode: r.rcode, Protocol: 'UDP' };
  },
});
defineCommand({
  service: 'route53', name: 'create-health-check', op: 'CreateHealthCheck', structured: ['health-check-config'],
  run: (c, p) => {
    const cfg = need(p, 'HealthCheckConfig', 'health-check-config');
    const h = r53.createHealthCheck(c, { CallerReference: need(p, 'CallerReference', 'caller-reference').toString(), HealthCheckConfig: cfg });
    return { Location: `https://route53.amazonaws.com/2013-04-01/healthcheck/${h.id}`, HealthCheck: { Id: h.id, CallerReference: h.callerRef, HealthCheckConfig: { ...(h.ip ? { IPAddress: h.ip } : {}), Port: h.port, Type: h.type, ...(h.path ? { ResourcePath: h.path } : {}), ...(h.fqdn ? { FullyQualifiedDomainName: h.fqdn } : {}), RequestInterval: h.interval, FailureThreshold: h.threshold, MeasureLatency: false, Inverted: false, Disabled: false, EnableSNI: h.type === 'HTTPS' }, HealthCheckVersion: 1 } };
  },
});
defineCommand({
  service: 'route53', name: 'list-health-checks', op: 'ListHealthChecks',
  run: (c) => ({ HealthChecks: r53.listHealthChecks(c).map((h) => ({ Id: h.id, CallerReference: h.callerRef, HealthCheckConfig: { ...(h.ip ? { IPAddress: h.ip } : {}), Port: h.port, Type: h.type, ...(h.path ? { ResourcePath: h.path } : {}), RequestInterval: h.interval, FailureThreshold: h.threshold }, HealthCheckVersion: 1 })) }),
});
defineCommand({ service: 'route53', name: 'delete-health-check', op: 'DeleteHealthCheck', run: (c, p) => void r53.deleteHealthCheck(c, { HealthCheckId: need(p, 'HealthCheckId', 'health-check-id') }) });
defineCommand({
  service: 'route53', name: 'get-health-check-status', op: 'GetHealthCheckStatus',
  run: (c, p) => {
    const { h, report } = r53.getHealthCheckStatus(c, { HealthCheckId: need(p, 'HealthCheckId', 'health-check-id') });
    const t = iso(new Date().toISOString());
    return { HealthCheckObservations: ['us-east-1', 'eu-west-1', 'us-west-2'].map((Region, i) => ({ Region, IPAddress: ['15.177.10.', '54.228.16.', '54.244.52.'][i] + (10 + i), StatusReport: { Status: report, CheckedTime: t } })).slice(0, h.type ? 3 : 3) };
  },
});

// ------------------------------------------------------------------ elbv2

const lbShape = (c: { s: any }, l: LoadBalancer) => ({
  LoadBalancerArn: l.arn, DNSName: l.dnsName, CanonicalHostedZoneId: l.zoneId, CreatedTime: iso(l.createdAt), LoadBalancerName: l.name, Scheme: l.scheme, VpcId: l.vpcId, State: { Code: elb.lbState(l) }, Type: 'application',
  AvailabilityZones: l.subnets.map((id) => ({ ZoneName: c.s.subnets.find((x: any) => x.id === id)?.az, SubnetId: id, LoadBalancerAddresses: [] })), SecurityGroups: l.securityGroups, IpAddressType: 'ipv4',
});
const tgShape = (c: { s: any }, g: TargetGroup) => ({
  TargetGroupArn: g.arn, TargetGroupName: g.name, Protocol: g.protocol, Port: g.port, VpcId: g.vpcId, HealthCheckProtocol: g.hc.protocol, HealthCheckPort: g.hc.port, HealthCheckEnabled: true, HealthCheckIntervalSeconds: g.hc.interval, HealthCheckTimeoutSeconds: g.hc.timeout,
  HealthyThresholdCount: g.hc.healthy, UnhealthyThresholdCount: g.hc.unhealthy, HealthCheckPath: g.hc.path, Matcher: { HttpCode: g.hc.matcher }, LoadBalancerArns: c.s.listeners.filter((l: any) => l.tgArn === g.arn).map((l: any) => l.lbArn).filter((a: string, i: number, all: string[]) => all.indexOf(a) === i), TargetType: g.targetType, ProtocolVersion: 'HTTP1', IpAddressType: 'ipv4',
});
const lsShape = (l: { arn: string; lbArn: string; port: number; protocol: string; tgArn: string }) => ({ ListenerArn: l.arn, LoadBalancerArn: l.lbArn, Port: l.port, Protocol: l.protocol, DefaultActions: [{ Type: 'forward', TargetGroupArn: l.tgArn, ForwardConfig: { TargetGroups: [{ TargetGroupArn: l.tgArn, Weight: 1 }], TargetGroupStickinessConfig: { Enabled: false } } }] });
const tagsOf = (t: any): { Key: string; Value: string }[] => flat(t).map((x: any) => ({ Key: x.Key, Value: String(x.Value ?? '') }));
const targets = (p: Params) => flat(p.Targets).map((t: any) => ({ Id: t.Id, Port: t.Port !== undefined ? Number(t.Port) : undefined }));

defineCommand({
  service: 'elbv2', name: 'create-load-balancer', op: 'CreateLoadBalancer', list: ['subnets', 'security-groups', 'tags'], structured: ['tags'],
  run: (c, p) => ({ LoadBalancers: [lbShape(c, elb.createLoadBalancer(c, { Name: need(p, 'Name', 'name'), Subnets: p.Subnets, SecurityGroups: p.SecurityGroups, Scheme: p.Scheme, Type: p.Type, Tags: p.Tags ? tagsOf(p.Tags) : undefined }))] }),
});
defineCommand({
  service: 'elbv2', name: 'describe-load-balancers', op: 'DescribeLoadBalancers', list: ['load-balancer-arns', 'names'],
  run: (c, p) => ({ LoadBalancers: elb.describeLoadBalancers(c, { LoadBalancerArns: p.LoadBalancerArns, Names: p.Names }).map((l) => lbShape(c, l)) }),
});
defineCommand({ service: 'elbv2', name: 'delete-load-balancer', op: 'DeleteLoadBalancer', run: (c, p) => void elb.deleteLoadBalancer(c, { LoadBalancerArn: need(p, 'LoadBalancerArn', 'load-balancer-arn') }) });
defineCommand({
  service: 'elbv2', name: 'create-target-group', op: 'CreateTargetGroup', structured: ['matcher'],
  run: (c, p) => ({ TargetGroups: [tgShape(c, elb.createTargetGroup(c, { Name: need(p, 'Name', 'name'), Protocol: p.Protocol, Port: p.Port, VpcId: p.VpcId, HealthCheckPath: p.HealthCheckPath, HealthCheckPort: p.HealthCheckPort?.toString(), HealthCheckProtocol: p.HealthCheckProtocol, HealthCheckIntervalSeconds: p.HealthCheckIntervalSeconds, HealthCheckTimeoutSeconds: p.HealthCheckTimeoutSeconds, HealthyThresholdCount: p.HealthyThresholdCount, UnhealthyThresholdCount: p.UnhealthyThresholdCount, Matcher: p.Matcher && { HttpCode: String(p.Matcher.HttpCode) }, TargetType: p.TargetType }))] }),
});
defineCommand({
  service: 'elbv2', name: 'modify-target-group', op: 'ModifyTargetGroup', structured: ['matcher'],
  run: (c, p) => ({ TargetGroups: [tgShape(c, elb.modifyTargetGroup(c, { TargetGroupArn: need(p, 'TargetGroupArn', 'target-group-arn'), HealthCheckPath: p.HealthCheckPath, HealthCheckPort: p.HealthCheckPort?.toString(), HealthCheckIntervalSeconds: p.HealthCheckIntervalSeconds, HealthCheckTimeoutSeconds: p.HealthCheckTimeoutSeconds, HealthyThresholdCount: p.HealthyThresholdCount, UnhealthyThresholdCount: p.UnhealthyThresholdCount, Matcher: p.Matcher && { HttpCode: String(p.Matcher.HttpCode) } }))] }),
});
defineCommand({
  service: 'elbv2', name: 'describe-target-groups', op: 'DescribeTargetGroups', list: ['target-group-arns', 'names'],
  run: (c, p) => ({ TargetGroups: elb.describeTargetGroups(c, { TargetGroupArns: p.TargetGroupArns, Names: p.Names, LoadBalancerArn: p.LoadBalancerArn }).map((g) => tgShape(c, g)) }),
});
defineCommand({ service: 'elbv2', name: 'delete-target-group', op: 'DeleteTargetGroup', run: (c, p) => void elb.deleteTargetGroup(c, { TargetGroupArn: need(p, 'TargetGroupArn', 'target-group-arn') }) });
defineCommand({ service: 'elbv2', name: 'register-targets', op: 'RegisterTargets', list: ['targets'], structured: ['targets'], run: (c, p) => void elb.registerTargets(c, { TargetGroupArn: need(p, 'TargetGroupArn', 'target-group-arn'), Targets: targets(need(p, 'Targets', 'targets') && p) }) });
defineCommand({ service: 'elbv2', name: 'deregister-targets', op: 'DeregisterTargets', list: ['targets'], structured: ['targets'], run: (c, p) => void elb.deregisterTargets(c, { TargetGroupArn: need(p, 'TargetGroupArn', 'target-group-arn'), Targets: targets(need(p, 'Targets', 'targets') && p) }) });
defineCommand({
  service: 'elbv2', name: 'describe-target-health', op: 'DescribeTargetHealth', list: ['targets'], structured: ['targets'],
  run: (c, p) => ({
    TargetHealthDescriptions: elb.describeTargetHealth(c, { TargetGroupArn: need(p, 'TargetGroupArn', 'target-group-arn'), Targets: p.Targets ? targets(p) : undefined }).map((d) => ({
      Target: { Id: d.id, Port: d.port }, HealthCheckPort: String(d.g.hc.port === 'traffic-port' ? d.port : d.g.hc.port),
      TargetHealth: { State: d.h.state, ...(d.h.reason ? { Reason: d.h.reason, Description: d.h.description } : {}) },
    })),
  }),
});
defineCommand({
  service: 'elbv2', name: 'create-listener', op: 'CreateListener', list: ['default-actions', 'certificates'], structured: ['default-actions', 'certificates'],
  run: (c, p) => ({ Listeners: [lsShape(elb.createListener(c, { LoadBalancerArn: need(p, 'LoadBalancerArn', 'load-balancer-arn'), Protocol: p.Protocol, Port: p.Port, DefaultActions: flat(need(p, 'DefaultActions', 'default-actions')), Certificates: p.Certificates && flat(p.Certificates) }))] }),
});
defineCommand({
  service: 'elbv2', name: 'describe-listeners', op: 'DescribeListeners', list: ['listener-arns'],
  run: (c, p) => ({ Listeners: elb.describeListeners(c, { LoadBalancerArn: p.LoadBalancerArn, ListenerArns: p.ListenerArns }).map(lsShape) }),
});
defineCommand({ service: 'elbv2', name: 'delete-listener', op: 'DeleteListener', run: (c, p) => void elb.deleteListener(c, { ListenerArn: need(p, 'ListenerArn', 'listener-arn') }) });

// ------------------------------------------------------------------ plantillas de lanzamiento

const ltShape = (l: { id: string; name: string; createdAt: string; createdBy: string; version: number }) => ({ LaunchTemplateId: l.id, LaunchTemplateName: l.name, CreateTime: iso(l.createdAt), CreatedBy: l.createdBy, DefaultVersionNumber: l.version, LatestVersionNumber: l.version });
defineCommand({
  service: 'ec2', name: 'create-launch-template', op: 'CreateLaunchTemplate', structured: ['launch-template-data'],
  run: (c, p) => {
    const d = need(p, 'LaunchTemplateData', 'launch-template-data');
    return { LaunchTemplate: ltShape(asg.createLaunchTemplate(c, { LaunchTemplateName: need(p, 'LaunchTemplateName', 'launch-template-name'), LaunchTemplateData: { ...d, SecurityGroupIds: d.SecurityGroupIds === undefined ? undefined : flat(d.SecurityGroupIds), UserData: d.UserData } })) };
  },
});
defineCommand({ service: 'ec2', name: 'describe-launch-templates', op: 'DescribeLaunchTemplates', list: ['launch-template-names', 'launch-template-ids'], run: (c, p) => ({ LaunchTemplates: asg.describeLaunchTemplates(c, { LaunchTemplateNames: p.LaunchTemplateNames, LaunchTemplateIds: p.LaunchTemplateIds }).map(ltShape) }) });
defineCommand({ service: 'ec2', name: 'delete-launch-template', op: 'DeleteLaunchTemplate', run: (c, p) => ({ LaunchTemplate: ltShape(asg.deleteLaunchTemplate(c, { LaunchTemplateName: p.LaunchTemplateName, LaunchTemplateId: p.LaunchTemplateId })) }) });

// ------------------------------------------------------------------ autoscaling

const ltRef = (c: { s: any }, g: Asg) => { const lt = c.s.launchTemplates.find((l: any) => l.name === g.ltName); return { LaunchTemplateId: lt?.id, LaunchTemplateName: g.ltName, Version: '$Latest' }; };
const asgShape = (c: { s: any }, g: Asg) => ({
  AutoScalingGroupName: g.name, AutoScalingGroupARN: g.arn, LaunchTemplate: ltRef(c, g), MinSize: g.min, MaxSize: g.max, DesiredCapacity: g.desired, DefaultCooldown: 300,
  AvailabilityZones: [...new Set(g.subnets.map((id) => c.s.subnets.find((x: any) => x.id === id)?.az))].sort(), LoadBalancerNames: [], TargetGroupARNs: g.tgArns, HealthCheckType: g.healthCheckType, HealthCheckGracePeriod: g.grace,
  Instances: asg.groupInstances(c.s, g).map((i) => ({ InstanceId: i.id, InstanceType: i.type, AvailabilityZone: i.az, LifecycleState: i.state === 'pending' ? 'Pending' : 'InService', HealthStatus: 'Healthy', LaunchTemplate: ltRef(c, g), ProtectedFromScaleIn: false })),
  CreatedTime: iso(g.createdAt), SuspendedProcesses: [], VPCZoneIdentifier: g.subnets.join(','), EnabledMetrics: [],
  Tags: Object.entries(g.tags ?? {}).map(([Key, Value]) => ({ ResourceId: g.name, ResourceType: 'auto-scaling-group', Key, Value, PropagateAtLaunch: true })), TerminationPolicies: ['Default'], NewInstancesProtectedFromScaleIn: false,
  ServiceLinkedRoleARN: `arn:aws:iam::${c.s.account.id}:role/aws-service-role/autoscaling.amazonaws.com/AWSServiceRoleForAutoScaling`, TrafficSources: g.tgArns.map((Identifier) => ({ Identifier, Type: 'elbv2' })),
});
defineCommand({
  service: 'autoscaling', name: 'create-auto-scaling-group', op: 'CreateAutoScalingGroup', list: ['target-group-arns', 'tags'], structured: ['launch-template', 'tags'],
  run: (c, p) => void asg.createAutoScalingGroup(c, {
    AutoScalingGroupName: need(p, 'AutoScalingGroupName', 'auto-scaling-group-name'), LaunchTemplate: p.LaunchTemplate, MinSize: need(p, 'MinSize', 'min-size'), MaxSize: need(p, 'MaxSize', 'max-size'), DesiredCapacity: p.DesiredCapacity,
    VPCZoneIdentifier: p.VpcZoneIdentifier, TargetGroupARNs: p.TargetGroupArns, HealthCheckType: p.HealthCheckType, HealthCheckGracePeriod: p.HealthCheckGracePeriod, Tags: p.Tags && tagsOf(p.Tags),
  }),
});
defineCommand({ service: 'autoscaling', name: 'describe-auto-scaling-groups', op: 'DescribeAutoScalingGroups', list: ['auto-scaling-group-names'], run: (c, p) => ({ AutoScalingGroups: asg.describeAutoScalingGroups(c, { AutoScalingGroupNames: p.AutoScalingGroupNames }).map((g) => asgShape(c, g)) }) });
defineCommand({
  service: 'autoscaling', name: 'update-auto-scaling-group', op: 'UpdateAutoScalingGroup', structured: ['launch-template'],
  run: (c, p) => void asg.updateAutoScalingGroup(c, { AutoScalingGroupName: need(p, 'AutoScalingGroupName', 'auto-scaling-group-name'), MinSize: p.MinSize, MaxSize: p.MaxSize, DesiredCapacity: p.DesiredCapacity, VPCZoneIdentifier: p.VpcZoneIdentifier, HealthCheckType: p.HealthCheckType, HealthCheckGracePeriod: p.HealthCheckGracePeriod, LaunchTemplate: p.LaunchTemplate }),
});
defineCommand({ service: 'autoscaling', name: 'set-desired-capacity', op: 'SetDesiredCapacity', bool: ['honor-cooldown', 'no-honor-cooldown'], run: (c, p) => void asg.setDesiredCapacity(c, { AutoScalingGroupName: need(p, 'AutoScalingGroupName', 'auto-scaling-group-name'), DesiredCapacity: need(p, 'DesiredCapacity', 'desired-capacity') }) });
defineCommand({
  service: 'autoscaling', name: 'terminate-instance-in-auto-scaling-group', op: 'TerminateInstanceInAutoScalingGroup', bool: ['should-decrement-desired-capacity', 'no-should-decrement-desired-capacity'],
  run: (c, p) => { const a = asg.terminateInstanceInAutoScalingGroup(c, { InstanceId: need(p, 'InstanceId', 'instance-id'), ShouldDecrementDesiredCapacity: p.ShouldDecrementDesiredCapacity === true }); return { Activity: { ActivityId: a.id, AutoScalingGroupName: c.s.asgs.find((g) => g.activities[0] === a)?.name, Description: a.description, Cause: a.cause, StartTime: iso(a.ts), StatusCode: 'InProgress', Progress: 0, Details: '{}' } }; },
});
defineCommand({ service: 'autoscaling', name: 'delete-auto-scaling-group', op: 'DeleteAutoScalingGroup', bool: ['force-delete', 'no-force-delete'], run: (c, p) => void asg.deleteAutoScalingGroup(c, { AutoScalingGroupName: need(p, 'AutoScalingGroupName', 'auto-scaling-group-name'), ForceDelete: p.ForceDelete === true }) });
defineCommand({
  service: 'autoscaling', name: 'describe-scaling-activities', op: 'DescribeScalingActivities',
  run: (c, p) => ({ Activities: asg.describeScalingActivities(c, { AutoScalingGroupName: p.AutoScalingGroupName }).map((a) => ({ ActivityId: a.id, AutoScalingGroupName: a.g.name, Description: a.description, Cause: a.cause, StartTime: iso(a.ts), EndTime: iso(a.ts), StatusCode: a.status === 'Successful' ? 'Successful' : 'Failed', Progress: 100, Details: '{}' })) }),
});
defineCommand({
  service: 'autoscaling', name: 'describe-auto-scaling-instances', op: 'DescribeAutoScalingInstances', list: ['instance-ids'],
  run: (c, p) => ({ AutoScalingInstances: c.s.asgs.flatMap((g) => asg.groupInstances(c.s, g).filter((i) => !p.InstanceIds?.length || p.InstanceIds.includes(i.id)).map((i) => ({ InstanceId: i.id, InstanceType: i.type, AutoScalingGroupName: g.name, AvailabilityZone: i.az, LifecycleState: i.state === 'pending' ? 'Pending' : 'InService', HealthStatus: 'HEALTHY', LaunchTemplate: ltRef(c, g), ProtectedFromScaleIn: false }))) }),
});

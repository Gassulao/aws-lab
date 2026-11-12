// EC2 Auto Scaling mínimo (con plantillas de lanzamiento): mantiene la capacidad deseada, reparte las instancias entre
// subredes, sustituye las que dejan de estar sanas y las registra en los grupos de destino. Se evalúa de forma perezosa.
import type { Asg, CloudState, Instance, LaunchTemplate } from '../types';
import { AwsError } from '../errors';
import { trailed, authorize, type Ctx } from '../api';
import { guid, hex, now, nowIso } from '../util';
import { speedFactor } from '../store';
import { runInstances, terminateInstances, settle, settleHooks } from './ec2';
import { targetHealth } from './elbv2';

const SRC = 'autoscaling.amazonaws.com';
const TAG = 'aws:autoscaling:groupName';
const arnOf = (ctx: Ctx, n: string, id: string) => `arn:aws:autoscaling:${ctx.region}:${ctx.s.account.id}:autoScalingGroup:${id}:autoScalingGroupName/${n}`;

// ------------------------------------------------------------------ plantillas de lanzamiento

export function createLaunchTemplate(ctx: Ctx, p: { LaunchTemplateName: string; LaunchTemplateData: { ImageId?: string; InstanceType?: string; SecurityGroupIds?: string[]; KeyName?: string; UserData?: string } }): LaunchTemplate {
  return trailed(ctx, 'ec2.amazonaws.com', 'CreateLaunchTemplate', [{ type: 'AWS::EC2::LaunchTemplate', name: p.LaunchTemplateName }], { launchTemplateName: p.LaunchTemplateName }, () => {
    authorize(ctx, 'ec2:CreateLaunchTemplate', `arn:aws:ec2:${ctx.region}:${ctx.s.account.id}:launch-template/*`);
    const n = p.LaunchTemplateName ?? '';
    if (!/^[A-Za-z0-9()./_-]{3,128}$/.test(n)) throw new AwsError('InvalidLaunchTemplateName.MalformedException', 'Launch template name must be between 3 and 128 characters, and may contain letters, numbers, and the following characters: - _ . / ( ).');
    if (ctx.s.launchTemplates.some((l) => l.name === n && l.region === ctx.region)) throw new AwsError('InvalidLaunchTemplateName.AlreadyExistsException', `Launch template name already in use.`);
    const d = p.LaunchTemplateData ?? {};
    const lt: LaunchTemplate = { id: `lt-${hex(17)}`, name: n, region: ctx.region, imageId: d.ImageId ?? '', instanceType: d.InstanceType ?? 't3.micro', securityGroupIds: d.SecurityGroupIds ?? [], keyName: d.KeyName, userData: d.UserData, createdAt: nowIso(), createdBy: ctx.caller.arn, version: 1 };
    ctx.s.launchTemplates.push(lt);
    return lt;
  });
}
export function describeLaunchTemplates(ctx: Ctx, p: { LaunchTemplateNames?: string[]; LaunchTemplateIds?: string[] } = {}): LaunchTemplate[] {
  return trailed(ctx, 'ec2.amazonaws.com', 'DescribeLaunchTemplates', [], p, () => {
    authorize(ctx, 'ec2:DescribeLaunchTemplates', '*');
    for (const n of p.LaunchTemplateNames ?? []) if (!ctx.s.launchTemplates.some((l) => l.name === n && l.region === ctx.region)) throw new AwsError('InvalidLaunchTemplateName.NotFoundException', `At least one of the launch templates specified in the request does not exist.`);
    return ctx.s.launchTemplates.filter((l) => l.region === ctx.region && (!p.LaunchTemplateNames?.length || p.LaunchTemplateNames.includes(l.name)) && (!p.LaunchTemplateIds?.length || p.LaunchTemplateIds.includes(l.id)));
  });
}
export function deleteLaunchTemplate(ctx: Ctx, p: { LaunchTemplateName?: string; LaunchTemplateId?: string }): LaunchTemplate {
  return trailed(ctx, 'ec2.amazonaws.com', 'DeleteLaunchTemplate', [], p, () => {
    authorize(ctx, 'ec2:DeleteLaunchTemplate', '*');
    const lt = ctx.s.launchTemplates.find((l) => l.region === ctx.region && (l.name === p.LaunchTemplateName || l.id === p.LaunchTemplateId));
    if (!lt) throw new AwsError('InvalidLaunchTemplateName.NotFoundException', `At least one of the launch templates specified in the request does not exist.`);
    ctx.s.launchTemplates = ctx.s.launchTemplates.filter((l) => l !== lt);
    return lt;
  });
}

// ------------------------------------------------------------------ grupos

// Mensaje real de AWS al no encontrar el grupo (incluye el «null»).
const GROUP_NOT_FOUND = () => new AwsError('ValidationError', 'AutoScalingGroup name not found - null');
const getAsg = (ctx: Ctx, n: string): Asg => { const g = ctx.s.asgs.find((x) => x.name === n && x.region === ctx.region); if (!g) throw GROUP_NOT_FOUND(); return g; };

export const groupInstances = (s: CloudState, g: Asg): Instance[] => s.instances.filter((i) => i.tags[TAG] === g.name && i.region === g.region && i.state !== 'terminated' && i.state !== 'shutting-down');

const svcCtx = (s: CloudState, region: string): Ctx => ({ s, region, caller: { type: 'Root', arn: 'autoscaling.amazonaws.com', userName: 'autoscaling.amazonaws.com', mfa: false, sourceIp: 'autoscaling.amazonaws.com' } });
const activity = (g: Asg, description: string, cause: string) => { g.activities.unshift({ id: guid(), ts: nowIso(), cause, description, status: 'Successful' }); if (g.activities.length > 50) g.activities.pop(); };
const at = () => `At ${nowIso().replace(/\.\d+Z$/, 'Z')}`;

function launch(s: CloudState, g: Asg, n: number, cause: string) {
  const lt = s.launchTemplates.find((l) => l.name === g.ltName && l.region === g.region);
  if (!lt) return;
  const c = svcCtx(s, g.region);
  for (let k = 0; k < n; k++) {
    const counts = g.subnets.map((id) => ({ id, n: groupInstances(s, g).filter((i) => i.subnetId === id).length }));
    const sub = counts.sort((a, b) => a.n - b.n)[0].id;
    try {
      const [i] = runInstances(c, { ImageId: lt.imageId, InstanceType: lt.instanceType, KeyName: lt.keyName, SubnetId: sub, SecurityGroupIds: lt.securityGroupIds.length ? lt.securityGroupIds : undefined, UserData: lt.userData, Tags: { ...(g.tags ?? {}), [TAG]: g.name, 'aws:ec2launchtemplate:id': lt.id, 'aws:ec2launchtemplate:version': '1' } });
      for (const arn of g.tgArns) { const tg = s.targetGroups.find((x) => x.arn === arn); if (tg && !tg.targets.some((t) => t.id === i.id)) tg.targets.push({ id: i.id, port: tg.port, since: now() }); }
      activity(g, `Launching a new EC2 instance: ${i.id}`, cause);
    } catch (e) {
      g.activities.unshift({ id: guid(), ts: nowIso(), cause, description: 'Launching a new EC2 instance', status: 'Failed' });
      void e;
      return;
    }
  }
}
function drop(s: CloudState, g: Asg, inst: Instance, cause: string) {
  for (const arn of g.tgArns) { const tg = s.targetGroups.find((x) => x.arn === arn); if (tg) tg.targets = tg.targets.filter((t) => t.id !== inst.id); }
  if (inst.state !== 'shutting-down' && inst.state !== 'terminated') terminateInstances(svcCtx(s, g.region), { InstanceIds: [inst.id] });
  activity(g, `Terminating EC2 instance: ${inst.id}`, cause);
}

/** Reconcilia cada grupo con su capacidad deseada. */
export function settleAsg(s: CloudState): void {
  if (!s.asgs.length) return;
  const f = speedFactor();
  const t = now();
  for (const g of s.asgs) {
    // Instancias terminadas o paradas fuera del grupo: se sustituyen tras la detección.
    for (const i of s.instances.filter((x) => x.tags[TAG] === g.name && x.region === g.region)) {
      const gone = i.state === 'terminated' || i.state === 'shutting-down' || i.state === 'stopped' || i.state === 'stopping';
      if (!gone || (i.tags['simulador:asg-handled'] === 'yes')) continue;
      const since = i.runPeriods?.[i.runPeriods.length - 1]?.to ?? t;
      if (f > 0 && t - since < 20_000 * f) continue;
      i.tags['simulador:asg-handled'] = 'yes';
      drop(s, g, i, `${at()} an instance was taken out of service in response to an EC2 health check indicating it has been terminated or stopped.`);
    }
    // Comprobación de salud de ELB tras el periodo de gracia.
    if (g.healthCheckType === 'ELB' && g.tgArns.length) {
      for (const i of groupInstances(s, g)) {
        if (i.state !== 'running' || (f > 0 && t - Date.parse(i.launchTime) < g.grace * 1000 * f)) continue;
        const bad = g.tgArns.every((arn) => { const tg = s.targetGroups.find((x) => x.arn === arn); const tt = tg?.targets.find((x) => x.id === i.id); return tg && tt && targetHealth(s, tg, tt).state === 'unhealthy'; });
        if (bad) { i.tags['simulador:asg-handled'] = 'yes'; drop(s, g, i, `${at()} an instance was taken out of service in response to an ELB system health check failure.`); }
      }
    }
    const cur = groupInstances(s, g);
    if (cur.length < g.desired) launch(s, g, g.desired - cur.length, `${at()} an instance was started in response to a difference between desired and actual capacity, increasing the capacity from ${cur.length} to ${g.desired}.`);
    else if (cur.length > g.desired) {
      const byAz = (az: string) => cur.filter((i) => i.az === az).length;
      const order = [...cur].sort((a, b) => byAz(b.az) - byAz(a.az) || Date.parse(a.launchTime) - Date.parse(b.launchTime));
      for (const i of order.slice(0, cur.length - g.desired)) drop(s, g, i, `${at()} an instance was taken out of service in response to a difference between desired and actual capacity, shrinking the capacity from ${cur.length} to ${g.desired}.`);
    }
  }
}
settleHooks.push(settleAsg);

export function createAutoScalingGroup(ctx: Ctx, p: { AutoScalingGroupName: string; LaunchTemplate?: { LaunchTemplateName?: string; LaunchTemplateId?: string; Version?: string }; MinSize: number; MaxSize: number; DesiredCapacity?: number; VPCZoneIdentifier?: string; TargetGroupARNs?: string[]; HealthCheckType?: string; HealthCheckGracePeriod?: number; Tags?: { Key: string; Value: string }[] }): void {
  return trailed(ctx, SRC, 'CreateAutoScalingGroup', [{ type: 'AWS::AutoScaling::AutoScalingGroup', name: p.AutoScalingGroupName }], { autoScalingGroupName: p.AutoScalingGroupName, minSize: p.MinSize, maxSize: p.MaxSize, desiredCapacity: p.DesiredCapacity }, () => {
    authorize(ctx, 'autoscaling:CreateAutoScalingGroup', arnOf(ctx, p.AutoScalingGroupName, '*'));
    const name = p.AutoScalingGroupName ?? '';
    if (!name || name.length > 255) throw new AwsError('ValidationError', `1 validation error detected: Value '${name}' at 'autoScalingGroupName' failed to satisfy constraint: Member must have length greater than or equal to 1`);
    if (ctx.s.asgs.some((g) => g.name === name && g.region === ctx.region)) throw new AwsError('AlreadyExists', `AutoScalingGroup by this name already exists - A group with the name ${name} already exists`);
    const lt = p.LaunchTemplate && ctx.s.launchTemplates.find((l) => l.region === ctx.region && (l.name === p.LaunchTemplate!.LaunchTemplateName || l.id === p.LaunchTemplate!.LaunchTemplateId));
    if (!p.LaunchTemplate) throw new AwsError('ValidationError', 'Valid requests must contain either a launch template, launch configuration, or an instance');
    if (!lt) throw new AwsError('ValidationError', `You must use a valid fully-formed launch template. The specified launch template, with template name ${p.LaunchTemplate.LaunchTemplateName ?? p.LaunchTemplate.LaunchTemplateId}, does not exist.`);
    const min = Number(p.MinSize), max = Number(p.MaxSize);
    if (Number.isNaN(min) || Number.isNaN(max)) throw new AwsError('ValidationError', 'MinSize and MaxSize are required');
    if (min > max) throw new AwsError('ValidationError', `Max size:${max} must be greater than or equal to min size:${min}`.replace('Max size:', 'Max size ').replace('min size:', 'min size '));
    const desired = p.DesiredCapacity === undefined ? min : Number(p.DesiredCapacity);
    if (desired < min || desired > max) throw new AwsError('ValidationError', `Desired capacity:${desired} must be between the specified min size:${min} and max size:${max}`);
    const subnets = (p.VPCZoneIdentifier ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!subnets.length) throw new AwsError('ValidationError', 'At least one Availability Zone or VPC Subnet is required to create or update AutoScalingGroup.');
    for (const sid of subnets) if (!ctx.s.subnets.some((x) => x.id === sid)) throw new AwsError('ValidationError', `The subnet ID '${sid}' does not exist`);
    for (const a of p.TargetGroupARNs ?? []) if (!ctx.s.targetGroups.some((t) => t.arn === a)) throw new AwsError('ValidationError', `Provided Target Groups may not be valid. Please ensure they exist and try again. Target group ARNs: [${a}]`);
    const hct = (p.HealthCheckType ?? 'EC2').toUpperCase();
    if (!['EC2', 'ELB'].includes(hct)) throw new AwsError('ValidationError', `Invalid health check type: ${p.HealthCheckType}`);
    const g: Asg = { name, arn: arnOf(ctx, name, guid()), region: ctx.region, ltName: lt.name, min, max, desired, subnets, tgArns: p.TargetGroupARNs ?? [], healthCheckType: hct as 'EC2' | 'ELB', grace: p.HealthCheckGracePeriod ?? 0, createdAt: nowIso(), activities: [], tags: Object.fromEntries((p.Tags ?? []).map((t) => [t.Key, t.Value])) };
    ctx.s.asgs.push(g);
    settle(ctx.s);
  });
}
export function describeAutoScalingGroups(ctx: Ctx, p: { AutoScalingGroupNames?: string[] } = {}): Asg[] {
  return trailed(ctx, SRC, 'DescribeAutoScalingGroups', [], p, () => {
    authorize(ctx, 'autoscaling:DescribeAutoScalingGroups', '*');
    settle(ctx.s);
    return ctx.s.asgs.filter((g) => g.region === ctx.region && (!p.AutoScalingGroupNames?.length || p.AutoScalingGroupNames.includes(g.name)));
  });
}
export function updateAutoScalingGroup(ctx: Ctx, p: { AutoScalingGroupName: string; MinSize?: number; MaxSize?: number; DesiredCapacity?: number; VPCZoneIdentifier?: string; HealthCheckType?: string; HealthCheckGracePeriod?: number; LaunchTemplate?: { LaunchTemplateName?: string } }): void {
  return trailed(ctx, SRC, 'UpdateAutoScalingGroup', [{ type: 'AWS::AutoScaling::AutoScalingGroup', name: p.AutoScalingGroupName }], { autoScalingGroupName: p.AutoScalingGroupName }, () => {
    authorize(ctx, 'autoscaling:UpdateAutoScalingGroup', arnOf(ctx, p.AutoScalingGroupName, '*'));
    const g = getAsg(ctx, p.AutoScalingGroupName);
    const min = p.MinSize !== undefined ? Number(p.MinSize) : g.min, max = p.MaxSize !== undefined ? Number(p.MaxSize) : g.max;
    let desired = p.DesiredCapacity !== undefined ? Number(p.DesiredCapacity) : g.desired;
    if (min > max) throw new AwsError('ValidationError', `Max size ${max} must be greater than or equal to min size ${min}`);
    if (p.DesiredCapacity !== undefined && (desired < min || desired > max)) throw new AwsError('ValidationError', `Desired capacity:${desired} must be between the specified min size:${min} and max size:${max}`);
    desired = Math.min(max, Math.max(min, desired));
    g.min = min; g.max = max; g.desired = desired;
    if (p.VPCZoneIdentifier) g.subnets = p.VPCZoneIdentifier.split(',').map((x) => x.trim()).filter(Boolean);
    if (p.HealthCheckType) g.healthCheckType = p.HealthCheckType.toUpperCase() as 'EC2' | 'ELB';
    if (p.HealthCheckGracePeriod !== undefined) g.grace = Number(p.HealthCheckGracePeriod);
    if (p.LaunchTemplate?.LaunchTemplateName) { if (!ctx.s.launchTemplates.some((l) => l.name === p.LaunchTemplate!.LaunchTemplateName)) throw new AwsError('ValidationError', `You must use a valid fully-formed launch template. The specified launch template, with template name ${p.LaunchTemplate.LaunchTemplateName}, does not exist.`); g.ltName = p.LaunchTemplate.LaunchTemplateName; }
    settle(ctx.s);
  });
}
export function setDesiredCapacity(ctx: Ctx, p: { AutoScalingGroupName: string; DesiredCapacity: number }): void {
  return trailed(ctx, SRC, 'SetDesiredCapacity', [{ type: 'AWS::AutoScaling::AutoScalingGroup', name: p.AutoScalingGroupName }], { autoScalingGroupName: p.AutoScalingGroupName, desiredCapacity: p.DesiredCapacity }, () => {
    authorize(ctx, 'autoscaling:SetDesiredCapacity', arnOf(ctx, p.AutoScalingGroupName, '*'));
    const g = getAsg(ctx, p.AutoScalingGroupName);
    const d = Number(p.DesiredCapacity);
    if (d < g.min || d > g.max) throw new AwsError('ValidationError', `New SetDesiredCapacity value ${d} is below min value ${g.min} for the AutoScalingGroup.`.replace(`below min value ${g.min}`, d < g.min ? `below min value ${g.min}` : `above max value ${g.max}`));
    g.desired = d;
    settle(ctx.s);
  });
}
export function terminateInstanceInAutoScalingGroup(ctx: Ctx, p: { InstanceId: string; ShouldDecrementDesiredCapacity: boolean }) {
  return trailed(ctx, SRC, 'TerminateInstanceInAutoScalingGroup', [], { instanceId: p.InstanceId }, () => {
    authorize(ctx, 'autoscaling:TerminateInstanceInAutoScalingGroup', '*');
    const i = ctx.s.instances.find((x) => x.id === p.InstanceId && x.tags[TAG]);
    if (!i) throw new AwsError('ValidationError', `Instance Id not found - No managed instance found for instance ID ${p.InstanceId}`);
    const g = ctx.s.asgs.find((x) => x.name === i.tags[TAG])!;
    if (p.ShouldDecrementDesiredCapacity) {
      if (g.desired - 1 < g.min) throw new AwsError('ValidationError', `Cannot terminate instance and decrement desired capacity: it would go below the minimum size ${g.min}`.replace(/^Cannot[^:]*: /, 'Cannot decrement: '));
      g.desired -= 1;
    }
    i.tags['simulador:asg-handled'] = 'yes';
    drop(ctx.s, g, i, `${at()} instance was taken out of service in response to a user request${p.ShouldDecrementDesiredCapacity ? ', shrinking the capacity from ' + (g.desired + 1) + ' to ' + g.desired : ''}.`.replace('instance was', 'an instance was'));
    settle(ctx.s);
    return g.activities[0];
  });
}
export function deleteAutoScalingGroup(ctx: Ctx, p: { AutoScalingGroupName: string; ForceDelete?: boolean }): void {
  return trailed(ctx, SRC, 'DeleteAutoScalingGroup', [{ type: 'AWS::AutoScaling::AutoScalingGroup', name: p.AutoScalingGroupName }], { autoScalingGroupName: p.AutoScalingGroupName, forceDelete: p.ForceDelete }, () => {
    authorize(ctx, 'autoscaling:DeleteAutoScalingGroup', arnOf(ctx, p.AutoScalingGroupName, '*'));
    const g = getAsg(ctx, p.AutoScalingGroupName);
    const inst = groupInstances(ctx.s, g);
    if (inst.length && !p.ForceDelete) throw new AwsError('ResourceInUse', `You cannot delete an AutoScalingGroup while there are instances or pending Spot instance request(s) still in the group.`, 400);
    for (const i of inst) drop(ctx.s, g, i, `${at()} an instance was taken out of service in response to a user request.`);
    ctx.s.asgs = ctx.s.asgs.filter((x) => x !== g);
  });
}
export function describeScalingActivities(ctx: Ctx, p: { AutoScalingGroupName?: string }) {
  return trailed(ctx, SRC, 'DescribeScalingActivities', [], p, () => {
    authorize(ctx, 'autoscaling:DescribeScalingActivities', '*');
    settle(ctx.s);
    const gs = p.AutoScalingGroupName ? [getAsg(ctx, p.AutoScalingGroupName)] : ctx.s.asgs.filter((g) => g.region === ctx.region);
    return gs.flatMap((g) => g.activities.map((a) => ({ g, ...a })));
  });
}

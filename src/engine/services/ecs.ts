// Amazon ECS (solo Fargate): clústeres, definiciones de tarea, servicios, tareas con ciclo de vida
// (PROVISIONING → PENDING → RUNNING → STOPPED), integración con ALB (destinos de tipo ip) y registros awslogs.
// Los fallos de arranque se derivan de la red de la subred, el rol de ejecución, ECR y el grupo de registros.
import type { CloudState, Subnet } from '../types';
import { AwsError } from '../errors';
import { trailed, authorize, check, type Ctx } from '../api';
import { digits, guid, hex, now } from '../util';
import { speedFactor } from '../store';
import { ids } from '../ids';
import { settleHooks, routeTableOfSubnet, cidrWithin } from './ec2';
import { ipTargets, type TargetState } from './elbv2';
import { allocIp } from '../kube';
import { cs, parseRef, resolveImage, simulateRun, webBody, type ContainerDef, type EcsCluster, type EcsService, type EcsTask, type ImageMeta, type TaskDef } from './containerCore';

const SRC = 'ecs.amazonaws.com';
const arn = (ctx: Ctx, kind: string, path: string) => `arn:aws:ecs:${ctx.region}:${ctx.s.account.id}:${kind}/${path}`;
const clientErr = (m: string) => new AwsError('ClientException', m);
const invalid = (m: string) => new AwsError('InvalidParameterException', m);
const tagMap = (t?: { key?: string; value?: string; Key?: string; Value?: string }[]) => Object.fromEntries((t ?? []).map((x) => [x.key ?? x.Key ?? '', String(x.value ?? x.Value ?? '')]));

// ------------------------------------------------------------------ clústeres

const nameOf = (v: string) => v.split('/').pop() ?? v;
export function getCluster(ctx: Ctx, ref?: string): EcsCluster {
  const n = nameOf(ref ?? 'default');
  const c = cs(ctx.s).ecsClusters.find((x) => x.name === n && x.region === ctx.region);
  if (!c) throw new AwsError('ClusterNotFoundException', 'Cluster not found.');
  return c;
}
export function createCluster(ctx: Ctx, p: { ClusterName?: string; Tags?: any[]; Settings?: { name: string; value: string }[] }): EcsCluster {
  const name = p.ClusterName ?? 'default';
  return trailed(ctx, SRC, 'CreateCluster', [{ type: 'AWS::ECS::Cluster', name }], { clusterName: name }, () => {
    authorize(ctx, 'ecs:CreateCluster', '*');
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(name)) throw invalid('Cluster name must be 1-255 characters of letters, numbers, hyphens and underscores.');
    const ex = cs(ctx.s).ecsClusters.find((x) => x.name === name && x.region === ctx.region);
    if (ex) return ex;
    const c: EcsCluster = { name, arn: arn(ctx, 'cluster', name), region: ctx.region, createdAt: now(), tags: tagMap(p.Tags), containerInsights: !!p.Settings?.some((x) => x.name === 'containerInsights' && x.value === 'enabled') };
    cs(ctx.s).ecsClusters.push(c);
    return c;
  });
}
export function clusterCounts(s: CloudState, c: EcsCluster) {
  settleEcs(s);
  const tasks = cs(s).ecsTasks.filter((t) => t.clusterName === c.name && t.region === c.region);
  return { running: tasks.filter((t) => t.lastStatus === 'RUNNING').length, pending: tasks.filter((t) => t.lastStatus === 'PROVISIONING' || t.lastStatus === 'PENDING').length, services: cs(s).ecsServices.filter((x) => x.clusterName === c.name && x.region === c.region && x.status === 'ACTIVE').length };
}
export function describeClusters(ctx: Ctx, p: { Clusters?: string[] } = {}) {
  return trailed(ctx, SRC, 'DescribeClusters', [], p, () => {
    authorize(ctx, 'ecs:DescribeClusters', '*');
    const want = p.Clusters?.length ? p.Clusters : ['default'];
    const clusters: EcsCluster[] = [];
    const failures: { arn: string; reason: string }[] = [];
    for (const w of want) {
      const c = cs(ctx.s).ecsClusters.find((x) => x.region === ctx.region && (x.name === nameOf(w) || x.arn === w));
      if (c) clusters.push(c); else failures.push({ arn: w.startsWith('arn:') ? w : arn(ctx, 'cluster', w), reason: 'MISSING' });
    }
    return { clusters, failures };
  });
}
export function listClusters(ctx: Ctx): EcsCluster[] {
  return trailed(ctx, SRC, 'ListClusters', [], {}, () => { authorize(ctx, 'ecs:ListClusters', '*'); return cs(ctx.s).ecsClusters.filter((c) => c.region === ctx.region); });
}
export function deleteCluster(ctx: Ctx, p: { Cluster: string }): EcsCluster {
  return trailed(ctx, SRC, 'DeleteCluster', [{ type: 'AWS::ECS::Cluster', name: p.Cluster }], { cluster: p.Cluster }, () => {
    authorize(ctx, 'ecs:DeleteCluster', arn(ctx, 'cluster', nameOf(p.Cluster)));
    const c = getCluster(ctx, p.Cluster);
    const n = clusterCounts(ctx.s, c);
    if (n.services) throw new AwsError('ClusterContainsServicesException', 'The Cluster cannot be deleted while Services are active.');
    if (n.running || n.pending) throw new AwsError('ClusterContainsTasksException', 'The Cluster cannot be deleted while Tasks are active.');
    cs(ctx.s).ecsClusters = cs(ctx.s).ecsClusters.filter((x) => x !== c);
    cs(ctx.s).ecsTasks = cs(ctx.s).ecsTasks.filter((t) => !(t.clusterName === c.name && t.region === c.region));
    return c;
  });
}

// ------------------------------------------------------------------ definiciones de tarea

const FARGATE: Record<number, number[]> = { 256: [512, 1024, 2048], 512: [1024, 2048, 3072, 4096], 1024: [2048, 3072, 4096, 5120, 6144, 7168, 8192], 2048: [4096, 5120, 6144, 7168, 8192, 9216, 10240, 11264, 12288, 13312, 14336, 15360, 16384], 4096: [8192, 9216, 10240, 11264, 12288, 13312, 14336, 15360, 16384, 17408, 18432, 19456, 20480, 21504, 22528, 23552, 24576, 25600, 26624, 27648, 28672, 29696, 30720] };
const num = (v: any) => (v === undefined || v === '' ? undefined : Number(v));

export function registerTaskDefinition(ctx: Ctx, p: { Family: string; ContainerDefinitions: any[]; Cpu?: string | number; Memory?: string | number; NetworkMode?: string; RequiresCompatibilities?: string[]; ExecutionRoleArn?: string; TaskRoleArn?: string; Tags?: any[] }): TaskDef {
  return trailed(ctx, SRC, 'RegisterTaskDefinition', [{ type: 'AWS::ECS::TaskDefinition', name: p.Family }], { family: p.Family }, () => {
    authorize(ctx, 'ecs:RegisterTaskDefinition', '*');
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(p.Family ?? '')) throw clientErr('Family must be 1-255 characters of letters, numbers, hyphens and underscores.');
    if (!Array.isArray(p.ContainerDefinitions) || !p.ContainerDefinitions.length) throw clientErr('Container list cannot be empty.');
    const fargate = (p.RequiresCompatibilities ?? []).includes('FARGATE');
    const networkMode = p.NetworkMode ?? (fargate ? 'awsvpc' : 'bridge');
    if (fargate && networkMode !== 'awsvpc') throw invalid("Fargate only supports network mode 'awsvpc'.");
    const cpu = num(p.Cpu);
    const mem = num(p.Memory);
    if (fargate) {
      if (cpu === undefined || mem === undefined) throw clientErr('Fargate requires task definition to have execution role ARN to support ECR images.'.replace('Fargate requires task definition to have execution role ARN to support ECR images.', 'Fargate requires that \'cpu\' be defined at the task level.'));
      if (!FARGATE[cpu]?.includes(mem)) throw clientErr('No Fargate configuration exists for given values.');
    }
    const cds: ContainerDef[] = p.ContainerDefinitions.map((d: any, i: number) => {
      if (!d.image) throw clientErr('Container.image should not be null or empty.');
      if (!d.name) throw clientErr(`Container.name should not be null or empty. (container index ${i})`);
      if (d.memory === undefined && d.memoryReservation === undefined && mem === undefined) throw invalid(`Invalid setting for container '${d.name}'. At least one of 'memory' or 'memoryReservation' must be specified.`);
      return {
        name: d.name, image: d.image, essential: d.essential === undefined ? true : d.essential === true || d.essential === 'true', cpu: num(d.cpu) ?? 0, memory: num(d.memory), memoryReservation: num(d.memoryReservation),
        portMappings: (d.portMappings ?? []).map((m: any) => ({ containerPort: Number(m.containerPort), hostPort: Number(m.hostPort ?? m.containerPort), protocol: m.protocol ?? 'tcp' })),
        command: d.command === undefined ? undefined : [].concat(d.command), entryPoint: d.entryPoint === undefined ? undefined : [].concat(d.entryPoint),
        environment: (d.environment ?? []).map((e: any) => ({ name: e.name, value: String(e.value) })),
        logConfiguration: d.logConfiguration ? { logDriver: d.logConfiguration.logDriver, options: d.logConfiguration.options ?? {} } : undefined,
      };
    });
    if (new Set(cds.map((x) => x.name)).size !== cds.length) throw clientErr('Duplicate container name.');
    const rev = Math.max(0, ...cs(ctx.s).taskDefs.filter((t) => t.family === p.Family && t.region === ctx.region).map((t) => t.revision)) + 1;
    const td: TaskDef = {
      family: p.Family, revision: rev, arn: arn(ctx, 'task-definition', `${p.Family}:${rev}`), region: ctx.region, status: 'ACTIVE', registeredAt: now(), containerDefinitions: cds,
      cpu: cpu === undefined ? undefined : String(cpu), memory: mem === undefined ? undefined : String(mem), networkMode, requiresCompatibilities: p.RequiresCompatibilities ?? ['EC2'],
      executionRoleArn: p.ExecutionRoleArn, taskRoleArn: p.TaskRoleArn, tags: tagMap(p.Tags),
    };
    cs(ctx.s).taskDefs.push(td);
    return td;
  });
}
export function findTaskDef(ctx: Ctx, ref: string): TaskDef | undefined {
  const r = ref.startsWith('arn:') ? ref.split('/').pop()! : ref;
  const [family, rev] = r.split(':');
  const list = cs(ctx.s).taskDefs.filter((t) => t.family === family && t.region === ctx.region);
  if (rev) return list.find((t) => t.revision === Number(rev));
  return list.filter((t) => t.status === 'ACTIVE').sort((a, b) => b.revision - a.revision)[0];
}
export function describeTaskDefinition(ctx: Ctx, p: { TaskDefinition: string }): TaskDef {
  return trailed(ctx, SRC, 'DescribeTaskDefinition', [], { taskDefinition: p.TaskDefinition }, () => {
    authorize(ctx, 'ecs:DescribeTaskDefinition', '*');
    const td = findTaskDef(ctx, p.TaskDefinition);
    if (!td) throw clientErr('Unable to describe task definition.');
    return td;
  });
}
export function listTaskDefinitions(ctx: Ctx, p: { FamilyPrefix?: string; Status?: string } = {}): TaskDef[] {
  return trailed(ctx, SRC, 'ListTaskDefinitions', [], p, () => {
    authorize(ctx, 'ecs:ListTaskDefinitions', '*');
    return cs(ctx.s).taskDefs.filter((t) => t.region === ctx.region && (!p.FamilyPrefix || t.family.startsWith(p.FamilyPrefix)) && t.status === (p.Status ?? 'ACTIVE')).sort((a, b) => a.family.localeCompare(b.family) || a.revision - b.revision);
  });
}
export function deregisterTaskDefinition(ctx: Ctx, p: { TaskDefinition: string }): TaskDef {
  return trailed(ctx, SRC, 'DeregisterTaskDefinition', [], { taskDefinition: p.TaskDefinition }, () => {
    authorize(ctx, 'ecs:DeregisterTaskDefinition', '*');
    const td = findTaskDef(ctx, p.TaskDefinition);
    if (!td || !/:\d+$/.test(p.TaskDefinition)) throw clientErr('The specified task definition does not exist. Specify a valid account, family, revision and try again.'.replace('The specified task definition does not exist. Specify a valid account, family, revision and try again.', 'Unable to describe task definition.'));
    td.status = 'INACTIVE';
    td.deregisteredAt = now();
    return td;
  });
}

// ------------------------------------------------------------------ red y fallos de arranque

interface NetCfg { subnets: string[]; securityGroups: string[]; assignPublicIp: 'ENABLED' | 'DISABLED' }
function netConfig(ctx: Ctx, td: TaskDef, raw: any): NetCfg {
  const v = raw?.awsvpcConfiguration ?? raw?.AwsvpcConfiguration;
  if (!v) throw invalid("Network Configuration must be provided when networkMode 'awsvpc' is specified.");
  const subnets: string[] = [].concat(v.subnets ?? []);
  if (!subnets.length) throw invalid('At least one subnet must be specified.'.replace('At least one subnet must be specified.', 'Subnets can not be empty.'));
  for (const id of subnets) if (!ctx.s.subnets.some((x) => x.id === id && x.region === ctx.region)) throw invalid(`Error retrieving subnet information for [${id}]: The subnet ID '${id}' does not exist (ErrorCode: InvalidSubnetID.NotFound)`);
  const vpcs = new Set(subnets.map((id) => ctx.s.subnets.find((x) => x.id === id)!.vpcId));
  if (vpcs.size > 1) throw invalid('Subnets must belong to the same VPC.'.replace('Subnets must belong to the same VPC.', 'All subnets must be in the same VPC.'));
  const vpc = [...vpcs][0];
  let sgs: string[] = [].concat(v.securityGroups ?? []);
  if (!sgs.length) sgs = [ctx.s.vpcs.find((x) => x.id === vpc)!.defaultSecurityGroupId];
  for (const g of sgs) if (!ctx.s.securityGroups.some((x) => x.id === g && x.region === ctx.region)) throw invalid(`Error retrieving security group information for [${g}]: The security group '${g}' does not exist (ErrorCode: InvalidGroup.NotFound)`);
  void td;
  const pub = String(v.assignPublicIp ?? 'DISABLED').toUpperCase();
  if (!['ENABLED', 'DISABLED'].includes(pub)) throw invalid(`Invalid assignPublicIp: ${v.assignPublicIp}`);
  return { subnets, securityGroups: sgs, assignPublicIp: pub as 'ENABLED' | 'DISABLED' };
}

/** ¿Sale la tarea a internet? IGW con IP pública asignada, o NAT. */
function hasEgress(s: CloudState, sub: Subnet, publicIp: boolean): { ok: boolean; why: string } {
  const rt = routeTableOfSubnet(s, sub);
  const def = rt.routes.find((r) => r.destination === '0.0.0.0/0');
  if (!def) return { ok: false, why: 'no default route' };
  if (def.target.startsWith('igw-')) return publicIp ? { ok: true, why: '' } : { ok: false, why: 'igw without public ip' };
  if (def.target.startsWith('nat-')) return { ok: true, why: '' };
  return { ok: false, why: 'unsupported route target' };
}
const randIp = (seed: string) => { const n = parseInt(hex(6), 16) ^ seed.length; return `${3 + (n % 50)}.${(n >> 6) % 250}.${(n >> 12) % 250}.${1 + ((n >> 3) % 250)}`; };

function roleAllows(s: CloudState, roleArn: string, action: string): 'missing' | boolean {
  const name = roleArn.split('/').pop() ?? '';
  if (!s.roles.some((r) => r.name === name)) return 'missing';
  return check({ s, region: s.region, caller: { type: 'AssumedRole', arn: `arn:aws:sts::${s.account.id}:assumed-role/${name}/ecs-tasks`, userName: 'ecs-tasks', roleName: name, mfa: false, sourceIp: 'ecs-tasks.amazonaws.com' } }, action, '*').decision === 'Allow';
}

/** Motivo por el que un contenedor no puede arrancar (o undefined si arranca). */
function startFailure(s: CloudState, t: EcsTask, td: TaskDef): string | undefined {
  const sub = s.subnets.find((x) => x.id === t.subnetId)!;
  const eg = hasEgress(s, sub, !!t.publicIp);
  for (const cd of td.containerDefinitions) {
    const r = parseRef(cd.image);
    const res = resolveImage(s, cd.image);
    const ref = `${r.registry}/${r.repo}:${r.tag}`;
    if (res.ok === false ? res.reason === 'RepositoryNotFound' || res.reason === 'TagNotFound' || /\.dkr\.ecr\./.test(r.registry) : res.source === 'ecr') {
      if (!eg.ok) return `ResourceInitializationError: unable to pull secrets or registry auth: The task cannot pull registry auth from Amazon ECR: There is a connection issue between the task and Amazon ECR. Check your task network configuration. RequestError: send request failed caused by: Post "https://api.ecr.${s.region}.amazonaws.com/": dial tcp ${randIp(cd.image)}:443: i/o timeout`;
      if (!td.executionRoleArn) return `CannotPullContainerError: pull image manifest has been retried 5 time(s): failed to resolve ref ${ref}: pull access denied, repository does not exist or may require authorization: authorization failed: no basic auth credentials`;
      const ok = roleAllows(s, td.executionRoleArn, 'ecr:GetAuthorizationToken');
      if (ok === 'missing' || ok === false) return `ResourceInitializationError: unable to pull secrets or registry auth: execution resource retrieval failed: unable to retrieve ecr registry auth: service call has been retried 3 time(s): AccessDeniedException: User: arn:aws:sts::${s.account.id}:assumed-role/${td.executionRoleArn.split('/').pop()}/ecs-tasks is not authorized to perform: ecr:GetAuthorizationToken on resource: * because no identity-based policy allows the ecr:GetAuthorizationToken action`;
      if (!res.ok) return `CannotPullContainerError: pull image manifest has been retried 5 time(s): failed to resolve ref ${ref}: ${ref}: not found`;
    } else {
      if (!res.ok) return `CannotPullContainerError: pull image manifest has been retried 5 time(s): failed to resolve ref ${ref}: ${res.reason === 'NotFound' ? ref + ': not found' : 'pull access denied, repository does not exist or may require authorization'}`;
      if (!eg.ok) return `CannotPullContainerError: pull image manifest has been retried 5 time(s): failed to resolve ref ${ref}: failed to do request: Head "https://registry-1.docker.io/v2/${r.repo}/manifests/${r.tag}": dial tcp ${randIp(cd.image)}:443: i/o timeout`;
    }
    const lc = cd.logConfiguration;
    if (lc?.logDriver === 'awslogs') {
      const g = lc.options['awslogs-group'];
      if (!s.logGroups.some((x) => x.name === g && x.region === (lc.options['awslogs-region'] ?? s.region)) && lc.options['awslogs-create-group'] !== 'true') return `ResourceInitializationError: failed to validate logger args: create stream has been retried 1 times: failed to create Cloudwatch log stream: ResourceNotFoundException: The specified log group does not exist.\n\tstatus code: 400, request id: ${guid()} : exit status 1`;
    }
  }
  return undefined;
}

// ------------------------------------------------------------------ tareas

const ID = () => hex(32);
interface Overrides { containerOverrides?: { name: string; command?: string[]; environment?: { name: string; value: string }[] }[] }

function launchTask(s: CloudState, region: string, o: { cluster: EcsCluster; td: TaskDef; net: NetCfg; group: string; startedBy?: string; service?: EcsService; deploymentId?: string; overrides?: Overrides }): EcsTask {
  const id = ID();
  const used = cs(s).ecsTasks.filter((t) => t.clusterName === o.cluster.name && t.lastStatus !== 'STOPPED' && o.net.subnets.includes(t.subnetId));
  const subId = [...o.net.subnets].sort((a, b) => used.filter((t) => t.subnetId === a).length - used.filter((t) => t.subnetId === b).length)[0];
  const sub = s.subnets.find((x) => x.id === subId)!;
  const cpu = o.td.cpu ?? String(o.td.containerDefinitions.reduce((a, c) => a + (c.cpu ?? 0), 0) || 256);
  const memory = o.td.memory ?? String(o.td.containerDefinitions.reduce((a, c) => a + (c.memory ?? c.memoryReservation ?? 0), 0));
  const t: EcsTask = {
    arn: `arn:aws:ecs:${region}:${s.account.id}:task/${o.cluster.name}/${id}`, id, clusterName: o.cluster.name, region, taskDefinition: o.td.arn, group: o.group, startedBy: o.startedBy, serviceName: o.service?.name, deploymentId: o.deploymentId,
    lastStatus: 'PROVISIONING', desiredStatus: 'RUNNING', createdAt: now(), subnetId: sub.id, az: sub.az, securityGroups: o.net.securityGroups, eniId: ids.eni(), privateIp: allocIp(s, sub.id),
    publicIp: o.net.assignPublicIp === 'ENABLED' ? randIp(id) : undefined, launchType: 'FARGATE', cpu, memory,
    containers: o.td.containerDefinitions.map((c) => ({ name: c.name, image: c.image, lastStatus: 'PENDING' as const, runtimeId: `${id}-${digits(10)}` })),
    runCmd: Object.fromEntries((o.overrides?.containerOverrides ?? []).map((c) => [c.name, { command: c.command, environment: c.environment }])),
  };
  cs(s).ecsTasks.push(t);
  return t;
}

export function runTask(ctx: Ctx, p: { Cluster?: string; TaskDefinition: string; Count?: number; LaunchType?: string; NetworkConfiguration?: any; Overrides?: Overrides; StartedBy?: string; Group?: string }) {
  return trailed(ctx, SRC, 'RunTask', [{ type: 'AWS::ECS::TaskDefinition', name: p.TaskDefinition }], { cluster: p.Cluster, taskDefinition: p.TaskDefinition, count: p.Count, launchType: p.LaunchType }, () => {
    authorize(ctx, 'ecs:RunTask', p.TaskDefinition.startsWith('arn:') ? p.TaskDefinition : arn(ctx, 'task-definition', p.TaskDefinition.includes(':') ? p.TaskDefinition : p.TaskDefinition + ':*'));
    const cl = getCluster(ctx, p.Cluster);
    const td = findTaskDef(ctx, p.TaskDefinition);
    if (!td) throw clientErr('TaskDefinition not found.');
    if (td.status === 'INACTIVE') throw invalid('TaskDefinition is inactive');
    const count = p.Count ?? 1;
    if (count < 1 || count > 10) throw invalid('Invalid count: must be between 1 and 10.'.replace('Invalid count: must be between 1 and 10.', `Count must be between 1 and 10`));
    const lt = p.LaunchType ?? 'EC2';
    if (lt === 'EC2') return { tasks: [] as EcsTask[], failures: [{ arn: cl.arn, reason: 'No Container Instances were found in your cluster.' }] };
    if (!td.requiresCompatibilities.includes('FARGATE')) throw invalid('Task definition does not support launch_type FARGATE.');
    const net = netConfig(ctx, td, p.NetworkConfiguration);
    for (const o of p.Overrides?.containerOverrides ?? []) if (!td.containerDefinitions.some((c) => c.name === o.name)) throw invalid(`Override for container '${o.name}' not found in the task definition.`.replace('Override for container', 'Container override').replace(' not found in the task definition.', ' does not exist in the task definition.'));
    const tasks: EcsTask[] = [];
    for (let i = 0; i < count; i++) tasks.push(launchTask(ctx.s, ctx.region, { cluster: cl, td, net, group: p.Group ?? `family:${td.family}`, startedBy: p.StartedBy, overrides: p.Overrides }));
    return { tasks, failures: [] as { arn: string; reason: string }[] };
  });
}
export function findTask(ctx: Ctx, cluster: string | undefined, ref: string): EcsTask | undefined {
  const cl = getCluster(ctx, cluster);
  const id = ref.split('/').pop();
  return cs(ctx.s).ecsTasks.find((t) => t.clusterName === cl.name && t.region === ctx.region && t.id === id);
}
export function describeTasks(ctx: Ctx, p: { Cluster?: string; Tasks: string[] }) {
  return trailed(ctx, SRC, 'DescribeTasks', [], { cluster: p.Cluster, tasks: p.Tasks }, () => {
    authorize(ctx, 'ecs:DescribeTasks', '*');
    getCluster(ctx, p.Cluster);
    settleEcs(ctx.s);
    const tasks: EcsTask[] = [];
    const failures: { arn: string; reason: string }[] = [];
    for (const r of p.Tasks ?? []) { const t = findTask(ctx, p.Cluster, r); if (t) tasks.push(t); else failures.push({ arn: r.startsWith('arn:') ? r : arn(ctx, 'task', `${nameOf(p.Cluster ?? 'default')}/${r}`), reason: 'MISSING' }); }
    return { tasks, failures };
  });
}
export function listTasks(ctx: Ctx, p: { Cluster?: string; ServiceName?: string; DesiredStatus?: string; Family?: string; StartedBy?: string } = {}): EcsTask[] {
  return trailed(ctx, SRC, 'ListTasks', [], p, () => {
    authorize(ctx, 'ecs:ListTasks', '*');
    const cl = getCluster(ctx, p.Cluster);
    settleEcs(ctx.s);
    const want = p.DesiredStatus ?? 'RUNNING';
    return cs(ctx.s).ecsTasks.filter((t) => t.clusterName === cl.name && t.region === ctx.region && t.desiredStatus === want && (!p.ServiceName || t.serviceName === p.ServiceName) && (!p.Family || t.taskDefinition.includes(`/${p.Family}:`)) && (!p.StartedBy || t.startedBy === p.StartedBy));
  });
}
function stop(t: EcsTask, reason: string, code: string) {
  if (t.desiredStatus === 'STOPPED') return;
  t.desiredStatus = 'STOPPED';
  t.stoppingAt = now();
  t.stoppedReason = reason;
  t.stopCode = code;
  if (t.lastStatus === 'PROVISIONING' || t.lastStatus === 'PENDING') { t.lastStatus = 'STOPPED'; t.stoppedAt = now(); for (const c of t.containers) c.lastStatus = 'STOPPED'; }
  else if (t.lastStatus === 'RUNNING') t.lastStatus = 'DEPROVISIONING';
}
export function stopTask(ctx: Ctx, p: { Cluster?: string; Task: string; Reason?: string }): EcsTask {
  return trailed(ctx, SRC, 'StopTask', [], { cluster: p.Cluster, task: p.Task, reason: p.Reason }, () => {
    authorize(ctx, 'ecs:StopTask', '*');
    const t = findTask(ctx, p.Cluster, p.Task);
    if (!t) throw invalid('The referenced task was not found.');
    stop(t, p.Reason ?? 'Task stopped by user', 'UserInitiated');
    settleEcs(ctx.s);
    return t;
  });
}

// ------------------------------------------------------------------ servicios

const tgOfService = (s: CloudState, sv: EcsService) => sv.loadBalancers.map((l) => s.targetGroups.find((g) => g.arn === l.targetGroupArn)).filter(Boolean) as CloudState['targetGroups'];
const svcEvent = (sv: EcsService, message: string) => { sv.events.unshift({ id: guid(), ts: now(), message }); if (sv.events.length > 100) sv.events.pop(); };
const depId = () => `ecs-svc/${digits(19)}`;

export function getService(ctx: Ctx, cluster: string | undefined, name: string): EcsService {
  const cl = getCluster(ctx, cluster);
  const sv = cs(ctx.s).ecsServices.find((x) => x.clusterName === cl.name && x.region === ctx.region && x.name === nameOf(name) && x.status !== 'INACTIVE');
  if (!sv) throw new AwsError('ServiceNotFoundException', 'Service not found.');
  return sv;
}
export function createService(ctx: Ctx, p: { Cluster?: string; ServiceName: string; TaskDefinition: string; DesiredCount?: number; LaunchType?: string; NetworkConfiguration?: any; LoadBalancers?: any[]; HealthCheckGracePeriodSeconds?: number; Tags?: any[] }): EcsService {
  return trailed(ctx, SRC, 'CreateService', [{ type: 'AWS::ECS::Service', name: p.ServiceName }], { cluster: p.Cluster, serviceName: p.ServiceName, taskDefinition: p.TaskDefinition, desiredCount: p.DesiredCount, launchType: p.LaunchType }, () => {
    authorize(ctx, 'ecs:CreateService', arn(ctx, 'service', `${nameOf(p.Cluster ?? 'default')}/${p.ServiceName}`));
    const cl = getCluster(ctx, p.Cluster);
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(p.ServiceName ?? '')) throw invalid('Service name must be 1-255 characters of letters, numbers, hyphens and underscores.'.replace('Service name must be 1-255 characters of letters, numbers, hyphens and underscores.', 'Invalid service name.'));
    const td = findTaskDef(ctx, p.TaskDefinition);
    if (!td) throw clientErr('TaskDefinition not found.');
    if (td.status === 'INACTIVE') throw invalid('Unable to Start a service that is not ACTIVE'.replace('Unable to Start a service that is not ACTIVE', 'TaskDefinition is inactive'));
    if (cs(ctx.s).ecsServices.some((x) => x.clusterName === cl.name && x.region === ctx.region && x.name === p.ServiceName && x.status === 'ACTIVE')) throw invalid('Creation of service was not idempotent.');
    const lt = p.LaunchType ?? 'EC2';
    if (lt === 'FARGATE' && !td.requiresCompatibilities.includes('FARGATE')) throw invalid('Task definition does not support launch_type FARGATE.');
    const net = lt === 'FARGATE' || td.networkMode === 'awsvpc' ? netConfig(ctx, td, p.NetworkConfiguration) : { subnets: [], securityGroups: [], assignPublicIp: 'DISABLED' as const };
    const lbs = (p.LoadBalancers ?? []).map((l: any) => ({ targetGroupArn: l.targetGroupArn ?? l.TargetGroupArn, containerName: l.containerName ?? l.ContainerName, containerPort: Number(l.containerPort ?? l.ContainerPort) }));
    for (const l of lbs) {
      const g = ctx.s.targetGroups.find((x) => x.arn === l.targetGroupArn);
      if (!g) throw invalid(`Target group ${l.targetGroupArn} not found`.replace('Target group ', 'Target group not found: '));
      const cd = td.containerDefinitions.find((c) => c.name === l.containerName);
      if (!cd) throw invalid(`The container ${l.containerName} does not exist in the task definition.`);
      if (!cd.portMappings.some((m) => m.containerPort === l.containerPort)) throw invalid(`The container ${l.containerName} did not have a container port ${l.containerPort} defined.`);
      if (td.networkMode === 'awsvpc' && g.targetType !== 'ip') throw invalid(`The provided target group ${g.arn} has target type instance, which is incompatible with the awsvpc network mode specified in the task definition.`);
      if (!ctx.s.listeners.some((x) => x.tgArn === g.arn)) throw invalid(`The target group with targetGroupArn ${g.arn} does not have an associated load balancer.`);
      if (net.subnets.length && ctx.s.subnets.find((x) => x.id === net.subnets[0])?.vpcId !== g.vpcId) throw invalid(`The target group ${g.arn} is in a different VPC from the service subnets.`.replace('The target group ', 'Target group ').replace(' is in a different VPC from the service subnets.', ' belongs to a different VPC than the subnets of the service.'));
    }
    const t = now();
    const dep = depId();
    const sv: EcsService = {
      name: p.ServiceName, arn: arn(ctx, 'service', `${cl.name}/${p.ServiceName}`), clusterName: cl.name, region: ctx.region, taskDefinition: td.arn, desiredCount: p.DesiredCount ?? 1, launchType: lt, createdAt: t, status: 'ACTIVE',
      subnets: net.subnets, securityGroups: net.securityGroups, assignPublicIp: net.assignPublicIp, loadBalancers: lbs, events: [], healthCheckGracePeriodSeconds: p.HealthCheckGracePeriodSeconds ?? 0,
      deployments: [{ id: dep, status: 'PRIMARY', taskDefinition: td.arn, desiredCount: p.DesiredCount ?? 1, createdAt: t, updatedAt: t, rolloutState: 'IN_PROGRESS' }], tags: tagMap(p.Tags), failures: 0,
    };
    cs(ctx.s).ecsServices.push(sv);
    settleEcs(ctx.s);
    return sv;
  });
}
export function describeServices(ctx: Ctx, p: { Cluster?: string; Services: string[] }) {
  return trailed(ctx, SRC, 'DescribeServices', [], { cluster: p.Cluster, services: p.Services }, () => {
    authorize(ctx, 'ecs:DescribeServices', '*');
    const cl = getCluster(ctx, p.Cluster);
    settleEcs(ctx.s);
    const services: EcsService[] = [];
    const failures: { arn: string; reason: string }[] = [];
    for (const n of p.Services ?? []) {
      const sv = cs(ctx.s).ecsServices.find((x) => x.clusterName === cl.name && x.region === ctx.region && x.name === nameOf(n));
      if (sv) services.push(sv); else failures.push({ arn: arn(ctx, 'service', `${cl.name}/${nameOf(n)}`), reason: 'MISSING' });
    }
    return { services, failures };
  });
}
export function listServices(ctx: Ctx, p: { Cluster?: string } = {}): EcsService[] {
  return trailed(ctx, SRC, 'ListServices', [], p, () => { authorize(ctx, 'ecs:ListServices', '*'); const cl = getCluster(ctx, p.Cluster); return cs(ctx.s).ecsServices.filter((x) => x.clusterName === cl.name && x.region === ctx.region && x.status === 'ACTIVE'); });
}
export function serviceCounts(s: CloudState, sv: EcsService) {
  const ts = cs(s).ecsTasks.filter((t) => t.serviceName === sv.name && t.clusterName === sv.clusterName && t.region === sv.region);
  const of = (id?: string) => ts.filter((t) => (!id || t.deploymentId === id));
  return {
    running: of().filter((t) => t.lastStatus === 'RUNNING').length, pending: of().filter((t) => t.lastStatus === 'PROVISIONING' || t.lastStatus === 'PENDING').length,
    byDeployment: (id: string) => ({ running: of(id).filter((t) => t.lastStatus === 'RUNNING').length, pending: of(id).filter((t) => t.lastStatus === 'PROVISIONING' || t.lastStatus === 'PENDING').length, failed: of(id).filter((t) => t.stopCode === 'TaskFailedToStart').length }),
  };
}
export function updateService(ctx: Ctx, p: { Cluster?: string; Service: string; DesiredCount?: number; TaskDefinition?: string; ForceNewDeployment?: boolean; HealthCheckGracePeriodSeconds?: number }): EcsService {
  return trailed(ctx, SRC, 'UpdateService', [{ type: 'AWS::ECS::Service', name: p.Service }], { cluster: p.Cluster, service: p.Service, desiredCount: p.DesiredCount, taskDefinition: p.TaskDefinition }, () => {
    authorize(ctx, 'ecs:UpdateService', arn(ctx, 'service', `${nameOf(p.Cluster ?? 'default')}/${nameOf(p.Service)}`));
    const sv = getService(ctx, p.Cluster, p.Service);
    if (p.DesiredCount !== undefined) {
      if (!(Number(p.DesiredCount) >= 0)) throw invalid('Desired count must be greater than or equal to 0.'.replace('Desired count must be greater than or equal to 0.', 'Invalid desiredCount.'));
      sv.desiredCount = Number(p.DesiredCount);
      sv.deployments.find((d) => d.status === 'PRIMARY')!.desiredCount = sv.desiredCount;
    }
    if (p.HealthCheckGracePeriodSeconds !== undefined) sv.healthCheckGracePeriodSeconds = Number(p.HealthCheckGracePeriodSeconds);
    let td: TaskDef | undefined;
    if (p.TaskDefinition) { td = findTaskDef(ctx, p.TaskDefinition); if (!td) throw clientErr('TaskDefinition not found.'); }
    if ((td && td.arn !== sv.taskDefinition) || p.ForceNewDeployment) {
      const t = now();
      for (const d of sv.deployments) if (d.status === 'PRIMARY') d.status = 'ACTIVE';
      if (td) sv.taskDefinition = td.arn;
      sv.deployments.unshift({ id: depId(), status: 'PRIMARY', taskDefinition: sv.taskDefinition, desiredCount: sv.desiredCount, createdAt: t, updatedAt: t, rolloutState: 'IN_PROGRESS' });
      sv.failures = 0;
    }
    settleEcs(ctx.s);
    return sv;
  });
}
export function deleteService(ctx: Ctx, p: { Cluster?: string; Service: string; Force?: boolean }): EcsService {
  return trailed(ctx, SRC, 'DeleteService', [{ type: 'AWS::ECS::Service', name: p.Service }], { cluster: p.Cluster, service: p.Service, force: p.Force }, () => {
    authorize(ctx, 'ecs:DeleteService', arn(ctx, 'service', `${nameOf(p.Cluster ?? 'default')}/${nameOf(p.Service)}`));
    const sv = getService(ctx, p.Cluster, p.Service);
    if (sv.desiredCount > 0 && !p.Force) throw invalid('The service cannot be stopped while it is scaled above 0.');
    sv.status = 'DRAINING';
    sv.desiredCount = 0;
    for (const t of cs(ctx.s).ecsTasks.filter((x) => x.serviceName === sv.name && x.clusterName === sv.clusterName)) stop(t, 'Service deleted', 'ServiceSchedulerInitiated');
    settleEcs(ctx.s);
    return sv;
  });
}

// ------------------------------------------------------------------ evaluación perezosa

const logsFor = (s: CloudState, t: EcsTask, td: TaskDef, at: number) => {
  td.containerDefinitions.forEach((cd, i) => {
    const lc = cd.logConfiguration;
    if (lc?.logDriver !== 'awslogs') return;
    const gname = lc.options['awslogs-group'];
    const region = lc.options['awslogs-region'] ?? t.region;
    let g = s.logGroups.find((x) => x.name === gname && x.region === region);
    if (!g && lc.options['awslogs-create-group'] === 'true') { g = { name: gname, arn: `arn:aws:logs:${region}:${s.account.id}:log-group:${gname}:*`, region, created: now(), streams: [], filters: [], tags: {} }; s.logGroups.push(g); }
    if (!g) return;
    const stName = `${lc.options['awslogs-stream-prefix'] ?? 'ecs'}/${cd.name}/${t.id}`;
    if (g.streams.some((x) => x.name === stName)) return;
    const run = runOf(s, t, td, cd, i);
    g.streams.push({ name: stName, created: at, seq: 1, events: run.lines.map((message, k) => ({ ts: at + k, message, ingestion: at + k })) });
  });
};
function runOf(s: CloudState, t: EcsTask, td: TaskDef, cd: ContainerDef, _i: number) {
  void _i;
  const res = resolveImage(s, cd.image);
  const ov = t.runCmd?.[cd.name];
  const meta: ImageMeta | undefined = res.ok ? res.meta : undefined;
  const env = Object.fromEntries([...cd.environment, ...(ov?.environment ?? [])].map((e) => [e.name, e.value]));
  const base = meta ?? ({ env: {}, exposed: [], workdir: '/', resident: false, baseRef: cd.image, sizeBytes: 0, layers: 1, logs: [] } as ImageMeta);
  void td;
  return simulateRun({ ...base, entrypoint: undefined, cmd: undefined }, { command: [...(cd.entryPoint ?? base.entrypoint ?? []), ...(ov?.command ?? cd.command ?? (cd.entryPoint ? [] : base.cmd ?? []))], env, host: t.id.slice(0, 12) });
}

function advanceTask(s: CloudState, t: EcsTask) {
  if (t.lastStatus === 'STOPPED') return;
  const f = speedFactor();
  const age = now() - t.createdAt;
  const td = cs(s).taskDefs.find((x) => x.arn === t.taskDefinition)!;
  if (t.lastStatus === 'DEPROVISIONING') {
    if (f === 0 || now() - (t.stoppingAt ?? 0) >= 3000 * f) { t.lastStatus = 'STOPPED'; t.stoppedAt = now(); for (const c of t.containers) { c.lastStatus = 'STOPPED'; c.exitCode ??= 137; } }
    return;
  }
  if (t.lastStatus === 'PROVISIONING' && (f === 0 || age >= 2000 * f)) t.lastStatus = 'PENDING';
  if (t.lastStatus === 'PENDING' && (f === 0 || age >= 6000 * f)) {
    const fail = startFailure(s, t, td);
    if (fail) {
      t.lastStatus = 'STOPPED'; t.desiredStatus = 'STOPPED'; t.stoppedAt = now(); t.stoppingAt = now(); t.stoppedReason = 'Task failed to start'; t.stopCode = 'TaskFailedToStart';
      for (const c of t.containers) { c.lastStatus = 'STOPPED'; c.reason = fail; }
      return;
    }
    t.lastStatus = 'RUNNING';
    t.startedAt = now();
    t.containers.forEach((c, i) => { c.lastStatus = 'RUNNING'; const r = resolveImage(s, c.image); if (r.ok) c.imageDigest = r.digest; void i; });
    logsFor(s, t, td, now());
  }
  if (t.lastStatus === 'RUNNING') {
    // Contenedores que terminan solos: si es esencial, la tarea se detiene.
    const exits = td.containerDefinitions.map((cd, i) => ({ cd, i, run: runOf(s, t, td, cd, i) }));
    const done = exits.filter((e) => !e.run.resident);
    const essentialDone = done.find((e) => e.cd.essential);
    if (essentialDone && (f === 0 || now() - (t.startedAt ?? 0) >= 2000 * f)) {
      for (const e of exits) { const c = t.containers[e.i]; c.lastStatus = 'STOPPED'; c.exitCode = e.run.resident ? 137 : e.run.exitCode; if (e.run.execError) c.reason = `CannotStartContainerError: ${e.run.execError}`; }
      t.lastStatus = 'STOPPED'; t.desiredStatus = 'STOPPED'; t.stoppedAt = now(); t.stoppedReason = 'Essential container in task exited'; t.stopCode = 'EssentialContainerExited'; t.exitCode = essentialDone.run.exitCode;
    }
  }
}

function sync(s: CloudState) {
  const f = speedFactor();
  const st = cs(s);
  for (const t of st.ecsTasks) advanceTask(s, t);
  for (const sv of [...st.ecsServices]) {
    const ts = st.ecsTasks.filter((t) => t.serviceName === sv.name && t.clusterName === sv.clusterName && t.region === sv.region);
    if (sv.status === 'DRAINING') { if (ts.every((t) => t.lastStatus === 'STOPPED')) { sv.status = 'INACTIVE'; for (const g of tgOfService(s, sv)) g.targets = g.targets.filter((x) => !ts.some((t) => t.privateIp === x.id)); } continue; }
    if (sv.status !== 'ACTIVE') continue;
    const primary = sv.deployments.find((d) => d.status === 'PRIMARY')!;
    const live = ts.filter((t) => t.lastStatus !== 'STOPPED' && t.desiredStatus === 'RUNNING');
    const mine = live.filter((t) => t.deploymentId === primary.id);
    const olds = live.filter((t) => t.deploymentId !== primary.id);
    // Fallos de arranque: aplican espera creciente entre reintentos.
    for (const t of ts) if (t.stopCode === 'TaskFailedToStart' && !t.counted) { t.counted = true; sv.failures++; sv.lastFailureAt = t.stoppedAt; svcEvent(sv, `(service ${sv.name}) was unable to keep the task running: ${t.stoppedReason}.`); }
    for (const t of ts) if (t.lastStatus === 'RUNNING' && sv.failures) sv.failures = 0;
    if (sv.launchType === 'EC2') { if (!sv.events.some((e) => /unable to place/.test(e.message))) svcEvent(sv, `(service ${sv.name}) was unable to place a task because no container instance met all of its requirements. Reason: No Container Instances were found in your cluster.`); continue; }
    const td = cs(s).taskDefs.find((x) => x.arn === primary.taskDefinition)!;
    const need = primary.desiredCount - mine.length;
    const gap = sv.failures ? Math.min(2 ** sv.failures * 3000, 60_000) * Math.max(f, 0.2) : 0;
    if (need > 0 && (!sv.lastFailureAt || !sv.failures || now() - sv.lastFailureAt >= gap)) {
      const cl = st.ecsClusters.find((c) => c.name === sv.clusterName && c.region === sv.region)!;
      const created: EcsTask[] = [];
      for (let i = 0; i < need; i++) created.push(launchTask(s, sv.region, { cluster: cl, td, net: { subnets: sv.subnets, securityGroups: sv.securityGroups, assignPublicIp: sv.assignPublicIp }, group: `service:${sv.name}`, startedBy: primary.id, service: sv, deploymentId: primary.id }));
      svcEvent(sv, `(service ${sv.name}) has started ${created.length} tasks: ${created.map((t) => `(task ${t.id})`).join(' ')}.`);
      for (const t of created) advanceTask(s, t);
    } else if (need < 0) for (const t of [...mine].sort((a, b) => b.createdAt - a.createdAt).slice(0, -need)) stop(t, 'Scaling activity initiated by (deployment ' + primary.id + ')', 'ServiceSchedulerInitiated');
    const running = mine.filter((t) => t.lastStatus === 'RUNNING').length;
    if (olds.length && running >= primary.desiredCount) for (const t of olds) stop(t, `Scaling activity initiated by (deployment ${primary.id})`, 'ServiceSchedulerInitiated');
    // Registro en los grupos de destino.
    for (const l of sv.loadBalancers) {
      const g = s.targetGroups.find((x) => x.arn === l.targetGroupArn);
      if (!g) continue;
      const add = ts.filter((t) => t.lastStatus === 'RUNNING' && t.desiredStatus === 'RUNNING' && !g.targets.some((x) => x.id === t.privateIp && x.port === l.containerPort));
      for (const t of add) g.targets.push({ id: t.privateIp, port: l.containerPort, since: now() });
      if (add.length) svcEvent(sv, `(service ${sv.name}) registered ${add.length} targets in (target-group ${g.arn})`);
      const gone = g.targets.filter((x) => ts.some((t) => t.privateIp === x.id && (t.desiredStatus === 'STOPPED' || t.lastStatus === 'STOPPED')));
      if (gone.length) { g.targets = g.targets.filter((x) => !gone.includes(x)); svcEvent(sv, `(service ${sv.name}) deregistered ${gone.length} targets in (target-group ${g.arn})`); }
    }
    // Despliegues.
    const nowRunning = ts.filter((t) => t.deploymentId === primary.id && t.lastStatus === 'RUNNING').length;
    const stillOld = ts.some((t) => t.deploymentId !== primary.id && t.lastStatus !== 'STOPPED');
    if (primary.rolloutState === 'IN_PROGRESS' && nowRunning >= primary.desiredCount && !stillOld) { primary.rolloutState = 'COMPLETED'; primary.updatedAt = now(); sv.deployments = sv.deployments.filter((d) => d === primary); svcEvent(sv, `(service ${sv.name}) has reached a steady state.`); }
    else if (primary.desiredCount === 0 && !sv.events[0]?.message.includes('steady')) { /* sin tareas que desplegar */ }
    // Poda del historial de tareas detenidas.
    const stopped = ts.filter((t) => t.lastStatus === 'STOPPED').sort((a, b) => (b.stoppedAt ?? 0) - (a.stoppedAt ?? 0));
    if (stopped.length > 10) { const drop = new Set(stopped.slice(10)); st.ecsTasks = st.ecsTasks.filter((t) => !drop.has(t)); }
  }
  st.ecsServices = st.ecsServices.filter((x) => x.status !== 'INACTIVE');
  // Las tareas sueltas detenidas se conservan un rato y se podan al pasar de 50.
  const loose = st.ecsTasks.filter((t) => !t.serviceName && t.lastStatus === 'STOPPED').sort((a, b) => (b.stoppedAt ?? 0) - (a.stoppedAt ?? 0));
  if (loose.length > 50) { const drop = new Set(loose.slice(50)); st.ecsTasks = st.ecsTasks.filter((t) => !drop.has(t)); }
}
let syncing = false;
export function settleEcs(s: CloudState) {
  if (syncing || !s.containers?.ecsClusters.length) return;
  syncing = true;
  try { sync(s); } finally { syncing = false; }
}
settleHooks.push(settleEcs);

// ------------------------------------------------------------------ salud de destinos de tipo ip

function taskByIp(s: CloudState, ip: string) { return cs(s).ecsTasks.filter((t) => t.privateIp === ip && t.lastStatus !== 'STOPPED').sort((a, b) => b.createdAt - a.createdAt)[0]; }
ipTargets.health = (s, tg, t): TargetState => {
  const task = taskByIp(s, t.id);
  if (!task) return { state: 'unhealthy', reason: 'Target.Timeout', description: 'Request timed out' };
  if (task.lastStatus === 'DEPROVISIONING' || task.desiredStatus === 'STOPPED') return { state: 'draining', reason: 'Target.DeregistrationInProgress', description: 'Target deregistration is in progress' };
  const ls = s.listeners.filter((l) => l.tgArn === tg.arn);
  if (!ls.length) return { state: 'unused', reason: 'Target.NotInUse', description: 'Target group is not configured to receive traffic from the load balancer' };
  const f = speedFactor();
  if (f > 0 && now() - t.since < Math.min(tg.hc.healthy * tg.hc.interval, 150) * 1000 * f) return { state: 'initial', reason: 'Elb.InitialHealthChecking', description: 'Initial health checking in progress' };
  const lbs = ls.map((l) => s.loadBalancers.find((x) => x.arn === l.lbArn)).filter(Boolean) as CloudState['loadBalancers'];
  const port = tg.hc.port === 'traffic-port' ? t.port : Number(tg.hc.port);
  const lbSubs = lbs.flatMap((l) => l.subnets.map((id) => s.subnets.find((x) => x.id === id)?.cidr ?? ''));
  const allowed = task.securityGroups.some((id) => s.securityGroups.find((g) => g.id === id)?.ingress.some((r) => (r.protocol === '-1' || (r.protocol === 'tcp' && r.from <= port && port <= r.to)) && ((r.sourceSg && lbs.some((l) => l.securityGroups.includes(r.sourceSg!))) || (r.cidr && lbSubs.some((c) => c && cidrWithin(c, r.cidr!))))));
  if (!allowed) return { state: 'unhealthy', reason: 'Target.Timeout', description: 'Request timed out' };
  const meta = taskMeta(s, task);
  if (!meta?.web || meta.web.port !== port) return { state: 'unhealthy', reason: 'Target.FailedHealthChecks', description: 'Health checks failed' };
  const staticApp = !task.containers.some((c) => /\.dkr\.ecr\./.test(c.image));
  if (staticApp && !['/', '/index.html'].includes(tg.hc.path)) return { state: 'unhealthy', reason: 'Target.ResponseCodeMismatch', description: `Health checks failed with these codes: [404]` };
  return { state: 'healthy' };
};
function taskMeta(s: CloudState, t: EcsTask): ImageMeta | null {
  for (const c of t.containers) { const r = resolveImage(s, c.image); if (r.ok && r.meta.web) return r.meta; }
  return null;
}
ipTargets.backends = (s, lb, port) => {
  const l = s.listeners.find((x) => x.lbArn === lb.arn && x.port === port);
  const tg = l && s.targetGroups.find((g) => g.arn === l.tgArn);
  if (!tg || tg.targetType !== 'ip') return [];
  return tg.targets.filter((t) => ipTargets.health!(s, tg, t).state === 'healthy').flatMap((t) => {
    const task = taskByIp(s, t.id);
    const meta = task && taskMeta(s, task);
    const w = meta && webBody(meta, task!.id.slice(0, 12));
    return w ? [{ body: w.body, server: w.server }] : [];
  });
};

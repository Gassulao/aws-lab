// aws ecs: clústeres, definiciones de tarea, servicios y tareas (Fargate).
import { defineCommand, type Params } from '../framework';
import * as ecs from '../../../engine/services/ecs';
import { cs, type EcsCluster, type EcsService, type EcsTask, type TaskDef } from '../../../engine/services/containerCore';
import { settle } from '../../../engine/services/ec2';
import { now } from '../../../engine/util';
import { speedFactor } from '../../../engine/store';

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000+00:00');
const arr = (v: any): any[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const need = (p: Params, key: string, opt: string) => { if (p[key] === undefined) throw new Error(`aws: error: the following arguments are required: --${opt}`); return p[key]; };
const n = (v: any) => (v === undefined ? undefined : Number(v));
const tagsOut = (t: Record<string, string>) => Object.entries(t).map(([key, value]) => ({ key, value }));

const clusterShape = (c: { s: any }, cl: EcsCluster) => { const k = ecs.clusterCounts(c.s, cl); return { clusterArn: cl.arn, clusterName: cl.name, status: 'ACTIVE', registeredContainerInstancesCount: 0, runningTasksCount: k.running, pendingTasksCount: k.pending, activeServicesCount: k.services, statistics: [], tags: tagsOut(cl.tags), settings: [{ name: 'containerInsights', value: cl.containerInsights ? 'enabled' : 'disabled' }], capacityProviders: [], defaultCapacityProviderStrategy: [] }; };
const tdShape = (c: { s: any; caller: any }, t: TaskDef) => ({
  taskDefinitionArn: t.arn,
  containerDefinitions: t.containerDefinitions.map((d) => ({
    name: d.name, image: d.image, cpu: d.cpu ?? 0, ...(d.memory !== undefined ? { memory: d.memory } : {}), ...(d.memoryReservation !== undefined ? { memoryReservation: d.memoryReservation } : {}),
    portMappings: d.portMappings, essential: d.essential, ...(d.command ? { command: d.command } : {}), ...(d.entryPoint ? { entryPoint: d.entryPoint } : {}), environment: d.environment, mountPoints: [], volumesFrom: [],
    ...(d.logConfiguration ? { logConfiguration: d.logConfiguration } : {}), systemControls: [],
  })),
  family: t.family, ...(t.taskRoleArn ? { taskRoleArn: t.taskRoleArn } : {}), ...(t.executionRoleArn ? { executionRoleArn: t.executionRoleArn } : {}), networkMode: t.networkMode, revision: t.revision, volumes: [], status: t.status,
  requiresAttributes: [{ name: 'com.amazonaws.ecs.capability.docker-remote-api.1.18' }, ...(t.networkMode === 'awsvpc' ? [{ name: 'ecs.capability.task-eni' }] : [])], placementConstraints: [],
  compatibilities: t.networkMode === 'awsvpc' ? ['EC2', 'FARGATE'] : ['EC2'], requiresCompatibilities: t.requiresCompatibilities, ...(t.cpu ? { cpu: t.cpu } : {}), ...(t.memory ? { memory: t.memory } : {}),
  runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' }, registeredAt: iso(t.registeredAt), ...(t.deregisteredAt ? { deregisteredAt: iso(t.deregisteredAt) } : {}), registeredBy: c.caller.arn,
});
const netShape = (sv: EcsService) => ({ awsvpcConfiguration: { subnets: sv.subnets, securityGroups: sv.securityGroups, assignPublicIp: sv.assignPublicIp } });
const svcShape = (c: { s: any }, sv: EcsService, fresh = false) => {
  const k = ecs.serviceCounts(c.s, sv);
  const cl = cs(c.s).ecsClusters.find((x) => x.name === sv.clusterName && x.region === sv.region)!;
  return {
    serviceArn: sv.arn, serviceName: sv.name, clusterArn: cl.arn, loadBalancers: sv.loadBalancers, serviceRegistries: [], status: sv.status, desiredCount: sv.desiredCount, runningCount: k.running, pendingCount: k.pending, launchType: sv.launchType,
    ...(sv.launchType === 'FARGATE' ? { platformVersion: 'LATEST', platformFamily: 'Linux' } : {}), taskDefinition: sv.taskDefinition,
    deploymentConfiguration: { deploymentCircuitBreaker: { enable: false, rollback: false }, maximumPercent: 200, minimumHealthyPercent: 100 },
    deployments: sv.deployments.map((d) => { const x = k.byDeployment(d.id); return { id: d.id, status: d.status, taskDefinition: d.taskDefinition, desiredCount: d.desiredCount, pendingCount: x.pending, runningCount: x.running, failedTasks: x.failed, createdAt: iso(d.createdAt), updatedAt: iso(d.updatedAt), launchType: sv.launchType, ...(sv.launchType === 'FARGATE' ? { platformVersion: '1.4.0', platformFamily: 'Linux' } : {}), networkConfiguration: netShape(sv), rolloutState: d.rolloutState, rolloutStateReason: d.rolloutState === 'COMPLETED' ? `ECS deployment ${d.id} completed.` : `ECS deployment ${d.id} in progress.` }; }),
    roleArn: `arn:aws:iam::${c.s.account.id}:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS`,
    events: fresh ? [] : sv.events.map((e) => ({ id: e.id, createdAt: iso(e.ts), message: e.message })), createdAt: iso(sv.createdAt), placementConstraints: [], placementStrategy: [], networkConfiguration: netShape(sv),
    healthCheckGracePeriodSeconds: sv.healthCheckGracePeriodSeconds, schedulingStrategy: 'REPLICA', createdBy: `arn:aws:iam::${c.s.account.id}:user/${'admin'}`, enableECSManagedTags: false, propagateTags: 'NONE', enableExecuteCommand: false, tags: tagsOut(sv.tags),
  };
};
const taskShape = (c: { s: any }, t: EcsTask) => {
  const cl = cs(c.s).ecsClusters.find((x) => x.name === t.clusterName && x.region === t.region);
  return {
    attachments: [{ id: t.eniId.replace('eni-', '').padEnd(36, '0').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5'), type: 'ElasticNetworkInterface', status: t.lastStatus === 'STOPPED' ? 'DELETED' : 'ATTACHED', details: [{ name: 'subnetId', value: t.subnetId }, { name: 'networkInterfaceId', value: t.eniId }, { name: 'macAddress', value: '02:' + t.id.slice(0, 10).replace(/(..)/g, '$1:').slice(0, 14) }, { name: 'privateDnsName', value: `ip-${t.privateIp.replace(/\./g, '-')}.${t.region}.compute.internal` }, { name: 'privateIPv4Address', value: t.privateIp }] }],
    attributes: [{ name: 'ecs.cpu-architecture', value: 'x86_64' }], availabilityZone: t.az, clusterArn: cl?.arn,
    containers: t.containers.map((ct) => ({ containerArn: `arn:aws:ecs:${t.region}:${c.s.account.id}:container/${t.clusterName}/${t.id}/${ct.runtimeId.slice(-8)}`, taskArn: t.arn, name: ct.name, image: ct.image, ...(ct.imageDigest ? { imageDigest: ct.imageDigest } : {}), runtimeId: ct.runtimeId, lastStatus: ct.lastStatus, ...(ct.exitCode !== undefined ? { exitCode: ct.exitCode } : {}), ...(ct.reason ? { reason: ct.reason } : {}), networkBindings: [], networkInterfaces: [{ attachmentId: t.eniId, privateIpv4Address: t.privateIp }], healthStatus: 'UNKNOWN', cpu: '0' })),
    cpu: t.cpu, createdAt: iso(t.createdAt), desiredStatus: t.desiredStatus, enableExecuteCommand: false, group: t.group, healthStatus: 'UNKNOWN', lastStatus: t.lastStatus, launchType: t.launchType, memory: t.memory,
    overrides: { containerOverrides: t.containers.map((x) => ({ name: x.name })), inferenceAcceleratorOverrides: [] }, platformVersion: '1.4.0', platformFamily: 'Linux', ...(t.startedAt ? { startedAt: iso(t.startedAt) } : {}), ...(t.startedBy ? { startedBy: t.startedBy } : {}),
    ...(t.stoppedAt ? { stoppedAt: iso(t.stoppedAt) } : {}), ...(t.stoppingAt ? { stoppingAt: iso(t.stoppingAt) } : {}), ...(t.stoppedReason ? { stoppedReason: t.stoppedReason } : {}), ...(t.stopCode ? { stopCode: t.stopCode } : {}),
    taskArn: t.arn, taskDefinitionArn: t.taskDefinition, version: t.lastStatus === 'RUNNING' ? 3 : t.lastStatus === 'STOPPED' ? 5 : 1, ephemeralStorage: { sizeInGiB: 20 }, fargateEphemeralStorage: { sizeInGiB: 20 },
  };
};

// ------------------------------------------------------------------ clústeres

defineCommand({ service: 'ecs', name: 'create-cluster', op: 'CreateCluster', list: ['tags', 'settings'], structured: ['tags', 'settings'], run: (c, p) => ({ cluster: clusterShape(c, ecs.createCluster(c, { ClusterName: p.ClusterName, Tags: p.Tags, Settings: p.Settings })) }) });
defineCommand({ service: 'ecs', name: 'list-clusters', op: 'ListClusters', run: (c) => ({ clusterArns: ecs.listClusters(c).map((x) => x.arn) }) });
defineCommand({ service: 'ecs', name: 'describe-clusters', op: 'DescribeClusters', list: ['clusters'], run: (c, p) => { const r = ecs.describeClusters(c, { Clusters: p.Clusters }); return { clusters: r.clusters.map((x) => clusterShape(c, x)), failures: r.failures }; } });
defineCommand({ service: 'ecs', name: 'delete-cluster', op: 'DeleteCluster', run: (c, p) => ({ cluster: { ...clusterShape(c, ecs.deleteCluster(c, { Cluster: need(p, 'Cluster', 'cluster') })), status: 'INACTIVE' } }) });

// ------------------------------------------------------------------ definiciones de tarea

defineCommand({
  service: 'ecs', name: 'register-task-definition', op: 'RegisterTaskDefinition', list: ['requires-compatibilities', 'tags'], structured: ['container-definitions', 'tags'],
  run: (c, p) => ({ taskDefinition: tdShape(c, ecs.registerTaskDefinition(c, { Family: need(p, 'Family', 'family'), ContainerDefinitions: arr(need(p, 'ContainerDefinitions', 'container-definitions')).flat(), Cpu: p.Cpu, Memory: p.Memory, NetworkMode: p.NetworkMode, RequiresCompatibilities: p.RequiresCompatibilities, ExecutionRoleArn: p.ExecutionRoleArn, TaskRoleArn: p.TaskRoleArn, Tags: p.Tags })) }),
});
defineCommand({ service: 'ecs', name: 'describe-task-definition', op: 'DescribeTaskDefinition', run: (c, p) => { const t = ecs.describeTaskDefinition(c, { TaskDefinition: need(p, 'TaskDefinition', 'task-definition') }); return { taskDefinition: tdShape(c, t), tags: tagsOut(t.tags) }; } });
defineCommand({ service: 'ecs', name: 'list-task-definitions', op: 'ListTaskDefinitions', run: (c, p) => ({ taskDefinitionArns: ecs.listTaskDefinitions(c, { FamilyPrefix: p.FamilyPrefix, Status: p.Status }).map((t) => t.arn) }) });
defineCommand({ service: 'ecs', name: 'deregister-task-definition', op: 'DeregisterTaskDefinition', run: (c, p) => ({ taskDefinition: tdShape(c, ecs.deregisterTaskDefinition(c, { TaskDefinition: need(p, 'TaskDefinition', 'task-definition') })) }) });

// ------------------------------------------------------------------ servicios

defineCommand({
  service: 'ecs', name: 'create-service', op: 'CreateService', list: ['load-balancers', 'tags'], structured: ['network-configuration', 'load-balancers', 'tags'],
  run: (c, p) => ({ service: svcShape(c, ecs.createService(c, { Cluster: p.Cluster, ServiceName: need(p, 'ServiceName', 'service-name'), TaskDefinition: need(p, 'TaskDefinition', 'task-definition'), DesiredCount: n(p.DesiredCount), LaunchType: p.LaunchType, NetworkConfiguration: p.NetworkConfiguration, LoadBalancers: p.LoadBalancers, HealthCheckGracePeriodSeconds: n(p.HealthCheckGracePeriodSeconds), Tags: p.Tags }), true) }),
});
defineCommand({ service: 'ecs', name: 'describe-services', op: 'DescribeServices', list: ['services'], run: (c, p) => { const r = ecs.describeServices(c, { Cluster: p.Cluster, Services: need(p, 'Services', 'services') }); return { services: r.services.map((x) => svcShape(c, x)), failures: r.failures }; } });
defineCommand({ service: 'ecs', name: 'list-services', op: 'ListServices', run: (c, p) => ({ serviceArns: ecs.listServices(c, { Cluster: p.Cluster }).map((x) => x.arn) }) });
defineCommand({
  service: 'ecs', name: 'update-service', op: 'UpdateService', bool: ['force-new-deployment', 'no-force-new-deployment'],
  run: (c, p) => ({ service: svcShape(c, ecs.updateService(c, { Cluster: p.Cluster, Service: need(p, 'Service', 'service'), DesiredCount: n(p.DesiredCount), TaskDefinition: p.TaskDefinition, ForceNewDeployment: p.ForceNewDeployment === true, HealthCheckGracePeriodSeconds: n(p.HealthCheckGracePeriodSeconds) })) }),
});
defineCommand({ service: 'ecs', name: 'delete-service', op: 'DeleteService', bool: ['force'], run: (c, p) => ({ service: svcShape(c, ecs.deleteService(c, { Cluster: p.Cluster, Service: need(p, 'Service', 'service'), Force: p.Force === true })) }) });

// ------------------------------------------------------------------ tareas

defineCommand({
  service: 'ecs', name: 'run-task', op: 'RunTask', structured: ['network-configuration', 'overrides'],
  run: (c, p) => { const r = ecs.runTask(c, { Cluster: p.Cluster, TaskDefinition: need(p, 'TaskDefinition', 'task-definition'), Count: n(p.Count), LaunchType: p.LaunchType, NetworkConfiguration: p.NetworkConfiguration, Overrides: p.Overrides, StartedBy: p.StartedBy, Group: p.Group }); return { tasks: r.tasks.map((t) => taskShape(c, t)), failures: r.failures }; },
});
defineCommand({ service: 'ecs', name: 'list-tasks', op: 'ListTasks', run: (c, p) => ({ taskArns: ecs.listTasks(c, { Cluster: p.Cluster, ServiceName: p.ServiceName, DesiredStatus: p.DesiredStatus, Family: p.Family, StartedBy: p.StartedBy }).map((t) => t.arn) }) });
defineCommand({ service: 'ecs', name: 'describe-tasks', op: 'DescribeTasks', list: ['tasks'], run: (c, p) => { const r = ecs.describeTasks(c, { Cluster: p.Cluster, Tasks: need(p, 'Tasks', 'tasks') }); return { tasks: r.tasks.map((t) => taskShape(c, t)), failures: r.failures }; } });
defineCommand({ service: 'ecs', name: 'stop-task', op: 'StopTask', run: (c, p) => ({ task: taskShape(c, ecs.stopTask(c, { Cluster: p.Cluster, Task: need(p, 'Task', 'task'), Reason: p.Reason })) }) });
defineCommand({ service: 'ecs', name: 'tag-resource', op: 'TagResource', list: ['tags'], structured: ['tags'], run: (c, p) => { const r = need(p, 'ResourceArn', 'resource-arn') as string; const cl = cs(c.s).ecsClusters.find((x) => x.arn === r); if (cl) Object.assign(cl.tags, Object.fromEntries(arr(p.Tags).map((t: any) => [t.key, t.value]))); return {}; } });

// ------------------------------------------------------------------ wait

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(c: { s: any }, what: string, ok: () => boolean, hardFail?: () => string | undefined): Promise<void> {
  const limit = Date.now() + (speedFactor() === 0 ? 0 : 150_000);
  for (;;) {
    settle(c.s);
    ecs.settleEcs(c.s);
    const bad = hardFail?.();
    if (bad) throw new Error(`\nWaiter ${what} failed: ${bad}`);
    if (ok()) return;
    if (Date.now() >= limit) throw new Error(`\nWaiter ${what} failed: Max attempts exceeded`);
    await sleep(500);
  }
}
defineCommand({
  service: 'ecs', name: 'wait', op: 'Wait', list: ['services', 'tasks'],
  run: async (c, p, _sh, pos) => {
    const w = pos[0];
    const cl = p.Cluster;
    if (w === 'services-stable') {
      const names: string[] = need(p, 'Services', 'services');
      await waitFor(c, 'ServicesStable', () => names.every((x) => { const sv = cs(c.s).ecsServices.find((y) => y.name === x && y.clusterName === (cl ?? 'default')); return !!sv && sv.deployments.length === 1 && sv.deployments[0].rolloutState === 'COMPLETED' && ecs.serviceCounts(c.s, sv).running === sv.desiredCount; }), () => (names.some((x) => !cs(c.s).ecsServices.some((y) => y.name === x && y.clusterName === (cl ?? 'default'))) ? 'Service not found' : undefined));
    } else if (w === 'services-inactive') {
      await waitFor(c, 'ServicesInactive', () => !(need(p, 'Services', 'services') as string[]).some((x) => cs(c.s).ecsServices.some((y) => y.name === x && y.clusterName === (cl ?? 'default'))));
    } else if (w === 'tasks-running') {
      const ids: string[] = need(p, 'Tasks', 'tasks');
      await waitFor(c, 'TasksRunning', () => ids.every((i) => cs(c.s).ecsTasks.find((t) => t.id === i.split('/').pop())?.lastStatus === 'RUNNING'), () => (ids.some((i) => cs(c.s).ecsTasks.find((t) => t.id === i.split('/').pop())?.lastStatus === 'STOPPED') ? 'Matched expected service error state STOPPED' : undefined));
    } else if (w === 'tasks-stopped') {
      const ids: string[] = need(p, 'Tasks', 'tasks');
      await waitFor(c, 'TasksStopped', () => ids.every((i) => cs(c.s).ecsTasks.find((t) => t.id === i.split('/').pop())?.lastStatus === 'STOPPED'));
    } else throw new Error(`\nusage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\naws: error: argument operation: Invalid choice, valid choices are:\n\nservices-inactive | services-stable | tasks-running | tasks-stopped`);
    return undefined;
  },
});
void now;

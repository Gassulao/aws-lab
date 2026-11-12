// AWS CodeDeploy (plataforma Server, despliegues in-place): aplicaciones, grupos de despliegue y despliegues simulados
// con los eventos del ciclo de vida del agente (ApplicationStop ... ValidateService) y los hooks del appspec.yml.
import yaml from 'js-yaml';
import type { CloudState, Instance } from '../types';
import { AwsError } from '../errors';
import { trailed, authorize, type Ctx } from '../api';
import { guid, now } from '../util';
import { cicd, type CdApp, type CdDeployment, type CdGroup, type CdLifecycle, type CdTarget } from './cicdTypes';
import { asArr, roleByArn, roleDenial, scaled, trustsService, unpackBundle, upper } from './cicdCommon';
import { groupInstances } from './autoscaling';
import { runShellScript } from './codebuild';

const SRC = 'codedeploy.amazonaws.com';
const REAL_MS_PER_SIM_S = 40;
export const CONFIGS: Record<string, { min: string; type: string; value: number }> = {
  'CodeDeployDefault.AllAtOnce': { min: 'HOST_COUNT', type: 'HOST_COUNT', value: 0 },
  'CodeDeployDefault.HalfAtATime': { min: 'FLEET_PERCENT', type: 'FLEET_PERCENT', value: 50 },
  'CodeDeployDefault.OneAtATime': { min: 'HOST_COUNT', type: 'HOST_COUNT', value: 1 },
};
const LIFECYCLE = ['ApplicationStop', 'DownloadBundle', 'BeforeInstall', 'Install', 'AfterInstall', 'ApplicationStart', 'ValidateService'];

const appArn = (ctx: Ctx, n: string) => `arn:aws:codedeploy:${ctx.region}:${ctx.s.account.id}:application:${n}`;
const groupArn = (ctx: Ctx, a: string, g: string) => `arn:aws:codedeploy:${ctx.region}:${ctx.s.account.id}:deploymentgroup:${a}/${g}`;
const cfgArn = (ctx: Ctx, n: string) => `arn:aws:codedeploy:${ctx.region}:${ctx.s.account.id}:deploymentconfig:${n}`;
const e = (code: string, msg: string) => new AwsError(code, msg, 400);

export function getApp(ctx: Ctx, name: string): CdApp {
  if (!name) throw e('ApplicationNameRequiredException', 'The minimum number of required application names was not specified.');
  const a = cicd(ctx.s).apps.find((x) => x.name === name && x.region === ctx.region);
  if (!a) throw e('ApplicationDoesNotExistException', `No application found for name: ${name}`);
  return a;
}
export function getGroup(ctx: Ctx, app: string, name: string): CdGroup {
  if (!name) throw e('DeploymentGroupNameRequiredException', 'The minimum number of required deployment group names was not specified.');
  const g = cicd(ctx.s).groups.find((x) => x.appName === app && x.name === name && x.region === ctx.region);
  if (!g) throw e('DeploymentGroupDoesNotExistException', `Deployment group doesn't exist: ${name}`);
  return g;
}

// ------------------------------------------------------------------ aplicaciones y grupos

export function createApplication(ctx: Ctx, p: { ApplicationName: string; ComputePlatform?: string; Tags?: { Key: string; Value: string }[] }): CdApp {
  return trailed(ctx, SRC, 'CreateApplication', [{ type: 'AWS::CodeDeploy::Application', name: p.ApplicationName }], { applicationName: p.ApplicationName, computePlatform: p.ComputePlatform }, () => {
    authorize(ctx, 'codedeploy:CreateApplication', appArn(ctx, p.ApplicationName ?? '*'));
    if (!/^[\w.-]{1,100}$/.test(p.ApplicationName ?? '')) throw e('InvalidApplicationNameException', 'The application name was specified in an invalid format.');
    if (p.ComputePlatform && p.ComputePlatform !== 'Server') throw e('InvalidComputePlatformException', `The computePlatform ${p.ComputePlatform} is not supported by the simulator; use Server.`);
    if (cicd(ctx.s).apps.some((a) => a.name === p.ApplicationName && a.region === ctx.region)) throw e('ApplicationAlreadyExistsException', 'An application with the specified name with the IAM user or AWS account already exists.');
    const a: CdApp = { id: guid(), name: p.ApplicationName, region: ctx.region, created: now(), computePlatform: 'Server', tags: Object.fromEntries((p.Tags ?? []).map((t) => [t.Key, t.Value])) };
    cicd(ctx.s).apps.push(a);
    return a;
  });
}

export function getApplication(ctx: Ctx, p: { ApplicationName: string }): CdApp {
  return trailed(ctx, SRC, 'GetApplication', [{ type: 'AWS::CodeDeploy::Application', name: p.ApplicationName }], { applicationName: p.ApplicationName }, () => {
    authorize(ctx, 'codedeploy:GetApplication', appArn(ctx, p.ApplicationName));
    return getApp(ctx, p.ApplicationName);
  });
}

export function listApplications(ctx: Ctx): string[] {
  return trailed(ctx, SRC, 'ListApplications', [], {}, () => {
    authorize(ctx, 'codedeploy:ListApplications', '*');
    return cicd(ctx.s).apps.filter((a) => a.region === ctx.region).map((a) => a.name).sort();
  });
}

export function deleteApplication(ctx: Ctx, p: { ApplicationName: string }): void {
  return trailed(ctx, SRC, 'DeleteApplication', [{ type: 'AWS::CodeDeploy::Application', name: p.ApplicationName }], { applicationName: p.ApplicationName }, () => {
    authorize(ctx, 'codedeploy:DeleteApplication', appArn(ctx, p.ApplicationName));
    const c = cicd(ctx.s);
    c.apps = c.apps.filter((a) => !(a.name === p.ApplicationName && a.region === ctx.region));
    c.groups = c.groups.filter((g) => !(g.appName === p.ApplicationName && g.region === ctx.region));
  });
}

function checkServiceRole(ctx: Ctx, arn: string): void {
  const role = roleByArn(ctx.s, arn ?? '');
  if (!arn) throw e('RoleRequiredException', 'The role ID was not specified.');
  if (!role || !trustsService(role, 'codedeploy.amazonaws.com')) throw e('InvalidRoleException', `AWS CodeDeploy does not have the permissions required to assume the role ${arn}.`);
}

export function createDeploymentGroup(ctx: Ctx, p: { ApplicationName: string; DeploymentGroupName: string; ServiceRoleArn: string; DeploymentConfigName?: string; Ec2TagFilters?: CdGroup['ec2TagFilters']; AutoScalingGroups?: string[]; AutoRollbackConfiguration?: { enabled?: boolean } }): CdGroup {
  return trailed(ctx, SRC, 'CreateDeploymentGroup', [{ type: 'AWS::CodeDeploy::DeploymentGroup', name: p.DeploymentGroupName }], { applicationName: p.ApplicationName, deploymentGroupName: p.DeploymentGroupName, serviceRoleArn: p.ServiceRoleArn }, () => {
    authorize(ctx, 'codedeploy:CreateDeploymentGroup', groupArn(ctx, p.ApplicationName ?? '*', p.DeploymentGroupName ?? '*'));
    getApp(ctx, p.ApplicationName);
    if (!/^[\w.-]{1,100}$/.test(p.DeploymentGroupName ?? '')) throw e('InvalidDeploymentGroupNameException', 'The deployment group name was specified in an invalid format.');
    if (cicd(ctx.s).groups.some((g) => g.appName === p.ApplicationName && g.name === p.DeploymentGroupName && g.region === ctx.region)) throw e('DeploymentGroupAlreadyExistsException', 'A deployment group with the specified name with the IAM user or AWS account already exists.');
    checkServiceRole(ctx, p.ServiceRoleArn);
    const cfg = p.DeploymentConfigName ?? 'CodeDeployDefault.OneAtATime';
    if (!CONFIGS[cfg]) throw e('DeploymentConfigDoesNotExistException', `The deployment configuration does not exist with the IAM user or AWS account: ${cfg}`);
    for (const f of p.Ec2TagFilters ?? []) if (!f.Key && !f.Value) throw e('InvalidEC2TagException', 'The tag was specified in an invalid format.');
    const g: CdGroup = { id: guid(), appName: p.ApplicationName, name: p.DeploymentGroupName, region: ctx.region, configName: cfg, ec2TagFilters: (p.Ec2TagFilters ?? []).map((f) => ({ Key: f.Key, Value: f.Value, Type: f.Type ?? (f.Key && f.Value ? 'KEY_AND_VALUE' : f.Key ? 'KEY_ONLY' : 'VALUE_ONLY') })), autoScalingGroups: p.AutoScalingGroups ?? [], serviceRoleArn: p.ServiceRoleArn, created: now(), autoRollback: String(p.AutoRollbackConfiguration?.enabled) === 'true' };
    cicd(ctx.s).groups.push(g);
    return g;
  });
}

export function getDeploymentGroup(ctx: Ctx, p: { ApplicationName: string; DeploymentGroupName: string }): CdGroup {
  return trailed(ctx, SRC, 'GetDeploymentGroup', [{ type: 'AWS::CodeDeploy::DeploymentGroup', name: p.DeploymentGroupName }], { applicationName: p.ApplicationName, deploymentGroupName: p.DeploymentGroupName }, () => {
    authorize(ctx, 'codedeploy:GetDeploymentGroup', groupArn(ctx, p.ApplicationName, p.DeploymentGroupName));
    getApp(ctx, p.ApplicationName);
    return getGroup(ctx, p.ApplicationName, p.DeploymentGroupName);
  });
}

export function listDeploymentGroups(ctx: Ctx, p: { ApplicationName: string }): string[] {
  return trailed(ctx, SRC, 'ListDeploymentGroups', [], { applicationName: p.ApplicationName }, () => {
    authorize(ctx, 'codedeploy:ListDeploymentGroups', appArn(ctx, p.ApplicationName));
    getApp(ctx, p.ApplicationName);
    return cicd(ctx.s).groups.filter((g) => g.appName === p.ApplicationName && g.region === ctx.region).map((g) => g.name).sort();
  });
}

export function updateDeploymentGroup(ctx: Ctx, p: { ApplicationName: string; CurrentDeploymentGroupName: string; NewDeploymentGroupName?: string; ServiceRoleArn?: string; DeploymentConfigName?: string; Ec2TagFilters?: CdGroup['ec2TagFilters']; AutoScalingGroups?: string[] }): void {
  return trailed(ctx, SRC, 'UpdateDeploymentGroup', [], { applicationName: p.ApplicationName, currentDeploymentGroupName: p.CurrentDeploymentGroupName }, () => {
    authorize(ctx, 'codedeploy:UpdateDeploymentGroup', groupArn(ctx, p.ApplicationName, p.CurrentDeploymentGroupName));
    getApp(ctx, p.ApplicationName);
    const g = getGroup(ctx, p.ApplicationName, p.CurrentDeploymentGroupName);
    if (p.ServiceRoleArn) { checkServiceRole(ctx, p.ServiceRoleArn); g.serviceRoleArn = p.ServiceRoleArn; }
    if (p.DeploymentConfigName) { if (!CONFIGS[p.DeploymentConfigName]) throw e('DeploymentConfigDoesNotExistException', `The deployment configuration does not exist with the IAM user or AWS account: ${p.DeploymentConfigName}`); g.configName = p.DeploymentConfigName; }
    if (p.Ec2TagFilters) g.ec2TagFilters = p.Ec2TagFilters.map((f) => ({ ...f, Type: f.Type ?? (f.Key && f.Value ? 'KEY_AND_VALUE' : f.Key ? 'KEY_ONLY' : 'VALUE_ONLY') }));
    if (p.AutoScalingGroups) g.autoScalingGroups = p.AutoScalingGroups;
    if (p.NewDeploymentGroupName) g.name = p.NewDeploymentGroupName;
  });
}

export function deleteDeploymentGroup(ctx: Ctx, p: { ApplicationName: string; DeploymentGroupName: string }): void {
  return trailed(ctx, SRC, 'DeleteDeploymentGroup', [], { applicationName: p.ApplicationName, deploymentGroupName: p.DeploymentGroupName }, () => {
    authorize(ctx, 'codedeploy:DeleteDeploymentGroup', groupArn(ctx, p.ApplicationName, p.DeploymentGroupName));
    getApp(ctx, p.ApplicationName);
    const c = cicd(ctx.s);
    c.groups = c.groups.filter((g) => !(g.appName === p.ApplicationName && g.name === p.DeploymentGroupName && g.region === ctx.region));
  });
}

export function getDeploymentConfig(ctx: Ctx, p: { DeploymentConfigName: string }) {
  return trailed(ctx, SRC, 'GetDeploymentConfig', [], { deploymentConfigName: p.DeploymentConfigName }, () => {
    authorize(ctx, 'codedeploy:GetDeploymentConfig', cfgArn(ctx, p.DeploymentConfigName));
    const c = CONFIGS[p.DeploymentConfigName];
    if (!c) throw e('DeploymentConfigDoesNotExistException', `The deployment configuration does not exist with the IAM user or AWS account: ${p.DeploymentConfigName}`);
    return { name: p.DeploymentConfigName, ...c };
  });
}

export function listDeploymentConfigs(ctx: Ctx): string[] {
  return trailed(ctx, SRC, 'ListDeploymentConfigs', [], {}, () => {
    authorize(ctx, 'codedeploy:ListDeploymentConfigs', '*');
    return Object.keys(CONFIGS);
  });
}

// ------------------------------------------------------------------ despliegues

/** Instancias que recibirían el despliegue ahora mismo (en ejecución y que coinciden con las etiquetas o el ASG). */
export function targetInstances(s: CloudState, g: CdGroup): Instance[] {
  const byTag = s.instances.filter((i) => i.region === g.region && i.state === 'running' && g.ec2TagFilters.some((f) => {
    const hasKey = f.Key !== undefined && f.Key !== '' && f.Key in i.tags;
    if (f.Type === 'KEY_ONLY') return hasKey;
    if (f.Type === 'VALUE_ONLY') return Object.values(i.tags).includes(f.Value ?? '');
    return hasKey && i.tags[f.Key!] === (f.Value ?? '');
  }));
  const asg = s.asgs.filter((a) => g.autoScalingGroups.includes(a.name) && a.region === g.region).flatMap((a) => groupInstances(s, a)).filter((i) => i.state === 'running');
  const all = [...byTag, ...asg];
  return all.filter((i, k) => all.findIndex((x) => x.id === i.id) === k).sort((a, b) => a.id.localeCompare(b.id));
}

function instanceRole(s: CloudState, i: Instance) {
  const ip = s.instanceProfiles.find((x) => x.name === i.iamInstanceProfile);
  return ip?.roles[0] ? s.roles.find((r) => r.name === ip.roles[0]) : undefined;
}

const ROOT = (gid: string, did: string) => `/opt/codedeploy-agent/deployment-root/${gid}/${did}/deployment-archive`;

function simulateTarget(s: CloudState, g: CdGroup, d: { id: string; t0: number; revision: CdDeployment['revision'] }, inst: Instance, firstDeploy: boolean): CdTarget {
  let off = 0;
  const lifecycle: CdLifecycle[] = [];
  const t = (o: number) => d.t0 + scaled(o * REAL_MS_PER_SIM_S);
  let failed = false;
  const bundleObj = s.buckets.find((b) => b.name === d.revision.s3Location.bucket)?.objects[d.revision.s3Location.key];
  const files = bundleObj ? unpackBundle(bundleObj.body) : null;
  let appspec: any = null;
  const role = instanceRole(s, inst);
  const ev = (name: string, run: () => { status: CdLifecycle['status']; diag?: CdLifecycle['diagnostics'] } | null, secs = 2) => {
    if (failed) { lifecycle.push({ name, status: 'Skipped' }); return; }
    const r = run();
    lifecycle.push({ name, status: r?.status ?? 'Succeeded', start: t(off), end: t(off + secs), diagnostics: r?.diag });
    off += secs;
    if (r?.status === 'Failed') failed = true;
  };
  const hook = (name: string) => () => {
    const hooks = asArr<any>(appspec?.hooks?.[name]);
    for (const h of hooks) {
      const loc: string = h.location;
      if (!files || files[loc] === undefined) return { status: 'Failed' as const, diag: { errorCode: 'ScriptMissing', scriptName: loc, message: `Script does not exist at specified location: ${ROOT(g.id, d.id)}/${loc}`, logTail: '' } };
      const res = runShellScript(s, files, loc, {});
      if (res.code !== 0) return { status: 'Failed' as const, diag: { errorCode: 'ScriptFailed', scriptName: loc, message: `Script at specified location: ${loc} failed with exit code ${res.code}`, logTail: `LifecycleEvent - ${name}\nScript - ${loc}\n${res.out}`.trim() } };
    }
    return { status: 'Succeeded' as const };
  };
  ev('ApplicationStop', () => (firstDeploy ? { status: 'Skipped' } : hook('ApplicationStop')()), 1);
  ev('DownloadBundle', () => {
    if (!bundleObj) return { status: 'Failed', diag: { errorCode: 'UnknownError', scriptName: '', message: `The specified key does not exist. (Service: AmazonS3; Status Code: 404; Error Code: NoSuchKey)`, logTail: '' } };
    const denial = role ? roleDenial(s, role, 'CodeDeployAgent', 's3:GetObject', `arn:aws:s3:::${d.revision.s3Location.bucket}/${d.revision.s3Location.key}`) : 'no role';
    if (denial) return { status: 'Failed', diag: { errorCode: 'UnknownError', scriptName: '', message: 'Access Denied (Service: Amazon S3; Status Code: 403; Error Code: AccessDenied)' + (role ? '' : ': the instance has no IAM instance profile'), logTail: '' } };
    if (!files) return { status: 'Failed', diag: { errorCode: 'UnknownError', scriptName: '', message: 'The revision bundle could not be unpacked: it is not a valid zip archive.', logTail: '' } };
    const raw = files['appspec.yml'] ?? files['appspec.yaml'];
    if (raw === undefined) return { status: 'Failed', diag: { errorCode: 'UnknownError', scriptName: '', message: `The CodeDeploy agent did not find an AppSpec file within the unpacked revision directory at revision-relative path "appspec.yml". The revision was unpacked to directory "${ROOT(g.id, d.id)}" on the instance.`, logTail: '' } };
    try { appspec = yaml.load(raw); } catch { return { status: 'Failed', diag: { errorCode: 'UnknownError', scriptName: '', message: 'The AppSpec file could not be parsed: invalid YAML.', logTail: '' } }; }
    if (!appspec || appspec.version === undefined || (appspec.os && appspec.os !== 'linux')) return { status: 'Failed', diag: { errorCode: 'UnknownError', scriptName: '', message: 'The AppSpec file is not valid: it must declare "version: 0.0" and "os: linux".', logTail: '' } };
    return { status: 'Succeeded' };
  }, 3);
  ev('BeforeInstall', hook('BeforeInstall'));
  ev('Install', () => {
    for (const f of asArr<any>(appspec?.files)) if (files && f.source !== '/' && !Object.keys(files).some((k) => k === f.source.replace(/^\//, '') || k.startsWith(f.source.replace(/^\/|\/$/g, '') + '/'))) return { status: 'Failed', diag: { errorCode: 'UnknownError', scriptName: '', message: `The source "${f.source}" listed in the AppSpec "files" section does not exist in the revision.`, logTail: '' } };
    return { status: 'Succeeded' };
  });
  ev('AfterInstall', hook('AfterInstall'));
  ev('ApplicationStart', hook('ApplicationStart'));
  ev('ValidateService', hook('ValidateService'));
  return { instanceId: inst.id, status: failed ? 'Failed' : 'Succeeded', lifecycle, lastUpdated: t(off) };
}

export function createDeploymentInternal(s: CloudState, g: CdGroup, o: { revision: CdDeployment['revision']; description?: string; configName?: string; creator: string; region: string; pipelineExecutionId?: string }): CdDeployment {
  const c = cicd(s);
  const id = 'd-' + upper(9);
  const t0 = now();
  const insts = targetInstances(s, g);
  const firstDeploy = !g.lastSuccessfulDeployment;
  const cfgName = o.configName ?? g.configName;
  let targets: CdTarget[] = [];
  let error: CdDeployment['error'];
  let status: CdDeployment['finalStatus'] = 'Succeeded';
  let sim = 4;
  if (!insts.length) {
    status = 'Failed';
    error = { code: 'NO_INSTANCES', message: 'The deployment failed because no instances were found in your deployment group. Check your deployment group settings to make sure the tags or Auto Scaling groups correctly identify the instances you want to deploy to, and then try again.' };
  } else {
    const d0 = { id, t0, revision: o.revision };
    const batch = cfgName.endsWith('OneAtATime') ? 1 : cfgName.endsWith('HalfAtATime') ? Math.max(1, Math.ceil(insts.length / 2)) : insts.length;
    let stop = false;
    for (let i = 0; i < insts.length; i += batch) {
      const group = insts.slice(i, i + batch);
      if (stop) { targets.push(...group.map((x) => ({ instanceId: x.id, status: 'Skipped' as const, lifecycle: [], lastUpdated: t0 }))); continue; }
      const res = group.map((x) => simulateTarget(s, g, { ...d0, t0: t0 + scaled(sim * REAL_MS_PER_SIM_S) }, x, firstDeploy));
      targets.push(...res);
      sim += 14;
      if (res.some((r) => r.status === 'Failed') && cfgName !== 'CodeDeployDefault.AllAtOnce') stop = true;
    }
    const ok = targets.filter((t2) => t2.status === 'Succeeded').length;
    const need = cfgName.endsWith('AllAtOnce') ? 1 : cfgName.endsWith('HalfAtATime') ? Math.ceil(insts.length / 2) : insts.length;
    if (ok < need) {
      status = 'Failed';
      error = { code: 'HEALTH_CONSTRAINTS', message: 'The overall deployment failed because too many individual instances failed deployment, too few healthy instances are available for deployment, or some instances in your deployment group are experiencing problems.' };
    }
  }
  const d: CdDeployment = { id, appName: g.appName, groupName: g.name, region: o.region, configName: cfgName, description: o.description, creator: o.creator, created: t0, start: t0, completeAt: t0 + scaled(sim * REAL_MS_PER_SIM_S), finalStatus: status, status: 'InProgress', revision: o.revision, error, targets, pipelineExecutionId: o.pipelineExecutionId };
  c.deployments.push(d);
  g.lastAttemptedDeployment = id;
  settleDeployments(s);
  return d;
}

export function settleDeployments(s: CloudState): void {
  const t = now();
  for (const d of cicd(s).deployments) {
    if (d.status !== 'InProgress' && d.status !== 'Created' && d.status !== 'Queued') continue;
    if (t >= d.completeAt) {
      d.status = d.finalStatus;
      d.complete = d.completeAt;
      const g = cicd(s).groups.find((x) => x.appName === d.appName && x.name === d.groupName && x.region === d.region);
      if (g && d.status === 'Succeeded') g.lastSuccessfulDeployment = d.id;
    }
  }
}

/** Estado de un destino ahora (los eventos futuros aparecen como pendientes mientras el despliegue avanza). */
export function overview(d: CdDeployment): { Pending: number; InProgress: number; Succeeded: number; Failed: number; Skipped: number; Ready: number } {
  const o = { Pending: 0, InProgress: 0, Succeeded: 0, Failed: 0, Skipped: 0, Ready: 0 };
  const t = now();
  for (const x of d.targets) {
    const settled: 'Succeeded' | 'Failed' | 'Skipped' = x.status === 'InProgress' || x.status === 'Pending' ? 'Succeeded' : x.status;
    if (d.status !== 'InProgress') { o[x.status === 'InProgress' || x.status === 'Pending' ? 'Pending' : x.status]++; continue; }
    if (x.lastUpdated <= t) o[settled]++;
    else if (x.lifecycle[0]?.start && x.lifecycle[0].start <= t) o.InProgress++;
    else o.Pending++;
  }
  return o;
}

function getDep(ctx: Ctx, id: string): CdDeployment {
  settleDeployments(ctx.s);
  if (!id) throw e('DeploymentIdRequiredException', 'At least one deployment ID must be specified.');
  const d = cicd(ctx.s).deployments.find((x) => x.id === id && x.region === ctx.region);
  if (!d) throw e('DeploymentDoesNotExistException', `The deployment ${id} could not be found.`);
  return d;
}

export function createDeployment(ctx: Ctx, p: { ApplicationName: string; DeploymentGroupName: string; Revision?: any; DeploymentConfigName?: string; Description?: string }): CdDeployment {
  return trailed(ctx, SRC, 'CreateDeployment', [{ type: 'AWS::CodeDeploy::Application', name: p.ApplicationName }], { applicationName: p.ApplicationName, deploymentGroupName: p.DeploymentGroupName, revision: p.Revision, deploymentConfigName: p.DeploymentConfigName, description: p.Description }, () => {
    authorize(ctx, 'codedeploy:CreateDeployment', groupArn(ctx, p.ApplicationName ?? '*', p.DeploymentGroupName ?? '*'));
    getApp(ctx, p.ApplicationName);
    const g = getGroup(ctx, p.ApplicationName, p.DeploymentGroupName);
    const rev = p.Revision;
    if (!rev) throw e('RevisionRequiredException', 'The revision ID was not specified.');
    if (rev.revisionType !== 'S3' || !rev.s3Location?.bucket || !rev.s3Location?.key) throw e('InvalidRevisionException', 'The revision was specified in an invalid format. In this simulator only S3 revisions (revisionType=S3, s3Location={bucket=,key=,bundleType=zip}) are supported.');
    if (p.DeploymentConfigName && !CONFIGS[p.DeploymentConfigName]) throw e('DeploymentConfigDoesNotExistException', `The deployment configuration does not exist with the IAM user or AWS account: ${p.DeploymentConfigName}`);
    if (!s3Exists(ctx.s, rev.s3Location.bucket)) throw e('InvalidRevisionException', `The revision was specified in an invalid format: the S3 bucket ${rev.s3Location.bucket} does not exist.`);
    return createDeploymentInternal(ctx.s, g, { revision: { revisionType: 'S3', s3Location: { bucket: rev.s3Location.bucket, key: rev.s3Location.key, bundleType: rev.s3Location.bundleType ?? 'zip' } }, description: p.Description, configName: p.DeploymentConfigName, creator: 'user', region: ctx.region });
  });
}
const s3Exists = (s: CloudState, b: string) => s.buckets.some((x) => x.name === b);

export function getDeployment(ctx: Ctx, p: { DeploymentId: string }): CdDeployment {
  return trailed(ctx, SRC, 'GetDeployment', [], { deploymentId: p.DeploymentId }, () => {
    const d = getDep(ctx, p.DeploymentId);
    authorize(ctx, 'codedeploy:GetDeployment', groupArn(ctx, d.appName, d.groupName));
    return d;
  });
}

export function listDeployments(ctx: Ctx, p: { ApplicationName?: string; DeploymentGroupName?: string; IncludeOnlyStatuses?: string[] }): string[] {
  return trailed(ctx, SRC, 'ListDeployments', [], p, () => {
    authorize(ctx, 'codedeploy:ListDeployments', p.ApplicationName && p.DeploymentGroupName ? groupArn(ctx, p.ApplicationName, p.DeploymentGroupName) : '*');
    if (p.ApplicationName) getApp(ctx, p.ApplicationName);
    if (p.ApplicationName && p.DeploymentGroupName) getGroup(ctx, p.ApplicationName, p.DeploymentGroupName);
    settleDeployments(ctx.s);
    return cicd(ctx.s).deployments.filter((d) => d.region === ctx.region && (!p.ApplicationName || d.appName === p.ApplicationName) && (!p.DeploymentGroupName || d.groupName === p.DeploymentGroupName) && (!p.IncludeOnlyStatuses?.length || p.IncludeOnlyStatuses.includes(d.status))).sort((a, b) => b.created - a.created).map((d) => d.id);
  });
}

export function stopDeployment(ctx: Ctx, p: { DeploymentId: string }): CdDeployment {
  return trailed(ctx, SRC, 'StopDeployment', [], { deploymentId: p.DeploymentId }, () => {
    const d = getDep(ctx, p.DeploymentId);
    authorize(ctx, 'codedeploy:StopDeployment', groupArn(ctx, d.appName, d.groupName));
    if (d.status === 'Succeeded' || d.status === 'Failed' || d.status === 'Stopped') throw e('DeploymentAlreadyCompletedException', 'The deployment is already complete.');
    d.status = 'Stopped';
    d.complete = now();
    return d;
  });
}

export function getTarget(ctx: Ctx, p: { DeploymentId: string; InstanceId: string }): CdTarget {
  return trailed(ctx, SRC, 'GetDeploymentInstance', [], { deploymentId: p.DeploymentId, instanceId: p.InstanceId }, () => {
    const d = getDep(ctx, p.DeploymentId);
    authorize(ctx, 'codedeploy:GetDeploymentInstance', groupArn(ctx, d.appName, d.groupName));
    const t = d.targets.find((x) => x.instanceId === p.InstanceId);
    if (!t) throw e('InstanceDoesNotExistException', `The instance ${p.InstanceId} does not exist in this deployment.`);
    return t;
  });
}

export function listTargets(ctx: Ctx, p: { DeploymentId: string }): string[] {
  return trailed(ctx, SRC, 'ListDeploymentTargets', [], { deploymentId: p.DeploymentId }, () => {
    const d = getDep(ctx, p.DeploymentId);
    authorize(ctx, 'codedeploy:ListDeploymentTargets', groupArn(ctx, d.appName, d.groupName));
    return d.targets.map((t) => t.instanceId);
  });
}

/** Lectura de la consola (sin evento de CloudTrail). */
export const deploymentsOf = (s: CloudState): CdDeployment[] => (settleDeployments(s), [...cicd(s).deployments].sort((a, b) => b.created - a.created));

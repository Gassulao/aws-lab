// aws codebuild (y el ejecutor de `aws` que usan las compilaciones con su rol de servicio)
import { defineCommand, listCommands, parseArgs, render, type Params } from '../framework';
import * as cb from '../../../engine/services/codebuild';
import { cicdHooks, type CbBuild, type CbProject } from '../../../engine/services/cicdTypes';
import '../../../engine/services/cicd';
import { AwsError, cliErrorText } from '../../../engine/errors';
import { assumedCaller } from '../../../engine/services/cicdCommon';
import { newShell } from '../../interp';
import { VFS } from '../../fs';
import type { VfsNode } from '../../../engine/types';
import { iso, strip, num } from './cicd-util';
import type { Ctx } from '../../../engine/api';

export const projectView = (c: { s: { account: { id: string } } }, p: CbProject) => strip({
  name: p.name, arn: p.arn, description: p.description,
  source: strip({ type: p.source.type, location: p.source.location, gitCloneDepth: p.source.gitCloneDepth, gitSubmodulesConfig: p.source.type === 'CODECOMMIT' ? { fetchSubmodules: false } : undefined, buildspec: p.source.buildspec, insecureSsl: false }),
  sourceVersion: p.sourceVersion,
  artifacts: strip({ ...p.artifacts, overrideArtifactName: false, encryptionDisabled: false }),
  cache: { type: 'NO_CACHE' }, environment: p.environment, serviceRole: p.serviceRole, timeoutInMinutes: p.timeoutInMinutes, queuedTimeoutInMinutes: p.queuedTimeoutInMinutes,
  encryptionKey: `arn:aws:kms:${p.region}:${c.s.account.id}:alias/aws/s3`, tags: Object.entries(p.tags).map(([key, value]) => ({ key, value })),
  created: iso(p.created), lastModified: iso(p.lastModified), badge: { badgeEnabled: false },
  logsConfig: { cloudWatchLogs: strip(p.logsConfig.cloudWatchLogs), s3Logs: { status: p.logsConfig.s3Logs.status, encryptionDisabled: false } }, projectVisibility: 'PRIVATE',
});

export function buildView(c: { s: { account: { id: string } } }, b: CbBuild, justStarted = false) {
  const phases = justStarted ? b.plan.slice(0, 1).map((p) => ({ ...p, phaseStatus: 'SUCCEEDED' })) : cb.visiblePhases(b);
  const done = !justStarted && b.buildStatus !== 'IN_PROGRESS';
  const group = b.logGroup;
  return strip({
    id: b.id, arn: b.arn, buildNumber: b.buildNumber, startTime: iso(b.startTime), endTime: done && b.endTime ? iso(b.endTime) : undefined,
    currentPhase: justStarted ? 'QUEUED' : cb.currentPhase(b), buildStatus: justStarted ? 'IN_PROGRESS' : b.buildStatus, sourceVersion: b.sourceVersion, resolvedSourceVersion: b.resolvedSourceVersion, projectName: b.projectName,
    phases: phases.map((p) => strip({ phaseType: p.phaseType, phaseStatus: p.phaseStatus, startTime: iso(p.startTime), endTime: p.endTime ? iso(p.endTime) : undefined, durationInSeconds: p.durationInSeconds, contexts: p.contexts })),
    source: strip({ type: b.source.type, location: b.source.location, gitCloneDepth: b.source.gitCloneDepth, buildspec: b.source.buildspec, insecureSsl: false }),
    secondarySources: [], secondarySourceVersions: [],
    artifacts: b.artifacts ? { ...b.artifacts, overrideArtifactName: false, encryptionDisabled: false } : undefined,
    cache: { type: 'NO_CACHE' }, environment: b.environment, serviceRole: b.serviceRole,
    logs: group ? { groupName: group, streamName: b.logStream, deepLink: `https://console.aws.amazon.com/cloudwatch/home?region=${b.region}#logEvent:group=${group};stream=${b.logStream}`, cloudWatchLogsArn: `arn:aws:logs:${b.region}:${c.s.account.id}:log-group:${group}:log-stream:${b.logStream}`, cloudWatchLogs: { status: 'ENABLED', groupName: group, streamName: b.logStream }, s3Logs: { status: 'DISABLED', encryptionDisabled: false } } : { cloudWatchLogs: { status: 'DISABLED' }, s3Logs: { status: 'DISABLED', encryptionDisabled: false } },
    timeoutInMinutes: 60, queuedTimeoutInMinutes: 480, buildComplete: done, initiator: b.initiator, encryptionKey: `arn:aws:kms:${b.region}:${c.s.account.id}:alias/aws/s3`, exportedEnvironmentVariables: [], reportArns: [],
  });
}

const projectInput = (p: Params) => ({
  Name: p.Name, Description: p.Description, Source: p.Source, SourceVersion: p.SourceVersion, Artifacts: p.Artifacts, Environment: p.Environment && { ...p.Environment, privilegedMode: p.Environment.privilegedMode }, ServiceRole: p.ServiceRole,
  TimeoutInMinutes: num(p.TimeoutInMinutes), QueuedTimeoutInMinutes: num(p.QueuedTimeoutInMinutes), LogsConfig: p.LogsConfig, Tags: p.Tags,
});
const COMMON = { structured: ['source', 'artifacts', 'environment', 'logs-config', 'tags'], list: ['tags'] };

defineCommand({ service: 'codebuild', name: 'create-project', op: 'CreateProject', structured: ['source', 'artifacts', 'environment', 'logs-config', 'tags'], list: ['tags'], run: (c, p) => ({ project: projectView(c, cb.createProject(c, projectInput(p))) }) });
defineCommand({ service: 'codebuild', name: 'update-project', op: 'UpdateProject', ...COMMON, run: (c, p) => ({ project: projectView(c, cb.updateProject(c, projectInput(p))) }) });
defineCommand({ service: 'codebuild', name: 'delete-project', op: 'DeleteProject', run: (c, p) => void cb.deleteProject(c, { Name: p.Name }) });
defineCommand({ service: 'codebuild', name: 'list-projects', op: 'ListProjects', run: (c) => ({ projects: cb.listProjects(c) }) });
defineCommand({ service: 'codebuild', name: 'batch-get-projects', op: 'BatchGetProjects', list: ['names'], run: (c, p) => { const r = cb.batchGetProjects(c, { Names: p.Names }); return { projects: r.projects.map((x) => projectView(c, x)), projectsNotFound: r.notFound }; } });
defineCommand({
  service: 'codebuild', name: 'start-build', op: 'StartBuild', list: ['environment-variables-override'], structured: ['environment-variables-override'],
  run: (c, p) => { const b = cb.startBuild(c, { ProjectName: p.ProjectName, SourceVersion: p.SourceVersion, EnvironmentVariablesOverride: p.EnvironmentVariablesOverride, BuildspecOverride: p.BuildspecOverride }); return { build: buildView(c, b, true) }; },
});
defineCommand({ service: 'codebuild', name: 'batch-get-builds', op: 'BatchGetBuilds', list: ['ids'], run: (c, p) => { const r = cb.batchGetBuilds(c, { Ids: p.Ids }); return { builds: r.builds.map((b) => buildView(c, b)), buildsNotFound: r.notFound }; } });
defineCommand({ service: 'codebuild', name: 'list-builds', op: 'ListBuilds', run: (c, p) => ({ ids: cb.listBuilds(c, { SortOrder: p.SortOrder }) }) });
defineCommand({ service: 'codebuild', name: 'list-builds-for-project', op: 'ListBuildsForProject', run: (c, p) => ({ ids: cb.listBuilds(c, { ProjectName: p.ProjectName, SortOrder: p.SortOrder }) }) });
defineCommand({ service: 'codebuild', name: 'stop-build', op: 'StopBuild', run: (c, p) => ({ build: buildView(c, cb.stopBuild(c, { Id: p.Id })) }) });

// ---- ejecutor de `aws` dentro de una compilación: mismo CLI, con las credenciales del rol de servicio
const tree = (files: Record<string, string>): VfsNode => {
  const root: VfsNode = { type: 'dir', children: {} };
  const src: VfsNode = { type: 'dir', children: {} };
  root.children!.src = src;
  for (const [p, content] of Object.entries(files)) {
    const parts = p.split('/');
    const name = parts.pop()!;
    let cur = src;
    for (const d of parts) { cur.children![d] ??= { type: 'dir', children: {} }; cur = cur.children![d]; }
    cur.children![name] = { type: 'file', content };
  }
  return root;
};

cicdHooks.runAws = (s, region, roleName, argv, files) => {
  const [service, name, ...rest] = argv;
  const cmd = listCommands(service).find((x) => x.name === name);
  if (!cmd) return { out: '', err: `\naws: [ERROR]: argument command: Invalid choice '${service} ${name ?? ''}'\n`, code: 252 };
  const sh = newShell(s);
  sh.fs = new VFS(tree(files));
  sh.cwd = '/src';
  try {
    const parsed = parseArgs(cmd, rest, sh);
    const role = s.roles.find((r) => r.name === roleName)!;
    const ctx: Ctx = { s, region: parsed.global.region ?? region, caller: assumedCaller(s, role, 'AWSCodeBuild-session') };
    const out = cmd.run(ctx, parsed.params, sh, parsed.positional);
    if (out instanceof Promise) return { out: '', err: 'This command is asynchronous and is not supported inside builds.\n', code: 255 };
    if (out === undefined) return { out: '', err: '', code: 0 };
    if (cmd.raw) return { out: typeof out === 'string' ? out : '', err: '', code: 0 };
    return { out: render(out, parsed.global.output ?? 'json', parsed.global.query), err: '', code: 0 };
  } catch (e) {
    if (e instanceof AwsError) return { out: '', err: `\n${cliErrorText(e, cmd.op)}\n`, code: 254 };
    return { out: '', err: `\n${(e as Error).message}\n`, code: 255 };
  }
};

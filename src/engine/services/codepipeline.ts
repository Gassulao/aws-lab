// AWS CodePipeline: canalizaciones con etapas Source / Build / aprobación manual / Deploy. Cada ejecución avanza con el
// reloj de la simulación: llama a CodeCommit, CodeBuild y CodeDeploy con el rol de servicio de la canalización.
import type { CloudState, IamRole } from '../types';
import { AwsError } from '../errors';
import { trailed, authorize, type Ctx } from '../api';
import { guid, now } from '../util';
import { cicd, cicdHooks, type CpAction, type CpActionExec, type CpExecution, type CpPipeline, type CpStage, type CpStageExec } from './cicdTypes';
import { asArr, packBundle, putBucketObject, roleByArn, roleDenial, trustsService, unpackBundle, upper } from './cicdCommon';
import { createBuild, settleBuilds } from './codebuild';
import { createDeploymentInternal, settleDeployments, getGroup } from './codedeploy';
import { filesOf } from './gitCore';

const SRC = 'codepipeline.amazonaws.com';
export const pipelineArn = (ctx: { s: CloudState; region: string }, n: string) => `arn:aws:codepipeline:${ctx.region}:${ctx.s.account.id}:${n}`;
const actionArn = (ctx: Ctx, p: string, st: string, a: string) => `arn:aws:codepipeline:${ctx.region}:${ctx.s.account.id}:${p}/${st}/${a}`;
const e = (code: string, msg: string) => new AwsError(code, msg, 400);

const SUPPORTED: Record<string, string[]> = {
  'Source/AWS/CodeCommit': ['RepositoryName', 'BranchName'],
  'Source/AWS/S3': ['S3Bucket', 'S3ObjectKey'],
  'Build/AWS/CodeBuild': ['ProjectName'],
  'Test/AWS/CodeBuild': ['ProjectName'],
  'Approval/AWS/Manual': [],
  'Deploy/AWS/CodeDeploy': ['ApplicationName', 'DeploymentGroupName'],
  'Deploy/AWS/S3': ['BucketName', 'Extract'],
};
const typeKey = (a: CpAction) => `${a.actionTypeId?.category}/${a.actionTypeId?.owner}/${a.actionTypeId?.provider}`;

// ------------------------------------------------------------------ validación de la declaración

function validate(ctx: Ctx, d: any): CpPipeline {
  const bad = (m: string, code = 'InvalidStructureException') => e(code, m);
  if (!/^[A-Za-z0-9.@\-_]{1,100}$/.test(d?.name ?? '')) throw e('ValidationException', `1 validation error detected: Value '${d?.name ?? ''}' at 'pipeline.name' failed to satisfy constraint: Member must satisfy regular expression pattern: [A-Za-z0-9.@\\-_]+`);
  const role = roleByArn(ctx.s, d.roleArn ?? '');
  if (!role || !trustsService(role, 'codepipeline.amazonaws.com')) throw bad(`CodePipeline is not authorized to perform AssumeRole on role ${d.roleArn}`);
  const store = d.artifactStore;
  if (!store?.location) throw bad('Pipeline must have an artifact store (artifactStore) with an S3 bucket location.');
  if (!ctx.s.buckets.some((b) => b.name === store.location)) throw bad(`The S3 bucket '${store.location}' specified for the artifact store does not exist.`);
  const stages: CpStage[] = d.stages ?? [];
  if (stages.length < 2) throw bad(`Pipeline has only ${stages.length} stage(s). There should be a minimum of 2 stages in a pipeline`);
  const names = new Set<string>();
  const outputs = new Set<string>();
  stages.forEach((st, si) => {
    if (!st.name || names.has(st.name)) throw bad(`Stage name '${st.name}' is not unique or is empty.`, 'InvalidStageDeclarationException');
    names.add(st.name);
    if (!st.actions?.length) throw bad(`Stage '${st.name}' must contain at least one action.`, 'InvalidStageDeclarationException');
    const an = new Set<string>();
    const stageOut = new Set<string>();
    for (const a of st.actions) {
      if (!a.name || an.has(a.name)) throw bad(`Action name '${a.name}' is not unique within stage '${st.name}'.`, 'InvalidActionDeclarationException');
      an.add(a.name);
      const key = typeKey(a);
      const req = SUPPORTED[key];
      if (!req) throw e('ActionTypeNotFoundException', `Could not find action type: category ${a.actionTypeId?.category}, owner ${a.actionTypeId?.owner}, provider ${a.actionTypeId?.provider}, version ${a.actionTypeId?.version}. The simulator supports: ${Object.keys(SUPPORTED).join(', ')}.`);
      if ((a.actionTypeId.category === 'Source') !== (si === 0)) throw bad(si === 0 ? `Stage '${st.name}' is the first stage and can only contain Source actions.` : `Source actions are only allowed in the first stage, but stage '${st.name}' contains '${a.name}'.`, 'InvalidStageDeclarationException');
      for (const k of req) if (!a.configuration || a.configuration[k] === undefined || a.configuration[k] === '') throw bad(`Action configuration for action '${a.name}' is missing required configuration '${k}'`, 'InvalidActionDeclarationException');
      if (a.actionTypeId.category === 'Source' && !a.outputArtifacts?.length) throw bad(`Action '${a.name}' must declare at least one output artifact.`, 'InvalidActionDeclarationException');
      if (['Build', 'Deploy', 'Test'].includes(a.actionTypeId.category) && !a.inputArtifacts?.length) throw bad(`Action '${a.name}' must declare at least one input artifact.`, 'InvalidActionDeclarationException');
      for (const ia of a.inputArtifacts ?? []) if (!outputs.has(ia.name)) throw bad(`Action '${a.name}' in stage '${st.name}' declares input artifact '${ia.name}', which is not an output artifact of a previous action.`, 'InvalidActionDeclarationException');
      for (const oa of a.outputArtifacts ?? []) { if (outputs.has(oa.name) || stageOut.has(oa.name)) throw bad(`Output artifact '${oa.name}' is declared more than once.`, 'InvalidActionDeclarationException'); stageOut.add(oa.name); }
      if (a.roleArn) { const ar = roleByArn(ctx.s, a.roleArn); if (!ar || !trustsService(ar, 'codepipeline.amazonaws.com')) throw bad(`CodePipeline is not authorized to perform AssumeRole on role ${a.roleArn}`); }
    }
    stageOut.forEach((o) => outputs.add(o));
  });
  return {
    name: d.name, arn: pipelineArn(ctx, d.name), region: ctx.region, roleArn: d.roleArn, artifactStore: { type: 'S3', location: store.location },
    stages: stages.map((st) => ({ name: st.name, actions: st.actions.map((a) => ({ ...a, runOrder: a.runOrder ?? 1, configuration: a.configuration ?? {}, outputArtifacts: a.outputArtifacts ?? [], inputArtifacts: a.inputArtifacts ?? [], region: a.region ?? ctx.region, namespace: a.namespace })) })),
    version: 1, created: now(), updated: now(), disabled: {}, pipelineType: d.pipelineType ?? 'V1',
  };
}

export function getPipelineRaw(ctx: Ctx, name: string): CpPipeline {
  const p = cicd(ctx.s).pipelines.find((x) => x.name === name && x.region === ctx.region);
  if (!p) throw e('PipelineNotFoundException', `Account '${ctx.s.account.id}' does not have a pipeline with name '${name}'`);
  return p;
}

// ------------------------------------------------------------------ ejecución

const consoleUrl = (pl: CpPipeline, path: string) => `https://${pl.region}.console.aws.amazon.com/${path}`;

function artifactKey(pl: CpPipeline, name: string, files: Record<string, string>, s: CloudState): string {
  const key = `${pl.name}/${name.slice(0, 10)}/${upper(6).toLowerCase()}`;
  putBucketObject(s, pl.artifactStore.location, key, packBundle(files));
  return key;
}

function failAction(ae: CpActionExec, code: string, message: string) {
  ae.status = 'Failed';
  ae.endTime = now();
  ae.summary = message;
  ae.errorDetails = { code, message };
}
const okAction = (ae: CpActionExec, summary?: string) => {
  ae.status = 'Succeeded';
  ae.endTime = now();
  if (summary) ae.summary = summary;
};

function roleFor(s: CloudState, pl: CpPipeline, a: CpAction): IamRole | undefined {
  return roleByArn(s, a.roleArn ?? pl.roleArn);
}

function startAction(s: CloudState, pl: CpPipeline, ex: CpExecution, stage: CpStage, a: CpAction, ae: CpActionExec): void {
  ae.status = 'InProgress';
  ae.startTime = now();
  const role = roleFor(s, pl, a);
  const cfg = a.configuration ?? {};
  const session = `${pl.name}`.slice(0, 40);
  const deny = (action: string, resource: string) => (role ? roleDenial(s, role, session, action, resource) : 'role not found');
  const key = typeKey(a);
  const outName = a.outputArtifacts?.[0]?.name;
  const store = pl.artifactStore.location;
  const needStore = (): string | null => {
    const d = deny('s3:PutObject', `arn:aws:s3:::${store}/${pl.name}/*`);
    return d ? `Insufficient permissions The provided role does not have sufficient permissions to access the S3 artifact bucket '${store}'. Error: ${d}` : null;
  };

  if (key === 'Source/AWS/CodeCommit') {
    const repo = cicd(s).repos.find((r) => r.name === cfg.RepositoryName && r.region === pl.region);
    if (!repo) return failAction(ae, 'ConfigurationError', `The action failed because the AWS CodeCommit repository '${cfg.RepositoryName}' does not exist.`);
    for (const act of ['codecommit:GetBranch', 'codecommit:GetCommit', 'codecommit:UploadArchive']) {
      const d = deny(act, repo.arn);
      if (d) return failAction(ae, 'PermissionError', `Insufficient permissions The service role or action role doesn't have the permissions required to access the AWS CodeCommit repository ${repo.name}. Update the IAM role permissions, and then try again. Error: ${d}`);
    }
    const id = repo.branches[cfg.BranchName];
    if (!id) return failAction(ae, 'ConfigurationError', `The action failed because the branch '${cfg.BranchName}' does not exist in the AWS CodeCommit repository '${repo.name}'.`);
    const ps = needStore();
    if (ps) return failAction(ae, 'PermissionError', ps);
    const files = filesOf(repo.objs, id);
    const c = repo.objs.commits[id];
    ex.artifacts[outName!] = { files, commitId: id, repo: repo.name, branch: cfg.BranchName, s3Key: artifactKey(pl, outName!, files, s) };
    const summary = c.message.split('\n')[0];
    ex.sourceRevisions.push({ actionName: a.name, revisionId: id, revisionSummary: summary, revisionUrl: consoleUrl(pl, `codesuite/codecommit/repositories/${repo.name}/commit/${id}`) });
    ae.externalExecutionId = id;
    ae.externalExecutionUrl = consoleUrl(pl, `codesuite/codecommit/repositories/${repo.name}/commit/${id}`);
    return okAction(ae, summary);
  }

  if (key === 'Source/AWS/S3') {
    const bk = s.buckets.find((b) => b.name === cfg.S3Bucket);
    const o = bk?.objects[cfg.S3ObjectKey];
    if (!bk || !o) return failAction(ae, 'ConfigurationError', `The action failed because the S3 object '${cfg.S3ObjectKey}' does not exist in bucket '${cfg.S3Bucket}'.`);
    const d = deny('s3:GetObject', `arn:aws:s3:::${bk.name}/${o.key}`);
    if (d) return failAction(ae, 'PermissionError', `Insufficient permissions The provided role does not have sufficient permissions to access the S3 bucket '${bk.name}'. Error: ${d}`);
    const ps = needStore();
    if (ps) return failAction(ae, 'PermissionError', ps);
    const files = unpackBundle(o.body) ?? { [o.key.split('/').pop()!]: o.body };
    ex.artifacts[outName!] = { files, s3Key: artifactKey(pl, outName!, files, s) };
    ex.sourceRevisions.push({ actionName: a.name, revisionId: o.versionId ?? o.etag, revisionSummary: `${bk.name}/${o.key}` });
    return okAction(ae, `${bk.name}/${o.key}`);
  }

  if (key === 'Build/AWS/CodeBuild' || key === 'Test/AWS/CodeBuild') {
    const proj = cicd(s).projects.find((p) => p.name === cfg.ProjectName && p.region === pl.region);
    if (!proj) return failAction(ae, 'ConfigurationError', `Could not find project '${cfg.ProjectName}'.`);
    for (const act of ['codebuild:StartBuild', 'codebuild:BatchGetBuilds']) {
      const d = deny(act, proj.arn);
      if (d) return failAction(ae, 'PermissionError', `Error calling StartBuild: ${d} (Service: AWSCodeBuild; Status Code: 400; Error Code: AccessDeniedException)`);
    }
    const input = ex.artifacts[a.inputArtifacts?.[0]?.name ?? ''];
    const b = createBuild(s, proj, { initiator: `codepipeline/${pl.name}`, input: input ? { files: input.files ?? {}, commitId: input.commitId } : { files: {} }, pipelineExecutionId: ex.id });
    ae.waitFor = b.id;
    ae.externalExecutionId = b.id;
    ae.externalExecutionUrl = consoleUrl(pl, `codesuite/codebuild/projects/${proj.name}/build/${b.id}`);
    ae.summary = 'Build started';
    return;
  }

  if (key === 'Approval/AWS/Manual') {
    ae.token = guid();
    ae.summary = cfg.CustomData ?? 'Waiting for approval';
    const arn = cfg.NotificationArn;
    const topic = arn ? s.topics.find((t) => t.arn === arn) : undefined;
    if (topic) {
      topic.messages.push({ id: guid(), ts: new Date(now()).toISOString(), subject: `APPROVAL NEEDED: Action ${a.name} for pipeline ${pl.name}`, source: 'codepipeline', message: JSON.stringify({ region: pl.region, consoleLink: consoleUrl(pl, `codesuite/codepipeline/pipelines/${pl.name}/view`), approval: { pipelineName: pl.name, stageName: stage.name, actionName: a.name, token: ae.token, expires: new Date(now() + 7 * 86400000).toISOString(), externalEntityLink: cfg.ExternalEntityLink ?? null, approvalReviewLink: consoleUrl(pl, `codesuite/codepipeline/pipelines/${pl.name}/view`), customData: cfg.CustomData ?? null } }, null, 2) });
    }
    return;
  }

  if (key === 'Deploy/AWS/CodeDeploy') {
    const app = cicd(s).apps.find((x) => x.name === cfg.ApplicationName && x.region === pl.region);
    if (!app) return failAction(ae, 'ConfigurationError', `Application '${cfg.ApplicationName}' not found. No application found for name: ${cfg.ApplicationName}`);
    const g = cicd(s).groups.find((x) => x.appName === app.name && x.name === cfg.DeploymentGroupName && x.region === pl.region);
    if (!g) return failAction(ae, 'ConfigurationError', `Deployment group '${cfg.DeploymentGroupName}' not found. Deployment group doesn't exist: ${cfg.DeploymentGroupName}`);
    for (const act of ['codedeploy:CreateDeployment', 'codedeploy:GetApplicationRevision', 'codedeploy:RegisterApplicationRevision', 'codedeploy:GetDeploymentConfig', 'codedeploy:GetDeployment']) {
      const d = deny(act, `arn:aws:codedeploy:${pl.region}:${s.account.id}:deploymentgroup:${app.name}/${g.name}`);
      if (d) return failAction(ae, 'PermissionError', `Insufficient permissions The provided role does not have sufficient permissions to perform ${act} for deployment group '${g.name}'. Error: ${d}`);
    }
    const input = ex.artifacts[a.inputArtifacts?.[0]?.name ?? ''];
    if (!input?.s3Key) return failAction(ae, 'ConfigurationError', 'The input artifact is not available.');
    const dep = createDeploymentInternal(s, g, { revision: { revisionType: 'S3', s3Location: { bucket: store, key: input.s3Key, bundleType: 'zip' } }, creator: 'user', region: pl.region, pipelineExecutionId: ex.id });
    ae.waitFor = dep.id;
    ae.externalExecutionId = dep.id;
    ae.externalExecutionUrl = consoleUrl(pl, `codesuite/codedeploy/deployments/${dep.id}`);
    ae.summary = 'Deployment started';
    return;
  }

  if (key === 'Deploy/AWS/S3') {
    const input = ex.artifacts[a.inputArtifacts?.[0]?.name ?? ''];
    const bk = s.buckets.find((b) => b.name === cfg.BucketName);
    if (!bk) return failAction(ae, 'ConfigurationError', `The specified bucket '${cfg.BucketName}' does not exist.`);
    const prefix = (cfg.ObjectKey ?? '').replace(/\/$/, '');
    const extract = cfg.Extract !== 'false';
    const d = deny('s3:PutObject', `arn:aws:s3:::${bk.name}/${prefix ? prefix + '/' : ''}*`);
    if (d) return failAction(ae, 'PermissionError', `Insufficient permissions The provided role does not have sufficient permissions to write to the S3 bucket '${bk.name}'. Error: ${d}`);
    if (extract) for (const [p, c] of Object.entries(input?.files ?? {})) putBucketObject(s, bk.name, prefix ? `${prefix}/${p}` : p, c, 'binary/octet-stream');
    else putBucketObject(s, bk.name, prefix || 'artifact.zip', packBundle(input?.files ?? {}));
    return okAction(ae, 'Deployed to S3');
  }
}

function pollAction(s: CloudState, pl: CpPipeline, ex: CpExecution, a: CpAction, ae: CpActionExec): void {
  const key = typeKey(a);
  if (ae.waitFor && (key === 'Build/AWS/CodeBuild' || key === 'Test/AWS/CodeBuild')) {
    const b = cicd(s).builds.find((x) => x.id === ae.waitFor);
    if (!b) return failAction(ae, 'JobFailed', 'The build no longer exists.');
    if (b.buildStatus === 'IN_PROGRESS') return;
    if (b.buildStatus !== 'SUCCEEDED') return failAction(ae, 'JobFailed', `Build terminated with state: ${b.buildStatus}`);
    const out = a.outputArtifacts?.[0]?.name;
    if (out) {
      const files = b.outFiles ?? {};
      ex.artifacts[out] = { files, s3Key: artifactKey(pl, out, files, s) };
    }
    return okAction(ae, 'Build succeeded');
  }
  if (ae.waitFor && key === 'Deploy/AWS/CodeDeploy') {
    const d = cicd(s).deployments.find((x) => x.id === ae.waitFor);
    if (!d) return failAction(ae, 'JobFailed', 'The deployment no longer exists.');
    if (d.status === 'InProgress' || d.status === 'Created' || d.status === 'Queued') return;
    if (d.status !== 'Succeeded') return failAction(ae, 'JobFailed', `Deployment ${d.id} failed${d.error ? `: ${d.error.code}` : ''}`);
    return okAction(ae, 'Deployment succeeded');
  }
}

const groupsByRunOrder = (st: CpStage): CpAction[][] => {
  const orders = [...new Set(st.actions.map((a) => a.runOrder ?? 1))].sort((x, y) => x - y);
  return orders.map((o) => st.actions.filter((a) => (a.runOrder ?? 1) === o));
};

export function advanceExecution(s: CloudState, ex: CpExecution): void {
  const pl = cicd(s).pipelines.find((p) => p.name === ex.pipelineName && p.region === ex.region);
  if (!pl) return;
  for (let guard = 0; guard < 60; guard++) {
    if (ex.status !== 'InProgress') return;
    const si = ex.stages.findIndex((x) => x.status !== 'Succeeded');
    if (si < 0) { ex.status = 'Succeeded'; ex.last = now(); return; }
    const se = ex.stages[si];
    const decl = pl.stages[si];
    if (se.status === 'Failed') { ex.status = 'Failed'; ex.last = now(); return; }
    if (se.status === '') {
      if (si > 0 && pl.disabled[se.name]) { ex.statusSummary = `Stage transition into '${se.name}' is disabled`; return; }
      ex.statusSummary = undefined;
      se.status = 'InProgress';
      // Bloqueo de etapa: una ejecución más nueva sustituye a la anterior si esta solo espera una aprobación; si trabaja, espera.
      const holder = cicd(s).executions.find((o) => o !== ex && o.pipelineName === ex.pipelineName && o.region === ex.region && o.status === 'InProgress' && o.start < ex.start && o.stages[si]?.status === 'InProgress');
      if (holder) {
        const os = holder.stages[si];
        const onlyApprovals = os.actions.filter((x) => x.status === 'InProgress').every((x) => !x.waitFor && !!x.token);
        if (!onlyApprovals) { se.status = ''; ex.statusSummary = `Waiting for stage '${se.name}' to be released by a previous execution`; return; }
        holder.status = 'Superseded';
        os.status = 'Stopped';
        os.actions.forEach((x) => { if (x.status === 'InProgress') x.status = 'Abandoned'; });
      }
    }
    let waiting = false, failed = false;
    for (const grp of groupsByRunOrder(decl)) {
      for (const a of grp) {
        const ae = se.actions.find((x) => x.name === a.name)!;
        if (ae.status === '') startAction(s, pl, ex, decl, a, ae);
        if (ae.status === 'InProgress') pollAction(s, pl, ex, a, ae);
        if (ae.status === 'InProgress') waiting = true;
        if (ae.status === 'Failed') failed = true;
      }
      if (failed || waiting) break;
    }
    ex.last = now();
    if (failed) { se.status = 'Failed'; ex.status = 'Failed'; return; }
    if (waiting) return;
    se.status = 'Succeeded';
  }
}

/** Avanza todo el CI/CD: compilaciones, despliegues y ejecuciones de canalizaciones. */
export function settleCicd(s: CloudState): void {
  const c = cicd(s);
  if (!c.builds.length && !c.deployments.length && !c.executions.length) return;
  settleBuilds(s);
  settleDeployments(s);
  for (const ex of c.executions) if (ex.status === 'InProgress') advanceExecution(s, ex);
}

export function startExecution(s: CloudState, pl: CpPipeline, trigger: { triggerType: string; triggerDetail: string }): CpExecution {
  const ex: CpExecution = {
    id: guid(), pipelineName: pl.name, region: pl.region, pipelineVersion: pl.version, status: 'InProgress', trigger, start: now(), last: now(),
    stages: pl.stages.map((st) => ({ name: st.name, status: '', actions: st.actions.map((a) => ({ name: a.name, status: '' })) })), artifacts: {}, sourceRevisions: [],
  };
  cicd(s).executions.push(ex);
  advanceExecution(s, ex);
  return ex;
}

// ------------------------------------------------------------------ disparo por cambios en CodeCommit

cicdHooks.repoUpdated.push((s, repo, branch, actor) => {
  for (const pl of cicd(s).pipelines) {
    if (pl.region !== repo.region) continue;
    const src = pl.stages[0]?.actions.find((a) => typeKey(a) === 'Source/AWS/CodeCommit' && a.configuration?.RepositoryName === repo.name && a.configuration?.BranchName === branch);
    if (!src) continue;
    const id = repo.branches[branch];
    const last = [...cicd(s).executions].reverse().find((x) => x.pipelineName === pl.name && x.region === pl.region);
    if (last?.sourceRevisions.some((r) => r.revisionId === id)) continue;
    startExecution(s, pl, src.configuration?.PollForSourceChanges === 'false' ? { triggerType: 'CloudWatchEvent', triggerDetail: `arn:aws:events:${pl.region}:${s.account.id}:rule/codepipeline-${pl.name.slice(0, 20)}-${branch}-event-rule` } : { triggerType: 'PollForSourceChanges', triggerDetail: `arn:aws:codecommit:${pl.region}:${s.account.id}:${repo.name}/${branch}` });
    void actor;
  }
});

// ------------------------------------------------------------------ API

export function createPipeline(ctx: Ctx, p: { Pipeline: any; Tags?: { key: string; value: string }[] }): CpPipeline {
  return trailed(ctx, SRC, 'CreatePipeline', [{ type: 'AWS::CodePipeline::Pipeline', name: p.Pipeline?.name ?? '' }], { pipeline: { name: p.Pipeline?.name, roleArn: p.Pipeline?.roleArn } }, () => {
    if (!p.Pipeline) throw e('ValidationException', "1 validation error detected: Value null at 'pipeline' failed to satisfy constraint: Member must not be null");
    authorize(ctx, 'codepipeline:CreatePipeline', pipelineArn(ctx, p.Pipeline.name ?? '*'));
    settleCicd(ctx.s);
    const pl = validate(ctx, p.Pipeline);
    if (cicd(ctx.s).pipelines.some((x) => x.name === pl.name && x.region === ctx.region)) throw e('PipelineNameInUseException', 'The specified pipeline name is already in use.');
    cicd(ctx.s).pipelines.push(pl);
    startExecution(ctx.s, pl, { triggerType: 'CreatePipeline', triggerDetail: ctx.caller.arn });
    return pl;
  });
}

export function getPipeline(ctx: Ctx, p: { Name: string; Version?: number }): CpPipeline {
  return trailed(ctx, SRC, 'GetPipeline', [{ type: 'AWS::CodePipeline::Pipeline', name: p.Name }], { name: p.Name }, () => {
    authorize(ctx, 'codepipeline:GetPipeline', pipelineArn(ctx, p.Name));
    return getPipelineRaw(ctx, p.Name);
  });
}

export function updatePipeline(ctx: Ctx, p: { Pipeline: any }): CpPipeline {
  return trailed(ctx, SRC, 'UpdatePipeline', [{ type: 'AWS::CodePipeline::Pipeline', name: p.Pipeline?.name ?? '' }], { pipeline: { name: p.Pipeline?.name } }, () => {
    authorize(ctx, 'codepipeline:UpdatePipeline', pipelineArn(ctx, p.Pipeline?.name ?? '*'));
    const prev = getPipelineRaw(ctx, p.Pipeline?.name);
    const next = validate(ctx, p.Pipeline);
    Object.assign(prev, { ...next, created: prev.created, version: prev.version + 1, updated: now(), disabled: prev.disabled });
    return prev;
  });
}

export function deletePipeline(ctx: Ctx, p: { Name: string }): void {
  return trailed(ctx, SRC, 'DeletePipeline', [{ type: 'AWS::CodePipeline::Pipeline', name: p.Name }], { name: p.Name }, () => {
    authorize(ctx, 'codepipeline:DeletePipeline', pipelineArn(ctx, p.Name));
    const c = cicd(ctx.s);
    c.pipelines = c.pipelines.filter((x) => !(x.name === p.Name && x.region === ctx.region));
    c.executions = c.executions.filter((x) => !(x.pipelineName === p.Name && x.region === ctx.region));
  });
}

export function listPipelines(ctx: Ctx): CpPipeline[] {
  return trailed(ctx, SRC, 'ListPipelines', [], {}, () => {
    authorize(ctx, 'codepipeline:ListPipelines', '*');
    return cicd(ctx.s).pipelines.filter((x) => x.region === ctx.region).sort((a, b) => a.name.localeCompare(b.name));
  });
}

export const executionsOf = (s: CloudState, name: string, region: string): CpExecution[] => (settleCicd(s), cicd(s).executions.filter((x) => x.pipelineName === name && x.region === region).sort((a, b) => b.start - a.start));

export function startPipelineExecution(ctx: Ctx, p: { Name: string }): CpExecution {
  return trailed(ctx, SRC, 'StartPipelineExecution', [{ type: 'AWS::CodePipeline::Pipeline', name: p.Name }], { name: p.Name }, () => {
    authorize(ctx, 'codepipeline:StartPipelineExecution', pipelineArn(ctx, p.Name));
    const pl = getPipelineRaw(ctx, p.Name);
    settleCicd(ctx.s);
    return startExecution(ctx.s, pl, { triggerType: 'StartPipelineExecution', triggerDetail: ctx.caller.arn });
  });
}

export function getPipelineExecution(ctx: Ctx, p: { PipelineName: string; PipelineExecutionId: string }): CpExecution {
  return trailed(ctx, SRC, 'GetPipelineExecution', [{ type: 'AWS::CodePipeline::Pipeline', name: p.PipelineName }], { pipelineName: p.PipelineName, pipelineExecutionId: p.PipelineExecutionId }, () => {
    authorize(ctx, 'codepipeline:GetPipelineExecution', pipelineArn(ctx, p.PipelineName));
    getPipelineRaw(ctx, p.PipelineName);
    settleCicd(ctx.s);
    const ex = cicd(ctx.s).executions.find((x) => x.id === p.PipelineExecutionId && x.pipelineName === p.PipelineName);
    if (!ex) throw e('PipelineExecutionNotFoundException', `Pipeline '${p.PipelineName}' does not have an execution with ID '${p.PipelineExecutionId}'`);
    return ex;
  });
}

export function listPipelineExecutions(ctx: Ctx, p: { PipelineName: string }): CpExecution[] {
  return trailed(ctx, SRC, 'ListPipelineExecutions', [{ type: 'AWS::CodePipeline::Pipeline', name: p.PipelineName }], { pipelineName: p.PipelineName }, () => {
    authorize(ctx, 'codepipeline:ListPipelineExecutions', pipelineArn(ctx, p.PipelineName));
    getPipelineRaw(ctx, p.PipelineName);
    return executionsOf(ctx.s, p.PipelineName, ctx.region);
  });
}

/** Estado de cada etapa: la última ejecución que la tocó. */
export function stageStates(s: CloudState, pl: CpPipeline) {
  const exs = executionsOf(s, pl.name, pl.region);
  return pl.stages.map((st, i) => {
    const ex = exs.find((x) => x.stages[i]?.status !== '');
    const se: CpStageExec | undefined = ex?.stages[i];
    return { stage: st, exec: ex, se, transition: pl.disabled[st.name] };
  });
}

export function getPipelineState(ctx: Ctx, p: { Name: string }) {
  return trailed(ctx, SRC, 'GetPipelineState', [{ type: 'AWS::CodePipeline::Pipeline', name: p.Name }], { name: p.Name }, () => {
    authorize(ctx, 'codepipeline:GetPipelineState', pipelineArn(ctx, p.Name));
    const pl = getPipelineRaw(ctx, p.Name);
    return { pl, states: stageStates(ctx.s, pl) };
  });
}

export function putApprovalResult(ctx: Ctx, p: { PipelineName: string; StageName: string; ActionName: string; Result: { summary: string; status: 'Approved' | 'Rejected' }; Token: string }): number {
  return trailed(ctx, SRC, 'PutApprovalResult', [{ type: 'AWS::CodePipeline::Pipeline', name: p.PipelineName }], { pipelineName: p.PipelineName, stageName: p.StageName, actionName: p.ActionName, result: p.Result }, () => {
    authorize(ctx, 'codepipeline:PutApprovalResult', actionArn(ctx, p.PipelineName, p.StageName, p.ActionName));
    const pl = getPipelineRaw(ctx, p.PipelineName);
    const si = pl.stages.findIndex((x) => x.name === p.StageName);
    if (si < 0) throw e('StageNotFoundException', `Pipeline '${p.PipelineName}' does not have a stage with the name '${p.StageName}'`);
    const decl = pl.stages[si].actions.find((x) => x.name === p.ActionName);
    if (!decl) throw e('ActionNotFoundException', `Stage '${p.StageName}' does not have an action with the name '${p.ActionName}'`);
    if (!['Approved', 'Rejected'].includes(p.Result?.status)) throw e('ValidationException', `1 validation error detected: Value '${p.Result?.status}' at 'result.status' failed to satisfy constraint: Member must satisfy enum value set: [Approved, Rejected]`);
    if (!p.Result.summary) throw e('ValidationException', "1 validation error detected: Value null at 'result.summary' failed to satisfy constraint: Member must not be null");
    settleCicd(ctx.s);
    const ex = executionsOf(ctx.s, pl.name, pl.region).find((x) => x.stages[si]?.actions.some((a) => a.name === p.ActionName && a.token === p.Token));
    if (!ex) throw e('InvalidApprovalTokenException', 'The approval request already received a response or has expired.');
    const ae = ex.stages[si].actions.find((a) => a.name === p.ActionName)!;
    if (ae.status !== 'InProgress') throw e('ApprovalAlreadyCompletedException', 'The approval action has already been approved or rejected.');
    if (p.Result.status === 'Approved') okAction(ae, p.Result.summary);
    else failAction(ae, 'JobFailed', `Rejected: ${p.Result.summary}`);
    ae.token = undefined;
    ex.last = now();
    advanceExecution(ctx.s, ex);
    return now();
  });
}

export function stopPipelineExecution(ctx: Ctx, p: { PipelineName: string; PipelineExecutionId: string; Abandon?: boolean; Reason?: string }): string {
  return trailed(ctx, SRC, 'StopPipelineExecution', [{ type: 'AWS::CodePipeline::Pipeline', name: p.PipelineName }], { pipelineName: p.PipelineName, pipelineExecutionId: p.PipelineExecutionId, reason: p.Reason }, () => {
    authorize(ctx, 'codepipeline:StopPipelineExecution', pipelineArn(ctx, p.PipelineName));
    getPipelineRaw(ctx, p.PipelineName);
    settleCicd(ctx.s);
    const ex = cicd(ctx.s).executions.find((x) => x.id === p.PipelineExecutionId && x.pipelineName === p.PipelineName);
    if (!ex) throw e('PipelineExecutionNotFoundException', `Pipeline '${p.PipelineName}' does not have an execution with ID '${p.PipelineExecutionId}'`);
    if (ex.status !== 'InProgress') throw e('PipelineExecutionNotStoppableException', `Cannot stop execution ${ex.id}: it is not in progress (status ${ex.status}).`);
    ex.status = 'Stopped';
    ex.statusSummary = p.Reason;
    for (const st of ex.stages) if (st.status === 'InProgress') { st.status = 'Stopped'; st.actions.forEach((a) => { if (a.status === 'InProgress') a.status = 'Abandoned'; }); }
    return ex.id;
  });
}

export function retryStage(ctx: Ctx, p: { PipelineName: string; StageName: string; PipelineExecutionId: string; RetryMode: string }): string {
  return trailed(ctx, SRC, 'RetryStageExecution', [{ type: 'AWS::CodePipeline::Pipeline', name: p.PipelineName }], { pipelineName: p.PipelineName, stageName: p.StageName, pipelineExecutionId: p.PipelineExecutionId, retryMode: p.RetryMode }, () => {
    authorize(ctx, 'codepipeline:RetryStageExecution', pipelineArn(ctx, p.PipelineName));
    const pl = getPipelineRaw(ctx, p.PipelineName);
    const si = pl.stages.findIndex((x) => x.name === p.StageName);
    if (si < 0) throw e('StageNotFoundException', `Pipeline '${p.PipelineName}' does not have a stage with the name '${p.StageName}'`);
    if (!['FAILED_ACTIONS', 'ALL_ACTIONS'].includes(p.RetryMode)) throw e('ValidationException', `1 validation error detected: Value '${p.RetryMode}' at 'retryMode' failed to satisfy constraint: Member must satisfy enum value set: [ALL_ACTIONS, FAILED_ACTIONS]`);
    settleCicd(ctx.s);
    const ex = cicd(ctx.s).executions.find((x) => x.id === p.PipelineExecutionId && x.pipelineName === p.PipelineName);
    if (!ex) throw e('PipelineExecutionNotFoundException', `Pipeline '${p.PipelineName}' does not have an execution with ID '${p.PipelineExecutionId}'`);
    const se = ex.stages[si];
    if (se.status !== 'Failed') throw e('StageNotRetryableException', `Stage '${p.StageName}' cannot be retried: it is not in a failed state.`);
    const latest = executionsOf(ctx.s, pl.name, pl.region)[0];
    if (latest.id !== ex.id && latest.stages[si].status === 'InProgress') throw e('NotLatestPipelineExecutionException', 'The stage cannot be retried because the pipeline structure or stage state changed after the stage was inactive.');
    for (const a of se.actions) if (p.RetryMode === 'ALL_ACTIONS' || a.status === 'Failed') Object.assign(a, { status: '', summary: undefined, errorDetails: undefined, endTime: undefined, waitFor: undefined, token: undefined });
    se.status = 'InProgress';
    ex.status = 'InProgress';
    advanceExecution(ctx.s, ex);
    return ex.id;
  });
}

export function setTransition(ctx: Ctx, p: { PipelineName: string; StageName: string; TransitionType: string; Reason?: string }, enable: boolean): void {
  return trailed(ctx, SRC, enable ? 'EnableStageTransition' : 'DisableStageTransition', [{ type: 'AWS::CodePipeline::Pipeline', name: p.PipelineName }], { pipelineName: p.PipelineName, stageName: p.StageName, transitionType: p.TransitionType, reason: p.Reason }, () => {
    authorize(ctx, enable ? 'codepipeline:EnableStageTransition' : 'codepipeline:DisableStageTransition', pipelineArn(ctx, p.PipelineName));
    const pl = getPipelineRaw(ctx, p.PipelineName);
    const si = pl.stages.findIndex((x) => x.name === p.StageName);
    if (si < 0) throw e('StageNotFoundException', `Pipeline '${p.PipelineName}' does not have a stage with the name '${p.StageName}'`);
    if (si === 0) throw e('ValidationException', 'The first stage of a pipeline has no inbound transition.');
    if (enable) { delete pl.disabled[p.StageName]; settleCicd(ctx.s); for (const ex of cicd(ctx.s).executions) if (ex.pipelineName === pl.name && ex.status === 'InProgress') advanceExecution(ctx.s, ex); }
    else pl.disabled[p.StageName] = { reason: p.Reason ?? '', by: ctx.caller.arn, at: now() };
  });
}

export { asArr };

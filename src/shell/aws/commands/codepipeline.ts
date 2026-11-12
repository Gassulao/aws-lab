// aws codepipeline
import { defineCommand } from '../framework';
import * as cp from '../../../engine/services/codepipeline';
import '../../../engine/services/cicd';
import type { CpExecution, CpPipeline } from '../../../engine/services/cicdTypes';
import { iso, strip } from './cicd-util';

const declView = (pl: CpPipeline) => ({
  name: pl.name, roleArn: pl.roleArn, artifactStore: pl.artifactStore,
  stages: pl.stages.map((st) => ({ name: st.name, actions: st.actions.map((a) => strip({ name: a.name, actionTypeId: a.actionTypeId, runOrder: a.runOrder, configuration: a.configuration, outputArtifacts: a.outputArtifacts, inputArtifacts: a.inputArtifacts, region: a.region, namespace: a.namespace, roleArn: a.roleArn })) })),
  version: pl.version, pipelineType: pl.pipelineType,
});
const meta = (pl: CpPipeline, c: { s: { account: { id: string } } }) => ({ pipelineArn: pl.arn, created: iso(pl.created), updated: iso(pl.updated) });
void meta;
const tags = (t: any) => t;
void tags;

const exView = (ex: CpExecution) => ({ pipelineExecutionId: ex.id, status: ex.status, statusSummary: ex.statusSummary, startTime: iso(ex.start), lastUpdateTime: iso(ex.last), sourceRevisions: ex.sourceRevisions, trigger: ex.trigger });

defineCommand({ service: 'codepipeline', name: 'create-pipeline', op: 'CreatePipeline', structured: ['pipeline', 'tags'], list: ['tags'], run: (c, p) => { const pl = cp.createPipeline(c, { Pipeline: p.Pipeline ?? p.pipeline }); return { pipeline: declView(pl) }; } });
defineCommand({ service: 'codepipeline', name: 'update-pipeline', op: 'UpdatePipeline', structured: ['pipeline'], run: (c, p) => ({ pipeline: declView(cp.updatePipeline(c, { Pipeline: p.Pipeline ?? p.pipeline })) }) });
defineCommand({ service: 'codepipeline', name: 'get-pipeline', op: 'GetPipeline', run: (c, p) => { const pl = cp.getPipeline(c, { Name: p.Name }); return { pipeline: declView(pl), metadata: meta(pl, c) }; } });
defineCommand({ service: 'codepipeline', name: 'delete-pipeline', op: 'DeletePipeline', run: (c, p) => void cp.deletePipeline(c, { Name: p.Name }) });
defineCommand({ service: 'codepipeline', name: 'list-pipelines', op: 'ListPipelines', run: (c) => ({ pipelines: cp.listPipelines(c).map((pl) => ({ name: pl.name, version: pl.version, pipelineType: pl.pipelineType, executionMode: 'SUPERSEDED', created: iso(pl.created), updated: iso(pl.updated) })) }) });
defineCommand({ service: 'codepipeline', name: 'start-pipeline-execution', op: 'StartPipelineExecution', run: (c, p) => ({ pipelineExecutionId: cp.startPipelineExecution(c, { Name: p.Name }).id }) });
defineCommand({
  service: 'codepipeline', name: 'get-pipeline-execution', op: 'GetPipelineExecution',
  run: (c, p) => {
    const ex = cp.getPipelineExecution(c, { PipelineName: p.PipelineName, PipelineExecutionId: p.PipelineExecutionId });
    return { pipelineExecution: strip({ pipelineName: ex.pipelineName, pipelineVersion: ex.pipelineVersion, pipelineExecutionId: ex.id, status: ex.status, statusSummary: ex.statusSummary, artifactRevisions: ex.sourceRevisions.map((r) => strip({ name: r.actionName, revisionId: r.revisionId, revisionSummary: r.revisionSummary, created: iso(ex.start), revisionUrl: r.revisionUrl })), trigger: ex.trigger, executionMode: 'SUPERSEDED' }) };
  },
});
defineCommand({ service: 'codepipeline', name: 'list-pipeline-executions', op: 'ListPipelineExecutions', run: (c, p) => ({ pipelineExecutionSummaries: cp.listPipelineExecutions(c, { PipelineName: p.PipelineName }).map((x) => strip(exView(x))) }) });
defineCommand({
  service: 'codepipeline', name: 'get-pipeline-state', op: 'GetPipelineState',
  run: (c, p) => {
    const { pl, states } = cp.getPipelineState(c, { Name: p.Name });
    return {
      pipelineName: pl.name, pipelineVersion: pl.version,
      stageStates: states.map(({ stage, exec, se, transition }) => strip({
        stageName: stage.name,
        inboundExecution: undefined,
        inboundTransitionState: transition ? { enabled: false, lastChangedBy: transition.by, lastChangedAt: iso(transition.at), disabledReason: transition.reason } : { enabled: true },
        actionStates: stage.actions.map((a) => {
          const ae = se?.actions.find((x) => x.name === a.name);
          return strip({
            actionName: a.name,
            currentRevision: exec?.sourceRevisions.find((r) => r.actionName === a.name) ? { revisionId: exec.sourceRevisions.find((r) => r.actionName === a.name)!.revisionId } : undefined,
            latestExecution: ae && ae.status ? strip({ actionExecutionId: undefined, status: ae.status, summary: ae.summary, lastStatusChange: iso(ae.endTime ?? ae.startTime ?? Date.now()), token: ae.token, externalExecutionId: ae.externalExecutionId, externalExecutionUrl: ae.externalExecutionUrl, errorDetails: ae.errorDetails }) : undefined,
            entityUrl: `https://${pl.region}.console.aws.amazon.com/codesuite/codepipeline/pipelines/${pl.name}/view`,
            revisionUrl: exec?.sourceRevisions.find((r) => r.actionName === a.name)?.revisionUrl,
          });
        }),
        latestExecution: se && exec ? { pipelineExecutionId: exec.id, status: se.status } : undefined,
      })),
      created: iso(pl.created), updated: iso(pl.updated),
    };
  },
});
defineCommand({
  service: 'codepipeline', name: 'put-approval-result', op: 'PutApprovalResult', structured: ['result'],
  run: (c, p) => ({ approvedAt: iso(cp.putApprovalResult(c, { PipelineName: p.PipelineName, StageName: p.StageName, ActionName: p.ActionName, Result: p.Result, Token: p.Token })) }),
});
defineCommand({ service: 'codepipeline', name: 'stop-pipeline-execution', op: 'StopPipelineExecution', bool: ['abandon'], run: (c, p) => ({ pipelineExecutionId: cp.stopPipelineExecution(c, { PipelineName: p.PipelineName, PipelineExecutionId: p.PipelineExecutionId, Abandon: p.Abandon, Reason: p.Reason }) }) });
defineCommand({ service: 'codepipeline', name: 'retry-stage-execution', op: 'RetryStageExecution', run: (c, p) => ({ pipelineExecutionId: cp.retryStage(c, { PipelineName: p.PipelineName, StageName: p.StageName, PipelineExecutionId: p.PipelineExecutionId, RetryMode: p.RetryMode }) }) });
defineCommand({ service: 'codepipeline', name: 'disable-stage-transition', op: 'DisableStageTransition', run: (c, p) => void cp.setTransition(c, { PipelineName: p.PipelineName, StageName: p.StageName, TransitionType: p.TransitionType, Reason: p.Reason }, false) });
defineCommand({ service: 'codepipeline', name: 'enable-stage-transition', op: 'EnableStageTransition', run: (c, p) => void cp.setTransition(c, { PipelineName: p.PipelineName, StageName: p.StageName, TransitionType: p.TransitionType }, true) });

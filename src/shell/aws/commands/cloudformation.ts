// aws cloudformation ...
import { defineCommand, type Params } from '../framework';
import * as cfn from '../../../engine/services/cloudformation';
import { AwsError } from '../../../engine/errors';
import { VFS } from '../../fs';
import type { Ctx } from '../../../engine/api';
import type { CfnChange, CfnStack } from '../../../engine/services/cloudformation';

const isoMicro = (s: string) => s.replace(/\.(\d{3})Z$/, '.$1000+00:00').replace(/Z$/, '+00:00');
const ms = (t: number) => isoMicro(new Date(t).toISOString());
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const flat = (v: any): any[] => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).flat());
const DRIFT = { StackDriftStatus: 'NOT_CHECKED' };

/** `--parameters` y `--tags` admiten sintaxis abreviada, JSON en línea y file://. */
const paramList = (p: Params) => flat(p.Parameters).map((x) => strip({ ParameterKey: String(x.ParameterKey), ParameterValue: x.ParameterValue === undefined ? undefined : Array.isArray(x.ParameterValue) ? x.ParameterValue.join(',') : String(x.ParameterValue), UsePreviousValue: x.UsePreviousValue === undefined ? undefined : x.UsePreviousValue === true || x.UsePreviousValue === 'true' }));
const tagList = (p: Params) => (p.Tags === undefined ? undefined : flat(p.Tags).map((t) => ({ Key: String(t.Key), Value: String(t.Value ?? '') })));
const TPL = { structured: ['parameters', 'tags'], list: ['parameters', 'tags', 'capabilities'] };

const stackShape = (c: Ctx, st: CfnStack) => {
  const outs = cfn.visibleOutputs(st);
  const cs = st.status === 'REVIEW_IN_PROGRESS' ? st.changeSets[st.changeSets.length - 1] : undefined;
  return strip({
    StackId: st.id, StackName: st.name, ChangeSetId: cs?.id, Description: st.description,
    Parameters: st.parameters.length ? st.parameters.map((x) => ({ ParameterKey: x.key, ParameterValue: x.noEcho ? '****' : x.value })) : undefined,
    CreationTime: isoMicro(st.createdAt), LastUpdatedTime: st.updatedAt ? isoMicro(st.updatedAt) : undefined, DeletionTime: st.deletedAt ? isoMicro(st.deletedAt) : undefined,
    RollbackConfiguration: {}, StackStatus: st.status, StackStatusReason: st.statusReason, DisableRollback: st.disableRollback, NotificationARNs: [] as string[],
    Capabilities: st.capabilities.length ? st.capabilities : undefined,
    Outputs: outs.length ? outs.map((o) => strip({ OutputKey: o.key, OutputValue: o.value, Description: o.description, ExportName: o.exportName })) : undefined,
    RoleARN: st.roleArn, Tags: st.tags, EnableTerminationProtection: st.terminationProtection, DriftInformation: DRIFT,
  });
};

const changeShape = (ch: CfnChange) => ({
  Type: 'Resource',
  ResourceChange: strip({
    PolicyAction: ch.policyAction, Action: ch.action, LogicalResourceId: ch.logicalId, PhysicalResourceId: ch.physicalId, ResourceType: ch.type, Replacement: ch.replacement, Scope: ch.scope,
    Details: ch.details.map((d) => strip({ Target: { Attribute: d.attribute, Name: d.attribute === 'Tags' ? undefined : d.name, RequiresRecreation: d.recreation }, Evaluation: 'Static', ChangeSource: d.source, CausingEntity: d.causing })),
  }),
});

// ---------------------------------------------------------------- pilas

defineCommand({
  service: 'cloudformation', name: 'create-stack', op: 'CreateStack', ...TPL, bool: ['disable-rollback', 'enable-termination-protection'],
  run: (c, p) => {
    if (p.StackName === undefined) throw new Error('aws: error: the following arguments are required: --stack-name');
    const r = cfn.createStack(c, { StackName: p.StackName, TemplateBody: p.TemplateBody, TemplateURL: p.TemplateUrl, Parameters: paramList(p), Capabilities: flat(p.Capabilities), Tags: tagList(p), RoleARN: p.RoleArn, DisableRollback: p.DisableRollback, OnFailure: p.OnFailure, EnableTerminationProtection: p.EnableTerminationProtection, TimeoutInMinutes: p.TimeoutInMinutes });
    return { StackId: r.stackId };
  },
});
defineCommand({
  service: 'cloudformation', name: 'update-stack', op: 'UpdateStack', ...TPL, bool: ['use-previous-template', 'disable-rollback'],
  run: (c, p) => {
    if (p.StackName === undefined) throw new Error('aws: error: the following arguments are required: --stack-name');
    return { StackId: cfn.updateStack(c, { StackName: p.StackName, TemplateBody: p.TemplateBody, TemplateURL: p.TemplateUrl, UsePreviousTemplate: p.UsePreviousTemplate, Parameters: paramList(p), Capabilities: flat(p.Capabilities), Tags: tagList(p), RoleARN: p.RoleArn, DisableRollback: p.DisableRollback }).stackId };
  },
});
defineCommand({
  service: 'cloudformation', name: 'delete-stack', op: 'DeleteStack', list: ['retain-resources'],
  run: (c, p) => {
    if (p.StackName === undefined) throw new Error('aws: error: the following arguments are required: --stack-name');
    cfn.deleteStack(c, { StackName: p.StackName, RetainResources: p.RetainResources, RoleARN: p.RoleArn });
  },
});
defineCommand({ service: 'cloudformation', name: 'describe-stacks', op: 'DescribeStacks', run: (c, p) => ({ Stacks: cfn.describeStacks(c, { StackName: p.StackName }).map((st) => stackShape(c, st)) }) });
defineCommand({
  service: 'cloudformation', name: 'list-stacks', op: 'ListStacks', list: ['stack-status-filter'],
  run: (c, p) => ({
    StackSummaries: cfn.listStacks(c, { StackStatusFilter: p.StackStatusFilter }).map((st) => strip({
      StackId: st.id, StackName: st.name, TemplateDescription: st.description, CreationTime: isoMicro(st.createdAt), LastUpdatedTime: st.updatedAt ? isoMicro(st.updatedAt) : undefined,
      DeletionTime: st.deletedAt ? isoMicro(st.deletedAt) : undefined, StackStatus: st.status, StackStatusReason: st.statusReason, DriftInformation: DRIFT,
    })),
  }),
});
defineCommand({
  service: 'cloudformation', name: 'describe-stack-events', op: 'DescribeStackEvents',
  run: (c, p) => {
    const { stack, events } = cfn.describeStackEvents(c, { StackName: p.StackName });
    return {
      StackEvents: events.map((e) => strip({
        StackId: stack.id, EventId: e.id, StackName: stack.name, LogicalResourceId: e.logicalId, PhysicalResourceId: e.physicalId || undefined, ResourceType: e.type, Timestamp: ms(e.ts), ResourceStatus: e.status,
        ResourceStatusReason: e.reason, ResourceProperties: e.props,
      })),
    };
  },
});
defineCommand({
  service: 'cloudformation', name: 'describe-stack-resources', op: 'DescribeStackResources',
  run: (c, p) => {
    const { stack, resources } = cfn.describeStackResources(c, { StackName: p.StackName, LogicalResourceId: p.LogicalResourceId, PhysicalResourceId: p.PhysicalResourceId });
    return {
      StackResources: resources.map((r) => strip({ StackName: stack.name, StackId: stack.id, LogicalResourceId: r.res.logicalId, PhysicalResourceId: r.res.physicalId || undefined, ResourceType: r.res.type, Timestamp: ms(r.ts), ResourceStatus: r.status, ResourceStatusReason: r.reason, DriftInformation: { StackResourceDriftStatus: 'NOT_CHECKED' } })),
    };
  },
});
defineCommand({
  service: 'cloudformation', name: 'list-stack-resources', op: 'ListStackResources',
  run: (c, p) => ({
    StackResourceSummaries: cfn.listStackResources(c, { StackName: p.StackName }).resources.map((r) => strip({ LogicalResourceId: r.res.logicalId, PhysicalResourceId: r.res.physicalId || undefined, ResourceType: r.res.type, LastUpdatedTimestamp: ms(r.ts), ResourceStatus: r.status, ResourceStatusReason: r.reason, DriftInformation: { StackResourceDriftStatus: 'NOT_CHECKED' } })),
  }),
});
defineCommand({
  service: 'cloudformation', name: 'describe-stack-resource', op: 'DescribeStackResource',
  run: (c, p) => {
    const { stack, resource: r } = cfn.describeStackResource(c, { StackName: p.StackName, LogicalResourceId: p.LogicalResourceId });
    return { StackResourceDetail: strip({ StackName: stack.name, StackId: stack.id, LogicalResourceId: r.res.logicalId, PhysicalResourceId: r.res.physicalId || undefined, ResourceType: r.res.type, LastUpdatedTimestamp: ms(r.ts), ResourceStatus: r.status, ResourceStatusReason: r.reason, Metadata: '{}', DriftInformation: { StackResourceDriftStatus: 'NOT_CHECKED' } }) };
  },
});
defineCommand({
  service: 'cloudformation', name: 'get-template', op: 'GetTemplate',
  run: (c, p) => {
    const t = cfn.getTemplate(c, { StackName: p.StackName, ChangeSetName: p.ChangeSetName, TemplateStage: p.TemplateStage });
    return { TemplateBody: t.format === 'JSON' ? JSON.parse(t.body) : t.body, StagesAvailable: ['Original', 'Processed'] };
  },
});
defineCommand({
  service: 'cloudformation', name: 'validate-template', op: 'ValidateTemplate',
  run: (c, p) => {
    const r = cfn.validateTemplate(c, { TemplateBody: p.TemplateBody, TemplateURL: p.TemplateUrl });
    return strip({
      Parameters: r.parameters.map((x) => strip({ ParameterKey: x.key, DefaultValue: x.defaultValue, NoEcho: x.noEcho, Description: x.description })), Description: r.description,
      Capabilities: r.capabilities.length ? r.capabilities : undefined, CapabilitiesReason: r.reason,
    });
  },
});
defineCommand({
  service: 'cloudformation', name: 'update-termination-protection', op: 'UpdateTerminationProtection', bool: ['enable-termination-protection'],
  run: (c, p) => {
    if (p.EnableTerminationProtection === undefined) throw new Error('aws: error: argument --enable-termination-protection: expected one argument');
    return { StackId: cfn.updateTerminationProtection(c, { StackName: p.StackName, EnableTerminationProtection: p.EnableTerminationProtection }) };
  },
});
defineCommand({ service: 'cloudformation', name: 'list-exports', op: 'ListExports', run: (c) => ({ Exports: cfn.listExports(c).map((e) => ({ ExportingStackId: e.stackId, Name: e.name, Value: e.value })) }) });
defineCommand({ service: 'cloudformation', name: 'list-imports', op: 'ListImports', run: (c, p) => ({ Imports: cfn.listImports(c, { ExportName: p.ExportName }) }) });

// ---------------------------------------------------------------- conjuntos de cambios

defineCommand({
  service: 'cloudformation', name: 'create-change-set', op: 'CreateChangeSet', ...TPL, bool: ['use-previous-template'],
  run: (c, p) => {
    for (const k of ['StackName', 'ChangeSetName']) if (p[k] === undefined) throw new Error(`aws: error: the following arguments are required: --${k === 'StackName' ? 'stack-name' : 'change-set-name'}`);
    const r = cfn.createChangeSet(c, { StackName: p.StackName, ChangeSetName: p.ChangeSetName, TemplateBody: p.TemplateBody, TemplateURL: p.TemplateUrl, UsePreviousTemplate: p.UsePreviousTemplate, Parameters: paramList(p), Capabilities: flat(p.Capabilities), Tags: tagList(p), RoleARN: p.RoleArn, Description: p.Description, ChangeSetType: p.ChangeSetType });
    return { Id: r.id, StackId: r.stackId };
  },
});
defineCommand({
  service: 'cloudformation', name: 'describe-change-set', op: 'DescribeChangeSet',
  run: (c, p) => {
    const { stack, cs, status, execution, reason } = cfn.describeChangeSet(c, { ChangeSetName: p.ChangeSetName, StackName: p.StackName });
    return strip({
      Changes: status === 'CREATE_COMPLETE' ? cs.changes.map(changeShape) : [], ChangeSetName: cs.name, ChangeSetId: cs.id, StackId: stack.id, StackName: stack.name, Description: cs.description,
      Parameters: cs.parameters.length ? cs.parameters.map((x) => ({ ParameterKey: x.key, ParameterValue: x.noEcho ? '****' : x.value })) : undefined,
      CreationTime: isoMicro(cs.createdAt), ExecutionStatus: execution, Status: status, StatusReason: reason, NotificationARNs: [] as string[], RollbackConfiguration: {},
      Capabilities: cs.capabilities.length ? cs.capabilities : undefined, Tags: cs.tags, IncludeNestedStacks: false,
    });
  },
});
defineCommand({
  service: 'cloudformation', name: 'list-change-sets', op: 'ListChangeSets',
  run: (c, p) => {
    const { stack, sets } = cfn.listChangeSets(c, { StackName: p.StackName });
    return { Summaries: sets.map(({ cs, status, execution, reason }) => strip({ StackId: stack.id, StackName: stack.name, ChangeSetId: cs.id, ChangeSetName: cs.name, ExecutionStatus: execution, Status: status, StatusReason: reason, CreationTime: isoMicro(cs.createdAt), Description: cs.description, IncludeNestedStacks: false })) };
  },
});
defineCommand({ service: 'cloudformation', name: 'execute-change-set', op: 'ExecuteChangeSet', bool: ['disable-rollback'], run: (c, p) => void cfn.executeChangeSet(c, { ChangeSetName: p.ChangeSetName, StackName: p.StackName, DisableRollback: p.DisableRollback }) });
defineCommand({ service: 'cloudformation', name: 'delete-change-set', op: 'DeleteChangeSet', run: (c, p) => void cfn.deleteChangeSet(c, { ChangeSetName: p.ChangeSetName, StackName: p.StackName }) });

// ---------------------------------------------------------------- esperas

const WAITERS: Record<string, { name: string; ok: string[]; fail: string[]; kind?: 'exists' | 'changeset' }> = {
  'stack-create-complete': { name: 'StackCreateComplete', ok: ['CREATE_COMPLETE'], fail: ['CREATE_FAILED', 'DELETE_COMPLETE', 'DELETE_FAILED', 'ROLLBACK_FAILED', 'ROLLBACK_COMPLETE'] },
  'stack-update-complete': { name: 'StackUpdateComplete', ok: ['UPDATE_COMPLETE'], fail: ['UPDATE_FAILED', 'UPDATE_ROLLBACK_FAILED', 'UPDATE_ROLLBACK_COMPLETE'] },
  'stack-delete-complete': { name: 'StackDeleteComplete', ok: ['DELETE_COMPLETE'], fail: ['DELETE_FAILED', 'CREATE_FAILED', 'ROLLBACK_FAILED', 'UPDATE_ROLLBACK_FAILED', 'UPDATE_ROLLBACK_COMPLETE', 'UPDATE_COMPLETE'] },
  'stack-rollback-complete': { name: 'StackRollbackComplete', ok: ['UPDATE_ROLLBACK_COMPLETE'], fail: ['UPDATE_ROLLBACK_FAILED', 'CREATE_COMPLETE', 'CREATE_FAILED', 'DELETE_FAILED', 'DELETE_COMPLETE'] },
  'stack-exists': { name: 'StackExists', ok: [], fail: [], kind: 'exists' },
  'change-set-create-complete': { name: 'ChangeSetCreateComplete', ok: ['CREATE_COMPLETE'], fail: ['FAILED'], kind: 'changeset' },
};

defineCommand({
  service: 'cloudformation', name: 'wait', op: 'DescribeStacks',
  run: (c, p, _sh, pos) => {
    const key = pos[0];
    if (!key) throw new Error('aws: error: the following arguments are required: waiter_name');
    const w = WAITERS[key];
    if (!w) throw new Error(`aws: error: argument waiter_name: Invalid choice, valid choices are:\n\n${Object.keys(WAITERS).map((k) => '* ' + k).join('\n')}`);
    const wfail = (m: string) => new Error(`Waiter ${w.name} failed: ${m}`);
    if (w.kind === 'changeset') {
      let d;
      try { d = cfn.describeChangeSet(c, { ChangeSetName: p.ChangeSetName, StackName: p.StackName }); } catch (e) { if (e instanceof AwsError) throw wfail(`An error occurred (${e.code}) when calling the DescribeChangeSet operation: ${e.message}`); throw e; }
      cfn.fastForward(c.s, undefined, d.cs);
      const st = cfn.changeSetStatus(c.s, d.cs);
      if (st.status === 'FAILED') throw wfail('Waiter encountered a terminal failure state: For expression "Status" we matched expected path: "FAILED"');
      return;
    }
    let stack: CfnStack | undefined;
    try {
      stack = cfn.describeStacks(c, { StackName: p.StackName })[0];
    } catch (e) {
      if (e instanceof AwsError) {
        if (w.kind === 'exists') throw wfail('Max attempts exceeded');
        if (key === 'stack-delete-complete') return;
        throw wfail(`An error occurred (${e.code}) when calling the DescribeStacks operation: ${e.message}`);
      }
      throw e;
    }
    if (w.kind === 'exists') return;
    cfn.fastForward(c.s, stack);
    const status = stack.status;
    if (w.ok.includes(status)) return;
    if (w.fail.includes(status) || /FAILED|ROLLBACK_COMPLETE|COMPLETE$/.test(status)) throw wfail(`Waiter encountered a terminal failure state: For expression "Stacks[].StackStatus" we matched expected path: "${status}" at least once`);
  },
});

// ---------------------------------------------------------------- deploy

const kv = (s: string, what: string): [string, string] => {
  const i = s.indexOf('=');
  if (i < 0) throw new Error(`Expected Key=Value format for ${what}, got: ${s}`);
  return [s.slice(0, i), s.slice(i + 1)];
};
const apiErr = (e: unknown, op: string): never => {
  if (e instanceof AwsError) throw new Error(`An error occurred (${e.code}) when calling the ${op} operation: ${e.message}`);
  throw e;
};

defineCommand({
  service: 'cloudformation', name: 'deploy', op: 'CreateChangeSet', raw: true, list: ['parameter-overrides', 'capabilities', 'tags'], bool: ['execute-changeset', 'fail-on-empty-changeset', 'disable-rollback'],
  run: (c, p, sh) => {
    for (const k of ['TemplateFile', 'StackName']) if (p[k] === undefined) throw new Error(`aws: error: the following arguments are required: --${k === 'StackName' ? 'stack-name' : 'template-file'}`);
    const path = VFS.norm(String(p.TemplateFile), sh.cwd);
    let text: string;
    try {
      text = sh.fs.readFile(path);
    } catch {
      throw new Error(`Invalid template path ${p.TemplateFile}`);
    }
    const name = String(p.StackName);
    const existing = cfn.findStack(c, name);
    const kind = existing && existing.status !== 'REVIEW_IN_PROGRESS' ? 'UPDATE' : 'CREATE';
    const overrides = flat(p.ParameterOverrides).map((x) => (typeof x === 'string' ? kv(x, 'parameter-overrides') : [String(x.ParameterKey), String(x.ParameterValue)] as [string, string]));
    let declared: string[] = [];
    try { declared = Object.keys(cfn.parseTemplate(text).tpl.Parameters ?? {}); } catch { /* el error real lo da CreateChangeSet */ }
    const params = [
      ...overrides.map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })),
      ...(kind === 'UPDATE' ? declared.filter((k) => !overrides.some(([o]) => o === k) && existing!.parameters.some((x) => x.key === k)).map((ParameterKey) => ({ ParameterKey, UsePreviousValue: true })) : []),
    ];
    let epoch = Math.floor(cfn.cfnNow(c.s) / 1000);
    while (existing?.changeSets.some((x) => x.name === `awscli-cloudformation-package-deploy-${epoch}`)) epoch++;
    const csName = `awscli-cloudformation-package-deploy-${epoch}`;
    let created: { id: string; stackId: string };
    try {
      created = cfn.createChangeSet(c, {
        StackName: name, ChangeSetName: csName, TemplateBody: text, Parameters: params, Capabilities: flat(p.Capabilities), Tags: p.Tags ? flat(p.Tags).map((t) => { const [Key, Value] = kv(String(t), 'tags'); return { Key, Value }; }) : undefined,
        RoleARN: p.RoleArn, ChangeSetType: kind, Description: `Created by AWS CLI at ${new Date(cfn.cfnNow(c.s)).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')} UTC`,
      });
    } catch (e) {
      return apiErr(e, 'CreateChangeSet');
    }
    const st = cfn.findStack(c, name)!;
    const cs = st.changeSets.find((x) => x.id === created.id)!;
    cfn.fastForward(c.s, undefined, cs);
    const state = cfn.changeSetStatus(c.s, cs);
    if (state.status === 'FAILED') {
      const empty = /didn't contain changes|No updates are to be performed/.test(state.reason ?? '');
      cfn.deleteChangeSet(c, { ChangeSetName: cs.id });
      if (kind === 'CREATE') cfn.deleteStack(c, { StackName: name });
      if (empty) {
        if (p.FailOnEmptyChangeset === false) return `\nNo changes to deploy. Stack ${name} is up to date\n`;
        throw new Error(`No changes to deploy. Stack ${name} is up to date`);
      }
      throw new Error(`Failed to create the changeset: Waiter ChangeSetCreateComplete failed: Waiter encountered a terminal failure state: For expression "Status" we matched expected path: "FAILED" Status: FAILED. Reason: ${state.reason}`);
    }
    if (p.ExecuteChangeset === false) return `\nChangeset created successfully. Run the following command to review changes:\naws cloudformation describe-change-set --change-set-name ${cs.id}\n`;
    try {
      cfn.executeChangeSet(c, { ChangeSetName: cs.id, DisableRollback: p.DisableRollback });
    } catch (e) {
      return apiErr(e, 'ExecuteChangeSet');
    }
    cfn.fastForward(c.s, st);
    if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(st.status)) {
      throw new Error(`Failed to create/update the stack. Run the following command\nto fetch the list of events leading up to the failure\naws cloudformation describe-stack-events --stack-name ${name}`);
    }
    return `\nWaiting for changeset to be created..\nWaiting for stack create/update to complete\nSuccessfully created/updated stack - ${name}\n`;
  },
});

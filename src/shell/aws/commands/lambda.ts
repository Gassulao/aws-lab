// aws lambda
import { defineCommand, type Params } from '../framework';
import { VFS } from '../../fs';
import * as L from '../../../engine/serverless/lambda';
import { sv } from '../../../engine/serverless';
import type { LambdaFn, LambdaVersionSnap, EventSourceMapping, LambdaAlias } from '../../../engine/serverless/types';
import { BIN } from '../framework';
import { need, num, arr, binaryIn, strip, secIso, waitFor } from './sv-util';

const configOut = (fn: LambdaFn, v: LambdaVersionSnap, opts: { fresh?: boolean; alias?: string } = {}) => {
  const isLatest = v.version === '$LATEST';
  const state = L.fnState(fn);
  return strip({
    FunctionName: fn.name, FunctionArn: isLatest ? fn.arn : `${fn.arn}:${v.version}`, Runtime: v.runtime, Role: v.role, Handler: v.handler, CodeSize: v.codeSize, Description: v.description, Timeout: v.timeout, MemorySize: v.memory,
    LastModified: v.lastModified, CodeSha256: v.codeSha256, Version: v.version,
    Environment: Object.keys(v.env).length ? { Variables: v.env } : undefined,
    DeadLetterConfig: fn.deadLetterArn ? { TargetArn: fn.deadLetterArn } : undefined,
    TracingConfig: { Mode: 'PassThrough' }, RevisionId: fn.revisionId,
    ...(isLatest ? { State: opts.fresh ? 'Pending' : state, StateReason: (opts.fresh || state === 'Pending') ? 'The function is being created.' : undefined, StateReasonCode: (opts.fresh || state === 'Pending') ? 'Creating' : undefined } : {}),
    ...(isLatest ? { LastUpdateStatus: 'Successful' } : {}),
    PackageType: 'Zip', Architectures: ['x86_64'], EphemeralStorage: { Size: 512 }, SnapStart: { ApplyOn: 'None', OptimizationStatus: 'Off' },
    RuntimeVersionConfig: { RuntimeVersionArn: `arn:aws:lambda:${fn.region}::runtime:${'0'.repeat(8)}0${'0'.repeat(55)}` },
    LoggingConfig: { LogFormat: 'Text', LogGroup: `/aws/lambda/${fn.name}` },
  });
};
const cfg = (fn: LambdaFn) => configOut(fn, L.snapOf(fn, '$LATEST'));
const aliasOut = (a: LambdaAlias) => strip({ AliasArn: a.arn, Name: a.name, FunctionVersion: a.version, Description: a.description, RevisionId: a.revisionId, RoutingConfig: a.routing ? { AdditionalVersionWeights: a.routing } : undefined });
const mappingOut = (m: EventSourceMapping, fresh = false) => ({
  UUID: m.uuid, StateTransitionReason: 'USER_INITIATED', LastModified: secIso(m.lastModified), BatchSize: m.batchSize, MaximumBatchingWindowInSeconds: m.maxBatchingWindow, EventSourceArn: m.eventSourceArn, FunctionArn: m.functionArn,
  State: fresh ? 'Creating' : m.enabled ? 'Enabled' : 'Disabled', LastProcessingResult: m.lastProcessingResult, ...(m.functionResponseTypes.length ? { FunctionResponseTypes: m.functionResponseTypes } : {}),
});

/** El código llega como --zip-file fileb://paquete.zip (o --code S3Bucket=,S3Key=). */
function codeOf(p: Params) {
  if (p.ZipFile !== undefined) return { ZipFile: String(p.ZipFile) };
  if (p.Code) return { S3Bucket: p.Code.S3Bucket, S3Key: p.Code.S3Key, ...(p.Code.ZipFile ? { ZipFile: p.Code.ZipFile } : {}) };
  return {};
}
const S = 'lambda';
const STRUCT = { structured: ['environment', 'code', 'dead-letter-config', 'routing-config', 'tags'] };

defineCommand({
  service: S, name: 'create-function', op: 'CreateFunction', ...STRUCT, bool: ['publish'],
  run: (c, p) => {
    const fn = L.createFunction(c, {
      FunctionName: need(p, 'FunctionName', 'function-name'), Runtime: p.Runtime, Role: need(p, 'Role', 'role'), Handler: p.Handler, Code: codeOf(p), Description: p.Description, Timeout: num(p.Timeout), MemorySize: num(p.MemorySize),
      Environment: p.Environment, Publish: p.Publish, Tags: p.Tags, DeadLetterConfig: p.DeadLetterConfig,
    });
    return configOut(fn, L.snapOf(fn, '$LATEST'), { fresh: true });
  },
});
defineCommand({
  service: S, name: 'get-function', op: 'GetFunction',
  run: (c, p) => {
    const { fn, snap } = L.getFunction(c, { FunctionName: need(p, 'FunctionName', 'function-name'), Qualifier: p.Qualifier });
    return strip({
      Configuration: configOut(fn, snap), Code: { RepositoryType: 'S3', Location: `https://awslambda-${fn.region}-tasks.s3.${fn.region}.amazonaws.com/snapshots/${c.s.account.id}/${fn.name}-${fn.revisionId}?versionId=${fn.revisionId.slice(0, 8)}` },
      Tags: Object.keys(fn.tags).length ? fn.tags : undefined, Concurrency: fn.reservedConcurrency !== undefined ? { ReservedConcurrentExecutions: fn.reservedConcurrency } : undefined,
    });
  },
});
defineCommand({ service: S, name: 'get-function-configuration', op: 'GetFunctionConfiguration', run: (c, p) => { const { fn, snap } = L.getFunctionConfiguration(c, { FunctionName: need(p, 'FunctionName', 'function-name'), Qualifier: p.Qualifier }); return configOut(fn, snap); } });
defineCommand({ service: S, name: 'list-functions', op: 'ListFunctions', run: (c) => ({ Functions: L.listFunctions(c).map(cfg) }) });
defineCommand({ service: S, name: 'delete-function', op: 'DeleteFunction', run: (c, p) => void L.deleteFunction(c, { FunctionName: need(p, 'FunctionName', 'function-name'), Qualifier: p.Qualifier }) });
defineCommand({
  service: S, name: 'update-function-code', op: 'UpdateFunctionCode', bool: ['publish', 'dry-run'],
  run: (c, p) => configOut(L.updateFunctionCode(c, { FunctionName: need(p, 'FunctionName', 'function-name'), ZipFile: p.ZipFile, S3Bucket: p.S3Bucket, S3Key: p.S3Key, Publish: p.Publish }), L.snapOf(L.getFn(c, p.FunctionName).fn, '$LATEST')),
});
defineCommand({
  service: S, name: 'update-function-configuration', op: 'UpdateFunctionConfiguration', ...STRUCT,
  run: (c, p) => { const fn = L.updateFunctionConfiguration(c, { FunctionName: need(p, 'FunctionName', 'function-name'), Role: p.Role, Handler: p.Handler, Description: p.Description, Timeout: num(p.Timeout), MemorySize: num(p.MemorySize), Environment: p.Environment, Runtime: p.Runtime, DeadLetterConfig: p.DeadLetterConfig }); return cfg(fn); },
});
defineCommand({
  service: S, name: 'invoke', op: 'Invoke',
  run: (c, p, sh, pos) => {
    if (!pos[0]) throw new Error('aws: error: the following arguments are required: outfile');
    const payload = p.Payload !== undefined ? binaryIn(p, p.Payload) : undefined;
    const r = L.invoke(c, { FunctionName: need(p, 'FunctionName', 'function-name'), Qualifier: p.Qualifier, Payload: payload, InvocationType: p.InvocationType, LogType: p.LogType });
    if (pos[0] !== '/dev/null') sh.fs.writeFile(VFS.norm(pos[0], sh.cwd), r.payload);
    return strip({ StatusCode: r.statusCode, FunctionError: r.functionError, LogResult: r.logResult, ExecutedVersion: r.executedVersion });
  },
});
defineCommand({ service: S, name: 'publish-version', op: 'PublishVersion', run: (c, p) => { const v = L.publishVersion(c, { FunctionName: need(p, 'FunctionName', 'function-name'), Description: p.Description, CodeSha256: p.CodeSha256 }); return configOut(L.getFn(c, p.FunctionName).fn, v); } });
defineCommand({ service: S, name: 'list-versions-by-function', op: 'ListVersionsByFunction', run: (c, p) => { const { fn, snaps } = L.listVersions(c, { FunctionName: need(p, 'FunctionName', 'function-name') }); return { Versions: snaps.map((v) => configOut(fn, v)) }; } });

// ---------------------------------------------------------------- alias
defineCommand({ service: S, name: 'create-alias', op: 'CreateAlias', ...STRUCT, run: (c, p) => aliasOut(L.createAlias(c, { FunctionName: need(p, 'FunctionName', 'function-name'), Name: need(p, 'Name', 'name'), FunctionVersion: need(p, 'FunctionVersion', 'function-version'), Description: p.Description, RoutingConfig: normRouting(p.RoutingConfig) })) });
defineCommand({ service: S, name: 'get-alias', op: 'GetAlias', run: (c, p) => aliasOut(L.getAliasApi(c, { FunctionName: need(p, 'FunctionName', 'function-name'), Name: need(p, 'Name', 'name') })) });
defineCommand({ service: S, name: 'list-aliases', op: 'ListAliases', run: (c, p) => ({ Aliases: L.listAliases(c, { FunctionName: need(p, 'FunctionName', 'function-name'), FunctionVersion: p.FunctionVersion }).map(aliasOut) }) });
defineCommand({ service: S, name: 'update-alias', op: 'UpdateAlias', ...STRUCT, run: (c, p) => aliasOut(L.updateAlias(c, { FunctionName: need(p, 'FunctionName', 'function-name'), Name: need(p, 'Name', 'name'), FunctionVersion: p.FunctionVersion, Description: p.Description, RoutingConfig: normRouting(p.RoutingConfig) })) });
defineCommand({ service: S, name: 'delete-alias', op: 'DeleteAlias', run: (c, p) => void L.deleteAlias(c, { FunctionName: need(p, 'FunctionName', 'function-name'), Name: need(p, 'Name', 'name') }) });
/** --routing-config AdditionalVersionWeights={"2"=0.1} (los pesos llegan como texto en la sintaxis abreviada). */
function normRouting(r: any) {
  if (!r) return undefined;
  const w = r.AdditionalVersionWeights ?? {};
  return { AdditionalVersionWeights: Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Number(v)])) };
}

// ---------------------------------------------------------------- permisos, concurrencia, etiquetas
defineCommand({
  service: S, name: 'add-permission', op: 'AddPermission',
  run: (c, p) => ({ Statement: JSON.stringify(L.addPermission(c, { FunctionName: need(p, 'FunctionName', 'function-name'), StatementId: need(p, 'StatementId', 'statement-id'), Action: need(p, 'Action', 'action'), Principal: need(p, 'Principal', 'principal'), SourceArn: p.SourceArn, SourceAccount: p.SourceAccount, Qualifier: p.Qualifier, FunctionUrlAuthType: p.FunctionUrlAuthType })) }),
});
defineCommand({ service: S, name: 'remove-permission', op: 'RemovePermission', run: (c, p) => void L.removePermission(c, { FunctionName: need(p, 'FunctionName', 'function-name'), StatementId: need(p, 'StatementId', 'statement-id'), Qualifier: p.Qualifier }) });
defineCommand({ service: S, name: 'get-policy', op: 'GetPolicy', run: (c, p) => { const { fn, doc } = L.getPolicy(c, { FunctionName: need(p, 'FunctionName', 'function-name'), Qualifier: p.Qualifier }); return { Policy: JSON.stringify(doc), RevisionId: fn.revisionId }; } });
defineCommand({ service: S, name: 'put-function-concurrency', op: 'PutFunctionConcurrency', run: (c, p) => ({ ReservedConcurrentExecutions: L.putConcurrency(c, { FunctionName: need(p, 'FunctionName', 'function-name'), ReservedConcurrentExecutions: Number(need(p, 'ReservedConcurrentExecutions', 'reserved-concurrent-executions')) }) }) });
defineCommand({ service: S, name: 'delete-function-concurrency', op: 'DeleteFunctionConcurrency', run: (c, p) => void L.deleteConcurrency(c, { FunctionName: need(p, 'FunctionName', 'function-name') }) });
defineCommand({ service: S, name: 'get-function-concurrency', op: 'GetFunctionConcurrency', run: (c, p) => { const { fn } = L.getFn(c, need(p, 'FunctionName', 'function-name')); return fn.reservedConcurrency === undefined ? {} : { ReservedConcurrentExecutions: fn.reservedConcurrency }; } });
defineCommand({ service: S, name: 'tag-resource', op: 'TagResource', structured: ['tags'], run: (c, p) => void L.tagResource(c, { Resource: need(p, 'Resource', 'resource'), Tags: need(p, 'Tags', 'tags') }) });
defineCommand({ service: S, name: 'untag-resource', op: 'UntagResource', list: ['tag-keys'], run: (c, p) => void L.untagResource(c, { Resource: need(p, 'Resource', 'resource'), TagKeys: arr(need(p, 'TagKeys', 'tag-keys')) }) });
defineCommand({ service: S, name: 'list-tags', op: 'ListTags', run: (c, p) => ({ Tags: L.listTags(c, { Resource: need(p, 'Resource', 'resource') }) }) });

// ---------------------------------------------------------------- event source mappings
defineCommand({
  service: S, name: 'create-event-source-mapping', op: 'CreateEventSourceMapping', list: ['function-response-types'], bool: ['enabled'],
  run: (c, p) => mappingOut(L.createMapping(c, { FunctionName: need(p, 'FunctionName', 'function-name'), EventSourceArn: need(p, 'EventSourceArn', 'event-source-arn'), BatchSize: num(p.BatchSize), Enabled: p.Enabled, MaximumBatchingWindowInSeconds: num(p.MaximumBatchingWindowInSeconds), FunctionResponseTypes: p.FunctionResponseTypes }), true),
});
defineCommand({ service: S, name: 'list-event-source-mappings', op: 'ListEventSourceMappings', run: (c, p) => ({ EventSourceMappings: L.listMappings(c, { FunctionName: p.FunctionName, EventSourceArn: p.EventSourceArn }).map((m) => mappingOut(m)) }) });
defineCommand({ service: S, name: 'get-event-source-mapping', op: 'GetEventSourceMapping', run: (c, p) => mappingOut(L.getMapping(c, { UUID: need(p, 'Uuid', 'uuid') })) });
defineCommand({
  service: S, name: 'update-event-source-mapping', op: 'UpdateEventSourceMapping', list: ['function-response-types'], bool: ['enabled'],
  run: (c, p) => mappingOut(L.updateMapping(c, { UUID: need(p, 'Uuid', 'uuid'), Enabled: p.Enabled, BatchSize: num(p.BatchSize), MaximumBatchingWindowInSeconds: num(p.MaximumBatchingWindowInSeconds), FunctionResponseTypes: p.FunctionResponseTypes })),
});
defineCommand({ service: S, name: 'delete-event-source-mapping', op: 'DeleteEventSourceMapping', run: (c, p) => ({ ...mappingOut(L.deleteMapping(c, { UUID: need(p, 'Uuid', 'uuid') })), State: 'Deleting' }) });

// ---------------------------------------------------------------- URL de función
const urlOut = (fn: LambdaFn) => ({ FunctionUrl: fn.url!.url, FunctionArn: fn.arn, AuthType: fn.url!.authType, CreationTime: fn.url!.createdAt.replace('Z', '+0000') });
defineCommand({ service: S, name: 'create-function-url-config', op: 'CreateFunctionUrlConfig', run: (c, p) => urlOut(L.createUrl(c, { FunctionName: need(p, 'FunctionName', 'function-name'), AuthType: need(p, 'AuthType', 'auth-type') })) });
defineCommand({ service: S, name: 'get-function-url-config', op: 'GetFunctionUrlConfig', run: (c, p) => urlOut(L.getUrl(c, { FunctionName: need(p, 'FunctionName', 'function-name') })) });
defineCommand({ service: S, name: 'delete-function-url-config', op: 'DeleteFunctionUrlConfig', run: (c, p) => void L.deleteUrl(c, { FunctionName: need(p, 'FunctionName', 'function-name') }) });

// ---------------------------------------------------------------- wait
defineCommand({
  service: S, name: 'wait', op: 'Wait',
  run: async (c, p, _sh, pos) => {
    const w = pos[0];
    const ref = need(p, 'FunctionName', 'function-name') as string;
    const find = () => { try { return L.getFn(c, ref).fn; } catch { return undefined; } };
    if (w === 'function-active' || w === 'function-active-v2') await waitFor(c, 'FunctionActive', () => !!find() && L.fnState(find()!) === 'Active', () => (find() ? undefined : 'Function not found'));
    else if (w === 'function-updated' || w === 'function-updated-v2') await waitFor(c, 'FunctionUpdated', () => !!find(), () => (find() ? undefined : 'Function not found'));
    else if (w === 'function-exists') await waitFor(c, 'FunctionExists', () => !!find());
    else if (w === 'published-version-active') await waitFor(c, 'PublishedVersionActive', () => !!find());
    else throw new Error(`\nusage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\naws: error: argument operation: Invalid choice, valid choices are:\n\nfunction-active | function-active-v2 | function-exists | function-updated | function-updated-v2 | published-version-active`);
    return undefined;
  },
});
void sv; void BIN;

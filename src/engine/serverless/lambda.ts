// AWS Lambda: funciones con código JavaScript interpretado, versiones y alias, permisos de recurso, mappings de SQS,
// URLs de función e invocación con logs en CloudWatch Logs, métricas y rol de ejecución.
import { AwsError } from '../errors';
import { trailed, getRole, type Ctx, type Caller } from '../api';
import type { CloudState } from '../types';
import { guid, hex, now, nowIso, wildcardMatch } from '../util';
import { emitMetric } from '../services/cloudwatch';
import { assumedCaller, roleDenial, trustsService, unpackBundle, writeLog } from '../services/cicdCommon';
import * as sns from '../services/sns';
import { sv, type EventSourceMapping, type LambdaAlias, type LambdaFn, type LambdaVersionSnap } from './types';
import { svAuthorize, roleOf, md5, fakeSha256b64, lambdaTime, asArr, b64 } from './util';
import { Interp, LambdaThrow, isTimeout, parse, type AwsHost } from './js';
import { bridge } from './bridge';
import { speedFactor } from '../store';
import * as sqs from './sqs';
import * as ddb from './dynamodb';

const SRC = 'lambda.amazonaws.com';
export const RUNTIMES = ['nodejs18.x', 'nodejs20.x', 'nodejs22.x'];
const OTHER_RUNTIMES = ['python3.9', 'python3.10', 'python3.11', 'python3.12', 'python3.13', 'java17', 'java21', 'dotnet8', 'ruby3.3', 'provided.al2023', 'go1.x', 'nodejs16.x', 'nodejs14.x'];
const RESERVED_ENV = ['_HANDLER', 'AWS_REGION', 'AWS_EXECUTION_ENV', 'AWS_LAMBDA_FUNCTION_NAME', 'AWS_LAMBDA_FUNCTION_MEMORY_SIZE', 'AWS_LAMBDA_FUNCTION_VERSION', 'AWS_LAMBDA_LOG_GROUP_NAME', 'AWS_LAMBDA_LOG_STREAM_NAME', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_LAMBDA_RUNTIME_API', 'LAMBDA_TASK_ROOT', 'LAMBDA_RUNTIME_DIR'];
const ARN_FN = (region: string, acct: string, name: string, q?: string) => `arn:aws:lambda:${region}:${acct}:function:${name}${q ? ':' + q : ''}`;
const rev = () => guid();

const conflict = (m: string) => new AwsError('ResourceConflictException', m, 409);
const invalidP = (m: string) => new AwsError('InvalidParameterValueException', m, 400);
const val = (m: string) => new AwsError('ValidationException', m, 400);

// ------------------------------------------------------------------ resolución

export interface Ref { fn: LambdaFn; qualifier?: string }
export function parseRef(ctx: Ctx, ref: string, qualifier?: string): { name: string; qualifier?: string; region: string } {
  let r = ref ?? '', region = ctx.region;
  const m = /^arn:aws[a-z-]*:lambda:([a-z0-9-]+):(\d{12}):function:([^:]+)(?::(.+))?$/.exec(r);
  if (m) { region = m[1]; return { name: m[3], qualifier: qualifier ?? m[4], region }; }
  const m2 = /^(\d{12}):function:([^:]+)(?::(.+))?$/.exec(r);
  if (m2) return { name: m2[2], qualifier: qualifier ?? m2[3], region };
  if (r.startsWith('arn:')) throw val(`1 validation error detected: Value '${r}' at 'functionName' failed to satisfy constraint: Member must satisfy regular expression pattern: (arn:(aws[a-zA-Z-]*)?:lambda:)?([a-z]{2}(-gov)?-[a-z]+-\\d{1}:)?(\\d{12}:)?(function:)?([a-zA-Z0-9-_]+)(:(\\$LATEST|[a-zA-Z0-9-_]+))?`);
  const parts = r.split(':');
  r = parts[0];
  if (!/^[a-zA-Z0-9-_]{1,64}$/.test(r)) throw val(`1 validation error detected: Value '${ref}' at 'functionName' failed to satisfy constraint: Member must satisfy regular expression pattern: (arn:(aws[a-zA-Z-]*)?:lambda:)?([a-z]{2}(-gov)?-[a-z]+-\\d{1}:)?(\\d{12}:)?(function:)?([a-zA-Z0-9-_]+)(:(\\$LATEST|[a-zA-Z0-9-_]+))?`);
  return { name: r, qualifier: qualifier ?? parts[1], region };
}
const notFound = (ctx: Ctx, name: string, region: string, q?: string) => new AwsError('ResourceNotFoundException', `Function not found: ${ARN_FN(region, ctx.s.account.id, name, q)}`, 404);

export function fnByName(s: CloudState, region: string, name: string): LambdaFn | undefined {
  return sv(s).lambdas.find((f) => f.name === name && f.region === region);
}
export function getFn(ctx: Ctx, ref: string, qualifier?: string): Ref {
  const p = parseRef(ctx, ref, qualifier);
  const fn = fnByName(ctx.s, p.region, p.name);
  if (!fn) throw notFound(ctx, p.name, p.region, p.qualifier);
  if (p.qualifier && p.qualifier !== '$LATEST' && !fn.aliases.some((a) => a.name === p.qualifier) && !fn.versions.some((v) => v.version === p.qualifier)) throw notFound(ctx, p.name, p.region, p.qualifier);
  return { fn, qualifier: p.qualifier };
}

const latest = (fn: LambdaFn): LambdaVersionSnap => ({ version: '$LATEST', description: fn.description, codeSha256: fn.codeSha256, codeSize: fn.codeSize, lastModified: fn.lastModified, handler: fn.handler, runtime: fn.runtime, role: fn.role, timeout: fn.timeout, memory: fn.memory, env: fn.env, files: fn.files });
export function snapOf(fn: LambdaFn, version: string): LambdaVersionSnap { return version === '$LATEST' ? latest(fn) : fn.versions.find((v) => v.version === version)!; }

/** Qué versión ejecuta un calificador (versión, alias con enrutamiento ponderado o $LATEST). */
export function resolveVersion(fn: LambdaFn, qualifier?: string): string {
  if (!qualifier || qualifier === '$LATEST') return '$LATEST';
  const a = fn.aliases.find((x) => x.name === qualifier);
  if (!a) return qualifier;
  const extra = Object.entries(a.routing ?? {});
  if (!extra.length) return a.version;
  a.hits = (a.hits ?? 0) + 1;
  const slot = (a.hits - 1) % 100;
  let acc = 0;
  for (const [v, w] of extra) { acc += Math.round(w * 100); if (slot < acc) return v; }
  return a.version;
}

// ------------------------------------------------------------------ código

function loadCode(ctx: Ctx, code: { ZipFile?: string; S3Bucket?: string; S3Key?: string }): Record<string, string> {
  let body: string | undefined;
  if (code.ZipFile !== undefined) body = String(code.ZipFile);
  else if (code.S3Bucket) {
    const b = ctx.s.buckets.find((x) => x.name === code.S3Bucket);
    if (!b) throw invalidP(`Error occurred while GetObject. S3 Error Code: NoSuchBucket. S3 Error Message: The specified bucket does not exist`);
    const o = b.objects[code.S3Key ?? ''];
    if (!o) throw invalidP(`Error occurred while GetObject. S3 Error Code: NoSuchKey. S3 Error Message: The specified key does not exist.`);
    body = o.body;
  } else throw invalidP('Please provide a source for function code.');
  const files = unpackBundle(body.replace('\u0000fileb\u0000', ''));
  if (!files || !Object.keys(files).length) throw invalidP('Could not unzip uploaded file. Please check your file, then try to upload again.');
  return files;
}
const sizeOf = (files: Record<string, string>) => Object.values(files).reduce((n, f) => n + new TextEncoder().encode(f).length, 0) + 150;
const shaOf = (files: Record<string, string>) => fakeSha256b64(JSON.stringify(files));

function validateEnv(env: Record<string, string> | undefined) {
  const bad = Object.keys(env ?? {}).filter((k) => RESERVED_ENV.includes(k));
  if (bad.length) throw invalidP(`Lambda was unable to configure your environment variables because the environment variables you have provided contains reserved keys that are currently not supported for modification. Reserved keys used in this request: ${bad.join(', ')}`);
  for (const [k, v] of Object.entries(env ?? {})) {
    if (!/^[a-zA-Z]([a-zA-Z0-9_])+$/.test(k)) throw val(`1 validation error detected: Value '{${k}=${v}}' at 'environment.variables' failed to satisfy constraint: Map keys must satisfy constraint: [Member must have length greater than or equal to 2, Member must have length less than or equal to 255, Member must satisfy regular expression pattern: [a-zA-Z]([a-zA-Z0-9_])+]`);
  }
}
function checkRole(ctx: Ctx, arn: string) {
  const role = roleOf(ctx.s, arn ?? '');
  if (!role || !trustsService(role, 'lambda.amazonaws.com')) throw invalidP('The role defined for the function cannot be assumed by Lambda.');
}
function checkSizes(p: { Timeout?: number; MemorySize?: number }) {
  if (p.Timeout !== undefined) {
    if (p.Timeout > 900) throw val(`1 validation error detected: Value '${p.Timeout}' at 'timeout' failed to satisfy constraint: Member must have value less than or equal to 900`);
    if (p.Timeout < 1) throw val(`1 validation error detected: Value '${p.Timeout}' at 'timeout' failed to satisfy constraint: Member must have value greater than or equal to 1`);
  }
  if (p.MemorySize !== undefined) {
    if (p.MemorySize < 128) throw val(`1 validation error detected: Value '${p.MemorySize}' at 'memorySize' failed to satisfy constraint: Member must have value greater than or equal to 128`);
    if (p.MemorySize > 10240) throw val(`1 validation error detected: Value '${p.MemorySize}' at 'memorySize' failed to satisfy constraint: Member must have value less than or equal to 10240`);
  }
}
function checkRuntime(rt: string) {
  if (RUNTIMES.includes(rt)) return;
  if (OTHER_RUNTIMES.includes(rt)) throw invalidP(`Este simulador solo ejecuta runtimes ${RUNTIMES.join(', ')} (código JavaScript interpretado); ${rt} no está disponible.`);
  throw val(`1 validation error detected: Value '${rt}' at 'runtime' failed to satisfy constraint: Member must satisfy enum value set: [${[...RUNTIMES, ...OTHER_RUNTIMES].sort().join(', ')}]`);
}

// ------------------------------------------------------------------ CRUD

/** Una función recién creada está `Pending` unos instantes (no se puede invocar hasta que pasa a `Active`). */
export const fnState = (fn: LambdaFn): 'Pending' | 'Active' => (now() - fn.createdAt < Math.round(1500 * speedFactor()) ? 'Pending' : 'Active');
const pendingErr = () => conflict('The operation cannot be performed at this time. The function is currently in the following state: Pending');

export function createFunction(ctx: Ctx, p: { FunctionName: string; Runtime: string; Role: string; Handler: string; Code: { ZipFile?: string; S3Bucket?: string; S3Key?: string }; Description?: string; Timeout?: number; MemorySize?: number; Environment?: { Variables?: Record<string, string> }; Publish?: boolean; Tags?: Record<string, string>; DeadLetterConfig?: { TargetArn?: string }; PackageType?: string }): LambdaFn {
  return trailed(ctx, SRC, 'CreateFunction20150331', [{ type: 'AWS::Lambda::Function', name: p.FunctionName }], { functionName: p.FunctionName, runtime: p.Runtime, role: p.Role, handler: p.Handler }, () => {
    const name = parseRef(ctx, p.FunctionName).name;
    svAuthorize(ctx, 'lambda:CreateFunction', ARN_FN(ctx.region, ctx.s.account.id, name), 'json');
    if (p.FunctionName.includes(':')) throw val(`1 validation error detected: Value '${p.FunctionName}' at 'functionName' failed to satisfy constraint: Member must satisfy regular expression pattern: (arn:(aws[a-zA-Z-]*)?:lambda:)?([a-z]{2}(-gov)?-[a-z]+-\\d{1}:)?(\\d{12}:)?(function:)?([a-zA-Z0-9-_\\.]+)(:(\\$LATEST|[a-zA-Z0-9-_]+))?`.replace('(arn', '(arn'));
    if (!p.Runtime) throw invalidP('Runtime and Handler are required for Zip package type.'.replace('Runtime and Handler are required for Zip package type.', 'Runtime and Handler are required when PackageType is Zip'));
    checkRuntime(p.Runtime);
    checkSizes(p);
    validateEnv(p.Environment?.Variables);
    if (fnByName(ctx.s, ctx.region, name)) throw conflict(`Function already exist: ${name}`);
    checkRole(ctx, p.Role);
    const files = loadCode(ctx, p.Code ?? {});
    const t = now();
    const fn: LambdaFn = {
      name, arn: ARN_FN(ctx.region, ctx.s.account.id, name), region: ctx.region, runtime: p.Runtime, handler: p.Handler, role: p.Role, description: p.Description ?? '', timeout: p.Timeout ?? 3, memory: p.MemorySize ?? 128,
      env: { ...(p.Environment?.Variables ?? {}) }, files, codeSha256: shaOf(files), codeSize: sizeOf(files), lastModified: lambdaTime(t), createdAt: t, versions: [], nextVersion: 1, aliases: [], permissions: [], tags: { ...(p.Tags ?? {}) },
      deadLetterArn: p.DeadLetterConfig?.TargetArn, revisionId: rev(), stats: { invocations: 0, errors: 0, throttles: 0 },
    };
    sv(ctx.s).lambdas.push(fn);
    if (p.Publish) publish(fn, p.Description);
    return fn;
  });
}

function publish(fn: LambdaFn, description?: string): LambdaVersionSnap {
  const last = fn.versions[fn.versions.length - 1];
  const cfg = (v: LambdaVersionSnap | ReturnType<typeof latest>) => JSON.stringify([v.codeSha256, v.handler, v.runtime, v.role, v.timeout, v.memory, v.env, v.description]);
  const cur = latest(fn);
  if (description !== undefined) cur.description = description;
  if (last && cfg(last) === cfg(cur)) return last;
  const snap: LambdaVersionSnap = { ...cur, version: String(fn.nextVersion++), files: { ...fn.files }, env: { ...fn.env }, lastModified: lambdaTime(now()) };
  fn.versions.push(snap);
  fn.revisionId = rev();
  return snap;
}

export function getFunction(ctx: Ctx, p: { FunctionName: string; Qualifier?: string }): { fn: LambdaFn; snap: LambdaVersionSnap } {
  return trailed(ctx, SRC, 'GetFunction20150331v2', [], { functionName: p.FunctionName, qualifier: p.Qualifier }, () => {
    const { fn, qualifier } = getFn(ctx, p.FunctionName, p.Qualifier);
    svAuthorize(ctx, 'lambda:GetFunction', fn.arn + (qualifier ? ':' + qualifier : ''), 'json');
    const v = qualifier ? (fn.aliases.find((a) => a.name === qualifier)?.version ?? qualifier) : '$LATEST';
    return { fn, snap: snapOf(fn, v) };
  });
}
export function getFunctionConfiguration(ctx: Ctx, p: { FunctionName: string; Qualifier?: string }) {
  return trailed(ctx, SRC, 'GetFunctionConfiguration20150331v2', [], { functionName: p.FunctionName }, () => {
    const { fn, qualifier } = getFn(ctx, p.FunctionName, p.Qualifier);
    svAuthorize(ctx, 'lambda:GetFunctionConfiguration', fn.arn + (qualifier ? ':' + qualifier : ''), 'json');
    const v = qualifier ? (fn.aliases.find((a) => a.name === qualifier)?.version ?? qualifier) : '$LATEST';
    return { fn, snap: snapOf(fn, v) };
  });
}
export function listFunctions(ctx: Ctx): LambdaFn[] {
  return trailed(ctx, SRC, 'ListFunctions20150331', [], {}, () => {
    svAuthorize(ctx, 'lambda:ListFunctions', '*', 'json');
    return sv(ctx.s).lambdas.filter((f) => f.region === ctx.region);
  });
}
export function deleteFunction(ctx: Ctx, p: { FunctionName: string; Qualifier?: string }): void {
  trailed(ctx, SRC, 'DeleteFunction20150331', [{ type: 'AWS::Lambda::Function', name: p.FunctionName }], { functionName: p.FunctionName, qualifier: p.Qualifier }, () => {
    const { fn, qualifier } = getFn(ctx, p.FunctionName, p.Qualifier);
    svAuthorize(ctx, 'lambda:DeleteFunction', fn.arn + (qualifier ? ':' + qualifier : ''), 'json');
    if (qualifier) {
      if (qualifier === '$LATEST') throw invalidP('Cannot delete the $LATEST version. Use the function name without a qualifier to delete the function.');
      if (fn.aliases.some((a) => a.name === qualifier)) throw invalidP(`Please use the DeleteAlias API to delete an alias (${qualifier}).`.replace('Please use the DeleteAlias API to delete an alias', 'Unable to delete a version referenced by an alias; delete alias'));
      if (fn.aliases.some((a) => a.version === qualifier)) throw conflict(`Unable to delete version ${qualifier} because the following aliases reference it: ${fn.aliases.filter((a) => a.version === qualifier).map((a) => a.name).join(', ')}`);
      fn.versions = fn.versions.filter((v) => v.version !== qualifier);
      return;
    }
    sv(ctx.s).lambdas = sv(ctx.s).lambdas.filter((f) => f !== fn);
    sv(ctx.s).mappings = sv(ctx.s).mappings.filter((m) => m.functionName !== fn.name || m.region !== fn.region);
  });
}

export function updateFunctionCode(ctx: Ctx, p: { FunctionName: string; ZipFile?: string; S3Bucket?: string; S3Key?: string; Publish?: boolean; DryRun?: boolean }): LambdaFn {
  return trailed(ctx, SRC, 'UpdateFunctionCode20150331v2', [{ type: 'AWS::Lambda::Function', name: p.FunctionName }], { functionName: p.FunctionName }, () => {
    const { fn } = getFn(ctx, p.FunctionName);
    svAuthorize(ctx, 'lambda:UpdateFunctionCode', fn.arn, 'json');
    const files = loadCode(ctx, p);
    fn.files = files; fn.codeSha256 = shaOf(files); fn.codeSize = sizeOf(files); fn.lastModified = lambdaTime(now()); fn.revisionId = rev();
    fn.stats.streamKey = undefined;
    if (p.Publish) publish(fn);
    return fn;
  });
}
export function updateFunctionConfiguration(ctx: Ctx, p: { FunctionName: string; Role?: string; Handler?: string; Description?: string; Timeout?: number; MemorySize?: number; Environment?: { Variables?: Record<string, string> }; Runtime?: string; DeadLetterConfig?: { TargetArn?: string } }): LambdaFn {
  return trailed(ctx, SRC, 'UpdateFunctionConfiguration20150331v2', [{ type: 'AWS::Lambda::Function', name: p.FunctionName }], { functionName: p.FunctionName }, () => {
    const { fn } = getFn(ctx, p.FunctionName);
    svAuthorize(ctx, 'lambda:UpdateFunctionConfiguration', fn.arn, 'json');
    checkSizes(p);
    if (p.Runtime) { checkRuntime(p.Runtime); fn.runtime = p.Runtime; }
    if (p.Environment) { validateEnv(p.Environment.Variables); fn.env = { ...(p.Environment.Variables ?? {}) }; }
    if (p.Role) { checkRole(ctx, p.Role); fn.role = p.Role; }
    if (p.Handler !== undefined) fn.handler = p.Handler;
    if (p.Description !== undefined) fn.description = p.Description;
    if (p.Timeout !== undefined) fn.timeout = Number(p.Timeout);
    if (p.MemorySize !== undefined) fn.memory = Number(p.MemorySize);
    if (p.DeadLetterConfig) fn.deadLetterArn = p.DeadLetterConfig.TargetArn;
    fn.lastModified = lambdaTime(now()); fn.revisionId = rev(); fn.stats.streamKey = undefined;
    return fn;
  });
}
export function publishVersion(ctx: Ctx, p: { FunctionName: string; Description?: string; CodeSha256?: string }): LambdaVersionSnap {
  return trailed(ctx, SRC, 'PublishVersion20150331', [{ type: 'AWS::Lambda::Function', name: p.FunctionName }], { functionName: p.FunctionName }, () => {
    const { fn } = getFn(ctx, p.FunctionName);
    svAuthorize(ctx, 'lambda:PublishVersion', fn.arn, 'json');
    if (p.CodeSha256 && p.CodeSha256 !== fn.codeSha256) throw new AwsError('PreconditionFailedException', `CodeSHA256 (${p.CodeSha256}) is different from current CodeSHA256 in $LATEST (${fn.codeSha256}). Please try again with the CodeSHA256 in $LATEST.`, 412);
    return publish(fn, p.Description);
  });
}
export function listVersions(ctx: Ctx, p: { FunctionName: string }) {
  return trailed(ctx, SRC, 'ListVersionsByFunction20150331', [], { functionName: p.FunctionName }, () => {
    const { fn } = getFn(ctx, p.FunctionName);
    svAuthorize(ctx, 'lambda:ListVersionsByFunction', fn.arn, 'json');
    return { fn, snaps: [latest(fn), ...fn.versions] };
  });
}

// ------------------------------------------------------------------ alias
const aliasArn = (fn: LambdaFn, n: string) => `${fn.arn}:${n}`;
function aliasChecks(fn: LambdaFn, version: string, routing?: Record<string, number>) {
  if (version !== '$LATEST' && !fn.versions.some((v) => v.version === version)) throw new AwsError('ResourceNotFoundException', `Function not found: ${fn.arn}:${version}`, 404);
  for (const [v, w] of Object.entries(routing ?? {})) {
    if (!fn.versions.some((x) => x.version === v)) throw new AwsError('ResourceNotFoundException', `Function not found: ${fn.arn}:${v}`, 404);
    if (!(w >= 0 && w <= 1)) throw val(`1 validation error detected: Value '${w}' at 'routingConfig.additionalVersionWeights' failed to satisfy constraint: Map value must satisfy constraint: [Member must have value less than or equal to 1.0, Member must have value greater than or equal to 0.0]`);
  }
}
export function createAlias(ctx: Ctx, p: { FunctionName: string; Name: string; FunctionVersion: string; Description?: string; RoutingConfig?: { AdditionalVersionWeights?: Record<string, number> } }): LambdaAlias {
  return trailed(ctx, SRC, 'CreateAlias20150331', [], { functionName: p.FunctionName, name: p.Name, functionVersion: p.FunctionVersion }, () => {
    const { fn } = getFn(ctx, p.FunctionName);
    svAuthorize(ctx, 'lambda:CreateAlias', fn.arn, 'json');
    if (!/^(?!^[0-9]+$)([a-zA-Z0-9-_]+)$/.test(p.Name ?? '')) throw val(`1 validation error detected: Value '${p.Name}' at 'name' failed to satisfy constraint: Member must satisfy regular expression pattern: (?!^[0-9]+$)([a-zA-Z0-9-_]+)`);
    if (fn.aliases.some((a) => a.name === p.Name)) throw conflict(`Alias already exists: ${aliasArn(fn, p.Name)}`);
    const w = p.RoutingConfig?.AdditionalVersionWeights;
    aliasChecks(fn, p.FunctionVersion, w);
    const a: LambdaAlias = { name: p.Name, arn: aliasArn(fn, p.Name), version: p.FunctionVersion, description: p.Description ?? '', routing: w && Object.keys(w).length ? w : undefined, revisionId: rev() };
    fn.aliases.push(a);
    return a;
  });
}
function getAlias(ctx: Ctx, fnRef: string, name: string) {
  const { fn } = getFn(ctx, fnRef);
  const a = fn.aliases.find((x) => x.name === name);
  if (!a) throw new AwsError('ResourceNotFoundException', `Cannot find alias arn: ${aliasArn(fn, name)}`, 404);
  return { fn, a };
}
export function getAliasApi(ctx: Ctx, p: { FunctionName: string; Name: string }) {
  return trailed(ctx, SRC, 'GetAlias20150331', [], p, () => { const r = getAlias(ctx, p.FunctionName, p.Name); svAuthorize(ctx, 'lambda:GetAlias', r.a.arn, 'json'); return r.a; });
}
export function listAliases(ctx: Ctx, p: { FunctionName: string; FunctionVersion?: string }) {
  return trailed(ctx, SRC, 'ListAliases20150331', [], p, () => { const { fn } = getFn(ctx, p.FunctionName); svAuthorize(ctx, 'lambda:ListAliases', fn.arn, 'json'); return fn.aliases.filter((a) => !p.FunctionVersion || a.version === p.FunctionVersion); });
}
export function updateAlias(ctx: Ctx, p: { FunctionName: string; Name: string; FunctionVersion?: string; Description?: string; RoutingConfig?: { AdditionalVersionWeights?: Record<string, number> } }) {
  return trailed(ctx, SRC, 'UpdateAlias20150331', [], p, () => {
    const { fn, a } = getAlias(ctx, p.FunctionName, p.Name);
    svAuthorize(ctx, 'lambda:UpdateAlias', a.arn, 'json');
    const ver = p.FunctionVersion ?? a.version;
    const w = p.RoutingConfig ? (p.RoutingConfig.AdditionalVersionWeights ?? {}) : a.routing;
    aliasChecks(fn, ver, w);
    a.version = ver; if (p.Description !== undefined) a.description = p.Description;
    if (p.RoutingConfig) a.routing = w && Object.keys(w).length ? w : undefined;
    a.revisionId = rev();
    return a;
  });
}
export function deleteAlias(ctx: Ctx, p: { FunctionName: string; Name: string }) {
  trailed(ctx, SRC, 'DeleteAlias20150331', [], p, () => { const { fn, a } = getAlias(ctx, p.FunctionName, p.Name); svAuthorize(ctx, 'lambda:DeleteAlias', a.arn, 'json'); fn.aliases = fn.aliases.filter((x) => x !== a); });
}

// ------------------------------------------------------------------ permisos (política de recurso)
export function permissionStatement(fn: LambdaFn, p: LambdaFn['permissions'][number]) {
  const principal = p.principal === '*' ? '*' : /^\d{12}$/.test(p.principal) ? { AWS: `arn:aws:iam::${p.principal}:root` } : p.principal.startsWith('arn:') ? { AWS: p.principal } : { Service: p.principal };
  const cond: any = {};
  if (p.sourceArn) cond.ArnLike = { 'AWS:SourceArn': p.sourceArn };
  if (p.sourceAccount) cond.StringEquals = { 'AWS:SourceAccount': p.sourceAccount };
  if (p.urlAuthType) cond.StringEquals = { ...(cond.StringEquals ?? {}), 'lambda:FunctionUrlAuthType': p.urlAuthType };
  return { Sid: p.sid, Effect: 'Allow', Principal: principal, Action: p.action, Resource: p.qualifier ? `${fn.arn}:${p.qualifier}` : fn.arn, ...(Object.keys(cond).length ? { Condition: cond } : {}) };
}
export function addPermission(ctx: Ctx, p: { FunctionName: string; StatementId: string; Action: string; Principal: string; SourceArn?: string; SourceAccount?: string; Qualifier?: string; FunctionUrlAuthType?: string }) {
  return trailed(ctx, SRC, 'AddPermission20150331v2', [{ type: 'AWS::Lambda::Function', name: p.FunctionName }], { functionName: p.FunctionName, statementId: p.StatementId, action: p.Action, principal: p.Principal, sourceArn: p.SourceArn }, () => {
    const { fn, qualifier } = getFn(ctx, p.FunctionName, p.Qualifier);
    svAuthorize(ctx, 'lambda:AddPermission', fn.arn + (qualifier ? ':' + qualifier : ''), 'json');
    if (!/^[a-zA-Z0-9-_]+$/.test(p.StatementId ?? '')) throw val(`1 validation error detected: Value '${p.StatementId}' at 'statementId' failed to satisfy constraint: Member must satisfy regular expression pattern: ([a-zA-Z0-9-_]+)`);
    if (!/^lambda:(\*|[A-Za-z]+)$/.test(p.Action ?? '')) throw val(`1 validation error detected: Value '${p.Action}' at 'action' failed to satisfy constraint: Member must satisfy regular expression pattern: (lambda:[*]|lambda:[a-zA-Z]+|[*])`);
    if (fn.permissions.some((x) => x.sid === p.StatementId)) throw conflict(`The statement id (${p.StatementId}) provided already exists. Please provide a new statement id, or remove the existing statement.`);
    const perm = { sid: p.StatementId, action: p.Action, principal: p.Principal, sourceArn: p.SourceArn, sourceAccount: p.SourceAccount, qualifier, urlAuthType: p.FunctionUrlAuthType };
    fn.permissions.push(perm);
    fn.revisionId = rev();
    return permissionStatement(fn, perm);
  });
}
export function removePermission(ctx: Ctx, p: { FunctionName: string; StatementId: string; Qualifier?: string }) {
  trailed(ctx, SRC, 'RemovePermission20150331v2', [{ type: 'AWS::Lambda::Function', name: p.FunctionName }], p, () => {
    const { fn } = getFn(ctx, p.FunctionName, p.Qualifier);
    svAuthorize(ctx, 'lambda:RemovePermission', fn.arn, 'json');
    if (!fn.permissions.some((x) => x.sid === p.StatementId)) throw new AwsError('ResourceNotFoundException', `No policy is associated with the given resource.`.replace('No policy is associated with the given resource.', fn.permissions.length ? `Statement ${p.StatementId} is not found in resource policy.` : 'No policy is associated with the given resource.'), 404);
    fn.permissions = fn.permissions.filter((x) => x.sid !== p.StatementId);
  });
}
export function getPolicy(ctx: Ctx, p: { FunctionName: string; Qualifier?: string }) {
  return trailed(ctx, SRC, 'GetPolicy20150331v2', [], p, () => {
    const { fn } = getFn(ctx, p.FunctionName, p.Qualifier);
    svAuthorize(ctx, 'lambda:GetPolicy', fn.arn, 'json');
    if (!fn.permissions.length) throw new AwsError('ResourceNotFoundException', 'The resource you requested does not exist.', 404);
    return { fn, doc: { Version: '2012-10-17', Id: 'default', Statement: fn.permissions.map((x) => permissionStatement(fn, x)) } };
  });
}
/** ¿Puede este principal de servicio invocar la función? (resource-based policy) */
export function permitted(fn: LambdaFn, principal: string, sourceArn?: string, action = 'lambda:InvokeFunction', sourceAccount?: string): boolean {
  return fn.permissions.some((x) => (x.principal === '*' || x.principal === principal) && (wildcardMatch(x.action, action, true) || x.action === 'lambda:*') && (!x.sourceArn || (!!sourceArn && wildcardMatch(x.sourceArn, sourceArn))) && (!x.sourceAccount || x.sourceAccount === sourceAccount));
}

// ------------------------------------------------------------------ concurrencia, etiquetas, URL
export function putConcurrency(ctx: Ctx, p: { FunctionName: string; ReservedConcurrentExecutions: number }) {
  return trailed(ctx, SRC, 'PutFunctionConcurrency20171031', [], p, () => { const { fn } = getFn(ctx, p.FunctionName); svAuthorize(ctx, 'lambda:PutFunctionConcurrency', fn.arn, 'json'); const n = Number(p.ReservedConcurrentExecutions); if (n < 0) throw val(`1 validation error detected: Value '${n}' at 'reservedConcurrentExecutions' failed to satisfy constraint: Member must have value greater than or equal to 0`); fn.reservedConcurrency = n; return n; });
}
export function deleteConcurrency(ctx: Ctx, p: { FunctionName: string }) {
  trailed(ctx, SRC, 'DeleteFunctionConcurrency20171031', [], p, () => { const { fn } = getFn(ctx, p.FunctionName); svAuthorize(ctx, 'lambda:DeleteFunctionConcurrency', fn.arn, 'json'); fn.reservedConcurrency = undefined; });
}
export function tagResource(ctx: Ctx, p: { Resource: string; Tags: Record<string, string> }) {
  trailed(ctx, SRC, 'TagResource20170331v2', [], { resource: p.Resource }, () => { const { fn } = getFn(ctx, p.Resource); svAuthorize(ctx, 'lambda:TagResource', fn.arn, 'json'); Object.assign(fn.tags, p.Tags); });
}
export function untagResource(ctx: Ctx, p: { Resource: string; TagKeys: string[] }) {
  trailed(ctx, SRC, 'UntagResource20170331v2', [], { resource: p.Resource }, () => { const { fn } = getFn(ctx, p.Resource); svAuthorize(ctx, 'lambda:UntagResource', fn.arn, 'json'); for (const k of p.TagKeys) delete fn.tags[k]; });
}
export function listTags(ctx: Ctx, p: { Resource: string }) {
  return trailed(ctx, SRC, 'ListTags20170331v2', [], { resource: p.Resource }, () => { const { fn } = getFn(ctx, p.Resource); svAuthorize(ctx, 'lambda:ListTags', fn.arn, 'json'); return fn.tags; });
}
export function createUrl(ctx: Ctx, p: { FunctionName: string; AuthType: string }) {
  return trailed(ctx, SRC, 'CreateFunctionUrlConfig', [{ type: 'AWS::Lambda::Function', name: p.FunctionName }], p, () => {
    const { fn } = getFn(ctx, p.FunctionName);
    svAuthorize(ctx, 'lambda:CreateFunctionUrlConfig', fn.arn, 'json');
    if (!['NONE', 'AWS_IAM'].includes(p.AuthType)) throw val(`1 validation error detected: Value '${p.AuthType}' at 'authType' failed to satisfy constraint: Member must satisfy enum value set: [NONE, AWS_IAM]`);
    if (fn.url) throw conflict(`FunctionUrlConfig exists for this Lambda function`);
    const id = hex(32);
    fn.url = { id, url: `https://${id}.lambda-url.${fn.region}.on.aws/`, authType: p.AuthType as 'NONE', createdAt: nowIso() };
    return fn;
  });
}
export function getUrl(ctx: Ctx, p: { FunctionName: string }) {
  return trailed(ctx, SRC, 'GetFunctionUrlConfig', [], p, () => { const { fn } = getFn(ctx, p.FunctionName); svAuthorize(ctx, 'lambda:GetFunctionUrlConfig', fn.arn, 'json'); if (!fn.url) throw new AwsError('ResourceNotFoundException', 'The resource you requested does not exist.', 404); return fn; });
}
export function deleteUrl(ctx: Ctx, p: { FunctionName: string }) {
  trailed(ctx, SRC, 'DeleteFunctionUrlConfig', [], p, () => { const { fn } = getFn(ctx, p.FunctionName); svAuthorize(ctx, 'lambda:DeleteFunctionUrlConfig', fn.arn, 'json'); if (!fn.url) throw new AwsError('ResourceNotFoundException', 'The resource you requested does not exist.', 404); fn.url = undefined; });
}

// ------------------------------------------------------------------ ejecución

export interface ExecResult { requestId: string; ok: boolean; payload: string; value?: any; errorType?: string; errorMessage?: string; trace?: string[]; durationMs: number; billedMs: number; logText: string; timedOut: boolean }

function hostFor(s: CloudState, region: string, fn: LambdaFn, snap: LambdaVersionSnap, depth: number): AwsHost {
  return {
    call(service, op, params) {
      const role = roleOf(s, snap.role);
      if (!role) throw Object.assign(new Error('The role defined for the function cannot be assumed by Lambda.'), { name: 'AccessDeniedException' });
      const ctx: Ctx = { s, region, caller: assumedCaller(s, role, fn.name) };
      try {
        switch (service) {
          case 'dynamodb': { const f = (ddb as any)[op]; return JSON.parse(JSON.stringify(f(ctx, params) ?? {})); }
          case 'sqs':
            if (op === 'sendMessage') { const r = sqs.sendMessage(ctx, params); return { MessageId: r.m.id, MD5OfMessageBody: r.m.md5 }; }
            if (op === 'sendMessageBatch') { const r = sqs.sendMessageBatch(ctx, params); return { Successful: r.ok.map((x) => ({ Id: x.Id, MessageId: x.m.id, MD5OfMessageBody: x.m.md5 })), Failed: r.failed }; }
            if (op === 'receiveMessage') { const r = sqs.receiveMessage(ctx, params); return { Messages: r.msgs.map((m) => sqs.messageOut(r.q, m, ['All'], ['All'])) }; }
            if (op === 'deleteMessage') { sqs.deleteMessage(ctx, params); return {}; }
            break;
          case 'sns': return { MessageId: sns.publish(ctx, { TopicArn: params.TopicArn, Message: params.Message, Subject: params.Subject }) };
          case 'lambda': {
            if (depth >= 4) throw new AwsError('TooManyRequestsException', 'Rate Exceeded.', 429);
            const r = invokeCore(ctx, { FunctionName: params.FunctionName, Payload: typeof params.Payload === 'string' ? params.Payload : JSON.stringify(params.Payload ?? {}), InvocationType: params.InvocationType, Qualifier: params.Qualifier }, depth + 1);
            return { StatusCode: r.statusCode, ...(r.functionError ? { FunctionError: r.functionError } : {}), Payload: r.payload };
          }
        }
      } catch (e) {
        if (e instanceof AwsError) throw Object.assign(new Error(e.message), { name: e.code, $fault: e.status >= 500 ? 'server' : 'client', $metadata: { httpStatusCode: e.status } });
        throw e;
      }
      throw new Error(`Operación no soportada en el simulador: ${service}.${op}`);
    },
  };
}

function fmtLog(ts: number, reqId: string, level: string, msg: string) { return `${new Date(ts).toISOString()}\t${reqId}\t${level}\t${msg}`; }

/** Ejecuta una versión de la función con el evento dado. No autoriza al llamador: lo hace quien invoca. */
export function execute(s: CloudState, region: string, fn: LambdaFn, version: string, event: any, source = 'invoke', depth = 0): ExecResult {
  const snap = snapOf(fn, version);
  const reqId = guid();
  const t0 = now();
  let elapsed = 0;
  const lines: { ts: number; text: string; level: string }[] = [];
  let timedOut = false;
  const timeoutMs = snap.timeout * 1000;
  const cold = fn.stats.streamKey !== `${version}:${snap.codeSha256}:${snap.lastModified}` || !fn.stats.lastInvoked || t0 - fn.stats.lastInvoked > 600_000;
  const initMs = cold ? 90 + Math.round(Object.values(snap.files).join('').length / 400) : 0;
  const maxSteps = 600_000;
  const interp = new Interp({
    files: snap.files, env: { ...snap.env, AWS_REGION: region, AWS_DEFAULT_REGION: region, AWS_LAMBDA_FUNCTION_NAME: fn.name, AWS_LAMBDA_FUNCTION_VERSION: version, AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(snap.memory), AWS_LAMBDA_LOG_GROUP_NAME: `/aws/lambda/${fn.name}`, AWS_EXECUTION_ENV: `AWS_Lambda_${snap.runtime}`, _HANDLER: snap.handler, TZ: ':UTC' },
    maxSteps, now: () => t0 + elapsed, aws: hostFor(s, region, fn, snap, depth),
    log: (level, msg) => lines.push({ ts: t0 + elapsed, level, text: msg }),
    advance: (ms) => { elapsed += ms; if (elapsed > timeoutMs) { throw Object.assign(new Error('timeout'), { __timeout: true }); } },
  });
  let ok = true, value: any, errorType: string | undefined, errorMessage: string | undefined, trace: string[] | undefined;
  const fail = (type: string, msg: string, line?: number) => { ok = false; errorType = type; errorMessage = msg; trace = [`${type}: ${msg}`.replace(/^Runtime\.[A-Za-z]+: /, ''), ...(line ? [`    at Runtime.handler (/var/task/${snap.handler.split('.')[0]}.js:${line}:9)`] : []), '    at Runtime.handleOnceNonStreaming (file:///var/runtime/index.mjs:1173:29)']; };
  const [modPath, ...exportParts] = snap.handler.split('.');
  const exportName = exportParts.join('.');
  const file = !modPath || !exportName ? null : interp.resolveFile('', modPath);
  try {
    if (!file) { if (!exportName) fail('Runtime.MalformedHandlerName', `Bad handler '${snap.handler}'`); else fail('Runtime.ImportModuleError', `Error: Cannot find module '${modPath}'\nRequire stack:\n- /var/runtime/index.mjs`); }
    else {
      try { parse(snap.files[file]); }
      catch (e) { if (e instanceof SyntaxError) { ok = false; errorType = 'Runtime.UserCodeSyntaxError'; errorMessage = `SyntaxError: ${e.message}`; trace = [`Runtime.UserCodeSyntaxError: SyntaxError: ${e.message}`, `    at _loadUserApp (file:///var/runtime/index.mjs:1:1)`]; } else throw e; }
      if (ok) {
        const mod = interp.load(file);
        const h = mod.exports?.[exportName];
        if (typeof h !== 'function') fail('Runtime.HandlerNotFound', `${snap.handler} is undefined or not exported`);
        else {
          let cbResult: { err?: any; res?: any } | null = null;
          const context = {
            functionName: fn.name, functionVersion: version, invokedFunctionArn: ARN_FN(region, s.account.id, fn.name, version === '$LATEST' ? undefined : version), memoryLimitInMB: String(snap.memory), awsRequestId: reqId,
            logGroupName: `/aws/lambda/${fn.name}`, logStreamName: fn.stats.stream ?? 'pending', callbackWaitsForEmptyEventLoop: true, getRemainingTimeInMillis: () => Math.max(0, timeoutMs - elapsed - Math.round(interp.steps / 2000)),
          };
          const callback = (err?: any, res?: any) => { cbResult = { err, res }; };
          const r = h(JSON.parse(JSON.stringify(event ?? null)), context, callback);
          if (r === undefined && cbResult) {
            const cr = cbResult as { err?: any; res?: any };
            if (cr.err) throw new LambdaThrow(cr.err);
            value = cr.res;
          } else value = r;
        }
      }
    }
  } catch (e) {
    if (isTimeout(e) || (e as any)?.__timeout) timedOut = true;
    else if (e instanceof LambdaThrow) {
      const v = e.value;
      if (v instanceof Error) fail(v.name || 'Error', v.message, e.line || (v as any).__line);
      else fail('string', String(v), e.line);
      if (v instanceof Error && 'code' in v && (v as any).code === 'MODULE_NOT_FOUND') { errorType = 'Runtime.ImportModuleError'; trace![0] = `Runtime.ImportModuleError: Error: ${v.message}`; errorMessage = `Error: ${v.message}`; }
    } else if (e instanceof SyntaxError) fail('Runtime.UserCodeSyntaxError', `SyntaxError: ${e.message}`, (e as any).line);
    else fail((e as Error).name || 'Error', (e as Error).message);
  }
  const steps = Math.round(interp.steps / 2000);
  let durationMs = Math.max(1, elapsed + steps);
  if (timedOut || durationMs > timeoutMs) { timedOut = true; durationMs = timeoutMs; ok = false; errorType = undefined; }
  let payload: string;
  if (timedOut) {
    const msg = `${new Date(t0 + timeoutMs).toISOString()} ${reqId} Task timed out after ${snap.timeout.toFixed(2)} seconds`;
    payload = JSON.stringify({ errorMessage: msg });
    lines.push({ ts: t0 + timeoutMs, level: 'RAW', text: msg });
    errorMessage = msg;
  } else if (!ok) payload = JSON.stringify({ errorType, errorMessage, trace });
  else { try { payload = JSON.stringify(value ?? null) ?? 'null'; } catch { payload = 'null'; } }
  const billed = Math.ceil(durationMs);
  const memUsed = Math.min(snap.memory, 38 + Math.round(interp.steps / 4000) + Math.round(snap.codeSize / 1000));
  const rlines: string[] = [`START RequestId: ${reqId} Version: ${version}`];
  for (const l of lines) rlines.push(l.level === 'RAW' ? l.text : fmtLog(l.ts, reqId, l.level, l.text));
  if (!ok && !timedOut) rlines.push(fmtLog(t0 + durationMs, reqId, 'ERROR', `Invoke Error \t${JSON.stringify({ errorType, errorMessage, stackTrace: (trace ?? []).slice(1) })}`));
  rlines.push(`END RequestId: ${reqId}`);
  rlines.push(`REPORT RequestId: ${reqId}\tDuration: ${durationMs.toFixed(2)} ms\tBilled Duration: ${billed} ms\tMemory Size: ${snap.memory} MB\tMax Memory Used: ${memUsed} MB${cold ? `\tInit Duration: ${initMs.toFixed(2)} ms` : ''}${timedOut ? '' : ''}`);
  const logText = rlines.join('\n') + '\n';

  // Registros en CloudWatch Logs: solo si el rol de ejecución puede escribirlos.
  const role = roleOf(s, snap.role);
  const group = `/aws/lambda/${fn.name}`;
  if (cold || !fn.stats.stream) fn.stats.stream = `${new Date(t0).toISOString().slice(0, 10).replace(/-/g, '/')}/[${version}]${hex(32)}`;
  fn.stats.streamKey = `${version}:${snap.codeSha256}:${snap.lastModified}`;
  if (role) {
    const gArn = `arn:aws:logs:${region}:${s.account.id}:log-group:${group}`;
    const sess = fn.name;
    const exists = s.logGroups.some((g) => g.name === group && g.region === region);
    const canGroup = exists || !roleDenial(s, role, sess, 'logs:CreateLogGroup', `arn:aws:logs:${region}:${s.account.id}:log-group:*`);
    const stream = s.logGroups.find((g) => g.name === group && g.region === region)?.streams.some((x) => x.name === fn.stats.stream);
    const canStream = stream || !roleDenial(s, role, sess, 'logs:CreateLogStream', `${gArn}:log-stream:${fn.stats.stream}`);
    const canPut = !roleDenial(s, role, sess, 'logs:PutLogEvents', `${gArn}:log-stream:${fn.stats.stream}`);
    if (canGroup && canStream && canPut) {
      const stamped = rlines.map((text, i) => ({ ts: t0 + Math.min(i, 1) * 0 + (i >= rlines.length - 2 ? durationMs : 0), msg: text.replace(/^(\d{4}-[^\t]+)\t[^\t]+\t[A-Z]+\t/, (m) => m) }));
      writeLog(s, region, group, fn.stats.stream, stamped);
    }
  }
  fn.stats.invocations++;
  if (!ok) fn.stats.errors++;
  fn.stats.lastInvoked = t0 + durationMs;
  const dims = { FunctionName: fn.name };
  emitMetric(s, 'AWS/Lambda', 'Invocations', 1, t0, dims);
  emitMetric(s, 'AWS/Lambda', 'Duration', durationMs, t0, dims);
  emitMetric(s, 'AWS/Lambda', 'Errors', ok ? 0 : 1, t0, dims);
  const inv = sv(s).invokes;
  inv.push({ fn: fn.name, region, ts: t0, requestId: reqId, ok, durationMs, billedMs: billed, memoryUsed: memUsed, source });
  if (inv.length > 300) inv.splice(0, inv.length - 200);
  return { requestId: reqId, ok, payload, value, errorType, errorMessage, trace, durationMs, billedMs: billed, logText, timedOut };
}

export interface InvokeResult { statusCode: number; functionError?: string; executedVersion: string; payload: string; logResult?: string; requestId: string }

function parsePayload(payload: string | undefined): any {
  if (payload === undefined || payload === '') return undefined;
  try { return JSON.parse(payload); } catch (e) { throw new AwsError('InvalidRequestContentException', `Could not parse request body into json: Could not parse payload into json: ${(e as Error).message}`, 400); }
}

function invokeCore(ctx: Ctx, p: { FunctionName: string; Qualifier?: string; Payload?: string; InvocationType?: string; LogType?: string }, depth = 0): InvokeResult {
  const { fn, qualifier } = getFn(ctx, p.FunctionName, p.Qualifier);
  svAuthorize(ctx, 'lambda:InvokeFunction', fn.arn + (qualifier ? ':' + qualifier : ''), 'json');
  if (fnState(fn) === 'Pending') throw pendingErr();
  const type = p.InvocationType ?? 'RequestResponse';
  if (!['RequestResponse', 'Event', 'DryRun'].includes(type)) throw val(`1 validation error detected: Value '${type}' at 'invocationType' failed to satisfy constraint: Member must satisfy enum value set: [RequestResponse, DryRun, Event]`);
  const event = parsePayload(p.Payload);
  if (type === 'DryRun') return { statusCode: 204, executedVersion: '$LATEST', payload: '', requestId: guid() };
  if (fn.reservedConcurrency === 0) {
    fn.stats.throttles++;
    emitMetric(ctx.s, 'AWS/Lambda', 'Throttles', 1, now(), { FunctionName: fn.name });
    throw new AwsError('TooManyRequestsException', 'Rate Exceeded.', 429);
  }
  const version = resolveVersion(fn, qualifier);
  const r = execute(ctx.s, fn.region, fn, version, event, depth ? 'lambda' : type === 'Event' ? 'async' : 'invoke', depth);
  if (type === 'Event') {
    if (!r.ok) deadLetter(ctx.s, fn, event);
    return { statusCode: 202, executedVersion: version, payload: '', requestId: r.requestId };
  }
  return { statusCode: 200, ...(r.ok ? {} : { functionError: 'Unhandled' }), executedVersion: version, payload: r.payload, requestId: r.requestId, ...(p.LogType === 'Tail' ? { logResult: b64(r.logText.slice(-4096)) } : {}) };
}
export function invoke(ctx: Ctx, p: { FunctionName: string; Qualifier?: string; Payload?: string; InvocationType?: string; LogType?: string }): InvokeResult {
  return trailed(ctx, SRC, 'Invoke', [{ type: 'AWS::Lambda::Function', name: parseRef(ctx, p.FunctionName).name }], { functionName: p.FunctionName, qualifier: p.Qualifier, invocationType: p.InvocationType }, () => {
    bridge.settle?.(ctx.s);
    return invokeCore(ctx, p);
  });
}

function deadLetter(s: CloudState, fn: LambdaFn, event: any) {
  const t = fn.deadLetterArn;
  if (!t) return;
  const body = JSON.stringify(event ?? null);
  const q = sqs.queueByArn(s, t);
  if (q) { sqs.enqueue(s, q, { body }); return; }
  const topic = s.topics.find((x) => x.arn === t);
  if (topic) topic.messages.push({ id: guid(), ts: nowIso(), message: body, source: 'lambda-dlq' });
}

/** Invocación hecha por otro servicio (API Gateway, SNS...). Comprueba la política de recurso de la función. */
export function invokeAsService(s: CloudState, region: string, target: string, principal: string, sourceArn: string, event: any, source: string, action = 'lambda:InvokeFunction'): { status: 'ok' | 'denied' | 'notfound' | 'error' | 'throttled'; result?: ExecResult } {
  const m = /^arn:aws[a-z-]*:lambda:([a-z0-9-]+):(\d{12}):function:([^:]+)(?::(.+))?$/.exec(target);
  const name = m ? m[3] : target, qual = m ? m[4] : undefined, reg = m ? m[1] : region;
  const fn = fnByName(s, reg, name);
  if (!fn || (qual && qual !== '$LATEST' && !fn.aliases.some((a) => a.name === qual) && !fn.versions.some((v) => v.version === qual))) return { status: 'notfound' };
  if (!permitted(fn, principal, sourceArn, action, s.account.id)) return { status: 'denied' };
  if (fn.reservedConcurrency === 0) { fn.stats.throttles++; emitMetric(s, 'AWS/Lambda', 'Throttles', 1, now(), { FunctionName: fn.name }); return { status: 'throttled' }; }
  const r = execute(s, fn.region, fn, resolveVersion(fn, qual), event, source);
  if (!r.ok) deadLetter(s, fn, event);
  return { status: r.ok ? 'ok' : 'error', result: r };
}

// ------------------------------------------------------------------ event source mappings (SQS)
const esmArnQueue = (ctx: Ctx, arn: string) => sqs.queueByArn(ctx.s, arn);

export function createMapping(ctx: Ctx, p: { FunctionName: string; EventSourceArn: string; BatchSize?: number; Enabled?: boolean; MaximumBatchingWindowInSeconds?: number; FunctionResponseTypes?: string[] }): EventSourceMapping {
  return trailed(ctx, SRC, 'CreateEventSourceMapping20150331', [{ type: 'AWS::Lambda::EventSourceMapping', name: p.FunctionName }], { functionName: p.FunctionName, eventSourceArn: p.EventSourceArn, batchSize: p.BatchSize }, () => {
    const { fn } = getFn(ctx, p.FunctionName);
    svAuthorize(ctx, 'lambda:CreateEventSourceMapping', '*', 'json');
    const arn = p.EventSourceArn ?? '';
    if (!arn.startsWith('arn:aws:sqs:')) throw invalidP('Este simulador solo admite orígenes de eventos de Amazon SQS.');
    const q = esmArnQueue(ctx, arn);
    if (!q) throw invalidP('Error occurred while ReceiveMessage. SQS Error Code: AWS.SimpleQueueService.NonExistentQueue. SQS Error Message: The specified queue does not exist.');
    const role = roleOf(ctx.s, fn.role);
    if (role) {
      for (const a of ['ReceiveMessage', 'DeleteMessage', 'GetQueueAttributes']) {
        if (roleDenial(ctx.s, role, fn.name, 'sqs:' + a, q.arn)) throw invalidP(`The provided execution role does not have permissions to call ${a} on SQS`);
      }
    }
    const vis = Number(q.attrs.VisibilityTimeout);
    if (fn.timeout > vis) throw invalidP(`Queue visibility timeout: ${vis} seconds is less than Function timeout: ${fn.timeout} seconds`);
    const batch = p.BatchSize ?? 10;
    const win = p.MaximumBatchingWindowInSeconds ?? 0;
    if (batch < 1 || batch > 10000) throw val(`1 validation error detected: Value '${batch}' at 'batchSize' failed to satisfy constraint: Member must have value less than or equal to 10000`);
    if (batch > 10 && !win) throw invalidP(`Maximum batch size for function with event source SQS is 10. When BatchSize is greater than 10, you must set MaximumBatchingWindowInSeconds to at least 1.`);
    const dup = sv(ctx.s).mappings.find((m) => m.eventSourceArn === arn && m.functionName === fn.name && m.region === fn.region);
    if (dup) throw conflict(`An event source mapping with SQS arn (" ${arn} ") and function (" ${fn.name} ") already exists. Please update or delete the existing mapping with UUID ${dup.uuid}`);
    const m: EventSourceMapping = { uuid: guid(), functionArn: fn.arn, functionName: fn.name, region: fn.region, eventSourceArn: arn, batchSize: batch, enabled: p.Enabled ?? true, lastModified: now(), maxBatchingWindow: win, functionResponseTypes: asArr(p.FunctionResponseTypes), lastProcessingResult: 'No records processed' };
    sv(ctx.s).mappings.push(m);
    bridge.afterSend?.(ctx.s);
    return m;
  });
}
function mappingOr(ctx: Ctx, uuid: string) {
  const m = sv(ctx.s).mappings.find((x) => x.uuid === uuid);
  if (!m) throw new AwsError('ResourceNotFoundException', 'The resource you requested does not exist.', 404);
  return m;
}
export function listMappings(ctx: Ctx, p: { FunctionName?: string; EventSourceArn?: string }) {
  return trailed(ctx, SRC, 'ListEventSourceMappings20150331', [], p, () => {
    svAuthorize(ctx, 'lambda:ListEventSourceMappings', '*', 'json');
    bridge.settle?.(ctx.s);
    const name = p.FunctionName ? parseRef(ctx, p.FunctionName).name : undefined;
    return sv(ctx.s).mappings.filter((m) => m.region === ctx.region && (!name || m.functionName === name) && (!p.EventSourceArn || m.eventSourceArn === p.EventSourceArn));
  });
}
export function getMapping(ctx: Ctx, p: { UUID: string }) { return trailed(ctx, SRC, 'GetEventSourceMapping20150331', [], p, () => { svAuthorize(ctx, 'lambda:GetEventSourceMapping', '*', 'json'); bridge.settle?.(ctx.s); return mappingOr(ctx, p.UUID); }); }
export function updateMapping(ctx: Ctx, p: { UUID: string; Enabled?: boolean; BatchSize?: number; FunctionResponseTypes?: string[]; FunctionName?: string; MaximumBatchingWindowInSeconds?: number }) {
  return trailed(ctx, SRC, 'UpdateEventSourceMapping20150331', [], p, () => {
    svAuthorize(ctx, 'lambda:UpdateEventSourceMapping', '*', 'json');
    const m = mappingOr(ctx, p.UUID);
    if (p.Enabled !== undefined) m.enabled = p.Enabled;
    if (p.BatchSize !== undefined) m.batchSize = Number(p.BatchSize);
    if (p.MaximumBatchingWindowInSeconds !== undefined) m.maxBatchingWindow = Number(p.MaximumBatchingWindowInSeconds);
    if (p.FunctionResponseTypes) m.functionResponseTypes = asArr(p.FunctionResponseTypes);
    m.lastModified = now();
    bridge.afterSend?.(ctx.s);
    return m;
  });
}
export function deleteMapping(ctx: Ctx, p: { UUID: string }) {
  return trailed(ctx, SRC, 'DeleteEventSourceMapping20150331', [], p, () => { svAuthorize(ctx, 'lambda:DeleteEventSourceMapping', '*', 'json'); const m = mappingOr(ctx, p.UUID); sv(ctx.s).mappings = sv(ctx.s).mappings.filter((x) => x !== m); return m; });
}

let busy = false;
/** Procesa las colas con un mapping habilitado: invoca la función con lotes y borra lo que sale bien. */
export function processMappings(s: CloudState) {
  if (busy) return;
  busy = true;
  try {
    for (let round = 0; round < 60; round++) {
      let any = false;
      for (const m of sv(s).mappings) {
        if (!m.enabled) continue;
        const q = sqs.queueByArn(s, m.eventSourceArn);
        const fn = fnByName(s, m.region, m.functionName);
        if (!q || !fn) continue;
        const role = roleOf(s, fn.role);
        if (role && ['ReceiveMessage', 'DeleteMessage', 'GetQueueAttributes'].some((a) => roleDenial(s, role, fn.name, 'sqs:' + a, q.arn))) { m.lastProcessingResult = 'PROBLEM: Function execution role does not have permissions to call ReceiveMessage on SQS'; continue; }
        if (fn.reservedConcurrency === 0) continue;
        const msgs = sqs.receive(s, q, Math.min(m.batchSize, 10));
        if (!msgs.length) continue;
        any = true;
        const event = { Records: msgs.map((x) => ({ messageId: x.id, receiptHandle: x.receipt, body: x.body, attributes: { ApproximateReceiveCount: String(x.receiveCount), SentTimestamp: String(x.sentAt), SenderId: 'AIDAEXAMPLE0000000000', ApproximateFirstReceiveTimestamp: String(x.firstReceivedAt ?? x.sentAt), ...(q.fifo ? { MessageGroupId: x.groupId, MessageDeduplicationId: x.dedupId, SequenceNumber: x.seq } : {}) }, messageAttributes: x.attrs, md5OfBody: x.md5, eventSource: 'aws:sqs', eventSourceARN: q.arn, awsRegion: q.region })) };
        const r = execute(s, fn.region, fn, '$LATEST', event, 'sqs');
        if (r.ok) {
          let failed: string[] = [];
          if (m.functionResponseTypes.includes('ReportBatchItemFailures') && r.value && Array.isArray(r.value.batchItemFailures)) failed = r.value.batchItemFailures.map((f: any) => f.itemIdentifier);
          for (const x of msgs) if (!failed.includes(x.id)) sqs.deleteMessageInternal(q, x.receipt!);
          m.lastProcessingResult = 'OK';
        } else m.lastProcessingResult = 'PROBLEM: Function call failed';
      }
      if (!any) break;
    }
  } finally { busy = false; }
}

bridge.afterSend = processMappings;
bridge.settle = (s) => { processMappings(s); };
export const settleLambda = processMappings;
void getRole; void md5;
export type { Caller };

// AWS CloudFormation: pilas, conjuntos de cambios, eventos y reversión. Las plantillas (JSON o YAML) crean recursos REALES del
// motor (S3, EC2/VPC, IAM, KMS, Secrets Manager, SNS, CloudWatch, Logs) con la identidad de quien lanza la pila o el rol de servicio.
// El tiempo es simulado: las operaciones se ejecutan al instante, pero cada evento lleva la marca temporal que tendría en AWS y el
// estado de la pila avanza (CREATE_IN_PROGRESS → CREATE_COMPLETE...) con el reloj. `wait`/`deploy` adelantan ese reloj.
import type { CloudState } from '../types';
import { AwsError } from '../errors';
import { check, trailed, type Ctx } from '../api';
import { speedFactor } from '../store';
import { guid, now } from '../util';
import * as s3 from './s3';
import { NAMED_IAM_PROP, NEEDS_IAM, customName, genName, providerOf, validateProps, PropError, type Live, type PCtx, type Props, type Provider } from './cfnResources';
import {
  analyze, collectRefs, evalConditions, evalValue, parseTemplate, resolveParameters, stableJson, valError, tplError,
  type Analysis, type EvalEnv, type ParamInput, type ResolvedParam, type Template,
} from './cfnTemplate';

export { parseTemplate } from './cfnTemplate';
export { supportedTypes } from './cfnResources';

const SRC = 'cloudformation.amazonaws.com';

// ------------------------------------------------------------------ modelo

export type StackStatus =
  | 'REVIEW_IN_PROGRESS' | 'CREATE_IN_PROGRESS' | 'CREATE_FAILED' | 'CREATE_COMPLETE' | 'ROLLBACK_IN_PROGRESS' | 'ROLLBACK_FAILED' | 'ROLLBACK_COMPLETE'
  | 'DELETE_IN_PROGRESS' | 'DELETE_FAILED' | 'DELETE_COMPLETE' | 'UPDATE_IN_PROGRESS' | 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS' | 'UPDATE_COMPLETE'
  | 'UPDATE_FAILED' | 'UPDATE_ROLLBACK_IN_PROGRESS' | 'UPDATE_ROLLBACK_FAILED' | 'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS' | 'UPDATE_ROLLBACK_COMPLETE';

export interface CfnTag { Key: string; Value: string }
export interface CfnEvent { id: string; seq: number; ts: number; logicalId: string; physicalId: string; type: string; status: string; reason?: string; props?: string; stackLevel: boolean }
export interface CfnRes {
  logicalId: string; type: string; physicalId: string; attrs: Record<string, string>; props: Props; deps: string[];
  state: 'live' | 'failed' | 'deleted' | 'retained' | 'delete_failed'; deletionPolicy?: string; updateReplacePolicy?: string; createdAt: number;
}
export interface CfnChange {
  action: 'Add' | 'Modify' | 'Remove'; logicalId: string; physicalId?: string; type: string; replacement?: 'True' | 'False' | 'Conditional';
  scope: string[]; details: { name: string; attribute: 'Properties' | 'Tags'; recreation: 'Never' | 'Always'; source: 'DirectModification' | 'ResourceReference'; causing?: string }[]; policyAction?: string;
}
export interface CfnChangeSet {
  id: string; name: string; description?: string; kind: 'CREATE' | 'UPDATE'; createdAt: string; readyAt: number; template: string; format: 'JSON' | 'YAML';
  parameters: ResolvedParam[]; capabilities: string[]; tags: CfnTag[]; roleArn?: string; changes: CfnChange[]; failed?: string; executed?: 'ok' | 'rollback' | 'running' | 'obsolete';
}
export interface CfnStack {
  id: string; name: string; region: string; status: StackStatus; statusReason?: string; createdAt: string; updatedAt?: string; deletedAt?: string; description?: string;
  template: string; format: 'JSON' | 'YAML'; parameters: ResolvedParam[]; outputs: { key: string; value: string; description?: string; exportName?: string }[];
  capabilities: string[]; tags: CfnTag[]; roleArn?: string; disableRollback: boolean; terminationProtection: boolean;
  resources: CfnRes[]; events: CfnEvent[]; changeSets: CfnChangeSet[]; timeline: { at: number; status: StackStatus; reason?: string }[]; seq: number; imports: string[];
}
export interface CfnState { stacks: CfnStack[]; skew: number }

const cf = (s: CloudState): CfnState => (s.cfn ??= { stacks: [], skew: 0 });
/** Reloj de CloudFormation: el del motor más lo que han adelantado las esperas (`wait`, `deploy`). */
export const cfnNow = (s: CloudState) => now() + cf(s).skew;
const iso = (ms: number) => new Date(ms).toISOString();

const IN_PROGRESS = (st: string) => st.endsWith('_IN_PROGRESS');
const stackArn = (ctx: Ctx, name: string, id: string) => `arn:aws:cloudformation:${ctx.region}:${ctx.s.account.id}:stack/${name}/${id}`;
const stackWild = (ctx: Ctx, name = '*') => `arn:aws:cloudformation:${ctx.region}:${ctx.s.account.id}:stack/${name}/*`;

function authz(ctx: Ctx, action: string, resource: string) {
  if (ctx.caller.type === 'Root') return;
  const r = check(ctx, action, resource);
  if (r.decision === 'Allow') return;
  const why = r.decision === 'ExplicitDeny' ? 'with an explicit deny in an identity-based policy' : `because no identity-based policy allows the ${action} action`;
  throw new AwsError('AccessDenied', `User: ${ctx.caller.arn} is not authorized to perform: ${action} on resource: ${resource} ${why}`, 403);
}

// ------------------------------------------------------------------ evolución en el tiempo

/** Aplica las fases del ciclo de vida de cada pila cuyo momento ya llegó. */
export function settleCfn(s: CloudState) {
  const t = cfnNow(s);
  for (const st of cf(s).stacks) {
    while (st.timeline.length && st.timeline[0].at <= t) {
      const p = st.timeline.shift()!;
      st.status = p.status;
      st.statusReason = p.reason;
      if (p.status === 'DELETE_COMPLETE') st.deletedAt = iso(p.at);
    }
    for (const c of st.changeSets) {
      if (c.executed === 'running' && !IN_PROGRESS(st.status)) c.executed = /ROLLBACK|FAILED/.test(st.status) ? 'rollback' : 'ok';
    }
  }
}

/** Adelanta el reloj de CloudFormation hasta que la pila (o el conjunto de cambios) termine su operación actual. */
export function fastForward(s: CloudState, st?: CfnStack, cs?: CfnChangeSet) {
  let end = cfnNow(s);
  if (st) end = Math.max(end, ...st.timeline.map((p) => p.at), ...st.events.map((e) => e.ts));
  if (cs) end = Math.max(end, cs.readyAt);
  if (end > cfnNow(s)) cf(s).skew += end - cfnNow(s);
  settleCfn(s);
}

const DUR: Record<string, [number, number]> = {
  'AWS::S3::Bucket': [2500, 1500], 'AWS::EC2::VPC': [2000, 1500], 'AWS::EC2::Subnet': [1500, 1200], 'AWS::EC2::SecurityGroup': [1500, 1200], 'AWS::EC2::InternetGateway': [1200, 1000],
  'AWS::EC2::VPCGatewayAttachment': [1500, 1200], 'AWS::EC2::Instance': [12000, 8000], 'AWS::IAM::Role': [3000, 2000], 'AWS::IAM::User': [2500, 1500], 'AWS::KMS::Key': [3000, 1500],
  'AWS::SecretsManager::Secret': [2000, 1500], 'AWS::SNS::Topic': [1500, 1200], 'AWS::CloudWatch::Alarm': [1500, 1000], 'AWS::Logs::LogGroup': [1200, 1000],
};
const dur = (type: string, kind: 0 | 1, F: number) => (DUR[type]?.[kind] ?? (kind === 0 ? 1500 : 1000)) * F;

// ------------------------------------------------------------------ búsqueda

const NAME_RE = /^[a-zA-Z][-a-zA-Z0-9]*$/;

export function findStack(ctx: Ctx, ref: string, opts: { deleted?: boolean } = {}): CfnStack | undefined {
  settleCfn(ctx.s);
  const all = cf(ctx.s).stacks.filter((x) => x.region === ctx.region);
  if (ref.startsWith('arn:')) return all.find((x) => x.id === ref);
  return all.find((x) => x.name === ref && (opts.deleted || x.status !== 'DELETE_COMPLETE'));
}
const noStack = (ref: string, style: 'id' | 'brackets' = 'brackets') => valError(style === 'id' ? `Stack with id ${ref} does not exist` : `Stack [${ref}] does not exist`);
function mustStack(ctx: Ctx, ref: string | undefined, style: 'id' | 'brackets' = 'brackets'): CfnStack {
  if (!ref) throw valError("1 validation error detected: Value null at 'stackName' failed to satisfy constraint: Member must not be null");
  const st = findStack(ctx, ref);
  if (!st) throw noStack(ref, style);
  return st;
}

// ------------------------------------------------------------------ eventos

function addEvent(st: CfnStack, ts: number, res: { logicalId: string; type: string; physicalId: string } | null, status: string, reason?: string, props?: Props) {
  const stamp = iso(ts);
  st.events.push({
    id: res ? `${res.logicalId}-${status}-${stamp}` : guid(), seq: st.seq++, ts, logicalId: res?.logicalId ?? st.name, physicalId: res ? res.physicalId : st.id,
    type: res?.type ?? 'AWS::CloudFormation::Stack', status, reason, props: props && Object.keys(props).length ? JSON.stringify(props) : undefined, stackLevel: !res,
  });
}
/** Fija el estado inicial de una operación y programa el resto de fases. */
function begin(st: CfnStack, ts: number, status: StackStatus, reason = 'User Initiated') {
  st.timeline = [];
  st.status = status;
  st.statusReason = undefined;
  addEvent(st, ts, null, status, reason);
}
function phase(st: CfnStack, at: number, status: StackStatus, reason?: string) {
  addEvent(st, at, null, status, reason);
  st.timeline.push({ at, status, reason: /FAILED|ROLLBACK_IN_PROGRESS/.test(status) ? reason : undefined });
}

/** Eventos ya ocurridos, del más reciente al más antiguo. */
export function visibleEvents(s: CloudState, st: CfnStack): CfnEvent[] {
  const t = cfnNow(s);
  return st.events.filter((e) => e.ts <= t).sort((a, b) => b.ts - a.ts || b.seq - a.seq);
}

/** Estado actual de cada recurso, deducido de sus eventos visibles. */
export function visibleResources(s: CloudState, st: CfnStack) {
  const evs = visibleEvents(s, st).filter((e) => !e.stackLevel);
  const out: { res: CfnRes; status: string; reason?: string; ts: number }[] = [];
  for (const r of st.resources) {
    const last = evs.find((e) => e.logicalId === r.logicalId);
    if (!last) continue;
    out.push({ res: r, status: last.status, reason: last.reason, ts: last.ts });
  }
  return out;
}

// ------------------------------------------------------------------ plantillas

function loadSource(ctx: Ctx, p: { TemplateBody?: string; TemplateURL?: string }): string {
  if (p.TemplateBody !== undefined) {
    if (new TextEncoder().encode(p.TemplateBody).length > 51200) throw valError('Template format error: Template may not exceed 51200 bytes in size. Use an S3 URL (TemplateURL) for larger templates.');
    return p.TemplateBody;
  }
  if (!p.TemplateURL) throw valError('Either Template URL or Template Body must be specified.');
  const m = /^https:\/\/(?:([a-z0-9.-]+)\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com|s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com\/([^/]+))\/(.+)$/.exec(p.TemplateURL.split('?')[0]);
  if (!m) throw valError('TemplateURL must be a supported URL.');
  const bucket = m[1] ?? m[2];
  try {
    return s3.getObject(ctx, { Bucket: bucket, Key: decodeURIComponent(m[3]) }).body;
  } catch {
    throw valError('TemplateURL must reference a valid S3 object to which you have access.');
  }
}

const isKnown = (t: string) => !!providerOf(t);
const attrsOf = (t: string) => providerOf(t)?.attrs ?? [];
const isCapIam = (c: string) => c === 'CAPABILITY_IAM' || c === 'CAPABILITY_NAMED_IAM';

/** Capacidades que exige la plantilla (según los recursos de IAM que declara). */
export function requiredCapabilities(tpl: Template): { caps: string[]; types: string[] } {
  const types: string[] = [];
  let named = false;
  for (const r of Object.values(tpl.Resources)) {
    if (!NEEDS_IAM(r.Type)) continue;
    types.push(r.Type);
    const np = NAMED_IAM_PROP[r.Type];
    if (np && r.Properties?.[np] !== undefined) named = true;
  }
  return { caps: types.length ? [named ? 'CAPABILITY_NAMED_IAM' : 'CAPABILITY_IAM'] : [], types: [...new Set(types)] };
}
function checkCapabilities(tpl: Template, given: string[] = []) {
  const need = requiredCapabilities(tpl).caps[0];
  if (!need) return;
  const ok = need === 'CAPABILITY_IAM' ? given.some(isCapIam) : given.includes('CAPABILITY_NAMED_IAM');
  if (!ok) throw new AwsError('InsufficientCapabilitiesException', `Requires capabilities : [${need}]`, 400);
}

export interface Loaded { tpl: Template; format: 'JSON' | 'YAML'; text: string; an: Analysis }
function load(ctx: Ctx, p: { TemplateBody?: string; TemplateURL?: string }): Loaded {
  const text = loadSource(ctx, p);
  const { tpl, format } = parseTemplate(text);
  return { tpl, format, text, an: analyze(tpl, isKnown, attrsOf) };
}

// ------------------------------------------------------------------ entorno de evaluación

function makeEnv(ctx: Ctx, stackName: string, stackId: string, tpl: Template, params: ResolvedParam[], lookup: (l: string) => Live | undefined, opts: { placeholders?: boolean; imports?: Set<string>; conditions?: Record<string, boolean> } = {}): EvalEnv {
  const base = {
    params: Object.fromEntries(params.map((p) => [p.key, p.value])), paramTypes: Object.fromEntries(params.map((p) => [p.key, p.type])),
    pseudo: { 'AWS::Region': ctx.region, 'AWS::AccountId': ctx.s.account.id, 'AWS::StackName': stackName, 'AWS::StackId': stackId, 'AWS::Partition': 'aws', 'AWS::URLSuffix': 'amazonaws.com', 'AWS::NotificationARNs': '' } as Record<string, string>,
    mappings: tpl.Mappings,
    physical(l: string) {
      const x = lookup(l);
      if (x) return x.id;
      if (opts.placeholders) return `<${l}>`;
      throw valError(`Template error: resource ${l} has not been created yet`);
    },
    attr(l: string, a: string) {
      const x = lookup(l);
      if (x) return x.attrs[a] ?? '';
      if (opts.placeholders) return `<${l}.${a}>`;
      throw valError(`Template error: resource ${l} has not been created yet`);
    },
    importValue(name: string) {
      for (const o of cf(ctx.s).stacks) {
        if (o.region !== ctx.region || o.status === 'DELETE_COMPLETE' || o.name === stackName) continue;
        const e = o.outputs.find((x) => x.exportName === name);
        if (e) { opts.imports?.add(name); return e.value; }
      }
      throw valError(`No export named ${name} found.`);
    },
    resourceExists: (l: string) => !!tpl.Resources[l],
  };
  const conditions = opts.conditions ?? evalConditions(tpl, { ...base });
  return { ...base, conditions };
}

const tagsFor = (st: { name: string; id: string; tags: CfnTag[] }, logical: string): CfnTag[] => [
  { Key: 'aws:cloudformation:stack-name', Value: st.name }, { Key: 'aws:cloudformation:stack-id', Value: st.id }, { Key: 'aws:cloudformation:logical-id', Value: logical }, ...st.tags,
];

function outputsOf(tpl: Template, env: EvalEnv): CfnStack['outputs'] {
  const out: CfnStack['outputs'] = [];
  for (const [key, o] of Object.entries(tpl.Outputs ?? {})) {
    if (o.Condition && !env.conditions[o.Condition]) continue;
    const v = evalValue(o.Value, env);
    const name = o.Export?.Name !== undefined ? String(evalValue(o.Export.Name, env)) : undefined;
    out.push({ key, value: Array.isArray(v) ? v.join(',') : typeof v === 'object' ? JSON.stringify(v) : String(v), description: o.Description, exportName: name });
  }
  return out;
}

/** Evalúa toda la plantilla con marcadores para detectar errores estáticos (ImportValue inexistente, Select fuera de rango...). */
function preflight(ctx: Ctx, st: { name: string; id: string }, ld: Loaded, params: ResolvedParam[]) {
  const imports = new Set<string>();
  const env = makeEnv(ctx, st.name, st.id, ld.tpl, params, () => undefined, { placeholders: true, imports });
  for (const [l, d] of Object.entries(ld.tpl.Resources)) {
    if (d.Condition && !env.conditions[d.Condition]) continue;
    evalValue(d.Properties ?? {}, env);
  }
  const outs = outputsOf(ld.tpl, env);
  for (const o of outs) {
    if (!o.exportName) continue;
    const other = cf(ctx.s).stacks.find((x) => x.region === ctx.region && x.name !== st.name && x.status !== 'DELETE_COMPLETE' && x.outputs.some((e) => e.exportName === o.exportName));
    if (other) throw valError(`Export with name ${o.exportName} is already exported by stack ${other.name}`);
  }
  return imports;
}

// ------------------------------------------------------------------ plan de cambios

const props = (v: Props) => JSON.parse(JSON.stringify(v ?? {})) as Props;
const diffKeys = (a: Props, b: Props) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => stableJson(a[k]) !== stableJson(b[k]));

/** Cambios que produciría aplicar `ld` sobre la pila actual (o sobre nada, al crear). */
function plan(ctx: Ctx, st: CfnStack, ld: Loaded, params: ResolvedParam[]): CfnChange[] {
  const old = st.resources.filter((r) => r.state === 'live');
  const live = new Map<string, Live | undefined>();
  const env = makeEnv(ctx, st.name, st.id, ld.tpl, params, (l) => live.get(l), { placeholders: true });
  const changes: CfnChange[] = [];
  const seen = new Set<string>();
  for (const l of ld.an.order) {
    const d = ld.tpl.Resources[l];
    if (d.Condition && !env.conditions[d.Condition]) continue;
    seen.add(l);
    const prov = providerOf(d.Type)!;
    const p = evalValue(d.Properties ?? {}, env) as Props;
    const o = old.find((r) => r.logicalId === l);
    if (!o) { changes.push({ action: 'Add', logicalId: l, type: d.Type, scope: [], details: [] }); live.set(l, undefined); continue; }
    if (o.type !== d.Type) {
      changes.push({ action: 'Add', logicalId: l, type: d.Type, scope: [], details: [] }, { action: 'Remove', logicalId: l, physicalId: o.physicalId, type: o.type, scope: [], details: [], policyAction: o.deletionPolicy === 'Retain' ? 'Retain' : 'Delete' });
      live.set(l, undefined);
      continue;
    }
    const keys = diffKeys(o.props, p);
    if (!keys.length) { live.set(l, { id: o.physicalId, attrs: o.attrs }); continue; }
    const rep = keys.some((k) => prov.replace.includes(k));
    const details = keys.map((k) => {
      const m = /<([A-Za-z0-9]+)(?:\.[^>]*)?>/.exec(JSON.stringify(p[k]) ?? '');
      return { name: k, attribute: (k === 'Tags' ? 'Tags' : 'Properties') as 'Tags' | 'Properties', recreation: (prov.replace.includes(k) ? 'Always' : 'Never') as 'Always' | 'Never', source: (m ? 'ResourceReference' : 'DirectModification') as 'ResourceReference' | 'DirectModification', causing: m?.[1] };
    });
    changes.push({ action: 'Modify', logicalId: l, physicalId: o.physicalId, type: d.Type, replacement: rep ? 'True' : 'False', scope: [...new Set(details.map((x) => x.attribute))], details, ...(rep ? { policyAction: (d.UpdateReplacePolicy ?? 'Delete') === 'Retain' ? 'ReplaceAndRetain' : 'ReplaceAndDelete' } : {}) });
    live.set(l, rep ? undefined : { id: o.physicalId, attrs: o.attrs });
  }
  for (const o of old) if (!seen.has(o.logicalId)) changes.push({ action: 'Remove', logicalId: o.logicalId, physicalId: o.physicalId, type: o.type, scope: [], details: [], policyAction: o.deletionPolicy === 'Retain' ? 'Retain' : 'Delete' });
  return changes;
}

// ------------------------------------------------------------------ ejecución (crear y actualizar)

/** Contexto con el que CloudFormation llama a los demás servicios: el rol de servicio o el llamador. */
function execCtx(ctx: Ctx, roleArn?: string): Ctx {
  const base: Ctx['caller'] = { ...ctx.caller, sourceIp: SRC };
  if (!roleArn) return { ...ctx, caller: base };
  const name = roleArn.split('/').pop()!;
  const role = ctx.s.roles.find((r) => r.name === name && r.arn === roleArn);
  const bad = () => valError(`Role ${roleArn} is invalid or cannot be assumed`);
  if (!role) throw bad();
  if (!JSON.stringify(role.assumeRolePolicy).includes('cloudformation.amazonaws.com')) throw bad();
  authz(ctx, 'iam:PassRole', role.arn);
  return { ...ctx, caller: { type: 'AssumedRole', arn: `arn:aws:sts::${ctx.s.account.id}:assumed-role/${role.name}/AWSCloudFormation`, userName: 'AWSCloudFormation', roleName: role.name, mfa: false, sourceIp: SRC } };
}

function reasonOf(prov: Provider, e: unknown): string {
  if (e instanceof PropError) return e.message;
  if (e instanceof AwsError) return /^(ValidationError)$/.test(e.code) && !prov.service ? e.message : `${e.message} (Service: ${prov.service}; Status Code: ${e.status}; Error Code: ${e.code}; Request ID: ${guid()}; Proxy: null)`;
  return (e as Error).message;
}

/** Ordena recursos de modo que ninguno aparezca antes que los que dependen de él (para borrar). */
function deleteOrder<T extends { logicalId: string; deps: string[] }>(list: T[]): T[] {
  const left = [...list];
  const out: T[] = [];
  while (left.length) {
    const i = left.findIndex((r) => !left.some((o) => o !== r && o.deps.includes(r.logicalId)));
    out.push(...left.splice(i < 0 ? 0 : i, 1));
  }
  return out;
}

interface Undo { logical: string; kind: 'created' | 'updated'; res: CfnRes; run(): void }
interface Job {
  mode: 'create' | 'update'; ld: Loaded; params: ResolvedParam[]; caps: string[]; tags: CfnTag[]; roleArn?: string; disableRollback: boolean; onFailure?: 'ROLLBACK' | 'DO_NOTHING' | 'DELETE'; cs?: CfnChangeSet;
}

/** Aplica una plantilla a la pila: crea, actualiza o sustituye recursos y, si algo falla, revierte. */
function execute(ctx: Ctx, st: CfnStack, job: Job) {
  const api = execCtx(ctx, job.roleArn);
  const F = speedFactor();
  const t0 = cfnNow(ctx.s);
  const { tpl, an } = job.ld;
  const create = job.mode === 'create';
  const oldList = create ? [] : st.resources.filter((r) => r.state === 'live');
  const oldSnap = new Map(oldList.map((r) => [r.logicalId, { props: props(r.props), attrs: { ...r.attrs }, physicalId: r.physicalId, deps: [...r.deps] }]));
  const stackTags = job.tags;
  const live = new Map<string, Live>();
  for (const r of oldList) live.set(r.logicalId, { id: r.physicalId, attrs: r.attrs });
  const imports = new Set<string>();
  const env = makeEnv(api, st.name, st.id, tpl, job.params, (l) => live.get(l), { imports });
  if (create) st.resources = [];
  begin(st, t0, create ? 'CREATE_IN_PROGRESS' : 'UPDATE_IN_PROGRESS');
  if (!create) st.updatedAt = iso(t0);
  const pctx = (logical: string): PCtx => ({ ctx: api, stackName: st.name, stackId: st.id, logical, tags: tagsFor({ name: st.name, id: st.id, tags: stackTags }, logical) });
  const ends: Record<string, number> = {};
  const undo: Undo[] = [];
  const cleanup: CfnRes[] = [];
  const keep: CfnRes[] = [];
  const created: CfnRes[] = [];
  let failed: { logical: string; reason: string; verb: 'create' | 'update' } | undefined;
  let tEnd = t0 + 400 * F;

  for (const l of an.order) {
    const d = tpl.Resources[l];
    if (d.Condition && !env.conditions[d.Condition]) continue;
    const prov = providerOf(d.Type)!;
    const start = Math.max(t0 + 400 * F, ...an.deps[l].map((x) => ends[x] ?? 0));
    const old = oldList.find((r) => r.logicalId === l && r.type === d.Type);
    let p: Props;
    let announced = false;
    const mk = (physicalId: string, state: CfnRes['state'] = 'live', attrs: Record<string, string> = {}): CfnRes => ({ logicalId: l, type: d.Type, physicalId, attrs, props: {}, deps: an.deps[l], state, deletionPolicy: d.DeletionPolicy, updateReplacePolicy: d.UpdateReplacePolicy, createdAt: start });
    try {
      p = props(evalValue(d.Properties ?? {}, env) as Props);
    } catch (e) {
      const r = mk('', 'failed');
      addEvent(st, start, r, 'CREATE_FAILED', (e as Error).message);
      if (!old) keep.push(r); else keep.push(old);
      failed = { logical: l, reason: (e as Error).message, verb: old ? 'update' : 'create' };
      tEnd = start;
      break;
    }
    const changed = old ? diffKeys(old.props, p) : [];
    if (old && !changed.length) { keep.push(old); ends[l] = ends[l] ?? 0; continue; }
    const replaced = !!old && changed.some((k) => prov.replace.includes(k));
    // Un recurso con nombre fijo no se puede sustituir: AWS lo rechaza porque el nombre nuevo chocaría con el antiguo.
    if (replaced && prov.named && !changed.includes(prov.named) && customName(prov, p) !== undefined) {
      const msg = `CloudFormation cannot update a stack when a custom-named resource requires replacing. Rename ${customName(prov, p)} and update the stack again.`;
      addEvent(st, start, old!, 'UPDATE_IN_PROGRESS', undefined, p);
      addEvent(st, start + 300 * F, old!, 'UPDATE_FAILED', msg);
      keep.push(old!);
      failed = { logical: l, reason: msg, verb: 'update' };
      tEnd = start + 300 * F;
      break;
    }
    try {
      validateProps(prov, p);
      if (!old || replaced) {
        const r = mk('', 'live');
        r.props = p;
        addEvent(st, start, { ...r, physicalId: '' }, 'CREATE_IN_PROGRESS', replaced ? 'Requested update requires the creation of a new physical resource; hence creating one.' : undefined, p);
        announced = true;
        const made = prov.create(pctx(l), p);
        r.physicalId = made.id; r.attrs = made.attrs;
        ends[l] = start + dur(d.Type, 0, F);
        addEvent(st, ends[l], r, 'CREATE_COMPLETE');
        live.set(l, made);
        created.push(r);
        keep.push(r);
        undo.push({ logical: l, kind: 'created', res: r, run: () => prov.remove(pctx(l), { id: r.physicalId, attrs: r.attrs }, r.props) });
        if (replaced) cleanup.push({ ...old!, props: oldSnap.get(l)!.props });
      } else {
        const snap = oldSnap.get(l)!;
        addEvent(st, start, old, 'UPDATE_IN_PROGRESS', undefined, p);
        const made = prov.update ? prov.update(pctx(l), { id: old.physicalId, attrs: old.attrs }, p, snap.props) : { id: old.physicalId, attrs: old.attrs };
        old.props = p; old.attrs = made.attrs; old.deletionPolicy = d.DeletionPolicy; old.updateReplacePolicy = d.UpdateReplacePolicy; old.deps = an.deps[l];
        ends[l] = start + dur(d.Type, 0, F) * 0.6;
        addEvent(st, ends[l], old, 'UPDATE_COMPLETE');
        live.set(l, made);
        keep.push(old);
        undo.push({ logical: l, kind: 'updated', res: old, run: () => { prov.update?.(pctx(l), { id: snap.physicalId, attrs: snap.attrs }, snap.props, p); old.props = snap.props; old.attrs = snap.attrs; old.deps = snap.deps; } });
      }
      tEnd = Math.max(tEnd, ends[l]);
    } catch (e) {
      const reason = reasonOf(prov, e);
      const verb: 'create' | 'update' = !old || replaced ? 'create' : 'update';
      if (verb === 'create') {
        const r = mk('', 'failed'); r.props = p;
        if (!announced) addEvent(st, start, r, 'CREATE_IN_PROGRESS', replaced ? 'Requested update requires the creation of a new physical resource; hence creating one.' : undefined, p);
        addEvent(st, start + 400 * F, r, 'CREATE_FAILED', reason);
        if (!replaced) keep.push(r);
        else keep.push(old!);
      } else {
        addEvent(st, start + 400 * F, old!, 'UPDATE_FAILED', reason);
        keep.push(old!);
      }
      failed = { logical: l, reason, verb };
      tEnd = start + 400 * F;
      break;
    }
  }

  // ------------------------------------------------------------ fallo: reversión
  if (failed) {
    const why = `The following resource(s) failed to ${failed.verb}: [${failed.logical}]. `;
    if (create) {
      st.resources = keep;
      const mode = job.onFailure ?? (job.disableRollback ? 'DO_NOTHING' : 'ROLLBACK');
      if (mode === 'DO_NOTHING') { phase(st, tEnd + 200 * F, 'CREATE_FAILED', why); return finish(st, job, imports); }
      let t = tEnd + 300 * F;
      phase(st, t, 'ROLLBACK_IN_PROGRESS', `${why}Rollback requested by user.`);
      const failedDel: string[] = [];
      for (const r of deleteOrder(created.filter((x) => x.state === 'live'))) {
        t += 200 * F;
        if (r.deletionPolicy === 'Retain') { addEvent(st, t, r, 'DELETE_SKIPPED'); r.state = 'retained'; continue; }
        addEvent(st, t, r, 'DELETE_IN_PROGRESS');
        try {
          providerOf(r.type)!.remove(pctx(r.logicalId), { id: r.physicalId, attrs: r.attrs }, r.props);
          t += dur(r.type, 1, F);
          addEvent(st, t, r, 'DELETE_COMPLETE');
          r.state = 'deleted';
        } catch (e) {
          t += 300 * F;
          addEvent(st, t, r, 'DELETE_FAILED', reasonOf(providerOf(r.type)!, e));
          r.state = 'delete_failed';
          failedDel.push(r.logicalId);
        }
      }
      if (failedDel.length) { phase(st, t + 200 * F, 'ROLLBACK_FAILED', `The following resource(s) failed to delete: [${failedDel.join(', ')}]. `); return finish(st, job, imports); }
      phase(st, t + 200 * F, 'ROLLBACK_COMPLETE');
      if (mode === 'DELETE') {
        phase(st, t + 400 * F, 'DELETE_IN_PROGRESS', 'User Initiated');
        phase(st, t + 600 * F, 'DELETE_COMPLETE');
      }
      return finish(st, job, imports);
    }
    // actualización fallida: se deshace lo hecho, en orden inverso
    let t = tEnd + 300 * F;
    if (job.disableRollback) { phase(st, t, 'UPDATE_FAILED', why); st.resources = [...keep.filter((r) => !created.includes(r)), ...created]; return finish(st, job, imports); }
    phase(st, t, 'UPDATE_ROLLBACK_IN_PROGRESS', why);
    for (const u of [...undo].reverse()) {
      t += 200 * F;
      const prov = providerOf(u.res.type)!;
      try {
        if (u.kind === 'created') {
          addEvent(st, t, u.res, 'DELETE_IN_PROGRESS');
          u.run();
          t += dur(u.res.type, 1, F);
          addEvent(st, t, u.res, 'DELETE_COMPLETE');
        } else {
          addEvent(st, t, u.res, 'UPDATE_IN_PROGRESS');
          u.run();
          t += 600 * F;
          addEvent(st, t, u.res, 'UPDATE_COMPLETE');
        }
      } catch (e) {
        addEvent(st, t + 200 * F, u.res, u.kind === 'created' ? 'DELETE_FAILED' : 'UPDATE_FAILED', reasonOf(prov, e));
      }
    }
    phase(st, t + 200 * F, 'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS');
    phase(st, t + 400 * F, 'UPDATE_ROLLBACK_COMPLETE');
    st.resources = oldList.map((r) => { const o = oldSnap.get(r.logicalId)!; r.props = o.props; r.attrs = o.attrs; r.physicalId = o.physicalId; return r; });
    return finish(st, job, imports, true);
  }

  // ------------------------------------------------------------ éxito
  let t = tEnd + 300 * F;
  if (create) {
    st.resources = keep;
    phase(st, t, 'CREATE_COMPLETE');
  } else {
    for (const o of oldList) {
      const k = keep.find((r) => r.logicalId === o.logicalId);
      if (!k || (k !== o && !cleanup.some((c) => c.physicalId === o.physicalId))) cleanup.push(o);
    }
    st.resources = keep;
    if (cleanup.length) {
      phase(st, t, 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS');
      for (const r of deleteOrder(cleanup)) {
        t += 200 * F;
        const prov = providerOf(r.type)!;
        const policy = (r.updateReplacePolicy && keep.some((k) => k.logicalId === r.logicalId) ? r.updateReplacePolicy : r.deletionPolicy) ?? 'Delete';
        if (policy === 'Retain') { addEvent(st, t, r, 'DELETE_SKIPPED'); continue; }
        addEvent(st, t, r, 'DELETE_IN_PROGRESS');
        try {
          prov.remove(pctx(r.logicalId), { id: r.physicalId, attrs: r.attrs }, r.props);
          t += dur(r.type, 1, F);
          addEvent(st, t, r, 'DELETE_COMPLETE');
        } catch (e) {
          t += 300 * F;
          addEvent(st, t, r, 'DELETE_FAILED', reasonOf(prov, e));
        }
      }
      t += 200 * F;
    }
    phase(st, t, 'UPDATE_COMPLETE');
  }
  // La plantilla, los parámetros y las salidas solo se consolidan cuando todo ha ido bien.
  st.template = job.ld.text; st.format = job.ld.format; st.description = tpl.Description;
  st.parameters = job.params; st.tags = job.tags; st.capabilities = job.caps; st.roleArn = job.roleArn;
  st.outputs = outputsOf(tpl, env);
  finish(st, job, imports);
}

function finish(st: CfnStack, job: Job, imports: Set<string>, rolledBack = false) {
  if (!rolledBack || job.mode === 'create') st.imports = [...imports];
  if (job.cs) job.cs.executed = 'running';
}

// ------------------------------------------------------------------ operaciones: pilas

const CAPS = ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'];
function checkCaps(given?: string[]) {
  for (const c of given ?? []) if (!CAPS.includes(c)) throw valError(`1 validation error detected: Value '[${c}]' at 'capabilities' failed to satisfy constraint: Member must satisfy enum value set: [CAPABILITY_AUTO_EXPAND, CAPABILITY_IAM, CAPABILITY_NAMED_IAM]`);
}
const tagsOfInput = (t?: CfnTag[]): CfnTag[] => (t ?? []).map((x) => ({ Key: String(x.Key), Value: String(x.Value ?? '') }));

export interface CreateStackInput {
  StackName: string; TemplateBody?: string; TemplateURL?: string; Parameters?: ParamInput[]; Capabilities?: string[]; Tags?: CfnTag[]; RoleARN?: string;
  DisableRollback?: boolean; OnFailure?: string; EnableTerminationProtection?: boolean; TimeoutInMinutes?: number;
}

export function createStack(ctx: Ctx, p: CreateStackInput): { stackId: string } {
  return trailed(ctx, SRC, 'CreateStack', [{ type: 'AWS::CloudFormation::Stack', name: p.StackName }], { stackName: p.StackName, capabilities: p.Capabilities }, () => {
    authz(ctx, 'cloudformation:CreateStack', stackWild(ctx, p.StackName));
    settleCfn(ctx.s);
    if (!p.StackName || p.StackName.length > 128 || !NAME_RE.test(p.StackName)) throw valError(`1 validation error detected: Value '${p.StackName}' at 'stackName' failed to satisfy constraint: Member must satisfy regular expression pattern: [a-zA-Z][-a-zA-Z0-9]*|arn:[-a-zA-Z0-9:/._+]*`);
    if (p.DisableRollback && p.OnFailure) throw valError('You can specify either DisableRollback or OnFailure, but not both.');
    if (p.OnFailure && !['ROLLBACK', 'DO_NOTHING', 'DELETE'].includes(p.OnFailure)) throw valError(`1 validation error detected: Value '${p.OnFailure}' at 'onFailure' failed to satisfy constraint: Member must satisfy enum value set: [DO_NOTHING, ROLLBACK, DELETE]`);
    checkCaps(p.Capabilities);
    const dup = findStack(ctx, p.StackName);
    if (dup) throw new AwsError('AlreadyExistsException', `Stack [${p.StackName}] already exists`, 400);
    const ld = load(ctx, p);
    const params = resolveParameters(ld.tpl, p.Parameters);
    checkCapabilities(ld.tpl, p.Capabilities);
    const id = stackArn(ctx, p.StackName, guid());
    preflight(ctx, { name: p.StackName, id }, ld, params);
    execCtx(ctx, p.RoleARN); // valida el rol de servicio (y iam:PassRole) antes de crear nada
    const st: CfnStack = {
      id, name: p.StackName, region: ctx.region, status: 'CREATE_IN_PROGRESS', createdAt: new Date(cfnNow(ctx.s)).toISOString(), description: ld.tpl.Description, template: ld.text, format: ld.format,
      parameters: params, outputs: [], capabilities: p.Capabilities ?? [], tags: tagsOfInput(p.Tags), roleArn: p.RoleARN, disableRollback: !!p.DisableRollback, terminationProtection: !!p.EnableTerminationProtection,
      resources: [], events: [], changeSets: [], timeline: [], seq: 0, imports: [],
    };
    cf(ctx.s).stacks.push(st);
    execute(ctx, st, { mode: 'create', ld, params, caps: p.Capabilities ?? [], tags: st.tags, roleArn: p.RoleARN, disableRollback: !!p.DisableRollback, onFailure: p.OnFailure as 'ROLLBACK' });
    settleCfn(ctx.s);
    return { stackId: id };
  });
}

const UPDATABLE: StackStatus[] = ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE', 'CREATE_FAILED', 'UPDATE_FAILED'];
function mustBeUpdatable(st: CfnStack) {
  if (!UPDATABLE.includes(st.status) || st.status === 'CREATE_FAILED') throw valError(`Stack:${st.id} is in ${st.status} state and can not be updated.`);
}

export interface UpdateStackInput extends Omit<CreateStackInput, 'OnFailure' | 'EnableTerminationProtection' | 'TimeoutInMinutes'> { UsePreviousTemplate?: boolean }
export function updateStack(ctx: Ctx, p: UpdateStackInput): { stackId: string } {
  return trailed(ctx, SRC, 'UpdateStack', [{ type: 'AWS::CloudFormation::Stack', name: p.StackName }], { stackName: p.StackName }, () => {
    authz(ctx, 'cloudformation:UpdateStack', stackWild(ctx, p.StackName));
    const st = mustStack(ctx, p.StackName);
    mustBeUpdatable(st);
    checkCaps(p.Capabilities);
    const ld = p.UsePreviousTemplate ? { ...parseKeep(st), an: undefined as any } : load(ctx, p);
    if (p.UsePreviousTemplate) ld.an = analyze(ld.tpl, isKnown, attrsOf);
    const prev = Object.fromEntries(st.parameters.map((x) => [x.key, x.value]));
    const params = resolveParameters(ld.tpl, p.Parameters, prev);
    checkCapabilities(ld.tpl, p.Capabilities);
    preflight(ctx, st, ld, params);
    const tags = p.Tags ? tagsOfInput(p.Tags) : st.tags;
    const changes = plan(ctx, st, ld, params);
    const same = stableJson(parseTemplate(st.template).tpl) === stableJson(ld.tpl) && JSON.stringify(st.parameters.map((x) => [x.key, x.value])) === JSON.stringify(params.map((x) => [x.key, x.value])) && stableJson(tags) === stableJson(st.tags);
    if (!changes.length && same) throw valError('No updates are to be performed.');
    execute(ctx, st, { mode: 'update', ld, params, caps: p.Capabilities ?? st.capabilities, tags, roleArn: p.RoleARN ?? st.roleArn, disableRollback: !!p.DisableRollback });
    settleCfn(ctx.s);
    return { stackId: st.id };
  });
}
function parseKeep(st: CfnStack): Omit<Loaded, 'an'> {
  const { tpl, format } = parseTemplate(st.template);
  return { tpl, format, text: st.template };
}

export function deleteStack(ctx: Ctx, p: { StackName: string; RetainResources?: string[]; RoleARN?: string }): void {
  return trailed(ctx, SRC, 'DeleteStack', [{ type: 'AWS::CloudFormation::Stack', name: p.StackName }], { stackName: p.StackName }, () => {
    authz(ctx, 'cloudformation:DeleteStack', stackWild(ctx, p.StackName));
    settleCfn(ctx.s);
    const st = findStack(ctx, p.StackName);
    if (!st) return; // borrar una pila que no existe no falla
    if (st.terminationProtection) throw valError(`Stack [${st.id}] cannot be deleted while TerminationProtection is enabled`);
    if (IN_PROGRESS(st.status)) throw valError(`Stack [${st.name}] cannot be deleted while in status ${st.status}`);
    const names = st.outputs.map((o) => o.exportName).filter(Boolean) as string[];
    for (const o of cf(ctx.s).stacks) {
      if (o === st || o.region !== ctx.region || o.status === 'DELETE_COMPLETE') continue;
      const used = o.imports.find((i) => names.includes(i));
      if (used) throw valError(`Export ${used} cannot be deleted as it is in use by ${o.name}`);
    }
    const retain = p.RetainResources ?? [];
    if (retain.length && st.status !== 'DELETE_FAILED') throw valError('Specifying RetainResources is only valid if the stack is in the DELETE_FAILED state.');
    const missing = retain.filter((l) => !st.resources.some((r) => r.logicalId === l));
    if (missing.length) throw valError(`Resource(s) [${missing.join(', ')}] do not exist in stack ${st.name}`);
    runDelete(ctx, st, retain, p.RoleARN ?? st.roleArn);
    settleCfn(ctx.s);
  });
}

function runDelete(ctx: Ctx, st: CfnStack, retain: string[], roleArn?: string) {
  const api = execCtx(ctx, roleArn);
  const F = speedFactor();
  let t = cfnNow(ctx.s);
  begin(st, t, 'DELETE_IN_PROGRESS');
  const failedIds: string[] = [];
  const pending = st.resources.filter((r) => r.state === 'live' || r.state === 'delete_failed');
  for (const r of deleteOrder(pending)) {
    const prov = providerOf(r.type)!;
    t += 200 * F;
    // Si algo de lo que depende de él ha fallado al borrarse, este recurso no se puede borrar aún.
    if (pending.some((o) => failedIds.includes(o.logicalId) && o.deps.includes(r.logicalId))) continue;
    if (retain.includes(r.logicalId) || r.deletionPolicy === 'Retain') { addEvent(st, t, r, 'DELETE_SKIPPED'); r.state = 'retained'; continue; }
    addEvent(st, t, r, 'DELETE_IN_PROGRESS');
    try {
      prov.remove({ ctx: api, stackName: st.name, stackId: st.id, logical: r.logicalId, tags: [] }, { id: r.physicalId, attrs: r.attrs }, r.props);
      t += dur(r.type, 1, F);
      addEvent(st, t, r, 'DELETE_COMPLETE');
      r.state = 'deleted';
    } catch (e) {
      t += 300 * F;
      addEvent(st, t, r, 'DELETE_FAILED', reasonOf(prov, e));
      r.state = 'delete_failed';
      failedIds.push(r.logicalId);
    }
  }
  if (failedIds.length) phase(st, t + 200 * F, 'DELETE_FAILED', `The following resource(s) failed to delete: [${failedIds.join(', ')}]. `);
  else phase(st, t + 200 * F, 'DELETE_COMPLETE');
}

export function describeStacks(ctx: Ctx, p: { StackName?: string }): CfnStack[] {
  return trailed(ctx, SRC, 'DescribeStacks', [], { stackName: p.StackName }, () => {
    authz(ctx, 'cloudformation:DescribeStacks', stackWild(ctx, p.StackName?.startsWith('arn:') ? p.StackName.split('/')[1] : p.StackName));
    settleCfn(ctx.s);
    if (p.StackName) return [mustStack(ctx, p.StackName, 'id')];
    return cf(ctx.s).stacks.filter((x) => x.region === ctx.region && x.status !== 'DELETE_COMPLETE');
  });
}

export function listStacks(ctx: Ctx, p: { StackStatusFilter?: string[] }): CfnStack[] {
  return trailed(ctx, SRC, 'ListStacks', [], p, () => {
    authz(ctx, 'cloudformation:ListStacks', '*');
    settleCfn(ctx.s);
    return cf(ctx.s).stacks.filter((x) => x.region === ctx.region && (!p.StackStatusFilter?.length || p.StackStatusFilter.includes(x.status))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
}

export function describeStackEvents(ctx: Ctx, p: { StackName?: string }) {
  return trailed(ctx, SRC, 'DescribeStackEvents', [], p, () => {
    authz(ctx, 'cloudformation:DescribeStackEvents', stackWild(ctx, p.StackName));
    const st = mustStack(ctx, p.StackName);
    return { stack: st, events: visibleEvents(ctx.s, st) };
  });
}

export function describeStackResources(ctx: Ctx, p: { StackName?: string; LogicalResourceId?: string; PhysicalResourceId?: string }) {
  return trailed(ctx, SRC, 'DescribeStackResources', [], p, () => {
    authz(ctx, 'cloudformation:DescribeStackResources', stackWild(ctx, p.StackName));
    let st: CfnStack | undefined;
    if (p.StackName) st = mustStack(ctx, p.StackName, 'id');
    else if (p.PhysicalResourceId) {
      settleCfn(ctx.s);
      st = cf(ctx.s).stacks.find((x) => x.region === ctx.region && x.resources.some((r) => r.physicalId === p.PhysicalResourceId));
      if (!st) throw valError(`Stack for ${p.PhysicalResourceId} does not exist`);
    } else throw valError('Either StackName or PhysicalResourceId must be specified.');
    const list = visibleResources(ctx.s, st).filter((r) => (!p.LogicalResourceId || r.res.logicalId === p.LogicalResourceId));
    return { stack: st, resources: list };
  });
}

export function listStackResources(ctx: Ctx, p: { StackName: string }) {
  return trailed(ctx, SRC, 'ListStackResources', [], p, () => {
    authz(ctx, 'cloudformation:ListStackResources', stackWild(ctx, p.StackName));
    const st = mustStack(ctx, p.StackName);
    return { stack: st, resources: visibleResources(ctx.s, st) };
  });
}

export function describeStackResource(ctx: Ctx, p: { StackName: string; LogicalResourceId: string }) {
  return trailed(ctx, SRC, 'DescribeStackResource', [], p, () => {
    authz(ctx, 'cloudformation:DescribeStackResource', stackWild(ctx, p.StackName));
    const st = mustStack(ctx, p.StackName, 'id');
    const r = visibleResources(ctx.s, st).find((x) => x.res.logicalId === p.LogicalResourceId);
    if (!r) throw valError(`Resource ${p.LogicalResourceId} does not exist for stack ${p.StackName}`);
    return { stack: st, resource: r };
  });
}

export function getTemplate(ctx: Ctx, p: { StackName?: string; ChangeSetName?: string; TemplateStage?: string }): { body: string; format: 'JSON' | 'YAML' } {
  return trailed(ctx, SRC, 'GetTemplate', [], p, () => {
    authz(ctx, 'cloudformation:GetTemplate', stackWild(ctx, p.StackName));
    if (p.TemplateStage && !['Original', 'Processed'].includes(p.TemplateStage)) throw valError(`1 validation error detected: Value '${p.TemplateStage}' at 'templateStage' failed to satisfy constraint: Member must satisfy enum value set: [Processed, Original]`);
    const st = mustStack(ctx, p.StackName, 'id');
    if (p.ChangeSetName) {
      const cs = findChangeSet(st, p.ChangeSetName);
      return { body: cs.template, format: cs.format };
    }
    return { body: st.template, format: st.format };
  });
}

export function validateTemplate(ctx: Ctx, p: { TemplateBody?: string; TemplateURL?: string }) {
  return trailed(ctx, SRC, 'ValidateTemplate', [], {}, () => {
    authz(ctx, 'cloudformation:ValidateTemplate', '*');
    const ld = load(ctx, p);
    const rc = requiredCapabilities(ld.tpl);
    return {
      description: ld.tpl.Description,
      parameters: Object.entries(ld.tpl.Parameters ?? {}).map(([k, d]) => ({ key: k, defaultValue: d.Default === undefined ? undefined : String(d.Default), noEcho: d.NoEcho === true || d.NoEcho === 'true', description: d.Description })),
      capabilities: rc.caps, reason: rc.types.length ? `The following resource(s) require capabilities: [${rc.types.join(', ')}]` : undefined,
    };
  });
}

export function updateTerminationProtection(ctx: Ctx, p: { StackName: string; EnableTerminationProtection: boolean }): string {
  return trailed(ctx, SRC, 'UpdateTerminationProtection', [{ type: 'AWS::CloudFormation::Stack', name: p.StackName }], p, () => {
    authz(ctx, 'cloudformation:UpdateTerminationProtection', stackWild(ctx, p.StackName));
    const st = mustStack(ctx, p.StackName);
    st.terminationProtection = !!p.EnableTerminationProtection;
    return st.id;
  });
}

export function listExports(ctx: Ctx) {
  return trailed(ctx, SRC, 'ListExports', [], {}, () => {
    authz(ctx, 'cloudformation:ListExports', '*');
    settleCfn(ctx.s);
    return cf(ctx.s).stacks.filter((x) => x.region === ctx.region && ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'].includes(x.status)).flatMap((x) => x.outputs.filter((o) => o.exportName).map((o) => ({ stackId: x.id, name: o.exportName!, value: o.value })));
  });
}

export function listImports(ctx: Ctx, p: { ExportName: string }): string[] {
  return trailed(ctx, SRC, 'ListImports', [], p, () => {
    authz(ctx, 'cloudformation:ListImports', '*');
    settleCfn(ctx.s);
    const all = cf(ctx.s).stacks.filter((x) => x.region === ctx.region && x.status !== 'DELETE_COMPLETE');
    if (!all.some((x) => x.outputs.some((o) => o.exportName === p.ExportName))) throw valError(`Export '${p.ExportName}' does not exist`);
    return all.filter((x) => x.imports.includes(p.ExportName)).map((x) => x.name);
  });
}

// ------------------------------------------------------------------ conjuntos de cambios

const csArn = (ctx: Ctx, name: string, id: string) => `arn:aws:cloudformation:${ctx.region}:${ctx.s.account.id}:changeSet/${name}/${id}`;

export function findChangeSet(st: CfnStack, ref: string): CfnChangeSet {
  const cs = st.changeSets.find((c) => c.name === ref || c.id === ref);
  if (!cs) throw new AwsError('ChangeSetNotFound', `ChangeSet [${ref}] does not exist`, 404);
  return cs;
}

/** Estado visible del conjunto de cambios (CREATE_PENDING → CREATE_COMPLETE / FAILED) y de su ejecución. */
export function changeSetStatus(s: CloudState, cs: CfnChangeSet): { status: string; execution: string; reason?: string } {
  if (cs.executed === 'obsolete') return { status: 'CREATE_COMPLETE', execution: 'OBSOLETE' };
  if (cs.executed === 'running') return { status: 'CREATE_COMPLETE', execution: 'EXECUTE_IN_PROGRESS' };
  if (cs.executed === 'ok') return { status: 'CREATE_COMPLETE', execution: 'EXECUTE_COMPLETE' };
  if (cs.executed === 'rollback') return { status: 'CREATE_COMPLETE', execution: 'EXECUTE_FAILED' };
  if (cfnNow(s) < cs.readyAt) return { status: 'CREATE_PENDING', execution: 'UNAVAILABLE' };
  if (cs.failed) return { status: 'FAILED', execution: 'UNAVAILABLE', reason: cs.failed };
  return { status: 'CREATE_COMPLETE', execution: 'AVAILABLE' };
}

export interface CreateChangeSetInput {
  StackName: string; ChangeSetName: string; TemplateBody?: string; TemplateURL?: string; UsePreviousTemplate?: boolean; Parameters?: ParamInput[]; Capabilities?: string[]; Tags?: CfnTag[]; RoleARN?: string;
  Description?: string; ChangeSetType?: string;
}
export function createChangeSet(ctx: Ctx, p: CreateChangeSetInput): { id: string; stackId: string } {
  return trailed(ctx, SRC, 'CreateChangeSet', [{ type: 'AWS::CloudFormation::Stack', name: p.StackName }], { stackName: p.StackName, changeSetName: p.ChangeSetName }, () => {
    authz(ctx, 'cloudformation:CreateChangeSet', stackWild(ctx, p.StackName));
    settleCfn(ctx.s);
    if (!p.ChangeSetName || !/^[a-zA-Z][-a-zA-Z0-9]*$/.test(p.ChangeSetName)) throw valError(`1 validation error detected: Value '${p.ChangeSetName}' at 'changeSetName' failed to satisfy constraint: Member must satisfy regular expression pattern: [a-zA-Z][-a-zA-Z0-9]*`);
    const type = p.ChangeSetType ?? 'UPDATE';
    if (!['CREATE', 'UPDATE', 'IMPORT'].includes(type)) throw valError(`1 validation error detected: Value '${type}' at 'changeSetType' failed to satisfy constraint: Member must satisfy enum value set: [IMPORT, UPDATE, CREATE]`);
    if (type === 'IMPORT') throw valError('ChangeSetType IMPORT is not supported by this simulator.');
    checkCaps(p.Capabilities);
    let st = findStack(ctx, p.StackName);
    if (type === 'CREATE') {
      if (st && st.status !== 'REVIEW_IN_PROGRESS') throw new AwsError('AlreadyExistsException', `Stack [${p.StackName}] already exists`, 400);
    } else {
      if (!st) throw valError(`Stack [${p.StackName}] does not exist`);
      mustBeUpdatable(st);
    }
    const ld: Loaded = p.UsePreviousTemplate && st ? { ...parseKeep(st), an: analyze(parseKeep(st).tpl, isKnown, attrsOf) } : load(ctx, p);
    const prev = Object.fromEntries((st?.parameters ?? []).map((x) => [x.key, x.value]));
    const params = resolveParameters(ld.tpl, p.Parameters, prev);
    checkCapabilities(ld.tpl, p.Capabilities);
    const id = st?.id ?? stackArn(ctx, p.StackName, guid());
    if (st?.changeSets.some((c) => c.name === p.ChangeSetName)) throw new AwsError('AlreadyExistsException', `ChangeSet [${p.ChangeSetName}] already exists`, 400);
    preflight(ctx, { name: p.StackName, id }, ld, params);
    if (!st) {
      st = {
        id, name: p.StackName, region: ctx.region, status: 'REVIEW_IN_PROGRESS', statusReason: 'User Initiated', createdAt: new Date(cfnNow(ctx.s)).toISOString(), template: '', format: 'JSON', parameters: [], outputs: [], capabilities: [],
        tags: [], disableRollback: false, terminationProtection: false, resources: [], events: [], changeSets: [], timeline: [], seq: 0, imports: [],
      };
      cf(ctx.s).stacks.push(st);
      addEvent(st, cfnNow(ctx.s), null, 'REVIEW_IN_PROGRESS', 'User Initiated');
    }
    const changes = plan(ctx, type === 'CREATE' ? { ...st, resources: [] } : st, ld, params);
    const paramsSame = type === 'UPDATE' && JSON.stringify(st.parameters.map((x) => [x.key, x.value])) === JSON.stringify(params.map((x) => [x.key, x.value]));
    const cs: CfnChangeSet = {
      id: csArn(ctx, p.ChangeSetName, guid()), name: p.ChangeSetName, description: p.Description, kind: type as 'CREATE', createdAt: new Date(cfnNow(ctx.s)).toISOString(), readyAt: cfnNow(ctx.s) + 1500 * speedFactor(),
      template: ld.text, format: ld.format, parameters: params, capabilities: p.Capabilities ?? [], tags: tagsOfInput(p.Tags), roleArn: p.RoleARN, changes,
      failed: !changes.length && paramsSame ? "The submitted information didn't contain changes. Submit different information to create a change set." : undefined,
    };
    st.changeSets.push(cs);
    return { id: cs.id, stackId: st.id };
  });
}

export function describeChangeSet(ctx: Ctx, p: { ChangeSetName: string; StackName?: string }) {
  return trailed(ctx, SRC, 'DescribeChangeSet', [], p, () => {
    authz(ctx, 'cloudformation:DescribeChangeSet', '*');
    settleCfn(ctx.s);
    let st: CfnStack | undefined;
    if (p.ChangeSetName.startsWith('arn:')) st = cf(ctx.s).stacks.find((x) => x.region === ctx.region && x.changeSets.some((c) => c.id === p.ChangeSetName));
    else st = p.StackName ? findStack(ctx, p.StackName) : undefined;
    if (!st) {
      if (p.ChangeSetName.startsWith('arn:')) throw new AwsError('ChangeSetNotFound', `ChangeSet [${p.ChangeSetName}] does not exist`, 404);
      throw valError(p.StackName ? `Stack [${p.StackName}] does not exist` : 'StackName must be specified if ChangeSetName is not specified as an ARN.');
    }
    const cs = findChangeSet(st, p.ChangeSetName);
    return { stack: st, cs, ...changeSetStatus(ctx.s, cs) };
  });
}

export function listChangeSets(ctx: Ctx, p: { StackName: string }) {
  return trailed(ctx, SRC, 'ListChangeSets', [], p, () => {
    authz(ctx, 'cloudformation:ListChangeSets', stackWild(ctx, p.StackName));
    const st = mustStack(ctx, p.StackName);
    return { stack: st, sets: st.changeSets.map((cs) => ({ cs, ...changeSetStatus(ctx.s, cs) })) };
  });
}

export function executeChangeSet(ctx: Ctx, p: { ChangeSetName: string; StackName?: string; DisableRollback?: boolean }): void {
  return trailed(ctx, SRC, 'ExecuteChangeSet', [{ type: 'AWS::CloudFormation::Stack', name: p.StackName ?? p.ChangeSetName }], { changeSetName: p.ChangeSetName, stackName: p.StackName }, () => {
    authz(ctx, 'cloudformation:ExecuteChangeSet', stackWild(ctx, p.StackName));
    settleCfn(ctx.s);
    const st = p.ChangeSetName.startsWith('arn:') ? cf(ctx.s).stacks.find((x) => x.region === ctx.region && x.changeSets.some((c) => c.id === p.ChangeSetName)) : p.StackName ? findStack(ctx, p.StackName) : undefined;
    if (!st) throw p.ChangeSetName.startsWith('arn:') ? new AwsError('ChangeSetNotFound', `ChangeSet [${p.ChangeSetName}] does not exist`, 404) : valError(p.StackName ? `Stack [${p.StackName}] does not exist` : 'StackName must be specified if ChangeSetName is not specified as an ARN.');
    const cs = findChangeSet(st, p.ChangeSetName);
    const state = changeSetStatus(ctx.s, cs);
    if (state.status !== 'CREATE_COMPLETE' || state.execution !== 'AVAILABLE') throw new AwsError('InvalidChangeSetStatus', `ChangeSet [${cs.id}] cannot be executed in its current status of [${state.execution === 'AVAILABLE' ? state.status : state.status === 'FAILED' ? 'FAILED' : state.execution === 'UNAVAILABLE' ? state.status : state.execution}]`, 400);
    if (cs.kind === 'CREATE' ? st.status !== 'REVIEW_IN_PROGRESS' : (mustBeUpdatable(st), false)) throw valError(`Stack:${st.id} is in ${st.status} state and can not be updated.`);
    const ld: Loaded = { ...parseTemplate(cs.template), text: cs.template, an: undefined as any };
    ld.an = analyze(ld.tpl, isKnown, attrsOf);
    for (const o of st.changeSets) if (o !== cs) o.executed = 'obsolete';
    if (cs.kind === 'CREATE') {
      st.template = cs.template; st.format = cs.format; st.description = ld.tpl.Description; st.tags = cs.tags; st.capabilities = cs.capabilities; st.roleArn = cs.roleArn; st.parameters = cs.parameters;
      st.resources = [];
    }
    execute(ctx, st, { mode: cs.kind === 'CREATE' ? 'create' : 'update', ld, params: cs.parameters, caps: cs.capabilities, tags: cs.tags, roleArn: cs.roleArn ?? st.roleArn, disableRollback: !!p.DisableRollback, cs });
    settleCfn(ctx.s);
  });
}

export function deleteChangeSet(ctx: Ctx, p: { ChangeSetName: string; StackName?: string }): void {
  return trailed(ctx, SRC, 'DeleteChangeSet', [], p, () => {
    authz(ctx, 'cloudformation:DeleteChangeSet', stackWild(ctx, p.StackName));
    settleCfn(ctx.s);
    const st = p.ChangeSetName.startsWith('arn:') ? cf(ctx.s).stacks.find((x) => x.region === ctx.region && x.changeSets.some((c) => c.id === p.ChangeSetName)) : p.StackName ? findStack(ctx, p.StackName) : undefined;
    if (!st) throw p.ChangeSetName.startsWith('arn:') ? new AwsError('ChangeSetNotFound', `ChangeSet [${p.ChangeSetName}] does not exist`, 404) : valError(`Stack [${p.StackName}] does not exist`);
    const cs = findChangeSet(st, p.ChangeSetName);
    if (cs.executed === 'running') throw new AwsError('InvalidChangeSetStatus', `ChangeSet [${cs.id}] cannot be deleted in its current status of [EXECUTE_IN_PROGRESS]`, 400);
    st.changeSets = st.changeSets.filter((c) => c !== cs);
  });
}

// ------------------------------------------------------------------ utilidades para la CLI y la consola

/** Salidas visibles de la pila (solo cuando la operación terminó bien). */
export function visibleOutputs(st: CfnStack) {
  return ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE', 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS', 'UPDATE_IN_PROGRESS'].includes(st.status) ? st.outputs : [];
}
export const isFinal = (st: string) => !IN_PROGRESS(st);
export { genName, tplError, collectRefs };

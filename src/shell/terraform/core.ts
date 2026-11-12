// Núcleo de Terraform: carga de configuración, validación, evaluación, grafo de dependencias, estado y plan.
import type { Shell } from '../interp';
import { VFS } from '../fs';
import { buildCtx } from '../aws/framework';
import * as iam from '../../engine/services/iam';
import { REGIONS, azsOf } from '../../engine/catalog';
import { guid, now } from '../../engine/util';
import { HclError, EvalError, UNKNOWN, bodyRefs, evaluate, parseHcl, refsOf, type Block, type Body, type Expr, type Scope, type Step } from './hcl';
import { DEFAULT_AMI, TfApiError, sameJson, typeOf, normRules, type Attrs, type BlockSchema, type Env, type RType } from './resources';
import type { Diag } from './render';

export const TF_VERSION = '1.9.5';
export const AWS_PROVIDER_VERSION = '5.62.0';

// ------------------------------------------------------------------ configuración

export interface ResBlock {
  mode: 'managed' | 'data';
  type: string;
  name: string;
  body: Body;
  file: string;
  line: number;
  addr: string;
}
export interface VarDef { name: string; default?: Expr; hasDefault: boolean; type?: string; validations: { cond: Expr; msg: Expr }[]; sensitive: boolean; line: number; file: string }
export interface OutDef { name: string; value: Expr; sensitive: boolean; line: number; file: string; deps: Expr[] }
export interface Config {
  files: Record<string, string[]>;
  resources: ResBlock[];
  vars: Record<string, VarDef>;
  locals: Record<string, { e: Expr; line: number; file: string }>;
  outputs: Record<string, OutDef>;
  region?: Expr;
  providerConstraint?: string;
  modules: { name: string; file: string; line: number }[];
  providerBlocks: number;
}

export class TfFailure extends Error {
  constructor(public diags: Diag[]) {
    super(diags[0]?.summary ?? 'error');
  }
}

const dg = (summary: string, detail: string, file?: string, line?: number, context?: string, address?: string): Diag => ({ severity: 'error', summary, detail, file, line, context, address });

export function listTf(sh: Shell): string[] {
  return sh.fs.list(sh.cwd).filter((f) => f.endsWith('.tf')).sort();
}

export function loadConfig(sh: Shell): { cfg: Config; diags: Diag[] } {
  const cfg: Config = { files: {}, resources: [], vars: {}, locals: {}, outputs: {}, modules: [], providerBlocks: 0 };
  const diags: Diag[] = [];
  const names = listTf(sh);
  for (const f of names) {
    const text = sh.fs.readFile(VFS.norm(f, sh.cwd));
    cfg.files[f] = text.split('\n');
    let body: Body;
    try {
      body = parseHcl(text);
    } catch (e) {
      if (e instanceof HclError) { diags.push(dg(e.message, e.detail, f, e.line)); continue; }
      throw e;
    }
    for (const b of body.blocks) {
      const ctxStr = `${b.type}${b.labels.map((l) => ` "${l}"`).join('')}`;
      switch (b.type) {
        case 'terraform': {
          for (const rp of b.body.blocks.filter((x) => x.type === 'required_providers'))
            for (const [k, a] of Object.entries(rp.body.attrs)) if (k === 'aws' && a.e.t === 'obj') { const v = a.e.items.find((i) => i.k.t === 'lit' && i.k.v === 'version'); if (v?.v.t === 'lit') cfg.providerConstraint = String(v.v.v); }
          break;
        }
        case 'provider':
          cfg.providerBlocks++;
          if (b.labels[0] === 'aws' && b.body.attrs.region) cfg.region = b.body.attrs.region.e;
          break;
        case 'variable': {
          const name = b.labels[0];
          const d = b.body.attrs.default;
          cfg.vars[name] = { name, default: d?.e, hasDefault: !!d, type: b.body.attrs.type ? typeText(b.body.attrs.type.e) : undefined, sensitive: b.body.attrs.sensitive?.e.t === 'lit' && b.body.attrs.sensitive.e.v === true, line: b.line, file: f,
            validations: b.body.blocks.filter((x) => x.type === 'validation').map((x) => ({ cond: x.body.attrs.condition?.e, msg: x.body.attrs.error_message?.e })) };
          break;
        }
        case 'locals': for (const [k, a] of Object.entries(b.body.attrs)) cfg.locals[k] = { e: a.e, line: a.line, file: f }; break;
        case 'output': cfg.outputs[b.labels[0]] = { name: b.labels[0], value: b.body.attrs.value?.e ?? { t: 'lit', v: null }, sensitive: b.body.attrs.sensitive?.e.t === 'lit' && b.body.attrs.sensitive.e.v === true, line: b.line, file: f, deps: [] }; break;
        case 'resource':
        case 'data': {
          const mode = b.type === 'data' ? 'data' : 'managed';
          if (b.labels.length !== 2) { diags.push(dg('Invalid block definition', `A ${b.type} block must have exactly two labels: the ${b.type === 'data' ? 'data source' : 'resource'} type and a name.`, f, b.line)); break; }
          const addr = `${mode === 'data' ? 'data.' : ''}${b.labels[0]}.${b.labels[1]}`;
          if (cfg.resources.some((r) => r.addr === addr)) { diags.push(dg(`Duplicate ${mode === 'data' ? 'data ' : ''}resource "${b.labels[0]}" configuration`, `A ${mode === 'data' ? 'data' : 'resource'} named "${b.labels[1]}" was already declared. ${mode === 'data' ? 'Data' : 'Resource'} names must be unique per type in each module.`, f, b.line, ctxStr)); break; }
          cfg.resources.push({ mode, type: b.labels[0], name: b.labels[1], body: b.body, file: f, line: b.line, addr });
          break;
        }
        case 'module': cfg.modules.push({ name: b.labels[0], file: f, line: b.line }); break;
        default: diags.push(dg('Unsupported block type', `Blocks of type "${b.type}" are not expected here.`, f, b.line));
      }
    }
  }
  return { cfg, diags };
}

const typeText = (e: Expr): string => (e.t === 'ref' ? e.root : e.t === 'call' ? `${e.fn}(${e.args.map(typeText).join(', ')})` : e.t === 'lit' ? String(e.v) : 'any');

// ------------------------------------------------------------------ fuentes de datos

interface DataType { args: Record<string, boolean>; blocks: Record<string, BlockSchema>; read(env: Env, a: Attrs): Attrs }
const AZ_LETTERS = 'abcdefghij';
const DATA: Record<string, DataType> = {
  aws_caller_identity: { args: {}, blocks: {}, read: (env) => { const r = iam.getCallerIdentity(env.ctx); return { account_id: r.Account, arn: r.Arn, user_id: r.UserId, id: r.Account }; } },
  aws_region: { args: { name: false }, blocks: {}, read: (env) => ({ name: env.ctx.region, id: env.ctx.region, description: REGIONS.find((r) => r.code === env.ctx.region)?.name ?? env.ctx.region, endpoint: `ec2.${env.ctx.region}.amazonaws.com` }) },
  aws_partition: { args: {}, blocks: {}, read: () => ({ partition: 'aws', dns_suffix: 'amazonaws.com', id: 'aws', reverse_dns_prefix: 'com.amazonaws' }) },
  aws_availability_zones: { args: { state: false, all_availability_zones: false }, blocks: { filter: { args: { name: true, values: true } } }, read: (env, a) => {
    const names = azsOf(env.ctx.region);
    return { names, zone_ids: names.map((_, i) => `${env.ctx.region.slice(0, 3)}${i + 1}-az${i + 1}`), state: a.state, id: env.ctx.region, group_names: [env.ctx.region] };
  } },
  aws_ami: { args: { most_recent: false, owners: false, name_regex: false, include_deprecated: false }, blocks: { filter: { args: { name: true, values: true } } }, read: () => ({ id: DEFAULT_AMI, image_id: DEFAULT_AMI, name: 'al2023-ami-2023.5.20240805.0-kernel-6.1-x86_64', architecture: 'x86_64' }) },
  aws_iam_policy_document: { args: { version: false, policy_id: false }, blocks: { statement: { args: { sid: false, effect: false, actions: false, not_actions: false, resources: false, not_resources: false }, blocks: { principals: { args: { type: true, identifiers: true } }, condition: { args: { test: true, variable: true, values: true } } } } }, read: (_env, a) => {
    const stmts = (a.statement ?? []).map((s: Attrs) => {
      const o: Attrs = {};
      if (s.sid) o.Sid = s.sid;
      o.Effect = s.effect ?? 'Allow';
      if (s.actions) o.Action = s.actions.length === 1 ? s.actions[0] : s.actions;
      if (s.not_actions) o.NotAction = s.not_actions;
      if (s.resources) o.Resource = s.resources.length === 1 ? s.resources[0] : s.resources;
      if (s.not_resources) o.NotResource = s.not_resources;
      if (s.principals?.length) { const pr: Attrs = {}; for (const p of s.principals) pr[p.type] = [...(pr[p.type] ?? []), ...p.identifiers]; for (const k of Object.keys(pr)) if (pr[k].length === 1) pr[k] = pr[k][0]; o.Principal = pr.AWS === '*' && Object.keys(pr).length === 1 ? '*' : pr; }
      if (s.condition?.length) { const cd: Attrs = {}; for (const c of s.condition) (cd[c.test] ??= {})[c.variable] = c.values.length === 1 ? c.values[0] : c.values; o.Condition = cd; }
      return o;
    });
    const doc = { Version: a.version ?? '2012-10-17', ...(a.policy_id ? { Id: a.policy_id } : {}), Statement: stmts };
    return { json: JSON.stringify(doc, null, 2), minified_json: JSON.stringify(doc), id: String(Math.abs([...JSON.stringify(doc)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7))), version: doc.Version };
  } },
};
export const dataTypeNames = () => Object.keys(DATA);

// ------------------------------------------------------------------ validación estática

const META = new Set(['count', 'for_each', 'depends_on', 'provider']);
function checkBody(d: Diag[], b: Body, args: Record<string, boolean>, blocks: Record<string, BlockSchema>, res: ResBlock, top: boolean, label = '') {
  const ctxStr = `${res.mode === 'data' ? 'data' : 'resource'} "${res.type}" "${res.name}"`;
  const addr = res.addr;
  for (const [k, a] of Object.entries(b.attrs)) {
    if (top && META.has(k)) continue;
    if (!(k in args) && !(k in blocks && false)) d.push(dg('Unsupported argument', `An argument named "${k}" is not expected here.${k in blocks ? ` Did you mean to define a block of type "${k}"?` : ''}`, res.file, a.line, ctxStr, addr));
  }
  for (const [k, req] of Object.entries(args)) if (req && !(k in b.attrs) && !(k in blocks)) d.push(dg('Missing required argument', `The argument "${k}" is required, but no definition was found.`, res.file, res.line, ctxStr, addr));
  for (const bl of b.blocks) {
    if (top && (bl.type === 'lifecycle' || bl.type === 'dynamic' || bl.type === 'provisioner')) {
      if (bl.type === 'dynamic') {
        const content = bl.body.blocks.find((x) => x.type === 'content');
        const sch = blocks[bl.labels[0]];
        if (!sch) d.push(dg('Unsupported block type', `Blocks of type "${bl.labels[0]}" are not expected here.`, res.file, bl.line, ctxStr, addr));
        else if (content) checkBody(d, content.body, sch.args, sch.blocks ?? {}, res, false);
        if (!bl.body.attrs.for_each) d.push(dg('Missing required argument', 'The argument "for_each" is required, but no definition was found.', res.file, bl.line, ctxStr, addr));
      }
      continue;
    }
    const sch = blocks[bl.type];
    if (!sch) { d.push(dg('Unsupported block type', `Blocks of type "${bl.type}" are not expected here.`, res.file, bl.line, ctxStr, addr)); continue; }
    checkBody(d, bl.body, sch.args, sch.blocks ?? {}, res, false, bl.type);
  }
  void label;
}

export function validateConfig(cfg: Config): Diag[] {
  const d: Diag[] = [];
  for (const m of cfg.modules) d.push(dg('Module not supported', 'Este simulador de Terraform no admite bloques "module": escribe los recursos directamente en el directorio raíz.', m.file, m.line, `module "${m.name}"`));
  const known = new Set(cfg.resources.map((r) => r.addr));
  for (const r of cfg.resources) {
    const ctxStr = `${r.mode === 'data' ? 'data' : 'resource'} "${r.type}" "${r.name}"`;
    const rt = r.mode === 'managed' ? typeOf(r.type) : undefined;
    const dt = r.mode === 'data' ? DATA[r.type] : undefined;
    if (r.mode === 'managed' && !rt) { d.push(dg('Invalid resource type', `The provider hashicorp/aws does not support resource type "${r.type}".${r.type.startsWith('aws_') ? '' : ' Did you intend to use the aws provider? Resource types start with "aws_".'}`, r.file, r.line, ctxStr)); continue; }
    if (r.mode === 'data' && !dt) { d.push(dg('Invalid data source', `The provider hashicorp/aws does not support data source "${r.type}".`, r.file, r.line, ctxStr)); continue; }
    const args = rt?.args ?? dt!.args;
    const blocks = rt?.blocks ?? dt!.blocks;
    checkBody(d, r.body, args, blocks, r, true);
    // referencias
    const refs = bodyRefs(r.body);
    for (const x of refs) checkRef(d, cfg, known, x, r, ctxStr);
  }
  for (const o of Object.values(cfg.outputs)) for (const x of refsOf(o.value)) checkRef(d, cfg, known, x, { file: o.file, line: o.line, addr: '', mode: 'managed', type: '', name: '', body: { attrs: {}, blocks: [] } }, `output "${o.name}"`);
  return d;
}

function checkRef(d: Diag[], cfg: Config, known: Set<string>, ref: string, r: ResBlock, ctxStr: string) {
  const [root, a, b] = ref.split('.');
  if (root === 'var') { if (a && !(a in cfg.vars)) d.push(dg('Reference to undeclared input variable', `An input variable with the name "${a}" has not been declared. This variable can be declared with a variable "${a}" {} block.`, r.file, r.line, ctxStr, r.addr || undefined)); return; }
  if (root === 'local') { if (a && !(a in cfg.locals)) d.push(dg('Reference to undeclared local value', `A local value with the name "${a}" has not been declared.`, r.file, r.line, ctxStr, r.addr || undefined)); return; }
  if (['each', 'count', 'path', 'terraform', 'self'].includes(root)) return;
  if (root === 'data') { if (!known.has(`data.${a}.${b}`)) d.push(dg('Reference to undeclared resource', `A data resource "${a}" "${b}" has not been declared in the root module.`, r.file, r.line, ctxStr, r.addr || undefined)); return; }
  if (/^[a-z]+_/.test(root) && a && !known.has(`${root}.${a}`)) d.push(dg('Reference to undeclared resource', `A managed resource "${root}" "${a}" has not been declared in the root module.`, r.file, r.line, ctxStr, r.addr || undefined));
}

// ------------------------------------------------------------------ estado

export interface StateInstance { index_key?: string | number; schema_version: number; attributes: Attrs; sensitive_attributes: any[]; dependencies: string[] }
export interface StateResource { mode: 'managed' | 'data'; type: string; name: string; provider: string; instances: StateInstance[] }
export interface State { version: 4; terraform_version: string; serial: number; lineage: string; outputs: Record<string, { value: any; type: any; sensitive?: boolean }>; resources: StateResource[]; check_results: null }

export const PROVIDER = 'provider["registry.terraform.io/hashicorp/aws"]';
export const emptyState = (): State => ({ version: 4, terraform_version: TF_VERSION, serial: 0, lineage: guid(), outputs: {}, resources: [], check_results: null });

export function loadState(sh: Shell): State | null {
  const p = VFS.norm('terraform.tfstate', sh.cwd);
  if (!sh.fs.isFile(p)) return null;
  const raw = sh.fs.readFile(p);
  if (!raw.trim()) return null;
  try { return JSON.parse(raw) as State; } catch { throw new TfFailure([dg('Failed to load state', 'The state file could not be parsed as JSON: terraform.tfstate is not valid.')]); }
}
export function saveState(sh: Shell, st: State) {
  const p = VFS.norm('terraform.tfstate', sh.cwd);
  if (sh.fs.isFile(p)) { const old = sh.fs.readFile(p); if (old.trim() && old !== JSON.stringify(st, null, 2) + '\n') sh.fs.writeFile(VFS.norm('terraform.tfstate.backup', sh.cwd), old); }
  st.resources.sort((a, b) => (a.mode + a.type + '.' + a.name).localeCompare(b.mode + b.type + '.' + b.name));
  st.serial++;
  sh.fs.writeFile(p, JSON.stringify(st, null, 2) + '\n');
}

export const addrOf = (r: { mode: string; type: string; name: string }, key?: string | number) => `${r.mode === 'data' ? 'data.' : ''}${r.type}.${r.name}${key === undefined ? '' : typeof key === 'number' ? `[${key}]` : `["${key}"]`}`;
export function stateInstances(st: State): { addr: string; res: StateResource; inst: StateInstance; base: string }[] {
  return st.resources.flatMap((r) => r.instances.map((inst) => ({ addr: addrOf(r, inst.index_key), res: r, inst, base: addrOf(r) })));
}
export function setInstance(st: State, mode: 'managed' | 'data', type: string, name: string, key: string | number | undefined, attrs: Attrs, deps: string[]) {
  let r = st.resources.find((x) => x.mode === mode && x.type === type && x.name === name);
  if (!r) { r = { mode, type, name, provider: PROVIDER, instances: [] }; st.resources.push(r); }
  const i = r.instances.findIndex((x) => x.index_key === key);
  const inst: StateInstance = { index_key: key, schema_version: 0, attributes: attrs, sensitive_attributes: [], dependencies: deps };
  if (key === undefined) delete inst.index_key;
  if (i >= 0) r.instances[i] = inst; else r.instances.push(inst);
}
export function removeInstance(st: State, mode: string, type: string, name: string, key: string | number | undefined) {
  const r = st.resources.find((x) => x.mode === mode && x.type === type && x.name === name);
  if (!r) return;
  r.instances = r.instances.filter((x) => x.index_key !== key);
  if (!r.instances.length) st.resources = st.resources.filter((x) => x !== r);
}

// ------------------------------------------------------------------ variables

export interface VarInput { cli: Record<string, string>; files: string[] }

function parseTfvars(text: string): Record<string, any> {
  const body = parseHcl(text);
  const out: Record<string, any> = {};
  const sc: Scope = { resolve: () => { throw new EvalError('Variables not allowed', 'Variables may not be used here.'); } };
  for (const [k, a] of Object.entries(body.attrs)) out[k] = evaluate(a.e, sc);
  return out;
}

export function resolveVars(sh: Shell, cfg: Config, input: VarInput): { values: Record<string, any>; diags: Diag[] } {
  const values: Record<string, any> = {};
  const diags: Diag[] = [];
  const src: Record<string, any> = {};
  const fileList = ['terraform.tfvars', 'terraform.tfvars.json', ...sh.fs.list(sh.cwd).filter((f) => f.endsWith('.auto.tfvars')).sort(), ...input.files];
  for (const f of fileList) {
    const p = VFS.norm(f, sh.cwd);
    if (!sh.fs.isFile(p)) { if (input.files.includes(f)) diags.push(dg('Failed to read variables file', `Given variables file ${f} does not exist.`)); continue; }
    try { Object.assign(src, f.endsWith('.json') ? JSON.parse(sh.fs.readFile(p)) : parseTfvars(sh.fs.readFile(p))); } catch (e) { diags.push(dg('Invalid variables file', (e as Error).message, f, (e as HclError).line)); }
  }
  for (const k of Object.keys(cfg.vars)) if (sh.vars[`TF_VAR_${k}`] !== undefined) src[k] = coerceCli(sh.vars[`TF_VAR_${k}`], cfg.vars[k].type);
  for (const [k, v] of Object.entries(input.cli)) src[k] = coerceCli(v, cfg.vars[k]?.type);
  const sc: Scope = { resolve: () => { throw new EvalError('Variables not allowed', 'Variables may not be used in a default.'); } };
  for (const v of Object.values(cfg.vars)) {
    if (v.name in src) values[v.name] = src[v.name];
    else if (v.hasDefault) { try { values[v.name] = evaluate(v.default!, sc); } catch (e) { diags.push(dg('Invalid default', (e as Error).message, v.file, v.line)); } }
    else diags.push(dg('No value for required variable', `The root module input variable "${v.name}" is not set, and has no default value. Use a -var or -var-file command line argument to provide a value for this variable.`, v.file, v.line, `variable "${v.name}"`));
    if (v.name in values && v.type) {
      const t = v.type, val = values[v.name];
      const bad = (t === 'string' && typeof val === 'object') || (t === 'number' && Number.isNaN(Number(val))) || (t === 'bool' && typeof val !== 'boolean') || (t.startsWith('list') && !Array.isArray(val)) || (t.startsWith('map') && (typeof val !== 'object' || Array.isArray(val)));
      if (bad) diags.push(dg('Invalid value for input variable', `The given value is not suitable for var.${v.name} declared at ${v.file}:${v.line}: ${t === 'bool' ? 'a bool is required' : t === 'number' ? 'a number is required' : t === 'string' ? 'string required' : `${t} required`}.`));
      else if (t === 'number') values[v.name] = Number(val);
    }
  }
  for (const k of Object.keys(src)) if (!(k in cfg.vars) && !(k in input.cli)) { /* aviso real: Value for undeclared variable (omitido) */ }
  for (const k of Object.keys(input.cli)) if (!(k in cfg.vars)) diags.push(dg('Value for undeclared variable', `A variable named "${k}" was assigned on the command line, but the root module does not declare a variable of that name. To use this value, add a "variable" block to the configuration.`));
  // validaciones
  for (const v of Object.values(cfg.vars)) {
    if (!(v.name in values)) continue;
    for (const val of v.validations) {
      if (!val.cond) continue;
      try {
        const ok = evaluate(val.cond, { resolve: (root, steps, ev) => { if (root === 'var' && steps[0]?.k === 'attr' && steps[0].name === v.name) return walkSteps(values[v.name], steps.slice(1), ev); throw new EvalError('Invalid reference', 'Only the variable itself can be referenced in a validation condition.'); } });
        if (ok === false) diags.push(dg('Invalid value for variable', `${val.msg ? String(evaluate(val.msg, { resolve: () => null })) : 'Validation failed.'}\n\nThis was checked by the validation rule at ${v.file}:${v.line}.`, v.file, v.line, `variable "${v.name}"`));
      } catch (e) { diags.push(dg('Invalid validation rule', (e as Error).message, v.file, v.line)); }
    }
  }
  return { values, diags };
}
function walkSteps(v: any, steps: Step[], ev: (x: Expr) => any): any {
  for (let i = 0; i < steps.length; i++) {
    if (v === UNKNOWN) return UNKNOWN;
    const s = steps[i];
    if (s.k === 'attr') v = v?.[s.name];
    else if (s.k === 'idx') { const ix = ev(s.e); if (ix === UNKNOWN) return UNKNOWN; v = v?.[ix]; }
    else { const arr = Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]; return arr.map((x) => walkSteps(x, steps.slice(i + 1), ev)); }
  }
  return v;
}
function coerceCli(v: string, type?: string): any {
  if (type === 'number') return Number(v);
  if (type === 'bool') return v === 'true';
  if (type && (type.startsWith('list') || type.startsWith('map') || type === 'object' || type === 'set')) { try { return JSON.parse(v); } catch { try { return parseTfvars(`x = ${v}`).x; } catch { return v; } } }
  return v;
}

// ------------------------------------------------------------------ evaluación y plan

export interface Action {
  addr: string;
  base: string;
  key?: string | number;
  res: ResBlock | null;
  type: string;
  name: string;
  kind: 'create' | 'update' | 'replace' | 'destroy';
  before?: Attrs;
  after?: Attrs;
  replaceKeys: string[];
  changed: string[];
  deps: string[];
}
export interface Drift { addr: string; type: string; name: string; kind: 'changed' | 'deleted'; before: Attrs; after?: Attrs; changed: string[] }
export interface Plan {
  actions: Action[];
  drift: Drift[];
  outputs: { name: string; before: any; after: any; sensitive: boolean; status: 'create' | 'update' | 'destroy' }[];
  /** Estado tras refrescar (para guardar). */
  state: State;
  /** Valores finales planificados por dirección base. */
  config: Config;
  vars: Record<string, any>;
  counts: { add: number; change: number; destroy: number };
}

const clone = <T>(v: T): T => (v === UNKNOWN ? v : v === undefined ? v : JSON.parse(JSON.stringify(v)));
const eq = (a: any, b: any) => (a === UNKNOWN || b === UNKNOWN ? false : sameJson(a, b));
const isJsonish = (k: string) => k === 'policy' || k === 'assume_role_policy';

export function makeEnv(sh: Shell, cfg: Config, vars: Record<string, any>): { env: Env; diags: Diag[] } {
  const diags: Diag[] = [];
  const { ctx } = buildCtx(sh, {}, false);
  let region = ctx.region;
  if (cfg.region) {
    try { region = String(evaluate(cfg.region, { resolve: (root, steps, ev) => (root === 'var' ? walkSteps(vars[(steps[0] as any).name], steps.slice(1), ev) : null) })); } catch { /* usa el perfil */ }
  }
  ctx.region = region;
  return { env: { ctx }, diags };
}

type Inst = { key?: string | number; each?: { key: any; value: any }; count?: number };

class Evaluator {
  memoLocals: Record<string, any> = {};
  busy = new Set<string>();
  values = new Map<string, any>(); // dirección base -> valor (único, lista o mapa)
  constructor(public cfg: Config, public vars: Record<string, any>, public sh: Shell) {}

  scope(): Scope {
    return {
      resolve: (root, steps, ev) => {
        const first = steps[0]?.k === 'attr' ? (steps[0] as any).name : undefined;
        if (root === 'var') {
          if (first === undefined || !(first in this.vars)) throw new EvalError('Reference to undeclared input variable', `An input variable with the name "${first}" has not been declared.`);
          return walkSteps(this.vars[first], steps.slice(1), ev);
        }
        if (root === 'local') return walkSteps(this.local(first!), steps.slice(1), ev);
        if (root === 'path') return first === 'module' || first === 'root' ? '.' : this.sh.cwd;
        if (root === 'terraform') return first === 'workspace' ? 'default' : null;
        if (root === 'data') {
          const addr = `data.${first}.${(steps[1] as any)?.name}`;
          if (!this.values.has(addr)) throw new EvalError('Reference to undeclared resource', `A data resource "${first}" "${(steps[1] as any)?.name}" has not been declared in the root module.`);
          return walkSteps(this.values.get(addr), steps.slice(2), ev);
        }
        const addr = `${root}.${first}`;
        if (!this.values.has(addr)) {
          if (this.cfg.resources.some((r) => r.addr === addr)) return UNKNOWN;
          throw new EvalError('Reference to undeclared resource', `A managed resource "${root}" "${first}" has not been declared in the root module.`);
        }
        return walkSteps(this.values.get(addr), steps.slice(1), ev);
      },
    };
  }
  local(name: string): any {
    if (name in this.memoLocals) return this.memoLocals[name];
    const l = this.cfg.locals[name];
    if (!l) throw new EvalError('Reference to undeclared local value', `A local value with the name "${name}" has not been declared.`);
    if (this.busy.has(name)) throw new EvalError('Cycle error', `Local value "${name}" depends on itself.`);
    this.busy.add(name);
    try { return (this.memoLocals[name] = evaluate(l.e, this.scope())); } finally { this.busy.delete(name); }
  }
  ev(e: Expr, loc: Record<string, any> = {}) { return evaluate(e, this.scope(), loc); }

  /** Instancias de un bloque: count, for_each o única. */
  instances(r: ResBlock): Inst[] {
    const cnt = r.body.attrs.count, fe = r.body.attrs.for_each;
    if (cnt) {
      const n = this.ev(cnt.e);
      if (n === UNKNOWN) throw new EvalError('Invalid count argument', 'The "count" value depends on resource attributes that cannot be determined until apply, so Terraform cannot predict how many instances will be created. To work around this, use the -target argument to first apply only the resources that the count depends on.');
      return Array.from({ length: Math.max(0, Number(n)) }, (_, i) => ({ key: i, count: i }));
    }
    if (fe) {
      const v = this.ev(fe.e);
      if (v === UNKNOWN) throw new EvalError('Invalid for_each argument', 'The "for_each" map includes keys derived from resource attributes that cannot be determined until apply, and so Terraform cannot determine the full set of keys that will identify the instances of this resource.');
      if (Array.isArray(v)) return v.map((x) => ({ key: String(x), each: { key: String(x), value: x } }));
      return Object.entries(v ?? {}).map(([k, x]) => ({ key: k, each: { key: k, value: x } }));
    }
    return [{}];
  }

  /** Atributos de una instancia a partir de su bloque (incluye bloques anidados como listas de objetos). */
  attrs(body: Body, inst: Inst, skipMeta: boolean): Attrs {
    const loc: Record<string, any> = {};
    if (inst.count !== undefined) loc.count = { index: inst.count };
    if (inst.each) loc.each = inst.each;
    return this.bodyAttrs(body, loc, skipMeta);
  }
  bodyAttrs(body: Body, loc: Record<string, any>, skipMeta: boolean): Attrs {
    const out: Attrs = {};
    for (const [k, a] of Object.entries(body.attrs)) {
      if (skipMeta && META.has(k)) continue;
      try { out[k] = this.ev(a.e, loc); } catch (e) { if (e instanceof EvalError) { e.line = e.line || a.line; throw e; } throw e; }
    }
    for (const b of body.blocks) {
      if (skipMeta && (b.type === 'lifecycle' || b.type === 'provisioner')) continue;
      if (b.type === 'dynamic') {
        const name = b.labels[0];
        const content = b.body.blocks.find((x) => x.type === 'content');
        const coll = this.ev(b.body.attrs.for_each.e, loc);
        if (coll === UNKNOWN || !content) continue;
        const it = b.body.attrs.iterator ? String((b.body.attrs.iterator.e as any).root ?? 'it') : name;
        const entries: [any, any][] = Array.isArray(coll) ? coll.map((v, i) => [i, v]) : Object.entries(coll ?? {});
        for (const [k, v] of entries) (out[name] ??= []).push(this.bodyAttrs(content.body, { ...loc, [it]: { key: k, value: v } }, false));
        continue;
      }
      (out[b.type] ??= []).push(this.bodyAttrs(b.body, loc, false));
    }
    return out;
  }
}

function depsOf(cfg: Config, r: ResBlock): string[] {
  const refs = bodyRefs(r.body);
  const dep = r.body.attrs.depends_on;
  if (dep) refsOf(dep.e, refs);
  const out = new Set<string>();
  const visitLocal = (name: string, seen: Set<string>) => {
    if (seen.has(name) || !cfg.locals[name]) return;
    seen.add(name);
    for (const x of refsOf(cfg.locals[name].e)) addRef(x, seen);
  };
  const addRef = (x: string, seen = new Set<string>()) => {
    const [root, a, b] = x.split('.');
    if (root === 'local') visitLocal(a, seen);
    else if (root === 'data') { if (cfg.resources.some((q) => q.addr === `data.${a}.${b}`)) out.add(`data.${a}.${b}`); }
    else if (cfg.resources.some((q) => q.addr === `${root}.${a}`)) out.add(`${root}.${a}`);
  };
  for (const x of refs) addRef(x);
  out.delete(r.addr);
  return [...out];
}

export function topo(nodes: { addr: string; deps: string[] }[]): { order: string[]; cycle?: string[] } {
  const by = new Map(nodes.map((n) => [n.addr, n]));
  const order: string[] = [];
  const mark = new Map<string, 1 | 2>();
  let cycle: string[] | undefined;
  const visit = (a: string, stack: string[]) => {
    if (cycle) return;
    const m = mark.get(a);
    if (m === 2) return;
    if (m === 1) { cycle = [...stack.slice(stack.indexOf(a)), a].slice(0, -1); return; }
    mark.set(a, 1);
    for (const d of by.get(a)?.deps ?? []) if (by.has(d)) visit(d, [...stack, a]);
    mark.set(a, 2);
    order.push(a);
  };
  for (const n of nodes) visit(n.addr, []);
  return { order, cycle };
}

const keyLabel = (k: string | number | undefined) => (k === undefined ? '' : typeof k === 'number' ? `[${k}]` : `["${k}"]`);

function diffAttrs(rt: RType, prior: Attrs, want: Attrs, ignore: string[]): { changed: string[]; replace: string[] } {
  const changed: string[] = [];
  const replace: string[] = [];
  for (const k of Object.keys(want)) {
    if (ignore.includes(k) || k === 'tags_all') continue;
    const w = want[k];
    if (w === undefined) continue;
    const p = prior[k];
    const same = emptyish(w) && emptyish(p) ? true : isJsonish(k) ? eq(w, p) : k === 'user_data' ? w === p : JSON.stringify(sortDeep(w)) === JSON.stringify(sortDeep(p)) && w !== UNKNOWN;
    if (!same && !(w === UNKNOWN && false)) { changed.push(k); if (rt.forceNew.includes(k)) replace.push(k); }
  }
  return { changed, replace };
}
const emptyish = (v: any) => v === undefined || v === null || (Array.isArray(v) && !v.length) || (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
const sortDeep = (v: any): any => (Array.isArray(v) ? v.map(sortDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])])) : v);

function lifecycle(r: ResBlock): { ignore: string[]; prevent: boolean } {
  const l = r.body.blocks.find((b) => b.type === 'lifecycle');
  const ig = l?.body.attrs.ignore_changes?.e;
  const ignore = ig && ig.t === 'list' ? ig.items.map((i) => (i.t === 'ref' ? i.root : i.t === 'lit' ? String(i.v) : '')) : [];
  const prev = l?.body.attrs.prevent_destroy?.e;
  return { ignore, prevent: !!(prev && prev.t === 'lit' && prev.v === true) };
}

export function buildPlan(sh: Shell, cfg: Config, vars: Record<string, any>, env: Env, state: State, opts: { destroy?: boolean; refresh?: boolean } = {}): Plan {
  const st: State = JSON.parse(JSON.stringify(state));
  const drift: Drift[] = [];

  // 1. Refresco: lee la nube y actualiza el estado.
  if (opts.refresh !== false) {
    for (const si of stateInstances(st)) {
      if (si.res.mode !== 'managed') continue;
      const rt = typeOf(si.res.type);
      if (!rt) continue;
      const cur = rt.read(env, si.inst.attributes);
      if (cur === null) {
        drift.push({ addr: si.addr, type: si.res.type, name: si.res.name, kind: 'deleted', before: clone(si.inst.attributes), changed: [] });
        removeInstance(st, 'managed', si.res.type, si.res.name, si.inst.index_key);
        continue;
      }
      const changed: string[] = [];
      const next = { ...si.inst.attributes };
      for (const [k, v] of Object.entries(cur)) {
        if ((rt.local ?? []).includes(k)) continue;
        if (emptyish(v) && emptyish(si.inst.attributes[k])) continue;
        const same = isJsonish(k) ? eq(v, si.inst.attributes[k]) : JSON.stringify(sortDeep(v)) === JSON.stringify(sortDeep(si.inst.attributes[k]));
        if (!same) { changed.push(k); next[k] = v; if (k === 'tags') next.tags_all = v && Object.keys(v).length ? { ...v } : undefined; }
      }
      if (changed.length) { drift.push({ addr: si.addr, type: si.res.type, name: si.res.name, kind: 'changed', before: clone(si.inst.attributes), after: clone(next), changed }); si.inst.attributes = next; }
    }
  }

  const ev = new Evaluator(cfg, vars, sh);
  const actions: Action[] = [];
  const nodes = cfg.resources.map((r) => ({ addr: r.addr, deps: depsOf(cfg, r) }));
  const { order, cycle } = topo(nodes);
  if (cycle) throw new TfFailure([dg('Cycle', `Cycle: ${cycle.join(', ')}`)]);
  const byAddr = new Map(cfg.resources.map((r) => [r.addr, r]));
  const wantedKeys = new Set<string>();

  if (opts.destroy) {
    for (const si of stateInstances(st)) if (si.res.mode === 'managed') {
      const rr = byAddr.get(si.base);
      if (rr && lifecycle(rr).prevent) throw new TfFailure([dg('Instance cannot be destroyed', `Resource ${si.addr} has lifecycle.prevent_destroy set, but the plan calls for this resource to be destroyed. To avoid this error and continue with the plan, either disable lifecycle.prevent_destroy or reduce the scope of the plan using the -target option.`, rr.file, rr.line, `resource "${rr.type}" "${rr.name}"`, si.addr)]);
      actions.push({ addr: si.addr, base: si.base, key: si.inst.index_key, res: byAddr.get(si.base) ?? null, type: si.res.type, name: si.res.name, kind: 'destroy', before: si.inst.attributes, replaceKeys: [], changed: [], deps: si.inst.dependencies });
    }
  } else {
    for (const a of order) {
      const r = byAddr.get(a)!;
      const ctxFail = (e: EvalError) => new TfFailure([dg(e.message, e.detail, r.file, e.line || r.line, `${r.mode === 'data' ? 'data' : 'resource'} "${r.type}" "${r.name}"`, r.addr)]);
      try {
        const insts = ev.instances(r);
        const multi = r.body.attrs.count ? 'list' : r.body.attrs.for_each ? 'map' : 'one';
        const vals: any[] = [];
        const valMap: Record<string, any> = {};
        for (const inst of insts) {
          const want = ev.attrs(r.body, inst, true);
          const full = addrOf(r, inst.key);
          wantedKeys.add(full);
          if (r.mode === 'data') {
            const dt = DATA[r.type];
            const hasUnknown = JSON.stringify(sortDeep(want), (_k, v) => (v === UNKNOWN ? '__u' : v)).includes('__u');
            const out = hasUnknown ? { ...want } : { ...want, ...dt.read(env, want) };
            if (!hasUnknown) setInstance(st, 'data', r.type, r.name, inst.key, out, depsOf(cfg, r));
            vals.push(out);
            if (inst.key !== undefined) valMap[String(inst.key)] = out;
            continue;
          }
          const rt = typeOf(r.type)!;
          const prior = stateInstances(st).find((x) => x.addr === full && x.res.mode === 'managed');
          const lc = lifecycle(r);
          let after: Attrs;
          if (!prior) {
            after = { ...(rt.defaults ?? {}), ...stripUndef(want) };
            for (const c of rt.computed) if (!(c in after) || after[c] === undefined) after[c] = UNKNOWN;
            if (after.tags && typeof after.tags === 'object' && Object.keys(after.tags).length) after.tags_all = { ...after.tags };
            actions.push({ addr: full, base: a, key: inst.key, res: r, type: r.type, name: r.name, kind: 'create', after, replaceKeys: [], changed: Object.keys(after), deps: nodes.find((n) => n.addr === a)!.deps });
          } else {
            const pa = prior.inst.attributes;
            const { changed, replace } = diffAttrs(rt, pa, normalizeWant(rt, want), lc.ignore);
            if (!changed.length) after = pa;
            else if (replace.length) {
              if (lc.prevent) throw new TfFailure([dg('Instance cannot be destroyed', `Resource ${full} has lifecycle.prevent_destroy set, but the plan calls for this resource to be destroyed. To avoid this error and continue with the plan, either disable lifecycle.prevent_destroy or reduce the scope of the plan using the -target option.`, r.file, r.line, `resource "${r.type}" "${r.name}"`, full)]);
              after = { ...(rt.defaults ?? {}), ...stripUndef(normalizeWant(rt, want)) };
              for (const c of rt.computed) if (!(c in want) || want[c] === undefined) after[c] = UNKNOWN;
              if (after.tags && Object.keys(after.tags).length) after.tags_all = { ...after.tags };
              actions.push({ addr: full, base: a, key: inst.key, res: r, type: r.type, name: r.name, kind: 'replace', before: pa, after, replaceKeys: replace, changed, deps: nodes.find((n) => n.addr === a)!.deps });
            } else {
              after = { ...pa, ...stripUndef(pick(normalizeWant(rt, want), changed)) };
              if (changed.includes('tags')) after.tags_all = after.tags && Object.keys(after.tags).length ? { ...after.tags } : undefined;
              actions.push({ addr: full, base: a, key: inst.key, res: r, type: r.type, name: r.name, kind: 'update', before: pa, after, replaceKeys: [], changed, deps: nodes.find((n) => n.addr === a)!.deps });
            }
          }
          vals.push(after);
          if (inst.key !== undefined) valMap[String(inst.key)] = after;
        }
        ev.values.set(a, multi === 'list' ? vals : multi === 'map' ? valMap : vals[0] ?? UNKNOWN);
      } catch (e) {
        if (e instanceof EvalError) throw ctxFail(e);
        throw e;
      }
    }
    // Recursos en el estado que ya no están en la configuración.
    for (const si of stateInstances(st)) {
      if (si.res.mode !== 'managed' || wantedKeys.has(si.addr)) continue;
      const r = byAddr.get(si.base);
      if (r && lifecycle(r).prevent) throw new TfFailure([dg('Instance cannot be destroyed', `Resource ${si.addr} has lifecycle.prevent_destroy set, but the plan calls for this resource to be destroyed. To avoid this error and continue with the plan, either disable lifecycle.prevent_destroy or reduce the scope of the plan using the -target option.`, r.file, r.line, `resource "${r.type}" "${r.name}"`, si.addr)]);
      actions.push({ addr: si.addr, base: si.base, key: si.inst.index_key, res: null, type: si.res.type, name: si.res.name, kind: 'destroy', before: si.inst.attributes, replaceKeys: [], changed: [], deps: si.inst.dependencies });
    }
  }

  // Salidas.
  const outputs: Plan['outputs'] = [];
  if (opts.destroy) {
    for (const [name, o] of Object.entries(st.outputs)) outputs.push({ name, before: o.value, after: undefined, sensitive: !!o.sensitive, status: 'destroy' });
  } else {
    for (const o of Object.values(cfg.outputs)) {
      let val: any;
      try { val = ev.ev(o.value); } catch (e) { if (e instanceof EvalError) throw new TfFailure([dg(e.message, e.detail, o.file, e.line || o.line, `output "${o.name}"`)]); throw e; }
      const prev = st.outputs[o.name];
      if (!prev) outputs.push({ name: o.name, before: undefined, after: val, sensitive: o.sensitive, status: 'create' });
      else if (val === UNKNOWN || !sameJson(prev.value, val)) outputs.push({ name: o.name, before: prev.value, after: val, sensitive: o.sensitive, status: 'update' });
    }
    for (const [name, o] of Object.entries(st.outputs)) if (!(name in cfg.outputs)) outputs.push({ name, before: o.value, after: undefined, sensitive: !!o.sensitive, status: 'destroy' });
  }
  const counts = { add: 0, change: 0, destroy: 0 };
  for (const a of actions) { if (a.kind === 'create') counts.add++; else if (a.kind === 'update') counts.change++; else if (a.kind === 'destroy') counts.destroy++; else { counts.add++; counts.destroy++; } }
  return { actions, drift, outputs, state: st, config: cfg, vars, counts };
}

function stripUndef(a: Attrs): Attrs { return Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)); }
function pick(a: Attrs, keys: string[]): Attrs { return Object.fromEntries(keys.map((k) => [k, a[k]])); }
/** Normaliza bloques con semántica propia (reglas de SG, rutas) antes de comparar. */
function normalizeWant(rt: RType, want: Attrs): Attrs {
  const w = { ...want };
  for (const k of ['ingress', 'egress']) if (Array.isArray(w[k]) && rt.blocks[k]) w[k] = normRules(w[k].map((r: Attrs) => ({ ...r, security_groups: r.security_groups ?? [], cidr_blocks: r.cidr_blocks ?? [] })));
  if (Array.isArray(w.route)) w.route = w.route.map((r: Attrs) => ({ cidr_block: r.cidr_block, ...(r.nat_gateway_id ? { nat_gateway_id: r.nat_gateway_id } : { gateway_id: r.gateway_id }) })).sort((a: Attrs, b: Attrs) => `${a.cidr_block}`.localeCompare(`${b.cidr_block}`));
  return w;
}

// ------------------------------------------------------------------ aplicar

export interface ApplyEvents {
  start(a: Action, phase: 'create' | 'update' | 'destroy'): void;
  done(a: Action, phase: 'create' | 'update' | 'destroy', id: string, secs: number): void;
}
export interface ApplyResult { error?: { action: Action; err: unknown }; added: number; changed: number; destroyed: number }

const SECS: Record<string, number> = { aws_instance: 13, aws_security_group: 2, aws_cloudtrail: 2, aws_vpc: 1, aws_internet_gateway: 1, aws_route_table: 1, aws_kms_key: 1, aws_s3_bucket: 1, aws_nat_gateway: 90 };
const secsFor = (t: string, phase: string) => (phase === 'destroy' ? (t === 'aws_instance' ? 30 : t === 'aws_vpc' || t === 'aws_s3_bucket' ? 1 : 0) : (SECS[t] ?? 0));

/** Resuelve UNKNOWN con los atributos reales ya creados y aplica la acción. */
export function applyPlan(sh: Shell, plan: Plan, env: Env, ev: ApplyEvents, destroyAll = false): ApplyResult {
  const { config: cfg, vars } = plan;
  const st = plan.state;
  const res: ApplyResult = { added: 0, changed: 0, destroyed: 0 };
  const evaluator = new Evaluator(cfg, vars, sh);
  const byAddr = new Map(cfg.resources.map((r) => [r.addr, r]));
  const destroyOrder = (list: Action[]): Action[] => {
    const nodes = list.map((a) => ({ addr: a.addr, deps: [] as string[] }));
    const base = new Map(list.map((a) => [a.base, a]));
    // Un recurso se destruye antes que aquello de lo que depende.
    for (const a of list) for (const d of a.deps) for (const b of list.filter((x) => x.base === d)) nodes.find((n) => n.addr === b.addr)!.deps.push(a.addr);
    void base;
    return topo(nodes).order.map((x) => list.find((a) => a.addr === x)!);
  };
  const doDestroy = (a: Action): boolean => {
    const rt = typeOf(a.type)!;
    ev.start(a, 'destroy');
    try { rt.destroy(env, a.before!); } catch (err) { res.error = { action: a, err }; return false; }
    removeInstance(st, 'managed', a.type, a.name, a.key);
    res.destroyed++;
    ev.done(a, 'destroy', a.before!.id, secsFor(a.type, 'destroy'));
    return true;
  };
  const destroys = destroyOrder(plan.actions.filter((a) => a.kind === 'destroy'));
  const creates = plan.actions.filter((a) => a.kind !== 'destroy');
  if (destroyAll) {
    for (const a of destroys) if (!doDestroy(a)) return res;
    return res;
  }
  // Los reemplazos destruyen primero (dependientes antes que dependencias) y luego recrean.
  for (const a of destroyOrder(creates.filter((x) => x.kind === 'replace').map((x) => ({ ...x, kind: 'destroy' as const, after: undefined })))) if (!doDestroy(a)) return res;
  // Orden de aplicación: creaciones y cambios por dependencias; destrucciones sin uso al final.
  const nodes = creates.map((a) => ({ addr: a.addr, deps: a.deps.flatMap((d) => creates.filter((x) => x.base === d).map((x) => x.addr)) }));
  const ordered = topo(nodes).order.map((x) => creates.find((a) => a.addr === x)!);
  // Valores reales de los recursos ya existentes (los desconocidos se rellenan al crearlos).
  const known = new Map<string, any>();
  for (const si of stateInstances(st)) if (si.res.mode === 'managed') pushVal(known, si.base, si.inst.index_key, si.inst.attributes);
  for (const si of stateInstances(st)) if (si.res.mode === 'data') pushVal(known, si.base, si.inst.index_key, si.inst.attributes);
  for (const a of ordered) {
    const rt = typeOf(a.type)!;
    const r = byAddr.get(a.base)!;
    // Reevalúa con los valores reales de las dependencias.
    evaluator.values = new Map(known);
    let want: Attrs;
    try {
      const inst: Inst = a.key === undefined ? {} : typeof a.key === 'number' ? { key: a.key, count: a.key } : { key: a.key, each: forEachItem(evaluator, r, a.key) };
      want = normalizeWant(rt, evaluator.attrs(r.body, inst, true));
    } catch (e) {
      if (e instanceof EvalError) { res.error = { action: a, err: new TfFailure([dg(e.message, e.detail, r.file, e.line || r.line, `resource "${r.type}" "${r.name}"`, a.addr)]) }; return res; }
      throw e;
    }
    const deps = a.deps;
    const phase = a.kind === 'update' ? 'update' : 'create';
    ev.start(a, phase);
    try {
      let out: Attrs;
      if (a.kind === 'update') out = rt.update(env, a.before!, { ...a.before!, ...stripUndef(pickKeys(want, a.changed)) });
      else out = rt.create(env, stripUndef(want));
      setInstance(st, 'managed', a.type, a.name, a.key, out, deps);
      pushVal(known, a.base, a.key, out);
      if (a.kind === 'update') res.changed++; else res.added++;
      ev.done(a, phase, out.id, secsFor(a.type, phase));
    } catch (err) {
      res.error = { action: a, err };
      return res;
    }
  }
  for (const a of destroys) if (!doDestroy(a)) return res;
  return res;
}
const pickKeys = (a: Attrs, keys: string[]) => Object.fromEntries(keys.map((k) => [k, a[k]]));
function pushVal(m: Map<string, any>, base: string, key: string | number | undefined, v: any) {
  if (key === undefined) { m.set(base, v); return; }
  if (typeof key === 'number') { const l = Array.isArray(m.get(base)) ? m.get(base) : []; l[key] = v; m.set(base, l); return; }
  const o = m.get(base) && !Array.isArray(m.get(base)) ? m.get(base) : {};
  o[key] = v;
  m.set(base, o);
}
function forEachItem(ev: Evaluator, r: ResBlock, key: string) {
  const v = ev.ev(r.body.attrs.for_each.e);
  if (Array.isArray(v)) return { key, value: v.find((x) => String(x) === key) };
  return { key, value: v[key] };
}

/** Calcula las salidas finales tras aplicar. */
export function computeOutputs(sh: Shell, cfg: Config, vars: Record<string, any>, st: State): { name: string; value: any; sensitive: boolean }[] {
  const ev = new Evaluator(cfg, vars, sh);
  for (const si of stateInstances(st)) pushVal(ev.values, si.base, si.inst.index_key, si.inst.attributes);
  const out: { name: string; value: any; sensitive: boolean }[] = [];
  for (const o of Object.values(cfg.outputs)) {
    try { out.push({ name: o.name, value: ev.ev(o.value), sensitive: o.sensitive }); } catch (e) { if (e instanceof EvalError) throw new TfFailure([dg(e.message, e.detail, o.file, o.line, `output "${o.name}"`)]); throw e; }
  }
  return out;
}

export function apiErrorText(err: TfApiError, noun: string, kind: 'create' | 'update' | 'destroy', id?: string): string {
  const verb = kind === 'create' ? 'creating' : kind === 'update' ? 'updating' : 'deleting';
  const rid = guid().toUpperCase().replace(/-/g, '').slice(0, 16);
  return `${verb} ${noun}${id ? ` (${id})` : ''}: operation error ${err.service}: ${err.op}, https response error StatusCode: ${err.status}, RequestID: ${rid}, api error ${err.code}: ${err.msg}`;
}
void now;
void AZ_LETTERS;

// CloudFormation: lectura de plantillas (JSON y YAML con etiquetas abreviadas), validación estática y evaluación de
// funciones intrínsecas (Ref, Fn::GetAtt, Fn::Sub, Fn::Join, Fn::If...). No toca el estado de la nube.
import yaml from 'js-yaml';
import { AwsError } from '../errors';
import { azsOf } from '../catalog';

export type Json = any;
export interface ParamDef { Type?: string; Default?: any; Description?: string; AllowedValues?: any[]; AllowedPattern?: string; MinLength?: number; MaxLength?: number; MinValue?: number; MaxValue?: number; NoEcho?: boolean | string; ConstraintDescription?: string }
export interface ResDef { Type: string; Properties?: Record<string, Json>; DependsOn?: string | string[]; Condition?: string; DeletionPolicy?: string; UpdateReplacePolicy?: string; Metadata?: Json }
export interface Template {
  AWSTemplateFormatVersion?: string;
  Description?: string;
  Parameters?: Record<string, ParamDef>;
  Mappings?: Record<string, Record<string, Record<string, Json>>>;
  Conditions?: Record<string, Json>;
  Resources: Record<string, ResDef>;
  Outputs?: Record<string, { Value: Json; Description?: string; Export?: { Name: Json }; Condition?: string }>;
  [k: string]: Json;
}

export const tplError = (msg: string) => new AwsError('ValidationError', `Template format error: ${msg}`, 400);
export const valError = (msg: string) => new AwsError('ValidationError', msg, 400);

// ------------------------------------------------------------------ lectura (JSON / YAML)

const SHORT: [string, string][] = [
  ['Ref', 'Ref'], ['Condition', 'Condition'], ['Sub', 'Fn::Sub'], ['Join', 'Fn::Join'], ['If', 'Fn::If'], ['Equals', 'Fn::Equals'], ['Not', 'Fn::Not'], ['And', 'Fn::And'], ['Or', 'Fn::Or'],
  ['FindInMap', 'Fn::FindInMap'], ['Select', 'Fn::Select'], ['Split', 'Fn::Split'], ['GetAZs', 'Fn::GetAZs'], ['Base64', 'Fn::Base64'], ['ImportValue', 'Fn::ImportValue'], ['Cidr', 'Fn::Cidr'], ['Length', 'Fn::Length'], ['ToJsonString', 'Fn::ToJsonString'],
];
const types: yaml.Type[] = [];
for (const [short, full] of SHORT) for (const kind of ['scalar', 'sequence', 'mapping'] as const) types.push(new yaml.Type('!' + short, { kind, construct: (d: any) => ({ [full]: d ?? '' }) }));
// !GetAtt Recurso.Atributo  ==  Fn::GetAtt: [Recurso, Atributo]
types.push(new yaml.Type('!GetAtt', { kind: 'scalar', construct: (d: string) => { const i = String(d).indexOf('.'); return { 'Fn::GetAtt': i < 0 ? [d, ''] : [d.slice(0, i), d.slice(i + 1)] }; } }));
types.push(new yaml.Type('!GetAtt', { kind: 'sequence', construct: (d: any) => ({ 'Fn::GetAtt': d }) }));
const SCHEMA = yaml.DEFAULT_SCHEMA.extend(types);

function lineCol(text: string, pos: number): [number, number] {
  const before = text.slice(0, Math.max(0, Math.min(pos, text.length)));
  const lines = before.split('\n');
  return [lines.length, lines[lines.length - 1].length + 1];
}

/** Interpreta el cuerpo de una plantilla: JSON si empieza por «{», YAML en otro caso. */
export function parseTemplate(body: string): { tpl: Template; format: 'JSON' | 'YAML' } {
  const text = String(body ?? '');
  if (!text.trim()) throw valError('Template format error: Template body is empty.');
  let obj: any;
  let format: 'JSON' | 'YAML';
  if (text.trimStart().startsWith('{')) {
    format = 'JSON';
    try {
      obj = JSON.parse(text);
    } catch (e) {
      const m = /position (\d+)/.exec((e as Error).message);
      const [l, c] = m ? lineCol(text, Number(m[1])) : (() => { const x = /line (\d+) column (\d+)/.exec((e as Error).message); return x ? [Number(x[1]), Number(x[2])] as [number, number] : ([1, 1] as [number, number]); })();
      throw tplError(`JSON not well-formed. (line ${l}, column ${c})`);
    }
  } else {
    format = 'YAML';
    try {
      obj = yaml.load(text, { schema: SCHEMA });
    } catch (e) {
      const mark = (e as any).mark;
      throw tplError(`YAML not well-formed. (line ${mark ? mark.line + 1 : 1}, column ${mark ? mark.column + 1 : 1})`);
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw tplError('The template must be a JSON or YAML object.');
  return { tpl: obj as Template, format };
}

// ------------------------------------------------------------------ referencias estáticas

const PSEUDO = new Set(['AWS::Region', 'AWS::AccountId', 'AWS::StackName', 'AWS::StackId', 'AWS::NoValue', 'AWS::Partition', 'AWS::URLSuffix', 'AWS::NotificationARNs']);
export const isPseudo = (n: string) => PSEUDO.has(n);

interface Refs { refs: Set<string>; conds: Set<string>; imports: boolean }
/** Recorre un valor y recoge los nombres lógicos a los que apunta (Ref, GetAtt, Sub, If, Condition). */
export function collectRefs(v: Json, out: Refs = { refs: new Set(), conds: new Set(), imports: false }): Refs {
  if (Array.isArray(v)) v.forEach((x) => collectRefs(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'Ref' && typeof x === 'string') out.refs.add(x);
      else if (k === 'Condition' && typeof x === 'string') out.conds.add(x);
      else if (k === 'Fn::GetAtt') out.refs.add(String(Array.isArray(x) ? x[0] : String(x).split('.')[0]));
      else if (k === 'Fn::If' && Array.isArray(x)) { out.conds.add(String(x[0])); x.slice(1).forEach((y) => collectRefs(y, out)); }
      else if (k === 'Fn::Sub') {
        const [str, map] = Array.isArray(x) ? x : [x, {}];
        for (const m of String(str).matchAll(/\$\{([^}]+)\}/g)) if (!m[1].startsWith('!') && !(m[1] in (map ?? {}))) out.refs.add(m[1].split('.')[0]);
        collectRefs(map, out);
      } else if (k === 'Fn::ImportValue') { out.imports = true; collectRefs(x, out); } else collectRefs(x, out);
    }
  }
  return out;
}

function collectGetAtts(v: Json, out: [string, string][] = []): [string, string][] {
  if (Array.isArray(v)) v.forEach((x) => collectGetAtts(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'Fn::GetAtt') { const [r, a] = Array.isArray(x) ? x : String(x).split(/\.(.*)/s); if (typeof a === 'string') out.push([String(r), a]); } else collectGetAtts(x, out);
    }
  }
  return out;
}

export const asList = (v: Json): string[] => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

export interface Analysis {
  /** Orden de creación (dependencias primero). */
  order: string[];
  /** Dependencias directas de cada recurso (solo recursos de la plantilla). */
  deps: Record<string, string[]>;
}

/** Valida la estructura y las referencias. Lanza «Template format error» como CloudFormation. */
export function analyze(tpl: Template, isKnownType: (t: string) => boolean, attrsOf: (t: string) => string[]): Analysis {
  const res = tpl.Resources;
  if (!res || typeof res !== 'object' || !Object.keys(res).length) throw tplError('At least one Resources member must be defined.');
  const known = new Set(['AWSTemplateFormatVersion', 'Description', 'Metadata', 'Parameters', 'Mappings', 'Conditions', 'Transform', 'Resources', 'Outputs', 'Rules', 'Hooks']);
  const extra = Object.keys(tpl).filter((k) => !known.has(k));
  if (extra.length) throw tplError(`Template contains unrecognized sections: [${extra.join(', ')}]`);
  if (tpl.Transform) throw tplError('Transforms (AWS::Serverless, AWS::Include...) are not supported by this simulator.');
  const params = new Set(Object.keys(tpl.Parameters ?? {}));
  const conds = new Set(Object.keys(tpl.Conditions ?? {}));
  for (const [n, r] of Object.entries(res)) {
    if (!/^[A-Za-z0-9]+$/.test(n)) throw tplError(`Resource name ${n} is non alphanumeric.`);
    if (!r || typeof r !== 'object' || !r.Type) throw tplError(`[/Resources/${n}] Every Resources object must contain a Type member.`);
  }
  const bad = Object.entries(res).filter(([, r]) => !isKnownType(r.Type)).map(([, r]) => r.Type);
  if (bad.length) throw tplError(`Unrecognized resource types: [${[...new Set(bad)].join(', ')}]`);
  const deps: Record<string, string[]> = {};
  const unresolved = new Set<string>();
  const unresolvedConds = new Set<string>();
  for (const [n, r] of Object.entries(res)) {
    const c = collectRefs(r.Properties ?? {});
    for (const d of asList(r.DependsOn)) { if (!res[d]) unresolved.add(d); c.refs.add(d); }
    if (r.Condition) c.conds.add(r.Condition);
    const mine = new Set<string>();
    for (const ref of c.refs) {
      if (res[ref]) { if (ref !== n) mine.add(ref); else throw valError(`Circular dependency between resources: [${n}]`); } else if (!params.has(ref) && !PSEUDO.has(ref)) unresolved.add(ref);
    }
    for (const cd of c.conds) if (!conds.has(cd)) unresolvedConds.add(cd);
    deps[n] = [...mine];
    // GetAtt solo a atributos que el tipo expone.
    for (const [rn, at] of collectGetAtts(r.Properties ?? {})) {
      const target = res[rn];
      if (target && at && !attrsOf(target.Type).includes(at)) throw valError(`Template error: resource ${rn} does not support attribute type ${at} in Fn::GetAtt`);
    }
  }
  if (unresolved.size) throw tplError(`Unresolved resource dependencies [${[...unresolved].join(', ')}] in the Resources block of the template`);
  if (unresolvedConds.size) throw tplError(`Unresolved condition dependencies [${[...unresolvedConds].join(', ')}] in the Resources block of the template`);
  for (const [n, o] of Object.entries(tpl.Outputs ?? {})) {
    if (!o || o.Value === undefined) throw tplError(`Every Outputs member must contain a Value object [${n}]`);
    const c = collectRefs(o.Value);
    const un = [...c.refs].filter((r) => !res[r] && !params.has(r) && !PSEUDO.has(r));
    if (un.length) throw tplError(`Unresolved resource dependencies [${un.join(', ')}] in the Outputs block of the template`);
    for (const [rn, at] of collectGetAtts(o.Value)) if (res[rn] && at && !attrsOf(res[rn].Type).includes(at)) throw valError(`Template error: resource ${rn} does not support attribute type ${at} in Fn::GetAtt`);
  }
  // Orden topológico con detección de ciclos.
  const order: string[] = [];
  const state: Record<string, 1 | 2> = {};
  const stack: string[] = [];
  const visit = (n: string) => {
    if (state[n] === 2) return;
    if (state[n] === 1) throw valError(`Circular dependency between resources: [${[...stack.slice(stack.indexOf(n)), n].filter((x, i, a) => a.indexOf(x) === i).join(', ')}]`);
    state[n] = 1; stack.push(n);
    for (const d of deps[n]) visit(d);
    stack.pop(); state[n] = 2; order.push(n);
  };
  Object.keys(res).forEach(visit);
  return { order, deps };
}

// ------------------------------------------------------------------ parámetros

export interface ParamInput { ParameterKey: string; ParameterValue?: string; UsePreviousValue?: boolean }
export interface ResolvedParam { key: string; value: string; noEcho: boolean; type: string; description?: string }

const isListType = (t = 'String') => t === 'CommaDelimitedList' || t.startsWith('List<') || t.endsWith('CommaDelimitedList');

/** Combina los valores recibidos con los predeterminados y valida las restricciones. */
export function resolveParameters(tpl: Template, input: ParamInput[] = [], prev: Record<string, string> = {}): ResolvedParam[] {
  const defs = tpl.Parameters ?? {};
  const unknown = input.filter((i) => !(i.ParameterKey in defs)).map((i) => i.ParameterKey);
  if (unknown.length) throw valError(`Parameters: [${unknown.join(', ')}] do not exist in the template`);
  const out: ResolvedParam[] = [];
  const missing: string[] = [];
  for (const [k, d] of Object.entries(defs)) {
    const given = input.find((i) => i.ParameterKey === k);
    let v: any = given?.UsePreviousValue ? prev[k] : given?.ParameterValue;
    if (v === undefined || v === null) v = given?.UsePreviousValue ? undefined : d.Default;
    if (v === undefined) { missing.push(k); continue; }
    const s = Array.isArray(v) ? v.join(',') : String(v);
    const type = d.Type ?? 'String';
    const fail = (m: string) => valError(`Parameter '${k}' ${m}`);
    if (d.AllowedValues && !d.AllowedValues.map(String).includes(s)) throw fail('must be one of AllowedValues');
    if (d.AllowedPattern && !new RegExp(`^(?:${d.AllowedPattern})$`).test(s)) throw fail(`must match pattern ${d.AllowedPattern}`);
    if (d.MinLength !== undefined && s.length < Number(d.MinLength)) throw fail(`must contain at least ${d.MinLength} characters`);
    if (d.MaxLength !== undefined && s.length > Number(d.MaxLength)) throw fail(`must contain at most ${d.MaxLength} characters`);
    if (type === 'Number' || type === 'List<Number>') {
      for (const part of type === 'Number' ? [s] : s.split(',')) if (part.trim() === '' || Number.isNaN(Number(part))) throw valError(`Parameter '${k}' must be a number`);
      if (type === 'Number' && d.MinValue !== undefined && Number(s) < Number(d.MinValue)) throw fail(`must be greater than or equal to ${d.MinValue}`);
      if (type === 'Number' && d.MaxValue !== undefined && Number(s) > Number(d.MaxValue)) throw fail(`must be less than or equal to ${d.MaxValue}`);
    }
    out.push({ key: k, value: s, noEcho: d.NoEcho === true || d.NoEcho === 'true', type, description: d.Description });
  }
  if (missing.length) throw valError(`Parameters: [${missing.join(', ')}] must have values`);
  return out;
}

// ------------------------------------------------------------------ evaluación

export const NOVALUE = Symbol('AWS::NoValue');

export interface EvalEnv {
  params: Record<string, string>;
  paramTypes: Record<string, string>;
  pseudo: Record<string, string>;
  mappings: Template['Mappings'];
  conditions: Record<string, boolean>;
  /** Identificador físico de un recurso ya creado. */
  physical(logical: string): string;
  attr(logical: string, attr: string): string;
  importValue(name: string): string;
  resourceExists(logical: string): boolean;
}

const stringify = (v: Json): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function evalValue(v: Json, env: EvalEnv): Json {
  const r = ev(v, env);
  return strip(r);
}
function strip(v: Json): Json {
  if (v === NOVALUE) return undefined;
  if (Array.isArray(v)) return v.filter((x) => x !== NOVALUE).map(strip);
  if (v && typeof v === 'object') {
    const o: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v)) if (x !== NOVALUE) o[k] = strip(x);
    return o;
  }
  return v;
}

function ev(v: Json, env: EvalEnv): Json {
  if (Array.isArray(v)) return v.map((x) => ev(x, env));
  if (!v || typeof v !== 'object') return v;
  const keys = Object.keys(v);
  if (keys.length === 1) {
    const k = keys[0];
    const a = v[k];
    switch (k) {
      case 'Ref': return ref(String(a), env);
      case 'Fn::GetAtt': {
        const [r, at] = Array.isArray(a) ? a : String(a).split(/\.(.*)/s);
        return env.attr(String(r), String(ev(at, env)));
      }
      case 'Fn::Join': {
        const [d, list] = a as [string, Json];
        return (ev(list, env) as Json[]).filter((x) => x !== NOVALUE).map(stringify).join(String(d));
      }
      case 'Fn::Sub': {
        const [str, map] = Array.isArray(a) ? a : [a, {}];
        const vars: Record<string, Json> = {};
        for (const [n, x] of Object.entries(map ?? {})) vars[n] = ev(x, env);
        return String(str).replace(/\$\{([^}]+)\}/g, (_m, name: string) => {
          if (name.startsWith('!')) return '${' + name.slice(1) + '}';
          if (name in vars) return stringify(vars[name]);
          if (name.includes('.')) { const i = name.indexOf('.'); return env.attr(name.slice(0, i), name.slice(i + 1)); }
          return stringify(ref(name, env));
        });
      }
      case 'Fn::Select': {
        const [i, list] = a as [Json, Json];
        const l = ev(list, env) as Json[];
        const idx = Number(ev(i, env));
        if (!Array.isArray(l) || !(idx in l)) throw valError(`Template error: Fn::Select cannot select nonexistent value at index ${idx}`);
        return l[idx];
      }
      case 'Fn::Split': return stringify(ev((a as Json[])[1], env)).split(String((a as Json[])[0]));
      case 'Fn::GetAZs': { const r = stringify(ev(a, env)) || env.pseudo['AWS::Region']; return azsOf(r); }
      case 'Fn::Base64': return btoa(unescape(encodeURIComponent(stringify(ev(a, env)))));
      case 'Fn::Length': return (ev(a, env) as Json[]).length;
      case 'Fn::ToJsonString': return JSON.stringify(ev(a, env));
      case 'Fn::FindInMap': {
        const [m, k1, k2] = (a as Json[]).map((x) => stringify(ev(x, env)));
        const val = env.mappings?.[m]?.[k1]?.[k2];
        if (val === undefined) throw valError(`Template error: Unable to get mapping for ${m}::${k1}::${k2}`);
        return val;
      }
      case 'Fn::ImportValue': return env.importValue(stringify(ev(a, env)));
      case 'Fn::If': {
        const [c, t, f] = a as Json[];
        return ev(cond(String(c), env) ? t : f, env);
      }
      case 'Fn::Equals': case 'Fn::Not': case 'Fn::And': case 'Fn::Or': case 'Condition': return evalCondition(v, env);
    }
  }
  const o: Record<string, Json> = {};
  for (const [k, x] of Object.entries(v)) o[k] = ev(x, env);
  return o;
}

function ref(name: string, env: EvalEnv): Json {
  if (name === 'AWS::NoValue') return NOVALUE;
  if (name in env.pseudo) return env.pseudo[name];
  if (name in env.params) return isListType(env.paramTypes[name]) ? env.params[name].split(',').map((x) => x.trim()) : env.params[name];
  if (env.resourceExists(name)) return env.physical(name);
  throw valError(`Template error: unresolved reference ${name}`);
}

function cond(name: string, env: EvalEnv): boolean {
  if (!(name in env.conditions)) throw tplError(`Unresolved condition dependencies [${name}] in the Resources block of the template`);
  return env.conditions[name];
}

export function evalCondition(c: Json, env: EvalEnv): boolean {
  const [k] = Object.keys(c);
  const a = c[k];
  switch (k) {
    case 'Fn::Equals': return stringify(ev(a[0], env)) === stringify(ev(a[1], env));
    case 'Fn::Not': return !evalCondition(a[0], env);
    case 'Fn::And': return (a as Json[]).every((x) => evalCondition(x, env));
    case 'Fn::Or': return (a as Json[]).some((x) => evalCondition(x, env));
    case 'Condition': return cond(String(a), env);
  }
  throw tplError(`Invalid condition: ${JSON.stringify(c)}`);
}

/** Evalúa todas las condiciones de la plantilla (pueden referirse unas a otras). */
export function evalConditions(tpl: Template, env: Omit<EvalEnv, 'conditions'>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const full = { ...env, conditions: out } as EvalEnv;
  const defs = tpl.Conditions ?? {};
  const todo = new Set(Object.keys(defs));
  for (let guard = 0; todo.size && guard < 50; guard++) {
    for (const n of [...todo]) {
      try { out[n] = evalCondition(defs[n], full); todo.delete(n); } catch (e) { if (guard > 40) throw e; }
    }
  }
  return out;
}

export const stableJson = (v: Json): string => JSON.stringify(sortKeys(v));
function sortKeys(v: Json): Json {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

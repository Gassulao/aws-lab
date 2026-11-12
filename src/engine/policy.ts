// Motor de evaluación de políticas IAM: Allow/Deny explícitos, denegación implícita, NotAction/NotResource,
// condiciones habituales, variables de política y límites de permisos.
import type { PolicyDocument, PolicyStatement } from './types';
import { wildcardMatch } from './util';
import { AwsError } from './errors';

export type Decision = 'Allow' | 'ImplicitDeny' | 'ExplicitDeny';

export interface EvalRequest {
  action: string; // "s3:GetObject"
  resource: string; // ARN o "*"
  context?: Record<string, string | string[] | boolean | number>;
  /** Políticas de identidad (usuario, grupos, rol). */
  identity: PolicyDocument[];
  /** Límite de permisos: si existe, también debe permitir. */
  boundary?: PolicyDocument;
  /** Política de sesión (AssumeRole con --policy). */
  session?: PolicyDocument;
  /** Política de recurso (bucket policy, trust policy...). */
  resourcePolicy?: PolicyDocument;
  /** ARN del principal, para evaluar Principal en políticas de recurso. */
  principalArn?: string;
  /** Misma cuenta que el recurso. */
  sameAccount?: boolean;
  /** Políticas de control de servicios (SCP) por nivel (raíz, unidades organizativas, cuenta). Cada nivel debe permitir y ninguno puede denegar. */
  scp?: PolicyDocument[][];
}

export interface EvalResult {
  decision: Decision;
  /** Sentencia que decidió (Sid o índice). */
  matched?: string;
  /** La decisión la tomó una política de control de servicios (SCP). */
  via?: 'scp';
}

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export function statements(doc: PolicyDocument | undefined): PolicyStatement[] {
  if (!doc) return [];
  return asArray(doc.Statement);
}

function subst(v: string, ctx: Record<string, any>): string {
  return v.replace(/\$\{([^}]+)\}/g, (_, k: string) => {
    const hit = Object.entries(ctx).find(([key]) => key.toLowerCase() === k.toLowerCase());
    return hit ? String(hit[1]) : '';
  });
}

function ctxGet(ctx: Record<string, any>, key: string): any {
  const hit = Object.entries(ctx).find(([k]) => k.toLowerCase() === key.toLowerCase());
  return hit ? hit[1] : undefined;
}

function ipToInt(ip: string): number | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return null;
  return ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4];
}

export function cidrContains(cidr: string, ip: string): boolean {
  const [base, bitsStr] = cidr.split('/');
  const bits = bitsStr === undefined ? 32 : Number(bitsStr);
  const b = ipToInt(base);
  const i = ipToInt(ip);
  if (b === null || i === null || Number.isNaN(bits)) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((b & mask) >>> 0) === ((i & mask) >>> 0);
}

function condMatchOne(op: string, actual: any, expected: string): boolean {
  const a = String(actual);
  switch (op) {
    case 'StringEquals':
      return a === expected;
    case 'StringNotEquals':
      return a !== expected;
    case 'StringEqualsIgnoreCase':
      return a.toLowerCase() === expected.toLowerCase();
    case 'StringLike':
      return wildcardMatch(expected, a);
    case 'StringNotLike':
      return !wildcardMatch(expected, a);
    case 'ArnEquals':
    case 'ArnLike':
      return wildcardMatch(expected, a);
    case 'ArnNotEquals':
    case 'ArnNotLike':
      return !wildcardMatch(expected, a);
    case 'Bool':
      return a.toLowerCase() === expected.toLowerCase();
    case 'IpAddress':
      return cidrContains(expected, a);
    case 'NotIpAddress':
      return !cidrContains(expected, a);
    case 'NumericEquals':
      return Number(a) === Number(expected);
    case 'NumericNotEquals':
      return Number(a) !== Number(expected);
    case 'NumericLessThan':
      return Number(a) < Number(expected);
    case 'NumericLessThanEquals':
      return Number(a) <= Number(expected);
    case 'NumericGreaterThan':
      return Number(a) > Number(expected);
    case 'NumericGreaterThanEquals':
      return Number(a) >= Number(expected);
    case 'DateLessThan':
      return new Date(a).getTime() < new Date(expected).getTime();
    case 'DateGreaterThan':
      return new Date(a).getTime() > new Date(expected).getTime();
    default:
      throw new AwsError('MalformedPolicyDocument', `Unsupported condition operator ${op}`);
  }
}

const NEGATED = new Set(['StringNotEquals', 'StringNotLike', 'ArnNotEquals', 'ArnNotLike', 'NotIpAddress', 'NumericNotEquals']);

function conditionsHold(cond: PolicyStatement['Condition'], ctx: Record<string, any>): boolean {
  if (!cond) return true;
  for (const [rawOp, block] of Object.entries(cond)) {
    let op = rawOp;
    let ifExists = false;
    if (op.endsWith('IfExists')) {
      ifExists = true;
      op = op.slice(0, -8);
    }
    let setOp: 'ForAnyValue' | 'ForAllValues' | null = null;
    if (op.startsWith('ForAnyValue:')) {
      setOp = 'ForAnyValue';
      op = op.slice(12);
    } else if (op.startsWith('ForAllValues:')) {
      setOp = 'ForAllValues';
      op = op.slice(13);
    }
    for (const [key, vals] of Object.entries(block)) {
      const actual = ctxGet(ctx, key);
      if (op === 'Null') {
        const want = String(asArray(vals)[0]).toLowerCase() === 'true';
        if ((actual === undefined) !== want) return false;
        continue;
      }
      if (actual === undefined) {
        if (ifExists) continue;
        // Operadores negativos sobre clave ausente se cumplen.
        if (NEGATED.has(op)) continue;
        return false;
      }
      const expected = asArray(vals).map((v) => subst(String(v), ctx));
      const actualList = asArray(actual);
      const one = (a: any) => {
        const hits = expected.map((e) => condMatchOne(op, a, e));
        // Para operadores negativos, todos los valores deben cumplirse (AND); para el resto, alguno (OR).
        return NEGATED.has(op) ? hits.every(Boolean) : hits.some(Boolean);
      };
      let ok: boolean;
      if (setOp === 'ForAllValues') ok = actualList.every(one);
      else if (setOp === 'ForAnyValue') ok = actualList.some(one);
      else ok = one(actualList[0]);
      if (!ok) return false;
    }
  }
  return true;
}

function actionMatches(st: PolicyStatement, action: string): boolean {
  if (st.Action !== undefined) return asArray(st.Action).some((p) => wildcardMatch(p, action, true));
  if (st.NotAction !== undefined) return !asArray(st.NotAction).some((p) => wildcardMatch(p, action, true));
  return false;
}

function resourceMatches(st: PolicyStatement, resource: string, ctx: Record<string, any>): boolean {
  if (st.Resource !== undefined) return asArray(st.Resource).some((p) => wildcardMatch(subst(p, ctx), resource));
  if (st.NotResource !== undefined) return !asArray(st.NotResource).some((p) => wildcardMatch(subst(p, ctx), resource));
  // Sentencias sin Resource (p. ej. trust policies) coinciden con cualquiera.
  return true;
}

function principalMatches(st: PolicyStatement, principalArn: string | undefined, account: string | undefined): boolean {
  if (st.Principal === undefined) return false;
  if (st.Principal === '*') return true;
  const p = st.Principal;
  const list: string[] = [];
  for (const v of Object.values<any>(p)) list.push(...asArray<string>(v));
  if (list.includes('*')) return true;
  if (!principalArn) return false;
  return list.some((x) => {
    if (x === principalArn) return true;
    // arn:aws:iam::123456789012:root o el número de cuenta equivalen a "toda la cuenta".
    const acct = /^\d{12}$/.test(x) ? x : /^arn:aws:iam::(\d{12}):root$/.exec(x)?.[1];
    return !!acct && principalArn.split(':')[4] === acct;
  });
}

interface DocVerdict {
  allow?: string;
  deny?: string;
}

function evalDoc(doc: PolicyDocument, req: EvalRequest, ctx: Record<string, any>, resourceSide = false): DocVerdict {
  const out: DocVerdict = {};
  statements(doc).forEach((st, i) => {
    if (resourceSide && !principalMatches(st, req.principalArn, undefined)) return;
    if (!actionMatches(st, req.action)) return;
    if (!resourceMatches(st, req.resource, ctx)) return;
    if (!conditionsHold(st.Condition, ctx)) return;
    const id = st.Sid ?? `#${i}`;
    if (st.Effect === 'Deny') out.deny ??= id;
    else out.allow ??= id;
  });
  return out;
}

/** Valida estructuralmente un documento de política. Lanza MalformedPolicyDocument como IAM. */
export function validatePolicyDocument(doc: any, kind: 'identity' | 'trust' | 'resource' = 'identity'): PolicyDocument {
  if (doc === null || typeof doc !== 'object') throw new AwsError('MalformedPolicyDocument', 'Syntax errors in policy.');
  if (doc.Version !== undefined && !['2012-10-17', '2008-10-17'].includes(doc.Version)) {
    throw new AwsError('MalformedPolicyDocument', `The policy failed legacy parsing`);
  }
  const sts = asArray<any>(doc.Statement);
  if (sts.length === 0) throw new AwsError('MalformedPolicyDocument', 'Syntax errors in policy.');
  for (const st of sts) {
    if (st.Effect !== 'Allow' && st.Effect !== 'Deny') throw new AwsError('MalformedPolicyDocument', 'Syntax errors in policy.');
    if (st.Action === undefined && st.NotAction === undefined) throw new AwsError('MalformedPolicyDocument', 'Syntax errors in policy.');
    if (kind === 'identity' && st.Resource === undefined && st.NotResource === undefined) {
      throw new AwsError('MalformedPolicyDocument', 'Policy statement must contain resources.');
    }
    if (kind === 'identity' && st.Principal !== undefined) {
      throw new AwsError('MalformedPolicyDocument', 'Policy document should not specify a principal.');
    }
    if ((kind === 'trust' || kind === 'resource') && st.Principal === undefined && st.NotPrincipal === undefined) {
      throw new AwsError('MalformedPolicyDocument', 'Missing required field Principal');
    }
    for (const a of asArray<string>(st.Action ?? st.NotAction)) {
      if (!/^([a-zA-Z0-9-]+:[A-Za-z0-9*?]+|\*)$/.test(a)) throw new AwsError('MalformedPolicyDocument', `Actions/Conditions must be prefaced by a vendor, e.g., iam, sdb, ec2, etc.`);
    }
  }
  return doc as PolicyDocument;
}

/**
 * Evalúa una petición. Reglas de AWS (misma cuenta):
 *  1. Cualquier Deny explícito aplicable => ExplicitDeny.
 *  2. Si hay límite de permisos o política de sesión, deben permitir.
 *  3. Un Allow de identidad o de recurso => Allow.
 *  4. En otro caso => ImplicitDeny.
 */
export function evaluate(req: EvalRequest): EvalResult {
  const ctx = { ...(req.context ?? {}) };
  const sameAccount = req.sameAccount ?? true;

  for (const d of req.identity) {
    const v = evalDoc(d, req, ctx);
    if (v.deny) return { decision: 'ExplicitDeny', matched: v.deny };
  }
  if (req.boundary) {
    const v = evalDoc(req.boundary, req, ctx);
    if (v.deny) return { decision: 'ExplicitDeny', matched: v.deny };
  }
  if (req.scp) {
    for (const level of req.scp) {
      for (const d of level) {
        const v = evalDoc(d, req, ctx);
        if (v.deny) return { decision: 'ExplicitDeny', matched: v.deny, via: 'scp' };
      }
    }
  }
  if (req.session) {
    const v = evalDoc(req.session, req, ctx);
    if (v.deny) return { decision: 'ExplicitDeny', matched: v.deny };
  }
  let resourceAllow: string | undefined;
  if (req.resourcePolicy) {
    const v = evalDoc(req.resourcePolicy, req, ctx, true);
    if (v.deny) return { decision: 'ExplicitDeny', matched: v.deny };
    resourceAllow = v.allow;
  }

  let identityAllow: string | undefined;
  for (const d of req.identity) {
    const v = evalDoc(d, req, ctx);
    if (v.allow) {
      identityAllow = v.allow;
      break;
    }
  }
  const boundaryOk = !req.boundary || !!evalDoc(req.boundary, req, ctx).allow;
  const sessionOk = !req.session || !!evalDoc(req.session, req, ctx).allow;
  // Las SCP no conceden permisos, pero cada nivel necesita al menos un Allow que los deje pasar.
  if (req.scp && !req.scp.every((level) => level.some((d) => !!evalDoc(d, req, ctx).allow))) return { decision: 'ImplicitDeny', via: 'scp' };

  if (sameAccount) {
    // Misma cuenta: basta con la política de recurso (si nombra al principal concreto) o con la de identidad.
    if (resourceAllow && principalIsExplicit(req.resourcePolicy, req.principalArn)) return { decision: 'Allow', matched: resourceAllow };
    if (identityAllow && boundaryOk && sessionOk) return { decision: 'Allow', matched: identityAllow };
    if (resourceAllow && boundaryOk && sessionOk) return { decision: 'Allow', matched: resourceAllow };
  } else {
    // Entre cuentas se necesita permiso en ambos lados.
    if (identityAllow && resourceAllow && boundaryOk && sessionOk) return { decision: 'Allow', matched: resourceAllow };
  }
  return { decision: 'ImplicitDeny' };
}

function principalIsExplicit(doc: PolicyDocument | undefined, principalArn?: string): boolean {
  if (!doc || !principalArn) return false;
  return statements(doc).some((st) => {
    if (st.Effect !== 'Allow' || !st.Principal || st.Principal === '*') return false;
    const list: string[] = [];
    for (const v of Object.values<any>(st.Principal)) list.push(...asArray<string>(v));
    return list.includes(principalArn);
  });
}

/** Evalúa una trust policy: ¿puede el principal asumir el rol? */
export function trustAllows(trust: PolicyDocument, principalArn: string, ctx: Record<string, any>, action = 'sts:AssumeRole'): boolean {
  const req: EvalRequest = { action, resource: '*', identity: [], principalArn, context: ctx };
  const v = evalDoc(trust, req, ctx, true);
  return !!v.allow && !v.deny;
}

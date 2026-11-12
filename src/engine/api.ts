// Capa de API: identifica quién llama, autoriza con IAM y registra cada llamada en CloudTrail.
import type { CloudState, IamRole, IamUser, PolicyDocument, TrailEvent } from './types';
import { AwsError } from './errors';
import { evaluate, type EvalResult } from './policy';
import { guid, nowIso, now } from './util';
import { deliverEvent } from './trailDelivery';
import { accountOfArn, memberAccount, scpLevelsFor, MEMBER_ADMIN_DOCS } from './orgPolicy';

export interface Caller {
  type: 'IAMUser' | 'AssumedRole' | 'Root';
  arn: string;
  userName: string;
  accessKeyId?: string;
  mfa: boolean;
  sessionName?: string;
  roleName?: string;
  sourceIp: string;
}

export interface Ctx {
  s: CloudState;
  caller: Caller;
  region: string;
}

const MFA_SESSION_FALLBACK_IP = '203.0.113.10';

export function getUser(s: CloudState, name: string): IamUser | undefined {
  return s.users.find((u) => u.name === name);
}
export function getRole(s: CloudState, name: string): IamRole | undefined {
  return s.roles.find((r) => r.name === name);
}

/** Resuelve las credenciales (clave de acceso y token opcional) a un llamador. */
export function resolveCaller(s: CloudState, accessKeyId?: string, token?: string, mfaPresent = false): Caller {
  if (!accessKeyId) throw new AwsError('NoCredentialsError', 'Unable to locate credentials. You can configure credentials by running "aws configure".');
  if (accessKeyId.startsWith('ASIA')) {
    const sess = s.sessions.find((x) => x.accessKeyId === accessKeyId);
    if (!sess) throw new AwsError('InvalidClientTokenId', 'The security token included in the request is invalid.', 403);
    if (sess.token !== token) throw new AwsError('InvalidClientTokenId', 'The security token included in the request is invalid.', 403);
    if (new Date(sess.expiration).getTime() <= now()) throw new AwsError('ExpiredToken', 'The security token included in the request is expired', 400);
    if (sess.roleArn.includes(':user/')) {
      // GetSessionToken: mismo usuario, con o sin MFA.
      return { type: 'IAMUser', arn: sess.roleArn, userName: sess.sessionName, accessKeyId, mfa: sess.mfa, sourceIp: MFA_SESSION_FALLBACK_IP };
    }
    const roleName = sess.roleArn.split('/').pop()!;
    return { type: 'AssumedRole', arn: sess.assumedRoleArn, userName: sess.sessionName, accessKeyId, mfa: sess.mfa, sessionName: sess.sessionName, roleName, sourceIp: MFA_SESSION_FALLBACK_IP };
  }
  const user = s.users.find((u) => u.accessKeys.some((k) => k.id === accessKeyId));
  if (!user) throw new AwsError('InvalidClientTokenId', 'The security token included in the request is invalid.', 403);
  return { type: 'IAMUser', arn: user.arn, userName: user.name, accessKeyId, mfa: mfaPresent, sourceIp: MFA_SESSION_FALLBACK_IP };
}

export function isActiveKey(s: CloudState, accessKeyId: string, secret?: string): boolean {
  const u = s.users.find((x) => x.accessKeys.some((k) => k.id === accessKeyId));
  const k = u?.accessKeys.find((x) => x.id === accessKeyId);
  if (!k) return accessKeyId.startsWith('ASIA');
  if (secret !== undefined && k.secret !== secret) return false;
  return k.status === 'Active';
}

function managedDoc(s: CloudState, arn: string): PolicyDocument | undefined {
  return s.policies.find((p) => p.arn === arn)?.document;
}

/** Políticas de identidad que se aplican al llamador (usuario + grupos, o rol). */
export function identityPolicies(s: CloudState, c: Caller): { docs: PolicyDocument[]; boundary?: PolicyDocument; session?: PolicyDocument; scp?: PolicyDocument[][] } {
  // SCP de AWS Organizations: solo afectan a las cuentas miembro (nunca a la cuenta de administración).
  return { ...identityPoliciesBase(s, c), scp: scpLevelsFor(s, accountOfArn(c.arn)) };
}

function identityPoliciesBase(s: CloudState, c: Caller): { docs: PolicyDocument[]; boundary?: PolicyDocument; session?: PolicyDocument } {
  const docs: PolicyDocument[] = [];
  if (c.type === 'AssumedRole' && memberAccount(s, accountOfArn(c.arn))) return { docs: MEMBER_ADMIN_DOCS, session: s.sessions.find((x) => x.accessKeyId === c.accessKeyId)?.sessionPolicy };
  if (c.type === 'IAMUser') {
    const u = getUser(s, c.userName)!;
    for (const a of u.attached) {
      const d = managedDoc(s, a);
      if (d) docs.push(d);
    }
    docs.push(...Object.values(u.inline));
    for (const g of s.groups.filter((g) => g.members.includes(u.name))) {
      for (const a of g.attached) {
        const d = managedDoc(s, a);
        if (d) docs.push(d);
      }
      docs.push(...Object.values(g.inline));
    }
    return { docs, boundary: u.permissionsBoundary ? managedDoc(s, u.permissionsBoundary) : undefined };
  }
  if (c.type === 'AssumedRole') {
    const r = getRole(s, c.roleName!);
    if (!r) return { docs };
    for (const a of r.attached) {
      const d = managedDoc(s, a);
      if (d) docs.push(d);
    }
    docs.push(...Object.values(r.inline));
    const sess = s.sessions.find((x) => x.accessKeyId === c.accessKeyId);
    return { docs, boundary: r.permissionsBoundary ? managedDoc(s, r.permissionsBoundary) : undefined, session: sess?.sessionPolicy };
  }
  return { docs: [{ Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] }] };
}

export function requestContext(c: Caller, extra: Record<string, any> = {}): Record<string, any> {
  return {
    'aws:username': c.type === 'IAMUser' ? c.userName : undefined,
    'aws:userid': c.userName,
    'aws:PrincipalAccount': accountOfArn(c.arn),
    'aws:PrincipalArn': c.arn,
    'aws:MultiFactorAuthPresent': c.mfa ? 'true' : 'false',
    'aws:SourceIp': c.sourceIp,
    'aws:CurrentTime': nowIso(),
    'aws:SecureTransport': 'true',
    ...extra,
  };
}

export function check(ctx: Ctx, action: string, resource: string, opts: { resourcePolicy?: PolicyDocument; context?: Record<string, any>; sameAccount?: boolean } = {}): EvalResult {
  const { docs, boundary, session, scp } = identityPolicies(ctx.s, ctx.caller);
  return evaluate({
    action,
    resource,
    identity: docs,
    boundary,
    session,
    scp,
    resourcePolicy: opts.resourcePolicy,
    principalArn: ctx.caller.arn,
    context: requestContext(ctx.caller, { 'aws:RequestedRegion': ctx.region, ...opts.context }),
    sameAccount: opts.sameAccount,
  });
}

/** Lanza AccessDenied con el texto exacto que devuelve AWS. */
/** Servicios cuyo protocolo JSON devuelve AccessDeniedException y muestra el recurso sin comillas. */
const JSON_SERVICES = new Set(['organizations', 'config', 'budgets', 'ce', 'support', 'health', 'kms', 'secretsmanager', 'cloudtrail', 'logs', 'codecommit', 'codebuild', 'codepipeline', 'codedeploy', 'ecr', 'ecs', 'eks']);

export function authorize(ctx: Ctx, action: string, resource: string, opts: { resourcePolicy?: PolicyDocument; context?: Record<string, any>; sameAccount?: boolean; display?: string } = {}): void {
  if (ctx.caller.type === 'Root') return;
  const r = check(ctx, action, resource, opts);
  if (r.decision === 'Allow') return;
  const who = ctx.caller.arn;
  const why = r.via === 'scp'
    ? (r.decision === 'ExplicitDeny' ? 'with an explicit deny in a service control policy' : `because no service control policy allows the ${action} action`)
    : r.decision === 'ExplicitDeny' ? 'with an explicit deny in an identity-based policy' : `because no identity-based policy allows the ${action} action`;
  const svc = action.split(':')[0].toLowerCase();
  if (JSON_SERVICES.has(svc)) {
    const whyJson = why;
    throw new AwsError('AccessDeniedException', `User: ${who} is not authorized to perform: ${action} on resource: ${opts.display ?? resource} ${whyJson}`, 400);
  }
  const base = `User: ${who} is not authorized to perform: ${action} on resource: "${resource}" ${why}`;
  const isEc2 = action.startsWith('ec2:');
  throw new AwsError(isEc2 ? 'UnauthorizedOperation' : 'AccessDenied', isEc2 ? `You are not authorized to perform this operation. ${base}` : base, 403);
}

const READ_ONLY = /^(Get|List|Describe|Head|Lookup|Check|Simulate|Generate|GitPull|Evaluate)/;

/** Registra el evento y propaga errores. */
export function trailed<T>(ctx: Ctx, source: string, eventName: string, resources: { type: string; name: string }[], requestParameters: any, fn: () => T): T {
  const ev: TrailEvent = {
    id: guid(),
    time: nowIso(),
    eventName,
    eventSource: source,
    region: ctx.region,
    principalArn: ctx.caller.arn,
    userName: ctx.caller.userName,
    readOnly: READ_ONLY.test(eventName),
    resources,
    sourceIp: ctx.caller.sourceIp,
    requestParameters,
  };
  try {
    const r = fn();
    ctx.s.trail.push(ev);
    deliverEvent(ctx.s, ev);
    return r;
  } catch (e) {
    if (e instanceof AwsError) {
      ev.errorCode = e.code;
      ev.errorMessage = e.message;
      ctx.s.trail.push(ev);
      deliverEvent(ctx.s, ev);
    }
    throw e;
  }
}

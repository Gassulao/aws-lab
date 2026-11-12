// Utilidades comunes de CodeCommit, CodeBuild, CodePipeline y CodeDeploy: roles de servicio, registros y artefactos.
import type { CloudState, IamRole, PolicyStatement } from '../types';
import { identityPolicies, getRole, type Caller, type Ctx } from '../api';
import { evaluate, statements } from '../policy';
import { speedFactor } from '../store';
import { now, hex, wildcardMatch } from '../util';

export const asArr = <T>(v: T | T[] | undefined): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** Rol por ARN completo (o por nombre). */
export function roleByArn(s: CloudState, arn: string): IamRole | undefined {
  const name = arn.split('/').pop() ?? arn;
  return s.roles.find((r) => r.arn === arn || (arn.includes(':role/') && r.name === name && arn.startsWith('arn:aws:iam::' + s.account.id)));
}

/** ¿La política de confianza del rol permite a ese servicio asumirlo? */
export function trustsService(role: IamRole, service: string): boolean {
  return statements(role.assumeRolePolicy).some((st: PolicyStatement) => {
    if (st.Effect !== 'Allow') return false;
    if (!asArr(st.Action).some((a) => wildcardMatch(a, 'sts:AssumeRole', true))) return false;
    const p = st.Principal;
    if (p === '*') return true;
    return asArr<string>(p?.Service).includes(service);
  });
}

export function assumedCaller(s: CloudState, role: IamRole, session: string): Caller {
  return { type: 'AssumedRole', arn: `arn:aws:sts::${s.account.id}:assumed-role/${role.name}/${session}`, userName: session, roleName: role.name, mfa: false, sourceIp: '203.0.113.10' };
}

/** Motivo (texto tras "because") si el rol de servicio no puede ejecutar la acción sobre el recurso; null si puede. */
export function roleDenial(s: CloudState, role: IamRole, session: string, action: string, resource: string, context: Record<string, any> = {}): string | null {
  const caller = assumedCaller(s, role, session);
  const { docs, boundary, scp } = identityPolicies(s, caller);
  const r = evaluate({ action, resource, identity: docs, boundary, scp, principalArn: caller.arn, context: { 'aws:PrincipalArn': caller.arn, ...context } });
  if (r.decision === 'Allow') return null;
  const who = caller.arn;
  return `User: ${who} is not authorized to perform: ${action} on resource: ${resource} ${r.decision === 'ExplicitDeny' ? 'with an explicit deny in an identity-based policy' : `because no identity-based policy allows the ${action} action`}`;
}

/** Escala de tiempo: 0 en modo instantáneo. Las esperas se comprimen respecto a las reales. */
export function scaled(ms: number): number {
  return Math.round(ms * speedFactor());
}

/** Escribe líneas en un flujo de CloudWatch Logs, creando el grupo y el flujo si no existen. */
export function writeLog(s: CloudState, region: string, groupName: string, streamName: string, lines: { ts: number; msg: string }[]): void {
  let g = s.logGroups.find((x) => x.name === groupName && x.region === region);
  if (!g) {
    g = { name: groupName, arn: `arn:aws:logs:${region}:${s.account.id}:log-group:${groupName}:*`, region, created: now(), streams: [], filters: [], tags: {} };
    s.logGroups.push(g);
  }
  let st = g.streams.find((x) => x.name === streamName);
  if (!st) {
    st = { name: streamName, created: now(), events: [], seq: 0 };
    g.streams.push(st);
  }
  for (const l of lines) st.events.push({ ts: l.ts, message: l.msg, ingestion: now() });
  st.seq++;
}

/** Guarda un objeto en un bucket (sin pasar por IAM del llamador: lo hace un servicio con su rol, ya verificado). */
export function putBucketObject(s: CloudState, bucket: string, key: string, body: string, contentType = 'application/zip'): boolean {
  const b = s.buckets.find((x) => x.name === bucket);
  if (!b) return false;
  const etag = hex(32);
  const obj = { key, body, size: body.length, etag, contentType, lastModified: new Date(now()).toISOString(), storageClass: 'STANDARD', metadata: {}, tags: {} };
  if (b.versioning === 'Enabled') {
    const prev = b.objects[key];
    if (prev) (b.versions[key] ??= []).push(prev);
    (obj as any).versionId = hex(32);
  }
  b.objects[key] = obj;
  return true;
}

/** «Zip» simulado: JSON con los ficheros. Los servicios lo leen y lo escriben con estas funciones. */
export const packBundle = (files: Record<string, string>) => JSON.stringify({ aws_lab_zip: 1, files });
export function unpackBundle(body: string): Record<string, string> | null {
  try {
    const o = JSON.parse(body);
    return o && o.aws_lab_zip === 1 && o.files ? (o.files as Record<string, string>) : null;
  } catch {
    return null;
  }
}

export const upper = (n: number) => Array.from({ length: n }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join('');

/** Servicio de la API interna: contexto con la identidad de un servicio (sin autorización de usuario). */
export const serviceCtx = (s: CloudState, region: string, name: string): Ctx => ({ s, region, caller: { type: 'Root', arn: name, userName: name, mfa: false, sourceIp: name } });

export { getRole };

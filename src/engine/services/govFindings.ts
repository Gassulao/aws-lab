// Comprobaciones sobre el estado real de la cuenta, compartidas por AWS Config (reglas gestionadas) y Trusted Advisor.
import type { CloudState, IamUser, S3Bucket, SecurityGroup, SgRule } from '../types';
import { evaluate, statements } from '../policy';
import { isPublicPolicy } from './s3';
import { now } from '../util';
import { settle } from './ec2';

const DAY = 86_400_000;

export const isWorldCidr = (cidr?: string) => cidr === '0.0.0.0/0' || cidr === '::/0';

/** ¿La regla de entrada abre el puerto a todo internet? */
export function ruleOpensPort(r: SgRule, port: number): boolean {
  if (!isWorldCidr(r.cidr)) return false;
  if (r.protocol === '-1') return true;
  return r.protocol === 'tcp' && r.from <= port && port <= r.to;
}
export const sgOpenToWorldOn = (g: SecurityGroup, port: number) => g.ingress.some((r) => ruleOpensPort(r, port));

/** Reglas abiertas al mundo en puertos distintos de 80, 443, 25, 465 y 587 (criterio de Trusted Advisor «Unrestricted Access»). */
export function sgUnrestrictedRules(g: SecurityGroup): SgRule[] {
  const web = [80, 443, 25, 465, 587];
  return g.ingress.filter((r) => isWorldCidr(r.cidr) && (r.protocol === '-1' || r.from !== r.to || !web.includes(r.from)));
}

const arnObj = (b: S3Bucket) => `arn:aws:s3:::${b.name}/object`;

/** Lectura anónima posible por política de bucket o ACL pública, teniendo en cuenta el bloqueo de acceso público. */
export function bucketPublicRead(b: S3Bucket): boolean {
  const pab = b.publicAccessBlock;
  let viaPolicy = false;
  if (b.policy && !(pab.RestrictPublicBuckets && isPublicPolicy(b.policy))) {
    viaPolicy = evaluate({ action: 's3:GetObject', resource: arnObj(b), identity: [], resourcePolicy: b.policy, principalArn: '*', context: { 'aws:SecureTransport': 'true' } }).decision === 'Allow';
  }
  const viaAcl = (b.acl === 'public-read' || b.acl === 'public-read-write') && !pab.IgnorePublicAcls;
  return viaPolicy || viaAcl;
}
export function bucketPublicWrite(b: S3Bucket): boolean {
  const pab = b.publicAccessBlock;
  let viaPolicy = false;
  if (b.policy && !(pab.RestrictPublicBuckets && isPublicPolicy(b.policy))) {
    viaPolicy = evaluate({ action: 's3:PutObject', resource: arnObj(b), identity: [], resourcePolicy: b.policy, principalArn: '*', context: { 'aws:SecureTransport': 'true' } }).decision === 'Allow';
  }
  return viaPolicy || (b.acl === 'public-read-write' && !pab.IgnorePublicAcls);
}
export const bucketBlocksAllPublic = (b: S3Bucket) => Object.values(b.publicAccessBlock).every(Boolean);
/** Política que obliga a usar TLS (Deny con aws:SecureTransport=false). */
export const bucketRequiresTls = (b: S3Bucket) => !!b.policy && statements(b.policy).some((st) => st.Effect === 'Deny' && JSON.stringify(st.Condition ?? {}).toLowerCase().includes('"aws:securetransport":"false"'));

export const hasMfa = (u: IamUser) => u.mfaDevices.length > 0;
export const hasConsole = (u: IamUser) => u.hasConsolePassword || !!u.loginProfile;
/** Edad en días de cada clave de acceso activa. */
export const activeKeyAges = (u: IamUser, t = now()) => u.accessKeys.filter((k) => k.status === 'Active').map((k) => ({ id: k.id, days: Math.floor((t - new Date(k.createdAt).getTime()) / DAY) }));

/** Instancias no terminadas, con el ciclo de vida ya resuelto al reloj actual. */
export function liveInstances(s: CloudState) {
  settle(s);
  return s.instances.filter((i) => i.state !== 'terminated');
}

export const trailLogging = (s: CloudState) => s.trails.some((t) => t.logging);

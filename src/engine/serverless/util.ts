// Utilidades compartidas por los servicios sin servidor: autorización con el estilo de error de cada servicio,
// hash MD5/SHA, fechas con el formato de cada API y búsqueda de roles.
import { AwsError } from '../errors';
import { check, type Ctx } from '../api';
import type { CloudState, IamRole } from '../types';

export type ErrStyle = 'json' | 'sqs' | 'query' | 'rest';

/** Autoriza la acción con IAM y lanza el error de AccessDenied con el texto de cada servicio. */
export function svAuthorize(ctx: Ctx, action: string, resource: string, style: ErrStyle = 'json', opts: { resourcePolicy?: any; context?: Record<string, any> } = {}): void {
  if (ctx.caller.type === 'Root') return;
  const r = check(ctx, action, resource, opts);
  if (r.decision === 'Allow') return;
  const why = r.decision === 'ExplicitDeny' ? 'with an explicit deny in an identity-based policy' : `because no identity-based policy allows the ${action} action`;
  if (style === 'sqs') {
    const a = action.toLowerCase();
    throw new AwsError('AccessDenied', `User: ${ctx.caller.arn} is not authorized to perform: ${a} on resource: ${resource} ${why.replace(action, a)}`, 403);
  }
  if (style === 'query') throw new AwsError('AccessDenied', `User: ${ctx.caller.arn} is not authorized to perform: ${action} on resource: ${resource} ${why}`, 403);
  throw new AwsError('AccessDeniedException', `User: ${ctx.caller.arn} is not authorized to perform: ${action} on resource: ${resource} ${why}`, 403);
}

export const roleOf = (s: CloudState, arn: string): IamRole | undefined => s.roles.find((r) => r.arn === arn);

/** Acepta ARN, nombre o ARN parcial de función y devuelve el nombre. */
export const lastSeg = (v: string) => v.split(':').pop() ?? v;

export const iso = (ms: number) => new Date(ms).toISOString();
/** 2024-01-01T00:00:00.000+0000, el formato de LastModified de Lambda. */
export const lambdaTime = (ms: number) => new Date(ms).toISOString().replace('Z', '+0000');
/** 2024-01-01T00:00:00.000000+00:00, el formato de las marcas de RDS/ API Gateway v1 en el CLI. */
export const awsTime = (ms: number) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000+00:00');
export const epoch = (ms: number) => ms / 1000;

export const asArr = <T>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

// ------------------------------------------------------------------ hashes
function rotl(x: number, n: number) { return (x << n) | (x >>> (32 - n)); }
const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s));

/** MD5 en hexadecimal (SQS lo devuelve para cuerpos y atributos). */
export function md5(str: string): string {
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const bytes = utf8(str);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 0; i < 8; i++) bytes.push(i < 4 ? (bitLen >>> (8 * i)) & 0xff : 0);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < bytes.length; off += 64) {
    const M = Array.from({ length: 16 }, (_, i) => bytes[off + i * 4] | (bytes[off + i * 4 + 1] << 8) | (bytes[off + i * 4 + 2] << 16) | (bytes[off + i * 4 + 3] << 24));
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, S[(i >> 4) * 4 + (i % 4)])) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  return [a0, b0, c0, d0].map((v) => Array.from({ length: 4 }, (_, i) => ((v >>> (8 * i)) & 0xff).toString(16).padStart(2, '0')).join('')).join('');
}

/** Resumen determinista tipo SHA-256 en base64 (no criptográfico; solo para CodeSha256). */
export function fakeSha256b64(seed: string): string {
  let h = 2166136261 >>> 0;
  const out: number[] = [];
  for (let r = 0; out.length < 32; r++) {
    for (const c of seed + '#' + r) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    out.push(h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff, (h >>> 24) & 0xff);
  }
  return btoa(String.fromCharCode(...out.slice(0, 32)));
}

export const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
export const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

// Amazon S3 (operaciones complementarias): ACL, propiedad de objetos, ciclo de vida, CORS, etiquetas de objeto,
// versiones, consultas de configuración y URL prefirmadas.
import type { S3Bucket, S3Object } from '../types';
import { AwsError } from '../errors';
import { trailed, resolveCaller, type Ctx } from '../api';
import { now, nowIso } from '../util';
import { getBucket, auth, getObject } from './s3';

const SRC = 's3.amazonaws.com';
const bres = (b: string) => [{ type: 'AWS::S3::Bucket', name: b }];

// ------------------------------------------------------------------ ACL y propiedad

const ACLS = ['private', 'public-read', 'public-read-write', 'authenticated-read'];

export function putBucketAcl(ctx: Ctx, p: { Bucket: string; ACL: string }): void {
  trailed(ctx, SRC, 'PutBucketAcl', bres(p.Bucket), p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:PutBucketAcl', b);
    if (!ACLS.includes(p.ACL)) throw new AwsError('InvalidArgument', 'Invalid canned ACL', 400);
    if (b.ownershipControls === 'BucketOwnerEnforced') throw new AwsError('AccessControlListNotSupported', 'The bucket does not allow ACLs', 400);
    if ((p.ACL === 'public-read' || p.ACL === 'public-read-write') && b.publicAccessBlock.BlockPublicAcls) throw new AwsError('AccessDenied', 'Access Denied', 403);
    b.acl = p.ACL as S3Bucket['acl'];
  });
}

export function getBucketAcl(ctx: Ctx, p: { Bucket: string }) {
  return trailed(ctx, SRC, 'GetBucketAcl', bres(p.Bucket), p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:GetBucketAcl', b);
    const owner = { DisplayName: ctx.s.account.alias ?? ctx.s.users[0]?.name ?? 'owner', ID: canonicalId(ctx) };
    const grants: any[] = [{ Grantee: { DisplayName: owner.DisplayName, ID: owner.ID, Type: 'CanonicalUser' }, Permission: 'FULL_CONTROL' }];
    const all = { Type: 'Group', URI: 'http://acs.amazonaws.com/groups/global/AllUsers' };
    if (b.acl === 'public-read' || b.acl === 'public-read-write') grants.push({ Grantee: all, Permission: 'READ' });
    if (b.acl === 'public-read-write') grants.push({ Grantee: all, Permission: 'WRITE' });
    if (b.acl === 'authenticated-read') grants.push({ Grantee: { Type: 'Group', URI: 'http://acs.amazonaws.com/groups/global/AuthenticatedUsers' }, Permission: 'READ' });
    return { Owner: owner, Grants: grants };
  });
}

function canonicalId(ctx: Ctx): string {
  return (ctx.s.account.id + ctx.s.account.id + ctx.s.account.id).slice(0, 12).padEnd(64, 'a1b2c3d4e5f6');
}

export function putBucketOwnershipControls(ctx: Ctx, p: { Bucket: string; ObjectOwnership: string }): void {
  trailed(ctx, SRC, 'PutBucketOwnershipControls', bres(p.Bucket), p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:PutBucketOwnershipControls', b);
    if (!['BucketOwnerEnforced', 'BucketOwnerPreferred', 'ObjectWriter'].includes(p.ObjectOwnership)) throw new AwsError('MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema', 400);
    b.ownershipControls = p.ObjectOwnership as S3Bucket['ownershipControls'];
    if (p.ObjectOwnership === 'BucketOwnerEnforced') b.acl = 'private';
  });
}
export function getBucketOwnershipControls(ctx: Ctx, p: { Bucket: string }) {
  return trailed(ctx, SRC, 'GetBucketOwnershipControls', bres(p.Bucket), p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:GetBucketOwnershipControls', b);
    return b.ownershipControls;
  });
}

// ------------------------------------------------------------------ ciclo de vida

const MALFORMED = 'The XML you provided was not well-formed or did not validate against our published schema';
export function putBucketLifecycle(ctx: Ctx, p: { Bucket: string; Rules: any[] }): void {
  trailed(ctx, SRC, 'PutBucketLifecycleConfiguration', bres(p.Bucket), { Bucket: p.Bucket }, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:PutLifecycleConfiguration', b);
    if (!Array.isArray(p.Rules) || !p.Rules.length) throw new AwsError('MalformedXML', MALFORMED, 400);
    const seen = new Set<string>();
    b.lifecycle = p.Rules.map((r, i) => {
      if (!['Enabled', 'Disabled'].includes(r.Status)) throw new AwsError('MalformedXML', MALFORMED, 400);
      if (r.Filter === undefined && r.Prefix === undefined) throw new AwsError('MalformedXML', MALFORMED, 400);
      if (!r.Expiration && !r.Transitions && !r.NoncurrentVersionExpiration && !r.NoncurrentVersionTransitions && !r.AbortIncompleteMultipartUpload) throw new AwsError('InvalidRequest', 'At least one action needs to be specified in a rule', 400);
      const id = r.ID ?? `rule-${i + 1}`;
      if (seen.has(id)) throw new AwsError('InvalidArgument', 'Rule ID must be unique. Found same ID for more than one rule.', 400);
      seen.add(id);
      return { ID: id, ...r };
    });
  });
}
export function getBucketLifecycle(ctx: Ctx, p: { Bucket: string }): any[] {
  return trailed(ctx, SRC, 'GetBucketLifecycleConfiguration', bres(p.Bucket), p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:GetLifecycleConfiguration', b);
    if (!b.lifecycle.length) throw new AwsError('NoSuchLifecycleConfiguration', 'The lifecycle configuration does not exist', 404);
    return b.lifecycle;
  });
}
export function deleteBucketLifecycle(ctx: Ctx, p: { Bucket: string }): void {
  trailed(ctx, SRC, 'DeleteBucketLifecycle', bres(p.Bucket), p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:PutLifecycleConfiguration', b);
    b.lifecycle = [];
  });
}

// ------------------------------------------------------------------ web, versionado, cifrado, acceso público, CORS

export function getBucketWebsite(ctx: Ctx, p: { Bucket: string }) {
  return trailed(ctx, SRC, 'GetBucketWebsite', bres(p.Bucket), p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:GetBucketWebsite', b);
    if (!b.website) throw new AwsError('NoSuchWebsiteConfiguration', 'The specified bucket does not have a website configuration', 404);
    return b.website;
  });
}
export function deleteBucketWebsite(ctx: Ctx, p: { Bucket: string }): void {
  trailed(ctx, SRC, 'DeleteBucketWebsite', bres(p.Bucket), p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:DeleteBucketWebsite', b);
    delete b.website;
  });
}
export function getBucketVersioning(ctx: Ctx, p: { Bucket: string }) {
  return trailed(ctx, SRC, 'GetBucketVersioning', bres(p.Bucket), p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:GetBucketVersioning', b);
    return b.versioning;
  });
}
export function getBucketEncryption(ctx: Ctx, p: { Bucket: string }) {
  return trailed(ctx, SRC, 'GetBucketEncryption', bres(p.Bucket), p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:GetEncryptionConfiguration', b);
    if (!b.encryption) throw new AwsError('ServerSideEncryptionConfigurationNotFoundError', 'The server side encryption configuration was not found', 404);
    return b.encryption;
  });
}
export function deleteBucketEncryption(ctx: Ctx, p: { Bucket: string }): void {
  trailed(ctx, SRC, 'DeleteBucketEncryption', bres(p.Bucket), p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:PutEncryptionConfiguration', b);
    b.encryption = { algorithm: 'AES256' };
  });
}
export function getPublicAccessBlock(ctx: Ctx, p: { Bucket: string }) {
  return trailed(ctx, SRC, 'GetPublicAccessBlock', bres(p.Bucket), p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:GetBucketPublicAccessBlock', b);
    const c = b.publicAccessBlock;
    if (!c.BlockPublicAcls && !c.IgnorePublicAcls && !c.BlockPublicPolicy && !c.RestrictPublicBuckets && (b as any).pabRemoved) {
      throw new AwsError('NoSuchPublicAccessBlockConfiguration', 'The public access block configuration was not found', 404);
    }
    return c;
  });
}
export function deletePublicAccessBlock(ctx: Ctx, p: { Bucket: string }): void {
  trailed(ctx, SRC, 'DeletePublicAccessBlock', bres(p.Bucket), p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:PutBucketPublicAccessBlock', b);
    b.publicAccessBlock = { BlockPublicAcls: false, IgnorePublicAcls: false, BlockPublicPolicy: false, RestrictPublicBuckets: false };
    (b as any).pabRemoved = true;
  });
}

export function putBucketCors(ctx: Ctx, p: { Bucket: string; CORSRules: any[] }): void {
  trailed(ctx, SRC, 'PutBucketCors', bres(p.Bucket), { Bucket: p.Bucket }, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:PutBucketCORS', b);
    if (!Array.isArray(p.CORSRules) || !p.CORSRules.length) throw new AwsError('MalformedXML', MALFORMED, 400);
    for (const r of p.CORSRules) {
      if (!r.AllowedMethods?.length || !r.AllowedOrigins?.length) throw new AwsError('MalformedXML', MALFORMED, 400);
      const bad = (r.AllowedMethods as string[]).find((m) => !['GET', 'PUT', 'POST', 'DELETE', 'HEAD'].includes(m));
      if (bad) throw new AwsError('InvalidRequest', `Found unsupported HTTP method in CORS config. Unsupported method is ${bad}`, 400);
    }
    b.cors = p.CORSRules;
  });
}
export function getBucketCors(ctx: Ctx, p: { Bucket: string }): any[] {
  return trailed(ctx, SRC, 'GetBucketCors', bres(p.Bucket), p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:GetBucketCORS', b);
    if (!b.cors?.length) throw new AwsError('NoSuchCORSConfiguration', 'The CORS configuration does not exist', 404);
    return b.cors;
  });
}
export function deleteBucketCors(ctx: Ctx, p: { Bucket: string }): void {
  trailed(ctx, SRC, 'DeleteBucketCors', bres(p.Bucket), p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:PutBucketCORS', b);
    delete b.cors;
  });
}

export function getBucketTagging(ctx: Ctx, p: { Bucket: string }) {
  return trailed(ctx, SRC, 'GetBucketTagging', bres(p.Bucket), p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:GetBucketTagging', b);
    if (!Object.keys(b.tags).length) throw new AwsError('NoSuchTagSet', 'The TagSet does not exist', 404);
    return b.tags;
  });
}

// ------------------------------------------------------------------ etiquetas de objeto

function objOr(b: S3Bucket, key: string): S3Object {
  const o = b.objects[key];
  if (!o) throw new AwsError('NoSuchKey', 'The specified key does not exist.', 404);
  return o;
}
export function putObjectTagging(ctx: Ctx, p: { Bucket: string; Key: string; Tags: Record<string, string> }): void {
  trailed(ctx, SRC, 'PutObjectTagging', [{ type: 'AWS::S3::Object', name: `${p.Bucket}/${p.Key}` }], { Bucket: p.Bucket, Key: p.Key }, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:PutObjectTagging', b, p.Key);
    const o = objOr(b, p.Key);
    if (Object.keys(p.Tags).length > 10) throw new AwsError('BadRequest', 'Object tags cannot be greater than 10', 400);
    o.tags = { ...p.Tags };
  });
}
export function getObjectTagging(ctx: Ctx, p: { Bucket: string; Key: string }): Record<string, string> {
  return trailed(ctx, SRC, 'GetObjectTagging', [{ type: 'AWS::S3::Object', name: `${p.Bucket}/${p.Key}` }], p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:GetObjectTagging', b, p.Key);
    return objOr(b, p.Key).tags ?? {};
  });
}
export function deleteObjectTagging(ctx: Ctx, p: { Bucket: string; Key: string }): void {
  trailed(ctx, SRC, 'DeleteObjectTagging', [{ type: 'AWS::S3::Object', name: `${p.Bucket}/${p.Key}` }], p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:DeleteObjectTagging', b, p.Key);
    objOr(b, p.Key).tags = {};
  });
}

// ------------------------------------------------------------------ versiones

export interface VersionEntry {
  Key: string;
  VersionId: string;
  IsLatest: boolean;
  LastModified: string;
  ETag?: string;
  Size?: number;
  StorageClass?: string;
  DeleteMarker: boolean;
}
export function listObjectVersions(ctx: Ctx, p: { Bucket: string; Prefix?: string }): VersionEntry[] {
  return trailed(ctx, SRC, 'ListObjectVersions', bres(p.Bucket), p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:ListBucketVersions', b);
    const keys = new Set([...Object.keys(b.objects), ...Object.keys(b.versions)]);
    const out: VersionEntry[] = [];
    for (const k of [...keys].filter((k) => k.startsWith(p.Prefix ?? '')).sort()) {
      const hist = b.versions[k] ?? [];
      const cur = b.objects[k];
      const chain = [...hist, ...(cur ? [cur] : [])]; // de la más antigua a la más reciente
      chain.reverse().forEach((o, i) => {
        const dm = !!(o as any).deleteMarker;
        out.push({ Key: k, VersionId: o.versionId ?? 'null', IsLatest: i === 0, LastModified: o.lastModified, ETag: dm ? undefined : `"${o.etag}"`, Size: dm ? undefined : o.size, StorageClass: dm ? undefined : o.storageClass, DeleteMarker: dm });
      });
    }
    return out;
  });
}

// ------------------------------------------------------------------ URL prefirmadas

/** Hash no criptográfico de 256 bits (8 vueltas de FNV-1a con semillas distintas) para firmas simuladas. */
export function fakeSignature(input: string): string {
  let out = '';
  for (let r = 0; r < 8; r++) {
    let h = (0x811c9dc5 ^ (r * 0x9e3779b1)) >>> 0;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

const amzDate = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

export function presign(ctx: Ctx, p: { Bucket: string; Key: string; ExpiresIn?: number; Secret: string; AccessKeyId: string; Token?: string }): string {
  const expires = p.ExpiresIn ?? 3600;
  const date = amzDate(now());
  const region = ctx.region;
  const host = region === 'us-east-1' ? `${p.Bucket}.s3.amazonaws.com` : `${p.Bucket}.s3.${region}.amazonaws.com`;
  const cred = `${p.AccessKeyId}/${date.slice(0, 8)}/${region}/s3/aws4_request`;
  const sig = fakeSignature([p.Secret, p.Bucket, p.Key, date, expires, region].join('|'));
  const q = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'], ['X-Amz-Credential', cred], ['X-Amz-Date', date], ['X-Amz-Expires', String(expires)],
    ...(p.Token ? [['X-Amz-Security-Token', p.Token]] : []), ['X-Amz-SignedHeaders', 'host'], ['X-Amz-Signature', sig],
  ];
  return `https://${host}/${p.Key.split('/').map(encodeURIComponent).join('/')}?${q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

/** Atiende una petición GET con URL prefirmada: valida firma y caducidad y lee con los permisos de quien firmó. */
export function presignedGet(s: Ctx['s'], bucket: string, key: string, search: URLSearchParams): { status: number; body: string; contentType: string } {
  const xml = (status: number, code: string, msg: string) => ({ status, contentType: 'application/xml', body: `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${msg}</Message></Error>` });
  const cred = search.get('X-Amz-Credential') ?? '';
  const [akid, day, region] = cred.split('/');
  const date = search.get('X-Amz-Date') ?? '';
  const expires = Number(search.get('X-Amz-Expires') ?? '0');
  const sess = s.sessions.find((x) => x.accessKeyId === akid);
  const user = s.users.find((u) => u.accessKeys.some((k) => k.id === akid));
  const secret = sess?.secret ?? user?.accessKeys.find((k) => k.id === akid)?.secret;
  if (!secret) return xml(403, 'InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records.');
  const expected = fakeSignature([secret, bucket, key, date, expires, region].join('|'));
  if (expected !== search.get('X-Amz-Signature') || !date.startsWith(day)) return xml(403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided. Check your key and signing method.');
  const t0 = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
  if (now() > t0 + expires * 1000) return xml(403, 'AccessDenied', 'Request has expired');
  try {
    const caller = resolveCaller(s, akid, sess?.token);
    const o = getObject({ s, caller, region: region || 'us-east-1' }, { Bucket: bucket, Key: key });
    return { status: 200, body: o.body, contentType: o.contentType };
  } catch (e) {
    if (e instanceof AwsError) return e.code === 'NoSuchKey' ? xml(404, 'NoSuchKey', e.message) : xml(e.status, e.code, e.code === 'AccessDenied' ? 'Access Denied' : e.message);
    throw e;
  }
}

export { nowIso };

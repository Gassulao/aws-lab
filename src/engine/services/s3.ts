// Amazon S3: buckets, objetos, versionado, políticas de bucket, bloqueo de acceso público, cifrado y web estática.
import type { PolicyDocument, S3Bucket, S3Object } from '../types';
import { AwsError } from '../errors';
import { authorize, trailed, type Ctx } from '../api';
import { s3Arn } from '../arn';
import { ids } from '../ids';
import { nowIso } from '../util';
import { evaluate, validatePolicyDocument, statements } from '../policy';
import { awsManagedKey, resolveKey, kmsAuthorize, type KmsAuthOpts } from './kms';
import type { KmsKey } from '../types';

const SRC = 's3.amazonaws.com';

/** Nombres que "pertenecen a otra cuenta" para practicar BucketAlreadyExists. */
const TAKEN = new Set(['test', 'backup', 'backups', 'data', 'logs', 'prod', 'dev', 'my-bucket', 'mybucket', 'bucket', 'images', 'files', 'website', 'assets', 'terraform', 'terraform-state']);

export function validBucketName(n: string): boolean {
  if (n.length < 3 || n.length > 63) return false;
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(n)) return false;
  if (/\.\./.test(n) || /^\d+\.\d+\.\d+\.\d+$/.test(n)) return false;
  if (n.startsWith('xn--') || n.endsWith('-s3alias')) return false;
  return true;
}

export function getBucket(ctx: Ctx, name: string): S3Bucket {
  const b = ctx.s.buckets.find((x) => x.name === name);
  if (!b) throw new AwsError('NoSuchBucket', 'The specified bucket does not exist', 404);
  return b;
}

function objArn(b: string, k?: string) {
  return s3Arn(b, k);
}

export function auth(ctx: Ctx, action: string, b: S3Bucket, key?: string, context?: Record<string, any>) {
  authorize(ctx, action, key !== undefined ? objArn(b.name, key) : objArn(b.name), { resourcePolicy: b.policy, context });
}

// ------------------------------------------------------------------ SSE-KMS

/** Convierte los errores de KMS en los que devuelve S3 (prefijo KMS.). */
function viaS3<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof AwsError) {
      if (e.code === 'AccessDeniedException') throw new AwsError('AccessDenied', e.message, 403);
      if (e.code === 'DisabledException' || e.code === 'KMSInvalidStateException' || e.code === 'NotFoundException') throw new AwsError(`KMS.${e.code}`, e.message, 400);
    }
    throw e;
  }
}

/** Clave KMS de un cifrado SSE-KMS (la administrada por AWS si no se indica ninguna). */
function sseKey(ctx: Ctx, kmsKeyId?: string): KmsKey {
  return kmsKeyId ? viaS3(() => resolveKey(ctx, kmsKeyId)) : awsManagedKey(ctx, 's3');
}
const VIA = (ctx: Ctx): KmsAuthOpts => ({ via: `s3.${ctx.region}.amazonaws.com` });

function assertKeyUsable(key: KmsKey) {
  if (key.state === 'PendingDeletion') throw new AwsError('KMS.KMSInvalidStateException', `${key.arn} is pending deletion.`, 400);
  if (key.state === 'Disabled') throw new AwsError('KMS.DisabledException', `${key.arn} is disabled.`, 400);
}

/** Determina el cifrado efectivo de una escritura y comprueba los permisos de KMS (GenerateDataKey). */
export function sseForWrite(ctx: Ctx, b: S3Bucket, req?: { algorithm?: string; kmsKeyId?: string }): S3Object['sse'] {
  const algorithm = (req?.algorithm ?? b.encryption?.algorithm ?? 'AES256') as 'AES256' | 'aws:kms';
  if (algorithm !== 'AES256' && algorithm !== 'aws:kms') throw new AwsError('InvalidArgument', 'The encryption method specified is not supported', 400);
  if (algorithm === 'AES256') return { algorithm };
  const keyRef = req?.kmsKeyId ?? (req?.algorithm ? undefined : b.encryption?.kmsKeyId);
  const key = sseKey(ctx, keyRef);
  viaS3(() => kmsAuthorize(ctx, key, 'kms:GenerateDataKey', VIA(ctx)));
  assertKeyUsable(key);
  return { algorithm, kmsKeyId: key.arn };
}

/** Lectura de un objeto SSE-KMS: exige kms:Decrypt y que la clave siga disponible. */
export function checkSseRead(ctx: Ctx, o: S3Object): void {
  if (o.sse?.algorithm !== 'aws:kms') return;
  const key = viaS3(() => resolveKey(ctx, o.sse!.kmsKeyId!));
  viaS3(() => kmsAuthorize(ctx, key, 'kms:Decrypt', VIA(ctx)));
  assertKeyUsable(key);
}

export function createBucket(ctx: Ctx, p: { Bucket: string; Region?: string }): { Location: string } {
  return trailed(ctx, SRC, 'CreateBucket', [{ type: 'AWS::S3::Bucket', name: p.Bucket }], p, () => {
    if (!validBucketName(p.Bucket)) throw new AwsError('InvalidBucketName', 'The specified bucket is not valid.');
    authorize(ctx, 's3:CreateBucket', objArn(p.Bucket));
    const region = p.Region ?? ctx.region;
    if (ctx.s.buckets.some((b) => b.name === p.Bucket)) throw new AwsError('BucketAlreadyOwnedByYou', 'Your previous request to create the named bucket succeeded and you already own it.', 409);
    if (TAKEN.has(p.Bucket)) throw new AwsError('BucketAlreadyExists', 'The requested bucket name is not available. The bucket namespace is shared by all users of the system. Please select a different name and try again.', 409);
    const b: S3Bucket = {
      name: p.Bucket,
      region,
      createdAt: nowIso(),
      objects: {},
      versions: {},
      versioning: 'Disabled',
      publicAccessBlock: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
      encryption: { algorithm: 'AES256' },
      lifecycle: [],
      tags: {},
      acl: 'private',
      ownershipControls: 'BucketOwnerEnforced',
    };
    ctx.s.buckets.push(b);
    return { Location: `/${p.Bucket}` };
  });
}

export function listBuckets(ctx: Ctx) {
  return trailed(ctx, SRC, 'ListBuckets', [], {}, () => {
    authorize(ctx, 's3:ListAllMyBuckets', '*');
    return ctx.s.buckets.map((b) => ({ Name: b.name, CreationDate: b.createdAt }));
  });
}

export function deleteBucket(ctx: Ctx, p: { Bucket: string }): void {
  trailed(ctx, SRC, 'DeleteBucket', [{ type: 'AWS::S3::Bucket', name: p.Bucket }], p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:DeleteBucket', b);
    if (Object.keys(b.objects).length || Object.values(b.versions).some((v) => v.length)) {
      throw new AwsError('BucketNotEmpty', 'The bucket you tried to delete is not empty', 409);
    }
    ctx.s.buckets = ctx.s.buckets.filter((x) => x !== b);
  });
}

function sizeOf(s: string) {
  return new TextEncoder().encode(s).length;
}

export function putObject(ctx: Ctx, p: { Bucket: string; Key: string; Body?: string; ContentType?: string; Metadata?: Record<string, string>; StorageClass?: string; ServerSideEncryption?: string; SSEKMSKeyId?: string }) {
  return trailed(ctx, SRC, 'PutObject', [{ type: 'AWS::S3::Object', name: `${p.Bucket}/${p.Key}` }], { Bucket: p.Bucket, Key: p.Key }, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:PutObject', b, p.Key, {
      ...(p.ServerSideEncryption ? { 's3:x-amz-server-side-encryption': p.ServerSideEncryption } : {}),
      ...(p.SSEKMSKeyId ? { 's3:x-amz-server-side-encryption-aws-kms-key-id': p.SSEKMSKeyId } : {}),
    });
    if (!p.Key) throw new AwsError('InvalidArgument', 'Key is too short.');
    const sse = sseForWrite(ctx, b, p.ServerSideEncryption || p.SSEKMSKeyId ? { algorithm: p.ServerSideEncryption ?? 'aws:kms', kmsKeyId: p.SSEKMSKeyId } : undefined);
    // La política puede exigir cifrado en la subida.
    const prev = b.objects[p.Key];
    const body = p.Body ?? '';
    const o: S3Object = {
      key: p.Key,
      body,
      size: sizeOf(body),
      etag: ids.etag(),
      contentType: p.ContentType ?? guessType(p.Key),
      lastModified: nowIso(),
      storageClass: p.StorageClass ?? 'STANDARD',
      metadata: p.Metadata ?? {},
      tags: {},
      sse,
    };
    if (b.versioning === 'Enabled') {
      o.versionId = ids.etag().slice(0, 32);
      if (prev) (b.versions[p.Key] ??= []).push(prev);
    }
    b.objects[p.Key] = o;
    return { ETag: `"${o.etag}"`, VersionId: o.versionId, ServerSideEncryption: sse?.algorithm, SSEKMSKeyId: sse?.kmsKeyId };
  });
}

export function getObject(ctx: Ctx, p: { Bucket: string; Key: string; VersionId?: string }) {
  return trailed(ctx, SRC, 'GetObject', [{ type: 'AWS::S3::Object', name: `${p.Bucket}/${p.Key}` }], p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:GetObject', b, p.Key);
    let o: S3Object | undefined = b.objects[p.Key];
    if (p.VersionId) o = [...(b.versions[p.Key] ?? []), ...(o ? [o] : [])].find((x) => x.versionId === p.VersionId);
    if (!o || (o as any).deleteMarker) throw new AwsError('NoSuchKey', 'The specified key does not exist.', 404);
    checkSseRead(ctx, o);
    return o;
  });
}

export function headObject(ctx: Ctx, p: { Bucket: string; Key: string }) {
  return trailed(ctx, SRC, 'HeadObject', [], p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:GetObject', b, p.Key);
    const o = b.objects[p.Key];
    if (!o) throw new AwsError('404', 'Not Found', 404);
    return o;
  });
}

export function deleteObject(ctx: Ctx, p: { Bucket: string; Key: string; VersionId?: string }) {
  return trailed(ctx, SRC, 'DeleteObject', [{ type: 'AWS::S3::Object', name: `${p.Bucket}/${p.Key}` }], p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, p.VersionId ? 's3:DeleteObjectVersion' : 's3:DeleteObject', b, p.Key);
    if (p.VersionId) {
      const all = b.versions[p.Key] ?? [];
      const live = b.objects[p.Key];
      if (live?.versionId === p.VersionId) delete b.objects[p.Key];
      else b.versions[p.Key] = all.filter((x) => x.versionId !== p.VersionId);
      // Si ya no hay versión actual y lo último es una versión real (no una marca de borrado), pasa a ser la actual:
      // así se restaura un objeto borrando su marca de borrado.
      const rest = b.versions[p.Key] ?? [];
      const top = rest[rest.length - 1];
      if (!b.objects[p.Key] && top && !top.deleteMarker) {
        rest.pop();
        const { deleteMarker: _d, ...obj } = top;
        void _d;
        b.objects[p.Key] = obj;
      }
      return { VersionId: p.VersionId };
    }
    const prev = b.objects[p.Key];
    if (b.versioning === 'Enabled') {
      if (prev) (b.versions[p.Key] ??= []).push(prev);
      delete b.objects[p.Key];
      const marker = ids.etag().slice(0, 32);
      (b.versions[p.Key] ??= []).push({ ...(prev ?? emptyObj(p.Key)), versionId: marker, deleteMarker: true });
      return { DeleteMarker: true, VersionId: marker };
    }
    delete b.objects[p.Key];
    return {};
  });
}

function emptyObj(key: string): S3Object {
  return { key, body: '', size: 0, etag: '', contentType: '', lastModified: nowIso(), storageClass: 'STANDARD', metadata: {}, tags: {} };
}

export function listObjectsV2(ctx: Ctx, p: { Bucket: string; Prefix?: string; Delimiter?: string; MaxKeys?: number }) {
  return trailed(ctx, SRC, 'ListObjectsV2', [], p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:ListBucket', b);
    const prefix = p.Prefix ?? '';
    const keys = Object.keys(b.objects).filter((k) => k.startsWith(prefix)).sort();
    const contents: S3Object[] = [];
    const common = new Set<string>();
    for (const k of keys) {
      if (p.Delimiter) {
        const rest = k.slice(prefix.length);
        const i = rest.indexOf(p.Delimiter);
        if (i >= 0) {
          common.add(prefix + rest.slice(0, i + p.Delimiter.length));
          continue;
        }
      }
      contents.push(b.objects[k]);
    }
    const max = p.MaxKeys ?? 1000;
    return { Contents: contents.slice(0, max), CommonPrefixes: [...common], KeyCount: Math.min(contents.length, max) + common.size, IsTruncated: contents.length > max };
  });
}

export function copyObject(ctx: Ctx, p: { SourceBucket: string; SourceKey: string; Bucket: string; Key: string }) {
  return trailed(ctx, SRC, 'CopyObject', [], p, () => {
    const src = getBucket(ctx, p.SourceBucket);
    auth(ctx, 's3:GetObject', src, p.SourceKey);
    const o = src.objects[p.SourceKey];
    if (!o) throw new AwsError('NoSuchKey', 'The specified key does not exist.', 404);
    const dst = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:PutObject', dst, p.Key);
    checkSseRead(ctx, o);
    const sse = sseForWrite(ctx, dst);
    dst.objects[p.Key] = { ...o, key: p.Key, lastModified: nowIso(), etag: ids.etag(), sse };
    return { ETag: `"${dst.objects[p.Key].etag}"` };
  });
}

// ------------------------------------------------------------------ configuración del bucket

export function putBucketVersioning(ctx: Ctx, p: { Bucket: string; Status: 'Enabled' | 'Suspended' }): void {
  trailed(ctx, SRC, 'PutBucketVersioning', [], p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:PutBucketVersioning', b);
    b.versioning = p.Status;
  });
}

export function putPublicAccessBlock(ctx: Ctx, p: { Bucket: string; BlockPublicAcls: boolean; IgnorePublicAcls: boolean; BlockPublicPolicy: boolean; RestrictPublicBuckets: boolean }): void {
  trailed(ctx, SRC, 'PutPublicAccessBlock', [], p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:PutBucketPublicAccessBlock', b);
    b.publicAccessBlock = { BlockPublicAcls: p.BlockPublicAcls, IgnorePublicAcls: p.IgnorePublicAcls, BlockPublicPolicy: p.BlockPublicPolicy, RestrictPublicBuckets: p.RestrictPublicBuckets };
  });
}

/** ¿La política concede acceso a Principal "*"? */
export function isPublicPolicy(doc: PolicyDocument): boolean {
  return statements(doc).some((st) => {
    if (st.Effect !== 'Allow') return false;
    const pr = st.Principal;
    if (pr === '*') return true;
    if (pr && typeof pr === 'object') {
      const vals = Object.values<any>(pr).flat();
      return vals.includes('*');
    }
    return false;
  });
}

export function putBucketPolicy(ctx: Ctx, p: { Bucket: string; Policy: string | PolicyDocument }): void {
  trailed(ctx, SRC, 'PutBucketPolicy', [{ type: 'AWS::S3::Bucket', name: p.Bucket }], { Bucket: p.Bucket }, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:PutBucketPolicy', b);
    let obj: any = p.Policy;
    if (typeof obj === 'string') {
      try {
        obj = JSON.parse(obj);
      } catch {
        throw new AwsError('MalformedPolicy', 'Policy has invalid resource');
      }
    }
    const doc = validatePolicyDocument(obj, 'resource');
    for (const st of statements(doc)) {
      const resources = ([] as string[]).concat(st.Resource ?? []);
      if (!resources.length) throw new AwsError('MalformedPolicy', 'Missing required field Resource');
      if (!resources.every((r) => r === `arn:aws:s3:::${b.name}` || r.startsWith(`arn:aws:s3:::${b.name}/`))) {
        throw new AwsError('MalformedPolicy', 'Policy has invalid resource');
      }
    }
    if (isPublicPolicy(doc) && b.publicAccessBlock.BlockPublicPolicy) {
      throw new AwsError('AccessDenied', `User: ${ctx.caller.arn} is not authorized to perform: s3:PutBucketPolicy on resource: "arn:aws:s3:::${b.name}" because public policies are blocked by the BlockPublicPolicy block public access setting.`, 403);
    }
    b.policy = doc;
  });
}

export function getBucketPolicy(ctx: Ctx, p: { Bucket: string }): PolicyDocument {
  return trailed(ctx, SRC, 'GetBucketPolicy', [], p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:GetBucketPolicy', b);
    if (!b.policy) throw new AwsError('NoSuchBucketPolicy', 'The bucket policy does not exist', 404);
    return b.policy;
  });
}

export function deleteBucketPolicy(ctx: Ctx, p: { Bucket: string }): void {
  trailed(ctx, SRC, 'DeleteBucketPolicy', [], p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:DeleteBucketPolicy', b);
    delete b.policy;
  });
}

export function putBucketEncryption(ctx: Ctx, p: { Bucket: string; Algorithm: 'AES256' | 'aws:kms'; KmsKeyId?: string }): void {
  trailed(ctx, SRC, 'PutBucketEncryption', [], p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:PutEncryptionConfiguration', b);
    if (p.Algorithm !== 'AES256' && p.Algorithm !== 'aws:kms') throw new AwsError('MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema', 400);
    if (p.Algorithm === 'aws:kms' && p.KmsKeyId) {
      try {
        const k = resolveKey(ctx, p.KmsKeyId);
        if (k.state === 'PendingDeletion') throw new AwsError('InvalidArgument', 'Invalid KMS key: the key is pending deletion.', 400);
      } catch (e) {
        if (e instanceof AwsError && e.code === 'NotFoundException') throw new AwsError('KMS.NotFoundException', e.message, 400);
        throw e;
      }
    }
    if (p.Algorithm === 'aws:kms' && !p.KmsKeyId) awsManagedKey(ctx, 's3');
    b.encryption = { algorithm: p.Algorithm, kmsKeyId: p.KmsKeyId };
  });
}

export function putBucketWebsite(ctx: Ctx, p: { Bucket: string; IndexDocument: string; ErrorDocument?: string }): void {
  trailed(ctx, SRC, 'PutBucketWebsite', [], p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:PutBucketWebsite', b);
    b.website = { indexDocument: p.IndexDocument, errorDocument: p.ErrorDocument };
  });
}

export function putBucketTagging(ctx: Ctx, p: { Bucket: string; Tags: Record<string, string> }): void {
  trailed(ctx, SRC, 'PutBucketTagging', [], p, () => {
    const b = getBucket(ctx, p.Bucket);
    auth(ctx, 's3:PutBucketTagging', b);
    b.tags = { ...p.Tags };
  });
}

// ------------------------------------------------------------------ acceso anónimo (HTTP público)

export interface HttpResult {
  status: number;
  body: string;
  contentType: string;
}

/** Petición sin credenciales: lo que vería un navegador. Cubre acceso por política pública y web estática. */
export function anonymousGet(s: Ctx['s'], bucketName: string, key: string, viaWebsite = false): HttpResult {
  const b = s.buckets.find((x) => x.name === bucketName);
  if (!b) return { status: 404, body: '<Error><Code>NoSuchBucket</Code></Error>', contentType: 'application/xml' };
  if (viaWebsite && !b.website) return { status: 404, body: '<Error><Code>NoSuchWebsiteConfiguration</Code></Error>', contentType: 'application/xml' };
  let k = key;
  if (viaWebsite && (k === '' || k.endsWith('/'))) k += b.website!.indexDocument;
  const arn = objArn(b.name, k);
  const blocked = b.publicAccessBlock.RestrictPublicBuckets && !!b.policy && isPublicPolicy(b.policy);
  const allowed = !blocked && !!b.policy && evaluate({ action: 's3:GetObject', resource: arn, identity: [], resourcePolicy: b.policy, principalArn: '*', context: { 'aws:SecureTransport': 'true' } }).decision === 'Allow';
  const o = b.objects[k];
  if (!allowed) return { status: 403, body: '<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>', contentType: 'application/xml' };
  if (!o) {
    if (viaWebsite && b.website?.errorDocument && b.objects[b.website.errorDocument]) {
      return { status: 404, body: b.objects[b.website.errorDocument].body, contentType: 'text/html' };
    }
    return { status: 404, body: '<Error><Code>NoSuchKey</Code></Error>', contentType: 'application/xml' };
  }
  return { status: 200, body: o.body, contentType: o.contentType };
}

function guessType(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = { html: 'text/html', htm: 'text/html', css: 'text/css', js: 'application/javascript', json: 'application/json', txt: 'text/plain', md: 'text/markdown', png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml' };
  return (ext && map[ext]) || 'binary/octet-stream';
}

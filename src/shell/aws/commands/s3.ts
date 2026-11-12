// aws s3 (comandos de alto nivel), aws s3api y aws cloudtrail
import { defineCommand, type Params } from '../framework';
import * as s3 from '../../../engine/services/s3';
import { AwsError } from '../../../engine/errors';
import { eventShape } from '../shapes';
import { VFS } from '../../fs';
import type { Ctx } from '../../../engine/api';

const iso = (s: string) => s.replace(/\.\d+Z$/, '+00:00');

// ---------------------------------------------------------------- s3api
defineCommand({
  service: 's3api',
  name: 'create-bucket',
  op: 'CreateBucket',
  run: (c, p) => {
    const cfg = p.CreateBucketConfiguration;
    return s3.createBucket(c, { Bucket: p.Bucket, Region: cfg?.LocationConstraint });
  },
  structured: ['create-bucket-configuration'],
});
defineCommand({ service: 's3api', name: 'delete-bucket', op: 'DeleteBucket', run: (c, p) => void s3.deleteBucket(c, { Bucket: p.Bucket }) });
defineCommand({
  service: 's3api',
  name: 'list-buckets',
  op: 'ListBuckets',
  run: (c) => ({ Buckets: s3.listBuckets(c).map((b) => ({ ...b, CreationDate: iso(b.CreationDate) })), Owner: { DisplayName: c.caller.userName, ID: c.s.account.id } }),
});
defineCommand({
  service: 's3api',
  name: 'put-object',
  op: 'PutObject',
  run: (c, p, sh) => {
    let body = '';
    if (p.Body) {
      const path = VFS.norm(String(p.Body), sh.cwd);
      if (!sh.fs.isFile(path)) throw new AwsError('InvalidParameter', `Parameter validation failed:\nInvalid file or path: ${p.Body}`);
      body = sh.fs.readFile(path);
    }
    const r = s3.putObject(c, { Bucket: p.Bucket, Key: p.Key, Body: body, ContentType: p.ContentType, ServerSideEncryption: p.ServerSideEncryption, SSEKMSKeyId: p.SsekmsKeyId });
    return { ETag: r.ETag, ...(r.ServerSideEncryption ? { ServerSideEncryption: r.ServerSideEncryption } : {}), ...(r.VersionId ? { VersionId: r.VersionId } : {}), ...(r.SSEKMSKeyId ? { SSEKMSKeyId: r.SSEKMSKeyId, BucketKeyEnabled: false } : {}) };
  },
});
defineCommand({
  service: 's3api',
  name: 'get-object',
  op: 'GetObject',
  run: (c, p, sh, pos) => {
    const o = s3.getObject(c, { Bucket: p.Bucket, Key: p.Key, VersionId: p.VersionId });
    const out = pos[0];
    if (out) sh.fs.writeFile(VFS.norm(String(out), sh.cwd), o.body);
    return { AcceptRanges: 'bytes', LastModified: iso(o.lastModified), ContentLength: o.size, ETag: `"${o.etag}"`, ContentType: o.contentType, ServerSideEncryption: o.sse?.algorithm ?? 'AES256', ...(o.sse?.kmsKeyId ? { SSEKMSKeyId: o.sse.kmsKeyId, BucketKeyEnabled: false } : {}), Metadata: o.metadata };
  },
});
defineCommand({
  service: 's3api',
  name: 'head-object',
  op: 'HeadObject',
  run: (c, p) => {
    const o = s3.headObject(c, { Bucket: p.Bucket, Key: p.Key });
    return { AcceptRanges: 'bytes', LastModified: iso(o.lastModified), ContentLength: o.size, ETag: `"${o.etag}"`, ContentType: o.contentType, ServerSideEncryption: o.sse?.algorithm ?? 'AES256', ...(o.sse?.kmsKeyId ? { SSEKMSKeyId: o.sse.kmsKeyId } : {}), Metadata: o.metadata };
  },
});
defineCommand({ service: 's3api', name: 'delete-object', op: 'DeleteObject', run: (c, p) => s3.deleteObject(c, { Bucket: p.Bucket, Key: p.Key, VersionId: p.VersionId }) });
defineCommand({
  service: 's3api',
  name: 'list-objects-v2',
  op: 'ListObjectsV2',
  run: (c, p) => {
    const r = s3.listObjectsV2(c, { Bucket: p.Bucket, Prefix: p.Prefix, Delimiter: p.Delimiter, MaxKeys: p.MaxItems && Number(p.MaxItems) });
    const out: Record<string, any> = {};
    if (r.Contents.length) out.Contents = r.Contents.map((o) => ({ Key: o.key, LastModified: iso(o.lastModified), ETag: `"${o.etag}"`, Size: o.size, StorageClass: o.storageClass }));
    if (r.CommonPrefixes.length) out.CommonPrefixes = r.CommonPrefixes.map((x) => ({ Prefix: x }));
    return out;
  },
});
defineCommand({
  service: 's3api',
  name: 'put-bucket-versioning',
  op: 'PutBucketVersioning',
  structured: ['versioning-configuration'],
  run: (c, p) => void s3.putBucketVersioning(c, { Bucket: p.Bucket, Status: p.VersioningConfiguration?.Status }),
});
defineCommand({
  service: 's3api',
  name: 'put-public-access-block',
  op: 'PutPublicAccessBlock',
  structured: ['public-access-block-configuration'],
  run: (c, p) => {
    const cfg = p.PublicAccessBlockConfiguration ?? {};
    const b = (k: string) => String(cfg[k]) === 'true';
    s3.putPublicAccessBlock(c, { Bucket: p.Bucket, BlockPublicAcls: b('BlockPublicAcls'), IgnorePublicAcls: b('IgnorePublicAcls'), BlockPublicPolicy: b('BlockPublicPolicy'), RestrictPublicBuckets: b('RestrictPublicBuckets') });
  },
});
defineCommand({ service: 's3api', name: 'put-bucket-policy', op: 'PutBucketPolicy', run: (c, p) => void s3.putBucketPolicy(c, { Bucket: p.Bucket, Policy: p.Policy }) });
defineCommand({ service: 's3api', name: 'get-bucket-policy', op: 'GetBucketPolicy', run: (c, p) => ({ Policy: JSON.stringify(s3.getBucketPolicy(c, { Bucket: p.Bucket })) }) });
defineCommand({ service: 's3api', name: 'delete-bucket-policy', op: 'DeleteBucketPolicy', run: (c, p) => void s3.deleteBucketPolicy(c, { Bucket: p.Bucket }) });
defineCommand({
  service: 's3api',
  name: 'put-bucket-encryption',
  op: 'PutBucketEncryption',
  structured: ['server-side-encryption-configuration'],
  run: (c, p) => {
    const rule = p.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault ?? {};
    s3.putBucketEncryption(c, { Bucket: p.Bucket, Algorithm: rule.SSEAlgorithm, KmsKeyId: rule.KMSMasterKeyID });
  },
});
defineCommand({
  service: 's3api',
  name: 'put-bucket-website',
  op: 'PutBucketWebsite',
  structured: ['website-configuration'],
  run: (c, p) => void s3.putBucketWebsite(c, { Bucket: p.Bucket, IndexDocument: p.WebsiteConfiguration?.IndexDocument?.Suffix, ErrorDocument: p.WebsiteConfiguration?.ErrorDocument?.Key }),
});
defineCommand({
  service: 's3api',
  name: 'put-bucket-tagging',
  op: 'PutBucketTagging',
  structured: ['tagging'],
  run: (c, p) => void s3.putBucketTagging(c, { Bucket: p.Bucket, Tags: Object.fromEntries((p.Tagging?.TagSet ?? []).map((t: any) => [t.Key, t.Value])) }),
});

// ---------------------------------------------------------------- cloudtrail
defineCommand({
  service: 'cloudtrail',
  name: 'lookup-events',
  op: 'LookupEvents',
  list: ['lookup-attributes'],
  structured: ['lookup-attributes'],
  run: (c: Ctx, p: Params) => {
    const attrs: { AttributeKey: string; AttributeValue: string }[] = (p.LookupAttributes ?? []).flat();
    const max = p.MaxItems ? Number(p.MaxItems) : 50;
    const events = [...c.s.trail]
      .reverse()
      .filter((e) => attrs.every((a) => (a.AttributeKey === 'EventName' ? e.eventName === a.AttributeValue : a.AttributeKey === 'Username' ? e.userName === a.AttributeValue : a.AttributeKey === 'EventSource' ? e.eventSource === a.AttributeValue : true)))
      .slice(0, max);
    return { Events: events.map(eventShape) };
  },
});

// aws s3api (operaciones complementarias) y aws s3 presign
import { defineCommand } from '../framework';
import * as x from '../../../engine/services/s3Extra';
import * as s3 from '../../../engine/services/s3';
import { AwsError } from '../../../engine/errors';

const iso = (s: string) => s.replace(/\.\d+Z$/, '+00:00');
const tagSet = (t: Record<string, string>) => Object.entries(t).map(([Key, Value]) => ({ Key, Value }));
const owner = (c: any) => ({ DisplayName: c.s.account.alias ?? c.s.users[0]?.name ?? 'owner', ID: (c.s.account.id.repeat(3)).slice(0, 12).padEnd(64, 'a1b2c3d4e5f6') });

defineCommand({ service: 's3api', name: 'put-bucket-acl', op: 'PutBucketAcl', run: (c, p) => void x.putBucketAcl(c, { Bucket: p.Bucket, ACL: p.Acl }) });
defineCommand({ service: 's3api', name: 'get-bucket-acl', op: 'GetBucketAcl', run: (c, p) => x.getBucketAcl(c, { Bucket: p.Bucket }) });
defineCommand({
  service: 's3api', name: 'put-bucket-ownership-controls', op: 'PutBucketOwnershipControls', structured: ['ownership-controls'],
  run: (c, p) => void x.putBucketOwnershipControls(c, { Bucket: p.Bucket, ObjectOwnership: p.OwnershipControls?.Rules?.[0]?.ObjectOwnership }),
});
defineCommand({ service: 's3api', name: 'get-bucket-ownership-controls', op: 'GetBucketOwnershipControls', run: (c, p) => ({ OwnershipControls: { Rules: [{ ObjectOwnership: x.getBucketOwnershipControls(c, { Bucket: p.Bucket }) }] } }) });

defineCommand({
  service: 's3api', name: 'put-bucket-lifecycle-configuration', op: 'PutBucketLifecycleConfiguration', structured: ['lifecycle-configuration'],
  run: (c, p) => void x.putBucketLifecycle(c, { Bucket: p.Bucket, Rules: p.LifecycleConfiguration?.Rules }),
});
defineCommand({ service: 's3api', name: 'get-bucket-lifecycle-configuration', op: 'GetBucketLifecycleConfiguration', run: (c, p) => ({ TransitionDefaultMinimumObjectSize: 'all_storage_classes_128K', Rules: x.getBucketLifecycle(c, { Bucket: p.Bucket }) }) });
defineCommand({ service: 's3api', name: 'delete-bucket-lifecycle', op: 'DeleteBucketLifecycle', run: (c, p) => void x.deleteBucketLifecycle(c, { Bucket: p.Bucket }) });

defineCommand({
  service: 's3api', name: 'get-bucket-website', op: 'GetBucketWebsite',
  run: (c, p) => {
    const w = x.getBucketWebsite(c, { Bucket: p.Bucket });
    return { IndexDocument: { Suffix: w.indexDocument }, ...(w.errorDocument ? { ErrorDocument: { Key: w.errorDocument } } : {}) };
  },
});
defineCommand({ service: 's3api', name: 'delete-bucket-website', op: 'DeleteBucketWebsite', run: (c, p) => void x.deleteBucketWebsite(c, { Bucket: p.Bucket }) });
defineCommand({
  service: 's3api', name: 'get-bucket-versioning', op: 'GetBucketVersioning',
  run: (c, p) => {
    const v = x.getBucketVersioning(c, { Bucket: p.Bucket });
    return v === 'Disabled' ? undefined : { Status: v };
  },
});
defineCommand({
  service: 's3api', name: 'get-bucket-encryption', op: 'GetBucketEncryption',
  run: (c, p) => {
    const e = x.getBucketEncryption(c, { Bucket: p.Bucket });
    return { ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: e.algorithm, ...(e.kmsKeyId ? { KMSMasterKeyID: e.kmsKeyId } : {}) }, BucketKeyEnabled: false }] } };
  },
});
defineCommand({ service: 's3api', name: 'delete-bucket-encryption', op: 'DeleteBucketEncryption', run: (c, p) => void x.deleteBucketEncryption(c, { Bucket: p.Bucket }) });
defineCommand({ service: 's3api', name: 'get-public-access-block', op: 'GetPublicAccessBlock', run: (c, p) => ({ PublicAccessBlockConfiguration: x.getPublicAccessBlock(c, { Bucket: p.Bucket }) }) });
defineCommand({ service: 's3api', name: 'delete-public-access-block', op: 'DeletePublicAccessBlock', run: (c, p) => void x.deletePublicAccessBlock(c, { Bucket: p.Bucket }) });

defineCommand({ service: 's3api', name: 'put-bucket-cors', op: 'PutBucketCors', structured: ['cors-configuration'], run: (c, p) => void x.putBucketCors(c, { Bucket: p.Bucket, CORSRules: p.CORSConfiguration?.CORSRules ?? p.CorsConfiguration?.CORSRules }) });
defineCommand({ service: 's3api', name: 'get-bucket-cors', op: 'GetBucketCors', run: (c, p) => ({ CORSRules: x.getBucketCors(c, { Bucket: p.Bucket }) }) });
defineCommand({ service: 's3api', name: 'delete-bucket-cors', op: 'DeleteBucketCors', run: (c, p) => void x.deleteBucketCors(c, { Bucket: p.Bucket }) });
defineCommand({ service: 's3api', name: 'get-bucket-tagging', op: 'GetBucketTagging', run: (c, p) => ({ TagSet: tagSet(x.getBucketTagging(c, { Bucket: p.Bucket })) }) });
defineCommand({ service: 's3api', name: 'get-bucket-policy-status', op: 'GetBucketPolicyStatus', run: (c, p) => ({ PolicyStatus: { IsPublic: !!s3.getBucketPolicy(c, { Bucket: p.Bucket }) && s3.isPublicPolicy(s3.getBucketPolicy(c, { Bucket: p.Bucket })) } }) });

defineCommand({
  service: 's3api', name: 'put-object-tagging', op: 'PutObjectTagging', structured: ['tagging'],
  run: (c, p) => void x.putObjectTagging(c, { Bucket: p.Bucket, Key: p.Key, Tags: Object.fromEntries((p.Tagging?.TagSet ?? []).map((t: any) => [t.Key, t.Value])) }),
});
defineCommand({ service: 's3api', name: 'get-object-tagging', op: 'GetObjectTagging', run: (c, p) => ({ TagSet: tagSet(x.getObjectTagging(c, { Bucket: p.Bucket, Key: p.Key })) }) });
defineCommand({ service: 's3api', name: 'delete-object-tagging', op: 'DeleteObjectTagging', run: (c, p) => void x.deleteObjectTagging(c, { Bucket: p.Bucket, Key: p.Key }) });

defineCommand({
  service: 's3api', name: 'copy-object', op: 'CopyObject',
  run: (c, p) => {
    const src = String(p.CopySource ?? '').replace(/^\//, '');
    const i = src.indexOf('/');
    if (i < 0) throw new AwsError('InvalidArgument', 'Invalid copy source object key', 400);
    const r = s3.copyObject(c, { SourceBucket: src.slice(0, i), SourceKey: src.slice(i + 1).split('?')[0], Bucket: p.Bucket, Key: p.Key });
    const o = s3.getBucket(c, p.Bucket).objects[p.Key];
    return { CopyObjectResult: { ETag: r.ETag, LastModified: iso(o.lastModified) } };
  },
});

defineCommand({
  service: 's3api', name: 'list-object-versions', op: 'ListObjectVersions',
  run: (c, p) => {
    const all = x.listObjectVersions(c, { Bucket: p.Bucket, Prefix: p.Prefix });
    const o = owner(c);
    const out: Record<string, any> = {};
    const vs = all.filter((v) => !v.DeleteMarker).map((v) => ({ ETag: v.ETag, Size: v.Size, StorageClass: v.StorageClass, Key: v.Key, VersionId: v.VersionId, IsLatest: v.IsLatest, LastModified: iso(v.LastModified), Owner: o }));
    const dm = all.filter((v) => v.DeleteMarker).map((v) => ({ Owner: o, Key: v.Key, VersionId: v.VersionId, IsLatest: v.IsLatest, LastModified: iso(v.LastModified) }));
    if (vs.length) out.Versions = vs;
    if (dm.length) out.DeleteMarkers = dm;
    return out;
  },
});

// aws s3 presign s3://bucket/key [--expires-in N]
defineCommand({
  service: 's3', name: 'presign', op: 'PresignUrl', raw: true,
  run: (c, p, sh, pos) => {
    const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(pos[0] ?? '');
    if (!m) throw new Error('\nusage: aws s3 presign <S3Uri> [--expires-in <value>]\nerror: the following arguments are required: path');
    const id = c.caller.accessKeyId!;
    const sess = c.s.sessions.find((x) => x.accessKeyId === id);
    const secret = sess?.secret ?? c.s.users.find((u) => u.accessKeys.some((k) => k.id === id))?.accessKeys.find((k) => k.id === id)?.secret ?? '';
    void sh;
    return x.presign(c, { Bucket: m[1], Key: m[2], ExpiresIn: p.ExpiresIn ? Number(p.ExpiresIn) : undefined, Secret: secret, AccessKeyId: id, Token: sess?.token }) + '\n';
  },
});

// AWS CloudTrail: trails que entregan eventos de administración a un bucket de S3.
import type { EventSelector, Trail } from '../types';
import { AwsError } from '../errors';
import { authorize, trailed, type Ctx } from '../api';
import { nowIso } from '../util';
import { statements } from '../policy';
import { getKmsKeyOrNull } from './kmsLookup';

const SRC = 'cloudtrail.amazonaws.com';
const trailArn = (ctx: Ctx, name: string, region = ctx.region) => `arn:aws:cloudtrail:${region}:${ctx.s.account.id}:trail/${name}`;

export function defaultSelector(): EventSelector {
  return { ReadWriteType: 'All', IncludeManagementEvents: true, DataResources: [], ExcludeManagementEventSources: [] };
}

function nameOf(id: string) {
  return id.startsWith('arn:') ? id.split('/').pop()! : id;
}

export function getTrailOr(ctx: Ctx, id: string): Trail {
  const t = ctx.s.trails.find((x) => (x.name === nameOf(id) && (id.startsWith('arn:') ? x.arn === id : x.homeRegion === ctx.region || x.multiRegion)));
  if (!t) throw new AwsError('TrailNotFoundException', `Unknown trail: ${id} for the user: ${ctx.s.account.id}`, 404);
  return t;
}

function bucketPolicyOk(ctx: Ctx, bucket: string): boolean {
  const b = ctx.s.buckets.find((x) => x.name === bucket)!;
  if (!b.policy) return false;
  const sts = statements(b.policy).filter((st) => st.Effect === 'Allow' && JSON.stringify(st.Principal ?? {}).includes('cloudtrail.amazonaws.com'));
  const acts = (st: any) => ([] as string[]).concat(st.Action ?? []).map((a) => a.toLowerCase());
  const hasAcl = sts.some((st) => acts(st).some((a) => a === 's3:getbucketacl' || a === 's3:*'));
  const hasPut = sts.some((st) => acts(st).some((a) => a === 's3:putobject' || a === 's3:*'));
  return hasAcl && hasPut;
}

export function createTrail(ctx: Ctx, p: { Name: string; S3BucketName: string; S3KeyPrefix?: string; IsMultiRegionTrail?: boolean; IncludeGlobalServiceEvents?: boolean; EnableLogFileValidation?: boolean; KmsKeyId?: string }): Trail {
  return trailed(ctx, SRC, 'CreateTrail', [{ type: 'AWS::CloudTrail::Trail', name: p.Name }], p, () => {
    authorize(ctx, 'cloudtrail:CreateTrail', trailArn(ctx, p.Name));
    if (p.Name.length < 3) throw new AwsError('InvalidTrailNameException', `Trail name too short. Minimum allowed length is 3 characters. (Specified name: ${p.Name})`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/.test(p.Name) || /[._-]{2}/.test(p.Name)) {
      throw new AwsError('InvalidTrailNameException', `Trail name must start with a letter or number, end with a letter or number, and contain only letters, numbers, periods, underscores, or dashes. (Specified name: ${p.Name})`);
    }
    if (ctx.s.trails.some((t) => t.name === p.Name)) throw new AwsError('TrailAlreadyExistsException', `Trail ${p.Name} already exists for customer: ${ctx.s.account.id}`);
    if (!ctx.s.buckets.some((b) => b.name === p.S3BucketName)) throw new AwsError('S3BucketDoesNotExistException', 'S3 bucket does not exist.');
    if (!bucketPolicyOk(ctx, p.S3BucketName)) throw new AwsError('InsufficientS3BucketPolicyException', `Incorrect S3 bucket policy is detected for bucket: ${p.S3BucketName}`);
    if (p.KmsKeyId) {
      const k = getKmsKeyOrNull(ctx, p.KmsKeyId);
      if (!k) throw new AwsError('KmsKeyNotFoundException', `Invalid KMS key ARN or alias: ${p.KmsKeyId}`);
    }
    const t: Trail = {
      name: p.Name, arn: trailArn(ctx, p.Name), homeRegion: ctx.region, s3Bucket: p.S3BucketName, s3Prefix: p.S3KeyPrefix,
      multiRegion: !!p.IsMultiRegionTrail, includeGlobal: p.IncludeGlobalServiceEvents ?? true, logValidation: !!p.EnableLogFileValidation,
      kmsKeyId: p.KmsKeyId, logging: false, selectors: [defaultSelector()], createdAt: nowIso(),
    };
    ctx.s.trails.push(t);
    return t;
  });
}

export function describeTrails(ctx: Ctx, p: { TrailNameList?: string[] }): Trail[] {
  return trailed(ctx, SRC, 'DescribeTrails', [], p, () => {
    authorize(ctx, 'cloudtrail:DescribeTrails', '*');
    let list = ctx.s.trails.filter((t) => t.homeRegion === ctx.region || t.multiRegion);
    if (p.TrailNameList?.length) list = list.filter((t) => p.TrailNameList!.some((n) => n === t.name || n === t.arn));
    return list;
  });
}

export function listTrails(ctx: Ctx): Trail[] {
  return trailed(ctx, SRC, 'ListTrails', [], {}, () => {
    authorize(ctx, 'cloudtrail:ListTrails', '*');
    return ctx.s.trails;
  });
}

export function startLogging(ctx: Ctx, p: { Name: string }): void {
  trailed(ctx, SRC, 'StartLogging', [{ type: 'AWS::CloudTrail::Trail', name: nameOf(p.Name) }], p, () => {
    const t = getTrailOr(ctx, p.Name);
    authorize(ctx, 'cloudtrail:StartLogging', t.arn);
    t.logging = true;
    t.startedAt = nowIso();
  });
}
export function stopLogging(ctx: Ctx, p: { Name: string }): void {
  trailed(ctx, SRC, 'StopLogging', [{ type: 'AWS::CloudTrail::Trail', name: nameOf(p.Name) }], p, () => {
    const t = getTrailOr(ctx, p.Name);
    authorize(ctx, 'cloudtrail:StopLogging', t.arn);
    t.logging = false;
    t.stoppedAt = nowIso();
  });
}
export function getTrailStatus(ctx: Ctx, p: { Name: string }) {
  return trailed(ctx, SRC, 'GetTrailStatus', [], p, () => {
    const t = getTrailOr(ctx, p.Name);
    authorize(ctx, 'cloudtrail:GetTrailStatus', t.arn);
    return t;
  });
}
export function deleteTrail(ctx: Ctx, p: { Name: string }): void {
  trailed(ctx, SRC, 'DeleteTrail', [{ type: 'AWS::CloudTrail::Trail', name: nameOf(p.Name) }], p, () => {
    const t = getTrailOr(ctx, p.Name);
    authorize(ctx, 'cloudtrail:DeleteTrail', t.arn);
    ctx.s.trails = ctx.s.trails.filter((x) => x !== t);
  });
}
export function updateTrail(ctx: Ctx, p: { Name: string; S3BucketName?: string; S3KeyPrefix?: string; IsMultiRegionTrail?: boolean; EnableLogFileValidation?: boolean; KmsKeyId?: string }): Trail {
  return trailed(ctx, SRC, 'UpdateTrail', [{ type: 'AWS::CloudTrail::Trail', name: nameOf(p.Name) }], p, () => {
    const t = getTrailOr(ctx, p.Name);
    authorize(ctx, 'cloudtrail:UpdateTrail', t.arn);
    if (p.S3BucketName) {
      if (!ctx.s.buckets.some((b) => b.name === p.S3BucketName)) throw new AwsError('S3BucketDoesNotExistException', 'S3 bucket does not exist.');
      if (!bucketPolicyOk(ctx, p.S3BucketName)) throw new AwsError('InsufficientS3BucketPolicyException', `Incorrect S3 bucket policy is detected for bucket: ${p.S3BucketName}`);
      t.s3Bucket = p.S3BucketName;
    }
    if (p.S3KeyPrefix !== undefined) t.s3Prefix = p.S3KeyPrefix;
    if (p.IsMultiRegionTrail !== undefined) t.multiRegion = p.IsMultiRegionTrail;
    if (p.EnableLogFileValidation !== undefined) t.logValidation = p.EnableLogFileValidation;
    if (p.KmsKeyId) t.kmsKeyId = p.KmsKeyId;
    return t;
  });
}
export function getEventSelectors(ctx: Ctx, p: { TrailName: string }) {
  return trailed(ctx, SRC, 'GetEventSelectors', [], p, () => {
    const t = getTrailOr(ctx, p.TrailName);
    authorize(ctx, 'cloudtrail:GetEventSelectors', t.arn);
    return t;
  });
}
export function putEventSelectors(ctx: Ctx, p: { TrailName: string; EventSelectors: Partial<EventSelector>[] }) {
  return trailed(ctx, SRC, 'PutEventSelectors', [], p, () => {
    const t = getTrailOr(ctx, p.TrailName);
    authorize(ctx, 'cloudtrail:PutEventSelectors', t.arn);
    if (!p.EventSelectors?.length || p.EventSelectors.length > 5) throw new AwsError('InvalidEventSelectorsException', 'Event selectors must contain between 1 and 5 selectors.');
    t.selectors = p.EventSelectors.map((e) => ({
      ReadWriteType: (e.ReadWriteType as EventSelector['ReadWriteType']) ?? 'All',
      IncludeManagementEvents: String(e.IncludeManagementEvents ?? true) !== 'false',
      DataResources: e.DataResources ?? [],
      ExcludeManagementEventSources: e.ExcludeManagementEventSources ?? [],
    }));
    return t;
  });
}

// aws cloudtrail (administración de trails)
import { defineCommand } from '../framework';
import * as ct from '../../../engine/services/cloudtrail';
import type { Trail } from '../../../engine/types';

const iso = (s?: string) => (s ? s.replace(/\.\d+Z$/, '+00:00') : s);
const isoZ = (s?: string) => (s ? s.replace(/\.\d+Z$/, 'Z') : '');

const created = (t: Trail) => ({
  Name: t.name, S3BucketName: t.s3Bucket, ...(t.s3Prefix ? { S3KeyPrefix: t.s3Prefix } : {}), IncludeGlobalServiceEvents: t.includeGlobal, IsMultiRegionTrail: t.multiRegion,
  TrailARN: t.arn, LogFileValidationEnabled: t.logValidation, ...(t.kmsKeyId ? { KmsKeyId: t.kmsKeyId } : {}), IsOrganizationTrail: false,
});
const described = (t: Trail) => ({
  Name: t.name, S3BucketName: t.s3Bucket, ...(t.s3Prefix ? { S3KeyPrefix: t.s3Prefix } : {}), IncludeGlobalServiceEvents: t.includeGlobal, IsMultiRegionTrail: t.multiRegion,
  HomeRegion: t.homeRegion, TrailARN: t.arn, LogFileValidationEnabled: t.logValidation, ...(t.kmsKeyId ? { KmsKeyId: t.kmsKeyId } : {}),
  HasCustomEventSelectors: JSON.stringify(t.selectors) !== JSON.stringify([ct.defaultSelector()]), HasInsightSelectors: false, IsOrganizationTrail: false,
});

defineCommand({
  service: 'cloudtrail', name: 'create-trail', op: 'CreateTrail', bool: ['is-multi-region-trail', 'include-global-service-events', 'enable-log-file-validation'],
  run: (c, p) => created(ct.createTrail(c, { Name: p.Name, S3BucketName: p.S3BucketName, S3KeyPrefix: p.S3KeyPrefix, IsMultiRegionTrail: p.IsMultiRegionTrail, IncludeGlobalServiceEvents: p.IncludeGlobalServiceEvents, EnableLogFileValidation: p.EnableLogFileValidation, KmsKeyId: p.KmsKeyId })),
});
defineCommand({
  service: 'cloudtrail', name: 'update-trail', op: 'UpdateTrail', bool: ['is-multi-region-trail', 'enable-log-file-validation'],
  run: (c, p) => created(ct.updateTrail(c, { Name: p.Name, S3BucketName: p.S3BucketName, S3KeyPrefix: p.S3KeyPrefix, IsMultiRegionTrail: p.IsMultiRegionTrail, EnableLogFileValidation: p.EnableLogFileValidation, KmsKeyId: p.KmsKeyId })),
});
defineCommand({ service: 'cloudtrail', name: 'describe-trails', op: 'DescribeTrails', list: ['trail-name-list'], run: (c, p) => ({ trailList: ct.describeTrails(c, { TrailNameList: p.TrailNameList }).map(described) }) });
defineCommand({ service: 'cloudtrail', name: 'list-trails', op: 'ListTrails', run: (c) => ({ Trails: ct.listTrails(c).map((t) => ({ TrailARN: t.arn, Name: t.name, HomeRegion: t.homeRegion })) }) });
defineCommand({ service: 'cloudtrail', name: 'start-logging', op: 'StartLogging', run: (c, p) => void (ct.startLogging(c, { Name: p.Name }), {}) });
defineCommand({ service: 'cloudtrail', name: 'stop-logging', op: 'StopLogging', run: (c, p) => void (ct.stopLogging(c, { Name: p.Name }), {}) });
defineCommand({ service: 'cloudtrail', name: 'delete-trail', op: 'DeleteTrail', run: (c, p) => void ct.deleteTrail(c, { Name: p.Name }) });
defineCommand({
  service: 'cloudtrail', name: 'get-trail-status', op: 'GetTrailStatus',
  run: (c, p) => {
    const t = ct.getTrailStatus(c, { Name: p.Name });
    const delivered = t.lastDelivery ? iso(t.lastDelivery) : undefined;
    return {
      IsLogging: t.logging,
      ...(delivered ? { LatestDeliveryTime: delivered } : {}),
      ...(t.startedAt ? { StartLoggingTime: iso(t.startedAt) } : {}),
      ...(t.stoppedAt ? { StopLoggingTime: iso(t.stoppedAt) } : {}),
      LatestDeliveryAttemptTime: isoZ(t.lastDelivery), LatestNotificationAttemptTime: '', LatestNotificationAttemptSucceeded: '',
      LatestDeliveryAttemptSucceeded: isoZ(t.lastDelivery), TimeLoggingStarted: isoZ(t.startedAt), TimeLoggingStopped: t.logging ? '' : isoZ(t.stoppedAt),
    };
  },
});
defineCommand({
  service: 'cloudtrail', name: 'get-event-selectors', op: 'GetEventSelectors',
  run: (c, p) => {
    const t = ct.getEventSelectors(c, { TrailName: p.TrailName });
    return { TrailARN: t.arn, EventSelectors: t.selectors };
  },
});
defineCommand({
  service: 'cloudtrail', name: 'put-event-selectors', op: 'PutEventSelectors', list: ['event-selectors'], structured: ['event-selectors'],
  run: (c, p) => {
    const t = ct.putEventSelectors(c, { TrailName: p.TrailName, EventSelectors: (p.EventSelectors ?? []).flat() });
    return { TrailARN: t.arn, EventSelectors: t.selectors };
  },
});

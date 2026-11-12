// Entrega de eventos de CloudTrail a S3 mientras un trail está registrando.
// Simplificación documentada: AWS entrega los archivos cada ~5 minutos; aquí el objeto de la ventana de 5 minutos
// se actualiza al instante para que el alumno pueda inspeccionarlo sin esperar. El cuerpo es JSON sin comprimir
// aunque el nombre termine en .json.gz.
import type { CloudState, TrailEvent, S3Object } from './types';
import { hex } from './util';

const WINDOW_MS = 5 * 60 * 1000;

function identityOf(s: CloudState, e: TrailEvent) {
  const arn = e.principalArn;
  const type = arn.endsWith(':root') ? 'Root' : arn.includes(':assumed-role/') ? 'AssumedRole' : 'IAMUser';
  const base: Record<string, unknown> = { type, principalId: e.userName, arn, accountId: s.account.id };
  if (type === 'IAMUser') base.userName = e.userName;
  return base;
}

export function recordOf(s: CloudState, e: TrailEvent) {
  const r: Record<string, unknown> = {
    eventVersion: '1.09',
    userIdentity: identityOf(s, e),
    eventTime: e.time.replace(/\.\d+Z$/, 'Z'),
    eventSource: e.eventSource,
    eventName: e.eventName,
    awsRegion: e.region,
    sourceIPAddress: e.sourceIp,
    userAgent: 'aws-cli/2.17.0',
    requestParameters: e.requestParameters ?? null,
    responseElements: null,
    requestID: e.id.toUpperCase(),
    eventID: e.id,
    readOnly: e.readOnly,
    eventType: 'AwsApiCall',
    managementEvent: true,
    recipientAccountId: s.account.id,
    eventCategory: 'Management',
  };
  if (e.errorCode) {
    r.errorCode = e.errorCode;
    r.errorMessage = e.errorMessage;
  }
  return r;
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 13) + 'Z';
}

/** Añade el evento al objeto de la ventana actual en el bucket de cada trail que esté registrando. */
export function deliverEvent(s: CloudState, e: TrailEvent): void {
  if (!s.trails?.length) return;
  for (const t of s.trails) {
    if (!t.logging) continue;
    if (!t.multiRegion && t.homeRegion !== e.region) continue;
    const sel = t.selectors[0];
    if (sel) {
      if (!sel.IncludeManagementEvents) continue;
      if (sel.ReadWriteType === 'ReadOnly' && !e.readOnly) continue;
      if (sel.ReadWriteType === 'WriteOnly' && e.readOnly) continue;
      if (sel.ExcludeManagementEventSources?.includes(e.eventSource)) continue;
    }
    const bucket = s.buckets.find((b) => b.name === t.s3Bucket);
    if (!bucket) continue;
    const t0 = Math.floor(new Date(e.time).getTime() / WINDOW_MS) * WINDOW_MS;
    const dt = new Date(t0).toISOString();
    const dir = `${t.s3Prefix ? t.s3Prefix.replace(/\/$/, '') + '/' : ''}AWSLogs/${s.account.id}/CloudTrail/${e.region}/${dt.slice(0, 4)}/${dt.slice(5, 7)}/${dt.slice(8, 10)}/`;
    const stampKey = `${s.account.id}_CloudTrail_${e.region}_${stamp(t0)}_${t.name}`;
    const existing = Object.keys(bucket.objects).find((k) => k.startsWith(dir + stampKey));
    const rec = recordOf(s, e);
    if (existing) {
      const o = bucket.objects[existing];
      const doc = JSON.parse(o.body) as { Records: unknown[] };
      doc.Records.push(rec);
      o.body = JSON.stringify(doc);
      o.size = o.body.length;
      o.lastModified = e.time;
    } else {
      const body = JSON.stringify({ Records: [rec] });
      const key = `${dir}${stampKey}_${hex(8)}.json.gz`;
      const obj: S3Object = { key, body, size: body.length, etag: hex(32), contentType: 'application/x-gzip', lastModified: e.time, storageClass: 'STANDARD', metadata: {}, tags: {} };
      bucket.objects[key] = obj;
    }
    t.lastDelivery = e.time;
  }
}

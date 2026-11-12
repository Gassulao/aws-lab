// Amazon SQS: colas estándar y FIFO, envío/recepción, visibilidad, DLQ con redrive, retraso y atributos.
// El paso del tiempo usa el reloj inyectable (now): un mensaje recibido reaparece cuando vence su visibilidad.
import { AwsError } from '../errors';
import { trailed, type Ctx } from '../api';
import type { CloudState } from '../types';
import { guid, hex, now } from '../util';
import { emitMetric } from '../services/cloudwatch';
import { sv, type SqsMessage, type SqsQueue } from './types';
import { svAuthorize, md5, asArr } from './util';
import { bridge } from './bridge';

const SRC = 'sqs.amazonaws.com';
const MAX_BYTES = 262_144;
const queueUrl = (region: string, acct: string, name: string) => `https://sqs.${region}.amazonaws.com/${acct}/${name}`;
const queueArn = (region: string, acct: string, name: string) => `arn:aws:sqs:${region}:${acct}:${name}`;
const auth = (ctx: Ctx, action: string, q: SqsQueue) => svAuthorize(ctx, action, q.arn, 'sqs', { resourcePolicy: q.attrs.Policy ? safeJson(q.attrs.Policy) : undefined });
const safeJson = (t: string) => { try { return JSON.parse(t); } catch { return undefined; } };
const invalid = (m: string) => new AwsError('InvalidParameterValue', m, 400);

const DEFAULTS: Record<string, string> = { VisibilityTimeout: '30', MessageRetentionPeriod: '345600', DelaySeconds: '0', MaximumMessageSize: '262144', ReceiveMessageWaitTimeSeconds: '0' };
const RANGE: Record<string, [number, number]> = { VisibilityTimeout: [0, 43200], MessageRetentionPeriod: [60, 1209600], DelaySeconds: [0, 900], MaximumMessageSize: [1024, 262144], ReceiveMessageWaitTimeSeconds: [0, 20] };
const KNOWN = [...Object.keys(DEFAULTS), 'RedrivePolicy', 'RedriveAllowPolicy', 'Policy', 'FifoQueue', 'ContentBasedDeduplication', 'KmsMasterKeyId', 'KmsDataKeyReusePeriodSeconds', 'SqsManagedSseEnabled', 'DeduplicationScope', 'FifoThroughputLimit'];

function validateAttrs(s: CloudState, region: string, name: string, fifo: boolean, a: Record<string, string>) {
  for (const [k, v] of Object.entries(a)) {
    if (!KNOWN.includes(k)) throw new AwsError('InvalidAttributeName', `Unknown Attribute ${k}.`, 400);
    const r = RANGE[k];
    if (r) {
      const n = Number(v);
      if (!Number.isInteger(n) || n < r[0] || n > r[1]) throw new AwsError('InvalidAttributeValue', `Invalid value for the parameter ${k}. Reason: Must be between ${r[0]} and ${r[1]}, if provided.`, 400);
    }
    if (k === 'RedrivePolicy') {
      const p = safeJson(v);
      const bad = (why: string) => new AwsError('InvalidParameterValue', `Value ${v} for parameter RedrivePolicy is invalid. Reason: ${why}.`, 400);
      if (!p || typeof p !== 'object') throw bad('Invalid value for the parameter RedrivePolicy');
      if (!p.deadLetterTargetArn) throw bad('Dead-letter target ARN is required');
      const m = Number(p.maxReceiveCount);
      if (!Number.isInteger(m) || m < 1 || m > 1000) throw bad('Invalid value for maxReceiveCount: must be between 1 and 1000');
      const t = sv(s).queues.find((x) => x.arn === p.deadLetterTargetArn);
      if (!t) throw bad('Dead-letter target does not exist');
      if (t.fifo !== fifo) throw bad('Dead-letter queue must be the same type of queue as the source');
    }
    if (k === 'Policy' && !safeJson(v)) throw new AwsError('InvalidAttributeValue', 'Invalid value for the parameter Policy.', 400);
  }
  void region; void name;
}

export function queueByUrl(ctx: Ctx, url: string): SqsQueue {
  const q = sv(ctx.s).queues.find((x) => x.url === url && x.region === ctx.region);
  if (!q) throw new AwsError('QueueDoesNotExist', 'The specified queue does not exist.', 400);
  return q;
}
export const queueByArn = (s: CloudState, arn: string) => sv(s).queues.find((q) => q.arn === arn);

/** Aplica la retención y devuelve las cifras aproximadas de la cola. */
export function counts(q: SqsQueue, t = now()) {
  const retention = Number(q.attrs.MessageRetentionPeriod) * 1000;
  q.messages = q.messages.filter((m) => t - m.sentAt < retention);
  let visible = 0, notVisible = 0, delayed = 0;
  const blocked = new Set(q.messages.filter((m) => m.receipt && m.visibleAt > t && m.groupId).map((m) => m.groupId));
  for (const m of q.messages) {
    if (m.availableAt > t) delayed++;
    else if (m.visibleAt > t && m.receiveCount > 0) notVisible++;
    else if (!(q.fifo && m.groupId && blocked.has(m.groupId))) visible++;
    else visible++; // FIFO: sigue visible a efectos de contador
  }
  return { visible, notVisible, delayed };
}

export function createQueue(ctx: Ctx, p: { QueueName: string; Attributes?: Record<string, string>; tags?: Record<string, string> }): SqsQueue {
  return trailed(ctx, SRC, 'CreateQueue', [{ type: 'AWS::SQS::Queue', name: p.QueueName }], { queueName: p.QueueName, attributes: p.Attributes }, () => {
    const name = p.QueueName ?? '';
    svAuthorize(ctx, 'sqs:CreateQueue', queueArn(ctx.region, ctx.s.account.id, name), 'sqs');
    const attrs = { ...(p.Attributes ?? {}) };
    const fifoAttr = attrs.FifoQueue === 'true';
    const fifo = name.endsWith('.fifo');
    if (!/^[a-zA-Z0-9_-]{1,80}(\.fifo)?$/.test(name) || (name.length > 80 + (fifo ? 5 : 0))) throw invalid(fifoAttr ? 'The name of a FIFO queue can only include alphanumeric characters, hyphens, or underscores, must end with .fifo suffix and be 1 to 80 in length.' : 'Can only include alphanumeric characters, hyphens, or underscores. 1 to 80 in length');
    if (fifoAttr !== fifo && (fifoAttr || fifo)) throw invalid('The name of a FIFO queue can only include alphanumeric characters, hyphens, or underscores, must end with .fifo suffix and be 1 to 80 in length.');
    validateAttrs(ctx.s, ctx.region, name, fifo, attrs);
    const ex = sv(ctx.s).queues.find((q) => q.name === name && q.region === ctx.region);
    if (ex) {
      for (const [k, v] of Object.entries(attrs)) if (k !== 'FifoQueue' && (ex.attrs[k] ?? DEFAULTS[k]) !== v) throw new AwsError('QueueNameExists', `A queue already exists with the same name and a different value for attribute ${k}`, 400);
      return ex;
    }
    const t = now();
    const q: SqsQueue = { name, url: queueUrl(ctx.region, ctx.s.account.id, name), arn: queueArn(ctx.region, ctx.s.account.id, name), region: ctx.region, fifo, createdAt: t, modifiedAt: t, attrs: { ...DEFAULTS, ...attrs }, messages: [], tags: p.tags ?? {}, dedup: {}, seq: 0 };
    delete q.attrs.FifoQueue;
    if (!q.attrs.SqsManagedSseEnabled && !q.attrs.KmsMasterKeyId) q.attrs.SqsManagedSseEnabled = 'true';
    if (fifo) { q.attrs.ContentBasedDeduplication ??= 'false'; q.attrs.DeduplicationScope ??= 'queue'; q.attrs.FifoThroughputLimit ??= 'perQueue'; }
    sv(ctx.s).queues.push(q);
    return q;
  });
}

export function listQueues(ctx: Ctx, p: { QueueNamePrefix?: string }): SqsQueue[] {
  return trailed(ctx, SRC, 'ListQueues', [], p, () => {
    svAuthorize(ctx, 'sqs:ListQueues', queueArn(ctx.region, ctx.s.account.id, '*'), 'sqs');
    return sv(ctx.s).queues.filter((q) => q.region === ctx.region && (!p.QueueNamePrefix || q.name.startsWith(p.QueueNamePrefix)));
  });
}
export function getQueueUrl(ctx: Ctx, p: { QueueName: string }): string {
  return trailed(ctx, SRC, 'GetQueueUrl', [], p, () => {
    const q = sv(ctx.s).queues.find((x) => x.name === p.QueueName && x.region === ctx.region);
    if (!q) throw new AwsError('QueueDoesNotExist', 'The specified queue does not exist.', 400);
    auth(ctx, 'sqs:GetQueueUrl', q);
    return q.url;
  });
}
export function deleteQueue(ctx: Ctx, p: { QueueUrl: string }): void {
  trailed(ctx, SRC, 'DeleteQueue', [], p, () => {
    const q = queueByUrl(ctx, p.QueueUrl);
    auth(ctx, 'sqs:DeleteQueue', q);
    sv(ctx.s).queues = sv(ctx.s).queues.filter((x) => x !== q);
    sv(ctx.s).mappings = sv(ctx.s).mappings.filter((m) => m.eventSourceArn !== q.arn);
  });
}

export function queueAttributes(q: SqsQueue, names: string[] = ['All']): Record<string, string> {
  const c = counts(q);
  const all: Record<string, string> = {
    ...Object.fromEntries(Object.entries(q.attrs).filter(([k]) => !k.startsWith('__'))), QueueArn: q.arn, ApproximateNumberOfMessages: String(c.visible), ApproximateNumberOfMessagesNotVisible: String(c.notVisible), ApproximateNumberOfMessagesDelayed: String(c.delayed),
    CreatedTimestamp: String(Math.floor(q.createdAt / 1000)), LastModifiedTimestamp: String(Math.floor(q.modifiedAt / 1000)), ...(q.fifo ? { FifoQueue: 'true' } : {}),
  };
  if (names.includes('All')) return all;
  return Object.fromEntries(names.filter((n) => n in all).map((n) => [n, all[n]]));
}
export function getQueueAttributes(ctx: Ctx, p: { QueueUrl: string; AttributeNames?: string[] }) {
  return trailed(ctx, SRC, 'GetQueueAttributes', [], p, () => {
    settle(ctx.s);
    const q = queueByUrl(ctx, p.QueueUrl);
    auth(ctx, 'sqs:GetQueueAttributes', q);
    return queueAttributes(q, p.AttributeNames ?? ['All']);
  });
}
export function setQueueAttributes(ctx: Ctx, p: { QueueUrl: string; Attributes: Record<string, string> }): void {
  trailed(ctx, SRC, 'SetQueueAttributes', [], { queueUrl: p.QueueUrl, attributes: p.Attributes }, () => {
    const q = queueByUrl(ctx, p.QueueUrl);
    auth(ctx, 'sqs:SetQueueAttributes', q);
    if ('FifoQueue' in p.Attributes) throw new AwsError('InvalidAttributeName', 'Unknown Attribute FifoQueue.', 400);
    validateAttrs(ctx.s, ctx.region, q.name, q.fifo, p.Attributes);
    for (const [k, v] of Object.entries(p.Attributes)) { if (v === '' && ['RedrivePolicy', 'Policy'].includes(k)) delete q.attrs[k]; else q.attrs[k] = v; }
    q.modifiedAt = now();
  });
}
export function listDeadLetterSourceQueues(ctx: Ctx, p: { QueueUrl: string }): SqsQueue[] {
  return trailed(ctx, SRC, 'ListDeadLetterSourceQueues', [], p, () => {
    const q = queueByUrl(ctx, p.QueueUrl);
    auth(ctx, 'sqs:ListDeadLetterSourceQueues', q);
    return sv(ctx.s).queues.filter((x) => safeJson(x.attrs.RedrivePolicy ?? '')?.deadLetterTargetArn === q.arn);
  });
}
export function tagQueue(ctx: Ctx, p: { QueueUrl: string; Tags: Record<string, string> }): void {
  trailed(ctx, SRC, 'TagQueue', [], p, () => { const q = queueByUrl(ctx, p.QueueUrl); auth(ctx, 'sqs:TagQueue', q); Object.assign(q.tags, p.Tags); });
}
export function untagQueue(ctx: Ctx, p: { QueueUrl: string; TagKeys: string[] }): void {
  trailed(ctx, SRC, 'UntagQueue', [], p, () => { const q = queueByUrl(ctx, p.QueueUrl); auth(ctx, 'sqs:UntagQueue', q); for (const k of p.TagKeys) delete q.tags[k]; });
}
export function listQueueTags(ctx: Ctx, p: { QueueUrl: string }) {
  return trailed(ctx, SRC, 'ListQueueTags', [], p, () => { const q = queueByUrl(ctx, p.QueueUrl); auth(ctx, 'sqs:ListQueueTags', q); return q.tags; });
}

// ------------------------------------------------------------------ mensajes

type MsgAttrs = Record<string, { DataType: string; StringValue?: string; BinaryValue?: string }>;
const attrsMd5 = (a: MsgAttrs) => (Object.keys(a).length ? md5(JSON.stringify(a)) : undefined);

/** Encola un mensaje (uso interno: no autoriza; lo usan SNS, Lambda y la API pública tras autorizar). */
export function enqueue(s: CloudState, q: SqsQueue, m: { body: string; attrs?: MsgAttrs; delay?: number; groupId?: string; dedupId?: string }): SqsMessage {
  const t = now();
  if (q.fifo) {
    const dedup = m.dedupId ?? (q.attrs.ContentBasedDeduplication === 'true' ? md5(m.body) : undefined);
    for (const k of Object.keys(q.dedup)) if (t - q.dedup[k] > 300_000) delete q.dedup[k];
    if (dedup) {
      const dup = q.messages.find((x) => x.dedupId === dedup);
      if (q.dedup[dedup] !== undefined && dup) return dup;
      q.dedup[dedup] = t;
    }
    m = { ...m, dedupId: dedup };
  }
  const msg: SqsMessage = {
    id: guid(), body: m.body, md5: md5(m.body), attrs: m.attrs ?? {}, sentAt: t, availableAt: t + (m.delay ?? Number(q.attrs.DelaySeconds)) * 1000, visibleAt: 0, receiveCount: 0,
    groupId: m.groupId, dedupId: m.dedupId, ...(q.fifo ? { seq: String(18_000_000_000_000_000_000n + BigInt(++q.seq)) } : {}),
  };
  q.messages.push(msg);
  emitMetric(s, 'AWS/SQS', 'NumberOfMessagesSent', 1, t, { QueueName: q.name });
  return msg;
}

function checkSend(q: SqsQueue, p: { MessageBody: string; MessageGroupId?: string; MessageDeduplicationId?: string; DelaySeconds?: number }) {
  if (!p.MessageBody?.length) throw new AwsError('MissingParameter', 'The request must contain the parameter MessageBody.', 400);
  if (new TextEncoder().encode(p.MessageBody).length > Number(q.attrs.MaximumMessageSize)) throw invalid(`One or more parameters are invalid. Reason: Message must be shorter than ${q.attrs.MaximumMessageSize} bytes.`);
  if (q.fifo) {
    if (!p.MessageGroupId) throw new AwsError('MissingParameter', 'The request must contain the parameter MessageGroupId.', 400);
    if (!p.MessageDeduplicationId && q.attrs.ContentBasedDeduplication !== 'true') throw invalid('The queue should either have ContentBasedDeduplication enabled or MessageDeduplicationId provided explicitly');
    if (p.DelaySeconds) throw invalid('Value ' + p.DelaySeconds + ' for parameter DelaySeconds is invalid. Reason: The request include parameter that is not valid for this queue type.');
  } else if (p.MessageGroupId) throw invalid(`Value ${p.MessageGroupId} for parameter MessageGroupId is invalid. Reason: The request include parameter that is not valid for this queue type.`);
  if (p.DelaySeconds !== undefined && (p.DelaySeconds < 0 || p.DelaySeconds > 900)) throw invalid(`Value ${p.DelaySeconds} for parameter DelaySeconds is invalid. Reason: DelaySeconds must be >= 0 and <= 900.`);
}

export function sendMessage(ctx: Ctx, p: { QueueUrl: string; MessageBody: string; DelaySeconds?: number; MessageAttributes?: MsgAttrs; MessageGroupId?: string; MessageDeduplicationId?: string }) {
  return trailed(ctx, SRC, 'SendMessage', [], { queueUrl: p.QueueUrl }, () => {
    settle(ctx.s);
    const q = queueByUrl(ctx, p.QueueUrl);
    auth(ctx, 'sqs:SendMessage', q);
    checkSend(q, p);
    const m = enqueue(ctx.s, q, { body: p.MessageBody, attrs: p.MessageAttributes, delay: p.DelaySeconds, groupId: p.MessageGroupId, dedupId: p.MessageDeduplicationId });
    bridge.afterSend?.(ctx.s);
    return { q, m, attrsMd5: attrsMd5(m.attrs) };
  });
}
export function sendMessageBatch(ctx: Ctx, p: { QueueUrl: string; Entries: { Id: string; MessageBody: string; DelaySeconds?: number; MessageAttributes?: MsgAttrs; MessageGroupId?: string; MessageDeduplicationId?: string }[] }) {
  return trailed(ctx, SRC, 'SendMessageBatch', [], { queueUrl: p.QueueUrl }, () => {
    const q = queueByUrl(ctx, p.QueueUrl);
    auth(ctx, 'sqs:SendMessage', q);
    const es = asArr(p.Entries);
    if (!es.length) throw new AwsError('EmptyBatchRequest', 'There should be at least one SendMessageBatchRequestEntry in the request.', 400);
    if (es.length > 10) throw new AwsError('TooManyEntriesInBatchRequest', 'Maximum number of entries per request are 10. You have sent ' + es.length + '.', 400);
    if (new Set(es.map((e) => e.Id)).size !== es.length) throw new AwsError('BatchEntryIdsNotDistinct', 'Id ' + es[1]?.Id + ' repeated.', 400);
    const ok: { Id: string; m: SqsMessage }[] = [], failed: { Id: string; SenderFault: boolean; Code: string; Message: string }[] = [];
    for (const e of es) {
      try { checkSend(q, e); ok.push({ Id: e.Id, m: enqueue(ctx.s, q, { body: e.MessageBody, attrs: e.MessageAttributes, delay: e.DelaySeconds, groupId: e.MessageGroupId, dedupId: e.MessageDeduplicationId }) }); }
      catch (err) { if (err instanceof AwsError) failed.push({ Id: e.Id, SenderFault: true, Code: err.code, Message: err.message }); else throw err; }
    }
    bridge.afterSend?.(ctx.s);
    return { ok, failed };
  });
}

/** Mueve a la DLQ los mensajes que han superado maxReceiveCount. */
function redrive(s: CloudState, q: SqsQueue, t: number) {
  const pol = safeJson(q.attrs.RedrivePolicy ?? '');
  if (!pol) return;
  const dlq = queueByArn(s, pol.deadLetterTargetArn);
  const max = Number(pol.maxReceiveCount);
  if (!dlq) return;
  const moved = q.messages.filter((m) => m.receiveCount >= max && m.availableAt <= t && m.visibleAt <= t);
  for (const m of moved) {
    q.messages = q.messages.filter((x) => x !== m);
    dlq.messages.push({ ...m, receipt: undefined, visibleAt: 0, availableAt: t, receiveCount: 0, sentAt: m.sentAt });
  }
}

/** Recibe mensajes (uso interno): aplica visibilidad, orden FIFO por grupo y redrive. */
export function receive(s: CloudState, q: SqsQueue, max: number, visibility?: number): SqsMessage[] {
  const t = now();
  counts(q, t);
  redrive(s, q, t);
  const vis = (visibility ?? Number(q.attrs.VisibilityTimeout)) * 1000;
  const out: SqsMessage[] = [];
  const inflightGroups = new Set(q.messages.filter((m) => m.groupId && m.receiveCount > 0 && m.receipt && m.visibleAt > t).map((m) => m.groupId));
  const ordered = q.fifo ? [...q.messages].sort((a, b) => Number(BigInt(a.seq ?? '0') - BigInt(b.seq ?? '0'))) : q.messages;
  const takenGroups = new Set<string>();
  for (const m of ordered) {
    if (out.length >= max) break;
    if (m.availableAt > t || m.visibleAt > t) continue;
    if (q.fifo && m.groupId && (inflightGroups.has(m.groupId) && !takenGroups.has(m.groupId))) continue;
    m.receiveCount++;
    m.firstReceivedAt ??= t;
    m.visibleAt = t + vis;
    m.receipt = 'AQEB' + hex(60);
    if (q.fifo && m.groupId) takenGroups.add(m.groupId);
    out.push(m);
  }
  if (out.length) emitMetric(s, 'AWS/SQS', 'NumberOfMessagesReceived', out.length, t, { QueueName: q.name });
  return out;
}
export function receiveMessage(ctx: Ctx, p: { QueueUrl: string; MaxNumberOfMessages?: number; VisibilityTimeout?: number; WaitTimeSeconds?: number }) {
  return trailed(ctx, SRC, 'ReceiveMessage', [], { queueUrl: p.QueueUrl }, () => {
    settle(ctx.s);
    const q = queueByUrl(ctx, p.QueueUrl);
    auth(ctx, 'sqs:ReceiveMessage', q);
    const max = p.MaxNumberOfMessages ?? 1;
    if (!Number.isInteger(max) || max < 1 || max > 10) throw invalid(`Value ${max} for parameter MaxNumberOfMessages is invalid. Reason: Must be between 1 and 10, if provided.`);
    if (p.VisibilityTimeout !== undefined && (p.VisibilityTimeout < 0 || p.VisibilityTimeout > 43200)) throw invalid(`Value ${p.VisibilityTimeout} for parameter VisibilityTimeout is invalid. Reason: Must be between 0 and 43200, if provided.`);
    if (p.WaitTimeSeconds !== undefined && (p.WaitTimeSeconds < 0 || p.WaitTimeSeconds > 20)) throw invalid(`Value ${p.WaitTimeSeconds} for parameter WaitTimeSeconds is invalid. Reason: Must be >= 0 and <= 20, if provided.`);
    return { q, msgs: receive(ctx.s, q, max, p.VisibilityTimeout) };
  });
}
export function deleteMessageInternal(q: SqsQueue, receipt: string): boolean {
  const m = q.messages.find((x) => x.receipt === receipt);
  if (!m) return false;
  q.messages = q.messages.filter((x) => x !== m);
  return true;
}
function badReceipt(r: string) {
  return new AwsError('ReceiptHandleIsInvalid', `The input receipt handle "${r}" is not a valid receipt handle.`, 400);
}
export function deleteMessage(ctx: Ctx, p: { QueueUrl: string; ReceiptHandle: string }): void {
  trailed(ctx, SRC, 'DeleteMessage', [], { queueUrl: p.QueueUrl }, () => {
    const q = queueByUrl(ctx, p.QueueUrl);
    auth(ctx, 'sqs:DeleteMessage', q);
    if (!/^AQEB[0-9a-f]{20,}$/.test(p.ReceiptHandle ?? '')) throw badReceipt(p.ReceiptHandle);
    if (deleteMessageInternal(q, p.ReceiptHandle)) emitMetric(ctx.s, 'AWS/SQS', 'NumberOfMessagesDeleted', 1, now(), { QueueName: q.name });
  });
}
export function deleteMessageBatch(ctx: Ctx, p: { QueueUrl: string; Entries: { Id: string; ReceiptHandle: string }[] }) {
  return trailed(ctx, SRC, 'DeleteMessageBatch', [], { queueUrl: p.QueueUrl }, () => {
    const q = queueByUrl(ctx, p.QueueUrl);
    auth(ctx, 'sqs:DeleteMessage', q);
    const ok: string[] = [], failed: { Id: string; SenderFault: boolean; Code: string; Message: string }[] = [];
    for (const e of asArr(p.Entries)) { if (!/^AQEB[0-9a-f]{20,}$/.test(e.ReceiptHandle ?? '')) failed.push({ Id: e.Id, SenderFault: true, Code: 'ReceiptHandleIsInvalid', Message: `The input receipt handle "${e.ReceiptHandle}" is not a valid receipt handle.` }); else { deleteMessageInternal(q, e.ReceiptHandle); ok.push(e.Id); } }
    return { ok, failed };
  });
}
export function changeMessageVisibility(ctx: Ctx, p: { QueueUrl: string; ReceiptHandle: string; VisibilityTimeout: number }): void {
  trailed(ctx, SRC, 'ChangeMessageVisibility', [], { queueUrl: p.QueueUrl }, () => {
    const q = queueByUrl(ctx, p.QueueUrl);
    auth(ctx, 'sqs:ChangeMessageVisibility', q);
    if (!/^AQEB[0-9a-f]{20,}$/.test(p.ReceiptHandle ?? '')) throw badReceipt(p.ReceiptHandle);
    const v = Number(p.VisibilityTimeout);
    if (!Number.isInteger(v) || v < 0 || v > 43200) throw invalid(`Value ${p.VisibilityTimeout} for parameter VisibilityTimeout is invalid. Reason: Must be between 0 and 43200, if provided.`);
    const m = q.messages.find((x) => x.receipt === p.ReceiptHandle);
    if (!m || m.visibleAt <= now()) throw new AwsError('MessageNotInflight', 'Message does not exist or is not available for visibility timeout change.', 400);
    m.visibleAt = now() + v * 1000;
  });
}
export function purgeQueue(ctx: Ctx, p: { QueueUrl: string }): void {
  trailed(ctx, SRC, 'PurgeQueue', [], p, () => {
    const q = queueByUrl(ctx, p.QueueUrl);
    auth(ctx, 'sqs:PurgeQueue', q);
    const last = Number(q.attrs.__purgedAt ?? 0);
    if (last && now() - last < 60_000) throw new AwsError('PurgeQueueInProgress', `Only one PurgeQueue operation on ${q.name} is allowed every 60 seconds.`, 403);
    q.messages = [];
    q.attrs.__purgedAt = String(now());
  });
}

/** Paso del tiempo: aplica la retención y lanza los desencadenadores de Lambda pendientes. */
export function settle(s: CloudState) {
  for (const q of sv(s).queues) counts(q);
  bridge.afterSend?.(s);
}

/** Mensaje tal y como lo devuelve ReceiveMessage. */
export function messageOut(q: SqsQueue, m: SqsMessage, attrNames: string[] = [], msgAttrNames: string[] = []) {
  const want = (n: string) => attrNames.includes('All') || attrNames.includes(n);
  const attrs: Record<string, string> = {};
  if (want('SenderId')) attrs.SenderId = 'AIDAEXAMPLE0000000000';
  if (want('SentTimestamp')) attrs.SentTimestamp = String(m.sentAt);
  if (want('ApproximateReceiveCount')) attrs.ApproximateReceiveCount = String(m.receiveCount);
  if (want('ApproximateFirstReceiveTimestamp') && m.firstReceivedAt) attrs.ApproximateFirstReceiveTimestamp = String(m.firstReceivedAt);
  if (q.fifo && m.groupId && want('MessageGroupId')) attrs.MessageGroupId = m.groupId;
  if (q.fifo && m.dedupId && want('MessageDeduplicationId')) attrs.MessageDeduplicationId = m.dedupId;
  if (q.fifo && m.seq && want('SequenceNumber')) attrs.SequenceNumber = m.seq;
  const ma = msgAttrNames.includes('All') || msgAttrNames.includes('.*') ? m.attrs : Object.fromEntries(Object.entries(m.attrs).filter(([k]) => msgAttrNames.includes(k)));
  return {
    MessageId: m.id, ReceiptHandle: m.receipt, MD5OfBody: m.md5, Body: m.body,
    ...(Object.keys(attrs).length ? { Attributes: attrs } : {}),
    ...(Object.keys(ma).length ? { MD5OfMessageAttributes: attrsMd5(ma as MsgAttrs), MessageAttributes: ma } : {}),
  };
}

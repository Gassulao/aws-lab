// aws sqs
import { defineCommand, type Params } from '../framework';
import * as Q from '../../../engine/serverless/sqs';
import { need, num, arr, strip } from './sv-util';

const S = 'sqs';
const url = (p: Params) => need(p, 'QueueUrl', 'queue-url') as string;
const STR = (v: unknown) => (v === undefined ? undefined : String(v));
/** --attributes: los valores se guardan como texto en SQS (VisibilityTimeout=60 → "60"). */
const attrs = (v: any): Record<string, string> | undefined => (v === undefined ? undefined : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' ? x : JSON.stringify(x)])));
const msgAttrs = (v: any) => (v === undefined ? undefined : Object.fromEntries(Object.entries<any>(v).map(([k, x]) => [k, { DataType: x.DataType, ...(x.StringValue !== undefined ? { StringValue: String(x.StringValue) } : {}) }])));

defineCommand({
  service: S, name: 'create-queue', op: 'CreateQueue', structured: ['attributes', 'tags'],
  run: (c, p) => ({ QueueUrl: Q.createQueue(c, { QueueName: need(p, 'QueueName', 'queue-name'), Attributes: attrs(p.Attributes), tags: p.Tags }).url }),
});
defineCommand({ service: S, name: 'list-queues', op: 'ListQueues', run: (c, p) => { const l = Q.listQueues(c, { QueueNamePrefix: p.QueueNamePrefix }); return l.length ? { QueueUrls: l.map((q) => q.url) } : undefined; } });
defineCommand({ service: S, name: 'get-queue-url', op: 'GetQueueUrl', run: (c, p) => ({ QueueUrl: Q.getQueueUrl(c, { QueueName: need(p, 'QueueName', 'queue-name') }) }) });
defineCommand({ service: S, name: 'delete-queue', op: 'DeleteQueue', run: (c, p) => void Q.deleteQueue(c, { QueueUrl: url(p) }) });
defineCommand({
  service: S, name: 'get-queue-attributes', op: 'GetQueueAttributes', list: ['attribute-names'],
  run: (c, p) => { const a = Q.getQueueAttributes(c, { QueueUrl: url(p), AttributeNames: p.AttributeNames ? arr(p.AttributeNames) : [] }); return Object.keys(a).length ? { Attributes: a } : undefined; },
});
defineCommand({ service: S, name: 'set-queue-attributes', op: 'SetQueueAttributes', structured: ['attributes'], run: (c, p) => void Q.setQueueAttributes(c, { QueueUrl: url(p), Attributes: attrs(need(p, 'Attributes', 'attributes'))! }) });
defineCommand({ service: S, name: 'list-dead-letter-source-queues', op: 'ListDeadLetterSourceQueues', run: (c, p) => ({ queueUrls: Q.listDeadLetterSourceQueues(c, { QueueUrl: url(p) }).map((q) => q.url) }) });
defineCommand({ service: S, name: 'tag-queue', op: 'TagQueue', structured: ['tags'], run: (c, p) => void Q.tagQueue(c, { QueueUrl: url(p), Tags: need(p, 'Tags', 'tags') }) });
defineCommand({ service: S, name: 'untag-queue', op: 'UntagQueue', list: ['tag-keys'], run: (c, p) => void Q.untagQueue(c, { QueueUrl: url(p), TagKeys: arr(need(p, 'TagKeys', 'tag-keys')) }) });
defineCommand({ service: S, name: 'list-queue-tags', op: 'ListQueueTags', run: (c, p) => { const t = Q.listQueueTags(c, { QueueUrl: url(p) }); return Object.keys(t).length ? { Tags: t } : undefined; } });
defineCommand({ service: S, name: 'purge-queue', op: 'PurgeQueue', run: (c, p) => void Q.purgeQueue(c, { QueueUrl: url(p) }) });

defineCommand({
  service: S, name: 'send-message', op: 'SendMessage', structured: ['message-attributes'],
  run: (c, p) => {
    const r = Q.sendMessage(c, { QueueUrl: url(p), MessageBody: need(p, 'MessageBody', 'message-body'), DelaySeconds: num(p.DelaySeconds), MessageAttributes: msgAttrs(p.MessageAttributes), MessageGroupId: STR(p.MessageGroupId), MessageDeduplicationId: STR(p.MessageDeduplicationId) });
    return strip({ MD5OfMessageBody: r.m.md5, MD5OfMessageAttributes: r.attrsMd5, MessageId: r.m.id, SequenceNumber: r.m.seq });
  },
});
defineCommand({
  service: S, name: 'send-message-batch', op: 'SendMessageBatch', list: ['entries'], structured: ['entries'],
  run: (c, p) => {
    const r = Q.sendMessageBatch(c, { QueueUrl: url(p), Entries: arr(need(p, 'Entries', 'entries')).map((e: any) => ({ Id: e.Id, MessageBody: e.MessageBody, DelaySeconds: num(e.DelaySeconds), MessageAttributes: msgAttrs(e.MessageAttributes), MessageGroupId: e.MessageGroupId, MessageDeduplicationId: e.MessageDeduplicationId })) });
    return { ...(r.ok.length ? { Successful: r.ok.map((x) => strip({ Id: x.Id, MessageId: x.m.id, MD5OfMessageBody: x.m.md5, SequenceNumber: x.m.seq })) } : {}), ...(r.failed.length ? { Failed: r.failed } : {}) };
  },
});
defineCommand({
  service: S, name: 'receive-message', op: 'ReceiveMessage', list: ['attribute-names', 'message-attribute-names', 'message-system-attribute-names'],
  run: (c, p) => {
    const r = Q.receiveMessage(c, { QueueUrl: url(p), MaxNumberOfMessages: num(p.MaxNumberOfMessages), VisibilityTimeout: num(p.VisibilityTimeout), WaitTimeSeconds: num(p.WaitTimeSeconds) });
    if (!r.msgs.length) return undefined;
    return { Messages: r.msgs.map((m) => Q.messageOut(r.q, m, arr(p.AttributeNames ?? p.MessageSystemAttributeNames), arr(p.MessageAttributeNames))) };
  },
});
defineCommand({ service: S, name: 'delete-message', op: 'DeleteMessage', run: (c, p) => void Q.deleteMessage(c, { QueueUrl: url(p), ReceiptHandle: need(p, 'ReceiptHandle', 'receipt-handle') }) });
defineCommand({
  service: S, name: 'delete-message-batch', op: 'DeleteMessageBatch', list: ['entries'], structured: ['entries'],
  run: (c, p) => { const r = Q.deleteMessageBatch(c, { QueueUrl: url(p), Entries: arr(need(p, 'Entries', 'entries')) }); return { ...(r.ok.length ? { Successful: r.ok.map((Id) => ({ Id })) } : {}), ...(r.failed.length ? { Failed: r.failed } : {}) }; },
});
defineCommand({ service: S, name: 'change-message-visibility', op: 'ChangeMessageVisibility', run: (c, p) => void Q.changeMessageVisibility(c, { QueueUrl: url(p), ReceiptHandle: need(p, 'ReceiptHandle', 'receipt-handle'), VisibilityTimeout: Number(need(p, 'VisibilityTimeout', 'visibility-timeout')) }) });

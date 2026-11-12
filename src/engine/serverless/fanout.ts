// SNS → SQS y SNS → Lambda: reparte cada mensaje publicado a las suscripciones confirmadas del tema.
// Igual que en AWS, si la política de la cola no permite a SNS enviar, o la función no concede permiso a
// sns.amazonaws.com, el mensaje se descarta sin error para quien publica (queda constancia en el tema).
import type { CloudState, SnsTopic } from '../types';
import { guid, nowIso, wildcardMatch } from '../util';
import { publishHooks } from '../services/cloudwatch';
import { queueByArn, enqueue } from './sqs';
import { invokeAsService } from './lambda';
import { bridge } from './bridge';
import { statements } from '../policy';

const asArr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** ¿Permite la política de la cola que SNS (con ese tema de origen) envíe mensajes? */
export function queueAllowsSns(policyText: string | undefined, queueArn: string, topicArn: string): boolean {
  if (!policyText) return false;
  let doc: any;
  try { doc = JSON.parse(policyText); } catch { return false; }
  return statements(doc).some((st) => {
    if (st.Effect !== 'Allow') return false;
    const pr: any = st.Principal;
    const principals = pr === '*' ? ['*'] : Object.values<any>(pr ?? {}).flatMap((v) => asArr<string>(v));
    if (!principals.some((p) => p === '*' || p === 'sns.amazonaws.com')) return false;
    if (!asArr<string>(st.Action as any).some((a) => wildcardMatch(a, 'sqs:SendMessage', true))) return false;
    if (st.Resource !== undefined && !asArr<string>(st.Resource as any).some((r) => wildcardMatch(r, queueArn))) return false;
    const cond: any = st.Condition;
    if (cond) {
      for (const [op, kv] of Object.entries<any>(cond)) {
        for (const [k, v] of Object.entries<any>(kv)) {
          if (k.toLowerCase() === 'aws:sourcearn' && /^Arn(Like|Equals)$/.test(op) && !asArr<string>(v).some((x) => wildcardMatch(x, topicArn))) return false;
          if (k.toLowerCase() === 'aws:sourcearn' && op === 'ArnNotEquals') return false;
        }
      }
    }
    return true;
  });
}

publishHooks.push((s: CloudState, t: SnsTopic, message: string, subject: string | undefined, id: string) => {
  for (const sub of t.subs) {
    if (!sub.confirmed) continue;
    if (sub.protocol === 'sqs') {
      const q = queueByArn(s, sub.endpoint);
      if (!q || !queueAllowsSns(q.attrs.Policy, q.arn, t.arn)) continue;
      const body = JSON.stringify({ Type: 'Notification', MessageId: id, TopicArn: t.arn, ...(subject ? { Subject: subject } : {}), Message: message, Timestamp: nowIso(), SignatureVersion: '1', Signature: 'EXAMPLE', SigningCertURL: 'https://sns.' + t.region + '.amazonaws.com/SimpleNotificationService-0000000000000000000000.pem', UnsubscribeURL: `https://sns.${t.region}.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=${sub.arn}` });
      enqueue(s, q, { body });
    } else if (sub.protocol === 'lambda') {
      const event = { Records: [{ EventSource: 'aws:sns', EventVersion: '1.0', EventSubscriptionArn: sub.arn, Sns: { Type: 'Notification', MessageId: id, TopicArn: t.arn, Subject: subject ?? null, Message: message, Timestamp: nowIso(), SignatureVersion: '1', Signature: 'EXAMPLE', SigningCertUrl: 'EXAMPLE', UnsubscribeUrl: 'EXAMPLE', MessageAttributes: {} } }] };
      const r = invokeAsService(s, t.region, sub.endpoint, 'sns.amazonaws.com', t.arn, event, 'sns');
      if (r.status === 'denied') t.messages.push({ id: guid(), ts: nowIso(), message: `Entrega fallida a ${sub.endpoint}: la función no concede permiso a sns.amazonaws.com`, source: 'delivery-failure' });
    }
  }
  bridge.afterSend?.(s);
});

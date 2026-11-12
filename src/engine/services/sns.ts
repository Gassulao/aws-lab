// Amazon SNS mínimo: temas, suscripciones y publicación. Los mensajes publicados se guardan en el tema
// (el simulador no entrega correos ni llamadas HTTP) para poder comprobar qué recibiría cada suscriptor.
import type { SnsTopic } from '../types';
import { AwsError } from '../errors';
import { trailed, authorize, type Ctx } from '../api';
import { guid, hex } from '../util';
import { publishTo } from './cloudwatch';

const SRC = 'sns.amazonaws.com';
const topicArn = (ctx: Ctx, n: string) => `arn:aws:sns:${ctx.region}:${ctx.s.account.id}:${n}`;
const PROTOCOLS = ['http', 'https', 'email', 'email-json', 'sms', 'sqs', 'application', 'lambda', 'firehose'];

export function getTopic(ctx: Ctx, arn: string): SnsTopic {
  const t = ctx.s.topics.find((x) => x.arn === arn);
  if (!t) throw new AwsError('NotFound', 'Topic does not exist', 404);
  return t;
}

export function createTopic(ctx: Ctx, p: { Name: string }): SnsTopic {
  return trailed(ctx, SRC, 'CreateTopic', [{ type: 'AWS::SNS::Topic', name: p.Name }], { name: p.Name }, () => {
    authorize(ctx, 'sns:CreateTopic', topicArn(ctx, p.Name ?? ''));
    if (!/^[A-Za-z0-9_-]{1,256}(\.fifo)?$/.test(p.Name ?? '')) throw new AwsError('InvalidParameter', 'Invalid parameter: Topic Name', 400);
    const ex = ctx.s.topics.find((t) => t.arn === topicArn(ctx, p.Name));
    if (ex) return ex;
    const t: SnsTopic = { name: p.Name, arn: topicArn(ctx, p.Name), region: ctx.region, subs: [], messages: [] };
    ctx.s.topics.push(t);
    return t;
  });
}
export function listTopics(ctx: Ctx): SnsTopic[] {
  return trailed(ctx, SRC, 'ListTopics', [], {}, () => {
    authorize(ctx, 'sns:ListTopics', '*');
    return ctx.s.topics.filter((t) => t.region === ctx.region);
  });
}
export function deleteTopic(ctx: Ctx, p: { TopicArn: string }): void {
  return trailed(ctx, SRC, 'DeleteTopic', [{ type: 'AWS::SNS::Topic', name: p.TopicArn }], { topicArn: p.TopicArn }, () => {
    authorize(ctx, 'sns:DeleteTopic', p.TopicArn);
    ctx.s.topics = ctx.s.topics.filter((t) => t.arn !== p.TopicArn);
  });
}
export function subscribe(ctx: Ctx, p: { TopicArn: string; Protocol: string; Endpoint?: string }) {
  return trailed(ctx, SRC, 'Subscribe', [{ type: 'AWS::SNS::Topic', name: p.TopicArn }], { topicArn: p.TopicArn, protocol: p.Protocol }, () => {
    authorize(ctx, 'sns:Subscribe', p.TopicArn);
    const t = getTopic(ctx, p.TopicArn);
    if (!PROTOCOLS.includes(p.Protocol)) throw new AwsError('InvalidParameter', `Invalid parameter: Amazon SNS does not support this protocol string: ${p.Protocol}`, 400);
    if (!p.Endpoint) throw new AwsError('InvalidParameter', 'Invalid parameter: Endpoint', 400);
    if ((p.Protocol === 'email' || p.Protocol === 'email-json') && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.Endpoint)) throw new AwsError('InvalidParameter', `Invalid parameter: Email address`, 400);
    const ex = t.subs.find((x) => x.protocol === p.Protocol && x.endpoint === p.Endpoint);
    if (ex) return ex;
    const pending = ['email', 'email-json', 'http', 'https'].includes(p.Protocol);
    const sub = { arn: `${t.arn}:${guid()}`, protocol: p.Protocol, endpoint: p.Endpoint, confirmed: !pending };
    t.subs.push(sub);
    return sub;
  });
}
export function confirmSubscription(ctx: Ctx, p: { TopicArn: string; Token: string }) {
  return trailed(ctx, SRC, 'ConfirmSubscription', [], { topicArn: p.TopicArn }, () => {
    authorize(ctx, 'sns:ConfirmSubscription', p.TopicArn);
    const t = getTopic(ctx, p.TopicArn);
    const sub = t.subs.find((x) => !x.confirmed);
    if (!sub) throw new AwsError('InvalidParameter', 'Invalid parameter: Token', 400);
    sub.confirmed = true;
    return sub;
  });
}
export function listSubscriptionsByTopic(ctx: Ctx, p: { TopicArn: string }) {
  return trailed(ctx, SRC, 'ListSubscriptionsByTopic', [], { topicArn: p.TopicArn }, () => {
    authorize(ctx, 'sns:ListSubscriptionsByTopic', p.TopicArn);
    return getTopic(ctx, p.TopicArn);
  });
}
export function publish(ctx: Ctx, p: { TopicArn: string; Message: string; Subject?: string }): string {
  return trailed(ctx, SRC, 'Publish', [{ type: 'AWS::SNS::Topic', name: p.TopicArn }], { topicArn: p.TopicArn }, () => {
    authorize(ctx, 'sns:Publish', p.TopicArn);
    const t = getTopic(ctx, p.TopicArn);
    if (!p.Message) throw new AwsError('InvalidParameter', 'Invalid parameter: Empty message', 400);
    return publishTo(ctx.s, t, p.Message, p.Subject, 'publish');
  });
}
void hex;

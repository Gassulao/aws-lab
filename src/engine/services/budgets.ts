// AWS Budgets: presupuestos de coste con avisos reales (correo y SNS) calculados con el gasto acumulado y previsto de la cuenta.
import { AwsError } from '../errors';
import { authorize, trailed, type Ctx } from '../api';
import type { CloudState } from '../types';
import { nowIso, now } from '../util';
import { gov, type Budget, type BudgetNotification } from './govTypes';
import { monthSpend, startOfDay, totalUsd, usageBetween } from './costs';
import { settle } from './ec2';
import { publishTo, topicByArn } from './cloudwatch';

const SRC = 'budgets.amazonaws.com';

export interface Spend { actual: number; forecast: number }

/** Gasto acumulado y previsto del presupuesto en su periodo actual. */
export function budgetSpend(s: CloudState, b: Budget, t = now()): Spend {
  if (b.timeUnit === 'MONTHLY') return monthSpend(s, t);
  const d = new Date(t);
  const start = b.timeUnit === 'DAILY' ? startOfDay(t) : b.timeUnit === 'ANNUALLY' ? Date.UTC(d.getUTCFullYear(), 0, 1) : Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1);
  const actual = totalUsd(usageBetween(s, start, t));
  // La previsión de periodos no mensuales se aproxima con el ritmo del mes.
  const m = monthSpend(s, t);
  return { actual, forecast: b.timeUnit === 'DAILY' ? actual + (m.forecast - m.actual) / Math.max(1, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()) : actual + (m.forecast - m.actual) };
}

const cmp = (op: BudgetNotification['operator'], v: number, thr: number) => (op === 'GREATER_THAN' ? v > thr : op === 'LESS_THAN' ? v < thr : Math.abs(v - thr) < 1e-9);

/** Recalcula los estados de las notificaciones y envía los avisos nuevos. Se llama al consultar cualquier presupuesto. */
export function settleBudgets(s: CloudState): void {
  const g = gov(s);
  if (!g.budgets.length) return;
  settle(s);
  for (const b of g.budgets) {
    const sp = budgetSpend(s, b);
    for (const n of b.notifications) {
      const base = n.type === 'ACTUAL' ? sp.actual : sp.forecast;
      const value = n.thresholdType === 'PERCENTAGE' ? (base / b.limit) * 100 : base;
      const hit = cmp(n.operator, value, n.threshold);
      const was = n.state;
      n.state = hit ? 'ALARM' : 'OK';
      if (hit && was !== 'ALARM') {
        n.notifiedAt = nowIso();
        const pct = ((base / b.limit) * 100).toFixed(2);
        const subject = `AWS Budgets: ${b.name} has exceeded your alert threshold`;
        const body = `You requested that we alert you when the ${n.type === 'ACTUAL' ? 'actual' : 'forecasted'} cost associated with your ${b.name} budget is greater than ${n.threshold}${n.thresholdType === 'PERCENTAGE' ? '%' : ' USD'} of your budgeted amount (${b.limit.toFixed(2)} USD). The ${n.type === 'ACTUAL' ? 'actual' : 'forecasted'} cost associated with this budget is ${base.toFixed(4)} USD (${pct}% of the budget).`;
        for (const sub of n.subscribers) {
          (g.alerts ??= []).push({ ts: nowIso(), budget: b.name, to: sub.address, channel: sub.type, subject, body });
          if (sub.type === 'SNS') {
            const t = topicByArn(s, sub.address);
            if (t) publishTo(s, t, body, subject, 'budgets.amazonaws.com');
          }
        }
        if (g.alerts && g.alerts.length > 100) g.alerts.shift();
      }
    }
  }
}

// ------------------------------------------------------------------ API

const own = (ctx: Ctx, accountId: string) => {
  if (accountId !== ctx.s.account.id) throw new AwsError('AccessDeniedException', `You don't have permission to access account ${accountId}.`, 400);
};
const budgetArn = (ctx: Ctx, name: string) => `arn:aws:budgets::${ctx.s.account.id}:budget/${name}`;
const need = (ctx: Ctx, name: string): Budget => {
  const b = gov(ctx.s).budgets.find((x) => x.name === name);
  if (!b) throw new AwsError('NotFoundException', `Failed to call DescribeBudget for [AccountId: ${ctx.s.account.id}] - Unable to get budget: ${name} - the budget doesn't exist.`, 400);
  return b;
};

export interface BudgetIn {
  BudgetName: string;
  BudgetLimit?: { Amount: string | number; Unit: string };
  TimeUnit: string;
  BudgetType: string;
  CostFilters?: unknown;
}
export interface NotificationIn { NotificationType: string; ComparisonOperator: string; Threshold: number | string; ThresholdType?: string }
export interface SubscriberIn { SubscriptionType: string; Address: string }

function validBudget(p: BudgetIn): { limit: number; timeUnit: Budget['timeUnit'] } {
  if (!p.BudgetName || /[:\\]/.test(p.BudgetName)) throw new AwsError('InvalidParameterException', 'BudgetName contains invalid characters (no se permiten : ni \\).', 400);
  if (p.BudgetType !== 'COST') throw new AwsError('InvalidParameterException', 'Este simulador solo admite presupuestos de tipo COST.', 400);
  if (!['MONTHLY', 'QUARTERLY', 'ANNUALLY', 'DAILY'].includes(p.TimeUnit)) throw new AwsError('InvalidParameterException', `TimeUnit ${p.TimeUnit} is not valid.`, 400);
  const limit = Number(p.BudgetLimit?.Amount);
  if (!p.BudgetLimit || !Number.isFinite(limit) || limit <= 0) throw new AwsError('InvalidParameterException', 'BudgetLimit.Amount must be a number greater than 0.', 400);
  if (p.BudgetLimit.Unit !== 'USD') throw new AwsError('InvalidParameterException', 'Este simulador solo admite la unidad USD.', 400);
  return { limit, timeUnit: p.TimeUnit as Budget['timeUnit'] };
}

function mkNotification(ctx: Ctx, n: NotificationIn, subs: SubscriberIn[]): BudgetNotification {
  if (!['ACTUAL', 'FORECASTED'].includes(n.NotificationType)) throw new AwsError('InvalidParameterException', `NotificationType ${n.NotificationType} is not valid. Valid values: ACTUAL, FORECASTED.`, 400);
  if (!['GREATER_THAN', 'LESS_THAN', 'EQUAL_TO'].includes(n.ComparisonOperator)) throw new AwsError('InvalidParameterException', `ComparisonOperator ${n.ComparisonOperator} is not valid.`, 400);
  const thr = Number(n.Threshold);
  if (!Number.isFinite(thr) || thr < 0) throw new AwsError('InvalidParameterException', 'Threshold must be a non-negative number.', 400);
  const tt = (n.ThresholdType ?? 'PERCENTAGE') as BudgetNotification['thresholdType'];
  if (!['PERCENTAGE', 'ABSOLUTE_VALUE'].includes(tt)) throw new AwsError('InvalidParameterException', `ThresholdType ${tt} is not valid.`, 400);
  if (!subs.length) throw new AwsError('InvalidParameterException', 'A notification must have at least one subscriber.', 400);
  return { type: n.NotificationType as BudgetNotification['type'], operator: n.ComparisonOperator as BudgetNotification['operator'], threshold: thr, thresholdType: tt, subscribers: subs.map((x) => mkSub(ctx, x)), state: 'OK' };
}
function mkSub(ctx: Ctx, x: SubscriberIn) {
  if (!['EMAIL', 'SNS'].includes(x.SubscriptionType)) throw new AwsError('InvalidParameterException', `SubscriptionType ${x.SubscriptionType} is not valid. Valid values: EMAIL, SNS.`, 400);
  if (x.SubscriptionType === 'EMAIL' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.Address ?? '')) throw new AwsError('InvalidParameterException', `The email address ${x.Address} is not valid.`, 400);
  if (x.SubscriptionType === 'SNS' && !ctx.s.topics.some((t) => t.arn === x.Address)) throw new AwsError('InvalidParameterException', `Unable to find the SNS topic ${x.Address}. Create the topic first.`, 400);
  return { type: x.SubscriptionType as 'EMAIL' | 'SNS', address: x.Address };
}

export function createBudget(ctx: Ctx, p: { AccountId: string; Budget: BudgetIn; NotificationsWithSubscribers?: { Notification: NotificationIn; Subscribers: SubscriberIn[] }[] }): void {
  trailed(ctx, SRC, 'CreateBudget', [], { AccountId: p.AccountId, Budget: { BudgetName: p.Budget?.BudgetName } }, () => {
    authorize(ctx, 'budgets:ModifyBudget', budgetArn(ctx, p.Budget?.BudgetName ?? ''));
    own(ctx, p.AccountId);
    const { limit, timeUnit } = validBudget(p.Budget);
    const g = gov(ctx.s);
    if (g.budgets.some((b) => b.name === p.Budget.BudgetName)) throw new AwsError('DuplicateRecordException', `Error creating budget: ${p.Budget.BudgetName} - the budget already exists.`, 400);
    const notifications = (p.NotificationsWithSubscribers ?? []).map((x) => mkNotification(ctx, x.Notification, x.Subscribers ?? []));
    g.budgets.push({ name: p.Budget.BudgetName, type: 'COST', timeUnit, limit, unit: 'USD', createdAt: nowIso(), notifications });
    settleBudgets(ctx.s);
  });
}
export function describeBudgets(ctx: Ctx, p: { AccountId: string }): { budget: Budget; spend: Spend }[] {
  return trailed(ctx, SRC, 'DescribeBudgets', [], p, () => {
    authorize(ctx, 'budgets:ViewBudget', `arn:aws:budgets::${ctx.s.account.id}:budget/*`);
    own(ctx, p.AccountId);
    settleBudgets(ctx.s);
    return gov(ctx.s).budgets.map((b) => ({ budget: b, spend: budgetSpend(ctx.s, b) }));
  });
}
export function describeBudget(ctx: Ctx, p: { AccountId: string; BudgetName: string }): { budget: Budget; spend: Spend } {
  return trailed(ctx, SRC, 'DescribeBudget', [], p, () => {
    authorize(ctx, 'budgets:ViewBudget', budgetArn(ctx, p.BudgetName));
    own(ctx, p.AccountId);
    settleBudgets(ctx.s);
    const b = need(ctx, p.BudgetName);
    return { budget: b, spend: budgetSpend(ctx.s, b) };
  });
}
export function updateBudget(ctx: Ctx, p: { AccountId: string; NewBudget: BudgetIn }): void {
  trailed(ctx, SRC, 'UpdateBudget', [], { AccountId: p.AccountId, NewBudget: { BudgetName: p.NewBudget?.BudgetName } }, () => {
    authorize(ctx, 'budgets:ModifyBudget', budgetArn(ctx, p.NewBudget?.BudgetName ?? ''));
    own(ctx, p.AccountId);
    const b = need(ctx, p.NewBudget.BudgetName);
    const v = validBudget(p.NewBudget);
    b.limit = v.limit;
    b.timeUnit = v.timeUnit;
    settleBudgets(ctx.s);
  });
}
export function deleteBudget(ctx: Ctx, p: { AccountId: string; BudgetName: string }): void {
  trailed(ctx, SRC, 'DeleteBudget', [], p, () => {
    authorize(ctx, 'budgets:ModifyBudget', budgetArn(ctx, p.BudgetName));
    own(ctx, p.AccountId);
    const b = need(ctx, p.BudgetName);
    gov(ctx.s).budgets = gov(ctx.s).budgets.filter((x) => x !== b);
  });
}
export function createNotification(ctx: Ctx, p: { AccountId: string; BudgetName: string; Notification: NotificationIn; Subscribers: SubscriberIn[] }): void {
  trailed(ctx, SRC, 'CreateNotification', [], { AccountId: p.AccountId, BudgetName: p.BudgetName }, () => {
    authorize(ctx, 'budgets:ModifyBudget', budgetArn(ctx, p.BudgetName));
    own(ctx, p.AccountId);
    const b = need(ctx, p.BudgetName);
    const n = mkNotification(ctx, p.Notification, p.Subscribers ?? []);
    if (b.notifications.some((x) => x.type === n.type && x.operator === n.operator && x.threshold === n.threshold && x.thresholdType === n.thresholdType)) throw new AwsError('DuplicateRecordException', 'Error creating notification: the notification already exists.', 400);
    b.notifications.push(n);
    settleBudgets(ctx.s);
  });
}
const findN = (b: Budget, n: NotificationIn) => {
  const x = b.notifications.find((q) => q.type === n.NotificationType && q.operator === n.ComparisonOperator && q.threshold === Number(n.Threshold) && q.thresholdType === (n.ThresholdType ?? 'PERCENTAGE'));
  if (!x) throw new AwsError('NotFoundException', "Failed to call the operation - the notification doesn't exist.", 400);
  return x;
};
export function deleteNotification(ctx: Ctx, p: { AccountId: string; BudgetName: string; Notification: NotificationIn }): void {
  trailed(ctx, SRC, 'DeleteNotification', [], { AccountId: p.AccountId, BudgetName: p.BudgetName }, () => {
    authorize(ctx, 'budgets:ModifyBudget', budgetArn(ctx, p.BudgetName));
    own(ctx, p.AccountId);
    const b = need(ctx, p.BudgetName);
    const n = findN(b, p.Notification);
    b.notifications = b.notifications.filter((x) => x !== n);
  });
}
export function describeNotificationsForBudget(ctx: Ctx, p: { AccountId: string; BudgetName: string }): BudgetNotification[] {
  return trailed(ctx, SRC, 'DescribeNotificationsForBudget', [], p, () => {
    authorize(ctx, 'budgets:ViewBudget', budgetArn(ctx, p.BudgetName));
    own(ctx, p.AccountId);
    settleBudgets(ctx.s);
    return need(ctx, p.BudgetName).notifications;
  });
}
export function createSubscriber(ctx: Ctx, p: { AccountId: string; BudgetName: string; Notification: NotificationIn; Subscriber: SubscriberIn }): void {
  trailed(ctx, SRC, 'CreateSubscriber', [], { AccountId: p.AccountId, BudgetName: p.BudgetName }, () => {
    authorize(ctx, 'budgets:ModifyBudget', budgetArn(ctx, p.BudgetName));
    own(ctx, p.AccountId);
    const n = findN(need(ctx, p.BudgetName), p.Notification);
    const sub = mkSub(ctx, p.Subscriber);
    if (n.subscribers.some((x) => x.type === sub.type && x.address === sub.address)) throw new AwsError('DuplicateRecordException', 'Error creating subscriber: the subscriber already exists.', 400);
    n.subscribers.push(sub);
  });
}
export function describeSubscribersForNotification(ctx: Ctx, p: { AccountId: string; BudgetName: string; Notification: NotificationIn }) {
  return trailed(ctx, SRC, 'DescribeSubscribersForNotification', [], { AccountId: p.AccountId, BudgetName: p.BudgetName }, () => {
    authorize(ctx, 'budgets:ViewBudget', budgetArn(ctx, p.BudgetName));
    own(ctx, p.AccountId);
    return findN(need(ctx, p.BudgetName), p.Notification).subscribers;
  });
}

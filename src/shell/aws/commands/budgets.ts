// aws budgets y aws ce
import { defineCommand } from '../framework';
import * as bud from '../../../engine/services/budgets';
import * as ce from '../../../engine/services/ce';
import { amount } from '../../../engine/services/costs';
import type { Budget, BudgetNotification } from '../../../engine/services/govTypes';

const isoMicro = (s: string) => s.replace(/\.(\d{3})Z$/, '.$1000+00:00').replace(/Z$/, '+00:00');
const flat = <T>(v: unknown): T[] => (v === undefined ? [] : ([] as unknown[]).concat(...[v as unknown[]].flat()) as T[]);
const money = (n: number) => ({ Amount: amount(n), Unit: 'USD' });

const budgetView = (b: Budget, spend?: bud.Spend) => ({
  BudgetName: b.name, BudgetLimit: { Amount: b.limit.toFixed(1), Unit: b.unit }, CostFilters: {}, CostTypes: { IncludeTax: true, IncludeSubscription: true, UseBlended: false, IncludeRefund: true, IncludeCredit: true, IncludeUpfront: true, IncludeRecurring: true, IncludeOtherSubscription: true, IncludeSupport: true, IncludeDiscount: true, UseAmortized: false },
  TimeUnit: b.timeUnit, TimePeriod: {}, CalculatedSpend: spend ? { ActualSpend: money(spend.actual), ForecastedSpend: money(spend.forecast) } : undefined, BudgetType: b.type, LastUpdatedTime: isoMicro(b.createdAt),
});
const notifView = (n: BudgetNotification) => ({ NotificationType: n.type, ComparisonOperator: n.operator, Threshold: n.threshold, ThresholdType: n.thresholdType, NotificationState: n.state });
const subView = (x: { type: string; address: string }) => ({ SubscriptionType: x.type, Address: x.address });

defineCommand({
  service: 'budgets', name: 'create-budget', op: 'CreateBudget', structured: ['budget', 'notifications-with-subscribers'], list: ['notifications-with-subscribers'],
  run: (c, p) => void bud.createBudget(c, { AccountId: String(p.AccountId), Budget: p.Budget, NotificationsWithSubscribers: flat(p.NotificationsWithSubscribers) }),
});
defineCommand({ service: 'budgets', name: 'describe-budgets', op: 'DescribeBudgets', run: (c, p) => ({ Budgets: bud.describeBudgets(c, { AccountId: String(p.AccountId) }).map((x) => budgetView(x.budget, x.spend)) }) });
defineCommand({ service: 'budgets', name: 'describe-budget', op: 'DescribeBudget', run: (c, p) => { const x = bud.describeBudget(c, { AccountId: String(p.AccountId), BudgetName: p.BudgetName }); return { Budget: budgetView(x.budget, x.spend) }; } });
defineCommand({ service: 'budgets', name: 'update-budget', op: 'UpdateBudget', structured: ['new-budget'], run: (c, p) => void bud.updateBudget(c, { AccountId: String(p.AccountId), NewBudget: p.NewBudget }) });
defineCommand({ service: 'budgets', name: 'delete-budget', op: 'DeleteBudget', run: (c, p) => void bud.deleteBudget(c, { AccountId: String(p.AccountId), BudgetName: p.BudgetName }) });
defineCommand({
  service: 'budgets', name: 'create-notification', op: 'CreateNotification', structured: ['notification', 'subscribers'], list: ['subscribers'],
  run: (c, p) => void bud.createNotification(c, { AccountId: String(p.AccountId), BudgetName: p.BudgetName, Notification: p.Notification, Subscribers: flat(p.Subscribers) }),
});
defineCommand({ service: 'budgets', name: 'delete-notification', op: 'DeleteNotification', structured: ['notification'], run: (c, p) => void bud.deleteNotification(c, { AccountId: String(p.AccountId), BudgetName: p.BudgetName, Notification: p.Notification }) });
defineCommand({ service: 'budgets', name: 'describe-notifications-for-budget', op: 'DescribeNotificationsForBudget', run: (c, p) => ({ Notifications: bud.describeNotificationsForBudget(c, { AccountId: String(p.AccountId), BudgetName: p.BudgetName }).map(notifView) }) });
defineCommand({
  service: 'budgets', name: 'create-subscriber', op: 'CreateSubscriber', structured: ['notification', 'subscriber'],
  run: (c, p) => void bud.createSubscriber(c, { AccountId: String(p.AccountId), BudgetName: p.BudgetName, Notification: p.Notification, Subscriber: p.Subscriber }),
});
defineCommand({
  service: 'budgets', name: 'describe-subscribers-for-notification', op: 'DescribeSubscribersForNotification', structured: ['notification'],
  run: (c, p) => ({ Subscribers: bud.describeSubscribersForNotification(c, { AccountId: String(p.AccountId), BudgetName: p.BudgetName, Notification: p.Notification }).map(subView) }),
});

// ---------------------------------------------------------------- Cost Explorer
const METRIC_UNIT = (m: string, unit: string) => (m === 'UsageQuantity' ? unit : 'USD');
defineCommand({
  service: 'ce', name: 'get-cost-and-usage', op: 'GetCostAndUsage', list: ['metrics', 'group-by'], structured: ['time-period', 'group-by', 'filter'],
  run: (c, p) => {
    const r = ce.getCostAndUsage(c, { TimePeriod: p.TimePeriod, Granularity: p.Granularity, Metrics: p.Metrics, GroupBy: flat(p.GroupBy), Filter: p.Filter });
    const metrics = (usd: number, qty: number, unit: string) => Object.fromEntries(r.metrics.map((m) => [m, { Amount: amount(m === 'UsageQuantity' ? qty : usd), Unit: METRIC_UNIT(m, unit) }]));
    return {
      GroupDefinitions: r.groupBy.map((g) => ({ Type: g.Type, Key: g.Key })),
      ResultsByTime: r.periods.map((x) => ({ TimePeriod: { Start: x.start, End: x.end }, Total: r.groupBy.length ? {} : metrics(x.usd, x.qty, x.unit), Groups: x.groups.map((g) => ({ Keys: g.keys, Metrics: metrics(g.usd, g.qty, g.unit) })), Estimated: true })),
      DimensionValueAttributes: [],
    };
  },
});
defineCommand({
  service: 'ce', name: 'get-dimension-values', op: 'GetDimensionValues', structured: ['time-period'],
  run: (c, p) => { const v = ce.getDimensionValues(c, { TimePeriod: p.TimePeriod, Dimension: p.Dimension }); return { DimensionValues: v.map((x) => ({ Value: x, Attributes: {} })), ReturnSize: v.length, TotalSize: v.length }; },
});
defineCommand({
  service: 'ce', name: 'get-cost-forecast', op: 'GetCostForecast', structured: ['time-period'],
  run: (c, p) => {
    const r = ce.getCostForecast(c, { TimePeriod: p.TimePeriod, Metric: p.Metric, Granularity: p.Granularity });
    return { Total: money(r.total), ForecastResultsByTime: r.periods.map((x) => ({ TimePeriod: { Start: x.start, End: x.end }, MeanValue: amount(x.mean), PredictionIntervalLowerBound: amount(x.mean * 0.9), PredictionIntervalUpperBound: amount(x.mean * 1.1) })) };
  },
});

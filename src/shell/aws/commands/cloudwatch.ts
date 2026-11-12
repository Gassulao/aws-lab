// aws cloudwatch, aws logs, aws sns
import { defineCommand, type Params } from '../framework';
import * as cw from '../../../engine/services/cloudwatch';
import * as lg from '../../../engine/services/logs';
import * as sns from '../../../engine/services/sns';
import type { CwAlarm } from '../../../engine/types';

const isoMicro = (s: string) => s.replace(/\.(\d{3})Z$/, '.$1000+00:00').replace(/Z$/, '+00:00');
const isoSec = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, '+00:00');
const n = (v: unknown) => (v === undefined ? undefined : Number(v));
const dims = (p: Params) => (p.Dimensions ?? []).map((d: any) => ({ Name: d.Name, Value: String(d.Value) }));

const alarmShape = (a: CwAlarm) => ({
  AlarmName: a.name, AlarmArn: a.arn, ...(a.description ? { AlarmDescription: a.description } : {}), AlarmConfigurationUpdatedTimestamp: isoMicro(a.configUpdated), ActionsEnabled: a.actionsEnabled,
  OKActions: a.okActions, AlarmActions: a.alarmActions, InsufficientDataActions: a.insufficientActions, StateValue: a.state, StateReason: a.stateReason, StateUpdatedTimestamp: isoMicro(a.stateUpdated),
  MetricName: a.metric, Namespace: a.namespace, Statistic: a.statistic, Dimensions: Object.entries(a.dims).map(([Name, Value]) => ({ Name, Value })), Period: a.period, EvaluationPeriods: a.evalPeriods,
  ...(a.datapointsToAlarm ? { DatapointsToAlarm: a.datapointsToAlarm } : {}), Threshold: a.threshold, ComparisonOperator: a.operator, TreatMissingData: a.treatMissing, StateTransitionedTimestamp: isoMicro(a.stateUpdated),
});

// ------------------------------------------------------------------ cloudwatch

defineCommand({
  service: 'cloudwatch', name: 'put-metric-data', op: 'PutMetricData', list: ['metric-data', 'dimensions', 'statistic-values'], structured: ['metric-data', 'dimensions', 'statistic-values'],
  run: (c, p) => {
    const data = p.MetricData ?? [{ MetricName: p.MetricName, Dimensions: p.Dimensions ? dims(p) : undefined, Timestamp: p.Timestamp, Value: p.Value !== undefined ? Number(p.Value) : undefined, Unit: p.Unit,
      StatisticValues: p.StatisticValues?.[0] ? { SampleCount: Number(p.StatisticValues[0].SampleCount), Sum: Number(p.StatisticValues[0].Sum), Minimum: Number(p.StatisticValues[0].Minimum), Maximum: Number(p.StatisticValues[0].Maximum) } : undefined }];
    if (!p.MetricData && !p.MetricName) throw new Error('aws: error: the following arguments are required: --metric-data or --metric-name');
    cw.putMetricData(c, { Namespace: p.Namespace, MetricData: data.map((d: any) => ({ ...d, Value: d.Value !== undefined ? Number(d.Value) : undefined, Dimensions: d.Dimensions?.map((x: any) => ({ Name: x.Name, Value: String(x.Value) })) })) });
  },
});
defineCommand({
  service: 'cloudwatch', name: 'list-metrics', op: 'ListMetrics', list: ['dimensions'], structured: ['dimensions'],
  run: (c, p) => ({ Metrics: cw.listMetrics(c, { Namespace: p.Namespace, MetricName: p.MetricName, Dimensions: p.Dimensions }) }),
});
defineCommand({
  service: 'cloudwatch', name: 'get-metric-statistics', op: 'GetMetricStatistics', list: ['statistics', 'dimensions'], structured: ['dimensions'],
  run: (c, p) => {
    for (const k of ['Namespace', 'MetricName', 'StartTime', 'EndTime', 'Period']) if (p[k] === undefined) throw new Error(`aws: error: the following arguments are required: --${k.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`);
    const r = cw.getMetricStatistics(c, { Namespace: p.Namespace, MetricName: p.MetricName, Dimensions: dims(p), StartTime: p.StartTime, EndTime: p.EndTime, Period: Number(p.Period), Statistics: p.Statistics, Unit: p.Unit });
    return { Label: r.Label, Datapoints: r.Datapoints.map((d) => ({ ...d, Timestamp: isoSec(Date.parse(d.Timestamp)) })) };
  },
});
defineCommand({
  service: 'cloudwatch', name: 'put-metric-alarm', op: 'PutMetricAlarm', list: ['dimensions', 'alarm-actions', 'ok-actions', 'insufficient-data-actions'], structured: ['dimensions'], bool: ['actions-enabled'],
  run: (c, p) => {
    cw.putMetricAlarm(c, {
      AlarmName: p.AlarmName, AlarmDescription: p.AlarmDescription, Namespace: p.Namespace, MetricName: p.MetricName, Dimensions: p.Dimensions ? dims(p) : undefined, Statistic: p.Statistic, Period: Number(p.Period),
      EvaluationPeriods: Number(p.EvaluationPeriods), DatapointsToAlarm: n(p.DatapointsToAlarm), Threshold: Number(p.Threshold), ComparisonOperator: p.ComparisonOperator, TreatMissingData: p.TreatMissingData, Unit: p.Unit,
      AlarmActions: p.AlarmActions, OKActions: p.OkActions, InsufficientDataActions: p.InsufficientDataActions, ActionsEnabled: p.ActionsEnabled,
    });
  },
});
defineCommand({
  service: 'cloudwatch', name: 'describe-alarms', op: 'DescribeAlarms', list: ['alarm-names'],
  run: (c, p) => ({ CompositeAlarms: [], MetricAlarms: cw.describeAlarms(c, { AlarmNames: p.AlarmNames, AlarmNamePrefix: p.AlarmNamePrefix, StateValue: p.StateValue }).map(alarmShape) }),
});
defineCommand({ service: 'cloudwatch', name: 'delete-alarms', op: 'DeleteAlarms', list: ['alarm-names'], run: (c, p) => void cw.deleteAlarms(c, { AlarmNames: p.AlarmNames ?? [] }) });
defineCommand({ service: 'cloudwatch', name: 'set-alarm-state', op: 'SetAlarmState', run: (c, p) => void cw.setAlarmState(c, { AlarmName: p.AlarmName, StateValue: p.StateValue, StateReason: p.StateReason }) });
defineCommand({ service: 'cloudwatch', name: 'enable-alarm-actions', op: 'EnableAlarmActions', list: ['alarm-names'], run: (c, p) => void cw.enableAlarmActions(c, { AlarmNames: p.AlarmNames ?? [] }, true) });
defineCommand({ service: 'cloudwatch', name: 'disable-alarm-actions', op: 'DisableAlarmActions', list: ['alarm-names'], run: (c, p) => void cw.enableAlarmActions(c, { AlarmNames: p.AlarmNames ?? [] }, false) });
defineCommand({
  service: 'cloudwatch', name: 'describe-alarm-history', op: 'DescribeAlarmHistory',
  run: (c, p) => ({ AlarmHistoryItems: cw.describeAlarmHistory(c, { AlarmName: p.AlarmName, HistoryItemType: p.HistoryItemType }).map((h) => ({ AlarmName: h.name, AlarmType: 'MetricAlarm', Timestamp: isoMicro(h.ts), HistoryItemType: h.type, HistorySummary: h.summary, ...(h.data ? { HistoryData: h.data } : {}) })) }),
});

// ------------------------------------------------------------------ logs

defineCommand({ service: 'logs', name: 'create-log-group', op: 'CreateLogGroup', run: (c, p) => void lg.createLogGroup(c, { LogGroupName: p.LogGroupName, KmsKeyId: p.KmsKeyId }) });
defineCommand({ service: 'logs', name: 'delete-log-group', op: 'DeleteLogGroup', run: (c, p) => void lg.deleteLogGroup(c, { LogGroupName: p.LogGroupName }) });
defineCommand({
  service: 'logs', name: 'describe-log-groups', op: 'DescribeLogGroups',
  run: (c, p) => ({ logGroups: lg.describeLogGroups(c, { LogGroupNamePrefix: p.LogGroupNamePrefix, LogGroupNamePattern: p.LogGroupNamePattern }).map((g) => ({ logGroupName: g.name, creationTime: g.created, ...(g.retention ? { retentionInDays: g.retention } : {}), metricFilterCount: g.filters.length, arn: g.arn, storedBytes: g.streams.reduce((a, s) => a + s.events.reduce((b, e) => b + e.message.length + 26, 0), 0), ...(g.kmsKeyId ? { kmsKeyId: g.kmsKeyId } : {}), logGroupClass: 'STANDARD', logGroupArn: g.arn })) }),
});
defineCommand({ service: 'logs', name: 'put-retention-policy', op: 'PutRetentionPolicy', run: (c, p) => void lg.putRetentionPolicy(c, { LogGroupName: p.LogGroupName, RetentionInDays: Number(p.RetentionInDays) }) });
defineCommand({ service: 'logs', name: 'delete-retention-policy', op: 'DeleteRetentionPolicy', run: (c, p) => void lg.deleteRetentionPolicy(c, { LogGroupName: p.LogGroupName }) });
defineCommand({ service: 'logs', name: 'create-log-stream', op: 'CreateLogStream', run: (c, p) => void lg.createLogStream(c, { LogGroupName: p.LogGroupName, LogStreamName: p.LogStreamName }) });
defineCommand({
  service: 'logs', name: 'describe-log-streams', op: 'DescribeLogStreams',
  run: (c, p) => ({ logStreams: lg.describeLogStreams(c, { LogGroupName: p.LogGroupName, LogStreamNamePrefix: p.LogStreamNamePrefix }).map((s) => ({ logStreamName: s.name, creationTime: s.created, ...(s.events.length ? { firstEventTimestamp: s.events[0].ts, lastEventTimestamp: s.events[s.events.length - 1].ts, lastIngestionTime: s.events[s.events.length - 1].ingestion } : {}), uploadSequenceToken: `49${String(s.seq).padStart(20, '0')}`, arn: `arn:aws:logs:${c.region}:${c.s.account.id}:log-group:${p.LogGroupName}:log-stream:${s.name}`, storedBytes: 0 })) }),
});
defineCommand({
  service: 'logs', name: 'put-log-events', op: 'PutLogEvents', list: ['log-events'], structured: ['log-events'],
  run: (c, p) => {
    const evs = (Array.isArray(p.LogEvents) && p.LogEvents.length === 1 && Array.isArray(p.LogEvents[0]) ? p.LogEvents[0] : p.LogEvents) as any[];
    return lg.putLogEvents(c, { LogGroupName: p.LogGroupName, LogStreamName: p.LogStreamName, LogEvents: (evs ?? []).map((e) => ({ timestamp: Number(e.timestamp), message: String(e.message) })), SequenceToken: p.SequenceToken });
  },
});
defineCommand({
  service: 'logs', name: 'get-log-events', op: 'GetLogEvents', bool: ['start-from-head'],
  run: (c, p) => ({ events: lg.getLogEvents(c, { LogGroupName: p.LogGroupName, LogStreamName: p.LogStreamName, StartTime: n(p.StartTime), EndTime: n(p.EndTime), Limit: n(p.Limit), StartFromHead: p.StartFromHead }).map((e) => ({ timestamp: e.ts, message: e.message, ingestionTime: e.ingestion })), nextForwardToken: 'f/' + '0'.repeat(56), nextBackwardToken: 'b/' + '0'.repeat(56) }),
});
defineCommand({
  service: 'logs', name: 'filter-log-events', op: 'FilterLogEvents', list: ['log-stream-names'],
  run: (c, p) => {
    const r = lg.filterLogEvents(c, { LogGroupName: p.LogGroupName, LogStreamNames: p.LogStreamNames, FilterPattern: p.FilterPattern, StartTime: n(p.StartTime), EndTime: n(p.EndTime), Limit: n(p.Limit) });
    return { events: r.events.map((e) => ({ logStreamName: e.stream, timestamp: e.ts, message: e.message, ingestionTime: e.ingestion, eventId: e.id })), searchedLogStreams: r.streams.map((s) => ({ logStreamName: s, searchedCompletely: true })) };
  },
});
defineCommand({
  service: 'logs', name: 'put-metric-filter', op: 'PutMetricFilter', list: ['metric-transformations'], structured: ['metric-transformations'],
  run: (c, p) => {
    const mt = (Array.isArray(p.MetricTransformations?.[0]) ? p.MetricTransformations[0] : p.MetricTransformations) as any[];
    lg.putMetricFilter(c, { LogGroupName: p.LogGroupName, FilterName: p.FilterName, FilterPattern: p.FilterPattern ?? '', MetricTransformations: mt.map((m) => ({ metricName: m.metricName, metricNamespace: m.metricNamespace, metricValue: String(m.metricValue) })) });
  },
});
defineCommand({
  service: 'logs', name: 'describe-metric-filters', op: 'DescribeMetricFilters',
  run: (c, p) => ({ metricFilters: lg.describeMetricFilters(c, { LogGroupName: p.LogGroupName, FilterNamePrefix: p.FilterNamePrefix }).map(({ g, f }) => ({ filterName: f.name, filterPattern: f.pattern, metricTransformations: [{ metricName: f.metric, metricNamespace: f.ns, metricValue: f.value }], creationTime: f.created, logGroupName: g.name })) }),
});
defineCommand({ service: 'logs', name: 'delete-metric-filter', op: 'DeleteMetricFilter', run: (c, p) => void lg.deleteMetricFilter(c, { LogGroupName: p.LogGroupName, FilterName: p.FilterName }) });
defineCommand({
  service: 'logs', name: 'tail', op: 'FilterLogEvents', raw: true, bool: ['follow', 'format'],
  run: (c, p, _sh, pos) => {
    const g = pos[0] ?? p.LogGroupName;
    if (!g) throw new Error('aws: error: the following arguments are required: group_name');
    const m = String(p.Since ?? '10m').match(/^(\d+)([smhdw])$/);
    const ms = m ? Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as 's'] : 600_000;
    const r = lg.filterLogEvents(c, { LogGroupName: g, FilterPattern: p.FilterPattern, StartTime: Date.now() - ms });
    return r.events.map((e) => `${new Date(e.ts).toISOString().replace(/Z$/, '000+00:00')} ${e.stream} ${e.message}\n`).join('');
  },
});

// ------------------------------------------------------------------ sns

const subArn = (s: { arn: string; confirmed: boolean }) => (s.confirmed ? s.arn : 'PendingConfirmation');
defineCommand({ service: 'sns', name: 'create-topic', op: 'CreateTopic', run: (c, p) => ({ TopicArn: sns.createTopic(c, { Name: p.Name }).arn }) });
defineCommand({ service: 'sns', name: 'list-topics', op: 'ListTopics', run: (c) => ({ Topics: sns.listTopics(c).map((t) => ({ TopicArn: t.arn })) }) });
defineCommand({ service: 'sns', name: 'delete-topic', op: 'DeleteTopic', run: (c, p) => void sns.deleteTopic(c, { TopicArn: p.TopicArn }) });
defineCommand({
  service: 'sns', name: 'subscribe', op: 'Subscribe', bool: ['return-subscription-arn'],
  run: (c, p) => { const s = sns.subscribe(c, { TopicArn: p.TopicArn, Protocol: p.Protocol, Endpoint: p.NotificationEndpoint }); return { SubscriptionArn: s.confirmed || p.ReturnSubscriptionArn ? s.arn : 'pending confirmation' }; },
});
defineCommand({ service: 'sns', name: 'confirm-subscription', op: 'ConfirmSubscription', run: (c, p) => ({ SubscriptionArn: sns.confirmSubscription(c, { TopicArn: p.TopicArn, Token: p.Token }).arn }) });
defineCommand({
  service: 'sns', name: 'list-subscriptions-by-topic', op: 'ListSubscriptionsByTopic',
  run: (c, p) => ({ Subscriptions: sns.listSubscriptionsByTopic(c, { TopicArn: p.TopicArn }).subs.map((s) => ({ SubscriptionArn: subArn(s), Owner: c.s.account.id, Protocol: s.protocol, Endpoint: s.endpoint, TopicArn: p.TopicArn })) }),
});
defineCommand({ service: 'sns', name: 'publish', op: 'Publish', run: (c, p) => ({ MessageId: sns.publish(c, { TopicArn: p.TopicArn, Message: p.Message, Subject: p.Subject }) }) });

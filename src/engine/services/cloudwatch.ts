// Amazon CloudWatch: métricas (EC2 deterministas + personalizadas), estadísticas y alarmas, con SNS mínimo.
// Simplificaciones: las alarmas se reevalúan al consultarlas (reloj inyectable `now()`), no cada minuto; los datos de
// EC2 son sintéticos (un punto cada 5 minutos mientras la instancia corre) y la etiqueta `simulador:carga=alta`
// hace que la CPU supere el 80 %.
import type { CwAlarm, Instance, MetricPoint, SnsTopic } from '../types';
import { AwsError } from '../errors';
import { trailed, authorize, type Ctx } from '../api';
import { nowIso, now, guid } from '../util';
import { settle } from './ec2';
import { fakeSignature } from './s3Extra';

const SRC = 'monitoring.amazonaws.com';
const EC2_NS = 'AWS/EC2';
export const EC2_METRICS: Record<string, string> = { CPUUtilization: 'Percent', NetworkIn: 'Bytes', NetworkOut: 'Bytes', DiskReadOps: 'Count', StatusCheckFailed: 'Count' };
export const STATS = ['Average', 'Sum', 'Minimum', 'Maximum', 'SampleCount'];
export const OPERATORS: Record<string, string> = { GreaterThanThreshold: 'greater than', GreaterThanOrEqualToThreshold: 'greater than or equal to', LessThanThreshold: 'less than', LessThanOrEqualToThreshold: 'less than or equal to' };
const BUCKET = 300_000;
const MAX_LOOKBACK = 14 * 86_400_000;

const hash = (s: string) => parseInt(fakeSignature(s).slice(0, 8), 16);

function ranIn(i: Instance, from: number, to: number): boolean {
  const per = [...(i.runPeriods ?? []), ...(i.runningSince ? [{ from: i.runningSince, to: Infinity }] : [])];
  return per.some((x) => x.from < to && x.to > from);
}

function ec2Value(i: Instance, metric: string, t: number): number {
  const h = hash(`${i.id}|${metric}|${t}`) % 1000;
  const f = h / 1000;
  const high = (i.tags['simulador:carga'] ?? '').toLowerCase() === 'alta';
  switch (metric) {
    case 'CPUUtilization': return Math.round((high ? 82 + f * 16 : 2 + f * 7) * 100) / 100;
    case 'NetworkIn': return Math.round(2000 + f * 40000);
    case 'NetworkOut': return Math.round(1500 + f * 30000);
    case 'DiskReadOps': return Math.round(f * 20);
    default: return 0;
  }
}

/** Puntos crudos (5 min) de las instancias EC2 para una métrica, en [from, to]. */
function ec2Points(s: Ctx['s'], dims: Record<string, string>, metric: string, from: number, to: number): MetricPoint[] {
  if (!(metric in EC2_METRICS)) return [];
  settle(s);
  const out: MetricPoint[] = [];
  const insts = s.instances.filter((i) => (!dims.InstanceId || i.id === dims.InstanceId) && Object.keys(dims).every((k) => k === 'InstanceId'));
  if (!insts.length || (Object.keys(dims).length && !dims.InstanceId)) return [];
  const lo = Math.max(from, now() - MAX_LOOKBACK);
  for (const i of insts) {
    for (let t = Math.floor(lo / BUCKET) * BUCKET; t <= Math.min(to, now()); t += BUCKET) {
      if (t < lo - BUCKET || t > to) continue;
      if (ranIn(i, t, t + BUCKET)) out.push({ ns: EC2_NS, name: metric, dims: { InstanceId: i.id }, ts: t, value: ec2Value(i, metric, t), unit: EC2_METRICS[metric] });
    }
  }
  return out;
}

const dimsEq = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);

export function pointsFor(s: Ctx['s'], ns: string, name: string, dims: Record<string, string>, from: number, to: number): MetricPoint[] {
  if (ns === EC2_NS) return ec2Points(s, dims, name, from, to);
  return s.metricData.filter((m) => m.ns === ns && m.name === name && dimsEq(m.dims, dims) && m.ts >= from && m.ts <= to);
}

export function statOf(stat: string, vals: number[]): number {
  switch (stat) {
    case 'Sum': return vals.reduce((a, b) => a + b, 0);
    case 'Minimum': return Math.min(...vals);
    case 'Maximum': return Math.max(...vals);
    case 'SampleCount': return vals.length;
    default: return vals.reduce((a, b) => a + b, 0) / vals.length;
  }
}

// ------------------------------------------------------------------ API de métricas

const checkNs = (ns: string) => {
  if (!ns || ns.startsWith('AWS/')) throw new AwsError('InvalidParameterValue', 'The value AWS/ for parameter Namespace is invalid. Namespaces starting with "AWS/" are reserved.', 400);
};

export function putMetricData(ctx: Ctx, p: { Namespace: string; MetricData: { MetricName: string; Dimensions?: { Name: string; Value: string }[]; Timestamp?: string | number; Value?: number; Unit?: string; StatisticValues?: { SampleCount: number; Sum: number; Minimum: number; Maximum: number } }[] }): void {
  return trailed(ctx, SRC, 'PutMetricData', [], { namespace: p.Namespace }, () => {
    authorize(ctx, 'cloudwatch:PutMetricData', '*');
    if (!p.Namespace) throw new AwsError('MissingParameter', 'The parameter Namespace is required.', 400);
    if (p.Namespace.startsWith('AWS/')) throw new AwsError('InvalidParameterValue', `The value ${p.Namespace} for parameter Namespace is invalid.`, 400);
    if (!p.MetricData?.length) throw new AwsError('MissingParameter', 'The parameter MetricData is required.', 400);
    for (const d of p.MetricData) {
      if (!d.MetricName) throw new AwsError('MissingParameter', 'The parameter MetricData.member.1.MetricName is required.', 400);
      const v = d.Value ?? (d.StatisticValues ? d.StatisticValues.Sum / d.StatisticValues.SampleCount : undefined);
      if (v === undefined || !Number.isFinite(v)) throw new AwsError('MissingParameter', 'The parameter MetricData.member.1.Value (or StatisticValues) is required.', 400);
      const dims: Record<string, string> = {};
      for (const x of d.Dimensions ?? []) dims[x.Name] = x.Value;
      const ts = d.Timestamp !== undefined ? (typeof d.Timestamp === 'number' ? d.Timestamp * (d.Timestamp < 1e11 ? 1000 : 1) : Date.parse(String(d.Timestamp))) : now();
      if (Number.isNaN(ts)) throw new AwsError('InvalidParameterValue', 'The parameter MetricData.member.1.Timestamp is invalid.', 400);
      ctx.s.metricData.push({ ns: p.Namespace, name: d.MetricName, dims, ts, value: v, unit: d.Unit ?? 'None' });
    }
    if (ctx.s.metricData.length > 20000) ctx.s.metricData.splice(0, ctx.s.metricData.length - 20000);
    for (const a of ctx.s.alarms) if (a.namespace === p.Namespace) a.holdUntil = undefined;
  });
}

export function emitMetric(s: Ctx['s'], ns: string, name: string, value: number, ts = now(), dims: Record<string, string> = {}): void {
  s.metricData.push({ ns, name, dims, ts, value, unit: 'Count' });
  for (const a of s.alarms) if (a.namespace === ns) a.holdUntil = undefined;
}

export function listMetrics(ctx: Ctx, p: { Namespace?: string; MetricName?: string; Dimensions?: { Name: string; Value?: string }[] }) {
  return trailed(ctx, SRC, 'ListMetrics', [], p, () => {
    authorize(ctx, 'cloudwatch:ListMetrics', '*');
    settle(ctx.s);
    const seen = new Map<string, { Namespace: string; MetricName: string; Dimensions: { Name: string; Value: string }[] }>();
    const add = (ns: string, name: string, dims: Record<string, string>) => seen.set(`${ns}|${name}|${JSON.stringify(dims)}`, { Namespace: ns, MetricName: name, Dimensions: Object.entries(dims).map(([Name, Value]) => ({ Name, Value })) });
    for (const m of ctx.s.metricData) add(m.ns, m.name, m.dims);
    for (const i of ctx.s.instances) if (i.state !== 'terminated' && (i.runPeriods?.length || i.runningSince)) for (const m of Object.keys(EC2_METRICS)) add(EC2_NS, m, { InstanceId: i.id });
    return [...seen.values()].filter((m) => (!p.Namespace || m.Namespace === p.Namespace) && (!p.MetricName || m.MetricName === p.MetricName)
      && (p.Dimensions ?? []).every((d) => m.Dimensions.some((x) => x.Name === d.Name && (d.Value === undefined || x.Value === d.Value))));
  });
}

export function getMetricStatistics(ctx: Ctx, p: { Namespace: string; MetricName: string; Dimensions?: { Name: string; Value: string }[]; StartTime: string | number; EndTime: string | number; Period: number; Statistics?: string[]; Unit?: string }) {
  return trailed(ctx, SRC, 'GetMetricStatistics', [], { namespace: p.Namespace, metricName: p.MetricName }, () => {
    authorize(ctx, 'cloudwatch:GetMetricStatistics', '*');
    const toMs = (v: string | number) => (typeof v === 'number' ? v * (v < 1e11 ? 1000 : 1) : Date.parse(v));
    const from = toMs(p.StartTime), to = toMs(p.EndTime);
    if (Number.isNaN(from) || Number.isNaN(to)) throw new AwsError('InvalidParameterValue', 'The parameter StartTime/EndTime is invalid.', 400);
    if (from >= to) throw new AwsError('InvalidParameterValue', 'The parameter StartTime must be less than the parameter EndTime.', 400);
    const period = Number(p.Period);
    if (!period || period < 1 || period % 60 !== 0) throw new AwsError('InvalidParameterValue', `The parameter Period must be a multiple of 60.`, 400);
    const stats = p.Statistics ?? [];
    if (!stats.length) throw new AwsError('InvalidParameterCombination', 'Must specify either Statistics or ExtendedStatistics', 400);
    for (const st of stats) if (!STATS.includes(st)) throw new AwsError('InvalidParameterValue', `Invalid value for Statistics: ${st}`, 400);
    const dims: Record<string, string> = {};
    for (const d of p.Dimensions ?? []) dims[d.Name] = d.Value;
    const pts = pointsFor(ctx.s, p.Namespace, p.MetricName, dims, from, to - 1).filter((x) => !p.Unit || x.unit === p.Unit);
    const buckets = new Map<number, MetricPoint[]>();
    for (const x of pts) {
      const b = from + Math.floor((x.ts - from) / (period * 1000)) * period * 1000;
      (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(x);
    }
    const Datapoints = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([b, xs]) => {
      const vals = xs.map((x) => x.value);
      const o: Record<string, any> = { Timestamp: new Date(b).toISOString() };
      for (const st of stats) o[st] = Math.round(statOf(st, vals) * 1e6) / 1e6;
      o.Unit = xs[0].unit;
      return o;
    });
    return { Label: p.MetricName, Datapoints };
  });
}

// ------------------------------------------------------------------ SNS mínimo (lo usan las acciones de alarma)

export function topicByArn(s: Ctx['s'], arn: string): SnsTopic | undefined {
  return s.topics.find((t) => t.arn === arn);
}

/** Ganchos que reparten cada mensaje publicado a sus suscriptores (SQS, Lambda...). Los registra el módulo `serverless`. */
export const publishHooks: ((s: Ctx['s'], t: SnsTopic, message: string, subject: string | undefined, id: string) => void)[] = [];

export function publishTo(s: Ctx['s'], t: SnsTopic, message: string, subject: string | undefined, source: string): string {
  const id = guid();
  t.messages.push({ id, ts: nowIso(), subject, message, source });
  if (t.messages.length > 200) t.messages.shift();
  for (const h of publishHooks) h(s, t, message, subject, id);
  return id;
}

// ------------------------------------------------------------------ alarmas

const alarmArn = (ctx: Ctx, n: string) => `arn:aws:cloudwatch:${ctx.region}:${ctx.s.account.id}:alarm:${n}`;
const fmtTs = (t: number) => { const d = new Date(t); const z = (n: number) => String(n).padStart(2, '0'); return `${z(d.getUTCDate())}/${z(d.getUTCMonth() + 1)}/${String(d.getUTCFullYear()).slice(2)} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())}`; };
const num = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

function breaches(op: string, v: number, thr: number) {
  switch (op) {
    case 'GreaterThanThreshold': return v > thr;
    case 'GreaterThanOrEqualToThreshold': return v >= thr;
    case 'LessThanThreshold': return v < thr;
    default: return v <= thr;
  }
}

function evaluateOne(s: Ctx['s'], a: CwAlarm): { state: CwAlarm['state']; reason: string } {
  const t = now();
  const need = a.datapointsToAlarm ?? a.evalPeriods;
  const res: { v?: number; at?: number; b: boolean | null }[] = [];
  for (let i = a.evalPeriods - 1; i >= 0; i--) {
    const hi = t - i * a.period * 1000, lo = hi - a.period * 1000;
    const pts = pointsFor(s, a.namespace, a.metric, a.dims, lo + (i === 0 ? 1 : 1), hi);
    if (!pts.length) res.push({ b: a.treatMissing === 'breaching' ? true : a.treatMissing === 'notBreaching' ? false : null });
    else { const v = statOf(a.statistic, pts.map((x) => x.value)); res.push({ v, at: Math.max(...pts.map((x) => x.ts)), b: breaches(a.operator, v, a.threshold) }); }
  }
  const have = res.filter((r) => r.b !== null);
  const list = (rs: typeof res) => rs.filter((r) => r.v !== undefined).map((r) => `${num(r.v!)} (${fmtTs(r.at!)})`).join(', ');
  const word = OPERATORS[a.operator];
  const thr = num(a.threshold);
  if (!have.length) return { state: 'INSUFFICIENT_DATA', reason: 'Insufficient Data: ' + (a.evalPeriods === 1 ? '1 datapoint was unknown.' : `${a.evalPeriods} datapoints were unknown.`) };
  const bad = have.filter((r) => r.b);
  if (bad.length >= need) {
    const rs = res.filter((r) => r.v !== undefined);
    return { state: 'ALARM', reason: a.evalPeriods === 1
      ? `Threshold Crossed: 1 datapoint [${list(rs)}] was ${word} the threshold (${thr}).`
      : `Threshold Crossed: ${bad.length} out of the last ${a.evalPeriods} datapoints [${list(rs)}] were ${word} the threshold (${thr}) (minimum ${need} datapoint${need > 1 ? 's' : ''} for OK -> ALARM transition).` };
  }
  if (have.length < need && a.treatMissing === 'missing') return { state: 'INSUFFICIENT_DATA', reason: `Insufficient Data: ${a.evalPeriods - have.length} datapoint${a.evalPeriods - have.length > 1 ? 's were' : ' was'} unknown.` };
  const rs = res.filter((r) => r.v !== undefined);
  return { state: 'OK', reason: a.evalPeriods === 1
    ? `Threshold Crossed: 1 datapoint [${list(rs)}] was not ${word} the threshold (${thr}).`
    : `Threshold Crossed: ${a.evalPeriods - bad.length} out of the last ${a.evalPeriods} datapoints [${list(rs)}] were not ${word} the threshold (${thr}).` };
}

function transition(s: Ctx['s'], a: CwAlarm, to: CwAlarm['state'], reason: string, manual = false) {
  const from = a.state;
  const ts = nowIso();
  const data = JSON.stringify({ version: '1.0', oldState: { stateValue: from }, newState: { stateValue: to, stateReason: reason }, ...(manual ? {} : {}) });
  a.history.push({ ts, type: 'StateUpdate', summary: `Alarm updated from ${from} to ${to}`, data });
  a.state = to; a.stateReason = reason; a.stateUpdated = ts;
  if (!a.actionsEnabled) return;
  const acts = to === 'ALARM' ? a.alarmActions : to === 'OK' ? a.okActions : a.insufficientActions;
  for (const arn of acts) {
    const topic = topicByArn(s, arn);
    if (topic) {
      publishTo(s, topic, JSON.stringify({ AlarmName: a.name, AlarmDescription: a.description ?? null, AWSAccountId: s.account.id, NewStateValue: to, NewStateReason: reason, StateChangeTime: ts, Region: a.region, OldStateValue: from, Trigger: { MetricName: a.metric, Namespace: a.namespace, Statistic: a.statistic.toUpperCase(), Period: a.period, EvaluationPeriods: a.evalPeriods, ComparisonOperator: a.operator, Threshold: a.threshold, TreatMissingData: a.treatMissing } }),
        `${to === 'OK' ? 'OK' : to === 'ALARM' ? 'ALARM' : 'INSUFFICIENT_DATA'}: "${a.name}" in ${a.region}`, 'cloudwatch');
    }
    a.history.push({ ts, type: 'Action', summary: `Successfully executed action ${arn}`, data: JSON.stringify({ actionState: 'Succeeded', notificationResource: arn }) });
  }
}

/** Reevalúa todas las alarmas con el reloj actual. */
export function settleCw(s: Ctx['s'], force = false) {
  const t = now();
  for (const a of s.alarms) {
    if (!force && a.holdUntil && a.holdUntil > t) continue;
    const r = evaluateOne(s, a);
    if (r.state !== a.state) transition(s, a, r.state, r.reason);
    else if (a.stateReason.startsWith('Unchecked')) a.stateReason = r.reason;
  }
}

export interface PutAlarmParams {
  AlarmName: string; AlarmDescription?: string; Namespace: string; MetricName: string; Dimensions?: { Name: string; Value: string }[]; Statistic?: string; Period: number; EvaluationPeriods: number;
  DatapointsToAlarm?: number; Threshold: number; ComparisonOperator: string; TreatMissingData?: string; Unit?: string; AlarmActions?: string[]; OKActions?: string[]; InsufficientDataActions?: string[]; ActionsEnabled?: boolean;
}

const ARN_RE = /^arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:.+/;

export function putMetricAlarm(ctx: Ctx, p: PutAlarmParams): void {
  return trailed(ctx, SRC, 'PutMetricAlarm', [{ type: 'AWS::CloudWatch::Alarm', name: p.AlarmName }], { alarmName: p.AlarmName }, () => {
    authorize(ctx, 'cloudwatch:PutMetricAlarm', alarmArn(ctx, p.AlarmName));
    if (!p.AlarmName) throw new AwsError('ValidationError', 'The parameter AlarmName is required.', 400);
    if (!p.MetricName || !p.Namespace) throw new AwsError('ValidationError', 'The parameters MetricName and Namespace are required.', 400);
    if (!(p.ComparisonOperator in OPERATORS)) throw new AwsError('ValidationError', `1 validation error detected: Value '${p.ComparisonOperator}' at 'comparisonOperator' failed to satisfy constraint: Member must satisfy enum value set: [GreaterThanOrEqualToThreshold, GreaterThanToThreshold, LessThanThreshold, LessThanOrEqualToThreshold]`, 400);
    if (p.Threshold === undefined || Number.isNaN(Number(p.Threshold))) throw new AwsError('ValidationError', 'The parameter Threshold is required.', 400);
    if (!p.EvaluationPeriods || p.EvaluationPeriods < 1) throw new AwsError('ValidationError', 'The parameter EvaluationPeriods is required.', 400);
    if (!p.Period || (p.Period < 60 && ![10, 30].includes(p.Period)) || (p.Period >= 60 && p.Period % 60 !== 0)) throw new AwsError('ValidationError', 'Period must be 10, 30 or a multiple of 60.', 400);
    const stat = p.Statistic ?? 'Average';
    if (!STATS.includes(stat)) throw new AwsError('ValidationError', `Invalid statistic: ${stat}`, 400);
    if (p.DatapointsToAlarm && p.DatapointsToAlarm > p.EvaluationPeriods) throw new AwsError('ValidationError', 'DatapointsToAlarm must be less than or equal to EvaluationPeriods', 400);
    const treat = (p.TreatMissingData ?? 'missing') as CwAlarm['treatMissing'];
    if (!['missing', 'notBreaching', 'breaching', 'ignore'].includes(treat)) throw new AwsError('ValidationError', `Invalid TreatMissingData: ${treat}`, 400);
    for (const arn of [...(p.AlarmActions ?? []), ...(p.OKActions ?? []), ...(p.InsufficientDataActions ?? [])]) if (!ARN_RE.test(arn)) throw new AwsError('ValidationError', `Invalid action ARN: ${arn}`, 400);
    const dims: Record<string, string> = {};
    for (const d of p.Dimensions ?? []) dims[d.Name] = d.Value;
    const prev = ctx.s.alarms.find((a) => a.name === p.AlarmName && a.region === ctx.region);
    const ts = nowIso();
    const a: CwAlarm = {
      name: p.AlarmName, arn: alarmArn(ctx, p.AlarmName), region: ctx.region, description: p.AlarmDescription, namespace: p.Namespace, metric: p.MetricName, dims, statistic: stat,
      period: p.Period, evalPeriods: p.EvaluationPeriods, datapointsToAlarm: p.DatapointsToAlarm, threshold: Number(p.Threshold), operator: p.ComparisonOperator, treatMissing: treat, unit: p.Unit,
      alarmActions: p.AlarmActions ?? [], okActions: p.OKActions ?? [], insufficientActions: p.InsufficientDataActions ?? [], actionsEnabled: p.ActionsEnabled ?? true,
      state: prev?.state ?? 'INSUFFICIENT_DATA', stateReason: prev?.stateReason ?? 'Unchecked: Initial alarm creation', stateUpdated: prev?.stateUpdated ?? ts, configUpdated: ts,
      history: [...(prev?.history ?? []), { ts, type: 'ConfigurationUpdate', summary: prev ? `Alarm "${p.AlarmName}" updated` : `Alarm "${p.AlarmName}" created`, data: JSON.stringify({ version: '1.0', type: prev ? 'Update' : 'Create' }) }],
    };
    if (prev) { ctx.s.alarms[ctx.s.alarms.indexOf(prev)] = a; settleCw(ctx.s); } else { a.holdUntil = now() + 10_000; ctx.s.alarms.push(a); }
  });
}

export function describeAlarms(ctx: Ctx, p: { AlarmNames?: string[]; AlarmNamePrefix?: string; StateValue?: string }): CwAlarm[] {
  return trailed(ctx, SRC, 'DescribeAlarms', [], p, () => {
    authorize(ctx, 'cloudwatch:DescribeAlarms', '*');
    settleCw(ctx.s);
    return ctx.s.alarms.filter((a) => a.region === ctx.region && (!p.AlarmNames?.length || p.AlarmNames.includes(a.name)) && (!p.AlarmNamePrefix || a.name.startsWith(p.AlarmNamePrefix)) && (!p.StateValue || a.state === p.StateValue));
  });
}

export function deleteAlarms(ctx: Ctx, p: { AlarmNames: string[] }): void {
  return trailed(ctx, SRC, 'DeleteAlarms', p.AlarmNames.map((n) => ({ type: 'AWS::CloudWatch::Alarm', name: n })), p, () => {
    authorize(ctx, 'cloudwatch:DeleteAlarms', '*');
    const missing = p.AlarmNames.filter((n) => !ctx.s.alarms.some((a) => a.name === n && a.region === ctx.region));
    if (missing.length) throw new AwsError('ResourceNotFound', `The alarms ${missing.join(', ')} do not exist`, 404);
    ctx.s.alarms = ctx.s.alarms.filter((a) => !(a.region === ctx.region && p.AlarmNames.includes(a.name)));
  });
}

export function setAlarmState(ctx: Ctx, p: { AlarmName: string; StateValue: string; StateReason: string }): void {
  return trailed(ctx, SRC, 'SetAlarmState', [{ type: 'AWS::CloudWatch::Alarm', name: p.AlarmName }], p, () => {
    authorize(ctx, 'cloudwatch:SetAlarmState', alarmArn(ctx, p.AlarmName));
    const a = ctx.s.alarms.find((x) => x.name === p.AlarmName && x.region === ctx.region);
    if (!a) throw new AwsError('ResourceNotFound', `Alarm ${p.AlarmName} does not exist`, 404);
    if (!['OK', 'ALARM', 'INSUFFICIENT_DATA'].includes(p.StateValue)) throw new AwsError('ValidationError', `1 validation error detected: Value '${p.StateValue}' at 'stateValue' failed to satisfy constraint: Member must satisfy enum value set: [INSUFFICIENT_DATA, ALARM, OK]`, 400);
    if (a.state !== p.StateValue) transition(ctx.s, a, p.StateValue as CwAlarm['state'], p.StateReason, true);
    else a.stateReason = p.StateReason;
    a.holdUntil = now() + 60_000;
  });
}

export function describeAlarmHistory(ctx: Ctx, p: { AlarmName?: string; HistoryItemType?: string }) {
  return trailed(ctx, SRC, 'DescribeAlarmHistory', [], p, () => {
    authorize(ctx, 'cloudwatch:DescribeAlarmHistory', '*');
    settleCw(ctx.s);
    const out: (CwAlarm['history'][number] & { name: string })[] = [];
    for (const a of ctx.s.alarms) if (a.region === ctx.region && (!p.AlarmName || a.name === p.AlarmName)) for (const h of a.history) if (!p.HistoryItemType || h.type === p.HistoryItemType) out.push({ ...h, name: a.name });
    return out.sort((x, y) => (x.ts < y.ts ? 1 : x.ts > y.ts ? -1 : 0));
  });
}

export function enableAlarmActions(ctx: Ctx, p: { AlarmNames: string[] }, on: boolean): void {
  return trailed(ctx, SRC, on ? 'EnableAlarmActions' : 'DisableAlarmActions', [], p, () => {
    authorize(ctx, on ? 'cloudwatch:EnableAlarmActions' : 'cloudwatch:DisableAlarmActions', '*');
    for (const n of p.AlarmNames) { const a = ctx.s.alarms.find((x) => x.name === n && x.region === ctx.region); if (a) a.actionsEnabled = on; }
  });
}

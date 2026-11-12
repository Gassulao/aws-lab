// CloudWatch Logs: grupos, flujos, eventos, patrones de filtro y filtros de métricas.
import type { LogEvent, LogGroup, LogStream } from '../types';
import { AwsError } from '../errors';
import { trailed, authorize, type Ctx } from '../api';
import { now, guid } from '../util';
import { emitMetric } from './cloudwatch';

const SRC = 'logs.amazonaws.com';
const DAY = 86_400_000;
export const RETENTION = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653];

const groupArn = (ctx: Ctx, n: string) => `arn:aws:logs:${ctx.region}:${ctx.s.account.id}:log-group:${n}`;
const notFound = (what: 'group' | 'stream') => new AwsError('ResourceNotFoundException', `The specified log ${what} does not exist.`, 400);

/** Aplica la retención: descarta eventos más antiguos que el periodo configurado. */
export function settleLogs(s: Ctx['s']) {
  const t = now();
  for (const g of s.logGroups) if (g.retention) for (const st of g.streams) st.events = st.events.filter((e) => e.ts >= t - g.retention! * DAY);
}

function group(ctx: Ctx, name: string): LogGroup {
  const g = ctx.s.logGroups.find((x) => x.name === name && x.region === ctx.region);
  if (!g) throw notFound('group');
  return g;
}
function stream(g: LogGroup, name: string): LogStream {
  const st = g.streams.find((x) => x.name === name);
  if (!st) throw notFound('stream');
  return st;
}

export function createLogGroup(ctx: Ctx, p: { LogGroupName: string; KmsKeyId?: string }): void {
  return trailed(ctx, SRC, 'CreateLogGroup', [{ type: 'AWS::Logs::LogGroup', name: p.LogGroupName }], { logGroupName: p.LogGroupName }, () => {
    authorize(ctx, 'logs:CreateLogGroup', groupArn(ctx, p.LogGroupName) + ':*');
    if (!/^[.\-_/#A-Za-z0-9]{1,512}$/.test(p.LogGroupName ?? '')) throw new AwsError('InvalidParameterException', `1 validation error detected: Value '${p.LogGroupName}' at 'logGroupName' failed to satisfy constraint: Member must satisfy regular expression pattern: [\\.\\-_/#A-Za-z0-9]+`, 400);
    if (ctx.s.logGroups.some((g) => g.name === p.LogGroupName && g.region === ctx.region)) throw new AwsError('ResourceAlreadyExistsException', 'The specified log group already exists', 400);
    ctx.s.logGroups.push({ name: p.LogGroupName, arn: groupArn(ctx, p.LogGroupName) + ':*', region: ctx.region, created: now(), kmsKeyId: p.KmsKeyId, streams: [], filters: [], tags: {} });
  });
}

export function deleteLogGroup(ctx: Ctx, p: { LogGroupName: string }): void {
  return trailed(ctx, SRC, 'DeleteLogGroup', [{ type: 'AWS::Logs::LogGroup', name: p.LogGroupName }], { logGroupName: p.LogGroupName }, () => {
    authorize(ctx, 'logs:DeleteLogGroup', groupArn(ctx, p.LogGroupName) + ':*');
    const g = group(ctx, p.LogGroupName);
    ctx.s.logGroups = ctx.s.logGroups.filter((x) => x !== g);
  });
}

export function describeLogGroups(ctx: Ctx, p: { LogGroupNamePrefix?: string; LogGroupNamePattern?: string }): LogGroup[] {
  return trailed(ctx, SRC, 'DescribeLogGroups', [], p, () => {
    authorize(ctx, 'logs:DescribeLogGroups', `arn:aws:logs:${ctx.region}:${ctx.s.account.id}:log-group::log-stream:`);
    settleLogs(ctx.s);
    return ctx.s.logGroups.filter((g) => g.region === ctx.region && (!p.LogGroupNamePrefix || g.name.startsWith(p.LogGroupNamePrefix)) && (!p.LogGroupNamePattern || g.name.includes(p.LogGroupNamePattern)));
  });
}

export function putRetentionPolicy(ctx: Ctx, p: { LogGroupName: string; RetentionInDays: number }): void {
  return trailed(ctx, SRC, 'PutRetentionPolicy', [{ type: 'AWS::Logs::LogGroup', name: p.LogGroupName }], p, () => {
    authorize(ctx, 'logs:PutRetentionPolicy', groupArn(ctx, p.LogGroupName) + ':*');
    const g = group(ctx, p.LogGroupName);
    const d = Number(p.RetentionInDays);
    if (!RETENTION.includes(d)) throw new AwsError('InvalidParameterException', `Invalid retention value. Allowed values: ${RETENTION.join(', ')}`, 400);
    g.retention = d;
  });
}
export function deleteRetentionPolicy(ctx: Ctx, p: { LogGroupName: string }): void {
  return trailed(ctx, SRC, 'DeleteRetentionPolicy', [{ type: 'AWS::Logs::LogGroup', name: p.LogGroupName }], p, () => {
    authorize(ctx, 'logs:DeleteRetentionPolicy', groupArn(ctx, p.LogGroupName) + ':*');
    group(ctx, p.LogGroupName).retention = undefined;
  });
}

export function createLogStream(ctx: Ctx, p: { LogGroupName: string; LogStreamName: string }): void {
  return trailed(ctx, SRC, 'CreateLogStream', [{ type: 'AWS::Logs::LogGroup', name: p.LogGroupName }], { logGroupName: p.LogGroupName, logStreamName: p.LogStreamName }, () => {
    authorize(ctx, 'logs:CreateLogStream', groupArn(ctx, p.LogGroupName) + ':log-stream:' + p.LogStreamName);
    const g = group(ctx, p.LogGroupName);
    if (!p.LogStreamName || /[:*]/.test(p.LogStreamName)) throw new AwsError('InvalidParameterException', 'The specified log stream name is not valid: it cannot be empty or contain ":" or "*".', 400);
    if (g.streams.some((x) => x.name === p.LogStreamName)) throw new AwsError('ResourceAlreadyExistsException', 'The specified log stream already exists', 400);
    g.streams.push({ name: p.LogStreamName, created: now(), events: [], seq: 0 });
  });
}

export function describeLogStreams(ctx: Ctx, p: { LogGroupName: string; LogStreamNamePrefix?: string }): LogStream[] {
  return trailed(ctx, SRC, 'DescribeLogStreams', [], p, () => {
    authorize(ctx, 'logs:DescribeLogStreams', groupArn(ctx, p.LogGroupName) + ':log-stream:*');
    settleLogs(ctx.s);
    return group(ctx, p.LogGroupName).streams.filter((x) => !p.LogStreamNamePrefix || x.name.startsWith(p.LogStreamNamePrefix));
  });
}

export function putLogEvents(ctx: Ctx, p: { LogGroupName: string; LogStreamName: string; LogEvents: { timestamp: number; message: string }[]; SequenceToken?: string }) {
  return trailed(ctx, SRC, 'PutLogEvents', [{ type: 'AWS::Logs::LogGroup', name: p.LogGroupName }], { logGroupName: p.LogGroupName, logStreamName: p.LogStreamName }, () => {
    authorize(ctx, 'logs:PutLogEvents', groupArn(ctx, p.LogGroupName) + ':log-stream:' + p.LogStreamName);
    const g = group(ctx, p.LogGroupName);
    const st = stream(g, p.LogStreamName);
    if (!p.LogEvents?.length) throw new AwsError('InvalidParameterException', '1 validation error detected: Value \'[]\' at \'logEvents\' failed to satisfy constraint: Member must have length greater than or equal to 1', 400);
    const t = now();
    for (const e of p.LogEvents) {
      if (e.timestamp > t + 2 * 3600_000) throw new AwsError('InvalidParameterException', 'Log event timestamp is too far in the future (more than 2 hours).', 400);
      if (g.retention && e.timestamp < t - g.retention * DAY) throw new AwsError('InvalidParameterException', 'Log event is older than the retention period of the log group.', 400);
    }
    let rejected = false;
    for (const e of p.LogEvents) {
      const ev: LogEvent = { ts: e.timestamp, message: e.message, ingestion: t };
      st.events.push(ev);
      for (const f of g.filters) if (matches(f.pattern, e.message)) emitMetric(ctx.s, f.ns, f.metric, f.value === '1' || Number.isNaN(Number(f.value)) ? 1 : Number(f.value), e.timestamp);
    }
    st.events.sort((a, b) => a.ts - b.ts);
    st.seq++;
    void rejected;
    return { nextSequenceToken: `49${String(Date.parse('2020-01-01') + st.seq).padStart(20, '0')}${st.name.length}` };
  });
}

function parseTerms(pattern: string): { any: string[][]; all: string[]; not: string[] } {
  const toks = (pattern.match(/"[^"]*"|\S+/g) ?? []);
  const out = { any: [] as string[][], all: [] as string[], not: [] as string[] };
  const anyG: string[] = [];
  for (const t of toks) {
    const clean = (x: string) => x.replace(/^"|"$/g, '');
    if (t.startsWith('?')) anyG.push(clean(t.slice(1)));
    else if (t.startsWith('-')) out.not.push(clean(t.slice(1)));
    else out.all.push(clean(t));
  }
  if (anyG.length) out.any.push(anyG);
  return out;
}

function jsonMatch(pattern: string, message: string): boolean {
  let obj: any;
  try { obj = JSON.parse(message); } catch { return false; }
  const body = pattern.trim().replace(/^\{/, '').replace(/\}$/, '').trim();
  return body.split(/\s*&&\s*/).every((cond) => {
    const m = cond.match(/^\$\.([\w.]+)\s*(=|!=|>=|<=|>|<)\s*("?)(.*?)\3$/);
    if (!m) throw new AwsError('InvalidParameterException', `Invalid character(s) in term '${cond}'`, 400);
    let v: any = obj;
    for (const k of m[1].split('.')) v = v?.[k];
    if (v === undefined) return false;
    const rhs = m[4];
    const numeric = !m[3] && rhs !== '' && !Number.isNaN(Number(rhs));
    const a: any = numeric ? Number(v) : String(v), b: any = numeric ? Number(rhs) : rhs;
    switch (m[2]) { case '=': return rhs === '*' ? true : a === b; case '!=': return a !== b; case '>': return a > b; case '<': return a < b; case '>=': return a >= b; default: return a <= b; }
  });
}

export function matches(pattern: string, message: string): boolean {
  const p = (pattern ?? '').trim();
  if (!p) return true;
  if (p.startsWith('{')) return jsonMatch(p, message);
  const t = parseTerms(p);
  return t.all.every((x) => message.includes(x)) && t.not.every((x) => !message.includes(x)) && t.any.every((g) => g.some((x) => message.includes(x)));
}

export function getLogEvents(ctx: Ctx, p: { LogGroupName: string; LogStreamName: string; StartTime?: number; EndTime?: number; Limit?: number; StartFromHead?: boolean }) {
  return trailed(ctx, SRC, 'GetLogEvents', [], p, () => {
    authorize(ctx, 'logs:GetLogEvents', groupArn(ctx, p.LogGroupName) + ':log-stream:' + p.LogStreamName);
    settleLogs(ctx.s);
    const st = stream(group(ctx, p.LogGroupName), p.LogStreamName);
    let ev = st.events.filter((e) => (p.StartTime === undefined || e.ts >= p.StartTime) && (p.EndTime === undefined || e.ts < p.EndTime));
    const lim = p.Limit ?? 10000;
    if (ev.length > lim) ev = p.StartFromHead ? ev.slice(0, lim) : ev.slice(-lim);
    return ev;
  });
}

export function filterLogEvents(ctx: Ctx, p: { LogGroupName: string; LogStreamNames?: string[]; FilterPattern?: string; StartTime?: number; EndTime?: number; Limit?: number }) {
  return trailed(ctx, SRC, 'FilterLogEvents', [], p, () => {
    authorize(ctx, 'logs:FilterLogEvents', groupArn(ctx, p.LogGroupName) + ':*');
    settleLogs(ctx.s);
    const g = group(ctx, p.LogGroupName);
    const out: (LogEvent & { stream: string; id: string })[] = [];
    for (const st of g.streams) {
      if (p.LogStreamNames?.length && !p.LogStreamNames.includes(st.name)) continue;
      for (const e of st.events) if ((p.StartTime === undefined || e.ts >= p.StartTime) && (p.EndTime === undefined || e.ts < p.EndTime) && matches(p.FilterPattern ?? '', e.message)) out.push({ ...e, stream: st.name, id: guid().replace(/-/g, '') });
    }
    out.sort((a, b) => a.ts - b.ts);
    return { events: p.Limit ? out.slice(0, p.Limit) : out, streams: g.streams.map((x) => x.name) };
  });
}

export function putMetricFilter(ctx: Ctx, p: { LogGroupName: string; FilterName: string; FilterPattern: string; MetricTransformations: { metricName: string; metricNamespace: string; metricValue: string }[] }): void {
  return trailed(ctx, SRC, 'PutMetricFilter', [{ type: 'AWS::Logs::LogGroup', name: p.LogGroupName }], { logGroupName: p.LogGroupName, filterName: p.FilterName }, () => {
    authorize(ctx, 'logs:PutMetricFilter', groupArn(ctx, p.LogGroupName) + ':*');
    const g = group(ctx, p.LogGroupName);
    const m = p.MetricTransformations?.[0];
    if (!m || !m.metricName || !m.metricNamespace) throw new AwsError('InvalidParameterException', 'metricTransformations with metricName, metricNamespace and metricValue are required.', 400);
    try { matches(p.FilterPattern ?? '', '{}'); } catch (e) { throw e; }
    g.filters = g.filters.filter((f) => f.name !== p.FilterName);
    g.filters.push({ name: p.FilterName, pattern: p.FilterPattern ?? '', ns: m.metricNamespace, metric: m.metricName, value: String(m.metricValue ?? '1'), created: now() });
  });
}
export function describeMetricFilters(ctx: Ctx, p: { LogGroupName?: string; FilterNamePrefix?: string }) {
  return trailed(ctx, SRC, 'DescribeMetricFilters', [], p, () => {
    authorize(ctx, 'logs:DescribeMetricFilters', `arn:aws:logs:${ctx.region}:${ctx.s.account.id}:log-group::log-stream:`);
    if (p.LogGroupName) group(ctx, p.LogGroupName);
    return ctx.s.logGroups.filter((g) => g.region === ctx.region && (!p.LogGroupName || g.name === p.LogGroupName)).flatMap((g) => g.filters.filter((f) => !p.FilterNamePrefix || f.name.startsWith(p.FilterNamePrefix)).map((f) => ({ g, f })));
  });
}
export function deleteMetricFilter(ctx: Ctx, p: { LogGroupName: string; FilterName: string }): void {
  return trailed(ctx, SRC, 'DeleteMetricFilter', [{ type: 'AWS::Logs::LogGroup', name: p.LogGroupName }], p, () => {
    authorize(ctx, 'logs:DeleteMetricFilter', groupArn(ctx, p.LogGroupName) + ':*');
    const g = group(ctx, p.LogGroupName);
    if (!g.filters.some((f) => f.name === p.FilterName)) throw new AwsError('ResourceNotFoundException', 'The specified metric filter does not exist.', 400);
    g.filters = g.filters.filter((f) => f.name !== p.FilterName);
  });
}

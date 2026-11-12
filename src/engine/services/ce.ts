// AWS Cost Explorer (ce): coste y uso por día o mes, agrupación por servicio, filtros y previsión.
import { AwsError } from '../errors';
import { authorize, trailed, type Ctx } from '../api';
import { now } from '../util';
import { settle } from './ec2';
import { amount, burnPerHour, fmtDay, startOfDay, startOfMonth, startOfNextMonth, usageBetween, type UsageLine } from './costs';

const SRC = 'ce.amazonaws.com';
const DAY = 86_400_000;
const COST_METRICS = ['BlendedCost', 'UnblendedCost', 'AmortizedCost', 'NetUnblendedCost', 'NetAmortizedCost'];

const parseDay = (v: string, what: string): number => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v ?? '')) throw new AwsError('ValidationException', `${what} date (${v}) is not valid. Dates must be formatted as YYYY-MM-DD.`, 400);
  const t = Date.parse(v + 'T00:00:00Z');
  if (Number.isNaN(t)) throw new AwsError('ValidationException', `${what} date (${v}) is not valid. Dates must be formatted as YYYY-MM-DD.`, 400);
  return t;
};

interface Expr { Dimensions?: { Key: string; Values: string[] }; And?: Expr[]; Or?: Expr[]; Not?: Expr; Tags?: unknown; CostCategories?: unknown }

function matches(e: Expr, l: { service: string }, acct: string): boolean {
  if (e.And) return e.And.every((x) => matches(x, l, acct));
  if (e.Or) return e.Or.some((x) => matches(x, l, acct));
  if (e.Not) return !matches(e.Not, l, acct);
  if (e.Dimensions) {
    const { Key, Values } = e.Dimensions;
    if (Key === 'SERVICE') return Values.includes(l.service);
    if (Key === 'LINKED_ACCOUNT') return Values.includes(acct);
    if (Key === 'REGION') return true;
    throw new AwsError('ValidationException', `Este simulador no admite filtrar por la dimensión ${Key} (admite SERVICE y LINKED_ACCOUNT).`, 400);
  }
  if (e.Tags || e.CostCategories) throw new AwsError('ValidationException', 'Este simulador no admite filtros por etiquetas ni categorías de coste.', 400);
  throw new AwsError('ValidationException', 'Filter must contain exactly one of: Dimensions, Tags, CostCategories, Not, And, Or.', 400);
}

function pad(lines: UsageLine[], f: Expr | undefined, acct: string) {
  return f ? lines.filter((l) => matches(f, l, acct)) : lines;
}

export interface CeGroup { keys: string[]; usd: number; qty: number; unit: string }
export interface CePeriod { start: string; end: string; usd: number; qty: number; unit: string; groups: CeGroup[] }

export function getCostAndUsage(ctx: Ctx, p: { TimePeriod: { Start: string; End: string }; Granularity: string; Metrics: string[]; GroupBy?: { Type: string; Key: string }[]; Filter?: Expr }): { periods: CePeriod[]; metrics: string[]; groupBy: { Type: string; Key: string }[] } {
  return trailed(ctx, SRC, 'GetCostAndUsage', [], { TimePeriod: p.TimePeriod, Granularity: p.Granularity, Metrics: p.Metrics }, () => {
    authorize(ctx, 'ce:GetCostAndUsage', '*');
    if (!p.TimePeriod) throw new AwsError('ValidationException', 'TimePeriod is required.', 400);
    const from = parseDay(p.TimePeriod.Start, 'Start');
    const to = parseDay(p.TimePeriod.End, 'End');
    if (to <= from) throw new AwsError('ValidationException', `Start date (${p.TimePeriod.Start}) must be before end date (${p.TimePeriod.End}).`, 400);
    if (!['DAILY', 'MONTHLY'].includes(p.Granularity)) throw new AwsError('ValidationException', `Granularity ${p.Granularity} no está disponible en este simulador (admite DAILY y MONTHLY).`, 400);
    if (!p.Metrics?.length) throw new AwsError('ValidationException', 'Metrics is required.', 400);
    for (const m of p.Metrics) if (![...COST_METRICS, 'UsageQuantity'].includes(m)) throw new AwsError('ValidationException', `Metric ${m} is not valid. Valid metrics: ${[...COST_METRICS, 'UsageQuantity'].join(', ')}.`, 400);
    const gb = p.GroupBy ?? [];
    if (gb.length > 2) throw new AwsError('ValidationException', 'GroupBy admite como máximo dos criterios.', 400);
    for (const g of gb) if (g.Type !== 'DIMENSION' || !['SERVICE', 'LINKED_ACCOUNT'].includes(g.Key)) throw new AwsError('ValidationException', `Este simulador solo admite GroupBy Type=DIMENSION con Key=SERVICE o LINKED_ACCOUNT.`, 400);
    settle(ctx.s);
    const acct = ctx.s.account.id;
    const periods: CePeriod[] = [];
    for (let a = from; a < to; ) {
      const b = p.Granularity === 'DAILY' ? a + DAY : Math.min(startOfNextMonth(a), to);
      const lines = pad(usageBetween(ctx.s, a, b), p.Filter, acct);
      const groups: CeGroup[] = [];
      if (gb.length) {
        const map = new Map<string, CeGroup>();
        for (const l of lines) {
          const keys = gb.map((g) => (g.Key === 'SERVICE' ? l.service : acct));
          const k = keys.join('|');
          const cur = map.get(k) ?? { keys, usd: 0, qty: 0, unit: l.unit };
          cur.usd += l.usd;
          cur.qty += l.qty;
          if (cur.unit !== l.unit) cur.unit = 'N/A';
          map.set(k, cur);
        }
        groups.push(...[...map.values()].sort((x, y) => x.keys.join().localeCompare(y.keys.join())));
      }
      const qUnit = lines.length && lines.every((l) => l.unit === lines[0].unit) ? lines[0].unit : 'N/A';
      periods.push({ start: fmtDay(a), end: fmtDay(b), usd: lines.reduce((x, l) => x + l.usd, 0), qty: lines.reduce((x, l) => x + l.qty, 0), unit: qUnit, groups });
      a = b;
    }
    return { periods, metrics: p.Metrics, groupBy: gb };
  });
}

export function getDimensionValues(ctx: Ctx, p: { TimePeriod: { Start: string; End: string }; Dimension: string }): string[] {
  return trailed(ctx, SRC, 'GetDimensionValues', [], p, () => {
    authorize(ctx, 'ce:GetDimensionValues', '*');
    const from = parseDay(p.TimePeriod?.Start, 'Start');
    const to = parseDay(p.TimePeriod?.End, 'End');
    if (to <= from) throw new AwsError('ValidationException', 'Start date must be before end date.', 400);
    if (p.Dimension === 'LINKED_ACCOUNT') return [ctx.s.account.id];
    if (p.Dimension !== 'SERVICE') throw new AwsError('ValidationException', 'Este simulador solo admite Dimension=SERVICE o LINKED_ACCOUNT.', 400);
    settle(ctx.s);
    return usageBetween(ctx.s, from, to).map((l) => l.service);
  });
}

export function getCostForecast(ctx: Ctx, p: { TimePeriod: { Start: string; End: string }; Metric: string; Granularity: string }): { total: number; periods: { start: string; end: string; mean: number }[] } {
  return trailed(ctx, SRC, 'GetCostForecast', [], p, () => {
    authorize(ctx, 'ce:GetCostForecast', '*');
    const from = parseDay(p.TimePeriod?.Start, 'Start');
    const to = parseDay(p.TimePeriod?.End, 'End');
    const today = startOfDay(now());
    if (from < today) throw new AwsError('DataUnavailableException', 'Start date for the forecast must be today or in the future.', 400);
    if (to <= from) throw new AwsError('ValidationException', 'Start date must be before end date.', 400);
    if (!['DAILY', 'MONTHLY'].includes(p.Granularity)) throw new AwsError('ValidationException', `Granularity ${p.Granularity} no está disponible en este simulador.`, 400);
    if (!['BLENDED_COST', 'UNBLENDED_COST', 'AMORTIZED_COST', 'NET_UNBLENDED_COST', 'NET_AMORTIZED_COST', 'USAGE_QUANTITY'].includes(p.Metric)) throw new AwsError('ValidationException', `Metric ${p.Metric} is not valid.`, 400);
    settle(ctx.s);
    const perMs = burnPerHour(ctx.s) / 3.6e6;
    const periods: { start: string; end: string; mean: number }[] = [];
    for (let a = from; a < to; ) {
      const b = p.Granularity === 'DAILY' ? a + DAY : Math.min(startOfNextMonth(a), to);
      periods.push({ start: fmtDay(a), end: fmtDay(b), mean: perMs * Math.max(0, b - Math.max(a, now())) });
      a = b;
    }
    return { total: periods.reduce((x, y) => x + y.mean, 0), periods };
  });
}

export { amount, startOfMonth };

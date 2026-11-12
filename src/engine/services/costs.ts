// Uso y coste por servicio y por periodo. Coherente con estimateCost (src/ui/pages/home/cost.ts): la suma de todos los periodos
// desde el origen hasta ahora es exactamente el coste acumulado de la cuenta.
import { INSTANCE_TYPES, NAT_HOURLY, PUBLIC_IPV4_HOURLY, EBS_PRICE_GB_MONTH, HOURS_PER_MONTH } from '../catalog';
import type { CloudState } from '../types';
import { now } from '../util';

const H = 3.6e6;
const ALB_HOURLY = 0.0225;
const R53_ZONE_MONTH = 0.5;

export const SVC_EC2 = 'Amazon Elastic Compute Cloud - Compute';
export const SVC_EC2_OTHER = 'EC2 - Other';
export const SVC_VPC = 'Amazon Virtual Private Cloud';
export const SVC_ELB = 'Amazon Elastic Load Balancing';
export const SVC_R53 = 'Amazon Route 53';

export interface UsageLine { service: string; usd: number; qty: number; unit: string }

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** Coste y cantidad de uso por servicio entre dos instantes (ms), limitado a «ahora». */
export function usageBetween(s: CloudState, from: number, to: number): UsageLine[] {
  const t = now();
  const end = Math.min(to, t);
  const acc = new Map<string, UsageLine>();
  const add = (service: string, usd: number, qty: number, unit: string) => {
    const cur = acc.get(service) ?? { service, usd: 0, qty: 0, unit };
    cur.usd += usd;
    cur.qty += qty;
    if (cur.unit !== unit) cur.unit = 'N/A';
    acc.set(service, cur);
  };
  if (end <= from) return [];
  for (const i of s.instances) {
    const price = INSTANCE_TYPES[i.type]?.hourly ?? 0;
    const periods = [...(i.runPeriods ?? []), ...(i.state === 'running' && i.runningSince ? [{ from: i.runningSince, to: t }] : [])];
    const hours = periods.reduce((a, p) => a + overlap(p.from, p.to, from, end), 0) / H;
    if (!hours) continue;
    add(SVC_EC2, price * hours, hours, 'Hrs');
    if (i.publicIp) add(SVC_VPC, PUBLIC_IPV4_HOURLY * hours, hours, 'Hrs');
  }
  for (const n of s.natGateways) {
    if (n.state === 'deleted') continue;
    const hours = overlap(new Date(n.createdAt).getTime(), t, from, end) / H;
    if (hours) add(SVC_EC2_OTHER, NAT_HOURLY * hours, hours, 'Hrs');
  }
  for (const l of s.loadBalancers) {
    const hours = overlap(new Date(l.createdAt).getTime(), t, from, end) / H;
    if (hours) add(SVC_ELB, ALB_HOURLY * hours, hours, 'Hrs');
  }
  for (const z of s.zones) {
    const hours = overlap(new Date(z.createdAt).getTime(), t, from, end) / H;
    if (hours) add(SVC_R53, (R53_ZONE_MONTH * hours) / HOURS_PER_MONTH, hours / HOURS_PER_MONTH, 'N/A');
  }
  for (const v of s.volumes) {
    const hours = overlap(new Date(v.createdAt).getTime(), t, from, end) / H;
    if (hours) add(SVC_EC2_OTHER, (v.sizeGiB * (EBS_PRICE_GB_MONTH[v.type] ?? 0) * hours) / HOURS_PER_MONTH, (v.sizeGiB * hours) / HOURS_PER_MONTH, 'GB-Mo');
  }
  return [...acc.values()].sort((a, b) => a.service.localeCompare(b.service));
}

export const totalUsd = (l: UsageLine[]) => l.reduce((a, x) => a + x.usd, 0);

export const startOfMonth = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
export const startOfNextMonth = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };
export const startOfDay = (ms: number) => ms - (((ms % 86_400_000) + 86_400_000) % 86_400_000);

/** Gasto por hora actual si todo sigue encendido (instancias, IP, NAT, ALB) más lo prorrateado de EBS y Route 53. */
export function burnPerHour(s: CloudState): number {
  let h = 0;
  for (const i of s.instances) if (i.state === 'running') h += (INSTANCE_TYPES[i.type]?.hourly ?? 0) + (i.publicIp ? PUBLIC_IPV4_HOURLY : 0);
  for (const n of s.natGateways) if (n.state !== 'deleted') h += NAT_HOURLY;
  h += s.loadBalancers.length * ALB_HOURLY;
  h += (s.zones.length * R53_ZONE_MONTH) / HOURS_PER_MONTH;
  h += s.volumes.reduce((a, v) => a + (v.sizeGiB * (EBS_PRICE_GB_MONTH[v.type] ?? 0)) / HOURS_PER_MONTH, 0);
  return h;
}

/** Gasto acumulado en el mes en curso y previsión a fin de mes. */
export function monthSpend(s: CloudState, t = now()) {
  const actual = totalUsd(usageBetween(s, startOfMonth(t), t));
  const remaining = Math.max(0, startOfNextMonth(t) - t) / H;
  return { actual, forecast: actual + burnPerHour(s) * remaining };
}

export const fmtDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Importe como lo devuelve la API: cadena decimal sin notación científica. */
export function amount(n: number): string {
  const v = Math.abs(n) < 1e-10 ? 0 : n;
  return v.toFixed(10).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') || '0';
}

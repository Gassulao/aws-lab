// Coste estimado de la cuenta simulada a partir de los campos del motor (billedMs, runningSince, createdAt…).
import { INSTANCE_TYPES, NAT_HOURLY, PUBLIC_IPV4_HOURLY, EBS_PRICE_GB_MONTH, HOURS_PER_MONTH } from '../../../engine/catalog';
import type { CloudState } from '../../../engine/types';
import { now as engineNow } from '../../../engine/util';

const H = 3.6e6;
export interface CostLine { label: string; usd: number }
export interface CostSummary {
  lines: CostLine[];
  total: number;
  /** Gasto por hora si todo lo que corre sigue encendido. */
  hourly: number;
  /** Previsión mensual (730 h) con los recursos actuales. */
  monthly: number;
  running: number;
}

export function estimateCost(s: CloudState, now = engineNow()): CostSummary {
  let ec2 = 0, ip = 0, hourly = 0, running = 0;
  for (const i of s.instances) {
    const price = INSTANCE_TYPES[i.type]?.hourly ?? 0;
    const live = i.state === 'running' && i.runningSince ? Math.max(0, now - i.runningSince) : 0;
    ec2 += (price * (i.billedMs + live)) / H;
    if (i.publicIp) ip += (PUBLIC_IPV4_HOURLY * (i.billedMs + live)) / H;
    if (i.state === 'running') {
      running++;
      hourly += price + (i.publicIp ? PUBLIC_IPV4_HOURLY : 0);
    }
  }
  let nat = 0;
  for (const n of s.natGateways) {
    if (n.state === 'deleted') continue;
    nat += (NAT_HOURLY * Math.max(0, now - new Date(n.createdAt).getTime())) / H;
    hourly += NAT_HOURLY;
  }
  // Application Load Balancer: 0,0225 USD por hora (más las LCU, que el simulador no mide).
  const ALB_HOURLY = 0.0225;
  let alb = 0;
  for (const l of s.loadBalancers) { alb += (ALB_HOURLY * Math.max(0, now - new Date(l.createdAt).getTime())) / H; hourly += ALB_HOURLY; }
  // Route 53: 0,50 USD por zona alojada y mes.
  const r53Monthly = s.zones.length * 0.5;
  const r53 = s.zones.reduce((a, z) => a + (0.5 * Math.max(0, now - new Date(z.createdAt).getTime())) / H / HOURS_PER_MONTH, 0);
  const ebsMonthly = s.volumes.reduce((a, v) => a + v.sizeGiB * (EBS_PRICE_GB_MONTH[v.type] ?? 0), 0);
  const ebs = s.volumes.reduce((a, v) => a + (v.sizeGiB * (EBS_PRICE_GB_MONTH[v.type] ?? 0) * Math.max(0, now - new Date(v.createdAt).getTime())) / H / HOURS_PER_MONTH, 0);
  const lines: CostLine[] = [
    { label: 'EC2 - Instancias', usd: ec2 },
    { label: 'EC2 - Volúmenes EBS', usd: ebs },
    { label: 'VPC - Gateways NAT', usd: nat },
    { label: 'VPC - Direcciones IPv4 públicas', usd: ip },
    ...(alb ? [{ label: 'Elastic Load Balancing', usd: alb }] : []),
    ...(r53 ? [{ label: 'Route 53 - Zonas alojadas', usd: r53 }] : []),
  ];
  return { lines, total: lines.reduce((a, l) => a + l.usd, 0), hourly, monthly: hourly * HOURS_PER_MONTH + ebsMonthly + r53Monthly, running };
}

export const usd = (n: number) => '$' + n.toLocaleString('es-ES', { minimumFractionDigits: n < 1 ? 4 : 2, maximumFractionDigits: n < 1 ? 4 : 2 });

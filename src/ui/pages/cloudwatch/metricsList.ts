import type { CloudState } from '../../../engine/types';
import { EC2_METRICS } from '../../../engine/services/cloudwatch';

export interface MetricRef { key: string; ns: string; name: string; dims: Record<string, string>; unit?: string }

/** Métricas visibles en la consola: personalizadas con datos y las de EC2 de instancias que han llegado a correr. */
export function listMetricsRaw(s: CloudState): MetricRef[] {
  const out = new Map<string, MetricRef>();
  for (const m of s.metricData) { const key = `${m.ns}|${m.name}|${JSON.stringify(m.dims)}`; out.set(key, { key, ns: m.ns, name: m.name, dims: m.dims, unit: m.unit }); }
  for (const i of s.instances) if (i.state !== 'terminated' && (i.runPeriods?.length || i.runningSince)) for (const [name, unit] of Object.entries(EC2_METRICS)) { const key = `AWS/EC2|${name}|{"InstanceId":"${i.id}"}`; out.set(key, { key, ns: 'AWS/EC2', name, dims: { InstanceId: i.id }, unit }); }
  return [...out.values()];
}

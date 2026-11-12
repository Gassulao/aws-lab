import React, { useEffect, useState } from 'react';
import { useCloud } from '../../session';
import { Flash, Status, nav, type Tone } from '../../components/ui';
import type { CloudState } from '../../../engine/types';
import { settleEcr } from '../../../engine/services/ecr';
import { settleEcs } from '../../../engine/services/ecs';
import { settleEks } from '../../../engine/services/eks';
import { cs } from '../../../engine/services/containerCore';
import { settle } from '../../../engine/services/ec2';
import './containers.css';

/** Estado de la nube con los ciclos de vida de contenedores al día; se refresca cada segundo. */
export function useContainers(): { s: CloudState; c: ReturnType<typeof cs> } {
  const s = useCloud();
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  settle(s); settleEcr(s); settleEcs(s); settleEks(s);
  return { s, c: cs(s) };
}

export const TONES: Record<string, Tone> = {
  ACTIVE: 'ok', RUNNING: 'ok', COMPLETED: 'ok', COMPLETE: 'ok', CREATING: 'load', PENDING: 'load', PROVISIONING: 'load', IN_PROGRESS: 'load', UPDATING: 'load', DEPROVISIONING: 'load', DELETING: 'load', DRAINING: 'warn',
  STOPPED: 'warn', INACTIVE: 'warn', FAILED: 'err', CREATE_FAILED: 'err',
};
export const St = ({ v }: { v: string }) => <Status tone={TONES[v] ?? ''}>{v}</Status>;
export const link = (to: string, label: React.ReactNode) => <a onClick={() => nav(to)}>{label}</a>;
export const enc = encodeURIComponent;
export const when = (ms?: number) => (ms ? new Date(ms).toLocaleString('es-ES') : '-');
export const bytes = (n: number) => (n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : (n / 1e6).toFixed(1) + ' MB');
export const short = (arn: string) => arn.split('/').pop() ?? arn;

export function Tabs<T extends string>({ tabs, cur, onChange }: { tabs: [T, string][]; cur: T; onChange: (t: T) => void }) {
  return <div className="ct-tabs" role="tablist">{tabs.map(([k, l]) => <a key={k} role="tab" aria-selected={cur === k} className={cur === k ? 'on' : ''} onClick={() => onChange(k)}>{l}</a>)}</div>;
}
export const NotFound = ({ what }: { what: string }) => <Flash kind="err" title="No encontrado">{what}</Flash>;

/** Subredes, SG y VPC por defecto para los asistentes. */
export function networkDefaults(s: CloudState) {
  const vpc = s.vpcs.find((v) => v.isDefault && v.region === s.region) ?? s.vpcs.find((v) => v.region === s.region);
  const subnets = s.subnets.filter((x) => x.vpcId === vpc?.id && x.region === s.region).map((x) => x.id);
  return { vpc, subnets, sg: vpc?.defaultSecurityGroupId };
}

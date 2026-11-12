import React, { useEffect, useState } from 'react';
import { Status, type Tone } from '../../components/ui';
import { settleCicd } from '../../../engine/services/codepipeline';
import { useCloud } from '../../session';
import type { CloudState } from '../../../engine/types';

export const toneOf = (s?: string): Tone =>
  /^(Succeeded|SUCCEEDED|Approved|MERGED|Ready)$/.test(s ?? '') ? 'ok'
    : /^(Failed|FAILED|FAULT|TIMED_OUT|Rejected|Stopped|STOPPED|Abandoned|Cancelled)$/.test(s ?? '') ? 'err'
      : /^(InProgress|IN_PROGRESS|Queued|Created|Stopping|OPEN|Pending)$/.test(s ?? '') ? 'load' : '';
export const Badge = ({ s }: { s?: string }) => <Status tone={toneOf(s)}>{s || 'Sin ejecutar'}</Status>;

/** Estado de la nube con la simulación de CI/CD al día; se refresca cada segundo. */
export function useCicd(): CloudState {
  const s = useCloud();
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  settleCicd(s);
  return s;
}

export const ts = (ms?: number) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '–');
export const ctxOf = (s: CloudState) => ({ s, caller: { type: 'Root' as const, arn: s.me.arn, userName: s.me.userName, mfa: false, sourceIp: '' }, region: s.region });

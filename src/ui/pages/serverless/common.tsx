import React, { useEffect, useState } from 'react';
import { useCloud, getShell } from '../../session';
import { Flash, Status, nav, type Tone } from '../../components/ui';
import type { CloudState } from '../../../engine/types';
import { settleSv } from '../../../engine/serverless';
import './serverless.css';

/** Estado de la nube con el paso del tiempo aplicado (colas, mapeos de Lambda, RDS); se refresca cada segundo. */
export function useSvc(): CloudState {
  const s = useCloud();
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  settleSv(s);
  return s;
}

export const TONES: Record<string, Tone> = {
  Active: 'ok', ACTIVE: 'ok', available: 'ok', Enabled: 'ok', Successful: 'ok', Pending: 'load', CREATING: 'load', creating: 'load', modifying: 'load', rebooting: 'load', 'backing-up': 'load', starting: 'load', stopping: 'load', deleting: 'load',
  stopped: 'warn', Disabled: 'warn', failed: 'err', Failed: 'err',
};
export const St = ({ v }: { v: string }) => <Status tone={TONES[v] ?? ''}>{v}</Status>;
export const link = (to: string, label: React.ReactNode) => <a onClick={() => nav(to)}>{label}</a>;
export const enc = encodeURIComponent;
export const when = (ms?: number) => (ms ? new Date(ms).toLocaleString('es-ES') : '-');
export const NotFound = ({ what }: { what: string }) => <Flash kind="err" title="No encontrado">{what}</Flash>;

export function Tabs<T extends string>({ tabs, cur, onChange }: { tabs: [T, string][]; cur: T; onChange: (t: T) => void }) {
  return <div className="sv-tabs" role="tablist">{tabs.map(([k, l]) => <a key={k} role="tab" aria-selected={cur === k} className={cur === k ? 'on' : ''} onClick={() => onChange(k)}>{l}</a>)}</div>;
}

/** Guarda un fichero en el sistema de archivos del shell y devuelve su ruta. */
export function putFile(name: string, content: string): string {
  const path = `/tmp/ui/${name}`;
  const fs = getShell().fs;
  fs.mkdir(path.slice(0, path.lastIndexOf('/')), true);
  fs.writeFile(path, content);
  return path;
}
export const readFile = (path: string): string => { try { return getShell().fs.readFile(path); } catch { return ''; } };
export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export const roleName = (arn: string) => arn.split('/').pop() ?? arn;
export const parseArnName = (arn: string) => arn.split(':').pop() ?? arn;

export const DEFAULT_CODE = `exports.handler = async (event) => {
  console.log('Evento recibido:', JSON.stringify(event));
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mensaje: 'Hola desde Lambda', recibido: event }),
  };
};
`;

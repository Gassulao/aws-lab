// Ayudas comunes de los comandos de Lambda, API Gateway, SQS, RDS y DynamoDB.
import type { Params } from '../framework';
import type { Ctx } from '../../../engine/api';
import { settleSv } from '../../../engine/serverless';
import { speedFactor } from '../../../engine/store';
import { BIN } from '../framework';

export const need = (p: Params, key: string, opt: string) => {
  if (p[key] === undefined) throw new Error(`aws: error: the following arguments are required: --${opt}`);
  return p[key];
};
export const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
export const bool = (v: unknown) => (v === undefined ? undefined : v === true || v === 'true');
export const arr = (v: any): any[] => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).flat());
/** 2024-01-01T00:00:00.123000+00:00 */
export const microIso = (ms: number) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000+00:00');
/** 2024-01-01T00:00:00+00:00 */
export const secIso = (v: string | number) => new Date(v).toISOString().replace(/\.\d{3}Z$/, '+00:00');
export const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
export const tagsOut = (t: Record<string, string>) => Object.entries(t).map(([Key, Value]) => ({ Key, Value }));
export const tagsIn = (v: any): { Key: string; Value: string }[] => arr(v).map((t) => ({ Key: t.Key, Value: t.Value }));

/** Texto de un argumento binario: base64 por defecto o texto crudo con --cli-binary-format raw-in-base64-out (como AWS CLI v2). */
export function binaryIn(p: Params, v: unknown): string {
  const s = String(v ?? '');
  if (s.startsWith(BIN)) return s.slice(BIN.length);
  if (p.CliBinaryFormat === 'raw-in-base64-out') return s;
  if (s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s)) { try { return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))); } catch { /* error abajo */ } }
  throw new Error(`Invalid base64: "${s}"`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Espera de `aws <servicio> wait ...`: reevalúa el paso del tiempo cada 500 ms hasta 150 s (inmediato en modo instantáneo). */
export async function waitFor(c: Ctx, what: string, ok: () => boolean, hardFail?: () => string | undefined): Promise<void> {
  const limit = Date.now() + (speedFactor() === 0 ? 0 : 150_000);
  for (;;) {
    settleSv(c.s);
    const bad = hardFail?.();
    if (bad) throw new Error(`\nWaiter ${what} failed: ${bad}`);
    if (ok()) return;
    if (Date.now() >= limit) throw new Error(`\nWaiter ${what} failed: Max attempts exceeded`);
    await sleep(500);
  }
}

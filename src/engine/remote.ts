// Sincronización con el servidor (Docker): al arrancar carga el estado guardado y después lo sube con cada cambio.
// Si no hay servidor (modo desarrollo con Vite), no hace nada y se queda localStorage.
import { getState, replaceState, subscribe, SCHEMA_VERSION } from './store';
import type { CloudState } from './types';

export interface RemoteBlob {
  schema: number;
  cloud: CloudState;
  progress?: unknown;
}

let active = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let getExtra: () => unknown = () => undefined;

async function push() {
  const blob: RemoteBlob = { schema: SCHEMA_VERSION, cloud: getState(), progress: getExtra() };
  try {
    await fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(blob) });
  } catch {
    /* sin servidor: se ignora */
  }
}

export function schedulePush() {
  if (!active) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(push, 800);
}

/** Devuelve el progreso guardado en el servidor (si lo hay) para que la Academia lo restaure. */
export async function initRemote(opts: { progress: () => unknown }): Promise<{ progress?: unknown }> {
  getExtra = opts.progress;
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    const ct = r.headers.get('content-type') ?? '';
    if (r.status === 204) {
      active = true; // servidor vacío: subimos lo que haya en el navegador
      schedulePush();
    } else if (r.ok && ct.includes('application/json')) {
      const blob = (await r.json()) as RemoteBlob;
      active = true;
      if (blob.schema === SCHEMA_VERSION && blob.cloud) replaceState(blob.cloud);
      subscribe(schedulePush);
      return { progress: blob.progress };
    } else return {};
  } catch {
    return {};
  }
  subscribe(schedulePush);
  return {};
}

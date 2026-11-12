// Sesión de la interfaz: hook para suscribirse al estado y ejecución de acciones de consola como comandos del CLI.
import { useSyncExternalStore } from 'react';
import { getState, getVersion, subscribe, mutate } from '../engine/store';
import { newShell, execLine, type Shell } from '../shell';

export function useCloud() {
  useSyncExternalStore(subscribe, getVersion);
  return getState();
}

let sh: Shell | null = null;
export function getShell(): Shell {
  if (!sh || sh.s !== getState()) sh = newShell(getState());
  return sh;
}

export interface ActionResult {
  ok: boolean;
  out: string;
  err: string;
  json: any;
  cmd: string;
}

/** Ejecuta la acción de la consola como el comando de CLI equivalente (queda en CloudTrail, igual que en AWS). */
export async function consoleRun(cmd: string): Promise<ActionResult> {
  const shell = getShell();
  const r = await execLine(shell, cmd, 'console');
  mutate(() => {});
  let json: any = null;
  try {
    json = r.out.trim() ? JSON.parse(r.out) : null;
  } catch {
    /* salida no JSON */
  }
  return { ok: r.code === 0, out: r.out, err: r.err, json, cmd };
}

/** Quita el prefijo técnico de un error del CLI para mostrarlo como en la consola. */
export function consoleError(err: string): string {
  const m = /An error occurred \(([^)]+)\) when calling the \w+ operation: (.*)/s.exec(err);
  return m ? m[2].trim() : err.trim();
}

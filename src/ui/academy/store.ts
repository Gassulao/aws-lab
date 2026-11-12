// Persistencia del progreso de la Academia (localStorage).
import { useSyncExternalStore } from 'react';
import { emptyProgress, type Progress } from './progress';
import { bus } from '../../engine/store';

const KEY = 'awslab:progress:v1';
let cur: Progress = (() => {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    return raw ? { ...emptyProgress(), ...JSON.parse(raw) } : emptyProgress();
  } catch {
    return emptyProgress();
  }
})();
const ls = new Set<() => void>();
export const getProgress = () => cur;
export function setProgress(p: Progress) {
  if (p === cur) return;
  cur = p;
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* sin almacenamiento */ }
  ls.forEach((l) => l());
}
export function useProgress(): Progress {
  return useSyncExternalStore((l) => { ls.add(l); return () => ls.delete(l); }, getProgress);
}

export function subscribeProgress(l: () => void): () => void {
  ls.add(l);
  return () => ls.delete(l);
}

/** Borra todo el progreso de la Academia. */
export function resetProgress() {
  setProgress(emptyProgress());
}

// Si se reinicia la nube simulada, los escenarios de los laboratorios dejan de existir: se volverán a preparar al abrirlos.
bus.on('cloud:reset', () => setProgress({ ...cur, started: {}, steps: {} }));

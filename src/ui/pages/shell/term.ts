// Estado persistente de la terminal (sobrevive a los cambios de página dentro de la sesión).
import { bus, getState } from '../../../engine/store';

export interface Line {
  kind: 'in' | 'out' | 'err' | 'info';
  text: string;
  prompt?: string;
}

const banner = (): Line[] => [
  { kind: 'info', text: 'Bienvenido a AWS CloudShell simulado.' },
  { kind: 'info', text: 'Las credenciales de tu usuario ya están configuradas. Prueba: aws sts get-caller-identity' },
  { kind: 'info', text: 'Atajos: Tab autocompleta · ↑/↓ historial · Ctrl+L limpia · Ctrl+C cancela la línea.' },
];

let lines: Line[] = banner();
let hist: string[] | null = null;
let busy = false;
let draft = '';
const subs = new Set<() => void>();
let ver = 0;
const emit = () => {
  ver++;
  subs.forEach((f) => f());
};

export const termStore = {
  subscribe(f: () => void) {
    subs.add(f);
    return () => {
      subs.delete(f);
    };
  },
  version: () => ver,
  lines: () => lines,
  push(...l: Line[]) {
    lines = [...lines, ...l].slice(-1500);
    emit();
  },
  clear() {
    lines = [];
    emit();
  },
  history(): string[] {
    if (!hist) hist = getState().cli.commandLog.filter((c) => c.source !== 'console').map((c) => c.cmd);
    return hist;
  },
  addHistory(cmd: string) {
    const h = termStore.history();
    if (cmd.trim() && h[h.length - 1] !== cmd) h.push(cmd);
  },
  busy: () => busy,
  setBusy(b: boolean) {
    busy = b;
    emit();
  },
  draft: () => draft,
  setDraft(d: string) {
    draft = d;
  },
};

bus.on('cloud:reset', () => {
  lines = banner();
  hist = null;
  busy = false;
  draft = '';
  emit();
});

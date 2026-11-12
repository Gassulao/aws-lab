// Puente con la terminal (CloudShell): pega y ejecuta comandos en el input `#term-in` como si los escribiera el alumno.
import { getState } from '../../../engine/store';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const input = () => document.getElementById('term-in') as HTMLInputElement | null;

function setValue(el: HTMLInputElement, v: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export const terminalAvailable = () => !!input();

/** Escribe el texto en la terminal sin ejecutarlo y le da el foco. */
export async function pasteInTerminal(text: string): Promise<boolean> {
  const el = input();
  if (!el) return false;
  setValue(el, text.split('\n')[0]);
  el.focus();
  return true;
}

let running = false;
export const isRunning = () => running;

/** Ejecuta cada línea en la terminal, esperando a que termine antes de lanzar la siguiente. */
export async function runInTerminal(text: string, onLine?: (i: number, n: number) => void): Promise<boolean> {
  const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (running || !lines.length) return false;
  running = true;
  try {
    for (let i = 0; i < lines.length; i++) {
      const el = input();
      if (!el) return false;
      onLine?.(i, lines.length);
      const before = getState().cli.commandLog.length;
      const histBefore = getState().cli.history.length;
      setValue(el, lines[i]);
      await sleep(45);
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const t0 = Date.now();
      while (Date.now() - t0 < 4000) {
        await sleep(30);
        const s = getState();
        if (s.cli.commandLog.length > before || s.cli.history.length > histBefore) break;
      }
      await sleep(80);
    }
    return true;
  } finally {
    running = false;
  }
}

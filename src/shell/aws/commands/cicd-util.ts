// Utilidades de los comandos de CodeCommit, CodeBuild, CodePipeline y CodeDeploy.
import { BIN, type Params } from '../framework';
import type { Shell } from '../../interp';
import { VFS } from '../../fs';

/** Fecha como la imprime AWS CLI v2: ISO 8601 con microsegundos y desplazamiento. */
export const iso = (ms: number) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000+00:00');
export const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
export const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
export const num = (v: unknown): number | undefined => (v === undefined ? undefined : Number(v));
export const bool = (v: unknown) => String(v) === 'true';

/** Entrada de tipo «blob» como AWS CLI v2: base64, o texto con --cli-binary-format raw-in-base64-out, o fileb://. */
export function blobIn(sh: Shell, p: Params, v: unknown): string {
  const s = String(v ?? '');
  if (s.startsWith(BIN)) return s.slice(BIN.length);
  const lit = /^fileb?:\/\/(.+)$/.exec(s);
  if (lit) {
    try {
      return sh.fs.readFile(VFS.norm(lit[1], sh.cwd));
    } catch {
      throw new Error(`Error parsing parameter: Unable to load paramfile ${s}: [Errno 2] No such file or directory: '${lit[1]}'`);
    }
  }
  if (p.CliBinaryFormat === 'raw-in-base64-out') return s;
  if (s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    try {
      return unb64(s);
    } catch {
      /* cae al error */
    }
  }
  throw new Error(`Invalid base64: "${s}"`);
}

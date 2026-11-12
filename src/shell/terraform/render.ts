// Salida de Terraform con el formato del original: valores, diagnósticos con cajas y planes con colores ANSI.
import { UNKNOWN } from './hcl';

export const ESC = '\u001b[';
let colorOn = true;
export const setColor = (on: boolean) => { colorOn = on; };
const c = (code: string, s: string) => (colorOn ? `${ESC}${code}m${s}${ESC}0m` : s);
export const bold = (s: string) => c('1', s);
export const red = (s: string) => c('31', s);
export const green = (s: string) => c('32', s);
export const yellow = (s: string) => c('33', s);
export const cyan = (s: string) => c('36', s);
export const dim = (s: string) => c('2', s);
export const boldRed = (s: string) => c('1;31', s);
export const boldGreen = (s: string) => c('1;32', s);
export const boldYellow = (s: string) => c('1;33', s);

export interface Diag {
  severity: 'error' | 'warning';
  summary: string;
  detail: string;
  file?: string;
  line?: number;
  /** "resource \"aws_vpc\" \"main\"" (contexto de la línea) */
  context?: string;
  address?: string;
}

/** Renderiza un diagnóstico dentro de una caja ╷ │ ╵ como Terraform. */
export function renderDiag(d: Diag, src: (file: string) => string[] | undefined): string {
  const col = d.severity === 'error' ? boldRed : boldYellow;
  const lines: string[] = [];
  lines.push(`${col(d.severity === 'error' ? 'Error: ' : 'Warning: ')}${bold(d.summary)}`);
  lines.push('');
  if (d.file && d.line) {
    if (d.address) lines.push(`  with ${d.address},`);
    lines.push(`  on ${d.file} line ${d.line}${d.context ? `, in ${d.context}` : ''}:`);
    const text = src(d.file)?.[d.line - 1];
    if (text !== undefined) lines.push(`${String(d.line).padStart(4, ' ')}: ${text}`);
    lines.push('');
  }
  for (const l of d.detail.split('\n')) lines.push(l);
  const box = (txt: string) => (txt.length ? `│ ${txt}` : '│ ');
  const body = lines.map(box).join('\n');
  return `${col('╷')}\n${body.replace(/^│/gm, col('│'))}\n${col('╵')}\n`;
}

// ------------------------------------------------------------------ valores

export const isMap = (v: any) => v && typeof v === 'object' && !Array.isArray(v);

/** Valor en una sola línea para listas cortas de escalares y valores simples. */
function scalar(v: any): string {
  if (v === UNKNOWN) return '(known after apply)';
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}

/** Texto multilínea de un valor (lista o mapa). `ind` es la columna donde empieza la clave; el cierre va en esa columna. */
export function fmtValue(v: any, ind: string, sym = '', bare = false): string {
  if (v === UNKNOWN || v === null || v === undefined || typeof v !== 'object') {
    if (typeof v === 'string' && v.trimStart().startsWith('{') && !v.includes('\n')) {
      try {
        const o = JSON.parse(v);
        return `jsonencode(\n${fmtJsonBody(o, ind + '  ', sym)}\n${ind})`;
      } catch { /* texto normal */ }
    }
    return scalar(v);
  }
  const pre = sym ? `${sym} ` : '';
  const inner = ind + '  ' + (sym ? '' : '');
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    const lines = v.map((x) => `${inner}${pre}${isMap(x) || Array.isArray(x) ? fmtValue(x, inner + ' '.repeat(pre.length), sym, true) : scalar(x)},`).join('\n');
    return `[\n${lines}\n${ind}]`;
  }
  const keys = Object.keys(v).sort();
  if (!keys.length) return '{}';
  const kn = (k: string) => (bare ? k : JSON.stringify(k));
  const w = Math.max(...keys.map((k) => kn(k).length));
  const lines = keys.map((k) => `${inner}${pre}${kn(k).padEnd(w)} = ${isMap(v[k]) || Array.isArray(v[k]) ? fmtValue(v[k], inner + ' '.repeat(pre.length), sym, bare) : scalar(v[k])}`).join('\n');
  return `{\n${lines}\n${ind}}`;
}

function fmtJsonBody(o: any, ind: string, sym: string): string {
  const pre = sym ? `${sym} ` : '';
  const text = JSON.stringify(o, null, 2).split('\n').map((l) => `${ind}${pre}${l}`).join('\n');
  return text;
}

/** Valor para `terraform output` y `show` (sin símbolos). */
export function fmtPlain(v: any, ind = ''): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'object') return scalar(v);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return `[\n${v.map((x) => `${ind}  ${fmtPlain(x, ind + '  ')},`).join('\n')}\n${ind}]`;
  }
  const keys = Object.keys(v);
  if (!keys.length) return '{}';
  const w = Math.max(...keys.map((k) => JSON.stringify(k).length));
  return `{\n${keys.map((k) => `${ind}  ${JSON.stringify(k).padEnd(w)} = ${fmtPlain(v[k], ind + '  ')}`).join('\n')}\n${ind}}`;
}

export const jsonOf = (v: any): any => (v === UNKNOWN ? null : Array.isArray(v) ? v.map(jsonOf) : isMap(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonOf(x)])) : v);

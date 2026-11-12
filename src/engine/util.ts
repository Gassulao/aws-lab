// Utilidades comunes del motor: identificadores, tiempo y aleatoriedad determinista opcional.

let seed: number | null = null;

/** Fija una semilla para obtener identificadores reproducibles (útil en tests). null = aleatorio. */
export function setSeed(s: number | null) {
  seed = s;
}

function rnd(): number {
  if (seed === null) return Math.random();
  // mulberry32
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function randomString(len: number, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'): string {
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(rnd() * alphabet.length)];
  return out;
}

export function hex(len: number): string {
  return randomString(len, '0123456789abcdef');
}

export function digits(len: number): string {
  let out = String(1 + Math.floor(rnd() * 9));
  while (out.length < len) out += Math.floor(rnd() * 10);
  return out;
}

export function guid(): string {
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

let clock: (() => number) | null = null;

/** Sustituye el reloj (tests). */
export function setClock(fn: (() => number) | null) {
  clock = fn;
}

export function now(): number {
  return clock ? clock() : Date.now();
}

export function nowIso(): string {
  return new Date(now()).toISOString();
}

export function slugify(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'estudiante'
  );
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/** Coincidencia con comodines estilo IAM (* y ?), insensible a mayúsculas si ci. */
export function wildcardMatch(pattern: string, value: string, ci = false): boolean {
  const p = ci ? pattern.toLowerCase() : pattern;
  const v = ci ? value.toLowerCase() : value;
  const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return re.test(v);
}

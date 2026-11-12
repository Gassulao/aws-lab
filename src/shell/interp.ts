// Intérprete de Bash simplificado. Los comandos son funciones registradas; las estructuras de control, las
// expansiones, las tuberías y las redirecciones se resuelven aquí.
import type { CloudState } from '../engine/types';
import { parse, ParseError, type Node, type SimpleCmd, type Word, type Redirect } from './parser';
import { VFS, FsError } from './fs';
import { changed } from '../engine/store';

export interface CmdResult {
  out: string;
  err: string;
  code: number;
}

export interface Shell {
  s: CloudState;
  fs: VFS;
  /** Variables de la sesión (exportadas o no). */
  vars: Record<string, string>;
  cwd: string;
  lastCode: number;
  /** Salida de sustituciones de comando anidadas, para depurar. */
  depth: number;
  funcs: Record<string, never>;
  /** Parámetros posicionales ($1, $2, $@, $#) del script en ejecución. */
  pos?: string[];
  /** $0: nombre del script o de la shell. */
  argv0?: string;
  /** Entrada que consume `read` dentro de un `while read ...; done < fichero`. */
  rd?: { text: string };
  /** Origen efectivo de `read` en el comando en curso. */
  readSrc?: { text: string };
  /** `exit` pidió terminar: se corta el script en curso. */
  exitCode?: number;
}

export type CmdFn = (args: string[], io: { stdin: string; sh: Shell }) => CmdResult | Promise<CmdResult>;

const registry = new Map<string, CmdFn>();
export function registerCommand(name: string | string[], fn: CmdFn) {
  for (const n of Array.isArray(name) ? name : [name]) registry.set(n, fn);
}
export function hasCommand(name: string) {
  return registry.has(name);
}

export class ShellError extends Error {}

export const ok = (out = ''): CmdResult => ({ out, err: '', code: 0 });
export const fail = (err: string, code = 1): CmdResult => ({ out: '', err: err.endsWith('\n') ? err : err + '\n', code });

export function newShell(s: CloudState): Shell {
  const sh: Shell = { s, fs: new VFS(s.fs), vars: {}, cwd: s.cli.cwd, lastCode: 0, depth: 0, funcs: {} };
  return sh;
}

const globToRe = (g: string, anchored = true): string => {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = g.indexOf(']', i + 2);
      if (end < 0) re += '\\[';
      else {
        re += g.slice(i, end + 1);
        i = end;
      }
    } else if (c === '\\' && i + 1 < g.length) re += '\\' + g[++i];
    else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return anchored ? `^(?:${re})$` : re;
};

function rawVar(sh: Shell, name: string): string | undefined {
  if (name === '?') return String(sh.lastCode);
  if (name === '$') return '1';
  if (name === '#') return String((sh.pos ?? []).length);
  if (name === '@' || name === '*') return (sh.pos ?? []).join(' ');
  if (/^\d+$/.test(name)) return name === '0' ? sh.argv0 ?? 'bash' : (sh.pos ?? [])[Number(name) - 1];
  if (name === 'HOME') return sh.vars.HOME ?? `/home/${sh.s.me.userName}`;
  if (name === 'USER') return sh.vars.USER ?? sh.s.me.userName;
  if (name === 'PWD') return sh.cwd;
  return sh.vars[name] ?? sh.s.cli.env[name];
}

/** Expansión de parámetros: ${v:-x} ${v:=x} ${v:+x} ${v#p} ${v##p} ${v%p} ${v%%p} ${v/a/b} ${v//a/b} ${v:o:n} ${v^^} ${v,,} ${#v}. */
function lookupVar(sh: Shell, name: string): string {
  const len = /^#([A-Za-z_][A-Za-z0-9_]*|[0-9@*])$/.exec(name);
  if (len) return String((len[1] === '@' || len[1] === '*' ? (sh.pos ?? []).length : (rawVar(sh, len[1]) ?? '').length));
  const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?])(:-|:=|:\+|-|=|\+|##|#|%%|%|\/\/|\/|\^\^|,,|:)([\s\S]*)$/.exec(name);
  if (!m) return rawVar(sh, name) ?? '';
  const [, v, op, arg] = m;
  const val = rawVar(sh, v);
  const empty = val === undefined || val === '';
  switch (op) {
    case ':-': return empty ? arg : val!;
    case '-': return val === undefined ? arg : val;
    case ':=': if (empty) { sh.vars[v] = arg; return arg; } return val!;
    case '=': if (val === undefined) { sh.vars[v] = arg; return arg; } return val;
    case ':+': return empty ? '' : arg;
    case '+': return val === undefined ? '' : arg;
    case '#': case '##': {
      const re = new RegExp('^' + globToRe(arg, false) + '$');
      const t = val ?? '';
      const idx = op === '#' ? Array.from({ length: t.length + 1 }, (_, i) => i) : Array.from({ length: t.length + 1 }, (_, i) => t.length - i);
      for (const i of idx) if (re.test(t.slice(0, i))) return t.slice(i);
      return t;
    }
    case '%': case '%%': {
      const re = new RegExp('^' + globToRe(arg, false) + '$');
      const t = val ?? '';
      const idx = op === '%' ? Array.from({ length: t.length + 1 }, (_, i) => t.length - i) : Array.from({ length: t.length + 1 }, (_, i) => i);
      for (const i of idx) if (re.test(t.slice(i))) return t.slice(0, i);
      return t;
    }
    case '/': case '//': {
      const k = arg.indexOf('/');
      const pat = k < 0 ? arg : arg.slice(0, k);
      const rep = k < 0 ? '' : arg.slice(k + 1);
      try {
        return (val ?? '').replace(new RegExp(globToRe(pat, false), op === '//' ? 'g' : ''), () => rep);
      } catch {
        return val ?? '';
      }
    }
    case ':': {
      const [o, l] = arg.split(':');
      const t = val ?? '';
      const off = Number(o) < 0 ? Math.max(0, t.length + Number(o)) : Number(o);
      return l === undefined ? t.slice(off) : t.slice(off, off + Number(l));
    }
    case '^^': return (val ?? '').toUpperCase();
    case ',,': return (val ?? '').toLowerCase();
  }
  return val ?? '';
}

/** Aritmética de $(( )): + - * / % ** paréntesis, comparaciones, && || ! y variables. */
export function arith(sh: Shell, src: string): number {
  const toks = src.replace(/\$/g, '').match(/\*\*|<=|>=|==|!=|&&|\|\||[0-9]+|[A-Za-z_][A-Za-z0-9_]*|[-+*\/%()<>!?:]/g) ?? [];
  let i = 0;
  const peek = () => toks[i];
  const num = (n: string): number => {
    const v = Number(rawVar(sh, n) ?? 0);
    return Number.isNaN(v) ? 0 : v;
  };
  const prim = (): number => {
    const t = toks[i++];
    if (t === undefined) throw new Error('syntax error: operand expected');
    if (t === '(') {
      const v = ternary();
      if (toks[i++] !== ')') throw new Error('syntax error: missing )');
      return v;
    }
    if (t === '-') return -prim();
    if (t === '+') return prim();
    if (t === '!') return prim() ? 0 : 1;
    if (/^\d+$/.test(t)) return Number(t);
    if (/^[A-Za-z_]/.test(t)) return num(t);
    throw new Error(`syntax error: unexpected '${t}'`);
  };
  const bin = (next: () => number, ops: string[], f: (op: string, a: number, b: number) => number) => () => {
    let a = next();
    while (ops.includes(peek())) {
      const op = toks[i++];
      a = f(op, a, next());
    }
    return a;
  };
  const pow = (): number => {
    const a = prim();
    if (peek() === '**') {
      i++;
      return a ** pow();
    }
    return a;
  };
  const mul = bin(pow, ['*', '/', '%'], (op, a, b) => {
    if (op !== '*' && b === 0) throw new Error('division by 0 (error token is "0")');
    return op === '*' ? a * b : op === '/' ? Math.trunc(a / b) : a % b;
  });
  const add = bin(mul, ['+', '-'], (op, a, b) => (op === '+' ? a + b : a - b));
  const cmp = bin(add, ['<', '>', '<=', '>='], (op, a, b) => Number(op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b));
  const eq = bin(cmp, ['==', '!='], (op, a, b) => Number(op === '==' ? a === b : a !== b));
  const and = bin(eq, ['&&'], (_o, a, b) => Number(!!a && !!b));
  const or = bin(and, ['||'], (_o, a, b) => Number(!!a || !!b));
  function ternary(): number {
    const c = or();
    if (peek() === '?') {
      i++;
      const a = ternary();
      if (toks[i++] !== ':') throw new Error('syntax error: expected :');
      return c ? a : ternary();
    }
    return c;
  }
  const v = ternary();
  if (i < toks.length) throw new Error(`syntax error in expression (error token is "${toks[i]}")`);
  return v;
}

async function expandWord(sh: Shell, w: Word): Promise<string[]> {
  // Devuelve una lista porque una expansión sin comillas puede dividirse en varias palabras.
  let fields: string[] = [''];
  let hasGlob = false;
  let raw = '';
  const addText = (txt: string, split: boolean) => {
    if (!split) {
      fields[fields.length - 1] += txt;
      raw += txt;
      return;
    }
    const pieces = txt.split(/\s+/);
    pieces.forEach((pc, i) => {
      if (i > 0) fields.push('');
      fields[fields.length - 1] += pc;
    });
    raw += txt;
  };
  for (const p of w.parts) {
    if (p.t === 'lit') {
      // ~ al inicio
      if (p.v.startsWith('~') && fields.length === 1 && fields[0] === '' && (p.v === '~' || p.v.startsWith('~/'))) addText(lookupVar(sh, 'HOME') + p.v.slice(1), false);
      else addText(p.v, false);
    } else if (p.t === 'var' && p.name === '@' && p.quoted) {
      // "$@": cada parámetro posicional es una palabra distinta.
      (sh.pos ?? []).forEach((x, k) => {
        if (k > 0) fields.push('');
        fields[fields.length - 1] += x;
      });
    } else if (p.t === 'var') addText(lookupVar(sh, p.name), !p.quoted);
    else if (p.t === 'arith') {
      try {
        addText(String(Math.trunc(arith(sh, p.src))), !p.quoted);
      } catch (e) {
        throw new ShellError(`${p.src.trim()}: ${(e as Error).message}`);
      }
    } else if (p.t === 'cmd') {
      const r = await runString(sh, p.src, '', true);
      addText(r.out.replace(/\n+$/, ''), !p.quoted);
    } else {
      hasGlob = true;
      addText(p.v, false);
    }
  }
  if (w.parts.length === 1 && w.parts[0].t === 'var' && (w.parts[0] as { name: string }).name === '@' && !(sh.pos ?? []).length) return [];
  if (!w.quoted && fields.length === 1 && fields[0] === '' && w.parts.every((p) => p.t === 'var' || p.t === 'cmd' || p.t === 'arith')) return [];
  if (hasGlob && !w.quoted) {
    const out: string[] = [];
    for (const f of fields) {
      const m = /[*?]/.test(f) ? sh.fs.glob(f, sh.cwd) : [];
      if (m.length) out.push(...m);
      else out.push(f);
    }
    return out;
  }
  if (!w.quoted) fields = fields.filter((f) => f !== '');
  return fields;
}

async function expandAll(sh: Shell, words: Word[]): Promise<string[]> {
  const out: string[] = [];
  for (const w of words) out.push(...(await expandWord(sh, w)));
  return out;
}

/** Lee las redirecciones de entrada (`<`) y devuelve el texto de entrada, o un error. */
async function inputRedirect(sh: Shell, redirects: Redirect[], stdin: string): Promise<{ input: string } | { error: CmdResult }> {
  let input = stdin;
  for (const r of redirects) {
    if (r.op !== '<') continue;
    const target = (await expandWord(sh, r.target!)).join('');
    try {
      input = sh.fs.readFile(VFS.norm(target, sh.cwd));
    } catch (e) {
      return { error: fail(`bash: ${target}: ${(e as Error).message}`) };
    }
  }
  return { input };
}

/** Aplica las redirecciones de salida (`>`, `>>`, `2>`, `2>&1`, `&>`) al resultado de un comando. */
async function applyRedirects(sh: Shell, redirects: Redirect[], res: CmdResult): Promise<CmdResult> {
  let outTarget: { path: string; append: boolean } | null = null;
  let errTarget: { path: string; append: boolean } | null = null;
  let errToOut = false;
  for (const r of redirects) {
    if (r.op === '2>&1') {
      errToOut = true;
      continue;
    }
    if (r.op === '<') continue;
    const target = (await expandWord(sh, r.target!)).join('');
    const abs = VFS.norm(target, sh.cwd);
    if (r.op === '>' || r.op === '>>' || r.op === '&>') {
      outTarget = { path: abs, append: r.op === '>>' };
      if (r.op === '&>') errToOut = true;
    } else errTarget = { path: abs, append: r.op === '2>>' };
  }
  try {
    if (errToOut) {
      res = { out: res.out + res.err, err: '', code: res.code };
    }
    if (errTarget) {
      if (errTarget.path === '/dev/null') res = { ...res, err: '' };
      else {
        sh.fs.writeFile(errTarget.path, res.err, errTarget.append);
        res = { ...res, err: '' };
      }
    }
    if (outTarget) {
      if (outTarget.path === '/dev/null') res = { ...res, out: '' };
      else {
        sh.fs.writeFile(outTarget.path, res.out, outTarget.append);
        res = { ...res, out: '' };
      }
    }
  } catch (e) {
    const msg = e instanceof FsError ? e.message : String(e);
    return fail(`bash: ${(outTarget ?? errTarget)!.path}: ${msg}`);
  }
  return res;
}

/** Ejecuta un guion con sus argumentos. `child` aísla variables, directorio y parámetros como un proceso hijo; `source` los comparte. */
export async function runScript(sh: Shell, text: string, argv0: string, args: string[], mode: 'child' | 'source', stdin = ''): Promise<CmdResult> {
  const saved = { vars: { ...sh.vars }, env: { ...sh.s.cli.env }, pos: sh.pos, argv0: sh.argv0, cwd: sh.cwd, rd: sh.rd };
  sh.pos = args;
  sh.argv0 = argv0;
  try {
    return await runString(sh, text, stdin, true);
  } finally {
    sh.pos = saved.pos;
    sh.argv0 = saved.argv0;
    sh.rd = saved.rd;
    if (mode === 'child') {
      sh.vars = saved.vars;
      for (const k of Object.keys(sh.s.cli.env)) delete sh.s.cli.env[k];
      Object.assign(sh.s.cli.env, saved.env);
      sh.cwd = saved.cwd;
    }
  }
}

/** Ejecuta `./guion.sh` o una ruta absoluta: exige el bit de ejecución, como Linux. */
async function runPath(sh: Shell, name: string, args: string[], stdin: string): Promise<CmdResult> {
  const abs = VFS.norm(name, sh.cwd);
  const st = sh.fs.stat(abs);
  if (!st) return fail(`bash: ${name}: No such file or directory`, 127);
  if (st.type === 'dir') return fail(`bash: ${name}: Is a directory`, 126);
  if (!(st.mode & 0o100)) return fail(`bash: ${name}: Permission denied`, 126);
  return runScript(sh, sh.fs.readFile(abs), name, args, 'child', stdin);
}

async function runSimple(sh: Shell, n: SimpleCmd, stdin: string): Promise<CmdResult> {
  const args = await expandAll(sh, n.words);
  // asignaciones
  const saved: Record<string, string | undefined> = {};
  for (const a of n.assigns) {
    const v = (await expandWord(sh, a.value)).join(' ');
    if (!args.length) {
      sh.vars[a.name] = v;
      sh.s.cli.env[a.name] = v;
    } else {
      saved[a.name] = sh.vars[a.name];
      sh.vars[a.name] = v;
    }
  }
  let input = stdin;
  if (n.heredoc) {
    input = n.heredoc.expand ? await expandHeredoc(sh, n.heredoc.body) : n.heredoc.body;
  }
  const inp = await inputRedirect(sh, n.redirects, input);
  if ('error' in inp) return inp.error;
  input = inp.input;
  const ownInput = n.heredoc !== undefined || n.redirects.some((r) => r.op === '<');
  let res: CmdResult = { out: '', err: '', code: 0 };
  if (args.length) {
    const [name, ...rest] = args;
    const fn = registry.get(name);
    sh.readSrc = !ownInput && sh.rd ? sh.rd : { text: input };
    if (!fn && name.includes('/')) res = await runPath(sh, name, rest, input);
    else if (!fn) res = fail(`bash: ${name}: command not found`, 127);
    else {
      try {
        res = await fn(rest, { stdin: input, sh });
      } catch (e) {
        res = fail(`${name}: ${(e as Error).message}`);
      }
    }
  }
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete sh.vars[k];
    else sh.vars[k] = v;
  }
  return applyRedirects(sh, n.redirects, res);
}

async function expandHeredoc(sh: Shell, body: string): Promise<string> {
  let out = '';
  let i = 0;
  while (i < body.length) {
    if (body[i] === '$') {
      const m = /^\$\{([^}]+)\}|^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(body.slice(i));
      if (m) {
        out += lookupVar(sh, m[1] ?? m[2]);
        i += m[0].length;
        continue;
      }
      if (body[i + 1] === '(') {
        let d = 1;
        let j = i + 2;
        while (j < body.length && d) {
          if (body[j] === '(') d++;
          else if (body[j] === ')') d--;
          j++;
        }
        out += (await runString(sh, body.slice(i + 2, j - 1), '', true)).out.replace(/\n+$/, '');
        i = j;
        continue;
      }
    }
    out += body[i++];
  }
  return out;
}

async function run(sh: Shell, n: Node, stdin: string): Promise<CmdResult> {
  switch (n.type) {
    case 'simple': {
      const r = await runSimple(sh, n, stdin);
      sh.lastCode = r.code;
      return r;
    }
    case 'pipeline': {
      let data = stdin;
      let err = '';
      let last: CmdResult = ok();
      for (const c of n.cmds) {
        last = await run(sh, c, data);
        err += last.err;
        data = last.out;
      }
      const code = n.negate ? (last.code === 0 ? 1 : 0) : last.code;
      sh.lastCode = code;
      return { out: last.out, err, code };
    }
    case 'andor': {
      let r = await run(sh, n.first, stdin);
      let out = r.out;
      let err = r.err;
      for (const step of n.rest) {
        if (sh.exitCode !== undefined) break;
        if (step.op === '&&' ? r.code === 0 : r.code !== 0) {
          r = await run(sh, step.node, stdin);
          out += r.out;
          err += r.err;
        }
      }
      return { out, err, code: r.code };
    }
    case 'list': {
      let out = '';
      let err = '';
      let code = 0;
      for (const it of n.items) {
        const r = await run(sh, it, stdin);
        out += r.out;
        err += r.err;
        code = r.code;
        if (sh.exitCode !== undefined) break;
      }
      return { out, err, code };
    }
    case 'redir': {
      const inp = await inputRedirect(sh, n.redirects, stdin);
      if ('error' in inp) return inp.error;
      const r = await run(sh, n.node, inp.input);
      return applyRedirects(sh, n.redirects, r);
    }
    case 'if': {
      const c = await run(sh, n.cond, stdin);
      const branch = c.code === 0 ? n.then : n.else;
      const r = branch ? await run(sh, branch, stdin) : ok();
      return { out: c.out + r.out, err: c.err + r.err, code: r.code };
    }
    case 'for': {
      const items = await expandAll(sh, n.words);
      let out = '';
      let err = '';
      let code = 0;
      for (const it of items) {
        sh.vars[n.name] = it;
        const r = await run(sh, n.body, stdin);
        out += r.out;
        err += r.err;
        code = r.code;
        if (sh.exitCode !== undefined) break;
      }
      return { out, err, code };
    }
    case 'while': {
      let out = '';
      let err = '';
      let code = 0;
      // La entrada del bucle (tubería o `done < fichero`) la consume `read` línea a línea.
      const prevRd = sh.rd;
      sh.rd = { text: stdin };
      try {
        for (let guard = 0; guard < 1000; guard++) {
          const c = await run(sh, n.cond, stdin);
          out += c.out;
          err += c.err;
          if (c.code !== 0 || sh.exitCode !== undefined) break;
          const r = await run(sh, n.body, stdin);
          out += r.out;
          err += r.err;
          code = r.code;
          if (sh.exitCode !== undefined) break;
        }
      } finally {
        sh.rd = prevRd;
      }
      return { out, err, code };
    }
  }
}

export async function runString(sh: Shell, src: string, stdin = '', nested = false): Promise<CmdResult> {
  let ast: Node;
  try {
    ast = parse(src);
  } catch (e) {
    if (e instanceof ParseError) return fail(`bash: ${e.message}`, 2);
    throw e;
  }
  if (nested) sh.depth++;
  try {
    const r = await run(sh, ast, stdin);
    if (sh.exitCode !== undefined) {
      const code = sh.exitCode;
      sh.exitCode = undefined;
      sh.lastCode = code;
      return { ...r, code };
    }
    return r;
  } catch (e) {
    if (e instanceof ShellError) {
      sh.exitCode = undefined;
      sh.lastCode = 1;
      return fail(`bash: ${e.message}`);
    }
    throw e;
  } finally {
    if (nested) sh.depth--;
  }
}

/** Ejecuta una línea escrita por el usuario y la anota en el registro de comandos (para validar laboratorios). */
export async function execLine(sh: Shell, line: string, source: 'typed' | 'shell' | 'console' = 'typed'): Promise<CmdResult> {
  const r = await runString(sh, line);
  sh.s.cli.cwd = sh.cwd;
  sh.s.cli.history.push(line);
  sh.s.cli.commandLog.push({ ts: Date.now(), cmd: line, ok: r.code === 0, source });
  changed(); // avisa a la interfaz y guarda el estado
  return r;
}

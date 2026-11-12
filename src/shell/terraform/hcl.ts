// Subconjunto de HCL2 para el simulador de Terraform: bloques, atributos, plantillas de texto, listas, objetos,
// referencias, operadores, condicionales, expresiones `for`, funciones habituales y heredocs.

export class HclError extends Error {
  constructor(msg: string, public line: number, public detail = '') {
    super(msg);
  }
}

/** Valor aún desconocido (se conocerá tras aplicar). */
export const UNKNOWN = Symbol('unknown');
export type Unknown = typeof UNKNOWN;

export type Step = { k: 'attr'; name: string } | { k: 'idx'; e: Expr } | { k: 'splat' };
export type Expr =
  | { t: 'lit'; v: any }
  | { t: 'tmpl'; parts: (string | Expr)[] }
  | { t: 'ref'; root: string; steps: Step[]; line: number }
  | { t: 'list'; items: Expr[] }
  | { t: 'obj'; items: { k: Expr; v: Expr }[] }
  | { t: 'call'; fn: string; args: Expr[]; line: number }
  | { t: 'cond'; c: Expr; a: Expr; b: Expr }
  | { t: 'bin'; op: string; l: Expr; r: Expr }
  | { t: 'un'; op: string; e: Expr }
  | { t: 'for'; key?: string; val: string; coll: Expr; k?: Expr; v: Expr; isObj: boolean; cond?: Expr }
  | { t: 'idxe'; e: Expr; step: Step };

export interface Block {
  type: string;
  labels: string[];
  body: Body;
  line: number;
}
export interface Body {
  attrs: Record<string, { e: Expr; line: number }>;
  blocks: Block[];
}

// ------------------------------------------------------------------ tokenizador

type Tok = { k: 'id' | 'num' | 'str' | 'p' | 'nl' | 'eof' | 'heredoc'; v: string; line: number; parts?: (string | Tok[])[] };

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  const push = (k: Tok['k'], v: string, extra: Partial<Tok> = {}) => out.push({ k, v, line, ...extra });
  const readTemplate = (end: string): (string | Tok[])[] => {
    const parts: (string | Tok[])[] = [];
    let cur = '';
    while (i < n && src[i] !== end) {
      const c = src[i];
      if (c === '\\') {
        const nx = src[i + 1];
        cur += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx === 'r' ? '\r' : nx;
        i += 2;
      } else if ((c === '$' || c === '%') && src[i + 1] === '{') {
        if (src[i + 2] === '{' && c === '$') { cur += '${'; i += 3; continue; }
        if (c === '%') { cur += c; i++; continue; }
        if (cur) parts.push(cur);
        cur = '';
        i += 2;
        let depth = 1;
        const start = i;
        while (i < n && depth > 0) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') depth--;
          else if (src[i] === '"') { i++; while (i < n && src[i] !== '"') { if (src[i] === '\\') i++; i++; } }
          i++;
        }
        parts.push(tokenize(src.slice(start, i - 1)).filter((t) => t.k !== 'eof'));
      } else {
        if (c === '\n') line++;
        cur += c;
        i++;
      }
    }
    if (i >= n) throw new HclError('Unterminated template string', line, 'No closing quote was found for this string.');
    i++;
    if (cur || !parts.length) parts.push(cur);
    return parts;
  };
  while (i < n) {
    const c = src[i];
    if (c === '\n') { push('nl', '\n'); line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '#' || (c === '/' && src[i + 1] === '/')) { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }
    if (c === '"') { i++; const l0 = line; const parts = readTemplate('"'); out.push({ k: 'str', v: '', line: l0, parts }); continue; }
    if (c === '<' && src[i + 1] === '<') {
      const m = /^<<(-?)([A-Za-z_][A-Za-z0-9_]*)\r?\n/.exec(src.slice(i));
      if (m) {
        const l0 = line;
        i += m[0].length;
        line++;
        const lines: string[] = [];
        for (;;) {
          if (i >= n) throw new HclError('Unterminated heredoc', l0, `There is no closing marker "${m[2]}".`);
          let e = src.indexOf('\n', i);
          if (e < 0) e = n;
          const ln = src.slice(i, e);
          i = e + 1;
          line++;
          if ((m[1] ? ln.trim() : ln) === m[2]) break;
          lines.push(ln);
        }
        let body = lines;
        if (m[1]) {
          const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length), Infinity);
          body = lines.map((l) => l.slice(Number.isFinite(ind) ? ind : 0));
        }
        const text = body.join('\n') + '\n';
        // Los heredocs también admiten interpolación.
        const save = { i, line };
        const sub = tokenizeHeredoc(text);
        i = save.i; line = save.line;
        out.push({ k: 'str', v: '', line: l0, parts: sub });
        continue;
      }
    }
    if (/[0-9]/.test(c)) { let j = i; while (j < n && /[0-9.eE]/.test(src[j]) && !(src[j] === '.' && !/[0-9]/.test(src[j + 1] ?? ''))) j++; push('num', src.slice(i, j)); i = j; continue; }
    if (/[A-Za-z_]/.test(c)) { let j = i; while (j < n && /[A-Za-z0-9_-]/.test(src[j])) j++; push('id', src.slice(i, j)); i = j; continue; }
    const three = src.slice(i, i + 3);
    if (three === '...') { push('p', three); i += 3; continue; }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||', '=>'].includes(two)) { push('p', two); i += 2; continue; }
    if ('{}[]()=,.:?<>!+-*/%'.includes(c)) { push('p', c); i++; continue; }
    throw new HclError('Invalid character', line, `This character is not used within the language: "${c}".`);
  }
  push('eof', '');
  return out;
}

function tokenizeHeredoc(text: string): (string | Tok[])[] {
  const parts: (string | Tok[])[] = [];
  let cur = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '$' && text[i + 1] === '{') {
      if (cur) parts.push(cur);
      cur = '';
      i += 2;
      let depth = 1;
      const s = i;
      while (i < text.length && depth > 0) { if (text[i] === '{') depth++; else if (text[i] === '}') depth--; i++; }
      parts.push(tokenize(text.slice(s, i - 1)).filter((t) => t.k !== 'eof'));
    } else cur += text[i++];
  }
  if (cur || !parts.length) parts.push(cur);
  return parts;
}

// ------------------------------------------------------------------ analizador

class Parser {
  p = 0;
  constructor(public toks: Tok[]) {}
  get cur() { return this.toks[this.p]; }
  kind(): string { return this.cur.k; }
  is(v: string) { return this.cur.k === 'p' && this.cur.v === v; }
  isId(v?: string) { return this.cur.k === 'id' && (v === undefined || this.cur.v === v); }
  next() { return this.toks[this.p++]; }
  skipNl() { while (this.cur.k === 'nl') this.p++; }
  expect(v: string, what = `"${v}"`) {
    if (!this.is(v)) throw new HclError(`Argument or block definition required`, this.cur.line, `Expected ${what}, found "${this.cur.v || (this.cur.k === 'eof' ? 'end of file' : 'newline')}".`);
    return this.next();
  }

  parseBody(top: boolean): Body {
    const body: Body = { attrs: {}, blocks: [] };
    for (;;) {
      this.skipNl();
      if (this.cur.k === 'eof') { if (!top) throw new HclError('Unclosed configuration block', this.cur.line, 'There is no closing brace for this block before the end of the file.'); return body; }
      if (this.is('}')) { if (top) throw new HclError('Unbalanced braces', this.cur.line, 'Unexpected "}".'); this.next(); return body; }
      if (this.cur.k !== 'id') throw new HclError('Argument or block definition required', this.cur.line, 'An argument or block definition is required here.');
      const name = this.next();
      if (this.is('=')) {
        this.next();
        if (name.v in body.attrs) throw new HclError('Attribute redefined', name.line, `The argument "${name.v}" was already set. Each argument may be set only once.`);
        const e = this.expr();
        if (this.kind() !== 'nl' && this.kind() !== 'eof' && !this.is('}')) throw new HclError('Missing newline after argument', this.cur.line, 'An argument definition must end with a newline.');
        body.attrs[name.v] = { e, line: name.line };
      } else {
        const labels: string[] = [];
        while (this.kind() === 'str' || (this.kind() === 'id' && this.toks[this.p + 1] && (this.toks[this.p + 1].k === 'p' && this.toks[this.p + 1].v === '{' || this.toks[this.p + 1].k === 'str' || this.toks[this.p + 1].k === 'id'))) {
          const t = this.next();
          labels.push(t.k === 'str' ? (t.parts ?? []).map((x) => (typeof x === 'string' ? x : '')).join('') : t.v);
        }
        if (!this.is('{')) throw new HclError('Invalid block definition', this.cur.line, 'A block definition must have block content delimited by "{" and "}", starting on the same line as the block header.');
        this.next();
        const inner = this.parseBody(false);
        body.blocks.push({ type: name.v, labels, body: inner, line: name.line });
      }
    }
  }

  expr(): Expr {
    const c = this.binary(0);
    if (this.is('?')) {
      this.next(); this.skipNl();
      const a = this.expr();
      this.skipNl();
      this.expect(':');
      this.skipNl();
      const b = this.expr();
      return { t: 'cond', c, a, b };
    }
    return c;
  }

  static PREC: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };
  binary(min: number): Expr {
    let l = this.unary();
    for (;;) {
      const t = this.cur;
      if (t.k !== 'p' || !(t.v in Parser.PREC) || Parser.PREC[t.v] <= min - 1 && false) break;
      const pr = Parser.PREC[t.v];
      if (pr < min) break;
      this.next();
      this.skipNl();
      const r = this.binary(pr + 1);
      l = { t: 'bin', op: t.v, l, r };
    }
    return l;
  }
  unary(): Expr {
    if (this.is('!') || this.is('-')) { const op = this.next().v; return { t: 'un', op, e: this.unary() }; }
    return this.postfix(this.primary());
  }
  postfix(e: Expr): Expr {
    for (;;) {
      if (this.is('.')) {
        this.next();
        if (this.is('*')) { this.next(); e = this.addStep(e, { k: 'splat' }); continue; }
        const t = this.next();
        if (t.k !== 'id' && t.k !== 'num') throw new HclError('Invalid attribute name', t.line, 'An attribute name is required after a dot.');
        e = this.addStep(e, t.k === 'num' ? { k: 'idx', e: { t: 'lit', v: Number(t.v) } } : { k: 'attr', name: t.v });
      } else if (this.is('[')) {
        this.next(); this.skipNl();
        if (this.is('*')) { this.next(); this.skipNl(); this.expect(']'); e = this.addStep(e, { k: 'splat' }); continue; }
        const ix = this.expr();
        this.skipNl();
        this.expect(']');
        e = this.addStep(e, { k: 'idx', e: ix });
      } else return e;
    }
  }
  addStep(e: Expr, s: Step): Expr {
    if (e.t === 'ref') return { ...e, steps: [...e.steps, s] };
    return { t: 'idxe', e, step: s };
  }
  primary(): Expr {
    const t = this.cur;
    if (t.k === 'num') { this.next(); return { t: 'lit', v: Number(t.v) }; }
    if (t.k === 'str') {
      this.next();
      const parts = (t.parts ?? []).map((x) => (typeof x === 'string' ? x : new Parser([...x, { k: 'eof', v: '', line: t.line }]).exprAll()));
      if (parts.length === 1 && typeof parts[0] === 'string') return { t: 'lit', v: parts[0] };
      return { t: 'tmpl', parts };
    }
    if (t.k === 'id') {
      this.next();
      if (t.v === 'true') return { t: 'lit', v: true };
      if (t.v === 'false') return { t: 'lit', v: false };
      if (t.v === 'null') return { t: 'lit', v: null };
      if (this.is('(')) {
        this.next(); this.skipNl();
        const args: Expr[] = [];
        while (!this.is(')')) {
          args.push(this.expr());
          this.skipNl();
          if (this.is('...')) { this.next(); this.skipNl(); }
          if (this.is(',')) { this.next(); this.skipNl(); } else break;
        }
        this.skipNl();
        this.expect(')');
        return { t: 'call', fn: t.v, args, line: t.line };
      }
      return { t: 'ref', root: t.v, steps: [], line: t.line };
    }
    if (this.is('(')) { this.next(); this.skipNl(); const e = this.expr(); this.skipNl(); this.expect(')'); return e; }
    if (this.is('[')) {
      this.next(); this.skipNl();
      if (this.isId('for')) return this.forExpr(false);
      const items: Expr[] = [];
      while (!this.is(']')) {
        items.push(this.expr());
        this.skipNl();
        if (this.is(',')) { this.next(); this.skipNl(); } else break;
      }
      this.skipNl();
      this.expect(']');
      return { t: 'list', items };
    }
    if (this.is('{')) {
      this.next(); this.skipNl();
      if (this.isId('for')) return this.forExpr(true);
      const items: { k: Expr; v: Expr }[] = [];
      while (!this.is('}')) {
        let k: Expr;
        if (this.cur.k === 'id' && this.toks[this.p + 1] && this.toks[this.p + 1].k === 'p' && (this.toks[this.p + 1].v === '=' || this.toks[this.p + 1].v === ':')) k = { t: 'lit', v: this.next().v };
        else if (this.is('(')) { this.next(); k = this.expr(); this.expect(')'); } else k = this.expr();
        if (!(this.is('=') || this.is(':'))) throw new HclError('Missing key/value separator', this.cur.line, 'Expected an equals sign ("=") to mark the beginning of the attribute value.');
        this.next();
        const v = this.expr();
        items.push({ k, v });
        while (this.cur.k === 'nl' || this.is(',')) this.next();
      }
      this.expect('}');
      return { t: 'obj', items };
    }
    throw new HclError('Invalid expression', t.line, `Expected the start of an expression, but found ${t.k === 'eof' ? 'the end of the file' : t.k === 'nl' ? 'a newline' : `"${t.v}"`}.`);
  }
  forExpr(isObj: boolean): Expr {
    this.next();
    let key: string | undefined;
    let val = this.next().v;
    if (this.is(',')) { this.next(); key = val; val = this.next().v; }
    if (!this.isId('in')) throw new HclError('Invalid for expression', this.cur.line, 'Expected the "in" keyword.');
    this.next();
    const coll = this.expr();
    this.expect(':');
    this.skipNl();
    let k: Expr | undefined;
    let v = this.expr();
    if (this.is('=>')) { this.next(); k = v; v = this.expr(); }
    let cond: Expr | undefined;
    this.skipNl();
    if (this.isId('if')) { this.next(); cond = this.expr(); }
    this.skipNl();
    this.expect(isObj ? '}' : ']');
    return { t: 'for', key, val, coll, k, v, isObj, cond };
  }
  exprAll(): Expr {
    const e = this.expr();
    this.skipNl();
    if (this.cur.k !== 'eof') throw new HclError('Invalid template interpolation', this.cur.line, 'Extra characters after the interpolation expression.');
    return e;
  }
}

export function parseHcl(src: string): Body {
  return new Parser(tokenize(src)).parseBody(true);
}

// ------------------------------------------------------------------ referencias (grafo de dependencias)

/** Referencias de primer nivel de una expresión: [raíz, primer atributo] (p. ej. ['aws_vpc','main'] se devuelve como "aws_vpc.main"). */
export function refsOf(e: Expr, out: Set<string> = new Set()): Set<string> {
  const walkStep = (s: Step) => { if (s.k === 'idx') refsOf(s.e, out); };
  switch (e.t) {
    case 'ref': {
      const first = e.steps[0]?.k === 'attr' ? (e.steps[0] as any).name : '';
      if (e.root === 'data') { const second = e.steps[1]?.k === 'attr' ? (e.steps[1] as any).name : ''; out.add(`data.${first}.${second}`); }
      else if (['var', 'local', 'each', 'count', 'path', 'terraform', 'self'].includes(e.root)) out.add(`${e.root}.${first}`);
      else out.add(`${e.root}.${first}`);
      e.steps.forEach(walkStep);
      break;
    }
    case 'tmpl': e.parts.forEach((p) => typeof p !== 'string' && refsOf(p, out)); break;
    case 'list': e.items.forEach((x) => refsOf(x, out)); break;
    case 'obj': e.items.forEach((x) => { refsOf(x.k, out); refsOf(x.v, out); }); break;
    case 'call': e.args.forEach((x) => refsOf(x, out)); break;
    case 'cond': refsOf(e.c, out); refsOf(e.a, out); refsOf(e.b, out); break;
    case 'bin': refsOf(e.l, out); refsOf(e.r, out); break;
    case 'un': refsOf(e.e, out); break;
    case 'for': refsOf(e.coll, out); if (e.k) refsOf(e.k, out); refsOf(e.v, out); if (e.cond) refsOf(e.cond, out); break;
    case 'idxe': refsOf(e.e, out); walkStep(e.step); break;
  }
  return out;
}

export function bodyRefs(b: Body, out: Set<string> = new Set()): Set<string> {
  for (const a of Object.values(b.attrs)) refsOf(a.e, out);
  for (const bl of b.blocks) bodyRefs(bl.body, out);
  return out;
}

// ------------------------------------------------------------------ evaluación

export interface Scope {
  /** Resuelve la raíz de una referencia (var, local, recurso, data...) a un valor. */
  resolve(root: string, steps: Step[], evalIdx: (e: Expr) => any): any;
  locals?: Record<string, any>;
}

export class EvalError extends Error {
  constructor(msg: string, public detail: string, public line = 0) {
    super(msg);
  }
}

const isUnknown = (v: any) => v === UNKNOWN;
const hasUnknown = (v: any): boolean => v === UNKNOWN || (Array.isArray(v) && v.some(hasUnknown)) || (v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).some(hasUnknown));

export function toStr(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') throw new EvalError('Invalid template interpolation value', 'Cannot include the given value in a string template: string required.');
  return String(v);
}

export function evaluate(e: Expr, sc: Scope, loc: Record<string, any> = {}): any {
  const ev = (x: Expr, l = loc) => evaluate(x, sc, l);
  switch (e.t) {
    case 'lit': return e.v;
    case 'tmpl': {
      let s = '';
      for (const p of e.parts) {
        if (typeof p === 'string') { s += p; continue; }
        const v = ev(p);
        if (isUnknown(v) || hasUnknown(v)) return UNKNOWN;
        s += toStr(v);
      }
      return s;
    }
    case 'list': return e.items.map((x) => ev(x));
    case 'obj': {
      const o: Record<string, any> = {};
      for (const it of e.items) { const k = ev(it.k); if (isUnknown(k)) return UNKNOWN; o[toStr(k)] = ev(it.v); }
      return o;
    }
    case 'ref': {
      if (e.root in loc) return walk(loc[e.root], e.steps, ev, e.line);
      return sc.resolve(e.root, e.steps, (x) => ev(x));
    }
    case 'idxe': return walk(ev(e.e), [e.step], ev, 0);
    case 'un': { const v = ev(e.e); if (isUnknown(v)) return UNKNOWN; return e.op === '!' ? !v : -Number(v); }
    case 'cond': { const c = ev(e.c); if (isUnknown(c)) return UNKNOWN; return c ? ev(e.a) : ev(e.b); }
    case 'bin': {
      if (e.op === '&&' || e.op === '||') {
        const l = ev(e.l);
        if (isUnknown(l)) return UNKNOWN;
        if (e.op === '&&' ? !l : l) return !!l;
        const r = ev(e.r);
        return isUnknown(r) ? UNKNOWN : !!r;
      }
      const l = ev(e.l), r = ev(e.r);
      if (isUnknown(l) || isUnknown(r)) return UNKNOWN;
      switch (e.op) {
        case '==': return JSON.stringify(l) === JSON.stringify(r);
        case '!=': return JSON.stringify(l) !== JSON.stringify(r);
        case '<': return Number(l) < Number(r);
        case '>': return Number(l) > Number(r);
        case '<=': return Number(l) <= Number(r);
        case '>=': return Number(l) >= Number(r);
        case '+': return Number(l) + Number(r);
        case '-': return Number(l) - Number(r);
        case '*': return Number(l) * Number(r);
        case '/': return Number(l) / Number(r);
        default: return Number(l) % Number(r);
      }
    }
    case 'for': {
      const coll = ev(e.coll);
      if (isUnknown(coll)) return UNKNOWN;
      const entries: [any, any][] = Array.isArray(coll) ? coll.map((v, i) => [i, v]) : Object.entries(coll ?? {});
      const outL: any[] = [];
      const outO: Record<string, any> = {};
      for (const [k, v] of entries) {
        const l2 = { ...loc, [e.val]: v, ...(e.key ? { [e.key]: k } : {}) };
        if (e.cond) { const c = ev(e.cond, l2); if (isUnknown(c)) return UNKNOWN; if (!c) continue; }
        if (e.isObj) outO[toStr(ev(e.k!, l2))] = ev(e.v, l2);
        else outL.push(ev(e.v, l2));
      }
      return e.isObj ? outO : outL;
    }
    case 'call': {
      const f = FUNCS[e.fn];
      if (!f) throw new EvalError('Call to unknown function', `There is no function named "${e.fn}".`, e.line);
      if (e.fn === 'try') { for (const a of e.args) { try { const v = ev(a); if (!isUnknown(v)) return v; return v; } catch { /* siguiente */ } } throw new EvalError('Error in function call', 'Call to function "try" failed: no expression succeeded.', e.line); }
      if (e.fn === 'can') { try { ev(e.args[0]); return true; } catch { return false; } }
      const args = e.args.map((a) => ev(a));
      if (args.some((a) => isUnknown(a) || (e.fn !== 'jsonencode' && hasUnknown(a)))) return UNKNOWN;
      try {
        return f(...args);
      } catch (err) {
        if (err instanceof EvalError) throw err;
        throw new EvalError('Error in function call', `Call to function "${e.fn}" failed: ${(err as Error).message}.`, e.line);
      }
    }
  }
}

function walk(v: any, steps: Step[], ev: (x: Expr) => any, line: number): any {
  for (let i = 0; i < steps.length; i++) {
    if (isUnknown(v)) return UNKNOWN;
    const s = steps[i];
    if (s.k === 'splat') {
      const rest = steps.slice(i + 1);
      const list = Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
      return list.map((x) => walk(x, rest, ev, line));
    }
    if (s.k === 'attr') {
      if (v === null || v === undefined) throw new EvalError('Attempt to get attribute from null value', `This value is null, so it does not have any attributes.`, line);
      if (typeof v !== 'object' || !(s.name in v)) throw new EvalError('Unsupported attribute', `This object does not have an attribute named "${s.name}".`, line);
      v = v[s.name];
    } else {
      const ix = ev(s.e);
      if (isUnknown(ix)) return UNKNOWN;
      if (v === null || v === undefined || typeof v !== 'object') throw new EvalError('Invalid index', 'This value does not have any indices.', line);
      if (Array.isArray(v)) { if (typeof ix !== 'number' || ix < 0 || ix >= v.length) throw new EvalError('Invalid index', `The given key does not identify an element in this collection value: the given index is out of range.`, line); v = v[ix]; }
      else { if (!(String(ix) in v)) throw new EvalError('Invalid index', 'The given key does not identify an element in this collection value.', line); v = v[String(ix)]; }
    }
  }
  return v;
}

// ------------------------------------------------------------------ funciones

const ip2n = (ip: string) => ip.split('.').reduce((a, b) => a * 256 + Number(b), 0);
const n2ip = (n: number) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');

function cidrsubnet(prefix: string, newbits: number, netnum: number): string {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(prefix);
  if (!m) throw new Error(`invalid CIDR expression: ${prefix}`);
  const len = Number(m[2]) + newbits;
  if (len > 32) throw new Error(`insufficient address space to extend prefix of ${m[2]} by ${newbits}`);
  if (netnum >= 2 ** newbits) throw new Error(`prefix extension of ${newbits} does not accommodate a subnet numbered ${netnum}`);
  const base = Math.floor(ip2n(m[1]) / 2 ** (32 - Number(m[2]))) * 2 ** (32 - Number(m[2]));
  return `${n2ip(base + netnum * 2 ** (32 - len))}/${len}`;
}
function cidrhost(prefix: string, hostnum: number): string {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(prefix);
  if (!m) throw new Error(`invalid CIDR expression: ${prefix}`);
  const base = Math.floor(ip2n(m[1]) / 2 ** (32 - Number(m[2]))) * 2 ** (32 - Number(m[2]));
  return n2ip(base + hostnum);
}

function format(fmt: string, ...args: any[]): string {
  let i = 0;
  return fmt.replace(/%(\d*)([sdvf%])/g, (_m, w, c) => {
    if (c === '%') return '%';
    const a = args[i++];
    let s = c === 'd' ? String(Math.trunc(Number(a))) : typeof a === 'object' ? JSON.stringify(a) : String(a);
    if (w) s = s.padStart(Number(w), c === 'd' ? '0' : ' ');
    return s;
  });
}

export const FUNCS: Record<string, (...a: any[]) => any> = {
  lower: (s) => String(s).toLowerCase(), upper: (s) => String(s).toUpperCase(), title: (s) => String(s).replace(/\b\w/g, (c) => c.toUpperCase()),
  trimspace: (s) => String(s).trim(), trimprefix: (s, p) => (String(s).startsWith(p) ? String(s).slice(p.length) : s), trimsuffix: (s, p) => (String(s).endsWith(p) ? String(s).slice(0, -p.length) : s),
  replace: (s, a, b) => String(s).split(a).join(b), substr: (s, o, l) => String(s).substr(o, l < 0 ? undefined : l), startswith: (s, p) => String(s).startsWith(p), endswith: (s, p) => String(s).endsWith(p),
  format, formatlist: (f, l) => (l as any[]).map((x) => format(f, x)), join: (sep, l) => (l as any[]).join(sep), split: (sep, s) => String(s).split(sep),
  concat: (...l) => ([] as any[]).concat(...l), flatten: (l) => (l as any[]).flat(Infinity), distinct: (l) => [...new Set(l as any[])], sort: (l) => [...(l as string[])].sort(), reverse: (l) => [...l].reverse(),
  length: (v) => (typeof v === 'string' || Array.isArray(v) ? v.length : Object.keys(v ?? {}).length), element: (l, i) => l[((i % l.length) + l.length) % l.length], contains: (l, v) => (l as any[]).includes(v),
  index: (l, v) => (l as any[]).indexOf(v), slice: (l, a, b) => (l as any[]).slice(a, b), range: (a: number, b?: number, s = 1) => { const r: number[] = []; const [x, y] = b === undefined ? [0, a] : [a, b]; for (let i = x; s > 0 ? i < y : i > y; i += s) r.push(i); return r; },
  merge: (...o) => Object.assign({}, ...o.filter(Boolean)), keys: (o) => Object.keys(o).sort(), values: (o) => Object.keys(o).sort().map((k) => o[k]), lookup: (o, k, d) => (o && k in o ? o[k] : d),
  zipmap: (k, v) => Object.fromEntries((k as string[]).map((x, i) => [x, v[i]])), toset: (l) => [...new Set(l as any[])].sort(), tolist: (l) => [...l], tomap: (o) => o, tostring: (v) => String(v), tonumber: (v) => Number(v), tobool: (v) => v === true || v === 'true',
  coalesce: (...a) => { const r = a.find((x) => x !== null && x !== undefined && x !== ''); if (r === undefined) throw new Error('no non-null, non-empty-string arguments'); return r; },
  max: (...a) => Math.max(...a.flat()), min: (...a) => Math.min(...a.flat()), abs: Math.abs, ceil: Math.ceil, floor: Math.floor, pow: Math.pow,
  jsonencode: (v) => JSON.stringify(v), jsondecode: (s) => JSON.parse(s), base64encode: (s) => btoa(String(s)), base64decode: (s) => atob(String(s)),
  cidrsubnet, cidrhost, md5: (s) => String(s).length.toString(16).padStart(32, '0'), uuid: () => '00000000-0000-4000-8000-000000000000', timestamp: () => new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  try: () => undefined, can: () => undefined, file: () => { throw new Error('file() no está disponible en el simulador'); },
};

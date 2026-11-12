// Subconjunto de awk: patrones, BEGIN/END, campos, variables, arrays asociativos, printf y las funciones habituales.
import { registerCommand, ok, fail } from './interp';
import { abs, readInputs } from './commands';
import { formatPrintf, toJsRegex } from './textutils';

class AwkError extends Error {}
/** Cadena procedente de la entrada: se compara como número si lo parece. */
class SN {
  constructor(public s: string) {}
}
type Val = number | string | SN | undefined;

const looksNum = (s: string) => /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(s);
const toNum = (v: Val): number => {
  if (typeof v === 'number') return v;
  if (v === undefined) return 0;
  const m = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(v instanceof SN ? v.s : v);
  return m ? parseFloat(m[0]) : 0;
};
const numStr = (n: number): string => (Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(6))));
const toStr = (v: Val): string => (typeof v === 'number' ? numStr(v) : v === undefined ? '' : v instanceof SN ? v.s : v);
const truthy = (v: Val): boolean => (typeof v === 'number' ? v !== 0 : v === undefined ? false : v instanceof SN ? (looksNum(v.s) ? parseFloat(v.s) !== 0 : v.s !== '') : v !== '');

// ---------------------------------------------------------------- análisis léxico

type Tok = { k: 'num' | 'str' | 're' | 'id' | 'fn' | 'op' | 'nl' | 'eof'; v: string };
const KW = new Set(['BEGIN', 'END', 'if', 'else', 'while', 'for', 'in', 'next', 'exit', 'print', 'printf', 'delete']);
const FUNCS = new Set(['length', 'substr', 'index', 'split', 'sub', 'gsub', 'tolower', 'toupper', 'sprintf', 'int', 'sqrt', 'log', 'exp', 'match']);

function lex(src: string): Tok[] {
  const t: Tok[] = [];
  let i = 0;
  const regexOk = () => {
    const p = t[t.length - 1];
    return !p || p.k === 'nl' || (p.k === 'op' && !')]'.includes(p.v) && p.v !== '++' && p.v !== '--') || (p.k === 'id' && KW.has(p.v));
  };
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '\n') { t.push({ k: 'nl', v: '\n' }); i++; continue; }
    if (/\d|\./.test(c) && /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.test(src.slice(i))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i))!;
      t.push({ k: 'num', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (c === '"') {
      let s = '';
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') {
          const n = src[i + 1];
          s += ({ n: '\n', t: '\t', '\\': '\\', '"': '"', '/': '/', r: '\r' } as Record<string, string>)[n] ?? '\\' + n;
          i += 2;
        } else s += src[i++];
      }
      if (i >= src.length) throw new AwkError('non-terminated string');
      i++;
      t.push({ k: 'str', v: s });
      continue;
    }
    if (c === '/' && regexOk()) {
      let s = '';
      i++;
      while (i < src.length && src[i] !== '/') {
        if (src[i] === '\\' && src[i + 1] === '/') { s += '/'; i += 2; } else if (src[i] === '\\') { s += src[i] + src[i + 1]; i += 2; } else s += src[i++];
      }
      i++;
      t.push({ k: 're', v: s });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      i += m[0].length;
      t.push({ k: FUNCS.has(m[0]) && src[i] === '(' ? 'fn' : 'id', v: m[0] });
      continue;
    }
    const op = ['&&', '||', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '^=', '++', '--', '!~', '>>'].find((o) => src.startsWith(o, i));
    if (op) { t.push({ k: 'op', v: op }); i += op.length; continue; }
    t.push({ k: 'op', v: c });
    i++;
  }
  t.push({ k: 'eof', v: '' });
  return t;
}

// ---------------------------------------------------------------- árbol

type E =
  | { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 're'; v: string }
  | { t: 'var'; n: string } | { t: 'idx'; n: string; i: E } | { t: 'field'; i: E }
  | { t: 'asg'; op: string; l: E; r: E } | { t: 'inc'; l: E; d: number; post: boolean }
  | { t: 'bin'; op: string; a: E; b: E } | { t: 'un'; op: string; a: E } | { t: 'cond'; c: E; a: E; b: E }
  | { t: 'cat'; a: E; b: E } | { t: 'call'; f: string; args: E[] } | { t: 'in'; k: E; n: string } | { t: 'match'; neg: boolean; a: E; re: E };
type S =
  | { t: 'print'; args: E[]; out?: { file: E; append: boolean } } | { t: 'printf'; args: E[]; out?: { file: E; append: boolean } }
  | { t: 'expr'; e: E } | { t: 'if'; c: E; a: S; b?: S } | { t: 'while'; c: E; body: S }
  | { t: 'for'; init?: S; c?: E; step?: S; body: S } | { t: 'forin'; v: string; n: string; body: S }
  | { t: 'block'; s: S[] } | { t: 'next' } | { t: 'exit'; e?: E } | { t: 'delete'; n: string; i?: E };
interface Rule { kind: 'begin' | 'end' | 'main'; pat?: E; pat2?: E; body?: S; on?: boolean }

class Parser {
  i = 0;
  constructor(private t: Tok[]) {}
  private get cur() { return this.t[this.i]; }
  private isOp(v: string) { return this.cur.k === 'op' && this.cur.v === v; }
  private isId(v: string) { return this.cur.k === 'id' && this.cur.v === v; }
  private eat(v: string) { if (!this.isOp(v)) throw new AwkError(`syntax error at source line 1: expected '${v}' near '${this.cur.v}'`); this.i++; }
  private skipTerm() { while (this.cur.k === 'nl' || this.isOp(';')) this.i++; }
  private skipNl() { while (this.cur.k === 'nl') this.i++; }

  program(): Rule[] {
    const rules: Rule[] = [];
    this.skipTerm();
    while (this.cur.k !== 'eof') {
      if (this.isId('BEGIN')) { this.i++; rules.push({ kind: 'begin', body: this.block() }); }
      else if (this.isId('END')) { this.i++; rules.push({ kind: 'end', body: this.block() }); }
      else {
        const r: Rule = { kind: 'main' };
        if (!this.isOp('{')) {
          r.pat = this.expr();
          if (this.isOp(',')) { this.i++; r.pat2 = this.expr(); }
        }
        if (this.isOp('{')) r.body = this.block();
        rules.push(r);
      }
      this.skipTerm();
    }
    return rules;
  }
  block(): S {
    this.eat('{');
    const s: S[] = [];
    this.skipTerm();
    while (!this.isOp('}')) {
      if (this.cur.k === 'eof') throw new AwkError('syntax error: missing }');
      s.push(this.stmt());
      this.skipTerm();
    }
    this.eat('}');
    return { t: 'block', s };
  }
  private simpleEnd() { return this.cur.k === 'nl' || this.isOp(';') || this.isOp('}') || this.cur.k === 'eof'; }
  stmt(): S {
    if (this.isOp('{')) return this.block();
    if (this.isId('if')) {
      this.i++; this.eat('(');
      const c = this.expr();
      this.eat(')'); this.skipNl();
      const a = this.stmt();
      const save = this.i;
      this.skipTerm();
      if (this.isId('else')) { this.i++; this.skipNl(); return { t: 'if', c, a, b: this.stmt() }; }
      this.i = save;
      return { t: 'if', c, a };
    }
    if (this.isId('while')) {
      this.i++; this.eat('(');
      const c = this.expr();
      this.eat(')'); this.skipNl();
      return { t: 'while', c, body: this.stmt() };
    }
    if (this.isId('for')) {
      this.i++; this.eat('(');
      if (this.cur.k === 'id' && this.t[this.i + 1]?.v === 'in' && this.t[this.i + 3]?.v === ')') {
        const v = this.cur.v; const n = this.t[this.i + 2].v;
        this.i += 4; this.skipNl();
        return { t: 'forin', v, n, body: this.stmt() };
      }
      const init = this.isOp(';') ? undefined : this.simple();
      this.eat(';');
      const c = this.isOp(';') ? undefined : this.expr();
      this.eat(';');
      const step = this.isOp(')') ? undefined : this.simple();
      this.eat(')'); this.skipNl();
      return { t: 'for', init, c, step, body: this.stmt() };
    }
    return this.simple();
  }
  simple(): S {
    if (this.isId('next')) { this.i++; return { t: 'next' }; }
    if (this.isId('exit')) { this.i++; return { t: 'exit', e: this.simpleEnd() ? undefined : this.expr() }; }
    if (this.isId('delete')) {
      this.i++;
      const n = this.cur.v; this.i++;
      if (this.isOp('[')) { this.i++; const i = this.expr(); this.eat(']'); return { t: 'delete', n, i }; }
      return { t: 'delete', n };
    }
    if (this.isId('print') || this.isId('printf')) {
      const isF = this.cur.v === 'printf';
      this.i++;
      const args: E[] = [];
      if (!this.simpleEnd() && !this.isOp('>') && !this.isOp('>>')) {
        const paren = this.isOp('(');
        args.push(this.expr(true));
        while (this.isOp(',')) { this.i++; this.skipNl(); args.push(this.expr(true)); }
        void paren;
      }
      let out: { file: E; append: boolean } | undefined;
      if (this.isOp('>') || this.isOp('>>')) { const append = this.cur.v === '>>'; this.i++; out = { file: this.primary(), append }; }
      return isF ? { t: 'printf', args, out } : { t: 'print', args, out };
    }
    return { t: 'expr', e: this.expr() };
  }

  // Expresiones. `noGt`: dentro de print, `>` redirige en lugar de comparar.
  expr(noGt = false): E { return this.ternary(noGt); }
  private ternary(g: boolean): E {
    const c = this.or(g);
    if (this.isOp('?')) {
      this.i++;
      const a = this.ternary(g);
      this.eat(':');
      return { t: 'cond', c, a, b: this.ternary(g) };
    }
    if (this.cur.k === 'op' && ['=', '+=', '-=', '*=', '/=', '%=', '^='].includes(this.cur.v) && (c.t === 'var' || c.t === 'idx' || c.t === 'field')) {
      const op = this.cur.v; this.i++;
      return { t: 'asg', op, l: c, r: this.ternary(g) };
    }
    return c;
  }
  private or(g: boolean): E {
    let a = this.and(g);
    while (this.isOp('||')) { this.i++; this.skipNl(); a = { t: 'bin', op: '||', a, b: this.and(g) }; }
    return a;
  }
  private and(g: boolean): E {
    let a = this.inn(g);
    while (this.isOp('&&')) { this.i++; this.skipNl(); a = { t: 'bin', op: '&&', a, b: this.inn(g) }; }
    return a;
  }
  private inn(g: boolean): E {
    let a = this.match(g);
    while (this.isId('in')) { this.i++; const n = this.cur.v; this.i++; a = { t: 'in', k: a, n }; }
    return a;
  }
  private match(g: boolean): E {
    let a = this.cmp(g);
    while (this.isOp('~') || this.isOp('!~')) { const neg = this.cur.v === '!~'; this.i++; a = { t: 'match', neg, a, re: this.cmp(g) }; }
    return a;
  }
  private cmp(g: boolean): E {
    const a = this.cat(g);
    const ops = g ? ['<', '<=', '==', '!=', '>='] : ['<', '<=', '==', '!=', '>', '>='];
    if (this.cur.k === 'op' && ops.includes(this.cur.v)) { const op = this.cur.v; this.i++; return { t: 'bin', op, a, b: this.cat(g) }; }
    return a;
  }
  private cat(g: boolean): E {
    let a = this.add();
    for (;;) {
      const c = this.cur;
      const starts = c.k === 'num' || c.k === 'str' || c.k === 'fn' || (c.k === 'id' && !KW.has(c.v)) || (c.k === 'op' && ['$', '(', '!', '-', '+'].includes(c.v) && c.v !== '-' && c.v !== '+') || c.k === 're';
      if (!starts || (c.k === 'id' && c.v === 'in')) break;
      a = { t: 'cat', a, b: this.add() };
      void g;
    }
    return a;
  }
  private add(): E {
    let a = this.mul();
    while (this.isOp('+') || this.isOp('-')) { const op = this.cur.v; this.i++; a = { t: 'bin', op, a, b: this.mul() }; }
    return a;
  }
  private mul(): E {
    let a = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) { const op = this.cur.v; this.i++; a = { t: 'bin', op, a, b: this.unary() }; }
    return a;
  }
  private unary(): E {
    if (this.isOp('!')) { this.i++; return { t: 'un', op: '!', a: this.unary() }; }
    if (this.isOp('-')) { this.i++; return { t: 'un', op: '-', a: this.unary() }; }
    if (this.isOp('+')) { this.i++; return { t: 'un', op: '+', a: this.unary() }; }
    return this.pow();
  }
  private pow(): E {
    const a = this.postfix();
    if (this.isOp('^')) { this.i++; return { t: 'bin', op: '^', a, b: this.unary() }; }
    return a;
  }
  private postfix(): E {
    if (this.isOp('++') || this.isOp('--')) { const d = this.cur.v === '++' ? 1 : -1; this.i++; return { t: 'inc', l: this.primary(), d, post: false }; }
    const p = this.primary();
    if ((this.isOp('++') || this.isOp('--')) && (p.t === 'var' || p.t === 'idx' || p.t === 'field')) { const d = this.cur.v === '++' ? 1 : -1; this.i++; return { t: 'inc', l: p, d, post: true }; }
    return p;
  }
  primary(): E {
    const c = this.cur;
    if (c.k === 'num') { this.i++; return { t: 'num', v: Number(c.v) }; }
    if (c.k === 'str') { this.i++; return { t: 'str', v: c.v }; }
    if (c.k === 're') { this.i++; return { t: 're', v: c.v }; }
    if (c.k === 'fn') {
      this.i++; this.eat('(');
      const args: E[] = [];
      if (!this.isOp(')')) { args.push(this.expr()); while (this.isOp(',')) { this.i++; args.push(this.expr()); } }
      this.eat(')');
      return { t: 'call', f: c.v, args };
    }
    if (c.k === 'op' && c.v === '$') { this.i++; return { t: 'field', i: this.primaryNoPost() }; }
    if (c.k === 'op' && c.v === '(') { this.i++; const e = this.expr(); this.eat(')'); return e; }
    if (c.k === 'id' && !KW.has(c.v)) {
      this.i++;
      if (this.isOp('[')) { this.i++; const i = this.expr(); this.eat(']'); return { t: 'idx', n: c.v, i }; }
      return { t: 'var', n: c.v };
    }
    throw new AwkError(`syntax error at source line 1 near '${c.v || 'end of program'}'`);
  }
  private primaryNoPost(): E {
    if (this.isOp('-')) { this.i++; return { t: 'un', op: '-', a: this.primaryNoPost() }; }
    if (this.isOp('++') || this.isOp('--')) return this.postfix();
    return this.primary();
  }
}

// ---------------------------------------------------------------- intérprete

class NextSignal {}
class ExitSignal { constructor(public code: number) {} }

function runAwk(src: string, text: string, fsArg: string | undefined, assigns: Record<string, string>, filename: string): { out: string; files: Record<string, { text: string; append: boolean }>; code: number } {
  const rules = new Parser(lex(src)).program();
  const vars: Record<string, Val> = { FS: fsArg ?? ' ', OFS: ' ', ORS: '\n', NR: 0, NF: 0, FILENAME: filename };
  for (const [k, v] of Object.entries(assigns)) vars[k] = new SN(v);
  const arrays: Record<string, Map<string, Val>> = {};
  const arr = (n: string) => (arrays[n] ??= new Map());
  let out = '';
  const files: Record<string, { text: string; append: boolean }> = {};
  let fields: string[] = [];
  let record = '';
  const reCache = new Map<string, RegExp>();
  const mkRe = (s: string, g = false): RegExp => {
    const key = (g ? 'g:' : '') + s;
    let r = reCache.get(key);
    if (!r) {
      try { r = new RegExp(toJsRegex(s, true), g ? 'g' : ''); } catch { throw new AwkError(`invalid regular expression: ${s}`); }
      reCache.set(key, r);
    }
    r.lastIndex = 0;
    return r;
  };
  const split = (line: string): string[] => {
    const fs = toStr(vars.FS);
    if (line === '') return [];
    if (fs === ' ') return line.trim() === '' ? [] : line.trim().split(/[ \t]+/);
    if (fs.length === 1 && fs !== '\\') return line.split(fs === '|' ? '|' : fs);
    return line.split(mkRe(fs));
  };
  const setRecord = (line: string) => { record = line; fields = split(line); vars.NF = fields.length; };
  const rebuild = () => { record = fields.join(toStr(vars.OFS)); vars.NF = fields.length; };
  const getField = (n: number): Val => (n === 0 ? new SN(record) : n < 0 ? (() => { throw new AwkError(`attempt to access field ${n}`); })() : n <= fields.length ? new SN(fields[n - 1]) : undefined);
  const setField = (n: number, v: string) => {
    if (n === 0) { setRecord(v); return; }
    while (fields.length < n) fields.push('');
    fields[n - 1] = v;
    rebuild();
  };
  const cmpVals = (a: Val, b: Val): number => {
    const numA = typeof a === 'number' || a === undefined || (a instanceof SN && looksNum(a.s));
    const numB = typeof b === 'number' || b === undefined || (b instanceof SN && looksNum(b.s));
    if (numA && numB) return toNum(a) - toNum(b);
    const x = toStr(a), y = toStr(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const ev = (e: E): Val => {
    switch (e.t) {
      case 'num': return e.v;
      case 'str': return e.v;
      case 're': return mkRe(e.v).test(record) ? 1 : 0;
      case 'var': return vars[e.n];
      case 'idx': return arr(e.n).get(toStr(ev(e.i)));
      case 'field': return getField(Math.trunc(toNum(ev(e.i))));
      case 'asg': {
        const r = ev(e.r);
        let v: Val = r;
        if (e.op !== '=') {
          const cur = toNum(ev(e.l));
          const x = toNum(r);
          v = e.op === '+=' ? cur + x : e.op === '-=' ? cur - x : e.op === '*=' ? cur * x : e.op === '/=' ? cur / x : e.op === '%=' ? cur % x : cur ** x;
        }
        assign(e.l, v);
        return v;
      }
      case 'inc': {
        const cur = toNum(ev(e.l));
        assign(e.l, cur + e.d);
        return e.post ? cur : cur + e.d;
      }
      case 'bin': {
        if (e.op === '&&') return truthy(ev(e.a)) && truthy(ev(e.b)) ? 1 : 0;
        if (e.op === '||') return truthy(ev(e.a)) || truthy(ev(e.b)) ? 1 : 0;
        const a = ev(e.a), b = ev(e.b);
        switch (e.op) {
          case '+': return toNum(a) + toNum(b);
          case '-': return toNum(a) - toNum(b);
          case '*': return toNum(a) * toNum(b);
          case '/': if (toNum(b) === 0) throw new AwkError('division by zero'); return toNum(a) / toNum(b);
          case '%': if (toNum(b) === 0) throw new AwkError('division by zero in %'); return toNum(a) % toNum(b);
          case '^': return toNum(a) ** toNum(b);
          case '<': return cmpVals(a, b) < 0 ? 1 : 0;
          case '<=': return cmpVals(a, b) <= 0 ? 1 : 0;
          case '>': return cmpVals(a, b) > 0 ? 1 : 0;
          case '>=': return cmpVals(a, b) >= 0 ? 1 : 0;
          case '==': return cmpVals(a, b) === 0 ? 1 : 0;
          default: return cmpVals(a, b) !== 0 ? 1 : 0;
        }
      }
      case 'un': { const v = ev(e.a); return e.op === '!' ? (truthy(v) ? 0 : 1) : e.op === '-' ? -toNum(v) : toNum(v); }
      case 'cond': return truthy(ev(e.c)) ? ev(e.a) : ev(e.b);
      case 'cat': return toStr(ev(e.a)) + toStr(ev(e.b));
      case 'in': return arr(e.n).has(toStr(ev(e.k))) ? 1 : 0;
      case 'match': { const re = e.re.t === 're' ? mkRe(e.re.v) : mkRe(toStr(ev(e.re))); return re.test(toStr(ev(e.a))) !== e.neg ? 1 : 0; }
      case 'call': return call(e.f, e.args);
    }
  };
  const assign = (l: E, v: Val) => {
    if (l.t === 'var') { vars[l.n] = v; if (l.n === 'NF') { const n = toNum(v); fields = fields.slice(0, n); while (fields.length < n) fields.push(''); rebuild(); } }
    else if (l.t === 'idx') arr(l.n).set(toStr(ev(l.i)), v);
    else if (l.t === 'field') setField(Math.trunc(toNum(ev(l.i))), toStr(v));
  };
  const call = (f: string, a: E[]): Val => {
    const s = (k: number) => toStr(ev(a[k]));
    switch (f) {
      case 'length': return a.length ? (a[0].t === 'var' && arrays[a[0].n] ? arrays[a[0].n].size : s(0).length) : record.length;
      case 'substr': { const str = s(0); let m = Math.trunc(toNum(ev(a[1]))); let n = a[2] ? Math.trunc(toNum(ev(a[2]))) : str.length; if (m < 1) { n += m - 1; m = 1; } return n <= 0 ? '' : str.substr(m - 1, n); }
      case 'index': return s(0).indexOf(s(1)) + 1;
      case 'tolower': return s(0).toLowerCase();
      case 'toupper': return s(0).toUpperCase();
      case 'int': return Math.trunc(toNum(ev(a[0])));
      case 'sqrt': return Math.sqrt(toNum(ev(a[0])));
      case 'log': return Math.log(toNum(ev(a[0])));
      case 'exp': return Math.exp(toNum(ev(a[0])));
      case 'sprintf': return formatPrintf(s(0), a.slice(1).map((_x, i) => toStr(ev(a[i + 1]))));
      case 'split': {
        const target = a[1].t === 'var' ? a[1].n : '';
        const sep = a[2] ? (a[2].t === 're' ? a[2].v : s(2)) : toStr(vars.FS);
        const str = s(0);
        const parts = str === '' ? [] : sep === ' ' ? str.trim().split(/[ \t\n]+/) : sep.length === 1 ? str.split(sep) : str.split(mkRe(sep));
        const m = arr(target);
        m.clear();
        parts.forEach((p, i) => m.set(String(i + 1), new SN(p)));
        return parts.length;
      }
      case 'match': { const m = mkRe(a[1].t === 're' ? a[1].v : s(1)).exec(s(0)); vars.RSTART = m ? m.index + 1 : 0; vars.RLENGTH = m ? m[0].length : -1; return m ? m.index + 1 : 0; }
      case 'sub': case 'gsub': {
        const re = mkRe(a[0].t === 're' ? a[0].v : s(0), f === 'gsub');
        const target: E = a[2] ?? { t: 'field', i: { t: 'num', v: 0 } };
        const str = toStr(ev(target));
        const rep = s(1);
        let n = 0;
        const res = str.replace(re, (m) => { n++; return rep.replace(/\\&/g, '\u0000').replace(/&/g, m).replace(/\u0000/g, '&'); });
        if (n) assign(target, res);
        return n;
      }
    }
    throw new AwkError(`function ${f} not defined`);
  };
  const emit = (text2: string, o?: { file: E; append: boolean }) => {
    if (!o) { out += text2; return; }
    const name = toStr(ev(o.file));
    files[name] ??= { text: '', append: o.append };
    files[name].text += text2;
  };
  const exec = (s: S): void => {
    switch (s.t) {
      case 'block': for (const x of s.s) exec(x); return;
      case 'expr': ev(s.e); return;
      case 'print': emit((s.args.length ? s.args.map((x) => toStr(ev(x))).join(toStr(vars.OFS)) : record) + toStr(vars.ORS), s.out); return;
      case 'printf': emit(formatPrintf(toStr(ev(s.args[0])), s.args.slice(1).map((x) => toStr(ev(x)))), s.out); return;
      case 'if': if (truthy(ev(s.c))) exec(s.a); else if (s.b) exec(s.b); return;
      case 'while': for (let g = 0; truthy(ev(s.c)) && g < 100000; g++) exec(s.body); return;
      case 'for': if (s.init) exec(s.init); for (let g = 0; (!s.c || truthy(ev(s.c))) && g < 100000; g++) { exec(s.body); if (s.step) exec(s.step); } return;
      case 'forin': for (const k of [...arr(s.n).keys()]) { vars[s.v] = new SN(k); exec(s.body); } return;
      case 'next': throw new NextSignal();
      case 'exit': throw new ExitSignal(s.e ? Math.trunc(toNum(ev(s.e))) : 0);
      case 'delete': if (s.i) arr(s.n).delete(toStr(ev(s.i))); else arr(s.n).clear(); return;
    }
  };
  let code = 0;
  try {
    for (const r of rules) if (r.kind === 'begin') exec(r.body!);
    if (rules.some((r) => r.kind !== 'begin')) {
      const ls = text === '' ? [] : text.replace(/\n$/, '').split('\n');
      for (const line of ls) {
        vars.NR = toNum(vars.NR) + 1;
        setRecord(line);
        try {
          for (const r of rules) {
            if (r.kind !== 'main') continue;
            let hit = true;
            if (r.pat && r.pat2) {
              if (!r.on) { if (truthy(ev(r.pat))) { r.on = true; hit = true; if (truthy(ev(r.pat2))) r.on = false; } else hit = false; }
              else if (truthy(ev(r.pat2))) r.on = false;
            } else if (r.pat) hit = truthy(ev(r.pat));
            if (hit) { if (r.body) exec(r.body); else out += record + toStr(vars.ORS); }
          }
        } catch (e) {
          if (!(e instanceof NextSignal)) throw e;
        }
      }
    }
  } catch (e) {
    if (e instanceof ExitSignal) code = e.code;
    else throw e;
  }
  try {
    for (const r of rules) if (r.kind === 'end') exec(r.body!);
  } catch (e) {
    if (e instanceof ExitSignal) code = e.code;
    else if (!(e instanceof NextSignal)) throw e;
  }
  return { out, files, code };
}

registerCommand('awk', (args, { sh, stdin }) => {
  let fsArg: string | undefined;
  const assigns: Record<string, string> = {};
  let prog: string | undefined;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-F') fsArg = args[++i];
    else if (a.startsWith('-F') && prog === undefined) fsArg = a.slice(2);
    else if (a === '-v') { const [k, ...v] = (args[++i] ?? '').split('='); assigns[k] = v.join('='); }
    else if (a === '-f') { const r = readInputs(sh, [args[++i] ?? ''], ''); if ('err' in r) return fail(`awk: can't open file ${args[i]}`, 2); prog = r.text; }
    else if (a === '--') continue;
    else if (prog === undefined) prog = a;
    else files.push(a);
  }
  if (prog === undefined) return fail('usage: awk [-F fs][-v var=value][prog | -f progfile][file ...]', 2);
  if (fsArg === '\\t') fsArg = '\t';
  const r = readInputs(sh, files, stdin);
  if ('err' in r) return fail(`awk: cannot open "${files[0]}" (No such file or directory)`, 2);
  try {
    const res = runAwk(prog, r.text, fsArg, assigns, files[0] ?? '');
    for (const [name, f] of Object.entries(res.files)) sh.fs.writeFile(abs(sh, name), f.text, f.append);
    return { out: res.out, err: '', code: res.code };
  } catch (e) {
    if (e instanceof AwkError) return fail(`awk: ${e.message}`, 2);
    throw e;
  }
});

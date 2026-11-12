// Subconjunto de jq suficiente para trabajar con las salidas JSON del CLI de AWS:
// rutas (.a.b[0]), iteración (.[]), tuberías, select, map, keys, length, to_entries, comparaciones,
// construcción de objetos/arrays básicos y funciones habituales (first, last, sort, unique, join, tostring, not, has...).

type J = any;
class JqError extends Error {}
export { JqError };

type Tok = { k: string; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const n = src[j + 1];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          j += 2;
        } else s += src[j++];
      }
      out.push({ k: 'str', v: s });
      i = j + 1;
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num && !(out.length && ['id', 'num', 'str', ')', ']'].includes(out[out.length - 1].k) && num[0].startsWith('-'))) {
      out.push({ k: 'num', v: num[0] });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      out.push({ k: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    const op = ['==', '!=', '<=', '>=', '//', '..', '|', ',', '(', ')', '[', ']', '{', '}', ':', '.', '<', '>', '+', '-', '*', '/', '?'].find((o) => src.startsWith(o, i));
    if (!op) throw new JqError(`syntax error near ${src.slice(i, i + 5)}`);
    out.push({ k: op, v: op });
    i += op.length;
  }
  return out;
}

type Expr = (input: J) => J[];

class Parser {
  i = 0;
  constructor(private t: Tok[]) {}
  peek() {
    return this.t[this.i];
  }
  eat(k: string) {
    const t = this.t[this.i];
    if (!t || t.k !== k) throw new JqError(`syntax error: expected ${k}`);
    this.i++;
    return t;
  }
  is(k: string) {
    return this.t[this.i]?.k === k;
  }

  pipe(): Expr {
    let left = this.comma();
    while (this.is('|')) {
      this.i++;
      const l = left;
      const r = this.comma();
      left = (x) => l(x).flatMap(r);
    }
    return left;
  }
  comma(): Expr {
    let left = this.alt();
    while (this.is(',')) {
      this.i++;
      const l = left;
      const r = this.alt();
      left = (x) => [...l(x), ...r(x)];
    }
    return left;
  }
  alt(): Expr {
    let left = this.cmp();
    while (this.is('//')) {
      this.i++;
      const l = left;
      const r = this.cmp();
      left = (x) => {
        const v = l(x).filter((y) => y !== null && y !== false);
        return v.length ? v : r(x);
      };
    }
    return left;
  }
  cmp(): Expr {
    const left = this.add();
    const t = this.peek();
    if (t && ['==', '!=', '<', '>', '<=', '>='].includes(t.k)) {
      this.i++;
      const r = this.add();
      return (x) =>
        left(x).flatMap((a) =>
          r(x).map((b) => {
            switch (t.k) {
              case '==': return JSON.stringify(a) === JSON.stringify(b);
              case '!=': return JSON.stringify(a) !== JSON.stringify(b);
              case '<': return a < b;
              case '>': return a > b;
              case '<=': return a <= b;
              default: return a >= b;
            }
          }),
        );
    }
    return left;
  }
  add(): Expr {
    let left = this.mul();
    while (this.is('+') || this.is('-')) {
      const op = this.t[this.i++].k;
      const l = left;
      const r = this.mul();
      left = (x) =>
        l(x).flatMap((a) =>
          r(x).map((b) => {
            if (op === '+') {
              if (a === null) return b;
              if (b === null) return a;
              if (Array.isArray(a)) return a.concat(b);
              if (typeof a === 'object') return { ...a, ...b };
              return a + b;
            }
            return a - b;
          }),
        );
    }
    return left;
  }
  mul(): Expr {
    let left = this.postfix();
    while (this.is('*') || this.is('/')) {
      const op = this.t[this.i++].k;
      const l = left;
      const r = this.postfix();
      left = (x) => l(x).flatMap((a) => r(x).map((b) => (op === '*' ? a * b : typeof a === 'string' ? a.split(b) : a / b)));
    }
    return left;
  }
  postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.is('.') && this.t[this.i + 1]?.k === 'id') {
        this.i++;
        const name = this.t[this.i++].v;
        const base = e;
        e = (x) => base(x).map((v) => (v === null ? null : v[name] ?? null));
      } else if (this.is('.') && this.t[this.i + 1]?.k === 'str') {
        this.i++;
        const name = this.t[this.i++].v;
        const base = e;
        e = (x) => base(x).map((v) => (v === null ? null : v[name] ?? null));
      } else if (this.is('[')) {
        e = this.bracket(e);
      } else if (this.is('?')) {
        this.i++;
        const base = e;
        e = (x) => {
          try {
            return base(x);
          } catch {
            return [];
          }
        };
      } else break;
    }
    return e;
  }
  bracket(base: Expr): Expr {
    this.eat('[');
    if (this.is(']')) {
      this.i++;
      return (x) =>
        base(x).flatMap((v) => {
          if (v === null) return [];
          if (Array.isArray(v)) return v;
          if (typeof v === 'object') return Object.values(v);
          throw new JqError('Cannot iterate over ' + typeof v);
        });
    }
    const idx = this.pipe();
    this.eat(']');
    return (x) => base(x).flatMap((v) => idx(x).map((i) => (v === null ? null : typeof i === 'number' ? (Array.isArray(v) ? v.at(i) ?? null : null) : v[i] ?? null)));
  }
  primary(): Expr {
    const t = this.peek();
    if (!t) throw new JqError('syntax error: unexpected end');
    if (t.k === '.') {
      this.i++;
      const n = this.peek();
      if (n?.k === 'id') {
        this.i++;
        const name = n.v;
        return (x) => [x === null ? null : x[name] ?? null];
      }
      if (n?.k === 'str') {
        this.i++;
        const name = n.v;
        return (x) => [x === null ? null : x[name] ?? null];
      }
      if (n?.k === '[') return this.bracket((x) => [x]);
      return (x) => [x];
    }
    if (t.k === '..') {
      this.i++;
      const rec = (v: J): J[] => [v, ...(Array.isArray(v) ? v.flatMap(rec) : v && typeof v === 'object' ? Object.values(v).flatMap(rec) : [])];
      return (x) => rec(x);
    }
    if (t.k === 'num') {
      this.i++;
      return () => [Number(t.v)];
    }
    if (t.k === 'str') {
      this.i++;
      return () => [t.v];
    }
    if (t.k === '(') {
      this.i++;
      const e = this.pipe();
      this.eat(')');
      return e;
    }
    if (t.k === '[') {
      this.i++;
      if (this.is(']')) {
        this.i++;
        return () => [[]];
      }
      const e = this.pipe();
      this.eat(']');
      return (x) => [e(x)];
    }
    if (t.k === '{') return this.object();
    if (t.k === '-') {
      this.i++;
      const e = this.postfix();
      return (x) => e(x).map((v) => -v);
    }
    if (t.k === 'id') return this.func();
    throw new JqError(`syntax error near ${t.v}`);
  }
  object(): Expr {
    this.eat('{');
    const entries: { key: Expr; val: Expr }[] = [];
    while (!this.is('}')) {
      const t = this.peek();
      let key: Expr;
      let val: Expr;
      if (t.k === 'id' || t.k === 'str') {
        this.i++;
        const name = t.v;
        key = () => [name];
        if (this.is(':')) {
          this.i++;
          val = this.alt();
        } else val = (x) => [x?.[name] ?? null];
      } else if (t.k === '(') {
        this.i++;
        key = this.pipe();
        this.eat(')');
        this.eat(':');
        val = this.alt();
      } else throw new JqError('syntax error in object');
      entries.push({ key, val });
      if (this.is(',')) this.i++;
    }
    this.eat('}');
    return (x) => {
      let acc: J[] = [{}];
      for (const e of entries) {
        acc = acc.flatMap((o) => e.key(x).flatMap((k) => e.val(x).map((v) => ({ ...o, [k]: v }))));
      }
      return acc;
    };
  }
  func(): Expr {
    const name = this.t[this.i++].v;
    const arg = (): Expr => {
      this.eat('(');
      const e = this.pipe();
      this.eat(')');
      return e;
    };
    switch (name) {
      case 'empty': return () => [];
      case 'null': return () => [null];
      case 'true': return () => [true];
      case 'false': return () => [false];
      case 'not': return (x) => [x === null || x === false];
      case 'length': return (x) => [x === null ? 0 : typeof x === 'string' || Array.isArray(x) ? x.length : typeof x === 'object' ? Object.keys(x).length : Math.abs(x)];
      case 'keys': return (x) => [Array.isArray(x) ? x.map((_, i) => i) : Object.keys(x).sort()];
      case 'values': return (x) => (x === null ? [] : [x]);
      case 'first': return (x) => [x[0] ?? null];
      case 'last': return (x) => [x.at(-1) ?? null];
      case 'reverse': return (x) => [[...x].reverse()];
      case 'sort': return (x) => [[...x].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))];
      case 'unique': return (x) => [[...new Set(x.map((v: J) => JSON.stringify(v)))].map((s) => JSON.parse(s as string))];
      case 'add': return (x) => [x.length ? x.reduce((a: J, b: J) => (typeof a === 'string' || typeof b === 'string' ? a + b : Array.isArray(a) ? a.concat(b) : a + b)) : null];
      case 'flatten': return (x) => [x.flat(Infinity)];
      case 'tostring': return (x) => [typeof x === 'string' ? x : JSON.stringify(x)];
      case 'tonumber': return (x) => [Number(x)];
      case 'type': return (x) => [x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x];
      case 'ascii_downcase': return (x) => [String(x).toLowerCase()];
      case 'ascii_upcase': return (x) => [String(x).toUpperCase()];
      case 'to_entries': return (x) => [Object.entries(x).map(([key, value]) => ({ key, value }))];
      case 'from_entries': return (x) => [Object.fromEntries(x.map((e: J) => [e.key ?? e.name ?? e.Key, e.value ?? e.Value]))];
      case 'select': { const f = arg(); return (x) => (f(x).some((v) => v !== null && v !== false) ? [x] : []); }
      case 'map': { const f = arg(); return (x) => [x.flatMap(f)]; }
      case 'has': { const f = arg(); return (x) => f(x).map((k) => (Array.isArray(x) ? k < x.length : k in x)); }
      case 'contains': { const f = arg(); return (x) => f(x).map((v) => (typeof x === 'string' ? x.includes(v) : JSON.stringify(x).includes(JSON.stringify(v)))); }
      case 'startswith': { const f = arg(); return (x) => f(x).map((v) => String(x).startsWith(v)); }
      case 'endswith': { const f = arg(); return (x) => f(x).map((v) => String(x).endsWith(v)); }
      case 'test': { const f = arg(); return (x) => f(x).map((v) => new RegExp(v).test(String(x))); }
      case 'join': { const f = arg(); return (x) => f(x).map((sep) => x.map((v: J) => (v === null ? '' : String(v))).join(sep)); }
      case 'split': { const f = arg(); return (x) => f(x).map((sep) => String(x).split(sep)); }
      case 'sort_by': { const f = arg(); return (x) => [[...x].sort((a, b) => { const ka = f(a)[0]; const kb = f(b)[0]; return ka < kb ? -1 : ka > kb ? 1 : 0; })]; }
      case 'group_by': { const f = arg(); return (x) => { const m = new Map<string, J[]>(); for (const v of x) { const k = JSON.stringify(f(v)[0]); m.set(k, [...(m.get(k) ?? []), v]); } return [[...m.values()]]; }; }
      case 'any': return (x) => [x.some((v: J) => v)];
      case 'all': return (x) => [x.every((v: J) => v)];
      case 'min': return (x) => [x.length ? x.reduce((a: J, b: J) => (b < a ? b : a)) : null];
      case 'max': return (x) => [x.length ? x.reduce((a: J, b: J) => (b > a ? b : a)) : null];
      case 'paths': return () => [];
      default: throw new JqError(`${name}/0 is not defined`);
    }
  }
}

export function compile(src: string): Expr {
  const p = new Parser(lex(src));
  const e = p.pipe();
  if (p.i < (p as any).t.length) throw new JqError(`syntax error near ${(p as any).t[p.i].v}`);
  return e;
}

export function jq(program: string, input: J): J[] {
  return compile(program)(input);
}

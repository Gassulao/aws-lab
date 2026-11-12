// Intérprete mínimo de JavaScript para el código de las funciones Lambda simuladas.
// Admite lo habitual en un handler: const/let, funciones y flechas, async/await (síncrono), desestructuración,
// objetos, arrays, plantillas, try/catch, bucles, switch, require de ficheros del zip y un objeto global `aws`
// (DynamoDB, SQS, SNS, Lambda) que se ejecuta con el rol de ejecución de la función. No accede al navegador.

export class LambdaThrow { constructor(public value: any, public line = 0) {} }
class Timeout { constructor() {} }
class Return { constructor(public value: any) {} }
class Break { constructor(public label?: string) {} }
class Continue { constructor(public label?: string) {} }
const SHORT = Symbol('short-circuit');

type Tok = { t: 'num' | 'str' | 'tpl' | 'id' | 'p' | 're' | 'eof'; v: any; line: number; nl: boolean };
const KEYWORDS = new Set(['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'break', 'continue', 'throw', 'try', 'catch', 'finally', 'new', 'typeof', 'delete', 'void', 'in', 'of', 'instanceof', 'async', 'await', 'switch', 'case', 'default', 'export', 'import', 'class', 'null', 'true', 'false', 'this']);
const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '**', '<<', '>>', '&=', '|=', '^='];
const BLOCKED = new Set(['constructor', '__proto__', 'prototype', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);

function syntax(msg: string, line: number): never {
  const e = new SyntaxError(msg);
  (e as any).line = line;
  throw e;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0, line = 1, nl = false;
  const push = (t: Tok['t'], v: any) => { out.push({ t, v, line, nl }); nl = false; };
  const prevAllowsRegex = () => {
    const p = out[out.length - 1];
    if (!p) return true;
    if (p.t === 'num' || p.t === 'str' || p.t === 'tpl' || p.t === 're') return false;
    if (p.t === 'id') return ['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'await'].includes(p.v);
    return ![')', ']', '}'].includes(p.v);
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; nl = true; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const chunk = src.slice(i, e < 0 ? src.length : e + 2); line += (chunk.match(/\n/g) ?? []).length; i += chunk.length; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(0[xX][0-9a-fA-F]+|(\d[\d_]*\.?\d*|\.\d+)([eE][+-]?\d+)?)/.exec(src.slice(i))!;
      push('num', Number(m[0].replace(/_/g, ''))); i += m[0].length; continue;
    }
    if (/[A-Za-z_$]/.test(c)) { let j = i + 1; while (j < src.length && /[\w$]/.test(src[j])) j++; push('id', src.slice(i, j)); i = j; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\n') syntax('Invalid or unexpected token', line);
        if (src[j] === '\\') { j++; const e = src[j]; s += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === 'u' ? String.fromCharCode(parseInt(src.slice(j + 1, j + 5), 16)) : e; if (e === 'u') j += 4; } else s += src[j];
        j++;
      }
      if (j >= src.length) syntax('Invalid or unexpected token', line);
      push('str', s); i = j + 1; continue;
    }
    if (c === '`') {
      const strs: string[] = [], exprs: string[] = [];
      let j = i + 1, cur = '';
      while (j < src.length && src[j] !== '`') {
        if (src[j] === '\\') { j++; const e = src[j]; cur += e === 'n' ? '\n' : e === 't' ? '\t' : e; j++; continue; }
        if (src[j] === '$' && src[j + 1] === '{') {
          let d = 1, k = j + 2;
          while (k < src.length && d > 0) { if (src[k] === '{') d++; else if (src[k] === '}') d--; k++; }
          strs.push(cur); cur = ''; exprs.push(src.slice(j + 2, k - 1)); j = k; continue;
        }
        if (src[j] === '\n') line++;
        cur += src[j]; j++;
      }
      if (j >= src.length) syntax('Unterminated template literal', line);
      strs.push(cur); push('tpl', { strs, exprs }); i = j + 1; continue;
    }
    if (c === '/' && prevAllowsRegex()) {
      let j = i + 1, inClass = false;
      while (j < src.length && (src[j] !== '/' || inClass)) { if (src[j] === '\\') j++; else if (src[j] === '[') inClass = true; else if (src[j] === ']') inClass = false; j++; }
      const body = src.slice(i + 1, j); j++;
      let fl = ''; while (j < src.length && /[a-z]/.test(src[j])) fl += src[j++];
      push('re', { body, flags: fl }); i = j; continue;
    }
    const p = PUNCT.find((x) => src.startsWith(x, i));
    if (p) { push('p', p); i += p.length; continue; }
    if ('{}()[];,.<>+-*/%=!&|^~?:'.includes(c)) { push('p', c); i++; continue; }
    syntax('Invalid or unexpected token', line);
  }
  out.push({ t: 'eof', v: '', line, nl: true });
  return out;
}

// ------------------------------------------------------------------ analizador
type N = any;
class Parser {
  i = 0;
  constructor(public toks: Tok[]) {}
  get tok() { return this.toks[this.i]; }
  peek(n = 1) { return this.toks[Math.min(this.i + n, this.toks.length - 1)]; }
  is(v: string) { const t = this.tok; return (t.t === 'p' || t.t === 'id') && t.v === v; }
  eat(v: string) { if (this.is(v)) { this.i++; return true; } return false; }
  expect(v: string) { if (!this.eat(v)) this.unexpected(); }
  unexpected(): never {
    const t = this.tok;
    syntax(t.t === 'eof' ? 'Unexpected end of input' : t.t === 'str' ? 'Unexpected string' : t.t === 'num' ? 'Unexpected number' : `Unexpected token '${t.v}'`, t.line);
  }
  semi() { if (this.eat(';')) return; if (this.is('}') || this.tok.t === 'eof' || this.tok.nl) return; this.unexpected(); }
  ident(): string { const t = this.tok; if (t.t !== 'id' || (KEYWORDS.has(t.v) && !['of', 'async', 'await'].includes(t.v))) this.unexpected(); this.i++; return t.v; }

  program(): N[] { const out: N[] = []; while (this.tok.t !== 'eof') out.push(this.stmt()); return out; }
  block(): N { const line = this.tok.line; this.expect('{'); const body: N[] = []; while (!this.is('}')) { if (this.tok.t === 'eof') this.unexpected(); body.push(this.stmt()); } this.expect('}'); return { t: 'block', body, line }; }

  stmt(): N {
    const t = this.tok, line = t.line;
    if (t.t === 'p' && t.v === '{') return this.block();
    if (t.t === 'p' && t.v === ';') { this.i++; return { t: 'empty' }; }
    if (t.t === 'id') {
      switch (t.v) {
        case 'export': { this.i++; if (this.eat('default')) { const e = this.assign(); this.semi(); return { t: 'exportDefault', e, line }; } const d = this.stmt(); return { t: 'export', d, line }; }
        case 'import': syntax('Cannot use import statement outside a module', line); break;
        case 'const': case 'let': case 'var': { const d = this.decl(); this.semi(); return d; }
        case 'function': return this.fnDecl(false);
        case 'async': if (this.peek().v === 'function') { this.i++; return this.fnDecl(true); } break;
        case 'return': { this.i++; let e: N = null; if (!this.is(';') && !this.is('}') && !this.tok.nl && this.tok.t !== 'eof') e = this.expr(); this.semi(); return { t: 'return', e, line }; }
        case 'if': { this.i++; this.expect('('); const c = this.expr(); this.expect(')'); const a = this.stmt(); const b = this.eat('else') ? this.stmt() : null; return { t: 'if', c, a, b }; }
        case 'while': { this.i++; this.expect('('); const c = this.expr(); this.expect(')'); return { t: 'while', c, body: this.stmt() }; }
        case 'do': { this.i++; const body = this.stmt(); this.expect('while'); this.expect('('); const c = this.expr(); this.expect(')'); this.eat(';'); return { t: 'dowhile', c, body }; }
        case 'for': return this.forStmt();
        case 'break': { this.i++; const l = this.tok.t === 'id' && !this.tok.nl && !KEYWORDS.has(this.tok.v) ? this.ident() : undefined; this.semi(); return { t: 'break', label: l }; }
        case 'continue': { this.i++; const l = this.tok.t === 'id' && !this.tok.nl && !KEYWORDS.has(this.tok.v) ? this.ident() : undefined; this.semi(); return { t: 'continue', label: l }; }
        case 'throw': { this.i++; const e = this.expr(); this.semi(); return { t: 'throw', e, line }; }
        case 'try': {
          this.i++; const body = this.block(); let param: N = null, handler: N = null, fin: N = null;
          if (this.eat('catch')) { if (this.eat('(')) { param = this.pattern(); this.expect(')'); } handler = this.block(); }
          if (this.eat('finally')) fin = this.block();
          if (!handler && !fin) syntax('Missing catch or finally after try', line);
          return { t: 'try', body, param, handler, fin };
        }
        case 'switch': {
          this.i++; this.expect('('); const d = this.expr(); this.expect(')'); this.expect('{'); const cases: { test: N; body: N[] }[] = [];
          while (!this.eat('}')) { let test: N = null; if (this.eat('default')) { /* sin test */ } else { this.expect('case'); test = this.expr(); } this.expect(':'); const body: N[] = []; while (!this.is('case') && !this.is('default') && !this.is('}')) body.push(this.stmt()); cases.push({ test, body }); }
          return { t: 'switch', d, cases };
        }
        case 'class': syntax('Las clases no están soportadas por el intérprete del simulador', line); break;
      }
      if (this.peek().v === ':' && this.peek().t === 'p' && !KEYWORDS.has(t.v)) { this.i += 2; const s = this.stmt(); s.label = t.v; return s; }
    }
    const e = this.expr(); this.semi();
    return { t: 'expr', e, line };
  }

  decl(): N {
    const line = this.tok.line; const kind = this.tok.v; this.i++;
    const list: { target: N; init: N }[] = [];
    do { const target = this.pattern(); const init = this.eat('=') ? this.assign() : null; list.push({ target, init }); } while (this.eat(','));
    return { t: 'decl', kind, list, line };
  }
  fnDecl(isAsync: boolean): N { const line = this.tok.line; this.expect('function'); this.eat('*'); const name = this.ident(); const f = this.fnRest(name, isAsync, false); return { t: 'fnDecl', name, f, line }; }
  fnRest(name: string | null, isAsync: boolean, arrow: boolean): N {
    const params = this.params(); const body = this.block();
    return { t: 'fn', name, params, body, arrow, isAsync };
  }
  params(): N[] { this.expect('('); const ps: N[] = []; while (!this.is(')')) { ps.push(this.pattern(true)); if (!this.eat(',')) break; } this.expect(')'); return ps; }
  forStmt(): N {
    this.i++; this.expect('(');
    let init: N = null;
    if (this.is('const') || this.is('let') || this.is('var')) {
      const kind = this.tok.v; const save = this.i; this.i++;
      const target = this.pattern();
      if (this.is('of') || this.is('in')) { const of = this.tok.v === 'of'; this.i++; const right = of ? this.assign() : this.expr(); this.expect(')'); return { t: of ? 'forof' : 'forin', kind, target, right, body: this.stmt() }; }
      this.i = save; init = this.decl();
    } else if (!this.is(';')) init = { t: 'expr', e: this.expr() };
    this.expect(';'); const c = this.is(';') ? null : this.expr(); this.expect(';'); const upd = this.is(')') ? null : this.expr(); this.expect(')');
    return { t: 'for', init, c, upd, body: this.stmt() };
  }

  pattern(allowDefault = false): N {
    let p: N;
    if (this.is('{')) {
      this.i++; const props: N[] = []; let rest: N = null;
      while (!this.is('}')) {
        if (this.eat('...')) { rest = this.pattern(); break; }
        let key: N, computed = false;
        if (this.eat('[')) { key = this.assign(); this.expect(']'); computed = true; } else key = { t: 'str', v: this.tok.t === 'id' ? this.tok.v : String(this.tok.v) }, this.i++;
        let value: N;
        if (this.eat(':')) value = this.pattern(); else value = { t: 'id', name: key.v };
        if (this.eat('=')) value = { t: 'def', target: value, def: this.assign() };
        props.push({ key, computed, value }); if (!this.eat(',')) break;
      }
      this.expect('}'); p = { t: 'obj', props, rest };
    } else if (this.is('[')) {
      this.i++; const elems: N[] = []; let rest: N = null;
      while (!this.is(']')) { if (this.is(',')) { this.i++; elems.push(null); continue; } if (this.eat('...')) { rest = this.pattern(); break; } let e = this.pattern(); if (this.eat('=')) e = { t: 'def', target: e, def: this.assign() }; elems.push(e); if (!this.eat(',')) break; }
      this.expect(']'); p = { t: 'arr', elems, rest };
    } else if (allowDefault && this.eat('...')) { p = { t: 'restParam', target: this.pattern() }; return p; } else p = { t: 'id', name: this.ident() };
    if (allowDefault && this.eat('=')) p = { t: 'def', target: p, def: this.assign() };
    return p;
  }

  expr(): N { return this.assign(); }
  isArrowAhead(): boolean {
    // en '(' : localiza el ')' que cierra y comprueba si sigue '=>'
    let d = 0, j = this.i;
    for (; j < this.toks.length; j++) { const t = this.toks[j]; if (t.t === 'p') { if (t.v === '(' || t.v === '[' || t.v === '{') d++; else if (t.v === ')' || t.v === ']' || t.v === '}') { d--; if (d === 0) break; } } }
    const nx = this.toks[j + 1]; return !!nx && nx.t === 'p' && nx.v === '=>';
  }
  arrowBody(params: N[], isAsync: boolean): N {
    this.expect('=>');
    if (this.is('{')) return { t: 'fn', name: null, params, body: this.block(), arrow: true, isAsync };
    const e = this.assign(); return { t: 'fn', name: null, params, body: { t: 'block', body: [{ t: 'return', e, line: this.tok.line }] }, arrow: true, isAsync };
  }
  assign(): N {
    const t = this.tok, line = t.line;
    if (t.t === 'id' && t.v === 'async' && !this.peek().nl) {
      if (this.peek().t === 'id' && this.peek(2).v === '=>' && this.peek().v !== 'function') { this.i++; const n = this.ident(); return this.arrowBody([{ t: 'id', name: n }], true); }
      if (this.peek().v === '(' ) { const save = this.i; this.i++; if (this.isArrowAhead()) { const ps = this.params(); return this.arrowBody(ps, true); } this.i = save; }
    }
    if (t.t === 'id' && !KEYWORDS.has(t.v) && this.peek().v === '=>' && this.peek().t === 'p') { this.i++; return this.arrowBody([{ t: 'id', name: t.v }], false); }
    if (t.t === 'p' && t.v === '(' && this.isArrowAhead()) { const ps = this.params(); return this.arrowBody(ps, false); }
    const left = this.cond();
    const o = this.tok;
    if (o.t === 'p' && ['=', '+=', '-=', '*=', '/=', '%=', '**=', '&&=', '||=', '??=', '&=', '|=', '^=', '<<=', '>>='].includes(o.v)) {
      this.i++;
      if (!['id', 'member'].includes(left.t) && !(o.v === '=' && ['objLit', 'arrLit'].includes(left.t))) syntax('Invalid left-hand side in assignment', line);
      return { t: 'assign', op: o.v, left, right: this.assign(), line };
    }
    return left;
  }
  cond(): N {
    const c = this.bin(0);
    if (this.eat('?')) { const a = this.assign(); this.expect(':'); const b = this.assign(); return { t: 'cond', c, a, b }; }
    return c;
  }
  bin(minPrec: number): N {
    const PREC: Record<string, number> = { '??': 1, '||': 2, '&&': 3, '|': 4, '^': 5, '&': 6, '==': 7, '!=': 7, '===': 7, '!==': 7, '<': 8, '>': 8, '<=': 8, '>=': 8, in: 8, instanceof: 8, '<<': 9, '>>': 9, '>>>': 9, '+': 10, '-': 10, '*': 11, '/': 11, '%': 11, '**': 12 };
    let left = this.unary();
    for (;;) {
      const t = this.tok; const op = t.v; const prec = t.t === 'p' || (t.t === 'id' && (op === 'in' || op === 'instanceof')) ? PREC[op] : undefined;
      if (prec === undefined || prec < minPrec) break;
      this.i++;
      const right = op === '**' ? this.bin(prec) : this.bin(prec + 1);
      left = op === '&&' || op === '||' || op === '??' ? { t: 'logic', op, left, right } : { t: 'bin', op, left, right, line: t.line };
    }
    return left;
  }
  unary(): N {
    const t = this.tok, line = t.line;
    if (t.t === 'p' && ['!', '-', '+', '~'].includes(t.v)) { this.i++; return { t: 'un', op: t.v, e: this.unary() }; }
    if (t.t === 'p' && (t.v === '++' || t.v === '--')) { this.i++; return { t: 'upd', op: t.v, prefix: true, e: this.unary(), line }; }
    if (t.t === 'id' && ['typeof', 'void', 'delete'].includes(t.v)) { this.i++; return { t: 'un', op: t.v, e: this.unary() }; }
    if (t.t === 'id' && t.v === 'await') { this.i++; return { t: 'await', e: this.unary(), line }; }
    let e = this.postfix();
    const n = this.tok;
    if (n.t === 'p' && (n.v === '++' || n.v === '--') && !n.nl) { this.i++; e = { t: 'upd', op: n.v, prefix: false, e, line }; }
    return e;
  }
  args(): N[] { this.expect('('); const a: N[] = []; while (!this.is(')')) { a.push(this.eat('...') ? { t: 'spread', e: this.assign() } : this.assign()); if (!this.eat(',')) break; } this.expect(')'); return a; }
  postfix(): N {
    let e: N; const line = this.tok.line;
    if (this.is('new')) {
      this.i++; let callee = this.primary();
      while (this.is('.')) { this.i++; callee = { t: 'member', obj: callee, key: { t: 'str', v: this.tok.v }, computed: false, line }; this.i++; }
      const args = this.is('(') ? this.args() : [];
      e = { t: 'new', callee, args, line };
    } else e = this.primary();
    let opt = false;
    for (;;) {
      const t = this.tok;
      if (t.t !== 'p') break;
      if (t.v === '.') { this.i++; const k = this.tok; if (k.t !== 'id') this.unexpected(); this.i++; e = { t: 'member', obj: e, key: { t: 'str', v: k.v }, computed: false, line: t.line }; }
      else if (t.v === '?.') {
        this.i++; opt = true;
        if (this.is('(')) e = { t: 'call', callee: e, args: this.args(), opt: true, line: t.line };
        else if (this.eat('[')) { const k = this.expr(); this.expect(']'); e = { t: 'member', obj: e, key: k, computed: true, opt: true, line: t.line }; }
        else { const k = this.tok; this.i++; e = { t: 'member', obj: e, key: { t: 'str', v: k.v }, computed: false, opt: true, line: t.line }; }
      }
      else if (t.v === '[') { this.i++; const k = this.expr(); this.expect(']'); e = { t: 'member', obj: e, key: k, computed: true, line: t.line }; }
      else if (t.v === '(') e = { t: 'call', callee: e, args: this.args(), line: t.line };
      else break;
    }
    return opt ? { t: 'chain', e } : e;
  }
  primary(): N {
    const t = this.tok, line = t.line;
    switch (t.t) {
      case 'num': this.i++; return { t: 'lit', v: t.v };
      case 'str': this.i++; return { t: 'lit', v: t.v };
      case 're': this.i++; return { t: 're', body: t.v.body, flags: t.v.flags };
      case 'tpl': this.i++; return { t: 'tpl', strs: t.v.strs, exprs: t.v.exprs.map((s: string) => { const p = new Parser(tokenize(s)); const x = p.expr(); return x; }) };
      case 'id':
        switch (t.v) {
          case 'true': this.i++; return { t: 'lit', v: true };
          case 'false': this.i++; return { t: 'lit', v: false };
          case 'null': this.i++; return { t: 'lit', v: null };
          case 'this': this.i++; return { t: 'lit', v: undefined };
          case 'function': { this.i++; this.eat('*'); const name = this.tok.t === 'id' && !this.is('(') ? this.ident() : null; return this.fnRest(name, false, false); }
          case 'async': if (this.peek().v === 'function') { this.i += 2; const name = this.tok.t === 'id' && !this.is('(') ? this.ident() : null; return this.fnRest(name, true, false); } break;
        }
        if (KEYWORDS.has(t.v) && !['of', 'async', 'await'].includes(t.v)) this.unexpected();
        this.i++; return { t: 'id', name: t.v, line };
      case 'p':
        if (t.v === '(') { this.i++; const e = this.expr(); this.expect(')'); return e; }
        if (t.v === '[') {
          this.i++; const items: N[] = [];
          while (!this.is(']')) { if (this.is(',')) { this.i++; items.push({ t: 'lit', v: undefined }); continue; } items.push(this.eat('...') ? { t: 'spread', e: this.assign() } : this.assign()); if (!this.eat(',')) break; }
          this.expect(']'); return { t: 'arrLit', items };
        }
        if (t.v === '{') {
          this.i++; const props: N[] = [];
          while (!this.is('}')) {
            if (this.eat('...')) { props.push({ spread: this.assign() }); if (!this.eat(',')) break; continue; }
            let key: N, computed = false, isAsync = false;
            if (this.is('async') && !['(', ':', ',', '}'].includes(this.peek().v)) { this.i++; isAsync = true; }
            if (this.eat('[')) { key = this.assign(); this.expect(']'); computed = true; }
            else { const k = this.tok; this.i++; key = { t: 'lit', v: k.t === 'num' ? String(k.v) : k.v }; if (k.t === 'p') this.unexpected(); }
            if (this.is('(')) { props.push({ key, computed, value: this.fnRest(null, isAsync, false) }); }
            else if (this.eat(':')) props.push({ key, computed, value: this.assign() });
            else props.push({ key, computed, value: { t: 'id', name: key.v, line } });
            if (!this.eat(',')) break;
          }
          this.expect('}'); return { t: 'objLit', props };
        }
    }
    this.unexpected();
  }
}

export function parse(src: string): N[] { return new Parser(tokenize(src)).program(); }

// ------------------------------------------------------------------ intérprete
class Scope {
  vars = new Map<string, any>();
  consts = new Set<string>();
  constructor(public parent: Scope | null = null) {}
  find(n: string): Scope | null { for (let s: Scope | null = this; s; s = s.parent) if (s.vars.has(n)) return s; return null; }
  declare(n: string, v: any, isConst = false) { this.vars.set(n, v); if (isConst) this.consts.add(n); }
}

export interface AwsHost { call(service: string, op: string, params: any): any }
export interface RunOpts {
  files: Record<string, string>;
  env: Record<string, string>;
  maxSteps: number;
  now: () => number;
  aws: AwsHost;
  log: (level: string, msg: string) => void;
  advance: (ms: number) => void;
}
export interface Loaded { exports: any }

const inspect = (v: any, depth = 0): string => {
  if (typeof v === 'string') return depth ? `'${v}'` : v;
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'function') return '[Function]';
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (Array.isArray(v)) return v.length ? `[ ${v.map((x) => inspect(x, depth + 1)).join(', ')} ]` : '[]';
  if (typeof v === 'object') { const e = Object.entries(v); return e.length ? `{ ${e.map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`}: ${inspect(x, depth + 1)}`).join(', ')} }` : '{}'; }
  return String(v);
};

export class Interp {
  steps = 0;
  modules = new Map<string, any>();
  globals = new Scope();
  constructor(private o: RunOpts) {
    const g = this.globals;
    const hostErr = (name: string) => function (this: any, msg?: string) { const e = new Error(msg); e.name = name; return e; };
    const E = (name: string) => { const f: any = (msg?: string) => { const e = new Error(msg); e.name = name; return e; }; Object.defineProperty(f, 'name', { value: name }); return f; };
    void hostErr;
    g.declare('undefined', undefined); g.declare('NaN', NaN); g.declare('Infinity', Infinity);
    for (const n of ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError']) g.declare(n, E(n));
    g.declare('JSON', { stringify: (v: any, r?: any, sp?: any) => JSON.stringify(v, r ?? undefined, sp), parse: (s: string) => { try { return JSON.parse(s); } catch (e) { throw this.mkErr('SyntaxError', (e as Error).message); } } });
    g.declare('Math', Math);
    g.declare('Object', { keys: Object.keys, values: Object.values, entries: Object.entries, assign: Object.assign, fromEntries: Object.fromEntries, freeze: (x: any) => x, isFrozen: () => false });
    g.declare('Array', { isArray: Array.isArray, from: (x: any, f?: any) => Array.from(x, f), of: Array.of });
    g.declare('Number', Object.assign((x: any) => Number(x), { isInteger: Number.isInteger, isNaN: Number.isNaN, parseFloat, parseInt, MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER, isFinite: Number.isFinite }));
    g.declare('String', (x: any) => String(x)); g.declare('Boolean', (x: any) => Boolean(x));
    g.declare('parseInt', parseInt); g.declare('parseFloat', parseFloat); g.declare('isNaN', isNaN);
    g.declare('encodeURIComponent', encodeURIComponent); g.declare('decodeURIComponent', decodeURIComponent);
    g.declare('btoa', (s: string) => btoa(s)); g.declare('atob', (s: string) => atob(s));
    g.declare('structuredClone', (x: any) => JSON.parse(JSON.stringify(x)));
    g.declare('Map', Map); g.declare('Set', Set); g.declare('RegExp', RegExp);
    const nowFn = () => this.o.now();
    g.declare('Date', new Proxy(Date, { get: (t, k) => (k === 'now' ? nowFn : Reflect.get(t, k)), construct: (t, a) => (a.length ? new (t as any)(...a) : new t(nowFn())) }));
    g.declare('Buffer', { from: (s: string, enc?: string) => { const raw = enc === 'base64' ? atob(s) : String(s); return { toString: (e?: string) => (e === 'base64' ? btoa(raw) : enc === 'base64' ? raw : raw), length: raw.length }; } });
    g.declare('Promise', Object.assign(function () { /* se usa vía new */ }, { resolve: (x: any) => x, all: (x: any) => x, reject: (e: any) => { throw new LambdaThrow(e); } }));
    g.declare('console', Object.fromEntries([['log', 'INFO'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR'], ['debug', 'DEBUG']].map(([k, lv]) => [k, (...a: any[]) => this.o.log(lv, a.map((x) => inspect(x)).join(' '))])));
    g.declare('process', { env: { ...o.env }, version: 'v20.11.1', argv: [], platform: 'linux', uptime: () => 0.05, memoryUsage: () => ({ heapUsed: 30_000_000, rss: 60_000_000 }) });
    g.declare('sleep', (ms: number) => { this.o.advance(Number(ms) || 0); });
    g.declare('setTimeout', (fn: any, ms?: number) => { this.o.advance(Number(ms) || 0); if (typeof fn === 'function') fn(); return 1; });
    g.declare('clearTimeout', () => undefined);
    g.declare('aws', this.makeAws());
    g.declare('require', (name: string) => this.require(name, ''));
  }

  mkErr(name: string, msg: string) { const e = new Error(msg); e.name = name; return e; }
  throwErr(name: string, msg: string, line = 0): never { throw new LambdaThrow(this.mkErr(name, msg), line); }

  makeAws() {
    const svc = (name: string, ops: string[]) => Object.fromEntries(ops.map((op) => [op, (p: any) => this.o.aws.call(name, op, p ?? {})]));
    const mar = (v: any): any => v === null || v === undefined ? { NULL: true } : typeof v === 'string' ? { S: v } : typeof v === 'number' ? { N: String(v) } : typeof v === 'boolean' ? { BOOL: v } : Array.isArray(v) ? { L: v.map(mar) } : { M: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mar(x)])) };
    const unm = (a: any): any => 'S' in a ? a.S : 'N' in a ? Number(a.N) : 'BOOL' in a ? a.BOOL : 'NULL' in a ? null : 'L' in a ? a.L.map(unm) : 'M' in a ? Object.fromEntries(Object.entries(a.M).map(([k, x]) => [k, unm(x)])) : 'SS' in a ? a.SS : 'NS' in a ? a.NS.map(Number) : undefined;
    return {
      dynamodb: svc('dynamodb', ['putItem', 'getItem', 'deleteItem', 'updateItem', 'query', 'scan']),
      sqs: svc('sqs', ['sendMessage', 'receiveMessage', 'deleteMessage', 'sendMessageBatch']),
      sns: svc('sns', ['publish']),
      lambda: svc('lambda', ['invoke']),
      marshall: (o: any) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, mar(v)])),
      unmarshall: (i: any) => Object.fromEntries(Object.entries(i).map(([k, v]) => [k, unm(v as any)])),
    };
  }

  /** Módulos del SDK de AWS para JavaScript v3 (cliente + comandos) sobre las operaciones que expone el simulador. */
  sdkModule(name: string): any | undefined {
    const aws: any = this.makeAws();
    const mkCmd = (svc: string, op: string, doc = false) => {
      const f = function (this: any, input: any) { this.input = input ?? {}; this.__svc = svc; this.__op = op; this.__doc = doc; };
      Object.defineProperty(f, 'name', { value: '' });
      return f;
    };
    const marshallAll = (o: any) => (o ? aws.marshall(o) : o);
    const dispatch = (cmd: any, doc: boolean) => {
      if (!cmd || !cmd.__op) throw this.mkErr('TypeError', 'client.send: se esperaba un objeto Command del SDK');
      let p = { ...cmd.input };
      if (doc || cmd.__doc) {
        for (const k of ['Item', 'Key', 'ExpressionAttributeValues', 'ExclusiveStartKey']) if (p[k]) p[k] = marshallAll(p[k]);
        const r = this.o.aws.call(cmd.__svc, cmd.__op, p);
        const out: any = { ...r };
        if (r.Item) out.Item = aws.unmarshall(r.Item);
        if (r.Items) out.Items = r.Items.map((i: any) => aws.unmarshall(i));
        if (r.Attributes) out.Attributes = aws.unmarshall(r.Attributes);
        return out;
      }
      return this.o.aws.call(cmd.__svc, cmd.__op, p);
    };
    const mkClient = (doc = false) => {
      const f: any = function (this: any) { this.send = (cmd: any) => dispatch(cmd, doc); this.destroy = () => undefined; this.config = {}; };
      Object.defineProperty(f, 'name', { value: '' });
      return f;
    };
    const cmds = (svc: string, ops: Record<string, string>, doc = false) => Object.fromEntries(Object.entries(ops).map(([n, op]) => [n, mkCmd(svc, op, doc)]));
    const DDB = { PutItemCommand: 'putItem', GetItemCommand: 'getItem', DeleteItemCommand: 'deleteItem', UpdateItemCommand: 'updateItem', QueryCommand: 'query', ScanCommand: 'scan' };
    const DOC = { PutCommand: 'putItem', GetCommand: 'getItem', DeleteCommand: 'deleteItem', UpdateCommand: 'updateItem', QueryCommand: 'query', ScanCommand: 'scan' };
    switch (name) {
      case '@aws-sdk/client-dynamodb': return { DynamoDBClient: mkClient(), ...cmds('dynamodb', DDB), marshall: aws.marshall, unmarshall: aws.unmarshall };
      case '@aws-sdk/lib-dynamodb': { const C = mkClient(true); return { DynamoDBDocumentClient: Object.assign(C, { from: () => Reflect.construct(C, []) }), ...cmds('dynamodb', DOC, true) }; }
      case '@aws-sdk/util-dynamodb': return { marshall: aws.marshall, unmarshall: aws.unmarshall };
      case '@aws-sdk/client-sqs': return { SQSClient: mkClient(), ...cmds('sqs', { SendMessageCommand: 'sendMessage', ReceiveMessageCommand: 'receiveMessage', DeleteMessageCommand: 'deleteMessage', SendMessageBatchCommand: 'sendMessageBatch' }) };
      case '@aws-sdk/client-sns': return { SNSClient: mkClient(), ...cmds('sns', { PublishCommand: 'publish' }) };
      case '@aws-sdk/client-lambda': return { LambdaClient: mkClient(), ...cmds('lambda', { InvokeCommand: 'invoke' }) };
      default: return undefined;
    }
  }

  tick(n = 1) { this.steps += n; if (this.steps > this.o.maxSteps) throw new Timeout(); }

  // --- módulos
  resolveFile(from: string, name: string): string | null {
    const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
    const parts = (name.startsWith('.') ? (dir ? dir + '/' : '') + name : name).split('/');
    const out: string[] = []; for (const p of parts) { if (p === '.' || p === '') continue; if (p === '..') out.pop(); else out.push(p); }
    const base = out.join('/');
    for (const c of [base, base + '.js', base + '.mjs', base + '.cjs', base + '/index.js', base + '/index.mjs']) if (c in this.o.files) return c;
    return null;
  }
  require(name: string, from: string): any {
    if (name.startsWith('@aws-sdk/') || name === 'aws-sdk' || name.startsWith('node:') || ['fs', 'path', 'util', 'crypto', 'os'].includes(name)) {
      if (name.startsWith('@aws-sdk/') || name === 'aws-sdk') return this.sdkModule(name) ?? this.globals.vars.get('aws');
      if (name === 'crypto' || name === 'node:crypto') return { randomUUID: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => ((Math.random() * 16) | 0).toString(16)) };
      return {};
    }
    const f = name.startsWith('.') ? this.resolveFile(from, name) : null;
    if (!f) throw new LambdaThrow(Object.assign(this.mkErr('Error', `Cannot find module '${name}'\nRequire stack:\n- /var/task/${from || 'index.js'}`), { code: 'MODULE_NOT_FOUND' }), 0);
    return this.load(f).exports;
  }
  load(file: string): Loaded {
    const hit = this.modules.get(file); if (hit) return hit;
    const src = this.o.files[file];
    const ast = parse(src);
    const module: any = { exports: {} };
    const rec: Loaded = { get exports() { return module.exports; } } as any;
    this.modules.set(file, rec);
    const sc = new Scope(this.globals);
    sc.declare('module', module); sc.declare('exports', module.exports);
    sc.declare('require', (n: string) => this.require(n, file));
    sc.declare('__filename', '/var/task/' + file);
    this.currentExports = module;
    this.execBlock(ast, sc, true, module);
    return rec;
  }
  currentExports: any;

  // --- ejecución
  execBlock(body: N[], sc: Scope, top = false, mod?: any) {
    for (const s of body) if (s.t === 'fnDecl' || (s.t === 'export' && s.d.t === 'fnDecl')) { const d = s.t === 'fnDecl' ? s : s.d; sc.declare(d.name, this.mkFn(d.f, sc, d.name)); if (s.t === 'export') mod.exports[d.name] = sc.vars.get(d.name); }
    for (const s of body) this.exec(s, sc, mod);
    void top;
  }
  exec(n: N, sc: Scope, mod?: any): void {
    this.tick();
    switch (n.t) {
      case 'empty': case 'fnDecl': return;
      case 'expr': this.ev(n.e, sc); return;
      case 'decl': for (const d of n.list) { const v = d.init ? this.ev(d.init, sc, d.target.t === 'id' ? d.target.name : undefined) : undefined; this.bind(d.target, v, sc, n.kind === 'const', true); } return;
      case 'export': if (n.d.t === 'fnDecl') return; this.exec(n.d, sc, mod); if (n.d.t === 'decl') for (const d of n.d.list) this.collect(d.target, (nm) => { mod.exports[nm] = sc.vars.get(nm); }); return;
      case 'exportDefault': mod.exports.default = this.ev(n.e, sc); return;
      case 'return': throw new Return(n.e ? this.ev(n.e, sc) : undefined);
      case 'throw': throw new LambdaThrow(this.ev(n.e, sc), n.line);
      case 'break': throw new Break(n.label);
      case 'continue': throw new Continue(n.label);
      case 'block': { const s2 = new Scope(sc); this.execBlock(n.body, s2); return; }
      case 'if': if (this.ev(n.c, sc)) this.exec(n.a, sc); else if (n.b) this.exec(n.b, sc); return;
      case 'while': this.loop(n, sc, () => !!this.ev(n.c, sc), n.body); return;
      case 'dowhile': { let first = true; this.loop(n, sc, () => { if (first) { first = false; return true; } return !!this.ev(n.c, sc); }, n.body); return; }
      case 'for': {
        const s2 = new Scope(sc); if (n.init) this.exec(n.init, s2);
        let first = true;
        this.loop(n, s2, () => { if (!first && n.upd) this.ev(n.upd, s2); first = false; return n.c ? !!this.ev(n.c, s2) : true; }, n.body);
        return;
      }
      case 'forof': case 'forin': {
        const src = this.ev(n.right, sc);
        if (src === null || src === undefined) this.throwErr('TypeError', `${inspect(src)} is not iterable`);
        const items: any[] = n.t === 'forof' ? Array.from(src as Iterable<any>) : Object.keys(src);
        let k = 0;
        this.loop(n, sc, () => k < items.length, n.body, (s2) => { this.bind(n.target, items[k++], s2, n.kind === 'const', true); });
        return;
      }
      case 'try': {
        try {
          try { this.exec(n.body, sc); }
          catch (e) {
            const hostErr = e instanceof Error && !(e instanceof RangeError) && !!(e as any).$metadata;
            if (!n.handler || !(e instanceof LambdaThrow || e instanceof RangeError || hostErr)) throw e;
            const s2 = new Scope(sc);
            if (n.param) this.bind(n.param, e instanceof LambdaThrow ? e.value : hostErr ? e : this.mkErr('RangeError', (e as Error).message), s2, false, true);
            this.exec(n.handler, s2);
          }
        } finally { if (n.fin) this.exec(n.fin, sc); }
        return;
      }
      case 'switch': {
        const d = this.ev(n.d, sc); const s2 = new Scope(sc);
        let hit = n.cases.findIndex((c: N) => c.test && this.ev(c.test, s2) === d);
        if (hit < 0) hit = n.cases.findIndex((c: N) => !c.test);
        if (hit < 0) return;
        try { for (let i = hit; i < n.cases.length; i++) for (const s of n.cases[i].body) this.exec(s, s2); } catch (e) { if (!(e instanceof Break && !e.label)) throw e; }
        return;
      }
    }
    throw new Error('Nodo no soportado: ' + n.t);
  }
  loop(n: N, sc: Scope, test: () => boolean, body: N, before?: (s: Scope) => void) {
    while (test()) {
      this.tick();
      const s2 = new Scope(sc); before?.(s2);
      try { this.exec(body, s2); }
      catch (e) {
        if (e instanceof Break && (!e.label || e.label === n.label)) break;
        if (e instanceof Continue && (!e.label || e.label === n.label)) continue;
        throw e;
      }
    }
  }
  collect(p: N, f: (n: string) => void) {
    if (p.t === 'id') f(p.name); else if (p.t === 'def') this.collect(p.target, f); else if (p.t === 'obj') { for (const x of p.props) this.collect(x.value, f); if (p.rest) this.collect(p.rest, f); } else if (p.t === 'arr') { for (const e of p.elems) if (e) this.collect(e, f); if (p.rest) this.collect(p.rest, f); }
  }
  bind(p: N, v: any, sc: Scope, isConst: boolean, declare: boolean) {
    switch (p.t) {
      case 'id': if (declare) sc.declare(p.name, v, isConst); else this.setVar(p.name, v, sc); return;
      case 'def': this.bind(p.target, v === undefined ? this.ev(p.def, sc) : v, sc, isConst, declare); return;
      case 'obj': {
        if (v === null || v === undefined) this.throwErr('TypeError', `Cannot destructure '${inspect(v)}' as it is ${inspect(v)}.`);
        const used: string[] = [];
        for (const pr of p.props) { const k = pr.computed ? String(this.ev(pr.key, sc)) : pr.key.v; used.push(k); this.bind(pr.value, this.get(v, k), sc, isConst, declare); }
        if (p.rest) this.bind(p.rest, Object.fromEntries(Object.entries(v).filter(([k]) => !used.includes(k))), sc, isConst, declare);
        return;
      }
      case 'arr': {
        if (v === null || v === undefined) this.throwErr('TypeError', `${inspect(v)} is not iterable`);
        const arr = Array.from(v as Iterable<any>);
        p.elems.forEach((e: N, i: number) => e && this.bind(e, arr[i], sc, isConst, declare));
        if (p.rest) this.bind(p.rest, arr.slice(p.elems.length), sc, isConst, declare);
        return;
      }
    }
  }
  setVar(name: string, v: any, sc: Scope) {
    const s = sc.find(name);
    if (!s) this.throwErr('ReferenceError', `${name} is not defined`);
    if (s.consts.has(name)) this.throwErr('TypeError', 'Assignment to constant variable.');
    s.vars.set(name, v);
  }
  get(o: any, k: any, line = 0): any {
    if (o === null || o === undefined) this.throwErr('TypeError', `Cannot read properties of ${o} (reading '${String(k)}')`, line);
    if (typeof k === 'string' && BLOCKED.has(k)) return undefined;
    const v = o[k];
    return v;
  }
  mkFn(f: N, sc: Scope, name?: string): (...a: any[]) => any {
    const self = this;
    const fn = function (...args: any[]) {
      const s2 = new Scope(sc);
      f.params.forEach((p: N, i: number) => { if (p.t === 'restParam') self.bind(p.target, args.slice(i), s2, false, true); else self.bind(p, args[i], s2, false, true); });
      if (f.name) s2.declare(f.name, fn);
      self.tick(2);
      try { self.execBlock(f.body.body, s2); } catch (e) { if (e instanceof Return) return e.value; throw e; }
      return undefined;
    };
    Object.defineProperty(fn, 'name', { value: name ?? f.name ?? '' });
    return fn;
  }
  ev(n: N, sc: Scope, nameHint?: string): any {
    this.tick();
    switch (n.t) {
      case 'lit': return n.v;
      case 're': return new RegExp(n.body, n.flags);
      case 'id': { const s = sc.find(n.name); if (!s) this.throwErr('ReferenceError', `${n.name} is not defined`, n.line); return s.vars.get(n.name); }
      case 'tpl': return n.strs.reduce((a: string, s: string, i: number) => a + s + (i < n.exprs.length ? String(inspect2(this.ev(n.exprs[i], sc))) : ''), '');
      case 'arrLit': { const out: any[] = []; for (const it of n.items) { if (it.t === 'spread') out.push(...Array.from(this.ev(it.e, sc))); else out.push(this.ev(it, sc)); } return out; }
      case 'objLit': {
        const o: any = {};
        for (const p of n.props) {
          if (p.spread) { Object.assign(o, this.ev(p.spread, sc)); continue; }
          const k = p.computed ? String(this.ev(p.key, sc)) : String(p.key.v);
          if (BLOCKED.has(k)) continue;
          o[k] = p.value.t === 'fn' ? this.mkFn(p.value, sc, k) : this.ev(p.value, sc, k);
        }
        return o;
      }
      case 'fn': return this.mkFn(n, sc, n.name ?? nameHint);
      case 'cond': return this.ev(n.c, sc) ? this.ev(n.a, sc) : this.ev(n.b, sc);
      case 'logic': { const l = this.ev(n.left, sc); return n.op === '&&' ? (l ? this.ev(n.right, sc) : l) : n.op === '||' ? (l ? l : this.ev(n.right, sc)) : l ?? this.ev(n.right, sc); }
      case 'bin': return this.binop(n.op, this.ev(n.left, sc), this.ev(n.right, sc), n.line);
      case 'un': {
        if (n.op === 'typeof') { if (n.e.t === 'id' && !sc.find(n.e.name)) return 'undefined'; return typeof this.ev(n.e, sc); }
        if (n.op === 'delete') { if (n.e.t === 'member') { const o = this.ev(n.e.obj, sc); const k = n.e.computed ? this.ev(n.e.key, sc) : n.e.key.v; if (o) delete o[k]; } return true; }
        const v = this.ev(n.e, sc);
        return n.op === '!' ? !v : n.op === '-' ? -v : n.op === '+' ? +v : n.op === '~' ? ~v : undefined;
      }
      case 'await': { const v = this.ev(n.e, sc); return v; }
      case 'chain': try { return this.ev(n.e, sc); } catch (e) { if (e === SHORT) return undefined; throw e; }
      case 'member': {
        const o = this.ev(n.obj, sc);
        if (n.opt && (o === null || o === undefined)) throw SHORT;
        const k = n.computed ? this.ev(n.key, sc) : n.key.v;
        return this.get(o, k, n.line);
      }
      case 'call': {
        let fn: any, thisArg: any;
        if (n.callee.t === 'member') {
          thisArg = this.ev(n.callee.obj, sc);
          if (n.callee.opt && (thisArg === null || thisArg === undefined)) throw SHORT;
          const k = n.callee.computed ? this.ev(n.callee.key, sc) : n.callee.key.v;
          fn = this.get(thisArg, k, n.callee.line);
          if (typeof fn !== 'function') { if (n.opt && (fn === null || fn === undefined)) throw SHORT; this.throwErr('TypeError', `${srcOf(n.callee)} is not a function`, n.line); }
        } else {
          fn = this.ev(n.callee, sc);
          if (typeof fn !== 'function') { if (n.opt && (fn === null || fn === undefined)) throw SHORT; this.throwErr('TypeError', `${srcOf(n.callee)} is not a function`, n.line); }
        }
        const args: any[] = []; for (const a of n.args) { if (a.t === 'spread') args.push(...Array.from(this.ev(a.e, sc))); else args.push(this.ev(a, sc)); }
        try { return fn.apply(thisArg, args); } catch (e) { if (e instanceof LambdaThrow && !e.line) e.line = n.line; throw e; }
      }
      case 'new': {
        const C = this.ev(n.callee, sc);
        const args = n.args.map((a: N) => (a.t === 'spread' ? Array.from(this.ev(a.e, sc)) : [this.ev(a, sc)])).flat();
        if (C === this.globals.vars.get('Promise')) {
          let val: any, rej: any, has = false;
          (args[0] as any)((v: any) => { val = v; has = true; }, (e: any) => { rej = e; has = true; });
          if (rej !== undefined) throw new LambdaThrow(rej, n.line);
          void has; return val;
        }
        if (typeof C !== 'function') this.throwErr('TypeError', `${srcOf(n.callee)} is not a constructor`, n.line);
        if (C.name === '' || ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError'].includes(C.name) || C === Map || C === Set || C === RegExp || C === this.globals.vars.get('Date')) {
          const isErr = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError'].includes(C.name);
          if (isErr) { const e = C(...args); (e as any).__line = n.line; return e; }
          return Reflect.construct(C, args);
        }
        this.throwErr('TypeError', `${srcOf(n.callee)} is not a constructor`, n.line);
        break;
      }
      case 'assign': {
        const l = n.left;
        const rhs = () => this.ev(n.right, sc, l.t === 'id' ? l.name : undefined);
        if (l.t === 'id') {
          const cur = n.op === '=' ? undefined : this.ev(l, sc);
          const v = n.op === '=' ? rhs() : this.compound(n.op, cur, rhs, n.line);
          if (v === SHORT) return cur;
          this.setVar(l.name, v, sc); return v;
        }
        if (l.t === 'member') {
          const o = this.ev(l.obj, sc); const k = l.computed ? this.ev(l.key, sc) : l.key.v;
          if (o === null || o === undefined) this.throwErr('TypeError', `Cannot set properties of ${o} (setting '${String(k)}')`, n.line);
          if (typeof k === 'string' && BLOCKED.has(k)) return undefined;
          const cur = n.op === '=' ? undefined : o[k];
          const v = n.op === '=' ? rhs() : this.compound(n.op, cur, rhs, n.line);
          if (v === SHORT) return cur;
          o[k] = v; return v;
        }
        this.bind(l.t === 'objLit' ? this.toPattern(l) : this.toPattern(l), rhs(), sc, false, false);
        return undefined;
      }
      case 'upd': {
        const t = n.e; const cur = Number(this.ev(t, sc)); const nv = n.op === '++' ? cur + 1 : cur - 1;
        if (t.t === 'id') this.setVar(t.name, nv, sc); else if (t.t === 'member') { const o = this.ev(t.obj, sc); o[t.computed ? this.ev(t.key, sc) : t.key.v] = nv; } else syntax('Invalid left-hand side expression in postfix operation', n.line);
        return n.prefix ? nv : cur;
      }
      case 'spread': return this.ev(n.e, sc);
    }
    throw new Error('Expresión no soportada: ' + n.t);
  }
  toPattern(n: N): N {
    if (n.t === 'arrLit') return { t: 'arr', elems: n.items.map((x: N) => this.toPattern(x)), rest: null };
    if (n.t === 'objLit') return { t: 'obj', props: n.props.map((p: N) => ({ key: p.key, computed: p.computed, value: this.toPattern(p.value) })), rest: null };
    return n;
  }
  compound(op: string, cur: any, rhs: () => any, line: number): any {
    if (op === '&&=') return cur ? rhs() : SHORT;
    if (op === '||=') return cur ? SHORT : rhs();
    if (op === '??=') return cur === undefined || cur === null ? rhs() : SHORT;
    return this.binop(op.slice(0, -1), cur, rhs(), line);
  }
  binop(op: string, a: any, b: any, line: number): any {
    switch (op) {
      case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b; case '%': return a % b; case '**': return a ** b;
      case '==': return a == b; case '!=': return a != b; case '===': return a === b; case '!==': return a !== b; // eslint-disable-line eqeqeq
      case '<': return a < b; case '>': return a > b; case '<=': return a <= b; case '>=': return a >= b;
      case '&': return a & b; case '|': return a | b; case '^': return a ^ b; case '<<': return a << b; case '>>': return a >> b; case '>>>': return a >>> b;
      case 'in': if (b === null || typeof b !== 'object') this.throwErr('TypeError', `Cannot use 'in' operator to search for '${String(a)}' in ${inspect(b)}`, line); return a in b;
      case 'instanceof': return b === Array ? Array.isArray(a) : typeof b === 'function' && a instanceof Error && ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError'].includes(b.name) ? (b.name === 'Error' || a.name === b.name) : false;
    }
    throw new Error('Operador no soportado ' + op);
  }
}

const inspect2 = (v: any) => (v !== null && typeof v === 'object' && !(v instanceof Error) ? (Array.isArray(v) ? v.join(',') : '[object Object]') : v instanceof Error ? `${v.name}: ${v.message}` : v);
const srcOf = (n: N): string => (n.t === 'id' ? n.name : n.t === 'member' ? `${srcOf(n.obj)}.${n.computed ? '<computed>' : n.key.v}` : '(intermediate value)');

export { Timeout, Return };
export const isTimeout = (e: unknown): boolean => e instanceof Timeout;

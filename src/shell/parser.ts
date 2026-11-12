// Parser de Bash simplificado: palabras con comillas y expansiones, tuberías, listas (; && ||), redirecciones,
// here-documents, asignaciones previas y las estructuras if / for / while.

export type WordPart = { t: 'lit'; v: string } | { t: 'var'; name: string; quoted: boolean } | { t: 'cmd'; src: string; quoted: boolean } | { t: 'arith'; src: string; quoted: boolean } | { t: 'glob'; v: string };
export interface Word {
  parts: WordPart[];
  /** Cualquier parte entrecomillada (evita expansión de comodines y separación de palabras). */
  quoted: boolean;
  /** `NAME=` sin comillas al inicio de una palabra que luego lleva comillas: A="x y". */
  assignPrefix?: string;
}

export interface Redirect {
  op: '>' | '>>' | '<' | '2>' | '2>>' | '2>&1' | '&>';
  target?: Word;
}
export interface SimpleCmd {
  type: 'simple';
  assigns: { name: string; value: Word }[];
  words: Word[];
  redirects: Redirect[];
  heredoc?: { body: string; expand: boolean };
}
export interface Pipeline {
  type: 'pipeline';
  cmds: Node[];
  negate: boolean;
}
export interface AndOr {
  type: 'andor';
  first: Node;
  rest: { op: '&&' | '||'; node: Node }[];
}
export interface List {
  type: 'list';
  items: Node[];
}
export interface IfNode {
  type: 'if';
  cond: Node;
  then: Node;
  else?: Node;
}
export interface ForNode {
  type: 'for';
  name: string;
  words: Word[];
  body: Node;
}
export interface WhileNode {
  type: 'while';
  cond: Node;
  body: Node;
}
/** Estructura compuesta con redirecciones: `done < fichero`, `fi > salida.txt`. */
export interface RedirNode {
  type: 'redir';
  node: Node;
  redirects: Redirect[];
}
export type Node = SimpleCmd | Pipeline | AndOr | List | IfNode | ForNode | WhileNode | RedirNode;

export class ParseError extends Error {}

type Tok = { k: 'word'; w: Word } | { k: 'op'; v: string } | { k: 'nl' };

const OPS = ['&&', '||', '2>>', '2>&1', '&>', '>>', '2>', '<<', '|', ';', '>', '<', '(', ')', '&'];

function readDollar(src: string, i: number, quoted: boolean): { part: WordPart; next: number } {
  // src[i] === '$'
  if (src[i + 1] === '(' && src[i + 2] === '(') {
    let depth = 2;
    let j = i + 3;
    while (j < src.length && depth > 0) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') depth--;
      j++;
    }
    if (depth === 0 && src[j - 2] === ')') return { part: { t: 'arith', src: src.slice(i + 3, j - 2), quoted }, next: j };
  }
  if (src[i + 1] === '(') {
    let depth = 1;
    let j = i + 2;
    while (j < src.length && depth > 0) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') depth--;
      j++;
    }
    if (depth !== 0) throw new ParseError('unexpected EOF while looking for matching `)\'');
    return { part: { t: 'cmd', src: src.slice(i + 2, j - 1), quoted }, next: j };
  }
  if (src[i + 1] === '{') {
    const end = src.indexOf('}', i + 2);
    if (end < 0) throw new ParseError('bad substitution');
    return { part: { t: 'var', name: src.slice(i + 2, end), quoted }, next: end + 1 };
  }
  const m = /^[A-Za-z_][A-Za-z0-9_]*|^[?#@*0-9$!]/.exec(src.slice(i + 1));
  if (!m) return { part: { t: 'lit', v: '$' }, next: i + 1 };
  return { part: { t: 'var', name: m[0], quoted }, next: i + 1 + m[0].length };
}

export function tokenize(src: string): { toks: Tok[]; heredocs: Map<number, { delim: string; quoteless: boolean }> } {
  const toks: Tok[] = [];
  const heredocs = new Map<number, { delim: string; quoteless: boolean }>();
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '\\' && src[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '#' ) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\n') {
      toks.push({ k: 'nl' });
      i++;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    // "2>" solo es operador si va al inicio de palabra
    if (op && !(op === '2>' && false)) {
      toks.push({ k: 'op', v: op });
      i += op.length;
      continue;
    }
    // palabra
    const parts: WordPart[] = [];
    let quoted = false;
    let assignPrefix: string | undefined;
    const markQuote = () => {
      quoted = true;
    };
    let lit = '';
    const flush = () => {
      if (lit) parts.push({ t: 'lit', v: lit });
      lit = '';
    };
    while (i < n) {
      const ch = src[i];
      if (ch === ' ' || ch === '\t' || ch === '\n') break;
      // Primer entrecomillado justo tras `NAME=`: es una asignación.
      if (!quoted && assignPrefix === undefined && parts.length === 0 && (ch === '"' || ch === "'") && /^[A-Za-z_][A-Za-z0-9_]*=$/.test(lit)) assignPrefix = lit;
      if (OPS.some((o) => src.startsWith(o, i)) && !(ch === '2' )) break;
      if (ch === '2' && OPS.some((o) => o.startsWith('2') && src.startsWith(o, i)) && lit === '' && parts.length === 0) break;
      if (ch === '\\') {
        if (src[i + 1] === '\n') {
          i += 2;
          continue;
        }
        lit += src[i + 1] ?? '';
        markQuote();
        i += 2;
        continue;
      }
      if (ch === "'") {
        const end = src.indexOf("'", i + 1);
        if (end < 0) throw new ParseError("unexpected EOF while looking for matching `''");
        lit += src.slice(i + 1, end);
        markQuote();
        i = end + 1;
        continue;
      }
      if (ch === '"') {
        markQuote();
        i++;
        while (i < n && src[i] !== '"') {
          if (src[i] === '\\' && '"\\$`\n'.includes(src[i + 1] ?? '')) {
            if (src[i + 1] !== '\n') lit += src[i + 1];
            i += 2;
          } else if (src[i] === '$') {
            const { part, next } = readDollar(src, i, true);
            if (part.t === 'lit') lit += part.v;
            else {
              flush();
              parts.push(part);
            }
            i = next;
          } else lit += src[i++];
        }
        if (i >= n) throw new ParseError('unexpected EOF while looking for matching `"\'');
        i++;
        continue;
      }
      if (ch === '$') {
        const { part, next } = readDollar(src, i, false);
        if (part.t === 'lit') lit += part.v;
        else {
          flush();
          parts.push(part);
        }
        i = next;
        continue;
      }
      if (ch === '`') {
        const end = src.indexOf('`', i + 1);
        if (end < 0) throw new ParseError('unexpected EOF while looking for matching ``\'');
        flush();
        parts.push({ t: 'cmd', src: src.slice(i + 1, end), quoted: false });
        i = end + 1;
        continue;
      }
      if (ch === '*' || ch === '?') {
        flush();
        parts.push({ t: 'glob', v: ch });
        i++;
        continue;
      }
      lit += ch;
      i++;
    }
    flush();
    if (parts.length || quoted) toks.push({ k: 'word', w: { parts, quoted, assignPrefix } });
    // here-doc: tras "<<" la siguiente palabra es el delimitador
    const prev = toks[toks.length - 2];
    if (prev && prev.k === 'op' && prev.v === '<<') {
      const w = (toks[toks.length - 1] as any).w as Word;
      const delim = w.parts.map((p) => (p.t === 'lit' ? p.v : '')).join('');
      heredocs.set(toks.length - 1, { delim, quoteless: !w.quoted });
    }
  }
  return { toks, heredocs };
}

/** Extrae los cuerpos de here-document del texto original, en orden de aparición. */
function extractHeredocBodies(src: string, delims: { delim: string }[]): { cleaned: string; bodies: string[] } {
  if (!delims.length) return { cleaned: src, bodies: [] };
  const lines = src.split('\n');
  const out: string[] = [];
  const bodies: string[] = [];
  let k = 0;
  let pending: string[] = [];
  let collecting: { delim: string; lines: string[] } | null = null;
  for (const line of lines) {
    if (collecting) {
      if (line.trim() === collecting.delim) {
        bodies.push(collecting.lines.join('\n') + (collecting.lines.length ? '\n' : ''));
        collecting = null;
        if (pending.length) {
          collecting = { delim: pending.shift()!, lines: [] };
        }
      } else collecting.lines.push(line);
      continue;
    }
    out.push(line);
    const found = [...line.matchAll(/<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/g)];
    if (found.length) {
      pending = found.map((m) => m[1] ?? m[2] ?? m[3]);
      collecting = { delim: pending.shift()!, lines: [] };
      k++;
    }
  }
  if (collecting) throw new ParseError(`here-document delimited by end-of-file (wanted \`${collecting.delim}')`);
  return { cleaned: out.join('\n'), bodies };
}

class P {
  i = 0;
  hd = 0;
  constructor(private toks: Tok[], private bodies: string[], private hdInfo: Map<number, { delim: string; quoteless: boolean }>) {}

  peek(): Tok | undefined {
    return this.toks[this.i];
  }
  eof() {
    return this.i >= this.toks.length;
  }
  isKw(kw: string): boolean {
    const t = this.peek();
    if (t?.k !== 'word') return false;
    const w = t.w;
    return !w.quoted && w.parts.length === 1 && w.parts[0].t === 'lit' && (w.parts[0] as any).v === kw;
  }
  skipNl() {
    while (this.peek()?.k === 'nl' || (this.peek()?.k === 'op' && (this.peek() as any).v === ';')) this.i++;
  }
  expectKw(kw: string) {
    this.skipNl();
    if (!this.isKw(kw)) throw new ParseError(`syntax error: expected \`${kw}'`);
    this.i++;
  }

  parseList(stop: string[] = []): Node {
    const items: Node[] = [];
    this.skipNl();
    while (!this.eof() && !stop.some((s) => this.isKw(s)) && !(this.peek()?.k === 'op' && (this.peek() as any).v === ')')) {
      items.push(this.parseAndOr());
      const t = this.peek();
      if (t && (t.k === 'nl' || (t.k === 'op' && (t.v === ';' || t.v === '&')))) this.i++;
      this.skipNl();
    }
    return items.length === 1 ? items[0] : { type: 'list', items };
  }

  parseAndOr(): Node {
    const first = this.parsePipeline();
    const rest: AndOr['rest'] = [];
    for (;;) {
      const t = this.peek();
      if (t?.k === 'op' && (t.v === '&&' || t.v === '||')) {
        this.i++;
        while (this.peek()?.k === 'nl') this.i++;
        rest.push({ op: t.v, node: this.parsePipeline() });
      } else break;
    }
    return rest.length ? { type: 'andor', first, rest } : first;
  }

  parsePipeline(): Node {
    let negate = false;
    if (this.isKw('!')) {
      negate = true;
      this.i++;
    }
    const cmds: Node[] = [this.parseCommand()];
    while (this.peek()?.k === 'op' && (this.peek() as any).v === '|') {
      this.i++;
      while (this.peek()?.k === 'nl') this.i++;
      cmds.push(this.parseCommand());
    }
    return cmds.length === 1 && !negate ? cmds[0] : { type: 'pipeline', cmds, negate };
  }

  parseCommand(): Node {
    if (this.isKw('if')) return this.withRedirects(this.parseIf());
    if (this.isKw('for')) {
      this.i++;
      const nameTok = this.peek();
      if (nameTok?.k !== 'word') throw new ParseError('syntax error near `for\'');
      this.i++;
      const name = nameTok.w.parts.map((p) => (p.t === 'lit' ? p.v : '')).join('');
      this.skipNl();
      if (!this.isKw('in')) throw new ParseError("syntax error: expected `in'");
      this.i++;
      const words: Word[] = [];
      while (this.peek()?.k === 'word' && !this.isKw('do')) {
        words.push((this.peek() as any).w);
        this.i++;
      }
      this.expectKw('do');
      const body = this.parseList(['done']);
      this.expectKw('done');
      return this.withRedirects({ type: 'for', name, words, body });
    }
    if (this.isKw('while')) {
      this.i++;
      const cond = this.parseList(['do']);
      this.expectKw('do');
      const body = this.parseList(['done']);
      this.expectKw('done');
      return this.withRedirects({ type: 'while', cond, body });
    }
    return this.parseSimple();
  }

  /** `if` y `elif` comparten estructura; solo el `if` más externo consume el `fi` final. */
  parseIf(): IfNode {
    this.i++; // if | elif
    const cond = this.parseList(['then']);
    this.expectKw('then');
    const then = this.parseList(['elif', 'else', 'fi']);
    let els: Node | undefined;
    if (this.isKw('elif')) return { type: 'if', cond, then, else: this.parseIfChain() };
    if (this.isKw('else')) {
      this.i++;
      els = this.parseList(['fi']);
    }
    this.expectKw('fi');
    return { type: 'if', cond, then, else: els };
  }
  /** Rama `elif`: un `if` anidado que ya consume el `fi` común. */
  parseIfChain(): IfNode {
    return this.parseIf();
  }

  /** Redirecciones tras `done` o `fi`. */
  withRedirects(node: Node): Node {
    const redirects: Redirect[] = [];
    for (;;) {
      const t = this.peek();
      if (t?.k !== 'op') break;
      if (t.v === '2>&1') {
        this.i++;
        redirects.push({ op: '2>&1' });
        continue;
      }
      if (!['>', '>>', '<', '2>', '2>>', '&>'].includes(t.v)) break;
      this.i++;
      const target = this.peek();
      if (target?.k !== 'word') throw new ParseError(`syntax error near unexpected token \`${t.v}'`);
      this.i++;
      redirects.push({ op: t.v as Redirect['op'], target: target.w });
    }
    return redirects.length ? { type: 'redir', node, redirects } : node;
  }

  parseSimple(): SimpleCmd {
    const cmd: SimpleCmd = { type: 'simple', assigns: [], words: [], redirects: [] };
    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (t.k === 'nl') break;
      if (t.k === 'op') {
        if (['>', '>>', '<', '2>', '2>>', '&>'].includes(t.v)) {
          this.i++;
          const target = this.peek();
          if (target?.k !== 'word') throw new ParseError(`syntax error near unexpected token \`${t.v}'`);
          this.i++;
          cmd.redirects.push({ op: t.v as Redirect['op'], target: target.w });
          continue;
        }
        if (t.v === '2>&1') {
          this.i++;
          cmd.redirects.push({ op: '2>&1' });
          continue;
        }
        if (t.v === '<<') {
          const idx = this.i + 1;
          this.i += 2;
          const info = this.hdInfo.get(idx);
          cmd.heredoc = { body: this.bodies[this.hd++] ?? '', expand: info?.quoteless ?? true };
          continue;
        }
        break;
      }
      // palabra
      const first = t.w.parts[0];
      // NAME=valor o NAME="valor con espacios".
      if (!cmd.words.length && first?.t === 'lit' && t.w.assignPrefix) {
        const name = t.w.assignPrefix.slice(0, -1);
        const rest: WordPart[] = [];
        const after = first.v.slice(t.w.assignPrefix.length);
        if (after) rest.push({ t: 'lit', v: after });
        rest.push(...t.w.parts.slice(1));
        cmd.assigns.push({ name, value: { parts: rest, quoted: true } });
        this.i++;
        continue;
      }
      if (!cmd.words.length && !t.w.quoted && first?.t === 'lit' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(first.v)) {
        const eq = first.v.indexOf('=');
        const name = first.v.slice(0, eq);
        const rest: WordPart[] = [];
        if (first.v.slice(eq + 1)) rest.push({ t: 'lit', v: first.v.slice(eq + 1) });
        rest.push(...t.w.parts.slice(1));
        cmd.assigns.push({ name, value: { parts: rest, quoted: false } });
        this.i++;
        continue;
      }
      cmd.words.push(t.w);
      this.i++;
    }
    if (!cmd.words.length && !cmd.assigns.length && !cmd.redirects.length && !cmd.heredoc) {
      throw new ParseError(`syntax error near unexpected token \`${(this.peek() as any)?.v ?? 'newline'}'`);
    }
    return cmd;
  }
}

export function parse(src: string): Node {
  // Los cuerpos de here-document se sacan antes de tokenizar.
  const delims = [...src.matchAll(/<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/g)].map((m) => ({ delim: m[1] ?? m[2] ?? m[3] }));
  const { cleaned, bodies } = extractHeredocBodies(src, delims);
  const { toks, heredocs } = tokenize(cleaned);
  const p = new P(toks, bodies, heredocs);
  const node = p.parseList();
  if (!p.eof()) {
    const t = p.peek()!;
    throw new ParseError(`syntax error near unexpected token \`${t.k === 'op' ? t.v : t.k === 'nl' ? 'newline' : 'word'}'`);
  }
  return node;
}

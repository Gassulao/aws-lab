// Utilidades de texto de Linux: echo, printf, ls, head, tail, wc, sort, uniq, cut, tr, grep, sed, xargs, basename, dirname.
import { registerCommand, ok, fail, runString, type Shell, type CmdResult } from './interp';
import { VFS } from './fs';
import { abs, readInputs, lines, join } from './commands';

// ---------------------------------------------------------------- expresiones regulares

const POSIX: Record<string, string> = { alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z', space: '\\s', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', word: '\\w' };

/** Convierte una expresión regular básica de POSIX (grep, sed) a JavaScript. Con `ere` solo traduce las clases [[:alpha:]]. */
export function toJsRegex(src: string, ere: boolean): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '[') {
      // clase de caracteres: copiar hasta el cierre, traduciendo [:clase:]
      let j = i + 1;
      if (src[j] === '^') j++;
      if (src[j] === ']') j++;
      while (j < src.length && src[j] !== ']') {
        if (src[j] === '[' && src[j + 1] === ':') {
          const e = src.indexOf(':]', j + 2);
          if (e > 0) j = e + 2;
          else j++;
        } else j++;
      }
      const body = src.slice(i, j + 1).replace(/\[:([a-z]+):\]/g, (_m, n: string) => POSIX[n] ?? '');
      out += body.replace(/\\(?![sSwWdDbtnr\]\\\-^])/g, '\\\\');
      i = j;
      continue;
    }
    if (c === '\\' && i + 1 < src.length) {
      const n = src[i + 1];
      i++;
      if (!ere && '(){}|+?'.includes(n)) out += n;
      else if (n === '<' || n === '>') out += '\\b';
      else out += '\\' + n;
      continue;
    }
    if (!ere && '(){}|+?'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return out;
}

// ---------------------------------------------------------------- echo y printf

const unescape = (s: string, stopAtC = false): string =>
  s.replace(/\\(?:([abfnrtv\\"'e])|x([0-9a-fA-F]{1,2})|0([0-7]{0,3})|(c))/g, (m, c, hx, oct, cc) => {
    if (cc) return stopAtC ? '' : m;
    if (hx) return String.fromCharCode(parseInt(hx, 16));
    if (oct !== undefined) return String.fromCharCode(parseInt(oct || '0', 8));
    return ({ a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', "'": "'", e: '\x1b' } as Record<string, string>)[c] ?? m;
  });

registerCommand('echo', (args) => {
  let nl = true;
  let esc = false;
  let i = 0;
  for (; i < args.length && /^-[neE]+$/.test(args[i]); i++) {
    for (const ch of args[i].slice(1)) {
      if (ch === 'n') nl = false;
      else if (ch === 'e') esc = true;
      else esc = false;
    }
  }
  let s = args.slice(i).join(' ');
  if (esc) s = unescape(s);
  return ok(s + (nl ? '\n' : ''));
});

const shQuote = (s: string) => (s === '' ? "''" : /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Formatea según printf de Bash; si sobran argumentos reutiliza el formato. */
export function formatPrintf(fmt: string, vals: string[]): string {
  const spec = /%([-+ 0#]*)(\d+)?(?:\.(\d+))?([sdifxXocbqeEgG%])/g;
  let used = 0;
  const once = (): string => {
    used = 0;
    const text = fmt.replace(/\\(?:[abfnrtv\\"'e]|x[0-9a-fA-F]{1,2}|0[0-7]{0,3})|%([-+ 0#]*)(\d+)?(?:\.(\d+))?([sdifxXocbqeEgG%])/g, (m, fl: string, w: string, pr: string, cv: string) => {
      if (!cv) return unescape(m);
      if (cv === '%') return '%';
      const raw = vals[used++] ?? '';
      let t: string;
      const num = () => {
        const n = raw === '' ? 0 : raw.startsWith("'") ? raw.charCodeAt(1) : Number(raw);
        return Number.isNaN(n) ? 0 : n;
      };
      switch (cv) {
        case 'd': case 'i': t = String(Math.trunc(num())); break;
        case 'f': case 'e': case 'E': case 'g': case 'G': t = num().toFixed(pr === undefined ? 6 : Number(pr)); break;
        case 'x': t = Math.trunc(num()).toString(16); break;
        case 'X': t = Math.trunc(num()).toString(16).toUpperCase(); break;
        case 'o': t = Math.trunc(num()).toString(8); break;
        case 'c': t = raw.slice(0, 1); break;
        case 'b': t = unescape(raw, true); break;
        case 'q': t = shQuote(raw); break;
        default: t = pr !== undefined ? raw.slice(0, Number(pr)) : raw;
      }
      if ('+'.includes('') && fl?.includes('+') && 'dif'.includes(cv) && !t.startsWith('-')) t = '+' + t;
      const width = w ? Number(w) : 0;
      if (t.length < width) {
        if (fl?.includes('-')) t = t.padEnd(width);
        else if (fl?.includes('0') && 'difxXo'.includes(cv)) t = (t.startsWith('-') ? '-' : '') + t.replace('-', '').padStart(width - (t.startsWith('-') ? 1 : 0), '0');
        else t = t.padStart(width);
      }
      return t;
    });
    return text;
  };
  void spec;
  let out = once();
  while (used > 0 && used < vals.length) {
    vals = vals.slice(used);
    out += once();
  }
  return out;
}

registerCommand('printf', (args) => {
  const [fmt, ...vals] = args;
  if (fmt === undefined) return fail('printf: usage: printf [-v var] format [arguments]', 2);
  return ok(formatPrintf(fmt, vals));
});

// ---------------------------------------------------------------- ls

const modeStr = (type: string, mode: number): string => {
  const bit = (m: number, r: string, w: string, x: string, s?: [number, string, string]) =>
    (m & 4 ? r : '-') + (m & 2 ? w : '-') + (s && mode & s[0] ? (m & 1 ? s[1] : s[2]) : m & 1 ? x : '-');
  return (type === 'dir' ? 'd' : '-') + bit((mode >> 6) & 7, 'r', 'w', 'x', [0o4000, 's', 'S']) + bit((mode >> 3) & 7, 'r', 'w', 'x', [0o2000, 's', 'S']) + bit(mode & 7, 'r', 'w', 'x', [0o1000, 't', 'T']);
};
export { modeStr };

registerCommand('ls', (args, { sh }) => {
  const flags = new Set<string>();
  const targets: string[] = [];
  for (const a of args) {
    if (a.startsWith('--')) {
      if (a === '--all') flags.add('a');
      else if (a === '--human-readable') flags.add('h');
    } else if (a.startsWith('-') && a.length > 1) for (const c of a.slice(1)) flags.add(c);
    else targets.push(a);
  }
  const human = (n: number) => (n < 1024 ? String(n) : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0).replace(/\.0$/, '') + 'K' : (n / 1048576).toFixed(1).replace(/\.0$/, '') + 'M');
  const fmtName = (name: string, st: { type: string; mode: number }) => name + (flags.has('F') ? (st.type === 'dir' ? '/' : st.mode & 0o111 ? '*' : '') : '');
  const longLine = (name: string, st: { type: string; mode: number; size: number }) =>
    `${modeStr(st.type, st.mode)} ${st.type === 'dir' ? 2 : 1} ${sh.s.me.userName} ${sh.s.me.userName} ${(flags.has('h') ? human(st.size) : String(st.size)).padStart(flags.has('h') ? 4 : 6)} Nov  7 12:00 ${fmtName(name, st)}\n`;
  const files: string[] = [];
  const dirs: string[] = [];
  let err = '';
  for (const t of targets.length ? targets : ['.']) {
    const st = sh.fs.stat(abs(sh, t));
    if (!st) {
      err += `ls: cannot access '${t}': No such file or directory\n`;
      continue;
    }
    if (st.type === 'dir' && !flags.has('d')) dirs.push(t);
    else files.push(t);
  }
  let out = '';
  const sortNames = (n: string[]) => (flags.has('r') ? [...n].reverse() : n);
  for (const f of sortNames(files)) {
    const st = sh.fs.stat(abs(sh, f))!;
    out += flags.has('l') ? longLine(f, st) : fmtName(f, st) + '\n';
  }
  const many = files.length + dirs.length > 1;
  dirs.forEach((d, k) => {
    const p = abs(sh, d);
    let names = sh.fs.list(p);
    if (flags.has('a')) names = ['.', '..', ...names];
    else if (!flags.has('A')) names = names.filter((n) => !n.startsWith('.'));
    else names = names.filter((n) => n !== '.' && n !== '..');
    if (many) out += (files.length + k > 0 ? '\n' : '') + `${d}:\n`;
    if (flags.has('l')) out += `total ${Math.ceil(names.length / 2) * 4}\n`;
    for (const n of sortNames(names)) {
      const st = sh.fs.stat(n === '.' ? p : n === '..' ? VFS.norm('..', p) : VFS.norm(n, p))!;
      out += flags.has('l') ? longLine(n, st) : fmtName(n, st) + '\n';
    }
  });
  return { out, err, code: err ? 2 : 0 };
});

// ---------------------------------------------------------------- head, tail, wc

function headTail(name: 'head' | 'tail') {
  registerCommand(name, (args, { sh, stdin }) => {
    let n = 10;
    let bytes = false;
    let plus = false;
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const num = (v: string) => {
        plus = v.startsWith('+');
        return Math.abs(Number(v));
      };
      if (a === '-n' || a === '-c') {
        bytes = a === '-c';
        n = num(args[++i] ?? '10');
      } else if (/^-[nc]/.test(a) && a.length > 2) {
        bytes = a[1] === 'c';
        n = num(a.slice(2));
      } else if (/^-\d+$/.test(a)) n = Number(a.slice(1));
      else if (a !== '-q') files.push(a);
    }
    const take = (text: string): string => {
      if (bytes) return name === 'head' ? text.slice(0, n) : text.slice(-n);
      const l = lines(text);
      return join(name === 'head' ? l.slice(0, n) : plus ? l.slice(Math.max(0, n - 1)) : n === 0 ? [] : l.slice(-n));
    };
    if (files.length > 1) {
      let out = '';
      for (const f of files) {
        const r = readInputs(sh, [f], '');
        if ('err' in r) return fail(`${name}: cannot open '${f}' for reading: No such file or directory`);
        out += `${out ? '\n' : ''}==> ${f} <==\n${take(r.text)}`;
      }
      return ok(out);
    }
    const r = readInputs(sh, files, stdin);
    return 'err' in r ? fail(`${name}: cannot open '${files[0]}' for reading: No such file or directory`) : ok(take(r.text));
  });
}
headTail('head');
headTail('tail');

registerCommand('wc', (args, { sh, stdin }) => {
  const flags = new Set<string>();
  const files: string[] = [];
  for (const a of args) {
    if (a.startsWith('--')) flags.add(a === '--lines' ? 'l' : a === '--words' ? 'w' : a === '--bytes' ? 'c' : a.slice(2));
    else if (a.startsWith('-') && a.length > 1) for (const c of a.slice(1)) flags.add(c);
    else files.push(a);
  }
  const count = (t: string) => ({ l: (t.match(/\n/g) ?? []).length, w: t.split(/\s+/).filter(Boolean).length, c: t.length });
  const cols = (['l', 'w', 'c'] as const).filter((k) => flags.has(k) || flags.has(k === 'c' ? 'm' : '') || false);
  const use = cols.length ? cols : (['l', 'w', 'c'] as const);
  const rows: { name?: string; n: ReturnType<typeof count> }[] = [];
  if (!files.length) rows.push({ n: count(stdin) });
  for (const f of files) {
    const r = readInputs(sh, [f], '');
    if ('err' in r) return fail(`wc: ${f}: No such file or directory`);
    rows.push({ name: f, n: count(r.text) });
  }
  if (rows.length > 1) rows.push({ name: 'total', n: rows.reduce((a, r) => ({ l: a.l + r.n.l, w: a.w + r.n.w, c: a.c + r.n.c }), { l: 0, w: 0, c: 0 }) });
  const width = use.length === 1 && rows.length === 1 ? 0 : !files.length ? 7 : String(Math.max(...rows.map((r) => r.n.c))).length;
  return ok(rows.map((r) => use.map((k) => String(r.n[k]).padStart(width)).join(' ') + (r.name ? ' ' + r.name : '')).join('\n') + '\n');
});

// ---------------------------------------------------------------- sort, uniq, cut, tr

registerCommand('sort', (args, { sh, stdin }) => {
  const g = { n: false, r: false, u: false, f: false, h: false };
  let sep: string | undefined;
  const keys: { from: number; to?: number; n: boolean; r: boolean; f: boolean }[] = [];
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-k' || /^-k./.test(a)) {
      const v = a === '-k' ? args[++i] : a.slice(2);
      const m = /^(\d+)(?:\.\d+)?([a-zA-Z]*)(?:,(\d+)(?:\.\d+)?([a-zA-Z]*))?$/.exec(v ?? '');
      if (!m) return fail(`sort: invalid number at field start: invalid count at start of '${v}'`, 2);
      const mods = (m[2] ?? '') + (m[4] ?? '');
      keys.push({ from: Number(m[1]), to: m[3] ? Number(m[3]) : undefined, n: mods.includes('n'), r: mods.includes('r'), f: mods.includes('f') });
    } else if (a === '-t' || /^-t./.test(a)) sep = a === '-t' ? args[++i] : a.slice(2);
    else if (a === '-o') i++;
    else if (a.startsWith('--')) {
      if (a === '--reverse') g.r = true;
      else if (a === '--numeric-sort') g.n = true;
      else if (a === '--unique') g.u = true;
    } else if (a.startsWith('-') && a.length > 1) for (const c of a.slice(1)) {
      if (c in g) g[c as keyof typeof g] = true;
    } else files.push(a);
  }
  const r = readInputs(sh, files, stdin);
  if ('err' in r) return fail(`sort: cannot read: ${r.err}`, 2);
  const field = (line: string, k: { from: number; to?: number }): string => {
    const parts = sep === undefined ? line.match(/\s*\S+/g) ?? [] : line.split(sep);
    const sl = parts.slice(k.from - 1, k.to ?? (sep === undefined ? k.from - 1 + parts.length : parts.length));
    return sep === undefined ? sl.join('') : sl.join(sep);
  };
  const toNum = (s: string) => {
    const m = /^\s*[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/.exec(s);
    return m ? parseFloat(m[0]) : 0;
  };
  const human = (s: string) => {
    const m = /^\s*([\d.]+)\s*([KMGT]?)/i.exec(s);
    return m ? parseFloat(m[1]) * 1024 ** ('KMGT'.indexOf((m[2] || '').toUpperCase()) + 1) : 0;
  };
  const cmp = (a: string, b: string): number => {
    const ks = keys.length ? keys : [{ from: 1, to: undefined as number | undefined, n: g.n, r: g.r, f: g.f }];
    for (const k of ks) {
      const x = keys.length ? field(a, k) : a;
      const y = keys.length ? field(b, k) : b;
      let d: number;
      if (g.h && !keys.length) d = human(x) - human(y);
      else if (k.n || (g.n && keys.length)) d = toNum(x) - toNum(y);
      else {
        const p = k.f || g.f ? x.toLowerCase() : x;
        const q = k.f || g.f ? y.toLowerCase() : y;
        d = p < q ? -1 : p > q ? 1 : 0;
      }
      if (d !== 0) return k.r || (keys.length && g.r) ? -d : d;
    }
    return 0;
  };
  let l = lines(r.text);
  l = l.map((v, i) => ({ v, i })).sort((a, b) => cmp(a.v, b.v) || (a.v < b.v ? -1 : a.v > b.v ? 1 : 0) * (g.r ? -1 : 1) || a.i - b.i).map((x) => x.v);
  if (g.u) l = l.filter((v, i) => i === 0 || cmp(l[i - 1], v) !== 0);
  return ok(join(l));
});

registerCommand('uniq', (args, { sh, stdin }) => {
  const flags = new Set<string>();
  const rest: string[] = [];
  for (const a of args) {
    if (a.startsWith('-') && a.length > 1) for (const c of a.slice(1)) flags.add(c);
    else rest.push(a);
  }
  const r = readInputs(sh, rest, stdin);
  if ('err' in r) return fail(`uniq: ${r.err}`);
  const groups: { line: string; n: number }[] = [];
  for (const l of lines(r.text)) {
    const last = groups[groups.length - 1];
    if (last && (flags.has('i') ? last.line.toLowerCase() === l.toLowerCase() : last.line === l)) last.n++;
    else groups.push({ line: l, n: 1 });
  }
  const sel = groups.filter((g) => (flags.has('d') ? g.n > 1 : flags.has('u') ? g.n === 1 : true));
  return ok(join(sel.map((g) => (flags.has('c') ? `${String(g.n).padStart(7)} ${g.line}` : g.line))));
});

const parseRanges = (spec: string): ((i: number, len: number) => boolean) => {
  const parts = spec.split(',').map((p) => {
    const m = /^(\d*)-(\d*)$/.exec(p);
    if (m) return { a: m[1] ? Number(m[1]) : 1, b: m[2] ? Number(m[2]) : Infinity };
    return { a: Number(p), b: Number(p) };
  });
  return (i) => parts.some((p) => i >= p.a && i <= p.b);
};

registerCommand('cut', (args, { sh, stdin }) => {
  let d = '\t';
  let f: string | undefined;
  let c: string | undefined;
  let onlyDelim = false;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-d')) d = a.length > 2 ? a.slice(2) : (args[++i] ?? '\t');
    else if (a.startsWith('-f')) f = a.length > 2 ? a.slice(2) : args[++i];
    else if (a.startsWith('-c')) c = a.length > 2 ? a.slice(2) : args[++i];
    else if (a === '-s') onlyDelim = true;
    else files.push(a);
  }
  if (f === undefined && c === undefined) return fail('cut: you must specify a list of bytes, characters, or fields', 1);
  const r = readInputs(sh, files, stdin);
  if ('err' in r) return fail(`cut: ${r.err}`);
  const out: string[] = [];
  if (c !== undefined) {
    const pick = parseRanges(c);
    for (const l of lines(r.text)) out.push([...l].filter((_ch, i) => pick(i + 1, l.length)).join(''));
  } else {
    const pick = parseRanges(f!);
    for (const l of lines(r.text)) {
      if (!l.includes(d)) {
        if (!onlyDelim) out.push(l);
        continue;
      }
      out.push(l.split(d).filter((_x, i) => pick(i + 1, 0)).join(d));
    }
  }
  return ok(join(out));
});

const expandSet = (s: string): string => {
  const cls: Record<string, string> = { upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', lower: 'abcdefghijklmnopqrstuvwxyz', digit: '0123456789', space: ' \t\n\r\f\v', alpha: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', punct: '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~' };
  const t = unescape(s).replace(/\[:([a-z]+):\]/g, (_m, n: string) => cls[n] ?? '');
  return t.replace(/(.)-(.)/gs, (_m, a: string, b: string) => (a.charCodeAt(0) <= b.charCodeAt(0) ? Array.from({ length: b.charCodeAt(0) - a.charCodeAt(0) + 1 }, (_x, i) => String.fromCharCode(a.charCodeAt(0) + i)).join('') : _m));
};
registerCommand('tr', (args, { stdin }) => {
  const flags = new Set<string>();
  const sets: string[] = [];
  for (const a of args) {
    if (a.startsWith('-') && a.length > 1 && !sets.length) for (const ch of a.slice(1)) flags.add(ch);
    else sets.push(a);
  }
  if (!sets.length) return fail('tr: missing operand', 1);
  let s1 = expandSet(sets[0]);
  if (flags.has('c') || flags.has('C')) {
    const keep = s1;
    s1 = Array.from({ length: 256 }, (_x, i) => String.fromCharCode(i)).filter((ch) => !keep.includes(ch)).join('');
  }
  let text = stdin;
  if (flags.has('d')) text = [...text].filter((ch) => !s1.includes(ch)).join('');
  else if (sets[1] !== undefined) {
    const s2 = expandSet(sets[1]);
    text = [...text].map((ch) => { const i = s1.indexOf(ch); return i < 0 ? ch : s2[Math.min(i, s2.length - 1)] ?? ch; }).join('');
  }
  if (flags.has('s')) {
    const sq = sets[sets.length - 1] && (sets.length > 1 || !flags.has('d')) ? expandSet(sets[sets.length - 1]) : s1;
    text = text.replace(/(.)\1+/gs, (m, ch: string) => (sq.includes(ch) ? ch : m));
  }
  return ok(text);
});

// ---------------------------------------------------------------- grep

/** Ficheros bajo una ruta (recursivo), como `grep -r` y `find`. */
export function walkFiles(sh: Shell, start: string, shown: string): { path: string; show: string }[] {
  const out: { path: string; show: string }[] = [];
  const rec = (p: string, show: string) => {
    if (sh.fs.isDir(p)) for (const n of sh.fs.list(p)) rec(VFS.norm(n, p), show === '.' && false ? n : `${show.replace(/\/$/, '')}/${n}`);
    else out.push({ path: p, show });
  };
  rec(start, shown);
  return out;
}

registerCommand('grep', (args, { sh, stdin }) => {
  const f = new Set<string>();
  const pats: string[] = [];
  const rest: string[] = [];
  let after = 0;
  let before = 0;
  let max = Infinity;
  const include: RegExp[] = [];
  const exclude: RegExp[] = [];
  const globRe = (g: string) => new RegExp('^' + g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const [k, v] = [a.split('=')[0], a.includes('=') ? a.slice(a.indexOf('=') + 1) : undefined];
      const map: Record<string, string> = { '--count': 'c', '--ignore-case': 'i', '--invert-match': 'v', '--line-number': 'n', '--recursive': 'r', '--only-matching': 'o', '--word-regexp': 'w', '--line-regexp': 'x', '--files-with-matches': 'l', '--files-without-match': 'L', '--extended-regexp': 'E', '--fixed-strings': 'F', '--quiet': 'q', '--no-filename': 'h', '--with-filename': 'H', '--perl-regexp': 'P', '--silent': 'q' };
      if (map[k]) f.add(map[k]);
      else if (k === '--include' && v) include.push(globRe(v));
      else if (k === '--exclude' && v) exclude.push(globRe(v));
      else if (k === '--regexp' && v) pats.push(v);
      else if (k === '--max-count' && v) max = Number(v);
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d+$/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if ('eABCm'.includes(ch)) {
          const val = a.length > j + 1 ? a.slice(j + 1) : (args[++i] ?? '');
          if (ch === 'e') pats.push(val);
          else if (ch === 'A') after = Number(val);
          else if (ch === 'B') before = Number(val);
          else if (ch === 'C') after = before = Number(val);
          else max = Number(val);
          break;
        }
        f.add(ch);
        if (ch === 'R') f.add('r');
      }
      continue;
    }
    if (/^-\d+$/.test(a)) after = before = Number(a.slice(1));
    else rest.push(a);
  }
  if (!pats.length) {
    const p = rest.shift();
    if (p === undefined) return fail('Usage: grep [OPTION]... PATTERNS [FILE]...', 2);
    pats.push(p);
  }
  const compile = (p: string) => (f.has('F') ? p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : toJsRegex(p, f.has('E') || f.has('P')));
  let source = pats.flatMap((p) => p.split('\n')).map((p) => `(?:${compile(p)})`).join('|');
  if (f.has('x')) source = `^(?:${source})$`;
  else if (f.has('w')) source = `(?<![A-Za-z0-9_])(?:${source})(?![A-Za-z0-9_])`;
  let re: RegExp;
  try {
    re = new RegExp(source, (f.has('i') ? 'i' : '') + 'g');
  } catch {
    return fail('grep: Invalid regular expression', 2);
  }
  type Src = { name: string; text: string };
  const inputs: Src[] = [];
  let err = '';
  const recursive = f.has('r');
  const targets = rest.length ? rest : recursive ? ['.'] : [];
  if (!targets.length) inputs.push({ name: '(standard input)', text: stdin });
  for (const t of targets) {
    const p = abs(sh, t);
    if (!sh.fs.exists(p)) {
      if (!f.has('s')) err += `grep: ${t}: No such file or directory\n`;
      continue;
    }
    if (sh.fs.isDir(p)) {
      if (!recursive) {
        if (!f.has('s')) err += `grep: ${t}: Is a directory\n`;
        continue;
      }
      for (const w of walkFiles(sh, p, t)) {
        const base = w.show.split('/').pop()!;
        if (include.length && !include.some((r) => r.test(base))) continue;
        if (exclude.some((r) => r.test(base))) continue;
        inputs.push({ name: w.show.replace(/^\.\/\.\//, './'), text: sh.fs.readFile(w.path) });
      }
    } else inputs.push({ name: t, text: sh.fs.readFile(p) });
  }
  const withName = f.has('H') || (!f.has('h') && (inputs.length > 1 || recursive));
  let out = '';
  let any = false;
  for (const inp of inputs) {
    const ls = lines(inp.text);
    const hit = ls.map((l) => {
      re.lastIndex = 0;
      return re.test(l) !== f.has('v');
    });
    let count = 0;
    const picked: number[] = [];
    hit.forEach((h, i) => {
      if (h && count < max) {
        count++;
        picked.push(i);
      }
    });
    if (count) any = true;
    if (f.has('q')) {
      if (any) return { out: '', err, code: 0 };
      continue;
    }
    const pre = withName ? inp.name : '';
    if (f.has('l') || f.has('L')) {
      if ((count > 0) === f.has('l')) out += inp.name + '\n';
      continue;
    }
    if (f.has('c')) {
      out += `${withName ? pre + ':' : ''}${count}\n`;
      continue;
    }
    const show = new Set<number>(picked);
    if (!f.has('o') && !f.has('v')) for (const i of picked) { for (let k = 1; k <= after; k++) if (i + k < ls.length) show.add(i + k); for (let k = 1; k <= before; k++) if (i - k >= 0) show.add(i - k); }
    const order = [...show].sort((a, b) => a - b);
    let prev = -2;
    for (const i of order) {
      if ((after || before) && prev >= 0 && i > prev + 1) out += '--\n';
      prev = i;
      const isMatch = picked.includes(i);
      const sepCh = isMatch ? ':' : '-';
      const prefix = (withName ? pre + sepCh : '') + (f.has('n') ? `${i + 1}${sepCh}` : '');
      if (f.has('o') && !f.has('v')) {
        re.lastIndex = 0;
        for (const m of ls[i].matchAll(re)) if (m[0] !== '') out += prefix + m[0] + '\n';
      } else out += prefix + ls[i] + '\n';
    }
  }
  return { out, err, code: any ? 0 : err ? 2 : 1 };
});

// ---------------------------------------------------------------- sed

interface Addr { t: 'n' | 'last' | 're'; n?: number; re?: RegExp }
interface SedCmd { a1?: Addr; a2?: Addr; neg: boolean; c: string; re?: RegExp; rep?: ((m: RegExpMatchArray) => string); g: boolean; nth: number; p: boolean; arg?: string; active: boolean; y?: Map<string, string> }

function parseSed(script: string, ere: boolean): SedCmd[] | string {
  const cmds: SedCmd[] = [];
  let i = 0;
  const n = script.length;
  const skipWs = () => { while (i < n && /[ \t]/.test(script[i])) i++; };
  const readDelimited = (delim: string): string | null => {
    let out = '';
    while (i < n && script[i] !== delim) {
      if (script[i] === '\\' && i + 1 < n) {
        out += script[i + 1] === delim && delim !== '\\' ? delim : script[i] + script[i + 1];
        i += 2;
      } else out += script[i++];
    }
    if (i >= n) return null;
    i++;
    return out;
  };
  const mkRe = (src: string, flags: string): RegExp | string => {
    try {
      return new RegExp(toJsRegex(src, ere), flags);
    } catch {
      return 'invalid regular expression';
    }
  };
  const addr = (): Addr | undefined | string => {
    skipWs();
    if (/\d/.test(script[i] ?? '')) {
      let v = '';
      while (/\d/.test(script[i] ?? '')) v += script[i++];
      return { t: 'n', n: Number(v) };
    }
    if (script[i] === '$') {
      i++;
      return { t: 'last' };
    }
    if (script[i] === '/' || script[i] === '\\') {
      const d = script[i] === '\\' ? script[++i] : '/';
      i++;
      const body = readDelimited(d);
      if (body === null) return 'unterminated address regex';
      let fl = '';
      if (script[i] === 'I') { fl = 'i'; i++; }
      const r = mkRe(body, fl);
      return typeof r === 'string' ? r : { t: 're', re: r };
    }
    return undefined;
  };
  while (i < n) {
    while (i < n && /[\s;]/.test(script[i])) i++;
    if (i >= n) break;
    const cmd: SedCmd = { neg: false, c: '', g: false, nth: 0, p: false, active: false };
    const a1 = addr();
    if (typeof a1 === 'string') return a1;
    cmd.a1 = a1;
    if (a1 && script[i] === ',') {
      i++;
      const a2 = addr();
      if (typeof a2 === 'string') return a2;
      cmd.a2 = a2;
    }
    skipWs();
    while (script[i] === '!') { cmd.neg = true; i++; skipWs(); }
    const c = script[i++];
    if (c === undefined) return 'missing command';
    cmd.c = c;
    if (c === 's') {
      const d = script[i++];
      const pat = readDelimited(d);
      const rep = pat === null ? null : readDelimited(d);
      if (pat === null || rep === null) return "unterminated `s' command";
      let fl = '';
      while (i < n && /[gpiIm0-9]/.test(script[i])) {
        const ch = script[i++];
        if (ch === 'g') cmd.g = true;
        else if (ch === 'p') cmd.p = true;
        else if (ch === 'i' || ch === 'I') fl += 'i';
        else if (/\d/.test(ch)) cmd.nth = cmd.nth * 10 + Number(ch);
      }
      const r = mkRe(pat, fl + 'g');
      if (typeof r === 'string') return r;
      cmd.re = r;
      const pieces: (string | number)[] = [];
      let buf = '';
      for (let k = 0; k < rep.length; k++) {
        const ch = rep[k];
        if (ch === '\\' && k + 1 < rep.length) {
          const nx = rep[++k];
          if (/\d/.test(nx)) { if (buf) pieces.push(buf); buf = ''; pieces.push(Number(nx)); }
          else if (nx === 'n') buf += '\n';
          else if (nx === 't') buf += '\t';
          else buf += nx;
        } else if (ch === '&') { if (buf) pieces.push(buf); buf = ''; pieces.push(0); }
        else buf += ch;
      }
      if (buf) pieces.push(buf);
      cmd.rep = (m) => pieces.map((p) => (typeof p === 'number' ? m[p] ?? '' : p)).join('');
    } else if (c === 'y') {
      const d = script[i++];
      const from = readDelimited(d);
      const to = from === null ? null : readDelimited(d);
      if (from === null || to === null || from.length !== to.length) return "strings for `y' command are different lengths";
      cmd.y = new Map([...from].map((ch, k) => [ch, to[k]]));
    } else if (c === 'a' || c === 'i' || c === 'c') {
      skipWs();
      if (script[i] === '\\') { i++; if (script[i] === '\n') i++; }
      let t = '';
      while (i < n && script[i] !== '\n') t += script[i++];
      cmd.arg = t;
    } else if (!'dpq=Dn'.includes(c) && c !== '}' && c !== '{') return `unknown command: \`${c}'`;
    cmds.push(cmd);
  }
  return cmds;
}

function runSed(cmds: SedCmd[], text: string, quiet: boolean, ctx: { total?: number } = {}): string {
  const endsNl = text.endsWith('\n');
  const ls = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const total = ctx.total ?? ls.length;
  let out = '';
  const emit = (s: string) => (out += s + '\n');
  for (const c of cmds) c.active = false;
  const test = (a: Addr, no: number, line: string): boolean => (a.t === 'n' ? no === a.n : a.t === 'last' ? no === total : (a.re!.lastIndex = 0, a.re!.test(line)));
  const sel = (c: SedCmd, no: number, line: string): boolean => {
    if (!c.a1) return true;
    if (!c.a2) return test(c.a1, no, line);
    if (c.active) {
      if (c.a2.t === 'n' ? no >= c.a2.n! : test(c.a2, no, line)) c.active = false;
      return true;
    }
    if (test(c.a1, no, line)) {
      if (!(c.a2.t === 'n' && c.a2.n! <= no) && !(c.a2.t === 'last' && no === total)) c.active = true;
      return true;
    }
    return false;
  };
  for (let k = 0; k < ls.length; k++) {
    let line = ls[k];
    let del = false;
    let quit = false;
    for (const c of cmds) {
      if (sel(c, k + 1, line) === c.neg) continue;
      if (c.c === 'd') { del = true; break; }
      else if (c.c === 'p') emit(line);
      else if (c.c === 'q') { quit = true; break; }
      else if (c.c === '=') emit(String(k + 1));
      else if (c.c === 'a') { ctx.total = total; (c as { after?: string }).after = c.arg; }
      else if (c.c === 'i') emit(c.arg ?? '');
      else if (c.c === 'c') { emit(c.arg ?? ''); del = true; break; }
      else if (c.c === 'y') line = [...line].map((ch) => c.y!.get(ch) ?? ch).join('');
      else if (c.c === 's') {
        let cnt = 0;
        let changed = false;
        c.re!.lastIndex = 0;
        const res = line.replace(c.re!, (...m) => {
          const groups = m.slice(0, -2).filter((x) => typeof x === 'string' || x === undefined) as string[];
          const mm = Object.assign(groups, { index: 0, input: line }) as RegExpMatchArray;
          cnt++;
          if (c.nth ? (c.g ? cnt >= c.nth : cnt === c.nth) : c.g || cnt === 1) {
            changed = true;
            return c.rep!(mm);
          }
          return m[0];
        });
        line = res;
        if (changed && c.p) emit(line);
      }
    }
    if (!del && !quiet) emit(line);
    for (const c of cmds) if (c.c === 'a' && !del && sel({ ...c, a2: c.a2 } as SedCmd, k + 1, ls[k]) !== c.neg) emit(c.arg ?? '');
    if (quit) break;
  }
  return endsNl || out === '' ? out : out.slice(0, -1);
}

registerCommand('sed', (args, { sh, stdin }) => {
  let quiet = false;
  let ere = false;
  let inPlace: string | null = null;
  const scripts: string[] = [];
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-e' || a === '--expression') scripts.push(args[++i] ?? '');
    else if (a.startsWith('--expression=')) scripts.push(a.slice(13));
    else if (a === '-n' || a === '--quiet' || a === '--silent') quiet = true;
    else if (a === '-E' || a === '-r' || a === '--regexp-extended') ere = true;
    else if (a.startsWith('-i') || a === '--in-place') inPlace = a.startsWith('-i') ? a.slice(2) : '';
    else if (/^-[nEr]+$/.test(a)) { for (const ch of a.slice(1)) { if (ch === 'n') quiet = true; else ere = true; } }
    else if (a === '-s') continue;
    else if (a.startsWith('-') && a.length > 1) return fail(`sed: invalid option -- '${a.slice(1)}'`, 1);
    else if (!scripts.length && !files.length && !args.some((x) => x === '-e')) scripts.push(a);
    else files.push(a);
  }
  if (!scripts.length) return fail('Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...', 1);
  const cmds = parseSed(scripts.join('\n'), ere);
  if (typeof cmds === 'string') return fail(`sed: -e expression #1, char ${scripts.join('\n').length}: ${cmds}`, 1);
  if (inPlace !== null) {
    if (!files.length) return fail('sed: no input files', 1);
    for (const f of files) {
      const r = readInputs(sh, [f], '');
      if ('err' in r) return fail(`sed: can't read ${f}: No such file or directory`, 2);
      if (inPlace) sh.fs.writeFile(abs(sh, f + inPlace), r.text);
      sh.fs.writeFile(abs(sh, f), runSed(cmds, r.text, quiet));
    }
    return ok();
  }
  const r = readInputs(sh, files, stdin);
  if ('err' in r) return fail(`sed: can't read ${r.err.split(':')[0]}: No such file or directory`, 2);
  return ok(runSed(cmds, r.text, quiet));
});

// ---------------------------------------------------------------- basename, dirname, xargs, nl, tac

registerCommand('basename', (a) => {
  const base = (a[0] ?? '').replace(/\/+$/, '').split('/').pop() ?? '';
  const suf = a[1];
  return ok((suf && base.endsWith(suf) && base !== suf ? base.slice(0, -suf.length) : base) + '\n');
});
registerCommand('dirname', (a) => {
  const parts = (a[0] ?? '').replace(/\/+$/, '').split('/');
  parts.pop();
  const d = parts.join('/');
  return ok((d || ((a[0] ?? '').startsWith('/') ? '/' : '.')) + '\n');
});
registerCommand('tac', (args, { sh, stdin }) => {
  const r = readInputs(sh, args, stdin);
  return 'err' in r ? fail(`tac: ${r.err}`) : ok(join(lines(r.text).reverse()));
});
registerCommand('nl', (args, { sh, stdin }) => {
  const r = readInputs(sh, args.filter((x) => !x.startsWith('-')), stdin);
  return 'err' in r ? fail(`nl: ${r.err}`) : ok(join(lines(r.text).map((l, i) => `${String(i + 1).padStart(6)}\t${l}`)));
});

registerCommand('xargs', async (args, { sh, stdin }) => {
  let perCall = Infinity;
  let repl: string | null = null;
  const cmdWords: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!cmdWords.length && a === '-n') perCall = Number(args[++i]);
    else if (!cmdWords.length && /^-n\d+$/.test(a)) perCall = Number(a.slice(2));
    else if (!cmdWords.length && (a === '-I' || a === '-i')) repl = args[++i] ?? '{}';
    else if (!cmdWords.length && /^-I./.test(a)) repl = a.slice(2);
    else if (!cmdWords.length && (a === '-r' || a === '-t' || a === '-0')) continue;
    else cmdWords.push(a);
  }
  const base = cmdWords.length ? cmdWords : ['echo'];
  const items = repl !== null ? lines(stdin) : stdin.split(/\s+/).filter(Boolean);
  const calls: string[] = [];
  if (repl !== null) for (const it of items) calls.push(base.map((w) => shQuote(w.split(repl!).join(it))).join(' '));
  else if (!items.length) calls.push(base.map(shQuote).join(' '));
  else for (let k = 0; k < items.length; k += perCall) calls.push([...base.map(shQuote), ...items.slice(k, k + perCall).map(shQuote)].join(' '));
  let out = '';
  let err = '';
  let code = 0;
  for (const c of calls) {
    const r: CmdResult = await runString(sh, c);
    out += r.out;
    err += r.err;
    if (r.code) code = 123;
  }
  return { out, err, code };
});

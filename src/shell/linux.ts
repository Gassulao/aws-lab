// Comandos de Linux para guiones y administración: bash/sh/source, read, shift, chmod, stat, id, find, crontab.
import { registerCommand, ok, fail, runScript, runString, type Shell, type CmdResult } from './interp';
import { VFS, FsError } from './fs';
import { abs, readInputs, lines } from './commands';
import { modeStr, walkFiles } from './textutils';

// ---------------------------------------------------------------- guiones

const scriptCmd = (name: string) =>
  registerCommand(name, async (args, { sh, stdin }) => {
    if (args[0] === '-c') {
      if (args[1] === undefined) return fail(`${name}: -c: option requires an argument`, 2);
      return runScript(sh, args[1], args[2] ?? name, args.slice(3), 'child', stdin);
    }
    const rest = args.filter((a, i) => i > 0 || !/^-[a-z]$/.test(a) || args.length === 1);
    const [file, ...params] = rest;
    if (!file) return runScript(sh, stdin, name, [], 'child');
    const p = abs(sh, file);
    if (!sh.fs.exists(p)) return fail(`${name}: ${file}: No such file or directory`, 127);
    if (sh.fs.isDir(p)) return fail(`${name}: ${file}: Is a directory`, 126);
    return runScript(sh, sh.fs.readFile(p), file, params, 'child', stdin);
  });
scriptCmd('bash');
scriptCmd('sh');

registerCommand(['source', '.'], async (args, { sh }) => {
  const [file, ...params] = args;
  if (!file) return fail('bash: source: filename argument required', 2);
  const p = abs(sh, file);
  if (!sh.fs.isFile(p)) return fail(`bash: ${file}: No such file or directory`, 1);
  return runScript(sh, sh.fs.readFile(p), file, params.length ? params : sh.pos ?? [], 'source');
});

registerCommand('shift', (args, { sh }) => {
  const n = Number(args[0] ?? 1);
  if ((sh.pos ?? []).length < n) return { out: '', err: '', code: 1 };
  sh.pos = (sh.pos ?? []).slice(n);
  return ok();
});

registerCommand('read', (args, { sh }) => {
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (['-p', '-n', '-t', '-d', '-N', '-u'].includes(a)) i++;
    else if (a.startsWith('-') && a.length > 1) continue;
    else names.push(a);
  }
  if (!names.length) names.push('REPLY');
  const src = sh.readSrc ?? { text: '' };
  if (src.text === '') {
    for (const n of names) sh.vars[n] = '';
    return { out: '', err: '', code: 1 };
  }
  const nl = src.text.indexOf('\n');
  const line = nl < 0 ? src.text : src.text.slice(0, nl);
  const eof = nl < 0;
  src.text = nl < 0 ? '' : src.text.slice(nl + 1);
  const ifs = sh.vars.IFS ?? ' \t\n';
  const splitter = ifs === '' ? null : new RegExp(`[${ifs.replace(/[\]\\^-]/g, '\\$&').replace(/\t/g, '\\t').replace(/\n/g, '\\n')}]`);
  let restText = line;
  names.forEach((n, i) => {
    if (i === names.length - 1 || !splitter) {
      sh.vars[n] = restText.replace(/^[ \t]+|[ \t]+$/g, (m) => (ifs.includes(' ') ? '' : m));
      restText = '';
      return;
    }
    const trimmed = ifs.includes(' ') ? restText.replace(/^[ \t]+/, '') : restText;
    const m = splitter.exec(trimmed);
    if (!m) {
      sh.vars[n] = trimmed;
      restText = '';
    } else {
      sh.vars[n] = trimmed.slice(0, m.index);
      restText = trimmed.slice(m.index + 1);
    }
  });
  for (const n of names) sh.s.cli.env[n] = sh.vars[n];
  return { out: '', err: '', code: eof && line === '' ? 1 : 0 };
});

// ---------------------------------------------------------------- permisos

/** Calcula el modo resultante de aplicar un modo octal o simbólico (`u+x`, `go-rwx`, `a=r`). */
export function applyChmod(spec: string, cur: number, isDir: boolean): number | null {
  if (/^[0-7]{1,4}$/.test(spec)) return parseInt(spec, 8);
  let mode = cur;
  for (const clause of spec.split(',')) {
    const m = /^([ugoa]*)((?:[-+=][rwxXst]*)+)$/.exec(clause);
    if (!m) return null;
    const who = m[1] || 'a';
    for (const [, op, perms] of m[2].matchAll(/([-+=])([rwxXst]*)/g)) {
      let bits = 0;
      for (const p of perms) {
        if (p === 'r') bits |= 4;
        else if (p === 'w') bits |= 2;
        else if (p === 'x' || (p === 'X' && (isDir || cur & 0o111))) bits |= 1;
      }
      for (const [ch, shift] of [['u', 6], ['g', 3], ['o', 0]] as const) {
        if (!(who.includes(ch) || who.includes('a'))) continue;
        const mask = 7 << shift;
        const v = bits << shift;
        if (op === '+') mode |= v;
        else if (op === '-') mode &= ~v;
        else mode = (mode & ~mask) | v;
      }
    }
  }
  return mode;
}

registerCommand('chmod', (args, { sh }) => {
  const flags = new Set<string>();
  const rest: string[] = [];
  for (const a of args) {
    if (/^-[Rvc]+$/.test(a)) for (const ch of a.slice(1)) flags.add(ch);
    else rest.push(a);
  }
  const [spec, ...files] = rest;
  if (spec === undefined || !files.length) return fail(`chmod: missing operand${spec === undefined ? '' : ` after ‘${spec}’`}\nTry 'chmod --help' for more information.`, 1);
  let out = '';
  for (const f of files) {
    const p = abs(sh, f);
    const st = sh.fs.stat(p);
    if (!st) return fail(`chmod: cannot access '${f}': No such file or directory`, 1);
    const targets = flags.has('R') && st.type === 'dir' ? [p, ...walkFiles(sh, p, f).map((w) => w.path)] : [p];
    for (const t of targets) {
      const s2 = sh.fs.stat(t)!;
      const nm = applyChmod(spec, s2.mode, s2.type === 'dir');
      if (nm === null) return fail(`chmod: invalid mode: ‘${spec}’\nTry 'chmod --help' for more information.`, 1);
      if (flags.has('v')) out += `mode of '${t === p ? f : t}' changed from ${(s2.mode & 0o7777).toString(8).padStart(4, '0')} (${modeStr(s2.type, s2.mode).slice(1)}) to ${(nm & 0o7777).toString(8).padStart(4, '0')} (${modeStr(s2.type, nm).slice(1)})\n`;
      sh.fs.chmod(t, nm);
    }
  }
  return ok(out);
});

registerCommand('stat', (args, { sh }) => {
  let fmt: string | undefined;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' || args[i] === '--format') fmt = args[++i];
    else if (args[i].startsWith('--format=')) fmt = args[i].slice(9);
    else files.push(args[i]);
  }
  let out = '';
  for (const f of files) {
    const st = sh.fs.stat(abs(sh, f));
    if (!st) return fail(`stat: cannot statx '${f}': No such file or directory`, 1);
    const u = sh.s.me.userName;
    const kind = st.type === 'dir' ? 'directory' : st.size === 0 ? 'regular empty file' : 'regular file';
    if (fmt !== undefined) out += fmt.replace(/%([aAnsUGFu])/g, (_m, c: string) => ({ a: (st.mode & 0o7777).toString(8), A: modeStr(st.type, st.mode), n: f, s: String(st.size), U: u, G: u, F: kind, u: '1000' } as Record<string, string>)[c]) + '\n';
    else out += `  File: ${f}\n  Size: ${st.size}\t\tBlocks: ${Math.ceil(st.size / 512)}\t   IO Block: 4096   ${kind}\nAccess: (${(st.mode & 0o7777).toString(8).padStart(4, '0')}/${modeStr(st.type, st.mode)})  Uid: ( 1000/${u})   Gid: ( 1000/${u})\n`;
  }
  return ok(out);
});

registerCommand('id', (args, { sh }) => {
  const u = sh.s.me.userName;
  if (args.includes('-un') || args.includes('-nu')) return ok(u + '\n');
  if (args.includes('-gn') || args.includes('-ng')) return ok(u + '\n');
  if (args.includes('-u')) return ok('1000\n');
  if (args.includes('-g')) return ok('1000\n');
  return ok(`uid=1000(${u}) gid=1000(${u}) groups=1000(${u})\n`);
});
registerCommand('umask', () => ok('0022\n'));

// ---------------------------------------------------------------- find

registerCommand('find', async (args, { sh }) => {
  const starts: string[] = [];
  let i = 0;
  while (i < args.length && !args[i].startsWith('-') && args[i] !== '!' && args[i] !== '(') starts.push(args[i++]);
  if (!starts.length) starts.push('.');
  type Pred = (p: string, show: string, st: NonNullable<ReturnType<VFS['stat']>>, depth: number) => boolean;
  const preds: Pred[] = [];
  let maxDepth = Infinity;
  let minDepth = 0;
  let exec: { cmd: string[]; plus: boolean } | null = null;
  let print0 = false;
  let neg = false;
  const push = (f: Pred) => {
    const g = neg ? (...a: Parameters<Pred>) => !f(...a) : f;
    neg = false;
    preds.push(g);
  };
  const globRe = (g: string, ci: boolean) => new RegExp('^' + g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\[!/g, '[^') + '$', ci ? 'i' : '');
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '!' || a === '-not') neg = true;
    else if (a === '-name' || a === '-iname') {
      const re = globRe(args[++i] ?? '', a === '-iname');
      push((p) => re.test(p.split('/').pop() ?? ''));
    } else if (a === '-type') {
      const t = args[++i];
      push((_p, _s, st) => (t === 'd' ? st.type === 'dir' : t === 'f' ? st.type === 'file' : false));
    } else if (a === '-maxdepth') maxDepth = Number(args[++i]);
    else if (a === '-mindepth') minDepth = Number(args[++i]);
    else if (a === '-perm') {
      const v = args[++i] ?? '';
      const all = v.startsWith('-');
      const any = v.startsWith('/');
      const m = parseInt(v.replace(/^[-/]/, ''), 8);
      push((_p, _s, st) => (all ? (st.mode & m) === m : any ? (st.mode & m) !== 0 : (st.mode & 0o7777) === m));
    } else if (a === '-empty') push((p, _s, st) => (st.type === 'file' ? st.size === 0 : sh.fs.list(p).length === 0));
    else if (a === '-size') {
      const v = args[++i] ?? '';
      const m = /^([+-]?)(\d+)([ckMG]?)$/.exec(v);
      if (!m) return fail(`find: invalid argument '${v}' to '-size'`, 1);
      const unit = { '': 512, c: 1, k: 1024, M: 1048576, G: 1073741824 }[m[3] as '' | 'c' | 'k' | 'M' | 'G'];
      push((_p, _s, st) => {
        const blocks = Math.ceil(st.size / unit);
        return m[1] === '+' ? blocks > Number(m[2]) : m[1] === '-' ? blocks < Number(m[2]) : blocks === Number(m[2]);
      });
    } else if (a === '-print0') print0 = true;
    else if (a === '-print') continue;
    else if (a === '-exec') {
      const cmd: string[] = [];
      i++;
      while (i < args.length && args[i] !== ';' && args[i] !== '+') cmd.push(args[i++]);
      exec = { cmd, plus: args[i] === '+' };
    } else if (a === '-a' || a === '-and') continue;
    else return fail(`find: unknown predicate \`${a}'`, 1);
  }
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const found: { path: string; show: string }[] = [];
  for (const s of starts) {
    const p = abs(sh, s);
    if (!sh.fs.exists(p)) return fail(`find: ‘${s}’: No such file or directory`, 1);
    const rec = (path: string, show: string, depth: number) => {
      const st = sh.fs.stat(path)!;
      if (depth >= minDepth && preds.every((f) => f(path, show, st, depth))) found.push({ path, show });
      if (st.type === 'dir' && depth < maxDepth) for (const n of sh.fs.list(path)) rec(VFS.norm(n, path), `${show.replace(/\/$/, '')}/${n}`, depth + 1);
    };
    rec(p, s, 0);
  }
  if (exec) {
    let out = '';
    let err = '';
    let code = 0;
    const batches = exec.plus ? [found] : found.map((f) => [f]);
    for (const b of batches) {
      if (!b.length) continue;
      const line = exec.plus
        ? [...exec.cmd.filter((w) => w !== '{}').map(quote), ...b.map((f) => quote(f.show))].join(' ')
        : exec.cmd.map((w) => quote(w.split('{}').join(b[0].show))).join(' ');
      const r: CmdResult = await runString(sh, line);
      out += r.out;
      err += r.err;
      if (r.code) code = 1;
    }
    return { out, err, code };
  }
  return ok(found.map((f) => f.show).join(print0 ? '\0' : '\n') + (found.length ? (print0 ? '\0' : '\n') : ''));
});

// ---------------------------------------------------------------- cron

const CRON_DIR = '/var/spool/cron/crontabs';
const FIELD = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
];
const NAMES: Record<number, string[]> = { 3: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'], 4: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] };

/** Valida un campo de cron: asterisco, pasos, rangos, listas y nombres de mes o día. */
export function cronFieldOk(v: string, k: number): boolean {
  const f = FIELD[k];
  const num = (x: string): number | null => {
    if (/^\d+$/.test(x)) return Number(x);
    const i = NAMES[k]?.indexOf(x.toLowerCase().slice(0, 3)) ?? -1;
    return i < 0 ? null : k === 3 ? i + 1 : i;
  };
  return v.split(',').every((part) => {
    const m = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return false;
    if (m[2] !== undefined && Number(m[2]) === 0) return false;
    if (m[1] === '*') return true;
    const [a, b] = m[1].split('-').map(num);
    if (a === null || a < f.min || a > f.max) return false;
    return b === undefined || (b !== null && b >= a && b <= f.max);
  });
}

export function cronValidate(text: string): string | null {
  const ls = text.split('\n');
  for (let n = 0; n < ls.length; n++) {
    const l = ls[n].trim();
    if (!l || l.startsWith('#') || /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l)) continue;
    if (/^@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)\s+\S/.test(l)) continue;
    const parts = l.split(/\s+/);
    if (parts.length < 6) return `"-":${n + 1}: bad minute`;
    for (let k = 0; k < 5; k++) if (!cronFieldOk(parts[k], k)) return `"-":${n + 1}: bad ${FIELD[k].name}`;
  }
  return null;
}

registerCommand('crontab', (args, { sh, stdin }) => {
  const user = sh.s.me.userName;
  const path = `${CRON_DIR}/${user}`;
  if (args[0] === '-l') {
    if (!sh.fs.isFile(path)) return fail(`no crontab for ${user}`, 1);
    return ok(sh.fs.readFile(path));
  }
  if (args[0] === '-r') {
    if (!sh.fs.isFile(path)) return fail(`no crontab for ${user}`, 1);
    sh.fs.remove(path);
    return ok();
  }
  if (args[0] === '-e') return fail('crontab: no editor available in this terminal: use `crontab fichero` o `crontab -`', 1);
  if (args[0] === '-u') return fail('crontab: must be privileged to use -u', 1);
  const file = args[0];
  let text: string;
  if (file === undefined || file === '-') text = stdin;
  else {
    const r = readInputs(sh, [file], '');
    if ('err' in r) return fail(`crontab: ${file}: No such file or directory`, 1);
    text = r.text;
  }
  const bad = cronValidate(text);
  if (bad) return fail(`${bad.replace('"-"', `"${file ?? '-'}"`)}\nerrors in crontab file, can't install.`, 1);
  try {
    sh.fs.mkdir(CRON_DIR, true);
    sh.fs.writeFile(path, text.endsWith('\n') || text === '' ? text : text + '\n');
  } catch (e) {
    return fail(`crontab: ${(e as FsError).message}`, 1);
  }
  return ok();
});

void lines;
export type { Shell };

// Comandos de Linux disponibles en la terminal simulada.
import { registerCommand, ok, fail, runString, type Shell, type CmdResult } from './interp';
import { VFS } from './fs';
import { now } from '../engine/util';
import { jq as runJq, JqError } from './jq';
import { anonymousGet } from '../engine/services/s3';
import { presignedGet } from '../engine/services/s3Extra';
import { webGet, webRequest } from '../engine/services/web';

export const abs = (sh: Shell, p: string) => VFS.norm(p, sh.cwd);

export function readInputs(sh: Shell, files: string[], stdin: string): { text: string } | { err: string } {
  if (!files.length) return { text: stdin };
  let text = '';
  for (const f of files) {
    try {
      text += sh.fs.readFile(abs(sh, f));
    } catch (e) {
      return { err: `${f}: ${(e as Error).message}` };
    }
  }
  return { text };
}

export function splitFlags(args: string[]): { flags: Set<string>; vals: Record<string, string>; rest: string[] } {
  const flags = new Set<string>();
  const vals: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) flags.add(a.slice(2));
    else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) for (const c of a.slice(1)) flags.add(c);
    else rest.push(a);
  }
  return { flags, vals, rest };
}



registerCommand('pwd', (_a, { sh }) => ok(sh.cwd + '\n'));
registerCommand('whoami', (_a, { sh }) => ok(sh.s.me.userName + '\n'));
registerCommand('hostname', () => ok('aws-lab\n'));
registerCommand('uname', (a) => ok(a.includes('-a') ? 'Linux aws-lab 6.1.0 #1 SMP x86_64 GNU/Linux\n' : 'Linux\n'));
registerCommand('clear', () => ok(''));
registerCommand('true', () => ok());
registerCommand('false', () => ({ out: '', err: '', code: 1 }));
registerCommand('exit', (a, { sh }) => {
  const code = a[0] === undefined ? sh.lastCode : Number(a[0]);
  sh.exitCode = Number.isNaN(code) ? 2 : code & 255;
  return { out: '', err: '', code: sh.exitCode };
});
registerCommand('sleep', () => ok());
const UNIT_MS: Record<string, number> = { second: 1000, sec: 1000, minute: 60_000, min: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };
/** Interpreta la parte útil de `date -d`: now, @epoch, "N unidades ago", "+N unidades"/"-N unidades" e ISO 8601. */
function parseDateArg(spec: string, base: number): number | null {
  const t = spec.trim();
  if (!t || t === 'now') return base;
  if (t === 'yesterday') return base - 86_400_000;
  if (t === 'tomorrow') return base + 86_400_000;
  const ep = t.match(/^@(-?\d+)$/);
  if (ep) return Number(ep[1]) * 1000;
  const rel = t.match(/^([+-]?\d+)\s*(second|sec|minute|min|hour|day|week)s?(\s+ago)?$/i);
  if (rel) return base + Number(rel[1]) * UNIT_MS[rel[2].toLowerCase()] * (rel[3] ? -1 : 1);
  const v = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t.replace(' ', 'T') + 'Z');
  return Number.isNaN(v) ? null : v;
}
function strftime(fmt: string, ms: number): string {
  const d = new Date(ms);
  const z = (n: number, w = 2) => String(n).padStart(w, '0');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const f: Record<string, () => string> = {
    Y: () => String(d.getUTCFullYear()), y: () => z(d.getUTCFullYear() % 100), m: () => z(d.getUTCMonth() + 1), d: () => z(d.getUTCDate()), e: () => String(d.getUTCDate()).padStart(2, ' '),
    H: () => z(d.getUTCHours()), M: () => z(d.getUTCMinutes()), S: () => z(d.getUTCSeconds()), s: () => String(Math.floor(ms / 1000)), N: () => z(d.getUTCMilliseconds() * 1e6, 9),
    F: () => `${d.getUTCFullYear()}-${z(d.getUTCMonth() + 1)}-${z(d.getUTCDate())}`, T: () => `${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())}`,
    Z: () => 'UTC', z: () => '+0000', a: () => days[d.getUTCDay()], b: () => mons[d.getUTCMonth()], '%': () => '%',
  };
  return fmt.replace(/%(\d?)([A-Za-z%])/g, (m, w, c) => (f[c] ? (c === 'N' && w ? f[c]().slice(0, Number(w)) : f[c]()) : m));
}
registerCommand('date', (a) => {
  let ms = now();
  let fmt: string | undefined;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '-d' || a[i] === '--date') {
      const v = parseDateArg(a[++i] ?? '', ms);
      if (v === null) return fail(`date: invalid date '${a[i]}'`);
      ms = v;
    } else if (a[i].startsWith('--date=')) {
      const v = parseDateArg(a[i].slice(7), ms);
      if (v === null) return fail(`date: invalid date '${a[i].slice(7)}'`);
      ms = v;
    } else if (a[i].startsWith('+')) fmt = a[i].slice(1);
    else if (a[i] === '-u' || a[i] === '--utc') continue;
  }
  if (fmt !== undefined) return ok(strftime(fmt, ms) + '\n');
  if (a.includes('-u')) return ok(strftime('%a %b %e %H:%M:%S UTC %Y', ms) + '\n');
  return ok(new Date(ms).toString() + '\n');
});

registerCommand('cd', (a, { sh }) => {
  const target = a[0] ?? sh.vars.HOME ?? `/home/${sh.s.me.userName}`;
  const p = abs(sh, target === '~' ? `/home/${sh.s.me.userName}` : target.replace(/^~\//, `/home/${sh.s.me.userName}/`));
  if (!sh.fs.exists(p)) return fail(`bash: cd: ${target}: No such file or directory`);
  if (!sh.fs.isDir(p)) return fail(`bash: cd: ${target}: Not a directory`);
  sh.cwd = p;
  return ok();
});


registerCommand('mkdir', (args, { sh }) => {
  const { flags, rest } = splitFlags(args);
  for (const r of rest) {
    try {
      if (!flags.has('p') && sh.fs.exists(abs(sh, r))) return fail(`mkdir: cannot create directory '${r}': File exists`);
      sh.fs.mkdir(abs(sh, r), flags.has('p'));
    } catch (e) {
      return fail(`mkdir: cannot create directory '${r}': ${(e as Error).message}`);
    }
  }
  return ok();
});

registerCommand('touch', (args, { sh }) => {
  for (const r of args) {
    const p = abs(sh, r);
    if (!sh.fs.exists(p)) sh.fs.writeFile(p, '');
  }
  return ok();
});

registerCommand('rm', (args, { sh }) => {
  const { flags, rest } = splitFlags(args);
  for (const r of rest) {
    try {
      if (!sh.fs.exists(abs(sh, r))) {
        if (flags.has('f')) continue;
        return fail(`rm: cannot remove '${r}': No such file or directory`);
      }
      if (sh.fs.isDir(abs(sh, r)) && !(flags.has('r') || flags.has('R'))) return fail(`rm: cannot remove '${r}': Is a directory`);
      sh.fs.remove(abs(sh, r), true);
    } catch (e) {
      return fail(`rm: ${(e as Error).message}`);
    }
  }
  return ok();
});

registerCommand('cp', (args, { sh }) => {
  const { rest } = splitFlags(args);
  if (rest.length < 2) return fail('cp: missing destination file operand');
  const dst = abs(sh, rest[rest.length - 1]);
  for (const s of rest.slice(0, -1)) {
    const src = abs(sh, s);
    if (!sh.fs.exists(src)) return fail(`cp: cannot stat '${s}': No such file or directory`);
    sh.fs.copy(src, sh.fs.isDir(dst) ? VFS.norm(s.split('/').pop()!, dst) : dst);
  }
  return ok();
});
registerCommand('mv', (args, { sh }) => {
  const { rest } = splitFlags(args);
  if (rest.length < 2) return fail('mv: missing destination file operand');
  const dst = abs(sh, rest[rest.length - 1]);
  for (const s of rest.slice(0, -1)) {
    const src = abs(sh, s);
    if (!sh.fs.exists(src)) return fail(`mv: cannot stat '${s}': No such file or directory`);
    sh.fs.copy(src, sh.fs.isDir(dst) ? VFS.norm(s.split('/').pop()!, dst) : dst);
    sh.fs.remove(src, true);
  }
  return ok();
});

registerCommand('cat', (args, { sh, stdin }) => {
  const r = readInputs(sh, args.filter((a) => a !== '-'), stdin);
  return 'err' in r ? fail(`cat: ${r.err}`) : ok(r.text);
});

registerCommand('tee', (args, { sh, stdin }) => {
  const { flags, rest } = splitFlags(args);
  for (const f of rest) sh.fs.writeFile(abs(sh, f), stdin, flags.has('a'));
  return ok(stdin);
});

export const lines = (t: string) => (t === '' ? [] : t.replace(/\n$/, '').split('\n'));
export const join = (l: string[]) => (l.length ? l.join('\n') + '\n' : '');

registerCommand('seq', (a) => {
  const [s, e] = a.length === 1 ? [1, Number(a[0])] : [Number(a[0]), Number(a[1])];
  return ok(join(Array.from({ length: Math.max(0, e - s + 1) }, (_, i) => String(s + i))));
});
const utf8ToB64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const b64ToUtf8 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
registerCommand('base64', (a, { stdin }) => {
  try {
    if (a.includes('-d') || a.includes('--decode')) return ok(b64ToUtf8(stdin.trim()));
    return ok(utf8ToB64(stdin) + '\n');
  } catch {
    return fail('base64: invalid input');
  }
});

registerCommand('env', (_a, { sh }) => ok(Object.entries({ ...sh.s.cli.env, ...sh.vars }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'));
registerCommand('export', (args, { sh }) => {
  for (const a of args) {
    const eq = a.indexOf('=');
    if (eq > 0) {
      sh.vars[a.slice(0, eq)] = a.slice(eq + 1);
      sh.s.cli.env[a.slice(0, eq)] = a.slice(eq + 1);
    } else if (sh.vars[a] !== undefined) sh.s.cli.env[a] = sh.vars[a];
  }
  return ok();
});
registerCommand('unset', (args, { sh }) => {
  for (const a of args) {
    delete sh.vars[a];
    delete sh.s.cli.env[a];
  }
  return ok();
});
registerCommand('history', (_a, { sh }) => ok(sh.s.cli.history.map((h, i) => `${String(i + 1).padStart(5)}  ${h}`).join('\n') + '\n'));
registerCommand('which', (a) => ok(a.map((x) => `/usr/local/bin/${x}`).join('\n') + '\n'));

const globMatch = (v: string, pat: string) =>
  new RegExp('^' + pat.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(v);

function testExpr(sh: Shell, a: string[], dbl = false): boolean {
  // `-o` (o) y `-a` (y) entre subexpresiones, con menor precedencia que las comparaciones.
  const o = a.indexOf('-o');
  if (o > 0) return testExpr(sh, a.slice(0, o), dbl) || testExpr(sh, a.slice(o + 1), dbl);
  const y = a.indexOf('-a');
  if (y > 0 && a.length > 3) return testExpr(sh, a.slice(0, y), dbl) && testExpr(sh, a.slice(y + 1), dbl);
  if (a[0] === '!') return !testExpr(sh, a.slice(1), dbl);
  if (a.length === 0) return false;
  if (a.length === 1) return a[0] !== '';
  if (a.length === 2) {
    const [op, v] = a;
    if (op === '-z') return v === '';
    if (op === '-n') return v !== '';
    const st = sh.fs.stat(abs(sh, v));
    if (op === '-f') return st?.type === 'file';
    if (op === '-d') return st?.type === 'dir';
    if (op === '-e') return !!st;
    if (op === '-s') return st?.type === 'file' && st.size > 0;
    if (op === '-r') return !!st && !!(st.mode & 0o444);
    if (op === '-w') return !!st && !!(st.mode & 0o222);
    if (op === '-x') return !!st && !!(st.mode & 0o111);
  }
  if (a.length === 3) {
    const [l, op, r] = a;
    if (op === '=' || op === '==') return dbl ? globMatch(l, r) : l === r;
    if (op === '!=') return dbl ? !globMatch(l, r) : l !== r;
    if (op === '=~') return new RegExp(r).test(l);
    if (op === '<') return l < r;
    if (op === '>') return l > r;
    if (op === '-eq') return Number(l) === Number(r);
    if (op === '-ne') return Number(l) !== Number(r);
    if (op === '-gt') return Number(l) > Number(r);
    if (op === '-lt') return Number(l) < Number(r);
    if (op === '-ge') return Number(l) >= Number(r);
    if (op === '-le') return Number(l) <= Number(r);
  }
  return false;
}
registerCommand('test', (a, { sh }) => ({ out: '', err: '', code: testExpr(sh, a) ? 0 : 1 }));
registerCommand('[', (a, { sh }) => ({ out: '', err: '', code: testExpr(sh, a.filter((x) => x !== ']')) ? 0 : 1 }));
registerCommand('[[', (a, { sh }) => ({ out: '', err: '', code: testExpr(sh, a.filter((x) => x !== ']]'), true) ? 0 : 1 }));

// ---------------------------------------------------------------- jq

registerCommand('jq', (args, { sh, stdin }) => {
  const { flags, rest } = splitFlags(args);
  const [prog = '.', ...files] = rest;
  const r = readInputs(sh, files, stdin);
  if ('err' in r) return fail(`jq: error: Could not open ${r.err}`, 2);
  let input: any;
  try {
    input = JSON.parse(r.text);
  } catch {
    return fail('jq: error (at <stdin>:0): Cannot parse input as JSON', 2);
  }
  try {
    const res = runJq(prog, input);
    const fmt = (v: any) => (flags.has('r') && typeof v === 'string' ? v : flags.has('c') ? JSON.stringify(v) : JSON.stringify(v, null, 2));
    return ok(res.map(fmt).join('\n') + (res.length ? '\n' : ''));
  } catch (e) {
    if (e instanceof JqError) return fail(`jq: error: ${e.message}`, 3);
    return fail(`jq: error: ${(e as Error).message}`, 5);
  }
});

// ---------------------------------------------------------------- curl (solo S3 y direcciones públicas simuladas)

export function s3Target(url: string): { bucket: string; key: string; website: boolean } | null {
  const u = /^https?:\/\/([^/]+)(\/.*)?$/.exec(url);
  if (!u) return null;
  const host = u[1];
  const path = (u[2] ?? '/').slice(1).split('?')[0];
  let m = /^(.+)\.s3-website[.-]([a-z0-9-]+)\.amazonaws\.com$/.exec(host);
  if (m) return { bucket: m[1], key: decodeURIComponent(path), website: true };
  m = /^(.+)\.s3[.-]([a-z0-9-]+)\.amazonaws\.com$/.exec(host) ?? /^(.+)\.s3\.amazonaws\.com$/.exec(host);
  if (m) return { bucket: m[1], key: decodeURIComponent(path), website: false };
  m = /^s3[.-]([a-z0-9-]+)\.amazonaws\.com$/.exec(host);
  if (m) {
    const [b, ...k] = path.split('/');
    return { bucket: b, key: decodeURIComponent(k.join('/')), website: false };
  }
  return null;
}

registerCommand('curl', (args, { sh }): CmdResult => {
  const VAL_OPTS = ['-o', '-H', '-X', '-d', '--data', '--data-raw', '--request', '--header'];
  const optVals = (names: string[]) => args.flatMap((a, i) => (names.includes(a) && args[i + 1] !== undefined ? [args[i + 1]] : []));
  webRequest.body = optVals(['-d', '--data', '--data-raw']).join('&');
  webRequest.method = (optVals(['-X', '--request'])[0] ?? (webRequest.body ? 'POST' : 'GET')).toUpperCase();
  webRequest.headers = Object.fromEntries(optVals(['-H', '--header']).map((h) => [h.slice(0, h.indexOf(':')).trim(), h.slice(h.indexOf(':') + 1).trim()]));
  const { flags, rest } = splitFlags(args.filter((a, i) => !VAL_OPTS.includes(args[i - 1])));
  const bare = rest.find((a) => /^(localhost|[\w-]+(\.[\w-]+)+|\d+\.\d+\.\d+\.\d+)(:\d+)?(\/.*)?$/.test(a));
  const url = rest.find((a) => /^https?:\/\//.test(a)) ?? (bare ? 'http://' + bare : undefined);
  if (!url) return fail('curl: no URL specified', 2);
  const t = s3Target(url);
  let r: { status: number; contentType: string; body: string };
  if (!t) {
    const w = webGet(sh.s, url);
    if (!w || w.kind === 'nohost') return fail(`curl: (6) Could not resolve host: ${url.split('/')[2].split(':')[0]}`, 6);
    if (w.kind === 'refused') return fail(`curl: (7) Failed to connect to ${w.host} port ${w.port} after 1 ms: Connection refused`, 7);
    if (w.kind === 'timeout') return fail(`curl: (28) Failed to connect to ${w.host} port ${w.port} after 130102 ms: Connection timed out`, 28);
    if (w.kind === 'ssl') return fail(`curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to ${w.host}:${w.port} `, 35);
    if (w.kind !== 'ok') return fail('curl: (56) Failure', 56);
    r = { status: w.status, contentType: w.headers['content-type'], body: w.body };
  } else {
    const qs = url.includes('?') ? new URLSearchParams(url.slice(url.indexOf('?') + 1)) : null;
    r = qs?.has('X-Amz-Signature') ? presignedGet(sh.s, t.bucket, t.key, qs) : anonymousGet(sh.s, t.bucket, t.key, t.website);
  }
  const oIdx = args.indexOf('-o');
  if (flags.has('I') || flags.has('head')) return ok(`HTTP/1.1 ${r.status}\ncontent-type: ${r.contentType}\n\n`);
  if (r.status >= 400 && (flags.has('f') || flags.has('fail'))) return fail(`curl: (22) The requested URL returned error: ${r.status}`, 22);
  if (flags.has('w')) return ok(String(r.status));
  if (oIdx >= 0) {
    sh.fs.writeFile(abs(sh, args[oIdx + 1]), r.body);
    return ok();
  }
  return ok(r.body + (r.body.endsWith('\n') ? '' : '\n'));
});

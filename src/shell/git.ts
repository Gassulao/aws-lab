// `git` simulado sobre el sistema de ficheros virtual. El repositorio vive en `.git/` (HEAD, config, state.json, objects.json)
// y se sincroniza con CodeCommit por HTTPS (`https://git-codecommit.<región>.amazonaws.com/v1/repos/<nombre>`) o `codecommit::<región>://<nombre>`.
import { registerCommand, ok, fail, type Shell, type CmdResult } from './interp';
import { VFS } from './fs';
import { buildCtx } from './aws/framework';
import { AwsError } from '../engine/errors';
import type { Ctx } from '../engine/api';
import type { GitCommit, GitObjects } from '../engine/services/cicdTypes';
import { blobId, countChanges, copyHistory, diffTrees, emptyObjects, filesOf, history, isAncestor, makeCommit, mergeBase, mergeFiles, putBlob, short, treeOf, unifiedDiff, hasConflictMarkers } from '../engine/services/gitCore';
import { cicd } from '../engine/services/cicdTypes';
import { gitPull, gitPush, cloneUrl, type PushUpdate } from '../engine/services/codecommit';
import { now } from '../engine/util';
import '../engine/services/cicd';

// ------------------------------------------------------------------ configuración (formato ini)

type Ini = Record<string, Record<string, string>>;
function parseIni(text: string): Ini {
  const out: Ini = {};
  let cur = '';
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || l.startsWith(';')) continue;
    const m = /^\[(.+)\]$/.exec(l);
    if (m) { cur = m[1].replace(/\s+"(.*)"$/, '.$1'); out[cur] ??= {}; continue; }
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(l);
    if (kv && cur) out[cur][kv[1]] = kv[2];
  }
  return out;
}
function dumpIni(ini: Ini): string {
  let t = '';
  for (const [sec, kv] of Object.entries(ini)) {
    if (!Object.keys(kv).length) continue;
    const i = sec.indexOf('.');
    t += i > 0 ? `[${sec.slice(0, i)} "${sec.slice(i + 1)}"]\n` : `[${sec}]\n`;
    for (const [k, v] of Object.entries(kv)) t += `\t${k} = ${v}\n`;
  }
  return t;
}
const splitKey = (key: string): [string, string] => { const i = key.lastIndexOf('.'); return [key.slice(0, i), key.slice(i + 1)]; };

// ------------------------------------------------------------------ repositorio

interface GitState {
  branches: Record<string, string>;
  remotes: Record<string, Record<string, string>>;
  tags: Record<string, string>;
  index?: Record<string, string>;
  merge?: { theirs: string; msg: string; conflicts: string[]; label: string };
}

class GitErr extends Error { constructor(msg: string, public code = 128) { super(msg); } }

class Repo {
  objs: GitObjects;
  st: GitState;
  private dirty = false;
  constructor(public sh: Shell, public root: string) {
    this.objs = JSON.parse(sh.fs.isFile(this.p('objects.json')) ? sh.fs.readFile(this.p('objects.json')) : JSON.stringify(emptyObjects()));
    this.st = JSON.parse(sh.fs.isFile(this.p('state.json')) ? sh.fs.readFile(this.p('state.json')) : '{"branches":{},"remotes":{},"tags":{}}');
  }
  p = (f: string) => `${this.root}/.git/${f}`;
  static find(sh: Shell): Repo | null {
    let d = sh.cwd;
    for (;;) {
      if (sh.fs.isDir(d + '/.git') && sh.fs.isFile(d + '/.git/HEAD')) return new Repo(sh, d === '/' ? '' : d);
      if (d === '/' || d === '') return null;
      d = d.split('/').slice(0, -1).join('/') || '/';
    }
  }
  static create(sh: Shell, root: string, branch: string): Repo {
    sh.fs.mkdir(root + '/.git', true);
    sh.fs.writeFile(root + '/.git/HEAD', `ref: refs/heads/${branch}\n`);
    sh.fs.writeFile(root + '/.git/config', '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n');
    const r = new Repo(sh, root);
    r.touch();
    r.save();
    return r;
  }
  touch() { this.dirty = true; }
  save() {
    this.sh.fs.writeFile(this.p('objects.json'), JSON.stringify(this.objs));
    this.sh.fs.writeFile(this.p('state.json'), JSON.stringify(this.st));
    this.dirty = false;
  }
  // HEAD
  get headRef(): string | null { const h = this.sh.fs.readFile(this.p('HEAD')).trim(); return h.startsWith('ref: refs/heads/') ? h.slice(16) : null; }
  get headId(): string | undefined { const r = this.headRef; return r ? this.st.branches[r] : this.sh.fs.readFile(this.p('HEAD')).trim() || undefined; }
  setHead(branch: string) { this.sh.fs.writeFile(this.p('HEAD'), `ref: refs/heads/${branch}\n`); }
  setDetached(id: string) { this.sh.fs.writeFile(this.p('HEAD'), id + '\n'); }
  moveHead(id: string) { const r = this.headRef; if (r) this.st.branches[r] = id; else this.setDetached(id); this.touch(); }
  commit(id: string | undefined): GitCommit | undefined { return id ? this.objs.commits[id] : undefined; }
  get headTree(): Record<string, string> { return this.commit(this.headId)?.tree ?? {}; }
  get index(): Record<string, string> { return this.st.index ?? { ...this.headTree }; }
  setIndex(i: Record<string, string>) { this.st.index = i; this.touch(); }
  // configuración
  cfgFile(global: boolean) { return global ? `/home/${this.sh.s.me.userName}/.gitconfig` : this.p('config'); }
  readCfg(global: boolean): Ini { const f = this.cfgFile(global); return this.sh.fs.isFile(f) ? parseIni(this.sh.fs.readFile(f)) : {}; }
  cfg(key: string): string | undefined { const [s, k] = splitKey(key); return this.readCfg(false)[s]?.[k] ?? this.readCfg(true)[s]?.[k]; }
  setCfg(key: string, v: string | null, global = false) { const ini = this.readCfg(global); const [s, k] = splitKey(key); ini[s] ??= {}; if (v === null) delete ini[s][k]; else ini[s][k] = v; this.sh.fs.writeFile(this.cfgFile(global), dumpIni(ini)); }
  upstream(branch: string): { remote: string; branch: string } | null { const r = this.cfg(`branch.${branch}.remote`), m = this.cfg(`branch.${branch}.merge`); return r && m ? { remote: r, branch: m.replace('refs/heads/', '') } : null; }
  // árbol de trabajo
  ignore(): ((path: string) => boolean) {
    const f = `${this.root}/.gitignore`;
    const pats = (this.sh.fs.isFile(f) ? this.sh.fs.readFile(f) : '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    return (path) => pats.some((p) => {
      const dir = p.endsWith('/');
      const pat = p.replace(/^\//, '').replace(/\/$/, '');
      const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
      const parts = path.split('/');
      return parts.some((seg, i) => (re.test(seg) && (!dir || i < parts.length - 1)) || (pat.includes('/') && re.test(parts.slice(0, i + 1).join('/'))));
    });
  }
  work(): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (dir: string, rel: string) => {
      for (const n of this.sh.fs.list(dir)) {
        if (n === '.git' && !rel) continue;
        const abs = `${dir}/${n}`, r = rel ? `${rel}/${n}` : n;
        if (this.sh.fs.isDir(abs)) walk(abs, r);
        else out[r] = this.sh.fs.readFile(abs);
      }
    };
    walk(this.root || '/', '');
    return out;
  }
  abs(rel: string) { return `${this.root}/${rel}`; }
  rel(path: string): string { const a = VFS.norm(path, this.sh.cwd); const r = a.slice(this.root.length).replace(/^\//, ''); return r; }
  writeWork(rel: string, content: string) { const a = this.abs(rel); const d = a.split('/').slice(0, -1).join('/'); if (!this.sh.fs.exists(d)) this.sh.fs.mkdir(d, true); this.sh.fs.writeFile(a, content); }
  removeWork(rel: string) {
    const a = this.abs(rel);
    if (this.sh.fs.exists(a)) this.sh.fs.remove(a);
    let d = a.split('/').slice(0, -1).join('/');
    while (d.length > this.root.length && this.sh.fs.isDir(d) && this.sh.fs.list(d).length === 0) { this.sh.fs.remove(d, true); d = d.split('/').slice(0, -1).join('/'); }
  }
  content(blob: string) { return this.objs.blobs[blob] ?? ''; }
  /** Resuelve una revisión: HEAD, HEAD~n, rama, rama remota, etiqueta o prefijo de SHA. */
  rev(spec: string): string | undefined {
    const m = /^(.*?)((?:[~^]\d*)*)$/.exec(spec)!;
    let base = m[1] || 'HEAD';
    let id: string | undefined;
    if (base === 'HEAD') id = this.headId;
    else if (this.st.branches[base]) id = this.st.branches[base];
    else if (base.startsWith('refs/heads/') && this.st.branches[base.slice(11)]) id = this.st.branches[base.slice(11)];
    else if (this.st.tags[base]) id = this.st.tags[base];
    else {
      const [rem, ...br] = base.split('/');
      if (br.length && this.st.remotes[rem]?.[br.join('/')]) id = this.st.remotes[rem][br.join('/')];
      else if (this.objs.commits[base]) id = base;
      else if (/^[0-9a-f]{4,39}$/.test(base)) { const h = Object.keys(this.objs.commits).filter((k) => k.startsWith(base)); if (h.length === 1) id = h[0]; }
    }
    base = '';
    for (const step of m[2].match(/[~^]\d*/g) ?? []) {
      const n = step.length > 1 ? Number(step.slice(1)) : 1;
      for (let i = 0; i < (step[0] === '~' ? n : 1); i++) id = id ? this.commit(id)?.parents[step[0] === '^' && n > 1 ? n - 1 : 0] : undefined;
    }
    return id && this.objs.commits[id] ? id : undefined;
  }
  need(spec: string): string { const id = this.rev(spec); if (!id) throw new GitErr(`fatal: ambiguous argument '${spec}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`); return id; }
  ident(): { name: string; email: string; date: number } {
    const name = this.cfg('user.name'), email = this.cfg('user.email');
    if (!name || !email) throw new GitErr(`Author identity unknown\n\n*** Please tell me who you are.\n\nRun\n\n  git config --global user.email "you@example.com"\n  git config --global user.name "Your Name"\n\nto set your account's default identity.\nOmit --global to set the identity only in this repository.\n\nfatal: unable to auto-detect email address (got '${this.sh.s.me.userName}@aws-lab.(none)')`);
    return { name, email, date: now() };
  }
  /** Reemplaza el árbol de trabajo y el índice por el de un commit. */
  checkoutTree(tree: Record<string, string>, keepLocal = true) {
    const old = this.index;
    const work = this.work();
    for (const path of Object.keys(old)) if (!(path in tree)) this.removeWork(path);
    for (const [path, b] of Object.entries(tree)) {
      const modified = keepLocal && path in work && old[path] && blobId(work[path]) !== old[path] && old[path] === b;
      if (!modified) this.writeWork(path, this.content(b));
    }
    this.setIndex({ ...tree });
  }
}

const dateStr = (ms: number) => { const d = new Date(ms); return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCDate()} ${d.toISOString().slice(11, 19)} ${d.getUTCFullYear()} +0000`; };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function statLines(oldT: Record<string, string>, newT: Record<string, string>, r: Repo, modes = true): string {
  const ch = diffTrees(oldT, newT);
  if (!ch.length) return '';
  let add = 0, del = 0;
  const w = Math.max(...ch.map((c) => c.path.length));
  let out = '';
  for (const c of ch) {
    const n = countChanges(c.kind === 'A' ? null : r.content(oldT[c.path]), c.kind === 'D' ? null : r.content(newT[c.path]));
    add += n.add; del += n.del;
    out += ` ${c.path.padEnd(w)} | ${String(n.add + n.del).padStart(String(Math.max(...ch.map((x) => { const q = countChanges(x.kind === 'A' ? null : r.content(oldT[x.path]), x.kind === 'D' ? null : r.content(newT[x.path])); return q.add + q.del; }))).length)} ${'+'.repeat(Math.min(n.add, 30))}${'-'.repeat(Math.min(n.del, 30))}\n`;
  }
  out += ` ${plural(ch.length, 'file')} changed${add ? `, ${plural(add, 'insertion')}(+)` : ''}${del ? `, ${plural(del, 'deletion')}(-)` : ''}\n`;
  if (modes) for (const c of ch) if (c.kind !== 'M') out += ` ${c.kind === 'A' ? 'create' : 'delete'} mode 100644 ${c.path}\n`;
  return out;
}

// ------------------------------------------------------------------ remotos (CodeCommit)

interface Remote { region: string; name: string; https: boolean; url: string }
function parseRemote(sh: Shell, url: string, defRegion: string): Remote | null {
  let m = /^https:\/\/git-codecommit\.([a-z0-9-]+)\.amazonaws\.com\/v1\/repos\/([\w.-]+?)\/?$/.exec(url);
  if (m) return { region: m[1], name: m[2], https: true, url };
  m = /^codecommit::([a-z0-9-]+):\/\/(?:[^@/]+@)?([\w.-]+)$/.exec(url);
  if (m) return { region: m[1], name: m[2], https: false, url };
  m = /^codecommit:\/\/(?:[^@/]+@)?([\w.-]+)$/.exec(url);
  if (m) return { region: defRegion, name: m[1], https: false, url };
  void sh;
  return null;
}

function remoteAccess(r: Repo | null, sh: Shell, url: string): { remote: Remote; ctx: Ctx } {
  const cfg = (k: string) => (r ? r.cfg(k) : readGlobal(sh)[splitKey(k)[0]]?.[splitKey(k)[1]]);
  const remote = parseRemote(sh, url, sh.s.cli.profiles[sh.s.cli.activeProfile]?.region ?? sh.s.region);
  if (!remote) {
    const host = /^[a-z]+:\/\/([^/]+)/.exec(url)?.[1];
    throw new GitErr(host ? `fatal: unable to access '${url}/': Could not resolve host: ${host}` : `fatal: '${url}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`);
  }
  if (remote.https && !/codecommit\s+credential-helper/.test(cfg('credential.helper') ?? '')) throw new GitErr(`fatal: could not read Username for 'https://git-codecommit.${remote.region}.amazonaws.com': terminal prompts disabled`);
  try {
    const { ctx } = buildCtx(sh, { region: remote.region });
    return { remote, ctx };
  } catch {
    throw new GitErr(`fatal: unable to access '${url}/': The requested URL returned error: 403`);
  }
}
const readGlobal = (sh: Shell): Ini => { const f = `/home/${sh.s.me.userName}/.gitconfig`; return sh.fs.isFile(f) ? parseIni(sh.fs.readFile(f)) : {}; };

function guarded<T>(url: string, fn: () => T, notFound = true): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof AwsError) {
      if (e.code === 'RepositoryDoesNotExistException' && notFound) throw new GitErr(`fatal: repository '${url}' not found`);
      throw new GitErr(`fatal: unable to access '${url}/': The requested URL returned error: 403`);
    }
    throw e;
  }
}

// ------------------------------------------------------------------ estado

interface Changes { staged: { path: string; kind: 'A' | 'D' | 'M' }[]; unstaged: { path: string; kind: 'D' | 'M' }[]; untracked: string[]; unmerged: string[] }
function changes(r: Repo): Changes {
  const idx = r.index, work = r.work(), ign = r.ignore();
  const unmerged = r.st.merge?.conflicts.filter((c) => c in work || c in idx) ?? [];
  const staged = diffTrees(r.headTree, idx).filter((c) => !unmerged.includes(c.path));
  const unstaged: Changes['unstaged'] = [];
  for (const path of Object.keys(idx)) {
    if (unmerged.includes(path)) continue;
    if (!(path in work)) unstaged.push({ path, kind: 'D' });
    else if (blobId(work[path]) !== idx[path]) unstaged.push({ path, kind: 'M' });
  }
  const untracked = Object.keys(work).filter((p) => !(p in idx) && !ign(p) && !unmerged.includes(p));
  return { staged, unstaged: unstaged.sort((a, b) => a.path.localeCompare(b.path)), untracked: untracked.sort(), unmerged };
}
const dirsOnly = (paths: string[]): string[] => {
  const out = new Set<string>();
  for (const p of paths) out.add(p.includes('/') ? p.split('/')[0] + '/' : p);
  return [...out].sort();
};

function branchLine(r: Repo): { text: string; ahead: number; behind: number } {
  const b = r.headRef;
  if (!b) return { text: `HEAD detached at ${short(r.headId ?? '')}`, ahead: 0, behind: 0 };
  const up = r.upstream(b);
  const rid = up ? r.st.remotes[up.remote]?.[up.branch] : undefined;
  let ahead = 0, behind = 0, text = '';
  if (up && rid && r.headId) {
    const mine = new Set(history(r.objs, r.headId).map((c) => c.id)), theirs = new Set(history(r.objs, rid).map((c) => c.id));
    ahead = [...mine].filter((x) => !theirs.has(x)).length;
    behind = [...theirs].filter((x) => !mine.has(x)).length;
    text = ahead && behind ? `Your branch and '${up.remote}/${up.branch}' have diverged,\nand have ${ahead} and ${behind} different commits each, respectively.\n  (use "git pull" to merge the remote branch into yours)\n`
      : ahead ? `Your branch is ahead of '${up.remote}/${up.branch}' by ${plural(ahead, 'commit')}.\n  (use "git push" to publish your local commits)\n`
      : behind ? `Your branch is behind '${up.remote}/${up.branch}' by ${plural(behind, 'commit')}, and can be fast-forwarded.\n  (use "git pull" to update your local branch)\n`
      : `Your branch is up to date with '${up.remote}/${up.branch}'.\n`;
  } else if (up && !rid) text = `Your branch is based on '${up.remote}/${up.branch}', but the upstream is gone.\n`;
  return { text, ahead, behind };
}

function status(r: Repo, short_ = false, withBranch = false): string {
  const c = changes(r);
  const T = '\t';
  const kind = (k: string) => (k === 'A' ? 'new file:  ' : k === 'D' ? 'deleted:   ' : 'modified:  ');
  if (short_) {
    let out = withBranch ? `## ${r.headRef ?? 'HEAD (no branch)'}${r.upstream(r.headRef ?? '') ? `...${r.upstream(r.headRef!)!.remote}/${r.upstream(r.headRef!)!.branch}` : ''}\n` : '';
    const rows = new Map<string, string>();
    for (const s of c.staged) rows.set(s.path, s.kind + ' ');
    for (const u of c.unstaged) rows.set(u.path, (rows.get(u.path)?.[0] ?? ' ') + u.kind);
    for (const p of c.unmerged) rows.set(p, 'UU');
    for (const [p, v] of [...rows].sort()) out += `${v} ${p}\n`;
    for (const u of dirsOnly(c.untracked)) out += `?? ${u}\n`;
    return out;
  }
  let out = r.headRef ? `On branch ${r.headRef}\n` : `HEAD detached at ${short(r.headId ?? '')}\n`;
  if (!r.headId) out += '\nNo commits yet\n\n';
  else out += branchLine(r).text;
  if (r.st.merge) {
    out += c.unmerged.length ? `You have unmerged paths.\n  (fix conflicts and run "git commit")\n  (use "git merge --abort" to abort the merge)\n\n` : `All conflicts fixed but you are still merging.\n  (use "git commit" to conclude merge)\n\n`;
  } else if (r.headId) out += '\n';
  if (c.staged.length) { out += `Changes to be committed:\n  (use "git restore --staged <file>..." to unstage)\n`; for (const s of c.staged) out += `${T}${kind(s.kind)}${s.path}\n`; out += '\n'; }
  if (c.unmerged.length) { out += `Unmerged paths:\n  (use "git add <file>..." to mark resolution)\n`; for (const p of c.unmerged) out += `${T}both modified:   ${p}\n`; out += '\n'; }
  if (c.unstaged.length) { out += `Changes not staged for commit:\n  (use "git add${c.unstaged.some((u) => u.kind === 'D') ? '/rm' : ''} <file>..." to update what will be committed)\n  (use "git restore <file>..." to discard changes in working directory)\n`; for (const u of c.unstaged) out += `${T}${kind(u.kind)}${u.path}\n`; out += '\n'; }
  if (c.untracked.length) { out += `Untracked files:\n  (use "git add <file>..." to include in what will be committed)\n`; for (const u of dirsOnly(c.untracked)) out += `${T}${u}\n`; out += '\n'; }
  if (!c.staged.length && !c.unstaged.length && !c.unmerged.length) out += c.untracked.length ? `nothing added to commit but untracked files present (use "git add" to track)\n` : r.headId ? 'nothing to commit, working tree clean\n' : 'nothing to commit (create/copy files and use "git add" to track)\n';
  else if (!c.staged.length && !c.unmerged.length) out += `no changes added to commit (use "git add" and/or "git commit -a")\n`;
  return out;
}

// ------------------------------------------------------------------ comandos

type Args = { flags: Set<string>; vals: Record<string, string>; rest: string[]; multi: Record<string, string[]> };
/** Análisis sencillo: banderas cortas agrupadas, --larga[=valor] y opciones con valor indicadas en `withVal`. */
function parse(args: string[], withVal: string[] = [], bool: string[] = []): Args {
  const a: Args = { flags: new Set(), vals: {}, rest: [], multi: {} };
  let dd = false;
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (dd || !x.startsWith('-') || x === '-') { a.rest.push(x); continue; }
    if (x === '--') { dd = true; a.rest.push('--'); continue; }
    if (x.startsWith('--')) {
      const eq = x.indexOf('=');
      const n = eq > 0 ? x.slice(2, eq) : x.slice(2);
      if (eq > 0) { a.vals[n] = x.slice(eq + 1); (a.multi[n] ??= []).push(x.slice(eq + 1)); }
      else if (withVal.includes(n) && !bool.includes(n)) { a.vals[n] = args[++i] ?? ''; (a.multi[n] ??= []).push(a.vals[n]); }
      else a.flags.add(n);
      continue;
    }
    if (/^-\d+$/.test(x)) { a.vals.n = x.slice(1); continue; }
    for (let k = 1; k < x.length; k++) {
      const c = x[k];
      if (withVal.includes(c)) { const v = x.slice(k + 1) || args[++i] || ''; a.vals[c] = v; (a.multi[c] ??= []).push(v); break; }
      a.flags.add(c);
    }
  }
  return a;
}

const run = async (sh: Shell, args: string[]): Promise<CmdResult> => {
  let a = args;
  while (a[0] === '-C' || a[0] === '-c') {
    if (a[0] === '-C') { const d = VFS.norm(a[1] ?? '.', sh.cwd); if (!sh.fs.isDir(d)) return fail(`fatal: cannot change to '${a[1]}': No such file or directory`, 128); sh = Object.assign(Object.create(Object.getPrototypeOf(sh)), sh, { cwd: d }); }
    a = a.slice(2);
  }
  const [cmd, ...rest] = a;
  if (!cmd || cmd === 'help' || cmd === '--help') return ok('usage: git [-v | --version] [-h | --help] [-C <path>] <command> [<args>]\n\nstart a working area: clone init\nwork on the current change: add mv restore rm\nexamine the history and state: diff log show status\ngrow, mark and tweak your history: branch commit merge reset tag\ncollaborate: fetch pull push\n');
  if (cmd === '--version' || cmd === 'version') return ok('git version 2.43.0\n');
  const fn = COMMANDS[cmd];
  if (!fn) return fail(`git: '${cmd}' is not a git command. See 'git --help'.`, 1);
  try {
    if (cmd === 'init') return fn(null, sh, rest);
    if (cmd === 'clone') return fn(null, sh, rest);
    if (cmd === 'config') {
      const r = Repo.find(sh);
      return fn(r, sh, rest);
    }
    const r = Repo.find(sh);
    if (!r) return fail('fatal: not a git repository (or any of the parent directories): .git', 128);
    const res = fn(r, sh, rest);
    r.save();
    return res;
  } catch (e) {
    if (e instanceof GitErr) return { out: '', err: e.message + '\n', code: e.code };
    throw e;
  }
};

type Fn = (r: Repo | null, sh: Shell, args: string[]) => CmdResult;
const COMMANDS: Record<string, Fn> = {};

COMMANDS.init = (_r, sh, args) => {
  const a = parse(args, ['b', 'initial-branch']);
  const dir = a.rest[0] ? VFS.norm(a.rest[0], sh.cwd) : sh.cwd;
  const existed = sh.fs.isDir(dir + '/.git');
  if (!sh.fs.exists(dir)) sh.fs.mkdir(dir, true);
  const g = readGlobal(sh);
  const branch = a.vals.b ?? a.vals['initial-branch'] ?? g.init?.defaultBranch ?? 'master';
  if (existed) return ok(`Reinitialized existing Git repository in ${dir}/.git/\n`);
  Repo.create(sh, dir === '/' ? '' : dir, branch);
  return ok(`Initialized empty Git repository in ${dir}/.git/\n`);
};

COMMANDS.config = (r, sh, args) => {
  const a = parse(args);
  const global = a.flags.has('global');
  const f = (global || !r) ? `/home/${sh.s.me.userName}/.gitconfig` : r.p('config');
  const read = (): Ini => (sh.fs.isFile(f) ? parseIni(sh.fs.readFile(f)) : {});
  if (!global && !r && !a.flags.has('list') && !a.flags.has('l') && !a.flags.has('get')) { if (a.rest.length >= 1 && a.rest.length <= 2 && !a.flags.has('get')) throw new GitErr('fatal: not in a git directory'); }
  if (a.flags.has('list') || a.flags.has('l')) {
    const ini = { ...readGlobal(sh), ...(r ? r.readCfg(false) : {}) };
    return ok(Object.entries(ini).flatMap(([s, kv]) => Object.entries(kv).map(([k, v]) => `${s}.${k}=${v}`)).join('\n') + '\n');
  }
  const [key, val] = a.rest;
  if (!key) return fail('usage: git config [<options>]', 129);
  if (!/^[A-Za-z][\w-]*(\.[^.]+)*\.[A-Za-z][\w-]*$/.test(key)) return fail(`error: key does not contain a section: ${key}`, 1);
  if (a.flags.has('unset')) { const ini = read(); const [s, k] = splitKey(key); if (ini[s]) delete ini[s][k]; sh.fs.writeFile(f, dumpIni(ini)); return ok(); }
  if (val === undefined || a.flags.has('get')) {
    const [s, k] = splitKey(key);
    const v = (r && !global ? r.cfg(key) : read()[s]?.[k]);
    return v === undefined ? { out: '', err: '', code: 1 } : ok(v + '\n');
  }
  const ini = read();
  const [s, k] = splitKey(key);
  ini[s] ??= {};
  ini[s][k] = val;
  sh.fs.writeFile(f, dumpIni(ini));
  return ok();
};

COMMANDS.add = (r, sh, args) => {
  const R = r!;
  const a = parse(args);
  const all = a.flags.has('A') || a.flags.has('all') || a.flags.has('u') || a.flags.has('update');
  const specs = a.rest.filter((x) => x !== '--');
  if (!specs.length && !all) return fail('Nothing specified, nothing added.\nhint: Maybe you wanted to say \'git add .\'?', 0);
  const work = R.work(), ign = R.ignore();
  const idx = { ...R.index };
  const rels = (all && !specs.length ? ['.'] : specs).map((s) => R.rel(s));
  for (const rel of rels) {
    const prefix = rel === '' || rel === '.' ? '' : rel.replace(/\/$/, '');
    const inScope = (p: string) => !prefix || p === prefix || p.startsWith(prefix + '/');
    const hit = Object.keys(work).filter(inScope), tracked = Object.keys(idx).filter(inScope);
    if (!hit.length && !tracked.length) throw new GitErr(`fatal: pathspec '${specs[rels.indexOf(rel)] ?? rel}' did not match any files`);
    for (const p of hit) { if (ign(p) && !(p in idx) && !(prefix === p)) continue; if (a.flags.has('u') && !(p in idx)) continue; idx[p] = putBlob(R.objs, work[p]); }
    for (const p of tracked) if (!(p in work)) delete idx[p];
  }
  if (R.st.merge) R.st.merge.conflicts = R.st.merge.conflicts.filter((c) => !rels.some((rel) => !rel || rel === '.' || c === rel || c.startsWith(rel.replace(/\/$/, '') + '/')) );
  R.setIndex(idx);
  return ok();
};

COMMANDS.rm = (r, sh, args) => {
  const R = r!;
  const a = parse(args);
  const specs = a.rest.filter((x) => x !== '--');
  const idx = { ...R.index };
  let out = '';
  for (const s of specs) {
    const rel = R.rel(s).replace(/\/$/, '');
    const hit = Object.keys(idx).filter((p) => p === rel || p.startsWith(rel + '/'));
    if (!hit.length) throw new GitErr(`fatal: pathspec '${s}' did not match any files`);
    if (hit.length > 1 || hit[0] !== rel) if (!a.flags.has('r')) throw new GitErr(`fatal: not removing '${s}' recursively without -r`);
    for (const p of hit) { delete idx[p]; if (!a.flags.has('cached')) R.removeWork(p); out += `rm '${p}'\n`; }
  }
  R.setIndex(idx);
  return ok(out);
};

COMMANDS.mv = (r, _sh, args) => {
  const R = r!;
  const [src, dst] = args.filter((x) => !x.startsWith('-'));
  const s = R.rel(src), d = R.rel(dst);
  const idx = { ...R.index };
  if (!(s in idx)) throw new GitErr(`fatal: not under version control, source=${s}, destination=${d}`);
  R.writeWork(d, R.work()[s] ?? R.content(idx[s]));
  R.removeWork(s);
  idx[d] = idx[s];
  delete idx[s];
  R.setIndex(idx);
  return ok();
};

COMMANDS.restore = (r, _sh, args) => {
  const R = r!;
  const a = parse(args, ['source', 's']);
  const paths = a.rest.filter((x) => x !== '--').map((x) => R.rel(x));
  if (!paths.length) return fail('fatal: you must specify path(s) to restore', 128);
  const src = a.vals.source ?? a.vals.s;
  const idx = { ...R.index };
  const base = src ? R.commit(R.need(src))!.tree : R.headTree;
  for (const p0 of paths) {
    const p = p0 === '' ? '.' : p0;
    const match = (x: string) => p === '.' || x === p || x.startsWith(p + '/');
    const names = new Set([...Object.keys(idx), ...Object.keys(base), ...Object.keys(R.work())].filter(match));
    if (!names.size) throw new GitErr(`error: pathspec '${p0}' did not match any file(s) known to git`, 1);
    for (const n of names) {
      if (a.flags.has('staged') || a.flags.has('S')) { if (n in base) idx[n] = base[n]; else delete idx[n]; if (a.flags.has('worktree') || a.flags.has('W')) { if (n in base) R.writeWork(n, R.content(base[n])); else R.removeWork(n); } }
      else if (src ? n in base : n in idx) R.writeWork(n, R.content(src ? base[n] : idx[n]));
      else if (!(n in idx) && !src) throw new GitErr(`error: pathspec '${p0}' did not match any file(s) known to git`, 1);
    }
  }
  R.setIndex(idx);
  return ok();
};

COMMANDS.status = (r, _sh, args) => {
  const a = parse(args);
  return ok(status(r!, a.flags.has('s') || a.flags.has('short') || a.flags.has('b') || a.flags.has('branch') && a.flags.has('s'), a.flags.has('b') || a.flags.has('branch')));
};

COMMANDS.commit = (r, _sh, args) => {
  const R = r!;
  const a = parse(args, ['m', 'message', 'F', 'author']);
  if (a.flags.has('a') || a.flags.has('all')) {
    const idx = { ...R.index }, work = R.work();
    for (const p of Object.keys(idx)) { if (p in work) idx[p] = putBlob(R.objs, work[p]); else delete idx[p]; }
    R.setIndex(idx);
  }
  const ch = changes(R);
  if (R.st.merge && ch.unmerged.length) throw new GitErr('error: Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use \'git add/rm <file>\'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.');
  const amend = a.flags.has('amend');
  const msgs = [...(a.multi.m ?? []), ...(a.multi.message ?? [])];
  if (!ch.staged.length && !R.st.merge && !a.flags.has('allow-empty') && !amend) {
    return { out: status(R), err: '', code: 1 };
  }
  let message = msgs.join('\n\n');
  if (!message && R.st.merge) message = R.st.merge.msg;
  if (!message && amend) message = R.commit(R.headId)?.message ?? '';
  if (!message) throw new GitErr('Aborting commit due to empty commit message.', 1);
  const id = R.ident();
  const head = R.headId;
  const parents = amend ? R.commit(head)?.parents ?? [] : head ? [head] : [];
  if (R.st.merge) parents.push(R.st.merge.theirs);
  const before = amend ? R.commit(R.commit(head)?.parents[0])?.tree ?? {} : R.headTree;
  const c = makeCommit(R.objs, { tree: { ...R.index }, parents, message, author: id });
  R.moveHead(c.id);
  R.st.merge = undefined;
  const root = !parents.length ? ' (root-commit)' : '';
  const label = R.headRef ?? 'detached HEAD';
  return ok(`[${label}${root} ${short(c.id)}] ${message.split('\n')[0]}\n${statLines(before, c.tree, R) || ''}`.replace(/^(\[.*\n)$/, '$1'));
};

function fmtCommit(r: Repo, c: GitCommit, fmt: 'full' | 'oneline' | string, decorate: Map<string, string[]>): string {
  const dec = decorate.get(c.id);
  const d = dec ? ` (${dec.join(', ')})` : '';
  if (fmt === 'oneline') return `${short(c.id)}${d} ${c.message.split('\n')[0]}\n`;
  if (fmt !== 'full') return fmt.replace(/%H/g, c.id).replace(/%h/g, short(c.id)).replace(/%s/g, c.message.split('\n')[0]).replace(/%an/g, c.author.name).replace(/%ae/g, c.author.email).replace(/%ad/g, dateStr(c.author.date)).replace(/%d/g, d).replace(/%b/g, c.message.split('\n').slice(1).join('\n').trim()).replace(/%n/g, '\n') + '\n';
  const merge = c.parents.length > 1 ? `Merge: ${c.parents.map(short).join(' ')}\n` : '';
  return `commit ${c.id}${d}\n${merge}Author: ${c.author.name} <${c.author.email}>\nDate:   ${dateStr(c.author.date)}\n\n${c.message.split('\n').map((l) => '    ' + l).join('\n')}\n`;
}

function decorations(r: Repo): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const add = (id: string, t: string) => m.set(id, [...(m.get(id) ?? []), t]);
  const hb = r.headRef;
  if (r.headId) add(r.headId, hb ? `HEAD -> ${hb}` : 'HEAD');
  for (const [b, id] of Object.entries(r.st.branches)) if (b !== hb) add(id, b);
  for (const [rem, brs] of Object.entries(r.st.remotes)) for (const [b, id] of Object.entries(brs)) add(id, `${rem}/${b}`);
  for (const [t, id] of Object.entries(r.st.tags)) add(id, `tag: ${t}`);
  return m;
}

COMMANDS.log = (r, _sh, args) => {
  const R = r!;
  const a = parse(args, ['n', 'max-count', 'pretty', 'format']);
  const limit = Number(a.vals.n ?? a.vals['max-count'] ?? 1000);
  const fmt = a.flags.has('oneline') ? 'oneline' : (a.vals.pretty ?? a.vals.format ?? 'full').replace(/^format:/, '').replace(/^oneline$/, 'oneline');
  const spec = a.rest.filter((x) => x !== '--')[0];
  let list: GitCommit[];
  if (a.flags.has('all')) { const seen = new Map<string, GitCommit>(); for (const id of [...Object.values(R.st.branches), ...Object.values(R.st.remotes).flatMap((b) => Object.values(b))]) for (const c of history(R.objs, id)) seen.set(c.id, c); list = [...seen.values()].sort((x, y) => y.committer.date - x.committer.date); }
  else {
    if (!R.headId && !spec) throw new GitErr(`fatal: your current branch '${R.headRef ?? 'HEAD'}' does not have any commits yet`);
    if (spec?.includes('..')) { const [from, to] = spec.split('..'); const exclude = new Set(history(R.objs, R.need(from)).map((c) => c.id)); list = history(R.objs, R.need(to || 'HEAD')).filter((c) => !exclude.has(c.id)); }
    else list = history(R.objs, spec ? R.need(spec) : R.headId);
  }
  const dec = fmt === 'full' || fmt === 'oneline' || fmt.includes('%d') ? decorations(R) : new Map();
  const graph = a.flags.has('graph');
  const out = list.slice(0, limit).map((c) => { const t = fmtCommit(R, c, fmt, dec); return graph ? (fmt === 'oneline' ? '* ' + t : t.split('\n').map((l, i) => (i === 0 ? '* ' + l : l ? '| ' + l : '|')).join('\n')) : t; });
  return ok(out.join(fmt === 'full' && !graph ? '\n' : ''));
};

COMMANDS.show = (r, _sh, args) => {
  const R = r!;
  const spec = args.filter((x) => !x.startsWith('-'))[0] ?? 'HEAD';
  const id = R.need(spec);
  const c = R.commit(id)!;
  let out = fmtCommit(R, c, 'full', decorations(R)) + '\n';
  const prev = R.commit(c.parents[0])?.tree ?? {};
  for (const d of diffTrees(prev, c.tree)) out += unifiedDiff(d.path, d.kind === 'A' ? null : R.content(prev[d.path]), d.kind === 'D' ? null : R.content(c.tree[d.path]));
  return ok(out);
};

COMMANDS.diff = (r, _sh, args) => {
  const R = r!;
  const a = parse(args);
  const names = a.flags.has('name-only') || a.flags.has('name-status') || a.flags.has('stat');
  const dd = a.rest.indexOf('--');
  const revs = (dd >= 0 ? a.rest.slice(0, dd) : a.rest).filter((x) => R.rev(x.split('..')[0] || 'HEAD') !== undefined && !R.sh.fs.exists(R.abs(R.rel(x))));
  const paths = (dd >= 0 ? a.rest.slice(dd + 1) : a.rest.filter((x) => !revs.includes(x))).map((x) => R.rel(x));
  const inScope = (p: string) => !paths.length || paths.some((q) => q === '' || p === q || p.startsWith(q + '/'));
  let left: Record<string, string>, right: Record<string, string>;
  const work = () => Object.fromEntries(Object.entries(R.work()).filter(([p]) => p in R.index || false).map(([p, c]) => [p, putBlob(R.objs, c)]));
  const rv = revs.flatMap((x) => (x.includes('..') ? x.split('..') : [x]));
  if (rv.length >= 2) { left = R.commit(R.need(rv[0]))!.tree; right = R.commit(R.need(rv[1] || 'HEAD'))!.tree; }
  else if (rv.length === 1) { left = R.commit(R.need(rv[0]))!.tree; right = work(); }
  else if (a.flags.has('staged') || a.flags.has('cached')) { left = R.headTree; right = R.index; }
  else { left = R.index; right = work(); }
  let out = '';
  for (const d of diffTrees(left, right)) {
    if (!inScope(d.path)) continue;
    if (a.flags.has('name-only')) out += d.path + '\n';
    else if (a.flags.has('name-status')) out += `${d.kind}\t${d.path}\n`;
    else if (!a.flags.has('stat')) out += unifiedDiff(d.path, d.kind === 'A' ? null : R.content(left[d.path]), d.kind === 'D' ? null : R.content(right[d.path]));
  }
  if (a.flags.has('stat')) out = statLines(left, right, R, false);
  void names;
  return ok(out);
};

COMMANDS.branch = (r, _sh, args) => {
  const R = r!;
  const a = parse(args, ['m', 'M', 'd', 'D', 'u', 'set-upstream-to', 'delete']);
  const hb = R.headRef;
  const subject = (id: string) => R.commit(id)?.message.split('\n')[0] ?? '';
  if (a.flags.has('show-current')) return ok(hb ? hb + '\n' : '');
  const delName = a.vals.d ?? a.vals.D ?? a.vals.delete;
  if (a.flags.has('d') || a.flags.has('D') || delName !== undefined || a.flags.has('delete')) {
    const names = [delName, ...a.rest].filter((x): x is string => !!x);
    let out = '';
    for (const n of names) {
      const id = R.st.branches[n];
      if (!id) throw new GitErr(`error: branch '${n}' not found.`, 1);
      if (n === hb) throw new GitErr(`error: Cannot delete branch '${n}' checked out at '${R.root}'`, 1);
      const force = a.flags.has('D') || a.vals.D !== undefined || a.flags.has('f');
      if (!force && R.headId && !isAncestor(R.objs, id, R.headId)) throw new GitErr(`error: The branch '${n}' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D ${n}'.`, 1);
      delete R.st.branches[n];
      out += `Deleted branch ${n} (was ${short(id)}).\n`;
    }
    R.touch();
    return ok(out);
  }
  const mv = a.vals.m ?? a.vals.M;
  if (mv !== undefined) {
    const [from, to] = a.rest.length ? [mv, a.rest[0]] : [hb!, mv];
    if (!R.st.branches[from] && !(from === hb && !R.headId)) throw new GitErr(`error: refname refs/heads/${from} not found\nfatal: Branch rename failed`);
    if (R.st.branches[to] && !a.flags.has('M') && a.vals.M === undefined) throw new GitErr(`fatal: a branch named '${to}' already exists`);
    if (R.st.branches[from]) { R.st.branches[to] = R.st.branches[from]; delete R.st.branches[from]; }
    if (hb === from) R.setHead(to);
    R.touch();
    return ok();
  }
  const upTo = a.vals.u ?? a.vals['set-upstream-to'];
  if (upTo) {
    const [rem, ...b] = upTo.split('/');
    const target = a.rest[0] ?? hb!;
    if (!R.st.remotes[rem]?.[b.join('/')]) throw new GitErr(`fatal: the requested upstream branch '${upTo}' does not exist`);
    R.setCfg(`branch.${target}.remote`, rem); R.setCfg(`branch.${target}.merge`, `refs/heads/${b.join('/')}`);
    return ok(`branch '${target}' set up to track '${upTo}'.\n`);
  }
  if (a.rest.length) {
    const [name, start] = a.rest;
    if (R.st.branches[name]) throw new GitErr(`fatal: a branch named '${name}' already exists`);
    if (!/^[^\s~^:?*\[\\]+$/.test(name) || name.includes('..') || name.startsWith('-')) throw new GitErr(`fatal: '${name}' is not a valid branch name`);
    const id = start ? R.need(start) : R.headId;
    if (!id) throw new GitErr(`fatal: not a valid object name: '${hb ?? 'HEAD'}'`);
    R.st.branches[name] = id; R.touch();
    return ok();
  }
  const verbose = a.flags.has('v') || a.flags.has('vv') || a.flags.has('verbose');
  const lines: string[] = [];
  const remotes = a.flags.has('r') || a.flags.has('remotes') || a.flags.has('a') || a.flags.has('all');
  if (!a.flags.has('r') && !a.flags.has('remotes')) for (const n of Object.keys(R.st.branches).sort()) {
    const id = R.st.branches[n];
    const up = R.upstream(n);
    lines.push(`${n === hb ? '* ' : '  '}${verbose ? n.padEnd(Math.max(...Object.keys(R.st.branches).map((x) => x.length))) + ` ${short(id)} ${a.flags.has('vv') && up ? `[${up.remote}/${up.branch}] ` : ''}${subject(id)}` : n}`);
  }
  if (!R.headId && hb && !R.st.branches[hb]) { /* rama sin commits: no aparece */ }
  if (remotes) for (const [rem, brs] of Object.entries(R.st.remotes)) for (const [b, id] of Object.entries(brs).sort()) lines.push(`  ${a.flags.has('r') || a.flags.has('remotes') ? '' : 'remotes/'}${rem}/${b}${verbose ? ` ${short(id)} ${subject(id)}` : ''}`);
  return ok(lines.length ? lines.join('\n') + '\n' : '');
};

function dirtyConflicts(R: Repo, newTree: Record<string, string>): string[] {
  const ch = changes(R), old = R.headTree;
  const touched = new Set([...ch.staged.map((c) => c.path), ...ch.unstaged.map((c) => c.path)]);
  return [...touched].filter((p) => (old[p] ?? undefined) !== newTree[p] && (R.index[p] !== newTree[p] || R.work()[p] !== undefined && blobId(R.work()[p]) !== newTree[p])).sort();
}

function switchTo(R: Repo, name: string, create: { start?: string; force?: boolean } | null, detachOK = true): CmdResult {
  let target: string | undefined, detached = false, track: { rem: string; br: string } | null = null;
  if (create) {
    if (R.st.branches[name] && !create.force) throw new GitErr(`fatal: a branch named '${name}' already exists`);
    target = create.start ? R.need(create.start) : R.headId;
    const sm = create.start && /^([^/]+)\/(.+)$/.exec(create.start);
    if (sm && R.st.remotes[sm[1]]?.[sm[2]]) track = { rem: sm[1], br: sm[2] };
  } else if (R.st.branches[name]) target = R.st.branches[name];
  else {
    const rem = Object.keys(R.st.remotes).find((x) => R.st.remotes[x][name]);
    if (rem) { target = R.st.remotes[rem][name]; create = {}; track = { rem, br: name }; }
    else { const id = R.rev(name); if (!id || !detachOK) throw new GitErr(`error: pathspec '${name}' did not match any file(s) known to git`, 1); target = id; detached = true; }
  }
  const newTree = target ? R.commit(target)?.tree ?? {} : {};
  const clash = dirtyConflicts(R, newTree);
  if (clash.length) throw new GitErr(`error: Your local changes to the following files would be overwritten by checkout:\n${clash.map((c) => '\t' + c).join('\n')}\nPlease commit your changes or stash them before you switch branches.\nAborting`, 1);
  const work = R.work();
  const untr = Object.keys(newTree).filter((p) => p in work && !(p in R.index) && blobId(work[p]) !== newTree[p]);
  if (untr.length) throw new GitErr(`error: The following untracked working tree files would be overwritten by checkout:\n${untr.map((c) => '\t' + c).join('\n')}\nPlease move or remove them before you switch branches.\nAborting`, 1);
  const fromHead = R.headTree;
  if (create) { if (target) R.st.branches[name] = target; R.setHead(name); if (!target) { /* rama huérfana */ } }
  else if (detached) R.setDetached(target!);
  else R.setHead(name);
  if (track) { R.setCfg(`branch.${name}.remote`, track.rem); R.setCfg(`branch.${name}.merge`, `refs/heads/${track.br}`); }
  // aplicar el árbol: ficheros de HEAD anterior que no existen en el nuevo se eliminan
  const old = R.index;
  for (const p of Object.keys(fromHead)) if (!(p in newTree) && p in old && !(p in work && blobId(work[p]) !== old[p])) R.removeWork(p);
  for (const [p, b] of Object.entries(newTree)) if (!(p in work) || blobId(work[p]) === old[p] || old[p] === undefined) R.writeWork(p, R.content(b));
  const keepStaged = Object.fromEntries(Object.entries(old).filter(([p, b]) => b !== fromHead[p] && !(p in newTree) === false ? false : b !== fromHead[p]));
  R.setIndex({ ...newTree, ...Object.fromEntries(Object.entries(keepStaged).filter(([p]) => !(p in newTree))) });
  R.st.merge = undefined;
  if (detached) return ok(`HEAD is now at ${short(target!)} ${R.commit(target)?.message.split('\n')[0] ?? ''}\n`);
  return ok(`${track ? `branch '${name}' set up to track '${track.rem}/${track.br}'.\n` : ''}Switched to ${create ? 'a new ' : ''}branch '${name}'\n`);
}

const checkout = (r: Repo | null, _sh: Shell, args: string[], sw = false): CmdResult => {
  const R = r!;
  const a = parse(args, ['b', 'B', 'c', 'C']);
  const nb = a.vals.b ?? a.vals.B ?? a.vals.c ?? a.vals.C;
  const force = a.vals.B !== undefined || a.vals.C !== undefined;
  if (nb !== undefined) return switchTo(R, nb, { start: a.rest[0], force });
  const dd = a.rest.indexOf('--');
  if (dd >= 0 || (a.rest.length > 1 && !sw)) {
    // restaurar ficheros desde el índice (o desde una revisión)
    const paths = (dd >= 0 ? a.rest.slice(dd + 1) : a.rest.slice(1));
    const src = dd > 0 ? a.rest[0] : a.rest.length > 1 && dd < 0 ? a.rest[0] : undefined;
    const tree = src ? R.commit(R.need(src))!.tree : R.index;
    for (const p of paths) {
      const rel = R.rel(p);
      const hit = Object.keys(tree).filter((x) => x === rel || x.startsWith(rel.replace(/\/$/, '') + '/'));
      if (!hit.length) throw new GitErr(`error: pathspec '${p}' did not match any file(s) known to git`, 1);
      for (const h of hit) R.writeWork(h, R.content(tree[h]));
      if (src) { const idx = { ...R.index }; for (const h of hit) idx[h] = tree[h]; R.setIndex(idx); }
    }
    return ok(`Updated ${plural(paths.length, 'path')} from the index\n`);
  }
  if (!a.rest.length) return ok(status(R));
  const name = a.rest[0];
  if (!R.st.branches[name] && R.sh.fs.exists(R.abs(R.rel(name))) && R.index[R.rel(name)] !== undefined) { R.writeWork(R.rel(name), R.content(R.index[R.rel(name)])); return ok(`Updated 1 path from the index\n`); }
  if (name === R.headRef) return ok(`Already on '${name}'\n`);
  return switchTo(R, name, null);
};
COMMANDS.checkout = (r, sh, args) => checkout(r, sh, args);
COMMANDS.switch = (r, sh, args) => checkout(r, sh, args, true);

COMMANDS.reset = (r, _sh, args) => {
  const R = r!;
  const a = parse(args);
  const items = a.rest.filter((x) => x !== '--');
  const hard = a.flags.has('hard'), soft = a.flags.has('soft');
  let id: string | undefined = R.headId;
  const paths: string[] = [];
  for (const it of items) { const v = R.rev(it); if (v && !paths.length && !R.sh.fs.exists(R.abs(R.rel(it)))) id = v; else paths.push(R.rel(it)); }
  if (paths.length) {
    const idx = { ...R.index }, base = R.commit(id)?.tree ?? {};
    for (const p of paths) for (const n of new Set([...Object.keys(idx), ...Object.keys(base)])) if (n === p || n.startsWith(p + '/')) { if (n in base) idx[n] = base[n]; else delete idx[n]; }
    R.setIndex(idx);
    return ok();
  }
  if (!id) throw new GitErr("fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.");
  R.moveHead(id);
  R.st.merge = undefined;
  if (hard) { const tree = R.commit(id)!.tree; const old = { ...R.index, ...R.work() }; for (const p of Object.keys(old)) if (!(p in tree)) R.removeWork(p); for (const [p, b] of Object.entries(tree)) R.writeWork(p, R.content(b)); R.setIndex({ ...tree }); return ok(`HEAD is now at ${short(id)} ${R.commit(id)!.message.split('\n')[0]}\n`); }
  if (!soft) R.setIndex({ ...R.commit(id)!.tree });
  return ok();
};

COMMANDS.tag = (r, _sh, args) => {
  const R = r!;
  const a = parse(args, ['m', 'd']);
  if (a.vals.d || a.flags.has('d')) { const n = a.vals.d || a.rest[0]; if (!R.st.tags[n]) throw new GitErr(`error: tag '${n}' not found.`, 1); const id = R.st.tags[n]; delete R.st.tags[n]; R.touch(); return ok(`Deleted tag '${n}' (was ${short(id)})\n`); }
  if (!a.rest.length) return ok(Object.keys(R.st.tags).sort().join('\n') + (Object.keys(R.st.tags).length ? '\n' : ''));
  const [n, rev] = a.rest;
  if (R.st.tags[n]) throw new GitErr(`fatal: tag '${n}' already exists`);
  R.st.tags[n] = R.need(rev ?? 'HEAD'); R.touch();
  return ok();
};

COMMANDS['rev-parse'] = (r, _sh, args) => {
  const R = r!;
  const out: string[] = [];
  const f = args.filter((x) => !x.startsWith('--') || x === '--abbrev-ref' || x === '--short');
  for (const x of args) {
    if (x === '--show-toplevel') out.push(R.root || '/');
    else if (x === '--is-inside-work-tree') out.push('true');
    else if (x === '--abbrev-ref' || x === '--short') continue;
    else if (x === 'HEAD' && args.includes('--abbrev-ref')) out.push(R.headRef ?? 'HEAD');
    else if (x.startsWith('--')) continue;
    else { const id = R.rev(x); if (!id) throw new GitErr(`fatal: ambiguous argument '${x}': unknown revision or path not in the working tree.`); out.push(args.includes('--short') ? short(id) : id); }
  }
  void f;
  return ok(out.join('\n') + '\n');
};

COMMANDS.remote = (r, _sh, args) => {
  const R = r!;
  const a = parse(args);
  const [sub, ...rest] = a.rest;
  const ini = () => R.readCfg(false);
  const write = (i: Ini) => R.sh.fs.writeFile(R.p('config'), dumpIni(i));
  const names = () => Object.keys(ini()).filter((s) => s.startsWith('remote.')).map((s) => s.slice(7));
  if (!sub) {
    if (a.flags.has('v') || a.flags.has('verbose')) return ok(names().map((n) => `${n}\t${ini()['remote.' + n].url} (fetch)\n${n}\t${ini()['remote.' + n].url} (push)`).join('\n') + (names().length ? '\n' : ''));
    return ok(names().join('\n') + (names().length ? '\n' : ''));
  }
  if (sub === 'add') {
    const [n, url] = rest;
    if (!n || !url) return fail('usage: git remote add <name> <url>', 129);
    if (names().includes(n)) return fail(`error: remote ${n} already exists.`, 3);
    const i = ini(); i['remote.' + n] = { url, fetch: `+refs/heads/*:refs/remotes/${n}/*` }; write(i);
    return ok();
  }
  if (sub === 'remove' || sub === 'rm') {
    const n = rest[0];
    if (!names().includes(n)) return fail(`error: No such remote: '${n}'`, 2);
    const i = ini(); delete i['remote.' + n]; write(i); delete R.st.remotes[n]; R.touch();
    return ok();
  }
  if (sub === 'get-url') { const n = rest[0]; if (!names().includes(n)) return fail(`error: No such remote '${n}'`, 2); return ok(ini()['remote.' + n].url + '\n'); }
  if (sub === 'set-url') { const [n, url] = rest; if (!names().includes(n)) return fail(`error: No such remote '${n}'`, 2); const i = ini(); i['remote.' + n].url = url; write(i); return ok(); }
  if (sub === 'rename') { const [o, n] = rest; if (!names().includes(o)) return fail(`error: No such remote: '${o}'`, 2); const i = ini(); i['remote.' + n] = i['remote.' + o]; delete i['remote.' + o]; write(i); if (R.st.remotes[o]) { R.st.remotes[n] = R.st.remotes[o]; delete R.st.remotes[o]; R.touch(); } return ok(); }
  return fail(`error: Unknown subcommand: ${sub}`, 1);
};

// ---- clone, fetch, pull, push

COMMANDS.clone = (_r, sh, args) => {
  const a = parse(args, ['b', 'branch']);
  const [url, destArg] = a.rest;
  if (!url) return fail('fatal: You must specify a repository to clone.', 129);
  const { remote, ctx } = remoteAccess(null, sh, url);
  const name = destArg ?? remote.name;
  const dest = VFS.norm(name, sh.cwd);
  if (sh.fs.exists(dest) && (!sh.fs.isDir(dest) || sh.fs.list(dest).length)) return fail(`fatal: destination path '${name}' already exists and is not an empty directory.`, 128);
  const repo = guarded(url, () => gitPull(ctx, remote.name));
  const R = Repo.create(sh, dest, repo.defaultBranch ?? 'master');
  let out = `Cloning into '${name}'...\n`;
  const want = a.vals.b ?? a.vals.branch ?? repo.defaultBranch;
  R.setCfg('remote.origin.url', url); R.setCfg('remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  R.st.remotes.origin = {};
  for (const [b, id] of Object.entries(repo.branches)) { copyHistory(repo.objs, R.objs, id); R.st.remotes.origin[b] = id; }
  if (!Object.keys(repo.branches).length) { out += 'warning: You appear to have cloned an empty repository.\n'; R.save(); return { out, err: '', code: 0 }; }
  if (want && !repo.branches[want]) { sh.fs.remove(dest, true); return fail(`warning: Remote branch ${want} not found in upstream origin\nfatal: Remote branch ${want} not found in upstream origin`, 128); }
  R.st.branches[want!] = repo.branches[want!];
  R.setHead(want!);
  R.setCfg(`branch.${want}.remote`, 'origin'); R.setCfg(`branch.${want}.merge`, `refs/heads/${want}`);
  const tree = R.commit(repo.branches[want!])!.tree;
  for (const [p, b] of Object.entries(tree)) R.writeWork(p, R.content(b));
  R.setIndex({ ...tree });
  R.save();
  return ok(out);
};

function doFetch(R: Repo, remoteName: string): { out: string; changed: boolean } {
  const url = R.cfg(`remote.${remoteName}.url`);
  if (!url) throw new GitErr(`fatal: '${remoteName}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`);
  const { remote, ctx } = remoteAccess(R, R.sh, url);
  const repo = guarded(url, () => gitPull(ctx, remote.name));
  const cur = (R.st.remotes[remoteName] ??= {});
  let out = '';
  for (const [b, id] of Object.entries(repo.branches).sort()) {
    copyHistory(repo.objs, R.objs, id);
    const old = cur[b];
    if (old === id) continue;
    if (!out) out = `From ${url}\n`;
    out += old ? ` ${short(old)}..${short(id)}`.padEnd(21) + ` ${b.padEnd(10)} -> ${remoteName}/${b}\n` : ` * [new branch]      ${b.padEnd(10)} -> ${remoteName}/${b}\n`;
    cur[b] = id;
  }
  for (const b of Object.keys(cur)) if (!repo.branches[b]) delete cur[b];
  R.touch();
  return { out, changed: !!out };
}

COMMANDS.fetch = (r, _sh, args) => {
  const R = r!;
  const a = parse(args);
  const remotes = a.flags.has('all') ? Object.keys(R.readCfg(false)).filter((s) => s.startsWith('remote.')).map((s) => s.slice(7)) : [a.rest[0] ?? 'origin'];
  let out = '';
  for (const rem of remotes) out += doFetch(R, rem).out;
  return ok(out);
};

function mergeInto(R: Repo, theirs: string, label: string, opts: { noFf?: boolean; ffOnly?: boolean; msg?: string }): CmdResult {
  const head = R.headId;
  if (!head) { // rama sin commits: equivale a un fast-forward
    R.moveHead(theirs); R.checkoutTree(R.commit(theirs)!.tree, false);
    return ok(`Updating ${short(theirs)}\nFast-forward\n`);
  }
  if (head === theirs || isAncestor(R.objs, theirs, head)) return ok('Already up to date.\n');
  const ch = changes(R);
  const base = mergeBase(R.objs, head, theirs);
  const ff = isAncestor(R.objs, head, theirs);
  const newTree = ff ? R.commit(theirs)!.tree : mergeFiles(R.commit(base ?? undefined)?.tree ? Object.fromEntries(Object.entries(R.commit(base!)!.tree).map(([p, b]) => [p, R.content(b)])) : {}, filesOf(R.objs, head), filesOf(R.objs, theirs), { ours: 'HEAD', theirs: label }).files && null;
  void newTree; void ch;
  const touchedLocal = new Set([...ch.staged.map((c) => c.path), ...ch.unstaged.map((c) => c.path)]);
  const theirsChanged = new Set(diffTrees(R.headTree, R.commit(theirs)!.tree).map((c) => c.path));
  const clash = [...touchedLocal].filter((p) => theirsChanged.has(p));
  if (clash.length) throw new GitErr(`error: Your local changes to the following files would be overwritten by merge:\n${clash.map((c) => '\t' + c).join('\n')}\nPlease commit your changes or stash them before you merge.\nAborting`, 1);
  if (ff && !opts.noFf) {
    const before = R.headTree;
    R.moveHead(theirs);
    const after = R.commit(theirs)!.tree;
    const keep = R.work();
    for (const p of Object.keys(before)) if (!(p in after)) R.removeWork(p);
    for (const [p, b] of Object.entries(after)) if (!(p in keep) || blobId(keep[p]) === R.index[p] || R.index[p] === undefined) R.writeWork(p, R.content(b));
    R.setIndex({ ...after });
    return ok(`Updating ${short(head)}..${short(theirs)}\nFast-forward\n${statLines(before, after, R)}`);
  }
  if (opts.ffOnly) throw new GitErr('fatal: Not possible to fast-forward, aborting.');
  const m = mergeFiles(Object.fromEntries(Object.entries(R.commit(base ?? undefined)?.tree ?? {}).map(([p, b]) => [p, R.content(b)])), filesOf(R.objs, head), filesOf(R.objs, theirs), { ours: 'HEAD', theirs: label });
  const msg = opts.msg ?? `Merge ${label.includes('/') || R.st.branches[label] === undefined ? 'remote-tracking ' : ''}branch '${label}'${R.headRef && !['master', 'main'].includes(R.headRef) ? ` into ${R.headRef}` : ''}`;
  let out = '';
  const before = R.headTree;
  for (const [p, c] of Object.entries(m.files)) { R.writeWork(p, c); }
  for (const p of Object.keys(before)) if (!(p in m.files)) R.removeWork(p);
  if (m.conflicts.length) {
    const idx: Record<string, string> = {};
    for (const [p, c] of Object.entries(m.files)) if (!m.conflicts.includes(p)) idx[p] = putBlob(R.objs, c);
    for (const p of m.conflicts) if (before[p]) idx[p] = before[p];
    R.setIndex(idx);
    R.st.merge = { theirs, msg, conflicts: m.conflicts, label };
    for (const p of m.conflicts) out += `Auto-merging ${p}\nCONFLICT (${m.conflictKinds[p] === 'add/add' ? 'add/add' : 'content'}): Merge conflict in ${p}\n`;
    out += 'Automatic merge failed; fix conflicts and then commit the result.\n';
    return { out, err: '', code: 1 };
  }
  const tree = treeOf(R.objs, m.files);
  const c = makeCommit(R.objs, { tree, parents: [head, theirs], message: msg, author: R.ident() });
  R.moveHead(c.id);
  R.setIndex({ ...tree });
  return ok(`Merge made by the 'ort' strategy.\n${statLines(before, tree, R)}`);
}

COMMANDS.merge = (r, _sh, args) => {
  const R = r!;
  const a = parse(args, ['m']);
  if (a.flags.has('abort')) {
    if (!R.st.merge) throw new GitErr('fatal: There is no merge to abort (MERGE_HEAD missing).');
    return COMMANDS.reset(R, R.sh, ['--hard', 'HEAD']);
  }
  if (R.st.merge) throw new GitErr('error: Merging is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use \'git add/rm <file>\'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.');
  const name = a.rest[0];
  if (!name) throw new GitErr('fatal: No remote for the current branch.');
  const id = R.rev(name);
  if (!id) throw new GitErr(`merge: ${name} - not something we can merge`, 1);
  return mergeInto(R, id, name, { noFf: a.flags.has('no-ff'), ffOnly: a.flags.has('ff-only'), msg: a.vals.m });
};

COMMANDS.pull = (r, _sh, args) => {
  const R = r!;
  const a = parse(args);
  if (a.flags.has('rebase') || a.flags.has('r')) throw new GitErr("error: 'git pull --rebase' is not supported in the simulator; use 'git pull' (merge).", 1);
  const hb = R.headRef;
  const up = hb ? R.upstream(hb) : null;
  const rem = a.rest[0] ?? up?.remote ?? 'origin';
  let br = a.rest[1] ?? up?.branch;
  if (!br) {
    if (!hb) throw new GitErr('You are not currently on a branch.', 1);
    throw new GitErr(`There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.\nSee git-pull(1) for details.\n\n    git pull <remote> <branch>\n\nIf you wish to set tracking information for this branch you can do so with:\n\n    git branch --set-upstream-to=${rem}/<branch> ${hb}\n`, 1);
  }
  const f = doFetch(R, rem);
  const id = R.st.remotes[rem]?.[br];
  if (!id) throw new GitErr(`fatal: couldn't find remote ref ${br}`);
  const res = mergeInto(R, id, `${rem}/${br}`, { msg: `Merge branch '${br}' of ${R.cfg(`remote.${rem}.url`)}` });
  return { out: f.out + res.out, err: res.err, code: res.code };
};

COMMANDS.push = (r, _sh, args) => {
  const R = r!;
  const a = parse(args);
  const setUp = a.flags.has('u') || a.flags.has('set-upstream');
  const force = a.flags.has('f') || a.flags.has('force');
  const del = a.flags.has('d') || a.flags.has('delete');
  const pos = a.rest.filter((x) => x !== '--');
  const hb = R.headRef;
  const up = hb ? R.upstream(hb) : null;
  let remote = pos[0];
  let specs = pos.slice(1);
  if (!remote) {
    if (up) remote = up.remote;
    else if (R.cfg('remote.origin.url')) remote = 'origin';
    else throw new GitErr('fatal: No configured push destination.\nEither specify the URL from the command-line or configure a remote repository using\n\n    git remote add <name> <url>\n\nand then push using the remote name\n\n    git push <name>\n');
  }
  const url = R.cfg(`remote.${remote}.url`) ?? (parseRemote(R.sh, remote, R.sh.s.region) ? remote : undefined);
  if (!url) throw new GitErr(`fatal: '${remote}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.`);
  if (!specs.length) {
    if (a.flags.has('all')) specs = Object.keys(R.st.branches);
    else {
      if (!hb) throw new GitErr('fatal: You are not currently on a branch.');
      if (!up && !setUp && !pos.length) throw new GitErr(`fatal: The current branch ${hb} has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream ${remote} ${hb}\n`);
      specs = [up && !pos.length ? `${hb}:${up.branch}` : hb];
    }
  }
  const updates: PushUpdate[] = [];
  const local: Record<string, string> = {};
  for (const sp0 of specs) {
    const sp = sp0.replace(/^\+/, '');
    const f = sp0.startsWith('+') || force;
    const [src, dst0] = sp.includes(':') ? sp.split(':') : [sp, sp === 'HEAD' ? hb ?? '' : sp];
    const dst = (dst0 || src).replace(/^refs\/heads\//, '');
    if (del || src === '') { updates.push({ branch: (src === '' ? dst : sp).replace(/^refs\/heads\//, ''), newId: null }); continue; }
    const sname = src === 'HEAD' ? hb ?? '' : src.replace(/^refs\/heads\//, '');
    const id = R.st.branches[sname];
    if (!id) throw new GitErr(`error: src refspec ${src} does not match any\nerror: failed to push some refs to '${url}'`, 1);
    updates.push({ branch: dst, newId: id, force: f });
    local[dst] = sname;
  }
  const { remote: rm, ctx } = remoteAccess(R, R.sh, url);
  const res = guarded(url, () => gitPush(ctx, rm.name, updates, R.objs));
  let out = '', rejected = false;
  const cur = (R.st.remotes[remote] ??= {});
  const lines: string[] = [];
  for (const x of res) {
    if (x.status === 'up-to-date') continue;
    if (x.status === 'new') lines.push(` * [new branch]      ${(local[x.branch] ?? x.branch)} -> ${x.branch}`);
    else if (x.status === 'ff') lines.push(` ${short(x.old!)}..${short(x.id!)}  ${(local[x.branch] ?? x.branch)} -> ${x.branch}`);
    else if (x.status === 'forced') lines.push(` + ${short(x.old!)}...${short(x.id!)} ${(local[x.branch] ?? x.branch)} -> ${x.branch} (forced update)`);
    else if (x.status === 'deleted') lines.push(` - [deleted]         ${x.branch}`);
    else { rejected = true; lines.push(x.id ? ` ! [rejected]        ${(local[x.branch] ?? x.branch)} -> ${x.branch} (${R.objs.commits[x.old ?? ''] ? 'non-fast-forward' : 'fetch first'})` : ` ! [remote rejected] ${x.branch} (cannot delete the default branch)`); }
    if (x.status === 'new' || x.status === 'ff' || x.status === 'forced') { cur[x.branch] = x.id!; if (setUp) { const lb = local[x.branch] ?? x.branch; R.setCfg(`branch.${lb}.remote`, remote); R.setCfg(`branch.${lb}.merge`, `refs/heads/${x.branch}`); lines.push(`branch '${lb}' set up to track '${remote}/${x.branch}'.`); } }
    if (x.status === 'deleted') delete cur[x.branch];
  }
  R.touch();
  if (!lines.length) return ok('Everything up-to-date\n');
  out = `To ${url}\n${lines.join('\n')}\n`;
  if (rejected) {
    out += `error: failed to push some refs to '${url}'\n`;
    if (res.some((x) => x.status === 'rejected' && x.id)) out += `hint: Updates were rejected because the remote contains work that you do not\nhint: have locally. This is usually caused by another repository pushing to\nhint: the same ref. If you want to integrate the remote changes, use\nhint: 'git pull' before pushing again.\nhint: See the 'Note about fast-forwards' in 'git push --help' for details.\n`;
    return { out: '', err: out, code: 1 };
  }
  return ok(out);
};

registerCommand('git', (args, { sh }) => run(sh, args));
void unifiedDiff; void hasConflictMarkers; void cloneUrl; void cicd;

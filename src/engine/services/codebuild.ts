// AWS CodeBuild: proyectos y compilaciones. El buildspec.yml se ejecuta con un intérprete simulado (echo, exit, npm,
// scripts del repositorio, `aws` con el rol de servicio...) y las fases, los registros y los artefactos son realistas.
import yaml from 'js-yaml';
import type { CloudState, IamRole } from '../types';
import { AwsError } from '../errors';
import { trailed, authorize, type Ctx } from '../api';
import { guid, now, hex } from '../util';
import { cicd, cicdHooks, type CbBuild, type CbPhase, type CbProject } from './cicdTypes';
import { asArr, packBundle, putBucketObject, roleByArn, roleDenial, scaled, trustsService, unpackBundle, writeLog } from './cicdCommon';
import { filesOf } from './gitCore';

const SRC = 'codebuild.amazonaws.com';
export const projectArn = (ctx: { s: CloudState; region: string }, name: string) => `arn:aws:codebuild:${ctx.region}:${ctx.s.account.id}:project/${name}`;
const invalid = (m: string) => new AwsError('InvalidInputException', m, 400);
const COMPUTE = ['BUILD_GENERAL1_SMALL', 'BUILD_GENERAL1_MEDIUM', 'BUILD_GENERAL1_LARGE', 'BUILD_GENERAL1_2XLARGE'];
/** Segundos simulados -> milisegundos reales (de 40 ms por segundo simulado en modo rápido). */
const REAL_MS_PER_SIM_S = 40;

// ------------------------------------------------------------------ proyectos

function checkRole(ctx: Ctx, arn: string): IamRole {
  const role = roleByArn(ctx.s, arn ?? '');
  if (!role || !trustsService(role, 'codebuild.amazonaws.com')) throw invalid(`CodeBuild is not authorized to perform: sts:AssumeRole on ${arn}`);
  return role;
}

function normalize(ctx: Ctx, p: any, prev?: CbProject): CbProject {
  const src = p.Source ?? prev?.source;
  if (!src?.type) throw invalid('Project source must be provided');
  if (!['CODECOMMIT', 'CODEPIPELINE', 'S3', 'NO_SOURCE', 'GITHUB', 'BITBUCKET'].includes(src.type)) throw invalid(`Invalid source type: ${src.type}`);
  if ((src.type === 'CODECOMMIT' || src.type === 'S3') && !src.location) throw invalid('Source location must be provided');
  if (src.type === 'NO_SOURCE' && !src.buildspec) throw invalid('Source buildspec must be provided when the source type is NO_SOURCE');
  const art = p.Artifacts ?? prev?.artifacts ?? { type: 'NO_ARTIFACTS' };
  if (!['NO_ARTIFACTS', 'S3', 'CODEPIPELINE'].includes(art.type)) throw invalid(`Invalid artifacts type: ${art.type}`);
  if (art.type === 'S3' && !art.location) throw invalid('Artifacts location must be provided for S3 artifacts');
  if ((src.type === 'CODEPIPELINE') !== (art.type === 'CODEPIPELINE')) throw invalid('Source and artifacts type must both be CODEPIPELINE when used with AWS CodePipeline');
  const env = p.Environment ?? prev?.environment;
  if (!env?.image || !env?.computeType || !env?.type) throw invalid('Environment must specify type, image and computeType');
  if (!COMPUTE.includes(env.computeType)) throw invalid(`Invalid compute type: ${env.computeType}`);
  if (!['LINUX_CONTAINER', 'LINUX_GPU_CONTAINER', 'ARM_CONTAINER', 'WINDOWS_SERVER_2019_CONTAINER'].includes(env.type)) throw invalid(`Invalid environment type: ${env.type}`);
  const role = p.ServiceRole ?? prev?.serviceRole;
  if (!role) throw invalid('Service role must be provided');
  checkRole(ctx, role);
  const tmo = p.TimeoutInMinutes ?? prev?.timeoutInMinutes ?? 60;
  if (tmo < 5 || tmo > 2160) throw invalid(`Invalid timeout: ${tmo}. Timeout must be between 5 and 2160 minutes`);
  return {
    name: prev?.name ?? p.Name, arn: prev?.arn ?? projectArn(ctx, p.Name), region: prev?.region ?? ctx.region, description: p.Description ?? prev?.description,
    source: { type: src.type, location: src.location, buildspec: src.buildspec, gitCloneDepth: src.gitCloneDepth ?? (src.type === 'CODECOMMIT' ? 1 : undefined) },
    sourceVersion: p.SourceVersion ?? prev?.sourceVersion,
    artifacts: art,
    environment: { type: env.type, image: env.image, computeType: env.computeType, environmentVariables: (env.environmentVariables ?? []).map((v: any) => ({ name: v.name, value: String(v.value ?? ''), type: v.type ?? 'PLAINTEXT' })), privilegedMode: String(env.privilegedMode) === 'true', imagePullCredentialsType: env.imagePullCredentialsType ?? 'CODEBUILD' },
    serviceRole: role, timeoutInMinutes: tmo, queuedTimeoutInMinutes: p.QueuedTimeoutInMinutes ?? prev?.queuedTimeoutInMinutes ?? 480,
    logsConfig: p.LogsConfig ? { cloudWatchLogs: { status: p.LogsConfig.cloudWatchLogs?.status ?? 'ENABLED', groupName: p.LogsConfig.cloudWatchLogs?.groupName, streamName: p.LogsConfig.cloudWatchLogs?.streamName }, s3Logs: { status: p.LogsConfig.s3Logs?.status ?? 'DISABLED' } } : prev?.logsConfig ?? { cloudWatchLogs: { status: 'ENABLED' }, s3Logs: { status: 'DISABLED' } },
    created: prev?.created ?? now(), lastModified: now(), tags: p.Tags ? Object.fromEntries(asArr<any>(p.Tags).map((t) => [t.key, t.value])) : prev?.tags ?? {},
  };
}

export function getProject(ctx: Ctx, name: string): CbProject {
  const p = cicd(ctx.s).projects.find((x) => x.name === name && x.region === ctx.region);
  if (!p) throw new AwsError('ResourceNotFoundException', `Project cannot be found: ${projectArn(ctx, name)}`, 400);
  return p;
}

export function createProject(ctx: Ctx, p: any): CbProject {
  return trailed(ctx, SRC, 'CreateProject', [{ type: 'AWS::CodeBuild::Project', name: p.Name }], { name: p.Name, source: p.Source, artifacts: p.Artifacts, environment: p.Environment, serviceRole: p.ServiceRole }, () => {
    authorize(ctx, 'codebuild:CreateProject', projectArn(ctx, p.Name ?? '*'));
    if (!/^[A-Za-z0-9][A-Za-z0-9\-_]{1,254}$/.test(p.Name ?? '')) throw invalid(`Invalid project name: ${p.Name}`);
    if (cicd(ctx.s).projects.some((x) => x.name === p.Name && x.region === ctx.region)) throw new AwsError('ResourceAlreadyExistsException', `Project already exists: ${projectArn(ctx, p.Name)}`, 400);
    const proj = normalize(ctx, p);
    cicd(ctx.s).projects.push(proj);
    return proj;
  });
}

export function updateProject(ctx: Ctx, p: any): CbProject {
  return trailed(ctx, SRC, 'UpdateProject', [{ type: 'AWS::CodeBuild::Project', name: p.Name }], { name: p.Name }, () => {
    authorize(ctx, 'codebuild:UpdateProject', projectArn(ctx, p.Name));
    const prev = getProject(ctx, p.Name);
    const next = normalize(ctx, p, prev);
    Object.assign(prev, next);
    return prev;
  });
}

export function deleteProject(ctx: Ctx, p: { Name: string }): void {
  return trailed(ctx, SRC, 'DeleteProject', [{ type: 'AWS::CodeBuild::Project', name: p.Name }], { name: p.Name }, () => {
    authorize(ctx, 'codebuild:DeleteProject', projectArn(ctx, p.Name));
    const c = cicd(ctx.s);
    c.projects = c.projects.filter((x) => !(x.name === p.Name && x.region === ctx.region));
  });
}

export function listProjects(ctx: Ctx): string[] {
  return trailed(ctx, SRC, 'ListProjects', [], {}, () => {
    authorize(ctx, 'codebuild:ListProjects', '*');
    return cicd(ctx.s).projects.filter((x) => x.region === ctx.region).map((x) => x.name).sort();
  });
}

export function batchGetProjects(ctx: Ctx, p: { Names: string[] }): { projects: CbProject[]; notFound: string[] } {
  return trailed(ctx, SRC, 'BatchGetProjects', [], { names: p.Names }, () => {
    for (const n of p.Names ?? []) authorize(ctx, 'codebuild:BatchGetProjects', projectArn(ctx, n));
    const projects: CbProject[] = [], notFound: string[] = [];
    for (const n of p.Names ?? []) {
      const x = cicd(ctx.s).projects.find((y) => y.name === n && y.region === ctx.region);
      (x ? projects : notFound).push(x as any ?? n);
    }
    return { projects, notFound };
  });
}

// ------------------------------------------------------------------ intérprete de buildspec

const CMD_SECONDS: [RegExp, number][] = [[/^(npm|yarn|pnpm) (ci|install)/, 14], [/^(npm|yarn) (run )?test/, 9], [/^(npm|yarn) run/, 11], [/^(pip3?|poetry) install/, 8], [/^docker build/, 28], [/^docker push/, 12], [/^docker pull/, 6], [/^(mvn|gradle|\.\/gradlew)/, 25], [/^go (build|test)/, 10], [/^aws /, 2], [/^(apt-get|yum|dnf) /, 9], [/^pytest|^python.* -m (pytest|unittest)/, 6]];

interface RunCtx {
  s: CloudState;
  region: string;
  role?: IamRole;
  env: Record<string, string>;
  files: Record<string, string>;
  cwd: string;
  priv: boolean;
  sim: number;
  log: string[];
  depth: number;
}

type Tok = { t: string; quoted: boolean };

function tokenize(line: string, env: Record<string, string>, sub: (c: string) => string): Tok[] {
  const toks: Tok[] = [];
  let cur = '', has = false, quoted = false;
  const push = () => { if (has) toks.push({ t: cur, quoted }); cur = ''; has = false; quoted = false; };
  const expand = (txt: string) => txt.replace(/\$\(([^()]*)\)/g, (_, c) => sub(c)).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a, d, b) => env[a ?? b] ?? d ?? '');
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") { const e = line.indexOf("'", i + 1); const end = e < 0 ? line.length : e; cur += line.slice(i + 1, end); i = end; has = quoted = true; }
    else if (c === '"') {
      let j = i + 1, buf = '';
      while (j < line.length && line[j] !== '"') { if (line[j] === '\\' && '"\\$'.includes(line[j + 1] ?? '')) { buf += line[j + 1]; j += 2; continue; } if (line[j] === '$' && line[j + 1] === '(') { let d = 1, k = j + 2; while (k < line.length && d) { if (line[k] === '(') d++; else if (line[k] === ')') d--; k++; } buf += line.slice(j, k); j = k; continue; } buf += line[j++]; }
      cur += expand(buf); i = j; has = quoted = true;
    } else if (/\s/.test(c)) push();
    else if (c === '$' && line[i + 1] === '(') {
      let d = 1, k = i + 2;
      while (k < line.length && d) { if (line[k] === '(') d++; else if (line[k] === ')') d--; k++; }
      cur += expand(line.slice(i, k)); i = k - 1; has = true;
    } else if (c === '>' ) { push(); let op = '>'; if (line[i + 1] === '>') { op = '>>'; i++; } toks.push({ t: op, quoted: false }); }
    else { let j = i; while (j < line.length && !/[\s'">]/.test(line[j]) && !(line[j] === '$' && line[j + 1] === '(')) j++; cur += expand(line.slice(i, j)); i = j - 1; has = true; }
  }
  push();
  return toks;
}

/** Parte por separadores de nivel superior (&&, ||, ;, |) respetando comillas y $( ). */
function splitTop(line: string, seps: string[]): { part: string; op: string }[] {
  const out: { part: string; op: string }[] = [];
  let cur = '', q = '', depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { cur += c; if (c === q) q = ''; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '$' && line[i + 1] === '(') { depth++; cur += '$('; i++; continue; }
    if (depth && c === ')') { depth--; cur += c; continue; }
    if (!depth) {
      const hit = seps.find((s) => line.startsWith(s, i) && !(s === '|' && (line[i + 1] === '|' || line[i - 1] === '|')));
      if (hit) { out.push({ part: cur.trim(), op: hit }); cur = ''; i += hit.length - 1; continue; }
    }
    cur += c;
  }
  out.push({ part: cur.trim(), op: '' });
  return out.filter((x) => x.part || x.op);
}

function cmdSeconds(cmd: string): number {
  if (/^(echo|printf|export|cd|true|false|:|exit)\b/.test(cmd)) return 0;
  return CMD_SECONDS.find(([re]) => re.test(cmd))?.[1] ?? 1;
}

const writeFile = (r: RunCtx, path: string, content: string, append: boolean) => {
  const p = path.startsWith('/') ? path.replace(/^\//, '') : [r.cwd, path].filter((x) => x && x !== '.').join('/').replace(/^\.\//, '');
  r.files[p] = append ? (r.files[p] ?? '') + content : content;
};
const readFile = (r: RunCtx, path: string): string | undefined => r.files[path.replace(/^\.\//, '')] ?? r.files[[r.cwd, path].filter((x) => x && x !== '.').join('/')];

function runPipe(r: RunCtx, text: string): { code: number; out: string } {
  const stages = splitTop(text, ['|']);
  let data = '', code = 0;
  stages.forEach((st, i) => {
    const res = runSimple(r, st.part, data, i === stages.length - 1);
    data = res.out;
    code = res.code;
  });
  return { code, out: data };
}

function runSimple(r: RunCtx, text: string, stdin: string, last: boolean): { code: number; out: string } {
  const sub = (c: string) => runList(r, c, true).out.replace(/\n+$/, '');
  let toks = tokenize(text, r.env, sub);
  if (!toks.length) return { code: 0, out: '' };
  // redirecciones
  let redir: { path: string; append: boolean } | null = null;
  const ri = toks.findIndex((t) => !t.quoted && (t.t === '>' || t.t === '>>'));
  if (ri >= 0) {
    const path = toks[ri + 1]?.t;
    if (path) redir = { path, append: toks[ri].t === '>>' };
    toks = [...toks.slice(0, ri), ...toks.slice(ri + 2).filter((x) => !/^\d>&\d$|^2>/.test(x.t))];
    toks = toks.filter((x) => x.t !== '2>&1');
  }
  const words = toks.map((t) => t.t).filter((w) => w !== '2>&1');
  let res: { code: number; out: string };
  // asignaciones VAR=valor
  let k = 0;
  while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k])) { const [n, ...v] = words[k].split('='); r.env[n] = v.join('='); k++; }
  const argv = words.slice(k);
  if (!argv.length) return { code: 0, out: '' };
  res = exec(r, argv, stdin);
  if (redir) {
    if (redir.path !== '/dev/null') writeFile(r, redir.path, res.out, redir.append);
    res = { code: res.code, out: '' };
  }
  void last;
  return res;
}

function runList(r: RunCtx, line: string, quiet = false): { code: number; out: string } {
  const parts = splitTop(line, ['&&', '||', ';']);
  let code = 0, out = '', prevOp = '';
  for (const p of parts) {
    const skip = (prevOp === '&&' && code !== 0) || (prevOp === '||' && code === 0);
    if (!skip && p.part) {
      const res = runPipe(r, p.part);
      code = res.code;
      out += res.out;
      if (!quiet && res.out) r.log.push(...res.out.replace(/\n$/, '').split('\n'));
    }
    prevOp = p.op;
  }
  return { code, out };
}

function runScript(r: RunCtx, path: string, args: string[]): { code: number; out: string } {
  const body = readFile(r, path);
  if (body === undefined) return { code: 127, out: `bash: ${path}: No such file or directory\n` };
  if (r.depth > 5) return { code: 0, out: '' };
  let out = '';
  r.depth++;
  try {
    args.forEach((a, i) => { r.env[String(i + 1)] = a; });
    for (const raw of body.split('\n')) {
      const l = raw.trim();
      if (!l || l.startsWith('#')) continue;
      const res = runList(r, l, true);
      out += res.out;
      if (res.code !== 0) return { code: res.code, out };
    }
  } finally { r.depth--; }
  return { code: 0, out };
}

function exec(r: RunCtx, argv: string[], stdin: string): { code: number; out: string } {
  const [cmd, ...a] = argv;
  r.sim += cmdSeconds(argv.join(' '));
  const ok = (out = '') => ({ code: 0, out: out ? out.replace(/\n?$/, '\n') : '' });
  switch (cmd) {
    case 'echo': { const n = a[0] === '-n'; const e = a[0] === '-e'; return { code: 0, out: a.slice(n || e ? 1 : 0).join(' ') + (n ? '' : '\n') }; }
    case 'printf': return ok((a[0] ?? '').replace(/%s/g, () => a.splice(1, 1)[0] ?? '').replace(/\\n/g, '\n').replace(/\n$/, ''));
    case 'exit': return { code: Number(a[0] ?? 0) || 0, out: '' };
    case 'true': case ':': return ok();
    case 'false': return { code: 1, out: '' };
    case 'cd': { const t = a[0] ?? '.'; r.cwd = t === '..' ? r.cwd.split('/').slice(0, -1).join('/') : t.startsWith('/') ? t.replace(/^\//, '') : [r.cwd, t].filter((x) => x && x !== '.').join('/'); return ok(); }
    case 'pwd': return ok('/codebuild/output/src/' + r.cwd);
    case 'export': for (const w of a) { const [n, ...v] = w.split('='); if (v.length) r.env[n] = v.join('='); } return ok();
    case 'set': case 'unset': case 'sleep': case 'source_profile': return ok();
    case 'test': case '[': {
      const args = a.filter((x) => x !== ']');
      const [f, v] = args;
      if (f === '-f') return { code: readFile(r, v) !== undefined ? 0 : 1, out: '' };
      if (f === '-d') return { code: Object.keys(r.files).some((p) => p.startsWith(v.replace(/\/$/, '') + '/')) ? 0 : 1, out: '' };
      if (f === '-n') return { code: v ? 0 : 1, out: '' };
      if (f === '-z') return { code: v ? 1 : 0, out: '' };
      if (args[1] === '=' || args[1] === '==') return { code: args[0] === args[2] ? 0 : 1, out: '' };
      if (args[1] === '!=') return { code: args[0] !== args[2] ? 0 : 1, out: '' };
      return ok();
    }
    case 'mkdir': case 'touch': { for (const f of a.filter((x) => !x.startsWith('-'))) if (cmd === 'touch' && readFile(r, f) === undefined) writeFile(r, f, '', false); return ok(); }
    case 'cp': { const [src, dst] = a.filter((x) => !x.startsWith('-')); const c = src && readFile(r, src); if (c === undefined || c === '' && src && readFile(r, src) === undefined) return { code: 1, out: `cp: cannot stat '${src}': No such file or directory\n` }; writeFile(r, dst, c as string, false); return ok(); }
    case 'mv': { const [src, dst] = a.filter((x) => !x.startsWith('-')); const c = readFile(r, src); if (c === undefined) return { code: 1, out: `mv: cannot stat '${src}': No such file or directory\n` }; writeFile(r, dst, c, false); delete r.files[src]; return ok(); }
    case 'rm': { for (const f of a.filter((x) => !x.startsWith('-'))) { delete r.files[f]; for (const k of Object.keys(r.files)) if (k.startsWith(f.replace(/\/$/, '') + '/')) delete r.files[k]; } return ok(); }
    case 'cat': { const outp: string[] = []; for (const f of a.filter((x) => !x.startsWith('-'))) { const c = readFile(r, f); if (c === undefined) return { code: 1, out: `cat: ${f}: No such file or directory\n` }; outp.push(c); } return { code: 0, out: outp.length ? outp.join('') : stdin }; }
    case 'ls': return ok(Object.keys(r.files).filter((p) => !p.includes('/')).sort().join('\n'));
    case 'cut': {
      const ci = a.indexOf('-c');
      if (ci >= 0) { const [s0, e0] = a[ci + 1].split('-').map(Number); return ok(stdin.replace(/\n$/, '').split('\n').map((l) => l.slice(s0 - 1, e0 || undefined)).join('\n')); }
      const di = a.indexOf('-d'), fi = a.indexOf('-f');
      if (di >= 0 && fi >= 0) return ok(stdin.replace(/\n$/, '').split('\n').map((l) => l.split(a[di + 1])[Number(a[fi + 1]) - 1] ?? '').join('\n'));
      return ok(stdin);
    }
    case 'head': { const n = a.indexOf('-c'); if (n >= 0) return ok(stdin.replace(/\n$/, '').slice(0, Number(a[n + 1]))); return ok(stdin); }
    case 'tr': { if (a[0] === '-d') return ok(stdin.replace(new RegExp(`[${a[1].replace(/[\]\\^-]/g, '\\$&')}]`, 'g'), '')); return ok(stdin); }
    case 'sh': case 'bash': { const f = a.find((x) => !x.startsWith('-')); return f ? runScript(r, f, a.slice(a.indexOf(f) + 1)) : ok(); }
    case 'source': case '.': return runScript(r, a[0], a.slice(1));
    case 'npm': case 'yarn': case 'pnpm': return runNode(r, cmd, a);
    case 'node': case 'python': case 'python3': return ok();
    case 'pip': case 'pip3': return ok('Collecting dependencies\nSuccessfully installed ' + (a.slice(1).filter((x) => !x.startsWith('-')).join(' ') || 'requirements'));
    case 'docker': return runDocker(r, a);
    case 'aws': return runAwsCmd(r, a);
    case 'git': return ok();
    case 'curl': case 'wget': return ok();
    case 'zip': case 'tar': case 'unzip': return ok();
    case 'make': return ok(`make: Entering directory '/codebuild/output/src/${r.cwd}'\nmake: Leaving directory`);
    case 'mvn': return ok('[INFO] BUILD SUCCESS');
    case 'apt-get': case 'yum': case 'dnf': return ok('Reading package lists... Done');
  }
  if (/^\.\//.test(cmd) || cmd.endsWith('.sh')) return runScript(r, cmd, a);
  return ok();
}

function runNode(r: RunCtx, bin: string, a: string[]): { code: number; out: string } {
  const sub = a[0] ?? '';
  const pj = readFile(r, 'package.json');
  if (['ci', 'install', 'i', 'add'].includes(sub)) return { code: 0, out: bin === 'npm' ? `added 142 packages, and audited 143 packages in 3s\n\nfound 0 vulnerabilities\n` : 'Done in 3.2s.\n' };
  let script: string | undefined;
  let name = sub;
  if (sub === 'run' || sub === 'run-script') name = a[1];
  if (sub === 'test' || sub === 't') name = 'test';
  if (!name) return { code: 0, out: '' };
  let pkg: any = {};
  try { pkg = pj ? JSON.parse(pj) : {}; } catch { return { code: 1, out: 'npm ERR! code EJSONPARSE\nnpm ERR! JSON.parse Invalid package.json: JSONParseError\n' }; }
  script = pkg.scripts?.[name];
  if (script === undefined) {
    if (!pj) return { code: 254, out: `npm ERR! code ENOENT\nnpm ERR! syscall open\nnpm ERR! path /codebuild/output/src/${r.cwd}/package.json\nnpm ERR! errno -2\nnpm ERR! enoent Could not read package.json: Error: ENOENT: no such file or directory, open '/codebuild/output/src/package.json'\n` };
    return { code: 1, out: `npm ERR! Missing script: "${name}"\nnpm ERR!\nnpm ERR! To see a list of scripts, run:\nnpm ERR!   npm run\n` };
  }
  if (r.depth > 5) return { code: 0, out: '' };
  r.depth++;
  try {
    const res = runList(r, script, true);
    const head = `\n> ${pkg.name ?? 'app'}@${pkg.version ?? '1.0.0'} ${name}\n> ${script}\n\n`;
    if (res.code !== 0) return { code: 1, out: head + res.out + `npm ERR! code ELIFECYCLE\nnpm ERR! errno ${res.code}\nnpm ERR! ${pkg.name ?? 'app'}@${pkg.version ?? '1.0.0'} ${name}: \`${script}\`\nnpm ERR! Exit status ${res.code}\n` };
    return { code: 0, out: head + res.out };
  } finally { r.depth--; }
}

function runDocker(r: RunCtx, a: string[]): { code: number; out: string } {
  if (!r.priv) return { code: 1, out: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n' };
  const sub = a[0];
  if (sub === 'build') return { code: 0, out: '[+] Building 18.2s (9/9) FINISHED\n => exporting to image\n => => writing image sha256:' + hex(64) + '\n' };
  if (sub === 'login') return { code: 0, out: 'Login Succeeded\n' };
  if (sub === 'push') return { code: 0, out: `The push refers to repository [${a[1] ?? ''}]\nlatest: digest: sha256:${hex(64)} size: 1573\n` };
  return { code: 0, out: '' };
}

function runAwsCmd(r: RunCtx, a: string[]): { code: number; out: string } {
  if (!cicdHooks.runAws || !r.role) return { code: 0, out: '' };
  const res = cicdHooks.runAws(r.s, r.region, r.role.name, a.some((x) => x === '--region') ? a : [...a, '--region', r.region], r.files);
  return { code: res.code, out: res.out + res.err };
}

/** Ejecuta un script (p. ej. un hook de CodeDeploy) con el mismo intérprete simulado que usan las compilaciones. */
export function runShellScript(s: CloudState, files: Record<string, string>, path: string, env: Record<string, string> = {}): { code: number; out: string } {
  const r: RunCtx = { s, region: '', env: { ...env }, files: { ...files }, cwd: '', priv: false, sim: 0, log: [], depth: 0 };
  return runScript(r, path, []);
}

// ------------------------------------------------------------------ simulación de una compilación

const PHASES = ['install', 'pre_build', 'build', 'post_build'] as const;
const stamp = (ts: number) => { const d = new Date(ts); const p = (n: number, w = 2) => String(n).padStart(w, '0'); return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}${p(Math.floor(Math.random() * 1000), 3)}`; };

const globRe = (pat: string) => new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');

interface Sim { phases: CbPhase[]; logs: { ts: number; msg: string }[]; status: CbBuild['finalStatus']; outFiles?: Record<string, string>; artifactLocation?: string; totalSim: number }

function simulate(s: CloudState, proj: CbProject, role: IamRole | undefined, b: { t0: number; number: number; id: string; version?: string; resolved?: string }, files: Record<string, string> | { error: string }, specText: string | { error: string }, envOverride: { name: string; value: string }[]): Sim {
  const phases: CbPhase[] = [];
  const logs: { ts: number; msg: string }[] = [];
  let off = 0;
  const at = (o: number) => b.t0 + scaled(o * REAL_MS_PER_SIM_S);
  const L = (msg: string, o = off) => logs.push({ ts: at(o), msg: `[Container] ${stamp(at(o))} ${msg}` });
  const raw = (msg: string, o = off) => logs.push({ ts: at(o), msg });
  const phase = (type: string, sim: number, status: string | undefined, contexts?: { statusCode: string; message: string }[]) => {
    phases.push({ phaseType: type, phaseStatus: status, startTime: at(off), endTime: type === 'COMPLETED' ? undefined : at(off + sim), durationInSeconds: type === 'COMPLETED' ? undefined : sim, contexts: contexts ?? (type === 'COMPLETED' ? undefined : []) });
    off += sim;
  };
  const srcDir = `/codebuild/output/src${String(100000000 + b.number * 7919)}/src`;
  const finish = (status: Sim['status'], extra: Partial<Sim> = {}): Sim => {
    phase('FINALIZING', 1, 'SUCCEEDED');
    phase('COMPLETED', 0, status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED');
    phases[phases.length - 1].endTime = undefined;
    return { phases, logs, status, totalSim: off, ...extra };
  };
  const fail = (type: string, sim: number, code: string, message: string): Sim => {
    L(`Phase complete: ${type} State: FAILED`);
    L(`Phase context status code: ${code} Message: ${message}`);
    phase(type, sim, 'FAILED', [{ statusCode: code, message }]);
    return finish('FAILED');
  };

  phase('SUBMITTED', 0, 'SUCCEEDED');
  phase('QUEUED', 1, 'SUCCEEDED');
  L('Running on CodeBuild On-demand', off + 18);
  // PROVISIONING: el rol debe poder escribir registros.
  const logGroup = proj.logsConfig.cloudWatchLogs.groupName ?? `/aws/codebuild/${proj.name}`;
  const prov = 18 + (b.number % 7);
  if (role && proj.logsConfig.cloudWatchLogs.status === 'ENABLED') {
    const denial = roleDenial(s, role, `AWSCodeBuild-${b.id.split(':')[1]}`, 'logs:CreateLogStream', `arn:aws:logs:${proj.region}:${s.account.id}:log-group:${logGroup}:log-stream:${b.id.split(':')[1]}`) ?? roleDenial(s, role, 'AWSCodeBuild', 'logs:PutLogEvents', `arn:aws:logs:${proj.region}:${s.account.id}:log-group:${logGroup}:log-stream:${b.id.split(':')[1]}`);
    if (denial) {
      phase('PROVISIONING', prov, 'FAILED', [{ statusCode: 'CLIENT_ERROR', message: `Error in creating log stream: ${denial}. Make sure the service role has logs:CreateLogGroup, logs:CreateLogStream and logs:PutLogEvents permissions.` }]);
      logs.length = 0;
      return finish('FAILED', { logs: [] });
    }
  }
  phase('PROVISIONING', prov, 'SUCCEEDED');
  L('Waiting for agent ping');
  L('Waiting for DOWNLOAD_SOURCE');
  L('Phase is DOWNLOAD_SOURCE');
  L(`CODEBUILD_SRC_DIR=${srcDir}`);
  if ('error' in files) return fail('DOWNLOAD_SOURCE', 3, 'CLIENT_ERROR', files.error);
  if (typeof specText !== 'string') {
    L(`YAML location is ${srcDir}/buildspec.yml`);
    return fail('DOWNLOAD_SOURCE', 3, 'YAML_FILE_ERROR', specText.error);
  }
  L(`YAML location is ${srcDir}/${proj.source.buildspec && !/\n/.test(proj.source.buildspec) ? proj.source.buildspec : 'buildspec.yml'}`);
  let spec: any;
  try { spec = yaml.load(specText); } catch (e) {
    const m = (e as Error).message.split('\n')[0];
    return fail('DOWNLOAD_SOURCE', 3, 'YAML_FILE_ERROR', `YAML_FILE_ERROR: ${m}`.replace('YAML_FILE_ERROR: YAML_FILE_ERROR', 'YAML_FILE_ERROR'));
  }
  if (!spec || typeof spec !== 'object' || ![0.1, 0.2, '0.1', '0.2'].includes(spec.version)) return fail('DOWNLOAD_SOURCE', 3, 'YAML_FILE_ERROR', 'YAML_FILE_ERROR: Invalid buildspec: the "version" key must be 0.1 or 0.2.');
  for (const ph of PHASES) {
    const cmds = spec.phases?.[ph]?.commands;
    if (cmds !== undefined) {
      if (!Array.isArray(cmds)) return fail('DOWNLOAD_SOURCE', 3, 'YAML_FILE_ERROR', `YAML_FILE_ERROR: Expected phases.${ph}.commands to be a list`);
      const i = cmds.findIndex((c: unknown) => typeof c !== 'string');
      if (i >= 0) return fail('DOWNLOAD_SOURCE', 3, 'YAML_FILE_ERROR', `YAML_FILE_ERROR: Expected Commands[${i}] to be of string type: found subkeys instead. Please use '|' or '>' indicator for multi-line commands`);
    }
  }
  phase('DOWNLOAD_SOURCE', 3, 'SUCCEEDED');
  L('Phase complete: DOWNLOAD_SOURCE State: SUCCEEDED');
  L('Phase context status code:  Message: ');
  L('Processing environment variables');
  const env: Record<string, string> = {
    CODEBUILD_BUILD_ID: b.id, CODEBUILD_BUILD_NUMBER: String(b.number), CODEBUILD_BUILD_ARN: `arn:aws:codebuild:${proj.region}:${s.account.id}:build/${b.id}`, CODEBUILD_SRC_DIR: srcDir,
    CODEBUILD_RESOLVED_SOURCE_VERSION: b.resolved ?? '', CODEBUILD_SOURCE_VERSION: b.version ?? '', CODEBUILD_INITIATOR: 'user', AWS_REGION: proj.region, AWS_DEFAULT_REGION: proj.region,
    CODEBUILD_BUILD_IMAGE: proj.environment.image, CODEBUILD_START_TIME: String(b.t0), CODEBUILD_BUILD_SUCCEEDING: '1',
  };
  for (const v of proj.environment.environmentVariables) env[v.name] = v.value;
  for (const [k, v] of Object.entries<any>(spec.env?.variables ?? {})) env[k] = String(v);
  for (const v of envOverride) env[v.name] = v.value;
  const run: RunCtx = { s, region: proj.region, role, env, files: { ...files }, cwd: '', priv: proj.environment.privilegedMode, sim: 0, log: [], depth: 0 };
  const runtimes = spec.phases?.install?.['runtime-versions'];
  let failedPhase: string | null = null;
  let failedCtx: { statusCode: string; message: string } | null = null;
  const runPhase = (ph: (typeof PHASES)[number], upper: string) => {
    const def = spec.phases?.[ph];
    const skipAfterFail = failedPhase && !(ph === 'post_build' && failedPhase === 'BUILD');
    if (skipAfterFail) return;
    L(`Entering phase ${upper}`);
    if (ph === 'install') L(runtimes ? `Selecting ${Object.entries(runtimes).map(([k, v]) => `'${k}' runtime version '${v}'`).join(', ')} based on manual selections...` : 'No runtime version selected in buildspec.');
    run.sim = 0;
    if (ph === 'post_build') env.CODEBUILD_BUILD_SUCCEEDING = failedPhase ? '0' : '1';
    let code = 0, failedCmd = '';
    const cmds: string[] = [...(def?.commands ?? [])];
    for (const cmd of cmds) {
      L(`Running command ${cmd}`, off + run.sim);
      run.log = [];
      const res = runList(run, cmd);
      if (res.code !== 0) {
        for (const ln of run.log) raw(ln, off + run.sim);
        L(`Command did not exit successfully ${cmd} exit status ${res.code}`, off + run.sim);
        code = res.code; failedCmd = cmd;
        break;
      }
      for (const ln of run.log) raw(ln, off + run.sim);
    }
    for (const cmd of [...(def?.finally ?? [])] as string[]) { L(`Running command ${cmd}`, off + run.sim); run.log = []; runList(run, cmd); for (const ln of run.log) raw(ln, off + run.sim); }
    const sim = Math.max(1, Math.ceil(run.sim));
    if (code) {
      const message = `Error while executing command: ${failedCmd}. Reason: exit status ${code}`;
      L(`Phase complete: ${upper} State: FAILED`, off + sim);
      L(`Phase context status code: COMMAND_EXECUTION_ERROR Message: ${message}`, off + sim);
      phase(upper, sim, 'FAILED', [{ statusCode: 'COMMAND_EXECUTION_ERROR', message }]);
      failedPhase = upper; failedCtx = { statusCode: 'COMMAND_EXECUTION_ERROR', message };
    } else {
      L(`Phase complete: ${upper} State: SUCCEEDED`, off + sim);
      L('Phase context status code:  Message: ', off + sim);
      phase(upper, def ? sim : 0, 'SUCCEEDED');
    }
  };
  runPhase('install', 'INSTALL');
  runPhase('pre_build', 'PRE_BUILD');
  runPhase('build', 'BUILD');
  runPhase('post_build', 'POST_BUILD');
  void failedCtx;
  if (failedPhase) return finish('FAILED');
  // UPLOAD_ARTIFACTS
  L('Entering phase UPLOAD_ARTIFACTS');
  const art = spec.artifacts;
  let outFiles: Record<string, string> | undefined;
  let location: string | undefined;
  if (proj.artifacts.type === 'NO_ARTIFACTS') {
    L('Skipping upload of artifacts');
    phase('UPLOAD_ARTIFACTS', 0, 'SUCCEEDED');
  } else if (!art) {
    L('Phase complete: UPLOAD_ARTIFACTS State: FAILED');
    L('Phase context status code: CLIENT_ERROR Message: no matching artifact paths found');
    phase('UPLOAD_ARTIFACTS', 1, 'FAILED', [{ statusCode: 'CLIENT_ERROR', message: 'no matching artifact paths found' }]);
    return finish('FAILED');
  } else {
    const base = (art['base-directory'] ?? '.') as string;
    const baseDir = base === '.' ? '' : base.replace(/^\.\//, '').replace(/\/$/, '') + '/';
    L(`Expanding base directory path: ${base}`);
    L('Assembling file list');
    const pats: string[] = asArr(art.files ?? ['**/*']);
    const matched: Record<string, string> = {};
    for (const p of pats) {
      L(`Expanding ${p}`);
      const re = globRe(p.replace(/^\.\//, ''));
      for (const [path, c] of Object.entries(run.files)) if (path.startsWith(baseDir) && re.test(path.slice(baseDir.length))) matched[art['discard-paths'] === 'yes' ? path.split('/').pop()! : path.slice(baseDir.length)] = c;
    }
    L(`Found ${Object.keys(matched).length} file(s)`);
    if (!Object.keys(matched).length) {
      L('Phase complete: UPLOAD_ARTIFACTS State: FAILED');
      L('Phase context status code: CLIENT_ERROR Message: no matching artifact paths found');
      phase('UPLOAD_ARTIFACTS', 1, 'FAILED', [{ statusCode: 'CLIENT_ERROR', message: 'no matching artifact paths found' }]);
      return finish('FAILED');
    }
    outFiles = matched;
    if (proj.artifacts.type === 'S3') {
      const bucket = proj.artifacts.location!;
      const packaging = proj.artifacts.packaging ?? 'NONE';
      const name = art.name ?? proj.artifacts.name ?? proj.name;
      const prefix = [proj.artifacts.path, proj.artifacts.namespaceType === 'BUILD_ID' ? b.id.split(':')[1] : ''].filter(Boolean).join('/');
      const key = [prefix, packaging === 'ZIP' ? (name.endsWith('.zip') ? name : name + '.zip') : name].filter(Boolean).join('/');
      const bk = s.buckets.find((x) => x.name === bucket);
      const denial = role && bk ? roleDenial(s, role, 'AWSCodeBuild', 's3:PutObject', `arn:aws:s3:::${bucket}/${key}`) : null;
      const reason = !bk ? 'NoSuchBucket: The specified bucket does not exist' : denial ? 'AccessDenied: Access Denied' : '';
      if (reason) {
        L('Phase complete: UPLOAD_ARTIFACTS State: FAILED');
        L(`Phase context status code: CLIENT_ERROR Message: Failed to upload artifacts: ${reason}`);
        phase('UPLOAD_ARTIFACTS', 1, 'FAILED', [{ statusCode: 'CLIENT_ERROR', message: `Failed to upload artifacts: ${reason}` }]);
        return finish('FAILED');
      }
      if (packaging === 'ZIP') putBucketObject(s, bucket, key, packBundle(matched));
      else for (const [p, c] of Object.entries(matched)) putBucketObject(s, bucket, `${key}/${p}`, c, 'binary/octet-stream');
      location = `arn:aws:s3:::${bucket}/${key}`;
    }
    L('Phase complete: UPLOAD_ARTIFACTS State: SUCCEEDED');
    L('Phase context status code:  Message: ');
    phase('UPLOAD_ARTIFACTS', 2, 'SUCCEEDED');
  }
  return finish('SUCCEEDED', { outFiles, artifactLocation: location });
}

// ------------------------------------------------------------------ compilaciones

export interface BuildOpts {
  versionOverride?: string;
  envOverride?: { name: string; value: string }[];
  buildspecOverride?: string;
  initiator: string;
  /** Fuente suministrada por CodePipeline. */
  input?: { files: Record<string, string>; commitId?: string };
  pipelineExecutionId?: string;
}

function loadSource(s: CloudState, proj: CbProject, role: IamRole | undefined, versionOverride?: string): { files: Record<string, string> | { error: string }; resolved?: string; version?: string } {
  const version = versionOverride ?? proj.sourceVersion;
  const t = proj.source.type;
  if (t === 'NO_SOURCE') return { files: {} };
  if (t === 'CODECOMMIT') {
    const m = /\/v1\/repos\/([^/?#]+)/.exec(proj.source.location ?? '');
    const name = m?.[1] ?? (proj.source.location ?? '').split('/').pop()!;
    const repo = cicd(s).repos.find((r) => r.name === name && r.region === proj.region);
    if (!repo) return { files: { error: `repository not found for primary source and source version ${version ?? 'refs/heads/main'}` }, version };
    const denial = role ? roleDenial(s, role, 'AWSCodeBuild', 'codecommit:GitPull', repo.arn) : null;
    if (denial) return { files: { error: `Git clone failed: Unable to access '${proj.source.location}': The requested URL returned error: 403` }, version };
    const spec = (version ?? repo.defaultBranch ?? '').replace(/^refs\/heads\//, '');
    const id = repo.branches[spec] ?? (repo.objs.commits[spec] ? spec : Object.keys(repo.objs.commits).find((k) => spec.length >= 7 && k.startsWith(spec)));
    if (!id) return { files: { error: `reference not found for primary source and source version ${version ?? spec}` }, version };
    return { files: filesOf(repo.objs, id), resolved: id, version };
  }
  if (t === 'S3') {
    const loc = (proj.source.location ?? '').replace(/^arn:aws:s3:::/, '');
    const bucket = loc.split('/')[0], key = loc.split('/').slice(1).join('/');
    const o = s.buckets.find((b) => b.name === bucket)?.objects[key];
    if (!o) return { files: { error: `The specified key does not exist: ${loc}` }, version };
    const denial = role ? roleDenial(s, role, 'AWSCodeBuild', 's3:GetObject', `arn:aws:s3:::${loc}`) : null;
    if (denial) return { files: { error: 'AccessDenied: Access Denied' }, version };
    return { files: unpackBundle(o.body) ?? { [key.split('/').pop()!]: o.body }, version };
  }
  return { files: { error: `Source type ${t} is not supported in the simulator` }, version };
}

export function createBuild(s: CloudState, proj: CbProject, o: BuildOpts): CbBuild {
  const c = cicd(s);
  const number = (c.buildSeq[proj.name] = (c.buildSeq[proj.name] ?? 0) + 1);
  const uuid = guid();
  const id = `${proj.name}:${uuid}`;
  const t0 = now();
  const role = roleByArn(s, proj.serviceRole);
  const src = o.input ? { files: o.input.files, resolved: o.input.commitId, version: o.input.commitId } : loadSource(s, proj, role, o.versionOverride);
  // buildspec
  let specText: string | { error: string };
  const inline = o.buildspecOverride ?? proj.source.buildspec;
  const files = 'error' in src.files ? {} : src.files;
  if (inline && /\n|^version\s*:/.test(inline)) specText = inline;
  else {
    const path = (inline ?? 'buildspec.yml').replace(/^\.\//, '');
    specText = files[path] ?? { error: `YAML_FILE_ERROR: stat /codebuild/output/src${100000000 + number * 7919}/src/${path}: no such file or directory` };
  }
  const sim = simulate(s, proj, role, { t0, number, id, version: src.version, resolved: src.resolved }, src.files, specText, o.envOverride ?? []);
  const logGroup = proj.logsConfig.cloudWatchLogs.groupName ?? `/aws/codebuild/${proj.name}`;
  const b: CbBuild = {
    id, arn: `arn:aws:codebuild:${proj.region}:${s.account.id}:build/${id}`, region: proj.region, buildNumber: number, projectName: proj.name, startTime: t0,
    sourceVersion: src.version, resolvedSourceVersion: src.resolved, phases: [], plan: sim.phases, initiator: o.initiator, logGroup: proj.logsConfig.cloudWatchLogs.status === 'ENABLED' ? logGroup : undefined, logStream: uuid,
    serviceRole: proj.serviceRole, finalStatus: sim.status, completeAt: t0 + scaled(sim.totalSim * REAL_MS_PER_SIM_S), buildStatus: 'IN_PROGRESS', environment: proj.environment, source: proj.source,
    artifacts: sim.artifactLocation ? { location: sim.artifactLocation } : proj.artifacts.type === 'NO_ARTIFACTS' ? null : { location: sim.artifactLocation }, logPlan: sim.logs, logFlushed: 0,
    outFiles: proj.artifacts.type === 'CODEPIPELINE' ? sim.outFiles : undefined, pipelineExecutionId: o.pipelineExecutionId,
  };
  c.builds.push(b);
  if (b.logGroup && !s.logGroups.some((g) => g.name === b.logGroup && g.region === b.region)) writeLog(s, b.region, b.logGroup, b.logStream, []);
  else if (b.logGroup) writeLog(s, b.region, b.logGroup, b.logStream, []);
  settleBuilds(s);
  return b;
}

/** Publica el avance de las compilaciones según el reloj: registros, fases y estado final. */
export function settleBuilds(s: CloudState): void {
  const t = now();
  for (const b of cicd(s).builds) {
    if (b.logPlan.length && b.logGroup) {
      const due = b.logPlan.slice(b.logFlushed).filter((l) => l.ts <= t || t >= b.completeAt);
      if (due.length) { writeLog(s, b.region, b.logGroup, b.logStream, due); b.logFlushed += due.length; }
    }
    if (b.buildStatus !== 'IN_PROGRESS') continue;
    if (t >= b.completeAt) {
      b.buildStatus = b.finalStatus;
      b.endTime = b.completeAt;
      b.phases = b.plan;
      if (b.logFlushed >= b.logPlan.length) b.logPlan = [];
    }
  }
}

/** Fases visibles ahora: las que ya empezaron, con la última sin estado si sigue en curso. */
export function visiblePhases(b: CbBuild, t = now()): CbPhase[] {
  if (b.buildStatus !== 'IN_PROGRESS') return b.plan;
  return b.plan.filter((p) => p.startTime <= t).map((p) => (p.endTime !== undefined && p.endTime <= t ? p : { ...p, phaseStatus: undefined, endTime: undefined, durationInSeconds: undefined }));
}
export const currentPhase = (b: CbBuild) => (b.buildStatus === 'IN_PROGRESS' ? visiblePhases(b).slice(-1)[0]?.phaseType ?? 'SUBMITTED' : 'COMPLETED');

function findBuild(ctx: Ctx, id: string): CbBuild {
  settleBuilds(ctx.s);
  const b = cicd(ctx.s).builds.find((x) => x.id === id && x.region === ctx.region);
  if (!b) throw new AwsError('ResourceNotFoundException', `Build cannot be found: arn:aws:codebuild:${ctx.region}:${ctx.s.account.id}:build/${id}`, 400);
  return b;
}

export function startBuild(ctx: Ctx, p: { ProjectName: string; SourceVersion?: string; EnvironmentVariablesOverride?: { name: string; value: string }[]; BuildspecOverride?: string }): CbBuild {
  return trailed(ctx, SRC, 'StartBuild', [{ type: 'AWS::CodeBuild::Project', name: p.ProjectName }], { projectName: p.ProjectName, sourceVersion: p.SourceVersion }, () => {
    authorize(ctx, 'codebuild:StartBuild', projectArn(ctx, p.ProjectName));
    const proj = getProject(ctx, p.ProjectName);
    if (proj.source.type === 'CODEPIPELINE' && !p.SourceVersion) { /* se puede lanzar a mano, pero sin artefacto de entrada */ }
    return createBuild(ctx.s, proj, { versionOverride: p.SourceVersion, envOverride: p.EnvironmentVariablesOverride, buildspecOverride: p.BuildspecOverride, initiator: ctx.caller.type === 'AssumedRole' ? ctx.caller.sessionName ?? ctx.caller.userName : ctx.caller.userName });
  });
}

export function batchGetBuilds(ctx: Ctx, p: { Ids: string[] }): { builds: CbBuild[]; notFound: string[] } {
  return trailed(ctx, SRC, 'BatchGetBuilds', [], { ids: p.Ids }, () => {
    settleBuilds(ctx.s);
    const builds: CbBuild[] = [], notFound: string[] = [];
    for (const id of p.Ids ?? []) {
      const b = cicd(ctx.s).builds.find((x) => x.id === id && x.region === ctx.region);
      if (b) { authorize(ctx, 'codebuild:BatchGetBuilds', projectArn(ctx, b.projectName)); builds.push(b); } else notFound.push(id);
    }
    return { builds, notFound };
  });
}

export function listBuilds(ctx: Ctx, p: { ProjectName?: string; SortOrder?: string }): string[] {
  return trailed(ctx, SRC, p.ProjectName ? 'ListBuildsForProject' : 'ListBuilds', [], p, () => {
    authorize(ctx, p.ProjectName ? 'codebuild:ListBuildsForProject' : 'codebuild:ListBuilds', p.ProjectName ? projectArn(ctx, p.ProjectName) : '*');
    if (p.ProjectName) getProject(ctx, p.ProjectName);
    settleBuilds(ctx.s);
    const l = cicd(ctx.s).builds.filter((b) => b.region === ctx.region && (!p.ProjectName || b.projectName === p.ProjectName)).sort((a, b) => b.startTime - a.startTime || b.buildNumber - a.buildNumber);
    return (p.SortOrder === 'ASCENDING' ? l.reverse() : l).map((b) => b.id);
  });
}

export function stopBuild(ctx: Ctx, p: { Id: string }): CbBuild {
  return trailed(ctx, SRC, 'StopBuild', [], { id: p.Id }, () => {
    const b = findBuild(ctx, p.Id);
    authorize(ctx, 'codebuild:StopBuild', projectArn(ctx, b.projectName));
    if (b.buildStatus === 'IN_PROGRESS') {
      b.buildStatus = 'STOPPED';
      b.endTime = now();
      b.phases = visiblePhases(b).map((x) => (x.phaseStatus ? x : { ...x, phaseStatus: 'STOPPED', endTime: now(), durationInSeconds: 0 }));
      b.plan = b.phases;
      b.logPlan = [];
    }
    return b;
  });
}

/** Lectura de la consola (sin evento de CloudTrail). */
export const buildsOf = (s: CloudState, name?: string): CbBuild[] => (settleBuilds(s), cicd(s).builds.filter((b) => !name || b.projectName === name).sort((a, b) => b.buildNumber - a.buildNumber));

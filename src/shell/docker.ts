// Comando `docker` simulado: login (ECR), build desde un Dockerfile, tag, push, pull, images, run, ps, stop, rm, rmi, logs.
import { registerCommand, ok, fail, type CmdResult, type Shell } from './interp';
import { VFS } from './fs';
import { now, hex } from '../engine/util';
import { AwsError } from '../engine/errors';
import { authorize } from '../engine/api';
import * as ecr from '../engine/services/ecr';
import { webHooks, type WebResult } from '../engine/services/web';
import { cs, ecrHost, parseRef, resolveImage, sha, simulateRun, webBody, defaultMeta, type DockerContainer, type ImageMeta, type LocalImage } from '../engine/services/containerCore';

const NAMES = [['quirky', 'turing'], ['brave', 'hopper'], ['calm', 'lovelace'], ['eager', 'ritchie'], ['happy', 'knuth'], ['jolly', 'torvalds'], ['keen', 'wozniak'], ['nifty', 'thompson']];
const ago = (ms: number) => { const s = Math.max(0, Math.round((now() - ms) / 1000)); if (s < 60) return s <= 1 ? 'Less than a second ago' : `${s} seconds ago`; if (s < 3600) return `${Math.floor(s / 60)} minutes ago`; if (s < 86400) return `${Math.floor(s / 3600)} hours ago`; return `${Math.floor(s / 86400)} days ago`; };
const size = (b: number) => (b >= 1e9 ? (b / 1e9).toFixed(2) + 'GB' : b >= 1e6 ? (b / 1e6).toFixed(1).replace(/\.0$/, '') + 'MB' : (b / 1e3).toFixed(1) + 'kB');
const pad = (rows: string[][]) => { const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length))); return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i] + 3))).join('')).join('\n') + '\n'; };
const D = (s: Shell) => cs(s.s).docker;
const normName = (ref: string) => { const r = parseRef(ref); const repo = r.registry === 'docker.io' ? r.repo.replace(/^library\//, '') : `${r.registry}/${r.repo}`; return `${repo}:${r.tag}`; };
const findLocal = (s: Shell, ref: string) => { const n = normName(ref); return D(s).images.find((i) => i.refs.includes(n) || i.id.replace('sha256:', '').startsWith(ref.replace('sha256:', ''))); };

function addLocal(s: Shell, ref: string, id: string, meta: ImageMeta, history: string[]): LocalImage {
  const n = normName(ref);
  const d = D(s);
  for (const i of d.images) i.refs = i.refs.filter((r) => r !== n);
  let img = d.images.find((i) => i.id === id);
  if (!img) { img = { id, refs: [], created: now(), meta, history }; d.images.push(img); }
  if (!img.refs.includes(n)) img.refs.push(n);
  d.images = d.images.filter((i) => i.refs.length || d.containers.some((c) => c.imageId === i.id));
  return img;
}

// ------------------------------------------------------------------ build

function build(sh: Shell, args: string[]): CmdResult {
  let file: string | undefined; const tags: string[] = []; const buildArgs: Record<string, string> = {}; let ctxDir = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-t' || a === '--tag') tags.push(args[++i]); else if (a.startsWith('--tag=')) tags.push(a.slice(6));
    else if (a === '-f' || a === '--file') file = args[++i];
    else if (a === '--build-arg') { const [k, ...v] = args[++i].split('='); buildArgs[k] = v.join('='); }
    else if (a.startsWith('-')) { if (['--platform', '--target', '--progress'].includes(a)) i++; } else ctxDir = a;
  }
  if (!ctxDir) return fail('ERROR: "docker buildx build" requires exactly 1 argument.\nSee \'docker buildx build --help\'.\n\nUsage:  docker buildx build [OPTIONS] PATH | URL | -\n\nStart a build', 1);
  const root = VFS.norm(ctxDir, sh.cwd);
  const df = file ? VFS.norm(file, sh.cwd) : root + '/Dockerfile';
  const t0 = now();
  if (!sh.fs.isDir(root)) return fail(`ERROR: failed to solve: failed to read dockerfile: open ${root}: no such file or directory`);
  if (!sh.fs.isFile(df)) return fail(`ERROR: failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory`);
  const lines: string[] = [];
  let cur = '';
  for (const l of sh.fs.readFile(df).split('\n')) { const t = l.trim(); if (!t || t.startsWith('#')) continue; if (t.endsWith('\\')) { cur += t.slice(0, -1) + ' '; continue; } lines.push(cur + t); cur = ''; }
  const out: string[] = ['#0 building with "default" instance using docker driver', '', '#1 [internal] load build definition from Dockerfile', '#1 transferring dockerfile: ' + (sh.fs.readFile(df).length) + 'B done', '#1 DONE 0.0s', ''];
  let meta: ImageMeta | undefined; let baseRef = ''; const hist: string[] = []; let key = ''; let copied = 0; const env: Record<string, string> = {}; let docroot = ''; let body: string | undefined; let step = 0;
  const total = lines.filter((l) => /^(FROM|RUN|COPY|ADD|WORKDIR)\b/i.test(l)).length;
  const fatal = (m: string) => fail(out.join('\n') + `\nERROR: failed to solve: ${m}`);
  for (let n = 0; n < lines.length; n++) {
    const m = /^(\w+)\s+(.*)$/.exec(lines[n]);
    const ins = (m?.[1] ?? lines[n]).toUpperCase();
    const rest = (m?.[2] ?? '').replace(/\$\{?(\w+)\}?/g, (_x, k) => buildArgs[k] ?? env[k] ?? '');
    if (!['FROM', 'RUN', 'COPY', 'ADD', 'WORKDIR', 'ENV', 'EXPOSE', 'CMD', 'ENTRYPOINT', 'USER', 'ARG', 'LABEL', 'HEALTHCHECK', 'VOLUME', 'SHELL', 'STOPSIGNAL', 'ONBUILD', 'MAINTAINER'].includes(ins)) return fatal(`dockerfile parse error on line ${n + 1}: unknown instruction: ${ins.toLowerCase()}`.replace('ERROR: ', ''));
    if (ins !== 'FROM' && !meta && ins !== 'ARG') return fatal(`dockerfile parse error on line ${n + 1}: no build stage in current context`);
    const label = () => `#${2 + step} [${Math.min(step + 1, total)}/${total}] ${lines[n]}`;
    if (ins === 'FROM') {
      const ref = rest.split(/\s+/).filter((x) => !x.startsWith('--'))[0];
      const r = resolveImage(sh.s, ref);
      if (!r.ok) { const pr = parseRef(ref); return fatal(r.reason === 'Unknown' ? `${ref}: failed to resolve source metadata for ${pr.registry}/${pr.repo}:${pr.tag}: pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed` : `${ref}: failed to resolve source metadata for ${pr.registry}/${pr.repo}:${pr.tag}: ${pr.registry}/${pr.repo}:${pr.tag}: not found`); }
      baseRef = ref; meta = { ...r.meta, env: { ...r.meta.env }, exposed: [...r.meta.exposed], logs: [...r.meta.logs] }; key = r.digest; copied = 0; docroot = r.meta.baseRef.startsWith('nginx') ? '/usr/share/nginx/html' : r.meta.baseRef.startsWith('httpd') ? '/usr/local/apache2/htdocs' : '';
      body = undefined;
      out.push(`#${2 + step} [internal] load metadata for docker.io/library/${ref.replace(/^library\//, '')}`, `#${2 + step} DONE 0.4s`, '');
      step++; continue;
    }
    key += '|' + lines[n];
    if (ins === 'COPY' || ins === 'ADD') {
      const parts = rest.split(/\s+/).filter((x) => !x.startsWith('--'));
      const dest = parts.pop()!;
      if (rest.includes('--from=')) { step++; continue; }
      for (const src of parts) {
        const p = VFS.norm(src, root);
        const globbed = /[*?]/.test(src) ? sh.fs.glob(src, root) : [];
        if (!sh.fs.exists(p) && !globbed.length) { out.push(label(), `#${2 + step} ERROR: failed to calculate checksum of ref: "/${src.replace(/^\.?\//, '')}": not found`); return fail(out.join('\n') + `\n------\n > [${step}/${total}] ${lines[n]}:\n------\nERROR: failed to solve: failed to compute cache key: failed to calculate checksum of ref ${hex(8)}::${hex(24)}: "/${src.replace(/^\.?\//, '')}": not found`); }
        if (sh.fs.isFile(p)) { const c = sh.fs.readFile(p); copied += c.length; key += sha(c); const d = dest.endsWith('/') ? dest + src.split('/').pop() : dest; if (docroot && (d === docroot + '/index.html' || (dest.replace(/\/$/, '') === docroot && src.endsWith('index.html')))) body = c; else if (!docroot && /index\.html$/.test(src)) body = c; }
      }
      if (docroot && parts.some((x) => x === '.' || x === './' ) && sh.fs.isFile(root + '/index.html') && dest.replace(/\/$/, '') === docroot) body = sh.fs.readFile(root + '/index.html');
    } else if (ins === 'ENV') { for (const kv of rest.split(/\s+/)) { const [k, ...v] = kv.split('='); if (v.length) { meta!.env[k] = v.join('='); env[k] = v.join('='); } } }
    else if (ins === 'ARG') { const [k, v] = rest.split('='); if (v !== undefined) buildArgs[k] ??= v; }
    else if (ins === 'EXPOSE') { for (const p of rest.split(/\s+/)) { const port = parseInt(p, 10); if (port) meta!.exposed.push(port); } }
    else if (ins === 'WORKDIR') meta!.workdir = rest;
    else if (ins === 'USER') meta!.user = rest;
    else if (ins === 'CMD' || ins === 'ENTRYPOINT') {
      let v: string[]; try { const j = JSON.parse(rest); v = Array.isArray(j) ? j.map(String) : [String(j)]; } catch { v = ['/bin/sh', '-c', rest]; }
      if (ins === 'CMD') meta!.cmd = v; else { meta!.entrypoint = v; meta!.cmd = undefined; }
    }
    if (/^(FROM|RUN|COPY|ADD|WORKDIR)$/.test(ins)) { out.push(label(), `#${2 + step} DONE 0.${1 + (n % 8)}s`, ''); step++; }
  }
  if (!meta) return fatal('dockerfile parse error on line 1: file with no instructions');
  // El proceso principal: ¿se queda vivo?
  const run = simulateRun({ ...meta, resident: meta.resident || meta.exposed.length > 0 }, {});
  meta.resident = run.resident || (!!(meta.cmd ?? meta.entrypoint)?.length && !meta.web && meta.exposed.length > 0);
  if (body === undefined && !meta.web && meta.exposed.length && meta.resident) body = `Hola desde ${tags[0] ?? 'la aplicación'}\n`;
  if (body !== undefined) meta.web = { port: meta.web?.port ?? meta.exposed[0] ?? 80, body, server: meta.web?.server ?? 'app' };
  if (meta.web && meta.exposed.length && !meta.exposed.includes(meta.web.port)) meta.web.port = meta.exposed[0];
  meta.baseRef = baseRef; meta.sizeBytes += copied + 1200; meta.layers += step;
  const id = 'sha256:' + sha(key + JSON.stringify(meta.cmd) + JSON.stringify(meta.exposed));
  const cached = D(sh).images.some((i) => i.id === id);
  for (const t of tags.length ? tags : []) addLocal(sh, t, id, meta, hist);
  if (!tags.length) D(sh).images.push({ id, refs: [], created: now(), meta, history: hist });
  const secs = ((now() - t0) / 1000 + 1.2).toFixed(1);
  out.push(`#${2 + step} exporting to image`, `#${2 + step} exporting layers 0.1s done`, `#${2 + step} writing image ${id} done`, ...tags.map((t) => `#${2 + step} naming to docker.io/library/${normName(t)} done`.replace('docker.io/library/', t.includes('/') ? '' : 'docker.io/library/')), `#${2 + step} DONE 0.1s`);
  return { out: '', err: `[+] Building ${secs}s (${step + 4}/${step + 4}) FINISHED${cached ? ' (CACHED)' : ''}                                    docker:default\n${out.filter((l) => l.startsWith('#') || !l).join('\n')}\n`, code: 0 };
}

// ------------------------------------------------------------------ comandos

function login(sh: Shell, args: string[], stdin: string): CmdResult {
  let user = '', pass: string | undefined; let host = ''; let fromStdin = false;
  for (let i = 0; i < args.length; i++) { const a = args[i]; if (a === '-u' || a === '--username') user = args[++i]; else if (a === '-p' || a === '--password') pass = args[++i]; else if (a === '--password-stdin') fromStdin = true; else if (!a.startsWith('-')) host = a; }
  if (fromStdin) pass = stdin.replace(/\n$/, '');
  if (!host) host = 'https://index.docker.io/v1/';
  if (!user) return fail('Error: Cannot perform an interactive login from a non TTY device');
  if (pass === undefined || pass === '') return fail(fromStdin ? 'Error: Password Required' : 'Error: Cannot perform an interactive login from a non TTY device');
  const h = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (/\.dkr\.ecr\./.test(h)) {
    const v = ecr.verifyToken(sh.s, pass);
    if (user !== 'AWS' || v === 'invalid') return fail(`Error response from daemon: login attempt to https://${h}/v2/ failed with status: 400 Bad Request`);
    if (v === 'expired') return fail(`Error response from daemon: Get "https://${h}/v2/": denied: Your authorization token has expired. Reauthenticate and try again.`);
    D(sh).logins[h] = { user, at: now(), token: pass };
  } else D(sh).logins[h] = { user, at: now() };
  return { out: 'Login Succeeded\n', err: fromStdin || pass ? 'WARNING! Your password will be stored unencrypted in /root/.docker/config.json.\nConfigure a credential helper to remove this warning. See\nhttps://docs.docker.com/go/credential-store/\n\n' : '', code: 0 };
}

function push(sh: Shell, ref: string): CmdResult {
  if (!ref) return fail('"docker push" requires exactly 1 argument.\nSee \'docker push --help\'.\n\nUsage:  docker push [OPTIONS] NAME[:TAG]\n\nUpload an image to a registry');
  const r = parseRef(ref);
  const img = findLocal(sh, ref);
  const head = `The push refers to repository [${r.registry}/${r.repo}]\n`;
  if (!img) return fail(`The push refers to repository [${r.registry}/${r.repo}]\nAn image does not exist locally with the tag: ${r.registry}/${r.repo}`);
  const m = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com$/.exec(r.registry);
  const layers = Array.from({ length: Math.min(img.meta.layers, 6) }, (_, i) => sha(img.id + i).slice(0, 12));
  const lay = (verb: string) => layers.map((l) => `${l}: ${verb}`).join('\n') + '\n';
  if (!m) return { out: head + lay('Preparing'), err: `denied: requested access to the resource is denied`, code: 1 };
  const login = D(sh).logins[r.registry];
  if (!login?.token) return { out: head + lay('Preparing'), err: 'no basic auth credentials\n', code: 1 };
  const v = ecr.verifyToken(sh.s, login.token);
  if (v === 'expired' || v === 'invalid') return { out: head + lay('Preparing'), err: 'denied: Your authorization token has expired. Reauthenticate and try again.\n', code: 1 };
  const ctx = { s: sh.s, caller: v.caller, region: m[2] };
  try {
    const repoArn = `arn:aws:ecr:${m[2]}:${m[1]}:repository/${r.repo}`;
    authorize(ctx, 'ecr:InitiateLayerUpload', repoArn);
    const repo = sh.s.containers && cs(sh.s).ecr.find((x) => x.name === r.repo && x.region === m[2]);
    if (!repo) return { out: head + lay('Preparing'), err: `name unknown: The repository with name '${r.repo}' does not exist in the registry with id '${m[1]}'\n`, code: 1 };
    const digest = 'sha256:' + sha('manifest' + img.id);
    ecr.putImage(ctx, { RepositoryName: r.repo, Tag: r.tag, Digest: digest, Meta: img.meta, SizeBytes: img.meta.sizeBytes });
    return ok(head + lay('Pushed') + `${r.tag}: digest: ${digest} size: 1570\n`);
  } catch (e) {
    if (e instanceof AwsError) {
      const msg = e.message.replace(/resource: "([^"]*)"/, 'resource: $1');
      return { out: head + lay('Preparing'), err: (e.code === 'ImageTagAlreadyExistsException' ? 'tag invalid: ' : 'denied: ') + msg + '\n', code: 1 };
    }
    throw e;
  }
}

function pull(sh: Shell, ref: string): CmdResult {
  const r = parseRef(ref);
  const m = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com$/.exec(r.registry);
  if (m) {
    const lg = D(sh).logins[r.registry];
    if (!lg?.token || typeof ecr.verifyToken(sh.s, lg.token) === 'string') return fail(`Error response from daemon: Head "https://${r.registry}/v2/${r.repo}/manifests/${r.tag}": no basic auth credentials`);
  }
  const res = resolveImage(sh.s, ref, true);
  if (!res.ok) {
    if (res.reason === 'RepositoryNotFound') return fail(`Error response from daemon: name unknown: ${res.detail}`.replace('name unknown: ', 'pull access denied for ' + r.repo + ', repository does not exist or may require authorization: name unknown: '));
    if (res.reason === 'TagNotFound') return fail(`Error response from daemon: manifest for ${r.registry}/${r.repo}:${r.tag} not found: manifest unknown: Requested image not found`);
    if (res.reason === 'NotFound') return fail(`Error response from daemon: manifest for ${normName(ref)} not found: manifest unknown: manifest unknown`);
    return fail(`Error response from daemon: ${res.detail}`);
  }
  const id = 'sha256:' + sha('id' + res.digest);
  const had = !!findLocal(sh, ref) && findLocal(sh, ref)!.id === id;
  addLocal(sh, ref, id, res.meta, []);
  const full = `${r.registry}/${r.repo}:${r.tag}`;
  const layerLines = Array.from({ length: Math.min(res.meta.layers, 5) }, (_, i) => `${sha(res.digest + i).slice(0, 12)}: Pull complete`).join('\n');
  return ok(`${r.tag}: Pulling from ${r.repo}\n${layerLines}\nDigest: ${res.digest}\nStatus: ${had ? 'Image is up to date for' : 'Downloaded newer image for'} ${normName(ref)}\n${full}\n`);
}

function containerOf(sh: Shell, ref: string) { return D(sh).containers.find((c) => c.name === ref || c.id.startsWith(ref)); }
function refresh(sh: Shell) { for (const c of D(sh).containers) void c; }

function run(sh: Shell, args: string[]): CmdResult {
  const ports: { host: number; container: number }[] = []; const env: Record<string, string> = {}; let name = ''; let detach = false; let rm = false; let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '-d' || a === '--detach') detach = true; else if (a === '--rm') rm = true; else if (a === '-it' || a === '-i' || a === '-t') continue;
    else if (a === '-p' || a === '--publish') { const [h, c] = args[++i].split(':').slice(-2); ports.push({ host: Number(h), container: Number(String(c).replace(/\/.*/, '')) }); }
    else if (a === '--name') name = args[++i]; else if (a === '-e' || a === '--env') { const [k, ...v] = args[++i].split('='); env[k] = v.join('='); }
    else if (a.startsWith('--name=')) name = a.slice(7); else if (a.startsWith('-')) { if (['-v', '--volume', '-w', '--workdir', '--network', '--restart', '-m', '--memory', '--entrypoint'].includes(a)) i++; } else break;
  }
  const ref = args[i];
  if (!ref) return fail('docker: "run" requires at least 1 argument.\nSee \'docker run --help\'.\n\nUsage:  docker run [OPTIONS] IMAGE [COMMAND] [ARG...]\n\nCreate and run a new container from an image');
  const cmd = args.slice(i + 1);
  let pre = '';
  let img = findLocal(sh, ref);
  if (!img) {
    const pr = parseRef(ref);
    if (/\.dkr\.ecr\./.test(pr.registry)) { const p = pull(sh, ref); if (p.code) return p; }
    else { const res = resolveImage(sh.s, ref); if (!res.ok) return fail(`Unable to find image '${normName(ref)}' locally\ndocker: Error response from daemon: ${res.reason === 'Unknown' ? res.detail : `manifest for ${normName(ref)} not found: manifest unknown: manifest unknown`}.\nSee 'docker run --help'.`, 125); const p = pull(sh, ref); pre = `Unable to find image '${normName(ref)}' locally\n` + p.out; }
    img = findLocal(sh, ref)!;
  }
  const d = D(sh);
  for (const p of ports) { const used = d.containers.find((c) => c.status === 'running' && c.ports.some((x) => x.host === p.host)); if (used) return fail(`docker: Error response from daemon: driver failed programming external connectivity on endpoint ${name || 'container'}: Bind for 0.0.0.0:${p.host} failed: port is already allocated.`, 125); }
  if (name && d.containers.some((c) => c.name === name)) return fail(`docker: Error response from daemon: Conflict. The container name "/${name}" is already in use by container "${d.containers.find((c) => c.name === name)!.id}". You have to remove (or rename) that container to be able to reuse that name.`, 125);
  const [adj, nm] = NAMES[Math.floor(Math.random() * NAMES.length)];
  const id = hex(64);
  const res = simulateRun(img.meta, { command: cmd.length ? cmd : undefined, env, host: id.slice(0, 12) });
  if (res.execError) return fail(`docker: Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: ${res.execError}: unknown.`, 127);
  const c: DockerContainer = { id, name: name || `${adj}_${nm}`, imageRef: normName(ref), imageId: img.id, command: (cmd.length ? cmd : img.meta.entrypoint ?? img.meta.cmd ?? ['sh']).join(' '), created: now(), status: res.resident ? 'running' : 'exited', exitCode: res.exitCode, startedAt: now(), finishedAt: res.resident ? undefined : now(), ports, env, logs: res.lines, meta: img.meta };
  if (!(rm && !res.resident)) d.containers.push(c);
  if (detach) return ok(pre + id + '\n');
  return { out: pre + (res.resident ? res.lines.join('\n') + (res.lines.length ? '\n' : '') : res.lines.join('\n') + (res.lines.length ? '\n' : '')), err: '', code: res.exitCode };
}

function ps(sh: Shell, args: string[]): CmdResult {
  const all = args.some((a) => a === '-a' || a === '--all'); const q = args.includes('-q');
  const list = D(sh).containers.filter((c) => all || c.status === 'running').sort((a, b) => b.created - a.created);
  if (q) return ok(list.map((c) => c.id.slice(0, 12)).join('\n') + (list.length ? '\n' : ''));
  const rows = [['CONTAINER ID', 'IMAGE', 'COMMAND', 'CREATED', 'STATUS', 'PORTS', 'NAMES'], ...list.map((c) => [c.id.slice(0, 12), c.imageRef.replace(/:latest$/, '') === c.imageRef ? c.imageRef : c.imageRef.replace(/:latest$/, ''), `"${c.command.length > 18 ? c.command.slice(0, 17) + '…' : c.command}"`, ago(c.created), c.status === 'running' ? `Up ${ago(c.startedAt).replace(' ago', '')}` : `Exited (${c.exitCode}) ${ago(c.finishedAt ?? c.startedAt)}`, c.ports.map((p) => `0.0.0.0:${p.host}->${p.container}/tcp`).join(', '), c.name])];
  return ok(pad(rows));
}

function images(sh: Shell, args: string[]): CmdResult {
  const q = args.includes('-q');
  const rows: string[][] = [];
  for (const i of [...D(sh).images].sort((a, b) => b.created - a.created)) for (const r of i.refs.length ? i.refs : ['<none>:<none>']) { const k = r.lastIndexOf(':'); rows.push([r.slice(0, k), r.slice(k + 1), i.id.slice(7, 19), ago(i.created), size(i.meta.sizeBytes)]); }
  if (q) return ok(rows.map((r) => r[2]).join('\n') + (rows.length ? '\n' : ''));
  return ok(pad([['REPOSITORY', 'TAG', 'IMAGE ID', 'CREATED', 'SIZE'], ...rows]));
}

registerCommand('docker', (args, { sh, stdin }) => {
  const [sub, ...rest] = args;
  if (!sub || sub === '--help') return ok('Usage:  docker [OPTIONS] COMMAND\n\nCommands:\n  build   Build an image from a Dockerfile\n  images  List images\n  login   Authenticate to a registry\n  logs    Fetch the logs of a container\n  ps      List containers\n  pull    Download an image from a registry\n  push    Upload an image to a registry\n  rm      Remove one or more containers\n  rmi     Remove one or more images\n  run     Create and run a new container from an image\n  stop    Stop one or more running containers\n  tag     Create a tag TARGET_IMAGE that refers to SOURCE_IMAGE\n');
  if (sub === '--version' || sub === '-v') return ok('Docker version 27.3.1, build ce12230\n');
  if (sub === 'version') return ok('Client:\n Version:           27.3.1\n API version:       1.47\n Go version:       go1.22.7\n OS/Arch:          linux/amd64\n');
  refresh(sh);
  switch (sub) {
    case 'login': return login(sh, rest, stdin);
    case 'logout': { const h = rest[0]?.replace(/^https?:\/\//, '') ?? 'https://index.docker.io/v1/'; delete D(sh).logins[h]; return ok(`Removing login credentials for ${h}\n`); }
    case 'build': return build(sh, rest);
    case 'tag': { const [src, dst] = rest; if (!src || !dst) return fail('"docker tag" requires exactly 2 arguments.\nSee \'docker tag --help\'.\n\nUsage:  docker tag SOURCE_IMAGE[:TAG] TARGET_IMAGE[:TAG]\n\nCreate a tag TARGET_IMAGE that refers to SOURCE_IMAGE'); const i = findLocal(sh, src); if (!i) return fail(`Error response from daemon: No such image: ${src}`); addLocal(sh, dst, i.id, i.meta, i.history); return ok(); }
    case 'push': return push(sh, rest[0]);
    case 'pull': return pull(sh, rest[0]);
    case 'images': case 'image': return images(sh, sub === 'image' ? rest.slice(1) : rest);
    case 'run': return run(sh, rest);
    case 'ps': return ps(sh, rest);
    case 'stop': case 'kill': { const out: string[] = []; for (const n of rest) { const c = containerOf(sh, n); if (!c) return fail(`Error response from daemon: No such container: ${n}`); c.status = 'exited'; c.exitCode = 0; c.finishedAt = now(); out.push(n); } return ok(out.join('\n') + '\n'); }
    case 'rm': { const force = rest.includes('-f'); const out: string[] = []; for (const n of rest.filter((x) => !x.startsWith('-'))) { const c = containerOf(sh, n); if (!c) return fail(`Error response from daemon: No such container: ${n}`); if (c.status === 'running' && !force) return fail(`Error response from daemon: cannot remove container "/${c.name}": container is running: stop the container before removing or force remove`); D(sh).containers = D(sh).containers.filter((x) => x !== c); out.push(n); } return ok(out.join('\n') + '\n'); }
    case 'rmi': { const out: string[] = []; for (const n of rest.filter((x) => !x.startsWith('-'))) { const i = findLocal(sh, n); if (!i) return fail(`Error: No such image: ${n}`); if (D(sh).containers.some((c) => c.imageId === i.id) && !rest.includes('-f')) return fail(`Error response from daemon: conflict: unable to remove repository reference "${n}" (must force) - container ${D(sh).containers.find((c) => c.imageId === i.id)!.id.slice(0, 12)} is using its referenced image ${i.id.slice(7, 19)}`); const nn = normName(n); if (i.refs.includes(nn) && i.refs.length > 1) { i.refs = i.refs.filter((r) => r !== nn); out.push(`Untagged: ${nn}`); } else { D(sh).images = D(sh).images.filter((x) => x !== i); out.push(`Untagged: ${nn}`, `Deleted: ${i.id}`); } } return ok(out.join('\n') + '\n'); }
    case 'logs': { const c = containerOf(sh, rest.filter((x) => !x.startsWith('-')).pop() ?? ''); if (!c) return fail(`Error response from daemon: No such container: ${rest[rest.length - 1] ?? ''}`); return ok(c.logs.join('\n') + (c.logs.length ? '\n' : '')); }
    default: return fail(`docker: '${sub}' is not a docker command.\nSee 'docker --help'`);
  }
});

// curl http://localhost:8080 → contenedor con ese puerto publicado
webHooks.push((s, host, port): WebResult | null => {
  if (host !== 'localhost' && host !== '127.0.0.1') return null;
  const c = s.containers?.docker.containers.find((x) => x.status === 'running' && x.ports.some((p) => p.host === port));
  if (!c) return { kind: 'refused', host, port };
  const p = c.ports.find((x) => x.host === port)!;
  const w = webBody(c.meta, c.id.slice(0, 12));
  if (!w || w.port !== p.container) return { kind: 'ok', status: 200, headers: {}, body: '' };
  return { kind: 'ok', status: 200, headers: { server: w.server, 'content-type': 'text/html' }, body: w.body };
});
void ecrHost; void defaultMeta;

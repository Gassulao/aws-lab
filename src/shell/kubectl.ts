// Comando `kubectl` simulado sobre el mini-motor de Kubernetes de EKS: get, describe, apply, create, run, expose, delete,
// scale, set image, rollout, logs, exec, config y version. Lee ~/.kube/config como el original.
import yaml from 'js-yaml';
import { registerCommand, ok, fail, type CmdResult, type Shell } from './interp';
import { VFS } from './fs';
import { buildCtx } from './aws/framework';
import { homeDir } from '../engine/store';
import { now } from '../engine/util';
import { cs, type EksCluster } from '../engine/services/containerCore';
import { settle } from '../engine/services/ec2';
import { kubeAuthorized } from '../engine/services/eks';
import * as K from '../engine/kube';
import type { KObj } from '../engine/kube';

const E = (m: string, code = 1): CmdResult => fail(m, code);

// ------------------------------------------------------------------ utilidades de salida

export function age(ms: number): string {
  const s = Math.max(0, Math.floor((now() - ms) / 1000));
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return s % 60 ? `${m}m${s % 60}s` : `${m}m`;
  if (m < 180) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 8) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
const table = (rows: string[][]) => { const w = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length))); return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : (c ?? '').padEnd(w[i] + 3))).join('')).join('\n') + '\n'; };
const kv = (rows: [string, string][]) => { const w = Math.max(...rows.map((r) => r[0].length)) + 2; return rows.map(([k, v]) => `${(k + ':').padEnd(w + 1)}${v}`).join('\n') + '\n'; };
const lab = (l?: Record<string, string>) => (l && Object.keys(l).length ? Object.entries(l).map(([k, v]) => `${k}=${v}`).join(',') : '<none>');
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
const rfc = (ms: number) => new Date(ms).toUTCString().replace('GMT', '+0000');

// ------------------------------------------------------------------ contexto

interface Ctx { c: EksCluster; ns: string }
function context(sh: Shell, nsFlag?: string): Ctx | CmdResult {
  const path = sh.vars.KUBECONFIG ?? sh.s.cli.env.KUBECONFIG ?? `${homeDir(sh.s)}/.kube/config`;
  const refused = E('The connection to the server localhost:8080 was refused - did you specify the right host or port?');
  if (!sh.fs.isFile(path)) return refused;
  let cfg: any;
  try { cfg = yaml.load(sh.fs.readFile(path)); } catch { return E('error: error loading config file: yaml: invalid'); }
  const cur = cfg?.['current-context'];
  const ctx = cfg?.contexts?.find((x: any) => x.name === cur)?.context;
  if (!cur || !ctx) return E('error: current-context is not set');
  const cl = cs(sh.s).eks.find((x) => x.arn === ctx.cluster);
  const server = cfg.clusters?.find((x: any) => x.name === ctx.cluster)?.cluster?.server ?? 'https://unknown';
  if (!cl) return E(`Unable to connect to the server: dial tcp: lookup ${server.replace('https://', '')}: no such host`);
  settle(sh.s);
  if (cl.status !== 'ACTIVE') return E(`Unable to connect to the server: dial tcp ${server.replace('https://', '')}:443: i/o timeout`);
  try { const { ctx: cc } = buildCtx(sh, {}); if (!kubeAuthorized(cl, cc.caller)) return E('error: You must be logged in to the server (Unauthorized)'); } catch { return E('error: You must be logged in to the server (Unauthorized)'); }
  K.reconcile(sh.s, cl);
  return { c: cl, ns: nsFlag ?? ctx.namespace ?? 'default' };
}
const isErr = (x: Ctx | CmdResult): x is CmdResult => 'code' in x;

// ------------------------------------------------------------------ análisis de argumentos

interface Opts { flags: Set<string>; vals: Record<string, string[]>; pos: string[]; rest: string[] }
const VAL = new Set(['n', 'namespace', 'o', 'output', 'l', 'selector', 'f', 'filename', 'replicas', 'image', 'tail', 'c', 'container', 'type', 'port', 'target-port', 'name', 'from-literal', 'restart', 'timeout', 'labels', 'to-revision', 'field-selector', 'sort-by', 'current', 'env', 'e', 'cluster']);
function parse(args: string[], valFlags = VAL, noVal: string[] = []): Opts {
  const o: Opts = { flags: new Set(), vals: {}, pos: [], rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { o.rest = args.slice(i + 1); break; }
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2)) {
      const raw = a.replace(/^-+/, '');
      const eq = raw.indexOf('=');
      const name = eq >= 0 ? raw.slice(0, eq) : raw;
      if (eq >= 0) (o.vals[name] ??= []).push(raw.slice(eq + 1));
      else if (valFlags.has(name) && !noVal.includes(name)) (o.vals[name] ??= []).push(args[++i] ?? '');
      else o.flags.add(name);
    } else if (/^-n\S+$/.test(a)) (o.vals.n ??= []).push(a.slice(2));
    else if (a.startsWith('-') && a.length > 2 && !a.startsWith('--')) for (const ch of a.slice(1)) o.flags.add(ch);
    else o.pos.push(a);
  }
  return o;
}
const val = (o: Opts, ...n: string[]) => n.map((k) => o.vals[k]?.[0]).find((v) => v !== undefined);
const nsOf = (o: Opts) => val(o, 'n', 'namespace');

// ------------------------------------------------------------------ vistas de objeto

const podReadyStr = (p: KObj) => `${p.status.ready ? p.spec.containers.length : 0}/${p.spec.containers.length}`;
const restarts = (p: KObj) => (p.status.restarts ? `${p.status.restarts} (${age(p.status.startedAt ?? p.metadata.creationTimestamp)} ago)` : '0');
const shortImg = (img: string) => img;
const svcPorts = (s: KObj) => (s.spec.ports as any[]).map((p) => `${p.port}${p.nodePort ? ':' + p.nodePort : ''}/${p.protocol}`).join(',');
const ext = (s: KObj) => (s.spec.type === 'LoadBalancer' ? s.status?.lbHost ?? '<pending>' : '<none>');
const nodeVer = (c: EksCluster) => `v${c.version}.${c.version === '1.31' ? 2 : 4}-eks-${c.arn.slice(-6).replace(/[^a-z0-9]/gi, 'a').toLowerCase()}`;

function rowsFor(c: EksCluster, kind: string, objs: KObj[], wide: boolean, allNs: boolean, showLabels: boolean): string[][] {
  const ns = (o: KObj) => (allNs ? [o.metadata.namespace ?? ''] : []);
  const L = (o: KObj) => (showLabels ? [lab(o.metadata.labels)] : []);
  const head = (h: string[]) => [...(allNs ? ['NAMESPACE'] : []), ...h, ...(showLabels ? ['LABELS'] : [])];
  const rows: string[][] = [];
  const A = (o: KObj) => age(o.metadata.creationTimestamp);
  switch (kind) {
    case 'Pod': rows.push(head(['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE', ...(wide ? ['IP', 'NODE', 'NOMINATED NODE', 'READINESS GATES'] : [])])); for (const p of objs) rows.push([...ns(p), p.metadata.name, podReadyStr(p), p.status.state, restarts(p), A(p), ...(wide ? [p.status.ip ?? '<none>', p.status.node ?? '<none>', '<none>', '<none>'] : []), ...L(p)]); break;
    case 'Deployment': rows.push(head(['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE', ...(wide ? ['CONTAINERS', 'IMAGES', 'SELECTOR'] : [])])); for (const d of objs) { const s = K.depStatus(c, d); rows.push([...ns(d), d.metadata.name, `${s.ready}/${s.want}`, String(s.updated), String(s.available), A(d), ...(wide ? [d.spec.template.spec.containers.map((x: any) => x.name).join(','), d.spec.template.spec.containers.map((x: any) => x.image).join(','), lab(d.spec.selector.matchLabels)] : []), ...L(d)]); } break;
    case 'ReplicaSet': rows.push(head(['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE'])); for (const r of objs) { const s = K.rsStatus(c, r); rows.push([...ns(r), r.metadata.name, String(s.desired), String(s.current), String(s.ready), A(r), ...L(r)]); } break;
    case 'DaemonSet': rows.push(head(['NAME', 'DESIRED', 'CURRENT', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'NODE SELECTOR', 'AGE'])); for (const d of objs) { const s = K.dsStatus(c, d); rows.push([...ns(d), d.metadata.name, String(s.desired), String(s.current), String(s.ready), String(s.current), String(s.ready), '<none>', A(d), ...L(d)]); } break;
    case 'Service': rows.push(head(['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE', ...(wide ? ['SELECTOR'] : [])])); for (const s of objs) rows.push([...ns(s), s.metadata.name, s.spec.type, s.status?.clusterIP ?? '<none>', ext(s), svcPorts(s), A(s), ...(wide ? [lab(s.spec.selector)] : []), ...L(s)]); break;
    case 'ConfigMap': rows.push(head(['NAME', 'DATA', 'AGE'])); for (const o of objs) rows.push([...ns(o), o.metadata.name, String(Object.keys(o.data ?? {}).length), A(o), ...L(o)]); break;
    case 'Secret': rows.push(head(['NAME', 'TYPE', 'DATA', 'AGE'])); for (const o of objs) rows.push([...ns(o), o.metadata.name, o.type ?? 'Opaque', String(Object.keys(o.data ?? {}).length), A(o), ...L(o)]); break;
    case 'Namespace': rows.push(['NAME', 'STATUS', 'AGE', ...(showLabels ? ['LABELS'] : [])]); for (const o of objs) rows.push([o.metadata.name, 'Active', A(o), ...L(o)]); break;
    case 'Node': rows.push(['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION', ...(wide ? ['INTERNAL-IP', 'EXTERNAL-IP', 'OS-IMAGE'] : []), ...(showLabels ? ['LABELS'] : [])]); for (const o of objs) rows.push([o.metadata.name, 'Ready', '<none>', A(o), nodeVer(c), ...(wide ? [K.nodeInfo(o).ip, '<none>', 'Amazon Linux 2023'] : []), ...L(o)]); break;
  }
  return rows;
}

/** Objeto tal y como lo devolvería la API (para -o yaml/json/jsonpath). */
function serialize(c: EksCluster, o: KObj): any {
  const k = K.kindInfo(o.kind);
  const md: any = { ...(o.metadata.annotations ? { annotations: o.metadata.annotations } : {}), creationTimestamp: iso(o.metadata.creationTimestamp), ...(o.metadata.generation ? { generation: o.metadata.generation } : {}), ...(o.metadata.labels ? { labels: o.metadata.labels } : {}), name: o.metadata.name, ...(o.metadata.namespace ? { namespace: o.metadata.namespace } : {}), ...(o.metadata.owner ? { ownerReferences: [{ apiVersion: 'apps/v1', kind: o.metadata.owner.kind, name: o.metadata.owner.name, controller: true }] } : {}), resourceVersion: o.metadata.resourceVersion, uid: o.metadata.uid };
  const out: any = { apiVersion: k.api, kind: o.kind, metadata: md };
  const strip = (sp: any) => { if (!sp) return sp; const { _tmpl, ...r } = sp; void _tmpl; return r; };
  if (o.kind === 'ConfigMap' || o.kind === 'Secret') { out.data = o.data ?? {}; if (o.kind === 'Secret') out.type = o.type ?? 'Opaque'; return out; }
  if (o.spec) out.spec = strip(o.spec);
  if (o.kind === 'Pod') { out.spec = { ...out.spec, ...(o.status.node ? { nodeName: o.status.node } : {}) }; out.status = { phase: o.status.phase, ...(o.status.ip ? { podIP: o.status.ip, hostIP: o.status.hostIp, podIPs: [{ ip: o.status.ip }] } : {}), containerStatuses: (o.spec.containers as any[]).map((ct) => ({ name: ct.name, image: ct.image, ready: !!o.status.ready, restartCount: o.status.restarts, state: o.status.state === 'Running' ? { running: { startedAt: iso(o.status.startedAt ?? now()) } } : { waiting: { reason: o.status.state } } })) }; }
  else if (o.kind === 'Deployment') { const s = K.depStatus(c, o); out.status = { availableReplicas: s.available, observedGeneration: o.metadata.generation ?? 1, readyReplicas: s.ready, replicas: s.replicas, updatedReplicas: s.updated }; }
  else if (o.kind === 'Service') { out.spec.clusterIP = o.status?.clusterIP; out.status = { loadBalancer: o.status?.lbHost ? { ingress: [{ hostname: o.status.lbHost }] } : {} }; }
  else if (o.kind === 'Namespace') out.status = { phase: 'Active' };
  else if (o.kind === 'Node') { const i = K.nodeInfo(o); out.status = { addresses: [{ type: 'InternalIP', address: i.ip }, { type: 'Hostname', address: o.metadata.name }], allocatable: { cpu: `${i.cpu}m`, memory: `${i.mem}Mi`, pods: String(i.maxPods) }, capacity: { cpu: `${i.cpu + 70}m`, pods: String(i.maxPods) }, conditions: [{ type: 'Ready', status: 'True' }], nodeInfo: { kubeletVersion: nodeVer(c), osImage: 'Amazon Linux 2023' } }; out.spec = { providerID: `aws:///${i.az}/${i.instanceId}` }; }
  return out;
}
function jsonpath(obj: any, expr: string): string {
  return expr.replace(/\{([^}]*)\}/g, (_m, p: string) => {
    let cur: any[] = [obj];
    for (const tok of p.replace(/^\./, '').match(/[^.[\]]+|\[\*\]|\[\d+\]/g) ?? []) {
      if (tok === '[*]') cur = cur.flatMap((x) => (Array.isArray(x) ? x : []));
      else if (/^\[\d+\]$/.test(tok)) cur = cur.map((x) => x?.[Number(tok.slice(1, -1))]);
      else cur = cur.flatMap((x) => (Array.isArray(x) ? x.map((y) => y?.[tok]) : [x?.[tok]]));
    }
    return cur.filter((x) => x !== undefined).map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
  }).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}
function format(c: EksCluster, objs: KObj[], single: boolean, fmt: string): string {
  if (fmt === 'name') return objs.map((o) => K.qualified(o)).join('\n') + (objs.length ? '\n' : '');
  const items = objs.map((o) => serialize(c, o));
  const data = single ? items[0] : { apiVersion: 'v1', items, kind: 'List', metadata: { resourceVersion: '' } };
  if (fmt === 'json') return JSON.stringify(data, null, 4) + '\n';
  if (fmt.startsWith('jsonpath=')) return jsonpath(data, fmt.slice(9).replace(/^['"]|['"]$/g, ''));
  return yaml.dump(data, { lineWidth: -1 });
}

// ------------------------------------------------------------------ recursos por nombre

function resolveKinds(tok: string): string[] | undefined {
  if (tok === 'all') return ['Pod', 'Service', 'Deployment', 'ReplicaSet', 'DaemonSet'];
  const parts = tok.split(',').map((t) => K.kindFromToken(t)?.kind);
  return parts.every(Boolean) ? (parts as string[]) : undefined;
}
const notFound = (kind: string, name: string) => `Error from server (NotFound): ${K.kindInfo(kind).plural}${K.kindInfo(kind).group ? '.' + K.kindInfo(kind).group : ''} "${name}" not found`;
function split(pos: string[]): { kinds?: string[]; names: string[]; bad?: string } {
  if (!pos.length) return { names: [] };
  const [a, ...rest] = pos;
  if (a.includes('/') && !a.includes(',')) { const [k, n] = a.split('/'); const kk = K.kindFromToken(k); return kk ? { kinds: [kk.kind], names: [n, ...rest] } : { names: [], bad: k }; }
  const kinds = resolveKinds(a);
  return kinds ? { kinds, names: rest } : { names: [], bad: a };
}
const badKind = (t: string) => E(`error: the server doesn't have a resource type "${t}"`);

// ------------------------------------------------------------------ get

function get(sh: Shell, args: string[]): CmdResult {
  const o = parse(args);
  const cx = context(sh, nsOf(o)); if (isErr(cx)) return cx;
  const { c, ns } = cx;
  if (!o.pos.length) return E('You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.\n\nerror: Required resource not specified.');
  if (o.pos[0] === 'events' || o.pos[0] === 'ev') {
    const evs = c.kube.events.filter((e) => o.flags.has('A') || o.flags.has('all-namespaces') || e.ns === ns).sort((a, b) => a.ts - b.ts);
    if (!evs.length) return { out: '', err: `No resources found in ${ns} namespace.\n`, code: 0 };
    return ok(table([['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'], ...evs.map((e) => [age(e.ts), e.type, e.reason, `${e.kind.toLowerCase()}/${e.name}`, e.message])]));
  }
  const sp = split(o.pos);
  if (sp.bad) return badKind(sp.bad);
  const allNs = o.flags.has('A') || o.flags.has('all-namespaces');
  const fmt = val(o, 'o', 'output') ?? '';
  const sel = val(o, 'l', 'selector');
  const wide = fmt === 'wide';
  let out = '';
  let total = 0;
  const kinds = sp.kinds!;
  const multi = kinds.length > 1;
  for (const kind of kinds) {
    let objs = K.list(c, kind, allNs ? undefined : ns).filter((x) => K.matchLabelExpr(sel, x.metadata.labels ?? {}));
    if (sp.names.length) {
      const missing = sp.names.filter((n) => !objs.some((x) => x.metadata.name === n));
      if (missing.length && !(kind !== 'Namespace' && K.kindInfo(kind).namespaced === false && false)) { const objsFound = objs.filter((x) => sp.names.includes(x.metadata.name)); return { out: objsFound.length ? rowsOut(c, kind, objsFound, wide, allNs, o) : '', err: missing.map((n) => notFound(kind, n)).join('\n') + '\n', code: 1 }; }
      objs = objs.filter((x) => sp.names.includes(x.metadata.name));
    }
    if (!objs.length && !fmt.match(/^(yaml|json|jsonpath|name)/)) continue;
    total += objs.length;
    if (fmt && !wide) out += format(c, objs, sp.names.length === 1 && !multi, fmt);
    else out += (out ? '\n' : '') + (multi ? '' : '') + rowsOut(c, kind, objs, wide, allNs, o, multi);
  }
  if (!total && !fmt.match(/^(yaml|json|jsonpath|name)/)) return { out: '', err: `No resources found${K.kindInfo(kinds[0]).namespaced ? ` in ${allNs ? 'all' : ns} namespace${allNs ? 's' : ''}` : ''}.\n`.replace('in all namespaces', ''), code: 0 };
  return ok(out);
}
function rowsOut(c: EksCluster, kind: string, objs: KObj[], wide: boolean, allNs: boolean, o: Opts, prefix = false): string {
  const rows = rowsFor(c, kind, objs, wide, allNs && K.kindInfo(kind).namespaced, o.flags.has('show-labels'));
  if (prefix) { const i = rows[0].indexOf('NAME'); for (let r = 1; r < rows.length; r++) rows[r][i] = K.qualified(objs[r - 1]); }
  return table(rows);
}

// ------------------------------------------------------------------ describe

function evTable(c: EksCluster, o: KObj): string {
  const evs = K.eventsFor(c, o);
  if (!evs.length) return 'Events:                <none>\n';
  return 'Events:\n' + table([['  Type', 'Reason', 'Age', 'From', 'Message'], ...evs.map((e) => ['  ' + e.type, e.reason, age(e.ts), e.from, e.message])]);
}
function describePod(c: EksCluster, p: KObj): string {
  const st = p.status;
  let t = kv([['Name', p.metadata.name], ['Namespace', p.metadata.namespace!], ['Priority', '0'], ['Service Account', 'default'], ['Node', st.node ? `${st.node}/${st.hostIp}` : '<none>'], ...(st.scheduled ? [['Start Time', rfc(st.scheduled)] as [string, string]] : []), ['Labels', lab(p.metadata.labels).replace(/,/g, '\n                  ')], ['Annotations', '<none>'], ['Status', st.phase], ['IP', st.ip ?? ''], ['IPs', st.ip ? `\n  IP:           ${st.ip}` : '<none>'], ...(p.metadata.owner ? [['Controlled By', `${p.metadata.owner.kind}/${p.metadata.owner.name}`] as [string, string]] : [])]);
  t += 'Containers:\n';
  for (const ct of p.spec.containers as any[]) {
    t += `  ${ct.name}:\n    Container ID:   ${st.scheduled ? 'containerd://' + p.metadata.uid.replace(/-/g, '') + p.metadata.uid.replace(/-/g, '').slice(0, 32) : ''}\n    Image:          ${ct.image}\n    Image ID:       ${st.state === 'Running' ? ct.image : ''}\n    Port:           ${(ct.ports ?? []).map((x: any) => `${x.containerPort}/TCP`).join(', ') || '<none>'}\n    Host Port:      ${(ct.ports ?? []).length ? '0/TCP' : '<none>'}\n`;
    t += st.state === 'Running' ? `    State:          Running\n      Started:      ${rfc(st.startedAt ?? now())}\n` : `    State:          Waiting\n      Reason:       ${st.state}\n`;
    if (st.state === 'CrashLoopBackOff') t += `    Last State:     Terminated\n      Reason:       Completed\n      Exit Code:    ${st.lastExit ?? 0}\n`;
    t += `    Ready:          ${st.ready ? 'True' : 'False'}\n    Restart Count:  ${st.restarts}\n`;
    if (ct.resources?.requests) t += `    Requests:\n${Object.entries(ct.resources.requests).map(([k, v]) => `      ${k}:  ${v}`).join('\n')}\n`;
    t += '    Environment:    ' + ((ct.env ?? []).length || (ct.envFrom ?? []).length ? '\n' + [...(ct.envFrom ?? []).map((e: any) => `      <set to the key from ConfigMap ${e.configMapRef?.name}>`), ...(ct.env ?? []).map((e: any) => `      ${e.name}:  ${e.value ?? '<set from configmap>'}`)].join('\n') + '\n' : '<none>\n');
  }
  t += `Conditions:\n  Type                        Status\n  PodReadyToStartContainers   ${st.scheduled ? 'True' : 'False'}\n  Initialized                 True\n  Ready                       ${st.ready ? 'True' : 'False'}\n  ContainersReady             ${st.ready ? 'True' : 'False'}\n  PodScheduled                ${st.scheduled ? 'True' : 'False'}\n`;
  t += 'QoS Class:                   ' + (p.spec.containers.some((x: any) => x.resources?.requests) ? 'Burstable' : 'BestEffort') + '\nNode-Selectors:              ' + (lab(p.spec.nodeSelector) === '<none>' ? '<none>' : lab(p.spec.nodeSelector)) + '\nTolerations:                 node.kubernetes.io/not-ready:NoExecute op=Exists for 300s\n';
  return t + evTable(c, p);
}
function describeObj(c: EksCluster, o: KObj): string {
  switch (o.kind) {
    case 'Pod': return describePod(c, o);
    case 'Deployment': {
      const s = K.depStatus(c, o);
      const rss = K.revisions(c, o);
      const olds = rss.filter((r) => r !== s.cur && r.spec.replicas > 0).map((r) => `${r.metadata.name} (${K.rsStatus(c, r).current}/${r.spec.replicas} replicas created)`);
      const tpl = o.spec.template;
      let t = kv([['Name', o.metadata.name], ['Namespace', o.metadata.namespace!], ['CreationTimestamp', rfc(o.metadata.creationTimestamp)], ['Labels', lab(o.metadata.labels)], ['Annotations', Object.entries(o.metadata.annotations ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n                  ') || '<none>'], ['Selector', lab(o.spec.selector.matchLabels)], ['Replicas', `${s.want} desired | ${s.updated} updated | ${s.replicas} total | ${s.available} available | ${s.unavailable} unavailable`], ['StrategyType', 'RollingUpdate'], ['MinReadySeconds', '0'], ['RollingUpdateStrategy', `${o.spec.strategy?.rollingUpdate?.maxUnavailable ?? '25%'} max unavailable, ${o.spec.strategy?.rollingUpdate?.maxSurge ?? '25%'} max surge`]]);
      t += `Pod Template:\n  Labels:  ${lab(tpl.metadata?.labels)}\n  Containers:\n` + (tpl.spec.containers as any[]).map((ct) => `   ${ct.name}:\n    Image:      ${ct.image}\n    Port:       ${(ct.ports ?? []).map((x: any) => `${x.containerPort}/TCP`).join(', ') || '<none>'}\n    Host Port:  ${(ct.ports ?? []).length ? '0/TCP' : '<none>'}\n`).join('') + '  Node-Selectors:  <none>\n  Tolerations:     <none>\n';
      t += `Conditions:\n  Type           Status  Reason\n  ----           ------  ------\n  Available      ${s.available >= s.want - 0 && s.want ? 'True' : s.available ? 'True' : 'False'}    ${s.available ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable'}\n  Progressing    ${s.done ? 'True    NewReplicaSetAvailable' : 'True    ReplicaSetUpdated'}\n`;
      t += `OldReplicaSets:  ${olds.join(', ') || '<none>'}\nNewReplicaSet:   ${s.cur ? `${s.cur.metadata.name} (${K.rsStatus(c, s.cur).current}/${s.cur.spec.replicas} replicas created)` : '<none>'}\n`;
      return t + evTable(c, o);
    }
    case 'Service': {
      const eps = K.serviceEndpoints(c, o);
      const sp = o.spec.ports as any[];
      let t = kv([['Name', o.metadata.name], ['Namespace', o.metadata.namespace!], ['Labels', lab(o.metadata.labels)], ['Annotations', '<none>'], ['Selector', lab(o.spec.selector)], ['Type', o.spec.type], ['IP Family Policy', 'SingleStack'], ['IP Families', 'IPv4'], ['IP', o.status?.clusterIP ?? ''], ['IPs', o.status?.clusterIP ?? ''], ...(o.status?.lbHost ? [['LoadBalancer Ingress', o.status.lbHost] as [string, string]] : [])]);
      for (const p of sp) t += kv([['Port', `${p.name ?? '<unset>'}  ${p.port}/${p.protocol}`], ['TargetPort', `${p.targetPort}/${p.protocol}`], ...(p.nodePort ? [['NodePort', `${p.name ?? '<unset>'}  ${p.nodePort}/${p.protocol}`] as [string, string]] : []), ['Endpoints', eps.filter((e) => e.port === Number(p.targetPort)).map((e) => `${e.ip}:${e.port}`).join(',') || '<none>']]);
      return t + 'Session Affinity:  None\n' + evTable(c, o);
    }
    case 'Node': {
      const i = K.nodeInfo(o); const u = K.nodeUsage(c, o);
      return kv([['Name', o.metadata.name], ['Roles', '<none>'], ['Labels', lab(o.metadata.labels).replace(/,/g, '\n                    ')], ['CreationTimestamp', rfc(o.metadata.creationTimestamp)], ['Taints', '<none>']]) + `Conditions:\n  Type    Status\n  Ready   True\nAddresses:\n  InternalIP:  ${i.ip}\n  Hostname:    ${o.metadata.name}\nCapacity:\n  cpu:     ${(i.cpu + 70) / 1000}\n  memory:  ${i.mem}Mi\n  pods:    ${i.maxPods}\nAllocatable:\n  cpu:     ${i.cpu}m\n  memory:  ${i.mem}Mi\n  pods:    ${i.maxPods}\nProviderID:                   aws:///${i.az}/${i.instanceId}\nNon-terminated Pods:          (${u.pods} in total)\n` + table([['  Namespace', 'Name', 'CPU Requests'], ...u.list.map((p) => ['  ' + p.metadata.namespace, p.metadata.name, `${(p.spec.containers as any[]).reduce((a, x) => a + K.cpuM(x.resources?.requests?.cpu), 0)}m`])]) + `Allocated resources:\n  cpu     ${u.cpu}m (${Math.round((u.cpu / i.cpu) * 100)}%)\n  memory  ${Math.round(u.mem)}Mi (${Math.round((u.mem / i.mem) * 100)}%)\n` + evTable(c, o);
    }
    case 'ConfigMap': return kv([['Name', o.metadata.name], ['Namespace', o.metadata.namespace!], ['Labels', lab(o.metadata.labels)], ['Annotations', '<none>']]) + '\nData\n====\n' + Object.entries(o.data ?? {}).map(([k, v]) => `${k}:\n----\n${v}\n`).join('\n') + '\nBinaryData\n====\n\n' + evTable(c, o);
    case 'Namespace': return kv([['Name', o.metadata.name], ['Labels', lab(o.metadata.labels)], ['Annotations', '<none>'], ['Status', 'Active']]) + '\nNo resource quota.\n\nNo LimitRange resource.\n';
    default: return kv([['Name', o.metadata.name], ['Namespace', o.metadata.namespace ?? ''], ['Labels', lab(o.metadata.labels)]]) + evTable(c, o);
  }
}
function describe(sh: Shell, args: string[]): CmdResult {
  const o = parse(args);
  const cx = context(sh, nsOf(o)); if (isErr(cx)) return cx;
  const sp = split(o.pos);
  if (sp.bad) return badKind(sp.bad);
  if (!o.pos.length) return E('error: You must specify the type of resource to describe. Use "kubectl api-resources" for a complete list of supported resources.');
  const out: string[] = [];
  for (const kind of sp.kinds!) {
    const objs = K.list(cx.c, kind, cx.ns).filter((x) => (!sp.names.length || sp.names.includes(x.metadata.name)) && K.matchLabelExpr(val(o, 'l', 'selector'), x.metadata.labels ?? {}));
    for (const n of sp.names) if (!objs.some((x) => x.metadata.name === n)) return E(notFound(kind, n));
    if (!objs.length) return { out: '', err: `No resources found in ${cx.ns} namespace.\n`, code: 0 };
    out.push(...objs.map((x) => describeObj(cx.c, x)));
  }
  return ok(out.join('\n\n'));
}

// ------------------------------------------------------------------ apply / create / delete

function docsFrom(sh: Shell, o: Opts, stdin: string): { docs: { doc: any; file: string }[] } | CmdResult {
  const files = o.vals.f ?? o.vals.filename ?? [];
  if (!files.length) return E('error: must specify one of -f and -k');
  const docs: { doc: any; file: string }[] = [];
  for (const f of files) {
    let texts: { t: string; name: string }[] = [];
    if (f === '-') texts = [{ t: stdin, name: 'STDIN' }];
    else if (/^https?:\/\//.test(f)) return E(`error: unable to read URL "${f}", server reported 404 Not Found, status code=404`);
    else {
      const p = VFS.norm(f, sh.cwd);
      if (sh.fs.isDir(p)) texts = sh.fs.list(p).filter((x) => /\.(ya?ml|json)$/.test(x)).map((x) => ({ t: sh.fs.readFile(p + '/' + x), name: p + '/' + x }));
      else if (sh.fs.isFile(p)) texts = [{ t: sh.fs.readFile(p), name: f }];
      else return E(`error: the path "${f}" does not exist`);
    }
    for (const { t, name } of texts) {
      try { for (const d of yaml.loadAll(t) as any[]) { if (d === null || d === undefined) continue; for (const x of d?.kind === 'List' ? d.items ?? [] : [d]) docs.push({ doc: x, file: name }); } }
      catch (e) { return E(`error: error parsing ${name}: error converting YAML to JSON: yaml: ${(e as Error).message.split('\n')[0].replace(/^.*?: /, '')}`); }
    }
  }
  if (!docs.length) return E('error: no objects passed to apply');
  return { docs };
}
function applyOrCreate(sh: Shell, args: string[], stdin: string, creating: boolean): CmdResult {
  const o = parse(args);
  const cx = context(sh, nsOf(o)); if (isErr(cx)) return cx;
  const r = docsFrom(sh, o, stdin); if ('code' in r) return r;
  let out = ''; let err = ''; let code = 0;
  for (const { doc, file } of r.docs) {
    try {
      if (creating && doc?.kind && doc?.metadata?.name) {
        const info = K.KINDS.find((k) => k.kind === doc.kind);
        const ns = info?.namespaced ? doc.metadata.namespace ?? cx.ns : undefined;
        if (info && K.find(cx.c, doc.kind, ns, doc.metadata.name)) throw new K.KubeError(`Error from server (AlreadyExists): error when creating "${file}": ${info.plural}${info.group ? '.' + info.group : ''} "${doc.metadata.name}" already exists`);
      }
      const res = K.applyDoc(cx.c, doc, cx.ns, file);
      out += `${K.qualified(res.obj)} ${creating ? 'created' : res.verb}\n`;
    } catch (e) { if (e instanceof K.KubeError) { err += e.message.replace(/\n$/, '') + '\n'; code = 1; } else throw e; }
  }
  K.reconcile(sh.s, cx.c);
  return { out, err, code };
}

function del(sh: Shell, args: string[], stdin: string): CmdResult {
  const o = parse(args);
  const cx = context(sh, nsOf(o)); if (isErr(cx)) return cx;
  let targets: KObj[] = []; let err = '';
  if (o.vals.f || o.vals.filename) {
    const r = docsFrom(sh, o, stdin); if ('code' in r) return r;
    for (const { doc } of r.docs) { const info = K.KINDS.find((k) => k.kind === doc.kind); const x = info && K.find(cx.c, doc.kind, info.namespaced ? doc.metadata?.namespace ?? cx.ns : undefined, doc.metadata?.name); if (x) targets.push(x); else if (info) err += notFound(doc.kind, doc.metadata?.name) + '\n'; }
  } else {
    const sp = split(o.pos);
    if (!o.pos.length) return E('error: You must provide one or more resources by argument or filename (.json|.yaml|.yml|stdin)\nExample resource specifications include:\n   \'-f rsrc.yaml\'\n   \'--filename=rsrc.json\'\n   \'<resource> <name>\'\n   \'<resource>\'');
    if (sp.bad) return badKind(sp.bad);
    const all = o.flags.has('all') || o.flags.has('A');
    for (const kind of sp.kinds!) {
      const found = K.list(cx.c, kind, cx.ns).filter((x) => K.matchLabelExpr(val(o, 'l', 'selector'), x.metadata.labels ?? {}));
      if (sp.names.length) { for (const n of sp.names) { const x = found.find((y) => y.metadata.name === n); if (x) targets.push(x); else err += notFound(kind, n) + '\n'; } }
      else if (all || val(o, 'l', 'selector')) targets.push(...found.filter((x) => !(kind === 'Namespace' && ['default', 'kube-system', 'kube-public', 'kube-node-lease'].includes(x.metadata.name)) && !(kind === 'Service' && x.metadata.name === 'kubernetes')));
      else return E('error: resource(s) were provided, but no name was specified');
    }
  }
  let out = '';
  for (const t of targets) { try { K.deleteObj(cx.c, t); out += `${K.kindInfo(t.kind).singular}${K.kindInfo(t.kind).group ? '.' + K.kindInfo(t.kind).group : ''} "${t.metadata.name}" deleted\n`; } catch (e) { if (e instanceof K.KubeError) err += e.message + '\n'; else throw e; } }
  if (!targets.length && !err) return { out: '', err: `No resources found\n`, code: 0 };
  K.reconcile(sh.s, cx.c);
  return { out, err, code: err ? 1 : 0 };
}

function create(sh: Shell, args: string[], stdin: string): CmdResult {
  const o = parse(args);
  if (o.vals.f || o.vals.filename) return applyOrCreate(sh, args, stdin, true);
  const cx = context(sh, nsOf(o)); if (isErr(cx)) return cx;
  const [what, name, ...more] = o.pos;
  const doc = (d: any) => { try { const r = K.applyDoc(cx.c, d, cx.ns, 'cli'); K.reconcile(sh.s, cx.c); return ok(`${K.qualified(r.obj)} created\n`); } catch (e) { if (e instanceof K.KubeError) return E(e.message); throw e; } };
  const exists = (kind: string) => { const info = K.kindInfo(kind); return K.find(cx.c, kind, info.namespaced ? cx.ns : undefined, name) ? E(`Error from server (AlreadyExists): ${info.plural}${info.group ? '.' + info.group : ''} "${name}" already exists`) : undefined; };
  if (what === 'namespace' || what === 'ns') { if (!name) return E('error: exactly one NAME is required, got 0'); return exists('Namespace') ?? doc({ apiVersion: 'v1', kind: 'Namespace', metadata: { name } }); }
  if (what === 'deployment' || what === 'deploy') {
    const image = val(o, 'image'); if (!name || !image) return E('error: required flag(s) "image" not set');
    return exists('Deployment') ?? doc({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, labels: { app: name } }, spec: { replicas: Number(val(o, 'replicas') ?? 1), selector: { matchLabels: { app: name } }, template: { metadata: { labels: { app: name } }, spec: { containers: [{ name: image.split('/').pop()!.split(':')[0], image, ...(val(o, 'port') ? { ports: [{ containerPort: Number(val(o, 'port')) }] } : {}) }] } } } });
  }
  if (what === 'configmap' || what === 'cm') { const data = Object.fromEntries((o.vals['from-literal'] ?? []).map((x) => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; })); return exists('ConfigMap') ?? doc({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name }, data }); }
  if (what === 'secret') { const n = more[0] ?? name; void n; const nm = o.pos[2] ?? name; const data = Object.fromEntries((o.vals['from-literal'] ?? []).map((x) => { const i = x.indexOf('='); return [x.slice(0, i), btoa(x.slice(i + 1))]; })); return doc({ apiVersion: 'v1', kind: 'Secret', metadata: { name: nm }, type: 'Opaque', data }); }
  return E(`error: unknown command "${what ?? ''}"\nSee 'kubectl create --help' for usage.`);
}

function run(sh: Shell, args: string[]): CmdResult {
  const o = parse(args);
  const cx = context(sh, nsOf(o)); if (isErr(cx)) return cx;
  const name = o.pos[0]; const image = val(o, 'image');
  if (!name) return E('error: NAME is required for run');
  if (!image) return E('error: required flag(s) "image" not set');
  const labels = { run: name, ...Object.fromEntries((val(o, 'labels') ?? '').split(',').filter(Boolean).map((x) => x.split('='))) };
  if (K.find(cx.c, 'Pod', cx.ns, name)) return E(`Error from server (AlreadyExists): pods "${name}" already exists`);
  try { K.applyDoc(cx.c, { apiVersion: 'v1', kind: 'Pod', metadata: { name, labels }, spec: { restartPolicy: val(o, 'restart') ?? 'Always', containers: [{ name, image, ...(val(o, 'port') ? { ports: [{ containerPort: Number(val(o, 'port')) }] } : {}), ...(o.rest.length ? { command: undefined, args: o.rest } : {}) }] } }, cx.ns, 'cli'); } catch (e) { if (e instanceof K.KubeError) return E(e.message); throw e; }
  K.reconcile(sh.s, cx.c);
  return ok(`pod/${name} created\n`);
}

function expose(sh: Shell, args: string[]): CmdResult {
  const o = parse(args);
  const cx = context(sh, nsOf(o)); if (isErr(cx)) return cx;
  const sp = split(o.pos);
  if (sp.bad) return badKind(sp.bad);
  const kind = sp.kinds![0]; const nm = sp.names[0];
  const src = K.find(cx.c, kind, cx.ns, nm);
  if (!src) return E(notFound(kind, nm));
  const port = Number(val(o, 'port')); if (!port) return E('error: couldn\'t find port via --port flag or introspection');
  const selector = kind === 'Pod' ? src.metadata.labels : src.spec.template?.metadata?.labels ?? src.spec.selector?.matchLabels;
  const sname = val(o, 'name') ?? nm;
  if (K.find(cx.c, 'Service', cx.ns, sname)) return E(`Error from server (AlreadyExists): services "${sname}" already exists`);
  K.applyDoc(cx.c, { apiVersion: 'v1', kind: 'Service', metadata: { name: sname, labels: src.metadata.labels }, spec: { type: val(o, 'type') ?? 'ClusterIP', selector, ports: [{ port, targetPort: Number(val(o, 'target-port') ?? port) }] } }, cx.ns, 'cli');
  K.reconcile(sh.s, cx.c);
  return ok(`service/${sname} exposed\n`);
}

function target(sh: Shell, o: Opts, kinds: string[]): { cx: Ctx; obj: KObj } | CmdResult {
  const cx = context(sh, nsOf(o)); if (isErr(cx)) return cx;
  const sp = split(o.pos);
  if (sp.bad) return badKind(sp.bad);
  const kind = sp.kinds![0];
  if (!kinds.includes(kind)) return E(`error: cannot ${'perform this action on'} ${K.kindInfo(kind).plural}`);
  const nm = sp.names[0];
  if (!nm) return E('error: resource name may not be empty');
  const obj = K.find(cx.c, kind, cx.ns, nm);
  return obj ? { cx, obj } : E(notFound(kind, nm));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rollout(sh: Shell, args: string[]): Promise<CmdResult> {
  const [sub, ...rest] = args;
  const o = parse(rest);
  const t = target(sh, o, ['Deployment']); if ('code' in t) return t;
  const { cx, obj } = t;
  const dn = `deployment.apps/${obj.metadata.name}`;
  if (sub === 'status') {
    const seen: string[] = [];
    const limit = Date.now() + (sh.s.settings.speed === 'instant' ? 0 : Math.min(60, parseInt(val(o, 'timeout') ?? '30', 10) || 30) * 1000);
    for (;;) {
      K.reconcile(sh.s, cx.c);
      const p = K.rolloutProgress(cx.c, obj);
      for (const l of p.lines) if (!seen.includes(l)) seen.push(l);
      if (p.done) return ok(seen.join('\n') + '\n');
      if (Date.now() >= limit) return { out: seen.join('\n') + '\n', err: `error: deployment "${obj.metadata.name}" exceeded its progress deadline\n`, code: 1 };
      await sleep(400);
    }
  }
  if (sub === 'history') return ok(`${dn}\nREVISION  CHANGE-CAUSE\n` + K.revisions(cx.c, obj).map((r) => `${r.metadata.annotations?.['deployment.kubernetes.io/revision']}         ${r.metadata.annotations?.['kubernetes.io/change-cause'] ?? '<none>'}`).join('\n') + '\n');
  if (sub === 'restart') { K.rolloutRestart(cx.c, obj); K.reconcile(sh.s, cx.c); return ok(`${dn} restarted\n`); }
  if (sub === 'undo') { try { K.rolloutUndo(cx.c, obj, val(o, 'to-revision') ? Number(val(o, 'to-revision')) : undefined); } catch (e) { if (e instanceof K.KubeError) return E(e.message); throw e; } K.reconcile(sh.s, cx.c); return ok(`${dn} rolled back\n`); }
  return E(`error: unknown subcommand "${sub ?? ''}"\nSee 'kubectl rollout --help' for usage.`);
}

function logs(sh: Shell, args: string[]): CmdResult {
  const o = parse(args, VAL, []);
  o.flags.delete('f');
  const cx = context(sh, nsOf(o)); if (isErr(cx)) return cx;
  let pod: KObj | undefined;
  const sel = val(o, 'l', 'selector');
  if (sel) pod = K.list(cx.c, 'Pod', cx.ns).find((p) => K.matchLabelExpr(sel, p.metadata.labels ?? {}));
  else {
    const a = o.pos[0] ?? '';
    if (!a) return E('error: expected \'logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER]\'.\nPOD or TYPE/NAME is a required argument for the logs command\nSee \'kubectl logs -h\' for help and examples');
    const [k, n] = a.includes('/') ? a.split('/') : ['pod', a];
    const kind = K.kindFromToken(k)?.kind;
    if (kind === 'Deployment') { const d = K.find(cx.c, 'Deployment', cx.ns, n); if (!d) return E(notFound('Deployment', n)); pod = K.list(cx.c, 'Pod', cx.ns).find((p) => K.matchSelector(d.spec.selector.matchLabels, p.metadata.labels ?? {})); }
    else { pod = K.find(cx.c, 'Pod', cx.ns, n); if (!pod) return E(notFound('Pod', n)); }
  }
  if (!pod) return E(`error: no pods found${sel ? ` with label ${sel}` : ''}`.replace('error: ', 'No resources found in ' + cx.ns + ' namespace.\n').replace(/^No resources.*\n/, () => 'error: no pods found\n'));
  try { const l = K.podLogs(cx.c, pod, val(o, 'tail') ? Number(val(o, 'tail')) : undefined); return ok(l.join('\n') + (l.length ? '\n' : '')); } catch (e) { if (e instanceof K.KubeError) return E(e.message); throw e; }
}

function exec(sh: Shell, args: string[]): CmdResult {
  const o = parse(args.filter((a) => a !== '-it' && a !== '-i' && a !== '-t'));
  const cx = context(sh, nsOf(o)); if (isErr(cx)) return cx;
  const name = o.pos[0].replace(/^pod\//, '');
  const pod = K.find(cx.c, 'Pod', cx.ns, name);
  if (!pod) return E(notFound('Pod', name));
  if (!pod.status.ready) return E(`error: unable to upgrade connection: container not found ("${pod.spec.containers[0].name}")`);
  const [cmd, ...a] = o.rest;
  if (!cmd) return E('error: you must specify at least one command for the container');
  if (cmd === 'hostname') return ok(pod.metadata.name + '\n');
  if (cmd === 'env' || cmd === 'printenv') return ok(Object.entries({ HOSTNAME: pod.metadata.name, KUBERNETES_SERVICE_HOST: '10.100.0.1', ...(pod.spec.containers[0].env ?? []).reduce((m: any, e: any) => ({ ...m, [e.name]: e.value }), {}) }).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  if (cmd === 'echo') return ok(a.join(' ') + '\n');
  if (cmd === 'wget' || cmd === 'curl') {
    const url = a.filter((x) => !x.startsWith('-')).pop() ?? '';
    const m = /^https?:\/\/([^/:]+)(?::(\d+))?/.exec(url.startsWith('http') ? url : 'http://' + url);
    if (!m) return E(`${cmd}: bad address '${url}'`);
    const svc = K.resolveService(cx.c, m[1], cx.ns);
    if (!svc) return E(cmd === 'wget' ? `wget: bad address '${m[1]}'` : `curl: (6) Could not resolve host: ${m[1]}`);
    const r = K.serviceHttp(sh.s, cx.c, svc, Number(m[2] ?? 80));
    if (!r || !r.status) return E(cmd === 'wget' ? 'wget: download timed out' : `curl: (28) Failed to connect to ${m[1]} port ${m[2] ?? 80}: Connection timed out`);
    return ok(r.body);
  }
  return E(`OCI runtime exec failed: exec failed: unable to start container process: exec: "${cmd}": executable file not found in $PATH: unknown\ncommand terminated with exit code 126`, 126);
}

function config(sh: Shell, args: string[]): CmdResult {
  const [sub, ...rest] = args;
  const path = `${homeDir(sh.s)}/.kube/config`;
  if (!sh.fs.isFile(path)) return sub === 'current-context' ? E('error: current-context is not set') : ok(sub === 'view' ? 'apiVersion: v1\nclusters: null\ncontexts: null\ncurrent-context: ""\nkind: Config\npreferences: {}\nusers: null\n' : '');
  const cfg: any = yaml.load(sh.fs.readFile(path));
  const save = () => sh.fs.writeFile(path, yaml.dump(cfg, { lineWidth: -1 }));
  if (sub === 'current-context') return cfg['current-context'] ? ok(cfg['current-context'] + '\n') : E('error: current-context is not set');
  if (sub === 'view') return ok(yaml.dump({ ...cfg, clusters: (cfg.clusters ?? []).map((x: any) => ({ cluster: { server: x.cluster.server, 'certificate-authority-data': 'DATA+OMITTED' }, name: x.name })) }, { lineWidth: -1 }));
  if (sub === 'get-contexts') return ok(table([['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE'], ...(cfg.contexts ?? []).map((x: any) => [x.name === cfg['current-context'] ? '*' : '', x.name, x.context.cluster, x.context.user, x.context.namespace ?? ''])]));
  if (sub === 'use-context') { const n = rest[0]; if (!(cfg.contexts ?? []).some((x: any) => x.name === n)) return E(`error: no context exists with the name: "${n}"`); cfg['current-context'] = n; save(); return ok(`Switched to context "${n}".\n`); }
  if (sub === 'set-context') { const o = parse(rest); const cur = (cfg.contexts ?? []).find((x: any) => x.name === (o.flags.has('current') || o.vals.current !== undefined ? cfg['current-context'] : o.pos[0])); if (!cur) return E('error: no context to modify'); if (val(o, 'namespace')) cur.context.namespace = val(o, 'namespace'); save(); return ok(`Context "${cur.name}" modified.\n`); }
  return E(`error: unknown command "${sub ?? ''}"\nSee 'kubectl config --help' for usage.`);
}

registerCommand('kubectl', async (args, { sh, stdin }) => {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '--help') return ok('kubectl controls the Kubernetes cluster manager.\n\nBasic Commands:\n  create, expose, run\n\nDeploy Commands:\n  rollout, scale\n\nCluster Management:\n  config, describe, get, logs, exec\n\nAdvanced Commands:\n  apply, delete, set\n');
  if (sub === 'version') { const c = context(sh); const sv = isErr(c) ? '' : `Server Version: ${nodeVer(c.c).replace(/-eks.*/, '')}-eks-${c.c.arn.slice(-6).replace(/[^a-z0-9]/gi, 'a').toLowerCase()}\n`; return { out: 'Client Version: v1.31.2\nKustomize Version: v5.4.2\n' + sv, err: isErr(c) ? c.err : '', code: 0 }; }
  switch (sub) {
    case 'get': return get(sh, rest);
    case 'describe': return describe(sh, rest);
    case 'apply': return applyOrCreate(sh, rest, stdin, false);
    case 'create': return create(sh, rest, stdin);
    case 'delete': return del(sh, rest, stdin);
    case 'run': return run(sh, rest);
    case 'expose': return expose(sh, rest);
    case 'logs': return logs(sh, rest);
    case 'exec': return exec(sh, rest);
    case 'config': return config(sh, rest);
    case 'rollout': return rollout(sh, rest);
    case 'cluster-info': { const c = context(sh); if (isErr(c)) return c; return ok(`Kubernetes control plane is running at ${c.c.endpoint}\nCoreDNS is running at ${c.c.endpoint}/api/v1/namespaces/kube-system/services/kube-dns:dns/proxy\n\nTo further debug and diagnose cluster problems, use 'kubectl cluster-info dump'.\n`); }
    case 'scale': {
      const o = parse(rest); const t = target(sh, o, ['Deployment']); if ('code' in t) return t;
      const n = val(o, 'replicas'); if (n === undefined) return E('error: required flag(s) "replicas" not set');
      try { K.scaleDeployment(t.cx.c, t.obj, Number(n)); } catch (e) { if (e instanceof K.KubeError) return E(e.message); throw e; }
      K.reconcile(sh.s, t.cx.c); return ok(`deployment.apps/${t.obj.metadata.name} scaled\n`);
    }
    case 'set': {
      if (rest[0] !== 'image') return E(`error: unknown command "${rest[0] ?? ''}"`);
      const o = parse(rest.slice(1)); const t = target(sh, o, ['Deployment', 'Pod', 'DaemonSet']); if ('code' in t) return t;
      const pairs = o.pos.slice(o.pos[0]?.includes('/') ? 1 : 2); if (!pairs.length) return E('error: at least one image update is required');
      try { for (const p of pairs) { const [cn, img] = p.split('='); K.setImage(t.cx.c, t.obj, cn, img); } } catch (e) { if (e instanceof K.KubeError) return E(e.message); throw e; }
      K.reconcile(sh.s, t.cx.c); return ok(`${K.qualified(t.obj)} image updated\n`);
    }
    default: return E(`error: unknown command "${sub}" for "kubectl"\n\nDid you mean this?\n\tget\nRun 'kubectl --help' for usage.`);
  }
});

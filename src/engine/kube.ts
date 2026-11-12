// Mini-motor de Kubernetes ligado a un clúster de EKS: namespaces, pods, deployments (con ReplicaSets y
// actualizaciones progresivas), daemonsets, services, configmaps y secrets. Los controladores se evalúan de forma
// perezosa (`reconcile`) a partir de los instantes de creación, igual que el resto de servicios del simulador.
import type { CloudState } from './types';
import { guid, hex, now, randomString } from './util';
import { speedFactor } from './store';
import { check } from './api';
import { INSTANCE_TYPES } from './catalog';
import { cs, defaultMeta, resolveImage, sha, simulateRun, webBody, type EksCluster, type ImageMeta } from './services/containerCore';

export class KubeError extends Error {
  constructor(message: string, public code = 1) { super(message); this.name = 'KubeError'; }
}

export interface KObj {
  kind: string;
  apiVersion: string;
  metadata: { name: string; namespace?: string; uid: string; creationTimestamp: number; labels?: Record<string, string>; annotations?: Record<string, string>; generation?: number; resourceVersion: string; owner?: { kind: string; name: string } };
  spec?: any;
  data?: Record<string, string>;
  type?: string;
  status?: any;
}
export interface KEvent { ts: number; ns: string; kind: string; name: string; type: 'Normal' | 'Warning'; reason: string; message: string; from: string }
export interface KubeState { objects: KObj[]; events: KEvent[]; seq: number }

export const newKube = (): KubeState => ({ objects: [], events: [], seq: 1 });

// ------------------------------------------------------------------ tipos de recurso

interface KindInfo { kind: string; api: string; plural: string; short: string[]; namespaced: boolean; singular: string; group: string }
export const KINDS: KindInfo[] = [
  { kind: 'Pod', api: 'v1', plural: 'pods', short: ['po'], namespaced: true, singular: 'pod', group: '' },
  { kind: 'Deployment', api: 'apps/v1', plural: 'deployments', short: ['deploy'], namespaced: true, singular: 'deployment', group: 'apps' },
  { kind: 'ReplicaSet', api: 'apps/v1', plural: 'replicasets', short: ['rs'], namespaced: true, singular: 'replicaset', group: 'apps' },
  { kind: 'DaemonSet', api: 'apps/v1', plural: 'daemonsets', short: ['ds'], namespaced: true, singular: 'daemonset', group: 'apps' },
  { kind: 'Service', api: 'v1', plural: 'services', short: ['svc'], namespaced: true, singular: 'service', group: '' },
  { kind: 'ConfigMap', api: 'v1', plural: 'configmaps', short: ['cm'], namespaced: true, singular: 'configmap', group: '' },
  { kind: 'Secret', api: 'v1', plural: 'secrets', short: [], namespaced: true, singular: 'secret', group: '' },
  { kind: 'Namespace', api: 'v1', plural: 'namespaces', short: ['ns'], namespaced: false, singular: 'namespace', group: '' },
  { kind: 'Node', api: 'v1', plural: 'nodes', short: ['no'], namespaced: false, singular: 'node', group: '' },
];
export const kindInfo = (kind: string) => KINDS.find((k) => k.kind === kind)!;
export function kindFromToken(t: string): KindInfo | undefined {
  const x = t.toLowerCase();
  return KINDS.find((k) => k.plural === x || k.singular === x || k.short.includes(x) || k.kind.toLowerCase() === x);
}
/** `deployment.apps/web`, `service/web`, `pod/x`. */
export const qualified = (o: KObj) => { const k = kindInfo(o.kind); return `${k.group ? `${k.singular}.${k.group}` : k.singular}/${o.metadata.name}`; };

// ------------------------------------------------------------------ acceso a objetos

const ver = (k: KubeState) => String(k.seq++);
export function find(c: EksCluster, kind: string, ns: string | undefined, name: string): KObj | undefined {
  return c.kube.objects.find((o) => o.kind === kind && o.metadata.name === name && (!kindInfo(kind).namespaced || o.metadata.namespace === ns));
}
export function list(c: EksCluster, kind: string, ns?: string): KObj[] {
  return c.kube.objects.filter((o) => o.kind === kind && (!ns || !kindInfo(kind).namespaced || o.metadata.namespace === ns));
}
const labelsOf = (o: KObj) => o.metadata.labels ?? {};
export function matchSelector(sel: Record<string, string> | undefined, labels: Record<string, string>): boolean {
  if (!sel || !Object.keys(sel).length) return false;
  return Object.entries(sel).every(([k, v]) => labels[k] === v);
}
/** Selector de etiquetas de kubectl (-l app=web,tier!=db). */
export function matchLabelExpr(expr: string | undefined, labels: Record<string, string>): boolean {
  if (!expr) return true;
  return expr.split(',').every((t) => {
    const m = /^([^!=\s]+)\s*(==|=|!=)\s*(.*)$/.exec(t.trim());
    if (m) return m[2] === '!=' ? labels[m[1]] !== m[3] : labels[m[1]] === m[3];
    return t.trim().startsWith('!') ? !(t.trim().slice(1) in labels) : t.trim() in labels;
  });
}

function addEvent(c: EksCluster, o: KObj, type: KEvent['type'], reason: string, message: string, from: string) {
  c.kube.events.push({ ts: now(), ns: o.metadata.namespace ?? '', kind: o.kind, name: o.metadata.name, type, reason, message, from });
  if (c.kube.events.length > 400) c.kube.events.splice(0, c.kube.events.length - 300);
}
export const eventsFor = (c: EksCluster, o: KObj) => c.kube.events.filter((e) => e.kind === o.kind && e.name === o.metadata.name && e.ns === (o.metadata.namespace ?? ''));

// ------------------------------------------------------------------ cantidades

export function cpuM(v: unknown): number {
  const t = String(v ?? '0');
  return t.endsWith('m') ? Number(t.slice(0, -1)) : Math.round(Number(t) * 1000);
}
export function memMi(v: unknown): number {
  const m = /^([\d.]+)\s*(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(String(v ?? '0'));
  if (!m) return 0;
  const n = Number(m[1]);
  const f: Record<string, number> = { Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024, K: 1000 / 1048576, M: 1e6 / 1048576, G: 1e9 / 1048576, T: 1e12 / 1048576 };
  return n * (f[m[2] ?? ''] ?? 1 / 1048576);
}
const MAX_PODS: Record<string, number> = { 't2.micro': 4, 't3.micro': 4, 't3.small': 11, 't3.medium': 17, 't3.large': 35, 'm5.large': 29, 'm5.xlarge': 58, 'c5.large': 29, 'r5.large': 29 };

// ------------------------------------------------------------------ nodos

interface NodeInfo { instanceId: string; nodegroup: string; roleArn: string; instanceType: string; cpu: number; mem: number; maxPods: number; ip: string; subnetId: string; az: string }
export const nodeName = (ip: string, region: string) => `ip-${ip.replace(/\./g, '-')}.${region}.compute.internal`;

/** Sincroniza los objetos Node con las instancias de EC2 de los grupos de nodos. */
function syncNodes(s: CloudState, c: EksCluster) {
  const f = speedFactor();
  const want = new Map<string, NodeInfo & { ready: boolean; created: number }>();
  for (const ng of c.nodegroups) {
    if (ng.status !== 'ACTIVE' && ng.status !== 'UPDATING') continue;
    for (const i of s.instances) {
      if (i.tags['eks:cluster-name'] !== c.name || i.tags['eks:nodegroup-name'] !== ng.name || i.state === 'terminated' || i.state === 'shutting-down') continue;
      const it = INSTANCE_TYPES[i.type] ?? INSTANCE_TYPES['t3.medium'];
      const ready = i.state === 'running' && (f === 0 || now() - Date.parse(i.launchTime) >= 14_000 * f);
      want.set(nodeName(i.privateIp, c.region), { instanceId: i.id, nodegroup: ng.name, roleArn: ng.nodeRole, instanceType: i.type, cpu: it.vcpu * 1000 - 70, mem: Math.round(it.memGiB * 1024 * 0.81), maxPods: MAX_PODS[i.type] ?? 17, ip: i.privateIp, subnetId: i.subnetId, az: i.az, ready, created: Date.parse(i.launchTime) });
    }
  }
  c.kube.objects = c.kube.objects.filter((o) => o.kind !== 'Node' || (want.has(o.metadata.name) && want.get(o.metadata.name)!.ready));
  for (const [name, n] of want) {
    if (!n.ready) continue;
    const ex = find(c, 'Node', undefined, name);
    if (ex) { ex.status.info = n; continue; }
    c.kube.objects.push({
      kind: 'Node', apiVersion: 'v1', metadata: { name, uid: guid(), creationTimestamp: now(), resourceVersion: ver(c.kube), labels: { 'beta.kubernetes.io/instance-type': n.instanceType, 'kubernetes.io/hostname': name, 'topology.kubernetes.io/zone': n.az, 'topology.kubernetes.io/region': c.region, 'node.kubernetes.io/instance-type': n.instanceType, 'eks.amazonaws.com/nodegroup': n.nodegroup, 'eks.amazonaws.com/capacityType': 'ON_DEMAND', 'kubernetes.io/os': 'linux', 'kubernetes.io/arch': 'amd64' } },
      status: { info: n },
    });
  }
}
const readyNodes = (c: EksCluster): KObj[] => list(c, 'Node');
export const nodeInfo = (n: KObj): NodeInfo => n.status.info;
const podsOnNode = (c: EksCluster, node: string) => list(c, 'Pod').filter((p) => p.status?.node === node && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed');
export function nodeUsage(c: EksCluster, n: KObj) {
  const pods = podsOnNode(c, n.metadata.name);
  const req = (p: KObj, k: 'cpu' | 'memory') => (p.spec.containers as any[]).reduce((a, ct) => a + (k === 'cpu' ? cpuM(ct.resources?.requests?.cpu) : memMi(ct.resources?.requests?.memory)), 0);
  return { pods: pods.length, cpu: pods.reduce((a, p) => a + req(p, 'cpu'), 0), mem: pods.reduce((a, p) => a + req(p, 'memory'), 0), list: pods };
}

// ------------------------------------------------------------------ plantillas y controladores

const stable = (v: any): string => (v && typeof v === 'object' ? (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${k}:${stable(v[k])}`).join(',')}}`) : JSON.stringify(v));
const hashOf = (v: unknown) => { const h = [...stable(v)].reduce((a, ch) => (Math.imul(a, 31) + ch.charCodeAt(0)) >>> 0, 7); return h.toString(36).padStart(7, '0').replace(/[aeiou01]/g, 'b') + 'd8'; };
const rsHash = (dep: KObj) => hashOf(dep.spec.template);
const suffix = () => randomString(5, 'bcdfghjklmnpqrstvwxz2456789');

function mkObj(c: EksCluster, kind: string, ns: string | undefined, name: string, extra: Partial<KObj> & { labels?: Record<string, string>; annotations?: Record<string, string> } = {}): KObj {
  const { labels, annotations, ...rest } = extra;
  return { kind, apiVersion: kindInfo(kind).api, metadata: { name, ...(kindInfo(kind).namespaced ? { namespace: ns } : {}), uid: guid(), creationTimestamp: now(), resourceVersion: ver(c.kube), ...(labels ? { labels } : {}), ...(annotations ? { annotations } : {}), generation: 1 }, ...rest };
}

const pct = (v: unknown, n: number, up: boolean): number => { const t = String(v); if (t.endsWith('%')) { const x = (Number(t.slice(0, -1)) / 100) * n; return up ? Math.ceil(x) : Math.floor(x); } return Number(t); };
const ownedBy = (o: KObj, kind: string, name: string) => o.metadata.owner?.kind === kind && o.metadata.owner.name === name;
const podReady = (p: KObj) => !!p.status?.ready;

function reconcileDeployments(c: EksCluster): boolean {
  let changed = false;
  for (const dep of list(c, 'Deployment')) {
    const ns = dep.metadata.namespace!;
    const rss = list(c, 'ReplicaSet', ns).filter((r) => ownedBy(r, 'Deployment', dep.metadata.name));
    const h = rsHash(dep);
    let cur = rss.find((r) => r.metadata.labels?.['pod-template-hash'] === h);
    const N = dep.spec.replicas ?? 1;
    const old = rss.filter((r) => r !== cur);
    if (!cur) {
      const revision = Math.max(0, ...rss.map((r) => Number(r.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0))) + 1;
      const tl = { ...(dep.spec.template.metadata?.labels ?? {}), 'pod-template-hash': h };
      cur = mkObj(c, 'ReplicaSet', ns, `${dep.metadata.name}-${h}`, { labels: tl, annotations: { 'deployment.kubernetes.io/desired-replicas': String(N), 'deployment.kubernetes.io/revision': String(revision) }, spec: { replicas: old.length ? 0 : N, selector: { matchLabels: tl }, template: { metadata: { labels: tl }, spec: JSON.parse(JSON.stringify(dep.spec.template.spec)) }, _tmpl: JSON.parse(JSON.stringify(dep.spec.template)) } });
      cur.metadata.owner = { kind: 'Deployment', name: dep.metadata.name };
      if (dep.metadata.annotations?.['kubernetes.io/change-cause']) cur.metadata.annotations!['kubernetes.io/change-cause'] = dep.metadata.annotations['kubernetes.io/change-cause'];
      c.kube.objects.push(cur);
      dep.metadata.annotations = { ...(dep.metadata.annotations ?? {}), 'deployment.kubernetes.io/revision': String(revision) };
      addEvent(c, dep, 'Normal', 'ScalingReplicaSet', `Scaled up replica set ${cur.metadata.name} to ${cur.spec.replicas}`, 'deployment-controller');
      changed = true;
    } else if (!old.length && cur.spec.replicas !== N) {
      addEvent(c, dep, 'Normal', 'ScalingReplicaSet', `Scaled ${N > cur.spec.replicas ? 'up' : 'down'} replica set ${cur.metadata.name} to ${N} from ${cur.spec.replicas}`, 'deployment-controller');
      cur.spec.replicas = N;
      changed = true;
    }
    if (old.length || cur.spec.replicas !== N) {
      // Actualización progresiva: maxSurge 25 % (hacia arriba) y maxUnavailable 25 % (hacia abajo).
      const ru = dep.spec.strategy?.rollingUpdate ?? {};
      let surge = pct(ru.maxSurge ?? '25%', N, true);
      const unavail = pct(ru.maxUnavailable ?? '25%', N, false);
      if (surge === 0 && unavail === 0) surge = 1;
      const oldCount = old.reduce((a, r) => a + r.spec.replicas, 0);
      const wantNew = Math.max(0, Math.min(N, N + surge - oldCount));
      if (cur.spec.replicas < wantNew) { addEvent(c, dep, 'Normal', 'ScalingReplicaSet', `Scaled up replica set ${cur.metadata.name} to ${wantNew} from ${cur.spec.replicas}`, 'deployment-controller'); cur.spec.replicas = wantNew; changed = true; }
      else if (cur.spec.replicas > N) { cur.spec.replicas = N; changed = true; }
      const available = [...rss, cur].reduce((a, r) => a + podsOf(c, r).filter(podReady).length, 0);
      let canDrop = Math.max(0, available - (N - unavail));
      for (const r of old.sort((a, b) => a.metadata.creationTimestamp - b.metadata.creationTimestamp)) {
        if (r.spec.replicas > 0 && canDrop > 0) {
          const drop = Math.min(r.spec.replicas, canDrop);
          addEvent(c, dep, 'Normal', 'ScalingReplicaSet', `Scaled down replica set ${r.metadata.name} to ${r.spec.replicas - drop} from ${r.spec.replicas}`, 'deployment-controller');
          r.spec.replicas -= drop; canDrop -= drop; changed = true;
        }
      }
      // Un ReplicaSet antiguo que no estaba listo (nunca llegó a servir) se reduce sin esperar a los nuevos.
      for (const r of old) if (r.spec.replicas > 0 && podsOf(c, r).filter(podReady).length === 0 && cur.spec.replicas >= N && podsOf(c, cur).filter(podReady).length >= N) { r.spec.replicas = 0; changed = true; }
    }
    // Limpia el historial (revisionHistoryLimit = 10).
    const zero = old.filter((r) => r.spec.replicas === 0).sort((a, b) => a.metadata.creationTimestamp - b.metadata.creationTimestamp);
    for (const r of zero.slice(0, Math.max(0, zero.length - 10))) c.kube.objects = c.kube.objects.filter((o) => o !== r);
  }
  return changed;
}
const podsOf = (c: EksCluster, rs: KObj) => list(c, 'Pod', rs.metadata.namespace).filter((p) => ownedBy(p, rs.kind, rs.metadata.name));

function reconcileReplicaSets(c: EksCluster): boolean {
  let changed = false;
  for (const rs of list(c, 'ReplicaSet')) {
    const pods = podsOf(c, rs);
    const n = rs.spec.replicas as number;
    if (pods.length < n) {
      for (let i = pods.length; i < n; i++) {
        const tmpl = rs.spec.template;
        const pod = mkObj(c, 'Pod', rs.metadata.namespace, `${rs.metadata.name}-${suffix()}`, { labels: { ...(tmpl.metadata?.labels ?? {}) }, annotations: tmpl.metadata?.annotations, spec: JSON.parse(JSON.stringify(tmpl.spec)), status: { phase: 'Pending', ready: false, state: 'Pending', restarts: 0, logs: [] } });
        pod.metadata.owner = { kind: 'ReplicaSet', name: rs.metadata.name };
        c.kube.objects.push(pod);
      }
      changed = true;
    } else if (pods.length > n) {
      // Se eliminan primero los pods no listos y después los más recientes.
      const order = [...pods].sort((a, b) => Number(podReady(a)) - Number(podReady(b)) || b.metadata.creationTimestamp - a.metadata.creationTimestamp);
      for (const p of order.slice(0, pods.length - n)) removePod(c, p);
      changed = true;
    }
  }
  return changed;
}
function removePod(c: EksCluster, p: KObj) { c.kube.objects = c.kube.objects.filter((o) => o !== p); }

function reconcileDaemonSets(c: EksCluster): boolean {
  let changed = false;
  const nodes = readyNodes(c);
  for (const ds of list(c, 'DaemonSet')) {
    const pods = list(c, 'Pod', ds.metadata.namespace).filter((p) => ownedBy(p, 'DaemonSet', ds.metadata.name));
    for (const n of nodes) {
      if (pods.some((p) => p.status.node === n.metadata.name)) continue;
      const tmpl = ds.spec.template;
      const pod = mkObj(c, 'Pod', ds.metadata.namespace, `${ds.metadata.name}-${suffix()}`, { labels: { ...(tmpl.metadata?.labels ?? {}) }, spec: JSON.parse(JSON.stringify(tmpl.spec)), status: { phase: 'Pending', ready: false, state: 'Pending', restarts: 0, logs: [], node: n.metadata.name, forced: true } });
      pod.metadata.owner = { kind: 'DaemonSet', name: ds.metadata.name };
      c.kube.objects.push(pod);
      changed = true;
    }
    for (const p of pods) if (!nodes.some((n) => n.metadata.name === p.status.node)) { removePod(c, p); changed = true; }
  }
  return changed;
}

// ------------------------------------------------------------------ pods: planificación y ciclo de vida

const usedIps = (s: CloudState): Set<string> => {
  const u = new Set<string>();
  for (const i of s.instances) u.add(i.privateIp);
  for (const t of cs(s).ecsTasks) u.add(t.privateIp);
  for (const k of cs(s).eks) for (const o of k.kube.objects) if (o.kind === 'Pod' && o.status?.ip) u.add(o.status.ip);
  return u;
};
export function allocIp(s: CloudState, subnetId: string): string {
  const sub = s.subnets.find((x) => x.id === subnetId);
  const [base, bits] = (sub?.cidr ?? '10.0.0.0/24').split('/');
  const o = base.split('.').map(Number);
  const used = usedIps(s);
  const size = 2 ** (32 - Number(bits));
  const start = o[0] * 2 ** 24 + o[1] * 65536 + o[2] * 256 + o[3];
  for (let n = 10; n < Math.min(size - 1, 250); n++) {
    const v = start + n;
    const ip = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
    if (!used.has(ip)) return ip;
  }
  return '10.0.0.250';
}

const pullErr = (image: string, why: string) => `Failed to pull image "${image}": rpc error: code = NotFound desc = failed to pull and unpack image "${image}": ${why}`;

function nodeRoleAllows(s: CloudState, roleArn: string, action: string): boolean {
  const name = roleArn.split('/').pop() ?? '';
  if (!s.roles.some((r) => r.name === name)) return false;
  return check({ s, region: s.region, caller: { type: 'AssumedRole', arn: `arn:aws:sts::${s.account.id}:assumed-role/${name}/node`, userName: 'node', roleName: name, mfa: false, sourceIp: 'ec2.amazonaws.com' } }, action, '*').decision === 'Allow';
}

function configError(c: EksCluster, pod: KObj): string | undefined {
  const ns = pod.metadata.namespace!;
  for (const ct of pod.spec.containers as any[]) {
    for (const ef of ct.envFrom ?? []) if (ef.configMapRef && !ef.configMapRef.optional && !find(c, 'ConfigMap', ns, ef.configMapRef.name)) return `configmap "${ef.configMapRef.name}" not found`;
    for (const e of ct.env ?? []) {
      const r = e.valueFrom?.configMapKeyRef;
      if (r) { const cm = find(c, 'ConfigMap', ns, r.name); if (!cm) return `configmap "${r.name}" not found`; if (!(r.key in (cm.data ?? {}))) return `couldn't find key ${r.key} in ConfigMap ${ns}/${r.name}`; }
    }
  }
  return undefined;
}

function containerEnv(c: EksCluster, pod: KObj, ct: any): Record<string, string> {
  const env: Record<string, string> = {};
  const ns = pod.metadata.namespace!;
  for (const ef of ct.envFrom ?? []) if (ef.configMapRef) Object.assign(env, find(c, 'ConfigMap', ns, ef.configMapRef.name)?.data ?? {});
  for (const e of ct.env ?? []) env[e.name] = e.valueFrom?.configMapKeyRef ? find(c, 'ConfigMap', ns, e.valueFrom.configMapKeyRef.name)?.data?.[e.valueFrom.configMapKeyRef.key] ?? '' : String(e.value ?? '');
  return env;
}

export function podMeta(s: CloudState, pod: KObj): ImageMeta | null {
  const r = resolveImage(s, pod.spec.containers[0].image);
  return r.ok ? r.meta : null;
}

function progressPod(s: CloudState, c: EksCluster, pod: KObj): boolean {
  const st = pod.status;
  const f = speedFactor();
  const t = now();
  const age = t - pod.metadata.creationTimestamp;
  const before = JSON.stringify([st.phase, st.state, st.ready, st.restarts, st.node]);
  const ev = (st.ev ??= {} as Record<string, boolean>);
  const once = (k: string, type: KEvent['type'], reason: string, msg: string, from = 'kubelet') => { if (!ev[k]) { ev[k] = true; addEvent(c, pod, type, reason, msg, from); } };
  const ns = pod.metadata.namespace!;
  const full = `${ns}/${pod.metadata.name}`;
  // 1. Planificación
  if (!st.node || !st.scheduled) {
    const nodes = readyNodes(c);
    const sel = pod.spec.nodeSelector as Record<string, string> | undefined;
    const cpu = (pod.spec.containers as any[]).reduce((a, ct) => a + cpuM(ct.resources?.requests?.cpu), 0);
    const mem = (pod.spec.containers as any[]).reduce((a, ct) => a + memMi(ct.resources?.requests?.memory), 0);
    const reasons: Record<string, number> = {};
    const pick = (st.forced ? nodes.filter((n) => n.metadata.name === st.node) : nodes).filter((n) => {
      if (sel && !Object.entries(sel).every(([k, v]) => n.metadata.labels?.[k] === v)) { reasons["node(s) didn't match Pod's node affinity/selector"] = (reasons["node(s) didn't match Pod's node affinity/selector"] ?? 0) + 1; return false; }
      const u = nodeUsage(c, n);
      const i = nodeInfo(n);
      if (u.pods + 1 > i.maxPods) { reasons['Too many pods'] = (reasons['Too many pods'] ?? 0) + 1; return false; }
      if (u.cpu + cpu > i.cpu) { reasons['Insufficient cpu'] = (reasons['Insufficient cpu'] ?? 0) + 1; return false; }
      if (u.mem + mem > i.mem) { reasons['Insufficient memory'] = (reasons['Insufficient memory'] ?? 0) + 1; return false; }
      return true;
    });
    if (!pick.length) {
      st.phase = 'Pending'; st.state = 'Pending'; st.ready = false;
      const why = !nodes.length ? 'no nodes available to schedule pods' : `0/${nodes.length} nodes are available: ${Object.entries(reasons).map(([k, v]) => `${v} ${k}`).join(', ')}. preemption: 0/${nodes.length} nodes are available: ${nodes.length} No preemption victims found for incoming pod.`;
      st.pendingMessage = why;
      once('sched', 'Warning', 'FailedScheduling', why, 'default-scheduler');
    } else {
      const n = pick.sort((a, b) => nodeUsage(c, a).pods - nodeUsage(c, b).pods)[0];
      st.node = n.metadata.name; st.scheduled = t; st.ip = allocIp(s, nodeInfo(n).subnetId); st.hostIp = nodeInfo(n).ip;
      addEvent(c, pod, 'Normal', 'Scheduled', `Successfully assigned ${full} to ${n.metadata.name}`, 'default-scheduler');
    }
  }
  if (st.scheduled) {
    const node = find(c, 'Node', undefined, st.node);
    if (!node) { st.phase = 'Failed'; st.state = 'Unknown'; st.ready = false; }
    else {
      const since = t - st.scheduled;
      const img = pod.spec.containers[0].image as string;
      const cfg = configError(c, pod);
      const r = isSystemImage(img) ? ({ ok: true, meta: { ...defaultMeta(img), resident: true }, source: 'public' } as const) : resolveImage(s, img);
      let pullErrMsg: string | undefined;
      if (!r.ok) pullErrMsg = r.reason === 'TagNotFound' || r.reason === 'NotFound' ? pullErr(img, `${img}: not found`) : r.reason === 'RepositoryNotFound' ? pullErr(img, `${img}: not found`) : `Failed to pull image "${img}": rpc error: code = Unknown desc = failed to pull and unpack image "${img}": failed to resolve reference "${img}": pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed`;
      else if (r.source === 'ecr' && !(nodeRoleAllows(s, nodeInfo(node).roleArn, 'ecr:GetAuthorizationToken') && nodeRoleAllows(s, nodeInfo(node).roleArn, 'ecr:BatchGetImage'))) pullErrMsg = `Failed to pull image "${img}": rpc error: code = Unknown desc = failed to pull and unpack image "${img}": failed to resolve reference "${img}": unexpected status from HEAD request to https://${img.split('/')[0]}/v2/${img.split('/').slice(1).join('/').split(':')[0]}/manifests/${img.split(':').pop()}: 401 Unauthorized`;
      const pulled = since >= 3000 * f;
      if (cfg && pulled) { st.state = 'CreateContainerConfigError'; st.phase = 'Pending'; st.ready = false; once('cfg', 'Warning', 'Failed', `Error: ${cfg}`); }
      else if (!pulled) { st.state = 'ContainerCreating'; st.phase = 'Pending'; st.ready = false; once('pulling', 'Normal', 'Pulling', `Pulling image "${img}"`); }
      else if (pullErrMsg) {
        once('pullfail', 'Warning', 'Failed', pullErrMsg);
        once('errpull', 'Warning', 'Failed', 'Error: ErrImagePull');
        once('backoff', 'Normal', 'BackOff', `Back-off pulling image "${img}"`);
        once('ipbo', 'Warning', 'Failed', 'Error: ImagePullBackOff');
        st.state = f === 0 || since >= 10_000 * f ? 'ImagePullBackOff' : 'ErrImagePull'; st.phase = 'Pending'; st.ready = false; st.pullError = pullErrMsg;
      } else if (r.ok) {
        once('pulled', 'Normal', 'Pulled', `Successfully pulled image "${img}" in 1.2s (1.2s including waiting)`);
        once('created', 'Normal', 'Created', `Created container ${pod.spec.containers[0].name}`);
        once('started', 'Normal', 'Started', `Started container ${pod.spec.containers[0].name}`);
        const ct = pod.spec.containers[0];
        const entry = ct.command ?? r.meta.entrypoint ?? [];
        const args = ct.args ?? (ct.command ? [] : r.meta.cmd ?? []);
        const res = simulateRun({ ...r.meta, entrypoint: undefined, cmd: undefined }, { command: [...entry, ...args], env: containerEnv(c, pod, ct), host: pod.metadata.name });
        const startedAt = st.scheduled + 3000 * f;
        st.startedAt = startedAt;
        if (res.execError) { st.state = 'RunContainerError'; st.phase = 'Pending'; st.ready = false; once('exec', 'Warning', 'Failed', `Error: failed to create containerd task: ${res.execError}`); }
        else if (res.resident) {
          const ok = t - startedAt >= 1500 * f;
          st.phase = 'Running'; st.state = 'Running'; st.ready = ok; st.logs = res.lines;
        } else {
          st.logs = res.lines; st.exitCode = res.exitCode;
          const policy = pod.spec.restartPolicy ?? 'Always';
          if (policy === 'Always' || (policy === 'OnFailure' && res.exitCode !== 0)) {
            const restarts = Math.max(1, Math.floor((t - startedAt) / (15_000 * Math.max(f, 0.2))) + 1);
            st.restarts = Math.min(restarts, 12); st.phase = 'Running'; st.state = 'CrashLoopBackOff'; st.ready = false;
            once('crash', 'Warning', 'BackOff', `Back-off restarting failed container ${ct.name} in pod ${pod.metadata.name}_${ns}(${pod.metadata.uid})`);
            st.lastExit = res.exitCode;
          } else { st.phase = res.exitCode === 0 ? 'Succeeded' : 'Failed'; st.state = res.exitCode === 0 ? 'Completed' : 'Error'; st.ready = false; }
        }
      }
    }
  }
  return before !== JSON.stringify([st.phase, st.state, st.ready, st.restarts, st.node]);
}

// ------------------------------------------------------------------ services

export function serviceEndpoints(c: EksCluster, svc: KObj): { ip: string; port: number; pod: KObj }[] {
  const out: { ip: string; port: number; pod: KObj }[] = [];
  for (const p of list(c, 'Pod', svc.metadata.namespace)) {
    if (!podReady(p) || !matchSelector(svc.spec.selector, labelsOf(p))) continue;
    for (const sp of svc.spec.ports ?? []) {
      const tp = typeof sp.targetPort === 'string' && !/^\d+$/.test(sp.targetPort) ? (p.spec.containers as any[]).flatMap((ct) => ct.ports ?? []).find((x) => x.name === sp.targetPort)?.containerPort : Number(sp.targetPort ?? sp.port);
      if (tp) out.push({ ip: p.status.ip, port: tp, pod: p });
    }
  }
  return out;
}
export const lbHost = (c: EksCluster, svc: KObj) => `a${sha(svc.metadata.uid).slice(0, 32)}-${String(parseInt(sha(svc.metadata.uid).slice(32, 40), 16)).padEnd(10, '1').slice(0, 10)}.${c.region}.elb.amazonaws.com`;

function reconcileServices(c: EksCluster): boolean {
  let changed = false;
  const f = speedFactor();
  for (const svc of list(c, 'Service')) {
    const st = (svc.status ??= {});
    if (!st.clusterIP) {
      st.clusterIP = svc.spec.clusterIP ?? `10.100.${Math.floor(parseInt(svc.metadata.uid.slice(0, 4), 16) % 250)}.${1 + (parseInt(svc.metadata.uid.slice(4, 8), 16) % 250)}`;
      changed = true;
    }
    for (const p of svc.spec.ports ?? []) {
      if ((svc.spec.type === 'NodePort' || svc.spec.type === 'LoadBalancer') && !p.nodePort) { p.nodePort = 30000 + (parseInt(hex(4), 16) % 2767); changed = true; }
      if (svc.spec.type === 'ClusterIP' && p.nodePort) delete p.nodePort;
    }
    if (svc.spec.type === 'LoadBalancer') {
      if (!st.lbHost && now() - svc.metadata.creationTimestamp >= 12_000 * f) { st.lbHost = lbHost(c, svc); addEvent(c, svc, 'Normal', 'EnsuredLoadBalancer', 'Ensured load balancer', 'service-controller'); changed = true; }
      if (!st.lbEv) { st.lbEv = true; addEvent(c, svc, 'Normal', 'EnsuringLoadBalancer', 'Ensuring load balancer', 'service-controller'); }
    } else if (st.lbHost) { st.lbHost = undefined; }
  }
  return changed;
}

// ------------------------------------------------------------------ bucle principal

/** Evalúa los controladores hasta alcanzar un punto estable para el instante actual. */
export function reconcile(s: CloudState, c: EksCluster) {
  if (c.status !== 'ACTIVE') return;
  syncNodes(s, c);
  // Los pods de nodos que ya no existen se pierden; sus controladores los recrean en otros nodos.
  for (const p of list(c, 'Pod')) if (p.status?.scheduled && !find(c, 'Node', undefined, p.status.node) && p.metadata.owner) removePod(c, p);
  for (let i = 0; i < 40; i++) {
    let ch = reconcileDeployments(c);
    ch = reconcileReplicaSets(c) || ch;
    ch = reconcileDaemonSets(c) || ch;
    for (const p of list(c, 'Pod')) ch = progressPod(s, c, p) || ch;
    ch = reconcileServices(c) || ch;
    if (!ch) break;
  }
}

/** Seed de un clúster nuevo: namespaces del sistema y componentes por defecto. */
export function seedCluster(c: EksCluster) {
  for (const n of ['default', 'kube-system', 'kube-public', 'kube-node-lease']) c.kube.objects.push(mkObj(c, 'Namespace', undefined, n, { labels: { 'kubernetes.io/metadata.name': n }, status: { phase: 'Active' } }));
  const sys = (kind: string, name: string, spec: any, labels: Record<string, string>) => c.kube.objects.push(mkObj(c, kind, 'kube-system', name, { labels, spec }));
  const pod = (name: string, image: string) => ({ metadata: { labels: { 'k8s-app': name } }, spec: { containers: [{ name, image, resources: { requests: name === 'coredns' ? { cpu: '100m', memory: '70Mi' } : { cpu: name === 'aws-node' ? '25m' : '100m' } } }] } });
  sys('Deployment', 'coredns', { replicas: 2, selector: { matchLabels: { 'k8s-app': 'coredns' } }, template: pod('coredns', `602401143452.dkr.ecr.${c.region}.amazonaws.com/eks/coredns:v1.11.3-eksbuild.2`) }, { 'k8s-app': 'kube-dns' });
  sys('DaemonSet', 'kube-proxy', { selector: { matchLabels: { 'k8s-app': 'kube-proxy' } }, template: pod('kube-proxy', `602401143452.dkr.ecr.${c.region}.amazonaws.com/eks/kube-proxy:v1.31.2-minimal-eksbuild.3`) }, { 'k8s-app': 'kube-proxy' });
  sys('DaemonSet', 'aws-node', { selector: { matchLabels: { 'k8s-app': 'aws-node' } }, template: pod('aws-node', `602401143452.dkr.ecr.${c.region}.amazonaws.com/amazon-k8s-cni:v1.19.0-eksbuild.1`) }, { 'k8s-app': 'aws-node' });
  c.kube.objects.push(mkObj(c, 'Service', 'default', 'kubernetes', { labels: { component: 'apiserver', provider: 'kubernetes' }, spec: { type: 'ClusterIP', ports: [{ name: 'https', port: 443, protocol: 'TCP', targetPort: 443 }] } }));
  c.kube.objects.push(mkObj(c, 'Service', 'kube-system', 'kube-dns', { labels: { 'k8s-app': 'kube-dns' }, spec: { type: 'ClusterIP', selector: { 'k8s-app': 'coredns' }, ports: [{ name: 'dns', port: 53, protocol: 'UDP', targetPort: 53 }] } }));
}

// Los pods del sistema usan imágenes de la cuenta de AWS de EKS: se consideran siempre disponibles.
// (resolveImage no las conoce, así que se tratan aparte al crear la vista del pod.)
export const isSystemImage = (img: string) => img.startsWith('602401143452.dkr.ecr.');

// ------------------------------------------------------------------ operaciones (apply, delete, scale…)

const NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
let CUR = { file: 'manifest', creating: true };
const bad = (kind: string, name: string, msg: string) => { const g = kindInfo(kind)?.group; const api = g ? `${kind}.${g}` : kind; return new KubeError(CUR.creating ? `Error from server (Invalid): error when creating "${CUR.file}": ${api} "${name}" is invalid: ${msg}` : `The ${kind} "${name}" is invalid: ${msg}`); };

function validate(doc: any): void {
  const kind = doc.kind as string;
  const name = doc.metadata?.name as string;
  const info = KINDS.find((k) => k.kind === kind);
  if (!info) throw new KubeError(`resource mapping not found for name: "${name}" namespace: "${doc.metadata?.namespace ?? ''}" from "{FILE}": no matches for kind "${kind}" in version "${doc.apiVersion}"\nensure CRDs are installed first`);
  if (info.api !== doc.apiVersion) throw new KubeError(`resource mapping not found for name: "${name}" namespace: "${doc.metadata?.namespace ?? ''}" from "{FILE}": no matches for kind "${kind}" in version "${doc.apiVersion}"\nensure CRDs are installed first`);
  if (!name) throw new KubeError(`error validating "{FILE}": error validating data: ${'metadata.name'} missing; if you choose to ignore these errors, turn validation off with --validate=false`);
  if (!NAME_RE.test(name) || name.length > 253) throw bad(kind, name, `metadata.name: Invalid value: "${name}": a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character`);
  const cts = (spec: any) => spec?.containers as any[] | undefined;
  const checkPod = (spec: any, path: string) => {
    if (!cts(spec)?.length) throw bad(kind, name, `${path}.containers: Required value`);
    cts(spec)!.forEach((ct, i) => { if (!ct.name) throw bad(kind, name, `${path}.containers[${i}].name: Required value`); if (!ct.image) throw bad(kind, name, `${path}.containers[${i}].image: Required value`); });
  };
  if (kind === 'Pod') checkPod(doc.spec, 'spec');
  if (kind === 'Deployment' || kind === 'DaemonSet') {
    const sel = doc.spec?.selector?.matchLabels;
    if (!sel || !Object.keys(sel).length) throw bad(kind, name, 'spec.selector: Required value');
    const tl = doc.spec?.template?.metadata?.labels ?? {};
    if (!Object.entries(sel).every(([k, v]) => tl[k] === v)) throw bad(kind, name, `spec.template.metadata.labels: Invalid value: map[string]string{${Object.entries(tl).map(([k, v]) => `"${k}":"${v}"`).join(', ')}}: \`selector\` does not match template \`labels\``);
    checkPod(doc.spec?.template?.spec, 'spec.template.spec');
    if (kind === 'Deployment' && doc.spec.replicas !== undefined && (!Number.isInteger(Number(doc.spec.replicas)) || Number(doc.spec.replicas) < 0)) throw bad(kind, name, `spec.replicas: Invalid value: ${doc.spec.replicas}: must be greater than or equal to 0`);
  }
  if (kind === 'Service') {
    const ports = doc.spec?.ports;
    if (!Array.isArray(ports) || !ports.length) throw bad(kind, name, 'spec.ports: Required value');
    if (doc.spec.type && !['ClusterIP', 'NodePort', 'LoadBalancer'].includes(doc.spec.type)) throw bad(kind, name, `spec.type: Unsupported value: "${doc.spec.type}": supported values: "ClusterIP", "ExternalName", "LoadBalancer", "NodePort"`);
    ports.forEach((p: any, i: number) => { if (!(Number(p.port) >= 1 && Number(p.port) <= 65535)) throw bad(kind, name, `spec.ports[${i}].port: Invalid value: ${p.port}: must be between 1 and 65535, inclusive`); });
  }
}

export interface ApplyResult { obj: KObj; verb: 'created' | 'configured' | 'unchanged' }

/** `kubectl apply` de un documento ya interpretado (YAML → objeto). */
export function applyDoc(c: EksCluster, doc: any, defaultNs: string, file = 'manifest'): ApplyResult {
  if (!doc || typeof doc !== 'object' || !doc.kind) throw new KubeError(`error: error validating "${file}": error validating data: [apiVersion not set, kind not set]; if you choose to ignore these errors, turn validation off with --validate=false`);
  CUR = { file, creating: !(KINDS.some((k) => k.kind === doc.kind) && doc.metadata?.name && find(c, doc.kind, kindInfo(doc.kind).namespaced ? doc.metadata.namespace ?? defaultNs : undefined, doc.metadata.name)) };
  try { validate(doc); } catch (e) { if (e instanceof KubeError) e.message = e.message.replace('{FILE}', file); throw e; }
  const info = kindInfo(doc.kind);
  const ns = info.namespaced ? doc.metadata.namespace ?? defaultNs : undefined;
  if (ns && !find(c, 'Namespace', undefined, ns)) throw new KubeError(`Error from server (NotFound): error when creating "${file}": namespaces "${ns}" not found`);
  const name = doc.metadata.name as string;
  const ex = find(c, doc.kind, ns, name);
  const spec = JSON.parse(JSON.stringify(doc.spec ?? {}));
  if (doc.kind === 'Deployment') spec.replicas ??= 1;
  if (doc.kind === 'Service') { spec.type ??= 'ClusterIP'; for (const p of spec.ports) { p.protocol ??= 'TCP'; p.targetPort ??= p.port; p.port = Number(p.port); } }
  const labels = doc.metadata.labels as Record<string, string> | undefined;
  const annotations = doc.metadata.annotations as Record<string, string> | undefined;
  let data: Record<string, string> | undefined;
  if (doc.kind === 'ConfigMap') data = Object.fromEntries(Object.entries(doc.data ?? {}).map(([k, v]) => [k, String(v)]));
  if (doc.kind === 'Secret') data = { ...Object.fromEntries(Object.entries(doc.data ?? {})), ...Object.fromEntries(Object.entries(doc.stringData ?? {}).map(([k, v]) => [k, btoa(String(v))])) } as Record<string, string>;
  if (!ex) {
    const o = mkObj(c, doc.kind, ns, name, { labels, annotations, spec: doc.kind === 'ConfigMap' || doc.kind === 'Secret' || doc.kind === 'Namespace' ? undefined : spec, data, type: doc.kind === 'Secret' ? doc.type ?? 'Opaque' : undefined });
    if (doc.kind === 'Pod') o.status = { phase: 'Pending', ready: false, state: 'Pending', restarts: 0, logs: [] };
    if (doc.kind === 'Namespace') { o.status = { phase: 'Active' }; o.metadata.labels = { ...(labels ?? {}), 'kubernetes.io/metadata.name': name }; }
    if (doc.kind === 'Service') o.status = {};
    c.kube.objects.push(o);
    return { obj: o, verb: 'created' };
  }
  const noNodePort = (sp: any) => { if (!sp) return null; const x = JSON.parse(JSON.stringify(stripRuntime(sp))); for (const p of x.ports ?? []) delete p.nodePort; return x; };
  const noSpecKinds = doc.kind === 'ConfigMap' || doc.kind === 'Secret' || doc.kind === 'Namespace';
  const same = noSpecKinds || stable(noNodePort(ex.spec)) === stable(noNodePort(spec));
  const sameData = stable(ex.data ?? null) === stable(data ?? null);
  const sameLabels = stable(ex.metadata.labels ?? {}) === stable({ ...(labels ?? {}), ...(doc.kind === 'Namespace' ? { 'kubernetes.io/metadata.name': name } : {}) });
  if (same && sameData && sameLabels) return { obj: ex, verb: 'unchanged' };
  if (doc.kind === 'Pod') {
    const cur = ex.spec.containers as any[];
    const nxt = spec.containers as any[];
    const onlyImage = cur.length === nxt.length && stable(cur.map((x) => ({ ...x, image: '' }))) === stable(nxt.map((x) => ({ ...x, image: '' })));
    if (!onlyImage) throw new KubeError(`The Pod "${name}" is invalid: spec: Forbidden: pod updates may not change fields other than \`spec.containers[*].image\`, \`spec.initContainers[*].image\`, \`spec.activeDeadlineSeconds\`, \`spec.tolerations\` (only additions to existing tolerations) or \`spec.terminationGracePeriodSeconds\` (allow it to be set to 1 if it was previously negative)\n`);
    ex.spec = spec; ex.status = { ...ex.status, phase: 'Pending', state: 'ContainerCreating', ready: false, scheduled: now(), ev: {}, restarts: 0 };
  } else if (doc.kind === 'Service') {
    const keep = ex.spec.ports as any[];
    for (const p of spec.ports) { const o = keep.find((k) => k.port === p.port); if (o?.nodePort && spec.type !== 'ClusterIP') p.nodePort ??= o.nodePort; }
    ex.spec = spec;
  } else if (doc.kind !== 'ConfigMap' && doc.kind !== 'Secret' && doc.kind !== 'Namespace') {
    if (stable(ex.spec.template) !== stable(spec.template)) ex.metadata.generation = (ex.metadata.generation ?? 1) + 1;
    ex.spec = spec;
  }
  if (data) ex.data = data;
  ex.metadata.labels = doc.kind === 'Namespace' ? { ...(labels ?? {}), 'kubernetes.io/metadata.name': name } : labels;
  if (annotations) ex.metadata.annotations = { ...(ex.metadata.annotations ?? {}), ...annotations };
  ex.metadata.resourceVersion = ver(c.kube);
  return { obj: ex, verb: 'configured' };
}
const stripRuntime = (spec: any) => { const { _tmpl, ...r } = spec; void _tmpl; return r; };

const SYSTEM_NS = new Set(['default', 'kube-system', 'kube-public', 'kube-node-lease']);
export function deleteObj(c: EksCluster, o: KObj): void {
  if (o.kind === 'Namespace') {
    if (SYSTEM_NS.has(o.metadata.name)) throw new KubeError(`Error from server (Forbidden): namespaces "${o.metadata.name}" is forbidden: this namespace may not be deleted`);
    c.kube.objects = c.kube.objects.filter((x) => x !== o && x.metadata.namespace !== o.metadata.name);
    return;
  }
  if (o.kind === 'Node') throw new KubeError(`Error from server (Forbidden): nodes "${o.metadata.name}" is forbidden: nodes are managed by the node group`);
  const cascade = (owner: KObj) => { for (const ch of c.kube.objects.filter((x) => x.metadata.owner && x.metadata.owner.kind === owner.kind && x.metadata.owner.name === owner.metadata.name && x.metadata.namespace === owner.metadata.namespace)) { c.kube.objects = c.kube.objects.filter((x) => x !== ch); cascade(ch); } };
  cascade(o);
  c.kube.objects = c.kube.objects.filter((x) => x !== o);
}
export function scaleDeployment(c: EksCluster, dep: KObj, n: number) {
  if (!Number.isInteger(n) || n < 0) throw new KubeError(`error: --replicas=${n} is invalid`);
  dep.spec.replicas = n;
  dep.metadata.resourceVersion = ver(c.kube);
}
export function setImage(c: EksCluster, o: KObj, container: string, image: string) {
  const spec = o.kind === 'Pod' ? o.spec : o.spec.template.spec;
  const ct = (spec.containers as any[]).find((x) => x.name === container || container === '*');
  if (!ct) throw new KubeError(`error: unable to find container named "${container}"`);
  ct.image = image;
  if (o.kind !== 'Pod') o.metadata.generation = (o.metadata.generation ?? 1) + 1;
  else o.status = { ...o.status, phase: 'Pending', state: 'ContainerCreating', scheduled: now(), ev: {} };
  o.metadata.resourceVersion = ver(c.kube);
}
export function rolloutRestart(c: EksCluster, dep: KObj) {
  dep.spec.template.metadata ??= {};
  dep.spec.template.metadata.annotations = { ...(dep.spec.template.metadata.annotations ?? {}), 'kubectl.kubernetes.io/restartedAt': new Date(now()).toISOString() };
  dep.metadata.generation = (dep.metadata.generation ?? 1) + 1;
  dep.metadata.resourceVersion = ver(c.kube);
}
export function revisions(c: EksCluster, dep: KObj): KObj[] {
  return list(c, 'ReplicaSet', dep.metadata.namespace).filter((r) => ownedBy(r, 'Deployment', dep.metadata.name)).sort((a, b) => Number(a.metadata.annotations?.['deployment.kubernetes.io/revision']) - Number(b.metadata.annotations?.['deployment.kubernetes.io/revision']));
}
export function rolloutUndo(c: EksCluster, dep: KObj, toRevision?: number): number {
  const revs = revisions(c, dep);
  const curHash = rsHash(dep);
  const target = toRevision ? revs.find((r) => Number(r.metadata.annotations?.['deployment.kubernetes.io/revision']) === toRevision) : [...revs].reverse().find((r) => r.metadata.labels?.['pod-template-hash'] !== curHash);
  if (!target) throw new KubeError(toRevision ? `error: unable to find specified revision ${toRevision} in history` : 'error: no rollout history found for deployment "' + dep.metadata.name + '"');
  dep.spec.template = JSON.parse(JSON.stringify(target.spec._tmpl));
  dep.metadata.generation = (dep.metadata.generation ?? 1) + 1;
  return Number(target.metadata.annotations?.['deployment.kubernetes.io/revision']);
}

// ------------------------------------------------------------------ estado derivado

export function depStatus(c: EksCluster, dep: KObj) {
  const rss = revisions(c, dep);
  const h = rsHash(dep);
  const cur = rss.find((r) => r.metadata.labels?.['pod-template-hash'] === h);
  const pods = rss.flatMap((r) => podsOf(c, r));
  const ready = pods.filter(podReady).length;
  const updated = cur ? podsOf(c, cur).length : 0;
  const replicas = pods.length;
  const want = dep.spec.replicas ?? 1;
  return { replicas, updated, ready, available: ready, unavailable: Math.max(0, want - ready), want, cur, done: updated === want && replicas === want && ready === want };
}
export function dsStatus(c: EksCluster, ds: KObj) {
  const pods = list(c, 'Pod', ds.metadata.namespace).filter((p) => ownedBy(p, 'DaemonSet', ds.metadata.name));
  return { desired: readyNodes(c).length, current: pods.length, ready: pods.filter(podReady).length };
}
export function rsStatus(c: EksCluster, rs: KObj) {
  const pods = podsOf(c, rs);
  return { desired: rs.spec.replicas as number, current: pods.length, ready: pods.filter(podReady).length };
}

/** Texto de un `kubectl rollout status` (sin esperar): devuelve las líneas y si terminó. */
export function rolloutProgress(c: EksCluster, dep: KObj): { lines: string[]; done: boolean } {
  const st = depStatus(c, dep);
  const name = dep.metadata.name;
  if (st.done) return { lines: [`deployment "${name}" successfully rolled out`], done: true };
  const lines: string[] = [];
  if (st.updated < st.want) lines.push(`Waiting for deployment "${name}" rollout to finish: ${st.updated} out of ${st.want} new replicas have been updated...`);
  else if (st.replicas > st.updated) lines.push(`Waiting for deployment "${name}" rollout to finish: ${st.replicas - st.updated} old replicas are pending termination...`);
  else lines.push(`Waiting for deployment "${name}" rollout to finish: ${st.ready} of ${st.want} updated replicas are available...`);
  return { lines, done: false };
}

/** Logs de un pod (últimas `tail` líneas). */
export function podLogs(c: EksCluster, pod: KObj, tail?: number): string[] {
  const st = pod.status;
  if (!st?.scheduled || ['ContainerCreating', 'Pending', 'ErrImagePull', 'ImagePullBackOff', 'CreateContainerConfigError'].includes(st.state)) throw new KubeError(`Error from server (BadRequest): container "${pod.spec.containers[0].name}" in pod "${pod.metadata.name}" is waiting to start: ${st?.state === 'ContainerCreating' ? 'ContainerCreating' : st?.state ?? 'PodInitializing'}`);
  const lines = [...(st.logs ?? [])];
  return tail !== undefined && tail >= 0 ? lines.slice(-tail) : lines;
}

/** Resuelve un nombre DNS de Service dentro del clúster (nombre, nombre.ns, nombre.ns.svc.cluster.local). */
export function resolveService(c: EksCluster, host: string, fromNs: string): KObj | undefined {
  const h = host.toLowerCase().replace(/\.$/, '');
  const p = h.split('.');
  const clean = h.replace(/\.svc(\.cluster\.local)?$/, '');
  const [name, ns] = clean.split('.');
  void p;
  const byIp = list(c, 'Service').find((x) => x.status?.clusterIP === h);
  return byIp ?? find(c, 'Service', ns ?? fromNs, name);
}

/** Respuesta HTTP de un Service (por ClusterIP/DNS dentro del clúster, o por el nombre del balanceador). */
export function serviceHttp(s: CloudState, c: EksCluster, svc: KObj, port: number): { status: number; body: string; server: string } | null {
  const sp = (svc.spec.ports as any[]).find((p) => p.port === port || p.nodePort === port);
  if (!sp) return null;
  const eps = serviceEndpoints(c, svc).filter((e) => e.port === Number(typeof sp.targetPort === 'number' || /^\d+$/.test(String(sp.targetPort)) ? sp.targetPort : e.port));
  if (!eps.length) return { status: 0, body: '', server: '' };
  const e = eps[Math.floor((now() / 1000)) % eps.length];
  const meta = podMeta(s, e.pod);
  const w = meta ? webBody(meta, e.pod.metadata.name) : null;
  if (!w || w.port !== e.port) return { status: 0, body: '', server: '' };
  return { status: 200, body: w.body, server: w.server };
}

// Núcleo común de los contenedores (ECR, ECS, EKS, Docker y Kubernetes): tipos de estado, catálogo de imágenes
// públicas, resolución de referencias de imagen y utilidades de hash. Todo el estado vive en `s.containers`.
import type { CloudState } from '../types';
import type { Caller } from '../api';
import type { KubeState } from '../kube';

// ------------------------------------------------------------------ utilidades

/** Hash determinista de 64 caracteres hexadecimales (para digests e identificadores de imagen). */
export function sha(seed: string): string {
  let out = '';
  let h = 2166136261 >>> 0;
  for (let r = 0; out.length < 64; r++) {
    for (const c of seed + '#' + r) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
}
export const shortSha = (s: string, n = 12) => s.replace(/^sha256:/, '').slice(0, n);

export const ecrHost = (s: CloudState, region: string) => `${s.account.id}.dkr.ecr.${region}.amazonaws.com`;

// ------------------------------------------------------------------ tipos de estado

export interface Counts { CRITICAL?: number; HIGH?: number; MEDIUM?: number; LOW?: number; INFORMATIONAL?: number }

/** Lo que hace falta saber de una imagen para ejecutarla: comando, puertos y qué responde por HTTP. */
export interface ImageMeta {
  entrypoint?: string[];
  cmd?: string[];
  env: Record<string, string>;
  exposed: number[];
  workdir: string;
  user?: string;
  /** Respuesta HTTP simulada. `{host}` se sustituye por el nombre del contenedor, pod o tarea. */
  web?: { port: number; body: string; server: string };
  /** true si el proceso principal sigue vivo sin comando (servidores); false si termina al instante (alpine, busybox...). */
  resident: boolean;
  baseRef: string;
  sizeBytes: number;
  layers: number;
  /** Líneas que escribe al arrancar. */
  logs: string[];
}

export interface Finding { name: string; severity: keyof Counts; pkg: string; description: string }
export interface EcrImage {
  digest: string;
  tags: string[];
  pushedAt: number;
  sizeBytes: number;
  meta: ImageMeta;
  scan?: { status: 'IN_PROGRESS' | 'COMPLETE'; startedAt: number; counts: Counts; findings: Finding[] };
  lastPulledAt?: number;
}
export interface EcrRepo {
  name: string; arn: string; uri: string; region: string; createdAt: number;
  tagMutability: 'MUTABLE' | 'IMMUTABLE'; scanOnPush: boolean; encryption: 'AES256' | 'KMS'; kmsKey?: string;
  images: EcrImage[]; lifecyclePolicy?: { text: string; updatedAt: number; applied: boolean }; policy?: string; tags: Record<string, string>;
}
export interface EcrToken { token: string; expires: number; account: string; region: string; caller: Caller }

export interface ContainerDef {
  name: string; image: string; essential: boolean; cpu?: number; memory?: number; memoryReservation?: number;
  portMappings: { containerPort: number; hostPort: number; protocol: string }[];
  command?: string[]; entryPoint?: string[]; environment: { name: string; value: string }[];
  logConfiguration?: { logDriver: string; options: Record<string, string> };
}
export interface TaskDef {
  family: string; revision: number; arn: string; region: string; status: 'ACTIVE' | 'INACTIVE'; registeredAt: number; deregisteredAt?: number;
  containerDefinitions: ContainerDef[]; cpu?: string; memory?: string; networkMode: string; requiresCompatibilities: string[];
  executionRoleArn?: string; taskRoleArn?: string; tags: Record<string, string>;
}
export interface EcsCluster { name: string; arn: string; region: string; createdAt: number; tags: Record<string, string>; containerInsights: boolean }
export interface EcsEvent { id: string; ts: number; message: string }
export interface EcsDeployment { id: string; status: 'PRIMARY' | 'ACTIVE' | 'INACTIVE'; taskDefinition: string; desiredCount: number; createdAt: number; updatedAt: number; rolloutState: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' }
export interface EcsService {
  name: string; arn: string; clusterName: string; region: string; taskDefinition: string; desiredCount: number; launchType: string; createdAt: number;
  status: 'ACTIVE' | 'DRAINING' | 'INACTIVE'; subnets: string[]; securityGroups: string[]; assignPublicIp: 'ENABLED' | 'DISABLED';
  loadBalancers: { targetGroupArn: string; containerName: string; containerPort: number }[]; events: EcsEvent[]; deployments: EcsDeployment[];
  healthCheckGracePeriodSeconds: number; tags: Record<string, string>; failures: number; lastFailureAt?: number;
}
export interface EcsTask {
  arn: string; id: string; clusterName: string; region: string; taskDefinition: string; group: string; startedBy?: string; serviceName?: string; deploymentId?: string;
  lastStatus: 'PROVISIONING' | 'PENDING' | 'RUNNING' | 'DEPROVISIONING' | 'STOPPED'; desiredStatus: 'RUNNING' | 'STOPPED';
  createdAt: number; startedAt?: number; stoppingAt?: number; stoppedAt?: number; stoppedReason?: string; stopCode?: string;
  subnetId: string; az: string; securityGroups: string[]; eniId: string; privateIp: string; publicIp?: string; launchType: string;
  cpu: string; memory: string; containers: { name: string; image: string; lastStatus: 'PENDING' | 'RUNNING' | 'STOPPED'; exitCode?: number; reason?: string; runtimeId: string; imageDigest?: string }[];
  /** Si la tarea no puede arrancar: motivo (se aplica al pasar de PROVISIONING a STOPPED). */
  failReason?: string; exitCode?: number; counted?: boolean; runCmd?: Record<string, { command?: string[]; environment?: { name: string; value: string }[] }>;
}

export interface NodeGroup {
  name: string; arn: string; status: 'CREATING' | 'ACTIVE' | 'UPDATING' | 'DELETING' | 'CREATE_FAILED'; health?: { code: string; message: string; resourceIds: string[] }; createdAt: number; nodeRole: string; subnets: string[]; instanceTypes: string[];
  amiType: string; capacityType: string; diskSize: number; scaling: { minSize: number; maxSize: number; desiredSize: number }; labels: Record<string, string>; tags: Record<string, string>;
  version: string; releaseVersion: string;
}
export interface EksAddon { name: string; version: string; status: 'CREATING' | 'ACTIVE' | 'DELETING'; arn: string; createdAt: number; serviceAccountRoleArn?: string }
export interface EksCluster {
  name: string; arn: string; region: string; status: 'CREATING' | 'ACTIVE' | 'DELETING' | 'FAILED'; createdAt: number; roleArn: string; version: string;
  endpoint: string; subnetIds: string[]; securityGroupIds: string[]; clusterSecurityGroupId: string; vpcId: string; endpointPublicAccess: boolean; endpointPrivateAccess: boolean;
  certificateAuthority: string; platformVersion: string; oidcIssuer: string; nodegroups: NodeGroup[]; addons: EksAddon[]; tags: Record<string, string>;
  accessEntries: { principalArn: string; policies: string[]; createdAt: number }[]; creatorArn: string; kube: KubeState;
}

export interface LocalImage { id: string; refs: string[]; created: number; meta: ImageMeta; history: string[] }
export interface DockerContainer {
  id: string; name: string; imageRef: string; imageId: string; command: string; created: number; status: 'running' | 'exited';
  exitCode: number; startedAt: number; finishedAt?: number; ports: { host: number; container: number }[]; env: Record<string, string>; logs: string[]; meta: ImageMeta;
}
export interface DockerState { images: LocalImage[]; containers: DockerContainer[]; logins: Record<string, { user: string; at: number; token?: string }> }

export interface ContainersState {
  ecr: EcrRepo[]; tokens: EcrToken[];
  ecsClusters: EcsCluster[]; taskDefs: TaskDef[]; ecsServices: EcsService[]; ecsTasks: EcsTask[];
  eks: EksCluster[]; docker: DockerState;
}

/** Estado de contenedores de la cuenta (se crea de forma perezosa para no tocar el esquema guardado). */
export function cs(s: CloudState): ContainersState {
  return (s.containers ??= { ecr: [], tokens: [], ecsClusters: [], taskDefs: [], ecsServices: [], ecsTasks: [], eks: [], docker: { images: [], containers: [], logins: {} } });
}

// ------------------------------------------------------------------ catálogo de imágenes públicas

const NGINX_PAGE = '<!DOCTYPE html>\n<html>\n<head>\n<title>Welcome to nginx!</title>\n</head>\n<body>\n<h1>Welcome to nginx!</h1>\n<p>If you see this page, the nginx web server is successfully installed and working. Further configuration is required.</p>\n</body>\n</html>\n';
const mk = (o: Partial<ImageMeta> & { baseRef: string }): ImageMeta => ({ env: {}, exposed: [], workdir: '/', resident: false, sizeBytes: 8_000_000, layers: 1, logs: [], ...o });

interface Pub { size: number; meta: Partial<ImageMeta> }
const PUBLIC: Record<string, Pub> = {
  nginx: { size: 192_000_000, meta: { exposed: [80], resident: true, cmd: ['nginx', '-g', 'daemon off;'], web: { port: 80, body: NGINX_PAGE, server: 'nginx/1.27.2' }, logs: ['/docker-entrypoint.sh: /docker-entrypoint.d/ is not empty, will attempt to perform configuration', '/docker-entrypoint.sh: Looking for shell scripts in /docker-entrypoint.d/', '/docker-entrypoint.sh: Configuration complete; ready for start up'] } },
  httpd: { size: 148_000_000, meta: { exposed: [80], resident: true, cmd: ['httpd-foreground'], web: { port: 80, body: '<html><body><h1>It works!</h1></body></html>\n', server: 'Apache/2.4.62 (Unix)' }, logs: ['AH00558: httpd: Could not reliably determine the server\'s fully qualified domain name', '[mpm_event:notice] [pid 1:tid 1] AH00489: Apache/2.4.62 (Unix) configured -- resuming normal operations'] } },
  node: { size: 1_100_000_000, meta: { cmd: ['node'], resident: false, workdir: '/' } },
  python: { size: 1_000_000_000, meta: { cmd: ['python3'], resident: false } },
  alpine: { size: 8_200_000, meta: { cmd: ['/bin/sh'], resident: false } },
  busybox: { size: 4_300_000, meta: { cmd: ['sh'], resident: false } },
  ubuntu: { size: 78_000_000, meta: { cmd: ['/bin/bash'], resident: false } },
  debian: { size: 117_000_000, meta: { cmd: ['bash'], resident: false } },
  golang: { size: 840_000_000, meta: { cmd: ['bash'], resident: false } },
  amazonlinux: { size: 160_000_000, meta: { cmd: ['/bin/bash'], resident: false } },
  redis: { size: 117_000_000, meta: { exposed: [6379], resident: true, cmd: ['redis-server'], logs: ['* Ready to accept connections tcp'] } },
  postgres: { size: 432_000_000, meta: { exposed: [5432], resident: true, cmd: ['postgres'], logs: ['database system is ready to accept connections'] } },
  mysql: { size: 586_000_000, meta: { exposed: [3306, 33060], resident: true, cmd: ['mysqld'], logs: ['[System] [MY-010931] [Server] /usr/sbin/mysqld: ready for connections.'] } },
  'traefik/whoami': { size: 6_700_000, meta: { exposed: [80], resident: true, cmd: ['/whoami'], web: { port: 80, body: 'Hostname: {host}\nIP: 127.0.0.1\nRemoteAddr: 172.17.0.1:52044\nGET / HTTP/1.1\nHost: localhost\n', server: 'whoami' }, logs: ['2025/01/10 10:00:00 Starting up on port 80'] } },
  'amazon/amazon-ecs-sample': { size: 270_000_000, meta: { exposed: [80], resident: true, web: { port: 80, body: '<html><head><title>Amazon ECS Sample App</title></head><body><h1>Amazon ECS Sample App</h1><h2>Congratulations!</h2><p>Your application is now running on a container in Amazon ECS.</p></body></html>\n', server: 'Apache/2.4.62 (Unix)' }, logs: ['AH00558: httpd: Could not reliably determine the server\'s fully qualified domain name'] } },
  'hashicorp/http-echo': { size: 5_200_000, meta: { exposed: [5678], resident: true, web: { port: 5678, body: 'hello-world\n', server: 'http-echo' }, logs: ['2025/01/10 10:00:00 server is listening on :5678'] } },
  'google-samples/hello-app': { size: 12_000_000, meta: { exposed: [8080], resident: true, web: { port: 8080, body: 'Hello, world!\nVersion: 1.0.0\nHostname: {host}\n', server: 'hello-app' }, logs: ['2025/01/10 10:00:00 Server listening on port 8080'] } },
  pause: { size: 700_000, meta: { resident: true, cmd: ['/pause'] } },
};

/** Alias de registros públicos a la clave del catálogo. */
function catalogKey(registry: string, repo: string): string | undefined {
  let r = repo;
  if (registry === 'docker.io' || registry === 'public.ecr.aws') {
    r = r.replace(/^docker\/library\//, '').replace(/^library\//, '');
    if (registry === 'public.ecr.aws') r = r.replace(/^nginx\/nginx$/, 'nginx').replace(/^ecs-sample-image\/amazon-ecs-sample$/, 'amazon/amazon-ecs-sample').replace(/^httpd\/httpd$/, 'httpd');
    if (PUBLIC[r]) return r;
    return undefined;
  }
  if (registry === 'gcr.io' || registry === 'registry.k8s.io') { if (PUBLIC[r]) return r; if (registry === 'registry.k8s.io' && r === 'pause') return 'pause'; }
  if (registry === 'mcr.microsoft.com') return undefined;
  return undefined;
}

export interface ImageRef { registry: string; repo: string; tag: string; digest?: string; raw: string }
export function parseRef(ref: string): ImageRef {
  let rest = ref.trim();
  let digest: string | undefined;
  const at = rest.indexOf('@');
  if (at >= 0) { digest = rest.slice(at + 1); rest = rest.slice(0, at); }
  const parts = rest.split('/');
  let registry = 'docker.io';
  if (parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')) registry = parts.shift()!;
  let last = parts.pop() ?? '';
  let tag = 'latest';
  const c = last.indexOf(':');
  if (c >= 0) { tag = last.slice(c + 1); last = last.slice(0, c); }
  parts.push(last);
  let repo = parts.join('/');
  if (registry === 'docker.io' && !repo.includes('/')) repo = 'library/' + repo;
  return { registry, repo, tag, digest, raw: ref };
}

/** Última versión (mayor, menor) que existe de algunas imágenes populares; por encima, el tag no existe. */
const MAXV: Record<string, [number, number]> = { nginx: [1, 29], httpd: [2, 4], node: [24, 99], python: [3, 14], redis: [8, 9], postgres: [17, 9], mysql: [9, 9], golang: [1, 25], ubuntu: [24, 10], alpine: [3, 22] };
export const tagLooksValid = (tag: string, repo = '') => {
  const mv = MAXV[repo.replace(/^library\//, '')];
  const m = /^v?(\d+)(?:\.(\d+))?/.exec(tag);
  if (mv && m && (Number(m[1]) > mv[0] || (Number(m[1]) === mv[0] && m[2] !== undefined && Number(m[2]) > mv[1]))) return false;
  return baseTagOk(tag);
};
const baseTagOk = (tag: string) => tag === 'latest' || tag === 'stable' || tag === 'mainline' || /^v?\d[\w.-]*$/.test(tag) || /^(alpine|slim|bookworm|bullseye|jammy|noble|lts|buster)/.test(tag);

const OLD = /^(node:(8|10|12|14|16)\b|python:(2|3\.[0-8])\b|nginx:1\.(1\d|20)|ubuntu:1[0-8]|debian:(8|9|10)|redis:[1-5]\b)/;
/** Vulnerabilidades (simuladas) heredadas de la imagen base. */
export function baseVulns(baseRef: string): Counts {
  const r = parseRef(baseRef);
  const key = `${r.repo.replace(/^library\//, '')}:${r.tag}`;
  if (/alpine|distroless|busybox|pause/.test(key) && !OLD.test(key)) return { LOW: 1 };
  if (/^(alpine|busybox|pause|traefik|hashicorp|google-samples|amazon\/)/.test(r.repo.replace(/^library\//, ''))) return { LOW: 1 };
  if (OLD.test(key)) return { CRITICAL: 2, HIGH: 7, MEDIUM: 14, LOW: 9 };
  if (r.tag === 'latest') return { HIGH: 1, MEDIUM: 4, LOW: 6 };
  return { MEDIUM: 3, LOW: 5 };
}

export type Resolved = { ok: true; meta: ImageMeta; digest: string; source: 'ecr' | 'public'; size: number } | { ok: false; reason: 'RepositoryNotFound' | 'TagNotFound' | 'Unknown' | 'ForeignRegistry' | 'NotFound'; detail: string };

/** Resuelve una referencia de imagen (ECR de la cuenta o catálogo público) como lo haría un runtime de contenedores. */
export function resolveImage(s: CloudState, ref: string, mark = false): Resolved {
  const r = parseRef(ref);
  const m = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com$/.exec(r.registry);
  if (m) {
    if (m[1] !== s.account.id) return { ok: false, reason: 'ForeignRegistry', detail: `pull access denied, repository does not exist or may require authorization` };
    const repo = cs(s).ecr.find((x) => x.name === r.repo && x.region === m[2]);
    if (!repo) return { ok: false, reason: 'RepositoryNotFound', detail: `The repository with name '${r.repo}' does not exist in the registry with id '${m[1]}'` };
    const img = r.digest ? repo.images.find((i) => i.digest === r.digest) : repo.images.find((i) => i.tags.includes(r.tag));
    if (!img) return { ok: false, reason: 'TagNotFound', detail: `Requested image not found` };
    if (mark) img.lastPulledAt = Date.now();
    return { ok: true, meta: img.meta, digest: img.digest, source: 'ecr', size: img.sizeBytes };
  }
  const key = catalogKey(r.registry, r.repo);
  if (!key) return { ok: false, reason: 'Unknown', detail: `pull access denied for ${r.repo.replace(/^library\//, '')}, repository does not exist or may require 'docker login'` };
  if (!tagLooksValid(r.tag, r.repo)) return { ok: false, reason: 'NotFound', detail: `manifest unknown` };
  const p = PUBLIC[key];
  const baseRef = `${key}:${r.tag}`;
  const meta = mk({ baseRef, sizeBytes: p.size, layers: 4, ...p.meta });
  return { ok: true, meta, digest: 'sha256:' + sha('pub:' + baseRef), source: 'public', size: p.size };
}

export const isPublicRef = (ref: string): boolean => { const r = parseRef(ref); return !!catalogKey(r.registry, r.repo); };
export const defaultMeta = (baseRef: string) => mk({ baseRef });

// ------------------------------------------------------------------ comportamiento en ejecución

export interface RunResult { resident: boolean; lines: string[]; exitCode: number; execError?: string }
const SHELLS = new Set(['sh', '/bin/sh', 'bash', '/bin/bash', 'ash']);
const unq = (t: string) => t.replace(/^(["'])(.*)\1$/, '$2');
const splitWords = (t: string): string[] => (t.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unq);

/** Simula lo que hace el proceso principal de un contenedor: imprime, termina o se queda en ejecución. */
export function simulateRun(meta: ImageMeta, o: { command?: string[]; entrypoint?: string[]; env?: Record<string, string>; host?: string } = {}): RunResult {
  const ep = o.entrypoint ?? meta.entrypoint ?? [];
  const cmd = o.command ?? (o.entrypoint ? [] : meta.cmd ?? []);
  const argv = [...ep, ...cmd];
  const lines: string[] = [];
  const env = { ...meta.env, ...(o.env ?? {}) };
  if (!argv.length) return { resident: meta.resident, lines: meta.resident ? [...meta.logs] : [], exitCode: 0 };
  const script = SHELLS.has(argv[0]) && argv[1] === '-c' ? argv.slice(2).join(' ') : SHELLS.has(argv[0]) && argv.length === 1 ? '' : argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  if (SHELLS.has(argv[0]) && argv.length === 1) return { resident: meta.resident, lines: meta.resident ? [...meta.logs] : [], exitCode: 0 };
  const stmts = script.split(/\s*(?:;|&&)\s*/).filter(Boolean);
  for (const st of stmts) {
    const w = splitWords(st);
    const prog = w[0];
    if (prog === 'echo') { lines.push(w.slice(1).join(' ').replace(/\$\{?(\w+)\}?/g, (_m, k) => env[k] ?? '')); continue; }
    if (prog === 'hostname') { lines.push(o.host ?? 'localhost'); continue; }
    if (prog === 'date') { lines.push(new Date().toUTCString().replace('GMT', 'UTC')); continue; }
    if (prog === 'whoami') { lines.push(meta.user ?? 'root'); continue; }
    if (prog === 'env' || prog === 'printenv') { for (const [k, v] of Object.entries(env)) lines.push(`${k}=${v}`); continue; }
    if (prog === 'pwd') { lines.push(meta.workdir); continue; }
    if (prog === 'exit') return { resident: false, lines, exitCode: Number(w[1] ?? 0) };
    if (prog === 'sleep') { const n = w[1] === 'infinity' ? 1e9 : Number(w[1]); if (n >= 20) return { resident: true, lines, exitCode: 0 }; continue; }
    if (prog === 'tail' || prog === 'while' || prog === 'cat' && w[1] === '/dev/zero') return { resident: true, lines, exitCode: 0 };
    if (['ls', 'cat', 'true', ':', 'uname', 'id'].includes(prog)) { if (prog === 'uname') lines.push('Linux'); continue; }
    if (prog === 'false') return { resident: false, lines, exitCode: 1 };
    // Programa desconocido: un servidor de la imagen o una aplicación del usuario se queda ejecutándose.
    if (meta.resident || meta.exposed.length) return { resident: true, lines: [...lines, ...meta.logs], exitCode: 0 };
    return { resident: false, lines, exitCode: 127, execError: `exec: "${prog}": executable file not found in $PATH` };
  }
  return { resident: false, lines, exitCode: 0 };
}

/** Respuesta HTTP de un contenedor, pod o tarea concretos. */
export function webBody(meta: ImageMeta, host: string): { body: string; server: string; port: number } | null {
  if (!meta.web) return null;
  return { body: meta.web.body.replace(/\{host\}/g, host), server: meta.web.server, port: meta.web.port };
}

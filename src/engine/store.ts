// Store central de la nube simulada: estado mutable + suscriptores + persistencia.
import type { CloudState, Settings, IamUser } from './types';
import { slugify, nowIso, guid } from './util';
import { ids } from './ids';
import { AWS_MANAGED } from './managedPolicies';
import { canPersist, readKey, writeKey } from './persistence';
import { buildHome } from './seedFiles';

const STORAGE_KEY = 'awslab:cloud:v1';
export const SCHEMA_VERSION = 1;
export const DEFAULT_REGION = 'eu-west-1';

export function homeDir(s: { me: { userName: string } }): string {
  return `/home/${s.me.userName}`;
}

/** Crea la cuenta inicial: usuario administrador, VPC por defecto y políticas gestionadas de AWS. */
export function createInitialState(displayName = 'Estudiante', prev?: Partial<Settings>): CloudState {
  const slug = slugify(displayName);
  const account = ids.accountId();
  const meArn = `arn:aws:iam::${account}:user/${slug}`;
  const me: IamUser = {
    arn: meArn,
    name: slug,
    id: ids.iamId('AIDA'),
    path: '/',
    createdAt: nowIso(),
    tags: {},
    attached: ['arn:aws:iam::aws:policy/AdministratorAccess'],
    inline: {},
    accessKeys: [],
    hasConsolePassword: true,
    mfaDevices: [],
  };
  const key = { id: ids.accessKeyId(), secret: ids.secretKey(), status: 'Active' as const, createdAt: nowIso() };
  me.accessKeys.push(key);

  const s: CloudState = {
    schema: SCHEMA_VERSION,
    createdAt: nowIso(),
    settings: {
      speed: prev?.speed ?? 'fast',
      theme: prev?.theme ?? 'light',
      freeMode: prev?.freeMode ?? false,
      userDisplayName: displayName,
      onboarded: prev?.onboarded ?? false,
    },
    account: { id: account, rootEmail: `${slug}@example.com` },
    region: DEFAULT_REGION,
    me: { arn: meArn, userName: slug },
    users: [me],
    groups: [],
    roles: [],
    instanceProfiles: [],
    policies: AWS_MANAGED.map((p) => ({ ...p, id: ids.iamId('ANPA'), attachmentCount: p.name === 'AdministratorAccess' ? 1 : 0, createdAt: '2015-02-06T18:39:46Z' })),
    sessions: [],
    buckets: [],
    vpcs: [],
    subnets: [],
    internetGateways: [],
    natGateways: [],
    routeTables: [],
    securityGroups: [],
    networkAcls: [],
    elasticIps: [],
    keyPairs: [],
    volumes: [],
    instances: [],
    snapshots: [],
    virtualMfa: [],
    trails: [],
    kmsKeys: [],
    kmsAliases: [],
    secrets: [],
    metricData: [],
    alarms: [],
    logGroups: [],
    topics: [],
    zones: [],
    healthChecks: [],
    loadBalancers: [],
    targetGroups: [],
    listeners: [],
    launchTemplates: [],
    asgs: [],
    cfn: { stacks: [], skew: 0 },
    trail: [],
    cli: {
      profiles: { default: { accessKeyId: key.id, secret: key.secret, region: DEFAULT_REGION, output: 'json' } },
      activeProfile: 'default',
      env: {},
      cwd: `/home/${slug}`,
      history: [],
      commandLog: [],
    },
    fs: buildHome(slug),
    recent: [],
  };
  return s;
}

/** Migración suave: rellena los campos añadidos en versiones posteriores sin invalidar estados guardados. */
export function migrate(s: CloudState): CloudState {
  const a = s as any;
  a.snapshots ??= [];
  a.virtualMfa ??= [];
  a.trails ??= [];
  a.kmsKeys ??= [];
  a.kmsAliases ??= [];
  a.secrets ??= [];
  a.metricData ??= [];
  a.alarms ??= [];
  a.logGroups ??= [];
  a.topics ??= [];
  a.zones ??= [];
  a.healthChecks ??= [];
  a.loadBalancers ??= [];
  a.targetGroups ??= [];
  a.listeners ??= [];
  a.launchTemplates ??= [];
  a.asgs ??= [];
  a.cfn ??= { stacks: [], skew: 0 };
  // Políticas gestionadas añadidas en versiones posteriores (p. ej. Lambda, SQS, RDS).
  for (const p of AWS_MANAGED) if (!a.policies?.some((x: { arn: string }) => x.arn === p.arn)) a.policies?.push({ ...p, id: ids.iamId('ANPA'), attachmentCount: 0, createdAt: '2015-02-06T18:39:46Z' });
  return s;
}

function load(): CloudState | null {
  if (!canPersist()) return null;
  try {
    const raw = readKey(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as CloudState;
    return s.schema === SCHEMA_VERSION ? migrate(s) : null;
  } catch {
    return null;
  }
}

let state: CloudState = load() ?? createInitialState();
let version = 0;
const listeners = new Set<() => void>();
let notifyPending = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function getState(): CloudState {
  return state;
}
export function getVersion(): number {
  return version;
}
export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function save() {
  if (!canPersist()) return;
  try {
    if (state.trail.length > 3000) state.trail = state.trail.slice(-2400);
    if (state.cli.commandLog.length > 800) state.cli.commandLog = state.cli.commandLog.slice(-600);
    if (state.cli.history.length > 500) state.cli.history = state.cli.history.slice(-400);
    writeKey(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('No se pudo guardar el estado del simulador', e);
  }
}

export function flushSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  save();
}

/** Señala que el estado ha cambiado (agrupa notificaciones en un microtask). */
export function changed() {
  if (canPersist()) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }
  if (notifyPending) return;
  notifyPending = true;
  queueMicrotask(() => {
    notifyPending = false;
    version++;
    for (const l of [...listeners]) l();
  });
}

export function mutate<T>(fn: (s: CloudState) => T): T {
  const r = fn(state);
  changed();
  return r;
}

export function replaceState(s: CloudState) {
  state = migrate(s);
  changed();
}

/** Para tests: estado limpio sin tocar el almacenamiento. */
export function freshState(name = 'Estudiante'): CloudState {
  state = createInitialState(name);
  changed();
  return state;
}

export function resetCloud() {
  const prev = state.settings;
  state = createInitialState(prev.userDisplayName, prev);
  flushSave();
  changed();
  bus.emit('cloud:reset', null);
}

export function speedFactor(): number {
  switch (state.settings.speed) {
    case 'instant':
      return 0;
    case 'realistic':
      return 2.5;
    default:
      return 1;
  }
}

type Handler = (payload: any) => void;
const handlers = new Map<string, Set<Handler>>();
export const bus = {
  on(evt: string, h: Handler) {
    if (!handlers.has(evt)) handlers.set(evt, new Set());
    handlers.get(evt)!.add(h);
    return () => {
      handlers.get(evt)?.delete(h);
    };
  },
  emit(evt: string, payload: any) {
    handlers.get(evt)?.forEach((h) => {
      try {
        h(payload);
      } catch (e) {
        console.error(e);
      }
    });
  },
};

export { guid };

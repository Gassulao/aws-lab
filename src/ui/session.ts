// Sesión de la interfaz: hook para suscribirse al estado y ejecución de acciones de consola como comandos del CLI.
import { useSyncExternalStore } from 'react';
import { getState, getVersion, subscribe, mutate } from '../engine/store';
import { readKey, writeKey, removeKey } from '../engine/persistence';
import { ids } from '../engine/ids';
import { buildHome } from '../engine/seedFiles';
import type { CloudState, IamUser } from '../engine/types';
import { newShell, execLine, type Shell } from '../shell';

export function useCloud() {
  useSyncExternalStore(subscribe, getVersion);
  return getState();
}

let sh: Shell | null = null;
/** Descarta el intérprete en caché (p. ej. al cambiar de usuario, para que tome el nuevo directorio personal). */
export const resetShell = () => { sh = null; };
export function getShell(): Shell {
  if (!sh || sh.s !== getState()) sh = newShell(getState());
  return sh;
}

export interface ActionResult {
  ok: boolean;
  out: string;
  err: string;
  json: any;
  cmd: string;
}

/** Ejecuta la acción de la consola como el comando de CLI equivalente (queda en CloudTrail, igual que en AWS). */
export async function consoleRun(cmd: string): Promise<ActionResult> {
  const shell = getShell();
  const r = await execLine(shell, cmd, 'console');
  mutate(() => {});
  let json: any = null;
  try {
    json = r.out.trim() ? JSON.parse(r.out) : null;
  } catch {
    /* salida no JSON */
  }
  return { ok: r.code === 0, out: r.out, err: r.err, json, cmd };
}

/** Quita el prefijo técnico de un error del CLI para mostrarlo como en la consola. */
export function consoleError(err: string): string {
  const m = /An error occurred \(([^)]+)\) when calling the \w+ operation: (.*)/s.exec(err);
  return m ? m[2].trim() : err.trim();
}

// ------------------------------------------------------------------ Inicio de sesión
// La sesión es solo de interfaz: guarda el nombre con el que el alumno ha entrado. Los permisos reales
// los da el principal IAM del simulador (`state.me`): el usuario con ese nombre si existe, o el administrador.

export interface Session {
  /** Nombre que se muestra en la cabecera (`usuario @ cuenta`). */
  user: string;
  /** Entró como usuario raíz. */
  root: boolean;
}

export const SESSION_KEY = 'awslab.session';
const NOLOGIN_KEY = 'awslab.nologin';
const ADMIN_POLICY = 'arn:aws:iam::aws:policy/AdministratorAccess';

/** ¿Hay que saltarse el login? `?nologin` en la URL (o en el hash) o `localStorage['awslab.nologin']='1'`. Pensado para tests y labs automatizados. */
export function nologinRequested(): boolean {
  try {
    if (typeof location !== 'undefined' && (/[?&]nologin\b/.test(location.search) || /[?&]nologin\b/.test(location.hash))) return true;
  } catch { /* sin location */ }
  return readKey(NOLOGIN_KEY) === '1';
}

const parseSession = (raw: string | null): Session | null => {
  if (!raw) return null;
  try {
    const x = JSON.parse(raw);
    return x && typeof x.user === 'string' && x.user.trim() ? { user: x.user, root: !!x.root } : null;
  } catch {
    return null;
  }
};

let cur: Session | null | undefined;
const sessSubs = new Set<() => void>();
const setSession = (s: Session | null) => {
  cur = s;
  if (s) writeKey(SESSION_KEY, JSON.stringify(s));
  else removeKey(SESSION_KEY);
  sessSubs.forEach((f) => f());
};

export function getSession(): Session | null {
  if (cur === undefined) {
    cur = parseSession(readKey(SESSION_KEY));
    if (!cur && nologinRequested()) {
      cur = { user: getState().settings.userDisplayName, root: false };
      writeKey(SESSION_KEY, JSON.stringify(cur));
    }
  }
  return cur;
}

export function useSession(): Session | null {
  return useSyncExternalStore((f) => { sessSubs.add(f); return () => { sessSubs.delete(f); }; }, getSession);
}

const isAdmin = (u: IamUser) => u.attached.includes(ADMIN_POLICY);

/** Principal administrador por defecto (el usuario original de la cuenta; si ya no existe, cualquier otro administrador). */
export function defaultAdmin(s: CloudState): IamUser | undefined {
  return (s.users[0] && isAdmin(s.users[0]) ? s.users[0] : undefined) ?? s.users.find(isAdmin) ?? s.users[0];
}

/** Usuario IAM con ese nombre (en IAM los nombres no distinguen mayúsculas). */
export function findIamUser(s: CloudState, name: string): IamUser | undefined {
  const n = name.trim().toLowerCase();
  return s.users.find((u) => u.name.toLowerCase() === n);
}

/** Etiqueta de cuenta de la cabecera: el alias si existe y, si no, el ID con guiones. */
export const accountLabel = (s: CloudState) => s.account.alias || s.account.id.replace(/(\d{4})(\d{4})(\d{4})/, '$1-$2-$3');

/** ¿Coincide lo escrito con el ID de cuenta (con o sin guiones) o con su alias? */
export function accountMatches(s: CloudState, typed: string): boolean {
  const t = typed.trim().toLowerCase();
  return !!t && (t.replace(/-/g, '') === s.account.id || (!!s.account.alias && t === s.account.alias.toLowerCase()));
}

/**
 * Hace que `name` sea el principal de la consola y del CLI: el usuario IAM con ese nombre (aplican sus permisos reales)
 * o, si no existe (o `name` es undefined), el administrador por defecto. No toca nada si ya es el principal actual.
 * Devuelve el usuario IAM efectivo (undefined si la cuenta no tiene usuarios).
 */
export function assumePrincipal(st: CloudState, name?: string): IamUser | undefined {
  const target = (name ? findIamUser(st, name) : undefined) ?? defaultAdmin(st);
  if (!target || st.me.arn === target.arn) return target;
  st.me = { arn: target.arn, userName: target.name };
  let key = target.accessKeys.find((k) => k.status === 'Active');
  if (!key && target.accessKeys.length < 2) {
    key = { id: ids.accessKeyId(), secret: ids.secretKey(), status: 'Active', createdAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
    target.accessKeys.push(key);
  }
  const prev = st.cli.profiles.default ?? {};
  if (key) st.cli.profiles.default = { ...prev, accessKeyId: key.id, secret: key.secret, token: undefined, roleArn: undefined, sourceProfile: undefined, mfaSerial: undefined, region: prev.region ?? st.region, output: prev.output ?? 'json' };
  st.cli.activeProfile = 'default';
  for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE']) delete st.cli.env[k];
  // Directorio personal en CloudShell.
  const home = `/home/${target.name}`;
  const homes = st.fs.children?.home?.children;
  if (homes && !homes[target.name]) homes[target.name] = buildHome(target.name).children!.home.children![target.name];
  st.cli.cwd = home;
  return target;
}

/** Inicia sesión: aplica el principal y guarda la sesión (persistente al recargar). */
export function signIn(name: string, opts: { root?: boolean } = {}): Session {
  const root = !!opts.root;
  const typed = name.trim();
  mutate((st) => assumePrincipal(st, root ? undefined : typed));
  resetShell();
  const iam = root ? undefined : findIamUser(getState(), typed);
  const sess: Session = { user: root ? 'raíz' : iam?.name ?? typed, root };
  setSession(sess);
  try { writeKey('awslab.lastUser', typed); } catch { /* sin almacenamiento */ }
  return sess;
}

export function signOut() {
  setSession(null);
  try {
    // Si se entró con `?nologin` en la URL, se quita para que el login se pueda ver.
    history.replaceState(null, '', location.pathname);
    location.hash = '#/';
  } catch { /* sin history */ }
}

export const lastUser = () => readKey('awslab.lastUser') ?? '';

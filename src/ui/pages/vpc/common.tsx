import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useCloud, consoleRun, consoleError, type ActionResult } from '../../session';
import { Btn, Flash, Modal, CliEquivalent, nav as rawNav } from '../../components/ui';
import { isKnownRoute } from '../../services';
import { mutate } from '../../../engine/store';
import { ensureDefaultVpc } from '../../../engine/services/ec2';
import type { Tags } from '../../../engine/types';
import './vpc.css';

// ---------------------------------------------------------------- avisos persistentes entre páginas de VPC
interface Msg { kind: 'ok' | 'err' | 'info'; title?: string; text: string }
let msg: Msg | null = null;
const subs = new Set<() => void>();
let ver = 0;
let age = 0;
export const notify = (m: Msg | null) => {
  msg = m;
  age = 0;
  ver++;
  subs.forEach((f) => f());
};
/** Se llama al montar cada página de VPC: el aviso se muestra en la página siguiente y se retira en la otra. */
export function ageNotice() {
  if (!msg) return;
  if (age >= 1) msg = null;
  else age++;
}
export function FlashBar() {
  useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => ver);
  return msg ? <Flash kind={msg.kind} title={msg.title} onClose={() => notify(null)}>{msg.text}</Flash> : null;
}

// ---------------------------------------------------------------- utilidades
export const nm = (t: Tags | undefined) => t?.Name ?? '-';
export const rg = (region: string) => `--region ${region}`;
export const SAFE = /^[A-Za-z0-9 _.:/@+=-]*$/;
export const nameError = (v: string) => (SAFE.test(v) ? '' : 'Solo se permiten letras, números, espacios y los caracteres _ . : / @ + = -');
export const tagSpec = (type: string, name: string) => (name.trim() ? `--tag-specifications 'ResourceType=${type},Tags=[{Key=Name,Value=${name.trim()}}]'` : '');
export const cmdOf = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ');

export function errParts(err: string): { code: string; msg: string } {
  const m = /An error occurred \(([^)]+)\)/.exec(err);
  return { code: m?.[1] ?? '', msg: consoleError(err) };
}

/** Ejecuta un comando y muestra un aviso global. Devuelve el resultado. */
export async function runNotify(cmd: string, okText: string, errTitle: string): Promise<ActionResult> {
  const r = await consoleRun(cmd);
  if (r.ok) notify({ kind: 'ok', text: okText });
  else {
    const e = errParts(r.err);
    notify({ kind: 'err', title: errTitle, text: (e.code ? `${e.code}: ` : '') + e.msg });
  }
  return r;
}

/** La consola de AWS siempre muestra la VPC predeterminada de cada región. */
export function useDefaults() {
  const s = useCloud();
  const has = s.vpcs.some((v) => v.region === s.region && v.isDefault);
  useEffect(() => {
    if (!has) mutate((st) => ensureDefaultVpc(st, st.region));
  }, [has, s.region]);
}

export const inRegion = <T extends { region: string }>(list: T[], region: string) => list.filter((x) => x.region === region);

// ---------------------------------------------------------------- componentes
export function ActionsMenu({ label = 'Acciones', items, kind }: { label?: string; kind?: 'primary'; items: ({ label: string; onClick: () => void; disabled?: boolean } | 'sep')[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const f = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    addEventListener('mousedown', f);
    return () => removeEventListener('mousedown', f);
  }, []);
  return (
    <div className="vp-menu" ref={ref}>
      <Btn kind={kind} onClick={() => setOpen(!open)}>{label} ▾</Btn>
      {open && (
        <div className="vp-pop">
          {items.map((it, i) =>
            it === 'sep' ? <hr key={i} /> : (
              <div key={i} className={it.disabled ? 'off' : ''} onClick={() => { if (it.disabled) return; setOpen(false); it.onClick(); }}>{it.label}</div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: string[]; value: string; onChange: (t: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <a key={t} role="tab" aria-selected={t === value} className={t === value ? 'on' : ''} onClick={() => onChange(t)}>{t}</a>
      ))}
    </div>
  );
}

export function KV({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <div className="vp-kv">
      {items.map(([k, v]) => (
        <div key={k}><div className="k">{k}</div><div className="v">{v ?? '-'}</div></div>
      ))}
    </div>
  );
}

/** Confirmación con el comando equivalente. `onConfirm` devuelve un texto de error o null si todo fue bien. */
export function ConfirmModal({ title, children, cmd, label = 'Eliminar', danger = true, onConfirm, onClose }: { title: string; children: React.ReactNode; cmd?: string; label?: string; danger?: boolean; onConfirm: () => Promise<string | null>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    const e = await onConfirm();
    setBusy(false);
    if (e) setErr(e);
    else onClose();
  };
  return (
    <Modal title={title} onClose={onClose} footer={<><Btn onClick={onClose}>Cancelar</Btn><Btn kind={danger ? 'danger' : 'primary'} disabled={busy} onClick={go}>{busy ? 'Procesando…' : label}</Btn></>}>
      {err && <Flash kind="err" title="No se pudo completar la operación">{err}</Flash>}
      {children}
      {cmd && <CliEquivalent cmd={cmd} />}
    </Modal>
  );
}

/** Ejecuta `cmd` desde un modal: error inline si falla; aviso global si va bien. */
export const modalRun = (cmd: string, okText: string, then?: (r: ActionResult) => void) => async (): Promise<string | null> => {
  const r = await consoleRun(cmd);
  if (!r.ok) {
    const e = errParts(r.err);
    return (e.code ? `${e.code}: ` : '') + e.msg;
  }
  notify({ kind: 'ok', text: okText });
  then?.(r);
  return null;
};

// Rutas que el menú del servicio puede no conocer todavía: se sirven bajo /vpc/igw/<sección> como alternativa.
const ALIAS = ['nat', 'eip', 'sg'];
export function fix(to: string): string {
  const m = /^\/vpc\/(nat|eip|sg)(\/.*|\?.*)?$/.exec(to);
  if (!m || isKnownRoute('/vpc/' + m[1])) return to;
  return `/vpc/igw/${m[1]}${m[2] ?? ''}`;
}
export const nav = (to: string) => rawNav(fix(to));
export { ALIAS };

export function Link({ to, children }: { to: string; children: React.ReactNode }) {
  return <a href={'#' + fix(to)} onClick={(e) => { e.preventDefault(); nav(to); }}>{children}</a>;
}

export const queryOf = (name: string) => new URLSearchParams(location.hash.split('?')[1] ?? '').get(name);
export function useVpcFilter(path: string): [string | null, () => void] {
  return [queryOf('vpc'), () => nav(path.split('?')[0])];
}

export function FilterBanner({ vpc, clear }: { vpc: string | null; clear: () => void }) {
  if (!vpc) return null;
  return <div className="vp-banner"><span>Mostrando solo los recursos de la VPC <b>{vpc}</b></span><Btn kind="link" onClick={clear}>Quitar filtro</Btn></div>;
}

export const sel1 = (set: (ids: string[]) => void) => (ids: string[]) => set(ids.slice(-1));

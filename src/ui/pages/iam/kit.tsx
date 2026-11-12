// Componentes y utilidades compartidas por las consolas de IAM y S3 (solo variables CSS del tema).
import React, { useEffect, useRef, useState } from 'react';
import { consoleRun, consoleError, getShell, type ActionResult } from '../../session';
import { Btn, Flash, Modal } from '../../components/ui';
import { validatePolicyDocument } from '../../../engine/policy';
import './iam.css';

export function Tabs<T extends string>({ tabs, active, onChange }: { tabs: { id: T; label: string }[]; active: T; onChange: (t: T) => void }) {
  return (
    <div className="k-tabs" role="tablist">
      {tabs.map((t) => (
        <a key={t.id} role="tab" className={active === t.id ? 'on' : ''} onClick={() => onChange(t.id)}>{t.label}</a>
      ))}
    </div>
  );
}

/** Menú desplegable "Acciones". */
export function Menu({ label, items, small }: { label: string; items: { label: string; onClick: () => void; disabled?: boolean }[]; small?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div className="k-menu" ref={ref}>
      <Btn small={small} onClick={() => setOpen(!open)}>{label} ▾</Btn>
      {open && (
        <div className="k-menu-list">
          {items.map((it) => (
            <div key={it.label} className={it.disabled ? 'dis' : ''} onClick={() => { if (it.disabled) return; setOpen(false); it.onClick(); }}>{it.label}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Escribe un archivo temporal en el sistema de archivos del shell y devuelve file:// para --opcion file://... */
export function tmpFile(content: string): string {
  const path = `/tmp/ui-${Date.now()}-${Math.floor(Math.random() * 1e5)}.json`;
  getShell().fs.writeFile(path, content);
  return 'file://' + path;
}

export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function run(cmd: string): Promise<ActionResult & { msg: string }> {
  const r = await consoleRun(cmd);
  return { ...r, msg: r.ok ? '' : consoleError(r.err) };
}

/** Valida JSON de política con el validador del motor. Devuelve '' si es correcto. */
export function checkPolicy(text: string, kind: 'identity' | 'trust' | 'resource' = 'identity'): string {
  let obj: any;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return 'Error de sintaxis JSON: ' + (e as Error).message;
  }
  try {
    validatePolicyDocument(obj, kind);
  } catch (e) {
    return (e as Error).message;
  }
  return '';
}

export function JsonEditor({ value, onChange, kind, rows }: { value: string; onChange: (v: string) => void; kind: 'identity' | 'trust' | 'resource'; rows?: number }) {
  const err = value.trim() ? checkPolicy(value, kind) : '';
  return (
    <div>
      <textarea className="k-code" spellCheck={false} style={rows ? { minHeight: rows * 18 } : undefined} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Editor JSON" />
      {value.trim() && (err ? <div style={{ color: 'var(--err)', fontSize: 12 }}>✕ {err}</div> : <div style={{ color: 'var(--ok)', fontSize: 12 }}>✓ JSON válido</div>)}
    </div>
  );
}

export const pretty = (o: unknown) => JSON.stringify(o, null, 2);

export function ConfirmModal({ title, children, confirmLabel, danger, requireText, disabled, onConfirm, onClose }: {
  disabled?: boolean; title: string; children: React.ReactNode; confirmLabel: string; danger?: boolean; requireText?: string; onConfirm: () => Promise<string | void>; onClose: () => void;
}) {
  const [t, setT] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const e = await onConfirm();
    setBusy(false);
    if (e) setErr(e); else onClose();
  };
  return (
    <Modal title={title} onClose={onClose} footer={<><Btn onClick={onClose}>Cancelar</Btn><Btn kind={danger ? 'danger' : 'primary'} disabled={busy || !!disabled || (requireText !== undefined && t !== requireText)} onClick={go}>{confirmLabel}</Btn></>}>
      {err && <Flash kind="err">{err}</Flash>}
      {children}
      {requireText !== undefined && (
        <div className="field" style={{ marginTop: 12 }}>
          <label>Para confirmar la eliminación, escriba <i>{requireText}</i> en el campo de texto.</label>
          <input className="k-input" type="text" autoFocus value={t} onChange={(e) => setT(e.target.value)} placeholder={requireText} />
        </div>
      )}
    </Modal>
  );
}

export function Tile({ on, onClick, title, desc, kind = 'radio' }: { on: boolean; onClick: () => void; title: React.ReactNode; desc?: React.ReactNode; kind?: 'radio' | 'check' }) {
  return (
    <div className={`k-tile ${on ? 'on' : ''}`} onClick={onClick} role={kind}>
      <input type={kind === 'radio' ? 'radio' : 'checkbox'} checked={on} readOnly style={{ marginTop: 3 }} />
      <div><b>{title}</b>{desc && <small>{desc}</small>}</div>
    </div>
  );
}

export function Steps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="k-steps">
      {steps.map((s, i) => (
        <div key={s} className={`st ${i === current ? 'on' : i < current ? 'done' : ''}`}>
          <small>Paso {i + 1}</small>{s}
        </div>
      ))}
    </div>
  );
}

export function Dl({ items, cols = 3 }: { items: [string, React.ReactNode][]; cols?: 2 | 3 }) {
  return (
    <div className="k-three k-dl" style={cols === 2 ? { gridTemplateColumns: '1fr 1fr' } : undefined}>
      {items.map(([k, v]) => (
        <div key={k}><div className="k">{k}</div><div className="v">{v ?? '-'}</div></div>
      ))}
    </div>
  );
}

export type TagRow = { k: string; v: string };
export function TagEditor({ tags, onChange }: { tags: TagRow[]; onChange: (t: TagRow[]) => void }) {
  return (
    <div>
      {tags.map((t, i) => (
        <div className="k-tag-row" key={i}>
          <input placeholder="Clave" aria-label="Clave de etiqueta" value={t.k} onChange={(e) => onChange(tags.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
          <input placeholder="Valor - opcional" aria-label="Valor de etiqueta" value={t.v} onChange={(e) => onChange(tags.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
          <Btn small onClick={() => onChange(tags.filter((_, j) => j !== i))}>Quitar</Btn>
        </div>
      ))}
      <Btn small onClick={() => onChange([...tags, { k: '', v: '' }])}>Agregar nueva etiqueta</Btn>
      <div className="k-muted" style={{ fontSize: 12, marginTop: 4 }}>Puede agregar hasta {50 - tags.length} etiquetas más.</div>
    </div>
  );
}

export const tagsArg = (tags: TagRow[]) => tags.filter((t) => t.k.trim()).map((t) => `Key=${t.k.trim()},Value=${q(t.v)}`);

const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
export function ago(iso?: string): string {
  if (!iso) return '-';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const a = Math.abs(diff);
  if (a < 60) return 'Hace un momento';
  if (a < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}
export function days(iso?: string): string {
  if (!iso) return '-';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d <= 0 ? 'Hoy' : d === 1 ? '1 día' : `${d} días`;
}

export const policyKind = (arn: string) => (arn.includes(':aws:policy') ? 'Administrada por AWS' : 'Administrada por el cliente');
export const lastSeg = (arn: string) => arn.split('/').pop()!;

export function PolicyBlock({ doc }: { doc: unknown }) {
  return <pre className="k-pre">{pretty(doc)}</pre>;
}

export function Spinner() {
  return <span className="k-muted">Cargando…</span>;
}

/** Mensaje de éxito que se muestra en la página a la que se navega tras una acción. */
let nextFlash = '';
export const setNextFlash = (m: string) => { nextFlash = m; };
export const takeFlash = (): string => { const m = nextFlash; nextFlash = ''; return m; };

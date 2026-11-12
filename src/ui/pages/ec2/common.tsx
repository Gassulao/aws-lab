import React, { useEffect, useRef, useState } from 'react';
import { useCloud, consoleRun, consoleError } from '../../session';
import { Btn, Modal, Status, Field, nav, type Tone } from '../../components/ui';
import { settle, routeTableOfSubnet, isPublicSubnet, reachableFromInternet, canReachInternet } from '../../../engine/services/ec2';
import type { Instance, SgRule, SecurityGroup, CloudState } from '../../../engine/types';
import './ec2.css';

export const STATE_ES: Record<string, string> = { pending: 'Pendiente', running: 'En ejecución', stopping: 'Deteniéndose', stopped: 'Detenida', 'shutting-down': 'Terminando', terminated: 'Terminada' };
export const TONE: Record<string, Tone> = { pending: 'load', running: 'ok', stopping: 'load', stopped: 'warn', 'shutting-down': 'load', terminated: 'err' };
export const InstState = ({ i }: { i: Instance }) => <Status tone={TONE[i.state]}>{STATE_ES[i.state]}</Status>;

export const dnsOf = (i: Instance) => (i.publicIp ? `ec2-${i.publicIp.replace(/\./g, '-')}.${i.region === 'us-east-1' ? 'compute-1' : i.region + '.compute'}.amazonaws.com` : '');
export const privDnsOf = (i: Instance) => `ip-${i.privateIp.replace(/\./g, '-')}.${i.region === 'us-east-1' ? 'ec2.internal' : i.region + '.compute.internal'}`;

/** Re-renderiza cada segundo mientras haya instancias en transición. */
export function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function useSettled(): CloudState {
  const s = useCloud();
  useTick();
  settle(s);
  return s;
}

export interface MenuItem { label: string; onClick?: () => void; disabled?: boolean; divider?: boolean }
export function Menu({ label, items, kind, disabled, small, left }: { label: string; items: MenuItem[]; kind?: 'primary' | 'danger'; disabled?: boolean; small?: boolean; left?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div className="e2-menu" ref={ref}>
      <Btn kind={kind} small={small} disabled={disabled} onClick={() => setOpen(!open)}>{label} ▾</Btn>
      {open && (
        <div className={`e2-menu-list ${left ? 'left' : ''}`}>
          {items.map((it, k) => it.divider ? <hr key={k} /> : (
            <div key={k} className={it.disabled ? 'dis' : ''} onClick={() => { if (it.disabled) return; setOpen(false); it.onClick?.(); }}>{it.label}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, cur, onChange }: { tabs: [T, string][]; cur: T; onChange: (t: T) => void }) {
  return <div className="e2-tabs">{tabs.map(([k, l]) => <a key={k} className={cur === k ? 'on' : ''} onClick={() => onChange(k)}>{l}</a>)}</div>;
}

export function Kv({ items, cols }: { items: [string, React.ReactNode][]; cols?: 2 | 3 }) {
  return (
    <div className={`e2-kv ${cols === 2 ? 'two' : ''}`}>
      {items.map(([k, v], n) => <div key={k + n}><div className="k">{k}</div><div className="v">{v === undefined || v === null || v === '' ? '-' : v}</div></div>)}
    </div>
  );
}

export const Ic = ({ ok }: { ok: boolean }) => <span className={`e2-ic ${ok ? 'ok' : 'err'}`}>{ok ? '✓' : '✕'}</span>;

export function CmdBox({ cmds }: { cmds: string[] }) {
  return (
    <details className="e2-cli" open>
      <summary>Comando equivalente de la AWS CLI</summary>
      {cmds.map((c, k) => <div key={k}><b>$</b> {c}</div>)}
    </details>
  );
}

export const protoLabel = (r: SgRule) => (r.protocol === '-1' ? 'Todo el tráfico' : r.protocol === 'icmp' ? 'ICMP' : r.protocol.toUpperCase());
export const typeLabel = (r: SgRule) => {
  if (r.protocol === '-1') return 'Todo el tráfico';
  if (r.protocol === 'tcp') return ({ 22: 'SSH', 80: 'HTTP', 443: 'HTTPS', 3389: 'RDP', 3306: 'MYSQL/Aurora', 5432: 'PostgreSQL' } as Record<number, string>)[r.from] && r.from === r.to ? ({ 22: 'SSH', 80: 'HTTP', 443: 'HTTPS', 3389: 'RDP', 3306: 'MYSQL/Aurora', 5432: 'PostgreSQL' } as Record<number, string>)[r.from] : 'TCP personalizado';
  if (r.protocol === 'udp') return 'UDP personalizado';
  return 'ICMP';
};
export const portLabel = (r: SgRule) => (r.protocol === '-1' || r.from === -1 ? 'Todo' : r.from === r.to ? String(r.from) : `${r.from} - ${r.to}`);
export const sourceLabel = (r: SgRule) => r.cidr ?? r.sourceSg ?? '-';

export function RulesTable({ rules, egress }: { rules: SgRule[]; egress?: boolean }) {
  return (
    <div className="e2-wrap tall">
      <table>
        <thead><tr><th>ID de la regla</th><th>Tipo</th><th>Protocolo</th><th>Intervalo de puertos</th><th>{egress ? 'Destino' : 'Origen'}</th><th>Descripción</th></tr></thead>
        <tbody>
          {rules.length === 0 && <tr><td colSpan={6} className="empty"><b>Sin reglas</b>No hay reglas {egress ? 'de salida' : 'de entrada'}; se deniega todo el tráfico.</td></tr>}
          {rules.map((r) => <tr key={r.id}><td>{r.id}</td><td>{typeLabel(r)}</td><td>{protoLabel(r)}</td><td>{portLabel(r)}</td><td>{r.sourceSg ? <a onClick={() => nav('/ec2/sg/' + r.sourceSg)}>{r.sourceSg}</a> : r.cidr}</td><td>{r.description ?? '-'}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

export function SgLink({ id, s }: { id: string; s: CloudState }) {
  const g = s.securityGroups.find((x) => x.id === id);
  return <><a onClick={() => nav('/ec2/sg/' + id)}>{id}</a>{g ? ` (${g.name})` : ''}</>;
}

/** Reglas efectivas + diagnóstico de conectividad de una instancia. */
export function SecurityTab({ i }: { i: Instance }) {
  const s = useCloud();
  const sgs = i.securityGroupIds.map((id) => s.securityGroups.find((g) => g.id === id)).filter(Boolean) as SecurityGroup[];
  const checks = [22, 80, 443].map((p) => ({ p, r: reachableFromInternet(s, i, p) }));
  const out = canReachInternet(s, i);
  const role = s.instanceProfiles.find((p) => p.name === i.iamInstanceProfile);
  return (
    <>
      <Kv items={[
        ['ID de propietario', s.account.id],
        ['Hora de lanzamiento', new Date(i.launchTime).toLocaleString('es-ES')],
        ['Rol de IAM', i.iamInstanceProfile ? <a onClick={() => nav('/iam/roles')}>{role?.roles?.[0] ?? i.iamInstanceProfile}</a> : '-'],
        ['IMDSv2', i.httpTokens === 'required' ? 'Obligatorio' : 'Opcional'],
      ]} />
      <div className="e2-sub e2-sec">Diagnóstico de conectividad</div>
      <div className="e2-diag">
        {checks.map(({ p, r }) => (
          <div key={p}><Ic ok={r.ok} /><span><b>Internet → instancia, TCP/{p}{p === 22 ? ' (SSH)' : p === 80 ? ' (HTTP)' : ' (HTTPS)'}</b>: {r.ok ? 'alcanzable' : 'no alcanzable'}<small>{r.reason}</small></span></div>
        ))}
        <div><Ic ok={out.ok} /><span><b>Instancia → Internet (salida)</b>: {out.ok ? 'tiene salida' : 'sin salida'}<small>{out.reason}</small></span></div>
      </div>
      {sgs.map((g) => (
        <div key={g.id} className="e2-sub">
          <div className="e2-sec">Grupo de seguridad <SgLink id={g.id} s={s} /></div>
          <div className="e2-note" style={{ paddingBottom: 4 }}>Reglas de entrada</div>
          <RulesTable rules={g.ingress} />
          <div className="e2-note" style={{ padding: '10px 20px 4px' }}>Reglas de salida</div>
          <RulesTable rules={g.egress} egress />
        </div>
      ))}
    </>
  );
}

export function NetworkTab({ i }: { i: Instance }) {
  const s = useCloud();
  const sub = s.subnets.find((x) => x.id === i.subnetId);
  const rt = sub ? routeTableOfSubnet(s, sub) : undefined;
  const pub = sub ? isPublicSubnet(s, sub) : false;
  return (
    <>
      <Kv items={[
        ['ID de VPC', <a onClick={() => nav('/vpc/vpcs')}>{i.vpcId}</a>],
        ['ID de subred', i.subnetId],
        ['Tipo de subred', pub ? 'Pública (ruta a Internet Gateway)' : 'Privada'],
        ['Zona de disponibilidad', i.az],
        ['Dirección IPv4 pública', i.publicIp],
        ['DNS IPv4 público', dnsOf(i)],
        ['Direcciones IPv4 privadas', i.privateIp],
        ['DNS de IP privada (solo IPv4)', privDnsOf(i)],
        ['Asignación automática de IP pública', sub?.mapPublicIpOnLaunch ? 'Habilitada en la subred' : 'Deshabilitada en la subred'],
      ]} />
      {rt && (
        <div className="e2-sub">
          <div className="e2-sec">Tabla de rutas {rt.id}</div>
          <div className="e2-wrap tall"><table><thead><tr><th>Destino</th><th>Destino de la ruta</th></tr></thead><tbody>{rt.routes.map((r) => <tr key={r.destination}><td>{r.destination}</td><td>{r.target}</td></tr>)}</tbody></table></div>
        </div>
      )}
    </>
  );
}

export function StorageTab({ i }: { i: Instance }) {
  const s = useCloud();
  const vols = s.volumes.filter((v) => v.attachedTo === i.id || v.id === i.rootVolumeId);
  return (
    <div className="e2-wrap tall">
      <table>
        <thead><tr><th>ID del volumen</th><th>Nombre del dispositivo</th><th>Tamaño del volumen (GiB)</th><th>Tipo</th><th>Estado de asociación</th><th>Cifrado</th><th>Eliminar al terminar</th></tr></thead>
        <tbody>
          {vols.length === 0 && <tr><td colSpan={7} className="empty"><b>Sin volúmenes</b>{i.state === 'terminated' ? 'Los volúmenes se eliminaron al terminar la instancia.' : 'No hay volúmenes asociados.'}</td></tr>}
          {vols.map((v) => <tr key={v.id}><td>{v.id}</td><td>{v.id === i.rootVolumeId ? '/dev/xvda (raíz)' : '-'}</td><td>{v.sizeGiB}</td><td>{v.type}</td><td><Status tone="ok">{v.state === 'in-use' ? 'Asociado' : v.state}</Status></td><td>{v.encrypted ? 'Cifrado' : 'No cifrado'}</td><td>{v.deleteOnTermination ? 'Sí' : 'No'}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

export function StatusTab({ i }: { i: Instance }) {
  const ok = i.state === 'running';
  return (
    <>
      <div className="e2-sec">Comprobaciones de estado</div>
      <Kv cols={2} items={[
        ['Comprobación de estado del sistema', ok ? <span className="e2-ok"><Ic ok />Comprobación aprobada</span> : i.state === 'pending' ? 'Inicializando' : 'No disponible'],
        ['Comprobación de estado de la instancia', ok ? <span className="e2-ok"><Ic ok />Comprobación aprobada</span> : i.state === 'pending' ? 'Inicializando' : 'No disponible'],
      ]} />
      <div className="e2-sub e2-sec">Alarmas de CloudWatch</div>
      <div className="e2-empty" style={{ padding: '14px 0 22px' }}><b>No hay alarmas</b>Esta instancia no tiene alarmas de CloudWatch asociadas.</div>
    </>
  );
}

export function MonitorTab({ i }: { i: Instance }) {
  const info = INSTANCE_HOURLY(i.type);
  const ms = i.billedMs + (i.runningSince ? Date.now() - i.runningSince : 0);
  const h = ms / 3600000;
  return (
    <>
      <Kv items={[
        ['Monitoreo detallado', 'Deshabilitado (monitoreo básico, 5 minutos)'],
        ['Tiempo facturable acumulado', `${h.toFixed(3)} horas`],
        ['Coste estimado de cómputo', `${(h * info).toFixed(4)} USD (a ${info.toFixed(4)} USD/hora)`],
      ]} />
      <div className="e2-note">Las métricas de CloudWatch (CPU, red, disco) no se simulan en este laboratorio.</div>
    </>
  );
}
import { INSTANCE_TYPES } from '../../../engine/catalog';
const INSTANCE_HOURLY = (t: string) => INSTANCE_TYPES[t]?.hourly ?? 0;

/** Modal de edición de etiquetas (create-tags). El CLI simulado no soporta delete-tags. */
export function TagsModal({ i, onClose, onDone }: { i: Instance; onClose: () => void; onDone: (m: { kind: 'ok' | 'err'; text: string }) => void }) {
  const s = useCloud();
  const [rows, setRows] = useState<{ k: string; v: string; locked: boolean }[]>(Object.entries(i.tags).map(([k, v]) => ({ k, v, locked: true })));
  const [err, setErr] = useState('');
  const save = async () => {
    const seen = new Set<string>();
    for (const r of rows) {
      if (!r.k.trim()) return setErr('La clave de la etiqueta no puede estar vacía.');
      if (r.k.length > 128) return setErr('La clave de etiqueta admite un máximo de 128 caracteres.');
      if (r.k.startsWith('aws:')) return setErr('Las claves de etiqueta no pueden empezar por "aws:".');
      if (seen.has(r.k)) return setErr(`Clave de etiqueta duplicada: ${r.k}`);
      seen.add(r.k);
    }
    const changed = rows.filter((r) => i.tags[r.k] !== r.v);
    if (!changed.length) return onClose();
    const tags = JSON.stringify(changed.map((r) => ({ Key: r.k, Value: r.v })));
    const r = await consoleRun(`aws ec2 create-tags --region ${s.region} --resources ${i.id} --tags '${tags.replace(/'/g, "'\\''")}'`);
    if (r.ok) { onDone({ kind: 'ok', text: `Se actualizaron correctamente las etiquetas de ${i.id}.` }); onClose(); } else setErr(consoleError(r.err));
  };
  return (
    <Modal title="Administrar etiquetas" onClose={onClose} footer={<><Btn onClick={onClose}>Cancelar</Btn><Btn kind="primary" onClick={save}>Guardar</Btn></>}>
      <p style={{ marginTop: 0, color: 'var(--muted)' }}>Una etiqueta es un par clave-valor que se asocia a un recurso.</p>
      {rows.map((r, k) => (
        <div key={k} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input type="text" placeholder="Clave" disabled={r.locked} value={r.k} onChange={(e) => setRows(rows.map((x, j) => (j === k ? { ...x, k: e.target.value } : x)))} style={{ flex: 1, height: 32, border: '1px solid var(--line2)', borderRadius: 2, padding: '0 8px', background: 'var(--card)', color: 'var(--text)' }} />
          <input type="text" placeholder="Valor" value={r.v} onChange={(e) => setRows(rows.map((x, j) => (j === k ? { ...x, v: e.target.value } : x)))} style={{ flex: 1, height: 32, border: '1px solid var(--line2)', borderRadius: 2, padding: '0 8px', background: 'var(--card)', color: 'var(--text)' }} />
        </div>
      ))}
      <Btn small onClick={() => setRows([...rows, { k: '', v: '', locked: false }])}>Agregar nueva etiqueta</Btn>
      {err && <div className="e2-err" style={{ marginTop: 10 }}>{err}</div>}
      <div className="e2-note" style={{ padding: '10px 0 0' }}>Puede agregar o modificar etiquetas. La eliminación de etiquetas no está disponible en el simulador.</div>
    </Modal>
  );
}

export function TagsTab({ i, onDone }: { i: Instance; onDone: (m: { kind: 'ok' | 'err'; text: string }) => void }) {
  const [edit, setEdit] = useState(false);
  const tags = Object.entries(i.tags);
  return (
    <>
      <div className="e2-head" style={{ borderBottom: 0, paddingBottom: 0 }}><h2 style={{ fontSize: 16 }}>Etiquetas<span className="count">({tags.length})</span></h2><Btn small onClick={() => setEdit(true)}>Administrar etiquetas</Btn></div>
      <div className="e2-wrap tall">
        <table>
          <thead><tr><th>Clave</th><th>Valor</th></tr></thead>
          <tbody>
            {tags.length === 0 && <tr><td colSpan={2} className="empty"><b>No hay etiquetas</b>No tiene etiquetas asociadas a este recurso.</td></tr>}
            {tags.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}
          </tbody>
        </table>
      </div>
      {edit && <TagsModal i={i} onClose={() => setEdit(false)} onDone={onDone} />}
    </>
  );
}

export const DETAIL_TABS: ['details' | 'status' | 'monitor' | 'security' | 'network' | 'storage' | 'tags', string][] = [
  ['details', 'Detalles'], ['status', 'Estado y alarmas'], ['monitor', 'Monitoreo'], ['security', 'Seguridad'], ['network', 'Redes'], ['storage', 'Almacenamiento'], ['tags', 'Etiquetas'],
];
export type DetailTab = (typeof DETAIL_TABS)[number][0];

export function DetailsTab({ i }: { i: Instance }) {
  const s = useCloud();
  const info = INSTANCE_TYPES[i.type];
  const ami = AMI_BY_ID(i.imageId);
  return (
    <>
      <div className="e2-sec">Resumen de la instancia</div>
      <Kv items={[
        ['ID de instancia', i.id],
        ['Dirección IPv4 pública', i.publicIp ? <>{i.publicIp}</> : '-'],
        ['Direcciones IPv4 privadas', i.privateIp],
        ['Estado de la instancia', <InstState i={i} />],
        ['DNS IPv4 público', dnsOf(i)],
        ['DNS de IP privada (solo IPv4)', privDnsOf(i)],
        ['Tipo de instancia', i.type],
        ['ID de VPC', i.vpcId],
        ['ID de subred', i.subnetId],
        ['ARN de la instancia', `arn:aws:ec2:${i.region}:${s.account.id}:instance/${i.id}`],
        ['Perfil de instancia de IAM', i.iamInstanceProfile],
        ['IMDSv2', i.httpTokens === 'required' ? 'Obligatorio' : 'Opcional'],
      ]} />
      <div className="e2-sub e2-sec">Detalles de la instancia</div>
      <Kv items={[
        ['Plataforma', ami?.description ?? i.imageId],
        ['ID de AMI', i.imageId],
        ['Nombre de AMI', ami?.name],
        ['Hora de lanzamiento', new Date(i.launchTime).toLocaleString('es-ES', { dateStyle: 'long', timeStyle: 'medium' })],
        ['Par de claves asignado', i.keyName],
        ['vCPU / Memoria', info ? `${info.vcpu} vCPU / ${info.memGiB} GiB` : '-'],
        ['Zona de disponibilidad', i.az],
        ['Arquitectura', 'x86_64'],
        ['Tipo de dispositivo raíz', 'EBS (/dev/xvda)'],
      ]} />
    </>
  );
}
import { AMIS } from '../../../engine/catalog';
const AMI_BY_ID = (id: string) => AMIS.find((a) => a.id === id);

export function InstanceTabs({ i, tab, setTab, onDone }: { i: Instance; tab: DetailTab; setTab: (t: DetailTab) => void; onDone: (m: { kind: 'ok' | 'err'; text: string }) => void }) {
  return (
    <>
      <Tabs tabs={DETAIL_TABS} cur={tab} onChange={setTab} />
      {tab === 'details' && <DetailsTab i={i} />}
      {tab === 'status' && <StatusTab i={i} />}
      {tab === 'monitor' && <MonitorTab i={i} />}
      {tab === 'security' && <SecurityTab i={i} />}
      {tab === 'network' && <NetworkTab i={i} />}
      {tab === 'storage' && <StorageTab i={i} />}
      {tab === 'tags' && <TagsTab i={i} onDone={onDone} />}
    </>
  );
}

/** Confirmación genérica para detener/terminar. */
export function ConfirmModal({ title, body, confirm, danger, onCancel, onConfirm }: { title: string; body: React.ReactNode; confirm: string; danger?: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Modal title={title} onClose={onCancel} footer={<><Btn onClick={onCancel}>Cancelar</Btn><Btn kind={danger ? 'primary' : 'primary'} onClick={onConfirm}>{confirm}</Btn></>}>
      {body}
    </Modal>
  );
}
export { Field };

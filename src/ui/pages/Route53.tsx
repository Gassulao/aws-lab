// Consola de Route 53: zonas alojadas, registros (simple, alias, ponderado, conmutación por error) y comprobaciones de estado.
import React, { useState } from 'react';
import { useCloud } from '../session';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, Modal, PageHead, Status, Table, nav, fmtDate } from '../components/ui';
import { ConfirmModal, Dl, Menu, run, setNextFlash, takeFlash, q } from './iam/kit';
import { hcStatus } from '../../engine/services/route53';
import type { HostedZone, RecordSet } from '../../engine/types';

const root = { label: 'Route 53', to: '/route53/zones' };
const Err = ({ msg, onClose }: { msg: string; onClose: () => void }) => (msg ? <Flash kind="err" title="Error" onClose={onClose}>{msg}</Flash> : null);

export function Route53Pages({ path }: { path: string }) {
  const parts = path.split('?')[0].split('/').map((x) => decodeURIComponent(x));
  if (parts[2] === 'zone') return <ZoneDetail key={parts[3]} id={parts[3] ?? ''} />;
  if (parts[2] === 'health') return <HealthChecks />;
  return <Zones />;
}

function Zones() {
  const s = useCloud();
  const [flash, setFlash] = useState(takeFlash);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [priv, setPriv] = useState(false);
  const [vpc, setVpc] = useState('');
  const [comment, setComment] = useState('');
  const [err, setErr] = useState('');
  const vpcs = s.vpcs.filter((v) => v.region === s.region);
  const cmd = `aws route53 create-hosted-zone --name ${name || '<dominio>'} --caller-reference ${q('consola-' + (name || 'zona'))}${comment ? ` --hosted-zone-config Comment=${q(comment)}${priv ? ',PrivateZone=true' : ''}` : priv ? ' --hosted-zone-config PrivateZone=true' : ''}${priv ? ` --vpc VPCRegion=${s.region},VPCId=${vpc || '<vpc>'}` : ''}`;
  return (
    <>
      <Crumbs items={[root, { label: 'Zonas alojadas' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <PageHead title="Zonas alojadas" desc="Una zona alojada contiene los registros DNS de un dominio. Las zonas públicas responden en Internet y las privadas solo dentro de sus VPC." />
      <Card title="Zonas alojadas" count={s.zones.length} flush actions={<Btn kind="primary" onClick={() => { setName(''); setPriv(false); setVpc(vpcs[0]?.id ?? ''); setComment(''); setErr(''); setOpen(true); }}>Crear zona alojada</Btn>}>
        <Table rows={s.zones} id={(z) => z.id} filterPlaceholder="Buscar zonas" empty={{ title: 'No hay zonas alojadas', desc: 'Cree una zona alojada para administrar los registros DNS de su dominio.' }} cols={[
          { head: 'Nombre de dominio', cell: (z) => <a onClick={() => nav('/route53/zone/' + z.id)}>{z.name.replace(/\.$/, '')}</a>, text: (z) => z.name }, { head: 'Tipo', cell: (z) => (z.isPrivate ? 'Privada' : 'Pública') },
          { head: 'ID de la zona alojada', cell: (z) => z.id }, { head: 'Registros', cell: (z) => z.records.length }, { head: 'Descripción', cell: (z) => z.comment ?? '-' },
        ]} />
      </Card>
      {open && (
        <Modal title="Crear zona alojada" onClose={() => setOpen(false)} footer={<><Btn onClick={() => setOpen(false)}>Cancelar</Btn><Btn kind="primary" disabled={!name || (priv && !vpc)} onClick={async () => { const r = await run(cmd); if (!r.ok) { setErr(r.msg); return; } setOpen(false); setFlash(`Zona alojada ${name} creada correctamente.`); }}>Crear zona alojada</Btn></>}>
          <Err msg={err} onClose={() => setErr('')} />
          <Field label="Nombre de dominio"><input className="k-input" aria-label="Nombre de dominio" value={name} onChange={(e) => setName(e.target.value)} placeholder="ejemplo.com" autoFocus /></Field>
          <Field label="Descripción (opcional)"><input className="k-input" aria-label="Descripción" value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
          <Field label="Tipo"><select className="k-select" aria-label="Tipo de zona" value={priv ? 'priv' : 'pub'} onChange={(e) => setPriv(e.target.value === 'priv')}><option value="pub">Zona alojada pública</option><option value="priv">Zona alojada privada</option></select></Field>
          {priv && <Field label="VPC asociada"><select className="k-select" aria-label="VPC" value={vpc} onChange={(e) => setVpc(e.target.value)}>{vpcs.map((v) => <option key={v.id} value={v.id}>{v.tags.Name ?? v.id} ({v.cidr})</option>)}</select></Field>}
          <CliEquivalent cmd={cmd} />
        </Modal>
      )}
    </>
  );
}

const policyOf = (r: RecordSet) => (r.failover ? `Conmutación por error (${r.failover === 'PRIMARY' ? 'principal' : 'secundario'})` : r.weight !== undefined ? `Ponderada (${r.weight})` : 'Simple');
const valueOf = (r: RecordSet) => (r.alias ? `Alias: ${r.alias.dnsName.replace(/\.$/, '')}` : r.values.join('\n'));

function ZoneDetail({ id }: { id: string }) {
  const s = useCloud();
  const z = s.zones.find((x) => x.id === id);
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const [del, setDel] = useState(false);
  const [delRec, setDelRec] = useState<RecordSet | null>(null);
  if (!z) return <><Crumbs items={[root, { label: 'Zonas alojadas', to: '/route53/zones' }]} /><Flash kind="err" title="NoSuchHostedZone">No existe ninguna zona alojada con el ID {id}.</Flash></>;
  const batch = (a: string, r: RecordSet) => `aws route53 change-resource-record-sets --hosted-zone-id ${z.id} --change-batch ${q(JSON.stringify({ Changes: [{ Action: a, ResourceRecordSet: rrJson(r) }] }))}`;
  return (
    <>
      <Crumbs items={[root, { label: 'Zonas alojadas', to: '/route53/zones' }, { label: z.name.replace(/\.$/, '') }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <Err msg={err} onClose={() => setErr('')} />
      <PageHead title={z.name.replace(/\.$/, '')}><Menu label="Acciones" items={[{ label: 'Eliminar zona', onClick: () => setDel(true) }]} /></PageHead>
      <Card title="Detalles de la zona"><Dl items={[['ID', z.id], ['Tipo', z.isPrivate ? 'Privada' : 'Pública'], ['Registros', z.records.length], ['Creada', fmtDate(z.createdAt)], ['Descripción', z.comment ?? '-'], ['Servidores de nombres', z.isPrivate ? '-' : z.nameServers.join(' · ')]]} /></Card>
      <Card title="Registros" count={z.records.length} flush actions={<Btn kind="primary" onClick={() => setOpen(true)}>Crear registro</Btn>}>
        <Table rows={z.records} id={(r) => `${r.name}|${r.type}|${r.setId ?? ''}`} filterPlaceholder="Buscar registros" empty={{ title: 'No hay registros', desc: 'Cree un registro para que el dominio apunte a un servidor.' }} cols={[
          { head: 'Nombre del registro', cell: (r) => r.name.replace(/\.$/, ''), text: (r) => r.name }, { head: 'Tipo', cell: (r) => r.type }, { head: 'Política de enrutamiento', cell: policyOf },
          { head: 'Alias', cell: (r) => (r.alias ? 'Sí' : 'No') }, { head: 'Valor o destino del tráfico', cell: (r) => <span style={{ whiteSpace: 'pre-line' }}>{valueOf(r)}</span> }, { head: 'TTL', cell: (r) => (r.ttl ?? '-') },
          { head: 'Acciones', cell: (r) => (r.type === 'NS' || r.type === 'SOA' ? '-' : <Btn small onClick={() => setDelRec(r)}>Eliminar</Btn>) },
        ]} />
      </Card>
      {open && <CreateRecord z={z} onClose={() => setOpen(false)} done={(m) => { setOpen(false); setFlash(m); }} />}
      {delRec && <ConfirmModal title="Eliminar registro" danger confirmLabel="Eliminar" onClose={() => setDelRec(null)} onConfirm={async () => { const r = await run(batch('DELETE', delRec)); setDelRec(null); if (!r.ok) setErr(r.msg); else setFlash('Registro eliminado correctamente.'); }}>¿Eliminar el registro <b>{delRec.name} {delRec.type}</b>?</ConfirmModal>}
      {del && <ConfirmModal title="Eliminar zona alojada" danger confirmLabel="Eliminar" onClose={() => setDel(false)} onConfirm={async () => { const r = await run(`aws route53 delete-hosted-zone --id ${z.id}`); if (!r.ok) { setErr(r.msg); setDel(false); return; } setNextFlash(`Zona ${z.name.replace(/\.$/, '')} eliminada.`); nav('/route53/zones'); }}>¿Eliminar <b>{z.name.replace(/\.$/, '')}</b>? Debe estar vacía (solo con los registros NS y SOA).</ConfirmModal>}
    </>
  );
}

function rrJson(r: RecordSet) {
  return {
    Name: r.name, Type: r.type, ...(r.setId ? { SetIdentifier: r.setId } : {}), ...(r.weight !== undefined ? { Weight: r.weight } : {}), ...(r.failover ? { Failover: r.failover } : {}), ...(r.healthCheckId ? { HealthCheckId: r.healthCheckId } : {}),
    ...(r.alias ? { AliasTarget: { HostedZoneId: r.alias.zoneId, DNSName: r.alias.dnsName, EvaluateTargetHealth: r.alias.evalHealth } } : { TTL: r.ttl, ResourceRecords: r.values.map((Value) => ({ Value })) }),
  };
}

function CreateRecord({ z, onClose, done }: { z: HostedZone; onClose: () => void; done: (m: string) => void }) {
  const s = useCloud();
  const [f, setF] = useState({ sub: '', type: 'A', target: 'value', value: '', ttl: '300', policy: 'simple', setId: '', weight: '50', failover: 'PRIMARY', hc: '', lb: '' });
  const [err, setErr] = useState('');
  const full = (f.sub ? f.sub + '.' : '') + z.name;
  const lbs = s.loadBalancers;
  const lb = lbs.find((l) => l.arn === f.lb);
  const rec: RecordSet = {
    name: full, type: f.type, values: f.target === 'alias' ? [] : f.value.split('\n').map((x) => x.trim()).filter(Boolean), ttl: f.target === 'alias' ? undefined : Number(f.ttl),
    ...(f.target === 'alias' && lb ? { alias: { zoneId: lb.zoneId, dnsName: lb.dnsName, evalHealth: true } } : {}),
    ...(f.policy !== 'simple' ? { setId: f.setId || '<id>' } : {}), ...(f.policy === 'weighted' ? { weight: Number(f.weight) } : {}), ...(f.policy === 'failover' ? { failover: f.failover as 'PRIMARY' } : {}), ...(f.hc ? { healthCheckId: f.hc } : {}),
  };
  const cmd = `aws route53 change-resource-record-sets --hosted-zone-id ${z.id} --change-batch ${q(JSON.stringify({ Changes: [{ Action: 'CREATE', ResourceRecordSet: rrJson(rec) }] }))}`;
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  return (
    <Modal title="Crear registro" onClose={onClose} footer={<><Btn onClick={onClose}>Cancelar</Btn><Btn kind="primary" disabled={f.target === 'alias' ? !lb : !f.value} onClick={async () => { const r = await run(cmd); if (!r.ok) { setErr(r.msg); return; } done(`Registro ${full.replace(/\.$/, '')} creado (cambio pendiente de propagarse).`); }}>Crear registro</Btn></>}>
      <Err msg={err} onClose={() => setErr('')} />
      <Field label="Nombre del registro" hint={`Deje el subdominio vacío para el dominio raíz (${z.name.replace(/\.$/, '')}).`}><div className="cw-row"><input className="k-input" aria-label="Subdominio" value={f.sub} onChange={(e) => set('sub', e.target.value)} placeholder="www" /><span>.{z.name.replace(/\.$/, '')}</span></div></Field>
      <Field label="Tipo de registro"><select className="k-select" aria-label="Tipo de registro" value={f.type} onChange={(e) => set('type', e.target.value)}>{['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS'].map((t) => <option key={t}>{t}</option>)}</select></Field>
      <Field label="Destino"><select className="k-select" aria-label="Destino" value={f.target} onChange={(e) => set('target', e.target.value)}><option value="value">Valor (direcciones IP u otro nombre)</option><option value="alias">Alias de un balanceador de carga</option></select></Field>
      {f.target === 'alias'
        ? <Field label="Balanceador de carga"><select className="k-select" aria-label="Balanceador de carga" value={f.lb} onChange={(e) => set('lb', e.target.value)}><option value="">Elija un balanceador</option>{lbs.map((l) => <option key={l.arn} value={l.arn}>{l.name} ({l.dnsName})</option>)}</select></Field>
        : <><Field label="Valor" hint="Un valor por línea."><textarea className="k-input" aria-label="Valor" rows={3} value={f.value} onChange={(e) => set('value', e.target.value)} /></Field><Field label="TTL (segundos)"><input className="k-input" aria-label="TTL" value={f.ttl} onChange={(e) => set('ttl', e.target.value)} /></Field></>}
      <Field label="Política de enrutamiento"><select className="k-select" aria-label="Política de enrutamiento" value={f.policy} onChange={(e) => set('policy', e.target.value)}><option value="simple">Simple</option><option value="weighted">Ponderada</option><option value="failover">Conmutación por error</option></select></Field>
      {f.policy !== 'simple' && <Field label="Identificador del registro"><input className="k-input" aria-label="Identificador del registro" value={f.setId} onChange={(e) => set('setId', e.target.value)} /></Field>}
      {f.policy === 'weighted' && <Field label="Peso (0-255)"><input className="k-input" aria-label="Peso" value={f.weight} onChange={(e) => set('weight', e.target.value)} /></Field>}
      {f.policy === 'failover' && <Field label="Tipo de conmutación por error"><select className="k-select" aria-label="Tipo de conmutación" value={f.failover} onChange={(e) => set('failover', e.target.value)}><option value="PRIMARY">Principal</option><option value="SECONDARY">Secundario</option></select></Field>}
      {f.policy !== 'simple' && s.healthChecks.length > 0 && <Field label="Comprobación de estado (opcional)"><select className="k-select" aria-label="Comprobación de estado" value={f.hc} onChange={(e) => set('hc', e.target.value)}><option value="">Ninguna</option>{s.healthChecks.map((h) => <option key={h.id} value={h.id}>{h.ip ?? h.fqdn}:{h.port}{h.path ?? ''} ({h.id.slice(0, 8)})</option>)}</select></Field>}
      <CliEquivalent cmd={cmd} />
    </Modal>
  );
}

function HealthChecks() {
  const s = useCloud();
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const [ip, setIp] = useState('');
  const [port, setPort] = useState('80');
  const [path, setPath] = useState('/');
  const cmd = `aws route53 create-health-check --caller-reference ${q('consola-' + (ip || 'hc'))} --health-check-config IPAddress=${ip || '<ip>'},Port=${port},Type=HTTP,ResourcePath=${path}`;
  return (
    <>
      <Crumbs items={[root, { label: 'Comprobaciones de estado' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <Err msg={err} onClose={() => setErr('')} />
      <PageHead title="Comprobaciones de estado" desc="Route 53 comprueba un punto de enlace; si falla, los registros de conmutación por error dejan de usarlo." />
      <Card title="Comprobaciones de estado" count={s.healthChecks.length} flush actions={<Btn kind="primary" onClick={() => { setIp(''); setOpen(true); }}>Crear comprobación de estado</Btn>}>
        <Table rows={s.healthChecks} id={(h) => h.id} empty={{ title: 'No hay comprobaciones de estado', desc: 'Cree una para vigilar un servidor y habilitar la conmutación por error.' }} cols={[
          { head: 'ID', cell: (h) => h.id }, { head: 'Punto de enlace', cell: (h) => `${h.type}://${h.ip ?? h.fqdn}:${h.port}${h.path ?? ''}` }, { head: 'Intervalo', cell: (h) => `${h.interval} s` },
          { head: 'Estado', cell: (h) => { const st = hcStatus(s, h); return <Status tone={st.ok ? 'ok' : 'err'}>{st.ok ? 'Correcto' : 'Incorrecto'}</Status>; } },
          { head: 'Acciones', cell: (h) => <Btn small onClick={async () => { const r = await run(`aws route53 delete-health-check --health-check-id ${h.id}`); if (!r.ok) setErr(r.msg); else setFlash('Comprobación eliminada.'); }}>Eliminar</Btn> },
        ]} />
      </Card>
      {open && (
        <Modal title="Crear comprobación de estado" onClose={() => setOpen(false)} footer={<><Btn onClick={() => setOpen(false)}>Cancelar</Btn><Btn kind="primary" disabled={!ip} onClick={async () => { const r = await run(cmd); if (!r.ok) { setErr(r.msg); setOpen(false); return; } setOpen(false); setFlash('Comprobación de estado creada.'); }}>Crear</Btn></>}>
          <Field label="Dirección IP"><input className="k-input" aria-label="Dirección IP" value={ip} onChange={(e) => setIp(e.target.value)} autoFocus /></Field>
          <div className="cw-row"><Field label="Puerto"><input className="k-input" aria-label="Puerto" value={port} onChange={(e) => setPort(e.target.value)} /></Field><Field label="Ruta"><input className="k-input" aria-label="Ruta" value={path} onChange={(e) => setPath(e.target.value)} /></Field></div>
          <CliEquivalent cmd={cmd} />
        </Modal>
      )}
    </>
  );
}

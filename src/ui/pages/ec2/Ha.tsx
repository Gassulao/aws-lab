// Consola de balanceadores de carga, grupos de destino, grupos de Auto Scaling y plantillas de lanzamiento.
import React, { useState } from 'react';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, Modal, PageHead, Status, Table, nav, fmtDate, type Tone } from '../../components/ui';
import { ConfirmModal, Dl, Menu, run, setNextFlash, takeFlash, q } from '../iam/kit';
import { useSettled } from './common';
import { elbHealthy, lbState, targetHealth } from '../../../engine/services/elbv2';
import { groupInstances } from '../../../engine/services/autoscaling';
import { AMIS, INSTANCE_TYPES } from '../../../engine/catalog';
import type { CloudState, TargetGroup } from '../../../engine/types';

const root = { label: 'EC2', to: '/ec2' };
const ST: Record<string, [string, Tone]> = { healthy: ['Correcto', 'ok'], unhealthy: ['Incorrecto', 'err'], initial: ['Inicial', 'load'], unused: ['No utilizado', 'warn'], draining: ['Drenando', 'warn'], active: ['Activo', 'ok'], provisioning: ['Aprovisionando', 'load'] };
const Badge = ({ v }: { v: string }) => <Status tone={ST[v]?.[1] ?? ''}>{ST[v]?.[0] ?? v}</Status>;
const short = (arn: string) => arn.split('/')[1] ?? arn;
const Err = ({ msg, onClose }: { msg: string; onClose: () => void }) => (msg ? <Flash kind="err" title="Error" onClose={onClose}>{msg}</Flash> : null);
const vpcName = (s: CloudState, id: string) => s.vpcs.find((v) => v.id === id)?.tags.Name ?? id;
const checks = (items: string[], sel: string[], set: (v: string[]) => void, label: (x: string) => string) => items.map((x) => (
  <label key={x} className="cw-check"><input type="checkbox" checked={sel.includes(x)} onChange={() => set(sel.includes(x) ? sel.filter((y) => y !== x) : [...sel, x])} /> {label(x)}</label>
));

// ------------------------------------------------------------------ balanceadores

export function LoadBalancers() {
  const s = useSettled();
  const [flash, setFlash] = useState(takeFlash);
  const [open, setOpen] = useState(false);
  const rows = s.loadBalancers.filter((l) => l.region === s.region);
  return (
    <>
      <Crumbs items={[root, { label: 'Balanceadores de carga' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <PageHead title="Balanceadores de carga" desc="Un Application Load Balancer reparte el tráfico HTTP entre los destinos sanos de un grupo de destino." />
      <Card title="Balanceadores de carga" count={rows.length} flush actions={<Btn kind="primary" onClick={() => setOpen(true)}>Crear balanceador de carga</Btn>}>
        <Table rows={rows} id={(l) => l.name} filterPlaceholder="Buscar balanceadores" empty={{ title: 'No hay balanceadores de carga', desc: 'Cree un Application Load Balancer para repartir el tráfico entre sus instancias.' }} cols={[
          { head: 'Nombre', cell: (l) => <a onClick={() => nav('/ec2/lb/' + l.name)}>{l.name}</a>, text: (l) => l.name }, { head: 'Nombre de DNS', cell: (l) => l.dnsName }, { head: 'Estado', cell: (l) => <Badge v={lbState(l)} /> },
          { head: 'VPC', cell: (l) => vpcName(s, l.vpcId) }, { head: 'Tipo', cell: () => 'application' }, { head: 'Esquema', cell: (l) => l.scheme },
        ]} />
      </Card>
      {open && <CreateLb onClose={() => setOpen(false)} done={(m) => { setNextFlash(m); setOpen(false); setFlash(m); }} />}
    </>
  );
}

function CreateLb({ onClose, done }: { onClose: () => void; done: (m: string) => void }) {
  const s = useSettled();
  const [name, setName] = useState('');
  const [subs, setSubs] = useState<string[]>([]);
  const [sg, setSg] = useState('');
  const [tg, setTg] = useState('');
  const [err, setErr] = useState('');
  const subnets = s.subnets.filter((x) => x.region === s.region && !s.vpcs.find((v) => v.id === x.vpcId)?.isDefault || x.region === s.region);
  const vpcId = s.subnets.find((x) => x.id === subs[0])?.vpcId;
  const sgs = s.securityGroups.filter((g) => g.vpcId === vpcId);
  const tgs = s.targetGroups.filter((g) => g.region === s.region && g.vpcId === vpcId);
  const cmds = [`aws elbv2 create-load-balancer --name ${name || '<nombre>'} --subnets ${subs.join(' ') || '<subredes>'}${sg ? ` --security-groups ${sg}` : ''}`, ...(tg ? [`aws elbv2 create-listener --load-balancer-arn <arn> --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=${tg}`] : [])];
  const go = async () => {
    const r = await run(cmds[0]);
    if (!r.ok) { setErr(r.msg); return; }
    if (tg) { const arn = JSON.parse(r.out).LoadBalancers[0].LoadBalancerArn; const l = await run(cmds[1].replace('<arn>', arn)); if (!l.ok) { setErr(l.msg); return; } }
    done(`Balanceador de carga ${name} creado correctamente.`);
  };
  return (
    <Modal title="Crear Application Load Balancer" onClose={onClose} footer={<><Btn onClick={onClose}>Cancelar</Btn><Btn kind="primary" disabled={!name || subs.length < 1} onClick={go}>Crear balanceador de carga</Btn></>}>
      <Err msg={err} onClose={() => setErr('')} />
      <Field label="Nombre del balanceador"><input className="k-input" aria-label="Nombre del balanceador" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <Field label="Subredes" hint="Elija al menos dos subredes en zonas de disponibilidad distintas."><div>{checks(subnets.map((x) => x.id), subs, setSubs, (id) => { const x = s.subnets.find((y) => y.id === id)!; return `${x.tags.Name ?? id} · ${x.az} · ${x.cidr} (${vpcName(s, x.vpcId)})`; })}</div></Field>
      <Field label="Grupo de seguridad"><select className="k-select" aria-label="Grupo de seguridad" value={sg} onChange={(e) => setSg(e.target.value)}><option value="">Predeterminado de la VPC</option>{sgs.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.id})</option>)}</select></Field>
      <Field label="Oyente HTTP:80 (opcional)"><select className="k-select" aria-label="Grupo de destino" value={tg} onChange={(e) => setTg(e.target.value)}><option value="">Sin oyente por ahora</option>{tgs.map((g) => <option key={g.arn} value={g.arn}>Reenviar a {g.name}</option>)}</select></Field>
      {cmds.map((c) => <CliEquivalent key={c} cmd={c} />)}
    </Modal>
  );
}

export function LbDetail({ name }: { name: string }) {
  const s = useSettled();
  const lb = s.loadBalancers.find((l) => l.name === name && l.region === s.region);
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [del, setDel] = useState(false);
  const [add, setAdd] = useState(false);
  const [tg, setTg] = useState('');
  const [port, setPort] = useState('80');
  if (!lb) return <><Crumbs items={[root, { label: 'Balanceadores de carga', to: '/ec2/lbs' }]} /><Flash kind="err" title="LoadBalancerNotFound">El balanceador {name} no existe en esta región.</Flash></>;
  const ls = s.listeners.filter((l) => l.lbArn === lb.arn);
  const tgs = s.targetGroups.filter((g) => g.vpcId === lb.vpcId && g.region === lb.region);
  return (
    <>
      <Crumbs items={[root, { label: 'Balanceadores de carga', to: '/ec2/lbs' }, { label: lb.name }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <Err msg={err} onClose={() => setErr('')} />
      <PageHead title={lb.name}><Menu label="Acciones" items={[{ label: 'Eliminar balanceador de carga', onClick: () => setDel(true) }]} /></PageHead>
      <Card title="Detalles"><Dl items={[['Estado', <Badge key="s" v={lbState(lb)} />], ['Nombre de DNS', lb.dnsName], ['Tipo', 'application'], ['Esquema', lb.scheme], ['VPC', vpcName(s, lb.vpcId)], ['Zonas', lb.subnets.map((id) => s.subnets.find((x) => x.id === id)?.az).join(', ')], ['Grupos de seguridad', lb.securityGroups.join(', ')], ['Creado', fmtDate(lb.createdAt)], ['ARN', lb.arn], ['Destinos sanos', elbHealthy(s, lb) ? 'Sí' : 'Ninguno']]} /></Card>
      <Card title="Oyentes" count={ls.length} flush actions={<Btn kind="primary" onClick={() => { setTg(tgs[0]?.arn ?? ''); setAdd(true); }}>Añadir oyente</Btn>}>
        <Table rows={ls} id={(l) => l.arn} empty={{ title: 'No hay oyentes', desc: 'Sin oyentes el balanceador no acepta tráfico. Añada uno que reenvíe a un grupo de destino.' }} cols={[
          { head: 'Protocolo:puerto', cell: (l) => `${l.protocol}:${l.port}` }, { head: 'Acción predeterminada', cell: (l) => <a onClick={() => nav('/ec2/tg/' + short(l.tgArn))}>Reenviar a {short(l.tgArn)}</a> },
          { head: 'Acciones', cell: (l) => <Btn small onClick={async () => { const r = await run(`aws elbv2 delete-listener --listener-arn ${l.arn}`); if (!r.ok) setErr(r.msg); else setFlash('Oyente eliminado.'); }}>Eliminar</Btn> },
        ]} />
      </Card>
      {add && (
        <Modal title="Añadir oyente" onClose={() => setAdd(false)} footer={<><Btn onClick={() => setAdd(false)}>Cancelar</Btn><Btn kind="primary" disabled={!tg} onClick={async () => { const r = await run(`aws elbv2 create-listener --load-balancer-arn ${lb.arn} --protocol HTTP --port ${port} --default-actions Type=forward,TargetGroupArn=${tg}`); if (!r.ok) { setErr(r.msg); setAdd(false); } else { setAdd(false); setFlash(`Oyente HTTP:${port} creado.`); } }}>Añadir</Btn></>}>
          <Field label="Puerto"><input className="k-input" aria-label="Puerto" value={port} onChange={(e) => setPort(e.target.value)} /></Field>
          <Field label="Reenviar a"><select className="k-select" aria-label="Grupo de destino" value={tg} onChange={(e) => setTg(e.target.value)}>{tgs.map((g) => <option key={g.arn} value={g.arn}>{g.name}</option>)}</select></Field>
          <CliEquivalent cmd={`aws elbv2 create-listener --load-balancer-arn ${lb.arn} --protocol HTTP --port ${port} --default-actions Type=forward,TargetGroupArn=${tg || '<arn>'}`} />
        </Modal>
      )}
      {del && <ConfirmModal title="Eliminar balanceador de carga" danger confirmLabel="Eliminar" onClose={() => setDel(false)} onConfirm={async () => { const r = await run(`aws elbv2 delete-load-balancer --load-balancer-arn ${lb.arn}`); if (!r.ok) { setErr(r.msg); setDel(false); return; } setNextFlash(`Balanceador de carga ${lb.name} eliminado.`); nav('/ec2/lbs'); }}>¿Eliminar <b>{lb.name}</b> y sus oyentes? Los destinos no se borran.</ConfirmModal>}
    </>
  );
}

// ------------------------------------------------------------------ grupos de destino

export function TargetGroups() {
  const s = useSettled();
  const [flash, setFlash] = useState(takeFlash);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [vpc, setVpc] = useState('');
  const [path, setPath] = useState('/');
  const [err, setErr] = useState('');
  const rows = s.targetGroups.filter((g) => g.region === s.region);
  const vpcs = s.vpcs.filter((v) => v.region === s.region);
  const cmd = `aws elbv2 create-target-group --name ${name || '<nombre>'} --protocol HTTP --port 80 --vpc-id ${vpc || '<vpc>'} --health-check-path ${path}`;
  return (
    <>
      <Crumbs items={[root, { label: 'Grupos de destino' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <PageHead title="Grupos de destino" desc="Un grupo de destino agrupa las instancias que reciben el tráfico y define cómo se comprueba su salud." />
      <Card title="Grupos de destino" count={rows.length} flush actions={<Btn kind="primary" onClick={() => { setName(''); setVpc(vpcs[0]?.id ?? ''); setErr(''); setOpen(true); }}>Crear grupo de destino</Btn>}>
        <Table rows={rows} id={(g) => g.name} filterPlaceholder="Buscar grupos de destino" empty={{ title: 'No hay grupos de destino', desc: 'Cree un grupo de destino y registre en él sus instancias.' }} cols={[
          { head: 'Nombre', cell: (g) => <a onClick={() => nav('/ec2/tg/' + g.name)}>{g.name}</a>, text: (g) => g.name }, { head: 'Puerto', cell: (g) => g.port }, { head: 'Protocolo', cell: (g) => g.protocol }, { head: 'Tipo de destino', cell: () => 'Instancia' },
          { head: 'Balanceador de carga', cell: (g) => [...new Set(s.listeners.filter((l) => l.tgArn === g.arn).map((l) => s.loadBalancers.find((b) => b.arn === l.lbArn)?.name))].join(', ') || 'Ninguno' },
          { head: 'Destinos sanos', cell: (g) => `${g.targets.filter((t) => targetHealth(s, g, t).state === 'healthy').length} / ${g.targets.length}` },
        ]} />
      </Card>
      {open && (
        <Modal title="Crear grupo de destino" onClose={() => setOpen(false)} footer={<><Btn onClick={() => setOpen(false)}>Cancelar</Btn><Btn kind="primary" disabled={!name || !vpc} onClick={async () => { const r = await run(cmd); if (!r.ok) { setErr(r.msg); return; } setOpen(false); setFlash(`Grupo de destino ${name} creado correctamente.`); }}>Crear grupo de destino</Btn></>}>
          <Err msg={err} onClose={() => setErr('')} />
          <Field label="Nombre del grupo de destino"><input className="k-input" aria-label="Nombre del grupo de destino" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
          <Field label="VPC"><select className="k-select" aria-label="VPC" value={vpc} onChange={(e) => setVpc(e.target.value)}>{vpcs.map((v) => <option key={v.id} value={v.id}>{vpcName(s, v.id)} ({v.cidr})</option>)}</select></Field>
          <Field label="Ruta de comprobación de estado"><input className="k-input" aria-label="Ruta de comprobación" value={path} onChange={(e) => setPath(e.target.value)} /></Field>
          <CliEquivalent cmd={cmd} />
        </Modal>
      )}
    </>
  );
}

export function TgDetail({ name }: { name: string }) {
  const s = useSettled();
  const g = s.targetGroups.find((x) => x.name === name && x.region === s.region);
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [reg, setReg] = useState(false);
  const [pick, setPick] = useState<string[]>([]);
  const [del, setDel] = useState(false);
  if (!g) return <><Crumbs items={[root, { label: 'Grupos de destino', to: '/ec2/tgs' }]} /><Flash kind="err" title="TargetGroupNotFound">El grupo de destino {name} no existe en esta región.</Flash></>;
  const candidates = s.instances.filter((i) => i.vpcId === g.vpcId && i.state !== 'terminated' && !g.targets.some((t) => t.id === i.id));
  const rows = g.targets.map((t) => ({ t, h: targetHealth(s, g as TargetGroup, t) }));
  return (
    <>
      <Crumbs items={[root, { label: 'Grupos de destino', to: '/ec2/tgs' }, { label: g.name }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <Err msg={err} onClose={() => setErr('')} />
      <PageHead title={g.name}><Menu label="Acciones" items={[{ label: 'Eliminar grupo de destino', onClick: () => setDel(true) }]} /></PageHead>
      <Card title="Detalles"><Dl items={[['Protocolo:puerto', `${g.protocol}:${g.port}`], ['Tipo de destino', 'Instancia'], ['VPC', vpcName(s, g.vpcId)], ['Ruta de comprobación', g.hc.path], ['Intervalo', `${g.hc.interval} s`], ['Umbral sano / no sano', `${g.hc.healthy} / ${g.hc.unhealthy}`], ['Código de éxito', g.hc.matcher], ['ARN', g.arn]]} /></Card>
      <Card title="Destinos registrados" count={g.targets.length} flush actions={<Btn kind="primary" onClick={() => { setPick([]); setReg(true); }}>Registrar destinos</Btn>}>
        <Table rows={rows} id={(r) => r.t.id} empty={{ title: 'No hay destinos registrados', desc: 'Registre instancias para que reciban tráfico del balanceador.' }} cols={[
          { head: 'ID de instancia', cell: (r) => <a onClick={() => nav('/ec2/instance/' + r.t.id)}>{r.t.id}</a>, text: (r) => r.t.id }, { head: 'Puerto', cell: (r) => r.t.port }, { head: 'Zona', cell: (r) => s.instances.find((i) => i.id === r.t.id)?.az ?? '-' },
          { head: 'Estado de salud', cell: (r) => <Badge v={r.h.state} /> }, { head: 'Detalles del estado', cell: (r) => (r.h.description ? `${r.h.reason}: ${r.h.description}` : '-') },
          { head: 'Acciones', cell: (r) => <Btn small onClick={async () => { const x = await run(`aws elbv2 deregister-targets --target-group-arn ${g.arn} --targets Id=${r.t.id}`); if (!x.ok) setErr(x.msg); else setFlash(`Destino ${r.t.id} anulado.`); }}>Anular registro</Btn> },
        ]} />
      </Card>
      {reg && (
        <Modal title="Registrar destinos" onClose={() => setReg(false)} footer={<><Btn onClick={() => setReg(false)}>Cancelar</Btn><Btn kind="primary" disabled={!pick.length} onClick={async () => { const r = await run(`aws elbv2 register-targets --target-group-arn ${g.arn} --targets ${pick.map((id) => `Id=${id}`).join(' ')}`); if (!r.ok) { setErr(r.msg); setReg(false); } else { setReg(false); setFlash(`${pick.length} destino(s) registrado(s).`); } }}>Registrar</Btn></>}>
          {candidates.length ? checks(candidates.map((i) => i.id), pick, setPick, (id) => { const i = s.instances.find((x) => x.id === id)!; return `${i.tags.Name ?? id} (${id}) · ${i.az} · ${i.state}`; }) : <p>No hay instancias disponibles en la VPC del grupo.</p>}
          <CliEquivalent cmd={`aws elbv2 register-targets --target-group-arn ${g.arn} --targets ${pick.map((id) => `Id=${id}`).join(' ') || 'Id=<instancia>'}`} />
        </Modal>
      )}
      {del && <ConfirmModal title="Eliminar grupo de destino" danger confirmLabel="Eliminar" onClose={() => setDel(false)} onConfirm={async () => { const r = await run(`aws elbv2 delete-target-group --target-group-arn ${g.arn}`); if (!r.ok) { setErr(r.msg); setDel(false); return; } setNextFlash(`Grupo de destino ${g.name} eliminado.`); nav('/ec2/tgs'); }}>¿Eliminar <b>{g.name}</b>?</ConfirmModal>}
    </>
  );
}

// ------------------------------------------------------------------ plantillas de lanzamiento

export function LaunchTemplates() {
  const s = useSettled();
  const [flash, setFlash] = useState(takeFlash);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [ami, setAmi] = useState(AMIS[0].id);
  const [type, setType] = useState('t3.micro');
  const [sg, setSg] = useState('');
  const [web, setWeb] = useState(true);
  const [err, setErr] = useState('');
  const rows = s.launchTemplates.filter((l) => l.region === s.region);
  const ud = btoa('#!/bin/bash\nyum install -y httpd\nsystemctl enable --now httpd');
  const data = JSON.stringify({ ImageId: ami, InstanceType: type, ...(sg ? { SecurityGroupIds: [sg] } : {}), ...(web ? { UserData: ud } : {}) });
  const cmd = `aws ec2 create-launch-template --launch-template-name ${name || '<nombre>'} --launch-template-data ${q(data)}`;
  return (
    <>
      <Crumbs items={[root, { label: 'Plantillas de lanzamiento' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <PageHead title="Plantillas de lanzamiento" desc="Una plantilla de lanzamiento guarda la configuración de las instancias que crea un grupo de Auto Scaling." />
      <Card title="Plantillas de lanzamiento" count={rows.length} flush actions={<Btn kind="primary" onClick={() => { setName(''); setErr(''); setOpen(true); }}>Crear plantilla de lanzamiento</Btn>}>
        <Table rows={rows} id={(l) => l.id} empty={{ title: 'No hay plantillas de lanzamiento', desc: 'Cree una plantilla para usarla en un grupo de Auto Scaling.' }} cols={[
          { head: 'Nombre', cell: (l) => l.name, text: (l) => l.name }, { head: 'ID', cell: (l) => l.id }, { head: 'AMI', cell: (l) => l.imageId }, { head: 'Tipo de instancia', cell: (l) => l.instanceType }, { head: 'Creada', cell: (l) => fmtDate(l.createdAt) },
        ]} />
      </Card>
      {open && (
        <Modal title="Crear plantilla de lanzamiento" onClose={() => setOpen(false)} footer={<><Btn onClick={() => setOpen(false)}>Cancelar</Btn><Btn kind="primary" disabled={!name} onClick={async () => { const r = await run(cmd); if (!r.ok) { setErr(r.msg); return; } setOpen(false); setFlash(`Plantilla ${name} creada correctamente.`); }}>Crear plantilla</Btn></>}>
          <Err msg={err} onClose={() => setErr('')} />
          <Field label="Nombre de la plantilla"><input className="k-input" aria-label="Nombre de la plantilla" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
          <Field label="AMI"><select className="k-select" aria-label="AMI" value={ami} onChange={(e) => setAmi(e.target.value)}>{AMIS.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.id})</option>)}</select></Field>
          <Field label="Tipo de instancia"><select className="k-select" aria-label="Tipo de instancia" value={type} onChange={(e) => setType(e.target.value)}>{Object.keys(INSTANCE_TYPES).map((t) => <option key={t}>{t}</option>)}</select></Field>
          <Field label="Grupo de seguridad"><select className="k-select" aria-label="Grupo de seguridad" value={sg} onChange={(e) => setSg(e.target.value)}><option value="">Predeterminado</option>{s.securityGroups.filter((g) => g.region === s.region).map((g) => <option key={g.id} value={g.id}>{g.name} ({g.id})</option>)}</select></Field>
          <label className="cw-check"><input type="checkbox" checked={web} onChange={(e) => setWeb(e.target.checked)} /> Instalar un servidor web Apache al arrancar (datos de usuario)</label>
          <CliEquivalent cmd={cmd} />
        </Modal>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Auto Scaling

export function Asgs() {
  const s = useSettled();
  const [flash, setFlash] = useState(takeFlash);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', lt: '', min: '2', max: '4', desired: '2', subs: [] as string[], tg: '' });
  const [err, setErr] = useState('');
  const rows = s.asgs.filter((g) => g.region === s.region);
  const lts = s.launchTemplates.filter((l) => l.region === s.region);
  const vpcId = s.subnets.find((x) => x.id === f.subs[0])?.vpcId;
  const cmd = `aws autoscaling create-auto-scaling-group --auto-scaling-group-name ${f.name || '<nombre>'} --launch-template LaunchTemplateName=${f.lt || '<plantilla>'},Version='$Latest' --min-size ${f.min} --max-size ${f.max} --desired-capacity ${f.desired} --vpc-zone-identifier ${f.subs.join(',') || '<subredes>'}${f.tg ? ` --target-group-arns ${f.tg} --health-check-type ELB --health-check-grace-period 120` : ''}`;
  return (
    <>
      <Crumbs items={[root, { label: 'Grupos de Auto Scaling' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <PageHead title="Grupos de Auto Scaling" desc="Mantienen el número de instancias que desee, las reparten entre zonas y sustituyen las que fallan." />
      <Card title="Grupos de Auto Scaling" count={rows.length} flush actions={<Btn kind="primary" onClick={() => { setF({ name: '', lt: lts[0]?.name ?? '', min: '2', max: '4', desired: '2', subs: [], tg: '' }); setErr(''); setOpen(true); }}>Crear grupo de Auto Scaling</Btn>}>
        <Table rows={rows} id={(g) => g.name} filterPlaceholder="Buscar grupos" empty={{ title: 'No hay grupos de Auto Scaling', desc: 'Cree una plantilla de lanzamiento y, después, un grupo que la utilice.' }} cols={[
          { head: 'Nombre', cell: (g) => <a onClick={() => nav('/ec2/asg/' + g.name)}>{g.name}</a>, text: (g) => g.name }, { head: 'Plantilla de lanzamiento', cell: (g) => g.ltName }, { head: 'Instancias', cell: (g) => groupInstances(s, g).length },
          { head: 'Mínimo', cell: (g) => g.min }, { head: 'Deseada', cell: (g) => g.desired }, { head: 'Máximo', cell: (g) => g.max },
          { head: 'Zonas', cell: (g) => [...new Set(g.subnets.map((id) => s.subnets.find((x) => x.id === id)?.az))].join(', ') },
        ]} />
      </Card>
      {open && (
        <Modal title="Crear grupo de Auto Scaling" onClose={() => setOpen(false)} footer={<><Btn onClick={() => setOpen(false)}>Cancelar</Btn><Btn kind="primary" disabled={!f.name || !f.lt || !f.subs.length} onClick={async () => { const r = await run(cmd); if (!r.ok) { setErr(r.msg); return; } setOpen(false); setFlash(`Grupo de Auto Scaling ${f.name} creado correctamente.`); }}>Crear grupo</Btn></>}>
          <Err msg={err} onClose={() => setErr('')} />
          <Field label="Nombre del grupo"><input className="k-input" aria-label="Nombre del grupo" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
          <Field label="Plantilla de lanzamiento" hint={lts.length ? undefined : 'Cree primero una plantilla de lanzamiento.'}><select className="k-select" aria-label="Plantilla de lanzamiento" value={f.lt} onChange={(e) => setF({ ...f, lt: e.target.value })}>{lts.map((l) => <option key={l.id}>{l.name}</option>)}</select></Field>
          <Field label="Subredes (zonas de disponibilidad)"><div>{checks(s.subnets.filter((x) => x.region === s.region && !s.vpcs.find((v) => v.id === x.vpcId)?.isDefault).map((x) => x.id), f.subs, (v) => setF({ ...f, subs: v }), (id) => { const x = s.subnets.find((y) => y.id === id)!; return `${x.tags.Name ?? id} · ${x.az} · ${x.cidr}`; })}</div></Field>
          <Field label="Capacidad: mínima, deseada y máxima"><div className="cw-row">{(['min', 'desired', 'max'] as const).map((k) => <input key={k} className="k-input" style={{ width: 80 }} aria-label={k === 'min' ? 'Mínimo' : k === 'max' ? 'Máximo' : 'Deseada'} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />)}</div></Field>
          <Field label="Grupo de destino (opcional)"><select className="k-select" aria-label="Grupo de destino" value={f.tg} onChange={(e) => setF({ ...f, tg: e.target.value })}><option value="">Sin balanceador</option>{s.targetGroups.filter((g) => g.vpcId === vpcId).map((g) => <option key={g.arn} value={g.arn}>{g.name}</option>)}</select></Field>
          <CliEquivalent cmd={cmd} />
        </Modal>
      )}
    </>
  );
}

export function AsgDetail({ name }: { name: string }) {
  const s = useSettled();
  const g = s.asgs.find((x) => x.name === name && x.region === s.region);
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState(false);
  const [cap, setCap] = useState({ min: '', desired: '', max: '' });
  const [del, setDel] = useState(false);
  if (!g) return <><Crumbs items={[root, { label: 'Grupos de Auto Scaling', to: '/ec2/asgs' }]} /><Flash kind="err" title="ValidationError">El grupo {name} no existe en esta región.</Flash></>;
  const inst = groupInstances(s, g);
  const cmd = `aws autoscaling update-auto-scaling-group --auto-scaling-group-name ${g.name} --min-size ${cap.min} --max-size ${cap.max} --desired-capacity ${cap.desired}`;
  return (
    <>
      <Crumbs items={[root, { label: 'Grupos de Auto Scaling', to: '/ec2/asgs' }, { label: g.name }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <Err msg={err} onClose={() => setErr('')} />
      <PageHead title={g.name}><Menu label="Acciones" items={[{ label: 'Editar capacidad', onClick: () => { setCap({ min: String(g.min), desired: String(g.desired), max: String(g.max) }); setEdit(true); } }, { label: 'Eliminar grupo de Auto Scaling', onClick: () => setDel(true) }]} /></PageHead>
      <Card title="Detalles"><Dl items={[['Plantilla de lanzamiento', g.ltName], ['Capacidad deseada', g.desired], ['Mínimo / máximo', `${g.min} / ${g.max}`], ['Tipo de comprobación de estado', g.healthCheckType], ['Periodo de gracia', `${g.grace} s`], ['Subredes', g.subnets.join(', ')], ['Grupos de destino', g.tgArns.map(short).join(', ') || 'Ninguno'], ['ARN', g.arn]]} /></Card>
      <Card title="Instancias" count={inst.length} flush>
        <Table rows={inst} id={(i) => i.id} empty={{ title: 'El grupo no tiene instancias', desc: 'Con capacidad deseada 0 no se lanza ninguna instancia.' }} cols={[
          { head: 'ID de instancia', cell: (i) => <a onClick={() => nav('/ec2/instance/' + i.id)}>{i.id}</a>, text: (i) => i.id }, { head: 'Ciclo de vida', cell: (i) => (i.state === 'pending' ? 'Pending' : 'InService') }, { head: 'Tipo', cell: (i) => i.type }, { head: 'Zona', cell: (i) => i.az }, { head: 'Estado de salud', cell: () => 'Correcto' },
          { head: 'Acciones', cell: (i) => <Btn small onClick={async () => { const r = await run(`aws autoscaling terminate-instance-in-auto-scaling-group --instance-id ${i.id} --no-should-decrement-desired-capacity`); if (!r.ok) setErr(r.msg); else setFlash(`Instancia ${i.id} terminada; el grupo lanzará una sustituta.`); }}>Terminar</Btn> },
        ]} />
      </Card>
      <Card title="Historial de actividad" count={g.activities.length} flush>
        <Table rows={g.activities} id={(a) => a.id} pageSize={5} empty={{ title: 'Sin actividad' }} cols={[{ head: 'Estado', cell: (a) => <Status tone={a.status === 'Successful' ? 'ok' : 'err'}>{a.status === 'Successful' ? 'Correcto' : 'Error'}</Status> }, { head: 'Descripción', cell: (a) => a.description }, { head: 'Causa', cell: (a) => a.cause }, { head: 'Inicio', cell: (a) => fmtDate(a.ts) }]} />
      </Card>
      {edit && (
        <Modal title="Editar capacidad" onClose={() => setEdit(false)} footer={<><Btn onClick={() => setEdit(false)}>Cancelar</Btn><Btn kind="primary" onClick={async () => { const r = await run(cmd); if (!r.ok) { setErr(r.msg); setEdit(false); return; } setEdit(false); setFlash('Capacidad actualizada.'); }}>Actualizar</Btn></>}>
          <div className="cw-row">{(['min', 'desired', 'max'] as const).map((k) => <Field key={k} label={k === 'min' ? 'Mínimo' : k === 'max' ? 'Máximo' : 'Deseada'}><input className="k-input" style={{ width: 90 }} aria-label={k === 'min' ? 'Mínimo' : k === 'max' ? 'Máximo' : 'Deseada'} value={cap[k]} onChange={(e) => setCap({ ...cap, [k]: e.target.value })} /></Field>)}</div>
          <CliEquivalent cmd={cmd} />
        </Modal>
      )}
      {del && <ConfirmModal title="Eliminar grupo de Auto Scaling" danger confirmLabel="Eliminar" onClose={() => setDel(false)} onConfirm={async () => { const r = await run(`aws autoscaling delete-auto-scaling-group --auto-scaling-group-name ${g.name} --force-delete`); if (!r.ok) { setErr(r.msg); setDel(false); return; } setNextFlash(`Grupo ${g.name} eliminado junto con sus instancias.`); nav('/ec2/asgs'); }}>¿Eliminar <b>{g.name}</b>? Se terminarán todas sus instancias.</ConfirmModal>}
    </>
  );
}

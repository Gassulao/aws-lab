import React, { useState } from 'react';
import { useCloud, consoleRun, consoleError } from '../../session';
import { Btn, Crumbs, Field, Flash, Modal, PageHead, nav, fmtDate } from '../../components/ui';
import { parseCidr, settle } from '../../../engine/services/ec2';
import type { SecurityGroup, SgRule } from '../../../engine/types';
import { CmdBox, InstState, Kv, Menu, RulesTable, Tabs, useSettled, typeLabel, portLabel } from './common';
import { KeyModal } from './Launch';

type Msg = { kind: 'ok' | 'err'; text: string } | null;
const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

// ----------------------------------------------------------------- Panel
export function Dashboard() {
  const s = useSettled();
  const mine = s.instances.filter((i) => i.region === s.region && i.state !== 'terminated');
  const vols = s.volumes.filter((v) => v.region === s.region);
  const eips = s.elasticIps.filter((e) => e.region === s.region);
  const res: [string, number, string?][] = [
    ['Instancias (en ejecución)', mine.filter((i) => i.state === 'running').length, '/ec2/instances'],
    ['Instancias (todas)', mine.length, '/ec2/instances'],
    ['Grupos de seguridad', s.securityGroups.filter((g) => g.region === s.region).length, '/ec2/sg'],
    ['Pares de claves', s.keyPairs.filter((k) => k.region === s.region).length, '/ec2/keys'],
    ['Volúmenes', vols.length],
    ['Direcciones IP elásticas', eips.length],
  ];
  const vpc = s.vpcs.find((v) => v.region === s.region && v.isDefault);
  return (
    <>
      <Crumbs items={[{ label: 'EC2' }, { label: 'Panel' }]} />
      <PageHead title="Panel de EC2" desc={`Región: ${s.region}`} />
      <div className="card">
        <div className="e2-head"><h2>Recursos</h2><div className="e2-btns"><Btn kind="primary" onClick={() => nav('/ec2/launch')}>Lanzar instancia</Btn><Btn onClick={() => nav('/ec2/instances')}>Ver instancias</Btn></div></div>
        <div className="e2-res">
          {res.map(([l, n, to]) => <div key={l}><span>{l}</span>{to ? <a className="n" onClick={() => nav(to)}>{n}</a> : <span className="n">{n}</span>}</div>)}
        </div>
      </div>
      <div className="card">
        <div className="e2-head"><h2>Lanzar instancia</h2></div>
        <div className="e2-cards">
          <div><h3>Lanzar una máquina virtual</h3><p style={{ color: 'var(--muted)' }}>Para comenzar, lance una instancia de EC2, que es una máquina virtual en la nube.</p><Btn kind="primary" onClick={() => nav('/ec2/launch')}>Lanzar instancia</Btn></div>
          <div><h3>Crear un par de claves</h3><p style={{ color: 'var(--muted)' }}>Necesita un par de claves para conectarse por SSH.</p><Btn onClick={() => nav('/ec2/keys')}>Pares de claves</Btn></div>
          <div><h3>Grupos de seguridad</h3><p style={{ color: 'var(--muted)' }}>Controle el tráfico de red de sus instancias.</p><Btn onClick={() => nav('/ec2/sg')}>Grupos de seguridad</Btn></div>
        </div>
      </div>
      <div className="card">
        <div className="e2-head"><h2>Atributos de la cuenta</h2></div>
        <Kv items={[['ID de cuenta', s.account.id], ['Región', s.region], ['VPC predeterminada', vpc ? <a onClick={() => nav('/vpc/vpcs')}>{vpc.id}</a> : 'No hay VPC predeterminada (se crea al primer uso)'], ['Zona de disponibilidad', 'Se asigna automáticamente']]} cols={2} />
      </div>
    </>
  );
}

// ----------------------------------------------------------------- Grupos de seguridad
export function SecurityGroups() {
  const s = useCloud();
  settle(s);
  const [sel, setSel] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [create, setCreate] = useState(false);
  const [del, setDel] = useState(false);
  const all = s.securityGroups.filter((g) => g.region === s.region);
  const rows = all.filter((g) => !filter.trim() || [g.id, g.name, g.vpcId, g.description, g.tags.Name ?? ''].some((x) => x.toLowerCase().includes(filter.toLowerCase())));
  const one = sel.length === 1 ? all.find((g) => g.id === sel[0]) : undefined;
  const doDelete = async () => {
    const out: string[] = [];
    for (const id of sel) {
      const r = await consoleRun(`aws ec2 delete-security-group --region ${s.region} --group-id ${id}`);
      if (!r.ok) { setMsg({ kind: 'err', text: `No se pudo eliminar ${id}: ${consoleError(r.err)}` }); setDel(false); setSel([]); return; }
      out.push(id);
    }
    setMsg({ kind: 'ok', text: `Se eliminó correctamente: ${out.join(', ')}` });
    setDel(false); setSel([]);
  };
  return (
    <>
      <Crumbs items={[{ label: 'EC2', to: '/ec2' }, { label: 'Grupos de seguridad' }]} />
      {msg && <Flash kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Flash>}
      <div className="card">
        <div className="e2-head">
          <h2>Grupos de seguridad<span className="count">({all.length})</span></h2>
          <div className="e2-btns">
            <Menu label="Acciones" items={[
              { label: 'Ver detalles', disabled: !one, onClick: () => one && nav('/ec2/sg/' + one.id) },
              { label: 'Editar reglas de entrada', disabled: !one, onClick: () => one && nav('/ec2/sg/' + one.id + '?edit=in') },
              { label: 'Editar reglas de salida', disabled: !one, onClick: () => one && nav('/ec2/sg/' + one.id + '?edit=out') },
              { divider: true, label: '' },
              { label: 'Eliminar grupos de seguridad', disabled: !sel.length, onClick: () => setDel(true) },
            ]} />
            <Btn kind="primary" onClick={() => setCreate(true)}>Crear grupo de seguridad</Btn>
          </div>
        </div>
        <div className="e2-tool"><input className="e2-search" type="text" placeholder="Buscar grupos de seguridad" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
        <div className="e2-wrap">
          <table>
            <thead><tr><th style={{ width: 36 }} /><th>Nombre</th><th>ID del grupo de seguridad</th><th>Nombre del grupo de seguridad</th><th>ID de VPC</th><th>Descripción</th><th>Entradas de reglas de entrada</th><th>Entradas de reglas de salida</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={8}><div className="e2-empty"><b>{all.length ? 'No se encontraron grupos' : 'No hay grupos de seguridad'}</b>{all.length ? 'Pruebe con otro filtro.' : 'Cree un grupo de seguridad para controlar el tráfico.'}{!all.length && <div><Btn kind="primary" onClick={() => setCreate(true)}>Crear grupo de seguridad</Btn></div>}</div></td></tr>}
              {rows.map((g) => (
                <tr key={g.id} className={sel.includes(g.id) ? 'sel' : ''} onClick={(e) => { if ((e.target as HTMLElement).closest('a,input')) return; setSel([g.id]); }}>
                  <td><input type="checkbox" checked={sel.includes(g.id)} onChange={() => setSel(sel.includes(g.id) ? sel.filter((x) => x !== g.id) : [...sel, g.id])} /></td>
                  <td>{g.tags.Name ?? '-'}</td>
                  <td><a onClick={() => nav('/ec2/sg/' + g.id)}>{g.id}</a></td>
                  <td>{g.name}</td>
                  <td>{g.vpcId}</td>
                  <td>{g.description}</td>
                  <td>{g.ingress.length} entradas de permiso</td>
                  <td>{g.egress.length} entradas de permiso</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {create && <CreateSgModal onClose={() => setCreate(false)} onCreated={(id) => nav('/ec2/sg/' + id)} />}
      {del && (
        <Modal title="Eliminar grupos de seguridad" onClose={() => setDel(false)} footer={<><Btn onClick={() => setDel(false)}>Cancelar</Btn><Btn kind="primary" onClick={doDelete}>Eliminar</Btn></>}>
          <p style={{ marginTop: 0 }}>¿Está seguro de que desea eliminar los siguientes grupos de seguridad?</p>
          <ul>{sel.map((id) => <li key={id}>{id} ({all.find((g) => g.id === id)?.name})</li>)}</ul>
        </Modal>
      )}
    </>
  );
}

function CreateSgModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const s = useCloud();
  const vpcs = s.vpcs.filter((v) => v.region === s.region);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [vpc, setVpc] = useState(vpcs.find((v) => v.isDefault)?.id ?? vpcs[0]?.id ?? '');
  const [err, setErr] = useState<Record<string, string>>({});
  const go = async () => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = 'El nombre del grupo de seguridad es obligatorio.';
    else if (name.startsWith('sg-')) e.name = 'Los nombres de grupo no pueden tener el formato sg-*.';
    if (!desc.trim()) e.desc = 'La descripción es obligatoria.';
    if (Object.keys(e).length) return setErr(e);
    const r = await consoleRun(`aws ec2 create-security-group --region ${s.region} --group-name ${q(name.trim())} --description ${q(desc.trim())}${vpc ? ' --vpc-id ' + vpc : ''}`);
    if (!r.ok) return setErr({ form: consoleError(r.err) });
    onCreated(r.json?.GroupId);
  };
  return (
    <Modal title="Crear grupo de seguridad" onClose={onClose} footer={<><Btn onClick={onClose}>Cancelar</Btn><Btn kind="primary" onClick={go}>Crear grupo de seguridad</Btn></>}>
      {err.form && <Flash kind="err">{err.form}</Flash>}
      <Field label="Nombre del grupo de seguridad" error={err.name}><input type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Descripción" error={err.desc}><input type="text" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
      <Field label="VPC"><select value={vpc} onChange={(e) => setVpc(e.target.value)}>{vpcs.map((v) => <option key={v.id} value={v.id}>{v.id} ({v.cidr}){v.isDefault ? ' (predeterminada)' : ''}</option>)}</select></Field>
      <div className="e2-note" style={{ padding: 0 }}>Podrá agregar reglas de entrada y salida desde la página de detalles del grupo.</div>
    </Modal>
  );
}

type SgTab = 'in' | 'out' | 'inst' | 'tags';
export function SgDetail({ id }: { id: string }) {
  const s = useSettled();
  const [tab, setTab] = useState<SgTab>(location.hash.includes('edit=out') ? 'out' : 'in');
  const [edit, setEdit] = useState<null | 'in' | 'out'>(location.hash.includes('edit=in') ? 'in' : location.hash.includes('edit=out') ? 'out' : null);
  const [msg, setMsg] = useState<Msg>(null);
  const [del, setDel] = useState(false);
  const g = s.securityGroups.find((x) => x.id === id);
  const crumbs = [{ label: 'EC2', to: '/ec2' }, { label: 'Grupos de seguridad', to: '/ec2/sg' }];
  if (!g) return <><Crumbs items={[...crumbs, { label: id }]} /><Flash kind="err" title="No se encontró el grupo de seguridad">{id}</Flash><Btn onClick={() => nav('/ec2/sg')}>Volver a grupos de seguridad</Btn></>;
  const insts = s.instances.filter((i) => i.securityGroupIds.includes(g.id) && i.state !== 'terminated');
  const doDelete = async () => {
    const r = await consoleRun(`aws ec2 delete-security-group --region ${g.region} --group-id ${g.id}`);
    setDel(false);
    if (r.ok) nav('/ec2/sg'); else setMsg({ kind: 'err', text: consoleError(r.err) });
  };
  return (
    <>
      <Crumbs items={[...crumbs, { label: g.id }]} />
      {msg && <Flash kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Flash>}
      <PageHead title={`${g.id} - ${g.name}`}>
        <Menu label="Acciones" items={[
          { label: 'Editar reglas de entrada', onClick: () => setEdit('in') },
          { label: 'Editar reglas de salida', onClick: () => setEdit('out') },
          { divider: true, label: '' },
          { label: 'Eliminar grupo de seguridad', onClick: () => setDel(true) },
        ]} />
      </PageHead>
      <div className="card">
        <div className="e2-head"><h2>Detalles</h2></div>
        <Kv items={[['Nombre del grupo de seguridad', g.name], ['ID del grupo de seguridad', g.id], ['Descripción', g.description], ['ID de VPC', g.vpcId], ['ID de propietario', s.account.id], ['Entradas de reglas', `${g.ingress.length} de entrada, ${g.egress.length} de salida`]]} />
      </div>
      <div className="card">
        <Tabs<SgTab> tabs={[['in', 'Reglas de entrada'], ['out', 'Reglas de salida'], ['inst', 'Instancias asociadas'], ['tags', 'Etiquetas']]} cur={tab} onChange={setTab} />
        {tab === 'in' && <><div className="e2-head"><h2 style={{ fontSize: 16 }}>Reglas de entrada<span className="count">({g.ingress.length})</span></h2><Btn small onClick={() => setEdit('in')}>Editar reglas de entrada</Btn></div><RulesTable rules={g.ingress} /></>}
        {tab === 'out' && <><div className="e2-head"><h2 style={{ fontSize: 16 }}>Reglas de salida<span className="count">({g.egress.length})</span></h2><Btn small onClick={() => setEdit('out')}>Editar reglas de salida</Btn></div><RulesTable rules={g.egress} egress /></>}
        {tab === 'inst' && (
          <div className="e2-wrap tall"><table><thead><tr><th>ID de instancia</th><th>Nombre</th><th>Estado</th></tr></thead><tbody>
            {insts.length === 0 && <tr><td colSpan={3} className="empty"><b>Sin instancias</b>Ninguna instancia usa este grupo de seguridad.</td></tr>}
            {insts.map((i) => <tr key={i.id}><td><a onClick={() => nav('/ec2/instance/' + i.id)}>{i.id}</a></td><td>{i.tags.Name ?? '-'}</td><td><InstState i={i} /></td></tr>)}
          </tbody></table></div>
        )}
        {tab === 'tags' && (
          <div className="e2-wrap tall"><table><thead><tr><th>Clave</th><th>Valor</th></tr></thead><tbody>
            {Object.keys(g.tags).length === 0 && <tr><td colSpan={2} className="empty"><b>No hay etiquetas</b></td></tr>}
            {Object.entries(g.tags).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}
          </tbody></table></div>
        )}
      </div>
      {edit && <EditRulesModal g={g} egress={edit === 'out'} onClose={() => { setEdit(null); if (location.hash.includes('?')) history.replaceState(null, '', '#/ec2/sg/' + g.id); }} onDone={(m) => { setMsg(m); setTab(edit); }} />}
      {del && (
        <Modal title="Eliminar grupo de seguridad" onClose={() => setDel(false)} footer={<><Btn onClick={() => setDel(false)}>Cancelar</Btn><Btn kind="primary" onClick={doDelete}>Eliminar</Btn></>}>
          ¿Está seguro de que desea eliminar el grupo {g.id} ({g.name})?
        </Modal>
      )}
    </>
  );
}

type Draft = { proto: 'tcp' | 'udp' | 'icmp' | '-1'; port: string; cidr: string; desc: string };
const permOf = (proto: string, from: number, to: number, cidr?: string, sg?: string) =>
  `IpProtocol=${proto}${proto !== '-1' ? `,FromPort=${from},ToPort=${to}` : ''},${sg ? `UserIdGroupPairs=[{GroupId=${sg}}]` : `IpRanges=[{CidrIp=${cidr}}]`}`;

function EditRulesModal({ g, egress, onClose, onDone }: { g: SecurityGroup; egress: boolean; onClose: () => void; onDone: (m: Msg) => void }) {
  const s = useCloud();
  const existing = egress ? g.egress : g.ingress;
  const [rm, setRm] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [err, setErr] = useState('');
  const [bad, setBad] = useState<Record<number, string>>({});
  const dir = egress ? 'egress' : 'ingress';
  const parsePort = (d: Draft): [number, number] | null => {
    if (d.proto === '-1') return [-1, -1];
    if (d.proto === 'icmp') return [-1, -1];
    const m = /^(\d+)(?:-(\d+))?$/.exec(d.port.trim());
    if (!m) return null;
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    return a > 65535 || b > 65535 || a > b ? null : [a, b];
  };
  const cmdsFor = () => [
    ...existing.filter((r) => rm.includes(r.id)).map((r) => `aws ec2 revoke-security-group-${dir} --region ${s.region} --group-id ${g.id} --ip-permissions ${q(permOf(r.protocol, r.from, r.to, r.cidr, r.sourceSg))}`),
    ...drafts.map((d) => { const p = parsePort(d) ?? [0, 0]; return `aws ec2 authorize-security-group-${dir} --region ${s.region} --group-id ${g.id} --ip-permissions ${q(permOf(d.proto, p[0], p[1], d.cidr.trim() || '0.0.0.0/0'))}`; }),
  ];
  const save = async () => {
    const b: Record<number, string> = {};
    drafts.forEach((d, k) => {
      if (!parsePort(d)) b[k] = 'Puerto no válido (p. ej. 443 o 8000-8100).';
      else if (!parseCidr(d.cidr.trim())) b[k] = 'CIDR no válido (p. ej. 0.0.0.0/0 o 10.0.0.0/16).';
    });
    setBad(b);
    if (Object.keys(b).length) return;
    const cmds = cmdsFor();
    if (!cmds.length) return onClose();
    for (const c of cmds) {
      const r = await consoleRun(c);
      if (!r.ok) return setErr(consoleError(r.err));
    }
    onDone({ kind: 'ok', text: `Se modificaron correctamente las reglas de ${egress ? 'salida' : 'entrada'} de ${g.id}.` });
    onClose();
  };
  const setD = (k: number, p: Partial<Draft>) => setDrafts(drafts.map((d, j) => (j === k ? { ...d, ...p } : d)));
  const live = (r: SgRule) => rm.includes(r.id);
  return (
    <Modal title={`Editar reglas de ${egress ? 'salida' : 'entrada'}`} onClose={onClose} footer={<><Btn onClick={onClose}>Cancelar</Btn><Btn kind="primary" onClick={save}>Guardar reglas</Btn></>}>
      {err && <Flash kind="err" onClose={() => setErr('')}>{err}</Flash>}
      <div className="e2-wide">
        <table>
          <thead><tr><th>Tipo</th><th>Protocolo</th><th>Puertos</th><th>{egress ? 'Destino' : 'Origen'}</th><th /></tr></thead>
          <tbody>
            {existing.map((r) => (
              <tr key={r.id} style={live(r) ? { opacity: 0.45, textDecoration: 'line-through' } : undefined}>
                <td>{typeLabel(r)}</td><td>{r.protocol === '-1' ? 'Todo' : r.protocol.toUpperCase()}</td><td>{portLabel(r)}</td><td>{r.cidr ?? r.sourceSg}</td>
                <td><Btn small onClick={() => setRm(live(r) ? rm.filter((x) => x !== r.id) : [...rm, r.id])}>{live(r) ? 'Restaurar' : 'Eliminar'}</Btn></td>
              </tr>
            ))}
            {drafts.map((d, k) => (
              <React.Fragment key={'d' + k}>
                <tr>
                  <td colSpan={2}><select value={d.proto} onChange={(e) => setD(k, { proto: e.target.value as Draft['proto'] })} style={{ width: '100%', height: 32 }}><option value="tcp">TCP</option><option value="udp">UDP</option><option value="icmp">ICMP</option><option value="-1">Todo el tráfico</option></select></td>
                  <td><input style={{ width: 110, height: 32 }} disabled={d.proto === '-1' || d.proto === 'icmp'} placeholder="443" value={d.proto === '-1' || d.proto === 'icmp' ? '' : d.port} onChange={(e) => setD(k, { port: e.target.value })} /></td>
                  <td><input style={{ width: 150, height: 32 }} placeholder="0.0.0.0/0" value={d.cidr} onChange={(e) => setD(k, { cidr: e.target.value })} /></td>
                  <td><Btn small onClick={() => setDrafts(drafts.filter((_, j) => j !== k))}>Quitar</Btn></td>
                </tr>
                {bad[k] && <tr><td colSpan={5} className="e2-err" style={{ fontSize: 12 }}>{bad[k]}</td></tr>}
              </React.Fragment>
            ))}
          </tbody>
        </table>
        <div style={{ margin: '12px 0' }}><Btn small onClick={() => setDrafts([...drafts, { proto: 'tcp', port: '', cidr: '0.0.0.0/0', desc: '' }])}>Agregar regla</Btn></div>
        {(rm.length > 0 || drafts.length > 0) && <CmdBox cmds={cmdsFor()} />}
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------- Pares de claves
export function Keys() {
  const s = useCloud();
  const [msg, setMsg] = useState<Msg>(null);
  const [create, setCreate] = useState(false);
  const [filter, setFilter] = useState('');
  const all = s.keyPairs.filter((k) => k.region === s.region);
  const rows = all.filter((k) => !filter.trim() || (k.name + k.id + k.fingerprint).toLowerCase().includes(filter.toLowerCase()));
  return (
    <>
      <Crumbs items={[{ label: 'EC2', to: '/ec2' }, { label: 'Pares de claves' }]} />
      {msg && <Flash kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Flash>}
      <div className="card">
        <div className="e2-head">
          <h2>Pares de claves<span className="count">({all.length})</span></h2>
          <div className="e2-btns"><Btn kind="primary" onClick={() => setCreate(true)}>Crear par de claves</Btn></div>
        </div>
        <div className="e2-tool"><input className="e2-search" type="text" placeholder="Buscar pares de claves" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
        <div className="e2-wrap">
          <table>
            <thead><tr><th>Nombre</th><th>Tipo</th><th>Creado</th><th>Huella digital</th><th>ID</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={5}><div className="e2-empty"><b>{all.length ? 'No se encontraron pares de claves' : 'No hay pares de claves'}</b>{all.length ? 'Pruebe con otro filtro.' : 'No tiene ningún par de claves en esta región.'}{!all.length && <div><Btn kind="primary" onClick={() => setCreate(true)}>Crear par de claves</Btn></div>}</div></td></tr>}
              {rows.map((k) => <tr key={k.id}><td>{k.name}</td><td>rsa</td><td>{fmtDate(k.createdAt)}</td><td>{k.fingerprint}</td><td>{k.id}</td></tr>)}
            </tbody>
          </table>
        </div>
      </div>
      <div className="e2-note">La eliminación de pares de claves no está disponible en el simulador (el CLI no implementa delete-key-pair).</div>
      {create && <KeyModal onClose={() => setCreate(false)} onCreated={(n) => setMsg({ kind: 'ok', text: `Se creó correctamente el par de claves ${n}.` })} />}
    </>
  );
}

import React, { useState } from 'react';
import { consoleRun, consoleError } from '../../session';
import { Btn, Crumbs, Flash, Modal, PageHead, nav, Field } from '../../components/ui';
import { INSTANCE_TYPES, AMIS } from '../../../engine/catalog';
import { reachableFromInternet } from '../../../engine/services/ec2';
import type { Instance } from '../../../engine/types';
import { useSettled, InstState, Menu, Tabs, Kv, Ic, ConfirmModal, InstanceTabs, STATE_ES, dnsOf, privDnsOf, type DetailTab, type MenuItem } from './common';

type Msg = { kind: 'ok' | 'err'; text: string } | null;
const FILTERS: [string, string][] = [['', 'Todos los estados'], ['running', 'En ejecución'], ['stopped', 'Detenida'], ['pending', 'Pendiente'], ['terminated', 'Terminada']];

const COLS: { id: string; head: string; cell: (i: Instance) => React.ReactNode; text: (i: Instance) => string; def?: boolean }[] = [
  { id: 'name', head: 'Nombre', cell: (i) => i.tags.Name ?? '-', text: (i) => i.tags.Name ?? '' },
  { id: 'id', head: 'ID de instancia', cell: (i) => <a onClick={() => nav('/ec2/instance/' + i.id)}>{i.id}</a>, text: (i) => i.id },
  { id: 'state', head: 'Estado de la instancia', cell: (i) => <InstState i={i} />, text: (i) => STATE_ES[i.state] + ' ' + i.state },
  { id: 'type', head: 'Tipo de instancia', cell: (i) => i.type, text: (i) => i.type },
  { id: 'check', head: 'Comprobación de estado', cell: (i) => (i.state === 'running' ? <span className="e2-ok"><Ic ok />2/2 comprobaciones superadas</span> : i.state === 'pending' ? <span className="e2-mut">Inicializando</span> : <span className="e2-mut">-</span>), text: (i) => (i.state === 'running' ? 'comprobaciones superadas' : '') },
  { id: 'alarm', head: 'Estado de la alarma', cell: (i) => (i.state === 'terminated' ? '-' : <span className="e2-mut">Sin alarmas</span>), text: () => '' },
  { id: 'az', head: 'Zona de disponibilidad', cell: (i) => i.az, text: (i) => i.az },
  { id: 'dns', head: 'DNS IPv4 pública', cell: (i) => dnsOf(i) || '-', text: (i) => dnsOf(i) },
  { id: 'ip', head: 'Dirección IPv4 pública', cell: (i) => i.publicIp ?? '-', text: (i) => i.publicIp ?? '' },
  { id: 'priv', head: 'Dirección IPv4 privada', cell: (i) => i.privateIp, text: (i) => i.privateIp },
  { id: 'key', head: 'Nombre de clave', cell: (i) => i.keyName ?? '-', text: (i) => i.keyName ?? '' },
  { id: 'sg', head: 'Grupos de seguridad', cell: (i) => i.securityGroupIds.join(', '), text: (i) => i.securityGroupIds.join(' ') },
  { id: 'launch', head: 'Hora de lanzamiento', cell: (i) => new Date(i.launchTime).toLocaleString('es-ES'), text: (i) => i.launchTime },
];

export function Instances() {
  const s = useSettled();
  const [sel, setSel] = useState<string[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const [q, setQ] = useState('');
  const [stateF, setStateF] = useState('');
  const [tab, setTab] = useState<DetailTab>('details');
  const [modal, setModal] = useState<null | 'stop' | 'start' | 'terminate' | 'imds'>(null);
  const all = s.instances.filter((i) => i.region === s.region);
  const rows = all.filter((i) => (!stateF || i.state === stateF) && (!q.trim() || COLS.some((c) => c.text(i).toLowerCase().includes(q.toLowerCase())) || Object.entries(i.tags).some(([k, v]) => `${k}=${v}`.toLowerCase().includes(q.toLowerCase()))));
  const selRows = sel.map((id) => all.find((i) => i.id === id)).filter(Boolean) as Instance[];
  const one = selRows.length === 1 ? selRows[0] : undefined;
  const toggle = (id: string) => setSel(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
  const allOn = rows.length > 0 && rows.every((r) => sel.includes(r.id));

  const run = async (verb: 'start' | 'stop' | 'terminate') => {
    const ids = selRows.map((i) => i.id);
    const r = await consoleRun(`aws ec2 ${verb}-instances --region ${s.region} --instance-ids ${ids.join(' ')}`);
    setModal(null);
    const word = verb === 'start' ? 'Se inició' : verb === 'stop' ? 'Se detuvo' : 'Se terminó';
    setMsg(r.ok ? { kind: 'ok', text: `${word} correctamente: ${ids.join(', ')}` } : { kind: 'err', text: consoleError(r.err) });
    setSel([]);
  };

  const stateItems: MenuItem[] = [
    { label: 'Detener instancia', disabled: !selRows.length || !selRows.every((i) => ['running', 'pending'].includes(i.state)), onClick: () => setModal('stop') },
    { label: 'Iniciar instancia', disabled: !selRows.length || !selRows.every((i) => i.state === 'stopped'), onClick: () => setModal('start') },
    { divider: true, label: '' },
    { label: 'Terminar (eliminar) instancia', disabled: !selRows.length || selRows.every((i) => i.state === 'terminated'), onClick: () => setModal('terminate') },
  ];
  const actItems: MenuItem[] = [
    { label: 'Ver detalles', disabled: !one, onClick: () => one && nav('/ec2/instance/' + one.id) },
    { label: 'Administrar etiquetas', disabled: !one, onClick: () => { setTab('tags'); } },
    { label: 'Modificar opciones de metadatos', disabled: !one || one.state === 'terminated', onClick: () => setModal('imds') },
    { divider: true, label: '' },
    { label: 'Copiar ID de instancia', disabled: !one, onClick: () => { navigator.clipboard?.writeText(one!.id).catch(() => {}); setMsg({ kind: 'ok', text: `Se copió ${one!.id} al portapapeles.` }); } },
    { label: 'Lanzar instancias', onClick: () => nav('/ec2/launch') },
  ];
  const visCols = COLS;

  return (
    <>
      <Crumbs items={[{ label: 'EC2', to: '/ec2' }, { label: 'Instancias' }]} />
      {msg && <Flash kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Flash>}
      <div className="card">
        <div className="e2-head">
          <h2>Instancias<span className="count">({all.length})</span></h2>
          <div className="e2-btns">
            <Btn title="Actualizar" onClick={() => setMsg(null)}>⟳</Btn>
            <Btn disabled={!one || one.state === 'terminated'} onClick={() => one && nav('/ec2/instance/' + one.id + '/connect')}>Conectar</Btn>
            <Menu label="Estado de la instancia" items={stateItems} disabled={!selRows.length} />
            <Menu label="Acciones" items={actItems} />
            <div className="e2-menu" style={{ display: 'inline-flex' }}>
              <Btn kind="primary" onClick={() => nav('/ec2/launch')}>Lanzar instancias</Btn>
            </div>
          </div>
        </div>
        <div className="e2-tool">
          <input className="e2-search" type="text" placeholder="Buscar instancia por atributo o etiqueta (case-sensitive)" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={stateF} onChange={(e) => setStateF(e.target.value)} aria-label="Filtro de estado">
            {FILTERS.map(([v, l]) => <option key={v} value={v}>{v ? 'Estado de la instancia: ' : ''}{l}</option>)}
          </select>
          <div className="e2-pager"><span>‹</span><b>1</b><span>›</span></div>
        </div>
        <div className="e2-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 36 }}><input type="checkbox" checked={allOn} onChange={() => setSel(allOn ? [] : rows.map((r) => r.id))} aria-label="Seleccionar todo" /></th>
                {visCols.map((c) => <th key={c.id}>{c.head}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} className={sel.includes(i.id) ? 'sel' : ''} onClick={(e) => { const t = e.target as HTMLElement; if (t.closest('a,input,button')) return; setSel([i.id]); }}>
                  <td><input type="checkbox" checked={sel.includes(i.id)} onChange={() => toggle(i.id)} aria-label={'Seleccionar ' + i.id} /></td>
                  {visCols.map((c) => <td key={c.id}>{c.cell(i)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        {rows.length === 0 && (
          <div className="e2-empty">
            <b>{all.length === 0 ? 'No hay instancias' : 'No se encontraron instancias'}</b>
            {all.length === 0 ? 'No tiene ninguna instancia en esta región.' : 'No hay instancias que coincidan con el filtro.'}
            {all.length === 0 && <div><Btn kind="primary" onClick={() => nav('/ec2/launch')}>Lanzar instancias</Btn></div>}
          </div>
        )}
        </div>
      </div>

      <div className="card">
        {one ? (
          <>
            <div className="e2-head"><h2>{one.id}{one.tags.Name ? ` (${one.tags.Name})` : ''}</h2><Btn small onClick={() => nav('/ec2/instance/' + one.id)}>Abrir página de detalles</Btn></div>
            <InstanceTabs i={one} tab={tab} setTab={setTab} onDone={setMsg} />
          </>
        ) : (
          <div className="e2-empty"><b>{selRows.length > 1 ? 'Seleccione una sola instancia' : 'Seleccione una instancia'}</b>{selRows.length > 1 ? 'Hay varias instancias seleccionadas.' : 'Seleccione una instancia arriba para ver sus detalles.'}</div>
        )}
      </div>

      {modal === 'terminate' && (
        <ConfirmModal title={`¿Terminar (eliminar) ${selRows.length === 1 ? 'la instancia' : selRows.length + ' instancias'}?`} confirm="Terminar (eliminar)" danger onCancel={() => setModal(null)} onConfirm={() => run('terminate')}
          body={<><p style={{ marginTop: 0 }}>Se van a terminar las siguientes instancias. Esta acción no se puede deshacer; los volúmenes configurados para eliminarse al terminar se borrarán.</p><ul>{selRows.map((i) => <li key={i.id}>{i.id}{i.tags.Name ? ` (${i.tags.Name})` : ''}</li>)}</ul></>} />
      )}
      {modal === 'stop' && (
        <ConfirmModal title={`¿Detener ${selRows.length === 1 ? 'la instancia' : selRows.length + ' instancias'}?`} confirm="Detener" onCancel={() => setModal(null)} onConfirm={() => run('stop')}
          body={<><p style={{ marginTop: 0 }}>Se detendrán las siguientes instancias. Perderá la IP pública que no sea una Elastic IP.</p><ul>{selRows.map((i) => <li key={i.id}>{i.id}</li>)}</ul></>} />
      )}
      {modal === 'start' && (
        <ConfirmModal title={`¿Iniciar ${selRows.length === 1 ? 'la instancia' : selRows.length + ' instancias'}?`} confirm="Iniciar" onCancel={() => setModal(null)} onConfirm={() => run('start')}
          body={<ul style={{ marginTop: 0 }}>{selRows.map((i) => <li key={i.id}>{i.id}</li>)}</ul>} />
      )}
      {modal === 'imds' && one && <ImdsModal i={one} onClose={() => setModal(null)} onDone={setMsg} />}
    </>
  );
}

export function ImdsModal({ i, onClose, onDone }: { i: Instance; onClose: () => void; onDone: (m: Msg) => void }) {
  const [v, setV] = useState<'optional' | 'required'>(i.httpTokens);
  const save = async () => {
    const r = await consoleRun(`aws ec2 modify-instance-metadata-options --region ${i.region} --instance-id ${i.id} --http-tokens ${v}`);
    onDone(r.ok ? { kind: 'ok', text: `Se modificaron las opciones de metadatos de ${i.id}.` } : { kind: 'err', text: consoleError(r.err) });
    onClose();
  };
  return (
    <Modal title="Modificar opciones de metadatos de la instancia" onClose={onClose} footer={<><Btn onClick={onClose}>Cancelar</Btn><Btn kind="primary" onClick={save}>Guardar</Btn></>}>
      <Field label="Servicio de metadatos de instancia (IMDS)" hint="Con IMDSv2 obligatorio se bloquean ataques SSRF contra los metadatos.">
        <select value={v} onChange={(e) => setV(e.target.value as 'optional' | 'required')}>
          <option value="required">Solo V2 (se requiere token)</option>
          <option value="optional">V1 y V2 (token opcional)</option>
        </select>
      </Field>
      <div className="cli"><b>$</b> aws ec2 modify-instance-metadata-options --instance-id {i.id} --http-tokens {v}</div>
    </Modal>
  );
}

export function Detail({ id }: { id: string }) {
  const s = useSettled();
  const [tab, setTab] = useState<DetailTab>('details');
  const [msg, setMsg] = useState<Msg>(null);
  const [modal, setModal] = useState<null | 'stop' | 'start' | 'terminate' | 'imds'>(null);
  const i = s.instances.find((x) => x.id === id);
  const crumbs = [{ label: 'EC2', to: '/ec2' }, { label: 'Instancias', to: '/ec2/instances' }];
  if (!i) return <><Crumbs items={[...crumbs, { label: id }]} /><Flash kind="err" title="No se encontró la instancia">{`La instancia ${id} no existe en esta cuenta.`}</Flash><Btn onClick={() => nav('/ec2/instances')}>Volver a instancias</Btn></>;
  const run = async (verb: 'start' | 'stop' | 'terminate') => {
    const r = await consoleRun(`aws ec2 ${verb}-instances --region ${i.region} --instance-ids ${i.id}`);
    setModal(null);
    setMsg(r.ok ? { kind: 'ok', text: `${verb === 'start' ? 'Se inició' : verb === 'stop' ? 'Se detuvo' : 'Se terminó'} correctamente: ${i.id}` } : { kind: 'err', text: consoleError(r.err) });
  };
  const stateItems: MenuItem[] = [
    { label: 'Detener instancia', disabled: !['running', 'pending'].includes(i.state), onClick: () => setModal('stop') },
    { label: 'Iniciar instancia', disabled: i.state !== 'stopped', onClick: () => setModal('start') },
    { divider: true, label: '' },
    { label: 'Terminar (eliminar) instancia', disabled: i.state === 'terminated', onClick: () => setModal('terminate') },
  ];
  const act: MenuItem[] = [
    { label: 'Administrar etiquetas', onClick: () => setTab('tags') },
    { label: 'Modificar opciones de metadatos', disabled: i.state === 'terminated', onClick: () => setModal('imds') },
    { label: 'Copiar ID de instancia', onClick: () => { navigator.clipboard?.writeText(i.id).catch(() => {}); setMsg({ kind: 'ok', text: `Se copió ${i.id} al portapapeles.` }); } },
  ];
  return (
    <>
      <Crumbs items={[...crumbs, { label: i.id }]} />
      {msg && <Flash kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Flash>}
      <PageHead title={`Resumen de la instancia de ${i.id}${i.tags.Name ? ` (${i.tags.Name})` : ''}`}>
        <Btn disabled={i.state === 'terminated'} onClick={() => nav('/ec2/instance/' + i.id + '/connect')}>Conectar</Btn>
        <Menu label="Estado de la instancia" items={stateItems} />
        <Menu label="Acciones" items={act} />
      </PageHead>
      <div className="card">
        <InstanceTabs i={i} tab={tab} setTab={setTab} onDone={setMsg} />
      </div>
      {modal === 'terminate' && <ConfirmModal title="¿Terminar (eliminar) la instancia?" confirm="Terminar (eliminar)" danger onCancel={() => setModal(null)} onConfirm={() => run('terminate')} body={<p style={{ marginTop: 0 }}>Se terminará {i.id}. Esta acción no se puede deshacer.</p>} />}
      {modal === 'stop' && <ConfirmModal title="¿Detener la instancia?" confirm="Detener" onCancel={() => setModal(null)} onConfirm={() => run('stop')} body={<p style={{ marginTop: 0 }}>Se detendrá {i.id}.</p>} />}
      {modal === 'start' && <ConfirmModal title="¿Iniciar la instancia?" confirm="Iniciar" onCancel={() => setModal(null)} onConfirm={() => run('start')} body={<p style={{ marginTop: 0 }}>Se iniciará {i.id}.</p>} />}
      {modal === 'imds' && <ImdsModal i={i} onClose={() => setModal(null)} onDone={setMsg} />}
    </>
  );
}

export function Connect({ id }: { id: string }) {
  const s = useSettled();
  const [tab, setTab] = useState<'ssh' | 'eic' | 'ssm'>('ssh');
  const i = s.instances.find((x) => x.id === id);
  const crumbs = [{ label: 'EC2', to: '/ec2' }, { label: 'Instancias', to: '/ec2/instances' }];
  if (!i) return <><Crumbs items={crumbs} /><Flash kind="err">No se encuentra la instancia {id}.</Flash></>;
  const ami = AMIS.find((a) => a.id === i.imageId);
  const user = ami?.user ?? 'ec2-user';
  const r22 = reachableFromInternet(s, i, 22);
  const dns = dnsOf(i) || privDnsOf(i);
  return (
    <>
      <Crumbs items={[...crumbs, { label: i.id, to: '/ec2/instance/' + i.id }, { label: 'Conectar a la instancia' }]} />
      <PageHead title="Conectar a la instancia" desc={`${i.id}${i.tags.Name ? ` (${i.tags.Name})` : ''}`} />
      <div className="card">
        <Tabs tabs={[['eic', 'EC2 Instance Connect'], ['ssm', 'Administrador de sesiones'], ['ssh', 'Cliente SSH']]} cur={tab} onChange={setTab} />
        <div className="body2" style={{ padding: 20 }}>
          {tab === 'ssh' && (
            <>
              <Kv cols={2} items={[['ID de instancia', i.id], ['Estado', <InstState i={i} />], ['Nombre de usuario', user], ['Tipo de instancia', i.type + (INSTANCE_TYPES[i.type] ? '' : '')]]} />
              <div style={{ padding: '0 20px' }}>
                <ol style={{ lineHeight: '26px' }}>
                  <li>Abra un cliente SSH.</li>
                  <li>Localice el archivo de clave privada{i.keyName ? <>: <code>{i.keyName}.pem</code></> : <> (esta instancia se lanzó sin par de claves)</>}.</li>
                  <li>Ejecute este comando para asegurarse de que la clave no sea visible públicamente: <div className="e2-pre">chmod 400 "{i.keyName ?? 'clave'}.pem"</div></li>
                  <li>Conéctese a la instancia con su DNS público: <div className="e2-pre">ssh -i "{i.keyName ?? 'clave'}.pem" {user}@{dns}</div></li>
                </ol>
                <div className="e2-diag" style={{ padding: 0 }}><div><Ic ok={r22.ok} /><span><b>Diagnóstico de conectividad SSH (TCP/22): {r22.ok ? 'alcanzable' : 'no alcanzable'}</b><small>{r22.reason}</small></span></div></div>
              </div>
            </>
          )}
          {tab === 'eic' && <div className="e2-empty"><b>EC2 Instance Connect</b>Conexión desde el navegador no disponible en el simulador. Use la pestaña "Cliente SSH" o <a onClick={() => nav('/cloudshell')}>CloudShell</a>.</div>}
          {tab === 'ssm' && <div className="e2-empty"><b>Administrador de sesiones</b>Requiere el agente SSM y un rol de IAM; no está disponible en el simulador.</div>}
        </div>
        <div className="mf" style={{ padding: '12px 20px', borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn onClick={() => nav('/ec2/instance/' + i.id)}>Cancelar</Btn>
        </div>
      </div>
    </>
  );
}

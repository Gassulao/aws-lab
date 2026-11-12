import React, { useState } from 'react';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, Modal, PageHead, Table, nav } from '../../components/ui';
import { ConfirmModal, Dl, Menu, run, takeFlash, setNextFlash } from '../iam/kit';
import { useSvc, link, enc, when, St, NotFound, sq } from '../serverless/common';
import { sv } from '../../../engine/serverless';
import { rdsStatus, snapshotStatus, allSubnetGroups, ENGINE_NAMES, ENGINE_VERSIONS } from '../../../engine/serverless/rds';
import type { RdsInstance } from '../../../engine/serverless/types';
import './rds.css';

const ROOT = { label: 'Aurora y RDS', to: '/rds/databases' };
const ENGINE_LABEL: Record<string, string> = { mysql: 'MySQL', postgres: 'PostgreSQL', mariadb: 'MariaDB' };
const CLASSES = ['db.t3.micro', 'db.t3.small', 'db.t3.medium', 'db.m5.large', 'db.r5.large'];

function RdTabs<T extends string>({ tabs, cur, onChange }: { tabs: [T, string][]; cur: T; onChange: (t: T) => void }) {
  return <div className="rd-tabs" role="tablist">{tabs.map(([k, l]) => <a key={k} role="tab" aria-selected={cur === k} className={cur === k ? 'on' : ''} onClick={() => onChange(k)}>{l}</a>)}</div>;
}

export function RdsList() {
  const s = useSvc();
  const [flash, setFlash] = useState(takeFlash);
  const [sel, setSel] = useState<string[]>([]);
  const [del, setDel] = useState(false);
  const [err, setErr] = useState('');
  const dbs = sv(s).rdsInstances.filter((i) => i.region === s.region);
  const act = async (cmd: string, ok: string) => { const r = await run(cmd); if (!r.ok) return setErr(r.msg); setErr(''); setFlash(ok); };
  const cur = dbs.find((d) => d.id === sel[0]);
  return (
    <>
      <Crumbs items={[ROOT, { label: 'Bases de datos' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title="Bases de datos" desc="Bases de datos relacionales administradas: MySQL, PostgreSQL y MariaDB con copias de seguridad, Multi-AZ y réplicas de lectura." />
      <Card title="Bases de datos" count={dbs.length} flush actions={<div className="rd-row">
        <Menu label="Acciones" items={[
          { label: 'Reiniciar', disabled: !cur, onClick: () => cur && act(`aws rds reboot-db-instance --db-instance-identifier ${cur.id}`, `Se está reiniciando ${cur.id}.`) },
          { label: 'Detener temporalmente', disabled: !cur, onClick: () => cur && act(`aws rds stop-db-instance --db-instance-identifier ${cur.id}`, `Se está deteniendo ${cur.id}.`) },
          { label: 'Iniciar', disabled: !cur, onClick: () => cur && act(`aws rds start-db-instance --db-instance-identifier ${cur.id}`, `Se está iniciando ${cur.id}.`) },
          { label: 'Eliminar', disabled: !cur, onClick: () => setDel(true) },
        ]} />
        <Btn kind="primary" onClick={() => nav('/rds/create')}>Crear base de datos</Btn></div>}>
        <Table rows={dbs} id={(d) => d.id} selected={sel} onSelect={(x) => setSel(x.slice(-1))} filterPlaceholder="Filtrar bases de datos" empty={{ title: 'No hay bases de datos', desc: 'Cree una base de datos para empezar.' }} cols={[
          { head: 'Identificador de la base de datos', cell: (d) => link('/rds/database/' + enc(d.id), d.id), text: (d) => d.id },
          { head: 'Estado', cell: (d) => <St v={rdsStatus(d)} />, text: (d) => rdsStatus(d) },
          { head: 'Rol', cell: (d) => (d.readReplicaOf ? 'Réplica' : 'Instancia'), text: (d) => (d.readReplicaOf ? 'Réplica' : 'Instancia') },
          { head: 'Motor', cell: (d) => `${ENGINE_LABEL[d.engine] ?? d.engine} ${d.engineVersion}`, text: (d) => d.engine },
          { head: 'Clase', cell: (d) => d.cls, text: (d) => d.cls },
          { head: 'Zona de disponibilidad', cell: (d) => d.az + (d.multiAz ? ' (Multi-AZ)' : ''), text: (d) => d.az },
        ]} />
      </Card>
      {del && cur && <ConfirmModal title="Eliminar la instancia de base de datos" confirmLabel="Eliminar" danger requireText="eliminar" onClose={() => setDel(false)} onConfirm={async () => { const r = await run(`aws rds delete-db-instance --db-instance-identifier ${cur.id} --skip-final-snapshot`); if (!r.ok) return r.msg; setFlash(`Se está eliminando ${cur.id}.`); setSel([]); }}>
        Se eliminará la instancia <b>{cur.id}</b> sin instantánea final. Esta acción no se puede deshacer.
      </ConfirmModal>}
    </>
  );
}

export function RdsCreate() {
  const s = useSvc();
  const [engine, setEngine] = useState('mysql');
  const [id, setId] = useState('');
  const [user, setUser] = useState('admin');
  const [pass, setPass] = useState('');
  const [cls, setCls] = useState('db.t3.micro');
  const [storage, setStorage] = useState(20);
  const [multi, setMulti] = useState(false);
  const [pub, setPub] = useState(false);
  const [group, setGroup] = useState('default');
  const [sgs, setSgs] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const groups = allSubnetGroups({ s, caller: undefined as any, region: s.region } as any);
  const g = groups.find((x) => x.name === group);
  const sgList = s.securityGroups.filter((x) => x.region === s.region && (!g || x.vpcId === g.vpcId));
  const cmd = `aws rds create-db-instance --db-instance-identifier ${id || '<identificador>'} --db-instance-class ${cls} --engine ${engine} --master-username ${user} --master-user-password ${pass ? '********' : '<contraseña>'} --allocated-storage ${storage}${multi ? ' --multi-az' : ' --no-multi-az'}${pub ? ' --publicly-accessible' : ' --no-publicly-accessible'} --db-subnet-group-name ${group}${sgs ? ` --vpc-security-group-ids ${sgs}` : ''}`;
  const create = async () => {
    setBusy(true); setErr('');
    const real = cmd.replace('********', sq(pass));
    const r = await run(real);
    setBusy(false);
    if (!r.ok) return setErr(r.msg);
    setNextFlash(`Se está creando la base de datos ${id}. Puede tardar unos minutos en estar disponible.`);
    nav('/rds/database/' + enc(id));
  };
  return (
    <>
      <Crumbs items={[ROOT, { label: 'Bases de datos', to: '/rds/databases' }, { label: 'Crear base de datos' }]} />
      <PageHead title="Crear base de datos" desc="Elija un motor y configure la instancia. Todos los parámetros equivalen a aws rds create-db-instance." />
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <div className="rd-form">
        <Card title="Opciones del motor">
          <Field label="Tipo de motor"><div className="rd-row">{ENGINE_NAMES.map((e) => <label key={e}><input type="radio" name="engine" checked={engine === e} onChange={() => setEngine(e)} /> {ENGINE_LABEL[e] ?? e}</label>)}</div></Field>
          <div className="rd-muted">Versiones disponibles: {ENGINE_VERSIONS(engine).join(', ')}</div>
        </Card>
        <Card title="Configuración">
          <div className="rd-grid2">
            <Field label="Identificador de instancia de base de datos" hint="Minúsculas, números y guiones; empieza por una letra."><input className="k-input" type="text" aria-label="Identificador de la base de datos" value={id} onChange={(e) => setId(e.target.value)} /></Field>
            <Field label="Clase de instancia"><select className="k-input" aria-label="Clase de instancia" value={cls} onChange={(e) => setCls(e.target.value)}>{CLASSES.map((c) => <option key={c}>{c}</option>)}</select></Field>
            <Field label="Nombre de usuario maestro" hint={engine === 'postgres' ? 'En PostgreSQL «admin» es una palabra reservada.' : undefined}><input className="k-input" type="text" aria-label="Nombre de usuario maestro" value={user} onChange={(e) => setUser(e.target.value)} /></Field>
            <Field label="Contraseña maestra" hint={'Al menos 8 caracteres; no puede contener /, \' , " ni @.'}><input className="k-input" type="password" aria-label="Contraseña maestra" value={pass} onChange={(e) => setPass(e.target.value)} /></Field>
            <Field label="Almacenamiento asignado (GiB)"><input className="k-input" type="number" aria-label="Almacenamiento" value={storage} onChange={(e) => setStorage(Number(e.target.value))} /></Field>
          </div>
          <Field label="Disponibilidad y durabilidad"><label><input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> Implementación Multi-AZ (crea una réplica en espera en otra zona de disponibilidad)</label></Field>
        </Card>
        <Card title="Conectividad">
          <div className="rd-grid2">
            <Field label="Grupo de subredes de base de datos"><select className="k-input" aria-label="Grupo de subredes" value={group} onChange={(e) => { setGroup(e.target.value); setSgs(''); }}>{groups.map((x) => <option key={x.name}>{x.name}</option>)}</select></Field>
            <Field label="Grupo de seguridad de VPC"><select className="k-input" aria-label="Grupo de seguridad" value={sgs} onChange={(e) => setSgs(e.target.value)}><option value="">Predeterminado de la VPC</option>{sgList.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.id})</option>)}</select></Field>
          </div>
          <Field label="Acceso público"><label><input type="checkbox" checked={pub} onChange={(e) => setPub(e.target.checked)} /> Sí: asignar una dirección IP pública (todavía necesita un grupo de seguridad que permita el acceso)</label></Field>
        </Card>
        <CliEquivalent cmd={cmd} />
        <div className="rd-row" style={{ justifyContent: 'flex-end', marginTop: 12 }}><Btn onClick={() => nav('/rds/databases')}>Cancelar</Btn><Btn kind="primary" disabled={!id || !pass || busy} onClick={create}>Crear base de datos</Btn></div>
      </div>
    </>
  );
}

type Tab = 'conn' | 'config' | 'snaps' | 'events';

export function RdsDetail({ id }: { id: string }) {
  const s = useSvc();
  const [tab, setTab] = useState<Tab>('conn');
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [modal, setModal] = useState<null | 'modify' | 'snapshot' | 'delete'>(null);
  const [snapName, setSnapName] = useState('');
  const [mCls, setMCls] = useState('');
  const [mMulti, setMMulti] = useState<boolean | null>(null);
  const [mStorage, setMStorage] = useState('');
  const [mNow, setMNow] = useState(false);
  const [finalSnap, setFinalSnap] = useState('');
  const d = sv(s).rdsInstances.find((x) => x.id === id && x.region === s.region);
  if (!d) return <><Crumbs items={[ROOT]} /><NotFound what={`La instancia de base de datos ${id} no existe en la región ${s.region}.`} /></>;
  const status = rdsStatus(d);
  const act = async (cmd: string, ok: string) => { const r = await run(cmd); if (!r.ok) { setErr(r.msg); return false; } setErr(''); setFlash(ok); return true; };
  const snaps = sv(s).rdsSnapshots.filter((x) => x.instanceId === d.id && x.region === s.region);
  const events = sv(s).rdsEvents.filter((e) => e.sourceId === d.id && e.region === s.region).slice(-30).reverse();
  const replicas = sv(s).rdsInstances.filter((x) => x.readReplicaOf === d.id);
  const modParts = [mCls && mCls !== d.cls ? `--db-instance-class ${mCls}` : '', mMulti !== null && mMulti !== d.multiAz ? (mMulti ? '--multi-az' : '--no-multi-az') : '', mStorage && Number(mStorage) !== d.allocatedStorage ? `--allocated-storage ${mStorage}` : '', mNow ? '--apply-immediately' : ''].filter(Boolean);
  const modCmd = `aws rds modify-db-instance --db-instance-identifier ${d.id} ${modParts.join(' ')}`;
  const snapCmd = `aws rds create-db-snapshot --db-instance-identifier ${d.id} --db-snapshot-identifier ${snapName || '<nombre>'}`;
  const delCmd = finalSnap ? `aws rds delete-db-instance --db-instance-identifier ${d.id} --final-db-snapshot-identifier ${finalSnap}` : `aws rds delete-db-instance --db-instance-identifier ${d.id} --skip-final-snapshot`;
  const pv = d.pendingValues ?? {};
  const cantAct = status !== 'available';
  return (
    <>
      <Crumbs items={[ROOT, { label: 'Bases de datos', to: '/rds/databases' }, { label: d.id }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title={d.id}>
        <Btn onClick={() => { setMCls(d.cls); setMMulti(d.multiAz); setMStorage(String(d.allocatedStorage)); setMNow(false); setErr(''); setModal('modify'); }}>Modificar</Btn>
        <Menu label="Acciones" items={[
          { label: 'Reiniciar', onClick: () => act(`aws rds reboot-db-instance --db-instance-identifier ${d.id}`, 'Reiniciando la instancia.') },
          { label: 'Reiniciar con conmutación por error', disabled: !d.multiAz, onClick: () => act(`aws rds reboot-db-instance --db-instance-identifier ${d.id} --force-failover`, 'Conmutación por error iniciada: la instancia en espera pasará a ser la principal.') },
          { label: status === 'stopped' ? 'Iniciar' : 'Detener temporalmente', onClick: () => act(status === 'stopped' ? `aws rds start-db-instance --db-instance-identifier ${d.id}` : `aws rds stop-db-instance --db-instance-identifier ${d.id}`, status === 'stopped' ? 'Iniciando la instancia.' : 'Deteniendo la instancia.') },
          { label: 'Tomar instantánea', onClick: () => { setSnapName(`${d.id}-snap`); setErr(''); setModal('snapshot'); } },
          { label: 'Crear réplica de lectura', disabled: !!d.readReplicaOf, onClick: () => act(`aws rds create-db-instance-read-replica --db-instance-identifier ${d.id}-replica --source-db-instance-identifier ${d.id}`, 'Creando la réplica de lectura.') },
          { label: 'Eliminar', onClick: () => { setFinalSnap(''); setErr(''); setModal('delete'); } },
        ]} />
      </PageHead>
      <Card title="Resumen">
        <Dl items={[['Identificador', d.id], ['Estado', <St key="s" v={status} />], ['Motor', `${ENGINE_LABEL[d.engine] ?? d.engine} ${d.engineVersion}`], ['Clase', d.cls], ['Rol', d.readReplicaOf ? `Réplica de ${d.readReplicaOf}` : 'Instancia'], ['Multi-AZ', d.multiAz ? 'Sí' : 'No']]} />
        {Object.keys(pv).length > 0 && <div className="rd-pending">Modificaciones pendientes (se aplicarán en la próxima ventana de mantenimiento o al reiniciar): {Object.entries(pv).map(([k, v]) => `${k}=${String(v)}`).join(', ')}</div>}
      </Card>
      <RdTabs cur={tab} onChange={setTab} tabs={[['conn', 'Conectividad y seguridad'], ['config', 'Configuración'], ['snaps', 'Mantenimiento y copias'], ['events', 'Eventos']]} />
      {tab === 'conn' && (
        <>
          <Card title="Conectividad">
            <Dl items={[['Punto de enlace', status === 'creating' ? 'Disponible cuando la instancia esté lista' : <span className="rd-url" key="e">{d.endpoint}</span>], ['Puerto', d.port], ['Acceso público', d.publiclyAccessible ? 'Sí' : 'No'], ['VPC', d.vpcId], ['Grupo de subredes', d.subnetGroup], ['Grupos de seguridad', d.sgIds.join(', ')]]} />
          </Card>
          <Card title="Disponibilidad">
            <div className="rd-az" aria-label="Zonas de disponibilidad">
              <div className="primary"><b>Principal</b>{d.az}<div className="rd-muted">Atiende las lecturas y escrituras</div></div>
              {d.multiAz && d.secondaryAz && <div><b>En espera (síncrona)</b>{d.secondaryAz}<div className="rd-muted">Toma el relevo en una conmutación por error</div></div>}
            </div>
            {!d.multiAz && <span className="rd-muted">Esta instancia está en una sola zona de disponibilidad: si falla, hay interrupción. Active Multi-AZ para alta disponibilidad.</span>}
            {replicas.length > 0 && <div style={{ marginTop: 8 }}>Réplicas de lectura: {replicas.map((r) => <span key={r.id} style={{ marginRight: 8 }}>{link('/rds/database/' + enc(r.id), r.id)}</span>)}</div>}
          </Card>
        </>
      )}
      {tab === 'config' && <Card title="Configuración"><Dl items={[['ARN', <span className="rd-url" key="a">{d.arn}</span>], ['Usuario maestro', d.masterUser], ['Nombre de la base de datos', d.dbName ?? '-'], ['Almacenamiento', `${d.allocatedStorage} GiB (${d.storageType})`], ['Cifrado', d.encrypted ? 'Habilitado' : 'No habilitado'], ['Retención de copias', d.backupRetention + ' días'], ['Protección contra eliminación', d.deletionProtection ? 'Habilitada' : 'Deshabilitada'], ['Grupo de parámetros', d.parameterGroup]]} /></Card>}
      {tab === 'snaps' && (
        <Card title="Instantáneas" count={snaps.length} flush actions={<Btn disabled={cantAct && status !== 'stopped'} onClick={() => { setSnapName(`${d.id}-snap`); setErr(''); setModal('snapshot'); }}>Tomar instantánea</Btn>}>
          <Table rows={snaps} id={(x) => x.id} empty={{ title: 'No hay instantáneas', desc: 'Las instantáneas manuales se conservan hasta que las elimine.' }} cols={[
            { head: 'Nombre', cell: (x) => x.id }, { head: 'Estado', cell: (x) => <St v={snapshotStatus(x)} /> }, { head: 'Tipo', cell: (x) => x.type }, { head: 'Creada', cell: (x) => when(x.createdAt) },
            { head: 'Acciones', cell: (x) => <div className="rd-row"><Btn small disabled={snapshotStatus(x) !== 'available'} onClick={() => act(`aws rds restore-db-instance-from-db-snapshot --db-instance-identifier ${d.id}-restaurada --db-snapshot-identifier ${x.id}`, 'Restaurando una nueva instancia desde la instantánea.')}>Restaurar</Btn><Btn small onClick={() => act(`aws rds delete-db-snapshot --db-snapshot-identifier ${x.id}`, 'Instantánea eliminada.')}>Eliminar</Btn></div> },
          ]} />
        </Card>
      )}
      {tab === 'events' && <Card title="Eventos recientes">{events.length ? <ul className="rd-ev">{events.map((e, i) => <li key={i}><span className="rd-muted">{when(e.ts)}</span><span>{e.message}</span></li>)}</ul> : <span className="rd-muted">No hay eventos recientes.</span>}</Card>}
      {modal === 'modify' && (
        <Modal title="Modificar instancia de base de datos" onClose={() => setModal(null)} footer={<><Btn onClick={() => setModal(null)}>Cancelar</Btn><Btn kind="primary" disabled={!modParts.filter((x) => x !== '--apply-immediately').length} onClick={async () => { if (await act(modCmd, mNow ? 'Aplicando la modificación ahora.' : 'Modificación programada: se aplicará en la próxima ventana de mantenimiento.')) setModal(null); }}>Continuar</Btn></>}>
          {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
          <div className="rd-form">
            <Field label="Clase de instancia"><select className="k-input" aria-label="Nueva clase" value={mCls} onChange={(e) => setMCls(e.target.value)}>{CLASSES.map((c) => <option key={c}>{c}</option>)}</select></Field>
            <Field label="Almacenamiento (GiB)" hint="Solo se puede aumentar."><input className="k-input" type="number" aria-label="Nuevo almacenamiento" value={mStorage} onChange={(e) => setMStorage(e.target.value)} /></Field>
            <Field label="Multi-AZ"><label><input type="checkbox" checked={!!mMulti} onChange={(e) => setMMulti(e.target.checked)} /> Implementación Multi-AZ</label></Field>
            <Field label="Cuándo aplicar"><label><input type="checkbox" checked={mNow} onChange={(e) => setMNow(e.target.checked)} /> Aplicar inmediatamente (provoca una breve interrupción)</label></Field>
            <CliEquivalent cmd={modCmd} />
          </div>
        </Modal>
      )}
      {modal === 'snapshot' && (
        <Modal title="Tomar instantánea de base de datos" onClose={() => setModal(null)} footer={<><Btn onClick={() => setModal(null)}>Cancelar</Btn><Btn kind="primary" disabled={!snapName} onClick={async () => { if (await act(snapCmd, `Se está creando la instantánea ${snapName}.`)) setModal(null); }}>Tomar instantánea</Btn></>}>
          {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
          <div className="rd-form"><Field label="Nombre de la instantánea"><input className="k-input" type="text" aria-label="Nombre de la instantánea" value={snapName} onChange={(e) => setSnapName(e.target.value)} /></Field><CliEquivalent cmd={snapCmd} /></div>
        </Modal>
      )}
      {modal === 'delete' && (
        <ConfirmModal title={`Eliminar ${d.id}`} confirmLabel="Eliminar" danger requireText="eliminar" onClose={() => setModal(null)} onConfirm={async () => { const r = await run(delCmd); if (!r.ok) return r.msg; setNextFlash(`Se está eliminando la instancia ${d.id}.`); nav('/rds/databases'); }}>
          <div className="rd-form">
            <Field label="Instantánea final" hint="Déjelo vacío para omitir la instantánea final."><input className="k-input" type="text" aria-label="Instantánea final" value={finalSnap} onChange={(e) => setFinalSnap(e.target.value)} placeholder="nombre-de-la-instantánea-final" /></Field>
            <CliEquivalent cmd={delCmd} />
          </div>
        </ConfirmModal>
      )}
    </>
  );
}

export function RdsSnapshots() {
  const s = useSvc();
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const snaps = sv(s).rdsSnapshots.filter((x) => x.region === s.region);
  const act = async (cmd: string, ok: string) => { const r = await run(cmd); if (!r.ok) return setErr(r.msg); setErr(''); setFlash(ok); };
  return (
    <>
      <Crumbs items={[ROOT, { label: 'Instantáneas' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title="Instantáneas" desc="Copias de seguridad completas del volumen de almacenamiento de una instancia." />
      <Card title="Instantáneas manuales" count={snaps.length} flush>
        <Table rows={snaps} id={(x) => x.id} filterPlaceholder="Buscar instantáneas" empty={{ title: 'No hay instantáneas', desc: 'Tome una instantánea desde la página de una base de datos.' }} cols={[
          { head: 'Nombre', cell: (x) => x.id, text: (x) => x.id }, { head: 'Instancia de origen', cell: (x) => link('/rds/database/' + enc(x.instanceId), x.instanceId), text: (x) => x.instanceId },
          { head: 'Estado', cell: (x) => <St v={snapshotStatus(x)} /> }, { head: 'Motor', cell: (x) => `${x.engine} ${x.engineVersion}` }, { head: 'Creada', cell: (x) => when(x.createdAt) },
          { head: 'Acciones', cell: (x) => <div className="rd-row"><Btn small disabled={snapshotStatus(x) !== 'available'} onClick={() => act(`aws rds restore-db-instance-from-db-snapshot --db-instance-identifier ${x.instanceId}-restaurada --db-snapshot-identifier ${x.id}`, 'Restaurando una nueva instancia desde la instantánea.')}>Restaurar</Btn><Btn small onClick={() => act(`aws rds delete-db-snapshot --db-snapshot-identifier ${x.id}`, 'Instantánea eliminada.')}>Eliminar</Btn></div> },
        ]} />
      </Card>
    </>
  );
}

export function RdsSubnetGroups() {
  const s = useSvc();
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [modal, setModal] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [subs, setSubs] = useState<string[]>([]);
  const groups = allSubnetGroups({ s, caller: undefined as any, region: s.region } as any);
  const vpcSubs = s.subnets.filter((x) => x.region === s.region);
  const cmd = `aws rds create-db-subnet-group --db-subnet-group-name ${name || '<nombre>'} --db-subnet-group-description ${sq(desc || name || 'descripción')} --subnet-ids ${subs.join(' ') || '<subred-1> <subred-2>'}`;
  const create = async () => { const r = await run(cmd); if (!r.ok) return setErr(r.msg); setErr(''); setModal(false); setFlash(`Se creó el grupo de subredes ${name}.`); };
  return (
    <>
      <Crumbs items={[ROOT, { label: 'Grupos de subredes' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && !modal && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title="Grupos de subredes" desc="Un grupo de subredes indica en qué subredes (al menos dos zonas de disponibilidad) puede colocar RDS sus instancias." />
      <Card title="Grupos de subredes" count={groups.length} flush actions={<Btn kind="primary" onClick={() => { setErr(''); setSubs([]); setModal(true); }}>Crear grupo de subredes</Btn>}>
        <Table rows={groups} id={(g) => g.name} empty={{ title: 'No hay grupos de subredes' }} cols={[
          { head: 'Nombre', cell: (g) => g.name, text: (g) => g.name }, { head: 'Descripción', cell: (g) => g.description }, { head: 'VPC', cell: (g) => g.vpcId },
          { head: 'Subredes', cell: (g) => g.subnetIds.length }, { head: 'Zonas de disponibilidad', cell: (g) => [...new Set(g.subnetIds.map((i) => s.subnets.find((x) => x.id === i)?.az))].join(', ') },
          { head: 'Acciones', cell: (g) => (g.name === 'default' ? '-' : <Btn small onClick={async () => { const r = await run(`aws rds delete-db-subnet-group --db-subnet-group-name ${g.name}`); if (!r.ok) return setErr(r.msg); setErr(''); setFlash('Grupo de subredes eliminado.'); }}>Eliminar</Btn>) },
        ]} />
      </Card>
      {modal && (
        <Modal title="Crear grupo de subredes de base de datos" onClose={() => setModal(false)} footer={<><Btn onClick={() => setModal(false)}>Cancelar</Btn><Btn kind="primary" disabled={!name || subs.length === 0} onClick={create}>Crear</Btn></>}>
          {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
          <div className="rd-form">
            <Field label="Nombre"><input className="k-input" type="text" aria-label="Nombre del grupo" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Descripción"><input className="k-input" type="text" aria-label="Descripción" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
            <Field label="Subredes" hint="Elija subredes de al menos dos zonas de disponibilidad de la misma VPC.">
              {vpcSubs.map((x) => <label key={x.id} style={{ display: 'block' }}><input type="checkbox" checked={subs.includes(x.id)} onChange={(e) => setSubs(e.target.checked ? [...subs, x.id] : subs.filter((y) => y !== x.id))} /> {x.id} · {x.az} · {x.cidr} · {x.vpcId}</label>)}
            </Field>
            <CliEquivalent cmd={cmd} />
          </div>
        </Modal>
      )}
    </>
  );
}

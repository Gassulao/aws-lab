import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, Modal, PageHead, Table, nav, fmtDate } from '../../components/ui';
import { ConfirmModal, Dl, JsonEditor, Steps, Tabs, Tile, TagEditor, tagsArg, pretty, run, tmpFile, lastSeg, policyKind, checkPolicy, setNextFlash, takeFlash, ago, PolicyBlock, type TagRow } from './kit';
import { PolicyPicker } from './Pickers';
import type { IamRole, PolicyDocument } from '../../../engine/types';

const hrs = (s: number) => (s === 3600 ? '1 hora' : `${s / 3600} horas`);
const asArr = <T,>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function trustedOf(r: IamRole, acct: string): string {
  const out: string[] = [];
  for (const st of asArr<any>(r.assumeRolePolicy.Statement)) {
    const pr = st.Principal;
    if (!pr) continue;
    if (pr === '*') { out.push('Todos (*)'); continue; }
    for (const [k, v] of Object.entries<any>(pr)) for (const x of asArr<string>(v)) {
      if (k === 'Service') out.push(`Servicio de AWS: ${x.replace('.amazonaws.com', '')}`);
      else if (k === 'AWS') out.push(x.includes(acct) ? 'Cuenta de AWS: ' + (x.endsWith(':root') ? 'esta cuenta' : lastSeg(x)) : `Cuenta de AWS: ${x}`);
      else out.push(`${k}: ${x}`);
    }
  }
  return out.join(', ') || '-';
}

export function Roles() {
  const s = useCloud();
  const [sel, setSel] = useState<string[]>([]);
  const [del, setDel] = useState(false);
  const [flash, setFlash] = useState(takeFlash);
  return (
    <>
      <Crumbs items={[{ label: 'IAM', to: '/iam' }, { label: 'Roles' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <PageHead title="Roles" desc="Un rol de IAM es una identidad que puede crear con permisos específicos y credenciales que son válidas durante períodos cortos. Los roles pueden ser asumidos por entidades en las que usted confía." />
      <Card title="Roles" count={s.roles.length} flush actions={<><Btn small disabled={sel.length !== 1} onClick={() => setDel(true)}>Eliminar</Btn><Btn kind="primary" onClick={() => nav('/iam/roles/create')}>Crear rol</Btn></>}>
        <Table rows={s.roles} id={(r) => r.name} selected={sel} onSelect={setSel} filterPlaceholder="Buscar" empty={{ title: 'No hay recursos para mostrar', desc: 'No hay roles en esta cuenta.' }} cols={[
          { head: 'Nombre del rol', cell: (r) => <a onClick={() => nav('/iam/roles/' + encodeURIComponent(r.name))}>{r.name}</a>, text: (r) => r.name },
          { head: 'Entidades de confianza', cell: (r) => trustedOf(r, s.account.id), text: (r) => trustedOf(r, s.account.id) },
          { head: 'Duración máx. de sesión', cell: (r) => hrs(r.maxSessionDuration) },
          { head: 'Última actividad', cell: (r) => ago(s.trail.filter((e) => e.principalArn.includes(`/${r.name}/`)).map((e) => e.time).sort().pop()) },
          { head: 'Creado', cell: (r) => fmtDate(r.createdAt), text: (r) => r.createdAt },
        ]} />
      </Card>
      {del && <DeleteRole role={s.roles.find((r) => r.name === sel[0])!} onClose={() => setDel(false)} onDone={() => { setFlash(`Se eliminó el rol ${sel[0]}.`); setSel([]); }} />}
    </>
  );
}

function DeleteRole({ role, onClose, onDone }: { role: IamRole; onClose: () => void; onDone: () => void }) {
  return (
    <ConfirmModal title={`¿Eliminar ${role.name}?`} confirmLabel="Eliminar" danger requireText={role.name} onClose={onClose}
      onConfirm={async () => {
        for (const a of role.attached) { const r = await run(`aws iam detach-role-policy --role-name ${role.name} --policy-arn ${a}`); if (!r.ok) return r.msg; }
        const r = await run(`aws iam delete-role --role-name ${role.name}`);
        if (!r.ok) return r.msg;
        onDone();
      }}>
      <p>Se desvincularán las políticas adjuntas ({role.attached.length}) y se eliminará el rol de forma permanente. Las entidades que lo asuman perderán el acceso.</p>
    </ConfirmModal>
  );
}

type Kind = 'service' | 'account' | 'custom';
const SERVICES = [
  ['ec2.amazonaws.com', 'EC2', 'Permite a las instancias EC2 llamar a servicios de AWS en su nombre.'],
  ['lambda.amazonaws.com', 'Lambda', 'Permite a las funciones Lambda llamar a servicios de AWS en su nombre.'],
  ['ecs-tasks.amazonaws.com', 'Elastic Container Service Task', 'Permite a las tareas de ECS llamar a servicios de AWS.'],
  ['s3.amazonaws.com', 'S3', 'Permite a S3 llamar a servicios de AWS en su nombre.'],
  ['cloudtrail.amazonaws.com', 'CloudTrail', 'Permite a CloudTrail llamar a servicios de AWS.'],
  ['ssm.amazonaws.com', 'Systems Manager', 'Permite a SSM llamar a servicios de AWS.'],
];

export function CreateRole() {
  const s = useCloud();
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<Kind>('service');
  const [svc, setSvc] = useState(SERVICES[0][0]);
  const [acctMode, setAcctMode] = useState<'this' | 'other'>('this');
  const [acct, setAcct] = useState('');
  const [mfa, setMfa] = useState(false);
  const [ext, setExt] = useState('');
  const [custom, setCustom] = useState(pretty({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] }));
  const [pols, setPols] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [tags, setTags] = useState<TagRow[]>([]);
  const [trustText, setTrustText] = useState('');
  const [err, setErr] = useState('');
  const buildTrust = (): string => {
    if (kind === 'custom') return custom;
    const stmt: any = { Effect: 'Allow', Action: 'sts:AssumeRole' };
    if (kind === 'service') stmt.Principal = { Service: svc };
    else {
      stmt.Principal = { AWS: `arn:aws:iam::${acctMode === 'this' ? s.account.id : acct}:root` };
      const cond: any = {};
      if (ext) cond.StringEquals = { 'sts:ExternalId': ext };
      if (mfa) cond.Bool = { 'aws:MultiFactorAuthPresent': 'true' };
      if (Object.keys(cond).length) stmt.Condition = cond;
    }
    return pretty({ Version: '2012-10-17', Statement: [stmt] });
  };
  const next = () => {
    if (step === 0) {
      if (kind === 'account' && acctMode === 'other' && !/^\d{12}$/.test(acct)) return setErr('Escriba un ID de cuenta de AWS de 12 dígitos.');
      const t = buildTrust();
      const e = checkPolicy(t, 'trust');
      if (e) return setErr(e);
      setTrustText(t);
    }
    setErr(''); setStep(step + 1);
  };
  const tagA = tagsArg(tags);
  const exists = s.roles.some((r) => r.name === name);
  const create = async () => {
    const trust = step === 2 ? trustText : buildTrust();
    const cmd = `aws iam create-role --role-name ${name} --assume-role-policy-document ${tmpFile(trust)}${desc ? ` --description '${desc.replace(/'/g, '')}'` : ''}${tagA.length ? ' --tags ' + tagA.join(' ') : ''}`;
    const r = await run(cmd);
    if (!r.ok) return setErr(r.msg);
    for (const a of pols) { const x = await run(`aws iam attach-role-policy --role-name ${name} --policy-arn ${a}`); if (!x.ok) return setErr(`Se creó el rol, pero falló al adjuntar ${lastSeg(a)}: ${x.msg}`); }
    setNextFlash(`Se creó el rol ${name}.`);
    nav('/iam/roles/' + encodeURIComponent(name));
  };
  return (
    <>
      <Crumbs items={[{ label: 'IAM', to: '/iam' }, { label: 'Roles', to: '/iam/roles' }, { label: 'Crear rol' }]} />
      <PageHead title="Crear rol" />
      <div className="k-wiz">
        <Steps steps={['Seleccionar entidad de confianza', 'Agregar permisos', 'Nombrar, revisar y crear']} current={step} />
        <div>
          {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
          {step === 0 && (
            <>
              <Card title="Tipo de entidad de confianza">
                <div className="k-tiles">
                  <Tile on={kind === 'service'} onClick={() => setKind('service')} title="Servicio de AWS" desc="Permita que servicios de AWS como EC2, Lambda u otros realicen acciones en esta cuenta." />
                  <Tile on={kind === 'account'} onClick={() => setKind('account')} title="Cuenta de AWS" desc="Permita que entidades de otras cuentas de AWS que le pertenezcan a usted o a un tercero realicen acciones en esta cuenta." />
                  <Tile on={kind === 'custom'} onClick={() => setKind('custom')} title="Política de confianza personalizada" desc="Cree una política de confianza personalizada para permitir que otros realicen acciones en esta cuenta." />
                </div>
              </Card>
              {kind === 'service' && (
                <Card title="Caso de uso">
                  <Field label="Servicio o caso de uso" hint="Elija un servicio para ver sus casos de uso.">
                    <select className="k-select" value={svc} onChange={(e) => setSvc(e.target.value)} style={{ minWidth: 320 }}>{SERVICES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                  </Field>
                  <div className="k-muted">{SERVICES.find((x) => x[0] === svc)?.[2]}</div>
                </Card>
              )}
              {kind === 'account' && (
                <Card title="Una cuenta de AWS">
                  <Tile on={acctMode === 'this'} onClick={() => setAcctMode('this')} title="Esta cuenta" desc={s.account.id} />
                  <Tile on={acctMode === 'other'} onClick={() => setAcctMode('other')} title="Otra cuenta de AWS" desc="ID de cuenta de 12 dígitos" />
                  {acctMode === 'other' && <Field label="ID de cuenta"><input className="k-input" type="text" value={acct} onChange={(e) => setAcct(e.target.value)} placeholder="123456789012" /></Field>}
                  <Field label="Opciones"><label><input type="checkbox" checked={mfa} onChange={(e) => setMfa(e.target.checked)} /> Requerir MFA</label></Field>
                  <Field label="ID externo - opcional"><input className="k-input" type="text" value={ext} onChange={(e) => setExt(e.target.value)} /></Field>
                </Card>
              )}
              {kind === 'custom' && <Card title="Política de confianza personalizada"><JsonEditor kind="trust" value={custom} onChange={setCustom} /></Card>}
            </>
          )}
          {step === 1 && <Card title="Políticas de permisos" count={pols.length} flush><PolicyPicker selected={pols} onChange={setPols} /></Card>}
          {step === 2 && (
            <>
              <Card title="Detalles del rol">
                <Field label="Nombre del rol" hint="Máximo 64 caracteres. Use caracteres alfanuméricos y + = , . @ _ -" error={exists ? 'Ya existe un rol con ese nombre.' : name && !/^[\w+=,.@-]{1,64}$/.test(name) ? 'Nombre no válido.' : ''}><input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
                <Field label="Descripción"><input type="text" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Permite a los servicios llamar a servicios de AWS en su nombre." /></Field>
              </Card>
              <Card title="Paso 1: seleccionar entidades de confianza"><JsonEditor kind="trust" value={trustText} onChange={setTrustText} rows={10} /></Card>
              <Card title="Paso 2: agregar permisos">{pols.length ? pols.map(lastSeg).join(', ') : <span className="k-muted">Sin políticas adjuntas</span>}</Card>
              <Card title="Etiquetas - opcional"><TagEditor tags={tags} onChange={setTags} /></Card>
              <CliEquivalent cmd={`aws iam create-role --role-name ${name || '<nombre>'} --assume-role-policy-document file://trust.json`} />
            </>
          )}
          <div className="k-foot">
            <Btn onClick={() => (step === 0 ? nav('/iam/roles') : setStep(step - 1))}>{step === 0 ? 'Cancelar' : 'Anterior'}</Btn>
            {step < 2 ? <Btn kind="primary" onClick={next}>Siguiente</Btn> : <Btn kind="primary" disabled={!name || exists || !!checkPolicy(trustText, 'trust')} onClick={create}>Crear rol</Btn>}
          </div>
        </div>
      </div>
    </>
  );
}

type Tab = 'perm' | 'trust' | 'tags';
export function RoleDetail({ name }: { name: string }) {
  const s = useCloud();
  const r = s.roles.find((x) => x.name === name);
  const [tab, setTab] = useState<Tab>('perm');
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [modal, setModal] = useState<null | 'add' | 'del' | { detach: string } | { inline: string }>(null);
  const [pick, setPick] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [trust, setTrust] = useState('');
  if (!r) return <><Crumbs items={[{ label: 'IAM', to: '/iam' }, { label: 'Roles', to: '/iam/roles' }]} /><Flash kind="err" title="NoSuchEntity">The role with name {name} cannot be found.</Flash></>;
  const close = () => { setModal(null); setPick([]); };
  const exec = async (cmds: string[], ok: string) => {
    for (const c of cmds) { const x = await run(c); if (!x.ok) { setErr(x.msg); close(); return x.msg; } }
    setErr(''); setFlash(ok); close();
  };
  const m = modal as any;
  const saveTrust = async () => {
    const e = checkPolicy(trust, 'trust');
    if (e) return setErr(e);
    const x = await run(`aws iam update-assume-role-policy --role-name ${r.name} --policy-document ${tmpFile(trust)}`);
    if (!x.ok) return setErr(x.msg);
    setErr(''); setEditing(false); setFlash('Se actualizó la política de confianza.');
  };
  return (
    <>
      <Crumbs items={[{ label: 'IAM', to: '/iam' }, { label: 'Roles', to: '/iam/roles' }, { label: r.name }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title={r.name}><Btn onClick={() => setModal('del')}>Eliminar</Btn></PageHead>
      <Card title="Resumen">
        <Dl items={[['Fecha de creación', fmtDate(r.createdAt)], ['ARN', r.arn], ['Duración máxima de la sesión', hrs(r.maxSessionDuration)], ['Descripción', r.description || '-'], ['Entidades de confianza', trustedOf(r, s.account.id)], ['Última actividad', ago(s.trail.filter((e) => e.principalArn.includes(`/${r.name}/`)).map((e) => e.time).sort().pop())]]} />
      </Card>
      <div className="card" style={{ marginBottom: 20 }}>
        <Tabs<Tab> active={tab} onChange={setTab} tabs={[{ id: 'perm', label: 'Permisos' }, { id: 'trust', label: 'Relaciones de confianza' }, { id: 'tags', label: 'Etiquetas' }]} />
        {tab === 'perm' && (
          <div>
            <div style={{ padding: '14px 20px', display: 'flex', justifyContent: 'space-between' }}>
              <h2 style={{ fontSize: 18 }}>Políticas de permisos <span className="k-muted" style={{ fontWeight: 400 }}>({r.attached.length + Object.keys(r.inline).length})</span></h2>
              <Btn small kind="primary" onClick={() => setModal('add')}>Agregar permisos</Btn>
            </div>
            <Table rows={[...r.attached.map((a) => ({ n: lastSeg(a), t: policyKind(a), arn: a })), ...Object.keys(r.inline).map((n) => ({ n, t: 'En línea', arn: '' }))]} id={(x) => x.n} filterPlaceholder="Buscar" empty={{ title: 'Sin permisos', desc: 'Este rol no tiene políticas.' }} cols={[
              { head: 'Nombre de la política', cell: (x) => (x.arn ? <a onClick={() => nav('/iam/policies/' + encodeURIComponent(x.arn))}>{x.n}</a> : <a onClick={() => setModal({ inline: x.n })}>{x.n}</a>), text: (x) => x.n },
              { head: 'Tipo', cell: (x) => x.t },
              { head: '', cell: (x) => (x.arn ? <Btn kind="link" onClick={() => setModal({ detach: x.arn })}>Quitar</Btn> : null) },
            ]} />
          </div>
        )}
        {tab === 'trust' && (
          <div className="body2" style={{ padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
              <h2 style={{ fontSize: 18 }}>Entidades de confianza</h2>
              {!editing ? <Btn small onClick={() => { setTrust(pretty(r.assumeRolePolicy)); setEditing(true); }}>Editar política de confianza</Btn> : <div className="actions"><Btn small onClick={() => { setEditing(false); setErr(''); }}>Cancelar</Btn><Btn small kind="primary" disabled={!!checkPolicy(trust, 'trust')} onClick={saveTrust}>Actualizar política</Btn></div>}
            </div>
            <p className="k-muted">Entidades que pueden asumir este rol bajo las condiciones definidas.</p>
            {editing ? <JsonEditor kind="trust" value={trust} onChange={setTrust} /> : <PolicyBlock doc={r.assumeRolePolicy as PolicyDocument} />}
          </div>
        )}
        {tab === 'tags' && <Table rows={Object.entries(r.tags)} id={([k]) => k} filterPlaceholder="Buscar etiquetas" empty={{ title: 'Sin etiquetas', desc: 'Las etiquetas se asignan al crear el rol.' }} cols={[{ head: 'Clave', cell: ([k]) => k }, { head: 'Valor', cell: ([, v]) => v || '-' }]} />}
      </div>
      {modal === 'add' && (
        <Modal title="Agregar permisos" onClose={close} footer={<><Btn onClick={close}>Cancelar</Btn><Btn kind="primary" disabled={!pick.length} onClick={() => exec(pick.map((a) => `aws iam attach-role-policy --role-name ${r.name} --policy-arn ${a}`), `Se adjuntaron ${pick.length} política(s).`)}>Agregar permisos</Btn></>}>
          <PolicyPicker selected={pick} onChange={setPick} exclude={r.attached} />
        </Modal>
      )}
      {m?.detach && <ConfirmModal title="Quitar política" confirmLabel="Quitar" danger onConfirm={async () => exec([`aws iam detach-role-policy --role-name ${r.name} --policy-arn ${m.detach}`], `Se quitó ${lastSeg(m.detach)}.`)} onClose={close}><p>¿Quitar <b>{lastSeg(m.detach)}</b> del rol <b>{r.name}</b>?</p></ConfirmModal>}
      {m?.inline && <Modal title={m.inline} onClose={close}><PolicyBlock doc={r.inline[m.inline]} /></Modal>}
      {modal === 'del' && <DeleteRole role={r} onClose={close} onDone={() => nav('/iam/roles')} />}
    </>
  );
}

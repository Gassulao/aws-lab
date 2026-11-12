import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, Modal, PageHead, Table, nav, fmtDate } from '../../components/ui';
import { ConfirmModal, Dl, JsonEditor, PolicyBlock, pretty, run, tmpFile, q } from '../iam/kit';
import { gov, type OrgAccount, type OrgPolicy, type OrgUnit, type Organization } from '../../../engine/services/govTypes';
import { FULL_ACCESS_ID, settleOrg } from '../../../engine/services/organizations';
import { Empty, Kpi } from './common';

const root = { label: 'AWS Organizations', to: '/organizations/accounts' };
type Sel = { kind: 'root' | 'ou' | 'acct'; id: string };

const polsOf = (o: Organization, id: string) => o.policies.filter((p) => p.targets.includes(id));
const parentOf = (o: Organization, id: string): string | undefined => o.accounts.find((a) => a.id === id)?.parentId ?? o.ous.find((u) => u.id === id)?.parentId;
function ancestors(o: Organization, id: string): string[] {
  const out: string[] = [];
  let p = parentOf(o, id);
  for (let i = 0; p && i < 10; i++) { out.unshift(p); p = p === o.rootId ? undefined : parentOf(o, p); }
  return out;
}
const nameOf = (o: Organization, id: string) => (id === o.rootId ? 'Raíz' : o.ous.find((u) => u.id === id)?.name ?? o.accounts.find((a) => a.id === id)?.name ?? id);

function CreateOrg({ onDone }: { onDone: (m: string) => void }) {
  const [err, setErr] = useState('');
  const cmd = 'aws organizations create-organization --feature-set ALL';
  return (
    <>
      <Crumbs items={[root, { label: 'Cuentas de AWS' }]} />
      <PageHead title="AWS Organizations" desc="Administre de forma centralizada varias cuentas de AWS, agrúpelas en unidades organizativas y aplique políticas de control de servicios (SCP)." />
      {err && <Flash kind="err" onClose={() => setErr('')}>{err}</Flash>}
      <Card>
        <Empty title="Cree una organización" action={<><Btn kind="primary" onClick={async () => { const r = await run(cmd); if (!r.ok) return setErr(r.msg); onDone('Se creó la organización. Su cuenta es ahora la cuenta de administración.'); }}>Crear una organización</Btn><div style={{ marginTop: 16 }}><CliEquivalent cmd={cmd} /></div></>}>
          Su cuenta se convertirá en la cuenta de administración. Después podrá crear cuentas miembro, agruparlas en unidades organizativas (OU) y limitar lo que pueden hacer con las SCP.
        </Empty>
      </Card>
    </>
  );
}

function Tree({ o, sel, onSel }: { o: Organization; sel: Sel; onSel: (s: Sel) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (id: string) => open[id] ?? true;
  const flip = (id: string) => setOpen({ ...open, [id]: !isOpen(id) });
  const acctRow = (a: OrgAccount) => (
    <li key={a.id}>
      <div className={'gv-node ' + (sel.id === a.id ? 'on' : '')} onClick={() => onSel({ kind: 'acct', id: a.id })} role="treeitem" aria-selected={sel.id === a.id}>
        <span className="tw" /><span className="ico acct">A</span>
        <span>{a.name}</span>{a.management && <span className="gv-badge">Administración</span>}{a.status !== 'ACTIVE' && <span className="gv-badge warn">Suspendida</span>}
        <small>{a.id}</small>
      </div>
    </li>
  );
  const ouRow = (u: OrgUnit): React.ReactNode => {
    const kids = o.ous.filter((x) => x.parentId === u.id);
    const accts = o.accounts.filter((a) => a.parentId === u.id);
    return (
      <li key={u.id}>
        <div className={'gv-node ' + (sel.id === u.id ? 'on' : '')} onClick={() => onSel({ kind: 'ou', id: u.id })} role="treeitem" aria-selected={sel.id === u.id} aria-expanded={isOpen(u.id)}>
          <span className="tw" onClick={(e) => { e.stopPropagation(); flip(u.id); }}>{kids.length + accts.length ? (isOpen(u.id) ? '▾' : '▸') : ''}</span><span className="ico ou">OU</span>
          <span>{u.name}</span><small>{u.id}</small>
        </div>
        {isOpen(u.id) && (kids.length + accts.length > 0) && <ul role="group">{kids.map(ouRow)}{accts.map(acctRow)}</ul>}
      </li>
    );
  };
  return (
    <ul className="gv-tree" role="tree" aria-label="Estructura de la organización">
      <li>
        <div className={'gv-node ' + (sel.id === o.rootId ? 'on' : '')} onClick={() => onSel({ kind: 'root', id: o.rootId })} role="treeitem" aria-selected={sel.id === o.rootId}>
          <span className="tw" onClick={(e) => { e.stopPropagation(); flip(o.rootId); }}>{isOpen(o.rootId) ? '▾' : '▸'}</span><span className="ico root">R</span><span>Raíz</span><small>{o.rootId}</small>
        </div>
        {isOpen(o.rootId) && <ul role="group">{o.ous.filter((u) => u.parentId === o.rootId).map(ouRow)}{o.accounts.filter((a) => a.parentId === o.rootId).map(acctRow)}</ul>}
      </li>
    </ul>
  );
}

function FormModal({ title, onClose, onSubmit, children, label }: { title: string; onClose: () => void; onSubmit: () => Promise<string | void>; children: React.ReactNode; label: string }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} footer={<><Btn onClick={onClose}>Cancelar</Btn><Btn kind="primary" disabled={busy} onClick={async () => { setBusy(true); const e = await onSubmit(); setBusy(false); if (e) setErr(e); else onClose(); }}>{label}</Btn></>}>
      {err && <Flash kind="err">{err}</Flash>}
      {children}
    </Modal>
  );
}

export function Accounts() {
  const s = useCloud();
  const g = gov(s);
  const [flash, setFlash] = useState('');
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<Sel | null>(null);
  const [modal, setModal] = useState<null | 'ou' | 'acct' | 'move' | 'delou'>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [dest, setDest] = useState('');
  const [pick, setPick] = useState('');
  settleOrg(s);
  const o = g.org;
  if (!o) return <CreateOrg onDone={setFlash} />;
  const cur: Sel = sel ?? { kind: 'root', id: o.rootId };
  const target = cur.kind === 'ou' ? o.ous.find((u) => u.id === cur.id) : cur.kind === 'acct' ? o.accounts.find((a) => a.id === cur.id) : undefined;
  if (cur.kind !== 'root' && !target) setTimeout(() => setSel(null));
  const act = async (cmd: string, ok: string) => { const r = await run(cmd); if (!r.ok) { setErr(r.msg); return r.msg; } setErr(''); setFlash(ok); };
  const attached = polsOf(o, cur.id);
  const inherited = ancestors(o, cur.id).flatMap((a) => polsOf(o, a).map((p) => ({ p, from: a })));
  const free = o.policies.filter((p) => !attached.includes(p));
  const parents = [{ id: o.rootId, name: 'Raíz' }, ...o.ous.map((u) => ({ id: u.id, name: u.name }))];
  const accountDetail = cur.kind === 'acct' ? (target as OrgAccount) : undefined;
  return (
    <>
      <Crumbs items={[root, { label: 'Cuentas de AWS' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="No se pudo completar la acción" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title="Cuentas de AWS" desc="Estructura jerárquica de su organización: la raíz, las unidades organizativas (OU) y las cuentas.">
        <Btn onClick={() => { setName(''); setModal('ou'); }}>Crear unidad organizativa</Btn>
        <Btn kind="primary" onClick={() => { setName(''); setEmail(''); setModal('acct'); }}>Crear cuenta de AWS</Btn>
      </PageHead>
      <div className="gv-kpis">
        <Kpi label="ID de la organización" value={<span style={{ fontSize: 18 }}>{o.id}</span>} sub={`Conjunto de características: ${o.featureSet}`} />
        <Kpi label="Cuentas" value={o.accounts.length} sub={`${o.accounts.filter((a) => a.status === 'ACTIVE').length} activas`} />
        <Kpi label="Unidades organizativas" value={o.ous.length} />
        <Kpi label="Políticas de control de servicios" tone={o.scpEnabled ? 'ok' : 'warn'} value={<span style={{ fontSize: 18 }}>{o.scpEnabled ? 'Habilitadas' : 'Deshabilitadas'}</span>}
          sub={o.scpEnabled ? `${o.policies.length} ${o.policies.length === 1 ? 'política' : 'políticas'}` : <a onClick={() => act(`aws organizations enable-policy-type --root-id ${o.rootId} --policy-type SERVICE_CONTROL_POLICY`, 'Se habilitaron las políticas de control de servicios y se adjuntó FullAWSAccess a todos los destinos.')}>Habilitar SCP</a>} />
      </div>
      <div className="gv-split">
        <Card title="Estructura de la organización"><Tree o={o} sel={cur} onSel={setSel} /></Card>
        <div>
          <Card title={cur.kind === 'root' ? 'Raíz' : target ? (target as OrgUnit).name : ''} actions={cur.kind === 'ou' ? <Btn small kind="danger" onClick={() => setModal('delou')}>Eliminar</Btn> : cur.kind === 'acct' && !accountDetail?.management ? <Btn small onClick={() => { setDest(''); setModal('move'); }}>Mover</Btn> : undefined}>
            <Dl cols={2} items={[
              ['Tipo', cur.kind === 'root' ? 'Raíz' : cur.kind === 'ou' ? 'Unidad organizativa' : 'Cuenta de AWS'],
              ['ID', cur.id],
              ...(accountDetail ? ([['Correo electrónico', accountDetail.email], ['Estado', accountDetail.status === 'ACTIVE' ? 'Activa' : 'Suspendida'], ['Método de unión', accountDetail.joinedMethod === 'CREATED' ? 'Creada' : 'Invitada'], ['Se unió', fmtDate(accountDetail.joinedAt)], ['OU principal', nameOf(o, accountDetail.parentId)]] as [string, React.ReactNode][]) : []),
            ]} />
            {accountDetail && !accountDetail.management && (
              <div style={{ marginTop: 12 }}>
                <p className="k-muted" style={{ margin: '0 0 6px' }}>Para actuar en esta cuenta asuma su rol de acceso (las SCP de su OU se aplicarán a la sesión):</p>
                <CliEquivalent cmd={`aws sts assume-role --role-arn arn:aws:iam::${accountDetail.id}:role/OrganizationAccountAccessRole --role-session-name prueba`} />
              </div>
            )}
            {accountDetail?.management && <p className="k-muted" style={{ marginTop: 12 }}>Las SCP nunca afectan a la cuenta de administración, ni siquiera si están adjuntas a la raíz.</p>}
          </Card>
          <Card title="Políticas de control de servicios adjuntas" count={attached.length} flush actions={o.scpEnabled && free.length > 0 ? <><select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Política a adjuntar"><option value="">Seleccione una SCP…</option>{free.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select> <Btn small kind="primary" disabled={!pick} onClick={async () => { await act(`aws organizations attach-policy --policy-id ${pick} --target-id ${cur.id}`, 'Se adjuntó la política.'); setPick(''); }}>Adjuntar</Btn></> : undefined}>
            <Table rows={attached} id={(p) => p.id} empty={{ title: o.scpEnabled ? 'Sin SCP adjuntas' : 'SCP deshabilitadas', desc: o.scpEnabled ? 'Este destino solo hereda las políticas de sus niveles superiores.' : 'Habilite las SCP en la raíz para poder adjuntarlas.' }} cols={[
              { head: 'Nombre', cell: (p) => <a onClick={() => nav('/organizations/policy/' + p.id)}>{p.name}</a>, text: (p) => p.name },
              { head: 'Tipo', cell: (p) => (p.awsManaged ? 'Administrada por AWS' : 'Administrada por el cliente') },
              { head: 'Acciones', cell: (p) => <Btn small onClick={() => act(`aws organizations detach-policy --policy-id ${p.id} --target-id ${cur.id}`, 'Se desasoció la política.')}>Desasociar</Btn> },
            ]} />
          </Card>
          {o.scpEnabled && cur.kind !== 'root' && (
            <Card title="Políticas heredadas" count={inherited.length} flush>
              <Table rows={inherited} id={(x) => x.p.id + x.from} empty={{ title: 'Sin políticas heredadas' }} cols={[
                { head: 'Nombre', cell: (x) => <a onClick={() => nav('/organizations/policy/' + x.p.id)}>{x.p.name}</a>, text: (x) => x.p.name },
                { head: 'Heredada de', cell: (x) => nameOf(o, x.from), text: (x) => nameOf(o, x.from) },
              ]} />
            </Card>
          )}
        </div>
      </div>
      {modal === 'ou' && (
        <FormModal title="Crear unidad organizativa" label="Crear unidad organizativa" onClose={() => setModal(null)} onSubmit={() => act(`aws organizations create-organizational-unit --parent-id ${cur.kind === 'acct' ? o.rootId : cur.id} --name ${q(name)}`, `Se creó la unidad organizativa ${name}.`)}>
          <Field label="Nombre de la unidad organizativa" hint={`Se creará dentro de: ${nameOf(o, cur.kind === 'acct' ? o.rootId : cur.id)}`}><input type="text" value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Sandbox" /></Field>
          <CliEquivalent cmd={`aws organizations create-organizational-unit --parent-id ${cur.kind === 'acct' ? o.rootId : cur.id} --name ${q(name || 'Nombre')}`} />
        </FormModal>
      )}
      {modal === 'acct' && (
        <FormModal title="Crear cuenta de AWS" label="Crear cuenta de AWS" onClose={() => setModal(null)} onSubmit={async () => { const e = await act(`aws organizations create-account --account-name ${q(name)} --email ${q(email)}`, `Se solicitó la cuenta ${name}.`); if (e) return e; }}>
          <Field label="Nombre de la cuenta"><input type="text" value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="dev" /></Field>
          <Field label="Correo electrónico del usuario raíz" hint="Debe ser único en AWS."><input type="text" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="dev@example.com" /></Field>
          <p className="k-muted">La cuenta se crea en la raíz con el rol OrganizationAccountAccessRole. Después puede moverla a una OU.</p>
          <CliEquivalent cmd={`aws organizations create-account --account-name ${q(name || 'nombre')} --email ${q(email || 'correo')}`} />
        </FormModal>
      )}
      {modal === 'move' && accountDetail && (
        <FormModal title={`Mover ${accountDetail.name}`} label="Mover cuenta" onClose={() => setModal(null)} onSubmit={() => act(`aws organizations move-account --account-id ${accountDetail.id} --source-parent-id ${accountDetail.parentId} --destination-parent-id ${dest}`, `Se movió la cuenta a ${nameOf(o, dest)}.`)}>
          <Field label="Destino"><select value={dest} onChange={(e) => setDest(e.target.value)}><option value="">Seleccione un destino…</option>{parents.filter((x) => x.id !== accountDetail.parentId).map((x) => <option key={x.id} value={x.id}>{x.name} ({x.id})</option>)}</select></Field>
          <CliEquivalent cmd={`aws organizations move-account --account-id ${accountDetail.id} --source-parent-id ${accountDetail.parentId} --destination-parent-id ${dest || '<destino>'}`} />
        </FormModal>
      )}
      {modal === 'delou' && target && (
        <ConfirmModal title="Eliminar unidad organizativa" confirmLabel="Eliminar" danger onClose={() => setModal(null)} onConfirm={async () => { const e = await act(`aws organizations delete-organizational-unit --organizational-unit-id ${cur.id}`, 'Se eliminó la unidad organizativa.'); if (!e) setSel(null); return e; }}>
          ¿Eliminar la unidad organizativa <b>{(target as OrgUnit).name}</b>? Debe estar vacía (sin cuentas ni OU hijas).
        </ConfirmModal>
      )}
    </>
  );
}

const TEMPLATES: { label: string; doc: object }[] = [
  { label: 'Impedir borrar buckets de S3', doc: { Version: '2012-10-17', Statement: [{ Sid: 'NoBorrarBuckets', Effect: 'Deny', Action: ['s3:DeleteBucket'], Resource: '*' }] } },
  { label: 'Solo la región eu-west-1', doc: { Version: '2012-10-17', Statement: [{ Sid: 'SoloIrlanda', Effect: 'Deny', Action: ['ec2:*', 'rds:*', 'lambda:*'], Resource: '*', Condition: { StringNotEquals: { 'aws:RequestedRegion': ['eu-west-1'] } } }] } },
  { label: 'Proteger CloudTrail', doc: { Version: '2012-10-17', Statement: [{ Sid: 'ProtegerTrail', Effect: 'Deny', Action: ['cloudtrail:StopLogging', 'cloudtrail:DeleteTrail'], Resource: '*' }] } },
  { label: 'Lista de permitidos (solo S3)', doc: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:*', 'sts:*'], Resource: '*' }] } },
];

export function ScpList() {
  const s = useCloud();
  const o = gov(s).org;
  const [modal, setModal] = useState(false);
  const [pname, setPname] = useState('');
  const [desc, setDesc] = useState('');
  const [body, setBody] = useState(pretty(TEMPLATES[0].doc));
  const [flash, setFlash] = useState('');
  const [err, setErr] = useState('');
  if (!o) return <CreateOrg onDone={setFlash} />;
  const create = async () => {
    const r = await run(`aws organizations create-policy --name ${q(pname)} --description ${q(desc || pname)} --type SERVICE_CONTROL_POLICY --content ${tmpFile(body)}`);
    if (!r.ok) return r.msg;
    setFlash(`Se creó la política ${pname}.`);
  };
  return (
    <>
      <Crumbs items={[root, { label: 'Políticas de control de servicios' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title="Políticas de control de servicios" desc="Las SCP fijan los permisos máximos de las cuentas miembro. No conceden acceso: una SCP que deniega prevalece aunque IAM permita.">
        <Btn kind="primary" disabled={!o.scpEnabled} onClick={() => { setPname(''); setDesc(''); setBody(pretty(TEMPLATES[0].doc)); setModal(true); }}>Crear política</Btn>
      </PageHead>
      {!o.scpEnabled && <Flash kind="info">Las políticas de control de servicios no están habilitadas. Habilítelas desde <a onClick={() => nav('/organizations/accounts')}>Cuentas de AWS</a>.</Flash>}
      <Card title="Políticas disponibles" count={o.policies.length} flush>
        <Table rows={o.policies} id={(p) => p.id} filterPlaceholder="Buscar políticas" empty={{ title: 'Sin políticas' }} cols={[
          { head: 'Nombre', cell: (p) => <a onClick={() => nav('/organizations/policy/' + p.id)}>{p.name}</a>, text: (p) => p.name },
          { head: 'ID', cell: (p) => p.id, text: (p) => p.id },
          { head: 'Tipo', cell: (p) => (p.awsManaged ? 'Administrada por AWS' : 'Administrada por el cliente') },
          { head: 'Destinos', cell: (p) => p.targets.length, text: (p) => String(p.targets.length) },
          { head: 'Descripción', cell: (p) => p.description },
        ]} />
      </Card>
      {modal && (
        <Modal title="Crear política de control de servicios" onClose={() => setModal(false)} footer={<><Btn onClick={() => setModal(false)}>Cancelar</Btn><Btn kind="primary" disabled={!pname.trim()} onClick={async () => { const e = await create(); if (e) setErr(e); setModal(false); }}>Crear política</Btn></>}>
          <Field label="Nombre de la política"><input type="text" value={pname} autoFocus onChange={(e) => setPname(e.target.value)} placeholder="NoBorrarBuckets" /></Field>
          <Field label="Descripción"><input type="text" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
          <Field label="Plantillas"><div className="gv-chips">{TEMPLATES.map((t) => <Btn key={t.label} small onClick={() => setBody(pretty(t.doc))}>{t.label}</Btn>)}</div></Field>
          <Field label="Documento de política"><JsonEditor kind="identity" value={body} onChange={setBody} rows={12} /></Field>
        </Modal>
      )}
    </>
  );
}

export function ScpDetail({ id }: { id: string }) {
  const s = useCloud();
  const o = gov(s).org;
  const [flash, setFlash] = useState('');
  const [err, setErr] = useState('');
  const [del, setDel] = useState(false);
  if (!o) return <CreateOrg onDone={setFlash} />;
  const p: OrgPolicy | undefined = o.policies.find((x) => x.id === id);
  if (!p) return <><Crumbs items={[root, { label: 'Políticas de control de servicios', to: '/organizations/policies' }]} /><Flash kind="err" title="PolicyNotFoundException">No existe la política {id}.</Flash></>;
  const act = async (cmd: string, ok: string) => { const r = await run(cmd); if (!r.ok) { setErr(r.msg); return r.msg; } setErr(''); setFlash(ok); };
  return (
    <>
      <Crumbs items={[root, { label: 'Políticas de control de servicios', to: '/organizations/policies' }, { label: p.name }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title={p.name} desc={p.description}>{!p.awsManaged && <Btn kind="danger" onClick={() => setDel(true)}>Eliminar</Btn>}</PageHead>
      <Card title="Detalles"><Dl cols={3} items={[['ID', p.id], ['Tipo', 'Política de control de servicios'], ['Administrada por', p.awsManaged ? 'AWS' : 'El cliente']]} /></Card>
      <Card title="Contenido"><PolicyBlock doc={JSON.parse(p.content)} /></Card>
      <Card title="Destinos" count={p.targets.length} flush>
        <Table rows={p.targets} id={(t) => t} empty={{ title: 'No está adjunta a ningún destino', desc: 'Adjúntela a la raíz, a una OU o a una cuenta desde Cuentas de AWS.' }} cols={[
          { head: 'Nombre', cell: (t) => nameOf(o, t), text: (t) => nameOf(o, t) },
          { head: 'ID', cell: (t) => t },
          { head: 'Tipo', cell: (t) => (t === o.rootId ? 'Raíz' : o.ous.some((u) => u.id === t) ? 'Unidad organizativa' : 'Cuenta') },
          { head: 'Acciones', cell: (t) => <Btn small onClick={() => act(`aws organizations detach-policy --policy-id ${p.id} --target-id ${t}`, 'Se desasoció la política.')}>Desasociar</Btn> },
        ]} />
      </Card>
      {del && (
        <ConfirmModal title="Eliminar política" confirmLabel="Eliminar" danger onClose={() => setDel(false)} onConfirm={async () => { const r = await run(`aws organizations delete-policy --policy-id ${p.id}`); if (!r.ok) return r.msg; nav('/organizations/policies'); }}>
          ¿Eliminar la política <b>{p.name}</b>? Debe estar desasociada de todos los destinos.
        </ConfirmModal>
      )}
    </>
  );
}

export function OrganizationsPages({ path }: { path: string }) {
  const clean = path.split('?')[0];
  if (clean.startsWith('/organizations/policy/')) return <ScpDetail key={clean} id={decodeURIComponent(clean.split('/')[3] ?? '')} />;
  if (clean.startsWith('/organizations/policies')) return <ScpList />;
  return <Accounts />;
}

export { FULL_ACCESS_ID };

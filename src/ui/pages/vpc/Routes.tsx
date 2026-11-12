import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, Crumbs, Field, Flash, PageHead, Status, Table } from '../../components/ui';
import { parseCidr } from '../../../engine/services/ec2';
import type { RouteTable } from '../../../engine/types';
import { nav, ActionsMenu, ConfirmModal, FilterBanner, FlashBar, KV, Link, Tabs, cmdOf, inRegion, modalRun, nameError, nm, rg, sel1, tagSpec, useVpcFilter } from './common';
import { TagModal } from './Vpcs';

export function RouteTableTable({ rt, onDelete }: { rt: RouteTable; onDelete?: (dest: string) => void }) {
  const s = useCloud();
  const kind = (t: string) => (t === 'local' ? 'local' : t.startsWith('igw-') ? 'Gateway de internet' : t.startsWith('nat-') ? 'Gateway NAT' : 'Otro');
  const nameOfTarget = (t: string) => nm((s.internetGateways.find((g) => g.id === t) ?? s.natGateways.find((g) => g.id === t))?.tags);
  return (
    <Table
      rows={rt.routes}
      id={(r) => r.destination}
      empty={{ title: 'Sin rutas' }}
      cols={[
        { head: 'Destino', cell: (r) => r.destination },
        { head: 'Destino de la ruta', cell: (r) => <>{r.target}{nameOfTarget(r.target) !== '-' && <span style={{ color: 'var(--muted)' }}> ({nameOfTarget(r.target)})</span>}</>, text: (r) => r.target },
        { head: 'Tipo de destino', cell: (r) => kind(r.target) },
        { head: 'Estado', cell: (r) => { const g = r.target.startsWith('igw-') ? s.internetGateways.find((x) => x.id === r.target) : undefined; return g && !g.attachedVpcId ? <Status tone="err">Agujero negro</Status> : <Status tone="ok">Activa</Status>; } },
        { head: 'Propagada', cell: () => 'No' },
        ...(onDelete ? [{ head: 'Acciones', cell: (r: { destination: string; target: string }) => (r.target === 'local' ? <span style={{ color: 'var(--muted)' }}>—</span> : <Btn small kind="danger" onClick={() => onDelete(r.destination)}>Eliminar</Btn>) }] : []),
      ]}
    />
  );
}

export function RouteList({ path }: { path: string }) {
  const s = useCloud();
  const [vpc, clear] = useVpcFilter(path);
  const rows = inRegion(s.routeTables, s.region).filter((x) => !vpc || x.vpcId === vpc);
  const [sel, setSel] = useState<string[]>([]);
  const [create, setCreate] = useState(false);
  const cur = rows.find((x) => x.id === sel[0]);
  return (
    <>
      <Crumbs items={[{ label: 'VPC', to: '/vpc' }, { label: 'Tablas de enrutamiento' }]} />
      <FlashBar />
      <Card
        title="Tablas de enrutamiento"
        count={rows.length}
        flush
        actions={
          <>
            <Btn disabled={!cur} onClick={() => cur && nav('/vpc/routes/' + cur.id)}>Ver detalles</Btn>
            <ActionsMenu items={[{ label: 'Ver detalles', disabled: !cur, onClick: () => cur && nav('/vpc/routes/' + cur.id) }, { label: 'Editar rutas', disabled: !cur, onClick: () => cur && nav('/vpc/routes/' + cur.id + '?tab=routes') }]} />
            <Btn kind="primary" onClick={() => setCreate(true)}>Crear tabla de enrutamiento</Btn>
          </>
        }
      >
        <FilterBanner vpc={vpc} clear={clear} />
        <Table
          rows={rows}
          id={(x) => x.id}
          selected={sel}
          onSelect={sel1(setSel)}
          empty={{ title: 'No hay tablas de enrutamiento' }}
          filterPlaceholder="Buscar tablas de enrutamiento por atributo o etiqueta"
          cols={[
            { head: 'Nombre', cell: (x) => (nm(x.tags) === '-' ? '-' : <Link to={'/vpc/routes/' + x.id}>{nm(x.tags)}</Link>), text: (x) => nm(x.tags) },
            { head: 'ID de tabla de enrutamiento', cell: (x) => <Link to={'/vpc/routes/' + x.id}>{x.id}</Link>, text: (x) => x.id },
            { head: 'Asociaciones de subred explícitas', cell: (x) => { const n = x.associations.filter((a) => a.subnetId).length; return n ? `${n} subred${n === 1 ? '' : 'es'}` : '-'; } },
            { head: 'Principal', cell: (x) => (x.main ? 'Sí' : 'No') },
            { head: 'VPC', cell: (x) => <Link to={'/vpc/vpcs/' + x.vpcId}>{x.vpcId}</Link>, text: (x) => x.vpcId },
            { head: 'Rutas', cell: (x) => x.routes.map((q) => `${q.destination} → ${q.target}`).join(' · ') },
            { head: 'ID de propietario', cell: () => s.account.id },
          ]}
        />
      </Card>
      {create && <CreateRtb onClose={() => setCreate(false)} />}
    </>
  );
}

function CreateRtb({ onClose }: { onClose: () => void }) {
  const s = useCloud();
  const vpcs = inRegion(s.vpcs, s.region);
  const [vpcId, setVpcId] = useState(vpcs.find((v) => !v.isDefault)?.id ?? vpcs[0]?.id ?? '');
  const [name, setName] = useState('');
  const cmd = cmdOf('aws ec2 create-route-table --vpc-id', vpcId || '<vpc-id>', tagSpec('route-table', name), rg(s.region));
  return (
    <ConfirmModal title="Crear tabla de enrutamiento" label="Crear tabla de enrutamiento" danger={false} cmd={cmd} onClose={onClose}
      onConfirm={async () => (nameError(name) ? nameError(name) : !vpcId ? 'Seleccione una VPC.' : modalRun(cmd, 'Se creó correctamente la tabla de enrutamiento.')())}>
      <Field label="Nombre"><input type="text" aria-label="Nombre" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="VPC"><select aria-label="VPC" value={vpcId} onChange={(e) => setVpcId(e.target.value)}>{vpcs.map((v) => <option key={v.id} value={v.id}>{v.id} {nm(v.tags) !== '-' ? `(${nm(v.tags)})` : ''}</option>)}</select></Field>
    </ConfirmModal>
  );
}

export function RouteDetail({ id, tab: t0 }: { id: string; tab?: string }) {
  const s = useCloud();
  const rt = s.routeTables.find((x) => x.id === id);
  const [tab, setTab] = useState(t0 === 'routes' ? 'Rutas' : 'Detalles');
  const [modal, setModal] = useState<null | 'add' | 'assoc' | 'tag'>(null);
  const [delDest, setDelDest] = useState<string | null>(null);
  if (!rt) return (
    <>
      <Crumbs items={[{ label: 'VPC', to: '/vpc' }, { label: 'Tablas de enrutamiento', to: '/vpc/routes' }, { label: id }]} />
      <Flash kind="err" title="Tabla de enrutamiento no encontrada">La tabla {id} no existe en la región {s.region}. <Link to="/vpc/routes">Volver</Link></Flash>
    </>
  );
  const explicit = rt.associations.filter((a) => a.subnetId);
  const implicit = rt.main ? s.subnets.filter((x) => x.vpcId === rt.vpcId && !s.routeTables.some((r) => r.associations.some((a) => a.subnetId === x.id))) : [];
  return (
    <>
      <Crumbs items={[{ label: 'VPC', to: '/vpc' }, { label: 'Tablas de enrutamiento', to: '/vpc/routes' }, { label: rt.id }]} />
      <FlashBar />
      <PageHead title={<>{rt.id}{nm(rt.tags) !== '-' && <span style={{ fontWeight: 400, color: 'var(--muted)' }}> / {nm(rt.tags)}</span>}</>}>
        <ActionsMenu items={[{ label: 'Editar rutas', onClick: () => setTab('Rutas') }, { label: 'Agregar ruta', onClick: () => setModal('add') }, { label: 'Editar asociaciones de subred', onClick: () => setModal('assoc') }, { label: 'Administrar etiquetas', onClick: () => setModal('tag') }]} />
      </PageHead>
      <Card flush>
        <Tabs tabs={['Detalles', 'Rutas', 'Asociaciones de subred', 'Etiquetas']} value={tab} onChange={setTab} />
        <div style={{ padding: 20 }}>
          {tab === 'Detalles' && <KV items={[['ID de tabla de enrutamiento', rt.id], ['Principal', rt.main ? 'Sí' : 'No'], ['VPC', <Link to={'/vpc/vpcs/' + rt.vpcId}>{rt.vpcId}</Link>], ['Asociaciones de subred explícitas', explicit.length ? explicit.map((a) => a.subnetId).join(', ') : '-'], ['Rutas', rt.routes.length], ['ID de propietario', s.account.id]]} />}
          {tab === 'Rutas' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}><b>Rutas ({rt.routes.length})</b><Btn kind="primary" onClick={() => setModal('add')}>Agregar ruta</Btn></div>
              <RouteTableTable rt={rt} onDelete={setDelDest} />
            </>
          )}
          {tab === 'Asociaciones de subred' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}><b>Asociaciones de subred explícitas ({explicit.length})</b><Btn onClick={() => setModal('assoc')}>Editar asociaciones de subred</Btn></div>
              <Table rows={explicit} id={(a) => a.id} empty={{ title: 'Sin asociaciones explícitas', desc: rt.main ? 'Las subredes sin asociación explícita usan esta tabla principal.' : 'Ninguna subred está asociada explícitamente.' }} cols={[
                { head: 'ID de asociación', cell: (a) => a.id },
                { head: 'ID de subred', cell: (a) => <Link to={'/vpc/subnets/' + a.subnetId}>{a.subnetId}</Link>, text: (a) => a.subnetId ?? '' },
                { head: 'Nombre', cell: (a) => nm(s.subnets.find((x) => x.id === a.subnetId)?.tags) },
                { head: 'CIDR IPv4', cell: (a) => s.subnets.find((x) => x.id === a.subnetId)?.cidr ?? '-' },
              ]} />
              {rt.main && (
                <>
                  <h3 style={{ margin: '20px 0 8px' }}>Subredes sin asociaciones explícitas ({implicit.length})</h3>
                  <Table rows={implicit} id={(x) => x.id} empty={{ title: 'Ninguna' }} cols={[{ head: 'ID de subred', cell: (x) => <Link to={'/vpc/subnets/' + x.id}>{x.id}</Link>, text: (x) => x.id }, { head: 'CIDR IPv4', cell: (x) => x.cidr }]} />
                </>
              )}
            </>
          )}
          {tab === 'Etiquetas' && <Table rows={Object.entries(rt.tags)} id={([k]) => k} empty={{ title: 'Sin etiquetas' }} cols={[{ head: 'Clave', cell: ([k]) => k }, { head: 'Valor', cell: ([, v]) => v }]} />}
        </div>
      </Card>
      {modal === 'add' && <AddRoute rt={rt} onClose={() => setModal(null)} />}
      {modal === 'assoc' && <AssocModal rt={rt} onClose={() => setModal(null)} />}
      {modal === 'tag' && <TagModal resource={rt.id} onClose={() => setModal(null)} />}
      {delDest && (
        <ConfirmModal title="Eliminar ruta" cmd={`aws ec2 delete-route --route-table-id ${rt.id} --destination-cidr-block ${delDest} ${rg(s.region)}`} onClose={() => setDelDest(null)} onConfirm={modalRun(`aws ec2 delete-route --route-table-id ${rt.id} --destination-cidr-block ${delDest} ${rg(s.region)}`, `Se eliminó la ruta ${delDest}.`)}>
          <p>¿Seguro que desea eliminar la ruta con destino <b>{delDest}</b>?</p>
        </ConfirmModal>
      )}
    </>
  );
}

function AddRoute({ rt, onClose }: { rt: RouteTable; onClose: () => void }) {
  const s = useCloud();
  const igws = s.internetGateways.filter((g) => g.region === s.region && g.attachedVpcId === rt.vpcId);
  const nats = s.natGateways.filter((n) => n.region === s.region && n.state !== 'deleted' && s.subnets.find((x) => x.id === n.subnetId)?.vpcId === rt.vpcId);
  const opts = [...igws.map((g) => ({ id: g.id, label: `Gateway de internet — ${g.id}${nm(g.tags) !== '-' ? ' (' + nm(g.tags) + ')' : ''}` })), ...nats.map((n) => ({ id: n.id, label: `Gateway NAT — ${n.id}${nm(n.tags) !== '-' ? ' (' + nm(n.tags) + ')' : ''}` }))];
  const [dest, setDest] = useState('0.0.0.0/0');
  const [target, setTarget] = useState(opts[0]?.id ?? '');
  const cmd = `aws ec2 create-route --route-table-id ${rt.id} --destination-cidr-block ${dest} ${target.startsWith('nat-') ? '--nat-gateway-id' : '--gateway-id'} ${target || '<destino>'} ${rg(s.region)}`;
  const bad = !parseCidr(dest) ? 'Introduzca un CIDR válido, por ejemplo 0.0.0.0/0' : !target ? 'Seleccione un destino. Esta VPC no tiene gateways de internet conectados ni gateways NAT.' : '';
  return (
    <ConfirmModal title="Agregar ruta" label="Guardar cambios" danger={false} cmd={cmd} onClose={onClose} onConfirm={async () => (bad ? bad : modalRun(cmd, `Se agregó la ruta ${dest} → ${target}.`)())}>
      <Field label="Destino"><input type="text" aria-label="Destino" value={dest} onChange={(e) => setDest(e.target.value)} /></Field>
      <Field label="Destino de la ruta" error={bad && !parseCidr(dest) ? undefined : bad || undefined}>
        <select aria-label="Destino de la ruta" value={target} onChange={(e) => setTarget(e.target.value)}>{opts.length === 0 && <option value="">— sin destinos disponibles —</option>}{opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
      </Field>
    </ConfirmModal>
  );
}

function AssocModal({ rt, onClose }: { rt: RouteTable; onClose: () => void }) {
  const s = useCloud();
  const subs = s.subnets.filter((x) => x.vpcId === rt.vpcId && !rt.associations.some((a) => a.subnetId === x.id));
  const [sub, setSub] = useState(subs[0]?.id ?? '');
  const cmd = `aws ec2 associate-route-table --route-table-id ${rt.id} --subnet-id ${sub || '<subnet-id>'} ${rg(s.region)}`;
  return (
    <ConfirmModal title="Editar asociaciones de subred" label="Asociar subred" danger={false} cmd={cmd} onClose={onClose} onConfirm={async () => (!sub ? 'No hay subredes disponibles para asociar.' : modalRun(cmd, `La subred ${sub} se asoció a ${rt.id}.`)())}>
      <Field label="Subred a asociar" hint="La asociación explícita sustituye a la que tuviera la subred.">
        <select aria-label="Subred a asociar" value={sub} onChange={(e) => setSub(e.target.value)}>{subs.length === 0 && <option value="">— sin subredes disponibles —</option>}{subs.map((x) => <option key={x.id} value={x.id}>{x.id} {nm(x.tags) !== '-' ? `(${nm(x.tags)})` : ''} — {x.cidr}</option>)}</select>
      </Field>
    </ConfirmModal>
  );
}

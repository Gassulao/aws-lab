import React, { useState } from 'react';
import { useCloud, consoleRun } from '../../session';
import { Btn, Card, Crumbs, Field, Flash, Status, Table } from '../../components/ui';
import { isPublicSubnet } from '../../../engine/services/ec2';
import { NAT_HOURLY } from '../../../engine/catalog';
import { ActionsMenu, ConfirmModal, FilterBanner, FlashBar, Link, cmdOf, errParts, inRegion, modalRun, nameError, nm, notify, rg, sel1, tagSpec, useVpcFilter } from './common';

// ---------------------------------------------------------------- Gateways de internet
export function IgwList({ path }: { path: string }) {
  const s = useCloud();
  const [vpc, clear] = useVpcFilter(path);
  const rows = inRegion(s.internetGateways, s.region).filter((x) => !vpc || x.attachedVpcId === vpc);
  const [sel, setSel] = useState<string[]>([]);
  const [modal, setModal] = useState<null | 'create' | 'attach' | 'detach' | 'del'>(null);
  const cur = rows.find((x) => x.id === sel[0]);
  const R = rg(s.region);
  return (
    <>
      <Crumbs items={[{ label: 'VPC', to: '/vpc' }, { label: 'Gateways de internet' }]} />
      <FlashBar />
      <Card
        title="Gateways de internet"
        count={rows.length}
        flush
        actions={
          <>
            <ActionsMenu items={[
              { label: 'Conectar a la VPC', disabled: !cur || !!cur.attachedVpcId, onClick: () => setModal('attach') },
              { label: 'Desconectar de la VPC', disabled: !cur || !cur.attachedVpcId, onClick: () => setModal('detach') },
              'sep',
              { label: 'Eliminar gateway de internet', disabled: !cur, onClick: () => setModal('del') },
            ]} />
            <Btn kind="primary" onClick={() => setModal('create')}>Crear gateway de internet</Btn>
          </>
        }
      >
        <FilterBanner vpc={vpc} clear={clear} />
        <Table
          rows={rows}
          id={(x) => x.id}
          selected={sel}
          onSelect={sel1(setSel)}
          empty={{ title: 'No hay gateways de internet', desc: 'Cree un gateway de internet y conéctelo a una VPC.' }}
          filterPlaceholder="Buscar gateways de internet por atributo o etiqueta"
          cols={[
            { head: 'Nombre', cell: (x) => nm(x.tags) },
            { head: 'ID del gateway de internet', cell: (x) => x.id },
            { head: 'Estado', cell: (x) => (x.attachedVpcId ? <Status tone="ok">Attached</Status> : <Status tone="warn">Detached</Status>), text: (x) => (x.attachedVpcId ? 'attached' : 'detached') },
            { head: 'ID de VPC', cell: (x) => (x.attachedVpcId ? <Link to={'/vpc/vpcs/' + x.attachedVpcId}>{x.attachedVpcId}</Link> : '-'), text: (x) => x.attachedVpcId ?? '' },
            { head: 'ID de propietario', cell: () => s.account.id },
          ]}
        />
      </Card>
      {modal === 'create' && <CreateIgw onClose={() => setModal(null)} />}
      {modal === 'attach' && cur && <AttachIgw id={cur.id} onClose={() => setModal(null)} />}
      {modal === 'detach' && cur?.attachedVpcId && (
        <ConfirmModal title="Desconectar de la VPC" label="Desconectar gateway de internet" cmd={`aws ec2 detach-internet-gateway --internet-gateway-id ${cur.id} --vpc-id ${cur.attachedVpcId} ${R}`} onClose={() => setModal(null)} onConfirm={modalRun(`aws ec2 detach-internet-gateway --internet-gateway-id ${cur.id} --vpc-id ${cur.attachedVpcId} ${R}`, `El gateway de internet ${cur.id} se desconectó de ${cur.attachedVpcId}.`)}>
          <p>¿Desconectar <b>{cur.id}</b> de la VPC <b>{cur.attachedVpcId}</b>? Los recursos de la VPC perderán acceso a internet.</p>
        </ConfirmModal>
      )}
      {modal === 'del' && cur && (
        <ConfirmModal title="Eliminar gateway de internet" cmd={`aws ec2 delete-internet-gateway --internet-gateway-id ${cur.id} ${R}`} onClose={() => setModal(null)} onConfirm={modalRun(`aws ec2 delete-internet-gateway --internet-gateway-id ${cur.id} ${R}`, `Se eliminó correctamente el gateway de internet ${cur.id}.`, () => setSel([]))}>
          <p>¿Seguro que desea eliminar <b>{cur.id}</b>? Debe estar desconectado de la VPC.</p>
        </ConfirmModal>
      )}
    </>
  );
}

function CreateIgw({ onClose }: { onClose: () => void }) {
  const s = useCloud();
  const [name, setName] = useState('');
  const cmd = cmdOf('aws ec2 create-internet-gateway', tagSpec('internet-gateway', name), rg(s.region));
  return (
    <ConfirmModal title="Crear gateway de internet" label="Crear gateway de internet" danger={false} cmd={cmd} onClose={onClose}
      onConfirm={async () => (nameError(name) ? nameError(name) : modalRun(cmd, 'Se creó correctamente el gateway de internet. Ahora puede conectarlo a una VPC.')())}>
      <Field label="Etiqueta de nombre" hint="Crea una etiqueta con la clave «Name»." error={nameError(name) || undefined}><input type="text" aria-label="Etiqueta de nombre" value={name} onChange={(e) => setName(e.target.value)} /></Field>
    </ConfirmModal>
  );
}

function AttachIgw({ id, onClose }: { id: string; onClose: () => void }) {
  const s = useCloud();
  const free = inRegion(s.vpcs, s.region).filter((v) => !s.internetGateways.some((g) => g.attachedVpcId === v.id));
  const [vpcId, setVpcId] = useState(free[0]?.id ?? '');
  const cmd = `aws ec2 attach-internet-gateway --internet-gateway-id ${id} --vpc-id ${vpcId || '<vpc-id>'} ${rg(s.region)}`;
  return (
    <ConfirmModal title="Conectar a la VPC" label="Conectar gateway de internet" danger={false} cmd={cmd} onClose={onClose} onConfirm={async () => (!vpcId ? 'No hay VPC disponibles sin gateway de internet.' : modalRun(cmd, `El gateway de internet ${id} se conectó a ${vpcId}.`)())}>
      <Field label="VPC disponibles" hint="Una VPC solo puede tener un gateway de internet conectado."><select aria-label="VPC disponibles" value={vpcId} onChange={(e) => setVpcId(e.target.value)}>{free.length === 0 && <option value="">— ninguna —</option>}{free.map((v) => <option key={v.id} value={v.id}>{v.id} {nm(v.tags) !== '-' ? `(${nm(v.tags)})` : ''}</option>)}</select></Field>
    </ConfirmModal>
  );
}

// ---------------------------------------------------------------- Gateways NAT
export function NatList({ path }: { path: string }) {
  const s = useCloud();
  const [vpc, clear] = useVpcFilter(path);
  const rows = inRegion(s.natGateways, s.region).filter((n) => !vpc || s.subnets.find((x) => x.id === n.subnetId)?.vpcId === vpc);
  const [sel, setSel] = useState<string[]>([]);
  const [modal, setModal] = useState<null | 'create' | 'del'>(null);
  const cur = rows.find((x) => x.id === sel[0]);
  const R = rg(s.region);
  const ST: Record<string, [string, 'ok' | 'err' | 'load']> = { available: ['Disponible', 'ok'], pending: ['Pendiente', 'load'], deleted: ['Eliminado', 'err'] };
  return (
    <>
      <Crumbs items={[{ label: 'VPC', to: '/vpc' }, { label: 'Gateways NAT' }]} />
      <FlashBar />
      <Card
        title="Gateways NAT"
        count={rows.length}
        flush
        actions={
          <>
            <ActionsMenu items={[{ label: 'Eliminar gateway NAT', disabled: !cur || cur.state === 'deleted', onClick: () => setModal('del') }]} />
            <Btn kind="primary" onClick={() => setModal('create')}>Crear gateway NAT</Btn>
          </>
        }
      >
        <FilterBanner vpc={vpc} clear={clear} />
        <Table
          rows={rows}
          id={(x) => x.id}
          selected={sel}
          onSelect={sel1(setSel)}
          empty={{ title: 'No hay gateways NAT', desc: 'Un gateway NAT permite que las subredes privadas salgan a internet.' }}
          filterPlaceholder="Buscar gateways NAT por atributo o etiqueta"
          cols={[
            { head: 'Nombre', cell: (x) => nm(x.tags) },
            { head: 'ID del gateway NAT', cell: (x) => x.id },
            { head: 'Tipo de conectividad', cell: () => 'Público' },
            { head: 'Estado', cell: (x) => <Status tone={ST[x.state][1]}>{ST[x.state][0]}</Status>, text: (x) => ST[x.state][0] },
            { head: 'Dirección IP elástica principal', cell: (x) => s.elasticIps.find((e) => e.id === x.allocationId)?.publicIp ?? '-' },
            { head: 'ID de subred', cell: (x) => <Link to={'/vpc/subnets/' + x.subnetId}>{x.subnetId}</Link>, text: (x) => x.subnetId },
            { head: 'ID de VPC', cell: (x) => s.subnets.find((q) => q.id === x.subnetId)?.vpcId ?? '-' },
            { head: 'Hora de creación', cell: (x) => new Date(x.createdAt).toLocaleString('es-ES') },
          ]}
        />
      </Card>
      {modal === 'create' && <CreateNat onClose={() => setModal(null)} />}
      {modal === 'del' && cur && (
        <ConfirmModal title="Eliminar gateway NAT" cmd={`aws ec2 delete-nat-gateway --nat-gateway-id ${cur.id} ${R}`} onClose={() => setModal(null)} onConfirm={modalRun(`aws ec2 delete-nat-gateway --nat-gateway-id ${cur.id} ${R}`, `Se eliminó el gateway NAT ${cur.id}. La IP elástica sigue asignada: libérela para evitar cargos.`, () => setSel([]))}>
          <p>¿Seguro que desea eliminar el gateway NAT <b>{cur.id}</b>? Las subredes privadas que dependan de él perderán la salida a internet.</p>
        </ConfirmModal>
      )}
    </>
  );
}

function CreateNat({ onClose }: { onClose: () => void }) {
  const s = useCloud();
  const subs = inRegion(s.subnets, s.region);
  const free = inRegion(s.elasticIps, s.region).filter((e) => !e.associatedInstanceId && !s.natGateways.some((n) => n.allocationId === e.id && n.state !== 'deleted'));
  const [name, setName] = useState('');
  const [sub, setSub] = useState(subs.find((x) => isPublicSubnet(s, x) && !s.vpcs.find((v) => v.id === x.vpcId)?.isDefault)?.id ?? subs.find((x) => isPublicSubnet(s, x))?.id ?? subs[0]?.id ?? '');
  const [alloc, setAlloc] = useState(free[0]?.id ?? 'auto');
  const pubSub = subs.find((x) => x.id === sub);
  const R = rg(s.region);
  const cmd = cmdOf('aws ec2 create-nat-gateway --subnet-id', sub || '<subnet-id>', '--allocation-id', alloc === 'auto' ? '<eipalloc-id>' : alloc, tagSpec('natgateway', name), R);
  const go = async (): Promise<string | null> => {
    if (nameError(name)) return nameError(name);
    if (!sub) return 'Seleccione una subred.';
    let allocId = alloc;
    if (alloc === 'auto') {
      const a = await consoleRun(`aws ec2 allocate-address --domain vpc ${R}`);
      if (!a.ok) return errParts(a.err).msg;
      allocId = a.json.AllocationId;
    }
    const real = cmdOf('aws ec2 create-nat-gateway --subnet-id', sub, '--allocation-id', allocId, tagSpec('natgateway', name), R);
    const r = await consoleRun(real);
    if (!r.ok) {
      const e = errParts(r.err);
      return (e.code ? e.code + ': ' : '') + e.msg;
    }
    notify({ kind: 'ok', text: `Se creó correctamente el gateway NAT ${r.json.NatGateway.NatGatewayId}.` });
    return null;
  };
  return (
    <ConfirmModal title="Crear gateway NAT" label="Crear gateway NAT" danger={false} cmd={cmd} onClose={onClose} onConfirm={go}>
      <Field label="Nombre" error={nameError(name) || undefined}><input type="text" aria-label="Nombre" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Subred" hint="Seleccione una subred pública en la que se creará el gateway NAT.">
        <select aria-label="Subred" value={sub} onChange={(e) => setSub(e.target.value)}>
          {subs.length === 0 && <option value="">— sin subredes —</option>}
          {subs.map((x) => <option key={x.id} value={x.id}>{x.id} {nm(x.tags) !== '-' ? `(${nm(x.tags)})` : ''} — {isPublicSubnet(s, x) ? 'pública' : 'privada'}</option>)}
        </select>
        {pubSub && !isPublicSubnet(s, pubSub) && <div className="vp-warn">Esta subred no tiene ruta a un gateway de internet: el NAT no tendrá salida a internet.</div>}
      </Field>
      <Field label="ID de asignación de IP elástica">
        <select aria-label="ID de asignación de IP elástica" value={alloc} onChange={(e) => setAlloc(e.target.value)}>
          <option value="auto">Asignar dirección IP elástica nueva</option>
          {free.map((e) => <option key={e.id} value={e.id}>{e.id} ({e.publicIp})</option>)}
        </select>
      </Field>
      <div className="vp-warn">Coste estimado: ${NAT_HOURLY.toFixed(3)} por hora (≈ ${(NAT_HOURLY * 730).toFixed(0)}/mes) más el tráfico procesado.</div>
    </ConfirmModal>
  );
}

// ---------------------------------------------------------------- IP elásticas
export function EipList() {
  const s = useCloud();
  const rows = inRegion(s.elasticIps, s.region);
  const [sel, setSel] = useState<string[]>([]);
  const [modal, setModal] = useState<null | 'alloc' | 'rel'>(null);
  const cur = rows.find((x) => x.id === sel[0]);
  const R = rg(s.region);
  return (
    <>
      <Crumbs items={[{ label: 'VPC', to: '/vpc' }, { label: 'Direcciones IP elásticas' }]} />
      <FlashBar />
      <Card
        title="Direcciones IP elásticas"
        count={rows.length}
        flush
        actions={
          <>
            <ActionsMenu items={[{ label: 'Liberar direcciones IP elásticas', disabled: !cur, onClick: () => setModal('rel') }]} />
            <Btn kind="primary" onClick={() => setModal('alloc')}>Asignar dirección IP elástica</Btn>
          </>
        }
      >
        <Table
          rows={rows}
          id={(x) => x.id}
          selected={sel}
          onSelect={sel1(setSel)}
          empty={{ title: 'No hay direcciones IP elásticas', desc: 'Asigne una dirección IP elástica para usarla con un gateway NAT o una instancia.' }}
          filterPlaceholder="Buscar direcciones IP elásticas"
          cols={[
            { head: 'Nombre', cell: (x) => nm(x.tags) },
            { head: 'Dirección IPv4 asignada', cell: (x) => x.publicIp },
            { head: 'Tipo', cell: () => 'IP pública' },
            { head: 'ID de asignación', cell: (x) => x.id },
            { head: 'ID de instancia asociada', cell: (x) => (x.associatedInstanceId ? <Link to={'/ec2/instance/' + x.associatedInstanceId}>{x.associatedInstanceId}</Link> : '-'), text: (x) => x.associatedInstanceId ?? '' },
            { head: 'En uso por', cell: (x) => s.natGateways.find((n) => n.allocationId === x.id && n.state !== 'deleted')?.id ?? '-' },
            { head: 'Grupo de borde de red', cell: (x) => x.region },
          ]}
        />
      </Card>
      {modal === 'alloc' && (
        <ConfirmModal title="Asignar dirección IP elástica" label="Asignar" danger={false} cmd={`aws ec2 allocate-address --domain vpc ${R}`} onClose={() => setModal(null)} onConfirm={modalRun(`aws ec2 allocate-address --domain vpc ${R}`, 'Se asignó correctamente una nueva dirección IP elástica.')}>
          <Field label="Grupo de direcciones IPv4"><select><option>Grupo de direcciones IPv4 de Amazon</option></select></Field>
          <div className="vp-warn">Desde 2024 AWS cobra ${0.005} por hora por cada dirección IPv4 pública, esté en uso o no.</div>
        </ConfirmModal>
      )}
      {modal === 'rel' && cur && (
        <ConfirmModal title="Liberar direcciones IP elásticas" label="Liberar" cmd={`aws ec2 release-address --allocation-id ${cur.id} ${R}`} onClose={() => setModal(null)} onConfirm={modalRun(`aws ec2 release-address --allocation-id ${cur.id} ${R}`, `Se liberó la dirección IP elástica ${cur.publicIp}.`, () => setSel([]))}>
          <p>¿Liberar la dirección <b>{cur.publicIp}</b> ({cur.id})? No podrá recuperarla.</p>
        </ConfirmModal>
      )}
    </>
  );
}

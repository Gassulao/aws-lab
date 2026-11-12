import React, { useState } from 'react';
import { Card, Crumbs, PageHead, Table } from '../../components/ui';
import { Badge, ts, useCicd } from './common';
import { cicd } from '../../../engine/services/cicdTypes';
import { deploymentsOf } from '../../../engine/services/codedeploy';

export function Deployments() {
  const s = useCicd();
  const [open, setOpen] = useState('');
  const apps = cicd(s).apps.filter((a) => a.region === s.region);
  const groups = cicd(s).groups.filter((g) => g.region === s.region);
  const deps = deploymentsOf(s).filter((d) => d.region === s.region);
  const sel = deps.find((d) => d.id === open);
  return (
    <>
      <Crumbs items={[{ label: 'Developer Tools', to: '/devtools/repos' }, { label: 'Implementaciones' }]} />
      <PageHead title="Implementaciones" desc="Aplicaciones, grupos de implementación y despliegues de CodeDeploy (plataforma de servidores EC2)." />
      <Card title="Aplicaciones" count={apps.length} flush>
        <Table rows={apps} id={(a) => a.name} empty={{ title: 'No hay aplicaciones', desc: 'Cree una con aws deploy create-application.' }} cols={[
          { head: 'Nombre', cell: (a) => a.name, text: (a) => a.name },
          { head: 'Plataforma', cell: (a) => a.computePlatform, text: (a) => a.computePlatform },
          { head: 'Grupos de implementación', cell: (a) => groups.filter((g) => g.appName === a.name).map((g) => g.name).join(', ') || '–' },
        ]} />
      </Card>
      <Card title="Implementaciones" count={deps.length} flush>
        <Table rows={deps} id={(d) => d.id} empty={{ title: 'Sin implementaciones' }} cols={[
          { head: 'ID', cell: (d) => <a onClick={() => setOpen(d.id)}>{d.id}</a>, text: (d) => d.id },
          { head: 'Estado', cell: (d) => <Badge s={d.status} />, text: (d) => d.status },
          { head: 'Aplicación / grupo', cell: (d) => `${d.appName} / ${d.groupName}`, text: (d) => d.appName },
          { head: 'Configuración', cell: (d) => d.configName, text: (d) => d.configName },
          { head: 'Creación', cell: (d) => ts(d.created), text: (d) => String(d.created) },
        ]} />
      </Card>
      {sel && (
        <Card title={`Instancias de ${sel.id}`} flush>
          {sel.error && <div className="dt-pad dt-diff-del">{sel.error.code}: {sel.error.message}</div>}
          <Table rows={sel.targets} id={(t) => t.instanceId} empty={{ title: 'Sin instancias de destino' }} cols={[
            { head: 'Instancia', cell: (t) => t.instanceId, text: (t) => t.instanceId },
            { head: 'Estado', cell: (t) => <Badge s={t.status} />, text: (t) => t.status },
            { head: 'Eventos del ciclo de vida', cell: (t) => t.lifecycle.map((l) => `${l.name}: ${l.status}`).join(' · ') },
          ]} />
        </Card>
      )}
    </>
  );
}

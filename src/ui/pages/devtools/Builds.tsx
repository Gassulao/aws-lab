import React, { useState } from 'react';
import { Btn, Card, CliEquivalent, Crumbs, Flash, PageHead, Table, nav } from '../../components/ui';
import { Dl, run, takeFlash } from '../iam/kit';
import { Badge, ts, useCicd } from './common';
import { cicd } from '../../../engine/services/cicdTypes';
import { buildsOf, currentPhase, visiblePhases } from '../../../engine/services/codebuild';

export function Builds() {
  const s = useCicd();
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const projects = cicd(s).projects.filter((p) => p.region === s.region);
  const builds = buildsOf(s).filter((b) => b.region === s.region);
  const start = async (n: string) => { const r = await run(`aws codebuild start-build --project-name ${n}`); if (!r.ok) setErr(r.msg); else { setErr(''); setFlash(`Compilación iniciada en ${n}.`); } };
  return (
    <>
      <Crumbs items={[{ label: 'Developer Tools', to: '/devtools/repos' }, { label: 'Compilaciones' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title="Compilaciones" desc="Proyectos de CodeBuild y su historial de compilaciones." />
      <Card title="Proyectos de compilación" count={projects.length} flush>
        <Table rows={projects} id={(p) => p.name} empty={{ title: 'No hay proyectos', desc: 'Cree uno con aws codebuild create-project.' }} cols={[
          { head: 'Nombre', cell: (p) => p.name, text: (p) => p.name },
          { head: 'Origen', cell: (p) => `${p.source.type}${p.source.location ? ' · ' + p.source.location : ''}`, text: (p) => p.source.type },
          { head: 'Rol de servicio', cell: (p) => p.serviceRole.split('/').pop(), text: (p) => p.serviceRole },
          { head: 'Acción', cell: (p) => <Btn small onClick={() => start(p.name)}>Iniciar compilación</Btn> },
        ]} />
      </Card>
      <Card title="Historial de compilaciones" count={builds.length} flush>
        <Table rows={builds} id={(b) => b.id} empty={{ title: 'Sin compilaciones' }} cols={[
          { head: 'Ejecución', cell: (b) => <a onClick={() => nav('/devtools/build/' + encodeURIComponent(b.id))}>{b.projectName}:#{b.buildNumber}</a>, text: (b) => b.id },
          { head: 'Estado', cell: (b) => <Badge s={b.buildStatus} />, text: (b) => b.buildStatus },
          { head: 'Fase actual', cell: (b) => currentPhase(b), text: (b) => currentPhase(b) },
          { head: 'Inicio', cell: (b) => ts(b.startTime), text: (b) => String(b.startTime) },
          { head: 'Iniciador', cell: (b) => b.initiator, text: (b) => b.initiator },
        ]} />
      </Card>
    </>
  );
}

export function BuildDetail({ id }: { id: string }) {
  const s = useCicd();
  const [flash, setFlash] = useState(takeFlash);
  const b = cicd(s).builds.find((x) => x.id === id && x.region === s.region);
  const crumbs = <Crumbs items={[{ label: 'Developer Tools', to: '/devtools/repos' }, { label: 'Compilaciones', to: '/devtools/builds' }, { label: id }]} />;
  if (!b) return <>{crumbs}<Flash kind="err" title="ResourceNotFoundException">Build cannot be found: {id}</Flash></>;
  const group = s.logGroups.find((g) => g.name === b.logGroup && g.region === b.region);
  const stream = group?.streams.find((x) => x.name === b.logStream);
  const logs = (stream?.events ?? []).map((e) => e.message.replace(/\n$/, '')).join('\n');
  return (
    <>
      {crumbs}
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <PageHead title={<>{b.projectName}:#{b.buildNumber} <Badge s={b.buildStatus} /></>}>
        <Btn disabled={b.buildStatus !== 'IN_PROGRESS'} onClick={async () => { const r = await run(`aws codebuild stop-build --id ${b.id}`); if (r.ok) setFlash('Compilación detenida.'); }}>Detener compilación</Btn>
      </PageHead>
      <Card title="Detalles">
        <Dl items={[['ID', b.id], ['Proyecto', b.projectName], ['Inicio', ts(b.startTime)], ['Fin', ts(b.endTime)], ['Rol de servicio', b.serviceRole], ['Iniciador', b.initiator], ['Imagen', b.environment.image], ['Versión de origen', b.resolvedSourceVersion ?? b.sourceVersion ?? '–']]} />
      </Card>
      <Card title="Detalles de las fases" flush>
        <Table rows={visiblePhases(b)} id={(p) => p.phaseType} empty={{ title: 'Sin fases' }} cols={[
          { head: 'Nombre', cell: (p) => p.phaseType, text: (p) => p.phaseType },
          { head: 'Estado', cell: (p) => <Badge s={p.phaseStatus ?? 'IN_PROGRESS'} />, text: (p) => p.phaseStatus ?? '' },
          { head: 'Duración', cell: (p) => (p.durationInSeconds !== undefined ? `${p.durationInSeconds} s` : '–') },
          { head: 'Mensaje', cell: (p) => p.contexts?.map((c) => `${c.statusCode}: ${c.message}`).join(' · ') ?? '–' },
        ]} />
      </Card>
      <Card title="Registros de compilación (CloudWatch Logs)">
        <pre className="dt-code dt-log" aria-label="Registros de compilación">{logs || '(todavía no hay registros)'}</pre>
        <CliEquivalent cmd={`aws logs get-log-events --log-group-name ${b.logGroup ?? ''} --log-stream-name ${b.logStream}`} />
      </Card>
    </>
  );
}

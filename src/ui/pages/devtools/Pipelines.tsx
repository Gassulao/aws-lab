import React, { useState } from 'react';
import { Btn, Card, CliEquivalent, Crumbs, Flash, PageHead, Table, nav } from '../../components/ui';
import { Dl, run, takeFlash } from '../iam/kit';
import { Badge, ts, useCicd } from './common';
import { cicd } from '../../../engine/services/cicdTypes';
import { executionsOf, stageStates } from '../../../engine/services/codepipeline';

const cls = (st?: string) => (st === 'Succeeded' ? 'dt-s-ok' : st === 'Failed' || st === 'Stopped' ? 'dt-s-err' : st === 'InProgress' ? 'dt-s-load' : 'dt-s-none');

export function Pipelines() {
  const s = useCicd();
  const rows = cicd(s).pipelines.filter((p) => p.region === s.region);
  return (
    <>
      <Crumbs items={[{ label: 'Developer Tools', to: '/devtools/repos' }, { label: 'Canalizaciones' }]} />
      <PageHead title="Canalizaciones" desc="CodePipeline orquesta las etapas Source, Build, aprobación y Deploy." />
      <Card title="Canalizaciones" count={rows.length} flush>
        <Table rows={rows} id={(p) => p.name} empty={{ title: 'No hay canalizaciones', desc: 'Cree una con aws codepipeline create-pipeline --cli-input-json file://pipeline.json.' }} cols={[
          { head: 'Nombre', cell: (p) => <a onClick={() => nav('/devtools/pipeline/' + encodeURIComponent(p.name))}>{p.name}</a>, text: (p) => p.name },
          { head: 'Última ejecución', cell: (p) => <Badge s={executionsOf(s, p.name, p.region)[0]?.status} />, text: (p) => executionsOf(s, p.name, p.region)[0]?.status ?? '' },
          { head: 'Etapas', cell: (p) => p.stages.map((x) => x.name).join(' → '), text: (p) => p.name },
          { head: 'Actualizada', cell: (p) => ts(p.updated), text: (p) => String(p.updated) },
        ]} />
      </Card>
    </>
  );
}

export function PipelineDetail({ name }: { name: string }) {
  const s = useCicd();
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const pl = cicd(s).pipelines.find((p) => p.name === name && p.region === s.region);
  const crumbs = <Crumbs items={[{ label: 'Developer Tools', to: '/devtools/repos' }, { label: 'Canalizaciones', to: '/devtools/pipelines' }, { label: name }]} />;
  if (!pl) return <>{crumbs}<Flash kind="err" title="PipelineNotFoundException">Account '{s.account.id}' does not have a pipeline with name '{name}'</Flash></>;
  const states = stageStates(s, pl);
  const execs = executionsOf(s, pl.name, pl.region);
  const go = async (cmd: string, ok: string) => { const r = await run(cmd); if (!r.ok) setErr(r.msg); else { setErr(''); setFlash(ok); } };
  return (
    <>
      {crumbs}
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title={pl.name}>
        <Btn kind="primary" onClick={() => go(`aws codepipeline start-pipeline-execution --name ${pl.name}`, 'Ejecución iniciada.')}>Liberar cambio</Btn>
      </PageHead>
      <Card title="Visualización">
        <div className="dt-pipe" role="group" aria-label="Etapas de la canalización">
          {states.map((x, i) => (
            <React.Fragment key={x.stage.name}>
              {i > 0 && <div className="dt-arrow" aria-hidden>→</div>}
              <div className={`dt-stage ${cls(x.se?.status)}`}>
                <h4><span>{x.stage.name}</span><Badge s={x.se?.status} /></h4>
                {x.stage.actions.map((a) => {
                  const ae = x.se?.actions.find((y) => y.name === a.name);
                  const approval = a.actionTypeId.category === 'Approval';
                  return (
                    <div key={a.name} className="dt-act">
                      <div><b>{a.name}</b> <Badge s={ae?.status} /></div>
                      <div className="dt-sub">{a.actionTypeId.provider}{ae?.summary ? ` · ${ae.summary}` : ''}</div>
                      {ae?.errorDetails && <div className="dt-sub dt-diff-del">{ae.errorDetails.code}: {ae.errorDetails.message}</div>}
                      {approval && ae?.status === 'InProgress' && ae.token && (
                        <div className="dt-row">
                          <Btn small kind="primary" onClick={() => go(`aws codepipeline put-approval-result --pipeline-name ${pl.name} --stage-name ${x.stage.name} --action-name ${a.name} --result summary=Aprobado,status=Approved --token ${ae.token}`, 'Aprobación registrada.')}>Aprobar</Btn>
                          <Btn small onClick={() => go(`aws codepipeline put-approval-result --pipeline-name ${pl.name} --stage-name ${x.stage.name} --action-name ${a.name} --result summary=Rechazado,status=Rejected --token ${ae.token}`, 'Rechazo registrado.')}>Rechazar</Btn>
                        </div>
                      )}
                    </div>
                  );
                })}
                {x.se?.status === 'Failed' && x.exec && <div className="dt-act"><Btn small onClick={() => go(`aws codepipeline retry-stage-execution --pipeline-name ${pl.name} --stage-name ${x.stage.name} --pipeline-execution-id ${x.exec!.id} --retry-mode FAILED_ACTIONS`, 'Etapa reintentada.')}>Reintentar etapa</Btn></div>}
              </div>
            </React.Fragment>
          ))}
        </div>
        <CliEquivalent cmd={`aws codepipeline get-pipeline-state --name ${pl.name}`} />
      </Card>
      <Card title="Historial de ejecuciones" count={execs.length} flush>
        <Table rows={execs} id={(e) => e.id} empty={{ title: 'Sin ejecuciones' }} cols={[
          { head: 'ID de ejecución', cell: (e) => <code>{e.id}</code>, text: (e) => e.id },
          { head: 'Estado', cell: (e) => <Badge s={e.status} />, text: (e) => e.status },
          { head: 'Disparador', cell: (e) => `${e.trigger.triggerType}: ${e.trigger.triggerDetail}`, text: (e) => e.trigger.triggerType },
          { head: 'Revisión de origen', cell: (e) => e.sourceRevisions[0]?.revisionSummary ?? '–' },
          { head: 'Inicio', cell: (e) => ts(e.start), text: (e) => String(e.start) },
        ]} />
      </Card>
      <Card title="Configuración"><Dl items={[['ARN', pl.arn], ['Rol de servicio', pl.roleArn], ['Almacén de artefactos', pl.artifactStore.location], ['Versión', String(pl.version)]]} cols={2} /></Card>
    </>
  );
}

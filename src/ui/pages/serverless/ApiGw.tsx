import React, { useState } from 'react';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, Modal, PageHead, Table, nav } from '../../components/ui';
import { ConfirmModal, Dl, run, takeFlash, setNextFlash } from '../iam/kit';
import { useSvc, link, enc, NotFound, Tabs, sq } from './common';
import { sv } from '../../../engine/serverless';
import { httpEndpoint } from '../../../engine/serverless/apigateway';

const ROOT = { label: 'API Gateway', to: '/apigateway/apis' };
type Row = { kind: 'REST' | 'HTTP'; id: string; name: string; created: string; url: string };

export function ApiList() {
  const s = useSvc();
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const [modal, setModal] = useState<null | 'create' | 'delete'>(null);
  const [kind, setKind] = useState<'HTTP' | 'REST'>('HTTP');
  const [name, setName] = useState('');
  const [fnName, setFnName] = useState('');
  const st = sv(s);
  const rows: Row[] = [
    ...st.httpApis.filter((a) => a.region === s.region).map((a) => ({ kind: 'HTTP' as const, id: a.id, name: a.name, created: a.createdDate, url: httpEndpoint(a) })),
    ...st.restApis.filter((a) => a.region === s.region).map((a) => ({ kind: 'REST' as const, id: a.id, name: a.name, created: a.createdDate, url: '' })),
  ];
  const fnArn = st.lambdas.find((f) => f.name === fnName && f.region === s.region)?.arn;
  const cmd = kind === 'HTTP'
    ? `aws apigatewayv2 create-api --name ${name || '<nombre>'} --protocol-type HTTP${fnArn ? ` --target ${fnArn}` : ''}`
    : `aws apigateway create-rest-api --name ${name || '<nombre>'}`;
  const create = async () => {
    const r = await run(cmd);
    if (!r.ok) return setErr(r.msg);
    setModal(null); setErr(''); setFlash(`Se creó la API ${name}.`); setName('');
  };
  const selRow = rows.find((r) => r.id === sel[0]);
  return (
    <>
      <Crumbs items={[ROOT, { label: 'API' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <PageHead title="API" desc="Cree, publique y administre API REST y HTTP a escala." />
      <Card title="API" count={rows.length} flush actions={<div className="sv-row"><Btn disabled={!selRow} onClick={() => setModal('delete')}>Eliminar</Btn><Btn kind="primary" onClick={() => { setErr(''); setModal('create'); }}>Crear API</Btn></div>}>
        <Table rows={rows} id={(r) => r.id} selected={sel} onSelect={(x) => setSel(x.slice(-1))} filterPlaceholder="Buscar API" empty={{ title: 'No hay API', desc: 'Cree una API HTTP para exponer una función Lambda.' }} cols={[
          { head: 'Nombre', cell: (r) => link('/apigateway/api/' + r.kind.toLowerCase() + '/' + r.id, r.name), text: (r) => r.name },
          { head: 'ID', cell: (r) => r.id, text: (r) => r.id }, { head: 'Tipo', cell: (r) => r.kind, text: (r) => r.kind },
          { head: 'Creada', cell: (r) => r.created.slice(0, 19).replace('T', ' '), text: (r) => r.created },
        ]} />
      </Card>
      {modal === 'create' && (
        <Modal title="Crear API" onClose={() => setModal(null)} footer={<><Btn onClick={() => setModal(null)}>Cancelar</Btn><Btn kind="primary" disabled={!name} onClick={create}>Crear API</Btn></>}>
          {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
          <div className="sv-form">
            <Field label="Tipo de API"><label><input type="radio" checked={kind === 'HTTP'} onChange={() => setKind('HTTP')} /> API HTTP (más simple y económica)</label><br /><label><input type="radio" checked={kind === 'REST'} onChange={() => setKind('REST')} /> API REST (control total: recursos, métodos, integraciones)</label></Field>
            <Field label="Nombre de la API"><input className="k-input" type="text" aria-label="Nombre de la API" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
            {kind === 'HTTP' && <Field label="Integración rápida con Lambda" hint="Crea una ruta $default y la etapa $default con implementación automática."><select className="k-input" aria-label="Función Lambda" value={fnName} onChange={(e) => setFnName(e.target.value)}><option value="">Sin integración</option>{st.lambdas.filter((f) => f.region === s.region).map((f) => <option key={f.name}>{f.name}</option>)}</select></Field>}
            <CliEquivalent cmd={cmd} />
          </div>
        </Modal>
      )}
      {modal === 'delete' && selRow && <ConfirmModal title="Eliminar API" confirmLabel="Eliminar" danger requireText="eliminar" onClose={() => setModal(null)} onConfirm={async () => { const r = await run(selRow.kind === 'HTTP' ? `aws apigatewayv2 delete-api --api-id ${selRow.id}` : `aws apigateway delete-rest-api --rest-api-id ${selRow.id}`); if (!r.ok) return r.msg; setFlash(`Se eliminó la API ${selRow.name}.`); setSel([]); }}>
        Se eliminará la API <b>{selRow.name}</b>. Los clientes que la usen recibirán errores.
      </ConfirmModal>}
    </>
  );
}

export function ApiDetail({ kind, id }: { kind: string; id: string }) {
  const s = useSvc();
  const [tab, setTab] = useState<'routes' | 'stages' | 'test'>('routes');
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const [path, setPath] = useState('/');
  const [method, setMethod] = useState('GET');
  const [reqBody, setReqBody] = useState('');
  const [out, setOut] = useState('');
  const [routeKey, setRouteKey] = useState('GET /hola');
  const [target, setTarget] = useState('');
  const [stage, setStage] = useState('prod');
  const st = sv(s);
  const http = kind === 'http' ? st.httpApis.find((a) => a.id === id && a.region === s.region) : undefined;
  const rest = kind === 'rest' ? st.restApis.find((a) => a.id === id && a.region === s.region) : undefined;
  if (!http && !rest) return <><Crumbs items={[ROOT]} /><NotFound what={`La API ${id} no existe en la región ${s.region}.`} /></>;
  const name = (http ?? rest)!.name;
  const stages = http ? http.stages.map((x) => x.stageName) : rest!.stages.map((x) => x.stageName);
  const base = (stg: string) => `https://${id}.execute-api.${s.region}.amazonaws.com${http && stg === '$default' ? '' : '/' + stg}`;
  const curlStage = stages[0] ?? '';
  const curlCmd = `curl -s -i -X ${method}${reqBody ? ` -d ${sq(reqBody)}` : ''} ${base(curlStage)}${path === '/' && !http ? '/' : path}`;
  const act = async (cmd: string, ok: string) => { const r = await run(cmd); if (!r.ok) return setErr(r.msg); setErr(''); setFlash(ok); };
  const lambdas = st.lambdas.filter((f) => f.region === s.region);
  const doCurl = async () => { const r = await run(curlCmd); setOut(r.out + r.err); };
  return (
    <>
      <Crumbs items={[ROOT, { label: 'API', to: '/apigateway/apis' }, { label: name }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title={`${name} (${id})`}><Btn kind="danger" onClick={async () => { if (!confirm(`¿Eliminar la API ${name}?`)) return; const r = await run(http ? `aws apigatewayv2 delete-api --api-id ${id}` : `aws apigateway delete-rest-api --rest-api-id ${id}`); if (!r.ok) return setErr(r.msg); setNextFlash(`Se eliminó la API ${name}.`); nav('/apigateway/apis'); }}>Eliminar</Btn></PageHead>
      <Card title="Detalles">
        <Dl items={[['Tipo', http ? 'API HTTP' : 'API REST'], ['ID de la API', id], ['URL de invocación', <span className="sv-url" key="u">{http ? httpEndpoint(http) : `https://${id}.execute-api.${s.region}.amazonaws.com/<etapa>`}</span>]]} />
      </Card>
      <Tabs cur={tab} onChange={setTab} tabs={[['routes', http ? 'Rutas e integraciones' : 'Recursos y métodos'], ['stages', 'Etapas'], ['test', 'Probar con curl']]} />
      {tab === 'routes' && http && (
        <>
          <Card title="Rutas" count={http.routes.length} flush>
            <Table rows={http.routes} id={(r) => r.id} empty={{ title: 'No hay rutas' }} cols={[
              { head: 'Clave de ruta', cell: (r) => r.routeKey, text: (r) => r.routeKey }, { head: 'Destino', cell: (r) => { const i = http.integrations.find((x) => `integrations/${x.id}` === r.target); return i ? <span className="sv-url">{i.uri.split(':').pop()}</span> : '-'; } },
              { head: 'Acciones', cell: (r) => <Btn small onClick={() => act(`aws apigatewayv2 delete-route --api-id ${id} --route-id ${r.id}`, 'Ruta eliminada.')}>Eliminar</Btn> },
            ]} />
          </Card>
          <Card title="Agregar ruta con integración Lambda">
            <div className="sv-form sv-grid2">
              <Field label="Clave de ruta" hint="Por ejemplo GET /pedidos o $default"><input className="k-input" type="text" aria-label="Clave de ruta" value={routeKey} onChange={(e) => setRouteKey(e.target.value)} /></Field>
              <Field label="Función Lambda"><select className="k-input" aria-label="Función Lambda de la ruta" value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Seleccione una función</option>{lambdas.map((f) => <option key={f.name} value={f.arn}>{f.name}</option>)}</select></Field>
            </div>
            <div className="sv-row"><Btn kind="primary" disabled={!target || !routeKey} onClick={async () => {
              const i = await run(`aws apigatewayv2 create-integration --api-id ${id} --integration-type AWS_PROXY --integration-uri ${target} --payload-format-version 2.0`);
              if (!i.ok) return setErr(i.msg);
              const r = await run(`aws apigatewayv2 create-route --api-id ${id} --route-key ${sq(routeKey)} --target integrations/${i.json.IntegrationId}`);
              if (!r.ok) return setErr(r.msg); setErr(''); setFlash('Se creó la ruta. Recuerde que Lambda necesita un permiso (add-permission) para que API Gateway pueda invocarla.');
            }}>Crear ruta</Btn></div>
            <CliEquivalent cmd={`aws apigatewayv2 create-integration --api-id ${id} --integration-type AWS_PROXY --integration-uri ${target || '<arn-lambda>'} --payload-format-version 2.0\naws apigatewayv2 create-route --api-id ${id} --route-key ${sq(routeKey)} --target integrations/<id-integración>`} />
          </Card>
        </>
      )}
      {tab === 'routes' && rest && (
        <Card title="Recursos" count={rest.resources.length} flush>
          <Table rows={rest.resources} id={(r) => r.id} empty={{ title: 'Sin recursos' }} cols={[
            { head: 'Ruta', cell: (r) => r.path, text: (r) => r.path }, { head: 'ID', cell: (r) => r.id },
            { head: 'Métodos', cell: (r) => Object.values(r.methods).map((m) => <span className="sv-badge" key={m.httpMethod} title={m.integration ? `${m.integration.type} ${m.integration.uri ?? ''}` : 'Sin integración'}>{m.httpMethod} · {m.integration?.type ?? 'sin integración'}</span>) },
          ]} />
        </Card>
      )}
      {tab === 'stages' && (
        <>
          <Card title="Etapas" count={stages.length} flush actions={<div className="sv-row"><input className="k-input" style={{ width: 130 }} aria-label="Nombre de la etapa" value={stage} onChange={(e) => setStage(e.target.value)} />
            <Btn kind="primary" disabled={!stage} onClick={() => act(http ? `aws apigatewayv2 create-stage --api-id ${id} --stage-name ${stage} --auto-deploy` : `aws apigateway create-deployment --rest-api-id ${id} --stage-name ${stage}`, http ? `Se creó la etapa ${stage}.` : `Se implementó la API en la etapa ${stage}.`)}>{http ? 'Crear etapa' : 'Implementar API'}</Btn></div>}>
            <Table rows={stages} id={(x) => x} empty={{ title: 'No hay etapas', desc: 'Sin una etapa implementada la API no es accesible.' }} cols={[
              { head: 'Etapa', cell: (x) => x }, { head: 'URL de invocación', cell: (x) => <span className="sv-url">{base(x)}</span> },
            ]} />
          </Card>
          <CliEquivalent cmd={http ? `aws apigatewayv2 create-stage --api-id ${id} --stage-name ${stage} --auto-deploy` : `aws apigateway create-deployment --rest-api-id ${id} --stage-name ${stage}`} />
        </>
      )}
      {tab === 'test' && (
        <Card title="Invocar la API" actions={<Btn kind="primary" disabled={!curlStage} onClick={doCurl}>Enviar solicitud</Btn>}>
          {!curlStage && <Flash kind="info">Esta API no tiene ninguna etapa implementada, así que no se puede invocar.</Flash>}
          <div className="sv-form sv-grid2">
            <Field label="Método"><select className="k-input" aria-label="Método HTTP" value={method} onChange={(e) => setMethod(e.target.value)}>{['GET', 'POST', 'PUT', 'DELETE'].map((m) => <option key={m}>{m}</option>)}</select></Field>
            <Field label="Ruta"><input className="k-input" type="text" aria-label="Ruta" value={path} onChange={(e) => setPath(e.target.value)} /></Field>
          </div>
          {method !== 'GET' && <Field label="Cuerpo"><textarea className="sv-code sm" aria-label="Cuerpo de la solicitud" value={reqBody} onChange={(e) => setReqBody(e.target.value)} /></Field>}
          <CliEquivalent cmd={curlCmd} />
          {out && <pre className="sv-pre" style={{ marginTop: 10 }} aria-label="Respuesta">{out}</pre>}
        </Card>
      )}
    </>
  );
}

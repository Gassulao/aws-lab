import React, { useEffect, useState } from 'react';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, Modal, PageHead, Table, nav } from '../../components/ui';
import { ConfirmModal, Dl, run, takeFlash, setNextFlash } from '../iam/kit';
import { useSvc, link, enc, when, St, NotFound, Tabs, putFile, readFile, sq, roleName, DEFAULT_CODE } from './common';
import { sv } from '../../../engine/serverless';
import * as L from '../../../engine/serverless/lambda';
import type { LambdaFn } from '../../../engine/serverless/types';
import type { CloudState } from '../../../engine/types';

const ROOT = { label: 'AWS Lambda', to: '/lambda/functions' };
const b64d = (s: string) => { try { return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))); } catch { return s; } };
const lambdaRoles = (s: CloudState) => s.roles.filter((r) => JSON.stringify(r.assumeRolePolicy).includes('lambda.amazonaws.com'));

/** Rutas del paquete de código dentro del shell (sin escribir nada: se usa también para mostrar el comando). */
function zipPaths(name: string, handler: string) {
  const file = handler.split('.')[0] + '.js';
  const dir = `/tmp/ui/${name}`;
  return { zip: `zip -j ${dir}/function.zip ${dir}/${file}`, path: `${dir}/function.zip`, rel: `${name}/${file}` };
}
/** Escribe el código en el shell y devuelve el comando que lo empaqueta. */
function zipCode(name: string, handler: string, code: string) {
  const z = zipPaths(name, handler);
  putFile(z.rel, code);
  return z;
}

export function LambdaList() {
  const s = useSvc();
  const [flash, setFlash] = useState(takeFlash);
  const [sel, setSel] = useState<string[]>([]);
  const [del, setDel] = useState(false);
  const fns = sv(s).lambdas.filter((f) => f.region === s.region);
  return (
    <>
      <Crumbs items={[ROOT, { label: 'Funciones' }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      <PageHead title="Funciones" desc="Ejecute código sin aprovisionar ni administrar servidores. Solo paga por el tiempo de cómputo que consume." />
      <Card title="Funciones" count={fns.length} flush actions={<div className="sv-row"><Btn disabled={sel.length !== 1} onClick={() => setDel(true)}>Eliminar</Btn><Btn kind="primary" onClick={() => nav('/lambda/create')}>Crear función</Btn></div>}>
        <Table rows={fns} id={(f) => f.name} selected={sel} onSelect={(x) => setSel(x.slice(-1))} filterPlaceholder="Filtrar por nombre" empty={{ title: 'No hay funciones', desc: 'Cree una función para ejecutar código en respuesta a eventos.' }} cols={[
          { head: 'Nombre de la función', cell: (f) => link('/lambda/function/' + enc(f.name), f.name), text: (f) => f.name },
          { head: 'Estado', cell: (f) => <St v={L.fnState(f)} />, text: (f) => L.fnState(f) },
          { head: 'Tiempo de ejecución', cell: (f) => f.runtime, text: (f) => f.runtime },
          { head: 'Memoria (MB)', cell: (f) => f.memory, text: (f) => String(f.memory) },
          { head: 'Tiempo de espera', cell: (f) => f.timeout + ' s', text: (f) => String(f.timeout) },
          { head: 'Última modificación', cell: (f) => f.lastModified.slice(0, 19).replace('T', ' '), text: (f) => f.lastModified },
        ]} />
      </Card>
      {del && sel[0] && <ConfirmModal title="Eliminar función" confirmLabel="Eliminar" danger requireText="eliminar" onClose={() => setDel(false)} onConfirm={async () => { const r = await run(`aws lambda delete-function --function-name ${sel[0]}`); if (!r.ok) return r.msg; setFlash(`Se eliminó la función ${sel[0]}.`); setSel([]); }}>
        Se eliminará la función <b>{sel[0]}</b>, todas sus versiones y alias. Esta acción no se puede deshacer.
      </ConfirmModal>}
    </>
  );
}

export function LambdaCreate() {
  const s = useSvc();
  const roles = lambdaRoles(s);
  const [name, setName] = useState('');
  const [runtime, setRuntime] = useState('nodejs20.x');
  const [handler, setHandler] = useState('index.handler');
  const [role, setRole] = useState(roles[0]?.arn ?? '');
  const [timeout, setTimeoutS] = useState(3);
  const [memory, setMemory] = useState(128);
  const [code, setCode] = useState(DEFAULT_CODE);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!role && roles[0]) setRole(roles[0].arn); }, [roles.length]);
  const zip = zipPaths(name || '<nombre>', handler);
  const cmd = `${zip.zip}\naws lambda create-function --function-name ${name || '<nombre>'} --runtime ${runtime} --handler ${handler} --role ${role || '<arn-del-rol>'} --timeout ${timeout} --memory-size ${memory} --zip-file fileb://${zip.path}`;
  const valid = /^[a-zA-Z0-9_-]{1,64}$/.test(name) && !!role;
  const create = async () => {
    setBusy(true); setErr('');
    const z = zipCode(name, handler, code);
    const a = await run(z.zip);
    if (!a.ok) { setBusy(false); return setErr(a.msg); }
    const r = await run(`aws lambda create-function --function-name ${name} --runtime ${runtime} --handler ${handler} --role ${role} --timeout ${timeout} --memory-size ${memory} --zip-file fileb://${z.path}`);
    setBusy(false);
    if (!r.ok) return setErr(r.msg);
    setNextFlash(`Se creó correctamente la función ${name}. Ahora puede probarla.`);
    nav('/lambda/function/' + enc(name));
  };
  return (
    <>
      <Crumbs items={[ROOT, { label: 'Funciones', to: '/lambda/functions' }, { label: 'Crear función' }]} />
      <PageHead title="Crear función" desc="Cree una función desde cero con su propio código y un rol de ejecución." />
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <Card title="Información básica">
        <div className="sv-form">
          <Field label="Nombre de la función" hint="Hasta 64 caracteres: letras, números, guiones y guiones bajos."><input className="k-input" type="text" aria-label="Nombre de la función" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <div className="sv-grid2">
            <Field label="Tiempo de ejecución"><select className="k-input" aria-label="Tiempo de ejecución" value={runtime} onChange={(e) => setRuntime(e.target.value)}>{L.RUNTIMES.map((r) => <option key={r}>{r}</option>)}</select></Field>
            <Field label="Controlador" hint="archivo.función, por ejemplo index.handler"><input className="k-input" type="text" aria-label="Controlador" value={handler} onChange={(e) => setHandler(e.target.value)} /></Field>
          </div>
          <Field label="Rol de ejecución" hint="El rol que Lambda asume para ejecutar su código. Debe confiar en lambda.amazonaws.com.">
            <select className="k-input" aria-label="Rol de ejecución" value={role} onChange={(e) => setRole(e.target.value)}>
              {roles.length === 0 && <option value="">No hay roles para Lambda: créelo en IAM</option>}
              {roles.map((r) => <option key={r.arn} value={r.arn}>{r.name}</option>)}
            </select>
          </Field>
          <div className="sv-grid2">
            <Field label="Tiempo de espera (segundos)"><input className="k-input" type="number" min={1} max={900} aria-label="Tiempo de espera" value={timeout} onChange={(e) => setTimeoutS(Number(e.target.value))} /></Field>
            <Field label="Memoria (MB)"><input className="k-input" type="number" min={128} max={10240} aria-label="Memoria" value={memory} onChange={(e) => setMemory(Number(e.target.value))} /></Field>
          </div>
        </div>
      </Card>
      <Card title="Código fuente">
        <textarea className="sv-code" aria-label="Código fuente" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />
        <CliEquivalent cmd={cmd} />
      </Card>
      <div className="sv-row" style={{ justifyContent: 'flex-end' }}><Btn onClick={() => nav('/lambda/functions')}>Cancelar</Btn><Btn kind="primary" disabled={!valid || busy} onClick={create}>Crear función</Btn></div>
    </>
  );
}

type Tab = 'code' | 'config' | 'versions' | 'triggers' | 'monitor';

export function LambdaDetail({ name }: { name: string }) {
  const s = useSvc();
  const [tab, setTab] = useState<Tab>('code');
  const [flash, setFlash] = useState(takeFlash);
  const [err, setErr] = useState('');
  const fn = sv(s).lambdas.find((f) => f.name === name && f.region === s.region);
  if (!fn) return <><Crumbs items={[ROOT]} /><NotFound what={`La función ${name} no existe en la región ${s.region}.`} /></>;
  return (
    <>
      <Crumbs items={[ROOT, { label: 'Funciones', to: '/lambda/functions' }, { label: fn.name }]} />
      {flash && <Flash kind="ok" onClose={() => setFlash('')}>{flash}</Flash>}
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <PageHead title={fn.name}><Btn kind="danger" onClick={async () => { if (!confirm(`¿Eliminar la función ${fn.name}?`)) return; const r = await run(`aws lambda delete-function --function-name ${fn.name}`); if (!r.ok) return setErr(r.msg); setNextFlash(`Se eliminó la función ${fn.name}.`); nav('/lambda/functions'); }}>Eliminar</Btn></PageHead>
      <Card title="Información general">
        <Dl items={[['Descripción', fn.description || '-'], ['Estado', <St key="st" v={L.fnState(fn)} />], ['Última modificación', fn.lastModified.slice(0, 19).replace('T', ' ')], ['ARN de la función', <span className="sv-url" key="a">{fn.arn}</span>], ['Tiempo de ejecución', fn.runtime], ['URL de la función', fn.url ? <span className="sv-url" key="u">{fn.url.url}</span> : '-']]} />
      </Card>
      <Tabs cur={tab} onChange={setTab} tabs={[['code', 'Código y prueba'], ['config', 'Configuración'], ['versions', 'Versiones y alias'], ['triggers', 'Desencadenadores'], ['monitor', 'Supervisión']]} />
      {tab === 'code' && <CodeTab s={s} fn={fn} setFlash={setFlash} setErr={setErr} />}
      {tab === 'config' && <ConfigTab s={s} fn={fn} setFlash={setFlash} setErr={setErr} />}
      {tab === 'versions' && <VersionsTab fn={fn} setFlash={setFlash} setErr={setErr} />}
      {tab === 'triggers' && <TriggersTab s={s} fn={fn} setFlash={setFlash} setErr={setErr} />}
      {tab === 'monitor' && <MonitorTab s={s} fn={fn} />}
    </>
  );
}

interface TabProps { s: CloudState; fn: LambdaFn; setFlash: (m: string) => void; setErr: (m: string) => void }

function CodeTab({ fn, setFlash, setErr }: TabProps) {
  const file = fn.handler.split('.')[0] + '.js';
  const [code, setCode] = useState(fn.files[file] ?? Object.values(fn.files)[0] ?? '');
  const [event, setEvent] = useState('{\n  "nombre": "Ana"\n}');
  const [res, setRes] = useState<null | { status: string; fnErr?: string; payload: string; log: string }>(null);
  const [busy, setBusy] = useState(false);
  const z = zipPaths(fn.name, fn.handler);
  const deployCmd = `${z.zip}\naws lambda update-function-code --function-name ${fn.name} --zip-file fileb://${z.path}`;
  const outPath = `/tmp/ui/${fn.name}/response.json`;
  const invokeCmd = `aws lambda invoke --function-name ${fn.name} --cli-binary-format raw-in-base64-out --payload ${sq(event.replace(/\s*\n\s*/g, ' '))} --log-type Tail ${outPath}`;
  const deploy = async () => {
    zipCode(fn.name, fn.handler, code);
    const a = await run(z.zip); if (!a.ok) return setErr(a.msg);
    const r = await run(`aws lambda update-function-code --function-name ${fn.name} --zip-file fileb://${z.path}`);
    if (!r.ok) return setErr(r.msg);
    setErr(''); setFlash('Se actualizó el código de la función.');
  };
  const test = async () => {
    setBusy(true); setErr('');
    putFile(`${fn.name}/.keep`, '');
    const r = await run(invokeCmd);
    setBusy(false);
    if (!r.ok) return setErr(r.msg);
    setRes({ status: String(r.json?.StatusCode ?? ''), fnErr: r.json?.FunctionError, payload: readFile(outPath), log: r.json?.LogResult ? b64d(r.json.LogResult) : '' });
  };
  return (
    <>
      <Card title="Código fuente" actions={<Btn kind="primary" onClick={deploy}>Implementar</Btn>}>
        <div className="sv-muted" style={{ marginBottom: 6 }}>{file} · controlador <code>{fn.handler}</code></div>
        <textarea className="sv-code" aria-label="Editor de código" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />
        <CliEquivalent cmd={deployCmd} />
      </Card>
      <Card title="Probar" actions={<Btn kind="primary" disabled={busy} onClick={test}>Probar</Btn>}>
        <Field label="Evento JSON"><textarea className="sv-code sm" aria-label="Evento de prueba" spellCheck={false} value={event} onChange={(e) => setEvent(e.target.value)} /></Field>
        <CliEquivalent cmd={invokeCmd} />
        {res && (
          <div className="sv-result" aria-label="Resultado de la ejecución">
            <header><span>Resultado de la ejecución: {res.fnErr ? <span style={{ color: 'var(--err)' }}>con errores</span> : <span style={{ color: 'var(--ok)' }}>correcto</span>}</span><span className="sv-muted">StatusCode {res.status}</span></header>
            <div>
              <h4>Respuesta</h4><pre className="sv-pre">{res.payload}</pre>
              {res.log && <><h4>Registros de la función</h4><pre className="sv-pre">{res.log}</pre></>}
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

function ConfigTab({ s, fn, setFlash, setErr }: TabProps) {
  const [timeout, setT] = useState(fn.timeout);
  const [memory, setM] = useState(fn.memory);
  const [role, setR] = useState(fn.role);
  const [env, setEnv] = useState(Object.entries(fn.env).map(([k, v]) => `${k}=${v}`).join('\n'));
  const roles = lambdaRoles(s);
  const vars = env.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split('=')).filter((p) => p[0]);
  const envArg = vars.length ? `Variables={${vars.map(([k, ...v]) => `${k}=${v.join('=')}`).join(',')}}` : 'Variables={}';
  const cmd = `aws lambda update-function-configuration --function-name ${fn.name} --timeout ${timeout} --memory-size ${memory} --role ${role} --environment ${sq(envArg)}`;
  const save = async () => { const r = await run(cmd); if (!r.ok) return setErr(r.msg); setErr(''); setFlash('Se actualizó la configuración de la función.'); };
  return (
    <Card title="Configuración general" actions={<Btn kind="primary" onClick={save}>Guardar</Btn>}>
      <div className="sv-form">
        <div className="sv-grid2">
          <Field label="Memoria (MB)"><input className="k-input" type="number" aria-label="Memoria" value={memory} onChange={(e) => setM(Number(e.target.value))} /></Field>
          <Field label="Tiempo de espera (segundos)"><input className="k-input" type="number" aria-label="Tiempo de espera" value={timeout} onChange={(e) => setT(Number(e.target.value))} /></Field>
        </div>
        <Field label="Rol de ejecución"><select className="k-input" aria-label="Rol de ejecución" value={role} onChange={(e) => setR(e.target.value)}>{!roles.some((r) => r.arn === role) && <option value={role}>{roleName(role)}</option>}{roles.map((r) => <option key={r.arn} value={r.arn}>{r.name}</option>)}</select></Field>
        <Field label="Variables de entorno" hint="Una por línea con el formato CLAVE=valor."><textarea className="sv-code sm" aria-label="Variables de entorno" spellCheck={false} value={env} onChange={(e) => setEnv(e.target.value)} /></Field>
      </div>
      <CliEquivalent cmd={cmd} />
    </Card>
  );
}

function VersionsTab({ fn, setFlash, setErr }: Omit<TabProps, 's'>) {
  const [alias, setAlias] = useState('');
  const [ver, setVer] = useState('');
  const act = async (cmd: string, ok: string) => { const r = await run(cmd); if (!r.ok) return setErr(r.msg); setErr(''); setFlash(ok); };
  const cmdA = `aws lambda create-alias --function-name ${fn.name} --name ${alias || '<alias>'} --function-version ${ver || '<versión>'}`;
  return (
    <>
      <Card title="Versiones" count={fn.versions.length + 1} flush actions={<Btn onClick={() => act(`aws lambda publish-version --function-name ${fn.name}`, 'Se publicó una nueva versión.')}>Publicar nueva versión</Btn>}>
        <Table rows={[{ version: '$LATEST', lastModified: fn.lastModified, description: '' }, ...[...fn.versions].reverse()]} id={(v) => v.version} empty={{ title: 'Sin versiones' }} cols={[
          { head: 'Versión', cell: (v) => v.version, text: (v) => v.version }, { head: 'Descripción', cell: (v) => v.description || '-' }, { head: 'Modificada', cell: (v) => v.lastModified.slice(0, 19).replace('T', ' ') },
        ]} />
      </Card>
      <Card title="Alias" count={fn.aliases.length} flush actions={<div className="sv-row"><input className="k-input" style={{ width: 130 }} placeholder="Alias" aria-label="Nombre del alias" value={alias} onChange={(e) => setAlias(e.target.value)} /><input className="k-input" style={{ width: 90 }} placeholder="Versión" aria-label="Versión del alias" value={ver} onChange={(e) => setVer(e.target.value)} /><Btn kind="primary" disabled={!alias || !ver} onClick={() => act(cmdA, `Se creó el alias ${alias}.`)}>Crear alias</Btn></div>}>
        <Table rows={fn.aliases} id={(a) => a.name} empty={{ title: 'No hay alias', desc: 'Un alias apunta a una versión y se puede mover sin cambiar a los llamadores.' }} cols={[
          { head: 'Alias', cell: (a) => a.name, text: (a) => a.name }, { head: 'Versión', cell: (a) => a.version },
          { head: 'Ponderación', cell: (a) => (a.routing ? Object.entries(a.routing).map(([v, w]) => `v${v}: ${Math.round(w * 100)}%`).join(', ') : '-') },
          { head: 'Acciones', cell: (a) => <Btn small onClick={() => act(`aws lambda delete-alias --function-name ${fn.name} --name ${a.name}`, `Se eliminó el alias ${a.name}.`)}>Eliminar</Btn> },
        ]} />
      </Card>
      <CliEquivalent cmd={cmdA} />
    </>
  );
}

function TriggersTab({ s, fn, setFlash, setErr }: TabProps) {
  const maps = sv(s).mappings.filter((m) => m.functionName === fn.name && m.region === fn.region);
  const queues = sv(s).queues.filter((q) => q.region === s.region);
  const [qArn, setQArn] = useState('');
  const [batch, setBatch] = useState(10);
  const act = async (cmd: string, ok: string) => { const r = await run(cmd); if (!r.ok) return setErr(r.msg); setErr(''); setFlash(ok); };
  const cmd = `aws lambda create-event-source-mapping --function-name ${fn.name} --event-source-arn ${qArn || '<arn-de-la-cola>'} --batch-size ${batch}`;
  return (
    <>
      <Card title="Orígenes de eventos de SQS" count={maps.length} flush actions={<div className="sv-row"><select className="k-input" style={{ width: 220 }} aria-label="Cola SQS" value={qArn} onChange={(e) => setQArn(e.target.value)}><option value="">Seleccione una cola</option>{queues.map((q) => <option key={q.arn} value={q.arn}>{q.name}</option>)}</select><input className="k-input" type="number" style={{ width: 80 }} aria-label="Tamaño del lote" value={batch} onChange={(e) => setBatch(Number(e.target.value))} /><Btn kind="primary" disabled={!qArn} onClick={() => act(cmd, 'Se creó el mapeo de origen de eventos.')}>Agregar desencadenador</Btn></div>}>
        <Table rows={maps} id={(m) => m.uuid} empty={{ title: 'Sin desencadenadores', desc: 'Conecte una cola SQS para que Lambda procese sus mensajes.' }} cols={[
          { head: 'UUID', cell: (m) => m.uuid }, { head: 'Origen', cell: (m) => m.eventSourceArn.split(':').pop() }, { head: 'Lote', cell: (m) => m.batchSize },
          { head: 'Estado', cell: (m) => <St v={m.enabled ? 'Enabled' : 'Disabled'} /> }, { head: 'Último resultado', cell: (m) => m.lastProcessingResult },
          { head: 'Acciones', cell: (m) => <Btn small onClick={() => act(`aws lambda delete-event-source-mapping --uuid ${m.uuid}`, 'Se eliminó el desencadenador.')}>Eliminar</Btn> },
        ]} />
      </Card>
      <CliEquivalent cmd={cmd} />
      <Card title="URL de la función" actions={fn.url ? <Btn onClick={() => act(`aws lambda delete-function-url-config --function-name ${fn.name}`, 'Se eliminó la URL de la función.')}>Eliminar URL</Btn> : <Btn onClick={() => act(`aws lambda create-function-url-config --function-name ${fn.name} --auth-type NONE`, 'Se creó la URL de la función.')}>Crear URL (sin autenticación)</Btn>}>
        {fn.url ? <div className="sv-url">{fn.url.url}</div> : <span className="sv-muted">No hay URL de función. Cree una para invocar la función por HTTPS.</span>}
      </Card>
      <Card title="Permisos basados en recursos" count={fn.permissions.length} flush>
        <Table rows={fn.permissions} id={(p) => p.sid} empty={{ title: 'Sin permisos', desc: 'Otros servicios (API Gateway, SNS, S3) necesitan una política para invocar la función. Use aws lambda add-permission.' }} cols={[
          { head: 'ID de la instrucción', cell: (p) => p.sid }, { head: 'Principal', cell: (p) => p.principal }, { head: 'Acción', cell: (p) => p.action }, { head: 'ARN de origen', cell: (p) => <span className="sv-url">{p.sourceArn ?? '-'}</span> },
        ]} />
      </Card>
    </>
  );
}

function MonitorTab({ s, fn }: { s: CloudState; fn: LambdaFn }) {
  const rows = sv(s).invokes.filter((i) => i.fn === fn.name && i.region === fn.region).slice(-20).reverse();
  const group = s.logGroups.find((g) => g.name === `/aws/lambda/${fn.name}`);
  return (
    <>
      <Card title="Métricas"><Dl items={[['Invocaciones', fn.stats.invocations], ['Errores', fn.stats.errors], ['Limitaciones', fn.stats.throttles]]} /></Card>
      <Card title="Invocaciones recientes" count={rows.length} flush>
        <Table rows={rows} id={(r) => r.requestId} empty={{ title: 'Sin invocaciones' }} cols={[
          { head: 'Hora', cell: (r) => when(r.ts) }, { head: 'ID de solicitud', cell: (r) => <span className="sv-url">{r.requestId}</span> }, { head: 'Resultado', cell: (r) => (r.ok ? <span style={{ color: 'var(--ok)' }}>Correcto</span> : <span style={{ color: 'var(--err)' }}>Error</span>) },
          { head: 'Duración', cell: (r) => r.durationMs + ' ms' }, { head: 'Memoria usada', cell: (r) => r.memoryUsed + ' MB' }, { head: 'Origen', cell: (r) => r.source },
        ]} />
      </Card>
      <Card title="Registros en CloudWatch Logs">
        {group ? <>Grupo de registros <a onClick={() => nav('/cloudwatch/log-group/' + encodeURIComponent(group.name))}>{group.name}</a></> : <span className="sv-muted">Todavía no existe el grupo /aws/lambda/{fn.name}. Lambda lo crea al invocar la función, siempre que el rol de ejecución tenga los permisos de logs (AWSLambdaBasicExecutionRole).</span>}
      </Card>
    </>
  );
}

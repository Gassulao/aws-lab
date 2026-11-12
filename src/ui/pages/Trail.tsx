import React, { useMemo, useState } from 'react';
import { useCloud } from '../session';
import { Btn, Card, Crumbs, Flash, PageHead, Status, Table, nav, fmtDate } from '../components/ui';
import type { CloudState, TrailEvent } from '../../engine/types';
import './trail/trail.css';
import { CreateTrail, TrailDetail, TrailsList } from './trail/Trails';

const ATTRS: { id: string; label: string; get: (e: TrailEvent) => string[] }[] = [
  { id: 'EventName', label: 'Nombre del evento', get: (e) => [e.eventName] },
  { id: 'Username', label: 'Nombre de usuario', get: (e) => [e.userName] },
  { id: 'EventSource', label: 'Origen del evento', get: (e) => [e.eventSource] },
  { id: 'ResourceName', label: 'Nombre del recurso', get: (e) => e.resources.map((r) => r.name) },
  { id: 'ResourceType', label: 'Tipo de recurso', get: (e) => e.resources.map((r) => r.type) },
  { id: 'ReadOnly', label: 'Solo lectura', get: (e) => [String(e.readOnly)] },
  { id: 'EventId', label: 'ID del evento', get: (e) => [e.id] },
  { id: 'ErrorCode', label: 'Código de error', get: (e) => (e.errorCode ? [e.errorCode] : []) },
];
const RANGES: { id: string; label: string; ms: number }[] = [
  { id: '30m', label: 'Últimos 30 minutos', ms: 30 * 60e3 }, { id: '1h', label: 'Última hora', ms: 3600e3 }, { id: '3h', label: 'Últimas 3 horas', ms: 3 * 3600e3 },
  { id: '12h', label: 'Últimas 12 horas', ms: 12 * 3600e3 }, { id: '1d', label: 'Último día', ms: 86400e3 }, { id: '7d', label: 'Últimos 7 días', ms: 7 * 86400e3 },
  { id: '90d', label: 'Últimos 90 días', ms: 90 * 86400e3 }, { id: 'custom', label: 'Personalizado', ms: 0 },
];

const resType = (e: TrailEvent) => e.resources[0]?.type ?? '-';
const resName = (e: TrailEvent) => e.resources[0]?.name ?? '-';

/** Documento CloudTrail completo del evento (el «Registro de eventos» de la consola real). */
export function eventRecord(s: CloudState, e: TrailEvent) {
  const arnUser = e.principalArn.split('/').pop() ?? e.userName;
  const isRoot = e.principalArn.endsWith(':root');
  const isRole = e.principalArn.includes(':assumed-role/');
  const user = s.users.find((u) => u.name === e.userName);
  return {
    eventVersion: '1.09',
    userIdentity: {
      type: isRoot ? 'Root' : isRole ? 'AssumedRole' : 'IAMUser',
      principalId: user?.id ?? 'AIDAEXAMPLE',
      arn: e.principalArn,
      accountId: s.account.id,
      accessKeyId: user?.accessKeys?.[0]?.id,
      userName: isRoot ? undefined : arnUser,
    },
    eventTime: e.time.replace(/\.\d+Z$/, 'Z'),
    eventSource: e.eventSource,
    eventName: e.eventName,
    awsRegion: e.region,
    sourceIPAddress: e.sourceIp,
    userAgent: 'aws-cli/2.17.0 md/awscrt#0.20.11 ua/2.0 os/linux#6.1 lang/python#3.11.8',
    requestParameters: e.requestParameters ?? null,
    responseElements: e.errorCode ? null : undefined,
    ...(e.errorCode ? { errorCode: e.errorCode, errorMessage: e.errorMessage } : {}),
    requestID: e.id.toUpperCase(),
    eventID: e.id,
    readOnly: e.readOnly,
    eventType: 'AwsApiCall',
    managementEvent: true,
    recipientAccountId: s.account.id,
    eventCategory: 'Management',
    ...(e.resources.length ? { resources: e.resources.map((r) => ({ type: r.type, ARN: r.name })) } : {}),
  };
}

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;
function Json({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  let last = 0, k = 0;
  for (const m of text.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    if (m[1] !== undefined) out.push(<span key={k++} className={m[2] ? 'k' : 's'}>{m[1]}</span>, m[2] ?? '');
    else out.push(<span key={k++} className={m[3] ? 'l' : 'n'}>{m[0]}</span>);
    last = i + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

const download = (name: string, mime: string, body: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

export function TrailPage() {
  const parts = decodeURIComponent(location.hash.replace(/^#/, '').split('?')[0]).split('/');
  if (parts[2] === 'trails') return parts[3] === 'create' ? <CreateTrail /> : <TrailsList />;
  if (parts[2] === 'trail') return <TrailDetail key={parts[3]} name={parts[3] ?? ''} />;
  const id = parts[3];
  return id ? <EventDetail id={id} /> : <EventHistory />;
}

function EventHistory() {
  const s = useCloud();
  const [attr, setAttr] = useState('EventName');
  const [value, setValue] = useState('');
  const [range, setRange] = useState('1d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [allRegions, setAllRegions] = useState(false);
  const [errOnly, setErrOnly] = useState(false);
  const [tick, setTick] = useState(0);
  const [menu, setMenu] = useState(false);

  const rows = useMemo(() => {
    const now = Date.now();
    const r = RANGES.find((x) => x.id === range)!;
    const t0 = range === 'custom' ? (from ? new Date(from).getTime() : 0) : now - r.ms;
    const t1 = range === 'custom' ? (to ? new Date(to).getTime() : now) : now;
    const a = ATTRS.find((x) => x.id === attr)!;
    const v = value.trim().toLowerCase();
    return s.trail
      .filter((e) => {
        const t = new Date(e.time).getTime();
        if (t < t0 || t > t1) return false;
        if (!allRegions && e.region !== s.region) return false;
        if (errOnly && !e.errorCode) return false;
        if (v && !a.get(e).some((x) => x.toLowerCase() === v || x.toLowerCase().includes(v))) return false;
        return true;
      })
      .reverse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.trail.length, s.region, attr, value, range, from, to, allRegions, errOnly, tick]);
  const suggestions = useMemo(() => [...new Set(s.trail.flatMap((e) => ATTRS.find((x) => x.id === attr)!.get(e)))].slice(0, 80), [s.trail.length, attr]);
  const elsewhere = !allRegions && s.trail.filter((e) => e.region !== s.region).length;

  const csv = () => {
    const q = (x: string) => `"${String(x).replace(/"/g, '""')}"`;
    const head = ['Event ID', 'Event name', 'Event time', 'User name', 'Event source', 'Resource type', 'Resource name', 'Error code'];
    download('cloudtrail-eventos.csv', 'text/csv', [head.map(q).join(','), ...rows.map((e) => [e.id, e.eventName, e.time, e.userName, e.eventSource, resType(e), resName(e), e.errorCode ?? ''].map(q).join(','))].join('\n'));
  };
  const json = () => download('cloudtrail-eventos.json', 'application/json', JSON.stringify(rows.map((e) => eventRecord(s, e)), null, 2));

  return (
    <>
      <Crumbs items={[{ label: 'CloudTrail', to: '/cloudtrail/events' }, { label: 'Historial de eventos' }]} />
      <PageHead title="Historial de eventos" desc="El historial de eventos muestra los eventos de administración de los últimos 90 días: cada llamada a la API de su cuenta, correcta o fallida.">
        <div className="vp-menu" style={{ position: 'relative' }}>
          <Btn onClick={() => setMenu(!menu)}>Descargar eventos ▾</Btn>
          {menu && (
            <div style={{ position: 'absolute', right: 0, top: 36, minWidth: 190, background: 'var(--card)', border: '1px solid var(--line2)', boxShadow: '0 4px 12px rgba(0,0,0,.25)', zIndex: 30 }}>
              {[['Descargar como CSV', csv], ['Descargar como JSON', json]].map(([l, f]) => (
                <div key={l as string} style={{ padding: '8px 14px', cursor: 'pointer' }} onClick={() => { (f as () => void)(); setMenu(false); }}>{l as string}</div>
              ))}
            </div>
          )}
        </div>
      </PageHead>
      <Card title="Eventos" count={rows.length} flush actions={<Btn onClick={() => setTick(tick + 1)}>Actualizar</Btn>}>
        <div className="ct-filter">
          <div><label htmlFor="ct-attr">Atributos de búsqueda</label>
            <select id="ct-attr" value={attr} onChange={(e) => { setAttr(e.target.value); setValue(''); }}>{ATTRS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></div>
          <div className="grow"><label htmlFor="ct-val">Introduzca un valor</label>
            <input id="ct-val" type="text" list="ct-sug" placeholder={`Filtrar por ${ATTRS.find((a) => a.id === attr)!.label.toLowerCase()}`} value={value} onChange={(e) => setValue(e.target.value)} />
            <datalist id="ct-sug">{suggestions.map((x) => <option key={x} value={x} />)}</datalist></div>
          <div><label htmlFor="ct-range">Intervalo de tiempo</label>
            <select id="ct-range" value={range} onChange={(e) => setRange(e.target.value)}>{RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select></div>
          {range === 'custom' && (
            <>
              <div><label htmlFor="ct-from">Desde</label><input id="ct-from" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
              <div><label htmlFor="ct-to">Hasta</label><input id="ct-to" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} /></div>
            </>
          )}
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400, color: 'var(--text)', paddingBottom: 6 }}><input type="checkbox" checked={errOnly} onChange={(e) => setErrOnly(e.target.checked)} /> Solo con error</label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 400, color: 'var(--text)', paddingBottom: 6 }}><input type="checkbox" checked={allRegions} onChange={(e) => setAllRegions(e.target.checked)} /> Todas las regiones</label>
          {(value || errOnly) && <Btn kind="link" onClick={() => { setValue(''); setErrOnly(false); }}>Borrar filtros</Btn>}
        </div>
        {elsewhere ? <div className="ct-note">Mostrando eventos de la región {s.region}. Hay {elsewhere} evento(s) en otras regiones (los servicios globales como IAM se registran en la región desde la que se llama).</div> : null}
        <Table
          rows={rows}
          id={(e) => e.id}
          onRefresh={() => setTick(tick + 1)}
          empty={{ title: 'No hay eventos que coincidan', desc: 'Ejecute algún comando o acción en la consola, o amplíe el intervalo de tiempo.' }}
          filterPlaceholder="Filtrar los eventos mostrados"
          cols={[
            { head: 'Nombre del evento', cell: (e) => <a href={'#/cloudtrail/events/' + e.id} onClick={(ev) => { ev.preventDefault(); nav('/cloudtrail/events/' + e.id); }}>{e.eventName}</a>, text: (e) => e.eventName },
            { head: 'Hora del evento', cell: (e) => fmtDate(e.time), text: (e) => e.time },
            { head: 'Nombre de usuario', cell: (e) => e.userName, text: (e) => e.userName },
            { head: 'Origen del evento', cell: (e) => e.eventSource, text: (e) => e.eventSource },
            { head: 'Tipo de recurso', cell: resType, text: resType },
            { head: 'Nombre del recurso', cell: resName, text: resName },
            { head: 'Código de error', cell: (e) => (e.errorCode ? <span className="ct-err">{e.errorCode}</span> : '-'), text: (e) => e.errorCode ?? '' },
          ]}
        />
      </Card>
    </>
  );
}

function EventDetail({ id }: { id: string }) {
  const s = useCloud();
  const e = s.trail.find((x) => x.id === id);
  const [copied, setCopied] = useState(false);
  const crumbs = [{ label: 'CloudTrail', to: '/cloudtrail/events' }, { label: 'Historial de eventos', to: '/cloudtrail/events' }];
  if (!e) return (
    <>
      <Crumbs items={[...crumbs, { label: id }]} />
      <Flash kind="err" title="Evento no encontrado">No existe el evento {id}. <a onClick={() => nav('/cloudtrail/events')}>Volver al historial de eventos</a></Flash>
    </>
  );
  const text = JSON.stringify(eventRecord(s, e), null, 2);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { download('evento.json', 'application/json', text); }
  };
  const kv: [string, React.ReactNode][] = [
    ['Nombre del evento', e.eventName], ['Hora del evento', fmtDate(e.time)], ['Nombre de usuario', e.userName],
    ['Origen del evento', e.eventSource], ['Región de AWS', e.region], ['Dirección IP de origen', e.sourceIp],
    ['ARN de la identidad', e.principalArn], ['ID del evento', e.id], ['Solo lectura', e.readOnly ? 'Verdadero' : 'Falso'],
  ];
  return (
    <>
      <Crumbs items={[...crumbs, { label: e.eventName }]} />
      <PageHead title={e.eventName} desc={e.errorCode ? undefined : 'La llamada a la API se completó correctamente.'}>
        <Btn onClick={() => nav('/cloudtrail/events')}>Volver al historial</Btn>
      </PageHead>
      {e.errorCode && (
        <div className="ct-errbox" role="alert">
          <b>La llamada a la API falló</b>
          <div>Código de error: <code>{e.errorCode}</code></div>
          <div>Mensaje: {e.errorMessage}</div>
        </div>
      )}
      <Card title="Detalles del evento">
        <div className="ct-kv">
          {kv.map(([k, v]) => <div key={k}><div className="k">{k}</div><div className="v">{v}</div></div>)}
          <div><div className="k">Resultado</div><div className="v">{e.errorCode ? <Status tone="err">{e.errorCode}</Status> : <Status tone="ok">Correcto</Status>}</div></div>
        </div>
      </Card>
      <Card title="Recursos a los que se hace referencia" count={e.resources.length} flush>
        <Table rows={e.resources} id={(r) => r.type + r.name} empty={{ title: 'Sin recursos', desc: 'Este evento no hace referencia a recursos concretos.' }} cols={[{ head: 'Tipo de recurso', cell: (r) => r.type }, { head: 'Nombre del recurso', cell: (r) => r.name }]} />
      </Card>
      <Card title="Registro de eventos" actions={<Btn onClick={copy}>{copied ? 'Copiado' : 'Copiar'}</Btn>}>
        <pre className="ct-json" aria-label="Registro de eventos"><Json text={text} /></pre>
      </Card>
    </>
  );
}

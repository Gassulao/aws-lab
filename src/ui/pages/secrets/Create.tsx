import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, PageHead, nav } from '../../components/ui';
import { Steps, TagEditor, Tile, run, q, setNextFlash, tmpFile, type TagRow } from '../iam/kit';
import { aliasesOf } from '../kms/common';

type Row = { k: string; v: string };

export function CreateSecret() {
  const s = useCloud();
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<'kv' | 'text'>('kv');
  const [rows, setRows] = useState<Row[]>([{ k: '', v: '' }]);
  const [text, setText] = useState('');
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [tags, setTags] = useState<TagRow[]>([]);
  const [rot, setRot] = useState(false);
  const [days, setDays] = useState('30');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const customKeys = s.kmsKeys.filter((k) => k.manager === 'CUSTOMER' && k.region === s.region && k.state === 'Enabled');
  const value = mode === 'kv' ? JSON.stringify(Object.fromEntries(rows.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v]))) : text;
  const nameErr = name && !/^[0-9A-Za-z/_+=.@-]{1,512}$/.test(name) ? 'El nombre solo puede contener letras, números y los caracteres /_+=.@-' : s.secrets.some((x) => x.name === name && x.region === s.region) ? 'Ya existe un secreto con ese nombre.' : '';
  const cmd = `aws secretsmanager create-secret --name ${name || '<nombre>'}${desc ? ` --description ${q(desc)}` : ''}${key ? ` --kms-key-id ${key}` : ''} --secret-string ${q(value || '{}')}${tags.some((t) => t.k.trim()) ? ' --tags ' + tags.filter((t) => t.k.trim()).map((t) => `Key=${t.k.trim()},Value=${q(t.v)}`).join(' ') : ''}`;
  const go = async () => {
    setBusy(true); setErr('');
    const secretArg = tmpFile(value);
    const c = cmd.replace(q(value || '{}'), secretArg);
    const r = await run(c);
    if (!r.ok) { setBusy(false); return setErr(r.msg); }
    if (rot) {
      const x = await run(`aws secretsmanager rotate-secret --secret-id ${name} --rotation-rules AutomaticallyAfterDays=${days}`);
      if (!x.ok) setNextFlash(`Se almacenó el secreto, pero la rotación falló: ${x.msg}`);
      else setNextFlash(`Se almacenó el secreto "${name}" y se configuró la rotación cada ${days} días.`);
    } else setNextFlash(`Se almacenó correctamente el secreto "${name}".`);
    nav('/secretsmanager/secret/' + encodeURIComponent(name));
  };
  const valid0 = mode === 'kv' ? rows.some((r) => r.k.trim()) : text.length > 0;
  return (
    <>
      <Crumbs items={[{ label: 'AWS Secrets Manager', to: '/secretsmanager/secrets' }, { label: 'Secretos', to: '/secretsmanager/secrets' }, { label: 'Almacenar un secreto nuevo' }]} />
      <PageHead title="Almacenar un secreto nuevo" />
      {err && <Flash kind="err" title="Error al almacenar el secreto" onClose={() => setErr('')}>{err}</Flash>}
      <div className="k-wiz">
        <Steps current={step} steps={['Elegir el tipo de secreto', 'Configurar el secreto', 'Configurar la rotación', 'Revisar']} />
        <div>
          {step === 0 && (
            <>
              <Card title="Tipo de secreto">
                <div className="k-tiles">
                  <Tile on title="Otro tipo de secreto" desc="Clave de API, token de OAuth, credenciales de otro servicio…" onClick={() => {}} />
                </div>
              </Card>
              <Card title="Pares de clave/valor">
                <div style={{ marginBottom: 10 }}>
                  <label style={{ marginRight: 16 }}><input type="radio" checked={mode === 'kv'} onChange={() => setMode('kv')} /> Pares clave/valor</label>
                  <label><input type="radio" checked={mode === 'text'} onChange={() => setMode('text')} /> Texto sin formato</label>
                </div>
                {mode === 'kv' ? (
                  <>
                    {rows.map((r, i) => (
                      <div className="sm-kv" key={i}>
                        <input placeholder="Clave" aria-label="Clave" value={r.k} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
                        <input placeholder="Valor" aria-label="Valor" value={r.v} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
                        <Btn small onClick={() => setRows(rows.filter((_, j) => j !== i))}>Quitar</Btn>
                      </div>
                    ))}
                    <Btn small onClick={() => setRows([...rows, { k: '', v: '' }])}>Agregar fila</Btn>
                  </>
                ) : (
                  <textarea className="k-code" style={{ minHeight: 120 }} value={text} onChange={(e) => setText(e.target.value)} aria-label="Texto del secreto" />
                )}
              </Card>
              <Card title="Clave de cifrado">
                <p className="k-muted">Puede cifrar el secreto con la clave administrada por AWS (<code>aws/secretsmanager</code>) o con una clave administrada por el cliente.</p>
                <select className="k-select" aria-label="Clave de cifrado" value={key} onChange={(e) => setKey(e.target.value)} style={{ minWidth: 320 }}>
                  <option value="">aws/secretsmanager (predeterminada)</option>
                  {customKeys.map((k) => <option key={k.id} value={k.id}>{aliasesOf(s, k)[0] ?? k.id}</option>)}
                </select>
              </Card>
            </>
          )}
          {step === 1 && (
            <>
              <Card title="Nombre y descripción del secreto">
                <Field label="Nombre del secreto" hint="Un nombre descriptivo que ayude a encontrarlo. Puede incluir barras para organizarlos (por ejemplo, prod/app/db)." error={nameErr}>
                  <input className="k-input" type="text" placeholder="prod/app/db" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                </Field>
                <Field label="Descripción - opcional"><input className="k-input" type="text" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
              </Card>
              <Card title="Etiquetas - opcional"><TagEditor tags={tags} onChange={setTags} /></Card>
            </>
          )}
          {step === 2 && (
            <Card title="Rotación automática">
              <label className="k-switch"><input type="checkbox" checked={rot} onChange={(e) => setRot(e.target.checked)} /> Habilitar la rotación automática</label>
              {rot && (
                <Field label="Programación de la rotación (días)" hint="En AWS real la rotación la ejecuta una función de Lambda; en el simulador se genera un valor nuevo conservando la estructura JSON.">
                  <input className="k-input" type="number" min={1} max={1000} value={days} onChange={(e) => setDays(e.target.value)} style={{ maxWidth: 140 }} />
                </Field>
              )}
            </Card>
          )}
          {step === 3 && (
            <>
              <Card title="Resumen">
                <div className="k-three k-dl">
                  <div><div className="k">Nombre</div><div className="v">{name}</div></div>
                  <div><div className="k">Clave de cifrado</div><div className="v">{key ? aliasesOf(s, s.kmsKeys.find((k) => k.id === key)!)[0] ?? key : 'aws/secretsmanager'}</div></div>
                  <div><div className="k">Rotación</div><div className="v">{rot ? `Cada ${days} días` : 'Deshabilitada'}</div></div>
                </div>
              </Card>
              <CliEquivalent cmd={cmd} />
            </>
          )}
          <div className="k-foot">
            <Btn onClick={() => (step === 0 ? nav('/secretsmanager/secrets') : setStep(step - 1))}>{step === 0 ? 'Cancelar' : 'Anterior'}</Btn>
            {step < 3 ? <Btn kind="primary" disabled={(step === 0 && !valid0) || (step === 1 && (!name || !!nameErr))} onClick={() => setStep(step + 1)}>Siguiente</Btn> : <Btn kind="primary" disabled={busy} onClick={go}>Almacenar</Btn>}
          </div>
        </div>
      </div>
    </>
  );
}

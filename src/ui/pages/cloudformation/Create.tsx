import React, { useMemo, useState } from 'react';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, PageHead, nav } from '../../components/ui';
import { q, run, setNextFlash, tmpFile } from '../iam/kit';
import { parseTemplate, requiredCapabilities } from '../../../engine/services/cloudformation';
import { SAMPLE } from './common';

/** Crear una pila pegando la plantilla (o actualizar una existente si se pasa `update`). */
export function CreateStack({ update, initial }: { update?: string; initial?: string }) {
  const [body, setBody] = useState(initial ?? SAMPLE);
  const [name, setName] = useState(update ?? '');
  const [vals, setVals] = useState<Record<string, string>>({});
  const [caps, setCaps] = useState<string[]>([]);
  const [onFail, setOnFail] = useState('ROLLBACK');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => { try { return { tpl: parseTemplate(body).tpl, e: '' }; } catch (e) { return { tpl: null, e: (e as Error).message }; } }, [body]);
  const params = Object.entries(parsed.tpl?.Parameters ?? {});
  const need = parsed.tpl ? requiredCapabilities(parsed.tpl).caps[0] : undefined;
  const verb = update ? 'update-stack' : 'create-stack';
  const pArg = params.length ? ' --parameters ' + params.map(([k, d]) => `ParameterKey=${k},ParameterValue=${q(vals[k] ?? String(d.Default ?? ''))}`).join(' ') : '';
  const cmd = `aws cloudformation ${verb} --stack-name ${name || '<nombre>'} --template-body file://plantilla${pArg}${caps.length ? ' --capabilities ' + caps.join(' ') : ''}${update ? '' : ` --on-failure ${onFail}`}`;
  const go = async () => {
    setBusy(true); setErr('');
    const r = await run(cmd.replace('file://plantilla', tmpFile(body)));
    setBusy(false);
    if (!r.ok) return setErr(r.msg);
    setNextFlash(update ? `Se inició la actualización de la pila "${name}".` : `Se inició la creación de la pila "${name}".`);
    nav('/cloudformation/stack/' + encodeURIComponent(name));
  };
  const toggle = (c: string) => setCaps(caps.includes(c) ? caps.filter((x) => x !== c) : [...caps, c]);
  return (
    <>
      <Crumbs items={[{ label: 'CloudFormation', to: '/cloudformation/stacks' }, { label: 'Pilas', to: '/cloudformation/stacks' }, { label: update ? 'Actualizar pila' : 'Crear pila' }]} />
      <PageHead title={update ? `Actualizar la pila ${update}` : 'Crear pila'} />
      {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
      <Card title="Plantilla (JSON o YAML)">
        <textarea className="cf-tpl" aria-label="Cuerpo de la plantilla" spellCheck={false} value={body} onChange={(e) => setBody(e.target.value)} />
        {parsed.e && <div className="k-muted" style={{ color: 'var(--err, #d13212)', marginTop: 6 }}>{parsed.e}</div>}
      </Card>
      <Card title="Detalles de la pila">
        <Field label="Nombre de la pila" hint="Empieza por una letra; solo letras, números y guiones."><input className="k-input" aria-label="Nombre de la pila" value={name} disabled={!!update} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 360 }} /></Field>
        {params.map(([k, d]) => (
          <Field key={k} label={k} hint={d.Description ?? (d.AllowedValues ? `Valores permitidos: ${d.AllowedValues.join(', ')}` : undefined)}>
            <input className="k-input" aria-label={`Parámetro ${k}`} value={vals[k] ?? String(d.Default ?? '')} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} style={{ maxWidth: 360 }} />
          </Field>
        ))}
      </Card>
      <Card title="Opciones de la pila">
        {!update && <Field label="Al producirse un error"><select className="k-select" aria-label="Al producirse un error" value={onFail} onChange={(e) => setOnFail(e.target.value)}><option value="ROLLBACK">Revertir todos los recursos de la pila</option><option value="DO_NOTHING">Conservar los recursos aprovisionados</option><option value="DELETE">Eliminar la pila</option></select></Field>}
        <Field label="Capacidades" hint={need ? `La plantilla crea recursos de IAM: necesita ${need}.` : undefined}>
          <label className="cf-chk"><input type="checkbox" checked={caps.includes('CAPABILITY_IAM')} onChange={() => toggle('CAPABILITY_IAM')} /> Reconozco que CloudFormation puede crear recursos de IAM (CAPABILITY_IAM)</label>
          <label className="cf-chk"><input type="checkbox" checked={caps.includes('CAPABILITY_NAMED_IAM')} onChange={() => toggle('CAPABILITY_NAMED_IAM')} /> … con nombres personalizados (CAPABILITY_NAMED_IAM)</label>
        </Field>
      </Card>
      <CliEquivalent cmd={cmd} />
      <div className="k-foot"><Btn onClick={() => nav(update ? '/cloudformation/stack/' + encodeURIComponent(update) : '/cloudformation/stacks')}>Cancelar</Btn><Btn kind="primary" disabled={busy || !name || !!parsed.e} onClick={go}>{update ? 'Actualizar pila' : 'Crear pila'}</Btn></div>
    </>
  );
}

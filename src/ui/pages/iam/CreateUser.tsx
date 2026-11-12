import React, { useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, PageHead, Table, nav } from '../../components/ui';
import { Steps, Tile, TagEditor, tagsArg, run, setNextFlash, type TagRow, lastSeg } from './kit';
import { PolicyPicker } from './Pickers';

type Mode = 'group' | 'copy' | 'attach';

export function CreateUser() {
  const s = useCloud();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [console_, setConsole] = useState(false);
  const [mode, setMode] = useState<Mode>('group');
  const [groups, setGroups] = useState<string[]>([]);
  const [copyFrom, setCopyFrom] = useState<string[]>([]);
  const [pols, setPols] = useState<string[]>([]);
  const [tags, setTags] = useState<TagRow[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const nameErr = name && !/^[\w+=,.@-]{1,64}$/.test(name) ? 'El nombre solo puede contener caracteres alfanuméricos y + = , . @ _ -' : s.users.some((u) => u.name === name) ? 'Ya existe un usuario con ese nombre.' : '';
  const src = s.users.find((u) => u.name === copyFrom[0]);
  const effGroups = mode === 'group' ? groups : src ? s.groups.filter((g) => g.members.includes(src.name)).map((g) => g.name) : [];
  const effPols = mode === 'attach' ? pols : mode === 'copy' && src ? src.attached : [];
  const tagA = tagsArg(tags);
  const cmd = `aws iam create-user --user-name ${name || '<nombre>'}${tagA.length ? ' --tags ' + tagA.join(' ') : ''}`;
  const create = async () => {
    setBusy(true); setErr('');
    const r = await run(cmd);
    if (!r.ok) { setBusy(false); return setErr(r.msg); }
    for (const g of effGroups) {
      const x = await run(`aws iam add-user-to-group --group-name ${g} --user-name ${name}`);
      if (!x.ok) { setBusy(false); return setErr(`Se creó el usuario, pero no se pudo agregar al grupo ${g}: ${x.msg}`); }
    }
    for (const a of effPols) {
      const x = await run(`aws iam attach-user-policy --user-name ${name} --policy-arn ${a}`);
      if (!x.ok) { setBusy(false); return setErr(`Se creó el usuario, pero no se pudo adjuntar ${lastSeg(a)}: ${x.msg}`); }
    }
    setNextFlash(`Se creó el usuario ${name}.`);
    nav('/iam/users/' + encodeURIComponent(name));
  };
  const steps = ['Especificar los detalles del usuario', 'Establecer permisos', 'Revisar y crear'];
  return (
    <>
      <Crumbs items={[{ label: 'IAM', to: '/iam' }, { label: 'Usuarios', to: '/iam/users' }, { label: 'Crear usuario' }]} />
      <PageHead title="Crear usuario" />
      <div className="k-wiz">
        <Steps steps={steps} current={step} />
        <div>
          {err && <Flash kind="err" title="Error" onClose={() => setErr('')}>{err}</Flash>}
          {step === 0 && (
            <Card title="Detalles del usuario">
              <Field label="Nombre de usuario" hint="El nombre de usuario puede tener hasta 64 caracteres. Los caracteres válidos son: A-Z, a-z, 0-9 y + = , . @ _ - (guion)." error={nameErr}>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              </Field>
              <label><input type="checkbox" checked={console_} onChange={(e) => setConsole(e.target.checked)} /> Proporcionar acceso de usuario a la AWS Management Console - <i>opcional</i></label>
              {console_ && <div className="k-warnbox">El simulador no admite aún crear contraseñas de consola; el usuario se creará sin acceso a la consola. Podrá crear claves de acceso desde sus credenciales de seguridad.</div>}
            </Card>
          )}
          {step === 1 && (
            <>
              <Card title="Opciones de permisos">
                <div className="k-tiles">
                  <Tile on={mode === 'group'} onClick={() => setMode('group')} title="Agregar usuario a un grupo" desc="Asigne al usuario a uno o más grupos existentes. Los grupos facilitan la administración de permisos." />
                  <Tile on={mode === 'copy'} onClick={() => setMode('copy')} title="Copiar permisos" desc="Copie todas las pertenencias a grupos y las políticas adjuntas de un usuario existente." />
                  <Tile on={mode === 'attach'} onClick={() => setMode('attach')} title="Adjuntar políticas directamente" desc="Adjunte una política administrada directamente al usuario. Se recomienda usar grupos." />
                </div>
              </Card>
              {mode === 'group' && (
                <Card title="Grupos de usuarios" count={s.groups.length} flush actions={<Btn small onClick={() => nav('/iam/groups/create')}>Crear grupo</Btn>}>
                  <Table rows={s.groups} id={(g) => g.name} selected={groups} onSelect={setGroups} filterPlaceholder="Buscar grupos" empty={{ title: 'No hay grupos', desc: 'Cree un grupo para administrar permisos.' }} cols={[
                    { head: 'Nombre del grupo', cell: (g) => g.name, text: (g) => g.name }, { head: 'Usuarios', cell: (g) => g.members.length }, { head: 'Políticas adjuntas', cell: (g) => g.attached.map(lastSeg).join(', ') || '-' },
                  ]} />
                </Card>
              )}
              {mode === 'copy' && (
                <Card title="Copiar permisos de un usuario existente" flush>
                  <Table rows={s.users} id={(u) => u.name} selected={copyFrom} onSelect={(x) => setCopyFrom(x.slice(-1))} filterPlaceholder="Buscar usuarios" empty={{ title: 'No hay usuarios' }} cols={[
                    { head: 'Nombre de usuario', cell: (u) => u.name, text: (u) => u.name }, { head: 'Grupos', cell: (u) => s.groups.filter((g) => g.members.includes(u.name)).map((g) => g.name).join(', ') || '-' }, { head: 'Políticas adjuntas', cell: (u) => u.attached.map(lastSeg).join(', ') || '-' },
                  ]} />
                </Card>
              )}
              {mode === 'attach' && (
                <Card title="Políticas de permisos" count={pols.length} flush><PolicyPicker selected={pols} onChange={setPols} /></Card>
              )}
            </>
          )}
          {step === 2 && (
            <>
              <Card title="Detalles del usuario">
                <div className="k-three k-dl">
                  <div><div className="k">Nombre de usuario</div><div className="v">{name}</div></div>
                  <div><div className="k">Acceso a la consola</div><div className="v">Deshabilitado</div></div>
                  <div><div className="k">Tipo de permisos</div><div className="v">{mode === 'group' ? 'Agregar al grupo' : mode === 'copy' ? 'Copiar permisos' : 'Adjuntar políticas directamente'}</div></div>
                </div>
              </Card>
              <Card title="Resumen de permisos" flush>
                <Table rows={[...effGroups.map((g) => ({ n: g, t: 'Grupo' })), ...effPols.map((a) => ({ n: lastSeg(a), t: 'Política administrada' }))]} id={(r) => r.t + r.n} empty={{ title: 'Sin permisos', desc: 'El usuario no tendrá permisos hasta que se los asigne.' }} cols={[{ head: 'Nombre', cell: (r) => r.n }, { head: 'Tipo', cell: (r) => r.t }]} />
              </Card>
              <Card title="Etiquetas - opcional"><TagEditor tags={tags} onChange={setTags} /></Card>
              <CliEquivalent cmd={cmd} />
            </>
          )}
          <div className="k-foot">
            <Btn onClick={() => (step === 0 ? nav('/iam/users') : setStep(step - 1))}>{step === 0 ? 'Cancelar' : 'Anterior'}</Btn>
            {step < 2 ? <Btn kind="primary" disabled={!name || !!nameErr || (step === 1 && mode === 'copy' && !src)} onClick={() => setStep(step + 1)}>Siguiente</Btn> : <Btn kind="primary" disabled={busy} onClick={create}>Crear usuario</Btn>}
          </div>
        </div>
      </div>
    </>
  );
}

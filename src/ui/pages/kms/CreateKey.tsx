import React, { useMemo, useState } from 'react';
import { useCloud } from '../../session';
import { Btn, Card, CliEquivalent, Crumbs, Field, Flash, PageHead, nav } from '../../components/ui';
import { Steps, TagEditor, Tile, run, tmpFile, pretty, setNextFlash, q, type TagRow } from '../iam/kit';
import { principals } from './common';

const ADMIN_ACTIONS = ['kms:Create*', 'kms:Describe*', 'kms:Enable*', 'kms:List*', 'kms:Put*', 'kms:Update*', 'kms:Revoke*', 'kms:Disable*', 'kms:Get*', 'kms:Delete*', 'kms:TagResource', 'kms:UntagResource', 'kms:ScheduleKeyDeletion', 'kms:CancelKeyDeletion'];
const USE_ACTIONS = ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'];

export function CreateKey() {
  const s = useCloud();
  const [step, setStep] = useState(0);
  const [alias, setAlias] = useState('');
  const [desc, setDesc] = useState('');
  const [tags, setTags] = useState<TagRow[]>([]);
  const [admins, setAdmins] = useState<string[]>([s.me.arn]);
  const [users, setUsers] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const pr = principals(s);
  const aliasErr = alias && !/^[a-zA-Z0-9/_-]+$/.test(alias) ? 'El alias solo puede contener letras, números, barras, guiones y guiones bajos.' : alias.toLowerCase().startsWith('aws/') ? 'Los alias que empiezan por aws/ están reservados.' : s.kmsAliases.some((a) => a.name === 'alias/' + alias) ? 'Ya existe un alias con ese nombre.' : '';
  const policy = useMemo(() => {
    const st: any[] = [{ Sid: 'Enable IAM User Permissions', Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${s.account.id}:root` }, Action: 'kms:*', Resource: '*' }];
    if (admins.length) st.push({ Sid: 'Allow access for Key Administrators', Effect: 'Allow', Principal: { AWS: admins }, Action: ADMIN_ACTIONS, Resource: '*' });
    if (users.length) st.push({ Sid: 'Allow use of the key', Effect: 'Allow', Principal: { AWS: users }, Action: USE_ACTIONS, Resource: '*' });
    return { Version: '2012-10-17', Id: 'key-consolepolicy-3', Statement: st };
  }, [admins, users, s.account.id]);
  const cmds = () => {
    const t = tags.filter((x) => x.k.trim());
    const create = `aws kms create-key${desc ? ` --description ${q(desc)}` : ''} --policy ${tmpFile(pretty(policy))}${t.length ? ` --tags ${t.map((x) => `TagKey=${x.k.trim()},TagValue=${q(x.v)}`).join(' ')}` : ''}`;
    return { create, alias: alias ? `aws kms create-alias --alias-name alias/${alias} --target-key-id <id-de-clave>` : '' };
  };
  const toggle = (list: string[], set: (x: string[]) => void, arn: string) => set(list.includes(arn) ? list.filter((x) => x !== arn) : [...list, arn]);
  const go = async () => {
    setBusy(true); setErr('');
    const c = cmds();
    const r = await run(c.create);
    if (!r.ok) { setBusy(false); return setErr(r.msg); }
    const id = r.json?.KeyMetadata?.KeyId as string;
    if (alias) {
      const a = await run(`aws kms create-alias --alias-name alias/${alias} --target-key-id ${id}`);
      if (!a.ok) { setNextFlash(`Se creó la clave, pero no se pudo crear el alias: ${a.msg}`); return nav('/kms/key/' + id); }
    }
    setNextFlash(`Se creó correctamente la clave de KMS ${alias ? `"${alias}"` : id}.`);
    nav('/kms/key/' + id);
  };
  const Pick = ({ list, set }: { list: string[]; set: (x: string[]) => void }) => (
    <div className="kms-pick">
      {pr.map((p) => (
        <label key={p.arn}><input type="checkbox" checked={list.includes(p.arn)} onChange={() => toggle(list, set, p.arn)} /><span>{p.label} <small>{p.kind}</small></span></label>
      ))}
    </div>
  );
  return (
    <>
      <Crumbs items={[{ label: 'Key Management Service (KMS)', to: '/kms/keys' }, { label: 'Claves administradas por el cliente', to: '/kms/keys' }, { label: 'Crear clave' }]} />
      <PageHead title="Crear clave" />
      {err && <Flash kind="err" title="Error al crear la clave" onClose={() => setErr('')}>{err}</Flash>}
      <div className="k-wiz">
        <Steps current={step} steps={['Configurar la clave', 'Agregar etiquetas y alias', 'Permisos de administración', 'Permisos de uso', 'Revisar']} />
        <div>
          {step === 0 && (
            <Card title="Configuración de la clave">
              <Field label="Tipo de clave"><Tile on onClick={() => {}} title="Simétrica" desc="Una sola clave para cifrar y descifrar datos o para generar claves de datos. Es la opción recomendada." /></Field>
              <Field label="Uso de claves"><Tile on onClick={() => {}} title="Cifrar y descifrar" desc="Cifra y descifra datos con la clave simétrica." /></Field>
              <Field label="Opciones avanzadas"><span className="k-muted">Origen del material de clave: KMS · Regionalidad: clave de una sola región.</span></Field>
            </Card>
          )}
          {step === 1 && (
            <>
              <Card title="Alias y descripción">
                <Field label="Alias" hint="Un nombre descriptivo para la clave. No incluya información confidencial." error={aliasErr}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span className="k-muted">alias/</span><input className="k-input" type="text" aria-label="Alias" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="mi-clave" autoFocus /></div>
                </Field>
                <Field label="Descripción - opcional"><input className="k-input" type="text" value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
              </Card>
              <Card title="Etiquetas - opcional"><TagEditor tags={tags} onChange={setTags} /></Card>
            </>
          )}
          {step === 2 && (
            <Card title="Administradores de claves" count={admins.length}>
              <p className="k-muted">Elija los usuarios y roles de IAM que pueden administrar esta clave. Los administradores <b>no</b> pueden usarla para cifrar o descifrar salvo que también se les conceda en el siguiente paso.</p>
              <Pick list={admins} set={setAdmins} />
            </Card>
          )}
          {step === 3 && (
            <Card title="Usuarios de claves" count={users.length}>
              <p className="k-muted">Elija los usuarios y roles de IAM que pueden usar la clave en operaciones criptográficas (Encrypt, Decrypt, GenerateDataKey…). La política también delega en IAM mediante la cuenta raíz, por lo que las políticas de identidad pueden conceder acceso adicional.</p>
              <Pick list={users} set={setUsers} />
            </Card>
          )}
          {step === 4 && (
            <>
              <Card title="Revisar la clave">
                <div className="k-three k-dl">
                  <div><div className="k">Alias</div><div className="v">{alias ? 'alias/' + alias : '–'}</div></div>
                  <div><div className="k">Tipo / uso</div><div className="v">Simétrica · Cifrar y descifrar</div></div>
                  <div><div className="k">Descripción</div><div className="v">{desc || '–'}</div></div>
                </div>
              </Card>
              <Card title="Política de clave"><pre className="k-pre">{pretty(policy)}</pre></Card>
              <CliEquivalent cmd={cmds().create} />
              {alias && <CliEquivalent cmd={cmds().alias} />}
            </>
          )}
          <div className="k-foot">
            <Btn onClick={() => (step === 0 ? nav('/kms/keys') : setStep(step - 1))}>{step === 0 ? 'Cancelar' : 'Anterior'}</Btn>
            {step < 4 ? <Btn kind="primary" disabled={step === 1 && !!aliasErr} onClick={() => setStep(step + 1)}>Siguiente</Btn> : <Btn kind="primary" disabled={busy} onClick={go}>Finalizar</Btn>}
          </div>
        </div>
      </div>
    </>
  );
}

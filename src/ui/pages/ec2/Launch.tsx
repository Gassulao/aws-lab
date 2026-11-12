import React, { useState } from 'react';
import { useCloud, consoleRun, consoleError } from '../../session';
import { Btn, Card, Crumbs, Field, Flash, Modal, PageHead, nav } from '../../components/ui';
import { AMIS, INSTANCE_TYPES } from '../../../engine/catalog';
import { ensureDefaultVpc, parseCidr } from '../../../engine/services/ec2';
import { CmdBox, Kv, InstState, dnsOf, useSettled } from './common';

const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
const OS: { id: string; label: string; short: string; color: string; match: (n: string) => boolean }[] = [
  { id: 'al', label: 'Amazon Linux', short: 'aws', color: '#ec7211', match: (d) => d.startsWith('Amazon') },
  { id: 'ubuntu', label: 'Ubuntu', short: 'U', color: '#e95420', match: (d) => d.includes('Ubuntu') },
  { id: 'win', label: 'Windows', short: 'W', color: '#0078d4', match: (d) => d.includes('Windows') },
];
type Rule = { type: 'ssh' | 'http' | 'https' | 'tcp'; port: string; src: 'any' | 'myip' | 'custom'; cidr: string };
const RULE_PORT = { ssh: '22', http: '80', https: '443', tcp: '' };
const RULE_LABEL = { ssh: 'SSH', http: 'HTTP', https: 'HTTPS', tcp: 'TCP personalizado' };
const ruleCidr = (r: Rule) => (r.src === 'any' ? '0.0.0.0/0' : r.src === 'myip' ? '203.0.113.50/32' : r.cidr.trim());
const rulePort = (r: Rule) => (r.type === 'tcp' ? r.port.trim() : RULE_PORT[r.type]);

const inputStyle: React.CSSProperties = { height: 32, border: '1px solid var(--line2)', borderRadius: 2, padding: '0 8px', background: 'var(--card)', color: 'var(--text)', fontSize: 14, fontFamily: 'inherit' };

export function Launch() {
  const s = useCloud();
  ensureDefaultVpc(s, s.region);
  const vpcs = s.vpcs.filter((v) => v.region === s.region);
  const [name, setName] = useState('');
  const [tags, setTags] = useState<{ k: string; v: string }[]>([]);
  const [os, setOs] = useState('al');
  const [ami, setAmi] = useState(AMIS[0].id);
  const [type, setType] = useState('t3.micro');
  const [key, setKey] = useState('');
  const [vpcId, setVpcId] = useState(vpcs.find((v) => v.isDefault)?.id ?? vpcs[0]?.id ?? '');
  const subnets = s.subnets.filter((x) => x.vpcId === vpcId);
  const [subnet, setSubnet] = useState('');
  const [pubIp, setPubIp] = useState<'subnet' | 'enable' | 'disable'>('subnet');
  const [sgMode, setSgMode] = useState<'new' | 'existing'>('new');
  const sgs = s.securityGroups.filter((g) => g.vpcId === vpcId);
  const [sgSel, setSgSel] = useState('');
  const [sgName, setSgName] = useState('launch-wizard-' + (s.securityGroups.filter((g) => g.name.startsWith('launch-wizard-')).length + 1));
  const [sgDesc, setSgDesc] = useState('launch-wizard created ' + new Date().toISOString().slice(0, 10));
  const [rules, setRules] = useState<Rule[]>([{ type: 'ssh', port: '', src: 'any', cidr: '' }]);
  const [size, setSize] = useState('8');
  const [enc, setEnc] = useState(false);
  const [imds, setImds] = useState<'optional' | 'required'>('required');
  const [profile, setProfile] = useState('');
  const [userData, setUserData] = useState('');
  const [count, setCount] = useState('1');
  const [showErr, setShowErr] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [keyModal, setKeyModal] = useState(false);

  const sub = subnet || subnets[0]?.id || '';
  const subObj = subnets.find((x) => x.id === sub);
  const sgExisting = sgSel || sgs.find((g) => g.name === 'default')?.id || sgs[0]?.id || '';
  const amiObj = AMIS.find((a) => a.id === ami)!;
  const info = INSTANCE_TYPES[type];

  // Validaciones
  const e: Record<string, string> = {};
  const sz = Number(size);
  if (!/^\d+$/.test(size) || sz < 1 || sz > 16384) e.size = 'El tamaño del volumen debe ser un número entero entre 1 y 16384 GiB.';
  if (!/^\d+$/.test(count) || Number(count) < 1 || Number(count) > 20) e.count = 'El número de instancias debe estar entre 1 y 20.';
  if (!sub) e.subnet = 'Seleccione una subred.';
  if (name.length > 256) e.name = 'El nombre admite un máximo de 256 caracteres.';
  if (sgMode === 'new') {
    if (!sgName.trim()) e.sgName = 'El nombre del grupo de seguridad es obligatorio.';
    else if (sgName.startsWith('sg-')) e.sgName = 'Los nombres de grupo no pueden tener el formato sg-*.';
    else if (!/^[\w\s.:/()#,@[\]+=&;{}!$*-]+$/.test(sgName)) e.sgName = 'El nombre contiene caracteres no válidos.';
    else if (sgs.some((g) => g.name === sgName)) e.sgName = `El grupo de seguridad '${sgName}' ya existe en la VPC ${vpcId}.`;
    if (!sgDesc.trim()) e.sgDesc = 'La descripción del grupo de seguridad es obligatoria.';
    rules.forEach((r, k) => {
      const p = rulePort(r);
      if (r.type === 'tcp' && (!/^\d+(-\d+)?$/.test(p) || p.split('-').some((n) => Number(n) > 65535))) e['rp' + k] = 'Puerto no válido (0-65535, p. ej. 8080 o 8000-8100).';
      if (r.src === 'custom' && !parseCidr(r.cidr.trim())) e['rc' + k] = 'CIDR no válido (p. ej. 10.0.0.0/16).';
    });
  } else if (!sgExisting) e.sgExisting = 'Seleccione un grupo de seguridad.';
  const hasErr = Object.keys(e).length > 0;
  const E = (k: string) => (showErr ? e[k] : undefined);

  const cmds: string[] = [];
  const sgRef = sgMode === 'new' ? '<ID-del-nuevo-grupo>' : sgExisting;
  if (sgMode === 'new') {
    cmds.push(`aws ec2 create-security-group --region ${s.region} --group-name ${q(sgName)} --description ${q(sgDesc)} --vpc-id ${vpcId}`);
    rules.forEach((r) => cmds.push(`aws ec2 authorize-security-group-ingress --region ${s.region} --group-id ${sgRef} --protocol tcp --port ${rulePort(r) || '?'} --cidr ${ruleCidr(r) || '?'}`));
  }
  const allTags = [...(name ? [{ k: 'Name', v: name }] : []), ...tags.filter((t) => t.k.trim())];
  const runCmd = (sgId: string) =>
    [
      `aws ec2 run-instances --region ${s.region}`,
      `--image-id ${ami}`,
      `--instance-type ${type}`,
      `--count ${count || 1}`,
      key && `--key-name ${key}`,
      sub && `--subnet-id ${sub}`,
      `--security-group-ids ${sgId}`,
      pubIp === 'enable' ? '--associate-public-ip-address' : pubIp === 'disable' ? '--no-associate-public-ip-address' : '',
      `--block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=${size || 8},VolumeType=gp3${enc ? ',Encrypted=true' : ''}}'`,
      `--metadata-options HttpTokens=${imds}`,
      profile && `--iam-instance-profile Name=${profile}`,
      userData.trim() && `--user-data ${q(userData)}`,
      allTags.length && `--tag-specifications ${q(`ResourceType=instance,Tags=[${allTags.map((t) => `{Key=${t.k},Value=${t.v}}`).join(',')}]`)}`,
    ].filter(Boolean).join(' ');
  cmds.push(runCmd(sgRef));

  const launch = async () => {
    setErr('');
    if (hasErr) { setShowErr(true); window.scrollTo(0, 0); document.querySelector('.main')?.scrollTo(0, 0); return; }
    setBusy(true);
    let sgId = sgExisting;
    if (sgMode === 'new') {
      const r = await consoleRun(cmds[0]);
      if (!r.ok) { setBusy(false); return setErr(consoleError(r.err)); }
      sgId = r.json?.GroupId;
      for (const rl of rules) {
        const a = await consoleRun(`aws ec2 authorize-security-group-ingress --region ${s.region} --group-id ${sgId} --protocol tcp --port ${rulePort(rl)} --cidr ${ruleCidr(rl)}`);
        if (!a.ok) { setBusy(false); return setErr(consoleError(a.err)); }
      }
    }
    const r = await consoleRun(runCmd(sgId));
    setBusy(false);
    if (!r.ok) return setErr(consoleError(r.err));
    const ids = (r.json?.Instances ?? []).map((x: any) => x.InstanceId).join(',');
    nav('/ec2/launch/done/' + ids);
  };

  const setRule = (k: number, p: Partial<Rule>) => setRules(rules.map((r, j) => (j === k ? { ...r, ...p } : r)));
  const anyOpenSsh = sgMode === 'new' && rules.some((r) => r.src === 'any' && rulePort(r) === '22');

  return (
    <>
      <Crumbs items={[{ label: 'EC2', to: '/ec2' }, { label: 'Instancias', to: '/ec2/instances' }, { label: 'Lanzar una instancia' }]} />
      <PageHead title="Lanzar una instancia" desc="Amazon EC2 le permite crear máquinas virtuales (instancias) que se ejecutan en la nube de AWS. Comience rápidamente siguiendo los pasos que se indican a continuación." />
      {err && <Flash kind="err" title="Error al lanzar la instancia" onClose={() => setErr('')}>{err}</Flash>}
      {showErr && hasErr && <Flash kind="err" title="Hay errores en el formulario">Corrija los campos marcados en rojo antes de lanzar la instancia.</Flash>}
      <div className="e2-wiz">
        <div>
          <Card title="Nombre y etiquetas">
            <Field label="Nombre" error={E('name')}><input type="text" placeholder="Por ejemplo: Mi servidor web" value={name} onChange={(ev) => setName(ev.target.value)} /></Field>
            {tags.map((t, k) => (
              <div key={k} style={{ display: 'flex', gap: 8, marginBottom: 8, maxWidth: 620 }}>
                <input style={{ ...inputStyle, flex: 1 }} placeholder="Clave" value={t.k} onChange={(ev) => setTags(tags.map((x, j) => (j === k ? { ...x, k: ev.target.value } : x)))} />
                <input style={{ ...inputStyle, flex: 1 }} placeholder="Valor" value={t.v} onChange={(ev) => setTags(tags.map((x, j) => (j === k ? { ...x, v: ev.target.value } : x)))} />
                <button className="btn link" onClick={() => setTags(tags.filter((_, j) => j !== k))}>Quitar</button>
              </div>
            ))}
            <div style={{ marginBottom: 14 }}><Btn small onClick={() => setTags([...tags, { k: '', v: '' }])}>Agregar etiquetas adicionales</Btn></div>
          </Card>

          <Card title="Imágenes de aplicaciones y sistemas operativos (imagen de máquina de Amazon)">
            <div className="e2-os">
              {OS.map((o) => (
                <div key={o.id} className={os === o.id ? 'on' : ''} onClick={() => { setOs(o.id); const a = AMIS.find((x) => o.match(x.description)); if (a) setAmi(a.id); }}>
                  <span className="logo" style={{ background: o.color }}>{o.short}</span>{o.label}
                </div>
              ))}
            </div>
            <Field label="Imagen de máquina de Amazon (AMI)">
              <select value={ami} onChange={(ev) => { setAmi(ev.target.value); const a = AMIS.find((x) => x.id === ev.target.value)!; setOs(OS.find((o) => o.match(a.description))?.id ?? 'al'); }}>
                {AMIS.map((a) => <option key={a.id} value={a.id}>{a.description} ({a.id})</option>)}
              </select>
            </Field>
            <div className="e2-box"><div className="t">{amiObj.description}<span className="e2-badge">Apto para la capa gratuita</span></div><small>{amiObj.name}</small><small>ID de AMI: {amiObj.id} · Arquitectura: 64 bits (x86) · Usuario: {amiObj.user}</small></div>
          </Card>

          <Card title="Tipo de instancia">
            <Field label="Tipo de instancia">
              <select value={type} onChange={(ev) => setType(ev.target.value)}>
                {Object.values(INSTANCE_TYPES).map((t) => <option key={t.name} value={t.name}>{t.name}{t.freeTier ? ' (apto para la capa gratuita)' : ''}</option>)}
              </select>
            </Field>
            <div className="e2-box"><div className="t">{type}{info.freeTier && <span className="e2-badge">Apto para la capa gratuita</span>}</div><small>Familia: {type.split('.')[0]} · {info.vcpu} vCPU · {info.memGiB} GiB de memoria</small><small>Precio bajo demanda de Linux: {info.hourly.toFixed(4)} USD por hora</small></div>
          </Card>

          <Card title="Par de claves (inicio de sesión)">
            <p style={{ marginTop: 0, color: 'var(--muted)' }}>Puede utilizar un par de claves para conectarse de forma segura a su instancia.</p>
            <Field label="Nombre del par de claves - obligatorio" >
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <select style={{ maxWidth: 400 }} value={key} onChange={(ev) => setKey(ev.target.value)}>
                  <option value="">Continuar sin un par de claves (no recomendado)</option>
                  {s.keyPairs.filter((k) => k.region === s.region).map((k) => <option key={k.id} value={k.name}>{k.name}</option>)}
                </select>
                <a onClick={() => setKeyModal(true)}>Crear nuevo par de claves</a>
              </div>
            </Field>
          </Card>

          <Card title="Configuración de red">
            <Field label="VPC">
              <select value={vpcId} onChange={(ev) => { setVpcId(ev.target.value); setSubnet(''); setSgSel(''); }}>
                {vpcs.map((v) => <option key={v.id} value={v.id}>{v.id} ({v.cidr}){v.isDefault ? ' (predeterminada)' : ''}{v.tags.Name ? ` · ${v.tags.Name}` : ''}</option>)}
              </select>
            </Field>
            <Field label="Subred" error={E('subnet')}>
              <select value={sub} onChange={(ev) => setSubnet(ev.target.value)}>
                {subnets.length === 0 && <option value="">No hay subredes en esta VPC</option>}
                {subnets.map((x) => <option key={x.id} value={x.id}>{x.id} · {x.az} · {x.cidr}{x.tags.Name ? ` · ${x.tags.Name}` : ''}</option>)}
              </select>
            </Field>
            <Field label="Asignar automáticamente la IP pública" hint={subObj ? `La subred ${subObj.mapPublicIpOnLaunch ? 'asigna' : 'no asigna'} IP pública de forma predeterminada.` : undefined}>
              <select value={pubIp} onChange={(ev) => setPubIp(ev.target.value as typeof pubIp)}>
                <option value="subnet">Habilitar (según la configuración de la subred)</option>
                <option value="enable">Habilitar</option>
                <option value="disable">Deshabilitar</option>
              </select>
            </Field>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Firewall (grupos de seguridad)</div>
            <label className="e2-radio"><input type="radio" checked={sgMode === 'new'} onChange={() => setSgMode('new')} /><span>Crear grupo de seguridad</span></label>
            <label className="e2-radio"><input type="radio" checked={sgMode === 'existing'} onChange={() => setSgMode('existing')} /><span>Seleccionar un grupo de seguridad existente</span></label>
            {sgMode === 'existing' ? (
              <Field label="Grupos de seguridad comunes" error={E('sgExisting')}>
                <select value={sgExisting} onChange={(ev) => setSgSel(ev.target.value)}>
                  {sgs.length === 0 && <option value="">No hay grupos de seguridad en esta VPC</option>}
                  {sgs.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.id})</option>)}
                </select>
              </Field>
            ) : (
              <div style={{ marginTop: 10 }}>
                <Field label="Nombre del grupo de seguridad" error={E('sgName')}><input type="text" value={sgName} onChange={(ev) => setSgName(ev.target.value)} /></Field>
                <Field label="Descripción" error={E('sgDesc')}><input type="text" value={sgDesc} onChange={(ev) => setSgDesc(ev.target.value)} /></Field>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Reglas de grupos de seguridad de entrada</div>
                <div className="e2-rule h"><span>Tipo</span><span>Puerto</span><span>Tipo de origen</span><span>Origen</span><span /></div>
                {rules.map((r, k) => (
                  <div key={k}>
                    <div className="e2-rule">
                      <select value={r.type} onChange={(ev) => setRule(k, { type: ev.target.value as Rule['type'] })}>{(Object.keys(RULE_LABEL) as Rule['type'][]).map((t) => <option key={t} value={t}>{RULE_LABEL[t]}</option>)}</select>
                      <input className={E('rp' + k) ? 'bad' : ''} disabled={r.type !== 'tcp'} placeholder="8080" value={r.type === 'tcp' ? r.port : RULE_PORT[r.type]} onChange={(ev) => setRule(k, { port: ev.target.value })} />
                      <select value={r.src} onChange={(ev) => setRule(k, { src: ev.target.value as Rule['src'] })}><option value="any">Cualquier lugar</option><option value="myip">Mi IP</option><option value="custom">Personalizado</option></select>
                      <input className={E('rc' + k) ? 'bad' : ''} disabled={r.src !== 'custom'} placeholder="10.0.0.0/16" value={ruleCidr(r) && r.src !== 'custom' ? ruleCidr(r) : r.cidr} onChange={(ev) => setRule(k, { cidr: ev.target.value })} />
                      <button className="x" title="Quitar regla" onClick={() => setRules(rules.filter((_, j) => j !== k))}>✕</button>
                    </div>
                    {(E('rp' + k) || E('rc' + k)) && <div className="e2-err" style={{ marginTop: -4, marginBottom: 8, fontSize: 12 }}>{E('rp' + k) ?? E('rc' + k)}</div>}
                  </div>
                ))}
                <div style={{ marginBottom: 12 }}><Btn small onClick={() => setRules([...rules, { type: 'https', port: '', src: 'any', cidr: '' }])}>Agregar regla</Btn></div>
                {anyOpenSsh && <div className="e2-warnbox"><b>Las reglas con origen 0.0.0.0/0 permiten que todas las direcciones IP accedan a la instancia.</b> Se recomienda limitar el acceso SSH a direcciones IP conocidas.</div>}
              </div>
            )}
          </Card>

          <Card title="Configurar almacenamiento">
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <Field label="Volumen raíz (GiB)" error={E('size')}><input type="text" style={{ width: 120 }} value={size} onChange={(ev) => setSize(ev.target.value.replace(/[^\d]/g, ''))} /></Field>
              <Field label="Tipo de volumen"><select disabled style={{ width: 120 }}><option>gp3</option></select></Field>
              <Field label="Cifrado"><select style={{ width: 160 }} value={enc ? 'y' : 'n'} onChange={(ev) => setEnc(ev.target.value === 'y')}><option value="n">No cifrado</option><option value="y">Cifrado</option></select></Field>
            </div>
            <div className="e2-note" style={{ padding: '0 0 10px' }}>Dispositivo /dev/xvda · Eliminar al terminar: Sí. Las instancias de la capa gratuita incluyen hasta 30 GiB de almacenamiento EBS.</div>
          </Card>

          <Card title="Detalles avanzados">
            <Field label="Perfil de instancia de IAM">
              <select value={profile} onChange={(ev) => setProfile(ev.target.value)}>
                <option value="">Ninguno</option>
                {s.instanceProfiles.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Versión de metadatos" hint="Con IMDSv2 obligatorio se bloquean ataques SSRF contra los metadatos de la instancia.">
              <select value={imds} onChange={(ev) => setImds(ev.target.value as 'optional' | 'required')}>
                <option value="required">Solo V2 (se requiere token)</option>
                <option value="optional">V1 y V2 (token opcional)</option>
              </select>
            </Field>
            <Field label="Datos de usuario - opcional" hint="Script que se ejecuta al arrancar la instancia por primera vez (p. ej. #!/bin/bash).">
              <textarea placeholder={'#!/bin/bash\nyum install -y httpd'} value={userData} onChange={(ev) => setUserData(ev.target.value)} />
            </Field>
          </Card>
        </div>

        <div className="e2-sum">
          <Card>
            <h3>Resumen</h3>
            <Field label="Número de instancias" error={E('count')}><input type="text" style={{ width: 90 }} value={count} onChange={(ev) => setCount(ev.target.value.replace(/\D/g, ''))} /></Field>
            <dl>
              <dt>Imagen de software (AMI)</dt><dd>{amiObj.description}<br /><small style={{ color: 'var(--muted)' }}>{amiObj.id}</small></dd>
              <dt>Tipo de instancia</dt><dd>{type} ({info.vcpu} vCPU, {info.memGiB} GiB)</dd>
              <dt>Firewall (grupo de seguridad)</dt><dd>{sgMode === 'new' ? `Nuevo grupo de seguridad: ${sgName || '-'}` : sgs.find((g) => g.id === sgExisting)?.name ?? '-'}</dd>
              <dt>Almacenamiento (volúmenes)</dt><dd>1 volumen: {size || '-'} GiB gp3{enc ? ' (cifrado)' : ''}</dd>
              <dt>Coste estimado</dt><dd>{(info.hourly * (Number(count) || 1)).toFixed(4)} USD/hora</dd>
            </dl>
            <hr />
            <Btn kind="primary" onClick={launch} disabled={busy}>{busy ? 'Lanzando…' : 'Lanzar instancia'}</Btn>
            <Btn onClick={() => nav('/ec2/instances')}>Cancelar</Btn>
            <CmdBox cmds={cmds} />
          </Card>
        </div>
      </div>
      {keyModal && <KeyModal onClose={() => setKeyModal(false)} onCreated={(n) => { setKey(n); }} />}
    </>
  );
}

export function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-pem-file' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Crear par de claves (aws ec2 create-key-pair): muestra y descarga la clave privada. */
export function KeyModal({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => void }) {
  const s = useCloud();
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [mat, setMat] = useState<{ name: string; pem: string } | null>(null);
  const create = async () => {
    if (!name.trim()) return setErr('El nombre del par de claves es obligatorio.');
    if (!/^[\x20-\x7e]{1,255}$/.test(name)) return setErr('El nombre solo puede contener caracteres ASCII (máx. 255).');
    const r = await consoleRun(`aws ec2 create-key-pair --region ${s.region} --key-name ${q(name.trim())}`);
    if (!r.ok) return setErr(consoleError(r.err));
    const pem = r.json?.KeyMaterial ?? '';
    setMat({ name: name.trim(), pem });
    downloadText(name.trim() + '.pem', pem + '\n');
    onCreated(name.trim());
  };
  if (mat) {
    return (
      <Modal title="Par de claves creado" onClose={onClose} footer={<><Btn onClick={() => downloadText(mat.name + '.pem', mat.pem + '\n')}>Descargar de nuevo</Btn><Btn kind="primary" onClick={onClose}>Listo</Btn></>}>
        <Flash kind="ok">Se creó el par de claves <b style={{ display: 'inline' }}>{mat.name}</b> y se descargó <code>{mat.name}.pem</code>.</Flash>
        <p style={{ marginTop: 0 }}>Guarde la clave privada ahora: no se puede recuperar más tarde.</p>
        <div className="e2-pre">{mat.pem}</div>
      </Modal>
    );
  }
  return (
    <Modal title="Crear par de claves" onClose={onClose} footer={<><Btn onClick={onClose}>Cancelar</Btn><Btn kind="primary" onClick={create}>Crear par de claves</Btn></>}>
      <Field label="Nombre del par de claves" hint="El nombre puede incluir hasta 255 caracteres ASCII." error={err}>
        <input type="text" autoFocus value={name} onChange={(ev) => { setName(ev.target.value); setErr(''); }} onKeyDown={(ev) => ev.key === 'Enter' && create()} />
      </Field>
      <Field label="Tipo de par de claves"><select disabled><option>RSA</option></select></Field>
      <Field label="Formato de archivo de clave privada"><select disabled><option>.pem</option></select></Field>
      <CmdBox cmds={[`aws ec2 create-key-pair --key-name ${name || '<nombre>'}`]} />
    </Modal>
  );
}

/** Página de éxito tras lanzar. */
export function Launched({ ids }: { ids: string }) {
  const s = useSettled();
  const list = ids.split(',').filter(Boolean);
  const insts = list.map((id) => s.instances.find((i) => i.id === id)).filter(Boolean);
  return (
    <>
      <Crumbs items={[{ label: 'EC2', to: '/ec2' }, { label: 'Instancias', to: '/ec2/instances' }, { label: 'Lanzar una instancia' }]} />
      <PageHead title="Lanzar una instancia" />
      <Flash kind="ok" title={list.length === 1 ? `Se inició correctamente la instancia ${list[0]}` : `Se iniciaron correctamente ${list.length} instancias`}>
        {list.map((id, k) => <span key={id}>{k > 0 && ', '}<a onClick={() => nav('/ec2/instance/' + id)}>{id}</a></span>)}
      </Flash>
      <Card title="Próximos pasos">
        <div className="e2-cards">
          <div><h3>Ver instancias</h3><p>Compruebe el estado de la instancia y sus comprobaciones.</p><Btn onClick={() => nav('/ec2/instances')}>Ver todas las instancias</Btn></div>
          <div><h3>Conectarse a la instancia</h3><p>Use SSH con su par de claves para iniciar sesión.</p><Btn disabled={!list[0]} onClick={() => nav('/ec2/instance/' + list[0] + '/connect')}>Conectar</Btn></div>
          <div><h3>Lanzar otra instancia</h3><p>Cree otra máquina virtual con otra configuración.</p><Btn onClick={() => nav('/ec2/launch')}>Lanzar instancia</Btn></div>
        </div>
      </Card>
      {insts.length > 0 && (
        <Card title="Instancias lanzadas">
          <Kv items={insts.flatMap((i) => [[i!.id, <><InstState i={i!} /> · {i!.type}</>] as [string, React.ReactNode], ['DNS público', dnsOf(i!)] as [string, React.ReactNode]])} cols={2} />
        </Card>
      )}
    </>
  );
}

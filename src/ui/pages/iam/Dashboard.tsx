import React from 'react';
import { useCloud } from '../../session';
import { Card, Crumbs, PageHead, nav } from '../../components/ui';

export function Dashboard() {
  const s = useCloud();
  const noMfa = s.users.filter((u) => !u.mfaDevices.length);
  const oldKeys = s.users.flatMap((u) => u.accessKeys.filter((k) => k.status === 'Active' && Date.now() - new Date(k.createdAt).getTime() > 90 * 86400000).map((k) => ({ u, k })));
  const recs: { tone: 'ok' | 'warn' | 'err'; title: string; desc: string; to?: string }[] = [
    { tone: 'warn', title: 'Agregue MFA para el usuario raíz', desc: 'Habilite la autenticación multifactor (MFA) para el usuario raíz y proteja los recursos de la cuenta.' },
    noMfa.length
      ? { tone: 'warn', title: `${noMfa.length} usuario(s) de IAM sin MFA`, desc: 'Active MFA en los usuarios con acceso a la consola o con claves de acceso.', to: '/iam/users' }
      : { tone: 'ok', title: 'Todos los usuarios de IAM tienen MFA', desc: 'No hay usuarios sin autenticación multifactor.' },
    oldKeys.length
      ? { tone: 'warn', title: `${oldKeys.length} clave(s) de acceso activas con más de 90 días`, desc: 'Rote las claves de acceso con regularidad.', to: '/iam/users' }
      : { tone: 'ok', title: 'Las claves de acceso están rotadas', desc: 'Ninguna clave activa supera los 90 días.' },
    s.users.length > 0 && s.users.some((u) => u.attached.includes('arn:aws:iam::aws:policy/AdministratorAccess'))
      ? { tone: 'warn', title: 'Hay usuarios con AdministratorAccess adjunta directamente', desc: 'Utilice grupos y aplique el principio de privilegio mínimo.', to: '/iam/users' }
      : { tone: 'ok', title: 'Sin administradores directos', desc: 'Ningún usuario tiene AdministratorAccess adjunta directamente.' },
  ];
  const customPols = s.policies.filter((p) => p.managed === 'customer').length;
  return (
    <>
      <Crumbs items={[{ label: 'IAM' }, { label: 'Panel' }]} />
      <PageHead title="Panel de IAM" />
      <div className="k-two" style={{ gridTemplateColumns: '3fr 2fr' }}>
        <div>
          <Card title="Recomendaciones de seguridad" count={recs.filter((r) => r.tone !== 'ok').length}>
            {recs.map((r) => (
              <div className="k-rec" key={r.title}>
                <span className={`ic ${r.tone}`}>{r.tone === 'ok' ? '✓' : '⚠'}</span>
                <div>
                  <b>{r.to ? <a onClick={() => nav(r.to!)}>{r.title}</a> : r.title}</b>
                  <small>{r.desc}</small>
                </div>
              </div>
            ))}
          </Card>
          <Card title="Recursos de IAM">
            <div className="k-three k-dl">
              <div><div className="k">Grupos de usuarios</div><div className="v"><a onClick={() => nav('/iam/groups')}>{s.groups.length}</a></div></div>
              <div><div className="k">Usuarios</div><div className="v"><a onClick={() => nav('/iam/users')}>{s.users.length}</a></div></div>
              <div><div className="k">Roles</div><div className="v"><a onClick={() => nav('/iam/roles')}>{s.roles.length}</a></div></div>
              <div><div className="k">Políticas</div><div className="v"><a onClick={() => nav('/iam/policies')}>{customPols}</a></div></div>
              <div><div className="k">Perfiles de instancia</div><div className="v">{s.instanceProfiles.length}</div></div>
              <div><div className="k">Proveedores de identidad</div><div className="v">0</div></div>
            </div>
          </Card>
        </div>
        <div>
          <Card title="Cuenta de AWS">
            <div className="k-dl" style={{ display: 'grid', gap: 14 }}>
              <div><div className="k">ID de cuenta</div><div className="v">{s.account.id}</div></div>
              <div>
                <div className="k">Alias de cuenta</div>
                <div className="v">{s.account.alias ?? <span className="k-muted">Ninguno</span>}</div>
              </div>
              <div>
                <div className="k">URL de inicio de sesión para los usuarios de IAM de esta cuenta</div>
                <div className="v">{`https://${s.account.alias ?? s.account.id}.signin.aws.amazon.com/console`}</div>
              </div>
              <div><div className="k">Correo electrónico del usuario raíz</div><div className="v">{s.account.rootEmail}</div></div>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

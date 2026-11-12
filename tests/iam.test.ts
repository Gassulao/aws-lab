import { describe, it, expect, beforeEach } from 'vitest';
import { freshState } from '../src/engine/store';
import { resolveCaller, type Ctx } from '../src/engine/api';
import * as iam from '../src/engine/services/iam';
import { AwsError } from '../src/engine/errors';
import type { CloudState } from '../src/engine/types';

let s: CloudState;
const admin = (): Ctx => ({ s, region: 'eu-west-1', caller: resolveCaller(s, s.users[0].accessKeys[0].id) });
const as = (key: string, token?: string): Ctx => ({ s, region: 'eu-west-1', caller: resolveCaller(s, key, token) });

beforeEach(() => {
  s = freshState('Ana');
});

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AwsError) return e.code;
    throw e;
  }
  return 'OK';
};

describe('IAM', () => {
  it('el usuario inicial es administrador y se identifica con STS', () => {
    const id = iam.getCallerIdentity(admin());
    expect(id.Arn).toBe(`arn:aws:iam::${s.account.id}:user/ana`);
  });

  it('un usuario nuevo no tiene permisos hasta que se le concede alguno', () => {
    iam.createUser(admin(), { UserName: 'luis' });
    const k = iam.createAccessKey(admin(), { UserName: 'luis' });
    expect(code(() => iam.listUsers(as(k.id)))).toBe('AccessDenied');
    iam.attachUserPolicy(admin(), { UserName: 'luis', PolicyArn: 'arn:aws:iam::aws:policy/IAMReadOnlyAccess' });
    expect(code(() => iam.listUsers(as(k.id)))).toBe('OK');
  });

  it('el mensaje de AccessDenied es el de AWS', () => {
    iam.createUser(admin(), { UserName: 'luis' });
    const k = iam.createAccessKey(admin(), { UserName: 'luis' });
    try {
      iam.listUsers(as(k.id));
    } catch (e: any) {
      expect(e.message).toContain('is not authorized to perform: iam:ListUsers');
      expect(e.message).toContain('because no identity-based policy allows the iam:ListUsers action');
    }
  });

  it('no se puede crear dos veces el mismo usuario', () => {
    iam.createUser(admin(), { UserName: 'luis' });
    expect(code(() => iam.createUser(admin(), { UserName: 'luis' }))).toBe('EntityAlreadyExists');
  });

  it('un usuario no puede tener más de dos claves de acceso', () => {
    iam.createAccessKey(admin(), { UserName: 'ana' });
    expect(code(() => iam.createAccessKey(admin(), { UserName: 'ana' }))).toBe('LimitExceeded');
  });

  it('un grupo concede permisos a sus miembros', () => {
    iam.createUser(admin(), { UserName: 'luis' });
    const k = iam.createAccessKey(admin(), { UserName: 'luis' });
    iam.createGroup(admin(), { GroupName: 'lectores' });
    iam.attachGroupPolicy(admin(), { GroupName: 'lectores', PolicyArn: 'arn:aws:iam::aws:policy/IAMReadOnlyAccess' });
    expect(code(() => iam.listRoles(as(k.id)))).toBe('AccessDenied');
    iam.addUserToGroup(admin(), { GroupName: 'lectores', UserName: 'luis' });
    expect(code(() => iam.listRoles(as(k.id)))).toBe('OK');
  });

  it('una política gestionada creada por el alumno se valida', () => {
    expect(code(() => iam.createPolicy(admin(), { PolicyName: 'mala', PolicyDocument: '{no es json' }))).toBe('MalformedPolicyDocument');
    expect(code(() => iam.createPolicy(admin(), { PolicyName: 'ok', PolicyDocument: JSON.stringify({ Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }] }) }))).toBe('OK');
  });

  it('no se borra un usuario con claves', () => {
    iam.createUser(admin(), { UserName: 'luis' });
    iam.createAccessKey(admin(), { UserName: 'luis' });
    expect(code(() => iam.deleteUser(admin(), { UserName: 'luis' }))).toBe('DeleteConflict');
  });
});

describe('STS', () => {
  const trust = (arn: string, mfa = false) =>
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { AWS: arn }, Action: 'sts:AssumeRole', ...(mfa ? { Condition: { Bool: { 'aws:MultiFactorAuthPresent': 'true' } } } : {}) }],
    });

  it('un rol asumido tiene los permisos del rol, no los del usuario', () => {
    const role = iam.createRole(admin(), { RoleName: 'lector-s3', AssumeRolePolicyDocument: trust(s.users[0].arn) });
    iam.attachRolePolicy(admin(), { RoleName: 'lector-s3', PolicyArn: 'arn:aws:iam::aws:policy/IAMReadOnlyAccess' });
    const r = iam.assumeRole(admin(), { RoleArn: role.arn, RoleSessionName: 'prueba' });
    const c = as(r.Credentials.AccessKeyId, r.Credentials.SessionToken);
    expect(iam.getCallerIdentity(c).Arn).toContain(':assumed-role/lector-s3/prueba');
    expect(code(() => iam.listRoles(c))).toBe('OK');
    expect(code(() => iam.createUser(c, { UserName: 'x' }))).toBe('AccessDenied');
  });

  it('la trust policy bloquea a quien no nombra', () => {
    iam.createUser(admin(), { UserName: 'luis' });
    const k = iam.createAccessKey(admin(), { UserName: 'luis' });
    iam.attachUserPolicy(admin(), { UserName: 'luis', PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess' });
    const role = iam.createRole(admin(), { RoleName: 'solo-ana', AssumeRolePolicyDocument: trust(s.users[0].arn) });
    expect(code(() => iam.assumeRole(as(k.id), { RoleArn: role.arn, RoleSessionName: 'x' }))).toBe('AccessDenied');
  });

  it('la trust policy con MFA exige código', () => {
    const role = iam.createRole(admin(), { RoleName: 'con-mfa', AssumeRolePolicyDocument: trust(s.users[0].arn, true) });
    expect(code(() => iam.assumeRole(admin(), { RoleArn: role.arn, RoleSessionName: 'x' }))).toBe('AccessDenied');
    const serial = iam.enableMfa(admin(), { UserName: 'ana' });
    expect(code(() => iam.assumeRole(admin(), { RoleArn: role.arn, RoleSessionName: 'x', SerialNumber: serial, TokenCode: '123456' }))).toBe('OK');
  });

  it('las credenciales caducan', () => {
    const role = iam.createRole(admin(), { RoleName: 'corto', AssumeRolePolicyDocument: trust(s.users[0].arn) });
    const r = iam.assumeRole(admin(), { RoleArn: role.arn, RoleSessionName: 'x', DurationSeconds: 900 });
    s.sessions[0].expiration = new Date(Date.now() - 1000).toISOString();
    expect(code(() => as(r.Credentials.AccessKeyId, r.Credentials.SessionToken))).toBe('ExpiredToken');
  });

  it('la política de sesión recorta los permisos del rol', () => {
    const role = iam.createRole(admin(), { RoleName: 'amplio', AssumeRolePolicyDocument: trust(s.users[0].arn) });
    iam.attachRolePolicy(admin(), { RoleName: 'amplio', PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess' });
    const r = iam.assumeRole(admin(), {
      RoleArn: role.arn,
      RoleSessionName: 'x',
      Policy: JSON.stringify({ Statement: [{ Effect: 'Allow', Action: 'iam:List*', Resource: '*' }] }),
    });
    const c = as(r.Credentials.AccessKeyId, r.Credentials.SessionToken);
    expect(code(() => iam.listRoles(c))).toBe('OK');
    expect(code(() => iam.createUser(c, { UserName: 'x' }))).toBe('AccessDenied');
  });

  it('CloudTrail registra las llamadas y los errores', () => {
    iam.createUser(admin(), { UserName: 'luis' });
    code(() => iam.createUser(admin(), { UserName: 'luis' }));
    const ev = s.trail.filter((e) => e.eventName === 'CreateUser');
    expect(ev).toHaveLength(2);
    expect(ev[1].errorCode).toBe('EntityAlreadyExists');
  });
});

describe('detach-group-policy y delete-group', () => {
  it('no se borra un grupo con miembros o políticas; vacío sí', async () => {
    const { freshState } = await import('../src/engine/store');
    const { newShell, runString } = await import('../src/shell');
    const sh = newShell(freshState('Ana'));
    const run = (c: string) => runString(sh, c);
    await run('aws iam create-group --group-name g1');
    await run('aws iam attach-group-policy --group-name g1 --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess');
    expect((await run('aws iam delete-group --group-name g1')).err).toContain('DeleteConflict');
    expect((await run('aws iam detach-group-policy --group-name g1 --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess')).code).toBe(0);
    expect((await run('aws iam delete-group --group-name g1')).code).toBe(0);
    expect((await run('aws iam delete-group --group-name g1')).err).toContain('NoSuchEntity');
  });
});

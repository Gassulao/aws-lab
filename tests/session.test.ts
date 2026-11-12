import { describe, it, expect, beforeEach } from 'vitest';
import { freshState } from '../src/engine/store';
import { assumePrincipal, defaultAdmin, findIamUser, accountMatches, accountLabel, signIn, signOut, getSession } from '../src/ui/session';
import { execLine, newShell } from '../src/shell';
import type { CloudState } from '../src/engine/types';

let s: CloudState;
const addUser = (name: string, attached: string[] = []) => {
  s.users.push({ arn: `arn:aws:iam::${s.account.id}:user/${name}`, name, id: 'AIDATEST' + name, path: '/', createdAt: '2024-01-01T00:00:00Z', tags: {}, attached, inline: {}, accessKeys: [], hasConsolePassword: true, mfaDevices: [] });
};

beforeEach(() => {
  s = freshState('Ana');
});

describe('sesión: principal', () => {
  it('un nombre desconocido entra como el administrador por defecto', () => {
    assumePrincipal(s, 'gassu');
    expect(s.me.userName).toBe('ana');
    expect(defaultAdmin(s)?.name).toBe('ana');
  });

  it('un usuario IAM existente (sin distinguir mayúsculas) pasa a ser el principal con credenciales propias', () => {
    addUser('marta');
    const u = assumePrincipal(s, 'Marta')!;
    expect(u.name).toBe('marta');
    expect(s.me).toEqual({ arn: u.arn, userName: 'marta' });
    expect(u.accessKeys).toHaveLength(1);
    expect(s.cli.profiles.default.accessKeyId).toBe(u.accessKeys[0].id);
    expect(s.cli.cwd).toBe('/home/marta');
    expect(s.fs.children!.home.children!.marta).toBeTruthy();
  });

  it('se aplican los permisos reales del usuario (sin políticas: AccessDenied) y se vuelve a administrador con otro nombre', async () => {
    addUser('marta');
    assumePrincipal(s, 'marta');
    const sh = newShell(s);
    const denied = await execLine(sh, 'aws iam list-users', 'typed');
    expect(denied.code).not.toBe(0);
    expect(denied.err).toMatch(/AccessDenied/);
    assumePrincipal(s, 'otra-persona');
    expect(s.me.userName).toBe('ana');
    const ok = await execLine(newShell(s), 'aws iam list-users', 'typed');
    expect(ok.code).toBe(0);
  });

  it('entrar de nuevo como el principal actual no toca el estado de la CLI', () => {
    s.cli.profiles.default.region = 'us-east-1';
    assumePrincipal(s, 'ana');
    expect(s.cli.profiles.default.region).toBe('us-east-1');
  });

  it('findIamUser y la cuenta', () => {
    expect(findIamUser(s, ' ANA ')?.name).toBe('ana');
    expect(accountMatches(s, s.account.id)).toBe(true);
    expect(accountMatches(s, s.account.id.replace(/(\d{4})(\d{4})(\d{4})/, '$1-$2-$3'))).toBe(true);
    expect(accountMatches(s, '000000000000')).toBe(false);
    s.account.alias = 'mi-empresa';
    expect(accountMatches(s, 'MI-EMPRESA')).toBe(true);
    expect(accountLabel(s)).toBe('mi-empresa');
  });
});

describe('sesión: ciclo (sin almacenamiento, como en Node)', () => {
  it('signIn guarda el nombre escrito y signOut lo quita', () => {
    const sess = signIn('gassu');
    expect(sess).toEqual({ user: 'gassu', root: false });
    expect(getSession()).toEqual(sess);
    expect(signIn('', { root: true }).user).toBe('raíz');
    try { signOut(); } catch { /* sin history en Node */ }
    expect(getSession()).toBeNull();
  });
});

// Puente de solo lectura entre AWS Organizations y la evaluación de políticas IAM (sin dependencias del resto del motor).
// Las SCP se evalúan en `evaluate` (policy.ts): una SCP deniega aunque IAM permita y toda SCP exige un Allow en cada nivel.
//
// Simplificación documentada: las cuentas miembro creadas con Organizations comparten el plano de recursos del simulador
// (no hay una cuenta aislada por cada una). Sirven para practicar el efecto de las SCP asumiendo el rol
// OrganizationAccountAccessRole, igual que en AWS. Las SCP nunca afectan a la cuenta de administración.
import type { CloudState, PolicyDocument } from './types';

export const MEMBER_ROLE = 'OrganizationAccountAccessRole';

export const accountOfArn = (arn: string): string => arn.split(':')[4] ?? '';

/** Cuenta miembro (no administración) de la organización, si existe. */
export function memberAccount(s: CloudState, id: string) {
  const org = s.gov?.org;
  const a = org?.accounts.find((x) => x.id === id);
  return org && a && !a.management ? a : undefined;
}

/** Niveles de SCP aplicables a una cuenta miembro: raíz, cada unidad organizativa hasta la cuenta y la propia cuenta. */
export function scpLevelsFor(s: CloudState, accountId: string): PolicyDocument[][] | undefined {
  const org = s.gov?.org;
  if (!org || !org.scpEnabled) return undefined;
  const acct = memberAccount(s, accountId);
  if (!acct) return undefined;
  const chain: string[] = [acct.id];
  let parent = acct.parentId;
  for (let guard = 0; guard < 10 && parent !== org.rootId; guard++) {
    chain.unshift(parent);
    parent = org.ous.find((o) => o.id === parent)?.parentId ?? org.rootId;
  }
  chain.unshift(org.rootId);
  return chain.map((target) =>
    org.policies
      .filter((p) => p.targets.includes(target))
      .flatMap((p) => {
        try {
          return [JSON.parse(p.content) as PolicyDocument];
        } catch {
          return [];
        }
      }),
  );
}

/** Rol de acceso a una cuenta miembro (arn:aws:iam::<cuenta>:role/OrganizationAccountAccessRole). */
export function memberRoleAccount(s: CloudState, roleArn: string): string | undefined {
  const m = /^arn:aws:iam::(\d{12}):role\/OrganizationAccountAccessRole$/.exec(roleArn);
  return m && memberAccount(s, m[1]) ? m[1] : undefined;
}

/** El rol OrganizationAccountAccessRole tiene AdministratorAccess en la cuenta miembro. */
export const MEMBER_ADMIN_DOCS: PolicyDocument[] = [{ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] }];

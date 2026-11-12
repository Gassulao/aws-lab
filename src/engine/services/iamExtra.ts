// IAM (operaciones complementarias): perfil de consola, etiquetas, MFA, alias de cuenta, política de contraseñas,
// políticas en línea, versiones de políticas y resumen de la cuenta.
import type { IamPolicy, PolicyDocument, PasswordPolicy } from '../types';
import { AwsError } from '../errors';
import { authorize, trailed, type Ctx } from '../api';
import { nowIso } from '../util';
import { validatePolicyDocument } from '../policy';
import { getUserOr, getRoleOr, getGroupOr, getPolicyOr } from './iam';

const SRC = 'iam.amazonaws.com';

function parseDoc(doc: string | PolicyDocument): PolicyDocument {
  let obj: any = doc;
  if (typeof doc === 'string') {
    try {
      obj = JSON.parse(doc);
    } catch {
      throw new AwsError('MalformedPolicyDocument', 'This policy contains invalid Json');
    }
  }
  return validatePolicyDocument(obj, 'identity');
}

// ------------------------------------------------------------------ perfil de inicio de sesión

export function defaultPolicy(): PasswordPolicy {
  return { MinimumPasswordLength: 8, RequireSymbols: true, RequireNumbers: true, RequireUppercaseCharacters: true, RequireLowercaseCharacters: true, AllowUsersToChangePassword: true, ExpirePasswords: false };
}

function checkPassword(ctx: Ctx, pw: string) {
  const pol = ctx.s.passwordPolicy;
  if (!pol) {
    // Política predeterminada de IAM: 8 caracteres y al menos 3 de 4 tipos.
    const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(pw)).length;
    if (pw.length < 8 || kinds < 3) throw new AwsError('PasswordPolicyViolation', 'Password does not conform to the account password policy.', 400);
    return;
  }
  const bad =
    pw.length < pol.MinimumPasswordLength ||
    (pol.RequireSymbols && !/[^a-zA-Z0-9]/.test(pw)) ||
    (pol.RequireNumbers && !/[0-9]/.test(pw)) ||
    (pol.RequireUppercaseCharacters && !/[A-Z]/.test(pw)) ||
    (pol.RequireLowercaseCharacters && !/[a-z]/.test(pw));
  if (bad) throw new AwsError('PasswordPolicyViolation', 'Password does not conform to the account password policy.', 400);
}

export function createLoginProfile(ctx: Ctx, p: { UserName: string; Password: string; PasswordResetRequired?: boolean }) {
  return trailed(ctx, SRC, 'CreateLoginProfile', [{ type: 'AWS::IAM::User', name: p.UserName }], { UserName: p.UserName, PasswordResetRequired: p.PasswordResetRequired }, () => {
    const u = getUserOr(ctx, p.UserName);
    authorize(ctx, 'iam:CreateLoginProfile', u.arn);
    if (u.loginProfile || u.hasConsolePassword) throw new AwsError('EntityAlreadyExists', `Login Profile for User ${u.name} already exists.`, 409);
    checkPassword(ctx, p.Password);
    u.loginProfile = { createdAt: nowIso(), resetRequired: !!p.PasswordResetRequired };
    u.hasConsolePassword = true;
    return { UserName: u.name, CreateDate: u.loginProfile.createdAt, PasswordResetRequired: u.loginProfile.resetRequired };
  });
}

export function getLoginProfile(ctx: Ctx, p: { UserName: string }) {
  return trailed(ctx, SRC, 'GetLoginProfile', [], p, () => {
    const u = getUserOr(ctx, p.UserName);
    authorize(ctx, 'iam:GetLoginProfile', u.arn);
    if (!u.hasConsolePassword) throw new AwsError('NoSuchEntity', `Login Profile for User ${u.name} cannot be found.`, 404);
    return { UserName: u.name, CreateDate: u.loginProfile?.createdAt ?? u.createdAt, PasswordResetRequired: u.loginProfile?.resetRequired ?? false };
  });
}

export function deleteLoginProfile(ctx: Ctx, p: { UserName: string }): void {
  trailed(ctx, SRC, 'DeleteLoginProfile', [{ type: 'AWS::IAM::User', name: p.UserName }], p, () => {
    const u = getUserOr(ctx, p.UserName);
    authorize(ctx, 'iam:DeleteLoginProfile', u.arn);
    if (!u.hasConsolePassword) throw new AwsError('NoSuchEntity', `Login Profile for User ${u.name} cannot be found.`, 404);
    u.hasConsolePassword = false;
    delete u.loginProfile;
  });
}

// ------------------------------------------------------------------ etiquetas

type TagIn = { Key: string; Value: string };
function checkTags(tags: TagIn[]) {
  for (const t of tags) if (!t.Key || t.Key.length > 128) throw new AwsError('ValidationError', `1 validation error detected: Value '${t.Key}' at 'tags.1.member.key' failed to satisfy constraint: Member must have length less than or equal to 128`);
}

export function tagUser(ctx: Ctx, p: { UserName: string; Tags: TagIn[] }): void {
  trailed(ctx, SRC, 'TagUser', [{ type: 'AWS::IAM::User', name: p.UserName }], p, () => {
    const u = getUserOr(ctx, p.UserName);
    authorize(ctx, 'iam:TagUser', u.arn);
    checkTags(p.Tags);
    for (const t of p.Tags) u.tags[t.Key] = t.Value;
    if (Object.keys(u.tags).length > 50) throw new AwsError('LimitExceeded', 'Cannot exceed quota for TagsPerUser: 50', 409);
  });
}
export function untagUser(ctx: Ctx, p: { UserName: string; TagKeys: string[] }): void {
  trailed(ctx, SRC, 'UntagUser', [{ type: 'AWS::IAM::User', name: p.UserName }], p, () => {
    const u = getUserOr(ctx, p.UserName);
    authorize(ctx, 'iam:UntagUser', u.arn);
    for (const k of p.TagKeys) delete u.tags[k];
  });
}
export function listUserTags(ctx: Ctx, p: { UserName: string }) {
  return trailed(ctx, SRC, 'ListUserTags', [], p, () => {
    const u = getUserOr(ctx, p.UserName);
    authorize(ctx, 'iam:ListUserTags', u.arn);
    return Object.entries(u.tags).map(([Key, Value]) => ({ Key, Value }));
  });
}
export function tagRole(ctx: Ctx, p: { RoleName: string; Tags: TagIn[] }): void {
  trailed(ctx, SRC, 'TagRole', [{ type: 'AWS::IAM::Role', name: p.RoleName }], p, () => {
    const r = getRoleOr(ctx, p.RoleName);
    authorize(ctx, 'iam:TagRole', r.arn);
    checkTags(p.Tags);
    for (const t of p.Tags) r.tags[t.Key] = t.Value;
  });
}
export function untagRole(ctx: Ctx, p: { RoleName: string; TagKeys: string[] }): void {
  trailed(ctx, SRC, 'UntagRole', [{ type: 'AWS::IAM::Role', name: p.RoleName }], p, () => {
    const r = getRoleOr(ctx, p.RoleName);
    authorize(ctx, 'iam:UntagRole', r.arn);
    for (const k of p.TagKeys) delete r.tags[k];
  });
}
export function listRoleTags(ctx: Ctx, p: { RoleName: string }) {
  return trailed(ctx, SRC, 'ListRoleTags', [], p, () => {
    const r = getRoleOr(ctx, p.RoleName);
    authorize(ctx, 'iam:ListRoleTags', r.arn);
    return Object.entries(r.tags).map(([Key, Value]) => ({ Key, Value }));
  });
}

// ------------------------------------------------------------------ MFA

export function createVirtualMfaDevice(ctx: Ctx, p: { VirtualMFADeviceName: string; Path?: string }) {
  return trailed(ctx, SRC, 'CreateVirtualMFADevice', [], p, () => {
    const serial = `arn:aws:iam::${ctx.s.account.id}:mfa${p.Path ?? '/'}${p.VirtualMFADeviceName}`;
    authorize(ctx, 'iam:CreateVirtualMFADevice', serial);
    if (ctx.s.virtualMfa.some((m) => m.serial === serial)) throw new AwsError('EntityAlreadyExists', `MFADevice entity at the same path and name already exists.`, 409);
    ctx.s.virtualMfa.push({ serial, name: p.VirtualMFADeviceName });
    // Semilla Base32 determinista a partir del nombre (no es una semilla TOTP real).
    const seed = btoa(serial).replace(/[^A-Za-z2-7]/g, '').toUpperCase().padEnd(32, 'A').slice(0, 32);
    return { SerialNumber: serial, Base32StringSeed: seed, QRCodePNG: '' };
  });
}
export function listVirtualMfaDevices(ctx: Ctx) {
  return trailed(ctx, SRC, 'ListVirtualMFADevices', [], {}, () => {
    authorize(ctx, 'iam:ListVirtualMFADevices', '*');
    return ctx.s.virtualMfa.map((m) => ({ SerialNumber: m.serial, ...(m.user ? { User: getUserOr(ctx, m.user), EnableDate: m.enabledAt } : {}) }));
  });
}
export function listMfaDevices(ctx: Ctx, p: { UserName?: string }) {
  return trailed(ctx, SRC, 'ListMFADevices', [], p, () => {
    const u = getUserOr(ctx, p.UserName ?? ctx.caller.userName);
    authorize(ctx, 'iam:ListMFADevices', u.arn);
    return u.mfaDevices.map((serial) => ({ UserName: u.name, SerialNumber: serial, EnableDate: ctx.s.virtualMfa.find((m) => m.serial === serial)?.enabledAt ?? u.createdAt }));
  });
}
export function deactivateMfaDevice(ctx: Ctx, p: { UserName: string; SerialNumber: string }): void {
  trailed(ctx, SRC, 'DeactivateMFADevice', [], p, () => {
    const u = getUserOr(ctx, p.UserName);
    authorize(ctx, 'iam:DeactivateMFADevice', u.arn);
    if (!u.mfaDevices.includes(p.SerialNumber)) throw new AwsError('NoSuchEntity', `MFA Device with serial number ${p.SerialNumber} does not exist.`, 404);
    u.mfaDevices = u.mfaDevices.filter((x) => x !== p.SerialNumber);
    const reg = ctx.s.virtualMfa.find((m) => m.serial === p.SerialNumber);
    if (reg) {
      delete reg.user;
      delete reg.enabledAt;
    }
  });
}
export function deleteVirtualMfaDevice(ctx: Ctx, p: { SerialNumber: string }): void {
  trailed(ctx, SRC, 'DeleteVirtualMFADevice', [], p, () => {
    authorize(ctx, 'iam:DeleteVirtualMFADevice', p.SerialNumber);
    const reg = ctx.s.virtualMfa.find((m) => m.serial === p.SerialNumber);
    if (!reg) throw new AwsError('NoSuchEntity', `Virtual MFA Device ${p.SerialNumber} does not exist.`, 404);
    if (reg.user) throw new AwsError('DeleteConflict', 'Cannot delete a virtual MFA device that is enabled for a user.', 409);
    ctx.s.virtualMfa = ctx.s.virtualMfa.filter((m) => m !== reg);
  });
}

// ------------------------------------------------------------------ alias de cuenta

const ALIAS_RE = /^[a-z0-9](([a-z0-9]|-(?!-))*[a-z0-9])?$/;
export function createAccountAlias(ctx: Ctx, p: { AccountAlias: string }): void {
  trailed(ctx, SRC, 'CreateAccountAlias', [], p, () => {
    authorize(ctx, 'iam:CreateAccountAlias', '*');
    if (p.AccountAlias.length < 3 || p.AccountAlias.length > 63 || !ALIAS_RE.test(p.AccountAlias)) {
      throw new AwsError('ValidationError', `1 validation error detected: Value '${p.AccountAlias}' at 'accountAlias' failed to satisfy constraint: Member must satisfy regular expression pattern: ^[a-z0-9](([a-z0-9]|-(?!-))*[a-z0-9])?$`);
    }
    if (ctx.s.account.alias === p.AccountAlias) throw new AwsError('EntityAlreadyExists', `The account alias ${p.AccountAlias} already exists.`, 409);
    if (ctx.s.account.alias) throw new AwsError('LimitExceeded', 'Cannot exceed quota for AccountAliasesPerAccount: 1', 409);
    if (['admin', 'aws', 'amazon', 'prod', 'test', 'dev'].includes(p.AccountAlias)) throw new AwsError('EntityAlreadyExists', `The account alias ${p.AccountAlias} already exists.`, 409);
    ctx.s.account.alias = p.AccountAlias;
  });
}
export function listAccountAliases(ctx: Ctx): string[] {
  return trailed(ctx, SRC, 'ListAccountAliases', [], {}, () => {
    authorize(ctx, 'iam:ListAccountAliases', '*');
    return ctx.s.account.alias ? [ctx.s.account.alias] : [];
  });
}
export function deleteAccountAlias(ctx: Ctx, p: { AccountAlias: string }): void {
  trailed(ctx, SRC, 'DeleteAccountAlias', [], p, () => {
    authorize(ctx, 'iam:DeleteAccountAlias', '*');
    if (ctx.s.account.alias !== p.AccountAlias) throw new AwsError('NoSuchEntity', `The account alias ${p.AccountAlias} cannot be found.`, 404);
    delete ctx.s.account.alias;
  });
}

// ------------------------------------------------------------------ política de contraseñas

export function getAccountPasswordPolicy(ctx: Ctx): PasswordPolicy {
  return trailed(ctx, SRC, 'GetAccountPasswordPolicy', [], {}, () => {
    authorize(ctx, 'iam:GetAccountPasswordPolicy', '*');
    if (!ctx.s.passwordPolicy) throw new AwsError('NoSuchEntity', `The Password Policy with domain name ${ctx.s.account.id} cannot be found.`, 404);
    return ctx.s.passwordPolicy;
  });
}
export function updateAccountPasswordPolicy(ctx: Ctx, p: Partial<PasswordPolicy>): void {
  trailed(ctx, SRC, 'UpdateAccountPasswordPolicy', [], p, () => {
    authorize(ctx, 'iam:UpdateAccountPasswordPolicy', '*');
    const min = p.MinimumPasswordLength;
    if (min !== undefined && (min < 6 || min > 128)) throw new AwsError('ValidationError', `1 validation error detected: Value '${min}' at 'minimumPasswordLength' failed to satisfy constraint: Member must have value ${min < 6 ? 'greater' : 'less'} than or equal to ${min < 6 ? 6 : 128}`);
    const age = p.MaxPasswordAge;
    if (age !== undefined && (age < 0 || age > 1095)) throw new AwsError('ValidationError', `1 validation error detected: Value '${age}' at 'maxPasswordAge' failed to satisfy constraint: Member must have value less than or equal to 1095`);
    const prev = ctx.s.passwordPolicy ?? { MinimumPasswordLength: 6, RequireSymbols: false, RequireNumbers: false, RequireUppercaseCharacters: false, RequireLowercaseCharacters: false, AllowUsersToChangePassword: false, ExpirePasswords: false };
    const next: PasswordPolicy = { ...prev, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) } as PasswordPolicy;
    next.ExpirePasswords = !!next.MaxPasswordAge && next.MaxPasswordAge > 0;
    ctx.s.passwordPolicy = next;
  });
}
export function deleteAccountPasswordPolicy(ctx: Ctx): void {
  trailed(ctx, SRC, 'DeleteAccountPasswordPolicy', [], {}, () => {
    authorize(ctx, 'iam:DeleteAccountPasswordPolicy', '*');
    if (!ctx.s.passwordPolicy) throw new AwsError('NoSuchEntity', `The Password Policy with domain name ${ctx.s.account.id} cannot be found.`, 404);
    delete ctx.s.passwordPolicy;
  });
}

// ------------------------------------------------------------------ resumen de la cuenta

export function getAccountSummary(ctx: Ctx) {
  return trailed(ctx, SRC, 'GetAccountSummary', [], {}, () => {
    authorize(ctx, 'iam:GetAccountSummary', '*');
    const s = ctx.s;
    const root = 0;
    return {
      GroupPolicySizeQuota: 5120, InstanceProfilesQuota: 1000, Policies: s.policies.filter((p) => p.managed === 'customer').length,
      GroupsPerUserQuota: 10, InstanceProfiles: s.instanceProfiles.length, AttachedPoliciesPerUserQuota: 10, Users: s.users.length,
      PoliciesQuota: 1500, Providers: 0, AccountMFAEnabled: root, AccessKeysPerUserQuota: 2, AssumeRolePolicySizeQuota: 2048,
      PolicyVersionsInUseQuota: 10000, GlobalEndpointTokenVersion: 1, VersionsPerPolicyQuota: 5, AttachedPoliciesPerGroupQuota: 10,
      PolicySizeQuota: 6144, Groups: s.groups.length, AccountSigningCertificatesPresent: 0, UsersQuota: 5000, ServerCertificatesQuota: 20,
      MFADevices: s.users.reduce((n, u) => n + u.mfaDevices.length, 0), UserPolicySizeQuota: 2048, PolicyVersionsInUse: s.policies.filter((p) => p.attachmentCount > 0).length,
      ServerCertificates: 0, Roles: s.roles.length, RolesQuota: 1000, SigningCertificatesPerUserQuota: 2, MFADevicesInUse: s.users.reduce((n, u) => n + u.mfaDevices.length, 0),
      RolePolicySizeQuota: 10240, AttachedPoliciesPerRoleQuota: 10, AccountAccessKeysPresent: 0, GroupsQuota: 300,
    };
  });
}

// ------------------------------------------------------------------ grupos y entidades

export function listGroupsForUser(ctx: Ctx, p: { UserName: string }) {
  return trailed(ctx, SRC, 'ListGroupsForUser', [], p, () => {
    const u = getUserOr(ctx, p.UserName);
    authorize(ctx, 'iam:ListGroupsForUser', u.arn);
    return ctx.s.groups.filter((g) => g.members.includes(u.name));
  });
}
export function listAttachedGroupPolicies(ctx: Ctx, p: { GroupName: string }) {
  return trailed(ctx, SRC, 'ListAttachedGroupPolicies', [], p, () => {
    const g = getGroupOr(ctx, p.GroupName);
    authorize(ctx, 'iam:ListAttachedGroupPolicies', g.arn);
    return g.attached.map((a) => ({ PolicyName: getPolicyOr(ctx, a).name, PolicyArn: a }));
  });
}
export function listEntitiesForPolicy(ctx: Ctx, p: { PolicyArn: string; EntityFilter?: string }) {
  return trailed(ctx, SRC, 'ListEntitiesForPolicy', [], p, () => {
    authorize(ctx, 'iam:ListEntitiesForPolicy', p.PolicyArn);
    getPolicyOr(ctx, p.PolicyArn);
    const f = p.EntityFilter;
    return {
      PolicyGroups: !f || f === 'Group' ? ctx.s.groups.filter((g) => g.attached.includes(p.PolicyArn)).map((g) => ({ GroupName: g.name, GroupId: g.id })) : [],
      PolicyUsers: !f || f === 'User' ? ctx.s.users.filter((u) => u.attached.includes(p.PolicyArn)).map((u) => ({ UserName: u.name, UserId: u.id })) : [],
      PolicyRoles: !f || f === 'Role' ? ctx.s.roles.filter((r) => r.attached.includes(p.PolicyArn)).map((r) => ({ RoleName: r.name, RoleId: r.id })) : [],
    };
  });
}

// ------------------------------------------------------------------ políticas en línea

export function listRolePolicies(ctx: Ctx, p: { RoleName: string }): string[] {
  return trailed(ctx, SRC, 'ListRolePolicies', [], p, () => {
    const r = getRoleOr(ctx, p.RoleName);
    authorize(ctx, 'iam:ListRolePolicies', r.arn);
    return Object.keys(r.inline);
  });
}
export function listUserPolicies(ctx: Ctx, p: { UserName: string }): string[] {
  return trailed(ctx, SRC, 'ListUserPolicies', [], p, () => {
    const u = getUserOr(ctx, p.UserName);
    authorize(ctx, 'iam:ListUserPolicies', u.arn);
    return Object.keys(u.inline);
  });
}
export function getRolePolicy(ctx: Ctx, p: { RoleName: string; PolicyName: string }) {
  return trailed(ctx, SRC, 'GetRolePolicy', [], p, () => {
    const r = getRoleOr(ctx, p.RoleName);
    authorize(ctx, 'iam:GetRolePolicy', r.arn);
    const d = r.inline[p.PolicyName];
    if (!d) throw new AwsError('NoSuchEntity', `The role policy with name ${p.PolicyName} cannot be found.`, 404);
    return { RoleName: r.name, PolicyName: p.PolicyName, PolicyDocument: d };
  });
}
export function getUserPolicy(ctx: Ctx, p: { UserName: string; PolicyName: string }) {
  return trailed(ctx, SRC, 'GetUserPolicy', [], p, () => {
    const u = getUserOr(ctx, p.UserName);
    authorize(ctx, 'iam:GetUserPolicy', u.arn);
    const d = u.inline[p.PolicyName];
    if (!d) throw new AwsError('NoSuchEntity', `The user policy with name ${p.PolicyName} cannot be found.`, 404);
    return { UserName: u.name, PolicyName: p.PolicyName, PolicyDocument: d };
  });
}
export function deleteRolePolicy(ctx: Ctx, p: { RoleName: string; PolicyName: string }): void {
  trailed(ctx, SRC, 'DeleteRolePolicy', [], p, () => {
    const r = getRoleOr(ctx, p.RoleName);
    authorize(ctx, 'iam:DeleteRolePolicy', r.arn);
    if (!r.inline[p.PolicyName]) throw new AwsError('NoSuchEntity', `The role policy with name ${p.PolicyName} cannot be found.`, 404);
    delete r.inline[p.PolicyName];
  });
}
export function deleteUserPolicy(ctx: Ctx, p: { UserName: string; PolicyName: string }): void {
  trailed(ctx, SRC, 'DeleteUserPolicy', [], p, () => {
    const u = getUserOr(ctx, p.UserName);
    authorize(ctx, 'iam:DeleteUserPolicy', u.arn);
    if (!u.inline[p.PolicyName]) throw new AwsError('NoSuchEntity', `The user policy with name ${p.PolicyName} cannot be found.`, 404);
    delete u.inline[p.PolicyName];
  });
}

// ------------------------------------------------------------------ versiones de políticas

export function versionsOf(pol: IamPolicy) {
  return (pol.versions ??= [{ id: pol.defaultVersion, document: pol.document, createdAt: pol.createdAt }]);
}

export function createPolicyVersion(ctx: Ctx, p: { PolicyArn: string; PolicyDocument: string | PolicyDocument; SetAsDefault?: boolean }) {
  return trailed(ctx, SRC, 'CreatePolicyVersion', [], { PolicyArn: p.PolicyArn, SetAsDefault: p.SetAsDefault }, () => {
    authorize(ctx, 'iam:CreatePolicyVersion', p.PolicyArn);
    const pol = getPolicyOr(ctx, p.PolicyArn);
    if (pol.managed === 'aws') throw new AwsError('AccessDenied', `Policy ${p.PolicyArn} is an AWS managed policy and cannot be modified.`, 403);
    const doc = parseDoc(p.PolicyDocument);
    const vs = versionsOf(pol);
    if (vs.length >= 5) throw new AwsError('LimitExceeded', 'A managed policy can have up to 5 versions. Before you create a new version, you must delete an existing version.', 409);
    const n = Math.max(...vs.map((v) => Number(v.id.slice(1)))) + 1;
    const v = { id: `v${n}`, document: doc, createdAt: nowIso() };
    vs.push(v);
    if (p.SetAsDefault) {
      pol.defaultVersion = v.id;
      pol.document = doc;
    }
    return { VersionId: v.id, IsDefaultVersion: pol.defaultVersion === v.id, CreateDate: v.createdAt };
  });
}
export function listPolicyVersions(ctx: Ctx, p: { PolicyArn: string }) {
  return trailed(ctx, SRC, 'ListPolicyVersions', [], p, () => {
    authorize(ctx, 'iam:ListPolicyVersions', p.PolicyArn);
    const pol = getPolicyOr(ctx, p.PolicyArn);
    return [...versionsOf(pol)].reverse().map((v) => ({ VersionId: v.id, IsDefaultVersion: v.id === pol.defaultVersion, CreateDate: v.createdAt }));
  });
}
export function getPolicyVersion(ctx: Ctx, p: { PolicyArn: string; VersionId: string }) {
  return trailed(ctx, SRC, 'GetPolicyVersion', [], p, () => {
    authorize(ctx, 'iam:GetPolicyVersion', p.PolicyArn);
    const pol = getPolicyOr(ctx, p.PolicyArn);
    const v = versionsOf(pol).find((x) => x.id === p.VersionId);
    if (!v) throw new AwsError('NoSuchEntity', `Policy ${p.PolicyArn} version ${p.VersionId} does not exist or is not attachable.`, 404);
    return { Document: v.document, VersionId: v.id, IsDefaultVersion: v.id === pol.defaultVersion, CreateDate: v.createdAt };
  });
}
export function setDefaultPolicyVersion(ctx: Ctx, p: { PolicyArn: string; VersionId: string }): void {
  trailed(ctx, SRC, 'SetDefaultPolicyVersion', [], p, () => {
    authorize(ctx, 'iam:SetDefaultPolicyVersion', p.PolicyArn);
    const pol = getPolicyOr(ctx, p.PolicyArn);
    const v = versionsOf(pol).find((x) => x.id === p.VersionId);
    if (!v) throw new AwsError('NoSuchEntity', `Policy ${p.PolicyArn} version ${p.VersionId} does not exist or is not attachable.`, 404);
    pol.defaultVersion = v.id;
    pol.document = v.document;
  });
}
export function deletePolicyVersion(ctx: Ctx, p: { PolicyArn: string; VersionId: string }): void {
  trailed(ctx, SRC, 'DeletePolicyVersion', [], p, () => {
    authorize(ctx, 'iam:DeletePolicyVersion', p.PolicyArn);
    const pol = getPolicyOr(ctx, p.PolicyArn);
    const vs = versionsOf(pol);
    const v = vs.find((x) => x.id === p.VersionId);
    if (!v) throw new AwsError('NoSuchEntity', `Policy ${p.PolicyArn} version ${p.VersionId} does not exist or is not attachable.`, 404);
    if (v.id === pol.defaultVersion) throw new AwsError('DeleteConflict', 'Cannot delete the default version of a policy.', 409);
    pol.versions = vs.filter((x) => x !== v);
  });
}

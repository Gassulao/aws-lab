// IAM y STS: usuarios, grupos, roles, políticas, claves de acceso, perfiles de instancia y credenciales temporales.
import type { IamPolicy, IamRole, IamUser, IamGroup, PolicyDocument, Session, Tags } from '../types';
import { AwsError } from '../errors';
import { authorize, check, trailed, type Ctx, requestContext } from '../api';
import { ids } from '../ids';
import { nowIso, now, clone } from '../util';
import { validatePolicyDocument, trustAllows, evaluate, statements } from '../policy';
import { accountOfArn, memberRoleAccount } from '../orgPolicy';

const SRC = 'iam.amazonaws.com';
const NAME_RE = /^[\w+=,.@-]{1,64}$/;

function arnFor(ctx: Ctx, kind: string, path: string, name: string) {
  return `arn:aws:iam::${ctx.s.account.id}:${kind}${path}${name}`;
}

function normPath(p?: string): string {
  if (!p) return '/';
  let x = p.startsWith('/') ? p : `/${p}`;
  if (!x.endsWith('/')) x += '/';
  return x;
}

function checkName(kind: string, name: string) {
  if (!NAME_RE.test(name)) {
    throw new AwsError('ValidationError', `1 validation error detected: Value '${name}' at '${kind}Name' failed to satisfy constraint: Member must satisfy regular expression pattern: [\\w+=,.@-]+`);
  }
}

export function getUserOr(ctx: Ctx, name: string): IamUser {
  const u = ctx.s.users.find((x) => x.name === name);
  if (!u) throw new AwsError('NoSuchEntity', `The user with name ${name} cannot be found.`, 404);
  return u;
}
export function getRoleOr(ctx: Ctx, name: string): IamRole {
  const r = ctx.s.roles.find((x) => x.name === name);
  if (!r) throw new AwsError('NoSuchEntity', `The role with name ${name} cannot be found.`, 404);
  return r;
}
export function getGroupOr(ctx: Ctx, name: string): IamGroup {
  const g = ctx.s.groups.find((x) => x.name === name);
  if (!g) throw new AwsError('NoSuchEntity', `The group with name ${name} cannot be found.`, 404);
  return g;
}
export function getPolicyOr(ctx: Ctx, arn: string): IamPolicy {
  const p = ctx.s.policies.find((x) => x.arn === arn);
  if (!p) throw new AwsError('NoSuchEntity', `Policy ${arn} was not found.`, 404);
  return p;
}

function parseDoc(doc: string | PolicyDocument, kind: 'identity' | 'trust' = 'identity'): PolicyDocument {
  let obj: any = doc;
  if (typeof doc === 'string') {
    try {
      obj = JSON.parse(doc);
    } catch {
      throw new AwsError('MalformedPolicyDocument', 'This policy contains invalid Json');
    }
  }
  return validatePolicyDocument(obj, kind);
}

const toTags = (t?: { Key: string; Value: string }[] | Tags): Tags => {
  if (!t) return {};
  if (Array.isArray(t)) return Object.fromEntries(t.map((x) => [x.Key, x.Value]));
  return { ...t };
};

// ------------------------------------------------------------------ usuarios

export function createUser(ctx: Ctx, p: { UserName: string; Path?: string; Tags?: any; PermissionsBoundary?: string }): IamUser {
  const path = normPath(p.Path);
  return trailed(ctx, SRC, 'CreateUser', [{ type: 'AWS::IAM::User', name: p.UserName }], p, () => {
    checkName('User', p.UserName);
    authorize(ctx, 'iam:CreateUser', arnFor(ctx, 'user', path, p.UserName));
    if (ctx.s.users.some((u) => u.name === p.UserName)) throw new AwsError('EntityAlreadyExists', `User with name ${p.UserName} already exists.`, 409);
    const u: IamUser = {
      arn: arnFor(ctx, 'user', path, p.UserName),
      name: p.UserName,
      id: ids.iamId('AIDA'),
      path,
      createdAt: nowIso(),
      tags: toTags(p.Tags),
      attached: [],
      inline: {},
      accessKeys: [],
      hasConsolePassword: false,
      mfaDevices: [],
      permissionsBoundary: p.PermissionsBoundary,
    };
    ctx.s.users.push(u);
    return u;
  });
}

export function getUser(ctx: Ctx, p: { UserName?: string }): IamUser {
  return trailed(ctx, SRC, 'GetUser', [], p, () => {
    const name = p.UserName ?? (ctx.caller.type === 'IAMUser' ? ctx.caller.userName : undefined);
    if (!name) throw new AwsError('ValidationError', 'Must specify userName when calling with non-User credentials');
    const u = getUserOr(ctx, name);
    authorize(ctx, 'iam:GetUser', u.arn);
    return u;
  });
}

export function listUsers(ctx: Ctx): IamUser[] {
  return trailed(ctx, SRC, 'ListUsers', [], {}, () => {
    authorize(ctx, 'iam:ListUsers', `arn:aws:iam::${ctx.s.account.id}:user/`);
    return ctx.s.users;
  });
}

export function deleteUser(ctx: Ctx, p: { UserName: string }): void {
  trailed(ctx, SRC, 'DeleteUser', [{ type: 'AWS::IAM::User', name: p.UserName }], p, () => {
    const u = getUserOr(ctx, p.UserName);
    authorize(ctx, 'iam:DeleteUser', u.arn);
    if (u.accessKeys.length) throw new AwsError('DeleteConflict', 'Cannot delete entity, must delete access keys first.', 409);
    if (u.attached.length || Object.keys(u.inline).length) throw new AwsError('DeleteConflict', 'Cannot delete entity, must detach all policies first.', 409);
    if (ctx.s.groups.some((g) => g.members.includes(u.name))) throw new AwsError('DeleteConflict', 'Cannot delete entity, must remove users from group first.', 409);
    ctx.s.users = ctx.s.users.filter((x) => x !== u);
  });
}

export function createAccessKey(ctx: Ctx, p: { UserName?: string }) {
  return trailed(ctx, SRC, 'CreateAccessKey', [], p, () => {
    const name = p.UserName ?? ctx.caller.userName;
    const u = getUserOr(ctx, name);
    authorize(ctx, 'iam:CreateAccessKey', u.arn);
    if (u.accessKeys.length >= 2) throw new AwsError('LimitExceeded', 'Cannot exceed quota for AccessKeysPerUser: 2', 409);
    const k = { id: ids.accessKeyId(), secret: ids.secretKey(), status: 'Active' as const, createdAt: nowIso() };
    u.accessKeys.push(k);
    return { UserName: u.name, ...k };
  });
}

export function listAccessKeys(ctx: Ctx, p: { UserName?: string }) {
  return trailed(ctx, SRC, 'ListAccessKeys', [], p, () => {
    const u = getUserOr(ctx, p.UserName ?? ctx.caller.userName);
    authorize(ctx, 'iam:ListAccessKeys', u.arn);
    return u.accessKeys.map((k) => ({ UserName: u.name, AccessKeyId: k.id, Status: k.status, CreateDate: k.createdAt }));
  });
}

export function updateAccessKey(ctx: Ctx, p: { UserName?: string; AccessKeyId: string; Status: 'Active' | 'Inactive' }): void {
  trailed(ctx, SRC, 'UpdateAccessKey', [], p, () => {
    const u = getUserOr(ctx, p.UserName ?? ctx.caller.userName);
    authorize(ctx, 'iam:UpdateAccessKey', u.arn);
    const k = u.accessKeys.find((x) => x.id === p.AccessKeyId);
    if (!k) throw new AwsError('NoSuchEntity', `The Access Key with id ${p.AccessKeyId} cannot be found.`, 404);
    k.status = p.Status;
  });
}

export function deleteAccessKey(ctx: Ctx, p: { UserName?: string; AccessKeyId: string }): void {
  trailed(ctx, SRC, 'DeleteAccessKey', [], p, () => {
    const u = getUserOr(ctx, p.UserName ?? ctx.caller.userName);
    authorize(ctx, 'iam:DeleteAccessKey', u.arn);
    const k = u.accessKeys.find((x) => x.id === p.AccessKeyId);
    if (!k) throw new AwsError('NoSuchEntity', `The Access Key with id ${p.AccessKeyId} cannot be found.`, 404);
    u.accessKeys = u.accessKeys.filter((x) => x !== k);
  });
}

/** Registra un dispositivo MFA virtual y lo asocia al usuario (simplificado). */
export function enableMfa(ctx: Ctx, p: { UserName: string; SerialNumber?: string }): string {
  return trailed(ctx, SRC, 'EnableMFADevice', [], p, () => {
    const u = getUserOr(ctx, p.UserName);
    authorize(ctx, 'iam:EnableMFADevice', u.arn);
    const serial = p.SerialNumber ?? `arn:aws:iam::${ctx.s.account.id}:mfa/${u.name}`;
    if (!u.mfaDevices.includes(serial)) u.mfaDevices.push(serial);
    const reg = ctx.s.virtualMfa.find((m) => m.serial === serial);
    if (reg) {
      reg.user = u.name;
      reg.enabledAt = nowIso();
    } else ctx.s.virtualMfa.push({ serial, name: serial.split('/').pop()!, user: u.name, enabledAt: nowIso() });
    return serial;
  });
}

// ------------------------------------------------------------------ grupos

export function createGroup(ctx: Ctx, p: { GroupName: string; Path?: string }): IamGroup {
  const path = normPath(p.Path);
  return trailed(ctx, SRC, 'CreateGroup', [{ type: 'AWS::IAM::Group', name: p.GroupName }], p, () => {
    checkName('Group', p.GroupName);
    authorize(ctx, 'iam:CreateGroup', arnFor(ctx, 'group', path, p.GroupName));
    if (ctx.s.groups.some((g) => g.name === p.GroupName)) throw new AwsError('EntityAlreadyExists', `Group with name ${p.GroupName} already exists.`, 409);
    const g: IamGroup = { arn: arnFor(ctx, 'group', path, p.GroupName), name: p.GroupName, id: ids.iamId('AGPA'), path, createdAt: nowIso(), members: [], attached: [], inline: {} };
    ctx.s.groups.push(g);
    return g;
  });
}

export function listGroups(ctx: Ctx): IamGroup[] {
  return trailed(ctx, SRC, 'ListGroups', [], {}, () => {
    authorize(ctx, 'iam:ListGroups', `arn:aws:iam::${ctx.s.account.id}:group/`);
    return ctx.s.groups;
  });
}

export function addUserToGroup(ctx: Ctx, p: { GroupName: string; UserName: string }): void {
  trailed(ctx, SRC, 'AddUserToGroup', [], p, () => {
    const g = getGroupOr(ctx, p.GroupName);
    const u = getUserOr(ctx, p.UserName);
    authorize(ctx, 'iam:AddUserToGroup', g.arn);
    if (!g.members.includes(u.name)) g.members.push(u.name);
  });
}

export function removeUserFromGroup(ctx: Ctx, p: { GroupName: string; UserName: string }): void {
  trailed(ctx, SRC, 'RemoveUserFromGroup', [], p, () => {
    const g = getGroupOr(ctx, p.GroupName);
    authorize(ctx, 'iam:RemoveUserFromGroup', g.arn);
    if (!g.members.includes(p.UserName)) throw new AwsError('NoSuchEntity', `The user with name ${p.UserName} cannot be found.`, 404);
    g.members = g.members.filter((m) => m !== p.UserName);
  });
}

// ------------------------------------------------------------------ políticas

export function createPolicy(ctx: Ctx, p: { PolicyName: string; PolicyDocument: string | PolicyDocument; Path?: string; Description?: string }): IamPolicy {
  const path = normPath(p.Path);
  return trailed(ctx, SRC, 'CreatePolicy', [{ type: 'AWS::IAM::ManagedPolicy', name: p.PolicyName }], { PolicyName: p.PolicyName }, () => {
    checkName('Policy', p.PolicyName);
    authorize(ctx, 'iam:CreatePolicy', arnFor(ctx, 'policy', path, p.PolicyName));
    const doc = parseDoc(p.PolicyDocument);
    const arn = arnFor(ctx, 'policy', path, p.PolicyName);
    if (ctx.s.policies.some((x) => x.arn === arn)) throw new AwsError('EntityAlreadyExists', `A policy called ${p.PolicyName} already exists. Duplicate names are not allowed.`, 409);
    const pol: IamPolicy = { arn, name: p.PolicyName, id: ids.iamId('ANPA'), path, managed: 'customer', defaultVersion: 'v1', document: doc, attachmentCount: 0, createdAt: nowIso(), description: p.Description };
    ctx.s.policies.push(pol);
    return pol;
  });
}

export function getPolicy(ctx: Ctx, p: { PolicyArn: string }): IamPolicy {
  return trailed(ctx, SRC, 'GetPolicy', [], p, () => {
    authorize(ctx, 'iam:GetPolicy', p.PolicyArn);
    return getPolicyOr(ctx, p.PolicyArn);
  });
}

export function listPolicies(ctx: Ctx, p: { Scope?: 'All' | 'AWS' | 'Local'; OnlyAttached?: boolean }): IamPolicy[] {
  return trailed(ctx, SRC, 'ListPolicies', [], p, () => {
    authorize(ctx, 'iam:ListPolicies', '*');
    return ctx.s.policies.filter((x) => (p.Scope === 'Local' ? x.managed === 'customer' : p.Scope === 'AWS' ? x.managed === 'aws' : true) && (!p.OnlyAttached || x.attachmentCount > 0));
  });
}

export function deletePolicy(ctx: Ctx, p: { PolicyArn: string }): void {
  trailed(ctx, SRC, 'DeletePolicy', [], p, () => {
    authorize(ctx, 'iam:DeletePolicy', p.PolicyArn);
    const pol = getPolicyOr(ctx, p.PolicyArn);
    if (pol.managed === 'aws') throw new AwsError('AccessDenied', `Policy ${p.PolicyArn} is an AWS managed policy and cannot be deleted.`, 403);
    if (pol.attachmentCount > 0) throw new AwsError('DeleteConflict', 'Cannot delete a policy attached to entities.', 409);
    ctx.s.policies = ctx.s.policies.filter((x) => x !== pol);
  });
}

function attach(ctx: Ctx, list: string[], policyArn: string) {
  const pol = getPolicyOr(ctx, policyArn);
  if (!list.includes(policyArn)) {
    list.push(policyArn);
    pol.attachmentCount++;
  }
}
function detach(ctx: Ctx, list: string[], policyArn: string): string[] {
  const pol = getPolicyOr(ctx, policyArn);
  if (!list.includes(policyArn)) throw new AwsError('NoSuchEntity', `Policy ${policyArn} was not found.`, 404);
  pol.attachmentCount = Math.max(0, pol.attachmentCount - 1);
  return list.filter((x) => x !== policyArn);
}

export function attachUserPolicy(ctx: Ctx, p: { UserName: string; PolicyArn: string }): void {
  trailed(ctx, SRC, 'AttachUserPolicy', [], p, () => {
    const u = getUserOr(ctx, p.UserName);
    authorize(ctx, 'iam:AttachUserPolicy', u.arn);
    attach(ctx, u.attached, p.PolicyArn);
  });
}
export function detachUserPolicy(ctx: Ctx, p: { UserName: string; PolicyArn: string }): void {
  trailed(ctx, SRC, 'DetachUserPolicy', [], p, () => {
    const u = getUserOr(ctx, p.UserName);
    authorize(ctx, 'iam:DetachUserPolicy', u.arn);
    u.attached = detach(ctx, u.attached, p.PolicyArn);
  });
}
export function attachGroupPolicy(ctx: Ctx, p: { GroupName: string; PolicyArn: string }): void {
  trailed(ctx, SRC, 'AttachGroupPolicy', [], p, () => {
    const g = getGroupOr(ctx, p.GroupName);
    authorize(ctx, 'iam:AttachGroupPolicy', g.arn);
    attach(ctx, g.attached, p.PolicyArn);
  });
}
export function attachRolePolicy(ctx: Ctx, p: { RoleName: string; PolicyArn: string }): void {
  trailed(ctx, SRC, 'AttachRolePolicy', [], p, () => {
    const r = getRoleOr(ctx, p.RoleName);
    authorize(ctx, 'iam:AttachRolePolicy', r.arn);
    attach(ctx, r.attached, p.PolicyArn);
  });
}
export function detachRolePolicy(ctx: Ctx, p: { RoleName: string; PolicyArn: string }): void {
  trailed(ctx, SRC, 'DetachRolePolicy', [], p, () => {
    const r = getRoleOr(ctx, p.RoleName);
    authorize(ctx, 'iam:DetachRolePolicy', r.arn);
    r.attached = detach(ctx, r.attached, p.PolicyArn);
  });
}

export function putUserPolicy(ctx: Ctx, p: { UserName: string; PolicyName: string; PolicyDocument: string | PolicyDocument }): void {
  trailed(ctx, SRC, 'PutUserPolicy', [], { UserName: p.UserName, PolicyName: p.PolicyName }, () => {
    const u = getUserOr(ctx, p.UserName);
    authorize(ctx, 'iam:PutUserPolicy', u.arn);
    u.inline[p.PolicyName] = parseDoc(p.PolicyDocument);
  });
}
export function putRolePolicy(ctx: Ctx, p: { RoleName: string; PolicyName: string; PolicyDocument: string | PolicyDocument }): void {
  trailed(ctx, SRC, 'PutRolePolicy', [], { RoleName: p.RoleName, PolicyName: p.PolicyName }, () => {
    const r = getRoleOr(ctx, p.RoleName);
    authorize(ctx, 'iam:PutRolePolicy', r.arn);
    r.inline[p.PolicyName] = parseDoc(p.PolicyDocument);
  });
}

export function listAttachedUserPolicies(ctx: Ctx, p: { UserName: string }) {
  return trailed(ctx, SRC, 'ListAttachedUserPolicies', [], p, () => {
    const u = getUserOr(ctx, p.UserName);
    authorize(ctx, 'iam:ListAttachedUserPolicies', u.arn);
    return u.attached.map((a) => ({ PolicyName: a.split('/').pop()!, PolicyArn: a }));
  });
}
export function listAttachedRolePolicies(ctx: Ctx, p: { RoleName: string }) {
  return trailed(ctx, SRC, 'ListAttachedRolePolicies', [], p, () => {
    const r = getRoleOr(ctx, p.RoleName);
    authorize(ctx, 'iam:ListAttachedRolePolicies', r.arn);
    return r.attached.map((a) => ({ PolicyName: a.split('/').pop()!, PolicyArn: a }));
  });
}

// ------------------------------------------------------------------ roles

export function createRole(ctx: Ctx, p: { RoleName: string; AssumeRolePolicyDocument: string | PolicyDocument; Path?: string; Description?: string; MaxSessionDuration?: number; Tags?: any }): IamRole {
  const path = normPath(p.Path);
  return trailed(ctx, SRC, 'CreateRole', [{ type: 'AWS::IAM::Role', name: p.RoleName }], { RoleName: p.RoleName }, () => {
    checkName('Role', p.RoleName);
    authorize(ctx, 'iam:CreateRole', arnFor(ctx, 'role', path, p.RoleName));
    const trust = parseDoc(p.AssumeRolePolicyDocument, 'trust');
    if (ctx.s.roles.some((r) => r.name === p.RoleName)) throw new AwsError('EntityAlreadyExists', `Role with name ${p.RoleName} already exists.`, 409);
    const r: IamRole = {
      arn: arnFor(ctx, 'role', path, p.RoleName),
      name: p.RoleName,
      id: ids.iamId('AROA'),
      path,
      createdAt: nowIso(),
      description: p.Description,
      assumeRolePolicy: trust,
      maxSessionDuration: p.MaxSessionDuration ?? 3600,
      attached: [],
      inline: {},
      tags: toTags(p.Tags),
    };
    ctx.s.roles.push(r);
    return r;
  });
}

export function getRole(ctx: Ctx, p: { RoleName: string }): IamRole {
  return trailed(ctx, SRC, 'GetRole', [], p, () => {
    const r = getRoleOr(ctx, p.RoleName);
    authorize(ctx, 'iam:GetRole', r.arn);
    return r;
  });
}
export function listRoles(ctx: Ctx): IamRole[] {
  return trailed(ctx, SRC, 'ListRoles', [], {}, () => {
    authorize(ctx, 'iam:ListRoles', `arn:aws:iam::${ctx.s.account.id}:role/`);
    return ctx.s.roles;
  });
}
export function updateAssumeRolePolicy(ctx: Ctx, p: { RoleName: string; PolicyDocument: string | PolicyDocument }): void {
  trailed(ctx, SRC, 'UpdateAssumeRolePolicy', [], { RoleName: p.RoleName }, () => {
    const r = getRoleOr(ctx, p.RoleName);
    authorize(ctx, 'iam:UpdateAssumeRolePolicy', r.arn);
    r.assumeRolePolicy = parseDoc(p.PolicyDocument, 'trust');
  });
}
export function deleteRole(ctx: Ctx, p: { RoleName: string }): void {
  trailed(ctx, SRC, 'DeleteRole', [], p, () => {
    const r = getRoleOr(ctx, p.RoleName);
    authorize(ctx, 'iam:DeleteRole', r.arn);
    if (r.attached.length || Object.keys(r.inline).length) throw new AwsError('DeleteConflict', 'Cannot delete entity, must delete policies first.', 409);
    if (ctx.s.instanceProfiles.some((ip) => ip.roles.includes(r.name))) throw new AwsError('DeleteConflict', 'Cannot delete entity, must remove roles from instance profile first.', 409);
    ctx.s.roles = ctx.s.roles.filter((x) => x !== r);
  });
}

export function createInstanceProfile(ctx: Ctx, p: { InstanceProfileName: string }) {
  return trailed(ctx, SRC, 'CreateInstanceProfile', [], p, () => {
    authorize(ctx, 'iam:CreateInstanceProfile', arnFor(ctx, 'instance-profile', '/', p.InstanceProfileName));
    if (ctx.s.instanceProfiles.some((x) => x.name === p.InstanceProfileName)) throw new AwsError('EntityAlreadyExists', `Instance Profile ${p.InstanceProfileName} already exists.`, 409);
    const ip = { arn: arnFor(ctx, 'instance-profile', '/', p.InstanceProfileName), name: p.InstanceProfileName, id: ids.iamId('AIPA'), roles: [] as string[], createdAt: nowIso() };
    ctx.s.instanceProfiles.push(ip);
    return ip;
  });
}
export function addRoleToInstanceProfile(ctx: Ctx, p: { InstanceProfileName: string; RoleName: string }): void {
  trailed(ctx, SRC, 'AddRoleToInstanceProfile', [], p, () => {
    const ip = ctx.s.instanceProfiles.find((x) => x.name === p.InstanceProfileName);
    if (!ip) throw new AwsError('NoSuchEntity', `Instance Profile ${p.InstanceProfileName} cannot be found.`, 404);
    const r = getRoleOr(ctx, p.RoleName);
    authorize(ctx, 'iam:AddRoleToInstanceProfile', ip.arn);
    if (ip.roles.length >= 1) throw new AwsError('LimitExceeded', 'Cannot exceed quota for InstanceSessionsPerInstanceProfile: 1', 409);
    ip.roles.push(r.name);
  });
}

// ------------------------------------------------------------------ simulador

export function simulatePrincipalPolicy(ctx: Ctx, p: { PolicySourceArn: string; ActionNames: string[]; ResourceArns?: string[] }) {
  return trailed(ctx, SRC, 'SimulatePrincipalPolicy', [], p, () => {
    authorize(ctx, 'iam:SimulatePrincipalPolicy', p.PolicySourceArn);
    const name = p.PolicySourceArn.split('/').pop()!;
    const isRole = p.PolicySourceArn.includes(':role/');
    const docs: PolicyDocument[] = [];
    const add = (list: string[], inline: Record<string, PolicyDocument>) => {
      for (const a of list) docs.push(getPolicyOr(ctx, a).document);
      docs.push(...Object.values(inline));
    };
    if (isRole) {
      const r = getRoleOr(ctx, name);
      add(r.attached, r.inline);
    } else {
      const u = getUserOr(ctx, name);
      add(u.attached, u.inline);
      for (const g of ctx.s.groups.filter((g) => g.members.includes(u.name))) add(g.attached, g.inline);
    }
    const out: { EvalActionName: string; EvalResourceName: string; EvalDecision: string }[] = [];
    for (const action of p.ActionNames) {
      for (const res of p.ResourceArns ?? ['*']) {
        const r = evaluate({ action, resource: res, identity: docs, context: requestContext(ctx.caller) });
        out.push({ EvalActionName: action, EvalResourceName: res, EvalDecision: r.decision === 'Allow' ? 'allowed' : r.decision === 'ExplicitDeny' ? 'explicitDeny' : 'implicitDeny' });
      }
    }
    return out;
  });
}

// ------------------------------------------------------------------ STS

const STS = 'sts.amazonaws.com';

export function getCallerIdentity(ctx: Ctx) {
  return trailed(ctx, STS, 'GetCallerIdentity', [], {}, () => {
    const c = ctx.caller;
    if (c.type === 'IAMUser') {
      const u = getUserOr(ctx, c.userName);
      return { UserId: u.id, Account: ctx.s.account.id, Arn: u.arn };
    }
    if (c.type === 'AssumedRole') {
      // Sesión en una cuenta miembro de Organizations: su rol no existe en el estado de la cuenta de administración.
      if (accountOfArn(c.arn) !== ctx.s.account.id) return { UserId: `AROA${c.roleName}:${c.sessionName}`, Account: accountOfArn(c.arn), Arn: c.arn };
      const r = getRoleOr(ctx, c.roleName!);
      return { UserId: `${r.id}:${c.sessionName}`, Account: ctx.s.account.id, Arn: c.arn };
    }
    return { UserId: ctx.s.account.id, Account: ctx.s.account.id, Arn: `arn:aws:iam::${ctx.s.account.id}:root` };
  });
}

export function assumeRole(ctx: Ctx, p: { RoleArn: string; RoleSessionName: string; DurationSeconds?: number; SerialNumber?: string; TokenCode?: string; Policy?: string | PolicyDocument; ExternalId?: string }) {
  return trailed(ctx, STS, 'AssumeRole', [{ type: 'AWS::IAM::Role', name: p.RoleArn }], { RoleArn: p.RoleArn, RoleSessionName: p.RoleSessionName }, () => {
    const roleName = p.RoleArn.split('/').pop()!;
    // Cuentas miembro de AWS Organizations: el rol OrganizationAccountAccessRole confía en la cuenta de administración.
    const memberAcct = memberRoleAccount(ctx.s, p.RoleArn);
    if (memberAcct) {
      if (accountOfArn(ctx.caller.arn) !== ctx.s.account.id) throw new AwsError('AccessDenied', `User: ${ctx.caller.arn} is not authorized to perform: sts:AssumeRole on resource: ${p.RoleArn}`, 403);
      const rr = check(ctx, 'sts:AssumeRole', p.RoleArn);
      if (rr.decision !== 'Allow') throw new AwsError('AccessDenied', `User: ${ctx.caller.arn} is not authorized to perform: sts:AssumeRole on resource: ${p.RoleArn}`, 403);
      const dur0 = p.DurationSeconds ?? 3600;
      if (dur0 < 900 || dur0 > 43200) throw new AwsError('ValidationError', 'The requested DurationSeconds exceeds the MaxSessionDuration set for this role.', 400);
      const ms: Session = {
        accessKeyId: ids.sessionAccessKeyId(), secret: ids.secretKey(), token: ids.sessionToken(), expiration: new Date(now() + dur0 * 1000).toISOString(),
        roleArn: p.RoleArn, sessionName: p.RoleSessionName, assumedRoleArn: `arn:aws:sts::${memberAcct}:assumed-role/${roleName}/${p.RoleSessionName}`, mfa: ctx.caller.mfa,
        sessionPolicy: p.Policy ? parseDoc(p.Policy) : undefined,
      };
      ctx.s.sessions.push(ms);
      return {
        Credentials: { AccessKeyId: ms.accessKeyId, SecretAccessKey: ms.secret, SessionToken: ms.token, Expiration: ms.expiration },
        AssumedRoleUser: { AssumedRoleId: `AROA${memberAcct}${roleName.length}:${p.RoleSessionName}`, Arn: ms.assumedRoleArn },
      };
    }
    const role = ctx.s.roles.find((r) => r.arn === p.RoleArn);
    if (!role) throw new AwsError('AccessDenied', `User: ${ctx.caller.arn} is not authorized to perform: sts:AssumeRole on resource: ${p.RoleArn}`, 403);
    // MFA proporcionada en la llamada
    let mfa = ctx.caller.mfa;
    if (p.SerialNumber && p.TokenCode) {
      const u = ctx.s.users.find((x) => x.name === ctx.caller.userName);
      if (!u?.mfaDevices.includes(p.SerialNumber)) throw new AwsError('AccessDenied', `MultiFactorAuthentication failed with invalid MFA one time pass code. `, 403);
      if (!/^\d{6}$/.test(p.TokenCode)) throw new AwsError('AccessDenied', 'MultiFactorAuthentication failed with invalid MFA one time pass code. ', 403);
      mfa = true;
    }
    // 1) el llamador debe poder asumir (sts:AssumeRole en su política de identidad o la trust policy nombra su ARN)
    const ctxVals = requestContext({ ...ctx.caller, mfa }, p.ExternalId ? { 'sts:ExternalId': p.ExternalId } : {});
    const trusted = trustAllows(role.assumeRolePolicy, ctx.caller.arn, ctxVals);
    if (!trusted) {
      throw new AwsError('AccessDenied', `User: ${ctx.caller.arn} is not authorized to perform: sts:AssumeRole on resource: ${p.RoleArn}`, 403);
    }
    const sameAccountPrincipalListed = JSON.stringify(role.assumeRolePolicy).includes(ctx.caller.arn);
    if (!sameAccountPrincipalListed) {
      const r = check(ctx, 'sts:AssumeRole', p.RoleArn);
      if (r.decision !== 'Allow') throw new AwsError('AccessDenied', `User: ${ctx.caller.arn} is not authorized to perform: sts:AssumeRole on resource: ${p.RoleArn}`, 403);
    }
    const dur = p.DurationSeconds ?? 3600;
    if (dur < 900 || dur > role.maxSessionDuration) {
      throw new AwsError('ValidationError', `The requested DurationSeconds exceeds the MaxSessionDuration set for this role.`, 400);
    }
    const sessionPolicy = p.Policy ? parseDoc(p.Policy) : undefined;
    const sess: Session = {
      accessKeyId: ids.sessionAccessKeyId(),
      secret: ids.secretKey(),
      token: ids.sessionToken(),
      expiration: new Date(now() + dur * 1000).toISOString(),
      roleArn: role.arn,
      sessionName: p.RoleSessionName,
      assumedRoleArn: `arn:aws:sts::${ctx.s.account.id}:assumed-role/${roleName}/${p.RoleSessionName}`,
      mfa,
      sessionPolicy,
    };
    ctx.s.sessions.push(sess);
    return {
      Credentials: { AccessKeyId: sess.accessKeyId, SecretAccessKey: sess.secret, SessionToken: sess.token, Expiration: sess.expiration },
      AssumedRoleUser: { AssumedRoleId: `${role.id}:${p.RoleSessionName}`, Arn: sess.assumedRoleArn },
    };
  });
}

/** Credenciales temporales de un usuario con MFA (GetSessionToken). */
export function getSessionToken(ctx: Ctx, p: { SerialNumber?: string; TokenCode?: string; DurationSeconds?: number }) {
  return trailed(ctx, STS, 'GetSessionToken', [], p, () => {
    if (ctx.caller.type !== 'IAMUser') throw new AwsError('AccessDenied', 'Cannot call GetSessionToken with temporary credentials.', 403);
    const u = getUserOr(ctx, ctx.caller.userName);
    let mfa = false;
    if (p.SerialNumber) {
      if (!u.mfaDevices.includes(p.SerialNumber)) throw new AwsError('AccessDenied', 'MultiFactorAuthentication failed, unable to validate MFA code.  Please verify your MFA serial number is valid and associated with this user.', 403);
      if (!/^\d{6}$/.test(p.TokenCode ?? '')) throw new AwsError('AccessDenied', 'MultiFactorAuthentication failed with invalid MFA one time pass code. ', 403);
      mfa = true;
    }
    const dur = p.DurationSeconds ?? 43200;
    const sess: Session = {
      accessKeyId: ids.sessionAccessKeyId(),
      secret: ids.secretKey(),
      token: ids.sessionToken(),
      expiration: new Date(now() + dur * 1000).toISOString(),
      roleArn: u.arn,
      sessionName: u.name,
      assumedRoleArn: u.arn,
      mfa,
    };
    ctx.s.sessions.push(sess);
    return { Credentials: { AccessKeyId: sess.accessKeyId, SecretAccessKey: sess.secret, SessionToken: sess.token, Expiration: sess.expiration } };
  });
}

export const _internal = { statements, clone };

export function detachGroupPolicy(ctx: Ctx, p: { GroupName: string; PolicyArn: string }): void {
  trailed(ctx, SRC, 'DetachGroupPolicy', [], p, () => {
    const g = getGroupOr(ctx, p.GroupName);
    authorize(ctx, 'iam:DetachGroupPolicy', g.arn);
    g.attached = detach(ctx, g.attached, p.PolicyArn);
  });
}
export function deleteGroup(ctx: Ctx, p: { GroupName: string }): void {
  trailed(ctx, SRC, 'DeleteGroup', [{ type: 'AWS::IAM::Group', name: p.GroupName }], p, () => {
    const g = getGroupOr(ctx, p.GroupName);
    authorize(ctx, 'iam:DeleteGroup', g.arn);
    if (g.members.length) throw new AwsError('DeleteConflict', 'Cannot delete entity, must remove users from group first.', 409);
    if (g.attached.length || Object.keys(g.inline).length) throw new AwsError('DeleteConflict', 'Cannot delete entity, must detach all policies first.', 409);
    ctx.s.groups = ctx.s.groups.filter((x) => x !== g);
  });
}

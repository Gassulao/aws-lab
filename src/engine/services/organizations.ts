// AWS Organizations: organización, raíz, unidades organizativas (OU), cuentas miembro simuladas y políticas de control de servicios (SCP).
// Las SCP se evalúan de verdad en policy.ts (ver orgPolicy.ts): una SCP deniega aunque IAM permita.
import type { PolicyDocument } from '../types';
import { AwsError } from '../errors';
import { authorize, trailed, type Ctx } from '../api';
import { validatePolicyDocument } from '../policy';
import { ids } from '../ids';
import { nowIso, randomString } from '../util';
import { gov, type CreateAccountStatus, type OrgAccount, type OrgPolicy, type OrgUnit, type Organization } from './govTypes';
import { accountOfArn } from '../orgPolicy';

const SRC = 'organizations.amazonaws.com';
export const FULL_ACCESS_ID = 'p-FullAWSAccess';
const FULL_ACCESS = '{\n  "Version": "2012-10-17",\n  "Statement": [\n    {\n      "Effect": "Allow",\n      "Action": "*",\n      "Resource": "*"\n    }\n  ]\n}';
const SCP = 'SERVICE_CONTROL_POLICY';

// ------------------------------------------------------------------ ARN e identificadores

export const orgArn = (o: Organization) => `arn:aws:organizations::${o.masterAccountId}:organization/${o.id}`;
export const rootArn = (o: Organization) => `arn:aws:organizations::${o.masterAccountId}:root/${o.id}/${o.rootId}`;
export const ouArn = (o: Organization, u: OrgUnit) => `arn:aws:organizations::${o.masterAccountId}:ou/${o.id}/${u.id}`;
export const accountArn = (o: Organization, a: OrgAccount) => `arn:aws:organizations::${o.masterAccountId}:account/${o.id}/${a.id}`;
export const policyArn = (o: Organization, p: OrgPolicy) => (p.awsManaged ? `arn:aws:organizations::aws:policy/service_control_policy/${p.id}` : `arn:aws:organizations::${o.masterAccountId}:policy/${o.id}/service_control_policy/${p.id}`);

const lower = (n: number) => randomString(n, 'abcdefghijklmnopqrstuvwxyz0123456789');

// ------------------------------------------------------------------ acceso al estado

const notInUse = () => new AwsError('AWSOrganizationsNotInUseException', 'Your account is not a member of an organization.', 400);

export function orgOf(ctx: Ctx): Organization {
  const o = gov(ctx.s).org;
  if (!o) throw notInUse();
  return o;
}

/** Solo la cuenta de administración puede gestionar la organización. */
function mgmt(ctx: Ctx): Organization {
  const o = orgOf(ctx);
  if (accountOfArn(ctx.caller.arn) !== o.masterAccountId) throw new AwsError('AccessDeniedException', "You don't have permissions to access this resource.", 400);
  return o;
}

/** Las cuentas pedidas con create-account pasan a SUCCEEDED en la siguiente llamada a Organizations. */
export function settleOrg(ctx: Ctx['s']) {
  const o = gov(ctx).org;
  if (!o) return;
  for (const st of o.createStatuses) {
    if (st.state !== 'IN_PROGRESS') continue;
    st.state = 'SUCCEEDED';
    st.completedAt = nowIso();
    const acct: OrgAccount = { id: ids.accountId(), name: st.accountName, email: st.email, status: 'ACTIVE', joinedMethod: 'CREATED', joinedAt: nowIso(), parentId: o.rootId, management: false };
    st.accountId = acct.id;
    o.accounts.push(acct);
    if (o.scpEnabled) attach(o, FULL_ACCESS_ID, acct.id);
  }
}

function call<T>(ctx: Ctx, event: string, action: string, params: any, fn: (o: Organization) => T, opts: { needsOrg?: boolean } = {}): T {
  return trailed(ctx, SRC, event, [], params, () => {
    authorize(ctx, `organizations:${action}`, '*');
    if (opts.needsOrg === false) return fn(undefined as unknown as Organization);
    const o = mgmt(ctx);
    settleOrg(ctx.s);
    return fn(o);
  });
}

function attach(o: Organization, policyId: string, target: string) {
  const p = o.policies.find((x) => x.id === policyId);
  if (p && !p.targets.includes(target)) p.targets.push(target);
}

const targetKind = (o: Organization, id: string): 'ROOT' | 'ORGANIZATIONAL_UNIT' | 'ACCOUNT' | null =>
  id === o.rootId ? 'ROOT' : o.ous.some((u) => u.id === id) ? 'ORGANIZATIONAL_UNIT' : o.accounts.some((a) => a.id === id) ? 'ACCOUNT' : null;

function needTarget(o: Organization, id: string) {
  const k = targetKind(o, id);
  if (!k) throw new AwsError('TargetNotFoundException', 'You specified a target that doesn\'t exist.', 400);
  return k;
}
function needParent(o: Organization, id: string) {
  if (id !== o.rootId && !o.ous.some((u) => u.id === id)) throw new AwsError('ParentNotFoundException', "You specified parent that doesn't exist.", 400);
}
const ouNotFound = () => new AwsError('OrganizationalUnitNotFoundException', "You specified an organizational unit that doesn't exist.", 400);
const accNotFound = () => new AwsError('AccountNotFoundException', "You specified an account that doesn't exist.", 400);
const polNotFound = () => new AwsError('PolicyNotFoundException', "You specified a policy that doesn't exist.", 400);
const invalid = (reason: string, msg: string) => new AwsError('InvalidInputException', `You provided a value that does not match the required pattern.${msg ? ' ' + msg : ''}`.trim() || reason, 400);

// ------------------------------------------------------------------ organización

export function createOrganization(ctx: Ctx, p: { FeatureSet?: string }) {
  return trailed(ctx, SRC, 'CreateOrganization', [], p, () => {
    authorize(ctx, 'organizations:CreateOrganization', '*');
    const g = gov(ctx.s);
    if (g.org) throw new AwsError('AlreadyInOrganizationException', 'The AWS account is already a member of an organization.', 400);
    if (p.FeatureSet && p.FeatureSet !== 'ALL') throw new AwsError('ConstraintViolationException', 'Este simulador solo admite organizaciones con todas las características (FeatureSet=ALL).', 400);
    const rootId = `r-${lower(4)}`;
    const org: Organization = {
      id: `o-${lower(10)}`, featureSet: 'ALL', masterAccountId: ctx.s.account.id, masterEmail: ctx.s.account.rootEmail, rootId, scpEnabled: false,
      accounts: [{ id: ctx.s.account.id, name: ctx.s.account.alias ?? ctx.s.settings.userDisplayName, email: ctx.s.account.rootEmail, status: 'ACTIVE', joinedMethod: 'INVITED', joinedAt: nowIso(), parentId: rootId, management: true }],
      ous: [],
      policies: [{ id: FULL_ACCESS_ID, name: 'FullAWSAccess', description: 'Allows access to every operation', type: SCP, content: FULL_ACCESS, awsManaged: true, targets: [] }],
      createStatuses: [],
    };
    g.org = org;
    return org;
  });
}

export function describeOrganization(ctx: Ctx): Organization {
  return trailed(ctx, SRC, 'DescribeOrganization', [], {}, () => {
    authorize(ctx, 'organizations:DescribeOrganization', '*');
    const o = orgOf(ctx);
    settleOrg(ctx.s);
    return o;
  });
}

export function deleteOrganization(ctx: Ctx): void {
  call(ctx, 'DeleteOrganization', 'DeleteOrganization', {}, (o) => {
    if (o.accounts.some((a) => !a.management) || o.ous.length) throw new AwsError('OrganizationNotEmptyException', 'To delete an organization, you must first remove all member accounts (except the master).', 400);
    delete gov(ctx.s).org;
  });
}

export function listRoots(ctx: Ctx) {
  return call(ctx, 'ListRoots', 'ListRoots', {}, (o) => [o]);
}

export function enablePolicyType(ctx: Ctx, p: { RootId: string; PolicyType: string }, on: boolean) {
  return call(ctx, on ? 'EnablePolicyType' : 'DisablePolicyType', on ? 'EnablePolicyType' : 'DisablePolicyType', p, (o) => {
    if (p.RootId !== o.rootId) throw new AwsError('RootNotFoundException', "You specified a root that doesn't exist.", 400);
    if (p.PolicyType !== SCP) throw new AwsError('PolicyTypeNotAvailableForOrganizationException', 'You can\'t use the specified policy type with the feature set currently enabled for this organization. Este simulador solo admite SERVICE_CONTROL_POLICY.', 400);
    if (on) {
      if (o.scpEnabled) throw new AwsError('PolicyTypeAlreadyEnabledException', 'The specified policy type is already enabled in the specified root.', 400);
      o.scpEnabled = true;
      for (const t of [o.rootId, ...o.ous.map((u) => u.id), ...o.accounts.map((a) => a.id)]) attach(o, FULL_ACCESS_ID, t);
    } else {
      if (!o.scpEnabled) throw new AwsError('PolicyTypeNotEnabledException', 'This operation can be performed only for enabled policy types.', 400);
      o.scpEnabled = false;
      for (const pol of o.policies) pol.targets = [];
    }
    return o;
  });
}

// ------------------------------------------------------------------ unidades organizativas

const OU_NAME = /^[\s\S]{1,128}$/;

export function createOrganizationalUnit(ctx: Ctx, p: { ParentId: string; Name: string }): OrgUnit {
  return call(ctx, 'CreateOrganizationalUnit', 'CreateOrganizationalUnit', p, (o) => {
    needParent(o, p.ParentId);
    if (!p.Name || !OU_NAME.test(p.Name)) throw invalid('name', '');
    if (o.ous.some((u) => u.parentId === p.ParentId && u.name === p.Name)) throw new AwsError('DuplicateOrganizationalUnitException', 'An OU with the same name already exists.', 400);
    const u: OrgUnit = { id: `ou-${o.rootId.slice(2)}-${lower(8)}`, name: p.Name, parentId: p.ParentId, createdAt: nowIso() };
    o.ous.push(u);
    if (o.scpEnabled) attach(o, FULL_ACCESS_ID, u.id);
    return u;
  });
}
export function describeOrganizationalUnit(ctx: Ctx, p: { OrganizationalUnitId: string }): OrgUnit {
  return call(ctx, 'DescribeOrganizationalUnit', 'DescribeOrganizationalUnit', p, (o) => {
    const u = o.ous.find((x) => x.id === p.OrganizationalUnitId);
    if (!u) throw ouNotFound();
    return u;
  });
}
export function updateOrganizationalUnit(ctx: Ctx, p: { OrganizationalUnitId: string; Name: string }): OrgUnit {
  return call(ctx, 'UpdateOrganizationalUnit', 'UpdateOrganizationalUnit', p, (o) => {
    const u = o.ous.find((x) => x.id === p.OrganizationalUnitId);
    if (!u) throw ouNotFound();
    if (o.ous.some((x) => x !== u && x.parentId === u.parentId && x.name === p.Name)) throw new AwsError('DuplicateOrganizationalUnitException', 'An OU with the same name already exists.', 400);
    u.name = p.Name;
    return u;
  });
}
export function deleteOrganizationalUnit(ctx: Ctx, p: { OrganizationalUnitId: string }): void {
  call(ctx, 'DeleteOrganizationalUnit', 'DeleteOrganizationalUnit', p, (o) => {
    const u = o.ous.find((x) => x.id === p.OrganizationalUnitId);
    if (!u) throw ouNotFound();
    if (o.accounts.some((a) => a.parentId === u.id) || o.ous.some((x) => x.parentId === u.id)) throw new AwsError('OrganizationalUnitNotEmptyException', 'You must first remove all accounts and child OUs from the OU.', 400);
    o.ous = o.ous.filter((x) => x !== u);
    for (const pol of o.policies) pol.targets = pol.targets.filter((t) => t !== u.id);
  });
}
export function listOrganizationalUnitsForParent(ctx: Ctx, p: { ParentId: string }): OrgUnit[] {
  return call(ctx, 'ListOrganizationalUnitsForParent', 'ListOrganizationalUnitsForParent', p, (o) => {
    needParent(o, p.ParentId);
    return o.ous.filter((u) => u.parentId === p.ParentId);
  });
}
export function listParents(ctx: Ctx, p: { ChildId: string }) {
  return call(ctx, 'ListParents', 'ListParents', p, (o) => {
    const a = o.accounts.find((x) => x.id === p.ChildId);
    const u = o.ous.find((x) => x.id === p.ChildId);
    if (!a && !u) throw new AwsError('ChildNotFoundException', "You specified a child that doesn't exist.", 400);
    const parent = (a ?? u)!.parentId;
    return [{ Id: parent, Type: parent === o.rootId ? 'ROOT' : 'ORGANIZATIONAL_UNIT' }];
  });
}
export function listChildren(ctx: Ctx, p: { ParentId: string; ChildType: string }) {
  return call(ctx, 'ListChildren', 'ListChildren', p, (o) => {
    needParent(o, p.ParentId);
    if (p.ChildType !== 'ACCOUNT' && p.ChildType !== 'ORGANIZATIONAL_UNIT') throw new AwsError('InvalidInputException', 'You provided a value that does not match the required pattern. ChildType must be ACCOUNT or ORGANIZATIONAL_UNIT.', 400);
    const list = p.ChildType === 'ACCOUNT' ? o.accounts.filter((a) => a.parentId === p.ParentId) : o.ous.filter((u) => u.parentId === p.ParentId);
    return list.map((x) => ({ Id: x.id, Type: p.ChildType }));
  });
}

// ------------------------------------------------------------------ cuentas

export function listAccounts(ctx: Ctx): OrgAccount[] {
  return call(ctx, 'ListAccounts', 'ListAccounts', {}, (o) => o.accounts);
}
export function listAccountsForParent(ctx: Ctx, p: { ParentId: string }): OrgAccount[] {
  return call(ctx, 'ListAccountsForParent', 'ListAccountsForParent', p, (o) => {
    needParent(o, p.ParentId);
    return o.accounts.filter((a) => a.parentId === p.ParentId);
  });
}
export function describeAccount(ctx: Ctx, p: { AccountId: string }): OrgAccount {
  return call(ctx, 'DescribeAccount', 'DescribeAccount', p, (o) => {
    const a = o.accounts.find((x) => x.id === p.AccountId);
    if (!a) throw accNotFound();
    return a;
  });
}
export function createAccount(ctx: Ctx, p: { AccountName: string; Email: string; RoleName?: string }): CreateAccountStatus {
  return call(ctx, 'CreateAccount', 'CreateAccount', { AccountName: p.AccountName, Email: p.Email, RoleName: p.RoleName }, (o) => {
    if (!p.AccountName || p.AccountName.length > 50) throw invalid('name', '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.Email ?? '')) throw new AwsError('InvalidInputException', 'You provided a value that does not match the required pattern.', 400);
    if (p.RoleName && p.RoleName !== 'OrganizationAccountAccessRole') throw new AwsError('ConstraintViolationException', 'Este simulador solo admite el nombre de rol predeterminado OrganizationAccountAccessRole.', 400);
    const dup = o.accounts.some((a) => a.email.toLowerCase() === p.Email.toLowerCase());
    const st: CreateAccountStatus = { id: `car-${lower(32)}`, accountName: p.AccountName, email: p.Email, state: dup ? 'FAILED' : 'IN_PROGRESS', requestedAt: nowIso(), ...(dup ? { failureReason: 'EMAIL_ALREADY_EXISTS', completedAt: nowIso() } : {}) };
    o.createStatuses.push(st);
    return { ...st };
  });
}
export function describeCreateAccountStatus(ctx: Ctx, p: { CreateAccountRequestId: string }): CreateAccountStatus {
  return call(ctx, 'DescribeCreateAccountStatus', 'DescribeCreateAccountStatus', p, (o) => {
    const st = o.createStatuses.find((x) => x.id === p.CreateAccountRequestId);
    if (!st) throw new AwsError('CreateAccountStatusNotFoundException', "You haven't requested to create an account with the specified ID.", 400);
    return st;
  });
}
export function listCreateAccountStatus(ctx: Ctx, p: { States?: string[] }): CreateAccountStatus[] {
  return call(ctx, 'ListCreateAccountStatus', 'ListCreateAccountStatus', p, (o) => o.createStatuses.filter((s) => !p.States || p.States.includes(s.state)));
}
export function moveAccount(ctx: Ctx, p: { AccountId: string; SourceParentId: string; DestinationParentId: string }): void {
  call(ctx, 'MoveAccount', 'MoveAccount', p, (o) => {
    const a = o.accounts.find((x) => x.id === p.AccountId);
    if (!a) throw accNotFound();
    needParent(o, p.SourceParentId);
    needParent(o, p.DestinationParentId);
    if (a.parentId !== p.SourceParentId) throw new AwsError('SourceParentNotFoundException', "You specified the source parent that doesn't contain the specified account.", 400);
    if (p.SourceParentId === p.DestinationParentId) throw new AwsError('DuplicateAccountException', 'That account is already present in the specified destination.', 400);
    a.parentId = p.DestinationParentId;
  });
}
export function removeAccount(ctx: Ctx, p: { AccountId: string }): void {
  call(ctx, 'RemoveAccountFromOrganization', 'RemoveAccountFromOrganization', p, (o) => {
    const a = o.accounts.find((x) => x.id === p.AccountId);
    if (!a) throw accNotFound();
    if (a.management) throw new AwsError('ConstraintViolationException', "You can't remove the management account from the organization. Error: MASTER_ACCOUNT_MISSING_BILLING_INFO_NOT_APPLICABLE (cannot remove the management account).", 400);
    if (a.joinedMethod === 'CREATED') throw new AwsError('ConstraintViolationException', "This operation can't be completed because the account was created with CreateAccount and has no payment method/ contact information required to leave the organization. Error: ACCOUNT_CREATION_NOT_COMPLETE (use close-account instead).", 400);
    o.accounts = o.accounts.filter((x) => x !== a);
    for (const pol of o.policies) pol.targets = pol.targets.filter((t) => t !== a.id);
  });
}
export function closeAccount(ctx: Ctx, p: { AccountId: string }): void {
  call(ctx, 'CloseAccount', 'CloseAccount', p, (o) => {
    const a = o.accounts.find((x) => x.id === p.AccountId);
    if (!a) throw accNotFound();
    if (a.management) throw new AwsError('ConstraintViolationException', "You can't close the management account. Error: CANNOT_CLOSE_MANAGEMENT_ACCOUNT.", 400);
    a.status = 'SUSPENDED';
  });
}

// ------------------------------------------------------------------ políticas

const POLICY_NAME = /^[\s\S]{1,128}$/;

function parseScp(content: string): string {
  let doc: any;
  try {
    doc = JSON.parse(content);
  } catch {
    throw new AwsError('MalformedPolicyDocumentException', 'The provided policy document does not meet the requirements of the specified policy type.', 400);
  }
  try {
    validatePolicyDocument(doc, 'identity');
  } catch {
    throw new AwsError('MalformedPolicyDocumentException', 'The provided policy document does not meet the requirements of the specified policy type.', 400);
  }
  if (content.length > 5120) throw new AwsError('ConstraintViolationException', "You can't create the policy: the policy content exceeds the maximum size (5120 characters). Constraint: POLICY_CONTENT_LIMIT_EXCEEDED.", 400);
  return JSON.stringify(doc, null, 2);
}

export function createPolicy(ctx: Ctx, p: { Content: string; Description?: string; Name: string; Type: string }): OrgPolicy {
  return call(ctx, 'CreatePolicy', 'CreatePolicy', { Name: p.Name, Type: p.Type, Description: p.Description }, (o) => {
    if (p.Type !== SCP) throw new AwsError('InvalidInputException', 'You provided a value that does not match the required pattern. Este simulador solo admite Type=SERVICE_CONTROL_POLICY.', 400);
    if (!p.Name || !POLICY_NAME.test(p.Name)) throw invalid('name', '');
    if (o.policies.some((x) => x.name === p.Name)) throw new AwsError('DuplicatePolicyException', 'A policy with the specified name and type already exists.', 400);
    const pol: OrgPolicy = { id: `p-${lower(8)}`, name: p.Name, description: p.Description ?? '', type: SCP, content: parseScp(p.Content), awsManaged: false, targets: [] };
    o.policies.push(pol);
    return pol;
  });
}
function pol(o: Organization, id: string): OrgPolicy {
  const x = o.policies.find((q) => q.id === id);
  if (!x) throw polNotFound();
  return x;
}
export function describePolicy(ctx: Ctx, p: { PolicyId: string }): OrgPolicy {
  return call(ctx, 'DescribePolicy', 'DescribePolicy', p, (o) => pol(o, p.PolicyId));
}
export function updatePolicy(ctx: Ctx, p: { PolicyId: string; Name?: string; Description?: string; Content?: string }): OrgPolicy {
  return call(ctx, 'UpdatePolicy', 'UpdatePolicy', { PolicyId: p.PolicyId, Name: p.Name, Description: p.Description }, (o) => {
    const x = pol(o, p.PolicyId);
    if (x.awsManaged) throw new AwsError('AccessDeniedException', "You can't update an AWS managed policy.", 400);
    if (p.Name && p.Name !== x.name) {
      if (o.policies.some((q) => q.name === p.Name)) throw new AwsError('DuplicatePolicyException', 'A policy with the specified name and type already exists.', 400);
      x.name = p.Name;
    }
    if (p.Description !== undefined) x.description = p.Description;
    if (p.Content !== undefined) x.content = parseScp(p.Content);
    return x;
  });
}
export function deletePolicy(ctx: Ctx, p: { PolicyId: string }): void {
  call(ctx, 'DeletePolicy', 'DeletePolicy', p, (o) => {
    const x = pol(o, p.PolicyId);
    if (x.awsManaged) throw new AwsError('AccessDeniedException', "You can't delete an AWS managed policy.", 400);
    if (x.targets.length) throw new AwsError('PolicyInUseException', 'The policy is attached to one or more entities. You must detach it from all roots, OUs, and accounts before performing this operation.', 400);
    o.policies = o.policies.filter((q) => q !== x);
  });
}
export function listPolicies(ctx: Ctx, p: { Filter: string }): OrgPolicy[] {
  return call(ctx, 'ListPolicies', 'ListPolicies', p, (o) => {
    if (p.Filter !== SCP) throw new AwsError('InvalidInputException', 'You provided a value that does not match the required pattern. Este simulador solo admite Filter=SERVICE_CONTROL_POLICY.', 400);
    return o.policies;
  });
}
export function attachPolicy(ctx: Ctx, p: { PolicyId: string; TargetId: string }): void {
  call(ctx, 'AttachPolicy', 'AttachPolicy', p, (o) => {
    const x = pol(o, p.PolicyId);
    needTarget(o, p.TargetId);
    if (!o.scpEnabled) throw new AwsError('PolicyTypeNotEnabledException', 'This operation can be performed only for enabled policy types.', 400);
    if (x.targets.includes(p.TargetId)) throw new AwsError('DuplicatePolicyAttachmentException', 'The selected policy is already attached to the specified target.', 400);
    x.targets.push(p.TargetId);
  });
}
export function detachPolicy(ctx: Ctx, p: { PolicyId: string; TargetId: string }): void {
  call(ctx, 'DetachPolicy', 'DetachPolicy', p, (o) => {
    const x = pol(o, p.PolicyId);
    needTarget(o, p.TargetId);
    if (!x.targets.includes(p.TargetId)) throw new AwsError('PolicyNotAttachedException', "The policy you specified isn't attached to the specified target.", 400);
    const left = o.policies.filter((q) => q.targets.includes(p.TargetId) && q !== x);
    if (o.scpEnabled && !left.length) throw new AwsError('ConstraintViolationException', "This operation can't be completed because the target must have at least one service control policy attached. Error: MIN_POLICY_TYPE_ATTACHMENT_LIMIT_EXCEEDED.", 400);
    x.targets = x.targets.filter((t) => t !== p.TargetId);
  });
}
export function listPoliciesForTarget(ctx: Ctx, p: { TargetId: string; Filter: string }): OrgPolicy[] {
  return call(ctx, 'ListPoliciesForTarget', 'ListPoliciesForTarget', p, (o) => {
    needTarget(o, p.TargetId);
    return o.policies.filter((x) => x.targets.includes(p.TargetId));
  });
}
export function listTargetsForPolicy(ctx: Ctx, p: { PolicyId: string }) {
  return call(ctx, 'ListTargetsForPolicy', 'ListTargetsForPolicy', p, (o) => {
    const x = pol(o, p.PolicyId);
    return x.targets.map((t) => {
      const k = targetKind(o, t)!;
      const a = o.accounts.find((q) => q.id === t);
      const u = o.ous.find((q) => q.id === t);
      return { TargetId: t, Arn: k === 'ROOT' ? rootArn(o) : k === 'ACCOUNT' ? accountArn(o, a!) : ouArn(o, u!), Name: k === 'ROOT' ? 'Root' : (a ?? u)!.name, Type: k };
    });
  });
}


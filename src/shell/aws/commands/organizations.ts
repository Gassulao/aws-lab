// aws organizations
import { defineCommand } from '../framework';
import * as org from '../../../engine/services/organizations';
import type { OrgAccount, OrgPolicy, OrgUnit, Organization, CreateAccountStatus } from '../../../engine/services/govTypes';
import type { Ctx } from '../../../engine/api';

const isoMicro = (s: string) => s.replace(/\.(\d{3})Z$/, '.$1000+00:00').replace(/Z$/, '+00:00');
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const orgView = (o: Organization) => ({
  Id: o.id, Arn: org.orgArn(o), FeatureSet: o.featureSet, MasterAccountArn: `arn:aws:organizations::${o.masterAccountId}:account/${o.id}/${o.masterAccountId}`,
  MasterAccountId: o.masterAccountId, MasterAccountEmail: o.masterEmail,
  AvailablePolicyTypes: o.scpEnabled ? [{ Type: 'SERVICE_CONTROL_POLICY', Status: 'ENABLED' }] : [],
});
const acctView = (o: Organization, a: OrgAccount) => ({ Id: a.id, Arn: org.accountArn(o, a), Email: a.email, Name: a.name, Status: a.status, JoinedMethod: a.joinedMethod, JoinedTimestamp: isoMicro(a.joinedAt) });
const ouView = (o: Organization, u: OrgUnit) => ({ Id: u.id, Arn: org.ouArn(o, u), Name: u.name });
const polSummary = (o: Organization, p: OrgPolicy) => ({ Id: p.id, Arn: org.policyArn(o, p), Name: p.name, Description: p.description, Type: p.type, AwsManaged: p.awsManaged });
const statusView = (st: CreateAccountStatus) => strip({ Id: st.id, AccountName: st.accountName, State: st.state, RequestedTimestamp: isoMicro(st.requestedAt), CompletedTimestamp: st.completedAt ? isoMicro(st.completedAt) : undefined, AccountId: st.accountId, FailureReason: st.failureReason });
const o = (c: Ctx) => org.orgOf(c);

defineCommand({ service: 'organizations', name: 'create-organization', op: 'CreateOrganization', run: (c, p) => ({ Organization: orgView(org.createOrganization(c, { FeatureSet: p.FeatureSet })) }) });
defineCommand({ service: 'organizations', name: 'describe-organization', op: 'DescribeOrganization', run: (c) => ({ Organization: orgView(org.describeOrganization(c)) }) });
defineCommand({ service: 'organizations', name: 'delete-organization', op: 'DeleteOrganization', run: (c) => void org.deleteOrganization(c) });
defineCommand({
  service: 'organizations', name: 'list-roots', op: 'ListRoots',
  run: (c) => org.listRoots(c).map((x) => ({ Roots: [{ Id: x.rootId, Arn: org.rootArn(x), Name: 'Root', PolicyTypes: x.scpEnabled ? [{ Type: 'SERVICE_CONTROL_POLICY', Status: 'ENABLED' }] : [] }] }))[0],
});
defineCommand({
  service: 'organizations', name: 'enable-policy-type', op: 'EnablePolicyType',
  run: (c, p) => { const x = org.enablePolicyType(c, { RootId: p.RootId, PolicyType: p.PolicyType }, true); return { Root: { Id: x.rootId, Arn: org.rootArn(x), Name: 'Root', PolicyTypes: [{ Type: 'SERVICE_CONTROL_POLICY', Status: 'ENABLED' }] } }; },
});
defineCommand({
  service: 'organizations', name: 'disable-policy-type', op: 'DisablePolicyType',
  run: (c, p) => { const x = org.enablePolicyType(c, { RootId: p.RootId, PolicyType: p.PolicyType }, false); return { Root: { Id: x.rootId, Arn: org.rootArn(x), Name: 'Root', PolicyTypes: [] } }; },
});

defineCommand({ service: 'organizations', name: 'create-organizational-unit', op: 'CreateOrganizationalUnit', structured: ['tags'], list: ['tags'], run: (c, p) => ({ OrganizationalUnit: ouView(o(c), org.createOrganizationalUnit(c, { ParentId: p.ParentId, Name: p.Name })) }) });
defineCommand({ service: 'organizations', name: 'describe-organizational-unit', op: 'DescribeOrganizationalUnit', run: (c, p) => ({ OrganizationalUnit: ouView(o(c), org.describeOrganizationalUnit(c, { OrganizationalUnitId: p.OrganizationalUnitId })) }) });
defineCommand({ service: 'organizations', name: 'update-organizational-unit', op: 'UpdateOrganizationalUnit', run: (c, p) => ({ OrganizationalUnit: ouView(o(c), org.updateOrganizationalUnit(c, { OrganizationalUnitId: p.OrganizationalUnitId, Name: p.Name })) }) });
defineCommand({ service: 'organizations', name: 'delete-organizational-unit', op: 'DeleteOrganizationalUnit', run: (c, p) => void org.deleteOrganizationalUnit(c, { OrganizationalUnitId: p.OrganizationalUnitId }) });
defineCommand({ service: 'organizations', name: 'list-organizational-units-for-parent', op: 'ListOrganizationalUnitsForParent', run: (c, p) => ({ OrganizationalUnits: org.listOrganizationalUnitsForParent(c, { ParentId: p.ParentId }).map((u) => ouView(o(c), u)) }) });
defineCommand({ service: 'organizations', name: 'list-parents', op: 'ListParents', run: (c, p) => ({ Parents: org.listParents(c, { ChildId: p.ChildId }) }) });
defineCommand({ service: 'organizations', name: 'list-children', op: 'ListChildren', run: (c, p) => ({ Children: org.listChildren(c, { ParentId: p.ParentId, ChildType: p.ChildType }) }) });

defineCommand({ service: 'organizations', name: 'list-accounts', op: 'ListAccounts', run: (c) => ({ Accounts: org.listAccounts(c).map((a) => acctView(o(c), a)) }) });
defineCommand({ service: 'organizations', name: 'list-accounts-for-parent', op: 'ListAccountsForParent', run: (c, p) => ({ Accounts: org.listAccountsForParent(c, { ParentId: p.ParentId }).map((a) => acctView(o(c), a)) }) });
defineCommand({ service: 'organizations', name: 'describe-account', op: 'DescribeAccount', run: (c, p) => ({ Account: acctView(o(c), org.describeAccount(c, { AccountId: p.AccountId })) }) });
defineCommand({ service: 'organizations', name: 'create-account', op: 'CreateAccount', structured: ['tags'], list: ['tags'], run: (c, p) => ({ CreateAccountStatus: statusView(org.createAccount(c, { AccountName: p.AccountName, Email: p.Email, RoleName: p.RoleName })) }) });
defineCommand({ service: 'organizations', name: 'describe-create-account-status', op: 'DescribeCreateAccountStatus', run: (c, p) => ({ CreateAccountStatus: statusView(org.describeCreateAccountStatus(c, { CreateAccountRequestId: p.CreateAccountRequestId })) }) });
defineCommand({ service: 'organizations', name: 'list-create-account-status', op: 'ListCreateAccountStatus', list: ['states'], run: (c, p) => ({ CreateAccountStatuses: org.listCreateAccountStatus(c, { States: p.States }).map(statusView) }) });
defineCommand({ service: 'organizations', name: 'move-account', op: 'MoveAccount', run: (c, p) => void org.moveAccount(c, { AccountId: p.AccountId, SourceParentId: p.SourceParentId, DestinationParentId: p.DestinationParentId }) });
defineCommand({ service: 'organizations', name: 'remove-account-from-organization', op: 'RemoveAccountFromOrganization', run: (c, p) => void org.removeAccount(c, { AccountId: p.AccountId }) });
defineCommand({ service: 'organizations', name: 'close-account', op: 'CloseAccount', run: (c, p) => void org.closeAccount(c, { AccountId: p.AccountId }) });

defineCommand({
  service: 'organizations', name: 'create-policy', op: 'CreatePolicy', structured: ['tags'], list: ['tags'],
  run: (c, p) => { const x = org.createPolicy(c, { Content: p.Content, Description: p.Description ?? '', Name: p.Name, Type: p.Type }); return { Policy: { PolicySummary: polSummary(o(c), x), Content: x.content } }; },
});
defineCommand({ service: 'organizations', name: 'describe-policy', op: 'DescribePolicy', run: (c, p) => { const x = org.describePolicy(c, { PolicyId: p.PolicyId }); return { Policy: { PolicySummary: polSummary(o(c), x), Content: x.content } }; } });
defineCommand({
  service: 'organizations', name: 'update-policy', op: 'UpdatePolicy',
  run: (c, p) => { const x = org.updatePolicy(c, { PolicyId: p.PolicyId, Name: p.Name, Description: p.Description, Content: p.Content }); return { Policy: { PolicySummary: polSummary(o(c), x), Content: x.content } }; },
});
defineCommand({ service: 'organizations', name: 'delete-policy', op: 'DeletePolicy', run: (c, p) => void org.deletePolicy(c, { PolicyId: p.PolicyId }) });
defineCommand({ service: 'organizations', name: 'list-policies', op: 'ListPolicies', run: (c, p) => ({ Policies: org.listPolicies(c, { Filter: p.Filter }).map((x) => polSummary(o(c), x)) }) });
defineCommand({ service: 'organizations', name: 'attach-policy', op: 'AttachPolicy', run: (c, p) => void org.attachPolicy(c, { PolicyId: p.PolicyId, TargetId: p.TargetId }) });
defineCommand({ service: 'organizations', name: 'detach-policy', op: 'DetachPolicy', run: (c, p) => void org.detachPolicy(c, { PolicyId: p.PolicyId, TargetId: p.TargetId }) });
defineCommand({ service: 'organizations', name: 'list-policies-for-target', op: 'ListPoliciesForTarget', run: (c, p) => ({ Policies: org.listPoliciesForTarget(c, { TargetId: p.TargetId, Filter: p.Filter }).map((x) => polSummary(o(c), x)) }) });
defineCommand({ service: 'organizations', name: 'list-targets-for-policy', op: 'ListTargetsForPolicy', run: (c, p) => ({ Targets: org.listTargetsForPolicy(c, { PolicyId: p.PolicyId }) }) });

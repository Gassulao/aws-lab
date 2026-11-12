// Amazon EKS: clústeres (CREATING → ACTIVE), grupos de nodos administrados (instancias EC2 reales del motor), complementos
// y acceso. El plano de Kubernetes (pods, deployments…) vive en kube.ts y está ligado a cada clúster.
import type { CloudState, IamRole, PolicyStatement } from '../types';
import { AwsError } from '../errors';
import { trailed, authorize, type Ctx, type Caller } from '../api';
import { digits, hex, now } from '../util';
import { speedFactor } from '../store';
import { ids } from '../ids';
import { INSTANCE_TYPES } from '../catalog';
import { runInstances, terminateInstances, settleHooks, routeTableOfSubnet } from './ec2';
import { newKube, reconcile, seedCluster, applyDoc } from '../kube';
import { cs, sha, type EksAddon, type EksCluster, type NodeGroup } from './containerCore';

const SRC = 'eks.amazonaws.com';
export const EKS_VERSIONS = ['1.29', '1.30', '1.31', '1.32'];
const arnOf = (ctx: Ctx, kind: string, path: string) => `arn:aws:eks:${ctx.region}:${ctx.s.account.id}:${kind}/${path}`;
const tagMap = (t: any): Record<string, string> => (Array.isArray(t) ? Object.fromEntries(t.map((x: any) => [x.Key ?? x.key, String(x.Value ?? x.value)])) : t && typeof t === 'object' ? Object.fromEntries(Object.entries(t).map(([k, v]) => [k, String(v)])) : {});
const notFound = (n: string) => new AwsError('ResourceNotFoundException', `No cluster found for name: ${n}.`, 404);

export function getCluster(ctx: Ctx, name: string): EksCluster {
  const c = cs(ctx.s).eks.find((x) => x.name === name && x.region === ctx.region);
  if (!c) throw notFound(name);
  return c;
}
export const principalOf = (c: Caller): string => (c.type === 'AssumedRole' ? `arn:aws:iam::${c.arn.split(':')[4]}:role/${c.roleName}` : c.arn);

const roleOf = (s: CloudState, arn: string): IamRole | undefined => s.roles.find((r) => r.arn === arn);
const trustsService = (r: IamRole, svc: string) => ([] as PolicyStatement[]).concat(r.assumeRolePolicy.Statement as any).some((st) => st.Effect === 'Allow' && JSON.stringify(st.Principal ?? {}).includes(svc));
const badRole = (arn: string) => new AwsError('InvalidParameterException', `Role with arn: ${arn} could not be assumed because it does not exist or the trust policy is incorrect`);

// ------------------------------------------------------------------ clústeres

export function createCluster(ctx: Ctx, p: { Name: string; RoleArn: string; ResourcesVpcConfig: { subnetIds?: string[]; securityGroupIds?: string[]; endpointPublicAccess?: any; endpointPrivateAccess?: any }; Version?: string; Tags?: any }): EksCluster {
  return trailed(ctx, SRC, 'CreateCluster', [{ type: 'AWS::EKS::Cluster', name: p.Name }], { name: p.Name, roleArn: p.RoleArn, version: p.Version, resourcesVpcConfig: p.ResourcesVpcConfig }, () => {
    authorize(ctx, 'eks:CreateCluster', arnOf(ctx, 'cluster', p.Name ?? '*'));
    const name = p.Name ?? '';
    if (!/^[0-9A-Za-z][A-Za-z0-9\-_]{0,99}$/.test(name)) throw new AwsError('InvalidParameterException', 'Invalid cluster name: the name must be 1-100 characters, start with an alphanumeric character and contain only alphanumeric characters, hyphens and underscores.');
    if (cs(ctx.s).eks.some((x) => x.name === name && x.region === ctx.region)) throw new AwsError('ResourceInUseException', `Cluster already exists with name: ${name}`, 409);
    const role = roleOf(ctx.s, p.RoleArn ?? '');
    if (!role || !trustsService(role, 'eks.amazonaws.com')) throw badRole(p.RoleArn);
    const v = p.ResourcesVpcConfig ?? {};
    const subs = (v.subnetIds ?? []).map((id) => { const sn = ctx.s.subnets.find((x) => x.id === id && x.region === ctx.region); if (!sn) throw new AwsError('InvalidParameterException', `The subnet ID '${id}' does not exist`); return sn; });
    if (subs.length < 2 || new Set(subs.map((x) => x.az)).size < 2) throw new AwsError('InvalidParameterException', 'Subnets specified must be in at least two different AZs');
    if (new Set(subs.map((x) => x.vpcId)).size > 1) throw new AwsError('InvalidParameterException', 'Subnets specified must belong to the same VPC');
    for (const g of v.securityGroupIds ?? []) if (!ctx.s.securityGroups.some((x) => x.id === g)) throw new AwsError('InvalidParameterException', `The security group '${g}' does not exist`);
    const version = String(p.Version ?? '1.31');
    if (!EKS_VERSIONS.includes(version)) throw new AwsError('InvalidParameterException', `unsupported Kubernetes version`);
    const vpcId = subs[0].vpcId;
    const sg = { id: ids.sg(), name: `eks-cluster-sg-${name}-${digits(10)}`, description: 'EKS created security group applied to ENI that is attached to EKS Control Plane master nodes, as well as any managed workloads.', vpcId, region: ctx.region, ingress: [] as any[], egress: [{ id: ids.sgRule(), protocol: '-1', from: 0, to: 65535, cidr: '0.0.0.0/0' }], tags: { 'aws:eks:cluster-name': name } };
    sg.ingress.push({ id: ids.sgRule(), protocol: '-1', from: 0, to: 65535, sourceSg: sg.id });
    ctx.s.securityGroups.push(sg);
    const id = hex(32).toUpperCase();
    const c: EksCluster = {
      name, arn: arnOf(ctx, 'cluster', name), region: ctx.region, status: 'CREATING', createdAt: now(), roleArn: p.RoleArn, version, endpoint: `https://${id}.gr7.${ctx.region}.eks.amazonaws.com`, subnetIds: subs.map((x) => x.id),
      securityGroupIds: v.securityGroupIds ?? [], clusterSecurityGroupId: sg.id, vpcId, endpointPublicAccess: v.endpointPublicAccess === undefined ? true : String(v.endpointPublicAccess) !== 'false', endpointPrivateAccess: String(v.endpointPrivateAccess) === 'true',
      certificateAuthority: btoa(sha(name)).slice(0, 80), platformVersion: 'eks.7', oidcIssuer: `https://oidc.eks.${ctx.region}.amazonaws.com/id/${id}`, nodegroups: [], addons: [], tags: tagMap(p.Tags),
      accessEntries: [], creatorArn: principalOf(ctx.caller), kube: newKube(),
    };
    cs(ctx.s).eks.push(c);
    settleEks(ctx.s);
    return c;
  });
}
export function describeCluster(ctx: Ctx, p: { Name: string }): EksCluster {
  return trailed(ctx, SRC, 'DescribeCluster', [], { name: p.Name }, () => {
    authorize(ctx, 'eks:DescribeCluster', arnOf(ctx, 'cluster', p.Name));
    settleEks(ctx.s);
    return getCluster(ctx, p.Name);
  });
}
export function listClusters(ctx: Ctx): EksCluster[] {
  return trailed(ctx, SRC, 'ListClusters', [], {}, () => { authorize(ctx, 'eks:ListClusters', '*'); settleEks(ctx.s); return cs(ctx.s).eks.filter((c) => c.region === ctx.region); });
}
export function deleteCluster(ctx: Ctx, p: { Name: string }): EksCluster {
  return trailed(ctx, SRC, 'DeleteCluster', [{ type: 'AWS::EKS::Cluster', name: p.Name }], { name: p.Name }, () => {
    authorize(ctx, 'eks:DeleteCluster', arnOf(ctx, 'cluster', p.Name));
    const c = getCluster(ctx, p.Name);
    if (c.nodegroups.length) throw new AwsError('ResourceInUseException', `Cluster has nodegroups attached`, 409);
    if (c.status === 'CREATING') throw new AwsError('ResourceInUseException', `Cluster is not in ACTIVE status`.replace('Cluster is not in ACTIVE status', `Cluster ${p.Name} is in CREATING state`), 409);
    c.status = 'DELETING';
    (c as any).deletingAt = now();
    settleEks(ctx.s);
    return c;
  });
}

// ------------------------------------------------------------------ grupos de nodos

export const AMI_TYPES = ['AL2023_x86_64_STANDARD', 'AL2_x86_64', 'BOTTLEROCKET_x86_64', 'AL2023_ARM_64_STANDARD'];
const ngArn = (ctx: Ctx, cl: string, n: string, id: string) => arnOf(ctx, 'nodegroup', `${cl}/${n}/${id}`);
const NG_TAG = (c: EksCluster, n: NodeGroup) => ({ 'eks:cluster-name': c.name, 'eks:nodegroup-name': n.name, [`kubernetes.io/cluster/${c.name}`]: 'owned', Name: `${c.name}-${n.name}-Node` });
export const nodeInstances = (s: CloudState, c: EksCluster, ng: NodeGroup) => s.instances.filter((i) => i.tags['eks:cluster-name'] === c.name && i.tags['eks:nodegroup-name'] === ng.name && i.state !== 'terminated' && i.state !== 'shutting-down');
const svcCtx = (s: CloudState, region: string): Ctx => ({ s, region, caller: { type: 'Root', arn: 'eks.amazonaws.com', userName: 'eks.amazonaws.com', mfa: false, sourceIp: 'eks.amazonaws.com' } });

function launchNodes(s: CloudState, c: EksCluster, ng: NodeGroup, n: number) {
  const ctx = svcCtx(s, c.region);
  for (let k = 0; k < n; k++) {
    const cur = nodeInstances(s, c, ng);
    const sub = [...ng.subnets].sort((a, b) => cur.filter((i) => i.subnetId === a).length - cur.filter((i) => i.subnetId === b).length)[0];
    runInstances(ctx, { ImageId: 'ami-0a1b2c3d4e5f60001', InstanceType: ng.instanceTypes[0], SubnetId: sub, SecurityGroupIds: [c.clusterSecurityGroupId], VolumeSize: ng.diskSize, Tags: NG_TAG(c, ng) });
  }
}

export function createNodegroup(ctx: Ctx, p: { ClusterName: string; NodegroupName: string; Subnets?: string[]; NodeRole: string; ScalingConfig?: { minSize?: any; maxSize?: any; desiredSize?: any }; InstanceTypes?: string[]; AmiType?: string; DiskSize?: number; CapacityType?: string; Labels?: Record<string, string>; Tags?: any }): NodeGroup {
  return trailed(ctx, SRC, 'CreateNodegroup', [{ type: 'AWS::EKS::Nodegroup', name: p.NodegroupName }], { name: p.ClusterName, nodegroupName: p.NodegroupName, subnets: p.Subnets, nodeRole: p.NodeRole, scalingConfig: p.ScalingConfig, instanceTypes: p.InstanceTypes }, () => {
    authorize(ctx, 'eks:CreateNodegroup', arnOf(ctx, 'nodegroup', `${p.ClusterName}/${p.NodegroupName}/*`));
    const c = getCluster(ctx, p.ClusterName);
    settleEks(ctx.s);
    if (c.status !== 'ACTIVE') throw new AwsError('ResourceInUseException', `Cluster '${c.name}' is not in ACTIVE status`, 409);
    if (!/^[0-9A-Za-z][A-Za-z0-9\-_]{0,62}$/.test(p.NodegroupName ?? '')) throw new AwsError('InvalidParameterException', 'Invalid nodegroup name: the name must be 1-63 characters, start with an alphanumeric character and contain only alphanumeric characters, hyphens and underscores.');
    if (c.nodegroups.some((n) => n.name === p.NodegroupName)) throw new AwsError('ResourceInUseException', `NodeGroup already exists with name ${p.NodegroupName} and cluster name ${c.name}`, 409);
    const role = roleOf(ctx.s, p.NodeRole ?? '');
    if (!role || !trustsService(role, 'ec2.amazonaws.com')) throw badRole(p.NodeRole);
    const subnets = p.Subnets?.length ? p.Subnets : c.subnetIds;
    for (const id of subnets) { const sn = ctx.s.subnets.find((x) => x.id === id && x.region === ctx.region); if (!sn) throw new AwsError('InvalidParameterException', `The subnet ID '${id}' does not exist`); if (sn.vpcId !== c.vpcId) throw new AwsError('InvalidParameterException', `The subnet ID '${id}' does not belong to the VPC of the cluster`); }
    const sc = { minSize: Number(p.ScalingConfig?.minSize ?? 1), maxSize: Number(p.ScalingConfig?.maxSize ?? 2), desiredSize: Number(p.ScalingConfig?.desiredSize ?? p.ScalingConfig?.minSize ?? 2) };
    if (sc.maxSize < 1) throw new AwsError('InvalidParameterException', `Max size must be at least 1`.replace('Max size must be at least 1', 'Maximum capacity must be at least 1'));
    if (sc.minSize > sc.desiredSize) throw new AwsError('InvalidParameterException', `Minimum capacity ${sc.minSize} can't be greater than desired size ${sc.desiredSize}`);
    if (sc.desiredSize > sc.maxSize) throw new AwsError('InvalidParameterException', `Desired capacity ${sc.desiredSize} can't be greater than max size ${sc.maxSize}`);
    const types = p.InstanceTypes?.length ? p.InstanceTypes : ['t3.medium'];
    for (const t of types) if (!INSTANCE_TYPES[t]) throw new AwsError('InvalidParameterException', `Requested instance type ${t} is not supported in this simulator`.replace('Requested instance type', 'The requested instance type').replace(' is not supported in this simulator', ' is not supported'));
    const ami = p.AmiType ?? 'AL2023_x86_64_STANDARD';
    if (!AMI_TYPES.includes(ami)) throw new AwsError('InvalidParameterException', `Invalid ami type: ${ami}`);
    const cap = p.CapacityType ?? 'ON_DEMAND';
    if (!['ON_DEMAND', 'SPOT'].includes(cap)) throw new AwsError('InvalidParameterException', `Invalid capacity type: ${cap}`);
    const ng: NodeGroup = {
      name: p.NodegroupName, arn: ngArn(ctx, c.name, p.NodegroupName, hex(8) + '-' + hex(4) + '-' + hex(4) + '-' + hex(4) + '-' + hex(12)), status: 'CREATING', createdAt: now(), nodeRole: p.NodeRole, subnets, instanceTypes: types, amiType: ami, capacityType: cap, diskSize: Number(p.DiskSize ?? 20),
      scaling: sc, labels: p.Labels ?? {}, tags: tagMap(p.Tags), version: c.version, releaseVersion: `${c.version}.${c.version === '1.31' ? 2 : 4}-20250101`,
    };
    c.nodegroups.push(ng);
    launchNodes(ctx.s, c, ng, sc.desiredSize);
    settleEks(ctx.s);
    return ng;
  });
}
export function getNodegroup(ctx: Ctx, cluster: string, name: string): { c: EksCluster; ng: NodeGroup } {
  const c = getCluster(ctx, cluster);
  const ng = c.nodegroups.find((n) => n.name === name);
  if (!ng) throw new AwsError('ResourceNotFoundException', `No node group found for name: ${name}.`, 404);
  return { c, ng };
}
export function describeNodegroup(ctx: Ctx, p: { ClusterName: string; NodegroupName: string }) {
  return trailed(ctx, SRC, 'DescribeNodegroup', [], { name: p.ClusterName, nodegroupName: p.NodegroupName }, () => {
    authorize(ctx, 'eks:DescribeNodegroup', arnOf(ctx, 'nodegroup', `${p.ClusterName}/${p.NodegroupName}/*`));
    settleEks(ctx.s);
    return getNodegroup(ctx, p.ClusterName, p.NodegroupName);
  });
}
export function listNodegroups(ctx: Ctx, p: { ClusterName: string }): NodeGroup[] {
  return trailed(ctx, SRC, 'ListNodegroups', [], { name: p.ClusterName }, () => { authorize(ctx, 'eks:ListNodegroups', arnOf(ctx, 'cluster', p.ClusterName)); return getCluster(ctx, p.ClusterName).nodegroups; });
}
export function updateNodegroupConfig(ctx: Ctx, p: { ClusterName: string; NodegroupName: string; ScalingConfig?: { minSize?: any; maxSize?: any; desiredSize?: any } }) {
  return trailed(ctx, SRC, 'UpdateNodegroupConfig', [], { name: p.ClusterName, nodegroupName: p.NodegroupName, scalingConfig: p.ScalingConfig }, () => {
    authorize(ctx, 'eks:UpdateNodegroupConfig', arnOf(ctx, 'nodegroup', `${p.ClusterName}/${p.NodegroupName}/*`));
    const { ng } = getNodegroup(ctx, p.ClusterName, p.NodegroupName);
    if (ng.status === 'CREATE_FAILED' || ng.status === 'DELETING') throw new AwsError('ResourceInUseException', `Nodegroup ${ng.name} is in ${ng.status} status`, 409);
    const sc = { ...ng.scaling, ...Object.fromEntries(Object.entries(p.ScalingConfig ?? {}).map(([k, v]) => [k, Number(v)])) };
    if (sc.minSize > sc.desiredSize) throw new AwsError('InvalidParameterException', `Minimum capacity ${sc.minSize} can't be greater than desired size ${sc.desiredSize}`);
    if (sc.desiredSize > sc.maxSize) throw new AwsError('InvalidParameterException', `Desired capacity ${sc.desiredSize} can't be greater than max size ${sc.maxSize}`);
    ng.scaling = sc;
    ng.status = 'UPDATING';
    (ng as any).updatingAt = now();
    settleEks(ctx.s);
    return { id: hex(8) + '-' + hex(4) + '-' + hex(4) + '-' + hex(4) + '-' + hex(12), status: 'InProgress', type: 'ConfigUpdate', params: Object.entries(sc).map(([type, value]) => ({ type: type.replace(/^./, (c) => c.toUpperCase()), value: String(value) })), createdAt: now() };
  });
}
export function deleteNodegroup(ctx: Ctx, p: { ClusterName: string; NodegroupName: string }): NodeGroup {
  return trailed(ctx, SRC, 'DeleteNodegroup', [{ type: 'AWS::EKS::Nodegroup', name: p.NodegroupName }], { name: p.ClusterName, nodegroupName: p.NodegroupName }, () => {
    authorize(ctx, 'eks:DeleteNodegroup', arnOf(ctx, 'nodegroup', `${p.ClusterName}/${p.NodegroupName}/*`));
    const { c, ng } = getNodegroup(ctx, p.ClusterName, p.NodegroupName);
    ng.status = 'DELETING';
    (ng as any).deletingAt = now();
    const insts = nodeInstances(ctx.s, c, ng);
    if (insts.length) terminateInstances(svcCtx(ctx.s, c.region), { InstanceIds: insts.map((i) => i.id) });
    settleEks(ctx.s);
    return ng;
  });
}

// ------------------------------------------------------------------ complementos

const ADDONS: Record<string, string[]> = {
  'vpc-cni': ['v1.19.0-eksbuild.1', 'v1.18.5-eksbuild.1'],
  coredns: ['v1.11.3-eksbuild.2', 'v1.11.1-eksbuild.9'],
  'kube-proxy': ['v1.31.2-eksbuild.3', 'v1.30.6-eksbuild.3'],
  'aws-ebs-csi-driver': ['v1.37.0-eksbuild.1', 'v1.35.0-eksbuild.2'],
  'eks-pod-identity-agent': ['v1.3.4-eksbuild.1'],
};
export const addonNames = () => Object.keys(ADDONS);
export const addonVersions = (n: string) => ADDONS[n];
export function createAddon(ctx: Ctx, p: { ClusterName: string; AddonName: string; AddonVersion?: string; ServiceAccountRoleArn?: string }): EksAddon {
  return trailed(ctx, SRC, 'CreateAddon', [{ type: 'AWS::EKS::Addon', name: p.AddonName }], { name: p.ClusterName, addonName: p.AddonName, addonVersion: p.AddonVersion }, () => {
    authorize(ctx, 'eks:CreateAddon', arnOf(ctx, 'addon', `${p.ClusterName}/${p.AddonName}/*`));
    const c = getCluster(ctx, p.ClusterName);
    if (!ADDONS[p.AddonName]) throw new AwsError('InvalidParameterException', `Addon specified is not supported: ${p.AddonName}`.replace('Addon specified is not supported: ', 'No addon found with name: '));
    if (c.addons.some((a) => a.name === p.AddonName)) throw new AwsError('ResourceInUseException', `Addon already exists.`, 409);
    const v = p.AddonVersion ?? ADDONS[p.AddonName][0];
    if (!ADDONS[p.AddonName].includes(v)) throw new AwsError('InvalidParameterException', `Addon version specified is not supported`);
    if (p.ServiceAccountRoleArn && !roleOf(ctx.s, p.ServiceAccountRoleArn)) throw badRole(p.ServiceAccountRoleArn);
    const a: EksAddon = { name: p.AddonName, version: v, status: 'CREATING', arn: arnOf(ctx, 'addon', `${c.name}/${p.AddonName}/${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`), createdAt: now(), serviceAccountRoleArn: p.ServiceAccountRoleArn };
    c.addons.push(a);
    settleEks(ctx.s);
    return a;
  });
}
export function describeAddon(ctx: Ctx, p: { ClusterName: string; AddonName: string }): EksAddon {
  return trailed(ctx, SRC, 'DescribeAddon', [], { name: p.ClusterName, addonName: p.AddonName }, () => {
    authorize(ctx, 'eks:DescribeAddon', arnOf(ctx, 'addon', `${p.ClusterName}/${p.AddonName}/*`));
    settleEks(ctx.s);
    const a = getCluster(ctx, p.ClusterName).addons.find((x) => x.name === p.AddonName);
    if (!a) throw new AwsError('ResourceNotFoundException', `No addon: ${p.AddonName} found in cluster: ${p.ClusterName}`, 404);
    return a;
  });
}
export function listAddons(ctx: Ctx, p: { ClusterName: string }): EksAddon[] {
  return trailed(ctx, SRC, 'ListAddons', [], { name: p.ClusterName }, () => { authorize(ctx, 'eks:ListAddons', arnOf(ctx, 'cluster', p.ClusterName)); return getCluster(ctx, p.ClusterName).addons; });
}
export function deleteAddon(ctx: Ctx, p: { ClusterName: string; AddonName: string }): EksAddon {
  return trailed(ctx, SRC, 'DeleteAddon', [], { name: p.ClusterName, addonName: p.AddonName }, () => {
    authorize(ctx, 'eks:DeleteAddon', arnOf(ctx, 'addon', `${p.ClusterName}/${p.AddonName}/*`));
    const c = getCluster(ctx, p.ClusterName);
    const a = c.addons.find((x) => x.name === p.AddonName);
    if (!a) throw new AwsError('ResourceNotFoundException', `No addon: ${p.AddonName} found in cluster: ${p.ClusterName}`, 404);
    a.status = 'DELETING';
    (a as any).deletingAt = now();
    settleEks(ctx.s);
    return a;
  });
}

// ------------------------------------------------------------------ acceso (kubectl)

export function createAccessEntry(ctx: Ctx, p: { ClusterName: string; PrincipalArn: string }) {
  return trailed(ctx, SRC, 'CreateAccessEntry', [], { clusterName: p.ClusterName, principalArn: p.PrincipalArn }, () => {
    authorize(ctx, 'eks:CreateAccessEntry', arnOf(ctx, 'cluster', p.ClusterName));
    const c = getCluster(ctx, p.ClusterName);
    if (!roleOf(ctx.s, p.PrincipalArn) && !ctx.s.users.some((u) => u.arn === p.PrincipalArn)) throw new AwsError('InvalidParameterException', `The specified principalArn is invalid: invalid principal: ${p.PrincipalArn}`);
    if (c.accessEntries.some((e) => e.principalArn === p.PrincipalArn)) throw new AwsError('ResourceInUseException', `The specified access entry resource is already in use on this cluster.`, 409);
    const e = { principalArn: p.PrincipalArn, policies: [] as string[], createdAt: now() };
    c.accessEntries.push(e);
    return e;
  });
}
export function associateAccessPolicy(ctx: Ctx, p: { ClusterName: string; PrincipalArn: string; PolicyArn: string }) {
  return trailed(ctx, SRC, 'AssociateAccessPolicy', [], { clusterName: p.ClusterName, principalArn: p.PrincipalArn, policyArn: p.PolicyArn }, () => {
    authorize(ctx, 'eks:AssociateAccessPolicy', arnOf(ctx, 'cluster', p.ClusterName));
    const c = getCluster(ctx, p.ClusterName);
    const e = c.accessEntries.find((x) => x.principalArn === p.PrincipalArn);
    if (!e) throw new AwsError('ResourceNotFoundException', `The specified access entry resource could not be found.`, 404);
    if (!/^arn:aws:eks::aws:cluster-access-policy\/Amazon(EKS)?\w+Policy$/.test(p.PolicyArn)) throw new AwsError('InvalidParameterException', `The specified policy ARN is not valid: ${p.PolicyArn}`);
    if (!e.policies.includes(p.PolicyArn)) e.policies.push(p.PolicyArn);
    return c;
  });
}
export function listAccessEntries(ctx: Ctx, p: { ClusterName: string }): string[] {
  return trailed(ctx, SRC, 'ListAccessEntries', [], { clusterName: p.ClusterName }, () => { authorize(ctx, 'eks:ListAccessEntries', arnOf(ctx, 'cluster', p.ClusterName)); const c = getCluster(ctx, p.ClusterName); return [c.creatorArn, ...c.accessEntries.map((e) => e.principalArn)].filter((x, i, a) => a.indexOf(x) === i); });
}
/** ¿Puede esta identidad hablar con el servidor de API (Unauthorized en caso contrario)? */
export function kubeAuthorized(c: EksCluster, caller: Caller): boolean {
  if (caller.type === 'Root') return true;
  const me = principalOf(caller);
  return me === c.creatorArn || c.accessEntries.some((e) => e.principalArn === me && e.policies.length > 0);
}

/** Configuración de kubectl (formato de ~/.kube/config) como la escribe `aws eks update-kubeconfig`. */
export function kubeconfigYaml(c: EksCluster, alias?: string): { yaml: string; context: string } {
  const context = alias ?? c.arn;
  const yaml = [
    'apiVersion: v1', 'clusters:', '- cluster:', `    certificate-authority-data: ${c.certificateAuthority}`, `    server: ${c.endpoint}`, `  name: ${c.arn}`, 'contexts:', '- context:', `    cluster: ${c.arn}`, `    user: ${c.arn}`, `  name: ${context}`,
    `current-context: ${context}`, 'kind: Config', 'preferences: {}', 'users:', `- name: ${c.arn}`, '  user:', '    exec:', '      apiVersion: client.authentication.k8s.io/v1beta1', '      args:', '      - --region', `      - ${c.region}`, '      - eks', '      - get-token', '      - --cluster-name', `      - ${c.name}`, '      - --output', '      - json', '      command: aws', '',
  ].join('\n');
  return { yaml, context };
}

// ------------------------------------------------------------------ evaluación perezosa

function nodesCanJoin(s: CloudState, c: EksCluster, ng: NodeGroup): string | undefined {
  const role = roleOf(s, ng.nodeRole);
  const has = (n: string) => !!role?.attached.some((a) => a.endsWith('/' + n));
  if (!role || !has('AmazonEKSWorkerNodePolicy') || !has('AmazonEKS_CNI_Policy')) return 'AccessDenied';
  for (const id of ng.subnets) {
    const sn = s.subnets.find((x) => x.id === id);
    if (!sn) continue;
    const def = routeTableOfSubnet(s, sn).routes.find((r) => r.destination === '0.0.0.0/0');
    const ok = !!def && ((def.target.startsWith('igw-') && sn.mapPublicIpOnLaunch) || def.target.startsWith('nat-'));
    if (!ok) return 'NodeCreationFailure';
  }
  void c;
  return undefined;
}

let settling = false;
export function settleEks(s: CloudState) {
  if (settling || !s.containers?.eks.length) return;
  settling = true;
  try {
    const f = speedFactor();
    const st = cs(s);
    for (const c of [...st.eks]) {
      if (c.status === 'CREATING' && (f === 0 || now() - c.createdAt >= 25_000 * f)) { c.status = 'ACTIVE'; seedCluster(c); }
      if (c.status === 'DELETING') {
        if (f === 0 || now() - ((c as any).deletingAt ?? 0) >= 10_000 * f) { st.eks = st.eks.filter((x) => x !== c); s.securityGroups = s.securityGroups.filter((g) => g.id !== c.clusterSecurityGroupId); }
        continue;
      }
      for (const a of [...c.addons]) {
        if (a.status === 'CREATING' && (f === 0 || now() - a.createdAt >= 8000 * f)) {
          a.status = 'ACTIVE';
          if (a.name === 'aws-ebs-csi-driver' && c.status === 'ACTIVE') {
            const img = `602401143452.dkr.ecr.${c.region}.amazonaws.com/eks/aws-ebs-csi-driver:${a.version.split('-')[0]}`;
            const tpl = (n: string) => ({ metadata: { labels: { app: n } }, spec: { containers: [{ name: n, image: img, resources: { requests: { cpu: '10m', memory: '40Mi' } } }] } });
            applyDoc(c, { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'ebs-csi-controller', namespace: 'kube-system' }, spec: { replicas: 2, selector: { matchLabels: { app: 'ebs-csi-controller' } }, template: tpl('ebs-csi-controller') } }, 'kube-system');
            applyDoc(c, { apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name: 'ebs-csi-node', namespace: 'kube-system' }, spec: { selector: { matchLabels: { app: 'ebs-csi-node' } }, template: tpl('ebs-csi-node') } }, 'kube-system');
          }
        }
        if (a.status === 'DELETING' && (f === 0 || now() - ((a as any).deletingAt ?? 0) >= 6000 * f)) {
          c.addons = c.addons.filter((x) => x !== a);
          if (a.name === 'aws-ebs-csi-driver') c.kube.objects = c.kube.objects.filter((o) => !(o.metadata.namespace === 'kube-system' && /^ebs-csi-/.test(o.metadata.name)) && !(o.metadata.owner && /^ebs-csi-/.test(o.metadata.owner.name)));
        }
      }
      for (const ng of [...c.nodegroups]) {
        const live = nodeInstances(s, c, ng);
        if (ng.status === 'DELETING') {
          if (!live.length && (f === 0 || now() - ((ng as any).deletingAt ?? 0) >= 12_000 * f)) c.nodegroups = c.nodegroups.filter((x) => x !== ng);
          continue;
        }
        if (ng.status === 'CREATING') {
          const why = nodesCanJoin(s, c, ng);
          if (why && (f === 0 || now() - ng.createdAt >= 20_000 * f)) {
            ng.status = 'CREATE_FAILED';
            ng.health = { code: why, message: why === 'AccessDenied' ? 'Instances failed to join the kubernetes cluster: the node role lacks the required policies (AmazonEKSWorkerNodePolicy, AmazonEKS_CNI_Policy)' : 'Instances failed to join the kubernetes cluster', resourceIds: live.map((i) => i.id) };
            if (live.length) terminateInstances(svcCtx(s, c.region), { InstanceIds: live.map((i) => i.id) });
          } else if (!why && live.every((i) => i.state === 'running') && (f === 0 || now() - ng.createdAt >= 30_000 * f)) ng.status = 'ACTIVE';
          continue;
        }
        if (ng.status === 'UPDATING' || ng.status === 'ACTIVE') {
          if (live.length < ng.scaling.desiredSize) launchNodes(s, c, ng, ng.scaling.desiredSize - live.length);
          else if (live.length > ng.scaling.desiredSize) terminateInstances(svcCtx(s, c.region), { InstanceIds: [...live].sort((a, b) => Date.parse(b.launchTime) - Date.parse(a.launchTime)).slice(0, live.length - ng.scaling.desiredSize).map((i) => i.id) });
          if (ng.status === 'UPDATING' && (f === 0 || now() - ((ng as any).updatingAt ?? 0) >= 15_000 * f)) ng.status = 'ACTIVE';
        }
      }
      reconcile(s, c);
    }
  } finally { settling = false; }
}
settleHooks.push(settleEks);

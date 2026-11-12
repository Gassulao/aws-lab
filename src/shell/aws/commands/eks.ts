// aws eks: clústeres, grupos de nodos, complementos, acceso y kubeconfig.
import yaml from 'js-yaml';
import { defineCommand, type Params } from '../framework';
import * as eks from '../../../engine/services/eks';
import { cs, type EksAddon, type EksCluster, type NodeGroup } from '../../../engine/services/containerCore';
import { settle } from '../../../engine/services/ec2';
import { speedFactor } from '../../../engine/store';
import { homeDir } from '../../../engine/store';
import { VFS } from '../../fs';

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000+00:00');
const need = (p: Params, key: string, opt: string) => { if (p[key] === undefined) throw new Error(`aws: error: the following arguments are required: --${opt}`); return p[key]; };
const arr = (v: any): any[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

const clusterShape = (c: EksCluster) => ({
  name: c.name, arn: c.arn, createdAt: iso(c.createdAt), version: c.version, ...(c.status === 'CREATING' ? {} : { endpoint: c.endpoint }), roleArn: c.roleArn,
  resourcesVpcConfig: { subnetIds: c.subnetIds, securityGroupIds: c.securityGroupIds, ...(c.status === 'CREATING' ? {} : { clusterSecurityGroupId: c.clusterSecurityGroupId }), vpcId: c.vpcId, endpointPublicAccess: c.endpointPublicAccess, endpointPrivateAccess: c.endpointPrivateAccess, publicAccessCidrs: ['0.0.0.0/0'] },
  kubernetesNetworkConfig: { serviceIpv4Cidr: '10.100.0.0/16', ipFamily: 'ipv4' }, logging: { clusterLogging: [{ types: ['api', 'audit', 'authenticator', 'controllerManager', 'scheduler'], enabled: false }] },
  identity: { oidc: { issuer: c.oidcIssuer } }, status: c.status, ...(c.status === 'CREATING' ? {} : { certificateAuthority: { data: c.certificateAuthority } }), platformVersion: c.platformVersion, tags: c.tags,
  accessConfig: { authenticationMode: 'API_AND_CONFIG_MAP' }, upgradePolicy: { supportType: 'EXTENDED' },
});
const ngShape = (c: EksCluster, n: NodeGroup) => ({
  nodegroupName: n.name, nodegroupArn: n.arn, clusterName: c.name, version: n.version, releaseVersion: n.releaseVersion, createdAt: iso(n.createdAt), modifiedAt: iso(n.createdAt), status: n.status, capacityType: n.capacityType,
  scalingConfig: n.scaling, instanceTypes: n.instanceTypes, subnets: n.subnets, amiType: n.amiType, nodeRole: n.nodeRole, labels: n.labels, ...(n.status === 'CREATE_FAILED' ? {} : { resources: { autoScalingGroups: [{ name: `eks-${n.name}-${n.arn.split('/').pop()}` }] } }),
  health: { issues: n.health ? [{ code: n.health.code, message: n.health.message, resourceIds: n.health.resourceIds }] : [] }, updateConfig: { maxUnavailable: 1 }, diskSize: n.diskSize, tags: n.tags,
});
const addonShape = (c: EksCluster, a: EksAddon) => ({ addonName: a.name, clusterName: c.name, status: a.status, addonVersion: a.version, health: { issues: [] }, addonArn: a.arn, createdAt: iso(a.createdAt), modifiedAt: iso(a.createdAt), ...(a.serviceAccountRoleArn ? { serviceAccountRoleArn: a.serviceAccountRoleArn } : {}), tags: {} });
const vpc = (v: any) => (v && typeof v === 'object' ? v : {});

defineCommand({
  service: 'eks', name: 'create-cluster', op: 'CreateCluster', structured: ['resources-vpc-config', 'tags'],
  run: (c, p) => { const v = vpc(need(p, 'ResourcesVpcConfig', 'resources-vpc-config')); return { cluster: clusterShape(eks.createCluster(c, { Name: need(p, 'Name', 'name'), RoleArn: need(p, 'RoleArn', 'role-arn'), ResourcesVpcConfig: { subnetIds: arr(v.subnetIds), securityGroupIds: arr(v.securityGroupIds), endpointPublicAccess: v.endpointPublicAccess, endpointPrivateAccess: v.endpointPrivateAccess }, Version: p.KubernetesVersion, Tags: p.Tags })) }; },
});
defineCommand({ service: 'eks', name: 'describe-cluster', op: 'DescribeCluster', run: (c, p) => ({ cluster: clusterShape(eks.describeCluster(c, { Name: need(p, 'Name', 'name') })) }) });
defineCommand({ service: 'eks', name: 'list-clusters', op: 'ListClusters', run: (c) => ({ clusters: eks.listClusters(c).map((x) => x.name) }) });
defineCommand({ service: 'eks', name: 'delete-cluster', op: 'DeleteCluster', run: (c, p) => ({ cluster: clusterShape(eks.deleteCluster(c, { Name: need(p, 'Name', 'name') })) }) });

defineCommand({
  service: 'eks', name: 'create-nodegroup', op: 'CreateNodegroup', list: ['subnets', 'instance-types'], structured: ['scaling-config', 'labels', 'tags'],
  run: (c, p) => ({ nodegroup: ngShape(eks.getCluster(c, p.ClusterName), eks.createNodegroup(c, { ClusterName: need(p, 'ClusterName', 'cluster-name'), NodegroupName: need(p, 'NodegroupName', 'nodegroup-name'), Subnets: p.Subnets, NodeRole: need(p, 'NodeRole', 'node-role'), ScalingConfig: p.ScalingConfig, InstanceTypes: p.InstanceTypes, AmiType: p.AmiType, DiskSize: p.DiskSize === undefined ? undefined : Number(p.DiskSize), CapacityType: p.CapacityType, Labels: p.Labels, Tags: p.Tags })) }),
});
defineCommand({ service: 'eks', name: 'describe-nodegroup', op: 'DescribeNodegroup', run: (c, p) => { const r = eks.describeNodegroup(c, { ClusterName: need(p, 'ClusterName', 'cluster-name'), NodegroupName: need(p, 'NodegroupName', 'nodegroup-name') }); return { nodegroup: ngShape(r.c, r.ng) }; } });
defineCommand({ service: 'eks', name: 'list-nodegroups', op: 'ListNodegroups', run: (c, p) => ({ nodegroups: eks.listNodegroups(c, { ClusterName: need(p, 'ClusterName', 'cluster-name') }).map((n) => n.name) }) });
defineCommand({
  service: 'eks', name: 'update-nodegroup-config', op: 'UpdateNodegroupConfig', structured: ['scaling-config'],
  run: (c, p) => { const u = eks.updateNodegroupConfig(c, { ClusterName: need(p, 'ClusterName', 'cluster-name'), NodegroupName: need(p, 'NodegroupName', 'nodegroup-name'), ScalingConfig: need(p, 'ScalingConfig', 'scaling-config') }); return { update: { id: u.id, status: u.status, type: u.type, params: u.params, createdAt: iso(u.createdAt), errors: [] } }; },
});
defineCommand({ service: 'eks', name: 'delete-nodegroup', op: 'DeleteNodegroup', run: (c, p) => ({ nodegroup: ngShape(eks.getCluster(c, p.ClusterName), eks.deleteNodegroup(c, { ClusterName: need(p, 'ClusterName', 'cluster-name'), NodegroupName: need(p, 'NodegroupName', 'nodegroup-name') })) }) });

defineCommand({
  service: 'eks', name: 'create-addon', op: 'CreateAddon',
  run: (c, p) => ({ addon: addonShape(eks.getCluster(c, p.ClusterName), eks.createAddon(c, { ClusterName: need(p, 'ClusterName', 'cluster-name'), AddonName: need(p, 'AddonName', 'addon-name'), AddonVersion: p.AddonVersion, ServiceAccountRoleArn: p.ServiceAccountRoleArn })) }),
});
defineCommand({ service: 'eks', name: 'describe-addon', op: 'DescribeAddon', run: (c, p) => ({ addon: addonShape(eks.getCluster(c, p.ClusterName), eks.describeAddon(c, { ClusterName: need(p, 'ClusterName', 'cluster-name'), AddonName: need(p, 'AddonName', 'addon-name') })) }) });
defineCommand({ service: 'eks', name: 'list-addons', op: 'ListAddons', run: (c, p) => ({ addons: eks.listAddons(c, { ClusterName: need(p, 'ClusterName', 'cluster-name') }).map((a) => a.name) }) });
defineCommand({ service: 'eks', name: 'delete-addon', op: 'DeleteAddon', run: (c, p) => ({ addon: addonShape(eks.getCluster(c, p.ClusterName), eks.deleteAddon(c, { ClusterName: need(p, 'ClusterName', 'cluster-name'), AddonName: need(p, 'AddonName', 'addon-name') })) }) });
defineCommand({
  service: 'eks', name: 'describe-addon-versions', op: 'DescribeAddonVersions',
  run: (_c, p) => ({ addons: eks.addonNames().filter((n) => !p.AddonName || n === p.AddonName).map((n) => ({ addonName: n, type: n === 'aws-ebs-csi-driver' ? 'storage' : n === 'vpc-cni' || n === 'kube-proxy' ? 'networking' : 'security', addonVersions: eks.addonVersions(n).map((v, i) => ({ addonVersion: v, architecture: ['amd64', 'arm64'], compatibilities: [{ clusterVersion: '1.31', platformVersions: ['*'], defaultVersion: i === 0 }] })) })) }),
});

defineCommand({
  service: 'eks', name: 'create-access-entry', op: 'CreateAccessEntry',
  run: (c, p) => { const e = eks.createAccessEntry(c, { ClusterName: need(p, 'ClusterName', 'cluster-name'), PrincipalArn: need(p, 'PrincipalArn', 'principal-arn') }); return { accessEntry: { clusterName: p.ClusterName, principalArn: e.principalArn, kubernetesGroups: [], accessEntryArn: `arn:aws:eks:${c.region}:${c.s.account.id}:access-entry/${p.ClusterName}/${e.principalArn.split(':').slice(5).join('/')}`, createdAt: iso(e.createdAt), modifiedAt: iso(e.createdAt), tags: {}, username: e.principalArn, type: 'STANDARD' } }; },
});
defineCommand({
  service: 'eks', name: 'associate-access-policy', op: 'AssociateAccessPolicy', structured: ['access-scope'],
  run: (c, p) => { eks.associateAccessPolicy(c, { ClusterName: need(p, 'ClusterName', 'cluster-name'), PrincipalArn: need(p, 'PrincipalArn', 'principal-arn'), PolicyArn: need(p, 'PolicyArn', 'policy-arn') }); return { clusterName: p.ClusterName, principalArn: p.PrincipalArn, associatedAccessPolicy: { policyArn: p.PolicyArn, accessScope: p.AccessScope ?? { type: 'cluster', namespaces: [] }, associatedAt: iso(Date.now()), modifiedAt: iso(Date.now()) } }; },
});
defineCommand({ service: 'eks', name: 'list-access-entries', op: 'ListAccessEntries', run: (c, p) => ({ accessEntries: eks.listAccessEntries(c, { ClusterName: need(p, 'ClusterName', 'cluster-name') }) }) });

// ------------------------------------------------------------------ kubeconfig

defineCommand({
  service: 'eks', name: 'update-kubeconfig', op: 'DescribeCluster', raw: true,
  run: (c, p, sh) => {
    const name = need(p, 'Name', 'name') as string;
    const cl = eks.describeCluster(c, { Name: name });
    if (cl.status !== 'ACTIVE') throw new Error(`\nCluster status is ${cl.status}`);
    const path = p.Kubeconfig ? VFS.norm(p.Kubeconfig, sh.cwd) : `${homeDir(sh.s)}/.kube/config`;
    const { yaml: y, context } = eks.kubeconfigYaml(cl, p.Alias);
    let cfg: any = { apiVersion: 'v1', clusters: [], contexts: [], 'current-context': '', kind: 'Config', preferences: {}, users: [] };
    let existed = false;
    if (sh.fs.exists(path)) { try { const old = yaml.load(sh.fs.readFile(path)) as any; if (old && typeof old === 'object') cfg = { ...cfg, ...old, clusters: old.clusters ?? [], contexts: old.contexts ?? [], users: old.users ?? [] }; } catch { /* se sobrescribe */ } }
    const nw = yaml.load(y) as any;
    existed = cfg.contexts.some((x: any) => x.name === context);
    const upsert = (list: any[], it: any) => { const i = list.findIndex((x) => x.name === it.name); if (i >= 0) list[i] = it; else list.push(it); };
    upsert(cfg.clusters, nw.clusters[0]); upsert(cfg.users, nw.users[0]); upsert(cfg.contexts, nw.contexts[0]);
    cfg['current-context'] = context;
    sh.fs.mkdir(path.split('/').slice(0, -1).join('/') || '/', true);
    sh.fs.writeFile(path, yaml.dump(cfg, { lineWidth: -1 }));
    return `${existed ? 'Updated' : 'Added new'} context ${context} ${existed ? 'in' : 'to'} ${path}\n`;
  },
});

// ------------------------------------------------------------------ wait

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(c: { s: any }, what: string, state: () => string | undefined, want: string | 'GONE', bad: string[]) {
  const limit = Date.now() + (speedFactor() === 0 ? 0 : 200_000);
  for (;;) {
    settle(c.s);
    const st = state();
    if ((want === 'GONE' && st === undefined) || st === want) return;
    if (st && bad.includes(st)) throw new Error(`\nWaiter ${what} failed: Waiter encountered a terminal failure state: For expression "${what.includes('Nodegroup') ? 'nodegroup' : 'cluster'}.status" we matched expected path: "${st}"`);
    if (Date.now() >= limit) throw new Error(`\nWaiter ${what} failed: Max attempts exceeded`);
    await sleep(500);
  }
}
defineCommand({
  service: 'eks', name: 'wait', op: 'Wait',
  run: async (c, p, _sh, pos) => {
    const w = pos[0];
    const cluster = () => cs(c.s).eks.find((x) => x.name === (p.Name ?? p.ClusterName) && x.region === c.region);
    const ng = () => cluster()?.nodegroups.find((n) => n.name === p.NodegroupName);
    if (w === 'cluster-active') await waitFor(c, 'ClusterActive', () => cluster()?.status, 'ACTIVE', ['DELETING', 'FAILED']);
    else if (w === 'cluster-deleted') await waitFor(c, 'ClusterDeleted', () => cluster()?.status, 'GONE', ['ACTIVE']);
    else if (w === 'nodegroup-active') await waitFor(c, 'NodegroupActive', () => ng()?.status, 'ACTIVE', ['CREATE_FAILED']);
    else if (w === 'nodegroup-deleted') await waitFor(c, 'NodegroupDeleted', () => ng()?.status, 'GONE', ['DELETE_FAILED']);
    else if (w === 'addon-active') await waitFor(c, 'AddonActive', () => cluster()?.addons.find((a) => a.name === p.AddonName)?.status, 'ACTIVE', ['CREATE_FAILED']);
    else throw new Error(`\nusage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\naws: error: argument operation: Invalid choice, valid choices are:\n\naddon-active | cluster-active | cluster-deleted | nodegroup-active | nodegroup-deleted`);
    return undefined;
  },
});

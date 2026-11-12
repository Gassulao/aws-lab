// aws deploy (la API de CodeDeploy cuelga de `aws deploy` en el CLI real)
import { defineCommand } from '../framework';
import * as cd from '../../../engine/services/codedeploy';
import '../../../engine/services/cicd';
import type { CdDeployment, CdGroup, CdTarget } from '../../../engine/services/cicdTypes';
import { iso, strip, bool } from './cicd-util';
import { packBundle, putBucketObject } from '../../../engine/services/cicdCommon';
import { VFS } from '../../fs';
import { AwsError } from '../../../engine/errors';
import { hex } from '../../../engine/util';

const S = 'deploy';
const groupView = (g: CdGroup, c: { s: { account: { id: string } } }) => strip({
  applicationName: g.appName, deploymentGroupId: g.id, deploymentGroupName: g.name, deploymentConfigName: g.configName, ec2TagFilters: g.ec2TagFilters, onPremisesInstanceTagFilters: [], autoScalingGroups: g.autoScalingGroups.map((name) => ({ name, hook: 'CodeDeploy-managed-automatic-launch-deployment-hook-' + g.id })),
  serviceRoleArn: g.serviceRoleArn, targetRevision: undefined, triggerConfigurations: [], autoRollbackConfiguration: g.autoRollback ? { enabled: true, events: ['DEPLOYMENT_FAILURE'] } : {},
  deploymentStyle: { deploymentType: 'IN_PLACE', deploymentOption: 'WITHOUT_TRAFFIC_CONTROL' }, outdatedInstancesStrategy: 'UPDATE', blueGreenDeploymentConfiguration: undefined, computePlatform: 'Server', lastSuccessfulDeployment: g.lastSuccessfulDeployment ? { deploymentId: g.lastSuccessfulDeployment } : undefined,
  lastAttemptedDeployment: g.lastAttemptedDeployment ? { deploymentId: g.lastAttemptedDeployment } : undefined, ecsServices: [], terminationHookEnabled: false, _a: c.s.account.id,
} as any);

export const deploymentView = (d: CdDeployment) => strip({
  applicationName: d.appName, deploymentGroupName: d.groupName, deploymentConfigName: d.configName, deploymentId: d.id,
  revision: { revisionType: 'S3', s3Location: d.revision.s3Location }, status: d.status, errorInformation: d.status === 'Failed' ? d.error : undefined,
  createTime: iso(d.created), startTime: iso(d.start), completeTime: d.complete ? iso(d.complete) : undefined, deploymentOverview: cd.overview(d), description: d.description, creator: d.creator,
  ignoreApplicationStopFailures: false, autoRollbackConfiguration: {}, updateOutdatedInstancesOnly: false, rollbackInfo: {}, deploymentStyle: { deploymentType: 'IN_PLACE', deploymentOption: 'WITHOUT_TRAFFIC_CONTROL' },
  instanceTerminationWaitTimeStarted: false, fileExistsBehavior: 'DISALLOW', deploymentStatusMessages: [], computePlatform: 'Server',
});
const targetView = (d: string, t: CdTarget) => ({ deploymentId: d, instanceId: t.instanceId, status: t.status, lastUpdatedAt: iso(t.lastUpdated), lifecycleEvents: t.lifecycle.map((l) => strip({ lifecycleEventName: l.name, diagnostics: l.diagnostics ? { errorCode: l.diagnostics.errorCode, scriptName: l.diagnostics.scriptName, message: l.diagnostics.message, logTail: l.diagnostics.logTail } : { errorCode: 'Success', scriptName: '', message: 'Succeeded', logTail: '' }, startTime: l.start ? iso(l.start) : undefined, endTime: l.end ? iso(l.end) : undefined, status: l.status })), instanceType: 'Blue' });

defineCommand({ service: S, name: 'create-application', op: 'CreateApplication', list: ['tags'], structured: ['tags'], run: (c, p) => ({ applicationId: cd.createApplication(c, { ApplicationName: p.ApplicationName, ComputePlatform: p.ComputePlatform, Tags: p.Tags }).id }) });
defineCommand({ service: S, name: 'get-application', op: 'GetApplication', run: (c, p) => { const a = cd.getApplication(c, { ApplicationName: p.ApplicationName }); return { application: { applicationId: a.id, applicationName: a.name, createTime: iso(a.created), linkedToGitHub: false, computePlatform: a.computePlatform } }; } });
defineCommand({ service: S, name: 'list-applications', op: 'ListApplications', run: (c) => ({ applications: cd.listApplications(c) }) });
defineCommand({ service: S, name: 'delete-application', op: 'DeleteApplication', run: (c, p) => void cd.deleteApplication(c, { ApplicationName: p.ApplicationName }) });
defineCommand({
  service: S, name: 'create-deployment-group', op: 'CreateDeploymentGroup', list: ['ec2-tag-filters', 'auto-scaling-groups'], structured: ['ec2-tag-filters', 'auto-rollback-configuration'],
  run: (c, p) => ({ deploymentGroupId: cd.createDeploymentGroup(c, { ApplicationName: p.ApplicationName, DeploymentGroupName: p.DeploymentGroupName, ServiceRoleArn: p.ServiceRoleArn, DeploymentConfigName: p.DeploymentConfigName, Ec2TagFilters: p.Ec2TagFilters, AutoScalingGroups: p.AutoScalingGroups, AutoRollbackConfiguration: p.AutoRollbackConfiguration }).id }),
});
defineCommand({
  service: S, name: 'update-deployment-group', op: 'UpdateDeploymentGroup', list: ['ec2-tag-filters', 'auto-scaling-groups'], structured: ['ec2-tag-filters'],
  run: (c, p) => { cd.updateDeploymentGroup(c, { ApplicationName: p.ApplicationName, CurrentDeploymentGroupName: p.CurrentDeploymentGroupName, NewDeploymentGroupName: p.NewDeploymentGroupName, ServiceRoleArn: p.ServiceRoleArn, DeploymentConfigName: p.DeploymentConfigName, Ec2TagFilters: p.Ec2TagFilters, AutoScalingGroups: p.AutoScalingGroups }); return { hooksNotCleanedUp: [] }; },
});
defineCommand({ service: S, name: 'get-deployment-group', op: 'GetDeploymentGroup', run: (c, p) => ({ deploymentGroupInfo: groupView(cd.getDeploymentGroup(c, { ApplicationName: p.ApplicationName, DeploymentGroupName: p.DeploymentGroupName }), c) }) });
defineCommand({ service: S, name: 'list-deployment-groups', op: 'ListDeploymentGroups', run: (c, p) => ({ applicationName: p.ApplicationName, deploymentGroups: cd.listDeploymentGroups(c, { ApplicationName: p.ApplicationName }) }) });
defineCommand({ service: S, name: 'delete-deployment-group', op: 'DeleteDeploymentGroup', run: (c, p) => (cd.deleteDeploymentGroup(c, { ApplicationName: p.ApplicationName, DeploymentGroupName: p.DeploymentGroupName }), { hooksNotCleanedUp: [] }) });
defineCommand({ service: S, name: 'get-deployment-config', op: 'GetDeploymentConfig', run: (c, p) => { const r = cd.getDeploymentConfig(c, { DeploymentConfigName: p.DeploymentConfigName }); return { deploymentConfigInfo: { deploymentConfigName: r.name, minimumHealthyHosts: { type: r.type, value: r.value }, computePlatform: 'Server' } }; } });
defineCommand({ service: S, name: 'list-deployment-configs', op: 'ListDeploymentConfigs', run: (c) => ({ deploymentConfigsList: cd.listDeploymentConfigs(c) }) });
defineCommand({
  service: S, name: 'create-deployment', op: 'CreateDeployment', structured: ['revision', 's3-location'],
  run: (c, p) => ({ deploymentId: cd.createDeployment(c, { ApplicationName: p.ApplicationName, DeploymentGroupName: p.DeploymentGroupName, Revision: p.Revision ?? (p.S3Location ? { revisionType: 'S3', s3Location: p.S3Location } : undefined), DeploymentConfigName: p.DeploymentConfigName, Description: p.Description }).id }),
});
defineCommand({ service: S, name: 'get-deployment', op: 'GetDeployment', run: (c, p) => ({ deploymentInfo: deploymentView(cd.getDeployment(c, { DeploymentId: p.DeploymentId })) }) });
defineCommand({ service: S, name: 'list-deployments', op: 'ListDeployments', list: ['include-only-statuses'], run: (c, p) => ({ deployments: cd.listDeployments(c, { ApplicationName: p.ApplicationName, DeploymentGroupName: p.DeploymentGroupName, IncludeOnlyStatuses: p.IncludeOnlyStatuses }) }) });
defineCommand({ service: S, name: 'stop-deployment', op: 'StopDeployment', run: (c, p) => { cd.stopDeployment(c, { DeploymentId: p.DeploymentId }); return { status: 'Succeeded', statusMessage: 'No more commands will be scheduled for execution in the deployment instances' }; } });
defineCommand({ service: S, name: 'list-deployment-instances', op: 'ListDeploymentInstances', run: (c, p) => ({ instancesList: cd.listTargets(c, { DeploymentId: p.DeploymentId }) }) });
defineCommand({ service: S, name: 'list-deployment-targets', op: 'ListDeploymentTargets', run: (c, p) => ({ targetIds: cd.listTargets(c, { DeploymentId: p.DeploymentId }) }) });
defineCommand({ service: S, name: 'get-deployment-instance', op: 'GetDeploymentInstance', run: (c, p) => ({ instanceSummary: targetView(p.DeploymentId, cd.getTarget(c, { DeploymentId: p.DeploymentId, InstanceId: p.InstanceId })) }) });
defineCommand({
  service: S, name: 'wait', op: 'Wait',
  run: async (c, p, _sh, pos) => {
    const w = pos[0];
    if (w !== 'deployment-successful') throw new Error(`aws: error: argument waiter_name: Invalid choice, valid choices are:\n\n* deployment-successful`);
    for (let i = 0; i < 400; i++) {
      const d = cd.getDeployment(c, { DeploymentId: p.DeploymentId });
      if (d.status === 'Succeeded') return undefined;
      if (d.status === 'Failed' || d.status === 'Stopped') throw new Error(`\nWaiter DeploymentSuccessful failed: Waiter encountered a terminal failure state: For expression "deploymentInfo.status" we matched expected path: "${d.status}" at least once`);
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Max attempts exceeded');
  },
});
// aws deploy push: empaqueta un directorio como revisión y la sube a S3 (el zip simulado conserva los ficheros).
defineCommand({
  service: S, name: 'push', op: 'PushRevision', raw: true, bool: ['ignore-hidden-files'],
  run: (c, p, sh) => {
    const loc = /^s3:\/\/([^/]+)\/(.+)$/.exec(String(p.S3Location ?? ''));
    if (!p.ApplicationName || !loc) throw new Error('aws: error: the following arguments are required: --application-name, --s3-location');
    cd.getApp(c, p.ApplicationName);
    const src = VFS.norm(p.Source ?? '.', sh.cwd);
    if (!sh.fs.isDir(src)) throw new Error(`The directory ${p.Source} does not exist.`);
    const files: Record<string, string> = {};
    const walk = (dir: string, rel: string) => {
      for (const n of sh.fs.list(dir)) {
        if (p.IgnoreHiddenFiles !== undefined && n.startsWith('.')) continue;
        const a = `${dir}/${n}`, r = rel ? `${rel}/${n}` : n;
        if (sh.fs.isDir(a)) walk(a, r); else files[r] = sh.fs.readFile(a);
      }
    };
    walk(src, '');
    if (!files['appspec.yml'] && !files['appspec.yaml']) throw new Error(`appspec.yml was not found in the directory ${p.Source ?? '.'}. Create an AppSpec file or use --source to point at the right directory.`);
    if (!putBucketObject(c.s, loc[1], loc[2], packBundle(files))) throw new AwsError('NoSuchBucket', 'The specified bucket does not exist', 404);
    const etag = hex(32);
    return `To deploy with this revision, run:\naws deploy create-deployment --application-name ${p.ApplicationName} --s3-location bucket=${loc[1]},key=${loc[2]},bundleType=zip,eTag=${etag},version=null --deployment-group-name <deployment-group-name> --deployment-config-name <deployment-config-name> --description <description>\n`;
  },
});
void bool;

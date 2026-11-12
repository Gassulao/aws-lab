// aws configservice (AWS Config)
import { defineCommand } from '../framework';
import * as cfg from '../../../engine/services/config';
import { gov } from '../../../engine/services/govTypes';
import type { ConfigRule, ConfigRecorder } from '../../../engine/services/govTypes';
import type { Ctx } from '../../../engine/api';

const isoMicro = (s: string) => s.replace(/\.(\d{3})Z$/, '.$1000+00:00').replace(/Z$/, '+00:00');
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const bool = (v: unknown) => (typeof v === 'string' ? v === 'true' : v === undefined ? undefined : !!v);
const count = (n: number) => ({ CappedCount: n, CapExceeded: false });
const ruleName = (p: Record<string, any>) => String(p.ConfigRuleName);

const ruleView = (r: ConfigRule) => strip({
  ConfigRuleName: r.name, ConfigRuleArn: r.arn, ConfigRuleId: r.id, Description: r.description,
  Scope: r.scopeTypes?.length ? { ComplianceResourceTypes: r.scopeTypes } : undefined,
  Source: { Owner: 'AWS', SourceIdentifier: r.identifier }, InputParameters: Object.keys(r.inputParameters).length ? JSON.stringify(r.inputParameters) : undefined, ConfigRuleState: 'ACTIVE',
});
const recView = (r: ConfigRecorder) => ({ name: r.name, roleARN: r.roleArn, recordingGroup: { allSupported: r.allSupported, includeGlobalResourceTypes: r.includeGlobal, resourceTypes: r.resourceTypes } });
const evalView = (c: Ctx, x: { rule: ConfigRule; e: cfg.Evaluation; type: cfg.Compliance }) => strip({
  EvaluationResultIdentifier: { EvaluationResultQualifier: { ConfigRuleName: x.rule.name, ResourceType: x.e.type, ResourceId: x.e.id }, OrderingTimestamp: isoMicro(x.rule.lastEvaluatedAt ?? x.rule.createdAt) },
  ComplianceType: x.type, ResultRecordedTime: isoMicro(x.rule.lastEvaluatedAt ?? x.rule.createdAt), ConfigRuleInvokedTime: isoMicro(x.rule.lastEvaluatedAt ?? x.rule.createdAt), Annotation: x.e.annotation,
});
void evalView;

defineCommand({
  service: 'configservice', name: 'put-configuration-recorder', op: 'PutConfigurationRecorder', structured: ['configuration-recorder', 'recording-group'],
  run: (c, p) => {
    const r = p.ConfigurationRecorder ?? {};
    const rg = p.RecordingGroup ?? r.recordingGroup;
    cfg.putConfigurationRecorder(c, { name: r.name, roleARN: r.roleARN, recordingGroup: rg ? { allSupported: bool(rg.allSupported), includeGlobalResourceTypes: bool(rg.includeGlobalResourceTypes), resourceTypes: rg.resourceTypes === undefined ? undefined : ([] as string[]).concat(rg.resourceTypes) } : undefined });
  },
});
defineCommand({ service: 'configservice', name: 'describe-configuration-recorders', op: 'DescribeConfigurationRecorders', list: ['configuration-recorder-names'], run: (c) => ({ ConfigurationRecorders: cfg.describeConfigurationRecorders(c).map(recView) }) });
defineCommand({
  service: 'configservice', name: 'describe-configuration-recorder-status', op: 'DescribeConfigurationRecorderStatus', list: ['configuration-recorder-names'],
  run: (c) => ({
    ConfigurationRecordersStatus: cfg.describeConfigurationRecorders(c).map((r) => strip({
      name: r.name, lastStartTime: r.lastStartAt ? isoMicro(r.lastStartAt) : undefined, lastStopTime: r.lastStopAt ? isoMicro(r.lastStopAt) : undefined, recording: r.recording,
      lastStatus: r.recording ? 'SUCCESS' : undefined, lastStatusChangeTime: isoMicro(r.lastStopAt && !r.recording ? r.lastStopAt : r.lastStartAt ?? new Date().toISOString()),
    })),
  }),
});
defineCommand({ service: 'configservice', name: 'start-configuration-recorder', op: 'StartConfigurationRecorder', run: (c, p) => void cfg.startConfigurationRecorder(c, { ConfigurationRecorderName: p.ConfigurationRecorderName }, true) });
defineCommand({ service: 'configservice', name: 'stop-configuration-recorder', op: 'StopConfigurationRecorder', run: (c, p) => void cfg.startConfigurationRecorder(c, { ConfigurationRecorderName: p.ConfigurationRecorderName }, false) });
defineCommand({ service: 'configservice', name: 'delete-configuration-recorder', op: 'DeleteConfigurationRecorder', run: (c, p) => void cfg.deleteConfigurationRecorder(c, { ConfigurationRecorderName: p.ConfigurationRecorderName }) });
defineCommand({
  service: 'configservice', name: 'put-delivery-channel', op: 'PutDeliveryChannel', structured: ['delivery-channel'],
  run: (c, p) => { const d = p.DeliveryChannel ?? {}; cfg.putDeliveryChannel(c, { name: d.name, s3BucketName: d.s3BucketName, s3KeyPrefix: d.s3KeyPrefix, snsTopicARN: d.snsTopicARN }); },
});
defineCommand({ service: 'configservice', name: 'describe-delivery-channels', op: 'DescribeDeliveryChannels', list: ['delivery-channel-names'], run: (c) => ({ DeliveryChannels: cfg.describeDeliveryChannels(c).map((d) => strip({ name: d.name, s3BucketName: d.s3Bucket, s3KeyPrefix: d.s3Prefix, snsTopicARN: d.snsTopicArn })) }) });
defineCommand({
  service: 'configservice', name: 'describe-delivery-channel-status', op: 'DescribeDeliveryChannelStatus', list: ['delivery-channel-names'],
  run: (c) => ({ DeliveryChannelsStatus: cfg.describeDeliveryChannels(c).map((d) => ({ name: d.name, configSnapshotDeliveryInfo: {}, configHistoryDeliveryInfo: { lastStatus: 'SUCCESS' }, configStreamDeliveryInfo: { lastStatus: 'SUCCESS' } })) }),
});
defineCommand({ service: 'configservice', name: 'delete-delivery-channel', op: 'DeleteDeliveryChannel', run: (c, p) => void cfg.deleteDeliveryChannel(c, { DeliveryChannelName: p.DeliveryChannelName }) });

defineCommand({ service: 'configservice', name: 'put-config-rule', op: 'PutConfigRule', structured: ['config-rule', 'tags'], list: ['tags'], run: (c, p) => void cfg.putConfigRule(c, { ConfigRule: p.ConfigRule }) });
defineCommand({ service: 'configservice', name: 'describe-config-rules', op: 'DescribeConfigRules', list: ['config-rule-names'], run: (c, p) => ({ ConfigRules: cfg.describeConfigRules(c, { ConfigRuleNames: p.ConfigRuleNames }).map(ruleView) }) });
defineCommand({ service: 'configservice', name: 'delete-config-rule', op: 'DeleteConfigRule', run: (c, p) => void cfg.deleteConfigRule(c, { ConfigRuleName: ruleName(p) }) });
defineCommand({ service: 'configservice', name: 'start-config-rules-evaluation', op: 'StartConfigRulesEvaluation', list: ['config-rule-names'], run: (c, p) => ((cfg.startConfigRulesEvaluation(c, { ConfigRuleNames: p.ConfigRuleNames }), {})) });
defineCommand({
  service: 'configservice', name: 'describe-config-rule-evaluation-status', op: 'DescribeConfigRuleEvaluationStatus', list: ['config-rule-names'],
  run: (c, p) => ({
    ConfigRulesEvaluationStatus: cfg.describeRuleEvaluationStatus(c, { ConfigRuleNames: p.ConfigRuleNames }).map((r) => {
      const rec = gov(c.s).config.recorder;
      return strip({ ConfigRuleName: r.name, ConfigRuleArn: r.arn, ConfigRuleId: r.id, LastSuccessfulInvocationTime: isoMicro(r.lastEvaluatedAt ?? r.createdAt), LastSuccessfulEvaluationTime: rec?.recording ? isoMicro(r.lastEvaluatedAt ?? r.createdAt) : undefined, FirstActivatedTime: isoMicro(r.createdAt), FirstEvaluationStarted: rec?.recording });
    }),
  }),
});
defineCommand({
  service: 'configservice', name: 'describe-compliance-by-config-rule', op: 'DescribeComplianceByConfigRule', list: ['config-rule-names', 'compliance-types'],
  run: (c, p) => ({ ComplianceByConfigRules: cfg.describeComplianceByConfigRule(c, { ConfigRuleNames: p.ConfigRuleNames, ComplianceTypes: p.ComplianceTypes }).map((x) => ({ ConfigRuleName: x.rule.name, Compliance: { ComplianceType: x.type, ...(x.type === 'NON_COMPLIANT' ? { ComplianceContributorCount: count(x.noncompliant) } : {}) } })) }),
});
defineCommand({
  service: 'configservice', name: 'get-compliance-details-by-config-rule', op: 'GetComplianceDetailsByConfigRule', list: ['compliance-types'],
  run: (c, p) => ({ EvaluationResults: cfg.getComplianceDetailsByConfigRule(c, { ConfigRuleName: ruleName(p), ComplianceTypes: p.ComplianceTypes }).map((x) => evalView(c, x)) }),
});
defineCommand({
  service: 'configservice', name: 'get-compliance-summary-by-config-rule', op: 'GetComplianceSummaryByConfigRule',
  run: (c) => { const x = cfg.complianceSummary(c); return { ComplianceSummary: { CompliantResourceCount: count(x.compliant), NonCompliantResourceCount: count(x.nonCompliant), ComplianceSummaryTimestamp: isoMicro(new Date().toISOString()) } }; },
});
defineCommand({
  service: 'configservice', name: 'describe-compliance-by-resource', op: 'DescribeComplianceByResource', list: ['compliance-types'],
  run: (c, p) => ({ ComplianceByResources: cfg.complianceByResource(c, { ResourceType: p.ResourceType, ResourceId: p.ResourceId, ComplianceTypes: p.ComplianceTypes }).map((x) => ({ ResourceType: x.type, ResourceId: x.id, Compliance: { ComplianceType: x.compliance } })) }),
});
defineCommand({
  service: 'configservice', name: 'get-compliance-details-by-resource', op: 'GetComplianceDetailsByResource', list: ['compliance-types'],
  run: (c, p) => ({ EvaluationResults: cfg.getComplianceDetailsByResource(c, { ResourceType: p.ResourceType, ResourceId: p.ResourceId, ComplianceTypes: p.ComplianceTypes }).map((x) => evalView(c, x)) }),
});
defineCommand({
  service: 'configservice', name: 'list-discovered-resources', op: 'ListDiscoveredResources',
  run: (c, p) => ({ resourceIdentifiers: cfg.listDiscoveredResources(c, { resourceType: p.ResourceType }).map((r) => strip({ resourceType: r.type, resourceId: r.id, resourceName: r.name })) }),
});

// aws support (Trusted Advisor) y aws health
import { defineCommand } from '../framework';
import * as ta from '../../../engine/services/trustedadvisor';
import type { TaResult } from '../../../engine/services/govTypes';

const isoZ = (s: string) => s.replace(/\.\d+Z$/, 'Z');
const isoOff = (s: string) => s.replace(/\.(\d{3})Z$/, '.$1000+00:00');
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const summary = (r: TaResult, withFlagged: boolean) => {
  const cat = (ta.CHECKS.find((x) => x.id === r.checkId)?.category) ?? 'security';
  const out: Record<string, unknown> = {
    checkId: r.checkId, timestamp: isoZ(r.timestamp), status: r.status,
    resourcesSummary: { resourcesProcessed: r.processed, resourcesFlagged: r.flagged, resourcesIgnored: 0, resourcesSuppressed: 0 },
    categorySpecificSummary: cat === 'cost_optimizing' ? { costOptimizing: { estimatedMonthlySavings: Math.round((r.savings ?? 0) * 100) / 100, estimatedPercentMonthlySavings: 0.0 } } : {},
  };
  if (withFlagged) out.flaggedResources = r.flaggedResources.map((f) => ({ status: f.status, region: f.region, resourceId: f.resourceId, isSuppressed: false, metadata: f.metadata }));
  else out.hasFlaggedResources = r.flagged > 0;
  return out;
};

defineCommand({
  service: 'support', name: 'describe-trusted-advisor-checks', op: 'DescribeTrustedAdvisorChecks',
  run: (c, p) => ({ checks: ta.describeChecks(c, { language: p.Language }).map((x) => ({ id: x.id, name: x.name, description: x.description, category: x.category, metadata: x.metadata })) }),
});
defineCommand({ service: 'support', name: 'describe-trusted-advisor-check-result', op: 'DescribeTrustedAdvisorCheckResult', run: (c, p) => ({ result: summary(ta.describeCheckResult(c, { checkId: p.CheckId }), true) }) });
defineCommand({ service: 'support', name: 'describe-trusted-advisor-check-summaries', op: 'DescribeTrustedAdvisorCheckSummaries', list: ['check-ids'], run: (c, p) => ({ summaries: ta.describeCheckSummaries(c, { checkIds: p.CheckIds }).map((r) => summary(r, false)) }) });
defineCommand({
  service: 'support', name: 'refresh-trusted-advisor-check', op: 'RefreshTrustedAdvisorCheck',
  run: (c, p) => { ta.refreshTrustedAdvisorCheck(c, { checkId: p.CheckId }); return { status: { checkId: p.CheckId, status: 'enqueued', millisUntilNextRefreshable: 3_540_000 } }; },
});
defineCommand({
  service: 'support', name: 'describe-trusted-advisor-check-refresh-statuses', op: 'DescribeTrustedAdvisorCheckRefreshStatuses', list: ['check-ids'],
  run: (c, p) => ({ statuses: ([] as string[]).concat(p.CheckIds ?? []).map((id) => ({ checkId: id, status: 'success', millisUntilNextRefreshable: 0 })) }),
});

const evView = (e: ta.HealthEvent) => ({ arn: e.arn, service: e.service, eventTypeCode: e.eventTypeCode, eventTypeCategory: e.eventTypeCategory, region: e.region, startTime: isoOff(e.startTime), lastUpdatedTime: isoOff(e.lastUpdatedTime), statusCode: 'open', eventScopeCode: 'ACCOUNT_SPECIFIC' });
defineCommand({ service: 'health', name: 'describe-events', op: 'DescribeEvents', structured: ['filter'], run: (c) => ({ events: ta.describeEvents(c).map(evView) }) });
defineCommand({
  service: 'health', name: 'describe-event-details', op: 'DescribeEventDetails', list: ['event-arns'],
  run: (c, p) => { const r = ta.describeEventDetails(c, { eventArns: p.EventArns }); return { successfulSet: r.ok.map((e) => ({ event: evView(e), eventDescription: { latestDescription: e.description } })), failedSet: r.failed.map((a) => ({ eventArn: a, errorName: 'EventNotFound', errorMessage: 'Event not found.' })) }; },
});
defineCommand({
  service: 'health', name: 'describe-affected-entities', op: 'DescribeAffectedEntities', structured: ['filter'],
  run: (c, p) => {
    const f = p.Filter ?? {};
    const r = ta.describeAffectedEntities(c, { filter: { eventArns: ([] as string[]).concat(f.eventArns ?? []) } });
    return { entities: r.map((x) => strip({ entityArn: `arn:aws:health:${x.event.region}:${c.s.account.id}:entity/${x.value}`, eventArn: x.event.arn, entityValue: x.value, awsAccountId: c.s.account.id, lastUpdatedTime: isoOff(x.event.lastUpdatedTime), statusCode: x.status })) };
  },
});

// aws dynamodb
import { defineCommand, type Params } from '../framework';
import * as D from '../../../engine/serverless/dynamodb';
import type { DdbTable } from '../../../engine/serverless/types';
import { need, num, arr, strip, secIso, waitFor } from './sv-util';
import { settleSv } from '../../../engine/serverless';

const S = 'dynamodb';
const STR = ['key-schema', 'attribute-definitions', 'provisioned-throughput', 'global-secondary-indexes', 'tags', 'item', 'key', 'expression-attribute-names', 'expression-attribute-values', 'exclusive-start-key', 'request-items'];
const tableOut = (t: DdbTable, status = D.tableStatus(t)) => strip({
  AttributeDefinitions: t.attrDefs, TableName: t.name, KeySchema: t.keySchema, TableStatus: status, CreationDateTime: secIso(t.createdAt).replace('+00:00', '.000000+00:00'),
  ProvisionedThroughput: { NumberOfDecreasesToday: 0, ReadCapacityUnits: t.rcu, WriteCapacityUnits: t.wcu },
  TableSizeBytes: JSON.stringify(t.items).length, ItemCount: t.items.length, TableArn: t.arn, TableId: t.tableId,
  BillingModeSummary: t.billingMode === 'PAY_PER_REQUEST' ? { BillingMode: 'PAY_PER_REQUEST', LastUpdateToPayPerRequestDateTime: secIso(t.createdAt).replace('+00:00', '.000000+00:00') } : undefined,
  GlobalSecondaryIndexes: t.gsis.length ? t.gsis.map((g) => ({ IndexName: g.IndexName, KeySchema: g.KeySchema, Projection: g.Projection, IndexStatus: status, ProvisionedThroughput: { NumberOfDecreasesToday: 0, ReadCapacityUnits: t.billingMode === 'PROVISIONED' ? t.rcu : 0, WriteCapacityUnits: t.billingMode === 'PROVISIONED' ? t.wcu : 0 }, IndexSizeBytes: 0, ItemCount: 0, IndexArn: `${t.arn}/index/${g.IndexName}` })) : undefined,
});
/** Los valores de las opciones de tipo lista pueden llegar como una lista JSON o como varias estructuras abreviadas. */
const list = (v: any) => arr(v);
const one = (v: any) => (Array.isArray(v) && v.length === 1 && v[0] && typeof v[0] === 'object' ? v[0] : v);
const common = (p: Params) => ({
  ExpressionAttributeNames: p.ExpressionAttributeNames, ExpressionAttributeValues: p.ExpressionAttributeValues, ConditionExpression: p.ConditionExpression, ReturnValues: p.ReturnValues,
});

defineCommand({
  service: S, name: 'create-table', op: 'CreateTable', list: ['key-schema', 'attribute-definitions', 'global-secondary-indexes', 'tags'], structured: STR,
  run: (c, p) => ({ TableDescription: tableOut(D.createTable(c, {
    TableName: need(p, 'TableName', 'table-name'), KeySchema: list(need(p, 'KeySchema', 'key-schema')), AttributeDefinitions: list(need(p, 'AttributeDefinitions', 'attribute-definitions')), BillingMode: p.BillingMode,
    ProvisionedThroughput: p.ProvisionedThroughput ? { ReadCapacityUnits: Number(p.ProvisionedThroughput.ReadCapacityUnits), WriteCapacityUnits: Number(p.ProvisionedThroughput.WriteCapacityUnits) } : undefined,
    GlobalSecondaryIndexes: p.GlobalSecondaryIndexes ? list(p.GlobalSecondaryIndexes) : undefined, Tags: p.Tags ? list(p.Tags) : undefined,
  }), 'CREATING') }),
});
defineCommand({ service: S, name: 'describe-table', op: 'DescribeTable', run: (c, p) => ({ Table: tableOut(D.describeTable(c, { TableName: need(p, 'TableName', 'table-name') })) }) });
defineCommand({ service: S, name: 'list-tables', op: 'ListTables', run: (c) => ({ TableNames: D.listTables(c).map((t) => t.name) }) });
defineCommand({ service: S, name: 'delete-table', op: 'DeleteTable', run: (c, p) => ({ TableDescription: { ...tableOut(D.deleteTable(c, { TableName: need(p, 'TableName', 'table-name') }), 'ACTIVE' as any), TableStatus: 'DELETING' } }) });
defineCommand({
  service: S, name: 'put-item', op: 'PutItem', structured: STR,
  run: (c, p) => { const r: any = D.putItem(c, { TableName: need(p, 'TableName', 'table-name'), Item: need(p, 'Item', 'item'), ...common(p) }); return Object.keys(r).length ? r : undefined; },
});
defineCommand({
  service: S, name: 'get-item', op: 'GetItem', structured: STR, list: ['attributes-to-get'],
  run: (c, p) => { const r: any = D.getItem(c, { TableName: need(p, 'TableName', 'table-name'), Key: need(p, 'Key', 'key'), ProjectionExpression: p.ProjectionExpression, ExpressionAttributeNames: p.ExpressionAttributeNames, AttributesToGet: p.AttributesToGet }); return Object.keys(r).length ? r : undefined; },
});
defineCommand({
  service: S, name: 'delete-item', op: 'DeleteItem', structured: STR,
  run: (c, p) => { const r: any = D.deleteItem(c, { TableName: need(p, 'TableName', 'table-name'), Key: need(p, 'Key', 'key'), ...common(p) }); return Object.keys(r).length ? r : undefined; },
});
defineCommand({
  service: S, name: 'update-item', op: 'UpdateItem', structured: STR,
  run: (c, p) => { const r: any = D.updateItem(c, { TableName: need(p, 'TableName', 'table-name'), Key: need(p, 'Key', 'key'), UpdateExpression: p.UpdateExpression, ...common(p) }); return Object.keys(r).length ? r : undefined; },
});
const qp = (p: Params) => ({
  TableName: need(p, 'TableName', 'table-name') as string, IndexName: p.IndexName, KeyConditionExpression: p.KeyConditionExpression, FilterExpression: p.FilterExpression, ProjectionExpression: p.ProjectionExpression,
  ExpressionAttributeNames: p.ExpressionAttributeNames, ExpressionAttributeValues: p.ExpressionAttributeValues, Limit: num(p.Limit ?? p.MaxItems), ScanIndexForward: p.ScanIndexForward, Select: p.Select, ExclusiveStartKey: p.ExclusiveStartKey,
});
const qOut = (r: any) => ({ ...r, ConsumedCapacity: null });
defineCommand({ service: S, name: 'query', op: 'Query', structured: STR, bool: ['scan-index-forward'], run: (c, p) => qOut(D.query(c, qp(p))) });
defineCommand({ service: S, name: 'scan', op: 'Scan', structured: STR, run: (c, p) => qOut(D.scan(c, qp(p))) });
defineCommand({
  service: S, name: 'batch-write-item', op: 'BatchWriteItem', structured: STR,
  run: (c, p) => D.batchWriteItem(c, { RequestItems: need(p, 'RequestItems', 'request-items') }),
});
defineCommand({ service: S, name: 'tag-resource', op: 'TagResource', list: ['tags'], structured: STR, run: (c, p) => void D.tagResource(c, { ResourceArn: need(p, 'ResourceArn', 'resource-arn'), Tags: list(need(p, 'Tags', 'tags')) }) });
defineCommand({ service: S, name: 'list-tags-of-resource', op: 'ListTagsOfResource', run: (c, p) => ({ Tags: Object.entries(D.listTags(c, { ResourceArn: need(p, 'ResourceArn', 'resource-arn') })).map(([Key, Value]) => ({ Key, Value })) }) });
defineCommand({
  service: S, name: 'wait', op: 'Wait',
  run: async (c, p, _sh, pos) => {
    const name = need(p, 'TableName', 'table-name') as string;
    const find = () => c.s.sv?.tables.find((t) => t.name === name && t.region === c.region);
    if (pos[0] === 'table-exists') await waitFor(c, 'TableExists', () => { const t = find(); return !!t && D.tableStatus(t) === 'ACTIVE'; });
    else if (pos[0] === 'table-not-exists') await waitFor(c, 'TableNotExists', () => !find());
    else throw new Error(`\nusage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\naws: error: argument operation: Invalid choice, valid choices are:\n\ntable-exists | table-not-exists`);
    return undefined;
  },
});
void one; void settleSv;

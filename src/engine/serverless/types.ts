// Estado de los servicios sin servidor y de datos: Lambda, API Gateway, SQS, RDS y DynamoDB.
// Todo vive en `s.sv` (se crea de forma perezosa con sv(s)) para no tocar el resto del estado.
import type { CloudState, Tags } from '../types';

// ------------------------------------------------------------------ Lambda
export interface LambdaVersionSnap {
  version: string; description: string; codeSha256: string; codeSize: number; lastModified: string;
  handler: string; runtime: string; role: string; timeout: number; memory: number; env: Record<string, string>; files: Record<string, string>;
}
export interface LambdaAlias { hits?: number; name: string; arn: string; version: string; description: string; routing?: Record<string, number>; revisionId: string }
export interface LambdaPermission { sid: string; action: string; principal: string; sourceArn?: string; sourceAccount?: string; qualifier?: string; urlAuthType?: string }
export interface LambdaFn {
  name: string; arn: string; region: string; runtime: string; handler: string; role: string; description: string; timeout: number; memory: number;
  env: Record<string, string>; files: Record<string, string>; codeSha256: string; codeSize: number; lastModified: string; createdAt: number;
  versions: LambdaVersionSnap[]; nextVersion: number; aliases: LambdaAlias[]; permissions: LambdaPermission[]; tags: Tags; reservedConcurrency?: number;
  deadLetterArn?: string; url?: { id: string; url: string; authType: 'NONE' | 'AWS_IAM'; createdAt: string }; revisionId: string;
  stats: { invocations: number; errors: number; throttles: number; lastInvoked?: number; stream?: string; streamKey?: string };
}
export interface EventSourceMapping {
  uuid: string; functionArn: string; functionName: string; region: string; eventSourceArn: string; batchSize: number; enabled: boolean; lastModified: number;
  maxBatchingWindow: number; functionResponseTypes: string[]; lastProcessingResult: string;
}

// ------------------------------------------------------------------ SQS
export interface SqsMessage {
  id: string; body: string; md5: string; attrs: Record<string, { DataType: string; StringValue?: string }>; sentAt: number; availableAt: number; visibleAt: number;
  receiveCount: number; firstReceivedAt?: number; receipt?: string; groupId?: string; dedupId?: string; seq?: string;
}
export interface SqsQueue {
  name: string; url: string; arn: string; region: string; fifo: boolean; createdAt: number; modifiedAt: number; attrs: Record<string, string>;
  messages: SqsMessage[]; tags: Tags; dedup: Record<string, number>; seq: number;
}

// ------------------------------------------------------------------ API Gateway
export interface RestMethod {
  httpMethod: string; authorizationType: string; apiKeyRequired: boolean;
  integration?: { type: string; httpMethod?: string; uri?: string; passthroughBehavior?: string; requestTemplates?: Record<string, string>; responses: Record<string, { selectionPattern?: string; responseTemplates?: Record<string, string> }> };
  responses: Record<string, { responseModels?: Record<string, string> }>;
}
export interface RestResource { id: string; parentId?: string; pathPart?: string; path: string; methods: Record<string, RestMethod> }
export interface RestDeployment { id: string; description: string; createdDate: string; snapshot: RestResource[] }
export interface RestStage { stageName: string; deploymentId: string; description: string; variables: Record<string, string>; createdDate: string; lastUpdatedDate: string }
export interface RestApi { id: string; name: string; description: string; createdDate: string; region: string; endpointTypes: string[]; resources: RestResource[]; deployments: RestDeployment[]; stages: RestStage[]; tags: Tags }
export interface HttpIntegration { id: string; type: string; uri: string; payloadFormatVersion: string; method: string }
export interface HttpRoute { id: string; routeKey: string; target?: string; authorizationType: string }
export interface HttpStage { stageName: string; autoDeploy: boolean; deploymentId?: string; createdDate: string; variables: Record<string, string> }
export interface HttpApi { id: string; name: string; protocolType: string; createdDate: string; region: string; routes: HttpRoute[]; integrations: HttpIntegration[]; stages: HttpStage[]; deployments: { id: string; createdDate: string }[]; cors?: any; tags: Tags }

// ------------------------------------------------------------------ RDS
export interface RdsSubnetGroup { name: string; arn: string; description: string; vpcId: string; subnetIds: string[]; region: string }
export interface RdsInstance {
  id: string; arn: string; region: string; engine: string; engineVersion: string; cls: string; allocatedStorage: number; storageType: string; masterUser: string; dbName?: string;
  port: number; createdAt: number; readyAt: number; multiAz: boolean; publiclyAccessible: boolean; subnetGroup: string; vpcId: string; sgIds: string[]; az: string; secondaryAz?: string;
  encrypted: boolean; kmsKeyId?: string; backupRetention: number; deletionProtection: boolean; endpoint: string; dbiResourceId: string; tags: Tags;
  /** Transición en curso: estado temporal hasta `until`. */
  transient?: { status: string; until: number; apply?: Partial<RdsInstance>; after?: string };
  stopped?: boolean; readReplicaOf?: string; pendingValues?: Partial<RdsInstance>; parameterGroup: string;
}
export interface RdsSnapshot {
  id: string; arn: string; instanceId: string; region: string; engine: string; engineVersion: string; allocatedStorage: number; storageType: string; masterUser: string; port: number;
  createdAt: number; readyAt: number; type: 'manual' | 'automated'; encrypted: boolean; kmsKeyId?: string; az: string; vpcId: string; dbName?: string; tags: Tags; instanceCreatedAt: number; cls: string; multiAz: boolean;
}
export interface RdsEvent { ts: number; sourceId: string; sourceType: string; message: string; region: string }

// ------------------------------------------------------------------ DynamoDB
export type AttrValue = Record<string, any>;
export type Item = Record<string, AttrValue>;
export interface DdbTable {
  name: string; arn: string; region: string; keySchema: { AttributeName: string; KeyType: 'HASH' | 'RANGE' }[]; attrDefs: { AttributeName: string; AttributeType: string }[];
  billingMode: 'PROVISIONED' | 'PAY_PER_REQUEST'; rcu: number; wcu: number; createdAt: number; readyAt: number; items: Item[]; tags: Tags; gsis: { IndexName: string; KeySchema: { AttributeName: string; KeyType: string }[]; Projection: any }[]; tableId: string;
  ttl?: { attr: string; enabled: boolean };
}

export interface SvState {
  lambdas: LambdaFn[]; mappings: EventSourceMapping[];
  queues: SqsQueue[];
  restApis: RestApi[]; httpApis: HttpApi[];
  rdsInstances: RdsInstance[]; rdsSubnetGroups: RdsSubnetGroup[]; rdsSnapshots: RdsSnapshot[]; rdsEvents: RdsEvent[];
  tables: DdbTable[];
  /** Registro de invocaciones recientes (para la consola): función → últimas ejecuciones. */
  invokes: { fn: string; region: string; ts: number; requestId: string; ok: boolean; durationMs: number; billedMs: number; memoryUsed: number; source: string }[];
}

declare module '../types' {
  interface CloudState { sv?: SvState }
}

export function sv(s: CloudState): SvState {
  if (!s.sv) s.sv = { lambdas: [], mappings: [], queues: [], restApis: [], httpApis: [], rdsInstances: [], rdsSubnetGroups: [], rdsSnapshots: [], rdsEvents: [], tables: [], invokes: [] };
  const v = s.sv;
  v.lambdas ??= []; v.mappings ??= []; v.queues ??= []; v.restApis ??= []; v.httpApis ??= []; v.rdsInstances ??= []; v.rdsSubnetGroups ??= []; v.rdsSnapshots ??= []; v.rdsEvents ??= []; v.tables ??= []; v.invokes ??= [];
  return v;
}

// aws apigateway (REST) y aws apigatewayv2 (HTTP)
import { defineCommand, type Params } from '../framework';
import * as G from '../../../engine/serverless/apigateway';
import type { RestApi, RestMethod, RestResource, RestStage, HttpApi } from '../../../engine/serverless/types';
import { need, bool, arr, strip, secIso } from './sv-util';

const S = 'apigateway';
const iso = (v: string) => secIso(v);
const api = (a: RestApi) => strip({ id: a.id, name: a.name, description: a.description || undefined, createdDate: iso(a.createdDate), apiKeySource: 'HEADER', endpointConfiguration: { types: a.endpointTypes, ipAddressType: 'ipv4' }, disableExecuteApiEndpoint: false, rootResourceId: undefined as any, tags: Object.keys(a.tags).length ? a.tags : undefined });
const apiFull = (a: RestApi) => ({ ...api(a), rootResourceId: a.resources.find((r) => !r.parentId)?.id });
const resOut = (r: RestResource) => strip({ id: r.id, parentId: r.parentId, pathPart: r.pathPart, path: r.path, resourceMethods: Object.keys(r.methods).length ? Object.fromEntries(Object.keys(r.methods).map((k) => [k, {}])) : undefined });
const methodOut = (m: RestMethod) => strip({
  httpMethod: m.httpMethod, authorizationType: m.authorizationType, apiKeyRequired: m.apiKeyRequired,
  methodResponses: Object.keys(m.responses).length ? Object.fromEntries(Object.entries(m.responses).map(([k, v]) => [k, strip({ statusCode: k, responseModels: v.responseModels })])) : undefined,
  methodIntegration: m.integration ? integOut(m.integration) : undefined,
});
const integOut = (i: NonNullable<RestMethod['integration']>) => strip({
  type: i.type, httpMethod: i.httpMethod, uri: i.uri, passthroughBehavior: i.passthroughBehavior, requestTemplates: i.requestTemplates, timeoutInMillis: 29000, cacheNamespace: 'x', cacheKeyParameters: [],
  integrationResponses: Object.keys(i.responses).length ? Object.fromEntries(Object.entries(i.responses).map(([k, v]) => [k, strip({ statusCode: k, selectionPattern: v.selectionPattern, responseTemplates: v.responseTemplates })])) : undefined,
});
const stageOut = (s: RestStage) => strip({ deploymentId: s.deploymentId, stageName: s.stageName, description: s.description || undefined, cacheClusterEnabled: false, cacheClusterStatus: 'NOT_AVAILABLE', methodSettings: {}, variables: Object.keys(s.variables).length ? s.variables : undefined, tracingEnabled: false, createdDate: iso(s.createdDate), lastUpdatedDate: iso(s.lastUpdatedDate) });
const R = (p: Params) => need(p, 'RestApiId', 'rest-api-id') as string;
const RES = (p: Params) => need(p, 'ResourceId', 'resource-id') as string;
const M = (p: Params) => need(p, 'HttpMethod', 'http-method') as string;

defineCommand({
  service: S, name: 'create-rest-api', op: 'CreateRestApi', structured: ['endpoint-configuration', 'tags'],
  run: (c, p) => apiFull(G.createRestApi(c, { name: need(p, 'Name', 'name'), description: p.Description, endpointConfiguration: p.EndpointConfiguration ? { types: arr(p.EndpointConfiguration.types ?? p.EndpointConfiguration.Types) } : undefined, tags: p.Tags })),
});
defineCommand({ service: S, name: 'get-rest-apis', op: 'GetRestApis', run: (c) => ({ items: G.getRestApis(c).map(apiFull) }) });
defineCommand({ service: S, name: 'get-rest-api', op: 'GetRestApi', run: (c, p) => apiFull(G.getRestApi(c, { restApiId: R(p) })) });
defineCommand({ service: S, name: 'delete-rest-api', op: 'DeleteRestApi', run: (c, p) => void G.deleteRestApi(c, { restApiId: R(p) }) });
defineCommand({ service: S, name: 'get-resources', op: 'GetResources', run: (c, p) => ({ items: G.getResources(c, { restApiId: R(p) }).map(resOut) }) });
defineCommand({ service: S, name: 'get-resource', op: 'GetResource', run: (c, p) => resOut(G.getResource(c, { restApiId: R(p), resourceId: RES(p) })) });
defineCommand({ service: S, name: 'create-resource', op: 'CreateResource', run: (c, p) => resOut(G.createResource(c, { restApiId: R(p), parentId: need(p, 'ParentId', 'parent-id'), pathPart: need(p, 'PathPart', 'path-part') })) });
defineCommand({ service: S, name: 'delete-resource', op: 'DeleteResource', run: (c, p) => void G.deleteResource(c, { restApiId: R(p), resourceId: RES(p) }) });
defineCommand({
  service: S, name: 'put-method', op: 'PutMethod', bool: ['api-key-required'],
  run: (c, p) => { const m = G.putMethod(c, { restApiId: R(p), resourceId: RES(p), httpMethod: M(p), authorizationType: need(p, 'AuthorizationType', 'authorization-type'), apiKeyRequired: bool(p.ApiKeyRequired) }); return { httpMethod: m.httpMethod, authorizationType: m.authorizationType, apiKeyRequired: m.apiKeyRequired }; },
});
defineCommand({ service: S, name: 'get-method', op: 'GetMethod', run: (c, p) => methodOut(G.getMethod(c, { restApiId: R(p), resourceId: RES(p), httpMethod: M(p) })) });
defineCommand({ service: S, name: 'delete-method', op: 'DeleteMethod', run: (c, p) => void G.deleteMethod(c, { restApiId: R(p), resourceId: RES(p), httpMethod: M(p) }) });
defineCommand({
  service: S, name: 'put-method-response', op: 'PutMethodResponse', structured: ['response-models'],
  run: (c, p) => { const sc = String(need(p, 'StatusCode', 'status-code')); G.putMethodResponse(c, { restApiId: R(p), resourceId: RES(p), httpMethod: M(p), statusCode: sc, responseModels: p.ResponseModels }); return strip({ statusCode: sc, responseModels: p.ResponseModels }); },
});
defineCommand({
  service: S, name: 'put-integration', op: 'PutIntegration', structured: ['request-templates'],
  run: (c, p) => integOut(G.putIntegration(c, { restApiId: R(p), resourceId: RES(p), httpMethod: M(p), type: need(p, 'Type', 'type'), integrationHttpMethod: p.IntegrationHttpMethod, uri: p.Uri, passthroughBehavior: p.PassthroughBehavior, requestTemplates: p.RequestTemplates })),
});
defineCommand({ service: S, name: 'get-integration', op: 'GetIntegration', run: (c, p) => integOut(G.getIntegration(c, { restApiId: R(p), resourceId: RES(p), httpMethod: M(p) })) });
defineCommand({
  service: S, name: 'put-integration-response', op: 'PutIntegrationResponse', structured: ['response-templates'],
  run: (c, p) => { const sc = String(need(p, 'StatusCode', 'status-code')); G.putIntegrationResponse(c, { restApiId: R(p), resourceId: RES(p), httpMethod: M(p), statusCode: sc, selectionPattern: p.SelectionPattern, responseTemplates: p.ResponseTemplates }); return strip({ statusCode: sc, selectionPattern: p.SelectionPattern, responseTemplates: p.ResponseTemplates }); },
});
defineCommand({
  service: S, name: 'create-deployment', op: 'CreateDeployment', structured: ['variables'],
  run: (c, p) => { const d = G.createDeployment(c, { restApiId: R(p), stageName: p.StageName, description: p.Description, variables: p.Variables }); return strip({ id: d.id, createdDate: iso(d.createdDate), description: d.description || undefined }); },
});
defineCommand({ service: S, name: 'get-deployments', op: 'GetDeployments', run: (c, p) => ({ items: G.getDeployments(c, { restApiId: R(p) }).map((d) => strip({ id: d.id, createdDate: iso(d.createdDate), description: d.description || undefined })) }) });
defineCommand({
  service: S, name: 'create-stage', op: 'CreateStage', structured: ['variables'],
  run: (c, p) => stageOut(G.createStage(c, { restApiId: R(p), stageName: need(p, 'StageName', 'stage-name'), deploymentId: need(p, 'DeploymentId', 'deployment-id'), description: p.Description, variables: p.Variables })),
});
defineCommand({ service: S, name: 'get-stages', op: 'GetStages', run: (c, p) => ({ item: G.getStages(c, { restApiId: R(p) }).map(stageOut) }) });
defineCommand({ service: S, name: 'get-stage', op: 'GetStage', run: (c, p) => stageOut(G.getStage(c, { restApiId: R(p), stageName: need(p, 'StageName', 'stage-name') })) });
defineCommand({ service: S, name: 'delete-stage', op: 'DeleteStage', run: (c, p) => void G.deleteStage(c, { restApiId: R(p), stageName: need(p, 'StageName', 'stage-name') }) });
defineCommand({
  service: S, name: 'update-stage', op: 'UpdateStage', list: ['patch-operations'], structured: ['patch-operations'],
  run: (c, p) => stageOut(G.updateStage(c, { restApiId: R(p), stageName: need(p, 'StageName', 'stage-name'), patchOperations: arr(need(p, 'PatchOperations', 'patch-operations')) })),
});
defineCommand({
  service: S, name: 'test-invoke-method', op: 'TestInvokeMethod',
  run: (c, p) => {
    const { w, latency } = G.testInvoke(c, { restApiId: R(p), resourceId: RES(p), httpMethod: M(p), pathWithQueryString: p.PathWithQueryString, body: p.Body });
    const r: any = w;
    return { status: r.status, body: r.body, headers: r.headers, multiValueHeaders: Object.fromEntries(Object.entries<string>(r.headers ?? {}).map(([k, v]) => [k, [v]])), log: '', latency };
  },
});

// ---------------------------------------------------------------- v2
const V = 'apigatewayv2';
const hApi = (a: HttpApi) => strip({ ApiEndpoint: G.httpEndpoint(a), ApiId: a.id, ApiKeySelectionExpression: '$request.header.x-api-key', CorsConfiguration: a.cors, CreatedDate: iso(a.createdDate), DisableExecuteApiEndpoint: false, Name: a.name, ProtocolType: a.protocolType, RouteSelectionExpression: '$request.method $request.path', Tags: Object.keys(a.tags).length ? a.tags : undefined });
const hInt = (i: HttpApi['integrations'][number]) => strip({ ConnectionType: 'INTERNET', IntegrationId: i.id, IntegrationMethod: i.method, IntegrationType: i.type, IntegrationUri: i.uri, PayloadFormatVersion: i.payloadFormatVersion, TimeoutInMillis: 30000 });
const hRoute = (r: HttpApi['routes'][number]) => strip({ ApiKeyRequired: false, AuthorizationType: r.authorizationType, RouteId: r.id, RouteKey: r.routeKey, Target: r.target });
const hStage = (s: HttpApi['stages'][number]) => strip({ AutoDeploy: s.autoDeploy, CreatedDate: iso(s.createdDate), DefaultRouteSettings: { DetailedMetricsEnabled: false }, DeploymentId: s.deploymentId, LastUpdatedDate: iso(s.createdDate), RouteSettings: {}, StageName: s.stageName, StageVariables: Object.keys(s.variables).length ? s.variables : undefined, Tags: {} });
const A = (p: Params) => need(p, 'ApiId', 'api-id') as string;

defineCommand({
  service: V, name: 'create-api', op: 'CreateApi', structured: ['cors-configuration', 'tags'],
  run: (c, p) => hApi(G.createHttpApi(c, { Name: need(p, 'Name', 'name'), ProtocolType: need(p, 'ProtocolType', 'protocol-type'), Target: p.Target, RouteKey: p.RouteKey, CorsConfiguration: p.CorsConfiguration, Tags: p.Tags })),
});
defineCommand({ service: V, name: 'get-apis', op: 'GetApis', run: (c) => ({ Items: G.getHttpApis(c).map(hApi) }) });
defineCommand({ service: V, name: 'get-api', op: 'GetApi', run: (c, p) => hApi(G.getHttpApi(c, { ApiId: A(p) })) });
defineCommand({ service: V, name: 'delete-api', op: 'DeleteApi', run: (c, p) => void G.deleteHttpApi(c, { ApiId: A(p) }) });
defineCommand({
  service: V, name: 'create-integration', op: 'CreateIntegration',
  run: (c, p) => hInt(G.createIntegration(c, { ApiId: A(p), IntegrationType: need(p, 'IntegrationType', 'integration-type'), IntegrationUri: p.IntegrationUri, PayloadFormatVersion: p.PayloadFormatVersion, IntegrationMethod: p.IntegrationMethod })),
});
defineCommand({ service: V, name: 'get-integrations', op: 'GetIntegrations', run: (c, p) => ({ Items: G.getIntegrations(c, { ApiId: A(p) }).map(hInt) }) });
defineCommand({ service: V, name: 'create-route', op: 'CreateRoute', run: (c, p) => hRoute(G.createRoute(c, { ApiId: A(p), RouteKey: need(p, 'RouteKey', 'route-key'), Target: p.Target, AuthorizationType: p.AuthorizationType })) });
defineCommand({ service: V, name: 'get-routes', op: 'GetRoutes', run: (c, p) => ({ Items: G.getRoutes(c, { ApiId: A(p) }).map(hRoute) }) });
defineCommand({ service: V, name: 'delete-route', op: 'DeleteRoute', run: (c, p) => void G.deleteRoute(c, { ApiId: A(p), RouteId: need(p, 'RouteId', 'route-id') }) });
defineCommand({
  service: V, name: 'create-stage', op: 'CreateStage', bool: ['auto-deploy'], structured: ['stage-variables'],
  run: (c, p) => hStage(G.createHttpStage(c, { ApiId: A(p), StageName: need(p, 'StageName', 'stage-name'), AutoDeploy: bool(p.AutoDeploy), StageVariables: p.StageVariables })),
});
defineCommand({ service: V, name: 'get-stages', op: 'GetStages', run: (c, p) => ({ Items: G.getHttpStages(c, { ApiId: A(p) }).map(hStage) }) });
defineCommand({ service: V, name: 'delete-stage', op: 'DeleteStage', run: (c, p) => void G.deleteHttpStage(c, { ApiId: A(p), StageName: need(p, 'StageName', 'stage-name') }) });
defineCommand({
  service: V, name: 'create-deployment', op: 'CreateDeployment',
  run: (c, p) => { const d = G.createHttpDeployment(c, { ApiId: A(p), StageName: p.StageName, Description: p.Description }); return { AutoDeployed: false, CreatedDate: iso(d.createdDate), DeploymentId: d.id, DeploymentStatus: 'DEPLOYED' }; },
});

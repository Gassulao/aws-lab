// Amazon API Gateway: API REST (v1) y API HTTP (v2). Rutas, integraciones (Lambda proxy, MOCK, HTTP), etapas,
// despliegues y las URLs de invocación https://<id>.execute-api.<región>.amazonaws.com/<etapa>/... que atiende `curl`.
// También sirve las URLs de función de Lambda (https://<id>.lambda-url.<región>.on.aws/).
import { AwsError } from '../errors';
import { trailed, type Ctx } from '../api';
import type { CloudState } from '../types';
import { guid, hex, now, nowIso, randomString } from '../util';
import { emitMetric } from '../services/cloudwatch';
import { webHooks, webGet, webRequest, type WebResult } from '../services/web';
import { sv, type HttpApi, type RestApi, type RestMethod, type RestResource } from './types';
import { svAuthorize, asArr } from './util';
import { fnByName, invokeAsService, permitted, execute, resolveVersion, type ExecResult } from './lambda';

const SRC = 'apigateway.amazonaws.com';
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'ANY'];
const nf = (m: string) => new AwsError('NotFoundException', m, 404);
const bad = (m: string) => new AwsError('BadRequestException', m, 400);
const conflict = (m: string) => new AwsError('ConflictException', m, 409);
const apiId = () => randomString(10);
const res = (ctx: Ctx, tail: string) => `arn:aws:apigateway:${ctx.region}::${tail}`;
const auth = (ctx: Ctx, verb: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', tail: string) => svAuthorize(ctx, 'apigateway:' + verb, res(ctx, tail), 'json');

// ------------------------------------------------------------------ REST
export function restApiOr(ctx: Ctx, id: string): RestApi {
  const a = sv(ctx.s).restApis.find((x) => x.id === id && x.region === ctx.region);
  if (!a) throw nf('Invalid API identifier specified ' + ctx.s.account.id + ':' + id);
  return a;
}
function resourceOr(api: RestApi, id: string): RestResource {
  const r = api.resources.find((x) => x.id === id);
  if (!r) throw nf('Invalid Resource identifier specified');
  return r;
}

export function createRestApi(ctx: Ctx, p: { name: string; description?: string; endpointConfiguration?: { types?: string[] }; tags?: Record<string, string> }): RestApi {
  return trailed(ctx, SRC, 'CreateRestApi', [{ type: 'AWS::ApiGateway::RestApi', name: p.name }], { name: p.name }, () => {
    auth(ctx, 'POST', '/restapis');
    if (!p.name) throw bad('Invalid API name specified');
    const id = apiId();
    const api: RestApi = { id, name: p.name, description: p.description ?? '', createdDate: nowIso(), region: ctx.region, endpointTypes: p.endpointConfiguration?.types ?? ['EDGE'], resources: [{ id: randomString(10), path: '/', methods: {} }], deployments: [], stages: [], tags: p.tags ?? {} };
    sv(ctx.s).restApis.push(api);
    return api;
  });
}
export function getRestApis(ctx: Ctx): RestApi[] { return trailed(ctx, SRC, 'GetRestApis', [], {}, () => { auth(ctx, 'GET', '/restapis'); return sv(ctx.s).restApis.filter((a) => a.region === ctx.region); }); }
export function getRestApi(ctx: Ctx, p: { restApiId: string }): RestApi { return trailed(ctx, SRC, 'GetRestApi', [], p, () => { auth(ctx, 'GET', `/restapis/${p.restApiId}`); return restApiOr(ctx, p.restApiId); }); }
export function deleteRestApi(ctx: Ctx, p: { restApiId: string }): void {
  trailed(ctx, SRC, 'DeleteRestApi', [], p, () => { auth(ctx, 'DELETE', `/restapis/${p.restApiId}`); const a = restApiOr(ctx, p.restApiId); sv(ctx.s).restApis = sv(ctx.s).restApis.filter((x) => x !== a); });
}
export function getResources(ctx: Ctx, p: { restApiId: string }): RestResource[] {
  return trailed(ctx, SRC, 'GetResources', [], p, () => { auth(ctx, 'GET', `/restapis/${p.restApiId}/resources`); return restApiOr(ctx, p.restApiId).resources; });
}
export function getResource(ctx: Ctx, p: { restApiId: string; resourceId: string }): RestResource {
  return trailed(ctx, SRC, 'GetResource', [], p, () => { auth(ctx, 'GET', `/restapis/${p.restApiId}/resources/${p.resourceId}`); return resourceOr(restApiOr(ctx, p.restApiId), p.resourceId); });
}
export function createResource(ctx: Ctx, p: { restApiId: string; parentId: string; pathPart: string }): RestResource {
  return trailed(ctx, SRC, 'CreateResource', [], p, () => {
    auth(ctx, 'POST', `/restapis/${p.restApiId}/resources/${p.parentId}`);
    const api = restApiOr(ctx, p.restApiId);
    const parent = resourceOr(api, p.parentId);
    if (!/^([a-zA-Z0-9._-]+|\{[a-zA-Z0-9._-]+\}|\{[a-zA-Z0-9._-]+\+\})$/.test(p.pathPart ?? '')) throw bad('Resource\'s path part only allow a-zA-Z0-9._- and curly braces at the beginning and the end and an optional plus sign before the closing brace.');
    if (api.resources.some((r) => r.parentId === parent.id && r.pathPart === p.pathPart)) throw conflict(`Another resource with the same parent already has this name: ${p.pathPart}`);
    const r: RestResource = { id: randomString(10), parentId: parent.id, pathPart: p.pathPart, path: (parent.path === '/' ? '' : parent.path) + '/' + p.pathPart, methods: {} };
    api.resources.push(r);
    return r;
  });
}
export function deleteResource(ctx: Ctx, p: { restApiId: string; resourceId: string }): void {
  trailed(ctx, SRC, 'DeleteResource', [], p, () => {
    auth(ctx, 'DELETE', `/restapis/${p.restApiId}/resources/${p.resourceId}`);
    const api = restApiOr(ctx, p.restApiId); const r = resourceOr(api, p.resourceId);
    if (!r.parentId) throw bad('Cannot delete the root resource');
    const gone = (x: RestResource): boolean => x.id === r.id || (x.parentId !== undefined && gone(api.resources.find((y) => y.id === x.parentId)!));
    api.resources = api.resources.filter((x) => !gone(x));
  });
}
function methodOr(ctx: Ctx, p: { restApiId: string; resourceId: string; httpMethod: string }) {
  const api = restApiOr(ctx, p.restApiId);
  const r = resourceOr(api, p.resourceId);
  const m = r.methods[p.httpMethod];
  if (!m) throw nf('Invalid Method identifier specified');
  return { api, r, m };
}
export function putMethod(ctx: Ctx, p: { restApiId: string; resourceId: string; httpMethod: string; authorizationType: string; apiKeyRequired?: boolean }): RestMethod {
  return trailed(ctx, SRC, 'PutMethod', [], p, () => {
    auth(ctx, 'PUT', `/restapis/${p.restApiId}/resources/${p.resourceId}/methods/${p.httpMethod}`);
    const api = restApiOr(ctx, p.restApiId); const r = resourceOr(api, p.resourceId);
    if (!METHODS.includes(p.httpMethod)) throw bad(`Invalid HTTP method specified: ${p.httpMethod}`.replace('Invalid HTTP method specified: ' + p.httpMethod, `1 validation error: HTTP method ${p.httpMethod} is not supported`));
    if (!['NONE', 'AWS_IAM', 'CUSTOM', 'COGNITO_USER_POOLS'].includes(p.authorizationType)) throw bad(`Invalid authorizer type specified: ${p.authorizationType}`);
    if (r.methods[p.httpMethod]) throw conflict('Method already exists for this resource');
    const m: RestMethod = { httpMethod: p.httpMethod, authorizationType: p.authorizationType, apiKeyRequired: !!p.apiKeyRequired, responses: {} };
    r.methods[p.httpMethod] = m;
    return m;
  });
}
export function getMethod(ctx: Ctx, p: { restApiId: string; resourceId: string; httpMethod: string }): RestMethod {
  return trailed(ctx, SRC, 'GetMethod', [], p, () => { auth(ctx, 'GET', `/restapis/${p.restApiId}/resources/${p.resourceId}/methods/${p.httpMethod}`); return methodOr(ctx, p).m; });
}
export function deleteMethod(ctx: Ctx, p: { restApiId: string; resourceId: string; httpMethod: string }): void {
  trailed(ctx, SRC, 'DeleteMethod', [], p, () => { auth(ctx, 'DELETE', `/restapis/${p.restApiId}/resources/${p.resourceId}/methods/${p.httpMethod}`); const { r } = methodOr(ctx, p); delete r.methods[p.httpMethod]; });
}
export function putMethodResponse(ctx: Ctx, p: { restApiId: string; resourceId: string; httpMethod: string; statusCode: string; responseModels?: Record<string, string> }) {
  return trailed(ctx, SRC, 'PutMethodResponse', [], p, () => { auth(ctx, 'PUT', `/restapis/${p.restApiId}/resources/${p.resourceId}/methods/${p.httpMethod}/responses/${p.statusCode}`); const { m } = methodOr(ctx, p); if (m.responses[p.statusCode]) throw conflict('Response already exists for this resource'); m.responses[p.statusCode] = { responseModels: p.responseModels }; return p; });
}
export function putIntegration(ctx: Ctx, p: { restApiId: string; resourceId: string; httpMethod: string; type: string; integrationHttpMethod?: string; uri?: string; passthroughBehavior?: string; requestTemplates?: Record<string, string> }) {
  return trailed(ctx, SRC, 'PutIntegration', [], p, () => {
    auth(ctx, 'PUT', `/restapis/${p.restApiId}/resources/${p.resourceId}/methods/${p.httpMethod}/integration`);
    const { m } = methodOr(ctx, p);
    if (!['AWS', 'AWS_PROXY', 'HTTP', 'HTTP_PROXY', 'MOCK'].includes(p.type)) throw bad(`Invalid integration type specified: ${p.type}`.replace(/.*/, `1 validation error detected: Value '${p.type}' at 'type' failed to satisfy constraint: Member must satisfy enum value set: [HTTP, MOCK, AWS_PROXY, HTTP_PROXY, AWS]`));
    if (p.type !== 'MOCK' && !p.uri) throw bad('Invalid Integration URI specified'.replace('Invalid Integration URI specified', 'Uri must be specified for integration type ' + p.type));
    if ((p.type === 'AWS' || p.type === 'AWS_PROXY') && !/^arn:aws:apigateway:[a-z0-9-]+:[a-z0-9-]+:(path|action)\//.test(p.uri ?? '')) throw bad('Invalid ARN specified in the request');
    if ((p.type === 'AWS' || p.type === 'AWS_PROXY') && /:lambda:path\//.test(p.uri ?? '') && p.integrationHttpMethod !== 'POST') throw bad('Invalid HTTP method specified for integration. Lambda integrations must be invoked with POST.');
    if ((p.type === 'HTTP' || p.type === 'HTTP_PROXY') && !p.integrationHttpMethod) throw bad('Enumeration value for HttpMethod must be non-empty');
    m.integration = { type: p.type, httpMethod: p.integrationHttpMethod, uri: p.uri, passthroughBehavior: p.passthroughBehavior ?? (p.type === 'MOCK' || p.type === 'AWS' ? 'WHEN_NO_MATCH' : undefined), requestTemplates: p.requestTemplates, responses: {} };
    return m.integration;
  });
}
export function putIntegrationResponse(ctx: Ctx, p: { restApiId: string; resourceId: string; httpMethod: string; statusCode: string; selectionPattern?: string; responseTemplates?: Record<string, string> }) {
  return trailed(ctx, SRC, 'PutIntegrationResponse', [], p, () => {
    auth(ctx, 'PUT', `/restapis/${p.restApiId}/resources/${p.resourceId}/methods/${p.httpMethod}/integration/responses/${p.statusCode}`);
    const { m } = methodOr(ctx, p);
    if (!m.integration) throw nf('Invalid Integration identifier specified');
    if (!m.responses[p.statusCode]) throw bad('Invalid Response status code specified');
    m.integration.responses[p.statusCode] = { selectionPattern: p.selectionPattern, responseTemplates: p.responseTemplates };
    return p;
  });
}
export function getIntegration(ctx: Ctx, p: { restApiId: string; resourceId: string; httpMethod: string }) {
  return trailed(ctx, SRC, 'GetIntegration', [], p, () => { auth(ctx, 'GET', `/restapis/${p.restApiId}/resources/${p.resourceId}/methods/${p.httpMethod}/integration`); const { m } = methodOr(ctx, p); if (!m.integration) throw nf('Invalid Integration identifier specified'); return m.integration; });
}
export function createDeployment(ctx: Ctx, p: { restApiId: string; stageName?: string; description?: string; variables?: Record<string, string> }) {
  return trailed(ctx, SRC, 'CreateDeployment', [], p, () => {
    auth(ctx, 'POST', `/restapis/${p.restApiId}/deployments`);
    const api = restApiOr(ctx, p.restApiId);
    const withMethods = api.resources.filter((r) => Object.keys(r.methods).length);
    if (!withMethods.length) throw bad("The REST API doesn't contain any methods");
    for (const r of withMethods) for (const m of Object.values(r.methods)) if (!m.integration) throw bad('No integration defined for method');
    if (p.stageName !== undefined && !/^[a-zA-Z0-9_]+$/.test(p.stageName)) throw bad('Stage name only allows a-zA-Z0-9_');
    const d = { id: randomString(6), description: p.description ?? '', createdDate: nowIso(), snapshot: JSON.parse(JSON.stringify(api.resources)) as RestResource[] };
    api.deployments.push(d);
    if (p.stageName) {
      const ex = api.stages.find((x) => x.stageName === p.stageName);
      if (ex) { ex.deploymentId = d.id; ex.lastUpdatedDate = nowIso(); if (p.variables) ex.variables = p.variables; }
      else api.stages.push({ stageName: p.stageName, deploymentId: d.id, description: '', variables: p.variables ?? {}, createdDate: nowIso(), lastUpdatedDate: nowIso() });
    }
    return d;
  });
}
export function getDeployments(ctx: Ctx, p: { restApiId: string }) { return trailed(ctx, SRC, 'GetDeployments', [], p, () => { auth(ctx, 'GET', `/restapis/${p.restApiId}/deployments`); return restApiOr(ctx, p.restApiId).deployments; }); }
export function createStage(ctx: Ctx, p: { restApiId: string; stageName: string; deploymentId: string; description?: string; variables?: Record<string, string> }) {
  return trailed(ctx, SRC, 'CreateStage', [], p, () => {
    auth(ctx, 'POST', `/restapis/${p.restApiId}/stages`);
    const api = restApiOr(ctx, p.restApiId);
    if (!api.deployments.some((d) => d.id === p.deploymentId)) throw bad('Invalid deployment identifier specified');
    if (api.stages.some((s) => s.stageName === p.stageName)) throw conflict('Stage already exists');
    const s = { stageName: p.stageName, deploymentId: p.deploymentId, description: p.description ?? '', variables: p.variables ?? {}, createdDate: nowIso(), lastUpdatedDate: nowIso() };
    api.stages.push(s);
    return s;
  });
}
export function getStages(ctx: Ctx, p: { restApiId: string }) { return trailed(ctx, SRC, 'GetStages', [], p, () => { auth(ctx, 'GET', `/restapis/${p.restApiId}/stages`); return restApiOr(ctx, p.restApiId).stages; }); }
export function getStage(ctx: Ctx, p: { restApiId: string; stageName: string }) {
  return trailed(ctx, SRC, 'GetStage', [], p, () => { auth(ctx, 'GET', `/restapis/${p.restApiId}/stages/${p.stageName}`); const s = restApiOr(ctx, p.restApiId).stages.find((x) => x.stageName === p.stageName); if (!s) throw nf('Invalid Stage identifier specified'); return s; });
}
export function deleteStage(ctx: Ctx, p: { restApiId: string; stageName: string }) {
  trailed(ctx, SRC, 'DeleteStage', [], p, () => { auth(ctx, 'DELETE', `/restapis/${p.restApiId}/stages/${p.stageName}`); const api = restApiOr(ctx, p.restApiId); if (!api.stages.some((x) => x.stageName === p.stageName)) throw nf('Invalid Stage identifier specified'); api.stages = api.stages.filter((x) => x.stageName !== p.stageName); });
}
export function updateStage(ctx: Ctx, p: { restApiId: string; stageName: string; patchOperations: { op: string; path: string; value?: string }[] }) {
  return trailed(ctx, SRC, 'UpdateStage', [], p, () => {
    auth(ctx, 'PATCH', `/restapis/${p.restApiId}/stages/${p.stageName}`);
    const api = restApiOr(ctx, p.restApiId); const s = api.stages.find((x) => x.stageName === p.stageName);
    if (!s) throw nf('Invalid Stage identifier specified');
    for (const o of asArr(p.patchOperations)) {
      if (o.path === '/deploymentId') { if (!api.deployments.some((d) => d.id === o.value)) throw bad('Invalid deployment identifier specified'); s.deploymentId = o.value!; }
      else if (o.path === '/description') s.description = o.value ?? '';
      else if (o.path.startsWith('/variables/')) { const k = o.path.slice(11); if (o.op === 'remove') delete s.variables[k]; else s.variables[k] = o.value ?? ''; }
      else throw bad(`Invalid patch path ${o.path}`);
    }
    s.lastUpdatedDate = nowIso();
    return s;
  });
}

// ------------------------------------------------------------------ HTTP API (v2)
export function httpApiOr(ctx: Ctx, id: string): HttpApi {
  const a = sv(ctx.s).httpApis.find((x) => x.id === id && x.region === ctx.region);
  if (!a) throw new AwsError('NotFoundException', `Invalid API identifier specified ${ctx.s.account.id}:${id}`, 404);
  return a;
}
export const httpEndpoint = (a: HttpApi) => `https://${a.id}.execute-api.${a.region}.amazonaws.com`;
const v2auth = (ctx: Ctx, verb: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', tail: string) => svAuthorize(ctx, 'apigateway:' + verb, `arn:aws:apigateway:${ctx.region}::${tail}`, 'json');
const lambdaUriOf = (uri: string) => (uri.startsWith('arn:aws:apigateway:') ? (/functions\/(arn:[^/]+)\/invocations/.exec(uri)?.[1] ?? uri) : uri);

export function createHttpApi(ctx: Ctx, p: { Name: string; ProtocolType: string; Target?: string; RouteKey?: string; CorsConfiguration?: any; Tags?: Record<string, string> }): HttpApi {
  return trailed(ctx, SRC, 'CreateApi', [{ type: 'AWS::ApiGatewayV2::Api', name: p.Name }], { name: p.Name, protocolType: p.ProtocolType }, () => {
    v2auth(ctx, 'POST', '/apis');
    if (p.ProtocolType !== 'HTTP') throw bad(p.ProtocolType === 'WEBSOCKET' ? 'Este simulador solo admite APIs HTTP (ProtocolType=HTTP).' : `1 validation error detected: Value '${p.ProtocolType}' at 'protocolType' failed to satisfy constraint: Member must satisfy enum value set: [HTTP, WEBSOCKET]`);
    const a: HttpApi = { id: apiId(), name: p.Name, protocolType: 'HTTP', createdDate: nowIso(), region: ctx.region, routes: [], integrations: [], stages: [], deployments: [], cors: p.CorsConfiguration, tags: p.Tags ?? {} };
    if (p.Target) {
      const iid = randomString(7);
      a.integrations.push({ id: iid, type: 'AWS_PROXY', uri: p.Target, payloadFormatVersion: '2.0', method: 'POST' });
      a.routes.push({ id: randomString(7), routeKey: p.RouteKey ?? '$default', target: `integrations/${iid}`, authorizationType: 'NONE' });
      const d = { id: randomString(6), createdDate: nowIso() };
      a.deployments.push(d);
      a.stages.push({ stageName: '$default', autoDeploy: true, deploymentId: d.id, createdDate: nowIso(), variables: {} });
    }
    sv(ctx.s).httpApis.push(a);
    return a;
  });
}
export function getHttpApis(ctx: Ctx) { return trailed(ctx, SRC, 'GetApis', [], {}, () => { v2auth(ctx, 'GET', '/apis'); return sv(ctx.s).httpApis.filter((a) => a.region === ctx.region); }); }
export function getHttpApi(ctx: Ctx, p: { ApiId: string }) { return trailed(ctx, SRC, 'GetApi', [], p, () => { v2auth(ctx, 'GET', `/apis/${p.ApiId}`); return httpApiOr(ctx, p.ApiId); }); }
export function deleteHttpApi(ctx: Ctx, p: { ApiId: string }) { trailed(ctx, SRC, 'DeleteApi', [], p, () => { v2auth(ctx, 'DELETE', `/apis/${p.ApiId}`); const a = httpApiOr(ctx, p.ApiId); sv(ctx.s).httpApis = sv(ctx.s).httpApis.filter((x) => x !== a); }); }
export function createIntegration(ctx: Ctx, p: { ApiId: string; IntegrationType: string; IntegrationUri?: string; PayloadFormatVersion?: string; IntegrationMethod?: string }) {
  return trailed(ctx, SRC, 'CreateIntegration', [], p, () => {
    v2auth(ctx, 'POST', `/apis/${p.ApiId}/integrations`);
    const a = httpApiOr(ctx, p.ApiId);
    if (!['AWS_PROXY', 'HTTP_PROXY'].includes(p.IntegrationType)) throw bad(`Este simulador admite IntegrationType AWS_PROXY y HTTP_PROXY (recibido ${p.IntegrationType}).`);
    if (!p.IntegrationUri) throw bad('IntegrationUri is required for integration type ' + p.IntegrationType);
    const pf = p.PayloadFormatVersion ?? '1.0';
    if (p.IntegrationType === 'AWS_PROXY' && !['1.0', '2.0'].includes(pf)) throw bad("PayloadFormatVersion must be '1.0' or '2.0'");
    const i = { id: randomString(7), type: p.IntegrationType, uri: p.IntegrationUri, payloadFormatVersion: p.IntegrationType === 'AWS_PROXY' ? pf : '1.0', method: p.IntegrationMethod ?? (p.IntegrationType === 'AWS_PROXY' ? 'POST' : 'ANY') };
    a.integrations.push(i);
    return i;
  });
}
export function getIntegrations(ctx: Ctx, p: { ApiId: string }) { return trailed(ctx, SRC, 'GetIntegrations', [], p, () => { v2auth(ctx, 'GET', `/apis/${p.ApiId}/integrations`); return httpApiOr(ctx, p.ApiId).integrations; }); }
export function createRoute(ctx: Ctx, p: { ApiId: string; RouteKey: string; Target?: string; AuthorizationType?: string }) {
  return trailed(ctx, SRC, 'CreateRoute', [], p, () => {
    v2auth(ctx, 'POST', `/apis/${p.ApiId}/routes`);
    const a = httpApiOr(ctx, p.ApiId);
    const k = p.RouteKey ?? '';
    if (k !== '$default' && !/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|ANY) \/\S*$/.test(k)) throw bad(`Unable to create route: Invalid route key '${k}'. Route keys must be of the form "METHOD /path" or "$default".`.replace(/^Unable to create route: /, ''));
    if (a.routes.some((r) => r.routeKey === k)) throw conflict(`Route with key ${k} already exists`.replace('Route with key', 'Route key').replace(' already exists', ' already exists for this API'));
    if (p.Target) { const iid = p.Target.replace('integrations/', ''); if (!a.integrations.some((i) => i.id === iid)) throw bad(`Unable to find Integration with ID ${iid}`.replace(/^/, '')); }
    const r = { id: randomString(7), routeKey: k, target: p.Target, authorizationType: p.AuthorizationType ?? 'NONE' };
    a.routes.push(r);
    return r;
  });
}
export function getRoutes(ctx: Ctx, p: { ApiId: string }) { return trailed(ctx, SRC, 'GetRoutes', [], p, () => { v2auth(ctx, 'GET', `/apis/${p.ApiId}/routes`); return httpApiOr(ctx, p.ApiId).routes; }); }
export function deleteRoute(ctx: Ctx, p: { ApiId: string; RouteId: string }) { trailed(ctx, SRC, 'DeleteRoute', [], p, () => { v2auth(ctx, 'DELETE', `/apis/${p.ApiId}/routes/${p.RouteId}`); const a = httpApiOr(ctx, p.ApiId); if (!a.routes.some((r) => r.id === p.RouteId)) throw nf(`Invalid Route identifier specified ${p.RouteId}`); a.routes = a.routes.filter((r) => r.id !== p.RouteId); }); }
export function createHttpStage(ctx: Ctx, p: { ApiId: string; StageName: string; AutoDeploy?: boolean; StageVariables?: Record<string, string> }) {
  return trailed(ctx, SRC, 'CreateStage', [], p, () => {
    v2auth(ctx, 'POST', `/apis/${p.ApiId}/stages`);
    const a = httpApiOr(ctx, p.ApiId);
    if (a.stages.some((s) => s.stageName === p.StageName)) throw conflict(`Stage with name ${p.StageName} already exists`.replace('Stage with name', 'Stage').replace('already exists', 'already exists'));
    let deploymentId: string | undefined;
    if (p.AutoDeploy) { const d = { id: randomString(6), createdDate: nowIso() }; a.deployments.push(d); deploymentId = d.id; }
    const s = { stageName: p.StageName, autoDeploy: !!p.AutoDeploy, deploymentId, createdDate: nowIso(), variables: p.StageVariables ?? {} };
    a.stages.push(s);
    return s;
  });
}
export function getHttpStages(ctx: Ctx, p: { ApiId: string }) { return trailed(ctx, SRC, 'GetStages', [], p, () => { v2auth(ctx, 'GET', `/apis/${p.ApiId}/stages`); return httpApiOr(ctx, p.ApiId).stages; }); }
export function deleteHttpStage(ctx: Ctx, p: { ApiId: string; StageName: string }) { trailed(ctx, SRC, 'DeleteStage', [], p, () => { v2auth(ctx, 'DELETE', `/apis/${p.ApiId}/stages/${p.StageName}`); const a = httpApiOr(ctx, p.ApiId); if (!a.stages.some((s) => s.stageName === p.StageName)) throw nf(`Invalid stage identifier specified: ${p.StageName}`); a.stages = a.stages.filter((s) => s.stageName !== p.StageName); }); }
export function createHttpDeployment(ctx: Ctx, p: { ApiId: string; StageName?: string; Description?: string }) {
  return trailed(ctx, SRC, 'CreateDeployment', [], p, () => {
    v2auth(ctx, 'POST', `/apis/${p.ApiId}/deployments`);
    const a = httpApiOr(ctx, p.ApiId);
    const d = { id: randomString(6), createdDate: nowIso() };
    a.deployments.push(d);
    if (p.StageName) { const s = a.stages.find((x) => x.stageName === p.StageName); if (!s) throw nf(`Invalid stage identifier specified: ${p.StageName}`); s.deploymentId = d.id; }
    return d;
  });
}

// ------------------------------------------------------------------ invocación HTTP

const JSON_H = { 'content-type': 'application/json', 'x-amzn-requestid': '' };
const reply = (status: number, body: string, headers: Record<string, string> = {}): WebResult => ({ kind: 'ok', status, headers: { ...JSON_H, 'x-amzn-requestid': guid(), ...headers }, body });
const msg = (status: number, m: string, key = 'message') => reply(status, JSON.stringify({ [key]: m }), { 'x-amzn-errortype': status === 403 ? 'ForbiddenException' : status === 404 ? 'NotFoundException' : 'InternalServerErrorException' });

interface Req { method: string; path: string; query: string; headers: Record<string, string>; body: string }
function parseReq(rawUrl: string, host: string): Req {
  const u = new URL(rawUrl.startsWith('http') ? rawUrl : 'https://' + rawUrl);
  const hs: Record<string, string> = { Host: host, 'User-Agent': 'curl/8.5.0', Accept: '*/*', 'X-Forwarded-Port': '443', 'X-Forwarded-Proto': 'https' };
  for (const [k, v] of Object.entries(webRequest.headers)) hs[k] = v;
  if (webRequest.body && !hs['Content-Type'] && !hs['content-type']) hs['Content-Type'] = 'application/x-www-form-urlencoded';
  return { method: webRequest.method || 'GET', path: u.pathname || '/', query: u.search.replace(/^\?/, ''), headers: hs, body: webRequest.body };
}
const qs = (q: string): Record<string, string> | null => { if (!q) return null; const o: Record<string, string> = {}; for (const [k, v] of new URLSearchParams(q)) o[k] = v; return o; };
const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

/** Coincidencia de plantilla de ruta (/items/{id}, /{proxy+}) → parámetros y puntuación (más literales = mejor). */
function matchPath(tpl: string, path: string): { params: Record<string, string>; score: number } | null {
  const t = tpl.split('/').filter(Boolean), p = path.split('/').filter(Boolean);
  const params: Record<string, string> = {};
  let score = 0;
  for (let i = 0; i < t.length; i++) {
    const seg = t[i];
    const greedy = /^\{(.+)\+\}$/.exec(seg);
    if (greedy) { if (p.length <= i) return null; params[greedy[1]] = p.slice(i).join('/'); return { params, score }; }
    if (p[i] === undefined) return null;
    const par = /^\{(.+)\}$/.exec(seg);
    if (par) { params[par[1]] = decodeURIComponent(p[i]); score += 1; } else if (seg === p[i]) score += 10; else return null;
  }
  return p.length === t.length ? { params, score: score + 5 } : null;
}

function lambdaResult(r: ExecResult | undefined, kind: 'rest' | 'v2' | 'v1'): { status: number; headers: Record<string, string>; body: string } | 'error' {
  if (!r || !r.ok) return 'error';
  const v = r.value;
  if (kind === 'v2' && !(v && typeof v === 'object' && 'statusCode' in v)) {
    if (v === undefined || v === null) return { status: 200, headers: { 'content-type': 'application/json' }, body: '' };
    return { status: 200, headers: { 'content-type': 'application/json' }, body: typeof v === 'string' ? v : JSON.stringify(v) };
  }
  if (!v || typeof v !== 'object' || !Number.isInteger(v.statusCode) || v.statusCode < 100 || v.statusCode > 599) return 'error';
  if (v.body !== undefined && v.body !== null && typeof v.body !== 'string') return 'error';
  const h: Record<string, string> = {};
  for (const [k, x] of Object.entries(v.headers ?? {})) h[k.toLowerCase()] = String(x);
  if (Array.isArray(v.cookies)) h['set-cookie'] = v.cookies.join(', ');
  if (!h['content-type']) h['content-type'] = kind === 'v2' ? 'application/json' : 'application/json';
  return { status: v.statusCode, headers: h, body: v.isBase64Encoded ? atob(v.body ?? '') : (v.body ?? '') };
}

function metrics(s: CloudState, dims: Record<string, string>, status: number, latency: number) {
  const t = now();
  emitMetric(s, 'AWS/ApiGateway', 'Count', 1, t, dims);
  emitMetric(s, 'AWS/ApiGateway', 'Latency', latency, t, dims);
  if (status >= 500) emitMetric(s, 'AWS/ApiGateway', '5XXError', 1, t, dims);
  else if (status >= 400) emitMetric(s, 'AWS/ApiGateway', '4XXError', 1, t, dims);
}

function restEvent(api: RestApi, stage: string, r: RestResource, req: Req, params: Record<string, string>, vars: Record<string, string>) {
  const hs = req.headers;
  return {
    resource: r.path, path: req.path, httpMethod: req.method, headers: hs, multiValueHeaders: Object.fromEntries(Object.entries(hs).map(([k, v]) => [k, [v]])),
    queryStringParameters: qs(req.query), multiValueQueryStringParameters: req.query ? Object.fromEntries([...new URLSearchParams(req.query).keys()].map((k) => [k, new URLSearchParams(req.query).getAll(k)])) : null,
    pathParameters: Object.keys(params).length ? params : null, stageVariables: Object.keys(vars).length ? vars : null,
    requestContext: { resourceId: r.id, resourcePath: r.path, httpMethod: req.method, extendedRequestId: hex(15), requestTime: new Date(now()).toUTCString(), path: `/${stage}${req.path}`, accountId: '', protocol: 'HTTP/1.1', stage, domainPrefix: api.id, requestTimeEpoch: now(), requestId: guid(), identity: { sourceIp: '203.0.113.10', userAgent: hs['User-Agent'] }, domainName: `${api.id}.execute-api.${api.region}.amazonaws.com`, apiId: api.id },
    body: req.body || null, isBase64Encoded: false,
  };
}

function handleRest(s: CloudState, api: RestApi, stageName: string, req: Req, pathInStage: string): WebResult {
  const dims = { ApiName: api.name, Stage: stageName };
  const t0 = now();
  const done = (w: WebResult) => { if (w.kind === 'ok') metrics(s, dims, w.status, 5); return w; };
  const stage = api.stages.find((x) => x.stageName === stageName);
  const dep = stage && api.deployments.find((d) => d.id === stage.deploymentId);
  if (!stage || !dep) return msg(403, 'Forbidden', 'message');
  let best: { r: RestResource; params: Record<string, string>; score: number } | null = null;
  for (const r of dep.snapshot) {
    if (!Object.keys(r.methods).length) continue;
    const m = matchPath(r.path, pathInStage);
    if (m && (!best || m.score > best.score)) best = { r, ...m };
  }
  const missing = () => done(reply(403, JSON.stringify({ message: 'Missing Authentication Token' }), { 'x-amzn-errortype': 'MissingAuthenticationTokenException' }));
  if (!best) return missing();
  const meth = best.r.methods[req.method] ?? best.r.methods.ANY;
  if (!meth) return missing();
  if (meth.authorizationType === 'AWS_IAM') return done(reply(403, JSON.stringify({ message: 'Missing Authentication Token' }), { 'x-amzn-errortype': 'MissingAuthenticationTokenException' }));
  const integ = meth.integration;
  if (!integ) return done(msg(500, 'Internal server error'));
  void t0;
  const ev = restEvent(api, stageName, best.r, req, best.params, stage.variables);
  ev.requestContext.accountId = s.account.id;
  if (integ.type === 'MOCK') {
    let code = 200;
    const tpl = integ.requestTemplates?.['application/json'];
    if (tpl) { try { code = Number(JSON.parse(tpl).statusCode) || 200; } catch { code = 200; } }
    const ir = integ.responses[String(code)] ?? Object.entries(integ.responses).find(([, v]) => v.selectionPattern && new RegExp(v.selectionPattern).test(String(code)))?.[1];
    if (!ir) return done(msg(500, 'Internal server error'));
    return done(reply(code, ir.responseTemplates?.['application/json'] ?? '', {}));
  }
  if (integ.type === 'HTTP' || integ.type === 'HTTP_PROXY') {
    let uri = integ.uri ?? '';
    for (const [k, v] of Object.entries(best.params)) uri = uri.replace(`{${k}+}`, v).replace(`{${k}}`, v);
    const w = webGet(s, uri + (integ.type === 'HTTP_PROXY' && req.query && !uri.includes('?') ? '?' + req.query : ''));
    if (!w || w.kind !== 'ok') return done(msg(504, 'Endpoint request timed out'));
    return done({ ...w, headers: { ...w.headers, 'x-amzn-requestid': guid() } });
  }
  // AWS / AWS_PROXY hacia Lambda
  const fnArn = lambdaUriOf(integ.uri ?? '');
  const source = `arn:aws:execute-api:${api.region}:${s.account.id}:${api.id}/${stageName}/${req.method}${best.r.path === '/' ? '/' : best.r.path}`;
  const proxy = integ.type === 'AWS_PROXY';
  let payload: any = ev;
  if (!proxy) { try { payload = req.body ? JSON.parse(req.body) : {}; } catch { payload = {}; } }
  const out = invokeAsService(s, api.region, fnArn, 'apigateway.amazonaws.com', source, payload, 'apigateway');
  if (out.status !== 'ok' && out.status !== 'error') return done(msg(out.status === 'throttled' ? 429 : 500, out.status === 'throttled' ? 'Too Many Requests' : 'Internal server error'));
  if (out.result?.timedOut) return done(msg(504, 'Endpoint request timed out'));
  if (proxy) {
    const lr = lambdaResult(out.result, 'rest');
    if (lr === 'error') return done(msg(502, 'Internal server error'));
    return done(reply(lr.status, lr.body, lr.headers));
  }
  // integración no proxy: la respuesta de integración se elige por selectionPattern sobre el mensaje de error
  let code = '200';
  let body = out.result!.payload;
  if (!out.result!.ok) {
    const em = out.result!.errorMessage ?? '';
    const hit = Object.entries(meth.integration!.responses).find(([, v]) => v.selectionPattern && new RegExp(v.selectionPattern).test(em));
    if (hit) code = hit[0];
  }
  const ir = meth.integration!.responses[code];
  if (!ir && !Object.keys(meth.integration!.responses).length) return done(msg(500, 'Internal server error'));
  if (ir?.responseTemplates?.['application/json']) body = ir.responseTemplates['application/json'];
  return done(reply(Number(code), body));
}

function handleHttp(s: CloudState, api: HttpApi, stageName: string, req: Req, pathInStage: string): WebResult {
  const dims = { ApiId: api.id, Stage: stageName };
  const done = (w: WebResult) => { if (w.kind === 'ok') metrics(s, dims, w.status, 5); return w; };
  const stage = api.stages.find((x) => x.stageName === stageName);
  if (!stage || (!stage.autoDeploy && !stage.deploymentId)) return msg(404, 'Not Found');
  type Cand = { route: HttpApi['routes'][number]; params: Record<string, string>; score: number };
  let best: Cand | null = null;
  for (const route of api.routes) {
    if (route.routeKey === '$default') { if (!best) best = { route, params: {}, score: 0 }; continue; }
    const [m, tpl] = route.routeKey.split(' ');
    if (m !== 'ANY' && m !== req.method) continue;
    const mp = matchPath(tpl, pathInStage);
    if (!mp) continue;
    const score = mp.score * 2 + (m === req.method ? 1 : 0) + 1;
    if (!best || score > best.score) best = { route, params: mp.params, score };
  }
  if (!best) return done(msg(404, 'Not Found'));
  const integ = api.integrations.find((i) => `integrations/${i.id}` === best!.route.target);
  if (!integ) return done(msg(500, 'Internal Server Error', 'message'));
  if (integ.type === 'HTTP_PROXY') {
    let uri = integ.uri;
    for (const [k, v] of Object.entries(best.params)) uri = uri.replace(`{${k}+}`, v).replace(`{${k}}`, v);
    const w = webGet(s, uri + (req.query ? '?' + req.query : ''));
    if (!w || w.kind !== 'ok') return done(msg(503, 'Service Unavailable'));
    return done(w);
  }
  const hs = lower(req.headers);
  const rk = best.route.routeKey;
  const tpl = rk === '$default' ? '$default' : rk.split(' ')[1];
  const base = {
    routeKey: rk, headers: integ.payloadFormatVersion === '2.0' ? hs : req.headers, queryStringParameters: qs(req.query) ?? undefined, pathParameters: Object.keys(best.params).length ? best.params : undefined, stageVariables: Object.keys(stage.variables).length ? stage.variables : undefined, body: req.body || undefined, isBase64Encoded: false,
  };
  const ev = integ.payloadFormatVersion === '2.0'
    ? { version: '2.0', ...base, rawPath: stageName === '$default' ? req.path : `/${stageName}${req.path}`, rawQueryString: req.query, requestContext: { accountId: s.account.id, apiId: api.id, domainName: `${api.id}.execute-api.${api.region}.amazonaws.com`, domainPrefix: api.id, http: { method: req.method, path: req.path, protocol: 'HTTP/1.1', sourceIp: '203.0.113.10', userAgent: hs['user-agent'] }, requestId: hex(15), routeKey: rk, stage: stageName, time: new Date(now()).toUTCString(), timeEpoch: now() } }
    : { version: '1.0', resource: tpl, path: req.path, httpMethod: req.method, multiValueHeaders: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, [v]])), multiValueQueryStringParameters: null, ...base, requestContext: { accountId: s.account.id, apiId: api.id, domainName: `${api.id}.execute-api.${api.region}.amazonaws.com`, httpMethod: req.method, path: req.path, protocol: 'HTTP/1.1', requestId: hex(15), resourcePath: tpl, stage: stageName, requestTimeEpoch: now(), identity: { sourceIp: '203.0.113.10', userAgent: hs['user-agent'] } } };
  const fnArn = lambdaUriOf(integ.uri);
  const methodForArn = rk === '$default' ? 'ANY' : req.method;
  const source = `arn:aws:execute-api:${api.region}:${s.account.id}:${api.id}/${stageName}/${methodForArn}${tpl === '$default' ? '' : tpl}`;
  const out = invokeAsService(s, api.region, fnArn, 'apigateway.amazonaws.com', source, ev, 'apigateway');
  if (out.status !== 'ok' && out.status !== 'error') return done(msg(500, 'Internal Server Error'));
  if (out.result?.timedOut) return done(msg(503, 'Service Unavailable'));
  const lr = lambdaResult(out.result, integ.payloadFormatVersion === '2.0' ? 'v2' : 'v1');
  if (lr === 'error') return done(msg(integ.payloadFormatVersion === '2.0' && out.result?.ok ? 500 : 500, 'Internal Server Error'));
  return done(reply(lr.status, lr.body, lr.headers));
}

function handleFnUrl(s: CloudState, region: string, id: string, req: Req): WebResult {
  const fn = sv(s).lambdas.find((f) => f.url?.id === id && f.region === region);
  if (!fn) return { kind: 'nohost', host: `${id}.lambda-url.${region}.on.aws`, port: 443 };
  if (fn.url!.authType === 'AWS_IAM') return reply(403, JSON.stringify({ Message: 'Forbidden' }), { 'x-amzn-errortype': 'AccessDeniedException' });
  if (!permitted(fn, '*', undefined, 'lambda:InvokeFunctionUrl') ) return reply(403, JSON.stringify({ Message: 'Forbidden' }), { 'x-amzn-errortype': 'AccessDeniedException' });
  const hs = lower(req.headers);
  const ev = {
    version: '2.0', routeKey: '$default', rawPath: req.path, rawQueryString: req.query, headers: hs, queryStringParameters: qs(req.query) ?? undefined, body: req.body || undefined, isBase64Encoded: false,
    requestContext: { accountId: 'anonymous', apiId: id, domainName: `${id}.lambda-url.${region}.on.aws`, domainPrefix: id, http: { method: req.method, path: req.path, protocol: 'HTTP/1.1', sourceIp: '203.0.113.10', userAgent: hs['user-agent'] }, requestId: guid(), routeKey: '$default', stage: '$default', time: new Date(now()).toUTCString(), timeEpoch: now() },
  };
  const r = execute(s, fn.region, fn, resolveVersion(fn), ev, 'url');
  if (r.timedOut) return reply(502, JSON.stringify({ message: 'Internal Server Error' }));
  const lr = lambdaResult(r, 'v2');
  if (lr === 'error') return reply(502, JSON.stringify({ message: 'Internal Server Error' }));
  return reply(lr.status, lr.body, lr.headers);
}

webHooks.push((s, host, _port, _scheme, raw): WebResult | null => {
  const m = /^([a-z0-9]+)\.execute-api\.([a-z0-9-]+)\.amazonaws\.com$/.exec(host);
  const lu = /^([a-f0-9]+)\.lambda-url\.([a-z0-9-]+)\.on\.aws$/.exec(host);
  if (!m && !lu) return null;
  const req = parseReq(raw ?? `https://${host}/`, host);
  if (lu) return handleFnUrl(s, lu[2], lu[1], req);
  const [, id, region] = m!;
  const rest = sv(s).restApis.find((a) => a.id === id && a.region === region);
  const http = sv(s).httpApis.find((a) => a.id === id && a.region === region);
  if (!rest && !http) return reply(403, JSON.stringify({ message: 'Forbidden' }));
  const segs = req.path.split('/').filter(Boolean);
  if (rest) {
    const stage = segs[0];
    if (!stage) return reply(403, JSON.stringify({ message: 'Forbidden' }));
    return handleRest(s, rest, stage, req, '/' + segs.slice(1).join('/'));
  }
  const api = http!;
  const named = api.stages.find((x) => x.stageName !== '$default' && x.stageName === segs[0]);
  if (named) return handleHttp(s, api, named.stageName, req, '/' + segs.slice(1).join('/'));
  return handleHttp(s, api, '$default', req, req.path);
});

/** Para la consola y el comando `test-invoke-method`: ejecuta una petición contra una etapa sin pasar por `curl`. */
export function testInvoke(ctx: Ctx, p: { restApiId: string; resourceId: string; httpMethod: string; pathWithQueryString?: string; body?: string }) {
  return trailed(ctx, SRC, 'TestInvokeMethod', [], p, () => {
    auth(ctx, 'POST', `/restapis/${p.restApiId}/resources/${p.resourceId}/methods/${p.httpMethod}`);
    const { api, r } = methodOr(ctx, p);
    const saved = { ...webRequest };
    webRequest.method = p.httpMethod; webRequest.body = p.body ?? ''; webRequest.headers = {};
    const tmp: RestApi = { ...api, stages: [{ stageName: 'test-invoke-stage', deploymentId: 'test', description: '', variables: {}, createdDate: nowIso(), lastUpdatedDate: nowIso() }], deployments: [{ id: 'test', description: '', createdDate: nowIso(), snapshot: api.resources }] };
    const path = (p.pathWithQueryString ?? r.path).split('?');
    const t0 = now();
    const w = handleRest(ctx.s, tmp, 'test-invoke-stage', parseReq(`https://${api.id}.execute-api.${api.region}.amazonaws.com${path[0]}${path[1] ? '?' + path[1] : ''}`, `${api.id}.execute-api.${api.region}.amazonaws.com`), path[0]);
    Object.assign(webRequest, saved);
    return { w, latency: Math.max(1, now() - t0) };
  });
}
void fnByName;

// Punto de entrada de los servicios sin servidor: registra los enlaces entre servicios y expone el paso del tiempo.
import type { CloudState } from '../types';
import { bridge } from './bridge';
import { settleRds } from './rds';
import { processMappings } from './lambda';
import './fanout';
import './apigateway';

export * as lambda from './lambda';
export * as sqs from './sqs';
export * as apigw from './apigateway';
export * as rds from './rds';
export * as ddb from './dynamodb';
export { sv } from './types';

/** Aplica el paso del tiempo a todos los servicios: estados de RDS y DynamoDB, mappings de SQS → Lambda, retención. */
export function settleSv(s: CloudState): void {
  settleRds(s);
  processMappings(s);
}
bridge.settle = settleSv;

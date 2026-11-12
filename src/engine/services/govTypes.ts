// Estado de gobernanza y costes: AWS Organizations, AWS Config, Budgets, Cost Explorer y Trusted Advisor.
// Se crea de forma perezosa con gov(s) para no tocar el esquema guardado.
import type { CloudState } from '../types';

export interface OrgAccount {
  id: string;
  name: string;
  email: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'PENDING_CLOSURE';
  joinedMethod: 'CREATED' | 'INVITED';
  joinedAt: string;
  parentId: string;
  /** Cuenta de administración (la cuenta del alumno). */
  management: boolean;
}
export interface OrgUnit { id: string; name: string; parentId: string; createdAt: string }
export interface OrgPolicy {
  id: string;
  name: string;
  description: string;
  type: 'SERVICE_CONTROL_POLICY';
  /** JSON de la política, como lo devuelve describe-policy. */
  content: string;
  awsManaged: boolean;
  /** Ids de raíz, unidad organizativa o cuenta a los que está adjunta. */
  targets: string[];
}
export interface CreateAccountStatus {
  id: string;
  accountName: string;
  email: string;
  state: 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED';
  requestedAt: string;
  completedAt?: string;
  accountId?: string;
  failureReason?: string;
}
export interface Organization {
  id: string;
  featureSet: 'ALL';
  masterAccountId: string;
  masterEmail: string;
  rootId: string;
  /** El tipo de política SCP está habilitado en la raíz. */
  scpEnabled: boolean;
  accounts: OrgAccount[];
  ous: OrgUnit[];
  policies: OrgPolicy[];
  createStatuses: CreateAccountStatus[];
}

export interface ConfigRule {
  name: string;
  id: string;
  arn: string;
  description?: string;
  /** Identificador de la regla gestionada (S3_BUCKET_PUBLIC_READ_PROHIBITED, ...). */
  identifier: string;
  inputParameters: Record<string, string>;
  scopeTypes?: string[];
  createdAt: string;
  lastEvaluatedAt?: string;
}
export interface ConfigRecorder { name: string; roleArn: string; allSupported: boolean; includeGlobal: boolean; resourceTypes: string[]; recording: boolean; lastStartAt?: string; lastStopAt?: string }
export interface DeliveryChannel { name: string; s3Bucket: string; s3Prefix?: string; snsTopicArn?: string }
export interface ConfigState { recorder?: ConfigRecorder; channel?: DeliveryChannel; rules: ConfigRule[] }

export interface BudgetNotification {
  type: 'ACTUAL' | 'FORECASTED';
  operator: 'GREATER_THAN' | 'LESS_THAN' | 'EQUAL_TO';
  threshold: number;
  thresholdType: 'PERCENTAGE' | 'ABSOLUTE_VALUE';
  subscribers: { type: 'EMAIL' | 'SNS'; address: string }[];
  /** Estado actual (OK o ALARM) y cuándo se avisó por última vez. */
  state: 'OK' | 'ALARM';
  notifiedAt?: string;
}
export interface Budget {
  name: string;
  type: 'COST';
  timeUnit: 'MONTHLY' | 'QUARTERLY' | 'ANNUALLY' | 'DAILY';
  limit: number;
  unit: 'USD';
  createdAt: string;
  notifications: BudgetNotification[];
}
export interface TaFlagged { status: 'warning' | 'error'; region: string; resourceId: string; metadata: string[] }
export interface TaResult { checkId: string; timestamp: string; status: 'ok' | 'warning' | 'error'; processed: number; flagged: number; savings?: number; flaggedResources: TaFlagged[] }
/** Trusted Advisor guarda el último resultado de cada comprobación; solo cambia al actualizarla (refresh). */
export interface SupportState { plan: 'business'; refreshed: Record<string, string>; cache?: Record<string, TaResult> }

export interface BudgetAlert { ts: string; budget: string; to: string; channel: 'EMAIL' | 'SNS'; subject: string; body: string }
export interface GovState {
  org?: Organization;
  config: ConfigState;
  budgets: Budget[];
  /** Avisos de presupuesto enviados (correo y SNS). */
  alerts?: BudgetAlert[];
  support: SupportState;
}

export function gov(s: CloudState): GovState {
  return (s.gov ??= { config: { rules: [] }, budgets: [], support: { plan: 'business', refreshed: {} } });
}

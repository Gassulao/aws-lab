// Modelo de datos de Git y CI/CD (CodeCommit, CodeBuild, CodePipeline y CodeDeploy).
// Se guarda en `CloudState.cicd`, que se crea al primer uso (no requiere migración).
import type { CloudState, Tags } from '../types';

// ---------------------------------------------------------------- Git (objetos compartidos por repos locales y CodeCommit)

export interface GitIdent { name: string; email: string; date: number }
export interface GitCommit {
  id: string;
  /** Árbol plano: ruta -> id del blob. */
  tree: Record<string, string>;
  parents: string[];
  message: string;
  author: GitIdent;
  committer: GitIdent;
}
export interface GitObjects {
  commits: Record<string, GitCommit>;
  blobs: Record<string, string>;
}

// ---------------------------------------------------------------- CodeCommit

export interface CcApprovalRuleContent { Version: string; DestinationReferences?: string[]; Statements: { Type: 'Approvers'; NumberOfApprovalsNeeded: number; ApprovalPoolMembers?: string[] }[] }
export interface CcRuleTemplate { id: string; name: string; description?: string; content: string; created: number; modified: number; creator: string; repos: string[] }
export interface CcPrRule { id: string; name: string; content: string; fromTemplate?: string; created: number; modified: number; satisfiedBy?: string }
export interface CcComment { id: string; author: string; text: string; ts: number }
export interface CcPr {
  id: string;
  title: string;
  description?: string;
  author: string;
  status: 'OPEN' | 'CLOSED';
  created: number;
  lastActivity: number;
  source: string;
  dest: string;
  sourceCommit: string;
  destCommit: string;
  mergeBase: string;
  merged?: { by: string; at: number; commit: string; option: 'FAST_FORWARD_MERGE' | 'SQUASH_MERGE' | 'THREE_WAY_MERGE' };
  revisionId: string;
  approvals: { user: string; state: 'APPROVE' | 'REVOKE' }[];
  rules: CcPrRule[];
  comments: CcComment[];
}
export interface CcRepo {
  id: string;
  name: string;
  arn: string;
  region: string;
  description?: string;
  defaultBranch?: string;
  created: number;
  modified: number;
  branches: Record<string, string>;
  objs: GitObjects;
  prs: CcPr[];
  nextPr: number;
  tags: Tags;
}

// ---------------------------------------------------------------- CodeBuild

export interface CbEnvVar { name: string; value: string; type?: 'PLAINTEXT' | 'PARAMETER_STORE' | 'SECRETS_MANAGER' }
export interface CbProject {
  name: string;
  arn: string;
  region: string;
  description?: string;
  source: { type: 'CODECOMMIT' | 'CODEPIPELINE' | 'S3' | 'NO_SOURCE'; location?: string; buildspec?: string; gitCloneDepth?: number };
  sourceVersion?: string;
  artifacts: { type: 'NO_ARTIFACTS' | 'S3' | 'CODEPIPELINE'; location?: string; path?: string; name?: string; packaging?: string; namespaceType?: string };
  environment: { type: string; image: string; computeType: string; environmentVariables: CbEnvVar[]; privilegedMode: boolean; imagePullCredentialsType: string };
  serviceRole: string;
  timeoutInMinutes: number;
  queuedTimeoutInMinutes: number;
  logsConfig: { cloudWatchLogs: { status: 'ENABLED' | 'DISABLED'; groupName?: string; streamName?: string }; s3Logs: { status: 'ENABLED' | 'DISABLED' } };
  created: number;
  lastModified: number;
  tags: Tags;
}
export interface CbPhase { phaseType: string; phaseStatus?: string; startTime: number; endTime?: number; durationInSeconds?: number; contexts?: { statusCode: string; message: string }[] }
export interface CbBuild {
  id: string;
  arn: string;
  region: string;
  buildNumber: number;
  projectName: string;
  startTime: number;
  endTime?: number;
  sourceVersion?: string;
  resolvedSourceVersion?: string;
  phases: CbPhase[];
  initiator: string;
  logGroup?: string;
  logStream: string;
  serviceRole: string;
  /** Estado final decidido por la simulación; se publica cuando vence `completeAt`. */
  finalStatus: 'SUCCEEDED' | 'FAILED' | 'STOPPED' | 'TIMED_OUT' | 'FAULT';
  completeAt: number;
  buildStatus: 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'STOPPED' | 'TIMED_OUT' | 'FAULT';
  environment: CbProject['environment'];
  source: CbProject['source'];
  artifacts: { location?: string; md5sum?: string } | null;
  /** Instantáneas de las fases calculadas por la simulación (se revelan con el tiempo). */
  plan: CbPhase[];
  /** Líneas de registro previstas (se escriben en CloudWatch Logs según avanza el reloj). */
  logPlan: { ts: number; msg: string }[];
  logFlushed: number;
  /** Ficheros del artefacto producido (para la etapa siguiente de una canalización). */
  outFiles?: Record<string, string>;
  pipelineExecutionId?: string;
}

// ---------------------------------------------------------------- CodePipeline

export interface CpAction {
  name: string;
  actionTypeId: { category: string; owner: string; provider: string; version: string };
  runOrder?: number;
  configuration?: Record<string, string>;
  outputArtifacts?: { name: string }[];
  inputArtifacts?: { name: string }[];
  roleArn?: string;
  region?: string;
  namespace?: string;
}
export interface CpStage { name: string; actions: CpAction[] }
export interface CpPipeline {
  name: string;
  arn: string;
  region: string;
  roleArn: string;
  artifactStore: { type: 'S3'; location: string };
  stages: CpStage[];
  version: number;
  created: number;
  updated: number;
  /** Etapas con la transición de entrada desactivada: nombre -> motivo. */
  disabled: Record<string, { reason: string; by: string; at: number }>;
  pipelineType: 'V1' | 'V2';
}
export interface CpActionExec {
  name: string;
  status: 'InProgress' | 'Succeeded' | 'Failed' | 'Abandoned' | '';
  summary?: string;
  startTime?: number;
  endTime?: number;
  externalExecutionId?: string;
  externalExecutionUrl?: string;
  token?: string;
  errorDetails?: { code: string; message: string };
  /** Interno: instante (ms) en que se resuelve el trabajo externo. */
  waitFor?: string;
}
export interface CpStageExec { name: string; status: 'InProgress' | 'Succeeded' | 'Failed' | 'Stopped' | 'Stopping' | 'Cancelled' | ''; actions: CpActionExec[] }
export interface CpExecution {
  id: string;
  pipelineName: string;
  region: string;
  pipelineVersion: number;
  status: 'InProgress' | 'Stopping' | 'Stopped' | 'Succeeded' | 'Superseded' | 'Failed';
  statusSummary?: string;
  trigger: { triggerType: string; triggerDetail: string };
  start: number;
  last: number;
  stages: CpStageExec[];
  /** Artefactos de la ejecución: nombre -> contenido. */
  artifacts: Record<string, { files?: Record<string, string>; commitId?: string; repo?: string; branch?: string; s3Key?: string }>;
  sourceRevisions: { actionName: string; revisionId: string; revisionSummary: string; revisionUrl?: string }[];
}

// ---------------------------------------------------------------- CodeDeploy

export interface CdApp { id: string; name: string; region: string; created: number; computePlatform: 'Server'; tags: Tags }
export interface CdGroup {
  id: string;
  appName: string;
  name: string;
  region: string;
  configName: string;
  ec2TagFilters: { Key?: string; Value?: string; Type?: 'KEY_ONLY' | 'VALUE_ONLY' | 'KEY_AND_VALUE' }[];
  autoScalingGroups: string[];
  serviceRoleArn: string;
  created: number;
  autoRollback: boolean;
  lastSuccessfulDeployment?: string;
  lastAttemptedDeployment?: string;
}
export interface CdLifecycle { name: string; status: 'Succeeded' | 'Failed' | 'Skipped' | 'InProgress' | 'Pending'; start?: number; end?: number; diagnostics?: { errorCode: string; scriptName: string; message: string; logTail: string } }
export interface CdTarget { instanceId: string; status: 'Succeeded' | 'Failed' | 'Skipped' | 'InProgress' | 'Pending'; lifecycle: CdLifecycle[]; lastUpdated: number }
export interface CdDeployment {
  id: string;
  appName: string;
  groupName: string;
  region: string;
  configName: string;
  description?: string;
  creator: string;
  created: number;
  start: number;
  completeAt: number;
  finalStatus: 'Succeeded' | 'Failed' | 'Stopped';
  status: 'Created' | 'Queued' | 'InProgress' | 'Succeeded' | 'Failed' | 'Stopped';
  complete?: number;
  revision: { revisionType: 'S3'; s3Location: { bucket: string; key: string; bundleType: string } };
  error?: { code: string; message: string };
  targets: CdTarget[];
  pipelineExecutionId?: string;
}

export interface CicdState {
  repos: CcRepo[];
  ruleTemplates: CcRuleTemplate[];
  projects: CbProject[];
  builds: CbBuild[];
  buildSeq: Record<string, number>;
  pipelines: CpPipeline[];
  executions: CpExecution[];
  apps: CdApp[];
  groups: CdGroup[];
  deployments: CdDeployment[];
}

export function cicd(s: CloudState): CicdState {
  const a = s as CloudState & { cicd?: CicdState };
  a.cicd ??= { repos: [], ruleTemplates: [], projects: [], builds: [], buildSeq: {}, pipelines: [], executions: [], apps: [], groups: [], deployments: [] };
  return a.cicd;
}

/** Ganchos entre servicios sin dependencias circulares. */
export const cicdHooks: {
  repoUpdated: ((s: CloudState, repo: CcRepo, branch: string, actor: string) => void)[];
  /** Ejecuta un comando `aws` dentro de una compilación con el rol de servicio (lo registra la capa de shell). */
  runAws?: (s: CloudState, region: string, roleName: string, argv: string[], files: Record<string, string>) => { out: string; err: string; code: number };
} = { repoUpdated: [] };

// Modelo de datos de la nube simulada. Sigue la forma de las respuestas de la API de AWS.

export type Tags = Record<string, string>;

export interface Settings {
  speed: 'instant' | 'fast' | 'realistic';
  theme: 'light' | 'dark' | 'auto';
  freeMode: boolean;
  userDisplayName: string;
  onboarded: boolean;
}

// ---------------------------------------------------------------- IAM

export interface PolicyStatement {
  Sid?: string;
  Effect: 'Allow' | 'Deny';
  Action?: string | string[];
  NotAction?: string | string[];
  Resource?: string | string[];
  NotResource?: string | string[];
  Principal?: any;
  Condition?: Record<string, Record<string, string | string[]>>;
}

export interface PolicyDocument {
  Version?: string;
  Statement: PolicyStatement | PolicyStatement[];
}

export interface IamPolicy {
  arn: string;
  name: string;
  id: string;
  path: string;
  managed: 'aws' | 'customer';
  defaultVersion: string;
  document: PolicyDocument;
  attachmentCount: number;
  createdAt: string;
  description?: string;
  /** Versiones de la política (si falta, solo existe la predeterminada). */
  versions?: { id: string; document: PolicyDocument; createdAt: string }[];
}

export interface AccessKey {
  id: string;
  secret: string;
  status: 'Active' | 'Inactive';
  createdAt: string;
}

export interface IamUser {
  arn: string;
  name: string;
  id: string;
  path: string;
  createdAt: string;
  tags: Tags;
  /** Políticas gestionadas adjuntas (ARN). */
  attached: string[];
  /** Políticas en línea: nombre -> documento. */
  inline: Record<string, PolicyDocument>;
  accessKeys: AccessKey[];
  hasConsolePassword: boolean;
  mfaDevices: string[];
  permissionsBoundary?: string;
  loginProfile?: { createdAt: string; resetRequired: boolean };
}

export interface IamGroup {
  arn: string;
  name: string;
  id: string;
  path: string;
  createdAt: string;
  members: string[];
  attached: string[];
  inline: Record<string, PolicyDocument>;
}

export interface IamRole {
  arn: string;
  name: string;
  id: string;
  path: string;
  createdAt: string;
  description?: string;
  assumeRolePolicy: PolicyDocument;
  maxSessionDuration: number;
  attached: string[];
  inline: Record<string, PolicyDocument>;
  tags: Tags;
  permissionsBoundary?: string;
}

export interface InstanceProfile {
  arn: string;
  name: string;
  id: string;
  roles: string[];
  createdAt: string;
}

/** Credenciales temporales emitidas por STS. */
export interface Session {
  accessKeyId: string;
  secret: string;
  token: string;
  expiration: string;
  roleArn: string;
  sessionName: string;
  assumedRoleArn: string;
  mfa: boolean;
  /** Política de sesión opcional (intersecta con la del rol). */
  sessionPolicy?: PolicyDocument;
}

// ---------------------------------------------------------------- S3

export interface S3Object {
  key: string;
  body: string;
  size: number;
  etag: string;
  contentType: string;
  lastModified: string;
  storageClass: string;
  metadata: Record<string, string>;
  versionId?: string;
  tags: Tags;
  /** Cifrado del lado del servidor aplicado al subir el objeto. */
  sse?: { algorithm: 'AES256' | 'aws:kms'; kmsKeyId?: string };
}

export interface S3Bucket {
  name: string;
  region: string;
  createdAt: string;
  objects: Record<string, S3Object>;
  /** Versiones previas por clave (más antigua primero). */
  versions: Record<string, (S3Object & { deleteMarker?: boolean })[]>;
  versioning: 'Disabled' | 'Enabled' | 'Suspended';
  policy?: PolicyDocument;
  publicAccessBlock: {
    BlockPublicAcls: boolean;
    IgnorePublicAcls: boolean;
    BlockPublicPolicy: boolean;
    RestrictPublicBuckets: boolean;
  };
  encryption?: { algorithm: 'AES256' | 'aws:kms'; kmsKeyId?: string };
  website?: { indexDocument: string; errorDocument?: string };
  lifecycle: any[];
  cors?: any[];
  tags: Tags;
  acl: 'private' | 'public-read' | 'public-read-write' | 'authenticated-read';
  ownershipControls: 'BucketOwnerEnforced' | 'BucketOwnerPreferred' | 'ObjectWriter';
}

// ---------------------------------------------------------------- EC2 / VPC

export interface Vpc {
  id: string;
  cidr: string;
  region: string;
  state: 'available' | 'pending';
  isDefault: boolean;
  dnsSupport: boolean;
  dnsHostnames: boolean;
  tags: Tags;
  mainRouteTableId: string;
  defaultSecurityGroupId: string;
  defaultNetworkAclId: string;
}

export interface Subnet {
  id: string;
  vpcId: string;
  cidr: string;
  az: string;
  region: string;
  mapPublicIpOnLaunch: boolean;
  tags: Tags;
}

export interface InternetGateway {
  id: string;
  region: string;
  attachedVpcId?: string;
  tags: Tags;
}

export interface NatGateway {
  id: string;
  region: string;
  subnetId: string;
  allocationId: string;
  state: 'pending' | 'available' | 'deleted';
  createdAt: string;
  tags: Tags;
}

export interface Route {
  destination: string;
  target: string; // local | igw-xxx | nat-xxx | pcx-xxx
}

export interface RouteTable {
  id: string;
  vpcId: string;
  region: string;
  main: boolean;
  routes: Route[];
  associations: { id: string; subnetId?: string; main: boolean }[];
  tags: Tags;
}

export interface SgRule {
  id: string;
  protocol: string; // tcp | udp | icmp | -1
  from: number;
  to: number;
  cidr?: string;
  sourceSg?: string;
  description?: string;
}

export interface SecurityGroup {
  id: string;
  name: string;
  description: string;
  vpcId: string;
  region: string;
  ingress: SgRule[];
  egress: SgRule[];
  tags: Tags;
}

export interface NetworkAclEntry {
  rule: number;
  protocol: string;
  action: 'allow' | 'deny';
  egress: boolean;
  cidr: string;
  from?: number;
  to?: number;
}

export interface NetworkAcl {
  id: string;
  vpcId: string;
  region: string;
  isDefault: boolean;
  entries: NetworkAclEntry[];
  associations: string[];
  tags: Tags;
}

export interface ElasticIp {
  id: string;
  publicIp: string;
  region: string;
  associatedInstanceId?: string;
  associationId?: string;
  tags: Tags;
}

export interface KeyPair {
  id: string;
  name: string;
  region: string;
  fingerprint: string;
  createdAt: string;
}

export interface EbsVolume {
  id: string;
  region: string;
  az: string;
  sizeGiB: number;
  type: 'gp3' | 'gp2' | 'io1' | 'st1' | 'sc1';
  encrypted: boolean;
  state: 'creating' | 'available' | 'in-use';
  attachedTo?: string;
  device?: string;
  snapshotId?: string;
  deleteOnTermination: boolean;
  createdAt: string;
  tags: Tags;
}

export interface Snapshot {
  id: string;
  volumeId: string;
  region: string;
  sizeGiB: number;
  description: string;
  encrypted: boolean;
  startTime: string;
  tags: Tags;
}

export interface VirtualMfa {
  serial: string;
  name: string;
  user?: string;
  enabledAt?: string;
}

export interface PasswordPolicy {
  MinimumPasswordLength: number;
  RequireSymbols: boolean;
  RequireNumbers: boolean;
  RequireUppercaseCharacters: boolean;
  RequireLowercaseCharacters: boolean;
  AllowUsersToChangePassword: boolean;
  ExpirePasswords: boolean;
  MaxPasswordAge?: number;
  PasswordReusePrevention?: number;
  HardExpiry?: boolean;
}

export interface EventSelector {
  ReadWriteType: 'All' | 'ReadOnly' | 'WriteOnly';
  IncludeManagementEvents: boolean;
  DataResources: { Type: string; Values: string[] }[];
  ExcludeManagementEventSources: string[];
}

export interface Trail {
  name: string;
  arn: string;
  homeRegion: string;
  s3Bucket: string;
  s3Prefix?: string;
  multiRegion: boolean;
  includeGlobal: boolean;
  logValidation: boolean;
  kmsKeyId?: string;
  logging: boolean;
  startedAt?: string;
  stoppedAt?: string;
  lastDelivery?: string;
  selectors: EventSelector[];
  createdAt: string;
}

// ---------------------------------------------------------------- KMS y Secrets Manager

export interface KmsGrant {
  id: string;
  token: string;
  name?: string;
  granteePrincipal: string;
  retiringPrincipal?: string;
  operations: string[];
  createdAt: string;
}

export interface KmsKey {
  id: string;
  arn: string;
  region: string;
  description: string;
  manager: 'CUSTOMER' | 'AWS';
  /** Nombre del servicio para claves administradas por AWS (p. ej. aws/s3). */
  awsAlias?: string;
  state: 'Enabled' | 'Disabled' | 'PendingDeletion';
  usage: 'ENCRYPT_DECRYPT';
  spec: 'SYMMETRIC_DEFAULT';
  createdAt: string;
  policy: PolicyDocument;
  rotation: boolean;
  rotationDays: number;
  rotationEnabledAt?: string;
  deletionDate?: string;
  pendingWindowDays?: number;
  grants: KmsGrant[];
  tags: Tags;
  /** Material de la clave para el cifrado simulado (NO es criptografía real). */
  material: string;
}

export interface KmsAlias {
  name: string;
  keyId: string;
  region: string;
  createdAt: string;
  updatedAt: string;
}

export interface SecretVersion {
  id: string;
  stages: string[];
  /** Valor cifrado con KMS (blob del cifrado simulado). */
  ciphertext: string;
  binary: boolean;
  createdAt: string;
}

export interface Secret {
  name: string;
  arn: string;
  region: string;
  description?: string;
  kmsKeyId?: string;
  versions: SecretVersion[];
  createdAt: string;
  changedAt: string;
  accessedAt?: string;
  deletedAt?: string;
  rotation?: { enabled: boolean; lambdaArn?: string; days?: number; lastRotatedAt?: string; nextRotationAt?: string };
  resourcePolicy?: PolicyDocument;
  tags: Tags;
}

// ---------------------------------------------------------------- CloudWatch, Logs y SNS

export interface MetricPoint { ns: string; name: string; dims: Record<string, string>; ts: number; value: number; unit: string }
export interface AlarmHistoryItem { ts: string; type: 'StateUpdate' | 'ConfigurationUpdate' | 'Action'; summary: string; data?: string }
export interface CwAlarm {
  name: string; arn: string; region: string; description?: string;
  namespace: string; metric: string; dims: Record<string, string>; statistic: string; period: number; evalPeriods: number; datapointsToAlarm?: number;
  threshold: number; operator: string; treatMissing: 'missing' | 'notBreaching' | 'breaching' | 'ignore'; unit?: string;
  alarmActions: string[]; okActions: string[]; insufficientActions: string[]; actionsEnabled: boolean;
  state: 'OK' | 'ALARM' | 'INSUFFICIENT_DATA'; stateReason: string; stateUpdated: string; configUpdated: string;
  /** Hasta cuándo no se reevalúa tras un set-alarm-state (ms). */
  holdUntil?: number;
  history: AlarmHistoryItem[];
}
export interface LogEvent { ts: number; message: string; ingestion: number }
export interface LogStream { name: string; created: number; events: LogEvent[]; seq: number }
export interface MetricFilter { name: string; pattern: string; ns: string; metric: string; value: string; created: number }
export interface LogGroup { name: string; arn: string; region: string; created: number; retention?: number; kmsKeyId?: string; streams: LogStream[]; filters: MetricFilter[]; tags: Tags }
export interface SnsSub { arn: string; protocol: string; endpoint: string; confirmed: boolean }
export interface SnsMessage { id: string; ts: string; subject?: string; message: string; source: string }
export interface SnsTopic { name: string; arn: string; region: string; subs: SnsSub[]; messages: SnsMessage[]; displayName?: string }

// ---------------------------------------------------------------- Route 53, ELBv2 y Auto Scaling

export interface RecordSet {
  name: string;
  type: string;
  ttl?: number;
  values: string[];
  alias?: { zoneId: string; dnsName: string; evalHealth: boolean };
  setId?: string;
  weight?: number;
  failover?: 'PRIMARY' | 'SECONDARY';
  healthCheckId?: string;
}
export interface HostedZone { id: string; name: string; comment?: string; isPrivate: boolean; vpcs: { id: string; region: string }[]; callerRef: string; createdAt: string; records: RecordSet[]; nameServers: string[] }
export interface HealthCheck { id: string; callerRef: string; type: 'HTTP' | 'HTTPS' | 'TCP'; ip?: string; fqdn?: string; port: number; path?: string; interval: number; threshold: number }
export interface LoadBalancer { arn: string; name: string; dnsName: string; scheme: 'internet-facing' | 'internal'; vpcId: string; subnets: string[]; securityGroups: string[]; createdAt: string; region: string; zoneId: string; tags: Tags }
export interface TargetGroup {
  arn: string; name: string; protocol: string; port: number; vpcId: string; region: string; targetType: 'instance' | 'ip';
  hc: { protocol: string; port: string; path: string; interval: number; timeout: number; healthy: number; unhealthy: number; matcher: string };
  targets: { id: string; port: number; since: number }[];
  tags: Tags;
}
export interface Listener { arn: string; lbArn: string; port: number; protocol: string; tgArn: string }
export interface LaunchTemplate { id: string; name: string; region: string; imageId: string; instanceType: string; securityGroupIds: string[]; keyName?: string; userData?: string; createdAt: string; createdBy: string; version: number }
export interface Asg {
  name: string; arn: string; region: string; ltName: string; min: number; max: number; desired: number; subnets: string[]; tgArns: string[];
  healthCheckType: 'EC2' | 'ELB'; grace: number; createdAt: string; tags?: Tags; activities: { id: string; ts: string; cause: string; description: string; status: string }[];
}

export type InstanceState = 'pending' | 'running' | 'stopping' | 'stopped' | 'shutting-down' | 'terminated';

export interface Instance {
  id: string;
  region: string;
  az: string;
  type: string;
  imageId: string;
  state: InstanceState;
  subnetId: string;
  vpcId: string;
  securityGroupIds: string[];
  privateIp: string;
  publicIp?: string;
  keyName?: string;
  iamInstanceProfile?: string;
  userData?: string;
  rootVolumeId: string;
  /** IMDS: 1 = IMDSv2 requerido. */
  httpTokens: 'optional' | 'required';
  launchTime: string;
  /** Marca de tiempo (ms) de la última vez que empezó a correr, para el coste. */
  runningSince?: number;
  /** Milisegundos facturados acumulados en ejecuciones anteriores. */
  billedMs: number;
  /** Transición de estado pendiente (se resuelve al consultar). */
  transition?: { to: InstanceState; at: number };
  /** Intervalos (ms) en los que estuvo en ejecución, para las métricas de CloudWatch. */
  runPeriods?: { from: number; to: number }[];
  tags: Tags;
}

// ---------------------------------------------------------------- Registro y otros

export interface TrailEvent {
  id: string;
  time: string;
  eventName: string;
  eventSource: string;
  region: string;
  principalArn: string;
  userName: string;
  readOnly: boolean;
  errorCode?: string;
  errorMessage?: string;
  resources: { type: string; name: string }[];
  sourceIp: string;
  requestParameters?: any;
}

export interface CommandLogEntry {
  ts: number;
  cmd: string;
  ok: boolean;
  source: 'shell' | 'typed' | 'console' | 'pipeline' | 'vm';
}

export interface VfsNode {
  type: 'file' | 'dir';
  content?: string;
  mode?: number;
  children?: Record<string, VfsNode>;
}

export interface CliState {
  /** Perfil activo: nombre -> credenciales y región. */
  profiles: Record<string, { accessKeyId?: string; secret?: string; token?: string; region?: string; output?: string; roleArn?: string; sourceProfile?: string; mfaSerial?: string }>;
  activeProfile: string;
  env: Record<string, string>;
  cwd: string;
  history: string[];
  commandLog: CommandLogEntry[];
}

export interface CloudState {
  schema: number;
  createdAt: string;
  settings: Settings;
  account: { id: string; alias?: string; rootEmail: string };
  region: string;
  /** Principal con el que opera la consola web. */
  me: { arn: string; userName: string };
  users: IamUser[];
  groups: IamGroup[];
  roles: IamRole[];
  instanceProfiles: InstanceProfile[];
  policies: IamPolicy[];
  sessions: Session[];
  buckets: S3Bucket[];
  vpcs: Vpc[];
  subnets: Subnet[];
  internetGateways: InternetGateway[];
  natGateways: NatGateway[];
  routeTables: RouteTable[];
  securityGroups: SecurityGroup[];
  networkAcls: NetworkAcl[];
  elasticIps: ElasticIp[];
  keyPairs: KeyPair[];
  volumes: EbsVolume[];
  instances: Instance[];
  snapshots: Snapshot[];
  virtualMfa: VirtualMfa[];
  passwordPolicy?: PasswordPolicy;
  trails: Trail[];
  kmsKeys: KmsKey[];
  kmsAliases: KmsAlias[];
  secrets: Secret[];
  metricData: MetricPoint[];
  alarms: CwAlarm[];
  logGroups: LogGroup[];
  topics: SnsTopic[];
  zones: HostedZone[];
  healthChecks: HealthCheck[];
  loadBalancers: LoadBalancer[];
  targetGroups: TargetGroup[];
  listeners: Listener[];
  launchTemplates: LaunchTemplate[];
  asgs: Asg[];
  /** CloudFormation: pilas, conjuntos de cambios y desfase del reloj de las esperas (`wait`). */
  cfn: import('./services/cloudformation').CfnState;
  /** Git y CI/CD (CodeCommit, CodeBuild, CodePipeline, CodeDeploy); se crea al primer uso. */
  cicd?: import('./services/cicdTypes').CicdState;
  /** Contenedores (ECR, ECS, EKS, Docker): se crea de forma perezosa con cs(s). */
  containers?: import('./services/containerCore').ContainersState;
  /** Gobernanza y costes (Organizations, Config, Budgets, Cost Explorer, Trusted Advisor); se crea al primer uso. */
  gov?: import('./services/govTypes').GovState;
  trail: TrailEvent[];
  cli: CliState;
  fs: VfsNode;
  recent: string[];
}

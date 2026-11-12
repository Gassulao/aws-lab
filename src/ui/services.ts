// Catálogo de servicios de la consola y su menú lateral.
export type NavItem = { label: string; to: string; also?: string[] } | { group: string } | { sep: true };

export interface Svc {
  id: string;
  name: string;
  short: string;
  color: string;
  desc: string;
  home: string;
  cat: string;
  /** Prefijos de ruta adicionales que pertenecen a este servicio y a qué elemento del menú corresponden. */
  nav: NavItem[];
}

export const CATEGORIES = ['Computación', 'Almacenamiento', 'Bases de datos', 'Redes y entrega de contenido', 'Seguridad, identidad y conformidad', 'Administración y gobernanza', 'Integración de aplicaciones', 'Herramientas para desarrolladores', 'Aprendizaje'];

export const SERVICES: Svc[] = [
  {
    id: 'devtools', name: 'Developer Tools', short: 'DT', color: '#c925d1', desc: 'CodeCommit, CodeBuild, CodePipeline y CodeDeploy', home: '/devtools/repos', cat: 'Herramientas para desarrolladores',
    nav: [{ label: 'Repositorios', to: '/devtools/repos', also: ['/devtools/repo/'] }, { label: 'Compilaciones', to: '/devtools/builds', also: ['/devtools/build/'] }, { label: 'Canalizaciones', to: '/devtools/pipelines', also: ['/devtools/pipeline/'] }, { label: 'Implementaciones', to: '/devtools/deployments' }],
  },
  {
    id: 'ec2', name: 'EC2', short: 'EC2', color: '#ed7100', desc: 'Servidores virtuales en la nube', home: '/ec2/instances', cat: 'Computación',
    nav: [
      { label: 'Panel', to: '/ec2' }, { sep: true }, { group: 'Instancias' }, { label: 'Instancias', to: '/ec2/instances', also: ['/ec2/instance/', '/ec2/launch'] },
      { sep: true }, { label: 'Plantillas de lanzamiento', to: '/ec2/lts' },
      { sep: true }, { group: 'Red y seguridad' }, { label: 'Grupos de seguridad', to: '/ec2/sg' }, { label: 'Pares de claves', to: '/ec2/keys' },
      { sep: true }, { group: 'Balanceo de carga' }, { label: 'Balanceadores de carga', to: '/ec2/lbs', also: ['/ec2/lb/'] }, { label: 'Grupos de destino', to: '/ec2/tgs', also: ['/ec2/tg/'] },
      { sep: true }, { group: 'Auto Scaling' }, { label: 'Grupos de Auto Scaling', to: '/ec2/asgs', also: ['/ec2/asg/'] },
    ],
  },
  {
    id: 'ecr', name: 'ECR', short: 'ECR', color: '#ed7100', desc: 'Registro de imágenes de contenedor', home: '/ecr/repos', cat: 'Computación',
    nav: [{ label: 'Repositorios privados', to: '/ecr/repos', also: ['/ecr/repo/'] }],
  },
  {
    id: 'ecs', name: 'ECS', short: 'ECS', color: '#ed7100', desc: 'Contenedores con Fargate', home: '/ecs/clusters', cat: 'Computación',
    nav: [{ label: 'Clústeres', to: '/ecs/clusters', also: ['/ecs/cluster/'] }],
  },
  {
    id: 'eks', name: 'EKS', short: 'EKS', color: '#ed7100', desc: 'Kubernetes administrado', home: '/eks/clusters', cat: 'Computación',
    nav: [{ label: 'Clústeres', to: '/eks/clusters', also: ['/eks/cluster/'] }],
  },
  {
    id: 'iam', name: 'IAM', short: 'IAM', color: '#dd344c', desc: 'Gestión de acceso y permisos', home: '/iam/users', cat: 'Seguridad, identidad y conformidad',
    nav: [
      { label: 'Panel', to: '/iam' }, { sep: true }, { group: 'Administración de acceso' }, { label: 'Grupos de usuarios', to: '/iam/groups' },
      { label: 'Usuarios', to: '/iam/users' }, { label: 'Roles', to: '/iam/roles' }, { label: 'Políticas', to: '/iam/policies' },
    ],
  },
  {
    id: 's3', name: 'S3', short: 'S3', color: '#3f8624', desc: 'Almacenamiento escalable en la nube', home: '/s3/buckets', cat: 'Almacenamiento',
    nav: [{ label: 'Buckets de uso general', to: '/s3/buckets', also: ['/s3/bucket/', '/s3/create'] }],
  },
  {
    id: 'vpc', name: 'VPC', short: 'VPC', color: '#8c4fff', desc: 'Redes virtuales aisladas', home: '/vpc/vpcs', cat: 'Redes y entrega de contenido',
    nav: [{ label: 'Sus VPC', to: '/vpc/vpcs' }, { label: 'Subredes', to: '/vpc/subnets' }, { label: 'Tablas de enrutamiento', to: '/vpc/routes' }, { label: 'Gateways de internet', to: '/vpc/igw' }, { label: 'Gateways NAT', to: '/vpc/nat' }, { label: 'Direcciones IP elásticas', to: '/vpc/eip' }, { label: 'Grupos de seguridad', to: '/vpc/sg' }],
  },
  {
    id: 'kms', name: 'KMS', short: 'KMS', color: '#dd344c', desc: 'Administración de claves de cifrado', home: '/kms/keys', cat: 'Seguridad, identidad y conformidad',
    nav: [{ label: 'Claves administradas por AWS', to: '/kms/aws-keys' }, { label: 'Claves administradas por el cliente', to: '/kms/keys', also: ['/kms/key/', '/kms/create'] }],
  },
  {
    id: 'cloudwatch', name: 'CloudWatch', short: 'CW', color: '#e7157b', desc: 'Monitoreo de recursos y aplicaciones', home: '/cloudwatch/alarms', cat: 'Administración y gobernanza',
    nav: [{ label: 'Alarmas', to: '/cloudwatch/alarms', also: ['/cloudwatch/alarm/', '/cloudwatch/alarm-create'] }, { label: 'Grupos de registros', to: '/cloudwatch/logs', also: ['/cloudwatch/log-group/'] }, { label: 'Métricas', to: '/cloudwatch/metrics' }],
  },
  {
    id: 'organizations', name: 'Organizations', short: 'ORG', color: '#e7157b', desc: 'Cuentas múltiples, unidades organizativas y SCP', home: '/organizations/accounts', cat: 'Administración y gobernanza',
    nav: [{ label: 'Cuentas y OU', to: '/organizations/accounts' }, { label: 'Políticas de control de servicios', to: '/organizations/policies', also: ['/organizations/policy/'] }],
  },
  {
    id: 'config', name: 'Config', short: 'CFG', color: '#e7157b', desc: 'Conformidad y registro de configuración', home: '/config/dashboard', cat: 'Administración y gobernanza',
    nav: [{ label: 'Panel', to: '/config/dashboard' }, { label: 'Reglas', to: '/config/rules', also: ['/config/rule/'] }, { label: 'Recursos', to: '/config/resources' }, { label: 'Configuración', to: '/config/settings' }],
  },
  {
    id: 'billing', name: 'Billing y Cost Explorer', short: '$', color: '#e7157b', desc: 'Costos, Cost Explorer y presupuestos', home: '/billing', cat: 'Administración y gobernanza',
    nav: [{ label: 'Panel de facturación', to: '/billing' }, { label: 'Cost Explorer', to: '/billing/cost-explorer' }, { label: 'Presupuestos', to: '/billing/budgets', also: ['/billing/budget/'] }],
  },
  {
    id: 'trustedadvisor', name: 'Trusted Advisor', short: 'TA', color: '#e7157b', desc: 'Recomendaciones de buenas prácticas y AWS Health', home: '/trustedadvisor', cat: 'Administración y gobernanza',
    nav: [{ label: 'Recomendaciones', to: '/trustedadvisor' }, { label: 'Comprobaciones', to: '/trustedadvisor/checks' }, { label: 'AWS Health', to: '/trustedadvisor/health' }],
  },
  {
    id: 'route53', name: 'Route 53', short: 'R53', color: '#8c4fff', desc: 'DNS y comprobaciones de estado', home: '/route53/zones', cat: 'Redes y entrega de contenido',
    nav: [{ label: 'Zonas alojadas', to: '/route53/zones', also: ['/route53/zone/'] }, { label: 'Comprobaciones de estado', to: '/route53/health' }],
  },
  {
    id: 'sns', name: 'SNS', short: 'SNS', color: '#e7157b', desc: 'Notificaciones y mensajería pub/sub', home: '/sns/topics', cat: 'Integración de aplicaciones',
    nav: [{ label: 'Temas', to: '/sns/topics', also: ['/sns/topic/'] }],
  },
  {
    id: 'secretsmanager', name: 'Secrets Manager', short: 'SM', color: '#dd344c', desc: 'Almacene y rote secretos de forma segura', home: '/secretsmanager/secrets', cat: 'Seguridad, identidad y conformidad',
    nav: [{ label: 'Secretos', to: '/secretsmanager/secrets', also: ['/secretsmanager/secret/', '/secretsmanager/create'] }],
  },
  {
    id: 'cloudformation', name: 'CloudFormation', short: 'CF', color: '#e7157b', desc: 'Infraestructura como código con plantillas', home: '/cloudformation/stacks', cat: 'Administración y gobernanza',
    nav: [{ label: 'Pilas', to: '/cloudformation/stacks', also: ['/cloudformation/stack/', '/cloudformation/create'] }],
  },
  {
    id: 'cloudtrail', name: 'CloudTrail', short: 'CT', color: '#e7157b', desc: 'Registro de actividad de la cuenta', home: '/cloudtrail/events', cat: 'Administración y gobernanza',
    nav: [{ label: 'Historial de eventos', to: '/cloudtrail/events' }, { label: 'Sendas', to: '/cloudtrail/trails', also: ['/cloudtrail/trail/'] }],
  },
  {
    id: 'lambda', name: 'Lambda', short: 'λ', color: '#ed7100', desc: 'Ejecute código sin administrar servidores', home: '/lambda/functions', cat: 'Computación',
    nav: [{ label: 'Funciones', to: '/lambda/functions', also: ['/lambda/function/', '/lambda/create'] }],
  },
  {
    id: 'apigateway', name: 'API Gateway', short: 'APIG', color: '#e7157b', desc: 'Cree, publique y proteja API REST y HTTP', home: '/apigateway/apis', cat: 'Integración de aplicaciones',
    nav: [{ label: 'API', to: '/apigateway/apis', also: ['/apigateway/api/'] }],
  },
  {
    id: 'sqs', name: 'SQS', short: 'SQS', color: '#e7157b', desc: 'Colas de mensajes totalmente administradas', home: '/sqs/queues', cat: 'Integración de aplicaciones',
    nav: [{ label: 'Colas', to: '/sqs/queues', also: ['/sqs/queue/'] }],
  },
  {
    id: 'dynamodb', name: 'DynamoDB', short: 'DDB', color: '#3b48cc', desc: 'Base de datos NoSQL clave-valor sin servidor', home: '/dynamodb/tables', cat: 'Bases de datos',
    nav: [{ label: 'Tablas', to: '/dynamodb/tables', also: ['/dynamodb/table/'] }],
  },
  {
    id: 'rds', name: 'RDS', short: 'RDS', color: '#3b48cc', desc: 'Bases de datos relacionales administradas', home: '/rds/databases', cat: 'Bases de datos',
    nav: [{ label: 'Bases de datos', to: '/rds/databases', also: ['/rds/database/', '/rds/create'] }, { label: 'Instantáneas', to: '/rds/snapshots' }, { label: 'Grupos de subredes', to: '/rds/subnetgroups' }],
  },
  {
    id: 'academy', name: 'Academia', short: 'AC', color: '#0972d3', desc: 'Laboratorios guiados por niveles', home: '/academy', cat: 'Aprendizaje',
    nav: [{ label: 'Niveles', to: '/academy', also: ['/academy/'] }],
  },
];

export const svcOf = (path: string) => SERVICES.find((s) => path === '/' + s.id || path.startsWith('/' + s.id + '/'));

const links = (svc: Svc) => svc.nav.filter((n): n is { label: string; to: string; also?: string[] } => 'to' in n);

/** ¿Es la ruta del elemento de menú `n`? Solo el panel (/svc) exige coincidencia exacta. */
export function isActive(path: string, svc: Svc, n: { to: string; also?: string[] }): boolean {
  if (path === n.to) return true;
  if ((n.also ?? []).some((a) => (a.endsWith('/') ? path.startsWith(a) : path === a || path.startsWith(a + '/')))) return true;
  if (n.to === '/' + svc.id) return false;
  return path.startsWith(n.to + '/');
}

/** ¿Pertenece la ruta a alguna página conocida de la consola? */
export function isKnownRoute(path: string): boolean {
  if (path === '/' || path === '') return true;
  if (path === '/cloudshell' || path.startsWith('/cloudshell/')) return true;
  const svc = svcOf(path);
  if (!svc) return false;
  if (path === '/' + svc.id) return true;
  if (svc.id === 'academy' && path.startsWith('/academy/')) return true;
  return links(svc).some((n) => isActive(path, svc, n));
}

/** Entradas del buscador: servicios y sus secciones. */
export interface SearchEntry { key: string; title: string; parent?: string; desc: string; to: string; color: string; short: string }
export function searchIndex(): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const s of SERVICES) {
    out.push({ key: s.id, title: s.name, desc: s.desc, to: s.home, color: s.color, short: s.short });
    for (const n of links(s)) if (n.to !== s.home && n.to !== '/' + s.id) out.push({ key: n.to, title: n.label, parent: s.name, desc: s.desc, to: n.to, color: s.color, short: s.short });
  }
  out.push({ key: 'cloudshell', title: 'CloudShell', desc: 'Terminal de línea de comandos en el navegador', to: '/cloudshell', color: '#232f3e', short: '>_' });
  return out;
}

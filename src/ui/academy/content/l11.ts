import { SAA_DOMAINS, type Level } from '../types';
import { prep } from '../setup';
import type { CheckCtx } from '../checks';
import { settle } from '../../../engine/services/ec2';
import { settleEcr } from '../../../engine/services/ecr';
import { settleEcs } from '../../../engine/services/ecs';
import { settleEks } from '../../../engine/services/eks';
import { cs } from '../../../engine/services/containerCore';
import * as K from '../../../engine/kube';
import imagenes from './l11/1-imagenes-ecr.md?raw';
import ecs from './l11/2-ecs-fargate.md?raw';
import eks from './l11/3-eks-kubernetes.md?raw';
import kubectl from './l11/4-kubectl-diagnostico.md?raw';

/** Estado de contenedores con los ciclos de vida de ECR, ECS y EKS ya aplicados al reloj actual. */
const C = (c: CheckCtx) => {
  settle(c.s); settleEcr(c.s); settleEcs(c.s); settleEks(c.s);
  return cs(c.s);
};
const repo = (c: CheckCtx, name: string) => C(c).ecr.find((r) => r.name === name);
const cluster = (c: CheckCtx, name: string) => C(c).eks.find((x) => x.name === name);
const svc = (c: CheckCtx, cl: string, name: string) => C(c).ecsServices.find((x) => x.clusterName === cl && x.name === name && x.status !== 'INACTIVE');
const running = (c: CheckCtx, cl: string, name: string) => C(c).ecsTasks.filter((t) => t.clusterName === cl && t.serviceName === name && t.lastStatus === 'RUNNING').length;
const dep = (c: CheckCtx, cl: string, name: string, ns = 'default') => { const k = cluster(c, cl); if (!k) return undefined; K.reconcile(c.s, k); const d = K.find(k, 'Deployment', ns, name); return d ? { d, k, st: K.depStatus(k, d) } : undefined; };

const Q = (s: string) => `'${s}'`;
const ACC = 'ACC=$(aws sts get-caller-identity --query Account --output text)';
const REG = 'REG=$ACC.dkr.ecr.eu-west-1.amazonaws.com';
const LOGIN = 'aws ecr get-login-password | docker login --username AWS --password-stdin $REG';
const trust = (svcName: string) => `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"${svcName}"},"Action":"sts:AssumeRole"}]}`;
const pol = (n: string) => `arn:aws:iam::aws:policy/${n}`;
const execRole = [
  `printf '${trust('ecs-tasks.amazonaws.com')}' > ~/confianza-ecs.json`,
  'aws iam create-role --role-name ecsTaskExecutionRole --assume-role-policy-document file://confianza-ecs.json',
  `aws iam attach-role-policy --role-name ecsTaskExecutionRole --policy-arn ${pol('service-role/AmazonECSTaskExecutionRolePolicy')}`,
];
const eksRoles = [
  `printf '${trust('eks.amazonaws.com')}' > ~/confianza-eks.json`,
  `printf '${trust('ec2.amazonaws.com')}' > ~/confianza-ec2.json`,
  'aws iam create-role --role-name eks-cluster-role --assume-role-policy-document file://confianza-eks.json',
  `aws iam attach-role-policy --role-name eks-cluster-role --policy-arn ${pol('AmazonEKSClusterPolicy')}`,
  'aws iam create-role --role-name eks-nodos-role --assume-role-policy-document file://confianza-ec2.json',
  ...['AmazonEKSWorkerNodePolicy', 'AmazonEKS_CNI_Policy', 'AmazonEC2ContainerRegistryReadOnly'].map((p) => `aws iam attach-role-policy --role-name eks-nodos-role --policy-arn ${pol(p)}`),
];
/** Subredes de la VPC predeterminada (S1, S2) y su grupo de seguridad (SG). */
const net = [
  'VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query Vpcs[0].VpcId --output text)',
  `S1=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC --query ${Q('Subnets[0].SubnetId')} --output text)`,
  `S2=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC --query ${Q('Subnets[1].SubnetId')} --output text)`,
];
const eksCreate = (name: string, nodes: number): string[] => [
  ACC, ...net,
  `aws eks create-cluster --name ${name} --role-arn arn:aws:iam::$ACC:role/eks-cluster-role --resources-vpc-config subnetIds=$S1,$S2`,
  `aws eks wait cluster-active --name ${name}`,
  `aws eks create-nodegroup --cluster-name ${name} --nodegroup-name ng --node-role arn:aws:iam::$ACC:role/eks-nodos-role --subnets $S1 $S2 --scaling-config minSize=1,maxSize=4,desiredSize=${nodes} --instance-types t3.medium`,
  `aws eks wait nodegroup-active --cluster-name ${name} --nodegroup-name ng`,
  `aws eks update-kubeconfig --name ${name}`,
];
const taskFile = (image: string) => `printf '{"family":"web","networkMode":"awsvpc","requiresCompatibilities":["FARGATE"],"cpu":"256","memory":"512","executionRoleArn":"arn:aws:iam::'$ACC':role/ecsTaskExecutionRole","containerDefinitions":[{"name":"web","image":"${image.replace(/\$(ACC|REG)/g, "'$$$1'")}","essential":true,"portMappings":[{"containerPort":80}]}]}' > ~/tarea.json`;

// --- Laboratorio 1: tu primera imagen en ECR
const E1 = [
  'mkdir -p api',
  `printf 'FROM node:20-alpine\\nWORKDIR /app\\nCOPY . .\\nEXPOSE 8080\\nCMD ["node","server.js"]\\n' > api/Dockerfile`,
  `echo 'console.log("api lista")' > api/server.js`,
  'cd api',
  'docker build -t tienda/api:1.0 .',
  'aws ecr create-repository --repository-name tienda/api --image-scanning-configuration scanOnPush=true',
  ACC, REG, LOGIN,
  'docker tag tienda/api:1.0 $REG/tienda/api:1.0',
  'docker push $REG/tienda/api:1.0',
  'cd ~',
];

// --- Laboratorio 2: ciclo de vida, inmutabilidad y análisis
const VERS: [string, string][] = [['1.0', '1.25'], ['1.1', '1.26'], ['1.2', '1.27'], ['1.3', '1.28'], ['1.4', '1.29']];
const E2_SETUP = [
  ACC, REG, 'aws ecr create-repository --repository-name tienda/web', LOGIN,
  ...VERS.flatMap(([v, n]) => [`docker pull nginx:${n}`, `docker tag nginx:${n} $REG/tienda/web:${v}`, `docker push $REG/tienda/web:${v}`]),
];
const E2 = [
  ACC, REG,
  `printf '{"rules":[{"rulePriority":1,"description":"Conservar solo las 2 ultimas","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":2},"action":{"type":"expire"}}]}' > ~/politica.json`,
  'aws ecr put-lifecycle-policy --repository-name tienda/web --lifecycle-policy-text file://politica.json',
  'aws ecr put-image-tag-mutability --repository-name tienda/web --image-tag-mutability IMMUTABLE',
  'docker pull alpine:3.20',
  'docker tag alpine:3.20 $REG/tienda/web:1.4',
  'docker push $REG/tienda/web:1.4 || true',
  'aws ecr start-image-scan --repository-name tienda/web --image-id imageTag=1.4',
  'aws ecr describe-image-scan-findings --repository-name tienda/web --image-id imageTag=1.4 --query imageScanFindings.findingSeverityCounts > ~/hallazgos.txt',
];

// --- Laboratorio 3: Fargate detrás de un ALB
const E3_SETUP = [...execRole];
const E3 = [
  ACC, ...net,
  taskFile('public.ecr.aws/nginx/nginx:1.27'),
  'aws ecs create-cluster --cluster-name tienda',
  'aws ecs register-task-definition --cli-input-json file://tarea.json',
  'SG=$(aws ec2 create-security-group --group-name tienda-web --description tienda-web --vpc-id $VPC --query GroupId --output text)',
  'aws ec2 authorize-security-group-ingress --group-id $SG --protocol tcp --port 80 --cidr 0.0.0.0/0',
  'aws elbv2 create-target-group --name tienda-tg --protocol HTTP --port 80 --vpc-id $VPC --target-type ip',
  `TG=$(aws elbv2 describe-target-groups --names tienda-tg --query ${Q('TargetGroups[0].TargetGroupArn')} --output text)`,
  'aws elbv2 create-load-balancer --name tienda-alb --subnets $S1 $S2 --security-groups $SG',
  `LB=$(aws elbv2 describe-load-balancers --names tienda-alb --query ${Q('LoadBalancers[0].LoadBalancerArn')} --output text)`,
  'aws elbv2 create-listener --load-balancer-arn $LB --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=$TG',
  'aws ecs create-service --cluster tienda --service-name web --task-definition web --desired-count 2 --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[$S1,$S2],securityGroups=[$SG],assignPublicIp=ENABLED}" --load-balancers targetGroupArn=$TG,containerName=web,containerPort=80',
  'aws ecs wait services-stable --cluster tienda --services web',
  `DNS=$(aws elbv2 describe-load-balancers --names tienda-alb --query ${Q('LoadBalancers[0].DNSName')} --output text)`,
  'curl -s http://$DNS > ~/respuesta.html',
];

// --- Laboratorio 4: una tarea de Fargate que no arranca
const E4_SETUP = [
  ...execRole, ACC, REG, ...net,
  'aws ecr create-repository --repository-name tienda/web', LOGIN, 'docker pull nginx:1.25',
  'docker tag nginx:1.25 $REG/tienda/web:1.0', 'docker push $REG/tienda/web:1.0',
  taskFile('$ACC.dkr.ecr.eu-west-1.amazonaws.com/tienda/web:2.0'),
  'aws ecs create-cluster --cluster-name tienda',
  'aws ecs register-task-definition --cli-input-json file://tarea.json',
  'aws ecs create-service --cluster tienda --service-name web --task-definition web --desired-count 1 --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[$S1,$S2],assignPublicIp=ENABLED}"',
  'rm tarea.json',
];
const E4 = [
  ACC, REG,
  'aws ecs describe-services --cluster tienda --services web --query "services[0].events[0].message"',
  'T=$(aws ecs list-tasks --cluster tienda --desired-status STOPPED --query "taskArns[0]" --output text)',
  'aws ecs describe-tasks --cluster tienda --tasks $T --query "tasks[0].containers[0].reason" --output text > ~/causa.txt',
  'aws ecr list-images --repository-name tienda/web --query "imageIds[].imageTag"',
  taskFile('$REG/tienda/web:1.0'),
  'aws ecs register-task-definition --cli-input-json file://tarea.json',
  'aws ecs update-service --cluster tienda --service web --task-definition web',
  'aws ecs wait services-stable --cluster tienda --services web',
];

// --- Laboratorio 5: tu primer clúster de EKS
const E5_SETUP = [...eksRoles];
const E5 = [...eksCreate('dev', 2), 'kubectl get nodes > ~/nodos.txt', 'cat ~/nodos.txt'];

// --- Laboratorio 6: despliegue, actualización fallida y vuelta atrás
const WEB_YAML = 'apiVersion: apps/v1\\nkind: Deployment\\nmetadata:\\n  name: web\\nspec:\\n  replicas: 3\\n  selector:\\n    matchLabels:\\n      app: web\\n  template:\\n    metadata:\\n      labels:\\n        app: web\\n    spec:\\n      containers:\\n      - name: nginx\\n        image: nginx:1.25\\n        ports:\\n        - containerPort: 80\\n---\\napiVersion: v1\\nkind: Service\\nmetadata:\\n  name: web\\nspec:\\n  type: LoadBalancer\\n  selector:\\n    app: web\\n  ports:\\n  - port: 80\\n    targetPort: 80\\n';
const E6_SETUP = [...eksRoles, ...eksCreate('dev', 2)];
const E6 = [
  `printf '${WEB_YAML}' > ~/web.yaml`,
  'kubectl apply -f ~/web.yaml',
  'kubectl rollout status deployment/web',
  'kubectl set image deployment/web nginx=nginx:1.99',
  'kubectl rollout status deployment/web --timeout=5s || true',
  'kubectl get pods > ~/pods-rotos.txt',
  'kubectl rollout undo deployment/web',
  'kubectl rollout status deployment/web',
  'kubectl scale deployment web --replicas=4',
  'kubectl rollout status deployment/web',
  'kubectl get svc web > ~/servicio.txt',
];

// --- Laboratorio 7: pods que no arrancan por configuración
const API_YAML = 'apiVersion: apps/v1\\nkind: Deployment\\nmetadata:\\n  name: api\\nspec:\\n  replicas: 2\\n  selector:\\n    matchLabels:\\n      app: api\\n  template:\\n    metadata:\\n      labels:\\n        app: api\\n    spec:\\n      containers:\\n      - name: api\\n        image: nginx:1.25\\n        envFrom:\\n        - configMapRef:\\n            name: api-config\\n';
const E7_SETUP = [...eksRoles, ...eksCreate('dev', 2), `printf '${API_YAML}' > ~/api.yaml`, 'kubectl apply -f ~/api.yaml'];
const E7 = [
  'kubectl get pods',
  'POD=$(kubectl get pods -o name | head -n 1)',
  'kubectl describe $POD > ~/diagnostico.txt',
  'kubectl create configmap api-config --from-literal=MODO=produccion',
  'kubectl rollout restart deployment/api',
  'kubectl rollout status deployment/api',
  'kubectl get pods',
];

export const l11: Level = {
  id: 11,
  slug: 'contenedores',
  title: 'Contenedores: ECR, ECS y EKS',
  subtitle: 'Construye imágenes, guárdalas en ECR y ejecútalas en Fargate o en Kubernetes administrado.',
  skills: ['Docker y Dockerfile', 'ECR: etiquetas, análisis y ciclo de vida', 'ECS y Fargate', 'ALB con destinos IP', 'EKS y nodegroups', 'kubectl y diagnóstico de pods'],
  lessons: [
    { id: 'l11-imagenes', title: 'Imágenes y Amazon ECR', minutes: 9, body: imagenes },
    { id: 'l11-ecs', title: 'Amazon ECS con Fargate', minutes: 10, body: ecs },
    { id: 'l11-eks', title: 'Amazon EKS y Kubernetes', minutes: 10, body: eks },
    { id: 'l11-kubectl', title: 'kubectl y diagnóstico', minutes: 8, body: kubectl },
  ],
  exercises: [
    {
      id: 'l11-e1',
      title: 'Tu primera imagen en ECR',
      summary: 'Construye una imagen desde un Dockerfile, crea el repositorio y súbela.',
      difficulty: 'Fácil',
      minutes: 14,
      saa: [SAA_DOMAINS[2], SAA_DOMAINS[1]],
      tags: ['ECR', 'Docker', 'IAM'],
      scenario: 'El equipo de la tienda quiere guardar su API en un registro privado. En `~/api` escribe un `Dockerfile` (base `node:20-alpine`, que exponga el puerto 8080), construye la imagen `tienda/api:1.0`, crea el repositorio ECR `tienda/api` con análisis al enviar activado, autentica Docker y sube la imagen con la etiqueta `1.0`.',
      steps: [
        { id: 'build', title: 'Escribe `~/api/Dockerfile` y construye la imagen local `tienda/api:1.0`', hint: ['Un Dockerfile necesita al menos FROM; añade EXPOSE 8080.', 'docker build -t tienda/api:1.0 . (desde ~/api)', 'docker images lista las imágenes locales.'], check: (c) => { const f = c.file('api/Dockerfile') ?? ''; if (!/^FROM\s+node/m.test(f) || !/EXPOSE\s+8080/.test(f)) return 'Falta ~/api/Dockerfile con FROM node... y EXPOSE 8080.'; return C(c).docker.images.some((i) => i.refs.some((r) => r.includes('tienda/api:1.0'))) || 'Aún no existe la imagen local tienda/api:1.0: ejecuta docker build.'; } },
        { id: 'repo', title: 'Crea el repositorio ECR `tienda/api` con `scanOnPush=true`', hint: ['aws ecr create-repository --repository-name tienda/api', 'El análisis se activa con --image-scanning-configuration scanOnPush=true.'], check: (c) => { const r = repo(c, 'tienda/api'); if (!r) return 'No existe el repositorio tienda/api.'; return r.scanOnPush || 'El repositorio existe pero sin análisis al enviar (scanOnPush).'; } },
        { id: 'push', title: 'Autentica Docker contra ECR, etiqueta la imagen con la URI del repositorio y súbela como `1.0`', hint: ['aws ecr get-login-password | docker login --username AWS --password-stdin <cuenta>.dkr.ecr.eu-west-1.amazonaws.com', 'docker tag tienda/api:1.0 <uri-del-repositorio>:1.0', 'docker push <uri-del-repositorio>:1.0'], check: (c) => { const r = repo(c, 'tienda/api'); if (!r) return 'Primero crea el repositorio.'; return r.images.some((i) => i.tags.includes('1.0')) || 'El repositorio está vacío: falta el docker push de la etiqueta 1.0.'; } },
      ],
      script: E1,
      realWorld: 'En tu cuenta real necesitas Docker instalado (o CloudShell, que ya lo trae) y permisos `ecr:*` sobre el repositorio. El almacenamiento cuesta unos 0,10 USD por GB al mes y el análisis básico es gratuito. Usa siempre etiquetas con versión y no solo `latest`. Los CVE de este simulador son ficticios (`CVE-2099-xxxx`), pero los comandos son los reales. **Limpieza:** `aws ecr delete-repository --repository-name tienda/api --force`.',
    },
    {
      id: 'l11-e2',
      title: 'Ciclo de vida, etiquetas inmutables y análisis',
      summary: 'Reduce el coste del repositorio, protege las versiones y revisa las vulnerabilidades.',
      difficulty: 'Media',
      minutes: 18,
      saa: [SAA_DOMAINS[4], SAA_DOMAINS[1]],
      tags: ['ECR', 'Ciclo de vida', 'Seguridad'],
      scenario: 'El repositorio `tienda/web` acumula las versiones 1.0 a 1.4 y crece sin control. Configura una política de ciclo de vida que conserve solo las **2 últimas** imágenes, activa la **inmutabilidad de etiquetas** y comprueba que intentar sobrescribir `1.4` con otra imagen es rechazado. Por último analiza `1.4` y guarda el recuento por gravedad en `~/hallazgos.txt`.',
      setup: async (sh) => { await prep(sh, E2_SETUP); },
      steps: [
        { id: 'lc', title: 'Aplica una política de ciclo de vida: `imageCountMoreThan` 2 con acción `expire`', hint: ['La política es un JSON con "rules": rulePriority, selection y action.', 'aws ecr put-lifecycle-policy --repository-name tienda/web --lifecycle-policy-text file://politica.json'], check: (c) => { const lp = repo(c, 'tienda/web')?.lifecyclePolicy; if (!lp) return 'El repositorio no tiene política de ciclo de vida.'; try { return JSON.parse(lp.text).rules.some((r: any) => r.selection.countType === 'imageCountMoreThan' && r.selection.countNumber <= 2) || 'La política debe conservar como máximo 2 imágenes (imageCountMoreThan, countNumber 2).'; } catch { return 'La política no es un JSON válido.'; } } },
        { id: 'pruned', title: 'Comprueba que solo quedan las 2 últimas imágenes (`describe-images`)', hint: ['La política se evalúa de forma asíncrona: puede tardar unos segundos.', 'aws ecr describe-images --repository-name tienda/web'], check: (c) => { const r = repo(c, 'tienda/web'); if (!r?.lifecyclePolicy) return 'Aplica primero la política.'; return r.images.length <= 2 || `Aún hay ${r.images.length} imágenes: la política se aplica de forma asíncrona, vuelve a listar en unos segundos.`; } },
        { id: 'imm', title: 'Activa la inmutabilidad y comprueba que `docker push` de una imagen distinta con la etiqueta `1.4` falla', hint: ['aws ecr put-image-tag-mutability --repository-name tienda/web --image-tag-mutability IMMUTABLE', 'Etiqueta otra imagen (por ejemplo alpine) como tienda/web:1.4 y haz push: verás ImageTagAlreadyExistsException.'], check: (c) => { if (repo(c, 'tienda/web')?.tagMutability !== 'IMMUTABLE') return 'La inmutabilidad de etiquetas no está activada.'; return c.trail('PutImage', { error: 'ImageTagAlreadyExistsException' }).length > 0 || 'Intenta sobrescribir tienda/web:1.4 con docker push y comprueba que se rechaza.'; } },
        { id: 'scan', title: 'Analiza `1.4` y guarda los hallazgos por gravedad en `~/hallazgos.txt`', hint: ['aws ecr start-image-scan --repository-name tienda/web --image-id imageTag=1.4', 'aws ecr describe-image-scan-findings ... --query imageScanFindings.findingSeverityCounts > ~/hallazgos.txt'], check: (c) => { const i = repo(c, 'tienda/web')?.images.find((x) => x.tags.includes('1.4')); if (!i?.scan) return 'La imagen 1.4 aún no se ha analizado.'; return /[A-Z]{3,}/.test(c.file('hallazgos.txt') ?? '') || '~/hallazgos.txt debe contener el recuento por gravedad.'; } },
      ],
      script: E2,
      realWorld: 'En ECR real las políticas de ciclo de vida se evalúan cada 24 horas aproximadamente, así que la limpieza no es inmediata; usa `get-lifecycle-policy-preview` antes de aplicar una política para ver qué borraría. La inmutabilidad se activa por repositorio y es la base de despliegues reproducibles. El análisis mejorado (Inspector) tiene coste; el básico, no. **Limpieza:** `aws ecr delete-repository --repository-name tienda/web --force`.',
    },
    {
      id: 'l11-e3',
      title: 'Fargate detrás de un Application Load Balancer',
      summary: 'Define una tarea, crea un servicio de 2 tareas y publícalo con un ALB con destinos IP.',
      difficulty: 'Difícil',
      minutes: 28,
      saa: [SAA_DOMAINS[2], SAA_DOMAINS[3]],
      tags: ['ECS', 'Fargate', 'ALB', 'VPC'],
      scenario: 'Vas a publicar un sitio web sin gestionar servidores. Con el rol `ecsTaskExecutionRole` ya creado: registra la definición de tarea `web` (Fargate, `awsvpc`, 256 CPU / 512 MiB, imagen `public.ecr.aws/nginx/nginx:1.27`, puerto 80) en el clúster `tienda`; crea el balanceador `tienda-alb` con un grupo de destino **de tipo `ip`** llamado `tienda-tg` y un listener en el puerto 80; crea el servicio `web` con 2 tareas conectado al grupo de destino y comprueba con `curl` que el DNS del balanceador responde.',
      setup: async (sh) => { await prep(sh, E3_SETUP); },
      steps: [
        { id: 'td', title: 'Registra la definición de tarea `web` para Fargate (`awsvpc`, 256/512, puerto 80)', hint: ['aws ecs register-task-definition --cli-input-json file://tarea.json', 'Necesita requiresCompatibilities FARGATE, networkMode awsvpc, cpu y memory como cadenas y executionRoleArn.'], check: (c) => { const t = C(c).taskDefs.find((x) => x.family === 'web' && x.status === 'ACTIVE'); if (!t) return 'No hay una definición de tarea activa de la familia web.'; if (t.networkMode !== 'awsvpc' || !t.requiresCompatibilities.includes('FARGATE')) return 'La tarea debe ser Fargate con networkMode awsvpc.'; return t.containerDefinitions.some((d) => d.portMappings.some((p) => p.containerPort === 80)) || 'El contenedor debe exponer el puerto 80.'; } },
        { id: 'alb', title: 'Crea `tienda-alb` con el grupo de destino `tienda-tg` de tipo `ip` y un listener HTTP:80 que reenvíe a él', hint: ['Con Fargate (awsvpc) el tipo de destino es ip: --target-type ip en create-target-group.', 'aws elbv2 create-listener ... --default-actions Type=forward,TargetGroupArn=$TG'], check: (c) => { const tg = c.tg('tienda-tg'); if (!tg) return 'Falta el grupo de destino tienda-tg.'; if (tg.targetType !== 'ip') return 'El grupo de destino debe ser de tipo ip (Fargate no usa instancias).'; const lb = c.lb('tienda-alb'); if (!lb) return 'Falta el balanceador tienda-alb.'; return c.s.listeners.some((l) => l.lbArn === lb.arn && l.port === 80) || 'El balanceador no tiene listener en el puerto 80.'; } },
        { id: 'svc', title: 'Crea el servicio `web` (2 tareas, Fargate) conectado a `tienda-tg` y espera a que sea estable', hint: ['aws ecs create-service ... --desired-count 2 --launch-type FARGATE --load-balancers targetGroupArn=$TG,containerName=web,containerPort=80', 'La red lleva subredes, un grupo de seguridad y assignPublicIp=ENABLED.', 'aws ecs wait services-stable --cluster tienda --services web'], check: (c) => { const s = svc(c, 'tienda', 'web'); if (!s) return 'No existe el servicio web en el clúster tienda.'; if (!s.loadBalancers.length) return 'El servicio no está conectado a ningún grupo de destino.'; return running(c, 'tienda', 'web') === 2 || `Hay ${running(c, 'tienda', 'web')} tareas en ejecución de 2: espera a que el servicio se estabilice.`; } },
        { id: 'healthy', title: 'Los 2 destinos del grupo `tienda-tg` están `healthy`', hint: ['aws elbv2 describe-target-health --target-group-arn $TG', 'Si no son healthy, revisa que el grupo de seguridad permita el puerto 80.'], check: (c) => { const st = Object.values(c.targetStates('tienda-tg')); return (st.length === 2 && st.every((x) => x === 'healthy')) || `Destinos: ${st.join(', ') || 'ninguno'}. Deben ser 2 healthy.`; } },
        { id: 'curl', title: 'Guarda en `~/respuesta.html` la respuesta de `curl` al DNS del balanceador', hint: ['DNS=$(aws elbv2 describe-load-balancers --names tienda-alb --query "LoadBalancers[0].DNSName" --output text)', 'curl -s http://$DNS > ~/respuesta.html'], check: (c) => /nginx/i.test(c.file('respuesta.html') ?? '') || '~/respuesta.html debe contener la página de nginx servida por el balanceador.' },
      ],
      script: E3,
      realWorld: 'En tu cuenta real Fargate se factura por vCPU y GB por segundo, y el ALB cuesta por hora aunque no tenga tráfico. Las tareas necesitan salida a internet (IP pública o NAT) o *endpoints* de VPC para ECR, S3 y CloudWatch Logs; el grupo de seguridad de las tareas debería aceptar tráfico **solo del grupo de seguridad del ALB**, no de `0.0.0.0/0`. **Limpieza:** `aws ecs update-service --desired-count 0`, `aws ecs delete-service --force`, borra listener, balanceador y grupo de destino, y `aws ecs delete-cluster`.',
    },
    {
      id: 'l11-e4',
      title: 'La tarea que no arranca',
      summary: 'Diagnostica un servicio de ECS en bucle de fallos y corrígelo con una nueva revisión.',
      difficulty: 'Difícil',
      minutes: 22,
      saa: [SAA_DOMAINS[2]],
      tags: ['ECS', 'ECR', 'Diagnóstico'],
      scenario: 'El servicio `web` del clúster `tienda` lleva minutos en 0 tareas en ejecución. Averigua por qué (mira los **eventos del servicio** y el `stoppedReason`/`reason` de la tarea detenida) y guarda la causa en `~/causa.txt`. Después corrígelo: registra una nueva revisión de la definición de tarea que use una etiqueta que sí exista en ECR y actualiza el servicio hasta que tenga 1 tarea en ejecución.',
      setup: async (sh) => { await prep(sh, E4_SETUP); },
      steps: [
        { id: 'cause', title: 'Guarda en `~/causa.txt` el motivo del fallo de la tarea detenida', hint: ['aws ecs describe-services ... --query "services[0].events"', 'aws ecs list-tasks --cluster tienda --desired-status STOPPED', 'aws ecs describe-tasks ... --query "tasks[0].containers[0].reason"'], check: (c) => /CannotPullContainerError/.test(c.file('causa.txt') ?? '') || '~/causa.txt debe contener el error de la tarea (describe-tasks → containers[0].reason).' },
        { id: 'rev', title: 'Registra una nueva revisión de `web` que use la etiqueta `1.0` (la que sí existe en ECR)', hint: ['aws ecr list-images --repository-name tienda/web muestra las etiquetas disponibles.', 'Una definición de tarea es inmutable: registra una revisión nueva con aws ecs register-task-definition.'], check: (c) => C(c).taskDefs.some((t) => t.family === 'web' && t.revision >= 2 && t.containerDefinitions.some((d) => d.image.endsWith('/tienda/web:1.0'))) || 'Falta una revisión (≥ 2) de web con la imagen tienda/web:1.0.' },
        { id: 'fix', title: 'Actualiza el servicio a esa revisión y espera a tener 1 tarea en ejecución', hint: ['aws ecs update-service --cluster tienda --service web --task-definition web', 'aws ecs wait services-stable --cluster tienda --services web'], check: (c) => { const s = svc(c, 'tienda', 'web'); if (!s) return 'No existe el servicio web.'; if (!/web:([2-9]|\d{2,})$/.test(s.taskDefinition)) return 'El servicio sigue usando la revisión antigua.'; return running(c, 'tienda', 'web') === 1 || 'Aún no hay 1 tarea en ejecución: espera a que el despliegue termine.'; } },
      ],
      script: E4,
      realWorld: 'En una cuenta real el mismo síntoma tiene otras causas frecuentes: la subred no tiene salida a internet (sin IP pública ni NAT ni endpoints de VPC) → `ResourceInitializationError`; el rol de ejecución no puede leer de ECR o falta el grupo de CloudWatch Logs de `awslogs`. En la consola mira *Servicio → Eventos* y *Tarea → Registros*. **Limpieza:** `aws ecs update-service --desired-count 0` y `aws ecs delete-service --force`, borra el clúster y `aws ecr delete-repository --force`.',
    },
    {
      id: 'l11-e5',
      title: 'Tu primer clúster de EKS',
      summary: 'Crea el plano de control, un grupo de nodos y conéctate con kubectl.',
      difficulty: 'Media',
      minutes: 24,
      saa: [SAA_DOMAINS[2], SAA_DOMAINS[1]],
      tags: ['EKS', 'Kubernetes', 'EC2', 'IAM'],
      scenario: 'La plataforma migra a Kubernetes. Con los roles `eks-cluster-role` y `eks-nodos-role` ya preparados, crea el clúster `dev` en la VPC predeterminada, espera a que esté `ACTIVE`, añade un grupo de nodos administrado `ng` con 2 nodos `t3.medium`, configura `kubectl` con `update-kubeconfig` y guarda en `~/nodos.txt` la salida de `kubectl get nodes`.',
      setup: async (sh) => { await prep(sh, E5_SETUP); },
      steps: [
        { id: 'cluster', title: 'Crea el clúster `dev` con el rol `eks-cluster-role` y espera a `ACTIVE`', hint: ['aws eks create-cluster --name dev --role-arn <arn> --resources-vpc-config subnetIds=<s1>,<s2>', 'aws eks wait cluster-active --name dev'], check: (c) => { const k = cluster(c, 'dev'); if (!k) return 'No existe el clúster dev.'; return k.status === 'ACTIVE' || `El clúster está ${k.status}: espera con aws eks wait cluster-active.`; } },
        { id: 'ng', title: 'Crea el grupo de nodos `ng` con 2 nodos y espera a que esté activo', hint: ['aws eks create-nodegroup --cluster-name dev --nodegroup-name ng --node-role <arn> --subnets <s1> <s2> --scaling-config minSize=1,maxSize=4,desiredSize=2', 'aws eks wait nodegroup-active --cluster-name dev --nodegroup-name ng'], check: (c) => { const g = cluster(c, 'dev')?.nodegroups.find((x) => x.name === 'ng'); if (!g) return 'No existe el grupo de nodos ng.'; if (g.status === 'CREATE_FAILED') return `El grupo falló: ${g.health?.message ?? 'revisa el rol del nodo'}.`; if (g.status !== 'ACTIVE') return `El grupo de nodos está ${g.status}.`; return g.scaling.desiredSize === 2 || 'El tamaño deseado debe ser 2.'; } },
        { id: 'kc', title: 'Configura `kubectl` con `aws eks update-kubeconfig`', hint: ['aws eks update-kubeconfig --name dev', 'Escribe el contexto en ~/.kube/config.'], check: (c) => (c.file('.kube/config') ?? '').includes('cluster/dev') || 'Aún no hay contexto de dev en ~/.kube/config.' },
        { id: 'nodes', title: 'Guarda `kubectl get nodes` en `~/nodos.txt`: 2 nodos `Ready`', hint: ['kubectl get nodes > ~/nodos.txt'], check: (c) => ((c.file('nodos.txt') ?? '').match(/\bReady\b/g) ?? []).length === 2 || '~/nodos.txt debe listar 2 nodos en estado Ready.' },
      ],
      script: E5,
      realWorld: 'En tu cuenta real el plano de control de EKS cuesta unos 0,10 USD por hora (≈ 73 USD al mes) **además** de los nodos EC2: es de los laboratorios más caros, así que hazlo con tiempo y borra al terminar. Crear el clúster tarda unos 10-15 minutos. Si el grupo de nodos queda en `CREATE_FAILED` revisa las tres políticas del rol del nodo y que las subredes tengan salida a internet. **Limpieza:** `aws eks delete-nodegroup`, espera a que termine, `aws eks delete-cluster` y, si no los usas, borra los roles.',
    },
    {
      id: 'l11-e6',
      title: 'Despliegue, fallo y vuelta atrás en Kubernetes',
      summary: 'Publica una aplicación con un Service LoadBalancer, rompe la actualización y revierte.',
      difficulty: 'Difícil',
      minutes: 26,
      saa: [SAA_DOMAINS[2], SAA_DOMAINS[3]],
      tags: ['EKS', 'kubectl', 'Deployments'],
      scenario: 'El clúster `dev` ya está listo. Escribe `~/web.yaml` con un Deployment `web` (3 réplicas de `nginx:1.25`, etiqueta `app=web`) y un Service `web` de tipo `LoadBalancer` y aplícalo. Después simula una mala actualización: cambia la imagen a `nginx:1.99` (no existe), comprueba que los pods nuevos quedan en `ImagePullBackOff` y que el despliegue no progresa (guarda `kubectl get pods` en `~/pods-rotos.txt`); revierte con `rollout undo`, escala a 4 réplicas y guarda `kubectl get svc web` en `~/servicio.txt`.',
      setup: async (sh) => { await prep(sh, E6_SETUP); },
      steps: [
        { id: 'apply', title: 'Aplica `~/web.yaml` (Deployment `web` ×3 con `nginx:1.25` y Service `LoadBalancer`)', hint: ['kubectl apply -f web.yaml', 'El Service necesita type: LoadBalancer y selector app: web.'], check: (c) => { const x = dep(c, 'dev', 'web'); if (!x) return 'Aún no existe el Deployment web.'; const k = cluster(c, 'dev')!; const s = K.find(k, 'Service', 'default', 'web'); if (!s || s.spec.type !== 'LoadBalancer') return 'Falta el Service web de tipo LoadBalancer.'; return x.d.spec.template.spec.containers[0].image.startsWith('nginx:') || 'El Deployment debe usar nginx.'; } },
        { id: 'broken', title: 'Cambia la imagen a `nginx:1.99` y guarda en `~/pods-rotos.txt` los pods con `ImagePullBackOff`', hint: ['kubectl set image deployment/web nginx=nginx:1.99', 'kubectl get pods > ~/pods-rotos.txt', 'kubectl rollout status mostrará que no progresa.'], check: (c) => { if (!c.ran(/kubectl\s+set\s+image[^\n]*nginx:1\.99/)) return 'Aún no has actualizado la imagen a nginx:1.99.'; return /ImagePullBackOff|ErrImagePull/.test(c.file('pods-rotos.txt') ?? '') || '~/pods-rotos.txt debe mostrar pods en ImagePullBackOff (kubectl get pods).'; } },
        { id: 'undo', title: 'Revierte con `kubectl rollout undo`: `nginx:1.25` y todos los pods `Running`', hint: ['kubectl rollout undo deployment/web', 'kubectl rollout status deployment/web'], check: (c) => { const x = dep(c, 'dev', 'web'); if (!x) return 'No existe el Deployment web.'; if (!c.ran(/kubectl\s+rollout\s+undo/)) return 'Usa kubectl rollout undo para volver a la revisión anterior.'; return (x.d.spec.template.spec.containers[0].image === 'nginx:1.25' && x.st.available === x.st.want) || 'La imagen debe volver a nginx:1.25 y todos los pods estar disponibles.'; } },
        { id: 'scale', title: 'Escala a 4 réplicas y guarda `kubectl get svc web` en `~/servicio.txt` (con su nombre DNS)', hint: ['kubectl scale deployment web --replicas=4', 'kubectl get svc web > ~/servicio.txt'], check: (c) => { const x = dep(c, 'dev', 'web'); if (!x || x.d.spec.replicas !== 4 || x.st.available !== 4) return 'El Deployment web debe tener 4 réplicas disponibles.'; return /elb\.amazonaws\.com/.test(c.file('servicio.txt') ?? '') || '~/servicio.txt debe contener el EXTERNAL-IP (nombre DNS) del Service.'; } },
      ],
      script: E6,
      realWorld: 'En EKS real un Service `LoadBalancer` crea un balanceador de AWS que se factura por hora y tarda 2-3 minutos en tener DNS; fíjate en que los pods antiguos **siguen sirviendo** durante la actualización fallida gracias a `maxUnavailable`, y por eso el servicio no cae. Para producción usa el AWS Load Balancer Controller con un `Ingress` y ALB. **Limpieza:** `kubectl delete -f web.yaml` (elimina el balanceador) **antes** de borrar el clúster, o quedará huérfano y seguirá cobrando.',
    },
    {
      id: 'l11-e7',
      title: 'Pods bloqueados por configuración',
      summary: 'Un Deployment referencia un ConfigMap que no existe: diagnostica y repara.',
      difficulty: 'Reto',
      minutes: 18,
      saa: [SAA_DOMAINS[2]],
      tags: ['EKS', 'kubectl', 'ConfigMap', 'Diagnóstico'],
      scenario: 'El equipo ha desplegado el Deployment `api` (2 réplicas) y ninguno de sus pods arranca. Usa `kubectl get` y `kubectl describe pod` para encontrar la causa y guarda la descripción de un pod en `~/diagnostico.txt`. Después crea lo que falta (el ConfigMap `api-config` con la clave `MODO=produccion`) y reinicia el despliegue hasta que los 2 pods estén `Running`.',
      setup: async (sh) => { await prep(sh, E7_SETUP); },
      steps: [
        { id: 'diag', title: 'Guarda en `~/diagnostico.txt` el `describe` de un pod y localiza el error', hint: ['kubectl get pods muestra CreateContainerConfigError.', 'kubectl describe pod <nombre> > ~/diagnostico.txt'], check: (c) => /api-config/.test(c.file('diagnostico.txt') ?? '') || '~/diagnostico.txt debe contener la salida de kubectl describe pod (los eventos citan el ConfigMap que falta).' },
        { id: 'cm', title: 'Crea el ConfigMap `api-config` con `MODO=produccion`', hint: ['kubectl create configmap api-config --from-literal=MODO=produccion'], check: (c) => { const k = cluster(c, 'dev'); const m = k && K.find(k, 'ConfigMap', 'default', 'api-config'); if (!m) return 'No existe el ConfigMap api-config.'; return m.data?.MODO === 'produccion' || 'El ConfigMap debe tener MODO=produccion.'; } },
        { id: 'run', title: 'Reinicia el despliegue y consigue 2 pods `Running`', hint: ['kubectl rollout restart deployment/api', 'kubectl rollout status deployment/api'], check: (c) => { const x = dep(c, 'dev', 'api'); if (!x) return 'No existe el Deployment api.'; return x.st.available === 2 || `Hay ${x.st.available} pods disponibles de 2: reinicia el despliegue tras crear el ConfigMap.`; } },
      ],
      script: E7,
      realWorld: 'En un clúster real `CreateContainerConfigError` suele deberse a un ConfigMap o Secret que falta o a una clave mal escrita; el patrón es siempre `get` → `describe` → eventos. Los pods no suelen requerir reinicio manual (kubelet reintenta), pero `rollout restart` acelera la recuperación y deja constancia. No guardes secretos en ConfigMaps: usa `Secret` o AWS Secrets Manager. **Limpieza:** `kubectl delete deployment api` y `kubectl delete configmap api-config`; borra el clúster si no lo necesitas.',
    },
  ],
  quiz: [
    { domain: 4, q: 'Tu repositorio de ECR acumula cientos de imágenes antiguas y el coste de almacenamiento crece. ¿Qué configuras?', options: ['Una política de ciclo de vida que expire imágenes por antigüedad o número', 'Cifrado con KMS', 'Un repositorio por cada imagen', 'Replicación entre regiones'], answer: 0, explain: 'Las políticas de ciclo de vida de ECR eliminan automáticamente imágenes sin etiqueta o antiguas. El almacenamiento se factura por GB al mes, así que limpiar reduce el coste.' },
    { domain: 1, q: '¿Cómo evitas que alguien sobrescriba la etiqueta `1.0` de una imagen publicada en ECR?', options: ['Activando la inmutabilidad de etiquetas del repositorio', 'Cambiando el nombre del repositorio', 'Con un grupo de seguridad', 'Desactivando el análisis al enviar'], answer: 0, explain: 'Con `imageTagMutability=IMMUTABLE`, un push que reutilice una etiqueta existente con otra imagen falla con ImageTagAlreadyExistsException.' },
    { domain: 2, q: 'Un servicio de ECS en Fargate no consigue arrancar tareas y los eventos muestran CannotPullContainerError. ¿Qué es lo MÁS probable?', options: ['La etiqueta de imagen no existe en ECR o la tarea no tiene salida a internet/permisos para descargarla', 'Faltan nodos EC2 en el clúster', 'El clúster está en otra región', 'El ALB no tiene listener'], answer: 0, explain: 'Con Fargate no hay nodos que administrar. Ese error indica una imagen o etiqueta inexistente, un rol de ejecución sin permisos o una subred sin salida (IP pública, NAT o endpoints de VPC).' },
    { domain: 1, q: '¿Qué diferencia hay entre el rol de ejecución de tareas y el rol de tarea de ECS?', options: ['El de ejecución lo usa el agente de ECS (descargar imagen, escribir logs); el de tarea lo usa tu aplicación para llamar a otros servicios', 'Son el mismo rol con dos nombres', 'El de tarea solo sirve para EC2', 'El de ejecución da permisos al usuario que lanza la tarea'], answer: 0, explain: 'AmazonECSTaskExecutionRolePolicy permite a ECS extraer de ECR y escribir en CloudWatch Logs. Los permisos de la aplicación (S3, DynamoDB...) van en el rol de tarea, con mínimo privilegio.' },
    { domain: 3, q: 'Vas a poner un Application Load Balancer delante de un servicio de ECS en Fargate (modo awsvpc). ¿Qué tipo de destino debe tener el grupo de destino?', options: ['ip', 'instance', 'lambda', 'alb'], answer: 0, explain: 'Cada tarea Fargate tiene su propia ENI e IP; no hay instancias EC2 que registrar. Por eso el grupo de destino debe ser de tipo ip.' },
    { domain: 2, q: 'Tu grupo de nodos de EKS termina en CREATE_FAILED y los nodos no se unen al clúster. ¿Qué revisas primero?', options: ['Que el rol de los nodos tenga AmazonEKSWorkerNodePolicy, AmazonEKS_CNI_Policy y AmazonEC2ContainerRegistryReadOnly, y que las subredes tengan salida a internet', 'La versión de Docker', 'El tamaño de la VPC en el rango 10.0.0.0/8', 'El número de réplicas del Deployment'], answer: 0, explain: 'Los nodos necesitan esas tres políticas para registrarse, configurar la red de pods y descargar imágenes de ECR, y necesitan alcanzar el plano de control y ECR a través de internet, NAT o endpoints.' },
    { domain: 2, q: 'Una actualización de un Deployment deja pods nuevos en ImagePullBackOff y el despliegue no avanza. Quieres volver cuanto antes al estado sano. ¿Qué haces?', options: ['kubectl rollout undo deployment/<nombre>', 'Borrar el clúster', 'kubectl scale --replicas=0', 'Cambiar el tipo de Service a NodePort'], answer: 0, explain: 'Los Deployments guardan el historial de ReplicaSets: `rollout undo` restaura la revisión anterior. Además, gracias a maxUnavailable, los pods antiguos siguen sirviendo tráfico durante la actualización fallida.' },
    { domain: 4, q: 'Quieres ejecutar contenedores sin administrar servidores ni parchear nodos y pagando solo por vCPU y memoria usadas. ¿Qué eliges?', options: ['ECS con AWS Fargate', 'EKS con nodos autoadministrados en EC2', 'Una instancia EC2 con Docker instalado a mano', 'Lightsail Containers con instancia reservada'], answer: 0, explain: 'Fargate es cómputo sin servidor para contenedores: no hay nodos que administrar y se factura por vCPU y GB por segundo mientras la tarea se ejecuta.' },
  ],
};

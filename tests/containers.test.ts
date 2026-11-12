import { describe, it, expect, beforeEach } from 'vitest';
import { freshState } from '../src/engine/store';
import { newShell, execLine, type Shell } from '../src/shell';
import type { CloudState } from '../src/engine/types';
import { cs } from '../src/engine/services/containerCore';

let st: CloudState;
let sh: Shell;
const run = async (line: string) => { const r = await execLine(sh, line, 'typed'); return { ...r, all: r.out + r.err }; };
const ok = async (line: string) => { const r = await run(line); expect(r.code, `${line}\n${r.err}`).toBe(0); return r.out; };
const bad = async (line: string, re: RegExp | string) => { const r = await run(line); expect(r.code, line).not.toBe(0); expect(r.err).toMatch(re); return r.err; };
const json = async (line: string) => JSON.parse(await ok(line));
const ACC = () => st.account.id;
const REG = () => `${ACC()}.dkr.ecr.eu-west-1.amazonaws.com`;
const trust = (svc: string) => `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"${svc}"},"Action":"sts:AssumeRole"}]}`;
const role = async (name: string, svc: string, pols: string[]) => {
  sh.fs.writeFile(`/tmp/${name}.json`, trust(svc));
  await ok(`aws iam create-role --role-name ${name} --assume-role-policy-document file:///tmp/${name}.json`);
  for (const p of pols) await ok(`aws iam attach-role-policy --role-name ${name} --policy-arn arn:aws:iam::aws:policy/${p}`);
};
const subnets = async () => (await json('aws ec2 describe-subnets --query "Subnets[].SubnetId"')) as string[];

beforeEach(() => {
  st = freshState('Ana');
  st.settings.speed = 'instant';
  sh = newShell(st);
  sh.fs.mkdir('/tmp', true);
});

describe('ECR', () => {
  it('crea repositorios con la forma de la CLI y rechaza duplicados y nombres inválidos', async () => {
    const r = await json('aws ecr create-repository --repository-name tienda/api --image-scanning-configuration scanOnPush=true');
    expect(r.repository.repositoryUri).toBe(`${REG()}/tienda/api`);
    expect(r.repository.imageScanningConfiguration.scanOnPush).toBe(true);
    await bad('aws ecr create-repository --repository-name tienda/api', /RepositoryAlreadyExistsException/);
    await bad('aws ecr create-repository --repository-name Mayusculas', /InvalidParameterException/);
    await bad('aws ecr describe-repositories --repository-names nada', /RepositoryNotFoundException/);
  });

  it('get-login-password + docker login + build + push deja la imagen en el repositorio', async () => {
    await ok('aws ecr create-repository --repository-name app');
    sh.fs.mkdir('/tmp/app', true);
    sh.fs.writeFile('/tmp/app/Dockerfile', 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 8080\nCMD ["node","server.js"]\n');
    sh.fs.writeFile('/tmp/app/server.js', 'x');
    const b = await run('docker build -t app:1.0 /tmp/app');
    expect(b.code).toBe(0);
    expect(b.err).toContain('naming to docker.io/library/app:1.0');
    await ok(`docker tag app:1.0 ${REG()}/app:1.0`);
    // Sin autenticar el push falla igual que en el original
    await bad(`docker push ${REG()}/app:1.0`, /no basic auth credentials/);
    const login = await run(`aws ecr get-login-password | docker login --username AWS --password-stdin ${REG()}`);
    expect(login.out).toContain('Login Succeeded');
    const push = await ok(`docker push ${REG()}/app:1.0`);
    expect(push).toMatch(/1\.0: digest: sha256:[0-9a-f]{64} size: \d+/);
    const d = await json('aws ecr describe-images --repository-name app');
    expect(d.imageDetails[0].imageTags).toEqual(['1.0']);
    expect(cs(st).ecr[0].images).toHaveLength(1);
    const li = await json('aws ecr list-images --repository-name app');
    expect(li.imageIds[0].imageTag).toBe('1.0');
  });

  it('el push a un repositorio inexistente o ajeno falla; un token no sirve para otra cuenta', async () => {
    await ok(`aws ecr get-login-password | docker login --username AWS --password-stdin ${REG()}`);
    await ok('docker pull alpine:3.20');
    await ok(`docker tag alpine:3.20 ${REG()}/noexiste:1`);
    await bad(`docker push ${REG()}/noexiste:1`, /does not exist|name unknown/);
    await ok('docker tag alpine:3.20 123456789012.dkr.ecr.eu-west-1.amazonaws.com/otra:1');
    await bad('docker push 123456789012.dkr.ecr.eu-west-1.amazonaws.com/otra:1', /denied|no basic auth|not authorized/i);
  });

  it('IMMUTABLE rechaza reescribir una etiqueta con otra imagen y deja rastro en CloudTrail', async () => {
    await ok('aws ecr create-repository --repository-name web --image-tag-mutability IMMUTABLE');
    await ok(`aws ecr get-login-password | docker login --username AWS --password-stdin ${REG()}`);
    await ok('docker pull nginx:1.25'); await ok('docker pull alpine:3.20');
    await ok(`docker tag nginx:1.25 ${REG()}/web:v1`); await ok(`docker push ${REG()}/web:v1`);
    await ok(`docker tag alpine:3.20 ${REG()}/web:v1`);
    await bad(`docker push ${REG()}/web:v1`, /tag invalid|ImageTagAlreadyExists/i);
    expect(st.trail.some((e) => e.eventName === 'PutImage' && e.errorCode === 'ImageTagAlreadyExistsException')).toBe(true);
  });

  it('la política de ciclo de vida expira imágenes antiguas y se valida', async () => {
    await ok('aws ecr create-repository --repository-name web');
    await ok(`aws ecr get-login-password | docker login --username AWS --password-stdin ${REG()}`);
    for (const [v, n] of [['1', '1.25'], ['2', '1.26'], ['3', '1.27'], ['4', '1.28']]) { await ok(`docker pull nginx:${n}`); await ok(`docker tag nginx:${n} ${REG()}/web:${v}`); await ok(`docker push ${REG()}/web:${v}`); }
    sh.fs.writeFile('/tmp/mala.json', '{"rules":[]}');
    await bad('aws ecr put-lifecycle-policy --repository-name web --lifecycle-policy-text file:///tmp/mala.json', /InvalidParameterException/);
    sh.fs.writeFile('/tmp/lc.json', '{"rules":[{"rulePriority":1,"selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":2},"action":{"type":"expire"}}]}');
    await ok('aws ecr put-lifecycle-policy --repository-name web --lifecycle-policy-text file:///tmp/lc.json');
    const d = await json('aws ecr describe-images --repository-name web');
    expect(d.imageDetails).toHaveLength(2);
    expect(d.imageDetails.flatMap((i: any) => i.imageTags).sort()).toEqual(['3', '4']);
  });

  it('start-image-scan y describe-image-scan-findings; una imagen antigua tiene más hallazgos', async () => {
    await ok('aws ecr create-repository --repository-name old');
    await ok(`aws ecr get-login-password | docker login --username AWS --password-stdin ${REG()}`);
    await ok('docker pull node:14'); await ok('docker pull alpine:3.20');
    await ok(`docker tag node:14 ${REG()}/old:v14`); await ok(`docker push ${REG()}/old:v14`);
    await ok(`docker tag alpine:3.20 ${REG()}/old:alp`); await ok(`docker push ${REG()}/old:alp`);
    await ok('aws ecr start-image-scan --repository-name old --image-id imageTag=v14');
    await ok('aws ecr start-image-scan --repository-name old --image-id imageTag=alp');
    const a = await json('aws ecr describe-image-scan-findings --repository-name old --image-id imageTag=v14');
    const b = await json('aws ecr describe-image-scan-findings --repository-name old --image-id imageTag=alp');
    expect(a.imageScanStatus.status).toBe('COMPLETE');
    expect(a.imageScanFindings.findingSeverityCounts.CRITICAL ?? 0).toBeGreaterThan(b.imageScanFindings.findingSeverityCounts.CRITICAL ?? 0);
    expect(a.imageScanFindings.findings[0].name).toMatch(/^CVE-2099-/);
  });

  it('IAM: sin permisos de ECR el usuario recibe AccessDenied', async () => {
    await ok('aws iam create-user --user-name dev');
    const k = await json('aws iam create-access-key --user-name dev');
    await ok(`aws configure set aws_access_key_id ${k.AccessKey.AccessKeyId} --profile dev`);
    await ok(`aws configure set aws_secret_access_key ${k.AccessKey.SecretAccessKey} --profile dev`);
    await ok('aws configure set region eu-west-1 --profile dev');
    await bad('aws ecr create-repository --repository-name xx --profile dev', /AccessDeniedException|not authorized/);
    await ok('aws iam attach-user-policy --user-name dev --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPowerUser');
    await bad('aws ecr create-repository --repository-name xx --profile dev', /ecr:CreateRepository/);
    await ok('aws ecr create-repository --repository-name xx');
    await ok('aws ecr describe-images --repository-name xx --profile dev');
    await bad('aws ecr delete-repository --repository-name xx --profile dev', /AccessDeniedException|not authorized/);
    await ok('aws iam attach-user-policy --user-name dev --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryFullAccess');
    await ok('aws ecr delete-repository --repository-name xx --profile dev');
  });

  it('borrar un repositorio con imágenes exige --force', async () => {
    await ok('aws ecr create-repository --repository-name web');
    await ok(`aws ecr get-login-password | docker login --username AWS --password-stdin ${REG()}`);
    await ok('docker pull nginx:1.25'); await ok(`docker tag nginx:1.25 ${REG()}/web:1`); await ok(`docker push ${REG()}/web:1`);
    await bad('aws ecr delete-repository --repository-name web', /RepositoryNotEmptyException/);
    await ok('aws ecr delete-repository --repository-name web --force');
    expect(cs(st).ecr).toHaveLength(0);
  });
});

describe('docker', () => {
  it('run, ps, logs, stop, rm y curl a un contenedor publicado', async () => {
    await ok('docker pull nginx:1.25');
    const id = (await ok('docker run -d -p 8080:80 --name web nginx:1.25')).trim();
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(await ok('docker ps')).toMatch(/0\.0\.0\.0:8080->80\/tcp\s+web/);
    expect(await ok('curl -s localhost:8080')).toContain('Welcome to nginx');
    expect(await ok('docker logs web')).toContain('Configuration complete');
    await bad('docker run -d -p 8080:80 --name web2 nginx:1.25', /port is already allocated/);
    await bad('docker run -d --name web nginx:1.25', /already in use/);
    await ok('docker stop web');
    expect(await ok('docker ps')).not.toContain('web');
    expect(await ok('docker ps -a')).toContain('Exited');
    await ok('docker rm web');
    await bad('docker rm web', /No such container/);
  });

  it('docker run de una imagen efímera imprime y sale; errores como los del original', async () => {
    await ok('docker pull alpine:3.20');
    expect(await ok('docker run --rm alpine:3.20 echo hola')).toBe('hola\n');
    await bad('docker run nada-de-nada:1', /pull access denied|manifest unknown/);
    await bad('docker pull nginx:9.9', /manifest.*not found|manifest unknown/);
    await bad('docker build -t x /tmp', /(no such file|Dockerfile)/i);
    sh.fs.writeFile('/tmp/Dockerfile', 'RUN echo sin-from\n');
    await bad('docker build -t x /tmp', /no build stage|FROM/i);
    await bad('docker rmi inexistente', /No such image/);
  });
});

describe('ECS + Fargate', () => {
  const taskDef = (image: string, extra: Record<string, unknown> = {}) => JSON.stringify({ family: 'web', networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'], cpu: '256', memory: '512', executionRoleArn: `arn:aws:iam::${ACC()}:role/exec`, containerDefinitions: [{ name: 'web', image, essential: true, portMappings: [{ containerPort: 80 }] }], ...extra });
  const base = async () => {
    await role('exec', 'ecs-tasks.amazonaws.com', ['service-role/AmazonECSTaskExecutionRolePolicy']);
    await ok('aws ecs create-cluster --cluster-name c1');
    return (await subnets()).slice(0, 2);
  };
  const netcfg = (s: string[], pub = 'ENABLED') => `--network-configuration "awsvpcConfiguration={subnets=[${s.join(',')}],assignPublicIp=${pub}}"`;

  it('valida CPU/memoria de Fargate y el modo de red', async () => {
    await base();
    sh.fs.writeFile('/tmp/td.json', taskDef('nginx:1.25', { cpu: '256', memory: '4096' }));
    await bad('aws ecs register-task-definition --cli-input-json file:///tmp/td.json', /No Fargate configuration exists/);
    sh.fs.writeFile('/tmp/td.json', taskDef('nginx:1.25', { networkMode: 'bridge' }));
    await bad('aws ecs register-task-definition --cli-input-json file:///tmp/td.json', /awsvpc|InvalidParameterException/);
    sh.fs.writeFile('/tmp/td.json', taskDef('nginx:1.25'));
    expect(await json('aws ecs register-task-definition --cli-input-json file:///tmp/td.json --query taskDefinition.revision')).toBe(1);
    expect(await json('aws ecs register-task-definition --cli-input-json file:///tmp/td.json --query taskDefinition.revision')).toBe(2);
    expect((await json('aws ecs list-task-definitions')).taskDefinitionArns).toHaveLength(2);
  });

  it('un servicio crea sus tareas, las repone si se detienen y borra con --force', async () => {
    const subs = await base();
    sh.fs.writeFile('/tmp/td.json', taskDef('nginx:1.25'));
    await ok('aws ecs register-task-definition --cli-input-json file:///tmp/td.json');
    await ok(`aws ecs create-service --cluster c1 --service-name s1 --task-definition web --desired-count 2 --launch-type FARGATE ${netcfg(subs)}`);
    await ok('aws ecs wait services-stable --cluster c1 --services s1');
    const d = await json('aws ecs describe-services --cluster c1 --services s1');
    expect(d.services[0].runningCount).toBe(2);
    expect(d.services[0].deployments[0].rolloutState).toBe('COMPLETED');
    const arns = (await json('aws ecs list-tasks --cluster c1')).taskArns as string[];
    expect(arns).toHaveLength(2);
    await ok(`aws ecs stop-task --cluster c1 --task ${arns[0]}`);
    await ok('aws ecs wait services-stable --cluster c1 --services s1');
    expect((await json('aws ecs describe-services --cluster c1 --services s1')).services[0].runningCount).toBe(2);
    await ok('aws ecs update-service --cluster c1 --service s1 --desired-count 4');
    await ok('aws ecs wait services-stable --cluster c1 --services s1');
    expect((await json('aws ecs list-tasks --cluster c1')).taskArns).toHaveLength(4);
    await bad('aws ecs delete-cluster --cluster c1', /ClusterContainsServicesException|contains/);
    await ok('aws ecs delete-service --cluster c1 --service s1 --force');
    await bad('aws ecs create-service --cluster nada --service-name s --task-definition web --desired-count 1', /ClusterNotFoundException/);
  });

  it('imagen inexistente en ECR: CannotPullContainerError y se corrige con una nueva revisión', async () => {
    const subs = await base();
    await ok('aws ecr create-repository --repository-name web');
    await ok(`aws ecr get-login-password | docker login --username AWS --password-stdin ${REG()}`);
    await ok('docker pull nginx:1.25'); await ok(`docker tag nginx:1.25 ${REG()}/web:1.0`); await ok(`docker push ${REG()}/web:1.0`);
    sh.fs.writeFile('/tmp/td.json', taskDef(`${REG()}/web:2.0`));
    await ok('aws ecs register-task-definition --cli-input-json file:///tmp/td.json');
    await ok(`aws ecs create-service --cluster c1 --service-name s1 --task-definition web --desired-count 1 --launch-type FARGATE ${netcfg(subs)}`);
    const ev = await json('aws ecs describe-services --cluster c1 --services s1 --query "services[0].events[].message"');
    expect(ev.join('\n')).toMatch(/unable to keep the task running|failed to start/);
    const stopped = (await json('aws ecs list-tasks --cluster c1 --desired-status STOPPED')).taskArns[0];
    const t = await json(`aws ecs describe-tasks --cluster c1 --tasks ${stopped}`);
    expect(t.tasks[0].containers[0].reason).toMatch(/CannotPullContainerError.*not found/);
    sh.fs.writeFile('/tmp/td.json', taskDef(`${REG()}/web:1.0`));
    await ok('aws ecs register-task-definition --cli-input-json file:///tmp/td.json');
    await ok('aws ecs update-service --cluster c1 --service s1 --task-definition web');
    await ok('aws ecs wait services-stable --cluster c1 --services s1');
    expect((await json('aws ecs describe-services --cluster c1 --services s1')).services[0].runningCount).toBe(1);
  });

  it('sin rol de ejecución no se puede descargar de ECR, y una subred sin salida falla con ResourceInitializationError', async () => {
    await base();
    await ok('aws ecr create-repository --repository-name web');
    await ok(`aws ecr get-login-password | docker login --username AWS --password-stdin ${REG()}`);
    await ok('docker pull nginx:1.25'); await ok(`docker tag nginx:1.25 ${REG()}/web:1.0`); await ok(`docker push ${REG()}/web:1.0`);
    const vpc = await json('aws ec2 create-vpc --cidr-block 10.50.0.0/16');
    const sn = await json(`aws ec2 create-subnet --vpc-id ${vpc.Vpc.VpcId} --cidr-block 10.50.1.0/24`);
    sh.fs.writeFile('/tmp/td.json', taskDef(`${REG()}/web:1.0`));
    await ok('aws ecs register-task-definition --cli-input-json file:///tmp/td.json');
    await ok(`aws ecs create-service --cluster c1 --service-name priv --task-definition web --desired-count 1 --launch-type FARGATE ${netcfg([sn.Subnet.SubnetId], 'DISABLED')}`);
    const stopped = (await json('aws ecs list-tasks --cluster c1 --desired-status STOPPED')).taskArns[0];
    const t = await json(`aws ecs describe-tasks --cluster c1 --tasks ${stopped}`);
    expect(t.tasks[0].stoppedReason + JSON.stringify(t.tasks[0].containers)).toMatch(/ResourceInitializationError|CannotPullContainerError/);
  });

  it('detrás de un ALB con grupo de destino ip: destinos healthy y curl responde; con target-type instance se rechaza', async () => {
    const subs = await base();
    const vpc = (await json('aws ec2 describe-vpcs --filters Name=is-default,Values=true --query "Vpcs[0].VpcId"')) as string;
    const sg = (await json(`aws ec2 create-security-group --group-name web --description web --vpc-id ${vpc}`)).GroupId as string;
    await ok(`aws ec2 authorize-security-group-ingress --group-id ${sg} --protocol tcp --port 80 --cidr 0.0.0.0/0`);
    const tgI = await json(`aws elbv2 create-target-group --name tg-inst --protocol HTTP --port 80 --vpc-id ${vpc}`);
    const tg = (await json(`aws elbv2 create-target-group --name tg-ip --protocol HTTP --port 80 --vpc-id ${vpc} --target-type ip`)).TargetGroups[0].TargetGroupArn as string;
    const lb = (await json(`aws elbv2 create-load-balancer --name alb --subnets ${subs.join(' ')} --security-groups ${sg}`)).LoadBalancers[0];
    await ok(`aws elbv2 create-listener --load-balancer-arn ${lb.LoadBalancerArn} --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=${tg}`);
    sh.fs.writeFile('/tmp/td.json', taskDef('nginx:1.25'));
    await ok('aws ecs register-task-definition --cli-input-json file:///tmp/td.json');
    await bad(`aws ecs create-service --cluster c1 --service-name x --task-definition web --desired-count 1 --launch-type FARGATE ${netcfg(subs)} --load-balancers targetGroupArn=${tgI.TargetGroups[0].TargetGroupArn},containerName=web,containerPort=80`, /target group|InvalidParameterException/i);
    await ok(`aws ecs create-service --cluster c1 --service-name s1 --task-definition web --desired-count 2 --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[${subs.join(',')}],securityGroups=[${sg}],assignPublicIp=ENABLED}" --load-balancers targetGroupArn=${tg},containerName=web,containerPort=80`);
    await ok('aws ecs wait services-stable --cluster c1 --services s1');
    const h = await json(`aws elbv2 describe-target-health --target-group-arn ${tg}`);
    expect(h.TargetHealthDescriptions).toHaveLength(2);
    expect(h.TargetHealthDescriptions.every((x: any) => x.TargetHealth.State === 'healthy')).toBe(true);
    expect(await ok(`curl -s http://${lb.DNSName}`)).toContain('nginx');
    await bad(`aws elbv2 delete-target-group --target-group-arn ${tg}`, /ResourceInUse|in use/i);
  });
});

describe('EKS y kubectl', () => {
  const cluster = async (name = 'dev', nodes = 2) => {
    await role('eks-c', 'eks.amazonaws.com', ['AmazonEKSClusterPolicy']);
    await role('eks-n', 'ec2.amazonaws.com', ['AmazonEKSWorkerNodePolicy', 'AmazonEKS_CNI_Policy', 'AmazonEC2ContainerRegistryReadOnly']);
    const subs = (await subnets()).slice(0, 2);
    await ok(`aws eks create-cluster --name ${name} --role-arn arn:aws:iam::${ACC()}:role/eks-c --resources-vpc-config subnetIds=${subs.join(',')}`);
    await ok(`aws eks wait cluster-active --name ${name}`);
    if (nodes) {
      await ok(`aws eks create-nodegroup --cluster-name ${name} --nodegroup-name ng --node-role arn:aws:iam::${ACC()}:role/eks-n --subnets ${subs.join(' ')} --scaling-config minSize=1,maxSize=5,desiredSize=${nodes} --instance-types t3.medium`);
      await ok(`aws eks wait nodegroup-active --cluster-name ${name} --nodegroup-name ng`);
    }
    await ok(`aws eks update-kubeconfig --name ${name}`);
    return subs;
  };
  const apply = async (yaml: string, file = '/tmp/m.yaml') => { sh.fs.writeFile(file, yaml); return run(`kubectl apply -f ${file}`); };
  const dep = (name: string, image: string, replicas = 2, extra = '') => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
spec:
  replicas: ${replicas}
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
    spec:
      containers:
      - name: c
        image: ${image}
${extra}`;

  it('el clúster pasa de CREATING a ACTIVE con tiempo real; el rol incorrecto se rechaza', async () => {
    await role('eks-c', 'eks.amazonaws.com', ['AmazonEKSClusterPolicy']);
    await role('malo', 'ec2.amazonaws.com', []);
    const subs = (await subnets()).slice(0, 2);
    await bad(`aws eks create-cluster --name x --role-arn arn:aws:iam::${ACC()}:role/malo --resources-vpc-config subnetIds=${subs.join(',')}`, /InvalidParameterException/);
    await bad(`aws eks create-cluster --name x --role-arn arn:aws:iam::${ACC()}:role/eks-c --resources-vpc-config subnetIds=${subs[0]}`, /at least two subnets|InvalidParameterException/);
    st.settings.speed = 'fast';
    const c = await json(`aws eks create-cluster --name y --role-arn arn:aws:iam::${ACC()}:role/eks-c --resources-vpc-config subnetIds=${subs.join(',')}`);
    expect(c.cluster.status).toBe('CREATING');
    await bad('aws eks create-nodegroup --cluster-name y --nodegroup-name ng --node-role arn:aws:iam::1:role/r --subnets ' + subs.join(' '), /ResourceInUseException|not ACTIVE|InvalidParameterException/);
    st.settings.speed = 'instant';
    expect(await json('aws eks describe-cluster --name y --query cluster.status')).toBe('ACTIVE');
  });

  it('un nodegroup sin políticas en el rol queda en CREATE_FAILED con el motivo', async () => {
    await role('eks-c', 'eks.amazonaws.com', ['AmazonEKSClusterPolicy']);
    await role('nodo-pobre', 'ec2.amazonaws.com', ['AmazonEKSWorkerNodePolicy']);
    const subs = (await subnets()).slice(0, 2);
    await ok(`aws eks create-cluster --name dev --role-arn arn:aws:iam::${ACC()}:role/eks-c --resources-vpc-config subnetIds=${subs.join(',')}`);
    await ok('aws eks wait cluster-active --name dev');
    await ok(`aws eks create-nodegroup --cluster-name dev --nodegroup-name ng --node-role arn:aws:iam::${ACC()}:role/nodo-pobre --subnets ${subs.join(' ')}`);
    const g = await json('aws eks describe-nodegroup --cluster-name dev --nodegroup-name ng --query nodegroup');
    expect(g.status).toBe('CREATE_FAILED');
    expect(JSON.stringify(g.health.issues)).toMatch(/AmazonEKS_CNI_Policy|NodeCreationFailure/);
  });

  it('el nodegroup crea instancias EC2 reales y kubectl get nodes las lista', async () => {
    await cluster();
    const inst = await json('aws ec2 describe-instances --filters Name=tag:eks:cluster-name,Values=dev --query "Reservations[].Instances[].InstanceId"');
    expect(inst).toHaveLength(2);
    const out = await ok('kubectl get nodes');
    expect(out).toMatch(/^NAME\s+STATUS\s+ROLES\s+AGE\s+VERSION/);
    expect(out.match(/\sReady\s/g)).toHaveLength(2);
    expect(await ok('kubectl config current-context')).toContain('cluster/dev');
    await ok('aws eks update-nodegroup-config --cluster-name dev --nodegroup-name ng --scaling-config minSize=1,maxSize=5,desiredSize=3');
    await ok('aws eks wait nodegroup-active --cluster-name dev --nodegroup-name ng');
    expect((await ok('kubectl get nodes')).match(/\sReady\s/g)).toHaveLength(3);
  });

  it('sin kubeconfig kubectl no se conecta; con otro usuario sin acceso da Unauthorized', async () => {
    const r = await run('kubectl get pods');
    expect(r.err).toContain('The connection to the server localhost:8080 was refused');
    await cluster();
    await ok('aws iam create-user --user-name otro');
    const k = await json('aws iam create-access-key --user-name otro');
    await ok(`aws configure set aws_access_key_id ${k.AccessKey.AccessKeyId} --profile otro`);
    await ok(`aws configure set aws_secret_access_key ${k.AccessKey.SecretAccessKey} --profile otro`);
    await ok('aws configure set region eu-west-1 --profile otro');
    await bad('AWS_PROFILE=otro kubectl get pods', /Unauthorized|You must be logged in/);
  });

  it('apply de un Deployment con Service LoadBalancer: pods, rollout, escalado y dos aplicaciones idempotentes', async () => {
    await cluster();
    const y = dep('web', 'nginx:1.25', 3, '        ports:\n        - containerPort: 80\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: web\nspec:\n  type: LoadBalancer\n  selector:\n    app: web\n  ports:\n  - port: 80\n    targetPort: 80\n');
    const a = await apply(y);
    expect(a.out).toBe('deployment.apps/web created\nservice/web created\n');
    expect((await apply(y)).out).toBe('deployment.apps/web unchanged\nservice/web unchanged\n');
    expect(await ok('kubectl rollout status deployment/web')).toContain('successfully rolled out');
    const pods = await ok('kubectl get pods');
    expect(pods.match(/web-[a-z0-9]+-[a-z0-9]{5}\s+1\/1\s+Running/g)).toHaveLength(3);
    expect(await ok('kubectl get deploy')).toMatch(/web\s+3\/3\s+3\s+3/);
    const svc = await ok('kubectl get svc');
    expect(svc).toMatch(/web\s+LoadBalancer\s+10\.100\.\d+\.\d+\s+\S+\.elb\.amazonaws\.com\s+80:\d+\/TCP/);
    expect(await ok('kubectl scale deployment web --replicas=5')).toBe('deployment.apps/web scaled\n');
    expect(await ok('kubectl get deploy')).toMatch(/web\s+5\/5/);
    expect(await ok('kubectl get deploy web -o jsonpath={.spec.replicas}')).toBe('5');
    expect(await ok('kubectl get pods -o name | head -n 1')).toMatch(/^pod\/web-/);
    expect(await ok('kubectl describe deployment web')).toMatch(/Replicas:\s+5 desired \| 5 updated \| 5 total \| 5 available \| 0 unavailable/);
    await bad('kubectl get deploy noexiste', /Error from server \(NotFound\): deployments\.apps "noexiste" not found/);
    expect(await ok('kubectl delete deployment web')).toBe('deployment.apps "web" deleted\n');
    expect(await ok('kubectl get pods')).toBe('');
    expect((await run('kubectl get pods')).err).toContain('No resources found in default namespace.');
  });

  it('actualización con una imagen inexistente: ImagePullBackOff, el despliegue no progresa y rollout undo lo arregla', async () => {
    await cluster();
    await apply(dep('web', 'nginx:1.25', 3));
    await ok('kubectl set image deployment/web c=nginx:1.99');
    const pods = await ok('kubectl get pods');
    expect(pods).toMatch(/ImagePullBackOff|ErrImagePull/);
    expect(pods.match(/Running/g)!.length).toBeGreaterThanOrEqual(2); // los antiguos siguen sirviendo
    const rs = await run('kubectl rollout status deployment/web --timeout=3s');
    expect(rs.code).toBe(1);
    expect(rs.err).toContain('exceeded its progress deadline');
    const pod = (await ok('kubectl get pods -o name')).split('\n').find((l) => l) as string;
    const bro = (await ok('kubectl get pods')).split('\n').find((l) => /ImagePullBackOff|ErrImagePull/.test(l))!.split(/\s+/)[0];
    const d = await ok(`kubectl describe pod ${bro}`);
    expect(d).toMatch(/Failed to pull image "nginx:1\.99"|manifest/);
    void pod;
    await ok('kubectl rollout undo deployment/web');
    expect(await ok('kubectl rollout status deployment/web')).toContain('successfully rolled out');
    expect(await ok('kubectl get pods')).not.toMatch(/ImagePullBackOff/);
    expect(await ok('kubectl get deploy web -o jsonpath={.spec.template.spec.containers[0].image}')).toBe('nginx:1.25');
    expect(await ok('kubectl rollout history deployment/web')).toMatch(/REVISION/);
  });

  it('CreateContainerConfigError por un ConfigMap que falta, y se recupera al crearlo', async () => {
    await cluster();
    await apply(dep('api', 'nginx:1.25', 2, '        envFrom:\n        - configMapRef:\n            name: api-config\n'));
    expect(await ok('kubectl get pods')).toContain('CreateContainerConfigError');
    const name = (await ok('kubectl get pods')).split('\n')[1].split(/\s+/)[0];
    expect(await ok(`kubectl describe pod ${name}`)).toContain('api-config');
    await ok('kubectl create configmap api-config --from-literal=MODO=produccion');
    await ok('kubectl rollout restart deployment/api');
    expect(await ok('kubectl rollout status deployment/api')).toContain('successfully rolled out');
    expect(await ok('kubectl get pods')).not.toContain('CreateContainerConfigError');
    expect(await ok('kubectl get cm api-config -o jsonpath={.data.MODO}')).toBe('produccion');
  });

  it('Pending por falta de recursos: FailedScheduling, y escalar el nodegroup lo resuelve', async () => {
    await cluster('dev', 1);
    await apply(dep('grande', 'nginx:1.25', 4, '        resources:\n          requests:\n            cpu: "900m"\n'));
    const pods = await ok('kubectl get pods');
    expect(pods).toContain('Pending');
    const name = pods.split('\n').find((l) => l.includes('Pending'))!.split(/\s+/)[0];
    expect(await ok(`kubectl describe pod ${name}`)).toMatch(/FailedScheduling[\s\S]*Insufficient cpu/);
    await ok('aws eks update-nodegroup-config --cluster-name dev --nodegroup-name ng --scaling-config minSize=1,maxSize=5,desiredSize=3');
    await ok('aws eks wait nodegroup-active --cluster-name dev --nodegroup-name ng');
    expect(await ok('kubectl get pods')).not.toContain('Pending');
  });

  it('namespaces, -n, -A, kubectl create/run/expose, exec y errores de manifiesto', async () => {
    await cluster();
    await ok('kubectl create namespace tienda');
    await bad('kubectl create namespace tienda', /AlreadyExists/);
    await ok('kubectl create deployment api --image=nginx:1.25 --replicas=2 -n tienda');
    expect(await ok('kubectl get pods -n tienda')).toMatch(/api-/);
    expect(await ok('kubectl get pods')).toBe('');
    expect(await ok('kubectl get pods -A')).toMatch(/NAMESPACE\s+NAME/);
    await ok('kubectl expose deployment api --port=80 -n tienda');
    expect(await ok('kubectl get svc -n tienda')).toMatch(/api\s+ClusterIP/);
    await ok('kubectl run tmp --image=alpine:3.20');
    expect(await ok('kubectl get pods')).toMatch(/tmp\s+/);
    const bad1 = await apply('apiVersion: v1\nkind: Podd\nmetadata:\n  name: x\n');
    expect(bad1.code).toBe(1);
    expect(bad1.err).toMatch(/no matches for kind "Podd"/);
    const bad2 = await apply(dep('mal', 'nginx:1.25').replace('app: mal\n  template', 'app: otro\n  template'));
    expect(bad2.err).toMatch(/selector/);
    await bad('kubectl delete namespace nada', /NotFound/);
    await ok('kubectl delete namespace tienda');
    expect(await ok('kubectl get ns')).not.toContain('tienda');
  });

  it('IAM: sin eks:DescribeCluster update-kubeconfig falla con AccessDenied', async () => {
    await cluster();
    await ok('aws iam create-user --user-name sin');
    const k = await json('aws iam create-access-key --user-name sin');
    await ok(`aws configure set aws_access_key_id ${k.AccessKey.AccessKeyId} --profile sin`);
    await ok(`aws configure set aws_secret_access_key ${k.AccessKey.SecretAccessKey} --profile sin`);
    await ok('aws configure set region eu-west-1 --profile sin');
    await bad('aws eks describe-cluster --name dev --profile sin', /AccessDeniedException|not authorized/);
  });

  it('eliminar: el clúster con nodegroups no se puede borrar y luego sí; las instancias se terminan', async () => {
    await cluster();
    await bad('aws eks delete-cluster --name dev', /ResourceInUseException/);
    await ok('aws eks delete-nodegroup --cluster-name dev --nodegroup-name ng');
    await ok('aws eks wait nodegroup-deleted --cluster-name dev --nodegroup-name ng');
    expect(await json('aws ec2 describe-instances --filters Name=tag:eks:cluster-name,Values=dev Name=instance-state-name,Values=running --query "Reservations[].Instances[].InstanceId"')).toHaveLength(0);
    await ok('aws eks delete-cluster --name dev');
    await ok('aws eks wait cluster-deleted --name dev');
    await bad('aws eks describe-cluster --name dev', /ResourceNotFoundException/);
  });
});

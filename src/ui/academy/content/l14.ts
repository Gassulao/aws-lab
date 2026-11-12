import { SAA_DOMAINS, type Level, type Step } from '../types';
import { prep } from '../setup';
import type { CheckCtx } from '../checks';
import { bucketBlocksAllPublic, bucketRequiresTls } from '../../../engine/services/govFindings';
import { targetHealth } from '../../../engine/services/elbv2';
import arquitectura from './l14/1-arquitectura-defensa.md?raw';
import identidad from './l14/2-minimo-privilegio-cifrado.md?raw';
import observabilidad from './l14/3-observabilidad-auditoria.md?raw';
import verificar from './l14/4-verificar-y-repetir.md?raw';

const AMI = 'ami-0a1b2c3d4e5f60001';
const Q = (s: string) => `'${s}'`;
const ACC = 'ACC=$(aws sts get-caller-identity --query Account --output text)';
const PAB = 'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true';
const tag = (kind: string, name: string) => Q(`ResourceType=${kind},Tags=[{Key=Name,Value=${name}}]`);

// ---------------------------------------------------------------- fases (se reutilizan en el reto final)
/** Fase 1: la red por capas en dos zonas. */
const NET = [
  `VPC=$(aws ec2 create-vpc --cidr-block 10.50.0.0/16 --tag-specifications ${tag('vpc', 'tienda')} --query Vpc.VpcId --output text)`,
  'IGW=$(aws ec2 create-internet-gateway --query InternetGateway.InternetGatewayId --output text)',
  'aws ec2 attach-internet-gateway --internet-gateway-id $IGW --vpc-id $VPC',
  'RT=$(aws ec2 create-route-table --vpc-id $VPC --query RouteTable.RouteTableId --output text)',
  'aws ec2 create-route --route-table-id $RT --destination-cidr-block 0.0.0.0/0 --gateway-id $IGW',
  `PUBA=$(aws ec2 create-subnet --vpc-id $VPC --cidr-block 10.50.1.0/24 --availability-zone eu-west-1a --tag-specifications ${tag('subnet', 'pub-a')} --query Subnet.SubnetId --output text)`,
  `PUBB=$(aws ec2 create-subnet --vpc-id $VPC --cidr-block 10.50.2.0/24 --availability-zone eu-west-1b --tag-specifications ${tag('subnet', 'pub-b')} --query Subnet.SubnetId --output text)`,
  `PRIVA=$(aws ec2 create-subnet --vpc-id $VPC --cidr-block 10.50.11.0/24 --availability-zone eu-west-1a --tag-specifications ${tag('subnet', 'priv-a')} --query Subnet.SubnetId --output text)`,
  `PRIVB=$(aws ec2 create-subnet --vpc-id $VPC --cidr-block 10.50.12.0/24 --availability-zone eu-west-1b --tag-specifications ${tag('subnet', 'priv-b')} --query Subnet.SubnetId --output text)`,
  'aws ec2 associate-route-table --route-table-id $RT --subnet-id $PUBA',
  'aws ec2 associate-route-table --route-table-id $RT --subnet-id $PUBB',
];
/** Recupera la red de la fase 1 por nombre (las variables de la preparación no se conservan). */
const subnetVar = (v: string, name: string) => `${v}=$(aws ec2 describe-subnets --filters Name=tag:Name,Values=${name} --query ${Q('Subnets[0].SubnetId')} --output text)`;
const LOOKUP_NET = [
  `VPC=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=tienda --query ${Q('Vpcs[0].VpcId')} --output text)`,
  subnetVar('PUBA', 'pub-a'), subnetVar('PUBB', 'pub-b'), subnetVar('PRIVA', 'priv-a'), subnetVar('PRIVB', 'priv-b'),
];
const TRUST = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}';
const web = (n: number, sub: string) =>
  `W${n}=$(aws ec2 run-instances --image-id ${AMI} --instance-type t3.micro --subnet-id $${sub} --security-group-ids $WEBSG --iam-instance-profile Name=web-profile --metadata-options HttpTokens=required,HttpEndpoint=enabled --user-data 'yum install -y httpd' --tag-specifications ${tag('instance', `web-${n}`)} --query Instances[0].InstanceId --output text)`;
/** Fase 2: grupos de seguridad en cadena, rol de instancia, servidores privados y balanceador. */
const COMPUTE = [
  'ALBSG=$(aws ec2 create-security-group --group-name alb-sg --description "Balanceador" --vpc-id $VPC --query GroupId --output text)',
  'aws ec2 authorize-security-group-ingress --group-id $ALBSG --protocol tcp --port 80 --cidr 0.0.0.0/0',
  'WEBSG=$(aws ec2 create-security-group --group-name web-sg --description "Servidores web" --vpc-id $VPC --query GroupId --output text)',
  'aws ec2 authorize-security-group-ingress --group-id $WEBSG --protocol tcp --port 80 --source-group $ALBSG',
  `aws iam create-role --role-name web-role --assume-role-policy-document '${TRUST}'`,
  'aws iam create-instance-profile --instance-profile-name web-profile',
  'aws iam add-role-to-instance-profile --instance-profile-name web-profile --role-name web-role',
  web(1, 'PRIVA'),
  web(2, 'PRIVB'),
  'TG=$(aws elbv2 create-target-group --name web-tg --protocol HTTP --port 80 --vpc-id $VPC --health-check-interval-seconds 5 --health-check-timeout-seconds 2 --healthy-threshold-count 2 --query TargetGroups[0].TargetGroupArn --output text)',
  'aws elbv2 register-targets --target-group-arn $TG --targets Id=$W1 Id=$W2',
  'LB=$(aws elbv2 create-load-balancer --name tienda-alb --subnets $PUBA $PUBB --security-groups $ALBSG --scheme internet-facing --query LoadBalancers[0].LoadBalancerArn --output text)',
  'aws elbv2 create-listener --load-balancer-arn $LB --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=$TG',
  'sleep 30',
  'aws elbv2 describe-target-health --target-group-arn $TG --query TargetHealthDescriptions[].TargetHealth.State --output text',
  'DNS=$(aws elbv2 describe-load-balancers --names tienda-alb --query LoadBalancers[0].DNSName --output text)',
  'curl -s http://$DNS',
];
const BUCKET = 'B=tienda-datos-$ACC';
const SSE = `{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms","KMSMasterKeyID":"alias/tienda-datos"}}]}`;
const TLS_POLICY = `{"Version":"2012-10-17","Statement":[{"Sid":"SoloTLS","Effect":"Deny","Principal":"*","Action":"s3:*","Resource":["arn:aws:s3:::'$B'","arn:aws:s3:::'$B'/*"],"Condition":{"Bool":{"aws:SecureTransport":"false"}}}]}`;
const ROLE_POLICY = `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject"],"Resource":"arn:aws:s3:::'$B'/*"},{"Effect":"Allow","Action":["kms:Decrypt","kms:GenerateDataKey"],"Resource":"arn:aws:kms:eu-west-1:'$ACC':key/'$KEY'"}]}`;
/** Fase 3: clave KMS, bucket de datos endurecido y permisos mínimos para el rol. */
const DATA = [
  'KEY=$(aws kms create-key --description "Datos de la tienda" --query KeyMetadata.KeyId --output text)',
  'aws kms create-alias --alias-name alias/tienda-datos --target-key-id $KEY',
  'aws kms enable-key-rotation --key-id $KEY',
  BUCKET,
  'aws s3api create-bucket --bucket $B --create-bucket-configuration LocationConstraint=eu-west-1',
  `aws s3api put-public-access-block --bucket $B --public-access-block-configuration ${PAB}`,
  `aws s3api put-bucket-encryption --bucket $B --server-side-encryption-configuration '${SSE}'`,
  'aws s3api put-bucket-versioning --bucket $B --versioning-configuration Status=Enabled',
  `aws s3api put-bucket-policy --bucket $B --policy '${TLS_POLICY}'`,
  `aws iam put-role-policy --role-name web-role --policy-name datos --policy-document '${ROLE_POLICY}'`,
];
const LOOKUP_DATA = [ACC, "KEY=$(aws kms describe-key --key-id alias/tienda-datos --query KeyMetadata.KeyId --output text)"];
const TRAIL_POLICY = `{"Version":"2012-10-17","Statement":[{"Sid":"Acl","Effect":"Allow","Principal":{"Service":"cloudtrail.amazonaws.com"},"Action":"s3:GetBucketAcl","Resource":"arn:aws:s3:::'$L'"},{"Sid":"Escritura","Effect":"Allow","Principal":{"Service":"cloudtrail.amazonaws.com"},"Action":"s3:PutObject","Resource":"arn:aws:s3:::'$L'/AWSLogs/*","Condition":{"StringEquals":{"s3:x-amz-acl":"bucket-owner-full-control"}}}]}`;
const alarm = (n: number) =>
  `aws cloudwatch put-metric-alarm --alarm-name cpu-web-${n} --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value=$W${n} --statistic Average --period 300 --evaluation-periods 1 --threshold 80 --comparison-operator GreaterThanThreshold --alarm-actions $TOPIC`;
/** Fase 4: CloudTrail multirregión y alarmas con aviso. */
const AUDIT = [
  'L=tienda-logs-$ACC',
  'aws s3api create-bucket --bucket $L --create-bucket-configuration LocationConstraint=eu-west-1',
  `aws s3api put-public-access-block --bucket $L --public-access-block-configuration ${PAB}`,
  `aws s3api put-bucket-policy --bucket $L --policy '${TRAIL_POLICY}'`,
  'aws cloudtrail create-trail --name tienda-trail --s3-bucket-name $L --is-multi-region-trail --enable-log-file-validation',
  'aws cloudtrail start-logging --name tienda-trail',
  'TOPIC=$(aws sns create-topic --name alertas-seguridad --query TopicArn --output text)',
  'aws sns subscribe --topic-arn $TOPIC --protocol email --notification-endpoint ops@example.com',
  alarm(1),
  alarm(2),
];
const instVar = (v: string, name: string) => `${v}=$(aws ec2 describe-instances --filters Name=tag:Name,Values=${name} --query ${Q('Reservations[0].Instances[0].InstanceId')} --output text)`;
const LOOKUP_AUDIT = [ACC, instVar('W1', 'web-1'), instVar('W2', 'web-2')];

// ---------------------------------------------------------------- comprobaciones (true o el motivo del fallo)
type R = true | string;
const vpcOf = (c: CheckCtx) => c.vpc('tienda');
const bucketOf = (c: CheckCtx) => c.bucketLike(/^tienda-datos-/);
const cmk = (c: CheckCtx) => c.kmsKey('alias/tienda-datos');
const webs = (c: CheckCtx) => c.instances((i) => /^web-/.test(i.tags.Name ?? ''));

const netOk = (c: CheckCtx): R => {
  const v = vpcOf(c);
  if (!v) return 'Falta la VPC `tienda` (10.50.0.0/16) con la etiqueta Name=tienda.';
  const subs = c.subnets(v.id);
  const pub = subs.filter((s) => c.isPublic(s));
  const priv = subs.filter((s) => !c.isPublic(s));
  if (pub.length < 2 || new Set(pub.map((s) => s.az)).size < 2) return 'Necesitas al menos dos subredes públicas en zonas distintas (ruta 0.0.0.0/0 al IGW).';
  if (priv.length < 2 || new Set(priv.map((s) => s.az)).size < 2) return 'Necesitas al menos dos subredes privadas en zonas distintas (sin ruta al IGW).';
  return true;
};
const sgOk = (c: CheckCtx): R => {
  const v = vpcOf(c);
  const alb = v && c.sg('alb-sg', v.id);
  const web = v && c.sg('web-sg', v.id);
  if (!v || !alb || !web) return 'Crea los grupos de seguridad alb-sg y web-sg en la VPC tienda.';
  if (!web.ingress.length || web.ingress.some((r) => r.cidr || r.sourceSg !== alb.id || r.from > 80 || r.to < 80)) return 'web-sg solo debe aceptar el puerto 80 con origen el grupo alb-sg (sin CIDR).';
  const open = c.s.securityGroups.filter((g) => g.vpcId === v.id).flatMap((g) => g.ingress.filter((r) => r.cidr === '0.0.0.0/0' && !(r.protocol === 'tcp' && r.from === r.to && [80, 443].includes(r.from))));
  return open.length === 0 || 'Hay reglas abiertas a 0.0.0.0/0 distintas de HTTP/HTTPS en el balanceador (22, 3389, rangos…).';
};
const computeOk = (c: CheckCtx): R => {
  const v = vpcOf(c);
  const w = webs(c);
  if (!v || w.length < 2) return 'Lanza dos servidores web-1 y web-2 en la VPC tienda.';
  const priv = new Set(c.subnets(v.id).filter((s) => !c.isPublic(s)).map((s) => s.id));
  if (!w.every((i) => priv.has(i.subnetId))) return 'Los servidores deben estar en subredes privadas.';
  if (new Set(w.map((i) => i.az)).size < 2) return 'Reparte los servidores en dos zonas de disponibilidad.';
  if (w.some((i) => i.publicIp)) return 'Los servidores no deben tener IP pública.';
  if (w.some((i) => i.httpTokens !== 'required')) return 'Exige IMDSv2 (HttpTokens=required) en los servidores.';
  if (!w.every((i) => (i.iamInstanceProfile ?? '').includes('web-profile'))) return 'Asocia el perfil de instancia web-profile a los servidores.';
  const web = c.sg('web-sg', v.id);
  return (!!web && w.every((i) => i.securityGroupIds.includes(web.id))) || 'Los servidores deben usar el grupo de seguridad web-sg.';
};
const albOk = (c: CheckCtx): R => {
  const v = vpcOf(c);
  const lb = c.lb('tienda-alb');
  if (!v || !lb) return 'Falta el balanceador tienda-alb.';
  const pubIds = c.subnets(v.id).filter((s) => c.isPublic(s)).map((s) => s.id);
  if (lb.scheme !== 'internet-facing' || lb.subnets.length < 2 || !lb.subnets.every((s) => pubIds.includes(s))) return 'tienda-alb debe ser internet-facing y estar en las dos subredes públicas.';
  const alb = c.sg('alb-sg', v.id);
  if (!alb || !lb.securityGroups.includes(alb.id)) return 'tienda-alb debe usar el grupo de seguridad alb-sg.';
  const l = c.s.listeners.find((x) => x.lbArn === lb.arn && x.port === 80);
  const tg = c.s.targetGroups.find((g) => g.arn === l?.tgArn);
  if (!l || !tg) return 'Falta un oyente HTTP:80 que reenvíe a un grupo de destino.';
  const st = Object.values(c.targetStates(tg.name));
  if (st.length < 2) return 'Registra los dos servidores en el grupo de destino.';
  return st.every((x) => x === 'healthy') || 'Los destinos todavía no están healthy.';
};
const kmsOk = (c: CheckCtx): R => {
  const k = cmk(c);
  if (!k || k.manager !== 'CUSTOMER') return 'Crea una clave KMS gestionada por el cliente con el alias alias/tienda-datos.';
  return (k.state === 'Enabled' && k.rotation) || 'La clave debe estar habilitada y con la rotación automática activada.';
};
const s3Ok = (c: CheckCtx): R => {
  const b = bucketOf(c);
  const k = cmk(c);
  if (!b || !k) return 'Falta el bucket tienda-datos-<cuenta> o su clave KMS.';
  if (!bucketBlocksAllPublic(b)) return 'El bucket debe tener las cuatro opciones de bloqueo de acceso público.';
  const id = b.encryption?.kmsKeyId ?? '';
  if (b.encryption?.algorithm !== 'aws:kms' || !(id.includes('tienda-datos') || id.includes(k.id))) return 'El cifrado por defecto debe ser SSE-KMS con la clave alias/tienda-datos.';
  if (b.versioning !== 'Enabled') return 'Activa el versionado del bucket.';
  return bucketRequiresTls(b) || 'La política del bucket debe denegar las peticiones sin TLS (aws:SecureTransport=false).';
};
const iamOk = (c: CheckCtx): R => {
  const b = bucketOf(c);
  const k = cmk(c);
  const r = c.role('web-role');
  if (!r || !b || !k) return 'Faltan el rol web-role, el bucket de datos o la clave.';
  if (!JSON.stringify(r.assumeRolePolicy).includes('ec2.amazonaws.com')) return 'El rol web-role debe confiar en ec2.amazonaws.com.';
  const obj = `arn:aws:s3:::${b.name}/informe.csv`;
  if (c.decide('web-role', 's3:GetObject', obj) !== 'Allow' || c.decide('web-role', 's3:PutObject', obj) !== 'Allow') return 'web-role debe poder leer y escribir objetos en el bucket de datos.';
  if (!c.kmsCan('web-role', 'kms:Decrypt', k) || !c.kmsCan('web-role', 'kms:GenerateDataKey', k)) return 'web-role necesita kms:Decrypt y kms:GenerateDataKey sobre la clave.';
  const bad: [string, string][] = [['s3:DeleteBucket', `arn:aws:s3:::${b.name}`], ['s3:GetObject', 'arn:aws:s3:::otro-bucket/x'], ['iam:CreateUser', '*'], ['kms:ScheduleKeyDeletion', k.arn]];
  const leak = bad.find(([a, res]) => c.decide('web-role', a, res) === 'Allow');
  return !leak || `Demasiados permisos: web-role no debería poder ejecutar ${leak[0]}.`;
};
const trailOk = (c: CheckCtx): R => {
  const t = c.s.trails.find((x) => x.s3Bucket.startsWith('tienda-logs-'));
  if (!t) return 'Crea un trail que entregue a un bucket tienda-logs-<cuenta>.';
  if (!t.logging) return 'El trail existe pero no está registrando: falta start-logging.';
  if (!t.multiRegion || !t.logValidation) return 'El trail debe ser multirregión y tener la validación de integridad activada.';
  const b = c.bucket(t.s3Bucket);
  return (!!b && bucketBlocksAllPublic(b)) || 'El bucket de registros debe bloquear todo el acceso público.';
};
const alarmsOk = (c: CheckCtx): R => {
  const w = webs(c);
  if (w.length < 2) return 'Faltan los servidores web.';
  for (const i of w) {
    const a = c.s.alarms.find((x) => x.metric === 'CPUUtilization' && x.dims.InstanceId === i.id);
    if (!a) return `Falta la alarma de CPUUtilization de ${i.tags.Name}.`;
    const t = c.s.topics.find((x) => a.alarmActions.includes(x.arn));
    if (!t) return `La alarma de ${i.tags.Name} no avisa a ningún tema de SNS.`;
    if (!t.subs.some((x) => x.protocol === 'email')) return `El tema ${t.name} no tiene ningún suscriptor de correo.`;
  }
  return true;
};

const vpcOnly = (c: CheckCtx): R => (vpcOf(c) ? true : 'Falta la VPC `tienda` (10.50.0.0/16) con la etiqueta Name=tienda.');
const pubOnly = (c: CheckCtx): R => {
  const v = vpcOf(c);
  if (!v) return 'Falta la VPC tienda.';
  const pub = c.subnets(v.id).filter((s) => c.isPublic(s));
  return (pub.length >= 2 && new Set(pub.map((s) => s.az)).size >= 2) || 'Necesitas al menos dos subredes públicas en zonas distintas (con ruta 0.0.0.0/0 al IGW).';
};
const privOnly = (c: CheckCtx): R => {
  const v = vpcOf(c);
  if (!v) return 'Falta la VPC tienda.';
  const priv = c.subnets(v.id).filter((s) => !c.isPublic(s));
  return (priv.length >= 2 && new Set(priv.map((s) => s.az)).size >= 2) || 'Necesitas al menos dos subredes privadas en zonas distintas (sin ruta al IGW).';
};
const trailRunning = (c: CheckCtx): R => {
  const t = c.s.trails.find((x) => x.s3Bucket.startsWith('tienda-logs-'));
  if (!t) return 'Crea un trail que entregue a un bucket tienda-logs-<cuenta>.';
  return t.logging || 'El trail existe pero no está registrando: falta start-logging.';
};
const topicOk = (c: CheckCtx): R => {
  const t = c.topic('alertas-seguridad');
  if (!t) return 'Crea el tema de SNS alertas-seguridad.';
  return t.subs.some((x) => x.protocol === 'email') || 'Suscribe un correo electrónico al tema.';
};

const step = (id: string, title: string, hint: string[], check: (c: CheckCtx) => R): Step => ({ id, title, hint, check });
const sVpc = step('vpc', 'Crea la VPC `tienda` (`10.50.0.0/16`) con la etiqueta `Name=tienda`', ["aws ec2 create-vpc --cidr-block 10.50.0.0/16 --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=tienda}]'"], vpcOnly);
const sPub = step('pub', 'Dos subredes públicas en zonas distintas: ruta `0.0.0.0/0` a un Internet Gateway', ['Subredes 10.50.1.0/24 (eu-west-1a) y 10.50.2.0/24 (eu-west-1b).', 'create-internet-gateway, attach-internet-gateway, create-route-table, create-route y associate-route-table.'], pubOnly);
const sPriv = step('priv', 'Dos subredes privadas en zonas distintas, **sin** ruta al Internet Gateway', ['Subredes 10.50.11.0/24 (eu-west-1a) y 10.50.12.0/24 (eu-west-1b).', 'No las asocies a la tabla de rutas pública: usarán la tabla principal, que no sale a internet.'], privOnly);
const sNet = step('net', 'Red: VPC `tienda`, dos subredes públicas y dos privadas en zonas distintas', ['VPC 10.50.0.0/16 con Name=tienda; subredes 10.50.1.0/24 y 10.50.2.0/24 (públicas), 10.50.11.0/24 y 10.50.12.0/24 (privadas).', 'Solo las públicas se asocian a la tabla de rutas con 0.0.0.0/0 hacia el Internet Gateway.'], netOk);
const sSg = step('sg', 'Grupos de seguridad en cadena: `alb-sg` (80 desde internet) y `web-sg` (80 solo desde `alb-sg`)', ['aws ec2 authorize-security-group-ingress --group-id $WEBSG --protocol tcp --port 80 --source-group $ALBSG', 'Nada más abierto a 0.0.0.0/0: ni 22 ni 3389.'], sgOk);
const sCompute = step('compute', 'Cómputo: dos servidores en subredes privadas de zonas distintas, sin IP pública, con IMDSv2 y perfil `web-profile`', ['--metadata-options HttpTokens=required y --iam-instance-profile Name=web-profile en run-instances.', 'Crea antes el rol web-role (confianza ec2.amazonaws.com) y su perfil de instancia.'], computeOk);
const sAlb = step('alb', 'Balanceo: `tienda-alb` internet-facing en las subredes públicas, oyente 80 y los dos destinos `healthy`', ['aws elbv2 create-target-group, register-targets, create-load-balancer y create-listener.', 'Crea el grupo con `--health-check-interval-seconds 5 --health-check-timeout-seconds 2 --healthy-threshold-count 2` para no esperar 2,5 minutos; después repite describe-target-health hasta ver healthy.'], albOk);
const sKms = step('kms', 'Clave KMS gestionada por el cliente `alias/tienda-datos` con rotación automática', ['aws kms create-key; create-alias; enable-key-rotation.'], kmsOk);
const sS3 = step('s3', 'Bucket `tienda-datos-<cuenta>`: bloqueo público total, SSE-KMS con tu clave, versionado y TLS obligatorio', ['put-public-access-block, put-bucket-encryption, put-bucket-versioning y put-bucket-policy.', 'TLS obligatorio: Deny con Condition Bool aws:SecureTransport=false.'], s3Ok);
const sIam = step('iam', 'Mínimo privilegio: `web-role` lee y escribe solo en su bucket, usa solo su clave y nada más', ['Acciones s3:GetObject y s3:PutObject sobre arn:aws:s3:::<bucket>/*; kms:Decrypt y kms:GenerateDataKey sobre la clave.', 'Prueba lo que no debe poder: s3:DeleteBucket, iam:CreateUser, otros buckets.'], iamOk);
const sTrailRun = step('trailrun', 'Crea el trail `tienda-trail` hacia `tienda-logs-<cuenta>` e **inícialo**', ['El bucket necesita una política que permita a cloudtrail.amazonaws.com GetBucketAcl y PutObject.', 'aws cloudtrail create-trail --name tienda-trail --s3-bucket-name <bucket> y después start-logging.'], trailRunning);
const sTopic = step('topic', 'Crea el tema `alertas-seguridad` y suscribe tu correo', ['aws sns create-topic --name alertas-seguridad', 'aws sns subscribe --topic-arn <arn> --protocol email --notification-endpoint ops@example.com'], topicOk);
const sTrail = step('trail', 'Auditoría: trail multirregión con validación, **iniciado**, hacia un bucket `tienda-logs-<cuenta>` privado', ['El bucket necesita una política que permita a cloudtrail.amazonaws.com GetBucketAcl y PutObject.', 'create-trail --is-multi-region-trail --enable-log-file-validation y después start-logging.'], trailOk);
const sAlarms = step('alarms', 'Alarmas: `CPUUtilization` > 80 por servidor, con acción hacia un tema de SNS con suscriptor de correo', ['aws sns create-topic y subscribe --protocol email', 'aws cloudwatch put-metric-alarm ... --alarm-actions <tema>'], alarmsOk);

const realWorldCommon = 'En una cuenta real esta arquitectura cuesta, con poco tráfico, unos 35 a 45 USD al mes: el **ALB** (~16 USD), **dos `t3.micro`** (~16 USD), la clave KMS (1 USD) y céntimos de S3, CloudTrail (el primer trail de gestión es gratis) y alarmas. Si las instancias privadas necesitan salir a internet (actualizaciones), añade un NAT Gateway (~35 USD/mes) o VPC endpoints.';

export const l14: Level = {
  id: 14,
  slug: 'proyecto-final',
  title: 'Proyecto final: arquitectura segura',
  subtitle: 'Integra red, cómputo, balanceo, datos cifrados, IAM, CloudTrail y alarmas en una única arquitectura de producción.',
  skills: ['Diseño por capas', 'Subredes públicas y privadas', 'ALB y grupos de seguridad encadenados', 'Roles de instancia e IMDSv2', 'S3 + KMS endurecidos', 'CloudTrail y alarmas', 'Verificación y Terraform'],
  lessons: [
    { id: 'l14-arquitectura', title: 'Diseño en capas: defensa en profundidad', minutes: 9, body: arquitectura },
    { id: 'l14-identidad', title: 'Mínimo privilegio y datos cifrados', minutes: 10, body: identidad },
    { id: 'l14-observabilidad', title: 'Observabilidad y auditoría', minutes: 9, body: observabilidad },
    { id: 'l14-verificar', title: 'Verificar y repetir con Terraform', minutes: 8, body: verificar },
  ],
  exercises: [
    {
      id: 'l14-e1',
      title: 'Fase 1: la red por capas',
      summary: 'VPC de dos zonas con subredes públicas y privadas.',
      difficulty: 'Media',
      minutes: 15,
      saa: [SAA_DOMAINS[1], SAA_DOMAINS[2]],
      tags: ['VPC', 'Subredes', 'Multi-AZ'],
      scenario: 'Empieza el proyecto final: la tienda web. La primera pieza es la red. Crea la VPC `tienda` (`10.50.0.0/16`) con **dos subredes públicas** (`10.50.1.0/24` en `eu-west-1a`, `10.50.2.0/24` en `eu-west-1b`) para el balanceador y **dos privadas** (`10.50.11.0/24` y `10.50.12.0/24`, una por zona) para los servidores. Solo las públicas salen por un Internet Gateway; ponles etiquetas `Name` (`pub-a`, `pub-b`, `priv-a`, `priv-b`) porque las fases siguientes las buscarán.',
      steps: [sVpc, sPub, sPriv],
      script: NET,
      realWorld: 'La VPC, las subredes, el Internet Gateway y las tablas de rutas son gratuitos. En una cuenta real no uses el rango `10.0.0.0/16` si piensas conectar la VPC con otras redes: los CIDR no pueden solaparse. **Limpieza:** `aws ec2 delete-subnet`, `detach-internet-gateway`, `delete-internet-gateway`, `delete-route-table` y `delete-vpc`, en ese orden, o `terraform destroy` si lo creaste con código.',
    },
    {
      id: 'l14-e2',
      title: 'Fase 2: servidores privados detrás de un ALB',
      summary: 'Grupos de seguridad en cadena, rol de instancia, IMDSv2, dos servidores y el balanceador.',
      difficulty: 'Difícil',
      minutes: 25,
      saa: [SAA_DOMAINS[1], SAA_DOMAINS[2]],
      tags: ['EC2', 'ELB', 'IAM', 'Seguridad'],
      scenario: 'La red de la fase 1 ya existe. Despliega la capa web: `alb-sg` (puerto 80 desde internet) y `web-sg` (puerto 80 **solo desde `alb-sg`**); el rol `web-role` con su perfil `web-profile` (por ahora sin permisos); dos servidores `web-1` y `web-2` en **subredes privadas** de zonas distintas, sin IP pública, con **IMDSv2 obligatorio**; y el balanceador `tienda-alb` en las públicas con un oyente HTTP:80 hacia el grupo de destino `web-tg`. Comprueba que ambos destinos estén `healthy` y haz una petición con `curl`.',
      setup: (sh) => prep(sh, NET),
      steps: [sSg, sCompute, sAlb, step('curl', 'Pide la página al nombre DNS del balanceador con `curl`', ['aws elbv2 describe-load-balancers --names tienda-alb --query LoadBalancers[0].DNSName --output text', 'curl -s http://<dns>'], (c) => c.ran(/curl\b.*elb\.amazonaws\.com|curl\b.*\$DNS/) || 'Todavía no has hecho una petición con curl al balanceador.')],
      script: [...LOOKUP_NET, ...COMPUTE],
      realWorld: `${realWorldCommon} Para HTTPS añade un certificado de **ACM** (gratis) y un oyente 443; las instancias privadas solo necesitan aceptar tráfico del ALB. **Limpieza:** elimina el oyente y el balanceador, el grupo de destino, las instancias, el perfil de instancia (\`remove-role-from-instance-profile\` antes de \`delete-instance-profile\`), el rol y los grupos de seguridad.`,
    },
    {
      id: 'l14-e3',
      title: 'Fase 3: datos cifrados y mínimo privilegio',
      summary: 'Clave KMS rotada, bucket endurecido y permisos justos para el rol de los servidores.',
      difficulty: 'Difícil',
      minutes: 25,
      saa: [SAA_DOMAINS[1]],
      tags: ['KMS', 'S3', 'IAM', 'Cifrado'],
      scenario: 'La capa web ya responde. Ahora los datos: los servidores guardarán informes en S3. Crea la clave `alias/tienda-datos` con **rotación automática**, un bucket `tienda-datos-<cuenta>` con **bloqueo de acceso público total**, cifrado por defecto **SSE-KMS con tu clave**, versionado y una política que **exija TLS**. Después da a `web-role` **solo** lo necesario: leer y escribir objetos de ese bucket y usar esa clave. No debe poder borrar el bucket, tocar IAM ni leer otros buckets.',
      setup: (sh) => prep(sh, [...NET, ...COMPUTE]),
      steps: [sKms, sS3, sIam],
      script: [...LOOKUP_DATA.slice(0, 1), ...DATA],
      realWorld: 'La clave gestionada por el cliente cuesta 1 USD al mes más 0,03 USD por cada 10 000 llamadas; activa **Bucket Keys** para reducirlas. En una cuenta real escribe además un `Deny` explícito para accesos fuera de tu organización (`aws:PrincipalOrgID`) y revisa con **IAM Access Analyzer** qué principales externos pueden acceder. **Limpieza:** vacía el bucket (también las versiones), bórralo, programa la eliminación de la clave con `schedule-key-deletion --pending-window-in-days 7` y borra el alias.',
    },
    {
      id: 'l14-e4',
      title: 'Fase 4: auditoría y alarmas',
      summary: 'CloudTrail multirregión con validación, tema de SNS y una alarma de CPU por servidor.',
      difficulty: 'Media',
      minutes: 20,
      saa: [SAA_DOMAINS[1], SAA_DOMAINS[2]],
      tags: ['CloudTrail', 'CloudWatch', 'SNS', 'S3'],
      scenario: 'La tienda funciona y sus datos están cifrados; falta **vigilarla**. Crea un bucket privado `tienda-logs-<cuenta>` (con la política que permite escribir a CloudTrail), un trail `tienda-trail` **multirregión** con **validación de integridad** y recuerda **iniciarlo**. Crea el tema `alertas-seguridad` con tu correo suscrito y una alarma `cpu-web-1` y `cpu-web-2` (CPUUtilization media > 80, 300 s) que avisen al tema.',
      setup: (sh) => prep(sh, [...NET, ...COMPUTE, ACC, ...DATA]),
      steps: [sTrailRun, sTrail, sTopic, sAlarms],
      script: [...LOOKUP_AUDIT, ...AUDIT],
      realWorld: 'El primer trail de eventos de gestión por región es gratis; los eventos de datos (S3, Lambda) se cobran. Entrega los registros a una **cuenta de seguridad** aparte y activa **Object Lock** en ese bucket para que ni un administrador pueda borrarlos. Confirma la suscripción de SNS desde el correo. **Limpieza:** `aws cloudtrail delete-trail`, borra las alarmas (`delete-alarms`), el tema de SNS y vacía y elimina el bucket de registros.',
    },
    {
      id: 'l14-e5',
      title: 'Reto final: construye toda la arquitectura segura',
      summary: 'Red, cómputo, balanceo, datos, IAM, auditoría y alarmas, desde cero y verificado de punta a punta.',
      difficulty: 'Reto',
      minutes: 60,
      saa: [SAA_DOMAINS[1], SAA_DOMAINS[2], SAA_DOMAINS[3], SAA_DOMAINS[4]],
      tags: ['VPC', 'EC2', 'ELB', 'S3', 'KMS', 'IAM', 'CloudTrail', 'CloudWatch', 'Terraform'],
      scenario: 'Es el examen final. Parte de una cuenta vacía y construye, sin guía paso a paso, la **tienda segura** completa: red en dos zonas con subredes públicas y privadas; `alb-sg` y `web-sg` encadenados; rol `web-role` con perfil `web-profile`; dos servidores privados sin IP pública con IMDSv2; balanceador `tienda-alb` con los destinos sanos; clave `alias/tienda-datos` rotada; bucket `tienda-datos-<cuenta>` con bloqueo público total, SSE-KMS, versionado y TLS obligatorio; permisos mínimos para el rol; trail multirregión **iniciado** con validación hacia `tienda-logs-<cuenta>`; y una alarma de CPU por servidor que avise por SNS. Las nueve comprobaciones son estrictas: cualquier puerto abierto de más, un permiso comodín o un trail sin arrancar las suspenden. Usa las lecciones del nivel como guía.',
      steps: [sNet, sSg, sCompute, sAlb, sKms, sS3, sIam, sTrail, sAlarms],
      script: [ACC, ...NET, ...COMPUTE, ...DATA, ...AUDIT],
      solution: '```bash\n' + [ACC, ...NET, ...COMPUTE, ...DATA, ...AUDIT].join('\n') + '\n```\n\nCada bloque es una fase del nivel. Para repetirlo con código, usa los módulos de **aws-secure-infrastructure**.',
      realWorld: `${realWorldCommon} Para repetirlo en tu cuenta real **usa el Terraform del repositorio \`aws-secure-infrastructure\`**: \`terraform init\`, \`terraform plan -out tfplan\` (revisa el coste y los cambios antes de aplicar), \`terraform apply tfplan\`, y verifica con las mismas nueve comprobaciones de este reto. En producción añade un NAT por zona o VPC endpoints, HTTPS con ACM, WAF delante del ALB y Config con las reglas \`restricted-ssh\` y \`s3-bucket-public-read-prohibited\` del nivel anterior. **Limpieza:** \`terraform destroy\`; si lo hiciste a mano, elimina primero el balanceador, el trail, las instancias y la clave (con ventana de eliminación), y por último la VPC.`,
    },
  ],
  quiz: [
    { domain: 1, q: 'Los servidores web deben recibir tráfico solo del balanceador. ¿Cómo configuras la regla de entrada del grupo de seguridad de los servidores?', options: ['Puerto 80 desde `0.0.0.0/0`', 'Puerto 80 con origen el grupo de seguridad del balanceador', 'Todos los puertos desde el CIDR de la VPC', 'Puerto 80 desde la IP pública del balanceador'], answer: 1, explain: 'Referenciar el grupo del ALB como origen es más seguro y robusto: las IP del balanceador cambian, el grupo no.' },
    { domain: 1, q: 'Una instancia necesita leer un bucket de S3 sin guardar claves de acceso en el disco. ¿Qué usas?', options: ['Un usuario IAM con clave de acceso en un fichero de configuración', 'Un rol de IAM asociado mediante un perfil de instancia', 'La clave de acceso del usuario raíz', 'Un bucket público de solo lectura'], answer: 1, explain: 'El rol de instancia entrega credenciales temporales que se renuevan solas. IMDSv2 protege además su obtención.' },
    { domain: 1, q: 'Quieres exigir `HttpTokens=required` en las instancias. ¿Qué amenaza mitiga principalmente IMDSv2?', options: ['Ataques DDoS volumétricos', 'El robo de credenciales del rol mediante SSRF', 'El agotamiento de IP públicas', 'La pérdida de datos por borrado accidental'], answer: 1, explain: 'IMDSv2 exige un token de sesión con una petición PUT, lo que impide que un SSRF sencillo lea las credenciales.' },
    { domain: 1, q: 'Un rol puede hacer `s3:GetObject` sobre el bucket cifrado con SSE-KMS, pero la lectura falla con AccessDenied. ¿Qué falta con mayor probabilidad?', options: ['`kms:Decrypt` sobre la clave que cifra los objetos', 'Activar el versionado', 'Una regla de entrada en el grupo de seguridad', 'Un trail de CloudTrail'], answer: 0, explain: 'Con SSE-KMS, S3 llama a KMS en nombre del rol. Sin permiso sobre la clave (IAM y política de clave) la lectura se deniega.' },
    { domain: 2, q: 'Quieres que la tienda siga sirviendo si cae una zona de disponibilidad. ¿Qué diseño es el adecuado?', options: ['Dos servidores en la misma subred', 'Un ALB en dos subredes de zonas distintas y servidores repartidos entre ellas', 'Una sola instancia grande', 'Un NAT Gateway en una única zona'], answer: 1, explain: 'La resiliencia a fallos de zona exige recursos en al menos dos AZ y un balanceador que reparta y compruebe la salud.' },
    { domain: 2, q: 'Creaste un trail de CloudTrail multirregión pero no registra nada. ¿Cuál es la causa más habitual?', options: ['El trail no se ha iniciado con `start-logging`', 'CloudTrail solo registra el usuario raíz', 'Los trails multirregión no admiten S3', 'Falta una alarma de CloudWatch'], answer: 0, explain: 'Un trail se puede crear y estar detenido. Hay que iniciarlo y comprobar `get-trail-status`.' },
    { domain: 3, q: 'Quieres repartir el tráfico HTTP entre servidores y comprobar su salud en el nivel de aplicación. ¿Qué eliges?', options: ['Network Load Balancer', 'Application Load Balancer con un grupo de destino y comprobación de salud HTTP', 'Una entrada DNS con varias IP', 'Un Gateway Load Balancer'], answer: 1, explain: 'El ALB trabaja en capa 7: enruta por ruta o host y comprueba la salud con peticiones HTTP.' },
    { domain: 4, q: 'Terminas el proyecto en tu cuenta personal. ¿Qué es lo más importante eliminar para no recibir una factura inesperada?', options: ['Las reglas de los grupos de seguridad', 'El balanceador, las instancias y la clave KMS (con ventana de eliminación)', 'Los tags de las subredes', 'Las alarmas de CloudWatch estándar'], answer: 1, explain: 'ALB e instancias cobran por hora y la clave por mes. Un ALB olvidado es una de las sorpresas más comunes en la factura.' },
  ],
};

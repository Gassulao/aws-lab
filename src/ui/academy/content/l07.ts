import { SAA_DOMAINS, type Level } from '../types';
import { prep } from '../setup';
import dns from './l07/1-dns.md?raw';
import politicas from './l07/2-politicas.md?raw';
import balanceo from './l07/3-balanceo.md?raw';
import autoscaling from './l07/4-autoscaling.md?raw';

const AMI = 'ami-0a1b2c3d4e5f60001';
const TAGS = (pairs: string) => `'ResourceType=instance,Tags=[${pairs}]'`;
const Q = (s: string) => `'${s}'`;

/** Red pública de dos zonas (10.<n>.0.0/16): VPC `Name=<tag>`, puerta de enlace, tabla de rutas y dos subredes públicas. */
const network = (n: number, tag: string): string[] => [
  `VPC=$(aws ec2 create-vpc --cidr-block 10.${n}.0.0/16 --query Vpc.VpcId --output text)`,
  `aws ec2 create-tags --resources $VPC --tags Key=Name,Value=${tag}`,
  'IGW=$(aws ec2 create-internet-gateway --query InternetGateway.InternetGatewayId --output text)',
  'aws ec2 attach-internet-gateway --internet-gateway-id $IGW --vpc-id $VPC',
  'RTB=$(aws ec2 create-route-table --vpc-id $VPC --query RouteTable.RouteTableId --output text)',
  'aws ec2 create-route --route-table-id $RTB --destination-cidr-block 0.0.0.0/0 --gateway-id $IGW',
  `S1=$(aws ec2 create-subnet --vpc-id $VPC --cidr-block 10.${n}.1.0/24 --availability-zone eu-west-1a --query Subnet.SubnetId --output text)`,
  `S2=$(aws ec2 create-subnet --vpc-id $VPC --cidr-block 10.${n}.2.0/24 --availability-zone eu-west-1b --query Subnet.SubnetId --output text)`,
  'aws ec2 associate-route-table --route-table-id $RTB --subnet-id $S1',
  'aws ec2 associate-route-table --route-table-id $RTB --subnet-id $S2',
  'aws ec2 modify-subnet-attribute --subnet-id $S1 --map-public-ip-on-launch',
  'aws ec2 modify-subnet-attribute --subnet-id $S2 --map-public-ip-on-launch',
];
const secGroup = (varName: string, name: string): string[] => [
  `${varName}=$(aws ec2 create-security-group --group-name ${name} --description ${name} --vpc-id $VPC --query GroupId --output text)`,
];
const open80 = (v: string) => `aws ec2 authorize-security-group-ingress --group-id $${v} --protocol tcp --port 80 --cidr 0.0.0.0/0`;
const web = (name: string, sub: string, sg: string) =>
  `aws ec2 run-instances --image-id ${AMI} --instance-type t3.micro --subnet-id $${sub} --security-group-ids $${sg} --user-data 'yum install -y httpd' --tag-specifications ${TAGS(`{Key=Name,Value=${name}}`)}`;
const UNSET = 'unset VPC IGW RTB S1 S2 SGW SGA SGL TG LB I1 I2';
/** Recupera por nombre lo que dejó preparado el escenario (las variables de la preparación no se conservan). */
const lookup = (tag: string) => [
  `VPC=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=${tag} --query ${Q('Vpcs[0].VpcId')} --output text)`,
  `S1=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC --query ${Q('Subnets[0].SubnetId')} --output text)`,
  `S2=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC --query ${Q('Subnets[1].SubnetId')} --output text)`,
];
const sgByName = (v: string, name: string) => `${v}=$(aws ec2 describe-security-groups --filters Name=group-name,Values=${name} --query ${Q('SecurityGroups[0].GroupId')} --output text)`;
const tgArn = (name: string) => `TG=$(aws elbv2 describe-target-groups --names ${name} --query ${Q('TargetGroups[0].TargetGroupArn')} --output text)`;
const lbArn = (name: string) => `LB=$(aws elbv2 describe-load-balancers --names ${name} --query ${Q('LoadBalancers[0].LoadBalancerArn')} --output text)`;
const instId = (v: string, name: string) => `${v}=$(aws ec2 describe-instances --filters Name=tag:Name,Values=${name} --query ${Q('Reservations[0].Instances[0].InstanceId')} --output text)`;

const block = (lines: string[]) => '```bash\n' + lines.join('\n') + '\n```';

// --- Laboratorio 1: DNS
const E1 = [
  'ZID=$(aws route53 create-hosted-zone --name tienda-lab.com --caller-reference lab7-dns --query HostedZone.Id --output text)',
  `aws route53 change-resource-record-sets --hosted-zone-id $ZID --change-batch '{"Changes":[{"Action":"CREATE","ResourceRecordSet":{"Name":"www.tienda-lab.com","Type":"A","TTL":300,"ResourceRecords":[{"Value":"203.0.113.10"}]}},{"Action":"CREATE","ResourceRecordSet":{"Name":"blog.tienda-lab.com","Type":"CNAME","TTL":300,"ResourceRecords":[{"Value":"www.tienda-lab.com"}]}}]}'`,
  'dig +short www.tienda-lab.com > ~/dns.txt',
  'dig +short blog.tienda-lab.com >> ~/dns.txt',
  'cat ~/dns.txt',
];

// --- Laboratorio 2: ALB con dos servidores
const E2_SETUP = [
  ...network(71, 'ha-vpc'), ...secGroup('SGW', 'web-sg'), open80('SGW'),
  web('web-1', 'S1', 'SGW'), web('web-2', 'S2', 'SGW'), UNSET, 'cd ~',
];
const E2 = [
  ...lookup('ha-vpc'), sgByName('SGW', 'web-sg'),
  instId('I1', 'web-1'), instId('I2', 'web-2'),
  'aws elbv2 create-target-group --name web-tg --protocol HTTP --port 80 --vpc-id $VPC --health-check-interval-seconds 5 --health-check-timeout-seconds 2 --healthy-threshold-count 2',
  tgArn('web-tg'),
  'aws elbv2 register-targets --target-group-arn $TG --targets Id=$I1 Id=$I2',
  'aws elbv2 create-load-balancer --name web-alb --subnets $S1 $S2 --security-groups $SGW',
  lbArn('web-alb'),
  'aws elbv2 create-listener --load-balancer-arn $LB --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=$TG',
  'sleep 25',
  'aws elbv2 describe-target-health --target-group-arn $TG',
  `DNS=$(aws elbv2 describe-load-balancers --names web-alb --query ${Q('LoadBalancers[0].DNSName')} --output text)`,
  'curl -s http://$DNS > ~/respuestas.txt',
  'curl -s http://$DNS >> ~/respuestas.txt',
  'cat ~/respuestas.txt',
  UNSET + ' DNS',
];

// --- Laboratorio 3: destinos no sanos
const E3_SETUP = [
  ...network(73, 'app-vpc'), ...secGroup('SGL', 'alb-sg'), open80('SGL'), ...secGroup('SGA', 'app-sg'),
  'aws ec2 authorize-security-group-ingress --group-id $SGA --protocol tcp --port 22 --cidr 10.73.0.0/16',
  `I1=$(aws ec2 run-instances --image-id ${AMI} --instance-type t3.micro --subnet-id $S1 --security-group-ids $SGA --user-data 'yum install -y httpd' --tag-specifications ${TAGS('{Key=Name,Value=app-1}')} --query Instances[0].InstanceId --output text)`,
  'aws elbv2 create-target-group --name app-tg --protocol HTTP --port 80 --vpc-id $VPC --health-check-interval-seconds 5 --health-check-timeout-seconds 2 --healthy-threshold-count 2',
  tgArn('app-tg'),
  'aws elbv2 register-targets --target-group-arn $TG --targets Id=$I1',
  'aws elbv2 create-load-balancer --name app-alb --subnets $S1 $S2 --security-groups $SGL',
  lbArn('app-alb'),
  'aws elbv2 create-listener --load-balancer-arn $LB --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=$TG',
  UNSET, 'cd ~',
];
const E3 = [
  tgArn('app-tg'),
  'aws elbv2 describe-target-health --target-group-arn $TG',
  sgByName('SGL', 'alb-sg'), sgByName('SGA', 'app-sg'),
  'aws ec2 authorize-security-group-ingress --group-id $SGA --protocol tcp --port 80 --source-group $SGL',
  'sleep 20',
  'aws elbv2 describe-target-health --target-group-arn $TG',
  `DNS=$(aws elbv2 describe-load-balancers --names app-alb --query ${Q('LoadBalancers[0].DNSName')} --output text)`,
  'curl -s http://$DNS > ~/ok.txt',
  'cat ~/ok.txt',
  UNSET + ' DNS',
];

// --- Laboratorio 4: Auto Scaling
const E4_SETUP = [
  ...network(74, 'asg-vpc'), ...secGroup('SGW', 'asg-web-sg'), open80('SGW'),
  'aws elbv2 create-target-group --name asg-tg --protocol HTTP --port 80 --vpc-id $VPC --health-check-interval-seconds 5 --health-check-timeout-seconds 2 --healthy-threshold-count 2',
  tgArn('asg-tg'),
  'aws elbv2 create-load-balancer --name asg-alb --subnets $S1 $S2 --security-groups $SGW',
  lbArn('asg-alb'),
  'aws elbv2 create-listener --load-balancer-arn $LB --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=$TG',
  UNSET, 'cd ~',
];
const E4 = [
  ...lookup('asg-vpc'), sgByName('SGW', 'asg-web-sg'), tgArn('asg-tg'),
  'UD=$(echo yum install -y httpd | base64)',
  'aws ec2 create-launch-template --launch-template-name web-lt --launch-template-data ImageId=' + AMI + ',InstanceType=t3.micro,SecurityGroupIds=$SGW,UserData=$UD',
  `aws autoscaling create-auto-scaling-group --auto-scaling-group-name web-asg --launch-template LaunchTemplateName=web-lt,Version=${Q('$Latest')} --min-size 2 --max-size 4 --desired-capacity 2 --vpc-zone-identifier $S1,$S2 --target-group-arns $TG --health-check-type ELB --health-check-grace-period 60`,
  'sleep 25',
  `OLD=$(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names web-asg --query ${Q('AutoScalingGroups[0].Instances[0].InstanceId')} --output text)`,
  'aws ec2 terminate-instances --instance-ids $OLD',
  'sleep 40',
  'aws autoscaling describe-scaling-activities --auto-scaling-group-name web-asg',
  'aws autoscaling set-desired-capacity --auto-scaling-group-name web-asg --desired-capacity 3',
  'sleep 30',
  'aws elbv2 describe-target-health --target-group-arn $TG',
  UNSET + ' UD OLD',
];

// --- Laboratorio 5: conmutación por error
const E5_SETUP = [
  ...network(75, 'dr-vpc'), ...secGroup('SGW', 'dr-web-sg'), open80('SGW'), web('primario', 'S1', 'SGW'), UNSET, 'cd ~',
];
const E5 = [
  instId('I1', 'primario'),
  `IP=$(aws ec2 describe-instances --instance-ids $I1 --query ${Q('Reservations[0].Instances[0].PublicIpAddress')} --output text)`,
  'ZID=$(aws route53 create-hosted-zone --name failover-lab.com --caller-reference lab7-dr --query HostedZone.Id --output text)',
  `HC=$(aws route53 create-health-check --caller-reference hc-dr --health-check-config IPAddress=$IP,Port=80,Type=HTTP,ResourcePath=/ --query HealthCheck.Id --output text)`,
  `printf '{"Changes":[{"Action":"CREATE","ResourceRecordSet":{"Name":"app.failover-lab.com","Type":"A","SetIdentifier":"principal","Failover":"PRIMARY","TTL":60,"HealthCheckId":"%s","ResourceRecords":[{"Value":"%s"}]}},{"Action":"CREATE","ResourceRecordSet":{"Name":"app.failover-lab.com","Type":"A","SetIdentifier":"secundario","Failover":"SECONDARY","TTL":60,"ResourceRecords":[{"Value":"198.51.100.7"}]}}]}' $HC $IP > cambios.json`,
  'aws route53 change-resource-record-sets --hosted-zone-id $ZID --change-batch file://cambios.json',
  'dig +short app.failover-lab.com',
  'aws ec2 stop-instances --instance-ids $I1',
  'dig +short app.failover-lab.com > ~/failover.txt',
  'cat ~/failover.txt',
  'unset I1 IP ZID HC',
];

const E1_SOL = block(E1);

export const l07: Level = {
  id: 7,
  slug: 'alta-disponibilidad',
  title: 'Alta disponibilidad',
  subtitle: 'Route 53, balanceadores de carga y Auto Scaling en varias zonas',
  skills: ['Zonas y registros DNS (A, CNAME, alias)', 'Políticas de enrutamiento y comprobaciones de estado', 'ALB, oyentes y grupos de destino', 'Diagnóstico de destinos no sanos', 'Auto Scaling y autorreparación entre zonas'],
  lessons: [
    { id: 'l07-dns', title: 'Route 53 y el DNS', minutes: 7, body: dns },
    { id: 'l07-politicas', title: 'Políticas de enrutamiento y comprobaciones de estado', minutes: 7, body: politicas },
    { id: 'l07-balanceo', title: 'Balanceadores de carga (ALB)', minutes: 9, body: balanceo },
    { id: 'l07-autoscaling', title: 'Auto Scaling y varias zonas', minutes: 8, body: autoscaling },
  ],
  exercises: [
    {
      id: 'l07-e1',
      title: 'Tu primera zona DNS',
      summary: 'Crea una zona, un registro A y un CNAME, y compruébalos con dig.',
      difficulty: 'Fácil',
      minutes: 12,
      saa: [SAA_DOMAINS[2]],
      tags: ['Route 53', 'DNS', 'dig'],
      scenario: 'Tu tienda necesita nombres propios. Crea la zona alojada `tienda-lab.com`, añade `www.tienda-lab.com` (registro **A** hacia `203.0.113.10`, TTL 300) y `blog.tienda-lab.com` (**CNAME** hacia `www.tienda-lab.com`). Comprueba la resolución con `dig +short` y guarda las dos respuestas en `~/dns.txt`.',
      steps: [
        { id: 'zone', title: 'Crea la zona alojada `tienda-lab.com`', hint: ['aws route53 create-hosted-zone --name tienda-lab.com --caller-reference <texto-único>', 'Guarda el ID con --query HostedZone.Id --output text.'], check: (c) => !!c.zone('tienda-lab.com') || 'La zona tienda-lab.com todavía no existe.' },
        { id: 'a', title: 'Crea el registro A `www` hacia `203.0.113.10` con TTL 300', hint: ['aws route53 change-resource-record-sets --hosted-zone-id <id> --change-batch file://cambios.json', 'Acción CREATE (o UPSERT), Type A, TTL 300 y ResourceRecords con Value.'], check: (c) => { const r = c.zone('tienda-lab.com')?.records.find((x) => x.name === 'www.tienda-lab.com.' && x.type === 'A'); if (!r) return 'Falta el registro A de www.tienda-lab.com.'; return (r.values.includes('203.0.113.10') && r.ttl === 300) || 'El registro A debe apuntar a 203.0.113.10 con TTL 300.'; } },
        { id: 'cname', title: 'Crea el registro CNAME `blog` hacia `www.tienda-lab.com`', hint: ['Puedes enviar los dos registros en un solo lote.', 'Un CNAME no puede convivir con otros registros del mismo nombre.'], check: (c) => { const r = c.zone('tienda-lab.com')?.records.find((x) => x.name === 'blog.tienda-lab.com.' && x.type === 'CNAME'); if (!r) return 'Falta el registro CNAME de blog.tienda-lab.com.'; return r.values[0].replace(/\.$/, '') === 'www.tienda-lab.com' || 'El CNAME debe apuntar a www.tienda-lab.com.'; } },
        { id: 'dig', title: 'Guarda en `~/dns.txt` el resultado de `dig +short` para `www` y `blog`', hint: ['dig +short www.tienda-lab.com > ~/dns.txt', 'Usa >> para añadir la segunda consulta.', 'El CNAME devuelve primero el nombre al que apunta y después la IP.'], check: (c) => { const f = c.file('dns.txt'); if (!f) return 'Falta ~/dns.txt.'; return (f.includes('203.0.113.10') && f.includes('www.tienda-lab.com')) || '~/dns.txt debe contener la IP de www y la respuesta del CNAME de blog.'; } },
      ],
      script: E1,
      solution: E1_SOL,
      realWorld: 'En tu cuenta real una zona alojada cuesta **0,50 USD al mes** (y unos 0,40 USD por millón de consultas), aunque la borres a los pocos minutos se cobra el mes completo si pasa de 12 horas. Para usarla de verdad debes cambiar los servidores de nombres (NS) en tu registrador. Para dominios de pruebas conviene una zona **privada** o un subdominio que no uses. **Limpieza:** borra primero todos los registros que no sean NS ni SOA y después la zona con `aws route53 delete-hosted-zone`. En tu repositorio **aws-secure-infrastructure** puedes declararla con `aws_route53_zone` y `aws_route53_record` de Terraform.',
    },
    {
      id: 'l07-e2',
      title: 'Un ALB delante de dos servidores',
      summary: 'Crea el grupo de destino, el balanceador y el oyente, y comprueba el reparto.',
      difficulty: 'Media',
      minutes: 25,
      saa: [SAA_DOMAINS[2]],
      tags: ['ELB', 'ALB', 'EC2', 'Alta disponibilidad'],
      scenario: 'Hay dos servidores web (`web-1` y `web-2`) en dos zonas de disponibilidad de la VPC `ha-vpc`, pero cada cliente entra por una IP distinta. Crea un grupo de destino `web-tg`, registra las dos instancias, crea el balanceador `web-alb` en las dos subredes con su oyente HTTP:80, espera a que ambos destinos estén sanos y guarda en `~/respuestas.txt` **dos respuestas** pedidas al nombre DNS del balanceador (deberían venir de servidores distintos).',
      setup: async (sh) => { await prep(sh, E2_SETUP); },
      steps: [
        { id: 'tg', title: 'Crea el grupo de destino `web-tg` (HTTP, puerto 80) en la VPC `ha-vpc`', hint: ['aws elbv2 create-target-group --name web-tg --protocol HTTP --port 80 --vpc-id <vpc>', 'Para no esperar 2,5 minutos a que los destinos estén sanos, añade `--health-check-interval-seconds 5 --health-check-timeout-seconds 2 --healthy-threshold-count 2` (unos 10 s en lugar de 150 s).', "El ID de la VPC: aws ec2 describe-vpcs --filters Name=tag:Name,Values=ha-vpc --query 'Vpcs[0].VpcId' --output text"], check: (c) => { const g = c.tg('web-tg'); if (!g) return 'El grupo de destino web-tg todavía no existe.'; return (g.port === 80 && c.vpc('ha-vpc')?.id === g.vpcId) || 'web-tg debe ser HTTP:80 y estar en la VPC ha-vpc.'; } },
        { id: 'reg', title: 'Registra `web-1` y `web-2` en el grupo de destino', hint: ['aws elbv2 register-targets --target-group-arn <arn> --targets Id=<i-1> Id=<i-2>', 'Los IDs salen de aws ec2 describe-instances.'], check: (c) => { const g = c.tg('web-tg'); if (!g) return 'Primero crea web-tg.'; return g.targets.length === 2 || 'Registra las dos instancias en web-tg.'; } },
        { id: 'alb', title: 'Crea el balanceador `web-alb` en las dos subredes y su oyente HTTP:80 hacia `web-tg`', hint: ['aws elbv2 create-load-balancer --name web-alb --subnets <s1> <s2> --security-groups <sg>', 'Usa el grupo de seguridad web-sg, que ya permite el puerto 80.', 'aws elbv2 create-listener --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=<arn>'], check: (c) => { const l = c.lb('web-alb'); if (!l) return 'El balanceador web-alb todavía no existe.'; if (l.subnets.length < 2) return 'El balanceador necesita al menos dos subredes.'; return c.s.listeners.some((x) => x.lbArn === l.arn && x.port === 80 && x.tgArn === c.tg('web-tg')?.arn) || 'Falta un oyente HTTP:80 que reenvíe a web-tg.'; } },
        { id: 'health', title: 'Comprueba que los dos destinos están `healthy`', hint: ['aws elbv2 describe-target-health --target-group-arn <arn>', 'Al principio estarán en «initial»: repite el comando pasados unos segundos (con la comprobación acelerada, unos 20 s desde que existe el oyente).'], check: (c) => { const st = Object.values(c.targetStates('web-tg')); if (st.length !== 2) return 'web-tg debe tener dos destinos.'; return st.every((s) => s === 'healthy') || `Todavía no están sanos (${st.join(', ')}). Espera unos segundos y vuelve a mirar.`; } },
        { id: 'curl', title: 'Guarda en `~/respuestas.txt` dos respuestas del balanceador', hint: ['curl -s http://<dns-del-alb> > ~/respuestas.txt y repite con >>', 'El nombre DNS: aws elbv2 describe-load-balancers --names web-alb --query LoadBalancers[0].DNSName'], check: (c) => { const f = (c.file('respuestas.txt') ?? '').split('\n').filter((l) => l.includes('Hola desde')); if (f.length < 2) return '~/respuestas.txt debe contener dos respuestas del balanceador.'; return new Set(f).size >= 2 || 'Las dos respuestas vienen del mismo servidor; vuelve a pedir y fíjate en el nombre del host.'; } },
      ],
      script: E2,
      solution: block(E2),
      realWorld: 'Un ALB cuesta unos **0,0225 USD por hora (unos 16 USD al mes)** más las unidades de capacidad (LCU) por tráfico, y cada instancia `t3.micro` unos 8 USD al mes. En una cuenta real el balanceador necesita al menos dos subredes públicas en zonas distintas y, para HTTPS, un certificado de **ACM** (gratis). **Limpieza:** elimina primero el oyente y el balanceador (`delete-listener`, `delete-load-balancer`), luego el grupo de destino, termina las instancias y borra la VPC; los balanceadores olvidados son una de las causas habituales de factura sorpresa. En **aws-secure-infrastructure** todo esto sería `aws_lb`, `aws_lb_target_group` y `aws_lb_listener`.',
    },
    {
      id: 'l07-e3',
      title: 'Destinos no sanos: el balanceador no llega al servidor',
      summary: 'Diagnostica un Target.Timeout y abre el puerto solo al grupo de seguridad del ALB.',
      difficulty: 'Difícil',
      minutes: 20,
      saa: [SAA_DOMAINS[1]],
      tags: ['ELB', 'Seguridad', 'Security Group', 'Diagnóstico'],
      scenario: 'El balanceador `app-alb` devuelve **503** y el destino `app-1` aparece como `unhealthy`. El servidor web está instalado y arrancado, así que el fallo es de red. **Averigua el motivo con `describe-target-health`, corrígelo sin abrir el puerto 80 a todo Internet** (la instancia debe aceptar tráfico solo del balanceador) y guarda en `~/ok.txt` una respuesta correcta.',
      setup: async (sh) => { await prep(sh, E3_SETUP); },
      steps: [
        { id: 'diag', title: 'Consulta el estado del destino y lee el motivo', hint: ['aws elbv2 describe-target-health --target-group-arn <arn>', 'Target.Timeout significa que la petición no llega a la instancia.'], check: (c) => c.trail('DescribeTargetHealth', { error: false }).length > 0 || 'Aún no has consultado la salud del destino.' },
        { id: 'fix', title: 'Permite el puerto 80 en `app-sg` solo desde el grupo de seguridad `alb-sg`', hint: ['aws ec2 authorize-security-group-ingress --group-id <app-sg> --protocol tcp --port 80 --source-group <alb-sg>', 'No uses --cidr 0.0.0.0/0: la instancia no debe quedar expuesta.'], check: (c) => { const sg = c.sg('app-sg'); const alb = c.sg('alb-sg'); if (!sg || !alb) return 'No se encuentran los grupos de seguridad.'; if (c.sgAllows(sg, 80, '0.0.0.0/0')) return 'No abras el puerto 80 a todo Internet: permítelo solo desde alb-sg.'; return sg.ingress.some((r) => r.sourceSg === alb.id && r.from <= 80 && r.to >= 80) || 'app-sg todavía no acepta el puerto 80 desde alb-sg.'; } },
        { id: 'healthy', title: 'Comprueba que `app-1` pasa a `healthy`', hint: ['Pasa de «unhealthy» a «healthy» cuando el balanceador supera dos comprobaciones seguidas (unos 10-20 s). Repite `describe-target-health` hasta verlo.'], check: (c) => { const st = Object.values(c.targetStates('app-tg')); return (st.length > 0 && st.every((s) => s === 'healthy')) || `El destino aún no está sano (${st.join(', ') || 'sin destinos'}).`; } },
        { id: 'curl', title: 'Guarda en `~/ok.txt` una respuesta del balanceador', hint: ['curl -s http://<dns-del-alb> > ~/ok.txt'], check: (c) => (c.file('ok.txt') ?? '').includes('Hola desde') || '~/ok.txt debe contener una respuesta correcta del servidor.' },
      ],
      script: E3,
      solution: 'El motivo es `Target.Timeout`: el balanceador no consigue conectar con la instancia porque `app-sg` solo admite SSH. La solución correcta no es abrir el puerto 80 al mundo, sino **referenciar el grupo de seguridad del balanceador como origen**: así solo el ALB puede hablar con la aplicación.\n\n' + block(E3),
      realWorld: 'En una cuenta real sigue el mismo orden: **motivo del destino → grupo de seguridad de la instancia → que el servidor escuche en el puerto → ruta de comprobación y código esperado**. Si el motivo es `Target.FailedHealthChecks` revisa la aplicación y el `Matcher`. El patrón «instancia solo accesible desde el ALB» es la base de una arquitectura de tres capas segura. **Limpieza:** elimina oyente, balanceador, grupo de destino e instancia, y después la VPC (el ALB cuesta unos 0,0225 USD por hora mientras exista).',
    },
    {
      id: 'l07-e4',
      title: 'Auto Scaling: servidores que se reparan solos',
      summary: 'Un grupo de dos instancias en dos zonas que repone la que falla y escala a tres.',
      difficulty: 'Difícil',
      minutes: 28,
      saa: [SAA_DOMAINS[2], SAA_DOMAINS[4]],
      tags: ['Auto Scaling', 'ELB', 'EC2', 'Resiliencia'],
      scenario: 'En la VPC `asg-vpc` ya existen el balanceador `asg-alb` y su grupo de destino `asg-tg`. Crea una **plantilla de lanzamiento** `web-lt` (con servidor httpd en los datos de usuario) y un **grupo de Auto Scaling** `web-asg` con mínimo 2, deseado 2 y máximo 4 repartido en las dos subredes, asociado a `asg-tg` y con comprobación de estado de tipo ELB. Después **termina una instancia a mano** y comprueba que el grupo la sustituye, y finalmente escala a 3 instancias sanas.',
      setup: async (sh) => { await prep(sh, E4_SETUP); },
      steps: [
        { id: 'lt', title: 'Crea la plantilla de lanzamiento `web-lt` con httpd en los datos de usuario', hint: ['aws ec2 create-launch-template --launch-template-name web-lt --launch-template-data ImageId=<ami>,InstanceType=t3.micro,SecurityGroupIds=<sg>,UserData=<base64>', 'Los datos de usuario van en base64: echo "yum install -y httpd" | base64', 'El grupo de seguridad asg-web-sg ya permite el puerto 80.'], check: (c) => { const lt = c.s.launchTemplates.find((x) => x.name === 'web-lt'); if (!lt) return 'La plantilla web-lt todavía no existe.'; let ud = lt.userData ?? ''; try { ud += atob(ud); } catch { /* texto plano */ } return /httpd/.test(ud) || 'La plantilla debe instalar httpd en los datos de usuario.'; } },
        { id: 'asg', title: 'Crea `web-asg` (2/2/4) en las dos subredes, con `asg-tg` y `--health-check-type ELB`', hint: ["aws autoscaling create-auto-scaling-group --auto-scaling-group-name web-asg --launch-template LaunchTemplateName=web-lt,Version='$Latest' --min-size 2 --max-size 4 --vpc-zone-identifier <s1>,<s2> --target-group-arns <arn> --health-check-type ELB"], check: (c) => { const g = c.asg('web-asg'); if (!g) return 'El grupo web-asg todavía no existe.'; if (g.min !== 2 || g.max !== 4) return 'El grupo debe tener mínimo 2 y máximo 4.'; if (g.subnets.length < 2) return 'El grupo debe usar las dos subredes (dos zonas).'; if (g.healthCheckType !== 'ELB') return 'La comprobación de estado debe ser de tipo ELB.'; return g.tgArns.includes(c.tg('asg-tg')?.arn ?? '') || 'El grupo debe estar asociado a asg-tg.'; } },
        { id: 'two', title: 'Comprueba que hay dos instancias, una en cada zona, y ambas `healthy` en el balanceador', hint: ['aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names web-asg', 'aws elbv2 describe-target-health --target-group-arn <arn>'], check: (c) => { const ins = c.asgInstances('web-asg'); if (ins.length < 2) return 'El grupo aún no tiene dos instancias.'; if (new Set(ins.map((i) => i.az)).size < 2) return 'Las instancias deben estar repartidas en dos zonas.'; const st = Object.values(c.targetStates('asg-tg')); return (st.length >= 2 && st.every((s) => s === 'healthy')) || 'Los destinos todavía no están sanos; espera unos segundos.'; } },
        { id: 'heal', title: 'Termina una instancia con `aws ec2 terminate-instances` y comprueba que el grupo lanza otra', hint: ["aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names web-asg --query 'AutoScalingGroups[0].Instances[].InstanceId'", 'aws autoscaling describe-scaling-activities --auto-scaling-group-name web-asg'], check: (c) => { if (c.trail('TerminateInstances', { error: false }).length === 0) return 'Aún no has terminado ninguna instancia.'; const g = c.asg('web-asg'); return ((g?.activities.length ?? 0) >= 3 && c.asgInstances('web-asg').length >= 2) || 'El grupo todavía no ha repuesto la instancia; vuelve a consultar en unos segundos.'; } },
        { id: 'scale', title: 'Escala a 3 con `set-desired-capacity` y espera a tener 3 destinos sanos', hint: ['aws autoscaling set-desired-capacity --auto-scaling-group-name web-asg --desired-capacity 3'], check: (c) => { const g = c.asg('web-asg'); if (!g || g.desired !== 3) return 'El número deseado de instancias debe ser 3.'; const st = Object.values(c.targetStates('asg-tg')); return (st.length === 3 && st.every((s) => s === 'healthy')) || 'Aún no hay tres destinos sanos; espera unos segundos.'; } },
      ],
      script: E4,
      solution: block(E4),
      realWorld: 'En una cuenta real el grupo mantiene siempre el mínimo (2 `t3.micro` son unos 16 USD al mes) y el ALB suma unos 16 USD más. Añade una **política de escalado por seguimiento de destino** (por ejemplo, CPU media al 50 %) para que crezca y encoja según la demanda, y un **periodo de gracia** suficiente para que arranque la aplicación antes de que el balanceador la considere no sana. **Limpieza:** borra primero el grupo con `aws autoscaling delete-auto-scaling-group --force-delete` (termina sus instancias), luego el balanceador, el grupo de destino y la plantilla. En **aws-secure-infrastructure** son `aws_launch_template` y `aws_autoscaling_group`.',
    },
    {
      id: 'l07-e5',
      title: 'Recuperación ante desastres con conmutación por error DNS',
      summary: 'Si el servidor principal cae, Route 53 responde con el secundario.',
      difficulty: 'Reto',
      minutes: 25,
      saa: [SAA_DOMAINS[2], SAA_DOMAINS[4]],
      tags: ['Route 53', 'Conmutación por error', 'Comprobación de estado', 'Resiliencia'],
      scenario: 'El servidor `primario` atiende `app.failover-lab.com`. Si cae, los usuarios deben ir a una página de mantenimiento alojada en `198.51.100.7`. Crea la zona `failover-lab.com`, una **comprobación de estado** HTTP sobre la IP pública de `primario`, un registro A de conmutación por error **PRIMARY** (con la comprobación y TTL 60) y otro **SECONDARY** hacia `198.51.100.7`. Comprueba con `dig` que responde el principal, **detén la instancia** y guarda en `~/failover.txt` la respuesta tras la conmutación.',
      setup: async (sh) => { await prep(sh, E5_SETUP); },
      steps: [
        { id: 'hc', title: 'Crea la zona `failover-lab.com` y una comprobación de estado HTTP:80 sobre la IP pública de `primario`', hint: ["aws ec2 describe-instances --filters Name=tag:Name,Values=primario --query 'Reservations[0].Instances[0].PublicIpAddress' --output text", 'aws route53 create-health-check --caller-reference hc-dr --health-check-config IPAddress=<ip>,Port=80,Type=HTTP,ResourcePath=/'], check: (c) => { if (!c.zone('failover-lab.com')) return 'Falta la zona failover-lab.com.'; const hc = c.s.healthChecks.find((h) => h.type === 'HTTP' && h.port === 80 && !!h.ip); return !!hc || 'Falta una comprobación de estado HTTP:80 sobre la IP pública de primario.'; } },
        { id: 'primary', title: 'Crea el registro A `app` PRIMARY hacia la IP de `primario`, con la comprobación de estado y TTL 60', hint: ['Necesita SetIdentifier, Failover=PRIMARY y HealthCheckId.', 'Escribe el lote en un fichero con printf y pásalo con --change-batch file://cambios.json.'], check: (c) => { const r = c.zone('failover-lab.com')?.records.find((x) => x.name === 'app.failover-lab.com.' && x.failover === 'PRIMARY'); if (!r) return 'Falta el registro PRIMARY de app.failover-lab.com.'; if (!r.healthCheckId) return 'El registro PRIMARY debe llevar la comprobación de estado.'; const hc = c.s.healthChecks.find((h) => h.id === r.healthCheckId); return (!!hc && r.values.includes(hc.ip ?? '-') && r.ttl === 60) || 'PRIMARY debe apuntar a la misma IP que vigila la comprobación, con TTL 60.'; } },
        { id: 'secondary', title: 'Crea el registro A `app` SECONDARY hacia `198.51.100.7`', hint: ['Mismo nombre y tipo, distinto SetIdentifier, Failover=SECONDARY y sin comprobación de estado.'], check: (c) => { const r = c.zone('failover-lab.com')?.records.find((x) => x.name === 'app.failover-lab.com.' && x.failover === 'SECONDARY'); return (!!r && r.values.includes('198.51.100.7')) || 'Falta el registro SECONDARY hacia 198.51.100.7.'; } },
        { id: 'fail', title: 'Detén `primario` y guarda en `~/failover.txt` el resultado de `dig +short app.failover-lab.com`', hint: ['aws ec2 stop-instances --instance-ids <id>', 'Antes de parar la instancia comprueba que dig devuelve la IP del principal.'], check: (c) => { if (c.instance((i) => i.tags.Name === 'primario' && (i.state === 'stopped' || i.state === 'stopping'))) { const f = c.file('failover.txt'); if (!f) return 'Falta ~/failover.txt.'; return f.includes('198.51.100.7') || '~/failover.txt debe contener la respuesta del secundario (198.51.100.7).'; } return 'La instancia primario sigue en ejecución: deténla para provocar la conmutación.'; } },
      ],
      script: E5,
      solution: block(E5),
      realWorld: 'En una cuenta real una comprobación de estado básica cuesta unos **0,50 USD al mes** y la zona otros 0,50 USD. Las comprobaciones de Route 53 llegan desde Internet, por lo que el servidor debe aceptar sus IP en el grupo de seguridad (o usa una comprobación calculada o de alarma para recursos privados). El TTL bajo (60 s) acelera la conmutación pero aumenta las consultas, y los resolvedores de algunos proveedores lo ignoran. El secundario ideal es una **página estática en S3** servida por CloudFront. **Limpieza:** borra los registros, la comprobación de estado, la zona y la instancia; la zona se cobra si dura más de 12 horas.',
    },
  ],
  quiz: [
    { domain: 2, q: 'Una aplicación debe seguir disponible aunque caiga una zona de disponibilidad entera. ¿Qué diseño es el adecuado?', options: ['Una instancia grande en una sola zona', 'ALB y grupo de Auto Scaling repartidos en al menos dos zonas', 'Una instancia con una IP elástica', 'Un volumen EBS con instantáneas diarias'], answer: 1, explain: 'El balanceador deja de enviar tráfico a la zona caída y el grupo de Auto Scaling repone capacidad en la zona sana.' },
    { domain: 2, q: 'Quieres que Route 53 responda con un sitio de mantenimiento cuando el servidor principal falle. ¿Qué configuras?', options: ['Dos registros con política ponderada 50/50', 'Registros de conmutación por error (PRIMARY y SECONDARY) con comprobación de estado en el principal', 'Un CNAME en el apex', 'Un registro con TTL de 0 segundos'], answer: 1, explain: 'Sin comprobación de estado Route 53 no sabe que el principal ha caído; con ella deja de devolverlo y responde con el secundario.' },
    { domain: 1, q: 'Las instancias detrás de un ALB solo deben recibir tráfico del balanceador. ¿Cuál es la regla más segura en su grupo de seguridad?', options: ['Permitir el puerto 80 desde 0.0.0.0/0', 'Permitir el puerto 80 con origen el grupo de seguridad del balanceador', 'Permitir todo el tráfico desde la VPC', 'Cerrar el puerto 80 y abrir el 22'], answer: 1, explain: 'Usar el grupo de seguridad del ALB como origen limita el acceso a las IP del balanceador, aunque cambien o escalen.' },
    { domain: 2, q: 'Un destino aparece como «unhealthy» con el motivo Target.Timeout. ¿Cuál es la causa más probable?', options: ['El certificado ha caducado', 'El grupo de seguridad de la instancia no permite la conexión del balanceador', 'La instancia tiene demasiada memoria', 'El grupo de destino no tiene nombre'], answer: 1, explain: 'Timeout significa que la petición de comprobación no llega. FailedHealthChecks, en cambio, indica que llega pero la respuesta no es la esperada.' },
    { domain: 3, q: 'Quieres enviar el 10 % del tráfico a una versión nueva y el resto a la actual con el mismo nombre DNS. ¿Qué política usas?', options: ['Simple', 'Ponderada', 'Geolocalización', 'Conmutación por error'], answer: 1, explain: 'La política ponderada reparte las respuestas según el peso de cada registro, ideal para despliegues graduales.' },
    { domain: 4, q: '¿Cómo ajusta Auto Scaling el coste a la demanda?', options: ['Compra instancias reservadas automáticamente', 'Añade instancias cuando sube la carga y las termina cuando baja, dentro de un mínimo y un máximo', 'Apaga el balanceador por la noche', 'Cambia la región de despliegue'], answer: 1, explain: 'Con políticas de escalado por seguimiento de destino pagas solo la capacidad que necesitas en cada momento.' },
    { domain: 3, q: 'Necesitas que el dominio raíz (`tienda.com`) apunte a un ALB. ¿Qué tipo de registro usas?', options: ['CNAME', 'Alias de Route 53', 'MX', 'Un A con la IP del balanceador'], answer: 1, explain: 'El CNAME no puede usarse en el apex. El alias sí, resuelve las IP cambiantes del balanceador y no genera coste por consulta.' },
    { domain: 2, q: 'Una instancia de un grupo de Auto Scaling se termina por error. ¿Qué ocurre?', options: ['El grupo se queda con una instancia menos hasta que alguien intervenga', 'El grupo lanza una instancia de sustitución para volver a la capacidad deseada', 'El balanceador se elimina', 'Se escala al máximo'], answer: 1, explain: 'Auto Scaling compara la capacidad real con la deseada y lanza una nueva instancia, que se registra sola en el grupo de destino.' },
  ],
};

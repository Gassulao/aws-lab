import { SAA_DOMAINS, type Level } from '../types';
import { prep } from '../setup';
import vpc from './l03/1-vpc.md?raw';
import ha from './l03/2-alta-disponibilidad.md?raw';
import nat from './l03/3-nat.md?raw';
import diag from './l03/4-diagnostico.md?raw';

const AMI = 'ami-0a1b2c3d4e5f60001';
const T = (type: string, name: string, value: string) => `'ResourceType=${type},Tags=[{Key=${name},Value=${value}}]'`;

/** VPC 10.20.0.0/16 con una subred pública 10.20.1.0/24 ya conectada a internet (punto de partida del laboratorio de NAT). */
const baseVpc = [
  'VPC=$(aws ec2 create-vpc --cidr-block 10.20.0.0/16 --query Vpc.VpcId --output text)',
  'SUB=$(aws ec2 create-subnet --vpc-id $VPC --cidr-block 10.20.1.0/24 --query Subnet.SubnetId --output text)',
  'IGW=$(aws ec2 create-internet-gateway --query InternetGateway.InternetGatewayId --output text)',
  'aws ec2 attach-internet-gateway --internet-gateway-id $IGW --vpc-id $VPC',
  'RT=$(aws ec2 create-route-table --vpc-id $VPC --query RouteTable.RouteTableId --output text)',
  'aws ec2 create-route --route-table-id $RT --destination-cidr-block 0.0.0.0/0 --gateway-id $IGW',
  'aws ec2 associate-route-table --route-table-id $RT --subnet-id $SUB',
];

export const l03: Level = {
  id: 3,
  slug: 'vpc',
  title: 'Redes con VPC',
  subtitle: 'Subredes públicas y privadas, Internet Gateway, NAT y diagnóstico de red',
  skills: ['CIDR y subredes', 'Tablas de rutas', 'Alta disponibilidad en dos AZ', 'Internet Gateway y NAT Gateway', 'Diagnóstico de conectividad'],
  lessons: [
    { id: 'l03-vpc', title: 'VPC, CIDR y qué hace pública a una subred', minutes: 8, body: vpc },
    { id: 'l03-ha', title: 'Dos niveles en dos zonas de disponibilidad', minutes: 6, body: ha },
    { id: 'l03-nat', title: 'NAT Gateway: salir sin ser alcanzable', minutes: 6, body: nat },
    { id: 'l03-diag', title: 'Diagnóstico de conectividad paso a paso', minutes: 8, body: diag },
  ],
  exercises: [
    {
      id: 'l03-e1',
      title: 'Tu primera VPC con una subred pública',
      summary: 'VPC, subred, Internet Gateway, tabla de rutas y asociación.',
      difficulty: 'Media',
      minutes: 15,
      saa: [SAA_DOMAINS[1], SAA_DOMAINS[2]],
      tags: ['VPC', 'Subred', 'Internet Gateway', 'Rutas'],
      scenario: 'Vas a montar la red de una web. Crea una VPC `10.20.0.0/16` con una subred `10.20.1.0/24` que tenga salida directa a internet. Recuerda: lo que hace pública a una subred es su **tabla de rutas**, no un interruptor.',
      steps: [
        { id: 'vpc', title: 'Crea una VPC con CIDR `10.20.0.0/16`', hint: ['aws ec2 create-vpc --cidr-block 10.20.0.0/16 --query Vpc.VpcId --output text'], check: (c) => !!c.vpc('10.20.0.0/16') || 'Falta la VPC 10.20.0.0/16.' },
        { id: 'sub', title: 'Crea la subred `10.20.1.0/24` dentro de ella', hint: ['aws ec2 create-subnet --vpc-id <vpc> --cidr-block 10.20.1.0/24'], check: (c) => { const v = c.vpc('10.20.0.0/16'); return (!!v && c.subnets(v.id).some((x) => x.cidr === '10.20.1.0/24')) || 'Falta la subred 10.20.1.0/24.'; } },
        { id: 'igw', title: 'Crea un Internet Gateway y conéctalo a la VPC', hint: ['Son dos comandos: `create-internet-gateway` y `attach-internet-gateway`.'], check: (c) => { const v = c.vpc('10.20.0.0/16'); return (!!v && c.s.internetGateways.some((g) => g.attachedVpcId === v.id)) || 'Falta el Internet Gateway conectado a la VPC.'; } },
        { id: 'pub', title: 'Haz pública la subred: ruta `0.0.0.0/0` al IGW y asociación', hint: ['`create-route-table` → `create-route --gateway-id` → `associate-route-table`.', 'aws ec2 create-route --route-table-id $RT --destination-cidr-block 0.0.0.0/0 --gateway-id $IGW'], check: (c) => { const v = c.vpc('10.20.0.0/16'); const sub = v && c.subnets(v.id).find((x) => x.cidr === '10.20.1.0/24'); return (!!sub && c.isPublic(sub)) || 'La subred todavía no es pública.'; } },
      ],
      script: [
        'VPC=$(aws ec2 create-vpc --cidr-block 10.20.0.0/16 --query Vpc.VpcId --output text)',
        'SUB=$(aws ec2 create-subnet --vpc-id $VPC --cidr-block 10.20.1.0/24 --query Subnet.SubnetId --output text)',
        'IGW=$(aws ec2 create-internet-gateway --query InternetGateway.InternetGatewayId --output text)',
        'aws ec2 attach-internet-gateway --internet-gateway-id $IGW --vpc-id $VPC',
        'RT=$(aws ec2 create-route-table --vpc-id $VPC --query RouteTable.RouteTableId --output text)',
        'aws ec2 create-route --route-table-id $RT --destination-cidr-block 0.0.0.0/0 --gateway-id $IGW',
        'aws ec2 associate-route-table --route-table-id $RT --subnet-id $SUB',
      ],
      realWorld: 'Repítelo en tu cuenta real: VPC, subredes, IGW y tablas de rutas son **gratis**. Es la base de la red de **aws-secure-infrastructure** (en Terraform: `aws_vpc`, `aws_subnet`, `aws_internet_gateway`, `aws_route_table`). **Limpieza** en orden inverso: asociaciones, rutas, tabla, `detach-internet-gateway` + `delete-internet-gateway`, subred y por último la VPC.',
    },
    {
      id: 'l03-e2',
      title: 'Red en dos AZ: subredes públicas y privadas',
      summary: 'Cuatro subredes (2 públicas, 2 privadas) repartidas en dos zonas de disponibilidad.',
      difficulty: 'Media',
      minutes: 20,
      saa: [SAA_DOMAINS[2], SAA_DOMAINS[1]],
      tags: ['VPC', 'Multi-AZ', 'Subredes'],
      scenario: 'Diseña la red de una aplicación que debe sobrevivir a la caída de una zona de disponibilidad. VPC `10.30.0.0/16` con **dos subredes públicas** (`10.30.1.0/24` en `eu-west-1a`, `10.30.2.0/24` en `eu-west-1b`) y **dos privadas** (`10.30.11.0/24` en `1a`, `10.30.12.0/24` en `1b`). Solo las públicas salen por el Internet Gateway y asignan IP pública al lanzar instancias.',
      steps: [
        { id: 'vpc', title: 'Crea la VPC `10.30.0.0/16`', check: (c) => !!c.vpc('10.30.0.0/16') || 'Falta la VPC 10.30.0.0/16.' },
        { id: 'subs', title: 'Crea las cuatro subredes, dos en cada AZ (`--availability-zone`)', hint: ['aws ec2 create-subnet --vpc-id $VPC --cidr-block 10.30.1.0/24 --availability-zone eu-west-1a'], check: (c) => { const v = c.vpc('10.30.0.0/16'); if (!v) return 'Falta la VPC.'; const s = c.subnets(v.id); const want: [string, string][] = [['10.30.1.0/24', 'eu-west-1a'], ['10.30.2.0/24', 'eu-west-1b'], ['10.30.11.0/24', 'eu-west-1a'], ['10.30.12.0/24', 'eu-west-1b']]; return want.every(([cidr, az]) => s.some((x) => x.cidr === cidr && x.az === az)) || 'Faltan subredes o están en la AZ equivocada.'; } },
        { id: 'igw', title: 'Crea un Internet Gateway, conéctalo y crea una tabla de rutas pública con `0.0.0.0/0 → IGW`', check: (c) => { const v = c.vpc('10.30.0.0/16'); return (!!v && c.s.routeTables.some((r) => r.vpcId === v.id && r.routes.some((x) => x.destination === '0.0.0.0/0' && x.target.startsWith('igw-')))) || 'Falta la tabla de rutas con salida por el IGW.'; } },
        { id: 'pub', title: 'Asocia la tabla pública **solo** a las dos subredes públicas', check: (c) => { const v = c.vpc('10.30.0.0/16'); if (!v) return 'Falta la VPC.'; const s = c.subnets(v.id); const pub = s.filter((x) => c.isPublic(x)).map((x) => x.cidr).sort(); return (pub.length === 2 && pub[0] === '10.30.1.0/24' && pub[1] === '10.30.2.0/24') || 'Deben ser públicas exactamente 10.30.1.0/24 y 10.30.2.0/24.'; } },
        { id: 'ip', title: 'Activa la asignación automática de IP pública en las dos subredes públicas', hint: ['aws ec2 modify-subnet-attribute --subnet-id <id> --map-public-ip-on-launch'], check: (c) => { const v = c.vpc('10.30.0.0/16'); if (!v) return 'Falta la VPC.'; const s = c.subnets(v.id).filter((x) => x.cidr === '10.30.1.0/24' || x.cidr === '10.30.2.0/24'); return (s.length === 2 && s.every((x) => x.mapPublicIpOnLaunch)) || 'Las subredes públicas aún no asignan IP pública al lanzar.'; } },
      ],
      script: [
        'VPC=$(aws ec2 create-vpc --cidr-block 10.30.0.0/16 --query Vpc.VpcId --output text)',
        'PUBA=$(aws ec2 create-subnet --vpc-id $VPC --cidr-block 10.30.1.0/24 --availability-zone eu-west-1a --query Subnet.SubnetId --output text)',
        'PUBB=$(aws ec2 create-subnet --vpc-id $VPC --cidr-block 10.30.2.0/24 --availability-zone eu-west-1b --query Subnet.SubnetId --output text)',
        'aws ec2 create-subnet --vpc-id $VPC --cidr-block 10.30.11.0/24 --availability-zone eu-west-1a',
        'aws ec2 create-subnet --vpc-id $VPC --cidr-block 10.30.12.0/24 --availability-zone eu-west-1b',
        'IGW=$(aws ec2 create-internet-gateway --query InternetGateway.InternetGatewayId --output text)',
        'aws ec2 attach-internet-gateway --internet-gateway-id $IGW --vpc-id $VPC',
        'RT=$(aws ec2 create-route-table --vpc-id $VPC --query RouteTable.RouteTableId --output text)',
        'aws ec2 create-route --route-table-id $RT --destination-cidr-block 0.0.0.0/0 --gateway-id $IGW',
        'aws ec2 associate-route-table --route-table-id $RT --subnet-id $PUBA',
        'aws ec2 associate-route-table --route-table-id $RT --subnet-id $PUBB',
        'aws ec2 modify-subnet-attribute --subnet-id $PUBA --map-public-ip-on-launch',
        'aws ec2 modify-subnet-attribute --subnet-id $PUBB --map-public-ip-on-launch',
      ],
      realWorld: 'Es el esqueleto de la VPC de **aws-secure-infrastructure**: dos AZ, subredes públicas para el balanceador y privadas para la aplicación y los datos. VPC, subredes y rutas son gratis en tu cuenta real; en producción etiqueta todo con `Name` y calcula bloques CIDR con holgura (una `/24` por subred y AZ suele bastar). **Limpieza:** borra en orden inverso (rutas y asociaciones → IGW → subredes → VPC).',
    },
    {
      id: 'l03-e3',
      title: 'Subred privada con salida por NAT',
      summary: 'Subred privada que sale a internet a través de un NAT Gateway, sin ser alcanzable.',
      difficulty: 'Difícil',
      minutes: 20,
      saa: [SAA_DOMAINS[1], SAA_DOMAINS[4]],
      tags: ['VPC', 'NAT Gateway', 'Elastic IP', 'Coste'],
      scenario: 'Ya tienes una VPC `10.20.0.0/16` con una subred pública `10.20.1.0/24` conectada a internet. Añade una subred **privada** `10.20.2.0/24` cuyas instancias puedan salir a internet (parches, APIs) pero **no recibir** tráfico entrante. Piensa dónde va el NAT Gateway y qué IP necesita.',
      setup: async (sh) => {
        await prep(sh, [...baseVpc, 'unset VPC SUB IGW RT']);
      },
      steps: [
        { id: 'priv', title: 'Crea la subred privada `10.20.2.0/24` en la VPC existente', hint: ['Localiza la VPC: `aws ec2 describe-vpcs --filters Name=cidr,Values=10.20.0.0/16 --query Vpcs[0].VpcId --output text`.'], check: (c) => { const v = c.vpc('10.20.0.0/16'); return (!!v && c.subnets(v.id).some((x) => x.cidr === '10.20.2.0/24')) || 'Falta la subred privada 10.20.2.0/24.'; } },
        { id: 'eip', title: 'Reserva una IP elástica (`allocate-address`)', check: (c) => c.trail('AllocateAddress', { error: false }).length > 0 || 'Aún no has reservado una IP elástica.' },
        { id: 'nat', title: 'Crea un NAT Gateway en la subred **pública** con esa IP', hint: ['aws ec2 create-nat-gateway --subnet-id <subred pública 10.20.1.0/24> --allocation-id <eipalloc-…>'], check: (c) => { const v = c.vpc('10.20.0.0/16'); const pub = v && c.subnets(v.id).find((x) => x.cidr === '10.20.1.0/24'); return (!!pub && c.s.natGateways.some((n) => n.state !== 'deleted' && n.subnetId === pub.id)) || 'Falta un NAT Gateway en la subred pública.'; } },
        { id: 'route', title: 'Enruta `0.0.0.0/0` de la subred privada al NAT, sin que sea pública', hint: ['Tabla de rutas nueva con `create-route --nat-gateway-id` y `associate-route-table` a la subred privada.'], check: (c) => {
          const v = c.vpc('10.20.0.0/16'); const sub = v && c.subnets(v.id).find((x) => x.cidr === '10.20.2.0/24');
          if (!sub) return 'Falta la subred privada.';
          const rt = c.routeTableOf(sub);
          return (rt.routes.some((r) => r.destination === '0.0.0.0/0' && r.target.startsWith('nat-')) && !c.isPublic(sub)) || 'La subred privada aún no sale por el NAT.';
        } },
      ],
      script: [
        'VPC=$(aws ec2 describe-vpcs --filters Name=cidr,Values=10.20.0.0/16 --query Vpcs[0].VpcId --output text)',
        'PUB=$(aws ec2 describe-subnets --filters Name=cidr-block,Values=10.20.1.0/24 --query Subnets[0].SubnetId --output text)',
        'PRIV=$(aws ec2 create-subnet --vpc-id $VPC --cidr-block 10.20.2.0/24 --query Subnet.SubnetId --output text)',
        'EIP=$(aws ec2 allocate-address --query AllocationId --output text)',
        'NAT=$(aws ec2 create-nat-gateway --subnet-id $PUB --allocation-id $EIP --query NatGateway.NatGatewayId --output text)',
        'RT=$(aws ec2 create-route-table --vpc-id $VPC --query RouteTable.RouteTableId --output text)',
        'aws ec2 create-route --route-table-id $RT --destination-cidr-block 0.0.0.0/0 --nat-gateway-id $NAT',
        'aws ec2 associate-route-table --route-table-id $RT --subnet-id $PRIV',
      ],
      realWorld: 'Cuidado con el dinero en la cuenta real: el NAT Gateway cuesta unos **0,048 USD/hora** (≈ 35 USD/mes) más el tráfico, y la IP elástica sin asociar también se factura. Es el recurso que más facturas sorpresa genera en laboratorios. En **aws-secure-infrastructure** valora un solo NAT en desarrollo y uno por AZ en producción. **Limpieza inmediata:** `delete-nat-gateway`, espera a que pase a `deleted` y después `release-address`.',
    },
    {
      id: 'l03-e4',
      title: 'Diagnostica una instancia sin internet',
      summary: 'La instancia app-1 no sale a internet: hay dos causas distintas.',
      difficulty: 'Difícil',
      minutes: 25,
      saa: [SAA_DOMAINS[1], SAA_DOMAINS[3]],
      tags: ['VPC', 'Diagnóstico', 'Rutas', 'Security Group'],
      scenario: 'El equipo de aplicaciones dice: *«`app-1` no puede descargar paquetes, no sale a internet»*. La instancia está `running`, en una subred con Internet Gateway y con IP pública, así que la red «parece bien». Recorre el camino del paquete **de dentro hacia fuera** (instancia → grupo de seguridad → tabla de rutas → gateway), encuentra **las dos causas** y corrígelas sin abrir nada que no haga falta.',
      setup: async (sh) => {
        await prep(sh, [
          'VPC=$(aws ec2 create-vpc --cidr-block 10.50.0.0/16 --query Vpc.VpcId --output text)',
          'SUB=$(aws ec2 create-subnet --vpc-id $VPC --cidr-block 10.50.1.0/24 --query Subnet.SubnetId --output text)',
          'IGW=$(aws ec2 create-internet-gateway --query InternetGateway.InternetGatewayId --output text)',
          'aws ec2 attach-internet-gateway --internet-gateway-id $IGW --vpc-id $VPC',
          'RT=$(aws ec2 create-route-table --vpc-id $VPC --query RouteTable.RouteTableId --output text)',
          'aws ec2 create-route --route-table-id $RT --destination-cidr-block 0.0.0.0/0 --gateway-id $IGW',
          'SG=$(aws ec2 create-security-group --group-name app-sg --description "Aplicacion" --vpc-id $VPC --query GroupId --output text)',
          'aws ec2 revoke-security-group-egress --group-id $SG --protocol -1 --cidr 0.0.0.0/0',
          `aws ec2 run-instances --image-id ${AMI} --instance-type t3.micro --subnet-id $SUB --security-group-ids $SG --associate-public-ip-address --tag-specifications ${T('instance', 'Name', 'app-1')}`,
          'unset VPC SUB IGW RT SG',
        ]);
      },
      steps: [
        { id: 'inst', title: 'Localiza `app-1`: estado, subred, IP pública y grupo de seguridad con `describe-instances`', hint: ['aws ec2 describe-instances --filters Name=tag:Name,Values=app-1 --query \'Reservations[].Instances[].[InstanceId,State.Name,SubnetId,PublicIpAddress,SecurityGroups[].GroupId]\' --output text'], check: (c) => c.trail('DescribeInstances').length > 0 || 'Aún no has inspeccionado la instancia.' },
        { id: 'rt', title: 'Inspecciona las tablas de rutas (`describe-route-tables`): ¿qué subred usa cada una?', hint: ['Mira el campo `Associations`: la tabla con la ruta al IGW, ¿está asociada a la subred de `app-1`?'], check: (c) => c.trail('DescribeRouteTables').length > 0 || 'Aún no has revisado las tablas de rutas.' },
        { id: 'fixrt', title: 'Causa 1: haz que la subred de `app-1` use una tabla con ruta `0.0.0.0/0` al IGW', hint: ['La tabla correcta existe pero está sin asociar.', 'aws ec2 associate-route-table --route-table-id <rtb-…> --subnet-id <subnet-…>'], check: (c) => { const i = c.instance((x) => x.tags.Name === 'app-1'); if (!i) return 'No encuentro la instancia app-1.'; const sub = c.s.subnets.find((s) => s.id === i.subnetId)!; return c.isPublic(sub) || 'La subred de app-1 sigue sin ruta al Internet Gateway.'; } },
        { id: 'sg', title: 'Inspecciona el grupo de seguridad de `app-1` (`describe-security-groups`): fíjate en `IpPermissionsEgress`', check: (c) => c.trail('DescribeSecurityGroups').length > 0 || 'Aún no has revisado el grupo de seguridad.' },
        { id: 'fixsg', title: 'Causa 2: permite la salida (`authorize-security-group-egress`) del grupo `app-sg`', hint: ['aws ec2 authorize-security-group-egress --group-id <sg-…> --protocol -1 --cidr 0.0.0.0/0'], check: (c) => { const i = c.instance((x) => x.tags.Name === 'app-1'); if (!i) return 'No encuentro la instancia app-1.'; return i.securityGroupIds.some((id) => c.sgById(id)?.egress.length) || 'El grupo de seguridad sigue sin permitir tráfico de salida.'; } },
        { id: 'ok', title: 'Confirma que app-1 ya puede salir a internet', detail: 'Cuando las dos causas estén corregidas, esta comprobación se marca sola.', check: (c) => { const i = c.instance((x) => x.tags.Name === 'app-1'); if (!i) return 'No encuentro la instancia app-1.'; const r = c.egress(i); return r.ok || r.reason; } },
      ],
      script: [
        "aws ec2 describe-instances --filters Name=tag:Name,Values=app-1 --query 'Reservations[].Instances[].[InstanceId,State.Name,SubnetId,PublicIpAddress,SecurityGroups[].GroupId]' --output text",
        'VPC=$(aws ec2 describe-vpcs --filters Name=cidr,Values=10.50.0.0/16 --query Vpcs[0].VpcId --output text)',
        "aws ec2 describe-route-tables --filters Name=vpc-id,Values=$VPC --query 'RouteTables[].[RouteTableId,Associations[].SubnetId,Routes[].[DestinationCidrBlock,GatewayId]]' --output json",
        "RTB=$(aws ec2 describe-route-tables --filters Name=vpc-id,Values=$VPC --query 'RouteTables[?Routes[?starts_with(GatewayId, `igw-`)]].RouteTableId' --output text)",
        'aws ec2 associate-route-table --route-table-id $RTB --subnet-id $(aws ec2 describe-subnets --filters Name=cidr-block,Values=10.50.1.0/24 --query Subnets[0].SubnetId --output text)',
        "aws ec2 describe-security-groups --filters Name=group-name,Values=app-sg --query 'SecurityGroups[].[GroupId,IpPermissionsEgress]'",
        'aws ec2 authorize-security-group-egress --group-id $(aws ec2 describe-security-groups --filters Name=group-name,Values=app-sg --query SecurityGroups[0].GroupId --output text) --protocol -1 --cidr 0.0.0.0/0',
      ],
      realWorld: 'En una cuenta real tienes la herramienta **VPC Reachability Analyzer** (consola: «Reachability Analyzer») que recorre este mismo camino y te dice qué componente bloquea el paquete; y los **VPC Flow Logs** para ver qué tráfico se rechaza. Los grupos de seguridad reales llevan por defecto una regla de salida que permite todo: si alguien la elimina, el síntoma es exactamente este. **Limpieza:** `terminate-instances` (una `t3.micro` fuera de la capa gratuita cuesta unos 0,01 USD/hora) y borra la red.',
    },
    {
      id: 'l03-e5',
      title: 'Reto: red de producción completa',
      summary: 'VPC `prod` con 4 subredes en 2 AZ, IGW, NAT y rutas, todo desde cero.',
      difficulty: 'Reto',
      minutes: 30,
      saa: [SAA_DOMAINS[1], SAA_DOMAINS[2], SAA_DOMAINS[4]],
      tags: ['VPC', 'Multi-AZ', 'NAT Gateway', 'Terraform'],
      scenario: 'Es tu **VPC de producción**, como la de tu laboratorio Terraform. Construye desde cero, sin guía: VPC `10.40.0.0/16` con la etiqueta `Name=prod`; dos subredes públicas (`10.40.1.0/24` en `eu-west-1a`, `10.40.2.0/24` en `eu-west-1b`) y dos privadas (`10.40.11.0/24` en `1a`, `10.40.12.0/24` en `1b`); un Internet Gateway; **un** NAT Gateway (ahorra costes) en una pública; las públicas salen por el IGW y asignan IP pública, las privadas salen **solo** por el NAT. Verifica el resultado con `describe-route-tables`.',
      steps: [
        { id: 'vpc', title: 'VPC `10.40.0.0/16` con la etiqueta `Name=prod`', hint: ["--tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=prod}]'"], check: (c) => { const v = c.vpc('10.40.0.0/16'); return (v?.tags.Name === 'prod') || 'Falta la VPC 10.40.0.0/16 con Name=prod.'; } },
        { id: 'subs', title: 'Cuatro subredes en las AZ y CIDR indicados', check: (c) => { const v = c.vpc('10.40.0.0/16'); if (!v) return 'Falta la VPC.'; const s = c.subnets(v.id); const want: [string, string][] = [['10.40.1.0/24', 'eu-west-1a'], ['10.40.2.0/24', 'eu-west-1b'], ['10.40.11.0/24', 'eu-west-1a'], ['10.40.12.0/24', 'eu-west-1b']]; return want.every(([cidr, az]) => s.some((x) => x.cidr === cidr && x.az === az)) || 'Faltan subredes o están en la AZ equivocada.'; } },
        { id: 'pub', title: 'Las dos subredes públicas salen por el IGW y asignan IP pública', check: (c) => { const v = c.vpc('10.40.0.0/16'); if (!v) return 'Falta la VPC.'; const p = c.subnets(v.id).filter((x) => x.cidr === '10.40.1.0/24' || x.cidr === '10.40.2.0/24'); return (p.length === 2 && p.every((x) => c.isPublic(x) && x.mapPublicIpOnLaunch)) || 'Las subredes públicas deben tener ruta al IGW y asignar IP pública.'; } },
        { id: 'nat', title: 'Un NAT Gateway en una subred pública, con IP elástica', check: (c) => { const v = c.vpc('10.40.0.0/16'); if (!v) return 'Falta la VPC.'; const pubIds = c.subnets(v.id).filter((x) => c.isPublic(x)).map((x) => x.id); return c.s.natGateways.some((n) => n.state !== 'deleted' && pubIds.includes(n.subnetId)) || 'Falta un NAT Gateway en una subred pública.'; } },
        { id: 'priv', title: 'Las dos subredes privadas salen **solo** por el NAT (y no son públicas)', check: (c) => { const v = c.vpc('10.40.0.0/16'); if (!v) return 'Falta la VPC.'; const p = c.subnets(v.id).filter((x) => x.cidr === '10.40.11.0/24' || x.cidr === '10.40.12.0/24'); return (p.length === 2 && p.every((x) => !c.isPublic(x) && c.routeTableOf(x).routes.some((r) => r.destination === '0.0.0.0/0' && r.target.startsWith('nat-')))) || 'Las subredes privadas deben enrutar 0.0.0.0/0 al NAT.'; } },
        { id: 'ver', title: 'Verifica la configuración con `describe-route-tables`', check: (c) => c.ran(/describe-route-tables/) || 'Ejecuta describe-route-tables para revisar las rutas.' },
      ],
      script: [
        `VPC=$(aws ec2 create-vpc --cidr-block 10.40.0.0/16 --tag-specifications ${T('vpc', 'Name', 'prod')} --query Vpc.VpcId --output text)`,
        'PUBA=$(aws ec2 create-subnet --vpc-id $VPC --cidr-block 10.40.1.0/24 --availability-zone eu-west-1a --query Subnet.SubnetId --output text)',
        'PUBB=$(aws ec2 create-subnet --vpc-id $VPC --cidr-block 10.40.2.0/24 --availability-zone eu-west-1b --query Subnet.SubnetId --output text)',
        'PRIVA=$(aws ec2 create-subnet --vpc-id $VPC --cidr-block 10.40.11.0/24 --availability-zone eu-west-1a --query Subnet.SubnetId --output text)',
        'PRIVB=$(aws ec2 create-subnet --vpc-id $VPC --cidr-block 10.40.12.0/24 --availability-zone eu-west-1b --query Subnet.SubnetId --output text)',
        'IGW=$(aws ec2 create-internet-gateway --query InternetGateway.InternetGatewayId --output text)',
        'aws ec2 attach-internet-gateway --internet-gateway-id $IGW --vpc-id $VPC',
        'RTPUB=$(aws ec2 create-route-table --vpc-id $VPC --query RouteTable.RouteTableId --output text)',
        'aws ec2 create-route --route-table-id $RTPUB --destination-cidr-block 0.0.0.0/0 --gateway-id $IGW',
        'aws ec2 associate-route-table --route-table-id $RTPUB --subnet-id $PUBA',
        'aws ec2 associate-route-table --route-table-id $RTPUB --subnet-id $PUBB',
        'aws ec2 modify-subnet-attribute --subnet-id $PUBA --map-public-ip-on-launch',
        'aws ec2 modify-subnet-attribute --subnet-id $PUBB --map-public-ip-on-launch',
        'EIP=$(aws ec2 allocate-address --query AllocationId --output text)',
        'NAT=$(aws ec2 create-nat-gateway --subnet-id $PUBA --allocation-id $EIP --query NatGateway.NatGatewayId --output text)',
        'RTPRIV=$(aws ec2 create-route-table --vpc-id $VPC --query RouteTable.RouteTableId --output text)',
        'aws ec2 create-route --route-table-id $RTPRIV --destination-cidr-block 0.0.0.0/0 --nat-gateway-id $NAT',
        'aws ec2 associate-route-table --route-table-id $RTPRIV --subnet-id $PRIVA',
        'aws ec2 associate-route-table --route-table-id $RTPRIV --subnet-id $PRIVB',
        "aws ec2 describe-route-tables --filters Name=vpc-id,Values=$VPC --query 'RouteTables[].[RouteTableId,Associations[].SubnetId,Routes[].[DestinationCidrBlock,GatewayId,NatGatewayId]]' --output json",
      ],
      realWorld: 'Este es, a pequeña escala, el módulo de red de **aws-secure-infrastructure**. Con Terraform lo describes una vez y `terraform plan` te enseña el coste implícito: el único recurso de pago aquí es el NAT Gateway (≈ 35 USD/mes + tráfico) y su IP elástica. En producción real pon un NAT por AZ y añade *VPC endpoints* de S3 para ahorrar tráfico por el NAT. **Limpieza:** `terraform destroy` (o `delete-nat-gateway` + `release-address` primero y la red después).',
    },
  ],
  quiz: [
    { domain: 1, q: '¿Qué convierte a una subred en pública?', options: ['Un check «pública» en la subred', 'Una ruta 0.0.0.0/0 hacia un Internet Gateway en su tabla de rutas', 'Tener un NAT Gateway', 'Un grupo de seguridad abierto'], answer: 1, explain: 'La publicidad la define la tabla de rutas asociada, no la subred. La instancia además necesita IP pública.' },
    { domain: 1, q: '¿Dónde debe crearse un NAT Gateway para dar salida a las subredes privadas?', options: ['En una subred privada', 'En una subred pública', 'Fuera de la VPC', 'En cualquiera, da igual'], answer: 1, explain: 'El NAT necesita salir por el Internet Gateway, así que vive en una subred pública con una IP elástica.' },
    { domain: 2, q: 'Quieres que tu aplicación sobreviva a la caída de una zona de disponibilidad. ¿Qué diseño de red es el adecuado?', options: ['Una subred grande en una sola AZ', 'Subredes en al menos dos AZ con recursos repartidos entre ellas', 'Dos VPC en la misma AZ', 'Una Elastic IP por instancia'], answer: 1, explain: 'Cada subred vive en una única AZ: la resiliencia se consigue repartiendo subredes y recursos en varias.' },
    { domain: 4, q: 'Tus instancias privadas solo descargan datos de S3 y el NAT Gateway genera mucho coste. ¿Qué haces?', options: ['Cambiar a instancias más pequeñas', 'Crear un Gateway VPC Endpoint para S3', 'Pasar las instancias a la subred pública', 'Añadir un segundo NAT'], answer: 1, explain: 'El Gateway Endpoint de S3 no tiene coste y evita enviar ese tráfico por el NAT.' },
    { domain: 1, q: 'Necesitas bloquear la IP de un atacante concreto para toda una subred. ¿Qué usas?', options: ['Un security group con regla deny', 'Una Network ACL con regla deny', 'Una tabla de rutas', 'Un NAT Gateway'], answer: 1, explain: 'Solo las NACL admiten reglas de denegación. Los security groups únicamente permiten.' },
    { domain: 1, q: 'Los security groups, ¿son con estado o sin estado?', options: ['Sin estado: hay que permitir ida y vuelta', 'Con estado: la respuesta a una conexión permitida vuelve sola', 'Depende de la región', 'Solo con estado para tráfico TCP'], answer: 1, explain: 'Los SG son con estado; las NACL no, y por eso necesitan reglas de entrada y salida.' },
    { domain: 3, q: 'Quieres conectar la VPC con la oficina con un ancho de banda estable y baja latencia, evitando internet. ¿Qué eliges?', options: ['VPN sitio a sitio sobre internet', 'AWS Direct Connect', 'Un Internet Gateway', 'VPC Peering'], answer: 1, explain: 'Direct Connect es un enlace dedicado privado con ancho de banda y latencia predecibles.' },
    { domain: 2, q: 'Para que el tráfico de salida de dos AZ no dependa de una sola zona, ¿cuántos NAT Gateway despliegas en producción?', options: ['Uno en total', 'Uno por AZ, cada subred privada enruta al de su AZ', 'Uno por instancia', 'Ninguno, basta el Internet Gateway'], answer: 1, explain: 'Un NAT es zonal: uno por AZ evita que la caída de una zona corte la salida de las demás.' },
  ],
};

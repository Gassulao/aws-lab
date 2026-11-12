import { SAA_DOMAINS, type Level } from '../types';
import { prep } from '../setup';
import instancias from './l04/1-instancias.md?raw';
import seguridad from './l04/2-seguridad.md?raw';
import coste from './l04/3-coste.md?raw';
import diag from './l04/4-diagnostico.md?raw';

const AMI = 'ami-0a1b2c3d4e5f60001';
const NAME = (n: string) => `'ResourceType=instance,Tags=[{Key=Name,Value=${n}}]'`;
const MY_IP = '203.0.113.50';

export const l04: Level = {
  id: 4,
  slug: 'ec2',
  title: 'Cómputo con EC2',
  subtitle: 'Instancias, grupos de seguridad, IMDSv2, ciclo de vida y coste',
  skills: ['Lanzar instancias', 'Grupos de seguridad en capas', 'IMDSv2', 'Ciclo de vida y coste', 'Diagnóstico de SSH'],
  lessons: [
    { id: 'l04-instancias', title: 'Instancias, AMI y estados', minutes: 7, body: instancias },
    { id: 'l04-seguridad', title: 'Seguridad: SG, IMDSv2 y roles de instancia', minutes: 8, body: seguridad },
    { id: 'l04-coste', title: 'Ciclo de vida y coste', minutes: 7, body: coste },
    { id: 'l04-diag', title: 'Diagnóstico: «no puedo entrar por SSH»', minutes: 7, body: diag },
  ],
  exercises: [
    {
      id: 'l04-e1',
      title: 'Lanza tu primera instancia de forma segura',
      summary: 'Par de claves, grupo de seguridad con SSH acotado a tu IP y una t3.micro etiquetada.',
      difficulty: 'Fácil',
      minutes: 12,
      saa: [SAA_DOMAINS[1], SAA_DOMAINS[4]],
      tags: ['EC2', 'Security Group', 'Key pair'],
      scenario: `Tu equipo necesita un servidor de pruebas. Lánzalo siguiendo las buenas prácticas: **par de claves** propio, un **grupo de seguridad** que solo permita SSH desde tu IP (\`${MY_IP}/32\`, nunca \`0.0.0.0/0\`) y un tipo pequeño de la capa gratuita (\`t3.micro\`) con la etiqueta \`Name\`.`,
      steps: [
        { id: 'key', title: 'Crea el par de claves `lab-key` y guarda la clave privada en `~/lab-key.pem`', hint: ['aws ec2 create-key-pair --key-name lab-key --query KeyMaterial --output text > ~/lab-key.pem'], check: (c) => (!!c.s.keyPairs.some((k) => k.name === 'lab-key') && !!c.file('lab-key.pem')?.includes('PRIVATE KEY')) || 'Falta el par lab-key o el fichero ~/lab-key.pem.' },
        { id: 'sg', title: 'Crea el grupo `ssh-sg` y permite TCP/22 solo desde tu IP `/32`', hint: ['aws ec2 create-security-group --group-name ssh-sg --description "SSH desde mi IP"', `aws ec2 authorize-security-group-ingress --group-id <sg> --protocol tcp --port 22 --cidr ${MY_IP}/32`], check: (c) => { const g = c.sg('ssh-sg'); if (!g) return 'Falta el grupo ssh-sg.'; if (c.sgAllows(g, 22, '0.0.0.0/0')) return 'ssh-sg no debe abrir el puerto 22 a todo internet.'; return c.sgAllows(g, 22, `${MY_IP}/32`) || `ssh-sg debe permitir TCP/22 desde ${MY_IP}/32.`; } },
        { id: 'run', title: 'Lanza una `t3.micro` con Amazon Linux 2023, esa clave y ese grupo', hint: ['aws ec2 describe-images para ver el ID de la AMI (Amazon Linux 2023).', `aws ec2 run-instances --image-id ${AMI} --instance-type t3.micro --key-name lab-key --security-group-ids <sg>`], check: (c) => { const i = c.instance((x) => x.keyName === 'lab-key'); if (!i) return 'Aún no hay ninguna instancia con la clave lab-key.'; const g = c.sg('ssh-sg'); return (i.type === 't3.micro' && !!g && i.securityGroupIds.includes(g.id)) || 'La instancia debe ser t3.micro y usar ssh-sg.'; } },
        { id: 'tag', title: 'Etiquétala con `Name=mi-primera`', hint: ['Con `--tag-specifications` al lanzar o después con `aws ec2 create-tags --resources <i-…> --tags Key=Name,Value=mi-primera`.'], check: (c) => c.instance((x) => x.tags.Name === 'mi-primera') ? true : 'Ninguna instancia tiene la etiqueta Name=mi-primera.' },
      ],
      script: [
        'aws ec2 create-key-pair --key-name lab-key --query KeyMaterial --output text > ~/lab-key.pem',
        'SG=$(aws ec2 create-security-group --group-name ssh-sg --description "SSH desde mi IP" --query GroupId --output text)',
        `aws ec2 authorize-security-group-ingress --group-id $SG --protocol tcp --port 22 --cidr ${MY_IP}/32`,
        `aws ec2 run-instances --image-id ${AMI} --instance-type t3.micro --key-name lab-key --security-group-ids $SG --tag-specifications ${NAME('mi-primera')} --query 'Instances[0].[InstanceId,State.Name]' --output text`,
      ],
      realWorld: 'En tu cuenta real, protege la clave con `chmod 400 lab-key.pem` y conéctate con `ssh -i lab-key.pem ec2-user@<IP pública>`; consulta tu IP con `curl https://checkip.amazonaws.com`. Una `t3.micro` entra en la capa gratuita los 12 primeros meses (750 h/mes). En **aws-secure-infrastructure** el acceso va por **Session Manager**, sin SSH ni puertos abiertos. **Limpieza:** `terminate-instances`, `delete-security-group` y `delete-key-pair`.',
    },
    {
      id: 'l04-e2',
      title: 'Endurece los grupos de seguridad en capas',
      summary: 'La base de datos acepta tráfico solo desde la capa web, no desde internet.',
      difficulty: 'Media',
      minutes: 15,
      saa: [SAA_DOMAINS[1]],
      tags: ['EC2', 'Security Group', 'Arquitectura en capas'],
      scenario: 'En una auditoría aparece que el grupo `db-sg` (MySQL, puerto 3306) está **abierto a todo internet**. Corrígelo con una arquitectura en capas: `web-sg` recibe HTTP/HTTPS de cualquiera; `db-sg` solo acepta el 3306 **desde instancias con `web-sg`**, no desde rangos de IP.',
      setup: async (sh) => {
        await prep(sh, [
          'WEB=$(aws ec2 create-security-group --group-name web-sg --description "Capa web" --query GroupId --output text)',
          'DB=$(aws ec2 create-security-group --group-name db-sg --description "Capa de datos" --query GroupId --output text)',
          'aws ec2 authorize-security-group-ingress --group-id $DB --protocol tcp --port 3306 --cidr 0.0.0.0/0',
          'unset WEB DB',
        ]);
      },
      steps: [
        { id: 'audit', title: 'Audita los grupos con `describe-security-groups` y localiza la regla peligrosa', hint: ["aws ec2 describe-security-groups --filters Name=group-name,Values=db-sg --query 'SecurityGroups[].IpPermissions'"], check: (c) => c.trail('DescribeSecurityGroups').length > 0 || 'Aún no has auditado los grupos.' },
        { id: 'web', title: 'Permite en `web-sg` TCP/80 y TCP/443 desde `0.0.0.0/0`', check: (c) => { const g = c.sg('web-sg'); return (!!g && c.sgAllows(g, 80, '0.0.0.0/0') && c.sgAllows(g, 443, '0.0.0.0/0')) || 'web-sg debe permitir 80 y 443 desde cualquier origen.'; } },
        { id: 'revoke', title: 'Revoca la regla de `db-sg` que abre el 3306 a `0.0.0.0/0`', hint: ['aws ec2 revoke-security-group-ingress --group-id <db-sg> --protocol tcp --port 3306 --cidr 0.0.0.0/0'], check: (c) => { const g = c.sg('db-sg'); return (!!g && !c.sgAllows(g, 3306, '0.0.0.0/0')) || 'db-sg sigue abierto a todo internet.'; } },
        { id: 'src', title: 'Permite en `db-sg` el 3306 **solo** desde el grupo `web-sg` (`--source-group`)', hint: ['aws ec2 authorize-security-group-ingress --group-id <db-sg> --protocol tcp --port 3306 --source-group <web-sg>'], check: (c) => { const g = c.sg('db-sg'); const w = c.sg('web-sg'); if (!g || !w) return 'Faltan los grupos.'; return (g.ingress.some((r) => r.sourceSg === w.id && r.from <= 3306 && r.to >= 3306) && g.ingress.every((r) => !r.cidr)) || 'db-sg debe aceptar el 3306 únicamente desde web-sg.'; } },
      ],
      script: [
        'WEB=$(aws ec2 describe-security-groups --filters Name=group-name,Values=web-sg --query SecurityGroups[0].GroupId --output text)',
        'DB=$(aws ec2 describe-security-groups --filters Name=group-name,Values=db-sg --query SecurityGroups[0].GroupId --output text)',
        "aws ec2 describe-security-groups --group-ids $DB --query 'SecurityGroups[].IpPermissions'",
        'aws ec2 authorize-security-group-ingress --group-id $WEB --protocol tcp --port 80 --cidr 0.0.0.0/0',
        'aws ec2 authorize-security-group-ingress --group-id $WEB --protocol tcp --port 443 --cidr 0.0.0.0/0',
        'aws ec2 revoke-security-group-ingress --group-id $DB --protocol tcp --port 3306 --cidr 0.0.0.0/0',
        'aws ec2 authorize-security-group-ingress --group-id $DB --protocol tcp --port 3306 --source-group $WEB',
      ],
      realWorld: 'Es la misma idea que el módulo de seguridad de **aws-secure-infrastructure**: reglas por referencia de grupo, nunca por rangos de IP internos. En la cuenta real, **AWS Config** (`restricted-common-ports`, `vpc-sg-open-only-to-authorized-ports`) y **Security Hub** detectan automáticamente reglas abiertas al mundo. Los grupos de seguridad no cuestan nada. **Limpieza:** borra primero la regla que referencia (o el grupo db-sg) y luego web-sg; no se puede borrar un grupo referenciado por otro.',
    },
    {
      id: 'l04-e3',
      title: 'Obliga a usar IMDSv2',
      summary: 'Cierra el robo de credenciales por SSRF en las instancias existentes y en las nuevas.',
      difficulty: 'Media',
      minutes: 12,
      saa: [SAA_DOMAINS[1]],
      tags: ['EC2', 'IMDSv2', 'Metadatos', 'Seguridad'],
      scenario: 'Un informe de seguridad avisa: las instancias `legacy-app` y `batch-1` aceptan **IMDSv1**, de modo que una vulnerabilidad SSRF en una aplicación podría robar las credenciales del rol. Debes exigir **IMDSv2** (`HttpTokens=required`) en las que existen y garantizar que **toda instancia nueva** nazca ya con ello.',
      setup: async (sh) => {
        await prep(sh, [
          `aws ec2 run-instances --image-id ${AMI} --instance-type t3.micro --tag-specifications ${NAME('legacy-app')}`,
          `aws ec2 run-instances --image-id ${AMI} --instance-type t3.small --tag-specifications ${NAME('batch-1')}`,
        ]);
      },
      steps: [
        { id: 'find', title: 'Lista las instancias y su `MetadataOptions.HttpTokens`', hint: ["aws ec2 describe-instances --query 'Reservations[].Instances[].[InstanceId,Tags[0].Value,MetadataOptions.HttpTokens]' --output text"], check: (c) => c.trail('DescribeInstances').length > 0 || 'Aún no has revisado las instancias.' },
        { id: 'legacy', title: 'Exige IMDSv2 en `legacy-app`', hint: ['aws ec2 modify-instance-metadata-options --instance-id <i-…> --http-tokens required'], check: (c) => c.instance((i) => i.tags.Name === 'legacy-app')?.httpTokens === 'required' || 'legacy-app todavía acepta IMDSv1.' },
        { id: 'batch', title: 'Exige IMDSv2 en `batch-1`', check: (c) => c.instance((i) => i.tags.Name === 'batch-1')?.httpTokens === 'required' || 'batch-1 todavía acepta IMDSv1.' },
        { id: 'new', title: 'Lanza `nueva-app` ya con `--metadata-options HttpTokens=required`', hint: [`aws ec2 run-instances --image-id ${AMI} --instance-type t3.micro --metadata-options HttpTokens=required,HttpEndpoint=enabled`], check: (c) => c.instance((i) => i.tags.Name === 'nueva-app')?.httpTokens === 'required' || 'Falta la instancia nueva-app con IMDSv2 obligatorio.' },
      ],
      script: [
        "aws ec2 describe-instances --query 'Reservations[].Instances[].[InstanceId,Tags[0].Value,MetadataOptions.HttpTokens]' --output text",
        "aws ec2 modify-instance-metadata-options --instance-id $(aws ec2 describe-instances --filters Name=tag:Name,Values=legacy-app --query 'Reservations[0].Instances[0].InstanceId' --output text) --http-tokens required",
        "aws ec2 modify-instance-metadata-options --instance-id $(aws ec2 describe-instances --filters Name=tag:Name,Values=batch-1 --query 'Reservations[0].Instances[0].InstanceId' --output text) --http-tokens required",
        `aws ec2 run-instances --image-id ${AMI} --instance-type t3.micro --metadata-options HttpTokens=required,HttpEndpoint=enabled --tag-specifications ${NAME('nueva-app')}`,
        "aws ec2 describe-instances --query 'Reservations[].Instances[].[Tags[0].Value,MetadataOptions.HttpTokens]' --output text",
      ],
      realWorld: 'En la cuenta real exigirlo en todas las nuevas es un ajuste de región: `aws ec2 modify-instance-metadata-defaults --http-tokens required`, o `MetadataOptions` en la plantilla de lanzamiento / `metadata_options` en Terraform (como en **aws-secure-infrastructure**). Antes de forzarlo en producción comprueba que tu software (SDKs antiguos) soporta IMDSv2; el panel «IMDSv2 adoption» de CloudWatch lo mide. **Limpieza:** `terminate-instances` en las de prueba.',
    },
    {
      id: 'l04-e4',
      title: 'Ciclo de vida de una instancia y qué pagas',
      summary: 'Lanza, para, arranca y termina una instancia sabiendo qué se factura en cada estado.',
      difficulty: 'Media',
      minutes: 15,
      saa: [SAA_DOMAINS[4]],
      tags: ['EC2', 'Coste', 'Ciclo de vida'],
      scenario: 'Vas a probar una carga durante la tarde y quieres gastar lo mínimo. Recorre el ciclo completo con una instancia `coste-lab` (`t3.micro`, ≈ 0,0104 USD/h): **lanzar → comprobar estado → parar → volver a arrancar → terminar**. Piensa en cada paso qué se factura: `running` paga cómputo; `stopped` solo EBS; `terminated` nada. *(Las transiciones tardan unos segundos: consulta el estado con `describe-instances` antes del siguiente paso.)*',
      steps: [
        { id: 'run', title: 'Lanza una `t3.micro` con la etiqueta `Name=coste-lab`', check: (c) => c.s.instances.some((i) => i.tags.Name === 'coste-lab') || 'Aún no has lanzado coste-lab.' },
        { id: 'state', title: 'Consulta su estado y tipo con `describe-instances`', hint: ["aws ec2 describe-instances --filters Name=tag:Name,Values=coste-lab --query 'Reservations[].Instances[].[InstanceId,InstanceType,State.Name]' --output text"], check: (c) => c.ran(/describe-instances.*coste-lab/) || 'Consulta el estado de coste-lab filtrando por su etiqueta.' },
        { id: 'stop', title: 'Páralo con `stop-instances` (deja de pagar cómputo)', check: (c) => c.trail('StopInstances', { error: false }).length > 0 || 'Aún no has parado la instancia.' },
        { id: 'start', title: 'Arráncalo de nuevo con `start-instances` cuando esté `stopped`', hint: ['Si ves `IncorrectInstanceState`, espera unos segundos a que pase de `stopping` a `stopped`.'], check: (c) => c.trail('StartInstances', { error: false }).length > 0 || 'Aún no has vuelto a arrancar la instancia (debe estar stopped).' },
        { id: 'term', title: 'Termínala con `terminate-instances`', check: (c) => c.s.instances.some((i) => i.tags.Name === 'coste-lab' && (i.state === 'terminated' || i.state === 'shutting-down')) || 'La instancia coste-lab aún no está terminada.' },
      ],
      script: [
        `ID=$(aws ec2 run-instances --image-id ${AMI} --instance-type t3.micro --tag-specifications ${NAME('coste-lab')} --query 'Instances[0].InstanceId' --output text)`,
        "aws ec2 describe-instances --filters Name=tag:Name,Values=coste-lab --query 'Reservations[].Instances[].[InstanceId,InstanceType,State.Name]' --output text",
        'aws ec2 stop-instances --instance-ids $ID',
        'sleep 6',
        'aws ec2 start-instances --instance-ids $ID',
        'aws ec2 terminate-instances --instance-ids $ID',
      ],
      realWorld: 'Haz lo mismo en tu cuenta real y revisa **Billing → Cost Explorer** al día siguiente. Recuerda: parar no elimina el volumen EBS (unos 0,08 USD/GB·mes en gp3) y **una IP elástica asociada a una instancia parada se factura**. Crea una alerta con **AWS Budgets** (p. ej. 5 USD) antes de lanzar nada. En **aws-secure-infrastructure** etiqueta todo con `Project` y `Environment` para filtrar el coste. **Limpieza:** `terminate-instances`, borra volúmenes huérfanos (`describe-volumes` con estado `available`) y libera IP elásticas.',
    },
    {
      id: 'l04-e5',
      title: 'Diagnostica: «no puedo entrar por SSH»',
      summary: 'La instancia bastion está inaccesible: hay dos causas, y la solución no puede ser abrirlo al mundo.',
      difficulty: 'Difícil',
      minutes: 25,
      saa: [SAA_DOMAINS[1]],
      tags: ['EC2', 'SSH', 'Diagnóstico', 'Security Group'],
      scenario: `Desde tu portátil (IP pública \`${MY_IP}\`) haces \`ssh -i lab-key.pem ec2-user@<IP>\` a la instancia \`bastion\` y obtienes **Connection timed out**. Un timeout significa que el paquete **no llega**. Recorre la lista de comprobación (¿en marcha? ¿IP pública? ¿subred pública? ¿grupo de seguridad?), encuentra **las dos causas** y corrígelas **sin abrir el 22 a \`0.0.0.0/0\`**.`,
      setup: async (sh) => {
        await prep(sh, [
          'aws ec2 create-key-pair --key-name lab-key --query KeyMaterial --output text > /tmp/lab-key.pem',
          'SG=$(aws ec2 create-security-group --group-name bastion-sg --description "Acceso SSH al bastion" --query GroupId --output text)',
          'aws ec2 authorize-security-group-ingress --group-id $SG --protocol tcp --port 22 --cidr 10.0.0.0/8',
          `ID=$(aws ec2 run-instances --image-id ${AMI} --instance-type t3.micro --key-name lab-key --security-group-ids $SG --tag-specifications ${NAME('bastion')} --query 'Instances[0].InstanceId' --output text)`,
          'unset SG ID',
        ]);
        // Alguien paró la instancia anoche: sin IP pública hasta que vuelva a arrancar.
        const i = sh.s.instances.find((x) => x.tags.Name === 'bastion')!;
        i.state = 'stopped';
        i.transition = undefined;
        if (i.runningSince) { i.billedMs += Date.now() - i.runningSince; i.runningSince = undefined; }
        i.publicIp = undefined;
      },
      steps: [
        { id: 'look', title: 'Mira la instancia `bastion`: estado, IP pública y grupo de seguridad', hint: ["aws ec2 describe-instances --filters Name=tag:Name,Values=bastion --query 'Reservations[].Instances[].[InstanceId,State.Name,PublicIpAddress,SecurityGroups[].GroupId]' --output text"], check: (c) => c.trail('DescribeInstances').length > 0 || 'Aún no has inspeccionado la instancia.' },
        { id: 'start', title: 'Causa 1: la instancia está parada. Arráncala', hint: ['aws ec2 start-instances --instance-ids <i-…>', 'Al arrancar recibirá una IP pública nueva: vuelve a consultarla.'], check: (c) => c.trail('StartInstances', { error: false }).length > 0 || 'La instancia bastion sigue parada.' },
        { id: 'sg', title: 'Revisa las reglas de entrada del grupo `bastion-sg`', hint: ["aws ec2 describe-security-groups --filters Name=group-name,Values=bastion-sg --query 'SecurityGroups[].IpPermissions'"], check: (c) => c.trail('DescribeSecurityGroups').length > 0 || 'Aún no has revisado el grupo de seguridad.' },
        { id: 'fix', title: `Causa 2: el SSH solo se permite desde \`10.0.0.0/8\`. Permite TCP/22 desde tu IP \`${MY_IP}/32\``, hint: [`aws ec2 authorize-security-group-ingress --group-id <sg-…> --protocol tcp --port 22 --cidr ${MY_IP}/32`], check: (c) => { const g = c.sg('bastion-sg'); if (!g) return 'No encuentro bastion-sg.'; if (c.sgAllows(g, 22, '0.0.0.0/0')) return 'No abras el 22 a todo internet.'; return c.sgAllows(g, 22, `${MY_IP}/32`) || `bastion-sg aún no permite el 22 desde ${MY_IP}/32.`; } },
        { id: 'clean', title: 'Limpia: elimina la regla vieja de `10.0.0.0/8`', check: (c) => { const g = c.sg('bastion-sg'); return (!!g && !c.sgAllows(g, 22, '10.0.0.0/8')) || 'Revoca la regla del 22 desde 10.0.0.0/8, que no sirve para nada.'; } },
        { id: 'ok', title: `Comprueba la conectividad: el 22 debe ser alcanzable desde ${MY_IP}`, detail: 'Se marca sola cuando la instancia está `running` y las reglas son correctas.', check: (c) => { const i = c.instance((x) => x.tags.Name === 'bastion'); if (!i) return 'No encuentro la instancia bastion.'; const r = c.reach(i, 22); return r.ok || r.reason; } },
      ],
      script: [
        "aws ec2 describe-instances --filters Name=tag:Name,Values=bastion --query 'Reservations[].Instances[].[InstanceId,State.Name,PublicIpAddress,SecurityGroups[].GroupId]' --output text",
        'aws ec2 start-instances --instance-ids $(aws ec2 describe-instances --filters Name=tag:Name,Values=bastion --query Reservations[0].Instances[0].InstanceId --output text)',
        "aws ec2 describe-security-groups --filters Name=group-name,Values=bastion-sg --query 'SecurityGroups[].IpPermissions'",
        `aws ec2 authorize-security-group-ingress --group-id $(aws ec2 describe-security-groups --filters Name=group-name,Values=bastion-sg --query SecurityGroups[0].GroupId --output text) --protocol tcp --port 22 --cidr ${MY_IP}/32`,
        'aws ec2 revoke-security-group-ingress --group-id $(aws ec2 describe-security-groups --filters Name=group-name,Values=bastion-sg --query SecurityGroups[0].GroupId --output text) --protocol tcp --port 22 --cidr 10.0.0.0/8',
        "aws ec2 describe-instances --filters Name=tag:Name,Values=bastion --query 'Reservations[].Instances[].[State.Name,PublicIpAddress]' --output text",
      ],
      realWorld: 'En una cuenta real esto se comprueba con **VPC Reachability Analyzer** y, sobre todo, evitando SSH: con **Systems Manager Session Manager** (rol de instancia con `AmazonSSMManagedInstanceCore`) entras sin IP pública ni puerto 22, y queda auditado. Si usas Elastic IP, la dirección no cambia al parar y arrancar (pero cobra si la instancia está parada). En **aws-secure-infrastructure** el acceso a las máquinas es por SSM. **Limpieza:** `terminate-instances`, `delete-security-group` y `delete-key-pair`.',
    },
  ],
  quiz: [
    { domain: 4, q: 'Tu aplicación corre 24/7 durante todo el año con carga estable. ¿Cuál es la opción de cómputo más económica?', options: ['Instancias bajo demanda', 'Savings Plan o instancias reservadas', 'Instancias Spot', 'Hosts dedicados'], answer: 1, explain: 'Para cargas continuas y predecibles, el compromiso de 1 o 3 años (Savings Plans / Reservadas) ahorra hasta ~70 %.' },
    { domain: 4, q: 'Tienes un trabajo por lotes que puede reiniciarse si se interrumpe. ¿Qué modelo de compra minimiza el coste?', options: ['Bajo demanda', 'Instancias reservadas estándar', 'Instancias Spot', 'Host dedicado'], answer: 2, explain: 'Spot ofrece descuentos de hasta ~90 % a cambio de posibles interrupciones; ideal para cargas tolerantes a fallos.' },
    { domain: 4, q: 'Una instancia EC2 está en estado «stopped». ¿Qué sigues pagando?', options: ['Nada', 'El cómputo y el almacenamiento', 'El almacenamiento EBS (y las IP elásticas asociadas)', 'Solo la IP pública automática'], answer: 2, explain: 'Parada no factura cómputo, pero sí los volúmenes EBS y las Elastic IP asociadas.' },
    { domain: 1, q: 'La base de datos solo debe aceptar conexiones de los servidores de aplicación, que cambian de IP con el escalado. ¿Cómo lo configuras?', options: ['Regla de entrada con el CIDR de la subred de aplicación', 'Regla de entrada que referencia el security group de la aplicación', 'Regla de entrada desde 0.0.0.0/0', 'Una NACL con deny'], answer: 1, explain: 'Un SG puede ser origen de otro SG: las instancias que lo tengan asociado pasan, sin importar su IP.' },
    { domain: 1, q: '¿Qué protege IMDSv2 frente a IMDSv1?', options: ['Cifra los datos del disco', 'Exige un token de sesión, dificultando el robo de credenciales por SSRF', 'Evita el acceso por SSH', 'Aísla la instancia en otra AZ'], answer: 1, explain: 'IMDSv2 requiere un token obtenido con una petición PUT, lo que frustra la mayoría de ataques SSRF.' },
    { domain: 2, q: 'Quieres que una aplicación web sobreviva a la caída de una AZ y escale con la demanda. ¿Qué combinación eliges?', options: ['Una instancia grande con Elastic IP', 'Auto Scaling Group en varias AZ detrás de un Application Load Balancer', 'Dos instancias en la misma AZ', 'Una instancia con snapshots diarios'], answer: 1, explain: 'El ASG reparte instancias en varias subredes/AZ y el ALB distribuye el tráfico solo hacia las que están sanas.' },
    { domain: 3, q: 'Una base de datos transaccional necesita decenas de miles de IOPS con latencia baja y constante. ¿Qué volumen EBS eliges?', options: ['st1', 'sc1', 'io2 (SSD de IOPS aprovisionados)', 'Un bucket de S3'], answer: 2, explain: 'io2 está diseñado para cargas críticas con IOPS altos y sostenidos. st1/sc1 son HDD para flujos secuenciales.' },
    { domain: 1, q: 'Una aplicación en EC2 necesita llamar a S3. ¿Cuál es la forma más segura de darle credenciales?', options: ['Variables de entorno con una clave de acceso de un usuario IAM', 'Un perfil de instancia con un rol de IAM', 'Guardar la clave en el AMI', 'Hacer público el bucket'], answer: 1, explain: 'El rol de instancia entrega credenciales temporales rotadas automáticamente; no hay secretos que gestionar ni filtrar.' },
  ],
};

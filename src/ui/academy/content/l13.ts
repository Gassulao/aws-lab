import { SAA_DOMAINS, type Level } from '../types';
import { prep } from '../setup';
import type { Shell } from '../../../shell';
import type { CheckCtx } from '../checks';
import { gov } from '../../../engine/services/govTypes';
import { settleOrg } from '../../../engine/services/organizations';
import { ruleCompliance } from '../../../engine/services/config';
import { settleBudgets } from '../../../engine/services/budgets';
import { checkResult, healthEvents } from '../../../engine/services/trustedadvisor';
import { settle } from '../../../engine/services/ec2';
import organizations from './l13/1-organizations-scp.md?raw';
import config from './l13/2-config-conformidad.md?raw';
import costes from './l13/3-costes-budgets.md?raw';
import advisor from './l13/4-trustedadvisor-health.md?raw';

const AMI = 'ami-0a1b2c3d4e5f60001';
const DAY = 86_400_000;
const ACC = 'ACC=$(aws sts get-caller-identity --query Account --output text)';

// ---------------------------------------------------------------- ayudas de comprobación
const org = (c: CheckCtx) => (settleOrg(c.s), gov(c.s).org);
const ouNamed = (c: CheckCtx, name: string) => org(c)?.ous.find((u) => u.name === name);
const acctNamed = (c: CheckCtx, name: string) => org(c)?.accounts.find((a) => a.name === name);
const policyNamed = (c: CheckCtx, name: string) => org(c)?.policies.find((p) => p.name === name);
const MEMBER = 'OrganizationAccountAccessRole';
const memberCalls = (c: CheckCtx, event: string, error: boolean) => c.trailBy(MEMBER, event, { error });

/** Organización con SCP activadas, una OU `Produccion` y una cuenta miembro `prod` dentro de ella. */
const ORG_SETUP = [
  'aws organizations create-organization --feature-set ALL',
  "ROOT=$(aws organizations list-roots --query 'Roots[0].Id' --output text)",
  'aws organizations enable-policy-type --root-id $ROOT --policy-type SERVICE_CONTROL_POLICY',
  'OU=$(aws organizations create-organizational-unit --parent-id $ROOT --name Produccion --query OrganizationalUnit.Id --output text)',
  'aws organizations create-account --account-name prod --email prod@example.com',
  'aws organizations list-create-account-status --states IN_PROGRESS SUCCEEDED',
  `MIEMBRO=$(aws organizations list-accounts --query "Accounts[?Name=='prod'].Id" --output text)`,
  'aws organizations move-account --account-id $MIEMBRO --source-parent-id $ROOT --destination-parent-id $OU',
];
const FIND = [
  "ROOT=$(aws organizations list-roots --query 'Roots[0].Id' --output text)",
  `OU=$(aws organizations list-organizational-units-for-parent --parent-id $ROOT --query "OrganizationalUnits[?Name=='Produccion'].Id" --output text)`,
  `MIEMBRO=$(aws organizations list-accounts --query "Accounts[?Name=='prod'].Id" --output text)`,
];
/** Asume el rol de acceso de la cuenta miembro y deja las credenciales en el entorno. */
const ENTER = [
  'CREDS=$(aws sts assume-role --role-arn arn:aws:iam::$MIEMBRO:role/OrganizationAccountAccessRole --role-session-name prueba)',
  'export AWS_ACCESS_KEY_ID=$(echo $CREDS | jq -r .Credentials.AccessKeyId)',
  'export AWS_SECRET_ACCESS_KEY=$(echo $CREDS | jq -r .Credentials.SecretAccessKey)',
  'export AWS_SESSION_TOKEN=$(echo $CREDS | jq -r .Credentials.SessionToken)',
];
const LEAVE = 'unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN';

const SCP_NO_RB = '{"Version":"2012-10-17","Statement":[{"Sid":"NoBorrarBuckets","Effect":"Deny","Action":["s3:DeleteBucket"],"Resource":"*"}]}';
const SCP_REGION = '{"Version":"2012-10-17","Statement":[{"Sid":"SoloIrlanda","Effect":"Deny","Action":["ec2:*"],"Resource":"*","Condition":{"StringNotEquals":{"aws:RequestedRegion":["eu-west-1"]}}}]}';

const POL_PUBLIC = (b: string) => `{"Version":"2012-10-17","Statement":[{"Sid":"Publico","Effect":"Allow","Principal":"*","Action":"s3:GetObject","Resource":"arn:aws:s3:::${b}/*"}]}`;
const PAB_OFF = 'BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false';
const PAB_ON = PAB_OFF.replace(/false/g, 'true');
const publicBucket = (b: string) => [`aws s3 mb s3://${b}`, `aws s3api put-public-access-block --bucket ${b} --public-access-block-configuration ${PAB_OFF}`, `aws s3api put-bucket-policy --bucket ${b} --policy '${POL_PUBLIC(b)}'`];
const openSg = (name: string, port: number) => [`SGX=$(aws ec2 create-security-group --group-name ${name} --description "Abierto al mundo" --query GroupId --output text)`, `aws ec2 authorize-security-group-ingress --group-id $SGX --protocol tcp --port ${port} --cidr 0.0.0.0/0`];
const sgId = (name: string) => `SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=${name} --query 'SecurityGroups[0].GroupId' --output text)`;

const RULE = (name: string, id: string) => `{"ConfigRuleName":"${name}","Source":{"Owner":"AWS","SourceIdentifier":"${id}"}}`;

const BUDGET = '{"BudgetName":"aprendizaje","BudgetLimit":{"Amount":"5","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}';
const NOTIFS = '[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80,"ThresholdType":"PERCENTAGE"},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"ana@example.com"}]},{"Notification":{"NotificationType":"FORECASTED","ComparisonOperator":"GREATER_THAN","Threshold":100,"ThresholdType":"PERCENTAGE"},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"ana@example.com"}]}]';

/** Retrasa el inicio de las instancias en marcha para que ya hayan generado coste este mes. */
function age(sh: Shell, days: number) {
  settle(sh.s);
  for (const i of sh.s.instances) if (i.state === 'running') i.runningSince = Date.now() - days * DAY;
}

export const l13: Level = {
  id: 13,
  slug: 'gobernanza-costes',
  title: 'Gobernanza y costes',
  subtitle: 'Organizations y SCP, AWS Config, Budgets, Cost Explorer y Trusted Advisor: controlar, auditar y abaratar una cuenta.',
  skills: ['Organizations, OU y cuentas miembro', 'SCP: denegación, lista de permitidos y región', 'AWS Config: grabador, reglas y conformidad', 'Cost Explorer y previsión', 'Presupuestos con avisos', 'Trusted Advisor y AWS Health'],
  lessons: [
    { id: 'l13-organizations', title: 'Organizations y las SCP', minutes: 10, body: organizations },
    { id: 'l13-config', title: 'AWS Config: configuración y conformidad', minutes: 9, body: config },
    { id: 'l13-costes', title: 'Cost Explorer y Budgets', minutes: 9, body: costes },
    { id: 'l13-advisor', title: 'Trusted Advisor y AWS Health', minutes: 8, body: advisor },
  ],
  exercises: [
    {
      id: 'l13-e1',
      title: 'Tu organización y la OU de producción',
      summary: 'Crea una organización, habilita las SCP, añade una OU y una cuenta miembro.',
      difficulty: 'Fácil',
      minutes: 12,
      saa: [SAA_DOMAINS[1]],
      tags: ['Organizations', 'OU', 'SCP'],
      scenario: 'La empresa crece y todo vive en una sola cuenta. Crea una **organización** con todas las características, habilita las **políticas de control de servicios**, crea la unidad organizativa `Produccion` y una cuenta miembro llamada `prod` (correo `prod@example.com`). Las cuentas se crean en la raíz: muévela a la OU.',
      steps: [
        { id: 'org', title: 'Crea la organización con `--feature-set ALL`', hint: ['aws organizations create-organization --feature-set ALL'], check: (c) => !!org(c) || 'Todavía no existe la organización.' },
        { id: 'scp', title: 'Habilita el tipo de política `SERVICE_CONTROL_POLICY` en la raíz', hint: ['Necesitas el id de la raíz: aws organizations list-roots', 'aws organizations enable-policy-type --root-id <r-xxxx> --policy-type SERVICE_CONTROL_POLICY'], check: (c) => org(c)?.scpEnabled || 'Las SCP todavía no están habilitadas en la raíz.' },
        { id: 'ou', title: 'Crea la OU `Produccion` bajo la raíz', hint: ['aws organizations create-organizational-unit --parent-id <raíz> --name Produccion'], check: (c) => !!ouNamed(c, 'Produccion') || 'No existe la OU Produccion.' },
        { id: 'acct', title: 'Crea la cuenta `prod` y espera a que termine (`SUCCEEDED`)', hint: ['aws organizations create-account --account-name prod --email prod@example.com', 'La creación es asíncrona: repite aws organizations describe-create-account-status o list-accounts.'], check: (c) => acctNamed(c, 'prod')?.status === 'ACTIVE' || 'La cuenta prod todavía no existe o no ha terminado de crearse.' },
        { id: 'move', title: 'Mueve `prod` a la OU `Produccion`', hint: ['aws organizations move-account --account-id <id> --source-parent-id <raíz> --destination-parent-id <ou>'], check: (c) => { const a = acctNamed(c, 'prod'); const u = ouNamed(c, 'Produccion'); return (!!a && !!u && a.parentId === u.id) || 'La cuenta prod aún no está dentro de la OU Produccion.'; } },
      ],
      script: [
        'aws organizations create-organization --feature-set ALL',
        "ROOT=$(aws organizations list-roots --query 'Roots[0].Id' --output text)",
        'aws organizations enable-policy-type --root-id $ROOT --policy-type SERVICE_CONTROL_POLICY',
        'OU=$(aws organizations create-organizational-unit --parent-id $ROOT --name Produccion --query OrganizationalUnit.Id --output text)',
        'aws organizations create-account --account-name prod --email prod@example.com',
        'aws organizations list-create-account-status --states IN_PROGRESS SUCCEEDED',
        `MIEMBRO=$(aws organizations list-accounts --query "Accounts[?Name=='prod'].Id" --output text)`,
        'aws organizations move-account --account-id $MIEMBRO --source-parent-id $ROOT --destination-parent-id $OU',
        'aws organizations list-accounts-for-parent --parent-id $OU',
      ],
      realWorld: 'Crear una organización es gratis. En una cuenta real, `create-account` exige un correo que no esté ya asociado a otra cuenta de AWS y puede tardar minutos; la cuenta creada **no se puede borrar al instante** (el cierre tiene un periodo de 90 días y hay un límite de cierres). Antes de crear cuentas, decide la estructura de OU (por entorno o por carga de trabajo) y habilita CloudTrail de organización. **Limpieza:** cierra las cuentas de prueba con `aws organizations close-account --account-id <id>`; no necesitas borrar la organización, pero sí quitar las cuentas antes de `delete-organization`.',
    },
    {
      id: 'l13-e2',
      title: 'Una SCP que impide borrar buckets',
      summary: 'Escribe una SCP de denegación, adjúntala a una OU y compruébala desde la cuenta miembro.',
      difficulty: 'Media',
      minutes: 15,
      saa: [SAA_DOMAINS[1]],
      tags: ['Organizations', 'SCP', 'S3', 'STS'],
      scenario: 'La organización ya tiene la OU `Produccion` con la cuenta `prod`. El equipo de datos no debe poder borrar buckets de S3 en producción, ni siquiera siendo administradores. Crea la SCP `NoBorrarBuckets` que deniegue `s3:DeleteBucket`, adjúntala a la OU y compruébalo: asume `OrganizationAccountAccessRole` en `prod`, crea un bucket (funciona) e intenta borrarlo (debe fallar por la SCP).',
      setup: (sh) => prep(sh, ORG_SETUP),
      steps: [
        { id: 'policy', title: 'Crea la SCP `NoBorrarBuckets` con un `Deny` sobre `s3:DeleteBucket`', hint: ['El tipo es SERVICE_CONTROL_POLICY y el contenido va en --content file://scp.json', 'aws organizations create-policy --name NoBorrarBuckets --description "..." --type SERVICE_CONTROL_POLICY --content file://scp.json'], check: (c) => { const p = policyNamed(c, 'NoBorrarBuckets'); return (!!p && /"Deny"/.test(p.content) && /s3:DeleteBucket/i.test(p.content)) || 'Falta la SCP NoBorrarBuckets con un Deny sobre s3:DeleteBucket.'; } },
        { id: 'attach', title: 'Adjúntala a la OU `Produccion`', hint: ['aws organizations attach-policy --policy-id <p-xxxx> --target-id <ou-xxxx>'], check: (c) => { const p = policyNamed(c, 'NoBorrarBuckets'); const u = ouNamed(c, 'Produccion'); return (!!p && !!u && p.targets.includes(u.id)) || 'La SCP todavía no está adjunta a la OU Produccion.'; } },
        { id: 'enter', title: 'Asume `OrganizationAccountAccessRole` en la cuenta `prod`', hint: ['El ARN es arn:aws:iam::<cuenta prod>:role/OrganizationAccountAccessRole', 'Exporta AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY y AWS_SESSION_TOKEN con jq a partir de la respuesta.'], check: (c) => { const a = acctNamed(c, 'prod'); return (!!a && c.trail('AssumeRole', { error: false }).some((e) => String(e.requestParameters?.roleArn ?? e.requestParameters?.RoleArn).includes(`${a.id}:role/${MEMBER}`))) || 'Aún no has asumido el rol de acceso de la cuenta prod.'; } },
        { id: 'mb', title: 'Crea un bucket desde `prod`: la SCP no lo impide', hint: ['aws s3 mb s3://datos-prod-ana-001'], check: (c) => memberCalls(c, 'CreateBucket', false).length > 0 || 'Todavía no has creado un bucket desde la sesión de prod.' },
        { id: 'deny', title: 'Intenta borrarlo: debe fallar por la SCP', hint: ['aws s3 rb s3://datos-prod-ana-001', 'El error menciona «explicit deny in a service control policy».'], check: (c) => memberCalls(c, 'DeleteBucket', true).length > 0 || 'No consta un intento fallido de borrar el bucket desde prod.' },
      ],
      script: [
        ...FIND,
        `printf '${SCP_NO_RB}' > scp.json`,
        'P=$(aws organizations create-policy --name NoBorrarBuckets --description "No borrar buckets" --type SERVICE_CONTROL_POLICY --content file://scp.json --query Policy.PolicySummary.Id --output text)',
        'aws organizations attach-policy --policy-id $P --target-id $OU',
        ...ENTER,
        'aws sts get-caller-identity',
        'aws s3 mb s3://datos-prod-ana-001',
        'aws s3 rb s3://datos-prod-ana-001 || echo "Denegado por la SCP"',
        LEAVE,
      ],
      realWorld: 'Las SCP no cuestan nada. En una organización real, prueba cada SCP primero en una OU de pruebas: una SCP errónea en la raíz puede dejar sin acceso a todas las cuentas miembro (la cuenta de administración nunca se ve afectada, por eso es tu salvavidas). Combina SCP con **condiciones** (por ejemplo, `aws:PrincipalArn`) para exceptuar a un rol de emergencia. **Limpieza:** desasocia y borra la SCP (`detach-policy` y `delete-policy`) y vacía y borra el bucket de prueba desde la cuenta miembro.',
    },
    {
      id: 'l13-e3',
      title: 'Solo Irlanda: restringe las regiones de una cuenta',
      summary: 'Una SCP con `aws:RequestedRegion` adjunta a una cuenta concreta.',
      difficulty: 'Difícil',
      minutes: 18,
      saa: [SAA_DOMAINS[1], SAA_DOMAINS[4]],
      tags: ['Organizations', 'SCP', 'EC2', 'Regiones'],
      scenario: 'Cumplimiento exige que `prod` trabaje solo en **eu-west-1** (Irlanda): ni un recurso de EC2 en otra región. Crea la SCP `SoloIrlanda` con un `Deny` sobre `ec2:*` cuando `aws:RequestedRegion` **no sea** `eu-west-1`. Esta vez adjúntala **directamente a la cuenta** `prod` (no a la OU). Verifica desde una sesión en `prod`: `describe-vpcs` en `us-east-1` falla y en `eu-west-1` funciona.',
      setup: (sh) => prep(sh, ORG_SETUP),
      steps: [
        { id: 'policy', title: 'Crea la SCP `SoloIrlanda` con la condición `StringNotEquals` sobre `aws:RequestedRegion`', hint: ['"Condition":{"StringNotEquals":{"aws:RequestedRegion":["eu-west-1"]}}', 'Efecto Deny y acción ec2:*.'], check: (c) => { const p = policyNamed(c, 'SoloIrlanda'); return (!!p && /"Deny"/.test(p.content) && /aws:RequestedRegion/i.test(p.content) && /eu-west-1/.test(p.content)) || 'Falta la SCP SoloIrlanda con la condición de región.'; } },
        { id: 'attach', title: 'Adjúntala a la cuenta `prod` (el destino es el id de la cuenta)', hint: ['aws organizations attach-policy --policy-id <p-xxxx> --target-id <id de prod>'], check: (c) => { const p = policyNamed(c, 'SoloIrlanda'); const a = acctNamed(c, 'prod'); return (!!p && !!a && p.targets.includes(a.id)) || 'La SCP no está adjunta a la cuenta prod.'; } },
        { id: 'deny', title: 'Desde `prod`, `describe-vpcs --region us-east-1` debe fallar', hint: ['Asume OrganizationAccountAccessRole y exporta las credenciales.', 'aws ec2 describe-vpcs --region us-east-1'], check: (c) => memberCalls(c, 'DescribeVpcs', true).length > 0 || 'No consta un intento denegado en us-east-1 desde prod.' },
        { id: 'allow', title: 'Desde `prod`, `describe-vpcs --region eu-west-1` debe funcionar', hint: ['aws ec2 describe-vpcs --region eu-west-1'], check: (c) => memberCalls(c, 'DescribeVpcs', false).length > 0 || 'No consta una consulta correcta en eu-west-1 desde prod.' },
      ],
      script: [
        ...FIND,
        `printf '${SCP_REGION}' > region.json`,
        'P=$(aws organizations create-policy --name SoloIrlanda --description "Solo eu-west-1" --type SERVICE_CONTROL_POLICY --content file://region.json --query Policy.PolicySummary.Id --output text)',
        'aws organizations attach-policy --policy-id $P --target-id $MIEMBRO',
        ...ENTER,
        'aws ec2 describe-vpcs --region us-east-1 || echo "Denegado: región no permitida"',
        'aws ec2 describe-vpcs --region eu-west-1 --query "Vpcs[].VpcId"',
        LEAVE,
      ],
      realWorld: 'En producción, la lista de servicios globales (IAM, Organizations, Route 53, CloudFront, Support…) debe excluirse de una SCP de región porque sus llamadas se hacen a `us-east-1` y quedarían bloqueadas: usa `NotAction` con esos servicios. Control Tower ofrece esta barandilla ya hecha. **Limpieza:** `aws organizations detach-policy --policy-id <id> --target-id <cuenta>` y `delete-policy`; sin recursos creados no hay coste.',
    },
    {
      id: 'l13-e4',
      title: 'AWS Config detecta lo que está mal configurado',
      summary: 'Activa el grabador, crea dos reglas gestionadas, lee los incumplimientos y corrígelos.',
      difficulty: 'Media',
      minutes: 20,
      saa: [SAA_DOMAINS[1]],
      tags: ['Config', 'S3', 'EC2', 'Seguridad'],
      scenario: 'Auditoría sospecha de dos recursos: el bucket `web-publica-ana-001` (alguien abrió una política pública) y el grupo de seguridad `ssh-abierto` (SSH abierto a internet). Activa **AWS Config** con el bucket de entrega `config-entrega-ana`, crea las reglas `s3-bucket-public-read-prohibited` y `restricted-ssh` (`INCOMING_SSH_DISABLED`), consulta qué recursos incumplen, **corrígelos** y comprueba que ambas reglas pasan a `COMPLIANT`.',
      setup: (sh) => prep(sh, ['aws s3 mb s3://config-entrega-ana', ...publicBucket('web-publica-ana-001'), ...openSg('ssh-abierto', 22)]),
      steps: [
        { id: 'rec', title: 'Crea el grabador y el canal de entrega, e inicia la grabación', hint: ['El rol es el vinculado al servicio: arn:aws:iam::<cuenta>:role/aws-service-role/config.amazonaws.com/AWSServiceRoleForConfig', 'put-configuration-recorder, put-delivery-channel y start-configuration-recorder'], check: (c) => { const g = gov(c.s).config; return (!!g.recorder?.recording && g.channel?.s3Bucket === 'config-entrega-ana') || 'El grabador no está grabando o el canal no apunta a config-entrega-ana.'; } },
        { id: 'rules', title: 'Crea las reglas `s3-bucket-public-read-prohibited` y `restricted-ssh`', hint: ['aws configservice put-config-rule --config-rule file://regla.json', 'Owner=AWS; identificadores S3_BUCKET_PUBLIC_READ_PROHIBITED e INCOMING_SSH_DISABLED'], check: (c) => { const r = gov(c.s).config.rules; return (r.some((x) => x.identifier === 'S3_BUCKET_PUBLIC_READ_PROHIBITED') && r.some((x) => x.identifier === 'INCOMING_SSH_DISABLED')) || 'Faltan una o las dos reglas gestionadas.'; } },
        { id: 'see', title: 'Consulta los incumplimientos con `describe-compliance-by-config-rule`', hint: ['aws configservice describe-compliance-by-config-rule --compliance-types NON_COMPLIANT', 'Para ver los recursos: get-compliance-details-by-config-rule --config-rule-name <regla>'], check: (c) => c.trail('DescribeComplianceByConfigRule', { error: false }).length + c.trail('GetComplianceDetailsByConfigRule', { error: false }).length > 0 || 'Aún no has consultado la conformidad.' },
        { id: 'fix', title: 'Corrige el bucket (bloqueo de acceso público) y el grupo de seguridad (quita 22 desde 0.0.0.0/0)', hint: ['aws s3api put-public-access-block --bucket web-publica-ana-001 --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true', "El id del grupo: aws ec2 describe-security-groups --filters Name=group-name,Values=ssh-abierto --query 'SecurityGroups[0].GroupId' --output text", 'aws ec2 revoke-security-group-ingress --group-id <id> --protocol tcp --port 22 --cidr 0.0.0.0/0'], check: (c) => { const rs = gov(c.s).config.rules.filter((x) => ['S3_BUCKET_PUBLIC_READ_PROHIBITED', 'INCOMING_SSH_DISABLED'].includes(x.identifier)); return (rs.length === 2 && rs.every((x) => ruleCompliance(c.s, x) === 'COMPLIANT')) || 'Alguna de las dos reglas sigue sin estar en COMPLIANT.'; } },
      ],
      script: [
        ACC,
        'aws configservice put-configuration-recorder --configuration-recorder name=default,roleARN=arn:aws:iam::$ACC:role/aws-service-role/config.amazonaws.com/AWSServiceRoleForConfig --recording-group allSupported=true,includeGlobalResourceTypes=true',
        'aws configservice put-delivery-channel --delivery-channel name=default,s3BucketName=config-entrega-ana',
        'aws configservice start-configuration-recorder --configuration-recorder-name default',
        `printf '${RULE('s3-bucket-public-read-prohibited', 'S3_BUCKET_PUBLIC_READ_PROHIBITED')}' > r1.json`,
        `printf '${RULE('restricted-ssh', 'INCOMING_SSH_DISABLED')}' > r2.json`,
        'aws configservice put-config-rule --config-rule file://r1.json',
        'aws configservice put-config-rule --config-rule file://r2.json',
        'aws configservice describe-compliance-by-config-rule --compliance-types NON_COMPLIANT',
        'aws configservice get-compliance-details-by-config-rule --config-rule-name restricted-ssh --compliance-types NON_COMPLIANT',
        `aws s3api put-public-access-block --bucket web-publica-ana-001 --public-access-block-configuration ${PAB_ON}`,
        sgId('ssh-abierto'),
        'aws ec2 revoke-security-group-ingress --group-id $SG --protocol tcp --port 22 --cidr 0.0.0.0/0',
        'aws configservice describe-compliance-by-config-rule',
      ],
      realWorld: 'AWS Config cobra por elemento de configuración registrado (unos 0,003 USD cada uno) y por evaluación de regla (0,001 USD): en una cuenta de pruebas son céntimos, pero en una organización grande conviene limitar los tipos de recurso grabados. Necesitas un bucket de S3 con la política que permite a `config.amazonaws.com` escribir (la consola la crea por ti). Para corregir sin intervención humana, asocia una **acción de remediación** automática. **Limpieza:** `stop-configuration-recorder`, `delete-config-rule` para cada regla, `delete-delivery-channel`, `delete-configuration-recorder` y vacía y borra el bucket de entrega.',
    },
    {
      id: 'l13-e5',
      title: 'Un presupuesto de 5 dólares con aviso',
      summary: 'Crea un presupuesto mensual con avisos real y previsto, y reacciona cuando salta.',
      difficulty: 'Media',
      minutes: 15,
      saa: [SAA_DOMAINS[4]],
      tags: ['Budgets', 'Cost Explorer', 'EC2'],
      scenario: 'Es una cuenta de aprendizaje y nadie quiere sorpresas en la factura. Alguien dejó **dos instancias `m5.xlarge`** encendidas desde hace 10 días. Crea el presupuesto mensual `aprendizaje` de **5 USD** con dos avisos por correo (`ana@example.com`): al **80 % del gasto real** y al **100 % del gasto previsto**. Comprueba que el aviso ya ha saltado, consulta el gasto con Cost Explorer y **para las instancias**.',
      setup: async (sh) => {
        await prep(sh, [1, 2].map((n) => `aws ec2 run-instances --image-id ${AMI} --instance-type m5.xlarge --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=olvidada-${n}}]'`));
        age(sh, 10);
      },
      steps: [
        { id: 'budget', title: 'Crea el presupuesto `aprendizaje`: mensual, 5 USD, tipo `COST`', hint: ['aws budgets create-budget --account-id $ACC --budget file://presupuesto.json --notifications-with-subscribers file://avisos.json', 'BudgetLimit: {"Amount":"5","Unit":"USD"}, TimeUnit MONTHLY, BudgetType COST'], check: (c) => { const b = gov(c.s).budgets.find((x) => x.name === 'aprendizaje'); return (!!b && b.timeUnit === 'MONTHLY' && b.limit === 5) || 'No existe el presupuesto mensual aprendizaje de 5 USD.'; } },
        { id: 'notifs', title: 'Añade los avisos: ACTUAL > 80 % y FORECASTED > 100 %, ambos al correo `ana@example.com`', hint: ['Van en --notifications-with-subscribers, o con create-notification y create-subscriber.', 'ThresholdType PERCENTAGE; SubscriptionType EMAIL'], check: (c) => { const n = gov(c.s).budgets.find((x) => x.name === 'aprendizaje')?.notifications ?? []; const mail = (x: (typeof n)[number]) => x.subscribers.some((s) => s.type === 'EMAIL' && s.address === 'ana@example.com'); return (n.some((x) => x.type === 'ACTUAL' && x.threshold === 80 && mail(x)) && n.some((x) => x.type === 'FORECASTED' && x.threshold === 100 && mail(x))) || 'Faltan los avisos ACTUAL 80 % y FORECASTED 100 % con el correo indicado.'; } },
        { id: 'alarm', title: 'Comprueba con `describe-notifications-for-budget` que el aviso real está en `ALARM`', hint: ['aws budgets describe-notifications-for-budget --account-id $ACC --budget-name aprendizaje'], check: (c) => { settleBudgets(c.s); const n = gov(c.s).budgets.find((x) => x.name === 'aprendizaje')?.notifications ?? []; return (c.trail('DescribeNotificationsForBudget', { error: false }).length > 0 && n.some((x) => x.type === 'ACTUAL' && x.state === 'ALARM')) || 'Consulta los avisos del presupuesto y comprueba que el real está en ALARM.'; } },
        { id: 'ce', title: 'Consulta el gasto del mes con `ce get-cost-and-usage` agrupado por servicio', hint: ['aws ce get-cost-and-usage --time-period Start=<inicio del mes>,End=<mañana> --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE', 'date +%Y-%m-01 da el primer día del mes'], check: (c) => c.trail('GetCostAndUsage', { error: false }).length > 0 || 'Aún no has consultado Cost Explorer.' },
        { id: 'stop', title: 'Para las dos instancias olvidadas', hint: ['aws ec2 stop-instances --instance-ids <ids>', "aws ec2 describe-instances --filters Name=tag:Name,Values=olvidada-* --query 'Reservations[].Instances[].InstanceId' --output text"], check: (c) => c.instances((i) => i.tags.Name?.startsWith('olvidada-') && (i.state === 'running' || i.state === 'pending')).length === 0 || 'Todavía hay instancias olvidadas en marcha.' },
      ],
      script: [
        ACC,
        `printf '${BUDGET}' > presupuesto.json`,
        `printf '${NOTIFS}' > avisos.json`,
        'aws budgets create-budget --account-id $ACC --budget file://presupuesto.json --notifications-with-subscribers file://avisos.json',
        'aws budgets describe-notifications-for-budget --account-id $ACC --budget-name aprendizaje',
        'aws ce get-cost-and-usage --time-period Start=$(date +%Y-%m-01),End=$(date -d tomorrow +%F) --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE',
        "IDS=$(aws ec2 describe-instances --filters Name=tag:Name,Values=olvidada-* --query 'Reservations[].Instances[].InstanceId' --output text)",
        'aws ec2 stop-instances --instance-ids $IDS',
      ],
      realWorld: 'Los primeros 2 presupuestos de cada cuenta son gratuitos; después, unos 0,02 USD al día por presupuesto. Los avisos por correo requieren confirmar la suscripción. Un presupuesto **no detiene** nada: para actuar de forma automática usa *budget actions* o un tema de SNS con una función Lambda que pare instancias. Los datos de Cost Explorer tardan hasta 24 horas en reflejar el uso real. **Limpieza:** `aws budgets delete-budget --account-id <cuenta> --budget-name aprendizaje` y termina (no solo pares) las instancias olvidadas si ya no hacen falta.',
    },
    {
      id: 'l13-e6',
      title: '¿Quién se lleva el dinero? Caza un volumen olvidado',
      summary: 'Usa Cost Explorer para encontrar el servicio más caro y elimina la causa.',
      difficulty: 'Media',
      minutes: 15,
      saa: [SAA_DOMAINS[4]],
      tags: ['Cost Explorer', 'EBS', 'EC2', 'FinOps'],
      scenario: 'La factura se ha disparado y todos miran las instancias. Antes de apagar nada, **mide**: usa Cost Explorer agrupando por **servicio** los últimos 7 días, anota en `mayor-gasto.txt` el nombre exacto del servicio más caro y encuentra el recurso que lo causa. Pista: no siempre lo caro es la computación. Elimina la causa y consulta la **previsión** del resto del mes.',
      setup: async (sh) => {
        await prep(sh, [
          ...[1, 2].map((n) => `aws ec2 run-instances --image-id ${AMI} --instance-type t3.small --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=web-${n}}]'`),
          'aws ec2 create-volume --availability-zone eu-west-1a --size 2000 --volume-type gp3 --tag-specifications \'ResourceType=volume,Tags=[{Key=Name,Value=datos-olvidados}]\'',
        ]);
        age(sh, 10);
        for (const v of sh.s.volumes) if (v.sizeGiB === 2000) v.createdAt = new Date(Date.now() - 10 * DAY).toISOString();
      },
      steps: [
        { id: 'ce', title: 'Consulta `ce get-cost-and-usage` de los últimos 7 días agrupado por `SERVICE`', hint: ["aws ce get-cost-and-usage --time-period Start=$(date -d '7 days ago' +%F),End=$(date -d tomorrow +%F) --granularity DAILY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE", 'Fíjate en qué servicio acumula más importe en total.'], check: (c) => c.ran(/ce get-cost-and-usage/) && c.ran(/SERVICE/) || 'Aún no has agrupado el coste por servicio.' },
        { id: 'note', title: 'Guarda en `mayor-gasto.txt` el nombre exacto del servicio más caro', hint: ['El servicio que domina no es la computación: mira también «EC2 - Other» (EBS, NAT).', 'echo "<servicio>" > mayor-gasto.txt'], check: (c) => (c.file('mayor-gasto.txt') ?? '').trim() === 'EC2 - Other' || 'El fichero mayor-gasto.txt no contiene el servicio que más gasta (revisa el desglose).' },
        { id: 'find', title: 'Localiza el volumen sin adjuntar de 2000 GiB y elimínalo', hint: ["aws ec2 describe-volumes --filters Name=status,Values=available --query 'Volumes[].[VolumeId,Size]' --output text", 'aws ec2 delete-volume --volume-id <id>'], check: (c) => !c.s.volumes.some((v) => v.sizeGiB === 2000) || 'El volumen de 2000 GiB sigue existiendo.' },
        { id: 'forecast', title: 'Consulta la previsión con `ce get-cost-forecast`', hint: ['aws ce get-cost-forecast --time-period Start=<hoy>,End=<primer día del mes siguiente> --metric UNBLENDED_COST --granularity MONTHLY'], check: (c) => c.trail('GetCostForecast', { error: false }).length > 0 || 'Aún no has consultado la previsión.' },
      ],
      script: [
        'aws ce get-cost-and-usage --time-period Start=$(date -d "7 days ago" +%F),End=$(date -d tomorrow +%F) --granularity DAILY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE',
        'echo "EC2 - Other" > mayor-gasto.txt',
        "VOL=$(aws ec2 describe-volumes --filters Name=status,Values=available --query 'Volumes[0].VolumeId' --output text)",
        'aws ec2 delete-volume --volume-id $VOL',
        'aws ce get-cost-forecast --time-period Start=$(date -d tomorrow +%F),End=$(date -d "+20 days" +%F) --metric UNBLENDED_COST --granularity MONTHLY',
      ],
      realWorld: 'En una cuenta real, activa las **etiquetas de asignación de costes** (`Proyecto`, `Equipo`) para poder agrupar por etiqueta en Cost Explorer; solo se aplican desde el día en que se activan. «EC2 - Other» agrupa EBS, NAT Gateway, transferencia de datos e IP públicas: es la categoría que más sorprende. Un volumen gp3 de 2000 GiB cuesta unos 160 USD al mes aunque no esté conectado. Haz siempre una instantánea antes de borrar un volumen del que no estés seguro. **Limpieza:** elimina volúmenes `available`, instantáneas antiguas, IP elásticas sin asociar y NAT Gateways que no uses.',
    },
    {
      id: 'l13-e7',
      title: 'Trusted Advisor: corrige los hallazgos de seguridad',
      summary: 'Lee las comprobaciones, corrige tres problemas y actualiza Trusted Advisor para verlos en verde.',
      difficulty: 'Difícil',
      minutes: 22,
      saa: [SAA_DOMAINS[1]],
      tags: ['Trusted Advisor', 'Health', 'IAM', 'S3', 'EC2'],
      scenario: 'Trusted Advisor marca en rojo tres cosas: el grupo de seguridad `rdp-abierto` (RDP, puerto 3389, abierto a todo internet), el bucket público `web-publica-ana-001` y la clave de acceso de `dev-ana`, que lleva **120 días** sin rotar. Revisa los resultados, corrige los tres problemas, **actualiza** las tres comprobaciones (los resultados no cambian solos) y confirma con AWS Health que ya no hay aviso del bucket abierto.',
      setup: async (sh) => {
        await prep(sh, [...openSg('rdp-abierto', 3389), ...publicBucket('web-publica-ana-001'), 'aws iam create-user --user-name dev-ana', 'aws iam create-access-key --user-name dev-ana']);
        const u = sh.s.users.find((x) => x.name === 'dev-ana')!;
        u.accessKeys.forEach((k) => (k.createdAt = new Date(Date.now() - 120 * DAY).toISOString()));
      },
      steps: [
        { id: 'see', title: 'Lee el resultado de «Security Groups - Unrestricted Access» (`1iG5NDGVre`)', hint: ['aws support describe-trusted-advisor-check-result --check-id 1iG5NDGVre', 'Los ids de las demás: aws support describe-trusted-advisor-checks --language en'], check: (c) => c.trail('DescribeTrustedAdvisorCheckResult', { error: false }).some((e) => e.requestParameters?.checkId === '1iG5NDGVre') || 'Aún no has leído la comprobación 1iG5NDGVre.' },
        { id: 'sg', title: 'Cierra el puerto 3389 de `rdp-abierto` al mundo', hint: ["El id: aws ec2 describe-security-groups --filters Name=group-name,Values=rdp-abierto --query 'SecurityGroups[0].GroupId' --output text", 'aws ec2 revoke-security-group-ingress --group-id <id> --protocol tcp --port 3389 --cidr 0.0.0.0/0'], check: (c) => { const g = c.sg('rdp-abierto'); return (!!g && !g.ingress.some((r) => r.cidr === '0.0.0.0/0')) || 'rdp-abierto sigue abierto a 0.0.0.0/0.'; } },
        { id: 's3', title: 'Bloquea el acceso público del bucket `web-publica-ana-001`', hint: ['aws s3api put-public-access-block --bucket web-publica-ana-001 --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'], check: (c) => { const b = c.bucket('web-publica-ana-001'); return (!!b && Object.values(b.publicAccessBlock).every(Boolean)) || 'El bucket no tiene activo el bloqueo de acceso público completo.'; } },
        { id: 'key', title: 'Rota la clave de `dev-ana`: crea una nueva y borra la antigua', hint: ['aws iam list-access-keys --user-name dev-ana', 'aws iam create-access-key --user-name dev-ana y después delete-access-key de la antigua'], check: (c) => { const ks = c.accessKeys('dev-ana'); return (ks.length === 1 && Date.now() - Date.parse(ks[0].createdAt) < DAY) || 'Debe quedar una única clave de dev-ana, la reciente.'; } },
        { id: 'refresh', title: 'Actualiza las comprobaciones `1iG5NDGVre`, `Pfx0RwqBli` y `DqdJqYeRm5` hasta que salgan en verde', hint: ['aws support refresh-trusted-advisor-check --check-id <id>', 'Pfx0RwqBli = S3 Bucket Permissions; DqdJqYeRm5 = IAM Access Key Rotation'], check: (c) => ['1iG5NDGVre', 'Pfx0RwqBli', 'DqdJqYeRm5'].every((id) => checkResult(c.s, id).status === 'ok') || 'Alguna de las tres comprobaciones sigue sin estar en verde (¿la has actualizado?).' },
        { id: 'health', title: 'Consulta AWS Health y comprueba que ya no hay aviso de bucket abierto', hint: ['aws health describe-events --region us-east-1'], check: (c) => c.trail('DescribeEvents', { error: false }).length > 0 && !healthEvents(c.s).some((e) => e.service === 'S3') || 'Consulta AWS Health: debe quedar sin eventos de S3.' },
      ],
      script: [
        'aws support describe-trusted-advisor-check-result --check-id 1iG5NDGVre',
        'aws health describe-events --region us-east-1',
        sgId('rdp-abierto'),
        'aws ec2 revoke-security-group-ingress --group-id $SG --protocol tcp --port 3389 --cidr 0.0.0.0/0',
        `aws s3api put-public-access-block --bucket web-publica-ana-001 --public-access-block-configuration ${PAB_ON}`,
        "OLD=$(aws iam list-access-keys --user-name dev-ana --query 'AccessKeyMetadata[0].AccessKeyId' --output text)",
        'aws iam create-access-key --user-name dev-ana',
        'aws iam delete-access-key --user-name dev-ana --access-key-id $OLD',
        'aws support refresh-trusted-advisor-check --check-id 1iG5NDGVre',
        'aws support refresh-trusted-advisor-check --check-id Pfx0RwqBli',
        'aws support refresh-trusted-advisor-check --check-id DqdJqYeRm5',
        'aws support describe-trusted-advisor-check-summaries --check-ids 1iG5NDGVre Pfx0RwqBli DqdJqYeRm5',
        'aws health describe-events --region us-east-1',
      ],
      realWorld: 'Las comprobaciones completas de Trusted Advisor (y la API de `support`) requieren un plan **Business, Enterprise On-Ramp o Enterprise** (desde unos 100 USD al mes); con Basic solo ves un subconjunto de seguridad y límites de servicio. En AWS real el refresco de una comprobación puede tardar unos minutos y se limita a una vez cada pocos minutos. Complementa Trusted Advisor con Security Hub y Config para una cobertura continua. **Limpieza:** borra el usuario `dev-ana` (claves incluidas), el grupo de seguridad y el bucket de prueba.',
    },
  ],
  quiz: [
    { domain: 1, q: 'Una SCP adjunta a una OU tiene un `Allow` de `s3:*`. Un administrador de IAM de la cuenta miembro intenta crear una instancia EC2 y falla. ¿Por qué?', options: ['Porque las SCP no pueden conceder permisos y esa SCP no permite `ec2:*` (con `FullAWSAccess` retirada)', 'Porque el administrador debe usar la cuenta de administración', 'Porque las SCP solo se aplican a los usuarios raíz', 'Porque falta una política de recursos en EC2'], answer: 0, explain: 'Las SCP definen el máximo de permisos: sin un Allow explícito de `ec2:*` en cada nivel (y sin FullAWSAccess), la acción queda denegada aunque IAM la permita.' },
    { domain: 1, q: 'Tienes una SCP con `Deny` de `cloudtrail:StopLogging` adjunta a la raíz de la organización. ¿A qué principales afecta?', options: ['A todos, incluida la cuenta de administración', 'A todas las cuentas miembro, pero no a la cuenta de administración', 'Solo a los usuarios IAM sin MFA', 'Solo a los roles asumidos desde otras cuentas'], answer: 1, explain: 'Las SCP no afectan a la cuenta de administración de la organización; sí a todos los usuarios y roles de las cuentas miembro, incluidos sus administradores y su usuario raíz.' },
    { domain: 1, q: '¿Qué mensaje indica que una acción fue bloqueada por una SCP y no por una política de IAM?', options: ['«is not authorized to perform … because no identity-based policy allows»', '«with an explicit deny in a service control policy»', '«The security token included in the request is expired»', '«The bucket policy does not allow this action»'], answer: 1, explain: 'AWS indica el origen del Deny: las SCP aparecen como «service control policy». Distinguirlo ahorra horas de depuración.' },
    { domain: 1, q: 'Quieres detectar cuándo un grupo de seguridad abre SSH a `0.0.0.0/0` y tener el historial de cambios del recurso. ¿Qué servicio es el adecuado?', options: ['AWS Config con la regla gestionada `restricted-ssh` o `INCOMING_SSH_DISABLED`', 'Amazon Inspector', 'AWS Budgets', 'Cost Explorer'], answer: 0, explain: 'Config registra la configuración de los recursos, su historial y evalúa reglas de conformidad. CloudTrail diría quién hizo el cambio, no si el estado cumple una regla.' },
    { domain: 2, q: 'En una organización con 40 cuentas necesitas que ninguna pueda salir de las regiones aprobadas, sin tocar cada cuenta una a una. ¿Qué haces?', options: ['Una política IAM en cada cuenta', 'Una SCP con `Deny` y la condición `aws:RequestedRegion`, adjunta a la raíz o a las OU', 'Una regla de AWS Config con remediación manual', 'Un presupuesto con una acción de Lambda'], answer: 1, explain: 'La SCP con `aws:RequestedRegion` se hereda por todas las cuentas del árbol y no depende de que cada administrador cumpla. Recuerda exceptuar los servicios globales.' },
    { domain: 2, q: 'Arreglas un grupo de seguridad que Trusted Advisor marcaba en rojo, pero minutos después la comprobación sigue en rojo. ¿Qué ocurre?', options: ['Trusted Advisor está caído', 'El resultado es el de la última ejecución: hay que actualizar la comprobación (`refresh-trusted-advisor-check`)', 'Hay que reiniciar la instancia del grupo', 'El plan de soporte Basic no permite corregir hallazgos'], answer: 1, explain: 'Trusted Advisor guarda el último resultado hasta que se actualiza, manual o automáticamente. Es un detalle clásico de examen y de la vida real.' },
    { domain: 3, q: 'Quieres saber qué servicio concreto ha disparado el gasto de la última semana, día a día. ¿Qué consulta usas?', options: ['`aws ce get-cost-and-usage` con `Granularity=DAILY` y `--group-by Type=DIMENSION,Key=SERVICE`', '`aws budgets describe-budgets`', '`aws cloudwatch get-metric-statistics` sobre `EstimatedCharges`', '`aws support describe-trusted-advisor-checks`'], answer: 0, explain: 'Cost Explorer agrupa el coste por dimensión (servicio, cuenta, región) o etiqueta. Budgets solo compara con un límite; Trusted Advisor no desglosa el gasto.' },
    { domain: 4, q: 'Quieres que alguien reciba un aviso **antes** de que el gasto mensual supere el presupuesto de 500 USD. ¿Qué configuras en AWS Budgets?', options: ['Una notificación de tipo `FORECASTED` al 100 % del presupuesto', 'Una notificación `ACTUAL` al 150 %', 'Una alarma de CloudWatch sobre las instancias', 'Una SCP que impida lanzar instancias'], answer: 0, explain: 'Los avisos de gasto previsto se disparan cuando AWS estima que se superará el límite, no cuando ya se superó. Un presupuesto avisa, no frena.' },
  ],
};

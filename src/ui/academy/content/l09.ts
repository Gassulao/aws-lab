import { SAA_DOMAINS, type Level } from '../types';
import { prep } from '../setup';
import { settleCfn, type CfnStack } from '../../../engine/services/cloudformation';
import type { CheckCtx } from '../checks';
import fundamentos from './l09/1-fundamentos.md?raw';
import intrinsecas from './l09/2-intrinsecas.md?raw';
import ciclo from './l09/3-ciclo.md?raw';
import buenas from './l09/4-buenas-practicas.md?raw';

// Las plantillas se escriben con printf (una sola línea); la solución mostrada usa here-documents.
type Item = string | { file: string; body: string; append?: boolean };
const esc = (t: string) => t.replace(/%/g, '%%').replace(/\n/g, '\\n');
const scriptOf = (items: Item[]) => items.map((i) => (typeof i === 'string' ? i : `printf '${esc(i.body)}' ${i.append ? '>>' : '>'} ${i.file}`));
const solutionOf = (items: Item[]) => '```bash\n' + items.map((i) => (typeof i === 'string' ? i : `cat ${i.append ? '>>' : '>'} ${i.file} <<'EOF'\n${i.body.replace(/\n$/, '')}\nEOF`)).join('\n') + '\n```';

/** Pilas con ese nombre (la más reciente primero), con las transiciones de tiempo ya aplicadas. */
const stacks = (c: CheckCtx, name: string): CfnStack[] => {
  settleCfn(c.s);
  return c.s.cfn.stacks.filter((x) => x.name === name).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};
const live = (c: CheckCtx, name: string) => stacks(c, name).find((x) => x.status !== 'DELETE_COMPLETE');
const ran = (verb: string) => new RegExp(`aws\\s+cloudformation\\s+${verb}\\b`);

// --- Laboratorio 1
const BUCKET = `AWSTemplateFormatVersion: "2010-09-09"
Description: Bucket de datos del laboratorio
Resources:
  Datos:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: lab-cfn-datos-2026
Outputs:
  Cubo:
    Value: !Ref Datos
`;
const E1: Item[] = [
  'mkdir -p lab-cfn',
  'cd lab-cfn',
  { file: 'bucket.yaml', body: BUCKET },
  'aws cloudformation validate-template --template-body file://bucket.yaml',
  'aws cloudformation create-stack --stack-name lab-cfn --template-body file://bucket.yaml',
  'aws cloudformation wait stack-create-complete --stack-name lab-cfn',
  'aws cloudformation describe-stacks --stack-name lab-cfn --query "Stacks[0].Outputs[0].OutputValue" --output text > ~/salida.txt',
];

// --- Laboratorio 2
const RED = `AWSTemplateFormatVersion: "2010-09-09"
Parameters:
  Entorno:
    Type: String
    Default: dev
    AllowedValues: [dev, prod]
Resources:
  Vpc:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: 10.80.0.0/16
      Tags:
        - Key: Name
          Value: !Sub "\${Entorno}-vpc"
  Subred:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.80.1.0/24
  Web:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: Trafico web
      VpcId: !Ref Vpc
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 80
          ToPort: 80
          CidrIp: 0.0.0.0/0
`;
const E2: Item[] = [
  'mkdir -p lab-red',
  'cd lab-red',
  { file: 'red.yaml', body: RED },
  'aws cloudformation create-stack --stack-name lab-red --template-body file://red.yaml --parameters ParameterKey=Entorno,ParameterValue=qa || true',
  'aws cloudformation create-stack --stack-name lab-red --template-body file://red.yaml --parameters ParameterKey=Entorno,ParameterValue=prod',
  'aws cloudformation wait stack-create-complete --stack-name lab-red',
];

// --- Laboratorio 3
const FALLO = `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  Aviso:
    Type: AWS::SNS::Topic
    Properties:
      TopicName: lab-fallo-aviso
  Cubo:
    Type: AWS::S3::Bucket
    DependsOn: Aviso
    Properties:
      BucketName: lab-cfn-ocupado-2026
`;
const E3: Item[] = [
  'cd lab-fallo',
  'aws cloudformation create-stack --stack-name lab-fallo --template-body file://plantilla.yaml',
  'sleep 15',
  `aws cloudformation describe-stack-events --stack-name lab-fallo --query "StackEvents[?ResourceStatus=='CREATE_FAILED'].ResourceStatusReason" --output text > ~/motivo.txt`,
  'sed -i s/lab-cfn-ocupado-2026/lab-cfn-libre-2026/ plantilla.yaml',
  'aws cloudformation delete-stack --stack-name lab-fallo',
  'sleep 8',
  'aws cloudformation create-stack --stack-name lab-fallo --template-body file://plantilla.yaml',
  'aws cloudformation wait stack-create-complete --stack-name lab-fallo',
];

// --- Laboratorio 4
const CS = `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  Aviso:
    Type: AWS::SNS::Topic
    Properties:
      TopicName: lab-cs-aviso
  Cubo:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: lab-cfn-cs-2026
`;
const CS_LOGS = `  Logs:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: /lab-cfn/app
`;
const E4: Item[] = [
  'cd lab-cs',
  { file: 'plantilla.yaml', body: CS_LOGS, append: true },
  'aws cloudformation create-change-set --stack-name lab-cs --change-set-name agregar-logs --template-body file://plantilla.yaml',
  'aws cloudformation wait change-set-create-complete --stack-name lab-cs --change-set-name agregar-logs',
  'aws cloudformation describe-change-set --stack-name lab-cs --change-set-name agregar-logs --query Changes > ~/cambios.txt',
  'aws cloudformation execute-change-set --stack-name lab-cs --change-set-name agregar-logs',
  'aws cloudformation wait stack-update-complete --stack-name lab-cs',
];

// --- Laboratorio 5
const ROL = `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  Rol:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal:
              Service: ec2.amazonaws.com
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess
Outputs:
  RolArn:
    Value: !GetAtt Rol.Arn
`;
const E5: Item[] = [
  'mkdir -p lab-iam',
  'cd lab-iam',
  { file: 'rol.yaml', body: ROL },
  'aws cloudformation deploy --template-file rol.yaml --stack-name lab-iam || true',
  'aws cloudformation deploy --template-file rol.yaml --stack-name lab-iam --capabilities CAPABILITY_IAM',
  'aws cloudformation delete-stack --stack-name lab-iam',
];

export const l09: Level = {
  id: 9,
  slug: 'cloudformation',
  title: 'CloudFormation',
  subtitle: 'Infraestructura como código nativa de AWS: plantillas, pilas, reversión y conjuntos de cambios.',
  skills: ['Plantillas JSON/YAML', 'Pilas y eventos', 'Parámetros y funciones intrínsecas', 'Rollback', 'Change sets y deploy', 'Capacidades de IAM'],
  lessons: [
    { id: 'l09-fundamentos', title: 'Plantillas y pilas', minutes: 8, body: fundamentos },
    { id: 'l09-intrinsecas', title: 'Parámetros, condiciones y funciones', minutes: 9, body: intrinsecas },
    { id: 'l09-ciclo', title: 'Eventos, reversión y change sets', minutes: 10, body: ciclo },
    { id: 'l09-buenas', title: 'Capacidades, borrado y buenas prácticas', minutes: 8, body: buenas },
  ],
  exercises: [
    {
      id: 'l09-e1',
      title: 'Tu primera pila',
      summary: 'Valida una plantilla, crea la pila y lee sus salidas.',
      difficulty: 'Fácil',
      minutes: 12,
      saa: [SAA_DOMAINS[2]],
      tags: ['CloudFormation', 'S3', 'Pilas'],
      scenario: 'Quieres que tu bucket de datos `lab-cfn-datos-2026` deje de crearse a mano. En `~/lab-cfn` escribe una plantilla `bucket.yaml` con ese bucket y una salida `Cubo`, valídala, crea la pila `lab-cfn`, espera a que termine y guarda en `~/salida.txt` el valor de la salida.',
      steps: [
        { id: 'tpl', title: 'Escribe `~/lab-cfn/bucket.yaml` con un `AWS::S3::Bucket` y una salida, y valídala con `validate-template`', hint: ['mkdir -p lab-cfn && cd lab-cfn', 'Necesitas la sección Resources y, dentro, Type: AWS::S3::Bucket.', 'aws cloudformation validate-template --template-body file://bucket.yaml'], check: (c) => { const f = c.file('lab-cfn/bucket.yaml'); if (!f || !f.includes('AWS::S3::Bucket') || !f.includes('Outputs')) return 'Falta ~/lab-cfn/bucket.yaml con un bucket y una sección Outputs.'; return c.ran(ran('validate-template')) || 'Valida la plantilla con aws cloudformation validate-template.'; } },
        { id: 'create', title: 'Crea la pila `lab-cfn` y espera a que llegue a `CREATE_COMPLETE`', hint: ['aws cloudformation create-stack --stack-name lab-cfn --template-body file://bucket.yaml', 'aws cloudformation wait stack-create-complete --stack-name lab-cfn'], check: (c) => { const s = live(c, 'lab-cfn'); if (!s) return 'La pila lab-cfn todavía no existe.'; if (s.status !== 'CREATE_COMPLETE') return `La pila está en ${s.status}: espera con aws cloudformation wait stack-create-complete.`; return !!c.bucket('lab-cfn-datos-2026') || 'La pila existe pero el bucket no.'; } },
        { id: 'out', title: 'Guarda en `~/salida.txt` el valor de la salida con `describe-stacks --query ... --output text`', hint: ['aws cloudformation describe-stacks --stack-name lab-cfn --query "Stacks[0].Outputs[0].OutputValue" --output text > ~/salida.txt'], check: (c) => (c.file('salida.txt') ?? '').includes('lab-cfn-datos-2026') || '~/salida.txt debe contener el nombre del bucket (la salida Cubo).' },
      ],
      script: scriptOf(E1),
      solution: solutionOf(E1),
      realWorld: 'Repite este laboratorio en tu cuenta real con un bucket de nombre único (los nombres son globales) y un perfil con permisos de CloudFormation y S3. Un bucket vacío no cuesta nada. **Limpieza:** `aws cloudformation delete-stack --stack-name lab-cfn` y comprueba en la consola que la pila desaparece; si has subido objetos, vacía el bucket antes o el borrado quedará en `DELETE_FAILED`.',
    },
    {
      id: 'l09-e2',
      title: 'Una red parametrizada',
      summary: 'Un parámetro con valores permitidos, una VPC, una subred y un grupo de seguridad.',
      difficulty: 'Media',
      minutes: 18,
      saa: [SAA_DOMAINS[1], SAA_DOMAINS[2]],
      tags: ['CloudFormation', 'VPC', 'Parámetros', '!Sub'],
      scenario: 'Despliega con CloudFormation una VPC `10.80.0.0/16`, una subred y un grupo de seguridad que solo acepte HTTP. La plantilla `red.yaml` tiene un parámetro `Entorno` (`dev` o `prod`) que se usa en la etiqueta `Name` de la VPC (`<entorno>-vpc`). Comprueba que **un valor no permitido (`qa`) se rechaza** antes de crear nada y luego crea la pila `lab-red` con `prod`.',
      steps: [
        { id: 'tpl', title: 'Escribe `~/lab-red/red.yaml` con el parámetro `Entorno` (AllowedValues), la VPC, la subred y el grupo de seguridad', hint: ['Parameters: Entorno: Type: String, AllowedValues: [dev, prod]', 'Tags de la VPC: Key: Name, Value: !Sub "${Entorno}-vpc"', 'VpcId: !Ref Vpc en la subred y en el grupo de seguridad.'], check: (c) => { const f = c.file('lab-red/red.yaml'); return (!!f && ['AllowedValues', 'AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::EC2::SecurityGroup', '!Sub'].every((k) => f.includes(k))) || '~/lab-red/red.yaml debe tener el parámetro, la VPC, la subred y el grupo de seguridad.'; } },
        { id: 'bad', title: 'Intenta crear la pila con `Entorno=qa`: CloudFormation debe rechazarlo', hint: ['--parameters ParameterKey=Entorno,ParameterValue=qa', 'El error dice «must be one of AllowedValues» y no se crea nada.'], check: (c) => c.tried(/create-stack[^\n]*ParameterValue=qa/) || 'Prueba a crear la pila con ParameterValue=qa y lee el error.' },
        { id: 'ok', title: 'Crea la pila `lab-red` con `Entorno=prod` y espera a que termine', hint: ['aws cloudformation create-stack --stack-name lab-red --template-body file://red.yaml --parameters ParameterKey=Entorno,ParameterValue=prod', 'aws cloudformation wait stack-create-complete --stack-name lab-red'], check: (c) => { const s = live(c, 'lab-red'); if (!s) return 'La pila lab-red todavía no existe.'; if (s.status !== 'CREATE_COMPLETE') return `La pila está en ${s.status}: usa wait stack-create-complete.`; const v = c.vpc('10.80.0.0/16'); if (!v) return 'No se encuentra la VPC 10.80.0.0/16.'; if (v.tags.Name !== 'prod-vpc') return `La VPC se llama «${v.tags.Name ?? ''}»: debe ser prod-vpc (¿usaste Entorno=prod?).`; return (c.subnets(v.id).length === 1 && !!c.sg('', v.id) === false) || true; } },
        { id: 'res', title: 'Comprueba que los tres recursos están en `CREATE_COMPLETE` con `describe-stack-resources`', hint: ['aws cloudformation describe-stack-resources --stack-name lab-red --query "StackResources[].[LogicalResourceId,ResourceStatus]" --output text'], check: (c) => c.ran(ran('(describe|list)-stack-resources')) || 'Consulta los recursos de la pila con describe-stack-resources o list-stack-resources.' },
      ],
      script: [...scriptOf(E2), 'aws cloudformation describe-stack-resources --stack-name lab-red --query "StackResources[].[LogicalResourceId,ResourceStatus]" --output text'],
      solution: solutionOf(E2) + '\n\nY para revisar los recursos:\n\n```bash\naws cloudformation describe-stack-resources --stack-name lab-red --query "StackResources[].[LogicalResourceId,ResourceStatus]" --output text\n```',
      realWorld: 'En tu cuenta real una VPC, una subred y un grupo de seguridad **no tienen coste**, ideal para practicar. Usa un rango que no choque con tus otras VPC. Prueba también `aws cloudformation validate-template` antes de desplegar. **Limpieza:** `aws cloudformation delete-stack --stack-name lab-red` (CloudFormation borra primero el grupo de seguridad y la subred y por último la VPC).',
    },
    {
      id: 'l09-e3',
      title: 'Cuando la pila falla',
      summary: 'Lee el motivo de un CREATE_FAILED, entiende el rollback y recréala bien.',
      difficulty: 'Media',
      minutes: 20,
      saa: [SAA_DOMAINS[2]],
      tags: ['CloudFormation', 'Rollback', 'Eventos', 'S3'],
      scenario: 'Un compañero ha preparado `~/lab-fallo/plantilla.yaml` (un tema SNS y el bucket `lab-cfn-ocupado-2026`), pero ese bucket **ya existe**. Crea la pila `lab-fallo`, comprueba que acaba en `ROLLBACK_COMPLETE`, guarda en `~/motivo.txt` el motivo del `CREATE_FAILED`, corrige el nombre del bucket (`lab-cfn-libre-2026`), elimina la pila fallida y créala de nuevo.',
      setup: async (sh) => {
        await prep(sh, ['aws s3 mb s3://lab-cfn-ocupado-2026', 'mkdir -p lab-fallo', ...scriptOf([{ file: 'lab-fallo/plantilla.yaml', body: FALLO }])]);
      },
      steps: [
        { id: 'fail', title: 'Crea la pila `lab-fallo` con la plantilla: acabará en `ROLLBACK_COMPLETE`', hint: ['cd lab-fallo', 'aws cloudformation create-stack --stack-name lab-fallo --template-body file://plantilla.yaml', 'El tema SNS que se llegó a crear se borra solo durante el rollback.'], check: (c) => (stacks(c, 'lab-fallo').some((s) => s.events.some((e) => e.status === 'CREATE_FAILED')) ? true : 'Crea la pila lab-fallo con la plantilla del escenario.') },
        { id: 'why', title: 'Guarda en `~/motivo.txt` el motivo del evento `CREATE_FAILED`', hint: ['aws cloudformation describe-stack-events --stack-name lab-fallo --query "StackEvents[?ResourceStatus==\'CREATE_FAILED\'].ResourceStatusReason" --output text > ~/motivo.txt', 'Busca el estado CREATE_FAILED entre los eventos.'], check: (c) => /already|exists|own/i.test(c.file('motivo.txt') ?? '') || '~/motivo.txt debe contener el motivo del fallo (el bucket ya existe).' },
        { id: 'fix', title: 'Cambia el bucket a `lab-cfn-libre-2026` y elimina la pila fallida', hint: ["sed -i s/lab-cfn-ocupado-2026/lab-cfn-libre-2026/ plantilla.yaml", 'Una pila en ROLLBACK_COMPLETE no se puede actualizar: solo borrar.'], check: (c) => { const f = c.file('lab-fallo/plantilla.yaml') ?? ''; if (!f.includes('lab-cfn-libre-2026')) return 'Edita plantilla.yaml para usar lab-cfn-libre-2026.'; return stacks(c, 'lab-fallo').some((s) => s.status === 'DELETE_COMPLETE') || 'Elimina la pila fallida con delete-stack.'; } },
        { id: 'again', title: 'Vuelve a crear la pila `lab-fallo`: ahora debe llegar a `CREATE_COMPLETE`', hint: ['El nombre de la pila se puede reutilizar tras borrarla.', 'aws cloudformation wait stack-create-complete --stack-name lab-fallo'], check: (c) => { const s = live(c, 'lab-fallo'); if (!s) return 'Todavía no hay una pila lab-fallo activa.'; if (s.status !== 'CREATE_COMPLETE') return `La pila está en ${s.status}.`; return !!c.bucket('lab-cfn-libre-2026') || 'Falta el bucket lab-cfn-libre-2026.'; } },
      ],
      script: scriptOf(E3),
      solution: solutionOf(E3),
      realWorld: 'En tu cuenta real el nombre del bucket debe ser único en todo el mundo; este mismo fallo te saldrá al usar un nombre fijo común. La mejor solución es **no poner `BucketName`** y dejar que CloudFormation genere uno. Consulta siempre `describe-stack-events` y la pestaña *Eventos* de la consola. **Limpieza:** `aws cloudformation delete-stack --stack-name lab-fallo` y `aws s3 rb s3://lab-cfn-ocupado-2026` (el bucket que creaste a mano).',
    },
    {
      id: 'l09-e4',
      title: 'Cambios con red: change sets',
      summary: 'Previsualiza una actualización, guárdala y ejecútala.',
      difficulty: 'Difícil',
      minutes: 22,
      saa: [SAA_DOMAINS[1], SAA_DOMAINS[2]],
      tags: ['CloudFormation', 'Change sets', 'CloudWatch Logs'],
      scenario: 'La pila `lab-cs` (un tema SNS y el bucket `lab-cfn-cs-2026`) está en producción. Hay que añadirle un grupo de registros `/lab-cfn/app`. No quieres sorpresas: añade el recurso a `~/lab-cs/plantilla.yaml`, crea el change set `agregar-logs`, guarda su contenido en `~/cambios.txt` (debe decir `Add`), **y solo entonces** ejecútalo y espera a `UPDATE_COMPLETE`.',
      setup: async (sh) => {
        await prep(sh, ['mkdir -p lab-cs', ...scriptOf([{ file: 'lab-cs/plantilla.yaml', body: CS }]), 'aws cloudformation deploy --template-file lab-cs/plantilla.yaml --stack-name lab-cs']);
      },
      steps: [
        { id: 'edit', title: 'Añade el recurso `AWS::Logs::LogGroup` (`/lab-cfn/app`) a `~/lab-cs/plantilla.yaml`', hint: ['El nuevo recurso va dentro de Resources, con dos espacios de sangría.', 'printf ... >> plantilla.yaml añade al final del fichero.'], check: (c) => (c.file('lab-cs/plantilla.yaml') ?? '').includes('AWS::Logs::LogGroup') || 'La plantilla todavía no declara el grupo de registros.' },
        { id: 'cs', title: 'Crea el change set `agregar-logs` y guarda `describe-change-set` en `~/cambios.txt`', hint: ['aws cloudformation create-change-set --stack-name lab-cs --change-set-name agregar-logs --template-body file://plantilla.yaml', 'aws cloudformation describe-change-set ... --query Changes > ~/cambios.txt', 'Espera con wait change-set-create-complete.'], check: (c) => { const s = live(c, 'lab-cs'); const cs = s?.changeSets.find((x) => x.name === 'agregar-logs'); if (!cs) return 'No existe el change set agregar-logs.'; if (!cs.changes.some((x) => x.action === 'Add' && x.logicalId === 'Logs')) return 'El change set no añade el recurso Logs: revisa la plantilla.'; return (c.file('cambios.txt') ?? '').includes('"Add"') || '~/cambios.txt debe contener los cambios del change set (Add).'; } },
        { id: 'exec', title: 'Ejecuta el change set y espera a `UPDATE_COMPLETE`: el grupo de registros existe', hint: ['aws cloudformation execute-change-set --stack-name lab-cs --change-set-name agregar-logs', 'aws cloudformation wait stack-update-complete --stack-name lab-cs'], check: (c) => { const s = live(c, 'lab-cs'); if (!s) return 'No se encuentra la pila lab-cs.'; if (!c.logGroup('/lab-cfn/app')) return 'El grupo de registros aún no existe: ejecuta el change set.'; return s.status === 'UPDATE_COMPLETE' || `La pila está en ${s.status}: usa wait stack-update-complete.`; } },
      ],
      script: scriptOf(E4),
      solution: solutionOf(E4),
      realWorld: 'En una cuenta real un change set es **gratis**; lo que se factura son los recursos. Revisa siempre la columna `Replacement`: `True` significa que el recurso se destruye y se crea de nuevo (con pérdida de datos si es una base de datos). En la consola: *Pila → Conjuntos de cambios*. **Limpieza:** `aws cloudformation delete-stack --stack-name lab-cs` (vacía antes el bucket si subiste algo; los grupos de registros se borran con la pila).',
    },
    {
      id: 'l09-e5',
      title: 'Capacidades de IAM y deploy',
      summary: 'Despliega un rol de IAM con deploy: primero falla, luego se autoriza.',
      difficulty: 'Reto',
      minutes: 20,
      saa: [SAA_DOMAINS[1]],
      tags: ['CloudFormation', 'IAM', 'deploy', 'Capacidades'],
      scenario: 'En `~/lab-iam/rol.yaml` hay que declarar un rol de IAM para instancias EC2 con acceso de solo lectura a S3. Despliégalo con `aws cloudformation deploy` en la pila `lab-iam`. CloudFormation **se negará** la primera vez porque la plantilla crea recursos de IAM: lee el error, reconoce la capacidad que pide y vuelve a desplegar. Para terminar, elimina la pila y comprueba que el rol desaparece.',
      steps: [
        { id: 'tpl', title: 'Escribe `~/lab-iam/rol.yaml` con un `AWS::IAM::Role` (confianza en `ec2.amazonaws.com`) y la política `AmazonS3ReadOnlyAccess`', hint: ['Principal: Service: ec2.amazonaws.com y Action: sts:AssumeRole.', 'ManagedPolicyArns: [arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess]'], check: (c) => { const f = c.file('lab-iam/rol.yaml') ?? ''; return (f.includes('AWS::IAM::Role') && f.includes('ec2.amazonaws.com') && f.includes('AmazonS3ReadOnlyAccess')) || 'Falta el rol en ~/lab-iam/rol.yaml.'; } },
        { id: 'deny', title: 'Despliega sin capacidades y lee el error `Requires capabilities : [CAPABILITY_IAM]`', hint: ['aws cloudformation deploy --template-file rol.yaml --stack-name lab-iam'], check: (c) => c.tried(/cloudformation\s+deploy(?![^\n]*capabilities)[^\n]*lab-iam/) || 'Ejecuta deploy sin --capabilities para ver el error de capacidades.' },
        { id: 'deploy', title: 'Vuelve a desplegar con `--capabilities CAPABILITY_IAM`: el rol existe', hint: ['aws cloudformation deploy ... --capabilities CAPABILITY_IAM', 'CloudFormation genera el nombre del rol: lab-iam-Rol-XXXX.'], check: (c) => stacks(c, 'lab-iam').some((s) => s.events.some((e) => e.status === 'CREATE_COMPLETE' && e.type === 'AWS::IAM::Role')) || 'El rol aún no se ha creado: despliega con --capabilities CAPABILITY_IAM.' },
        { id: 'clean', title: 'Elimina la pila con `delete-stack` y comprueba que el rol se borra', hint: ['aws cloudformation delete-stack --stack-name lab-iam', 'Los recursos de una pila se borran con ella.'], check: (c) => { const s = stacks(c, 'lab-iam')[0]; if (!s || s.status !== 'DELETE_COMPLETE') return 'La pila lab-iam sigue activa: elimínala con delete-stack.'; return !c.s.roles.some((r) => r.name.startsWith('lab-iam-Rol-')) || 'El rol sigue existiendo.'; } },
      ],
      script: scriptOf(E5),
      solution: solutionOf(E5),
      realWorld: 'Un rol de IAM no cuesta nada, pero **concede permisos**: usa siempre políticas de mínimo privilegio y, en una cuenta real, un perfil que pueda crear roles solo a través de CloudFormation (con `--role-arn` y `iam:PassRole`). Si le pones nombre al rol necesitarás `CAPABILITY_NAMED_IAM`. **Limpieza:** `aws cloudformation delete-stack --stack-name lab-iam` y verifica en IAM que el rol ya no está.',
    },
  ],
  quiz: [
    { domain: 2, q: '¿Qué ocurre cuando un recurso falla durante la creación de una pila (con la configuración por defecto)?', options: ['La pila queda a medias para que puedas arreglarla', 'CloudFormation revierte: borra lo creado y la pila acaba en ROLLBACK_COMPLETE', 'Se reintenta indefinidamente', 'Se ignora el recurso y la pila queda en CREATE_COMPLETE'], answer: 1, explain: 'Por defecto CloudFormation hace rollback y elimina los recursos creados. La pila resultante solo se puede borrar. Con --on-failure DO_NOTHING (o desactivando la reversión) se conservan los recursos para investigar.' },
    { domain: 1, q: 'Tu plantilla crea un rol de IAM y el despliegue falla con «Requires capabilities : [CAPABILITY_IAM]». ¿Qué debes hacer?', options: ['Dar AdministratorAccess al usuario', 'Reconocer explícitamente la capacidad con --capabilities CAPABILITY_IAM (o CAPABILITY_NAMED_IAM si el rol tiene nombre propio)', 'Quitar el rol de la plantilla', 'Cambiar de región'], answer: 1, explain: 'Es una confirmación de que sabes que la plantilla puede crear permisos. Si los recursos de IAM tienen nombres personalizados hace falta CAPABILITY_NAMED_IAM.' },
    { domain: 2, q: 'Quieres saber qué cambiaría una actualización de la pila (y si algún recurso se sustituiría) antes de aplicarla. ¿Qué usas?', options: ['update-stack directamente', 'Un conjunto de cambios (change set)', 'delete-stack y create-stack', 'Los eventos de la pila'], answer: 1, explain: 'Un change set muestra Add, Modify y Remove y el atributo Replacement, y no toca nada hasta que lo ejecutas.' },
    { domain: 1, q: 'Para que un desarrollador despliegue pilas sin darle permisos para crear cada recurso, ¿qué configuras?', options: ['Compartir las claves del administrador', 'Un rol de servicio de CloudFormation (--role-arn) y permiso cloudformation:* más iam:PassRole para el desarrollador', 'Desactivar CloudTrail', 'Usar solo la consola de S3'], answer: 1, explain: 'CloudFormation usa el rol de servicio para crear los recursos, de modo que el usuario solo necesita permisos sobre CloudFormation y poder pasar ese rol.' },
    { domain: 4, q: 'Terminas un laboratorio con muchos recursos de pago creados con una pila. ¿Cómo evitas costes olvidados?', options: ['Borrarlos uno a uno por consola', 'Eliminar la pila: borra todos sus recursos de una vez', 'Apagar el ordenador', 'Cambiar de cuenta'], answer: 1, explain: 'Una pila es la unidad de ciclo de vida: delete-stack elimina todos los recursos (salvo los que tengan DeletionPolicy Retain).' },
    { domain: 1, q: 'Necesitas que un bucket con datos importantes sobreviva al borrado de la pila. ¿Qué atributo usas?', options: ['DependsOn', 'DeletionPolicy: Retain', 'Condition', 'Metadata'], answer: 1, explain: 'Con DeletionPolicy: Retain el recurso se conserva al eliminar la pila (queda DELETE_SKIPPED). Sin él, un bucket con objetos hace fallar el borrado.' },
    { domain: 3, q: 'Quieres desplegar la misma plantilla en dev y en prod con distinto tamaño de instancia. ¿Cuál es la forma idiomática?', options: ['Dos plantillas copiadas', 'Parámetros (con AllowedValues), Mappings y Conditions en una única plantilla', 'Editar la pila a mano en la consola', 'Un script que reescribe el texto de la plantilla'], answer: 1, explain: 'Parameters, Mappings y Conditions permiten una sola plantilla revisable y reutilizable para varios entornos.' },
    { domain: 2, q: 'Una actualización cambia una propiedad que exige sustitución en un recurso con nombre fijo. ¿Qué ocurre?', options: ['Se sustituye sin problema', 'CloudFormation lo rechaza: no puede actualizar un recurso con nombre personalizado que requiere sustituirse; renómbralo o deja que genere el nombre', 'Se borra la pila', 'Se crea un duplicado con sufijo'], answer: 1, explain: 'El recurso nuevo chocaría con el nombre del antiguo, así que la actualización falla y se revierte (UPDATE_ROLLBACK_COMPLETE).' },
  ],
};

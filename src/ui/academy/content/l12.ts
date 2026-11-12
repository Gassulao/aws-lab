import { SAA_DOMAINS, type Level } from '../types';
import { prep } from '../setup';
import type { Shell } from '../../../shell';
import type { CheckCtx } from '../checks';
import { sv, settleSv } from '../../../engine/serverless';
import { rdsStatus, snapshotStatus } from '../../../engine/serverless/rds';
import { tableStatus } from '../../../engine/serverless/dynamodb';
import lambda from './l12/1-lambda.md?raw';
import colas from './l12/2-sqs-sns.md?raw';
import api from './l12/3-apigateway-dynamodb.md?raw';
import rds from './l12/4-rds.md?raw';

// ---------------------------------------------------------------- ayudas de comprobación
/** Estado de serverless con el paso del tiempo aplicado (colas, mapeos, RDS). */
const S = (c: CheckCtx) => { settleSv(c.s); return sv(c.s); };
const fnOf = (c: CheckCtx, name: string) => S(c).lambdas.find((f) => f.name === name && f.region === c.s.region);
const queue = (c: CheckCtx, name: string) => S(c).queues.find((q) => q.name === name && q.region === c.s.region);
const table = (c: CheckCtx, name: string) => S(c).tables.find((t) => t.name === name && t.region === c.s.region);
const db = (c: CheckCtx, id: string) => S(c).rdsInstances.find((d) => d.id === id && d.region === c.s.region);
/** Texto de todos los registros de un grupo de CloudWatch Logs. */
const logText = (c: CheckCtx, group: string) => c.s.logGroups.find((g) => g.name === group && g.region === c.s.region)?.streams.flatMap((s) => s.events.map((e) => e.message)).join('\n') ?? '';
const ACC = 'ACC=$(aws sts get-caller-identity --query Account --output text)';
const pol = (n: string) => `arn:aws:iam::aws:policy/${n}`;
const BASIC = pol('service-role/AWSLambdaBasicExecutionRole');
const trust = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}';
/** Crea un rol de ejecución de Lambda (sin permisos o con las políticas indicadas). */
const lambdaRole = (name: string, ...policies: string[]) => [
  `printf '${trust}' > /tmp/trust-${name}.json`,
  `aws iam create-role --role-name ${name} --assume-role-policy-document file:///tmp/trust-${name}.json`,
  ...policies.map((p) => `aws iam attach-role-policy --role-name ${name} --policy-arn ${p}`),
];
/** Crea una función con el código dado (preparación de escenarios). */
async function mkFn(sh: Shell, name: string, code: string, role: string, extra = '') {
  const dir = `/tmp/setup-${name}`;
  sh.fs.mkdir(dir, true);
  sh.fs.writeFile(`${dir}/index.js`, code);
  await prep(sh, [`zip -j ${dir}/f.zip ${dir}/index.js`, ACC, `aws lambda create-function --function-name ${name} --runtime nodejs20.x --handler index.handler --role arn:aws:iam::$ACC:role/${role} --zip-file fileb://${dir}/f.zip ${extra}`, `aws lambda wait function-active-v2 --function-name ${name}`]);
}

// ---------------------------------------------------------------- Laboratorio 1: tu primera función
const E1 = [
  'mkdir -p saludo',
  `printf 'exports.handler = async (event) => {\\n  const msg = process.env.SALUDO + " " + event.nombre;\\n  console.log(msg);\\n  return { mensaje: msg };\\n};\\n' > saludo/index.js`,
  'cd saludo', 'zip function.zip index.js', ACC,
  'aws lambda create-function --function-name saludo --runtime nodejs20.x --handler index.handler --role arn:aws:iam::$ACC:role/lambda-basico --zip-file fileb://function.zip --environment Variables={SALUDO=Hola}',
  'aws lambda wait function-active-v2 --function-name saludo',
  `aws lambda invoke --function-name saludo --cli-binary-format raw-in-base64-out --payload '{"nombre":"Ana"}' ~/respuesta.json`,
  'cd ~',
];

// ---------------------------------------------------------------- Laboratorio 2: la función que no deja rastro
const E2_SETUP = async (sh: Shell) => {
  await prep(sh, lambdaRole('lambda-pedidos'));
  await mkFn(sh, 'procesar', 'exports.handler = async (event) => {\n  console.log("procesando pedido", event.id);\n  await new Promise((r) => setTimeout(r, 2000));\n  return { estado: "ok" };\n};\n', 'lambda-pedidos', '--timeout 1');
};
const E2 = [
  `aws lambda invoke --function-name procesar --cli-binary-format raw-in-base64-out --payload '{"id":7}' ~/error.json`,
  'cat ~/error.json',
  'aws lambda update-function-configuration --function-name procesar --timeout 5',
  'aws lambda wait function-updated-v2 --function-name procesar',
  `aws iam attach-role-policy --role-name lambda-pedidos --policy-arn ${BASIC}`,
  `aws lambda invoke --function-name procesar --cli-binary-format raw-in-base64-out --payload '{"id":7}' ~/resultado.json`,
];

// ---------------------------------------------------------------- Laboratorio 3: versiones y alias
const E3_SETUP = async (sh: Shell) => {
  await prep(sh, lambdaRole('lambda-basico', BASIC));
  await mkFn(sh, 'precios', 'exports.handler = async () => ({ version: "v1", precio: 10 });\n', 'lambda-basico');
};
const E3 = [
  'aws lambda publish-version --function-name precios --description primera',
  'aws lambda create-alias --function-name precios --name prod --function-version 1',
  'mkdir -p precios',
  `printf 'exports.handler = async () => ({ version: "v2", precio: 12 });\\n' > precios/index.js`,
  'cd precios', 'zip function.zip index.js',
  'aws lambda update-function-code --function-name precios --zip-file fileb://function.zip',
  'aws lambda wait function-updated-v2 --function-name precios',
  'aws lambda publish-version --function-name precios --description segunda',
  'aws lambda update-alias --function-name precios --name prod --function-version 2',
  `aws lambda invoke --function-name precios:prod --cli-binary-format raw-in-base64-out --payload '{}' ~/prod.json`,
  `aws lambda invoke --function-name precios:1 --cli-binary-format raw-in-base64-out --payload '{}' ~/v1.json`,
  'cd ~',
];

// ---------------------------------------------------------------- Laboratorio 4: API HTTP + Lambda
const E4_SETUP = async (sh: Shell) => {
  await prep(sh, lambdaRole('lambda-basico', BASIC));
  await mkFn(sh, 'hola-api', 'exports.handler = async (event) => ({\n  statusCode: 200,\n  headers: { "content-type": "text/plain" },\n  body: "Hola desde la API: " + event.rawPath,\n});\n', 'lambda-basico');
};
const E4 = [
  ACC,
  'FN=$(aws lambda get-function --function-name hola-api --query Configuration.FunctionArn --output text)',
  'API=$(aws apigatewayv2 create-api --name tienda-api --protocol-type HTTP --target $FN --query ApiId --output text)',
  'curl -s https://$API.execute-api.eu-west-1.amazonaws.com/hola || true',
  'aws lambda add-permission --function-name hola-api --statement-id apigw --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:eu-west-1:$ACC:$API/*/*"',
  'curl -s https://$API.execute-api.eu-west-1.amazonaws.com/hola > ~/respuesta.txt',
];

// ---------------------------------------------------------------- Laboratorio 5: SQS y cola de mensajes fallidos
const E5 = [
  'aws sqs create-queue --queue-name pedidos-dlq',
  'DLQ=$(aws sqs get-queue-url --queue-name pedidos-dlq --query QueueUrl --output text)',
  'DLQARN=$(aws sqs get-queue-attributes --queue-url $DLQ --attribute-names QueueArn --query Attributes.QueueArn --output text)',
  String.raw`echo "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQARN\\\",\\\"maxReceiveCount\\\":\\\"2\\\"}\"}" > ~/redrive.json`,
  'aws sqs create-queue --queue-name pedidos --attributes file://redrive.json',
  'Q=$(aws sqs get-queue-url --queue-name pedidos --query QueueUrl --output text)',
  'aws sqs send-message --queue-url $Q --message-body pedido-1001',
  'aws sqs receive-message --queue-url $Q --visibility-timeout 0',
  'aws sqs receive-message --queue-url $Q --visibility-timeout 0',
  'aws sqs receive-message --queue-url $Q --visibility-timeout 0',
  'aws sqs receive-message --queue-url $DLQ > ~/dlq.json',
];

// ---------------------------------------------------------------- Laboratorio 6: SQS → Lambda → DynamoDB
const PROC = 'const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");\nconst db = new DynamoDBClient({});\nexports.handler = async (event) => {\n  for (const r of event.Records) {\n    const p = JSON.parse(r.body);\n    await db.send(new PutItemCommand({ TableName: "pedidos", Item: { id: { S: p.id }, total: { N: String(p.total) } } }));\n    console.log("guardado", p.id);\n  }\n};\n';
const E6_SETUP = async (sh: Shell) => {
  await prep(sh, [
    ...lambdaRole('lambda-pedidos', BASIC),
    'aws dynamodb create-table --table-name pedidos --attribute-definitions AttributeName=id,AttributeType=S --key-schema AttributeName=id,KeyType=HASH --billing-mode PAY_PER_REQUEST',
    'aws dynamodb wait table-exists --table-name pedidos',
    'aws sqs create-queue --queue-name cola-pedidos',
  ]);
  await mkFn(sh, 'procesador', PROC, 'lambda-pedidos', '--timeout 10');
};
const E6 = [
  `aws iam attach-role-policy --role-name lambda-pedidos --policy-arn ${pol('service-role/AWSLambdaSQSQueueExecutionRole')}`,
  `aws iam attach-role-policy --role-name lambda-pedidos --policy-arn ${pol('AmazonDynamoDBFullAccess')}`,
  'Q=$(aws sqs get-queue-url --queue-name cola-pedidos --query QueueUrl --output text)',
  'QARN=$(aws sqs get-queue-attributes --queue-url $Q --attribute-names QueueArn --query Attributes.QueueArn --output text)',
  'aws lambda create-event-source-mapping --function-name procesador --event-source-arn $QARN --batch-size 5',
  `aws sqs send-message --queue-url $Q --message-body '{"id":"1001","total":25}'`,
  `aws sqs send-message --queue-url $Q --message-body '{"id":"1002","total":40}'`,
  `aws sqs send-message --queue-url $Q --message-body '{"id":"1003","total":15}'`,
  'aws dynamodb scan --table-name pedidos --query Count',
];

// ---------------------------------------------------------------- Laboratorio 7: DynamoDB
const E7 = [
  'aws dynamodb create-table --table-name tienda-pedidos --attribute-definitions AttributeName=cliente,AttributeType=S AttributeName=pedido,AttributeType=S --key-schema AttributeName=cliente,KeyType=HASH AttributeName=pedido,KeyType=RANGE --billing-mode PAY_PER_REQUEST',
  'aws dynamodb wait table-exists --table-name tienda-pedidos',
  `aws dynamodb put-item --table-name tienda-pedidos --item '{"cliente":{"S":"ana"},"pedido":{"S":"p-001"},"total":{"N":"25"}}'`,
  `aws dynamodb put-item --table-name tienda-pedidos --item '{"cliente":{"S":"ana"},"pedido":{"S":"p-002"},"total":{"N":"40"}}'`,
  `aws dynamodb put-item --table-name tienda-pedidos --item '{"cliente":{"S":"ana"},"pedido":{"S":"p-003"},"total":{"N":"15"}}'`,
  `aws dynamodb put-item --table-name tienda-pedidos --item '{"cliente":{"S":"luis"},"pedido":{"S":"p-004"},"total":{"N":"99"}}'`,
  `aws dynamodb query --table-name tienda-pedidos --key-condition-expression "cliente = :c" --expression-attribute-values '{":c":{"S":"ana"}}' > ~/ana.json`,
  `aws dynamodb put-item --table-name tienda-pedidos --item '{"cliente":{"S":"ana"},"pedido":{"S":"p-001"},"total":{"N":"1"}}' --condition-expression "attribute_not_exists(pedido)" || true`,
];

// ---------------------------------------------------------------- Laboratorio 8: RDS Multi-AZ
const E8_SETUP = [
  'VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query Vpcs[0].VpcId --output text)',
  'aws ec2 create-security-group --group-name app-sg --description servidores-de-aplicacion --vpc-id $VPC',
  'aws ec2 create-security-group --group-name db-sg --description base-de-datos --vpc-id $VPC',
];
const E8 = [
  'SGAPP=$(aws ec2 describe-security-groups --filters Name=group-name,Values=app-sg --query SecurityGroups[0].GroupId --output text)',
  'SGDB=$(aws ec2 describe-security-groups --filters Name=group-name,Values=db-sg --query SecurityGroups[0].GroupId --output text)',
  'aws ec2 authorize-security-group-ingress --group-id $SGDB --protocol tcp --port 3306 --source-group $SGAPP',
  'aws rds create-db-instance --db-instance-identifier tienda-db --db-instance-class db.t3.micro --engine mysql --master-username admin --master-user-password Contrasena-Segura-1 --allocated-storage 20 --multi-az --no-publicly-accessible --vpc-security-group-ids $SGDB',
  'aws rds wait db-instance-available --db-instance-identifier tienda-db',
  'aws rds create-db-snapshot --db-instance-identifier tienda-db --db-snapshot-identifier tienda-db-antes',
  'aws rds wait db-snapshot-available --db-snapshot-identifier tienda-db-antes',
  'aws rds describe-db-instances --db-instance-identifier tienda-db --query DBInstances[0].AvailabilityZone --output text > ~/az-antes.txt',
  'aws rds reboot-db-instance --db-instance-identifier tienda-db --force-failover',
  'aws rds wait db-instance-available --db-instance-identifier tienda-db',
  'aws rds describe-db-instances --db-instance-identifier tienda-db --query DBInstances[0].AvailabilityZone --output text > ~/az-despues.txt',
];

export const l12: Level = {
  id: 12,
  slug: 'serverless',
  title: 'Serverless y datos',
  subtitle: 'Lambda, API Gateway, SQS, DynamoDB y RDS: arquitecturas sin servidores y bases de datos administradas.',
  skills: ['Lambda: roles, logs, versiones y alias', 'Desacoplar con SQS, DLQ y SNS', 'API Gateway + Lambda', 'DynamoDB: claves, consultas y condiciones', 'RDS: Multi-AZ, snapshots y seguridad de red', 'Diagnóstico de permisos entre servicios'],
  lessons: [
    { id: 'l12-lambda', title: 'AWS Lambda: código sin servidores', minutes: 10, body: lambda },
    { id: 'l12-colas', title: 'Mensajería: SQS, SNS y desacoplamiento', minutes: 10, body: colas },
    { id: 'l12-api', title: 'API Gateway y DynamoDB', minutes: 10, body: api },
    { id: 'l12-rds', title: 'Amazon RDS y alta disponibilidad', minutes: 9, body: rds },
  ],
  exercises: [
    {
      id: 'l12-e1',
      title: 'Tu primera función Lambda',
      summary: 'Escribe, empaqueta y despliega una función con variables de entorno, invócala y revisa sus logs.',
      difficulty: 'Fácil',
      minutes: 14,
      saa: [SAA_DOMAINS[3], SAA_DOMAINS[4]],
      tags: ['Lambda', 'IAM', 'CloudWatch Logs'],
      scenario: 'El equipo necesita un microservicio de saludos sin gestionar servidores. Con el rol `lambda-basico` ya creado, escribe en `~/saludo/index.js` una función Node.js que devuelva `{ mensaje: SALUDO + " " + nombre }` (el saludo viene de la variable de entorno `SALUDO` y el nombre del evento), empaquétala en un zip, crea la función `saludo` (`nodejs20.x`, controlador `index.handler`) con `SALUDO=Hola`, invócala con `{"nombre":"Ana"}` guardando la respuesta en `~/respuesta.json` y comprueba que aparece el mensaje en CloudWatch Logs.',
      setup: async (sh) => { await prep(sh, lambdaRole('lambda-basico', BASIC)); },
      steps: [
        { id: 'fn', title: 'Crea la función `saludo` (`nodejs20.x`, `index.handler`, rol `lambda-basico`) con la variable `SALUDO=Hola`', hint: ['El código va en un .zip: zip function.zip index.js', 'aws lambda create-function --function-name saludo --runtime nodejs20.x --handler index.handler --role <arn> --zip-file fileb://function.zip', 'Las variables de entorno: --environment Variables={SALUDO=Hola}'], check: (c) => { const f = fnOf(c, 'saludo'); if (!f) return 'No existe la función saludo.'; if (f.runtime !== 'nodejs20.x') return 'El tiempo de ejecución debe ser nodejs20.x.'; if (!f.role.endsWith('/lambda-basico')) return 'La función debe usar el rol lambda-basico.'; if (f.env.SALUDO !== 'Hola') return 'Falta la variable de entorno SALUDO=Hola.'; return /nombre/.test(f.files['index.js'] ?? '') || 'El código debe usar event.nombre.'; } },
        { id: 'invoke', title: 'Invócala con `{"nombre":"Ana"}` y guarda la respuesta en `~/respuesta.json`', hint: ['aws lambda wait function-active-v2 --function-name saludo espera a que deje de estar Pending.', 'aws lambda invoke --function-name saludo --cli-binary-format raw-in-base64-out --payload \'{"nombre":"Ana"}\' ~/respuesta.json', 'Sin --cli-binary-format raw-in-base64-out la CLI v2 espera el payload en base64.'], check: (c) => /Hola Ana/.test(c.file('respuesta.json') ?? '') || '~/respuesta.json debe contener «Hola Ana».' },
        { id: 'logs', title: 'Confirma que el grupo `/aws/lambda/saludo` de CloudWatch Logs contiene el mensaje `Hola Ana`', hint: ['aws logs describe-log-streams --log-group-name /aws/lambda/saludo', 'aws logs get-log-events --log-group-name /aws/lambda/saludo --log-stream-name <flujo>', 'Lambda crea el grupo solo si el rol de ejecución puede escribir logs.'], check: (c) => /Hola Ana/.test(logText(c, '/aws/lambda/saludo')) || 'Todavía no hay registros de la función en /aws/lambda/saludo.' },
      ],
      script: E1,
      realWorld: 'En tu cuenta real el nivel gratuito incluye 1 millón de invocaciones y 400.000 GB-s al mes, así que este laboratorio no cuesta nada. Usa `aws lambda invoke --log-type Tail --query LogResult --output text | base64 -d` para ver los logs en el momento. El paquete real puede incluir `node_modules`; con Node 18+ el SDK v3 ya viene en el entorno de ejecución. **Limpieza:** `aws lambda delete-function --function-name saludo` y, si ya no lo necesitas, el rol `lambda-basico` y el grupo de logs `/aws/lambda/saludo` (los logs siguen cobrándose hasta que los elimines o les pongas retención).',
    },
    {
      id: 'l12-e2',
      title: 'La función que no deja rastro',
      summary: 'Una función falla y no hay logs: encuentra el timeout y el permiso que falta.',
      difficulty: 'Media',
      minutes: 18,
      saa: [SAA_DOMAINS[2], SAA_DOMAINS[1]],
      tags: ['Lambda', 'IAM', 'Diagnóstico', 'CloudWatch Logs'],
      scenario: 'La función `procesar` devuelve un error al invocarla y, para colmo, no existe el grupo de logs `/aws/lambda/procesar`: nadie sabe qué pasa. Invócala con `{"id":7}` guardando la respuesta en `~/error.json` para ver el motivo, corrige el tiempo de espera (el código necesita unos 2 segundos) y dale al rol `lambda-pedidos` el permiso para escribir logs. Vuelve a invocarla guardando el resultado en `~/resultado.json` y comprueba que ya aparecen registros.',
      setup: E2_SETUP,
      steps: [
        { id: 'cause', title: 'Guarda en `~/error.json` la respuesta del primer intento (debe mostrar el motivo del fallo)', hint: ['aws lambda invoke ... ~/error.json y después cat ~/error.json', 'El payload de respuesta incluye errorMessage.'], check: (c) => /Task timed out/.test(c.file('error.json') ?? '') || '~/error.json debe contener el error «Task timed out after…».' },
        { id: 'timeout', title: 'Sube el tiempo de espera de `procesar` a 3 segundos o más', hint: ['aws lambda update-function-configuration --function-name procesar --timeout 5'], check: (c) => (fnOf(c, 'procesar')?.timeout ?? 0) >= 3 || 'El timeout de procesar sigue siendo demasiado bajo.' },
        { id: 'perm', title: 'Concede al rol `lambda-pedidos` la política `AWSLambdaBasicExecutionRole`', hint: ['El rol de ejecución necesita logs:CreateLogGroup, logs:CreateLogStream y logs:PutLogEvents.', 'aws iam attach-role-policy --role-name lambda-pedidos --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'], check: (c) => c.roleHas('lambda-pedidos', 'AWSLambdaBasicExecutionRole') || 'El rol lambda-pedidos no tiene permisos para escribir logs.' },
        { id: 'ok', title: 'Invoca de nuevo guardando `~/resultado.json` (`"ok"`) y comprueba que `/aws/lambda/procesar` tiene el registro `procesando pedido`', hint: ['Repite el invoke con la misma carga útil.', 'Los registros aparecen en el grupo /aws/lambda/procesar.'], check: (c) => { if (!/"ok"/.test(c.file('resultado.json') ?? '')) return '~/resultado.json debe contener {"estado":"ok"}.'; return /procesando pedido/.test(logText(c, '/aws/lambda/procesar')) || 'Aún no hay registros en /aws/lambda/procesar.'; } },
      ],
      script: E2,
      realWorld: 'En AWS real el síntoma «la función falla y no hay logs» casi siempre es el rol de ejecución (sin permisos de CloudWatch Logs) o una función que ni siquiera llega a ejecutarse (VPC sin salida, permisos de invocación). Para los timeouts mira la línea `REPORT` (`Duration`, `Max Memory Used`) y usa CloudWatch Logs Insights. Un timeout alto con tráfico que cuelga cuesta dinero: ajusta el valor al tiempo real más un margen. **Limpieza:** `aws lambda delete-function --function-name procesar`, el rol `lambda-pedidos` y el grupo de logs `/aws/lambda/procesar`.',
    },
    {
      id: 'l12-e3',
      title: 'Versiones y alias: despliegue sin sobresaltos',
      summary: 'Publica versiones inmutables y mueve un alias de producción sin cambiar a los clientes.',
      difficulty: 'Media',
      minutes: 18,
      saa: [SAA_DOMAINS[2], SAA_DOMAINS[3]],
      tags: ['Lambda', 'Versiones', 'Alias', 'Despliegue'],
      scenario: 'La función `precios` (que devuelve `v1`) ya está en marcha. Publica la versión 1 y crea el alias `prod` apuntando a ella. Después cambia el código para que devuelva `v2`, publica la versión 2 y mueve el alias `prod` a la 2. Guarda en `~/prod.json` la respuesta del alias y en `~/v1.json` la de la versión 1 para comprobar que las versiones publicadas son inmutables.',
      setup: E3_SETUP,
      steps: [
        { id: 'v1', title: 'Publica la versión 1 (con el código `v1`) y crea el alias `prod` apuntando a ella', hint: ['aws lambda publish-version --function-name precios', 'aws lambda create-alias --function-name precios --name prod --function-version 1'], check: (c) => { const f = fnOf(c, 'precios'); if (!f) return 'No existe precios.'; const v1 = f.versions.find((v) => v.version === '1'); if (!v1) return 'Aún no has publicado la versión 1.'; if (!/v1/.test(Object.values(v1.files).join(''))) return 'La versión 1 debe contener el código v1: publícala antes de cambiar el código.'; return !!f.aliases.find((a) => a.name === 'prod') || 'Falta el alias prod.'; } },
        { id: 'v2', title: 'Actualiza el código para que devuelva `v2` y publica la versión 2', hint: ['Edita index.js, zip function.zip index.js y aws lambda update-function-code --function-name precios --zip-file fileb://function.zip', 'aws lambda wait function-updated-v2 y después aws lambda publish-version.'], check: (c) => { const f = fnOf(c, 'precios'); const v2 = f?.versions.find((v) => v.version === '2'); if (!v2) return 'Aún no has publicado la versión 2.'; return /v2/.test(Object.values(v2.files).join('')) || 'La versión 2 debe contener el código v2.'; } },
        { id: 'alias', title: 'Mueve el alias `prod` a la versión 2', hint: ['aws lambda update-alias --function-name precios --name prod --function-version 2'], check: (c) => fnOf(c, 'precios')?.aliases.find((a) => a.name === 'prod')?.version === '2' || 'El alias prod debe apuntar a la versión 2.' },
        { id: 'immutable', title: 'Guarda `~/prod.json` (invocando `precios:prod`, debe dar `v2`) y `~/v1.json` (invocando `precios:1`, sigue dando `v1`)', hint: ['aws lambda invoke --function-name precios:prod ... ~/prod.json', 'Una versión publicada nunca cambia aunque edites $LATEST.'], check: (c) => (/v2/.test(c.file('prod.json') ?? '') && /v1/.test(c.file('v1.json') ?? '')) || '~/prod.json debe contener v2 y ~/v1.json debe contener v1.' },
      ],
      script: E3,
      realWorld: 'En producción real los clientes (API Gateway, event source mappings, otras funciones) llaman al **alias**, nunca a `$LATEST`; así un despliegue es publicar una versión y mover el alias, y el *rollback* es mover el alias de vuelta. Con `--routing-config AdditionalVersionWeights={"2"=0.1}` envías el 10 % a la versión nueva (despliegue canario); CodeDeploy puede automatizarlo con alarmas. Las versiones no cuestan por sí mismas, pero acumulan código: borra las viejas. **Limpieza:** `aws lambda delete-alias` y `aws lambda delete-function --function-name precios` (elimina todas las versiones).',
    },
    {
      id: 'l12-e4',
      title: 'Una API HTTP delante de Lambda',
      summary: 'Publica una función con API Gateway, descubre por qué responde 500 y corrígelo con el permiso adecuado.',
      difficulty: 'Media',
      minutes: 20,
      saa: [SAA_DOMAINS[1], SAA_DOMAINS[3]],
      tags: ['API Gateway', 'Lambda', 'IAM', 'curl'],
      scenario: 'Quieres exponer la función `hola-api` por HTTPS. Crea una **API HTTP** `tienda-api` con integración Lambda (creación rápida con `--target`), llama a `https://<api-id>.execute-api.eu-west-1.amazonaws.com/hola` con `curl` y observa el error. Averigua qué falta para que API Gateway pueda invocar la función, corrígelo y guarda en `~/respuesta.txt` la respuesta correcta.',
      setup: E4_SETUP,
      steps: [
        { id: 'api', title: 'Crea la API HTTP `tienda-api` con una integración Lambda hacia `hola-api`', hint: ['aws apigatewayv2 create-api --name tienda-api --protocol-type HTTP --target <arn-de-la-función>', 'El ARN de la función: aws lambda get-function --function-name hola-api --query Configuration.FunctionArn --output text'], check: (c) => { const a = S(c).httpApis.find((x) => x.name === 'tienda-api' && x.region === c.s.region); if (!a) return 'No existe la API tienda-api.'; return a.integrations.some((i) => i.uri.includes(':function:hola-api')) || 'La API debe integrarse con la función hola-api.'; } },
        { id: 'perm', title: 'Permite que API Gateway invoque la función (`add-permission` con el ARN de origen de la API)', hint: ['La primera llamada devuelve 500: API Gateway no tiene permiso de invocación.', 'aws lambda add-permission --function-name hola-api --statement-id apigw --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:eu-west-1:<cuenta>:<api-id>/*/*"'], check: (c) => { const a = S(c).httpApis.find((x) => x.name === 'tienda-api'); const f = fnOf(c, 'hola-api'); if (!a || !f) return 'Primero crea la API.'; return f.permissions.some((p) => p.principal === 'apigateway.amazonaws.com' && (p.sourceArn ?? '').includes(a.id)) || 'La función aún no permite que apigateway.amazonaws.com la invoque desde esta API.'; } },
        { id: 'curl', title: 'Guarda en `~/respuesta.txt` la respuesta de `curl` a `/hola`', hint: ['curl -s https://<api-id>.execute-api.eu-west-1.amazonaws.com/hola > ~/respuesta.txt', 'El id de la API: aws apigatewayv2 get-apis --query "Items[0].ApiId" --output text'], check: (c) => /Hola desde la API: \/hola/.test(c.file('respuesta.txt') ?? '') || '~/respuesta.txt debe contener «Hola desde la API: /hola».' },
      ],
      script: E4,
      realWorld: 'Con una API HTTP real la integración rápida crea la ruta `$default`, la etapa `$default` con implementación automática y, **desde la consola**, también el permiso de Lambda; con la CLI debes añadirlo tú, por eso este fallo es tan común. Una API HTTP cuesta alrededor de 1 USD por millón de peticiones. Añade autorización (JWT, IAM o un autorizador Lambda) antes de exponer nada sensible y limita el `--source-arn` a la API concreta. **Limpieza:** `aws apigatewayv2 delete-api --api-id <id>` y `aws lambda delete-function --function-name hola-api`.',
    },
    {
      id: 'l12-e5',
      title: 'SQS: mensajes venenosos y cola de mensajes fallidos',
      summary: 'Configura una DLQ con `maxReceiveCount` y comprueba cómo un mensaje fallido acaba aislado en ella.',
      difficulty: 'Media',
      minutes: 18,
      saa: [SAA_DOMAINS[2]],
      tags: ['SQS', 'DLQ', 'Resiliencia'],
      scenario: 'Un mensaje defectuoso bloquea el procesamiento de pedidos porque se reintenta eternamente. Crea la cola `pedidos-dlq` y la cola `pedidos` con una política de redirección hacia la DLQ con `maxReceiveCount` = 2. Envía el mensaje `pedido-1001` y recíbelo tres veces **sin borrarlo** (usa `--visibility-timeout 0` para no esperar): en la tercera recepción SQS debe haberlo movido a la DLQ. Inspecciona la DLQ guardando en `~/dlq.json` lo que contiene.',
      steps: [
        { id: 'queues', title: 'Crea las colas `pedidos-dlq` y `pedidos`', hint: ['aws sqs create-queue --queue-name pedidos-dlq', 'La cola principal necesita el atributo RedrivePolicy: pásalo con --attributes file://redrive.json'], check: (c) => (!!queue(c, 'pedidos-dlq') && !!queue(c, 'pedidos')) || 'Faltan las colas pedidos y/o pedidos-dlq.' },
        { id: 'redrive', title: 'Configura en `pedidos` la `RedrivePolicy` hacia la DLQ con `maxReceiveCount` 2', hint: ['El JSON es {"deadLetterTargetArn":"<arn>","maxReceiveCount":"2"} dentro del atributo RedrivePolicy (como texto).', 'ARN de la DLQ: aws sqs get-queue-attributes --queue-url <url> --attribute-names QueueArn'], check: (c) => { const q = queue(c, 'pedidos'); const d = queue(c, 'pedidos-dlq'); if (!q || !d) return 'Crea primero las dos colas.'; if (!q.attrs.RedrivePolicy) return 'La cola pedidos no tiene RedrivePolicy.'; const r = JSON.parse(q.attrs.RedrivePolicy); if (r.deadLetterTargetArn !== d.arn) return 'La RedrivePolicy debe apuntar a la ARN de pedidos-dlq.'; return Number(r.maxReceiveCount) === 2 || 'maxReceiveCount debe ser 2.'; } },
        { id: 'moved', title: 'Envía `pedido-1001`, recíbelo 3 veces sin borrarlo y verifica que ha pasado a la DLQ', hint: ['aws sqs send-message --queue-url <url> --message-body pedido-1001', 'aws sqs receive-message --queue-url <url> --visibility-timeout 0 (repítelo)', 'En la tercera recepción la cola principal ya no devuelve nada.'], check: (c) => { const q = queue(c, 'pedidos'); const d = queue(c, 'pedidos-dlq'); if (!q || !d) return 'Crea las colas.'; if (!d.messages.some((m) => m.body === 'pedido-1001')) return 'pedido-1001 todavía no está en la DLQ: debe superar maxReceiveCount recepciones.'; return q.messages.length === 0 || 'La cola principal aún tiene mensajes.'; } },
        { id: 'inspect', title: 'Guarda en `~/dlq.json` el contenido de la DLQ (`receive-message`)', hint: ['aws sqs receive-message --queue-url <url-de-la-dlq> > ~/dlq.json'], check: (c) => /pedido-1001/.test(c.file('dlq.json') ?? '') || '~/dlq.json debe mostrar el mensaje pedido-1001 recibido de la DLQ.' },
      ],
      script: E5,
      realWorld: 'En una cuenta real configura siempre una DLQ con retención larga (14 días) y una **alarma de CloudWatch** sobre `ApproximateNumberOfMessagesVisible` de la DLQ para enterarte de los fallos. Un `maxReceiveCount` demasiado bajo mueve mensajes sanos si el consumidor es lento: ajusta también el *visibility timeout* (mayor que el tiempo de proceso). Desde la consola puedes «redirigir» los mensajes de la DLQ a la cola original (`start-message-move-task`). Las colas SQS cuestan 0,40 USD por millón de peticiones tras el millón gratuito mensual. **Limpieza:** `aws sqs delete-queue` de ambas colas.',
    },
    {
      id: 'l12-e6',
      title: 'SQS → Lambda → DynamoDB',
      summary: 'Conecta una cola a una función que guarda pedidos en DynamoDB y arregla los permisos del rol.',
      difficulty: 'Difícil',
      minutes: 26,
      saa: [SAA_DOMAINS[2], SAA_DOMAINS[1], SAA_DOMAINS[3]],
      tags: ['SQS', 'Lambda', 'DynamoDB', 'IAM', 'Event source mapping'],
      scenario: 'Los pedidos llegan a la cola `cola-pedidos` y una función `procesador` debe guardarlos en la tabla DynamoDB `pedidos`. La función, la cola y la tabla ya existen, pero el rol `lambda-pedidos` solo puede escribir logs. Dale los permisos para leer de SQS y escribir en DynamoDB, crea el *event source mapping* de la cola a la función (lote de 5) y envía los pedidos 1001, 1002 y 1003 (`{"id":"1001","total":25}`...). Verifica que la tabla contiene los 3 pedidos.',
      setup: E6_SETUP,
      steps: [
        { id: 'sqs-perm', title: 'El rol `lambda-pedidos` puede leer y borrar mensajes de la cola (política `AWSLambdaSQSQueueExecutionRole`)', hint: ['Lambda sondea la cola con el rol de ejecución: necesita sqs:ReceiveMessage, sqs:DeleteMessage y sqs:GetQueueAttributes.', 'aws iam attach-role-policy --role-name lambda-pedidos --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole'], check: (c) => { const q = queue(c, 'cola-pedidos'); if (!q) return 'Falta la cola cola-pedidos.'; return ['ReceiveMessage', 'DeleteMessage', 'GetQueueAttributes'].every((a) => c.decide('lambda-pedidos', 'sqs:' + a, q.arn) === 'Allow') || 'El rol lambda-pedidos aún no puede usar la cola (ReceiveMessage/DeleteMessage/GetQueueAttributes).'; } },
        { id: 'ddb-perm', title: 'El rol puede escribir en la tabla `pedidos` (`dynamodb:PutItem`)', hint: ['Puedes usar AmazonDynamoDBFullAccess para el laboratorio; en producción, una política con PutItem sobre esa tabla.'], check: (c) => { const t = table(c, 'pedidos'); if (!t) return 'Falta la tabla pedidos.'; return c.decide('lambda-pedidos', 'dynamodb:PutItem', t.arn) === 'Allow' || 'El rol aún no puede escribir en la tabla pedidos.'; } },
        { id: 'esm', title: 'Crea el *event source mapping* de `cola-pedidos` a `procesador` con lote de 5', hint: ['aws lambda create-event-source-mapping --function-name procesador --event-source-arn <arn-de-la-cola> --batch-size 5', 'Si falta algún permiso, el propio comando te lo dirá.'], check: (c) => { const q = queue(c, 'cola-pedidos'); const m = S(c).mappings.find((x) => x.functionName === 'procesador' && q && x.eventSourceArn === q.arn); if (!m) return 'No hay ningún mapeo de cola-pedidos a procesador.'; if (!m.enabled) return 'El mapeo está deshabilitado.'; return m.batchSize === 5 || 'El tamaño de lote debe ser 5.'; } },
        { id: 'items', title: 'Envía los pedidos 1001, 1002 y 1003 y comprueba que la tabla `pedidos` tiene los 3', hint: ['aws sqs send-message --queue-url <url> --message-body \'{"id":"1001","total":25}\'', 'aws dynamodb scan --table-name pedidos --query Count', 'Si no aparecen, mira los logs en /aws/lambda/procesador.'], check: (c) => { const t = table(c, 'pedidos'); const ids = new Set((t?.items ?? []).map((i) => i.id?.S)); return ['1001', '1002', '1003'].every((x) => ids.has(x)) || `La tabla tiene ${ids.size} de los 3 pedidos.`; } },
      ],
      script: E6,
      realWorld: 'En producción añade `ReportBatchItemFailures` (la función devuelve solo los mensajes fallidos para no reintentar todo el lote), una DLQ en la cola de origen y haz el consumidor **idempotente** (SQS estándar entrega al menos una vez; usa escrituras condicionales en DynamoDB). El *visibility timeout* de la cola debe ser al menos 6 veces el timeout de la función según las recomendaciones de AWS. Controla la concurrencia con `--scaling-config MaximumConcurrency` para no saturar la base de datos. **Limpieza:** `aws lambda delete-event-source-mapping --uuid <id>`, `aws lambda delete-function --function-name procesador`, `aws sqs delete-queue` y `aws dynamodb delete-table --table-name pedidos`.',
    },
    {
      id: 'l12-e7',
      title: 'DynamoDB: modelar por clave y consultar',
      summary: 'Diseña una tabla con clave compuesta, consulta por cliente y evita sobrescrituras con condiciones.',
      difficulty: 'Media',
      minutes: 18,
      saa: [SAA_DOMAINS[3], SAA_DOMAINS[4]],
      tags: ['DynamoDB', 'NoSQL', 'Claves'],
      scenario: 'La tienda quiere listar rápidamente los pedidos de cada cliente. Crea la tabla `tienda-pedidos` con clave de partición `cliente` (S) y clave de ordenación `pedido` (S) en modo bajo demanda, espera a que esté activa e inserta 4 pedidos (3 de `ana`: p-001, p-002, p-003 y uno de `luis`: p-004). Consulta con `query` los pedidos de `ana` guardando el resultado en `~/ana.json` y comprueba que un `put-item` condicional (`attribute_not_exists`) no puede sobrescribir un pedido existente.',
      steps: [
        { id: 'table', title: 'Crea `tienda-pedidos` (partición `cliente`, ordenación `pedido`, bajo demanda) y espera a que esté `ACTIVE`', hint: ['aws dynamodb create-table --table-name tienda-pedidos --attribute-definitions ... --key-schema AttributeName=cliente,KeyType=HASH AttributeName=pedido,KeyType=RANGE --billing-mode PAY_PER_REQUEST', 'aws dynamodb wait table-exists --table-name tienda-pedidos'], check: (c) => { const t = table(c, 'tienda-pedidos'); if (!t) return 'No existe la tabla tienda-pedidos.'; const h = t.keySchema.find((k) => k.KeyType === 'HASH')?.AttributeName; const r = t.keySchema.find((k) => k.KeyType === 'RANGE')?.AttributeName; if (h !== 'cliente' || r !== 'pedido') return 'La clave debe ser cliente (partición) + pedido (ordenación).'; if (t.billingMode !== 'PAY_PER_REQUEST') return 'Usa el modo bajo demanda (PAY_PER_REQUEST).'; return tableStatus(t) === 'ACTIVE' || 'La tabla aún se está creando: espera con aws dynamodb wait table-exists.'; } },
        { id: 'items', title: 'Inserta 4 pedidos: `p-001`, `p-002`, `p-003` de `ana` y `p-004` de `luis`', hint: ['aws dynamodb put-item --table-name tienda-pedidos --item \'{"cliente":{"S":"ana"},"pedido":{"S":"p-001"},"total":{"N":"25"}}\'', 'Los números se escriben como texto dentro de {"N":"25"}.'], check: (c) => { const t = table(c, 'tienda-pedidos'); const n = (t?.items ?? []).filter((i) => i.cliente?.S === 'ana').length; return (t?.items.length === 4 && n === 3) || `La tabla debe tener 4 pedidos (3 de ana); ahora hay ${t?.items.length ?? 0}.`; } },
        { id: 'query', title: 'Guarda en `~/ana.json` la consulta de los pedidos de `ana` (`Count` = 3)', hint: ['aws dynamodb query --table-name tienda-pedidos --key-condition-expression "cliente = :c" --expression-attribute-values \'{":c":{"S":"ana"}}\' > ~/ana.json', 'query lee solo la partición indicada; scan leería toda la tabla.'], check: (c) => { try { const j = JSON.parse(c.file('ana.json') ?? ''); return j.Count === 3 || `~/ana.json debe tener Count = 3 (tiene ${j.Count}).`; } catch { return '~/ana.json debe contener la salida JSON de aws dynamodb query.'; } } },
        { id: 'cond', title: 'Intenta de nuevo `put-item` de `p-001` con `attribute_not_exists(pedido)` y comprueba que falla', hint: ['aws dynamodb put-item ... --condition-expression "attribute_not_exists(pedido)"', 'Verás ConditionalCheckFailedException: el pedido original queda intacto.'], check: (c) => c.trail('PutItem', { error: 'ConditionalCheckFailedException' }).length > 0 || 'Aún no has provocado un ConditionalCheckFailedException con un put-item condicional.' },
      ],
      script: E7,
      realWorld: 'En DynamoDB real el diseño empieza por los **patrones de acceso**: elige claves que repartan el tráfico (una clave de partición «caliente» limita el rendimiento) y usa `query`, no `scan`. El modo bajo demanda cobra por petición (ideal para tráfico impredecible); el aprovisionado con *auto scaling* es más barato con carga estable. Activa **recuperación a un punto en el tiempo** y **TTL** según el caso. Las escrituras condicionales son la base de la idempotencia y de los contadores atómicos (`UpdateExpression: ADD`). **Limpieza:** `aws dynamodb delete-table --table-name tienda-pedidos`.',
    },
    {
      id: 'l12-e8',
      title: 'RDS Multi-AZ y seguridad de red',
      summary: 'Crea MySQL Multi-AZ privado, ábrelo solo a la aplicación, haz una instantánea y fuerza una conmutación.',
      difficulty: 'Difícil',
      minutes: 28,
      saa: [SAA_DOMAINS[1], SAA_DOMAINS[2], SAA_DOMAINS[3]],
      tags: ['RDS', 'Multi-AZ', 'VPC', 'Seguridad', 'Snapshots'],
      scenario: 'La tienda necesita una base de datos MySQL altamente disponible. Con los grupos de seguridad `app-sg` y `db-sg` ya creados en la VPC predeterminada: permite el puerto 3306 en `db-sg` **solo desde `app-sg`**, crea la instancia `tienda-db` (`db.t3.micro`, MySQL, 20 GiB, **Multi-AZ**, **sin acceso público**, con `db-sg`), espera a que esté `available`, toma la instantánea `tienda-db-antes`, guarda la zona de disponibilidad actual en `~/az-antes.txt`, fuerza una **conmutación por error** con `reboot --force-failover` y guarda la nueva zona en `~/az-despues.txt`.',
      setup: async (sh) => { await prep(sh, E8_SETUP); },
      steps: [
        { id: 'sg', title: 'Abre el puerto 3306 de `db-sg` solo al grupo `app-sg` (nunca a `0.0.0.0/0`)', hint: ['aws ec2 authorize-security-group-ingress --group-id <db-sg> --protocol tcp --port 3306 --source-group <app-sg>', 'Para obtener los ids: aws ec2 describe-security-groups --filters Name=group-name,Values=db-sg'], check: (c) => { const app = c.sg('app-sg'); const d = c.sg('db-sg'); if (!app || !d) return 'Faltan los grupos de seguridad app-sg y db-sg.'; if (d.ingress.some((r) => r.cidr === '0.0.0.0/0' && r.from <= 3306 && r.to >= 3306)) return 'db-sg no debe abrir 3306 a todo internet.'; return d.ingress.some((r) => r.sourceSg === app.id && r.from <= 3306 && r.to >= 3306) || 'db-sg aún no permite 3306 desde app-sg.'; } },
        { id: 'db', title: 'Crea `tienda-db` (MySQL, Multi-AZ, privada, con `db-sg`) y espera a que esté `available`', hint: ['aws rds create-db-instance --db-instance-identifier tienda-db --db-instance-class db.t3.micro --engine mysql --master-username admin --master-user-password <contraseña> --allocated-storage 20 --multi-az --no-publicly-accessible --vpc-security-group-ids <db-sg>', 'aws rds wait db-instance-available --db-instance-identifier tienda-db'], check: (c) => { const d = db(c, 'tienda-db'); if (!d) return 'No existe la instancia tienda-db.'; if (d.engine !== 'mysql') return 'El motor debe ser MySQL.'; if (!d.multiAz) return 'La instancia debe ser Multi-AZ.'; if (d.publiclyAccessible) return 'La instancia no debe ser accesible públicamente.'; if (!d.sgIds.includes(c.sg('db-sg')?.id ?? '')) return 'La instancia debe usar el grupo de seguridad db-sg.'; return rdsStatus(d) === 'available' || `La instancia está ${rdsStatus(d)}: espera con aws rds wait.`; } },
        { id: 'snap', title: 'Toma la instantánea `tienda-db-antes` y espera a que esté `available`', hint: ['aws rds create-db-snapshot --db-instance-identifier tienda-db --db-snapshot-identifier tienda-db-antes', 'aws rds wait db-snapshot-available --db-snapshot-identifier tienda-db-antes'], check: (c) => { const x = S(c).rdsSnapshots.find((y) => y.id === 'tienda-db-antes'); if (!x) return 'No existe la instantánea tienda-db-antes.'; return snapshotStatus(x) === 'available' || 'La instantánea aún se está creando.'; } },
        { id: 'failover', title: 'Fuerza la conmutación por error y guarda la zona antes y después (`~/az-antes.txt`, `~/az-despues.txt`): deben ser distintas', hint: ['aws rds describe-db-instances ... --query DBInstances[0].AvailabilityZone --output text > ~/az-antes.txt', 'aws rds reboot-db-instance --db-instance-identifier tienda-db --force-failover', 'Espera a available y vuelve a consultar la zona.'], check: (c) => { const a = (c.file('az-antes.txt') ?? '').trim(); const b = (c.file('az-despues.txt') ?? '').trim(); if (!a || !b) return 'Guarda la zona antes y después de la conmutación en ~/az-antes.txt y ~/az-despues.txt.'; if (a === b) return 'La zona no ha cambiado: ¿hiciste la conmutación (--force-failover) y esperaste a que terminara?'; return S(c).rdsEvents.some((e) => e.sourceId === 'tienda-db' && /failover completed/i.test(e.message)) || 'RDS no registra ninguna conmutación por error completada.'; } },
      ],
      script: E8,
      realWorld: 'Una instancia Multi-AZ real tarda 15-25 minutos en crearse y cuesta **el doble** (hay dos instancias): crea esto solo cuando lo necesites. La conmutación por error real tarda 60-120 s y el punto de enlace DNS no cambia, pero tu aplicación debe reconectar (usa el nombre DNS y *timeouts* razonables, nunca la IP). Guarda la contraseña en Secrets Manager (`--manage-master-user-password`), activa cifrado en el momento de crear la instancia (no se puede añadir después) y la retención de copias (7-35 días). Multi-AZ protege la disponibilidad; para escalar lecturas usa réplicas de lectura. **Limpieza:** `aws rds delete-db-instance --db-instance-identifier tienda-db --skip-final-snapshot`, `aws rds delete-db-snapshot --db-snapshot-identifier tienda-db-antes` y los grupos de seguridad.',
    },
  ],
  quiz: [
    { domain: 1, q: 'Tu función Lambda se ejecuta pero no aparece ningún grupo de logs en CloudWatch. ¿Cuál es la causa MÁS probable?', options: ['El rol de ejecución no tiene permisos logs:CreateLogGroup, CreateLogStream y PutLogEvents', 'La función no tiene política basada en recursos', 'El tiempo de ejecución es demasiado antiguo', 'Falta una VPC'], answer: 0, explain: 'Lambda escribe los logs con el rol de ejecución. Sin AWSLambdaBasicExecutionRole (o permisos equivalentes) la función funciona, pero no deja registros.' },
    { domain: 2, q: 'Necesitas desplegar una nueva versión de una función con la posibilidad de volver atrás al instante y que los clientes no cambien. ¿Qué haces?', options: ['Publicar una versión y mover un alias (`prod`) hacia ella; el rollback es moverlo de vuelta', 'Editar $LATEST y esperar', 'Crear una función nueva con otro nombre y avisar a los clientes', 'Borrar la función y volver a crearla'], answer: 0, explain: 'Las versiones publicadas son inmutables y un alias es un puntero con nombre que puedes mover (incluso con ponderación) sin cambiar a los llamadores.' },
    { domain: 2, q: 'Una API HTTP de API Gateway con integración Lambda responde 500 Internal Server Error, aunque la función funciona al invocarla directamente. ¿Qué falta con más probabilidad?', options: ['Una política basada en recursos en la función que permita a apigateway.amazonaws.com invocarla', 'Aumentar la memoria de la función', 'Un grupo de seguridad en la API', 'Activar el cifrado de la etapa'], answer: 0, explain: 'API Gateway invoca la función con su propio principal de servicio; sin `lambda add-permission` con el ARN de origen de la API, la invocación se rechaza y el cliente ve un 500.' },
    { domain: 2, q: 'Un consumidor falla con un mensaje concreto y SQS lo entrega una y otra vez, retrasando al resto. ¿Cómo lo aíslas sin perderlo?', options: ['Configuras una cola de mensajes fallidos (DLQ) con maxReceiveCount', 'Subes el tiempo de retención a 14 días', 'Conviertes la cola en FIFO', 'Reduces el visibility timeout a 0'], answer: 0, explain: 'Con una redrive policy, tras N recepciones SQS mueve el mensaje a la DLQ, donde puedes analizarlo mientras la cola principal sigue fluyendo.' },
    { domain: 3, q: 'Tu consumidor de SQS tarda unos 60 s en procesar cada mensaje y a veces se procesan dos veces. ¿Qué ajuste lo corrige?', options: ['Un visibility timeout mayor que el tiempo de proceso (y un consumidor idempotente)', 'Usar long polling con 0 s', 'Reducir el tamaño del mensaje', 'Cambiar a SNS'], answer: 0, explain: 'Si el mensaje reaparece antes de que se borre, otro consumidor lo recibe. El visibility timeout debe superar el tiempo de proceso; además SQS estándar es «al menos una vez», así que hay que ser idempotente.' },
    { domain: 3, q: 'Necesitas procesar pedidos en orden estricto por cliente sin duplicados en 5 minutos. ¿Qué cola eliges?', options: ['SQS FIFO con MessageGroupId = cliente y deduplicación', 'SQS estándar', 'Un tema SNS estándar', 'Una función Lambda con concurrencia reservada 1'], answer: 0, explain: 'FIFO garantiza el orden dentro de cada grupo de mensajes y deduplica durante 5 minutos; la cola estándar solo ofrece orden aproximado.' },
    { domain: 2, q: 'Quieres que un mensaje publicado se entregue a tres equipos, cada uno con su propia cola y ritmo de proceso. ¿Qué patrón usas?', options: ['Un tema SNS con tres colas SQS suscritas (fan-out)', 'Una sola cola con tres consumidores', 'Tres funciones Lambda llamándose entre sí', 'Un bucket S3 con notificaciones'], answer: 0, explain: 'SNS reparte una copia a cada suscriptor; cada cola absorbe picos y permite reintentos independientes. La política de cada cola debe permitir a sns.amazonaws.com SendMessage.' },
    { domain: 3, q: '¿Cuál es el acceso MÁS eficiente para obtener todos los pedidos de un cliente en DynamoDB con clave de partición `cliente`?', options: ['Query con la clave de partición', 'Scan con un filtro', 'GetItem repetido', 'Exportar la tabla a S3'], answer: 0, explain: 'Query lee solo los elementos de una partición. Scan recorre toda la tabla y se factura por todo lo leído, aunque el filtro descarte la mayoría.' },
    { domain: 4, q: 'El tráfico de tu aplicación es impredecible y con picos esporádicos; no quieres gestionar capacidad. ¿Qué modo de DynamoDB eliges?', options: ['Bajo demanda (PAY_PER_REQUEST)', 'Aprovisionado con 1000 RCU fijas', 'Aprovisionado con reserva de capacidad a 3 años', 'DynamoDB no tiene modos'], answer: 0, explain: 'El modo bajo demanda cobra por petición y escala solo; el aprovisionado compensa cuando el tráfico es estable y predecible.' },
    { domain: 1, q: 'Una instancia de RDS solo debe ser accesible desde los servidores de la aplicación. ¿Cuál es la configuración correcta?', options: ['No pública, y un grupo de seguridad que permita el puerto del motor solo desde el grupo de seguridad de la aplicación', 'Pública con 0.0.0.0/0 en el puerto 3306', 'Pública con la IP de cada desarrollador', 'Quitar el grupo de seguridad'], answer: 0, explain: 'Referenciar el grupo de seguridad de origen (en vez de una IP/CIDR) es la práctica recomendada: sigue a las instancias aunque cambien de IP, y la base de datos no es alcanzable desde internet.' },
    { domain: 2, q: 'Quieres que tu base de datos MySQL sobreviva al fallo de una zona de disponibilidad con la menor intervención posible. ¿Qué habilitas?', options: ['Multi-AZ', 'Una réplica de lectura en la misma zona', 'Copias automáticas con retención 0', 'Cifrado con KMS'], answer: 0, explain: 'Multi-AZ mantiene una réplica síncrona en otra zona y conmuta automáticamente al mismo punto de enlace DNS. Las réplicas de lectura son asíncronas y sirven para escalar lecturas.' },
    { domain: 4, q: 'Quieres conservar una copia de una instancia de RDS que vas a eliminar y poder recrearla más adelante pagando lo mínimo. ¿Qué haces?', options: ['Crear una instantánea final (o manual) y eliminar la instancia; restaurar crea una instancia nueva', 'Detener la instancia indefinidamente', 'Dejarla en Multi-AZ', 'Restaurar la instantánea sobre la misma instancia'], answer: 0, explain: 'Las instantáneas cuestan solo almacenamiento; una instancia detenida se reinicia sola a los 7 días. Restaurar siempre crea una instancia nueva con otro punto de enlace.' },
  ],
};

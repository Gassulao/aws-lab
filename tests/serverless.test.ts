import { describe, it, expect, beforeEach } from 'vitest';
import { freshState } from '../src/engine/store';
import { newShell, execLine, type Shell } from '../src/shell';
import type { CloudState } from '../src/engine/types';
import { Interp, parse } from '../src/engine/serverless/js';
import { md5 } from '../src/engine/serverless/util';
import { setClock } from '../src/engine/util';

let st: CloudState;
let sh: Shell;
const run = async (line: string) => { const r = await execLine(sh, line, 'typed'); return { ...r, all: r.out + r.err }; };
const ok = async (line: string) => { const r = await run(line); expect(r.code, `${line}\n${r.err}`).toBe(0); return r.out; };
const bad = async (line: string, re: RegExp | string) => { const r = await run(line); expect(r.code, line).not.toBe(0); expect(r.err).toMatch(re); return r.err; };
const json = async (line: string) => JSON.parse(await ok(line));
const trust = (svc: string) => `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"${svc}"},"Action":"sts:AssumeRole"}]}`;
const role = async (name: string, svc: string, pols: string[]) => {
  sh.fs.writeFile(`/tmp/${name}.json`, trust(svc));
  await ok(`aws iam create-role --role-name ${name} --assume-role-policy-document file:///tmp/${name}.json`);
  for (const p of pols) await ok(`aws iam attach-role-policy --role-name ${name} --policy-arn arn:aws:iam::aws:policy/${p}`);
};
const ROLE = () => `arn:aws:iam::${st.account.id}:role/lambda-role`;
const fn = async (name: string, code: string, extra = '', rl = 'lambda-role') => {
  sh.fs.writeFile(`/tmp/${name}.js`, code);
  await ok(`cd /tmp && zip ${name}.zip ${name}.js`);
  const handler = `${name}.handler`;
  await ok(`aws lambda create-function --function-name ${name} --runtime nodejs20.x --handler ${handler} --role arn:aws:iam::${st.account.id}:role/${rl} --zip-file fileb:///tmp/${name}.zip ${extra}`);
  await ok(`aws lambda wait function-active-v2 --function-name ${name}`);
};
const invoke = async (name: string, payload = '{}', extra = '') => {
  const r = await json(`aws lambda invoke --function-name ${name} --cli-binary-format raw-in-base64-out --payload '${payload}' ${extra} /tmp/out.json`);
  return { meta: r, body: sh.fs.readFile('/tmp/out.json') };
};
const logs = (name: string) => {
  const g = st.logGroups.find((x) => x.name === `/aws/lambda/${name}`);
  return g ? g.streams.flatMap((s: any) => s.events.map((e: any) => e.message)).join('') : '';
};

beforeEach(async () => {
  st = freshState('Ana');
  st.settings.speed = 'instant';
  sh = newShell(st);
  sh.fs.mkdir('/tmp', true);
  await role('lambda-role', 'lambda.amazonaws.com', ['service-role/AWSLambdaBasicExecutionRole']);
});

describe('intérprete JS y md5', () => {
  it('md5 coincide con el valor real', () => {
    expect(md5('hello')).toBe('5d41402abc4b2a76b9719d911017c592');
  });
  it('evalúa un subconjunto amplio de JS', async () => {
    const code = [
      'const f = (a, b) => a * b + 1;',
      'const { x, ...rest } = { x: 1, y: 2, z: 3 };',
      'exports.handler = async (event) => {',
      '  let t = 0; for (const n of [1, 2, 3]) { t += f(n, 2); }',
      '  const m = [1,2,3,4].filter((v) => v % 2 === 0).map((v) => v * 10);',
      '  let r; try { null.foo; } catch (e) { r = e.name; }',
      '  switch (event.k) { case "a": t += 100; break; default: t += 1; }',
      '  return { t, s: `v${t}`, m, rest, r, j: JSON.stringify({ a: [1] }) };',
      '};',
    ].join('\n');
    await fn('interp', code);
    const r = JSON.parse((await invoke('interp', '{"k":"a"}')).body);
    expect(r).toEqual({ t: 115, s: 'v115', m: [20, 40], rest: { y: 2, z: 3 }, r: 'TypeError', j: '{"a":[1]}' });
  });
  it('no permite escapar del sandbox', async () => {
    await fn('esc', 'exports.handler = async () => ({}).constructor.constructor("return 1")();');
    const r = await invoke('esc');
    expect(r.meta.FunctionError).toBe('Unhandled');
  });
});

describe('Lambda', () => {
  it('invoca, devuelve el resultado y escribe logs en CloudWatch', async () => {
    await fn('hola', 'exports.handler = async (event) => { console.log("hola", event.name); return { statusCode: 200, body: "Hola " + event.name }; };');
    const r = await invoke('hola', '{"name":"Ana"}');
    expect(r.meta.StatusCode).toBe(200);
    expect(JSON.parse(r.body).body).toBe('Hola Ana');
    const l = logs('hola');
    expect(l).toContain('START RequestId');
    expect(l).toContain('hola Ana');
    expect(l).toContain('REPORT RequestId');
  });

  it('sin permisos de logs en el rol no hay grupo de logs', async () => {
    await role('sin-logs', 'lambda.amazonaws.com', []);
    await fn('mudo', 'exports.handler = async () => { console.log("x"); return 1; };', '', 'sin-logs');
    await invoke('mudo');
    expect(st.logGroups.find((x) => x.name === '/aws/lambda/mudo')).toBeUndefined();
  });

  it('errores de la función: FunctionError y variables de entorno', async () => {
    await fn('falla', 'exports.handler = async () => { throw new Error("boom " + process.env.MODO); };', '--environment Variables={MODO=prueba}');
    const r = await invoke('falla');
    expect(r.meta.FunctionError).toBe('Unhandled');
    expect(JSON.parse(r.body).errorMessage).toBe('boom prueba');
  });

  it('timeout', async () => {
    await fn('lenta', 'exports.handler = async () => { await sleep(5000); return 1; };', '--timeout 1');
    const r = await invoke('lenta');
    expect(r.meta.FunctionError).toBe('Unhandled');
    expect(r.body).toMatch(/Task timed out after 1\.00 seconds/);
  });

  it('versiones y alias', async () => {
    await fn('v', 'exports.handler = async () => "uno";');
    const v1 = await json('aws lambda publish-version --function-name v');
    expect(v1.Version).toBe('1');
    sh.fs.writeFile('/tmp/v.js', 'exports.handler = async () => "dos";');
    await ok('cd /tmp && zip v.zip v.js');
    await ok('aws lambda update-function-code --function-name v --zip-file fileb:///tmp/v.zip');
    await ok('aws lambda publish-version --function-name v');
    await ok('aws lambda create-alias --function-name v --name prod --function-version 1');
    expect((await invoke('v:prod')).body).toBe('"uno"');
    await ok('aws lambda update-alias --function-name v --name prod --function-version 2');
    expect((await invoke('v:prod')).body).toBe('"dos"');
  });

  it('no existe la función', async () => {
    await bad('aws lambda invoke --function-name nada /tmp/o.json', /ResourceNotFoundException/);
  });
});

describe('SQS', () => {
  it('cola estándar: enviar, recibir, visibilidad y borrar', async () => {
    const q = (await json('aws sqs create-queue --queue-name pedidos')).QueueUrl as string;
    expect(q).toContain('/pedidos');
    const s = await json(`aws sqs send-message --queue-url ${q} --message-body hola`);
    expect(s.MD5OfMessageBody).toBe(md5('hola'));
    const r = await json(`aws sqs receive-message --queue-url ${q}`);
    expect(r.Messages[0].Body).toBe('hola');
    // invisible mientras dure la visibilidad
    const again = await run(`aws sqs receive-message --queue-url ${q}`);
    expect(again.out.trim()).toBe('');
    await ok(`aws sqs delete-message --queue-url ${q} --receipt-handle '${r.Messages[0].ReceiptHandle}'`);
    const a = await json(`aws sqs get-queue-attributes --queue-url ${q} --attribute-names All`);
    expect(a.Attributes.ApproximateNumberOfMessages).toBe('0');
  });

  it('FIFO exige grupo', async () => {
    const q = (await json('aws sqs create-queue --queue-name f.fifo --attributes FifoQueue=true,ContentBasedDeduplication=true')).QueueUrl as string;
    await bad(`aws sqs send-message --queue-url ${q} --message-body x`, /MessageGroupId/);
    const r = await json(`aws sqs send-message --queue-url ${q} --message-body x --message-group-id g1`);
    expect(r.SequenceNumber).toBeTruthy();
  });

  it('nombre FIFO inválido', async () => {
    await bad('aws sqs create-queue --queue-name f --attributes FifoQueue=true', /InvalidParameterValue/);
  });
});

describe('Lambda + SQS (event source mapping, DLQ)', () => {
  let T = 1_800_000_000_000;
  beforeEach(() => { setClock(() => T); });
  const attr = async (q: string, n: string) => (await json(`aws sqs get-queue-attributes --queue-url ${q} --attribute-names ${n}`)).Attributes[n];
  const adv = async (ms: number, q: string) => { T += ms; await attr(q, 'QueueArn'); };

  it('procesa mensajes y envía los que fallan a la DLQ tras maxReceiveCount', async () => {
    await role('sqs-role', 'lambda.amazonaws.com', ['service-role/AWSLambdaSQSQueueExecutionRole']);
    const dlq = (await json('aws sqs create-queue --queue-name dlq')).QueueUrl as string;
    const dlqArn = await attr(dlq, 'QueueArn');
    const attrs = JSON.stringify({ VisibilityTimeout: '5', RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 2 }) });
    sh.fs.writeFile('/tmp/attrs.json', attrs);
    const q = (await json('aws sqs create-queue --queue-name main --attributes file:///tmp/attrs.json')).QueueUrl as string;
    const qArn = await attr(q, 'QueueArn');
    await fn('worker', 'exports.handler = async (e) => { for (const r of e.Records) { if (r.body === "malo") throw new Error("no"); console.log("ok", r.body); } };', '--timeout 3', 'sqs-role');
    await ok(`aws lambda create-event-source-mapping --function-name worker --event-source-arn ${qArn} --batch-size 1`);
    await ok(`aws sqs send-message --queue-url ${q} --message-body bueno`);
    await ok(`aws sqs send-message --queue-url ${q} --message-body malo`);
    for (let i = 0; i < 6; i++) await adv(6000, q);
    expect(logs('worker')).toContain('ok bueno');
    expect(await attr(dlq, 'ApproximateNumberOfMessages')).toBe('1');
    const m = await json(`aws sqs receive-message --queue-url ${dlq}`);
    expect(m.Messages[0].Body).toBe('malo');
    expect(await attr(q, 'ApproximateNumberOfMessages')).toBe('0');
  });

  it('el rol sin permisos SQS impide crear el mapping', async () => {
    const q = (await json('aws sqs create-queue --queue-name q2')).QueueUrl as string;
    const qArn = await attr(q, 'QueueArn');
    await fn('w2', 'exports.handler = async () => 1;');
    await bad(`aws lambda create-event-source-mapping --function-name w2 --event-source-arn ${qArn}`, /execution role does not have permissions/);
  });

  it('visibilidad: el mensaje reaparece al expirar', async () => {
    const q = (await json('aws sqs create-queue --queue-name vis')).QueueUrl as string;
    await ok(`aws sqs send-message --queue-url ${q} --message-body a`);
    await ok(`aws sqs receive-message --queue-url ${q} --visibility-timeout 10`);
    expect((await run(`aws sqs receive-message --queue-url ${q}`)).out.trim()).toBe('');
    T += 11_000;
    expect((await json(`aws sqs receive-message --queue-url ${q}`)).Messages[0].Body).toBe('a');
  });
});

describe('SNS → SQS / Lambda', () => {
  it('sin política en la cola no entrega; con política sí', async () => {
    const q = (await json('aws sqs create-queue --queue-name sub')).QueueUrl as string;
    const qArn = (await json(`aws sqs get-queue-attributes --queue-url ${q} --attribute-names QueueArn`)).Attributes.QueueArn;
    const topic = (await json('aws sns create-topic --name t1')).TopicArn as string;
    await ok(`aws sns subscribe --topic-arn ${topic} --protocol sqs --notification-endpoint ${qArn}`);
    await ok(`aws sns publish --topic-arn ${topic} --message uno`);
    expect((await run(`aws sqs receive-message --queue-url ${q}`)).out.trim()).toBe('');
    const pol = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'sns.amazonaws.com' }, Action: 'sqs:SendMessage', Resource: qArn, Condition: { ArnEquals: { 'aws:SourceArn': topic } } }] };
    sh.fs.writeFile('/tmp/qa.json', JSON.stringify({ Policy: JSON.stringify(pol) }));
    await ok(`aws sqs set-queue-attributes --queue-url ${q} --attributes file:///tmp/qa.json`);
    await ok(`aws sns publish --topic-arn ${topic} --message dos`);
    const m = await json(`aws sqs receive-message --queue-url ${q}`);
    expect(JSON.parse(m.Messages[0].Body).Message).toBe('dos');
  });

  it('suscripción Lambda con permiso invoca la función', async () => {
    await fn('sub', 'exports.handler = async (e) => { console.log("SNS:", e.Records[0].Sns.Message); };');
    const topic = (await json('aws sns create-topic --name t2')).TopicArn as string;
    await ok(`aws lambda add-permission --function-name sub --statement-id sns --action lambda:InvokeFunction --principal sns.amazonaws.com --source-arn ${topic}`);
    await ok(`aws sns subscribe --topic-arn ${topic} --protocol lambda --notification-endpoint arn:aws:lambda:eu-west-1:${st.account.id}:function:sub`);
    await ok(`aws sns publish --topic-arn ${topic} --message hola`);
    expect(logs('sub')).toContain('SNS: hola');
  });
});

describe('API Gateway + curl', () => {
  it('API HTTP con integración Lambda responde por curl; sin permiso da 500', async () => {
    await fn('web', 'exports.handler = async (e) => ({ statusCode: 200, headers: {"content-type":"text/plain"}, body: "ruta " + e.rawPath });');
    const arn = `arn:aws:lambda:eu-west-1:${st.account.id}:function:web`;
    const api = await json(`aws apigatewayv2 create-api --name a --protocol-type HTTP --target ${arn}`);
    const url = `${api.ApiEndpoint}/hola`;
    const fail = await run(`curl -s -i ${url}`);
    expect(fail.out).toMatch(/500|Internal/);
    await ok(`aws lambda add-permission --function-name web --statement-id apigw --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:eu-west-1:${st.account.id}:${api.ApiId}/*"`);
    const good = await ok(`curl -s ${url}`);
    expect(good).toContain('ruta /hola');
  });
});

describe('DynamoDB', () => {
  it('tablas, put/get/query/scan', async () => {
    await ok('aws dynamodb create-table --table-name tabla --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE --billing-mode PAY_PER_REQUEST');
    await ok('aws dynamodb wait table-exists --table-name tabla');
    await ok(`aws dynamodb put-item --table-name tabla --item '{"pk":{"S":"a"},"sk":{"S":"1"},"n":{"N":"5"}}'`);
    await ok(`aws dynamodb put-item --table-name tabla --item '{"pk":{"S":"a"},"sk":{"S":"2"},"n":{"N":"7"}}'`);
    const g = await json(`aws dynamodb get-item --table-name tabla --key '{"pk":{"S":"a"},"sk":{"S":"1"}}'`);
    expect(g.Item.n.N).toBe('5');
    const q = await json(`aws dynamodb query --table-name tabla --key-condition-expression "pk = :p" --expression-attribute-values '{":p":{"S":"a"}}'`);
    expect(q.Count).toBe(2);
    const sc = await json(`aws dynamodb scan --table-name tabla --filter-expression "n > :v" --expression-attribute-values '{":v":{"N":"5"}}'`);
    expect(sc.Count).toBe(1);
    await bad(`aws dynamodb put-item --table-name tabla --item '{"pk":{"S":"a"},"sk":{"S":"1"}}' --condition-expression "attribute_not_exists(pk)"`, /ConditionalCheckFailedException/);
  });
});

describe('RDS', () => {
  it('ciclo de vida, snapshot y failover', async () => {
    const c = await json('aws rds create-db-instance --db-instance-identifier db1 --db-instance-class db.t3.micro --engine mysql --master-username admin --master-user-password Secret12345 --allocated-storage 20 --multi-az');
    expect(c.DBInstance.DBInstanceIdentifier).toBe('db1');
    await ok('aws rds wait db-instance-available --db-instance-identifier db1');
    const d = await json('aws rds describe-db-instances --db-instance-identifier db1');
    expect(d.DBInstances[0].DBInstanceStatus).toBe('available');
    const az = d.DBInstances[0].AvailabilityZone;
    await ok('aws rds reboot-db-instance --db-instance-identifier db1 --force-failover');
    await ok('aws rds wait db-instance-available --db-instance-identifier db1');
    const d2 = await json('aws rds describe-db-instances --db-instance-identifier db1');
    expect(d2.DBInstances[0].AvailabilityZone).not.toBe(az);
    await ok('aws rds create-db-snapshot --db-instance-identifier db1 --db-snapshot-identifier s1');
    await ok('aws rds wait db-snapshot-available --db-snapshot-identifier s1');
    await bad('aws rds delete-db-instance --db-instance-identifier db1', /final|snapshot/i);
    await ok('aws rds delete-db-instance --db-instance-identifier db1 --skip-final-snapshot');
    await ok('aws rds wait db-instance-deleted --db-instance-identifier db1');
  });
  it('validaciones', async () => {
    await bad('aws rds create-db-instance --db-instance-identifier db2 --db-instance-class db.t3.micro --engine postgres --master-username admin --master-user-password Secret12345 --allocated-storage 20', /reserved/);
  });
});

describe('SDK v3 dentro de Lambda', () => {
  it('guarda en DynamoDB con client-dynamodb y lib-dynamodb', async () => {
    await role('ddb-role', 'lambda.amazonaws.com', ['service-role/AWSLambdaBasicExecutionRole', 'AmazonDynamoDBFullAccess']);
    await ok('aws dynamodb create-table --table-name notas --attribute-definitions AttributeName=id,AttributeType=S --key-schema AttributeName=id,KeyType=HASH --billing-mode PAY_PER_REQUEST');
    await ok('aws dynamodb wait table-exists --table-name notas');
    const code = [
      'const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");',
      'const { DynamoDBDocumentClient, GetCommand } = require("@aws-sdk/lib-dynamodb");',
      'const c = new DynamoDBClient({});',
      'const d = DynamoDBDocumentClient.from(c);',
      'exports.handler = async (e) => {',
      '  await c.send(new PutItemCommand({ TableName: "notas", Item: { id: { S: e.id }, n: { N: String(e.n) } } }));',
      '  const r = await d.send(new GetCommand({ TableName: "notas", Key: { id: e.id } }));',
      '  return r.Item;',
      '};',
    ].join('\n');
    await fn('sdk', code, '', 'ddb-role');
    const r = await invoke('sdk', '{"id":"a","n":5}');
    expect(JSON.parse(r.body)).toEqual({ id: 'a', n: 5 });
  });

  it('un rol sin permisos recibe AccessDeniedException de DynamoDB', async () => {
    await ok('aws dynamodb create-table --table-name notas --attribute-definitions AttributeName=id,AttributeType=S --key-schema AttributeName=id,KeyType=HASH --billing-mode PAY_PER_REQUEST');
    await ok('aws dynamodb wait table-exists --table-name notas');
    const code = 'const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");\nexports.handler = async () => { try { await new DynamoDBClient({}).send(new PutItemCommand({ TableName: "notas", Item: { id: { S: "x" } } })); } catch (e) { return e.name; } };';
    await fn('deny', code);
    expect((await invoke('deny')).body).toBe('"AccessDeniedException"');
  });
});

describe('API Gateway REST', () => {
  it('recursos, método, integración MOCK, despliegue y curl', async () => {
    const api = await json('aws apigateway create-rest-api --name r');
    const root = (await json(`aws apigateway get-resources --rest-api-id ${api.id}`)).items[0].id;
    const res = await json(`aws apigateway create-resource --rest-api-id ${api.id} --parent-id ${root} --path-part ping`);
    await ok(`aws apigateway put-method --rest-api-id ${api.id} --resource-id ${res.id} --http-method GET --authorization-type NONE`);
    await ok(`aws apigateway put-method-response --rest-api-id ${api.id} --resource-id ${res.id} --http-method GET --status-code 200`);
    await ok(`aws apigateway put-integration --rest-api-id ${api.id} --resource-id ${res.id} --http-method GET --type MOCK --request-templates '{"application/json":"{\\"statusCode\\": 200}"}'`);
    await ok(`aws apigateway put-integration-response --rest-api-id ${api.id} --resource-id ${res.id} --http-method GET --status-code 200 --response-templates '{"application/json":"{\\"pong\\":true}"}'`);
    // sin desplegar no hay etapa
    expect((await run(`curl -s https://${api.id}.execute-api.eu-west-1.amazonaws.com/prod/ping`)).out).toMatch(/Forbidden|Missing/);
    await ok(`aws apigateway create-deployment --rest-api-id ${api.id} --stage-name prod`);
    expect(await ok(`curl -s https://${api.id}.execute-api.eu-west-1.amazonaws.com/prod/ping`)).toContain('pong');
  });
  it('métodos duplicados y despliegue vacío', async () => {
    const api = await json('aws apigateway create-rest-api --name r2');
    await bad(`aws apigateway create-deployment --rest-api-id ${api.id} --stage-name prod`, /BadRequestException/);
  });
});

describe('RDS: instantáneas, restauración y modificaciones', () => {
  it('restaura una instantánea en una instancia nueva y valida los nombres', async () => {
    await ok('aws rds create-db-instance --db-instance-identifier base1 --db-instance-class db.t3.micro --engine postgres --master-username dba --master-user-password Secret12345 --allocated-storage 20');
    await ok('aws rds wait db-instance-available --db-instance-identifier base1');
    await ok('aws rds create-db-snapshot --db-instance-identifier base1 --db-snapshot-identifier snap1');
    await ok('aws rds wait db-snapshot-available --db-snapshot-identifier snap1');
    await ok('aws rds restore-db-instance-from-db-snapshot --db-instance-identifier base2 --db-snapshot-identifier snap1');
    await ok('aws rds wait db-instance-available --db-instance-identifier base2');
    const d = await json('aws rds describe-db-instances --db-instance-identifier base2');
    expect(d.DBInstances[0].Engine).toBe('postgres');
    await bad('aws rds create-db-instance --db-instance-identifier base1 --db-instance-class db.t3.micro --engine postgres --master-username dba --master-user-password Secret12345 --allocated-storage 20', /DBInstanceAlreadyExists/);
    await bad('aws rds describe-db-instances --db-instance-identifier nada', /DBInstanceNotFound/);
    await bad('aws rds create-db-instance --db-instance-identifier x --db-instance-class db.t3.micro --engine mysql --master-username dba --master-user-password corta --allocated-storage 20', /password|Password/);
  });
  it('modify sin apply-immediately deja valores pendientes', async () => {
    await ok('aws rds create-db-instance --db-instance-identifier base3 --db-instance-class db.t3.micro --engine mysql --master-username dba --master-user-password Secret12345 --allocated-storage 20');
    await ok('aws rds wait db-instance-available --db-instance-identifier base3');
    const m = await json('aws rds modify-db-instance --db-instance-identifier base3 --db-instance-class db.t3.small');
    expect(m.DBInstance.PendingModifiedValues.DBInstanceClass).toBe('db.t3.small');
    expect(m.DBInstance.DBInstanceClass).toBe('db.t3.micro');
  });
  it('subnet group exige dos zonas de disponibilidad', async () => {
    const subs = (await json('aws ec2 describe-subnets --query "Subnets[].[SubnetId,AvailabilityZone]"')) as string[][];
    const first = subs[0][0];
    await bad(`aws rds create-db-subnet-group --db-subnet-group-name g1 --db-subnet-group-description d --subnet-ids ${first}`, /DBSubnetGroupDoesNotCoverEnoughAZs/);
    const other = subs.find((x) => x[1] !== subs[0][1])![0];
    await ok(`aws rds create-db-subnet-group --db-subnet-group-name g1 --db-subnet-group-description d --subnet-ids ${first} ${other}`);
  });
});

describe('DynamoDB: expresiones', () => {
  it('update-item, ADD y proyección', async () => {
    await ok('aws dynamodb create-table --table-name contadores --attribute-definitions AttributeName=id,AttributeType=S --key-schema AttributeName=id,KeyType=HASH --billing-mode PAY_PER_REQUEST');
    await ok('aws dynamodb wait table-exists --table-name contadores');
    await ok(`aws dynamodb update-item --table-name contadores --key '{"id":{"S":"c1"}}' --update-expression "ADD visitas :n SET nombre = :x" --expression-attribute-values '{":n":{"N":"2"},":x":{"S":"web"}}'`);
    await ok(`aws dynamodb update-item --table-name contadores --key '{"id":{"S":"c1"}}' --update-expression "ADD visitas :n" --expression-attribute-values '{":n":{"N":"3"}}'`);
    const g = await json(`aws dynamodb get-item --table-name contadores --key '{"id":{"S":"c1"}}'`);
    expect(g.Item.visitas.N).toBe('5');
    expect(g.Item.nombre.S).toBe('web');
    await bad(`aws dynamodb get-item --table-name nada --key '{"id":{"S":"c1"}}'`, /ResourceNotFoundException/);
  });
});

describe('CloudTrail', () => {
  it('registra eventos de Lambda y SQS', async () => {
    await ok('aws sqs create-queue --queue-name x');
    const ev = st.trail.map((e: any) => e.eventName);
    expect(ev).toContain('CreateQueue');
  });
});

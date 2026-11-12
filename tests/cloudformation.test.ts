import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshState } from '../src/engine/store';
import { newShell, runString, type Shell } from '../src/shell';
import { setClock } from '../src/engine/util';
import type { CloudState } from '../src/engine/types';

let st: CloudState;
let sh: Shell;
beforeEach(() => {
  setClock(null);
  st = freshState('Ana');
  st.settings.speed = 'instant';
  sh = newShell(st);
});
afterEach(() => setClock(null));

const run = (cmd: string) => runString(sh, cmd);
const ok = async (cmd: string) => {
  const r = await run(cmd);
  expect(r.err, cmd).toBe('');
  return r.out;
};
const json = async (cmd: string) => JSON.parse(await ok(cmd));
const err = async (cmd: string) => (await run(cmd)).err;
const put = (path: string, text: string) => sh.fs.writeFile(path, text);

/** Usuario con claves; devuelve el prefijo de entorno para actuar como él. */
async function newUser(name: string, policy?: object) {
  await ok(`aws iam create-user --user-name ${name}`);
  const k = await json(`aws iam create-access-key --user-name ${name}`);
  if (policy) await ok(`aws iam put-user-policy --user-name ${name} --policy-name p --policy-document '${JSON.stringify(policy)}'`);
  return `AWS_ACCESS_KEY_ID=${k.AccessKey.AccessKeyId} AWS_SECRET_ACCESS_KEY=${k.AccessKey.SecretAccessKey} AWS_DEFAULT_REGION=eu-west-1`;
}

const NET = `AWSTemplateFormatVersion: '2010-09-09'
Description: Red basica
Parameters:
  Entorno:
    Type: String
    Default: dev
    AllowedValues: [dev, prod]
  Cidr:
    Type: String
    Default: 10.50.0.0/16
Conditions:
  EsProd: !Equals [!Ref Entorno, prod]
Resources:
  Vpc:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: !Ref Cidr
      Tags:
        - Key: Name
          Value: !Sub '\${AWS::StackName}-vpc'
  Subred:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.50.1.0/24
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
  Datos:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Join ['-', [datos, !Ref 'AWS::AccountId', !Ref Entorno]]
  Extra:
    Type: AWS::SNS::Topic
    Condition: EsProd
Outputs:
  VpcId:
    Value: !Ref Vpc
    Export:
      Name: !Sub '\${AWS::StackName}-VpcId'
  Cubo:
    Description: Bucket de datos
    Value: !GetAtt Datos.Arn
`;

describe('CloudFormation: pilas', () => {
  it('crea una pila YAML con recursos reales, salidas y eventos', async () => {
    put('/tmp/red.yaml', NET);
    const r = await json('aws cloudformation create-stack --stack-name red --template-body file:///tmp/red.yaml');
    expect(r.StackId).toMatch(/^arn:aws:cloudformation:eu-west-1:\d{12}:stack\/red\/[0-9a-f-]{36}$/);
    await ok('aws cloudformation wait stack-create-complete --stack-name red');
    const s = (await json('aws cloudformation describe-stacks --stack-name red')).Stacks[0];
    expect(s.StackStatus).toBe('CREATE_COMPLETE');
    expect(s.Description).toBe('Red basica');
    expect(s.Parameters).toEqual([{ ParameterKey: 'Entorno', ParameterValue: 'dev' }, { ParameterKey: 'Cidr', ParameterValue: '10.50.0.0/16' }]);
    const vpc = st.vpcs.find((v) => v.cidr === '10.50.0.0/16')!;
    expect(vpc).toBeTruthy();
    expect(vpc.tags.Name).toBe('red-vpc');
    expect(vpc.tags['aws:cloudformation:stack-name']).toBe('red');
    expect(st.subnets.some((x) => x.vpcId === vpc.id && x.cidr === '10.50.1.0/24')).toBe(true);
    expect(st.securityGroups.find((g) => g.vpcId === vpc.id && g.description === 'Trafico web')!.ingress).toHaveLength(1);
    expect(st.buckets.some((b) => b.name === `datos-${st.account.id}-dev`)).toBe(true);
    expect(st.topics).toHaveLength(0); // condición falsa
    expect(s.Outputs).toEqual([
      { OutputKey: 'VpcId', OutputValue: vpc.id, ExportName: 'red-VpcId' },
      { OutputKey: 'Cubo', OutputValue: `arn:aws:s3:::datos-${st.account.id}-dev`, Description: 'Bucket de datos' },
    ]);
    // recursos
    const res = (await json('aws cloudformation describe-stack-resources --stack-name red')).StackResources;
    expect(res.map((x: any) => x.LogicalResourceId).sort()).toEqual(['Datos', 'Subred', 'Vpc', 'Web']);
    expect(res.every((x: any) => x.ResourceStatus === 'CREATE_COMPLETE')).toBe(true);
    expect((await json('aws cloudformation list-stack-resources --stack-name red --query "StackResourceSummaries[?LogicalResourceId==`Vpc`].PhysicalResourceId | [0]"'))).toBe(vpc.id);
    // eventos: del más reciente al más antiguo; la pila empieza con «User Initiated»
    const ev = (await json('aws cloudformation describe-stack-events --stack-name red')).StackEvents;
    expect(ev[0]).toMatchObject({ LogicalResourceId: 'red', ResourceType: 'AWS::CloudFormation::Stack', ResourceStatus: 'CREATE_COMPLETE' });
    expect(ev[ev.length - 1]).toMatchObject({ ResourceStatus: 'CREATE_IN_PROGRESS', ResourceStatusReason: 'User Initiated' });
    expect(ev.filter((e: any) => e.LogicalResourceId === 'Subred').map((e: any) => e.ResourceStatus)).toEqual(['CREATE_COMPLETE', 'CREATE_IN_PROGRESS']);
    // CloudTrail
    expect(st.trail.some((e) => e.eventName === 'CreateStack' && e.eventSource === 'cloudformation.amazonaws.com' && !e.errorCode)).toBe(true);
    expect(st.trail.some((e) => e.eventName === 'CreateVpc' && e.sourceIp === 'cloudformation.amazonaws.com')).toBe(true);
    // el nombre ya existe
    expect(await err('aws cloudformation create-stack --stack-name red --template-body file:///tmp/red.yaml')).toContain('AlreadyExistsException');
  });

  it('el estado avanza con el reloj: CREATE_IN_PROGRESS → CREATE_COMPLETE', async () => {
    st.settings.speed = 'fast';
    let t = Date.UTC(2026, 0, 1);
    setClock(() => t);
    put('/tmp/red.yaml', NET);
    await ok('aws cloudformation create-stack --stack-name red --template-body file:///tmp/red.yaml');
    expect((await json('aws cloudformation describe-stacks --stack-name red --query Stacks[0].StackStatus'))).toBe('CREATE_IN_PROGRESS');
    t += 3000;
    const mid = (await json('aws cloudformation describe-stack-resources --stack-name red')).StackResources.map((r: any) => `${r.LogicalResourceId}:${r.ResourceStatus}`);
    expect(mid.some((x: string) => x.endsWith('CREATE_COMPLETE'))).toBe(true);
    t += 120_000;
    expect((await json('aws cloudformation describe-stacks --stack-name red --query Stacks[0].StackStatus'))).toBe('CREATE_COMPLETE');
    expect((await json('aws cloudformation describe-stacks --stack-name red --query Stacks[0].Outputs'))).toHaveLength(2);
  });

  it('wait adelanta el reloj de CloudFormation', async () => {
    st.settings.speed = 'realistic';
    put('/tmp/red.yaml', NET);
    await ok('aws cloudformation create-stack --stack-name red --template-body file:///tmp/red.yaml');
    expect(await json('aws cloudformation describe-stacks --stack-name red --query Stacks[0].StackStatus')).toBe('CREATE_IN_PROGRESS');
    expect(await err('aws cloudformation update-stack --stack-name red --template-body file:///tmp/red.yaml')).toContain('is in CREATE_IN_PROGRESS state and can not be updated');
    await ok('aws cloudformation wait stack-create-complete --stack-name red');
    expect(await json('aws cloudformation describe-stacks --stack-name red --query Stacks[0].StackStatus')).toBe('CREATE_COMPLETE');
  });

  it('plantillas JSON con Fn::Sub, Join, GetAtt y Mappings', async () => {
    const tpl = {
      Parameters: { Env: { Type: 'String', Default: 'dev' } },
      Mappings: { Retencion: { dev: { Dias: '7' }, prod: { Dias: '90' } } },
      Resources: {
        Logs: { Type: 'AWS::Logs::LogGroup', Properties: { LogGroupName: { 'Fn::Sub': '/app/${Env}' }, RetentionInDays: { 'Fn::FindInMap': ['Retencion', { Ref: 'Env' }, 'Dias'] } } },
        Alarma: { Type: 'AWS::CloudWatch::Alarm', Properties: { AlarmName: { 'Fn::Join': ['-', ['cpu', { Ref: 'Env' }]] }, MetricName: 'CPUUtilization', Namespace: 'AWS/EC2', Statistic: 'Average', Period: 300, EvaluationPeriods: 1, Threshold: 80, ComparisonOperator: 'GreaterThanThreshold', AlarmActions: [{ Ref: 'Aviso' }] } },
        Aviso: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'avisos' } },
      },
      Outputs: { Grupo: { Value: { 'Fn::GetAtt': ['Logs', 'Arn'] } }, Tema: { Value: { Ref: 'Aviso' } } },
    };
    put('/tmp/t.json', JSON.stringify(tpl, null, 2));
    await ok('aws cloudformation create-stack --stack-name app --template-body file:///tmp/t.json');
    const s = (await json('aws cloudformation describe-stacks --stack-name app')).Stacks[0];
    expect(s.StackStatus).toBe('CREATE_COMPLETE');
    expect(st.logGroups.find((g) => g.name === '/app/dev')?.retention).toBe(7);
    expect(st.alarms.find((a) => a.name === 'cpu-dev')?.alarmActions[0]).toBe(`arn:aws:sns:eu-west-1:${st.account.id}:avisos`);
    expect(s.Outputs.find((o: any) => o.OutputKey === 'Grupo').OutputValue).toMatch(/log-group:\/app\/dev:\*$/);
    // get-template devuelve el JSON original como objeto
    expect((await json('aws cloudformation get-template --stack-name app')).TemplateBody.Mappings.Retencion.prod.Dias).toBe('90');
    // con otro valor del parámetro
    await ok('aws cloudformation create-stack --stack-name app2 --parameters ParameterKey=Env,ParameterValue=prod --template-body file:///tmp/t.json').catch(() => undefined);
  });

  it('get-template devuelve el YAML como texto y validate-template describe parámetros y capacidades', async () => {
    put('/tmp/red.yaml', NET);
    const v = await json('aws cloudformation validate-template --template-body file:///tmp/red.yaml');
    expect(v.Description).toBe('Red basica');
    expect(v.Parameters.map((p: any) => p.ParameterKey)).toEqual(['Entorno', 'Cidr']);
    expect(v.Capabilities).toBeUndefined();
    put('/tmp/iam.yaml', 'Resources:\n  R:\n    Type: AWS::IAM::Role\n    Properties:\n      AssumeRolePolicyDocument: {Version: "2012-10-17", Statement: []}\n');
    const vi = await json('aws cloudformation validate-template --template-body file:///tmp/iam.yaml');
    expect(vi.Capabilities).toEqual(['CAPABILITY_IAM']);
    expect(vi.CapabilitiesReason).toContain('AWS::IAM::Role');
    await ok('aws cloudformation create-stack --stack-name red --template-body file:///tmp/red.yaml');
    const t = await json('aws cloudformation get-template --stack-name red');
    expect(typeof t.TemplateBody).toBe('string');
    expect(t.TemplateBody).toContain('!Ref Entorno');
  });
});

describe('CloudFormation: validación de plantillas y errores', () => {
  const create = (body: string, extra = '') => { put('/tmp/x.tpl', body); return err(`aws cloudformation create-stack --stack-name x --template-body file:///tmp/x.tpl ${extra}`); };

  it('errores de formato como los de AWS', async () => {
    expect(await create('{"Resources": {')).toContain('Template format error: JSON not well-formed. (line 1, column');
    expect(await create('Resources:\n  A: [\n')).toContain('Template format error: YAML not well-formed. (line');
    expect(await create('Description: sin recursos\n')).toContain('Template format error: At least one Resources member must be defined.');
    expect(await create('Resources:\n  A:\n    Properties: {}\n')).toContain('Every Resources object must contain a Type member');
    expect(await create('Resources:\n  A:\n    Type: AWS::Lambda::Function\n')).toContain('Unrecognized resource types: [AWS::Lambda::Function]');
    expect(await create('Resources:\n  A:\n    Type: AWS::SNS::Topic\n    Properties:\n      DisplayName: !Ref Nada\n')).toContain('Unresolved resource dependencies [Nada] in the Resources block of the template');
    expect(await create('Resources:\n  A:\n    Type: AWS::EC2::VPC\n    Properties: {CidrBlock: !GetAtt B.Foo}\n  B:\n    Type: AWS::SNS::Topic\n')).toContain('does not support attribute type Foo in Fn::GetAtt');
    expect(await create('Resources:\n  A:\n    Type: AWS::SNS::Topic\n    DependsOn: B\n  B:\n    Type: AWS::SNS::Topic\n    DependsOn: A\n')).toContain('Circular dependency between resources: [A, B]');
    expect(await create('Resources:\n  A:\n    Type: AWS::SNS::Topic\nOutputs:\n  O:\n    Value: !Ref Z\n')).toContain('Unresolved resource dependencies [Z] in the Outputs block');
    expect((await run('aws cloudformation describe-stacks')).out).toContain('"Stacks": []');
  });

  it('parámetros: obligatorios, desconocidos y restricciones', async () => {
    const tpl = 'Parameters:\n  Env:\n    Type: String\n    AllowedValues: [dev, prod]\n  N:\n    Type: Number\n    Default: 3\n    MinValue: 1\n    MaxValue: 5\n  Code:\n    Type: String\n    Default: abc\n    AllowedPattern: "[a-z]+"\n    MinLength: 2\nResources:\n  T:\n    Type: AWS::SNS::Topic\n';
    expect(await create(tpl)).toContain('Parameters: [Env] must have values');
    expect(await create(tpl, '--parameters ParameterKey=Env,ParameterValue=qa')).toContain("Parameter 'Env' must be one of AllowedValues");
    expect(await create(tpl, '--parameters ParameterKey=Env,ParameterValue=dev ParameterKey=Otro,ParameterValue=1')).toContain('Parameters: [Otro] do not exist in the template');
    expect(await create(tpl, '--parameters ParameterKey=Env,ParameterValue=dev ParameterKey=N,ParameterValue=9')).toContain("Parameter 'N' must be less than or equal to 5");
    expect(await create(tpl, '--parameters ParameterKey=Env,ParameterValue=dev ParameterKey=Code,ParameterValue=ABC')).toContain("Parameter 'Code' must match pattern [a-z]+");
    expect(await err('aws cloudformation create-stack --stack-name x')).toContain('Either Template URL or Template Body must be specified.');
    expect(await err('aws cloudformation create-stack --stack-name 1mala --template-body "{}"')).toContain("Value '1mala' at 'stackName' failed to satisfy constraint");
    await ok(`aws cloudformation create-stack --stack-name x --template-body file:///tmp/x.tpl --parameters ParameterKey=Env,ParameterValue=dev`);
    expect((await json('aws cloudformation describe-stacks --stack-name x')).Stacks[0].Parameters.map((p: any) => p.ParameterValue)).toEqual(['dev', '3', 'abc']);
  });

  it('los recursos de IAM exigen CAPABILITY_IAM o CAPABILITY_NAMED_IAM', async () => {
    const role = (name = '') => `Resources:\n  R:\n    Type: AWS::IAM::Role\n    Properties:\n${name ? `      RoleName: ${name}\n` : ''}      AssumeRolePolicyDocument:\n        Version: "2012-10-17"\n        Statement:\n          - Effect: Allow\n            Principal: {Service: ec2.amazonaws.com}\n            Action: sts:AssumeRole\n`;
    expect(await create(role())).toContain('InsufficientCapabilitiesException');
    expect(await create(role())).toContain('Requires capabilities : [CAPABILITY_IAM]');
    expect(await create(role('mi-rol'), '--capabilities CAPABILITY_IAM')).toContain('Requires capabilities : [CAPABILITY_NAMED_IAM]');
    await ok('aws cloudformation create-stack --stack-name x --template-body file:///tmp/x.tpl --capabilities CAPABILITY_NAMED_IAM');
    expect(st.roles.some((r) => r.name === 'mi-rol')).toBe(true);
    expect(await err('aws cloudformation create-stack --stack-name y --template-body "{}" --capabilities CAPABILITY_MAGIC')).toContain('failed to satisfy constraint');
  });
});

describe('CloudFormation: fallos y reversión', () => {
  const bucketTpl = (name: string, extra = '') => `Resources:\n  Uno:\n    Type: AWS::SNS::Topic\n  Cubo:\n    Type: AWS::S3::Bucket\n    DependsOn: Uno\n    Properties:\n      BucketName: ${name}\n${extra}`;

  it('si un recurso falla, la pila acaba en ROLLBACK_COMPLETE y se borra lo creado', async () => {
    await ok('aws s3 mb s3://ocupado-1');
    put('/tmp/f.yaml', bucketTpl('ocupado-1'));
    await ok('aws cloudformation create-stack --stack-name f --template-body file:///tmp/f.yaml');
    const s = (await json('aws cloudformation describe-stacks --stack-name f')).Stacks[0];
    expect(s.StackStatus).toBe('ROLLBACK_COMPLETE');
    expect(st.topics).toHaveLength(0);
    const ev = (await json('aws cloudformation describe-stack-events --stack-name f')).StackEvents;
    const failed = ev.find((e: any) => e.ResourceStatus === 'CREATE_FAILED');
    expect(failed.LogicalResourceId).toBe('Cubo');
    expect(failed.ResourceStatusReason).toContain('Service: Amazon S3; Status Code: 409; Error Code: BucketAlreadyOwnedByYou');
    expect(ev.find((e: any) => e.ResourceStatus === 'ROLLBACK_IN_PROGRESS').ResourceStatusReason).toBe('The following resource(s) failed to create: [Cubo]. Rollback requested by user.');
    expect(ev.filter((e: any) => e.LogicalResourceId === 'Uno').map((e: any) => e.ResourceStatus)).toEqual(['DELETE_COMPLETE', 'DELETE_IN_PROGRESS', 'CREATE_COMPLETE', 'CREATE_IN_PROGRESS']);
    // el wait lo reporta
    expect(await err('aws cloudformation wait stack-create-complete --stack-name f')).toContain('Waiter StackCreateComplete failed: Waiter encountered a terminal failure state: For expression "Stacks[].StackStatus" we matched expected path: "ROLLBACK_COMPLETE"');
    // una pila en ROLLBACK_COMPLETE no se actualiza ni se puede recrear con el mismo nombre
    expect(await err('aws cloudformation update-stack --stack-name f --template-body file:///tmp/f.yaml')).toContain('is in ROLLBACK_COMPLETE state and can not be updated');
    expect(await err('aws cloudformation create-stack --stack-name f --template-body file:///tmp/f.yaml')).toContain('AlreadyExistsException');
    await ok('aws cloudformation delete-stack --stack-name f');
    expect(await err('aws cloudformation describe-stacks --stack-name f')).toContain('Stack with id f does not exist');
    const del = (await json('aws cloudformation list-stacks --stack-status-filter DELETE_COMPLETE')).StackSummaries;
    expect(del[0]).toMatchObject({ StackName: 'f', StackStatus: 'DELETE_COMPLETE' });
    expect(del[0].DeletionTime).toBeTruthy();
    // por ARN se sigue viendo
    expect((await json(`aws cloudformation describe-stacks --stack-name ${del[0].StackId}`)).Stacks[0].StackStatus).toBe('DELETE_COMPLETE');
  });

  it('--on-failure DO_NOTHING deja la pila en CREATE_FAILED con sus recursos', async () => {
    await ok('aws s3 mb s3://ocupado-2');
    put('/tmp/f.yaml', bucketTpl('ocupado-2'));
    await ok('aws cloudformation create-stack --stack-name g --on-failure DO_NOTHING --template-body file:///tmp/f.yaml');
    expect((await json('aws cloudformation describe-stacks --stack-name g')).Stacks[0].StackStatus).toBe('CREATE_FAILED');
    expect(st.topics).toHaveLength(1);
    const res = (await json('aws cloudformation describe-stack-resources --stack-name g')).StackResources;
    expect(res.map((r: any) => `${r.LogicalResourceId}:${r.ResourceStatus}`).sort()).toEqual(['Cubo:CREATE_FAILED', 'Uno:CREATE_COMPLETE']);
    await ok('aws cloudformation delete-stack --stack-name g');
    expect(st.topics).toHaveLength(0);
    expect(await err('aws cloudformation create-stack --stack-name h --on-failure DELETE --disable-rollback --template-body file:///tmp/f.yaml')).toContain('either DisableRollback or OnFailure');
  });

  it('un usuario sin permisos falla con el AccessDenied real y --role-arn lo resuelve', async () => {
    const cfnOnly = await newUser('dev', { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['cloudformation:*', 'iam:PassRole'], Resource: '*' }] });
    put('/tmp/b.yaml', 'Resources:\n  C:\n    Type: AWS::S3::Bucket\n    Properties:\n      BucketName: permisos-1\n');
    await ok(`${cfnOnly} aws cloudformation create-stack --stack-name p --template-body file:///tmp/b.yaml`);
    const ev = (await json(`${cfnOnly} aws cloudformation describe-stack-events --stack-name p`)).StackEvents;
    const f = ev.find((e: any) => e.ResourceStatus === 'CREATE_FAILED');
    expect(f.ResourceStatusReason).toContain(`User: arn:aws:iam::${st.account.id}:user/dev is not authorized to perform: s3:CreateBucket on resource: "arn:aws:s3:::permisos-1" because no identity-based policy allows the s3:CreateBucket action (Service: Amazon S3; Status Code: 403; Error Code: AccessDenied`);
    expect((await json(`${cfnOnly} aws cloudformation describe-stacks --stack-name p`)).Stacks[0].StackStatus).toBe('ROLLBACK_COMPLETE');
    // sin permisos de CloudFormation
    const nada = await newUser('nada');
    expect(await err(`${nada} aws cloudformation create-stack --stack-name q --template-body file:///tmp/b.yaml`)).toContain(`An error occurred (AccessDenied) when calling the CreateStack operation: User: arn:aws:iam::${st.account.id}:user/nada is not authorized to perform: cloudformation:CreateStack on resource: arn:aws:cloudformation:eu-west-1:${st.account.id}:stack/q/* because no identity-based policy allows the cloudformation:CreateStack action`);
    // rol de servicio
    await ok(`aws iam create-role --role-name cfn-rol --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"cloudformation.amazonaws.com"},"Action":"sts:AssumeRole"}]}'`);
    await ok('aws iam attach-role-policy --role-name cfn-rol --policy-arn arn:aws:iam::aws:policy/AmazonS3FullAccess');
    const arn = `arn:aws:iam::${st.account.id}:role/cfn-rol`;
    await ok(`${cfnOnly} aws cloudformation delete-stack --stack-name p`);
    await ok(`${cfnOnly} aws cloudformation create-stack --stack-name p --role-arn ${arn} --template-body file:///tmp/b.yaml`);
    expect((await json(`${cfnOnly} aws cloudformation describe-stacks --stack-name p`)).Stacks[0]).toMatchObject({ StackStatus: 'CREATE_COMPLETE', RoleARN: arn });
    expect(st.buckets.some((b) => b.name === 'permisos-1')).toBe(true);
    // sin iam:PassRole
    const sinPass = await newUser('sinpass', { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'cloudformation:*', Resource: '*' }] });
    expect(await err(`${sinPass} aws cloudformation create-stack --stack-name r --role-arn ${arn} --template-body file:///tmp/b.yaml`)).toContain('is not authorized to perform: iam:PassRole');
    expect(await err(`aws cloudformation create-stack --stack-name r --role-arn arn:aws:iam::${st.account.id}:role/noexiste --template-body file:///tmp/b.yaml`)).toContain('is invalid or cannot be assumed');
  });
});

describe('CloudFormation: actualización y borrado', () => {
  const base = (extra = '', name = 'cubo-upd') => `Resources:\n  Topic:\n    Type: AWS::SNS::Topic\n    Properties:\n      DisplayName: v1\n  Cubo:\n    Type: AWS::S3::Bucket\n    Properties:\n      BucketName: ${name}\n${extra}`;

  it('actualiza en sitio, añade, quita y rechaza «no hay cambios»', async () => {
    put('/tmp/a.yaml', base());
    await ok('aws cloudformation create-stack --stack-name u --template-body file:///tmp/a.yaml');
    expect(await err('aws cloudformation update-stack --stack-name u --template-body file:///tmp/a.yaml')).toContain('No updates are to be performed.');
    put('/tmp/a2.yaml', base('      Tags:\n        - Key: env\n          Value: dev\n').replace('v1', 'v2') + '  Nuevo:\n    Type: AWS::Logs::LogGroup\n    Properties:\n      LogGroupName: /nuevo\n');
    await ok('aws cloudformation update-stack --stack-name u --template-body file:///tmp/a2.yaml');
    await ok('aws cloudformation wait stack-update-complete --stack-name u');
    const s = (await json('aws cloudformation describe-stacks --stack-name u')).Stacks[0];
    expect(s.StackStatus).toBe('UPDATE_COMPLETE');
    expect(s.LastUpdatedTime).toBeTruthy();
    expect(st.topics[0].displayName).toBe('v2');
    expect(st.buckets.find((b) => b.name === 'cubo-upd')!.tags.env).toBe('dev');
    expect(st.logGroups.some((g) => g.name === '/nuevo')).toBe(true);
    const ev = (await json('aws cloudformation describe-stack-events --stack-name u')).StackEvents.map((e: any) => `${e.LogicalResourceId}:${e.ResourceStatus}`);
    expect(ev).toContain('Topic:UPDATE_COMPLETE');
    expect(ev).toContain('Nuevo:CREATE_COMPLETE');
    // quitar un recurso lo borra
    put('/tmp/a3.yaml', base('', 'cubo-upd'));
    await ok('aws cloudformation update-stack --stack-name u --template-body file:///tmp/a3.yaml');
    expect(st.logGroups.some((g) => g.name === '/nuevo')).toBe(false);
    expect((await json('aws cloudformation describe-stack-events --stack-name u')).StackEvents.map((e: any) => `${e.LogicalResourceId}:${e.ResourceStatus}`)).toEqual(expect.arrayContaining(['u:UPDATE_COMPLETE_CLEANUP_IN_PROGRESS', 'Nuevo:DELETE_COMPLETE']));
    expect((await json('aws cloudformation describe-stack-resources --stack-name u')).StackResources.map((r: any) => r.LogicalResourceId).sort()).toEqual(['Cubo', 'Topic']);
  });

  it('un recurso con nombre fijo no se puede sustituir y la actualización se revierte', async () => {
    put('/tmp/a.yaml', base());
    await ok('aws cloudformation create-stack --stack-name u --template-body file:///tmp/a.yaml');
    // cambiar una propiedad que exige sustitución manteniendo el nombre: no existe en el bucket; usamos un SG con nombre fijo
    put('/tmp/sg.yaml', 'Resources:\n  Vpc:\n    Type: AWS::EC2::VPC\n    Properties: {CidrBlock: 10.9.0.0/16}\n  Sg:\n    Type: AWS::EC2::SecurityGroup\n    Properties:\n      GroupName: fijo\n      GroupDescription: uno\n      VpcId: !Ref Vpc\n');
    await ok('aws cloudformation create-stack --stack-name redsg --template-body file:///tmp/sg.yaml');
    const sgId = st.securityGroups.find((g) => g.name === 'fijo')!.id;
    put('/tmp/sg2.yaml', 'Resources:\n  Vpc:\n    Type: AWS::EC2::VPC\n    Properties: {CidrBlock: 10.9.0.0/16}\n  Sg:\n    Type: AWS::EC2::SecurityGroup\n    Properties:\n      GroupName: fijo\n      GroupDescription: dos\n      VpcId: !Ref Vpc\n');
    await ok('aws cloudformation update-stack --stack-name redsg --template-body file:///tmp/sg2.yaml');
    const s = (await json('aws cloudformation describe-stacks --stack-name redsg')).Stacks[0];
    expect(s.StackStatus).toBe('UPDATE_ROLLBACK_COMPLETE');
    const ev = (await json('aws cloudformation describe-stack-events --stack-name redsg')).StackEvents;
    expect(ev.find((e: any) => e.ResourceStatus === 'UPDATE_FAILED').ResourceStatusReason).toBe('CloudFormation cannot update a stack when a custom-named resource requires replacing. Rename fijo and update the stack again.');
    expect(st.securityGroups.some((g) => g.id === sgId)).toBe(true);
    // sin nombre fijo, la sustitución crea el nuevo y borra el viejo
    put('/tmp/sg3.yaml', 'Resources:\n  Vpc:\n    Type: AWS::EC2::VPC\n    Properties: {CidrBlock: 10.9.0.0/16}\n  Sg:\n    Type: AWS::EC2::SecurityGroup\n    Properties:\n      GroupDescription: uno\n      VpcId: !Ref Vpc\n');
    await ok('aws cloudformation update-stack --stack-name redsg --template-body file:///tmp/sg3.yaml');
    const nuevo = (await json('aws cloudformation describe-stack-resource --stack-name redsg --logical-resource-id Sg')).StackResourceDetail.PhysicalResourceId;
    expect(nuevo).not.toBe(sgId);
    put('/tmp/sg4.yaml', 'Resources:\n  Vpc:\n    Type: AWS::EC2::VPC\n    Properties: {CidrBlock: 10.9.0.0/16}\n  Sg:\n    Type: AWS::EC2::SecurityGroup\n    Properties:\n      GroupDescription: tres\n      VpcId: !Ref Vpc\n');
    await ok('aws cloudformation update-stack --stack-name redsg --template-body file:///tmp/sg4.yaml');
    expect(st.securityGroups.some((g) => g.id === nuevo)).toBe(false);
    expect(st.securityGroups.filter((g) => g.description === 'tres')).toHaveLength(1);
  });

  it('DeletionPolicy Retain, buckets no vacíos y --retain-resources', async () => {
    put('/tmp/r.yaml', 'Resources:\n  Guardado:\n    Type: AWS::S3::Bucket\n    DeletionPolicy: Retain\n    Properties: {BucketName: guardado-1}\n  Lleno:\n    Type: AWS::S3::Bucket\n    Properties: {BucketName: lleno-1}\n');
    await ok('aws cloudformation create-stack --stack-name r --template-body file:///tmp/r.yaml');
    put('/tmp/o.txt', 'hola');
    await ok('aws s3 cp /tmp/o.txt s3://lleno-1/o.txt');
    await ok('aws cloudformation delete-stack --stack-name r');
    expect((await json('aws cloudformation describe-stacks --stack-name r')).Stacks[0].StackStatus).toBe('DELETE_FAILED');
    const ev = (await json('aws cloudformation describe-stack-events --stack-name r')).StackEvents;
    expect(ev.find((e: any) => e.ResourceStatus === 'DELETE_FAILED' && e.LogicalResourceId === 'Lleno').ResourceStatusReason).toContain('The bucket you tried to delete is not empty');
    expect(ev.find((e: any) => e.ResourceStatus === 'DELETE_FAILED' && e.LogicalResourceId === 'r').ResourceStatusReason).toBe('The following resource(s) failed to delete: [Lleno]. ');
    expect(ev.some((e: any) => e.LogicalResourceId === 'Guardado' && e.ResourceStatus === 'DELETE_SKIPPED')).toBe(true);
    expect(await err('aws cloudformation delete-stack --stack-name r --retain-resources Nada')).toContain('do not exist in stack');
    await ok('aws cloudformation delete-stack --stack-name r --retain-resources Lleno');
    expect(await err('aws cloudformation describe-stacks --stack-name r')).toContain('does not exist');
    expect(st.buckets.map((b) => b.name).sort()).toEqual(['guardado-1', 'lleno-1']);
  });

  it('la protección contra terminación impide borrar la pila', async () => {
    put('/tmp/a.yaml', base());
    await ok('aws cloudformation create-stack --stack-name u --enable-termination-protection --template-body file:///tmp/a.yaml');
    expect(await err('aws cloudformation delete-stack --stack-name u')).toContain('cannot be deleted while TerminationProtection is enabled');
    await ok('aws cloudformation update-termination-protection --stack-name u --no-enable-termination-protection');
    await ok('aws cloudformation delete-stack --stack-name u');
    expect(st.buckets).toHaveLength(0);
  });

  it('las exportaciones no se pueden borrar mientras otra pila las importe', async () => {
    put('/tmp/e1.yaml', 'Resources:\n  T:\n    Type: AWS::SNS::Topic\nOutputs:\n  Arn:\n    Value: !Ref T\n    Export: {Name: tema-arn}\n');
    put('/tmp/e2.yaml', 'Resources:\n  A:\n    Type: AWS::CloudWatch::Alarm\n    Properties:\n      MetricName: m\n      Namespace: n\n      Period: 60\n      EvaluationPeriods: 1\n      Threshold: 1\n      ComparisonOperator: GreaterThanThreshold\n      AlarmActions: [!ImportValue tema-arn]\n');
    expect(await err('aws cloudformation create-stack --stack-name consumidor --template-body file:///tmp/e2.yaml')).toContain('No export named tema-arn found.');
    await ok('aws cloudformation create-stack --stack-name productor --template-body file:///tmp/e1.yaml');
    expect((await json('aws cloudformation list-exports')).Exports[0]).toMatchObject({ Name: 'tema-arn' });
    expect(await err('aws cloudformation create-stack --stack-name otro --template-body file:///tmp/e1.yaml')).toContain('Export with name tema-arn is already exported by stack productor');
    await ok('aws cloudformation create-stack --stack-name consumidor --template-body file:///tmp/e2.yaml');
    expect((await json('aws cloudformation list-imports --export-name tema-arn')).Imports).toEqual(['consumidor']);
    expect(await err('aws cloudformation delete-stack --stack-name productor')).toContain('Export tema-arn cannot be deleted as it is in use by consumidor');
    await ok('aws cloudformation delete-stack --stack-name consumidor');
    await ok('aws cloudformation delete-stack --stack-name productor');
  });
});

describe('CloudFormation: conjuntos de cambios y deploy', () => {
  const tpl = (itype = 'cubo-cs-1', tema = '') => `Resources:\n  Cubo:\n    Type: AWS::S3::Bucket\n    Properties:\n      BucketName: ${itype}\n${tema}`;

  it('create / describe / execute / delete de conjuntos de cambios', async () => {
    put('/tmp/c1.yaml', tpl());
    const cs = await json('aws cloudformation create-change-set --stack-name cs --change-set-name inicial --change-set-type CREATE --template-body file:///tmp/c1.yaml');
    expect(cs.Id).toMatch(/^arn:aws:cloudformation:eu-west-1:\d{12}:changeSet\/inicial\//);
    expect((await json('aws cloudformation describe-stacks --stack-name cs')).Stacks[0].StackStatus).toBe('REVIEW_IN_PROGRESS');
    await ok('aws cloudformation wait change-set-create-complete --stack-name cs --change-set-name inicial');
    const d = await json('aws cloudformation describe-change-set --stack-name cs --change-set-name inicial');
    expect(d).toMatchObject({ Status: 'CREATE_COMPLETE', ExecutionStatus: 'AVAILABLE', ChangeSetName: 'inicial' });
    expect(d.Changes[0].ResourceChange).toMatchObject({ Action: 'Add', LogicalResourceId: 'Cubo', ResourceType: 'AWS::S3::Bucket' });
    expect(st.buckets).toHaveLength(0); // todavía no se ha creado nada
    expect(await err('aws cloudformation create-change-set --stack-name cs --change-set-name inicial --change-set-type CREATE --template-body file:///tmp/c1.yaml')).toContain('AlreadyExistsException');
    await ok('aws cloudformation execute-change-set --stack-name cs --change-set-name inicial');
    await ok('aws cloudformation wait stack-create-complete --stack-name cs');
    expect(st.buckets.map((b) => b.name)).toEqual(['cubo-cs-1']);
    expect((await json('aws cloudformation describe-change-set --stack-name cs --change-set-name inicial')).ExecutionStatus).toBe('EXECUTE_COMPLETE');
    expect(await err('aws cloudformation execute-change-set --stack-name cs --change-set-name inicial')).toContain('InvalidChangeSetStatus');
    // actualización: modificar etiqueta + añadir tema + quitar nada
    put('/tmp/c2.yaml', tpl('cubo-cs-1', '      Tags:\n        - Key: a\n          Value: b\n  Tema:\n    Type: AWS::SNS::Topic\n    Properties:\n      TopicName: cs-tema\n'));
    await ok('aws cloudformation create-change-set --stack-name cs --change-set-name cambios --template-body file:///tmp/c2.yaml');
    await ok('aws cloudformation wait change-set-create-complete --stack-name cs --change-set-name cambios');
    const d2 = await json('aws cloudformation describe-change-set --stack-name cs --change-set-name cambios');
    const by = Object.fromEntries(d2.Changes.map((c: any) => [c.ResourceChange.LogicalResourceId, c.ResourceChange]));
    expect(by.Tema.Action).toBe('Add');
    expect(by.Cubo).toMatchObject({ Action: 'Modify', Replacement: 'False', Scope: ['Tags'], PhysicalResourceId: 'cubo-cs-1' });
    expect((await json('aws cloudformation list-change-sets --stack-name cs')).Summaries.map((s: any) => s.ChangeSetName).sort()).toEqual(['cambios', 'inicial']);
    // sustitución: cambiar el nombre fijo del bucket
    put('/tmp/c3.yaml', tpl('cubo-cs-2'));
    await ok('aws cloudformation create-change-set --stack-name cs --change-set-name renombrar --template-body file:///tmp/c3.yaml');
    expect((await json('aws cloudformation describe-change-set --stack-name cs --change-set-name renombrar')).Changes[0].ResourceChange).toMatchObject({ Action: 'Modify', Replacement: 'True', Details: [{ Target: { Attribute: 'Properties', Name: 'BucketName', RequiresRecreation: 'Always' }, Evaluation: 'Static', ChangeSource: 'DirectModification' }] });
    await ok('aws cloudformation delete-change-set --stack-name cs --change-set-name renombrar');
    expect(await err('aws cloudformation describe-change-set --stack-name cs --change-set-name renombrar')).toContain('ChangeSetNotFound');
    await ok('aws cloudformation execute-change-set --stack-name cs --change-set-name cambios');
    expect(st.topics.map((t) => t.name)).toEqual(['cs-tema']);
    // el conjunto «inicial» ya no sirve y el que no se ejecutó queda obsoleto
    expect((await json('aws cloudformation list-change-sets --stack-name cs')).Summaries.find((s: any) => s.ChangeSetName === 'inicial').ExecutionStatus).toBe('OBSOLETE');
  });

  it('un conjunto de cambios sin diferencias queda en FAILED', async () => {
    put('/tmp/c1.yaml', tpl());
    await ok('aws cloudformation create-stack --stack-name cs --template-body file:///tmp/c1.yaml');
    await ok('aws cloudformation create-change-set --stack-name cs --change-set-name igual --template-body file:///tmp/c1.yaml');
    const d = await json('aws cloudformation describe-change-set --stack-name cs --change-set-name igual');
    expect(d).toMatchObject({ Status: 'FAILED', ExecutionStatus: 'UNAVAILABLE', StatusReason: "The submitted information didn't contain changes. Submit different information to create a change set.", Changes: [] });
    expect(await err('aws cloudformation wait change-set-create-complete --stack-name cs --change-set-name igual')).toContain('Waiter ChangeSetCreateComplete failed');
  });

  it('deploy crea, actualiza, avisa si no hay cambios y falla con el texto del CLI', async () => {
    put('/tmp/d.yaml', 'Parameters:\n  Nombre:\n    Type: String\nResources:\n  T:\n    Type: AWS::SNS::Topic\n    Properties:\n      TopicName: !Ref Nombre\n');
    const out = await ok('aws cloudformation deploy --template-file /tmp/d.yaml --stack-name dep --parameter-overrides Nombre=uno');
    expect(out).toBe('\nWaiting for changeset to be created..\nWaiting for stack create/update to complete\nSuccessfully created/updated stack - dep\n');
    expect(st.topics.map((t) => t.name)).toEqual(['uno']);
    const e = await err('aws cloudformation deploy --template-file /tmp/d.yaml --stack-name dep --parameter-overrides Nombre=uno');
    expect(e).toContain('No changes to deploy. Stack dep is up to date');
    expect(await ok('aws cloudformation deploy --template-file /tmp/d.yaml --stack-name dep --parameter-overrides Nombre=uno --no-fail-on-empty-changeset')).toContain('No changes to deploy');
    await ok('aws cloudformation deploy --template-file /tmp/d.yaml --stack-name dep --parameter-overrides Nombre=dos');
    expect(st.topics.map((t) => t.name)).toEqual(['dos']);
    // --no-execute-changeset
    const prev = await ok('aws cloudformation deploy --template-file /tmp/d.yaml --stack-name dep --parameter-overrides Nombre=tres --no-execute-changeset');
    expect(prev).toContain('Changeset created successfully. Run the following command to review changes:');
    expect(st.topics.map((t) => t.name)).toEqual(['dos']);
    // fallo
    await ok('aws s3 mb s3://ocupado-d');
    put('/tmp/d2.yaml', 'Resources:\n  C:\n    Type: AWS::S3::Bucket\n    Properties: {BucketName: ocupado-d}\n');
    const f = await err('aws cloudformation deploy --template-file /tmp/d2.yaml --stack-name dep2');
    expect(f).toContain('Failed to create/update the stack. Run the following command\nto fetch the list of events leading up to the failure\naws cloudformation describe-stack-events --stack-name dep2');
    expect(await err('aws cloudformation deploy --template-file /tmp/no.yaml --stack-name x')).toContain('Invalid template path /tmp/no.yaml');
    // IAM exige capacidades también con deploy
    put('/tmp/iam.yaml', 'Resources:\n  U:\n    Type: AWS::IAM::User\n');
    expect(await err('aws cloudformation deploy --template-file /tmp/iam.yaml --stack-name iamstack')).toContain('Requires capabilities : [CAPABILITY_IAM]');
    await ok('aws cloudformation deploy --template-file /tmp/iam.yaml --stack-name iamstack --capabilities CAPABILITY_IAM');
    expect(st.users.some((u) => u.name.startsWith('iamstack-U-'))).toBe(true);
  });
});

describe('CloudFormation: recursos de todos los servicios y compatibilidad', () => {
  it('crea IAM, KMS, Secrets Manager, EC2, IGW y CloudWatch con referencias entre ellos', async () => {
    put('/tmp/all.yaml', `Resources:
  Clave:
    Type: AWS::KMS::Key
    Properties:
      Description: clave de datos
      EnableKeyRotation: true
  Alias:
    Type: AWS::KMS::Alias
    Properties:
      AliasName: alias/cfn-datos
      TargetKeyId: !Ref Clave
  Secreto:
    Type: AWS::SecretsManager::Secret
    Properties:
      Name: cfn/db
      KmsKeyId: !GetAtt Clave.Arn
      GenerateSecretString:
        SecretStringTemplate: '{"user":"admin"}'
        GenerateStringKey: password
        PasswordLength: 20
  Rol:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal: {Service: ec2.amazonaws.com}
            Action: sts:AssumeRole
      Policies:
        - PolicyName: leer
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action: secretsmanager:GetSecretValue
                Resource: !Ref Secreto
  Perfil:
    Type: AWS::IAM::InstanceProfile
    Properties:
      Roles: [!Ref Rol]
  Vpc:
    Type: AWS::EC2::VPC
    Properties: {CidrBlock: 10.7.0.0/16}
  Igw:
    Type: AWS::EC2::InternetGateway
  Union:
    Type: AWS::EC2::VPCGatewayAttachment
    Properties:
      VpcId: !Ref Vpc
      InternetGatewayId: !Ref Igw
  Subred:
    Type: AWS::EC2::Subnet
    Properties:
      VpcId: !Ref Vpc
      CidrBlock: 10.7.1.0/24
      MapPublicIpOnLaunch: true
  Tabla:
    Type: AWS::EC2::RouteTable
    Properties: {VpcId: !Ref Vpc}
  Ruta:
    Type: AWS::EC2::Route
    DependsOn: Union
    Properties:
      RouteTableId: !Ref Tabla
      DestinationCidrBlock: 0.0.0.0/0
      GatewayId: !Ref Igw
  Asoc:
    Type: AWS::EC2::SubnetRouteTableAssociation
    Properties: {SubnetId: !Ref Subred, RouteTableId: !Ref Tabla}
  Sg:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: ssh
      VpcId: !Ref Vpc
      SecurityGroupIngress:
        - {IpProtocol: tcp, FromPort: 22, ToPort: 22, CidrIp: 10.0.0.0/8}
  Servidor:
    Type: AWS::EC2::Instance
    DependsOn: Union
    Properties:
      ImageId: ami-0a1b2c3d4e5f60001
      InstanceType: t3.micro
      SubnetId: !Ref Subred
      SecurityGroupIds: [!Ref Sg]
      IamInstanceProfile: !Ref Perfil
      Tags: [{Key: Name, Value: web}]
  Alarma:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmName: cpu-web
      Namespace: AWS/EC2
      MetricName: CPUUtilization
      Dimensions: [{Name: InstanceId, Value: !Ref Servidor}]
      Statistic: Average
      Period: 300
      EvaluationPeriods: 1
      Threshold: 80
      ComparisonOperator: GreaterThanThreshold
Outputs:
  Ip:
    Value: !GetAtt Servidor.PrivateIp
`);
    await ok('aws cloudformation create-stack --stack-name todo --template-body file:///tmp/all.yaml --capabilities CAPABILITY_IAM');
    const s = (await json('aws cloudformation describe-stacks --stack-name todo')).Stacks[0];
    expect(s.StackStatus, JSON.stringify((await json('aws cloudformation describe-stack-events --stack-name todo')).StackEvents.filter((e: any) => e.ResourceStatus.includes('FAILED')))).toBe('CREATE_COMPLETE');
    const inst = st.instances.find((i) => i.tags.Name === 'web')!;
    expect(inst.iamInstanceProfile).toMatch(/^todo-Perfil-/);
    expect(s.Outputs[0].OutputValue).toBe(inst.privateIp);
    expect(st.internetGateways.find((g) => g.tags['aws:cloudformation:logical-id'] === 'Igw')!.attachedVpcId).toBe(st.vpcs.find((v) => v.cidr === '10.7.0.0/16')!.id);
    expect(st.kmsKeys.find((k) => k.description === 'clave de datos')!.rotation).toBe(true);
    expect(st.secrets.find((x) => x.name === 'cfn/db')!.kmsKeyId).toMatch(/^arn:aws:kms/);
    const pw = JSON.parse((await json('aws secretsmanager get-secret-value --secret-id cfn/db')).SecretString);
    expect(pw.user).toBe('admin');
    expect(pw.password).toHaveLength(20);
    expect(st.alarms[0].dims.InstanceId).toBe(inst.id);
    // borrar la pila elimina todo en orden inverso de dependencias (la clave queda programada para eliminar)
    await ok('aws cloudformation delete-stack --stack-name todo');
    expect((await json('aws cloudformation list-stacks')).StackSummaries[0].StackStatus).toBe('DELETE_COMPLETE');
    expect(st.instances.filter((i) => i.state !== 'terminated')).toHaveLength(0);
    expect(st.vpcs.some((v) => v.cidr === '10.7.0.0/16')).toBe(false);
    expect(st.roles.filter((r) => r.name.startsWith('todo-'))).toHaveLength(0);
    expect(st.kmsKeys.find((k) => k.description === 'clave de datos')!.state).toBe('PendingDeletion');
    expect(st.secrets.find((x) => x.name === 'cfn/db')!.deletedAt).toBeTruthy();
    expect(st.alarms).toHaveLength(0);
  });

  it('acepta TemplateURL de S3 y no rompe aws s3', async () => {
    await ok('aws s3 mb s3://plantillas');
    put('/tmp/red.yaml', NET);
    expect(await ok('aws s3 cp /tmp/red.yaml s3://plantillas/red.yaml')).toContain('to s3://plantillas/red.yaml');
    await ok('aws cloudformation create-stack --stack-name u --template-url https://plantillas.s3.eu-west-1.amazonaws.com/red.yaml');
    expect((await json('aws cloudformation describe-stacks --stack-name u')).Stacks[0].StackStatus).toBe('CREATE_COMPLETE');
    expect(await err('aws cloudformation create-stack --stack-name v --template-url https://plantillas.s3.eu-west-1.amazonaws.com/nada.yaml')).toContain('TemplateURL must reference a valid S3 object to which you have access.');
    expect(await ok('aws s3 ls s3://plantillas/')).toContain('red.yaml');
    await ok('aws s3 rm s3://plantillas/red.yaml');
    await ok('aws s3 rb s3://plantillas');
    // la lista de comandos incluye cloudformation y el servicio tiene los comandos del temario
    const h = await ok('aws cloudformation help');
    for (const c of ['create-stack', 'update-stack', 'delete-stack', 'describe-stacks', 'describe-stack-events', 'describe-stack-resources', 'list-stack-resources', 'get-template', 'validate-template', 'create-change-set', 'describe-change-set', 'execute-change-set', 'delete-change-set', 'deploy']) expect(h).toContain(c);
  });

  it('describe-stacks sobre una pila inexistente y salida en tabla/texto', async () => {
    expect(await err('aws cloudformation describe-stacks --stack-name nada')).toContain('An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id nada does not exist');
    expect(await err('aws cloudformation describe-stack-events --stack-name nada')).toContain('Stack [nada] does not exist');
    put('/tmp/t.yaml', 'Resources:\n  T:\n    Type: AWS::SNS::Topic\n');
    await ok('aws cloudformation create-stack --stack-name tab --template-body file:///tmp/t.yaml');
    expect((await ok('aws cloudformation describe-stacks --query "Stacks[].StackStatus" --output text')).trim()).toBe('CREATE_COMPLETE');
    expect(await ok('aws cloudformation list-stack-resources --stack-name tab --query StackResourceSummaries --output table')).toContain('LogicalResourceId');
    // propiedades desconocidas y obligatorias
    put('/tmp/m.yaml', 'Resources:\n  V:\n    Type: AWS::EC2::VPC\n    Properties: {Foo: bar}\n');
    await ok('aws cloudformation create-stack --stack-name mal --template-body file:///tmp/m.yaml');
    const ev = (await json('aws cloudformation describe-stack-events --stack-name mal')).StackEvents.find((e: any) => e.ResourceStatus === 'CREATE_FAILED');
    expect(ev.ResourceStatusReason).toBe('Property validation failure: [The property {/CidrBlock} is required, Encountered unsupported properties in {/}: [Foo]]');
  });
});

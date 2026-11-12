import { describe, it, expect, beforeEach } from 'vitest';
import { freshState } from '../src/engine/store';
import { newShell, runString, type Shell } from '../src/shell';
import { parse } from '../src/shell/parser';
import { jq } from '../src/shell/jq';
import { parseShorthand } from '../src/shell/aws/framework';
import type { CloudState } from '../src/engine/types';

let st: CloudState;
let sh: Shell;
beforeEach(() => {
  st = freshState('Ana');
  sh = newShell(st);
});
const run = async (cmd: string) => {
  const r = await runString(sh, cmd);
  return r;
};
const out = async (cmd: string) => (await run(cmd)).out;

describe('bash', () => {
  it('tuberías, variables y sustitución de comandos', async () => {
    expect(await out('echo hola | tr a-z A-Z')).toBe('HOLA\n');
    expect(await out('X=mundo; echo "hola $X"')).toBe('hola mundo\n');
    expect(await out('echo $(echo a b | wc -w)')).toBe('2\n');
  });
  it('redirecciones y here-documents', async () => {
    await run('cat > /tmp/p.json <<EOF\n{"a": 1}\nEOF');
    expect(await out('cat /tmp/p.json')).toBe('{"a": 1}\n');
    await run('echo uno > /tmp/x.txt && echo dos >> /tmp/x.txt');
    expect(await out('cat /tmp/x.txt')).toBe('uno\ndos\n');
  });
  it('here-document con expansión de variables', async () => {
    await run('B=mi-bucket\ncat > /tmp/p.json <<EOF\n{"Resource": "arn:aws:s3:::$B/*"}\nEOF');
    expect(await out('cat /tmp/p.json')).toContain('arn:aws:s3:::mi-bucket/*');
  });
  it('if, for y comparaciones', async () => {
    expect(await out('for i in 1 2 3; do echo n$i; done')).toBe('n1\nn2\nn3\n');
    expect(await out('if [ 3 -gt 2 ]; then echo si; else echo no; fi')).toBe('si\n');
    expect(await out('false || echo alt')).toBe('alt\n');
  });
  it('comandos inexistentes devuelven 127', async () => {
    const r = await run('nope');
    expect(r.code).toBe(127);
    expect(r.err).toContain('command not found');
  });
  it('el parser rechaza comillas sin cerrar', () => {
    expect(() => parse('echo "abc')).toThrow();
  });
});

describe('jq', () => {
  it('rutas, iteración y filtros', () => {
    const d = { a: [{ n: 'x', v: 1 }, { n: 'y', v: 2 }] };
    expect(jq('.a[].n', d)).toEqual(['x', 'y']);
    expect(jq('.a | map(.v) | add', d)).toEqual([3]);
    expect(jq('.a[] | select(.v > 1) | .n', d)).toEqual(['y']);
    expect(jq('{k: .a[0].n}', d)).toEqual([{ k: 'x' }]);
  });
});

describe('sintaxis abreviada', () => {
  it('Key=a,Value=b', () => {
    expect(parseShorthand('Key=Name,Value=web')).toEqual({ Key: 'Name', Value: 'web' });
    expect(parseShorthand('Name=instance-state-name,Values=running,stopped')).toEqual({ Name: 'instance-state-name', Values: ['running', 'stopped'] });
  });
});

describe('aws cli', () => {
  it('sts get-caller-identity', async () => {
    const r = JSON.parse(await out('aws sts get-caller-identity'));
    expect(r.Arn).toBe(`arn:aws:iam::${st.account.id}:user/ana`);
  });
  it('sin credenciales falla como el CLI real', async () => {
    st.cli.profiles.default = { region: 'eu-west-1' };
    const r = await run('aws sts get-caller-identity');
    expect(r.err).toContain('Unable to locate credentials');
  });
  it('falta región', async () => {
    delete st.cli.profiles.default.region;
    const r = await run('aws ec2 describe-vpcs');
    expect(r.err).toContain('You must specify a region');
  });
  it('--query y --output', async () => {
    expect((await out("aws sts get-caller-identity --query Account --output text")).trim()).toBe(st.account.id);
    const t = await out('aws ec2 describe-vpcs --query "Vpcs[].{id:VpcId,cidr:CidrBlock}" --output table');
    expect(t).toContain('172.31.0.0/16');
    expect(t.startsWith('+')).toBe(true);
  });
  it('los errores usan el formato del CLI', async () => {
    const r = await run('aws iam get-user --user-name nadie');
    expect(r.err).toContain('An error occurred (NoSuchEntity) when calling the GetUser operation: The user with name nadie cannot be found.');
    expect(r.code).toBe(254);
  });
  it('flujo de red: VPC, subred, IGW y SG con variables', async () => {
    await run('VPC=$(aws ec2 create-vpc --cidr-block 10.0.0.0/16 --query Vpc.VpcId --output text)');
    expect(st.vpcs.find((v) => v.cidr === '10.0.0.0/16')).toBeTruthy();
    const r = await run('aws ec2 create-subnet --vpc-id $VPC --cidr-block 10.0.1.0/24');
    expect(JSON.parse(r.out).Subnet.CidrBlock).toBe('10.0.1.0/24');
    await run('SG=$(aws ec2 create-security-group --group-name web --description web --vpc-id $VPC --query GroupId --output text)');
    const a = await run('aws ec2 authorize-security-group-ingress --group-id $SG --protocol tcp --port 443 --cidr 0.0.0.0/0');
    expect(JSON.parse(a.out).Return).toBe(true);
    const dup = await run('aws ec2 authorize-security-group-ingress --group-id $SG --protocol tcp --port 443 --cidr 0.0.0.0/0');
    expect(dup.err).toContain('InvalidPermission.Duplicate');
  });
  it('IAM con documentos desde fichero (file://)', async () => {
    await run(`cat > /tmp/trust.json <<'EOF'\n{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}\nEOF`);
    const r = await run('aws iam create-role --role-name web --assume-role-policy-document file:///tmp/trust.json --query Role.Arn --output text');
    expect(r.out.trim()).toBe(`arn:aws:iam::${st.account.id}:role/web`);
    const bad = await run('aws iam create-role --role-name x --assume-role-policy-document "{no json"');
    expect(bad.err).toContain('MalformedPolicyDocument');
  });
  it('S3 de alto nivel: mb, cp, ls, sync y rb', async () => {
    expect((await out('aws s3 mb s3://ana-datos-1')).trim()).toBe('make_bucket: ana-datos-1');
    await run('echo hola > /tmp/f.txt');
    expect((await out('aws s3 cp /tmp/f.txt s3://ana-datos-1/f.txt')).trim()).toBe('upload: /tmp/f.txt to s3://ana-datos-1/f.txt');
    expect(await out('aws s3 ls s3://ana-datos-1/')).toMatch(/\s+5 f\.txt\n/);
    await run('mkdir -p /tmp/site/css && echo a > /tmp/site/index.html && echo b > /tmp/site/css/s.css');
    const sync = await out('aws s3 sync /tmp/site s3://ana-datos-1/web');
    expect(sync).toContain('s3://ana-datos-1/web/index.html');
    expect(sync).toContain('s3://ana-datos-1/web/css/s.css');
    expect(await out('aws s3 sync /tmp/site s3://ana-datos-1/web')).toBe('');
    const rb = await run('aws s3 rb s3://ana-datos-1');
    expect(rb.err).toContain('BucketNotEmpty');
    expect((await out('aws s3 rb s3://ana-datos-1 --force')).trim().split('\n').pop()).toBe('remove_bucket: ana-datos-1');
  });
  it('web estática pública con curl', async () => {
    await run('aws s3 mb s3://web-ana-1');
    await run('echo "<h1>Hola</h1>" > /tmp/index.html');
    await run('aws s3 cp /tmp/index.html s3://web-ana-1/index.html');
    await run('aws s3api put-bucket-website --bucket web-ana-1 --website-configuration \'{"IndexDocument":{"Suffix":"index.html"}}\'');
    const url = 'http://web-ana-1.s3-website-eu-west-1.amazonaws.com';
    expect(await out(`curl -s -o /dev/null -w "%{http_code}" ${url}`)).toBeDefined();
    expect((await run(`curl -s ${url}`)).out).toContain('AccessDenied');
    await run('aws s3api put-public-access-block --bucket web-ana-1 --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false');
    await run(`cat > /tmp/pol.json <<'EOF'\n{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":"*","Action":"s3:GetObject","Resource":"arn:aws:s3:::web-ana-1/*"}]}\nEOF`);
    const put = await run('aws s3api put-bucket-policy --bucket web-ana-1 --policy file:///tmp/pol.json');
    expect(put.err).toBe('');
    expect((await run(`curl -s ${url}`)).out).toContain('Hola');
  });
  it('credenciales temporales vía variables de entorno', async () => {
    await run(`cat > /tmp/t.json <<'EOF'\n{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::${st.account.id}:root"},"Action":"sts:AssumeRole"}]}\nEOF`);
    await run('aws iam create-role --role-name ro --assume-role-policy-document file:///tmp/t.json');
    await run('aws iam attach-role-policy --role-name ro --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess');
    await run(`CREDS=$(aws sts assume-role --role-arn arn:aws:iam::${st.account.id}:role/ro --role-session-name lab --output json)`);
    await run('export AWS_ACCESS_KEY_ID=$(echo $CREDS | jq -r .Credentials.AccessKeyId)');
    await run('export AWS_SECRET_ACCESS_KEY=$(echo $CREDS | jq -r .Credentials.SecretAccessKey)');
    await run('export AWS_SESSION_TOKEN=$(echo $CREDS | jq -r .Credentials.SessionToken)');
    const who = JSON.parse(await out('aws sts get-caller-identity'));
    expect(who.Arn).toContain(':assumed-role/ro/lab');
    const denied = await run('aws iam create-user --user-name x');
    expect(denied.err).toContain('AccessDenied');
  });
  it('cloudtrail lookup-events muestra lo ocurrido', async () => {
    await run('aws iam create-user --user-name luis');
    const r = JSON.parse(await out('aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=CreateUser'));
    expect(r.Events[0].EventName).toBe('CreateUser');
  });
});

describe('shorthand anidado', () => {
  it('listas de estructuras y estructuras anidadas', () => {
    expect(parseShorthand('ResourceType=instance,Tags=[{Key=Name,Value=web},{Key=Env,Value=dev}]')).toEqual({ ResourceType: 'instance', Tags: [{ Key: 'Name', Value: 'web' }, { Key: 'Env', Value: 'dev' }] });
    expect(parseShorthand('DeviceName=/dev/xvda,Ebs={VolumeSize=8,Encrypted=true}')).toEqual({ DeviceName: '/dev/xvda', Ebs: { VolumeSize: '8', Encrypted: 'true' } });
    expect(parseShorthand('Name=tag:Name,Values=a,b')).toEqual({ Name: 'tag:Name', Values: ['a', 'b'] });
  });
  it('lanzar con etiqueta y encontrarla por filtro, tal y como lo hace la consola web', async () => {
    const r = await run("aws ec2 run-instances --image-id ami-0a1b2c3d4e5f60001 --instance-type t3.micro --block-device-mappings DeviceName=/dev/xvda,Ebs={VolumeSize=12} --metadata-options HttpTokens=required --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=web}]'");
    expect(r.code, r.err).toBe(0);
    expect(await out('aws ec2 describe-instances --filters Name=tag:Name,Values=web --query Reservations[0].Instances[0].InstanceType --output text')).toBe('t3.micro\n');
  });
});

describe('asignaciones con comillas', () => {
  it('A="x y", A=\'x\' y expansión dentro', async () => {
    expect(await out('A="x y"; echo "$A"')).toBe('x y\n');
    expect(await out("A='uno'; B=\"${A}-dos\"; echo $B")).toBe('uno-dos\n');
    expect(await out('P="$(echo hola)"; echo $P')).toBe('hola\n');
    expect(await out('echo "A=1"')).toBe('A=1\n');
  });
});

describe('operaciones complementarias de EC2', () => {
  it('pares de claves, etiquetas, reinicio y tablas de rutas', async () => {
    st.settings.speed = 'instant';
    await run('aws ec2 create-key-pair --key-name k1');
    expect(await out('aws ec2 describe-key-pairs --query KeyPairs[].KeyName --output text')).toBe('k1\n');
    await run('aws ec2 delete-key-pair --key-name k1');
    expect((await out('aws ec2 describe-key-pairs --query KeyPairs[].KeyName --output text')).trim()).toBe('');
    await run('aws ec2 run-instances --image-id ami-0a1b2c3d4e5f60001 --instance-type t3.micro --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=w},{Key=Env,Value=dev}]"');
    const id = (await out('aws ec2 describe-instances --query Reservations[0].Instances[0].InstanceId --output text')).trim();
    await run(`aws ec2 delete-tags --resources ${id} --tags Key=Env`);
    expect(await out(`aws ec2 describe-instances --instance-ids ${id} --query Reservations[0].Instances[0].Tags[].Key --output text`)).toBe('Name\n');
    expect((await run(`aws ec2 reboot-instances --instance-ids ${id}`)).code).toBe(0);
    const vpc = (await out('aws ec2 create-vpc --cidr-block 10.9.0.0/16 --query Vpc.VpcId --output text')).trim();
    const rt = (await out(`aws ec2 create-route-table --vpc-id ${vpc} --query RouteTable.RouteTableId --output text`)).trim();
    expect((await run(`aws ec2 delete-route-table --route-table-id ${rt}`)).code).toBe(0);
    expect((await run(`aws ec2 delete-route-table --route-table-id ${rt}`)).err).toContain('InvalidRouteTableID.NotFound');
  });
});

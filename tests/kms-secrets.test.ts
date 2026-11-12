import { describe, it, expect, beforeEach } from 'vitest';
import { freshState } from '../src/engine/store';
import { newShell, runString, type Shell } from '../src/shell';
import { setClock } from '../src/engine/util';
import type { CloudState } from '../src/engine/types';

let st: CloudState;
let sh: Shell;
beforeEach(() => {
  setClock(null);
  st = freshState('Ana');
  sh = newShell(st);
});
const run = (cmd: string) => runString(sh, cmd);
const ok = async (cmd: string) => {
  const r = await run(cmd);
  expect(r.err, cmd).toBe('');
  return r.out;
};
const json = async (cmd: string) => JSON.parse(await ok(cmd));
const err = async (cmd: string) => (await run(cmd)).err;
const RAW = '--cli-binary-format raw-in-base64-out';

/** Usuario sin permisos propios con claves de acceso; devuelve el prefijo de entorno para actuar como él. */
async function newUser(name: string, policy?: object) {
  await ok(`aws iam create-user --user-name ${name}`);
  const k = await json(`aws iam create-access-key --user-name ${name}`);
  if (policy) await ok(`aws iam put-user-policy --user-name ${name} --policy-name p --policy-document '${JSON.stringify(policy)}'`);
  return `AWS_ACCESS_KEY_ID=${k.AccessKey.AccessKeyId} AWS_SECRET_ACCESS_KEY=${k.AccessKey.SecretAccessKey} AWS_DEFAULT_REGION=eu-west-1`;
}

describe('KMS', () => {
  it('crea claves, alias y cifra/descifra de ida y vuelta', async () => {
    const k = (await json('aws kms create-key --description "datos"')).KeyMetadata;
    expect(k).toMatchObject({ KeyState: 'Enabled', KeyManager: 'CUSTOMER', KeySpec: 'SYMMETRIC_DEFAULT', Enabled: true, Description: 'datos' });
    expect(k.Arn).toMatch(/^arn:aws:kms:eu-west-1:\d{12}:key\/[0-9a-f-]{36}$/);
    await ok(`aws kms create-alias --alias-name alias/mi-clave --target-key-id ${k.KeyId}`);
    expect(await err(`aws kms create-alias --alias-name alias/mi-clave --target-key-id ${k.KeyId}`)).toContain('AlreadyExistsException');
    expect(await err(`aws kms create-alias --alias-name mi-clave --target-key-id ${k.KeyId}`)).toContain('InvalidAliasNameException');
    expect((await json('aws kms list-aliases')).Aliases.map((a: any) => a.AliasName)).toContain('alias/mi-clave');
    expect(await err('aws kms encrypt --key-id alias/mi-clave --plaintext hello')).toContain('Invalid base64: "hello"');
    const enc = await json(`aws kms encrypt --key-id alias/mi-clave --plaintext "hola mundo" ${RAW}`);
    expect(enc.KeyId).toBe(k.Arn);
    const dec = await json(`aws kms decrypt --ciphertext-blob ${enc.CiphertextBlob}`);
    expect(atob(dec.Plaintext)).toBe('hola mundo');
    expect(dec.KeyId).toBe(k.Arn);
    // Binario por fichero y tubería con base64
    await ok(`aws kms encrypt --key-id alias/mi-clave --plaintext "secreto" ${RAW} --query CiphertextBlob --output text | base64 --decode > /tmp/enc.bin`);
    expect((await ok('aws kms decrypt --ciphertext-blob fileb:///tmp/enc.bin --query Plaintext --output text | base64 --decode')).trim()).toBe('secreto');
  });

  it('solo la clave correcta descifra, el contexto debe coincidir y los blobs corruptos fallan', async () => {
    const a = (await json('aws kms create-key')).KeyMetadata.KeyId;
    const b = (await json('aws kms create-key')).KeyMetadata.KeyId;
    const enc = await json(`aws kms encrypt --key-id ${a} --plaintext x ${RAW} --encryption-context app=web`);
    expect(await err(`aws kms decrypt --ciphertext-blob ${enc.CiphertextBlob}`)).toContain('InvalidCiphertextException');
    expect(await err(`aws kms decrypt --ciphertext-blob ${enc.CiphertextBlob} --encryption-context app=otra`)).toContain('InvalidCiphertextException');
    expect(await err(`aws kms decrypt --ciphertext-blob ${enc.CiphertextBlob} --encryption-context app=web --key-id ${b}`)).toContain('IncorrectKeyException');
    await ok(`aws kms decrypt --ciphertext-blob ${enc.CiphertextBlob} --encryption-context app=web --key-id ${a}`);
    expect(await err(`aws kms decrypt --ciphertext-blob ${btoa('basura')}`)).toContain('InvalidCiphertextException');
    const re = await json(`aws kms re-encrypt --ciphertext-blob ${enc.CiphertextBlob} --source-encryption-context app=web --destination-key-id ${b}`);
    expect(re.KeyId).toContain(b);
    const dec = await json(`aws kms decrypt --ciphertext-blob ${re.CiphertextBlob} --key-id ${b}`);
    expect(atob(dec.Plaintext)).toBe('x');
  });

  it('generate-data-key devuelve clave en claro y cifrada coherentes', async () => {
    const k = (await json('aws kms create-key')).KeyMetadata.KeyId;
    const dk = await json(`aws kms generate-data-key --key-id ${k} --key-spec AES_256`);
    expect(atob(dk.Plaintext)).toHaveLength(32);
    const dec = await json(`aws kms decrypt --ciphertext-blob ${dk.CiphertextBlob}`);
    expect(dec.Plaintext).toBe(dk.Plaintext);
    expect(await err(`aws kms generate-data-key --key-id ${k} --key-spec AES_999`)).toContain('ValidationException');
  });

  it('deshabilitada y pendiente de eliminación (ventana 7-30 días)', async () => {
    const k = (await json('aws kms create-key')).KeyMetadata;
    const enc = await json(`aws kms encrypt --key-id ${k.KeyId} --plaintext x ${RAW}`);
    await ok(`aws kms disable-key --key-id ${k.KeyId}`);
    expect(await err(`aws kms encrypt --key-id ${k.KeyId} --plaintext x ${RAW}`)).toContain(`DisabledException) when calling the Encrypt operation: ${k.Arn} is disabled.`);
    expect(await err(`aws kms decrypt --ciphertext-blob ${enc.CiphertextBlob}`)).toContain('DisabledException');
    await ok(`aws kms enable-key --key-id ${k.KeyId}`);
    expect(await err(`aws kms schedule-key-deletion --key-id ${k.KeyId} --pending-window-in-days 3`)).toContain('greater than or equal to 7');
    expect(await err(`aws kms schedule-key-deletion --key-id ${k.KeyId} --pending-window-in-days 31`)).toContain('less than or equal to 30');
    const t0 = Date.now();
    setClock(() => t0);
    const sched = await json(`aws kms schedule-key-deletion --key-id ${k.KeyId} --pending-window-in-days 7`);
    expect(sched).toMatchObject({ KeyState: 'PendingDeletion', PendingWindowInDays: 7 });
    expect(await err(`aws kms encrypt --key-id ${k.KeyId} --plaintext x ${RAW}`)).toContain(`KMSInvalidStateException) when calling the Encrypt operation: ${k.Arn} is pending deletion.`);
    expect((await json(`aws kms describe-key --key-id ${k.KeyId}`)).KeyMetadata).toMatchObject({ KeyState: 'PendingDeletion', Enabled: false });
    await ok(`aws kms cancel-key-deletion --key-id ${k.KeyId}`);
    expect((await json(`aws kms describe-key --key-id ${k.KeyId}`)).KeyMetadata.KeyState).toBe('Disabled');
    await ok(`aws kms schedule-key-deletion --key-id ${k.KeyId} --pending-window-in-days 7`);
    setClock(() => t0 + 8 * 86_400_000);
    expect(await err(`aws kms describe-key --key-id ${k.KeyId}`)).toContain('NotFoundException');
  });

  it('rotación: periodo, estado y límites', async () => {
    const k = (await json('aws kms create-key')).KeyMetadata.KeyId;
    expect((await json(`aws kms get-key-rotation-status --key-id ${k}`)).KeyRotationEnabled).toBe(false);
    expect(await err(`aws kms enable-key-rotation --key-id ${k} --rotation-period-in-days 30`)).toContain('ValidationException');
    await ok(`aws kms enable-key-rotation --key-id ${k} --rotation-period-in-days 180`);
    const r = await json(`aws kms get-key-rotation-status --key-id ${k}`);
    expect(r).toMatchObject({ KeyRotationEnabled: true, RotationPeriodInDays: 180 });
    expect(r.NextRotationDate).toBeTruthy();
  });

  it('política de clave: el administrador no puede cifrar salvo que se le conceda', async () => {
    const adminArn = st.me.arn;
    const policy = {
      Version: '2012-10-17',
      Statement: [
        { Sid: 'Admin', Effect: 'Allow', Principal: { AWS: adminArn }, Action: ['kms:Create*', 'kms:Describe*', 'kms:Enable*', 'kms:List*', 'kms:Put*', 'kms:Update*', 'kms:Revoke*', 'kms:Disable*', 'kms:Get*', 'kms:Delete*', 'kms:ScheduleKeyDeletion', 'kms:CancelKeyDeletion', 'kms:TagResource'], Resource: '*' },
      ],
    };
    const k = (await json(`aws kms create-key --policy '${JSON.stringify(policy)}'`)).KeyMetadata;
    // ana tiene AdministratorAccess en IAM, pero la política de clave no delega en IAM ni le da Encrypt.
    const e = await err(`aws kms encrypt --key-id ${k.KeyId} --plaintext x ${RAW}`);
    expect(e).toContain('AccessDeniedException');
    expect(e).toContain(`User: ${adminArn} is not authorized to perform: kms:Encrypt on resource: ${k.Arn} because no resource-based policy allows the kms:Encrypt action`);
    await ok(`aws kms describe-key --key-id ${k.KeyId}`); // las acciones de administración sí
    // Se le concede mediante un grant... (el administrador puede crear grants)
    await ok(`aws kms create-grant --key-id ${k.KeyId} --grantee-principal ${adminArn} --operations Encrypt Decrypt`);
    await ok(`aws kms encrypt --key-id ${k.KeyId} --plaintext x ${RAW}`);
    const grants = (await json(`aws kms list-grants --key-id ${k.KeyId}`)).Grants;
    expect(grants).toHaveLength(1);
    await ok(`aws kms revoke-grant --key-id ${k.KeyId} --grant-id ${grants[0].GrantId}`);
    expect(await err(`aws kms encrypt --key-id ${k.KeyId} --plaintext x ${RAW}`)).toContain('AccessDeniedException');
    // Y también editando la política (incluye al usuario como usuario de la clave).
    const p2 = { ...policy, Statement: [...policy.Statement, { Sid: 'Use', Effect: 'Allow', Principal: { AWS: adminArn }, Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey*'], Resource: '*' }] };
    await ok(`aws kms put-key-policy --key-id ${k.KeyId} --policy-name default --policy '${JSON.stringify(p2)}'`);
    await ok(`aws kms encrypt --key-id ${k.KeyId} --plaintext x ${RAW}`);
  });

  it('la política por defecto delega en IAM: sin permiso IAM se deniega con el mensaje de identidad', async () => {
    const k = (await json('aws kms create-key')).KeyMetadata;
    const luis = await newUser('luis');
    expect(await err(`${luis} aws kms encrypt --key-id ${k.KeyId} --plaintext x ${RAW}`)).toContain('because no identity-based policy allows the kms:Encrypt action');
    await ok(`aws iam put-user-policy --user-name luis --policy-name p --policy-document '${JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'kms:Encrypt', Resource: k.Arn }] })}'`);
    await ok(`${luis} aws kms encrypt --key-id ${k.KeyId} --plaintext x ${RAW}`);
    expect(await err(`${luis} aws kms decrypt --ciphertext-blob ${(await json(`aws kms encrypt --key-id ${k.KeyId} --plaintext x ${RAW}`)).CiphertextBlob}`)).toContain('kms:Decrypt');
    // Un Deny explícito en IAM gana a todo.
    await ok(`aws iam put-user-policy --user-name luis --policy-name d --policy-document '${JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: 'kms:*', Resource: '*' }] })}'`);
    expect(await err(`${luis} aws kms encrypt --key-id ${k.KeyId} --plaintext x ${RAW}`)).toContain('with an explicit deny in an identity-based policy');
  });

  it('evita bloquear la política de clave', async () => {
    const policy = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::111122223333:root' }, Action: 'kms:*', Resource: '*' }] };
    expect(await err(`aws kms create-key --policy '${JSON.stringify(policy)}'`)).toContain('The new key policy will not allow you to update the key policy in the future.');
    await ok(`aws kms create-key --policy '${JSON.stringify(policy)}' --bypass-policy-lockout-safety-check`);
  });

  it('CloudTrail registra las llamadas a KMS', async () => {
    const k = (await json('aws kms create-key')).KeyMetadata.KeyId;
    await ok(`aws kms encrypt --key-id ${k} --plaintext x ${RAW}`);
    const ev = await json("aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventSource,AttributeValue=kms.amazonaws.com");
    expect(ev.Events.map((e: any) => e.EventName)).toEqual(expect.arrayContaining(['CreateKey', 'Encrypt']));
  });
});

describe('S3 con SSE-KMS', () => {
  it('exige permisos KMS al subir y al leer', async () => {
    await ok('aws s3 mb s3://cifrado-lab');
    const k = (await json('aws kms create-key')).KeyMetadata;
    await ok(`aws kms create-alias --alias-name alias/s3 --target-key-id ${k.KeyId}`);
    expect(await err(`aws s3api put-bucket-encryption --bucket cifrado-lab --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms","KMSMasterKeyID":"alias/no-existe"}}]}'`)).toContain('NotFoundException');
    await ok(`aws s3api put-bucket-encryption --bucket cifrado-lab --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms","KMSMasterKeyID":"alias/s3"}}]}'`);
    expect((await json('aws s3api get-bucket-encryption --bucket cifrado-lab')).ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault).toEqual({ SSEAlgorithm: 'aws:kms', KMSMasterKeyID: 'alias/s3' });
    await ok('echo dato > /tmp/d.txt');
    const put = await json('aws s3api put-object --bucket cifrado-lab --key d.txt --body /tmp/d.txt');
    expect(put).toMatchObject({ ServerSideEncryption: 'aws:kms', SSEKMSKeyId: k.Arn });
    const luis = await newUser('luis', { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }] });
    expect(await err(`${luis} aws s3 cp /tmp/d.txt s3://cifrado-lab/x.txt`)).toContain('kms:GenerateDataKey');
    expect(await err(`${luis} aws s3 cp s3://cifrado-lab/d.txt /tmp/o.txt`)).toContain('kms:Decrypt');
    await ok(`aws iam put-user-policy --user-name luis --policy-name k --policy-document '${JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['kms:GenerateDataKey', 'kms:Decrypt'], Resource: k.Arn }] })}'`);
    await ok(`${luis} aws s3 cp /tmp/d.txt s3://cifrado-lab/x.txt`);
    await ok(`${luis} aws s3 cp s3://cifrado-lab/d.txt /tmp/o.txt`);
    // Clave deshabilitada: nadie lee ni escribe.
    await ok(`aws kms disable-key --key-id ${k.KeyId}`);
    expect(await err('aws s3 cp s3://cifrado-lab/d.txt /tmp/o.txt')).toContain('KMS.DisabledException');
    expect(await err('aws s3 cp /tmp/d.txt s3://cifrado-lab/y.txt')).toContain('KMS.DisabledException');
  });
  it('la clave administrada por AWS (aws/s3) funciona sin permisos KMS propios', async () => {
    await ok('aws s3 mb s3://aws-managed');
    await ok(`aws s3api put-bucket-encryption --bucket aws-managed --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"}}]}'`);
    const luis = await newUser('luis', { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }] });
    await ok('echo hola > /tmp/h.txt');
    const r = await json(`${luis} aws s3api put-object --bucket aws-managed --key h.txt --body /tmp/h.txt`);
    expect(r.SSEKMSKeyId).toContain(':key/');
    await ok(`${luis} aws s3 cp s3://aws-managed/h.txt /tmp/o.txt`);
    expect((await json('aws kms list-aliases')).Aliases.map((a: any) => a.AliasName)).toContain('alias/aws/s3');
  });
  it('una política puede exigir SSE-KMS en la subida', async () => {
    await ok('aws s3 mb s3://exige-kms');
    const pol = { Version: '2012-10-17', Statement: [{ Sid: 'DenyUnencrypted', Effect: 'Deny', Principal: '*', Action: 's3:PutObject', Resource: 'arn:aws:s3:::exige-kms/*', Condition: { StringNotEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' } } }] };
    await ok(`aws s3api put-bucket-policy --bucket exige-kms --policy '${JSON.stringify(pol)}'`);
    await ok('echo a > /tmp/a.txt');
    expect(await err('aws s3 cp /tmp/a.txt s3://exige-kms/a.txt')).toContain('explicit deny');
    await ok('aws s3 cp /tmp/a.txt s3://exige-kms/a.txt --sse aws:kms');
  });
});

describe('Secrets Manager', () => {
  it('ciclo de vida de un secreto con versiones AWSCURRENT / AWSPREVIOUS', async () => {
    const c = await json(`aws secretsmanager create-secret --name prod/db --description "BD" --secret-string '{"user":"app","password":"uno"}'`);
    expect(c.ARN).toMatch(/^arn:aws:secretsmanager:eu-west-1:\d{12}:secret:prod\/db-[A-Za-z0-9]{6}$/);
    expect(await err(`aws secretsmanager create-secret --name prod/db --secret-string x`)).toContain('ResourceExistsException');
    expect(await err(`aws secretsmanager create-secret --name "mal nombre" --secret-string x`)).toContain('Invalid name');
    const g = await json('aws secretsmanager get-secret-value --secret-id prod/db');
    expect(g).toMatchObject({ Name: 'prod/db', VersionStages: ['AWSCURRENT'] });
    expect(JSON.parse(g.SecretString).password).toBe('uno');
    const put = await json(`aws secretsmanager put-secret-value --secret-id prod/db --secret-string '{"user":"app","password":"dos"}'`);
    expect(put.VersionStages).toEqual(['AWSCURRENT']);
    expect(JSON.parse((await json('aws secretsmanager get-secret-value --secret-id prod/db')).SecretString).password).toBe('dos');
    const prev = await json('aws secretsmanager get-secret-value --secret-id prod/db --version-stage AWSPREVIOUS');
    expect(prev.VersionId).toBe(g.VersionId);
    expect(JSON.parse(prev.SecretString).password).toBe('uno');
    const d = await json('aws secretsmanager describe-secret --secret-id prod/db');
    expect(Object.values(d.VersionIdsToStages).flat().sort()).toEqual(['AWSCURRENT', 'AWSPREVIOUS']);
    expect(await err('aws secretsmanager get-secret-value --secret-id nada')).toContain("Secrets Manager can't find the specified secret.");
    expect(await err('aws secretsmanager get-secret-value --secret-id prod/db --version-stage AWSPENDING')).toContain('staging label: AWSPENDING');
    // Por ARN parcial y completo
    await ok(`aws secretsmanager get-secret-value --secret-id ${c.ARN}`);
    await ok(`aws secretsmanager get-secret-value --secret-id arn:aws:secretsmanager:eu-west-1:${st.account.id}:secret:prod/db`);
  });

  it('borrado con ventana de recuperación y restauración', async () => {
    await ok('aws secretsmanager create-secret --name tmp/x --secret-string abc');
    expect(await err('aws secretsmanager delete-secret --secret-id tmp/x --recovery-window-in-days 3')).toContain('between 7 and 30 days');
    expect(await err('aws secretsmanager delete-secret --secret-id tmp/x --recovery-window-in-days 7 --force-delete-without-recovery')).toContain('ForceDeleteWithoutRecovery in conjunction');
    const t0 = Date.now();
    setClock(() => t0);
    const del = await json('aws secretsmanager delete-secret --secret-id tmp/x --recovery-window-in-days 7');
    expect(new Date(del.DeletionDate).getTime() - t0).toBeGreaterThan(6.9 * 86_400_000);
    expect(await err('aws secretsmanager get-secret-value --secret-id tmp/x')).toContain('marked for deletion');
    expect(await err('aws secretsmanager create-secret --name tmp/x --secret-string z')).toContain('already scheduled for deletion');
    expect((await json('aws secretsmanager list-secrets')).SecretList).toHaveLength(0);
    expect((await json('aws secretsmanager list-secrets --include-planned-deletion')).SecretList).toHaveLength(1);
    expect((await json('aws secretsmanager describe-secret --secret-id tmp/x')).DeletedDate).toBeTruthy();
    await ok('aws secretsmanager restore-secret --secret-id tmp/x');
    expect((await json('aws secretsmanager get-secret-value --secret-id tmp/x')).SecretString).toBe('abc');
    await ok('aws secretsmanager delete-secret --secret-id tmp/x --recovery-window-in-days 7');
    setClock(() => t0 + 8 * 86_400_000);
    expect(await err('aws secretsmanager describe-secret --secret-id tmp/x')).toContain('ResourceNotFoundException');
    await ok('aws secretsmanager create-secret --name tmp/x --secret-string nuevo');
    await ok('aws secretsmanager delete-secret --secret-id tmp/x --force-delete-without-recovery');
    expect(await err('aws secretsmanager describe-secret --secret-id tmp/x')).toContain('ResourceNotFoundException');
  });

  it('rotación simulada genera una versión nueva conservando el JSON', async () => {
    await ok(`aws secretsmanager create-secret --name rot/db --secret-string '{"user":"app","password":"vieja"}'`);
    const r = await json('aws secretsmanager rotate-secret --secret-id rot/db --rotation-rules AutomaticallyAfterDays=15');
    expect(r.VersionId).toBeTruthy();
    const cur = JSON.parse((await json('aws secretsmanager get-secret-value --secret-id rot/db')).SecretString);
    expect(cur.user).toBe('app');
    expect(cur.password).not.toBe('vieja');
    const old = JSON.parse((await json('aws secretsmanager get-secret-value --secret-id rot/db --version-stage AWSPREVIOUS')).SecretString);
    expect(old.password).toBe('vieja');
    const d = await json('aws secretsmanager describe-secret --secret-id rot/db');
    expect(d).toMatchObject({ RotationEnabled: true, RotationRules: { AutomaticallyAfterDays: 15 } });
    expect(d.NextRotationDate).toBeTruthy();
    await ok('aws secretsmanager cancel-rotate-secret --secret-id rot/db');
    expect((await json('aws secretsmanager describe-secret --secret-id rot/db')).RotationEnabled).toBe(false);
  });

  it('cifrado con clave propia: sin permisos KMS el acceso falla, y con la clave deshabilitada también', async () => {
    const k = (await json('aws kms create-key')).KeyMetadata;
    await ok(`aws secretsmanager create-secret --name cmk/s --secret-string valor --kms-key-id ${k.KeyId}`);
    expect((await json('aws secretsmanager describe-secret --secret-id cmk/s')).KmsKeyId).toBe(k.KeyId);
    const luis = await newUser('luis', { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: '*' }] });
    expect(await err(`${luis} aws secretsmanager get-secret-value --secret-id cmk/s`)).toContain('AccessDeniedException) when calling the GetSecretValue operation: Access to KMS is not allowed');
    await ok(`aws iam put-user-policy --user-name luis --policy-name k --policy-document '${JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'kms:Decrypt', Resource: k.Arn }] })}'`);
    expect((await json(`${luis} aws secretsmanager get-secret-value --secret-id cmk/s`)).SecretString).toBe('valor');
    await ok(`aws kms disable-key --key-id ${k.KeyId}`);
    expect(await err('aws secretsmanager get-secret-value --secret-id cmk/s')).toContain('DecryptionFailure');
    await ok(`aws kms enable-key --key-id ${k.KeyId}`);
    expect((await json('aws secretsmanager get-secret-value --secret-id cmk/s')).SecretString).toBe('valor');
    // Cambiar de clave re-cifra
    const k2 = (await json('aws kms create-key')).KeyMetadata;
    await ok(`aws secretsmanager update-secret --secret-id cmk/s --kms-key-id ${k2.KeyId}`);
    expect((await json('aws secretsmanager get-secret-value --secret-id cmk/s')).SecretString).toBe('valor');
  });

  it('IAM por ARN, política de recurso y contraseña aleatoria', async () => {
    await ok('aws secretsmanager create-secret --name team/a --secret-string 1');
    await ok('aws secretsmanager create-secret --name other/b --secret-string 2');
    const luis = await newUser('luis', { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: `arn:aws:secretsmanager:eu-west-1:${st.account.id}:secret:team/*` }] });
    expect((await json(`${luis} aws secretsmanager get-secret-value --secret-id team/a`)).SecretString).toBe('1');
    expect(await err(`${luis} aws secretsmanager get-secret-value --secret-id other/b`)).toContain('AccessDeniedException) when calling the GetSecretValue operation: User: arn:aws:iam::'+st.account.id+':user/luis is not authorized to perform: secretsmanager:GetSecretValue on resource: other/b because no identity-based policy allows');
    const pol = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${st.account.id}:user/luis` }, Action: 'secretsmanager:GetSecretValue', Resource: '*' }] };
    await ok(`aws secretsmanager put-resource-policy --secret-id other/b --resource-policy '${JSON.stringify(pol)}'`);
    expect((await json(`${luis} aws secretsmanager get-secret-value --secret-id other/b`)).SecretString).toBe('2');
    expect(JSON.parse((await json('aws secretsmanager get-resource-policy --secret-id other/b')).ResourcePolicy).Statement).toHaveLength(1);
    const pw = (await json('aws secretsmanager get-random-password --password-length 20 --exclude-punctuation')).RandomPassword;
    expect(pw).toHaveLength(20);
    expect(pw).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('CloudTrail registra los accesos a secretos', async () => {
    await ok('aws secretsmanager create-secret --name audit/x --secret-string 1');
    await ok('aws secretsmanager get-secret-value --secret-id audit/x');
    const ev = await json('aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventSource,AttributeValue=secretsmanager.amazonaws.com');
    expect(ev.Events.map((e: any) => e.EventName)).toEqual(expect.arrayContaining(['CreateSecret', 'GetSecretValue']));
  });
});

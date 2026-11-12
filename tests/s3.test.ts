import { describe, it, expect, beforeEach } from 'vitest';
import { freshState } from '../src/engine/store';
import { resolveCaller, type Ctx } from '../src/engine/api';
import * as iam from '../src/engine/services/iam';
import * as s3 from '../src/engine/services/s3';
import { AwsError } from '../src/engine/errors';
import type { CloudState } from '../src/engine/types';

let st: CloudState;
const admin = (): Ctx => ({ s: st, region: 'eu-west-1', caller: resolveCaller(st, st.users[0].accessKeys[0].id) });
beforeEach(() => {
  st = freshState('Ana');
});
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AwsError) return e.code;
    throw e;
  }
  return 'OK';
};

describe('S3', () => {
  it('crea y valida nombres de bucket', () => {
    expect(code(() => s3.createBucket(admin(), { Bucket: 'AB' }))).toBe('InvalidBucketName');
    expect(code(() => s3.createBucket(admin(), { Bucket: 'mi-bucket-ana-1' }))).toBe('OK');
    expect(code(() => s3.createBucket(admin(), { Bucket: 'mi-bucket-ana-1' }))).toBe('BucketAlreadyOwnedByYou');
    expect(code(() => s3.createBucket(admin(), { Bucket: 'backup' }))).toBe('BucketAlreadyExists');
  });

  it('sube, lista y descarga objetos', () => {
    s3.createBucket(admin(), { Bucket: 'datos-ana' });
    s3.putObject(admin(), { Bucket: 'datos-ana', Key: 'a/b.txt', Body: 'hola' });
    s3.putObject(admin(), { Bucket: 'datos-ana', Key: 'c.txt', Body: 'x' });
    expect(s3.getObject(admin(), { Bucket: 'datos-ana', Key: 'a/b.txt' }).body).toBe('hola');
    const l = s3.listObjectsV2(admin(), { Bucket: 'datos-ana', Delimiter: '/' });
    expect(l.CommonPrefixes).toEqual(['a/']);
    expect(l.Contents.map((o) => o.key)).toEqual(['c.txt']);
    expect(code(() => s3.getObject(admin(), { Bucket: 'datos-ana', Key: 'no.txt' }))).toBe('NoSuchKey');
  });

  it('no se borra un bucket con objetos', () => {
    s3.createBucket(admin(), { Bucket: 'datos-ana' });
    s3.putObject(admin(), { Bucket: 'datos-ana', Key: 'a', Body: '1' });
    expect(code(() => s3.deleteBucket(admin(), { Bucket: 'datos-ana' }))).toBe('BucketNotEmpty');
    s3.deleteObject(admin(), { Bucket: 'datos-ana', Key: 'a' });
    expect(code(() => s3.deleteBucket(admin(), { Bucket: 'datos-ana' }))).toBe('OK');
  });

  it('el versionado conserva versiones y el borrado crea un marcador', () => {
    s3.createBucket(admin(), { Bucket: 'datos-ana' });
    s3.putBucketVersioning(admin(), { Bucket: 'datos-ana', Status: 'Enabled' });
    s3.putObject(admin(), { Bucket: 'datos-ana', Key: 'f', Body: 'v1' });
    s3.putObject(admin(), { Bucket: 'datos-ana', Key: 'f', Body: 'v2' });
    expect(st.buckets[0].versions['f']).toHaveLength(1);
    const del = s3.deleteObject(admin(), { Bucket: 'datos-ana', Key: 'f' }) as any;
    expect(del.DeleteMarker).toBe(true);
    expect(code(() => s3.getObject(admin(), { Bucket: 'datos-ana', Key: 'f' }))).toBe('NoSuchKey');
  });

  it('un usuario sin permisos recibe AccessDenied y con política de recurso puede leer', () => {
    s3.createBucket(admin(), { Bucket: 'datos-ana' });
    s3.putObject(admin(), { Bucket: 'datos-ana', Key: 'a', Body: '1' });
    iam.createUser(admin(), { UserName: 'luis' });
    const k = iam.createAccessKey(admin(), { UserName: 'luis' });
    const luis = (): Ctx => ({ s: st, region: 'eu-west-1', caller: resolveCaller(st, k.id) });
    expect(code(() => s3.getObject(luis(), { Bucket: 'datos-ana', Key: 'a' }))).toBe('AccessDenied');
    s3.putBucketPolicy(admin(), {
      Bucket: 'datos-ana',
      Policy: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { AWS: st.users.find((u) => u.name === 'luis')!.arn }, Action: 's3:GetObject', Resource: 'arn:aws:s3:::datos-ana/*' }] },
    });
    expect(code(() => s3.getObject(luis(), { Bucket: 'datos-ana', Key: 'a' }))).toBe('OK');
  });

  it('BlockPublicPolicy impide publicar un bucket hasta que se desactiva', () => {
    s3.createBucket(admin(), { Bucket: 'web-ana' });
    const pub = { Version: '2012-10-17', Statement: [{ Effect: 'Allow' as const, Principal: '*', Action: 's3:GetObject', Resource: 'arn:aws:s3:::web-ana/*' }] };
    expect(code(() => s3.putBucketPolicy(admin(), { Bucket: 'web-ana', Policy: pub }))).toBe('AccessDenied');
    s3.putPublicAccessBlock(admin(), { Bucket: 'web-ana', BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: false, RestrictPublicBuckets: false });
    expect(code(() => s3.putBucketPolicy(admin(), { Bucket: 'web-ana', Policy: pub }))).toBe('OK');
  });

  it('web estática: devuelve el index cuando la política es pública', () => {
    s3.createBucket(admin(), { Bucket: 'web-ana' });
    s3.putObject(admin(), { Bucket: 'web-ana', Key: 'index.html', Body: '<h1>Hola</h1>' });
    s3.putBucketWebsite(admin(), { Bucket: 'web-ana', IndexDocument: 'index.html' });
    expect(s3.anonymousGet(st, 'web-ana', '', true).status).toBe(403);
    s3.putPublicAccessBlock(admin(), { Bucket: 'web-ana', BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: false, RestrictPublicBuckets: false });
    s3.putBucketPolicy(admin(), { Bucket: 'web-ana', Policy: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: 'arn:aws:s3:::web-ana/*' }] } });
    const r = s3.anonymousGet(st, 'web-ana', '', true);
    expect(r.status).toBe(200);
    expect(r.body).toContain('Hola');
  });
});

describe('restaurar borrando la marca de borrado', () => {
  it('delete-object con VersionId de la marca devuelve el objeto', async () => {
    const { freshState } = await import('../src/engine/store');
    const { newShell, runString } = await import('../src/shell');
    const sh = newShell(freshState('Ana'));
    const run = (c: string) => runString(sh, c);
    await run('aws s3 mb s3://rest-bkt');
    await run('aws s3api put-bucket-versioning --bucket rest-bkt --versioning-configuration Status=Enabled');
    await run('echo v1 > /tmp/f.txt');
    await run('aws s3 cp /tmp/f.txt s3://rest-bkt/f.txt');
    const del = JSON.parse((await run('aws s3api delete-object --bucket rest-bkt --key f.txt')).out);
    expect(del.DeleteMarker).toBe(true);
    expect((await run('aws s3api head-object --bucket rest-bkt --key f.txt')).code).not.toBe(0);
    await run(`aws s3api delete-object --bucket rest-bkt --key f.txt --version-id ${del.VersionId}`);
    expect((await run('aws s3api head-object --bucket rest-bkt --key f.txt')).code).toBe(0);
  });
});

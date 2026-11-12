import { describe, it, expect, beforeEach } from 'vitest';
import { freshState } from '../src/engine/store';
import { newShell, runString, type Shell } from '../src/shell';
import { setClock } from '../src/engine/util';
import type { CloudState } from '../src/engine/types';

let st: CloudState;
let sh: Shell;
let T: number;
beforeEach(() => {
  T = Date.parse('2026-11-08T10:00:00Z');
  setClock(() => T);
  st = freshState('Ana');
  st.settings.speed = 'instant';
  sh = newShell(st);
});
const run = (cmd: string) => runString(sh, cmd);
const ok = async (cmd: string) => { const r = await run(cmd); expect(r.err, cmd).toBe(''); return r.out; };
const json = async (cmd: string) => JSON.parse(await ok(cmd));
const err = async (cmd: string) => (await run(cmd)).err;
const AMI = 'ami-0a1b2c3d4e5f60001';
const minutes = (m: number) => { T += m * 60_000; };

describe('CloudWatch: métricas', () => {
  it('put-metric-data, list-metrics y get-metric-statistics con agregación por periodo', async () => {
    await ok('aws cloudwatch put-metric-data --namespace Tienda --metric-name Pedidos --value 4 --unit Count --dimensions Name=Entorno,Value=prod');
    minutes(1);
    await ok('aws cloudwatch put-metric-data --namespace Tienda --metric-name Pedidos --value 6 --unit Count --dimensions Name=Entorno,Value=prod');
    const l = await json('aws cloudwatch list-metrics --namespace Tienda');
    expect(l.Metrics).toEqual([{ Namespace: 'Tienda', MetricName: 'Pedidos', Dimensions: [{ Name: 'Entorno', Value: 'prod' }] }]);
    const r = await json('aws cloudwatch get-metric-statistics --namespace Tienda --metric-name Pedidos --dimensions Name=Entorno,Value=prod --start-time 2026-11-08T09:55:00Z --end-time 2026-11-08T10:05:00Z --period 600 --statistics Sum Average SampleCount Maximum');
    expect(r.Label).toBe('Pedidos');
    expect(r.Datapoints).toHaveLength(1);
    expect(r.Datapoints[0]).toMatchObject({ Sum: 10, Average: 5, SampleCount: 2, Maximum: 6, Unit: 'Count' });
    expect(await err('aws cloudwatch put-metric-data --namespace AWS/EC2 --metric-name X --value 1')).toContain('InvalidParameterValue');
    expect(await err('aws cloudwatch get-metric-statistics --namespace Tienda --metric-name Pedidos --start-time 2026-11-08T09:55:00Z --end-time 2026-11-08T10:05:00Z --period 45 --statistics Sum')).toContain('multiple of 60');
  });

  it('las métricas de EC2 dependen del ciclo de vida de la instancia y son deterministas', async () => {
    const id = (await json(`aws ec2 run-instances --image-id ${AMI} --instance-type t3.micro`)).Instances[0].InstanceId;
    minutes(30);
    const q = `aws cloudwatch get-metric-statistics --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value=${id} --start-time 2026-11-08T09:00:00Z --end-time 2026-11-08T10:30:00Z --period 300 --statistics Average`;
    const a = await json(q);
    const b = await json(q);
    expect(a).toEqual(b);
    expect(a.Datapoints.length).toBeGreaterThanOrEqual(6);
    for (const d of a.Datapoints) { expect(d.Average).toBeGreaterThan(0); expect(d.Average).toBeLessThan(10); expect(d.Unit).toBe('Percent'); }
    expect((await json('aws cloudwatch list-metrics --namespace AWS/EC2')).Metrics.some((m: any) => m.MetricName === 'CPUUtilization')).toBe(true);
    await ok(`aws ec2 stop-instances --instance-ids ${id}`);
    minutes(30);
    const c = await json(`aws cloudwatch get-metric-statistics --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value=${id} --start-time 2026-11-08T10:31:00Z --end-time 2026-11-08T11:00:00Z --period 300 --statistics Average`);
    expect(c.Datapoints).toHaveLength(0);
  });
});

describe('CloudWatch: alarmas y SNS', () => {
  it('pasa de INSUFFICIENT_DATA a ALARM y a OK, ejecuta la acción SNS y guarda el historial', async () => {
    const topic = (await json('aws sns create-topic --name alertas')).TopicArn;
    expect(topic).toMatch(/^arn:aws:sns:eu-west-1:\d{12}:alertas$/);
    await ok(`aws cloudwatch put-metric-alarm --alarm-name errores --namespace Tienda --metric-name Errores --statistic Sum --period 60 --evaluation-periods 1 --threshold 5 --comparison-operator GreaterThanOrEqualToThreshold --alarm-actions ${topic}`);
    let a = (await json('aws cloudwatch describe-alarms --alarm-names errores')).MetricAlarms[0];
    expect(a).toMatchObject({ StateValue: 'INSUFFICIENT_DATA', StateReason: 'Unchecked: Initial alarm creation', AlarmActions: [topic], ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'missing' });
    await ok('aws cloudwatch put-metric-data --namespace Tienda --metric-name Errores --value 7');
    a = (await json('aws cloudwatch describe-alarms --alarm-names errores')).MetricAlarms[0];
    expect(a.StateValue).toBe('ALARM');
    expect(a.StateReason).toMatch(/^Threshold Crossed: 1 datapoint \[7\.0 \(08\/11\/26 10:00:00\)\] was greater than or equal to the threshold \(5\.0\)\.$/);
    expect(st.topics[0].messages).toHaveLength(1);
    expect(JSON.parse(st.topics[0].messages[0].message)).toMatchObject({ AlarmName: 'errores', NewStateValue: 'ALARM', OldStateValue: 'INSUFFICIENT_DATA' });
    const h = (await json('aws cloudwatch describe-alarm-history --alarm-name errores')).AlarmHistoryItems.map((x: any) => x.HistorySummary);
    expect(h).toContain('Alarm updated from INSUFFICIENT_DATA to ALARM');
    expect(h).toContain(`Successfully executed action ${topic}`);
    minutes(3);
    a = (await json('aws cloudwatch describe-alarms --alarm-names errores')).MetricAlarms[0];
    expect(a.StateValue).toBe('INSUFFICIENT_DATA');
    await ok('aws cloudwatch put-metric-data --namespace Tienda --metric-name Errores --value 1');
    expect((await json('aws cloudwatch describe-alarms --state-value OK')).MetricAlarms.map((x: any) => x.AlarmName)).toEqual(['errores']);
  });

  it('treat-missing-data notBreaching evita INSUFFICIENT_DATA y set-alarm-state se mantiene un minuto', async () => {
    await ok('aws cloudwatch put-metric-alarm --alarm-name sin-datos --namespace X --metric-name Y --statistic Average --period 60 --evaluation-periods 2 --threshold 1 --comparison-operator GreaterThanThreshold --treat-missing-data notBreaching');
    minutes(1);
    expect((await json('aws cloudwatch describe-alarms')).MetricAlarms[0].StateValue).toBe('OK');
    await ok('aws cloudwatch set-alarm-state --alarm-name sin-datos --state-value ALARM --state-reason "prueba"');
    expect((await json('aws cloudwatch describe-alarms')).MetricAlarms[0]).toMatchObject({ StateValue: 'ALARM', StateReason: 'prueba' });
    minutes(2);
    expect((await json('aws cloudwatch describe-alarms')).MetricAlarms[0].StateValue).toBe('OK');
  });

  it('valida parámetros y la CPU alta por etiqueta dispara la alarma', async () => {
    expect(await err('aws cloudwatch put-metric-alarm --alarm-name a --namespace X --metric-name Y --period 45 --evaluation-periods 1 --threshold 1 --comparison-operator GreaterThanThreshold')).toContain('Period');
    expect(await err('aws cloudwatch put-metric-alarm --alarm-name a --namespace X --metric-name Y --period 60 --evaluation-periods 1 --threshold 1 --comparison-operator Mayor')).toContain('comparisonOperator');
    expect(await err('aws cloudwatch delete-alarms --alarm-names nope')).toContain('do not exist');
    const id = (await json(`aws ec2 run-instances --image-id ${AMI} --instance-type t3.micro --tag-specifications 'ResourceType=instance,Tags=[{Key=simulador:carga,Value=alta}]'`)).Instances[0].InstanceId;
    await ok(`aws cloudwatch put-metric-alarm --alarm-name cpu --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value=${id} --statistic Average --period 300 --evaluation-periods 1 --threshold 80 --comparison-operator GreaterThanThreshold`);
    minutes(1);
    expect((await json('aws cloudwatch describe-alarms')).MetricAlarms[0].StateValue).toBe('ALARM');
  });

  it('SNS: suscripciones y publicación', async () => {
    const t = (await json('aws sns create-topic --name t1')).TopicArn;
    expect((await json('aws sns create-topic --name t1')).TopicArn).toBe(t);
    expect((await json(`aws sns subscribe --topic-arn ${t} --protocol email --notification-endpoint ana@example.com`)).SubscriptionArn).toBe('pending confirmation');
    expect((await json(`aws sns list-subscriptions-by-topic --topic-arn ${t}`)).Subscriptions[0]).toMatchObject({ Protocol: 'email', SubscriptionArn: 'PendingConfirmation' });
    expect((await json(`aws sns publish --topic-arn ${t} --message hola`)).MessageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await err(`aws sns subscribe --topic-arn ${t} --protocol correo --notification-endpoint x`)).toContain('InvalidParameter');
    expect(await err('aws sns publish --topic-arn arn:aws:sns:eu-west-1:123456789012:nada --message x')).toContain('NotFound');
  });
});

describe('CloudWatch Logs', () => {
  it('grupos, flujos, eventos, filtros y retención', async () => {
    await ok('aws logs create-log-group --log-group-name /app/web');
    expect(await err('aws logs create-log-group --log-group-name /app/web')).toContain('ResourceAlreadyExistsException');
    expect(await err('aws logs create-log-stream --log-group-name /nada --log-stream-name s')).toContain('The specified log group does not exist.');
    await ok('aws logs create-log-stream --log-group-name /app/web --log-stream-name i-1');
    const put = await json(`aws logs put-log-events --log-group-name /app/web --log-stream-name i-1 --log-events timestamp=${T},message="INFO arranque" timestamp=${T + 1},message="ERROR fallo de base de datos"`);
    expect(put.nextSequenceToken).toBeTruthy();
    const g = await json(`aws logs get-log-events --log-group-name /app/web --log-stream-name i-1`);
    expect(g.events.map((e: any) => e.message)).toEqual(['INFO arranque', 'ERROR fallo de base de datos']);
    const f = await json('aws logs filter-log-events --log-group-name /app/web --filter-pattern ERROR');
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({ logStreamName: 'i-1', message: 'ERROR fallo de base de datos' });
    expect((await json('aws logs filter-log-events --log-group-name /app/web --filter-pattern "?arranque ?fallo"')).events).toHaveLength(2);
    expect((await json('aws logs filter-log-events --log-group-name /app/web --filter-pattern "-ERROR"')).events).toHaveLength(1);
    await ok('aws logs put-retention-policy --log-group-name /app/web --retention-in-days 7');
    expect(await err('aws logs put-retention-policy --log-group-name /app/web --retention-in-days 8')).toContain('InvalidParameterException');
    expect((await json('aws logs describe-log-groups')).logGroups[0]).toMatchObject({ logGroupName: '/app/web', retentionInDays: 7 });
    T += 8 * 86_400_000;
    expect((await json(`aws logs get-log-events --log-group-name /app/web --log-stream-name i-1`)).events).toHaveLength(0);
  });

  it('un filtro de métrica convierte ERROR en una métrica que dispara una alarma', async () => {
    await ok('aws logs create-log-group --log-group-name /app/api');
    await ok('aws logs create-log-stream --log-group-name /app/api --log-stream-name s1');
    await ok('aws logs put-metric-filter --log-group-name /app/api --filter-name errores --filter-pattern ERROR --metric-transformations metricName=Errores,metricNamespace=Api,metricValue=1');
    expect((await json('aws logs describe-metric-filters --log-group-name /app/api')).metricFilters[0].metricTransformations[0]).toEqual({ metricName: 'Errores', metricNamespace: 'Api', metricValue: '1' });
    await ok(`aws cloudwatch put-metric-alarm --alarm-name api-errores --namespace Api --metric-name Errores --statistic Sum --period 60 --evaluation-periods 1 --threshold 2 --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching`);
    await ok(`aws logs put-log-events --log-group-name /app/api --log-stream-name s1 --log-events timestamp=${T},message="ERROR uno" timestamp=${T},message="ok" timestamp=${T},message="ERROR dos"`);
    expect((await json('aws cloudwatch describe-alarms')).MetricAlarms[0].StateValue).toBe('ALARM');
  });

  it('patrones JSON', async () => {
    await ok('aws logs create-log-group --log-group-name /j');
    await ok('aws logs create-log-stream --log-group-name /j --log-stream-name s');
    await ok(`aws logs put-log-events --log-group-name /j --log-stream-name s --log-events '[{"timestamp":${T},"message":"{\\"status\\":500,\\"path\\":\\"/a\\"}"},{"timestamp":${T},"message":"{\\"status\\":200,\\"path\\":\\"/b\\"}"}]'`);
    expect((await json(`aws logs filter-log-events --log-group-name /j --filter-pattern '{ $.status = 500 }'`)).events).toHaveLength(1);
    expect((await json(`aws logs filter-log-events --log-group-name /j --filter-pattern '{ $.status >= 200 && $.path = "/b" }'`)).events).toHaveLength(1);
  });
});

describe('Correcciones de CLI', () => {
  it('s3 cp con destino stdout muestra "to -" en el error de descarga', async () => {
    await ok('aws s3api create-bucket --bucket bb-uno-1 --create-bucket-configuration LocationConstraint=eu-west-1');
    const k = (await json('aws kms create-key')).KeyMetadata.KeyId;
    await ok(`aws s3api put-bucket-encryption --bucket bb-uno-1 --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms","KMSMasterKeyID":"${k}"}}]}'`);
    await ok('echo a > ~/x.txt');
    await ok('aws s3 cp ~/x.txt s3://bb-uno-1/x.txt');
    await ok(`aws kms disable-key --key-id ${k}`);
    expect(await err('aws s3 cp s3://bb-uno-1/x.txt -')).toContain('download failed: s3://bb-uno-1/x.txt to - ');
  });
});

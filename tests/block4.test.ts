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
const WEB = btoa('#!/bin/bash\nyum install -y httpd\nsystemctl start httpd');

/** VPC con dos subredes públicas en AZ distintas y un grupo de seguridad web abierto. */
async function network() {
  const vpc = (await json('aws ec2 create-vpc --cidr-block 10.0.0.0/16')).Vpc.VpcId;
  const igw = (await json('aws ec2 create-internet-gateway')).InternetGateway.InternetGatewayId;
  await ok(`aws ec2 attach-internet-gateway --internet-gateway-id ${igw} --vpc-id ${vpc}`);
  const rtb = (await json(`aws ec2 create-route-table --vpc-id ${vpc}`)).RouteTable.RouteTableId;
  await ok(`aws ec2 create-route --route-table-id ${rtb} --destination-cidr-block 0.0.0.0/0 --gateway-id ${igw}`);
  const sub: string[] = [];
  for (const [i, az] of ['eu-west-1a', 'eu-west-1b'].entries()) {
    const s = (await json(`aws ec2 create-subnet --vpc-id ${vpc} --cidr-block 10.0.${i + 1}.0/24 --availability-zone ${az}`)).Subnet.SubnetId;
    await ok(`aws ec2 associate-route-table --route-table-id ${rtb} --subnet-id ${s}`);
    await ok(`aws ec2 modify-subnet-attribute --subnet-id ${s} --map-public-ip-on-launch`);
    sub.push(s);
  }
  const sg = (await json(`aws ec2 create-security-group --group-name web --description web --vpc-id ${vpc}`)).GroupId;
  await ok(`aws ec2 authorize-security-group-ingress --group-id ${sg} --protocol tcp --port 80 --cidr 0.0.0.0/0`);
  return { vpc, sub, sg };
}

describe('Route 53', () => {
  it('zonas, registros simples, CNAME, errores y dig', async () => {
    const z = await json('aws route53 create-hosted-zone --name example.com --caller-reference r1 --hosted-zone-config Comment=pruebas');
    expect(z.HostedZone.Name).toBe('example.com.');
    expect(z.HostedZone.ResourceRecordSetCount).toBe(2);
    expect(z.DelegationSet.NameServers).toHaveLength(4);
    expect(z.ChangeInfo.Status).toBe('PENDING');
    const id = z.HostedZone.Id.replace('/hostedzone/', '');
    const batch = (a: string, rr: any) => `aws route53 change-resource-record-sets --hosted-zone-id ${id} --change-batch '${JSON.stringify({ Changes: [{ Action: a, ResourceRecordSet: rr }] })}'`;
    await ok(batch('CREATE', { Name: 'www.example.com', Type: 'A', TTL: 300, ResourceRecords: [{ Value: '203.0.113.10' }] }));
    await ok(batch('CREATE', { Name: 'app.example.com', Type: 'CNAME', TTL: 60, ResourceRecords: [{ Value: 'www.example.com' }] }));
    expect(await err(batch('CREATE', { Name: 'www.example.com', Type: 'A', TTL: 300, ResourceRecords: [{ Value: '203.0.113.11' }] }))).toContain("Tried to create resource record set [name='www.example.com.', type='A'] but it already exists");
    expect(await err(batch('CREATE', { Name: 'example.com', Type: 'CNAME', TTL: 60, ResourceRecords: [{ Value: 'x.com' }] }))).toContain('not permitted at apex');
    expect(await err(batch('CREATE', { Name: 'app.example.com', Type: 'TXT', TTL: 60, ResourceRecords: [{ Value: '"hola"' }] }))).toContain('conflicts with other records');
    expect(await err(batch('CREATE', { Name: 'otro.org', Type: 'A', TTL: 60, ResourceRecords: [{ Value: '1.2.3.4' }] }))).toContain('is not permitted in zone example.com.');
    expect(await err(batch('DELETE', { Name: 'no.example.com', Type: 'A', TTL: 60, ResourceRecords: [{ Value: '1.2.3.4' }] }))).toContain('but it was not found');
    await ok(batch('UPSERT', { Name: 'www.example.com', Type: 'A', TTL: 60, ResourceRecords: [{ Value: '203.0.113.20' }] }));
    const l = await json(`aws route53 list-resource-record-sets --hosted-zone-id ${id}`);
    expect(l.ResourceRecordSets.map((r: any) => `${r.Name} ${r.Type}`)).toEqual(['example.com. NS', 'example.com. SOA', 'app.example.com. CNAME', 'www.example.com. A']);
    expect((await run('dig +short www.example.com')).out).toBe('203.0.113.20\n');
    expect((await run('dig +short app.example.com')).out).toBe('www.example.com\n203.0.113.20\n');
    const full = (await run('dig www.example.com A')).out;
    expect(full).toContain('status: NOERROR');
    expect(full).toContain('www.example.com.\t60\tIN\tA\t203.0.113.20');
    const nx = (await run('dig nada.example.com')).out;
    expect(nx).toContain('status: NXDOMAIN');
    expect(nx).toContain('AUTHORITY SECTION');
    const ns = await run('nslookup app.example.com');
    expect(ns.out).toContain('canonical name = www.example.com.');
    expect(ns.out).toContain('Address: 203.0.113.20');
    expect((await run('nslookup nada.example.com')).code).toBe(1);
    const t = await json(`aws route53 test-dns-answer --hosted-zone-id ${id} --record-name www.example.com --record-type A`);
    expect(t).toMatchObject({ ResponseCode: 'NOERROR', RecordData: ['203.0.113.20'] });
    expect(await err(`aws route53 delete-hosted-zone --id ${id}`)).toContain('HostedZoneNotEmpty');
    await ok(batch('DELETE', { Name: 'www.example.com', Type: 'A', TTL: 60, ResourceRecords: [{ Value: '203.0.113.20' }] }));
    await ok(batch('DELETE', { Name: 'app.example.com', Type: 'CNAME', TTL: 60, ResourceRecords: [{ Value: 'www.example.com' }] }));
    await ok(`aws route53 delete-hosted-zone --id ${id}`);
    expect(st.trail.some((e) => e.eventName === 'ChangeResourceRecordSets' && e.errorCode === 'InvalidChangeBatch')).toBe(true);
  });

  it('ponderado, conmutación por error con comprobación de estado y zona privada', async () => {
    const z = await json('aws route53 create-hosted-zone --name example.com --caller-reference r1');
    const id = z.HostedZone.Id.replace('/hostedzone/', '');
    const change = (rr: any) => ok(`aws route53 change-resource-record-sets --hosted-zone-id ${id} --change-batch '${JSON.stringify({ Changes: [{ Action: 'CREATE', ResourceRecordSet: rr }] })}'`);
    expect(await err(`aws route53 change-resource-record-sets --hosted-zone-id ${id} --change-batch '${JSON.stringify({ Changes: [{ Action: 'CREATE', ResourceRecordSet: { Name: 'w.example.com', Type: 'A', Weight: 10, TTL: 60, ResourceRecords: [{ Value: '1.1.1.1' }] } }] })}'`)).toContain('SetIdentifier');
    await change({ Name: 'w.example.com', Type: 'A', SetIdentifier: 'uno', Weight: 90, TTL: 60, ResourceRecords: [{ Value: '1.1.1.1' }] });
    await change({ Name: 'w.example.com', Type: 'A', SetIdentifier: 'dos', Weight: 10, TTL: 60, ResourceRecords: [{ Value: '2.2.2.2' }] });
    const seen = new Set<string>();
    let uno = 0;
    for (let i = 0; i < 60; i++) { const a = (await run('dig +short w.example.com')).out.trim(); seen.add(a); if (a === '1.1.1.1') uno++; }
    expect([...seen].sort()).toEqual(['1.1.1.1', '2.2.2.2']);
    expect(uno).toBeGreaterThan(35);
    // Conmutación por error: el primario apunta a una instancia sin servidor web.
    const n = await network();
    const inst = (await json(`aws ec2 run-instances --image-id ${AMI} --subnet-id ${n.sub[0]} --security-group-ids ${n.sg}`)).Instances[0];
    const ip = (await json(`aws ec2 describe-instances --instance-ids ${inst.InstanceId}`)).Reservations[0].Instances[0].PublicIpAddress;
    const hc = (await json(`aws route53 create-health-check --caller-reference h1 --health-check-config IPAddress=${ip},Port=80,Type=HTTP,ResourcePath=/`)).HealthCheck.Id;
    await change({ Name: 'f.example.com', Type: 'A', SetIdentifier: 'p', Failover: 'PRIMARY', HealthCheckId: hc, TTL: 60, ResourceRecords: [{ Value: ip }] });
    await change({ Name: 'f.example.com', Type: 'A', SetIdentifier: 's', Failover: 'SECONDARY', TTL: 60, ResourceRecords: [{ Value: '9.9.9.9' }] });
    expect((await run('dig +short f.example.com')).out).toBe('9.9.9.9\n');
    const bad = await json(`aws route53 get-health-check-status --health-check-id ${hc}`);
    expect(bad.HealthCheckObservations[0].StatusReport.Status).toContain('Failure');
    await ok(`aws ec2 create-tags --resources ${inst.InstanceId} --tags Key=simulador:web,Value=ok`);
    expect((await run('dig +short f.example.com')).out).toBe(`${ip}\n`);
    expect((await json(`aws route53 get-health-check-status --health-check-id ${hc}`)).HealthCheckObservations[0].StatusReport.Status).toContain('Success');
    expect(await err(`aws route53 delete-health-check --health-check-id ${hc}`)).toContain('HealthCheckInUse');
    // Zona privada: exige VPC y no se resuelve desde fuera de la VPC.
    expect(await err('aws route53 create-hosted-zone --name interna.local --caller-reference p1 --hosted-zone-config PrivateZone=true')).toContain('must provide a VPC id and region');
    await ok(`aws route53 create-hosted-zone --name interna.local --caller-reference p1 --hosted-zone-config PrivateZone=true --vpc VPCRegion=eu-west-1,VPCId=${n.vpc}`);
    expect(JSON.parse((await ok('aws route53 list-hosted-zones'))).HostedZones.map((x: any) => x.Config.PrivateZone)).toEqual([false, true]);
  });
});

describe('ELBv2 y Auto Scaling', () => {
  it('validaciones del balanceador y del grupo de destino', async () => {
    const n = await network();
    expect(await err(`aws elbv2 create-load-balancer --name alb --subnets ${n.sub[0]}`)).toContain('At least two subnets in two different Availability Zones must be specified');
    expect(await err(`aws elbv2 create-load-balancer --name alb --subnets ${n.sub[0]} subnet-0123456789abcdef0`)).toContain("The subnet ID 'subnet-0123456789abcdef0' does not exist");
    expect(await err(`aws elbv2 create-load-balancer --name "mal nombre" --subnets ${n.sub.join(' ')}`)).toContain('can only contain characters that are alphanumeric characters or hyphens(-)');
    const lb = (await json(`aws elbv2 create-load-balancer --name alb --subnets ${n.sub.join(' ')} --security-groups ${n.sg}`)).LoadBalancers[0];
    expect(lb.DNSName).toMatch(/^alb-\d{9}\.eu-west-1\.elb\.amazonaws\.com$/);
    expect(lb.Type).toBe('application');
    expect(lb.AvailabilityZones.map((a: any) => a.ZoneName).sort()).toEqual(['eu-west-1a', 'eu-west-1b']);
    const tg = (await json(`aws elbv2 create-target-group --name tg --protocol HTTP --port 80 --vpc-id ${n.vpc}`)).TargetGroups[0];
    expect(tg).toMatchObject({ HealthCheckPath: '/', HealthCheckIntervalSeconds: 30, HealthyThresholdCount: 5, UnhealthyThresholdCount: 2, Matcher: { HttpCode: '200' } });
    expect(await err(`aws elbv2 create-target-group --name tg --protocol HTTP --port 8080 --vpc-id ${n.vpc}`)).toContain("A target group with the same name 'tg' exists, but with different attributes");
    expect(await err(`aws elbv2 create-listener --load-balancer-arn ${lb.LoadBalancerArn} --protocol HTTPS --port 443 --default-actions Type=forward,TargetGroupArn=${tg.TargetGroupArn}`)).toContain('A certificate must be specified for HTTPS listeners');
    await ok(`aws elbv2 create-listener --load-balancer-arn ${lb.LoadBalancerArn} --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=${tg.TargetGroupArn}`);
    const dup = await run(`aws elbv2 create-listener --load-balancer-arn ${lb.LoadBalancerArn} --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=${tg.TargetGroupArn}`);
    expect(dup.err).toContain('A listener already exists on this port');
    expect(await err(`aws elbv2 delete-target-group --target-group-arn ${tg.TargetGroupArn}`)).toContain('is currently in use by a listener or a rule');
    expect(await err(`aws elbv2 register-targets --target-group-arn ${tg.TargetGroupArn} --targets Id=i-0123456789abcdef0`)).toContain('InvalidTarget');
  });

  it('la salud de los destinos se deriva de la instancia, los grupos de seguridad y el servidor web', async () => {
    const n = await network();
    const lbSg = (await json(`aws ec2 create-security-group --group-name alb-sg --description alb --vpc-id ${n.vpc}`)).GroupId;
    await ok(`aws ec2 authorize-security-group-ingress --group-id ${lbSg} --protocol tcp --port 80 --cidr 0.0.0.0/0`);
    const lb = (await json(`aws elbv2 create-load-balancer --name alb --subnets ${n.sub.join(' ')} --security-groups ${lbSg}`)).LoadBalancers[0];
    const tg = (await json(`aws elbv2 create-target-group --name tg --protocol HTTP --port 80 --vpc-id ${n.vpc}`)).TargetGroups[0].TargetGroupArn;
    // El grupo de seguridad de la instancia solo acepta tráfico de otra fuente: el destino da tiempo de espera agotado.
    const appSg = (await json(`aws ec2 create-security-group --group-name app-sg --description app --vpc-id ${n.vpc}`)).GroupId;
    const inst = (await json(`aws ec2 run-instances --image-id ${AMI} --subnet-id ${n.sub[0]} --security-group-ids ${appSg} --user-data ${WEB}`)).Instances[0].InstanceId;
    await ok(`aws elbv2 register-targets --target-group-arn ${tg} --targets Id=${inst}`);
    const health = async () => (await json(`aws elbv2 describe-target-health --target-group-arn ${tg}`)).TargetHealthDescriptions[0];
    expect((await health()).TargetHealth).toMatchObject({ State: 'unused', Reason: 'Target.NotInUse' });
    await ok(`aws elbv2 create-listener --load-balancer-arn ${lb.LoadBalancerArn} --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=${tg}`);
    expect((await health()).TargetHealth).toMatchObject({ State: 'unhealthy', Reason: 'Target.Timeout', Description: 'Request timed out' });
    await ok(`aws ec2 authorize-security-group-ingress --group-id ${appSg} --protocol tcp --port 80 --source-group ${lbSg}`);
    expect((await health()).TargetHealth).toEqual({ State: 'healthy' });
    expect((await health()).HealthCheckPort).toBe('80');
    // Sin servidor web, aunque la red permita el paso: comprobaciones fallidas.
    const bare = (await json(`aws ec2 run-instances --image-id ${AMI} --subnet-id ${n.sub[1]} --security-group-ids ${appSg}`)).Instances[0].InstanceId;
    await ok(`aws elbv2 register-targets --target-group-arn ${tg} --targets Id=${bare}`);
    const all = (await json(`aws elbv2 describe-target-health --target-group-arn ${tg}`)).TargetHealthDescriptions;
    expect(all.find((d: any) => d.Target.Id === bare).TargetHealth).toMatchObject({ State: 'unhealthy', Reason: 'Target.FailedHealthChecks' });
    await ok(`aws ec2 stop-instances --instance-ids ${inst}`);
    expect((await health()).TargetHealth).toMatchObject({ State: 'unused', Reason: 'Target.InvalidState' });
    await ok(`aws elbv2 deregister-targets --target-group-arn ${tg} --targets Id=${bare}`);
    expect((await json(`aws elbv2 describe-target-health --target-group-arn ${tg}`)).TargetHealthDescriptions).toHaveLength(1);
  });

  it('Auto Scaling mantiene la capacidad, reparte por AZ, registra en el grupo de destino y sustituye instancias', async () => {
    const n = await network();
    const lb = (await json(`aws elbv2 create-load-balancer --name alb --subnets ${n.sub.join(' ')} --security-groups ${n.sg}`)).LoadBalancers[0];
    const tg = (await json(`aws elbv2 create-target-group --name tg --protocol HTTP --port 80 --vpc-id ${n.vpc}`)).TargetGroups[0].TargetGroupArn;
    await ok(`aws elbv2 create-listener --load-balancer-arn ${lb.LoadBalancerArn} --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=${tg}`);
    await ok(`aws ec2 authorize-security-group-ingress --group-id ${n.sg} --protocol tcp --port 80 --source-group ${n.sg}`).catch(() => undefined);
    await ok(`aws ec2 create-launch-template --launch-template-name web-lt --launch-template-data '${JSON.stringify({ ImageId: AMI, InstanceType: 't3.micro', SecurityGroupIds: [n.sg], UserData: WEB })}'`);
    expect(await err('aws ec2 create-launch-template --launch-template-name web-lt --launch-template-data \'{"ImageId":"ami-0a1b2c3d4e5f60001"}\'')).toContain('Launch template name already in use.');
    expect(await err(`aws autoscaling create-auto-scaling-group --auto-scaling-group-name asg --launch-template LaunchTemplateName=web-lt,Version='$Latest' --min-size 1 --max-size 3 --desired-capacity 5 --vpc-zone-identifier ${n.sub.join(',')}`)).toContain('Desired capacity:5 must be between the specified min size:1 and max size:3');
    expect(await err(`aws autoscaling create-auto-scaling-group --auto-scaling-group-name asg --launch-template LaunchTemplateName=nope --min-size 1 --max-size 3 --vpc-zone-identifier ${n.sub.join(',')}`)).toContain('You must use a valid fully-formed launch template');
    await ok(`aws autoscaling create-auto-scaling-group --auto-scaling-group-name asg --launch-template LaunchTemplateName=web-lt,Version='$Latest' --min-size 2 --max-size 4 --vpc-zone-identifier ${n.sub.join(',')} --target-group-arns ${tg}`);
    const g = (await json('aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names asg')).AutoScalingGroups[0];
    expect(g).toMatchObject({ MinSize: 2, MaxSize: 4, DesiredCapacity: 2, HealthCheckType: 'EC2', DefaultCooldown: 300 });
    expect(g.Instances).toHaveLength(2);
    expect(g.Instances.map((i: any) => i.AvailabilityZone).sort()).toEqual(['eu-west-1a', 'eu-west-1b']);
    expect(g.Instances.every((i: any) => i.LifecycleState === 'InService' && i.HealthStatus === 'Healthy')).toBe(true);
    expect((await json(`aws elbv2 describe-target-health --target-group-arn ${tg}`)).TargetHealthDescriptions.map((d: any) => d.TargetHealth.State)).toEqual(['healthy', 'healthy']);
    // El balanceador reparte las peticiones entre las dos instancias.
    const bodies = new Set<string>();
    for (let i = 0; i < 4; i++) bodies.add((await run(`curl -s http://${lb.DNSName}`)).out);
    expect(bodies.size).toBe(2);
    expect([...bodies][0]).toContain('Hola desde ip-10-0-');
    // Escalar.
    await ok('aws autoscaling set-desired-capacity --auto-scaling-group-name asg --desired-capacity 4');
    expect((await json('aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names asg')).AutoScalingGroups[0].Instances).toHaveLength(4);
    expect(await err('aws autoscaling set-desired-capacity --auto-scaling-group-name asg --desired-capacity 9')).toContain('above max value 4');
    await ok('aws autoscaling update-auto-scaling-group --auto-scaling-group-name asg --max-size 4 --min-size 2 --desired-capacity 2');
    expect((await json('aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names asg')).AutoScalingGroups[0].Instances).toHaveLength(2);
    // Autorreparación: se termina una instancia por fuera y el grupo la sustituye.
    const victim = (await json('aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names asg')).AutoScalingGroups[0].Instances[0].InstanceId;
    await ok(`aws ec2 terminate-instances --instance-ids ${victim}`);
    const after = (await json('aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names asg')).AutoScalingGroups[0];
    expect(after.Instances).toHaveLength(2);
    expect(after.Instances.some((i: any) => i.InstanceId === victim)).toBe(false);
    const acts = (await json('aws autoscaling describe-scaling-activities --auto-scaling-group-name asg')).Activities.map((a: any) => a.Description);
    expect(acts.some((d: string) => d === `Terminating EC2 instance: ${victim}`)).toBe(true);
    expect(await err('aws autoscaling delete-auto-scaling-group --auto-scaling-group-name asg')).toContain('You cannot delete an AutoScalingGroup while there are instances');
    await ok('aws autoscaling delete-auto-scaling-group --auto-scaling-group-name asg --force-delete');
    expect(await err('aws autoscaling update-auto-scaling-group --auto-scaling-group-name asg --max-size 3')).toContain('AutoScalingGroup name not found - null');
    expect(st.trail.some((e) => e.eventName === 'RunInstances' && e.userName === 'autoscaling.amazonaws.com')).toBe(true);
  });

  it('un alias de Route 53 hacia el balanceador responde con curl y desaparece con el último destino sano', async () => {
    const n = await network();
    const lb = (await json(`aws elbv2 create-load-balancer --name alb --subnets ${n.sub.join(' ')} --security-groups ${n.sg}`)).LoadBalancers[0];
    const tg = (await json(`aws elbv2 create-target-group --name tg --protocol HTTP --port 80 --vpc-id ${n.vpc}`)).TargetGroups[0].TargetGroupArn;
    await ok(`aws elbv2 create-listener --load-balancer-arn ${lb.LoadBalancerArn} --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=${tg}`);
    await ok(`aws ec2 authorize-security-group-ingress --group-id ${n.sg} --protocol tcp --port 80 --source-group ${n.sg}`).catch(() => undefined);
    const inst = (await json(`aws ec2 run-instances --image-id ${AMI} --subnet-id ${n.sub[0]} --security-group-ids ${n.sg} --user-data ${WEB}`)).Instances[0].InstanceId;
    await ok(`aws elbv2 register-targets --target-group-arn ${tg} --targets Id=${inst}`);
    const z = await json('aws route53 create-hosted-zone --name example.com --caller-reference r1');
    const id = z.HostedZone.Id.replace('/hostedzone/', '');
    await ok(`aws route53 change-resource-record-sets --hosted-zone-id ${id} --change-batch '${JSON.stringify({ Changes: [{ Action: 'CREATE', ResourceRecordSet: { Name: 'www.example.com', Type: 'A', AliasTarget: { HostedZoneId: lb.CanonicalHostedZoneId, DNSName: lb.DNSName, EvaluateTargetHealth: true } } }] })}'`);
    expect((await run('dig +short www.example.com')).out.trim().split('\n')).toHaveLength(2);
    expect((await run('curl -s http://www.example.com')).out).toContain('Hola desde ip-10-0-1-');
    await ok(`aws elbv2 deregister-targets --target-group-arn ${tg} --targets Id=${inst}`);
    const r = await run('curl -s http://www.example.com');
    expect(r.out).toContain('503 Service Temporarily Unavailable');
    expect((await run('curl -s http://nada.example.com')).err).toContain('Could not resolve host');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshState } from '../src/engine/store';
import { resolveCaller, type Ctx } from '../src/engine/api';
import * as ec2 from '../src/engine/services/ec2';
import { setClock } from '../src/engine/util';
import { AwsError } from '../src/engine/errors';
import type { CloudState } from '../src/engine/types';

let st: CloudState;
let t = 1_700_000_000_000;
const admin = (region = 'eu-west-1'): Ctx => ({ s: st, region, caller: resolveCaller(st, st.users[0].accessKeys[0].id) });
beforeEach(() => {
  t = 1_700_000_000_000;
  setClock(() => t);
  st = freshState('Ana');
});
afterEach(() => setClock(null));
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AwsError) return e.code;
    throw e;
  }
  return 'OK';
};
const AMI = 'ami-0a1b2c3d4e5f60001';

function publicNetwork() {
  const vpc = ec2.createVpc(admin(), { CidrBlock: '10.0.0.0/16' });
  const sub = ec2.createSubnet(admin(), { VpcId: vpc.id, CidrBlock: '10.0.1.0/24' });
  const igw = ec2.createInternetGateway(admin());
  ec2.attachInternetGateway(admin(), { InternetGatewayId: igw.id, VpcId: vpc.id });
  const rt = ec2.createRouteTable(admin(), { VpcId: vpc.id });
  ec2.createRoute(admin(), { RouteTableId: rt.id, DestinationCidrBlock: '0.0.0.0/0', GatewayId: igw.id });
  ec2.associateRouteTable(admin(), { RouteTableId: rt.id, SubnetId: sub.id });
  ec2.modifySubnetAttribute(admin(), { SubnetId: sub.id, MapPublicIpOnLaunch: true });
  return { vpc, sub, igw, rt };
}

describe('VPC', () => {
  it('la cuenta tiene una VPC predeterminada 172.31.0.0/16 con 3 subredes', () => {
    const v = ec2.describeVpcs(admin());
    expect(v).toHaveLength(1);
    expect(v[0].isDefault).toBe(true);
    expect(ec2.describeSubnets(admin())).toHaveLength(3);
  });
  it('valida los CIDR', () => {
    expect(code(() => ec2.createVpc(admin(), { CidrBlock: '10.0.0.0/8' }))).toBe('InvalidVpc.Range');
    expect(code(() => ec2.createVpc(admin(), { CidrBlock: 'nada' }))).toBe('InvalidParameterValue');
  });
  it('la subred debe estar dentro de la VPC y no solaparse', () => {
    const vpc = ec2.createVpc(admin(), { CidrBlock: '10.0.0.0/16' });
    expect(code(() => ec2.createSubnet(admin(), { VpcId: vpc.id, CidrBlock: '192.168.0.0/24' }))).toBe('InvalidSubnet.Range');
    ec2.createSubnet(admin(), { VpcId: vpc.id, CidrBlock: '10.0.1.0/24' });
    expect(code(() => ec2.createSubnet(admin(), { VpcId: vpc.id, CidrBlock: '10.0.1.128/25' }))).toBe('InvalidSubnet.Conflict');
  });
  it('una subred es pública solo con ruta a un IGW adjunto', () => {
    const vpc = ec2.createVpc(admin(), { CidrBlock: '10.0.0.0/16' });
    const sub = ec2.createSubnet(admin(), { VpcId: vpc.id, CidrBlock: '10.0.1.0/24' });
    expect(ec2.isPublicSubnet(st, sub)).toBe(false);
    const n = publicNetwork();
    expect(ec2.isPublicSubnet(st, n.sub)).toBe(true);
  });
  it('no se borra una VPC con dependencias', () => {
    const { vpc, sub } = publicNetwork();
    expect(code(() => ec2.deleteVpc(admin(), { VpcId: vpc.id }))).toBe('DependencyViolation');
    ec2.deleteSubnet(admin(), { SubnetId: sub.id });
  });
  it('una ruta a un IGW de otra VPC se rechaza', () => {
    const a = ec2.createVpc(admin(), { CidrBlock: '10.0.0.0/16' });
    const b = ec2.createVpc(admin(), { CidrBlock: '10.1.0.0/16' });
    const igw = ec2.createInternetGateway(admin());
    ec2.attachInternetGateway(admin(), { InternetGatewayId: igw.id, VpcId: a.id });
    const rt = ec2.createRouteTable(admin(), { VpcId: b.id });
    expect(code(() => ec2.createRoute(admin(), { RouteTableId: rt.id, DestinationCidrBlock: '0.0.0.0/0', GatewayId: igw.id }))).toBe('InvalidParameterValue');
  });
});

describe('grupos de seguridad', () => {
  it('rechaza reglas duplicadas y borra el SG por defecto', () => {
    const { vpc } = publicNetwork();
    const sg = ec2.createSecurityGroup(admin(), { GroupName: 'web', Description: 'web', VpcId: vpc.id });
    const perm = [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' }];
    ec2.authorizeSecurityGroupIngress(admin(), { GroupId: sg.id, IpPermissions: perm });
    expect(code(() => ec2.authorizeSecurityGroupIngress(admin(), { GroupId: sg.id, IpPermissions: perm }))).toBe('InvalidPermission.Duplicate');
    expect(code(() => ec2.deleteSecurityGroup(admin(), { GroupId: vpc.defaultSecurityGroupId }))).toBe('CannotDelete');
  });
});

describe('instancias', () => {
  it('pasa de pending a running con el tiempo y se factura solo en ejecución', () => {
    const { sub, vpc } = publicNetwork();
    const sg = ec2.createSecurityGroup(admin(), { GroupName: 'web', Description: 'web', VpcId: vpc.id });
    const [i] = ec2.runInstances(admin(), { ImageId: AMI, InstanceType: 't3.micro', SubnetId: sub.id, SecurityGroupIds: [sg.id] });
    expect(i.state).toBe('pending');
    t += 9000;
    expect(ec2.describeInstances(admin(), { InstanceIds: [i.id] })[0].state).toBe('running');
    t += 3_600_000;
    ec2.stopInstances(admin(), { InstanceIds: [i.id] });
    t += 6000;
    const stopped = ec2.describeInstances(admin(), { InstanceIds: [i.id] })[0];
    expect(stopped.state).toBe('stopped');
    expect(stopped.billedMs).toBeGreaterThanOrEqual(3_600_000);
    expect(stopped.publicIp).toBeUndefined();
  });
  it('valida AMI, clave y tipo', () => {
    expect(code(() => ec2.runInstances(admin(), { ImageId: 'ami-nope' }))).toBe('InvalidAMIID.NotFound');
    expect(code(() => ec2.runInstances(admin(), { ImageId: AMI, KeyName: 'no-existe' }))).toBe('InvalidKeyPair.NotFound');
    expect(code(() => ec2.runInstances(admin(), { ImageId: AMI, InstanceType: 'zz.huge' }))).toBe('InvalidParameterValue');
  });
  it('no se puede arrancar una instancia que ya corre ni terminar dos veces', () => {
    const [i] = ec2.runInstances(admin(), { ImageId: AMI });
    t += 9000;
    expect(code(() => ec2.startInstances(admin(), { InstanceIds: [i.id] }))).toBe('IncorrectInstanceState');
    ec2.terminateInstances(admin(), { InstanceIds: [i.id] });
    t += 7000;
    expect(code(() => ec2.stopInstances(admin(), { InstanceIds: [i.id] }))).toBe('IncorrectInstanceState');
  });
  it('terminar elimina el volumen raíz', () => {
    const [i] = ec2.runInstances(admin(), { ImageId: AMI });
    expect(st.volumes).toHaveLength(1);
    ec2.terminateInstances(admin(), { InstanceIds: [i.id] });
    t += 7000;
    ec2.describeInstances(admin());
    expect(st.volumes).toHaveLength(0);
  });
});

describe('conectividad', () => {
  it('SSH desde Internet exige IP pública, ruta, NACL y SG', () => {
    const { sub, vpc } = publicNetwork();
    const sg = ec2.createSecurityGroup(admin(), { GroupName: 'ssh', Description: 'ssh', VpcId: vpc.id });
    const [i] = ec2.runInstances(admin(), { ImageId: AMI, SubnetId: sub.id, SecurityGroupIds: [sg.id] });
    t += 9000;
    ec2.describeInstances(admin());
    expect(ec2.reachableFromInternet(st, i, 22).reason).toMatch(/grupo de seguridad/);
    ec2.authorizeSecurityGroupIngress(admin(), { GroupId: sg.id, IpPermissions: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '203.0.113.0/24' }] });
    expect(ec2.reachableFromInternet(st, i, 22).ok).toBe(true);
    expect(ec2.reachableFromInternet(st, i, 80).ok).toBe(false);
  });
  it('sin ruta al IGW la instancia no es alcanzable aunque el SG lo permita', () => {
    const vpc = ec2.createVpc(admin(), { CidrBlock: '10.0.0.0/16' });
    const sub = ec2.createSubnet(admin(), { VpcId: vpc.id, CidrBlock: '10.0.1.0/24' });
    ec2.modifySubnetAttribute(admin(), { SubnetId: sub.id, MapPublicIpOnLaunch: true });
    const sg = ec2.createSecurityGroup(admin(), { GroupName: 'ssh', Description: 'ssh', VpcId: vpc.id });
    ec2.authorizeSecurityGroupIngress(admin(), { GroupId: sg.id, IpPermissions: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '0.0.0.0/0' }] });
    const [i] = ec2.runInstances(admin(), { ImageId: AMI, SubnetId: sub.id, SecurityGroupIds: [sg.id] });
    t += 9000;
    ec2.describeInstances(admin());
    expect(ec2.reachableFromInternet(st, i, 22).reason).toMatch(/Internet Gateway/);
  });
  it('la salida a Internet desde una subred privada necesita un NAT en una subred pública', () => {
    const { vpc, sub: pub } = publicNetwork();
    const priv = ec2.createSubnet(admin(), { VpcId: vpc.id, CidrBlock: '10.0.2.0/24' });
    const [i] = ec2.runInstances(admin(), { ImageId: AMI, SubnetId: priv.id });
    t += 9000;
    ec2.describeInstances(admin());
    expect(ec2.canReachInternet(st, i).ok).toBe(false);
    const eip = ec2.allocateAddress(admin());
    const nat = ec2.createNatGateway(admin(), { SubnetId: pub.id, AllocationId: eip.id });
    const rt = ec2.createRouteTable(admin(), { VpcId: vpc.id });
    ec2.createRoute(admin(), { RouteTableId: rt.id, DestinationCidrBlock: '0.0.0.0/0', NatGatewayId: nat.id });
    ec2.associateRouteTable(admin(), { RouteTableId: rt.id, SubnetId: priv.id });
    expect(ec2.canReachInternet(st, i).ok).toBe(true);
  });
});

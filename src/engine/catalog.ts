// Catálogo estático: regiones, zonas, tipos de instancia y AMI.

export const REGIONS: { code: string; name: string; azs: string[] }[] = [
  { code: 'eu-west-1', name: 'Europa (Irlanda)', azs: ['a', 'b', 'c'] },
  { code: 'eu-west-3', name: 'Europa (París)', azs: ['a', 'b', 'c'] },
  { code: 'eu-south-2', name: 'Europa (España)', azs: ['a', 'b', 'c'] },
  { code: 'eu-central-1', name: 'Europa (Fráncfort)', azs: ['a', 'b', 'c'] },
  { code: 'us-east-1', name: 'EE. UU. Este (Virginia del Norte)', azs: ['a', 'b', 'c', 'd', 'e', 'f'] },
  { code: 'us-west-2', name: 'EE. UU. Oeste (Oregón)', azs: ['a', 'b', 'c', 'd'] },
];

export const isRegion = (r: string) => REGIONS.some((x) => x.code === r);
export const azsOf = (region: string) => (REGIONS.find((r) => r.code === region)?.azs ?? []).map((a) => region + a);

export interface InstanceTypeInfo {
  name: string;
  vcpu: number;
  memGiB: number;
  /** USD por hora (Linux, bajo demanda; valores aproximados para el simulador). */
  hourly: number;
  freeTier?: boolean;
}

export const INSTANCE_TYPES: Record<string, InstanceTypeInfo> = {
  't2.micro': { name: 't2.micro', vcpu: 1, memGiB: 1, hourly: 0.0126, freeTier: true },
  't3.micro': { name: 't3.micro', vcpu: 2, memGiB: 1, hourly: 0.0104, freeTier: true },
  't3.small': { name: 't3.small', vcpu: 2, memGiB: 2, hourly: 0.0208 },
  't3.medium': { name: 't3.medium', vcpu: 2, memGiB: 4, hourly: 0.0416 },
  't3.large': { name: 't3.large', vcpu: 2, memGiB: 8, hourly: 0.0832 },
  'm5.large': { name: 'm5.large', vcpu: 2, memGiB: 8, hourly: 0.096 },
  'm5.xlarge': { name: 'm5.xlarge', vcpu: 4, memGiB: 16, hourly: 0.192 },
  'c5.large': { name: 'c5.large', vcpu: 2, memGiB: 4, hourly: 0.085 },
  'r5.large': { name: 'r5.large', vcpu: 2, memGiB: 16, hourly: 0.126 },
};

export const AMIS: { id: string; name: string; description: string; user: string }[] = [
  { id: 'ami-0a1b2c3d4e5f60001', name: 'al2023-ami-2023.6.20251001.0-kernel-6.1-x86_64', description: 'Amazon Linux 2023 AMI', user: 'ec2-user' },
  { id: 'ami-0a1b2c3d4e5f60002', name: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20251001', description: 'Canonical, Ubuntu, 24.04 LTS', user: 'ubuntu' },
  { id: 'ami-0a1b2c3d4e5f60003', name: 'Windows_Server-2022-English-Full-Base-2025.10.15', description: 'Microsoft Windows Server 2022 Base', user: 'Administrator' },
];

export const EBS_PRICE_GB_MONTH: Record<string, number> = { gp3: 0.08, gp2: 0.1, io1: 0.125, st1: 0.045, sc1: 0.015 };
export const PUBLIC_IPV4_HOURLY = 0.005;
export const NAT_HOURLY = 0.048;
export const HOURS_PER_MONTH = 730;

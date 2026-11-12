// Generadores de identificadores con el formato real de cada servicio.
import { hex, randomString, digits } from './util';

const UPPER_NUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export const ids = {
  accountId: () => digits(12),
  vpc: () => `vpc-${hex(17)}`,
  subnet: () => `subnet-${hex(17)}`,
  igw: () => `igw-${hex(17)}`,
  natgw: () => `nat-${hex(17)}`,
  rtb: () => `rtb-${hex(17)}`,
  sg: () => `sg-${hex(17)}`,
  sgRule: () => `sgr-${hex(17)}`,
  acl: () => `acl-${hex(17)}`,
  eni: () => `eni-${hex(17)}`,
  eip: () => `eipalloc-${hex(17)}`,
  instance: () => `i-${hex(17)}`,
  volume: () => `vol-${hex(17)}`,
  snapshot: () => `snap-${hex(17)}`,
  ami: () => `ami-${hex(17)}`,
  keyPair: () => `key-${hex(17)}`,
  /** Identificador de principal IAM: AIDA (usuario), AROA (rol), AGPA (grupo), ANPA (política). */
  iamId: (prefix: 'AIDA' | 'AROA' | 'AGPA' | 'ANPA' | 'AIPA') => `${prefix}${randomString(17, UPPER_NUM)}`,
  accessKeyId: () => `AKIA${randomString(16, UPPER_NUM)}`,
  sessionAccessKeyId: () => `ASIA${randomString(16, UPPER_NUM)}`,
  secretKey: () => randomString(40, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/+'),
  sessionToken: () => randomString(120, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/+'),
  requestId: () => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`.toUpperCase(),
  kmsKey: () => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`,
  etag: () => hex(32),
};

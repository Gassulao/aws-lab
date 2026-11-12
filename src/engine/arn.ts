// ARNs y utilidades de formato. Formato: arn:partition:service:region:account-id:resource

export interface ParsedArn {
  partition: string;
  service: string;
  region: string;
  account: string;
  resource: string;
}

export function arn(service: string, region: string, account: string, resource: string): string {
  return `arn:aws:${service}:${region}:${account}:${resource}`;
}

export function parseArn(s: string): ParsedArn | null {
  const m = /^arn:([^:]*):([^:]*):([^:]*):([^:]*):(.*)$/.exec(s);
  if (!m) return null;
  return { partition: m[1], service: m[2], region: m[3], account: m[4], resource: m[5] };
}

/** S3 no lleva región ni cuenta en sus ARN. */
export function s3Arn(bucket: string, key?: string): string {
  return `arn:aws:s3:::${bucket}${key !== undefined ? '/' + key : ''}`;
}

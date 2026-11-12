// Amazon ECR: repositorios, token de autenticación, imágenes y etiquetas, análisis básico de vulnerabilidades y
// políticas de ciclo de vida. Los `docker push/pull` del shell usan estas mismas funciones.
import type { CloudState } from '../types';
import { AwsError } from '../errors';
import { trailed, authorize, type Ctx, type Caller } from '../api';
import { hex, now } from '../util';
import { speedFactor } from '../store';
import { settleHooks } from './ec2';
import { cs, ecrHost, sha, baseVulns, type Counts, type EcrImage, type EcrRepo, type Finding, type ImageMeta } from './containerCore';

const SRC = 'ecr.amazonaws.com';
const NAME_RE = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const DAY = 86_400_000;

const repoArn = (ctx: Ctx, n: string) => `arn:aws:ecr:${ctx.region}:${ctx.s.account.id}:repository/${n}`;
const notFound = (ctx: Ctx, n: string) => new AwsError('RepositoryNotFoundException', `The repository with name '${n}' does not exist in the registry with id '${ctx.s.account.id}'`);
export const TAG_RE = /^[\w][\w.-]{0,127}$/;

export function getRepo(ctx: Ctx, name: string): EcrRepo {
  const r = cs(ctx.s).ecr.find((x) => x.name === name && x.region === ctx.region);
  if (!r) throw notFound(ctx, name);
  return r;
}
const res = (ctx: Ctx, n: string) => [{ type: 'AWS::ECR::Repository', name: n }];
const tagMap = (t?: { Key?: string; Value?: string; key?: string; value?: string }[]) => Object.fromEntries((t ?? []).map((x) => [x.Key ?? x.key ?? '', String(x.Value ?? x.value ?? '')]));

// ------------------------------------------------------------------ repositorios

export function createRepository(ctx: Ctx, p: { RepositoryName: string; ImageTagMutability?: string; ScanOnPush?: boolean; EncryptionType?: string; KmsKey?: string; Tags?: any[] }): EcrRepo {
  return trailed(ctx, SRC, 'CreateRepository', res(ctx, p.RepositoryName), { repositoryName: p.RepositoryName, imageTagMutability: p.ImageTagMutability }, () => {
    authorize(ctx, 'ecr:CreateRepository', repoArn(ctx, p.RepositoryName ?? '*'));
    const name = p.RepositoryName ?? '';
    if (name.length < 2 || name.length > 256 || !NAME_RE.test(name)) throw new AwsError('InvalidParameterException', `Invalid parameter at 'repositoryName' failed to satisfy constraint: 'must satisfy regular expression '(?:[a-z0-9]+(?:[._-][a-z0-9]+)*/)*[a-z0-9]+(?:[._-][a-z0-9]+)*''`);
    if (p.ImageTagMutability && !['MUTABLE', 'IMMUTABLE'].includes(p.ImageTagMutability)) throw new AwsError('InvalidParameterException', `Invalid parameter at 'imageTagMutability' failed to satisfy constraint: 'Member must satisfy enum value set: [IMMUTABLE, MUTABLE]'`);
    if (cs(ctx.s).ecr.some((r) => r.name === name && r.region === ctx.region)) throw new AwsError('RepositoryAlreadyExistsException', `The repository with name '${name}' already exists in the registry with id '${ctx.s.account.id}'`);
    const r: EcrRepo = {
      name, arn: repoArn(ctx, name), uri: `${ecrHost(ctx.s, ctx.region)}/${name}`, region: ctx.region, createdAt: now(),
      tagMutability: (p.ImageTagMutability as EcrRepo['tagMutability']) ?? 'MUTABLE', scanOnPush: p.ScanOnPush === true || (p.ScanOnPush as any) === 'true',
      encryption: p.EncryptionType === 'KMS' ? 'KMS' : 'AES256', kmsKey: p.KmsKey, images: [], tags: tagMap(p.Tags),
    };
    cs(ctx.s).ecr.push(r);
    return r;
  });
}
export function describeRepositories(ctx: Ctx, p: { RepositoryNames?: string[] } = {}): EcrRepo[] {
  return trailed(ctx, SRC, 'DescribeRepositories', [], p, () => {
    authorize(ctx, 'ecr:DescribeRepositories', p.RepositoryNames?.length ? repoArn(ctx, p.RepositoryNames[0]) : `arn:aws:ecr:${ctx.region}:${ctx.s.account.id}:repository/*`);
    for (const n of p.RepositoryNames ?? []) getRepo(ctx, n);
    return cs(ctx.s).ecr.filter((r) => r.region === ctx.region && (!p.RepositoryNames?.length || p.RepositoryNames.includes(r.name)));
  });
}
export function deleteRepository(ctx: Ctx, p: { RepositoryName: string; Force?: boolean }): EcrRepo {
  return trailed(ctx, SRC, 'DeleteRepository', res(ctx, p.RepositoryName), { repositoryName: p.RepositoryName, force: p.Force }, () => {
    authorize(ctx, 'ecr:DeleteRepository', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    if (r.images.length && !p.Force) throw new AwsError('RepositoryNotEmptyException', `The repository with name '${r.name}' in registry with id '${ctx.s.account.id}' cannot be deleted because it still contains images`);
    cs(ctx.s).ecr = cs(ctx.s).ecr.filter((x) => x !== r);
    return r;
  });
}
export function putImageTagMutability(ctx: Ctx, p: { RepositoryName: string; ImageTagMutability: string }): EcrRepo {
  return trailed(ctx, SRC, 'PutImageTagMutability', res(ctx, p.RepositoryName), { repositoryName: p.RepositoryName, imageTagMutability: p.ImageTagMutability }, () => {
    authorize(ctx, 'ecr:PutImageTagMutability', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    if (!['MUTABLE', 'IMMUTABLE'].includes(p.ImageTagMutability)) throw new AwsError('InvalidParameterException', `Invalid parameter at 'imageTagMutability' failed to satisfy constraint: 'Member must satisfy enum value set: [IMMUTABLE, MUTABLE]'`);
    r.tagMutability = p.ImageTagMutability as EcrRepo['tagMutability'];
    return r;
  });
}
export function putImageScanningConfiguration(ctx: Ctx, p: { RepositoryName: string; ScanOnPush: boolean }): EcrRepo {
  return trailed(ctx, SRC, 'PutImageScanningConfiguration', res(ctx, p.RepositoryName), { repositoryName: p.RepositoryName, scanOnPush: p.ScanOnPush }, () => {
    authorize(ctx, 'ecr:PutImageScanningConfiguration', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    r.scanOnPush = p.ScanOnPush === true || (p.ScanOnPush as any) === 'true';
    return r;
  });
}
export function setRepositoryPolicy(ctx: Ctx, p: { RepositoryName: string; PolicyText: string }): EcrRepo {
  return trailed(ctx, SRC, 'SetRepositoryPolicy', res(ctx, p.RepositoryName), { repositoryName: p.RepositoryName }, () => {
    authorize(ctx, 'ecr:SetRepositoryPolicy', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    try { const d = JSON.parse(p.PolicyText); if (!d.Statement) throw new Error(); } catch { throw new AwsError('InvalidParameterException', 'Invalid parameter at \'PolicyText\' failed to satisfy constraint: \'Invalid repository policy provided\''); }
    r.policy = p.PolicyText;
    return r;
  });
}
export function getRepositoryPolicy(ctx: Ctx, p: { RepositoryName: string }): EcrRepo {
  return trailed(ctx, SRC, 'GetRepositoryPolicy', res(ctx, p.RepositoryName), { repositoryName: p.RepositoryName }, () => {
    authorize(ctx, 'ecr:GetRepositoryPolicy', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    if (!r.policy) throw new AwsError('RepositoryPolicyNotFoundException', `Repository policy does not exist for the repository with name '${r.name}' in the registry with id '${ctx.s.account.id}'`);
    return r;
  });
}
export function deleteRepositoryPolicy(ctx: Ctx, p: { RepositoryName: string }): EcrRepo {
  return trailed(ctx, SRC, 'DeleteRepositoryPolicy', res(ctx, p.RepositoryName), { repositoryName: p.RepositoryName }, () => {
    authorize(ctx, 'ecr:DeleteRepositoryPolicy', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    if (!r.policy) throw new AwsError('RepositoryPolicyNotFoundException', `Repository policy does not exist for the repository with name '${r.name}' in the registry with id '${ctx.s.account.id}'`);
    const old = r.policy;
    r.policy = undefined;
    return { ...r, policy: old };
  });
}
export function tagResource(ctx: Ctx, p: { ResourceArn: string; Tags: any[] }): void {
  return trailed(ctx, SRC, 'TagResource', [], { resourceArn: p.ResourceArn }, () => {
    authorize(ctx, 'ecr:TagResource', p.ResourceArn);
    const r = cs(ctx.s).ecr.find((x) => x.arn === p.ResourceArn);
    if (!r) throw new AwsError('RepositoryNotFoundException', `The repository with name '${p.ResourceArn.split('/').slice(1).join('/')}' does not exist in the registry with id '${ctx.s.account.id}'`);
    Object.assign(r.tags, tagMap(p.Tags));
  });
}
export function listTagsForResource(ctx: Ctx, p: { ResourceArn: string }): Record<string, string> {
  return trailed(ctx, SRC, 'ListTagsForResource', [], { resourceArn: p.ResourceArn }, () => {
    authorize(ctx, 'ecr:ListTagsForResource', p.ResourceArn);
    const r = cs(ctx.s).ecr.find((x) => x.arn === p.ResourceArn);
    if (!r) throw new AwsError('RepositoryNotFoundException', `The repository with name '${p.ResourceArn.split('/').slice(1).join('/')}' does not exist in the registry with id '${ctx.s.account.id}'`);
    return r.tags;
  });
}

// ------------------------------------------------------------------ autenticación

const TOKEN_TTL = 12 * 3600_000;
function mintToken(ctx: Ctx): { token: string; expires: number } {
  const token = btoa(`AWS:${hex(40)}${hex(24)}`).replace(/=+$/, '') + hex(16);
  const expires = now() + TOKEN_TTL;
  const t = cs(ctx.s);
  t.tokens = t.tokens.filter((x) => x.expires > now()).slice(-30);
  t.tokens.push({ token, expires, account: ctx.s.account.id, region: ctx.region, caller: ctx.caller });
  return { token, expires };
}
export function getAuthorizationToken(ctx: Ctx, p: { RegistryIds?: string[] } = {}): { token: string; expires: number; endpoint: string } {
  return trailed(ctx, SRC, 'GetAuthorizationToken', [], p, () => {
    authorize(ctx, 'ecr:GetAuthorizationToken', '*');
    const t = mintToken(ctx);
    return { ...t, endpoint: `https://${ecrHost(ctx.s, ctx.region)}` };
  });
}
/** Contraseña que imprime `aws ecr get-login-password`: el token sin el prefijo «AWS:» ya codificado por separado. */
export const passwordOf = (token: string) => token;

/** Valida la contraseña que presenta `docker login`; devuelve la identidad que la pidió. */
export function verifyToken(s: CloudState, password: string): { caller: Caller; region: string } | 'expired' | 'invalid' {
  const t = cs(s).tokens.find((x) => x.token === password);
  if (!t) return 'invalid';
  if (t.expires <= now()) return 'expired';
  return { caller: t.caller, region: t.region };
}

// ------------------------------------------------------------------ imágenes

type Id = { imageTag?: string; imageDigest?: string; ImageTag?: string; ImageDigest?: string };
const normId = (i: Id) => ({ tag: i.imageTag ?? i.ImageTag, digest: i.imageDigest ?? i.ImageDigest });
const findImage = (r: EcrRepo, i: Id): EcrImage | undefined => { const { tag, digest } = normId(i); return r.images.find((x) => (digest ? x.digest === digest : false) || (tag ? x.tags.includes(tag) : false)); };

export const mediaType = 'application/vnd.docker.distribution.manifest.v2+json';

export function listImages(ctx: Ctx, p: { RepositoryName: string; Filter?: { tagStatus?: string } }): { imageDigest: string; imageTag?: string }[] {
  return trailed(ctx, SRC, 'ListImages', res(ctx, p.RepositoryName), { repositoryName: p.RepositoryName }, () => {
    authorize(ctx, 'ecr:ListImages', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    const out: { imageDigest: string; imageTag?: string }[] = [];
    for (const i of [...r.images].sort((a, b) => a.pushedAt - b.pushedAt)) {
      if (!i.tags.length) { if (p.Filter?.tagStatus !== 'TAGGED') out.push({ imageDigest: i.digest }); }
      else if (p.Filter?.tagStatus !== 'UNTAGGED') for (const t of i.tags) out.push({ imageDigest: i.digest, imageTag: t });
    }
    return out;
  });
}
export function describeImages(ctx: Ctx, p: { RepositoryName: string; ImageIds?: Id[] }): { r: EcrRepo; images: EcrImage[] } {
  return trailed(ctx, SRC, 'DescribeImages', res(ctx, p.RepositoryName), { repositoryName: p.RepositoryName }, () => {
    authorize(ctx, 'ecr:DescribeImages', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    settleEcr(ctx.s);
    if (p.ImageIds?.length) {
      const imgs = p.ImageIds.map((id) => { const i = findImage(r, id); if (!i) { const n = normId(id); throw new AwsError('ImageNotFoundException', `The image with imageId {${n.digest ? `imageDigest:'${n.digest}', ` : ''}imageTag:'${n.tag ?? ''}'} does not exist within the repository with name '${r.name}' in the registry with id '${ctx.s.account.id}'`); } return i; });
      return { r, images: imgs };
    }
    return { r, images: [...r.images].sort((a, b) => a.pushedAt - b.pushedAt) };
  });
}
export function batchGetImage(ctx: Ctx, p: { RepositoryName: string; ImageIds: Id[] }) {
  return trailed(ctx, SRC, 'BatchGetImage', res(ctx, p.RepositoryName), { repositoryName: p.RepositoryName }, () => {
    authorize(ctx, 'ecr:BatchGetImage', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    const images: { r: EcrRepo; i: EcrImage; tag?: string }[] = [];
    const failures: { imageId: { imageTag?: string; imageDigest?: string }; failureCode: string; failureReason: string }[] = [];
    for (const id of p.ImageIds ?? []) {
      const i = findImage(r, id);
      const n = normId(id);
      if (i) images.push({ r, i, tag: n.tag });
      else failures.push({ imageId: { ...(n.digest ? { imageDigest: n.digest } : {}), ...(n.tag ? { imageTag: n.tag } : {}) }, failureCode: 'ImageNotFound', failureReason: 'Requested image not found' });
    }
    return { images, failures };
  });
}
export function batchDeleteImage(ctx: Ctx, p: { RepositoryName: string; ImageIds: Id[] }) {
  return trailed(ctx, SRC, 'BatchDeleteImage', res(ctx, p.RepositoryName), { repositoryName: p.RepositoryName }, () => {
    authorize(ctx, 'ecr:BatchDeleteImage', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    const deleted: { imageDigest: string; imageTag?: string }[] = [];
    const failures: { imageId: { imageTag?: string; imageDigest?: string }; failureCode: string; failureReason: string }[] = [];
    for (const id of p.ImageIds ?? []) {
      const n = normId(id);
      const i = findImage(r, id);
      if (!i) { failures.push({ imageId: { ...(n.digest ? { imageDigest: n.digest } : {}), ...(n.tag ? { imageTag: n.tag } : {}) }, failureCode: 'ImageNotFound', failureReason: 'Requested image not found' }); continue; }
      if (n.tag && !n.digest) {
        // Borrar por etiqueta solo quita esa etiqueta; la imagen desaparece cuando se queda sin etiquetas y sin referencia por digest.
        i.tags = i.tags.filter((t) => t !== n.tag);
        deleted.push({ imageDigest: i.digest, imageTag: n.tag });
        if (!i.tags.length) r.images = r.images.filter((x) => x !== i);
      } else {
        for (const t of i.tags) deleted.push({ imageDigest: i.digest, imageTag: t });
        if (!i.tags.length) deleted.push({ imageDigest: i.digest });
        r.images = r.images.filter((x) => x !== i);
      }
    }
    return { deleted, failures };
  });
}

/** Empuja una imagen (docker push, put-image): crea o mueve la etiqueta. */
export function putImage(ctx: Ctx, p: { RepositoryName: string; Tag: string; Digest: string; Meta: ImageMeta; SizeBytes: number }): { r: EcrRepo; img: EcrImage; reused: boolean } {
  return trailed(ctx, SRC, 'PutImage', res(ctx, p.RepositoryName), { repositoryName: p.RepositoryName, imageTag: p.Tag, imageManifestMediaType: mediaType }, () => {
    authorize(ctx, 'ecr:PutImage', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    if (!TAG_RE.test(p.Tag)) throw new AwsError('InvalidParameterException', `Invalid parameter at 'imageTag' failed to satisfy constraint: 'Member must satisfy regular expression pattern: [\\w][\\w.-]{0,127}'`);
    const existing = r.images.find((i) => i.tags.includes(p.Tag));
    if (existing && existing.digest === p.Digest) return { r, img: existing, reused: true };
    if (existing && r.tagMutability === 'IMMUTABLE') throw new AwsError('ImageTagAlreadyExistsException', `The image tag '${p.Tag}' already exists in the '${r.name}' repository and cannot be overwritten because the repository is immutable.`);
    if (existing) existing.tags = existing.tags.filter((t) => t !== p.Tag);
    let img = r.images.find((i) => i.digest === p.Digest);
    if (!img) {
      img = { digest: p.Digest, tags: [], pushedAt: now(), sizeBytes: p.SizeBytes, meta: p.Meta };
      r.images.push(img);
      if (r.scanOnPush) startScan(img);
    }
    img.tags.push(p.Tag);
    return { r, img, reused: false };
  });
}

// ------------------------------------------------------------------ análisis de vulnerabilidades (básico)

const PKGS = ['openssl', 'zlib', 'glibc', 'curl', 'libxml2', 'busybox', 'tar', 'bash', 'sqlite', 'expat', 'libcurl', 'ncurses'];
const SEV: (keyof Counts)[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
function startScan(img: EcrImage) {
  const counts = baseVulns(img.meta.baseRef);
  const findings: Finding[] = [];
  for (const sev of SEV) for (let n = 0; n < (counts[sev] ?? 0); n++) {
    const h = parseInt(sha(img.meta.baseRef + sev + n).slice(0, 6), 16);
    const pkg = PKGS[h % PKGS.length];
    findings.push({ name: `CVE-2099-${String(1000 + (h % 9000))}`, severity: sev, pkg, description: `Vulnerabilidad simulada de gravedad ${sev} en el paquete ${pkg} (identificador ficticio del laboratorio).` });
  }
  img.scan = { status: 'IN_PROGRESS', startedAt: now(), counts, findings };
}
const scanDone = (img: EcrImage) => !!img.scan && (img.scan.status === 'COMPLETE' || speedFactor() === 0 || now() - img.scan.startedAt >= 4000 * speedFactor());
export function scanOf(img: EcrImage) {
  if (img.scan && img.scan.status === 'IN_PROGRESS' && scanDone(img)) img.scan.status = 'COMPLETE';
  return img.scan;
}
export function startImageScan(ctx: Ctx, p: { RepositoryName: string; ImageId: Id }) {
  return trailed(ctx, SRC, 'StartImageScan', res(ctx, p.RepositoryName), { repositoryName: p.RepositoryName }, () => {
    authorize(ctx, 'ecr:StartImageScan', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    const img = findImage(r, p.ImageId ?? {});
    const n = normId(p.ImageId ?? {});
    if (!img) throw new AwsError('ImageNotFoundException', `The image with imageId {imageDigest:'${n.digest ?? 'null'}', imageTag:'${n.tag ?? 'null'}'} does not exist within the repository with name '${r.name}' in the registry with id '${ctx.s.account.id}'`);
    if (img.scan && now() - img.scan.startedAt < DAY) throw new AwsError('LimitExceededException', 'The scan quota per image has been exceeded. Wait and try again.');
    startScan(img);
    return { r, img, tag: n.tag };
  });
}
export function describeImageScanFindings(ctx: Ctx, p: { RepositoryName: string; ImageId: Id }) {
  return trailed(ctx, SRC, 'DescribeImageScanFindings', res(ctx, p.RepositoryName), { repositoryName: p.RepositoryName }, () => {
    authorize(ctx, 'ecr:DescribeImageScanFindings', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    const n = normId(p.ImageId ?? {});
    const img = findImage(r, p.ImageId ?? {});
    if (!img) throw new AwsError('ImageNotFoundException', `The image with imageId {imageDigest:'${n.digest ?? 'null'}', imageTag:'${n.tag ?? 'null'}'} does not exist within the repository with name '${r.name}' in the registry with id '${ctx.s.account.id}'`);
    const sc = scanOf(img);
    if (!sc) throw new AwsError('ScanNotFoundException', `Image scan does not exist for the image with '{imageDigest:'${img.digest}', imageTag:'${n.tag ?? 'null'}'}' in the repository with name '${r.name}' in the registry with id '${ctx.s.account.id}'`);
    return { r, img, tag: n.tag ?? img.tags[0], scan: sc };
  });
}

// ------------------------------------------------------------------ ciclo de vida

export interface LcRule { rulePriority: number; description?: string; selection: { tagStatus: string; tagPrefixList?: string[]; tagPatternList?: string[]; countType: string; countUnit?: string; countNumber: number }; action: { type: string } }

export function parseLifecycle(text: string): LcRule[] {
  const bad = (m: string) => new AwsError('InvalidParameterException', `Invalid parameter at 'LifecyclePolicyText' failed to satisfy constraint: 'Lifecycle policy validation failure: ${m}'`);
  let d: any;
  try { d = JSON.parse(text); } catch { throw bad('Could not map policyString into Object'); }
  const rules: LcRule[] = d?.rules;
  if (!Array.isArray(rules) || !rules.length) throw bad('Required property rules is missing or empty');
  const seen = new Set<number>();
  for (const r of rules) {
    if (typeof r.rulePriority !== 'number') throw bad('Required property rulePriority is missing');
    if (seen.has(r.rulePriority)) throw bad(`Rule priorities must be unique: ${r.rulePriority}`);
    seen.add(r.rulePriority);
    const s = r.selection;
    if (!s) throw bad('Required property selection is missing');
    if (!['tagged', 'untagged', 'any'].includes(s.tagStatus)) throw bad(`Invalid value for tagStatus: ${s.tagStatus}`);
    if (s.tagStatus === 'tagged' && !s.tagPrefixList?.length && !s.tagPatternList?.length) throw bad('tagPrefixList or tagPatternList is required when tagStatus is tagged');
    if (!['imageCountMoreThan', 'sinceImagePushed'].includes(s.countType)) throw bad(`Invalid value for countType: ${s.countType}`);
    if (!(s.countNumber >= 1)) throw bad('countNumber must be greater than or equal to 1');
    if (s.countType === 'sinceImagePushed' && s.countUnit !== 'days') throw bad('countUnit must be days for countType sinceImagePushed');
    if (r.action?.type !== 'expire') throw bad(`Invalid value for action type: ${r.action?.type}`);
  }
  return [...rules].sort((a, b) => a.rulePriority - b.rulePriority);
}
/** Imágenes que expiraría la política (y con qué regla). */
export function lifecycleExpiry(repo: EcrRepo, rules: LcRule[]): { img: EcrImage; rule: LcRule }[] {
  const out: { img: EcrImage; rule: LcRule }[] = [];
  const gone = new Set<EcrImage>();
  for (const rule of rules) {
    const s = rule.selection;
    const cands = repo.images.filter((i) => !gone.has(i) && (s.tagStatus === 'any' || (s.tagStatus === 'untagged' ? !i.tags.length : i.tags.length > 0 && ((s.tagPrefixList ?? []).some((p) => i.tags.some((t) => t.startsWith(p))) || (s.tagPatternList ?? []).some((p) => i.tags.some((t) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(t)))))));
    cands.sort((a, b) => b.pushedAt - a.pushedAt || repo.images.indexOf(b) - repo.images.indexOf(a));
    const hit = s.countType === 'imageCountMoreThan' ? cands.slice(s.countNumber) : cands.filter((i) => now() - i.pushedAt > s.countNumber * DAY);
    for (const img of hit) { gone.add(img); out.push({ img, rule }); }
  }
  return out;
}
export function putLifecyclePolicy(ctx: Ctx, p: { RepositoryName: string; LifecyclePolicyText: string }): EcrRepo {
  return trailed(ctx, SRC, 'PutLifecyclePolicy', res(ctx, p.RepositoryName), { repositoryName: p.RepositoryName }, () => {
    authorize(ctx, 'ecr:PutLifecyclePolicy', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    parseLifecycle(p.LifecyclePolicyText);
    r.lifecyclePolicy = { text: p.LifecyclePolicyText, updatedAt: now(), applied: false };
    return r;
  });
}
const noPolicy = (ctx: Ctx, n: string) => new AwsError('LifecyclePolicyNotFoundException', `Lifecycle policy does not exist for the repository with name '${n}' in the registry with id '${ctx.s.account.id}'`);
export function getLifecyclePolicy(ctx: Ctx, p: { RepositoryName: string }): EcrRepo {
  return trailed(ctx, SRC, 'GetLifecyclePolicy', res(ctx, p.RepositoryName), { repositoryName: p.RepositoryName }, () => {
    authorize(ctx, 'ecr:GetLifecyclePolicy', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    if (!r.lifecyclePolicy) throw noPolicy(ctx, r.name);
    return r;
  });
}
export function deleteLifecyclePolicy(ctx: Ctx, p: { RepositoryName: string }): EcrRepo {
  return trailed(ctx, SRC, 'DeleteLifecyclePolicy', res(ctx, p.RepositoryName), { repositoryName: p.RepositoryName }, () => {
    authorize(ctx, 'ecr:DeleteLifecyclePolicy', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    if (!r.lifecyclePolicy) throw noPolicy(ctx, r.name);
    const text = r.lifecyclePolicy.text;
    r.lifecyclePolicy = undefined;
    return { ...r, lifecyclePolicy: { text, updatedAt: now(), applied: true } };
  });
}
export function lifecyclePreview(ctx: Ctx, p: { RepositoryName: string; LifecyclePolicyText?: string }) {
  return trailed(ctx, SRC, 'GetLifecyclePolicyPreview', res(ctx, p.RepositoryName), { repositoryName: p.RepositoryName }, () => {
    authorize(ctx, 'ecr:GetLifecyclePolicyPreview', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    const text = p.LifecyclePolicyText ?? r.lifecyclePolicy?.text;
    if (!text) throw noPolicy(ctx, r.name);
    return { r, text, results: lifecycleExpiry(r, parseLifecycle(text)) };
  });
}

/** Aplica las políticas de ciclo de vida pendientes (en AWS se evalúan de forma asíncrona). */
export function settleEcr(s: CloudState) {
  const f = speedFactor();
  for (const r of cs(s).ecr) {
    const lp = r.lifecyclePolicy;
    if (!lp || lp.applied || (f > 0 && now() - lp.updatedAt < 15_000 * f)) continue;
    lp.applied = true;
    const drop = new Set(lifecycleExpiry(r, parseLifecycle(lp.text)).map((x) => x.img));
    r.images = r.images.filter((i) => !drop.has(i));
  }
}
settleHooks.push(settleEcr);


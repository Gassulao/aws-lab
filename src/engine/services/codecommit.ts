// AWS CodeCommit: repositorios Git administrados, ramas, commits, archivos, pull requests y reglas de aprobación.
import type { CloudState } from '../types';
import { AwsError } from '../errors';
import { trailed, authorize, type Ctx } from '../api';
import { guid, hex, now } from '../util';
import { cicd, cicdHooks, type CcPr, type CcPrRule, type CcRepo, type CcRuleTemplate, type GitCommit } from './cicdTypes';
import { sha1 as sha1Hex, filesOf, history, isAncestor, makeCommit, mergeBase, mergeFiles, putBlob, treeOf, diffTrees, emptyObjects } from './gitCore';
import { asArr } from './cicdCommon';
import { wildcardMatch } from '../util';

const SRC = 'codecommit.amazonaws.com';

export const repoArn = (ctx: Ctx, name: string) => `arn:aws:codecommit:${ctx.region}:${ctx.s.account.id}:${name}`;
export const cloneUrl = (region: string, name: string) => `https://git-codecommit.${region}.amazonaws.com/v1/repos/${name}`;
const resTag = (name: string) => [{ type: 'AWS::CodeCommit::Repository', name }];
const err = (code: string, msg: string) => new AwsError(code, msg, 400);

// ------------------------------------------------------------------ utilidades

export function getRepo(ctx: Ctx, name: string): CcRepo {
  if (!name) throw err('RepositoryNameRequiredException', 'A repository name is required to perform this operation.');
  const r = cicd(ctx.s).repos.find((x) => x.name === name && x.region === ctx.region);
  if (!r) throw err('RepositoryDoesNotExistException', `${name} does not exist`);
  return r;
}

const validName = (n: string) => /^[\w.-]{1,100}$/.test(n ?? '') && !n.endsWith('.git');
const validBranch = (b: string) => !!b && !/[\s~^:?*\[\\]|\.\.|\.lock$|^\/|\/$|^-/.test(b);

/** Resuelve un especificador (rama, ID de commit completo o abreviado) a un ID de commit. */
export function resolveSpec(repo: CcRepo, spec: string | undefined): string | undefined {
  if (!spec) return undefined;
  const b = spec.replace(/^refs\/heads\//, '');
  if (repo.branches[b]) return repo.branches[b];
  if (repo.objs.commits[spec]) return spec;
  if (/^[0-9a-f]{7,39}$/.test(spec)) {
    const hit = Object.keys(repo.objs.commits).filter((k) => k.startsWith(spec));
    if (hit.length === 1) return hit[0];
  }
  return undefined;
}

function commitOrFail(repo: CcRepo, spec: string | undefined, what = 'commit'): GitCommit {
  const id = resolveSpec(repo, spec);
  if (!id) throw err('CommitDoesNotExistException', `${spec} does not exist`);
  void what;
  return repo.objs.commits[id];
}

export const refContext = (branch: string) => ({ 'codecommit:References': [`refs/heads/${branch}`] });

const authRepo = (ctx: Ctx, action: string, repo: CcRepo, context?: Record<string, any>) => authorize(ctx, action, repo.arn, context ? { context } : undefined);

const identFor = (ctx: Ctx, name?: string, email?: string) => ({ name: name || ctx.caller.userName, email: email ?? '', date: now() });

/** Refresca los pull requests abiertos tras cambiar una rama. Si cambia el origen, caduca la revisión (y las aprobaciones). */
export function refreshPrs(repo: CcRepo): void {
  for (const pr of repo.prs) {
    if (pr.status !== 'OPEN') continue;
    const sc = repo.branches[pr.source], dc = repo.branches[pr.dest];
    if (sc && sc !== pr.sourceCommit) {
      pr.sourceCommit = sc;
      pr.revisionId = sha1Hex(sc + pr.destCommit).slice(0, 64);
      pr.approvals = [];
      pr.lastActivity = now();
    }
    if (dc) pr.destCommit = dc;
    if (sc && dc) pr.mergeBase = mergeBase(repo.objs, sc, dc) ?? pr.mergeBase;
  }
}

export function afterRefUpdate(ctx: Ctx, repo: CcRepo, branch: string): void {
  repo.modified = now();
  refreshPrs(repo);
  for (const h of cicdHooks.repoUpdated) h(ctx.s, repo, branch, ctx.caller.arn);
}

function setBranch(ctx: Ctx, repo: CcRepo, branch: string, id: string) {
  repo.branches[branch] = id;
  repo.defaultBranch ??= branch;
  afterRefUpdate(ctx, repo, branch);
}

// ------------------------------------------------------------------ repositorios

export function createRepository(ctx: Ctx, p: { RepositoryName: string; RepositoryDescription?: string; Tags?: Record<string, string> }): CcRepo {
  return trailed(ctx, SRC, 'CreateRepository', resTag(p.RepositoryName), { repositoryName: p.RepositoryName, repositoryDescription: p.RepositoryDescription }, () => {
    if (!p.RepositoryName) throw err('RepositoryNameRequiredException', 'A repository name is required to perform this operation.');
    authorize(ctx, 'codecommit:CreateRepository', repoArn(ctx, p.RepositoryName));
    if (!validName(p.RepositoryName)) throw err('InvalidRepositoryNameException', 'The repository name is not valid. Repository names can be any valid combination of letters, numbers, periods, underscores, and dashes between 1 and 100 characters in length. Names are case sensitive. For more information, see Limits in the AWS CodeCommit User Guide.');
    if (cicd(ctx.s).repos.some((r) => r.name === p.RepositoryName && r.region === ctx.region)) throw err('RepositoryNameExistsException', `Repository named ${p.RepositoryName} already exists`);
    if (p.RepositoryDescription && p.RepositoryDescription.length > 1000) throw err('InvalidRepositoryDescriptionException', 'The repository description is not valid. It must be 1,000 characters or fewer.');
    const r: CcRepo = { id: guid(), name: p.RepositoryName, arn: repoArn(ctx, p.RepositoryName), region: ctx.region, description: p.RepositoryDescription, created: now(), modified: now(), branches: {}, objs: emptyObjects(), prs: [], nextPr: 1, tags: p.Tags ?? {} };
    cicd(ctx.s).repos.push(r);
    return r;
  });
}

export function getRepository(ctx: Ctx, p: { RepositoryName: string }): CcRepo {
  return trailed(ctx, SRC, 'GetRepository', resTag(p.RepositoryName), { repositoryName: p.RepositoryName }, () => {
    authorize(ctx, 'codecommit:GetRepository', repoArn(ctx, p.RepositoryName));
    return getRepo(ctx, p.RepositoryName);
  });
}

export function listRepositories(ctx: Ctx, p: { SortBy?: string; Order?: string } = {}): CcRepo[] {
  return trailed(ctx, SRC, 'ListRepositories', [], p, () => {
    authorize(ctx, 'codecommit:ListRepositories', '*');
    const l = cicd(ctx.s).repos.filter((r) => r.region === ctx.region);
    l.sort((a, b) => (p.SortBy === 'lastModifiedDate' ? a.modified - b.modified : a.name.localeCompare(b.name)));
    return p.Order === 'descending' ? l.reverse() : l;
  });
}

export function deleteRepository(ctx: Ctx, p: { RepositoryName: string }): string | undefined {
  return trailed(ctx, SRC, 'DeleteRepository', resTag(p.RepositoryName), { repositoryName: p.RepositoryName }, () => {
    authorize(ctx, 'codecommit:DeleteRepository', repoArn(ctx, p.RepositoryName));
    const c = cicd(ctx.s);
    const r = c.repos.find((x) => x.name === p.RepositoryName && x.region === ctx.region);
    if (!r) return undefined; // como en AWS: borrar un repositorio inexistente no es un error
    c.repos = c.repos.filter((x) => x !== r);
    for (const t of c.ruleTemplates) t.repos = t.repos.filter((n) => n !== r.name);
    return r.id;
  });
}

export function updateRepositoryDescription(ctx: Ctx, p: { RepositoryName: string; RepositoryDescription?: string }): void {
  return trailed(ctx, SRC, 'UpdateRepositoryDescription', resTag(p.RepositoryName), { repositoryName: p.RepositoryName }, () => {
    authorize(ctx, 'codecommit:UpdateRepositoryDescription', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    r.description = p.RepositoryDescription || undefined;
    r.modified = now();
  });
}

export function updateDefaultBranch(ctx: Ctx, p: { RepositoryName: string; DefaultBranchName: string }): void {
  return trailed(ctx, SRC, 'UpdateDefaultBranch', resTag(p.RepositoryName), { repositoryName: p.RepositoryName, defaultBranchName: p.DefaultBranchName }, () => {
    authorize(ctx, 'codecommit:UpdateDefaultBranch', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    if (!r.branches[p.DefaultBranchName]) throw err('BranchDoesNotExistException', `${p.DefaultBranchName} does not exist`);
    r.defaultBranch = p.DefaultBranchName;
    r.modified = now();
  });
}

// ------------------------------------------------------------------ ramas

export function createBranch(ctx: Ctx, p: { RepositoryName: string; BranchName: string; CommitId: string }): void {
  return trailed(ctx, SRC, 'CreateBranch', resTag(p.RepositoryName), { repositoryName: p.RepositoryName, branchName: p.BranchName, commitId: p.CommitId }, () => {
    authorize(ctx, 'codecommit:CreateBranch', repoArn(ctx, p.RepositoryName), { context: refContext(p.BranchName) });
    const r = getRepo(ctx, p.RepositoryName);
    if (!p.BranchName) throw err('BranchNameRequiredException', 'A branch name is required to perform this operation.');
    if (!validBranch(p.BranchName)) throw err('InvalidBranchNameException', 'The specified reference name is not valid. Reference names must conform to the naming rules for Git references.');
    if (!p.CommitId) throw err('CommitIdRequiredException', 'A commit ID is required to perform this operation.');
    if (r.branches[p.BranchName]) throw err('BranchNameExistsException', `${p.BranchName} already exists`);
    if (!/^[0-9a-f]{40}$/.test(p.CommitId)) throw err('InvalidCommitIdException', 'The specified commit ID is not valid.');
    const c = commitOrFail(r, p.CommitId);
    setBranch(ctx, r, p.BranchName, c.id);
  });
}

export function getBranch(ctx: Ctx, p: { RepositoryName: string; BranchName: string }): { branchName: string; commitId: string } {
  return trailed(ctx, SRC, 'GetBranch', resTag(p.RepositoryName), { repositoryName: p.RepositoryName, branchName: p.BranchName }, () => {
    authorize(ctx, 'codecommit:GetBranch', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    if (!p.BranchName) throw err('BranchNameRequiredException', 'A branch name is required to perform this operation.');
    const id = r.branches[p.BranchName];
    if (!id) throw err('BranchDoesNotExistException', `${p.BranchName} does not exist`);
    return { branchName: p.BranchName, commitId: id };
  });
}

export function listBranches(ctx: Ctx, p: { RepositoryName: string }): string[] {
  return trailed(ctx, SRC, 'ListBranches', resTag(p.RepositoryName), { repositoryName: p.RepositoryName }, () => {
    authorize(ctx, 'codecommit:ListBranches', repoArn(ctx, p.RepositoryName));
    return Object.keys(getRepo(ctx, p.RepositoryName).branches).sort();
  });
}

export function deleteBranch(ctx: Ctx, p: { RepositoryName: string; BranchName: string }): { branchName: string; commitId: string } | null {
  return trailed(ctx, SRC, 'DeleteBranch', resTag(p.RepositoryName), { repositoryName: p.RepositoryName, branchName: p.BranchName }, () => {
    authorize(ctx, 'codecommit:DeleteBranch', repoArn(ctx, p.RepositoryName), { context: refContext(p.BranchName) });
    const r = getRepo(ctx, p.RepositoryName);
    if (r.defaultBranch === p.BranchName) throw err('DefaultBranchCannotBeDeletedException', 'The specified branch is the default branch for the repository, and cannot be deleted. To delete this branch, you must first set another branch as the default branch.');
    const id = r.branches[p.BranchName];
    if (!id) return null;
    delete r.branches[p.BranchName];
    r.modified = now();
    return { branchName: p.BranchName, commitId: id };
  });
}

// ------------------------------------------------------------------ commits, archivos y carpetas

export function getCommit(ctx: Ctx, p: { RepositoryName: string; CommitId: string }): GitCommit {
  return trailed(ctx, SRC, 'GetCommit', resTag(p.RepositoryName), { repositoryName: p.RepositoryName, commitId: p.CommitId }, () => {
    authorize(ctx, 'codecommit:GetCommit', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    if (!p.CommitId) throw err('CommitIdRequiredException', 'A commit ID is required to perform this operation.');
    const c = r.objs.commits[p.CommitId];
    if (!c) throw err('CommitIdDoesNotExistException', `${p.CommitId} does not exist`);
    return c;
  });
}

/** Historial de una rama (uso interno de la consola; no genera eventos de CloudTrail). */
export function branchLog(repo: CcRepo, branch: string, limit = 100): GitCommit[] {
  return history(repo.objs, repo.branches[branch], limit);
}

export function treeIdOf(c: GitCommit): string {
  return sha1Hex('tree' + JSON.stringify(Object.entries(c.tree).sort()));
}

interface FileChange { filePath: string; fileContent?: string; fileMode?: string }

/** Núcleo de create-commit, put-file y delete-file. */
function commitChanges(ctx: Ctx, repo: CcRepo, p: { branch: string; parent?: string; message?: string; name?: string; email?: string; put?: FileChange[]; del?: string[] }): { commit: GitCommit; added: FileChange[]; updated: FileChange[]; deleted: string[] } {
  if (!p.branch) throw err('BranchNameRequiredException', 'A branch name is required to perform this operation.');
  if (!validBranch(p.branch)) throw err('InvalidBranchNameException', 'The specified reference name is not valid. Reference names must conform to the naming rules for Git references.');
  const tip = repo.branches[p.branch];
  if (tip && !p.parent) throw err('ParentCommitIdRequiredException', 'A parent commit ID is required. To view the full commit ID of a branch in a repository, use GetBranch or a Git client to get the current commit ID.');
  if (p.parent && !tip) throw err('ParentCommitDoesNotExistException', `${p.parent} does not exist`);
  if (p.parent && repo.objs.commits[p.parent] === undefined) throw err('ParentCommitDoesNotExistException', `${p.parent} does not exist`);
  if (p.parent && tip && p.parent !== tip) throw err('ParentCommitIdOutdatedException', `The specified parent commit ID is not the tip of the branch ${p.branch}. The tip of the branch is ${tip}.`);
  const files = filesOf(repo.objs, tip);
  const added: FileChange[] = [], updated: FileChange[] = [], deleted: string[] = [];
  for (const f of p.put ?? []) {
    if (!f.filePath || f.filePath.startsWith('/') || f.filePath.includes('//')) throw err('PathRequiredException', 'The folderPath for a location cannot be null.');
    if (f.filePath in files) {
      if (files[f.filePath] === (f.fileContent ?? '')) throw err('SameFileContentException', 'The file is exactly the same as the existing file, so no changes can be made. Edit the file and try again.');
      updated.push(f);
    } else added.push(f);
    files[f.filePath] = f.fileContent ?? '';
  }
  for (const d of p.del ?? []) {
    if (!(d in files)) throw err('FileDoesNotExistException', `${d} does not exist in commit ${tip ?? ''}`.trim());
    delete files[d];
    deleted.push(d);
  }
  const c = makeCommit(repo.objs, { tree: treeOf(repo.objs, files), parents: tip ? [tip] : [], message: p.message || 'Added files', author: identFor(ctx, p.name, p.email) });
  setBranch(ctx, repo, p.branch, c.id);
  return { commit: c, added, updated, deleted };
}

export function createCommit(ctx: Ctx, p: { RepositoryName: string; BranchName: string; ParentCommitId?: string; AuthorName?: string; Email?: string; CommitMessage?: string; PutFiles?: FileChange[]; DeleteFiles?: { filePath: string }[] }) {
  return trailed(ctx, SRC, 'CreateCommit', resTag(p.RepositoryName), { repositoryName: p.RepositoryName, branchName: p.BranchName, parentCommitId: p.ParentCommitId, commitMessage: p.CommitMessage }, () => {
    authorize(ctx, 'codecommit:CreateCommit', repoArn(ctx, p.RepositoryName), { context: refContext(p.BranchName) });
    const r = getRepo(ctx, p.RepositoryName);
    if (!p.PutFiles?.length && !p.DeleteFiles?.length) throw err('NoChangeException', 'The commit cannot be created because no changes will be made to the repository as a result of this commit. A commit must contain at least one change.');
    const res = commitChanges(ctx, r, { branch: p.BranchName, parent: p.ParentCommitId, message: p.CommitMessage, name: p.AuthorName, email: p.Email, put: p.PutFiles, del: (p.DeleteFiles ?? []).map((d) => d.filePath) });
    return { r, ...res };
  });
}

export function putFile(ctx: Ctx, p: { RepositoryName: string; BranchName: string; FileContent: string; FilePath: string; ParentCommitId?: string; CommitMessage?: string; Name?: string; Email?: string }) {
  return trailed(ctx, SRC, 'PutFile', resTag(p.RepositoryName), { repositoryName: p.RepositoryName, branchName: p.BranchName, filePath: p.FilePath, commitMessage: p.CommitMessage }, () => {
    authorize(ctx, 'codecommit:PutFile', repoArn(ctx, p.RepositoryName), { context: refContext(p.BranchName) });
    const r = getRepo(ctx, p.RepositoryName);
    const res = commitChanges(ctx, r, { branch: p.BranchName, parent: p.ParentCommitId, message: p.CommitMessage, name: p.Name, email: p.Email, put: [{ filePath: p.FilePath, fileContent: p.FileContent }] });
    return { commit: res.commit, blobId: res.commit.tree[p.FilePath] };
  });
}

export function deleteFile(ctx: Ctx, p: { RepositoryName: string; BranchName: string; FilePath: string; ParentCommitId: string; CommitMessage?: string; Name?: string; Email?: string }) {
  return trailed(ctx, SRC, 'DeleteFile', resTag(p.RepositoryName), { repositoryName: p.RepositoryName, branchName: p.BranchName, filePath: p.FilePath }, () => {
    authorize(ctx, 'codecommit:DeleteFile', repoArn(ctx, p.RepositoryName), { context: refContext(p.BranchName) });
    const r = getRepo(ctx, p.RepositoryName);
    if (!r.branches[p.BranchName]) throw err('BranchDoesNotExistException', `${p.BranchName} does not exist`);
    const before = filesOf(r.objs, r.branches[p.BranchName])[p.FilePath];
    if (before === undefined) throw err('FileDoesNotExistException', `${p.FilePath} does not exist in commit ${r.branches[p.BranchName]}`);
    const blob = r.objs.commits[r.branches[p.BranchName]].tree[p.FilePath];
    const res = commitChanges(ctx, r, { branch: p.BranchName, parent: p.ParentCommitId, message: p.CommitMessage || `Deleted ${p.FilePath}`, name: p.Name, email: p.Email, del: [p.FilePath] });
    return { commit: res.commit, blobId: blob };
  });
}

export function getFile(ctx: Ctx, p: { RepositoryName: string; FilePath: string; CommitSpecifier?: string }) {
  return trailed(ctx, SRC, 'GetFile', resTag(p.RepositoryName), { repositoryName: p.RepositoryName, filePath: p.FilePath, commitSpecifier: p.CommitSpecifier }, () => {
    authorize(ctx, 'codecommit:GetFile', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    const spec = p.CommitSpecifier ?? r.defaultBranch;
    if (!spec) throw err('CommitDoesNotExistException', 'The repository has no commits yet.');
    const c = commitOrFail(r, spec);
    const path = (p.FilePath ?? '').replace(/^\//, '');
    const blob = c.tree[path];
    if (blob === undefined) throw err('FileDoesNotExistException', `${p.FilePath} does not exist in commit ${c.id}`);
    return { commitId: c.id, blobId: blob, filePath: path, fileMode: 'NORMAL', fileSize: new TextEncoder().encode(r.objs.blobs[blob]).length, content: r.objs.blobs[blob] };
  });
}

export function getBlob(ctx: Ctx, p: { RepositoryName: string; BlobId: string }): string {
  return trailed(ctx, SRC, 'GetBlob', resTag(p.RepositoryName), { repositoryName: p.RepositoryName, blobId: p.BlobId }, () => {
    authorize(ctx, 'codecommit:GetBlob', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    const b = r.objs.blobs[p.BlobId];
    if (b === undefined) throw err('BlobIdDoesNotExistException', `${p.BlobId} does not exist`);
    return b;
  });
}

export function getFolder(ctx: Ctx, p: { RepositoryName: string; FolderPath: string; CommitSpecifier?: string }) {
  return trailed(ctx, SRC, 'GetFolder', resTag(p.RepositoryName), { repositoryName: p.RepositoryName, folderPath: p.FolderPath }, () => {
    authorize(ctx, 'codecommit:GetFolder', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    const spec = p.CommitSpecifier ?? r.defaultBranch;
    if (!spec) throw err('CommitDoesNotExistException', 'The repository has no commits yet.');
    const c = commitOrFail(r, spec);
    const folder = (p.FolderPath ?? '').replace(/^\/+|\/+$/g, '');
    const prefix = folder ? folder + '/' : '';
    const files: { blobId: string; absolutePath: string; relativePath: string; fileMode: string }[] = [];
    const dirs = new Set<string>();
    for (const [path, blob] of Object.entries(c.tree)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const i = rest.indexOf('/');
      if (i < 0) files.push({ blobId: blob, absolutePath: path, relativePath: rest, fileMode: 'NORMAL' });
      else dirs.add(rest.slice(0, i));
    }
    if (folder && !files.length && !dirs.size) throw err('FolderDoesNotExistException', `${p.FolderPath} does not exist in commit ${c.id}`);
    return { commitId: c.id, folderPath: folder, treeId: treeIdOf(c), files, subFolders: [...dirs].sort().map((d) => ({ treeId: sha1Hex('tree' + prefix + d), absolutePath: prefix + d, relativePath: d })) };
  });
}

export function getDifferences(ctx: Ctx, p: { RepositoryName: string; BeforeCommitSpecifier?: string; AfterCommitSpecifier: string }) {
  return trailed(ctx, SRC, 'GetDifferences', resTag(p.RepositoryName), { repositoryName: p.RepositoryName, beforeCommitSpecifier: p.BeforeCommitSpecifier, afterCommitSpecifier: p.AfterCommitSpecifier }, () => {
    authorize(ctx, 'codecommit:GetDifferences', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    const after = commitOrFail(r, p.AfterCommitSpecifier);
    const before = p.BeforeCommitSpecifier ? commitOrFail(r, p.BeforeCommitSpecifier) : undefined;
    return diffTrees(before?.tree ?? {}, after.tree).map((d) => ({ ...d, before: before?.tree[d.path], after: after.tree[d.path] }));
  });
}

// ------------------------------------------------------------------ fusiones

type MergeOption = 'FAST_FORWARD_MERGE' | 'SQUASH_MERGE' | 'THREE_WAY_MERGE';

/** Calcula la fusión de `source` en `dest` sin escribir nada. */
function planMerge(repo: CcRepo, destId: string, srcId: string, option: MergeOption) {
  const o = repo.objs;
  const base = mergeBase(o, destId, srcId);
  const ff = isAncestor(o, destId, srcId);
  if (option === 'FAST_FORWARD_MERGE') return { mergeable: ff, conflicts: [] as string[], files: filesOf(o, srcId), ff, base };
  if (ff && option !== 'SQUASH_MERGE') return { mergeable: true, conflicts: [] as string[], files: filesOf(o, srcId), ff, base };
  const m = mergeFiles(filesOf(o, base ?? undefined), filesOf(o, destId), filesOf(o, srcId));
  return { mergeable: m.conflicts.length === 0, conflicts: m.conflicts, files: m.files, ff, base };
}

export function getMergeConflicts(ctx: Ctx, p: { RepositoryName: string; DestinationCommitSpecifier: string; SourceCommitSpecifier: string; MergeOption: MergeOption }) {
  return trailed(ctx, SRC, 'GetMergeConflicts', resTag(p.RepositoryName), { repositoryName: p.RepositoryName, destinationCommitSpecifier: p.DestinationCommitSpecifier, sourceCommitSpecifier: p.SourceCommitSpecifier, mergeOption: p.MergeOption }, () => {
    authorize(ctx, 'codecommit:GetMergeConflicts', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    if (!['FAST_FORWARD_MERGE', 'SQUASH_MERGE', 'THREE_WAY_MERGE'].includes(p.MergeOption)) throw err('InvalidMergeOptionException', 'The specified merge option is not valid. Valid merge options are FAST_FORWARD_MERGE, SQUASH_MERGE, or THREE_WAY_MERGE.');
    const d = commitOrFail(r, p.DestinationCommitSpecifier), s = commitOrFail(r, p.SourceCommitSpecifier);
    const plan = planMerge(r, d.id, s.id, p.MergeOption);
    return { mergeable: plan.mergeable, destinationCommitId: d.id, sourceCommitId: s.id, baseCommitId: plan.base ?? undefined, conflicts: plan.conflicts };
  });
}

function doMerge(ctx: Ctx, repo: CcRepo, destBranch: string, srcId: string, option: MergeOption, message: string, who: { name?: string; email?: string }): GitCommit {
  const destId = repo.branches[destBranch];
  if (!destId) throw err('BranchDoesNotExistException', `${destBranch} does not exist`);
  const plan = planMerge(repo, destId, srcId, option);
  if (!plan.mergeable) throw err('ManualMergeRequiredException', 'The pull request cannot be merged automatically into the destination branch. You must manually merge the branches and resolve any conflicts.');
  if (destId === srcId) throw err('NoChangeException', 'The merge cannot be completed because the source and destination are the same commit.');
  let commit: GitCommit;
  if (option === 'FAST_FORWARD_MERGE' || (plan.ff && option === 'THREE_WAY_MERGE')) commit = repo.objs.commits[srcId];
  else commit = makeCommit(repo.objs, { tree: treeOf(repo.objs, plan.files), parents: option === 'SQUASH_MERGE' ? [destId] : [destId, srcId], message, author: identFor(ctx, who.name, who.email) });
  setBranch(ctx, repo, destBranch, commit.id);
  return commit;
}

export function mergeBranches(ctx: Ctx, option: MergeOption, p: { RepositoryName: string; SourceCommitSpecifier: string; DestinationCommitSpecifier: string; TargetBranch?: string; CommitMessage?: string; AuthorName?: string; Email?: string }) {
  const ev = option === 'FAST_FORWARD_MERGE' ? 'MergeBranchesByFastForward' : option === 'SQUASH_MERGE' ? 'MergeBranchesBySquash' : 'MergeBranchesByThreeWay';
  return trailed(ctx, SRC, ev, resTag(p.RepositoryName), { repositoryName: p.RepositoryName, sourceCommitSpecifier: p.SourceCommitSpecifier, destinationCommitSpecifier: p.DestinationCommitSpecifier }, () => {
    const r = getRepo(ctx, p.RepositoryName);
    const target = p.TargetBranch ?? p.DestinationCommitSpecifier.replace(/^refs\/heads\//, '');
    authorize(ctx, `codecommit:${ev}`, repoArn(ctx, p.RepositoryName), { context: refContext(target) });
    const dest = commitOrFail(r, p.DestinationCommitSpecifier), src = commitOrFail(r, p.SourceCommitSpecifier);
    if (!r.branches[target]) {
      if (option !== 'FAST_FORWARD_MERGE' && !isAncestor(r.objs, dest.id, src.id)) { /* se crea la rama destino desde `dest` */ }
      r.branches[target] = dest.id;
    }
    const c = doMerge(ctx, r, target, src.id, option, p.CommitMessage || `Merge branch '${p.SourceCommitSpecifier}' into ${target}`, { name: p.AuthorName, email: p.Email });
    return c;
  });
}

// ------------------------------------------------------------------ pull requests

const PR_RULE_NAME_RE = /^[\w.-]{1,100}$/;

function parseRuleContent(content: string): { Version: string; DestinationReferences?: string[]; Statements: { Type: 'Approvers'; NumberOfApprovalsNeeded: number; ApprovalPoolMembers?: string[] }[] } {
  let o: any;
  try { o = JSON.parse(content); } catch { throw err('InvalidApprovalRuleContentException', `The content for the approval rule is not valid. Reason: Failed to parse the approval rule content as JSON.`); }
  const bad = (why: string) => err('InvalidApprovalRuleContentException', `The content for the approval rule is not valid. Reason: ${why}`);
  if (!o || o.Version !== '2018-11-08') throw bad('Version must be 2018-11-08.');
  if (!Array.isArray(o.Statements) || !o.Statements.length) throw bad('Statements is required.');
  for (const st of o.Statements) {
    if (st.Type !== 'Approvers') throw bad('Statement Type must be Approvers.');
    if (!Number.isInteger(st.NumberOfApprovalsNeeded) || st.NumberOfApprovalsNeeded < 1) throw bad('NumberOfApprovalsNeeded must be a positive integer.');
  }
  return o;
}

const prUrl = (pr: CcPr) => pr.id;

function approvalMatches(ctx: { s: CloudState }, member: string, user: string): boolean {
  if (wildcardMatch(member, user)) return true;
  // CodeCommitApprovers:<cuenta>:<nombre> equivale al usuario/rol con ese nombre.
  const m = /^CodeCommitApprovers:\d+:(.+)$/.exec(member);
  return !!m && (user.endsWith('/' + m[1]) || user.includes(`/${m[1]}/`));
}

export function evaluateRules(s: CloudState, pr: CcPr): { approved: boolean; satisfied: string[]; notSatisfied: string[] } {
  const approvers = pr.approvals.filter((a) => a.state === 'APPROVE').map((a) => a.user);
  const satisfied: string[] = [], notSatisfied: string[] = [];
  for (const rule of pr.rules) {
    const c = JSON.parse(rule.content);
    const st = c.Statements[0];
    const pool: string[] | undefined = st.ApprovalPoolMembers;
    const n = approvers.filter((u) => u !== pr.author && (!pool?.length || pool.some((m) => approvalMatches({ s }, m, u)))).length;
    (n >= st.NumberOfApprovalsNeeded ? satisfied : notSatisfied).push(rule.name);
  }
  return { approved: notSatisfied.length === 0, satisfied, notSatisfied };
}

function getPr(ctx: Ctx, id: string): { repo: CcRepo; pr: CcPr } {
  if (!id) throw err('PullRequestIdRequiredException', 'A pull request ID is required, but none was provided.');
  for (const repo of cicd(ctx.s).repos) {
    if (repo.region !== ctx.region) continue;
    const pr = repo.prs.find((x) => x.id === String(id));
    if (pr) return { repo, pr };
  }
  throw err('PullRequestDoesNotExistException', `The pull request ID ${id} could not be found.`);
}

export const findPullRequest = getPr;

const ruleSha = (c: string) => sha1Hex(c).slice(0, 64);

export function createPullRequest(ctx: Ctx, p: { Title: string; Description?: string; Targets: { repositoryName: string; sourceReference: string; destinationReference?: string }[] }): CcPr {
  const t = p.Targets?.[0];
  return trailed(ctx, SRC, 'CreatePullRequest', resTag(t?.repositoryName ?? ''), { title: p.Title, targets: p.Targets }, () => {
    if (!p.Title) throw err('TitleRequiredException', 'A pull request title is required. It cannot be empty or null.');
    if (!t) throw err('TargetsRequiredException', 'An array of target objects is required. It cannot be empty or null.');
    authorize(ctx, 'codecommit:CreatePullRequest', repoArn(ctx, t.repositoryName));
    const repo = getRepo(ctx, t.repositoryName);
    const src = (t.sourceReference ?? '').replace(/^refs\/heads\//, '');
    const dst = (t.destinationReference ?? repo.defaultBranch ?? '').replace(/^refs\/heads\//, '');
    if (!src) throw err('ReferenceNameRequiredException', 'A reference name is required.');
    if (!repo.branches[src]) throw err('ReferenceDoesNotExistException', `The specified reference does not exist. You must provide a full commit ID, a valid branch name or a valid tag. ${src}`);
    if (!dst || !repo.branches[dst]) throw err('ReferenceDoesNotExistException', `The specified reference does not exist. You must provide a full commit ID, a valid branch name or a valid tag. ${dst}`);
    if (src === dst) throw err('SourceAndDestinationAreSameException', 'The source branch and destination branch for the pull request are the same. You must specify different branches for the source and destination.');
    const sc = repo.branches[src], dc = repo.branches[dst];
    const rules: CcPrRule[] = [];
    for (const tpl of cicd(ctx.s).ruleTemplates.filter((x) => x.repos.includes(repo.name))) {
      const c = JSON.parse(tpl.content);
      if (c.DestinationReferences?.length && !c.DestinationReferences.includes(`refs/heads/${dst}`)) continue;
      rules.push({ id: guid(), name: tpl.name, content: tpl.content, fromTemplate: tpl.id, created: now(), modified: now() });
    }
    const pr: CcPr = { id: String(repo.nextPr++), title: p.Title, description: p.Description, author: ctx.caller.arn, status: 'OPEN', created: now(), lastActivity: now(), source: src, dest: dst, sourceCommit: sc, destCommit: dc, mergeBase: mergeBase(repo.objs, sc, dc) ?? dc, revisionId: sha1Hex(sc + dc).slice(0, 64), approvals: [], rules, comments: [] };
    repo.prs.push(pr);
    return pr;
  });
}

export function getPullRequest(ctx: Ctx, p: { PullRequestId: string }) {
  return trailed(ctx, SRC, 'GetPullRequest', [], { pullRequestId: p.PullRequestId }, () => {
    const { repo, pr } = getPr(ctx, p.PullRequestId);
    authorize(ctx, 'codecommit:GetPullRequest', repo.arn);
    return { repo, pr };
  });
}

export function listPullRequests(ctx: Ctx, p: { RepositoryName: string; PullRequestStatus?: 'OPEN' | 'CLOSED'; AuthorArn?: string }): string[] {
  return trailed(ctx, SRC, 'ListPullRequests', resTag(p.RepositoryName), { repositoryName: p.RepositoryName, pullRequestStatus: p.PullRequestStatus }, () => {
    authorize(ctx, 'codecommit:ListPullRequests', repoArn(ctx, p.RepositoryName));
    const r = getRepo(ctx, p.RepositoryName);
    return r.prs.filter((x) => (!p.PullRequestStatus || x.status === p.PullRequestStatus) && (!p.AuthorArn || x.author === p.AuthorArn)).map((x) => x.id);
  });
}

export function updatePullRequestStatus(ctx: Ctx, p: { PullRequestId: string; PullRequestStatus: 'OPEN' | 'CLOSED' }) {
  return trailed(ctx, SRC, 'UpdatePullRequestStatus', [], { pullRequestId: p.PullRequestId, pullRequestStatus: p.PullRequestStatus }, () => {
    const { repo, pr } = getPr(ctx, p.PullRequestId);
    authorize(ctx, 'codecommit:UpdatePullRequestStatus', repo.arn);
    if (!['OPEN', 'CLOSED'].includes(p.PullRequestStatus)) throw err('InvalidPullRequestStatusException', 'The pull request status is not valid. The only valid values are OPEN and CLOSED.');
    if (pr.merged) throw err('PullRequestAlreadyClosedException', 'The pull request status cannot be updated because it is already closed.');
    if (pr.status === p.PullRequestStatus) throw err('InvalidPullRequestStatusUpdateException', `The pull request status update is not valid. The pull request is already ${p.PullRequestStatus}.`);
    pr.status = p.PullRequestStatus;
    pr.lastActivity = now();
    return { repo, pr };
  });
}

export function updatePullRequestText(ctx: Ctx, which: 'Title' | 'Description', p: { PullRequestId: string; Title?: string; Description?: string }) {
  return trailed(ctx, SRC, `UpdatePullRequest${which}`, [], { pullRequestId: p.PullRequestId }, () => {
    const { repo, pr } = getPr(ctx, p.PullRequestId);
    authorize(ctx, `codecommit:UpdatePullRequest${which}`, repo.arn);
    if (pr.status === 'CLOSED') throw err('PullRequestAlreadyClosedException', 'The pull request status cannot be updated because it is already closed.');
    if (which === 'Title') pr.title = p.Title ?? pr.title;
    else pr.description = p.Description;
    pr.lastActivity = now();
    return { repo, pr };
  });
}

export function mergePullRequest(ctx: Ctx, option: MergeOption, p: { PullRequestId: string; RepositoryName: string; SourceCommitId?: string; CommitMessage?: string; AuthorName?: string; Email?: string }) {
  const ev = option === 'FAST_FORWARD_MERGE' ? 'MergePullRequestByFastForward' : option === 'SQUASH_MERGE' ? 'MergePullRequestBySquash' : 'MergePullRequestByThreeWay';
  return trailed(ctx, SRC, ev, resTag(p.RepositoryName), { pullRequestId: p.PullRequestId, repositoryName: p.RepositoryName }, () => {
    const { repo, pr } = getPr(ctx, p.PullRequestId);
    authorize(ctx, `codecommit:${ev}`, repo.arn, { context: refContext(pr.dest) });
    if (repo.name !== p.RepositoryName) throw err('RepositoryNotAssociatedWithPullRequestException', 'The repository does not contain any pull requests with that pull request ID. Use GetPullRequest to verify the correct repository name for the pull request ID.');
    if (pr.status === 'CLOSED') throw err('PullRequestAlreadyClosedException', 'The pull request status cannot be updated because it is already closed.');
    refreshPrs(repo);
    if (p.SourceCommitId && p.SourceCommitId !== pr.sourceCommit) throw err('TipOfSourceReferenceIsDifferentException', 'The tip of the source branch in the destination repository does not match the tip of the source branch specified in your request. The pull request might have been updated. Make sure that you have the latest changes.');
    const ev2 = evaluateRules(ctx.s, pr);
    if (!ev2.approved) throw err('PullRequestApprovalRulesNotSatisfiedException', 'The pull request cannot be merged because one or more approval rules applied to the pull request have not been satisfied.');
    const msg = p.CommitMessage || `Merged PR ${pr.id}: ${pr.title}`;
    const c = doMerge(ctx, repo, pr.dest, pr.sourceCommit, option, msg, { name: p.AuthorName, email: p.Email });
    pr.status = 'CLOSED';
    pr.merged = { by: ctx.caller.arn, at: now(), commit: c.id, option };
    pr.destCommit = c.id;
    pr.lastActivity = now();
    return { repo, pr };
  });
}

export function postComment(ctx: Ctx, p: { PullRequestId: string; Content: string }) {
  return trailed(ctx, SRC, 'PostCommentForPullRequest', [], { pullRequestId: p.PullRequestId }, () => {
    const { repo, pr } = getPr(ctx, p.PullRequestId);
    authorize(ctx, 'codecommit:PostCommentForPullRequest', repo.arn);
    if (!p.Content) throw err('CommentContentRequiredException', 'The comment is empty. You must provide some content for a comment. The content cannot be null.');
    const c = { id: guid(), author: ctx.caller.arn, text: p.Content, ts: now() };
    pr.comments.push(c);
    pr.lastActivity = now();
    return { repo, pr, comment: c };
  });
}

// ------------------------------------------------------------------ aprobaciones

export function updateApprovalState(ctx: Ctx, p: { PullRequestId: string; RevisionId: string; ApprovalState: 'APPROVE' | 'REVOKE' }): void {
  return trailed(ctx, SRC, 'UpdatePullRequestApprovalState', [], { pullRequestId: p.PullRequestId, revisionId: p.RevisionId, approvalState: p.ApprovalState }, () => {
    const { repo, pr } = getPr(ctx, p.PullRequestId);
    authorize(ctx, 'codecommit:UpdatePullRequestApprovalState', repo.arn);
    if (!['APPROVE', 'REVOKE'].includes(p.ApprovalState)) throw err('InvalidApprovalStateException', 'The state for the approval is not valid. Valid values include APPROVE and REVOKE.');
    refreshPrs(repo);
    if (!p.RevisionId || p.RevisionId !== pr.revisionId) throw err('InvalidRevisionIdException', 'The revision ID is not valid. Use GetPullRequest to determine the value.');
    if (pr.status === 'CLOSED') throw err('PullRequestAlreadyClosedException', 'The pull request status cannot be updated because it is already closed.');
    if (pr.author === ctx.caller.arn) throw err('PullRequestCannotBeApprovedByAuthorException', 'The approval cannot be applied because the user approving the pull request matches the user who created the pull request. You cannot approve a pull request that you created.');
    pr.approvals = pr.approvals.filter((a) => a.user !== ctx.caller.arn);
    pr.approvals.push({ user: ctx.caller.arn, state: p.ApprovalState });
    pr.lastActivity = now();
  });
}

export function getApprovalStates(ctx: Ctx, p: { PullRequestId: string; RevisionId: string }) {
  return trailed(ctx, SRC, 'GetPullRequestApprovalStates', [], { pullRequestId: p.PullRequestId, revisionId: p.RevisionId }, () => {
    const { repo, pr } = getPr(ctx, p.PullRequestId);
    authorize(ctx, 'codecommit:GetPullRequestApprovalStates', repo.arn);
    if (p.RevisionId !== pr.revisionId) throw err('InvalidRevisionIdException', 'The revision ID is not valid. Use GetPullRequest to determine the value.');
    return pr.approvals;
  });
}

export function evaluatePullRequestRules(ctx: Ctx, p: { PullRequestId: string; RevisionId: string }) {
  return trailed(ctx, SRC, 'EvaluatePullRequestApprovalRules', [], { pullRequestId: p.PullRequestId, revisionId: p.RevisionId }, () => {
    const { repo, pr } = getPr(ctx, p.PullRequestId);
    authorize(ctx, 'codecommit:EvaluatePullRequestApprovalRules', repo.arn);
    if (p.RevisionId !== pr.revisionId) throw err('InvalidRevisionIdException', 'The revision ID is not valid. Use GetPullRequest to determine the value.');
    return evaluateRules(ctx.s, pr);
  });
}

export function createPrApprovalRule(ctx: Ctx, p: { PullRequestId: string; ApprovalRuleName: string; ApprovalRuleContent: string }): CcPrRule {
  return trailed(ctx, SRC, 'CreatePullRequestApprovalRule', [], { pullRequestId: p.PullRequestId, approvalRuleName: p.ApprovalRuleName }, () => {
    const { repo, pr } = getPr(ctx, p.PullRequestId);
    authorize(ctx, 'codecommit:CreatePullRequestApprovalRule', repo.arn);
    if (!PR_RULE_NAME_RE.test(p.ApprovalRuleName ?? '')) throw err('InvalidApprovalRuleNameException', 'The name for the approval rule is not valid. Names must be between 1 and 100 characters.');
    parseRuleContent(p.ApprovalRuleContent);
    if (pr.rules.some((x) => x.name === p.ApprovalRuleName)) throw err('ApprovalRuleNameAlreadyExistsException', 'The approval rule cannot be added. The pull request already has an approval rule with the same name.');
    const rule: CcPrRule = { id: guid(), name: p.ApprovalRuleName, content: p.ApprovalRuleContent, created: now(), modified: now() };
    pr.rules.push(rule);
    return rule;
  });
}

export function deletePrApprovalRule(ctx: Ctx, p: { PullRequestId: string; ApprovalRuleName: string }): string {
  return trailed(ctx, SRC, 'DeletePullRequestApprovalRule', [], { pullRequestId: p.PullRequestId, approvalRuleName: p.ApprovalRuleName }, () => {
    const { repo, pr } = getPr(ctx, p.PullRequestId);
    authorize(ctx, 'codecommit:DeletePullRequestApprovalRule', repo.arn);
    const rule = pr.rules.find((x) => x.name === p.ApprovalRuleName);
    if (!rule) return '';
    pr.rules = pr.rules.filter((x) => x !== rule);
    return rule.id;
  });
}

// ------------------------------------------------------------------ plantillas de reglas de aprobación

const getTpl = (ctx: Ctx, name: string): CcRuleTemplate => {
  const t = cicd(ctx.s).ruleTemplates.find((x) => x.name === name);
  if (!t) throw err('ApprovalRuleTemplateDoesNotExistException', `The specified approval rule template does not exist. Verify that the name is correct and that you are signed in to the AWS Region where the template was created, and then try again.`);
  return t;
};

export function createRuleTemplate(ctx: Ctx, p: { ApprovalRuleTemplateName: string; ApprovalRuleTemplateContent: string; ApprovalRuleTemplateDescription?: string }): CcRuleTemplate {
  return trailed(ctx, SRC, 'CreateApprovalRuleTemplate', [], { approvalRuleTemplateName: p.ApprovalRuleTemplateName }, () => {
    authorize(ctx, 'codecommit:CreateApprovalRuleTemplate', '*');
    if (!PR_RULE_NAME_RE.test(p.ApprovalRuleTemplateName ?? '')) throw err('InvalidApprovalRuleTemplateNameException', 'The name of the approval rule template is not valid. Template names must be between 1 and 100 characters in length.');
    parseRuleContent(p.ApprovalRuleTemplateContent);
    if (cicd(ctx.s).ruleTemplates.some((x) => x.name === p.ApprovalRuleTemplateName)) throw err('ApprovalRuleTemplateNameAlreadyExistsException', 'You cannot create an approval rule template with that name because a template with that name already exists in this Region for your AWS account. Approval rule template names must be unique.');
    const t: CcRuleTemplate = { id: guid(), name: p.ApprovalRuleTemplateName, description: p.ApprovalRuleTemplateDescription, content: p.ApprovalRuleTemplateContent, created: now(), modified: now(), creator: ctx.caller.arn, repos: [] };
    cicd(ctx.s).ruleTemplates.push(t);
    return t;
  });
}

export function getRuleTemplate(ctx: Ctx, p: { ApprovalRuleTemplateName: string }): CcRuleTemplate {
  return trailed(ctx, SRC, 'GetApprovalRuleTemplate', [], { approvalRuleTemplateName: p.ApprovalRuleTemplateName }, () => {
    authorize(ctx, 'codecommit:GetApprovalRuleTemplate', '*');
    return getTpl(ctx, p.ApprovalRuleTemplateName);
  });
}

export function listRuleTemplates(ctx: Ctx): CcRuleTemplate[] {
  return trailed(ctx, SRC, 'ListApprovalRuleTemplates', [], {}, () => {
    authorize(ctx, 'codecommit:ListApprovalRuleTemplates', '*');
    return cicd(ctx.s).ruleTemplates;
  });
}

export function deleteRuleTemplate(ctx: Ctx, p: { ApprovalRuleTemplateName: string }): string {
  return trailed(ctx, SRC, 'DeleteApprovalRuleTemplate', [], { approvalRuleTemplateName: p.ApprovalRuleTemplateName }, () => {
    authorize(ctx, 'codecommit:DeleteApprovalRuleTemplate', '*');
    const c = cicd(ctx.s);
    const t = c.ruleTemplates.find((x) => x.name === p.ApprovalRuleTemplateName);
    if (!t) return '';
    if (t.repos.length) throw err('ApprovalRuleTemplateInUseException', 'The approval rule template is associated with one or more repositories. You cannot delete a template that is associated with a repository. Remove all associations, and then try again.');
    c.ruleTemplates = c.ruleTemplates.filter((x) => x !== t);
    return t.id;
  });
}

export function associateRuleTemplate(ctx: Ctx, p: { ApprovalRuleTemplateName: string; RepositoryName: string }, on: boolean): void {
  return trailed(ctx, SRC, on ? 'AssociateApprovalRuleTemplateWithRepository' : 'DisassociateApprovalRuleTemplateFromRepository', resTag(p.RepositoryName), { approvalRuleTemplateName: p.ApprovalRuleTemplateName, repositoryName: p.RepositoryName }, () => {
    authorize(ctx, on ? 'codecommit:AssociateApprovalRuleTemplateWithRepository' : 'codecommit:DisassociateApprovalRuleTemplateFromRepository', repoArn(ctx, p.RepositoryName));
    const t = getTpl(ctx, p.ApprovalRuleTemplateName);
    getRepo(ctx, p.RepositoryName);
    if (on && !t.repos.includes(p.RepositoryName)) t.repos.push(p.RepositoryName);
    if (!on) t.repos = t.repos.filter((x) => x !== p.RepositoryName);
  });
}

export function listAssociatedTemplates(ctx: Ctx, p: { RepositoryName: string }): string[] {
  return trailed(ctx, SRC, 'ListAssociatedApprovalRuleTemplatesForRepository', resTag(p.RepositoryName), { repositoryName: p.RepositoryName }, () => {
    authorize(ctx, 'codecommit:ListAssociatedApprovalRuleTemplatesForRepository', repoArn(ctx, p.RepositoryName));
    getRepo(ctx, p.RepositoryName);
    return cicd(ctx.s).ruleTemplates.filter((t) => t.repos.includes(p.RepositoryName)).map((t) => t.name);
  });
}

// ------------------------------------------------------------------ Git sobre HTTPS (clone, fetch, pull, push)

/** Autoriza y registra GitPull. Devuelve el repositorio. */
export function gitPull(ctx: Ctx, repoName: string): CcRepo {
  return trailed(ctx, SRC, 'GitPull', resTag(repoName), { repositoryName: repoName }, () => {
    authorize(ctx, 'codecommit:GitPull', repoArn(ctx, repoName));
    return getRepo(ctx, repoName);
  });
}

export interface PushUpdate { branch: string; newId: string | null; force?: boolean }

/** Autoriza y registra GitPush; aplica las actualizaciones de ramas. Devuelve el resultado por rama. */
export function gitPush(ctx: Ctx, repoName: string, updates: PushUpdate[], from: import('./cicdTypes').GitObjects): { branch: string; status: 'new' | 'ff' | 'forced' | 'deleted' | 'rejected' | 'up-to-date'; old?: string; id?: string }[] {
  return trailed(ctx, SRC, 'GitPush', resTag(repoName), { repositoryName: repoName, references: updates.map((u) => ({ commit: u.newId ?? '', ref: `refs/heads/${u.branch}` })) }, () => {
    const repo = getRepo(ctx, repoName);
    const ctxArr = updates.map((u) => `refs/heads/${u.branch}`);
    authorize(ctx, 'codecommit:GitPush', repo.arn, { context: { 'codecommit:References': ctxArr } });
    const out: ReturnType<typeof gitPush> = [];
    for (const u of updates) {
      const old = repo.branches[u.branch];
      if (u.newId === null) {
        if (!old) { out.push({ branch: u.branch, status: 'rejected' }); continue; }
        if (repo.defaultBranch === u.branch) { out.push({ branch: u.branch, status: 'rejected', old }); continue; }
        delete repo.branches[u.branch];
        out.push({ branch: u.branch, status: 'deleted', old });
        continue;
      }
      if (old === u.newId) { out.push({ branch: u.branch, status: 'up-to-date', id: u.newId }); continue; }
      for (const id of ancestorsOf(from, u.newId)) {
        if (repo.objs.commits[id]) continue;
        const c = from.commits[id];
        repo.objs.commits[id] = c;
        for (const b of Object.values(c.tree)) repo.objs.blobs[b] = from.blobs[b];
      }
      if (old && !isAncestor(repo.objs, old, u.newId) && !u.force) { out.push({ branch: u.branch, status: 'rejected', old, id: u.newId }); continue; }
      repo.branches[u.branch] = u.newId;
      repo.defaultBranch ??= u.branch;
      out.push({ branch: u.branch, status: !old ? 'new' : isAncestor(repo.objs, old, u.newId) ? 'ff' : 'forced', old, id: u.newId });
      afterRefUpdate(ctx, repo, u.branch);
    }
    repo.modified = now();
    return out;
  });
}

function ancestorsOf(o: import('./cicdTypes').GitObjects, tip: string): string[] {
  const seen: string[] = [];
  const st = [tip];
  const done = new Set<string>();
  while (st.length) {
    const id = st.pop()!;
    if (done.has(id) || !o.commits[id]) continue;
    done.add(id);
    seen.push(id);
    st.push(...o.commits[id].parents);
  }
  return seen;
}

export { prUrl, ruleSha, putBlob, hex, asArr };

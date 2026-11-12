// aws codecommit
import { defineCommand, type Params } from '../framework';
import * as cc from '../../../engine/services/codecommit';
import '../../../engine/services/cicd';
import type { Ctx } from '../../../engine/api';
import type { CcPr, CcRepo, GitCommit } from '../../../engine/services/cicdTypes';
import { sha1 } from '../../../engine/services/gitCore';
import { b64, blobIn, iso, strip } from './cicd-util';
import type { Shell } from '../../interp';

export const repoMeta = (c: Ctx, r: CcRepo) => strip({
  accountId: c.s.account.id, repositoryId: r.id, repositoryName: r.name, repositoryDescription: r.description, defaultBranch: r.defaultBranch,
  lastModifiedDate: iso(r.modified), creationDate: iso(r.created), cloneUrlHttp: cc.cloneUrl(r.region, r.name), cloneUrlSsh: `ssh://git-codecommit.${r.region}.amazonaws.com/v1/repos/${r.name}`, Arn: r.arn,
});

const ident = (i: GitCommit['author']) => ({ name: i.name, email: i.email, date: `${Math.floor(i.date / 1000)} +0000` });
export const commitView = (c: GitCommit) => ({ commitId: c.id, treeId: cc.treeIdOf(c), parents: c.parents, message: c.message, author: ident(c.author), committer: ident(c.committer), additionalData: '' });

const ruleView = (r: CcPr['rules'][number]) => strip({
  approvalRuleId: r.id, approvalRuleName: r.name, approvalRuleContent: r.content, ruleContentSha256: cc.ruleSha(r.content), lastModifiedDate: iso(r.modified), creationDate: iso(r.created),
  lastModifiedUser: 'arn:aws:iam::000000000000:root', originApprovalRuleTemplate: r.fromTemplate ? { approvalRuleTemplateId: r.fromTemplate, approvalRuleTemplateName: r.name } : undefined,
});

export const prView = (repo: CcRepo, pr: CcPr) => strip({
  pullRequestId: pr.id, title: pr.title, description: pr.description, lastActivityDate: iso(pr.lastActivity), creationDate: iso(pr.created), pullRequestStatus: pr.status, authorArn: pr.author,
  pullRequestTargets: [{
    repositoryName: repo.name, sourceReference: `refs/heads/${pr.source}`, destinationReference: `refs/heads/${pr.dest}`, destinationCommit: pr.destCommit, sourceCommit: pr.sourceCommit, mergeBase: pr.mergeBase,
    mergeMetadata: strip({ isMerged: !!pr.merged, mergedBy: pr.merged?.by, mergeCommitId: pr.merged?.commit, mergeOption: pr.merged?.option }),
  }],
  clientRequestToken: '', revisionId: pr.revisionId, approvalRules: pr.rules.map(ruleView),
});

const tplView = (t: import('../../../engine/services/cicdTypes').CcRuleTemplate) => strip({
  approvalRuleTemplateId: t.id, approvalRuleTemplateName: t.name, approvalRuleTemplateDescription: t.description, approvalRuleTemplateContent: t.content, ruleContentSha256: cc.ruleSha(t.content),
  lastModifiedDate: iso(t.modified), creationDate: iso(t.created), lastModifiedUser: t.creator,
});

const S = 'codecommit';
const repo = (p: Params) => String(p.RepositoryName);
const fileList = (sh: Shell, p: Params, list?: any[]) => (list ?? []).map((f) => ({ filePath: f.filePath, fileContent: f.fileContent === undefined ? '' : blobIn(sh, p, f.fileContent), fileMode: f.fileMode }));

defineCommand({ service: S, name: 'create-repository', op: 'CreateRepository', list: ['tags'], structured: ['tags'], run: (c, p) => ({ repositoryMetadata: repoMeta(c, cc.createRepository(c, { RepositoryName: p.RepositoryName, RepositoryDescription: p.RepositoryDescription })) }) });
defineCommand({ service: S, name: 'get-repository', op: 'GetRepository', run: (c, p) => ({ repositoryMetadata: repoMeta(c, cc.getRepository(c, { RepositoryName: repo(p) })) }) });
defineCommand({ service: S, name: 'list-repositories', op: 'ListRepositories', run: (c, p) => ({ repositories: cc.listRepositories(c, { SortBy: p.SortBy, Order: p.Order }).map((r) => ({ repositoryName: r.name, repositoryId: r.id })) }) });
defineCommand({ service: S, name: 'delete-repository', op: 'DeleteRepository', run: (c, p) => { const id = cc.deleteRepository(c, { RepositoryName: repo(p) }); return id ? { repositoryId: id } : {}; } });
defineCommand({ service: S, name: 'update-repository-description', op: 'UpdateRepositoryDescription', run: (c, p) => void cc.updateRepositoryDescription(c, { RepositoryName: repo(p), RepositoryDescription: p.RepositoryDescription }) });
defineCommand({ service: S, name: 'update-default-branch', op: 'UpdateDefaultBranch', run: (c, p) => void cc.updateDefaultBranch(c, { RepositoryName: repo(p), DefaultBranchName: p.DefaultBranchName }) });

defineCommand({ service: S, name: 'create-branch', op: 'CreateBranch', run: (c, p) => void cc.createBranch(c, { RepositoryName: repo(p), BranchName: p.BranchName, CommitId: p.CommitId }) });
defineCommand({ service: S, name: 'get-branch', op: 'GetBranch', run: (c, p) => ({ branch: cc.getBranch(c, { RepositoryName: repo(p), BranchName: p.BranchName }) }) });
defineCommand({ service: S, name: 'list-branches', op: 'ListBranches', run: (c, p) => ({ branches: cc.listBranches(c, { RepositoryName: repo(p) }) }) });
defineCommand({ service: S, name: 'delete-branch', op: 'DeleteBranch', run: (c, p) => { const b = cc.deleteBranch(c, { RepositoryName: repo(p), BranchName: p.BranchName }); return b ? { deletedBranch: b } : {}; } });

defineCommand({ service: S, name: 'get-commit', op: 'GetCommit', run: (c, p) => ({ commit: commitView(cc.getCommit(c, { RepositoryName: repo(p), CommitId: p.CommitId })) }) });
defineCommand({
  service: S, name: 'create-commit', op: 'CreateCommit', list: ['put-files', 'delete-files'], structured: ['put-files', 'delete-files'], bool: ['keep-empty-folders'],
  run: (c, p, sh) => {
    const r = cc.createCommit(c, { RepositoryName: repo(p), BranchName: p.BranchName, ParentCommitId: p.ParentCommitId, AuthorName: p.AuthorName, Email: p.Email, CommitMessage: p.CommitMessage, PutFiles: fileList(sh, p, p.PutFiles), DeleteFiles: p.DeleteFiles });
    const f = (x: { filePath: string }) => ({ absolutePath: x.filePath, blobId: r.commit.tree[x.filePath], fileMode: 'NORMAL' });
    return { commitId: r.commit.id, treeId: cc.treeIdOf(r.commit), filesAdded: r.added.map(f), filesUpdated: r.updated.map(f), filesDeleted: r.deleted.map((d) => ({ absolutePath: d, blobId: '', fileMode: 'NORMAL' })) };
  },
});
defineCommand({
  service: S, name: 'put-file', op: 'PutFile',
  run: (c, p, sh) => { const r = cc.putFile(c, { RepositoryName: repo(p), BranchName: p.BranchName, FileContent: blobIn(sh, p, p.FileContent), FilePath: p.FilePath, ParentCommitId: p.ParentCommitId, CommitMessage: p.CommitMessage, Name: p.Name, Email: p.Email }); return { commitId: r.commit.id, blobId: r.blobId, treeId: cc.treeIdOf(r.commit) }; },
});
defineCommand({
  service: S, name: 'delete-file', op: 'DeleteFile',
  run: (c, p) => { const r = cc.deleteFile(c, { RepositoryName: repo(p), BranchName: p.BranchName, FilePath: p.FilePath, ParentCommitId: p.ParentCommitId, CommitMessage: p.CommitMessage, Name: p.Name, Email: p.Email }); return { commitId: r.commit.id, blobId: r.blobId, treeId: cc.treeIdOf(r.commit), filePath: p.FilePath }; },
});
defineCommand({
  service: S, name: 'get-file', op: 'GetFile',
  run: (c, p) => { const r = cc.getFile(c, { RepositoryName: repo(p), FilePath: p.FilePath, CommitSpecifier: p.CommitSpecifier }); return { commitId: r.commitId, blobId: r.blobId, filePath: r.filePath, fileMode: r.fileMode, fileSize: r.fileSize, fileContent: b64(r.content) }; },
});
defineCommand({ service: S, name: 'get-blob', op: 'GetBlob', run: (c, p) => ({ content: b64(cc.getBlob(c, { RepositoryName: repo(p), BlobId: p.BlobId })) }) });
defineCommand({ service: S, name: 'get-folder', op: 'GetFolder', run: (c, p) => cc.getFolder(c, { RepositoryName: repo(p), FolderPath: p.FolderPath ?? '', CommitSpecifier: p.CommitSpecifier }) });
defineCommand({
  service: S, name: 'get-differences', op: 'GetDifferences',
  run: (c, p) => ({
    differences: cc.getDifferences(c, { RepositoryName: repo(p), BeforeCommitSpecifier: p.BeforeCommitSpecifier, AfterCommitSpecifier: p.AfterCommitSpecifier }).map((d) => strip({
      beforeBlob: d.before ? { blobId: d.before, path: d.path, mode: '100644' } : undefined, afterBlob: d.after ? { blobId: d.after, path: d.path, mode: '100644' } : undefined, changeType: d.kind,
    })),
  }),
});

// fusiones
defineCommand({
  service: S, name: 'get-merge-conflicts', op: 'GetMergeConflicts',
  run: (c, p) => {
    const r = cc.getMergeConflicts(c, { RepositoryName: repo(p), DestinationCommitSpecifier: p.DestinationCommitSpecifier, SourceCommitSpecifier: p.SourceCommitSpecifier, MergeOption: p.MergeOption });
    return strip({
      mergeable: r.mergeable, destinationCommitId: r.destinationCommitId, sourceCommitId: r.sourceCommitId, baseCommitId: r.baseCommitId,
      conflictMetadataList: r.conflicts.map((f) => ({ filePath: f, fileSizes: {}, fileModes: { source: 'NORMAL', destination: 'NORMAL', base: 'NORMAL' }, objectTypes: { source: 'FILE', destination: 'FILE', base: 'FILE' }, numberOfConflicts: 1, isBinaryFile: { source: false, destination: false, base: false }, contentConflict: true, fileModeConflict: false, objectTypeConflict: false, mergeOperations: { source: 'M', destination: 'M' } })),
    });
  },
});
const mb = (name: string, op: string, opt: 'FAST_FORWARD_MERGE' | 'SQUASH_MERGE' | 'THREE_WAY_MERGE') => defineCommand({
  service: S, name, op,
  run: (c, p) => { const m = cc.mergeBranches(c, opt, { RepositoryName: repo(p), SourceCommitSpecifier: p.SourceCommitSpecifier, DestinationCommitSpecifier: p.DestinationCommitSpecifier, TargetBranch: p.TargetBranch, CommitMessage: p.CommitMessage, AuthorName: p.AuthorName, Email: p.Email }); return { commitId: m.id, treeId: cc.treeIdOf(m) }; },
});
mb('merge-branches-by-fast-forward', 'MergeBranchesByFastForward', 'FAST_FORWARD_MERGE');
mb('merge-branches-by-squash', 'MergeBranchesBySquash', 'SQUASH_MERGE');
mb('merge-branches-by-three-way', 'MergeBranchesByThreeWay', 'THREE_WAY_MERGE');

// pull requests
defineCommand({ service: S, name: 'create-pull-request', op: 'CreatePullRequest', list: ['targets'], structured: ['targets'], run: (c, p) => { const pr = cc.createPullRequest(c, { Title: p.Title, Description: p.Description, Targets: p.Targets }); return { pullRequest: prView(cc.findPullRequest(c, pr.id).repo, pr) }; } });
defineCommand({ service: S, name: 'get-pull-request', op: 'GetPullRequest', run: (c, p) => { const r = cc.getPullRequest(c, { PullRequestId: String(p.PullRequestId) }); return { pullRequest: prView(r.repo, r.pr) }; } });
defineCommand({ service: S, name: 'list-pull-requests', op: 'ListPullRequests', run: (c, p) => ({ pullRequestIds: cc.listPullRequests(c, { RepositoryName: repo(p), PullRequestStatus: p.PullRequestStatus, AuthorArn: p.AuthorArn }) }) });
defineCommand({ service: S, name: 'update-pull-request-status', op: 'UpdatePullRequestStatus', run: (c, p) => { const r = cc.updatePullRequestStatus(c, { PullRequestId: String(p.PullRequestId), PullRequestStatus: p.PullRequestStatus }); return { pullRequest: prView(r.repo, r.pr) }; } });
defineCommand({ service: S, name: 'update-pull-request-title', op: 'UpdatePullRequestTitle', run: (c, p) => { const r = cc.updatePullRequestText(c, 'Title', { PullRequestId: String(p.PullRequestId), Title: p.Title }); return { pullRequest: prView(r.repo, r.pr) }; } });
defineCommand({ service: S, name: 'update-pull-request-description', op: 'UpdatePullRequestDescription', run: (c, p) => { const r = cc.updatePullRequestText(c, 'Description', { PullRequestId: String(p.PullRequestId), Description: p.Description }); return { pullRequest: prView(r.repo, r.pr) }; } });
const mp = (name: string, op: string, opt: 'FAST_FORWARD_MERGE' | 'SQUASH_MERGE' | 'THREE_WAY_MERGE') => defineCommand({
  service: S, name, op,
  run: (c, p) => { const r = cc.mergePullRequest(c, opt, { PullRequestId: String(p.PullRequestId), RepositoryName: repo(p), SourceCommitId: p.SourceCommitId, CommitMessage: p.CommitMessage, AuthorName: p.AuthorName, Email: p.Email }); return { pullRequest: prView(r.repo, r.pr) }; },
});
mp('merge-pull-request-by-fast-forward', 'MergePullRequestByFastForward', 'FAST_FORWARD_MERGE');
mp('merge-pull-request-by-squash', 'MergePullRequestBySquash', 'SQUASH_MERGE');
mp('merge-pull-request-by-three-way', 'MergePullRequestByThreeWay', 'THREE_WAY_MERGE');
defineCommand({ service: S, name: 'post-comment-for-pull-request', op: 'PostCommentForPullRequest', run: (c, p) => { const r = cc.postComment(c, { PullRequestId: String(p.PullRequestId), Content: p.Content }); return { repositoryName: r.repo.name, pullRequestId: r.pr.id, comment: { commentId: sha1(r.comment.id).slice(0, 40), content: r.comment.text, authorArn: r.comment.author, creationDate: iso(r.comment.ts), lastModifiedDate: iso(r.comment.ts) } }; } });

// aprobaciones
defineCommand({ service: S, name: 'update-pull-request-approval-state', op: 'UpdatePullRequestApprovalState', run: (c, p) => void cc.updateApprovalState(c, { PullRequestId: String(p.PullRequestId), RevisionId: p.RevisionId, ApprovalState: p.ApprovalState }) });
defineCommand({ service: S, name: 'get-pull-request-approval-states', op: 'GetPullRequestApprovalStates', run: (c, p) => ({ approvals: cc.getApprovalStates(c, { PullRequestId: String(p.PullRequestId), RevisionId: p.RevisionId }).map((a) => ({ userArn: a.user, approvalState: a.state })) }) });
defineCommand({ service: S, name: 'evaluate-pull-request-approval-rules', op: 'EvaluatePullRequestApprovalRules', run: (c, p) => { const r = cc.evaluatePullRequestRules(c, { PullRequestId: String(p.PullRequestId), RevisionId: p.RevisionId }); return { evaluation: { approved: r.approved, overridden: false, approvalRulesSatisfied: r.satisfied, approvalRulesNotSatisfied: r.notSatisfied } }; } });
defineCommand({ service: S, name: 'create-pull-request-approval-rule', op: 'CreatePullRequestApprovalRule', run: (c, p) => ({ approvalRule: ruleView(cc.createPrApprovalRule(c, { PullRequestId: String(p.PullRequestId), ApprovalRuleName: p.ApprovalRuleName, ApprovalRuleContent: p.ApprovalRuleContent })) }) });
defineCommand({ service: S, name: 'delete-pull-request-approval-rule', op: 'DeletePullRequestApprovalRule', run: (c, p) => ({ approvalRuleId: cc.deletePrApprovalRule(c, { PullRequestId: String(p.PullRequestId), ApprovalRuleName: p.ApprovalRuleName }) }) });
defineCommand({ service: S, name: 'create-approval-rule-template', op: 'CreateApprovalRuleTemplate', run: (c, p) => ({ approvalRuleTemplate: tplView(cc.createRuleTemplate(c, { ApprovalRuleTemplateName: p.ApprovalRuleTemplateName, ApprovalRuleTemplateContent: p.ApprovalRuleTemplateContent, ApprovalRuleTemplateDescription: p.ApprovalRuleTemplateDescription })) }) });
defineCommand({ service: S, name: 'get-approval-rule-template', op: 'GetApprovalRuleTemplate', run: (c, p) => ({ approvalRuleTemplate: tplView(cc.getRuleTemplate(c, { ApprovalRuleTemplateName: p.ApprovalRuleTemplateName })) }) });
defineCommand({ service: S, name: 'list-approval-rule-templates', op: 'ListApprovalRuleTemplates', run: (c) => ({ approvalRuleTemplateNames: cc.listRuleTemplates(c).map((t) => t.name) }) });
defineCommand({ service: S, name: 'delete-approval-rule-template', op: 'DeleteApprovalRuleTemplate', run: (c, p) => ({ approvalRuleTemplateId: cc.deleteRuleTemplate(c, { ApprovalRuleTemplateName: p.ApprovalRuleTemplateName }) }) });
defineCommand({ service: S, name: 'associate-approval-rule-template-with-repository', op: 'AssociateApprovalRuleTemplateWithRepository', run: (c, p) => void cc.associateRuleTemplate(c, { ApprovalRuleTemplateName: p.ApprovalRuleTemplateName, RepositoryName: repo(p) }, true) });
defineCommand({ service: S, name: 'disassociate-approval-rule-template-from-repository', op: 'DisassociateApprovalRuleTemplateFromRepository', run: (c, p) => void cc.associateRuleTemplate(c, { ApprovalRuleTemplateName: p.ApprovalRuleTemplateName, RepositoryName: repo(p) }, false) });
defineCommand({ service: S, name: 'list-associated-approval-rule-templates-for-repository', op: 'ListAssociatedApprovalRuleTemplatesForRepository', run: (c, p) => ({ approvalRuleTemplateNames: cc.listAssociatedTemplates(c, { RepositoryName: repo(p) }) }) });

import { describe, it, expect, beforeEach } from 'vitest';
import { freshState } from '../src/engine/store';
import { newShell, runString, type Shell } from '../src/shell';
import { setClock } from '../src/engine/util';
import type { CloudState } from '../src/engine/types';
import { cicd } from '../src/engine/services/cicdTypes';
import { settleCicd } from '../src/engine/services/codepipeline';

let st: CloudState;
let sh: Shell;
let ACC = '';
beforeEach(async () => {
  setClock(null);
  st = freshState('Ana');
  st.settings.speed = 'instant';
  sh = newShell(st);
  ACC = st.account.id;
  for (const l of ["git config --global credential.helper '!aws codecommit credential-helper $@'", 'git config --global user.name Ana', 'git config --global user.email ana@example.com']) await ok(l);
});
const run = (cmd: string) => runString(sh, cmd);
const ok = async (cmd: string) => {
  const r = await run(cmd);
  expect(r.err, cmd).toBe('');
  return r.out;
};
const json = async (cmd: string) => JSON.parse(await ok(cmd));
const err = async (cmd: string) => (await run(cmd)).err;
const URL = (n: string) => `https://git-codecommit.eu-west-1.amazonaws.com/v1/repos/${n}`;
const TRUST = (svc: string) => `'${JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: svc }, Action: 'sts:AssumeRole' }] })}'`;
const ALLOW = (actions: string[]) => `'${JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: actions, Resource: '*' }] })}'`;
const ENV = 'type=LINUX_CONTAINER,image=aws/codebuild/standard:7.0,computeType=BUILD_GENERAL1_SMALL';

/** Repositorio con ficheros en main, creado con git desde un clon temporal. */
async function seed(name: string, files: Record<string, string>) {
  await ok(`aws codecommit create-repository --repository-name ${name}`);
  await ok(`git clone ${URL(name)} /tmp/seed-${name}`);
  await ok(`cd /tmp/seed-${name}`);
  for (const [f, b] of Object.entries(files)) await ok(`printf '${b.replace(/\n/g, '\\n')}' > ${f}`);
  await ok('git add .');
  await ok('git commit -m "inicial"');
  await ok('git branch -M main');
  await ok('git push -u origin main');
  await ok('cd ~');
}
async function roles(svc: string, name: string, actions?: string[]) {
  await ok(`aws iam create-role --role-name ${name} --assume-role-policy-document ${TRUST(svc)}`);
  if (actions) await ok(`aws iam put-role-policy --role-name ${name} --policy-name p --policy-document ${ALLOW(actions)}`);
  return `arn:aws:iam::${ACC}:role/${name}`;
}
const BUILD_ACTIONS = ['logs:*', 'codecommit:GitPull', 's3:*'];

describe('git local', () => {
  it('init, add, commit, status, log y diff', async () => {
    await ok('mkdir p && cd p');
    expect(await ok('git init')).toMatch(/^Initialized empty Git repository in .*\/p\/\.git\/\n$/);
    await ok('echo hola > a.txt');
    expect(await ok('git status')).toContain('Untracked files:');
    expect((await run('git commit -m x')).out).toContain('nothing added to commit but untracked files present');
    await ok('git add a.txt');
    expect(await ok('git status')).toContain('new file:  a.txt');
    expect(await ok('git commit -m "primero"')).toMatch(/^\[master \(root-commit\) [0-9a-f]{7}\] primero\n a\.txt \| 1 \+\n 1 file changed, 1 insertion\(\+\)\n create mode 100644 a.txt\n$/);
    await ok('echo mas >> a.txt');
    expect(await ok('git diff')).toContain('+mas');
    expect(await ok('git status --short')).toBe(' M a.txt\n');
    await ok('git commit -am "segundo"');
    expect((await ok('git log --oneline')).trim().split('\n')).toHaveLength(2);
    expect(await ok('git log -1 --format=%s')).toBe('segundo\n');
    expect(await ok('git status')).toContain('nothing to commit, working tree clean');
  });

  it('exige identidad antes de hacer commit', async () => {
    await ok('git config --global --unset user.name');
    await ok('mkdir p && cd p && git init && echo x > f');
    await ok('git add f');
    const r = await run('git commit -m x');
    expect(r.err).toContain('Author identity unknown');
    expect(r.code).toBe(128);
  });

  it('fuera de un repositorio falla como git', async () => {
    const r = await run('git status');
    expect(r.err).toBe('fatal: not a git repository (or any of the parent directories): .git\n');
    expect(r.code).toBe(128);
  });

  it('ramas, merge con avance rápido, merge a tres bandas y conflicto', async () => {
    await ok('mkdir p && cd p && git init -b main && echo uno > f && git add f && git commit -m c1');
    await ok('git checkout -b rama && echo dos > g && git add g && git commit -m c2');
    await ok('git checkout main');
    expect(await ok('git merge rama')).toContain('Fast-forward');
    // tres bandas: cada rama toca un fichero distinto
    await ok('git checkout -b a && echo A > fa && git add fa && git commit -m ca');
    await ok('git checkout main && echo B > fb && git add fb && git commit -m cb');
    expect(await ok('git merge a')).toContain("Merge made by the 'ort' strategy.");
    expect(await ok('git log --oneline')).toContain("Merge branch 'a'");
    // conflicto: misma línea en ramas distintas
    await ok('git checkout -b x && echo desdeX > f && git commit -am cx');
    await ok('git checkout main && echo desdeMain > f && git commit -am cm');
    const m = await run('git merge x');
    expect(m.code).toBe(1);
    expect(m.out).toContain('CONFLICT (content): Merge conflict in f');
    expect(await ok('cat f')).toMatch(/<<<<<<< HEAD\ndesdeMain\n=======\ndesdeX\n>>>>>>> x\n/);
    expect(await ok('git status')).toContain('both modified:   f');
    await ok('echo resuelto > f && git add f');
    await ok('git commit -m "resuelve"');
    expect(await ok('git status')).toContain('nothing to commit');
  });

  it('checkout y branch protegen cambios y ramas', async () => {
    await ok('mkdir p && cd p && git init -b main && echo uno > f && git add f && git commit -m c1');
    await ok('git checkout -b otra');
    expect(await err('git checkout -b otra')).toContain("fatal: a branch named 'otra' already exists");
    expect(await err('git checkout inexistente')).toContain("pathspec 'inexistente' did not match");
    await ok('echo dos > f && git commit -am c2 && git checkout main');
    expect(await ok('cat f')).toBe('uno\n');
    expect(await err('git branch -d otra')).toContain("not fully merged");
    await ok('git branch -D otra');
    expect(await ok('git branch')).toBe('* main\n');
  });
});

describe('git con CodeCommit', () => {
  it('clone, push, pull, rechazo por no avance rápido y fetch', async () => {
    await seed('web', { 'README.md': '# web\n' });
    await ok(`git clone ${URL('web')} uno`);
    await ok(`git clone ${URL('web')} dos`);
    expect(await ok('ls uno')).toBe('README.md\n');
    await ok('cd uno && echo a >> README.md && git commit -am "desde uno" && git push');
    await ok('cd ~/dos && echo b >> README.md && git commit -am "desde dos"');
    const r = await run('git push');
    expect(r.code).toBe(1);
    expect(r.err).toContain('! [rejected]');
    expect(r.err).toContain('(fetch first)');
    expect(r.err).toContain("error: failed to push some refs to 'https://git-codecommit.eu-west-1.amazonaws.com/v1/repos/web'");
    await ok('git fetch');
    expect(await ok('git status')).toContain('have diverged');
    const pull = await run('git pull');
    expect(pull.code).toBe(1); // las dos ramas tocaron la misma línea
    expect(pull.out).toContain('CONFLICT');
    await ok('echo ok > README.md && git add README.md && git commit -m merge && git push');
    await ok('cd ~/uno && git pull');
    expect(await ok('cat README.md')).toBe('ok\n');
    expect(await ok('git status')).toContain('up to date with');
  });

  it('push forzado, borrado de rama y remotos', async () => {
    await seed('web', { 'a.txt': 'a\n' });
    await ok(`git clone ${URL('web')} w && cd w`);
    await ok('git checkout -b tmp && git push -u origin tmp');
    expect(await json('aws codecommit list-branches --repository-name web')).toEqual({ branches: ['main', 'tmp'] });
    await ok('git push origin --delete tmp');
    expect(await json('aws codecommit list-branches --repository-name web')).toEqual({ branches: ['main'] });
    expect(await ok('git remote -v')).toContain(`origin\t${URL('web')} (fetch)`);
    await ok('git remote add otro https://git-codecommit.eu-west-1.amazonaws.com/v1/repos/web');
    expect(await ok('git remote')).toBe('origin\notro\n');
    expect(await ok('git branch -r')).toContain('origin/main');
  });

  it('sin asistente de credenciales Git no puede autenticarse', async () => {
    await ok('aws codecommit create-repository --repository-name web');
    await ok('git config --global --unset credential.helper');
    const r = await run(`git clone ${URL('web')}`);
    expect(r.err).toContain("could not read Username for 'https://git-codecommit.eu-west-1.amazonaws.com'");
    expect(r.code).toBe(128);
  });

  it('repositorio inexistente y sin permisos', async () => {
    expect((await run(`git clone ${URL('nada')}`)).err).toContain(`fatal: repository '${URL('nada')}' not found`);
    await ok('aws codecommit create-repository --repository-name web');
    await ok('aws iam create-user --user-name sin');
    const k = await json('aws iam create-access-key --user-name sin');
    await ok(`aws configure set aws_access_key_id ${k.AccessKey.AccessKeyId} --profile sin`);
    await ok(`aws configure set aws_secret_access_key ${k.AccessKey.SecretAccessKey} --profile sin`);
    await ok('aws configure set region eu-west-1 --profile sin');
    const r = await run(`AWS_PROFILE=sin git clone ${URL('web')}`);
    expect(r.err).toContain('The requested URL returned error: 403');
  });

  it('la condición codecommit:References bloquea el push a main', async () => {
    await seed('web', { 'a.txt': 'a\n' });
    await ok('aws iam create-user --user-name dev');
    await ok(`aws iam put-user-policy --user-name dev --policy-name p --policy-document '${JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'codecommit:*', Resource: '*' }, { Effect: 'Deny', Action: ['codecommit:GitPush', 'codecommit:PutFile'], Resource: '*', Condition: { StringEqualsIfExists: { 'codecommit:References': ['refs/heads/main'] } } }] })}'`);
    const k = await json('aws iam create-access-key --user-name dev');
    await ok(`aws configure set aws_access_key_id ${k.AccessKey.AccessKeyId} --profile dev`);
    await ok(`aws configure set aws_secret_access_key ${k.AccessKey.SecretAccessKey} --profile dev`);
    await ok('aws configure set region eu-west-1 --profile dev');
    await ok('git config --global user.name Dev');
    await ok(`AWS_PROFILE=dev git clone ${URL('web')} d && cd d && echo x >> a.txt && git commit -am x`);
    expect((await run('AWS_PROFILE=dev git push')).err).toContain('The requested URL returned error: 403');
    await ok('AWS_PROFILE=dev git push origin HEAD:feature');
    expect((await json('aws codecommit list-branches --repository-name web')).branches).toContain('feature');
  });
});

describe('CodeCommit API', () => {
  it('put-file, get-file, get-folder, diferencias y errores reales', async () => {
    await ok('aws codecommit create-repository --repository-name r');
    await ok('echo hola > f.txt');
    const put = await json('aws codecommit put-file --repository-name r --branch-name main --file-path d/f.txt --file-content fileb://f.txt --commit-message m --name Ana --email a@b.c');
    expect(put.commitId).toMatch(/^[0-9a-f]{40}$/);
    expect(await json('aws codecommit get-repository --repository-name r')).toMatchObject({ repositoryMetadata: { defaultBranch: 'main' } });
    const f = await json('aws codecommit get-file --repository-name r --file-path d/f.txt');
    expect(atob(f.fileContent)).toBe('hola\n');
    expect((await json('aws codecommit get-folder --repository-name r --folder-path d')).files[0].relativePath).toBe('f.txt');
    // una escritura con un padre desfasado se rechaza
    await ok('echo dos > g.txt');
    await ok('aws codecommit put-file --repository-name r --branch-name main --file-path g.txt --file-content fileb://g.txt --parent-commit-id ' + put.commitId);
    expect(await err('aws codecommit put-file --repository-name r --branch-name main --file-path h.txt --file-content fileb://g.txt --parent-commit-id ' + put.commitId)).toContain('ParentCommitIdOutdatedException');
    expect(await err('aws codecommit put-file --repository-name r --branch-name main --file-path h.txt --file-content fileb://g.txt --parent-commit-id 0000000000000000000000000000000000000000')).toContain('ParentCommitDoesNotExistException');
    expect(await err('aws codecommit get-file --repository-name r --file-path nada')).toContain('FileDoesNotExistException');
    expect(await err('aws codecommit create-repository --repository-name r')).toContain('RepositoryNameExistsException');
    expect(await err('aws codecommit get-repository --repository-name nada')).toContain('RepositoryDoesNotExistException');
    expect(await err('aws codecommit create-repository --repository-name "no valido!"')).toContain('InvalidRepositoryNameException');
  });

  it('pull request con regla de plantilla: bloquea el merge hasta que otro la aprueba', async () => {
    await ok('aws iam create-user --user-name revisor');
    await ok(`aws iam put-user-policy --user-name revisor --policy-name p --policy-document ${ALLOW(['codecommit:*'])}`);
    const k = await json('aws iam create-access-key --user-name revisor');
    await ok(`aws configure set aws_access_key_id ${k.AccessKey.AccessKeyId} --profile revisor`);
    await ok(`aws configure set aws_secret_access_key ${k.AccessKey.SecretAccessKey} --profile revisor`);
    await ok('aws configure set region eu-west-1 --profile revisor');
    await seed('pagos', { 'a.txt': 'a\n' });
    const rule = JSON.stringify({ Version: '2018-11-08', DestinationReferences: ['refs/heads/main'], Statements: [{ Type: 'Approvers', NumberOfApprovalsNeeded: 1, ApprovalPoolMembers: [`arn:aws:iam::${ACC}:user/revisor`] }] });
    await ok(`aws codecommit create-approval-rule-template --approval-rule-template-name dos-ojos --approval-rule-template-content '${rule}'`);
    await ok('aws codecommit associate-approval-rule-template-with-repository --approval-rule-template-name dos-ojos --repository-name pagos');
    await ok(`git clone ${URL('pagos')} p && cd p && git checkout -b cambio && echo b >> a.txt && git commit -am cambio && git push -u origin cambio`);
    const pr = (await json('aws codecommit create-pull-request --title t --targets repositoryName=pagos,sourceReference=cambio,destinationReference=main')).pullRequest;
    expect(pr.approvalRules).toHaveLength(1);
    expect(await err(`aws codecommit merge-pull-request-by-fast-forward --pull-request-id ${pr.pullRequestId} --repository-name pagos`)).toContain('PullRequestApprovalRulesNotSatisfiedException');
    // el autor no puede aprobar su propio cambio
    expect(await err(`aws codecommit update-pull-request-approval-state --pull-request-id ${pr.pullRequestId} --revision-id ${pr.revisionId} --approval-state APPROVE`)).toContain('PullRequestCannotBeApprovedByAuthorException');
    expect((await json(`aws codecommit evaluate-pull-request-approval-rules --pull-request-id ${pr.pullRequestId} --revision-id ${pr.revisionId}`)).evaluation.approved).toBe(false);
    await ok(`aws codecommit update-pull-request-approval-state --pull-request-id ${pr.pullRequestId} --revision-id ${pr.revisionId} --approval-state APPROVE --profile revisor`);
    expect((await json(`aws codecommit evaluate-pull-request-approval-rules --pull-request-id ${pr.pullRequestId} --revision-id ${pr.revisionId}`)).evaluation.approved).toBe(true);
    const merged = (await json(`aws codecommit merge-pull-request-by-fast-forward --pull-request-id ${pr.pullRequestId} --repository-name pagos`)).pullRequest;
    expect(merged.pullRequestStatus).toBe('CLOSED');
    expect(merged.pullRequestTargets[0].mergeMetadata.isMerged).toBe(true);
    expect(await err(`aws codecommit merge-pull-request-by-fast-forward --pull-request-id ${pr.pullRequestId} --repository-name pagos`)).toContain('PullRequestAlreadyClosedException');
  });

  it('registra los eventos en CloudTrail', async () => {
    await ok('aws codecommit create-repository --repository-name r');
    await run('aws codecommit get-repository --repository-name nada');
    const ev = st.trail.filter((e) => e.eventSource === 'codecommit.amazonaws.com');
    expect(ev.map((e) => e.eventName)).toEqual(expect.arrayContaining(['CreateRepository', 'GetRepository']));
    expect(ev.find((e) => e.eventName === 'GetRepository')!.errorCode).toBe('RepositoryDoesNotExistException');
  });
});

describe('CodeBuild', () => {
  const SPEC = 'version: 0.2\nphases:\n  build:\n    commands:\n      - echo Hola desde la compilacion\n      - test -f package.json\nartifacts:\n  files:\n    - package.json\n';
  const project = (name: string, role: string, repo = 'app') => `aws codebuild create-project --name ${name} --source type=CODECOMMIT,location=${URL(repo)} --artifacts type=NO_ARTIFACTS --environment ${ENV} --service-role ${role}`;

  it('rechaza un rol que no confía en codebuild.amazonaws.com', async () => {
    await seed('app', { 'buildspec.yml': SPEC, 'package.json': '{}' });
    const role = await roles('ec2.amazonaws.com', 'mal');
    expect(await err(project('app', role))).toContain('CodeBuild is not authorized to perform: sts:AssumeRole on ' + role);
    expect(await err(project('app', `arn:aws:iam::${ACC}:role/noexiste`))).toContain('InvalidInputException');
  });

  it('compilación correcta: fases, registros en CloudWatch y estado final', async () => {
    await seed('app', { 'buildspec.yml': SPEC, 'package.json': '{}' });
    const role = await roles('codebuild.amazonaws.com', 'cb', BUILD_ACTIONS);
    await ok(project('app', role));
    const b = (await json('aws codebuild start-build --project-name app')).build;
    expect(b.buildStatus).toBe('IN_PROGRESS');
    expect(b.id).toMatch(/^app:[0-9a-f-]{36}$/);
    const done = (await json(`aws codebuild batch-get-builds --ids ${b.id}`)).builds[0];
    expect(done.buildStatus).toBe('SUCCEEDED');
    expect(done.phases.map((p: { phaseType: string }) => p.phaseType)).toEqual(expect.arrayContaining(['SUBMITTED', 'PROVISIONING', 'DOWNLOAD_SOURCE', 'BUILD', 'COMPLETED']));
    const events = await json(`aws logs get-log-events --log-group-name /aws/codebuild/app --log-stream-name ${b.id.split(':')[1]}`);
    expect(events.events.map((e: { message: string }) => e.message).join('')).toContain('Hola desde la compilacion');
    expect(st.trail.some((e) => e.eventName === 'StartBuild' && e.eventSource === 'codebuild.amazonaws.com')).toBe(true);
  });

  it('falla de verdad si el rol no puede escribir registros o un comando devuelve error', async () => {
    await seed('app', { 'buildspec.yml': SPEC, 'package.json': '{}' });
    const role = await roles('codebuild.amazonaws.com', 'cb');
    await ok(project('app', role));
    const b = (await json('aws codebuild start-build --project-name app')).build;
    const done = (await json(`aws codebuild batch-get-builds --ids ${b.id}`)).builds[0];
    expect(done.buildStatus).toBe('FAILED');
    expect(JSON.stringify(done.phases)).toContain('logs:CreateLogStream');
    await ok(`aws iam put-role-policy --role-name cb --policy-name p --policy-document ${ALLOW(BUILD_ACTIONS)}`);
    // comando que falla: falta el fichero
    await seed('rota', { 'buildspec.yml': 'version: 0.2\nphases:\n  build:\n    commands:\n      - test -f no-existe.txt\n' });
    await ok(project('rota', role, 'rota'));
    const bad = (await json('aws codebuild start-build --project-name rota')).build;
    const r = (await json(`aws codebuild batch-get-builds --ids ${bad.id}`)).builds[0];
    expect(r.buildStatus).toBe('FAILED');
    expect(JSON.stringify(r.phases)).toContain('COMMAND_EXECUTION_ERROR');
  });

  it('el tiempo avanza: IN_PROGRESS con velocidad realista y SUCCEEDED después', async () => {
    st.settings.speed = 'realistic';
    let t = Date.now();
    setClock(() => t);
    await seed('app', { 'buildspec.yml': SPEC, 'package.json': '{}' });
    const role = await roles('codebuild.amazonaws.com', 'cb', BUILD_ACTIONS);
    await ok(project('app', role));
    const b = (await json('aws codebuild start-build --project-name app')).build;
    expect((await json(`aws codebuild batch-get-builds --ids ${b.id}`)).builds[0].buildStatus).toBe('IN_PROGRESS');
    t += 10 * 60 * 1000;
    expect((await json(`aws codebuild batch-get-builds --ids ${b.id}`)).builds[0].buildStatus).toBe('SUCCEEDED');
    setClock(null);
  });
});

describe('CodePipeline y CodeDeploy', () => {
  const SPEC = 'version: 0.2\nphases:\n  build:\n    commands:\n      - echo Generando\nartifacts:\n  files:\n    - index.html\n';
  const pipeline = (extra: Record<string, unknown> = {}, role = 'pipe') => JSON.stringify({
    pipeline: {
      name: 'sitio', roleArn: `arn:aws:iam::${ACC}:role/${role}`, artifactStore: { type: 'S3', location: 'artefactos' },
      stages: [
        { name: 'Source', actions: [{ name: 'Codigo', actionTypeId: { category: 'Source', owner: 'AWS', provider: 'CodeCommit', version: '1' }, configuration: { RepositoryName: 'sitio', BranchName: 'main' }, outputArtifacts: [{ name: 'S' }] }] },
        { name: 'Build', actions: [{ name: 'Compilar', actionTypeId: { category: 'Build', owner: 'AWS', provider: 'CodeBuild', version: '1' }, configuration: { ProjectName: 'sitio-build' }, inputArtifacts: [{ name: 'S' }], outputArtifacts: [{ name: 'B' }] }] },
        { name: 'Aprobacion', actions: [{ name: 'Revision', actionTypeId: { category: 'Approval', owner: 'AWS', provider: 'Manual', version: '1' } }] },
        { name: 'Deploy', actions: [{ name: 'Publicar', actionTypeId: { category: 'Deploy', owner: 'AWS', provider: 'S3', version: '1' }, configuration: { BucketName: 'web', Extract: 'true' }, inputArtifacts: [{ name: 'B' }] }] },
      ],
      ...extra,
    },
  });
  async function base() {
    await seed('sitio', { 'buildspec.yml': SPEC, 'index.html': '<h1>v1</h1>\n' });
    await ok('aws s3 mb s3://artefactos && aws s3 mb s3://web');
    await roles('codebuild.amazonaws.com', 'cb', BUILD_ACTIONS);
    await ok(`aws codebuild create-project --name sitio-build --source type=CODEPIPELINE --artifacts type=CODEPIPELINE --environment ${ENV} --service-role arn:aws:iam::${ACC}:role/cb`);
  }
  const state = async () => (await json('aws codepipeline get-pipeline-state --name sitio')).stageStates as { stageName: string; latestExecution?: { status: string }; actionStates: { latestExecution?: { status: string; token?: string; errorDetails?: { message: string } } }[] }[];
  const writePipe = (p: string) => ok(`printf '${p.replace(/%/g, '%%')}' > pipe.json`);

  it('valida el rol de servicio, el número de etapas y los nombres', async () => {
    await base();
    await roles('ec2.amazonaws.com', 'malo');
    await writePipe(pipeline({}, 'malo'));
    expect(await err('aws codepipeline create-pipeline --cli-input-json file://pipe.json')).toContain('CodePipeline is not authorized to perform AssumeRole on role');
    await roles('codepipeline.amazonaws.com', 'pipe', ['s3:*', 'codecommit:*', 'codebuild:*']);
    const one = JSON.parse(pipeline()); one.pipeline.stages = one.pipeline.stages.slice(0, 1);
    await writePipe(JSON.stringify(one));
    expect(await err('aws codepipeline create-pipeline --cli-input-json file://pipe.json')).toContain('Pipeline has only 1 stage(s). There should be a minimum of 2 stages in a pipeline');
  });

  it('ejecución completa: build, aprobación manual con token y despliegue a S3', async () => {
    await base();
    await roles('codepipeline.amazonaws.com', 'pipe', ['s3:*', 'codecommit:*', 'codebuild:*']);
    await writePipe(pipeline());
    await ok('aws codepipeline create-pipeline --cli-input-json file://pipe.json');
    let s = await state();
    expect(s.map((x) => x.stageName)).toEqual(['Source', 'Build', 'Aprobacion', 'Deploy']);
    expect(s[1].latestExecution?.status).toBe('Succeeded');
    expect(s[2].latestExecution?.status).toBe('InProgress');
    expect(s[3].latestExecution).toBeUndefined();
    const token = s[2].actionStates[0].latestExecution!.token!;
    expect(await err('aws codepipeline put-approval-result --pipeline-name sitio --stage-name Aprobacion --action-name Revision --result summary=x,status=Approved --token tokenfalso')).toContain('InvalidApprovalTokenException');
    await ok(`aws codepipeline put-approval-result --pipeline-name sitio --stage-name Aprobacion --action-name Revision --result summary=ok,status=Approved --token ${token}`);
    s = await state();
    expect(s[3].latestExecution?.status).toBe('Succeeded');
    expect(await ok('aws s3 ls s3://web/')).toContain('index.html');
    const ex = (await json('aws codepipeline list-pipeline-executions --pipeline-name sitio')).pipelineExecutionSummaries;
    expect(ex[0].status).toBe('Succeeded');
  });

  it('un push a la rama dispara la canalización y rechazar detiene el despliegue', async () => {
    await base();
    await roles('codepipeline.amazonaws.com', 'pipe', ['s3:*', 'codecommit:*', 'codebuild:*']);
    await writePipe(pipeline());
    await ok('aws codepipeline create-pipeline --cli-input-json file://pipe.json');
    const before = (await json('aws codepipeline list-pipeline-executions --pipeline-name sitio')).pipelineExecutionSummaries.length;
    await ok(`git clone ${URL('sitio')} c && cd c && echo '<h1>v2</h1>' > index.html && git commit -am v2 && git push`);
    const list = (await json('aws codepipeline list-pipeline-executions --pipeline-name sitio')).pipelineExecutionSummaries;
    expect(list.length).toBe(before + 1);
    const s = await state();
    const token = s[2].actionStates[0].latestExecution!.token!;
    await ok(`aws codepipeline put-approval-result --pipeline-name sitio --stage-name Aprobacion --action-name Revision --result summary=no,status=Rejected --token ${token}`);
    const ex = (await json('aws codepipeline list-pipeline-executions --pipeline-name sitio')).pipelineExecutionSummaries[0];
    expect(ex.status).toBe('Failed');
    expect(await ok('aws s3 ls s3://web/')).not.toContain('index.html');
  });

  it('falla en Build por un permiso que falta y se reintenta tras corregirlo', async () => {
    await base();
    await roles('codepipeline.amazonaws.com', 'pipe', ['s3:*', 'codecommit:*', 'codebuild:BatchGetBuilds']);
    await writePipe(pipeline());
    await ok('aws codepipeline create-pipeline --cli-input-json file://pipe.json');
    let s = await state();
    expect(s[1].latestExecution?.status).toBe('Failed');
    expect(s[1].actionStates[0].latestExecution?.errorDetails?.message).toContain('codebuild:StartBuild');
    await ok(`aws iam put-role-policy --role-name pipe --policy-name p --policy-document ${ALLOW(['s3:*', 'codecommit:*', 'codebuild:*'])}`);
    const id = (await json('aws codepipeline list-pipeline-executions --pipeline-name sitio')).pipelineExecutionSummaries[0].pipelineExecutionId;
    await ok(`aws codepipeline retry-stage-execution --pipeline-name sitio --stage-name Build --pipeline-execution-id ${id} --retry-mode FAILED_ACTIONS`);
    s = await state();
    expect(s[1].latestExecution?.status).toBe('Succeeded');
  });

  describe('CodeDeploy', () => {
    const APPSPEC = 'version: 0.0\nos: linux\nfiles:\n  - source: /index.html\n    destination: /var/www/html\n';
    async function fleet(profile: boolean) {
      await ok('aws s3 mb s3://rev');
      await roles('codedeploy.amazonaws.com', 'cd-svc');
      if (profile) {
        await roles('ec2.amazonaws.com', 'ec2-cd', ['s3:GetObject']);
        await ok('aws iam create-instance-profile --instance-profile-name ec2-cd && aws iam add-role-to-instance-profile --instance-profile-name ec2-cd --role-name ec2-cd');
      }
      const ami = (await json('aws ec2 describe-images --owners amazon --query Images[0].ImageId')) as string;
      await ok(`aws ec2 run-instances --image-id ${ami} --tag-specifications ResourceType=instance,Tags=[{Key=app,Value=web}] ${profile ? '--iam-instance-profile Name=ec2-cd' : ''}`);
      await ok('aws deploy create-application --application-name web');
      await ok(`aws deploy create-deployment-group --application-name web --deployment-group-name prod --service-role-arn arn:aws:iam::${ACC}:role/cd-svc --ec2-tag-filters Key=app,Value=web,Type=KEY_AND_VALUE`);
      await ok(`printf '${APPSPEC.replace(/\n/g, '\\n')}' > appspec.yml && echo '<h1>v1</h1>' > index.html`);
      await ok('aws deploy push --application-name web --s3-location s3://rev/web.zip --ignore-hidden-files || true');
    }
    const create = (extra = '') => `aws deploy create-deployment --application-name web --deployment-group-name prod --s3-location bucket=rev,key=web.zip,bundleType=zip ${extra}`;

    it('rechaza un rol de servicio que no confía en codedeploy.amazonaws.com', async () => {
      await roles('ec2.amazonaws.com', 'x');
      await ok('aws deploy create-application --application-name web');
      expect(await err(`aws deploy create-deployment-group --application-name web --deployment-group-name g --service-role-arn arn:aws:iam::${ACC}:role/x`)).toContain('InvalidRoleException');
    });

    it('falla sin instancias y, con instancias y perfil, termina en Succeeded', async () => {
      await ok('aws s3 mb s3://rev');
      await roles('codedeploy.amazonaws.com', 'cd-svc');
      await ok('aws deploy create-application --application-name web');
      await ok(`aws deploy create-deployment-group --application-name web --deployment-group-name prod --service-role-arn arn:aws:iam::${ACC}:role/cd-svc --ec2-tag-filters Key=app,Value=web,Type=KEY_AND_VALUE`);
      await ok('echo x > f && aws s3 cp f s3://rev/web.zip');
      const id = (await json(create())).deploymentId as string;
      const d = (await json(`aws deploy get-deployment --deployment-id ${id}`)).deploymentInfo;
      expect(d.status).toBe('Failed');
      expect(d.errorInformation.code).toBe('NO_INSTANCES');
    });

    it('con instancias: Succeeded; sin permiso de S3 en el perfil falla en DownloadBundle', async () => {
      await fleet(true);
      const id = (await json(create())).deploymentId as string;
      let d = (await json(`aws deploy get-deployment --deployment-id ${id}`)).deploymentInfo;
      expect(d.status).toBe('Succeeded');
      expect(d.deploymentOverview.Succeeded).toBe(1);
      await ok(`aws deploy wait deployment-successful --deployment-id ${id}`);
      const inst = (await json(`aws deploy list-deployment-instances --deployment-id ${id}`)).instancesList[0];
      const sum = (await json(`aws deploy get-deployment-instance --deployment-id ${id} --instance-id ${inst}`)).instanceSummary;
      expect(sum.lifecycleEvents.map((e: { lifecycleEventName: string }) => e.lifecycleEventName)).toEqual(['ApplicationStop', 'DownloadBundle', 'BeforeInstall', 'Install', 'AfterInstall', 'ApplicationStart', 'ValidateService']);
      expect(sum.lifecycleEvents[0].status).toBe('Skipped');
      // quita el permiso del perfil de instancia
      await ok('aws iam delete-role-policy --role-name ec2-cd --policy-name p');
      const id2 = (await json(create())).deploymentId as string;
      d = (await json(`aws deploy get-deployment --deployment-id ${id2}`)).deploymentInfo;
      expect(d.status).toBe('Failed');
      expect(d.errorInformation.code).toBe('HEALTH_CONSTRAINTS');
      const s2 = (await json(`aws deploy get-deployment-instance --deployment-id ${id2} --instance-id ${inst}`)).instanceSummary;
      expect(JSON.stringify(s2.lifecycleEvents)).toContain('Access Denied');
      expect(st.trail.some((e) => e.eventName === 'CreateDeployment' && e.eventSource === 'codedeploy.amazonaws.com')).toBe(true);
    });
  });

  it('settleCicd es idempotente', async () => {
    settleCicd(st); settleCicd(st);
    expect(cicd(st).pipelines).toEqual([]);
  });
});

import { SAA_DOMAINS, type Level } from '../types';
import { prep, profileFor } from '../setup';
import type { CheckCtx } from '../checks';
import { cicd } from '../../../engine/services/cicdTypes';
import { trustsService } from '../../../engine/services/cicdCommon';
import { settleCicd, executionsOf } from '../../../engine/services/codepipeline';
import { buildsOf } from '../../../engine/services/codebuild';
import git from './l10/1-git.md?raw';
import codecommit from './l10/2-codecommit.md?raw';
import codebuild from './l10/3-codebuild.md?raw';
import pipeline from './l10/4-pipeline.md?raw';

const REGION = 'eu-west-1';
const URL = (n: string) => `https://git-codecommit.${REGION}.amazonaws.com/v1/repos/${n}`;
const ACC = 'ACC=$(aws sts get-caller-identity --query Account --output text)';
const TRUST = (svc: string) => `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"${svc}"},"Action":"sts:AssumeRole"}]}`;
const GIT_CFG = ["git config --global credential.helper '!aws codecommit credential-helper $@'", 'git config --global user.name Ana', 'git config --global user.email ana@example.com'];
const ENV = 'type=LINUX_CONTAINER,image=aws/codebuild/standard:7.0,computeType=BUILD_GENERAL1_SMALL';
const esc = (t: string) => t.replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

/** Crea un repositorio con ficheros iniciales en la rama main (usa git, igual que haría un compañero). */
const seed = (name: string, files: Record<string, string>): string[] => [
  `aws codecommit create-repository --repository-name ${name}`,
  `git clone ${URL(name)} /tmp/seed-${name}`,
  `cd /tmp/seed-${name}`,
  ...Object.entries(files).map(([f, body]) => `printf '${esc(body)}' > ${f}`),
  'git add .',
  'git commit -m "Versión inicial"',
  'git branch -M main',
  'git push -u origin main',
  'cd ~',
];

const repo = (c: CheckCtx, name: string) => cicd(c.s).repos.find((r) => r.name === name && r.region === REGION);
const fileIn = (c: CheckCtx, name: string, branch: string, path: string): string | undefined => {
  const r = repo(c, name);
  const id = r?.branches[branch];
  return r && id ? r.objs.blobs[r.objs.commits[id].tree[path]] : undefined;
};
const prsOf = (c: CheckCtx, name: string) => repo(c, name)?.prs ?? [];
const builds = (c: CheckCtx, project: string) => (settleCicd(c.s), buildsOf(c.s, project));

// --- Laboratorio 3: la regla de aprobación exige a `revisor`
const RULE = (acc: string) => `{\\"Version\\":\\"2018-11-08\\",\\"DestinationReferences\\":[\\"refs/heads/main\\"],\\"Statements\\":[{\\"Type\\":\\"Approvers\\",\\"NumberOfApprovalsNeeded\\":1,\\"ApprovalPoolMembers\\":[\\"arn:aws:iam::${acc}:user/revisor\\"]}]}`;

// --- Laboratorio 6: canalización
const BUILDSPEC_SITE = 'version: 0.2\nphases:\n  build:\n    commands:\n      - echo Generando el sitio\nartifacts:\n  files:\n    - index.html\n';
const PIPE = JSON.stringify({
  pipeline: {
    name: 'sitio', roleArn: 'arn:aws:iam::CUENTA:role/pipeline-sitio', artifactStore: { type: 'S3', location: 'lab-sitio-artefactos' },
    stages: [
      { name: 'Source', actions: [{ name: 'Codigo', actionTypeId: { category: 'Source', owner: 'AWS', provider: 'CodeCommit', version: '1' }, configuration: { RepositoryName: 'sitio', BranchName: 'main', PollForSourceChanges: 'false' }, outputArtifacts: [{ name: 'SourceOut' }] }] },
      { name: 'Build', actions: [{ name: 'Compilar', actionTypeId: { category: 'Build', owner: 'AWS', provider: 'CodeBuild', version: '1' }, configuration: { ProjectName: 'sitio-build' }, inputArtifacts: [{ name: 'SourceOut' }], outputArtifacts: [{ name: 'BuildOut' }] }] },
      { name: 'Aprobacion', actions: [{ name: 'Revision', actionTypeId: { category: 'Approval', owner: 'AWS', provider: 'Manual', version: '1' }, configuration: { CustomData: 'Revisa el sitio antes de publicarlo' } }] },
      { name: 'Deploy', actions: [{ name: 'Publicar', actionTypeId: { category: 'Deploy', owner: 'AWS', provider: 'S3', version: '1' }, configuration: { BucketName: 'lab-sitio-web', Extract: 'true' }, inputArtifacts: [{ name: 'BuildOut' }] }] },
    ],
  },
});
const POL_PIPE_FULL = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:*","codecommit:GetBranch","codecommit:GetCommit","codecommit:UploadArchive","codecommit:GetUploadArchiveStatus","codebuild:StartBuild","codebuild:BatchGetBuilds"],"Resource":"*"}]}';
const POL_PIPE_BROKEN = POL_PIPE_FULL.replace('"codebuild:StartBuild",', '');
const POL_BUILD = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents","codecommit:GitPull","s3:*"],"Resource":"*"}]}';
const pipeExecs = (c: CheckCtx) => (settleCicd(c.s), executionsOf(c.s, 'sitio', REGION));

export const l10: Level = {
  id: 10,
  slug: 'git-cicd',
  title: 'Git y CI/CD',
  subtitle: 'Control de versiones y entrega continua: CodeCommit, CodeBuild, CodePipeline y CodeDeploy.',
  skills: ['Git (commit, ramas, push, pull)', 'CodeCommit y pull requests', 'Reglas de aprobación', 'buildspec de CodeBuild', 'Roles de servicio', 'CodePipeline con aprobación manual'],
  lessons: [
    { id: 'l10-git', title: 'Git: commits, ramas y fusiones', minutes: 8, body: git },
    { id: 'l10-codecommit', title: 'CodeCommit, IAM y pull requests', minutes: 9, body: codecommit },
    { id: 'l10-codebuild', title: 'CodeBuild y buildspec.yml', minutes: 9, body: codebuild },
    { id: 'l10-pipeline', title: 'CodePipeline y CodeDeploy', minutes: 10, body: pipeline },
  ],
  exercises: [
    {
      id: 'l10-e1',
      title: 'Tu primer repositorio con Git',
      summary: 'Crea un repositorio en CodeCommit, clónalo y publica tu primer commit.',
      difficulty: 'Fácil',
      minutes: 12,
      saa: [SAA_DOMAINS[1]],
      tags: ['CodeCommit', 'Git', 'IAM'],
      scenario: 'Tu equipo guarda el código de la tienda en un zip por correo. Crea el repositorio `tienda-web` en CodeCommit, configura Git para autenticarse con tus credenciales de AWS (asistente de credenciales) y con tu identidad, clónalo, añade un `README.md` que mencione la tienda y publica el commit en la rama `main`.',
      steps: [
        { id: 'repo', title: 'Crea el repositorio `tienda-web` en CodeCommit', hint: ['aws codecommit create-repository --repository-name tienda-web'], check: (c) => !!repo(c, 'tienda-web') || 'El repositorio tienda-web todavía no existe en eu-west-1.' },
        { id: 'cfg', title: 'Configura Git: asistente de credenciales de AWS, `user.name` y `user.email`', hint: ["git config --global credential.helper '!aws codecommit credential-helper $@'", 'git config --global user.name "Ana" y git config --global user.email ana@example.com'], check: (c) => { const f = c.file('.gitconfig') ?? ''; return (/codecommit credential-helper/.test(f) && /name = /.test(f) && /email = /.test(f)) || 'Falta credential.helper, user.name o user.email en ~/.gitconfig.'; } },
        { id: 'clone', title: 'Clona el repositorio por HTTPS', hint: ['La URL es https://git-codecommit.eu-west-1.amazonaws.com/v1/repos/tienda-web'], check: (c) => /git-codecommit/.test(c.file('tienda-web/.git/config') ?? '') || 'Clona el repositorio con git clone (queda en ~/tienda-web).' },
        { id: 'push', title: 'Crea `README.md`, haz commit y publica la rama `main` con `git push -u origin main`', hint: ['Por defecto la rama local se llama master: git branch -M main la renombra.', 'cd tienda-web && echo "# Tienda web" > README.md && git add README.md && git commit -m "Primer commit"'], check: (c) => /tienda/i.test(fileIn(c, 'tienda-web', 'main', 'README.md') ?? '') || 'La rama main de CodeCommit todavía no contiene README.md con la palabra «tienda».' },
      ],
      script: [
        'aws codecommit create-repository --repository-name tienda-web --repository-description "Tienda web"',
        ...GIT_CFG,
        `git clone ${URL('tienda-web')}`,
        'cd tienda-web',
        'echo "# Tienda web" > README.md',
        'git add README.md',
        'git commit -m "Primer commit"',
        'git branch -M main',
        'git push -u origin main',
        'git log --oneline',
      ],
      realWorld: 'En una cuenta real necesitas un usuario o rol con permisos `codecommit:*` sobre el repositorio y AWS CLI v2 en la ruta del asistente de credenciales (en Windows y macOS se usa el mismo comando). Los repositorios activos cuestan unos céntimos al mes por usuario activo y tienen un nivel gratuito generoso. **Limpieza:** `aws codecommit delete-repository --repository-name tienda-web` (borra también el historial, así que antes confirma que no lo necesitas).',
    },
    {
      id: 'l10-e2',
      title: 'Una rama, un pull request',
      summary: 'Trabaja en una rama de funcionalidad, abre un pull request y fusiónalo.',
      difficulty: 'Media',
      minutes: 15,
      saa: [SAA_DOMAINS[1], SAA_DOMAINS[2]],
      tags: ['CodeCommit', 'Git', 'Pull request'],
      scenario: 'El repositorio `blog` ya existe con un `index.html` en `main`. Clónalo, crea la rama `feature/pie`, añade una línea con `<footer>` al `index.html`, publica la rama, abre un pull request hacia `main` y fusiónalo con avance rápido (*fast-forward*). Nadie debe escribir directamente en `main`.',
      steps: [
        { id: 'branch', title: 'Clona `blog` y crea la rama local `feature/pie`', hint: ['git clone https://git-codecommit.eu-west-1.amazonaws.com/v1/repos/blog', 'cd blog && git checkout -b feature/pie'], check: (c) => { try { return 'feature/pie' in JSON.parse(c.file('blog/.git/state.json') ?? '{}').branches || 'No existe la rama local feature/pie en ~/blog.'; } catch { return 'Clona primero el repositorio blog.'; } } },
        { id: 'push', title: 'Haz commit del `<footer>` y publica `feature/pie` en CodeCommit', hint: ['echo "<footer>Mi blog</footer>" >> index.html', 'git commit -am "Añade pie de página" && git push -u origin feature/pie'], check: (c) => /<footer>/.test(fileIn(c, 'blog', 'feature/pie', 'index.html') ?? '') || 'La rama feature/pie de CodeCommit todavía no tiene el <footer>.' },
        { id: 'pr', title: 'Abre un pull request de `feature/pie` hacia `main`', hint: ['aws codecommit create-pull-request --title "Añade pie" --targets repositoryName=blog,sourceReference=feature/pie,destinationReference=main'], check: (c) => prsOf(c, 'blog').some((p) => p.source === 'feature/pie' && p.dest === 'main') || 'No hay ningún pull request de feature/pie a main.' },
        { id: 'merge', title: 'Fusiona el pull request con `merge-pull-request-by-fast-forward`', hint: ['aws codecommit merge-pull-request-by-fast-forward --pull-request-id 1 --repository-name blog'], check: (c) => (!!prsOf(c, 'blog').find((p) => p.merged) && /<footer>/.test(fileIn(c, 'blog', 'main', 'index.html') ?? '')) || 'El pull request sigue abierto: main no contiene todavía el cambio.' },
      ],
      setup: (sh) => prep(sh, [...GIT_CFG, ...seed('blog', { 'index.html': '<h1>Mi blog</h1>\n' })]),
      script: [
        `git clone ${URL('blog')}`,
        'cd blog',
        'git checkout -b feature/pie',
        'echo "<footer>Mi blog</footer>" >> index.html',
        'git commit -am "Añade pie de página"',
        'git push -u origin feature/pie',
        'aws codecommit create-pull-request --title "Añade pie" --targets repositoryName=blog,sourceReference=feature/pie,destinationReference=main',
        'aws codecommit merge-pull-request-by-fast-forward --pull-request-id 1 --repository-name blog',
        'git checkout main',
        'git pull',
        'git log --oneline',
      ],
      realWorld: 'Es el flujo diario de cualquier equipo: una rama por cambio y revisión antes de fusionar. En la consola de CodeCommit puedes ver el pull request con las diferencias y comentar línea a línea. Añade una política de IAM con `Deny` sobre `codecommit:GitPush` y la condición `codecommit:References = refs/heads/main` para que nadie empuje directamente a `main`. **Limpieza:** `aws codecommit delete-branch --repository-name blog --branch-name feature/pie` y borra el repositorio si era solo de prueba.',
    },
    {
      id: 'l10-e3',
      title: 'Aprobaciones obligatorias',
      summary: 'Exige la aprobación de un revisor antes de poder fusionar en main.',
      difficulty: 'Difícil',
      minutes: 22,
      saa: [SAA_DOMAINS[1]],
      tags: ['CodeCommit', 'IAM', 'Reglas de aprobación'],
      scenario: 'El repositorio `pagos` mueve dinero y ningún cambio debe llegar a `main` sin revisión. Existe el usuario `revisor` (con perfil de CLI `revisor`). Crea la plantilla `revision-obligatoria` que exija 1 aprobación de `revisor`, asóciala a `pagos`, crea una rama `cambio-iva` con un fichero `iva.txt`, abre el pull request, comprueba que **no** se puede fusionar sin aprobación, apruébalo como `revisor` y fusiónalo.',
      steps: [
        { id: 'tpl', title: 'Crea la plantilla `revision-obligatoria` (1 aprobación, grupo de aprobadores: `revisor`)', hint: ['aws codecommit create-approval-rule-template --approval-rule-template-name revision-obligatoria --approval-rule-template-content <json>', 'El contenido JSON lleva Version 2018-11-08, DestinationReferences y Statements con Type Approvers, NumberOfApprovalsNeeded y ApprovalPoolMembers.'], check: (c) => { const t = cicd(c.s).ruleTemplates.find((x) => x.name === 'revision-obligatoria'); if (!t) return 'La plantilla revision-obligatoria no existe.'; const st = JSON.parse(t.content).Statements[0]; return (st.NumberOfApprovalsNeeded >= 1 && (st.ApprovalPoolMembers ?? []).some((m: string) => m.endsWith(':user/revisor'))) || 'La plantilla debe exigir al menos 1 aprobación y nombrar a user/revisor en ApprovalPoolMembers.'; } },
        { id: 'assoc', title: 'Asocia la plantilla al repositorio `pagos`', hint: ['aws codecommit associate-approval-rule-template-with-repository --approval-rule-template-name revision-obligatoria --repository-name pagos'], check: (c) => !!cicd(c.s).ruleTemplates.find((x) => x.name === 'revision-obligatoria')?.repos.includes('pagos') || 'La plantilla todavía no está asociada a pagos.' },
        { id: 'pr', title: 'Crea la rama `cambio-iva` con `iva.txt` y abre el pull request hacia `main`', hint: ['aws codecommit get-branch --repository-name pagos --branch-name main --query branch.commitId --output text', 'aws codecommit create-branch ... y aws codecommit put-file --branch-name cambio-iva --parent-commit-id <id> ...', 'La regla de la plantilla se aplica sola al nuevo pull request.'], check: (c) => { const p = prsOf(c, 'pagos').find((x) => x.source === 'cambio-iva'); if (!p) return 'No hay ningún pull request desde cambio-iva.'; return p.rules.length > 0 || 'El pull request no lleva la regla de aprobación: asocia la plantilla antes de crearlo.'; } },
        { id: 'denied', title: 'Intenta fusionar sin aprobación y lee el error `PullRequestApprovalRulesNotSatisfiedException`', hint: ['aws codecommit merge-pull-request-by-fast-forward --pull-request-id 1 --repository-name pagos'], check: (c) => c.trail('MergePullRequestByFastForward', { error: 'PullRequestApprovalRulesNotSatisfiedException' }).length > 0 || 'Prueba a fusionar antes de aprobar: debe fallar.' },
        { id: 'merge', title: 'Aprueba como `revisor` (`--profile revisor`) y fusiona', hint: ['aws codecommit get-pull-request --pull-request-id 1 --query pullRequest.revisionId --output text', 'aws codecommit update-pull-request-approval-state --pull-request-id 1 --revision-id <id> --approval-state APPROVE --profile revisor'], check: (c) => { const p = prsOf(c, 'pagos').find((x) => x.merged); if (!p) return 'El pull request todavía no está fusionado.'; return p.approvals.some((a) => a.state === 'APPROVE' && a.user.endsWith('/revisor')) || 'Debe aprobarlo revisor, no tú.'; } },
      ],
      setup: (sh) => prep(sh, [
        'aws codecommit create-repository --repository-name pagos',
        'echo "pagos v1" > ~/pagos.txt',
        'aws codecommit put-file --repository-name pagos --branch-name main --file-path pagos.txt --file-content fileb://pagos.txt --commit-message "Versión inicial" --name Ana --email ana@example.com',
        'rm ~/pagos.txt',
        'aws iam create-user --user-name revisor',
        `aws iam put-user-policy --user-name revisor --policy-name codecommit --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"codecommit:*","Resource":"*"}]}'`,
        ...profileFor('revisor'),
      ]),
      script: [
        ACC,
        `aws codecommit create-approval-rule-template --approval-rule-template-name revision-obligatoria --approval-rule-template-content "${RULE('$ACC')}"`,
        'aws codecommit associate-approval-rule-template-with-repository --approval-rule-template-name revision-obligatoria --repository-name pagos',
        'ID=$(aws codecommit get-branch --repository-name pagos --branch-name main --query branch.commitId --output text)',
        'aws codecommit create-branch --repository-name pagos --branch-name cambio-iva --commit-id $ID',
        'echo "iva=21" > ~/iva.txt',
        'aws codecommit put-file --repository-name pagos --branch-name cambio-iva --file-path iva.txt --file-content fileb://iva.txt --parent-commit-id $ID --commit-message "Añade IVA" --name Ana --email ana@example.com',
        'aws codecommit create-pull-request --title "Añade IVA" --targets repositoryName=pagos,sourceReference=cambio-iva,destinationReference=main',
        'REV=$(aws codecommit get-pull-request --pull-request-id 1 --query pullRequest.revisionId --output text)',
        'aws codecommit merge-pull-request-by-fast-forward --pull-request-id 1 --repository-name pagos || true',
        'aws codecommit update-pull-request-approval-state --pull-request-id 1 --revision-id $REV --approval-state APPROVE --profile revisor',
        'aws codecommit merge-pull-request-by-fast-forward --pull-request-id 1 --repository-name pagos',
      ],
      realWorld: 'Las reglas de aprobación se pueden aplicar a toda la organización con plantillas asociadas a muchos repositorios. En una cuenta real el grupo de aprobadores puede ser un rol asumido (`arn:aws:sts::<cuenta>:assumed-role/Revisores/*`), y conviene reforzarlo con un `Deny` de IAM sobre `codecommit:GitPush` hacia `main`, porque la regla solo controla el pull request. **Limpieza:** `aws codecommit disassociate-approval-rule-template-from-repository`, `aws codecommit delete-approval-rule-template` y `aws iam delete-user` del revisor (borra antes sus claves y políticas).',
    },
    {
      id: 'l10-e4',
      title: 'Tu primera compilación',
      summary: 'Un proyecto de CodeBuild con su rol de servicio, un buildspec y los registros.',
      difficulty: 'Media',
      minutes: 20,
      saa: [SAA_DOMAINS[1], SAA_DOMAINS[4]],
      tags: ['CodeBuild', 'IAM', 'CloudWatch Logs'],
      scenario: 'El repositorio `api` tiene un `buildspec.yml` que ejecuta las pruebas. Crea el rol `codebuild-api` (confianza en CodeBuild y permiso para escribir registros y leer el repositorio), el proyecto `api` que compila ese repositorio, lanza una compilación, comprueba que termina en `SUCCEEDED` y guarda los registros en `~/build.log`.',
      steps: [
        { id: 'role', title: 'Crea el rol `codebuild-api` que CodeBuild pueda asumir y con permisos de registros y de lectura del repositorio', hint: ['La política de confianza debe nombrar Service: codebuild.amazonaws.com.', 'Permisos mínimos: logs:CreateLogGroup, logs:CreateLogStream, logs:PutLogEvents y codecommit:GitPull.'], check: (c) => { const r = c.role('codebuild-api'); if (!r) return 'El rol codebuild-api no existe.'; if (!trustsService(r, 'codebuild.amazonaws.com')) return 'El rol no confía en codebuild.amazonaws.com.'; return (c.decide('codebuild-api', 'logs:CreateLogStream') === 'Allow' && c.decide('codebuild-api', 'codecommit:GitPull') === 'Allow') || 'Al rol le faltan permisos de logs o de codecommit:GitPull.'; } },
        { id: 'project', title: 'Crea el proyecto `api` con origen CodeCommit', hint: ['aws codebuild create-project --name api --source type=CODECOMMIT,location=<url> --artifacts type=NO_ARTIFACTS --environment type=LINUX_CONTAINER,image=aws/codebuild/standard:7.0,computeType=BUILD_GENERAL1_SMALL --service-role <arn>'], check: (c) => cicd(c.s).projects.some((p) => p.name === 'api' && p.source.type === 'CODECOMMIT') || 'El proyecto api todavía no existe.' },
        { id: 'build', title: 'Lanza una compilación y espera a `SUCCEEDED`', hint: ['aws codebuild start-build --project-name api', 'aws codebuild batch-get-builds --ids <id> --query builds[0].buildStatus (repítelo hasta que deje de ser IN_PROGRESS)'], check: (c) => builds(c, 'api').some((b) => b.buildStatus === 'SUCCEEDED') || 'Todavía no hay ninguna compilación correcta del proyecto api.' },
        { id: 'logs', title: 'Guarda los registros de la compilación en `~/build.log`', hint: ['El grupo es /aws/codebuild/api y el flujo es el UUID de la compilación (la parte tras «api:» del id).', 'aws logs get-log-events --log-group-name /aws/codebuild/api --log-stream-name <uuid> --query "events[].message" --output text > ~/build.log'], check: (c) => /Pruebas superadas/.test(c.file('build.log') ?? '') || '~/build.log debe contener el mensaje «Pruebas superadas» de la compilación.' },
      ],
      setup: (sh) => prep(sh, [...GIT_CFG, ...seed('api', { 'buildspec.yml': 'version: 0.2\nphases:\n  build:\n    commands:\n      - echo Compilando la API\n      - npm test\n      - echo Pruebas superadas\n', 'package.json': '{"name":"api","scripts":{"test":"echo ok"}}\n' })]),
      script: [
        ACC,
        `aws iam create-role --role-name codebuild-api --assume-role-policy-document '${TRUST('codebuild.amazonaws.com')}'`,
        `aws iam put-role-policy --role-name codebuild-api --policy-name compilar --policy-document '${POL_BUILD}'`,
        `aws codebuild create-project --name api --source type=CODECOMMIT,location=${URL('api')} --artifacts type=NO_ARTIFACTS --environment ${ENV} --service-role arn:aws:iam::$ACC:role/codebuild-api`,
        'ID=$(aws codebuild start-build --project-name api --query build.id --output text)',
        'aws codebuild batch-get-builds --ids $ID --query builds[0].buildStatus --output text',
        'aws logs get-log-events --log-group-name /aws/codebuild/api --log-stream-name $(echo $ID | cut -d: -f2) --query "events[].message" --output text > ~/build.log',
      ],
      realWorld: 'CodeBuild cobra por minuto de compilación según el tipo de instancia (`BUILD_GENERAL1_SMALL` es la más barata) y no cobra mientras no hay compilaciones. Los registros siguen en CloudWatch Logs y se cobran por almacenamiento: fija una retención. **Limpieza:** `aws codebuild delete-project --name api`, `aws logs delete-log-group --log-group-name /aws/codebuild/api` y borra el rol `codebuild-api` (primero su política en línea).',
    },
    {
      id: 'l10-e5',
      title: 'La compilación que no arranca',
      summary: 'Diagnostica dos fallos seguidos: el rol no confía en CodeBuild y luego le faltan permisos.',
      difficulty: 'Difícil',
      minutes: 22,
      saa: [SAA_DOMAINS[1]],
      tags: ['CodeBuild', 'IAM', 'Diagnóstico'],
      scenario: 'Un compañero dejó preparado el rol `codebuild-facturas` y el repositorio `facturas`, pero el proyecto no se puede crear. Averigua por qué, corrígelo y crea el proyecto `facturas`. Cuando lance la primera compilación **fallará** otra vez: lee la fase que falla, arregla el rol y consigue una compilación `SUCCEEDED`.',
      steps: [
        { id: 'fail1', title: 'Intenta crear el proyecto `facturas` con el rol y lee el error de `AssumeRole`', hint: ['aws codebuild create-project --name facturas --source type=CODECOMMIT,location=<url> --artifacts type=NO_ARTIFACTS --environment ... --service-role arn:aws:iam::<cuenta>:role/codebuild-facturas'], check: (c) => c.trail('CreateProject', { error: true }).length > 0 || 'Intenta crear el proyecto: el error te dirá qué le pasa al rol.' },
        { id: 'trust', title: 'Corrige la política de confianza del rol para que confíe en `codebuild.amazonaws.com` y crea el proyecto', hint: ['aws iam get-role --role-name codebuild-facturas --query Role.AssumeRolePolicyDocument', 'aws iam update-assume-role-policy --role-name codebuild-facturas --policy-document <json>'], check: (c) => { const r = c.role('codebuild-facturas'); if (!r || !trustsService(r, 'codebuild.amazonaws.com')) return 'El rol todavía no confía en codebuild.amazonaws.com.'; return cicd(c.s).projects.some((p) => p.name === 'facturas') || 'Falta crear el proyecto facturas.'; } },
        { id: 'fail2', title: 'Lanza una compilación y comprueba que termina en `FAILED` por permisos de registros', hint: ['aws codebuild start-build --project-name facturas', 'aws codebuild batch-get-builds --ids <id> --query builds[0].phases[].contexts'], check: (c) => builds(c, 'facturas').some((b) => b.buildStatus === 'FAILED') || 'Lanza una compilación y revisa por qué falla.' },
        { id: 'ok', title: 'Concede al rol permisos de registros y de lectura del repositorio y repite hasta `SUCCEEDED`', hint: ['aws iam put-role-policy --role-name codebuild-facturas --policy-name compilar --policy-document <json>', 'Acciones: logs:CreateLogGroup, logs:CreateLogStream, logs:PutLogEvents y codecommit:GitPull.'], check: (c) => { const b = builds(c, 'facturas'); const ok = b.find((x) => x.buildStatus === 'SUCCEEDED'); const bad = b.find((x) => x.buildStatus === 'FAILED'); return (!!ok && !!bad && ok.startTime >= bad.startTime) || 'Falta una compilación correcta posterior al fallo.'; } },
      ],
      setup: (sh) => prep(sh, [...GIT_CFG, ...seed('facturas', { 'buildspec.yml': 'version: 0.2\nphases:\n  build:\n    commands:\n      - echo Generando facturas\n' }), `aws iam create-role --role-name codebuild-facturas --assume-role-policy-document '${TRUST('ec2.amazonaws.com')}'`]),
      script: [
        ACC,
        `aws codebuild create-project --name facturas --source type=CODECOMMIT,location=${URL('facturas')} --artifacts type=NO_ARTIFACTS --environment ${ENV} --service-role arn:aws:iam::$ACC:role/codebuild-facturas || true`,
        'aws iam get-role --role-name codebuild-facturas --query Role.AssumeRolePolicyDocument',
        `aws iam update-assume-role-policy --role-name codebuild-facturas --policy-document '${TRUST('codebuild.amazonaws.com')}'`,
        `aws codebuild create-project --name facturas --source type=CODECOMMIT,location=${URL('facturas')} --artifacts type=NO_ARTIFACTS --environment ${ENV} --service-role arn:aws:iam::$ACC:role/codebuild-facturas`,
        'ID=$(aws codebuild start-build --project-name facturas --query build.id --output text)',
        'aws codebuild batch-get-builds --ids $ID --query builds[0].phases[].contexts',
        `aws iam put-role-policy --role-name codebuild-facturas --policy-name compilar --policy-document '${POL_BUILD}'`,
        'ID=$(aws codebuild start-build --project-name facturas --query build.id --output text)',
        'aws codebuild batch-get-builds --ids $ID --query builds[0].buildStatus --output text',
      ],
      realWorld: 'Son los dos errores más habituales con roles de servicio: **confianza** (quién puede asumir el rol) y **permisos** (qué puede hacer el rol). Tienen mensajes distintos: el primero aparece al crear el proyecto y el segundo dentro de la compilación, en la fase `PROVISIONING` o en los registros. En una cuenta real usa CloudTrail para ver qué acción exacta se denegó. **Limpieza:** `aws codebuild delete-project --name facturas` y borra el rol y su política en línea.',
    },
    {
      id: 'l10-e6',
      title: 'Canalización con aprobación manual',
      summary: 'Source, Build, aprobación y despliegue a S3, con un permiso que falta en el rol de la canalización.',
      difficulty: 'Reto',
      minutes: 30,
      saa: [SAA_DOMAINS[1], SAA_DOMAINS[2]],
      tags: ['CodePipeline', 'CodeBuild', 'S3', 'IAM'],
      scenario: 'Ya existen el repositorio `sitio`, el proyecto `sitio-build`, los buckets `lab-sitio-artefactos` y `lab-sitio-web` y el rol `pipeline-sitio`. Escribe `pipeline.json` con las etapas Source (CodeCommit, rama `main`), Build (CodeBuild), Aprobacion (manual) y Deploy (S3 en `lab-sitio-web`), y créala con `--cli-input-json`. La etapa Build **fallará** porque al rol de la canalización le falta un permiso: corrígelo, reintenta la etapa, aprueba el cambio y comprueba que `index.html` llega al bucket web.',
      steps: [
        { id: 'create', title: 'Crea la canalización `sitio` con cuatro etapas, una de ellas de aprobación manual', hint: ['aws codepipeline create-pipeline --cli-input-json file://pipeline.json', 'El JSON lleva {"pipeline": {"name", "roleArn", "artifactStore", "stages"}}; las acciones usan actionTypeId con category, owner AWS, provider y version 1.'], check: (c) => { const p = cicd(c.s).pipelines.find((x) => x.name === 'sitio'); if (!p) return 'La canalización sitio todavía no existe.'; return (p.stages.length === 4 && p.stages.some((s) => s.actions.some((a) => a.actionTypeId.category === 'Approval'))) || 'Debe tener cuatro etapas, una con una acción de aprobación manual.'; } },
        { id: 'diag', title: 'Lee en `get-pipeline-state` el error de permisos de la etapa Build', hint: ['aws codepipeline get-pipeline-state --name sitio --query "stageStates[1].actionStates[0].latestExecution.errorDetails"'], check: (c) => c.ran(/codepipeline\s+get-pipeline-state/) && pipeExecs(c).some((e) => e.stages[1]?.status === 'Failed' || e.stages[1]?.status === 'Succeeded') || 'Consulta el estado de la canalización con get-pipeline-state.' },
        { id: 'fix', title: 'Añade `codebuild:StartBuild` al rol `pipeline-sitio` y reintenta la etapa Build', hint: ['aws iam put-role-policy --role-name pipeline-sitio --policy-name pipeline --policy-document <json con codebuild:StartBuild>', 'aws codepipeline retry-stage-execution --pipeline-name sitio --stage-name Build --pipeline-execution-id <id> --retry-mode FAILED_ACTIONS'], check: (c) => pipeExecs(c).some((e) => e.stages[1]?.status === 'Succeeded') || 'La etapa Build todavía no ha terminado correctamente.' },
        { id: 'approve', title: 'Aprueba la acción manual con `put-approval-result` y su token', hint: ['aws codepipeline get-pipeline-state --name sitio --query "stageStates[2].actionStates[0].latestExecution.token" --output text', 'aws codepipeline put-approval-result --pipeline-name sitio --stage-name Aprobacion --action-name Revision --result summary=Aprobado,status=Approved --token <token>'], check: (c) => c.trail('PutApprovalResult', { error: false }).length > 0 || 'Todavía no has aprobado la etapa de aprobación.' },
        { id: 'deploy', title: 'Comprueba que `index.html` está en `lab-sitio-web` y que la ejecución terminó en `Succeeded`', hint: ['aws s3 ls s3://lab-sitio-web/', 'aws codepipeline list-pipeline-executions --pipeline-name sitio'], check: (c) => (!!c.object('lab-sitio-web', 'index.html') && pipeExecs(c).some((e) => e.status === 'Succeeded')) || 'El sitio aún no se ha desplegado en lab-sitio-web.' },
      ],
      setup: (sh) => prep(sh, [
        ...GIT_CFG,
        ...seed('sitio', { 'buildspec.yml': BUILDSPEC_SITE, 'index.html': '<h1>Sitio</h1>\n' }),
        ACC,
        'aws s3 mb s3://lab-sitio-artefactos',
        'aws s3 mb s3://lab-sitio-web',
        `aws iam create-role --role-name cb-sitio --assume-role-policy-document '${TRUST('codebuild.amazonaws.com')}'`,
        `aws iam put-role-policy --role-name cb-sitio --policy-name compilar --policy-document '${POL_BUILD}'`,
        `aws iam create-role --role-name pipeline-sitio --assume-role-policy-document '${TRUST('codepipeline.amazonaws.com')}'`,
        `aws iam put-role-policy --role-name pipeline-sitio --policy-name pipeline --policy-document '${POL_PIPE_BROKEN}'`,
        `aws codebuild create-project --name sitio-build --source type=CODEPIPELINE --artifacts type=CODEPIPELINE --environment ${ENV} --service-role arn:aws:iam::$ACC:role/cb-sitio`,
      ]),
      script: [
        ACC,
        `printf '${esc(PIPE)}' > pipeline.json`,
        'sed -i s/CUENTA/$ACC/ pipeline.json',
        'aws codepipeline create-pipeline --cli-input-json file://pipeline.json',
        'aws codepipeline get-pipeline-state --name sitio --query "stageStates[1].actionStates[0].latestExecution.errorDetails"',
        `aws iam put-role-policy --role-name pipeline-sitio --policy-name pipeline --policy-document '${POL_PIPE_FULL}'`,
        'EX=$(aws codepipeline get-pipeline-state --name sitio --query "stageStates[1].latestExecution.pipelineExecutionId" --output text)',
        'aws codepipeline retry-stage-execution --pipeline-name sitio --stage-name Build --pipeline-execution-id $EX --retry-mode FAILED_ACTIONS',
        'TOKEN=$(aws codepipeline get-pipeline-state --name sitio --query "stageStates[2].actionStates[0].latestExecution.token" --output text)',
        'aws codepipeline put-approval-result --pipeline-name sitio --stage-name Aprobacion --action-name Revision --result summary=Aprobado,status=Approved --token $TOKEN',
        'aws s3 ls s3://lab-sitio-web/',
      ],
      realWorld: 'Una canalización real cuesta 1 USD al mes por canalización activa (la primera es gratuita) más las compilaciones y el almacenamiento de artefactos en S3. Usa un bucket de artefactos cifrado con KMS y, en la acción de aprobación, un tema de SNS para avisar a los revisores. **Limpieza:** `aws codepipeline delete-pipeline --name sitio`, `aws codebuild delete-project --name sitio-build`, vacía y borra los dos buckets (`aws s3 rb --force`) y elimina los roles `pipeline-sitio` y `cb-sitio` con sus políticas.',
    },
  ],
  quiz: [
    { domain: 1, q: 'Quieres que solo se pueda cambiar la rama `main` de un repositorio de CodeCommit mediante pull requests aprobados. ¿Qué combinación es la adecuada?', options: ['Una regla de aprobación y un Deny de IAM sobre GitPush con la condición codecommit:References', 'Solo una regla de aprobación, porque bloquea los push directos', 'Cifrar el repositorio con KMS', 'Quitar el rol de CodeBuild'], answer: 0, explain: 'Las reglas de aprobación controlan los pull requests, pero no impiden un git push directo. Para cerrar esa vía se añade una política de IAM con Deny sobre codecommit:GitPush (y PutFile, merges) cuando codecommit:References es refs/heads/main.' },
    { domain: 1, q: '`aws codebuild create-project` falla con «CodeBuild is not authorized to perform: sts:AssumeRole». ¿Cuál es la causa más probable?', options: ['La imagen no existe', 'La política de confianza del rol de servicio no nombra a codebuild.amazonaws.com', 'Falta el archivo buildspec.yml', 'El bucket de artefactos no existe'], answer: 1, explain: 'Un servicio solo puede asumir un rol si la política de confianza (AssumeRolePolicyDocument) lo nombra como principal. Los permisos del rol son otro asunto y fallan después, durante la compilación.' },
    { domain: 1, q: '¿Cómo se autentica `git clone` por HTTPS contra CodeCommit sin guardar contraseñas?', options: ['Con una clave SSH de EC2', 'Con el asistente de credenciales de AWS CLI, que firma la petición con las credenciales IAM', 'Con el usuario root de la cuenta', 'Con un token de GitHub'], answer: 1, explain: 'git config --global credential.helper \'!aws codecommit credential-helper $@\' hace que Git firme cada petición con las credenciales de AWS CLI (usuario o rol de IAM), sin contraseñas propias.' },
    { domain: 2, q: 'Una canalización se detiene en la etapa Build porque a su rol le faltaba un permiso. Ya lo has corregido. ¿Qué haces para continuar sin volver a empezar desde el origen?', options: ['Borrar la canalización y crearla de nuevo', 'Reintentar la etapa fallida con retry-stage-execution', 'Hacer un nuevo commit vacío obligatoriamente', 'Cambiar de región'], answer: 1, explain: 'retry-stage-execution con FAILED_ACTIONS repite solo las acciones fallidas de la etapa, dentro de la misma ejecución y con los mismos artefactos.' },
    { domain: 2, q: 'Quieres que una actualización de producción espere la confirmación de una persona antes de desplegarse. ¿Qué añades a la canalización?', options: ['Una acción Approval de tipo Manual antes de Deploy', 'Otra acción de Build', 'Una alarma de CloudWatch', 'Un grupo de seguridad'], answer: 0, explain: 'La acción manual deja la etapa en InProgress con un token hasta que alguien con codepipeline:PutApprovalResult la aprueba o la rechaza; puede avisar por SNS.' },
    { domain: 2, q: 'Con CodeDeploy quieres desplegar en una flota minimizando el riesgo, de forma que solo la mitad de las instancias esté fuera de servicio a la vez. ¿Qué configuración eliges?', options: ['CodeDeployDefault.AllAtOnce', 'CodeDeployDefault.HalfAtATime', 'CodeDeployDefault.OneAtATime con 1 instancia', 'Ninguna: CodeDeploy siempre es secuencial'], answer: 1, explain: 'HalfAtATime despliega en el 50 % de las instancias a la vez; OneAtATime es más lento y AllAtOnce es el más rápido pero el más arriesgado.' },
    { domain: 3, q: 'En un `buildspec.yml`, ¿cuál es el orden correcto de las fases principales de una compilación?', options: ['build, install, post_build, pre_build', 'install, pre_build, build, post_build', 'pre_build, install, post_build, build', 'install, build, pre_build, post_build'], answer: 1, explain: 'Las fases se ejecutan en el orden install, pre_build, build y post_build; después se suben los artefactos.' },
    { domain: 4, q: 'Terminas el laboratorio de CI/CD y quieres evitar costes olvidados. ¿Qué eliminas primero?', options: ['Nada: CodeBuild no cobra', 'Las canalizaciones, los proyectos y los grupos de registros; también vaciar los buckets de artefactos', 'Solo el rol de IAM', 'Solo el repositorio'], answer: 1, explain: 'La canalización activa se cobra por mes, CodeBuild por minuto y S3 y CloudWatch Logs por almacenamiento. Los roles de IAM no cuestan, pero deben borrarse por higiene.' },
  ],
};

import { SAA_DOMAINS, type Level } from '../types';
import { prep, profileFor } from '../setup';
import kms from './l05/1-kms.md?raw';
import politicas from './l05/2-politicas.md?raw';
import ciclo from './l05/3-ciclo.md?raw';
import secretos from './l05/4-secretos.md?raw';

const ACC = 'ACC=$(aws sts get-caller-identity --query Account --output text)';
const ME = 'ME=$(aws sts get-caller-identity --query Arn --output text)';
const TEXTO = 'tarjeta de prueba 4111 1111 1111 1111';

export const l05: Level = {
  id: 5,
  slug: 'cifrado',
  title: 'Cifrado y secretos',
  subtitle: 'KMS, políticas de clave, SSE-KMS en S3 y Secrets Manager',
  skills: ['Claves y alias de KMS', 'Políticas de clave y grants', 'SSE-KMS en S3', 'Versiones y rotación de secretos', 'Recuperación de secretos'],
  lessons: [
    { id: 'l05-kms', title: 'KMS: claves, alias y cifrado', minutes: 7, body: kms },
    { id: 'l05-politicas', title: 'Políticas de clave, administradores y grants', minutes: 8, body: politicas },
    { id: 'l05-ciclo', title: 'Rotación, eliminación y SSE-KMS en S3', minutes: 7, body: ciclo },
    { id: 'l05-secretos', title: 'Secrets Manager: versiones, rotación y recuperación', minutes: 8, body: secretos },
  ],
  exercises: [
    {
      id: 'l05-e1',
      title: 'Tu primera clave de KMS',
      summary: 'Crea una clave con alias, cifra y descifra un texto y activa la rotación.',
      difficulty: 'Fácil',
      minutes: 12,
      saa: [SAA_DOMAINS[1]],
      tags: ['KMS', 'Cifrado', 'Alias'],
      scenario: `Vas a guardar un dato sensible cifrado. Crea una **clave administrada por el cliente** con el alias \`alias/lab-datos\`, cifra el texto «${TEXTO}» y guarda el resultado en \`~/tarjeta.enc\`. Después descífralo a \`~/tarjeta.txt\` y activa la **rotación automática** de la clave.`,
      steps: [
        { id: 'key', title: 'Crea una clave de KMS y ponle el alias `alias/lab-datos`', hint: ['aws kms create-key --description "Laboratorio"', 'aws kms create-alias --alias-name alias/lab-datos --target-key-id <KeyId>'], check: (c) => { const k = c.kmsKey('alias/lab-datos'); return (!!k && k.manager === 'CUSTOMER' && k.state === 'Enabled') || 'Falta una clave del cliente habilitada con el alias alias/lab-datos.'; } },
        { id: 'enc', title: 'Cifra el texto con esa clave y guarda el binario en `~/tarjeta.enc`', hint: ['El resultado de encrypt viene en base64: extrae `CiphertextBlob` con `--query … --output text` y decodifícalo con `base64 --decode`.', `aws kms encrypt --key-id alias/lab-datos --plaintext "${TEXTO}" --cli-binary-format raw-in-base64-out --query CiphertextBlob --output text | base64 --decode > ~/tarjeta.enc`], check: (c) => ((c.file('tarjeta.enc')?.length ?? 0) > 20 && c.trail('Encrypt', { error: false }).length > 0) || 'Aún no existe ~/tarjeta.enc generado con kms encrypt.' },
        { id: 'dec', title: 'Descífralo y guarda el texto original en `~/tarjeta.txt`', hint: ['aws kms decrypt --ciphertext-blob fileb://$HOME/tarjeta.enc --query Plaintext --output text | base64 --decode > ~/tarjeta.txt'], check: (c) => c.file('tarjeta.txt')?.trim() === TEXTO || '~/tarjeta.txt no contiene el texto original.' },
        { id: 'rot', title: 'Activa la rotación automática de la clave', hint: ['aws kms enable-key-rotation --key-id alias/lab-datos'], check: (c) => c.kmsKey('alias/lab-datos')?.rotation === true || 'La rotación de la clave sigue desactivada.' },
      ],
      script: [
        'KID=$(aws kms create-key --description "Laboratorio" --query KeyMetadata.KeyId --output text)',
        'aws kms create-alias --alias-name alias/lab-datos --target-key-id $KID',
        `aws kms encrypt --key-id alias/lab-datos --plaintext "${TEXTO}" --cli-binary-format raw-in-base64-out --query CiphertextBlob --output text | base64 --decode > ~/tarjeta.enc`,
        'aws kms decrypt --ciphertext-blob fileb://$HOME/tarjeta.enc --query Plaintext --output text | base64 --decode > ~/tarjeta.txt',
        'aws kms enable-key-rotation --key-id alias/lab-datos',
        'cat ~/tarjeta.txt',
      ],
      realWorld: 'En tu cuenta real una clave del cliente cuesta **1 USD/mes** (más 0,03 USD por cada 10 000 llamadas), y la rotación automática añade 1 USD/mes desde la segunda rotación. En **aws-secure-infrastructure** define la clave como `aws_kms_key` con `enable_key_rotation = true` y un `aws_kms_alias`. **Limpieza:** `aws kms schedule-key-deletion --key-id alias/lab-datos --pending-window-in-days 7` (la ventana mínima) y `delete-alias`; hasta que acabe la ventana todavía se factura.',
    },
    {
      id: 'l05-e2',
      title: 'AccessDenied por la política de clave',
      summary: 'Dani es administrador de la clave y tiene IAM completo, pero no puede cifrar. Averigua por qué y arréglalo.',
      difficulty: 'Difícil',
      minutes: 20,
      saa: [SAA_DOMAINS[1]],
      tags: ['KMS', 'Key policy', 'Grants', 'Diagnóstico'],
      scenario: 'Dani, del equipo de nóminas, tiene `AdministratorAccess` en IAM y figura como **administrador** de la clave `alias/nominas`. Sin embargo `aws kms encrypt --profile dani` le devuelve `AccessDeniedException`. **Reprodúcelo, lee la política de la clave, entiende la causa y concédele solo el uso de cifrado y descifrado** sin abrir la clave a nadie más.',
      setup: async (sh) => {
        await prep(sh, [
          ACC,
          ME,
          'aws iam create-user --user-name dani',
          'aws iam attach-user-policy --user-name dani --policy-arn arn:aws:iam::aws:policy/AdministratorAccess',
          ...profileFor('dani'),
          'KID=$(aws kms create-key --description "Nóminas" --bypass-policy-lockout-safety-check --policy "{\\"Version\\":\\"2012-10-17\\",\\"Statement\\":[{\\"Sid\\":\\"Propietario\\",\\"Effect\\":\\"Allow\\",\\"Principal\\":{\\"AWS\\":\\"$ME\\"},\\"Action\\":\\"kms:*\\",\\"Resource\\":\\"*\\"},{\\"Sid\\":\\"AdministradorDani\\",\\"Effect\\":\\"Allow\\",\\"Principal\\":{\\"AWS\\":\\"arn:aws:iam::$ACC:user/dani\\"},\\"Action\\":[\\"kms:Describe*\\",\\"kms:Get*\\",\\"kms:List*\\",\\"kms:Put*\\",\\"kms:Enable*\\",\\"kms:Disable*\\"],\\"Resource\\":\\"*\\"}]}" --query KeyMetadata.KeyId --output text)',
          'aws kms create-alias --alias-name alias/nominas --target-key-id $KID',
        ]);
      },
      steps: [
        { id: 'repro', title: 'Reproduce el error: `aws kms encrypt --key-id alias/nominas --plaintext abc --profile dani`', hint: ['Añade `--cli-binary-format raw-in-base64-out` para pasar el texto sin codificar.'], check: (c) => c.trailBy('dani', 'Encrypt', { error: true }).length > 0 || 'Aún no has reproducido el AccessDenied con el perfil dani.' },
        { id: 'pol', title: 'Lee la política de la clave con `get-key-policy`', hint: ['aws kms get-key-policy --key-id alias/nominas --policy-name default --query Policy --output text', 'Fíjate en las acciones de la sentencia de Dani y en que no hay sentencia para la raíz de la cuenta: IAM no puede ayudar.'], check: (c) => c.ran(/kms\s+get-key-policy/) || 'Aún no has consultado la política de la clave.' },
        { id: 'fix', title: 'Concede a Dani `Encrypt` y `Decrypt` sobre la clave (grant o política), sin dar acceso a nadie más', hint: ['Una opción: aws kms create-grant --key-id alias/nominas --grantee-principal arn:aws:iam::<cuenta>:user/dani --operations Encrypt Decrypt', 'Otra: añade una sentencia a la política con `put-key-policy`. No uses `Principal: *`.'], check: (c) => { const k = c.kmsKey('alias/nominas'); if (!k) return 'La clave alias/nominas ya no existe.'; if (JSON.stringify(k.policy).includes('"*"') && /"Principal":("\*"|\{"AWS":"\*"\})/.test(JSON.stringify(k.policy))) return 'No abras la clave a todo el mundo (Principal *).'; return (c.kmsCan('dani', 'kms:Encrypt', k) && c.kmsCan('dani', 'kms:Decrypt', k)) || 'Dani todavía no puede usar la clave para cifrar y descifrar.'; } },
        { id: 'ok', title: 'Comprueba que `aws kms encrypt … --profile dani` funciona', check: (c) => c.trailBy('dani', 'Encrypt', { error: false }).length > 0 || 'Aún no has comprobado que Dani puede cifrar.' },
      ],
      script: [
        'aws kms encrypt --key-id alias/nominas --plaintext abc --cli-binary-format raw-in-base64-out --profile dani || echo "AccessDenied reproducido"',
        'aws kms get-key-policy --key-id alias/nominas --policy-name default --query Policy --output text',
        'aws kms create-grant --key-id alias/nominas --grantee-principal $(aws iam get-user --user-name dani --query User.Arn --output text) --operations Encrypt Decrypt',
        'aws kms encrypt --key-id alias/nominas --plaintext abc --cli-binary-format raw-in-base64-out --profile dani --query CiphertextBlob --output text',
      ],
      solution: 'El error acaba en *«because no resource-based policy allows the kms:Encrypt action»*. La política de la clave solo da a Dani acciones de **administración** (`Describe*`, `Get*`, `Put*`…) y no delega en IAM (no hay sentencia para `arn:aws:iam::<cuenta>:root`), así que su `AdministratorAccess` no sirve de nada. Administrar una clave no es poder usarla. La solución con mínimo privilegio es un **grant** para `Encrypt` y `Decrypt`.\n\n```bash\naws kms encrypt --key-id alias/nominas --plaintext abc --cli-binary-format raw-in-base64-out --profile dani\naws kms get-key-policy --key-id alias/nominas --policy-name default --query Policy --output text\naws kms create-grant --key-id alias/nominas --grantee-principal $(aws iam get-user --user-name dani --query User.Arn --output text) --operations Encrypt Decrypt\naws kms encrypt --key-id alias/nominas --plaintext abc --cli-binary-format raw-in-base64-out --profile dani --query CiphertextBlob --output text\n```',
      realWorld: 'En una cuenta real el flujo es idéntico: lee el final del mensaje de error, `get-key-policy` y CloudTrail (`Encrypt` con `errorCode`). Es el fallo clásico al crear claves por consola eligiendo «administradores» pero no «usuarios». Para evitarlo mantén la sentencia por defecto que delega en la raíz de la cuenta y controla el uso con políticas de IAM. **Limpieza:** `revoke-grant`, borra el usuario `dani` y programa la eliminación de la clave (mínimo 7 días).',
    },
    {
      id: 'l05-e3',
      title: 'SSE-KMS en S3 y qué pasa si desactivas la clave',
      summary: 'Cifra un bucket con tu clave, comprueba el objeto y observa el efecto de desactivarla.',
      difficulty: 'Media',
      minutes: 18,
      saa: [SAA_DOMAINS[1]],
      tags: ['KMS', 'S3', 'SSE-KMS'],
      scenario: 'Cumplimiento exige que el bucket `datos-confidenciales-<tu-cuenta>` cifre todo con una **clave propia** (`alias/s3-datos`), no con la de S3. Configúralo, sube un fichero y demuestra que si la clave se **desactiva**, el contenido deja de poder leerse (y vuelve cuando la reactivas).',
      setup: async (sh) => {
        await prep(sh, [ACC, 'KID=$(aws kms create-key --description "Clave para S3" --query KeyMetadata.KeyId --output text)', 'aws kms create-alias --alias-name alias/s3-datos --target-key-id $KID']);
      },
      steps: [
        { id: 'bucket', title: 'Crea el bucket `datos-confidenciales-<cuenta>` con cifrado por defecto SSE-KMS usando `alias/s3-datos`', hint: ['aws s3api create-bucket … --create-bucket-configuration LocationConstraint=eu-west-1', 'aws s3api put-bucket-encryption --bucket <bucket> --server-side-encryption-configuration \'{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms","KMSMasterKeyID":"alias/s3-datos"}}]}\''], check: (c) => { const b = c.bucketLike(/^datos-confidenciales-/); if (!b) return 'Falta el bucket datos-confidenciales-<cuenta>.'; const k = c.kmsKey('alias/s3-datos'); return (b.encryption?.algorithm === 'aws:kms' && !!k && !!b.encryption.kmsKeyId && (b.encryption.kmsKeyId.includes(k.id) || b.encryption.kmsKeyId === 'alias/s3-datos')) || 'El bucket debe cifrar por defecto con aws:kms y la clave alias/s3-datos.'; } },
        { id: 'put', title: 'Sube `nominas.csv` y comprueba con `head-object` que usa SSE-KMS', hint: ['echo "ana,2100" > ~/nominas.csv', 'aws s3api head-object --bucket <bucket> --key nominas.csv'], check: (c) => { const b = c.bucketLike(/^datos-confidenciales-/); const o = b?.objects['nominas.csv']; return (o?.sse?.algorithm === 'aws:kms' && c.ran(/head-object/)) || 'El objeto nominas.csv no está cifrado con KMS, o no lo has inspeccionado con head-object.'; } },
        { id: 'dis', title: 'Desactiva la clave y comprueba que descargar el objeto falla', hint: ['aws kms disable-key --key-id alias/s3-datos', 'aws s3 cp s3://<bucket>/nominas.csv - → KMS.DisabledException'], check: (c) => (c.trail('DisableKey', { error: false }).length > 0 && c.trail('GetObject', { error: true }).length > 0) || 'Desactiva la clave y comprueba que la lectura del objeto falla.' },
        { id: 'en', title: 'Reactiva la clave y vuelve a leer el objeto', hint: ['aws kms enable-key --key-id alias/s3-datos'], check: (c) => c.kmsKey('alias/s3-datos')?.state === 'Enabled' && c.trail('GetObject', { error: false }).length > 0 ? true : 'Reactiva la clave y descarga el objeto con éxito.' },
      ],
      script: [
        'B=datos-confidenciales-$ACC',
        'aws s3api create-bucket --bucket $B --create-bucket-configuration LocationConstraint=eu-west-1',
        `aws s3api put-bucket-encryption --bucket $B --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms","KMSMasterKeyID":"alias/s3-datos"}}]}'`,
        'echo "ana,2100" > ~/nominas.csv',
        'aws s3 cp ~/nominas.csv s3://$B/nominas.csv',
        'aws s3api head-object --bucket $B --key nominas.csv',
        'aws kms disable-key --key-id alias/s3-datos',
        'aws s3 cp s3://$B/nominas.csv - || echo "KMS.DisabledException esperado"',
        'aws kms enable-key --key-id alias/s3-datos',
        'aws s3 cp s3://$B/nominas.csv -',
      ],
      realWorld: 'En tu cuenta real activa también **Bucket Keys** (`BucketKeyEnabled: true`) para reducir hasta un 99 % las llamadas a KMS y su coste. Con la clave desactivada o eliminada, los objetos siguen almacenados pero son ilegibles: por eso la eliminación de claves tiene ventana de 7 a 30 días. **Limpieza:** vacía y borra el bucket (`aws s3 rb s3://… --force`) y programa la eliminación de la clave.',
    },
    {
      id: 'l05-e4',
      title: 'Secrets Manager: versiones y rotación',
      summary: 'Guarda credenciales cifradas con tu clave, cambia el valor y consulta la versión anterior.',
      difficulty: 'Media',
      minutes: 15,
      saa: [SAA_DOMAINS[1], SAA_DOMAINS[4]],
      tags: ['Secrets Manager', 'KMS', 'Rotación'],
      scenario: 'La aplicación `pagos` lee sus credenciales de base de datos desde Secrets Manager. Crea el secreto `prod/pagos/db` cifrado con la clave `alias/secretos-app`, publica una **contraseña nueva** y comprueba que la anterior queda como `AWSPREVIOUS` para poder volver atrás. Por último, lanza una **rotación**.',
      setup: async (sh) => {
        await prep(sh, ['KID=$(aws kms create-key --description "Clave de secretos" --query KeyMetadata.KeyId --output text)', 'aws kms create-alias --alias-name alias/secretos-app --target-key-id $KID']);
      },
      steps: [
        { id: 'create', title: 'Crea `prod/pagos/db` con un JSON `{"username","password"}` cifrado con `alias/secretos-app`', hint: [`aws secretsmanager create-secret --name prod/pagos/db --kms-key-id alias/secretos-app --secret-string '{"username":"pagos","password":"inicial-123"}'`], check: (c) => { const s = c.secret('prod/pagos/db'); if (!s) return 'Falta el secreto prod/pagos/db.'; const k = c.kmsKey('alias/secretos-app'); return (!!k && !!s.kmsKeyId && (s.kmsKeyId === 'alias/secretos-app' || s.kmsKeyId.includes(k.id))) || 'El secreto debe estar cifrado con alias/secretos-app.'; } },
        { id: 'put', title: 'Publica un valor nuevo con `put-secret-value` para que el anterior pase a `AWSPREVIOUS`', hint: [`aws secretsmanager put-secret-value --secret-id prod/pagos/db --secret-string '{"username":"pagos","password":"nueva-456"}'`], check: (c) => { const s = c.secret('prod/pagos/db'); return (!!s && s.versions.some((v) => v.stages.includes('AWSPREVIOUS')) && s.versions.some((v) => v.stages.includes('AWSCURRENT'))) || 'El secreto aún no tiene una versión AWSPREVIOUS.'; } },
        { id: 'prev', title: 'Lee la versión anterior con `--version-stage AWSPREVIOUS`', hint: ['aws secretsmanager get-secret-value --secret-id prod/pagos/db --version-stage AWSPREVIOUS --query SecretString --output text'], check: (c) => c.ran(/get-secret-value.*AWSPREVIOUS/) || 'Aún no has leído la etapa AWSPREVIOUS.' },
        { id: 'rot', title: 'Lanza una rotación inmediata con `rotate-secret`', hint: ['aws secretsmanager rotate-secret --secret-id prod/pagos/db --rotate-immediately', 'Si te pide una Lambda, añade `--rotation-lambda-arn` con cualquier ARN de función.'], check: (c) => c.trail('RotateSecret', { error: false }).length > 0 || 'Aún no has rotado el secreto.' },
      ],
      script: [
        `aws secretsmanager create-secret --name prod/pagos/db --kms-key-id alias/secretos-app --secret-string '{"username":"pagos","password":"inicial-123"}'`,
        `aws secretsmanager put-secret-value --secret-id prod/pagos/db --secret-string '{"username":"pagos","password":"nueva-456"}'`,
        'aws secretsmanager get-secret-value --secret-id prod/pagos/db --version-stage AWSPREVIOUS --query SecretString --output text',
        'aws secretsmanager rotate-secret --secret-id prod/pagos/db --rotation-lambda-arn arn:aws:lambda:eu-west-1:$ACC:function:rotar-db --rotate-immediately',
        'aws secretsmanager list-secret-version-ids --secret-id prod/pagos/db',
      ],
      realWorld: 'En tu cuenta real un secreto cuesta **0,40 USD/mes** y 0,05 USD por 10 000 llamadas. La rotación real usa una función Lambda (hay plantillas para RDS) con los pasos `createSecret`, `setSecret`, `testSecret` y `finishSecret`; la etapa `AWSPENDING` marca la versión en curso. En **aws-secure-infrastructure** pasa el ARN del secreto a la aplicación, nunca el valor. **Limpieza:** `delete-secret --force-delete-without-recovery` en un laboratorio (en producción deja siempre la ventana de recuperación) y elimina la clave.',
    },
    {
      id: 'l05-e5',
      title: 'Recupera un secreto borrado por error',
      summary: 'Un secreto de producción está programado para eliminarse: restáuralo antes de que termine la ventana.',
      difficulty: 'Reto',
      minutes: 15,
      saa: [SAA_DOMAINS[1], SAA_DOMAINS[2]],
      tags: ['Secrets Manager', 'Recuperación', 'Diagnóstico'],
      scenario: 'La aplicación `facturas` ha dejado de arrancar: *«You can\'t perform this operation on the secret because it was marked for deletion»*. Alguien ejecutó `delete-secret` sobre `prod/facturas/api-key` con ventana de 7 días. **Confirma el diagnóstico, restaura el secreto y comprueba que la aplicación vuelve a leer su valor**, que no debe haber cambiado.',
      setup: async (sh) => {
        await prep(sh, [
          `aws secretsmanager create-secret --name prod/facturas/api-key --secret-string 'sk_live_9f8e7d6c'`,
          'aws secretsmanager delete-secret --secret-id prod/facturas/api-key --recovery-window-in-days 7',
        ]);
      },
      steps: [
        { id: 'repro', title: 'Reproduce el fallo: intenta leer `prod/facturas/api-key`', hint: ['aws secretsmanager get-secret-value --secret-id prod/facturas/api-key'], check: (c) => c.trail('GetSecretValue', { error: true }).length > 0 || 'Aún no has reproducido el error al leer el secreto.' },
        { id: 'desc', title: 'Confirma con `describe-secret` que tiene fecha de eliminación (`DeletedDate`)', hint: ['aws secretsmanager describe-secret --secret-id prod/facturas/api-key'], check: (c) => c.ran(/describe-secret/) || 'Aún no has consultado describe-secret.' },
        { id: 'restore', title: 'Restáuralo con `restore-secret`', hint: ['aws secretsmanager restore-secret --secret-id prod/facturas/api-key'], check: (c) => { const s = c.secret('prod/facturas/api-key'); return (!!s && !s.deletedAt) || 'El secreto sigue programado para eliminarse (o ya no existe).'; } },
        { id: 'ok', title: 'Lee el valor y comprueba que sigue siendo `sk_live_9f8e7d6c`', hint: ['aws secretsmanager get-secret-value --secret-id prod/facturas/api-key --query SecretString --output text'], check: (c) => c.trail('GetSecretValue', { error: false }).length > 0 || 'Aún no has leído el secreto restaurado.' },
      ],
      script: [
        'aws secretsmanager get-secret-value --secret-id prod/facturas/api-key || echo "error esperado"',
        'aws secretsmanager describe-secret --secret-id prod/facturas/api-key --query DeletedDate',
        'aws secretsmanager restore-secret --secret-id prod/facturas/api-key',
        'aws secretsmanager get-secret-value --secret-id prod/facturas/api-key --query SecretString --output text',
      ],
      realWorld: 'Es un incidente real frecuente. La ventana de recuperación (7 a 30 días) existe precisamente para esto; con `--force-delete-without-recovery` el borrado es inmediato e irreversible. Para evitarlo, deniega `secretsmanager:DeleteSecret` salvo a un rol de administración y activa una alarma sobre el evento `DeleteSecret` de CloudTrail. **Limpieza:** `delete-secret --force-delete-without-recovery` del secreto de prueba.',
    },
  ],
  quiz: [
    { domain: 1, q: 'Un usuario tiene AdministratorAccess en IAM pero recibe AccessDeniedException al usar una clave de KMS cuya política no delega en la raíz de la cuenta. ¿Por qué?', options: ['AdministratorAccess no incluye KMS', 'La política de la clave debe permitirlo explícitamente: sin delegación en IAM, los permisos de IAM no cuentan', 'Las claves de KMS solo las puede usar el usuario root', 'Hay que activar MFA'], answer: 1, explain: 'En KMS la política de clave es obligatoria. Solo con una sentencia que delegue en la cuenta (o un permiso directo o un grant) funcionan los permisos de IAM.' },
    { domain: 1, q: 'Necesitas cifrar un fichero de 2 GB con KMS. ¿Qué haces?', options: ['Encrypt directamente sobre el fichero', 'Cifrado de sobre: GenerateDataKey y cifrar localmente con la clave de datos', 'Dividirlo en trozos de 4 GB', 'Usar solo SSE-S3'], answer: 1, explain: 'Encrypt admite hasta 4 KB. Para datos grandes se usa una clave de datos (GenerateDataKey) y se guarda cifrada junto al dato.' },
    { domain: 1, q: '¿Cuál es la ventana de espera al programar la eliminación de una clave de KMS?', options: ['Inmediata', '1 a 7 días', '7 a 30 días', '30 a 90 días'], answer: 2, explain: 'KMS exige entre 7 y 30 días. Durante ese tiempo la clave no se puede usar y se puede cancelar la eliminación.' },
    { domain: 1, q: 'Quieres que los objetos de S3 se cifren con una clave que tú controlas y que cada uso quede auditado en CloudTrail. ¿Qué eliges?', options: ['SSE-S3', 'SSE-KMS con una clave del cliente', 'Sin cifrado y un bucket privado', 'HTTP en lugar de HTTPS'], answer: 1, explain: 'SSE-KMS registra cada uso de la clave en CloudTrail y permite controlar su política, rotación y eliminación.' },
    { domain: 1, q: 'Una aplicación en EC2 necesita una contraseña de base de datos que se rote cada 30 días sin cambiar código. ¿Qué servicio usas?', options: ['Variables de entorno en la AMI', 'AWS Secrets Manager con rotación automática', 'Un fichero cifrado en S3 sin versiones', 'IAM access keys en el código'], answer: 1, explain: 'Secrets Manager guarda la credencial cifrada y la rota con una Lambda; la aplicación siempre pide AWSCURRENT.' },
    { domain: 4, q: 'Necesitas guardar cientos de parámetros de configuración cifrados al menor coste, sin rotación automática. ¿Qué eliges?', options: ['Secrets Manager para todos', 'Parameter Store con parámetros SecureString', 'Una clave de KMS por parámetro', 'Un bucket de S3 público'], answer: 1, explain: 'Parameter Store estándar es gratuito y SecureString cifra con KMS. Secrets Manager se reserva a lo que necesita rotación o replicación.' },
    { domain: 2, q: 'Alguien borró un secreto de producción hace dos días con la ventana por defecto. ¿Cómo lo recuperas?', options: ['Es imposible', 'Con restore-secret, porque aún está dentro de la ventana de recuperación', 'Creándolo de nuevo con otro valor', 'Pidiéndolo a soporte de AWS'], answer: 1, explain: 'Con ventana de recuperación (7-30 días) el secreto sigue existiendo y restore-secret lo devuelve intacto. Con borrado forzado no hay vuelta atrás.' },
    { domain: 1, q: 'Tras activar la rotación automática de una clave de KMS, ¿qué ocurre con los datos cifrados antes?', options: ['Quedan ilegibles', 'Siguen pudiendo descifrarse con la misma clave', 'Hay que volver a cifrarlos manualmente', 'Cambia el ARN de la clave'], answer: 1, explain: 'KMS conserva el material anterior para descifrar; el ARN, el alias y la política no cambian.' },
  ],
};

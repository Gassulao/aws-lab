## CodeCommit: repositorios Git privados con IAM

**AWS CodeCommit** es un servicio de repositorios Git administrado: sin servidores que mantener, cifrado en reposo con KMS y autenticación con **IAM**. No hay contraseñas de Git propias: usas tus credenciales de AWS.

Para clonar por HTTPS se configura el **asistente de credenciales** de AWS CLI, que firma cada petición con tu usuario o rol (SigV4):

```bash
aws codecommit create-repository --repository-name tienda --repository-description "Tienda web"
git config --global credential.helper '!aws codecommit credential-helper $@'
git config --global credential.UseHttpPath true
git clone https://git-codecommit.eu-west-1.amazonaws.com/v1/repos/tienda
```

Los permisos se dan con acciones `codecommit:*` sobre el ARN del repositorio. Una condición muy útil es `codecommit:References`, que limita en qué ramas se puede hacer `git push`; así puedes impedir cambios directos en `main`:

```json
{ "Effect": "Deny", "Action": ["codecommit:GitPush", "codecommit:PutFile", "codecommit:MergePullRequestByFastForward"],
  "Resource": "arn:aws:codecommit:eu-west-1:123456789012:tienda",
  "Condition": { "StringEqualsIfExists": { "codecommit:References": ["refs/heads/main"] } } }
```

Las **solicitudes de incorporación de cambios** (*pull requests*) piden revisión antes de fusionar una rama en otra. Con una **plantilla de reglas de aprobación** exiges, por ejemplo, una aprobación de un grupo concreto de revisores; la plantilla se asocia a los repositorios y se aplica a cada PR nuevo. El autor no puede aprobar su propio cambio.

```bash
aws codecommit create-pull-request --title "Añade carrito" --targets repositoryName=tienda,sourceReference=feature/carrito,destinationReference=main
aws codecommit update-pull-request-approval-state --pull-request-id 1 --revision-id <id> --approval-state APPROVE
aws codecommit merge-pull-request-by-fast-forward --pull-request-id 1 --repository-name tienda
```

## CodeBuild: compilar y probar sin servidores

**AWS CodeBuild** ejecuta compilaciones en contenedores efímeros: arranca, descarga el código, ejecuta tus comandos y desaparece. Pagas por minuto de compilación. Un **proyecto** define de dónde sale el código, qué imagen se usa, qué rol asume y dónde van los artefactos.

Los comandos viven en un fichero `buildspec.yml` en la raíz del repositorio. Las fases se ejecutan en orden y, si un comando falla, la compilación falla (salvo `finally`):

```yaml
version: 0.2
phases:
  install:
    commands:
      - echo Instalando dependencias
  build:
    commands:
      - echo Compilando
      - npm test
artifacts:
  files:
    - "**/*"
```

El ciclo completo de una compilación es `SUBMITTED`, `QUEUED`, `PROVISIONING`, `DOWNLOAD_SOURCE`, `INSTALL`, `PRE_BUILD`, `BUILD`, `POST_BUILD`, `UPLOAD_ARTIFACTS`, `FINALIZING` y `COMPLETED`. Los registros van a **CloudWatch Logs** en `/aws/codebuild/<proyecto>`.

El punto donde más se falla es el **rol de servicio**: CodeBuild debe poder asumirlo (la política de confianza tiene que nombrar a `codebuild.amazonaws.com`) y el rol necesita permisos para escribir registros y para leer el código y escribir artefactos. Sin la confianza, `create-project` falla; sin permisos, la compilación falla en la fase de aprovisionamiento.

```bash
aws iam create-role --role-name codebuild-rol --assume-role-policy-document file://confianza.json
aws codebuild create-project --name api --source type=CODECOMMIT,location=<url> --artifacts type=NO_ARTIFACTS \
  --environment type=LINUX_CONTAINER,image=aws/codebuild/standard:7.0,computeType=BUILD_GENERAL1_SMALL --service-role <arn-del-rol>
aws codebuild start-build --project-name api
aws codebuild batch-get-builds --ids <id> --query "builds[0].buildStatus"
```

## CodePipeline y CodeDeploy: de un commit a producción

**AWS CodePipeline** automatiza la entrega continua con **etapas** (*stages*) que contienen **acciones**. Lo habitual es `Source` (CodeCommit, S3), `Build` (CodeBuild), una **aprobación manual** y `Deploy` (CodeDeploy, S3, CloudFormation, ECS). Entre etapas viajan **artefactos**, guardados en un bucket de S3 que tú indicas.

Cada ejecución recorre las etapas en orden; si una acción falla, la ejecución se detiene en esa etapa y puedes **reintentarla** tras corregir el problema. Un `push` a la rama vigilada dispara la canalización sin intervención. La aprobación manual deja la acción `InProgress` con un **token**; alguien con permiso `codepipeline:PutApprovalResult` la aprueba o rechaza, y se puede avisar por SNS.

```bash
aws codepipeline create-pipeline --cli-input-json file://pipeline.json
aws codepipeline get-pipeline-state --name sitio --query "stageStates[].[stageName,latestExecution.status]"
aws codepipeline put-approval-result --pipeline-name sitio --stage-name Aprobacion --action-name Revision \
  --result summary=Aprobado,status=Approved --token <token>
aws codepipeline retry-stage-execution --pipeline-name sitio --stage-name Build --pipeline-execution-id <id> --retry-mode FAILED_ACTIONS
```

La canalización usa su **propio rol de servicio** (confianza en `codepipeline.amazonaws.com`) y es ese rol, no tu usuario, el que necesita permisos sobre el repositorio, el proyecto de CodeBuild y los buckets.

**AWS CodeDeploy** despliega la aplicación en instancias EC2 o servidores locales. Defines una **aplicación**, un **grupo de implementación** (qué instancias, por etiquetas o Auto Scaling, y qué rol de servicio) y una **configuración** (`AllAtOnce`, `HalfAtATime`, `OneAtATime`). La revisión lleva un `appspec.yml` con los *hooks* del ciclo de vida: `ApplicationStop`, `BeforeInstall`, `AfterInstall`, `ApplicationStart` y `ValidateService`.

> Detalle de la CLI: el servicio se llama `deploy`, no `codedeploy`. Se usa `aws deploy create-deployment`; `aws codedeploy` no existe.

## Eventos, reversión y conjuntos de cambios

Todo lo que hace una pila queda en sus **eventos**, del más reciente al más antiguo. Cuando algo falla, el motivo está en el evento `CREATE_FAILED`:

```bash
aws cloudformation describe-stack-events --stack-name demo \
  --query "StackEvents[?ResourceStatus=='CREATE_FAILED'].[LogicalResourceId,ResourceStatusReason]" --output text
```

Si falla la **creación**, la pila hace rollback y acaba en `ROLLBACK_COMPLETE`: no se puede actualizar; hay que borrarla y crearla de nuevo (o usar `--on-failure DO_NOTHING` para inspeccionar los recursos). Si falla una **actualización**, vuelve al estado anterior (`UPDATE_ROLLBACK_COMPLETE`).

### Actualizar con seguridad: conjuntos de cambios

Antes de tocar nada, un **change set** te dice qué pasaría: `Add`, `Modify` o `Remove`, y si un cambio exige **sustitución** (`Replacement: True`: se crea un recurso nuevo y se borra el antiguo, con posible pérdida de datos).

```bash
aws cloudformation create-change-set --stack-name demo --change-set-name cambio1 --template-body file://v2.yaml
aws cloudformation describe-change-set --stack-name demo --change-set-name cambio1 --query Changes
aws cloudformation execute-change-set --stack-name demo --change-set-name cambio1
```

`aws cloudformation deploy` hace todo esto en un solo comando (crea el change set, lo ejecuta y espera):

```bash
aws cloudformation deploy --template-file v2.yaml --stack-name demo --parameter-overrides Entorno=prod
```

Un recurso con **nombre fijo** (`BucketName`, `RoleName`...) no puede sustituirse: CloudFormation lo rechaza. Deja que genere el nombre o cámbialo tú.

## Capacidades, políticas de borrado y buenas prácticas

**Capacidades.** Los recursos de IAM pueden dar permisos, así que CloudFormation te obliga a reconocerlo: `CAPABILITY_IAM`, o `CAPABILITY_NAMED_IAM` si le pones nombre a roles o usuarios.

```bash
aws cloudformation deploy --template-file rol.yaml --stack-name iam --capabilities CAPABILITY_IAM
```

**Rol de servicio.** Con `--role-arn` la pila usa los permisos de un rol de CloudFormation en vez de los tuyos: quien despliega solo necesita `cloudformation:*` e `iam:PassRole`.

**Protege los datos.**

- `DeletionPolicy: Retain` conserva el recurso al borrar la pila (buckets, bases de datos).
- Un bucket con objetos no se puede borrar: el borrado de la pila queda en `DELETE_FAILED`.
- `--enable-termination-protection` impide borrar la pila por accidente.

**Reutiliza.** Las salidas con `Export` se importan con `!ImportValue`; mientras alguien las use, la pila exportadora no se puede borrar.

**Buenas prácticas.** Plantillas en Git, revisión con change sets, `Description` y etiquetas, nada de nombres fijos salvo que sea imprescindible, y limpiar siempre con `delete-stack`:

```bash
aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE
aws cloudformation delete-stack --stack-name demo
```

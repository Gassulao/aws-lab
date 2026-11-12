Una **política** es un documento JSON que dice *quién puede hacer qué sobre qué recurso y bajo qué condiciones*:

```json
{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::informes/*" }
```

## Cómo decide IAM

1. Por defecto todo está **denegado** (deny implícito).
2. Un **Allow** en alguna política aplicable abre la puerta.
3. Un **Deny explícito** en *cualquier* política cierra la puerta, aunque haya cien Allow.

El Deny explícito siempre gana. Por eso se usa para barreras que nadie debe saltarse.

## Condiciones

El bloque `Condition` limita cuándo se aplica una sentencia. Operadores muy usados: `StringEquals`, `IpAddress`, `Bool`, `ArnLike`. Claves habituales: `aws:SourceIp`, `aws:MultiFactorAuthPresent`, `aws:SecureTransport`.

```json
{ "Effect": "Allow", "Action": "s3:PutObject", "Resource": "arn:aws:s3:::informes/*",
  "Condition": { "IpAddress": { "aws:SourceIp": "198.51.100.0/24" } } }
```

## Diagnosticar con el simulador

Cuando algo da `AccessDenied`, en vez de adivinar pregunta a IAM qué decidiría:

```bash
aws iam simulate-principal-policy --policy-source-arn arn:aws:iam::123456789012:user/lucia --action-names s3:GetObject s3:PutObject --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output text
```

Los resultados posibles son `allowed`, `implicitDeny` (nadie lo permite) y `explicitDeny` (alguien lo prohíbe). Esa diferencia te dice si debes **añadir** un permiso o **quitar** un Deny.

> **Tip:** el mensaje de error de AWS ya dice la acción y el recurso exactos (`is not authorized to perform: s3:ListAllMyBuckets`). Léelo entero antes de tocar nada.

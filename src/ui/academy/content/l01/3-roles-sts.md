Un **rol** no tiene contraseña ni claves propias: alguien lo **asume** y recibe credenciales temporales (acceso, secreto y *token* de sesión) que caducan, de 15 minutos a 12 horas. Es la forma recomendada de dar acceso a servicios (EC2, Lambda) y a otras cuentas.

Un rol tiene dos tipos de política:

- **Política de confianza** (*trust policy*): quién puede asumirlo.
- **Políticas de permisos**: qué puede hacer quien lo asume.

```bash
aws sts assume-role --role-arn arn:aws:iam::123456789012:role/auditor --role-session-name sesion1
```

Con las credenciales devueltas se exportan tres variables y, a partir de ahí, `aws sts get-caller-identity` muestra un ARN `assumed-role/...`.

## ExternalId: evitar el "confused deputy"

Si un proveedor externo asume un rol en tu cuenta, exige un **ExternalId** en la política de confianza. Así, otro cliente del proveedor no puede engañarlo para que use *tu* rol:

```json
"Condition": { "StringEquals": { "sts:ExternalId": "acme-7f3a" } }
```

Quien asume el rol debe indicarlo: `--external-id acme-7f3a`.

## MFA para acciones sensibles

La clave `aws:MultiFactorAuthPresent` permite exigir un segundo factor al asumir un rol de administración:

```json
"Condition": { "Bool": { "aws:MultiFactorAuthPresent": "true" } }
```

> **Para el examen:** las aplicaciones en EC2 usan **roles de instancia** (perfil de instancia), nunca claves guardadas en la máquina. Las credenciales temporales se renuevan solas.

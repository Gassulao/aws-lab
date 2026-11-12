## Límite de permisos (permissions boundary)

Un **límite de permisos** es una política que fija el *techo* de lo que puede llegar a hacer un usuario o rol, hagas lo que hagas con sus demás políticas. Los permisos efectivos son la **intersección** entre lo que concede la política de identidad y lo que permite el límite.

Sirve para delegar: dejas que un equipo cree usuarios y roles, pero obligas a que todos lleven un límite.

```bash
aws iam create-user --user-name dev1 --permissions-boundary arn:aws:iam::123456789012:policy/LimiteDev
```

Aunque le adjuntes `AdministratorAccess`, `dev1` solo podrá hacer lo que el límite permita.

## Claves de acceso: rotación

Las claves de acceso (`AKIA...`) son credenciales de larga duración y el mayor riesgo de IAM. Buenas prácticas:

- Cada usuario puede tener **dos** claves a la vez: es lo que permite rotar sin cortar el servicio.
- Rota cada 90 días como máximo: crea la nueva, actualiza la aplicación, **desactiva** la vieja (`Inactive`), espera unos días y entonces **bórrala**.
- Mejor aún: no uses claves; usa roles y credenciales temporales.

```bash
aws iam list-access-keys --user-name servicio-etl --query 'AccessKeyMetadata[].[AccessKeyId,Status,CreateDate]' --output text
```

> **Para el examen:** "rotar claves sin tiempo de inactividad" = crear segunda clave, migrar, desactivar, borrar. "Límite máximo de permisos para usuarios delegados" = permissions boundary.

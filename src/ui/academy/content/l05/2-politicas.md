## La política de clave manda

En KMS, a diferencia del resto de servicios, **la política de la clave es obligatoria**. Aunque tu usuario de IAM tenga `AdministratorAccess`, no puede usar la clave si la política de clave no lo permite, directamente o **delegando en IAM**.

La política por defecto incluye esta sentencia, que delega en IAM:

```json
{ "Sid": "Enable IAM User Permissions", "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::<cuenta>:root" },
  "Action": "kms:*", "Resource": "*" }
```

Sin ella, solo cuentan las sentencias que nombran a cada principal.

## Administrador de clave no es usuario de clave

La consola separa dos roles en la política:

- **Administradores**: `kms:Create*`, `Describe*`, `Put*`, `Enable*`, `Disable*`, `ScheduleKeyDeletion`... Gestionan la clave, pero **no pueden cifrar ni descifrar**.
- **Usuarios**: `kms:Encrypt`, `Decrypt`, `GenerateDataKey*`, `ReEncrypt*`, `DescribeKey`.

Diagnosticar un `AccessDeniedException` es leer el final del mensaje: *«because no resource-based policy allows the kms:Encrypt action»* indica que la política de clave no lo permite.

```bash
aws kms get-key-policy --key-id alias/app-datos --policy-name default
```

## Grants

Un **grant** concede permisos temporales y programáticos sin editar la política. Lo usan servicios como EBS o RDS.

```bash
aws kms create-grant --key-id alias/app-datos --grantee-principal arn:aws:iam::<cuenta>:user/dani --operations Encrypt Decrypt
```

> **Para el examen (dominio 1):** KMS evalúa política de clave + IAM + grants. Una denegación explícita en cualquiera gana siempre.

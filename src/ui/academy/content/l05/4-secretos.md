## Secrets Manager

Guarda credenciales, claves de API y cadenas de conexión **cifradas con KMS**, con control de acceso por IAM y auditoría en CloudTrail. Tu aplicación llama a `GetSecretValue` en lugar de llevar la contraseña en el código.

```bash
aws secretsmanager create-secret --name prod/db --secret-string '{"username":"app","password":"s3cr3to"}'
aws secretsmanager get-secret-value --secret-id prod/db --query SecretString --output text
```

## Versiones y etapas

Cada valor es una **versión** con etiquetas de etapa: `AWSCURRENT` (la vigente), `AWSPREVIOUS` (la anterior) y `AWSPENDING` (en rotación). Al guardar un valor nuevo, el anterior pasa a `AWSPREVIOUS`.

```bash
aws secretsmanager put-secret-value --secret-id prod/db --secret-string '{"username":"app","password":"nueva"}'
aws secretsmanager get-secret-value --secret-id prod/db --version-stage AWSPREVIOUS
```

## Rotación y eliminación

La **rotación** ejecuta una función Lambda que cambia la contraseña en la base de datos y en el secreto (`rotate-secret`). La **eliminación** nunca es inmediata: por defecto hay 30 días de ventana (7 a 30), y en ese tiempo `restore-secret` lo recupera. Mientras está programado para borrarse, `GetSecretValue` falla.

```bash
aws secretsmanager delete-secret --secret-id prod/db --recovery-window-in-days 7
aws secretsmanager restore-secret --secret-id prod/db
```

> **Para el examen (dominios 1 y 4):** Secrets Manager rota solo y cuesta ~0,40 USD/secreto/mes; Parameter Store (`SecureString`) es gratis pero no rota por sí mismo.

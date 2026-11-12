## Rotación, desactivación y eliminación

- **Rotación automática**: cambia el material de la clave cada año (configurable de 90 a 2560 días). Los datos antiguos siguen descifrándose; el alias y el ARN no cambian.
- **Desactivar** (`disable-key`): reversible al instante. Con la clave desactivada, `Encrypt` y `Decrypt` fallan con `DisabledException`.
- **Programar eliminación**: ventana obligatoria de **7 a 30 días**. Durante ese tiempo la clave queda en `PendingDeletion`, no se puede usar (`KMSInvalidStateException`) y puedes cancelarla. Cuando acaba, **los datos cifrados con ella son irrecuperables**.

```bash
aws kms enable-key-rotation --key-id alias/app-datos
aws kms schedule-key-deletion --key-id alias/app-datos --pending-window-in-days 7
aws kms cancel-key-deletion --key-id alias/app-datos
```

## Cifrado en S3 con KMS (SSE-KMS)

S3 puede cifrar cada objeto con una clave tuya. Quien lea el objeto necesita, además de permisos de S3, permiso `kms:Decrypt` sobre la clave.

```bash
aws s3api put-bucket-encryption --bucket mi-bucket --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms","KMSMasterKeyID":"alias/app-datos"}}]}'
```

Si desactivas la clave, los objetos siguen ahí pero nadie puede leerlos: `KMS.DisabledException`.

> **Para el examen (dominio 1):** SSE-S3 (claves de S3), SSE-KMS (tu clave, auditable) y SSE-C (clave que envía el cliente en cada petición).

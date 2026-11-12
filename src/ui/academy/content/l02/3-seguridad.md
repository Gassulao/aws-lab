Un bucket nuevo es **privado**. El acceso se decide combinando varias capas:

1. **Block Public Access** (BPA): cuatro interruptores (`BlockPublicAcls`, `IgnorePublicAcls`, `BlockPublicPolicy`, `RestrictPublicBuckets`) que anulan cualquier intento de hacer público el bucket. Se pueden fijar por bucket y por cuenta. Vienen **activados** por defecto.
2. **Política de bucket**: JSON con `Principal`, `Action`, `Resource` y condiciones.
3. **Políticas IAM** de quien llama.

Recuerda las dos formas de ARN: `arn:aws:s3:::bucket` (el bucket, para `s3:ListBucket`) y `arn:aws:s3:::bucket/*` (los objetos, para `s3:GetObject`). Confundirlas es la causa nº 1 de «mi política no funciona».

## Cifrado

- **SSE-S3** (`AES256`): S3 gestiona las claves. Es el cifrado por defecto de todos los buckets.
- **SSE-KMS** (`aws:kms`): la clave está en KMS; cada uso queda en CloudTrail y puedes controlarla con su propia política. Mejor para datos sensibles y auditoría.
- **Cifrado en tránsito:** fuerza HTTPS con una política que deniegue cuando `aws:SecureTransport` sea `false`.

```bash
aws s3api put-bucket-encryption --bucket nominas-lab-2026 --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms","KMSMasterKeyID":"alias/aws/s3"}}]}'
```

```bash
aws s3api put-public-access-block --bucket descargas-lab-2026 --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false
```

> **Regla práctica:** deja BPA activado en todo; relájalo solo en el bucket concreto que debe servir contenido público y solo lo necesario.

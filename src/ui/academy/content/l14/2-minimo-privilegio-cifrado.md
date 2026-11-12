## Identidad con mínimo privilegio y datos cifrados

### Roles de instancia, nunca claves

Una instancia EC2 obtiene credenciales temporales de un **rol de IAM** a través de un **perfil de instancia**. Las credenciales se renuevan solas y no quedan escritas en disco. El rol tiene dos partes:

- **Política de confianza**: quién puede asumirlo (`ec2.amazonaws.com`).
- **Política de permisos**: qué puede hacer, con **acciones y recursos concretos**.

```bash
aws iam create-role --role-name web-role --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam create-instance-profile --instance-profile-name web-profile
aws iam add-role-to-instance-profile --instance-profile-name web-profile --role-name web-role
aws ec2 run-instances --image-id <ami> --instance-type t3.micro --iam-instance-profile Name=web-profile --metadata-options HttpTokens=required
```

`HttpTokens=required` fuerza **IMDSv2**: las credenciales del rol solo se obtienen con un token de sesión, lo que frena los ataques SSRF que roban credenciales.

### Mínimo privilegio, medido

«Mínimo» significa que si el rol se filtra, el daño tiene un techo. Compara:

- Malo: `"Action":"s3:*","Resource":"*"`.
- Bueno: `"Action":["s3:GetObject","s3:PutObject"],"Resource":"arn:aws:s3:::tienda-datos-123456789012/*"`.

Prueba siempre lo que **no** debe poder hacer. Es un buen reflejo: tras escribir una política, pregunta al simulador de políticas si el rol puede, por ejemplo, borrar el bucket o crear usuarios.

### Cifrado y postura del bucket

Un bucket de S3 «seguro» tiene al menos cuatro cosas:

1. **Bloqueo de acceso público** completo (las cuatro opciones).
2. **Cifrado por defecto con SSE-KMS** usando una clave **gestionada por el cliente (CMK)**, con **rotación automática** activada.
3. **Versionado**, para recuperarte de borrados y sobrescrituras.
4. Una **política que exige TLS**: `Deny` con `"Bool":{"aws:SecureTransport":"false"}`.

```bash
KEY=$(aws kms create-key --description "Datos de la tienda" --query KeyMetadata.KeyId --output text)
aws kms create-alias --alias-name alias/tienda-datos --target-key-id $KEY
aws kms enable-key-rotation --key-id $KEY
aws s3api put-bucket-encryption --bucket $B --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms","KMSMasterKeyID":"alias/tienda-datos"}}]}'
```

Para que el rol use un bucket cifrado con SSE-KMS necesita **también** permisos sobre la clave (`kms:Decrypt`, `kms:GenerateDataKey`): la política de la clave delega en IAM, pero esos permisos deben estar en alguna de las dos partes. Un `AccessDenied` al leer un objeto cifrado suele ser KMS, no S3.

## Qué es KMS y por qué existe

**AWS KMS** (Key Management Service) guarda **claves de cifrado** que nunca salen en claro del servicio. Tú no cifras con la clave: le pides a KMS que cifre o descifre por ti, y cada llamada queda registrada en CloudTrail.

- **Claves administradas por AWS** (`aws/s3`, `aws/secretsmanager`, `aws/ebs`…): gratis, se crean solas y no puedes editar su política.
- **Claves administradas por el cliente (CMK)**: las creas tú, controlas la política, la rotación y la eliminación. Cuestan 1 USD/mes.

```bash
aws kms create-key --description "Datos de la aplicación"
aws kms create-alias --alias-name alias/app-datos --target-key-id <KeyId>
```

Un **alias** es un nombre amable (`alias/app-datos`) que puedes mover a otra clave sin tocar el código.

## Cifrar y descifrar

`Encrypt` sirve para datos pequeños (hasta 4 KB). Para ficheros grandes se usa **cifrado de sobre**: `GenerateDataKey` te da una clave de datos en claro y otra cifrada; cifras localmente con la primera, la descartas y guardas la cifrada junto al dato.

```bash
aws kms encrypt --key-id alias/app-datos --plaintext "hola" --cli-binary-format raw-in-base64-out --query CiphertextBlob --output text
```

El texto cifrado (`CiphertextBlob`) incluye la identidad de la clave, por eso `decrypt` no necesita que se la indiques.

> **Para el examen (dominio 1):** el cifrado de sobre es la respuesta para datos grandes; `Encrypt` directo solo admite 4 KB.

## Grupos de seguridad (SG)

Un SG es un cortafuegos virtual **a nivel de instancia**, con estado y solo con reglas *allow*. Por defecto no permite **nada de entrada** y **todo de salida**.

```bash
aws ec2 authorize-security-group-ingress --group-id <sg> --protocol tcp --port 22 --cidr 203.0.113.50/32
```

Buenas prácticas:

- **Nunca** abras 22 (SSH) ni 3389 (RDP) a `0.0.0.0/0`. Restringe a tu IP `/32` o, mejor, usa **Session Manager** (sin puertos abiertos).
- Encadena capas **referenciando grupos**: la base de datos acepta 3306 *solo* desde el SG de la aplicación (`--source-group`), no desde un rango de IP.

## IMDSv2: proteger las credenciales de la instancia

La instancia obtiene sus credenciales de rol del servicio de metadatos (`169.254.169.254`). **IMDSv1** responde a una simple petición GET, de modo que una vulnerabilidad SSRF en tu aplicación puede robar esas credenciales. **IMDSv2** exige un *token* de sesión obtenido con un PUT, lo que lo impide.

```bash
aws ec2 modify-instance-metadata-options --instance-id <i-…> --http-tokens required
```

Para instancias nuevas, `--metadata-options HttpTokens=required` en `run-instances` (o en la plantilla de lanzamiento).

## Roles de instancia

Las aplicaciones no guardan claves: se asocia a la instancia un **perfil de instancia** que contiene un rol de IAM. Las credenciales temporales se rotan solas.

> **Para el examen (dominio 1):** SG = permitir; NACL = permitir y denegar. Secretos fuera del código: roles de instancia, Secrets Manager o Parameter Store.

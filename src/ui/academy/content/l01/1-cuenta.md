Una **cuenta de AWS** es el contenedor de todos tus recursos y de tu facturación. Se identifica con 12 dígitos y es el límite natural de seguridad: lo que no está en la cuenta, no existe para ti.

Al crearla nace el **usuario raíz** (el correo con el que te registraste). Tiene poder absoluto y no se le pueden quitar permisos, así que se usa solo para unas pocas tareas (cerrar la cuenta, cambiar el plan de soporte...). Para todo lo demás trabajas con identidades de **IAM**:

| Identidad | Para qué sirve | Credenciales |
|---|---|---|
| **Usuario IAM** | Una persona o aplicación concreta con vida larga | Contraseña y/o claves de acceso (`AKIA...`) |
| **Grupo** | Agrupar usuarios y darles permisos de una vez | No tiene credenciales propias |
| **Rol** | Permisos que *se asumen* temporalmente | Credenciales temporales de STS (`ASIA...`) |

Regla de oro: **mínimo privilegio**. Empieza sin permisos y añade solo lo imprescindible.

El primer comando que ejecutas siempre que dudas de "quién soy" es:

```bash
aws sts get-caller-identity
```

Devuelve `Account`, `UserId` y `Arn` de quien hace la llamada. Todo lo que hagas queda registrado en **CloudTrail**; puedes verlo con:

```bash
aws cloudtrail lookup-events --max-items 5 --query 'Events[].[EventName,Username]' --output text
```

> **Para el examen (SAA-C03, dominio 1):** el usuario raíz no se usa en el día a día, se protege con MFA y no tiene claves de acceso. Los permisos se dan a grupos y roles, no usuario a usuario.

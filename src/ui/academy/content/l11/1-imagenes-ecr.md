## Imágenes de contenedor y Amazon ECR

Un **contenedor** empaqueta una aplicación con sus dependencias y se ejecuta aislado sobre el kernel del anfitrión. Una **imagen** es la plantilla inmutable (capas de solo lectura); el contenedor es la imagen en ejecución. Las imágenes se describen con un `Dockerfile`:

```bash
printf 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 8080\nCMD ["node","server.js"]\n' > Dockerfile
docker build -t miapp:1.0 .
docker images
```

**Amazon ECR** (*Elastic Container Registry*) es el registro privado de AWS. Cada **repositorio** guarda las versiones de una imagen, identificadas por una **etiqueta** (`1.0`, `latest`) y por un **resumen** o *digest* (`sha256:...`) que nunca cambia. Una URI de imagen tiene la forma `<cuenta>.dkr.ecr.<región>.amazonaws.com/<repositorio>:<etiqueta>`.

Para subir una imagen hay que **autenticar Docker** con un token de 12 horas, etiquetar la imagen con la URI del repositorio y hacer `push`:

```bash
REG=$(aws sts get-caller-identity --query Account --output text).dkr.ecr.eu-west-1.amazonaws.com
aws ecr create-repository --repository-name miapp --image-scanning-configuration scanOnPush=true
aws ecr get-login-password | docker login --username AWS --password-stdin $REG
docker tag miapp:1.0 $REG/miapp:1.0
docker push $REG/miapp:1.0
aws ecr describe-images --repository-name miapp
```

Funciones clave de ECR:

- **Inmutabilidad de etiquetas** (`--image-tag-mutability IMMUTABLE`): impide sobrescribir `1.0`. Es la mejor defensa contra el «en mi máquina funciona»: una etiqueta siempre apunta a lo mismo.
- **Análisis de vulnerabilidades**: `scanOnPush` o `aws ecr start-image-scan` buscan CVE conocidos en los paquetes de la imagen.
- **Políticas de ciclo de vida**: borran automáticamente imágenes antiguas o sin etiqueta para no pagar almacenamiento (se factura por GB al mes).
- **Permisos**: se controlan con IAM (`ecr:GetAuthorizationToken`, `ecr:BatchGetImage`, `ecr:PutImage`...) y con una *política de repositorio* para otras cuentas.

> En este simulador los CVE de los análisis son ficticios (`CVE-2099-xxxx`), pero el flujo de comandos y los campos son los reales.

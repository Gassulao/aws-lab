# Post de LinkedIn: borrador

> Borrador para revisar antes de publicar. Sustituye `[ENLACE AL REPO]` por la URL del repositorio y ajusta el texto si lo cambias.

## Texto del post

Estoy preparando el AWS Solutions Architect (SAA) y quería practicar sin miedo a una factura sorpresa.

Así que construí mi propio simulador de AWS: aws-lab.

Funciona en el navegador, sin cuenta y sin tarjeta, y reproduce los errores reales de AWS (AccessDenied, DependencyViolation, BucketNotEmpty...).

Qué incluye:
- Consola web con IAM, EC2, S3, VPC, CloudFormation, ECS/EKS, Lambda, CodePipeline y más.
- CLI `aws` y CloudShell con un Bash simulado (jq, terraform, git, docker, kubectl).
- Una academia de 15 niveles: 60 lecciones, 86 laboratorios con validación automática y 124 preguntas de test.
- Cada laboratorio indica qué repetir en una cuenta real y qué limpiar para no pagar.

Es un proyecto personal de aprendizaje: no está afiliado a AWS ni a Microsoft, y la idea parte de azure-lab (SalmeronDevZone), sin reutilizar su código.

Código y capturas: [ENLACE AL REPO]

#AWS #Cloud #DevOps #SAA #Terraform #Aprendizaje

## Capturas recomendadas para el carrusel

Orden sugerido (mayoría en tema oscuro; PNG de 1600x900 en `docs/img/`):

1. `02-home-oscuro.png`: portada de la consola (gancho visual).
2. `07-cloudshell-identidad.png`: CloudShell con `aws sts get-caller-identity`.
3. `08-cloudshell-ec2.png`: `aws ec2 describe-instances` con datos.
4. `04-ec2-instancias.png`: la misma infraestructura desde la consola.
5. `09-vpc-mapa.png`: mapa de recursos de una VPC.
6. `11-devtools-pipeline.png`: canalización Source, Build, Aprobación y Deploy.
7. `15-academia-niveles.png`: los 15 niveles con rango y progreso.
8. `17-academia-laboratorio.png`: laboratorio con pasos completados y terminal.

Alternativas: `10-cloudformation-pila.png`, `12-ecs-cluster.png`, `13-eks-cluster.png`, `14-lambda-funcion.png`, `05-iam-usuarios.png`, `06-s3-bucket.png`, `03-home-claro.png` (tema claro), `01-login.png`.

Como adjunto de vídeo: `demo.gif` (12 s: login, consola, CloudShell y dos comandos). LinkedIn admite GIF en publicaciones, pero suele comprimir mejor un MP4 si prefieres subirlo como vídeo.

## Notas antes de publicar

- Las capturas de la academia usan un progreso de ejemplo (niveles 1 a 3 completados), no un progreso real.

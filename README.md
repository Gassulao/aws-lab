# AWS Lab

**Tu AWS privado para aprender Cloud y DevOps.** Simulador de Amazon Web Services que funciona en tu ordenador, sin cuenta, sin tarjeta y sin miedo a la factura.

> Proyecto educativo independiente, sin relación con Amazon. AWS es marca de Amazon.com, Inc. No se conecta a AWS: todo se simula localmente.

## Estado

En construcción por fases. Hoy existen el **motor** de la nube simulada y una **terminal** con Bash y el CLI `aws`, con 69 pruebas:

| Área | Qué cubre |
| --- | --- |
| IAM | Usuarios, grupos, roles, políticas, claves de acceso, perfiles de instancia, MFA, simulador de políticas |
| Evaluación de políticas | Deny explícito > Allow > denegación implícita, NotAction/NotResource, condiciones, variables, límites de permisos, políticas de sesión y de recurso |
| STS | `GetCallerIdentity`, `AssumeRole` (trust policy, MFA, ExternalId, duración, política de sesión), `GetSessionToken`, caducidad |
| S3 | Buckets, objetos, versionado, política de bucket, bloqueo de acceso público, cifrado, web estática, acceso anónimo |
| VPC / EC2 | VPC (y predeterminada), subredes, IGW, NAT, tablas de rutas, Security Groups, NACL, instancias con ciclo de vida y coste, IMDSv2, diagnóstico de conectividad |
| CloudTrail | Cada llamada (con su error) queda registrada |

Los errores reproducen los textos reales de AWS (`AccessDenied`, `DependencyViolation`, `BucketNotEmpty`...).

### Terminal

Bash simulado (tuberías, variables, `$(...)`, redirecciones, here-documents, `if`/`for`/`while`, `jq`, `curl`) y CLI `aws` con `--query` (JMESPath), `--output json|text|table|yaml`, `file://`, sintaxis abreviada, perfiles y credenciales temporales por variables de entorno. Servicios: `sts`, `iam`, `ec2`, `s3` (alto nivel), `s3api` y `cloudtrail`.

## Hoja de ruta

1. Motor: IAM, STS, S3, VPC, EC2 ✅
2. Shell bash simulado y CLI `aws` (con `--query` y `--output`) ✅
3. Academia: motor de laboratorios con validación automática y niveles 1–5
4. Consola web
5. Resto del temario: CloudFormation y Terraform, ECR/EKS, CloudWatch, KMS y Secrets Manager, Route 53, pipelines

## Desarrollo

```bash
npm install
npm test          # pruebas del motor
npm run typecheck
```

## Verificar la arquitectura y repetirla con Terraform

Construir es la mitad del trabajo. La otra mitad es **demostrar** que lo construido cumple lo que dices: una lista de comprobaciones objetivas, repetibles y, a ser posible, automáticas.

### La lista de verificación del proyecto

1. **Red**: VPC con dos subredes públicas y dos privadas en zonas distintas; las privadas **no** tienen ruta a un Internet Gateway.
2. **Grupos de seguridad**: nada abierto a `0.0.0.0/0` salvo el 80 del balanceador; el grupo web solo acepta tráfico del grupo del ALB.
3. **Cómputo**: instancias sin IP pública, con IMDSv2 obligatorio y un perfil de instancia.
4. **Balanceo**: ALB expuesto a internet en las subredes públicas, con todos los destinos `healthy`.
5. **Datos**: bucket con bloqueo público completo, SSE-KMS con CMK rotada, versionado y TLS obligatorio.
6. **Identidad**: el rol puede leer y escribir en *su* bucket y usar *su* clave; **no** puede borrar el bucket, tocar IAM ni leer otros buckets.
7. **Auditoría**: trail multirregión con validación, iniciado y entregando a un bucket privado.
8. **Alarmas**: cada servidor con su alarma de CPU conectada a un tema con suscriptor.

```bash
aws ec2 describe-security-groups --filters Name=vpc-id,Values=$VPC --query 'SecurityGroups[].[GroupName,IpPermissions[].[FromPort,IpRanges[].CidrIp,UserIdGroupPairs[].GroupId]]' --output json
aws elbv2 describe-target-health --target-group-arn $TG --query 'TargetHealthDescriptions[].TargetHealth.State'
aws s3api get-public-access-block --bucket tienda-datos-$ACC
aws cloudtrail get-trail-status --name tienda-trail --query IsLogging
```

### Repetirlo como código

Lo que acabas de hacer comando a comando es exactamente lo que **Terraform** describe de forma declarativa. El repositorio **aws-secure-infrastructure** contiene esa misma arquitectura (red por capas, cómputo, datos cifrados, auditoría) como módulos: `terraform plan` te enseña el coste y los cambios *antes* de aplicarlos, `terraform apply` los crea y `terraform destroy` los limpia.

Ventajas del código sobre la consola: **repetible** (mismo resultado en otra cuenta o región), **revisable** (pull requests), **auditable** (el historial de Git cuenta qué cambió y por qué) y **detectable la deriva** (`plan` marca lo que alguien cambió a mano).

```bash
cd aws-secure-infrastructure
terraform init
terraform plan -out tfplan
terraform apply tfplan
terraform destroy
```

### Cuánto cuesta y cómo limpiar

Los recursos de pago de esta arquitectura son el **ALB** (~16 USD/mes), las **instancias** (~8 USD/mes cada `t3.micro`) y la **clave KMS** (1 USD/mes). Todo lo demás es céntimos. Destruye al terminar el laboratorio: un ALB olvidado es la sorpresa más común de la factura.

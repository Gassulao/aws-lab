## Diseñar en capas: defensa en profundidad

Una arquitectura segura no es un servicio mágico: es **una cadena de capas**, de modo que si una falla, la siguiente contiene el daño. Este proyecto final reúne todo lo aprendido en una pequeña tienda web. Antes de teclear un comando, dibuja el mapa:

| Capa | Pregunta | Servicios del proyecto |
|---|---|---|
| Red | ¿Quién puede llegar a qué? | VPC, subredes públicas y privadas, tablas de rutas, grupos de seguridad |
| Cómputo | ¿Qué corre y con qué identidad? | EC2 sin IP pública, IMDSv2, perfil de instancia |
| Datos | ¿Está cifrado y protegido? | S3 con bloqueo de acceso público, KMS, versionado |
| Identidad | ¿Qué puede hacer cada pieza? | Roles de IAM con mínimo privilegio |
| Detección | ¿Nos enteramos si algo ocurre? | CloudTrail, CloudWatch, SNS |

### El plano de la tienda

- **Subredes públicas** (dos zonas): solo el **balanceador de carga** (ALB). Es lo único con presencia en internet.
- **Subredes privadas** (dos zonas): los servidores web, **sin IP pública**. Aceptan tráfico solo desde el grupo de seguridad del ALB.
- **Dos zonas de disponibilidad**: si cae una, la otra sigue sirviendo.
- **Cadena de grupos de seguridad**: `internet → alb-sg (80) → web-sg (80, origen alb-sg)`. El grupo web **no** menciona ninguna IP: se refiere al grupo del ALB.

```bash
VPC=$(aws ec2 create-vpc --cidr-block 10.50.0.0/16 --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=tienda}]' --query Vpc.VpcId --output text)
ALBSG=$(aws ec2 create-security-group --group-name alb-sg --description ALB --vpc-id $VPC --query GroupId --output text)
WEBSG=$(aws ec2 create-security-group --group-name web-sg --description Web --vpc-id $VPC --query GroupId --output text)
aws ec2 authorize-security-group-ingress --group-id $WEBSG --protocol tcp --port 80 --source-group $ALBSG
```

### Qué no hacer (errores que encontrarás en auditorías)

1. Poner los servidores en la subred pública «para probar» y dejarlos allí.
2. Abrir el puerto 22 a `0.0.0.0/0` en lugar de usar Session Manager.
3. Un único NAT, una única AZ o una única instancia: un fallo y se cae todo.
4. Claves de acceso largas en el servidor en lugar de un **rol de instancia**.

El pilar de seguridad del *Well-Architected Framework* resume estas prácticas: identidad sólida, trazabilidad, seguridad en todas las capas, automatizar lo básico, proteger los datos y prepararse para incidentes.

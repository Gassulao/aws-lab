## Elastic Load Balancing

Un **Application Load Balancer (ALB)** recibe tráfico HTTP/HTTPS y lo reparte entre los destinos sanos. Se compone de tres piezas:

1. **Balanceador**: vive en al menos **dos subredes de dos zonas de disponibilidad** distintas y tiene un nombre DNS propio.
2. **Oyente** (*listener*): puerto y protocolo (`HTTP:80`) y la acción por defecto, normalmente reenviar a un grupo de destino.
3. **Grupo de destino**: las instancias que reciben el tráfico y la **comprobación de estado** (ruta `/`, intervalo, umbrales).

```bash
aws elbv2 create-target-group --name web-tg --protocol HTTP --port 80 --vpc-id vpc-0abc
aws elbv2 register-targets --target-group-arn <arn> --targets Id=i-0aaa Id=i-0bbb
aws elbv2 create-load-balancer --name web-alb --subnets subnet-a subnet-b --security-groups sg-alb
aws elbv2 create-listener --load-balancer-arn <arn> --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=<arn>
aws elbv2 describe-target-health --target-group-arn <arn>
```

## La salud de un destino

`describe-target-health` devuelve el estado de cada destino: `initial`, `healthy`, `unhealthy` o `unused`, con un motivo:

- `Target.Timeout`: la petición no llega. Casi siempre es el **grupo de seguridad de la instancia**.
- `Target.FailedHealthChecks`: llega, pero la aplicación no responde con el código esperado (¿está el servidor instalado y arrancado?).
- `Target.NotInUse`: el grupo no está asociado a ningún oyente, o la zona de la instancia no está habilitada en el balanceador.
- `Target.InvalidState`: la instancia está parada o terminada.

## Seguridad en dos capas

La buena práctica es que el grupo de seguridad del **balanceador** acepte el puerto 80 desde Internet y el de las **instancias** lo acepte **solo desde el grupo de seguridad del balanceador**, no desde `0.0.0.0/0`:

```bash
aws ec2 authorize-security-group-ingress --group-id sg-app --protocol tcp --port 80 --source-group sg-alb
```

> **Para el examen (dominio 1 y 2):** el ALB es capa 7 (rutas, hosts) y el NLB capa 4 (rendimiento extremo, IP fija). Las instancias privadas detrás de un ALB reducen la superficie expuesta.

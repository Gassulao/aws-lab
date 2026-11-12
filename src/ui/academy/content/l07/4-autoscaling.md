## Auto Scaling

Un **grupo de Auto Scaling** mantiene el número de instancias que declaras. Se configura con:

- Una **plantilla de lanzamiento**: AMI, tipo de instancia, grupo de seguridad y datos de usuario.
- **Mínimo, deseado y máximo**. Si bajas el deseado, termina instancias; si lo subes, lanza nuevas.
- Las **subredes** (una por zona): el grupo reparte las instancias de forma equilibrada entre zonas.

```bash
aws ec2 create-launch-template --launch-template-name web-lt --launch-template-data '{"ImageId":"ami-0a1b2c3d4e5f60001","InstanceType":"t3.micro"}'
aws autoscaling create-auto-scaling-group --auto-scaling-group-name web-asg --launch-template LaunchTemplateName=web-lt,Version='$Latest' --min-size 2 --max-size 4 --vpc-zone-identifier subnet-a,subnet-b --target-group-arns <arn> --health-check-type ELB --health-check-grace-period 120
aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names web-asg
aws autoscaling set-desired-capacity --auto-scaling-group-name web-asg --desired-capacity 3
```

## Autorreparación

Si una instancia se termina o se detiene, el grupo la **sustituye** automáticamente y la registra en el grupo de destino. Con `--health-check-type ELB` también sustituye las que el balanceador marca como no sanas (tras el periodo de gracia, que da tiempo a que arranque la aplicación).

```bash
aws autoscaling describe-scaling-activities --auto-scaling-group-name web-asg
```

## Alta disponibilidad y coste

ALB + Auto Scaling en **dos zonas** sobrevive a la caída de una zona entera: el tráfico va a la otra y el grupo lanza capacidad para reponerse. El coste: pagas las instancias mínimas siempre y el ALB por hora (unos 16 USD al mes) más el tráfico procesado.

> **Para el examen (dominio 2 y 4):** diseña siempre en varias zonas; usa Auto Scaling para resiliencia y para ajustar el coste a la demanda (políticas de escalado por CPU o por peticiones por destino).

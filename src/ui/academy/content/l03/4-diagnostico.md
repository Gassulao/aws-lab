Cuando una instancia «no tiene internet» (o «no puedo conectar»), recorre el camino del paquete **en orden**, de dentro hacia fuera:

1. **La instancia:** ¿está `running`? ¿Tiene IP pública si sale por el IGW?
2. **Grupo de seguridad:** ¿permite el tráfico de salida (egress) y, para entrar, el puerto desde tu origen? Los SG son **con estado**: la respuesta vuelve sola.
3. **Tabla de rutas de la subred:** ¿tiene `0.0.0.0/0`? ¿A dónde apunta (IGW o NAT)? ¿Está **asociada** a esa subred?
4. **Puerta de enlace:** ¿el IGW está **adjunto** a la VPC? ¿El NAT está en una subred pública y `available`?
5. **NACL de la subred:** reglas numeradas, **sin estado** (hay que permitir ida y vuelta).

```bash
aws ec2 describe-instances --query 'Reservations[].Instances[].[InstanceId,State.Name,SubnetId,PublicIpAddress,SecurityGroups[].GroupId]' --output text
aws ec2 describe-route-tables --query 'RouteTables[].[RouteTableId,Associations[].SubnetId,Routes[].[DestinationCidrBlock,GatewayId,NatGatewayId]]'
aws ec2 describe-security-groups --query 'SecurityGroups[].[GroupId,GroupName,IpPermissionsEgress]'
```

## SG frente a NACL

| | Security Group | Network ACL |
|---|---|---|
| Nivel | Instancia (interfaz) | Subred |
| Estado | Con estado | Sin estado |
| Reglas | Solo *allow* | *allow* y *deny*, por orden de número |

> **Para el examen:** bloquear una IP concreta = NACL (los SG no pueden denegar). Permitir solo tráfico entre capas = SG que referencia a otro SG.

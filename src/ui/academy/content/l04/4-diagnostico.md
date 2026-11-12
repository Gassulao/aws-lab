«No puedo entrar por SSH» es el problema más frecuente de EC2. Sigue siempre la misma lista, de fuera hacia dentro:

1. **¿La instancia está `running`?** Una parada implica que la IP pública automática **cambia** al volver a arrancar.
2. **¿Tiene IP pública** (o Elastic IP) y está en una subred **pública** (ruta `0.0.0.0/0` al IGW)?
3. **¿El grupo de seguridad** permite TCP/22 **desde tu IP**? Tu IP pública cambia con tu proveedor: compruébala.
4. **¿La NACL de la subred** permite entrada y la salida de los puertos efímeros?
5. **¿La clave** corresponde al par de claves de la instancia y el **usuario** es el de la AMI (`ec2-user` en Amazon Linux, `ubuntu` en Ubuntu)?

```bash
aws ec2 describe-instances --query 'Reservations[].Instances[].[InstanceId,State.Name,PublicIpAddress,KeyName,SecurityGroups[].GroupId]' --output text
aws ec2 describe-security-groups --query 'SecurityGroups[].[GroupId,GroupName,IpPermissions]'
```

El error de SSH ya orienta:

| Síntoma | Causa probable |
|---|---|
| `Connection timed out` | SG/NACL/ruta/IP pública: el paquete no llega |
| `Connection refused` | Llega, pero no hay servicio SSH escuchando |
| `Permission denied (publickey)` | Llega, pero la clave o el usuario son incorrectos |

> **Un timeout casi siempre es red; un "permission denied" casi siempre es credencial.** Y la solución moderna es no depender de SSH: **Systems Manager Session Manager** con un rol de instancia, sin puertos abiertos.

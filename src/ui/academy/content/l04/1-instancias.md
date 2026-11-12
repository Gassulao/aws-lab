Una **instancia EC2** es una máquina virtual. Para lanzarla eliges:

- **AMI:** la imagen del sistema operativo (Amazon Linux 2023, Ubuntu, Windows...).
- **Tipo de instancia:** familia y tamaño, p. ej. `t3.micro`. La letra indica el perfil: `t` (uso general con ráfagas), `m` (equilibrada), `c` (cómputo), `r` (memoria).
- **Red:** VPC, subred (y por tanto AZ), grupos de seguridad, ¿IP pública?
- **Almacenamiento:** volumen raíz **EBS** (gp3 por defecto).
- **Acceso:** par de claves para SSH y, mejor aún, un **perfil de instancia** (rol de IAM).

```bash
aws ec2 describe-images --query 'Images[].[ImageId,Name]' --output text
aws ec2 run-instances --image-id ami-0a1b2c3d4e5f60001 --instance-type t3.micro --count 1
```

## Estados

`pending` → `running` → `stopping` → `stopped` → (de nuevo `pending`) …  y al final `shutting-down` → `terminated`. Los datos de un volumen EBS sobreviven a un `stop`, pero al **terminar** la instancia se borra el volumen raíz (por defecto).

## Tipos de EBS y rendimiento

| Volumen | Uso |
|---|---|
| **gp3** | Propósito general SSD, rendimiento ajustable: la opción por defecto |
| **io2** | Alto IOPS sostenido (bases de datos críticas) |
| **st1 / sc1** | HDD baratos para flujos secuenciales y archivo |

> **Para el examen (dominio 3):** cargas con latencia crítica → io2 o instancias optimizadas para almacenamiento; Instance Store es muy rápido pero **efímero**.

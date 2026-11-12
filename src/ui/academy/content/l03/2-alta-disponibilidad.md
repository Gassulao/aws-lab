Una zona de disponibilidad es uno o más centros de datos con energía y red independientes. Para tolerar la caída de una AZ, la arquitectura debe repartirse en **al menos dos**.

## Patrón de dos niveles en dos AZ

| Nivel | Subred | Qué vive aquí |
|---|---|---|
| **Público** | `10.30.1.0/24` (AZ a), `10.30.2.0/24` (AZ b) | Balanceador de carga, NAT Gateway, bastión |
| **Privado** | `10.30.11.0/24` (AZ a), `10.30.12.0/24` (AZ b) | Aplicaciones y bases de datos |

Los usuarios solo llegan al balanceador (público); las aplicaciones y las bases de datos no son alcanzables desde internet. Es exactamente la forma de la VPC segura de **aws-secure-infrastructure**.

```bash
aws ec2 create-subnet --vpc-id <vpc-id> --cidr-block 10.30.1.0/24 --availability-zone eu-west-1a
aws ec2 create-subnet --vpc-id <vpc-id> --cidr-block 10.30.2.0/24 --availability-zone eu-west-1b
```

Para que las instancias de una subred pública reciban IP pública automáticamente:

```bash
aws ec2 modify-subnet-attribute --subnet-id <subnet-id> --map-public-ip-on-launch
```

> **Para el examen (dominio 2):** un único punto de fallo por AZ rompe la alta disponibilidad. Los recursos de un grupo de Auto Scaling y un balanceador deben abarcar varias subredes en AZ distintas.

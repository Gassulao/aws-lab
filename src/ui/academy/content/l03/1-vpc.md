Una **VPC** es tu red privada virtual dentro de una región. Eliges su rango de direcciones (CIDR, por ejemplo `10.20.0.0/16`) y la divides en **subredes**, cada una dentro de una única zona de disponibilidad (AZ).

```bash
aws ec2 create-vpc --cidr-block 10.20.0.0/16
```

- En cada subred AWS **reserva 5 direcciones** (red, router, DNS, futuro y difusión). Por eso la subred más pequeña posible es `/28` (16 − 5 = 11 útiles) y una `/24` ofrece 251.
- Los rangos de subredes de una misma VPC **no pueden solaparse** y deben caber dentro del CIDR de la VPC.
- Para poder conectar redes más adelante (peering, VPN), evita solapar CIDR con otras VPC u oficinas.

## ¿Qué hace pública a una subred?

Una subred es **pública** cuando su tabla de rutas tiene una ruta `0.0.0.0/0` hacia un **Internet Gateway** (IGW). Nada más: no existe un interruptor «pública» en la subred. Además la instancia necesita una **IP pública** (o Elastic IP) para ser alcanzable.

Una subred **privada** no tiene esa ruta.

Receta de una subred pública:

```bash
aws ec2 create-internet-gateway --query InternetGateway.InternetGatewayId --output text
aws ec2 describe-route-tables --query 'RouteTables[].[RouteTableId,VpcId,Routes[].DestinationCidrBlock]' --output text
```

1. Crear el IGW y **adjuntarlo** a la VPC.
2. Crear una tabla de rutas con `0.0.0.0/0 → igw-…`.
3. **Asociarla** a la subred.

> Una subred sin asociación explícita usa la **tabla de rutas principal** de la VPC (que solo tiene la ruta local).

Las instancias de una subred privada no tienen IP pública, pero a menudo necesitan **salir** a internet (actualizaciones, APIs externas) sin que nadie pueda **entrar**. Eso lo resuelve el **NAT Gateway**:

- Vive en una subred **pública** y usa una **IP elástica**.
- La tabla de rutas de la subred privada apunta `0.0.0.0/0 → nat-…`.
- Permite tráfico iniciado desde dentro; rechaza conexiones iniciadas desde fuera.

```bash
aws ec2 allocate-address --query AllocationId --output text
aws ec2 create-nat-gateway --subnet-id <subred-publica> --allocation-id <eipalloc-…>
```

## Coste y resiliencia

- Se factura **por hora** (unos 0,048 USD/h, ≈ 35 USD al mes) **más** por GB procesado, aunque no lo uses. Bórralo al terminar el laboratorio.
- Un NAT Gateway es **zonal**: para tolerar la caída de una AZ se crea **uno por AZ**, cada subred privada enruta a su NAT. Con un solo NAT ahorras, pero pierdes la salida de las demás AZ si la suya cae.
- Si solo hablas con S3 o DynamoDB, un **Gateway VPC Endpoint** es **gratis** y evita el NAT para ese tráfico (dominio 4, optimización de costes).

```bash
aws ec2 describe-nat-gateways
```

> Una trampa clásica: crear el NAT en una subred **privada**. No tendrá salida y las instancias seguirán sin internet.

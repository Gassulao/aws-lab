## Route 53 y el DNS

El DNS traduce nombres (`www.tienda.com`) en direcciones IP. En Route 53 organizas los nombres en **zonas alojadas**: una zona **pública** responde a todo Internet y una **privada** solo dentro de las VPC que le asocies.

Cada zona nace con dos registros que no debes borrar: **NS** (los cuatro servidores de nombres de AWS) y **SOA**. Para que el dominio funcione, el registrador debe apuntar a esos servidores NS.

```bash
aws route53 create-hosted-zone --name tienda.com --caller-reference alta-1
aws route53 list-hosted-zones
```

## Registros

Los cambios se envían en lotes con `change-resource-record-sets`; cada cambio es `CREATE`, `DELETE` o `UPSERT` (crea o reemplaza):

```bash
aws route53 change-resource-record-sets --hosted-zone-id Z123 --change-batch '{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{"Name":"www.tienda.com","Type":"A","TTL":300,"ResourceRecords":[{"Value":"203.0.113.10"}]}}]}'
```

- **A / AAAA**: nombre a IPv4 / IPv6. **CNAME**: nombre a otro nombre (no puede estar en el apex ni convivir con otros tipos). **MX, TXT, NS**: correo, texto y delegación.
- **TTL**: cuántos segundos cachean la respuesta los resolvedores. Un TTL bajo permite cambiar rápido, pero genera más consultas.
- Un **alias** apunta a un recurso de AWS (balanceador, CloudFront, bucket web) y, a diferencia del CNAME, **sí puede usarse en el apex** y no se factura por consulta.

## Comprobar con dig

```bash
dig +short www.tienda.com
dig www.tienda.com A
nslookup www.tienda.com
aws route53 test-dns-answer --hosted-zone-id Z123 --record-name www.tienda.com --record-type A
```

`NXDOMAIN` significa que el nombre no existe; `NOERROR` sin respuestas, que existe pero no con ese tipo de registro.

> **Para el examen (dominio 2):** Route 53 es un servicio global y de alta disponibilidad (SLA del 100 %). Prefiere alias frente a CNAME cuando el destino sea un recurso de AWS.

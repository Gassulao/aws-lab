## CloudWatch: métricas

Una **métrica** es una serie de puntos de datos ordenados en el tiempo, identificada por **espacio de nombres**, **nombre** y **dimensiones**. AWS publica las suyas (`AWS/EC2`, `AWS/S3`…) y tú puedes publicar las tuyas con un espacio de nombres propio.

- **EC2** envía por defecto métricas cada **5 minutos** (monitoreo básico, gratis) o cada 1 minuto con monitoreo detallado (de pago).
- La **memoria** y el **espacio en disco** no son métricas por defecto: necesitas el *agente de CloudWatch*.

```bash
aws cloudwatch put-metric-data --namespace Tienda --metric-name Pedidos --value 4 --unit Count --dimensions Name=Entorno,Value=prod
aws cloudwatch list-metrics --namespace Tienda
```

## Consultar estadísticas

`get-metric-statistics` agrupa los puntos en periodos (múltiplos de 60 s) y calcula `Average`, `Sum`, `Minimum`, `Maximum` o `SampleCount`.

```bash
aws cloudwatch get-metric-statistics --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value=i-0123456789abcdef0 --start-time $(date -u -d '-1 hour' +%FT%TZ) --end-time $(date -u +%FT%TZ) --period 300 --statistics Average
```

> **En el simulador:** las métricas de EC2 son sintéticas y deterministas, y solo existen mientras la instancia corre. Con la etiqueta `simulador:carga=alta` la CPU supera el 80 %.

> **Para el examen (dominio 3):** CPU, red y disco los ve CloudWatch sin agente; memoria y espacio en disco requieren el agente.

## CloudWatch, CloudTrail y Config: ¿cuál uso?

- **CloudWatch**: *¿cómo se comporta mi sistema?* Métricas, registros y alarmas.
- **CloudTrail**: *¿quién hizo qué en mi cuenta?* Llamadas a la API.
- **AWS Config**: *¿cómo estaba configurado y cuándo cambió?*

## Diagnosticar «Datos insuficientes»

Una alarma en `INSUFFICIENT_DATA` rara vez es un fallo de la alarma. Revisa en este orden:

1. `describe-alarms`: el campo `StateReason` y la dimensión (¿es el ID de instancia correcto?).
2. ¿Existen datos? `get-metric-statistics` sobre el mismo intervalo.
3. ¿Está parado el recurso (instancia detenida, aplicación que no publica)?
4. ¿Debe tratarse la ausencia de datos como normal? Cambia `--treat-missing-data`.

```bash
aws cloudwatch describe-alarms --alarm-names cpu-alta --query 'MetricAlarms[].[StateValue,StateReason]' --output text
aws cloudwatch describe-alarm-history --alarm-name cpu-alta
```

> **Para el examen (dominio 2):** monitoriza siempre la salud de la aplicación (alarmas sobre métricas de negocio y de infraestructura) y automatiza la respuesta con acciones.

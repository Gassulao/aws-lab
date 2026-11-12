## Alarmas

Una **alarma** vigila una métrica y tiene tres estados:

- `OK`: la métrica está dentro del umbral.
- `ALARM`: se ha incumplido el umbral en suficientes puntos de datos.
- `INSUFFICIENT_DATA`: faltan datos (recién creada, la métrica no se publica, la instancia está parada…).

```bash
aws cloudwatch put-metric-alarm --alarm-name cpu-alta --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value=i-0123456789abcdef0 --statistic Average --period 300 --evaluation-periods 1 --threshold 80 --comparison-operator GreaterThanThreshold
```

## Acciones y SNS

Cada cambio de estado puede ejecutar **acciones**: publicar en un tema de **SNS** (correo, SMS, Lambda…), reiniciar o recuperar una instancia EC2, o escalar un Auto Scaling Group.

```bash
aws sns create-topic --name alertas-ops
aws sns subscribe --topic-arn arn:aws:sns:eu-west-1:<cuenta>:alertas-ops --protocol email --notification-endpoint ops@example.com
```

Las suscripciones de correo quedan **pendientes de confirmación** hasta que el destinatario pulsa el enlace.

## Datos faltantes

`--treat-missing-data` decide qué hacer sin datos: `missing` (por defecto, puede dejar la alarma en `INSUFFICIENT_DATA`), `notBreaching`, `breaching` o `ignore`. Para métricas que solo se publican cuando hay un evento (como errores), `notBreaching` evita falsas alertas.

> **Para el examen (dominio 2):** alarma → SNS → equipo es la forma estándar de alertar; `describe-alarm-history` te dice cuándo y por qué cambió.

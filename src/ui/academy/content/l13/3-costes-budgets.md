## Costes: ver, limitar y reducir lo que gastas

El coste es el cuarto pilar del examen y un asunto de ingeniería diario. Tres herramientas, tres preguntas:

| Herramienta | Pregunta que responde |
|---|---|
| **Cost Explorer** (`ce`) | ¿En qué se ha ido el dinero, por servicio, cuenta o etiqueta? |
| **AWS Budgets** | ¿Me avisa alguien antes de pasarme del presupuesto? |
| **Cost and Usage Report** | Todo el detalle línea a línea, en S3, para analizarlo con Athena |

### Cost Explorer desde la CLI

```bash
aws ce get-cost-and-usage --time-period Start=2026-11-01,End=2026-11-12 --granularity DAILY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE
aws ce get-cost-and-usage --time-period Start=2026-11-01,End=2026-12-01 --granularity MONTHLY --metrics UnblendedCost UsageQuantity
aws ce get-cost-forecast --time-period Start=2026-11-12,End=2026-12-01 --metric UNBLENDED_COST --granularity MONTHLY
```

El intervalo `End` es **exclusivo**. Con `--group-by` obtienes un grupo por servicio; sin él, un total. Cost Explorer solo ve lo que **está etiquetado** si agrupas por etiqueta: por eso hay que activar las **etiquetas de asignación de costes** (`Proyecto`, `Entorno`, `Equipo`) y etiquetar todo.

### Presupuestos con avisos

Un presupuesto tiene un importe y una o varias **notificaciones**: umbral sobre el gasto **real** (`ACTUAL`) o **previsto** (`FORECASTED`), expresado en porcentaje o en dólares, con suscriptores de **correo** o **SNS**. El aviso previsto es el más útil: te alerta *antes* de superar el límite.

```bash
ACC=$(aws sts get-caller-identity --query Account --output text)
aws budgets create-budget --account-id $ACC --budget '{"BudgetName":"mensual","BudgetLimit":{"Amount":"20","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' --notifications-with-subscribers '[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80,"ThresholdType":"PERCENTAGE"},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"yo@example.com"}]}]'
aws budgets describe-budgets --account-id $ACC
```

Un presupuesto **avisa, no frena**: no apaga nada. Para actuar automáticamente se usan *budget actions* (aplicar una SCP o una política IAM, parar instancias) o una función Lambda enganchada a SNS.

### Reducir la factura: qué elegir

- **Dimensionar bien** (*right-sizing*): cambiar `m5.xlarge` por `m5.large` si la CPU nunca pasa del 20 %.
- **Savings Plans** y **Reserved Instances**: compromiso de 1 o 3 años a cambio de hasta ~70 % de descuento en cargas estables.
- **Spot**: hasta ~90 % más barato, para trabajos tolerantes a interrupciones.
- **Apagar lo que no se usa**: entornos de desarrollo fuera de horario, NAT Gateways y balanceadores olvidados, EIP sin asociar, volúmenes EBS sin adjuntar.
- **S3**: ciclos de vida hacia clases más baratas (Standard-IA, Glacier) y Intelligent-Tiering para accesos impredecibles.

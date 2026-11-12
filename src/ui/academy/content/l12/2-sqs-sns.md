## Mensajería: SQS, SNS y desacoplamiento

**Amazon SQS** es una cola administrada: los productores envían mensajes y los consumidores los leen cuando pueden. Así los componentes se **desacoplan**: si el consumidor cae o va lento, los mensajes esperan en la cola (hasta 14 días de retención) en lugar de perderse.

```bash
aws sqs create-queue --queue-name pedidos
Q=$(aws sqs get-queue-url --queue-name pedidos --query QueueUrl --output text)
aws sqs send-message --queue-url $Q --message-body '{"id":"1001","total":25}'
aws sqs receive-message --queue-url $Q
aws sqs delete-message --queue-url $Q --receipt-handle '<ReceiptHandle>'
```

### Visibilidad: el corazón de SQS

Al **recibir** un mensaje no se borra: queda **invisible** durante el *visibility timeout* (30 s por defecto). El consumidor debe **borrarlo** con su `ReceiptHandle` cuando termine. Si no lo hace (falló o tardó demasiado), el mensaje reaparece y se entrega otra vez: SQS estándar garantiza entrega **al menos una vez**, así que tu consumidor debe ser **idempotente**.

### Cola de mensajes fallidos (DLQ)

Un mensaje «venenoso» que falla siempre se reintentaría eternamente. Con una **política de redirección** (`RedrivePolicy`) y `maxReceiveCount`, SQS lo mueve a una **DLQ** tras N recepciones fallidas, donde puedes inspeccionarlo sin bloquear la cola principal.

```bash
aws sqs create-queue --queue-name pedidos-dlq
DLQ_ARN=$(aws sqs get-queue-attributes --queue-url $DLQ --attribute-names QueueArn --query Attributes.QueueArn --output text)
aws sqs set-queue-attributes --queue-url $Q --attributes '{"RedrivePolicy":"{\"deadLetterTargetArn\":\"'$DLQ_ARN'\",\"maxReceiveCount\":\"3\"}"}'
```

### Estándar o FIFO

| | Estándar | FIFO |
|---|---|---|
| Orden | Aproximado | Estricto por `MessageGroupId` |
| Entrega | Al menos una vez | Exactamente una vez (deduplicación 5 min) |
| Nombre | Libre | Termina en `.fifo` |
| Rendimiento | Casi ilimitado | Más limitado |

### Lambda como consumidor

Un **event source mapping** hace que Lambda sondee la cola por ti y te entregue lotes de mensajes (`--batch-size`). Si la función termina bien, Lambda borra el lote; si falla, los mensajes vuelven a ser visibles y, tras `maxReceiveCount`, van a la DLQ. El rol de la función necesita `sqs:ReceiveMessage`, `sqs:DeleteMessage` y `sqs:GetQueueAttributes` (política `AWSLambdaSQSQueueExecutionRole`), y el *visibility timeout* de la cola debe ser **mayor o igual** que el tiempo de espera de la función.

```bash
aws lambda create-event-source-mapping --function-name procesador --event-source-arn $QARN --batch-size 5
```

### SNS: publicar y repartir (fan-out)

**SNS** distribuye un mensaje a muchos suscriptores (colas SQS, funciones Lambda, correo, HTTP). Patrón clásico: un tema SNS con varias colas SQS suscritas, cada una procesada por un equipo distinto. Para entregar a una cola, **la política de la cola** debe permitir a `sns.amazonaws.com` hacer `sqs:SendMessage` con `aws:SourceArn` igual al ARN del tema; para Lambda, `add-permission` con principal `sns.amazonaws.com`. Sin eso la suscripción existe pero **no llega nada**.

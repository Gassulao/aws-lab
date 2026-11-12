## Observabilidad y auditoría: enterarte antes que el cliente

Una arquitectura segura **se vigila**. Tres preguntas, tres servicios:

- **CloudTrail**: *¿quién hizo qué?* Registra las llamadas a la API de la cuenta.
- **CloudWatch**: *¿cómo está el sistema?* Métricas, alarmas y registros.
- **SNS**: *¿a quién aviso?* Entrega los avisos por correo u otros canales.

### CloudTrail bien configurado

Un buen *trail* de auditoría es **multirregión** (un atacante puede actuar en una región que nadie mira), con **validación de integridad de ficheros** (detecta si alguien manipula los registros) y entrega a un **bucket propio, privado y con bloqueo de acceso público**. El bucket debe permitir a `cloudtrail.amazonaws.com` leer su ACL y escribir objetos:

```bash
aws s3api put-bucket-policy --bucket $L --policy '{"Version":"2012-10-17","Statement":[
 {"Sid":"Acl","Effect":"Allow","Principal":{"Service":"cloudtrail.amazonaws.com"},"Action":"s3:GetBucketAcl","Resource":"arn:aws:s3:::'$L'"},
 {"Sid":"Escritura","Effect":"Allow","Principal":{"Service":"cloudtrail.amazonaws.com"},"Action":"s3:PutObject","Resource":"arn:aws:s3:::'$L'/AWSLogs/*","Condition":{"StringEquals":{"s3:x-amz-acl":"bucket-owner-full-control"}}}]}'
aws cloudtrail create-trail --name tienda-trail --s3-bucket-name $L --is-multi-region-trail --enable-log-file-validation
aws cloudtrail start-logging --name tienda-trail
```

Crear el trail **no** basta: hay que iniciarlo (`start-logging`). Es un clásico: un trail creado y detenido no registra nada.

### Alarmas que importan

No alarmes todo: alarma lo que requiere **acción humana**. En la tienda: CPU sostenida alta de cada servidor y ningún destino sano en el balanceador. Cada alarma debe tener una **acción** (un tema de SNS con al menos un suscriptor confirmado), o el aviso nunca llegará a nadie.

```bash
TOPIC=$(aws sns create-topic --name alertas-seguridad --query TopicArn --output text)
aws sns subscribe --topic-arn $TOPIC --protocol email --notification-endpoint ops@example.com
aws cloudwatch put-metric-alarm --alarm-name cpu-web-1 --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value=$W1 --statistic Average --period 300 --evaluation-periods 1 --threshold 80 --comparison-operator GreaterThanThreshold --alarm-actions $TOPIC
```

### Cómo reaccionar

Cuando suena una alarma: **1)** mira la métrica, **2)** consulta CloudTrail por cambios recientes, **3)** contén (aísla la instancia con un grupo de seguridad sin reglas, revoca credenciales), **4)** corrige la causa y **5)** documenta. Sin esos registros, el análisis forense es imposible.

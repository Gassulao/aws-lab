## AWS Config: qué ha cambiado y si cumple las reglas

**CloudTrail** responde a «¿quién llamó a qué API?». **AWS Config** responde a otra pregunta: «¿cómo está configurado ahora cada recurso, cómo estaba antes y cumple mis reglas?». Config guarda el **historial de configuración** de los recursos (grupos de seguridad, buckets, volúmenes, usuarios IAM…) y evalúa **reglas** sobre ellos.

Piezas que debes conocer:

- **Grabador de configuración** (*configuration recorder*): decide qué tipos de recursos se registran. Necesita un rol de IAM (normalmente el rol vinculado al servicio `AWSServiceRoleForConfig`).
- **Canal de entrega** (*delivery channel*): el bucket de S3 (y opcionalmente un tema de SNS) donde se guardan instantáneas e historial.
- **Reglas**: *gestionadas por AWS* (más de 300 listas para usar) o personalizadas con Lambda. Cada regla evalúa cada recurso como `COMPLIANT` o `NON_COMPLIANT`.
- **Paquetes de conformidad** (*conformance packs*): conjuntos de reglas y remediaciones que se despliegan juntos (por ejemplo, CIS o PCI).
- **Agregador**: reúne la conformidad de varias cuentas y regiones en una sola vista.

```bash
ACC=$(aws sts get-caller-identity --query Account --output text)
aws configservice put-configuration-recorder --configuration-recorder name=default,roleARN=arn:aws:iam::$ACC:role/aws-service-role/config.amazonaws.com/AWSServiceRoleForConfig --recording-group allSupported=true,includeGlobalResourceTypes=true
aws configservice put-delivery-channel --delivery-channel name=default,s3BucketName=mi-bucket-config
aws configservice start-configuration-recorder --configuration-recorder-name default
```

Una regla gestionada se crea indicando su identificador de origen. Muchas aceptan parámetros dentro de `InputParameters`:

```bash
cat > regla.json <<'JSON'
{"ConfigRuleName":"s3-bucket-public-read-prohibited","Source":{"Owner":"AWS","SourceIdentifier":"S3_BUCKET_PUBLIC_READ_PROHIBITED"}}
JSON
aws configservice put-config-rule --config-rule file://regla.json
aws configservice describe-compliance-by-config-rule --compliance-types NON_COMPLIANT
aws configservice get-compliance-details-by-config-rule --config-rule-name s3-bucket-public-read-prohibited --compliance-types NON_COMPLIANT
```

### Detectar no es corregir

Config **detecta** la desviación; no la arregla por sí sola. Para corregirla se usan **acciones de remediación** (documentos de Systems Manager Automation, de modo manual o automático) o una regla de **EventBridge** que reaccione al cambio de conformidad. Si el grabador está detenido, las reglas pasan a `INSUFFICIENT_DATA`: sin registro no hay evaluación.

Regla práctica: CloudTrail para la **auditoría de acciones**, Config para el **estado y la conformidad**, CloudWatch para las **métricas y alarmas**. Una arquitectura segura usa los tres.

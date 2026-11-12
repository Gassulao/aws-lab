## API Gateway y DynamoDB: una API sin servidores

**Amazon API Gateway** es la puerta HTTP de tu backend. Hay dos familias:

- **API HTTP** (`apigatewayv2`): simple, rápida y más barata. Rutas como `GET /pedidos`, integración `AWS_PROXY` con Lambda y la etapa `$default` con implementación automática.
- **API REST** (`apigateway`): más funciones (claves de API, planes de uso, validación, plantillas de mapeo). Se construye con recursos, métodos e integraciones y hay que **implementar** (`create-deployment`) en una **etapa** (`prod`) para que sea accesible.

```bash
FN=$(aws lambda get-function --function-name hola-api --query Configuration.FunctionArn --output text)
API=$(aws apigatewayv2 create-api --name tienda-api --protocol-type HTTP --target $FN --query ApiId --output text)
curl -s https://$API.execute-api.eu-west-1.amazonaws.com/hola
```

### El permiso que siempre se olvida

API Gateway invoca la función con **su propia identidad** (`apigateway.amazonaws.com`), así que Lambda necesita una política basada en recursos que lo permita. Sin ella la API responde **500 Internal Server Error** aunque todo lo demás esté bien:

```bash
aws lambda add-permission --function-name hola-api --statement-id apigw --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:eu-west-1:<cuenta>:$API/*/*"
```

Los códigos típicos: `403 Forbidden` (la ruta o etapa no existe), `404` (sin ruta que coincida), `500` (error de configuración o permiso), `502 Bad Gateway` (la función devolvió algo que no es una respuesta válida) y `504` (la función superó el límite de 29-30 s).

### Amazon DynamoDB

Base de datos NoSQL sin servidor con latencia de milisegundos. Cada tabla tiene una **clave de partición** (`HASH`) y, opcionalmente, una **clave de ordenación** (`RANGE`). Los datos se acceden **por clave**: `get-item` y `query` son eficientes; `scan` recorre toda la tabla y es caro.

```bash
aws dynamodb create-table --table-name pedidos --attribute-definitions AttributeName=cliente,AttributeType=S AttributeName=pedido,AttributeType=S --key-schema AttributeName=cliente,KeyType=HASH AttributeName=pedido,KeyType=RANGE --billing-mode PAY_PER_REQUEST
aws dynamodb wait table-exists --table-name pedidos
aws dynamodb put-item --table-name pedidos --item '{"cliente":{"S":"ana"},"pedido":{"S":"p-001"},"total":{"N":"25"}}'
aws dynamodb query --table-name pedidos --key-condition-expression "cliente = :c" --expression-attribute-values '{":c":{"S":"ana"}}'
```

- **Modos de capacidad**: *bajo demanda* (`PAY_PER_REQUEST`, pagas por petición) o *aprovisionada* (RCU/WCU fijas, más barata con tráfico estable).
- **Escrituras condicionales**: `--condition-expression "attribute_not_exists(pedido)"` evita sobrescribir; si la condición falla recibes `ConditionalCheckFailedException`. Es la base de la idempotencia.
- **Índices secundarios globales** permiten consultar por otro atributo.
- Los valores llevan tipo: `{"S":"texto"}`, `{"N":"25"}` (los números viajan como texto), `{"BOOL":true}`.

> Arquitectura clásica: **API Gateway → Lambda → DynamoDB**. Nada que parchear, escala solo y se paga por uso.

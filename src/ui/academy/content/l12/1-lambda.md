## AWS Lambda: código sin servidores

**Lambda** ejecuta tu código en respuesta a eventos sin que aprovisiones ni parchees servidores. Subes una **función** (un paquete `.zip` con tu código), eliges un **tiempo de ejecución** (`nodejs20.x`...), un **controlador** (`index.handler` = archivo `index.js`, función `handler`) y un **rol de ejecución**. Pagas por invocación y por milisegundo de ejecución (tiempo × memoria).

```bash
mkdir -p saludo && cd saludo
printf 'exports.handler = async (event) => {\n  console.log("evento:", JSON.stringify(event));\n  return { mensaje: "Hola " + event.nombre };\n};\n' > index.js
zip function.zip index.js
aws lambda create-function --function-name saludo --runtime nodejs20.x --handler index.handler --role arn:aws:iam::<cuenta>:role/lambda-basico --zip-file fileb://function.zip
aws lambda wait function-active-v2 --function-name saludo
aws lambda invoke --function-name saludo --cli-binary-format raw-in-base64-out --payload '{"nombre":"Ana"}' respuesta.json
cat respuesta.json
```

> Una función recién creada está en estado `Pending` unos segundos: por eso existe `aws lambda wait function-active-v2`.

### Dos roles distintos

- **Rol de ejecución** (*execution role*): lo asume Lambda **mientras corre tu código**. Debe confiar en `lambda.amazonaws.com` y llevar los permisos que necesita la función (escribir logs, leer una cola, escribir en DynamoDB...). La política administrada `AWSLambdaBasicExecutionRole` solo da permisos para crear el grupo `/aws/lambda/<función>` y escribir logs.
- **Política basada en recursos** (`aws lambda add-permission`): dice **quién puede invocar** la función (API Gateway, SNS, S3, otra cuenta...).

Si el rol no tiene permisos de logs la función funciona, pero **no deja ningún registro**: es un fallo clásico de diagnóstico.

### Límites y comportamiento

- **Tiempo de espera** (`--timeout`): de 1 a 900 s; por defecto 3 s. Si se supera, la invocación termina con `Task timed out after N seconds`.
- **Memoria** (`--memory-size`): de 128 MB a 10 GB. La CPU crece con la memoria.
- **Variables de entorno** (`--environment Variables={CLAVE=valor}`): configuración sin tocar el código. No guardes secretos en ellas: usa Secrets Manager o Parameter Store.
- **Arranque en frío**: la primera invocación (o tras un tiempo de inactividad) inicializa un entorno nuevo y es más lenta. Los logs lo muestran como `Init Duration` en la línea `REPORT`.
- **Concurrencia reservada**: `put-function-concurrency` limita (o garantiza) cuántas ejecuciones simultáneas puede tener la función. Con `0` la función queda bloqueada y las invocaciones fallan con `TooManyRequestsException`.

### Versiones y alias

`$LATEST` es la copia editable. `publish-version` crea una **versión inmutable** (1, 2, 3...). Un **alias** (`prod`, `beta`) es un puntero con nombre a una versión que puedes mover sin cambiar a quienes lo llaman; también permite repartir tráfico (`--routing-config AdditionalVersionWeights={"2"=0.1}` envía el 10 % a la versión 2).

```bash
aws lambda publish-version --function-name saludo --description "primera"
aws lambda create-alias --function-name saludo --name prod --function-version 1
aws lambda update-alias --function-name saludo --name prod --function-version 2
aws lambda invoke --function-name saludo:prod --cli-binary-format raw-in-base64-out --payload '{"nombre":"Ana"}' out.json
```

> En este simulador el código se interpreta con un subconjunto de JavaScript (funciones, `async/await`, objetos, arrays, plantillas, `try/catch`, `require` de tus archivos y de los clientes `@aws-sdk/client-dynamodb`, `client-sqs`, `client-sns` y `client-lambda`). Los comandos, errores y registros son los reales.

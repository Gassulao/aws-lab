## CloudWatch Logs

Los registros se organizan en **grupos** (una aplicación o servicio, con su retención) y **flujos** (una fuente concreta, por ejemplo una instancia). Cada evento tiene marca de tiempo y mensaje.

```bash
aws logs create-log-group --log-group-name /tienda/api
aws logs create-log-stream --log-group-name /tienda/api --log-stream-name i-001
aws logs put-log-events --log-group-name /tienda/api --log-stream-name i-001 --log-events timestamp=$(date +%s%3N),message="ERROR no se pudo conectar"
```

## Retención y coste

Por defecto los registros **nunca caducan** y se cobra por almacenamiento. Fija una retención acorde con tus necesidades.

```bash
aws logs put-retention-policy --log-group-name /tienda/api --retention-in-days 14
```

## Buscar y convertir registros en métricas

Un **patrón de filtro** busca términos (`ERROR`), alternativas (`?ERROR ?WARN`), exclusiones (`-DEBUG`) o campos JSON (`{ $.status = 500 }`). Un **filtro de métrica** cuenta las coincidencias y las publica como métrica, sobre la que puedes crear una alarma.

```bash
aws logs filter-log-events --log-group-name /tienda/api --filter-pattern ERROR
aws logs put-metric-filter --log-group-name /tienda/api --filter-name errores --filter-pattern ERROR --metric-transformations metricName=ErroresApi,metricNamespace=Tienda,metricValue=1
```

> **Para el examen (dominio 4):** fija siempre una retención; y para exportar a largo plazo y bajo coste, envía los registros a S3.

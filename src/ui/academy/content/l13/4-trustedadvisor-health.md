## Trusted Advisor y AWS Health: alguien que mira por ti

**Trusted Advisor** inspecciona tu cuenta y la compara con las buenas prácticas de AWS en cinco categorías: **seguridad**, **optimización de costes**, **tolerancia a errores**, **rendimiento** y **límites de servicio**. Cada comprobación termina en un semáforo:

- **Verde** (`ok`): sin problemas.
- **Amarillo** (`warning`): conviene investigar.
- **Rojo** (`error`): acción recomendada.

Ejemplos reales: grupos de seguridad con SSH abierto a `0.0.0.0/0`, buckets de S3 públicos, usuarios IAM sin MFA, claves de acceso sin rotar en 90 días, balanceadores sin uso, IP elásticas sin asociar. Con el plan **Business** o superior, la API de `support` da acceso a todas las comprobaciones.

```bash
aws support describe-trusted-advisor-checks --language en --query 'checks[?category==`security`].[id,name]' --output table
aws support describe-trusted-advisor-check-result --check-id 1iG5NDGVre
aws support refresh-trusted-advisor-check --check-id 1iG5NDGVre
aws support describe-trusted-advisor-check-summaries --check-ids 1iG5NDGVre
```

Detalle importante: Trusted Advisor **guarda el último resultado**. Si corriges un recurso, el semáforo **no cambia** hasta que se **actualiza** la comprobación (`refresh-trusted-advisor-check`, o el botón de la consola). Es una confusión clásica.

### AWS Health

**AWS Health** (`health`) avisa de eventos que afectan a *tus* recursos: retirada programada de una instancia, mantenimiento, incidencias de servicio o avisos de seguridad (por ejemplo, un bucket expuesto). Se consulta con `describe-events` y `describe-affected-entities`, y se integra con EventBridge para generar alertas o tickets.

```bash
aws health describe-events --region us-east-1
aws health describe-event-details --event-arns <arn> --region us-east-1
```

### Cómo encaja todo

- **Organizations + SCP**: lo que está *prohibido hacer*.
- **Config**: lo que *está mal configurado* ahora mismo.
- **CloudTrail**: *quién hizo qué* y cuándo.
- **Budgets y Cost Explorer**: *cuánto cuesta*.
- **Trusted Advisor y Health**: *qué mejorar* y *qué te va a afectar*.
- **Well-Architected Tool**: la revisión por pilares de una carga de trabajo concreta.

Para entornos grandes se añaden **Control Tower** (crea y gobierna una *landing zone* multicuenta con barandillas ya definidas), **Security Hub** (agrega hallazgos de seguridad) y **IAM Access Analyzer** (accesos externos).

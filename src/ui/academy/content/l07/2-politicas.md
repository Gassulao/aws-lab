## Políticas de enrutamiento

Cuando un nombre tiene varios registros, la **política de enrutamiento** decide cuál se devuelve:

| Política | Qué hace |
| --- | --- |
| **Simple** | Un registro (con varios valores si quieres) |
| **Ponderada** | Reparte el tráfico según pesos (90/10 para desplegar poco a poco una versión nueva) |
| **Latencia** | Responde con la región más rápida para el usuario |
| **Conmutación por error** | Principal y secundario: si el principal falla, usa el secundario |
| **Geolocalización** | Según el país del usuario |

Los registros con política necesitan un **identificador** (`SetIdentifier`) que los distinga.

## Comprobaciones de estado

Una comprobación de estado vigila un punto de enlace (IP y puerto, HTTP o TCP). Asociada a un registro de conmutación por error, Route 53 deja de devolver el principal cuando falla:

```bash
aws route53 create-health-check --caller-reference hc-1 --health-check-config IPAddress=203.0.113.10,Port=80,Type=HTTP,ResourcePath=/
aws route53 get-health-check-status --health-check-id <id>
```

El patrón clásico de recuperación ante desastres es **principal en una región y secundario en otra** (o una página estática en S3), con TTL bajo para que el cambio se note enseguida.

```bash
dig +short www.tienda.com
```

> **Para el examen (dominio 2):** conmutación por error DNS = recuperación activa-pasiva; ponderada o latencia = activa-activa. Una comprobación de estado también puede evaluar el estado de un alias (`EvaluateTargetHealth`).

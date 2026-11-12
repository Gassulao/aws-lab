Con EC2 pagas por el tiempo que la instancia está en estado `running` (por segundo, con mínimo de 60 s en Linux), pero **otras piezas siguen facturando aunque la apagues**.

| Estado | ¿Se paga cómputo? | ¿Se paga almacenamiento? |
|---|---|---|
| `running` | Sí | Sí (EBS) |
| `stopped` | **No** | **Sí** (EBS) y las Elastic IP asociadas a instancias paradas |
| `terminated` | No | No (el volumen raíz se elimina por defecto) |

Cálculo rápido: **730 horas al mes**. Una `t3.micro` (≈ 0,0104 USD/h) ronda los 7,6 USD al mes en bajo demanda; una `m5.xlarge` (≈ 0,192 USD/h) unos 140 USD.

Los comandos que más dinero ahorran son los más simples:

```bash
aws ec2 stop-instances --instance-ids <i-…>
aws ec2 describe-instances --filters Name=instance-state-name,Values=running --query 'Reservations[].Instances[].[InstanceId,InstanceType]' --output text
aws ec2 terminate-instances --instance-ids <i-…>
```

## Modelos de compra

| Modelo | Ahorro | Cuándo |
|---|---|---|
| **Bajo demanda** | Referencia | Cargas impredecibles o cortas |
| **Savings Plans / Reservadas** | hasta ~70 % con compromiso de 1 o 3 años | Carga estable y continua |
| **Spot** | hasta ~90 % | Tolerante a interrupciones (lotes, CI, análisis) |

## Otros ahorros

- **Ajusta el tamaño** (*right-sizing*): si la CPU no pasa del 10 %, baja de tipo.
- **Apaga** entornos de desarrollo fuera de horario (`stop-instances`) y **termina** lo que no uses.
- Usa **etiquetas** (`Name`, `Proyecto`) para saber qué es de quién y activa **alertas de presupuesto**.

> **Para el examen (dominio 4):** carga continua 24/7 durante un año → Savings Plan o instancia reservada. Procesamiento por lotes interrumpible → Spot. No olvides los volúmenes EBS huérfanos y las IP elásticas sin usar.

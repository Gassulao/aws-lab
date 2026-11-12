## AWS Organizations y las SCP: barandillas para toda una empresa

Una empresa seria no tiene una sola cuenta de AWS: separa **producción**, **desarrollo**, **seguridad** y **logs** en cuentas distintas. Así un error en desarrollo no puede tumbar producción y la factura de cada equipo queda separada. **AWS Organizations** es el servicio que agrupa esas cuentas:

- **Cuenta de administración** (antes *master*): la que crea la organización y paga la factura consolidada.
- **Cuentas miembro**: el resto. Se crean con `create-account` o se invitan.
- **Raíz** (*root*): el nodo superior del árbol.
- **Unidades organizativas (OU)**: carpetas para agrupar cuentas (`Produccion`, `Sandbox`…). Pueden anidarse.

```bash
aws organizations create-organization --feature-set ALL
ROOT=$(aws organizations list-roots --query 'Roots[0].Id' --output text)
OU=$(aws organizations create-organizational-unit --parent-id $ROOT --name Produccion --query OrganizationalUnit.Id --output text)
aws organizations create-account --account-name prod --email prod@example.com
aws organizations list-accounts --query 'Accounts[].[Name,Id,Status]' --output table
```

La creación de una cuenta es **asíncrona**: `create-account` devuelve un estado `IN_PROGRESS` y debes consultar `describe-create-account-status` (o `list-create-account-status`) hasta ver `SUCCEEDED`.

### Políticas de control de servicios (SCP)

Una **SCP** fija el **máximo de permisos** que puede tener una cuenta. Tres ideas lo resumen todo:

1. **Una SCP nunca concede permisos**: solo los limita. Para que una acción funcione, IAM debe permitirla **y** las SCP de cada nivel (raíz, OU y cuenta) también.
2. **Un `Deny` en cualquier nivel gana siempre**, incluso para el administrador de esa cuenta.
3. **Las SCP no afectan a la cuenta de administración** ni a los roles vinculados a servicios. Por eso se recomienda no crear recursos en ella.

El tipo de política se habilita en la raíz (`enable-policy-type`). AWS adjunta entonces `FullAWSAccess` (Allow `*`) a todos los destinos: si la quitas sin poner otra cosa, la cuenta queda sin permisos. Hay dos estrategias:

- **Lista de denegación** (la habitual): se deja `FullAWSAccess` y se añaden `Deny` concretos (borrar CloudTrail, usar regiones no aprobadas, salir de la organización).
- **Lista de permitidos**: se sustituye `FullAWSAccess` por un `Allow` solo de los servicios aprobados. Es más estricta y más trabajosa.

```bash
cat > deny-region.json <<'JSON'
{"Version":"2012-10-17","Statement":[{"Sid":"SoloIrlanda","Effect":"Deny","Action":["ec2:*","rds:*"],"Resource":"*",
 "Condition":{"StringNotEquals":{"aws:RequestedRegion":["eu-west-1"]}}}]}
JSON
P=$(aws organizations create-policy --name SoloIrlanda --description "Solo eu-west-1" --type SERVICE_CONTROL_POLICY --content file://deny-region.json --query Policy.PolicySummary.Id --output text)
aws organizations attach-policy --policy-id $P --target-id $OU
```

### Cómo se entra en una cuenta miembro

Las cuentas creadas por Organizations traen el rol **`OrganizationAccountAccessRole`**, que confía en la cuenta de administración. Se asume con `sts assume-role` y la sesión resultante **sí** está sujeta a las SCP:

```bash
MIEMBRO=$(aws organizations list-accounts --query "Accounts[?Name=='prod'].Id" --output text)
aws sts assume-role --role-arn arn:aws:iam::$MIEMBRO:role/OrganizationAccountAccessRole --role-session-name prueba
```

Cuando una SCP bloquea una acción, el mensaje lo dice con claridad: *«with an explicit deny in a service control policy»* (el `Deny` de una SCP) o *«because no service control policy allows the … action»* (falta un `Allow` en algún nivel). Aprende a distinguirlos: es una pregunta típica del examen.

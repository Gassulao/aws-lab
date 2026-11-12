## El estado de Terraform

Terraform guarda en `terraform.tfstate` la correspondencia entre cada bloque `resource` y el recurso real (su `id` y todos sus atributos). Sin el estado no sabría que `aws_vpc.main` es la VPC `vpc-0abc...`.

```bash
terraform state list
terraform state show aws_vpc.main
terraform show
```

Reglas de oro:

- **No edites el fichero a mano.** Usa `terraform state ...` si necesitas moverlo.
- **No lo subas a Git**: contiene atributos sensibles (contraseñas, claves) en texto claro. Añade `*.tfstate*` al `.gitignore`.
- En equipo, guárdalo en un **backend remoto**: un bucket de S3 cifrado y versionado, con bloqueo de estado para que dos personas no apliquen a la vez.

## Deriva (drift)

Si alguien modifica un recurso desde la consola o la CLI, la realidad deja de coincidir con el estado. Antes de cada `plan`, Terraform **refresca** el estado consultando a AWS y te avisa:

```
Note: Objects have changed outside of Terraform
  # aws_security_group.web has changed
```

Tienes dos salidas: aplicar de nuevo (Terraform **revierte** el cambio manual para que coincida con el código) o trasladar el cambio al código si era legítimo. Lo importante es que la deriva ya no pasa desapercibida.

```bash
terraform plan -no-color
terraform plan -detailed-exitcode   # código 0: sin cambios, 2: hay cambios
```

> **Para el examen (dominio 1):** la deriva de configuración es un riesgo de seguridad. AWS Config detecta cambios en los recursos; Terraform los corrige. Se complementan.

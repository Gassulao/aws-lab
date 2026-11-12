## Infraestructura como código

Hasta ahora has creado recursos escribiendo comandos. Es útil para aprender, pero no se puede repetir con fiabilidad, nadie lo revisa y no deja rastro de **por qué** existe cada recurso. **Terraform** invierte el enfoque: describes el estado deseado en ficheros `.tf` y la herramienta calcula qué debe crear, cambiar o borrar.

El flujo es siempre el mismo:

1. `terraform init` descarga el proveedor (`hashicorp/aws`) y prepara el directorio.
2. `terraform validate` comprueba la sintaxis y las referencias sin tocar la nube.
3. `terraform plan` compara la configuración con el **estado** y la nube y muestra qué cambiaría.
4. `terraform apply` ejecuta el plan; `terraform destroy` lo deshace todo.

```bash
mkdir -p lab-tf && cd lab-tf
terraform version
```

## HCL en cinco minutos

Un fichero `.tf` se compone de **bloques**. Los más habituales son `provider`, `resource`, `variable`, `locals`, `data` y `output`.

```bash
cat > main.tf <<'EOF'
provider "aws" {
  region = "eu-west-1"
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags = {
    Name = "lab"
  }
}

resource "aws_subnet" "a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
}
EOF
terraform init
```

Fíjate en `aws_vpc.main.id`: es una **referencia**. Terraform deduce de ella que la subred depende de la VPC, así que crea la VPC primero y borra la subred primero. A esto se le llama **dependencia implícita** y forma un grafo; con `depends_on` puedes declarar una dependencia explícita cuando no hay ninguna referencia.

Los valores que solo se conocen tras crear el recurso (como `id`) aparecen en el plan como `(known after apply)`.

> **Para el examen (dominio 2):** la infraestructura como código hace los entornos **repetibles** y facilita la recuperación ante desastres: puedes reconstruir una región entera desde el repositorio.

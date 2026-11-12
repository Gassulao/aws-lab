## Variables, locals y salidas

Para no repetir valores y reutilizar el código en varios entornos usa **variables**:

```bash
cat > variables.tf <<'EOF'
variable "entorno" {
  type    = string
  default = "dev"
}

variable "subnet_cidrs" {
  type = list(string)
}
EOF
cat > terraform.tfvars <<'EOF'
subnet_cidrs = ["10.30.1.0/24", "10.30.2.0/24"]
EOF
```

El valor de una variable se toma, de menor a mayor prioridad, de: el `default`, `terraform.tfvars`, `*.auto.tfvars`, `-var-file` y `-var`. Las variables de entorno `TF_VAR_nombre` quedan por encima del `default`. Marca como `sensitive = true` las que contengan secretos.

Los **locals** son valores calculados reutilizables (`local.nombre`) y las **salidas** (`output`) publican datos al terminar: `terraform output -raw vpc_id`.

## Varias copias: count y for_each

```bash
cat > subnets.tf <<'EOF'
resource "aws_subnet" "sub" {
  count      = length(var.subnet_cidrs)
  vpc_id     = aws_vpc.main.id
  cidr_block = var.subnet_cidrs[count.index]
  tags       = { Name = "${var.entorno}-sub-${count.index + 1}" }
}

output "subnet_ids" {
  value = aws_subnet.sub[*].id
}
EOF
```

- `count` identifica cada copia por posición (`aws_subnet.sub[0]`): si quitas la primera, todas las demás se desplazan.
- `for_each` las identifica por clave (`aws_s3_bucket.b["logs"]`) y es más estable. Prefiérelo cuando cada elemento tenga un nombre propio.

Termina siempre con `terraform fmt` (reformatea el código) y `terraform validate`.

> **Para el examen (dominio 4):** parametrizar el tamaño y el número de recursos por entorno permite que desarrollo sea pequeño y barato, y producción, redundante.

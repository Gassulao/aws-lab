## Cómo leer un plan

Cada línea lleva un símbolo:

| Símbolo | Significado |
| --- | --- |
| `+` | crear |
| `~` | actualizar **en sitio** (el recurso sigue siendo el mismo) |
| `-` | destruir |
| `-/+` | **reemplazar**: destruir y volver a crear |

Un reemplazo ocurre cuando cambias un atributo que AWS no permite modificar (la `cidr_block` de una VPC, la `ami` de una instancia). El plan lo marca con `# forces replacement`. **Léelo siempre antes de aplicar**: un `-/+` sobre una base de datos o un bucket con datos es una pérdida de información.

```bash
terraform plan -out=plan.tfplan
terraform apply plan.tfplan
```

## Protecciones con lifecycle

```bash
cat > bucket.tf <<'EOF'
resource "aws_s3_bucket" "datos" {
  bucket = "mis-datos-2026"

  lifecycle {
    prevent_destroy = true
  }
}
EOF
```

- `prevent_destroy = true` hace fallar cualquier plan que borre el recurso.
- `ignore_changes = [tags]` ignora los cambios hechos fuera de Terraform en esos atributos.
- `create_before_destroy` crea la sustitución antes de borrar el original, para evitar cortes.

## Errores habituales

Los errores de AWS llegan tal cual: `api error AccessDenied`, `BucketAlreadyExists`, `VpcLimitExceeded`. Lee `with aws_xxx.nombre, on main.tf line N` para localizar el bloque. Si el `apply` falla a mitad, Terraform guarda en el estado lo que **sí** creó; corrige el problema y vuelve a aplicar.

> **Para el examen (dominio 4):** `terraform destroy` al terminar una práctica es la forma más fiable de no dejar recursos olvidados que sigan generando coste.

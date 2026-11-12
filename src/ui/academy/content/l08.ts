import { SAA_DOMAINS, type Level } from '../types';
import { prep } from '../setup';
import fundamentos from './l08/1-fundamentos.md?raw';
import estado from './l08/2-estado.md?raw';
import variables from './l08/3-variables.md?raw';
import ciclo from './l08/4-ciclo.md?raw';

// Los ficheros .tf se escriben con printf (una sola línea); la solución mostrada usa here-documents, que se leen mejor.
type Item = string | { file: string; body: string };
const esc = (t: string) => t.replace(/%/g, '%%').replace(/\n/g, '\\n');
const scriptOf = (items: Item[]) => items.map((i) => (typeof i === 'string' ? i : `printf '${esc(i.body)}' > ${i.file}`));
const solutionOf = (items: Item[]) => '```bash\n' + items.map((i) => (typeof i === 'string' ? i : `cat > ${i.file} <<'EOF'\n${i.body.replace(/\n$/, '')}\nEOF`)).join('\n') + '\n```';
const tfRan = (verb: string) => new RegExp(`terraform\\s+(-\\S+\\s+)*${verb}\\b`);
const AMI = 'ami-0a1b2c3d4e5f60001';

const PROVIDER = `terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "eu-west-1"
}
`;

// --- Laboratorio 1
const E1: Item[] = [
  'mkdir -p lab-tf',
  'cd lab-tf',
  { file: 'main.tf', body: `${PROVIDER}
resource "aws_vpc" "main" {
  cidr_block = "10.20.0.0/16"
  tags = {
    Name = "lab-tf"
  }
}

output "vpc_id" {
  value = aws_vpc.main.id
}
` },
  'terraform init',
  'terraform validate',
  'terraform plan',
  'terraform apply -auto-approve',
  'terraform output -raw vpc_id > ~/vpc.txt',
  'cat ~/vpc.txt',
];

// --- Laboratorio 2
const DRIFT_TF = `${PROVIDER}
resource "aws_vpc" "main" {
  cidr_block = "10.40.0.0/16"
  tags = {
    Name = "lab-drift"
  }
}

resource "aws_security_group" "web" {
  name        = "web-drift"
  description = "Trafico web"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
`;
const E2: Item[] = [
  'cd lab-drift',
  'terraform plan',
  'terraform plan -no-color > ~/deriva.txt',
  'terraform apply -auto-approve',
  'terraform plan -detailed-exitcode',
];

// --- Laboratorio 3
const E3: Item[] = [
  'mkdir -p lab-vars',
  'cd lab-vars',
  { file: 'main.tf', body: `${PROVIDER}
resource "aws_vpc" "main" {
  cidr_block = "10.30.0.0/16"
  tags = {
    Name = "lab-vars"
  }
}
` },
  { file: 'variables.tf', body: `variable "entorno" {
  type    = string
  default = "dev"
}

variable "subnet_cidrs" {
  type = list(string)
}
` },
  { file: 'terraform.tfvars', body: `subnet_cidrs = ["10.30.1.0/24", "10.30.2.0/24", "10.30.3.0/24"]
` },
  { file: 'subnets.tf', body: `resource "aws_subnet" "sub" {
  count      = length(var.subnet_cidrs)
  vpc_id     = aws_vpc.main.id
  cidr_block = var.subnet_cidrs[count.index]
  tags       = { Name = "\${var.entorno}-sub-\${count.index + 1}" }
}

output "subnet_ids" {
  value = aws_subnet.sub[*].id
}
` },
  'terraform init',
  'terraform fmt',
  'terraform validate',
  'terraform apply -auto-approve',
  'terraform apply -auto-approve -var entorno=prod',
];

// --- Laboratorio 4
const E4: Item[] = [
  'mkdir -p lab-s3',
  'cd lab-s3',
  { file: 'main.tf', body: `${PROVIDER}
resource "aws_kms_key" "datos" {
  description         = "Clave de datos del laboratorio"
  enable_key_rotation = true
}

resource "aws_s3_bucket" "datos" {
  bucket = "lab-tf-datos-2026"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "datos" {
  bucket = aws_s3_bucket.datos.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "datos" {
  bucket = aws_s3_bucket.datos.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.datos.arn
    }
  }
}

resource "aws_s3_bucket_public_access_block" "datos" {
  bucket                  = aws_s3_bucket.datos.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
` },
  'terraform init',
  'terraform apply -auto-approve',
  'terraform destroy -auto-approve || echo "destroy bloqueado por prevent_destroy"',
  'terraform state list > ~/recursos.txt',
];

// --- Laboratorio 5
const EC2_TF = `${PROVIDER}
resource "aws_vpc" "main" {
  cidr_block = "10.60.0.0/16"
}

resource "aws_subnet" "a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.60.1.0/24"
}

resource "aws_instance" "web" {
  ami           = "${AMI}"
  instance_type = "t3.micro"
  subnet_id     = aws_subnet.a.id
  tags = {
    Name = "web-tf"
  }
}
`;
const E5: Item[] = [
  'cd lab-ec2',
  "sed -i 's/t3.micro/t3.small/' main.tf",
  'terraform plan -no-color > ~/plan5.txt',
  'terraform apply -auto-approve',
  'terraform destroy -auto-approve',
];

const E5_SOL = solutionOf(E5);

export const l08: Level = {
  id: 8,
  slug: 'infraestructura-como-codigo',
  title: 'Infraestructura como código',
  subtitle: 'Terraform: plan, apply, estado, deriva y protección de recursos',
  skills: ['Flujo init, plan, apply y destroy', 'Lectura de planes (crear, actualizar, reemplazar)', 'Variables, count y salidas', 'Estado y detección de deriva', 'Protecciones con lifecycle'],
  lessons: [
    { id: 'l08-fundamentos', title: 'Terraform y HCL: el flujo de trabajo', minutes: 7, body: fundamentos },
    { id: 'l08-estado', title: 'Estado y deriva', minutes: 7, body: estado },
    { id: 'l08-variables', title: 'Variables, count y salidas', minutes: 8, body: variables },
    { id: 'l08-ciclo', title: 'Leer planes, reemplazos y protecciones', minutes: 8, body: ciclo },
  ],
  exercises: [
    {
      id: 'l08-e1',
      title: 'Tu primera VPC con Terraform',
      summary: 'Escribe la configuración, revisa el plan, aplícala y guarda la salida.',
      difficulty: 'Fácil',
      minutes: 15,
      saa: [SAA_DOMAINS[2]],
      tags: ['Terraform', 'VPC', 'IaC'],
      scenario: 'Quieres dejar de crear redes a mano. En la carpeta `~/lab-tf` escribe un `main.tf` que declare el proveedor `aws` en `eu-west-1` y una VPC `10.20.0.0/16` con la etiqueta `Name=lab-tf`, más una salida `vpc_id`. Inicializa, valida, **revisa el plan antes de aplicar**, aplícalo y guarda el ID de la VPC en `~/vpc.txt`.',
      steps: [
        { id: 'write', title: 'Crea `~/lab-tf/main.tf` con el proveedor, la VPC `10.20.0.0/16` (`Name=lab-tf`) y la salida `vpc_id`', hint: ['mkdir -p lab-tf && cd lab-tf', 'Usa un bloque resource "aws_vpc" "main" con cidr_block y tags, y un bloque output "vpc_id".', 'Puedes escribir el fichero con cat > main.tf <<\'EOF\' … EOF.'], check: (c) => { const f = c.file('lab-tf/main.tf'); if (!f) return 'Falta el fichero ~/lab-tf/main.tf.'; return (/resource\s+"aws_vpc"/.test(f) && f.includes('10.20.0.0/16') && /output\s+"vpc_id"/.test(f)) || 'main.tf debe declarar una aws_vpc con 10.20.0.0/16 y la salida vpc_id.'; } },
        { id: 'init', title: 'Ejecuta `terraform init` y `terraform validate`', hint: ['terraform init prepara el directorio y descarga el proveedor.', 'Debes estar dentro de ~/lab-tf.'], check: (c) => (c.file('lab-tf/.terraform.lock.hcl') !== null && c.ran(tfRan('validate'))) || 'Ejecuta terraform init y terraform validate dentro de ~/lab-tf.' },
        { id: 'plan', title: 'Revisa el plan con `terraform plan` antes de aplicar', hint: ['Comprueba que dice «Plan: 1 to add, 0 to change, 0 to destroy.»'], check: (c) => c.ran(tfRan('plan')) || 'Aún no has ejecutado terraform plan.' },
        { id: 'apply', title: 'Aplica con `terraform apply -auto-approve` y guarda el ID con `terraform output -raw vpc_id > ~/vpc.txt`', hint: ['El flag -raw imprime el valor sin comillas.', 'terraform output -raw vpc_id > ~/vpc.txt'], check: (c) => { const v = c.vpc('lab-tf'); if (!v || v.cidr !== '10.20.0.0/16') return 'La VPC lab-tf todavía no existe: ejecuta terraform apply.'; return c.file('vpc.txt')?.trim() === v.id || '~/vpc.txt debe contener el ID de la VPC creada.'; } },
      ],
      script: scriptOf(E1),
      solution: solutionOf(E1),
      realWorld: 'En tu cuenta real **una VPC vacía no cuesta nada**, así que es un buen primer ejercicio. Crea una carpeta `terraform/` en tu repositorio **aws-secure-infrastructure**, pon allí `main.tf`, ejecuta `terraform init`, `plan` y `apply` con un perfil de AWS de permisos mínimos y añade `*.tfstate*` y `.terraform/` al `.gitignore`. **Limpieza:** `terraform destroy` borra la VPC; después comprueba en la consola que no quedan recursos con la etiqueta `lab-tf`.',
    },
    {
      id: 'l08-e2',
      title: 'Deriva: alguien abrió el puerto 22',
      summary: 'Detecta un cambio manual con terraform plan y revierte la deriva.',
      difficulty: 'Media',
      minutes: 18,
      saa: [SAA_DOMAINS[1]],
      tags: ['Terraform', 'Deriva', 'Seguridad', 'Security Group'],
      scenario: 'La infraestructura de `~/lab-drift` se desplegó con Terraform: una VPC y el grupo de seguridad `web-drift`, que solo debe aceptar HTTP. Un compañero ha abierto **por consola** el puerto 22 a todo Internet. Demuéstralo con `terraform plan` (guarda la salida en `~/deriva.txt`), revierte el cambio aplicando de nuevo y confirma que el plan vuelve a salir limpio.',
      setup: async (sh) => {
        await prep(sh, [
          'mkdir -p lab-drift',
          'cd lab-drift',
          ...scriptOf([{ file: 'main.tf', body: DRIFT_TF }]),
          'terraform init',
          'terraform apply -auto-approve',
          "aws ec2 authorize-security-group-ingress --group-id $(aws ec2 describe-security-groups --filters Name=group-name,Values=web-drift --query 'SecurityGroups[0].GroupId' --output text) --protocol tcp --port 22 --cidr 0.0.0.0/0",
          'cd ~',
        ]);
      },
      steps: [
        { id: 'plan', title: 'Entra en `~/lab-drift` y guarda en `~/deriva.txt` la salida de `terraform plan -no-color`', hint: ['cd lab-drift', 'terraform plan -no-color > ~/deriva.txt', 'Busca «Objects have changed outside of Terraform».'], check: (c) => { const f = c.file('deriva.txt'); if (!f) return 'Falta ~/deriva.txt: redirige la salida del plan.'; return (f.includes('Objects have changed outside of Terraform') && f.includes('aws_security_group.web')) || 'El plan guardado debe mostrar la deriva de aws_security_group.web.'; } },
        { id: 'apply', title: 'Revierte la deriva con `terraform apply -auto-approve`', hint: ['Terraform aplicará lo que dice el código: solo el puerto 80.'], check: (c) => { const sg = c.sg('web-drift'); if (!sg) return 'No se encuentra el grupo web-drift.'; if (c.sgAllows(sg, 22, '0.0.0.0/0')) return 'El puerto 22 sigue abierto al mundo: aplica la configuración.'; return c.ran(tfRan('apply')) || 'Ejecuta terraform apply.'; } },
        { id: 'clean', title: 'Confirma que no quedan cambios con `terraform plan -detailed-exitcode`', hint: ['Código de salida 0: sin cambios; 2: hay cambios pendientes.'], check: (c) => c.ran(/terraform\s+(-\S+\s+)*plan\s+(-\S+\s+)*-detailed-exitcode/) || 'Ejecuta terraform plan -detailed-exitcode y comprueba que termina sin cambios.' },
      ],
      script: scriptOf(E2),
      solution: solutionOf(E2),
      realWorld: 'En tu cuenta real activa **AWS Config** (regla `restricted-ssh`) para enterarte de la deriva en cuanto ocurre, y ejecuta `terraform plan -detailed-exitcode` de forma periódica en tu pipeline: el código de salida 2 indica deriva. Decide caso a caso si revertir (`apply`) o trasladar el cambio al código. En **aws-secure-infrastructure** conviene que ningún grupo de seguridad se modifique por consola. **Limpieza:** `terraform destroy` en la carpeta del laboratorio; los grupos de seguridad no cuestan, pero la VPC y las reglas sueltas son ruido en la auditoría.',
    },
    {
      id: 'l08-e3',
      title: 'Variables, count y salidas',
      summary: 'Crea tres subredes desde una lista y renómbralas sin recrearlas.',
      difficulty: 'Media',
      minutes: 22,
      saa: [SAA_DOMAINS[3]],
      tags: ['Terraform', 'Variables', 'count', 'VPC'],
      scenario: 'En `~/lab-vars` define una VPC `10.30.0.0/16` y **tres subredes** generadas con `count` a partir de una variable `subnet_cidrs` (valores en `terraform.tfvars`: `10.30.1.0/24`, `10.30.2.0/24`, `10.30.3.0/24`). Cada subred se llama `<entorno>-sub-<n>` con la variable `entorno` (por defecto `dev`). Formatea, valida, aplica, y luego cambia el entorno a `prod` con `-var`: las subredes deben **renombrarse en sitio**, sin recrearse.',
      steps: [
        { id: 'files', title: 'Escribe `variables.tf`, `terraform.tfvars` y `subnets.tf` en `~/lab-vars` (además del `main.tf` con la VPC)', hint: ['variable "subnet_cidrs" { type = list(string) } y variable "entorno" con default "dev".', 'count = length(var.subnet_cidrs) y cidr_block = var.subnet_cidrs[count.index].', 'tags = { Name = "${var.entorno}-sub-${count.index + 1}" }'], check: (c) => { const v = c.file('lab-vars/variables.tf') ?? ''; const t = c.file('lab-vars/terraform.tfvars') ?? ''; const s = c.file('lab-vars/subnets.tf') ?? ''; if (!/variable\s+"subnet_cidrs"/.test(v) || !/variable\s+"entorno"/.test(v)) return 'variables.tf debe declarar subnet_cidrs y entorno.'; if (!['10.30.1.0/24', '10.30.2.0/24', '10.30.3.0/24'].every((x) => t.includes(x))) return 'terraform.tfvars debe listar las tres CIDR.'; return /count\s*=/.test(s) || 'subnets.tf debe usar count.'; } },
        { id: 'fmt', title: 'Ejecuta `terraform fmt` y `terraform validate`', hint: ['fmt reescribe el código con el estilo estándar.'], check: (c) => (c.ran(tfRan('fmt')) && c.ran(tfRan('validate'))) || 'Ejecuta terraform fmt y terraform validate.' },
        { id: 'apply', title: 'Aplica: debe haber tres subredes `dev-sub-1`, `dev-sub-2` y `dev-sub-3` en la VPC', hint: ['terraform init antes del primer plan.', 'terraform apply -auto-approve'], check: (c) => { const v = c.vpc('10.30.0.0/16'); if (!v) return 'La VPC 10.30.0.0/16 todavía no existe.'; const names = c.subnets(v.id).map((x) => x.tags.Name).sort(); return (names.length === 3 && names.every((n, i) => /^(dev|prod)-sub-\d$/.test(n ?? '') && n!.endsWith(`-${i + 1}`))) || 'Debe haber tres subredes con nombre <entorno>-sub-<n>.'; } },
        { id: 'prod', title: 'Cambia a `prod` con `terraform apply -auto-approve -var entorno=prod`: las tres subredes se renombran sin recrearse', hint: ['Una etiqueta es una actualización en sitio (~), no un reemplazo.'], check: (c) => { const v = c.vpc('10.30.0.0/16'); if (!v) return 'No se encuentra la VPC.'; const subs = c.subnets(v.id); if (!subs.every((x) => /^prod-sub-\d$/.test(x.tags.Name ?? ''))) return 'Las subredes deben llamarse prod-sub-1, prod-sub-2 y prod-sub-3.'; return (c.trail('CreateSubnet', { error: false }).length === 3 && c.tf('lab-vars')?.addrs.length === 4) || 'Las subredes se han recreado: el cambio de etiqueta debe ser en sitio.'; } },
      ],
      script: scriptOf(E3),
      solution: solutionOf(E3),
      realWorld: 'En tu repositorio **aws-secure-infrastructure** usa un fichero `.tfvars` por entorno (`dev.tfvars`, `prod.tfvars`) y ejecuta `terraform apply -var-file=dev.tfvars`. Las subredes y la VPC no tienen coste; las **NAT Gateway** y las IP elásticas sí (unos 32 USD al mes cada NAT), así que no las añadas a un laboratorio. **Limpieza:** `terraform destroy -var-file=dev.tfvars`.',
    },
    {
      id: 'l08-e4',
      title: 'Un bucket bien protegido y a prueba de borrados',
      summary: 'Cifrado con KMS, versionado, sin acceso público y prevent_destroy.',
      difficulty: 'Difícil',
      minutes: 25,
      saa: [SAA_DOMAINS[1]],
      tags: ['Terraform', 'S3', 'KMS', 'Seguridad', 'lifecycle'],
      scenario: 'En `~/lab-s3` declara con Terraform el bucket `lab-tf-datos-2026` para datos sensibles: **versionado activado**, **cifrado con una clave KMS propia** (con rotación), **bloqueo total de acceso público** y `prevent_destroy` para que nadie lo borre por accidente. Aplícalo, comprueba que `terraform destroy` se **niega** a borrarlo y guarda en `~/recursos.txt` la lista de recursos del estado.',
      steps: [
        { id: 'write', title: 'Escribe `~/lab-s3/main.tf` con la clave KMS, el bucket (`prevent_destroy`), el versionado, el cifrado y el bloqueo de acceso público', hint: ['Son cinco recursos: aws_kms_key, aws_s3_bucket, aws_s3_bucket_versioning, aws_s3_bucket_server_side_encryption_configuration y aws_s3_bucket_public_access_block.', 'Dentro del bucket: lifecycle { prevent_destroy = true }.', 'Referencia el bucket con aws_s3_bucket.datos.id y la clave con aws_kms_key.datos.arn.'], check: (c) => { const f = c.file('lab-s3/main.tf'); if (!f) return 'Falta ~/lab-s3/main.tf.'; const need = ['aws_kms_key', 'aws_s3_bucket"', 'aws_s3_bucket_versioning', 'aws_s3_bucket_server_side_encryption_configuration', 'aws_s3_bucket_public_access_block', 'prevent_destroy']; const miss = need.filter((n) => !f.includes(n)); return miss.length === 0 || `Falta en main.tf: ${miss.join(', ')}.`; } },
        { id: 'apply', title: 'Inicializa y aplica: versionado activo, cifrado `aws:kms` y bloqueo público completo', hint: ['terraform init && terraform apply -auto-approve'], check: (c) => { const b = c.bucket('lab-tf-datos-2026'); if (!b) return 'El bucket lab-tf-datos-2026 aún no existe.'; if (b.versioning !== 'Enabled') return 'El versionado no está activado.'; if (b.encryption?.algorithm !== 'aws:kms') return 'El cifrado debe ser aws:kms.'; const p = b.publicAccessBlock; if (!(p.BlockPublicAcls && p.IgnorePublicAcls && p.BlockPublicPolicy && p.RestrictPublicBuckets)) return 'Falta el bloqueo de acceso público completo.'; return c.tf('lab-s3')?.attr('aws_kms_key.datos', 'enable_key_rotation') === true || 'La clave KMS debe tener la rotación activada.'; } },
        { id: 'destroy', title: 'Intenta `terraform destroy -auto-approve` y comprueba que `prevent_destroy` lo impide', hint: ['Debe fallar con «Instance cannot be destroyed».', 'El bucket sigue existiendo.'], check: (c) => (c.tried(tfRan('destroy')) && !!c.bucket('lab-tf-datos-2026')) || 'Ejecuta terraform destroy: debe negarse a borrar el bucket protegido.' },
        { id: 'state', title: 'Guarda en `~/recursos.txt` la salida de `terraform state list`', hint: ['terraform state list > ~/recursos.txt'], check: (c) => { const f = c.file('recursos.txt')?.split('\n').filter(Boolean) ?? []; return f.length === 5 || '~/recursos.txt debe listar los cinco recursos del estado.'; } },
      ],
      script: scriptOf(E4),
      solution: solutionOf(E4),
      realWorld: 'Este es el patrón mínimo para cualquier bucket con datos sensibles en **aws-secure-infrastructure**. En una cuenta real **la clave KMS cuesta 1 USD al mes** y las peticiones de cifrado se facturan aparte; activa `bucket_key_enabled = true` para reducir llamadas a KMS. **Limpieza:** `prevent_destroy` bloquea el borrado a propósito. Para eliminarlo quita el bloque `lifecycle`, ejecuta `terraform apply`, vacía el bucket (incluidas **todas las versiones**, o usa `force_destroy = true`) y entonces `terraform destroy`. La clave KMS no se borra al instante: queda programada para eliminación entre 7 y 30 días y se sigue cobrando hasta entonces.',
    },
    {
      id: 'l08-e5',
      title: 'Cambiar una instancia en sitio y limpiar',
      summary: 'Escala una instancia sin recrearla y destruye todo al terminar.',
      difficulty: 'Reto',
      minutes: 25,
      saa: [SAA_DOMAINS[3], SAA_DOMAINS[4]],
      tags: ['Terraform', 'EC2', 'Coste', 'plan'],
      scenario: 'El directorio `~/lab-ec2` ya contiene la infraestructura de un servidor web desplegada con Terraform (VPC, subred e instancia `web-tf` de tipo `t3.micro`). Debe pasar a `t3.small`. Cambia el tipo en `main.tf`, **lee el plan** (guárdalo en `~/plan5.txt`) y asegúrate de que es una actualización **en sitio** y no un reemplazo; aplícalo y, para no dejar coste olvidado, destruye todo con Terraform.',
      setup: async (sh) => {
        await prep(sh, [
          'mkdir -p lab-ec2',
          'cd lab-ec2',
          ...scriptOf([{ file: 'main.tf', body: EC2_TF }]),
          'terraform init',
          'terraform apply -auto-approve',
          'cd ~',
        ]);
      },
      steps: [
        { id: 'edit', title: 'Cambia `instance_type` de `t3.micro` a `t3.small` en `~/lab-ec2/main.tf`', hint: ["sed -i 's/t3.micro/t3.small/' main.tf", 'Estás en ~; entra primero con cd lab-ec2.'], check: (c) => { const f = c.file('lab-ec2/main.tf'); return (f?.includes('"t3.small"') && !f.includes('"t3.micro"')) || 'main.tf debe usar t3.small.'; } },
        { id: 'plan', title: 'Guarda el plan en `~/plan5.txt` y comprueba que es una actualización en sitio (`~`)', hint: ['terraform plan -no-color > ~/plan5.txt', 'Busca «will be updated in-place» y que NO diga «must be replaced».'], check: (c) => { const f = c.file('plan5.txt'); if (!f) return 'Falta ~/plan5.txt.'; if (f.includes('must be replaced')) return 'El plan reemplaza la instancia: revisa qué atributo cambiaste.'; return f.includes('will be updated in-place') || 'El plan guardado debe mostrar una actualización en sitio.'; } },
        { id: 'apply', title: 'Aplica el cambio: la misma instancia pasa a `t3.small` sin crear otra', hint: ['terraform apply -auto-approve'], check: (c) => { const i = c.instance((x) => x.tags.Name === 'web-tf'); if (!i) return c.tf('lab-ec2')?.addrs.length === 0 ? true : 'No se encuentra la instancia web-tf.'; if (i.type !== 't3.small') return 'La instancia todavía no es t3.small.'; return c.trail('RunInstances', { error: false }).length === 0 || 'Se ha creado otra instancia: debía actualizarse la existente.'; } },
        { id: 'destroy', title: 'Destruye todo con `terraform destroy -auto-approve` y comprueba que no queda nada', hint: ['Se borran instancia, subred y VPC, en ese orden.'], check: (c) => { if (c.instance((x) => x.tags.Name === 'web-tf')) return 'La instancia web-tf sigue existiendo.'; if (c.vpc('10.60.0.0/16')) return 'La VPC 10.60.0.0/16 sigue existiendo.'; const t = c.tf('lab-ec2'); return (!!t && t.addrs.length === 0 && c.ran(tfRan('destroy'))) || 'Ejecuta terraform destroy y comprueba que el estado queda vacío.'; } },
      ],
      script: scriptOf(E5),
      solution: E5_SOL,
      realWorld: 'En una cuenta real, cambiar el tipo de una instancia EBS **la para y la vuelve a arrancar** (unos minutos de corte) aunque Terraform lo marque como `~`; planifícalo en una ventana de mantenimiento. Una `t3.small` cuesta unos 17 USD al mes encendida y el disco EBS se factura aunque la apagues. En **aws-secure-infrastructure** aplica siempre `terraform plan -out=plan.tfplan` y `terraform apply plan.tfplan`, para ejecutar exactamente lo que revisaste. **Limpieza:** `terraform destroy` al terminar y, después, comprueba en la consola que no quedan instancias, volúmenes EBS ni IP elásticas sueltas.',
    },
  ],
  quiz: [
    { domain: 2, q: '¿Qué ventaja principal aporta la infraestructura como código para la resiliencia?', options: ['Elimina la necesidad de copias de seguridad', 'Permite reconstruir entornos completos de forma repetible desde el repositorio', 'Hace que los recursos nunca fallen', 'Evita pagar por los recursos'], answer: 1, explain: 'Con el entorno descrito en código puedes recrearlo en otra región o cuenta tras un desastre, y revisar los cambios antes de aplicarlos. No sustituye a las copias de datos.' },
    { domain: 1, q: 'El fichero de estado de Terraform contiene atributos sensibles. ¿Dónde debe guardarse en un equipo?', options: ['En el repositorio de Git junto al código', 'En un bucket de S3 cifrado, versionado y con acceso restringido, con bloqueo de estado', 'En el escritorio de cada persona', 'En un bucket público para compartirlo'], answer: 1, explain: 'Un backend remoto cifrado y versionado con bloqueo evita fugas y que dos personas apliquen a la vez; el versionado permite recuperar un estado anterior.' },
    { domain: 2, q: 'Un plan de Terraform muestra «-/+» sobre una base de datos RDS con datos. ¿Qué significa y qué debes hacer?', options: ['Se actualizará en sitio sin impacto', 'Se destruirá y volverá a crear: hay riesgo de perder datos, así que revisa el atributo que fuerza el reemplazo y haz una copia antes', 'Solo se mostrará información', 'Se creará una réplica de lectura'], answer: 1, explain: '«-/+» es un reemplazo (destruir y crear). Léelo siempre; protege los recursos con datos con prevent_destroy y toma instantáneas antes de aplicar.' },
    { domain: 1, q: 'Alguien abre el puerto 22 a Internet desde la consola de un grupo de seguridad gestionado con Terraform. ¿Qué ocurre en el siguiente «terraform plan»?', options: ['Nada: Terraform no mira la nube', 'Terraform detecta el cambio externo (deriva) y propone revertirlo para que coincida con el código', 'El plan falla siempre', 'Se borra el grupo de seguridad'], answer: 1, explain: 'Antes de planificar, Terraform refresca el estado desde AWS, muestra «Objects have changed outside of Terraform» y propone volver a lo declarado. AWS Config puede avisar en el momento del cambio.' },
    { domain: 4, q: 'Terminas una práctica con muchos recursos de pago creados con Terraform. ¿Cuál es la forma más fiable de no dejar coste olvidado?', options: ['Borrar los recursos uno a uno por consola', 'Ejecutar terraform destroy y comprobar después la consola', 'Apagar el ordenador', 'Cambiar de región'], answer: 1, explain: 'terraform destroy borra en el orden correcto todo lo que está en el estado. Revisa luego la consola por si hubo recursos creados fuera de Terraform.' },
    { domain: 3, q: 'Necesitas desplegar la misma arquitectura en tres regiones cercanas a tus usuarios con el mínimo esfuerzo. ¿Qué enfoque es el más adecuado?', options: ['Crear los recursos a mano en cada región', 'Parametrizar el código (variables, módulos o StackSets de CloudFormation) y aplicarlo en cada región', 'Usar una sola región y aumentar el tamaño de las instancias', 'Copiar capturas de pantalla de la consola'], answer: 1, explain: 'La parametrización permite reutilizar la misma definición con valores distintos por región, con resultados idénticos y revisables.' },
    { domain: 4, q: 'Quieres que desarrollo sea barato y producción redundante con el mismo código. ¿Qué haces?', options: ['Dos repositorios completamente distintos', 'Variables por entorno (por ejemplo, número de instancias y tipo) con un fichero de valores para cada uno', 'Usar siempre el tipo de instancia más grande', 'Desactivar el plan'], answer: 1, explain: 'Un único código con variables y ficheros .tfvars por entorno evita divergencias y permite dimensionar cada entorno según su necesidad y su presupuesto.' },
    { domain: 2, q: '¿Qué servicio de AWS ofrece infraestructura como código nativa mediante plantillas que se despliegan como pilas?', options: ['AWS CloudFormation', 'Amazon Inspector', 'AWS Shield', 'Amazon Macie'], answer: 0, explain: 'CloudFormation despliega plantillas JSON o YAML como pilas, con detección de deriva y reversión automática si algo falla. Terraform cumple un papel parecido con proveedores de varias nubes.' },
  ],
};

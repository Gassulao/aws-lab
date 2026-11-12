import { describe, it, expect, beforeEach } from 'vitest';
import { freshState } from '../src/engine/store';
import { newShell, runString, type Shell } from '../src/shell';
import { setClock } from '../src/engine/util';
import type { CloudState } from '../src/engine/types';

let st: CloudState;
let sh: Shell;
beforeEach(() => {
  setClock(() => Date.parse('2026-11-08T10:00:00Z'));
  st = freshState('Ana');
  st.settings.speed = 'instant';
  sh = newShell(st);
});
const run = (cmd: string) => runString(sh, cmd);
const write = (name: string, body: string) => sh.fs.writeFile(`${sh.cwd}/${name}`, body);
const tf = async (args: string) => { const r = await run(`terraform -no-color ${args}`); return r; };

const MAIN = `
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

variable "env" {
  type    = string
  default = "dev"
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags = {
    Name = "lab-\${var.env}"
  }
}

resource "aws_subnet" "a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
}

output "vpc_id" {
  value = aws_vpc.main.id
}
`;

describe('terraform', () => {
  it('flujo init, plan, apply, output y destroy', async () => {
    write('main.tf', MAIN);
    const noInit = await tf('plan');
    expect(noInit.err).toContain('Required plugins are not installed');
    const init = await tf('init');
    expect(init.out).toContain('Terraform has been successfully initialized!');
    expect(init.out).toContain('Finding hashicorp/aws versions matching "~> 5.0"');
    const plan = await tf('plan');
    expect(plan.out).toContain('Plan: 2 to add, 0 to change, 0 to destroy.');
    expect(plan.out).toContain('+ resource "aws_vpc" "main" {');
    expect(plan.out).toContain('(known after apply)');
    const ap = await tf('apply -auto-approve');
    expect(ap.out).toContain('Apply complete! Resources: 2 added, 0 changed, 0 destroyed.');
    expect(st.vpcs.some((v) => v.cidr === '10.0.0.0/16')).toBe(true);
    const out = await tf('output vpc_id');
    expect(out.out).toMatch(/^"vpc-/);
    const again = await tf('plan');
    expect(again.out).toContain('No changes. Your infrastructure matches the configuration.');
    const list = await tf('state list');
    expect(list.out).toBe('aws_subnet.a\naws_vpc.main\n');
    const d = await tf('destroy -auto-approve');
    expect(d.out).toContain('Destroy complete! Resources: 2 destroyed.');
    expect(st.vpcs.some((v) => v.cidr === '10.0.0.0/16')).toBe(false);
  });

  const SG = `
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags       = { Name = "lab" }
}

resource "aws_security_group" "web" {
  name        = "web-sg"
  description = "Web"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_s3_bucket" "logs" {
  bucket = "ana-logs-lab-2026"
  tags   = { Env = "dev" }
}
`;
  it('actualiza en sitio, reemplaza y detecta deriva', async () => {
    write('main.tf', SG);
    await tf('init');
    const a = await tf('apply -auto-approve');
    expect(a.err).toBe('');
    expect(a.out).toContain('Apply complete! Resources: 3 added');
    // deriva: alguien abre el 22 a todo el mundo y borra el bucket etiquetado
    await run('aws ec2 authorize-security-group-ingress --group-id $(aws ec2 describe-security-groups --filters Name=group-name,Values=web-sg --query "SecurityGroups[0].GroupId" --output text) --protocol tcp --port 22 --cidr 0.0.0.0/0');
    const p = await tf('plan');
    expect(p.out).toContain('Objects have changed outside of Terraform');
    expect(p.out).toContain('# aws_security_group.web has changed');
    expect(p.out).toContain('will be updated in-place');
    // update de etiquetas
    write('main.tf', SG.replace('Env = "dev"', 'Env = "prod"').replace('"10.0.0.0/16"', '"10.1.0.0/16"'));
    const p2 = await tf('plan');
    expect(p2.out).toContain('must be replaced');
    expect(p2.out).toContain('# forces replacement');
    const a2 = await tf('apply -auto-approve');
    expect(a2.err).toBe('');
  });

  it('validate detecta argumentos, referencias y tipos desconocidos con el formato de Terraform', async () => {
    write('main.tf', `resource "aws_vpc" "main" {\n  cidr = "10.0.0.0/16"\n}\n\nresource "aws_subnet" "a" {\n  vpc_id     = aws_vpc.otra.id\n  cidr_block = "10.0.1.0/24"\n}\n\nresource "aws_nada" "x" {}\n`);
    await tf('init');
    const v = await tf('validate');
    expect(v.code).toBe(1);
    expect(v.err).toContain('Error: Unsupported argument');
    expect(v.err).toContain('An argument named "cidr" is not expected here.');
    expect(v.err).toContain('Error: Missing required argument');
    expect(v.err).toContain('The argument "cidr_block" is required, but no definition was found.');
    expect(v.err).toContain('Reference to undeclared resource');
    expect(v.err).toContain('Invalid resource type');
    expect(v.err).toContain('╷');
    expect(v.err).toContain('on main.tf line 2, in resource "aws_vpc" "main":');
    write('main.tf', MAIN);
    expect((await tf('validate')).out).toContain('Success! The configuration is valid.');
  });

  it('errores de sintaxis HCL y variables obligatorias', async () => {
    write('main.tf', MAIN);
    await tf('init');
    write('main.tf', 'resource "aws_vpc" "main" {\n  cidr_block = \n}\n');
    expect((await tf('validate')).err).toContain('Error:');
    write('main.tf', `variable "nombre" {\n  type = string\n}\nresource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n  tags = { Name = var.nombre }\n}\n`);
    const p = await tf('plan');
    expect(p.err).toContain('No value for required variable');
    const q = await tf('plan -var nombre=hola');
    expect(q.out).toContain('"Name" = "hola"');
    write('terraform.tfvars', 'nombre = "desde-fichero"\n');
    expect((await tf('plan')).out).toContain('"Name" = "desde-fichero"');
  });

  it('count, for_each, locals y funciones', async () => {
    write('main.tf', `locals {\n  nombres = ["a", "b"]\n  etiqueta = upper("lab")\n}\nresource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\nresource "aws_subnet" "s" {\n  count      = length(local.nombres)\n  vpc_id     = aws_vpc.main.id\n  cidr_block = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)\n  tags       = { Name = "\${local.etiqueta}-\${count.index}" }\n}\nresource "aws_s3_bucket" "b" {\n  for_each = toset(["uno", "dos"])\n  bucket   = "ana-\${each.key}-2026"\n}\n`);
    await tf('init');
    const a = await tf('apply -auto-approve');
    expect(a.err).toBe('');
    expect(a.out).toContain('Apply complete! Resources: 5 added');
    expect((await tf('state list')).out).toBe('aws_s3_bucket.b["dos"]\naws_s3_bucket.b["uno"]\naws_subnet.s[0]\naws_subnet.s[1]\naws_vpc.main\n');
    expect(st.subnets.map((x) => x.cidr).filter((c) => c.startsWith('10.')).sort()).toEqual(['10.0.0.0/24', '10.0.1.0/24']);
  });

  it('un error de la API se muestra como el proveedor de AWS y el estado queda parcial', async () => {
    await run('aws s3api create-bucket --bucket ya-existe-2026 --region eu-west-1 --create-bucket-configuration LocationConstraint=eu-west-1');
    write('main.tf', `resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n}\nresource "aws_s3_bucket" "b" {\n  bucket = "ya-existe-2026"\n}\n`);
    await tf('init');
    const a = await tf('apply -auto-approve');
    expect(a.code).toBe(1);
    expect(a.err).toMatch(/Error: creating Amazon S3 \(Simple Storage\) Bucket \(ya-existe-2026\): operation error S3: CreateBucket, https response error StatusCode: 409, RequestID: [0-9A-F]+, .*BucketAlreadyOwnedByYou/);
    expect(a.err).toContain('with aws_s3_bucket.b,');
    expect((await tf('state list')).out).toBe('aws_vpc.main\n');
  });

  it('destroy, apply sin -auto-approve y salida de output -json', async () => {
    write('main.tf', MAIN);
    await tf('init');
    const c = await tf('apply');
    expect(c.code).toBe(1);
    expect(c.out).toContain('Do you want to perform these actions?');
    expect(st.vpcs.some((v) => v.cidr === '10.0.0.0/16')).toBe(false);
    const y = await run('echo yes | terraform -no-color apply');
    expect(y.out).toContain('Apply complete!');
    const j = JSON.parse((await tf('output -json')).out);
    expect(j.vpc_id.type).toBe('string');
    expect((await tf('output -raw vpc_id')).out).toMatch(/^vpc-/);
    expect((await tf('show')).out).toContain('resource "aws_vpc" "main" {');
    expect((await tf('state show aws_vpc.main')).out).toContain('# aws_vpc.main:');
    expect((await tf('destroy')).out).toContain('Do you really want to destroy all resources?');
    expect((await tf('destroy -auto-approve')).out).toContain('Destroy complete! Resources: 2 destroyed.');
    expect(JSON.parse(sh.fs.readFile(`${sh.cwd}/terraform.tfstate`)).resources).toEqual([]);
  });

  it('fmt reescribe la sangría y alinea los iguales', async () => {
    write('main.tf', 'resource "aws_vpc" "main" {\ncidr_block = "10.0.0.0/16"\n    enable_dns_support = true\n}\n');
    const f = await tf('fmt');
    expect(f.out).toBe('main.tf\n');
    expect(sh.fs.readFile(`${sh.cwd}/main.tf`)).toBe('resource "aws_vpc" "main" {\n  cidr_block         = "10.0.0.0/16"\n  enable_dns_support = true\n}\n');
    expect((await tf('fmt -check')).code).toBe(0);
  });

  it('el plan en color usa secuencias ANSI y -no-color las omite', async () => {
    write('main.tf', MAIN);
    await tf('init');
    const colored = await run('terraform plan');
    expect(colored.out).toContain('\u001b[32m+\u001b[0m');
    expect((await tf('plan')).out).not.toContain('\u001b');
  });

  const FULL = `
data "aws_caller_identity" "current" {}
data "aws_availability_zones" "available" { state = "available" }

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
}
resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id
}
resource "aws_subnet" "pub" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true
}
resource "aws_route_table" "pub" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
}
resource "aws_route_table_association" "pub" {
  subnet_id      = aws_subnet.pub.id
  route_table_id = aws_route_table.pub.id
}
resource "aws_security_group" "web" {
  name   = "web"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_instance" "web" {
  ami                    = "ami-0a1b2c3d4e5f60001"
  instance_type          = "t3.micro"
  subnet_id              = aws_subnet.pub.id
  vpc_security_group_ids = [aws_security_group.web.id]
  tags                   = { Name = "web" }
}
resource "aws_kms_key" "k" {
  description         = "clave"
  enable_key_rotation = true
}
resource "aws_s3_bucket" "b" { bucket = "ana-full-2026" }
resource "aws_s3_bucket_versioning" "b" {
  bucket = aws_s3_bucket.b.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_public_access_block" "b" {
  bucket                  = aws_s3_bucket.b.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "b" {
  bucket = aws_s3_bucket.b.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.k.arn
    }
  }
}
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}
resource "aws_iam_role" "r" {
  name               = "web-role"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}
resource "aws_iam_user" "u" { name = "ana-tf" }
output "account" { value = data.aws_caller_identity.current.account_id }
output "ip" { value = aws_instance.web.private_ip }
`;
  it('recursos de red, cómputo, S3, IAM y KMS se crean, se refrescan sin cambios y se destruyen', async () => {
    write('main.tf', FULL);
    await tf('init');
    const v = await tf('validate');
    expect(v.err).toBe('');
    const a = await tf('apply -auto-approve');
    expect(a.err).toBe('');
    expect(a.out).toMatch(/Apply complete! Resources: 14 added, 0 changed, 0 destroyed\./);
    expect(st.instances.some((i) => i.subnetId === st.subnets.find((x) => x.cidr === '10.0.1.0/24')!.id)).toBe(true);
    const again = await tf('plan -detailed-exitcode');
    expect(again.out).toContain('No changes.');
    expect(again.code).toBe(0);
    const d = await tf('destroy -auto-approve');
    expect(d.err).toBe('');
    expect(d.out).toContain('Destroy complete! Resources: 14 destroyed.');
  });

  it('ciclos, prevent_destroy e ignore_changes', async () => {
    write('main.tf', `resource "aws_security_group" "a" {\n  name = "a"\n  description = aws_security_group.b.id\n}\nresource "aws_security_group" "b" {\n  name = "b"\n  description = aws_security_group.a.id\n}\n`);
    await tf('init');
    expect((await tf('plan')).err).toContain('Cycle:');
    write('main.tf', `resource "aws_s3_bucket" "b" {\n  bucket = "ana-prev-2026"\n  lifecycle {\n    prevent_destroy = true\n  }\n}\n`);
    await tf('apply -auto-approve');
    const dd = await tf('destroy -auto-approve');
    expect(dd.err).toBeDefined();
    write('main.tf', `resource "aws_s3_bucket" "b" {\n  bucket = "ana-prev-2026"\n  tags = { A = "1" }\n  lifecycle {\n    ignore_changes = [tags]\n  }\n}\n`);
    expect((await tf('plan')).out).toContain('No changes.');
  });
});

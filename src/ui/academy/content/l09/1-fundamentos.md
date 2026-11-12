## Infraestructura como código con CloudFormation

**AWS CloudFormation** describe la infraestructura en una **plantilla** (JSON o YAML) y la despliega como una **pila** (*stack*): un conjunto de recursos que se crean, actualizan y borran juntos. Si algo falla, CloudFormation **revierte** y no deja recursos a medias.

Una plantilla tiene estas secciones; solo `Resources` es obligatoria:

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Description: Bucket de datos
Parameters:        # valores que se pasan al desplegar
Conditions:        # decisiones (¿es producción?)
Resources:         # lo que se crea
  Datos:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: mi-bucket-de-datos
Outputs:           # valores que devuelve (y que otras pilas pueden importar)
  Cubo:
    Value: !Ref Datos
```

Cada recurso tiene un **ID lógico** (`Datos`, el nombre en la plantilla) y un **ID físico** (el que crea AWS: el nombre del bucket, `vpc-0abc...`). `Ref` devuelve el ID físico y `!GetAtt Recurso.Atributo` otros datos, como el ARN.

```bash
aws cloudformation validate-template --template-body file://bucket.yaml
aws cloudformation create-stack --stack-name demo --template-body file://bucket.yaml
aws cloudformation wait stack-create-complete --stack-name demo
aws cloudformation describe-stacks --stack-name demo --query "Stacks[0].[StackStatus,Outputs]"
```

Estados habituales: `CREATE_IN_PROGRESS` → `CREATE_COMPLETE`; si un recurso falla, `ROLLBACK_IN_PROGRESS` → `ROLLBACK_COMPLETE` (la pila queda vacía y solo se puede borrar).

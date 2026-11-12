## Parámetros, condiciones y funciones intrínsecas

Una misma plantilla sirve para varios entornos si la parametrizas:

```yaml
Parameters:
  Entorno:
    Type: String
    Default: dev
    AllowedValues: [dev, prod]
Conditions:
  EsProd: !Equals [!Ref Entorno, prod]
Resources:
  Vpc:
    Type: AWS::EC2::VPC
    Properties:
      CidrBlock: 10.0.0.0/16
      Tags:
        - Key: Name
          Value: !Sub "${Entorno}-vpc"
  Aviso:
    Type: AWS::SNS::Topic
    Condition: EsProd
```

Funciones más usadas (en YAML llevan `!`):

| Función | Para qué |
| --- | --- |
| `!Ref` | ID físico de un recurso o valor de un parámetro |
| `!GetAtt R.Attr` | Atributo de un recurso (`Arn`, `PrivateIp`...) |
| `!Sub "x-${Entorno}"` | Sustituye variables en un texto |
| `!Join ["-", [a, b]]` | Une valores |
| `!If`, `!Equals`, `!Not` | Condiciones |
| `!FindInMap` | Consulta la sección `Mappings` |
| `!ImportValue` | Usa una salida exportada por otra pila |

CloudFormation deduce el **orden** de creación de los `Ref`/`GetAtt`; con `DependsOn` lo fuerzas cuando no hay referencia (por ejemplo, la instancia debe esperar a la pasarela de Internet).

```bash
aws cloudformation create-stack --stack-name red --template-body file://red.yaml \
  --parameters ParameterKey=Entorno,ParameterValue=prod
aws cloudformation describe-stack-resources --stack-name red
```

Los parámetros se validan antes de crear nada: `Parameter 'Entorno' must be one of AllowedValues`.

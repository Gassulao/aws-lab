## Amazon ECS con Fargate

**Amazon ECS** orquesta contenedores sin que tengas que instalar nada: con **AWS Fargate** ni siquiera administras servidores. Estos son sus conceptos:

- **Clúster**: agrupación lógica de servicios y tareas.
- **Definición de tarea** (*task definition*): la receta versionada (`familia:revisión`): imagen, CPU y memoria, puertos, variables, rol y registro de logs. Es inmutable: un cambio crea una **revisión** nueva.
- **Tarea** (*task*): una instancia en ejecución de la definición. Con `awsvpc` cada tarea recibe su **propia interfaz de red** (ENI) en tu subred y se protege con **grupos de seguridad**.
- **Servicio**: mantiene N tareas vivas, las reemplaza si fallan y hace **despliegues progresivos** (*rolling update*). Se puede registrar detrás de un **Application Load Balancer** con un grupo de destino de tipo **`ip`** (no `instance`).

Dos roles distintos que se confunden mucho:

| Rol | Quién lo usa | Para qué |
|---|---|---|
| **Rol de ejecución de tareas** | el agente de ECS | descargar la imagen de ECR y escribir en CloudWatch Logs (`AmazonECSTaskExecutionRolePolicy`) |
| **Rol de tarea** | tu aplicación | llamar a S3, DynamoDB, etc. con mínimo privilegio |

```bash
aws ecs create-cluster --cluster-name tienda
aws ecs register-task-definition --cli-input-json file://tarea.json
aws ecs create-service --cluster tienda --service-name web --task-definition web --desired-count 2 --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[subnet-aaa,subnet-bbb],securityGroups=[sg-123],assignPublicIp=ENABLED}"
aws ecs wait services-stable --cluster tienda --services web
aws ecs describe-services --cluster tienda --services web --query "services[0].events[:3]"
```

Una tarea Fargate **no arranca** casi siempre por una de estas causas: la imagen no existe o no hay permiso para leerla (`CannotPullContainerError`), la subred no tiene salida a internet (IP pública o NAT) ni *endpoints* de VPC, falta el rol de ejecución, o el grupo de registros de `awslogs` no existe. El motivo está en `describe-tasks` (`stoppedReason`) y en los **eventos del servicio**.

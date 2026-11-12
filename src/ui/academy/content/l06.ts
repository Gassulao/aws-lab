import { SAA_DOMAINS, type Level } from '../types';
import { prep } from '../setup';
import metricas from './l06/1-metricas.md?raw';
import alarmas from './l06/2-alarmas.md?raw';
import logs from './l06/3-logs.md?raw';
import diag from './l06/4-diagnostico.md?raw';

const AMI = 'ami-0a1b2c3d4e5f60001';
const TAGS = (pairs: string) => `'ResourceType=instance,Tags=[${pairs}]'`;

export const l06: Level = {
  id: 6,
  slug: 'observabilidad',
  title: 'Observabilidad',
  subtitle: 'Métricas, alarmas, SNS y registros con CloudWatch',
  skills: ['Métricas personalizadas', 'Alarmas y acciones con SNS', 'Registros y filtros de métricas', 'Retención y coste', 'Diagnóstico de alarmas'],
  lessons: [
    { id: 'l06-metricas', title: 'Métricas y estadísticas', minutes: 7, body: metricas },
    { id: 'l06-alarmas', title: 'Alarmas, acciones y SNS', minutes: 8, body: alarmas },
    { id: 'l06-logs', title: 'Registros, retención y filtros de métricas', minutes: 8, body: logs },
    { id: 'l06-diag', title: 'Diagnóstico: «mi alarma no funciona»', minutes: 6, body: diag },
  ],
  exercises: [
    {
      id: 'l06-e1',
      title: 'Publica y consulta una métrica personalizada',
      summary: 'Envía pedidos a CloudWatch y calcula cuántos hubo en los últimos minutos.',
      difficulty: 'Fácil',
      minutes: 12,
      saa: [SAA_DOMAINS[3]],
      tags: ['CloudWatch', 'Métricas'],
      scenario: 'La tienda online quiere ver cuántos **pedidos** entran. Publica en el espacio de nombres `Tienda` la métrica `Pedidos` (dimensión `Entorno=prod`) con tres lecturas de **4**, **5** y **7** unidades, comprueba que aparece en `list-metrics` y calcula la **suma** con `get-metric-statistics`, guardándola en `~/pedidos.txt`.',
      steps: [
        { id: 'put', title: 'Publica tres puntos (4, 5 y 7) de `Tienda/Pedidos` con la dimensión `Entorno=prod`', hint: ['aws cloudwatch put-metric-data --namespace Tienda --metric-name Pedidos --value 4 --unit Count --dimensions Name=Entorno,Value=prod'], check: (c) => c.s.metricData.filter((m) => m.ns === 'Tienda' && m.name === 'Pedidos' && m.dims.Entorno === 'prod').map((m) => m.value).sort().join(',') === '4,5,7' || 'Faltan los tres puntos de datos 4, 5 y 7 en Tienda/Pedidos con Entorno=prod.' },
        { id: 'list', title: 'Comprueba con `list-metrics` que la métrica existe', hint: ['aws cloudwatch list-metrics --namespace Tienda'], check: (c) => c.trail('ListMetrics', { error: false }).length > 0 || 'Aún no has ejecutado list-metrics.' },
        { id: 'sum', title: 'Calcula la suma con `get-metric-statistics` y guárdala en `~/pedidos.txt`', hint: ['Necesitas --start-time, --end-time y un --period múltiplo de 60.', "aws cloudwatch get-metric-statistics … --statistics Sum --query 'Datapoints[0].Sum' --output text > ~/pedidos.txt", "Para las fechas: $(date -u -d '-10 minutes' +%FT%TZ) y $(date -u -d '+1 minute' +%FT%TZ)."], check: (c) => /^16(\.0)?$/.test(c.file('pedidos.txt')?.trim() ?? '') || '~/pedidos.txt debe contener la suma, 16.' },
      ],
      script: [
        'aws cloudwatch put-metric-data --namespace Tienda --metric-name Pedidos --value 4 --unit Count --dimensions Name=Entorno,Value=prod',
        'aws cloudwatch put-metric-data --namespace Tienda --metric-name Pedidos --value 5 --unit Count --dimensions Name=Entorno,Value=prod',
        'aws cloudwatch put-metric-data --namespace Tienda --metric-name Pedidos --value 7 --unit Count --dimensions Name=Entorno,Value=prod',
        'aws cloudwatch list-metrics --namespace Tienda',
        "aws cloudwatch get-metric-statistics --namespace Tienda --metric-name Pedidos --dimensions Name=Entorno,Value=prod --start-time $(date -u -d '-10 minutes' +%FT%TZ) --end-time $(date -u -d '+1 minute' +%FT%TZ) --period 600 --statistics Sum --query 'Datapoints[0].Sum' --output text > ~/pedidos.txt",
        'cat ~/pedidos.txt',
      ],
      realWorld: 'En tu cuenta real las métricas personalizadas cuestan unos **0,30 USD por métrica al mes** (las primeras 10 son gratis) y cada dimensión distinta cuenta como otra métrica: no uses identificadores de alta cardinalidad como dimensión. `put-metric-data` admite hasta 1 000 puntos por llamada. **Limpieza:** las métricas personalizadas no se pueden borrar; caducan solas 15 meses después del último dato, y dejan de cobrarse al no recibir datos.',
    },
    {
      id: 'l06-e2',
      title: 'Alarma de CPU con aviso por SNS',
      summary: 'Una instancia está al límite: crea la alarma y el canal de notificación.',
      difficulty: 'Media',
      minutes: 18,
      saa: [SAA_DOMAINS[2]],
      tags: ['CloudWatch', 'Alarmas', 'SNS', 'EC2'],
      scenario: 'La instancia `web-carga` está sometida a mucha carga. Operaciones quiere enterarse: crea el tema de SNS `alertas-ops`, suscribe a `ops@example.com` y crea la alarma `cpu-alta-web` (CPU media **mayor de 80 %** en un periodo de 5 minutos) que **publique en el tema** cuando se dispare. Comprueba que pasa a `ALARM` y que el tema ha recibido el aviso.',
      setup: async (sh) => {
        await prep(sh, [`aws ec2 run-instances --image-id ${AMI} --instance-type t3.micro --tag-specifications ${TAGS('{Key=Name,Value=web-carga},{Key=simulador:carga,Value=alta}')}`]);
      },
      steps: [
        { id: 'topic', title: 'Crea el tema `alertas-ops` y suscribe el correo `ops@example.com`', hint: ['aws sns create-topic --name alertas-ops', 'aws sns subscribe --topic-arn <arn> --protocol email --notification-endpoint ops@example.com'], check: (c) => { const t = c.topic('alertas-ops'); if (!t) return 'Falta el tema alertas-ops.'; return t.subs.some((x) => x.protocol === 'email' && x.endpoint === 'ops@example.com') || 'Falta la suscripción de correo a ops@example.com.'; } },
        { id: 'alarm', title: 'Crea `cpu-alta-web`: `CPUUtilization` media > 80, periodo 300 s, con acción de alarma hacia el tema', hint: ["Obtén el ID: aws ec2 describe-instances --filters Name=tag:Name,Values=web-carga --query 'Reservations[0].Instances[0].InstanceId' --output text", 'aws cloudwatch put-metric-alarm --alarm-name cpu-alta-web --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value=<id> --statistic Average --period 300 --evaluation-periods 1 --threshold 80 --comparison-operator GreaterThanThreshold --alarm-actions <arn del tema>'], check: (c) => { const a = c.alarm('cpu-alta-web'); const i = c.instance((x) => x.tags.Name === 'web-carga'); const t = c.topic('alertas-ops'); if (!a) return 'Falta la alarma cpu-alta-web.'; if (a.namespace !== 'AWS/EC2' || a.metric !== 'CPUUtilization' || a.dims.InstanceId !== i?.id) return 'La alarma debe vigilar CPUUtilization de la instancia web-carga.'; if (a.threshold !== 80 || a.period !== 300 || !a.operator.startsWith('GreaterThan')) return 'El umbral debe ser > 80 con periodo de 300 segundos.'; return (!!t && a.alarmActions.includes(t.arn)) || 'La alarma debe tener como acción de alarma el tema alertas-ops.'; } },
        { id: 'fire', title: 'Verifica con `describe-alarms` que la alarma está en `ALARM` y que el tema recibió la notificación', hint: ['La alarma tarda unos segundos en evaluarse tras crearla; repite el comando.', 'aws cloudwatch describe-alarm-history --alarm-name cpu-alta-web muestra la acción ejecutada.'], check: (c) => { const a = c.alarm('cpu-alta-web'); if (a?.state !== 'ALARM') return 'La alarma todavía no está en ALARM.'; if (!c.topic('alertas-ops')?.messages.some((m) => m.source === 'cloudwatch')) return 'El tema no ha recibido ninguna notificación de la alarma.'; return c.ran(/cloudwatch\s+describe-alarm(s|-history)/) || 'Consulta la alarma con describe-alarms o describe-alarm-history.'; } },
      ],
      script: [
        "INST=$(aws ec2 describe-instances --filters Name=tag:Name,Values=web-carga --query 'Reservations[0].Instances[0].InstanceId' --output text)",
        'TOPIC=$(aws sns create-topic --name alertas-ops --query TopicArn --output text)',
        'aws sns subscribe --topic-arn $TOPIC --protocol email --notification-endpoint ops@example.com',
        'aws cloudwatch put-metric-alarm --alarm-name cpu-alta-web --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value=$INST --statistic Average --period 300 --evaluation-periods 1 --threshold 80 --comparison-operator GreaterThanThreshold --alarm-actions $TOPIC',
        "aws cloudwatch describe-alarms --alarm-names cpu-alta-web --query 'MetricAlarms[].[AlarmName,StateValue]' --output text",
        'aws cloudwatch describe-alarm-history --alarm-name cpu-alta-web --query AlarmHistoryItems[].HistorySummary',
      ],
      realWorld: 'En tu cuenta real una alarma estándar cuesta **0,10 USD al mes** y SNS tiene un millón de publicaciones gratis. El destinatario del correo debe **confirmar la suscripción**, o no recibirá nada. Para producción añade acciones de `OK`, un periodo de evaluación mayor para evitar falsos positivos y, en EC2, la acción automática de recuperación. En **aws-secure-infrastructure** define `aws_cloudwatch_metric_alarm` y `aws_sns_topic` en Terraform. **Limpieza:** `delete-alarms`, `unsubscribe` y `delete-topic`.',
    },
    {
      id: 'l06-e3',
      title: 'De registros a alarma: errores de la API',
      summary: 'Cuenta los ERROR de un grupo de registros, avísate y limita su retención.',
      difficulty: 'Difícil',
      minutes: 22,
      saa: [SAA_DOMAINS[2], SAA_DOMAINS[4]],
      tags: ['CloudWatch Logs', 'Filtros de métricas', 'Alarmas'],
      scenario: 'La API de la tienda escribe en `/tienda/api`. Quieres una alarma cuando haya **al menos 2 errores** en un minuto. Crea el grupo y el flujo `i-001`, un **filtro de métrica** que cuente las líneas con `ERROR` en `Tienda/ErroresApi`, publica tres líneas (dos de ellas `ERROR`), crea la alarma `api-errores` y limita la retención del grupo a **14 días** para no pagar almacenamiento de más.',
      steps: [
        { id: 'group', title: 'Crea el grupo `/tienda/api` y el flujo `i-001`', hint: ['aws logs create-log-group --log-group-name /tienda/api', 'aws logs create-log-stream --log-group-name /tienda/api --log-stream-name i-001'], check: (c) => c.logGroup('/tienda/api')?.streams.some((s) => s.name === 'i-001') || 'Falta el grupo /tienda/api con el flujo i-001.' },
        { id: 'filter', title: 'Crea un filtro de métrica con patrón `ERROR` que publique `Tienda/ErroresApi`', hint: ['aws logs put-metric-filter --log-group-name /tienda/api --filter-name errores --filter-pattern ERROR --metric-transformations metricName=ErroresApi,metricNamespace=Tienda,metricValue=1'], check: (c) => c.logGroup('/tienda/api')?.filters.some((f) => f.pattern === 'ERROR' && f.ns === 'Tienda' && f.metric === 'ErroresApi') || 'Falta el filtro de métrica ERROR hacia Tienda/ErroresApi.' },
        { id: 'events', title: 'Publica tres líneas (dos con `ERROR`) y comprueba que la métrica recibe dos puntos', hint: ['aws logs put-log-events --log-group-name /tienda/api --log-stream-name i-001 --log-events timestamp=$(date +%s%3N),message="ERROR no se pudo conectar a la base de datos"', 'Cada comando publica uno o varios eventos; repítelo para tener dos ERROR y una línea INFO.'], check: (c) => { const g = c.logGroup('/tienda/api'); const n = g?.streams.flatMap((s) => s.events).filter((e) => e.message.includes('ERROR')).length ?? 0; return (n >= 2 && c.s.metricData.filter((m) => m.ns === 'Tienda' && m.name === 'ErroresApi').length >= 2) || 'Publica al menos dos líneas con ERROR después de crear el filtro.'; } },
        { id: 'alarm', title: 'Crea `api-errores` (`Sum` >= 2 en 60 s, datos faltantes `notBreaching`) y comprueba que está en `ALARM`', hint: ['aws cloudwatch put-metric-alarm --alarm-name api-errores --namespace Tienda --metric-name ErroresApi --statistic Sum --period 60 --evaluation-periods 1 --threshold 2 --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching'], check: (c) => { const a = c.alarm('api-errores'); if (!a) return 'Falta la alarma api-errores.'; if (a.namespace !== 'Tienda' || a.metric !== 'ErroresApi' || a.treatMissing !== 'notBreaching') return 'La alarma debe vigilar Tienda/ErroresApi con TreatMissingData=notBreaching.'; return a.state === 'ALARM' || 'La alarma aún no está en ALARM (¿publicaste los dos ERROR dentro del último minuto?).'; } },
        { id: 'ret', title: 'Fija la retención del grupo en 14 días', hint: ['aws logs put-retention-policy --log-group-name /tienda/api --retention-in-days 14'], check: (c) => c.logGroup('/tienda/api')?.retention === 14 || 'La retención del grupo no es de 14 días.' },
      ],
      script: [
        'aws logs create-log-group --log-group-name /tienda/api',
        'aws logs create-log-stream --log-group-name /tienda/api --log-stream-name i-001',
        'aws logs put-metric-filter --log-group-name /tienda/api --filter-name errores --filter-pattern ERROR --metric-transformations metricName=ErroresApi,metricNamespace=Tienda,metricValue=1',
        'aws logs put-log-events --log-group-name /tienda/api --log-stream-name i-001 --log-events timestamp=$(date +%s%3N),message="INFO pedido 1042 creado" timestamp=$(date +%s%3N),message="ERROR no se pudo conectar a la base de datos" timestamp=$(date +%s%3N),message="ERROR tiempo de espera agotado"',
        'aws cloudwatch put-metric-alarm --alarm-name api-errores --namespace Tienda --metric-name ErroresApi --statistic Sum --period 60 --evaluation-periods 1 --threshold 2 --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching',
        'aws logs put-retention-policy --log-group-name /tienda/api --retention-in-days 14',
        "aws cloudwatch describe-alarms --alarm-names api-errores --query 'MetricAlarms[].[AlarmName,StateValue]' --output text",
        'aws logs filter-log-events --log-group-name /tienda/api --filter-pattern ERROR --query events[].message',
      ],
      realWorld: 'En tu cuenta real el filtro de métrica solo cuenta los eventos **posteriores** a su creación, y los registros cuestan alrededor de 0,50 USD por GB ingerido más el almacenamiento. Con `logs tail --follow` ves los eventos en directo, y **Logs Insights** permite consultas más potentes. En una aplicación real, el agente de CloudWatch o la propia Lambda envían los registros. **Limpieza:** `delete-metric-filter`, `delete-log-group` y `delete-alarms`.',
    },
    {
      id: 'l06-e4',
      title: 'Diagnostica una alarma en «Datos insuficientes»',
      summary: 'La alarma de CPU no informa desde esta mañana: encuentra la causa y devuélvela a OK.',
      difficulty: 'Reto',
      minutes: 15,
      saa: [SAA_DOMAINS[2]],
      tags: ['CloudWatch', 'Diagnóstico', 'EC2'],
      scenario: 'La alarma `cpu-web-1` aparece en **Datos insuficientes** desde esta mañana y nadie sabe por qué: la métrica existe y la configuración parece correcta. **Averigua la causa con `describe-alarms`, las estadísticas y el estado de la instancia, corrígela y comprueba que la alarma vuelve a `OK`.**',
      setup: async (sh) => {
        await prep(sh, [
          `INST=$(aws ec2 run-instances --image-id ${AMI} --instance-type t3.micro --tag-specifications ${TAGS('{Key=Name,Value=web-1}')} --query Instances[0].InstanceId --output text)`,
          'aws ec2 stop-instances --instance-ids $INST',
          'aws cloudwatch put-metric-alarm --alarm-name cpu-web-1 --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value=$INST --statistic Average --period 300 --evaluation-periods 1 --threshold 80 --comparison-operator GreaterThanThreshold',
        ]);
        // La instancia se detuvo hace dos horas, no hace unos segundos.
        for (const i of sh.s.instances) {
          i.state = 'stopped'; // ya parada de hace rato (no «stopping»): el alumno puede arrancarla de inmediato
          i.transition = undefined;
          i.runPeriods = (i.runPeriods ?? []).map((p) => ({ from: p.from - 7_200_000, to: p.to - 7_200_000 }));
          i.launchTime = new Date(Date.parse(i.launchTime) - 7_200_000).toISOString();
        }
        for (const a of sh.s.alarms) { a.holdUntil = undefined; }
      },
      steps: [
        { id: 'see', title: 'Consulta la alarma y lee su `StateReason`', hint: ["aws cloudwatch describe-alarms --alarm-names cpu-web-1 --query 'MetricAlarms[].[StateValue,StateReason]' --output text"], check: (c) => c.trail('DescribeAlarms', { error: false }).length > 0 || 'Aún no has consultado la alarma con describe-alarms.' },
        { id: 'stats', title: 'Comprueba si la métrica tiene datos en las últimas horas', hint: ['aws cloudwatch get-metric-statistics --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value=<id> --start-time … --end-time … --period 300 --statistics Average', 'Sin datos devuelve `Datapoints: []`.'], check: (c) => c.trail('GetMetricStatistics', { error: false }).length > 0 || 'Aún no has consultado las estadísticas de la métrica.' },
        { id: 'inst', title: 'Mira el estado de la instancia `web-1`', hint: ["aws ec2 describe-instances --filters Name=tag:Name,Values=web-1 --query 'Reservations[].Instances[].State.Name' --output text"], check: (c) => c.trail('DescribeInstances', { error: false }).length > 0 || 'Aún no has consultado el estado de la instancia.' },
        { id: 'fix', title: 'Arranca la instancia', hint: ['aws ec2 start-instances --instance-ids <id>'], check: (c) => c.instance((x) => x.tags.Name === 'web-1' && (x.state === 'running' || x.state === 'pending')) ? true : 'La instancia web-1 sigue parada.' },
        { id: 'ok', title: 'Comprueba que `cpu-web-1` vuelve a `OK`', hint: ['La alarma tarda unos segundos en reevaluarse; repite describe-alarms.'], check: (c) => c.alarm('cpu-web-1')?.state === 'OK' || 'La alarma todavía no está en OK.' },
      ],
      script: [
        "aws cloudwatch describe-alarms --alarm-names cpu-web-1 --query 'MetricAlarms[].[StateValue,StateReason]' --output text",
        "aws cloudwatch get-metric-statistics --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value=$INST --start-time $(date -u -d '-3 hours' +%FT%TZ) --end-time $(date -u +%FT%TZ) --period 300 --statistics Average --query Datapoints",
        "aws ec2 describe-instances --filters Name=tag:Name,Values=web-1 --query 'Reservations[].Instances[].State.Name' --output text",
        'aws ec2 start-instances --instance-ids $INST',
        'sleep 20',
        "aws cloudwatch describe-alarms --alarm-names cpu-web-1 --query 'MetricAlarms[].[AlarmName,StateValue]' --output text",
      ],
      solution: 'El `StateReason` dice *«Insufficient Data: 1 datapoint was unknown»*: la alarma funciona, pero **no llegan datos**. Las estadísticas de `CPUUtilization` salen vacías y `describe-instances` muestra que `web-1` está **parada** desde hace horas: una instancia detenida no publica métricas. Al arrancarla vuelven los datos y la alarma pasa a `OK`. (Si la parada fuera normal, la alternativa es `--treat-missing-data notBreaching`.)\n\n```bash\naws cloudwatch describe-alarms --alarm-names cpu-web-1 --query \'MetricAlarms[].[StateValue,StateReason]\' --output text\naws ec2 describe-instances --filters Name=tag:Name,Values=web-1 --query \'Reservations[].Instances[].State.Name\' --output text\naws ec2 start-instances --instance-ids $INST\naws cloudwatch describe-alarms --alarm-names cpu-web-1 --query \'MetricAlarms[].[AlarmName,StateValue]\' --output text\n```',
      realWorld: 'En una cuenta real sigue el mismo orden: **StateReason → métrica con datos → estado del recurso → política de datos faltantes**. Otras causas frecuentes de `INSUFFICIENT_DATA` son una dimensión equivocada, una región diferente o una métrica que la aplicación solo publica ante eventos. Con CloudTrail verás quién paró la instancia (`StopInstances`). **Limpieza:** termina la instancia de prueba y borra la alarma.',
    },
  ],
  quiz: [
    { domain: 2, q: 'Una alarma de CloudWatch aparece en INSUFFICIENT_DATA. ¿Qué significa?', options: ['La métrica supera el umbral', 'No hay suficientes puntos de datos para evaluar la condición', 'Se ha eliminado la métrica', 'El tema de SNS no existe'], answer: 1, explain: 'La alarma no recibe suficientes datos: acaba de crearse, el recurso está parado o la aplicación no publica la métrica.' },
    { domain: 1, q: 'Quieres saber qué usuario terminó una instancia EC2 ayer. ¿Qué servicio consultas?', options: ['CloudWatch Metrics', 'CloudTrail', 'CloudWatch Logs Insights sobre la instancia', 'AWS Budgets'], answer: 1, explain: 'CloudTrail registra las llamadas a la API (TerminateInstances) con quién, cuándo y desde dónde.' },
    { domain: 4, q: 'Los grupos de registros de CloudWatch están creciendo y encareciendo la factura. ¿Qué haces primero?', options: ['Borrar las alarmas', 'Configurar una retención adecuada en cada grupo', 'Cambiar de región', 'Desactivar CloudTrail'], answer: 1, explain: 'Por defecto los registros no caducan. Una política de retención elimina lo antiguo; para conservar a largo plazo y barato, se exporta a S3.' },
    { domain: 3, q: 'Necesitas ver el uso de memoria de tus instancias EC2 en CloudWatch. ¿Qué haces?', options: ['Está disponible por defecto', 'Instalar y configurar el agente de CloudWatch', 'Activar el monitoreo detallado', 'Usar CloudTrail'], answer: 1, explain: 'EC2 publica CPU, red y disco sin agente, pero la memoria y el espacio en disco requieren el agente de CloudWatch.' },
    { domain: 2, q: 'Quieres que el equipo reciba un correo cuando la CPU de un servidor supere el 80 %. ¿Cuál es la arquitectura habitual?', options: ['Alarma de CloudWatch con acción hacia un tema de SNS suscrito al correo', 'Una Lambda que lee la métrica cada segundo', 'Un bucket de S3 con notificaciones', 'Un registro de Route 53'], answer: 0, explain: 'La alarma cambia a ALARM y publica en SNS; los suscriptores (correo, SMS, Lambda) reciben el aviso.' },
    { domain: 1, q: 'Tu aplicación escribe «ERROR» en sus registros y quieres una alarma cuando haya muchos. ¿Qué configuras?', options: ['Un filtro de métrica sobre el grupo de registros y una alarma sobre la métrica', 'Una regla de seguridad en el SG', 'Una política de bucket', 'Un volumen de EBS más grande'], answer: 0, explain: 'Un filtro de métrica convierte las coincidencias en una métrica de CloudWatch sobre la que se define la alarma.' },
    { domain: 3, q: '¿Cada cuánto publica EC2 sus métricas con monitoreo básico y con detallado?', options: ['1 minuto y 1 segundo', '5 minutos y 1 minuto', '15 minutos y 5 minutos', '1 hora y 5 minutos'], answer: 1, explain: 'El monitoreo básico (gratis) es cada 5 minutos; el detallado, de pago, cada minuto.' },
    { domain: 2, q: 'Una instancia debe recuperarse automáticamente si falla la comprobación de estado del sistema. ¿Cómo lo automatizas?', options: ['Con una alarma de CloudWatch sobre StatusCheckFailed_System con la acción de recuperación de EC2', 'Reiniciándola cada noche con cron', 'Con un snapshot diario', 'Con una NACL'], answer: 0, explain: 'Las alarmas pueden ejecutar acciones EC2 (reiniciar, detener, terminar o recuperar) sin intervención humana.' },
  ],
};

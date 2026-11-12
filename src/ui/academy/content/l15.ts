import { SAA_DOMAINS, type Level } from '../types';
import { prep } from '../setup';
import type { CheckCtx } from '../checks';
import tuberias from './l15/1-tuberias-filtros.md?raw';
import grepsed from './l15/2-grep-sed-jq.md?raw';
import scripts from './l15/3-scripts.md?raw';
import permisos from './l15/4-permisos-cron.md?raw';

const lines = (c: CheckCtx, path: string): string[] => (c.file(path) ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
const has = (c: CheckCtx, path: string) => c.file(path) !== null;

// ---------------------------------------------------------------- escenarios
const LOG_SETUP = [
  'for i in 1 2 3 4 5 6; do echo "10.0.0.7 GET /index 200" >> acceso.log; done',
  'for i in 1 2 3; do echo "10.0.0.9 POST /api 500" >> acceso.log; done',
  'echo "10.0.0.4 GET /api 503" >> acceso.log',
  'echo "10.0.0.4 GET /index 200" >> acceso.log',
  'echo "10.0.0.2 GET /logo 404" >> acceso.log',
];
const CONF_SETUP = [
  "printf '# configuración de la aplicación\\nregion=us-east-1\\nbucket=datos-ana\\n# credenciales\\npassword=hunter2\\nlog_level=debug\\n' > app.conf",
];
const BUCKETS_SETUP = ['aws s3 mb s3://prod-datos-ana-001', 'aws s3 mb s3://prod-logs-ana-001', 'aws s3 mb s3://test-pruebas-ana-001'];
const PERMS_SETUP = [
  "printf -- '-----BEGIN KEY-----\\nabc\\n' > clave.pem",
  "printf '#!/bin/bash\\necho desplegando\\n' > deploy.sh",
  'mkdir secretos && echo token > secretos/api.token',
];
const CRON_SETUP = ["printf '#!/bin/bash\\naws s3 ls\\n' > copia.sh"];

export const l15: Level = {
  id: 15,
  slug: 'linux-bash',
  title: 'Linux y Bash',
  subtitle: 'Tuberías, grep/sed/awk/jq, scripts con bucles, permisos y cron: la navaja suiza de cualquier ingeniero cloud.',
  skills: ['Tuberías y filtros de texto', 'grep, sed, awk y jq', 'Scripts: variables, if y for', 'Permisos de ficheros (chmod)', 'Tareas programadas con cron', 'Automatizar la AWS CLI'],
  lessons: [
    { id: 'l15-tuberias', title: 'Tuberías y filtros', minutes: 8, body: tuberias },
    { id: 'l15-grep-sed-jq', title: 'grep, sed y jq', minutes: 8, body: grepsed },
    { id: 'l15-scripts', title: 'Scripts con variables y bucles', minutes: 10, body: scripts },
    { id: 'l15-permisos-cron', title: 'Permisos y cron', minutes: 8, body: permisos },
  ],
  exercises: [
    {
      id: 'l15-e1',
      title: 'Quién llama más a tu servidor',
      summary: 'Analiza un log de accesos con grep, awk, sort y uniq.',
      difficulty: 'Fácil',
      minutes: 10,
      saa: [SAA_DOMAINS[1]],
      tags: ['Bash', 'grep', 'awk', 'tuberías'],
      scenario: 'En tu carpeta personal hay un `acceso.log` con líneas `IP MÉTODO RUTA ESTADO`. Hay un pico de errores: cuenta las respuestas 5xx y guarda el número en `errores.txt`, guarda en `top-ips.txt` las 3 IP más activas con su recuento (formato `uniq -c`) y la lista de IP distintas ordenadas en `ips.txt`.',
      setup: (sh) => prep(sh, LOG_SETUP),
      steps: [
        { id: 'err', title: 'Guarda en `errores.txt` el número de respuestas 5xx', hint: ["grep -cE ' 5[0-9][0-9]$' acceso.log > errores.txt"], check: (c) => c.file('errores.txt')?.trim() === '4' || 'errores.txt no existe o no contiene el número correcto de errores 5xx.' },
        { id: 'top', title: 'Guarda las 3 IP más activas en `top-ips.txt`', hint: ["Extrae la columna: awk '{print $1}' acceso.log", 'Cuenta con sort | uniq -c, ordena con sort -rn y recorta con head -n 3'], check: (c) => { const l = lines(c, 'top-ips.txt'); return (l.length === 3 && /^6\s+10\.0\.0\.7$/.test(l[0])) || 'top-ips.txt debe tener 3 líneas y empezar por la IP más activa con su recuento.'; } },
        { id: 'uniq', title: 'Guarda las IP distintas, ordenadas, en `ips.txt`', hint: ["awk '{print $1}' acceso.log | sort -u > ips.txt"], check: (c) => { const l = lines(c, 'ips.txt'); return (l.length === 4 && l[0] === '10.0.0.2') || 'ips.txt debe tener las 4 IP distintas ordenadas.'; } },
      ],
      script: [
        "grep -cE ' 5[0-9][0-9]$' acceso.log > errores.txt",
        "awk '{print $1}' acceso.log | sort | uniq -c | sort -rn | head -n 3 > top-ips.txt",
        "awk '{print $1}' acceso.log | sort -u > ips.txt",
        'cat top-ips.txt',
      ],
      realWorld: 'Es exactamente lo que harías con los logs de acceso de un balanceador volcados a S3 o con los VPC Flow Logs. Con volúmenes grandes pasarías a Athena o CloudWatch Logs Insights, pero estos filtros siguen siendo la primera herramienta. **Limpieza:** no hay recursos en AWS; borra los ficheros con `rm acceso.log errores.txt top-ips.txt ips.txt`.',
    },
    {
      id: 'l15-e2',
      title: 'Arreglar una configuración con sed',
      summary: 'Cambia la región, quita comentarios y genera una copia sin secretos.',
      difficulty: 'Fácil',
      minutes: 10,
      saa: [SAA_DOMAINS[1]],
      tags: ['Bash', 'sed', 'grep', 'secretos'],
      scenario: 'La aplicación usa `app.conf` y apunta a `us-east-1`, pero debe usar `eu-west-1`. Edita el fichero **en el sitio** con `sed -i`, elimina las líneas de comentario y crea `app.publico.conf`, una copia sin la línea de la contraseña, para poder compartirla en el repositorio.',
      setup: (sh) => prep(sh, CONF_SETUP),
      steps: [
        { id: 'reg', title: 'Cambia `us-east-1` por `eu-west-1` en `app.conf`', hint: ["sed -i 's/us-east-1/eu-west-1/' app.conf"], check: (c) => { const f = c.file('app.conf') ?? ''; return (/region=eu-west-1/.test(f) && !/us-east-1/.test(f)) || 'app.conf todavía apunta a us-east-1.'; } },
        { id: 'coment', title: 'Elimina las líneas que empiezan por `#`', hint: ["sed -i '/^#/d' app.conf"], check: (c) => { const f = c.file('app.conf') ?? ''; return (f.includes('bucket=') && !/^#/m.test(f)) || 'app.conf todavía tiene comentarios (o lo has vaciado).'; } },
        { id: 'pub', title: 'Crea `app.publico.conf` sin la línea `password`', hint: ['grep -v password app.conf > app.publico.conf'], check: (c) => { const f = c.file('app.publico.conf'); return (f !== null && /region=eu-west-1/.test(f) && !/password/.test(f)) || 'Falta app.publico.conf, o todavía contiene la contraseña.'; } },
      ],
      script: ["sed -i 's/us-east-1/eu-west-1/' app.conf", "sed -i '/^#/d' app.conf", 'grep -v password app.conf > app.publico.conf', 'cat app.publico.conf'],
      realWorld: 'Las contraseñas **nunca** van a un repositorio: usa Secrets Manager o Parameter Store (nivel de KMS y secretos) y deja en el repositorio solo ficheros sin secretos. `sed -i` modifica sin pedir confirmación: usa `-i.bak` para conservar copia. **Limpieza:** no hay recursos en AWS; borra los ficheros `app.conf` y `app.publico.conf`.',
    },
    {
      id: 'l15-e3',
      title: 'Inventario de buckets con jq',
      summary: 'Convierte el JSON de la AWS CLI en listas de texto filtradas.',
      difficulty: 'Media',
      minutes: 12,
      saa: [SAA_DOMAINS[1]],
      tags: ['Bash', 'jq', 'S3', 'CLI'],
      scenario: 'La cuenta tiene buckets de producción (`prod-`) y de pruebas (`test-`). Para auditar, guarda en `buckets.txt` los nombres de **todos** los buckets (uno por línea, ordenados), usando `jq` sobre la salida JSON de `list-buckets`, y en `prod-buckets.txt` solo los de producción.',
      setup: (sh) => prep(sh, BUCKETS_SETUP),
      steps: [
        { id: 'todos', title: 'Guarda los nombres de todos los buckets en `buckets.txt`', hint: ['aws s3api list-buckets --output json | jq -r ".Buckets[].Name" | sort > buckets.txt', '`-r` quita las comillas de la salida de jq'], check: (c) => { const l = lines(c, 'buckets.txt'); return (['prod-datos-ana-001', 'prod-logs-ana-001', 'test-pruebas-ana-001'].every((n) => l.includes(n)) && !l.some((x) => x.includes('"'))) || 'buckets.txt no contiene los nombres limpios de todos los buckets.'; } },
        { id: 'prod', title: 'Guarda solo los `prod-` en `prod-buckets.txt`', hint: ["grep '^prod-' buckets.txt > prod-buckets.txt"], check: (c) => { const l = lines(c, 'prod-buckets.txt'); return (l.length === 2 && l.every((x) => x.startsWith('prod-'))) || 'prod-buckets.txt debe tener exactamente los 2 buckets de producción.'; } },
        { id: 'cuenta', title: 'Guarda en `n-prod.txt` cuántos buckets de producción hay (`wc -l`)', hint: ['wc -l < prod-buckets.txt > n-prod.txt'], check: (c) => c.file('n-prod.txt')?.trim() === '2' || 'n-prod.txt no existe o no contiene el recuento correcto.' },
      ],
      script: ['aws s3api list-buckets --output json | jq -r ".Buckets[].Name" | sort > buckets.txt', "grep '^prod-' buckets.txt > prod-buckets.txt", 'wc -l < prod-buckets.txt > n-prod.txt', 'cat n-prod.txt'],
      realWorld: 'Un inventario así sirve para auditorías (¿qué buckets hay y cuáles son públicos?). Con muchos recursos usa `--query` para filtrar en el servidor. **Limpieza:** elimina los buckets con `aws s3 rb s3://<nombre>` y borra los ficheros de texto.',
    },
    {
      id: 'l15-e4',
      title: 'Tu primer script de inventario',
      summary: 'Escribe un script con un bucle `for`, hazlo ejecutable y lánzalo.',
      difficulty: 'Media',
      minutes: 15,
      saa: [SAA_DOMAINS[4]],
      tags: ['Bash', 'scripts', 'for', 'chmod'],
      scenario: 'Quieres repetir el inventario cada semana. Crea el script `inventario.sh` (con shebang `#!/bin/bash`) que recorra los buckets con un bucle `for` e imprima `bucket: <nombre>` por cada uno. Dale permiso de ejecución, lánzalo con `./inventario.sh` y guarda la salida en `inventario.txt`.',
      setup: (sh) => prep(sh, BUCKETS_SETUP),
      steps: [
        { id: 'sh', title: 'Crea `inventario.sh` con shebang y un bucle `for`', hint: ["printf '#!/bin/bash\\nfor b in $(aws s3api list-buckets --query \"Buckets[].Name\" --output text); do\\n  echo \"bucket: $b\"\\ndone\\n' > inventario.sh"], check: (c) => { const f = c.file('inventario.sh') ?? ''; return (f.startsWith('#!/bin/bash') && /\bfor\b/.test(f) && /\bdone\b/.test(f)) || 'inventario.sh no existe o le falta el shebang o el bucle for.'; } },
        { id: 'x', title: 'Dale permiso de ejecución', hint: ['chmod +x inventario.sh'], check: (c) => { const m = c.fileMode('inventario.sh'); return (m !== null && (m & 0o111) !== 0) || 'inventario.sh todavía no es ejecutable.'; } },
        { id: 'run', title: 'Ejecútalo con `./inventario.sh` y guarda la salida en `inventario.txt`', hint: ['./inventario.sh > inventario.txt'], check: (c) => { const l = lines(c, 'inventario.txt'); return (l.length >= 3 && l.includes('bucket: prod-datos-ana-001')) || 'inventario.txt no existe o no contiene la salida del script.'; } },
      ],
      script: [
        "printf '#!/bin/bash\\nfor b in $(aws s3api list-buckets --query \"Buckets[].Name\" --output text); do\\n  echo \"bucket: $b\"\\ndone\\n' > inventario.sh",
        'chmod +x inventario.sh',
        './inventario.sh > inventario.txt',
        'cat inventario.txt',
      ],
      realWorld: 'Los scripts pequeños son el primer paso de la automatización; después llegan Terraform, Lambda y EventBridge. Antes de que un script borre recursos, imprime primero lo que va a borrar. **Limpieza:** elimina los buckets con `aws s3 rb s3://<nombre>` y borra `inventario.sh` e `inventario.txt`.',
    },
    {
      id: 'l15-e5',
      title: 'Permisos: la clave que SSH rechaza',
      summary: 'Ajusta los permisos de una clave, un script y una carpeta de secretos.',
      difficulty: 'Fácil',
      minutes: 8,
      saa: [SAA_DOMAINS[1]],
      tags: ['Linux', 'chmod', 'permisos', 'seguridad'],
      scenario: 'Descargaste `clave.pem` con permisos abiertos (644) y `ssh` la rechaza. Además `deploy.sh` no se puede ejecutar y la carpeta `secretos/` la puede leer cualquier usuario. Corrige: la clave a `600`, el script ejecutable y la carpeta a `700`. Comprueba el resultado con `ls -l` y guarda con `find` la lista de ficheros en modo `600` en `modo600.txt`.',
      setup: (sh) => prep(sh, PERMS_SETUP),
      steps: [
        { id: 'pem', title: 'Deja `clave.pem` en modo `600`', hint: ['chmod 600 clave.pem'], check: (c) => c.fileMode('clave.pem') === 0o600 || 'clave.pem todavía no tiene el modo 600.' },
        { id: 'dep', title: 'Haz ejecutable `deploy.sh`', hint: ['chmod +x deploy.sh'], check: (c) => { const m = c.fileMode('deploy.sh'); return (m !== null && (m & 0o100) !== 0) || 'deploy.sh todavía no es ejecutable.'; } },
        { id: 'dir', title: 'Deja la carpeta `secretos` en modo `700`', hint: ['chmod 700 secretos'], check: (c) => c.fileMode('secretos') === 0o700 || 'La carpeta secretos todavía no tiene el modo 700.' },
        { id: 'ver', title: 'Verifica con `find`: guarda en `modo600.txt` los ficheros con modo 600', hint: ['find . -type f -perm 600 > modo600.txt'], check: (c) => /clave\.pem/.test(c.file('modo600.txt') ?? '') || 'modo600.txt no existe o no lista clave.pem.' },
      ],
      script: ['chmod 600 clave.pem', 'chmod +x deploy.sh', 'chmod 700 secretos', 'ls -l', 'find . -type f -perm 600 > modo600.txt'],
      realWorld: 'SSH exige que la clave privada de un par de claves de EC2 sea `400` o `600`; si no, responde «UNPROTECTED PRIVATE KEY FILE». Nunca subas claves a un repositorio: usa Systems Manager Session Manager para evitarlas. **Limpieza:** no hay recursos en AWS; borra `clave.pem`, `deploy.sh` y `secretos/` con `rm -r`.',
    },
    {
      id: 'l15-e6',
      title: 'Programar una copia con cron',
      summary: 'Haz ejecutable un script y planifícalo cada noche con crontab.',
      difficulty: 'Media',
      minutes: 10,
      saa: [SAA_DOMAINS[2]],
      tags: ['Linux', 'cron', 'automatización'],
      scenario: 'Hay un script `copia.sh` que lista los buckets. Debe ejecutarse **cada día a las 02:30**. Hazlo ejecutable, escribe una línea de cron con la ruta absoluta del script (usa `$HOME`) y redirige su salida a `copia.log`, instálala con `crontab` y guarda la salida de `crontab -l` en `crontab-actual.txt`.',
      setup: (sh) => prep(sh, CRON_SETUP),
      steps: [
        { id: 'x', title: 'Haz ejecutable `copia.sh`', hint: ['chmod +x copia.sh'], check: (c) => { const m = c.fileMode('copia.sh'); return (m !== null && (m & 0o100) !== 0) || 'copia.sh todavía no es ejecutable.'; } },
        { id: 'line', title: 'Escribe la línea de cron en un fichero (`30 2 * * *`)', hint: ["printf '30 2 * * * %s/copia.sh >> %s/copia.log 2>&1\\n' $HOME $HOME > cron.txt", 'Minuto 30, hora 2, resto asteriscos'], check: (c) => /^30 2 \* \* \* \S*copia\.sh/m.test(c.file('cron.txt') ?? '') || 'cron.txt no contiene una línea 30 2 * * * con la ruta de copia.sh.' },
        { id: 'inst', title: 'Instálala con `crontab`', hint: ['crontab cron.txt'], check: (c) => /^30 2 \* \* \* \S*copia\.sh/m.test(c.file(`/var/spool/cron/crontabs/${c.s.me.userName}`) ?? '') || 'La crontab del usuario todavía no tiene la tarea de copia.sh.' },
        { id: 'list', title: 'Guarda la salida de `crontab -l` en `crontab-actual.txt`', hint: ['crontab -l > crontab-actual.txt'], check: (c) => /copia\.sh/.test(c.file('crontab-actual.txt') ?? '') || 'crontab-actual.txt no existe o no contiene la tarea.' },
      ],
      script: ['chmod +x copia.sh', "printf '30 2 * * * %s/copia.sh >> %s/copia.log 2>&1\\n' $HOME $HOME > cron.txt", 'crontab cron.txt', 'crontab -l > crontab-actual.txt', 'cat crontab-actual.txt'],
      realWorld: 'En una instancia EC2 real, cron funciona igual, pero una tarea periódica en la nube suele ser una **regla programada de EventBridge** que lanza una Lambda, sin servidor que mantener ni zona horaria que olvidar (cron usa la hora local, EventBridge usa UTC). **Limpieza:** elimina la crontab con `crontab -r` y borra los ficheros.',
    },
    {
      id: 'l15-e7',
      title: 'Automatizar la CLI: versionado en todos los buckets de producción',
      summary: 'Un script con `for` e `if` que activa el versionado solo en los buckets `prod-`.',
      difficulty: 'Difícil',
      minutes: 15,
      saa: [SAA_DOMAINS[2]],
      tags: ['Bash', 'S3', 'versionado', 'automatización'],
      scenario: 'La política dice que los buckets de producción deben tener **versionado**. Hay tres buckets (dos `prod-` y uno `test-`). Escribe el script `versionar.sh`: un bucle `for` por los nombres de bucket y un `if` que, solo si empiezan por `prod-`, ejecute `aws s3api put-bucket-versioning`. Hazlo ejecutable y lánzalo. El bucket de pruebas debe quedar intacto.',
      setup: (sh) => prep(sh, BUCKETS_SETUP),
      steps: [
        { id: 'sh', title: 'Crea `versionar.sh` con un `for`, un `if` y `put-bucket-versioning`', hint: ['La condición: if [[ "$b" == prod-* ]]; then ...; fi', 'aws s3api put-bucket-versioning --bucket $b --versioning-configuration Status=Enabled'], check: (c) => { const f = c.file('versionar.sh') ?? ''; return (/\bfor\b/.test(f) && /\bif\b/.test(f) && /put-bucket-versioning/.test(f)) || 'versionar.sh no existe o le falta el for, el if o la llamada put-bucket-versioning.'; } },
        { id: 'x', title: 'Hazlo ejecutable y lánzalo', hint: ['chmod +x versionar.sh', './versionar.sh'], check: (c) => { const m = c.fileMode('versionar.sh'); return (m !== null && (m & 0o100) !== 0 && c.trail('PutBucketVersioning').length > 0) || 'Todavía no has ejecutado versionar.sh con permiso de ejecución.'; } },
        { id: 'prod', title: 'Los dos buckets `prod-` tienen el versionado activado', hint: ['aws s3api get-bucket-versioning --bucket prod-datos-ana-001'], check: (c) => (['prod-datos-ana-001', 'prod-logs-ana-001'].every((n) => c.bucket(n)?.versioning === 'Enabled')) || 'Algún bucket prod- todavía no tiene el versionado activado.' },
        { id: 'test', title: 'El bucket `test-` no se ha tocado', hint: ['El if debe filtrar por el prefijo prod-'], check: (c) => { const b = c.bucket('test-pruebas-ana-001'); return (!!b && b.versioning === 'Disabled' && c.trail('PutBucketVersioning').length > 0) || 'El bucket test- debe seguir sin versionado (y el script debe haberse ejecutado).'; } },
      ],
      script: [
        "printf '#!/bin/bash\\nfor b in $(aws s3api list-buckets --query \"Buckets[].Name\" --output text); do\\n  if [[ \"$b\" == prod-* ]]; then\\n    aws s3api put-bucket-versioning --bucket $b --versioning-configuration Status=Enabled\\n    echo \"versionado activado en $b\"\\n  fi\\ndone\\n' > versionar.sh",
        'chmod +x versionar.sh',
        './versionar.sh',
        'aws s3api get-bucket-versioning --bucket prod-datos-ana-001',
      ],
      realWorld: 'Aplicar una política a muchos recursos con un bucle es habitual, pero hazlo siempre primero en modo «solo listar» y revisa la salida. Para evitar deriva, es mejor declararlo en Terraform o forzarlo con una regla de AWS Config. El versionado cuesta almacenamiento de las versiones antiguas: añade una regla de ciclo de vida. **Limpieza:** elimina los buckets con `aws s3 rb s3://<nombre> --force` (los versionados requieren borrar también las versiones) y borra el script.',
    },
  ],
  quiz: [
    { domain: 1, q: 'Un fichero con una clave privada tiene el modo `644` y SSH la rechaza. ¿Qué corriges?', options: ['`chmod 600 clave.pem`', '`chmod 777 clave.pem`', '`chown root clave.pem`', 'Reiniciar el servicio ssh'], answer: 0, explain: 'SSH exige que solo el propietario pueda leer la clave. 600 (o 400) cumple; 777 la abriría a todos y se rechazaría igual.' },
    { domain: 1, q: '¿Qué hace `sed -i.bak \'s/us-east-1/eu-west-1/\' app.conf`?', options: ['Imprime el resultado sin tocar el fichero', 'Edita el fichero en el sitio y deja una copia `app.conf.bak`', 'Borra las líneas con us-east-1', 'Falla porque falta la opción -e'], answer: 1, explain: '`-i` edita en el sitio; con el sufijo `.bak` conserva el original, una buena práctica antes de modificar configuración.' },
    { domain: 1, q: 'Quieres imprimir solo las líneas del 2 al 5 de un log. ¿Qué comando?', options: ['`sed -n \'2,5p\' log`', '`sed \'2,5d\' log`', '`grep 2,5 log`', '`head -n 2 log`'], answer: 0, explain: '`-n` suprime la salida automática y `2,5p` imprime solo ese rango. `2,5d` haría lo contrario: borrarlo.' },
    { domain: 2, q: '¿Qué hace la tubería `awk \'{print $1}\' acceso.log | sort | uniq -c | sort -rn | head -n 3`?', options: ['Muestra las 3 primeras líneas del log', 'Cuenta cuántas veces aparece cada primera columna y muestra las 3 más frecuentes', 'Ordena el log por tamaño', 'Elimina las líneas duplicadas del fichero'], answer: 1, explain: 'Extrae la primera columna, agrupa iguales con sort, cuenta con uniq -c y ordena por recuento descendente. Es la receta clásica de «top N».' },
    { domain: 2, q: 'Un script ejecuta `./copia.sh` y recibe «Permission denied». ¿Cuál es la causa más probable?', options: ['Falta el shebang', 'El fichero no tiene el bit de ejecución: `chmod +x copia.sh`', 'La variable PATH está vacía', 'El script contiene un bucle for'], answer: 1, explain: 'Sin el bit de ejecución, `./script` da «Permission denied» (código 126). `bash script` funcionaría porque solo necesita leerlo.' },
    { domain: 2, q: 'En una crontab, ¿cuándo se ejecuta `30 2 * * 1-5`?', options: ['Cada 30 minutos de 2 a 5', 'A las 02:30 de lunes a viernes', 'A las 02:30 los días 1 a 5 del mes', 'A las 14:30 todos los días'], answer: 1, explain: 'Los campos son minuto, hora, día del mes, mes y día de la semana: minuto 30, hora 2 y días de semana 1 a 5 (lunes a viernes).' },
    { domain: 3, q: 'Necesitas lanzar una tarea cada noche sin mantener ningún servidor encendido. ¿Qué alternativa gestionada sustituye a cron en AWS?', options: ['Una regla programada de EventBridge que invoca una Lambda', 'Una instancia EC2 con cron siempre encendida', 'Un volumen EBS con un script', 'Una política de ciclo de vida de S3'], answer: 0, explain: 'EventBridge Scheduler o una regla programada lanzan la función a la hora indicada sin servidores que mantener ni parchear.' },
    { domain: 4, q: 'Tienes un script que borra buckets antiguos con un bucle `for`. ¿Qué buena práctica reduce el riesgo de borrar algo importante?', options: ['Ejecutarlo siempre como root', 'Primero imprimir los recursos que borraría (modo de prueba) y pedir confirmación', 'Quitar el shebang', 'Ejecutarlo desde cron cada minuto'], answer: 1, explain: 'Un listado previo o un parámetro explícito de confirmación evita borrados masivos. Ejecutarlo con más privilegios o más a menudo lo empeora.' },
  ],
};

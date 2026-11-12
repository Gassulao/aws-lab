## Permisos y tareas programadas

### Permisos de ficheros

`ls -l` muestra los permisos: `-rw-r--r--`. Tres grupos (propietario, grupo, resto) con **r**ead (4), **w**rite (2) y e**x**ecute (1).

- `chmod 600 clave.pem`: solo el propietario lee y escribe. Las claves privadas **deben** tener este modo; SSH rechaza una clave con permisos abiertos.
- `chmod 700 carpeta`, `chmod +x script.sh`, `chmod g-w fichero` (modo simbólico).
- `stat -c %a fichero` muestra el modo en octal; `find . -perm 600` localiza ficheros con ese modo.

```bash
printf 'clave\n' > mi-clave.pem
chmod 600 mi-clave.pem
ls -l mi-clave.pem
find . -type f -perm 600
```

### cron

`cron` ejecuta comandos de forma periódica. Cada línea de la crontab tiene cinco campos de tiempo y el comando:

```text
minuto hora día-mes mes día-semana  comando
*/15   *    *       *   *           /home/ana/copia.sh
0      3    *       *   1-5         /home/ana/limpieza.sh
```

Se instala con `crontab fichero` y se lista con `crontab -l`. En AWS el equivalente gestionado son las reglas programadas de **EventBridge** (`cron(0 3 * * ? *)`) que lanzan una Lambda sin servidor que mantener.

### Atención

Los trabajos de cron se ejecutan con un entorno mínimo: usa rutas absolutas y redirige la salida a un log (`>> /var/log/x.log 2>&1`).

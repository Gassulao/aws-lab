## Scripts: variables, bucles y condiciones

Un script es una lista de comandos en un fichero con permiso de ejecución. Empieza con la línea *shebang* `#!/bin/bash`.

```bash
printf '#!/bin/bash\nREGION=${1:-eu-west-1}\nfor b in $(aws s3api list-buckets --query "Buckets[].Name" --output text); do\n  echo "bucket: $b ($REGION)"\ndone\n' > revisar.sh
chmod +x revisar.sh
./revisar.sh
```

Piezas imprescindibles:

- **Variables**: `NOMBRE=valor`, se leen con `$NOMBRE` (entre comillas dobles por seguridad). `${1:-defecto}` usa el primer argumento o un valor por defecto.
- **Sustitución de comandos**: `$(comando)` captura su salida.
- **Condiciones**: `if [ -z "$X" ]; then ...; elif ...; else ...; fi`.
- **Bucles**: `for x in a b c; do ...; done` y `while read linea; do ...; done < fichero`.
- **Aritmética**: `N=$((N+1))`.
- **Códigos de salida**: `exit 0` éxito, distinto de cero error. `&&` y `||` encadenan según el resultado.

Sin el bit de ejecución el script no se lanza con `./`: da «Permission denied» (código 126). Siempre puedes ejecutarlo con `bash revisar.sh`.

### Buenas prácticas

Comprueba los argumentos, escribe mensajes claros y haz que el script falle ruidosamente. Un script que borra recursos debe pedir confirmación o un parámetro explícito.

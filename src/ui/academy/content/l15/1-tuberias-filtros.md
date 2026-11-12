## Tuberías y filtros: leer un log como un profesional

Casi todo lo que haces en la nube acaba en texto: logs, salidas JSON, listados. La shell te deja **encadenar** programas pequeños con la tubería `|`: la salida de uno es la entrada del siguiente. Es la herramienta de diagnóstico más rápida que existe.

- `grep patrón fichero`: filtra líneas (`-v` invierte, `-c` cuenta, `-i` ignora mayúsculas, `-E` expresiones extendidas).
- `cut -d' ' -f1`: extrae una columna; `awk '{print $1}'` hace lo mismo y mucho más.
- `sort | uniq -c | sort -rn | head`: la receta clásica para **contar y ordenar** (por ejemplo, las IP que más peticiones hacen).
- `wc -l`: cuenta líneas. `tr`, `head`, `tail`: transformar y recortar.

```bash
printf '10.0.0.1 GET /a 200\n10.0.0.2 GET /b 500\n10.0.0.1 GET /a 200\n' > acceso.log
grep -c ' 500$' acceso.log
awk '{print $1}' acceso.log | sort | uniq -c | sort -rn | head -n 3
```

Importante: `uniq` solo junta líneas **consecutivas** iguales, por eso siempre va precedido de `sort`. Y recuerda que cada comando de la tubería tiene su propio código de salida; `$?` es el del último.

### Por qué importa en AWS

Los accesos de un balanceador, los logs de VPC Flow Logs o la salida de `aws ... --output text` son texto. Con cuatro filtros encuentras la IP que te ataca o el servicio que más falla sin abrir una herramienta de análisis.

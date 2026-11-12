**Amazon S3** guarda *objetos* (un fichero más sus metadatos) dentro de *buckets*. No hay carpetas reales: `fotos/2026/a.jpg` es una clave única con prefijos que las herramientas dibujan como carpetas.

- El nombre del bucket es **global y único** en todo AWS, pero el bucket vive en **una región**.
- Cada objeto puede pesar hasta 5 TB; por encima de 100 MB conviene la subida *multipart*.
- La durabilidad es de **11 nueves** (99,999999999 %): los datos se replican en al menos tres zonas de disponibilidad de la región.

```bash
aws s3 mb s3://fotos-lab-2026
aws s3 cp ~/README.md s3://fotos-lab-2026/
aws s3 ls s3://fotos-lab-2026 --recursive
```

Para subir una carpeta entera y mantenerla sincronizada se usa `sync`, que solo transfiere lo que cambió:

```bash
aws s3 sync ~/samples s3://fotos-lab-2026/samples
```

## Clases de almacenamiento (coste)

| Clase | Cuándo usarla |
|---|---|
| **Standard** | Acceso frecuente |
| **Intelligent-Tiering** | Patrón de acceso desconocido o cambiante: S3 mueve los objetos solo |
| **Standard-IA / One Zone-IA** | Acceso poco frecuente pero rápido; se paga recuperación |
| **Glacier (Instant, Flexible, Deep Archive)** | Archivo a largo plazo, mucho más barato, con tiempos de recuperación |

> **Para el examen (dominio 4):** datos que casi no se leen → *lifecycle* para pasarlos a IA/Glacier; patrón desconocido → Intelligent-Tiering.

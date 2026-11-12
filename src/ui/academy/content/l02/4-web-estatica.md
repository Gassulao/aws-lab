S3 puede servir un sitio web estático (HTML, CSS, JS) directamente desde un bucket. Hace falta:

1. Subir `index.html` (y opcionalmente `error.html`).
2. Activar el alojamiento web con `put-bucket-website`.
3. Permitir la lectura anónima (política `s3:GetObject` con `Principal: "*"`) y relajar BPA en ese bucket.

```bash
aws s3api put-bucket-website --bucket web-lab-2026 --website-configuration '{"IndexDocument":{"Suffix":"index.html"},"ErrorDocument":{"Key":"error.html"}}'
curl http://web-lab-2026.s3-website-eu-west-1.amazonaws.com/
```

El *endpoint de sitio web* (`bucket.s3-website-<región>.amazonaws.com`) es distinto del endpoint de la API (`bucket.s3.<región>.amazonaws.com`) y solo habla HTTP.

## Cómo leer un 403 y un 404 de S3

- **403 AccessDenied** en una petición anónima: nadie permite ese `GetObject` (política ausente o mal escrita, `Resource` sin `/*`, BPA bloqueando, objeto cifrado con KMS ajeno…).
- **404 NoSuchKey**: el objeto no existe y la política sí deja listar... o ya deja leer.

Sin permiso `s3:ListBucket`, S3 devuelve **403** cuando la clave no existe, para no revelar qué hay dentro.

## Arquitectura recomendada

Para producción, **CloudFront** delante de un bucket **privado** con *Origin Access Control* (OAC): HTTPS, dominio propio, caché en el borde (menor latencia y menor coste) y el bucket sin exposición pública.

> **Para el examen (dominio 3):** contenido estático para usuarios en todo el mundo con baja latencia → S3 + CloudFront.

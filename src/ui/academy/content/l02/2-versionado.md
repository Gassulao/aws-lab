El **versionado** conserva todas las versiones de cada objeto en el bucket. Una vez activado solo puede *suspenderse*, no desactivarse.

- Al **sobrescribir**, se crea una versión nueva; la anterior sigue ahí.
- Al **borrar sin indicar versión**, S3 no elimina nada: añade un **marcador de borrado** (*delete marker*) y el objeto "desaparece" de los listados.
- Para **recuperar** un objeto borrado por error se usa una versión anterior (se descarga con `--version-id` y se vuelve a subir, o se elimina el marcador).
- Borrar **indicando una versión** sí es un borrado definitivo de esa versión.

```bash
aws s3api put-bucket-versioning --bucket contratos-lab-2026 --versioning-configuration Status=Enabled
aws s3api put-object --bucket contratos-lab-2026 --key contrato.txt --body /tmp/contrato.txt --query VersionId --output text
```

`put-object` devuelve el `VersionId` de lo que subes. Guárdalo: te permite volver a esa versión más tarde.

```bash
aws s3api get-object --bucket contratos-lab-2026 --key contrato.txt --version-id <VersionId> /tmp/recuperado.txt
```

## Resiliencia y replicación

- El versionado es **requisito** de la replicación entre regiones (CRR) y en la misma región (SRR).
- **MFA Delete** exige un código MFA para borrar versiones definitivamente.
- Con el versionado pagas por **todas** las versiones: combínalo con reglas de ciclo de vida que caduquen las antiguas.

> **Para el examen (dominio 2):** «proteger contra borrados accidentales» → versionado (+ MFA Delete). «Recuperación ante fallo de región» → replicación entre regiones.

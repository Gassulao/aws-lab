## Amazon RDS: bases de datos relacionales administradas

**RDS** ejecuta MySQL, PostgreSQL, MariaDB (y otros motores) con copias de seguridad, parches y alta disponibilidad administrados. Tú sigues siendo responsable del esquema, las consultas y la red, pero no del sistema operativo.

```bash
aws rds create-db-instance --db-instance-identifier tienda-db --db-instance-class db.t3.micro --engine mysql --master-username admin --master-user-password 'Contrasena-Segura-1' --allocated-storage 20 --no-publicly-accessible
aws rds wait db-instance-available --db-instance-identifier tienda-db
aws rds describe-db-instances --db-instance-identifier tienda-db --query "DBInstances[0].[DBInstanceStatus,Endpoint.Address,AvailabilityZone]"
```

La instancia pasa por `creating` → `available` (varios minutos en AWS real). Mientras no está `available` no admite modificaciones.

### Red y seguridad

- Las instancias viven en una VPC dentro de un **grupo de subredes de base de datos** (`create-db-subnet-group`) que debe cubrir **al menos dos zonas de disponibilidad**.
- El acceso se controla con **grupos de seguridad**: abre el puerto del motor (3306 MySQL, 5432 PostgreSQL) **solo al grupo de seguridad de la aplicación**, nunca a `0.0.0.0/0`.
- `--no-publicly-accessible` mantiene la base de datos sin IP pública; es lo correcto para casi todos los casos.
- Cifrado en reposo con KMS (`--storage-encrypted`), que **no se puede activar después** sobre una instancia existente.

### Alta disponibilidad: Multi-AZ

Con `--multi-az` RDS mantiene una instancia **en espera síncrona** en otra zona de disponibilidad. Si la principal falla (o en un mantenimiento) RDS conmuta automáticamente: el **mismo punto de enlace DNS** pasa a apuntar a la réplica en espera en uno o dos minutos. Multi-AZ es para **disponibilidad**, no para rendimiento: la instancia en espera no sirve lecturas.

```bash
aws rds modify-db-instance --db-instance-identifier tienda-db --multi-az --apply-immediately
aws rds reboot-db-instance --db-instance-identifier tienda-db --force-failover
```

Para **escalar lecturas** se usan **réplicas de lectura** (`create-db-instance-read-replica`), asíncronas y con su propio punto de enlace. Se pueden promover (`promote-read-replica`) como recuperación ante desastres.

### Copias y restauración

- **Copias automáticas**: retención de 0 a 35 días (`--backup-retention-period`) con recuperación a un momento dado.
- **Instantáneas manuales** (`create-db-snapshot`): se conservan hasta que las borres. **No se restaura sobre la misma instancia**: `restore-db-instance-from-db-snapshot` crea una instancia **nueva** con otro punto de enlace.
- Al eliminar una instancia debes crear una **instantánea final** (`--final-db-snapshot-identifier`) o indicar `--skip-final-snapshot`; la protección contra eliminación lo impide mientras esté activa.

### Cambios en la instancia

Algunos cambios (clase, almacenamiento, versión) se aplican en la siguiente ventana de mantenimiento salvo que uses `--apply-immediately`, que puede provocar una breve interrupción. Mientras tanto aparecen como *valores pendientes de modificación*.

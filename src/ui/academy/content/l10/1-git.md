## Git: el control de versiones que usa todo el equipo

**Git** guarda la historia de un proyecto como una cadena de **commits**. Cada commit es una foto completa de los ficheros, con autor, fecha, mensaje y un identificador (SHA-1) que depende de todo su contenido. Trabajas siempre sobre una copia local completa del repositorio, así que casi todo funciona sin red; solo `clone`, `fetch`, `pull` y `push` hablan con el servidor.

Tres zonas importan para entender los comandos:

- el **directorio de trabajo**: los ficheros que editas;
- el **índice** (*staging area*): lo que irá en el próximo commit (`git add`);
- el **repositorio**: los commits ya guardados (`git commit`).

```bash
git init proyecto && cd proyecto
git config user.name "Ana" && git config user.email ana@example.com
echo "# Proyecto" > README.md
git status                 # README.md aparece como «Untracked»
git add README.md          # pasa al índice
git commit -m "Primer commit"
git log --oneline
```

Una **rama** es solo un puntero móvil a un commit, por eso crearlas es instantáneo. Se trabaja en una rama por cambio y se integra después con `merge`:

```bash
git checkout -b feature/login     # crea y cambia de rama
echo "login" > login.txt && git add . && git commit -m "Añade login"
git checkout main
git merge feature/login           # fast-forward si main no avanzó
git diff HEAD~1                   # qué cambió en el último commit
```

Si dos ramas tocan las mismas líneas, `merge` se detiene con un **conflicto** y deja marcas `<<<<<<<`, `=======` y `>>>>>>>` en el fichero. Lo resuelves a mano, haces `git add` y terminas con `git commit`.

> En el examen: Git no es un servicio de AWS. AWS aporta el servidor remoto (CodeCommit) y la autenticación (IAM), no el control de versiones.

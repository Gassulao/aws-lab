## grep, sed y jq: editar y consultar sin abrir un editor

- **`grep -rn "texto" carpeta`** busca de forma recursiva y muestra el número de línea. Útil para encontrar dónde aparece una región o un ARN en tu código.
- **`sed 's/viejo/nuevo/g' fichero`** sustituye texto; con `-i` edita el fichero en el sitio. `sed -n '2,5p'` imprime solo un rango y `sed '/^#/d'` borra comentarios.
- **`jq`** hace con JSON lo que `grep` y `sed` hacen con texto: `jq -r '.Buckets[].Name'`, `jq 'length'`, filtros con `select(...)`.

```bash
printf 'region=us-east-1\nbucket=datos\n' > app.conf
sed -i 's/us-east-1/eu-west-1/' app.conf
grep region app.conf
aws s3api list-buckets --output json | jq -r '.Buckets[].Name'
```

Antes de lanzar `sed -i` sobre algo importante, guarda copia: `sed -i.bak 's/a/b/' fichero` deja `fichero.bak`. Con `--query` de la propia AWS CLI (JMESPath) filtras en el servidor; con `jq` filtras en tu máquina y puedes combinar varias salidas.

### Cuándo usar cada uno

Para **líneas de texto**, `grep` y `sed`. Para **JSON de la CLI**, `--query` o `jq`. Para **columnas y cálculos**, `awk`.

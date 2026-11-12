## kubectl en el día a día y diagnóstico

Los manifiestos YAML son **declarativos**: describes el estado deseado y `kubectl apply` hace que el clúster converja.

```bash
kubectl apply -f web.yaml
kubectl get pods -o wide
kubectl scale deployment web --replicas=4
kubectl set image deployment/web nginx=nginx:1.27
kubectl rollout status deployment/web
kubectl rollout undo deployment/web
kubectl logs deployment/web --tail=20
```

### Qué significa cada estado de un pod

| Estado | Causa típica | Dónde mirar |
|---|---|---|
| `Pending` | no hay nodo con CPU/memoria libres o con huecos de pods (`FailedScheduling`) | `kubectl describe pod` → *Events* |
| `ImagePullBackOff` / `ErrImagePull` | la etiqueta no existe, o el nodo no puede leer de ECR (rol de nodo o salida a internet) | `describe pod`, `aws ecr describe-images` |
| `CrashLoopBackOff` | el contenedor arranca y termina en bucle | `kubectl logs` (y `--previous`) |
| `CreateContainerConfigError` | falta un `ConfigMap` o `Secret` referenciado | `describe pod`, `kubectl get cm` |

El método es siempre el mismo: **`get`** para ver el estado, **`describe`** para leer los eventos y **`logs`** para ver qué dice la aplicación. Un despliegue que no avanza muestra `Waiting for rollout to finish` y acaba con `exceeded its progress deadline`; `rollout undo` vuelve a la revisión anterior que funcionaba.

> Un `Service` de tipo `LoadBalancer` obtiene un nombre DNS en `EXTERNAL-IP`; si dice `<pending>` el balanceador aún se está creando.

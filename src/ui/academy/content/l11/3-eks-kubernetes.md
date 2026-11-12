## Amazon EKS y Kubernetes

**Amazon EKS** es Kubernetes administrado: AWS opera el **plano de control** (API server, etcd) y tú aportas los **nodos** de trabajo. El clúster tarda unos minutos en pasar de `CREATING` a `ACTIVE`.

Piezas de EKS:

- **Rol del clúster**: lo asume `eks.amazonaws.com` y lleva `AmazonEKSClusterPolicy`.
- **Grupo de nodos administrado**: instancias EC2 gestionadas por EKS. Su rol (`ec2.amazonaws.com`) necesita `AmazonEKSWorkerNodePolicy`, `AmazonEKS_CNI_Policy` y `AmazonEC2ContainerRegistryReadOnly`. Sin estas políticas, o con subredes sin salida a internet, el grupo termina en `CREATE_FAILED`.
- **Complementos** (*add-ons*): `vpc-cni`, `coredns`, `kube-proxy`...
- **Acceso**: quien crea el clúster es administrador; para el resto se usan *access entries* de EKS.

Con el clúster activo, `aws eks update-kubeconfig` escribe el contexto en `~/.kube/config` y `kubectl` ya puede hablar con él:

```bash
aws eks create-cluster --name dev --role-arn arn:aws:iam::<cuenta>:role/eks-cluster --resources-vpc-config subnetIds=subnet-aaa,subnet-bbb
aws eks wait cluster-active --name dev
aws eks create-nodegroup --cluster-name dev --nodegroup-name ng --node-role arn:aws:iam::<cuenta>:role/eks-nodos --subnets subnet-aaa subnet-bbb --scaling-config minSize=1,maxSize=3,desiredSize=2
aws eks update-kubeconfig --name dev
kubectl get nodes
```

### Objetos de Kubernetes que usarás

- **Pod**: la unidad mínima, uno o varios contenedores con una IP.
- **Deployment**: declara «quiero 3 réplicas de esta imagen» y gestiona los *ReplicaSets*; hace *rolling updates* y permite `rollout undo`.
- **Service**: nombre estable y balanceo hacia los pods que cumplen un *selector*. `ClusterIP` (interno), `NodePort` y **`LoadBalancer`** (crea un balanceador de AWS con un nombre DNS público).
- **ConfigMap / Secret**: configuración y datos sensibles, separados de la imagen.
- **Namespace**: partición lógica del clúster.

# Kubernetes Monitoring

**Observability → Kubernetes** (`/kubernetes`) shows the health, configuration and resource usage of your Kubernetes clusters, in a layout similar to Dynatrace:

| Tab | Shows |
|---|---|
| Overview | Health tiles (nodes ready, pods, workloads, restarts in the last hour, CPU and memory use, warning events), a problem list, cluster usage trend, a node table with CPU and memory bars, and a per-namespace breakdown |
| Workloads | Deployments, StatefulSets, DaemonSets and Jobs: ready/desired replicas, images, age, restarts, CPU and memory used across all pods compared with requests and limits |
| Pods | A dense pod table: status reason (CrashLoopBackOff, OOMKilled, Pending (Unschedulable), ImagePullBackOff…), ready containers, restarts, CPU and memory used compared with limits, node, QoS class, age. You can filter by namespace, workload, node, status and free text. Click a pod to open its side panel (described below) |
| Nodes | Readiness, pressure conditions, taints, capacity and allocatable resources, usage and committed requests per node, with a trend chart |
| Events | Cluster events, warnings first, filtered by type and namespace |

The pod side panel has five tabs:

- **Summary**: usage compared with requests and limits, IPs, node, owner chain (Pod → ReplicaSet → Deployment), container states and last terminations, conditions and labels.
- **Configuration**: a readable, YAML-like view of the containers (image, ports, resources, probes, environment, volume mounts, security context), volumes, tolerations and annotations. You can download it as YAML.
- **Events**: events for this pod.
- **Logs**: the last 100–2,000 lines per container, including the previous container after a restart.
- **Metrics**: CPU and memory trends for the pod and for its workload.

At the top of the page you pick the cluster, choose how often the page refreshes (off, 15 s, 30 s or 1 min) and press **Refresh** to read the cluster again immediately.

## Secrets are never shown

- The read-only role below grants **no access to Secrets or ConfigMaps**, so Perfmon cannot read secret values.
- Environment variables taken from a Secret (`secretKeyRef`, `envFrom.secretRef`) appear as `••••••••  # from Secret <name>/<key>`.
- Literal values are masked when their name looks sensitive (password, secret, token, api key, credential, auth, DSN, connection string…) or when the value itself looks like a credential (JWT, PEM, vendor token formats, long random strings). Passwords inside URLs (`user:pass@`) are redacted.
- The `kubectl.kubernetes.io/last-applied-configuration` annotation is hidden, because it contains literal environment values.
- Command-line arguments and log lines are redacted in the same way (`password=…`, `--token …`, `Authorization: Bearer …`).

## Data sources

| Source | When to use | What you get |
|---|---|---|
| **Kubernetes** connection (API server + ServiceAccount token) | The API server can be reached from the Perfmon backend | Everything above, including container configuration, logs and per-pod usage from metrics-server |
| **Dynatrace** integration (entities.read + metrics.read) | The cluster is private but monitored by Dynatrace | Cluster, nodes, namespaces, workloads and pods from the Dynatrace entity model, plus usage, requests and limits per workload and node from `builtin:kubernetes.*` metrics. Container specifications and logs are not available |

> **Network note.** Perfmon's hosted backend runs on Render, on the public internet. A **Kubernetes** connection only works if the API server URL can be reached from there. That is usually true for managed clusters with a public endpoint (EKS, AKS and GKE public endpoints, optionally restricted to Render's outbound IPs). It is not true for private clusters or clusters on a corporate network. For those, use the **Dynatrace** source, or run Perfmon inside your network.

## 1. Create a read-only ServiceAccount

Download the ready-made manifest: [perfmon-k8s-readonly.yaml](/samples/perfmon-k8s-readonly.yaml), then apply it:

```bash
kubectl apply -f perfmon-k8s-readonly.yaml
```

It creates:

```yaml
apiVersion: v1
kind: Namespace
metadata: { name: perfmon-monitoring }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: perfmon-reader, namespace: perfmon-monitoring }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: perfmon-reader }
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log", "nodes", "namespaces", "events"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets", "daemonsets", "replicasets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["batch"]
    resources: ["jobs", "cronjobs"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["events.k8s.io"]
    resources: ["events"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["metrics.k8s.io"]
    resources: ["pods", "nodes"]
    verbs: ["get", "list"]
  - nonResourceURLs: ["/version", "/healthz"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: perfmon-reader }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: perfmon-reader }
subjects: [{ kind: ServiceAccount, name: perfmon-reader, namespace: perfmon-monitoring }]
---
# long-lived token (Kubernetes ≥ 1.24 no longer creates one automatically)
apiVersion: v1
kind: Secret
metadata:
  name: perfmon-reader-token
  namespace: perfmon-monitoring
  annotations: { kubernetes.io/service-account.name: perfmon-reader }
type: kubernetes.io/service-account-token
```

**Namespace-scoped only.** If you may not create a ClusterRole, create the same rules as a `Role` plus `RoleBinding` in each namespace, and enter those namespaces in the connection's **Namespace allow-list**. Node data, and the cluster-wide namespace list, then need a small ClusterRole with `get/list` on `nodes`. Without it the Nodes tab stays empty and the page shows a warning.

CPU and memory usage come from **metrics-server** (`metrics.k8s.io`). Most managed clusters and k3s include it. Otherwise install it:

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

## 2. Get the API server URL, token and CA

```bash
# API server URL of the current context
kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'

# bearer token
kubectl -n perfmon-monitoring get secret perfmon-reader-token -o jsonpath='{.data.token}' | base64 -d

# cluster CA (base64; paste as is, or decode it to PEM)
kubectl -n perfmon-monitoring get secret perfmon-reader-token -o jsonpath='{.data.ca\.crt}'
```

On Windows PowerShell, decode the token with:

```powershell
$t = kubectl -n perfmon-monitoring get secret perfmon-reader-token -o jsonpath='{.data.token}'
[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($t))
```

## 3. Add the connection in Perfmon

1. Go to **Platform → Integrations → Catalog → Kubernetes → Add**. You need the *Manage integrations* permission.
2. Fill in the fields:

| Field | Value |
|---|---|
| URL | API server URL, e.g. `https://my-cluster.example.com:6443` |
| Bearer token | the token from step 2 (stored encrypted with AES-256-GCM, never returned by the API) |
| CA certificate | PEM, or the base64 `ca.crt` / kubeconfig `certificate-authority-data`. Leave empty when the API server uses a publicly trusted certificate |
| Skip TLS verification | Only for throwaway test clusters |
| Cluster display name | Name shown in the cluster picker |
| Namespace allow-list | Optional, comma-separated. Empty = all namespaces |
| Perfmon environment | Optional. While a Perfmon run is **RUNNING** in this environment, usage samples are attached to that run |

3. Press **Test**. A working connection reports something like `Connected to Kubernetes v1.30.4; 6 namespaces; 3 nodes`. Missing permissions or metrics-server are listed in the result.
4. Open **Observability → Kubernetes**.

Anyone with *View project* can open the Kubernetes pages. Creating, editing and testing connections needs *Manage integrations*.

## Using Dynatrace as the data source

Use the existing **Dynatrace** integration. The URL is `https://<env-id>.live.dynatrace.com` (SaaS) or `https://<host>/e/<env-id>` (Managed). Create an API token with these scopes:

| Scope | Needed for |
|---|---|
| `entities.read` (Read entities) | Clusters, nodes, namespaces, workloads (CLOUD_APPLICATION) and pods (CLOUD_APPLICATION_INSTANCE) from `/api/v2/entities` |
| `metrics.read` (Read metrics) | `builtin:kubernetes.workload.*`, `builtin:kubernetes.node.*`, `builtin:kubernetes.container.restarts`, `builtin:kubernetes.pods` from `/api/v2/metrics/query`; also run-window imports |
| `events.read` (optional) | Cluster events on the Events tab |

Set **Kubernetes cluster** to the Dynatrace display name of the cluster, or leave it empty to show every cluster. Dynatrace connections then appear in the cluster picker with the suffix “(Dynatrace)”. Trends come straight from Dynatrace at 1-minute resolution. Pod trends show the pod's workload. The **Test** button reports how many Kubernetes clusters the token can see, or that `entities.read` is missing.

## Trends and run correlation

`metrics.k8s.io` only provides current values. While someone has the Kubernetes page open, or while a linked run is RUNNING, Perfmon samples pod and node CPU and memory **every 20 seconds**. The samples go into its metric store as `k8s.pod.cpu_mcores`, `k8s.pod.memory_bytes`, `k8s.pod.restarts`, `k8s.node.cpu_mcores`, `k8s.node.memory_bytes`, `k8s.node.cpu_pct` and `k8s.node.memory_pct`. They are tagged with cluster, namespace, pod, workload and node. When a run is linked, they are also attached to the run and tagged with `runId`.

Sampling stops about 3 minutes after the last viewer leaves. Samples that are not attached to a run are deleted after 24 hours.

API: `GET /api/v1/kubernetes/{connectionId}/trends?scope=cluster|node|namespace|workload|pod&namespace=&name=&minutes=60`.

## API reference

All endpoints are under `/api/v1` and listed in the OpenAPI docs (tag *Kubernetes*).

| Endpoint | Purpose |
|---|---|
| `GET /kubernetes/connections` | Kubernetes and Dynatrace data sources |
| `GET /kubernetes/{id}/overview` | Counts, capacity and usage, nodes, namespaces, problems |
| `GET /kubernetes/{id}/workloads?namespace=&kind=&q=` | Workloads |
| `GET /kubernetes/{id}/pods?namespace=&workload=&node=&status=&q=` | Pods. `status` = `ok`, `warn`, `fail`, `done` or a reason such as `CrashLoopBackOff` |
| `GET /kubernetes/{id}/pods/{ns}/{name}` | Pod configuration (masked), events, owner chain |
| `GET /kubernetes/{id}/pods/{ns}/{name}/logs?container=&tailLines=200&previous=true` | Log tail, 256 KB per container, redacted |
| `GET /kubernetes/{id}/nodes`, `/events`, `/namespaces`, `/trends` | Nodes, events, namespaces, trends |
| `POST /kubernetes/{id}/sample` | Take a usage sample now (*Manage integrations*) |

Results are cached for about 10 seconds per connection. Every call to the cluster has a timeout of 15 seconds or less.

## Troubleshooting

| Message | Cause and fix |
|---|---|
| `Kubernetes API rejected the token (HTTP 401)` | The token is wrong or expired, or its ServiceAccount or Secret was deleted. Short-lived tokens from `kubectl create token` expire, so use the `perfmon-reader-token` Secret |
| `Token lacks permission: list pods (cluster-wide)` | The ClusterRole or binding is missing. Re-apply the manifest, or use a namespace allow-list with namespaced Roles |
| `TLS verification failed (SELF_SIGNED_CERT_IN_CHAIN …)` | Paste the cluster CA (step 2). For a throwaway cluster, enable *Skip TLS verification* |
| TLS error mentioning the host name or `ERR_TLS_CERT_ALTNAME_INVALID` | The URL's host name is not in the API server certificate. Use the official endpoint, or add a SAN (`--tls-san` for k3s) |
| `Connection timed out` / `Host not found` / `Connection refused` | The API server cannot be reached from the Perfmon backend (private endpoint, firewall, wrong port). See the network note above, or use the Dynatrace source |
| `metrics-server (metrics.k8s.io) is not installed` | Install metrics-server. Everything except usage still works |
| `API server redirected` / `non-JSON response` | The URL points to a dashboard, an OIDC login page or a proxy instead of the API server |
| `Dynatrace token lacks permission (HTTP 403)` | Add `entities.read` and `metrics.read` to the token (`events.read` for events) |
| `Kubernetes cluster "X" not found in Dynatrace` | Check the *Kubernetes cluster* field against the cluster names that the Test button lists |
| No trend yet ("Collecting…") | Samples start when the page opens. The first points appear after about 20–40 seconds |

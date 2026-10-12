import type { Connector } from './types.js';
import { probe } from './http.js';
import { kubeConnFrom } from '../../kubernetes/source.js';
import { testDirect } from '../../kubernetes/directSource.js';

/**
 * Kubernetes connector: read-only access to a cluster's API server with a ServiceAccount bearer
 * token. Powers Observability → Kubernetes (overview, workloads, pods, nodes, events, logs) and
 * the pod/node usage sampler. See docs/user-manual/17a-kubernetes-monitoring.md for the RBAC.
 */
export const kubernetesConnector: Connector = {
  type: 'KUBERNETES',
  label: 'Kubernetes',
  category: 'OBSERVABILITY',
  authTypes: ['TOKEN'],
  fields: [
    { key: 'token', label: 'Bearer token (ServiceAccount)', required: true, secret: true, help: 'kubectl -n perfmon-monitoring get secret perfmon-reader-token -o jsonpath="{.data.token}" | base64 -d' },
    { key: 'caCert', label: 'CA certificate (PEM or base64)', required: false, secret: true, kind: 'multiline', help: 'Cluster CA (kubeconfig certificate-authority-data). Leave empty for publicly trusted certificates.' },
    { key: 'skipTlsVerify', label: 'Skip TLS verification', required: false, kind: 'boolean', help: 'Only for throwaway/test clusters with self-signed certificates.' },
    { key: 'clusterName', label: 'Cluster display name', required: false, placeholder: 'prod-eu-1' },
    { key: 'namespaces', label: 'Namespace allow-list (optional)', required: false, placeholder: 'shop, payments', help: 'Comma-separated. Empty = all namespaces (needs cluster-wide list).' },
    { key: 'environment', label: 'Perfmon environment (optional)', required: false, placeholder: 'PERF', help: 'Usage samples are attached to RUNNING runs in this environment (name or id).' },
  ],
  supportsImport: false,
  docs: 'Monitors a Kubernetes cluster directly through its API server (URL = https://<api-server>:6443) with a read-only ServiceAccount token: nodes, namespaces, Deployments/StatefulSets/DaemonSets/Jobs, pods (status, restarts, requests/limits, probes, env with secrets masked), events and container logs; CPU/memory usage from metrics-server (metrics.k8s.io). Needs get/list/watch on pods, pods/log, nodes, namespaces, events, apps/*, batch/jobs and metrics.k8s.io pods/nodes. The API server must be reachable from the Perfmon backend.',
  async test(i, c) {
    return probe(async () => testDirect(kubeConnFrom(i, c)));
  },
};

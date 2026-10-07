import type { Connector } from './types.js';
import { influxConnector } from './influxdb.js';
import { prometheusConnector } from './prometheus.js';
import { dynatraceConnector } from './dynatrace.js';
import { opentelemetryConnector } from './opentelemetry.js';
import { jenkinsConnector, githubActionsConnector, gitlabConnector, azureDevOpsConnector, jmeterConnector, grafanaConnector } from './ci.js';

const registry = new Map<string, Connector>();
export const registerConnector = (c: Connector) => registry.set(c.type, c);

for (const c of [jmeterConnector, influxConnector, prometheusConnector, dynatraceConnector, opentelemetryConnector, grafanaConnector,
  jenkinsConnector, githubActionsConnector, gitlabConnector, azureDevOpsConnector]) registerConnector(c);

export const connectorFor = (type: string) => registry.get(type) ?? null;
export const allConnectors = () => [...registry.values()];
export type { Connector } from './types.js';

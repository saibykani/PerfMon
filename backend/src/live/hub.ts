import { EventEmitter } from 'node:events';
import { selfMetrics } from '../selfmon/registry.js';

/**
 * Live event hub. Ingestion publishes "run:<id>" events after each flush;
 * SSE/WebSocket connections subscribe. For multi-replica deployments the SSE
 * handler also polls the database on its refresh interval, so clients receive
 * data regardless of which replica ingested it.
 */
export const hub = new EventEmitter();
hub.setMaxListeners(10000);

export function publishRunEvent(runId: string, type: string, data: unknown) {
  hub.emit(`run:${runId}`, { type, data });
  hub.emit('runs', { runId, type, data });
}

let connections = 0;
export const liveConnections = {
  inc() { connections++; selfMetrics.set('live_connections', connections); },
  dec() { connections--; selfMetrics.set('live_connections', connections); },
  get count() { return connections; },
};

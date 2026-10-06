import { createHmac } from 'node:crypto';
import { config } from '../config.js';
import { query, one } from '../db/pool.js';
import { decryptSecret } from '../lib/crypto.js';
import { registerJob } from '../jobs/queue.js';
import { sendEmail } from './email.js';

export interface AlertMessage {
  alertId: string;
  orgId: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  message: string;
  link: string;
  status: 'FIRING' | 'RESOLVED' | 'ACKNOWLEDGED';
  value?: number | null;
  threshold?: number | null;
  runKey?: string | null;
}

/**
 * Notification channel registry. To add an integration (PagerDuty, Opsgenie, ...)
 * register a new notifier with `registerNotifier(type, fn)` and add the type to
 * the notification_channels CHECK constraint.
 */
export type Notifier = (channel: { config: any; secret: string | null; name: string }, msg: AlertMessage) => Promise<void>;
const notifiers = new Map<string, Notifier>();
export const registerNotifier = (type: string, n: Notifier) => notifiers.set(type, n);

const emoji = (s: string) => (s === 'CRITICAL' ? '🔴' : s === 'WARNING' ? '🟠' : 'ℹ️');

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Webhook URL must be http(s)');
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

registerNotifier('IN_APP', async (_c, msg) => {
  await query(`INSERT INTO notifications (organization_id, alert_id, severity, title, body, link) VALUES ($1,$2,$3,$4,$5,$6)`,
    [msg.orgId, msg.alertId, msg.severity, `${msg.status === 'RESOLVED' ? 'Resolved: ' : ''}${msg.title}`, msg.message, msg.link]);
});

registerNotifier('EMAIL', async (c, msg) => {
  const to: string[] = c.config?.recipients ?? [];
  if (!to.length) throw new Error('No email recipients configured');
  const ok = await sendEmail(to, `[Perfmon ${msg.severity}] ${msg.status === 'RESOLVED' ? 'RESOLVED: ' : ''}${msg.title}`, `${msg.message}\n\nOpen in Perfmon: ${msg.link}`);
  if (!ok) throw new Error('SMTP is not configured (SMTP_HOST)');
});

registerNotifier('SLACK', async (c, msg) => {
  if (!c.secret) throw new Error('Slack webhook URL missing');
  await postJson(c.secret, {
    text: `${emoji(msg.severity)} *${msg.status === 'RESOLVED' ? 'RESOLVED: ' : ''}${msg.title}*\n${msg.message}\n<${msg.link}|Open in Perfmon>`,
  });
});

registerNotifier('TEAMS', async (c, msg) => {
  if (!c.secret) throw new Error('Teams webhook URL missing');
  await postJson(c.secret, {
    '@type': 'MessageCard', '@context': 'https://schema.org/extensions',
    themeColor: msg.severity === 'CRITICAL' ? 'D93025' : msg.severity === 'WARNING' ? 'F29900' : '1A73E8',
    summary: msg.title, title: `${msg.status === 'RESOLVED' ? 'RESOLVED: ' : ''}${msg.title}`, text: msg.message,
    potentialAction: [{ '@type': 'OpenUri', name: 'Open in Perfmon', targets: [{ os: 'default', uri: msg.link }] }],
  });
});

registerNotifier('WEBHOOK', async (c, msg) => {
  const url = c.config?.url;
  if (!url) throw new Error('Webhook URL missing');
  const body = { source: 'perfmon', ...msg, sentAt: new Date().toISOString() };
  const headers: Record<string, string> = {};
  if (c.secret) headers['x-perfmon-signature'] = 'sha256=' + createHmac('sha256', c.secret).update(JSON.stringify(body)).digest('hex');
  await postJson(url, body, headers);
});

export async function sendTestNotification(channelId: string, orgId: string) {
  const ch = await one(`SELECT * FROM notification_channels WHERE id = $1 AND organization_id = $2`, [channelId, orgId]);
  if (!ch) throw new Error('channel not found');
  const n = notifiers.get(ch.type);
  if (!n) throw new Error(`no notifier for ${ch.type}`);
  await n({ config: ch.config, secret: ch.secret_ciphertext ? decryptSecret(ch.secret_ciphertext) : null, name: ch.name },
    { alertId: '00000000-0000-0000-0000-000000000000', orgId, severity: 'INFO', title: 'Perfmon test notification', message: `Channel "${ch.name}" is configured correctly.`, link: config.publicUrl, status: 'FIRING' });
}

/** Job: deliver one alert to its channels (retried by the queue on failure). */
registerJob('alert.notify', async ({ alertId, channelIds, status }) => {
  const a = await one(`SELECT a.*, p.organization_id, r.run_key FROM alerts a JOIN projects p ON p.id = a.project_id LEFT JOIN test_runs r ON r.id = a.run_id WHERE a.id = $1`, [alertId]);
  if (!a) return { skipped: true };
  const msg: AlertMessage = {
    alertId, orgId: a.organization_id, severity: a.severity, title: a.title, message: a.message ?? '', status: status ?? a.status,
    link: `${config.publicUrl.replace(/\/$/, '')}/${a.run_key ? `runs/${a.run_key}` : 'alerts'}`, value: a.value, threshold: a.threshold, runKey: a.run_key,
  };
  const ids: string[] = channelIds?.length ? channelIds : [];
  const channels = ids.length ? await query(`SELECT * FROM notification_channels WHERE id = ANY($1::uuid[]) AND enabled`, [ids]) : [];
  if (!channels.some((c) => c.type === 'IN_APP')) channels.unshift({ id: null, type: 'IN_APP', config: {}, name: 'In-app', secret_ciphertext: null });
  const results: any[] = [];
  for (const ch of channels) {
    try {
      await notifiers.get(ch.type)!({ config: ch.config, secret: ch.secret_ciphertext ? decryptSecret(ch.secret_ciphertext) : null, name: ch.name }, msg);
      await query(`INSERT INTO alert_events (alert_id, kind, channel_id, details) VALUES ($1,'NOTIFIED',$2,$3)`, [alertId, ch.id, JSON.stringify({ type: ch.type })]);
      results.push({ channel: ch.name, ok: true });
    } catch (e) {
      await query(`INSERT INTO alert_events (alert_id, kind, channel_id, details) VALUES ($1,'NOTIFY_FAILED',$2,$3)`, [alertId, ch.id, JSON.stringify({ type: ch.type, error: (e as Error).message })]);
      results.push({ channel: ch.name, ok: false, error: (e as Error).message });
    }
  }
  return results;
});

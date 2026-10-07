import { useNavigate, useParams } from 'react-router-dom';
import { Activity, Archive, Cog, History, KeyRound, ListChecks, ShieldCheck, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuth } from '@/stores/auth';
import { PageHeader, Tabs } from '@/components/ui';
import { RolesTab, UsersTab } from '@/components/platform/admin/UsersTab';
import { ApiKeysTab, AuditTab } from '@/components/platform/admin/KeysAuditTabs';
import { RetentionTab, SettingsTab } from '@/components/platform/admin/SettingsTabs';
import { HealthTab, JobsTab } from '@/components/platform/admin/OpsTabs';

type TabKey = 'users' | 'roles' | 'api-keys' | 'audit' | 'settings' | 'retention' | 'jobs' | 'health';

const TABS: { key: TabKey; label: string; icon: LucideIcon; perm: string; render: () => JSX.Element; hint: string }[] = [
  { key: 'users', label: 'Users', icon: Users, perm: 'MANAGE_USERS', render: () => <UsersTab />, hint: 'Create accounts, assign roles, deactivate users and issue password links.' },
  { key: 'roles', label: 'Roles & permissions', icon: ShieldCheck, perm: 'MANAGE_USERS', render: () => <RolesTab />, hint: 'What each role is allowed to do.' },
  { key: 'api-keys', label: 'API keys', icon: KeyRound, perm: 'MANAGE_API_KEYS', render: () => <ApiKeysTab />, hint: 'Keys for JMeter, the collector and CI pipelines (scope ingest / read).' },
  { key: 'audit', label: 'Audit log', icon: History, perm: 'VIEW_AUDIT', render: () => <AuditTab />, hint: 'Who changed what, and when.' },
  { key: 'settings', label: 'Settings', icon: Cog, perm: 'MANAGE_SETTINGS', render: () => <SettingsTab />, hint: 'Performance score weights, regression thresholds and other platform settings.' },
  { key: 'retention', label: 'Retention', icon: Archive, perm: 'MANAGE_SETTINGS', render: () => <RetentionTab />, hint: 'How long metrics, logs and artifacts are kept; confirmed purges.' },
  { key: 'jobs', label: 'Background jobs', icon: ListChecks, perm: 'MANAGE_SETTINGS', render: () => <JobsTab />, hint: 'Report parsing, analysis and notification jobs; retry failures.' },
  { key: 'health', label: 'Platform health', icon: Activity, perm: 'MANAGE_SETTINGS', render: () => <HealthTab />, hint: 'API, database, ingestion, live connections and storage.' },
];

export function AdminPage() {
  const can = useAuth((s) => s.can);
  const nav = useNavigate();
  const { tab } = useParams<{ tab?: TabKey }>();
  const visible = TABS.filter((t) => can(t.perm));
  if (!visible.length) {
    return (
      <div>
        <PageHeader title="Administration" />
        <div className="notice">Your role has no administration permissions. Ask a Perfmon administrator if you need access to users, API keys or settings.</div>
      </div>
    );
  }
  const current = visible.find((t) => t.key === tab) ?? visible[0];
  return (
    <div className="stack" style={{ gap: 12 }}>
      <PageHeader title="Administration" subtitle={current.hint} />
      <Tabs tabs={visible.map((t) => ({ key: t.key, label: <span className="row" style={{ gap: 6 }}><t.icon size={14} />{t.label}</span> }))}
        value={current.key} onChange={(k) => nav(`/admin/${k}`)} />
      <div key={current.key}>{current.render()}</div>
    </div>
  );
}

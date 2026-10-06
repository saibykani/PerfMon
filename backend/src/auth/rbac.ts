export const PERMISSIONS = {
  VIEW_PROJECT: 'View projects, applications, environments and inventory',
  MANAGE_PROJECT: 'Create/edit/delete projects, applications, environments, servers, releases',
  CREATE_TEST: 'Create performance tests',
  EDIT_TEST: 'Edit performance tests and load profiles',
  DELETE_TEST: 'Delete performance tests',
  EXECUTE_TEST: 'Create, start, complete and abort test runs',
  DELETE_RUN: 'Delete test runs',
  VIEW_RUN: 'View test runs and metrics',
  INGEST_METRICS: 'Send metrics to the ingestion API',
  UPLOAD_ARTIFACT: 'Upload artifacts and HTML reports',
  DELETE_ARTIFACT: 'Delete artifacts',
  CREATE_DASHBOARD: 'Create dashboards',
  EDIT_DASHBOARD: 'Edit dashboards',
  DELETE_DASHBOARD: 'Delete dashboards',
  CONFIGURE_ALERT: 'Configure alert rules and notification channels',
  CONFIGURE_SLA: 'Configure SLA/SLO profiles',
  VIEW_REPORT: 'View reports',
  EXPORT_REPORT: 'Generate and export reports',
  MANAGE_USERS: 'Manage users and roles',
  MANAGE_INTEGRATIONS: 'Manage integrations',
  MANAGE_API_KEYS: 'Create, rotate and revoke API keys',
  VIEW_AUDIT: 'View the audit log',
  MANAGE_SETTINGS: 'Manage platform settings, retention and scoring',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

const VIEW: Permission[] = ['VIEW_PROJECT', 'VIEW_RUN', 'VIEW_REPORT'];

export const ROLES: Record<string, { description: string; permissions: Permission[] }> = {
  SUPER_ADMIN: { description: 'Full access to everything', permissions: ALL_PERMISSIONS },
  ADMIN: { description: 'Organization administrator', permissions: ALL_PERMISSIONS },
  PERFORMANCE_ENGINEER: {
    description: 'Designs, executes and analyses performance tests',
    permissions: [...VIEW, 'MANAGE_PROJECT', 'CREATE_TEST', 'EDIT_TEST', 'DELETE_TEST', 'EXECUTE_TEST', 'DELETE_RUN', 'INGEST_METRICS', 'UPLOAD_ARTIFACT', 'DELETE_ARTIFACT', 'CREATE_DASHBOARD', 'EDIT_DASHBOARD', 'DELETE_DASHBOARD', 'CONFIGURE_ALERT', 'CONFIGURE_SLA', 'EXPORT_REPORT', 'MANAGE_API_KEYS'],
  },
  QA_ENGINEER: {
    description: 'Runs tests and reviews results',
    permissions: [...VIEW, 'CREATE_TEST', 'EDIT_TEST', 'EXECUTE_TEST', 'INGEST_METRICS', 'UPLOAD_ARTIFACT', 'CREATE_DASHBOARD', 'EDIT_DASHBOARD', 'EXPORT_REPORT'],
  },
  DEVELOPER: { description: 'Investigates endpoint latency and errors', permissions: [...VIEW, 'UPLOAD_ARTIFACT', 'CREATE_DASHBOARD', 'EDIT_DASHBOARD', 'EXPORT_REPORT'] },
  SRE: { description: 'Infrastructure, service health and alerting', permissions: [...VIEW, 'CREATE_DASHBOARD', 'EDIT_DASHBOARD', 'CONFIGURE_ALERT', 'EXPORT_REPORT', 'MANAGE_INTEGRATIONS'] },
  ARCHITECT: { description: 'Capacity, scalability and bottlenecks', permissions: [...VIEW, 'CREATE_DASHBOARD', 'EDIT_DASHBOARD', 'CONFIGURE_SLA', 'EXPORT_REPORT'] },
  MANAGER: { description: 'Executive KPIs, SLA, regressions and trends', permissions: [...VIEW, 'CREATE_DASHBOARD', 'EXPORT_REPORT'] },
  VIEWER: { description: 'Read-only access', permissions: VIEW },
};

/** Permissions granted to API keys per scope. */
export const API_KEY_SCOPES: Record<string, Permission[]> = {
  ingest: ['VIEW_PROJECT', 'VIEW_RUN', 'EXECUTE_TEST', 'INGEST_METRICS', 'UPLOAD_ARTIFACT', 'CREATE_TEST'],
  read: ['VIEW_PROJECT', 'VIEW_RUN', 'VIEW_REPORT', 'EXPORT_REPORT'],
};

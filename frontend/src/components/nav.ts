import {
  LayoutDashboard, FolderKanban, Boxes, FlaskConical, PlayCircle, LayoutGrid, Radio, ArrowLeftRight, Network, Server, Activity,
  Database, ShieldCheck, Bell, Lightbulb, TrendingDown, GitCompare, LineChart, Gauge, FileText, Paperclip, Tag, Plug, Settings, BookOpen, CalendarClock,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem { to: string; label: string; icon: LucideIcon; section: string; perm?: string }

/** Sidebar structure (spec §61) + Help & Documentation (§85). */
export const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, section: 'Perfmon' },
  { to: '/projects', label: 'Projects', icon: FolderKanban, section: 'Inventory' },
  { to: '/applications', label: 'Applications', icon: Boxes, section: 'Inventory' },
  { to: '/tests', label: 'Performance Tests', icon: FlaskConical, section: 'Testing' },
  { to: '/runs', label: 'Test Runs', icon: PlayCircle, section: 'Testing' },
  { to: '/dashboards', label: 'Dashboards', icon: LayoutGrid, section: 'Observability' },
  { to: '/live', label: 'Live Monitoring', icon: Radio, section: 'Observability' },
  { to: '/transactions', label: 'Transactions', icon: ArrowLeftRight, section: 'Observability' },
  { to: '/apis', label: 'APIs', icon: Network, section: 'Observability' },
  { to: '/infrastructure', label: 'Infrastructure', icon: Server, section: 'Observability' },
  { to: '/app-monitoring', label: 'Applications Monitoring', icon: Activity, section: 'Observability' },
  { to: '/databases', label: 'Databases', icon: Database, section: 'Observability' },
  { to: '/events', label: 'Events & Annotations', icon: CalendarClock, section: 'Observability' },
  { to: '/sla', label: 'SLA / SLO', icon: ShieldCheck, section: 'Analysis' },
  { to: '/alerts', label: 'Alerts', icon: Bell, section: 'Analysis' },
  { to: '/insights', label: 'Performance Insights', icon: Lightbulb, section: 'Analysis' },
  { to: '/regression', label: 'Regression', icon: TrendingDown, section: 'Analysis' },
  { to: '/compare', label: 'Compare Runs', icon: GitCompare, section: 'Analysis' },
  { to: '/trends', label: 'Trends', icon: LineChart, section: 'Analysis' },
  { to: '/capacity', label: 'Capacity Planning', icon: Gauge, section: 'Analysis' },
  { to: '/reports', label: 'Reports', icon: FileText, section: 'Reporting' },
  { to: '/artifacts', label: 'Artifacts', icon: Paperclip, section: 'Reporting' },
  { to: '/releases', label: 'Releases', icon: Tag, section: 'Reporting' },
  { to: '/integrations', label: 'Integrations', icon: Plug, section: 'Platform' },
  { to: '/admin', label: 'Administration', icon: Settings, section: 'Platform' },
  { to: '/help', label: 'Help & Documentation', icon: BookOpen, section: 'Platform' },
];

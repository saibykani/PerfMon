import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, KeyRound, Lock, Mail, Minus, Pencil, Plus, UserCheck, UserX, Users } from 'lucide-react';
import { api } from '@/services/api';
import { useAuth } from '@/stores/auth';
import { Card, Modal, ConfirmDialog } from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { fmtDate } from '@/components/format';
import { Chip, CopyBox, EmptyState, errMsg, FormField, PillSelect, relTime, SkeletonRows, toast, Unavailable, plural } from '@/components/platform/kit';

export interface Role { name: string; description: string; isSystem?: boolean; permissions: string[]; userCount: number }
interface Permission { code: string; description: string; roles: string[] }
interface User { id: string; email: string; name: string; isActive: boolean; roles: string[]; lastLoginAt: string | null; createdAt: string; lockedUntil: string | null; failedLoginCount?: number }

const roleLabel = (r: string) => r.split('_').map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
const initials = (n: string) => n.split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function useRoles() {
  return useQuery({ queryKey: ['admin-roles'], queryFn: () => api.get<Role[]>('/admin/roles'), staleTime: 60000 });
}

/* ------------------------------------------------------------------ users */

export function UsersTab() {
  const me = useAuth((s) => s.user);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-users'], queryFn: () => api.get<User[]>('/admin/users', { includeInactive: true }) });
  const roles = useRoles();
  const [editing, setEditing] = useState<User | 'new' | null>(null);
  const [toggling, setToggling] = useState<User | null>(null);
  const [link, setLink] = useState<{ title: string; email: string; link: string; expiresAt?: string; emailed: boolean } | null>(null);
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('active');

  const active = useMutation({
    mutationFn: (u: User) => api.patch(`/admin/users/${u.id}`, { isActive: !u.isActive }),
    onSuccess: (_d, u) => { toast.success(`${u.name} ${u.isActive ? 'deactivated' : 'reactivated'}.`); qc.invalidateQueries({ queryKey: ['admin-users'] }); qc.invalidateQueries({ queryKey: ['admin-roles'] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const reset = useMutation({
    mutationFn: (u: User) => api.post<{ link: string; expiresAt: string; emailed: boolean }>(`/admin/users/${u.id}/reset-link`, {}),
    onSuccess: (r, u) => { setLink({ title: 'Password reset link', email: u.email, ...r }); },
    onError: (e) => toast.error(errMsg(e)),
  });

  const rows = (q.data ?? []).filter((u) => filter === 'all' || (filter === 'active' ? u.isActive : !u.isActive));
  const cols: Column<User>[] = [
    {
      key: 'name', header: 'User', render: (u) => (
        <div className="row" style={{ gap: 10 }}>
          <div className="avatar" style={u.isActive ? undefined : { background: 'var(--surface-3)', color: 'var(--text-3)' }}>{initials(u.name)}</div>
          <div><div style={{ fontWeight: 600 }}>{u.name}{u.id === me?.id && <span className="muted" style={{ fontWeight: 400 }}> (you)</span>}</div><div className="muted" style={{ fontSize: 12 }}>{u.email}</div></div>
        </div>
      ), value: (u) => `${u.name} ${u.email}`,
    },
    { key: 'roles', header: 'Roles', render: (u) => <div className="row wrap" style={{ gap: 4, maxWidth: 360 }}>{u.roles.map((r) => <span key={r} className={`pf-tag`} style={r.includes('ADMIN') ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}>{roleLabel(r)}</span>)}</div>, value: (u) => u.roles.join(' ') },
    {
      key: 'isActive', header: 'Status', render: (u) => !u.isActive ? <Chip tone="neutral" icon={<Minus size={11} />}>Inactive</Chip>
        : u.lockedUntil && new Date(u.lockedUntil) > new Date() ? <Chip tone="warn" icon={<Lock size={11} />} title={`Locked until ${fmtDate(u.lockedUntil)}`}>Locked</Chip>
          : <Chip tone="pass">Active</Chip>, value: (u) => (u.isActive ? 1 : 0),
    },
    { key: 'lastLoginAt', header: 'Last login', render: (u) => <span title={fmtDate(u.lastLoginAt)}>{u.lastLoginAt ? relTime(u.lastLoginAt) : <span className="muted">never</span>}</span>, value: (u) => (u.lastLoginAt ? new Date(u.lastLoginAt).getTime() : 0) },
    { key: 'createdAt', header: 'Created', render: (u) => fmtDate(u.createdAt), value: (u) => new Date(u.createdAt).getTime(), hidden: true },
    {
      key: 'actions', header: '', sortable: false, render: (u) => (
        <div className="pf-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn btn-ghost icon-btn btn-sm" title="Edit name & roles" aria-label={`Edit ${u.name}`} onClick={() => setEditing(u)}><Pencil size={13} /></button>
          {u.isActive && <button className="btn btn-ghost icon-btn btn-sm" title="Send password reset link" aria-label={`Reset link for ${u.name}`} disabled={reset.isPending} onClick={() => reset.mutate(u)}><KeyRound size={13} /></button>}
          {u.id !== me?.id && <button className="btn btn-ghost icon-btn btn-sm" title={u.isActive ? 'Deactivate' : 'Reactivate'} aria-label={u.isActive ? `Deactivate ${u.name}` : `Reactivate ${u.name}`} onClick={() => setToggling(u)}>{u.isActive ? <UserX size={13} /> : <UserCheck size={13} />}</button>}
        </div>
      ),
    },
  ];
  const counts = { active: (q.data ?? []).filter((u) => u.isActive).length, inactive: (q.data ?? []).filter((u) => !u.isActive).length };

  return (
    <div className="stack">
      <Card noPad title="Users" actions={<button className="btn btn-sm btn-primary" onClick={() => setEditing('new')}><Plus size={13} />Invite user</button>}>
        {q.error ? <div className="card-body"><Unavailable what="Users" error={q.error} /></div> : (
          <DataTable rows={rows} columns={cols} rowKey={(u) => u.id} loading={q.isLoading} exportName="users" onRowClick={(u) => setEditing(u)}
            toolbar={<div className="seg">
              <button className={filter === 'active' ? 'on' : ''} onClick={() => setFilter('active')}>Active · {counts.active}</button>
              <button className={filter === 'inactive' ? 'on' : ''} onClick={() => setFilter('inactive')}>Inactive · {counts.inactive}</button>
              <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All</button>
            </div>}
            empty={<EmptyState icon={<Users size={20} />} title="No users match">Invite teammates and assign roles to control what they can see and change.</EmptyState>} />
        )}
      </Card>
      {editing && <UserForm user={editing === 'new' ? null : editing} roles={roles.data ?? []} onClose={() => setEditing(null)}
        onCreated={(r) => r.setPasswordLink && setLink({ title: 'Account created — password set link', email: r.email, link: r.setPasswordLink, expiresAt: r.setPasswordExpiresAt ?? undefined, emailed: r.emailed })} />}
      <ConfirmDialog open={!!toggling} onClose={() => setToggling(null)} danger={!!toggling?.isActive} confirmLabel={toggling?.isActive ? 'Deactivate' : 'Reactivate'}
        title={toggling?.isActive ? 'Deactivate user' : 'Reactivate user'}
        message={toggling?.isActive ? <>Deactivate <b>{toggling?.name}</b>? They are signed out and can no longer log in. Their history and audit entries are kept.</> : <>Reactivate <b>{toggling?.name}</b>? Failed-login lockouts are cleared.</>}
        onConfirm={() => toggling && active.mutate(toggling)} />
      <Modal open={!!link} onClose={() => setLink(null)} title={link?.title ?? ''} width={560} footer={<button className="btn btn-primary" onClick={() => setLink(null)}>Done</button>}>
        {link && (
          <div className="stack">
            {link.emailed
              ? <div className="pf-result ok"><Mail size={14} /><span className="msg">Emailed to <b>{link.email}</b>. You can also share the link below.</span></div>
              : <div className="pf-callout warn"><Mail size={14} /><div>SMTP is not configured, so no email was sent. Share this one-time link with <b>{link.email}</b> over a secure channel.</div></div>}
            <CopyBox value={link.link} title="One-time link" tone="secret" warning={`Single use${link.expiresAt ? ` · expires ${fmtDate(link.expiresAt)}` : ''}. It won't be shown again.`} />
          </div>
        )}
      </Modal>
    </div>
  );
}

function UserForm({ user, roles, onClose, onCreated }: { user: User | null; roles: Role[]; onClose: () => void; onCreated: (r: any) => void }) {
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [sel, setSel] = useState<string[]>(user?.roles ?? ['VIEWER']);
  const [withPassword, setWithPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const errors: Record<string, string> = {};
  if (!name.trim()) errors.name = 'Name is required';
  if (!user && !EMAIL_RE.test(email.trim())) errors.email = 'Enter a valid email address';
  if (!sel.length) errors.roles = 'Assign at least one role';
  if (!user && withPassword && (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password))) errors.password = 'At least 8 characters with letters and digits';
  const valid = !Object.keys(errors).length;
  const err = (k: string) => (submitted ? errors[k] : undefined);
  const perms = useMemo(() => new Set(roles.filter((r) => sel.includes(r.name)).flatMap((r) => r.permissions)), [roles, sel]);
  const canSuper = me?.roles.includes('SUPER_ADMIN');

  const save = useMutation({
    mutationFn: () => user ? api.patch(`/admin/users/${user.id}`, { name: name.trim(), roles: sel })
      : api.post<any>('/admin/users', { email: email.trim(), name: name.trim(), roles: sel, ...(withPassword ? { password } : {}) }),
    onSuccess: (r: any) => { toast.success(user ? `${name.trim()} updated.` : `${name.trim()} invited.`); qc.invalidateQueries({ queryKey: ['admin-users'] }); qc.invalidateQueries({ queryKey: ['admin-roles'] }); onClose(); if (!user) onCreated(r); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const submit = () => { setSubmitted(true); if (valid) save.mutate(); };
  return (
    <Modal open onClose={onClose} width={640} title={user ? `Edit ${user.name}` : 'Invite user'}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={save.isPending} onClick={submit}>{save.isPending ? 'Saving…' : user ? 'Save' : 'Create user'}</button></>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="pf-form-grid">
          <FormField label="Full name" required error={err('name')}><input className="input" autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></FormField>
          <FormField label="Email" required={!user} error={err('email')}><input className="input" type="email" value={email} disabled={!!user} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" /></FormField>
        </div>
        <FormField label="Roles" required error={err('roles')} hint={`${perms.size} effective permissions`}>
          {!roles.length ? <SkeletonRows rows={1} height={26} /> : (
            <PillSelect value={sel} onChange={setSel} options={roles.map((r) => ({ value: r.name, label: roleLabel(r.name), hint: r.description }))} />
          )}
        </FormField>
        {sel.includes('SUPER_ADMIN') && !canSuper && <div className="pf-callout warn"><Lock size={14} /><div>Only a Super Admin can grant the Super Admin role — the server will reject this change.</div></div>}
        {!user && (
          <div className="stack" style={{ gap: 8 }}>
            <div className="seg" style={{ alignSelf: 'flex-start' }}>
              <button type="button" className={!withPassword ? 'on' : ''} onClick={() => setWithPassword(false)}>Send set-password link</button>
              <button type="button" className={withPassword ? 'on' : ''} onClick={() => setWithPassword(true)}>Set initial password</button>
            </div>
            {withPassword ? (
              <FormField label="Initial password" required error={err('password')} hint="Share it securely; the user should change it after first login.">
                <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </FormField>
            ) : <div className="pf-sub">A one-time link (valid 72 h) is emailed to the user. If SMTP is not configured, the link is shown to you to share.</div>}
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ roles matrix */

export function RolesTab() {
  const roles = useRoles();
  const perms = useQuery({ queryKey: ['admin-permissions'], queryFn: () => api.get<Permission[]>('/admin/permissions'), staleTime: Infinity });
  if (roles.isLoading || perms.isLoading) return <SkeletonRows rows={6} />;
  if (roles.error) return <Unavailable what="Roles" error={roles.error} />;
  const rs = roles.data ?? [];
  const ps = perms.data ?? [...new Set(rs.flatMap((r) => r.permissions))].sort().map((code) => ({ code, description: '', roles: [] }));
  return (
    <div className="stack">
      <div className="pf-callout"><Lock size={14} /><div>System roles are built in and <b>read-only</b>. Grant access by assigning one or more roles to a user — effective permissions are the union of their roles.</div></div>
      <div className="pf-grid-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
        {rs.map((r) => (
          <div key={r.name} className="pf-metric">
            <div className="row"><b>{roleLabel(r.name)}</b><div className="spacer" />{r.isSystem !== false && <span className="pf-tag"><Lock size={10} />System</span>}</div>
            <div className="pf-metric-sub" style={{ whiteSpace: 'normal' }}>{r.description}</div>
            <div className="row" style={{ gap: 6 }}><Chip tone="accent" icon={<Users size={11} />}>{plural(r.userCount, 'user')}</Chip><span className="muted" style={{ fontSize: 12 }}>{r.permissions.length} / {ps.length} permissions</span></div>
          </div>
        ))}
      </div>
      <Card noPad title="Permission matrix">
        <div className="table-wrap" style={{ maxHeight: 640 }}>
          <table className="table pf-matrix">
            <thead><tr><th>Permission</th>{rs.map((r) => <th key={r.name} className="c rot" title={r.description}>{roleLabel(r.name)}</th>)}</tr></thead>
            <tbody>
              {ps.map((p) => (
                <tr key={p.code}>
                  <td className="perm"><div className="mono" style={{ fontWeight: 600, fontSize: 11.5 }}>{p.code}</div>{p.description && <div className="muted" style={{ fontSize: 12 }}>{p.description}</div>}</td>
                  {rs.map((r) => {
                    const has = r.permissions.includes(p.code);
                    return <td key={r.name} className="c" aria-label={`${r.name} ${has ? 'has' : 'lacks'} ${p.code}`}>{has ? <Check size={15} className="pf-yes" /> : <Minus size={13} className="pf-no" />}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

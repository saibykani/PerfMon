import bcrypt from 'bcryptjs';
import { one, query } from '../db/pool.js';
import { config } from '../config.js';
import { PERMISSIONS, ROLES } from '../auth/rbac.js';

/** Idempotent: ensures permissions, system roles, a default organization and (if configured) the demo admin exist. */
export async function bootstrap(log: (m: string) => void = console.log) {
  for (const [code, description] of Object.entries(PERMISSIONS)) {
    await query(`INSERT INTO permissions (code, description) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description`, [code, description]);
  }
  for (const [name, def] of Object.entries(ROLES)) {
    const role = await one(`INSERT INTO roles (name, description) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description RETURNING id`, [name, def.description]);
    await query(`DELETE FROM role_permissions WHERE role_id = $1 AND permission_id NOT IN (SELECT id FROM permissions WHERE code = ANY($2))`, [role.id, def.permissions]);
    await query(`INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE code = ANY($2) ON CONFLICT DO NOTHING`, [role.id, def.permissions]);
  }
  let org = await one(`SELECT id FROM organizations ORDER BY created_at LIMIT 1`);
  if (!org) org = await one(`INSERT INTO organizations (name, slug) VALUES ('Perfmon', 'perfmon') RETURNING id`);
  const users = await one(`SELECT count(*)::int n FROM users`);
  if (users.n === 0) {
    if (!config.demoAdminPassword) {
      log('[bootstrap] No users exist and DEMO_ADMIN_PASSWORD is not set — set it to create the initial administrator.');
    } else {
      const u = await one(`INSERT INTO users (organization_id, email, name, password_hash) VALUES ($1,$2,'Perfmon Administrator',$3) RETURNING id`,
        [org.id, config.demoAdminEmail, await bcrypt.hash(config.demoAdminPassword, 10)]);
      await query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = 'SUPER_ADMIN'`, [u.id]);
      log(`[bootstrap] Created initial administrator ${config.demoAdminEmail} (password from DEMO_ADMIN_PASSWORD)`);
    }
  }
  return { orgId: org.id as string };
}

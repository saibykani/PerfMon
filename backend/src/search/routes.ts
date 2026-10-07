import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { requirePermission, principalOf } from '../auth/principal.js';
import { typed, z } from '../lib/http.js';
import { likeEscape } from '../lib/scope.js';

type HitType = 'Run' | 'Test' | 'Application' | 'Project' | 'Build' | 'Release' | 'Transaction' | 'Endpoint' | 'Artifact' | 'Report' | 'Dashboard';
interface Hit { type: HitType; id: string; title: string; subtitle?: string; url: string; score: number }

// Tie-break order when relevance is equal
const TYPE_RANK: Record<HitType, number> = { Run: 0, Test: 1, Build: 2, Release: 3, Transaction: 4, Endpoint: 5, Application: 6, Project: 7, Dashboard: 8, Report: 9, Artifact: 10 };
const RUN_KEY_RE = /^pf-\d{4}-\d{2}-\d{2}-\d+$/i;
const enc = encodeURIComponent;

/** Relevance: exact (100) > prefix (80) > word-prefix (65) > contains (50) + trigram similarity bonus. */
function score(q: string, ...fields: (string | null | undefined)[]) {
  const needle = q.toLowerCase();
  let best = 0;
  for (const f of fields) {
    if (!f) continue;
    const h = f.toLowerCase();
    let s = 0;
    if (h === needle) s = 100;
    else if (h.startsWith(needle)) s = 80;
    else if (new RegExp(`[\\s/_.:\\-]${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(h)) s = 65;
    else if (h.includes(needle)) s = 50;
    else s = 20; // trigram-only match
    s += Math.min(10, (needle.length / Math.max(h.length, 1)) * 10);
    best = Math.max(best, s);
  }
  return best;
}

export async function searchRoutes(app: FastifyInstance) {
  const r = typed(app);

  r.get('/search', {
    preHandler: requirePermission('VIEW_PROJECT'),
    schema: {
      tags: ['Search'], summary: 'Global search: Run IDs, builds, commits, tests, applications, projects, releases, transactions, endpoints, artifacts, reports, dashboards',
      querystring: z.object({ q: z.string().default(''), limit: z.coerce.number().int().min(1).max(20).default(20) }),
    },
  }, async (req) => {
    const p = principalOf(req);
    const q = req.query.q.trim().slice(0, 200);
    if (q.length < 1) return { items: [] };
    const limit = req.query.limit;
    const like = `%${likeEscape(q)}%`;
    const prefix = `${likeEscape(q)}%`;
    const per = Math.max(limit, 10);
    const proj = p.projectId ?? null;
    const canRuns = p.permissions.has('VIEW_RUN');
    const canReports = p.permissions.has('VIEW_REPORT');
    const userId = p.kind === 'user' ? p.id : null;
    // Common params: $1 org, $2 like, $3 prefix, $4 limit, $5 project binding (api keys), $6 raw q
    const params = [p.orgId, like, prefix, per, proj, q];
    const projCond = (col: string) => `($5::uuid IS NULL OR ${col} = $5)`;
    const trgm = q.length >= 3;

    // Declares every parameter's type so queries that don't reference all of them still prepare.
    const PARAMS_CTE = `WITH _params AS (SELECT $1::uuid, $2::text, $3::text, $4::int, $5::uuid, $6::text) `;
    const sq = (sql: string, ps: unknown[] = params) => query(PARAMS_CTE + sql, ps);
    const tasks: Promise<Hit[]>[] = [];
    if (canRuns) {
      tasks.push(sq(
        `SELECT r.id, r.run_key, r.build_number, r.commit_sha, r.status, r.result, t.name test_name, e.name env_name
         FROM test_runs r JOIN performance_tests t ON t.id = r.test_id JOIN environments e ON e.id = r.environment_id
         WHERE r.organization_id = $1 AND r.deleted_at IS NULL AND ${projCond('r.project_id')}
           AND (r.run_key ILIKE $2 OR r.build_number ILIKE $2 OR r.commit_sha ILIKE $3 OR r.execution_id = $6 OR r.branch ILIKE $2)
         ORDER BY (upper(r.run_key) = upper($6)) DESC, COALESCE(r.started_at, r.created_at) DESC LIMIT $4`, params).then((rows) => rows.map((x) => ({
        type: 'Run' as const, id: x.id, title: x.run_key,
        subtitle: [x.test_name, x.env_name, x.build_number ? `build ${x.build_number}` : null, x.commit_sha ? `commit ${String(x.commit_sha).slice(0, 10)}` : null, (x.result ?? x.status)?.replace(/_/g, ' ')].filter(Boolean).join(' · '),
        url: `/runs/${x.run_key}`,
        score: x.run_key.toUpperCase() === q.toUpperCase() ? 1000 : Math.max(score(q, x.run_key), score(q, x.build_number, x.commit_sha) - 5),
      }))));
      tasks.push(sq(
        `SELECT DISTINCT ON (t.name) t.name, r.run_key, pt.name test_name
         FROM transactions t JOIN test_runs r ON r.id = t.run_id JOIN performance_tests pt ON pt.id = r.test_id
         WHERE r.organization_id = $1 AND r.deleted_at IS NULL AND ${projCond('r.project_id')} AND t.name ILIKE $2
         ORDER BY t.name, COALESCE(r.started_at, r.created_at) DESC LIMIT $4`, params).then((rows) => rows.map((x) => ({
        type: 'Transaction' as const, id: `${x.run_key}:${x.name}`, title: x.name, subtitle: `${x.test_name} · latest in ${x.run_key}`,
        url: `/runs/${x.run_key}/transactions?name=${enc(x.name)}`, score: score(q, x.name),
      }))));
      tasks.push(sq(
        `SELECT a.id, a.name, a.kind, r.run_key FROM artifacts a JOIN test_runs r ON r.id = a.run_id
         WHERE r.organization_id = $1 AND a.deleted_at IS NULL AND r.deleted_at IS NULL AND ${projCond('a.project_id')} AND a.name ILIKE $2
         ORDER BY a.created_at DESC LIMIT $4`, params).then((rows) => rows.map((x) => ({
        type: 'Artifact' as const, id: x.id, title: x.name, subtitle: `${x.kind.replace(/_/g, ' ')} · ${x.run_key}`, url: `/runs/${x.run_key}/artifacts`, score: score(q, x.name) - 5,
      }))));
    }
    tasks.push(sq(
      `SELECT t.id, t.name, t.test_type, e.name env_name, a.name app_name FROM performance_tests t JOIN projects pr ON pr.id = t.project_id
       JOIN environments e ON e.id = t.environment_id JOIN applications a ON a.id = t.application_id
       WHERE pr.organization_id = $1 AND t.archived_at IS NULL AND ${projCond('t.project_id')} AND (t.name ILIKE $2 ${trgm ? 'OR t.name % $6' : ''})
       ORDER BY similarity(t.name, $6) DESC LIMIT $4`, params).then((rows) => rows.map((x) => ({
      type: 'Test' as const, id: x.id, title: x.name, subtitle: `${x.test_type} · ${x.app_name} / ${x.env_name}`, url: `/tests/${x.id}`, score: score(q, x.name),
    }))));
    tasks.push(sq(
      `SELECT a.id, a.name, a.code, pr.name project_name FROM applications a JOIN projects pr ON pr.id = a.project_id
       WHERE pr.organization_id = $1 AND a.archived_at IS NULL AND ${projCond('a.project_id')} AND (a.name ILIKE $2 OR a.code ILIKE $2 ${trgm ? 'OR a.name % $6' : ''})
       ORDER BY similarity(a.name, $6) DESC LIMIT $4`, params).then((rows) => rows.map((x) => ({
      type: 'Application' as const, id: x.id, title: x.name, subtitle: `${x.code} · ${x.project_name}`, url: `/applications?id=${x.id}`, score: score(q, x.name, x.code),
    }))));
    tasks.push(sq(
      `SELECT pr.id, pr.name, pr.key FROM projects pr WHERE pr.organization_id = $1 AND pr.archived_at IS NULL AND ${projCond('pr.id')}
         AND (pr.name ILIKE $2 OR pr.key ILIKE $2 ${trgm ? 'OR pr.name % $6' : ''}) ORDER BY similarity(pr.name, $6) DESC LIMIT $4`, params).then((rows) => rows.map((x) => ({
      type: 'Project' as const, id: x.id, title: x.name, subtitle: x.key, url: `/projects/${x.id}`, score: score(q, x.name, x.key),
    }))));
    tasks.push(sq(
      `SELECT b.id, b.build_number, b.branch, b.commit_sha, pr.name project_name FROM builds b JOIN projects pr ON pr.id = b.project_id
       WHERE pr.organization_id = $1 AND ${projCond('b.project_id')} AND (b.build_number ILIKE $2 OR b.commit_sha ILIKE $3)
       ORDER BY (b.build_number = $6) DESC, b.created_at DESC LIMIT $4`, params).then((rows) => rows.map((x) => ({
      type: 'Build' as const, id: x.id, title: `Build ${x.build_number}`, subtitle: [x.project_name, x.branch, x.commit_sha ? String(x.commit_sha).slice(0, 10) : null].filter(Boolean).join(' · '),
      url: `/runs?build=${enc(x.build_number)}`, score: score(q, x.build_number, x.commit_sha),
    }))));
    tasks.push(sq(
      `SELECT rl.id, rl.name, rl.version, rl.build_number, pr.name project_name FROM releases rl JOIN projects pr ON pr.id = rl.project_id
       WHERE pr.organization_id = $1 AND ${projCond('rl.project_id')} AND (rl.version ILIKE $2 OR rl.name ILIKE $2)
       ORDER BY (rl.version = $6) DESC, rl.deployment_date DESC NULLS LAST LIMIT $4`, params).then((rows) => rows.map((x) => ({
      type: 'Release' as const, id: x.id, title: `${x.name} ${x.version}`, subtitle: [x.project_name, x.build_number ? `build ${x.build_number}` : null].filter(Boolean).join(' · '),
      url: `/releases?id=${x.id}`, score: score(q, x.version, x.name),
    }))));
    tasks.push(sq(
      `SELECT ep.id, ep.method, ep.path_template, a.name app_name FROM api_endpoints ep JOIN applications a ON a.id = ep.application_id JOIN projects pr ON pr.id = a.project_id
       WHERE pr.organization_id = $1 AND ${projCond('a.project_id')} AND (ep.path_template ILIKE $2 OR (ep.method || ' ' || ep.path_template) ILIKE $2)
       ORDER BY length(ep.path_template) LIMIT $4`, params).then((rows) => rows.map((x) => ({
      type: 'Endpoint' as const, id: x.id, title: `${x.method} ${x.path_template}`, subtitle: x.app_name, url: `/apis?endpoint=${x.id}`, score: score(q, x.path_template, `${x.method} ${x.path_template}`),
    }))));
    if (canReports) {
      tasks.push(sq(
        `SELECT rp.id, rp.title, rp.type, rp.version, r.run_key FROM reports rp JOIN projects pr ON pr.id = rp.project_id LEFT JOIN test_runs r ON r.id = rp.run_id
         WHERE pr.organization_id = $1 AND ${projCond('rp.project_id')} AND (rp.title ILIKE $2 OR r.run_key ILIKE $2) ORDER BY rp.created_at DESC LIMIT $4`, params).then((rows) => rows.map((x) => ({
        type: 'Report' as const, id: x.id, title: x.title, subtitle: [x.type.replace(/_/g, ' '), `v${x.version}`, x.run_key].filter(Boolean).join(' · '), url: `/reports/${x.id}`, score: score(q, x.title, x.run_key) - 5,
      }))));
    }
    tasks.push(sq(
      `SELECT d.id, d.uid, d.name, d.is_system, pr.name project_name FROM dashboards d LEFT JOIN projects pr ON pr.id = d.project_id
       WHERE d.organization_id = $1 AND ${projCond('d.project_id')} AND (d.is_shared OR d.is_system OR d.owner_id = $7) AND d.name ILIKE $2
       ORDER BY d.is_system, d.name LIMIT $4`, [...params, userId]).then((rows) => rows.map((x) => ({
      type: 'Dashboard' as const, id: x.id, title: x.name, subtitle: [x.is_system ? 'System dashboard' : 'Dashboard', x.project_name].filter(Boolean).join(' · '), url: `/dashboards/${x.uid}`, score: score(q, x.name),
    }))));

    const settled = await Promise.allSettled(tasks);
    const hits = settled.flatMap((s) => {
      if (s.status === 'fulfilled') return s.value;
      req.log.warn({ err: s.reason }, 'search source failed');
      return [];
    });
    // A Run ID-shaped query that matches exactly always wins.
    if (RUN_KEY_RE.test(q)) for (const h of hits) if (h.type === 'Run' && h.title.toUpperCase() === q.toUpperCase()) h.score = 10000;
    hits.sort((a, b) => b.score - a.score || TYPE_RANK[a.type] - TYPE_RANK[b.type] || a.title.localeCompare(b.title));
    return { items: hits.slice(0, limit).map(({ score: _s, ...h }) => h) };
  });
}

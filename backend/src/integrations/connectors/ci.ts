import { config } from '../../config.js';
import type { Connector, Credentials, IntegrationRecord } from './types.js';
import { ConnectorError, authHeaders, basic, expectOk, http, joinUrl, probe, requireUrl } from './http.js';

/**
 * CI/CD and push-based integrations. Their main role is documented webhook/CLI usage:
 * pipelines create a run (POST /api/v1/runs), stream metrics (JMeter Backend Listener →
 * /api/v1/ingest/influx/write?runId=...), upload artifacts and complete the run. The
 * connection test performs an authenticated GET of the CI system's API root.
 */
const api = () => config.publicUrl.replace(/\/$/, '') + '/api/v1';

const PIPELINE_DOC = (system: string, snippet: string) =>
  `${system}: create an API key (scope "ingest") and store it as a CI secret PERFMON_API_KEY. Pipeline steps: ` +
  `(1) RUN_ID=$(curl -s -X POST ${api()}/runs -H "Authorization: Bearer $PERFMON_API_KEY" -H "content-type: application/json" ` +
  `-d '{"project":"<project-key>","application":"<app-code>","environment":"Performance","test":"<test name>","buildNumber":"'$BUILD'","branch":"'$BRANCH'","commit":"'$SHA'","triggeredBy":"CI","ciSystem":"${system}"}' | jq -r .runId); ` +
  `(2) run JMeter with the Backend Listener influxdbUrl=${api()}/ingest/influx/write?runId=$RUN_ID and influxdbToken=$PERFMON_API_KEY; ` +
  `(3) upload results: curl -F file=@report.zip -F kind=HTML_REPORT ${api()}/runs/$RUN_ID/artifacts; ` +
  `(4) curl -X POST ${api()}/runs/$RUN_ID/complete. ${snippet}`;

async function getRoot(i: IntegrationRecord, url: string, headers: Record<string, string>, what: string) {
  return expectOk(await http(url, { headers: { accept: 'application/json', ...headers } }), what);
}

export const jenkinsConnector: Connector = {
  type: 'JENKINS', label: 'Jenkins', category: 'CI_CD', authTypes: ['BASIC', 'NONE'],
  fields: [{ key: 'username', label: 'User', required: true, secret: true }, { key: 'apiToken', label: 'API token', required: true, secret: true }],
  supportsImport: false,
  docs: PIPELINE_DOC('jenkins', 'Use withCredentials([string(credentialsId: "perfmon-api-key", variable: "PERFMON_API_KEY")]) in a declarative pipeline stage. The connection test calls GET <jenkins>/api/json with basic auth (user + API token).'),
  async test(i, c) {
    return probe(async () => {
      const base = requireUrl(i);
      const h: Record<string, string> = c.username ? { authorization: basic(c.username, c.apiToken ?? c.password ?? '') } : {};
      const r = await getRoot(i, joinUrl(base, '/api/json?tree=mode,nodeDescription,jobs[name]'), h, 'Jenkins API');
      return { message: `Connected to Jenkins ${r.headers.get('x-jenkins') ?? ''}`.trim() + ` (${r.json?.jobs?.length ?? 0} jobs visible)`, details: { version: r.headers.get('x-jenkins'), mode: r.json?.mode } };
    });
  },
};

export const githubActionsConnector: Connector = {
  type: 'GITHUB_ACTIONS', label: 'GitHub Actions', category: 'CI_CD', authTypes: ['TOKEN'],
  fields: [{ key: 'repository', label: 'Repository (owner/name)', required: false, placeholder: 'acme/payments' }, { key: 'token', label: 'Personal access / fine-grained token', required: true, secret: true }],
  supportsImport: false,
  docs: PIPELINE_DOC('github-actions', 'Store the key as a repository secret and reference it as ${{ secrets.PERFMON_API_KEY }}; use ${{ github.run_number }}, ${{ github.ref_name }}, ${{ github.sha }} for build/branch/commit. URL defaults to https://api.github.com (set it for GitHub Enterprise: https://<host>/api/v3). The connection test calls GET / (or /repos/<repository>) with the token.'),
  async test(i, c) {
    return probe(async () => {
      const base = requireUrl(i, 'https://api.github.com');
      const h = { authorization: `Bearer ${c.token ?? ''}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'perfmon' };
      if (!c.token) throw new ConnectorError('GitHub token is not configured');
      const repo = i.config?.repository;
      const r = await getRoot(i, joinUrl(base, repo ? `/repos/${repo}` : '/user'), h, 'GitHub API');
      return { message: repo ? `Connected to GitHub repository ${r.json?.full_name}` : `Connected to GitHub as ${r.json?.login}`, details: { rateLimitRemaining: r.headers.get('x-ratelimit-remaining') } };
    });
  },
};

export const gitlabConnector: Connector = {
  type: 'GITLAB', label: 'GitLab CI', category: 'CI_CD', authTypes: ['TOKEN'],
  fields: [{ key: 'token', label: 'Access token (read_api)', required: true, secret: true }],
  supportsImport: false,
  docs: PIPELINE_DOC('gitlab', 'Define PERFMON_API_KEY as a masked CI/CD variable; use $CI_PIPELINE_IID, $CI_COMMIT_REF_NAME, $CI_COMMIT_SHA. URL defaults to https://gitlab.com. The connection test calls GET /api/v4/version with the PRIVATE-TOKEN header.'),
  async test(i, c) {
    return probe(async () => {
      const base = requireUrl(i, 'https://gitlab.com');
      if (!c.token) throw new ConnectorError('GitLab token is not configured');
      const r = await getRoot(i, joinUrl(base, '/api/v4/version'), { 'private-token': c.token }, 'GitLab API');
      return { message: `Connected to GitLab ${r.json?.version ?? ''}`.trim(), details: r.json };
    });
  },
};

export const azureDevOpsConnector: Connector = {
  type: 'AZURE_DEVOPS', label: 'Azure DevOps', category: 'CI_CD', authTypes: ['TOKEN', 'BASIC'],
  fields: [{ key: 'token', label: 'Personal access token (Build: read)', required: true, secret: true }],
  supportsImport: false,
  docs: PIPELINE_DOC('azure-devops', 'Add PERFMON_API_KEY as a secret pipeline variable and map it into the script env; use $(Build.BuildNumber), $(Build.SourceBranchName), $(Build.SourceVersion). URL = https://dev.azure.com/<organization>. The connection test calls GET <url>/_apis/projects?api-version=7.0 with the PAT (basic auth).'),
  async test(i, c) {
    return probe(async () => {
      const base = requireUrl(i);
      const pat = c.token ?? c.password;
      if (!pat) throw new ConnectorError('Azure DevOps personal access token is not configured');
      const r = await getRoot(i, joinUrl(base, '/_apis/projects?api-version=7.0&$top=10'), { authorization: basic(c.username ?? '', pat) }, 'Azure DevOps API');
      if (!r.json) throw new ConnectorError('Azure DevOps returned a non-JSON response (sign-in page?) — check the PAT');
      return { message: `Connected to Azure DevOps (${r.json?.count ?? 0} project(s) visible)`, details: { projects: (r.json?.value ?? []).map((p: any) => p.name) } };
    });
  },
};

export const jmeterConnector: Connector = {
  type: 'JMETER', label: 'Apache JMeter', category: 'LOAD_TESTING', authTypes: ['NONE'],
  fields: [],
  supportsImport: false,
  docs: `Push-based. In the test plan add a Backend Listener → org.apache.jmeter.visualizers.backend.influxdb.InfluxdbBackendListenerClient with influxdbUrl=${api()}/ingest/influx/write?runId=<RUN_ID>, application=<app>, measurement=jmeter, summaryOnly=false, percentiles=50;90;95;99 and influxdbToken=<pmk_ API key>. Alternatively post raw samples/aggregates to /api/v1/runs/<RUN_ID>/metrics or upload the JTL / HTML report as run artifacts.`,
  async test() { return { ok: true, latencyMs: 0, message: 'Push-based integration: JMeter sends data to Perfmon (no outbound connection to test).' }; },
};

export const grafanaConnector: Connector = {
  type: 'GRAFANA', label: 'Grafana', category: 'DASHBOARDS', authTypes: ['API_KEY', 'TOKEN', 'BASIC'],
  fields: [{ key: 'apiKey', label: 'Service account token', required: true, secret: true }],
  supportsImport: false,
  docs: 'Links Grafana for cross-navigation. The connection test calls GET /api/health and GET /api/org with the service-account token. Perfmon dashboards do not depend on Grafana.',
  async test(i: IntegrationRecord, c: Credentials) {
    return probe(async () => {
      const base = requireUrl(i);
      const health = expectOk(await http(joinUrl(base, '/api/health')), 'Grafana health');
      const org = expectOk(await http(joinUrl(base, '/api/org'), { headers: c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : authHeaders(i, c) }), 'Grafana API');
      return { message: `Connected to Grafana ${health.json?.version ?? ''} (org ${org.json?.name ?? 'n/a'})`.replace('  ', ' '), details: { version: health.json?.version } };
    });
  },
};

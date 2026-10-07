/** Ready-to-copy integration snippets (JMeter Backend Listener, CI pipelines, OTLP). */

export interface SnippetCtx { base: string; project: string; application: string; environment: string; test: string }

const json = (c: SnippetCtx, build: string, branch: string, commit: string) =>
  `{"project":"${c.project}","application":"${c.application}","environment":"${c.environment}","test":"${c.test}","createTestIfMissing":true,"buildNumber":"${build}","branch":"${branch}","commit":"${commit}"}`;

export function jmeterListener(c: SnippetCtx) {
  return `# Test plan → Add → Listener → Backend Listener
Backend Listener implementation : org.apache.jmeter.visualizers.backend.influxdb.InfluxdbBackendListenerClient
influxdbMetricsSender           : org.apache.jmeter.visualizers.backend.influxdb.HttpMetricsSender
influxdbUrl                     : ${c.base}/api/v1/ingest/influx/write?runId=\${__P(perfmon.runId)}
influxdbToken                   : \${__P(perfmon.apiKey)}        # pmk_… API key with the "ingest" scope
application                     : ${c.application}
measurement                     : jmeter
summaryOnly                     : false
samplersRegex                   : .*
percentiles                     : 50;90;95;99
testTitle                       : ${c.test}
eventTags                       :

# Run non-GUI, passing the Run ID returned by POST /api/v1/runs:
jmeter -n -t plan.jmx -l results.jtl -e -o report \\
  -Jperfmon.runId=$RUN_ID -Jperfmon.apiKey=$PERFMON_API_KEY`;
}

const shellSteps = (c: SnippetCtx, build: string, branch: string, commit: string, indent = '') => {
  const L = (s: string) => s.split('\n').map((l) => indent + l).join('\n');
  return L(`set -euo pipefail
API="${c.base}/api/v1"
AUTH="Authorization: Bearer $PERFMON_API_KEY"
# 1) create the run → Run ID (PF-YYYY-MM-DD-NNNNNN)
RUN_ID=$(curl -fsS -X POST "$API/runs" -H "$AUTH" -H "content-type: application/json" \\
  -d '${json(c, build, branch, commit)}' | jq -r .runId)
echo "Perfmon run: $RUN_ID"
curl -fsS -X POST "$API/runs/$RUN_ID/start" -H "$AUTH"
# 2) execute JMeter (Backend Listener streams live metrics to Perfmon)
jmeter -n -t plan.jmx -l results.jtl -e -o report -Jperfmon.runId=$RUN_ID -Jperfmon.apiKey=$PERFMON_API_KEY
# 3) upload artifacts (HTML report as zip, raw JTL)
(cd report && zip -qr ../report.zip .)
curl -fsS -X POST "$API/runs/$RUN_ID/artifacts" -H "$AUTH" -F kind=HTML_REPORT -F file=@report.zip
curl -fsS -X POST "$API/runs/$RUN_ID/artifacts" -H "$AUTH" -F kind=JTL -F file=@results.jtl
# 4) complete → SLA, regression, insights and score are computed server-side
curl -fsS -X POST "$API/runs/$RUN_ID/complete" -H "$AUTH" -H "content-type: application/json" -d '{"status":"COMPLETED"}'`);
};

export function githubActions(c: SnippetCtx) {
  return `# .github/workflows/performance.yml
name: performance
on: { workflow_dispatch: {}, push: { branches: [main] } }
jobs:
  load-test:
    runs-on: ubuntu-latest
    env:
      PERFMON_API_KEY: \${{ secrets.PERFMON_API_KEY }}
    steps:
      - uses: actions/checkout@v4
      - name: Install JMeter
        run: |
          curl -fsSL https://archive.apache.org/dist/jmeter/binaries/apache-jmeter-5.6.3.tgz | tar xz
          echo "$PWD/apache-jmeter-5.6.3/bin" >> $GITHUB_PATH
      - name: Run test and publish to Perfmon
        run: |
${shellSteps(c, '${{ github.run_number }}', '${{ github.ref_name }}', '${{ github.sha }}', '          ')}`;
}

export function jenkinsfile(c: SnippetCtx) {
  return `// Jenkinsfile (declarative)
pipeline {
  agent any
  stages {
    stage('Performance test') {
      steps {
        withCredentials([string(credentialsId: 'perfmon-api-key', variable: 'PERFMON_API_KEY')]) {
          sh '''
${shellSteps(c, '${BUILD_NUMBER}', '${BRANCH_NAME:-main}', '${GIT_COMMIT}', '            ')}
          '''
        }
      }
    }
  }
}`;
}

export function gitlabCi(c: SnippetCtx) {
  return `# .gitlab-ci.yml  (PERFMON_API_KEY = masked CI/CD variable)
performance:
  stage: test
  image: justb4/jmeter:5.6.3
  before_script: [ "apk add --no-cache curl jq zip bash || true" ]
  script:
    - |
${shellSteps(c, '$CI_PIPELINE_IID', '$CI_COMMIT_REF_NAME', '$CI_COMMIT_SHA', '      ')}
  artifacts: { paths: [report/, results.jtl], when: always }`;
}

export function azureDevops(c: SnippetCtx) {
  return `# azure-pipelines.yml  (PERFMON_API_KEY = secret pipeline variable)
trigger: [ main ]
pool: { vmImage: ubuntu-latest }
steps:
  - bash: |
${shellSteps(c, '$(Build.BuildNumber)', '$(Build.SourceBranchName)', '$(Build.SourceVersion)', '      ')}
    displayName: Run JMeter and publish to Perfmon
    env:
      PERFMON_API_KEY: $(PERFMON_API_KEY)`;
}

export function otlp(c: SnippetCtx) {
  return `# OTLP/HTTP (JSON) endpoint
POST ${c.base}/api/v1/ingest/otlp/v1/metrics?runId=$RUN_ID
Authorization: Bearer $PERFMON_API_KEY            # API key with the "ingest" scope

# OpenTelemetry Collector exporter
exporters:
  otlphttp/perfmon:
    metrics_endpoint: ${c.base}/api/v1/ingest/otlp/v1/metrics
    encoding: json
    headers: { Authorization: "Bearer \${env:PERFMON_API_KEY}" }
# Each data point must carry the run: resource/data-point attribute perfmon.run_id=<RUN_ID>
# (or runId / run.id), or pass ?runId= on the URL. Points without a run are rejected.
processors:
  resource/perfmon:
    attributes: [ { key: perfmon.run_id, value: "\${env:PERFMON_RUN_ID}", action: upsert } ]`;
}

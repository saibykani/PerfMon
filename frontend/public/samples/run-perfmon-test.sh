#!/usr/bin/env bash
# Perfmon wrapper: create a run → run JMeter with the Perfmon Backend Listener → upload JTL + HTML report → complete the run.
#
# Usage:   ./run-perfmon-test.sh plan.jmx
# Config (environment variables):
#   PERFMON_URL          Perfmon API, e.g. http://perfmon.example.com:8080        (required)
#   PERFMON_API_KEY      API key with scope "ingest" (pmk_...)                     (required)
#   PERFMON_PROJECT      project key or name, e.g. payments                         (required)
#   PERFMON_APPLICATION  application code or name, e.g. merchant-payments           (required)
#   PERFMON_ENVIRONMENT  environment name or type, e.g. Performance                 (required)
#   PERFMON_TEST         performance test name, e.g. "200 TPS Payment Load"         (required)
#   PERFMON_BUILD        build number (optional)        JMETER_ARGS  extra JMeter options (optional)
#   JMETER               jmeter executable (default: jmeter on PATH)
# Requires: curl, zip (for the HTML report) and python3 or jq (to read JSON).
set -euo pipefail

PLAN="${1:?usage: $0 plan.jmx}"
: "${PERFMON_URL:?set PERFMON_URL}" "${PERFMON_API_KEY:?set PERFMON_API_KEY}" "${PERFMON_PROJECT:?set PERFMON_PROJECT}"
: "${PERFMON_APPLICATION:?set PERFMON_APPLICATION}" "${PERFMON_ENVIRONMENT:?set PERFMON_ENVIRONMENT}" "${PERFMON_TEST:?set PERFMON_TEST}"
JMETER="${JMETER:-jmeter}"
API="${PERFMON_URL%/}/api/v1"
AUTH=(-H "authorization: Bearer ${PERFMON_API_KEY}")

json_get() {  # json_get <field> — reads JSON on stdin
  if command -v jq >/dev/null 2>&1; then jq -r ".$1 // empty"; else python3 -c "import sys,json; print(json.load(sys.stdin).get('$1') or '')"; fi
}
json_str() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1" 2>/dev/null || printf '"%s"' "$1"; }

echo "▶ Checking Perfmon at ${PERFMON_URL} ..."
curl -sf "${API}/health" >/dev/null || { echo "✖ Perfmon API not reachable at ${API}/health"; exit 1; }

echo "▶ Creating run ..."
BODY="{\"project\":$(json_str "$PERFMON_PROJECT"),\"application\":$(json_str "$PERFMON_APPLICATION"),\"environment\":$(json_str "$PERFMON_ENVIRONMENT"),\"test\":$(json_str "$PERFMON_TEST")${PERFMON_BUILD:+,\"buildNumber\":$(json_str "$PERFMON_BUILD")}}"
RESP=$(curl -s -w '\n%{http_code}' -X POST "${API}/runs" "${AUTH[@]}" -H 'content-type: application/json' -d "$BODY")
CODE=${RESP##*$'\n'}; RESP=${RESP%$'\n'*}
[ "$CODE" = "201" ] || [ "$CODE" = "200" ] || { echo "✖ Could not create the run (HTTP $CODE): $RESP"; exit 1; }
RUN_ID=$(printf '%s' "$RESP" | json_get runId)
echo "✔ Run ID: ${RUN_ID}"

OUT="perfmon-${RUN_ID}"
rm -rf "$OUT" && mkdir -p "$OUT"
echo "▶ Running JMeter (live view: ${PERFMON_URL%:*}:3000/live/${RUN_ID}) ..."
set +e
# shellcheck disable=SC2086
"$JMETER" -n -t "$PLAN" -l "$OUT/results.jtl" -e -o "$OUT/report" -j "$OUT/jmeter.log" \
  -Jperfmon.url="${PERFMON_URL%/}" -Jperfmon.runId="$RUN_ID" -Jperfmon.token="$PERFMON_API_KEY" ${JMETER_ARGS:-}
JM=$?
set -e

upload() {  # upload <kind> <file>
  [ -f "$2" ] || { echo "  (skipped $1: $2 not found)"; return 0; }
  local c; c=$(curl -s -o /dev/null -w '%{http_code}' "${AUTH[@]}" -F "kind=$1" -F "file=@$2" "${API}/runs/${RUN_ID}/artifacts")
  [ "$c" = "201" ] || [ "$c" = "200" ] && echo "  ✔ uploaded $1" || echo "  ✖ upload of $1 failed (HTTP $c)"
}
echo "▶ Uploading results ..."
upload JTL "$OUT/results.jtl"
if [ -d "$OUT/report" ] && command -v zip >/dev/null 2>&1; then (cd "$OUT/report" && zip -qr ../report.zip .); upload HTML_REPORT "$OUT/report.zip"; fi
upload LOG "$OUT/jmeter.log"

if [ $JM -eq 0 ]; then
  curl -s -o /dev/null -X POST "${AUTH[@]}" -H 'content-type: application/json' -d '{}' "${API}/runs/${RUN_ID}/complete"
  echo "✔ Run completed — analysis started: ${PERFMON_URL%:*}:3000/runs/${RUN_ID}"
else
  curl -s -o /dev/null -X POST "${AUTH[@]}" -H 'content-type: application/json' -d "{\"status\":\"FAILED\",\"reason\":\"JMeter exited with code $JM\"}" "${API}/runs/${RUN_ID}/complete"
  echo "✖ JMeter exited with code $JM — run marked FAILED"; exit $JM
fi

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
#   PERFMON_LOADGEN_MONITOR  true (default) | false — run the Perfmon Collector on this load generator during the test
#   PERFMON_COLLECTOR    path of perfmon-collector.mjs (default: next to this script); needs Node.js 18+
#   PERFMON_SERVER       load generator name shown in Perfmon (default: hostname)
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

# Load generator monitoring: host CPU/memory/disk/network + JMeter process and JVM heap, tagged with the Run ID
COLLECTOR="${PERFMON_COLLECTOR:-$(cd "$(dirname "$0")" && pwd)/perfmon-collector.mjs}"
COLL_PID=""; COLL_STOP="$OUT/.collector-stop"
if [ "${PERFMON_LOADGEN_MONITOR:-true}" = "false" ]; then
  echo "▶ Load generator monitoring disabled (PERFMON_LOADGEN_MONITOR=false)"
elif ! command -v node >/dev/null 2>&1; then
  echo "  (load generator monitoring skipped: Node.js 18+ not found on PATH)"
elif [ ! -f "$COLLECTOR" ]; then
  echo "  (load generator monitoring skipped: $COLLECTOR not found — download perfmon-collector.mjs next to this script)"
else
  PERFMON_URL="$PERFMON_URL" PERFMON_API_KEY="$PERFMON_API_KEY" PERFMON_RUN_ID="$RUN_ID" PERFMON_ROLE=loadgen PERFMON_JMETER=true     PERFMON_STOP_FILE="$COLL_STOP" INTERVAL_SEC="${INTERVAL_SEC:-5}" node "$COLLECTOR" >"$OUT/collector.log" 2>&1 &
  COLL_PID=$!
  echo "▶ Load generator monitoring started (collector pid $COLL_PID, log $OUT/collector.log)"
fi
stop_collector() {
  [ -n "$COLL_PID" ] || return 0
  touch "$COLL_STOP"
  for _ in $(seq 1 40); do kill -0 "$COLL_PID" 2>/dev/null || break; sleep 0.5; done
  kill "$COLL_PID" 2>/dev/null || true
  COLL_PID=""
  echo "  ✔ load generator monitoring stopped"
}
trap stop_collector EXIT
echo "▶ Running JMeter (live view: ${PERFMON_URL%:*}:3000/live/${RUN_ID}) ..."
set +e
# shellcheck disable=SC2086
"$JMETER" -n -t "$PLAN" -l "$OUT/results.jtl" -e -o "$OUT/report" -j "$OUT/jmeter.log" \
  -Jperfmon.url="${PERFMON_URL%/}" -Jperfmon.runId="$RUN_ID" -Jperfmon.token="$PERFMON_API_KEY" ${JMETER_ARGS:-}
JM=$?
set -e
stop_collector

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

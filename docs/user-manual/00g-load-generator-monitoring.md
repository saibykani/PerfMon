# Monitor the load generator

A load test measures the system under test only while the machine that generates the load keeps up. When the load generator runs out of CPU, memory or JMeter heap, it sends requests late and measures response times late. Throughput then levels off and response times rise, and it looks like the application is slow when the bottleneck is the test itself.

Perfmon therefore monitors every load generator during a run. It shows the load generator's health next to the results and warns you when the results may be unreliable.

## What is monitored

The [Perfmon Collector](00d-server-monitoring.md#the-perfmon-collector) runs on the load generator with role **loadgen** and the Run ID. Every 5 seconds it samples:

| Metric | Source | Platforms |
|---|---|---|
| Host CPU % (all cores) | Node.js `os.cpus()` | all |
| Host memory % and used MB | Node.js `os.freemem()` / `os.totalmem()` | all |
| Disk usage % of the volume of the working directory | `fs.statfs` (Node.js 18.15+) | all |
| Network receive / transmit bytes per second | `/proc/net/dev` (loopback excluded) on Linux, `netstat -e` on Windows | Linux, Windows (not reported on macOS) |
| Load average (1 min) | `os.loadavg()` | Linux, macOS |
| Open file handles (system-wide) | `/proc/sys/fs/file-nr` | Linux |
| **JMeter process** CPU % and resident memory (RSS) | `/proc/<pid>` on Linux, `Get-CimInstance Win32_Process` on Windows, `ps` on macOS | all |
| **JMeter JVM** heap used / committed / max, metaspace, GC count and GC time per sample | `jstat -gc` and `jstat -gccapacity` (from the JDK) | all, when `jstat` is found |

The collector looks for the JMeter process by the `ApacheJMeter.jar` in its command line. You can also give the PID with `PERFMON_JMETER_PID`. Process CPU is a share of the **whole machine** (100 % = all cores busy). The maximum heap comes from `-Xmx` on the JMeter command line. When `-Xmx` is missing, it comes from `jstat -gccapacity`.

`jstat` is part of the JDK, not the JRE. The collector looks for it in `JAVA_HOME/bin` and then on `PATH`. If it is not found, everything else is still reported and the startup log says `jstat not found`.

The JMeter process appears in Perfmon as a service **JMeter @ <load generator>** of kind *loadgen*. Its heap is stored as JVM metrics of the load generator server. Load-generator JVMs are kept out of the application's JVM figures in the bottleneck analysis and the insights.

## Automatic: the wrapper scripts

[run-perfmon-test.sh](/samples/run-perfmon-test.sh) and [run-perfmon-test.ps1](/samples/run-perfmon-test.ps1) start the collector for you:

1. Download [perfmon-collector.mjs](/samples/perfmon-collector.mjs) into the **same folder** as the wrapper script. Node.js 18+ must be on `PATH`.
2. Run the wrapper as usual ([JMeter setup → wrapper scripts](00b-jmeter-setup.md#the-wrapper-scripts)).

After the run is created and before JMeter starts, the script starts the collector in the background. It uses `PERFMON_ROLE=loadgen`, the new Run ID, and the same `PERFMON_URL` / `PERFMON_API_KEY`. When JMeter ends, the script creates a stop file. The collector then sends its last samples and exits; the script waits up to 20 seconds before it stops the process. After that the results are uploaded and the run is completed. The collector's output goes to `perfmon-<RUN_ID>/collector.log`. With PowerShell, errors go to `collector.err.log`.

| Variable | Default | Meaning |
|---|---|---|
| `PERFMON_LOADGEN_MONITOR` | `true` | `false` turns load generator monitoring off |
| `PERFMON_COLLECTOR` | `perfmon-collector.mjs` next to the script | Path of the collector |
| `PERFMON_SERVER` | host name | Name of the load generator in Perfmon |
| `INTERVAL_SEC` | `5` | Sampling interval |

If Node.js or the collector file is missing, the script prints a one-line notice and runs the test without load generator monitoring.

## Manual: distributed JMeter engines

In remote mode (`jmeter -R lg-01,lg-02`), the wrapper only monitors the controller. Start the collector on **every engine** for the duration of the test, with the Run ID of the run:

```bash
# on each engine (Linux)
PERFMON_URL=http://perfmon.example.com:8080 PERFMON_API_KEY=pmk_… \
PERFMON_RUN_ID=PF-2026-10-12-000137 PERFMON_ROLE=loadgen \
node perfmon-collector.mjs
```

```powershell
# on each engine (Windows)
$env:PERFMON_URL="http://perfmon.example.com:8080"; $env:PERFMON_API_KEY="pmk_…"
$env:PERFMON_RUN_ID="PF-2026-10-12-000137"; $env:PERFMON_ROLE="loadgen"
node .\perfmon-collector.mjs
```

Stop it with Ctrl+C (it sends what is buffered first), or set `PERFMON_STOP_FILE=/path/to/file` and create that file when the test ends. If an engine runs a collector permanently, leave `PERFMON_RUN_ID` empty and set `PERFMON_PROJECT` and `PERFMON_ENV`. Samples are then attached to the environment's RUNNING run.

### All collector options

Each option can be set as an environment variable or as a command-line flag. The flag wins.

| Variable | Flag | Default | Meaning |
|---|---|---|---|
| `PERFMON_URL` | `--url` | `http://localhost:8080` | Perfmon API |
| `PERFMON_API_KEY` | `--key` | — | API key with scope **ingest** (not needed with `--once`) |
| `PERFMON_PROJECT` / `PERFMON_ENV` | `--project` / `--env` | — | Used when no Run ID is given |
| `PERFMON_RUN_ID` | `--run-id` | — | Run ID to attach the samples to |
| `PERFMON_SERVER` | `--server` | host name | Server name |
| `PERFMON_ROLE` | `--role` | `app` | `loadgen` for load generators |
| `INTERVAL_SEC` | `--interval` | `5` | Sampling interval (s) |
| `PERFMON_BATCH` | `--batch` | `3` | Samples per request |
| `PERFMON_BUFFER_MAX` | `--buffer-max` | `2000` | Samples kept while Perfmon is unreachable |
| `PERFMON_JMETER` | `--jmeter` | `auto` | JMeter metrics: `auto` (only for role loadgen), `true`, `false` |
| `PERFMON_JMETER_PID` | `--jmeter-pid` | auto-detect | PID of the JMeter Java process |
| `PERFMON_JSTAT` | `--jstat` | `true` | `false` skips jstat (no heap/GC) |
| `PERFMON_CPU_WARN` / `PERFMON_MEM_WARN` / `PERFMON_HEAP_WARN` | `--cpu-warn` / `--mem-warn` / `--heap-warn` | `90` | Print a warning in the collector log when crossed |
| `PERFMON_STOP_FILE` | `--stop-file` | — | Flush and exit when this file appears |
| — | `--once` | — | Print one sample as JSON and exit (dry run, nothing is sent) |

Test the setup on a load generator with `node perfmon-collector.mjs --once --role loadgen` while JMeter is running.

**Reliability.** The collector never stops the test. Each probe is optional, and an error is logged before the collector carries on. When Perfmon cannot be reached, samples stay in memory, up to `PERFMON_BUFFER_MAX`. When the buffer is full, the oldest samples are dropped and the log reports how many. Retries back off exponentially, from the interval up to 5 minutes. Rejected requests (HTTP 4xx, for example a wrong API key) are logged and are not retried.

## Where it appears

On the run page, the **Load Generators** tab shows:

- a health chip per load generator: **Healthy**, **Warning** or **Saturated**;
- peak CPU, memory and JMeter heap, the share of samples at or above the warning threshold, and when the threshold was crossed;
- JMeter process CPU and RSS peak, and the maximum heap;
- charts of host CPU, host memory and JMeter heap usage (with the warning and critical thresholds drawn as lines), heap used/committed, JMeter process CPU and RSS, and GC time.

When a load generator is at Warning or Saturated, a banner appears above the tabs on every tab of the run page. The tab label also shows *warning* or *saturated*.

## Thresholds

**Administration → Settings → Load generator thresholds** (setting `loadgen_thresholds`, changes are audited):

| Threshold | Default |
|---|---|
| CPU warning / critical | 75 % / 90 % |
| Memory warning / critical | 80 % / 90 % |
| JMeter heap warning / critical | 85 % / 95 % (of the max heap; of the committed heap when the max is unknown) |
| Minimum share of samples | 10 % |

A metric reaches a level only when **at least the minimum share of its samples** is at or above the threshold. With the defaults, a single spike in a 10-minute test is ignored, but a full minute above the threshold is not.

- **Saturated**: at least one metric reached its critical threshold.
- **Warning**: at least one metric reached its warning threshold.
- **Healthy**: no metric reached a threshold.

## What the warning means

When the analysis runs (after the run completes, and on **Re-analyze**):

- **Saturated** adds the insight **"Load generator saturated — results may be unreliable"** (severity critical). The insight shows evidence for each metric, for example `lg-01: CPU peak 97.2%, at or above 90% (critical) for 34% of 120 samples (12:01:05 → 12:03:40 UTC)`. It also gives recommendations: add load generators or reduce the threads per generator, free memory, or raise the JMeter heap (`HEAP="-Xms2g -Xmx4g"`).
- **Warning** adds the insight *"Load generator under pressure — results may be affected"* (severity warning).
- A **saturated** load generator also adds the dimension **Load Generator: WARNING** to the run result, and puts the reason *"Load generator saturated — results may be unreliable (lg-01)"* first. A run that would have passed becomes **Pass with warnings**. Load generator health never turns a run into **Fail** on its own; Fail still comes only from SLA, error rate, TPS or CPU rules.

The result and the insights use the thresholds that apply when the run is analysed. To apply new thresholds to an older run, use **Re-analyze**. The Load Generators tab always uses the current thresholds.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Tab says *No load generator metrics for this run* | The collector did not run or sent nothing. Check `perfmon-<RUN_ID>/collector.log`. The wrapper prints *load generator monitoring skipped* when Node.js or `perfmon-collector.mjs` is missing. |
| `Perfmon rejected … (HTTP 401/403)` | The API key is wrong or lacks the **ingest** scope. |
| `send failed …; N samples buffered` | Perfmon is unreachable from the load generator. The samples are sent once it is reachable again. |
| Host metrics but no JMeter rows | The JMeter process was not found. Make sure JMeter runs on the same machine, or set `PERFMON_JMETER_PID`. On Windows, PowerShell must be available. |
| No heap chart | `jstat` was not found (install a JDK, not a JRE, or set `JAVA_HOME`), or `PERFMON_JSTAT=false`. On Linux, `jstat` must run as the same user as JMeter. |
| Always *Saturated* because of memory | Some operating systems keep memory in use for caches. If the machine has free memory left, raise the memory thresholds. Otherwise free memory before the test. |
| Network shows nothing on macOS | Network rates are reported only on Linux and Windows. |

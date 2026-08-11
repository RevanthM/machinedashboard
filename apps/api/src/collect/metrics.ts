/**
 * Live telemetry (R-15): CPU, RAM, disk, network, GPU utilisation and temp.
 *
 * Runs every 15s per host over the *pooled* connection (R-06) — this is the
 * hot path that would otherwise open an SSH handshake four times a minute per
 * machine.
 *
 * Each sample must be cheap. Anything that takes a second of wall clock (a
 * `sleep 1` to compute a CPU delta, a full `system_profiler`) is avoided in
 * favour of counters we difference ourselves between polls.
 */
import type { OsFamily } from '../shell/escape.js';
import type { Transport } from '../transport/types.js';
import { num, parseFlat } from './format.js';

export interface Sample {
  cpuPct?: number;
  ramPct?: number;
  diskPct?: number;
  netRxBps?: number;
  netTxBps?: number;
  gpuUtilPct?: number;
  gpuMemUsedMb?: number;
  gpuTempC?: number;
}

/** Counters carried between polls so rates can be differenced. */
interface CounterState {
  ts: number;
  netRxBytes?: number;
  netTxBytes?: number;
  cpuBusy?: number;
  cpuTotal?: number;
}

const previous = new Map<string, CounterState>();

export function resetCounters(hostId: string): void {
  previous.delete(hostId);
}

export async function collectMetrics(
  hostId: string,
  transport: Transport,
): Promise<Sample> {
  const result = await transport.exec(METRIC_SCRIPTS[transport.os], { timeoutMs: 30_000 });
  return parseMetrics(hostId, result.stdout, transport.os);
}

export function parseMetrics(hostId: string, stdout: string, os: OsFamily): Sample {
  const flat = parseFlat(stdout);
  const now = Date.now();
  const prior = previous.get(hostId);

  const ramTotal = num(flat, 'ram.total');
  const ramFree = num(flat, 'ram.free');
  const diskTotal = num(flat, 'disk.total');
  const diskFree = num(flat, 'disk.free');

  const netRxBytes = num(flat, 'net.rx');
  const netTxBytes = num(flat, 'net.tx');
  const cpuBusy = num(flat, 'cpu.busy');
  const cpuTotal = num(flat, 'cpu.total');

  const sample: Sample = {
    ramPct: ratioPct(ramTotal, ramFree),
    diskPct: ratioPct(diskTotal, diskFree),
    gpuUtilPct: num(flat, 'gpu.util'),
    gpuMemUsedMb: num(flat, 'gpu.mem_used'),
    gpuTempC: num(flat, 'gpu.temp'),
  };

  // Windows reports an instantaneous CPU percentage directly; POSIX gives
  // cumulative jiffies, which only mean something as a delta.
  const directCpu = num(flat, 'cpu.pct');
  if (directCpu !== undefined) {
    sample.cpuPct = clampPct(directCpu);
  } else if (
    prior?.cpuBusy !== undefined &&
    prior.cpuTotal !== undefined &&
    cpuBusy !== undefined &&
    cpuTotal !== undefined
  ) {
    const busyDelta = cpuBusy - prior.cpuBusy;
    const totalDelta = cpuTotal - prior.cpuTotal;
    // A reboot resets the counters; a negative delta means we must not report.
    if (totalDelta > 0 && busyDelta >= 0) {
      sample.cpuPct = clampPct((busyDelta / totalDelta) * 100);
    }
  }

  if (prior && netRxBytes !== undefined && netTxBytes !== undefined) {
    const seconds = (now - prior.ts) / 1000;
    if (seconds > 0 && prior.netRxBytes !== undefined && prior.netTxBytes !== undefined) {
      const rx = netRxBytes - prior.netRxBytes;
      const tx = netTxBytes - prior.netTxBytes;
      if (rx >= 0) sample.netRxBps = rx / seconds;
      if (tx >= 0) sample.netTxBps = tx / seconds;
    }
  }

  previous.set(hostId, { ts: now, netRxBytes, netTxBytes, cpuBusy, cpuTotal });
  return sample;
}

function ratioPct(total?: number, free?: number): number | undefined {
  if (total === undefined || free === undefined || total <= 0) return undefined;
  return clampPct(((total - free) / total) * 100);
}

function clampPct(value: number): number {
  return Number(Math.min(100, Math.max(0, value)).toFixed(1));
}

// ---------------------------------------------------------------------------

const WINDOWS_METRICS_TEMPLATE = String.raw`
$os = Get-CimInstance Win32_OperatingSystem
# LoadPercentage is instantaneous and costs nothing; no sampling window needed.
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
"cpu.pct<TAB>$cpu"
"ram.total<TAB>$([int64]$os.TotalVisibleMemorySize * 1024)"
"ram.free<TAB>$([int64]$os.FreePhysicalMemory * 1024)"

$sys = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($env:SystemDrive)'"
if ($sys) {
  "disk.total<TAB>$($sys.Size)"
  "disk.free<TAB>$($sys.FreeSpace)"
}

$net = Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface |
  Where-Object { $_.Name -notmatch 'Loopback|isatap|Teredo' }
"net.rx<TAB>$(($net | Measure-Object -Property BytesReceivedPersec -Sum).Sum)"
"net.tx<TAB>$(($net | Measure-Object -Property BytesSentPersec -Sum).Sum)"

$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($smi) {
  $g = & $smi --query-gpu=utilization.gpu,memory.used,temperature.gpu --format=csv,noheader,nounits 2>$null |
    Select-Object -First 1
  if ($g) {
    $p = $g -split ',\s*'
    "gpu.util<TAB>$($p[0])"
    "gpu.mem_used<TAB>$($p[1])"
    "gpu.temp<TAB>$($p[2])"
  }
}
`;

const WINDOWS_METRICS = WINDOWS_METRICS_TEMPLATE.replaceAll('<TAB>', '\t');

const LINUX_METRICS = String.raw`
awk '/^cpu /{idle=$5+$6; total=0; for(i=2;i<=NF;i++) total+=$i; printf "cpu.busy\t%d\ncpu.total\t%d\n", total-idle, total; exit}' /proc/stat
awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{printf "ram.total\t%d\nram.free\t%d\n", t*1024, a*1024}' /proc/meminfo
df -B1 / 2>/dev/null | awk 'NR==2{printf "disk.total\t%s\ndisk.free\t%s\n", $2, $4}'
awk 'NR>2 && $1 !~ /^lo:/ {gsub(/:/,"",$1); rx+=$2; tx+=$10} END{printf "net.rx\t%d\nnet.tx\t%d\n", rx, tx}' /proc/net/dev
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=utilization.gpu,memory.used,temperature.gpu --format=csv,noheader,nounits 2>/dev/null |
    head -1 | awk -F',' '{gsub(/ /,""); printf "gpu.util\t%s\ngpu.mem_used\t%s\ngpu.temp\t%s\n", $1, $2, $3}'
fi
`;

const MACOS_METRICS = String.raw`
# host_statistics via top, one non-interactive sample.
top -l 1 -n 0 2>/dev/null | awk -F'[ ,%]+' '/^CPU usage/{printf "cpu.busy\t%s\ncpu.total\t100\n", $3+$5}'
printf 'ram.total\t%s\n' "$(sysctl -n hw.memsize)"
printf 'ram.free\t%s\n' "$(vm_stat | awk '/page size of/{ps=$8} /Pages free/{f=$3} /Pages inactive/{i=$3} END{gsub(/\./,"",f); gsub(/\./,"",i); if (ps=="") ps=4096; print (f+i)*ps}')"
df -k / 2>/dev/null | awk 'NR==2{printf "disk.total\t%d\ndisk.free\t%d\n", $2*1024, $4*1024}'
netstat -ib 2>/dev/null | awk '$1 !~ /^lo/ && $3 ~ /Link/ {rx+=$7; tx+=$10} END{printf "net.rx\t%d\nnet.tx\t%d\n", rx, tx}'
`;

export const METRIC_SCRIPTS: Record<OsFamily, string> = {
  windows: WINDOWS_METRICS,
  ubuntu: LINUX_METRICS,
  debian: LINUX_METRICS,
  macos: MACOS_METRICS,
};

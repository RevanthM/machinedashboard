/**
 * Static spec collection (R-14): OS, CPU, GPU, RAM, storage.
 *
 * GPU detection drives the inference-backend badge (R-20), which is the single
 * most useful comparison on the dashboard — a CPU-only host at ~8 tok/s next to
 * a Metal host at ~95 tok/s. So each OS probes for a real accelerator and falls
 * back to the generic display adapter only when there isn't one.
 */
import type { GpuInfo, StorageMount } from '../db/schema.js';
import type { OsFamily } from '../shell/escape.js';
import type { Transport } from '../transport/types.js';
import { group, num, parseFlat, str } from './format.js';

export interface CollectedSpecs {
  cpuModel?: string;
  cpuCores?: number;
  cpuThreads?: number;
  cpuMhz?: number;
  ramTotalGb?: number;
  ramFreeGb?: number;
  gpu: GpuInfo[];
  storage: StorageMount[];
  osKernel?: string;
  uptimeS?: number;
}

export async function collectSpecs(transport: Transport): Promise<CollectedSpecs> {
  const script = SPEC_SCRIPTS[transport.os];
  const result = await transport.exec(script, { timeoutMs: 60_000 });
  return parseSpecs(result.stdout, transport.os);
}

export function parseSpecs(stdout: string, os: OsFamily): CollectedSpecs {
  const flat = parseFlat(stdout);

  const gpu: GpuInfo[] = group(flat, 'gpu').map((g) => {
    const model = g.get('model') ?? 'unknown';
    const vramRaw = g.get('vram_mb');
    const vramMb = vramRaw ? Number(vramRaw) : undefined;
    return {
      model,
      vramMb: Number.isFinite(vramMb) ? vramMb : undefined,
      driver: g.get('driver') || undefined,
      cuda: g.get('cuda') || undefined,
      backend: inferBackend(model, os, g.get('driver')),
    };
  });

  const storage: StorageMount[] = group(flat, 'storage')
    .map((s) => ({
      mount: s.get('mount') ?? '?',
      fs: s.get('fs') || undefined,
      totalBytes: Number(s.get('total') ?? 0),
      freeBytes: Number(s.get('free') ?? 0),
    }))
    .filter((s) => Number.isFinite(s.totalBytes) && s.totalBytes > 0);

  return {
    cpuModel: str(flat, 'cpu.model'),
    cpuCores: num(flat, 'cpu.cores'),
    cpuThreads: num(flat, 'cpu.threads'),
    cpuMhz: num(flat, 'cpu.mhz'),
    ramTotalGb: bytesToGb(num(flat, 'ram.total')),
    ramFreeGb: bytesToGb(num(flat, 'ram.free')),
    gpu,
    storage,
    osKernel: str(flat, 'os.kernel'),
    uptimeS: num(flat, 'os.uptime_s'),
  };
}

/**
 * Which Ollama backend this GPU implies (R-20).
 *
 * Apple Silicon always means Metal. NVIDIA means CUDA only when a driver is
 * present — a card with no driver loaded runs on CPU, and reporting `cuda`
 * would make a 5 tok/s result look like a broken GPU rather than a missing
 * driver.
 */
export function inferBackend(
  model: string,
  os: OsFamily,
  driver?: string,
): GpuInfo['backend'] {
  const m = model.toLowerCase();
  if (os === 'macos' && (m.includes('apple') || m.includes('m1') || m.includes('m2') || m.includes('m3') || m.includes('m4'))) {
    return 'metal';
  }
  if (m.includes('nvidia') || m.includes('geforce') || m.includes('rtx') || m.includes('quadro') || m.includes('tesla')) {
    return driver ? 'cuda' : 'cpu';
  }
  if (m.includes('radeon') || m.includes('amd')) return 'rocm';
  return 'cpu';
}

function bytesToGb(bytes?: number): number | undefined {
  return bytes === undefined ? undefined : Number((bytes / 1024 ** 3).toFixed(2));
}

// ---------------------------------------------------------------------------
// Per-OS collectors
// ---------------------------------------------------------------------------

/**
 * PowerShell has no printf and does not interpret `\t` inside double quotes —
 * its escape character is a backtick. Rather than fight two escaping schemes at
 * once, `<TAB>` is a placeholder substituted for a real tab below, so the
 * script text stays readable and there is exactly one place tabs come from.
 */
const WINDOWS_SPECS_TEMPLATE = String.raw`
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$os  = Get-CimInstance Win32_OperatingSystem
"cpu.model<TAB>$($cpu.Name.Trim())"
"cpu.cores<TAB>$($cpu.NumberOfCores)"
"cpu.threads<TAB>$($cpu.NumberOfLogicalProcessors)"
"cpu.mhz<TAB>$($cpu.MaxClockSpeed)"
"ram.total<TAB>$([int64]$os.TotalVisibleMemorySize * 1024)"
"ram.free<TAB>$([int64]$os.FreePhysicalMemory * 1024)"
"os.kernel<TAB>$($os.Version)"
"os.uptime_s<TAB>$([int]((Get-Date) - $os.LastBootUpTime).TotalSeconds)"

# Prefer nvidia-smi: it reports real VRAM and proves the driver is loaded,
# which Win32_VideoController cannot tell us.
$i = 0
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($smi) {
  & $smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits 2>$null | ForEach-Object {
    $p = $_ -split ',\s*'
    "gpu.$i.model<TAB>$($p[0])"
    "gpu.$i.vram_mb<TAB>$($p[1])"
    "gpu.$i.driver<TAB>$($p[2])"
    $i++
  }
}
if ($i -eq 0) {
  Get-CimInstance Win32_VideoController | ForEach-Object {
    "gpu.$i.model<TAB>$($_.Name)"
    # AdapterRAM is a uint32 and wraps above 4 GB, so it is reported only when
    # plausible rather than emitting a nonsense VRAM figure.
    if ($_.AdapterRAM -gt 0) { "gpu.$i.vram_mb<TAB>$([int]($_.AdapterRAM / 1MB))" }
    $i++
  }
}

$j = 0
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
  "storage.$j.mount<TAB>$($_.DeviceID)"
  "storage.$j.fs<TAB>$($_.FileSystem)"
  "storage.$j.total<TAB>$($_.Size)"
  "storage.$j.free<TAB>$($_.FreeSpace)"
  $j++
}
`;

const WINDOWS_SPECS = WINDOWS_SPECS_TEMPLATE.replaceAll('<TAB>', '\t');

const LINUX_SPECS = String.raw`
printf 'cpu.model\t%s\n' "$(awk -F': ' '/model name/{print $2; exit}' /proc/cpuinfo)"
printf 'cpu.cores\t%s\n' "$(lscpu 2>/dev/null | awk -F': +' '/^Core\(s\) per socket/{c=$2} /^Socket\(s\)/{s=$2} END{if (c && s) print c*s; else print ""}')"
printf 'cpu.threads\t%s\n' "$(nproc 2>/dev/null)"
printf 'cpu.mhz\t%s\n' "$(lscpu 2>/dev/null | awk -F': +' '/^CPU max MHz/{print int($2); exit}')"
printf 'ram.total\t%s\n' "$(awk '/MemTotal/{print $2*1024; exit}' /proc/meminfo)"
printf 'ram.free\t%s\n' "$(awk '/MemAvailable/{print $2*1024; exit}' /proc/meminfo)"
printf 'os.kernel\t%s\n' "$(uname -r)"
printf 'os.uptime_s\t%s\n' "$(awk '{print int($1); exit}' /proc/uptime)"

i=0
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits 2>/dev/null | while IFS=, read -r name mem drv; do
    printf 'gpu.%s.model\t%s\n' "$i" "$(echo "$name" | sed 's/^ *//')"
    printf 'gpu.%s.vram_mb\t%s\n' "$i" "$(echo "$mem" | tr -d ' ')"
    printf 'gpu.%s.driver\t%s\n' "$i" "$(echo "$drv" | tr -d ' ')"
    i=$((i+1))
  done
elif command -v lspci >/dev/null 2>&1; then
  lspci 2>/dev/null | grep -i 'vga\|3d controller' | head -4 | while read -r line; do
    printf 'gpu.%s.model\t%s\n' "$i" "$(echo "$line" | cut -d: -f3- | sed 's/^ *//')"
    i=$((i+1))
  done
fi

# Pseudo-filesystems are excluded by type rather than by size: efivarfs and
# friends report a non-zero but meaningless capacity, so a size threshold alone
# would still let them through and clutter the storage list.
df -B1 -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs -x devfs \
     -x fuse.snapfuse -x ramfs 2>/dev/null | tail -n +2 | awk '
  {
    mount = ""
    for (i = 6; i <= NF; i++) mount = mount (i > 6 ? " " : "") $i
    if (mount == "") next
    if (mount ~ /^\/(proc|sys|run|dev)(\/|$)/) next
    if (mount ~ /^\/snap\//) next
    printf "storage.%d.mount\t%s\n", j, mount
    printf "storage.%d.fs\t%s\n", j, $1
    printf "storage.%d.total\t%s\n", j, $2
    printf "storage.%d.free\t%s\n", j, $4
    j++
  }
'
`;

const MACOS_SPECS = String.raw`
printf 'cpu.model\t%s\n' "$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
printf 'cpu.cores\t%s\n' "$(sysctl -n hw.physicalcpu 2>/dev/null)"
printf 'cpu.threads\t%s\n' "$(sysctl -n hw.logicalcpu 2>/dev/null)"
printf 'ram.total\t%s\n' "$(sysctl -n hw.memsize 2>/dev/null)"
# vm_stat reports pages; free = free + inactive, which is what is actually reusable.
printf 'ram.free\t%s\n' "$(vm_stat 2>/dev/null | awk '/page size of/{ps=$8} /Pages free/{f=$3} /Pages inactive/{i=$3} END{gsub(/\./,"",f); gsub(/\./,"",i); if (ps=="") ps=4096; print (f+i)*ps}')"
printf 'os.kernel\t%s\n' "$(uname -r)"
printf 'os.uptime_s\t%s\n' "$(( $(date +%s) - $(sysctl -n kern.boottime 2>/dev/null | sed -n 's/.*sec = \([0-9]*\).*/\1/p') ))"

# Apple Silicon: the GPU is part of the SoC, so the chip name is the GPU name
# and its core count comes from system_profiler.
CHIP="$(system_profiler SPDisplaysDataType 2>/dev/null | awk -F': ' '/Chipset Model/{print $2; exit}')"
if [ -n "$CHIP" ]; then
  printf 'gpu.0.model\t%s\n' "$CHIP"
  printf 'gpu.0.driver\tmetal\n'
fi

# macOS "df -k" has three columns Linux does not (iused, ifree, %iused) before
# "Mounted on", so positional parsing tuned for Linux lands on the wrong field.
# The mount point is $9 onward — "onward" because it can contain spaces.
# (No backticks in these comments: this whole script lives in a JS template
# literal, and a stray backtick terminates it.)
#
# The filter matters as much as the parse: a Mac with Xcode reports ~50 firmlink
# and simulator volumes, all of which report the same underlying capacity. They
# would swamp the storage list and triple-count the same disk. Only real volumes
# are kept.
df -k 2>/dev/null | tail -n +2 | awk '
  $1 ~ /^\/dev\// {
    mount = ""
    for (i = 9; i <= NF; i++) mount = mount (i > 9 ? " " : "") $i
    if (mount == "") next
    if (mount ~ /^\/System\/Volumes\/(VM|Preboot|Update|xarts|iSCPreboot|Hardware)/) next
    if (mount ~ /^\/Library\/Developer\/CoreSimulator/) next
    if (mount ~ /^\/System\/Volumes\/Update/) next
    printf "storage.%d.mount\t%s\n", j, mount
    printf "storage.%d.fs\t%s\n", j, $1
    printf "storage.%d.total\t%.0f\n", j, $2 * 1024
    printf "storage.%d.free\t%.0f\n", j, $4 * 1024
    j++
  }
'
`;

export const SPEC_SCRIPTS: Record<OsFamily, string> = {
  windows: WINDOWS_SPECS,
  ubuntu: LINUX_SPECS,
  debian: LINUX_SPECS,
  macos: MACOS_SPECS,
};

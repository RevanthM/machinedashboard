/**
 * Runs the spec and metric collectors against the local machine.
 *
 * Collector scripts are the most OS-sensitive code in the project — every one
 * is a different tool with a different output format. Run this on each OS
 * family you manage before trusting the dashboard's numbers.
 *
 *   npx tsx scripts/verify-collect-local.ts
 */
import { collectMetrics } from '../src/collect/metrics.js';
import { collectSpecs } from '../src/collect/specs.js';
import { LocalTransport, detectLocalOs } from '../src/transport/local.js';

const os = detectLocalOs();
const transport = new LocalTransport(os);
console.log(`Collecting from local machine as os=${os}\n`);

const specs = await collectSpecs(transport);

console.log('--- SPECS ---');
console.log(`cpu       : ${specs.cpuModel ?? '?'}`);
console.log(`cores     : ${specs.cpuCores ?? '?'} physical / ${specs.cpuThreads ?? '?'} logical @ ${specs.cpuMhz ?? '?'} MHz`);
console.log(`ram       : ${specs.ramFreeGb ?? '?'} GB free of ${specs.ramTotalGb ?? '?'} GB`);
console.log(`kernel    : ${specs.osKernel ?? '?'}`);
console.log(`uptime    : ${specs.uptimeS ? `${(specs.uptimeS / 3600).toFixed(1)} h` : '?'}`);

console.log(`gpu       : ${specs.gpu.length} found`);
for (const g of specs.gpu) {
  console.log(
    `  - ${g.model}` +
      `${g.vramMb ? ` ${(g.vramMb / 1024).toFixed(1)} GB` : ''}` +
      `${g.driver ? ` driver=${g.driver}` : ''}` +
      `  backend=${g.backend}`,
  );
}

console.log(`storage   : ${specs.storage.length} mount(s)`);
for (const s of specs.storage) {
  const totalGb = s.totalBytes / 1024 ** 3;
  const freeGb = s.freeBytes / 1024 ** 3;
  console.log(
    `  - ${s.mount.padEnd(8)} ${freeGb.toFixed(1).padStart(8)} GB free of ${totalGb.toFixed(1).padStart(8)} GB  ${s.fs ?? ''}`,
  );
}

// Two samples: rate-based fields (CPU on POSIX, network everywhere) need a
// delta, so the first poll after startup legitimately has no value for them.
console.log('\n--- METRICS (sample 1, priming counters) ---');
console.log(await collectMetrics('verify-local', transport));

await new Promise((r) => setTimeout(r, 2000));

console.log('\n--- METRICS (sample 2, deltas available) ---');
const second = await collectMetrics('verify-local', transport);
console.log(`cpu       : ${fmtPct(second.cpuPct)}`);
console.log(`ram       : ${fmtPct(second.ramPct)}`);
console.log(`disk      : ${fmtPct(second.diskPct)}`);
console.log(`net rx/tx : ${fmtBps(second.netRxBps)} / ${fmtBps(second.netTxBps)}`);
console.log(
  `gpu       : util=${fmtPct(second.gpuUtilPct)} mem=${second.gpuMemUsedMb ?? '?'} MB temp=${second.gpuTempC ?? '?'} C`,
);

const missing: string[] = [];
if (!specs.cpuModel) missing.push('cpu.model');
if (!specs.ramTotalGb) missing.push('ram.total');
if (specs.storage.length === 0) missing.push('storage');
if (second.cpuPct === undefined) missing.push('cpu.pct');
if (second.ramPct === undefined) missing.push('ram.pct');

console.log(
  missing.length === 0
    ? '\nAll core fields collected.'
    : `\nMISSING FIELDS: ${missing.join(', ')}`,
);
process.exit(missing.length === 0 ? 0 : 1);

function fmtPct(v?: number): string {
  return v === undefined ? '?' : `${v.toFixed(1)}%`;
}
function fmtBps(v?: number): string {
  if (v === undefined) return '?';
  if (v > 1024 * 1024) return `${(v / 1024 / 1024).toFixed(2)} MB/s`;
  return `${(v / 1024).toFixed(1)} KB/s`;
}

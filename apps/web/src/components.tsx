import { useEffect, useState, type ReactNode } from 'react';
import { Circle } from 'lucide-react';
import type { Host } from './api.js';

export function Panel({
  children,
  title,
  icon,
  tone,
  actions,
  className = '',
}: {
  children: ReactNode;
  title?: ReactNode;
  icon?: ReactNode;
  tone?: 'ok' | 'warn' | 'bad';
  actions?: ReactNode;
  className?: string;
}) {
  const border =
    tone === 'warn'
      ? 'border-[var(--color-warn)]/50'
      : tone === 'ok'
        ? 'border-[var(--color-ok)]/50'
        : tone === 'bad'
          ? 'border-[var(--color-bad)]/50'
          : 'border-[var(--color-edge)]';
  const titleTone =
    tone === 'warn'
      ? 'text-[var(--color-warn)]'
      : tone === 'ok'
        ? 'text-[var(--color-ok)]'
        : tone === 'bad'
          ? 'text-[var(--color-bad)]'
          : 'text-[var(--color-ink)]';

  return (
    <section className={`rounded-lg border ${border} bg-[var(--color-panel)] p-4 ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && (
            <h2 className={`flex items-center gap-2 font-medium ${titleTone}`}>
              {icon}
              {title}
            </h2>
          )}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  tone = 'default',
  size = 'md',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: 'default' | 'primary' | 'danger';
  size?: 'sm' | 'md';
  title?: string;
}) {
  const tones = {
    default: 'border-[var(--color-edge)] hover:border-[var(--color-muted)] text-[var(--color-ink)]',
    primary: 'border-[var(--color-accent)]/60 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10',
    danger: 'border-[var(--color-bad)]/60 text-[var(--color-bad)] hover:bg-[var(--color-bad)]/10',
  };
  const sizeClass = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm';
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded border bg-transparent ${tones[tone]} ${sizeClass} transition-colors disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

/**
 * Status is never conveyed by colour alone (N-13): every pip carries a label,
 * and the shape differs between states — a filled dot for healthy, a hollow one
 * for unknown, so the three are distinguishable in greyscale too.
 */
export function Pip({
  label,
  state,
  detail,
}: {
  label: string;
  state: 'ok' | 'bad' | 'unknown' | 'warn';
  detail?: string;
}) {
  const tone = {
    ok: 'text-[var(--color-ok)]',
    bad: 'text-[var(--color-bad)]',
    warn: 'text-[var(--color-warn)]',
    unknown: 'text-[var(--color-muted)]',
  }[state];

  return (
    <span className={`mono flex items-center gap-1 text-[11px] ${tone}`} title={detail ?? label}>
      <Circle size={7} fill={state === 'unknown' ? 'none' : 'currentColor'} strokeWidth={2} />
      {label}
    </span>
  );
}

/** R-17: three independent pips — SSH, mesh, Ollama. */
export function HostPips({ host }: { host: Host }) {
  const ssh: 'ok' | 'bad' | 'unknown' =
    host.status === 'online' ? 'ok' : host.status === 'unknown' ? 'unknown' : 'bad';

  const mesh: 'ok' | 'bad' | 'unknown' =
    host.meshStatus === 'connected' ? 'ok' : host.meshStatus === 'unknown' ? 'unknown' : 'bad';

  const llm: 'ok' | 'bad' | 'unknown' | 'warn' = !host.enableOllama
    ? 'unknown'
    : host.provisionState === 'llm_unsupported'
      ? 'bad'
      : host.llm?.hostOllamaUp
        ? 'ok'
        : host.llm?.operatorOllamaUp
          ? 'warn'
          : host.llm
            ? 'bad'
            : 'unknown';

  return (
    <div className="flex items-center gap-3">
      <Pip label="ssh" state={ssh} detail={sshPipTitle(host)} />
      <Pip label="mesh" state={mesh} detail={meshPipTitle(host)} />
      <Pip label="llm" state={llm} detail={llmPipTitle(host)} />
    </div>
  );
}

/** On-demand SSH reachability check for one host. */
export const PROBE_HINT =
  'SSH reachability check on this host: resolve address → TCP port 22 → login → shell echo. Updates online / unreachable / auth failed. Does not benchmark, collect specs, or ping Ollama.';

/** Same check, every inventory host in parallel. */
export const PROBE_ALL_HINT =
  'SSH reachability check on every host now: resolve address → TCP port 22 → login → shell echo. Sets each host online or unreachable. Does not benchmark, collect hardware specs, or start Ollama. The 15s list refresh only re-reads stored SSH status and pings Ollama.';

export const STATUS_FRESHNESS_HINT =
  'Online/unreachable is the last SSH probe or telemetry poll — not a live stream. "list" is when this page last fetched. Probe all runs a fresh SSH check. Telemetry also updates last-checked about every 15s when a host answers.';

export function sshPipTitle(host: Host): string {
  const checked = host.lastCheckedAt
    ? `Last check ${relativeTime(host.lastCheckedAt)} (${absoluteTime(host.lastCheckedAt)}).`
    : 'Never probed. Press Probe all (or Probe on the host page).';
  const lastUp =
    host.lastSeenAt && host.lastSeenAt !== host.lastCheckedAt
      ? ` Last successful contact ${relativeTime(host.lastSeenAt)} (${absoluteTime(host.lastSeenAt)}).`
      : '';
  const err = host.lastError ? ` ${host.lastError}` : '';
  return `SSH ${host.status}. ${checked}${lastUp} Green means the last check reached a shell. Probe all does this check; it is not live.${err}`;
}

export function meshPipTitle(host: Host): string {
  const seen = host.meshLastSeenAt
    ? ` Control plane last saw it ${relativeTime(host.meshLastSeenAt)} (${absoluteTime(host.meshLastSeenAt)}).`
    : '';
  return `Mesh (${host.meshProvider}): ${host.meshStatus}.${seen} This is the overlay control plane, independent of SSH. Probe all does not change mesh. Hollow means the control plane has not reported this peer.`;
}

export function llmPipTitle(host: Host): string {
  if (!host.enableOllama) return 'Ollama disabled for this host.';
  if (host.provisionState === 'llm_unsupported') {
    return 'This host does not have enough RAM for the configured model.';
  }
  if (host.llm?.hostOllamaUp) {
    return `Ollama is up on this host (${host.llm.hostOllamaUrl ?? 'local'}). Checked over HTTP on the last list fetch, not by Probe all.`;
  }
  if (host.llm?.operatorOllamaUp) {
    return "This host's Ollama is down. Chat falls back to the operator laptop. Probe all does not ping Ollama — the list fetch does.";
  }
  if (host.llm) {
    return 'Ollama is not reachable on this host or the operator. Probe all does not ping Ollama.';
  }
  return 'Ollama status unknown.';
}

export function checkedLineTitle(host: Host): string {
  return [
    host.lastCheckedAt
      ? `Last SSH probe or telemetry attempt: ${absoluteTime(host.lastCheckedAt)}.`
      : 'No SSH check recorded yet. Press Probe all.',
    host.lastSeenAt
      ? `Last successful SSH contact: ${absoluteTime(host.lastSeenAt)}.`
      : 'Never reached a shell.',
    'A failed check updates "checked" but not "last up".',
  ].join(' ');
}

export function benchTitle(host: Host): string {
  const b = host.latestBenchmark;
  if (!b) {
    return 'No benchmark yet. This is not live tok/s. Re-bench from the host Overview tab. Probe all does not benchmark.';
  }
  return `Last Ollama benchmark of ${b.model}: ${fmtTps(b.evalTps)} eval tok/s at ${absoluteTime(b.ts)}. Historical, not live inference speed. Probe all does not re-bench.`;
}

export function BackendBadge({ backend }: { backend?: string | null }) {
  if (!backend) return null;
  const tone =
    backend === 'cuda'
      ? 'border-[var(--color-ok)]/50 text-[var(--color-ok)]'
      : backend === 'metal'
        ? 'border-[var(--color-accent)]/50 text-[var(--color-accent)]'
        : backend === 'rocm'
          ? 'border-[var(--color-warn)]/50 text-[var(--color-warn)]'
          : 'border-[var(--color-muted)]/50 text-[var(--color-muted)]';
  return (
    <span
      className={`mono rounded border px-1.5 py-0.5 text-[10px] uppercase ${tone}`}
      title={
        backend === 'cuda'
          ? 'Last benchmark ran on NVIDIA CUDA'
          : backend === 'metal'
            ? 'Last benchmark ran on Apple Metal'
            : backend === 'rocm'
              ? 'Last benchmark ran on AMD ROCm'
              : 'Last benchmark ran on CPU (no accelerator used)'
      }
    >
      {backend}
    </span>
  );
}

export function Skeleton({ label }: { label: string }) {
  return (
    <Panel>
      <div className="animate-pulse text-sm text-[var(--color-muted)]">{label}</div>
    </Panel>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  return (
    <Panel tone="bad">
      <p className="text-sm text-[var(--color-bad)]">
        {error instanceof Error ? error.message : String(error)}
      </p>
    </Panel>
  );
}

export function fmtBytes(bytes?: number): string {
  if (bytes === undefined) return '—';
  const gb = bytes / 1024 ** 3;
  return gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb.toFixed(0)} GB`;
}

export function fmtPct(value?: number | null): string {
  return value === undefined || value === null ? '—' : `${value.toFixed(0)}%`;
}

export function fmtTps(value?: number | null): string {
  return value === undefined || value === null ? '—' : value.toFixed(1);
}

/** Re-render on an interval so relative timestamps stay honest. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function relativeTime(unixSec?: number | null, nowMs = Date.now()): string {
  if (!unixSec) return 'never';
  const delta = nowMs / 1000 - unixSec;
  if (delta < 10) return 'just now';
  if (delta < 60) return `${Math.floor(delta)}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

export function absoluteTime(unixSec?: number | null): string {
  if (!unixSec) return 'never';
  return new Date(unixSec * 1000).toLocaleString();
}

import type { ReactNode } from 'react';
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
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded border bg-transparent ${tones[tone]} ${
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm'
      } transition-colors disabled:cursor-not-allowed disabled:opacity-40`}
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

  // Ollama health is inferred from a recent benchmark; a host that has never
  // been benchmarked is unknown rather than broken.
  const benchAge = host.latestBenchmark
    ? Date.now() / 1000 - host.latestBenchmark.ts
    : Number.POSITIVE_INFINITY;
  const llm: 'ok' | 'bad' | 'unknown' | 'warn' = !host.enableOllama
    ? 'unknown'
    : host.provisionState === 'llm_unsupported'
      ? 'bad'
      : benchAge < 24 * 3600
        ? 'ok'
        : host.latestBenchmark
          ? 'warn'
          : 'unknown';

  return (
    <div className="flex items-center gap-3">
      <Pip label="ssh" state={ssh} detail={host.lastError ?? `SSH: ${host.status}`} />
      <Pip label="mesh" state={mesh} detail={`${host.meshProvider}: ${host.meshStatus}`} />
      <Pip
        label="llm"
        state={llm}
        detail={
          !host.enableOllama
            ? 'Ollama disabled for this host'
            : host.provisionState === 'llm_unsupported'
              ? 'Insufficient RAM for the model'
              : host.latestBenchmark
                ? `Last benchmark ${new Date(host.latestBenchmark.ts * 1000).toLocaleString()}`
                : 'Never benchmarked'
        }
      />
    </div>
  );
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
    <span className={`mono rounded border px-1.5 py-0.5 text-[10px] uppercase ${tone}`}>
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

export function relativeTime(unixSec?: number | null): string {
  if (!unixSec) return 'never';
  const delta = Date.now() / 1000 - unixSec;
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

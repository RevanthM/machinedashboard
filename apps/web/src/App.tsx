import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Factory,
  LayoutGrid,
  Monitor,
  Pencil,
  Rows3,
  ScrollText,
  Server,
  Terminal as TerminalIcon,
  Trophy,
  Wifi,
  WifiOff,
  MessageSquare,
} from 'lucide-react';
import {
  api,
  hostLabel,
  type Host,
  type HostLlmInfo,
  type LeaderboardEntry,
  type MigrationState,
  type ProvisionReport,
} from './api.js';
import {
  BackendBadge,
  Button,
  ErrorNote,
  HostPips,
  Panel,
  Skeleton,
  fmtBytes,
  fmtPct,
  fmtTps,
  relativeTime,
  useNow,
  PROBE_ALL_HINT,
  PROBE_HINT,
  STATUS_FRESHNESS_HINT,
  benchTitle,
  checkedLineTitle,
} from './components.jsx';
import { TerminalPane } from './Terminal.jsx';
import { RemoteDesktop } from './RemoteDesktop.jsx';
import { HostChat } from './Chat.jsx';
import { FactoryView } from './Factory.jsx';
import { ToastStack, useFleetToasts } from './Toasts.jsx';

type HostTab = 'overview' | 'terminal' | 'desktop' | 'chat' | 'provision';

type Route =
  | { name: 'fleet' }
  | { name: 'factory' }
  | { name: 'leaderboard' }
  | { name: 'audit' }
  | { name: 'host'; id: string; tab: HostTab };

function parseHash(): Route {
  const hash = location.hash.replace(/^#\/?/, '');
  const [head, id, tab] = hash.split('/');
  if (head === 'hosts' && id) {
    return { name: 'host', id, tab: (tab as HostTab) ?? 'overview' };
  }
  if (head === 'factory') return { name: 'factory' };
  if (head === 'leaderboard') return { name: 'leaderboard' };
  if (head === 'audit') return { name: 'audit' };
  return { name: 'fleet' };
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const { toasts, dismiss } = useFleetToasts();
  const now = useNow(15_000);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  const hostsQuery = useQuery({
    queryKey: ['hosts'],
    queryFn: api.hosts,
    refetchInterval: 15_000,
  });
  const freshness = fleetFreshness(hostsQuery.data?.hosts ?? [], hostsQuery.dataUpdatedAt, now);

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 border-b border-[var(--color-edge)] bg-[var(--color-surface)]/95 px-6 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-6">
          <a href="#/" className="text-base font-semibold tracking-tight">
            Fleet Console
          </a>
          <nav className="flex items-center gap-1 text-sm">
            <NavLink href="#/" active={route.name === 'fleet'} icon={<Server size={14} />}>
              Fleet
            </NavLink>
            <NavLink
              href="#/factory"
              active={route.name === 'factory'}
              icon={<Factory size={14} />}
            >
              Factory
            </NavLink>
            <NavLink
              href="#/leaderboard"
              active={route.name === 'leaderboard'}
              icon={<Trophy size={14} />}
            >
              Leaderboard
            </NavLink>
            <NavLink href="#/audit" active={route.name === 'audit'} icon={<ScrollText size={14} />}>
              Audit
            </NavLink>
          </nav>
          <span className="mono ml-auto text-right text-xs text-[var(--color-muted)]" title={STATUS_FRESHNESS_HINT}>
            localhost · {hostsQuery.data?.hosts.length ?? 0} hosts
            {hostsQuery.data
              ? ` · ${hostsQuery.data.hosts.filter((h) => h.status === 'online').length} online`
              : ''}
            {freshness ? (
              <>
                <br />
                <span title={STATUS_FRESHNESS_HINT}>{freshness}</span>
              </>
            ) : null}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-5 px-6 py-6">
        {route.name === 'fleet' && <FleetView />}
        {route.name === 'factory' && <FactoryPage hosts={hostsQuery.data?.hosts ?? []} />}
        {route.name === 'leaderboard' && <LeaderboardView />}
        {route.name === 'audit' && <AuditView />}
        {route.name === 'host' && <HostView id={route.id} tab={route.tab} />}
      </main>

      <ToastStack toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

function fleetFreshness(
  hosts: Host[],
  dataUpdatedAt: number | undefined,
  nowMs: number,
): string | null {
  if (hosts.length === 0) return null;
  const checked = hosts
    .map((h) => h.lastCheckedAt ?? h.lastSeenAt)
    .filter((t): t is number => Boolean(t));
  const never = hosts.length - checked.length;
  const oldest = checked.length > 0 ? Math.min(...checked) : null;
  const snapshot = dataUpdatedAt ? `list ${relativeTime(dataUpdatedAt / 1000, nowMs)}` : null;
  const ssh =
    never === hosts.length
      ? 'SSH never checked'
      : never > 0
        ? `SSH ${relativeTime(oldest, nowMs)} · ${never} never`
        : `SSH ${relativeTime(oldest, nowMs)}`;
  return snapshot ? `${ssh} · ${snapshot}` : ssh;
}

function FactoryPage({ hosts }: { hosts: Host[] }) {
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Factory</h1>
          <p className="text-sm text-[var(--color-muted)]">
            Fleet chat, parallel jobs, and light schedules — single operator on localhost.
          </p>
        </div>
        <FactoryStatusStrip hosts={hosts} />
      </div>
      <FactoryView hosts={hosts} />
    </>
  );
}

function FactoryStatusStrip({ hosts }: { hosts: Host[] }) {
  const migration = useQuery({ queryKey: ['migration'], queryFn: api.migration });
  const stranded = migration.data?.stranded ?? [];
  const bad = hosts.filter((h) => h.status === 'unreachable' || h.status === 'auth_failed');
  if (stranded.length === 0 && bad.length === 0) return null;
  return (
    <div className="max-w-md rounded border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 px-3 py-2 text-xs">
      {stranded.length > 0 && (
        <p>
          Mesh-stranded (Tailscale only):{' '}
          {stranded.map((p) => p.hostname).join(', ')}. NetBird enroll still needs sudo on those
          hosts.
        </p>
      )}
      {bad.length > 0 && (
        <p className={stranded.length ? 'mt-1' : ''}>
          Unreachable / auth failed: {bad.map((h) => hostLabel(h)).join(', ')}
        </p>
      )}
    </div>
  );
}

function NicknameEdit({ host, compact }: { host: Host; compact?: boolean }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(host.nickname ?? '');

  useEffect(() => {
    setValue(host.nickname ?? '');
  }, [host.nickname]);

  const save = useMutation({
    mutationFn: () => api.patchHost(host.id, { nickname: value.trim() || null }),
    onSuccess: async () => {
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ['hosts'] });
      await queryClient.invalidateQueries({ queryKey: ['host', host.id] });
    },
  });

  if (!editing) {
    return (
      <button
        type="button"
        title="Edit nickname"
        className="rounded p-0.5 text-[var(--color-muted)] hover:text-[var(--color-ink)]"
        onClick={() => setEditing(true)}
      >
        <Pencil size={compact ? 11 : 14} />
      </button>
    );
  }

  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setEditing(false);
            setValue(host.nickname ?? '');
          }
        }}
        placeholder="Nickname"
        className="w-36 rounded border border-[var(--color-edge)] bg-[var(--color-panel)] px-1.5 py-0.5 text-xs"
      />
      <Button size="sm" tone="primary" disabled={save.isPending} onClick={() => save.mutate()}>
        Save
      </Button>
      <Button
        size="sm"
        onClick={() => {
          setEditing(false);
          setValue(host.nickname ?? '');
        }}
      >
        Cancel
      </Button>
    </form>
  );
}

function NavLink({
  href,
  active,
  icon,
  children,
}: {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className={`flex items-center gap-1.5 rounded px-2.5 py-1 transition-colors ${
        active
          ? 'bg-[var(--color-panel)] text-[var(--color-ink)]'
          : 'text-[var(--color-muted)] hover:text-[var(--color-ink)]'
      }`}
    >
      {icon}
      {children}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

function FleetView() {
  const queryClient = useQueryClient();
  const now = useNow(15_000);
  const hostsQuery = useQuery({
    queryKey: ['hosts'],
    queryFn: api.hosts,
    refetchInterval: 15_000,
  });
  const migration = useQuery({ queryKey: ['migration'], queryFn: api.migration });

  const [view, setView] = useState<'grid' | 'table'>('grid');
  const [osFilter, setOsFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  const probeAll = useMutation({
    mutationFn: api.probeAll,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['hosts'] }),
  });

  const hosts = hostsQuery.data?.hosts ?? [];

  const allTags = useMemo(
    () => [...new Set(hosts.flatMap((h) => h.tags ?? []))].sort(),
    [hosts],
  );

  const filtered = useMemo(
    () =>
      hosts.filter((h) => {
        if (osFilter !== 'all' && h.os !== osFilter) return false;
        if (statusFilter !== 'all' && h.status !== statusFilter) return false;
        if (tagFilter !== 'all' && !(h.tags ?? []).includes(tagFilter)) return false;
        if (search.trim()) {
          const q = search.trim().toLowerCase();
          const hay = [h.name, h.nickname, h.hostname, h.host, ...(h.tags ?? [])]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      }),
    [hosts, osFilter, statusFilter, tagFilter, search],
  );

  return (
    <>
      <MigrationPanel state={migration.data} loading={migration.isLoading} />

      <div className="flex flex-wrap items-center gap-2">
        <a href="#/factory">
          <Button size="sm" tone="primary" title="Chat across the whole fleet from one thread. Not a status probe.">
            <Factory size={13} className="inline" /> Factory Chat
          </Button>
        </a>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name / nickname…"
          className="rounded border border-[var(--color-edge)] bg-[var(--color-panel)] px-2 py-1 text-xs"
        />
        <Select value={osFilter} onChange={setOsFilter} label="os">
          <option value="all">all</option>
          {[...new Set(hosts.map((h) => h.os).filter(Boolean))].map((os) => (
            <option key={os!} value={os!}>
              {os}
            </option>
          ))}
        </Select>
        <Select value={statusFilter} onChange={setStatusFilter} label="status">
          <option value="all">all</option>
          <option value="online">online</option>
          <option value="unreachable">unreachable</option>
          <option value="auth_failed">auth failed</option>
          <option value="unknown">unknown</option>
        </Select>
        {allTags.length > 0 && (
          <Select value={tagFilter} onChange={setTagFilter} label="tag">
            <option value="all">all</option>
            {allTags.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </Select>
        )}

        <div className="ml-auto flex items-center gap-3">
          <span
            className="mono hidden text-[10px] text-[var(--color-muted)] sm:block"
            title={STATUS_FRESHNESS_HINT}
          >
            {fleetFreshness(hosts, hostsQuery.dataUpdatedAt, now) ?? 'SSH never checked'}
            {hostsQuery.isFetching ? ' · refreshing…' : ''}
          </span>
          <Button
            size="sm"
            onClick={() => probeAll.mutate()}
            disabled={probeAll.isPending}
            title={PROBE_ALL_HINT}
          >
            {probeAll.isPending ? 'Probing…' : 'Probe all'}
          </Button>
          <div className="flex rounded border border-[var(--color-edge)]">
            <IconToggle active={view === 'grid'} onClick={() => setView('grid')} title="Card grid">
              <LayoutGrid size={14} />
            </IconToggle>
            <IconToggle active={view === 'table'} onClick={() => setView('table')} title="Dense table">
              <Rows3 size={14} />
            </IconToggle>
          </div>
        </div>
      </div>

      {hostsQuery.isLoading && <Skeleton label="Loading hosts…" />}
      {hostsQuery.error && <ErrorNote error={hostsQuery.error} />}

      {!hostsQuery.isLoading && filtered.length === 0 && (
        <Panel>
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <Server size={24} className="text-[var(--color-muted)]" />
            <p className="font-medium">{hosts.length === 0 ? 'No hosts yet' : 'No hosts match'}</p>
            <p className="max-w-md text-sm text-[var(--color-muted)]">
              {hosts.length === 0
                ? 'Import an inventory spreadsheet to get started. Check PREREQS.md first — each machine needs an SSH server running.'
                : 'Try clearing the filters.'}
            </p>
          </div>
        </Panel>
      )}

      {view === 'grid' ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((host) => (
            <HostCard key={host.id} host={host} now={now} />
          ))}
        </div>
      ) : (
        <HostTable hosts={filtered} now={now} />
      )}
    </>
  );
}

function Select({
  value,
  onChange,
  label,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mono flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-[var(--color-edge)] bg-[var(--color-panel)] px-2 py-1 text-[var(--color-ink)]"
      >
        {children}
      </select>
    </label>
  );
}

function IconToggle({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`px-2 py-1 ${active ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]'}`}
    >
      {children}
    </button>
  );
}

function HostCard({ host, now }: { host: Host; now: number }) {
  const tps = host.latestBenchmark?.evalTps;
  const statusTone =
    host.status === 'online'
      ? 'text-[var(--color-ok)]'
      : host.status === 'unknown'
        ? 'text-[var(--color-muted)]'
        : 'text-[var(--color-bad)]';
  return (
    <Panel className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <a href={`#/hosts/${host.id}`} className="block truncate font-medium hover:underline">
              {hostLabel(host)}
            </a>
            <NicknameEdit host={host} compact />
          </div>
          <p className="mono truncate text-[11px] text-[var(--color-muted)]">
            {host.nickname ? `${host.name} · ` : ''}
            {host.os ?? 'unknown'} {host.osVersion ?? ''}
            {host.isSelf && ' · local'}
            <span className={`ml-2 ${statusTone}`} title={STATUS_FRESHNESS_HINT}>
              · {host.status}
            </span>
          </p>
        </div>
        <BackendBadge backend={host.latestBenchmark?.backend} />
      </div>

      <HostPips host={host} />
      <p className="mono text-[10px] text-[var(--color-muted)]" title={checkedLineTitle(host)}>
        {host.lastCheckedAt
          ? `checked ${relativeTime(host.lastCheckedAt, now)}`
          : host.lastSeenAt
            ? `last up ${relativeTime(host.lastSeenAt, now)}`
            : 'never checked'}
        {host.lastCheckedAt && host.lastSeenAt && host.lastSeenAt !== host.lastCheckedAt
          ? ` · last up ${relativeTime(host.lastSeenAt, now)}`
          : ''}
      </p>

      <LlmModelBlock llm={host.llm} compact />

      <div className="flex items-end justify-between gap-2">
        <div title={benchTitle(host)}>
          <div className="mono text-2xl leading-none tabular-nums">
            {tps === undefined || tps === null ? (
              <span className="text-[var(--color-muted)]">—</span>
            ) : (
              tps.toFixed(1)
            )}
          </div>
          <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
            tok/s
            {host.latestBenchmark
              ? ` · ${relativeTime(host.latestBenchmark.ts, now)}`
              : ''}
          </div>
        </div>
        <dl className="mono space-y-0.5 text-right text-[11px] text-[var(--color-muted)]">
          <div>
            {host.specs?.cpuCores ?? '—'}c / {fmtBytes((host.specs?.ramTotalGb ?? 0) * 1024 ** 3)}
          </div>
          <div className="truncate" title={host.activeAddress?.address}>
            {host.activeAddress?.address ?? '—'}
          </div>
          <div>{host.activeAddress?.source ?? ''}</div>
        </dl>
      </div>

      <div className="flex flex-wrap gap-1.5 border-t border-[var(--color-edge)] pt-2">
        <a href={`#/hosts/${host.id}/chat`}>
          <Button size="sm" title="Open a chat session. Tools run on this host; the model may run here or on the operator Ollama.">
            <MessageSquare size={12} className="inline" /> Chat
          </Button>
        </a>
        <a href={`#/hosts/${host.id}/terminal`}>
          <Button size="sm" title="Interactive SSH terminal to this host. Does not change probe status by itself.">
            <TerminalIcon size={12} className="inline" /> Term
          </Button>
        </a>
        <a href={`#/hosts/${host.id}/provision`}>
          <Button size="sm" title="Install mesh, desktop, Ollama, and related packages on this host.">
            Provision
          </Button>
        </a>
        <a href={`#/hosts/${host.id}`}>
          <Button size="sm" title="Host overview: connection, specs, and last benchmark.">
            Details
          </Button>
        </a>
      </div>
    </Panel>
  );
}

function HostTable({ hosts, now }: { hosts: Host[]; now: number }) {
  return (
    <Panel className="overflow-x-auto">
      <table className="mono w-full text-left text-xs">
        <thead className="text-[var(--color-muted)]">
          <tr className="border-b border-[var(--color-edge)]">
            {['name', 'os', 'address', 'src', 'cpu', 'ram', 'chat model', 'tok/s', 'checked', 'state', 'status'].map(
              (h) => (
                <th key={h} className="py-1.5 pr-4 font-normal uppercase tracking-wide">
                  {h}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {hosts.map((host) => (
            <tr key={host.id} className="border-b border-[var(--color-edge)]/50">
              <td className="py-1.5 pr-4">
                <a href={`#/hosts/${host.id}`} className="hover:underline">
                  {hostLabel(host)}
                </a>
              </td>
              <td className="py-1.5 pr-4 text-[var(--color-muted)]">{host.os ?? '—'}</td>
              <td className="py-1.5 pr-4">{host.activeAddress?.address ?? '—'}</td>
              <td className="py-1.5 pr-4 text-[var(--color-muted)]">
                {host.activeAddress?.source ?? '—'}
              </td>
              <td className="py-1.5 pr-4 tabular-nums">{host.specs?.cpuCores ?? '—'}</td>
              <td className="py-1.5 pr-4 tabular-nums">
                {host.specs?.ramTotalGb ? `${host.specs.ramTotalGb.toFixed(0)}G` : '—'}
              </td>
              <td className="py-1.5 pr-4" title={host.llm?.summary}>
                <span className="font-medium">{host.llm?.chatModel ?? '—'}</span>
                <span className="ml-1 text-[var(--color-muted)]">
                  {llmWhereLabel(host.llm?.where)}
                </span>
              </td>
              <td className="py-1.5 pr-4 tabular-nums" title={benchTitle(host)}>
                {fmtTps(host.latestBenchmark?.evalTps)}
              </td>
              <td
                className="py-1.5 pr-4 text-[var(--color-muted)]"
                title={checkedLineTitle(host)}
              >
                {relativeTime(host.lastCheckedAt ?? host.lastSeenAt, now)}
              </td>
              <td className="py-1.5 pr-4 text-[var(--color-muted)]">{host.provisionState}</td>
              <td className="py-1.5 pr-4">
                <HostPips host={host} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Migration panel
// ---------------------------------------------------------------------------

function MigrationPanel({ state, loading }: { state?: MigrationState; loading: boolean }) {
  if (loading) return <Skeleton label="Checking mesh state…" />;
  if (!state) return null;

  if (!state.migrating) {
    return (
      <Panel>
        <div className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
          <Wifi size={15} />
          {state.note ?? 'Single mesh provider active.'}
        </div>
      </Panel>
    );
  }

  const stranded = state.stranded ?? [];
  const safe = state.safeToRemoveLegacy;

  return (
    <Panel
      tone={safe ? 'ok' : 'warn'}
      icon={safe ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
      title={
        safe
          ? `Mesh migration complete — safe to remove ${state.legacy?.provider}`
          : `Mesh migration — ${stranded.length} Tailscale peer(s) not yet on NetBird`
      }
    >
      <p className="mb-3 text-xs text-[var(--color-muted)]">
        This banner is about mesh cutover, not host online status. All inventory hosts still appear
        in the grid below; green/hollow pips are ssh · mesh · llm independently.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <PeerColumn
          label={`${state.primary?.provider ?? 'primary'} (target)`}
          reachable={state.primary?.reachable ?? false}
          peers={state.primary?.peers ?? []}
        />
        <PeerColumn
          label={`${state.legacy?.provider ?? 'legacy'} (leaving)`}
          reachable={state.legacy?.reachable ?? false}
          peers={state.legacy?.peers ?? []}
        />
      </div>

      {!safe && (
        <div className="mt-4 rounded border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 p-3">
          <p className="mb-2 text-sm text-[var(--color-warn)]">
            Do not remove {state.legacy?.provider} from these hosts — they have no peer on{' '}
            {state.primary?.provider} to fall back to:
          </p>
          <ul className="mono space-y-1 text-xs">
            {stranded.map((peer) => (
              <li key={peer.id}>
                {peer.hostname} <span className="text-[var(--color-muted)]">{peer.ip}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function PeerColumn({
  label,
  reachable,
  peers,
}: {
  label: string;
  reachable: boolean;
  peers: MigrationState['stranded'];
}) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-[var(--color-muted)]">
        {reachable ? <Wifi size={13} /> : <WifiOff size={13} />}
        {label}
      </div>
      {peers.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">
          {reachable ? 'No peers.' : 'Control plane unreachable.'}
        </p>
      ) : (
        <ul className="mono space-y-1 text-xs">
          {peers.map((peer) => (
            <li key={peer.id} className="flex items-center gap-2">
              <span
                className={peer.connected ? 'text-[var(--color-ok)]' : 'text-[var(--color-muted)]'}
              >
                ●
              </span>
              <span className="min-w-[13rem]">{peer.hostname}</span>
              <span className="text-[var(--color-muted)]">{peer.ip}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Host detail
// ---------------------------------------------------------------------------

function HostView({ id, tab }: { id: string; tab: HostTab }) {
  const hostQuery = useQuery({
    queryKey: ['host', id],
    queryFn: () => api.host(id),
    refetchInterval: 15_000,
  });

  if (hostQuery.isLoading) return <Skeleton label="Loading host…" />;
  if (hostQuery.error) return <ErrorNote error={hostQuery.error} />;
  const host = hostQuery.data;
  if (!host) return null;

  return (
    <>
      <div className="flex items-center gap-3">
        <a href="#/" className="text-sm text-[var(--color-muted)] hover:underline">
          ← Fleet
        </a>
        <h1 className="text-lg font-semibold">{hostLabel(host)}</h1>
        <NicknameEdit host={host} />
        <HostPips host={host} />
      </div>

      <nav className="flex gap-1 border-b border-[var(--color-edge)] text-sm">
        {(['overview', 'chat', 'terminal', 'desktop', 'provision'] as const).map((t) => (
          <a
            key={t}
            href={`#/hosts/${id}/${t}`}
            className={`px-3 py-1.5 capitalize ${
              tab === t
                ? 'border-b-2 border-[var(--color-accent)] text-[var(--color-ink)]'
                : 'text-[var(--color-muted)] hover:text-[var(--color-ink)]'
            }`}
          >
            {t}
          </a>
        ))}
      </nav>

      {tab === 'overview' && <HostOverview host={host} />}
      {tab === 'chat' && (
        <HostChat hostId={host.id} hostName={hostLabel(host)} llm={host.llm ?? null} />
      )}
      {tab === 'terminal' && (
        <Panel>
          {host.isSelf ? (
            <p className="text-sm text-[var(--color-muted)]">
              This is the machine running Fleet Console. Interactive terminal is disabled for the
              local host — use your own terminal instead.
            </p>
          ) : (
            <TerminalPane hostId={host.id} hostName={hostLabel(host)} />
          )}
        </Panel>
      )}
      {tab === 'desktop' && (
        <Panel>
          <RemoteDesktop
            hostId={host.id}
            hostName={hostLabel(host)}
            protocol={host.rdpProtocol === 'vnc' ? 'vnc' : 'rdp'}
          />
        </Panel>
      )}
      {tab === 'provision' && <ProvisionPanel hostId={id} />}
    </>
  );
}

function HostOverview({ host }: { host: Host }) {
  const queryClient = useQueryClient();
  const probe = useMutation({
    mutationFn: () => api.probe(host.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['host', host.id] }),
  });
  const bench = useMutation({
    mutationFn: () => api.benchmark(host.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['host', host.id] }),
  });
  const specs = useMutation({
    mutationFn: () => api.refreshSpecs(host.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['host', host.id] }),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel
        title="Connection"
        icon={<Activity size={15} />}
        actions={
          <Button
            size="sm"
            onClick={() => probe.mutate()}
            disabled={probe.isPending}
            title={PROBE_HINT}
          >
            {probe.isPending ? 'Probing…' : 'Probe'}
          </Button>
        }
      >
        <dl className="mono space-y-1 text-xs">
          <Row label="inventory name" value={host.name} />
          <Row label="nickname" value={host.nickname?.trim() || '—'} />
          <Row label="address" value={host.activeAddress?.address ?? '—'} />
          <Row label="source" value={host.activeAddress?.source ?? '—'} />
          <Row label="user" value={host.username} />
          <Row label="mesh" value={`${host.meshProvider} / ${host.meshStatus}`} />
          <Row
            label="last checked"
            value={host.lastCheckedAt ? relativeTime(host.lastCheckedAt) : 'never'}
            title="Last SSH probe or telemetry attempt, success or fail. Probe all / Probe updates this."
          />
          <Row
            label="last up"
            value={host.lastSeenAt ? relativeTime(host.lastSeenAt) : 'never'}
            title="Last time SSH reached a shell. Failed probes do not change this."
          />
          <Row label="remote desktop" value={`${host.rdpProtocol ?? '—'}:${host.rdpPort ?? '—'}`} />
          <Row label="provision" value={host.provisionState} />
        </dl>
        {probe.data && !probe.data.ok && (
          <div className="mt-3 rounded border border-[var(--color-bad)]/40 bg-[var(--color-bad)]/10 p-2 text-xs">
            <p className="text-[var(--color-bad)]">
              Failed at {probe.data.failedStage}: {probe.data.error}
            </p>
            {probe.data.remedy && (
              <p className="mt-1 text-[var(--color-muted)]">{probe.data.remedy}</p>
            )}
          </div>
        )}
        {host.lastError && !probe.data && (
          <p className="mt-3 text-xs text-[var(--color-bad)]">{host.lastError}</p>
        )}
      </Panel>

      <Panel title="LLM / chat model" icon={<Cpu size={15} />}>
        <LlmModelBlock llm={host.llm} />
      </Panel>

      <Panel
        title="Hardware"
        icon={<Monitor size={15} />}
        actions={
          <Button
            size="sm"
            onClick={() => specs.mutate()}
            disabled={specs.isPending}
            title="SSH in and re-collect CPU, RAM, GPU, and disk. Separate from Probe, which only checks reachability."
          >
            {specs.isPending ? 'Collecting…' : 'Refresh'}
          </Button>
        }
      >
        {host.specs ? (
          <dl className="mono space-y-1 text-xs">
            <Row label="cpu" value={host.specs.cpuModel ?? '—'} />
            <Row
              label="cores"
              value={`${host.specs.cpuCores ?? '—'} / ${host.specs.cpuThreads ?? '—'} threads`}
            />
            <Row
              label="ram"
              value={`${host.specs.ramFreeGb?.toFixed(1) ?? '—'} free of ${host.specs.ramTotalGb?.toFixed(1) ?? '—'} GB`}
            />
            {(host.specs.gpu ?? []).map((g, i) => (
              <Row
                key={i}
                label={`gpu${i}`}
                value={`${g.model}${g.vramMb ? ` ${(g.vramMb / 1024).toFixed(1)}GB` : ''} (${g.backend})`}
              />
            ))}
            {(host.specs.storage ?? []).map((s, i) => (
              <Row
                key={i}
                label={s.mount}
                value={`${fmtBytes(s.freeBytes)} free of ${fmtBytes(s.totalBytes)}`}
              />
            ))}
          </dl>
        ) : (
          <p className="text-xs text-[var(--color-muted)]">
            No specs collected yet. Provision the host or press Refresh.
          </p>
        )}
      </Panel>

      <Panel
        title="LLM benchmark"
        icon={<Trophy size={15} />}
        className="lg:col-span-2"
        actions={
          <Button
            size="sm"
            onClick={() => bench.mutate()}
            disabled={bench.isPending}
            title="Run an Ollama throughput benchmark on this host and store eval tok/s. Probe all does not do this."
          >
            {bench.isPending ? 'Benchmarking…' : 'Re-bench'}
          </Button>
        }
      >
        {bench.error && <p className="mb-2 text-xs text-[var(--color-bad)]">{String(bench.error)}</p>}
        {host.latestBenchmark ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Metric label="model" value={host.latestBenchmark.model} />
            <Metric label="eval tok/s" value={fmtTps(host.latestBenchmark.evalTps)} big />
            <Metric label="prompt tok/s" value={fmtTps(host.latestBenchmark.promptTps)} />
            <Metric
              label="ttft"
              value={host.latestBenchmark.ttftMs ? `${host.latestBenchmark.ttftMs.toFixed(0)}ms` : '—'}
            />
            <Metric
              label="load"
              value={host.latestBenchmark.loadMs ? `${host.latestBenchmark.loadMs.toFixed(0)}ms` : '—'}
            />
            <Metric label="num_ctx" value={String(host.latestBenchmark.numCtx ?? '—')} />
          </div>
        ) : (
          <p className="text-xs text-[var(--color-muted)]">
            Never benchmarked. Requires Ollama installed and reachable on this host.
          </p>
        )}
      </Panel>
    </div>
  );
}

function llmWhereLabel(where?: HostLlmInfo['where']): string {
  switch (where) {
    case 'this_host':
      return 'on host';
    case 'forced_operator':
      return 'operator';
    case 'operator_fallback':
      return 'fallback';
    case 'unavailable':
      return 'down';
    default:
      return '';
  }
}

function LlmModelBlock({ llm, compact }: { llm?: HostLlmInfo | null; compact?: boolean }) {
  if (!llm) {
    return (
      <p className="text-xs text-[var(--color-muted)]">Model info unavailable.</p>
    );
  }
  const whereTone =
    llm.where === 'unavailable'
      ? 'text-[var(--color-bad)]'
      : llm.where === 'operator_fallback' || llm.where === 'forced_operator'
        ? 'text-[var(--color-warn)]'
        : 'text-[var(--color-ok)]';

  if (compact) {
    return (
      <div
        className="rounded border border-[var(--color-edge)] bg-[var(--color-surface)] px-2 py-1.5"
        title={llm.summary}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="mono text-xs font-medium">{llm.chatModel}</span>
          <span className={`mono text-[10px] uppercase tracking-wide ${whereTone}`} title={llm.summary}>
            {llmWhereLabel(llm.where)}
          </span>
        </div>
        <p className="mt-0.5 text-[10px] leading-snug text-[var(--color-muted)]">{llm.summary}</p>
      </div>
    );
  }

  return (
    <dl className="mono space-y-1 text-xs">
      <Row label="chat model" value={llm.chatModel} />
      <Row label="bench model" value={llm.benchModel} />
      <Row label="runs on" value={llmWhereLabel(llm.where) || llm.where} />
      <Row label="endpoint" value={llm.baseUrl ?? '—'} />
      <Row label="host ollama" value={llm.hostOllamaUp ? 'up' : 'down'} />
      <div className="pt-1 text-[11px] leading-snug text-[var(--color-muted)] normal-case">
        {llm.summary}
      </div>
    </dl>
  );
}

function Row({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex justify-between gap-3" title={title}>
      <dt className="text-[var(--color-muted)]">{label}</dt>
      <dd className="truncate text-right">{value}</dd>
    </div>
  );
}

function Metric({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div>
      <div className={`mono tabular-nums ${big ? 'text-2xl' : 'text-lg'}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">{label}</div>
    </div>
  );
}

function ProvisionPanel({ hostId }: { hostId: string }) {
  const [report, setReport] = useState<ProvisionReport | null>(null);
  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.provision(hostId, { dryRun }),
    onSuccess: setReport,
  });

  return (
    <Panel
      title="Provisioning"
      actions={
        <>
          <Button size="sm" onClick={() => run.mutate(true)} disabled={run.isPending}>
            Dry run
          </Button>
          <Button size="sm" tone="primary" onClick={() => run.mutate(false)} disabled={run.isPending}>
            {run.isPending ? 'Running…' : 'Provision'}
          </Button>
        </>
      }
    >
      {run.error && <ErrorNote error={run.error} />}
      {!report && !run.isPending && (
        <p className="text-xs text-[var(--color-muted)]">
          Dry run prints every command without connecting to the host.
        </p>
      )}
      {report && (
        <>
          <p className="mb-3 text-xs text-[var(--color-muted)]">
            {report.dryRun ? 'Dry run — nothing was executed.' : 'Live run.'} Finished in{' '}
            {report.durationMs}ms.
          </p>
          <ul className="space-y-2">
            {report.steps.map((step) => (
              <li key={step.id} className="rounded border border-[var(--color-edge)] p-2">
                <div className="flex items-center gap-2 text-xs">
                  <StepStatus status={step.status} />
                  <span className="mono">{step.id}</span>
                  <span className="text-[var(--color-muted)]">{step.detail}</span>
                </div>
                {step.commands && step.commands.length > 0 && (
                  <pre className="mono mt-2 max-h-40 overflow-auto rounded bg-[var(--color-surface)] p-2 text-[10px] text-[var(--color-muted)]">
                    {step.commands.join('\n\n')}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

function StepStatus({ status }: { status: string }) {
  const tone =
    status === 'ok'
      ? 'text-[var(--color-ok)]'
      : status === 'failed'
        ? 'text-[var(--color-bad)]'
        : status === 'blocked'
          ? 'text-[var(--color-warn)]'
          : 'text-[var(--color-muted)]';
  return <span className={`mono w-24 shrink-0 ${tone}`}>{status}</span>;
}

// ---------------------------------------------------------------------------
// Leaderboard & audit
// ---------------------------------------------------------------------------

function LeaderboardView() {
  const query = useQuery({ queryKey: ['leaderboard'], queryFn: api.leaderboard });

  if (query.isLoading) return <Skeleton label="Loading leaderboard…" />;
  if (query.error) return <ErrorNote error={query.error} />;

  const entries = query.data?.entries ?? [];
  if (entries.length === 0) {
    return (
      <Panel>
        <p className="text-sm text-[var(--color-muted)]">
          No benchmarks yet. Provision a host with Ollama, then run a benchmark from its
          Overview tab.
        </p>
      </Panel>
    );
  }

  const byBackend = query.data?.byBackend ?? {};

  return (
    <>
      <Panel title="Fleet ranking" icon={<Trophy size={15} />}>
        <LeaderTable entries={entries} />
      </Panel>
      {Object.entries(byBackend).map(([backend, group]) => (
        <Panel key={backend} title={<span className="capitalize">{backend}</span>}>
          <LeaderTable entries={group} />
        </Panel>
      ))}
    </>
  );
}

function LeaderTable({ entries }: { entries: LeaderboardEntry[] }) {
  const max = Math.max(...entries.map((e) => e.evalTps ?? 0), 1);
  return (
    <table className="mono w-full text-left text-xs">
      <thead className="text-[var(--color-muted)]">
        <tr className="border-b border-[var(--color-edge)]">
          {['#', 'host', 'backend', 'model', 'eval tok/s', 'prompt tok/s', 'ttft', 'ctx', 'when'].map(
            (h) => (
              <th key={h} className="py-1.5 pr-4 font-normal uppercase tracking-wide">
                {h}
              </th>
            ),
          )}
        </tr>
      </thead>
      <tbody>
        {entries.map((entry, i) => (
          <tr key={entry.hostId} className="border-b border-[var(--color-edge)]/50">
            <td className="py-1.5 pr-4 text-[var(--color-muted)]">{i + 1}</td>
            <td className="py-1.5 pr-4">
              <a href={`#/hosts/${entry.hostId}`} className="hover:underline">
                {entry.name}
              </a>
            </td>
            <td className="py-1.5 pr-4">
              <BackendBadge backend={entry.backend} />
            </td>
            <td className="py-1.5 pr-4 text-[var(--color-muted)]">{entry.model}</td>
            <td className="py-1.5 pr-4">
              <div className="flex items-center gap-2">
                <span className="w-12 tabular-nums">{fmtTps(entry.evalTps)}</span>
                <span
                  className="h-1.5 rounded bg-[var(--color-accent)]/60"
                  style={{ width: `${((entry.evalTps ?? 0) / max) * 100}px` }}
                />
              </div>
            </td>
            <td className="py-1.5 pr-4 tabular-nums">{fmtTps(entry.promptTps)}</td>
            <td className="py-1.5 pr-4 tabular-nums">
              {entry.ttftMs ? `${entry.ttftMs.toFixed(0)}ms` : '—'}
            </td>
            <td className="py-1.5 pr-4 tabular-nums">{entry.numCtx ?? '—'}</td>
            <td className="py-1.5 pr-4 text-[var(--color-muted)]">{relativeTime(entry.ts)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AuditView() {
  const query = useQuery({ queryKey: ['audit'], queryFn: () => api.audit() });
  const hostsQuery = useQuery({ queryKey: ['hosts'], queryFn: api.hosts });

  if (query.isLoading) return <Skeleton label="Loading audit log…" />;
  if (query.error) return <ErrorNote error={query.error} />;

  const names = new Map(
    (hostsQuery.data?.hosts ?? []).map((h) => [h.id, hostLabel(h)]),
  );
  const entries = query.data?.entries ?? [];

  return (
    <Panel title="Command audit" icon={<ScrollText size={15} />}>
      {entries.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">
          Nothing executed yet. Every command run through Fleet Console — terminal, one-shot exec,
          provisioning, or an approved agent action — is recorded here.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="mono w-full text-left text-xs">
            <thead className="text-[var(--color-muted)]">
              <tr className="border-b border-[var(--color-edge)]">
                {['when', 'host', 'source', 'approved by', 'exit', 'command'].map((h) => (
                  <th key={h} className="py-1.5 pr-4 font-normal uppercase tracking-wide">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-b border-[var(--color-edge)]/50">
                  <td className="py-1.5 pr-4 text-[var(--color-muted)]">
                    {relativeTime(entry.ranAt)}
                  </td>
                  <td className="py-1.5 pr-4">{names.get(entry.hostId) ?? entry.hostId.slice(0, 8)}</td>
                  <td className="py-1.5 pr-4 text-[var(--color-muted)]">{entry.source}</td>
                  <td className="py-1.5 pr-4">{entry.approvedBy ?? '—'}</td>
                  <td
                    className={`py-1.5 pr-4 tabular-nums ${
                      entry.exitCode === 0 ? 'text-[var(--color-ok)]' : 'text-[var(--color-bad)]'
                    }`}
                  >
                    {entry.exitCode ?? '—'}
                  </td>
                  <td className="max-w-md truncate py-1.5 pr-4" title={entry.command}>
                    {entry.command}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

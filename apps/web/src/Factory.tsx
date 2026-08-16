import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Factory, Send } from 'lucide-react';
import { api, hostLabel, type Host } from './api.js';
import { Button, Panel } from './components.jsx';

export function FactoryView({ hosts }: { hosts: Host[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <FactoryChat hosts={hosts} />
      <div className="space-y-4">
        <JobsPanel hosts={hosts} />
        <SchedulesPanel />
        <p className="text-xs text-[var(--color-muted)]">
          Single-operator localhost factory. Multi-user auth and on-host worker daemons are deferred.
          Mesh-stranded hosts still need NetBird enroll (sudo) before Tailscale can be removed.
        </p>
      </div>
    </div>
  );
}

function FactoryChat({ hosts }: { hosts: Host[] }) {
  const queryClient = useQueryClient();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const sessions = useQuery({
    queryKey: ['factory-sessions'],
    queryFn: api.factorySessions,
  });

  const thread = useQuery({
    queryKey: ['factory-thread', sessionId],
    queryFn: () => api.factoryThread(sessionId!),
    enabled: Boolean(sessionId),
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [thread.data?.messages.length]);

  const ensureSession = async () => {
    if (sessionId) return sessionId;
    const created = await api.createFactorySession('Factory chat');
    setSessionId(created.id);
    await queryClient.invalidateQueries({ queryKey: ['factory-sessions'] });
    return created.id;
  };

  const send = useMutation({
    mutationFn: async (text: string) => {
      const id = await ensureSession();
      const result = await api.sendFactoryMessage(id, text);
      return { id, result };
    },
    onSuccess: async ({ id }) => {
      setDraft('');
      setError(null);
      setSessionId(id);
      await queryClient.invalidateQueries({ queryKey: ['factory-thread', id] });
      await queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const hostName = (id: string) => {
    const h = hosts.find((x) => x.id === id);
    return h ? hostLabel(h) : id.slice(0, 8);
  };

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <Factory size={15} />
          Factory Chat
        </span>
      }
      className="flex min-h-[28rem] flex-col"
      actions={
        <Button
          size="sm"
          onClick={async () => {
            const created = await api.createFactorySession('Factory chat');
            setSessionId(created.id);
            await queryClient.invalidateQueries({ queryKey: ['factory-sessions'] });
          }}
        >
          New
        </Button>
      }
    >
      <p className="mb-2 text-xs text-[var(--color-muted)]">
        Talk to the fleet. Example: “open Photo Booth on the Mac mini” — no need to open that host’s
        chat first. Known:{' '}
        {hosts.map((h) => hostLabel(h)).join(', ') || 'none'}
      </p>

      <select
        className="mono mb-2 max-w-full rounded border border-[var(--color-edge)] bg-[var(--color-panel)] px-2 py-1 text-xs"
        value={sessionId ?? ''}
        onChange={(e) => setSessionId(e.target.value || null)}
      >
        <option value="">New / pick session</option>
        {(sessions.data?.sessions ?? []).map((s) => (
          <option key={s.id} value={s.id}>
            {s.title ?? s.id.slice(0, 8)}
          </option>
        ))}
      </select>

      <div className="mb-3 flex min-h-[14rem] flex-1 flex-col gap-2 overflow-y-auto rounded border border-[var(--color-edge)] bg-[var(--color-surface)] p-3">
        {(thread.data?.messages ?? []).map((m) => (
          <div
            key={m.id}
            className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
              m.role === 'user'
                ? 'ml-8 bg-[var(--color-accent)]/15'
                : 'mr-4 bg-[var(--color-panel)]'
            }`}
          >
            <div className="mono mb-1 text-[10px] uppercase tracking-wide text-[var(--color-muted)]">
              {m.role}
              {m.hostIds && m.hostIds.length > 0
                ? ` · ${m.hostIds.map(hostName).join(', ')}`
                : ''}
              {m.jobId ? ` · job ${m.jobId.slice(0, 8)}` : ''}
            </div>
            {m.content}
            {m.hostIds?.[0] && (
              <a
                href={`#/hosts/${m.hostIds[0]}/chat`}
                className="mt-1 block text-xs text-[var(--color-accent)] underline"
              >
                Open host chat
              </a>
            )}
          </div>
        ))}
        {send.isPending && (
          <p className="mono text-xs text-[var(--color-muted)]">Working across the factory…</p>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <p className="mb-2 text-xs text-[var(--color-bad)]">{error}</p>}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const text = draft.trim();
          if (!text || send.isPending) return;
          send.mutate(text);
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={send.isPending}
          placeholder='e.g. open Photo Booth on the Mac mini'
          className="flex-1 rounded border border-[var(--color-edge)] bg-[var(--color-panel)] px-3 py-2 text-sm"
        />
        <Button tone="primary" disabled={send.isPending || !draft.trim()}>
          <Send size={14} />
        </Button>
      </form>
    </Panel>
  );
}

function JobsPanel({ hosts }: { hosts: Host[] }) {
  const queryClient = useQueryClient();
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: api.jobs, refetchInterval: 5000 });
  const [command, setCommand] = useState('hostname');

  const runParallel = useMutation({
    mutationFn: () =>
      api.createJob({
        type: 'exec',
        title: `exec: ${command}`,
        hostIds: hosts.filter((h) => h.status === 'online' || h.isSelf).map((h) => h.id),
        payload: { command },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs'] }),
  });

  return (
    <Panel title="Jobs">
      <div className="mb-3 flex gap-2">
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          className="mono flex-1 rounded border border-[var(--color-edge)] bg-[var(--color-panel)] px-2 py-1 text-xs"
          placeholder="shell command for all online hosts"
        />
        <Button
          size="sm"
          tone="primary"
          disabled={runParallel.isPending || !command.trim()}
          onClick={() => runParallel.mutate()}
        >
          Run all
        </Button>
      </div>
      <div className="max-h-64 space-y-2 overflow-y-auto text-xs">
        {(jobs.data?.jobs ?? []).slice(0, 20).map((j) => (
          <div key={j.id} className="rounded border border-[var(--color-edge)] p-2">
            <div className="flex justify-between gap-2">
              <span className="font-medium">{j.title}</span>
              <span className="mono text-[var(--color-muted)]">{j.status}</span>
            </div>
            <div className="mono mt-1 text-[10px] text-[var(--color-muted)]">
              {j.type} · {j.runs.length} run(s) · {j.id.slice(0, 8)}
            </div>
            {j.runs.map((r) => (
              <pre
                key={r.id}
                className="mono mt-1 max-h-20 overflow-auto whitespace-pre-wrap text-[10px] text-[var(--color-muted)]"
              >
                {hosts.find((h) => h.id === r.hostId)
                  ? hostLabel(hosts.find((h) => h.id === r.hostId)!)
                  : r.hostId.slice(0, 8)}
                : {r.status}
                {r.result ? `\n${r.result.slice(0, 400)}` : ''}
                {r.error ? `\nERR ${r.error}` : ''}
              </pre>
            ))}
          </div>
        ))}
        {(jobs.data?.jobs ?? []).length === 0 && (
          <p className="text-[var(--color-muted)]">No jobs yet.</p>
        )}
      </div>
    </Panel>
  );
}

function SchedulesPanel() {
  const queryClient = useQueryClient();
  const schedules = useQuery({ queryKey: ['schedules'], queryFn: api.schedules });
  const create = useMutation({
    mutationFn: () =>
      api.createSchedule({
        name: 'Probe all (hourly)',
        everyMinutes: 60,
        jobType: 'probe',
        payload: {},
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['schedules'] }),
  });

  return (
    <Panel
      title="Schedules"
      actions={
        <Button size="sm" onClick={() => create.mutate()} disabled={create.isPending}>
          Add hourly probe
        </Button>
      }
    >
      <div className="space-y-2 text-xs">
        {(schedules.data?.schedules ?? []).map((s) => (
          <div
            key={s.id}
            className="flex items-center justify-between gap-2 rounded border border-[var(--color-edge)] px-2 py-1.5"
          >
            <div>
              <div className="font-medium">{s.name}</div>
              <div className="mono text-[10px] text-[var(--color-muted)]">
                every {s.everyMinutes}m · {s.jobType}
                {s.enabled ? '' : ' · disabled'}
              </div>
            </div>
            <Button
              size="sm"
              tone="danger"
              onClick={async () => {
                await api.deleteSchedule(s.id);
                await queryClient.invalidateQueries({ queryKey: ['schedules'] });
              }}
            >
              Delete
            </Button>
          </div>
        ))}
        {(schedules.data?.schedules ?? []).length === 0 && (
          <p className="text-[var(--color-muted)]">No schedules. Add an hourly probe to start.</p>
        )}
      </div>
    </Panel>
  );
}

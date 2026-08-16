import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

export type Toast = { id: string; tone: 'ok' | 'warn' | 'bad'; text: string };

/** Subscribe to /ws/events: toasts for jobs, and host-list refresh on probe/telemetry. */
export function useFleetToasts(): { toasts: Toast[]; dismiss: (id: string) => void } {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const queryClient = useQueryClient();

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/events`);
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const refreshHosts = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ['hosts'] });
      }, 1500);
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          type?: string;
          title?: string;
          error?: string;
          name?: string;
          hostId?: string;
        };
        if (!msg.type || msg.type === 'hello' || msg.type === 'heartbeat') return;
        if (msg.type === 'telemetry' || msg.type === 'probe') {
          refreshHosts();
          if (msg.hostId) {
            void queryClient.invalidateQueries({ queryKey: ['host', msg.hostId] });
          }
          return;
        }
        if (msg.type === 'job_ok') {
          push({ tone: 'ok', text: `Job finished: ${msg.title ?? 'job'}` });
        } else if (msg.type === 'job_failed') {
          push({ tone: 'bad', text: `Job failed: ${msg.title ?? msg.error ?? 'job'}` });
        } else if (msg.type === 'job_started') {
          push({ tone: 'warn', text: `Job started: ${msg.title ?? 'job'}` });
        } else if (msg.type === 'schedule_fired') {
          push({ tone: 'ok', text: `Schedule fired: ${msg.name ?? 'schedule'}` });
        }
      } catch {
        /* ignore */
      }
    };
    return () => {
      ws.close();
      if (debounce) clearTimeout(debounce);
    };

    function push(t: Omit<Toast, 'id'>) {
      const id = `${Date.now()}-${Math.random()}`;
      setToasts((prev) => [...prev.slice(-4), { ...t, id }]);
      setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 8000);
    }
  }, [queryClient]);

  return {
    toasts,
    dismiss: (id) => setToasts((prev) => prev.filter((t) => t.id !== id)),
  };
}

export function ToastStack({
  toasts,
  dismiss,
}: {
  toasts: Toast[];
  dismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismiss(t.id)}
          className={`pointer-events-auto rounded border px-3 py-2 text-left text-xs shadow ${
            t.tone === 'ok'
              ? 'border-[var(--color-ok)]/40 bg-[var(--color-ok)]/15'
              : t.tone === 'bad'
                ? 'border-[var(--color-bad)]/40 bg-[var(--color-bad)]/15'
                : 'border-[var(--color-warn)]/40 bg-[var(--color-warn)]/15'
          }`}
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}

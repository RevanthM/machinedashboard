import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

/**
 * Browser terminal (R-23).
 *
 * Resize is propagated to the remote PTY so full-screen programs (top, vim)
 * redraw at the right size — without it the remote side stays at its initial
 * 80x24 and the display corrupts as soon as the pane changes size.
 */
export function TerminalPane({ hostId, hostName }: { hostId: string; hostName: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');
  const [message, setMessage] = useState<string>('');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      fontFamily: 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      scrollback: 10_000, // R-23
      cursorBlink: true,
      theme: {
        background: '#0b0e14',
        foreground: '#d5dae3',
        cursor: '#58a6ff',
        selectionBackground: '#1e2530',
      },
    });

    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(container);
    fit.fit();

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}/ws/terminal/${hostId}`);

    socket.onopen = () => {
      setStatus('open');
      // Tell the remote PTY our real size before anything is drawn.
      socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as
          | { type: 'data'; data: string }
          | { type: 'exit'; code: number | null }
          | { type: 'error'; message: string };

        if (msg.type === 'data') term.write(msg.data);
        else if (msg.type === 'exit') {
          setStatus('closed');
          term.write(`\r\n\x1b[90m[session ended${msg.code === null ? '' : `, code ${msg.code}`}]\x1b[0m\r\n`);
        } else {
          setStatus('error');
          setMessage(msg.message);
          term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
        }
      } catch {
        // Ignore malformed frames.
      }
    };

    socket.onerror = () => setStatus('error');
    socket.onclose = () => setStatus((s) => (s === 'error' ? s : 'closed'));

    const onData = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'input', data }));
      }
    });

    const resize = () => {
      fit.fit();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    return () => {
      observer.disconnect();
      onData.dispose();
      socket.close();
      term.dispose();
    };
  }, [hostId]);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center gap-2 text-xs text-[var(--color-muted)]">
        <span className="mono">{hostName}</span>
        <span
          className={
            status === 'open'
              ? 'text-[var(--color-ok)]'
              : status === 'error'
                ? 'text-[var(--color-bad)]'
                : 'text-[var(--color-muted)]'
          }
        >
          ● {status}
        </span>
        {message && <span className="text-[var(--color-bad)]">{message}</span>}
      </div>
      <div
        ref={containerRef}
        className="min-h-[420px] flex-1 overflow-hidden rounded border border-[var(--color-edge)] bg-[#0b0e14] p-2"
      />
    </div>
  );
}

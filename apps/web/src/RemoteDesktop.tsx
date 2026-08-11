import { useEffect, useRef, useState } from 'react';
import Guacamole from 'guacamole-common-js';
import { Button } from './components.jsx';

/**
 * In-browser remote desktop (R-25, R-26).
 *
 * The credentials for the target never reach this component. It receives an
 * opaque token from `/api/hosts/:id/rdp/session`, and the API has already
 * opened a single-use loopback shim pointing at the host — so the token is
 * useless once the session starts or its minute elapses.
 */

type Status = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export function RemoteDesktop({
  hostId,
  hostName,
  protocol,
}: {
  hostId: string;
  hostName: string;
  protocol: 'rdp' | 'vnc';
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<Guacamole.Client | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    return () => {
      clientRef.current?.disconnect();
      clientRef.current = null;
    };
  }, []);

  const connect = async () => {
    setStatus('connecting');
    setError('');

    try {
      const res = await fetch(`/api/hosts/${hostId}/rdp/session`, { method: 'POST' });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? res.statusText);
      const { token } = (await res.json()) as { token: string };

      const viewport = viewportRef.current;
      if (!viewport) return;
      viewport.replaceChildren();

      const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
      const tunnel = new Guacamole.WebSocketTunnel(`${wsProtocol}://${location.host}/guac`);
      const client = new Guacamole.Client(tunnel);
      clientRef.current = client;

      viewport.appendChild(client.getDisplay().getElement());

      client.onerror = (status) => {
        setStatus('error');
        setError(status.message || 'Connection failed.');
      };

      client.onstatechange = (state) => {
        // 3 = CONNECTED, 5 = DISCONNECTED in guacamole-common-js.
        if (state === 3) setStatus('connected');
        if (state === 5) setStatus('disconnected');
      };

      // R-26: clipboard sync, remote -> local.
      client.onclipboard = (stream, mimetype) => {
        if (!mimetype.startsWith('text/')) return;
        const reader = new Guacamole.StringReader(stream);
        let text = '';
        reader.ontext = (chunk) => {
          text += chunk;
        };
        reader.onend = () => {
          void navigator.clipboard?.writeText(text).catch(() => {
            // Clipboard write needs document focus; failing is not fatal.
          });
        };
      };

      const size = viewport.getBoundingClientRect();
      client.connect(
        new URLSearchParams({
          token,
          width: String(Math.floor(size.width) || 1280),
          height: String(Math.floor(size.height) || 800),
          dpi: '96',
        }).toString(),
      );

      // Input wiring — without these the display renders but nothing responds.
      const display = client.getDisplay().getElement();
      const mouse = new Guacamole.Mouse(display);
      const sendMouse = (mouseState: Guacamole.Mouse.State) => client.sendMouseState(mouseState);
      mouse.onmousedown = sendMouse;
      mouse.onmouseup = sendMouse;
      mouse.onmousemove = sendMouse;

      const keyboard = new Guacamole.Keyboard(document);
      keyboard.onkeydown = (keysym) => client.sendKeyEvent(1, keysym);
      keyboard.onkeyup = (keysym) => client.sendKeyEvent(0, keysym);

      // R-26: dynamic resize — tell the server when the pane changes size.
      const observer = new ResizeObserver(() => {
        const box = viewport.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) {
          client.sendSize(Math.floor(box.width), Math.floor(box.height));
        }
      });
      observer.observe(viewport);
    } catch (err) {
      setStatus('error');
      setError((err as Error).message);
    }
  };

  const disconnect = () => {
    clientRef.current?.disconnect();
    clientRef.current = null;
    setStatus('disconnected');
  };

  /** R-26: Ctrl+Alt+Del, which the browser would otherwise intercept. */
  const sendCtrlAltDel = () => {
    const client = clientRef.current;
    if (!client) return;
    const CTRL = 0xffe3;
    const ALT = 0xffe9;
    const DEL = 0xffff;
    for (const key of [CTRL, ALT, DEL]) client.sendKeyEvent(1, key);
    for (const key of [DEL, ALT, CTRL]) client.sendKeyEvent(0, key);
  };

  const goFullscreen = () => {
    void viewportRef.current?.requestFullscreen?.().catch(() => undefined);
  };

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="mono text-[var(--color-muted)]">
          {hostName} · {protocol.toUpperCase()}
        </span>
        <span
          className={
            status === 'connected'
              ? 'text-[var(--color-ok)]'
              : status === 'error'
                ? 'text-[var(--color-bad)]'
                : 'text-[var(--color-muted)]'
          }
        >
          ● {status}
        </span>

        <div className="ml-auto flex gap-1.5">
          {status !== 'connected' ? (
            <Button size="sm" tone="primary" onClick={() => void connect()} disabled={status === 'connecting'}>
              {status === 'connecting' ? 'Connecting…' : 'Connect'}
            </Button>
          ) : (
            <>
              <Button size="sm" onClick={sendCtrlAltDel} title="Send Ctrl+Alt+Del">
                Ctrl+Alt+Del
              </Button>
              <Button size="sm" onClick={goFullscreen}>
                Fullscreen
              </Button>
              <Button size="sm" tone="danger" onClick={disconnect}>
                Disconnect
              </Button>
            </>
          )}
          <a href={`/api/hosts/${hostId}/rdp/file`} download>
            <Button size="sm" title="Download .rdp for a native client">
              .rdp
            </Button>
          </a>
        </div>
      </div>

      {error && (
        <div className="rounded border border-[var(--color-bad)]/40 bg-[var(--color-bad)]/10 p-2 text-xs text-[var(--color-bad)]">
          {error}
          {error.includes('guacd') && (
            <p className="mt-1 text-[var(--color-muted)]">
              Start guacd: <code>docker compose -f deploy/guacd/docker-compose.yml up -d</code>
            </p>
          )}
        </div>
      )}

      <div
        ref={viewportRef}
        className="min-h-[480px] flex-1 overflow-hidden rounded border border-[var(--color-edge)] bg-black"
      />
    </div>
  );
}

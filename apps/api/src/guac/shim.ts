/**
 * Loopback TCP shim — the mitigation for PRD §14 risk #1.
 *
 * The problem: guacd runs in a container and must open a TCP connection to a
 * host's mesh address (100.x.x.x:5900/3389). On Linux you can paper over this
 * with `network_mode: host`. This operator machine is **Windows**, where Docker
 * containers live in a WSL2 VM, host networking is unavailable, and the mesh
 * client's TUN adapter belongs to the Windows host — so the container simply
 * cannot route to 100.x.
 *
 * The fix inverts who dials. The Node process runs natively on Windows and has
 * full mesh access, so it opens a listener on loopback and pipes bytes to the
 * mesh address. guacd is then pointed at `host.docker.internal:<port>` and
 * never needs mesh routing at all.
 *
 * This also works unchanged on Linux and macOS operators, so there is one code
 * path rather than a per-platform branch.
 *
 * Each shim is single-use and short-lived: it accepts exactly one connection,
 * then stops listening. A leftover listener would be an unauthenticated tunnel
 * to a host's RDP port sitting open on loopback.
 */
import { createServer, connect, type Server, type Socket } from 'node:net';

export interface ShimHandle {
  /** Port on 127.0.0.1 that guacd should connect to. */
  port: number;
  target: { host: string; port: number };
  close(): void;
}

export interface ShimOptions {
  targetHost: string;
  targetPort: number;
  /** Close if guacd never connects within this window. */
  acceptTimeoutMs?: number;
  /** Close this long after the session starts, regardless. */
  maxSessionMs?: number;
  onClose?: (reason: string) => void;
}

export function openShim(opts: ShimOptions): Promise<ShimHandle> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let acceptTimer: NodeJS.Timeout | undefined;
    let sessionTimer: NodeJS.Timeout | undefined;
    const sockets = new Set<Socket>();

    const server: Server = createServer();

    const shutdown = (reason: string) => {
      if (acceptTimer) clearTimeout(acceptTimer);
      if (sessionTimer) clearTimeout(sessionTimer);
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close();
      opts.onClose?.(reason);
    };

    server.on('connection', (client) => {
      // Single-use: stop accepting the moment guacd connects, so a second
      // process cannot ride the same tunnel.
      server.close();
      if (acceptTimer) clearTimeout(acceptTimer);
      sockets.add(client);

      const upstream = connect({ host: opts.targetHost, port: opts.targetPort });
      sockets.add(upstream);

      upstream.on('connect', () => {
        client.pipe(upstream);
        upstream.pipe(client);
      });

      const bail = (reason: string) => () => shutdown(reason);
      upstream.on('error', bail('upstream error'));
      client.on('error', bail('client error'));
      upstream.on('close', bail('upstream closed'));
      client.on('close', bail('client closed'));

      sessionTimer = setTimeout(
        () => shutdown('max session duration reached'),
        opts.maxSessionMs ?? 8 * 60 * 60 * 1000,
      );
    });

    server.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    // Port 0 lets the OS pick a free port; binding to 127.0.0.1 keeps the
    // tunnel off every other interface.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || address === null) {
        reject(new Error('Shim failed to bind a TCP port.'));
        return;
      }

      acceptTimer = setTimeout(
        () => shutdown('guacd never connected'),
        opts.acceptTimeoutMs ?? 60_000,
      );

      settled = true;
      resolvePromise({
        port: address.port,
        target: { host: opts.targetHost, port: opts.targetPort },
        close: () => shutdown('closed by caller'),
      });
    });
  });
}

/**
 * Can guacd actually reach a mesh address directly?
 *
 * Used by the preflight check so the operator learns the answer from a
 * diagnostic rather than from a remote-desktop session that hangs.
 */
export async function checkTcpReachable(
  host: string,
  port: number,
  timeoutMs = 5000,
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ host, port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolvePromise(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

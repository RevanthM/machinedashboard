/**
 * guacamole-lite WebSocket tunnel (R-25).
 *
 * Runs on its own loopback HTTP server rather than sharing Fastify's.
 * @fastify/websocket and guacamole-lite each install their own `upgrade`
 * handler, and two handlers on one server fight over every upgrade request —
 * the terminal WS and the desktop WS would intermittently steal each other's
 * connections. A separate port keeps the two stacks from interacting at all;
 * Vite proxies `/guac` to it in dev.
 *
 * Token format is dictated by guacamole-lite: base64(JSON({iv, value})) where
 * `value` is AES-256-CBC of the connection JSON. That is weaker than the
 * AES-GCM tokens in token.ts, so the security properties N-06 asks for are
 * provided by the layer underneath instead:
 *
 *   - **single-use** — the shim accepts exactly one TCP connection, then stops
 *     listening. A replayed token finds nothing to connect to.
 *   - **60s TTL** — the shim closes itself if guacd has not connected in time.
 *   - **host-bound** — a shim only ever proxies to the one address it was
 *     opened for; the token cannot redirect it.
 *
 * So a leaked token is worthless the moment its session starts or its minute
 * elapses, which is the property that actually matters.
 */
import { createServer, type Server } from 'node:http';
import { createCipheriv, randomBytes } from 'node:crypto';
import GuacamoleLite from 'guacamole-lite';

export interface TunnelOptions {
  port: number;
  guacdHost: string;
  guacdPort: number;
  /** Must be exactly 32 bytes for AES-256-CBC. */
  cryptKey: string;
  onLog?: (message: string) => void;
}

export interface GuacConnectionSettings {
  hostname: string;
  port: number;
  username?: string;
  password?: string;
  'ignore-cert'?: boolean;
  security?: string;
  width?: number;
  height?: number;
  dpi?: number;
  /** R-26: clipboard is enabled by not disabling it; these gate file transfer. */
  'enable-drive'?: boolean;
  'disable-copy'?: boolean;
  'disable-paste'?: boolean;
}

export class GuacTunnel {
  private server: Server | null = null;
  private guac: GuacamoleLite | null = null;
  private readonly key: Buffer;

  constructor(private readonly opts: TunnelOptions) {
    // guacamole-lite requires a key of exactly the cipher's length.
    this.key = Buffer.alloc(32);
    Buffer.from(opts.cryptKey, 'utf8').copy(this.key, 0, 0, 32);
  }

  start(): void {
    if (this.server) return;

    this.server = createServer();
    this.guac = new GuacamoleLite(
      { server: this.server, path: '/guac' },
      { host: this.opts.guacdHost, port: this.opts.guacdPort },
      {
        crypt: { cypher: 'AES-256-CBC', key: this.key.toString('utf8') },
        log: {
          level: 'NORMAL',
          stdLog: (...args: unknown[]) => this.opts.onLog?.(args.join(' ')),
          errorLog: (...args: unknown[]) => this.opts.onLog?.(`ERROR ${args.join(' ')}`),
        },
      },
    );

    // Loopback only — this tunnel reaches every managed desktop.
    this.server.listen(this.opts.port, '127.0.0.1');
  }

  stop(): void {
    this.guac?.close();
    this.server?.close();
    this.server = null;
    this.guac = null;
  }

  /**
   * Encode a connection in the format guacamole-lite expects on `?token=`.
   */
  encodeToken(protocol: 'rdp' | 'vnc', settings: GuacConnectionSettings): string {
    const iv = randomBytes(16);
    const cipher = createCipheriv('AES-256-CBC', this.key, iv);
    const payload = JSON.stringify({ connection: { type: protocol, settings } });

    let encrypted = cipher.update(payload, 'utf8', 'base64');
    encrypted += cipher.final('base64');

    return Buffer.from(
      JSON.stringify({ iv: iv.toString('base64'), value: encrypted }),
    ).toString('base64');
  }
}

/**
 * Default settings per protocol.
 *
 * `ignore-cert` is on for RDP because managed hosts use self-signed
 * certificates — the mesh is what authenticates the endpoint, not the RDP cert.
 * Clipboard is left enabled (R-26); file transfer via `enable-drive` is not,
 * since it would be an unaudited path onto the host, and `upload_attachment`
 * exists for that and goes through the approval gate.
 */
export function defaultSettings(
  protocol: 'rdp' | 'vnc',
  base: { hostname: string; port: number; username?: string; password?: string },
): GuacConnectionSettings {
  const common: GuacConnectionSettings = {
    ...base,
    width: 1280,
    height: 800,
    dpi: 96,
    'disable-copy': false,
    'disable-paste': false,
    'enable-drive': false,
  };

  if (protocol === 'rdp') {
    return { ...common, 'ignore-cert': true, security: 'any' };
  }
  // VNC has no username; Screen Sharing and TightVNC authenticate by password.
  const { username: _username, ...vnc } = common;
  return vnc;
}

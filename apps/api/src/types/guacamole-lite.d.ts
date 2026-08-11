/**
 * Minimal type declarations for `guacamole-lite`, which ships none.
 *
 * Written by hand rather than reached for with `any` (N-07): these are the only
 * members Fleet Console touches, and typing them means a future upgrade that
 * changes the constructor shape fails at compile time instead of at the first
 * remote-desktop session.
 *
 * Upstream: https://github.com/vadimpronin/guacamole-lite
 */
declare module 'guacamole-lite' {
  import type { Server as HttpServer } from 'node:http';

  interface WebSocketOptions {
    /** Attach to an existing HTTP server. */
    server?: HttpServer;
    /** Or listen standalone on this port. */
    port?: number;
    /** Path the tunnel is served from. */
    path?: string;
  }

  interface GuacdOptions {
    host?: string;
    port?: number;
  }

  interface CryptOptions {
    /** guacamole-lite supports AES-256-CBC. */
    cypher: string;
    /** Must match the cipher's key length exactly. */
    key: string;
  }

  interface LogOptions {
    level?: 'QUIET' | 'ERRORS' | 'NORMAL' | 'VERBOSE' | 'DEBUG';
    stdLog?: (...args: unknown[]) => void;
    errorLog?: (...args: unknown[]) => void;
  }

  interface ClientOptions {
    crypt: CryptOptions;
    log?: LogOptions;
    /** Defaults merged into every connection's settings. */
    connectionDefaultSettings?: Record<string, Record<string, unknown>>;
    /** Query params callers are allowed to override per connection. */
    allowedUnencryptedConnectionSettings?: Record<string, string[]>;
  }

  interface Callbacks {
    processConnectionSettings?: (
      settings: Record<string, unknown>,
      callback: (err: Error | null, settings?: Record<string, unknown>) => void,
    ) => void;
  }

  class GuacamoleLite {
    constructor(
      websocketOptions: WebSocketOptions,
      guacdOptions: GuacdOptions,
      clientOptions: ClientOptions,
      callbacks?: Callbacks,
    );
    close(): void;
    on(event: 'open' | 'close' | 'error', listener: (...args: unknown[]) => void): void;
  }

  export = GuacamoleLite;
}

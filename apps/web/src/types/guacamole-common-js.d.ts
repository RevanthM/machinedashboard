/**
 * Minimal type declarations for `guacamole-common-js`, which ships none.
 *
 * Hand-written rather than `any` (N-07). These are only the members
 * RemoteDesktop.tsx uses; the surface is deliberately small so an upstream
 * change breaks the build rather than a live session.
 *
 * Upstream: https://github.com/apache/guacamole-client (guacamole-common-js)
 */
declare module 'guacamole-common-js' {
  namespace Guacamole {
    interface Status {
      code: number;
      message?: string;
    }

    class Tunnel {}

    class WebSocketTunnel extends Tunnel {
      constructor(url: string);
    }

    class HTTPTunnel extends Tunnel {
      constructor(url: string, crossDomain?: boolean);
    }

    class Display {
      getElement(): HTMLElement;
      getWidth(): number;
      getHeight(): number;
      scale(scale: number): void;
    }

    class InputStream {}

    class StringReader {
      constructor(stream: InputStream);
      ontext: ((text: string) => void) | null;
      onend: (() => void) | null;
    }

    namespace Mouse {
      interface State {
        x: number;
        y: number;
        left: boolean;
        middle: boolean;
        right: boolean;
        up: boolean;
        down: boolean;
      }
    }

    class Mouse {
      constructor(element: HTMLElement);
      onmousedown: ((state: Mouse.State) => void) | null;
      onmouseup: ((state: Mouse.State) => void) | null;
      onmousemove: ((state: Mouse.State) => void) | null;
    }

    class Keyboard {
      constructor(element: HTMLElement | Document);
      onkeydown: ((keysym: number) => boolean | void) | null;
      onkeyup: ((keysym: number) => void) | null;
    }

    class Client {
      constructor(tunnel: Tunnel);
      /** Connection state: 3 = CONNECTED, 5 = DISCONNECTED. */
      onstatechange: ((state: number) => void) | null;
      onerror: ((status: Status) => void) | null;
      onclipboard: ((stream: InputStream, mimetype: string) => void) | null;
      onname: ((name: string) => void) | null;
      connect(connectionString?: string): void;
      disconnect(): void;
      getDisplay(): Display;
      sendMouseState(state: Mouse.State): void;
      /** pressed: 1 for keydown, 0 for keyup. */
      sendKeyEvent(pressed: number, keysym: number): void;
      sendSize(width: number, height: number): void;
      createClipboardStream(mimetype: string): OutputStream;
    }

    class OutputStream {
      sendEnd(): void;
    }
  }

  export = Guacamole;
}

import { vi } from "vite-plus/test";

import { closeWhenTestEnds } from "./open-sockets.ts";
import { routed } from "./sign-in.ts";

// A portable host page's `WebSocket` (packages/sdk's client-live.ts opens
// one to core per App), reaching core through the router as a browser's
// would, the person's cookies on the upgrade if given (a browser sends
// them whatever the page does).

/** Where a portable host's page runs: another site than the deployment. */
export const hostOrigin = "https://notes.elsewhere.test";

/** One socket the host's page opened, as the browser shows it. */
export interface HostSocket {
  readonly url: string;
  /** Its close code, once closed. */
  code: number | undefined;
}

/**
 * Stubs the page's `WebSocket`: every socket it opens reaches core's
 * route for its path. Answers the sockets opened, and a switch that makes
 * new ones fail to connect, as with the network down.
 */
export const hostSockets = ({ cookie }: { cookie?: string } = {}) => {
  const sockets: HostSocket[] = [];
  const network = { down: false };
  class BrowserSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = 0;
    binaryType = "blob";
    readonly #seen: HostSocket;
    #socket: WebSocket | undefined;

    constructor(url: string) {
      super();
      this.#seen = { url, code: undefined };
      sockets.push(this.#seen);
      void this.#open(new URL(url));
    }

    async #open(url: URL): Promise<void> {
      if (network.down) {
        await Promise.resolve();
        this.readyState = 3;
        this.dispatchEvent(new Event("error"));
        return;
      }
      const response = await routed(url.pathname, {
        headers: {
          Upgrade: "websocket",
          Origin: hostOrigin,
          ...(cookie === undefined ? {} : { cookie }),
        },
      });
      const socket = response.webSocket;
      if (!socket) {
        this.readyState = 3;
        this.dispatchEvent(new Event("error"));
        return;
      }
      if (this.readyState === 3) {
        // Closed by the page while it connected: never opened, as in a
        // browser, and core's end closed too.
        socket.accept();
        socket.close(1000, "Closed while connecting");
        const code = this.#seen.code ?? 1000;
        this.dispatchEvent(new CloseEvent("close", { code }));
        return;
      }
      socket.addEventListener("message", (event) => {
        const data = typeof event.data === "string" ? event.data : "";
        this.dispatchEvent(new MessageEvent("message", { data }));
      });
      socket.addEventListener("close", (event) => {
        this.readyState = 3;
        this.#seen.code ??= event.code;
        this.dispatchEvent(
          new CloseEvent("close", { code: event.code, reason: event.reason })
        );
      });
      socket.accept();
      closeWhenTestEnds(socket);
      this.#socket = socket;
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }

    send(data: string): void {
      this.#socket?.send(data);
    }

    close(code = 1000, reason = ""): void {
      this.#seen.code ??= code;
      this.readyState = 3;
      this.#socket?.close(code, reason);
    }
  }
  vi.stubGlobal("WebSocket", BrowserSocket);
  return { sockets, network };
};

import { portTransport } from "@grasp-os/shared/page-port";
import { RpcSession } from "capnweb";
import { vi } from "vite-plus/test";

// For tests: the page's own connection to core, a WebSocket, stood in for
// by a message port with `core` on its other end over a real Cap'n Web
// session, so what the page asks core (a frame's own link, tab-link.ts)
// reaches a test's core as it would the real one. Undone by
// `vi.unstubAllGlobals()`.

/** Answers each WebSocket the page opens with `core`, over a session of its own. */
export const socketsTo = (
  core: ConstructorParameters<typeof RpcSession>[1]
): void => {
  class Socket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    readonly readyState = Socket.OPEN;
    binaryType = "arraybuffer";
    readonly #port: MessagePort;

    constructor() {
      super();
      const { port1, port2 } = new MessageChannel();
      // oxlint-disable-next-line no-new -- the session serves core's side
      new RpcSession(portTransport(port1), core);
      port2.addEventListener("message", (event: MessageEvent<unknown>) => {
        this.dispatchEvent(new MessageEvent("message", { data: event.data }));
      });
      port2.start();
      this.#port = port2;
    }

    send(message: string): void {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a port has no target origin
      this.#port.postMessage(message);
    }

    close(): void {
      this.#port.close();
    }
  }
  vi.stubGlobal("WebSocket", Socket);
};

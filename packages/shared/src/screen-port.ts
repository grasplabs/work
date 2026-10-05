// How a screen's frame and its page talk over the frame's `MessagePort`:
// each Cap'n Web message as its JSON text. Cap'n Web's own port transport
// hands values over as they are (structured clone), which has no size to
// measure; text does, so the page's limit on a message's size
// (`screenLimits.rpc`) holds for exactly what the frame sent.

/** What Cap'n Web needs of a transport that carries text. */
export interface TextTransport {
  send: (message: string) => void;
  receive: () => Promise<string>;
  abort: (reason: unknown) => void;
}

/** What `null` on the port means: the other side ended the session. */
const closedByPeer = (): Error => new Error("The other side closed the port.");

/**
 * Carries Cap'n Web's messages over `port` as text. Anything but text
 * ends the session: the other side doesn't speak this.
 */
export const portTransport = (port: MessagePort): TextTransport => {
  const received: string[] = [];
  let failure: Error | undefined;
  let waiting:
    | { resolve: (message: string) => void; reject: (error: Error) => void }
    | undefined;

  const fail = (error: Error): void => {
    failure ??= error;
    waiting?.reject(failure);
    waiting = undefined;
  };

  port.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (failure !== undefined) {
      return;
    }
    if (typeof event.data !== "string") {
      fail(
        event.data === null
          ? closedByPeer()
          : new TypeError("A message on the port wasn't text.")
      );
      return;
    }
    if (waiting === undefined) {
      received.push(event.data);
      return;
    }
    waiting.resolve(event.data);
    waiting = undefined;
  });
  port.addEventListener("messageerror", () => {
    fail(new Error("A message on the port couldn't be read."));
  });
  port.start();

  return {
    send: (message) => {
      if (failure !== undefined) {
        throw failure;
      }
      port.postMessage(message);
    },
    receive: async () => {
      const next = received.shift();
      if (next !== undefined) {
        return next;
      }
      if (failure !== undefined) {
        throw failure;
      }
      // oxlint-disable-next-line promise/avoid-new -- a message event has no promise form
      return await new Promise<string>((resolve, reject) => {
        waiting = { resolve, reject };
      });
    },
    abort: (reason) => {
      try {
        port.postMessage(null);
      } catch {
        // Already closed: there is no one to tell.
      }
      port.close();
      fail(reason instanceof Error ? reason : closedByPeer());
    },
  };
};

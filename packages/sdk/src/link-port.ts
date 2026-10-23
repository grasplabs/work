import type {
  FrameLinkMessage,
  PageLinkMessage,
} from "@grasp-os/shared/app-link-limits";

import type { LinkTransport } from "./client-links.ts";

// The frame's side of its link port (spec 10.7.7): how the session client
// in a screen's frame asks the page to open a link. The frame sends the
// resource and the URL; the page, which alone reaches core and opens
// anything, answers each call by its number with whether it opened it.
// What the page says is trusted as everything else it says to the frame
// is; the frame never gets the window, nor anything of the page loaded.

/** A refusal the page answered, with its code. */
const refused = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

/** The link transport of a frame whose page listens on `port`. */
export const portLinkTransport = (port: MessagePort): LinkTransport => {
  const pending = new Map<number, (message: PageLinkMessage) => void>();
  let calls = 0;
  port.addEventListener("message", (event: MessageEvent<PageLinkMessage>) => {
    const message = event.data;
    const settle = pending.get(message.call);
    if (settle !== undefined) {
      pending.delete(message.call);
      settle(message);
    }
  });
  port.start();
  return {
    open: async (resource, url) => {
      calls += 1;
      const call = calls;
      const { promise, resolve, reject } = Promise.withResolvers<null>();
      pending.set(call, (message) => {
        if (message.type === "failed") {
          reject(refused(message.error.code, message.error.message));
        } else {
          resolve(null);
        }
      });
      port.postMessage({
        type: "open",
        call,
        resource,
        url,
      } satisfies FrameLinkMessage);
      await promise;
    },
  };
};

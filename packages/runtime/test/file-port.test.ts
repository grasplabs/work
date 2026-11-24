import { describe, expect, it } from "vite-plus/test";

import { portFileTransport } from "../src/file-port.ts";

// The frame's side of its file port: a call the browser can't send never
// becomes one the frame waits on or stops later, and a call the page
// refuses rejects with the page's code.

describe("a frame's file port", () => {
  it("leaves nothing behind for a call the browser couldn't send", async () => {
    const posted: unknown[] = [];
    const channel = new MessageChannel();
    let refuse = true;
    const port = Object.assign(channel.port1, {
      postMessage: (message: unknown) => {
        if (refuse) {
          refuse = false;
          throw new DOMException("Can't be cloned.", "DataCloneError");
        }
        posted.push(message);
      },
    });
    const transport = portFileTransport(port);
    const stop = new AbortController();
    try {
      await expect(
        transport.read("attachments", "file", stop.signal)
      ).rejects.toThrow("Can't be cloned.");
      // Stopping it afterwards sends nothing: there is no call to stop.
      stop.abort();
      expect(posted).toStrictEqual([]);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });

  it("rejects a call the page refuses with the page's code", async () => {
    const channel = new MessageChannel();
    const host = channel.port2;
    host.addEventListener("message", (event: MessageEvent<unknown>) => {
      const { data } = event;
      const call =
        typeof data === "object" && data !== null && "call" in data
          ? data.call
          : undefined;
      const refusal = {
        type: "failed",
        call,
        error: {
          code: "file.gesture_required",
          message: "Click to download.",
        },
      };
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a port has no target origin
      host.postMessage(refusal);
    });
    host.start();
    const transport = portFileTransport(channel.port1);
    try {
      await expect(
        transport.download("attachments", "file", new AbortController().signal)
      ).rejects.toMatchObject({ code: "file.gesture_required" });
    } finally {
      channel.port1.close();
      host.close();
    }
  });
});

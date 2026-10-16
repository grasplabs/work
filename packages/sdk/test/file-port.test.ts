import { describe, expect, it } from "vite-plus/test";

import { portFileTransport } from "../src/file-port.ts";

// The frame's side of its file port: a call the browser can't send never
// becomes one the frame waits on or stops later.

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
});

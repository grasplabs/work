import { describe, expect, it } from "vite-plus/test";

import { fileChannel } from "../src/file-channel.ts";

// A screen's file channel, through the page's own fetch: its requests stop
// when they're cancelled, also while they wait for the person to name.

describe("a screen's file channel", () => {
  it("stops a request that waits for its person once it's cancelled, sending nothing", async () => {
    const sent: string[] = [];
    const never = Promise.withResolvers<string>();
    const channel = fileChannel({
      app: "app",
      lease: "lease",
      // The page's connection is coming back, and doesn't yet.
      person: async () => await never.promise,
      fetch: async (path) => {
        sent.push(path);
        return await Promise.resolve(Response.json({}));
      },
    });
    const cancel = new AbortController();
    const asked = channel.describe("attachments", "file", cancel.signal);
    cancel.abort(new Error("Cancelled."));

    await expect(asked).rejects.toThrow("Cancelled.");
    expect(sent).toStrictEqual([]);
  });

  it("asks for no person for a request already cancelled, leaving no rejection unhandled", async () => {
    let asked = 0;
    const channel = fileChannel({
      app: "app",
      lease: "lease",
      // The screen has closed: its link refuses to name anyone.
      person: async () => {
        asked += 1;
        return await Promise.reject(new Error("The link is closed."));
      },
      fetch: async () => await Promise.resolve(Response.json({})),
    });
    const cancel = new AbortController();
    cancel.abort(new Error("Cancelled."));

    await expect(
      channel.describe("attachments", "file", cancel.signal)
    ).rejects.toThrow("Cancelled.");
    expect(asked).toBe(0);
  });
});

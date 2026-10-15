import { describe, expect, it } from "vite-plus/test";

import type { Session } from "../core.ts";
import { retryingOn } from "./core-link.ts";

// A frame's call on its connection (core-link.ts `retryingOn`): what
// stops while the session is on its way, such as a frame that left the
// tab's connection, sends nothing once the session is there.

describe("a frame's call on its connection", () => {
  it("sends nothing once the frame left while its session was on its way", async () => {
    let open = true;
    const sent: string[] = [];
    // SAFETY: the session is only handed on, never used here.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const session = {} as Session;
    const call = retryingOn(
      async () => {
        await Promise.resolve();
        // The frame leaves in the moment the session arrives.
        open = false;
        return session;
      },
      async () => {
        sent.push("open");
        return await Promise.resolve("opened");
      },
      () => open
    );

    await expect(call).rejects.toThrow(Error);
    expect(sent).toStrictEqual([]);
  });
});

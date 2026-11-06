import { describe, expect, it } from "vite-plus/test";

import { GraspClient } from "../src/client-core.ts";

// Leaving the App while a form holds unsaved edits (spec 10.7.7): the
// session client tells the host whether anything does, so the host
// confirms once before it leaves. Moving between the App's own routes is
// its router's, in the frame, and never asks the host.

describe("leaving the App with unsaved edits", () => {
  it("tells the host once whether anything holds unsaved edits, each time that changes", () => {
    const guards: boolean[] = [];
    const client = new GraspClient({
      call: async () => {
        await Promise.resolve();
        throw new Error("Nothing here calls the App.");
      },
      watch: async () => {
        await Promise.resolve();
        throw new Error("Nothing here follows a query.");
      },
      leaveGuard: (guarded) => {
        guards.push(guarded);
      },
    });
    const first = {};
    const second = {};
    client.guardLeave(first, true);
    client.guardLeave(second, true);
    client.guardLeave(first, false);
    client.guardLeave(first, false);
    client.guardLeave(second, false);
    client.guardLeave(second, true);
    expect(guards).toStrictEqual([true, false, true]);
  });
});

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { shownWaits } from "../src/workflows/run-waits.ts";
import type { Pending } from "../src/workflows/run-waits.ts";

// Which of a run's open waits a screen is shown: names the run's code chose
// are never shown, so nothing it read reaches a screen through one.

const key = "0123456789abcdef";
const openedAt = 1000;
const deadline = 61_000;

const pendingOf = (
  ordinal: number,
  name: string,
  type: Pending["type"] = "sleep"
): Pending => ({ ordinal, type, name, openedAt, deadline });

const declared = new Set(["hold"]);

describe("the waits a screen is shown of a run", () => {
  it("shows a declared task's sleep and leaves out an undeclared task and a step named by the run's code", () => {
    expect(
      shownWaits(
        [
          pendingOf(1, "task:hold"),
          pendingOf(2, "task:undeclared"),
          pendingOf(3, "ada@example.com"),
          pendingOf(4, "invoice 4711 for Acme", "retry"),
        ],
        declared
      ).map((wait) => z.object({ taskId: z.string() }).parse(wait).taskId)
    ).toStrictEqual(["hold"]);
  });

  it("shows a held step once, named by its place in the journal, never by the hash of the step's name", () => {
    expect(
      shownWaits(
        [
          pendingOf(5, `$grasp:wait:${key}:held:0:0`, "waitForEvent"),
          pendingOf(6, `$grasp:wait:${key}:held:0:1:check`, "retry"),
        ],
        declared
      ).map((wait) =>
        z.object({ id: z.string(), reason: z.string() }).parse(wait)
      )
    ).toStrictEqual([{ id: "hold-5", reason: "policy" }]);
  });

  it("shows a held step retrying its run again as a retry, not as waiting for confirmation", () => {
    expect(
      shownWaits(
        [pendingOf(7, `$grasp:wait:${key}:held:2:run`, "retry")],
        declared
      )
    ).toStrictEqual([
      {
        id: "wait-7",
        taskId: "$run",
        key: "$run",
        title: "Retrying a step",
        openedAt,
        deadline,
        kind: "timer",
        purpose: "retry",
      },
    ]);
  });
});

import { expect } from "@playwright/test";

import { callGate } from "./call-gate.ts";
import { test } from "./csp.ts";
import { peopleIn } from "./people.ts";

// A decision's page when core never answers: it says so rather than
// loading forever.

/**
 * How long a decision page may take to show what core said. It reads core
 * up to twice first (who is signed in, then the decision), each read
 * within 5 seconds of its own (apps/web/src/core.ts), so the default
 * 5-second wait is shorter than the page's. An answer, on a connection
 * opened for it, gets the same room.
 */
const pageRead = { timeout: 15_000 };

test("says core can't be reached when a decision never loads", async ({
  pageOf,
}) => {
  const { decider } = peopleIn("decisionUnreachable");
  const page = await pageOf(decider);
  const gate = await callGate(page, '["decisions","get"]');
  gate.hold();
  await page.goto(`/decisions/${crypto.randomUUID()}`);
  await expect(
    page.getByText("Grasp can't be reached right now. Try again in a moment.")
  ).toBeVisible(pageRead);
  expect(gate.stalled()).toBe(1);
});

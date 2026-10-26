import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { findApp } from "../../src/apps.ts";
import {
  activation,
  appWith,
  envWith,
  heldPlace,
  passing,
  suiteOf,
} from "./app-test-harness.ts";

// An App's tests on-prem, as core runs them when a version is made
// current: each suite in a sandbox session of its own (app-tests.ts), with
// `SANDBOX_HOST` bound to the sandbox supervisor this project starts. Its
// two processes give each owner one session at a time.

/** Passes on the refusal it gets while the App's calls have no place. */
const catching = suiteOf(`
      await t.rejectsCode(owner.query(api.notes.list, page), "operation.sandbox_busy");
`);

/** What a suite stopped past its CPU time fails with. */
const stoppedOnCpu = /^tests\/notes\.test\.ts: it stopped: .*CPU time/u;

/** Three calls at once, and a live query read again as they write. */
const parallel = suiteOf(`
      const live = await owner.subscribe(api.notes.list, page);
      const ids = await Promise.all([
        owner.mutation(api.notes.create, { title: "One" }),
        owner.mutation(api.notes.create, { title: "Two" }),
        owner.mutation(api.notes.create, { title: "Three" }),
      ]);
      const lists = await Promise.all([
        owner.query(api.notes.list, page),
        owner.query(api.notes.list, page),
        owner.query(api.notes.list, page),
      ]);
      t.equal(lists.map((list) => list.items.length), [3, 3, 3]);
      await live.next((found) => ids.every((id) => found.items.some((note) => note._id === id)));
      await live.close();
`);

/** Catches the refusal it gets while the App's calls have no place, then spins. */
const refusedThenStopped = suiteOf(`
      await owner.query(api.notes.list, page).catch(() => null);
      for (;;) {}
`);

/** Spins in a test, past any CPU time. */
const spinning = suiteOf("for (;;) {}");

describe("an App's tests on-prem", { timeout: 180_000 }, () => {
  it("make the version current when they pass, a live query included", async () => {
    await expect(activation(await appWith(passing))).resolves.toBe(1);
  });

  it("make the version current with three calls at once and a live query", async () => {
    await expect(activation(await appWith(parallel))).resolves.toBe(1);
  });

  it("fail a suite whose test spins on its CPU time, while core keeps serving", async () => {
    const built = await appWith(spinning);
    let slowest = 0;
    const done = new AbortController();
    const watching = (async () => {
      while (!done.signal.aborted) {
        const asked = Date.now();
        // oxlint-disable-next-line no-await-in-loop -- one look at a time
        await env.DB.prepare("SELECT 1").first();
        // oxlint-disable-next-line no-await-in-loop -- one look at a time
        await scheduler.wait(100);
        slowest = Math.max(slowest, Date.now() - asked - 100);
      }
    })();
    const outcome = await activation(built);
    done.abort();
    await watching;
    expect(outcome).toStrictEqual({
      code: "version.tests_failed",
      failures: [expect.stringMatching(stoppedOnCpu)],
    });
    // Core answered throughout, as the spin ran in the sandbox's process.
    expect(slowest).toBeLessThan(2000);
    await expect(findApp(env, built.app)).resolves.toMatchObject({
      currentVersion: null,
    });
  });

  it.each([
    ["a failure", passing],
    ["a pass", catching],
  ])(
    "take %s after the sandbox refused a test's call for want of a place as the sandbox's",
    async (_, suite) => {
      const built = await appWith(suite);
      // The App's own calls at their share: the function the test calls
      // finds no place, and the test fails for it.
      const giveUp = new AbortController();
      const { ended: held } = await heldPlace(built.app, giveUp.signal);
      try {
        await expect(activation(built)).resolves.toBe("unavailable");
      } finally {
        giveUp.abort();
        await held;
      }
      await expect(findApp(env, built.app)).resolves.toMatchObject({
        currentVersion: null,
      });
    }
  );

  it("take a suite stopped after the sandbox refused a test's call as the sandbox's", async () => {
    const built = await appWith(refusedThenStopped);
    const giveUp = new AbortController();
    const { ended: held } = await heldPlace(built.app, giveUp.signal);
    try {
      // A suite stops 8 seconds in: past the refusal, which waits 3.
      await expect(
        activation(built, envWith({ APP_TEST_LIMITS_MS: "20000/8000" }))
      ).resolves.toBe("unavailable");
    } finally {
      giveUp.abort();
      await held;
    }
  });
});

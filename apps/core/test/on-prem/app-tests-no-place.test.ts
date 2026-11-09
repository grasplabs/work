import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { findApp } from "../../src/apps.ts";
import { activation, appWith, heldPlace, passing } from "./app-test-harness.ts";
import { catching } from "./app-tests-suites.ts";

// An App's tests on-prem, as core runs them when a version is made
// current: each suite in a sandbox session of its own (app-tests.ts), with
// `SANDBOX_HOST` bound to the sandbox supervisor this project starts. Its
// two processes give each owner one session at a time.

describe("an App's tests on-prem", { timeout: 180_000 }, () => {
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
});

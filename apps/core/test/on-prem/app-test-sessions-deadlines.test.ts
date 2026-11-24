import { describe, expect, it } from "vite-plus/test";

import { appTestOwnerOf } from "../../src/app-tests.ts";
import { sandboxOwnerHeader } from "../../src/sandbox-headers.ts";
import {
  activation,
  appWith,
  envWith,
  suiteOf,
  supervisor,
} from "./app-test-harness.ts";
import { slowToAdmit } from "./app-test-sessions-harness.ts";

// An App's tests on-prem, as in app-tests.test.ts: here a suite waiting
// for its place in the sandbox supervisor, and the session a suite's code
// runs in. Apart from app-tests.test.ts so the two can run on different
// runners.

describe("an App's tests on-prem", { timeout: 180_000 }, () => {
  it("run no suite that got its place after the run's time was up", async () => {
    const built = await appWith(suiteOf("expect(1).toBe(1);"));
    // The sandbox answers the suite's ask for a place only once the run's
    // time is surely up: the run starts before the suite asks, so its
    // second is over a second after the ask, whatever the build took.
    const runMs = 1000;
    const admitting = slowToAdmit(appTestOwnerOf(built.app), runMs + 1000);
    await expect(
      activation(
        built,
        envWith({
          APP_TEST_LIMITS_MS: `20000/60000/${runMs}`,
          SANDBOX_HOST: admitting.host,
        })
      )
    ).resolves.toBe("unavailable");
    expect(admitting.delayed()).toBe(1);
  });

  it("start no ask for a suite's place that could still wait past the run's time", async () => {
    const built = await appWith(suiteOf("expect(1).toBe(1);"));
    // Every ask for the suite's place refused at once (`busy`), each
    // one's start noted: an ask may wait up to 6 s in the supervisor
    // (2 × its 3 s), so none may start later than 6 s before the end.
    const runMs = 20_000;
    const askMs = 6000;
    const asks: number[] = [];
    const refusing: Fetcher = {
      ...supervisor(),
      fetch: async (input, init) => {
        const headers: unknown = init?.headers;
        const of: unknown =
          typeof headers === "object" && headers !== null
            ? Reflect.get(headers, sandboxOwnerHeader)
            : undefined;
        if (
          of === appTestOwnerOf(built.app) &&
          new URL(input instanceof Request ? input.url : input).pathname ===
            "/session"
        ) {
          asks.push(Date.now());
          return new Response(null, { status: 429 });
        }
        return await supervisor().fetch(input, init);
      },
    };
    const outcome = await activation(
      built,
      envWith({
        APP_TEST_LIMITS_MS: `20000/60000/${runMs}`,
        SANDBOX_HOST: refusing,
      })
    );
    const [first = 0] = asks;
    const last = asks.at(-1) ?? 0;
    expect({
      outcome,
      askedAgain: asks.length > 1,
      lastStartedInTime: last - first <= runMs - askMs,
      gaveUpInTime: Date.now() - first < runMs,
    }).toStrictEqual({
      outcome: "unavailable",
      askedAgain: true,
      lastStartedInTime: true,
      gaveUpInTime: true,
    });
  });
});

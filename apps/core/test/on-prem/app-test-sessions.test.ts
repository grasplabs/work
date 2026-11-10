import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Release } from "../../src/app-releases.ts";
import {
  appTestOwnerOf,
  fixtureHostFor,
  suiteCapability,
} from "../../src/app-tests.ts";
import { releaseIdsOf } from "../../src/apps.ts";
import { runInSession } from "../../src/sandbox-session.ts";
import {
  activation,
  appWith,
  envWith,
  heldPlace,
  host,
  passing,
  suiteOf,
} from "./app-test-harness.ts";
import {
  notesRelease,
  requestFor,
  slowToAdmit,
} from "./app-test-sessions-harness.ts";

// An App's tests on-prem, as in app-tests.test.ts: here a suite waiting
// for its place in the sandbox supervisor, and the session a suite's code
// runs in. Apart from app-tests.test.ts so the two can run on different
// runners.

/**
 * What `body` answers, run as a suite's code would be in a session of its
 * own, over `host` as a suite gets it (`suiteCapability`), as `numbered`,
 * with `values` after it.
 */
const inSuiteSession = async (
  release: Release,
  body: string,
  { values = [], lingerMs }: { values?: unknown[]; lingerMs?: number } = {}
): Promise<{ answer: unknown; opened: readonly string[] }> => {
  if (host === undefined) {
    throw new Error("These tests run with SANDBOX_HOST bound.");
  }
  const suiteHost = fixtureHostFor(
    env,
    release,
    await releaseIdsOf(env, release),
    {
      parent: () => {},
    }
  );
  try {
    const answer = await runInSession(host, {
      mainModule: "probe.js",
      modules: {
        "probe.js": `import { WorkerEntrypoint } from "cloudflare:workers";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export class Probe extends WorkerEntrypoint {
  async run(numbered, ...values) {
    ${body}
  }
}
`,
      },
      entrypoint: "Probe",
      method: "run",
      args: [
        { capability: suiteCapability(suiteHost) },
        ...values.map((value) => ({ value })),
      ],
      owner: appTestOwnerOf(release.manifest.resourceId),
      cpuMs: 30_000,
      wallMs: 30_000,
      ...(lingerMs === undefined ? {} : { lingerMs }),
    });
    return { answer, opened: [...suiteHost.opened] };
  } finally {
    await suiteHost.closeAll();
  }
};

describe("an App's tests on-prem", { timeout: 180_000 }, () => {
  it("ask again while the sandbox has no place for a suite, then run it", async () => {
    const built = await appWith(passing);
    const giveUp = new AbortController();
    const { ended: held } = await heldPlace(
      appTestOwnerOf(built.app),
      giveUp.signal
    );
    const activating = activation(built);
    // Past the first ask's wait for a place, which hears it's busy.
    await scheduler.wait(6000);
    giveUp.abort();
    await expect(held).resolves.toBe("given up");
    await expect(activating).resolves.toBe(1);
  });

  it("give a suite its time from when it has a place, not while it waits for one", async () => {
    const built = await appWith(suiteOf("expect(1).toBe(1);"));
    // The sandbox answers the suite's ask for a place a second after the
    // suite's own time would be up, were it counted from the ask.
    const suiteMs = 5000;
    const admitting = slowToAdmit(appTestOwnerOf(built.app), suiteMs + 1000);
    await expect(
      activation(
        built,
        envWith({
          APP_TEST_LIMITS_MS: `20000/${suiteMs}`,
          SANDBOX_HOST: admitting.host,
        })
      )
    ).resolves.toBe(1);
    expect(admitting.delayed()).toBe(1);
  });

  it("refuse a session a suite wasn't answered: forged, or no number", async () => {
    const { answer } = await inSuiteSession(
      await notesRelease(),
      `const said = [];
    const real = await numbered.open("real");
    const owner = JSON.stringify({ name: "note-owner", role: "user", teams: [] });
    for (const id of [real + 7, String(real), real + 0.5, -1, null]) {
      try {
        await numbered.identify(id, owner);
        said.push("answered");
      } catch (error) {
        said.push(error.message);
      }
    }
    said.push((await numbered.identify(real, owner)) ?? "known");
    await numbered.close(real);
    return said;`
    );
    const refused = "No test of this suite was opened as that session.";
    expect(answer).toStrictEqual([
      refused,
      refused,
      refused,
      refused,
      refused,
      "known",
    ]);
  });

  // Two things refuse it: the sandbox host lets go of the call's
  // capabilities as it returns, and core's forwarder refuses once the call
  // is over (`sessionForwarder`). Keep either and it's refused; drop both
  // and the late call opens a test.
  it("refuse a suite's call once its session's call is over", async () => {
    const { answer, opened } = await inSuiteSession(
      await notesRelease(),
      `const kept = numbered.dup();
    this.ctx.waitUntil(scheduler.wait(300).then(() => kept.open("late")).catch(() => null));
    return "answered";`,
      { lingerMs: 1500 }
    );
    expect({ answer, opened }).toStrictEqual({
      answer: "answered",
      opened: [],
    });
  });

  it("let go of a live query's callbacks a test left open before its process ends", async () => {
    const release = await notesRelease();
    const { answer } = await inSuiteSession(
      release,
      `const [request] = values;
    const released = [];
    const session = await numbered.open("left-open");
    await numbered.identify(session, JSON.stringify({ name: "note-owner", role: "user", teams: [] }));
    const callback = (name) =>
      Object.assign(() => undefined, {
        [Symbol.dispose]: () => {
          released.push(name);
        },
      });
    const answer = await numbered.subscribe(session, "note-owner", request, callback("snapshot"), callback("lost"));
    await numbered.close(session);
    for (let waited = 0; released.length < 2 && waited < 5000; waited += 100) {
      await wait(100);
    }
    return { subscribed: "subscription" in answer, released: released.toSorted() };`,
      {
        values: [
          requestFor(release, "notes.list", { pagination: { pageSize: 50 } }),
        ],
      }
    );
    expect(answer).toStrictEqual({
      subscribed: true,
      released: ["lost", "snapshot"],
    });
  });
});

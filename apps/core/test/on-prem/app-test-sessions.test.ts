import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { activateVersion } from "../../src/app-activation.ts";
import { loadRelease, sealRelease } from "../../src/app-releases.ts";
import type { Release } from "../../src/app-releases.ts";
import {
  appTestOwnerOf,
  fixtureHostFor,
  suiteCapability,
} from "../../src/app-tests.ts";
import {
  commitFiles,
  createApp,
  findApp,
  setCurrentVersion,
} from "../../src/apps.ts";
import { createStore } from "../../src/data-stores.ts";
import { platformPlaceWaitMs } from "../../src/platform-sandbox.ts";
import {
  sandboxOwnerHeader,
  sandboxSubOwnerHeader,
} from "../../src/sandbox-headers.ts";
import { runInSession } from "../../src/sandbox-session.ts";
import { SandboxUnavailableError } from "../../src/sandboxed.ts";
import { runOwnerOf } from "../../src/workflows/code.ts";
import { person } from "../sealed-apps.ts";
import {
  activation,
  appFiles,
  appWith,
  envWith,
  heldPlace,
  host,
  passing,
  suiteOf,
  supervisor,
} from "./app-test-harness.ts";

// An App's tests on-prem, as in app-tests.test.ts: here a suite waiting
// for its place in the sandbox supervisor, and the session a suite's code
// runs in. Apart from app-tests.test.ts so the two can run on different
// runners.

/**
 * The supervisor, but answering each ask for a session of `owner`'s only
 * `ms` later: a place granted that long after it was asked for, however
 * fast or slow the machine. Says how many asks it held back.
 */
const slowToAdmit = (
  owner: string,
  ms: number
): { host: Fetcher; delayed: () => number } => {
  let delayed = 0;
  return {
    host: {
      ...supervisor(),
      fetch: async (input, init) => {
        const headers: unknown = init?.headers;
        const of: unknown =
          typeof headers === "object" && headers !== null
            ? Reflect.get(headers, sandboxOwnerHeader)
            : undefined;
        if (
          of === owner &&
          new URL(input instanceof Request ? input.url : input).pathname ===
            "/session"
        ) {
          delayed += 1;
          await scheduler.wait(ms);
        }
        return await supervisor().fetch(input, init);
      },
    },
    delayed: () => delayed,
  };
};

/** The Notes App made current with no suites: a release to open hosts on. */
const notesRelease = async (): Promise<Release> => {
  const owner = await person("builder");
  const { id } = await createApp(env, owner, { name: "Notes" });
  await commitFiles(env, owner, id, appFiles, "First version");
  await activateVersion(env, owner, id, 1);
  return await loadRelease(env, id, 1);
};

/** `release`'s function `path` called with `input`, as a test's call names it. */
const requestFor = (release: Release, path: string, input: unknown): string =>
  JSON.stringify({
    reference: {
      resourceId: release.manifest.resourceId,
      resourceVersion: release.manifest.resourceVersion,
      contractId: path,
      fingerprint: release.fingerprints[path],
      kind: release.app.operations[path]?.kind,
    },
    input,
  });

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
  const suiteHost = fixtureHostFor(env, release, appFiles, {
    parent: () => {},
  });
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
    const built = await appWith(suiteOf("t.equal(1, 1);"));
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

  it("run no suite that got its place after the run's time was up", async () => {
    const built = await appWith(suiteOf("t.equal(1, 1);"));
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

  it("ask again for the builder's place while the App's builds hold it past one build's wait", async () => {
    // Files no build was made of yet, sealed before the builder is held.
    const built = await appWith(
      suiteOf(`t.equal(1, 1); // ${crypto.randomUUID()}`)
    );
    await sealRelease(env, {
      app: built.app,
      version: 1,
      store: await createStore(env, built.owner),
      by: built.owner,
    });
    // The App's builds hold its part of the builder's share. It frees
    // only once the test build asked again after one build's own asks
    // for a place were over: asked again by activation, not by the build.
    const giveUp = new AbortController();
    const { ended: held } = await heldPlace(
      "platform:builder",
      giveUp.signal,
      built.app
    );
    let firstAsk: number | undefined;
    const askedAgain = Promise.withResolvers<null>();
    const watching: Fetcher = {
      ...supervisor(),
      fetch: async (input, init) => {
        const headers: unknown = init?.headers;
        const of: unknown =
          typeof headers === "object" && headers !== null
            ? Reflect.get(headers, sandboxSubOwnerHeader)
            : undefined;
        if (of === built.app) {
          firstAsk ??= Date.now();
          if (Date.now() - firstAsk > platformPlaceWaitMs) {
            askedAgain.resolve(null);
          }
        }
        return await supervisor().fetch(input, init);
      },
    };
    const activating = (async (): Promise<unknown> => {
      try {
        await setCurrentVersion(
          envWith({ SANDBOX_HOST: watching }),
          built.owner,
          built.app,
          1
        );
        const found = await findApp(env, built.app);
        return found?.currentVersion;
      } catch (error) {
        return error instanceof SandboxUnavailableError
          ? "unavailable"
          : String(error);
      }
    })();
    // Never asked again: freed anyway, the activation having given up.
    await Promise.race([
      askedAgain.promise,
      activating,
      scheduler.wait(60_000),
    ]);
    giveUp.abort();
    await expect(held).resolves.toBe("given up");
    await expect(activating).resolves.toBe(1);
  });

  it("start no ask for a suite's place that could still wait past the run's time", async () => {
    const built = await appWith(suiteOf("t.equal(1, 1);"));
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

  it("aren't held up by the App's own runs", async () => {
    const built = await appWith(passing);
    const giveUp = new AbortController();
    const { ended: held } = await heldPlace(
      runOwnerOf(built.app),
      giveUp.signal
    );
    try {
      await expect(activation(built)).resolves.toBe(1);
      // Made current while the run's session still held its place, not
      // once it ended on its CPU time.
      await expect(
        Promise.race([held, Promise.resolve("holding")])
      ).resolves.toBe("holding");
    } finally {
      giveUp.abort();
      await held;
    }
  });

  it("refuse a session a suite wasn't answered: forged, or no number", async () => {
    const { answer } = await inSuiteSession(
      await notesRelease(),
      `const said = [];
    const real = await numbered.open("notes", "real");
    for (const id of [real + 7, String(real), real + 0.5, -1, null]) {
      try {
        await numbered.principal(id, "note-owner");
        said.push("answered");
      } catch (error) {
        said.push(error.message);
      }
    }
    said.push((await numbered.principal(real, "note-owner")) ?? "known");
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
    this.ctx.waitUntil(scheduler.wait(300).then(() => kept.open("notes", "late")).catch(() => null));
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
    const session = await numbered.open("notes", "left-open");
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

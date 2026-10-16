import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { activateVersion } from "../../src/app-activation.ts";
import { appTestOwnerOf } from "../../src/app-tests.ts";
import { commitFiles, createApp, findApp } from "../../src/apps.ts";
import type { Acting } from "../../src/auth/identity.ts";
import { runInSession } from "../../src/sandbox-session.ts";
import { SandboxUnavailableError } from "../../src/sandboxed.ts";
import { runOwnerOf } from "../../src/workflows/code.ts";
import { notesFiles } from "../notes-client-app.ts";
import { person } from "../sealed-apps.ts";

// An App's tests on-prem, as core runs them when a version is made
// current: each suite in a sandbox session of its own (app-tests.ts), with
// `SANDBOX_HOST` bound to the sandbox supervisor this project starts. Its
// two processes give each owner one session at a time.

/** The Notes App, its screens left out, with a fixture. */
const appFiles: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(notesFiles).filter(([path]) => !path.startsWith("screens/"))
  ),
  "tests/fixtures/notes.json": JSON.stringify({
    principals: { "note-owner": { role: "user" } },
  }),
};

/** A suite of one test, `body`, with an owner and a page at hand. */
const suiteOf = (
  body: string
): string => `import { appTest } from "@grasp-os/sdk/testing";
import { api } from "#grasp";

const page = { pagination: { pageSize: 50 } };

export default appTest({
  fixtures: "notes",
  tests: {
    "runs": async (t) => {
      const owner = await t.as("note-owner");
      ${body}
    },
  },
});
`;

/** Creates a note, and reads it back from a call and from a live query. */
const passing = suiteOf(`
      const live = await owner.subscribe(api.notes.list, page);
      const id = await owner.mutation(api.notes.create, { title: "First note" });
      const snapshot = await live.next((found) => found.items.some((note) => note._id === id));
      t.equal(snapshot.items.map((note) => note.title), ["First note"]);
      t.equal((await owner.query(api.notes.list, page)).items.length, 1);
      await live.close();
`);

/** What a suite stopped past its CPU time fails with. */
const stoppedOnCpu = /^tests\/notes\.test\.ts: it stopped: .*CPU time/u;

/** Spins in a test, past any CPU time. */
const spinning = suiteOf("for (;;) {}");

interface Built {
  owner: Acting & Identity;
  app: AppId;
}

/** A builder's App with `suite` as its tests, at version 1. */
const appWith = async (suite: string): Promise<Built> => {
  const owner = await person("builder");
  const { id } = await createApp(env, owner, { name: "Notes" });
  await commitFiles(
    env,
    owner,
    id,
    { ...appFiles, "tests/notes.test.ts": suite },
    "First version"
  );
  return { owner, app: id };
};

/** What making version 1 current did: made it current, or why not. */
const activation = async ({ owner, app }: Built): Promise<unknown> => {
  try {
    await activateVersion(env, owner, app, 1);
    const found = await findApp(env, app);
    return found?.currentVersion;
  } catch (error) {
    if (error instanceof SandboxUnavailableError) {
      return "unavailable";
    }
    if (isExpectedError(error)) {
      return { code: error.code, failures: error.details?.failures };
    }
    throw error;
  }
};

const host = env.SANDBOX_HOST;

/**
 * Holds one of `owner`'s places in the sandbox with a session that spins,
 * until it's given up on (`signal`).
 */
const holdPlace = async (
  owner: string,
  signal: AbortSignal
): Promise<unknown> => {
  if (host === undefined) {
    throw new Error("These tests run with SANDBOX_HOST bound.");
  }
  try {
    return await runInSession(
      host,
      {
        mainModule: "spin.js",
        modules: {
          "spin.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export class Spin extends WorkerEntrypoint { run() { for (;;) {} } }
`,
        },
        entrypoint: "Spin",
        method: "run",
        args: [],
        owner,
        cpuMs: 30_000,
        wallMs: 60_000,
      },
      { signal }
    );
  } catch (error) {
    return signal.aborted ? "given up" : `refused: ${String(error)}`;
  }
};

/** How long a session takes to start, at most, in these tests. */
const startsMs = 1500;

/** `owner`'s place held (`holdPlace`), once it surely is: how it ends. */
const heldPlace = async (
  owner: string,
  signal: AbortSignal
): Promise<{ ended: Promise<unknown> }> => {
  const ended = holdPlace(owner, signal);
  await expect(
    Promise.race([ended, scheduler.wait(startsMs).then(() => "holding")])
  ).resolves.toBe("holding");
  return { ended };
};

describe("an App's tests on-prem", { timeout: 180_000 }, () => {
  it("make the version current when they pass, a live query included", async () => {
    await expect(activation(await appWith(passing))).resolves.toBe(1);
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

  it("take a failure after the sandbox refused a test's call for want of a place as the sandbox's", async () => {
    const built = await appWith(passing);
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
  });
});

import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { expect } from "vite-plus/test";

import { activateVersion } from "../../src/app-activation.ts";
import { commitFiles, createApp, findApp } from "../../src/apps.ts";
import type { Acting } from "../../src/auth/identity.ts";
import { runInSession } from "../../src/sandbox-session.ts";
import { SandboxUnavailableError } from "../../src/sandboxed.ts";
import { notesFiles } from "../notes-client-app.ts";
import { person } from "../sealed-apps.ts";

// What the on-prem tests of an App's tests share (app-tests.test.ts,
// app-test-sessions.test.ts): the Notes App with a suite, making its
// version current, and places held in the sandbox supervisor.

/** The Notes App, its screens left out, with a fixture. */
export const appFiles: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(notesFiles).filter(([path]) => !path.startsWith("screens/"))
  ),
  "tests/fixtures/notes.json": JSON.stringify({
    principals: { "note-owner": { role: "user" } },
  }),
};

/** A suite of one test, `body`, with an owner and a page at hand. */
export const suiteOf = (
  body: string
): string => `import { appTest } from "@grasp-os/sdk/testing";
import { api } from "#grasp";

export const page = { pagination: { pageSize: 50 } };

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
export const passing = suiteOf(`
      const live = await owner.subscribe(api.notes.list, page);
      const id = await owner.mutation(api.notes.create, { title: "First note" });
      const snapshot = await live.next((found) => found.items.some((note) => note._id === id));
      t.equal(snapshot.items.map((note) => note.title), ["First note"]);
      t.equal((await owner.query(api.notes.list, page)).items.length, 1);
      await live.close();
`);

export interface Built {
  owner: Acting & Identity;
  app: AppId;
}

/** A builder's App with `suite` as its tests, at version 1. */
export const appWith = async (suite: string): Promise<Built> => {
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

/** Core's env as code reads it, with `changes` over it; env itself unchanged. */
export const envWith = (changes: Partial<Env>): Env =>
  new Proxy(env, {
    get: (target, key, receiver): unknown =>
      Object.hasOwn(changes, key)
        ? Reflect.get(changes, key)
        : Reflect.get(target, key, receiver),
  });

/** What making version 1 current did: made it current, or why not. */
export const activation = async (
  { owner, app }: Built,
  on: Env = env
): Promise<unknown> => {
  try {
    await activateVersion(on, owner, app, 1);
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

export const host = env.SANDBOX_HOST;

/** The sandbox supervisor these tests run with. */
export const supervisor = (): Fetcher => {
  if (host === undefined) {
    throw new Error("These tests run with SANDBOX_HOST bound.");
  }
  return host;
};

/**
 * Holds one of `owner`'s places in the sandbox with a session that spins,
 * until it's given up on (`signal`).
 */
export const holdPlace = async (
  owner: string,
  signal: AbortSignal,
  subOwner?: string
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
        ...(subOwner === undefined ? {} : { subOwner }),
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
export const startsMs = 1500;

/** `owner`'s place held (`holdPlace`), once it surely is: how it ends. */
export const heldPlace = async (
  owner: string,
  signal: AbortSignal,
  subOwner?: string
): Promise<{ ended: Promise<unknown> }> => {
  const ended = holdPlace(owner, signal, subOwner);
  await expect(
    Promise.race([ended, scheduler.wait(startsMs).then(() => "holding")])
  ).resolves.toBe("holding");
  return { ended };
};

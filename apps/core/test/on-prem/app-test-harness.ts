import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";

import { appKind, createApp, findApp } from "../../src/apps.ts";
import type { Acting } from "../../src/auth/identity.ts";
import { rollback } from "../../src/publish.ts";
import { noPlaceOf, runInSession } from "../../src/sandbox-session.ts";
import { SandboxUnavailableError } from "../../src/sandboxed.ts";
import { appOf, withFiles } from "../app-definitions.ts";
import type { TestApp } from "../app-definitions.ts";
import { commitDefined } from "../apps.ts";
import { notesFiles } from "../notes-client-app.ts";
import { person } from "../sealed-apps.ts";

// What the on-prem tests of an App's tests share (app-tests.test.ts,
// app-test-sessions.test.ts): the Notes App with a suite, making its
// version current, and places held in the sandbox supervisor.

/** The Notes App, its pages left out. */
export const appFiles: TestApp = appOf(
  notesFiles.definition,
  Object.fromEntries(
    Object.entries(notesFiles.files).filter(
      ([path]) => !path.startsWith("src/")
    )
  )
);

/** A suite of one test, `body`, with an owner and a page at hand. */
export const suiteOf = (
  body: string
): string => `import { appTest } from "@grasp-os/sdk/testing";
import { ${["api", "workflows"].filter((name) => body.includes(`${name}.`)).join(", ")} } from "@server/_generated/api";
${body.includes("expect(") ? 'import { expect } from "vitest";' : ""}
import schema from "../server/schema.ts";

export const page = { pagination: { pageSize: 50 } };

export default appTest(schema, {
  "runs": async (t) => {
${body.includes("owner") ? '    const owner = t.withIdentity({ name: "note-owner" });' : ""}
    ${body}
  },
});
`;

/** Creates a note, and reads it back from a call and from a live query. */
export const passing = suiteOf(`
      const live = await owner.subscribe(api.notes.list, page);
      const id = await owner.mutation(api.notes.create, { title: "First note" });
      const snapshot = await live.next((found) => found.items.some((note) => note._id === id));
      expect(snapshot.items.map((note) => note.title)).toEqual(["First note"]);
      expect((await owner.query(api.notes.list, page)).items).toHaveLength(1);
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
  await commitDefined(
    env,
    owner,
    id,
    withFiles(appFiles, {
      "tests/notes.test.ts": suite,
    })
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
    await rollback(on, appKind, owner, app, 1);
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

/** What `holdPlace` says when the sandbox had no place for it. */
const noPlace = "no place";

/**
 * Holds one of `owner`'s places in the sandbox with a session that spins,
 * until it's given up on (`signal`). `opened` hears once it holds it: the
 * supervisor opens a session only once it has its place and a process.
 */
export const holdPlace = async (
  owner: string,
  signal: AbortSignal,
  subOwner?: string,
  opened?: () => void
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
      { signal, opened }
    );
  } catch (error) {
    if (signal.aborted) {
      return "given up";
    }
    return noPlaceOf(error) ? noPlace : `refused: ${String(error)}`;
  }
};

/**
 * `owner`'s place held (`holdPlace`), once it is: how it ends. Asked for
 * again while the sandbox has no place for it: a session that just ended
 * keeps its place until its process is gone (scripts/workerd-sandbox.ts),
 * which on a busy runner can take longer than one ask waits.
 */
export const heldPlace = async (
  owner: string,
  signal: AbortSignal,
  subOwner?: string
): Promise<{ ended: Promise<unknown> }> => {
  for (;;) {
    const holding = Promise.withResolvers<"holding">();
    const ended = holdPlace(owner, signal, subOwner, () => {
      holding.resolve("holding");
    });
    // oxlint-disable-next-line no-await-in-loop -- one ask at a time
    const first = await Promise.race([ended, holding.promise]);
    if (first === "holding") {
      return { ended };
    }
    if (first !== noPlace) {
      throw new Error(`The place wasn't held: ${String(first)}`);
    }
  }
};

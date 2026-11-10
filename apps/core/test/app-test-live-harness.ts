import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { publishVersion } from "../src/app-publish.ts";
import type { Release } from "../src/app-releases.ts";
import { createApp } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { appOf, withFiles } from "./app-definitions.ts";
import type { TestApp, TestSource } from "./app-definitions.ts";
import { commitDefined } from "./apps.ts";
import { notesFiles } from "./notes-client-app.ts";
import { person } from "./sealed-apps.ts";

// What app-test-live*.test.ts share: the Notes App and its fixture, and
// how they build its tests and read how they went.

/** A push of `notes.list`'s, as far as the tests read it. */
export const pushOfNotes = z.object({
  revision: z.number(),
  result: z.object({
    value: z.object({ items: z.array(z.object({ title: z.string() })) }),
  }),
});

/** The Notes App the session client's tests use, with a fixture. */
export const appFiles: TestApp = withFiles(
  appOf(
    notesFiles.definition,
    Object.fromEntries(
      Object.entries(notesFiles.files).filter(
        ([path]) => !path.startsWith("src/")
      )
    )
  ),
  {
    "tests/fixtures/notes.json": JSON.stringify({
      principals: {
        "note-owner": { role: "user" },
        "other-owner": { role: "user" },
      },
    }),
  }
);

/** Spec 28.2's first example, word for word, but for the package's scope. */
export const specExample = `import { appTest } from "@grasp-os/sdk/testing";
import { api } from "@server/_generated/api";

export default appTest({
  fixtures: "notes",
  tests: {
    "creating a note updates the authorized live list": async (t) => {
      const viewer = await t.as("note-owner");
      const live = await viewer.subscribe(api.notes.list, {
        pagination: { pageSize: 50 },
      });
      const createdId = await viewer.mutation(api.notes.create, {
        title: "First note",
      });
      const snapshot = await live.next((page) =>
        page.items.some((note) => note._id === createdId)
      );
      t.equal(
        snapshot.items.find((note) => note._id === createdId)?.title,
        "First note"
      );
      await live.close();
    },
  },
});
`;

/** A suite of `tests`, each `"name": async (t) => { body }`. */
export const suiteOf = (
  tests: Record<string, string>
): string => `import { appTest } from "@grasp-os/sdk/testing";
import { api } from "@server/_generated/api";

const page = { pagination: { pageSize: 50 } };

export default appTest({
  fixtures: "notes",
  tests: {
${Object.entries(tests)
  .map(
    ([name, body]) => `    ${JSON.stringify(name)}: async (t) => {
${body}
    },`
  )
  .join("\n")}
  },
});
`;

export interface Built {
  owner: Acting & Identity;
  app: AppId;
}

/** A builder's App with `files` as its first version. */
export const appWith = async (files: TestSource): Promise<Built> => {
  const owner = await person("builder");
  const { id } = await createApp(env, owner, { name: "Notes" });
  await commitDefined(env, owner, id, files, "First version");
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

/** Why activating version 1 failed: each failing test, and why. */
export const failuresOf = async (
  { owner, app }: Built,
  on: Env = env
): Promise<unknown> => {
  try {
    await publishVersion(on, owner, app, 1);
  } catch (error) {
    if (isExpectedError(error) && error.code === "version.tests_failed") {
      return error.details?.failures;
    }
    throw error;
  }
  return [];
};

/** The fixture stores core still records. */
export const fixturesLeft = async (): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM app_test_fixtures"
  ).first<{ n: number }>();
  return row?.n ?? -1;
};

/** A call's request for `path` of `release`, as a test principal sends it. */
export const requestFor = (
  release: Release,
  path: string,
  input: unknown
): string => {
  const operation = release.app.operations[path];
  return JSON.stringify({
    reference: { name: path, kind: operation?.kind },
    args: input,
  });
};

/**
 * A follower's callbacks, as stubs of a test isolate's would be (each
 * released by disposing it), and what core did with them.
 */
export const follower = () => {
  const pushes: unknown[] = [];
  let lost = 0;
  let released = 0;
  const release = {
    [Symbol.dispose]: () => {
      released += 1;
    },
  };
  return {
    pushes,
    lost: () => lost,
    released: () => released,
    onSnapshot: Object.assign((push: unknown) => {
      pushes.push(push);
    }, release),
    onLost: Object.assign(() => {
      lost += 1;
    }, release),
  };
};

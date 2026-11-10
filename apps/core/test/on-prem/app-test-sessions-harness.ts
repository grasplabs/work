import { env } from "cloudflare:workers";

import { publishVersion } from "../../src/app-publish.ts";
import { loadRelease } from "../../src/app-releases.ts";
import type { Release } from "../../src/app-releases.ts";
import { createApp } from "../../src/apps.ts";
import { sandboxOwnerHeader } from "../../src/sandbox-headers.ts";
import { commitDefined } from "../apps.ts";
import { person } from "../sealed-apps.ts";
import { appFiles, supervisor } from "./app-test-harness.ts";

// What app-test-sessions*.test.ts share: the Notes release whose suites
// they run, and how they ask for it.

/**
 * The supervisor, but answering each ask for a session of `owner`'s only
 * `ms` later: a place granted that long after it was asked for, however
 * fast or slow the machine. Says how many asks it held back.
 */
export const slowToAdmit = (
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
export const notesRelease = async (): Promise<Release> => {
  const owner = await person("builder");
  const { id } = await createApp(env, owner, { name: "Notes" });
  await commitDefined(env, owner, id, appFiles, "First version");
  await publishVersion(env, owner, id, 1);
  return await loadRelease(env, id, 1);
};

/** `release`'s function `path` called with `input`, as a test's call names it. */
export const requestFor = (
  release: Release,
  path: string,
  input: unknown
): string =>
  JSON.stringify({
    reference: { name: path, kind: release.app.operations[path]?.kind },
    args: input,
  });

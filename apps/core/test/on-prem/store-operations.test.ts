import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { callAppFunction } from "../../src/app-functions.ts";
import { setCurrentVersion } from "../../src/apps.ts";
import { deepFiles, fieldDepth } from "../deep-records.ts";
import { appWith, seal } from "../sealed-apps.ts";
import type { Fixture } from "../sealed-apps.ts";

// A store's records on-prem: the App's functions run in a sandbox
// session, through the real supervisor this project starts.

/** An App with `files`, sealed and current. */
const sealedApp = async (
  files: Record<string, string>,
  name: string
): Promise<Fixture> => {
  const fixture = await appWith(files, name);
  await seal(fixture);
  await setCurrentVersion(env, fixture.owner, fixture.app, 1);
  return fixture;
};

/** What `sealed`'s owner gets calling `path` of its App with `input`. */
const called = async (
  { owner, app }: Fixture,
  path: string,
  kind: "query" | "mutation",
  input: unknown
): Promise<unknown> => {
  const answer = await callAppFunction(
    env,
    owner,
    app,
    JSON.stringify({
      reference: { name: path, kind },
      input,
    })
  );
  return answer.result.ok ? answer.result.value : answer.result.error.code;
};

describe("a record as deep as a store keeps, on-prem", () => {
  it("is written and read back through the sandbox session, every level of it", async () => {
    const deep = await sealedApp(deepFiles, "Deep");
    const id = await called(deep, "deep.put", "mutation", {});
    const levels = await called(deep, "deep.read", "query", { id });
    expect({ written: typeof id, levels }).toStrictEqual({
      written: "string",
      levels: fieldDepth,
    });
  });
});

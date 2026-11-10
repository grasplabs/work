import { definitionText, readDefinition } from "@grasp-os/runtime/definition";
import { sha256Hex } from "@grasp-os/shared/encoding";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { sealRelease } from "../src/app-releases.ts";
import { createApp, findVersion, readTree, versionFiles } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { definitionOf, redefined, withFiles } from "./app-definitions.ts";
import { notesFiles } from "./app-releases-harness.ts";
import { commitDefined } from "./apps.ts";
import { appWith, failure, person, seal } from "./sealed-apps.ts";

// `server/_generated/` as part of an App's own files (app-definition.ts
// says how each way it could fail is closed), written first as the ways
// it can fail: a builder writes it to reference what the code doesn't
// declare, or hide what it does; a stale or forged copy in storage
// reaches a release; a definition change isn't reflected in it; and a
// function the references can't name reaches a release. Through the
// real commit, compiler, sandbox, R2 and D1. The agent's own writes are
// agent-builds-files.test.ts's.

const api = "server/_generated/api.ts";
const internal = "server/_generated/internal.ts";

/** A version's files, as stored. */
const filesOf = async (app: AppId, version: number) =>
  await versionFiles(env, app, version);

/**
 * Stores `files` as App `app`'s next version (`version`) exactly, with
 * version `of`'s definition, past every check a commit makes: a tree
 * written another way than through a commit.
 */
const storedAsIs = async (
  app: AppId,
  by: Acting,
  version: number,
  files: Readonly<Record<string, string>>,
  of = version - 1
): Promise<void> => {
  const json = canonicalJson(files);
  const tree = await sha256Hex(json);
  const { definition, definitionHash } = await findVersion(env, app, of);
  await env.FILES.put(`apps/${app}/trees/${tree}.json`, json);
  await env.DB.prepare(
    "INSERT INTO app_versions (app_id, version, parent, tree, definition, definition_hash, files, author_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Stored as is', 0)"
  )
    .bind(
      app,
      version,
      of,
      tree,
      definition,
      definitionHash,
      Object.keys(files).length,
      by.userId
    )
    .run();
};

describe("an App's server/_generated/", { timeout: 120_000 }, () => {
  it("is generated into every version from its code: its public functions in api, its internal ones in internal, and nothing else", async () => {
    const { app } = await appWith(notesFiles());
    const files = await filesOf(app, 1);
    expect({
      api: files[api]?.includes('get: { name: "notes.get" }'),
      tally: files[api]?.includes('tally: { name: "notes.tally" }'),
      // An internal function's name never reaches a page's bundle.
      internalInApi: files[api]?.includes("notes.count"),
      internal: files[internal]?.includes('count: { name: "notes.count" }'),
      publicInInternal: files[internal]?.includes("notes.get"),
      server: files["server/_generated/server.ts"]?.includes("serverModule"),
      dataModel: files["server/_generated/dataModel.ts"]?.includes("Doc"),
    }).toStrictEqual({
      api: true,
      tally: true,
      internalInApi: false,
      internal: true,
      publicInInternal: false,
      server: true,
      dataModel: true,
    });
  });

  it("follows each commit's code and definition, as the next version's", async () => {
    const owner = await person("builder");
    const { id } = await createApp(env, owner, { name: "Notes" });
    const app = notesFiles();
    await commitDefined(env, owner, id, app, "First");
    // A function added, and a links permission declared.
    const next = redefined(
      withFiles(app, {
        "server/extra.ts": `import { v } from "@grasp-os/sdk";
import { query } from "@server/_generated/server";

export const hello = query({ args: {}, returns: v.string(), handler: () => "hello" });
`,
      }),
      (definition) => ({
        ...definition,
        permissions: definitionOf({
          name: "Notes",
          permissions: [
            'permission.links({ origins: ["https://help.example.com"] })',
          ],
        }).permissions,
      })
    );
    await commitDefined(env, owner, id, next, "Second");
    const [first, second] = await Promise.all([filesOf(id, 1), filesOf(id, 2)]);
    expect({
      before: [
        first[api]?.includes("extra.hello"),
        first[api]?.includes("https://help.example.com"),
      ],
      after: [
        second[api]?.includes('hello: { name: "extra.hello" }'),
        second[api]?.includes("https://help.example.com"),
      ],
    }).toStrictEqual({ before: [false, false], after: [true, true] });
  });

  it.each([
    ["writes", { [api]: "export const api = { forged: { name: 'x' } };\n" }],
    ["deletes", { [api]: null }],
    [
      "adds a module",
      { "server/_generated/extra.ts": "export const x = 1;\n" },
    ],
    ["writes in another case", { "Server/_Generated/api.ts": "export {};\n" }],
  ])(
    "refuses a commit that %s under it, keeping the version's own",
    async (_what, changes) => {
      const { owner, app } = await appWith(notesFiles());
      const before = await filesOf(app, 1);
      expect({
        refused: await failure(
          async () =>
            await commitDefined(
              env,
              owner,
              app,
              { ...changes, "server/other.ts": "export const one = 1;\n" },
              "Forged references"
            )
        ),
        kept: await filesOf(app, 1).then((after) => after[api] === before[api]),
      }).toStrictEqual({ refused: "app.invalid", kept: true });
    }
  );

  it("refuses to publish a version whose copy was forged or written by an earlier generator, and publishes it once saved again", async () => {
    const fixture = await appWith(notesFiles());
    const { owner, app } = fixture;
    const files = await filesOf(app, 1);
    // A reference to the internal function, slipped into the browser's api.
    const forged = (files[api] ?? "").replace(
      "  notes: {",
      '  notes: {\n    count: { name: "notes.count" },'
    );
    await storedAsIs(app, owner, 2, { ...files, [api]: forged });
    // Without one at all: a version committed before it was part of the files.
    const { [internal]: _gone, ...without } = files;
    await storedAsIs(app, owner, 3, without, 1);
    const refusals = await Promise.all([
      failure(async () => await seal(fixture, 2)),
      failure(async () => await seal(fixture, 3)),
    ]);
    // Saved again, it is generated anew, and publishes.
    await commitDefined(
      env,
      owner,
      app,
      { "AGENTS.md": "# Notes\n" },
      "Saved again"
    );
    const saved = await filesOf(app, 4);
    const { manifest } = await sealRelease(env, { app, version: 4, by: owner });
    expect({
      refusals,
      regenerated:
        saved[api] === files[api] && saved[internal] === files[internal],
      sealed: manifest.resourceVersion,
    }).toStrictEqual({
      refusals: ["version.generated_stale", "version.generated_stale"],
      regenerated: true,
      sealed: 4,
    });
  });

  it("refuses to publish a version whose definition changed past its copy", async () => {
    const fixture = await appWith(notesFiles());
    const { owner, app } = fixture;
    const files = await filesOf(app, 1);
    // The definition's links permission, which `permissions.links` in the
    // api names, stored with the first version's copy.
    const changed = definitionOf({
      name: "Notes",
      permissions: [
        'permission.links({ origins: ["https://help.example.com"] })',
      ],
    });
    const first = await findVersion(env, app, 1);
    const stored = readDefinition(JSON.parse(first.definition ?? "null"));
    const text = definitionText({
      ...stored,
      permissions: changed.permissions,
    });
    const json = canonicalJson(files);
    const tree = await sha256Hex(json);
    await env.FILES.put(`apps/${app}/trees/${tree}.json`, json);
    await env.DB.prepare(
      "INSERT INTO app_versions (app_id, version, parent, tree, definition, definition_hash, files, author_id, message, created_at) VALUES (?, 2, 1, ?, ?, ?, ?, ?, 'Definition only', 0)"
    )
      .bind(
        app,
        tree,
        text,
        await sha256Hex(text),
        Object.keys(files).length,
        owner.userId
      )
      .run();
    await expect(failure(async () => await seal(fixture, 2))).resolves.toBe(
      "version.generated_stale"
    );
  });

  it("refuses to publish a function made through an alias of a builder or a wrapper, naming it", async () => {
    const fixture = await appWith(
      withFiles(notesFiles(), {
        "server/aliased.ts": `import { v } from "@grasp-os/sdk";
import { query } from "@server/_generated/server";

const read = query;
export const hidden = read({ args: {}, returns: v.string(), handler: () => "hidden" });
`,
      })
    );
    const { tree } = await findVersion(env, fixture.app, 1);
    const files = await readTree(env, fixture.app, tree);
    let details: unknown;
    try {
      await seal(fixture);
    } catch (error) {
      details =
        typeof error === "object" && error !== null
          ? Reflect.get(error, "details")
          : undefined;
    }
    expect({
      referenced: files.get(api)?.includes("aliased.hidden"),
      details,
    }).toStrictEqual({
      referenced: false,
      details: { functions: ["aliased.hidden"] },
    });
  });
});

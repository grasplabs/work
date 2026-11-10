import { definitionText, readDefinition } from "@grasp-os/runtime/definition";
import { sha256Hex } from "@grasp-os/shared/encoding";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Release } from "../src/app-releases.ts";
import { createApp, findVersion, readTree, versionFiles } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { definitionOf, redefined, withFiles } from "./app-definitions.ts";
import { notesFiles } from "./app-releases-harness.ts";
import { commitDefined } from "./apps.ts";
import { appWith, artifactKey, failure, person, seal } from "./sealed-apps.ts";

// `server/_generated/` as part of an App's own files (app-definition.ts
// says how each way it could fail is closed), written first as the ways
// it can fail: a builder writes it to reference what the code doesn't
// declare, or hide what it does; a stale or forged copy in storage
// reaches a release (a release is sealed with what Grasp generates from
// the version's files and definition, never the copy); a definition
// change isn't reflected in it; and a function the references can't
// name reaches a release. Through the
// real commit, compiler, sandbox, R2 and D1. The agent's own writes are
// agent-builds-files.test.ts's.

const api = "server/_generated/api.ts";
const internal = "server/_generated/internal.ts";

/** The text `release` sealed at `path`, or undefined for none. */
const sealedText = async (
  release: Release,
  path: string
): Promise<string | undefined> => {
  const entry = release.manifest.artifacts.find(
    (artifact) => artifact.path === path
  );
  if (entry === undefined) {
    return undefined;
  }
  const stored = await env.FILES.get(await artifactKey(entry.sha256));
  return await stored?.text();
};

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
    ["writes a file in its place", { "server/_generated": "export {};\n" }],
  ])(
    "refuses a commit that %s under it, committing nothing",
    async (_what, changes) => {
      const { owner, app } = await appWith(notesFiles());
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
        // Nothing of it committed.
        next: await failure(async () => await findVersion(env, app, 2)),
      }).toStrictEqual({
        refused: "app.invalid",
        next: "app.version_not_found",
      });
    }
  );

  it("seals what Grasp generates, never the copy a version holds: forged, missing, or with a module of its own there", async () => {
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
    // With a module of its own there, which no write could put.
    const extra = "server/_generated/extra.ts";
    await storedAsIs(
      app,
      owner,
      4,
      { ...files, [extra]: 'export const leaked = "secret";\n' },
      1
    );
    const sealed = await Promise.all(
      [2, 3, 4].map(async (version) => {
        const release = await seal(fixture, version);
        return {
          api: await sealedText(release, api),
          internal: await sealedText(release, internal),
          extra: release.manifest.artifacts.some(({ path }) =>
            path.includes("extra")
          ),
          leaked: Object.values(release.modules).some((code) =>
            code.includes("leaked")
          ),
        };
      })
    );
    // The version's tree stays as it was stored.
    const kept = await filesOf(app, 2);
    expect({ sealed, kept: kept[api] === forged }).toStrictEqual({
      sealed: [2, 3, 4].map(() => ({
        api: files[api],
        internal: files[internal],
        extra: false,
        leaked: false,
      })),
      kept: true,
    });
  });

  it("seals the references a version's definition gives, whatever its copy says", async () => {
    const fixture = await appWith(notesFiles());
    const { owner, app } = fixture;
    const files = await filesOf(app, 1);
    // The definition's links permission, which `permissions.links` in the
    // api names, stored with the first version's copy (and config).
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
    const release = await seal(fixture, 2);
    const sealed = await sealedText(release, api);
    expect({
      copy: files[api]?.includes("https://help.example.com"),
      sealed: sealed?.includes("https://help.example.com"),
    }).toStrictEqual({ copy: false, sealed: true });
  });

  it("refuses to publish a function made through an alias of a builder, or of another visibility than its syntax says, naming each", async () => {
    const fixture = await appWith(
      withFiles(notesFiles(), {
        "server/aliased.ts": `import { v } from "@grasp-os/sdk";
import { query } from "@server/_generated/server";

const read = query;
export const hidden = read({ args: {}, returns: v.string(), handler: () => "hidden" });
`,
        // Declared as a query by a builder of its own, so no function.
        "server/local.ts": `const query = (definition: unknown): unknown => definition;

export const fake = query({ args: {} });
`,
        // Internal, though its syntax reads as a public query's.
        "server/renamed.ts": `import { v } from "@grasp-os/sdk";
import { internalQuery as query } from "@server/_generated/server";

export const secret = query({ args: {}, returns: v.string(), handler: () => "secret" });
`,
      })
    );
    const { tree } = await findVersion(env, fixture.app, 1);
    const files = await readTree(env, fixture.app, tree);
    let refused: object = {};
    try {
      await seal(fixture);
    } catch (error) {
      refused = typeof error === "object" && error !== null ? error : {};
    }
    const code: unknown = Reflect.get(refused, "code");
    const details: unknown = Reflect.get(refused, "details");
    expect({
      referenced: files.get(api)?.includes("aliased.hidden"),
      code,
      details,
    }).toStrictEqual({
      referenced: false,
      code: "version.function_undeclared",
      details: {
        functions: ["aliased.hidden", "local.fake", "renamed.secret"],
      },
    });
  });
});

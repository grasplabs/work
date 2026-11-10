import { definitionManifest } from "@grasp-os/runtime/definition";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { publishVersion } from "../src/app-publish.ts";
import { sealRelease } from "../src/app-releases.ts";
import { createApp, draftOverLatest, proposeDraft } from "../src/apps.ts";
import { deleteStore, openStore } from "../src/data-stores.ts";
import { buildAppCode } from "../src/pages.ts";
import {
  changesOf,
  definitionOf,
  testApp,
  withFiles,
} from "./app-definitions.ts";
import type { AppSpec } from "./app-definitions.ts";
import {
  bootstrapModules,
  builds,
  errorsOf,
  importForms,
  namingAll,
  notesFiles,
  refusedIn,
  tablelessFiles,
  targets,
  withTable,
} from "./app-releases-harness.ts";
import { commitDefined } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { appWith, failure, person, seal, sweptAway } from "./sealed-apps.ts";

// Sealing an App's release (spec 8, 16) through the real compiler, Loader
// isolates, R2 and D1: what a seal pins, that what it pins can't change
// under it, and the ways App code and storage could try to make it seal
// or run something else. Running a sealed release is
// app-functions.test.ts. Gone with App workflows: the types an App's own
// workflow may name, as its build reads them.

describe("an App's definition", { timeout: 120_000 }, () => {
  it("seals as the App it is: its generated config and schema register as the definition does", async () => {
    // A definition of every part the generator writes: tables of row
    // rules, indexes and a search index, a sensitive one, permissions and
    // an answer.
    const spec: AppSpec = {
      name: "Desk",
      tables: {
        notes: {
          fields: {
            title: "v.string().trim().min(1).max(200)",
            owner: "v.person().optional()",
            team: "v.string()",
            tags: "v.array(v.string()).max(5).default([])",
            priority: 'v.enum(["low", "high"])',
          },
          indexes: { by_title: ["title"] },
          searchIndex: ["title"],
          access: {
            read: "appMembers",
            write: "appMembers",
            rows: {
              read: [
                { kind: "owner" },
                { kind: "person", field: "owner" },
                { kind: "team", field: "team" },
              ],
            },
          },
        },
        salaries: {
          fields: { note: 'v.id("notes")', amount: "v.number().min(0)" },
          sensitive: true,
          access: { read: "appBuilders", write: "appBuilders" },
        },
      },
      permissions: [
        "permission.ai({ maxOutputTokens: 500 })",
        'permission.links({ origins: ["https://help.example.com"] })',
        "people",
      ],
      answers: [{ table: "notes", field: "priority", value: "low" }],
    };
    const fixture = await appWith(testApp(spec), "Desk");
    const release = await seal(fixture);
    expect(release.app).toStrictEqual(definitionManifest(definitionOf(spec)));
  });
});

/** Notes with `changes` to its files, sealed. */
const sealedWith = async (changes: Record<string, string>): Promise<string> => {
  const fixture = await appWith(
    withFiles(notesFiles(), {
      ...changes,
    })
  );
  return await failure(async () => await seal(fixture));
};

describe("App code that a seal refuses", { timeout: 120_000 }, () => {
  it("can't reach the network while it is inspected", async () => {
    await expect(
      sealedWith({
        "server/extra.ts": 'await fetch("https://example.com");\nexport {};\n',
      })
    ).resolves.toBe("version.inspection_failed");
  });

  it("can't name a server module after an object's prototype", async () => {
    // Its modules are keyed by path in the generated entry: `__proto__`
    // is refused as a path, never taken for the map's prototype.
    const fixture = await appWith(
      withFiles(notesFiles(), {
        "server/__proto__.ts":
          'import { v } from "@grasp-os/runtime";\nimport { query } from "@server/_generated/server";\n\nexport const hello = query({ args: {}, returns: v.string(), handler: () => "hello" });\n',
      })
    );
    const refused: unknown = await seal(fixture).then(
      () => {},
      (error: unknown) => error
    );
    const { code, details } = z
      .object({ code: z.string(), details: z.object({ message: z.string() }) })
      .parse(refused);
    expect({
      code,
      byPath: details.message.includes(
        "server/__proto__.ts doesn't make a function path"
      ),
    }).toStrictEqual({ code: "version.inspection_failed", byPath: true });
  });

  it("can't hand the host a manifest it didn't declare", async () => {
    // The App's code makes the SDK in its isolate answer a function with
    // a list of its own, as if it narrowed or widened what the App holds:
    // no declaration makes that, so the host refuses it.
    const forging = `const stringify = JSON.stringify;
JSON.stringify = (value, ...rest) => {
  const text = stringify(value, ...rest);
  return typeof value === "object" && value !== null && "operations" in value
    ? text.replace('"stream":null', '"stream":null,"uses":[{"type":"resource","kind":"ai","alias":"ai"}]')
    : text;
};
`;
    await expect(sealedWith({ "server/forge.ts": forging })).resolves.toBe(
      "version.invalid_manifest"
    );
  });

  it.each([
    [
      "server code that imports the Workers runtime",
      {
        "server/extra.ts":
          'import { env } from "cloudflare:workers";\nexport const leak = env;\n',
      },
    ],
    [
      "server code that imports a platform-only SDK module",
      {
        "server/extra.ts":
          'import { inspectApp } from "@grasp-os/runtime/host";\nexport const peek = inspectApp;\n',
      },
    ],
    [
      "server code that imports a module by a computed name",
      {
        "server/extra.ts":
          'const name = "cloudflare:" + "workers";\nexport const load = () => import(name);\n',
      },
    ],
  ])("doesn't build with %s", async (_case, changes) => {
    await expect(sealedWith(changes)).resolves.toBe("version.build_failed");
  });

  it("binds its own App's store alone: another App's seal, by a builder of both, never reaches it", async () => {
    const first = await appWith(notesFiles());
    await publishVersion(env, first.owner, first.app, 1);
    const second = await appWith(withTable("beta"), "Beta", first.owner);
    const sealed = await seal(second);
    const opened = await openStore(env, first.store);
    expect({
      bound: sealed.store?.storeId,
      apart: second.store !== first.store,
      // Its schema was never handed to the first App's store.
      untouched: await opened.generations(["beta"]),
    }).toStrictEqual({ bound: second.store, apart: true, untouched: {} });
  });

  it("is refused to someone who doesn't build the App, before a store is made or its code is built", async () => {
    const owner = await person("builder");
    const { id } = await createApp(env, owner, { name: "Beta" });
    await commitDefined(env, owner, id, withTable("beta"), "First version");
    const outsider = await person("builder");
    const before = await builds();
    const refused = await failure(
      async () => await sealRelease(env, { app: id, version: 1, by: outsider })
    );
    const stores = await env.DB.prepare(
      "SELECT store_id FROM app_default_stores WHERE app_id = ?"
    )
      .bind(id)
      .all();
    expect([refused, await builds(), stores.results]).toStrictEqual([
      "app.not_found",
      before,
      [],
    ]);
  });

  it("keeps its store from being deleted while any release kept binds it, and lets it go once retention removed them", async () => {
    const fixture = await appWith(notesFiles());
    await seal(fixture);
    await publishVersion(env, fixture.owner, fixture.app, 1);
    const current = await failure(async () => {
      await deleteStore(env, fixture.owner, fixture.store);
    });
    const events = await allEvents();
    // A version without tables made current: version 1 binds the store
    // still, kept as a rollback target.
    // Its operations replaced: the notes' file goes, which reads tables
    // version 2 doesn't have.
    await commitDefined(
      env,
      fixture.owner,
      fixture.app,
      changesOf(tablelessFiles(), {
        "server/notes.ts": null,
      }),
      "Two"
    );
    await seal(fixture, 2);
    await publishVersion(env, fixture.owner, fixture.app, 2);
    const retained = await failure(async () => {
      await deleteStore(env, fixture.owner, fixture.store);
    });
    // Retention lets version 1 go: no longer among the App's latest.
    await sweptAway(fixture.app, 1);
    await deleteStore(env, fixture.owner, fixture.store);
    expect([
      current,
      retained,
      events.some(
        (event) =>
          event.action === "store.delete_refused" &&
          event.target?.id === fixture.store &&
          event.detail?.reason === "data.store_bound"
      ),
      await failure(async () => await openStore(env, fixture.store)),
    ]).toStrictEqual([
      "data.store_bound",
      "data.store_bound",
      true,
      "data.store_unavailable",
    ]);
  });

  it("is refused a store whose deletion has begun, and seals once that deletion let it be", async () => {
    const fixture = await appWith(notesFiles());
    // A deletion of the store in flight: its closing mark is set.
    await env.DB.prepare(
      "UPDATE business_stores SET closing_at = ?, closing_owner = 'deleting' WHERE id = ?"
    )
      .bind(Date.now(), fixture.store)
      .run();
    const refused = await failure(async () => await seal(fixture));
    const bound = await env.DB.prepare(
      "SELECT 1 FROM sdk_resource_bindings WHERE target_id = ?"
    )
      .bind(fixture.store)
      .all();
    // That deletion refused, and its mark cleared: the seal binds it.
    await env.DB.prepare(
      "UPDATE business_stores SET closing_at = NULL, closing_owner = NULL WHERE id = ?"
    )
      .bind(fixture.store)
      .run();
    const release = await seal(fixture);
    expect([refused, bound.results, release.store?.storeId]).toStrictEqual([
      "data.store_unavailable",
      [],
      fixture.store,
    ]);
  });

  it("seals functions at any segment a reference doesn't answer, `preferences` among them", async () => {
    const fixture = await appWith(
      withFiles(notesFiles(), {
        "server/preferences.ts": `import { v } from "@grasp-os/runtime";
import { api } from "@server/_generated/api";
import { action, query } from "@server/_generated/server";

export const defaults = query({
  args: {},
  returns: v.boolean(),
  handler: () => true,
});

export const reach = action({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => await ctx.runQuery(api.preferences.defaults, {}),
});
`,
      })
    );
    const release = await seal(fixture);
    expect([
      release.app.operations["preferences.defaults"]?.kind,
      release.app.operations["preferences.reach"]?.kind,
    ]).toStrictEqual(["query", "action"]);
  });

  it("makes its App's one store when it first declares tables, keyed by the App and audited", async () => {
    const owner = await person("builder");
    const { id } = await createApp(env, owner, { name: "Notes" });
    await commitDefined(env, owner, id, notesFiles(), "First version");
    const first = await sealRelease(env, { app: id, version: 1, by: owner });
    await commitDefined(env, owner, id, withTable("beta"), "Second version");
    const second = await sealRelease(env, { app: id, version: 2, by: owner });
    const keyed = await env.DB.prepare(
      "SELECT store_id AS store FROM app_default_stores WHERE app_id = ?"
    )
      .bind(id)
      .all<{ store: string }>();
    const events = await allEvents();
    const created = events.filter(
      (event) => event.action === "store.created" && event.detail?.app === id
    );
    expect({
      keyed: keyed.results.map(({ store }) => store),
      second: second.store?.storeId,
      created: created.map((event) => event.target?.id),
    }).toStrictEqual({
      keyed: [first.store?.storeId],
      second: first.store?.storeId,
      created: [first.store?.storeId],
    });
  });

  it("is an App of spec 8's layout: a draft that drops its schema gets it back from its definition", async () => {
    const fixture = await appWith(notesFiles());
    const draft = await draftOverLatest(env, fixture.app, {
      base: 1,
      changes: { "server/schema.ts": null },
      definition: null,
    });
    await expect(
      failure(
        async () =>
          await proposeDraft(
            env,
            fixture.owner,
            fixture.app,
            draft,
            "No schema"
          )
      )
      // Its schema generated from its definition again: the version it
      // would commit is the one it is over.
    ).resolves.toBe("app.nothing_to_commit");
  });

  it("can't keep anything but server code under operations/: each is refused by name", async () => {
    const strays = [
      "server/notes.json",
      "server/view.tsx",
      "server/types.d.ts",
      // Never saved (a save refuses each), never server code.
      "server/.hidden/notes.ts",
      "server/../app.ts",
      "server//x.ts",
    ];
    const built = await buildAppCode(
      env,
      withFiles(
        notesFiles(),
        Object.fromEntries(strays.map((path) => [path, "export {};\n"]))
      ).files,
      "app-test"
    );
    expect({
      ok: built.ok,
      refused: new Set(
        built.ok
          ? []
          : built.diagnostics
              .filter(({ message }) =>
                message.includes("which holds only the App's server code")
              )
              .map(({ file }) => file)
      ),
    }).toStrictEqual({ ok: false, refused: new Set(strays) });
  });

  it("can't keep anything but one file per migration under server/migrations/: each is refused by name", async () => {
    const strays = [
      "server/migrations/lib/helper.ts",
      "server/migrations/v1.0/derive.ts",
      "server/migrations/notes.md",
      "server/migrations/types.d.ts",
      // Never saved (a save refuses each), never a migration.
      "server/migrations/.hidden.ts",
      "server/migrations/../app.ts",
    ];
    const built = await buildAppCode(
      env,
      withFiles(
        notesFiles(),
        Object.fromEntries(strays.map((path) => [path, "export {};\n"]))
      ).files,
      "app-test"
    );
    expect({
      ok: built.ok,
      refused: new Set(
        built.ok
          ? []
          : built.diagnostics
              .filter(({ message }) =>
                message.includes("which holds only the App's migrations")
              )
              .map(({ file }) => file)
      ),
    }).toStrictEqual({ ok: false, refused: new Set(strays) });
  });

  it("builds each operations file as a module of its own, dotted folders included", async () => {
    // A folder named like a file beside it: each still has its own module.
    const built = await buildAppCode(
      env,
      withFiles(notesFiles(), {
        "server/v1.0/extra.ts": "export const one = 1;\n",
        "server/notes.ts/extra.ts": "export const two = 2;\n",
      }).files,
      "app-test"
    );
    expect(
      built.ok
        ? Object.keys(built.modules).filter((name) =>
            name.startsWith("app~server~")
          )
        : built.diagnostics
    ).toStrictEqual(
      expect.arrayContaining([
        "app~server~notes.js",
        "app~server~v1.0~extra.js",
        "app~server~notes.ts~extra.js",
      ])
    );
  });

  it("can't put generated modules in its source", async () => {
    const owner = await person("builder");
    const { id } = await createApp(env, owner, { name: "Notes" });
    await expect(
      failure(
        async () =>
          await commitDefined(
            env,
            owner,
            id,
            withFiles(notesFiles(), {
              "server/_generated/api.ts": "export const api = {};\n",
            }),
            "Forged references"
          )
      )
    ).resolves.toBe("app.invalid");
  });
});

describe("import boundaries", { timeout: 120_000 }, () => {
  it.each(
    Object.entries(targets).flatMap(([target, kind]) =>
      Object.entries(importForms)
        .filter(([form]) => !("typesOnly" in kind && form === "values"))
        .map(([form, write]) => [target, form, kind, write] as const)
    )
  )(
    "keep the platform's bootstrap out of %s, naming it for its %s",
    async (_target, _form, kind, write) => {
      const { file, wrap, build } = kind;
      const built = await build(
        withFiles(notesFiles(), {
          ...("others" in kind ? kind.others : {}),
          [file]: wrap(namingAll(write)),
        }).files
      );
      expect({ ok: built.ok, refused: refusedIn(built, file) }).toStrictEqual({
        ok: false,
        refused: [...bootstrapModules].toSorted(),
      });
    }
  );

  it.each(Object.entries(targets))(
    "build %s that names none of it, with the types it may name",
    async (_target, kind) => {
      const { file, wrap, build, types } = kind;
      const built = await build(
        withFiles(notesFiles(), {
          ...("others" in kind ? kind.others : {}),
          [file]: wrap(types),
        }).files
      );
      expect({
        ok: built.ok,
        errors: errorsOf(built),
      }).toStrictEqual({ ok: true, errors: [] });
    }
  );
});

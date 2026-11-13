import type { AppId } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { addMember, removeMember } from "../src/app-members.ts";
import { loadRelease, sealRelease } from "../src/app-releases.ts";
import { appKind, findApp } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { rollback } from "../src/publish.ts";
import { testApp, withFiles } from "./app-definitions.ts";
import type { TestApp, TestSource } from "./app-definitions.ts";
import { commitDefined, markPublished, racingDb } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { appWith, artifactKey, failure, person } from "./sealed-apps.ts";

// Publishing (app-publish.ts), from its threat model: no path makes code
// current that didn't pass. Each way it could fail, broken on purpose: a
// base that changed, a build or a test that fails, two publishes at once,
// a crash midway, bytes changed in storage, and someone without the right.

/** An App of spec 8's layout answering `greeting`. */
const helloFiles = (greeting = "hello"): TestApp =>
  testApp(
    { name: "Hello", tables: {} },
    {
      "server/hello.ts": `import { v } from "@grasp-os/sdk";
import { query } from "@server/_generated/server";

export const hello = query({
  args: {},
  returns: v.string(),
  handler: () => ${JSON.stringify(greeting)},
});
`,
    }
  );

/** An App test of `helloFiles` expecting `greeting`. */
const helloTest = (greeting: string): Record<string, string> => ({
  "tests/hello.test.ts": `import { appTest } from "@grasp-os/sdk/testing";
import { api } from "@server/_generated/api";
import { expect } from "vitest";
import schema from "../server/schema.ts";

export default appTest(schema, {
  "says ${greeting}": async (t) => {
    const reader = t.withIdentity({ name: "reader" });
    expect(await reader.query(api.hello.hello, {})).toBe(${JSON.stringify(greeting)});
  },
});
`,
});

/** Commits `files` as `app`'s next version, by `by`: its number. */
const committed = async (
  by: Acting & Identity,
  app: AppId,
  files: TestSource
): Promise<number> => {
  const { version } = await commitDefined(env, by, app, files, "Next");
  return version;
};

/** `app`'s current version. */
const currentOf = async (app: AppId): Promise<number | null> => {
  const { currentVersion } = await findApp(env, app);
  return currentVersion;
};

/** The publishing status of `version` of `app`. */
const statusOf = async (app: AppId, version: number): Promise<unknown> => {
  const row = await env.DB.prepare(
    "SELECT status FROM app_versions WHERE app_id = ? AND version = ?"
  )
    .bind(app, version)
    .first<{ status: string | null }>();
  return row?.status;
};

/** What the audit log says of publishing `app`: each entry's action and version. */
const publishingOf = async (app: AppId): Promise<unknown[][]> => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target }) =>
        target?.id === app &&
        [
          "app.release.sealed",
          "app.version.built",
          "app.version.publish_failed",
          "version.rolled_back",
        ].includes(action)
    )
    .map(({ action, detail }) => [
      action,
      detail?.version,
      ...(typeof detail?.code === "string" ? [detail.code] : []),
    ]);
};

/**
 * Whether the database refuses making `version` of `app` current by hand,
 * as another writer would.
 */
const refusedByHand = async (app: AppId, version: number): Promise<boolean> => {
  const outcome = await failure(
    async () =>
      await env.DB.prepare("UPDATE apps SET current_version = ? WHERE id = ?")
        .bind(version, app)
        .run()
  );
  return outcome.includes("apps are made current from a published version");
};

/** The entries of `publishingOf(app)` whose action is `action`. */
const audited = async (app: AppId, action: string): Promise<unknown[][]> => {
  const entries = await publishingOf(app);
  return entries.filter(([named]) => named === action);
};

describe("publishing a version", { timeout: 120_000 }, () => {
  it("seals it, runs its tests, marks it published and makes it current, each audited", async () => {
    const { owner, app } = await appWith(
      withFiles(helloFiles(), {
        ...helloTest("hello"),
      })
    );
    const made = await rollback(env, appKind, owner, app, 1);
    const release = await loadRelease(env, app, 1);
    const events = await allEvents();
    const published = events.find(
      ({ action, target }) =>
        action === "app.version.built" && target?.id === app
    );
    expect({
      current: made.version,
      status: await statusOf(app, 1),
      audited: await publishingOf(app),
      manifestHash: published?.detail?.manifestHash,
    }).toStrictEqual({
      current: 1,
      status: "published",
      audited: [
        ["app.release.sealed", 1],
        ["app.version.built", 1],
        ["version.rolled_back", 1],
      ],
      manifestHash: release.manifestHash,
    });
  });

  it("refuses a version whose test fails, marks it failed, and leaves the current one", async () => {
    const { owner, app } = await appWith(
      withFiles(helloFiles(), {
        ...helloTest("hello"),
      })
    );
    await rollback(env, appKind, owner, app, 1);
    const failing = await committed(owner, app, helloTest("goodbye"));
    expect({
      refused: await failure(
        async () => await rollback(env, appKind, owner, app, failing)
      ),
      current: await currentOf(app),
      status: await statusOf(app, failing),
      byHand: await refusedByHand(app, failing),
      audited: await publishingOf(app),
    }).toStrictEqual({
      refused: "version.tests_failed",
      current: 1,
      status: "failed",
      byHand: true,
      audited: [
        ["app.release.sealed", 1],
        ["app.version.built", 1],
        ["version.rolled_back", 1],
        ["app.release.sealed", 2],
        ["app.version.publish_failed", 2, "version.tests_failed"],
      ],
    });
  });

  it("refuses a version that doesn't build, and leaves the current one", async () => {
    const { owner, app } = await appWith(helloFiles());
    await rollback(env, appKind, owner, app, 1);
    const broken = await committed(owner, app, {
      "server/hello.ts": `import { v } from "@grasp-os/sdk";
import { query } from "@server/_generated/server";

export const hello = query({
  args: {},
  returns: v.string(),
  handler: () => 42,
});
`,
    });
    expect({
      refused: await failure(
        async () => await rollback(env, appKind, owner, app, broken)
      ),
      current: await currentOf(app),
      status: await statusOf(app, broken),
    }).toStrictEqual({
      refused: "version.build_failed",
      current: 1,
      status: "failed",
    });
  });

  it("refuses a caller's expected version that isn't current", async () => {
    const { owner, app } = await appWith(helloFiles("one"));
    await committed(owner, app, helloFiles("two"));
    await rollback(env, appKind, owner, app, 1);
    const wrong = await failure(
      async () => await rollback(env, appKind, owner, app, 2, undefined, null)
    );
    const right = await rollback(env, appKind, owner, app, 2, undefined, 1);
    expect({ wrong, right: right.version }).toStrictEqual({
      wrong: "draft.conflict",
      right: 2,
    });
  });

  it("never makes a version current over a base that changed while it was published", async () => {
    const { owner, app } = await appWith(helloFiles("one"));
    await committed(owner, app, helloFiles("two"));
    await committed(owner, app, helloFiles("three"));
    await rollback(env, appKind, owner, app, 1);
    // Version 3 is published and made current after version 2's publish
    // read version 1 as current, just before version 2 is marked.
    const racing = racingDb(async () => {
      await rollback(env, appKind, owner, app, 3);
    }, /^update "app_versions" set "status"/iu);
    expect({
      refused: await failure(
        async () =>
          await rollback({ ...env, DB: racing }, appKind, owner, app, 2)
      ),
      current: await currentOf(app),
      // Published all the same: a later publish only makes it current.
      status: await statusOf(app, 2),
    }).toStrictEqual({
      refused: "draft.conflict",
      current: 3,
      status: "published",
    });
  });

  it("makes one of two versions published at once over the same base current", async () => {
    const { owner, app } = await appWith(helloFiles("one"));
    await committed(owner, app, helloFiles("two"));
    await committed(owner, app, helloFiles("three"));
    await rollback(env, appKind, owner, app, 1);
    const outcomes = await Promise.all(
      [2, 3].map(
        async (version) =>
          await failure(
            async () => await rollback(env, appKind, owner, app, version)
          )
      )
    );
    const current = await currentOf(app);
    // The other is refused by the App's store, whose schema the first
    // took (`migration.busy`), or by core, whose current version it took
    // (`app.conflict`), whichever it reaches first.
    const refused = outcomes.find((outcome) => outcome !== "ok") ?? "";
    expect({
      made: outcomes.filter((outcome) => outcome === "ok").length,
      refused: ["draft.conflict", "migration.busy"].includes(refused),
      current: current === 2 || current === 3,
    }).toStrictEqual({ made: 1, refused: true, current: true });
  });

  it("goes on after a crash between sealing and marking, sealing nothing new", async () => {
    const { owner, app } = await appWith(
      withFiles(helloFiles(), {
        ...helloTest("hello"),
      })
    );
    // Sealed, then the publish stopped before its tests.
    const sealed = await sealRelease(env, { app, version: 1, by: owner });
    await expect(refusedByHand(app, 1)).resolves.toBeTruthy();
    const made = await rollback(env, appKind, owner, app, 1);
    const release = await loadRelease(env, app, 1);
    expect({
      current: made.version,
      sameRelease: release.manifestHash === sealed.manifestHash,
      seals: await audited(app, "app.release.sealed"),
    }).toStrictEqual({
      current: 1,
      sameRelease: true,
      seals: [["app.release.sealed", 1]],
    });
  });

  it("goes on after a crash between marking and making current, testing nothing again", async () => {
    const { owner, app } = await appWith(
      withFiles(helloFiles(), {
        ...helloTest("hello"),
      })
    );
    await sealRelease(env, { app, version: 1, by: owner });
    // Marked, then the publish stopped before making it current.
    await markPublished(app, 1);
    const made = await rollback(env, appKind, owner, app, 1);
    expect({
      current: made.version,
      audited: await publishingOf(app),
    }).toStrictEqual({
      current: 1,
      audited: [
        ["app.release.sealed", 1],
        ["version.rolled_back", 1],
      ],
    });
  });

  it("rolls back to a published version without running its tests again", async () => {
    const { owner, app } = await appWith(
      withFiles(helloFiles(), {
        ...helloTest("hello"),
      })
    );
    await rollback(env, appKind, owner, app, 1);
    await committed(
      owner,
      app,
      withFiles(helloFiles("two"), {
        ...helloTest("two"),
      })
    );
    await rollback(env, appKind, owner, app, 2);
    const back = await rollback(env, appKind, owner, app, 1);
    expect({
      current: back.version,
      published: await audited(app, "app.version.built"),
    }).toStrictEqual({
      current: 1,
      // Version 1's once, as it was first published, and version 2's.
      published: [
        ["app.version.built", 1],
        ["app.version.built", 2],
      ],
    });
  });

  it("refuses a rollback whose release changed in storage since it was published", async () => {
    const { owner, app } = await appWith(helloFiles("one"));
    await committed(owner, app, helloFiles("two"));
    await rollback(env, appKind, owner, app, 1);
    await rollback(env, appKind, owner, app, 2);
    const first = await loadRelease(env, app, 1);
    const second = await loadRelease(env, app, 2);
    const shared = new Set(second.manifest.artifacts.map((a) => a.sha256));
    const own = first.manifest.artifacts.find(
      ({ path, sha256 }) => path.startsWith("modules/") && !shared.has(sha256)
    );
    const key = await artifactKey(own?.sha256 ?? "");
    const stored = await env.FILES.get(key);
    // The isolate's cache of verified releases is warm from the load above.
    await env.FILES.put(key, `${(await stored?.text()) ?? ""} `);
    expect({
      refused: await failure(
        async () => await rollback(env, appKind, owner, app, 1)
      ),
      current: await currentOf(app),
    }).toStrictEqual({ refused: "version.artifact_corrupt", current: 2 });
  });

  it("counts a version published only while the release it tested is stored, whoever deleted it", async () => {
    const { owner, app } = await appWith(helloFiles("one"));
    await committed(owner, app, helloFiles("two"));
    await rollback(env, appKind, owner, app, 1);
    await rollback(env, appKind, owner, app, 2);
    // Deleted as an earlier release of core's sweep deletes it: the
    // version's own columns untouched.
    await env.DB.prepare(
      "DELETE FROM sdk_release_manifests WHERE app_id = ? AND version = 1"
    )
      .bind(app)
      .run();
    const status = await statusOf(app, 1);
    const byHand = await refusedByHand(app, 1);
    const back = await rollback(env, appKind, owner, app, 1);
    expect({
      status,
      byHand,
      current: back.version,
      published: await audited(app, "app.version.built"),
    }).toStrictEqual({
      status: "published",
      byHand: true,
      current: 1,
      // Sealed anew and tested again before it ran.
      published: [
        ["app.version.built", 1],
        ["app.version.built", 2],
        ["app.version.built", 1],
      ],
    });
  });

  it("records a failure no code names as an unexpected one, and leaves the current version", async () => {
    const { owner, app } = await appWith(helloFiles("one"));
    await rollback(env, appKind, owner, app, 1);
    const next = await committed(owner, app, helloFiles("two"));
    const put = env.FILES.put.bind(env.FILES);
    Reflect.set(env.FILES, "put", async () => {
      await Promise.resolve();
      throw new Error("R2 is unavailable");
    });
    let refused: string;
    try {
      refused = await failure(
        async () => await rollback(env, appKind, owner, app, next)
      );
    } finally {
      Reflect.set(env.FILES, "put", put);
    }
    expect({
      refused,
      current: await currentOf(app),
      status: await statusOf(app, next),
      failed: await audited(app, "app.version.publish_failed"),
    }).toStrictEqual({
      refused: "Error: R2 is unavailable",
      current: 1,
      status: "failed",
      failed: [["app.version.publish_failed", 2, "internal.unexpected"]],
    });
  });

  it("is refused, writing nothing, to someone who no longer builds the App", async () => {
    const { owner, app } = await appWith(helloFiles());
    const other = await person("builder");
    await addMember(env, owner, app, {
      type: "person",
      id: other.userId,
      role: "builder",
    });
    await removeMember(env, owner, app, { type: "person", id: other.userId });
    expect({
      refused: await failure(
        async () => await rollback(env, appKind, other, app, 1)
      ),
      current: await currentOf(app),
      status: await statusOf(app, 1),
      sealed: await failure(async () => await loadRelease(env, app, 1)),
    }).toStrictEqual({
      refused: "app.not_found",
      current: null,
      status: null,
      sealed: "version.not_sealed",
    });
  });

  it("refuses a row written already current, new or replacing an App, whoever writes", async () => {
    const { owner, app } = await appWith(helloFiles());
    await rollback(env, appKind, owner, app, 1);
    await committed(owner, app, helloFiles("two"));
    const forged = crypto.randomUUID();
    const inserted = await failure(
      async () =>
        await env.DB.prepare(
          `INSERT INTO apps (id, name, description, owner_id, current_version, created_at)
           SELECT ?, 'Forged', '', owner_id, 1, 0 FROM apps WHERE id = ?`
        )
          .bind(forged, app)
          .run()
    );
    const replaced = await failure(
      async () =>
        await env.DB.prepare(
          `INSERT OR REPLACE INTO apps (id, name, description, owner_id, current_version, created_at)
           SELECT id, name, description, owner_id, 2, created_at FROM apps WHERE id = ?`
        )
          .bind(app)
          .run()
    );
    expect({
      inserted: inserted.includes("apps are made current"),
      replaced: replaced.includes("apps are made current"),
      current: await currentOf(app),
    }).toStrictEqual({ inserted: true, replaced: true, current: 1 });
  });
});

import type { Json } from "@grasp-os/shared/json";
import type { OperationResult } from "@grasp-os/shared/operations";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { callAppFunction } from "../src/app-functions.ts";
import type { Release } from "../src/app-releases.ts";
import { setCurrentVersion } from "../src/apps.ts";
import { appMembers } from "../src/db/core/schema.ts";
import { appWith, person, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";

// What App code keeps of one invocation never acts in another (GRA-383,
// GRA-387), through the real Loader: every invocation runs in a fresh
// isolate of its own, and its channel stops working when it ends. The
// held-call reproduction from GRA-383, the channel kept past its call,
// and state one caller leaves for the next. A call cut short at its
// deadline is app-functions.test.ts's ("a call past its deadline").

const files: Record<string, string> = {
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({ title: v.string().min(1).max(200) }),
});
`,
  "operations/notes.ts": `import { AppError, v } from "@grasp-os/sdk";
import { action, mutation, query } from "#grasp/server";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const create = mutation({
  args: { title: v.string().min(1).max(200) },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

export const titles = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("notes").take(100)).map((note) => note.title).sort(),
});

/** Keeps its caller's channel where any later call in this isolate finds it, and holds the call open. */
export const hold = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    globalThis.kept = ctx;
    await ctx.db.insert("notes", { title: "A's own" });
    await wait(1500);
    return null;
  },
});

/** Writes through whatever channel an earlier call left behind. */
export const useKept = mutation({
  args: {},
  returns: v.string(),
  handler: async () => {
    const kept = globalThis.kept;
    if (kept === undefined) {
      return "nothing kept";
    }
    await kept.db.insert("notes", { title: "written as A" });
    return "wrote as A";
  },
});

/** Keeps its channel for work that runs after the call has answered. */
export const keepAfter = action({
  args: {},
  returns: v.null(),
  uses: [create],
  handler: (ctx) => {
    setTimeout(() => {
      void ctx.runMutation(create, { title: "after the call" }).catch(() => undefined);
    }, 200);
    return null;
  },
});

/** Leaves what it can for the next caller: module state, globals, a changed SDK class. */
export const poison = query({
  args: {},
  returns: v.null(),
  handler: () => {
    globalThis.poisoned = "by the first caller";
    Object.prototype.polluted = "by the first caller";
    AppError.prototype.leaked = "by the first caller";
    return null;
  },
});

/** What the previous callers left, as this call finds it. */
export const probe = query({
  args: {},
  returns: v.array(v.string()),
  handler: () => [
    String(globalThis.poisoned ?? "clean"),
    String(({}).polluted ?? "clean"),
    String(AppError.prototype.leaked ?? "clean"),
  ],
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { create, hold, keepAfter, poison, probe, titles, useKept } from "./operations/notes.ts";
import schema from "./schema.ts";

export default app({
  name: "Isolation",
  schema,
  access: { tables: { notes: { read: "appMembers", write: "appMembers" } } },
  operations: { notes: { create, titles, hold, useKept, keepAfter, poison, probe } },
  internalOperations: {},
  screens: [],
  uses: [],
});
`,
};

type Sealed = Fixture & { release: Release };
type Caller = Fixture["owner"];

/** The App, sealed and current, used by its builder and by `others`. */
const sealedApp = async (): Promise<Sealed & { other: Caller }> => {
  const fixture = await appWith(files);
  const release = await seal(fixture);
  await setCurrentVersion(env, fixture.owner, fixture.app, 1);
  const other = await person("user");
  await drizzle(env.DB).insert(appMembers).values({
    appId: fixture.app,
    memberType: "person",
    memberId: other.userId,
    role: "user",
    addedBy: fixture.owner.userId,
    addedAt: new Date(),
  });
  return { ...fixture, release, other };
};

/** Calls `path` of the App for `by`, as a screen sends it. */
const call = async (
  { app, release }: Sealed,
  by: Caller,
  path: string,
  input: Json = {}
): Promise<OperationResult> => {
  const operation = release.app.operations[path];
  const { result } = await callAppFunction(
    env,
    by,
    app,
    JSON.stringify({
      reference: {
        resourceId: release.manifest.resourceId,
        resourceVersion: release.manifest.resourceVersion,
        contractId: path,
        fingerprint: release.fingerprints[path],
        kind: operation?.kind,
      },
      input,
    })
  );
  return result;
};

describe("an invocation's authority", { timeout: 120_000 }, () => {
  it("never reaches another caller's call held open alongside it", async () => {
    const isolated = await sealedApp();
    const held = call(isolated, isolated.owner, "notes.hold");
    // B calls while A's call is held, its channel kept in module state.
    await scheduler.wait(300);
    const used = await call(isolated, isolated.other, "notes.useKept");
    expect(used).toStrictEqual({ ok: true, value: "nothing kept" });
    await expect(held).resolves.toStrictEqual({ ok: true, value: null });
    await expect(
      call(isolated, isolated.owner, "notes.titles")
    ).resolves.toStrictEqual({
      ok: true,
      value: ["A's own"],
    });
  });

  it("ends with its call: a channel kept for later writes nothing", async () => {
    const isolated = await sealedApp();
    await expect(
      call(isolated, isolated.owner, "notes.keepAfter")
    ).resolves.toStrictEqual({
      ok: true,
      value: null,
    });
    await scheduler.wait(1000);
    await expect(
      call(isolated, isolated.owner, "notes.titles")
    ).resolves.toStrictEqual({
      ok: true,
      value: [],
    });
  });

  it("leaves nothing of one caller's in the cached release for the next", async () => {
    const isolated = await sealedApp();
    await expect(
      call(isolated, isolated.owner, "notes.poison")
    ).resolves.toStrictEqual({
      ok: true,
      value: null,
    });
    // The same release, from the verified cache, for another person and
    // for the same one again.
    for (const by of [isolated.other, isolated.owner]) {
      // oxlint-disable-next-line no-await-in-loop -- one caller after the other
      await expect(call(isolated, by, "notes.probe")).resolves.toStrictEqual({
        ok: true,
        value: ["clean", "clean", "clean"],
      });
    }
  });
});

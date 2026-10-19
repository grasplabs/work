// An App of spec 8's layout whose functions try to carry one invocation's
// authority into another (GRA-383, GRA-387): `hold` keeps its channel in
// module state and holds its call open until a "release" note appears,
// `useKept` writes through whatever channel an earlier call left,
// `keepAfter` schedules work for after its call, `late` writes after a
// wait longer than a short deadline, and `poison` leaves what
// it can for the next caller, which `probe` reports. Shared by every path
// that calls an App's functions: a screen's, an agent's and a workflow
// run's (app-invocation-isolation.test.ts, run-functions.test.ts).

/** The App's files, its `notes` table readable and writable by its members. */
export const isolationFiles: Record<string, string> = {
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({ title: v.string().min(1).max(200) }),
});
`,
  "operations/notes.ts": `import { AppError, v } from "@grasp-os/sdk";
import { action, mutation, query } from "#grasp/server";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// What these functions leave for later callers, typed loose on purpose:
// they reach where an App's code never should.
type Kept = { runMutation: (reference: unknown, args: unknown) => Promise<unknown> };
const shared = globalThis as unknown as { kept?: Kept; poisoned?: string };
const loose = (value: object) => value as Record<string, unknown>;

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

/**
 * Keeps its caller's channel where any later call in this isolate finds
 * it, says so with a note ("A holding"), and holds the call open until a
 * "release" note appears: the test sees A hold, and keeps it holding
 * until B has finished.
 */
export const hold = action({
  args: {},
  returns: v.null(),
  uses: [create, titles],
  handler: async (ctx) => {
    shared.kept = ctx as unknown as Kept;
    await ctx.runMutation(create, { title: "A holding" });
    for (let polls = 0; polls < 50; polls += 1) {
      const seen = await ctx.runQuery(titles, {});
      if (seen.includes("release")) {
        return null;
      }
      await wait(200);
    }
    throw new AppError("hold.not_released", "Nobody released the call.");
  },
});

/** Writes through whatever channel an earlier call left behind. */
export const useKept = mutation({
  args: {},
  returns: v.string(),
  handler: async () => {
    const kept = shared.kept;
    if (kept === undefined) {
      return "nothing kept";
    }
    await kept.runMutation(create, { title: "written as A" });
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

/** Writes once a wait longer than its caller's deadline is over. */
export const late = action({
  args: {},
  returns: v.null(),
  uses: [create],
  handler: async (ctx) => {
    await wait(4000);
    await ctx.runMutation(create, { title: "too late" });
    return null;
  },
});

/** Leaves what it can for the next caller: module state, globals, a changed SDK class. */
export const poison = query({
  args: {},
  returns: v.null(),
  handler: () => {
    shared.poisoned = "by the first caller";
    loose(Object.prototype).polluted = "by the first caller";
    loose(AppError.prototype).leaked = "by the first caller";
    return null;
  },
});

/** What the previous callers left, as this call finds it. */
export const probe = query({
  args: {},
  returns: v.array(v.string()),
  handler: () => [
    String(shared.poisoned ?? "clean"),
    String(loose({}).polluted ?? "clean"),
    String(loose(AppError.prototype).leaked ?? "clean"),
  ],
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { create, hold, keepAfter, late, poison, probe, titles, useKept } from "./operations/notes.ts";
import schema from "./schema.ts";

export default app({
  name: "Isolation",
  schema,
  access: { tables: { notes: { read: "appMembers", write: "appMembers" } } },
  operations: { notes: { create, titles, hold, useKept, keepAfter, late, poison, probe } },
  internalOperations: {},
  screens: [],
  uses: [],
});
`,
};

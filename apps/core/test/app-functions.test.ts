import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import type { OperationResult } from "@grasp-os/shared/operations";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import {
  callAppFunction,
  functionRequestMaxBytes,
} from "../src/app-functions.ts";
import type { FunctionAnswer } from "../src/app-functions.ts";
import type { Release } from "../src/app-releases.ts";
import { commitFiles, setCurrentVersion } from "../src/apps.ts";
import {
  appMembers,
  sdkReleaseManifests,
  sdkResourceBindings,
} from "../src/db/core/schema.ts";
import { appWith, artifactKey, person, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";

// An App's functions run from its sealed release, each invocation in an
// isolate of its own, through core's operation host (spec 6, 8, 16,
// 32.6): the complete Notes operations end to end against a real store,
// then the ways a caller, App code or storage could try to reach
// another App's data, run another contract or keep something of one
// caller's for another.

const notesFiles = (label = "Notes"): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export const noteFields = {
  title: v.string().trim().min(1).max(200),
  body: v.string().max(100_000).default(""),
};

export default defineSchema({
  notes: defineTable(noteFields).index("by_updated", ["_updatedAt"]),
});
`,
  "operations/notes.ts": `import {
  AppError,
  paginationOptionsValidator,
  paginationResultValidator,
  v,
} from "@grasp-os/sdk";
import { internal } from "#grasp/server-references";
import { action, doc, internalQuery, mutation, query } from "#grasp/server";
import { noteFields } from "../schema.ts";

export const list = query({
  args: { pagination: paginationOptionsValidator },
  returns: paginationResultValidator(doc("notes")),
  handler: async (ctx, args) =>
    await ctx.db.query("notes").withIndex("by_updated").order("desc").paginate(args.pagination),
});

export const get = query({
  args: { id: v.id("notes") },
  returns: doc("notes").nullable(),
  handler: async (ctx, args) => await ctx.db.get("notes", args.id),
});

export const create = mutation({
  args: { title: noteFields.title, body: noteFields.body },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

export const update = mutation({
  args: {
    id: v.id("notes"),
    expectedRevision: v.number().integer().min(1),
    title: noteFields.title,
    body: v.string().max(100_000),
  },
  returns: doc("notes"),
  handler: async (ctx, args) => {
    const previous = await ctx.db.get("notes", args.id, { expectedRevision: args.expectedRevision });
    if (!previous) {
      throw new AppError("note.not_found", "The note is unavailable.");
    }
    await ctx.db.patch(
      "notes",
      args.id,
      { title: args.title, body: args.body },
      { expectedRevision: args.expectedRevision }
    );
    const updated = await ctx.db.get("notes", args.id);
    if (!updated) {
      throw new AppError("note.not_found", "The note is unavailable.");
    }
    return updated;
  },
});

export const remove = mutation({
  args: { id: v.id("notes"), expectedRevision: v.number().integer().min(1) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.delete("notes", args.id, { expectedRevision: args.expectedRevision });
    return null;
  },
});

export const count = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const notes = await ctx.db.query("notes").take(100);
    return notes.length;
  },
});

export const tally = action({
  args: {},
  returns: v.number(),
  uses: [internal.notes.count],
  handler: async (ctx) => await ctx.runQuery(internal.notes.count, {}),
});

let kept = "";
let calls = 0;

/** Counts its calls in module state: a fresh isolate counts from 0. */
export const bump = query({
  args: {},
  returns: v.number(),
  handler: () => {
    calls += 1;
    return calls;
  },
});

/** Keeps a caller's secret in module state, for the next call to find. */
export const remember = query({
  args: { secret: v.string() },
  returns: v.string(),
  handler: (_ctx, args) => {
    const before = kept;
    kept = args.secret;
    return before;
  },
});

/** Tries to reach the internet, and the runtime's cache. */
export const reach = query({
  args: { how: v.enum(["fetch", "cache"]) },
  returns: v.string(),
  handler: async (_ctx, args) => {
    if (args.how === "fetch") {
      await fetch("https://example.com/");
    } else {
      await caches.default.match("https://example.com/");
    }
    return "reached";
  },
});

/** Returns more than any function may. */
export const flood = query({
  args: {},
  returns: v.string(),
  handler: () => "x".repeat(2 * 1024 * 1024),
});

/** Fails on purpose, as a domain failure. */
export const closed = query({
  args: {},
  returns: v.null(),
  handler: () => {
    throw new AppError("notes.closed", "Notes are closed.", { reason: "maintenance" });
  },
});

/** Reads a note at a revision it hasn't, and handles the conflict itself. */
export const checkRevision = query({
  args: { id: v.id("notes"), expectedRevision: v.number().integer().min(1) },
  returns: v.string(),
  handler: async (ctx, args) => {
    try {
      await ctx.db.get("notes", args.id, { expectedRevision: args.expectedRevision });
      return "current";
    } catch (error) {
      if (error instanceof Error && Reflect.get(error, "code") === "data.conflict") {
        return "changed";
      }
      throw error;
    }
  },
});

/** Answers NaN where its contract allows a number or null. */
export const notANumber = query({
  args: {},
  returns: v.number().nullable(),
  handler: () => Number.NaN,
});

/** Answers an undefined in an array, which JSON would make a null. */
export const holey = query({
  args: {},
  returns: v.array(v.string().nullable()),
  handler: () => [undefined],
});

/** Waits past any deadline a test gives it, then writes. */
export const lateWrite = action({
  args: {},
  returns: v.null(),
  uses: [create],
  handler: async (ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await ctx.runMutation(create, { title: "Too late", body: "" });
    return null;
  },
});

/** What the SDK module it runs with marked, if it marked anything. */
export const sdkMark = query({
  args: {},
  returns: v.string(),
  handler: () => String(Reflect.get(globalThis, "sealedSdkMark") ?? "unmarked"),
});

let reads = 0;

/**
 * A reference that names one function to the registration (its two
 * reads in an isolate: the constructor's and the App's) and another to
 * everything after: the runner asks for a mutation the action never
 * listed.
 */
const shifty = {
  get contractId() {
    reads += 1;
    return reads <= 2 ? "notes.count" : "notes.create";
  },
  visibility: "internal",
};

/** Runs what its reference names now, and says how that ended. */
export const sneak = action({
  args: {},
  returns: v.string(),
  uses: [shifty as never],
  handler: async (ctx) => {
    try {
      await ctx.runMutation(shifty as never, { title: "Sneaked" });
      return "ran";
    } catch (error) {
      return \`caught \${String(Reflect.get(Object(error), "code"))}\`;
    }
  },
});

/** What the Workers runtime's env holds, reached around the import rules. */
export const peekEnv = query({
  args: {},
  returns: v.string(),
  handler: async () => {
    try {
      const workers = await new Function("return import('cloudflare:workers')")();
      return JSON.stringify(Object.keys(workers.env ?? {}));
    } catch (error) {
      return \`refused \${error instanceof Error ? error.name : "?"}\`;
    }
  },
});

/** Runs a query that fails as a domain failure, and recovers from it. */
export const recover = action({
  args: {},
  returns: v.string(),
  uses: [closed],
  handler: async (ctx) => {
    try {
      await ctx.runQuery(closed, {});
      return "open";
    } catch (error) {
      if (error instanceof AppError) {
        return \`recovered from \${error.code}\`;
      }
      throw error;
    }
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import {
  bump, checkRevision, closed, count, create, flood, get, list, peekEnv, reach, recover, remember, remove, sdkMark, sneak, tally, update, notANumber, holey, lateWrite,
} from "./operations/notes.ts";
import schema from "./schema.ts";

export default app({
  name: ${JSON.stringify(label)},
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: {
    notes: { list, get, create, update, remove, tally, bump, remember, reach, flood, closed, checkRevision, recover, sneak, peekEnv, sdkMark, notANumber, holey, lateWrite },
  },
  internalOperations: { notes: { count } },
  screens: [],
  uses: [],
});
`,
});

type Sealed = Fixture & { release: Release };

/** A Notes App, sealed and current. */
const sealedNotes = async (
  files: Record<string, string> = notesFiles()
): Promise<Sealed> => {
  const fixture = await appWith(files);
  const release = await seal(fixture);
  await setCurrentVersion(env, fixture.owner, fixture.app, 1);
  return { ...fixture, release };
};

/** The reference to `path` of `release`, as the generated `api` has it. */
const referenceTo = (release: Release, path: string) => {
  const operation = release.app.operations[path];
  if (operation === undefined) {
    throw new Error(`No ${path}`);
  }
  return {
    resourceId: release.manifest.resourceId,
    resourceVersion: release.manifest.resourceVersion,
    contractId: path,
    fingerprint: release.fingerprints[path] ?? "",
    kind: operation.kind,
  };
};

type Caller = Fixture["owner"];

/** Calls `path` of the fixture's App for `by`, as a screen sends it. */
const call = async (
  { app, release }: Sealed,
  by: Caller,
  path: string,
  input: unknown,
  reference: Partial<ReturnType<typeof referenceTo>> = {}
): Promise<FunctionAnswer> =>
  await callAppFunction(
    env,
    by,
    app,
    JSON.stringify({
      reference: { ...referenceTo(release, path), ...reference },
      input,
    })
  );

/** Shares the fixture's App with `by`, in `role`. */
const share = async (
  { app, owner }: Sealed,
  by: Caller,
  role: "user" | "builder" = "user"
): Promise<void> => {
  await drizzle(env.DB).insert(appMembers).values({
    appId: app,
    memberType: "person",
    memberId: by.userId,
    role,
    addedBy: owner.userId,
    addedAt: new Date(),
  });
};

/** The value of a call that succeeded; fails the test otherwise. */
const valueOf = ({ result }: { result: OperationResult }): Json => {
  if (!result.ok) {
    throw new Error(`The call failed: ${result.error.code}`);
  }
  return result.value;
};

/** The error code of a call that failed, or "ok". */
const codeOf = ({ result }: { result: OperationResult }): string =>
  result.ok ? "ok" : result.error.code;

/** Whether `value` is a JSON object: `Array.isArray` doesn't narrow a readonly array. */
const isObject = (
  value: Json | undefined
): value is Readonly<Record<string, Json | undefined>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A field of a JSON object. */
const field = (value: Json | undefined, key: string): Json | undefined =>
  isObject(value) ? value[key] : undefined;

/** The titles of the notes on a page. */
const titlesOn = (page: Json): (Json | undefined)[] => {
  const items = field(page, "items");
  if (!Array.isArray(items)) {
    return [];
  }
  const notes: readonly Json[] = items;
  return notes.map((note) => field(note, "title"));
};

describe("an App's functions", { timeout: 120_000 }, () => {
  it("run the complete Notes operations from the sealed release, in its sandbox", async () => {
    const notes = await sealedNotes();
    const id = valueOf(
      await call(notes, notes.owner, "notes.create", { title: "  Launch  " })
    );
    const created = valueOf(
      await call(notes, notes.owner, "notes.get", { id })
    );
    expect(created).toMatchObject({
      _id: id,
      title: "Launch",
      body: "",
      _rev: 1,
    });
    const updated = valueOf(
      await call(notes, notes.owner, "notes.update", {
        id,
        expectedRevision: 1,
        title: "Launch day",
        body: "Ship it",
      })
    );
    expect(updated).toMatchObject({
      title: "Launch day",
      body: "Ship it",
      _rev: 2,
    });
    const page = valueOf(
      await call(notes, notes.owner, "notes.list", { pagination: {} })
    );
    expect(field(page, "items")).toStrictEqual([updated]);
    expect(
      valueOf(
        await call(notes, notes.owner, "notes.remove", {
          id,
          expectedRevision: 2,
        })
      )
    ).toBeNull();
    expect(
      valueOf(await call(notes, notes.owner, "notes.get", { id }))
    ).toBeNull();
  });

  it("answer what the store refused, and the App's own failures, as their callers may see them", async () => {
    const notes = await sealedNotes();
    const id = valueOf(
      await call(notes, notes.owner, "notes.create", { title: "Launch" })
    );
    // A stale revision: the store's refusal crosses the isolate whole.
    const stale = await call(notes, notes.owner, "notes.update", {
      id,
      expectedRevision: 5,
      title: "Launch day",
      body: "",
    });
    expect(stale.result).toMatchObject({
      ok: false,
      error: { code: "data.conflict", category: "domain" },
    });
    const closed = await call(notes, notes.owner, "notes.closed", {});
    expect(closed.result).toMatchObject({
      ok: false,
      error: {
        code: "notes.closed",
        message: "Notes are closed.",
        category: "domain",
        details: { reason: "maintenance" },
      },
    });
  });

  it("hand App code the host's failures whole, to branch on and recover from", async () => {
    const notes = await sealedNotes();
    const id = valueOf(
      await call(notes, notes.owner, "notes.create", { title: "Launch" })
    );
    // A store refusal, caught in the isolate by its code.
    expect(
      valueOf(
        await call(notes, notes.owner, "notes.checkRevision", {
          id,
          expectedRevision: 7,
        })
      )
    ).toBe("changed");
    // A nested domain failure, caught as the SDK's own AppError.
    expect(valueOf(await call(notes, notes.owner, "notes.recover", {}))).toBe(
      "recovered from notes.closed"
    );
  });

  it("run an action's nested calls of internal functions, each in its own isolate", async () => {
    const notes = await sealedNotes();
    await call(notes, notes.owner, "notes.create", { title: "One" });
    await call(notes, notes.owner, "notes.create", { title: "Two" });
    expect(valueOf(await call(notes, notes.owner, "notes.tally", {}))).toBe(2);
  });

  it("keep nothing of one invocation for the next: each runs in a fresh isolate", async () => {
    const notes = await sealedNotes();
    expect(valueOf(await call(notes, notes.owner, "notes.bump", {}))).toBe(1);
    expect(valueOf(await call(notes, notes.owner, "notes.bump", {}))).toBe(1);
    // One person's secret, kept in module state, never reaches another's call.
    const other = await person("builder");
    await share(notes, other);
    await call(notes, notes.owner, "notes.remember", { secret: "owner's" });
    expect(
      valueOf(await call(notes, other, "notes.remember", { secret: "other's" }))
    ).toBe("");
  });

  it("are held to what was sealed, whatever their registration says at run time", async () => {
    const notes = await sealedNotes();
    // Sealed, the action uses an internal query; run, its reference names
    // a mutation it never listed, which the host refuses.
    expect(notes.release.app.operations["notes.sneak"]?.uses).toStrictEqual([
      { type: "function", path: "notes.count", kind: "query" },
    ]);
    expect(valueOf(await call(notes, notes.owner, "notes.sneak", {}))).toBe(
      "caught operation.not_found"
    );
    const page = valueOf(
      await call(notes, notes.owner, "notes.list", { pagination: {} })
    );
    expect(titlesOn(page)).toStrictEqual([]);
  });

  it("find nothing in the Workers runtime's env, however they import it", async () => {
    const notes = await sealedNotes();
    const peeked = valueOf(await call(notes, notes.owner, "notes.peekEnv", {}));
    expect(
      peeked === "[]" ||
        (typeof peeked === "string" && peeked.startsWith("refused"))
    ).toBeTruthy();
  });

  it("can't reach the network or the runtime's cache", async () => {
    const notes = await sealedNotes();
    const fetched = await call(notes, notes.owner, "notes.reach", {
      how: "fetch",
    });
    const cached = await call(notes, notes.owner, "notes.reach", {
      how: "cache",
    });
    expect([codeOf(fetched), codeOf(cached)]).toStrictEqual([
      "internal.unexpected",
      "internal.unexpected",
    ]);
  });

  it("can't send core more than any answer may be", async () => {
    const notes = await sealedNotes();
    expect(codeOf(await call(notes, notes.owner, "notes.flood", {}))).toBe(
      "contract.result_too_large"
    );
  });

  it("act for no one who has lost access to the App", async () => {
    const notes = await sealedNotes();
    const other = await person("builder");
    await share(notes, other);
    expect(codeOf(await call(notes, other, "notes.bump", {}))).toBe("ok");
    await drizzle(env.DB)
      .delete(appMembers)
      .where(
        and(
          eq(appMembers.appId, notes.app),
          eq(appMembers.memberId, other.userId)
        )
      );
    expect(codeOf(await call(notes, other, "notes.bump", {}))).toBe(
      "app.not_found"
    );
  });
});

describe("another App's store", { timeout: 120_000 }, () => {
  it("is never reached: each release reads and writes only the store the host bound it", async () => {
    const first = await sealedNotes();
    const second = await sealedNotes();
    const id = valueOf(
      await call(first, first.owner, "notes.create", { title: "First's" })
    );
    // The same person and note ID, through another App: its own store,
    // where there is no such note.
    await share(second, first.owner, "builder");
    expect(
      valueOf(await call(second, first.owner, "notes.get", { id }))
    ).toBeNull();
    await call(second, second.owner, "notes.create", { title: "Second's" });
    const page = valueOf(
      await call(first, first.owner, "notes.list", { pagination: {} })
    );
    expect(titlesOn(page)).toStrictEqual(["First's"]);
  });

  it("can't be named by a request", async () => {
    const first = await sealedNotes();
    const answer = await callAppFunction(
      env,
      first.owner,
      first.app,
      JSON.stringify({
        reference: referenceTo(first.release, "notes.get"),
        input: { id: "0" },
        store: first.store,
      })
    );
    expect(codeOf(answer)).toBe("contract.invalid_request");
  });
});

describe(
  "a reference that isn't the contract that runs",
  { timeout: 120_000 },
  () => {
    it.each([
      [
        "another fingerprint",
        { fingerprint: "0".repeat(64) },
        "version.mismatch",
      ],
      ["another version", { resourceVersion: 2 }, "version.mismatch"],
      ["another App", { resourceId: "app_other" }, "version.mismatch"],
      [
        "another kind",
        { kind: "mutation" as const },
        "operation.kind_mismatch",
      ],
      [
        "a path nothing is at",
        { contractId: "notes.missing" },
        "operation.not_found",
      ],
    ])(
      "is refused with %s, before its input is read",
      async (_case, forged, code) => {
        const notes = await sealedNotes();
        // Input that would be refused if it were read.
        expect(
          codeOf(await call(notes, notes.owner, "notes.get", { id: 1 }, forged))
        ).toBe(code);
      }
    );

    it("is refused to an internal function as to one that doesn't exist, fingerprint and all", async () => {
      const notes = await sealedNotes();
      expect(codeOf(await call(notes, notes.owner, "notes.count", {}))).toBe(
        "operation.not_found"
      );
    });

    it("is refused once another version runs, which runs its own code", async () => {
      const notes = await sealedNotes();
      const old = referenceTo(notes.release, "notes.bump");
      await commitFiles(
        env,
        notes.owner,
        notes.app,
        notesFiles("Notes, renamed"),
        "Rename"
      );
      const next = await seal(notes, 2);
      await setCurrentVersion(env, notes.owner, notes.app, 2);
      const current = { ...notes, release: next };
      expect(
        codeOf(await call(current, notes.owner, "notes.bump", {}, old))
      ).toBe("version.mismatch");
      expect(codeOf(await call(current, notes.owner, "notes.bump", {}))).toBe(
        "ok"
      );
    });
  }
);

describe("what a function answers", { timeout: 120_000 }, () => {
  it("is read as it is, never as JSON would quietly make it", async () => {
    const notes = await sealedNotes();
    const answers = await Promise.all(
      ["notes.notANumber", "notes.holey"].map(async (path) =>
        codeOf(await call(notes, notes.owner, path, {}))
      )
    );
    expect(answers).toStrictEqual([
      "contract.invalid_return",
      "contract.invalid_return",
    ]);
  });
});

describe("a call past its deadline", { timeout: 120_000 }, () => {
  it("is stopped at the deadline, and what it does after never commits", async () => {
    const notes = await sealedNotes();
    const started = Date.now();
    const answer = await callAppFunction(
      env,
      notes.owner,
      notes.app,
      JSON.stringify({
        reference: referenceTo(notes.release, "notes.lateWrite"),
        input: {},
      }),
      started + 1000
    );
    const took = Date.now() - started;
    // Long enough for its write, had it gone through.
    await scheduler.wait(4000);
    const page = valueOf(
      await call(notes, notes.owner, "notes.list", { pagination: {} })
    );
    expect([codeOf(answer), took < 2500, titlesOn(page)]).toStrictEqual([
      "operation.deadline_exceeded",
      true,
      [],
    ]);
  });
});

describe("the SDK a release runs with", { timeout: 120_000 }, () => {
  it("is the one sealed with it, never the one the host serves now", async () => {
    const notes = await sealedNotes();
    const before = valueOf(await call(notes, notes.owner, "notes.sdkMark", {}));
    // The sealed SDK differs from the host's from here on: its root
    // module marks the isolate, every hash rewritten to match.
    const path = "sdk/@grasp-os~sdk.js";
    const entry = notes.release.manifest.artifacts.find(
      (artifact) => artifact.path === path
    );
    const stored = await env.FILES.get(artifactKey(entry?.sha256 ?? ""));
    const text = `globalThis.sealedSdkMark = "sealed";\n${(await stored?.text()) ?? ""}`;
    const sha256 = await sha256Hex(text);
    await env.FILES.put(artifactKey(sha256), text);
    const manifest = canonicalJson({
      ...notes.release.manifest,
      artifacts: notes.release.manifest.artifacts.map((artifact) =>
        artifact.path === path
          ? { path, sha256, bytes: new TextEncoder().encode(text).byteLength }
          : artifact
      ),
    });
    const hash = await sha256Hex(manifest);
    await drizzle(env.DB)
      .update(sdkReleaseManifests)
      .set({ manifest, manifestHash: hash })
      .where(eq(sdkReleaseManifests.appId, notes.app));
    await drizzle(env.DB)
      .update(sdkResourceBindings)
      .set({ manifestHash: hash })
      .where(eq(sdkResourceBindings.resourceId, notes.app));
    const after = valueOf(await call(notes, notes.owner, "notes.sdkMark", {}));
    expect([entry === undefined, before, after]).toStrictEqual([
      false,
      "unmarked",
      "sealed",
    ]);
  });
});

describe("a release changed since it was sealed", { timeout: 120_000 }, () => {
  it("doesn't run when an artifact's bytes changed", async () => {
    const notes = await sealedNotes();
    const entry = notes.release.manifest.artifacts.find(
      ({ path }) => path === "modules/app~operations~notes.js"
    );
    const stored = await env.FILES.get(artifactKey(entry?.sha256 ?? ""));
    const code = (await stored?.text()) ?? "";
    const forged = code.replace("maintenance", "maintenancf");
    expect([forged.length, forged === code]).toStrictEqual([
      code.length,
      false,
    ]);
    await env.FILES.put(artifactKey(entry?.sha256 ?? ""), forged);
    expect(codeOf(await call(notes, notes.owner, "notes.bump", {}))).toBe(
      "version.artifact_corrupt"
    );
  });

  it("doesn't run when its manifest changed", async () => {
    const notes = await sealedNotes();
    await drizzle(env.DB)
      .update(sdkReleaseManifests)
      .set({
        manifest: JSON.stringify({
          ...notes.release.manifest,
          artifactTrust: "approved",
        }),
      })
      .where(eq(sdkReleaseManifests.appId, notes.app));
    expect(codeOf(await call(notes, notes.owner, "notes.bump", {}))).toBe(
      "version.manifest_corrupt"
    );
  });
});

describe("a request", { timeout: 120_000 }, () => {
  it("is refused unread when its bytes are past the bound", async () => {
    const notes = await sealedNotes();
    // Not even JSON: it is refused for its size before it is parsed.
    const oversized = "x".repeat(functionRequestMaxBytes + 1);
    expect(
      codeOf(await callAppFunction(env, notes.owner, notes.app, oversized))
    ).toBe("contract.input_too_large");
    // Multi-byte characters count as their bytes.
    const wide = "é".repeat(Math.ceil(functionRequestMaxBytes / 2) + 1);
    expect(
      codeOf(await callAppFunction(env, notes.owner, notes.app, wide))
    ).toBe("contract.input_too_large");
  });

  it.each([
    ["isn't text", { reference: {} }],
    ["isn't JSON", "{"],
    ["lacks its reference", JSON.stringify({ input: {} })],
    [
      "has a key no request has",
      JSON.stringify({ reference: {}, input: {}, principal: "someone" }),
    ],
  ])("is refused when it %s", async (_case, request) => {
    const notes = await sealedNotes();
    expect(
      codeOf(await callAppFunction(env, notes.owner, notes.app, request))
    ).toBe("contract.invalid_request");
  });

  it("is refused when it names a frame generation, which nothing reads", async () => {
    const notes = await sealedNotes();
    const request = JSON.stringify({
      reference: referenceTo(notes.release, "notes.bump"),
      input: {},
      frameGeneration: "1",
    });
    expect(
      codeOf(await callAppFunction(env, notes.owner, notes.app, request))
    ).toBe("contract.invalid_request");
  });

  it("names no App to someone without a role in it", async () => {
    const notes = await sealedNotes();
    const stranger = await person("builder");
    expect(codeOf(await call(notes, stranger, "notes.bump", {}))).toBe(
      "app.not_found"
    );
  });
});

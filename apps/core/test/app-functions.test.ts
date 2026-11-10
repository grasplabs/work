import { sha256Hex } from "@grasp-os/shared/encoding";
import { functionRequestMaxBytes } from "@grasp-os/shared/function-limits";
import { canonicalJson, isRecord } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import type { OperationResult } from "@grasp-os/shared/operations";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction, callPageFunction } from "../src/app-functions.ts";
import type { FunctionAnswer } from "../src/app-functions.ts";
import { publishVersion } from "../src/app-publish.ts";
import type { Release } from "../src/app-releases.ts";
import {
  appMembers,
  sdkReleaseManifests,
  sdkResourceBindings,
} from "../src/db/core/schema.ts";
import { deliveryOf, standingOf } from "../src/page-delivery.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { testApp, withFiles } from "./app-definitions.ts";
import type { TestApp, TestSource } from "./app-definitions.ts";
import { commitDefined } from "./apps.ts";
import { deepFiles, fieldDepth } from "./deep-records.ts";
import {
  appWith,
  artifactKey,
  putArtifact,
  person,
  seal,
} from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";

// An App's functions run from its sealed release, each invocation in an
// isolate of its own, through core's operation host (spec 6, 8, 16,
// 32.6): the complete Notes operations end to end against a real store,
// then the ways a caller, App code or storage could try to reach
// another App's data, run another contract or keep something of one
// caller's for another.

const notesFiles = (label = "Notes"): TestApp =>
  testApp(
    {
      name: label,
      tables: {
        notes: {
          fields: {
            title: "v.string().trim().min(1).max(200)",
            body: 'v.string().max(100_000).default("")',
          },
          access: { read: "owner", write: "owner" },
          indexes: { by_updated: ["_updatedAt"] },
        },
      },
    },
    {
      "values.ts": `import { v } from "@grasp-os/sdk";

export const noteFields = {
  title: v.string().trim().min(1).max(200),
  body: v.string().max(100_000).default(""),
};
`,
      "server/notes.ts": `import {
  AppError,
  paginationOptionsValidator,
  paginationResultValidator,
  v,
} from "@grasp-os/sdk";
import { internal } from "@server/_generated/internal";
import { action, doc, internalQuery, mutation, query } from "@server/_generated/server";
import { noteFields } from "../values.ts";

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
    title: noteFields.title,
    body: v.string().max(100_000),
  },
  returns: doc("notes"),
  handler: async (ctx, args) => {
    const previous = await ctx.db.get("notes", args.id);
    if (!previous) {
      throw new AppError("note.not_found", "The note is unavailable.");
    }
    await ctx.db.patch(
      "notes",
      args.id,
      { title: args.title, body: args.body }
    );
    const updated = await ctx.db.get("notes", args.id);
    if (!updated) {
      throw new AppError("note.not_found", "The note is unavailable.");
    }
    return updated;
  },
});

export const remove = mutation({
  args: { id: v.id("notes") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.delete("notes", args.id);
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
      // The Workers runtime's cache, which the worker's types don't name.
      await (caches as unknown as { default: Cache }).default.match("https://example.com/");
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
/** Reads a page the store refuses, and branches on its code. */
export const tryBadCursor = query({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    try {
      await ctx.db.query("notes").paginate({ pageSize: 1, cursor: "not-a-cursor" });
      return "read";
    } catch (error) {
      if (error instanceof Error && Reflect.get(error, "code") === "data.invalid_cursor") {
        return "refused";
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
  handler: () => [undefined as unknown as null],
});

/** Waits past any deadline a test gives it, then writes. */
export const lateWrite = action({
  args: {},
  returns: v.null(),
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

/** References made by hand: a path the App doesn't register, and a query's. */
const missing = { name: "notes.missing", visibility: "internal" };
const misnamed = { name: "notes.count", visibility: "internal" };

/** Runs each as a mutation, and says how each ended. */
export const sneak = action({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const ended: string[] = [];
    for (const reference of [missing, misnamed]) {
      try {
        await ctx.runMutation(reference as never, { title: "Sneaked" } as never);
        ended.push("ran");
      } catch (error) {
        ended.push(String(Reflect.get(Object(error), "code")));
      }
    }
    return ended.join(" ");
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
    }
  );

type Sealed = Fixture & { release: Release };

/** A Notes App, sealed and current. */
const sealedNotes = async (
  files: TestSource = notesFiles()
): Promise<Sealed> => {
  const fixture = await appWith(files);
  const release = await seal(fixture);
  await publishVersion(env, fixture.owner, fixture.app, 1);
  return { ...fixture, release };
};

/** The reference to `path` of `release`, as the generated `api` has it. */
const referenceTo = (release: Release, path: string) => {
  const operation = release.app.operations[path];
  if (operation === undefined) {
    throw new Error(`No ${path}`);
  }
  return { name: path, kind: operation.kind };
};

type Caller = Fixture["owner"];

/** Calls `path` of the fixture's App for `by`, as a page sends it. */
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
      args: input,
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

/** A field of a JSON object. */
const field = (value: Json | undefined, key: string): Json | undefined =>
  isRecord(value) ? value[key] : undefined;

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
    });
    const updated = valueOf(
      await call(notes, notes.owner, "notes.update", {
        id,
        title: "Launch day",
        body: "Ship it",
      })
    );
    expect(updated).toMatchObject({
      title: "Launch day",
      body: "Ship it",
    });
    const page = valueOf(
      await call(notes, notes.owner, "notes.list", { pagination: {} })
    );
    expect(field(page, "items")).toStrictEqual([updated]);
    expect(
      valueOf(
        await call(notes, notes.owner, "notes.remove", {
          id,
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
    // A record that is gone: the store's refusal crosses the isolate whole.
    await call(notes, notes.owner, "notes.remove", { id });
    const gone = await call(notes, notes.owner, "notes.remove", { id });
    expect(gone.result).toMatchObject({
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
    // A store refusal, caught in the isolate by its code.
    expect(
      valueOf(await call(notes, notes.owner, "notes.tryBadCursor", {}))
    ).toBe("refused");
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

  it("call only what the sealed App registers, of the kind asked, whatever a reference names at run time", async () => {
    const notes = await sealedNotes();
    // A path the release doesn't register, and a query run as a mutation:
    // the host refuses both, and nothing is written.
    expect(valueOf(await call(notes, notes.owner, "notes.sneak", {}))).toBe(
      "function.not_found function.kind_mismatch"
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
        args: { id: "0" },
        store: first.store,
      })
    );
    expect(codeOf(answer)).toBe("contract.invalid_request");
  });
});

// A page names a function by its name and kind, nothing more, and core
// resolves the name in the App's current release, checking what the call
// passes with that function's own validator. Threat model, each closed
// here: a reference forged to name something else, or to carry a version
// or contract; a call of an internal function; arguments the function
// doesn't take; a page still open after a publish, calling a function the
// new version changed or dropped; a lease kept from an older version, which
// never makes core run that version's code (page-delivery.test.ts
// replays one through the page's route). Calls between Apps stay pinned by
// their reviewed binding (app-function-calls.test.ts).
describe("a page's call, by a function's name", { timeout: 120_000 }, () => {
  it.each([
    ["another kind", { kind: "mutation" as const }, "function.kind_mismatch"],
    ["a name nothing is at", { name: "notes.missing" }, "function.not_found"],
    [
      "a version beside the name",
      { resourceVersion: 1 },
      "contract.invalid_request",
    ],
    [
      "a contract beside the name",
      { fingerprint: "0".repeat(64) },
      "contract.invalid_request",
    ],
  ])(
    "is refused with %s, before its input is read",
    async (_case, forged, code) => {
      const notes = await sealedNotes();
      // Input that would be refused if it were read.
      expect(
        codeOf(
          await callAppFunction(
            env,
            notes.owner,
            notes.app,
            JSON.stringify({
              reference: {
                ...referenceTo(notes.release, "notes.get"),
                ...forged,
              },
              args: { id: 1 },
            })
          )
        )
      ).toBe(code);
    }
  );

  it("finds nothing at a name that only imitates a function's, while the name itself answers", async () => {
    const notes = await sealedNotes();
    const imitations = [
      // The prototype of whatever map resolves a name.
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
      "notes.__proto__",
      "notes.get.__proto__",
      "notes.constructor",
      // Empty segments, padding, other separators and another case.
      "notes..get",
      ".notes.get",
      "notes.get.",
      " notes.get",
      "notes.get ",
      "notes/get",
      "notes:get",
      "NOTES.get",
      "notes.GET",
      // An internal function.
      "notes.count",
      // The names the host answers itself: people, workflows.
      "people.__proto__",
      "people.constructor",
      "workflows.x.queries.constructor",
      "workflows.__proto__.queries.runs",
    ];
    const codes = new Map<string, string>();
    for (const name of imitations) {
      // One at a time: each is its own call, and order doesn't matter.
      // oxlint-disable-next-line no-await-in-loop
      const answer = await callAppFunction(
        env,
        notes.owner,
        notes.app,
        JSON.stringify({ reference: { name, kind: "query" }, args: {} })
      );
      codes.set(name, codeOf(answer));
    }
    const noteId = valueOf(
      await call(notes, notes.owner, "notes.create", { title: "Real" })
    );
    codes.set(
      "notes.get",
      codeOf(await call(notes, notes.owner, "notes.get", { id: noteId }))
    );
    expect(codes).toStrictEqual(
      new Map([
        ...imitations.map((name) => [name, "function.not_found"] as const),
        ["notes.get", "ok"],
      ])
    );
  });

  it("is refused to an internal function as to one that doesn't exist", async () => {
    const notes = await sealedNotes();
    expect(codeOf(await call(notes, notes.owner, "notes.count", {}, {}))).toBe(
      "function.not_found"
    );
  });

  it("is checked by the function's own validator", async () => {
    const notes = await sealedNotes();
    expect({
      wrongType: codeOf(await call(notes, notes.owner, "notes.get", { id: 1 })),
      undeclared: codeOf(
        await call(notes, notes.owner, "notes.bump", { extra: true })
      ),
      missing: codeOf(await call(notes, notes.owner, "notes.create", {})),
    }).toStrictEqual({
      wrongType: "contract.invalid_args",
      undeclared: "contract.invalid_args",
      missing: "contract.invalid_args",
    });
  });

  it("recovers a save sent again under its key after a publish that gives its arguments a new default", async () => {
    const notes = await sealedNotes();
    const save = async (): Promise<unknown> => {
      const answered = await callAppFunction(
        env,
        notes.owner,
        notes.app,
        JSON.stringify({
          reference: { name: "notes.create", kind: "mutation" },
          args: { title: "Kept" },
          idempotencyKey: "save-once",
        })
      );
      return answered.result.ok ? answered.result.value : codeOf(answered);
    };
    const first = await save();
    // Version 2 gives `create` an argument with a default, which the
    // version normalizes the same input to.
    let files = notesFiles();
    const operations = files.files["server/notes.ts"] ?? "";
    const create = `export const create = mutation({
  args: { title: noteFields.title, body: noteFields.body },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});`;
    expect(operations).toContain(create);
    files = withFiles(files, {
      "server/notes.ts": operations.replace(
        create,
        `export const create = mutation({
  args: { title: noteFields.title, body: noteFields.body, tag: v.string().default("none") },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", { title: args.title, body: args.body }),
});`
      ),
    });
    await commitDefined(env, notes.owner, notes.app, files, "Tag");
    await seal(notes, 2);
    await publishVersion(env, notes.owner, notes.app, 2);
    const again = await save();
    const page = valueOf(
      await call(notes, notes.owner, "notes.list", { pagination: {} })
    );
    expect({ again, titles: titlesOn(page) }).toStrictEqual({
      again: first,
      titles: ["Kept"],
    });
  });

  it("is answered by the version current now, from a page still open on the one before", async () => {
    const notes = await sealedNotes();
    const opened = {
      get: referenceTo(notes.release, "notes.get"),
      bump: referenceTo(notes.release, "notes.bump"),
    };
    // Version 2 renames `get`'s argument and takes `bump` out of its API.
    let files = notesFiles("Notes, renamed");
    const operations = files.files["server/notes.ts"] ?? "";
    const get = `export const get = query({
  args: { id: v.id("notes") },
  returns: doc("notes").nullable(),
  handler: async (ctx, args) => await ctx.db.get("notes", args.id),
});`;
    expect(operations).toContain(get);
    files = withFiles(files, {
      "server/notes.ts": operations
        .replace(
          get,
          get
            .replace("{ id: v.id", "{ noteId: v.id")
            .replace("args.id", "args.noteId")
        )
        .replace(
          "export const bump = query(",
          "export const bump = internalQuery("
        ),
    });
    await commitDefined(env, notes.owner, notes.app, files, "Rename");
    await seal(notes, 2);
    await publishVersion(env, notes.owner, notes.app, 2);
    const fromPage = async (
      reference: ReturnType<typeof referenceTo>,
      input: unknown
    ): Promise<string> =>
      codeOf(
        await callPageFunction(
          env,
          notes.owner,
          notes.app,
          JSON.stringify({ reference, args: input }),
          Date.now() + 30_000
        )
      );
    const noteId = valueOf(
      await call(notes, notes.owner, "notes.create", { title: "Kept" })
    );
    const before = {
      changed: await fromPage(opened.get, { id: noteId }),
      renamed: await fromPage(opened.get, { noteId }),
      gone: await fromPage(opened.bump, {}),
    };
    // Version 1's release revoked: the calls are version 2's, so they go on,
    // while a build opened on version 1 gets nothing more.
    await revokeRelease(
      env,
      await person("admin"),
      { app: notes.app, version: 1 },
      "Leaks data"
    );
    expect({
      before,
      afterRevoked: await fromPage(opened.get, { noteId }),
      oldBuild: deliveryOf(
        await standingOf(env, notes.app, {
          artifact: "a".repeat(64),
          version: 1,
        })
      ),
    }).toStrictEqual({
      before: {
        changed: "contract.invalid_args",
        renamed: "ok",
        gone: "function.not_found",
      },
      afterRevoked: "ok",
      oldBuild: "revoked",
    });
  });
});

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

/**
 * An App whose functions, one of each kind, declare no `returns`: what
 * each handler answers is its return, held only to JSON and the output
 * limit; one that returns nothing answers null.
 */
const undeclaredReturnFiles: TestApp = testApp(
  {
    name: "Greetings",
    tables: {
      notes: {
        fields: { title: "v.string()" },
        access: { read: "owner", write: "owner" },
      },
    },
  },
  {
    "server/notes.ts": `import { v } from "@grasp-os/sdk";
import { action, mutation, query } from "@server/_generated/server";

export const greet = query({
  args: { who: v.string() },
  handler: (_ctx, args) => \`Hello, \${args.who}\`,
});

export const create = mutation({
  args: { title: v.string() },
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

export const greetTwice = action({
  args: {},
  handler: async (ctx) => ({
    greetings: [
      await ctx.runQuery(greet, { who: "one" }),
      await ctx.runQuery(greet, { who: "two" }),
    ],
  }),
});

export const notJson = query({ args: {}, handler: () => Number.NaN });

export const nothing = mutation({ args: {}, handler: async () => {} });

export const flood = query({ args: {}, handler: () => "x".repeat(2 * 1024 * 1024) });
`,
  }
);

/**
 * An App that reads the clock and randomness in each kind of function,
 * every way the platform has of reading them: the platform's own
 * functions as App code held them before the host started anything, the
 * real `Date`'s `now` through its descriptor, the performance timeline, a
 * formatter given no date, and a new file's and mark's time. `roll` fails
 * with what it read, and what a query it runs read, so nothing commits
 * and its caller may send it again under its key.
 */
const diceFiles: TestApp = testApp(
  {
    name: "Dice",
    tables: {
      rolls: {
        fields: { uuid: "v.string()" },
        access: { read: "owner", write: "owner" },
      },
    },
  },
  {
    "server/dice.ts": `import { AppError, v } from "@grasp-os/sdk";
import { action, mutation, query } from "@server/_generated/server";

const heldRandom = Math.random;
const heldNow = Date.now;
const formatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
});

/**
 * What \`Reflect.construct\`, replaced while a file is made, is handed to
 * construct: a file of it, made as the platform makes one, if any.
 */
const swappedConstruct = () => {
  const real = Reflect.construct;
  let handed: unknown;
  Object.defineProperty(Reflect, "construct", {
    configurable: true,
    writable: true,
    value: (target: never, args: never, newTarget?: never) => {
      handed = target;
      return real(target, args, newTarget);
    },
  });
  try {
    new File([], "a");
  } finally {
    Object.defineProperty(Reflect, "construct", { configurable: true, writable: true, value: real });
  }
  return typeof handed === "function" ? new (handed as typeof File)([], "a").lastModified : null;
};

/** A file made while an index setter on \`Array.prototype\` takes what's set. */
const settersOnArrays = () => {
  Object.defineProperty(Array.prototype, "2", { configurable: true, set: () => {} });
  try {
    return new File([], "a").lastModified;
  } finally {
    Reflect.deleteProperty(Array.prototype, "2");
  }
};

/** A file made by \`File\` as the global's prototype holds it. */
const fileByGlobalPrototype = () => {
  const PlatformFile: unknown = Reflect.get(Reflect.getPrototypeOf(globalThis) ?? {}, "File");
  return typeof PlatformFile === "function"
    ? Number(Reflect.get(Reflect.construct(PlatformFile, [[], "a"]), "lastModified"))
    : null;
};

const read = () => ({
  now: Date.now(),
  date: new Date().getTime(),
  heldNow: heldNow(),
  descriptorNow: Object.getOwnPropertyDescriptor(Date, "now")?.value(),
  performanceNow: performance.now(),
  formatted: formatter.format(),
  fileTime: new File([], "a").lastModified,
  fileUndefined: new File([], "a", { lastModified: undefined }).lastModified,
  fileSetters: settersOnArrays(),
  handedFile: swappedConstruct(),
  globalFile: fileByGlobalPrototype(),
  // Where the platform has the timeline's marks: its compatibility date
  // decides.
  markTime: "mark" in performance ? performance.mark("a").startTime : null,
  random: Math.random(),
  heldRandom: heldRandom(),
  uuid: crypto.randomUUID(),
  bytes: Array.from(crypto.getRandomValues(new Uint8Array(8))),
});

/** What it read, then what it reads once time has passed. */
const twice = async () => {
  const before = read();
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { before, after: read() };
};

export const sample = query({ args: {}, handler: () => read() });

/** Keys made as the App's modules load, before any mutation starts. */
const ecdsaKeys = crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
const rsaKeys = crypto.subtle.generateKey(
  { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  false,
  ["encrypt", "decrypt", "wrapKey"]
);

/**
 * Whether \`attempt\` ran, was refused as a mutation refuses what no seed
 * reaches, or failed otherwise.
 */
const outcome = async (attempt: () => unknown) => {
  try {
    await attempt();
    return "ran";
  } catch (error) {
    return error instanceof Error && error.message.includes("answers the same when it runs again")
      ? "refused"
      : "failed";
  }
};

/** What draws on the platform's clock or randomness that no seed reaches, each tried. */
const unseeded = async () => {
  const ecdsa = (await ecdsaKeys) as CryptoKeyPair;
  const rsa = (await rsaKeys) as CryptoKeyPair;
  const data = new Uint8Array([1, 2, 3]);
  let nameReads = 0;
  // HMAC to whatever reads it first, ECDSA to whatever reads it after.
  const switching = {
    hash: "SHA-256",
    get name() {
      nameReads += 1;
      return nameReads === 1 ? "HMAC" : "ECDSA";
    },
  };
  // Read before \`body\`: each puts a form on whatever it is read on.
  const byGetter = {
    body: "plain",
    get method() {
      Reflect.set(this, "body", new FormData());
      return "POST";
    },
  };
  const byTrap = new Proxy(
    { body: "plain", method: "POST" },
    {
      get: (target, key, receiver) => {
        if (key !== "body") {
          Reflect.set(receiver, "body", new FormData());
        }
        return Reflect.get(target, key);
      },
    }
  );
  const contentTypeOf = (init: RequestInit) =>
    new Request("https://example.test", init).headers.get("content-type");
  const toWrap = await crypto.subtle.importKey("raw", new Uint8Array(16), "AES-GCM", true, ["encrypt"]);
  const hmacKey = await crypto.subtle.importKey("raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return {
    key: await outcome(() => crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"])),
    formBody: await outcome(() => new Response(new FormData()).headers.get("content-type")),
    formRequest: await outcome(() =>
      new Request("https://example.test", { method: "POST", body: new FormData() }).headers.get("content-type")
    ),
    formRequestByGetter: contentTypeOf(byGetter),
    formRequestByTrap: contentTypeOf(byTrap),
    formFile: await outcome(() => new FormData().append("f", new Blob(["x"]), "n")),
    formRead: await outcome(() =>
      new Response("a=b", { headers: { "content-type": "application/x-www-form-urlencoded" } }).formData()
    ),
    ecdsa: await outcome(() => crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ecdsa.privateKey, data)),
    switchedName: await outcome(() => crypto.subtle.sign(switching, ecdsa.privateKey, data)),
    rsaOaep: await outcome(() => crypto.subtle.encrypt("RSA-OAEP", rsa.publicKey, data)),
    wrapped: await outcome(() => crypto.subtle.wrapKey("raw", toWrap, rsa.publicKey, "RSA-OAEP")),
    hmac: await outcome(() => crypto.subtle.sign("HMAC", hmacKey, data)),
  };
};

export const roll = mutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.query("rolls").take(1);
    const read = await twice();
    throw new AppError("dice.rolled", "Rolled.", {
      ...read,
      nested: [await ctx.runQuery(sample, {}), await ctx.runQuery(sample, {})],
      unseeded: await unseeded(),
    });
  },
});

export const keep = mutation({
  args: {},
  handler: async (ctx) => {
    const uuid = crypto.randomUUID();
    await ctx.db.insert("rolls", { uuid });
    return uuid;
  },
});

/** Tries to put the platform's randomness back. */
export const tamper = mutation({
  args: {},
  handler: () => {
    try {
      Math.random = () => 0.5;
      return "replaced";
    } catch (error) {
      return error instanceof TypeError ? "refused" : "failed";
    }
  },
});

export const look = query({ args: {}, handler: twice });

export const peek = action({ args: {}, handler: twice });

export const generate = action({ args: {}, handler: unseeded });
`,
  }
);

/** A read of the clock and randomness, as `diceFiles`' `read` answers it. */
const readSchema = z.strictObject({
  now: z.number(),
  date: z.number(),
  heldNow: z.number(),
  descriptorNow: z.number(),
  performanceNow: z.number(),
  formatted: z.string(),
  fileTime: z.number(),
  fileUndefined: z.number(),
  fileSetters: z.number(),
  handedFile: z.number().nullable(),
  globalFile: z.number().nullable(),
  markTime: z.number().nullable(),
  random: z.number(),
  heldRandom: z.number(),
  uuid: z.string(),
  bytes: z.array(z.number()),
});

/** Two reads, one before and one after time passed. */
const twiceSchema = z.strictObject({ before: readSchema, after: readSchema });

/** How each of `diceFiles`' `unseeded` attempts went. */
const outcomeSchema = z.enum(["ran", "refused", "failed"]);
const unseededSchema = z.strictObject({
  key: outcomeSchema,
  formBody: outcomeSchema,
  formRequest: outcomeSchema,
  formRequestByGetter: z.string().nullable(),
  formRequestByTrap: z.string().nullable(),
  formFile: outcomeSchema,
  formRead: outcomeSchema,
  ecdsa: outcomeSchema,
  switchedName: outcomeSchema,
  rsaOaep: outcomeSchema,
  wrapped: outcomeSchema,
  hmac: outcomeSchema,
});

/** What `roll` fails with. */
const rolledSchema = z.strictObject({
  before: readSchema,
  after: readSchema,
  nested: z.tuple([readSchema, readSchema]),
  unseeded: unseededSchema,
});

/** `read`'s randomness alone. */
const randomnessOf = ({
  random,
  heldRandom,
  uuid,
  bytes,
}: z.infer<typeof readSchema>) => [random, heldRandom, uuid, bytes.join(",")];

/** `read`'s times alone, from every way it reads one. */
const timesOf = (read: z.infer<typeof readSchema>) => ({
  date: read.date,
  heldNow: read.heldNow,
  descriptorNow: read.descriptorNow,
  formatted: read.formatted,
  fileTime: read.fileTime,
  fileUndefined: read.fileUndefined,
  fileSetters: read.fileSetters,
  handedFile: read.handedFile,
  globalFile: read.globalFile,
});

describe("a mutation's time and randomness", { timeout: 120_000 }, () => {
  it("are the same in every attempt of one submission, and new for another", async () => {
    const dice = await sealedNotes(diceFiles);
    const roll = async (key: string) => {
      const answered = await callAppFunction(
        env,
        dice.owner,
        dice.app,
        JSON.stringify({
          reference: { name: "dice.roll", kind: "mutation" },
          args: {},
          idempotencyKey: key,
        })
      );
      if (answered.result.ok) {
        throw new Error("Expected the roll to fail");
      }
      return rolledSchema.parse(answered.result.error.details);
    };
    const started = Date.now();
    const first = await roll("roll-one");
    const again = await roll("roll-one");
    const other = await roll("roll-two");
    const ended = Date.now();
    const { before, after, nested } = first;
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
    });
    const startedAt = {
      date: before.now,
      heldNow: before.now,
      descriptorNow: before.now,
      formatted: formatter.format(before.now),
      fileTime: before.now,
      fileUndefined: before.now,
      fileSetters: before.now,
      // Never handed the platform's \`File\`.
      handedFile: null,
      globalFile: before.now,
    };
    expect({
      again,
      // Held still while it ran, every way it is read, in the queries it
      // ran too.
      times: [before, after, ...nested].map(timesOf),
      timeline: [after, ...nested].map(
        ({ performanceNow, markTime }) =>
          performanceNow === before.performanceNow &&
          (markTime === null || markTime === before.performanceNow)
      ),
      whenStarted: before.now >= started && before.now <= ended,
      // Each query a seed of its own, never the mutation's.
      ownSeeds: new Set(
        [before, ...nested].map((read) => randomnessOf(read).join(","))
      ).size,
      newForAnother: randomnessOf(other.before).map(
        (value, index) => value === randomnessOf(before)[index]
      ),
      aUuid: z.uuidv4().safeParse(before.uuid).success,
      unseeded: first.unseeded,
    }).toStrictEqual({
      again: first,
      times: [startedAt, startedAt, startedAt, startedAt],
      timeline: [true, true, true],
      whenStarted: true,
      ownSeeds: 3,
      newForAnother: [false, false, false, false],
      aUuid: true,
      // Refused where no seed reaches; what draws none runs, and an
      // algorithm is checked as the platform reads it.
      unseeded: {
        key: "refused",
        formBody: "refused",
        formRequest: "refused",
        // The body as checked, whatever the init's getters write.
        formRequestByGetter: "text/plain;charset=UTF-8",
        formRequestByTrap: "text/plain;charset=UTF-8",
        formFile: "refused",
        formRead: "refused",
        ecdsa: "refused",
        switchedName: "failed",
        rsaOaep: "refused",
        wrapped: "refused",
        hmac: "ran",
      },
    });
  });

  it("commit as any mutation does, and can't be put back by App code", async () => {
    const dice = await sealedNotes(diceFiles);
    const kept = valueOf(await call(dice, dice.owner, "dice.keep", {}));
    expect({
      kept: z.uuidv4().safeParse(kept).success,
      tamper: valueOf(await call(dice, dice.owner, "dice.tamper", {})),
    }).toStrictEqual({ kept: true, tamper: "refused" });
  });

  it("leave a query's and an action's the platform's own", async () => {
    const dice = await sealedNotes(diceFiles);
    const live = async (path: string) => {
      const started = Date.now();
      const { before, after } = twiceSchema.parse(
        valueOf(await call(dice, dice.owner, path, {}))
      );
      return {
        moves:
          after.now > before.now &&
          after.date > before.date &&
          after.descriptorNow > before.descriptorNow &&
          after.performanceNow > before.performanceNow &&
          after.fileTime > before.fileTime &&
          (after.markTime === null ||
            before.markTime === null ||
            after.markTime > before.markTime),
        whenRead: before.now >= started && after.now <= Date.now(),
        differs: [
          after.random === before.random,
          after.heldRandom === before.heldRandom,
          after.uuid === before.uuid,
          after.bytes.join(",") === before.bytes.join(","),
        ],
      };
    };
    const platform = {
      moves: true,
      whenRead: true,
      differs: [false, false, false, false],
    };
    expect({
      query: await live("dice.look"),
      action: await live("dice.peek"),
      unseeded: unseededSchema.parse(
        valueOf(await call(dice, dice.owner, "dice.generate", {}))
      ),
    }).toStrictEqual({
      query: platform,
      action: platform,
      unseeded: {
        key: "ran",
        formBody: "ran",
        formRequest: "ran",
        formRequestByGetter: "text/plain;charset=UTF-8",
        formRequestByTrap: "text/plain;charset=UTF-8",
        formFile: "ran",
        formRead: "ran",
        ecdsa: "ran",
        // The platform's own refusal: HMAC, as it read the name, isn't
        // the key's algorithm.
        switchedName: "failed",
        rsaOaep: "ran",
        wrapped: "ran",
        hmac: "ran",
      },
    });
  });
});

describe("a function that declares no return", { timeout: 120_000 }, () => {
  it("answers what its handler returns, of each kind, still held to JSON and the output limit", async () => {
    const app = await sealedNotes(undeclaredReturnFiles);
    const id = valueOf(
      await call(app, app.owner, "notes.create", { title: "Kept" })
    );
    expect({
      query: valueOf(await call(app, app.owner, "notes.greet", { who: "you" })),
      mutation: typeof id,
      action: valueOf(await call(app, app.owner, "notes.greetTwice", {})),
      notJson: codeOf(await call(app, app.owner, "notes.notJson", {})),
      flood: codeOf(await call(app, app.owner, "notes.flood", {})),
      nothing: valueOf(await call(app, app.owner, "notes.nothing", {})),
    }).toStrictEqual({
      query: "Hello, you",
      mutation: "string",
      action: { greetings: ["Hello, one", "Hello, two"] },
      notJson: "contract.invalid_return",
      flood: "contract.result_too_large",
      nothing: null,
    });
  });
});

describe("a record as deep as a store keeps", { timeout: 120_000 }, () => {
  it("is written and read back through the operation channel, every level of it", async () => {
    const deep = await sealedNotes(deepFiles);
    const put = await call(deep, deep.owner, "deep.put", {});
    const id = put.result.ok ? put.result.value : put.result.error.code;
    const read = await call(deep, deep.owner, "deep.read", { id });
    expect({
      put: put.result.ok || put.result.error.code,
      levels: read.result.ok ? read.result.value : read.result.error.code,
    }).toStrictEqual({ put: true, levels: fieldDepth });
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
        args: {},
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
      "function.deadline_exceeded",
      true,
      [],
    ]);
  });
});

/** The text of the stored artifact with SHA-256 `sha256`, as a load decodes it. */
const storedText = async (sha256: string): Promise<string> => {
  const stored = await env.FILES.get(await artifactKey(sha256));
  const bytes = (await stored?.arrayBuffer()) ?? new ArrayBuffer(0);
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    bytes
  );
};

/** Where a release's check evidence is among its artifacts. */
const evidencePath = ".grasp/verification.json";

/**
 * Rewrites the fixture's sealed SDK module at `path` as `change` makes
 * it, every hash rewritten to match, the check's evidence of the SDK
 * included: a release as another SDK sealed it.
 */
const rewriteSdk = async (
  notes: Sealed,
  path: string,
  change: (text: string) => string
): Promise<void> => {
  const { manifest: sealed } = notes.release;
  const entry = sealed.artifacts.find((artifact) => artifact.path === path);
  const evidenceEntry = sealed.artifacts.find(
    (artifact) => artifact.path === evidencePath
  );
  if (entry === undefined || evidenceEntry === undefined) {
    throw new Error(`No ${path} or evidence in the release`);
  }
  const text = change(await storedText(entry.sha256));
  const sha256 = await sha256Hex(text);
  await putArtifact(sha256, text);
  const artifacts = sealed.artifacts.map((artifact) =>
    artifact.path === path
      ? { path, sha256, bytes: new TextEncoder().encode(text).byteLength }
      : artifact
  );

  const sdk: Record<string, string> = {};
  for (const artifact of artifacts) {
    if (artifact.path.startsWith("sdk/")) {
      // oxlint-disable-next-line no-await-in-loop -- a few, one at a time
      sdk[artifact.path.slice("sdk/".length)] = await storedText(
        artifact.sha256
      );
    }
  }
  const evidence = z
    .looseObject({ observed: z.record(z.string(), z.string()) })
    .parse(JSON.parse(await storedText(evidenceEntry.sha256)));
  const evidenceText = canonicalJson({
    ...evidence,
    observed: {
      ...evidence.observed,
      sdkModules: await sha256Hex(canonicalJson(sdk)),
    },
  });
  const evidenceHash = await sha256Hex(evidenceText);
  await putArtifact(evidenceHash, evidenceText);

  const manifest = canonicalJson({
    ...sealed,
    artifacts: artifacts.map((artifact) =>
      artifact.path === evidencePath
        ? {
            path: evidencePath,
            sha256: evidenceHash,
            bytes: new TextEncoder().encode(evidenceText).byteLength,
          }
        : artifact
    ),
    verificationReportHash: evidenceHash,
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
};

/** A bundled module's final export list. */
const finalExports = /export\s*\{(?<names>[^}]*)\};?\s*$/u;

/** A module's final export list, keeping only the names in `kept`. */
const exportsOnly = (text: string, kept: readonly string[]): string =>
  text.replace(finalExports, (_list, names: string) => {
    const entries = names
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => kept.includes(entry.split(/\s+as\s+/u).at(-1) ?? ""));
    return `export{${entries.join(",")}};`;
  });

describe("the SDK a release runs with", { timeout: 120_000 }, () => {
  it("is the one sealed with it, never the one the host serves now", async () => {
    const notes = await sealedNotes();
    const before = valueOf(await call(notes, notes.owner, "notes.sdkMark", {}));
    // The sealed SDK differs from the host's from here on: its root
    // module marks the isolate.
    await rewriteSdk(
      notes,
      "sdk/@grasp-os~sdk.js",
      (text) => `globalThis.sealedSdkMark = "sealed";\n${text}`
    );
    const after = valueOf(await call(notes, notes.owner, "notes.sdkMark", {}));
    expect([before, after]).toStrictEqual(["unmarked", "sealed"]);
  });

  it("needs nothing of its runner but what its protocol pins", async () => {
    const notes = await sealedNotes();
    // The runtime's host module exporting only what the host's modules
    // import of it (runFunction, installMutationRuntime, manifestOfApp)
    // and what an App's entry does (registerApp): the host brings the
    // rest itself.
    await rewriteSdk(notes, "sdk/@grasp-os~runtime~host.js", (text) => {
      const pinned = exportsOnly(text, [
        "runFunction",
        "installMutationRuntime",
        "manifestOfApp",
        "registerApp",
      ]);
      if (!finalExports.test(pinned)) {
        throw new Error("The runner has no export list to rewrite");
      }
      return pinned;
    });
    const created = valueOf(
      await call(notes, notes.owner, "notes.create", {
        title: "Pinned",
        body: "",
      })
    );
    expect([
      typeof created,
      codeOf(await call(notes, notes.owner, "notes.notANumber", {})),
    ]).toStrictEqual(["string", "contract.invalid_return"]);
  });
});

describe("a release changed since it was sealed", { timeout: 120_000 }, () => {
  it("doesn't run when an artifact's bytes changed", async () => {
    const notes = await sealedNotes();
    const entry = notes.release.manifest.artifacts.find(
      ({ path }) => path === "modules/app~server~notes.js"
    );
    const stored = await env.FILES.get(await artifactKey(entry?.sha256 ?? ""));
    const code = (await stored?.text()) ?? "";
    const forged = code.replace("maintenance", "maintenancf");
    expect([forged.length, forged === code]).toStrictEqual([
      code.length,
      false,
    ]);
    await putArtifact(entry?.sha256 ?? "", forged);
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
    ["lacks its reference", JSON.stringify({ args: {} })],
    [
      "has a key no request has",
      JSON.stringify({ reference: {}, args: {}, principal: "someone" }),
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
      args: {},
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

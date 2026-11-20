import { sha256HexOfBytes } from "@grasp-os/shared/encoding";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { runFileLimits } from "@grasp-os/shared/run-files";
import type { RunFileType } from "@grasp-os/shared/run-files";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import { createWorkflowResource } from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { sweepWorkflowStartDetails } from "../src/workflows/retention.ts";
import {
  callFiles,
  keepFile,
  runFilesRemoved,
  sweepGraceMs,
  sweepRunFiles,
} from "../src/workflows/run-files.ts";
import type { FilesAnswer, FilesCaller } from "../src/workflows/run-files.ts";
import { startFilesOf } from "./run-file-starts.ts";
import { outcome, unique } from "./sign-in.ts";
import { publishDefinition } from "./workflow-publishing.ts";

// A workflow run's own files (GRA-724, workflows/run-files.ts), from its
// threat model, through the files host itself: what a step asks of them
// (`callFiles`: read, write, list, delete) and what a connector read keeps
// as a file (`keepFile`). A replay writes nothing twice; a stale attempt
// stores and seals nothing; a file's bytes are what its type says; every
// limit holds before bytes are stored; a file is its run's alone; it goes
// with its run's details, and what R2 refuses is deleted on the next sweep.

const identityOf = (userId: string, role: Role): Identity => ({
  userId,
  email: `${userId}@acme.test`,
  name: "Person",
  role,
  teams: [],
  staff: false,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

/** A member of the organization with `role`, as their session has them. */
const person = async (role: Role): Promise<Identity> => {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).bind(userId, "Person", `${userId}@acme.test`, Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, ?, ?)"
    ).bind(crypto.randomUUID(), userId, role, Date.now()),
  ]);
  return identityOf(userId, role);
};

/** A text of `size` characters. */
const bodyOf = (size: number): string =>
  "abcdefghij".repeat(Math.ceil(size / 10)).slice(0, size);

const utf8 = new TextEncoder();

/** A workflow taking a file, whose run says which file it was handed. */
const definition = JSON.stringify({
  $schema: workflowSchemaUrl,
  args: { kind: "object", fields: { doc: { kind: "file" } } },
  returns: { kind: "object", fields: { status: { kind: "string" } } },
  result: { status: { $expr: "args.doc.id" } },
  steps: [],
});

/** A run of a workflow of `by`'s, handed one file by its start, once it ended. */
const handedRun = async (by: Identity): Promise<string> => {
  const workflow = await createWorkflowResource(env, by, `files-${unique()}`);
  await publishDefinition(env, by, workflow.id, definition);
  const handed = await startFilesOf({
    name: "a.csv",
    type: "text/csv",
    chunks: [utf8.encode(bodyOf(10))],
  });
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    workflow.id,
    { expected: 1, args: { doc: { id: handed.id } }, key: unique() },
    undefined,
    undefined,
    undefined,
    handed.files
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  await vi.waitFor(
    async () => {
      const read = await resourceRunFor(env, by, workflow.id, runId);
      expect(read.status).toBe("completed");
    },
    { timeout: 60_000, interval: 100 }
  );
  return runId;
};

/** An attempt that still holds its lease. */
const holds = (): void => undefined;

/** A caller of the files host for a run of its own, as a task's step is. */
const callerOf = (
  run = crypto.randomUUID(),
  workflowId = crypto.randomUUID(),
  step = `step-${unique()}`
) => {
  let ordinal = 0;
  return {
    run,
    workflowId,
    /** The next call's caller, numbered as a task numbers its calls. */
    next: (requireHolds: () => void = holds): FilesCaller => {
      ordinal += 1;
      return {
        runId: run,
        workflowId,
        effectKey: `${step}:${ordinal}`,
        requireHolds,
      };
    },
    /** The caller of call `n` again: a retry or replay of it. */
    again: (n: number): FilesCaller => ({
      runId: run,
      workflowId,
      effectKey: `${step}:${n}`,
      requireHolds: holds,
    }),
  };
};

/** An attempt whose lease was lost before it began. */
const lostLease = (): void => {
  throw new Error("The attempt went stale");
};

/** An attempt's lease, held until `lose` is called: then it went stale. */
const leaseOf = () => {
  let held = true;
  return {
    requireHolds: (): void => {
      if (!held) {
        throw new Error("The attempt went stale");
      }
    },
    lose: (): void => {
      held = false;
    },
  };
};

/**
 * The deployment's bucket, losing a lease once its `nth` `method` call
 * is answered: the attempt went stale right after it.
 */
const bucketLosingAfter = (
  method: "put" | "get",
  nth: number,
  lose: () => void
): R2Bucket => {
  let calls = 0;
  return new Proxy(env.FILES, {
    get: (target, property): unknown => {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") {
        return value;
      }
      return property === method
        ? async (...args: unknown[]) => {
            const result: unknown = await Reflect.apply(value, target, args);
            calls += 1;
            if (calls === nth) {
              lose();
            }
            return result;
          }
        : (...args: unknown[]): unknown => Reflect.apply(value, target, args);
    },
  });
};

/**
 * The deployment's database, losing a lease as a statement `pattern`
 * matches is prepared: the attempt went stale as it was made.
 */
const databaseLosingAt = (pattern: RegExp, lose: () => void): D1Database =>
  new Proxy(env.DB, {
    get: (target, property): unknown => {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") {
        return value;
      }
      return property === "prepare"
        ? (query: string): unknown => {
            if (pattern.test(query)) {
              lose();
            }
            return Reflect.apply(value, target, [query]);
          }
        : (...args: unknown[]): unknown => Reflect.apply(value, target, args);
    },
  });

/** A write's lookup of the piece its call may have reserved before. */
const pieceLookup =
  /from "workflow_run_file_chunks" where[\s\S]*"append_key" = \?/u;
/** A write's reservation of a piece's bytes. */
const pieceReserved = /INSERT INTO workflow_run_file_chunks/u;
/** A lookup of one of a run's files. */
const fileLookup = /select[\s\S]*from "workflow_run_files"/u;

/**
 * `caller`'s next call, and the deployment it runs on, its lease lost
 * once its `nth` `method` call to R2 is answered (its first put, unless
 * said otherwise).
 */
const staleAfter = (
  caller: ReturnType<typeof callerOf>,
  nth = 1,
  method: "put" | "get" = "put"
) => {
  const lease = leaseOf();
  return {
    caller: caller.next(lease.requireHolds),
    on: { ...env, FILES: bucketLosingAfter(method, nth, lease.lose) },
  };
};

/**
 * `caller`'s next call, and the deployment it runs on, its lease lost as
 * a statement `pattern` matches is prepared.
 */
const staleAt = (caller: ReturnType<typeof callerOf>, pattern: RegExp) => {
  const lease = leaseOf();
  return {
    caller: caller.next(lease.requireHolds),
    on: { ...env, DB: databaseLosingAt(pattern, lease.lose) },
  };
};

/**
 * The deployment's bucket, running `before` ahead of each `method` call:
 * something else happening while the call is under way.
 */
const runningBefore = (
  method: "put" | "get",
  before: () => Promise<void>
): R2Bucket =>
  new Proxy(env.FILES, {
    get: (target, property): unknown => {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") {
        return value;
      }
      // Called on the bucket itself, as R2's methods must be.
      return property === method
        ? async (...args: unknown[]) => {
            await before();
            const result: unknown = await Reflect.apply(value, target, args);
            return result;
          }
        : (...args: unknown[]): unknown => Reflect.apply(value, target, args);
    },
  });

/** Field `key` of `value`, as data. */
const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

/** Grows file `id`'s recorded size by `bytes`: a file near a limit. */
const grow = async (bytes: number, id: string): Promise<void> => {
  await env.DB.prepare(
    "UPDATE workflow_run_files SET size = size + ? WHERE id = ?"
  )
    .bind(bytes, id)
    .run();
};

/** The deployment's bucket, refusing every `method` call as R2 would when down. */
const failingOn = (method: "put" | "delete"): R2Bucket =>
  new Proxy(env.FILES, {
    get: (target, property): unknown =>
      property === method
        ? async () => {
            await Promise.resolve();
            throw new Error("R2 is down");
          }
        : Reflect.get(target, property),
  });

/** The R2 objects run `runId`'s files are kept in. */
const objectsOf = async (runId: string): Promise<number> => {
  const listed = await env.FILES.list({ prefix: `run-files/${runId}/` });
  return listed.objects.length;
};

/** The states of run `runId`'s files, in order of state. */
const rowsOf = async (runId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT state FROM workflow_run_files WHERE run_id = ? ORDER BY state"
  )
    .bind(runId)
    .all<{ state: string }>();
  return results.map(({ state }) => state);
};

/** The ID and size of the file run `runId` is still writing. */
const writingOf = async (runId: string) => {
  const row = await env.DB.prepare(
    "SELECT id, size FROM workflow_run_files WHERE run_id = ? AND state = 'writing'"
  )
    .bind(runId)
    .first<{ id: string; size: number }>();
  if (row === null) {
    throw new Error("The run writes no file");
  }
  return row;
};

/** What a files call answered. */
const outputOf = async (pending: Promise<FilesAnswer>): Promise<unknown> => {
  const { output } = await pending;
  return output;
};

/** The size of the file run `runId` is still writing. */
const writingSizeOf = async (runId: string): Promise<number> => {
  const { size } = await writingOf(runId);
  return size;
};

/** The ID of the file run `runId` is still writing. */
const writingIdOf = async (runId: string): Promise<string> => {
  const { id } = await writingOf(runId);
  return id;
};

/** Marks run `runId`'s files deleted, as its details going does. */
const detailsGone = async (runId: string): Promise<void> => {
  await runFilesRemoved(drizzle(env.DB), sql`(SELECT ${runId})`);
};

/** A step's whole write of `text` to a file of `caller`'s run. */
const written = async (
  caller: ReturnType<typeof callerOf>,
  text: string,
  name = "a.txt"
) => {
  const done = await callFiles(env, caller.next(), "write", {
    name,
    type: "text/plain",
    text,
  });
  return { file: String(fieldOf(done.output, "file")), ref: done.output };
};

/** A CSV file named `name`, as a connector read keeps one. */
const csvOf = (name: string) => ({ name, type: "text/csv" as const });

const note = { name: "notes.md", type: "text/markdown", text: "# Notes" };

/** What a run's file is, as a step is handed it. */
const refOf = async (file: string, name: string, text: string) => ({
  file,
  name,
  type: name.endsWith(".md") ? "text/markdown" : "text/plain",
  size: utf8.encode(text).length,
  sha256: await sha256HexOfBytes(utf8.encode(text)),
});

describe("a workflow run's own files", () => {
  it("write a file once however often its call is made again, storing a piece whose put failed by the same call again", async () => {
    const caller = callerOf();
    const writing = caller.next();
    // Its piece reserved, its put refused: the same call again stores it.
    const putFailed = await outcome(
      callFiles({ ...env, FILES: failingOn("put") }, writing, "write", note)
    );
    const first = await callFiles(env, writing, "write", note);
    const file = String(fieldOf(first.output, "file"));
    const replayed = await callFiles(env, writing, "write", note);
    // The same call again asking for another file, or other text.
    const otherName = await outcome(
      callFiles(env, writing, "write", { ...note, name: "other.md" })
    );
    const otherText = await outcome(
      callFiles(env, writing, "write", { ...note, text: "# Other" })
    );
    // The lease lost once its text is stored, before it is sealed: the
    // next attempt finishes the file the first opened.
    const lost = staleAfter(caller);
    const died = await outcome(callFiles(lost.on, lost.caller, "write", note));
    const opened = await writingIdOf(caller.run);
    const retried = await callFiles(
      env,
      { ...lost.caller, requireHolds: holds },
      "write",
      note
    );
    expect({
      putFailed,
      first: first.output,
      replayed: replayed.output,
      otherName,
      otherText,
      died,
      retried: fieldOf(retried.output, "file"),
      rows: await rowsOf(caller.run),
      objects: await objectsOf(caller.run),
    }).toStrictEqual({
      putFailed: "Error: R2 is down",
      first: await refOf(file, "notes.md", note.text),
      replayed: await refOf(file, "notes.md", note.text),
      otherName: "workflow.call_invalid",
      otherText: "workflow.call_invalid",
      died: "Error: The attempt went stale",
      retried: opened,
      rows: ["done", "done"],
      objects: 2,
    });
  });

  it("answer an attempt's calls again as they answered, once its own later call deleted the file, storing nothing again", async () => {
    const caller = callerOf();
    const { file, ref } = await written(caller, "hello");
    const read = await callFiles(env, caller.next(), "read", { file });
    const deleted = await callFiles(env, caller.next(), "delete", { file });
    const stored = await objectsOf(caller.run);
    // The attempt cut off after its delete: its calls, replayed in order.
    const replayed = {
      write: await outputOf(
        callFiles(env, caller.again(1), "write", {
          name: "a.txt",
          type: "text/plain",
          text: "hello",
        })
      ),
      delete: await outputOf(
        callFiles(env, caller.again(3), "delete", { file })
      ),
    };
    // A new call finds it gone.
    const later = {
      read: await outcome(callFiles(env, caller.next(), "read", { file })),
      delete: await outcome(callFiles(env, caller.next(), "delete", { file })),
      list: await outputOf(callFiles(env, caller.next(), "list", {})),
    };
    expect({
      read: read.output,
      deleted: deleted.output,
      replayed,
      later,
      storedAgain: (await objectsOf(caller.run)) - stored,
    }).toStrictEqual({
      read: { file: ref, text: "hello" },
      deleted: null,
      replayed: { write: ref, delete: null },
      // A delete again answers as done: the file is gone either way.
      later: { read: "file.not_found", delete: "ok", list: [] },
      storedAgain: 0,
    });
  });

  it("are their run's alone: another run finds, lists and deletes none of them", async () => {
    const workflowId = crypto.randomUUID();
    const owner = callerOf(crypto.randomUUID(), workflowId);
    const { file, ref } = await written(owner, "mine");
    // Another run of the same workflow, holding the file's ID.
    const other = callerOf(crypto.randomUUID(), workflowId);
    expect({
      read: await outcome(callFiles(env, other.next(), "read", { file })),
      delete: await outcome(callFiles(env, other.next(), "delete", { file })),
      list: await outputOf(callFiles(env, other.next(), "list", {})),
      owners: await outputOf(callFiles(env, owner.next(), "list", {})),
    }).toStrictEqual({
      read: "file.not_found",
      delete: "file.not_found",
      list: [],
      owners: [ref],
    });
  });

  it("delete a finished file only, never one a task is still writing, nor list or read one", async () => {
    const caller = callerOf();
    const done = await written(caller, "kept");
    // A file whose write went stale before it was sealed.
    const stale = staleAfter(caller);
    await outcome(
      callFiles(stale.on, stale.caller, "write", {
        name: "draft.txt",
        type: "text/plain",
        text: "draft",
      })
    );
    const draft = await writingOf(caller.run);
    expect({
      deleteDraft: await outcome(
        callFiles(env, caller.next(), "delete", { file: draft.id })
      ),
      readDraft: await outcome(
        callFiles(env, caller.next(), "read", { file: draft.id })
      ),
      listed: await outputOf(callFiles(env, caller.next(), "list", {})),
      deleteDone: await outputOf(
        callFiles(env, caller.next(), "delete", { file: done.file })
      ),
      rows: await rowsOf(caller.run),
    }).toStrictEqual({
      deleteDraft: "file.not_finished",
      readDraft: "file.not_finished",
      listed: [done.ref],
      deleteDone: null,
      rows: ["deleted", "writing"],
    });
  });

  it("read only a text file whole, within a call's bytes and as its step records it", async () => {
    const caller = callerOf();
    const readOf = async (
      bytes: Uint8Array,
      type: RunFileType = "text/plain"
    ) => {
      const kept = await keepFile(env, caller.next(), {
        name: "f.txt",
        type,
        bytes,
      });
      return await outcome(
        callFiles(env, caller.next(), "read", {
          file: String(fieldOf(kept.output, "file")),
        })
      );
    };
    // A finished file whose stored bytes changed, or went, since.
    const changedOf = async (change: (key: string) => Promise<unknown>) => {
      const { file } = await written(caller, "sealed");
      const chunk = await env.DB.prepare(
        "SELECT key FROM workflow_run_file_chunks WHERE file_id = ?"
      )
        .bind(file)
        .first<{ key: string }>();
      await change(chunk?.key ?? "");
      return await outcome(callFiles(env, caller.next(), "read", { file }));
    };
    expect({
      changed: await changedOf(
        async (key) => await env.FILES.put(key, "SEALED")
      ),
      gone: await changedOf(async (key) => {
        await env.FILES.delete(key);
      }),
      plain: await readOf(utf8.encode("a".repeat(256 * 1024))),
      // Within one call's bytes, but six times as long as JSON escapes it.
      escaped: await readOf(utf8.encode("\u0001".repeat(256 * 1024))),
      pastCall: await readOf(utf8.encode(bodyOf(runFileLimits.callBytes + 1))),
      png: await readOf(
        Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0),
        "image/png"
      ),
    }).toStrictEqual({
      changed: "file.incomplete",
      gone: "file.incomplete",
      plain: "ok",
      escaped: "file.not_readable",
      pastCall: "file.not_readable",
      png: "file.not_readable",
    });
  });

  it("refuse a stale attempt before anything is stored or sealed, and leave a file it would have deleted", async () => {
    const write = { name: "b.txt", type: "text/plain", text: "late" };
    // Stale before it starts: refused, no file opened.
    const atCall = callerOf();
    const staleCall = await outcome(
      callFiles(env, atCall.next(lostLease), "write", write)
    );
    // Stale as it looks up its piece, by the time it would reserve its
    // bytes: nothing reserved.
    const atReserve = callerOf();
    const reserving = staleAt(atReserve, pieceLookup);
    const staleReserve = await outcome(
      callFiles(reserving.on, reserving.caller, "write", write)
    );
    // Stale as its bytes are reserved, by the time they would go to R2:
    // reserved, never stored.
    const atPut = callerOf();
    const putting = staleAt(atPut, pieceReserved);
    const stalePut = await outcome(
      callFiles(putting.on, putting.caller, "write", write)
    );
    // Stale as it looks the file up, by the time it would mark it
    // deleted: still there.
    const atDelete = callerOf();
    const { file } = await written(atDelete, "kept");
    const deleting = staleAt(atDelete, fileLookup);
    const staleDelete = await outcome(
      callFiles(deleting.on, deleting.caller, "delete", { file })
    );
    // Stale while a file not of its type is read back to be hashed, by the
    // time it would be deleted: refused, the file left as it was.
    const atMismatch = callerOf();
    const hashing = staleAfter(atMismatch, 1, "get");
    const staleMismatch = await outcome(
      keepFile(hashing.on, hashing.caller, {
        name: "w.txt",
        type: "text/plain",
        bytes: Uint8Array.of(0x61, 0xff),
      })
    );
    expect({
      staleCall,
      callRows: await rowsOf(atCall.run),
      staleReserve,
      reserved: await writingSizeOf(atReserve.run),
      stalePut,
      put: {
        reserved: await writingSizeOf(atPut.run),
        objects: await objectsOf(atPut.run),
      },
      staleDelete,
      deleteRows: await rowsOf(atDelete.run),
      staleMismatch,
      mismatchRows: await rowsOf(atMismatch.run),
    }).toStrictEqual({
      staleCall: "Error: The attempt went stale",
      callRows: [],
      staleReserve: "Error: The attempt went stale",
      reserved: 0,
      stalePut: "Error: The attempt went stale",
      put: { reserved: 4, objects: 0 },
      staleDelete: "Error: The attempt went stale",
      deleteRows: ["done"],
      staleMismatch: "Error: The attempt went stale",
      mismatchRows: ["writing"],
    });
  });

  it("leave no bytes behind when its run's details go and a sweep lands while a write is under way, and finish only the file as hashed", async () => {
    const write = { name: "a.txt", type: "text/plain", text: "racing" };
    // The file deleted, and swept within the grace, while its write's put
    // is under way: the sweep leaves the chunk, the put lands and finds its
    // file gone, so deletes its object again; a later sweep takes the row.
    const graced = callerOf();
    const sweptDuring = runningBefore("put", async () => {
      await detailsGone(graced.run);
      await sweepRunFiles(env, new Date());
    });
    const gracedWrite = await outcome(
      callFiles({ ...env, FILES: sweptDuring }, graced.next(), "write", write)
    );
    const gracedDuring = await objectsOf(graced.run);
    await sweepRunFiles(env, new Date(Date.now() + sweepGraceMs + 1000));
    const gracedAfter = {
      objects: await objectsOf(graced.run),
      rows: await rowsOf(graced.run),
    };
    // A put that lands after its chunk was swept all the same (an attempt
    // past the grace): its object is deleted again.
    const late = callerOf();
    const sweptPast = runningBefore("put", async () => {
      await detailsGone(late.run);
      await sweepRunFiles(env, new Date(Date.now() + sweepGraceMs + 1000));
    });
    const lateWrite = await outcome(
      callFiles({ ...env, FILES: sweptPast }, late.next(), "write", write)
    );
    // A put that lands after the sweep deleted the chunk's object from R2,
    // but before it deleted the chunk's row: kept by neither.
    const between = callerOf();
    const { promise: held, resolve: release } =
      Promise.withResolvers<boolean>();
    const { promise: atPut, resolve: reachedPut } =
      Promise.withResolvers<boolean>();
    const putHeld = runningBefore("put", async () => {
      reachedPut(true);
      await held;
    });
    const betweenWrite = outcome(
      callFiles({ ...env, FILES: putHeld }, between.next(), "write", write)
    );
    await atPut;
    await detailsGone(between.run);
    // The sweep's R2 delete lets the put land, and waits for the write to
    // end, before the sweep goes on to the chunk's row.
    const deleteThenPut = new Proxy(env.FILES, {
      get: (target, property): unknown => {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        return property === "delete"
          ? async (...args: unknown[]) => {
              const result: unknown = await Reflect.apply(value, target, args);
              release(true);
              await betweenWrite;
              return result;
            }
          : (...args: unknown[]): unknown => Reflect.apply(value, target, args);
      },
    });
    await sweepRunFiles(
      { ...env, FILES: deleteThenPut },
      new Date(Date.now() + sweepGraceMs + 1000)
    );
    const betweenResult = await betweenWrite;
    // A write that grows the file while it is being hashed.
    const grown = callerOf();
    const growing = runningBefore("get", async () => {
      await grow(1, await writingIdOf(grown.run));
    });
    const grownWrite = await outcome(
      callFiles({ ...env, FILES: growing }, grown.next(), "write", write)
    );
    expect({
      gracedWrite,
      gracedDuring,
      gracedAfter,
      lateWrite,
      lateObjects: await objectsOf(late.run),
      betweenResult,
      betweenObjects: await objectsOf(between.run),
      grownWrite,
      grownRows: await rowsOf(grown.run),
    }).toStrictEqual({
      // Its file deleted while it was under way: nothing kept.
      gracedWrite: "file.not_found",
      gracedDuring: 0,
      gracedAfter: { objects: 0, rows: [] },
      lateWrite: "file.not_found",
      lateObjects: 0,
      betweenResult: "file.not_found",
      betweenObjects: 0,
      grownWrite: "file.incomplete",
      grownRows: ["writing"],
    });
  });

  it("sweep a deleted file of more chunks than one statement binds", async () => {
    const caller = callerOf();
    const { file } = await written(caller, "first");
    // As many more of its chunks as one sweep round takes past D1's bound
    // parameters, each with its object.
    const extra = 150;
    const keys = Array.from(
      { length: extra },
      (_, at) => `run-files/${caller.run}/${file}/extra-${String(at)}`
    );
    await env.DB.batch(
      keys.map((key, at) =>
        env.DB.prepare(
          `INSERT INTO workflow_run_file_chunks (file_id, "index", key, append_key, size, sha256, stored)
          VALUES (?, ?, ?, ?, 1, 'x', 1)`
        ).bind(file, at + 1, key, `extra:${key}`)
      )
    );
    await Promise.all(keys.map(async (key) => await env.FILES.put(key, "x")));
    await callFiles(env, caller.next(), "delete", { file });
    const before = await objectsOf(caller.run);
    await sweepRunFiles(env, new Date(Date.now() + sweepGraceMs + 1000));
    expect({
      before,
      objects: await objectsOf(caller.run),
      rows: await rowsOf(caller.run),
    }).toStrictEqual({ before: extra + 1, objects: 0, rows: [] });
  });

  it("check a file's bytes against its type: a signature for a binary type, UTF-8 for text", async () => {
    const caller = callerOf();
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];
    const asType = async (bytes: number[] | string, type: RunFileType) =>
      await outcome(
        keepFile(env, caller.next(), {
          name: type.includes("officedocument") ? "f.docx" : "f",
          type,
          bytes:
            typeof bytes === "string"
              ? utf8.encode(bytes)
              : Uint8Array.from(bytes),
        })
      );
    const writing = async (type: string) =>
      await outcome(
        callFiles(env, caller.next(), "write", { name: "f", type, text: "x" })
      );
    expect({
      png: await asType(png, "image/png"),
      pngAsText: await asType(png, "text/plain"),
      textAsPdf: await asType("plain", "application/pdf"),
      json: await asType('{"a":1}', "application/json"),
      notUtf8: await asType([0x61, 0xff, 0xfe], "text/csv"),
      nul: await asType([0x61, 0, 0x62], "text/markdown"),
      docx: await asType(
        [0x50, 0x4b, 0x03, 0x04, 1],
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ),
      // An empty text file is one; an empty binary one isn't what it says.
      emptyText: await asType([], "text/plain"),
      emptyPng: await asType([], "image/png"),
      // A step writes text of a text type only.
      writtenPng: await writing("image/png"),
      writtenUnlisted: await writing("text/html"),
      // Not what it says it is: none holds a place in the run.
      rows: await rowsOf(caller.run),
    }).toStrictEqual({
      png: "ok",
      pngAsText: "file.content_mismatch",
      textAsPdf: "file.content_mismatch",
      json: "ok",
      notUtf8: "file.content_mismatch",
      nul: "file.content_mismatch",
      docx: "ok",
      emptyText: "ok",
      emptyPng: "file.content_mismatch",
      writtenPng: "workflow.call_invalid",
      writtenUnlisted: "workflow.call_invalid",
      rows: [
        "deleted",
        "deleted",
        "deleted",
        "deleted",
        "deleted",
        "done",
        "done",
        "done",
        "done",
      ],
    });
  });

  it("keep a connector's answer as one finished file of the run, whatever its size, and the same call again as the same file, only of the same bytes", async () => {
    const caller = callerOf();
    // Past one call's bytes: written in pieces.
    const text = bodyOf(runFileLimits.callBytes * 2 + 10);
    const bytes = utf8.encode(text);
    const keeping = caller.next();
    const kept = await keepFile(env, keeping, {
      name: "report.csv",
      type: "text/csv",
      bytes,
    });
    const file = String(fieldOf(kept.output, "file"));
    // A replay, a retry: the same call, its effect key the same.
    const again = await keepFile(env, keeping, {
      name: "report.csv",
      type: "text/csv",
      bytes,
    });
    const other = await outcome(
      keepFile(env, keeping, {
        name: "report.csv",
        type: "text/csv",
        bytes: utf8.encode(bodyOf(10)),
      })
    );
    const listed = await callFiles(env, caller.next(), "list", {});
    expect({
      ref: kept.output,
      again: again.output,
      other,
      listed: listed.output,
      rows: await rowsOf(caller.run),
    }).toStrictEqual({
      ref: {
        file,
        name: "report.csv",
        type: "text/csv",
        size: bytes.length,
        sha256: await sha256HexOfBytes(bytes),
      },
      again: kept.output,
      other: "workflow.call_invalid",
      listed: [kept.output],
      rows: ["done"],
    });
  });

  it("name a kept Word or Excel document with its own extension", async () => {
    const caller = callerOf();
    const docx =
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const xlsx =
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const zip = Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 1);
    const kept = async (name: string, type: typeof docx | typeof xlsx) => {
      const answer = await keepFile(env, caller.next(), {
        name,
        type,
        bytes: zip,
      });
      return fieldOf(answer.output, "name");
    };
    expect({
      docm: await kept("letter.docm", docx),
      xlsxAsDocx: await kept("sheet.xlsx", docx),
      none: await kept("letter", docx),
      onlyExtension: await kept(".xlsm", xlsx),
      upperCase: await kept("LETTER.DOCX", docx),
      // A Kelvin sign is no K: not the extension, so renamed.
      kelvin: await kept("letter.doc\u212Ax", docx),
      fits: await kept("Sheet.XLSX", xlsx),
    }).toStrictEqual({
      docm: "letter.docx",
      xlsxAsDocx: "sheet.docx",
      none: "letter.docx",
      onlyExtension: "document.xlsx",
      upperCase: "LETTER.DOCX",
      kelvin: "letter.docx",
      fits: "Sheet.XLSX",
    });
  });

  it("keep nothing of a longer first attempt for a shorter retried read, sealed or not", async () => {
    const piece = runFileLimits.callBytes;
    const longer = utf8.encode(bodyOf(piece * 3));
    const shorter = longer.subarray(0, piece * 2);
    const csv = { name: "report.csv", type: "text/csv" } as const;
    // A first attempt that wrote all its pieces, then lost its lease before
    // sealing: the retry's own pieces replay, the first attempt's third stays.
    const unsealed = callerOf();
    const first = staleAfter(unsealed, 3);
    const lost = await outcome(
      keepFile(first.on, first.caller, { ...csv, bytes: longer })
    );
    const retried = await outcome(
      keepFile(
        env,
        { ...first.caller, requireHolds: holds },
        { ...csv, bytes: shorter }
      )
    );
    // A first attempt that sealed the longer file: the retry can't answer it.
    const sealed = callerOf();
    const once = sealed.next();
    await keepFile(env, once, { ...csv, bytes: longer });
    const again = await outcome(
      keepFile(env, once, { ...csv, bytes: shorter })
    );
    expect({
      lost,
      retried,
      unsealed: await writingSizeOf(unsealed.run),
      again,
    }).toStrictEqual({
      lost: "Error: The attempt went stale",
      retried: "workflow.call_invalid",
      unsealed: longer.length,
      again: "workflow.call_invalid",
    });
  });

  it("keep nothing of a connector read whose attempt went stale while it was answered, and seal nothing once it goes stale mid-write", async () => {
    const csv = { name: "report.csv", type: "text/csv" } as const;
    const bytes = utf8.encode(bodyOf(runFileLimits.callBytes * 2));
    // Stale before the answer is kept: no file, no reserved byte.
    const expired = callerOf();
    const before = await outcome(
      keepFile(env, expired.next(lostLease), { ...csv, bytes })
    );
    // Stale after its pieces are written and hashed, just before it is
    // sealed: never sealed, swept as unfinished.
    const late = callerOf();
    const hashed = staleAfter(late, 2, "get");
    const midway = await outcome(
      keepFile(hashed.on, hashed.caller, { ...csv, bytes })
    );
    // No row, so none of the run's limits (summed from its rows) moved.
    expect({
      before,
      expiredRows: await rowsOf(expired.run),
      expiredObjects: await objectsOf(expired.run),
      midway,
      lateRows: await rowsOf(late.run),
    }).toStrictEqual({
      before: "Error: The attempt went stale",
      expiredRows: [],
      expiredObjects: 0,
      midway: "Error: The attempt went stale",
      lateRows: ["writing"],
    });
  });

  it("hold every limit before bytes are stored: per call, open files, files and bytes per run, bytes per file, bytes per workflow", async () => {
    // Being written at once: the ninth is refused.
    const opener = callerOf();
    for (let at = 0; at < runFileLimits.openWrites; at += 1) {
      const stale = staleAfter(opener);
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await outcome(
        keepFile(stale.on, stale.caller, {
          name: `f${String(at)}.txt`,
          type: "text/plain",
          bytes: utf8.encode("x"),
        })
      );
    }
    const ninth = await outcome(written(opener, "x"));
    // A run's files: the hundred and first is refused.
    const many = callerOf();
    for (let at = 0; at < runFileLimits.runFiles; at += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await written(many, "x");
    }
    const hundredFirst = await outcome(written(many, "x"));
    // A step's text past a call's bytes is refused as it is asked.
    const pastCall = await outcome(
      written(callerOf(), "x".repeat(runFileLimits.callBytes + 1))
    );
    // A file near its limit: its first piece kept, then it went stale; the
    // retry's next piece passes the limit.
    const big = callerOf();
    const bigWrite = staleAfter(big);
    const bigBytes = utf8.encode(bodyOf(runFileLimits.callBytes + 2));
    await outcome(
      keepFile(bigWrite.on, bigWrite.caller, {
        ...csvOf("big.csv"),
        bytes: bigBytes,
      })
    );
    const bigFile = await writingOf(big.run);
    await grow(runFileLimits.fileBytes - bigFile.size - 1, bigFile.id);
    const pastFile = await outcome(
      keepFile(
        env,
        { ...bigWrite.caller, requireHolds: holds },
        { ...csvOf("big.csv"), bytes: bigBytes }
      )
    );
    // A run and a workflow already near their limits.
    const run = callerOf();
    const runFile = await written(run, "x");
    await grow(runFileLimits.runBytes - 2, runFile.file);
    const pastRun = await outcome(written(run, "xx"));
    const workflowId = crypto.randomUUID();
    const earlier = callerOf(crypto.randomUUID(), workflowId);
    const earlierFile = await written(earlier, "x");
    await grow(runFileLimits.workflowBytes - 2, earlierFile.file);
    const later = callerOf(crypto.randomUUID(), workflowId);
    const laterWrite = later.next();
    const laterText = { name: "later.txt", type: "text/plain", text: "xx" };
    const pastWorkflow = await outcome(
      callFiles(env, laterWrite, "write", laterText)
    );
    // Deleted, though not yet swept: only live files count, so its space
    // is back at once (GRA-950), and the refused write goes again.
    await callFiles(env, earlier.next(), "delete", { file: earlierFile.file });
    const afterDelete = await outcome(
      callFiles(env, laterWrite, "write", laterText)
    );
    expect({
      ninth,
      hundredFirst,
      pastCall,
      pastFile,
      pastRun,
      pastWorkflow,
      afterDelete,
      // Refused before its bytes reached R2: only the first piece's are.
      storedPastFile: await objectsOf(big.run),
    }).toStrictEqual({
      ninth: "file.writes_open",
      hundredFirst: "file.run_full",
      pastCall: "workflow.call_invalid",
      pastFile: "file.run_too_large",
      pastRun: "file.run_full",
      pastWorkflow: "file.workflow_quota",
      afterDelete: "ok",
      storedPastFile: 1,
    });
  }, 120_000);

  it("go with their run's details, the sweep deleting their chunks and trying again what R2 refused, and a file never finished a day after it opened", async () => {
    const runId = await handedRun(await person("builder"));
    const before = {
      objects: await objectsOf(runId),
      rows: await rowsOf(runId),
    };
    // Its details are past their retention, swept by a clock run that came
    // late: two graces after its scheduled time.
    const now = new Date();
    await sweepWorkflowStartDetails(
      env,
      new Date(now.getTime() + 1000),
      new Date(now.getTime() - 2 * sweepGraceMs)
    );
    const marked = await rowsOf(runId);
    const refusing = { ...env, FILES: failingOn("delete") };
    const pastGrace = new Date(now.getTime() + sweepGraceMs + 1000);
    // Within the grace from when they really went, nothing is swept.
    await sweepRunFiles(env);
    const inGrace = {
      objects: await objectsOf(runId),
      rows: await rowsOf(runId),
    };
    const refused = await outcome(sweepRunFiles(refusing, pastGrace));
    const afterRefusal = {
      objects: await objectsOf(runId),
      rows: await rowsOf(runId),
    };
    await sweepRunFiles(env, pastGrace);
    const swept = {
      objects: await objectsOf(runId),
      rows: await rowsOf(runId),
    };
    // One opened, added to, and never finished: its write went stale.
    const orphan = callerOf();
    const left = staleAfter(orphan);
    await outcome(
      callFiles(left.on, left.caller, "write", {
        name: "left.txt",
        type: "text/plain",
        text: "left",
      })
    );
    await sweepRunFiles(env, new Date(Date.now() + runFileLimits.orphanMs / 2));
    const halfDay = {
      objects: await objectsOf(orphan.run),
      rows: await rowsOf(orphan.run),
    };
    const orphaned = Date.now() + runFileLimits.orphanMs + 1000;
    await sweepRunFiles(env, new Date(orphaned));
    await sweepRunFiles(env, new Date(orphaned + sweepGraceMs + 1000));
    expect({
      before,
      marked,
      inGrace,
      refused,
      afterRefusal,
      swept,
      halfDay,
      orphan: {
        objects: await objectsOf(orphan.run),
        rows: await rowsOf(orphan.run),
      },
    }).toStrictEqual({
      before: { objects: 1, rows: ["done"] },
      marked: ["deleted"],
      inGrace: { objects: 1, rows: ["deleted"] },
      refused: "Error: R2 is down",
      afterRefusal: { objects: 1, rows: ["deleted"] },
      swept: { objects: 0, rows: [] },
      halfDay: { objects: 1, rows: ["writing"] },
      orphan: { objects: 0, rows: [] },
    });
  }, 120_000);
});

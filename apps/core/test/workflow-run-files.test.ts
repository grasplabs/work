import { sha256HexOfBytes, toBase64 } from "@grasp-os/shared/encoding";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { runFileLimits } from "@grasp-os/shared/run-files";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { sweepWorkflowStartDetails } from "../src/workflows/retention.ts";
import {
  callFiles,
  keepFile,
  sweepGraceMs,
  sweepRunFiles,
} from "../src/workflows/run-files.ts";
import type { FilesCaller } from "../src/workflows/run-files.ts";
import { startFilesOf } from "./run-file-starts.ts";
import { outcome, unique } from "./sign-in.ts";

// A workflow run's own files (GRA-724, workflows/run-files.ts), from its
// threat model, through the files host itself: only the task that opened
// a file writes it, and a replay writes nothing twice; its bytes are what
// its type says; every limit holds before bytes are stored; it goes with
// its run's details, and what R2 refuses is deleted on the next sweep.

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
  await publishWorkflowVersion(env, by, workflow.id, {
    definition,
    basedOn: null,
  });
  const handed = await startFilesOf({
    name: "a.csv",
    type: "text/csv",
    chunks: [new TextEncoder().encode(bodyOf(10))],
  });
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    workflow.id,
    { version: 1, input: { doc: { id: handed.id } }, key: unique() },
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

/** A caller of the files host for a run of its own (`callFiles`). */
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

/** An attempt's lease check that fails from its `nth` check on: it went stale. */
const staleFrom = (nth: number): (() => void) => {
  let checks = 0;
  return () => {
    checks += 1;
    if (checks >= nth) {
      throw new Error("The attempt went stale");
    }
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

const base64Of = (text: string): string =>
  toBase64(new TextEncoder().encode(text));

/** The R2 objects run `runId`'s files are kept in. */
const objectsOf = async (runId: string): Promise<number> => {
  const listed = await env.FILES.list({ prefix: `run-files/${runId}/` });
  return listed.objects.length;
};

/** The rows of run `runId`'s files, by state. */
const rowsOf = async (runId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT state FROM workflow_run_files WHERE run_id = ? ORDER BY created_at"
  )
    .bind(runId)
    .all<{ state: string }>();
  return results.map(({ state }) => state);
};

/** Opens, appends `text` to and finishes a file of `caller`'s run. */
const written = async (
  caller: ReturnType<typeof callerOf>,
  text: string,
  type = "text/plain"
) => {
  const opened = await callFiles(env, caller.next(), "open", {
    name: "a.txt",
    type,
  });
  const file = String(fieldOf(opened.output, "file"));
  await callFiles(env, caller.next(), "append", {
    file,
    content: base64Of(text),
  });
  const done = await callFiles(env, caller.next(), "finish", { file });
  return { file, ref: done.output };
};

describe("a workflow run's own files", () => {
  it("take only the task that opened a file as its writer, and a replay writes nothing twice", async () => {
    const caller = callerOf();
    const opened = await callFiles(env, caller.next(), "open", {
      name: "a.txt",
      type: "text/plain",
    });
    const file = String(fieldOf(opened.output, "file"));
    await callFiles(env, caller.next(), "append", {
      file,
      content: base64Of("half"),
    });
    // The attempt died here; its replay opens and adds the same again.
    const reopened = await callFiles(env, caller.again(1), "open", {
      name: "a.txt",
      type: "text/plain",
    });
    const replayed = await callFiles(env, caller.again(2), "append", {
      file,
      content: base64Of("half"),
    });
    // A piece whose put failed is stored by the same append again.
    const failing = { ...env, FILES: failingOn("put") };
    const third = caller.next();
    const putFailed = await outcome(
      callFiles(failing, third, "append", { file, content: base64Of(" way") })
    );
    await callFiles(env, third, "append", { file, content: base64Of(" way") });
    const finishing = caller.next();
    const done = await callFiles(env, finishing, "finish", { file });
    // The whole attempt again, after it finished the file: each call
    // answers what it did the first time.
    const afterFinish = {
      open: await outcome(
        callFiles(env, caller.again(1), "open", {
          name: "a.txt",
          type: "text/plain",
        })
      ),
      append: await outcome(
        callFiles(env, caller.again(2), "append", {
          file,
          content: base64Of("half"),
        })
      ),
      finish: await callFiles(env, finishing, "finish", { file }),
    };
    // An empty text file is one; an empty binary one isn't what it says.
    const empty = async (type: string) => {
      const emptyFile = await callFiles(env, caller.next(), "open", {
        name: "empty",
        type,
      });
      return await outcome(
        callFiles(env, caller.next(), "finish", {
          file: String(fieldOf(emptyFile.output, "file")),
        })
      );
    };
    const emptyText = await empty("text/plain");
    const emptyPng = await empty("image/png");
    // Another task of the same run neither adds to it nor finishes it.
    const other = callerOf(caller.run, caller.workflowId);
    const secondFile = await callFiles(env, caller.next(), "open", {
      name: "b.txt",
      type: "text/plain",
    });
    const second = String(fieldOf(secondFile.output, "file"));
    const read = await callFiles(env, caller.next(), "read", {
      file,
      offset: 0,
      length: 100,
    });
    expect({
      sameFile: fieldOf(reopened.output, "file") === file,
      replayedSize: replayed.output,
      putFailed,
      done: done.output,
      read: atob(String(fieldOf(read.output, "content"))),
      afterFinish: { ...afterFinish, finish: afterFinish.finish.output },
      emptyText,
      emptyPng,
      otherAppends: await outcome(
        callFiles(env, other.next(), "append", {
          file: second,
          content: base64Of("x"),
        })
      ),
      otherFinishes: await outcome(
        callFiles(env, other.next(), "finish", { file: second })
      ),
    }).toStrictEqual({
      sameFile: true,
      replayedSize: { size: 4 },
      putFailed: "Error: R2 is down",
      done: {
        file,
        name: "a.txt",
        type: "text/plain",
        size: 8,
        sha256: await sha256HexOfBytes(new TextEncoder().encode("half way")),
      },
      read: "half way",
      afterFinish: {
        open: "ok",
        append: "ok",
        finish: {
          file,
          name: "a.txt",
          type: "text/plain",
          size: 8,
          sha256: await sha256HexOfBytes(new TextEncoder().encode("half way")),
        },
      },
      emptyText: "ok",
      emptyPng: "file.content_mismatch",
      otherAppends: "file.not_writable",
      otherFinishes: "file.not_writable",
    });
  });

  it("answer a replayed delete as done, refuse a replayed open that asks for another file, and refuse a stale attempt before anything is stored", async () => {
    const caller = callerOf();
    const { file } = await written(caller, "gone");
    const deleting = caller.next();
    const deleted = await outcome(callFiles(env, deleting, "delete", { file }));
    const deletedAgain = await outcome(
      callFiles(env, deleting, "delete", { file })
    );
    const opening = caller.next();
    const opened = await callFiles(env, opening, "open", {
      name: "b.txt",
      type: "text/plain",
    });
    const openFile = String(fieldOf(opened.output, "file"));
    const otherName = await outcome(
      callFiles(env, opening, "open", { name: "c.txt", type: "text/plain" })
    );
    const otherType = await outcome(
      callFiles(env, opening, "open", { name: "b.txt", type: "text/csv" })
    );
    // Stale from its first check: refused before anything is decided.
    const staleCall = await outcome(
      callFiles(env, caller.next(staleFrom(1)), "append", {
        file: openFile,
        content: base64Of("late"),
      })
    );
    // Stale by the time it would reserve its bytes: nothing reserved.
    const staleReserve = await outcome(
      callFiles(env, caller.next(staleFrom(2)), "append", {
        file: openFile,
        content: base64Of("late"),
      })
    );
    const reservedSize = await env.DB.prepare(
      "SELECT size FROM workflow_run_files WHERE id = ?"
    )
      .bind(openFile)
      .first<{ size: number }>();
    // Stale by the time its bytes would go to R2.
    const stalePut = await outcome(
      callFiles(env, caller.next(staleFrom(3)), "append", {
        file: openFile,
        content: base64Of("late"),
      })
    );
    // Stale by the time it would mark the file deleted: still there.
    const staleDelete = await outcome(
      callFiles(env, caller.next(staleFrom(2)), "delete", { file: openFile })
    );
    // Stale by the time a file not of its type would be deleted, after
    // hashing it: refused, the file left as it was.
    const mismatched = caller.next();
    const wrong = await callFiles(env, mismatched, "open", {
      name: "w.txt",
      type: "text/plain",
    });
    const wrongFile = String(fieldOf(wrong.output, "file"));
    await callFiles(env, caller.next(), "append", {
      file: wrongFile,
      content: toBase64(Uint8Array.of(0x61, 0xff)),
    });
    const staleMismatch = await outcome(
      callFiles(env, caller.next(staleFrom(2)), "finish", { file: wrongFile })
    );
    const rowsAfterStale = await rowsOf(caller.run);
    expect({
      deleted,
      deletedAgain,
      otherName,
      otherType,
      staleDelete,
      staleMismatch,
      rowsAfterStale: rowsAfterStale.slice(1),
      staleCall,
      staleReserve,
      reserved: reservedSize?.size,
      stalePut,
      stored: await objectsOf(caller.run),
    }).toStrictEqual({
      deleted: "ok",
      deletedAgain: "ok",
      otherName: "workflow.call_invalid",
      otherType: "workflow.call_invalid",
      staleDelete: "Error: The attempt went stale",
      staleMismatch: "Error: The attempt went stale",
      // The open file and the mismatched one, both still being written.
      rowsAfterStale: ["writing", "writing"],
      staleCall: "Error: The attempt went stale",
      staleReserve: "Error: The attempt went stale",
      reserved: 0,
      stalePut: "Error: The attempt went stale",
      // The deleted file's bytes, which the sweep takes later, and the
      // mismatched file's, still being written.
      stored: 2,
    });
  });

  it("answer an attempt's calls again as they answered, once its own later call deleted the file, storing nothing again", async () => {
    const caller = callerOf();
    const opened = await callFiles(env, caller.next(), "open", {
      name: "short.txt",
      type: "text/plain",
    });
    const file = String(fieldOf(opened.output, "file"));
    const appended = await callFiles(env, caller.next(), "append", {
      file,
      content: base64Of("hello"),
    });
    const finished = await callFiles(env, caller.next(), "finish", { file });
    await callFiles(env, caller.next(), "delete", { file });
    const stored = await objectsOf(caller.run);
    // The attempt cut off after its delete: its calls, replayed in order.
    const openAgain = await callFiles(env, caller.again(1), "open", {
      name: "short.txt",
      type: "text/plain",
    });
    const appendAgain = await callFiles(env, caller.again(2), "append", {
      file,
      content: base64Of("hello"),
    });
    const finishAgain = await callFiles(env, caller.again(3), "finish", {
      file,
    });
    const replayed = {
      open: openAgain.output,
      append: appendAgain.output,
      finish: finishAgain.output,
      delete: await outcome(
        callFiles(env, caller.again(4), "delete", { file })
      ),
    };
    // A new call finds it gone.
    const later = await outcome(
      callFiles(env, caller.next(), "append", {
        file,
        content: base64Of("more"),
      })
    );
    expect({
      replayed,
      later,
      storedAgain: (await objectsOf(caller.run)) - stored,
    }).toStrictEqual({
      replayed: {
        open: opened.output,
        append: appended.output,
        finish: finished.output,
        delete: "ok",
      },
      later: "file.not_found",
      storedAgain: 0,
    });
  });

  it("leave no bytes behind when a delete and a sweep land while an append is under way, and finish only the file as hashed", async () => {
    // The file deleted, and swept within the grace, while its append's put
    // is under way: the sweep leaves the chunk, the put lands and finds its
    // file gone, so deletes its object again; a later sweep takes the row.
    const graced = callerOf();
    const gracedOpen = await callFiles(env, graced.next(), "open", {
      name: "a.txt",
      type: "text/plain",
    });
    const gracedFile = String(fieldOf(gracedOpen.output, "file"));
    const deleter = graced.next();
    const sweptDuring = runningBefore("put", async () => {
      await callFiles(env, deleter, "delete", { file: gracedFile });
      await sweepRunFiles(env, new Date());
    });
    const gracedAppend = await outcome(
      callFiles({ ...env, FILES: sweptDuring }, graced.next(), "append", {
        file: gracedFile,
        content: base64Of("racing"),
      })
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
    const lateOpen = await callFiles(env, late.next(), "open", {
      name: "a.txt",
      type: "text/plain",
    });
    const lateFile = String(fieldOf(lateOpen.output, "file"));
    const lateDeleter = late.next();
    const sweptPast = runningBefore("put", async () => {
      await callFiles(env, lateDeleter, "delete", { file: lateFile });
      await sweepRunFiles(env, new Date(Date.now() + sweepGraceMs + 1000));
    });
    const lateAppend = await outcome(
      callFiles({ ...env, FILES: sweptPast }, late.next(), "append", {
        file: lateFile,
        content: base64Of("racing"),
      })
    );
    // A put that lands after the sweep deleted the chunk's object from R2,
    // but before it deleted the chunk's row: kept by neither.
    const between = callerOf();
    const betweenOpen = await callFiles(env, between.next(), "open", {
      name: "a.txt",
      type: "text/plain",
    });
    const betweenFile = String(fieldOf(betweenOpen.output, "file"));
    const betweenDeleter = between.next();
    const { promise: held, resolve: release } =
      Promise.withResolvers<boolean>();
    const { promise: atPut, resolve: reachedPut } =
      Promise.withResolvers<boolean>();
    const putHeld = runningBefore("put", async () => {
      reachedPut(true);
      await held;
    });
    const betweenAppend = outcome(
      callFiles({ ...env, FILES: putHeld }, between.next(), "append", {
        file: betweenFile,
        content: base64Of("racing"),
      })
    );
    await atPut;
    await callFiles(env, betweenDeleter, "delete", { file: betweenFile });
    // The sweep's R2 delete lets the put land, and waits for the append to
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
              await betweenAppend;
              return result;
            }
          : (...args: unknown[]): unknown => Reflect.apply(value, target, args);
      },
    });
    await sweepRunFiles(
      { ...env, FILES: deleteThenPut },
      new Date(Date.now() + sweepGraceMs + 1000)
    );
    const betweenResult = await betweenAppend;
    // An append that grows the file while it is being hashed.
    const grown = callerOf();
    const grownOpen = await callFiles(env, grown.next(), "open", {
      name: "a.txt",
      type: "text/plain",
    });
    const grownFile = String(fieldOf(grownOpen.output, "file"));
    await callFiles(env, grown.next(), "append", {
      file: grownFile,
      content: base64Of("abc"),
    });
    const growing = runningBefore("get", async () => {
      await grow(1, grownFile);
    });
    const grownFinish = await outcome(
      callFiles({ ...env, FILES: growing }, grown.next(), "finish", {
        file: grownFile,
      })
    );
    expect({
      gracedAppend,
      gracedDuring,
      gracedAfter,
      lateAppend,
      lateObjects: await objectsOf(late.run),
      betweenResult,
      betweenObjects: await objectsOf(between.run),
      grownFinish,
      grownRows: await rowsOf(grown.run),
    }).toStrictEqual({
      // Its file deleted while it was under way: nothing kept.
      gracedAppend: "file.not_found",
      gracedDuring: 0,
      gracedAfter: { objects: 0, rows: [] },
      lateAppend: "file.not_found",
      lateObjects: 0,
      betweenResult: "file.not_found",
      betweenObjects: 0,
      grownFinish: "file.incomplete",
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
    const asType = async (bytes: number[] | string, type: string) => {
      const opened = await callFiles(env, caller.next(), "open", {
        name: type.includes("officedocument") ? "f.docx" : "f",
        type,
      });
      const file = String(fieldOf(opened.output, "file"));
      await callFiles(env, caller.next(), "append", {
        file,
        content:
          typeof bytes === "string"
            ? base64Of(bytes)
            : toBase64(Uint8Array.from(bytes)),
      });
      return await outcome(callFiles(env, caller.next(), "finish", { file }));
    };
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
      unlisted: await outcome(
        callFiles(env, caller.next(), "open", { name: "x", type: "text/html" })
      ),
    }).toStrictEqual({
      png: "ok",
      pngAsText: "file.content_mismatch",
      textAsPdf: "file.content_mismatch",
      json: "ok",
      notUtf8: "file.content_mismatch",
      nul: "file.content_mismatch",
      docx: "ok",
      unlisted: "workflow.call_invalid",
    });
  });

  it("keep a connector's answer as one finished file of the run, whatever its size, and the same call again as the same file, only of the same bytes", async () => {
    const caller = callerOf();
    // Past one call's bytes: written in pieces.
    const text = bodyOf(runFileLimits.callBytes * 2 + 10);
    const bytes = new TextEncoder().encode(text);
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
        bytes: new TextEncoder().encode(bodyOf(10)),
      })
    );
    const read = await callFiles(env, caller.next(), "read", {
      file,
      offset: 0,
      length: runFileLimits.callBytes,
    });
    // Not text it says it is: refused, and it holds no place in the run.
    const notText = await outcome(
      keepFile(env, caller.next(), {
        name: "x.txt",
        type: "text/plain",
        bytes: Uint8Array.from([0x61, 0xff, 0xfe]),
      })
    );
    expect({
      ref: {
        file: file.length > 0,
        name: fieldOf(kept.output, "name"),
        type: fieldOf(kept.output, "type"),
        size: fieldOf(kept.output, "size"),
        sha256: fieldOf(kept.output, "sha256"),
      },
      again: fieldOf(again.output, "file") === file,
      other,
      size: fieldOf(read.output, "size"),
      notText,
      rows: await rowsOf(caller.run),
    }).toStrictEqual({
      ref: {
        file: true,
        name: "report.csv",
        type: "text/csv",
        size: bytes.length,
        sha256: await sha256HexOfBytes(bytes),
      },
      again: true,
      other: "workflow.call_invalid",
      size: bytes.length,
      notText: "file.content_mismatch",
      rows: ["done", "deleted"],
    });
  });

  it("name a Word or Excel document with its own extension: refused otherwise when written, renamed when kept", async () => {
    const caller = callerOf();
    const docx =
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const xlsx =
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const zip = Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 1);
    const opening = async (name: string, type: string) =>
      await outcome(callFiles(env, caller.next(), "open", { name, type }));
    const kept = async (name: string, type: typeof docx | typeof xlsx) => {
      const answer = await keepFile(env, caller.next(), {
        name,
        type,
        bytes: zip,
      });
      return fieldOf(answer.output, "name");
    };
    expect({
      written: {
        docm: await opening("letter.docm", docx),
        xlsxAsDocx: await opening("sheet.xlsx", docx),
        kelvin: await opening("letter.doc\u212Ax", docx),
        upperCase: await opening("LETTER.DOCX", docx),
        xlsx: await opening("sheet.xlsx", xlsx),
      },
      kept: {
        docm: await kept("letter.docm", docx),
        none: await kept("letter", docx),
        onlyExtension: await kept(".xlsm", xlsx),
        fits: await kept("Sheet.XLSX", xlsx),
      },
    }).toStrictEqual({
      written: {
        docm: "workflow.call_invalid",
        xlsxAsDocx: "workflow.call_invalid",
        kelvin: "workflow.call_invalid",
        upperCase: "ok",
        xlsx: "ok",
      },
      kept: {
        docm: "letter.docx",
        none: "letter.docx",
        onlyExtension: "document.xlsx",
        fits: "Sheet.XLSX",
      },
    });
  });

  it("keep nothing of a longer first attempt for a shorter retried read, sealed or not", async () => {
    const piece = runFileLimits.callBytes;
    const longer = new TextEncoder().encode(bodyOf(piece * 3));
    const shorter = longer.subarray(0, piece * 2);
    const csv = { name: "report.csv", type: "text/csv" } as const;
    // A first attempt that wrote all its pieces, then lost its lease before
    // sealing: the retry's own pieces replay, the first attempt's third stays.
    const unsealed = callerOf();
    const first = unsealed.next();
    const as = (suffix: string): FilesCaller => ({
      ...first,
      effectKey: `${first.effectKey}#${suffix}`,
    });
    const opened = await callFiles(env, as("open"), "open", csv);
    const id = String(fieldOf(opened.output, "file"));
    for (let at = 0; at < 3; at += 1) {
      // oxlint-disable-next-line no-await-in-loop -- in order, as keepFile writes
      await callFiles(env, as(`piece${String(at)}`), "append", {
        file: id,
        content: toBase64(longer.subarray(at * piece, (at + 1) * piece)),
      });
    }
    const retried = await outcome(
      keepFile(env, first, { ...csv, bytes: shorter })
    );
    // A first attempt that sealed the longer file: the retry can't answer it.
    const sealed = callerOf();
    const once = sealed.next();
    await keepFile(env, once, { ...csv, bytes: longer });
    const again = await outcome(
      keepFile(env, once, { ...csv, bytes: shorter })
    );
    expect({
      retried,
      unsealedRows: await rowsOf(unsealed.run),
      again,
    }).toStrictEqual({
      retried: "workflow.call_invalid",
      unsealedRows: ["writing"],
      again: "workflow.call_invalid",
    });
  });

  it("keep nothing of a connector read whose attempt went stale while it was answered, and seal nothing once it goes stale mid-write", async () => {
    const csv = { name: "report.csv", type: "text/csv" } as const;
    const bytes = new TextEncoder().encode(bodyOf(runFileLimits.callBytes * 2));
    // Stale before the answer is kept: no file, no reserved byte.
    const expired = callerOf();
    const before = await outcome(
      keepFile(env, expired.next(staleFrom(1)), { ...csv, bytes })
    );
    // Stale after its pieces are written and hashed, just before it is
    // sealed (open, then three checks a piece, then finish's two): never
    // sealed, swept as unfinished.
    const late = callerOf();
    const midway = await outcome(
      keepFile(env, late.next(staleFrom(9)), { ...csv, bytes })
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
    // Open at once: the ninth is refused.
    const opener = callerOf();
    for (let at = 0; at < runFileLimits.openWrites; at += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await callFiles(env, opener.next(), "open", {
        name: `f${at}`,
        type: "text/plain",
      });
    }
    const ninth = await outcome(
      callFiles(env, opener.next(), "open", { name: "f", type: "text/plain" })
    );
    // A run's files: the hundred and first is refused.
    const many = callerOf();
    for (let at = 0; at < runFileLimits.runFiles; at += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await written(many, "x");
    }
    const hundredFirst = await outcome(
      callFiles(env, many.next(), "open", { name: "f", type: "text/plain" })
    );
    // A piece past a call's bytes is refused as it is asked.
    const big = callerOf();
    const opened = await callFiles(env, big.next(), "open", {
      name: "big",
      type: "text/plain",
    });
    const file = String(fieldOf(opened.output, "file"));
    const pastCall = await outcome(
      callFiles(env, big.next(), "append", {
        file,
        content: base64Of("x".repeat(runFileLimits.callBytes + 1)),
      })
    );
    // A file, a run and a workflow already near their limits.
    await grow(runFileLimits.fileBytes - 1, file);
    const pastFile = await outcome(
      callFiles(env, big.next(), "append", { file, content: base64Of("xx") })
    );
    const run = callerOf();
    const runFile = await written(run, "x");
    await grow(runFileLimits.runBytes - 2, runFile.file);
    const runOpened = await callFiles(env, run.next(), "open", {
      name: "more",
      type: "text/plain",
    });
    const pastRun = await outcome(
      callFiles(env, run.next(), "append", {
        file: String(fieldOf(runOpened.output, "file")),
        content: base64Of("xx"),
      })
    );
    const workflowId = crypto.randomUUID();
    const earlier = callerOf(crypto.randomUUID(), workflowId);
    const earlierFile = await written(earlier, "x");
    await grow(runFileLimits.workflowBytes - 2, earlierFile.file);
    const later = callerOf(crypto.randomUUID(), workflowId);
    const laterOpened = await callFiles(env, later.next(), "open", {
      name: "later",
      type: "text/plain",
    });
    const laterFile = String(fieldOf(laterOpened.output, "file"));
    const pastWorkflow = await outcome(
      callFiles(env, later.next(), "append", {
        file: laterFile,
        content: base64Of("xx"),
      })
    );
    // Deleted, though not yet swept: only live files count, so its space
    // is back at once (GRA-950).
    await callFiles(env, earlier.next(), "delete", { file: earlierFile.file });
    const afterDelete = await outcome(
      callFiles(env, later.next(), "append", {
        file: laterFile,
        content: base64Of("xx"),
      })
    );
    expect({
      ninth,
      hundredFirst,
      pastCall,
      pastFile,
      pastRun,
      pastWorkflow,
      afterDelete,
      // Refused before anything reached R2.
      storedPastFile: await objectsOf(big.run),
    }).toStrictEqual({
      ninth: "file.writes_open",
      hundredFirst: "file.run_full",
      pastCall: "workflow.call_invalid",
      pastFile: "file.run_too_large",
      pastRun: "file.run_full",
      pastWorkflow: "file.workflow_quota",
      afterDelete: "ok",
      storedPastFile: 0,
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
    // One opened, added to, and never finished.
    const orphan = callerOf();
    const opened = await callFiles(env, orphan.next(), "open", {
      name: "left",
      type: "text/plain",
    });
    await callFiles(env, orphan.next(), "append", {
      file: String(fieldOf(opened.output, "file")),
      content: base64Of("left"),
    });
    await sweepRunFiles(env, new Date(Date.now() + runFileLimits.orphanMs / 2));
    const halfDay = await rowsOf(orphan.run);
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
      halfDay: ["writing"],
      orphan: { objects: 0, rows: [] },
    });
  }, 120_000);
});

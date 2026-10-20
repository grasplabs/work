/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { sha256HexOfBytes, toBase64 } from "@grasp-os/shared/encoding";
import { agentIdSchema } from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { runFileLimits } from "@grasp-os/shared/run-files";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { appFor } from "../src/apps.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import {
  approveWorkflowBinding,
  revokeWorkflowBinding,
} from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import type { StartInvoker } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { sweepWorkflowStartDetails } from "../src/workflows/retention.ts";
import { callFiles, sweepRunFiles } from "../src/workflows/run-files.ts";
import type { FilesCaller } from "../src/workflows/run-files.ts";
import { allEvents } from "./audit-events.ts";
import { outcome, unique } from "./sign-in.ts";

// A workflow run's own files (GRA-724, workflows/run-files.ts), from its
// threat model: a file is its run's alone, found by nothing else, a
// restricted run's included; only the operations a use declares, each
// decided again; only the task that opened a file writes it, and a
// replay writes nothing twice; its bytes are what its type says; every
// limit holds before bytes are stored; it goes with its run's details,
// and what R2 refuses is deleted on the next sweep; its receipts carry
// its digest, never its name.

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

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** The text of `size` characters the actions write and check. */
const bodyOf = (size: number): string =>
  "abcdefghij".repeat(Math.ceil(size / 10)).slice(0, size);

/**
 * The module of the workflow's actions, its files use declaring
 * `operations`: `writeFile` writes a CSV of `size` characters and answers
 * its reference; `readFile` reads the file a reference names; `go` does
 * what its `mode` says, with the file its input names.
 */
const filesModule = (
  operations = '["write", "read", "list", "delete"]'
): string => `import { action, resource, v } from "@grasp-os/sdk/action";

const files = resource.files("files", { operations: ${operations} });
const ref = v.object({
  file: v.string(),
  name: v.string(),
  type: v.string(),
  size: v.number(),
  sha256: v.string(),
});
const bodyOf = (size: number) => "abcdefghij".repeat(Math.ceil(size / 10)).slice(0, size);
// Untyped, so a use declaring fewer operations still builds: the host is
// what refuses an undeclared one.
const loose = (files: unknown) =>
  files as {
    write: (request: object) => Promise<{ file: string; name: string; type: string; size: number; sha256: string }>;
    read: (request: object) => Promise<string>;
    list: () => Promise<{ file: string }[]>;
  };

export const writeFile = action({
  args: { size: v.number() },
  returns: ref,
  uses: [files],
  handler: async (ctx, args) =>
    await loose(ctx.resources.files).write({
      name: "report.csv",
      type: "text/csv",
      content: bodyOf(args.size),
    }),
});

export const readFile = action({
  args: { file: v.string() },
  returns: v.object({ status: v.string() }),
  uses: [files],
  handler: async (ctx, args) => {
    const text = await loose(ctx.resources.files).read({ file: args.file });
    return { status: JSON.stringify({ length: text.length, same: text === bodyOf(text.length) }) };
  },
});

export const go = action({
  args: { mode: v.string(), file: v.string() },
  returns: v.object({ status: v.string() }),
  uses: [files],
  handler: async (ctx, args) => {
    if (args.mode === "write") {
      const written = await loose(ctx.resources.files).write({ name: "notes.md", type: "text/markdown", content: "# Notes" });
      return { status: JSON.stringify(written) };
    }
    if (args.mode === "both") {
      const written = await loose(ctx.resources.files).write({ name: "notes.md", type: "text/markdown", content: "# Notes" });
      const text = await loose(ctx.resources.files).read({ file: written.file });
      const listed = await loose(ctx.resources.files).list();
      return { status: JSON.stringify({ text, listed: listed.map(({ file }) => file === written.file) }) };
    }
    if (args.mode === "lie") {
      await loose(ctx.resources.files).write({ name: "report.pdf", type: "application/pdf", content: "not a pdf" });
      return { status: "kept" };
    }
    if (args.mode === "list") {
      const listed = await loose(ctx.resources.files).list();
      return { status: String(listed.length) };
    }
    const text = await loose(ctx.resources.files).read({ file: args.file });
    return { status: text };
  },
});
`;

const call = (
  task: string,
  binding: string,
  args: Record<string, unknown>
) => ({
  [task]: {
    call: "grasp.operation",
    with: { binding, arguments: args },
  },
});

/** Suspends a run before its action: time to change what it relies on. */
const hold = { hold: { wait: "PT1S" } };

/** What `go` does: its mode and file, as the run's input. */
const goTask = call("go", "go", {
  mode: "${ $workflow.input.mode }",
  file: "${ $workflow.input.file }",
});

/** A definition of `name` running `tasks`, its files binding `key`. */
const definitionOf = (name: string, key: string, tasks: unknown[]): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: {
          profile: "grasp-open-workflow/1",
          params: {},
          bindings: {
            writeFile: {
              kind: "operation",
              contract: "local:code/files.ts#writeFile",
            },
            readFile: {
              kind: "operation",
              contract: "local:code/files.ts#readFile",
            },
            go: { kind: "operation", contract: "local:code/files.ts#go" },
            files: { kind: "files", contract: key },
          },
        },
      },
    },
    input: {
      schema: objectSchema({
        mode: { type: "string" },
        file: { type: "string" },
        size: { type: "number" },
      }),
    },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: tasks,
  });

/**
 * A workflow of `by`'s running `tasks`, its files binding approved by
 * `admin` for version 1: its ID and the approval's.
 */
const filesWorkflow = async (
  by: Identity,
  admin: Identity,
  tasks: unknown[],
  module = filesModule()
) => {
  const key = `files-${unique()}`;
  await publishCatalogContract(env, admin, { key, kind: "files" });
  const workflow = await createWorkflowResource(env, by, `files-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: definitionOf(workflow.name, key, tasks),
    basedOn: null,
    modules: { "code/files.ts": module },
  });
  const approval = await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "files",
    target: { kind: "files" },
    reviewed: { version: 1 },
  });
  return { workflow, approval: approval.id };
};

/** Starts version 1 of workflow `id` for `by` on `input`, as `invoker`. */
const started = async (
  by: Identity,
  id: string,
  input: { mode?: string; file?: string; size?: number },
  invoker?: StartInvoker
): Promise<string> => {
  const { runId } = await startWorkflow(
    env,
    invoker ?? { type: "person", person: by },
    id,
    {
      version: 1,
      input: { mode: "", file: "", size: 0, ...input },
      key: unique(),
    }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  return runId;
};

/** How run `runId` of workflow `id` ended. */
const ended = async (by: Identity, id: string, runId: string) => {
  const run: WorkflowResourceRun = await vi.waitFor(
    async () => {
      const read = await resourceRunFor(env, by, id, runId);
      expect(read.endedAt).not.toBeNull();
      return read;
    },
    { timeout: 60_000, interval: 100 }
  );
  return run.status === "completed"
    ? { status: run.status, output: run.output }
    : { status: run.status, code: run.error?.code };
};

/** The receipts of run `runId`'s file calls, as the audit log keeps them. */
const fileReceiptsOf = async (runId: string) => {
  const events = await allEvents();
  return events.filter(
    (event) =>
      event.action === "workflow.run.called" &&
      event.target?.id === runId &&
      event.detail?.call === "grasp.files"
  );
};

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
    /** The next call's caller, as the action host numbers its calls. */
    next: (): FilesCaller => {
      ordinal += 1;
      return { runId: run, workflowId, effectKey: `${step}:${ordinal}` };
    },
    /** The caller of call `n` again: a retry or replay of it. */
    again: (n: number): FilesCaller => ({
      runId: run,
      workflowId,
      effectKey: `${step}:${n}`,
    }),
  };
};

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
  it("are written in pieces by one task and read back by reference in the next, their receipts carrying the digest and never the name", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const size = 3 * 1024 * 1024 + 7;
    const { workflow } = await filesWorkflow(ada, admin, [
      call("write-file", "writeFile", { size: "${ $workflow.input.size }" }),
      call("read-file", "readFile", { file: "${ .file }" }),
    ]);
    const runId = await started(ada, workflow.id, { size });
    const end = await ended(ada, workflow.id, runId);
    const receipts = await fileReceiptsOf(runId);
    const sha256 = await sha256HexOfBytes(
      new TextEncoder().encode(bodyOf(size))
    );
    const finished = receipts.filter(
      ({ detail }) => detail?.outcome === "done" && detail.sha256 === sha256
    );
    expect({
      end,
      // Open, seven pieces and finish; then seven reads.
      calls: receipts.filter(({ detail }) => detail?.outcome === "done").length,
      // The finish and every read name the file by its digest.
      digested: finished.length,
      named: JSON.stringify(receipts).includes("report.csv"),
    }).toStrictEqual({
      end: {
        status: "completed",
        output: { status: JSON.stringify({ length: size, same: true }) },
      },
      calls: 16,
      digested: 8,
      named: false,
    });
  });

  it("are another run's nothing: one handed another run's file, a restricted run's too, finds none", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await filesWorkflow(ada, admin, [goTask]);
    const first = await ended(
      ada,
      workflow.id,
      await started(ada, workflow.id, { mode: "write" })
    );
    const status = fieldOf(first.output, "status");
    const ref: unknown = JSON.parse(typeof status === "string" ? status : "{}");
    const file = String(fieldOf(ref, "file"));
    // An agent's start that names no chat starts restricted
    // (workflow-starts.ts, `restrictedStart`).
    const agentId = agentIdSchema.parse(`agent-${unique()}`);
    const asked = await requestPermission(
      env,
      ada,
      {
        subject: { type: "agent", agentId },
        object: { type: "workflow", workflowId: workflow.id },
        actions: ["start"],
        binding: `START_${unique().toUpperCase().replaceAll("-", "_")}`,
      } satisfies PermissionRequest,
      {
        app: async (named: string, role: "user" | "builder") =>
          await appFor(env, ada, named, role),
        resource: async (
          refOf: Parameters<typeof requireResourceRole>[2],
          needed: Parameters<typeof requireResourceRole>[3]
        ) => {
          await requireResourceRole(env, ada, refOf, needed);
        },
      }
    );
    await grantPermission(env, admin, asked.id, { version: null });
    const agent: StartInvoker = {
      type: "agent",
      authority: {
        subject: { type: "agent", agentId },
        onBehalfOf: ada.userId,
        mode: "interactive",
      },
    };
    const restricted = await ended(
      ada,
      workflow.id,
      await started(ada, workflow.id, { mode: "both" }, agent)
    );
    const restrictedFile = await env.DB.prepare(
      "SELECT id FROM workflow_run_files WHERE workflow_resource_id = ? AND name = 'notes.md' ORDER BY created_at DESC LIMIT 1"
    )
      .bind(workflow.id)
      .first<{ id: string }>();
    const otherRun = await ended(
      ada,
      workflow.id,
      await started(ada, workflow.id, { mode: "read", file })
    );
    const fromRestricted = await ended(
      ada,
      workflow.id,
      await started(ada, workflow.id, {
        mode: "read",
        file: restrictedFile?.id ?? "",
      })
    );
    expect({
      first: first.status,
      restricted,
      otherRun,
      fromRestricted,
    }).toStrictEqual({
      first: "completed",
      // Its own file, within the run.
      restricted: {
        status: "completed",
        output: {
          status: JSON.stringify({ text: "# Notes", listed: [true] }),
        },
      },
      otherRun: { status: "failed", code: "file.not_found" },
      fromRestricted: { status: "failed", code: "file.not_found" },
    });
  });

  it("refuse an operation the use doesn't declare, and the next call once the files approval is revoked", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const writeOnly = await filesWorkflow(
      ada,
      admin,
      [goTask],
      filesModule('["write"]')
    );
    const undeclaredRun = await started(ada, writeOnly.workflow.id, {
      mode: "list",
    });
    const undeclared = await ended(ada, writeOnly.workflow.id, undeclaredRun);
    const revoked = await filesWorkflow(ada, admin, [hold, goTask]);
    const revokedRun = await started(ada, revoked.workflow.id, {
      mode: "write",
    });
    await revokeWorkflowBinding(
      env,
      admin,
      revoked.workflow.id,
      revoked.approval
    );
    const revokedEnd = await ended(ada, revoked.workflow.id, revokedRun);
    const events = await allEvents();
    expect({
      undeclared,
      refused: events
        .filter(
          (event) =>
            event.action === "workflow.call.refused" &&
            event.target?.id === undeclaredRun
        )
        .map(({ detail }) => ({ call: detail?.call, reason: detail?.reason })),
      revoked: revokedEnd,
      revokedFiles: await rowsOf(revokedRun),
    }).toStrictEqual({
      undeclared: { status: "failed", code: "workflow.call_denied" },
      refused: [{ call: "files", reason: "operation_undeclared" }],
      revoked: { status: "failed", code: "workflow.call_denied" },
      revokedFiles: [],
    });
  });

  it("refuse a file whose bytes aren't its type, which then holds no place in the run", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await filesWorkflow(ada, admin, [goTask]);
    const runId = await started(ada, workflow.id, { mode: "lie" });
    expect({
      end: await ended(ada, workflow.id, runId),
      files: await rowsOf(runId),
    }).toStrictEqual({
      end: { status: "failed", code: "file.content_mismatch" },
      files: ["deleted"],
    });
  });

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
    const done = await callFiles(env, caller.next(), "finish", { file });
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
      otherAppends: "file.not_writable",
      otherFinishes: "file.not_writable",
    });
  });

  it("check a file's bytes against its type: a signature for a binary type, UTF-8 for text", async () => {
    const caller = callerOf();
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];
    const asType = async (bytes: number[] | string, type: string) => {
      const opened = await callFiles(env, caller.next(), "open", {
        name: "f",
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
    const pastWorkflow = await outcome(
      callFiles(env, later.next(), "append", {
        file: String(fieldOf(laterOpened.output, "file")),
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
      // Refused before anything reached R2.
      storedPastFile: await objectsOf(big.run),
    }).toStrictEqual({
      ninth: "file.writes_open",
      hundredFirst: "file.run_full",
      pastCall: "workflow.call_invalid",
      pastFile: "file.run_too_large",
      pastRun: "file.run_full",
      pastWorkflow: "file.workflow_quota",
      storedPastFile: 0,
    });
  }, 120_000);

  it("go with their run's details, the sweep deleting their chunks and trying again what R2 refused, and a file never finished a day after it opened", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await filesWorkflow(ada, admin, [goTask]);
    const runId = await started(ada, workflow.id, { mode: "write" });
    const end = await ended(ada, workflow.id, runId);
    expect(end.status).toBe("completed");
    const before = {
      objects: await objectsOf(runId),
      rows: await rowsOf(runId),
    };
    // Its details are past their retention.
    const now = new Date();
    await sweepWorkflowStartDetails(env, new Date(now.getTime() + 1000), now);
    const marked = await rowsOf(runId);
    const refusing = { ...env, FILES: failingOn("delete") };
    const refused = await outcome(sweepRunFiles(refusing, now));
    const afterRefusal = {
      objects: await objectsOf(runId),
      rows: await rowsOf(runId),
    };
    await sweepRunFiles(env, now);
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
    await sweepRunFiles(
      env,
      new Date(Date.now() + runFileLimits.orphanMs + 1000)
    );
    expect({
      before,
      marked,
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
      refused: "Error: R2 is down",
      afterRefusal: { objects: 1, rows: ["deleted"] },
      swept: { objects: 0, rows: [] },
      halfDay: ["writing"],
      orphan: { objects: 0, rows: [] },
    });
  }, 120_000);
});

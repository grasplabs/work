import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  approveWorkflowBinding,
  revokeWorkflowBinding,
} from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { createWorkflowResource } from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { allEvents } from "./audit-events.ts";
import { unique } from "./sign-in.ts";
import { publishDefinition } from "./workflow-publishing.ts";

// A workflow's own steps on its run's files (`ctx.files.<alias>`), from
// their threat model (sealed-run.ts, run-files.ts): a step writes, lists,
// reads and deletes only its run's files, through its sealed permission
// and action; a file's ID from anything an expression reads, another
// run's or one a definition forges, finds nothing; a write is text of a
// text type, named as that type's file is; every call is decided again,
// so a revoked approval stops the next; its receipts carry a file's
// digest and ID, never its name or content.

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

/** A call of `action` on the run's files, as step `id`, with `args`. */
const files = (id: string, action: string, args: unknown = {}) => ({
  id,
  type: "call",
  files: "runFiles",
  action,
  args,
});

/** Writes the run's text as `notes.md`. */
const write = files("written", "write", {
  name: "notes.md",
  type: "text/markdown",
  text: { $expr: "args.text" },
});

/** Suspends a run before its next step: time to change what it relies on. */
const hold = { id: "hold", type: "wait", for: "1 second" };

/** What a run ends with: each field's type, and its value. */
type Ending = Readonly<Record<string, readonly [string, string]>>;

/**
 * A workflow of `by`'s running `steps` and ending with `ending`'s fields,
 * its files permission approved by `admin` for version 1.
 */
const filesWorkflow = async (
  by: Identity,
  admin: Identity,
  steps: readonly unknown[],
  ending: Ending = {}
) => {
  const fields = Object.entries(ending);
  const key = `files-${unique()}`;
  await publishCatalogContract(env, admin, { key, kind: "files" });
  const workflow = await createWorkflowResource(env, by, `files-${unique()}`);
  await publishDefinition(
    env,
    by,
    workflow.id,
    JSON.stringify({
      $schema: workflowSchemaUrl,
      args: {
        kind: "object",
        fields: { text: { kind: "string" }, file: { kind: "string" } },
      },
      ...(fields.length === 0
        ? {}
        : {
            returns: {
              kind: "object",
              fields: Object.fromEntries(
                fields.map(([name, [kind]]) => [name, { kind }])
              ),
            },
            result: Object.fromEntries(
              fields.map(([name, [, source]]) => [name, { $expr: source }])
            ),
          }),
      permissions: { files: { runFiles: { contract: key } } },
      steps,
    })
  );
  const approval = await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "runFiles",
    target: { kind: "files" },
    reviewed: { version: 1 },
  });
  return { workflow, approval: approval.id };
};

/** Starts version 1 of workflow `id` for `by`: its run's ID. */
const started = async (
  by: Identity,
  id: string,
  input: { text?: string; file?: string } = {}
): Promise<string> => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    { version: 1, args: { text: "", file: "", ...input }, key: unique() }
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
    ? { status: run.status, output: run.result }
    : { status: run.status, code: run.error?.code };
};

/** The receipts of run `runId`'s file calls, as the audit log keeps them. */
const fileReceiptsOf = async (runId: string) => {
  const events = await allEvents();
  return events
    .filter(
      (event) =>
        event.action === "workflow.run.called" &&
        event.target?.id === runId &&
        event.detail?.call === "grasp.files"
    )
    .map(({ detail }) => detail ?? {});
};

describe("a workflow's steps on its run's files", () => {
  it("write a text file, list it, read it back whole by its ID and delete it, the receipts carrying its digest and never its name or text", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow } = await filesWorkflow(
      ada,
      admin,
      [
        write,
        files("listed", "list"),
        files("notes", "read", { file: { $expr: "written.file" } }),
        files("removed", "delete", { file: { $expr: "written.file" } }),
        files("after", "list"),
      ],
      {
        text: ["string", "notes.text"],
        name: ["string", "notes.file.name"],
        type: ["string", "notes.file.type"],
        same: ["boolean", "notes.file.file === written.file"],
        listed: ["number", "listed.length"],
        after: ["number", "after.length"],
      }
    );
    const text = "# Notes\nThe invoice is due on Friday.";
    const runId = await started(ada, workflow.id, { text });
    const end = await ended(ada, workflow.id, runId);
    const receipts = await fileReceiptsOf(runId);
    expect({
      end,
      done: receipts
        .filter(({ outcome }) => outcome === "done")
        .map(({ operation }) => operation),
      // Never the file's name nor its text, in any receipt.
      leaks: receipts.filter((detail) =>
        /notes\.md|invoice is due/u.exec(JSON.stringify(detail))
      ),
      digests: receipts
        .filter(
          ({ operation, outcome }) =>
            operation === "write" && outcome === "done"
        )
        .map(
          ({ sha256 }) => typeof sha256 === "string" && sha256.length === 64
        ),
    }).toStrictEqual({
      end: {
        status: "completed",
        output: {
          text,
          name: "notes.md",
          type: "text/markdown",
          same: true,
          listed: 1,
          after: 0,
        },
      },
      done: ["write", "list", "read", "delete", "list"],
      leaks: [],
      digests: [true],
    });
  });

  it("find nothing by another run's file ID, nor by one a definition forges", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const writer = await filesWorkflow(ada, admin, [write], {
      file: ["string", "written.file"],
    });
    const writes = await ended(
      ada,
      writer.workflow.id,
      await started(ada, writer.workflow.id, { text: "Secret" })
    );
    const { file } = z.object({ file: z.string() }).parse(writes.output);
    const reader = await filesWorkflow(
      ada,
      admin,
      [files("notes", "read", { file: { $expr: "args.file" } })],
      { text: ["string", "notes.text"] }
    );
    const otherRun = await ended(
      ada,
      reader.workflow.id,
      await started(ada, reader.workflow.id, { file })
    );
    // Another workflow whose step forges the reference: the ID a literal.
    const forger = await filesWorkflow(
      ada,
      admin,
      [files("notes", "read", { file: { $expr: JSON.stringify(file) } })],
      { text: ["string", "notes.text"] }
    );
    const forgedRun = await started(ada, forger.workflow.id);
    const forged = await ended(ada, forger.workflow.id, forgedRun);
    const forgedReceipts = await fileReceiptsOf(forgedRun);
    expect({
      written: writes.status,
      otherRun,
      forged,
      // Its receipt says what was asked for: the file, and that none was.
      receipts: forgedReceipts.map(({ file: named, outcome }) => ({
        file: named,
        outcome,
      })),
    }).toStrictEqual({
      written: "completed",
      otherRun: { status: "failed", code: "file.not_found" },
      forged: { status: "failed", code: "file.not_found" },
      receipts: [
        { file, outcome: "started" },
        { file, outcome: "file.not_found" },
      ],
    });
  });

  it("write only text of a text type, and never nothing", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const endOf = async (args: Record<string, unknown>) => {
      const { workflow } = await filesWorkflow(ada, admin, [
        files("written", "write", args),
      ]);
      const runId = await started(ada, workflow.id);
      const end = await ended(ada, workflow.id, runId);
      const kept = await env.DB.prepare(
        "SELECT name FROM workflow_run_files WHERE run_id = ?"
      )
        .bind(runId)
        .first<{ name: string }>();
      return { ...end, kept: kept?.name ?? null };
    };
    expect({
      binary: await endOf({ name: "logo.png", type: "image/png", text: "x" }),
      empty: await endOf({ name: "notes.txt", type: "text/plain", text: "" }),
      text: await endOf({ name: "notes.txt", type: "text/plain", text: "x" }),
    }).toStrictEqual({
      binary: { status: "failed", code: "workflow.call_invalid", kept: null },
      empty: { status: "failed", code: "workflow.call_invalid", kept: null },
      text: { status: "completed", output: null, kept: "notes.txt" },
    });
  });

  it("stop at the next call once the files approval is revoked", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, approval } = await filesWorkflow(ada, admin, [
      hold,
      write,
    ]);
    const runId = await started(ada, workflow.id, { text: "Late" });
    await revokeWorkflowBinding(env, admin, workflow.id, approval);
    const end = await ended(ada, workflow.id, runId);
    const kept = await env.DB.prepare(
      "SELECT count(*) AS count FROM workflow_run_files WHERE run_id = ?"
    )
      .bind(runId)
      .first<{ count: number }>();
    expect({ end, files: kept?.count }).toStrictEqual({
      end: { status: "failed", code: "workflow.call_denied" },
      files: 0,
    });
  });
});

import { sha256Hex, sha256HexOfBytes } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appFor } from "../src/apps.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { createWorkflowResource } from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { allEvents } from "./audit-events.ts";
import {
  consentCode,
  graphAttachmentUrl,
  graphSentUrl,
} from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { routed, signedInApi, unique } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";
import { publishDefinition } from "./workflow-publishing.ts";

// A workflow's connection calls that keep a file (`into`) or attach run
// files (`from`), as steps of its own, from their threat model
// (sealed-run.ts, resource-calls.ts): only an action whose contract
// answers a file keeps one, and only one whose contract takes files
// attaches any, refused at publication otherwise; a kept file is the
// run's own, typed by its bytes, and read whole only as text; an
// attachment is a finished file of this run, named by its ID, and one of
// another run's is found nowhere, so nothing is sent; receipts carry a
// file's digest, never its name. Through the real connect, with Microsoft
// Graph as the outside system.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const identityOf = (userId: string, role: Role): Identity => ({
  userId,
  email: `${userId}@acme.test`,
  name: "Person",
  role,
  teams: [],
  staff: false,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

const rolesOf = (by: Identity) => ({
  app: async (named: string, role: "user" | "builder") =>
    await appFor(env, by, named, role),
  resource: async (
    ref: Parameters<typeof requireResourceRole>[2],
    needed: Parameters<typeof requireResourceRole>[3]
  ) => {
    await requireResourceRole(env, by, ref, needed);
  },
});

/** A permission `by` asks for and `admin` grants. */
const granted = async (
  by: Identity,
  admin: Identity,
  request: PermissionRequest
): Promise<string> => {
  const asked = await requestPermission(env, by, request, rolesOf(by));
  await grantPermission(env, admin, asked.id, { version: null });
  return asked.id;
};

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** The outside systems connect reaches (test/connect-providers.ts). */
const providers = (): Fetcher => {
  const fetcher = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(fetcher)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  return fetcher;
};

/** JSON text as the value it holds. */
const jsonOf = (text: string): unknown => {
  const value: unknown = JSON.parse(text);
  return value;
};

/** A shared Microsoft 365 account `admin` connects, as `subject`. */
const connectShared = async (admin: Person, subject: string) => {
  const { url } = await admin.api.connections.start({
    provider: "microsoft",
    scope: "shared",
  });
  const authorization = new URL(url);
  const query = new URLSearchParams({
    code: consentCode(authorization, acmeTenant, subject),
    state: authorization.searchParams.get("state") ?? "",
  });
  await routed(`/api/connections/callback?${query.toString()}`, {
    headers: { cookie: admin.session },
  });
  const listed = await admin.api.connections.list();
  const connection = listed.find(
    ({ accountName }) => accountName?.startsWith(`${subject}@`) === true
  );
  if (
    connection?.accountName === undefined ||
    connection.accountName === null
  ) {
    throw new Error("Expected the shared connection");
  }
  return { id: connection.id, mailbox: connection.accountName };
};

/** An attachment on message `message` of `mailbox`, as Graph will answer it. */
const attach = async (
  mailbox: string,
  message: string,
  attachment: {
    id: string;
    name: string;
    contentType: string;
    bytes: Uint8Array;
  }
): Promise<void> => {
  let binary = "";
  for (const byte of attachment.bytes) {
    binary += String.fromCodePoint(byte);
  }
  await providers().fetch(graphAttachmentUrl, {
    method: "POST",
    body: JSON.stringify({
      mailbox,
      message,
      id: attachment.id,
      name: attachment.name,
      contentType: attachment.contentType,
      contentBytes: btoa(binary),
    }),
  });
};

/**
 * Reads attachment `args.attachment` of `args.message` into the run's
 * files, reads it back whole, writes a note of its own and mails it,
 * attached from the run's files (`args.attach`, or the note).
 */
const steps = [
  {
    id: "kept",
    type: "call",
    connection: "mail",
    action: "mail.readAttachment",
    args: {
      mailbox: { $expr: "args.mailbox" },
      message: { $expr: "args.message" },
      attachment: { $expr: "args.attachment" },
    },
    into: "runFiles",
  },
  {
    id: "text",
    type: "call",
    files: "runFiles",
    action: "read",
    args: { file: { $expr: "kept.file.file" } },
  },
  {
    id: "note",
    type: "call",
    files: "runFiles",
    action: "write",
    args: {
      name: "note.txt",
      type: "text/plain",
      text: { $expr: '"Read: " + text.text' },
    },
  },
  {
    id: "sent",
    type: "call",
    connection: "mail",
    action: "mail.send",
    args: {
      mailbox: { $expr: "args.mailbox" },
      subject: "Invoice",
      body: "Attached.",
      to: ["billing@northwind.example.org"],
      attachments: [
        { file: { $expr: 'args.attach === "" ? note.file : args.attach' } },
      ],
    },
    from: "runFiles",
  },
];

/** A definition of `steps`, its mail contract `mail` and files `files`. */
const definitionOf = (
  mail: string,
  files: string,
  of: readonly unknown[] = steps
): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: {
      kind: "object",
      fields: {
        mailbox: { kind: "string" },
        message: { kind: "string" },
        attachment: { kind: "string" },
        attach: { kind: "string" },
      },
    },
    returns: {
      kind: "object",
      fields: {
        name: { kind: "string" },
        type: { kind: "string" },
        sha256: { kind: "string" },
        text: { kind: "string" },
      },
    },
    result: {
      name: { $expr: "kept.file.name" },
      type: { $expr: "kept.file.type" },
      sha256: { $expr: "kept.file.sha256" },
      text: { $expr: "text.text" },
    },
    permissions: {
      connections: { mail: { contract: mail } },
      files: { runFiles: { contract: files } },
    },
    steps: of,
  });

/**
 * The catalog contract of exactly the shapes the native connector makes
 * for its reads of attachments and its sends, answering and taking files
 * as it does: its key.
 */
const mailContract = async (
  admin: Identity,
  connectionId: string
): Promise<string> => {
  const served = await env.CONNECT.connectorContract({
    contract: "microsoft-365.mail@1",
    connectionId,
  });
  const shapeOf = (tool: string) => {
    const action = Object.values(served.actions).find(
      (each) => each.tool === tool
    );
    if (action === undefined) {
      throw new Error(`Expected ${tool} in the contract`);
    }
    return {
      input: JSON.stringify({ format: "json", document: jsonOf(action.input) }),
      output: JSON.stringify({
        format: "json",
        document: jsonOf(action.output),
      }),
    };
  };
  const key = `mail-${unique()}`;
  await publishCatalogContract(env, admin, {
    key,
    kind: "connector",
    operations: {
      "mail.readAttachment": {
        ...shapeOf("mail.readAttachment"),
        readOnly: true,
        answersFile: true,
      },
      "mail.send": { ...shapeOf("mail.send"), takesFiles: true },
    },
  });
  return key;
};

/**
 * `key`'s contract as one published before contracts recorded files:
 * stored under a key of its own without `answersFile` and `takesFiles`,
 * as contracts never change once published.
 */
const withoutFiles = async (key: string): Promise<string> => {
  const stored = await env.DB.prepare(
    "SELECT kind, contract, fingerprint, published_by AS publishedBy FROM workflow_catalog_contracts WHERE key = ?"
  )
    .bind(key)
    .first<{ kind: string; contract: string; publishedBy: string }>();
  const contract = z
    .object({
      operations: z.record(z.string(), z.record(z.string(), z.json())),
    })
    .loose()
    .parse(JSON.parse(stored?.contract ?? "{}"));
  const operations = Object.fromEntries(
    Object.entries(contract.operations).map(([name, operation]) => {
      const { answersFile: _a, takesFiles: _t, ...rest } = operation;
      return [name, rest];
    })
  );
  const text = canonicalJson(z.json().parse({ ...contract, operations }));
  const older = `${key}-older`;
  await env.DB.prepare(
    "INSERT INTO workflow_catalog_contracts (key, kind, contract, fingerprint, published_by, published_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(
      older,
      stored?.kind ?? "connector",
      text,
      await sha256Hex(text),
      stored?.publishedBy ?? "",
      Date.now()
    )
    .run();
  return older;
};

/**
 * A workflow of a builder's that keeps a shared Microsoft 365 account's
 * attachments and mails the run's files, its mail and files permissions
 * approved by an admin: the builder, the workflow and the mailbox.
 */
const filingWorkflow = async () => {
  const adminPerson = await signedInApi(idp, "admin");
  const builderPerson = await signedInApi(idp, "builder");
  const admin = identityOf(adminPerson.userId, "admin");
  const builder = identityOf(builderPerson.userId, "builder");
  const { id: connectionId, mailbox } = await connectShared(
    adminPerson,
    `files-${unique()}`
  );
  const mailKey = await mailContract(admin, connectionId);
  const filesKey = `files-${unique()}`;
  await publishCatalogContract(env, admin, { key: filesKey, kind: "files" });
  const workflow = await createWorkflowResource(
    env,
    builder,
    `files-${unique()}`
  );
  await publishDefinition(
    env,
    builder,
    workflow.id,
    definitionOf(mailKey, filesKey)
  );
  const permissionId = await granted(builder, admin, {
    subject: { type: "workflow", workflowId: workflow.id },
    object: { type: "connection", connectionId },
    actions: ["mail.readAttachment", "mail.send"],
    binding: `MAIL_${unique().toUpperCase().replaceAll("-", "_")}`,
  });
  await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "mail",
    target: {
      kind: "connector",
      permissionId,
      contract: "microsoft-365.mail@1",
    },
    reviewed: { version: 1 },
  });
  await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "runFiles",
    target: { kind: "files" },
    reviewed: { version: 1 },
  });
  return { admin, builder, workflow, mailbox, connectionId };
};

/** Runs version 1 of the workflow for `by` on `input`: how it ended. */
const ran = async (
  by: Identity,
  id: string,
  input: {
    mailbox: string;
    message: string;
    attachment: string;
    attach?: string;
  }
) => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    {
      expected: 1,
      args: { attach: "", ...input },
      key: unique(),
    }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  const run: WorkflowResourceRun = await vi.waitFor(
    async () => {
      const read = await resourceRunFor(env, by, id, runId);
      expect(read.endedAt).not.toBeNull();
      return read;
    },
    { timeout: 120_000, interval: 100 }
  );
  return {
    runId,
    end:
      run.status === "completed"
        ? { status: run.status, output: run.result }
        : { status: run.status, code: run.error?.code },
  };
};

const sentSchema = z.array(
  z.object({
    mailbox: z.string(),
    attachments: z.array(
      z.object({ name: z.string(), contentBytes: z.string() })
    ),
  })
);

/** The messages Graph was given for `mailbox`. */
const sentFor = async (mailbox: string) => {
  const response = await providers().fetch(graphSentUrl);
  return sentSchema
    .parse(await response.json())
    .filter((message) => message.mailbox === mailbox);
};

/** The receipts of run `runId`'s connector calls, as the audit log keeps them. */
const connectorReceiptsOf = async (runId: string) => {
  const events = await allEvents();
  return events
    .filter(
      (event) =>
        event.action === "workflow.run.called" &&
        event.target?.id === runId &&
        event.detail?.call === "grasp.connector"
    )
    .map(({ detail }) => detail ?? {});
};

describe("a workflow's connection calls keeping and attaching run files", () => {
  it("keep an attachment as the run's own file, read it back whole, and mail exactly a file the run wrote, the receipts carrying digests and never names", async () => {
    const { builder, workflow, mailbox } = await filingWorkflow();
    const csv = new TextEncoder().encode("amount,due\n120,2026-11-01\n");
    await attach(mailbox, "m1", {
      id: "a1",
      name: "invoice.csv",
      contentType: "text/csv; charset=utf-8",
      bytes: csv,
    });
    const { runId, end } = await ran(builder, workflow.id, {
      mailbox,
      message: "m1",
      attachment: "a1",
    });
    const sent = await sentFor(mailbox);
    const receipts = await connectorReceiptsOf(runId);
    expect({
      end,
      sent: sent.map(({ attachments }) =>
        attachments.map(({ name, contentBytes }) => [name, atob(contentBytes)])
      ),
      named: /invoice\.csv|note\.txt/u.exec(JSON.stringify(receipts)),
    }).toStrictEqual({
      end: {
        status: "completed",
        output: {
          name: "invoice.csv",
          type: "text/csv",
          sha256: await sha256HexOfBytes(csv),
          text: "amount,due\n120,2026-11-01\n",
        },
      },
      sent: [[["note.txt", "Read: amount,due\n120,2026-11-01\n"]]],
      named: null,
    });
  });

  it("read a kept file whole only as text: a PDF is not read", async () => {
    const { builder, workflow, mailbox } = await filingWorkflow();
    await attach(mailbox, "m2", {
      id: "pdf",
      name: "scan.pdf",
      contentType: "application/pdf",
      bytes: new TextEncoder().encode("%PDF-1.7\n%…\n"),
    });
    const { end } = await ran(builder, workflow.id, {
      mailbox,
      message: "m2",
      attachment: "pdf",
    });
    expect({ end, sent: await sentFor(mailbox) }).toStrictEqual({
      end: { status: "failed", code: "file.not_readable" },
      sent: [],
    });
  });

  it("attach nothing of another run's: its file is found nowhere and nothing is sent", async () => {
    const { builder, workflow, mailbox } = await filingWorkflow();
    await attach(mailbox, "m3", {
      id: "a1",
      name: "invoice.csv",
      contentType: "text/csv",
      bytes: new TextEncoder().encode("a,b\n1,2\n"),
    });
    const first = await ran(builder, workflow.id, {
      mailbox,
      message: "m3",
      attachment: "a1",
    });
    const theirs = await env.DB.prepare(
      "SELECT id FROM workflow_run_files WHERE run_id = ? AND name = 'note.txt'"
    )
      .bind(first.runId)
      .first<{ id: string }>();
    const { length: before } = await sentFor(mailbox);
    const second = await ran(builder, workflow.id, {
      mailbox,
      message: "m3",
      attachment: "a1",
      attach: theirs?.id ?? "",
    });
    const { length: after } = await sentFor(mailbox);
    expect({
      first: first.end.status,
      second: second.end,
      sent: after - before,
    }).toStrictEqual({
      first: "completed",
      second: { status: "failed", code: "file.not_found" },
      sent: 0,
    });
  });

  it("are refused at publication where the action's contract doesn't answer or take files", async () => {
    const adminPerson = await signedInApi(idp, "admin");
    const builderPerson = await signedInApi(idp, "builder");
    const admin = identityOf(adminPerson.userId, "admin");
    const builder = identityOf(builderPerson.userId, "builder");
    const { id: connectionId } = await connectShared(
      adminPerson,
      `plain-${unique()}`
    );
    const plain = await withoutFiles(await mailContract(admin, connectionId));
    const filesKey = `files-${unique()}`;
    await publishCatalogContract(env, admin, { key: filesKey, kind: "files" });
    const workflow = await createWorkflowResource(
      env,
      builder,
      `plain-${unique()}`
    );
    const refused = await publishDefinition(
      env,
      builder,
      workflow.id,
      definitionOf(plain, filesKey)
    ).then(
      () => [],
      (error: unknown) =>
        z
          .object({
            details: z.object({
              problems: z.array(
                z.object({ code: z.string(), pointer: z.string() })
              ),
            }),
          })
          .parse(error)
          .details.problems.map(({ code, pointer }) => [pointer, code])
    );
    expect(refused).toStrictEqual([
      ["/steps/0/into", "connector.no_file_answer"],
      ["/steps/3/from", "connector.takes_no_files"],
    ]);
  });
});

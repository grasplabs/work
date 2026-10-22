/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { sha256HexOfBytes } from "@grasp-os/shared/encoding";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appFor } from "../src/apps.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { allEvents } from "./audit-events.ts";
import { consentCode, graphAttachmentUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { routed, signedInApi, unique } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// A connector read an action has kept as a file of its run (GRA-886),
// from its threat note: only a read its native connector declares answers
// a file, as the sealed contract records it, and only into a files use
// the action declared to write; the bytes are kept as the run's own file,
// typed by what they are, never by the label they came with, named only as
// a run file may be, and handed on by reference, however much larger than
// a step's record; a type no run file may be is refused and nothing kept;
// the call's receipt carries the file's digest, never its name. Through
// the real connect, with Microsoft Graph as the outside system.

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

/** `bytes` as base64, a piece at a time: too many for one call's arguments. */
const base64Of = (bytes: Uint8Array): string => {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 8192) {
    binary += String.fromCodePoint(...bytes.subarray(at, at + 8192));
  }
  return btoa(binary);
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
  await providers().fetch(graphAttachmentUrl, {
    method: "POST",
    body: JSON.stringify({
      mailbox,
      message,
      id: attachment.id,
      name: attachment.name,
      contentType: attachment.contentType,
      contentBytes: base64Of(attachment.bytes),
    }),
  });
};

/**
 * The workflow's action: `read` reads an attachment, kept as a file in
 * `into` (none: as base64), then reads the file back by its reference,
 * answering its first characters. Its files use declares `operations`.
 */
const readModule = (
  operations = '["write", "read"]'
): string => `import { action, resource, v } from "@grasp-os/sdk/action";

const mail = resource.connector("mail", { operations: ["mail.readAttachment"] });
const files = resource.files("files", { operations: ${operations} });
type Loose = {
  mail: { call: (operation: string, args: object, options?: object) => Promise<Record<string, unknown>> };
  files: { read: (request: object) => Promise<string> };
};

export const read = action({
  args: { mailbox: v.string(), message: v.string(), attachment: v.string(), into: v.string() },
  returns: v.object({ status: v.string() }),
  uses: [mail, files],
  handler: async (ctx, args) => {
    const resources = ctx.resources as unknown as Loose;
    const answer = await resources.mail.call(
      "mail.readAttachment",
      { mailbox: args.mailbox, message: args.message, attachment: args.attachment },
      args.into === "" ? undefined : { into: args.into }
    );
    const file = answer.file as { file: string } | undefined;
    const text = file === undefined ? null : (await resources.files.read({ file: file.file })).slice(0, 64);
    return { status: JSON.stringify({ answer, text }) };
  },
});
`;

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** A definition of `name` that runs `read`, its mail and files bindings `mail` and `files`. */
const definitionOf = (name: string, mail: string, files: string): string =>
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
            read: { kind: "operation", contract: "local:code/read.ts#read" },
            mail: { kind: "connector", contract: mail },
            files: { kind: "files", contract: files },
          },
        },
      },
    },
    input: {
      schema: objectSchema({
        mailbox: { type: "string" },
        message: { type: "string" },
        attachment: { type: "string" },
        into: { type: "string" },
      }),
    },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [
      {
        read: {
          call: "grasp.operation",
          with: {
            binding: "read",
            arguments: {
              mailbox: "${ $workflow.input.mailbox }",
              message: "${ $workflow.input.message }",
              attachment: "${ $workflow.input.attachment }",
              into: "${ $workflow.input.into }",
            },
          },
        },
      },
    ],
  });

/**
 * A workflow of a builder's whose `read` action reads a shared Microsoft
 * 365 account's attachments, its mail and files bindings approved by an
 * admin: the builder, the workflow and the mailbox.
 */
const readingWorkflow = async (module = readModule()) => {
  const adminPerson = await signedInApi(idp, "admin");
  const builderPerson = await signedInApi(idp, "builder");
  const admin = identityOf(adminPerson.userId, "admin");
  const builder = identityOf(builderPerson.userId, "builder");
  const { id: connectionId, mailbox } = await connectShared(
    adminPerson,
    `reads-${unique()}`
  );
  // The catalog contract of exactly the shapes the native connector makes.
  const served = await env.CONNECT.connectorContract({
    contract: "microsoft-365.mail@1",
    connectionId,
  });
  const readAttachment = Object.values(served.actions).find(
    ({ tool }) => tool === "mail.readAttachment"
  );
  if (readAttachment === undefined) {
    throw new Error("Expected mail.readAttachment in the contract");
  }
  const mailKey = `mail-${unique()}`;
  await publishCatalogContract(env, admin, {
    key: mailKey,
    kind: "connector",
    operations: {
      "mail.readAttachment": {
        input: JSON.stringify({
          format: "json",
          document: jsonOf(readAttachment.input),
        }),
        output: JSON.stringify({
          format: "json",
          document: jsonOf(readAttachment.output),
        }),
        readOnly: true,
        answersFile: true,
      },
    },
  });
  const filesKey = `files-${unique()}`;
  await publishCatalogContract(env, admin, { key: filesKey, kind: "files" });
  const workflow = await createWorkflowResource(
    env,
    builder,
    `reads-${unique()}`
  );
  await publishWorkflowVersion(env, builder, workflow.id, {
    definition: definitionOf(workflow.name, mailKey, filesKey),
    basedOn: null,
    modules: { "code/read.ts": module },
  });
  const permissionId = await granted(builder, admin, {
    subject: { type: "workflow", workflowId: workflow.id },
    object: { type: "connection", connectionId },
    actions: ["mail.readAttachment"],
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
    alias: "files",
    target: { kind: "files" },
    reviewed: { version: 1 },
  });
  return { builder, workflow, mailbox };
};

/** Runs version 1 of the workflow for `by` on `input`: how it ended. */
const ran = async (
  by: Identity,
  id: string,
  input: { mailbox: string; message: string; attachment: string; into: string }
) => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    { version: 1, input, key: unique() }
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
    { timeout: 60_000, interval: 100 }
  );
  return {
    runId,
    end:
      run.status === "completed"
        ? { status: run.status, output: run.output }
        : { status: run.status, code: run.error?.code },
  };
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
    .map(({ detail }) => detail);
};

/** What the action answered, from the run's status text. */
const answerOf = (end: { output?: unknown }) => {
  const { status } = z.object({ status: z.string() }).parse(end.output);
  const parsed: unknown = JSON.parse(status);
  return z
    .object({
      answer: z.record(z.string(), z.unknown()),
      text: z.string().nullable(),
    })
    .parse(parsed);
};

const fileRefSchema = z.object({
  file: z.string(),
  name: z.string(),
  type: z.string(),
  size: z.number(),
  sha256: z.string(),
});

describe("a connector read kept as a file of the run", () => {
  it("keeps the bytes as the run's own file, typed by what they are and handed on by reference, its receipt carrying the digest and never the name", async () => {
    const { builder, workflow, mailbox } = await readingWorkflow();
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
      into: "files",
    });
    const { answer, text } = answerOf(end);
    const sha256 = await sha256HexOfBytes(csv);
    const receipts = await connectorReceiptsOf(runId);
    const file = fileRefSchema.parse(answer.file);
    const receipt = receipts.at(-1);
    expect({
      status: end.status,
      file: { ...file, file: file.file.length > 0 },
      content: "content" in answer,
      text,
      receipt: {
        outcome: receipt?.outcome,
        file: receipt?.file === file.file,
        type: receipt?.type,
        size: receipt?.size,
        sha256: receipt?.sha256,
      },
      named: JSON.stringify(receipts).includes("invoice.csv"),
    }).toStrictEqual({
      status: "completed",
      file: {
        file: true,
        name: "invoice.csv",
        type: "text/csv",
        size: csv.length,
        sha256,
      },
      content: false,
      text: "amount,due\n120,2026-11-01\n",
      receipt: {
        outcome: "done",
        file: true,
        type: "text/csv",
        size: csv.length,
        sha256,
      },
      named: false,
    });
  });

  it("keeps a file larger than a step records, which never passes through the step", async () => {
    const { builder, workflow, mailbox } = await readingWorkflow();
    // Past a step's record as base64; within the connector's 4 MiB read.
    const pdf = new Uint8Array(1536 * 1024).fill(0x41);
    pdf.set(new TextEncoder().encode("%PDF-1.7\n"), 0);
    await attach(mailbox, "big", {
      id: "pdf",
      name: "scan.pdf",
      contentType: "application/pdf",
      bytes: pdf,
    });
    const { end } = await ran(builder, workflow.id, {
      mailbox,
      message: "big",
      attachment: "pdf",
      into: "files",
    });
    const file = fileRefSchema.parse(answerOf(end).answer.file);
    expect({
      status: end.status,
      type: file.type,
      size: file.size,
      sha256: file.sha256,
    }).toStrictEqual({
      status: "completed",
      type: "application/pdf",
      size: pdf.length,
      sha256: await sha256HexOfBytes(pdf),
    });
  });

  it("takes a binary type by its signature whatever the label says, and refuses bytes no run file may be, keeping nothing", async () => {
    const { builder, workflow, mailbox } = await readingWorkflow();
    const pdf = new TextEncoder().encode("%PDF-1.7\n%…\n");
    await attach(mailbox, "m2", {
      id: "pdf",
      name: "../../etc/scan.pdf",
      contentType: "text/plain",
      bytes: pdf,
    });
    // A ZIP labelled as a Word document: its package declares nothing.
    await attach(mailbox, "m2", {
      id: "zip",
      name: "letter.docx",
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]),
    });
    const kept = await ran(builder, workflow.id, {
      mailbox,
      message: "m2",
      attachment: "pdf",
      into: "files",
    });
    const refused = await ran(builder, workflow.id, {
      mailbox,
      message: "m2",
      attachment: "zip",
      into: "files",
    });
    const rows = await env.DB.prepare(
      "SELECT count(*) AS n FROM workflow_run_files WHERE run_id = ?"
    )
      .bind(refused.runId)
      .first<{ n: number }>();
    const file = z
      .object({ name: z.string(), type: z.string() })
      .parse(answerOf(kept.end).answer.file);
    expect({
      kept: { type: file.type, name: file.name },
      refused: refused.end,
      rows: rows?.n,
    }).toStrictEqual({
      // A name a run file can't have is replaced, never cleaned up.
      kept: { type: "application/pdf", name: "attachment" },
      refused: { status: "failed", code: "file.run_type_unsupported" },
      rows: 0,
    });
  });

  it("answers as base64 when not asked for a file, and goes only into a files use the action declared to write", async () => {
    const reading = await readingWorkflow();
    const readOnly = await readingWorkflow(readModule('["read"]'));
    const bytes = new TextEncoder().encode("hello");
    for (const { mailbox } of [reading, readOnly]) {
      // oxlint-disable-next-line no-await-in-loop -- one mailbox after another
      await attach(mailbox, "m3", {
        id: "t",
        name: "hello.txt",
        contentType: "text/plain",
        bytes,
      });
    }
    const asBase64 = await ran(reading.builder, reading.workflow.id, {
      mailbox: reading.mailbox,
      message: "m3",
      attachment: "t",
      into: "",
    });
    const intoUndeclared = await ran(reading.builder, reading.workflow.id, {
      mailbox: reading.mailbox,
      message: "m3",
      attachment: "t",
      into: "elsewhere",
    });
    const intoReadOnly = await ran(readOnly.builder, readOnly.workflow.id, {
      mailbox: readOnly.mailbox,
      message: "m3",
      attachment: "t",
      into: "files",
    });
    const { answer } = answerOf(asBase64.end);
    expect({
      base64: {
        content: answer.content,
        encoding: answer.encoding,
        file: answer.file,
      },
      intoUndeclared: intoUndeclared.end,
      intoReadOnly: intoReadOnly.end,
    }).toStrictEqual({
      base64: { content: btoa("hello"), encoding: "base64", file: undefined },
      intoUndeclared: { status: "failed", code: "workflow.call_denied" },
      intoReadOnly: { status: "failed", code: "workflow.call_denied" },
    });
  });
});

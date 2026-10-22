/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { connectErrors } from "@grasp-os/shared/connect";
import type { AttachmentEntry } from "@grasp-os/shared/connector-attachments";
import { sha256HexOfBytes, toBase64 } from "@grasp-os/shared/encoding";
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
import { attachedAgain } from "../src/workflows/run-files.ts";
import { allEvents } from "./audit-events.ts";
import { consentCode, graphSentUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { routed, signedInApi, unique } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// A workflow's connector write that attaches files of its run (GRA-887),
// from its threat note. The ways it can fail come first: a file of another
// run, a file that isn't there, more files than a write may attach or
// larger ones, a file named twice, files with no files use declared to
// read from (or one declared only to write), and bytes sent that aren't the
// run's own. Then that the write reaches Microsoft Graph with exactly the
// run's files, and that its receipts carry each file's ID, type, size and
// digest, never its name or content. Through the real connect, with
// Microsoft Graph as the outside system.

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

/**
 * The workflow's action: writes `count` text files of `size` bytes (or
 * attaches `reuse`, a file ID), and sends them in a message, from the
 * files use `from` names (none: names no use). Its files use declares
 * `operations`.
 */
const sendModule = (
  operations = '["write", "read"]'
): string => `import { action, resource, v } from "@grasp-os/sdk/action";

const mail = resource.connector("mail", { operations: ["mail.send"] });
const files = resource.files("files", { operations: ${operations} });
type Loose = {
  mail: { call: (operation: string, args: object, options?: object) => Promise<unknown> };
  files: { write: (request: object) => Promise<{ file: string }> };
};

export const send = action({
  args: {
    mailbox: v.string(),
    from: v.string(),
    count: v.number(),
    size: v.number(),
    reuse: v.string(),
    twice: v.string(),
  },
  returns: v.object({ status: v.string() }),
  uses: [mail, files],
  handler: async (ctx, args) => {
    const resources = ctx.resources as unknown as Loose;
    const refs: { file: string }[] = [];
    if (args.reuse !== "") {
      refs.push({ file: args.reuse });
    } else {
      for (let at = 0; at < args.count; at += 1) {
        const written = await resources.files.write({
          name: "f" + String(at) + ".txt",
          type: "text/plain",
          content: String(at) + ":" + "x".repeat(args.size),
        });
        refs.push({ file: written.file });
      }
    }
    if (args.twice !== "" && refs[0] !== undefined) {
      refs.push(refs[0]);
    }
    await resources.mail.call(
      "mail.send",
      {
        mailbox: args.mailbox,
        subject: "Invoice",
        body: "Attached.",
        to: ["billing@northwind.example.org"],
        attachments: refs,
      },
      args.from === "" ? undefined : { from: args.from }
    );
    return { status: JSON.stringify({ refs }) };
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

/** A definition of `name` that runs `send`, its mail and files bindings `mail` and `files`. */
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
            send: { kind: "operation", contract: "local:code/send.ts#send" },
            mail: { kind: "connector", contract: mail },
            files: { kind: "files", contract: files },
          },
        },
      },
    },
    input: {
      schema: objectSchema({
        mailbox: { type: "string" },
        from: { type: "string" },
        count: { type: "number" },
        size: { type: "number" },
        reuse: { type: "string" },
        twice: { type: "string" },
      }),
    },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [
      {
        send: {
          call: "grasp.operation",
          with: {
            binding: "send",
            arguments: {
              mailbox: "${ $workflow.input.mailbox }",
              from: "${ $workflow.input.from }",
              count: "${ $workflow.input.count }",
              size: "${ $workflow.input.size }",
              reuse: "${ $workflow.input.reuse }",
              twice: "${ $workflow.input.twice }",
            },
          },
        },
      },
    ],
  });

/**
 * A workflow of a builder's whose `send` action mails from a shared
 * Microsoft 365 account, its mail and files bindings approved by an admin.
 */
const sendingWorkflow = async (module = sendModule()) => {
  const adminPerson = await signedInApi(idp, "admin");
  const builderPerson = await signedInApi(idp, "builder");
  const admin = identityOf(adminPerson.userId, "admin");
  const builder = identityOf(builderPerson.userId, "builder");
  const { id: connectionId, mailbox } = await connectShared(
    adminPerson,
    `attach-${unique()}`
  );
  const served = await env.CONNECT.connectorContract({
    contract: "microsoft-365.mail@1",
    connectionId,
  });
  const send = Object.values(served.actions).find(
    ({ tool }) => tool === "mail.send"
  );
  if (send === undefined) {
    throw new Error("Expected mail.send in the contract");
  }
  const mailKey = `mail-${unique()}`;
  await publishCatalogContract(env, admin, {
    key: mailKey,
    kind: "connector",
    operations: {
      "mail.send": {
        input: JSON.stringify({ format: "json", document: jsonOf(send.input) }),
        output: JSON.stringify({
          format: "json",
          document: jsonOf(send.output),
        }),
        takesFiles: true,
      },
    },
  });
  const filesKey = `files-${unique()}`;
  await publishCatalogContract(env, admin, { key: filesKey, kind: "files" });
  const workflow = await createWorkflowResource(
    env,
    builder,
    `attach-${unique()}`
  );
  await publishWorkflowVersion(env, builder, workflow.id, {
    definition: definitionOf(workflow.name, mailKey, filesKey),
    basedOn: null,
    modules: { "code/send.ts": module },
  });
  const permissionId = await granted(builder, admin, {
    subject: { type: "workflow", workflowId: workflow.id },
    object: { type: "connection", connectionId },
    actions: ["mail.send"],
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

interface SendInput {
  mailbox: string;
  from?: string;
  count?: number;
  size?: number;
  reuse?: string;
  twice?: string;
}

/** Runs version 1 of the workflow for `by` on `input`: how it ended. */
const ran = async (by: Identity, id: string, input: SendInput) => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    {
      version: 1,
      input: {
        from: "files",
        count: 1,
        size: 8,
        reuse: "",
        twice: "",
        ...input,
      },
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
        ? { status: run.status, output: run.output }
        : { status: run.status, code: run.error?.code },
  };
};

const sentSchema = z.array(
  z.object({
    mailbox: z.string(),
    subject: z.string(),
    attachments: z.array(
      z.object({
        name: z.string(),
        contentType: z.string(),
        contentBytes: z.string(),
      })
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

/** The files an action's end answers it attached, by ID. */
const refsOf = (end: { output?: unknown }): string[] => {
  const { status } = z.object({ status: z.string() }).parse(end.output);
  return z
    .object({ refs: z.array(z.object({ file: z.string() })) })
    .parse(JSON.parse(status))
    .refs.map(({ file }) => file);
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

/** What reading `shown` again from run `run` gives: its text, or why not. */
const again = async (run: string, shown: AttachmentEntry): Promise<string> => {
  try {
    const read = await attachedAgain(env, run, [shown]);
    return new TextDecoder().decode(read[shown.sha256]);
  } catch (error) {
    return connectErrors.codeOf(error) ?? String(error);
  }
};

const kib = 1024;
const mib = 1024 * kib;

describe("a connector write that attaches files of its run", () => {
  it("is refused, sending nothing, for files that aren't the run's, aren't there, break a limit or have no files use to come from", async () => {
    const { builder, workflow, mailbox } = await sendingWorkflow();
    const writeOnly = await sendingWorkflow(sendModule('["write"]'));
    // A file of another run: its ID is no use outside its own run.
    const other = await ran(builder, workflow.id, { mailbox });
    const [otherFile = ""] = refsOf(other.end);
    const attempt = async (input: Partial<SendInput>) => {
      const { end } = await ran(builder, workflow.id, { mailbox, ...input });
      return end;
    };
    const writeOnlyRun = await ran(writeOnly.builder, writeOnly.workflow.id, {
      mailbox: writeOnly.mailbox,
    });
    const refused = {
      noUse: await attempt({ from: "" }),
      undeclaredUse: await attempt({ from: "elsewhere" }),
      readNotDeclared: writeOnlyRun.end,
      anotherRunsFile: await attempt({ reuse: otherFile }),
      noSuchFile: await attempt({ reuse: crypto.randomUUID() }),
      twice: await attempt({ twice: "yes" }),
      tooLarge: await attempt({ size: 3 * mib }),
      tooLargeTogether: await attempt({ count: 2, size: 2 * mib }),
    };
    const sentFirst = await sentFor(mailbox);
    const sentWriteOnly = await sentFor(writeOnly.mailbox);
    expect({
      refused,
      // Only the first run's message went out.
      sent: [sentFirst.length, sentWriteOnly.length],
    }).toStrictEqual({
      refused: {
        noUse: { status: "failed", code: "workflow.call_invalid" },
        undeclaredUse: { status: "failed", code: "workflow.call_denied" },
        readNotDeclared: { status: "failed", code: "workflow.call_denied" },
        anotherRunsFile: { status: "failed", code: "file.not_found" },
        noSuchFile: { status: "failed", code: "file.not_found" },
        twice: { status: "failed", code: "file.attach_too_large" },
        tooLarge: { status: "failed", code: "file.attach_too_large" },
        tooLargeTogether: { status: "failed", code: "file.attach_too_large" },
      },
      sent: [1, 0],
    });
  });

  it("sends Graph exactly the run's files, and leaves receipts with each file's ID, type, size and digest, never its name or content", async () => {
    const { builder, workflow, mailbox } = await sendingWorkflow();
    const { runId, end } = await ran(builder, workflow.id, {
      mailbox,
      count: 2,
      size: 40,
    });
    const contents = ["0:", "1:"].map((prefix) => `${prefix}${"x".repeat(40)}`);
    const bytes = contents.map((text) => new TextEncoder().encode(text));
    const digests = await Promise.all(bytes.map(sha256HexOfBytes));
    const files = refsOf(end);
    const receipts = await connectorReceiptsOf(runId);
    const receipt = receipts.at(-1);
    const [message] = await sentFor(mailbox);
    expect({
      status: end.status,
      attached: message?.attachments.map(
        ({ name, contentType, contentBytes }) => ({
          name,
          contentType,
          contentBytes,
        })
      ),
      receipt: [0, 1].map((at) => receipt?.[`attachment${String(at)}`]),
      count: receipt?.attachmentCount,
      // Never a name or a part of the content.
      leaked:
        JSON.stringify(receipts).includes("f0.txt") ||
        JSON.stringify(await allEvents()).includes(
          toBase64(bytes[0] ?? new Uint8Array())
        ),
    }).toStrictEqual({
      status: "completed",
      attached: contents.map((text, at) => ({
        name: `f${String(at)}.txt`,
        contentType: "text/plain",
        contentBytes: btoa(text),
      })),
      receipt: files.map(
        (file, at) =>
          `${file} text/plain ${String(bytes[at]?.length)} ${digests[at]}`
      ),
      count: 2,
      leaked: false,
    });
  });

  it("attaches as many files as a write may, ten, and no more of the run's actions' calls than they take", async () => {
    const { builder, workflow, mailbox } = await sendingWorkflow();
    const { end } = await ran(builder, workflow.id, { mailbox, count: 10 });
    const [message] = await sentFor(mailbox);
    expect({
      status: end.status,
      names: message?.attachments.map(({ name }) => name),
    }).toStrictEqual({
      status: "completed",
      names: Array.from({ length: 10 }, (_, at) => `f${String(at)}.txt`),
    });
  });

  it("reads the files again, for a held write's release, only as the person was shown them, and not once they are gone", async () => {
    const { builder, workflow, mailbox } = await sendingWorkflow();
    const { runId } = await ran(builder, workflow.id, { mailbox, size: 16 });
    const content = `0:${"x".repeat(16)}`;
    const bytes = new TextEncoder().encode(content);
    const entry: AttachmentEntry = {
      name: "f0.txt",
      type: "text/plain",
      size: bytes.length,
      sha256: await sha256HexOfBytes(bytes),
    };
    const results = {
      asShown: await again(runId, entry),
      renamed: await again(runId, { ...entry, name: "other.txt" }),
      retyped: await again(runId, { ...entry, type: "application/json" }),
      anotherRun: await again(crypto.randomUUID(), entry),
    };
    await env.DB.prepare(
      "UPDATE workflow_run_files SET state = 'deleted', deleted_at = ?1 WHERE run_id = ?2"
    )
      .bind(Date.now(), runId)
      .run();
    expect({
      ...results,
      afterRetention: await again(runId, entry),
    }).toStrictEqual({
      asShown: content,
      renamed: "connect.files_changed",
      retyped: "connect.files_changed",
      anotherRun: "connect.files_changed",
      afterRetention: "connect.files_changed",
    });
  });
});

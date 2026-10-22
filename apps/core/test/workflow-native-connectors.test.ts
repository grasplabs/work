/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  workflowNamespace,
  workflowResourceErrors,
} from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowCandidateRun,
  WorkflowResourceRun,
} from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appFor } from "../src/apps.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { editWorkflowDraft, workflowDraft } from "../src/workflow-drafts.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import {
  candidateRunFor,
  startCandidateRun,
} from "../src/workflows/candidate-runs.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { consentCode, graphAttachmentUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { routed, signedInApi, unique } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// A workflow binding a native connector's operation (GRA-982): a host
// catalog contract describes it by the connector's own JSON Schemas, which
// use patterns no SDK descriptor holds. From the threat note on GRA-982,
// the ways it can go wrong first:
// - a schema no native connector makes, its pattern a backtracking one,
//   run by core on a test run's fixture before any approval;
// - a keyword core reads but doesn't enforce;
// - JSON Schemas on a contract that isn't a connector's, or half of one;
// - a native action's schemas under another operation's name.
// Then that a native operation is published, approved, called through the
// real connect against Microsoft Graph, its patterns enforced on what is
// sent, and checked the same way in a test run.

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

/** A file attachment on message `message` of `mailbox`, as Graph answers it. */
const attach = async (
  mailbox: string,
  message: string,
  attachment: { id: string; name: string; text: string }
): Promise<void> => {
  await providers().fetch(graphAttachmentUrl, {
    method: "POST",
    body: JSON.stringify({
      mailbox,
      message,
      id: attachment.id,
      name: attachment.name,
      contentType: "text/plain",
      contentBytes: btoa(attachment.text),
    }),
  });
};

/** A JSON Schema, as the catalog's envelope text for it. */
const enveloped = (document: unknown): string =>
  JSON.stringify({ format: "json", document });

/** JSON text as the value it holds. */
const jsonOf = (text: string): unknown => {
  const value: unknown = JSON.parse(text);
  return value;
};

/** `microsoft-365.mail@1`'s action `tool`, as connect serves it to `connectionId`. */
const servedAction = async (connectionId: string, tool: string) => {
  const served = await env.CONNECT.connectorContract({
    contract: "microsoft-365.mail@1",
    connectionId,
  });
  const action = Object.values(served.actions).find(
    (each) => each.tool === tool
  );
  if (action === undefined) {
    throw new Error(`Expected ${tool} in the contract`);
  }
  return { input: jsonOf(action.input), output: jsonOf(action.output) };
};

/** `schema` with every `pattern` in it replaced by `pattern`. */
const withPattern = (schema: unknown, pattern: string): unknown =>
  JSON.parse(
    JSON.stringify(schema, (key, value: unknown) =>
      key === "pattern" ? pattern : value
    )
  );

/** The code a publish was refused with, and its issues. */
const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return workflowResourceErrors.codeOf(error) ?? String(error);
  }
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

/** A definition of `name` reading an attachment through binding `mail`. */
const definitionOf = (name: string, mail: string): string =>
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
          bindings: { mail: { kind: "connector", contract: mail } },
        },
      },
    },
    input: {
      schema: objectSchema({
        mailbox: { type: "string" },
        message: { type: "string" },
        attachment: { type: "string" },
      }),
    },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [
      {
        read: {
          call: "grasp.connector",
          with: {
            binding: "mail",
            operation: "mail.readAttachment",
            arguments: {
              mailbox: "${ $workflow.input.mailbox }",
              message: "${ $workflow.input.message }",
              attachment: "${ $workflow.input.attachment }",
              as: "text",
            },
          },
          output: { as: "${ { status: .content } }" },
        },
      },
    ],
  });

/**
 * An admin, a builder, a shared Microsoft 365 mailbox, and a catalog
 * contract of exactly `mail.readAttachment`'s schemas, as connect makes them.
 */
const nativeContract = async () => {
  const adminPerson = await signedInApi(idp, "admin");
  const builderPerson = await signedInApi(idp, "builder");
  const admin = identityOf(adminPerson.userId, "admin");
  const builder = identityOf(builderPerson.userId, "builder");
  const { id: connectionId, mailbox } = await connectShared(
    adminPerson,
    `native-${unique()}`
  );
  const read = await servedAction(connectionId, "mail.readAttachment");
  const key = `mail-${unique()}`;
  await publishCatalogContract(env, admin, {
    key,
    kind: "connector",
    operations: {
      "mail.readAttachment": {
        input: enveloped(read.input),
        output: enveloped(read.output),
        readOnly: true,
      },
    },
  });
  return { admin, builder, connectionId, mailbox, key, read };
};

/** A published workflow reading attachments through `key`, its binding approved. */
const readingWorkflow = async () => {
  const { admin, builder, connectionId, mailbox, key } = await nativeContract();
  const workflow = await createWorkflowResource(
    env,
    builder,
    `native-${unique()}`
  );
  await publishWorkflowVersion(env, builder, workflow.id, {
    definition: definitionOf(workflow.name, key),
    basedOn: null,
    modules: {},
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
  return { builder, workflow, mailbox };
};

/** Runs version 1 of workflow `id` for `by` on `input`: how it ended. */
const ran = async (
  by: Identity,
  id: string,
  input: { mailbox: string; message: string; attachment: string }
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
  return run.status === "completed"
    ? { status: run.status, output: run.output }
    : { status: run.status, code: run.error?.code };
};

describe("a workflow binding a native connector's operation", () => {
  it("publishes a connector's own JSON Schemas only when connect confirms they're exactly a native action's", async () => {
    const { admin, read, connectionId } = await nativeContract();
    const send = await servedAction(connectionId, "mail.send");
    const publish = async (
      operations: Record<
        string,
        { input: string; output: string; readOnly?: boolean }
      >,
      kind: "connector" | "operation" = "connector"
    ) =>
      await refusal(
        publishCatalogContract(env, admin, {
          key: `mail-${unique()}`,
          kind,
          ...(kind === "connector"
            ? { operations }
            : (Object.values(operations)[0] ?? {})),
        })
      );
    const exact = {
      input: enveloped(read.input),
      output: enveloped(read.output),
      readOnly: true,
    };
    const descriptor = JSON.stringify({
      descriptorVersion: 1,
      kind: "object",
      presence: "required",
      nullable: false,
      fields: {},
    });
    expect({
      // Like the connector's, its pattern a catastrophic one.
      backtracking: await publish({
        "mail.readAttachment": {
          ...exact,
          input: enveloped(withPattern(read.input, "^(a+)+$")),
        },
      }),
      // A keyword the check doesn't enforce.
      unenforced: await publish({
        "mail.readAttachment": {
          ...exact,
          input: enveloped({
            ...z.record(z.string(), z.unknown()).parse(read.input),
            multipleOf: 2,
          }),
        },
      }),
      // A native action's schemas under another operation's name.
      otherName: await publish({ "mail.send": exact }),
      // Half of an operation: its output a descriptor.
      half: await publish({
        "mail.readAttachment": { input: exact.input, output: descriptor },
      }),
      // On a contract that isn't a connector's.
      notConnector: await publish({ op: exact }, "operation"),
      // A read published as a write: readOnly is the connector's to say.
      notReadOnly: await publish({
        "mail.readAttachment": { ...exact, readOnly: false },
      }),
      // A write published as a read, which would leave it out of the
      // writes a version's review says a model may steer.
      writeAsRead: await publish({
        "mail.send": {
          input: enveloped(send.input),
          output: enveloped(send.output),
          readOnly: true,
        },
      }),
      write: await publish({
        "mail.send": {
          input: enveloped(send.input),
          output: enveloped(send.output),
        },
      }),
      exact: await publish({ "mail.readAttachment": exact }),
    }).toStrictEqual({
      backtracking: "workflow.contract_invalid",
      unenforced: "workflow.contract_invalid",
      otherName: "workflow.contract_invalid",
      half: "workflow.contract_invalid",
      notConnector: "workflow.contract_invalid",
      notReadOnly: "workflow.contract_invalid",
      writeAsRead: "workflow.contract_invalid",
      write: "ok",
      exact: "ok",
    });
  });

  it("binds and calls it through connect, its patterns enforced on what is sent", async () => {
    const { builder, workflow, mailbox } = await readingWorkflow();
    await attach(mailbox, "m1", {
      id: "a1",
      name: "notes.txt",
      text: "due 2026-11-01",
    });
    const read = await ran(builder, workflow.id, {
      mailbox,
      message: "m1",
      attachment: "a1",
    });
    // An attachment ID its pattern refuses: refused before it is sent.
    const unpatterned = await ran(builder, workflow.id, {
      mailbox,
      message: "m1",
      attachment: "a1/../../m2",
    });
    expect({ read, unpatterned }).toStrictEqual({
      read: { status: "completed", output: { status: "due 2026-11-01" } },
      unpatterned: { status: "failed", code: "workflow.call_invalid" },
    });
  });

  it("checks a test run's call and fixture against its schemas, patterns included", async () => {
    const { builder, key, mailbox, read } = await nativeContract();
    const workflow = await createWorkflowResource(
      env,
      builder,
      `native-${unique()}`
    );
    const { revision: base } = await workflowDraft(env, builder, workflow.id);
    const saved = await editWorkflowDraft(env, builder, workflow.id, {
      expectedRevision: base,
      source: definitionOf(workflow.name, key),
      modules: {},
    });
    expect(saved.problems).toStrictEqual([]);
    const answer = {
      mailbox,
      messageId: "m1",
      id: "a1",
      name: "notes.txt",
      contentType: "text/plain",
      size: 4,
      encoding: "text",
      content: "note",
    };
    const tested = async (attachment: string, output: unknown) => {
      const { runId } = await startCandidateRun(env, builder, workflow.id, {
        revision: saved.revision,
        input: { mailbox, message: "m1", attachment },
        fixtures: { mail: { output } },
      });
      const run: WorkflowCandidateRun = await vi.waitFor(
        async () => {
          const found = await candidateRunFor(env, builder, workflow.id, runId);
          if (found.status === "starting" || found.status === "running") {
            throw new Error(`Test run ${runId} is ${found.status}`);
          }
          return found;
        },
        { timeout: 20_000, interval: 100 }
      );
      return run.status === "completed"
        ? { status: run.status, output: run.output }
        : { status: run.status, code: run.error?.code };
    };
    expect(JSON.stringify(read.input)).toContain('"pattern"');
    expect({
      answered: await tested("a1", answer),
      unpatterned: await tested("a1/..", answer),
      misshapen: await tested("a1", { ...answer, size: "4" }),
    }).toStrictEqual({
      answered: { status: "completed", output: { status: "note" } },
      unpatterned: { status: "failed", code: "workflow.call_invalid" },
      misshapen: { status: "failed", code: "workflow.call_invalid" },
    });
  });
});

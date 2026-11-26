import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowCandidateRun,
  WorkflowResourceRun,
} from "@grasp-os/shared/workflow-resources";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appFor } from "../src/apps.ts";
import { personOf } from "../src/connections.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { editWorkflowDraft, workflowDraft } from "../src/workflow-editor.ts";
import { createWorkflowResource } from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import {
  candidateRunFor,
  startCandidateRun,
} from "../src/workflows/candidate-runs.ts";
import { waitStepPrefix } from "../src/workflows/host.ts";
import { resourceRunTrace } from "../src/workflows/resource-run-trace.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import {
  consentCode,
  graphAttachmentUrl,
  graphThrottleUrl,
} from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { objectSchema } from "./json-workflow-apps.ts";
import { mailConnection } from "./mail-connection.ts";
import { configuredLimits, withQuotas } from "./quota-limits.ts";
import { resumed, sleeping, stopped } from "./runs.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { routed, signedInApi, unique } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";
import { publishDefinition } from "./workflow-publishing.ts";

// A workflow binding a native connector's operation (GRA-982): a host
// catalog contract describes it by the connector's own JSON Schemas, which
// may use patterns and formats no SDK descriptor holds. From the threat
// note on GRA-982, the ways it can go wrong first:
// - a schema no native connector makes (a vendor's MCP server's), its
//   pattern a backtracking one, run by core on a test run's fixture before
//   any approval;
// - a keyword core reads but doesn't enforce;
// - JSON Schemas on a contract that isn't a connector's, or half of one;
// - a native action's schemas under another operation's name.
// Then that a native operation is published, approved, called through the
// real connect against Microsoft Graph, a path argument that isn't one
// segment refused before it is sent, and checked the same way in a test
// run, for a connector written with `v` too (a path argument held to
// `v.string().segment()`, served as `format: "segment"`).

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

/**
 * Has Graph answer `mailbox`'s next `requests` requests 429, asking to
 * wait `retryAfter` seconds: connect pauses the connection that long.
 */
const throttle = async (
  mailbox: string,
  retryAfter: number,
  requests = 1
): Promise<void> => {
  await providers().fetch(graphThrottleUrl, {
    method: "POST",
    body: JSON.stringify({ mailbox, requests, retryAfter }),
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

/** `contract`'s action `tool`, as connect serves it to `connectionId`. */
const servedAction = async (
  connectionId: string,
  tool: string,
  contract = "microsoft-365.mail@1"
) => {
  const served = await env.CONNECT.connectorContract({
    contract,
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

/** The code a publish was refused with, and its issues. */
const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return workflowResourceErrors.codeOf(error) ?? String(error);
  }
};

/** The step reading an attachment through binding `mail`. */
const readStep = {
  id: "read",
  type: "call",
  connection: "mail",
  action: "mail.readAttachment",
  args: {
    mailbox: { $expr: "args.mailbox" },
    message: { $expr: "args.message" },
    attachment: { $expr: "args.attachment" },
    as: "text",
  },
};

/**
 * A definition reading an attachment through binding `mail`; `guarded`,
 * in a try whose catch retries the read once, a second on, and then takes
 * its failure.
 */
const definitionOf = (mail: string, guarded = false): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({
      mailbox: { kind: "string" },
      message: { kind: "string" },
      attachment: { kind: "string" },
    }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: { status: guarded ? "caught" : { $expr: "read.content" } },
    permissions: { connections: { mail: { contract: mail } } },
    steps: guarded
      ? [
          {
            id: "guarded",
            type: "try",
            try: [readStep],
            catch: {
              retry: { attempts: 2, delay: "1 second", backoff: "constant" },
              do: [{ id: "tell", type: "wait", until: { $expr: "0" } }],
            },
          },
        ]
      : [readStep],
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
        answersFile: true,
      },
    },
  });
  return { admin, builder, connectionId, mailbox, key, read };
};

/**
 * A published workflow reading attachments through `key`, its binding
 * approved; `guarded` as `definitionOf` says.
 */
const readingWorkflow = async (guarded = false) => {
  const { admin, builder, connectionId, mailbox, key } = await nativeContract();
  const workflow = await createWorkflowResource(
    env,
    builder,
    `native-${unique()}`
  );
  await publishDefinition(
    env,
    builder,
    workflow.id,
    definitionOf(key, guarded)
  );
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

/**
 * Runs version 1 of workflow `id` for `by` on `input`, doing
 * `meanwhile` to the run as it goes: how it ended.
 */
const ran = async (
  by: Identity,
  id: string,
  input: { mailbox: string; message: string; attachment: string },
  meanwhile?: (runId: string) => Promise<void> | void
) => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: by },
    id,
    { expected: 1, args: input, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  await meanwhile?.(runId);
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

/**
 * A test run of workflow `id`'s draft `source`, by `by`, on `args` with
 * its `fixtures`: how it ended.
 */
const testRunOf = async (by: Identity, id: string, source: string) => {
  const { revision: base } = await workflowDraft(env, by, id);
  const saved = await editWorkflowDraft(env, by, id, {
    revision: base,
    source,
  });
  expect(saved.problems).toStrictEqual([]);
  return async (
    args: Record<string, string>,
    fixtures: Record<string, { result: unknown }>
  ) => {
    const { runId } = await startCandidateRun(env, by, id, {
      revision: saved.revision,
      args,
      fixtures,
    });
    const run: WorkflowCandidateRun = await vi.waitFor(
      async () => {
        const found = await candidateRunFor(env, by, id, runId);
        if (found.status === "starting" || found.status === "running") {
          throw new Error(`Test run ${runId} is ${found.status}`);
        }
        return found;
      },
      { timeout: 20_000, interval: 100 }
    );
    return run.status === "completed"
      ? { status: run.status, output: run.result }
      : { status: run.status, code: run.error?.code };
  };
};

/** A definition listing a board's items through binding `boards`. */
const boardsDefinitionOf = (boards: string): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ board: { kind: "string" } }),
    returns: objectSchema({ next: { kind: "string" } }),
    result: { next: { $expr: "list.next" } },
    permissions: { connections: { boards: { contract: boards } } },
    steps: [
      {
        id: "list",
        type: "call",
        connection: "boards",
        action: "boards.items.list",
        args: { board: { $expr: "args.board" } },
      },
    ],
  });

describe("a workflow binding a native connector's operation", () => {
  it("publishes a connector's own JSON Schemas only when connect confirms they're exactly a native action's", async () => {
    const { admin, read, connectionId } = await nativeContract();
    const send = await servedAction(connectionId, "mail.send");
    // A vendor's MCP server lists a reviewed read whose schema carries a
    // catastrophic pattern. Connect serves no vendor schema with a pattern,
    // so the read isn't served; the schema can only reach core published
    // as it was listed.
    const listed = {
      type: "object",
      properties: { attachment: { type: "string", pattern: "^(a+)+$" } },
      required: ["attachment"],
    };
    const vendor = await mailConnection(
      [],
      [{ name: "mail.read", read: true }]
    );
    await vendor.serves([{ name: "mail.read", inputSchema: listed }]);
    await expect(
      servedAction(vendor.id, "mail.read", "composio.mail@1")
    ).rejects.toThrow("doesn't serve that contract");
    const publish = async (
      operations: Record<
        string,
        {
          input: string;
          output: string;
          readOnly?: boolean;
          answersFile?: true;
          takesFiles?: true;
        }
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
      answersFile: true as const,
    };
    const descriptor = JSON.stringify({
      descriptorVersion: 1,
      kind: "object",
      presence: "required",
      nullable: false,
      fields: {},
    });
    expect({
      // The vendor's schema as it listed it, its pattern a catastrophic one.
      backtracking: await publish({
        "mail.read": {
          input: enveloped(listed),
          output: enveloped({ type: "string" }),
          readOnly: true,
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
          takesFiles: true,
        },
      }),
      // A write that attaches files says so, as its connector declares it
      // (GRA-887), and no other does.
      write: await publish({
        "mail.send": {
          input: enveloped(send.input),
          output: enveloped(send.output),
          takesFiles: true,
        },
      }),
      writeFilesUndeclared: await publish({
        "mail.send": {
          input: enveloped(send.input),
          output: enveloped(send.output),
        },
      }),
      readTakesFiles: await publish({
        "mail.readAttachment": { ...exact, takesFiles: true },
      }),
      descriptorTakesFiles: await publish({
        "mail.send": {
          input: descriptor,
          output: descriptor,
          takesFiles: true,
        },
      }),
      // A file answer is the connector's to declare, both ways (GRA-886).
      fileUndeclared: await publish({
        "mail.readAttachment": { ...exact, answersFile: undefined },
      }),
      writeAnswersFile: await publish({
        "mail.send": {
          input: enveloped(send.input),
          output: enveloped(send.output),
          answersFile: true,
          takesFiles: true,
        },
      }),
      descriptorAnswersFile: await publish({
        "mail.readAttachment": {
          input: descriptor,
          output: descriptor,
          answersFile: true,
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
      writeFilesUndeclared: "workflow.contract_invalid",
      readTakesFiles: "workflow.contract_invalid",
      descriptorTakesFiles: "workflow.contract_invalid",
      fileUndeclared: "workflow.contract_invalid",
      writeAnswersFile: "workflow.contract_invalid",
      descriptorAnswersFile: "workflow.contract_invalid",
      exact: "ok",
    });
  });

  it("binds and calls it through connect, refusing a path argument that isn't one segment before it is sent", async () => {
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
    // An attachment ID that climbs out of its segment: core's check of
    // the call against the served schema refuses it before it is sent.
    const traversing = await ran(builder, workflow.id, {
      mailbox,
      message: "m1",
      attachment: "a1/../../m2",
    });
    expect({ read, traversing }).toStrictEqual({
      read: { status: "completed", output: { status: "due 2026-11-01" } },
      traversing: { status: "failed", code: "workflow.call_invalid" },
    });
  });

  it("waits out the pause its connection's vendor asked for, past its step's retries, then calls", async () => {
    const { builder, workflow, mailbox } = await readingWorkflow();
    await attach(mailbox, "m1", {
      id: "a1",
      name: "notes.txt",
      text: "due 2026-11-01",
    });
    const input = { mailbox, message: "m1", attachment: "a1" };
    // A run before it gets Graph's 429, which pauses the connection longer
    // than a sealed step's retries take in all (a second, then two).
    await throttle(mailbox, 6);
    const paused = Promise.withResolvers<null>();
    const tripping = ran(builder, workflow.id, input, async (runId) => {
      await sleeping(runId, waitStepPrefix);
      paused.resolve(null);
    });
    await paused.promise;
    // So connect refuses this run's first attempt itself, the connection
    // paused (`connect.rate_limited`): Graph has no 429 left to give.
    let run = "";
    const read = await ran(builder, workflow.id, input, async (runId) => {
      run = runId;
      // Stopped and resumed as it waits: a new activation replays the
      // wait, and waits on.
      await sleeping(runId, waitStepPrefix);
      await stopped(runId);
      await resumed(runId);
    });
    const { tasks } = await resourceRunTrace(env, builder, workflow.id, run);
    const done = {
      status: "completed",
      output: { status: "due 2026-11-01" },
    };
    expect({ tripping: await tripping, read, tasks }).toStrictEqual({
      tripping: done,
      read: done,
      // The attempt connect refused, then the one after the wait.
      tasks: [{ task: "read", state: "reached", attempts: 2 }],
    });
  });

  it("retries a pause longer than a step may wait as any failure, and fails with it", async () => {
    const { builder, workflow, mailbox } = await readingWorkflow();
    await throttle(mailbox, 6);
    let run = "";
    const read = await withQuotas(
      { ...configuredLimits, workflowQueuedStepMs: 1000 },
      async () =>
        await ran(
          builder,
          workflow.id,
          { mailbox, message: "m1", attachment: "a1" },
          (runId) => {
            run = runId;
          }
        )
    );
    const { tasks } = await resourceRunTrace(env, builder, workflow.id, run);
    expect({ read, tasks }).toStrictEqual({
      read: { status: "failed", code: "connect.rate_limited" },
      // Its first attempt and the engine's two retries, none waiting.
      tasks: [{ task: "read", state: "failed", attempts: 3 }],
    });
  });

  it("gives a catch's retry of a step no more time to wait out pauses than the step had left", async () => {
    const { builder, workflow, mailbox } = await readingWorkflow(true);
    // Every request Graph gets is turned away, a pause of 3 seconds each.
    await throttle(mailbox, 3, 1000);
    let run = "";
    const read = await withQuotas(
      { ...configuredLimits, workflowQueuedStepMs: 5000 },
      async () =>
        await ran(
          builder,
          workflow.id,
          { mailbox, message: "m1", attachment: "a1" },
          (runId) => {
            run = runId;
          }
        )
    );
    const { tasks } = await resourceRunTrace(env, builder, workflow.id, run);
    expect({
      read,
      attempts: tasks.find(({ task }) => task === "read")?.attempts,
    }).toStrictEqual({
      read: { status: "completed", output: { status: "caught" } },
      // Its first round: the attempt turned away, a sleep of the 5 seconds
      // a step may wait, then the engine's three tries. Its retry: three
      // tries more, none sleeping, as the step has no time left to wait.
      attempts: 7,
    });
  });

  it("checks a test run's call and fixture against its schemas, patterns included", async () => {
    const { builder, key, mailbox, read } = await nativeContract();
    const workflow = await createWorkflowResource(
      env,
      builder,
      `native-${unique()}`
    );
    const testRun = await testRunOf(builder, workflow.id, definitionOf(key));
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
    const tested = async (attachment: string, output: unknown) =>
      await testRun(
        { mailbox, message: "m1", attachment },
        { mail: { result: output } }
      );
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

  it("checks a test run's path argument as one segment, for a connector written with v", async () => {
    const adminPerson = await signedInApi(idp, "admin");
    const builderPerson = await signedInApi(idp, "builder");
    const admin = identityOf(adminPerson.userId, "admin");
    const builder = identityOf(builderPerson.userId, "builder");
    const apiKey = `key-${unique()}`;
    const { connectionId } = await env.CONNECT.connectWithKey({
      person: await personOf(env, await adminPerson.api.whoami()),
      provider: "sample-key",
      scope: "shared",
      key: apiKey,
    });
    const list = await servedAction(
      connectionId,
      "boards.items.list",
      "sample-key.boards.items@1"
    );
    expect(JSON.stringify(list.input)).toContain('"format":"segment"');
    expect(JSON.stringify(list.input)).not.toContain('"pattern"');
    const key = `boards-${unique()}`;
    await publishCatalogContract(env, admin, {
      key,
      kind: "connector",
      operations: {
        "boards.items.list": {
          input: enveloped(list.input),
          output: enveloped(list.output),
          readOnly: true,
        },
      },
    });
    const workflow = await createWorkflowResource(
      env,
      builder,
      `native-${unique()}`
    );
    const testRun = await testRunOf(
      builder,
      workflow.id,
      boardsDefinitionOf(key)
    );
    const page = { boards: { result: { items: [], next: "c2" } } };
    expect({
      listed: await testRun({ board: "b1" }, page),
      traversing: await testRun({ board: "b1/.." }, page),
      batch: await testRun({ board: "$batch" }, page),
    }).toStrictEqual({
      listed: { status: "completed", output: { next: "c2" } },
      traversing: { status: "failed", code: "workflow.call_invalid" },
      batch: { status: "failed", code: "workflow.call_invalid" },
    });
  });
});

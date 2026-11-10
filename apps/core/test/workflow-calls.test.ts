import { maxAttemptTimeoutMs } from "@grasp-os/shared/workflows";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { personOf } from "../src/connections.ts";
import { revokePermission } from "../src/permissions.ts";
import { resolveUnknownOutcome } from "../src/unknown-outcomes.ts";
import {
  approveWorkflowBinding,
  revokeWorkflowBinding,
} from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  shareWorkflowResource,
  unshareWorkflowResource,
} from "../src/workflow-resources.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { mailControlUrl } from "./mail-server.ts";
import { outcome as resultOf, unique } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";
import {
  allowedModel,
  callEventsOf,
  chooseModel,
  ended,
  endOf,
  greetStep,
  hold,
  mailingWorkflow,
  person,
  providerAnswering,
  published,
  receiptsOf,
  started,
} from "./workflow-calls.ts";

// The calls of grasp-workflow/2 workflows on the run host (sealed-run.ts,
// resource-calls.ts and resource-authority.ts), from their threat model:
// a call reaches only the target its start froze; authority revoked while
// a run runs stops its next call; a replay repeats no effect; a sensitive
// parameter reaches connect as a connector argument and nothing the run
// records; and a run's model calls stay within its ceiling. Everything runs for
// real, through the dispatcher, the engine, connect and the App's own
// code; only the mail server and the model provider behind connect are
// faked.

mockIdp();

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/**
 * Makes the mail server of connection `id` answer `mail.send` with
 * `messageId` its `echo`, as a server returning what it was sent does.
 */
const echoingMail = async (id: string, echo: string): Promise<void> => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  const answered = { messageId: echo };
  await providers.fetch(mailControlUrl(id.slice("connection-".length)), {
    method: "POST",
    body: JSON.stringify({
      answers: {
        "mail.send": {
          content: [{ type: "text", text: JSON.stringify(answered) }],
          structuredContent: answered,
        },
      },
    }),
  });
};

describe("connector calls", () => {
  beforeAll(chooseModel);

  it("sends once through connect, its sensitive parameter only as a binding argument, and a replay sends nothing again", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const secret = `secret-${unique()}`;
    const { workflow, executable, mail, serving } = await mailingWorkflow(
      ada,
      admin,
      { token: secret }
    );
    const runId = await started(ada, workflow.id, serving);
    const run = await ended(ada, workflow.id, runId);
    const sent = await mail.did();
    const events = JSON.stringify(await allEvents());
    expect({
      executable,
      end: endOf(run),
      // The mail server got the call once, its subject the secret: the
      // value reached connect, through the call's binding argument.
      sent: sent.sent,
      calls: sent.calls,
      receipts: await receiptsOf(runId),
      // Connect's own record names the workflow, the run and the person.
      callEvents: await callEventsOf(runId),
      // Nothing the run or the audit log keeps holds it.
      inOutput: JSON.stringify(run).includes(secret),
      inAudit: events.includes(secret),
    }).toStrictEqual({
      executable: true,
      end: { status: "completed", output: { status: "message-1" } },
      sent: [{ to: "Ada", subject: secret }],
      calls: 1,
      // Started before it went out, done once it answered.
      receipts: ["started", "done"].map((outcome) => ({
        call: "grasp.connector",
        binding: "mail",
        person: ada.userId,
        outcome,
      })),
      callEvents: [
        {
          action: "connection.call",
          workflow: workflow.id,
          person: ada.userId,
        },
      ],
      inOutput: false,
      inAudit: false,
    });
  });

  it("refuses files named to attach to an operation whose contract takes none, sending nothing", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin, {
      attachments: [
        {
          name: "a.txt",
          type: "text/plain",
          size: 1,
          sha256: "0".repeat(64),
        },
      ],
    });
    const runId = await started(ada, workflow.id, serving);
    const run = await ended(ada, workflow.id, runId);
    const sent = await mail.did();
    expect({
      end: endOf(run),
      calls: sent.calls,
    }).toStrictEqual({
      end: { status: "failed", code: "workflow.call_invalid" },
      calls: 0,
    });
  });

  it("refuses a connector's answer that echoes a binding argument, so its value is never recorded", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const secret = `secret-${unique()}`;
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin, {
      token: secret,
    });
    // The server answers with the subject it was sent, in a field the
    // contract takes.
    await echoingMail(mail.id, secret);
    const runId = await started(ada, workflow.id, serving);
    const run = await ended(ada, workflow.id, runId);
    expect({
      end: endOf(run),
      inRun: JSON.stringify(run).includes(secret),
    }).toStrictEqual({
      end: { status: "failed", code: "workflow.call_invalid" },
      inRun: false,
    });
  });

  it("refuses the next call of a running run once its approval or permission is revoked", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const byApproval = await mailingWorkflow(ada, admin, { before: [hold] });
    const byPermission = await mailingWorkflow(ada, admin, { before: [hold] });
    const approvalRun = await started(
      ada,
      byApproval.workflow.id,
      byApproval.serving
    );
    const permissionRun = await started(
      ada,
      byPermission.workflow.id,
      byPermission.serving
    );
    // Both runs sleep before their call: their starts stand.
    await revokeWorkflowBinding(
      env,
      admin,
      byApproval.workflow.id,
      byApproval.approval.id
    );
    await revokePermission(env, admin, byPermission.permissionId);
    const approvalEnd = await ended(ada, byApproval.workflow.id, approvalRun);
    const permissionEnd = await ended(
      ada,
      byPermission.workflow.id,
      permissionRun
    );
    const approvalMail = await byApproval.mail.did();
    const permissionMail = await byPermission.mail.did();
    expect({
      approval: endOf(approvalEnd),
      permission: endOf(permissionEnd),
      calls: [approvalMail.calls, permissionMail.calls],
      receipts: await receiptsOf(approvalRun),
    }).toStrictEqual({
      approval: { status: "failed", code: "workflow.call_denied" },
      permission: { status: "failed", code: "workflow.call_denied" },
      calls: [0, 0],
      receipts: [
        {
          call: "grasp.connector",
          binding: "mail",
          person: ada.userId,
          outcome: "workflow.call_denied",
        },
      ],
    });
  });

  it("refuses the next call of a running run once its person loses their role in the workflow", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const bob = await person("builder");
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin, {
      before: [hold],
    });
    await shareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: bob.userId,
      role: "user",
    });
    // Bob's run sleeps before its call; he's unshared, still a member.
    const runId = await started(bob, workflow.id, serving);
    await unshareWorkflowResource(env, ada, workflow.id, {
      type: "person",
      id: bob.userId,
    });
    // An admin reads why it failed: its details are its person's and theirs.
    const run = await ended(admin, workflow.id, runId);
    const sent = await mail.did();
    expect({ end: endOf(run), calls: sent.calls }).toStrictEqual({
      end: { status: "failed", code: "workflow.call_denied" },
      calls: 0,
    });
  });

  it("never sends again under the same key, whatever its step's retries, once a send's outcome is lost, nor keeps its sensitive argument", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    // The server sends the mail, and its answer is lost on the way back.
    const secret = `secret-${unique()}`;
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin, {
      plan: ["lost"],
      token: secret,
    });
    const runId = await started(ada, workflow.id, serving);
    const run = await ended(ada, workflow.id, runId);
    const sent = await mail.did();
    // The call's person lists it as of unknown outcome, never its secret.
    const listed = await env.CONNECT.listUnknownOutcomes(
      await personOf(env, ada)
    );
    const ours = listed.filter(({ key }) => key.subject.type === "workflow");
    // Its person says it didn't happen, then that it did: whatever connect
    // makes of each, what it records of the call holds no hash of its input.
    for (const choice of ["not_happened", "happened"]) {
      for (const unknown of ours) {
        // oxlint-disable-next-line no-await-in-loop -- one decision after the other
        await resultOf(
          resolveUnknownOutcome(env, ada, unknown.key, choice, unknown.claim)
        );
      }
    }
    const events = await allEvents();
    const resolutions = events.filter(
      ({ action, detail }) =>
        action.startsWith("connection.call.resolve") &&
        detail?.subjectId === workflow.id
    );
    expect({
      resolutions: resolutions.length > 0,
      inputHashes: resolutions.filter(({ detail }) => "inputHash" in detail),
    }).toStrictEqual({ resolutions: true, inputHashes: [] });
    expect({
      status: run.status,
      calls: sent.calls,
      listed: ours.length,
      input: ours.map(({ input }) => input),
      secretShown: JSON.stringify(listed).includes(secret),
    }).toStrictEqual({
      status: "failed",
      calls: 1,
      listed: 1,
      input: [null],
      secretShown: false,
    });
  });

  it("checks a call's arguments against its contract before anything is sent", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    // `to` is text in the contract; this one is a number.
    const { workflow, mail, serving } = await mailingWorkflow(ada, admin, {
      to: { $expr: "args.who.length" },
    });
    const runId = await started(ada, workflow.id, serving);
    const run = await ended(ada, workflow.id, runId);
    const sent = await mail.did();
    expect({ end: endOf(run), calls: sent.calls }).toStrictEqual({
      end: { status: "failed", code: "workflow.call_invalid" },
      calls: 0,
    });
  });
});

describe("a step's own timeout", () => {
  beforeAll(chooseModel);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ends an attempt that runs past its step's timeout, long before the host's", async () => {
    const admin = await person("admin");
    const by = await person("builder");
    const key = `summary-${unique()}`;
    await publishCatalogContract(env, admin, { key, kind: "model" });
    const { workflow } = await published(by, {
      permissions: { ai: { contract: key } },
      steps: [greetStep("greet", "2 seconds")],
      status: "greet.line",
    });
    await approveWorkflowBinding(env, admin, workflow.id, {
      alias: "ai",
      target: { kind: "model", model: allowedModel },
      reviewed: { version: 1 },
    });
    // The model never answers: only the attempt's timeout ends the call.
    const provider = await providerAnswering({ hang: true });
    const startedAt = Date.now();
    const run = await ended(by, workflow.id, await started(by, workflow.id));
    // Its request cut off with its attempt, never left running past it.
    const cutOff = await vi.waitFor(
      () => {
        expect(provider.requests[0]?.signal.aborted).toBeTruthy();
        return true;
      },
      { timeout: 5000, interval: 100 }
    );
    expect({
      // Sent and never answered: it fails as past its step's time, and is
      // never sent again.
      end: endOf(run),
      requests: provider.requests.length,
      // Its step's two seconds, not the host's minute.
      early:
        Date.parse(run.endedAt ?? "") - startedAt < maxAttemptTimeoutMs / 2,
      cutOff,
    }).toStrictEqual({
      end: { status: "failed", code: "function.deadline_exceeded" },
      requests: 1,
      early: true,
      cutOff: true,
    });
  });
});

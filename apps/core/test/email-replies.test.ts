/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { decode } from "@grasp-os/workerflow/codec";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  emailReplyContract,
  emailReplyType,
  releaseContracts,
} from "../src/release-contracts.ts";
import { createTriggerResource } from "../src/trigger-resources.ts";
import {
  approveWorkflowBinding,
  revokeWorkflowBinding,
} from "../src/workflow-bindings.ts";
import { ensureReleaseContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { trustedAuthservId } from "../src/workflows/authentication-results.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { inboxOf } from "../src/workflows/run-inboxes.ts";
import { allEvents } from "./audit-events.ts";
import { deliver } from "./email-triggers.ts";
import { endLiveResourceRuns } from "./json-workflow-apps.ts";
import { liveStatus, runObject, woken } from "./runs.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { unique } from "./sign-in.ts";

// Replies to a run's mail, delivered to its inbox (inbound-email.ts,
// `receiveReply`), from the threat model in run-inboxes.ts. Anyone the
// run's mail reached can reply; the ways that can fail, each closed:
//
// - a reply lost because it came before the run waited for it: the run's
//   inbox keeps it, and the wait takes it;
// - a redelivery taken as a second reply: it is the same event, by its
//   Message-ID, whatever its bytes;
// - a mail loop (an auto-reply answering the run's mail): dropped,
//   audited, never bounced;
// - a run that ended, or whose binding's approval went, taking replies:
//   dropped, audited once per run and reason, never bounced;
// - a guessed token, or one core's key no longer derives: rejected at
//   SMTP time, as an address nobody receives at, so nothing bounces later;
// - a forged From, or a forged verdict below Email Routing's: the From is
//   data, and only Email Routing's results are reported;
// - a builder taking a run's replies with an email trigger of that shape:
//   refused, and reply addresses are looked up first.
//
// Each reply goes through core's real email handler, as Email Routing
// delivers it, to a real run of a real published workflow.

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
  return {
    userId,
    email: `${userId}@acme.test`,
    name: "Person",
    role,
    teams: [],
    staff: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
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

/**
 * A workflow that waits out its hour (`task:hold`), then waits for a reply
 * to its mail through `replies` and returns the subject of the one it
 * took, its binding approved.
 */
const replyWorkflow = async () => {
  const admin = await person("admin");
  for (const contract of releaseContracts) {
    if (contract.key === emailReplyContract) {
      // oxlint-disable-next-line no-await-in-loop -- one
      await ensureReleaseContract(env, contract, { builtin: "release" });
    }
  }
  const workflow = await createWorkflowResource(
    env,
    admin,
    `replies-${unique()}`
  );
  await publishWorkflowVersion(env, admin, workflow.id, {
    definition: JSON.stringify({
      document: {
        dsl: "1.0.3",
        namespace: workflowNamespace,
        name: workflow.name,
        version: "1.0.0",
        title: workflow.name,
        metadata: {
          grasp: {
            profile: "grasp-open-workflow/1",
            params: {},
            bindings: {
              replies: { kind: "event", contract: emailReplyContract },
            },
          },
        },
      },
      input: { schema: objectSchema({}) },
      output: { schema: objectSchema({ subject: { type: "string" } }) },
      do: [
        { hold: { wait: "PT1H" } },
        {
          "await-reply": {
            listen: {
              to: { any: [{ with: { type: emailReplyType } }] },
              read: "data",
            },
            timeout: { after: { minutes: 5 } },
            metadata: { grasp: { binding: "replies" } },
          },
        },
        { answer: { set: { subject: "${ .[0].subject }" } } },
      ],
    }),
    basedOn: null,
  });
  const approval = await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "replies",
    target: { kind: "event" },
    reviewed: { version: 1 },
  });
  return { admin, workflow, approval };
};

type ReplyWorkflow = Awaited<ReturnType<typeof replyWorkflow>>;

/** A run of the workflow, holding its hour, and its reply address. */
const holdingRun = async ({ admin, workflow }: ReplyWorkflow) => {
  const { runId } = await startWorkflow(
    env,
    { type: "person", person: admin },
    workflow.id,
    { version: 1, input: {}, key: unique() }
  );
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  await vi.waitFor(
    async () => {
      await expect(liveStatus(runId)).resolves.toBe("waiting");
    },
    { timeout: 30_000, interval: 100 }
  );
  const { replies: address } = await inboxOf(env, {
    runId,
    calling: { candidate: undefined },
  });
  if (address === undefined) {
    throw new Error(`Run ${runId} has no reply address`);
  }
  return { runId, address };
};

/** How the run ended, once it waited out its hour: what it returned. */
const endedRun = async ({ admin, workflow }: ReplyWorkflow, runId: string) => {
  await woken(runId, "task:hold");
  const run = await vi.waitFor(
    async () => {
      const ended = await resourceRunFor(env, admin, workflow.id, runId);
      expect(ended.endedAt).not.toBeNull();
      return ended;
    },
    { timeout: 30_000, interval: 100 }
  );
  return { status: run.status, output: run.output };
};

/** The events in run `runId`'s inbox, each whether a wait took it. */
const inboxEvents = async (runId: string) => {
  const journal = await runObject(runId).journal();
  return (journal?.events ?? []).map((event) => ({
    taken: event.consumed_by !== null,
  }));
};

const replySchema = z.object({
  source: z.string(),
  data: z.object({
    from: z.object({ name: z.string(), address: z.string() }),
    subject: z.string(),
    text: z.string(),
    stored: z.null(),
    authentication: z.unknown(),
  }),
});

/** The replies in run `runId`'s inbox: where from, and what each says. */
const repliesIn = async (runId: string) => {
  const journal = await runObject(runId).journal();
  return (journal?.events ?? []).map((event) => {
    const { source, data } = replySchema.parse(decode(event.payload));
    return {
      source,
      from: data.from.address,
      subject: data.subject,
      text: data.text.trim(),
      stored: data.stored,
      authentication: data.authentication,
    };
  });
};

/** The audit events of `action` about run `runId`, by their detail. */
const audited = async (action: string, runId: string) => {
  const events = await allEvents();
  return events
    .filter((event) => event.action === action && event.target?.id === runId)
    .map(({ detail }) => detail);
};

/** Why each reply to run `runId` was dropped, as audited. */
const dropReasons = async (runId: string) => {
  const dropped = await audited("workflow.email.reply.dropped", runId);
  return dropped.map((detail) => detail?.reason);
};

/** Email Routing's results of a message from Ben, all passing. */
const routingPass = `ARC-Authentication-Results: i=1; ${trustedAuthservId}; dkim=pass header.d=acme.test header.s=s1 header.b=IRdayjbb; dmarc=pass header.from=acme.test policy.dmarc=reject; spf=pass (${trustedAuthservId}: domain of ben@acme.test designates 2a00:1440::32e as permitted sender) smtp.mailfrom=ben@acme.test; arc=none smtp.remote-ip=2a00:1440::32e`;

/** A plain reply, as it goes over the wire. */
const replyMail = ({
  messageId = `${unique()}@acme.test`,
  from = "Ben <ben@acme.test>",
  subject = "Re: Your quote",
  text = "Yes, go ahead.",
  headers = [routingPass],
}: {
  messageId?: string;
  from?: string;
  subject?: string;
  text?: string;
  headers?: string[];
} = {}): string =>
  [
    ...headers,
    `Message-ID: <${messageId}>`,
    `From: ${from}`,
    "To: quotes@acme.test",
    `Subject: ${subject}`,
    "Date: Mon, 28 Sep 2026 08:00:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
    "",
  ].join("\r\n");

const clientHost = new URL(clientOrigin).hostname;

describe("replies to a run's mail", { timeout: 120_000 }, () => {
  let shared: ReplyWorkflow;

  beforeAll(async () => {
    shared = await replyWorkflow();
  });

  afterAll(endLiveResourceRuns);

  it("keeps a reply sent before the run waits for it, for the wait to take, with what Email Routing found", async () => {
    const { runId, address } = await holdingRun(shared);

    const delivery = await deliver(address, replyMail());
    const before = await inboxEvents(runId);
    const run = await endedRun(shared, runId);
    const received = await audited("workflow.email.reply.received", runId);

    expect({
      delivery,
      before,
      run,
      after: await inboxEvents(runId),
      replies: await repliesIn(runId),
      received: received.map((detail) => ({
        workflow: detail?.workflow,
        binding: detail?.binding,
      })),
    }).toStrictEqual({
      delivery: { rejected: undefined },
      before: [{ taken: false }],
      run: { status: "completed", output: { subject: "Re: Your quote" } },
      after: [{ taken: true }],
      replies: [
        {
          source: `urn:grasp:run:${runId}:inbox:replies:email`,
          from: "ben@acme.test",
          subject: "Re: Your quote",
          text: "Yes, go ahead.",
          stored: null,
          authentication: {
            spf: { result: "pass", domain: "acme.test" },
            dkim: { result: "pass", domain: "acme.test" },
            dmarc: { result: "pass", domain: "acme.test" },
          },
        },
      ],
      received: [{ workflow: shared.workflow.id, binding: "replies" }],
    });
  });

  it("keeps a forged From as the claim it is, with Email Routing's verdict, never a sender's own below it", async () => {
    const { runId, address } = await holdingRun(shared);
    const forged = `${trustedAuthservId}; dmarc=pass header.from=bank.test`;

    await deliver(
      address,
      replyMail({
        from: "Boss <boss@bank.test>",
        headers: [
          `ARC-Authentication-Results: i=2; ${trustedAuthservId}; dkim=pass header.d=evil.test; dmarc=fail (p=reject) header.from=bank.test; spf=pass smtp.mailfrom=x@evil.test`,
          `ARC-Authentication-Results: i=1; ${forged}`,
          `Authentication-Results: ${forged}`,
        ],
      }),
      { envelopeFrom: "x@evil.test" }
    );

    const replies = await repliesIn(runId);

    expect(
      replies.map(({ from, authentication }) => ({
        from,
        authentication,
      }))
    ).toStrictEqual([
      {
        from: "boss@bank.test",
        authentication: {
          spf: { result: "pass", domain: "evil.test" },
          dkim: { result: "pass", domain: "evil.test" },
          dmarc: { result: "fail", domain: "bank.test" },
        },
      },
    ]);
  });

  it("takes a reply delivered again as the one event it is, whatever its bytes", async () => {
    const { runId, address } = await holdingRun(shared);
    const messageId = `${unique()}@acme.test`;

    const first = await deliver(address, replyMail({ messageId }));
    const again = await deliver(address, replyMail({ messageId }));
    const relayed = await deliver(
      address,
      replyMail({
        messageId,
        headers: [
          "Received: from relay.acme.test; Mon, 28 Sep 2026 08:00:05 +0000",
          routingPass,
        ],
      })
    );
    const events = await inboxEvents(runId);
    const received = await audited("workflow.email.reply.received", runId);

    expect({
      rejected: [first, again, relayed].map(({ rejected }) => rejected),
      events,
      received: received.length,
    }).toStrictEqual({
      rejected: [undefined, undefined, undefined],
      events: [{ taken: false }],
      received: 1,
    });
  });

  it("drops an automatic reply, audited, never bounced", async () => {
    const { runId, address } = await holdingRun(shared);

    const delivery = await deliver(
      address,
      replyMail({
        subject: "Out of office",
        headers: ["Auto-Submitted: auto-replied", routingPass],
      })
    );

    expect({
      delivery,
      events: await inboxEvents(runId),
      dropped: await audited("workflow.email.reply.dropped", runId),
    }).toStrictEqual({
      delivery: { rejected: undefined },
      events: [],
      dropped: [
        {
          workflow: shared.workflow.id,
          binding: "replies",
          reason: "auto_submitted",
          day: new Date().toISOString().slice(0, 10),
        },
      ],
    });
  });

  it("drops replies to a run that ended, audited once however many come, never bounced", async () => {
    const { runId, address } = await holdingRun(shared);
    await runObject(runId).terminate({ rollback: false });
    await vi.waitFor(
      async () => {
        await expect(liveStatus(runId)).resolves.toBe("terminated");
      },
      { timeout: 30_000, interval: 100 }
    );

    const deliveries = [
      await deliver(address, replyMail()),
      await deliver(address, replyMail()),
    ];

    expect({
      rejected: deliveries.map(({ rejected }) => rejected),
      dropped: await dropReasons(runId),
    }).toStrictEqual({
      rejected: [undefined, undefined],
      dropped: ["run_ended"],
    });
  });

  it("drops a reply once the binding's approval is revoked, audited, never bounced", async () => {
    const own = await replyWorkflow();
    const { runId, address } = await holdingRun(own);
    await revokeWorkflowBinding(
      env,
      own.admin,
      own.workflow.id,
      own.approval.id
    );

    const delivery = await deliver(address, replyMail());

    expect({
      delivery,
      events: await inboxEvents(runId),
      dropped: await dropReasons(runId),
    }).toStrictEqual({
      delivery: { rejected: undefined },
      events: [],
      dropped: ["event_denied"],
    });
  });

  it("rejects a token no run has, or one core's key no longer derives, before reading the message", async () => {
    const { runId, address } = await holdingRun(shared);
    const guessed = `reply-${"ab".repeat(16)}@${clientHost}`;

    const unknown = await deliver(guessed, replyMail());
    const rotated = await deliver(address, replyMail(), {
      changes: {
        BETTER_AUTH_SECRET: "another-auth-secret-of-32-chars-or-more",
      },
    });

    expect({
      unknown,
      rotated,
      events: await inboxEvents(runId),
    }).toStrictEqual({
      unknown: { rejected: "No such address." },
      rotated: { rejected: "No such address." },
      events: [],
    });
  });

  it("lets no email trigger take a reply address's shape", async () => {
    const { admin, workflow } = shared;
    const { address } = await holdingRun(shared);
    const [local] = address.split("@");

    await expect(
      createTriggerResource(env, admin, {
        kind: "email",
        workflowId: workflow.id,
        version: 1,
        config: { input: {}, address: local },
      })
    ).rejects.toMatchObject({ code: "workflow.email_taken" });
  });
});

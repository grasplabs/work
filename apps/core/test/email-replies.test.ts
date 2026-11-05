import type { Role } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { decode } from "@grasp-os/workerflow/codec";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
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
import { aroundEngine, liveStatus, runObject, woken } from "./runs.ts";
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

/** A JSON object schema of `properties`, each required, and nothing else. */
const objectSchema = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/**
 * A workflow that waits out its hour (`hold:task`), then waits for a reply
 * to its mail through each of `aliases` (`replies` unless given) in turn
 * (`reply1`, `reply2` …) and returns the subject of the last one it took,
 * each binding approved.
 */
const replyWorkflow = async (aliases: readonly string[] = ["replies"]) => {
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
      $schema: workflowSchemaUrl,
      input: objectSchema({}),
      output: {
        schema: objectSchema({ subject: { type: "string" } }),
        value: {
          subject: {
            $expr: `steps.reply${aliases.length}.output.event?.data.subject ?? ""`,
          },
        },
      },
      bindings: Object.fromEntries(
        aliases.map((alias) => [
          alias,
          { kind: "event", contract: emailReplyContract },
        ])
      ),
      steps: [
        { id: "hold", type: "wait", for: "1 hour" },
        ...aliases.map((alias, index) => ({
          id: `reply${index + 1}`,
          type: "wait",
          event: { from: alias, type: emailReplyType },
          timeout: "5 minutes",
        })),
      ],
    }),
    basedOn: null,
  });
  const approvals: string[] = [];
  for (const alias of aliases) {
    // oxlint-disable-next-line no-await-in-loop -- approvals, in turn
    const approval = await approveWorkflowBinding(env, admin, workflow.id, {
      alias,
      target: { kind: "event" },
      reviewed: { version: 1 },
    });
    approvals.push(approval.id);
  }
  return { admin, workflow, approvals };
};

type ReplyWorkflow = Awaited<ReturnType<typeof replyWorkflow>>;

/**
 * A run of the workflow, holding its hour: the address of its first
 * inbox, and every inbox it has.
 */
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
  const inbox = await inboxOf(env, {
    runId,
    calling: { candidate: undefined },
  });
  const [address] = Object.values(inbox);
  if (address === undefined) {
    throw new Error(`Run ${runId} has no reply address`);
  }
  return { runId, address, inbox };
};

/** How the run ended, once it waited out its hour: what it returned. */
const endedRun = async ({ admin, workflow }: ReplyWorkflow, runId: string) => {
  await woken(runId, "hold:task");
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

/** Today, as the audit log's days are: in UTC. */
const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * An ARC set at `instance` (its seal, message signature and results), its
 * seal saying `cv`.
 */
const arcSet = (instance: number, results: string, cv = "none"): string[] => [
  `ARC-Seal: i=${String(instance)}; a=rsa-sha256; s=cf2024-1; d=cloudflare-email.net; cv=${cv}; b=Lx35lY6/t4g==`,
  `ARC-Message-Signature: i=${String(instance)}; a=rsa-sha256; c=relaxed/relaxed; d=cloudflare-email.net; s=cf2024-1; h=from:to:subject; bh=x/y=; b=z+w==`,
  `ARC-Authentication-Results: i=${String(instance)}; ${results}`,
];

/** What Email Routing found of a message from Ben: all passing. */
const routingResults = `${trustedAuthservId}; dkim=pass header.d=acme.test header.s=s1 header.b=IRda/jbb; dmarc=pass header.from=acme.test policy.dmarc=reject; spf=pass (${trustedAuthservId}: domain of ben@acme.test designates 2a00:1440::32e as permitted sender) smtp.mailfrom=ben@acme.test; arc=none smtp.remote-ip=2a00:1440::32e`;

/** Email Routing's ARC set on a message from Ben, all passing. */
const routingPass = arcSet(1, routingResults);

/** A plain reply, as it goes over the wire. */
const replyMail = ({
  messageId = `${unique()}@acme.test`,
  from = "Ben <ben@acme.test>",
  subject = "Re: Your quote",
  text = "Yes, go ahead.",
  headers = routingPass,
}: {
  messageId?: string;
  /** Its From, or none at all for null. */
  from?: string | null;
  subject?: string;
  text?: string;
  headers?: string[];
} = {}): string =>
  [
    ...headers,
    `Message-ID: <${messageId}>`,
    ...(from === null ? [] : [`From: ${from}`]),
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

    // Sent from Microsoft 365, whose own ARC set, below Email Routing's,
    // isn't the grammar's.
    const delivery = await deliver(
      address,
      replyMail({
        headers: [
          ...arcSet(2, routingResults, "pass"),
          ...arcSet(
            1,
            "mx.microsoft.com 1; spf=pass smtp.mailfrom=acme.test; dmarc=pass action=none header.from=acme.test; dkim=pass header.d=acme.test; arc=none"
          ),
        ],
      })
    );
    const before = await inboxEvents(runId);
    const run = await endedRun(shared, runId);
    const received = await audited("workflow.email.reply.received", runId);

    expect({
      delivery,
      before,
      run,
      after: await inboxEvents(runId),
      replies: await repliesIn(runId),
      // Once a day it is delivered: once, unless the day turned.
      received: [
        ...new Set(
          received.map((detail) =>
            JSON.stringify([detail?.workflow, detail?.binding])
          )
        ),
      ],
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
      received: [JSON.stringify([shared.workflow.id, "replies"])],
    });
  });

  it("keeps a forged From as the claim it is, with Email Routing's verdict, never a sender's own", async () => {
    const { runId, address } = await holdingRun(shared);
    const forged = `${trustedAuthservId}; dmarc=pass header.from=bank.test`;

    await deliver(
      address,
      replyMail({
        from: "Boss <boss@bank.test>",
        headers: [
          ...arcSet(
            2,
            `${trustedAuthservId}; dkim=pass header.d=evil.test; dmarc=fail (p=reject) header.from=bank.test; spf=pass smtp.mailfrom=x@evil.test`,
            "pass"
          ),
          ...arcSet(1, forged),
          `Authentication-Results: ${forged}`,
        ],
      }),
      { envelopeFrom: "x@evil.test" }
    );
    // A chain forged full, so no sealer may add a set on top of its own.
    await deliver(
      address,
      replyMail({
        from: "Boss <boss@bank.test>",
        headers: arcSet(50, forged, "pass"),
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
      {
        from: "boss@bank.test",
        authentication: { spf: null, dkim: null, dmarc: null },
      },
    ]);
  });

  it("reports DMARC only when it judged the one From mailbox the run gets", async () => {
    const { runId, address } = await holdingRun(shared);
    // Each with Email Routing's own DMARC pass for acme.test, of the From
    // it judged: which one, the run can't tell, so only a message with one
    // From header holding one mailbox, the one the run gets, at that
    // domain, keeps it. By subject, each case.
    const cases: Record<
      string,
      { from: string | null; headers?: string[]; envelopeFrom?: string }
    > = {
      aligned: { from: "Ben <ben@acme.test>" },
      cased: { from: "Ben <ben@ACME.Test>" },
      // DMARC vouches for the domain: which address at it may send is the
      // domain's own policy.
      sameDomain: { from: "Boss <boss@acme.test>" },
      otherDomain: { from: "Boss <boss@bank.test>" },
      // A From above the one DMARC may have judged (verifiers read From
      // bottom up), the run getting the topmost.
      severalFrom: {
        from: "Ben <ben@acme.test>",
        headers: [...routingPass, "From: Boss <boss@acme.test>"],
      },
      // RFC 5322 4.5's obsolete `From :`, kept apart by postal-mime.
      spacedFrom: {
        from: "Ben <ben@acme.test>",
        headers: [...routingPass, "From : Boss <boss@acme.test>"],
      },
      severalMailboxes: { from: "boss@acme.test, ben@acme.test" },
      group: { from: "Team: boss@acme.test;" },
      // No From postal-mime can read: the run gets the envelope sender.
      unreadable: { from: "", envelopeFrom: "boss@acme.test" },
      spacedOnly: {
        from: null,
        headers: [...routingPass, "From : Boss <boss@acme.test>"],
        envelopeFrom: "boss@acme.test",
      },
      // Several `@`: which domain it names depends on who reads it.
      severalAt: {
        from: "Boss <boss@bank.test@acme.test>",
      },
      // An address the run gets cut to 256 characters, its quoted local
      // part ending, once cut, at another domain.
      cut: { from: `"${"x".repeat(245)}@bank.test tail"@acme.test` },
    };
    await Promise.all(
      Object.entries(cases).map(
        async ([subject, { from, headers, envelopeFrom }]) =>
          await deliver(address, replyMail({ subject, from, headers }), {
            envelopeFrom,
          })
      )
    );

    const replies = await repliesIn(runId);

    expect(
      Object.fromEntries(
        replies.map(({ subject, from, authentication }) => [
          subject,
          [from, z.object({ dmarc: z.unknown() }).parse(authentication).dmarc],
        ])
      )
    ).toStrictEqual({
      aligned: ["ben@acme.test", { result: "pass", domain: "acme.test" }],
      cased: ["ben@ACME.Test", { result: "pass", domain: "acme.test" }],
      sameDomain: ["boss@acme.test", { result: "pass", domain: "acme.test" }],
      otherDomain: ["boss@bank.test", null],
      severalFrom: ["boss@acme.test", null],
      spacedFrom: ["ben@acme.test", null],
      severalMailboxes: ["boss@acme.test", null],
      group: ["boss@acme.test", null],
      unreadable: ["boss@acme.test", null],
      spacedOnly: ["boss@acme.test", null],
      cut: [`"${"x".repeat(245)}@bank.test`, null],
      severalAt: ["boss@bank.test@acme.test", null],
    });
  });

  it("takes a reply delivered again as the one event it is, whatever its bytes", async () => {
    const { runId, address } = await holdingRun(shared);
    const messageId = `${unique()}@acme.test`;

    const before = today();
    const first = await deliver(address, replyMail({ messageId }));
    const again = await deliver(address, replyMail({ messageId }));
    const relayed = await deliver(
      address,
      replyMail({
        messageId,
        headers: [
          "Received: from relay.acme.test; Mon, 28 Sep 2026 08:00:05 +0000",
          ...routingPass,
        ],
      })
    );
    const days = new Set([before, today()]);
    const events = await inboxEvents(runId);
    const received = await audited("workflow.email.reply.received", runId);

    expect({
      rejected: [first, again, relayed].map(({ rejected }) => rejected),
      events,
      // Once a day it is delivered: once, unless the day turned.
      received: received.length >= 1 && received.length <= days.size,
    }).toStrictEqual({
      rejected: [undefined, undefined, undefined],
      events: [{ taken: false }],
      received: true,
    });
  });

  it("drops an automatic reply, audited, never bounced", async () => {
    const { runId, address } = await holdingRun(shared);

    const before = today();
    const delivery = await deliver(
      address,
      replyMail({
        subject: "Out of office",
        headers: ["Auto-Submitted: auto-replied", ...routingPass],
      })
    );
    const days = [before, today()];
    const [dropped] = await audited("workflow.email.reply.dropped", runId);

    expect({
      delivery,
      events: await inboxEvents(runId),
      dropped,
      onItsDay: days.includes(String(dropped?.day)),
    }).toStrictEqual({
      delivery: { rejected: undefined },
      events: [],
      dropped: {
        workflow: shared.workflow.id,
        binding: "replies",
        reason: "auto_submitted",
        day: dropped?.day,
      },
      onItsDay: true,
    });
  });

  it("audits drops for each of a run's inboxes on their own", async () => {
    const own = await replyWorkflow(["quotes", "approvals"]);
    const { runId, inbox } = await holdingRun(own);
    const autoReply = () =>
      replyMail({ headers: ["Auto-Submitted: auto-replied", ...routingPass] });

    for (const address of Object.values(inbox)) {
      // oxlint-disable-next-line no-await-in-loop -- one inbox, then the other
      await deliver(address, autoReply());
    }
    const dropped = await audited("workflow.email.reply.dropped", runId);
    const { results: rejected } = await env.DB.prepare(
      "SELECT id FROM audit_outbox_rejected"
    ).all();

    expect({
      inboxes: Object.keys(inbox).toSorted(),
      dropped: dropped.map((detail) => String(detail?.binding)).toSorted(),
      rejected,
    }).toStrictEqual({
      inboxes: ["approvals", "quotes"],
      dropped: ["approvals", "quotes"],
      rejected: [],
    });
  });

  it("drops replies to a run that ended, audited once a day however many come, never bounced, but not one it took", async () => {
    const { runId, address } = await holdingRun(shared);
    const taken = replyMail();
    await deliver(address, taken);
    await runObject(runId).terminate({ rollback: false });
    await vi.waitFor(
      async () => {
        await expect(liveStatus(runId)).resolves.toBe("terminated");
      },
      { timeout: 30_000, interval: 100 }
    );

    const before = today();
    const deliveries = [
      // Its answer lost, the reply the run took comes again.
      await deliver(address, taken),
      await deliver(address, replyMail()),
      await deliver(address, replyMail()),
    ];
    const days = new Set([before, today()]);
    const dropped = await dropReasons(runId);
    const received = await audited("workflow.email.reply.received", runId);

    expect({
      rejected: deliveries.map(({ rejected }) => rejected),
      reasons: [...new Set(dropped)],
      oncePerDay: dropped.length <= days.size,
      received: received.length,
    }).toStrictEqual({
      rejected: [undefined, undefined, undefined],
      reasons: ["run_ended"],
      oncePerDay: true,
      received: 1,
    });
  });

  it("fails a reply for now while the run's start isn't confirmed, and takes it when delivered again", async () => {
    const { runId, address } = await holdingRun(shared);
    const reply = replyMail();

    const refused = await aroundEngine(
      async (method, call) =>
        method === "sendEvent"
          ? await Promise.resolve("missing")
          : await call(),
      async () => {
        try {
          await deliver(address, reply);
          return "delivered";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }
    );
    const again = await deliver(address, reply);

    expect({
      refused: refused.includes("hasn't started yet"),
      again,
      events: await inboxEvents(runId),
      dropped: await dropReasons(runId),
    }).toStrictEqual({
      refused: true,
      again: { rejected: undefined },
      events: [{ taken: false }],
      dropped: [],
    });
  });

  it("drops replies past the inbox's share for replies, audited, leaving the rest of the inbox to the run's other senders", async () => {
    const { runId, address } = await holdingRun(shared);
    // Each reply as large as an event's data takes: an eighth of the
    // inbox's bytes holds a few dozen.
    const text = "x".repeat(140 * 1024);
    let sent = 0;
    const rejected: (string | undefined)[] = [];
    while (sent < 64) {
      sent += 1;
      // oxlint-disable-next-line no-await-in-loop -- in order, until the share is full
      const delivery = await deliver(address, replyMail({ text }));
      rejected.push(delivery.rejected);
      // oxlint-disable-next-line no-await-in-loop -- read after each
      const dropped = await dropReasons(runId);
      if (dropped.length > 0) {
        break;
      }
    }
    const events = await inboxEvents(runId);

    expect({
      rejected: [...new Set(rejected)],
      dropped: await dropReasons(runId),
      kept: events.length === sent - 1,
      share: events.length < 64,
    }).toStrictEqual({
      rejected: [undefined],
      dropped: ["event_refused"],
      kept: true,
      share: true,
    });
  });

  it("drops a reply once the binding's approval is revoked, audited, never bounced", async () => {
    const own = await replyWorkflow();
    const { runId, address } = await holdingRun(own);
    await revokeWorkflowBinding(
      env,
      own.admin,
      own.workflow.id,
      own.approvals[0]
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

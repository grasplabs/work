import { v } from "@grasp-os/sdk";
import { decode } from "@grasp-os/workerflow/codec";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { releaseContracts } from "../src/release-contracts.ts";
import {
  approveWorkflowBinding,
  revokeWorkflowBinding,
} from "../src/workflow-bindings.ts";
import {
  ensureReleaseContract,
  publishCatalogContract,
} from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { runEngine } from "../src/workflows/engine.ts";
import { eventTypeKey } from "../src/workflows/event-envelopes.ts";
import { admitRunEvent } from "../src/workflows/run-events.ts";
import type { HostedSealedRun } from "../src/workflows/sealed-run.ts";
import { allEvents } from "./audit-events.ts";
import { endLiveResourceRuns } from "./json-workflow-apps.ts";
import { mailConnection } from "./mail-connection.ts";
import { connectModels } from "./model-provider.ts";
import {
  allowedModel,
  deadlinePasses,
  descriptorOf,
  echoingMail,
  failedWith,
  granted,
  journalingEngine,
  mailInput,
  mailOutput,
  newerEngine,
  person,
  ranAs,
  retryingEngine,
  sealedRunOf,
  sealedWorkflow,
  serving,
  waitingRun,
} from "./sealed-run-harness.ts";
import type { Engine, Journaled } from "./sealed-run-harness.ts";
import { refusal, unique } from "./sign-in.ts";
import {
  declared,
  generated,
  objectOf,
  rowsOf,
} from "./workflow-schema-runs.ts";

/** The types of `eventWorkflow`'s event contract: a reply, and a bounce. */
const received = "grasp.reply.received";

const bounced = "grasp.reply.bounced";

/** Where `eventWorkflow`'s events come from: an App, as its page sends. */
const fromApp = "https://grasp.test/apps/replies";

/**
 * A workflow of `by`'s on input `{ who }`, published and its event
 * binding `replies` approved by `admin`: after an hour's wait, it listens
 * through `replies` for a reply or a bounce, each of data `{ from }`.
 */
const eventWorkflow = async () => {
  const admin = await person("admin");
  const by = await person("builder");
  const contract = `replies-${unique()}`;
  const data = descriptorOf(v.object({ from: v.string() }));
  await publishCatalogContract(env, admin, {
    key: contract,
    kind: "event",
    events: {
      [received]: { data, browser: false },
      [bounced]: { data, browser: false },
    },
  });
  const workflow = await createWorkflowResource(env, by, `replies-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: JSON.stringify({
      $schema: workflowSchemaUrl,
      args: objectOf({ who: { kind: "string" } }),
      permissions: { events: { replies: { contract } } },
      steps: [
        { id: "linger", type: "wait", for: "1 hour" },
        {
          id: "reply",
          type: "waitForEvent",
          events: "replies",
          eventType: [received, bounced],
          timeout: "3 days",
        },
      ],
    }),
    basedOn: null,
  });
  const approved = await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "replies",
    target: { kind: "event" },
    reviewed: { version: 1 },
  });
  return { admin, by, workflow, approval: approved };
};

type Listening = Awaited<ReturnType<typeof eventWorkflow>>;

/** `eventWorkflow`'s event binding, as a document declares it. */
const replies = { events: { replies: { contract: "grasp.replies@1" } } };

/** An event wait for a reply or a bounce through `replies`. */
const replyWait = (change: Record<string, unknown> = {}) => ({
  id: "reply",
  type: "waitForEvent",
  events: "replies",
  eventType: [received, bounced],
  timeout: "3 days",
  ...change,
});

/** What a run ends with: how wait `reply` ended, as later steps read it. */
const replied = {
  schema: objectOf({
    timedOut: { kind: "boolean" },
    type: { kind: "string" },
    from: { kind: "string" },
    source: { kind: "string" },
  }),
  value: {
    timedOut: { $expr: "reply.timedOut" },
    type: { $expr: 'reply.timedOut ? "" : reply.event.type' },
    from: { $expr: 'reply.timedOut ? "" : reply.event.data.from ?? ""' },
    source: { $expr: 'reply.timedOut ? "" : reply.event.source' },
  },
};

/** An App's event of `type` from `from`, sent to run `runId`. */
const sendTo = async (
  { workflow }: Listening,
  runId: string,
  type: string,
  from: string
) =>
  await admitRunEvent(env, {
    workflowId: workflow.id,
    runId,
    binding: "replies",
    type,
    data: { from },
    key: unique(),
    source: fromApp,
    sender: fromApp,
  });

/** What an engine's event waits were asked: each by its step, with its end. */
type Asked = { step: string; types: string[]; until: number }[];

/**
 * An engine whose waits for an event each take the event `sends` sends
 * the run as it begins, from the run's inbox as the engine keeps it, when
 * one of the wait's matches names its engine type, as the engine matches
 * them; and whose waits end as their deadline passes otherwise. What each
 * wait asked goes in `asked`.
 */
const listeningEngine = (
  runId: string,
  sends: () => Promise<{ id: string } | undefined>,
  asked: Asked
): Engine => {
  const { step, leaseOf } = newerEngine();
  return {
    leaseOf,
    step: {
      ...step,
      waitForMatch: async (name, { match, until }) => {
        asked.push({ step: name, types: match.map(({ type }) => type), until });
        const sent = await sends();
        const kept =
          sent === undefined
            ? null
            : await runEngine(env).eventOf(runId, sent.id);
        if (kept === null || !match.some(({ type }) => type === kept.type)) {
          return await deadlinePasses();
        }
        return { payload: decode(kept.payload), timestamp: new Date() };
      },
    },
  };
};

/** What an engine's waits for an event took, by their step. */
type Taken = Map<string, Awaited<ReturnType<Engine["step"]["waitForMatch"]>>>;

/**
 * `listening`'s waits, its other steps journaled as `journalingEngine`
 * journals them (those that ran in `ran`): each wait's event kept in
 * `taken`, which a replay takes it from, asking the engine nothing.
 */
const journaledListening = (
  listening: Engine,
  journal: Map<string, Journaled>,
  taken: Taken,
  ran: string[] = []
): Engine => {
  const journaled = journalingEngine(journal, ran);
  return {
    leaseOf: journaled.leaseOf,
    step: {
      ...journaled.step,
      waitForMatch: async (name, options) => {
        const kept = taken.get(name);
        if (kept !== undefined) {
          return kept;
        }
        const event = await listening.step.waitForMatch(name, options);
        taken.set(name, event);
        return event;
      },
    },
  };
};

/** The engine types the host keeps `replies`' events of `types` under. */
const keysOf = async (...types: string[]): Promise<string[]> =>
  await Promise.all(
    types.map(async (type) => await eventTypeKey("replies", type))
  );

/** The steps task `id` has in `run`'s build, its table `seal`ed in. */
const sealedSteps = (
  run: HostedSealedRun,
  seal: (loaded: HostedSealedRun) => HostedSealedRun,
  id: string
) => seal(run).build.tasks.find((task) => task.id === id)?.steps;

/** Sends nothing: the wait's deadline passes. */
const nothingSent = async (): Promise<undefined> => {
  await Promise.resolve();
};

// An event wait's generated code on the run host: the first event of its
// sealed binding and types an App sends the run, as the host minted it; a
// timeout an outcome, `{ timedOut: true }`, never a failure; a wait in
// each item of a loop under that item's keys; and a binding revoked since
// the start, `workflow.event_denied`, failing the run, which no catch takes.
/** A refused publication's problems, each as its code and pointer. */
const pointers = (error: unknown) =>
  z
    .object({
      details: z.object({
        problems: z.array(z.object({ code: z.string(), pointer: z.string() })),
      }),
    })
    .parse(error)
    .details.problems.map(({ code, pointer }) => `${code} ${pointer}`);

/**
 * The release's contract for replies to a run's mail, and its type: the
 * one whose type comes from outside, by email.
 */
const emailReplies = () => {
  for (const contract of releaseContracts) {
    for (const [type, event] of Object.entries(contract.events ?? {})) {
      if ("ingress" in event && event.ingress === "email") {
        return { contract, type };
      }
    }
  }
  throw new Error("The release has no contract for replies to a run's mail");
};

/**
 * A workflow of `by`'s on input `{ who }` that mails through connector
 * binding `mail`, and its event binding `replies`, of the release's
 * contract for replies to the run's mail, both approved by `admin`: so
 * each of its runs has a reply address for `replies`.
 */
const replyingWorkflow = async () => {
  const admin = await person("admin");
  const by = await person("builder");
  const reply = emailReplies();
  await ensureReleaseContract(env, reply.contract, { builtin: "release" });
  const mailKey = `mail-${unique()}`;
  await publishCatalogContract(env, admin, {
    key: mailKey,
    kind: "connector",
    operations: {
      "mail.send": {
        input: descriptorOf(mailInput),
        output: descriptorOf(mailOutput),
      },
    },
  });
  const workflow = await createWorkflowResource(env, by, `asks-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: JSON.stringify({
      $schema: workflowSchemaUrl,
      args: objectOf({ who: { kind: "string" } }),
      permissions: {
        connections: { mail: { contract: mailKey } },
        events: { replies: { contract: reply.contract.key } },
      },
      steps: [
        { id: "linger", type: "wait", for: "1 hour" },
        {
          id: "ask",
          type: "call",
          connection: "mail",
          action: "mail.send",
          args: { to: { $expr: "args.who" }, subject: "x" },
        },
        {
          id: "reply",
          type: "waitForEvent",
          events: "replies",
          eventType: reply.type,
          timeout: "7 days",
        },
      ],
    }),
    basedOn: null,
  });
  const mail = await mailConnection();
  const permissionId = await granted(by, admin, {
    subject: { type: "workflow", workflowId: workflow.id },
    object: { type: "connection", connectionId: mail.id },
    actions: ["mail.send"],
    binding: `MAIL_${unique().toUpperCase().replaceAll("-", "_")}`,
  });
  await approveWorkflowBinding(serving, admin, workflow.id, {
    alias: "mail",
    target: { kind: "connector", permissionId, contract: "composio.mail@1" },
    reviewed: { version: 1 },
  });
  await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "replies",
    target: { kind: "event" },
    reviewed: { version: 1 },
  });
  return { by, workflow, mail, replyType: reply.type };
};

/** A run's reply address, as `WorkflowContext.inbox` has it. */
const replyAddress = /^reply-[0-9a-f]{32}@/u;

/** A reply from `address`, as the run's inbox takes one by email. */
const replyFrom = (address: string) => ({
  id: `<${unique()}@acme.test>`,
  stored: null,
  from: { name: "Ada", address },
  to: [],
  cc: [],
  subject: "Re: Can you approve?",
  date: null,
  text: "Approved.",
  truncated: false,
  attachments: [],
  authentication: {
    spf: { result: "pass", domain: "acme.test" },
    dkim: { result: "pass", domain: "acme.test" },
    dmarc: { result: "pass", domain: "acme.test" },
  },
});

/** How many times run `runId`'s steps wrote the workflow's state. */
const stateWrites = async (runId: string): Promise<number> => {
  const events = await allEvents();
  return events.filter(
    ({ action, target }) =>
      action === "workflow.state.written" && target?.id === runId
  ).length;
};

/** A mail to the run's person, its subject what the state kept, or "none". */
const remember = {
  id: "remember",
  type: "call",
  connection: "mail",
  action: "mail.send",
  args: {
    to: { $expr: "args.who" },
    subject: { $expr: 'state.last ?? "none"' },
  },
  state: {
    last: { $expr: "output.messageId" },
    previous: { $expr: 'state.last ?? "none"' },
    runs: { $expr: "(state.runs ?? 0) + 1" },
    kind: "visit",
  },
};

/** What a run read of `remember`'s state: as its output's schema and value. */
const readState = {
  schema: objectOf({
    last: { kind: "string" },
    previous: { kind: "string" },
    runs: { kind: "number" },
    kind: { kind: "string" },
  }),
  value: {
    last: { $expr: 'state.last ?? "none"' },
    previous: { $expr: 'state.previous ?? "none"' },
    runs: { $expr: "state.runs ?? 0" },
    kind: { $expr: 'state.kind ?? "none"' },
  },
};

describe("a grasp-workflow/2 event wait's generated code on the run host", () => {
  let listening: Listening;

  beforeAll(async () => {
    listening = await eventWorkflow();
  });

  afterAll(endLiveResourceRuns);

  it("is published only for types its binding's contract admits, and records what it waits for as the version's listens", async () => {
    const admin = await person("admin");
    const by = await person("builder");
    const contract = `replies-${unique()}`;
    const data = descriptorOf(v.object({ from: v.string() }));
    await publishCatalogContract(env, admin, {
      key: contract,
      kind: "event",
      events: { [received]: { data, browser: false } },
    });
    const workflow = await createWorkflowResource(env, by, `waits-${unique()}`);
    const publishing = async (types: string | string[]) =>
      await publishWorkflowVersion(env, by, workflow.id, {
        definition: JSON.stringify({
          $schema: workflowSchemaUrl,
          permissions: { events: { replies: { contract } } },
          steps: [
            {
              id: "reply",
              type: "waitForEvent",
              events: "replies",
              eventType: types,
              timeout: "3 days",
            },
          ],
        }),
        basedOn: null,
      });
    const refused = await refusal(publishing([received, bounced]));
    const single = await refusal(publishing(bounced));
    await publishing(received);
    const stored = await env.DB.prepare(
      "SELECT contract FROM workflow_resource_versions WHERE workflow_resource_id = ?"
    )
      .bind(workflow.id)
      .first<{ contract: string }>();
    expect({
      refused: pointers(refused),
      single: pointers(single),
      listens: z
        .object({ listens: z.unknown() })
        .parse(JSON.parse(stored?.contract ?? "{}")).listens,
    }).toStrictEqual({
      // A wait for a type it can never be sent would end only by timing out.
      refused: ["event.unknown_type /steps/0/eventType/1"],
      single: ["event.unknown_type /steps/0/eventType"],
      listens: { reply: { alias: "replies", types: [received] } },
    });
  });

  it("takes an event of its binding and types an App sends the run, as the host minted it", async () => {
    const { source, sealed: withTable } = await generated(
      [replyWait()],
      replied,
      replies
    );
    const runId = await waitingRun(listening);
    const asked: Asked = [];
    const ran = await ranAs(runId, source, {
      sealed: withTable,
      engine: listeningEngine(
        runId,
        async () => await sendTo(listening, runId, bounced, "ada@acme.test"),
        asked
      ),
    });
    expect({
      ran,
      asked: asked.map(({ step, types }) => ({ step, types })),
    }).toStrictEqual({
      ran: {
        ended: {
          timedOut: false,
          type: bounced,
          from: "ada@acme.test",
          // The host's, from the sender's authority: never its input.
          source: fromApp,
        },
        tampered: [],
      },
      asked: [
        {
          step: "reply:task",
          types: await keysOf(received, bounced),
        },
      ],
    });
  });

  it("answers `{ timedOut: true }` once its sealed timeout passes, which a later step reads", async () => {
    const { source, sealed: withTable } = await generated(
      [
        replyWait({ timeout: "2 days" }),
        {
          id: "chase",
          type: "wait",
          if: { $expr: "reply.timedOut" },
          for: "1 hour",
        },
      ],
      replied,
      replies
    );
    const runId = await waitingRun(listening);
    const asked: Asked = [];
    const before = Date.now();
    const ran = await ranAs(runId, source, {
      sealed: withTable,
      engine: listeningEngine(runId, nothingSent, asked),
    });
    const after = Date.now();
    const until = asked.map((wait) => wait.until);
    expect({
      ran,
      // Its deadline is its sealed timeout from when it was first reached.
      sealedTimeout: until.map(
        (end) => end >= before + 2 * 86_400_000 && end <= after + 2 * 86_400_000
      ),
    }).toStrictEqual({
      ran: {
        ended: { timedOut: true, type: "", from: "", source: "" },
        tampered: [],
      },
      sealedTimeout: [true],
    });
  });

  it("waits in each item of a loop under that item's keys, each taking its own event", async () => {
    const { source, sealed: withTable } = await generated(
      [
        {
          id: "rounds",
          type: "forEach",
          items: { $expr: '["one", "two"]' },
          do: [
            replyWait({
              id: "each",
              events: "replies",
              eventType: received,
            }),
          ],
        },
      ],
      undefined,
      replies
    );
    const runId = await waitingRun(listening);
    const asked: Asked = [];
    const sent: string[] = [];
    const ran = await ranAs(runId, source, {
      sealed: withTable,
      engine: listeningEngine(
        runId,
        async () => {
          const event = await sendTo(
            listening,
            runId,
            received,
            `round-${sent.length}@acme.test`
          );
          sent.push(event.id);
          return event;
        },
        asked
      ),
    });
    expect({
      ran,
      asked: asked.map(({ step, types }) => ({ step, types })),
      sent: new Set(sent).size,
    }).toStrictEqual({
      ran: { ended: null, tampered: [] },
      asked: [
        { step: "each:task", types: await keysOf(received) },
        { step: "each:task@1", types: await keysOf(received) },
      ],
      sent: 2,
    });
  });

  it("skips a wait whose own `if` doesn't hold, at the top level and in an item, and the next item's wait takes its event", async () => {
    const skipped = await generated(
      [replyWait({ if: { $expr: 'args.who !== "Ada"' } })],
      {
        schema: objectOf({ skipped: { kind: "boolean" } }),
        value: { skipped: { $expr: "reply === null" } },
      },
      replies
    );
    const inItems = await generated(
      [
        {
          id: "rounds",
          type: "forEach",
          items: { $expr: '["skip", "take"]' },
          do: [
            replyWait({
              id: "each",
              if: { $expr: 'item === "take"' },
              events: "replies",
              eventType: received,
            }),
          ],
        },
      ],
      undefined,
      replies
    );
    const topRun = await waitingRun(listening);
    const itemRun = await waitingRun(listening);
    const asked: Asked = [];
    const sent: string[] = [];
    const top = await ranAs(topRun, skipped.source, {
      sealed: skipped.sealed,
      engine: listeningEngine(topRun, nothingSent, asked),
    });
    const items = await ranAs(itemRun, inItems.source, {
      sealed: inItems.sealed,
      engine: listeningEngine(
        itemRun,
        async () => {
          const event = await sendTo(listening, itemRun, received, "ada");
          sent.push(event.id);
          return event;
        },
        asked
      ),
    });
    const loaded = await sealedRunOf(topRun);
    expect({
      top,
      items,
      steps: {
        reply: sealedSteps(loaded, skipped.sealed, "reply"),
        each: sealedSteps(loaded, inItems.sealed, "each"),
      },
      // Only the second item's wait reached the engine, and took its event.
      asked: asked.map(({ step }) => step),
      sent: sent.length,
    }).toStrictEqual({
      top: { ended: { skipped: true }, tampered: [] },
      items: { ended: null, tampered: [] },
      // An `if` is the code's: no step records it.
      steps: { reply: ["task"], each: ["task"] },
      // The first run of `each`, in item 1.
      asked: ["each:task"],
      sent: 1,
    });
  });

  it("fails the run with `workflow.event_denied` once its binding is revoked, a `try` around it or not", async () => {
    const revoked = await eventWorkflow();
    const caught = await generated(
      [{ id: "guarded", type: "try", try: [replyWait()], catch: {} }],
      undefined,
      replies
    );
    const bare = await generated([replyWait()], undefined, replies);
    const caughtRun = await waitingRun(revoked);
    const bareRun = await waitingRun(revoked);
    await revokeWorkflowBinding(
      env,
      revoked.admin,
      revoked.workflow.id,
      revoked.approval.id
    );
    const asked: Asked = [];
    expect({
      caught: await ranAs(caughtRun, caught.source, {
        sealed: caught.sealed,
        engine: listeningEngine(caughtRun, nothingSent, asked),
      }),
      bare: await ranAs(bareRun, bare.source, {
        sealed: bare.sealed,
        engine: listeningEngine(bareRun, nothingSent, asked),
      }),
      // Refused before it waits: the engine is asked for nothing.
      asked,
    }).toStrictEqual({
      // No catch takes it: its catch of everything throws it on, so the
      // run ends with it, never as code that went on past it.
      caught: failedWith("workflow.event_denied"),
      bare: failedWith("workflow.event_denied"),
      asked: [],
    });
  });

  it("replays a wait that took its event as it ran, and fails the replay with `workflow.event_denied` once its binding is revoked, its `try` notwithstanding", async () => {
    const revoked = await eventWorkflow();
    const { source, sealed: withTable } = await generated(
      [{ id: "guarded", type: "try", try: [replyWait()], catch: {} }],
      undefined,
      replies
    );
    const runId = await waitingRun(revoked);
    const journal = new Map<string, Journaled>();
    const taken: Taken = new Map();
    const asked: Asked = [];
    const first = await ranAs(runId, source, {
      sealed: withTable,
      engine: journaledListening(
        listeningEngine(
          runId,
          async () => await sendTo(revoked, runId, received, "ada@acme.test"),
          asked
        ),
        journal,
        taken
      ),
    });
    // Each replay finds the wait's event in the journal: nothing is sent.
    const replay = async (ran: string[]) =>
      await ranAs(runId, source, {
        sealed: withTable,
        engine: journaledListening(
          listeningEngine(runId, nothingSent, asked),
          journal,
          taken,
          ran
        ),
      });
    const ranAgain: string[] = [];
    const replayed = await replay(ranAgain);
    await revokeWorkflowBinding(
      env,
      revoked.admin,
      revoked.workflow.id,
      revoked.approval.id
    );
    const ranRevoked: string[] = [];
    const afterRevoking = await replay(ranRevoked);
    expect({
      first,
      replayed,
      ranAgain,
      afterRevoking,
      ranRevoked,
      // The engine was asked once, by the first run.
      asked: asked.map(({ step }) => step),
    }).toStrictEqual({
      first: { ended: null, tampered: [] },
      replayed: { ended: null, tampered: [] },
      ranAgain: [],
      // The path the run took is gone: its code's catch can't take the
      // failure, so the run ends with it, never on a path it never took.
      afterRevoking: failedWith("workflow.event_denied"),
      ranRevoked: [],
      asked: ["reply:task"],
    });
  });
});

// `inbox.<alias>` on the run host: the run's reply address for event
// binding `replies`, which its mail gives as its Reply-To, sealed as any
// argument the isolate fills in, and the wait on `replies` after it,
// which takes the reply.
describe("a grasp-workflow/2 run's inbox on the run host", () => {
  afterAll(endLiveResourceRuns);

  it("mails its reply address as the Reply-To, and its wait on that binding takes the reply", async () => {
    const replying = await replyingWorkflow();
    const { source, sealed: withTable } = await generated(
      [
        {
          id: "ask",
          type: "call",
          if: { $expr: 'typeof inbox.replies === "string"' },
          connection: "mail",
          action: "mail.send",
          args: {
            to: { $expr: "args.who" },
            subject: { $expr: "inbox.replies" },
          },
        },
        {
          id: "reply",
          type: "waitForEvent",
          events: "replies",
          eventType: replying.replyType,
          timeout: "7 days",
        },
      ],
      {
        schema: objectOf({
          replyTo: { kind: "string" },
          from: { kind: "string" },
          dmarc: { kind: "string" },
        }),
        value: {
          replyTo: { $expr: 'inbox.replies ?? ""' },
          from: {
            $expr: 'reply.timedOut ? "" : reply.event.data.from.address ?? ""',
          },
          dmarc: {
            $expr:
              'reply.timedOut ? "" : reply.event.data.authentication.dmarc?.result ?? ""',
          },
        },
      },
      {
        connections: { mail: { contract: "composio.mail@1" } },
        events: { replies: { contract: "grasp/email-reply" } },
      }
    );
    const runId = await waitingRun(replying);
    const asked: Asked = [];
    const ran = await ranAs(runId, source, {
      sealed: withTable,
      engine: listeningEngine(
        runId,
        async () =>
          await admitRunEvent(env, {
            workflowId: replying.workflow.id,
            runId,
            binding: "replies",
            type: replying.replyType,
            data: replyFrom("ada@acme.test"),
            key: unique(),
            source: "mailto:ada@acme.test",
            sender: "mailto:ada@acme.test",
          }),
        asked
      ),
    });
    const address = z.object({ replyTo: z.string() }).safeParse(ran.ended)
      .data?.replyTo;
    const { sent } = await replying.mail.did();
    expect({
      // The run's own address, as `inbox.replies` read it.
      address: replyAddress.test(address ?? ""),
      // The mail went out with that address, as a Reply-To would carry it.
      mailed: sent,
      ran,
      asked: asked.map(({ step, types }) => ({ step, types })),
    }).toStrictEqual({
      address: true,
      mailed: [{ to: "Ada", subject: address }],
      ran: {
        ended: {
          replyTo: address,
          from: "ada@acme.test",
          dmarc: "pass",
        },
        tampered: [],
      },
      asked: [
        {
          step: "reply:task",
          types: [await eventTypeKey("replies", replying.replyType)],
        },
      ],
    });
  });
});

// What a step keeps in its workflow's state, end to end: written by the
// host from the record of the step that kept it, once that step
// succeeded, and read by the workflow's next run as `state.<key>`, the
// snapshot its start froze. Each test has a workflow of its own, so its
// state starts empty.
describe("a grasp-workflow/2 workflow's state on the run host", () => {
  // Its workflows bind a model, as every sealed workflow does: approved
  // only once the organization has one, whichever tests ran before.
  beforeAll(async () => {
    await connectModels(`test-model-key-${crypto.randomUUID()}`, [
      allowedModel,
    ]);
  });

  afterAll(endLiveResourceRuns);

  it("keeps a step's state once it succeeded, which the next run reads, and nothing of a step its `if` skipped", async () => {
    const kept = await sealedWorkflow();
    await echoingMail(kept.mail.id, "m-1");
    const { source, sealed: withTable } = await generated(
      [
        remember,
        {
          id: "never",
          type: "call",
          if: { $expr: 'args.who === "nobody"' },
          connection: "mail",
          action: "mail.send",
          args: { to: { $expr: "args.who" }, subject: "skipped" },
          state: { never: true },
        },
      ],
      {
        schema: objectOf({
          ...readState.schema.fields,
          never: { kind: "boolean" },
        }),
        value: { ...readState.value, never: { $expr: "state.never ?? false" } },
      }
    );
    const first = await waitingRun(kept);
    const ranFirst = await ranAs(first, source, {
      engine: retryingEngine(),
      sealed: withTable,
    });
    await echoingMail(kept.mail.id, "m-2");
    // Started once the first ended: its start reads what that one kept.
    const second = await waitingRun(kept);
    const ranSecond = await ranAs(second, source, {
      engine: retryingEngine(),
      sealed: withTable,
    });
    const third = await waitingRun(kept);
    const ranThird = await ranAs(third, source, {
      engine: retryingEngine(),
      sealed: withTable,
    });
    expect({ ranFirst, ranSecond, ranThird }).toStrictEqual({
      // The snapshot of its start: nothing kept yet, whatever it keeps.
      ranFirst: {
        ended: {
          last: "none",
          previous: "none",
          runs: 0,
          kind: "none",
          never: false,
        },
        tampered: [],
      },
      // What the first's call answered, what it read then, and its count.
      ranSecond: {
        ended: {
          last: "m-1",
          previous: "none",
          runs: 1,
          kind: "visit",
          never: false,
        },
        tampered: [],
      },
      ranThird: {
        ended: {
          last: "m-2",
          previous: "m-1",
          runs: 2,
          kind: "visit",
          never: false,
        },
        tampered: [],
      },
    });
  });

  it("writes a step's state once, whichever activation replays it or runs it again", async () => {
    const kept = await sealedWorkflow();
    await echoingMail(kept.mail.id, "m-1");
    const { source, sealed: withTable } = await generated(
      [remember],
      readState
    );
    const runId = await waitingRun(kept);
    const journal = new Map<string, Journaled>();
    const ran: string[] = [];
    const first = await ranAs(runId, source, {
      engine: journalingEngine(journal, ran),
      sealed: withTable,
    });
    // A later activation replays the journaled step; one that lost the
    // journal runs it again, its call answering otherwise, its key the
    // same.
    const replayed = await ranAs(runId, source, {
      engine: journalingEngine(journal, ran),
      sealed: withTable,
    });
    await echoingMail(kept.mail.id, "m-2");
    const again = await ranAs(runId, source, {
      engine: retryingEngine(),
      sealed: withTable,
    });
    const next = await waitingRun(kept);
    const read = await ranAs(next, source, {
      engine: retryingEngine(),
      sealed: withTable,
    });
    const nothing = { last: "none", previous: "none", runs: 0, kind: "none" };
    expect({
      first,
      replayed,
      again,
      ran: ran.filter((name) => name.startsWith("remember:")).length,
      writes: await stateWrites(runId),
      // The first write's: the step run again wrote nothing.
      read: read.ended,
    }).toStrictEqual({
      first: { ended: nothing, tampered: [] },
      replayed: { ended: nothing, tampered: [] },
      again: { ended: nothing, tampered: [] },
      ran: 1,
      writes: 1,
      read: { last: "m-1", previous: "none", runs: 1, kind: "visit" },
    });
  });

  it("holds each value to its key's declared schema as the step records it, failing the step and keeping nothing of one that doesn't fit", async () => {
    const kept = await sealedWorkflow();
    await echoingMail(kept.mail.id, "m-1");
    /** `remember`, keeping `state` alone. */
    const keepingOnly = async (state: Record<string, unknown>) =>
      await generated([{ ...remember, state }], {
        schema: objectOf({
          who: { kind: "string" },
          id: { kind: "string" },
          label: { kind: "string" },
        }),
        value: {
          who: { $expr: 'state.who ?? "none"' },
          id: { $expr: 'state.profile?.id ?? "none"' },
          // Typed by the schema's output, `label` filled in: read as such.
          label: { $expr: 'state.badge?.label.toUpperCase() ?? "none"' },
        },
      });
    /** What a run of `state`'s step ended with, and what it wrote. */
    const ranKeeping = async (state: Record<string, unknown>) => {
      const { source, sealed: withTable } = await keepingOnly(state);
      const runId = await waitingRun(kept);
      const ran = await ranAs(runId, source, {
        engine: retryingEngine(),
        sealed: withTable,
      });
      return { ended: ran.ended, writes: await stateWrites(runId) };
    };
    const refused = {
      // What the mail answered is text: `runs` is an integer.
      notInteger: await ranKeeping({ runs: { $expr: "output.messageId" } }),
      // Not a reference to a person: it has a space.
      notPerson: await ranKeeping({ who: { $expr: '"not " + "a person"' } }),
      // A closed object with a key it doesn't declare, never stripped.
      extraKey: await ranKeeping({
        profile: { $expr: "({ id: output.messageId, extra: 1 })" },
      }),
    };
    const fits = await ranKeeping({
      who: "user_1",
      profile: { $expr: "({ id: output.messageId })" },
      badge: {},
    });
    const { source, sealed: withTable } = await keepingOnly({});
    const next = await waitingRun(kept);
    const read = await ranAs(next, source, {
      engine: retryingEngine(),
      sealed: withTable,
    });
    // Each call took effect before its record failed.
    const failed = { ended: "workflow.failed_after_effect", writes: 0 };
    expect({ refused, fits, read: read.ended }).toStrictEqual({
      refused: { notInteger: failed, notPerson: failed, extraKey: failed },
      // The one that fits: read back as it was kept, its defaults filled in.
      fits: { ended: { who: "none", id: "none", label: "none" }, writes: 1 },
      read: { who: "user_1", id: "m-1", label: "UNKNOWN" },
    });
  });

  it("reads a value an older version kept under another schema as never kept, which the version that kept it still reads", async () => {
    const kept = await sealedWorkflow();
    /** A version keeping `value` as `count` of `schema`, ending with what it read. */
    const version = async (schema: Record<string, unknown>, value: unknown) =>
      await generated(
        [{ ...remember, state: { count: value } }],
        {
          schema: objectOf({ read: { kind: "string" } }),
          value: { read: { $expr: "typeof state.count" } },
        },
        declared.permissions,
        { count: schema }
      );
    const v1 = await version({ kind: "string" }, "many");
    const v2 = await version({ kind: "number" }, 3);
    const runOf = async (built: Awaited<ReturnType<typeof generated>>) => {
      const runId = await waitingRun(kept);
      const ran = await ranAs(runId, built.source, {
        engine: retryingEngine(),
        sealed: built.sealed,
      });
      return ran.ended;
    };
    const wrote = await runOf(v1);
    const again = await runOf(v1);
    // v2 declares a number: the string v1 kept reads as never kept.
    const newer = await runOf(v2);
    expect({ wrote, again, newer }).toStrictEqual({
      wrote: { read: "undefined" },
      again: { read: "string" },
      newer: { read: "undefined" },
    });
  });

  it("keeps state from a step in each item of a loop, the last item's last", async () => {
    const kept = await sealedWorkflow();
    const { source, sealed: withTable } = await generated(
      [
        {
          id: "rows",
          type: "forEach",
          items: { $expr: "args.rows" },
          do: [
            {
              ...remember,
              args: { to: { $expr: "item" }, subject: "row" },
              state: { last: { $expr: "item" } },
            },
          ],
        },
      ],
      {
        schema: objectOf({ last: { kind: "string" } }),
        value: { last: { $expr: 'state.last ?? "none"' } },
      },
      declared.permissions,
      declared.state,
      rowsOf({ kind: "string" })
    );
    const withRows = (run: HostedSealedRun) =>
      withTable({ ...run, input: { rows: ["a", "b", "c"] } });
    const first = await waitingRun(kept);
    const ranFirst = await ranAs(first, source, {
      engine: retryingEngine(),
      sealed: withRows,
    });
    const second = await waitingRun(kept);
    const ranSecond = await ranAs(second, source, {
      engine: retryingEngine(),
      sealed: withRows,
    });
    expect({
      ranFirst,
      writes: await stateWrites(first),
      ranSecond,
    }).toStrictEqual({
      ranFirst: { ended: { last: "none" }, tampered: [] },
      // Each item's step writes under its own key.
      writes: 3,
      ranSecond: { ended: { last: "c" }, tampered: [] },
    });
  });
});

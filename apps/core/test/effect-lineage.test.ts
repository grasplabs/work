import { quotaLimitsSchema } from "@grasp-os/shared/quota-policy";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import worker from "../src/index.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { consentCode, graphSentUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { endLiveRuns, finished } from "./runs.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { routed, signedInApi } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";
import { appWith, server } from "./workflow-apps.ts";

// The runs a run's own mail starts, as its descendants: mail it sends
// through a native mail connector to its App's own address starts its
// run under it, held to its lineage's nesting and descendant limits
// (mail-stamps.ts). The ways it can fail come first: a workflow that
// mails itself runs without end, each run a new root; a run's retry
// carries another token, and its side effect is refused; a customer's
// reply is taken for the run's own mail, deduplicated away or charged to
// its lineage; a token taken to another address attaches a run to the
// lineage; a refusal is retried without end, or dropped unheard; two
// deliveries of one message both take a slot. Runs, connect, the engine
// and core's database are real; Microsoft Graph and Email Routing are
// the tests' (test/connect-providers.ts, `deliver`).

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

/** Each policy a test sets, under a generation higher than any before. */
let generations = 1000;

/** The limits the tests' deployment sets (vite.config.ts). */
const configuredLimits = quotaLimitsSchema.parse(env.QUOTA_LIMITS).limits;

/** What `run` returns, with the operator's quota policy `limits` in force. */
const withQuotas = async <Result>(
  limits: Record<string, number>,
  run: () => Promise<Result>
): Promise<Result> => {
  generations += 1;
  env.QUOTA_LIMITS = { generation: generations, limits };
  try {
    return await run();
  } finally {
    generations += 1;
    env.QUOTA_LIMITS = { generation: generations, limits: configuredLimits };
  }
};

/** The shared mailbox an App at `local` may send as. */
const sharedMailbox = (local: string) => `shared-${local}@acme.test`;

/** How the `loop` workflow's step, of an App at `local`, sends its mail. */
const sends = (local: string) =>
  ({
    // Through the run's own connection.
    direct: `return JSON.parse((await env.MAIL.call("mail.send", mail, { idempotencyKey })).output);`,
    // Twice under its key, as a retry would: connect answers the second
    // only when it is the same call.
    twice: `await env.MAIL.call("mail.send", mail, { idempotencyKey });
      return JSON.parse((await env.MAIL.call("mail.send", mail, { idempotencyKey })).output);`,
    // Through its App's server code, with its caller's key.
    app: `return await env.APP.call("relay", mail);`,
    // Sends from its account, and drafts the same from a shared mailbox.
    draft: `await env.MAIL.call("mail.send", mail, { idempotencyKey });
      return JSON.parse((await env.MAIL.call("mail.createDraft", { ...mail, mailbox: "${sharedMailbox(local)}" }, { idempotencyKey })).output);`,
    // The same mail as the same shared mailbox, through two connections.
    both: `await env.MAIL.call("mail.send", { ...mail, mailbox: "${sharedMailbox(local)}" }, { idempotencyKey });
      return JSON.parse((await env.MAIL2.call("mail.send", { ...mail, mailbox: "${sharedMailbox(local)}" }, { idempotencyKey })).output);`,
    // Lists mail naming another address of the domain, then sends.
    list: `try {
        await env.MAIL.call("mail.list", { mailbox: mail.mailbox, to: ["other-${local}@grasp.test"] }, { idempotencyKey });
      } catch {
        // The connector refuses the field; the call was made.
      }
      return JSON.parse((await env.MAIL.call("mail.send", mail, { idempotencyKey })).output);`,
    // To 26 addresses of the domain at once.
    many: `return JSON.parse((await env.MAIL.call("mail.send", { ...mail, to: Array.from({ length: 26 }, (_, index) => "${local}-" + index + "@grasp.test") }, { idempotencyKey })).output);`,
  }) as const;

type Sends = keyof ReturnType<typeof sends>;

/** A workflow that receives mail at `local` too, and only reads it. */
const listen = (local: string): Record<string, string> => ({
  "workflows/listen.ts": `import { emailMessage, workflow } from "@grasp-os/sdk/workflow";

export default workflow(
  "listen",
  { params: {}, input: emailMessage, triggers: [{ type: "email", address: "${local}" }] },
  async (step, { input }) => await step.do("read", { description: "Read it" }, async () => input.id)
);
`,
  "workflows/listen.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./listen.ts";

const input = { id: "m", stored: null, from: { name: "", address: "a@b.test" }, to: [], cc: [], subject: "", date: null, text: "", truncated: false, attachments: [] };

export default workflowTests(definition, [{ name: "runs", input, mocks: { read: null }, expect: { output: null } }]);
`,
});

/** The App's server: the sample's, and `relay`, which sends `mail`. */
const relayServer = server.replace(
  "export class App extends DurableObject {",
  `export class App extends DurableObject {
  async relay(caller: Caller, mail: unknown): Promise<unknown> {
    const { output } = await (this.env as any).MAIL.call(caller, "mail.send", mail, { idempotencyKey: caller.idempotencyKey });
    return JSON.parse(output);
  }
`
);

/**
 * The `loop` workflow, receiving mail at `local`: from `mailbox`, it mails
 * the address the message came to, with the same subject, its Reply-To
 * the workflow's own address, as `send` says.
 */
const loop = (
  local: string,
  mailbox: string,
  send: Sends
): Record<string, string> => ({
  "workflows/loop.ts": `import { emailMessage, workflow } from "@grasp-os/sdk/workflow";

export default workflow(
  "loop",
  { params: {}, input: emailMessage, triggers: [{ type: "email", address: "${local}" }] },
  async (step, { env, input }) =>
    await step.do(
      "send",
      { description: "Mail the address again", sideEffect: true, retries: { limit: 0 }, input: { mailbox: "${mailbox}", subject: input.subject, body: "Again.", to: [input.to[0]?.address ?? ""], replyTo: ["${local}@grasp.test"] } },
      async ({ idempotencyKey, input: mail }) => {
      ${sends(local)[send]}
      }
    )
);
`,
  "workflows/loop.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./loop.ts";

const input = { id: "m", stored: null, from: { name: "", address: "a@b.test" }, to: [{ name: "", address: "loop@b.test" }], cc: [], subject: "", date: null, text: "", truncated: false, attachments: [] };

export default workflowTests(definition, [{ name: "runs", input, mocks: { send: { sent: true } }, expect: {} }]);
`,
  "app/server.ts": relayServer,
});

/**
 * A shared Microsoft 365 account `admin` connects: its ID, its mailbox as
 * its sign-in name, and the address it sends from. An `aliased` account's
 * sign-in name (a UPN) isn't that address.
 */
const connectShared = async (admin: Person, aliased = false) => {
  const subject = `${aliased ? "alias" : "team"}-${crypto.randomUUID()}`;
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
  const sender = `${subject}@acme.test`;
  const mailbox = aliased ? `${subject}@acme.onmicrosoft.test` : sender;
  const listed = await admin.api.connections.list();
  const connection = listed.find(({ accountName }) => accountName === mailbox);
  if (connection === undefined) {
    throw new Error("Expected the shared connection");
  }
  return { id: connection.id, mailbox, sender };
};

/**
 * An App with the `loop` workflow at an address of its own, sending as
 * `send` says through a shared Microsoft 365 connection of its own
 * (`MAIL`, allowing `actions`), and through a second one (`MAIL2`) for
 * `both`; with the `listen` workflow at the same address when asked.
 */
const loopApp = async (
  admin: Person,
  send: Sends = "direct",
  {
    actions = ["mail.send"],
    listening = false,
    aliased = false,
    files = (_local: string, _mailbox: string): Record<string, string> => ({}),
  } = {}
) => {
  const local = `loop-${crypto.randomUUID().slice(0, 8)}`;
  const connection = await connectShared(admin, aliased);
  const app = await appWith(admin, {
    ...loop(local, connection.mailbox, send),
    ...(listening ? listen(local) : {}),
    ...files(local, connection.mailbox),
  });
  await requestGranted(idp, admin, {
    subject: { type: "app", appId: app },
    object: { type: "connection", connectionId: connection.id },
    actions,
    binding: "MAIL",
  });
  if (send === "both") {
    const second = await connectShared(admin);
    await requestGranted(idp, admin, {
      subject: { type: "app", appId: app },
      object: { type: "connection", connectionId: second.id },
      actions,
      binding: "MAIL2",
    });
  }
  return {
    app,
    local,
    mailbox: connection.mailbox,
    sender: connection.sender,
    address: `${local}@grasp.test`,
  };
};

/** A plain message to `to`, as it goes over the wire. */
const message = (
  to: string,
  { from, subject }: { from: string; subject: string }
): string =>
  [
    `Message-ID: <${crypto.randomUUID()}@acme.test>`,
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "Date: Mon, 12 Oct 2026 08:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello.",
    "",
  ].join("\r\n");

/**
 * Delivers `raw` from `from` to `to`, as Email Routing does: the reason it
 * was rejected with, if it was. A delivery that fails for now throws.
 */
const deliver = async (
  to: string,
  raw: string,
  from = "bounces@acme.test"
): Promise<string | undefined> => {
  const bytes = new TextEncoder().encode(raw);
  let rejected: string | undefined;
  await worker.email(
    {
      from,
      to,
      raw: new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      headers: new Headers(),
      rawSize: bytes.byteLength,
      setReject: (reason) => {
        rejected = reason;
      },
      forward: async () => await Promise.reject(new Error("Never forwards")),
      reply: async () => await Promise.reject(new Error("Never replies")),
    },
    env
  );
  return rejected;
};

const sentSchema = z.array(
  z.object({
    mailbox: z.string(),
    subject: z.string(),
    to: z.array(z.string()),
    replyTo: z.array(z.string()),
    draft: z.boolean().optional(),
  })
);

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** The mail Graph sent with `subject`, in order. */
const sentWith = async (subject: string) => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  const response = await providers.fetch(graphSentUrl);
  return sentSchema
    .parse(await response.json())
    .filter((sent) => sent.subject === subject);
};

/** The address the `hop`th mail with `subject` went to, once it went. */
const sentTo = async (subject: string, hop: number): Promise<string> =>
  await vi.waitFor(
    async () => {
      const sent = await sentWith(subject);
      const to = sent[hop]?.to[0];
      expect(to).toBeDefined();
      return to ?? "";
    },
    { timeout: 20_000, interval: 200 }
  );

const startedSchema = z.object({ parent: z.string().optional() });

/** The App's runs as they started, each with the run it started under. */
const startedRuns = async (app: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, detail }) =>
        action === "workflow.run.started" && detail.app === app
    )
    .map(({ target, detail }) => ({
      id: target?.id ?? "",
      ...startedSchema.parse(detail),
    }));
};

/** Where each of the App's runs sits: a root, or under the run before. */
const placesOf = async (app: string): Promise<string[]> => {
  const started = await startedRuns(app);
  const ids = new Set(started.map(({ id }) => id));
  return started.map(({ parent }) => {
    if (parent === undefined) {
      return "root";
    }
    return ids.has(parent) ? "child" : "other";
  });
};

/** The App's runs, once there are `count` and every one has ended. */
const runsEnded = async (builder: Person, app: string, count: number) => {
  const runs = await vi.waitFor(
    async () => {
      const listed = await builder.api.workflows.list(app);
      expect(listed).toHaveLength(count);
      return listed;
    },
    { timeout: 20_000, interval: 200 }
  );
  await Promise.all(
    runs.map(async ({ id }) => {
      await finished(id);
    })
  );
  return runs;
};

/** The App's refusals of its mail, each as its reason and limit. */
const refusals = async (app: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target }) =>
        action === "workflow.email.refused" && target?.id === app
    )
    .map(({ detail }) => [detail.reason, detail.limit]);
};

/** What a refused child's message bounces with. */
const bounced =
  "This message would start a workflow run past the limits of the run that sent it.";

/** An address `local` with a token on it. */
const tokenedAt = (local: string) =>
  new RegExp(`^${local}\\+[0-9a-f]{26}@grasp\\.test$`, "u");

/**
 * Mails the App as a customer, then delivers each mail its runs send, as
 * its provider and Email Routing would, `hops` times: what each delivery
 * was rejected with.
 */
const followHops = async (
  admin: Person,
  { app, address, sender }: Awaited<ReturnType<typeof loopApp>>,
  subject: string,
  hops: number
): Promise<(string | undefined)[]> => {
  const rejected = [
    await deliver(
      address,
      message(address, { from: "ann@acme.test", subject })
    ),
  ];
  for (let hop = 1; hop <= hops; hop += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one hop after another
    await runsEnded(admin, app, hop);
    // oxlint-disable-next-line no-await-in-loop -- one hop after another
    const to = await sentTo(subject, hop - 1);
    rejected.push(
      // oxlint-disable-next-line no-await-in-loop -- one hop after another
      await deliver(to, message(to, { from: sender, subject }), sender)
    );
  }
  return rejected;
};

/**
 * The Relay App, receiving mail at `local`: its workflow mails the
 * address the message came to through the App's `relay` action, whose
 * connector resource sends from `mailbox` on Microsoft 365.
 */
const relayFiles = (
  local: string,
  mailbox: string
): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({ notes: defineTable({ title: v.string() }) });
`,
  "operations/mail.ts": `import { resource, v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const mail = resource.connector("mail", {
  contract: "microsoft-365.mail@1",
  actions: ["send"],
});

export const relay = action({
  args: { to: v.string().min(1), subject: v.string() },
  returns: v.boolean(),
  uses: [mail],
  handler: async (ctx, args) => {
    const sent = await ctx.resources.mail.call("send", {
      mailbox: "${mailbox}",
      subject: args.subject,
      body: "Again.",
      to: [args.to],
    });
    return typeof sent === "object" && sent !== null && Reflect.get(sent, "sent") === true;
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { mail, relay } from "./operations/mail.ts";
import schema from "./schema.ts";

export default app({
  name: "Relay",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { mail: { relay } },
  internalOperations: {},
  screens: [],
  uses: [mail],
});
`,
  "workflows/loop.ts": `import { emailMessage, workflow } from "@grasp-os/sdk/workflow";

export default workflow(
  "loop",
  { params: {}, input: emailMessage, triggers: [{ type: "email", address: "${local}" }] },
  async (step, { env, input }) =>
    await step.do("send", { description: "Mail the address again", sideEffect: true, retries: { limit: 0 }, input: null }, async () =>
      await env.APP.callFunction({ contractId: "mail.relay", kind: "action" }, { to: input.to[0]?.address ?? "", subject: input.subject })
    )
);
`,
  "workflows/loop.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./loop.ts";

const input = { id: "m", stored: null, from: { name: "", address: "a@b.test" }, to: [{ name: "", address: "loop@b.test" }], cc: [], subject: "", date: null, text: "", truncated: false, attachments: [] };

export default workflowTests(definition, [{ name: "runs", input, mocks: { send: null }, expect: {} }]);
`,
});

/** The tokens core recorded for `run`'s mail. */
const stampsOf = async (run: string): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS stamps FROM run_mail_stamps WHERE run_id = ?"
  )
    .bind(run)
    .first<{ stamps: number }>();
  return row?.stamps ?? 0;
};

/** Seeds `count` runs of the App's `workflow` from mail in the past hour. */
const seedHour = async (app: string, workflow: string, count: number) => {
  const now = Date.now();
  await env.DB.batch(
    Array.from({ length: count }, (_, index) =>
      env.DB.prepare(
        "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at, trigger_key) VALUES (?, ?, ?, 1, NULL, 'completed', ?, ?, ?)"
      ).bind(
        crypto.randomUUID(),
        app,
        workflow,
        now - index * 1000,
        now,
        `email:${app}:${workflow}:seeded-${index}`
      )
    )
  );
};

/** What `delivery` threw, or `ok`. */
const outcomeOf = async (
  delivery: Promise<string | undefined>
): Promise<string> => {
  try {
    return (await delivery) ?? "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/**
 * The `fresh` workflow: from `mailbox`, it mails `to` with `subject`,
 * then runs its step's first attempt out of time, so its retry, five
 * seconds on, makes the same call again under its key.
 */
const fresh = (
  mailbox: string,
  to: string,
  subject: string
): Record<string, string> => ({
  "workflows/fresh.ts": `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("fresh", { params: {}, input: z.unknown() }, async (step, { env }) =>
  await step.do(
    "send",
    { description: "Mail a new domain", sideEffect: true, timeout: "1 second", retries: { limit: 1, delay: "5 seconds" }, input: { mailbox: "${mailbox}", subject: "${subject}", body: "Hi.", to: ["${to}"] } },
    async ({ idempotencyKey, input: mail }) => {
      await env.MAIL.call("mail.send", mail, { idempotencyKey });
      if ((await env.APP.call("hit", "${subject}")) === 1) {
        // Runs out of time, so the step is tried again.
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      return "sent";
    }
  )
);
`,
  "workflows/fresh.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./fresh.ts";

export default workflowTests(definition, [{ name: "runs", mocks: { send: "sent" }, expect: {} }]);
`,
});

describe("runs a run's own mail starts", { timeout: 120_000 }, () => {
  afterEach(endLiveRuns);

  it("join its lineage, until its descendant limit bounces one", async () => {
    await withQuotas(
      { ...configuredLimits, workflowDescendantRuns: 2 },
      async () => {
        const admin = await personApi("admin");
        const looping = await loopApp(admin);
        const subject = `Ping ${crypto.randomUUID()}`;

        const rejected = await followHops(admin, looping, subject, 3);
        const sent = await sentWith(subject);

        expect({
          rejected,
          // Only its recipients carry a token, each its own; its Reply-To
          // none.
          to: sent.map(({ to }) =>
            to.every((address) => tokenedAt(looping.local).test(address))
          ),
          tokens: new Set(sent.flatMap(({ to }) => to)).size,
          replyTo: sent.map(({ replyTo }) => replyTo),
          places: await placesOf(looping.app),
          refused: await refusals(looping.app),
        }).toStrictEqual({
          rejected: [undefined, undefined, undefined, bounced],
          to: [true, true, true],
          tokens: 3,
          replyTo: [[looping.address], [looping.address], [looping.address]],
          places: ["root", "child", "child"],
          refused: [["lineage_limit", "descendants"]],
        });
      }
    );
  });

  it("join its lineage from an account whose sign-in name isn't the address it sends from", async () => {
    const admin = await personApi("admin");
    // Its mailbox named by its UPN, as Graph allows; Graph sends from its
    // primary address, the envelope sender its mail arrives from.
    const looping = await loopApp(admin, "direct", { aliased: true });
    const subject = `Ping ${crypto.randomUUID()}`;

    const rejected = await followHops(admin, looping, subject, 1);
    await runsEnded(admin, looping.app, 2);

    expect({
      senders: [looping.mailbox, looping.sender],
      rejected,
      places: await placesOf(looping.app),
    }).toStrictEqual({
      senders: [
        looping.sender.replace("@acme.test", "@acme.onmicrosoft.test"),
        looping.sender,
      ],
      rejected: [undefined, undefined],
      places: ["root", "child"],
    });
  });

  it("stop at its nesting limit", async () => {
    await withQuotas(
      { ...configuredLimits, workflowNestingLevels: 2 },
      async () => {
        const admin = await personApi("admin");
        const looping = await loopApp(admin);
        const subject = `Ping ${crypto.randomUUID()}`;

        const rejected = await followHops(admin, looping, subject, 2);

        expect({
          rejected,
          places: await placesOf(looping.app),
          refused: await refusals(looping.app),
        }).toStrictEqual({
          rejected: [undefined, undefined, bounced],
          places: ["root", "child"],
          refused: [["lineage_limit", "nesting"]],
        });
      }
    );
  });

  it("carry the same token each time their step calls again under its key", async () => {
    const admin = await personApi("admin");
    const looping = await loopApp(admin, "twice");
    const subject = `Ping ${crypto.randomUUID()}`;

    await deliver(
      looping.address,
      message(looping.address, { from: "ann@acme.test", subject })
    );
    const [run] = await runsEnded(admin, looping.app, 1);
    const { status } = await admin.api.workflows.status(run?.id ?? "");

    const sent = await sentWith(subject);

    expect({
      status,
      sent: sent.map(({ to }) =>
        to.map((address) => tokenedAt(looping.local).test(address))
      ),
    }).toStrictEqual({ status: "completed", sent: [[true]] });
  });

  it("join its lineage when it sends through its App's server code", async () => {
    const admin = await personApi("admin");
    const looping = await loopApp(admin, "app");
    const subject = `Ping ${crypto.randomUUID()}`;

    const rejected = await followHops(admin, looping, subject, 1);
    await runsEnded(admin, looping.app, 2);

    expect({ rejected, places: await placesOf(looping.app) }).toStrictEqual({
      rejected: [undefined, undefined],
      places: ["root", "child"],
    });
  });

  it("are only the run's own: replies, a token on another address and a made-up token start roots, never deduplicated", async () => {
    const admin = await personApi("admin");
    const looping = await loopApp(admin);
    const other = await loopApp(admin);
    const subject = `Ping ${crypto.randomUUID()}`;

    await deliver(
      looping.address,
      message(looping.address, { from: "ann@acme.test", subject })
    );
    await runsEnded(admin, looping.app, 1);
    const to = await sentTo(subject, 0);
    const token = to.slice(looping.local.length + 1, to.indexOf("@"));
    const elsewhere = `${other.local}+${token}@grasp.test`;
    const madeUp = `${looping.local}+${"0".repeat(26)}@grasp.test`;
    const reply = { from: "carol@customer.test", subject: `Re: ${subject}` };

    const rejected = {
      // A customer answers all of the run's mail, twice.
      replyAll: [
        await deliver(to, message(to, reply), reply.from),
        await deliver(to, message(to, reply), reply.from),
      ],
      // And to its Reply-To.
      replyTo: await deliver(
        looping.address,
        message(looping.address, reply),
        reply.from
      ),
      // The run's sender, with its token on another App's address.
      elsewhere: await deliver(
        elsewhere,
        message(elsewhere, { from: looping.mailbox, subject }),
        looping.mailbox
      ),
      madeUp: await deliver(
        madeUp,
        message(madeUp, { from: looping.mailbox, subject }),
        looping.mailbox
      ),
    };
    await runsEnded(admin, looping.app, 4);
    await runsEnded(admin, other.app, 1);

    expect({
      rejected,
      places: await placesOf(looping.app),
      elsewhere: await placesOf(other.app),
    }).toStrictEqual({
      rejected: {
        replyAll: [undefined, undefined],
        replyTo: undefined,
        elsewhere: undefined,
        madeUp: "No such address.",
      },
      places: ["root", "root", "root", "root"],
      elsewhere: ["root"],
    });
  });

  it("aren't stamped through a Composio toolkit, which core can't tell sends from reads of", async () => {
    const admin = await personApi("admin");
    const looping = await loopApp(admin);
    const subject = `Ping ${crypto.randomUUID()}`;
    // Teaches core the mail domain.
    await deliver(
      looping.address,
      message(looping.address, { from: "ann@acme.test", subject })
    );
    const composio = await mailConnection();
    const app = await appWith(admin, {
      "workflows/mailer.ts": `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow("mailer", { params: {}, input: z.unknown() }, async (step, { env }) =>
  await step.do("send", { description: "Send", sideEffect: true, input: { to: "${looping.address}", subject: "Hi" } }, async ({ idempotencyKey, input }) =>
    JSON.parse((await env.MAIL.call("mail.send", input, { idempotencyKey })).output)
  )
);
`,
      "workflows/mailer.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./mailer.ts";

export default workflowTests(definition, [{ name: "runs", mocks: { send: null }, expect: {} }]);
`,
    });
    await requestGranted(idp, admin, {
      subject: { type: "app", appId: app },
      object: { type: "connection", connectionId: composio.id },
      actions: ["mail.send"],
      binding: "MAIL",
    });

    const run = await admin.api.workflows.start(app, "mailer");
    await finished(run.id);

    const { sent } = await composio.did();

    expect(sent.map(({ to }) => to)).toStrictEqual([looping.address]);
  });

  it("take one slot of the lineage for one run, however its message is delivered again", async () => {
    await withQuotas(
      { ...configuredLimits, workflowDescendantRuns: 2 },
      async () => {
        const admin = await personApi("admin");
        const looping = await loopApp(admin);
        const subject = `Ping ${crypto.randomUUID()}`;
        const fromRun = { from: looping.mailbox, subject };

        await deliver(
          looping.address,
          message(looping.address, { from: "ann@acme.test", subject })
        );
        await runsEnded(admin, looping.app, 1);
        const first = await sentTo(subject, 0);
        const firstMail = message(first, fromRun);
        // Two deliveries of the root's mail at once: one run.
        const atOnce = await Promise.all([
          deliver(first, firstMail, looping.mailbox),
          deliver(first, firstMail, looping.mailbox),
        ]);
        await runsEnded(admin, looping.app, 2);
        // That run's mail: the lineage's second slot, still there.
        const second = await sentTo(subject, 1);
        const secondMail = message(second, fromRun);
        const next = await deliver(second, secondMail, looping.mailbox);
        await runsEnded(admin, looping.app, 3);
        // Its message again, with the lineage at its limit: its run, not a
        // refusal.
        const again = await deliver(second, secondMail, looping.mailbox);

        expect({
          atOnce,
          next,
          again,
          places: await placesOf(looping.app),
        }).toStrictEqual({
          atOnce: [undefined, undefined],
          next: undefined,
          again: undefined,
          places: ["root", "child", "child"],
        });
      }
    );
  });

  it("are each new message from the run's own mailbox, and a message delivered again is one run", async () => {
    const admin = await personApi("admin");
    const looping = await loopApp(admin);
    const subject = `Ping ${crypto.randomUUID()}`;

    await deliver(
      looping.address,
      message(looping.address, { from: "ann@acme.test", subject })
    );
    await runsEnded(admin, looping.app, 1);
    const to = await sentTo(subject, 0);
    const fromRun = { from: looping.mailbox, subject };
    const first = message(to, fromRun);
    // Two messages from the run's mailbox (a person answering all from
    // it, say), the first delivered again.
    const rejected = [
      await deliver(to, first, looping.mailbox),
      await deliver(to, message(to, fromRun), looping.mailbox),
      await deliver(to, first, looping.mailbox),
      // A From that says the run's mailbox, from another envelope sender.
      await deliver(to, message(to, fromRun), "mallory@evil.test"),
    ];
    await runsEnded(admin, looping.app, 4);

    expect({ rejected, places: await placesOf(looping.app) }).toStrictEqual({
      rejected: [undefined, undefined, undefined, undefined],
      places: ["root", "child", "child", "root"],
    });
  });

  it("carry a token of their own for each mailbox and connection a step sends from", async () => {
    const admin = await personApi("admin");
    const drafting = await loopApp(admin, "draft", {
      actions: ["mail.send", "mail.createDraft"],
    });
    const twoWays = await loopApp(admin, "both");
    const subject = `Ping ${crypto.randomUUID()}`;

    for (const { address } of [drafting, twoWays]) {
      // oxlint-disable-next-line no-await-in-loop -- one App after another
      await deliver(
        address,
        message(address, { from: "ann@acme.test", subject })
      );
    }
    await runsEnded(admin, drafting.app, 1);
    await runsEnded(admin, twoWays.app, 1);
    const sent = await sentWith(subject);
    const toOf = (local: string, draft: boolean) =>
      sent
        .filter(
          ({ to, draft: isDraft }) =>
            (isDraft ?? false) === draft &&
            to.some((address) => address.startsWith(`${local}+`))
        )
        .flatMap(({ to }) => to);
    const [sentByAccount] = toOf(drafting.local, false);
    const [drafted] = toOf(drafting.local, true);
    const viaBoth = toOf(twoWays.local, false);
    // The draft, once a person sends it from the shared mailbox.
    const fromShared = await deliver(
      drafted ?? "",
      message(drafted ?? "", { from: sharedMailbox(drafting.local), subject }),
      sharedMailbox(drafting.local)
    );
    await runsEnded(admin, drafting.app, 2);

    expect({
      draftOwn: sentByAccount !== undefined && sentByAccount !== drafted,
      viaBoth: { mails: viaBoth.length, tokens: new Set(viaBoth).size },
      fromShared,
      places: await placesOf(drafting.app),
    }).toStrictEqual({
      draftOwn: true,
      viaBoth: { mails: 2, tokens: 2 },
      fromShared: undefined,
      places: ["root", "child"],
    });
  });

  it("are stamped only for a send or a draft, and a call to too many addresses of the domain is refused", async () => {
    const admin = await personApi("admin");
    const listing = await loopApp(admin, "list", {
      actions: ["mail.send", "mail.list"],
    });
    const many = await loopApp(admin, "many");
    const subject = `Ping ${crypto.randomUUID()}`;

    for (const { address } of [listing, many]) {
      // oxlint-disable-next-line no-await-in-loop -- one App after another
      await deliver(
        address,
        message(address, { from: "ann@acme.test", subject })
      );
    }
    const [listed] = await runsEnded(admin, listing.app, 1);
    const [refused] = await runsEnded(admin, many.app, 1);
    const sent = await sentWith(subject);
    const { status } = await admin.api.workflows.status(refused?.id ?? "");

    expect({
      // The send's token only, not the list's.
      stamps: await stampsOf(listed?.id ?? ""),
      refused: status,
      sentToMany: sent.filter(({ to }) => to.length > 1).length,
    }).toStrictEqual({ stamps: 1, refused: "failed", sentToMany: 0 });
  });

  it("join its lineage when it sends through a connector resource", async () => {
    const admin = await personApi("admin");
    const local = `relay-${crypto.randomUUID().slice(0, 8)}`;
    const connection = await connectShared(admin);
    const app = await appWith(admin, relayFiles(local, connection.mailbox));
    const permissionId = await requestGranted(idp, admin, {
      subject: { type: "app", appId: app },
      object: { type: "connection", connectionId: connection.id },
      actions: ["mail.send"],
      binding: "MAIL",
    });
    await admin.api.resourceBindings.approve({
      app,
      alias: "mail",
      target: { kind: "connector", permissionId },
      reviewed: { version: 1 },
    });
    const subject = `Ping ${crypto.randomUUID()}`;

    const rejected = await followHops(
      admin,
      {
        app,
        local,
        mailbox: connection.mailbox,
        sender: connection.sender,
        address: `${local}@grasp.test`,
      },
      subject,
      1
    );
    await runsEnded(admin, app, 2);

    expect({ rejected, places: await placesOf(app) }).toStrictEqual({
      rejected: [undefined, undefined],
      places: ["root", "child"],
    });
  });

  it("fail for now, not bounce, when the lineage refuses one workflow and another starts", async () => {
    await withQuotas(
      { ...configuredLimits, workflowDescendantRuns: 1 },
      async () => {
        const admin = await personApi("admin");
        const looping = await loopApp(admin, "direct", { listening: true });
        const subject = `Ping ${crypto.randomUUID()}`;

        await deliver(
          looping.address,
          message(looping.address, { from: "ann@acme.test", subject })
        );
        await runsEnded(admin, looping.app, 2);
        const to = await sentTo(subject, 0);
        // `loop` and `listen` both, under the root: room for one.
        const outcome = await outcomeOf(
          deliver(
            to,
            message(to, { from: looping.mailbox, subject }),
            looping.mailbox
          )
        );
        await runsEnded(admin, looping.app, 3);

        expect({
          outcome: outcome.includes("past a lineage's limits"),
          places: await placesOf(looping.app),
        }).toStrictEqual({
          outcome: true,
          places: ["root", "root", "child"],
        });
      }
    );
  });

  it("fail for now, not bounce, when the lineage refuses one workflow and another is at its hourly limit", async () => {
    await withQuotas(
      { ...configuredLimits, workflowNestingLevels: 1 },
      async () => {
        const admin = await personApi("admin");
        const looping = await loopApp(admin, "direct", { listening: true });
        const subject = `Ping ${crypto.randomUUID()}`;

        await deliver(
          looping.address,
          message(looping.address, { from: "ann@acme.test", subject })
        );
        await runsEnded(admin, looping.app, 2);
        const to = await sentTo(subject, 0);
        // `listen` at its hour's 60; `loop` a level too deep.
        await seedHour(looping.app, "listen", 60);
        const outcome = await outcomeOf(
          deliver(
            to,
            message(to, { from: looping.mailbox, subject }),
            looping.mailbox
          )
        );

        expect({
          outcome: outcome.includes("over a workflow's hourly limit"),
          refused: await refusals(looping.app),
        }).toStrictEqual({
          outcome: true,
          refused: [["lineage_limit", "nesting"]],
        });
      }
    );
  });

  it("send the same input when their step calls again after core learned its mail domain", async () => {
    const admin = await personApi("admin");
    const domain = `fresh-${crypto.randomUUID().slice(0, 8)}.test`;
    const subject = `Fresh ${crypto.randomUUID()}`;
    const looping = await loopApp(admin, "direct", {
      files: (local, mailbox) => fresh(mailbox, `${local}@${domain}`, subject),
    });
    const to = `${looping.local}@${domain}`;

    const run = await admin.api.workflows.start(looping.app, "fresh");
    // Its first attempt has sent, to a domain core doesn't know yet.
    await sentTo(subject, 0);
    // Mail for the domain arrives: core knows it now.
    await deliver(to, message(to, { from: "ann@acme.test", subject: "Hi" }));
    await finished(run.id);
    const { status } = await admin.api.workflows.status(run.id);
    const sent = await sentWith(subject);

    expect({
      status,
      sent: sent.map(({ to: address }) => address),
    }).toStrictEqual({
      status: "completed",
      sent: [[to]],
    });
  });

  it("are one child for two deliveries at once with one slot left, and neither bounces", async () => {
    await withQuotas(
      { ...configuredLimits, workflowDescendantRuns: 1 },
      async () => {
        const admin = await personApi("admin");
        const looping = await loopApp(admin);
        const subject = `Ping ${crypto.randomUUID()}`;

        await deliver(
          looping.address,
          message(looping.address, { from: "ann@acme.test", subject })
        );
        await runsEnded(admin, looping.app, 1);
        const to = await sentTo(subject, 0);
        const mail = message(to, { from: looping.mailbox, subject });
        const atOnce = await Promise.all([
          outcomeOf(deliver(to, mail, looping.mailbox)),
          outcomeOf(deliver(to, mail, looping.mailbox)),
        ]);
        await runsEnded(admin, looping.app, 2);

        expect({ atOnce, places: await placesOf(looping.app) }).toStrictEqual({
          atOnce: ["ok", "ok"],
          places: ["root", "child"],
        });
      }
    );
  });
});

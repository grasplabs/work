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

/** How the `loop` workflow's step sends its mail. */
const sends = {
  // Through the run's own connection.
  direct: `return JSON.parse((await env.MAIL.call("mail.send", mail, { idempotencyKey })).output);`,
  // Twice under its key, as a retry would: connect answers the second
  // only when it is the same call.
  twice: `await env.MAIL.call("mail.send", mail, { idempotencyKey });
      return JSON.parse((await env.MAIL.call("mail.send", mail, { idempotencyKey })).output);`,
  // Through its App's server code, with its caller's key.
  app: `return await env.APP.call("relay", mail);`,
} as const;

type Sends = keyof typeof sends;

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
      { description: "Mail the address again", sideEffect: true, input: { mailbox: "${mailbox}", subject: input.subject, body: "Again.", to: [input.to[0]?.address ?? ""], replyTo: ["${local}@grasp.test"] } },
      async ({ idempotencyKey, input: mail }) => {
      ${sends[send]}
      }
    )
);
`,
  "workflows/loop.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./loop.ts";

const input = { id: "m", stored: null, from: { name: "", address: "a@b.test" }, to: [{ name: "", address: "loop@b.test" }], cc: [], subject: "", date: null, text: "", truncated: false, attachments: [] };

export default workflowTests(definition, [{ name: "runs", input, mocks: { send: { sent: true } }, expect: {} }]);
`,
  ...(send === "app" ? { "app/server.ts": relayServer } : {}),
});

/** A shared Microsoft 365 account `admin` connects: its ID and mailbox. */
const connectShared = async (admin: Person) => {
  const subject = `team-${crypto.randomUUID()}`;
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
  const mailbox = `${subject}@acme.test`;
  const listed = await admin.api.connections.list();
  const connection = listed.find(({ accountName }) => accountName === mailbox);
  if (connection === undefined) {
    throw new Error("Expected the shared connection");
  }
  return { id: connection.id, mailbox };
};

/**
 * An App with the `loop` workflow at an address of its own, sending as
 * `send` says through a shared Microsoft 365 connection of its own.
 */
const loopApp = async (admin: Person, send: Sends = "direct") => {
  const local = `loop-${crypto.randomUUID().slice(0, 8)}`;
  const connection = await connectShared(admin);
  const app = await appWith(admin, loop(local, connection.mailbox, send));
  await requestGranted(idp, admin, {
    subject: { type: "app", appId: app },
    object: { type: "connection", connectionId: connection.id },
    actions: ["mail.send"],
    binding: "MAIL",
  });
  return {
    app,
    local,
    mailbox: connection.mailbox,
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
  { app, address, mailbox }: Awaited<ReturnType<typeof loopApp>>,
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
      await deliver(to, message(to, { from: mailbox, subject }), mailbox)
    );
  }
  return rejected;
};

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
});

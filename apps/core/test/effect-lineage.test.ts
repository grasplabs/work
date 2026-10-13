import { quotaLimitsSchema } from "@grasp-os/shared/quota-policy";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import worker from "../src/index.ts";
import { deliverConnectorEvent } from "../src/workflows/connector-events.ts";
import { outlook, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { endLiveRuns, finished } from "./runs.ts";
import { signedInApi } from "./sign-in.ts";
import { appWith, grantMail } from "./workflow-apps.ts";

// The runs a run's own effects start, as its descendants: mail it sends
// to its App's own address, and what it makes through a connection that
// a connection then reports, start their runs under it, held to its
// lineage's nesting and descendant limits (effect-stamps.ts). The ways
// it can fail come first: a workflow that mails itself, or makes what it
// hears of, runs without end, each run a new root; a forged or copied
// stamp attaches a run to another's lineage, or takes one out of it; a
// lineage's refusal is retried without end. Runs, connect, the engine
// and core's database are real; the mail server and Email Routing are
// the tests' (test/mail-server.ts, `deliver`).

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

/**
 * The `loop` workflow, receiving mail at `address`: it mails the address
 * the message came to, through its App's mail connection.
 */
const loop = (address: string): Record<string, string> => ({
  "workflows/loop.ts": `import { emailMessage, workflow } from "@grasp-os/sdk/workflow";

export default workflow(
  "loop",
  { params: {}, input: emailMessage, triggers: [{ type: "email", address: "${address}" }] },
  async (step, { env, input }) =>
    await step.do(
      "send",
      { description: "Mail the address again", sideEffect: true, input: { to: input.to[0]?.address ?? "", subject: input.subject } },
      async ({ idempotencyKey, input: mail }) => JSON.parse((await env.MAIL.call("mail.send", mail, { idempotencyKey })).output)
    )
);
`,
  "workflows/loop.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./loop.ts";

const input = { id: "m", stored: null, from: { name: "", address: "a@b.test" }, to: [{ name: "", address: "loop@b.test" }], cc: [], subject: "", date: null, text: "", truncated: false, attachments: [] };

export default workflowTests(definition, [{ name: "runs", input, mocks: { send: { messageId: "mocked" } }, expect: {} }]);
`,
});

/**
 * The `filer` workflow, on a file created in OneDrive: it writes a file
 * through its App's drive connection.
 */
const filer: Record<string, string> = {
  "workflows/filer.ts": `import { connectorEvent, workflow } from "@grasp-os/sdk/workflow";

export default workflow(
  "filer",
  { params: {}, input: connectorEvent, triggers: [{ type: "event", event: "m365.file.created" }] },
  async (step, { env }) =>
    await step.do(
      "write",
      { description: "Write a copy", sideEffect: true, input: { name: "copy.txt" } },
      async ({ idempotencyKey, input }) => JSON.parse((await env.DRIVE.call("files.create", input, { idempotencyKey })).output)
    )
);
`,
  "workflows/filer.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./filer.ts";

const input = { id: "e", connection: "c", owner: null, action: "files.list", type: "m365.file.created", payload: null };

export default workflowTests(definition, [{ name: "runs", input, mocks: { write: { id: "mocked" } }, expect: {} }]);
`,
};

/** A plain message to `to`, from `from`, as it goes over the wire. */
const message = (
  to: string,
  { from = "Ann <ann@acme.test>", subject = "Ping" } = {}
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
 * Delivers `raw` to `to`, as Email Routing does: the reason it was
 * rejected with, if it was. A delivery that fails for now throws.
 */
const deliver = async (
  to: string,
  raw: string
): Promise<string | undefined> => {
  const bytes = new TextEncoder().encode(raw);
  let rejected: string | undefined;
  await worker.email(
    {
      from: "bounces@acme.test",
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

const startedSchema = z.object({
  parent: z.string().optional(),
  root: z.string().optional(),
});

/** The App's runs as they started, each with the lineage it joined. */
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

/** The App's refusals of `action`, each as its reason and limit. */
const refusals = async (app: string, action: string) => {
  const events = await allEvents();
  return events
    .filter(({ action: done, target }) => done === action && target?.id === app)
    .map(({ detail }) => [detail.reason, detail.limit]);
};

/** Where a run sits: the root, a run under `root`, or elsewhere. */
const placeOf = (
  { parent }: { parent?: string },
  root: string | undefined
): string => {
  if (parent === undefined) {
    return "root";
  }
  return parent === root ? "child" : "other";
};

/** What a toolkit's `files.create` answers: a file it made, `id`. */
const fileResult = (id: string) => ({
  content: [{ type: "text", text: JSON.stringify({ id }) }],
  structuredContent: { id },
});

/** A file created in OneDrive, as connect reports it. */
const created = (id: string) => ({
  id,
  connection: "connection-outlook",
  owner: null,
  action: "files.list",
  type: "m365.file.created",
  payload: { id, name: "copy.txt" },
});

/**
 * An App with the `loop` workflow at an address of its own, mailing
 * through a connection of its own.
 */
const loopApp = async (builder: Person) => {
  const local = `loop-${crypto.randomUUID().slice(0, 8)}`;
  const mail = await mailConnection();
  const app = await appWith(builder, loop(local));
  await grantMail(idp, builder, app, mail.id);
  return { app, mail, local, address: `${local}@grasp.test` };
};

/** An address `local` with a token on it. */
const tokenedAt = (local: string) =>
  new RegExp(`^${local}\\+[0-9a-f]{26}@grasp\\.test$`, "u");

describe("runs a run's own effects start", { timeout: 120_000 }, () => {
  afterEach(endLiveRuns);

  it("join its lineage when it mails its own address, until the lineage's descendant limit refuses one", async () => {
    await withQuotas(
      { ...configuredLimits, workflowDescendantRuns: 2 },
      async () => {
        const builder = await personApi("admin");
        const { app, mail, local, address } = await loopApp(builder);

        // Someone mails the App: the lineage's root.
        await expect(
          deliver(address, message(address))
        ).resolves.toBeUndefined();
        // Each run's mail, delivered as its provider and Email Routing would.
        for (let hop = 1; hop <= 3; hop += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one hop after another
          await runsEnded(builder, app, hop);
          // oxlint-disable-next-line no-await-in-loop -- one hop after another
          const { sent } = await mail.did();
          const to = sent[hop - 1]?.to ?? "";
          // oxlint-disable-next-line no-await-in-loop -- one hop after another
          await expect(deliver(to, message(to))).resolves.toBeUndefined();
        }
        const { sent } = await mail.did();
        const started = await startedRuns(app);
        const root = started.find(({ parent }) => parent === undefined);

        expect({
          sent: sent.map(({ to }) => tokenedAt(local).test(to)),
          tokens: new Set(sent.map(({ to }) => to)).size,
          runs: started.length,
          roots: started.filter(({ parent }) => parent === undefined).length,
          lineage: started
            .filter(({ parent }) => parent !== undefined)
            .map(({ root: of }) => of === root?.id),
          refused: await refusals(app, "workflow.email.refused"),
        }).toStrictEqual({
          // Every message the runs sent carries its own token.
          sent: [true, true, true],
          tokens: 3,
          // The root and two runs under it: the third is refused, and its
          // message dropped, not left to be tried again.
          runs: 3,
          roots: 1,
          lineage: [true, true],
          refused: [["lineage_limit", "descendants"]],
        });
        // Each run sits one deeper than the one whose mail started it.
        const child = started.find(({ parent }) => parent === root?.id);
        expect(started.some(({ parent }) => parent === child?.id)).toBeTruthy();
      }
    );
  });

  it("stop at the lineage's nesting limit", async () => {
    await withQuotas(
      { ...configuredLimits, workflowNestingLevels: 2 },
      async () => {
        const builder = await personApi("admin");
        const { app, mail, address } = await loopApp(builder);

        await deliver(address, message(address));
        for (let hop = 1; hop <= 2; hop += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one hop after another
          await runsEnded(builder, app, hop);
          // oxlint-disable-next-line no-await-in-loop -- one hop after another
          const { sent } = await mail.did();
          const to = sent[hop - 1]?.to ?? "";
          // oxlint-disable-next-line no-await-in-loop -- one hop after another
          await deliver(to, message(to));
        }

        const started = await startedRuns(app);

        expect({
          runs: started.length,
          refused: await refusals(app, "workflow.email.refused"),
        }).toStrictEqual({
          runs: 2,
          refused: [["lineage_limit", "nesting"]],
        });
      }
    );
  });

  it("can't be attached to a lineage by a token core didn't record, nor started twice by a copy of a run's mail", async () => {
    const builder = await personApi("admin");
    const { app, mail, local, address } = await loopApp(builder);

    await deliver(address, message(address));
    await runsEnded(builder, app, 1);
    const [root] = await startedRuns(app);
    const { sent } = await mail.did();
    const to = sent[0]?.to ?? "";
    const forged = `${local}+${"0".repeat(26)}@grasp.test`;

    // A made-up token is part of an address nobody receives at.
    const rejected = await deliver(forged, message(forged));
    // Someone who saw the run's mail sends to its address first, from
    // elsewhere: the one run that address starts, in the run's lineage.
    await deliver(to, message(to, { from: "Mallory <m@evil.test>" }));
    await deliver(to, message(to));
    await runsEnded(builder, app, 2);
    const started = await startedRuns(app);

    expect({
      rejected,
      runs: started.map((run) => placeOf(run, root?.id)),
    }).toStrictEqual({
      rejected: "No such address.",
      runs: ["root", "child"],
    });
  });

  it("join its lineage when it makes what a connection then reports, until the lineage's limit refuses one", async () => {
    await withQuotas(
      { ...configuredLimits, workflowNestingLevels: 2 },
      async () => {
        const builder = await personApi("admin");
        const drive = await mailConnection([], ["files.create"]);
        await drive.serve({
          list: [
            {
              name: "files.create",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: false },
            },
          ],
          answers: {
            "files.create": [
              fileResult("file-1"),
              fileResult("file-2"),
              fileResult("file-3"),
            ],
          },
        });
        const app = await appWith(builder, filer);
        await requestGranted(idp, builder, {
          ...outlook(app),
          actions: ["files.list"],
        });
        await requestGranted(idp, builder, {
          subject: { type: "app", appId: app },
          object: { type: "connection", connectionId: drive.id },
          actions: ["files.create"],
          binding: "DRIVE",
        });

        // Someone else's file: the root.
        await expect(
          deliverConnectorEvent(env, created("outside"))
        ).resolves.toStrictEqual({ runs: 1 });
        await runsEnded(builder, app, 1);
        // The root's file: a run under it.
        await expect(
          deliverConnectorEvent(env, created("file-1"))
        ).resolves.toStrictEqual({ runs: 1 });
        await runsEnded(builder, app, 2);
        // That run's file: a level too deep, refused, and settled.
        await expect(
          deliverConnectorEvent(env, created("file-2"))
        ).resolves.toStrictEqual({ runs: 0 });
        const started = await startedRuns(app);
        const root = started.find(({ parent }) => parent === undefined);

        expect({
          runs: started.map((run) => placeOf(run, root?.id)),
          refused: await refusals(app, "workflow.event.refused"),
        }).toStrictEqual({
          runs: ["root", "child"],
          refused: [["lineage_limit", "nesting"]],
        });
      }
    );
  });
});

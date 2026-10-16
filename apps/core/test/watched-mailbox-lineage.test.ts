import { appIdSchema } from "@grasp-os/shared/ids";
import { quotaLimitsSchema } from "@grasp-os/shared/quota-policy";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appHost } from "../src/durable-objects.ts";
import { deliverConnectorEvent } from "../src/workflows/connector-events.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import {
  consentCode,
  graphControlUrl,
  graphSentUrl,
} from "./connect-providers.ts";
import { runCron, runQuarterHourCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { endLiveRuns, finished } from "./runs.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { routed, signedInApi } from "./sign-in.ts";
import { connectDb, testBinding } from "./test-env.ts";
import { appWith } from "./workflow-apps.ts";

// The runs a run's own mail starts in a mailbox a connection watches, as
// its descendants (mail-stamps.ts, `stampedEventRun`). A workflow on
// `m365.mail.received` that mails a watched mailbox through Graph starts
// a run without starting it itself: Graph's `sendMail` answers no ID, and
// the copy that arrives gets one of its own. The ways it can fail come
// first: such a workflow runs without end, each run a new root; a stamp a
// recipient read is taken to another watched mailbox, or sent on with a
// forged From, or sent again, to attach a message to the run's lineage; a
// made-up stamp attaches one; a refusal is delivered again without end; an
// account whose sign-in name isn't the address it sends from escapes its
// lineage. Runs, connect, its event sources, the engine and core's
// database are real; Microsoft Graph is the tests'
// (test/connect-providers.ts).

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

/** A day, in milliseconds. */
const day = 24 * 60 * 60 * 1000;

/** Each policy a test sets, under a generation higher than any before. */
let generations = 2000;

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

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

const providers = (): Fetcher => {
  const binding = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(binding)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  return binding;
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
  return { id: connection.id, signInName: connection.accountName };
};

/**
 * The `echo` workflow: on mail arriving in a mailbox its App watches, it
 * mails `to` from `from`, with the same subject, and returns the event's
 * ID. Its input is loose, keeping whatever the event carries, so a stamp
 * handed to the run would show: it returns `stamped` then.
 */
const echo = (from: string, to: string): Record<string, string> => ({
  "workflows/echo.ts": `import { connectorEvent, workflow } from "@grasp-os/sdk/workflow";

export default workflow(
  "echo",
  { params: {}, input: connectorEvent.loose(), triggers: [{ type: "event", event: "m365.mail.received", filter: { folder: "inbox" } }] },
  async (step, { env, input }) =>
    await step.do(
      "send",
      { description: "Mail the mailbox again", sideEffect: true, retries: { limit: 0 }, input: { mailbox: "${from}", subject: String(input.payload.subject), body: "Again.", to: ["${to}"] } },
      async ({ idempotencyKey, input: mail }) => {
        await env.MAIL.call("mail.send", mail, { idempotencyKey });
        return Object.hasOwn(input, "stamp") ? "stamped" : input.id;
      }
    )
);
`,
  "workflows/echo.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./echo.ts";

const input = { id: "e", connection: "c", owner: null, action: "mail.list", type: "m365.mail.received", payload: { subject: "x" } };

export default workflowTests(definition, [{ name: "runs", input, mocks: { send: "e" }, expect: {} }]);
`,
});

/** The `listen` workflow: on the same mail, it only reads the event. */
const listen: Record<string, string> = {
  "workflows/listen.ts": `import { connectorEvent, workflow } from "@grasp-os/sdk/workflow";

export default workflow(
  "listen",
  { params: {}, input: connectorEvent, triggers: [{ type: "event", event: "m365.mail.received", filter: { folder: "inbox" } }] },
  async (step, { input }) => await step.do("read", { description: "Read it" }, async () => input.id)
);
`,
  "workflows/listen.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./listen.ts";

const input = { id: "e", connection: "c", owner: null, action: "mail.list", type: "m365.mail.received", payload: { subject: "x" } };

export default workflowTests(definition, [{ name: "runs", input, mocks: { read: "e" }, expect: {} }]);
`,
};

/**
 * An App with the `echo` workflow, watching a shared Microsoft 365
 * mailbox it mails (`MAIL`), and a second one it only watches when
 * `second` (`OTHER`), and the `listen` workflow too when `listening`.
 * `byName`, its permission names the mailbox by its sign-in name rather
 * than being on the whole connection. With `plusTag` the workflow mails
 * the mailbox's plus-address `local+<tag>@domain`, which its provider
 * delivers to the mailbox itself. An `aliased` account signs in with a UPN that isn't
 * the address it sends from; the workflow then names its mailbox by the
 * UPN, as Graph allows, and mails its address.
 */
const watchingApp = async (
  admin: Person,
  {
    aliased = false,
    second = false,
    listening = false,
    byName = false,
    plusTag,
  }: {
    aliased?: boolean;
    second?: boolean;
    listening?: boolean;
    byName?: boolean;
    plusTag?: string;
  } = {}
) => {
  const subject = `${aliased ? "alias" : "team"}-${crypto.randomUUID()}`;
  const watched = await connectShared(admin, subject);
  // The address it sends from, as Graph sends from a user's primary one.
  const address = `${subject}@acme.test`;
  const app = await appWith(admin, {
    ...echo(
      watched.signInName,
      plusTag === undefined ? address : address.replace("@", `+${plusTag}@`)
    ),
    ...(listening ? listen : {}),
  });
  await requestGranted(idp, admin, {
    subject: { type: "app", appId: app },
    object: {
      type: "connection",
      connectionId: watched.id,
      ...(byName ? { resource: watched.signInName } : {}),
    },
    actions: ["mail.list", "mail.send"],
    binding: "MAIL",
  });
  let other: string | undefined;
  if (second) {
    other = `team-${crypto.randomUUID()}`;
    const connection = await connectShared(admin, other);
    await requestGranted(idp, admin, {
      subject: { type: "app", appId: app },
      object: { type: "connection", connectionId: connection.id },
      actions: ["mail.list"],
      binding: "OTHER",
    });
  }
  // Connect starts listening where the App listens.
  await runCron();
  return {
    app,
    address,
    signInName: watched.signInName,
    // Graph reaches a whole connection's mailbox by its user's object ID,
    // and a mailbox a permission names by that name.
    user: byName ? watched.signInName : subject,
    other,
  };
};

type Watching = Awaited<ReturnType<typeof watchingApp>>;

const sentSchema = z.array(
  z.object({
    mailbox: z.string(),
    subject: z.string(),
    to: z.array(z.string()),
    headers: z.array(z.object({ name: z.string(), value: z.string() })),
  })
);

/** The `hop`th mail Graph sent with `subject`, once it went. */
const sentMail = async (subject: string, hop: number) =>
  await vi.waitFor(
    async () => {
      const response = await providers().fetch(graphSentUrl);
      const sent = sentSchema
        .parse(await response.json())
        .filter((each) => each.subject === subject)[hop];
      expect(sent).toBeDefined();
      return sent ?? { mailbox: "", subject, to: [], headers: [] };
    },
    { timeout: 20_000, interval: 200 }
  );

/** The stamp a mail Graph sent carries. */
const stampOf = (sent: Awaited<ReturnType<typeof sentMail>>): string =>
  sent.headers.find(({ name }) => name === "X-Grasp-Stamp")?.value ?? "";

/** A message as Graph's delta shows it in an inbox. */
const inboxMessage = ({
  id = crypto.randomUUID(),
  subject,
  from,
  stamp,
}: {
  id?: string;
  subject: string;
  from: string;
  stamp?: string;
}) => ({
  id,
  receivedDateTime: new Date().toISOString(),
  subject,
  from: { emailAddress: { name: null, address: from } },
  ...(stamp === undefined
    ? {}
    : { internetMessageHeaders: [{ name: "X-Grasp-Stamp", value: stamp }] }),
});

/**
 * `messages` arrive in `user`'s inbox at Graph, then a minute passes and
 * core's cron trigger runs: connect reads them, and core delivers them.
 */
const arrive = async (
  user: string,
  ...messages: Record<string, unknown>[]
): Promise<void> => {
  for (const message of messages) {
    // oxlint-disable-next-line no-await-in-loop -- in order, as they arrive
    await providers().fetch(graphControlUrl, {
      method: "POST",
      body: JSON.stringify({ mailbox: user, message }),
    });
  }
  await connectDb().prepare("UPDATE event_sources SET poll_at = 0").run();
  await runCron();
};

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
const runsEnded = async (admin: Person, app: string, count: number) => {
  const runs = await vi.waitFor(
    async () => {
      const listed = await admin.api.workflows.list(app);
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

/** The App's refusals of its events, each as its reason and limit. */
const refusals = async (app: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target }) =>
        action === "workflow.event.refused" && target?.id === app
    )
    .map(({ detail }) => [detail.reason, detail.limit]);
};

/**
 * A customer mails the App's mailbox, then each mail its runs send
 * arrives back in it, as Graph delivers it, `hops` times.
 */
const followHops = async (
  admin: Person,
  { app, address, user }: Watching,
  subject: string,
  hops: number
): Promise<void> => {
  await arrive(user, inboxMessage({ subject, from: "ann@customer.test" }));
  for (let hop = 0; hop < hops; hop += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one hop after another
    await runsEnded(admin, app, hop + 1);
    // oxlint-disable-next-line no-await-in-loop -- one hop after another
    const sent = await sentMail(subject, hop);
    // oxlint-disable-next-line no-await-in-loop -- one hop after another
    await arrive(
      user,
      inboxMessage({ subject, from: address, stamp: stampOf(sent) })
    );
  }
};

describe(
  "runs a run's mail to a watched mailbox starts",
  { timeout: 180_000 },
  () => {
    afterEach(endLiveRuns);

    it("join its lineage, until its descendant limit refuses one, for good", async () => {
      await withQuotas(
        { ...configuredLimits, workflowDescendantRuns: 2 },
        async () => {
          const admin = await personApi("admin");
          const watching = await watchingApp(admin);
          const subject = `Ping ${crypto.randomUUID()}`;

          await followHops(admin, watching, subject, 3);
          await runsEnded(admin, watching.app, 3);
          // Settled, not delivered again: once anything connect still
          // holds is due, another minute refuses nothing more.
          await connectDb()
            .prepare("UPDATE connector_events SET retry_at = 0")
            .run();
          await arrive(watching.user);
          const sent = await sentMail(subject, 0);

          expect({
            // The stamp is a header core made, never the App's input.
            stamped: /^[0-9a-f]{32}$/u.test(stampOf(sent)),
            places: await placesOf(watching.app),
            refused: await refusals(watching.app),
          }).toStrictEqual({
            stamped: true,
            places: ["root", "child", "child"],
            refused: [["lineage_limit", "descendants"]],
          });
          await expect(
            admin.api.workflows.list(watching.app)
          ).resolves.toHaveLength(3);
        }
      );
    });

    it("are refused once, as their event settles, when another workflow must wait for its hourly limit first", async () => {
      await withQuotas(
        { ...configuredLimits, workflowNestingLevels: 1 },
        async () => {
          const admin = await personApi("admin");
          const watching = await watchingApp(admin, { listening: true });
          const subject = `Ping ${crypto.randomUUID()}`;
          await arrive(
            watching.user,
            inboxMessage({ subject, from: "ann@customer.test" })
          );
          await runsEnded(admin, watching.app, 2);
          const sent = await sentMail(subject, 0);
          // `listen` has had its hour's runs.
          const now = Date.now();
          await env.DB.batch(
            Array.from({ length: 60 }, (_, index) =>
              env.DB.prepare(
                "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at, trigger_key) VALUES (?, ?, 'listen', 1, NULL, 'completed', ?, ?, ?)"
              ).bind(
                crypto.randomUUID(),
                watching.app,
                now - index * 1000,
                now,
                `event:${watching.app}:listen:seeded-${index}`
              )
            )
          );
          await arrive(
            watching.user,
            inboxMessage({
              subject,
              from: watching.address,
              stamp: stampOf(sent),
            })
          );
          const whileCapped = await refusals(watching.app);
          // The event as connect holds it, waiting to be delivered again.
          const held = await connectDb()
            .prepare(
              "SELECT event FROM connector_events WHERE event LIKE '%\"stamp\"%' ORDER BY created_at DESC LIMIT 1"
            )
            .first<{ event: string }>();
          // The hour passes for it; the event, still held, is delivered again.
          await env.DB.prepare(
            "DELETE FROM workflow_runs WHERE app_id = ? AND workflow_id = 'listen' AND instr(trigger_key, ':seeded-') > 0"
          )
            .bind(watching.app)
            .run();
          await connectDb()
            .prepare("UPDATE connector_events SET retry_at = 0")
            .run();
          await arrive(watching.user);
          await connectDb()
            .prepare("UPDATE connector_events SET retry_at = 0")
            .run();
          await arrive(watching.user);
          // Settled, then delivered once more, as when connect never heard
          // it settled, after an operator raised the nesting limit: a
          // refusal recorded is final for that delivery.
          await withQuotas(
            { ...configuredLimits, workflowNestingLevels: 5 },
            async () => {
              await deliverConnectorEvent(
                env,
                JSON.parse(held?.event ?? "null")
              );
            }
          );
          const runs = await admin.api.workflows.list(watching.app);
          const events = await allEvents();

          expect({
            whileCapped,
            runs: runs.length,
            refused: events
              .filter(
                ({ action, target }) =>
                  action === "workflow.event.refused" &&
                  target?.id === watching.app
              )
              .map(
                ({ detail }) =>
                  `${String(detail.workflow)} ${String(detail.limit)}`
              )
              .toSorted((a, b) => a.localeCompare(b)),
          }).toStrictEqual({
            whileCapped: [],
            // The customer's mail's two roots, and nothing the refused
            // delivery started later.
            runs: 2,
            refused: ["echo nesting", "listen nesting"],
          });
        }
      );
    });

    it("are only the run's own mail, and never let a forged copy detach it: up to a bound, every copy from its sender is a child", async () => {
      const admin = await personApi("admin");
      const watching = await watchingApp(admin, { second: true });
      const subject = `Ping ${crypto.randomUUID()}`;
      await arrive(
        watching.user,
        inboxMessage({ subject, from: "ann@customer.test" })
      );
      const [first] = await runsEnded(admin, watching.app, 1);
      const stamp = stampOf(await sentMail(subject, 0));
      const own = inboxMessage({ subject, from: watching.address, stamp });
      const forged = () =>
        inboxMessage({ subject, from: watching.address, stamp });

      // A recipient sends the stamp on, from their own address.
      const fromEve = inboxMessage({
        subject,
        from: "eve@customer.test",
        stamp,
      });
      await arrive(watching.user, fromEve);
      // The run's sender, with the stamp, to a mailbox the run never mailed.
      const elsewhere = inboxMessage({
        subject,
        from: watching.address,
        stamp,
      });
      await arrive(watching.other ?? "", elsewhere);
      // A stamp core never recorded.
      const madeUp = inboxMessage({
        subject,
        from: watching.address,
        stamp: "f".repeat(32),
      });
      await arrive(watching.user, madeUp);
      // A copy sent on with its From forged as the run's, read with the
      // run's own copy and ahead of it: the run's own copy is a child still.
      await arrive(watching.user, forged(), own);
      // Graph shows the run's own copy again, once it's read.
      await arrive(watching.user, { ...own, isRead: true });
      // More forged copies: children up to the bound, then roots.
      await arrive(watching.user, forged(), forged(), forged(), forged());
      const runs = await runsEnded(admin, watching.app, 10);
      const started = await startedRuns(watching.app);
      const children = started.filter(({ parent }) => parent !== undefined);
      const outputs = await Promise.all(
        children.map(async ({ id }) => {
          const { output } = await admin.api.workflows.status(id);
          return output;
        })
      );

      expect({
        runs: runs.length,
        parents: [...new Set(children.map(({ parent }) => parent))],
        children: children.length,
        // The run's own copy among them, and no run handed the stamp.
        own: outputs.includes(own.id),
        stamped: outputs.includes("stamped"),
        // Never a child: another sender, another mailbox, a made-up stamp.
        others: [fromEve, elsewhere, madeUp].filter(({ id }) =>
          outputs.includes(id)
        ).length,
      }).toStrictEqual({
        runs: 10,
        parents: [first?.id],
        children: 5,
        own: true,
        stamped: false,
        others: 0,
      });
    });

    it("join its lineage when it mails a plus-address of the watched mailbox", async () => {
      const admin = await personApi("admin");
      const watching = await watchingApp(admin, { plusTag: "loop" });
      const subject = `Ping ${crypto.randomUUID()}`;

      await followHops(admin, watching, subject, 1);
      await runsEnded(admin, watching.app, 2);
      const sent = await sentMail(subject, 0);

      expect({
        to: sent.to,
        places: await placesOf(watching.app),
      }).toStrictEqual({
        to: [`${watching.user}+loop@acme.test`],
        places: ["root", "child"],
      });
    });

    it("join its lineage when its mail waited for its person to confirm it", async () => {
      const admin = await personApi("admin");
      const watching = await watchingApp(admin);
      // Its App read restricted data: each side effect waits for its person.
      await appHost(env, appIdSchema.parse(watching.app)).restrict();
      const subject = `Ping ${crypto.randomUUID()}`;
      await arrive(
        watching.user,
        inboxMessage({ subject, from: "ann@customer.test" })
      );
      const held = await vi.waitFor(
        async () => {
          const waiting = await admin.api.pendingActions.list();
          const found = waiting.find(({ action }) => action === "mail.send");
          expect(found).toBeDefined();
          return found;
        },
        { timeout: 20_000, interval: 200 }
      );
      await admin.api.pendingActions.confirm(
        held?.id ?? "",
        held?.inputHash ?? ""
      );
      await runsEnded(admin, watching.app, 1);
      const sent = await sentMail(subject, 0);
      await arrive(
        watching.user,
        // Its From padded, as a provider may hand it over.
        inboxMessage({
          subject,
          from: ` ${watching.address} `,
          stamp: stampOf(sent),
        })
      );
      await vi.waitFor(
        async () => {
          await expect(
            admin.api.workflows.list(watching.app)
          ).resolves.toHaveLength(2);
        },
        { timeout: 20_000, interval: 200 }
      );

      await expect(placesOf(watching.app)).resolves.toStrictEqual([
        "root",
        "child",
      ]);
    });

    it("join its lineage from an account whose sign-in name, which its permission names, isn't the address it sends from", async () => {
      const admin = await personApi("admin");
      const watching = await watchingApp(admin, {
        aliased: true,
        byName: true,
      });
      const subject = `Ping ${crypto.randomUUID()}`;

      await followHops(admin, watching, subject, 1);
      await runsEnded(admin, watching.app, 2);

      await expect(placesOf(watching.app)).resolves.toStrictEqual([
        "root",
        "child",
      ]);
    });

    it("join its lineage from an account whose sign-in name isn't the address it sends from", async () => {
      const admin = await personApi("admin");
      const watching = await watchingApp(admin, { aliased: true });
      const subject = `Ping ${crypto.randomUUID()}`;

      await followHops(admin, watching, subject, 1);
      await runsEnded(admin, watching.app, 2);
      const sent = await sentMail(subject, 0);

      expect({
        signInName: watching.signInName,
        from: sent.mailbox,
        to: sent.to,
        places: await placesOf(watching.app),
      }).toStrictEqual({
        signInName: `${watching.user}@acme.onmicrosoft.test`,
        from: watching.signInName,
        to: [`${watching.user}@acme.test`],
        places: ["root", "child"],
      });
    });

    it("forget a run's stamps, and what claimed them or was refused under them, once its details are removed", async () => {
      await withQuotas(
        { ...configuredLimits, workflowNestingLevels: 2 },
        async () => {
          const admin = await personApi("admin");
          const watching = await watchingApp(admin);
          const subject = `Ping ${crypto.randomUUID()}`;
          await followHops(admin, watching, subject, 2);
          const runs = await runsEnded(admin, watching.app, 2);
          const stamps = [
            stampOf(await sentMail(subject, 0)),
            stampOf(await sentMail(subject, 1)),
          ];
          const kept = async () =>
            await env.DB.prepare(
              "SELECT (SELECT count(*) FROM run_mail_calls WHERE run_id IN (?1, ?2)) AS calls, (SELECT count(*) FROM run_mail_stamp_claims WHERE stamp IN (?3, ?4)) AS claims, (SELECT count(*) FROM run_mail_stamp_refusals WHERE stamp IN (?3, ?4)) AS refusals"
            )
              .bind(runs[0]?.id ?? "", runs[1]?.id ?? "", ...stamps)
              .first<{ calls: number; claims: number; refusals: number }>();
          const before = await kept();

          // Past every run's retention (the deployment's 30 days).
          await runQuarterHourCron({}, new Date(Date.now() + 31 * day));

          expect({ before, after: await kept() }).toStrictEqual({
            before: { calls: 2, claims: 2, refusals: 1 },
            after: { calls: 0, claims: 0, refusals: 0 },
          });
        }
      );
    });
  }
);

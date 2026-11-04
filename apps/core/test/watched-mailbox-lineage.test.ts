/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import {
  consentCode,
  graphControlUrl,
  graphSentUrl,
} from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import {
  endedRun,
  endLiveResourceRuns,
  jsonWorkflowAppsOf,
  objectSchema,
  publishedWorkflow,
  settles,
} from "./json-workflow-apps.ts";
import type { Person } from "./json-workflow-apps.ts";
import { runMinuteTasks, runQuarterHourTasks } from "./maintenance.ts";
import { configuredLimits } from "./quota-limits.ts";
import { endLiveRuns } from "./runs.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { routed, unique } from "./sign-in.ts";
import { connectDb, testBinding } from "./test-env.ts";

// The runs a run's own mail starts in a mailbox a connection watches, as
// its descendants (mail-stamps.ts, `stampedEventRun`;
// connector-triggers.ts). An independent workflow, started by its
// connector trigger on `m365.mail.received`, mails a watched mailbox
// through Graph and starts a run without starting it itself: Graph's
// `sendMail` answers no ID, and the copy that arrives gets one of its
// own. The ways it can fail come first: such a workflow runs without end,
// each run a new root; a stamp a recipient read is taken to another
// watched mailbox, or sent on with a forged From, or sent again, to
// attach a message to the run's lineage; a made-up stamp attaches one; a
// run is handed the stamp; an account whose sign-in name isn't the
// address it sends from escapes its lineage. Runs, connect, its event
// sources, the engine and core's database are real; Microsoft Graph is
// the tests' (test/connect-providers.ts).
//
// Not here: a refusal settled once for a trigger, however often the
// event is delivered again while another trigger waits for its hour, is
// connector-triggers.test.ts's ("settle an event once for a trigger when
// $scene, however often it is delivered, and sweep what's left past
// retention", and "end a workflow mailing its own watched mailbox at its
// lineage's limit, each run under the last"); the App's own workflows'
// refusal records went with them.
//
// Kept as an App run until a JSON run's mail can wait for its person to
// confirm it: that mail joining its run's lineage once confirmed. A
// trigger's JSON run is never restricted, so its mail never waits.

const idp = mockIdp();
const { signedIn } = jsonWorkflowAppsOf(idp);

/** A day, in milliseconds. */
const day = 24 * 60 * 60 * 1000;

/** What `run` returns, with the quota limits `limits` lowered. */
const withQuotas = async <Result>(
  limits: Record<string, number>,
  run: () => Promise<Result>
): Promise<Result> => {
  env.TEST_QUOTA_LIMITS = limits;
  try {
    return await run();
  } finally {
    env.TEST_QUOTA_LIMITS = configuredLimits;
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

/** The mailbox a test's permissions name, by what the test asks. */
const namedMailbox = (
  {
    byName,
    byId,
    byOtherId,
  }: { byName: boolean; byId: boolean; byOtherId: boolean },
  {
    signInName,
    subject,
    otherUser,
  }: { signInName: string; subject: string; otherUser: string }
): string | undefined => {
  if (byOtherId) {
    return otherUser;
  }
  if (byId) {
    return subject;
  }
  return byName ? signInName : undefined;
};

/** A JSON Schema, as the catalog's envelope text for it. */
const enveloped = (text: string): string => {
  const document: unknown = JSON.parse(text);
  return JSON.stringify({ format: "json", document });
};

/**
 * A catalog contract of `admin`'s of exactly `mail.send`, as connect
 * serves it to `connectionId` (`microsoft-365.mail@1`): its key.
 */
const sendContract = async (
  admin: Person,
  connectionId: string
): Promise<string> => {
  const served = await env.CONNECT.connectorContract({
    contract: "microsoft-365.mail@1",
    connectionId,
  });
  const send = Object.values(served.actions).find(
    ({ tool }) => tool === "mail.send"
  );
  if (send === undefined) {
    throw new Error("Expected mail.send in the contract");
  }
  const key = `mail-${unique()}`;
  await admin.api.workflowResources.publishContract({
    key,
    kind: "connector",
    operations: {
      "mail.send": {
        input: enveloped(send.input),
        output: enveloped(send.output),
        // As its connector declares it: a send may attach run files.
        ...(send.takesFiles === true ? { takesFiles: true } : {}),
      },
    },
  });
  return key;
};

const echoInput = {
  id: { type: "string" },
  subject: { type: "string" },
  stamp: { type: "string" },
};

/**
 * The `echo` workflow, through catalog contract `key`: on mail arriving
 * in a mailbox its trigger watches, it mails `to` from `from`, with the
 * same subject, and returns the event's ID, and the stamp its input was
 * handed, if any (`unstamped` otherwise).
 */
const echoOf =
  (key: string, from: string, to: string) =>
  (name: string): string =>
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
            bindings: { mail: { kind: "connector", contract: key } },
          },
        },
      },
      input: { schema: objectSchema(echoInput) },
      output: {
        schema: objectSchema({
          id: { type: "string" },
          stamp: { type: "string" },
        }),
      },
      do: [
        {
          send: {
            call: "grasp.connector",
            with: {
              binding: "mail",
              operation: "mail.send",
              arguments: {
                mailbox: from,
                to: [to],
                subject: "${ $workflow.input.subject }",
                body: "Again.",
              },
            },
          },
        },
        {
          finish: {
            set: {
              id: "${ $workflow.input.id }",
              stamp: "${ $workflow.input.stamp }",
            },
          },
        },
      ],
    });

/**
 * A connector trigger of `admin`'s starting `workflow` on mail received
 * at `connectionId` (in mailbox `resource`, when given), which an admin
 * lets start it and hear there. Its input: the event's ID and subject, and
 * the stamp at the event's `/stamp`, which no run is ever handed.
 */
const triggerOn = async (
  admin: Person,
  workflow: string,
  connectionId: string,
  resource?: string
): Promise<string> => {
  const connection = {
    connectionId,
    ...(resource === undefined ? {} : { resource }),
  };
  const { id } = await admin.api.workflowResources.triggers.create({
    kind: "connector",
    workflowId: workflow,
    version: 1,
    config: {
      connection,
      event: "m365.mail.received",
      input: {
        fields: { id: "/id", subject: "/payload/subject", stamp: "/stamp" },
        defaults: { stamp: "unstamped" },
      },
    },
  });
  const subject = { type: "trigger", triggerId: id } as const;
  await requestGranted(idp, admin, {
    subject,
    object: { type: "workflow", workflowId: workflow },
    actions: ["start"],
    binding: `START_${unique().toUpperCase()}`,
  });
  await requestGranted(idp, admin, {
    subject,
    object: { type: "connection", ...connection },
    actions: ["mail.list"],
    binding: `HEAR_${unique().toUpperCase()}`,
  });
  return id;
};

/**
 * The `echo` workflow, started by a connector trigger on a shared
 * Microsoft 365 mailbox it mails through its own binding `mail`, and by a
 * second trigger on another mailbox it only watches when `second`.
 * `byName`, its permissions name the mailbox by its sign-in name rather
 * than being on the whole connection. With `plusTag` the workflow mails
 * the mailbox's plus-address `local+<tag>@domain`, which its provider
 * delivers to the mailbox itself; with `toAlias` it mails the mailbox's
 * SMTP alias `also-<subject>@acme.test`, which Graph's profile of the
 * account lists. `byId`, its permissions name the mailbox by the user's
 * object ID, and the workflow sends from it by that ID; `byOtherId`, they
 * name another user's mailbox by that user's object ID, sent from and
 * watched there. An `aliased` account signs in with a UPN that isn't
 * the address it sends from; the workflow then names its mailbox by the
 * UPN, as Graph allows, and mails its address.
 */
const watchingWorkflow = async (
  admin: Person,
  {
    aliased = false,
    second = false,
    byName = false,
    byId = false,
    byOtherId = false,
    toAlias = false,
    plusTag,
  }: {
    aliased?: boolean;
    second?: boolean;
    byName?: boolean;
    byId?: boolean;
    byOtherId?: boolean;
    toAlias?: boolean;
    plusTag?: string;
  } = {}
) => {
  const subject = `${aliased ? "alias" : "team"}-${crypto.randomUUID()}`;
  // Another user's mailbox, by its object ID, which this account may use.
  const otherUser = `someone-${crypto.randomUUID()}`;
  const watched = await connectShared(admin, subject);
  // The mailbox its permissions name, if they name one: calls name it so.
  const named = namedMailbox(
    { byName, byId, byOtherId },
    { signInName: watched.signInName, subject, otherUser }
  );
  // The address it sends from, as Graph sends from a user's primary one.
  const address = `${subject}@acme.test`;
  const alias = `also-${subject}@acme.test`;
  const mailed =
    plusTag === undefined ? address : address.replace("@", `+${plusTag}@`);
  const key = await sendContract(admin, watched.id);
  const { id: workflow } = await publishedWorkflow(
    admin,
    echoOf(key, named ?? watched.signInName, toAlias ? alias : mailed)
  );
  const permissionId = await requestGranted(idp, admin, {
    subject: { type: "workflow", workflowId: workflow },
    object: {
      type: "connection",
      connectionId: watched.id,
      ...(named === undefined ? {} : { resource: named }),
    },
    actions: ["mail.send"],
    binding: `MAIL_${unique().toUpperCase()}`,
  });
  await admin.api.workflowResources.approveBinding(workflow, {
    alias: "mail",
    target: {
      kind: "connector",
      permissionId,
      contract: "microsoft-365.mail@1",
    },
    reviewed: { version: 1 },
  });
  const trigger = await triggerOn(admin, workflow, watched.id, named);
  let other: string | undefined;
  if (second) {
    other = `team-${crypto.randomUUID()}`;
    const connection = await connectShared(admin, other);
    await triggerOn(admin, workflow, connection.id);
  }
  // Connect starts listening where the triggers listen.
  await runMinuteTasks();
  return {
    workflow,
    trigger,
    address,
    alias,
    signInName: watched.signInName,
    // Graph reaches a whole connection's mailbox by its user's object ID,
    // and a mailbox a permission names by that name.
    user: named ?? subject,
    other,
  };
};

type Watching = Awaited<ReturnType<typeof watchingWorkflow>>;

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
 * core's clock runs: connect reads them, and core delivers them.
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
  await runMinuteTasks();
};

const lineageSchema = z.array(
  z.object({
    id: z.string(),
    parent: z.string().nullable(),
    root: z.string().nullable(),
    depth: z.number(),
  })
);

/**
 * The workflow's runs as they started, each with the run it started
 * under and its lineage's root, as core keeps them.
 */
const startedRuns = async (workflow: string) => {
  const { results } = await env.DB.prepare(
    "SELECT run.id, run.parent_run_id AS parent, run.root_run_id AS root, run.depth FROM workflow_resource_runs AS run JOIN workflow_start_receipts AS receipt ON receipt.id = run.id WHERE run.workflow_resource_id = ? ORDER BY receipt.created_at, run.depth"
  )
    .bind(workflow)
    .all();
  return lineageSchema.parse(results);
};

/** Where each of the workflow's runs sits: a root, or in another run's lineage. */
const placesOf = async (workflow: string): Promise<string[]> => {
  const started = await startedRuns(workflow);
  const ids = new Set(started.map(({ id }) => id));
  return started.map(({ depth, root }) => {
    if (depth === 0) {
      return "root";
    }
    return root !== null && ids.has(root) ? "child" : "other";
  });
};

/** The workflow's runs, once there are `count` and every one has ended. */
const runsEnded = async (admin: Person, workflow: string, count: number) => {
  const runs = await vi.waitFor(async () => {
    const listed = await admin.api.workflowResources.runs(workflow);
    expect(listed).toHaveLength(count);
    return listed;
  }, settles);
  return await Promise.all(
    runs.map(async ({ id }) => await endedRun(admin, workflow, id))
  );
};

/** The trigger's refusals of its events, each as its code. */
const refusals = async (trigger: string) => {
  const events = await allEvents();
  return events
    .filter(
      ({ action, target }) =>
        action === "workflow.event.refused" && target?.id === trigger
    )
    .map(({ detail }) => detail.code);
};

/**
 * A customer mails the watched mailbox, then each mail the workflow's runs
 * send arrives back in it, as Graph delivers it, `hops` times.
 */
const followHops = async (
  admin: Person,
  { workflow, address, user }: Watching,
  subject: string,
  hops: number
): Promise<void> => {
  await arrive(user, inboxMessage({ subject, from: "ann@customer.test" }));
  for (let hop = 0; hop < hops; hop += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one hop after another
    await runsEnded(admin, workflow, hop + 1);
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
    afterEach(endLiveResourceRuns);

    it("join its lineage, until its descendant limit refuses one, for good", async () => {
      await withQuotas(
        { ...configuredLimits, workflowDescendantRuns: 2 },
        async () => {
          const admin = await signedIn("admin");
          const watching = await watchingWorkflow(admin);
          const subject = `Ping ${crypto.randomUUID()}`;

          await followHops(admin, watching, subject, 3);
          await runsEnded(admin, watching.workflow, 3);
          // Settled, not delivered again: once anything connect still
          // holds is due, another minute refuses nothing more.
          await connectDb()
            .prepare("UPDATE connector_events SET retry_at = 0")
            .run();
          await arrive(watching.user);
          const sent = await sentMail(subject, 0);
          const runs = await runsEnded(admin, watching.workflow, 3);

          expect({
            // The stamp is a header core made, never the run's input.
            stamped: /^[0-9a-f]{32}$/u.test(stampOf(sent)),
            handed: runs
              .map(({ output }) => output)
              .filter(
                (output) =>
                  z.object({ stamp: z.string() }).parse(output).stamp !==
                  "unstamped"
              ),
            places: await placesOf(watching.workflow),
            refused: await refusals(watching.trigger),
          }).toStrictEqual({
            stamped: true,
            handed: [],
            places: ["root", "child", "child"],
            refused: ["workflow.lineage_limit"],
          });
        }
      );
    });

    it("are only the run's own mail, and never let a forged copy detach it: up to a bound, every copy from its sender is a child", async () => {
      const admin = await signedIn("admin");
      const watching = await watchingWorkflow(admin, { second: true });
      const subject = `Ping ${crypto.randomUUID()}`;
      await arrive(
        watching.user,
        inboxMessage({ subject, from: "ann@customer.test" })
      );
      const [first] = await runsEnded(admin, watching.workflow, 1);
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
      const runs = await runsEnded(admin, watching.workflow, 10);
      const started = await startedRuns(watching.workflow);
      const children = started.filter(({ depth }) => depth > 0);
      const outputs = new Map(
        runs.map(({ id, output }) => [
          id,
          z.object({ id: z.string(), stamp: z.string() }).parse(output),
        ])
      );
      const childIds = new Set(children.map(({ id }) => outputs.get(id)?.id));

      expect({
        runs: runs.length,
        roots: [...new Set(children.map(({ root }) => root))],
        children: children.length,
        // The run's own copy among them, and no run handed the stamp.
        own: childIds.has(own.id),
        handed: [...outputs.values()].filter(
          ({ stamp: handed }) => handed !== "unstamped"
        ),
        // Never a child: another sender, another mailbox, a made-up stamp.
        others: [fromEve, elsewhere, madeUp].filter(({ id }) =>
          childIds.has(id)
        ).length,
      }).toStrictEqual({
        runs: 10,
        roots: [first?.id],
        children: 5,
        own: true,
        handed: [],
        others: 0,
      });
    });

    it("join its lineage when it mails an SMTP alias of the watched mailbox", async () => {
      const admin = await signedIn("admin");
      const watching = await watchingWorkflow(admin, { toAlias: true });
      const subject = `Ping ${crypto.randomUUID()}`;

      await followHops(admin, watching, subject, 1);
      await runsEnded(admin, watching.workflow, 2);
      const sent = await sentMail(subject, 0);

      expect({
        to: sent.to,
        places: await placesOf(watching.workflow),
      }).toStrictEqual({
        to: [watching.alias],
        places: ["root", "child"],
      });
    });

    it("join its lineage when its copy comes from an SMTP alias of the account it was sent from", async () => {
      const admin = await signedIn("admin");
      const watching = await watchingWorkflow(admin);
      const subject = `Ping ${crypto.randomUUID()}`;
      await arrive(
        watching.user,
        inboxMessage({ subject, from: "ann@customer.test" })
      );
      await runsEnded(admin, watching.workflow, 1);
      const sent = await sentMail(subject, 0);
      // As a provider sending as the alias writes its From.
      await arrive(
        watching.user,
        inboxMessage({ subject, from: watching.alias, stamp: stampOf(sent) })
      );
      await runsEnded(admin, watching.workflow, 2);

      await expect(placesOf(watching.workflow)).resolves.toStrictEqual([
        "root",
        "child",
      ]);
    });

    it("join its lineage when its permissions name the watched mailbox by its user's object ID", async () => {
      const admin = await signedIn("admin");
      const watching = await watchingWorkflow(admin, { byId: true });
      const subject = `Ping ${crypto.randomUUID()}`;

      await followHops(admin, watching, subject, 1);
      await runsEnded(admin, watching.workflow, 2);

      await expect(placesOf(watching.workflow)).resolves.toStrictEqual([
        "root",
        "child",
      ]);
    });

    it("start a root when its copy reaches another user's mailbox, watched by ID, that it didn't mail", async () => {
      const admin = await signedIn("admin");
      // It sends from the other mailbox to the account's own address; its
      // copy, From its sender, shows up in the other mailbox.
      const watching = await watchingWorkflow(admin, { byOtherId: true });
      const subject = `Ping ${crypto.randomUUID()}`;

      await followHops(admin, watching, subject, 1);
      await runsEnded(admin, watching.workflow, 2);

      await expect(placesOf(watching.workflow)).resolves.toStrictEqual([
        "root",
        "root",
      ]);
    });

    it("join its lineage when it mails a plus-address of the watched mailbox", async () => {
      const admin = await signedIn("admin");
      const watching = await watchingWorkflow(admin, { plusTag: "loop" });
      const subject = `Ping ${crypto.randomUUID()}`;

      await followHops(admin, watching, subject, 1);
      await runsEnded(admin, watching.workflow, 2);
      const sent = await sentMail(subject, 0);

      expect({
        to: sent.to,
        places: await placesOf(watching.workflow),
      }).toStrictEqual({
        to: [`${watching.user}+loop@acme.test`],
        places: ["root", "child"],
      });
    });

    it("join its lineage from an account whose sign-in name, which its permissions name, isn't the address it sends from", async () => {
      const admin = await signedIn("admin");
      const watching = await watchingWorkflow(admin, {
        aliased: true,
        byName: true,
      });
      const subject = `Ping ${crypto.randomUUID()}`;

      await followHops(admin, watching, subject, 1);
      await runsEnded(admin, watching.workflow, 2);

      await expect(placesOf(watching.workflow)).resolves.toStrictEqual([
        "root",
        "child",
      ]);
    });

    it("join its lineage from an account whose sign-in name isn't the address it sends from", async () => {
      const admin = await signedIn("admin");
      const watching = await watchingWorkflow(admin, { aliased: true });
      const subject = `Ping ${crypto.randomUUID()}`;

      await followHops(admin, watching, subject, 1);
      await runsEnded(admin, watching.workflow, 2);
      const sent = await sentMail(subject, 0);

      expect({
        signInName: watching.signInName,
        from: sent.mailbox,
        to: sent.to,
        places: await placesOf(watching.workflow),
      }).toStrictEqual({
        signInName: `${watching.user}@acme.onmicrosoft.test`,
        from: watching.signInName,
        to: [`${watching.user}@acme.test`],
        places: ["root", "child"],
      });
    });

    it("forget a run's stamps, and what claimed them, once its details are removed", async () => {
      await withQuotas(
        { ...configuredLimits, workflowNestingLevels: 2 },
        async () => {
          const admin = await signedIn("admin");
          const watching = await watchingWorkflow(admin);
          const subject = `Ping ${crypto.randomUUID()}`;
          await followHops(admin, watching, subject, 2);
          const runs = await runsEnded(admin, watching.workflow, 2);
          const stamps = [
            stampOf(await sentMail(subject, 0)),
            stampOf(await sentMail(subject, 1)),
          ];
          const kept = async () =>
            await env.DB.prepare(
              "SELECT (SELECT count(*) FROM resource_run_mail_calls WHERE run_id IN (?1, ?2)) AS calls, (SELECT count(*) FROM run_mail_stamp_claims WHERE stamp IN (?3, ?4)) AS claims"
            )
              .bind(runs[0]?.id ?? "", runs[1]?.id ?? "", ...stamps)
              .first<{ calls: number; claims: number }>();
          const before = await kept();

          // Past every run's retention (the deployment's 30 days).
          await runQuarterHourTasks({}, new Date(Date.now() + 31 * day));

          expect({
            before,
            refused: await refusals(watching.trigger),
            after: await kept(),
          }).toStrictEqual({
            before: { calls: 2, claims: 2 },
            refused: ["workflow.lineage_limit"],
            after: { calls: 0, claims: 0 },
          });
        }
      );
    });
  }
);

// Kept until a JSON run's mail can wait for its person: an App's
// restricted run, as before.
describe(
  "runs an App run's mail to a watched mailbox starts",
  { timeout: 180_000 },
  () => {
    afterEach(endLiveRuns);
  }
);

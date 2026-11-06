import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { invoiceMail } from "../../connect/test/fixtures/graph-events.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { consentCode, graphControlUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import {
  endedRun,
  jsonWorkflowAppsOf,
  objectSchema,
  publishedWorkflow,
} from "./json-workflow-apps.ts";
import type { Person } from "./json-workflow-apps.ts";
import { runMinuteTasks } from "./maintenance.ts";
import { fullScan, planOf, recordedQueries } from "./query-plans.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { routed, unique } from "./sign-in.ts";
import { connectDb, testBinding } from "./test-env.ts";

// Connector events end to end: a builder's connector trigger listens for
// new mail on their Microsoft 365 connection and starts their independent
// workflow; core's clock tells the real connect where to listen, connect
// reads Graph's recorded delta answers (the stand-in behind it,
// test/connect-providers.ts), and core delivers what it read to the
// trigger. connector-triggers.test.ts delivers events straight to core,
// for who hears what.

const idp = mockIdp();
const { signedIn } = jsonWorkflowAppsOf(idp);

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** A message arriving in `mailbox`'s inbox, at Graph. */
const receive = async (mailbox: string, message: unknown): Promise<void> => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  await providers.fetch(graphControlUrl, {
    method: "POST",
    body: JSON.stringify({ mailbox, message }),
  });
};

/** The person's own Microsoft 365 account, connected: its ID. */
const connectOwn = async (person: Person): Promise<string> => {
  const oid = String(person.person.oid);
  const { url } = await person.api.connections.start({
    provider: "microsoft",
    scope: "personal",
  });
  const authorization = new URL(url);
  const query = new URLSearchParams({
    code: consentCode(authorization, acmeTenant, oid),
    state: authorization.searchParams.get("state") ?? "",
  });
  await routed(`/api/connections/callback?${query.toString()}`, {
    headers: { cookie: person.session },
  });
  const [connection] = await person.api.connections.list();
  if (connection === undefined) {
    throw new Error("Expected the connection");
  }
  return connection.id;
};

const mailFields = { id: { type: "string" }, subject: { type: "string" } };

/** The inbox workflow: it hands back the mail's ID and subject it started with. */
const inbox = JSON.stringify({
  $schema: workflowSchemaUrl,
  input: objectSchema(mailFields),
  output: {
    schema: objectSchema(mailFields),
    value: {
      id: { $expr: "input.id" },
      subject: { $expr: "input.subject" },
    },
  },
  steps: [],
});

/**
 * A builder's inbox workflow, started by their connector trigger on new
 * mail in their own connection's mailbox, which an admin let start the
 * workflow and hear the connection.
 */
const listening = async () => {
  const builder = await signedIn("builder");
  const connection = await connectOwn(builder);
  const workflow = await publishedWorkflow(builder, () => inbox);
  const trigger = await builder.api.workflowResources.triggers.create({
    kind: "connector",
    workflowId: workflow.id,
    version: 1,
    config: {
      connection: { connectionId: connection },
      event: "m365.mail.received",
      input: { fields: { id: "/id", subject: "/payload/subject" } },
    },
  });
  const subject = { type: "trigger", triggerId: trigger.id } as const;
  await requestGranted(idp, builder, {
    subject,
    object: { type: "workflow", workflowId: workflow.id },
    actions: ["start"],
    binding: `START_${unique().toUpperCase()}`,
  });
  await requestGranted(idp, builder, {
    subject,
    object: { type: "connection", connectionId: connection },
    actions: ["mail.list"],
    binding: `HEAR_${unique().toUpperCase()}`,
  });
  return {
    builder,
    connection,
    workflow: workflow.id,
    trigger: trigger.id,
    mailbox: String(builder.person.oid),
  };
};

/** Where connect listens on `connection`: the event types. */
const sources = async (connection: string): Promise<string[]> => {
  const { results } = await connectDb()
    .prepare("SELECT type FROM event_sources WHERE connection_id = ?")
    .bind(connection)
    .all();
  return z
    .array(z.object({ type: z.string() }))
    .parse(results)
    .map(({ type }) => type);
};

/** A minute passes for connect's sources: each is due for a read. */
const aMinuteLater = async (): Promise<void> => {
  await connectDb().prepare("UPDATE event_sources SET poll_at = 0").run();
};

/** Every run of `workflow` so far, once each has ended. */
const endedRuns = async (
  builder: Person,
  workflow: string
): Promise<WorkflowResourceRun[]> => {
  const runs = await builder.api.workflowResources.runs(workflow);
  return await Promise.all(
    runs.map(async ({ id }) => await endedRun(builder, workflow, id))
  );
};

/** Outputs in the order of their mail's ID. */
const byId = (a: unknown, b: unknown): number =>
  JSON.stringify(a).localeCompare(JSON.stringify(b));

describe("connector events", () => {
  it("start the listening workflow once for a new mail in its mailbox", async () => {
    const { builder, connection, workflow, mailbox } = await listening();
    await runMinuteTasks();
    const mail = invoiceMail(mailbox, 7, new Date().toISOString());
    await receive(mailbox, mail);
    await aMinuteLater();
    await runMinuteTasks();
    // Graph shows the message again once it's read: the same message.
    await receive(mailbox, { ...mail, isRead: true });
    await aMinuteLater();
    await runMinuteTasks();
    const runs = await endedRuns(builder, workflow);
    const events = await allEvents();

    expect({
      runs: runs.map(({ status, output }) => ({ status, output })),
      reads: events
        .filter(
          ({ action, target }) =>
            action.startsWith("connection.events.") && target?.id === connection
        )
        .map(({ action, provenance }) => [action, provenance]),
    }).toStrictEqual({
      runs: [
        {
          status: "completed",
          output: { id: mail.id, subject: "Invoice INV-7" },
        },
      ],
      reads: [
        ["connection.events.started", []],
        ["connection.events.read", [mail.id]],
        ["connection.events.read", [mail.id]],
      ],
    });
  });

  it("deliver only so many events a run, and the rest the next", async () => {
    const { builder, workflow, mailbox } = await listening();
    await runMinuteTasks();
    await receive(mailbox, invoiceMail(mailbox, 1, new Date().toISOString()));
    await receive(mailbox, invoiceMail(mailbox, 2, new Date().toISOString()));
    await aMinuteLater();
    await runMinuteTasks({ CONNECTOR_EVENTS_PER_RUN: "1" });
    const first = await endedRuns(builder, workflow);
    await runMinuteTasks({ CONNECTOR_EVENTS_PER_RUN: "1" });
    const second = await endedRuns(builder, workflow);

    expect({
      first: first.length,
      second: second.map(({ output }) => output).toSorted(byId),
    }).toStrictEqual({
      first: 1,
      second: [1, 2]
        .map((n) => {
          const { id, subject } = invoiceMail(mailbox, n, "");
          return { id, subject };
        })
        .toSorted(byId),
    });
  });

  it("stop listening once the trigger is disabled, and listen again once it's enabled", async () => {
    const { builder, connection, trigger } = await listening();
    await runMinuteTasks();
    const before = await sources(connection);
    await builder.api.workflowResources.triggers.setEnabled(trigger, false);
    await runMinuteTasks();
    const disabled = await sources(connection);
    await builder.api.workflowResources.triggers.setEnabled(trigger, true);
    await runMinuteTasks();

    expect({
      before,
      disabled,
      enabled: await sources(connection),
    }).toStrictEqual({
      before: ["m365.mail.received"],
      disabled: [],
      enabled: ["m365.mail.received"],
    });
  });

  it("stop listening once the trigger is deleted", async () => {
    const { builder, connection, trigger } = await listening();
    await runMinuteTasks();
    const before = await sources(connection);
    await builder.api.workflowResources.triggers.delete(trigger);
    await runMinuteTasks();

    expect({ before, after: await sources(connection) }).toStrictEqual({
      before: ["m365.mail.received"],
      after: [],
    });
  });

  it("find who listens by index, reading no table whole", async () => {
    const { connection } = await listening();
    // As the clock asks, telling connect where to listen.
    const recorded = await recordedQueries(async () => {
      await runMinuteTasks();
    });
    const lookups = recorded.filter(
      ({ query }) =>
        query.includes('"trigger_resource_versions"."event_type"') &&
        query.includes('json_each("permissions"."actions")')
    );
    const plans = await Promise.all(
      lookups.map(async (query) => await planOf(query))
    );
    const steps = plans.flat();

    expect({
      listening: await sources(connection),
      asked: lookups.length > 0,
      scans: steps.filter((step) => fullScan.test(step)),
      sorts: steps.filter((step) => step.includes("TEMP B-TREE")),
    }).toStrictEqual({
      listening: ["m365.mail.received"],
      asked: true,
      scans: [],
      sorts: [],
    });
  });
});

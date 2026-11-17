import { v } from "@grasp-os/runtime/app";
import type { AuditEvent } from "@grasp-os/shared/audit";
import type { ConnectorContract } from "@grasp-os/shared/connect";
import {
  triggerIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { drainAuditOutboxes } from "../src/audit-drains.ts";
import { readSourceVersionAs, recallAs, workBrain } from "../src/brain-next.ts";
import { producersOf, relayHandOvers } from "../src/brain-sources.ts";
import { answerCaptureIdOf } from "../src/connection-capture-key.ts";
import { createTriggerResource } from "../src/trigger-resources.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import { setWorkflowParams } from "../src/workflow-params.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { unique } from "./sign-in.ts";
import { webhookConfig } from "./source-config.ts";
import {
  descriptorOf,
  ended,
  endOf,
  granted,
  person,
  published,
  shapeOf,
} from "./workflow-calls.ts";

// What a workflow run reads through a connection, kept for the one person
// it acts for (GRA-1828, src/connection-capture.ts `captureRunRead`), by
// the chat's rules and code. Through the real engine and connect, with
// only the toolkit's MCP server faked (test/mail-server.ts). From the
// threat model on GRA-1828: someone else recalls a run's read; a run a
// trigger started copies someone's data with nobody there; a sensitive
// parameter reaches the Brain or its key; a run is refused for what it
// kept itself.

mockIdp();

/** Signing people in, connecting, granting and running can be slow on CI. */
const setUpTime = { timeout: 90_000 };

/** A word nothing else holds. */
const markerOf = (): string => `run${crypto.randomUUID().replaceAll("-", "")}`;

/** What `mail.search` takes, and what it answers. */
const searchInput = v.object({ query: v.string() });
const searchOutput = v.object({ messages: v.array(v.string()) });

/** `env`, its connect serving `mail.search` as a read of the contract's. */
const servingSearch = (): Env => {
  const contract: ConnectorContract = {
    contract: "composio.mail@1",
    actions: {
      search: {
        tool: "mail.search",
        readOnly: true,
        input: JSON.stringify(shapeOf(descriptorOf(searchInput))),
        output: JSON.stringify(shapeOf(descriptorOf(searchOutput))),
      },
    },
  };
  return {
    ...env,
    CONNECT: new Proxy(env.CONNECT, {
      get: (target, name): unknown =>
        name === "connectorContract"
          ? async () => await Promise.resolve(contract)
          : Reflect.get(target, name),
    }),
  };
};

/**
 * `owner`'s own connection to a toolkit of the company's mail (a shared
 * one without), its search a read the admin allowed, answering `messages`
 * as a toolkit does.
 */
const ownMail = async (owner: string | undefined, messages: string[]) => {
  const mail = await mailConnection(
    [],
    [{ name: "mail.search", read: true }],
    owner === undefined ? {} : { owner }
  );
  await mail.serves([
    {
      name: "mail.search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    },
  ]);
  const answered = { messages };
  await mail.answer("mail.search", {
    content: [{ type: "text", text: JSON.stringify(answered) }],
    structuredContent: answered,
  });
  return mail;
};

/**
 * A workflow of `by`'s that searches `connectionId`, approved by `admin`,
 * for its input's `who`, or for its parameter `token` (sensitive, as every
 * parameter not marked otherwise) set to `token`.
 */
const searching = async (
  by: Identity,
  admin: Identity,
  connectionId: string,
  { token }: { token?: string } = {}
) => {
  const key = `mail-search-${unique()}`;
  await publishCatalogContract(env, admin, {
    key,
    kind: "connector",
    operations: {
      "mail.search": {
        input: descriptorOf(searchInput),
        output: descriptorOf(searchOutput),
      },
    },
  });
  const { workflow, executable } = await published(by, {
    permissions: { connections: { mail: { contract: key } } },
    params:
      token === undefined
        ? {}
        : { token: { label: "Token", type: { kind: "string" } } },
    steps: [
      {
        id: "search",
        type: "call",
        connection: "mail",
        action: "mail.search",
        args: {
          query: { $expr: token === undefined ? "args.who" : "params.token" },
        },
      },
    ],
    status: "search.messages[0]",
  });
  if (token !== undefined) {
    await setWorkflowParams(env, by, workflow.id, {
      values: { token },
      expectedRevision: 0,
    });
  }
  const permissionId = await granted(by, admin, {
    subject: { type: "workflow", workflowId: workflow.id },
    object: { type: "connection", connectionId },
    actions: ["mail.search"],
    binding: `MAIL_${unique().toUpperCase().replaceAll("-", "_")}`,
  });
  const serving = servingSearch();
  await approveWorkflowBinding(serving, admin, workflow.id, {
    alias: "mail",
    target: { kind: "connector", permissionId, contract: "composio.mail@1" },
    reviewed: { version: 1 },
  });
  return { workflow, executable, serving };
};

/** Starts workflow `id` as `invoker` for `who`: its run's ID. */
const startedAs = async (
  serving: Env,
  invoker: Parameters<typeof startWorkflow>[1],
  id: string,
  who: string
): Promise<string> => {
  const { runId } = await startWorkflow(serving, invoker, id, {
    expected: 1,
    args: { who },
    key: unique(),
  });
  if (runId === null) {
    throw new Error("The start admitted no run");
  }
  return runId;
};

/** The source ids `personId` recalls for `marker` whose text holds it. */
const recalled = async (
  personId: string,
  marker: string,
  personal = true
): Promise<string[]> => {
  const { items } = await recallAs(env, personId, {
    personal,
    question: marker,
    budget: { tokens: 4000 },
  });
  return [
    ...new Set(
      items
        .filter(({ text }) => text.includes(marker))
        .map(({ source }) => `${source.producer}:${source.id}`)
    ),
  ];
};

/** The capture events about `connectionId`. */
const capturesOf = async (connectionId: string): Promise<AuditEvent[]> => {
  const events = await allEvents();
  return events.filter(
    ({ action, target }) =>
      action.startsWith("brain.capture.") && target?.id === connectionId
  );
};

/** The capture events about `connectionId`, once `count` of them are in. */
const captures = async (
  connectionId: string,
  count: number
): Promise<AuditEvent[]> => {
  await vi.waitFor(
    async () => {
      const found = await capturesOf(connectionId);
      expect(found).toHaveLength(count);
    },
    { timeout: 10_000, interval: 50 }
  );
  return await capturesOf(connectionId);
};

/** Hands over what changed, as core's clock does: drain, relay, a tick. */
const handedOver = async (): Promise<void> => {
  await drainAuditOutboxes(env);
  await relayHandOvers(env);
  await workBrain(env, new Date(Date.now() + 60_000), producersOf(env));
};

/** What the Brain keeps in `personId`'s own store of run `runId`: its text. */
const keptOf = async (personId: string, runId: string) => {
  const kept = await readSourceVersionAs(env, personId, {
    source: { producer: "run", id: runId },
    version: 1,
  });
  return kept?.text;
};

/** An event as the tests compare it. */
const shown = ({ action, actor, detail }: AuditEvent) => ({
  action,
  actor: actor.type,
  detail,
});

describe("what a workflow run reads through a connection", setUpTime, () => {
  it("keeps a read of a run a person started, through their own connection, for them alone, and the run ends with its result shown", async () => {
    const [admin, ada, ben] = await Promise.all([
      person("admin"),
      person("builder"),
      person("builder"),
    ]);
    const marker = markerOf();
    const mail = await ownMail(ada.userId, [`Ada's quote ${marker}`]);
    const { workflow, executable, serving } = await searching(
      ada,
      admin,
      mail.id
    );
    const runId = await startedAs(
      serving,
      { type: "person", person: ada },
      workflow.id,
      marker
    );
    const run = await ended(ada, workflow.id, runId);
    const events = await captures(mail.id, 1);
    await handedOver();
    const kept = `capture:${await answerCaptureIdOf(
      mail.id,
      ada.userId,
      "mail.search",
      { query: marker }
    )}`;
    expect({
      executable,
      // What it kept is not a read of the Brain: nothing of it joins the
      // run's evidence, whose check would refuse a version only Ada may
      // read, so the run ends and its result is shown.
      end: endOf(run),
      events: events.map(shown),
      ada: await recalled(ada.userId, marker),
      ben: await recalled(ben.userId, marker),
      // As an App, a workflow or the SDK asks: the shared store alone.
      asCode: await recalled(ada.userId, marker, false),
      // What it returned copies what it kept: the Brain keeps only how it
      // ended, so no copy outlives the capture's erasure on a disconnect.
      handedOver: await keptOf(ada.userId, runId),
    }).toStrictEqual({
      executable: true,
      end: { status: "completed", output: { status: `Ada's quote ${marker}` } },
      events: [
        {
          action: "brain.capture.kept",
          actor: "system",
          detail: { items: 1, kept: 1, failed: 0, skipped: 0, run: runId },
        },
      ],
      ada: [kept],
      ben: [],
      asCode: [],
      handedOver: "Workflow run completed.",
    });
  });

  it("keeps nothing of an answer the run doesn't take, outside its contract", async () => {
    const [admin, ada] = await Promise.all([
      person("admin"),
      person("builder"),
    ]);
    const marker = markerOf();
    const mail = await ownMail(ada.userId, []);
    // Text, where the contract has `{ messages }`: the step refuses it.
    await mail.answer("mail.search", {
      content: [{ type: "text", text: `Ada's quote ${marker}` }],
    });
    const { workflow, serving } = await searching(ada, admin, mail.id);
    const runId = await startedAs(
      serving,
      { type: "person", person: ada },
      workflow.id,
      marker
    );
    const end = endOf(await ended(ada, workflow.id, runId));
    expect({
      end,
      events: await capturesOf(mail.id),
      ada: await recalled(ada.userId, marker),
    }).toStrictEqual({
      end: { status: "failed", code: "workflow.call_invalid" },
      events: [],
      ada: [],
    });
  });

  it("keeps nothing of a run a trigger started, which acts as the workflow itself", async () => {
    const [admin, ada] = await Promise.all([
      person("admin"),
      person("builder"),
    ]);
    const [quote, byPerson, byTrigger] = [markerOf(), markerOf(), markerOf()];
    const mail = await ownMail(ada.userId, [`Ada's quote ${quote}`]);
    const { workflow, serving } = await searching(ada, admin, mail.id);
    const trigger = await createTriggerResource(env, ada, {
      kind: "webhook",
      workflowId: workflow.id,
      config: await webhookConfig(),
    });
    await granted(ada, admin, {
      subject: {
        type: "trigger",
        triggerId: triggerIdSchema.parse(trigger.id),
      },
      object: {
        type: "workflow",
        workflowId: workflowResourceIdSchema.parse(workflow.id),
      },
      actions: ["start"],
      binding: `START_${unique().toUpperCase().replaceAll("-", "_")}`,
    });
    // The trigger's run first, then its twin a person started: the same
    // read through the same connection, each its own call, so its own key.
    const triggerRun = await startedAs(
      serving,
      { type: "trigger", triggerId: trigger.id },
      workflow.id,
      byTrigger
    );
    const triggerEnd = endOf(await ended(ada, workflow.id, triggerRun));
    const personRun = await startedAs(
      serving,
      { type: "person", person: ada },
      workflow.id,
      byPerson
    );
    await ended(ada, workflow.id, personRun);
    const events = await captures(mail.id, 1);
    const keyOf = async (query: string) =>
      `capture:${await answerCaptureIdOf(mail.id, ada.userId, "mail.search", {
        query,
      })}`;
    expect({
      triggerEnd: triggerEnd.status,
      runs: events.map(({ detail }) => detail.run),
      ada: await recalled(ada.userId, quote),
    }).toStrictEqual({
      triggerEnd: "completed",
      runs: [personRun],
      // Kept under the person's run's call alone, never the trigger's.
      ada: [await keyOf(byPerson)],
    });
  });

  it("keeps nothing of a call that passes a sensitive parameter, its value in no event", async () => {
    const [admin, ada] = await Promise.all([
      person("admin"),
      person("builder"),
    ]);
    const marker = markerOf();
    const token = `secret${markerOf()}`;
    const mail = await ownMail(ada.userId, [`Ada's quote ${marker}`]);
    const { workflow, serving } = await searching(ada, admin, mail.id, {
      token,
    });
    const runId = await startedAs(
      serving,
      { type: "person", person: ada },
      workflow.id,
      "Ada"
    );
    const end = endOf(await ended(ada, workflow.id, runId));
    const events = await captures(mail.id, 1);
    expect({
      end,
      events: events.map(shown),
      ada: await recalled(ada.userId, marker),
      inEvents: JSON.stringify(await allEvents()).includes(token),
    }).toStrictEqual({
      end: { status: "completed", output: { status: `Ada's quote ${marker}` } },
      events: [
        {
          action: "brain.capture.skipped",
          actor: "system",
          detail: {
            reason: "sensitive",
            items: 1,
            kept: 0,
            failed: 0,
            skipped: 1,
            run: runId,
          },
        },
      ],
      ada: [],
      inEvents: false,
    });
  });

  it("keeps nothing of a read through a shared connection in anyone's own store", async () => {
    const [admin, ada] = await Promise.all([
      person("admin"),
      person("builder"),
    ]);
    const marker = markerOf();
    // A colleague's own connection is no run's of Ada's at all: connect
    // refuses the call (`connect.not_owner`). A shared one is the shared
    // Brain's (GRA-1831), never a person's own.
    const secret = `hunter${markerOf()}`;
    const shared = await ownMail(undefined, [
      `The team's quote ${marker} password=${secret}`,
    ]);
    const { workflow, serving } = await searching(ada, admin, shared.id);
    const runId = await startedAs(
      serving,
      { type: "person", person: ada },
      workflow.id,
      marker
    );
    const end = endOf(await ended(ada, workflow.id, runId));
    const events = await captures(shared.id, 1);
    await handedOver();
    const handed = (await keptOf(ada.userId, runId)) ?? "";
    expect({
      end: end.status,
      events: events.map(({ action, detail }) => ({
        action,
        reason: detail.reason,
      })),
      ada: await recalled(ada.userId, marker).then((ids) =>
        ids.filter((id) => !id.startsWith("run:"))
      ),
      // Nothing kept, so what it returned is handed over, redacted.
      handedOver: {
        result: handed.includes(marker),
        secret: handed.includes(secret),
      },
    }).toStrictEqual({
      end: "completed",
      events: [{ action: "brain.capture.skipped", reason: "shared" }],
      ada: [],
      handedOver: { result: true, secret: false },
    });
  });
});

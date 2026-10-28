import { chatIdSchema, workflowResourceIdSchema } from "@grasp-os/shared/ids";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { AgentScope } from "../src/agent-scope.ts";
import { memberOf } from "../src/auth/identity.ts";
import { confirmHeldStart } from "../src/held-starts.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import { openTestRun, personalChatsOf } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// A chat's agent asking to start an independent workflow
// (agent-workflows.ts, `start`; held-starts.ts), from its threat model:
// nothing runs until the person it acts for confirms it in Grasp, so a
// start an instruction it read steered it to stays held; only that person
// confirms, exactly what they were shown; the agent's own grant and the
// person's role are both needed, held and confirmed; the same key in the
// chat is one start; a restricted chat's start runs restricted; a chat
// app's chat is refused in favour of an offer; and every step is audited.

const idp = mockIdp();

/** Signing people in, granting and running can be slow on CI. */
const setUpTime = { timeout: 120_000 };

/** A definition of `name` that greets whoever its input names. */
const greeting = (name: string): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params: {}, bindings: {} },
      },
    },
    input: {
      schema: {
        format: "json",
        document: {
          type: "object",
          properties: { who: { type: "string" } },
          required: ["who"],
          additionalProperties: false,
        },
      },
    },
    output: {
      schema: {
        format: "json",
        document: {
          type: "object",
          properties: { status: { type: "string" } },
          required: ["status"],
          additionalProperties: false,
        },
      },
    },
    do: [{ finish: { set: { status: "done" } } }],
  });

type Session = Awaited<ReturnType<typeof signedInApi>>;

/**
 * A workflow a builder published, shared with `userId` unless `shared` is
 * false, and the builder's session, who asks for grants on it.
 */
const workflowFor = async (userId: string, shared = true) => {
  const builder = await signedInApi(idp, "builder");
  const by = await memberOf(env.DB, builder.userId);
  if (by === undefined) {
    throw new Error("Expected the builder to be a member");
  }
  const workflow = await createWorkflowResource(env, by, `greet-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: greeting(workflow.name),
    basedOn: null,
  });
  if (shared) {
    await shareWorkflowResource(env, by, workflow.id, {
      type: "person",
      id: userId,
      role: "user",
    });
  }
  return { workflow, builder };
};

/** `start` on `workflow` for `agentId`, asked by `builder`, granted by an admin. */
const grantStart = async (
  builder: Session,
  agentId: string,
  workflow: string
): Promise<string> =>
  await requestGranted(idp, builder, {
    subject: { type: "agent", agentId },
    object: {
      type: "workflow",
      workflowId: workflowResourceIdSchema.parse(workflow),
    },
    actions: ["start"],
    binding: `START_${unique().toUpperCase().replaceAll("-", "_")}`,
  });

/**
 * A chat of `person`'s, and `env.workflows` as its code reaches it, in a
 * code run of its own; through a chat app when `via` says.
 */
const chatOf = async (
  chats: Awaited<ReturnType<typeof personalChatsOf>>,
  person: Session,
  via?: AgentScope["via"]
) => {
  const { chat } = await chats.newChat();
  const chatId = chatIdSchema.parse(chat.id);
  /** `env.workflows` in a new code run of the chat. */
  const inRun = async () => {
    const runId = await openTestRun(chats.stub, chatId);
    const scope: AgentScope = {
      workspaceId: chats.id,
      agentId: chats.agent.agentId,
      chatId,
      personId: person.userId,
      runId,
      ...(via === undefined ? {} : { via }),
    };
    return exports.WorkflowsApi({ props: scope });
  };
  return { chatId, workflows: await inRun(), inRun };
};

/** The runs of workflow `id`: whom each acts for, and whether restricted. */
const runsOf = async (id: string) => {
  const { results } = await env.DB.prepare(
    "SELECT run.id, run.principal_id AS principal, run.restricted, receipt.invoker_type AS invoker, receipt.invoker_id AS agent FROM workflow_resource_runs AS run JOIN workflow_start_receipts AS receipt ON receipt.id = run.id WHERE run.workflow_resource_id = ? ORDER BY receipt.created_at"
  )
    .bind(id)
    .all<{
      id: string;
      principal: string;
      restricted: number;
      invoker: string;
      agent: string;
    }>();
  return results;
};

describe("a chat's agent asking to start a workflow", setUpTime, () => {
  it("runs nothing until its person confirms exactly what they were shown, and only they can", async () => {
    const person = await signedInApi(idp, "user");
    const someoneElse = await signedInApi(idp, "user");
    const { workflow, builder } = await workflowFor(person.userId);
    const chats = await personalChatsOf(person.userId);
    await grantStart(builder, chats.agent.agentId, workflow.id);
    const { chatId, workflows } = await chatOf(chats, person);

    // As an instruction it read might steer it to.
    const asked = await workflows.start(workflow.id, { who: "Ada" }, "greet");
    const askedAgain = await workflows.start(
      workflow.id,
      { who: "Ada" },
      "greet"
    );
    const beforeConfirm = await runsOf(workflow.id);
    const [listed] = await person.api.heldStarts.list();
    const othersList = await someoneElse.api.heldStarts.list();
    const othersConfirm = await outcome(
      someoneElse.api.heldStarts.confirm(
        listed?.id ?? "",
        listed?.inputHash ?? ""
      )
    );
    const changed = await outcome(
      person.api.heldStarts.confirm(listed?.id ?? "", "not-what-was-shown")
    );
    const confirmed = await person.api.heldStarts.confirm(
      listed?.id ?? "",
      listed?.inputHash ?? ""
    );
    const twice = await outcome(
      person.api.heldStarts.confirm(listed?.id ?? "", listed?.inputHash ?? "")
    );
    const afterConfirm = await runsOf(workflow.id);
    const standing = await workflows.start(
      workflow.id,
      { who: "Ada" },
      "greet"
    );
    const events = await allEvents();
    const about = events.filter(
      ({ action, target }) =>
        action.startsWith("workflow.start.") && target?.id === workflow.id
    );

    expect({
      asked: { status: asked.status, sameHeld: askedAgain.held === asked.held },
      beforeConfirm: beforeConfirm.length,
      listed: {
        workflow: listed?.workflow,
        input: listed?.input,
        chatId: listed?.chatId,
      },
      othersList: othersList.length,
      othersConfirm,
      changed,
      twice,
      afterConfirm: afterConfirm.map(({ id, principal, invoker, agent }) => ({
        isConfirmed: id === confirmed.run,
        principal,
        invoker,
        agent,
      })),
      standing: {
        status: standing.status,
        start: "start" in standing ? standing.start : null,
      },
      audited: about.map(({ action, actor, detail }) => ({
        action,
        actor:
          actor.type === "agent"
            ? { type: "agent", onBehalfOf: actor.onBehalfOf }
            : actor.type,
        chat: detail.chat ?? null,
      })),
    }).toStrictEqual({
      asked: { status: "waiting", sameHeld: true },
      beforeConfirm: 0,
      listed: { workflow: workflow.id, input: { who: "Ada" }, chatId },
      othersList: 0,
      othersConfirm: "workflow.start_held_gone",
      changed: "workflow.start_held_changed",
      twice: "workflow.start_held_gone",
      afterConfirm: [
        {
          isConfirmed: true,
          principal: person.userId,
          invoker: "agent",
          agent: chats.agent.agentId,
        },
      ],
      standing: { status: "started", start: confirmed.start },
      audited: [
        {
          action: "workflow.start.held",
          actor: { type: "agent", onBehalfOf: person.userId },
          chat: chatId,
        },
        { action: "workflow.start.confirmed", actor: "person", chat: null },
        {
          action: "workflow.start.admitted",
          actor: { type: "agent", onBehalfOf: person.userId },
          chat: chatId,
        },
      ],
    });
  });

  it("never runs a start its person declines or lets lapse, and refuses one it couldn't run", async () => {
    const person = await signedInApi(idp, "user");
    const { workflow, builder } = await workflowFor(person.userId);
    const { workflow: notTheirs, builder: otherBuilder } = await workflowFor(
      person.userId,
      false
    );
    const { workflow: ungranted } = await workflowFor(person.userId);
    const chats = await personalChatsOf(person.userId);
    await grantStart(builder, chats.agent.agentId, workflow.id);
    await grantStart(otherBuilder, chats.agent.agentId, notTheirs.id);
    const { workflows } = await chatOf(chats, person);

    const held = await workflows.start(
      workflow.id,
      { who: "Ada" },
      "decline-me"
    );
    await person.api.heldStarts.decline(held.held);
    const declined = await workflows.start(
      workflow.id,
      { who: "Ada" },
      "decline-me"
    );
    const lapsing = await workflows.start(workflow.id, { who: "Bo" }, "lapse");
    await env.DB.prepare(
      "UPDATE agent_held_starts SET expires_at = ? WHERE id = ?"
    )
      .bind(Date.now() - 1000, lapsing.held)
      .run();
    const lapsed = await workflows.start(workflow.id, { who: "Bo" }, "lapse");
    const lapsedConfirm = await outcome(
      person.api.heldStarts.confirm(lapsing.held, "any")
    );
    const stillWaiting = await person.api.heldStarts.list();
    const runs = await runsOf(workflow.id);

    expect({
      declined: declined.status,
      lapsed: lapsed.status,
      lapsedConfirm,
      waiting: stillWaiting.length,
      runs: runs.length,
      ungranted: await outcome(
        workflows.start(ungranted.id, { who: "Ada" }, "ungranted")
      ),
      noRole: await outcome(
        workflows.start(notTheirs.id, { who: "Ada" }, "no-role")
      ),
      badInput: await outcome(
        workflows.start(workflow.id, { whom: "Ada" }, "bad-input")
      ),
    }).toStrictEqual({
      declined: "declined",
      lapsed: "lapsed",
      lapsedConfirm: "workflow.start_held_gone",
      waiting: 0,
      runs: 0,
      ungranted: "workflow.start_denied",
      noRole: "workflow.resource_unavailable",
      badInput: "workflow.start_invalid",
    });
  });

  it("tells the agent a confirmed start refused for good, and lets its person confirm again one that stopped on the way", async () => {
    const person = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const { workflow, builder } = await workflowFor(person.userId);
    const chats = await personalChatsOf(person.userId);
    const grant = await grantStart(builder, chats.agent.agentId, workflow.id);
    const chat = await chatOf(chats, person);
    let { workflows } = chat;

    // Refused as it starts: the agent's grant revoked after it was held.
    const refusedHeld = await workflows.start(
      workflow.id,
      { who: "Ada" },
      "refused"
    );
    const [toRefuse] = await person.api.heldStarts.list();
    await admin.api.permissions.revoke(grant);
    const refusedConfirm = await outcome(
      person.api.heldStarts.confirm(refusedHeld.held, toRefuse?.inputHash ?? "")
    );
    // A revocation ends the code run under way: the agent asks in its next.
    workflows = await chat.inRun();
    const refused = await workflows.start(
      workflow.id,
      { who: "Ada" },
      "refused"
    );
    const afterRefusal = await person.api.heldStarts.list();
    await grantStart(builder, chats.agent.agentId, workflow.id);
    workflows = await chat.inRun();

    // Stopped between its confirmation and its start, as a failure of
    // core's would leave it.
    const stopped = await workflows.start(
      workflow.id,
      { who: "Bo" },
      "stopped"
    );
    await env.DB.prepare(
      "UPDATE agent_held_starts SET decision = 'confirmed', decided_at = ? WHERE id = ?"
    )
      .bind(Date.now(), stopped.held)
      .run();
    const meanwhile = await workflows.start(
      workflow.id,
      { who: "Bo" },
      "stopped"
    );
    const [open] = await person.api.heldStarts.list();
    const confirmedAgain = await person.api.heldStarts.confirm(
      stopped.held,
      open?.inputHash ?? ""
    );
    // Started, but stopped before it was noted: the agent learns it from
    // the start's receipt.
    await env.DB.prepare(
      "UPDATE agent_held_starts SET start_id = NULL WHERE id = ?"
    )
      .bind(stopped.held)
      .run();
    const learned = await workflows.start(
      workflow.id,
      { who: "Bo" },
      "stopped"
    );
    const runs = await runsOf(workflow.id);

    expect({
      refusedConfirm,
      refused: {
        status: refused.status,
        code: "code" in refused ? refused.code : null,
      },
      afterRefusal: afterRefusal.length,
      meanwhile: meanwhile.status,
      open: open?.id === stopped.held,
      learned: {
        status: learned.status,
        start: "start" in learned ? learned.start : null,
      },
      runs: runs.map(({ id }) => id === confirmedAgain.run),
    }).toStrictEqual({
      refusedConfirm: "workflow.start_denied",
      refused: { status: "refused", code: "workflow.start_denied" },
      afterRefusal: 0,
      meanwhile: "waiting",
      open: true,
      learned: { status: "started", start: confirmedAgain.start },
      runs: [true],
    });
  });

  it("never runs a start declined as it is admitted, refuses a decline once it was, and keeps a start core stopped before noting", async () => {
    const person = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const { workflow, builder } = await workflowFor(person.userId);
    const chats = await personalChatsOf(person.userId);
    const grant = await grantStart(builder, chats.agent.agentId, workflow.id);
    const chat = await chatOf(chats, person);
    const by = await person.api.whoami();

    // Declined while its confirmation is admitting it.
    const raced = await chat.workflows.start(
      workflow.id,
      { who: "Ada" },
      "raced"
    );
    const [racedOpen] = await person.api.heldStarts.list();
    let admitting = false;
    let declined = "";
    const racing: D1Database = new Proxy(env.DB, {
      get: (target, property): unknown => {
        const value: unknown = Reflect.get(target, property);
        if (property === "prepare") {
          return (query: string) => {
            if (/^insert into "workflow_start_receipts"/iu.test(query)) {
              admitting = true;
            }
            return target.prepare(query);
          };
        }
        if (property === "batch" && typeof value === "function") {
          return async (...args: unknown[]): Promise<unknown> => {
            if (admitting && declined === "") {
              declined = await outcome(
                person.api.heldStarts.decline(raced.held)
              );
            }
            return await Reflect.apply(value, target, args);
          };
        }
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
    const racedConfirm = await outcome(
      confirmHeldStart(
        { ...env, DB: racing },
        by,
        raced.held,
        racedOpen?.inputHash ?? ""
      )
    );
    const runsAfterRace = await runsOf(workflow.id);

    // Admitted, then core stopped before noting its start.
    const kept = await chat.workflows.start(workflow.id, { who: "Bo" }, "kept");
    const [keptOpen] = await person.api.heldStarts.list();
    const confirmed = await person.api.heldStarts.confirm(
      kept.held,
      keptOpen?.inputHash ?? ""
    );
    await env.DB.prepare(
      "UPDATE agent_held_starts SET start_id = NULL WHERE id = ?"
    )
      .bind(kept.held)
      .run();
    const lateDecline = await outcome(person.api.heldStarts.decline(kept.held));
    // The grant revoked meanwhile: confirming again names the start made.
    await admin.api.permissions.revoke(grant);
    const again = await person.api.heldStarts.confirm(
      kept.held,
      keptOpen?.inputHash ?? ""
    );

    const runsAtEnd = await runsOf(workflow.id);

    expect({
      declined,
      racedConfirm,
      runsAfterRace: runsAfterRace.length,
      lateDecline,
      again: again.start === confirmed.start,
      runs: runsAtEnd.map(({ id }) => id === confirmed.run),
    }).toStrictEqual({
      declined: "ok",
      racedConfirm: "workflow.start_held_gone",
      runsAfterRace: 0,
      lateDecline: "workflow.start_held_gone",
      again: true,
      runs: [true],
    });
  });

  it("runs a restricted chat's confirmed start restricted, and refuses a chat app's start for an offer", async () => {
    const person = await signedInApi(idp, "user");
    const { workflow, builder } = await workflowFor(person.userId);
    const chats = await personalChatsOf(person.userId);
    await grantStart(builder, chats.agent.agentId, workflow.id);
    const restricted = await chatOf(chats, person);
    await chats.stub.restrictChat(restricted.chatId);
    const teams = await chatOf(chats, person, "teams");

    const held = await restricted.workflows.start(
      workflow.id,
      { who: "Ada" },
      "restricted"
    );
    // Confirmed from the inbox: the feed of what waits, and its verdict.
    const feed = await person.api.waiting.list();
    const item = feed.items.find(({ kind }) => kind === "heldStart");
    await person.api.waiting.settle({
      kind: "heldStart",
      id: held.held,
      verdict: "confirm",
      inputHash: item?.kind === "heldStart" ? item.start.inputHash : "",
    });
    const runs = await runsOf(workflow.id);

    expect({
      item: item?.kind === "heldStart" ? item.verdicts : null,
      restricted: runs.map(({ restricted: isRestricted }) => isRestricted),
      teams: await outcome(
        teams.workflows.start(workflow.id, { who: "Ada" }, "teams")
      ),
    }).toStrictEqual({
      item: ["confirm", "decline"],
      restricted: [1],
      teams: "workflow.start_offer_only",
    });
  });
});

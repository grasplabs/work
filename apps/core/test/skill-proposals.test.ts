import {
  triggerIdSchema,
  workflowResourceIdSchema,
} from "@grasp-os/shared/ids";
import type { Authority } from "@grasp-os/shared/permissions";
import type { Identity, SessionApi } from "@grasp-os/shared/rpc";
import type { SkillProposal } from "@grasp-os/shared/skills";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { drainAuditOutboxes } from "../src/audit-drains.ts";
import type { Acting } from "../src/auth/identity.ts";
import { memberOf } from "../src/auth/identity.ts";
import { eraseSource, workBrain } from "../src/brain-next.ts";
import { skillsFor } from "../src/brain-skills.ts";
import { producersOf, relayHandOvers } from "../src/brain-sources.ts";
import { inJurisdiction } from "../src/durable-objects.ts";
import { createTriggerResource } from "../src/trigger-resources.ts";
import {
  shareWorkflowResource,
  unshareWorkflowResource,
} from "../src/workflow-members.ts";
import { createWorkflowResource } from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { actingFor } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { answeringProvider } from "./model-provider.ts";
import type { SentRequest } from "./model-provider.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";
import { webhookConfig } from "./source-config.ts";
import { holdsNothing } from "./stored-skills.ts";
import { granted } from "./workflow-calls.ts";
import { publishDefinition } from "./workflow-publishing.ts";
import { definitionOf, ended } from "./workflow-resource-runs-harness.ts";

// Skills proposed from a person's own runs that keep succeeding (GRA-1756;
// the design is on the issue), through core's real boundaries: real runs,
// core's hand-over of each into its person's own store as the clock does
// it, the store's own alarm drafting through core's model gateway to a
// faked provider, and the person's session. What could go wrong: a
// proposal used before its person adds it; one built from, or shown to,
// someone other than the person whose runs they were; one that outlives
// the access or the runs it rests on; the model asked again for nothing
// new; a dismissed one coming back for the same version.

const idp = mockIdp();

/** Signing people in, running workflows and drafting can be slow on CI. */
const setUpTime = { timeout: 180_000 };

/**
 * A definition that completes for a `who` of four letters or more, and
 * fails for a shorter one: its output reads `who`'s fourth letter, then
 * `who` in capitals, then `tail`.
 */
const pickyDefinition = (tail = "") =>
  definitionOf([], {
    value: {
      status: {
        $expr: `args.who.split("")[3].toUpperCase() + args.who.toUpperCase() + "${tail}"`,
      },
    },
  });

/** Someone signed in with `role`, their API and who they act as. */
const person = async (role: "admin" | "builder" | "user") => {
  const signed = await signedInApi(idp, role);
  const by = await memberOf(env.DB, signed.userId);
  if (by === undefined) {
    throw new Error("Expected a member");
  }
  return { ...signed, by };
};

/** `by` as a session names them. */
const identityOf = (by: Acting): Acting & Identity => ({
  email: `${by.userId}@example.test`,
  name: by.userId,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  ...by,
});

/** A workflow `builder` published from the picky definition, shared with `userIds` as users. */
const workflowOf = async (builder: Acting, userIds: readonly string[]) => {
  const workflow = await createWorkflowResource(
    env,
    builder,
    `send-report-${unique()}`
  );
  await publishDefinition(env, builder, workflow.id, pickyDefinition());
  for (const id of userIds) {
    // oxlint-disable-next-line no-await-in-loop -- a few, in turn
    await shareWorkflowResource(env, builder, workflow.id, {
      type: "person",
      id,
      role: "user",
    });
  }
  return workflow;
};

/** The clock's time for the Brain's ticks here: only forward. */
const clock = { at: Date.now() };

/** `personId`'s own store, as core names it. */
const ownStore = (personId: string) =>
  inJurisdiction(env, env.BRAIN_STORE).getByName(`person:${personId}`);

/**
 * Hands over what ended, as core's clock does (drain, relay, a tick of the
 * shared store, a few times), then runs `personId`'s own store's alarm
 * until it has nothing left due, at most 10 times.
 */
const handedOver = async (personId: string): Promise<void> => {
  for (let tick = 0; tick < 3; tick += 1) {
    clock.at = Math.max(clock.at + 60_000, Date.now());
    // oxlint-disable-next-line no-await-in-loop -- one tick after the other
    await drainAuditOutboxes(env);
    // oxlint-disable-next-line no-await-in-loop -- one tick after the other
    await relayHandOvers(env);
    // oxlint-disable-next-line no-await-in-loop -- one tick after the other
    await workBrain(env, new Date(clock.at), producersOf(env));
  }
  for (let run = 0; run < 10; run += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one alarm after the other
    if (!(await runDurableObjectAlarm(ownStore(personId)))) {
      return;
    }
  }
  throw new Error("The person's own store kept waking");
};

/** `by` runs version `version` of workflow `id` for `who`, until it ended; its ID. */
const runOnce = async (
  by: Acting,
  id: string,
  who: string,
  version: number
): Promise<string> => {
  const started = await startWorkflow(env, { type: "person", person: by }, id, {
    expected: version,
    args: { who },
    key: unique(),
  });
  await ended(by, id, started.runId);
  if (started.runId === null) {
    throw new Error("Expected a run");
  }
  return started.runId;
};

/**
 * `by` runs `id` `times` times for `who`, in turn, then everything is
 * handed over to them; their IDs, newest first.
 */
const runs = async (
  by: Acting,
  id: string,
  times: number,
  { who = "Adalbert", version = 1 }: { who?: string; version?: number } = {}
): Promise<string[]> => {
  const ids: string[] = [];
  for (let run = 0; run < times; run += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one run after another, in order
    ids.unshift(await runOnce(by, id, who, version));
  }
  await handedOver(by.userId);
  return ids;
};

/** The words of the draft request: the drafting prompt alone has them. */
const draftingWords = "You draft a skill";

/** Whether `request` asks for a draft of a skill. */
const drafts = (request: SentRequest): boolean =>
  JSON.stringify(request.body).includes(draftingWords);

/**
 * A provider that drafts a skill named `name` for every request to draft
 * one, and finds nothing for the Brain's extraction of the runs; and the
 * draft requests it got.
 */
const draftingProvider = async (name: string) => {
  const provider = await answeringProvider((requests) => {
    const body = JSON.stringify(requests.at(-1)?.body);
    if (body.includes(draftingWords)) {
      return {
        text: `---\nname: ${name}\ndescription: When you ask for the weekly report.\n---\nAsk which week, then send it.`,
        inputTokens: 50,
        outputTokens: 20,
      };
    }
    return {
      text: body.includes("You check statements")
        ? JSON.stringify({ supported: [] })
        : JSON.stringify({ entities: [], memories: [] }),
      inputTokens: 50,
      outputTokens: 20,
    };
  });
  return {
    drafted: () => provider.requests.filter((request) => drafts(request)),
  };
};

/** What `api`'s skills page proposes from workflow `id`. */
const proposedFrom = async (
  api: SessionApi,
  id: string
): Promise<SkillProposal[]> => {
  const proposals = await api.skills.proposals();
  return proposals.filter(({ basis }) => basis.workflow.id === id);
};

/** The scopes of the skills named `name` that `userId`'s own chat may use. */
const usableIn = async (userId: string, name: string): Promise<string[]> => {
  const agent: Authority = actingFor(
    { type: "agent", agentId: `agent-${unique()}` },
    userId
  );
  const listed = await skillsFor(env, agent, "person", holdsNothing);
  return listed
    .filter((skill) => skill.name === name)
    .map(({ scope }) => scope);
};

describe("skill proposals", setUpTime, () => {
  it("drafts a skill from a person's own runs that keep succeeding, for them alone, from what they read", async () => {
    const name = `weekly-report-${unique()}`;
    const { drafted } = await draftingProvider(name);
    const [builder, ada] = await Promise.all([
      person("builder"),
      person("user"),
    ]);
    const workflow = await workflowOf(builder.by, [ada.userId]);
    // The builder's own runs of it, holding a word Ada never runs with.
    const theirs = `Bertholde${unique()}`;
    await runs(builder.by, workflow.id, 2, { who: theirs });
    // Four of her runs succeeding aren't enough.
    const first = await runs(ada.by, workflow.id, 4);
    const afterFour = await proposedFrom(ada.api, workflow.id);
    const fifth = await runs(ada.by, workflow.id, 1);
    const proposed = await proposedFrom(ada.api, workflow.id);
    const [draft] = drafted();
    expect({
      afterFour,
      // What it rests on: her runs, at the version they ran.
      proposed: proposed.map(({ name: named, text, basis }) => ({
        name: named,
        text,
        version: basis.version,
        workflow: basis.workflow.name,
        runs: basis.runs.map(({ id }) => id),
      })),
      // One draft, from her runs' results, never the builder's.
      draftsAsked: drafted().length,
      readHers: JSON.stringify(draft?.body).includes("ADALBERT"),
      readTheirs: JSON.stringify(draft?.body).includes(theirs.toUpperCase()),
      // The builder, who can see her runs, is proposed nothing from them,
      // and can't add one from them.
      toBuilder: await proposedFrom(builder.api, workflow.id),
      builderAdds: await outcome(
        builder.api.skills.acceptProposal(proposed[0]?.key ?? "")
      ),
    }).toStrictEqual({
      afterFour: [],
      proposed: [
        {
          name,
          text: `---\nname: ${name}\ndescription: When you ask for the weekly report.\n---\nAsk which week, then send it.\n`,
          version: 1,
          workflow: workflow.name,
          runs: [...fifth, ...first],
        },
      ],
      draftsAsked: 1,
      readHers: true,
      readTheirs: false,
      toBuilder: [],
      builderAdds: "skills.not_found",
    });
  });

  it("uses a proposed skill only once its person adds it, and asks the model no more", async () => {
    const name = `weekly-report-${unique()}`;
    const { drafted } = await draftingProvider(name);
    const [builder, ada] = await Promise.all([
      person("builder"),
      person("user"),
    ]);
    const workflow = await workflowOf(builder.by, [ada.userId]);
    await runs(ada.by, workflow.id, 5);
    const [proposal] = await proposedFrom(ada.api, workflow.id);
    const before = await usableIn(ada.userId, name);
    const added = await ada.api.skills.acceptProposal(proposal?.key ?? "");
    const { own } = await ada.api.skills.overview();
    const after = await usableIn(ada.userId, name);
    // A sixth run that succeeds proposes nothing more, and asks nothing.
    await runs(ada.by, workflow.id, 1);
    expect({
      before,
      added: added.name,
      after,
      toBuilder: await usableIn(builder.userId, name),
      own: own.filter((skill) => skill.name === name).length,
      proposed: await proposedFrom(ada.api, workflow.id),
      again: await outcome(ada.api.skills.acceptProposal(proposal?.key ?? "")),
      draftsAsked: drafted().length,
    }).toStrictEqual({
      before: [],
      added: name,
      after: ["person"],
      toBuilder: [],
      own: 1,
      proposed: [],
      again: "skills.not_found",
      draftsAsked: 1,
    });
  });

  it("drafts nothing once a run among the last fails, or from runs a trigger started", async () => {
    const { drafted } = await draftingProvider(`weekly-report-${unique()}`);
    const [admin, builder, ada] = await Promise.all([
      person("admin"),
      person("builder"),
      person("user"),
    ]);
    const workflow = await workflowOf(builder.by, [ada.userId]);
    await runs(ada.by, workflow.id, 4);
    // "Ada" is too short: the run fails.
    await runs(ada.by, workflow.id, 1, { who: "Ada" });
    const afterFailure = await proposedFrom(ada.api, workflow.id);
    // Five runs a trigger started for the builder, all completed.
    const trigger = await createTriggerResource(env, builder.by, {
      kind: "webhook",
      workflowId: workflow.id,
      config: await webhookConfig(),
    });
    await granted(identityOf(builder.by), identityOf(admin.by), {
      subject: {
        type: "trigger",
        triggerId: triggerIdSchema.parse(trigger.id),
      },
      object: {
        type: "workflow",
        workflowId: workflowResourceIdSchema.parse(workflow.id),
      },
      actions: ["start"],
      binding: `START_${unique().toUpperCase().replaceAll(/\W/gu, "_")}`,
    });
    for (let run = 0; run < 5; run += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one run after another
      const started = await startWorkflow(
        env,
        { type: "trigger", triggerId: trigger.id },
        workflow.id,
        { expected: 1, args: { who: "Adalbert" }, key: unique() }
      );
      // oxlint-disable-next-line no-await-in-loop -- one run after another
      await ended(builder.by, workflow.id, started.runId);
    }
    await handedOver(builder.userId);
    expect({
      afterFailure,
      fromTrigger: await proposedFrom(builder.api, workflow.id),
      draftsAsked: drafted().length,
    }).toStrictEqual({ afterFailure: [], fromTrigger: [], draftsAsked: 0 });
  });

  it("hides a proposal once its person loses the workflow, and deletes it when a run it rests on is erased", async () => {
    await draftingProvider(`weekly-report-${unique()}`);
    const [builder, ada, bea] = await Promise.all([
      person("builder"),
      person("user"),
      person("user"),
    ]);
    const workflow = await workflowOf(builder.by, [ada.userId, bea.userId]);
    await runs(ada.by, workflow.id, 5);
    const [held] = await proposedFrom(ada.api, workflow.id);
    await unshareWorkflowResource(env, builder.by, workflow.id, {
      type: "person",
      id: ada.userId,
    });
    const lost = await proposedFrom(ada.api, workflow.id);
    const adds = await outcome(ada.api.skills.acceptProposal(held?.key ?? ""));
    // Bea's proposal, and one of the runs it rests on erased.
    const beas = await runs(bea.by, workflow.id, 5);
    const [beaHeld] = await proposedFrom(bea.api, workflow.id);
    await eraseSource(env, {
      source: { producer: "run", id: beas[2] ?? "" },
      readers: { kind: "owner", personId: bea.userId },
      reason: "deleted",
    });
    const kept = await runInDurableObject(
      ownStore(bea.userId),
      (_store, state) =>
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT count(*) AS count FROM skill_proposals"
          )
          .one().count
    );
    expect({
      held: held === undefined,
      lost,
      adds,
      beaHeld: beaHeld === undefined,
      afterErasure: await proposedFrom(bea.api, workflow.id),
      kept,
    }).toStrictEqual({
      held: false,
      lost: [],
      adds: "skills.not_found",
      beaHeld: false,
      afterErasure: [],
      kept: 0,
    });
  });

  it("never shows or adds a proposal named as a skill of the person's own, which keeps its text", async () => {
    const name = `weekly-report-${unique()}`;
    const { drafted } = await draftingProvider(name);
    const [builder, ada] = await Promise.all([
      person("builder"),
      person("user"),
    ]);
    const mine = `---\nname: ${name}\ndescription: My own way.\n---\nMine.\n`;
    await ada.api.skills.save(mine);
    const workflow = await workflowOf(builder.by, [ada.userId]);
    await runs(ada.by, workflow.id, 5);
    // The proposal's key, as core makes it: the workflow and its version.
    const key = [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`${workflow.id}:1`)
        )
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const adds = await outcome(ada.api.skills.acceptProposal(key));
    const { own } = await ada.api.skills.overview();
    const { text } = await ada.api.skills.read("own", name);
    expect({
      draftsAsked: drafted().length,
      proposed: await proposedFrom(ada.api, workflow.id),
      adds,
      own: own
        .filter((skill) => skill.name === name)
        .map(({ version }) => version),
      text,
    }).toStrictEqual({
      draftsAsked: 1,
      proposed: [],
      adds: "skills.not_found",
      own: [1],
      text: mine,
    });
  });

  it("keeps a dismissed proposal away for its version, and proposes again for a new one", async () => {
    const { drafted } = await draftingProvider(`weekly-report-${unique()}`);
    const [builder, ada] = await Promise.all([
      person("builder"),
      person("user"),
    ]);
    const workflow = await workflowOf(builder.by, [ada.userId]);
    await runs(ada.by, workflow.id, 5);
    const [first] = await proposedFrom(ada.api, workflow.id);
    await ada.api.skills.dismissProposal(first?.key ?? "");
    const dismissed = await proposedFrom(ada.api, workflow.id);
    await runs(ada.by, workflow.id, 1);
    const sixth = await proposedFrom(ada.api, workflow.id);
    await publishDefinition(
      env,
      builder.by,
      workflow.id,
      pickyDefinition(" again")
    );
    await runs(ada.by, workflow.id, 5, { version: 2 });
    const second = await proposedFrom(ada.api, workflow.id);
    expect({
      dismissed,
      sixth,
      again: await outcome(ada.api.skills.dismissProposal(first?.key ?? "")),
      versions: second.map(({ basis }) => basis.version),
      draftsAsked: drafted().length,
    }).toStrictEqual({
      dismissed: [],
      sixth: [],
      again: "skills.not_found",
      versions: [2],
      draftsAsked: 2,
    });
  });
});

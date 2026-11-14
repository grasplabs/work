import type { Authority } from "@grasp-os/shared/permissions";
import type { SessionApi } from "@grasp-os/shared/rpc";
import type { SkillProposal } from "@grasp-os/shared/skills";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import { memberOf } from "../src/auth/identity.ts";
import { skillsFor } from "../src/brain-skills.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  shareWorkflowResource,
  unshareWorkflowResource,
} from "../src/workflow-resources.ts";
import { startWorkflow } from "../src/workflow-starts.ts";
import { actingFor } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";
import { holdsNothing } from "./stored-skills.ts";
import { definitionOf, ended } from "./workflow-resource-runs-harness.ts";

// Skill proposals (GRA-1756), from the design on the issue: a person's own
// runs of a workflow that keep succeeding propose a draft of their own
// skill. What could go wrong: a proposal used before its person adds it;
// one built from, or shown to, someone other than the person whose runs
// they were; one that outlives the access or the evidence it rests on; a
// dismissed one coming back for the same evidence; adding one twice.

const idp = mockIdp();

/** Signing people in and running workflows can be slow on CI. */
const setUpTime = { timeout: 120_000 };

/**
 * A definition that completes for a `who` of four letters or more, and
 * fails for a shorter one: its output reads `who`'s fourth letter.
 */
const pickyDefinition = definitionOf([], {
  value: { status: { $expr: 'args.who.split("")[3].toUpperCase()' } },
});

/** Someone signed in with `role`, their API and who they act as. */
const person = async (role: "builder" | "user") => {
  const signed = await signedInApi(idp, role);
  const by = await memberOf(env.DB, signed.userId);
  if (by === undefined) {
    throw new Error("Expected a member");
  }
  return { ...signed, by };
};

/** A workflow `builder` published from the picky definition, shared with `userIds` as users. */
const workflowOf = async (builder: Acting, userIds: readonly string[]) => {
  const workflow = await createWorkflowResource(
    env,
    builder,
    `send-report-${unique()}`
  );
  await publishWorkflowVersion(env, builder, workflow.id, {
    definition: pickyDefinition,
    basedOn: null,
  });
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

/** `by` runs version `version` of workflow `id` for `who`, until it ended; its ID. */
const runOnce = async (
  by: Acting,
  id: string,
  who: string,
  version = 1
): Promise<string> => {
  const started = await startWorkflow(env, { type: "person", person: by }, id, {
    version,
    args: { who },
    key: unique(),
  });
  await ended(by, id, started.runId);
  if (started.runId === null) {
    throw new Error("Expected a run");
  }
  return started.runId;
};

/** `by` runs `id` `times` times for `who`, in turn; their IDs, newest first. */
const runs = async (
  by: Acting,
  id: string,
  times: number,
  who = "Adalbert",
  version = 1
): Promise<string[]> => {
  const ids: string[] = [];
  for (let run = 0; run < times; run += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one run after another, in order
    ids.unshift(await runOnce(by, id, who, version));
  }
  return ids;
};

/** What `api`'s skills page proposes from workflow `id`. */
const proposedFrom = async (
  api: SessionApi,
  id: string
): Promise<SkillProposal[]> => {
  const { proposals } = await api.skills.overview();
  return proposals.filter(({ basis }) => basis.workflow.id === id);
};

/** The names of the skills `userId`'s own chat may use, of `name`. */
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
  it("proposes a skill from a person's own runs that keep succeeding, to them alone", async () => {
    const [builder, ada] = await Promise.all([
      person("builder"),
      person("user"),
    ]);
    const workflow = await workflowOf(builder.by, [ada.userId]);
    // Four of her runs succeeding aren't enough.
    const first = await runs(ada.by, workflow.id, 4);
    const afterFour = await proposedFrom(ada.api, workflow.id);
    const fifth = await runs(ada.by, workflow.id, 1);
    const proposed = await proposedFrom(ada.api, workflow.id);
    expect({
      afterFour,
      // What it rests on: her runs, at the version they ran.
      proposed: proposed.map(({ name, basis }) => ({
        name,
        version: basis.version,
        runs: basis.runs.map(({ id }) => id),
      })),
      // The builder, who can see her runs, is proposed nothing from them,
      // and can't add one from them.
      toBuilder: await proposedFrom(builder.api, workflow.id),
      builderAdds: await outcome(
        builder.api.skills.acceptProposal(workflow.id, 1)
      ),
    }).toStrictEqual({
      afterFour: [],
      proposed: [
        { name: workflow.name, version: 1, runs: [...fifth, ...first] },
      ],
      toBuilder: [],
      builderAdds: "skills.not_found",
    });
  });

  it("uses a proposed skill only once its person adds it, and adds it once", async () => {
    const [builder, ada] = await Promise.all([
      person("builder"),
      person("user"),
    ]);
    const workflow = await workflowOf(builder.by, [ada.userId]);
    await runs(ada.by, workflow.id, 5);
    const before = await usableIn(ada.userId, workflow.name);
    const added = await ada.api.skills.acceptProposal(workflow.id, 1);
    const { own } = await ada.api.skills.overview();
    expect({
      before,
      added: added.name,
      after: await usableIn(ada.userId, workflow.name),
      toBuilder: await usableIn(builder.userId, workflow.name),
      own: own.filter(({ name }) => name === workflow.name).length,
      // Once hers, it isn't proposed again, and adding it again adds nothing.
      proposed: await proposedFrom(ada.api, workflow.id),
      again: await outcome(ada.api.skills.acceptProposal(workflow.id, 1)),
    }).toStrictEqual({
      before: [],
      added: workflow.name,
      after: ["person"],
      toBuilder: [],
      own: 1,
      proposed: [],
      again: "skills.not_found",
    });
  });

  it("proposes nothing once a run fails, or the person loses the workflow", async () => {
    const [builder, ada] = await Promise.all([
      person("builder"),
      person("user"),
    ]);
    const workflow = await workflowOf(builder.by, [ada.userId]);
    await runs(ada.by, workflow.id, 5);
    const succeeding = await proposedFrom(ada.api, workflow.id);
    // A failure among her latest runs.
    await runs(ada.by, workflow.id, 1, "Ada");
    const afterFailure = await proposedFrom(ada.api, workflow.id);
    await runs(ada.by, workflow.id, 5);
    const again = await proposedFrom(ada.api, workflow.id);
    // She no longer has a role in it: nothing, and nothing to add.
    await unshareWorkflowResource(env, builder.by, workflow.id, {
      type: "person",
      id: ada.userId,
    });
    expect({
      succeeding: succeeding.length,
      afterFailure,
      again: again.length,
      unshared: await proposedFrom(ada.api, workflow.id),
      adds: await outcome(ada.api.skills.acceptProposal(workflow.id, 1)),
    }).toStrictEqual({
      succeeding: 1,
      afterFailure: [],
      again: 1,
      unshared: [],
      adds: "skills.not_found",
    });
  });

  it("keeps a dismissed proposal dismissed until another version keeps succeeding", async () => {
    const [builder, ada] = await Promise.all([
      person("builder"),
      person("user"),
    ]);
    const workflow = await workflowOf(builder.by, [ada.userId]);
    await runs(ada.by, workflow.id, 5);
    await ada.api.skills.dismissProposal(workflow.id, 1);
    await runs(ada.by, workflow.id, 1);
    const dismissed = await proposedFrom(ada.api, workflow.id);
    const adds = await outcome(ada.api.skills.acceptProposal(workflow.id, 1));
    // Another version, succeeding as often: proposed again, from it.
    await publishWorkflowVersion(env, builder.by, workflow.id, {
      definition: pickyDefinition.replace("[3]", "[2]"),
      basedOn: 1,
    });
    await runs(ada.by, workflow.id, 5, "Adalbert", 2);
    const proposed = await proposedFrom(ada.api, workflow.id);
    await ada.api.skills.acceptProposal(workflow.id, 2);
    expect({
      dismissed,
      adds,
      versions: proposed.map(({ basis }) => basis.version),
      used: await usableIn(ada.userId, workflow.name),
    }).toStrictEqual({
      dismissed: [],
      adds: "skills.not_found",
      versions: [2],
      used: ["person"],
    });
  });
});

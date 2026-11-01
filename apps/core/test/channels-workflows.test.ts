import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { memberOf } from "../src/auth/identity.ts";
import type { Acting } from "../src/auth/identity.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
  setWorkflowAskable,
  shareWorkflowResource,
  workflowAskable,
} from "../src/workflow-resources.ts";
import { codeStep, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { answeringProvider } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";
import {
  member,
  memberAnsweredBy,
  messageFrom,
  post,
  reached,
  watched,
} from "./teams-door.ts";
import type { TeamsPerson } from "./teams-door.ts";

// Workflows people start by asking Stephen in Teams
// (src/channels/workflow-offers.ts): a workflow whose owner lets people
// ask for it is offered on a card by the chat's agent, started as the
// person once they press Start, and its end told in their chat. The turn
// runs in the person's Workspace, with the model provider faked; the cards
// and lines reach the fake Bot Connector through connect; the run is a
// real run of a published JSON workflow.

const idp = mockIdp();

watched();

/** Signing people in and running a workflow can be slow on CI. */
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

/** A builder who owns workflows, as their session has them. */
const owner = async (): Promise<Acting> => {
  const { userId } = await signedInApi(idp, "builder");
  const found = await memberOf(env.DB, userId);
  if (found === undefined) {
    throw new Error("Expected the builder to be a member");
  }
  return found;
};

/**
 * A workflow `by` published once and shared with `userId`, open to asking
 * Stephen when `askable`.
 */
const sharedWorkflow = async (by: Acting, userId: string, askable: boolean) => {
  const workflow = await createWorkflowResource(env, by, `ask-${unique()}`);
  await publishWorkflowVersion(env, by, workflow.id, {
    definition: greeting(workflow.name),
    basedOn: null,
  });
  await shareWorkflowResource(env, by, workflow.id, {
    type: "person",
    id: userId,
    role: "user",
  });
  if (askable) {
    await setWorkflowAskable(env, by, workflow.id, true);
  }
  return workflow;
};

/** The agent's code: offers the first workflow it may, for Ada. */
const offersFirst = codeStep(
  `export default async (self, env) => {
  const [first] = await env.workflows.askable();
  if (first === undefined) return "none";
  return await env.workflows.offer(first.id, { who: "Ada" });
};`
);

const cardSchema = z.object({
  attachments: z.array(
    z.object({
      content: z.object({
        actions: z
          .array(
            z.looseObject({
              type: z.string(),
              data: z.object({ actionId: z.string(), value: z.string() }),
            })
          )
          .optional(),
      }),
    })
  ),
});

/** The offers of start cards posted in `conversation`, in order. */
const offersIn = async (conversation: string): Promise<string[]> => {
  const { activities } = await reached(conversation);
  return activities.flatMap((activity) => {
    const card = cardSchema.safeParse(activity);
    return card.success
      ? card.data.attachments.flatMap(({ content }) =>
          (content.actions ?? [])
            .filter(({ data }) => data.actionId === "workflow.start")
            .map(({ data }) => data.value)
        )
      : [];
  });
};

/** `person` pressing Start on the card of `offer`, as Teams posts it. */
const pressStart = (person: TeamsPerson, offer: string) =>
  messageFrom(person, {
    text: undefined,
    value: { actionId: "workflow.start", value: offer },
  });

/** The runs of workflow `id`, by whom they act for. */
const runsOf = async (id: string) => {
  const { results } = await env.DB.prepare(
    "SELECT principal_id AS principal, status FROM workflow_resource_runs WHERE workflow_resource_id = ?"
  )
    .bind(id)
    .all<{ principal: string; status: string }>();
  return results;
};

describe("a workflow its owner lets people ask for", setUpTime, () => {
  it("is offered on a card, started once as the person who pressed Start, and its end told", async () => {
    const ann = await member(idp, offersFirst, says("There's a card for it."));
    const workflow = await sharedWorkflow(await owner(), ann.userId, true);

    await post(messageFrom(ann.teams, { text: "Run the greeting for Ada" }));
    const [offer] = await offersIn(ann.teams.conversation);
    if (offer === undefined) {
      throw new Error("Expected a card offering the workflow");
    }
    await post(pressStart(ann.teams, offer));
    // A second press, as a resend or a double click would be.
    await post(pressStart(ann.teams, offer));

    const lines = await vi.waitFor(
      async () => {
        const { lines: now } = await reached(ann.teams.conversation);
        expect(now).toContain(`${workflow.name} has finished.`);
        return now;
      },
      { timeout: 60_000, interval: 200 }
    );
    // The second press may be answered before or after the run ends.
    expect({
      lines: lines
        .filter((line): line is string => line !== undefined && line !== "")
        .toSorted((a, b) => a.localeCompare(b)),
      runs: await runsOf(workflow.id),
    }).toStrictEqual({
      lines: [
        `${workflow.name} has finished.`,
        `I started ${workflow.name} for you. I'll tell you here when it has finished.`,
        "This card has already been answered.",
      ].toSorted((a, b) => a.localeCompare(b)),
      runs: [{ principal: ann.userId, status: "completed" }],
    });
  });

  it("starts nothing for anyone else who presses it", async () => {
    const ann = await member(idp, offersFirst, says("There's a card for it."));
    const bo = await memberAnsweredBy(idp, ann.provider);
    const workflow = await sharedWorkflow(await owner(), ann.userId, true);
    await post(messageFrom(ann.teams, { text: "Run the greeting for Ada" }));
    const [offer = ""] = await offersIn(ann.teams.conversation);

    await post(pressStart(bo.teams, offer));

    const { lines } = await reached(bo.teams.conversation);
    expect({ lines, runs: await runsOf(workflow.id) }).toStrictEqual({
      lines: ["Only the person this card was made for can confirm it."],
      runs: [],
    });
  });

  it("starts nothing once its owner stopped people asking for it", async () => {
    const ann = await member(idp, offersFirst, says("There's a card for it."));
    const by = await owner();
    const workflow = await sharedWorkflow(by, ann.userId, true);
    await post(messageFrom(ann.teams, { text: "Run the greeting for Ada" }));
    const [offer = ""] = await offersIn(ann.teams.conversation);

    await setWorkflowAskable(env, by, workflow.id, false);
    await post(pressStart(ann.teams, offer));

    const { lines } = await reached(ann.teams.conversation);
    expect({
      said: lines.at(-1),
      runs: await runsOf(workflow.id),
    }).toStrictEqual({
      said: `I couldn't start ${workflow.name}. It may have changed, or who can start it may have. Ask me again to try once more.`,
      runs: [],
    });
  });
});

describe("a workflow its owner didn't open to asking", setUpTime, () => {
  it("is never offered, even named", async () => {
    // Its replies once the workflow is there, as the agent would name it.
    const replies: ProviderReply[] = [];
    const ann = await memberAnsweredBy(
      idp,
      await answeringProvider(() => replies.shift())
    );
    const workflow = await sharedWorkflow(await owner(), ann.userId, false);
    replies.push(
      codeStep(
        `export default async (self, env) => {
  const listed = await env.workflows.askable();
  try {
    await env.workflows.offer(${JSON.stringify(workflow.id)}, { who: "Ada" });
    return { listed, offered: true };
  } catch {
    return { listed, offered: false };
  }
};`
      ),
      says("Nothing to offer.")
    );

    await post(messageFrom(ann.teams, { text: "Run the greeting" }));

    const told = JSON.stringify(ann.provider.requests[1]?.body ?? null);
    expect({
      listedNone: told.includes(String.raw`\"listed\":[]`),
      offered: told.includes(String.raw`\"offered\":true`),
      refused: told.includes(String.raw`\"offered\":false`),
      cards: await offersIn(ann.teams.conversation),
    }).toStrictEqual({
      listedNone: true,
      offered: false,
      refused: true,
      cards: [],
    });
  });

  it("is off until its owner turns it on, and only its owner may", async () => {
    const by = await owner();
    const ann = await member(idp);
    const workflow = await sharedWorkflow(by, ann.userId, false);
    const annActing = await memberOf(env.DB, ann.userId);
    if (annActing === undefined) {
      throw new Error("Expected Ann to be a member");
    }

    const before = await workflowAskable(env, annActing, workflow.id);
    const byAnn = await outcome(
      setWorkflowAskable(env, annActing, workflow.id, true)
    );
    await setWorkflowAskable(env, by, workflow.id, true);

    expect({
      before,
      byAnn,
      after: await workflowAskable(env, annActing, workflow.id),
    }).toStrictEqual({
      before: false,
      byAnn: "role.forbidden",
      after: true,
    });
  });
});

describe(
  "the workflows open to asking, as Settings › Stephen lists them",
  setUpTime,
  () => {
    it("are those live and open to asking that the reader sees, in one read", async () => {
      const by = await owner();
      const ann = await signedInApi(idp, "user");
      const open = await sharedWorkflow(by, ann.userId, true);
      const closed = await sharedWorkflow(by, ann.userId, false);
      // Open to asking, but never published, and published but not shared.
      const unpublished = await createWorkflowResource(
        env,
        by,
        `ask-${unique()}`
      );
      await setWorkflowAskable(env, by, unpublished.id, true);
      const notShared = await createWorkflowResource(
        env,
        by,
        `ask-${unique()}`
      );
      await publishWorkflowVersion(env, by, notShared.id, {
        definition: greeting(notShared.name),
        basedOn: null,
      });
      await setWorkflowAskable(env, by, notShared.id, true);

      const listed = await ann.api.workflowResources.askableWorkflows();

      const ours = new Set([open.id, closed.id, unpublished.id, notShared.id]);
      expect(listed.filter(({ id }) => ours.has(id))).toStrictEqual([
        { id: open.id, name: open.name },
      ]);
    });
  }
);

import type { Message } from "@earendil-works/pi-ai";
import type { ChatMessage } from "@grasp-os/shared/chat";
import {
  checkThinkingStep,
  hoursPerWeek,
  nameKey,
} from "@grasp-os/shared/thinking";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resolverOf, showThinking } from "../src/agent-thinking.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { personalChatsOf, says, transcript } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { answering, holdAlarm, onLink } from "./interview-link.ts";
import type { Answer } from "./model-provider.ts";
import {
  intake,
  mapped,
  openLink,
  team,
  ticketsReply,
  told as peopleTold,
} from "./onboarding-team.ts";
import type { Ids } from "./onboarding-team.ts";
import { signedInApi } from "./sign-in.ts";

// Grasp's thinking, shown in the brain while it answers (`show_thinking`,
// src/agent-thinking.ts): the chat's agent names teams, what they said and
// workflows, and core takes only what is in the brain as the asker may
// read it, kept with the answer as steps the page plays. The model
// provider is faked behind the AI binding. The ways it can fail, tried
// here:
//
// - A team or a statement that isn't in the brain, or a statement that
//   rests on fewer than five people (a claim taken out), shown anyway.
// - A step with a shape or a move there isn't, or naming nothing.
// - The rounds spent on steps leaving none for the answer, or an answer
//   that only showed its thinking ending with no words.
// - Hours made up for a workflow whose hours the brain doesn't know.
// - Steps lost once the answer is kept, so it can't be played again.

const idp = mockIdp();

/** Signing people in, an onboarding and granting take a while on CI. */
const slow = { timeout: 120_000 };

/** The model shows a step of its thinking. */
const thinks = (input: Record<string, unknown>): Answer => ({
  text: "",
  toolCalls: [
    {
      id: `call_${crypto.randomUUID().replaceAll("-", "")}`,
      name: "show_thinking",
      arguments: input,
    },
  ],
  inputTokens: 200,
  outputTokens: 30,
});

/** A team through the onboarding, its claims and its tickets in the brain. */
const teamInTheBrain = async (): Promise<Ids> => {
  const ids = await team();
  await mapped(ids);
  await peopleTold(ids);
  await answering(
    [ticketsReply(ids)],
    async () => await onboardingStore(env).drawNext()
  );
  await intake(ids);
  return ids;
};

/**
 * A member whose chats' agent may read the brain, and a chat of theirs
 * answered by `replies`; with what the brain shows them of the team.
 */
const askedWithBrain = async (ids: Ids, ...replies: Answer[]) => {
  const admin = await signedInApi(idp, "admin");
  const member = await signedInApi(idp, "user");
  const chats = await personalChatsOf(member.userId, ...replies);
  await requestGranted(idp, admin, {
    subject: chats.agent,
    object: { type: "platform" },
    actions: ["brain"],
    binding: "BRAIN",
  });
  const brain = await member.api.brain.read();
  const teamId = `team-${ids.team}`;
  const said = brain.statements.find(({ teamIds }) => teamIds.includes(teamId));
  const work = brain.workflows.find((workflow) => workflow.teamId === teamId);
  return { member, chats, teamId, said: said?.id ?? "", work };
};

/** What each `show_thinking` call came to, as the model was told: shown, or why not. */
const toldOf = (messages: readonly Message[]) =>
  messages.flatMap((message) =>
    message.role === "toolResult" && message.toolName === "show_thinking"
      ? [
          {
            shown: !message.isError,
            told: message.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join(""),
          },
        ]
      : []
  );

/** The steps a member's page reads back of the chat, in order. */
const stepsShown = async (
  member: Awaited<ReturnType<typeof signedInApi>>,
  chatId: string
) => {
  const messages: ChatMessage[] = [];
  const subscription = await member.api.chats.watch(chatId, null, (update) => {
    messages.push(...update.messages);
  });
  try {
    return await vi.waitFor(
      () => {
        expect(messages.at(-1)?.role).toBe("assistant");
        return messages.flatMap((message) =>
          message.role === "result" && message.thinking !== undefined
            ? [message.thinking]
            : []
        );
      },
      { timeout: 10_000 }
    );
  } finally {
    subscription[Symbol.dispose]();
  }
};

/** A workflow drawn once: done 30 to 50 times a `per` by `of`, 10 to 20 minutes each. */
const drawn = (of: "me" | "team", per: "week" | "month") => ({
  drawings: [
    {
      volumes: [
        { of, per, low: 30, high: 50, people: 5, basis: "estimated" as const },
      ],
      takes: {
        unit: "minutes" as const,
        quickest: 10,
        longest: 20,
        people: 5,
        basis: "estimated" as const,
      },
    },
  ],
});

describe("a step of thinking, checked", () => {
  const brain = {
    teams: [{ id: "team-1", name: "Mortgage advice" }],
    statements: [{ id: "st-1" }],
    workflows: [{ id: "wf-1", name: "Weekly report" }],
  };
  const check = (input: Record<string, unknown>) =>
    checkThinkingStep(input, resolverOf(brain));

  it("finds a team by its id, its name, or an id made of its name, and only what its shape may name", () => {
    expect({
      byName: check({
        step: "Reading the teams.",
        shape: "same-pain",
        move: "teams",
        notes: ["Mortgage advice", "mortgage-advice", "team-1", "st-1"],
      }),
      workflowInSamePain: check({
        step: "Reading the work.",
        shape: "same-pain",
        move: "teams",
        notes: ["Weekly report"],
      }),
      key: nameKey("Handing a complete file to Mortgage Advice!"),
    }).toStrictEqual({
      byName: {
        step: {
          text: "Reading the teams.",
          notes: ["team-1", "st-1"],
          shape: "same-pain",
          move: "teams",
        },
      },
      workflowInSamePain: {
        refused:
          "Not in the brain as the person may read it: Weekly report. Name a team by its id or its name, and what a team said by its statement id.",
      },
      key: "handing-a-complete-file-to-mortgage-advice",
    });
  });

  it("reads the brain again for the next step when a read failed, and once a read worked, no more", async () => {
    let reads = 0;
    const tool = showThinking(async () => {
      reads += 1;
      if (reads === 1) {
        throw new Error("The brain could not be read.");
      }
      return await Promise.resolve(brain);
    });
    const shown = async (): Promise<unknown> => {
      try {
        const { details } = await tool.execute("call", {
          step: "Reading the teams.",
          shape: "same-pain",
          move: "teams",
          notes: ["team-1"],
        });
        return details;
      } catch (error) {
        return error instanceof Error ? error.message : error;
      }
    };
    const outcomes = [await shown(), await shown(), await shown()];

    expect({ outcomes, reads }).toStrictEqual({
      outcomes: [
        "The brain could not be read.",
        {
          text: "Reading the teams.",
          notes: ["team-1"],
          shape: "same-pain",
          move: "teams",
        },
        {
          text: "Reading the teams.",
          notes: ["team-1"],
          shape: "same-pain",
          move: "teams",
        },
      ],
      reads: 2,
    });
  });

  it("refuses a shape or a move there isn't, and a step that names nothing or says nothing", () => {
    expect([
      check({ step: "x", shape: "mood", move: "teams", notes: ["team-1"] }),
      check({ step: "x", shape: "hours", move: "teams", notes: ["wf-1"] }),
      check({ step: "x", shape: "hours", move: "work", notes: [] }),
      check({ step: " ", shape: "hours", move: "work", notes: ["wf-1"] }),
    ]).toStrictEqual([
      { refused: 'There is no shape "mood". Use one of: same-pain, hours.' },
      {
        refused:
          'The shape "hours" has no move "teams". Use one of: work, hours, most.',
      },
      { refused: 'Name in "notes" what this step looks at.' },
      { refused: 'Say in "step" what you do now, in one short sentence.' },
    ]);
  });

  it("weighs a workflow by how often the team does it and how long one takes, and knows none from one person's count", () => {
    expect({
      team: hoursPerWeek(drawn("team", "week")),
      monthly: hoursPerWeek(drawn("team", "month")),
      ownCount: hoursPerWeek(drawn("me", "week")),
      notDrawn: hoursPerWeek({}),
    }).toStrictEqual({
      team: 10,
      monthly: 2.3,
      ownCount: null,
      notDrawn: null,
    });
  });
});

describe("show_thinking in a chat", slow, () => {
  beforeEach(holdAlarm);

  it("shows only what is in the brain, keeps the steps with the answer, and asks once for words", async () => {
    const ids = await teamInTheBrain();
    const steps = (said: string, teamId: string) => [
      thinks({
        step: "Reading the teams.",
        shape: "same-pain",
        move: "teams",
        notes: ["Ops"],
      }),
      thinks({
        step: "Looking at what they said.",
        shape: "same-pain",
        move: "said",
        notes: [said, "st-nobody-said"],
      }),
      thinks({
        step: "Looking at what they said.",
        shape: "same-pain",
        move: "said",
        notes: [said],
      }),
      thinks({
        step: "Ops says it on its own.",
        shape: "same-pain",
        move: "together",
        notes: [teamId, said],
      }),
      // Only thinking, no words: asked once, it answers.
      says(""),
      says("Only Ops says tickets come in through Zendesk."),
    ];
    // The ids are the brain's: read them before scripting the model.
    const first = await askedWithBrain(ids);
    const { member, chats, teamId, said } = await askedWithBrain(
      ids,
      ...steps(first.said, first.teamId)
    );
    const { chat, ask } = await chats.newChat();
    await ask("Does the same pain hurt more than one team?");

    const kept = await transcript(chats.stub, chat.id);
    const answer = kept.findLast((message) => message.role === "assistant");
    expect({
      told: toldOf(kept).map(({ shown, told }) => ({
        shown,
        first: told.split("\n")[0],
      })),
      askedForWords: kept.some(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.startsWith("You showed your thinking")
      ),
      answer:
        answer?.role === "assistant"
          ? answer.content.flatMap((part) =>
              part.type === "text" ? [part.text] : []
            )
          : [],
      // Played again: the page reads the steps back with the answer.
      steps: await stepsShown(member, chat.id),
    }).toStrictEqual({
      told: [
        { shown: true, first: "Shown in the brain." },
        {
          shown: false,
          first:
            "Not in the brain as the person may read it: st-nobody-said. Name a team by its id or its name, and what a team said by its statement id.",
        },
        { shown: true, first: "Shown in the brain." },
        { shown: true, first: "Shown in the brain." },
      ],
      askedForWords: true,
      answer: ["Only Ops says tickets come in through Zendesk."],
      steps: [
        {
          text: "Reading the teams.",
          notes: [teamId],
          shape: "same-pain",
          move: "teams",
        },
        {
          text: "Looking at what they said.",
          notes: [said],
          shape: "same-pain",
          move: "said",
        },
        {
          text: "Ops says it on its own.",
          notes: [teamId, said],
          shape: "same-pain",
          move: "together",
        },
      ],
    });
  });

  it("keeps the turn's last rounds for the answer, however many steps the model would show", async () => {
    const ids = await teamInTheBrain();
    const reading = thinks({
      step: "Reading the teams.",
      shape: "same-pain",
      move: "teams",
      notes: ["Ops"],
    });
    const { chats } = await askedWithBrain(
      ids,
      ...Array.from({ length: 19 }, () => reading),
      says("Ops is the only team I can see.")
    );
    const { chat, ask } = await chats.newChat();
    await ask("Who hurts?");

    const kept = await transcript(chats.stub, chat.id);
    const told = toldOf(kept);
    const answer = kept.findLast((message) => message.role === "assistant");
    expect({
      lastTold: told.at(-1),
      answered:
        answer?.role === "assistant" &&
        answer.content.some(
          (part) =>
            part.type === "text" &&
            part.text === "Ops is the only team I can see."
        ),
    }).toStrictEqual({
      lastTold: {
        shown: false,
        told: "Not shown: the rounds left are for your answer. Write it now, in words.",
      },
      answered: true,
    });
  });

  it("refuses a statement once fewer than five of the people behind it still agree", async () => {
    const ids = await teamInTheBrain();
    const before = await askedWithBrain(ids);
    await onLink({ action: "withdraw", ...(await openLink(ids.pim)) });
    await onboardingStore(env).purgeBrain();
    const { chats } = await askedWithBrain(
      ids,
      thinks({
        step: "Looking at what they said.",
        shape: "same-pain",
        move: "said",
        notes: [before.said],
      }),
      says("Nothing I can show.")
    );
    const { chat, ask } = await chats.newChat();
    await ask("What slows Ops down?");

    expect({
      said: before.said === "" ? "none before" : "one before",
      told: toldOf(await transcript(chats.stub, chat.id)),
    }).toStrictEqual({
      said: "one before",
      told: [
        {
          shown: false,
          told: `Not in the brain as the person may read it: ${before.said}. Name a team by its id or its name, and what a team said by its statement id.`,
        },
      ],
    });
  });

  it("weighs workflows by the brain's own hours, and says where they aren't known", async () => {
    const ids = await teamInTheBrain();
    const { work } = await askedWithBrain(ids);
    const name = work?.name ?? "";
    const { chats } = await askedWithBrain(
      ids,
      thinks({
        step: "Weighing the work.",
        shape: "hours",
        move: "hours",
        notes: [nameKey(name)],
      }),
      says("Its hours aren't known yet.")
    );
    const { chat, ask } = await chats.newChat();
    await ask("Where do the hours go?");

    expect(toldOf(await transcript(chats.stub, chat.id))).toStrictEqual([
      {
        shown: true,
        told: [
          "Shown in the brain.",
          "Their hours today, from the brain's own numbers (say a workflow's hours are not known yet where they are not):",
          // Each told only how often they themselves do it.
          `- ${name}: hours not known yet`,
          'Next in this shape: "most".',
        ].join("\n"),
      },
    ]);
  });

  // Last: the team it adds shares the name "Ops" the tests above name it by.
  it("draws an answer's picture from what the brain shows the person, with who said what, and nothing else of it", async () => {
    const ids = await teamInTheBrain();
    const { member, teamId, said, work } = await askedWithBrain(ids);
    const [ground, brain] = await Promise.all([
      member.api.brain.thinking(),
      member.api.brain.read(),
    ]);

    expect({
      teams: ground.teams,
      statements: ground.statements.map(({ id }) => id),
      saidBy: ground.statements.find(({ id }) => id === said)?.teamId,
      work: ground.workflows.find(({ id }) => id === work?.id),
      keys: Object.keys(ground).toSorted(),
    }).toStrictEqual({
      teams: brain.teams.map(({ id, name }) => ({ id, name })),
      statements: brain.statements.map(({ id }) => id),
      saidBy: teamId,
      work:
        work === undefined
          ? undefined
          : { id: work.id, name: work.name, hours: hoursPerWeek(work) },
      keys: ["statements", "teams", "workflows"],
    });
  });
});

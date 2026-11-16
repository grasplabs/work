import { personalBrainOf } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { undoAction } from "../src/channels/cards.tsx";
import { say } from "../src/channels/words.ts";
import { chatAgentId, personalWorkspaceId } from "../src/chats-rpc.ts";
import { inJurisdiction, workspace } from "../src/durable-objects.ts";
import { model, says, toolResults, toolStep } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { chatIdsOf } from "./code-step-trace.ts";
import { mockIdp } from "./idp.ts";
import type { FakeProvider } from "./model-provider.ts";
import { signedInApi, unique } from "./sign-in.ts";
import {
  failsOnce,
  member,
  memberAnsweredBy,
  mentionIn,
  messageFrom,
  newGroup,
  onGroupRoster,
  post,
  reached,
  watched,
} from "./teams-door.ts";
import type { TeamsPerson } from "./teams-door.ts";

// The agent remembers in a person's Teams direct message as in their own
// chat in Grasp (GRA-1920, threat model on the issue): what they said is
// kept as their own word, in their own store, after the same two checks,
// and shown in that direct message as a notice with Undo, which retires
// it through the same path as Grasp's own notice. Through the real Teams
// door, with the real connect, Brain and audit log; only the model
// provider and Microsoft's Bot Connector are faked. The ways it can fail,
// tried here: a memory nobody sees a notice of (a group chat, a woken
// turn, a notice Teams refused), an Undo by someone else, and an Undo
// pressed twice.

const idp = mockIdp();

watched();

/** Signing people in and whole turns take a while on CI. */
const slow = { timeout: 120_000 };

/** How the second check's instructions begin (agent-remember.ts). */
const checkStart = "You check one thing";

/** The second check answers. */
const checked = (theirs: boolean) => says(JSON.stringify({ theirs }));

/** How many of the second check's requests reached the provider. */
const checksSent = (provider: FakeProvider): number =>
  provider.requests.filter(({ body }) =>
    JSON.stringify(body).includes(checkStart)
  ).length;

/** A word no other text holds. */
const marker = (): string => `m${unique()}`;

/** What the person says, and the model saves of it, about depot `depot`. */
const depotSaid = (depot: string, word: string) => {
  const statement = `Depot ${depot} opens at ${word}`;
  return {
    said: `${statement} from now on, just so you know.`,
    statement,
    saves: toolStep("remember", {
      about: { kind: "customer", name: `Depot ${depot}` },
      type: "fact",
      statement,
      quote: statement,
    }),
  };
};

/** The current statements `personId`'s own store holds of `name`. */
const keptFor = async (personId: string, name: string) => {
  const store = personalBrainOf(inJurisdiction(env, env.BRAIN_STORE), personId);
  const reader = { person: personId, groups: [] };
  const found = await store.findEntities({ reader, name });
  const statements = await Promise.all(
    found.entities.map(async ({ id }) => {
      const { memories } = await store.readMemories({ entity: id, reader });
      return memories.map(({ statement }) => statement);
    })
  );
  return statements.flat();
};

/** Teams' id of the notice posted in `conversation`, and the memory its Undo names. */
const noticeIn = async (conversation: string) => {
  const { sent } = await reached(conversation);
  const notice = sent.find(
    ({ id, activity }) =>
      id !== undefined && JSON.stringify(activity).includes(undoAction)
  );
  const memory = /"value":"(?<memory>[0-9a-f-]{36})"/u.exec(
    JSON.stringify(notice?.activity ?? {})
  )?.groups?.memory;
  if (notice?.id === undefined || memory === undefined) {
    throw new Error("Expected a notice with Undo");
  }
  return { cardId: notice.id, memory, card: JSON.stringify(notice.activity) };
};

/** A press on Undo on the notice `cardId`, naming `memory`, as Teams sends one. */
const undoFrom = (from: TeamsPerson, cardId: string, memory: string) => ({
  ...messageFrom(from, { text: undefined }),
  replyToId: cardId,
  value: { actionId: undoAction, value: memory },
});

/** The notice's edits, as JSON, and the lines said after it, in order. */
const afterNotice = async (conversation: string, cardId: string) => {
  const { sent } = await reached(conversation);
  const at = sent.findIndex(({ id }) => id === cardId);
  return {
    edits: sent
      .filter(({ editOf }) => editOf === cardId)
      .map(({ activity }) => JSON.stringify(activity)),
    lines: sent
      .slice(at + 1)
      .filter(({ editOf }) => editOf === undefined)
      .flatMap(({ activity }) =>
        activity.text === undefined ? [] : [activity.text]
      ),
  };
};

/** The forgetting `userId` did, as the audit log has it, oldest first. */
const forgottenBy = async (userId: string) => {
  const events = await allEvents();
  return events.flatMap(({ action, actor, detail }) =>
    action === "brain.memory.forgotten" &&
    "userId" in actor &&
    actor.userId === userId
      ? [{ actor, outcome: detail.outcome, result: detail.result }]
      : []
  );
};

/** The chat's agent may read the Brain, so a turn recalls before it answers. */
const chatAgentReadsBrain = async () => {
  await requestGranted(idp, await signedInApi(idp, "admin"), {
    subject: { type: "agent", agentId: chatAgentId },
    object: { type: "platform" },
    actions: ["brain"],
    binding: "BRAIN",
  });
};

describe("the agent remembering in a person's Teams direct message", () => {
  it(
    "keeps what they say in their own store, shows the notice there, and recalls it in a later turn there and in their chat in Grasp",
    slow,
    async () => {
      await chatAgentReadsBrain();
      const depot = `d${unique()}`;
      const word = marker();
      const { said, statement, saves } = depotSaid(depot, word);
      const ann = await member(
        idp,
        saves,
        checked(true),
        says("Noted."),
        says("It opens then."),
        says("It opens then.")
      );
      const question = `When does depot ${depot} open?`;

      await post(messageFrom(ann.teams, { text: said }));
      const { card } = await noticeIn(ann.teams.conversation);
      const kept = await keptFor(ann.userId, `Depot ${depot}`);
      const before = ann.provider.requests.length;
      await post(messageFrom(ann.teams, { text: question }));
      const inDirect = JSON.stringify(
        ann.provider.requests.slice(before).map(({ body }) => body)
      );
      const stub = workspace(env, personalWorkspaceId(ann.userId));
      const own = await stub.createChat("Questions", ann.userId, chatAgentId);
      const beforeWeb = ann.provider.requests.length;
      await stub.ask(own.id, { text: question, model });
      const inGrasp = JSON.stringify(
        ann.provider.requests.slice(beforeWeb).map(({ body }) => body)
      );

      expect({
        checks: checksSent(ann.provider),
        kept,
        notice: card.includes(say("remembered", "en", { statement })),
        recalledInDirect: inDirect.includes(word),
        recalledInGrasp: inGrasp.includes(word),
      }).toStrictEqual({
        checks: 1,
        kept: [statement],
        notice: true,
        recalledInDirect: true,
        recalledInGrasp: true,
      });
    }
  );

  it(
    "retires it on the person's own Undo, once: another member's press and a second press retire nothing more",
    slow,
    async () => {
      const depot = `d${unique()}`;
      const { said, statement, saves } = depotSaid(depot, marker());
      const ann = await member(idp, saves, checked(true), says("Noted."));
      const ben = await memberAnsweredBy(idp, ann.provider);
      await post(messageFrom(ann.teams, { text: said }));
      const { cardId, memory } = await noticeIn(ann.teams.conversation);

      // Ben, in his own direct message, presses Undo naming Ann's memory.
      await post(undoFrom(ben.teams, cardId, memory));
      const afterBen = await keptFor(ann.userId, `Depot ${depot}`);
      const press = undoFrom(ann.teams, cardId, memory);
      await post(press);
      // Teams sends the same press again, then Ann presses once more.
      await post(press);
      await post(undoFrom(ann.teams, cardId, memory));
      const { edits, lines } = await afterNotice(
        ann.teams.conversation,
        cardId
      );
      const forgotten = await forgottenBy(ann.userId);
      const toBen = await reached(ben.teams.conversation);

      expect({
        afterBen,
        benSaw: toBen.sent.filter(({ editOf }) => editOf !== undefined),
        after: await keptFor(ann.userId, `Depot ${depot}`),
        edits: edits.map((edit) => edit.includes(say("undone", "en"))),
        lines,
        forgotten,
      }).toStrictEqual({
        afterBen: [statement],
        benSaw: [],
        after: [],
        edits: [true],
        lines: [say("alreadyAnswered", "en")],
        // One Undo: its attempt, then what it did.
        forgotten: [
          {
            actor: { type: "person", userId: ann.userId, via: "teams" },
            outcome: "attempted",
            result: undefined,
          },
          {
            actor: { type: "person", userId: ann.userId, via: "teams" },
            outcome: "done",
            result: "done",
          },
        ],
      });
    }
  );

  it(
    "keeps nothing in a group chat, or in a turn something woke in the direct message, and checks nothing",
    slow,
    async () => {
      const depot = `d${unique()}`;
      const { said, saves } = depotSaid(depot, marker());
      const ann = await member(
        idp,
        says("Hi."),
        saves,
        says("Shared."),
        saves,
        says("Woken.")
      );
      const ben = await memberAnsweredBy(idp, ann.provider);
      const group = newGroup();
      await onGroupRoster(group, [
        { person: ann.teams },
        { person: ben.teams },
      ]);
      const stub = workspace(env, personalWorkspaceId(ann.userId));
      await post(messageFrom(ann.teams, { text: "Hi." }));
      const [direct] = await chatIdsOf(stub, ann.userId, "teams");
      if (direct === undefined) {
        throw new TypeError("Expected her direct message's chat");
      }

      await post(mentionIn(ann.teams, group, said));
      await stub.askUnattended(direct.id, { text: said, model });
      const chats = await chatIdsOf(stub, ann.userId, "teams");
      const outcomes = await Promise.all(
        chats.map(async ({ id }) => {
          const results = await toolResults(stub, id);
          return results.map(({ tool, isError }) => ({ tool, isError }));
        })
      );

      const [inGroup, inDirect] = [
        await reached(group),
        await reached(ann.teams.conversation),
      ];

      expect({
        outcomes: outcomes.flat(),
        kept: await keptFor(ann.userId, `Depot ${depot}`),
        checks: checksSent(ann.provider),
        notices: [...inGroup.sent, ...inDirect.sent].filter(({ activity }) =>
          JSON.stringify(activity).includes(undoAction)
        ),
      }).toStrictEqual({
        outcomes: [
          { tool: "remember", isError: true },
          { tool: "remember", isError: true },
        ],
        kept: [],
        // Never offered, so never checked either.
        checks: 0,
        notices: [],
      });
    }
  );

  it(
    "retires a memory whose notice Teams refused, as nobody sees it to undo",
    slow,
    async () => {
      const depot = `d${unique()}`;
      const word = marker();
      const { said, statement, saves } = depotSaid(depot, word);
      const ann = await member(idp, saves, checked(true), says("Noted."));
      await failsOnce(ann.teams.conversation, word);

      await post(messageFrom(ann.teams, { text: said }));
      const forgotten = await forgottenBy(ann.userId);
      const { sent } = await reached(ann.teams.conversation);

      expect({
        checks: checksSent(ann.provider),
        kept: await keptFor(ann.userId, `Depot ${depot}`),
        // Kept first, as the check passed, then retired.
        forgotten: forgotten.map(({ outcome, result }) => [outcome, result]),
        // The answer itself still came.
        answered: sent.some(
          ({ activity }) =>
            JSON.stringify(activity).includes("Noted.") &&
            !JSON.stringify(activity).includes(statement)
        ),
      }).toStrictEqual({
        checks: 1,
        kept: [],
        forgotten: [
          ["attempted", undefined],
          ["done", "done"],
        ],
        answered: true,
      });
    }
  );
});

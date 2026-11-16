import { personalBrainOf } from "@grasp-os/brain-next/contract";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { undoAction } from "../src/channels/cards.tsx";
import { say } from "../src/channels/words.ts";
import { chatAgentId, personalWorkspaceId } from "../src/chats-rpc.ts";
import {
  chatSession,
  inJurisdiction,
  workspace,
} from "../src/durable-objects.ts";
import {
  model,
  pausedReply,
  says,
  toolResults,
  toolStep,
} from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { breakOwnStore } from "./brain-next-own-store.ts";
import { chatIdsOf } from "./code-step-trace.ts";
import { botConnectorEditsUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { connectModels } from "./model-provider.ts";
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
  providers,
  reached,
  uninstalledFor,
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
// turn, a notice Teams refused, a turn that failed or threw after the
// save, a Workspace restarted mid-turn), an Undo by someone else, outside
// the direct message or pressed twice, and the bot's own words quoted in
// a reply taken for the person's.

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
      // Not the card offering their own Microsoft 365 (connect-own.ts).
      .filter(
        ({ activity }) =>
          !JSON.stringify(activity).includes("/connect-microsoft")
      )
      .flatMap(({ activity }) =>
        activity.text === undefined ? [] : [activity.text]
      ),
  };
};

/**
 * Every forgetting of `userId`'s memories, whoever did it, as the audit
 * log has it, oldest first: who, how it ended, and why when it wasn't
 * their own act.
 */
const forgottenBy = async (userId: string) => {
  const events = await allEvents();
  return events.flatMap(({ action, actor, detail }) =>
    action === "brain.memory.forgotten" && detail.onBehalfOf === userId
      ? [
          {
            actor,
            outcome: detail.outcome,
            result: detail.result,
            cause: detail.cause,
          },
        ]
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
        // What the store kept, about the depot, as Grasp's own notice says it.
        notice: card.includes(
          say("rememberedAbout", "en", { about: `Depot ${depot}`, statement })
        ),
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
        // Told in his own direct message, where he pressed.
        benSaw: toBen.sent.flatMap(({ editOf, activity }) =>
          editOf === undefined
            ? []
            : [JSON.stringify(activity).includes(say("nothingToUndo", "en"))]
        ),
        after: await keptFor(ann.userId, `Depot ${depot}`),
        edits: edits.map((edit) => edit.includes(say("undone", "en"))),
        lines,
        forgotten,
      }).toStrictEqual({
        afterBen: [statement],
        benSaw: [true],
        after: [],
        edits: [true],
        lines: [say("alreadyAnswered", "en")],
        // One Undo: its attempt, then what it did.
        forgotten: [
          {
            actor: { type: "person", userId: ann.userId, via: "teams" },
            outcome: "attempted",
            result: undefined,
            cause: undefined,
          },
          {
            actor: { type: "person", userId: ann.userId, via: "teams" },
            outcome: "done",
            result: "done",
            cause: undefined,
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
          return results.flatMap(({ tool, isError }) =>
            tool === "remember" ? [{ tool, isError }] : []
          );
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
        forgotten: forgotten.map(({ actor, outcome, result, cause }) => [
          actor,
          outcome,
          result,
          cause,
        ]),
        // The answer itself still came.
        answered: sent.some(
          ({ activity }) =>
            JSON.stringify(activity).includes("Noted.") &&
            !JSON.stringify(activity).includes(statement)
        ),
      }).toStrictEqual({
        checks: 1,
        kept: [],
        // By the platform, not by her: she never saw it.
        forgotten: [
          [{ type: "system" }, "attempted", undefined, "card_refused"],
          [{ type: "system" }, "done", "done", "card_refused"],
        ],
        answered: true,
      });
    }
  );
});

/** Whether `memory` was retired, as the audit log has its outcome, waited for. */
const retiredInLog = async (userId: string): Promise<unknown[]> =>
  await vi.waitFor(
    async () => {
      const forgotten = await forgottenBy(userId);
      const done = forgotten.filter(({ outcome }) => outcome === "done");
      expect(done).not.toHaveLength(0);
      return done.map(({ actor, result, cause }) => ({
        actor,
        result,
        cause,
      }));
    },
    { timeout: 20_000 }
  );

/** The person's Teams direct message's chat, once there is one. */
const directChatOf = async (userId: string) =>
  await vi.waitFor(
    async () => {
      const [direct] = await chatIdsOf(
        workspace(env, personalWorkspaceId(userId)),
        userId,
        "teams"
      );
      expect(direct).toBeDefined();
      return direct?.id ?? "";
    },
    { timeout: 20_000 }
  );

/** Restarts the durable object `stub` where it is, as a deploy does. */
const restarted = async (stub: DurableObjectStub): Promise<void> => {
  await runInDurableObject(stub, (_instance, state) => {
    state.abort("Restarted by the test");
  }).catch(() => {
    // Aborting fails the call that aborted: that is the restart.
  });
};

describe("a memory whose notice the person can't see in Teams", () => {
  it(
    "is shown with Undo under the failed line when the turn gives no answer after the save",
    slow,
    async () => {
      const depot = `d${unique()}`;
      const { said, statement, saves } = depotSaid(depot, marker());
      const ann = await member(idp, saves, checked(true), says(""), says(""));

      await post(messageFrom(ann.teams, { text: said }));
      const { card } = await noticeIn(ann.teams.conversation);
      const { lines } = await reached(ann.teams.conversation);

      expect({
        kept: await keptFor(ann.userId, `Depot ${depot}`),
        failed: lines.includes(say("failed", "en")),
        notice: card.includes(statement) && card.includes(undoAction),
      }).toStrictEqual({ kept: [statement], failed: true, notice: true });
    }
  );

  it(
    "is retired when neither the answer nor its notice can be posted",
    slow,
    async () => {
      const depot = `d${unique()}`;
      const { said, saves } = depotSaid(depot, marker());
      const ann = await member(idp, saves, checked(true), says("Noted."));
      // The app is gone from her chat: Teams refuses every post there.
      await uninstalledFor(ann.teams);

      await post(messageFrom(ann.teams, { text: said }));

      expect({
        checks: checksSent(ann.provider),
        retired: await retiredInLog(ann.userId),
        kept: await keptFor(ann.userId, `Depot ${depot}`),
      }).toStrictEqual({
        checks: 1,
        retired: [
          { actor: { type: "system" }, result: "done", cause: "card_refused" },
        ],
        kept: [],
      });
    }
  );

  it("is retired when the turn throws after the save", slow, async () => {
    const depot = `d${unique()}`;
    const { said, saves } = depotSaid(depot, marker());
    const next = pausedReply(says("Noted."), 0);
    const ann = await member(idp, saves, checked(true), next.reply);
    const posted = post(messageFrom(ann.teams, { text: said }));
    // Saved, and handed to the turn's asker, before the answer comes.
    const chatId = await directChatOf(ann.userId);
    const stub = workspace(env, personalWorkspaceId(ann.userId));
    await vi.waitFor(
      async () => {
        const results = await toolResults(stub, chatId);
        expect(results.map(({ tool }) => tool)).toContain("remember");
      },
      { timeout: 20_000 }
    );
    // The model it runs on is no longer allowed, and its chat's object
    // restarts: the turn is set up again, refused, and throws.
    await connectModels(`k-${unique()}`, ["mistral/mistral-large-latest"]);
    await restarted(
      chatSession(
        env,
        personalWorkspaceId(ann.userId),
        chatIdSchema.parse(chatId)
      )
    );
    await posted;
    next.release();
    const { lines } = await reached(ann.teams.conversation);

    expect({
      retired: await retiredInLog(ann.userId),
      kept: await keptFor(ann.userId, `Depot ${depot}`),
      failed: lines.includes(say("failed", "en")),
    }).toStrictEqual({
      retired: [
        { actor: { type: "system" }, result: "done", cause: "turn_threw" },
      ],
      kept: [],
      failed: true,
    });
  });

  it(
    "is retired when it reaches a Workspace restarted mid-turn, with nobody left to post it",
    slow,
    async () => {
      const depot = `d${unique()}`;
      const { said, saves } = depotSaid(depot, marker());
      const first = pausedReply(saves, 0);
      const ann = await member(idp, first.reply, checked(true), says("Noted."));
      const posted = post(messageFrom(ann.teams, { text: said }));
      // The turn's own request, which the model answers by saving.
      await vi.waitFor(
        () => {
          const asked = ann.provider.requests.some(({ body }) => {
            const sent = JSON.stringify(body);
            return sent.includes(said) && sent.includes('"remember"');
          });
          expect(asked).toBeTruthy();
        },
        { timeout: 20_000 }
      );
      // The Workspace restarts before the model asks to save: the door's
      // call to it breaks, and the turn goes on in its chat's object.
      await restarted(workspace(env, personalWorkspaceId(ann.userId)));
      await posted;
      first.release();

      expect({
        checks: await vi.waitFor(
          () => {
            expect(checksSent(ann.provider)).toBe(1);
            return 1;
          },
          { timeout: 20_000 }
        ),
        retired: await retiredInLog(ann.userId),
        kept: await keptFor(ann.userId, `Depot ${depot}`),
      }).toStrictEqual({
        checks: 1,
        retired: [
          { actor: { type: "system" }, result: "done", cause: "no_asker" },
        ],
        kept: [],
      });
    }
  );
});

describe("an Undo that fails", () => {
  it(
    "leaves the notice to be pressed again, and the next press retires the memory",
    slow,
    async () => {
      const depot = `d${unique()}`;
      const { said, statement, saves } = depotSaid(depot, marker());
      const ann = await member(idp, saves, checked(true), says("Noted."));
      await post(messageFrom(ann.teams, { text: said }));
      const { cardId, memory } = await noticeIn(ann.teams.conversation);

      // Her store fails every call while she presses Undo the first time.
      const broken = await breakOwnStore(ann.userId);
      await post(undoFrom(ann.teams, cardId, memory));
      await broken.heal();
      const afterFailed = await keptFor(ann.userId, `Depot ${depot}`);
      await post(undoFrom(ann.teams, cardId, memory));
      const { edits, lines } = await afterNotice(
        ann.teams.conversation,
        cardId
      );

      expect({
        afterFailed,
        lines,
        edits: edits.map((edit) => edit.includes(say("undone", "en"))),
        after: await keptFor(ann.userId, `Depot ${depot}`),
      }).toStrictEqual({
        afterFailed: [statement],
        lines: [say("undoFailed", "en")],
        edits: [true],
        after: [],
      });
    }
  );
});

describe("an Undo whose card can't be updated", () => {
  it(
    "says what it did in a message of its own, and a second press retires nothing more",
    slow,
    async () => {
      const depot = `d${unique()}`;
      const { said, saves } = depotSaid(depot, marker());
      const ann = await member(idp, saves, checked(true), says("Noted."));
      await post(messageFrom(ann.teams, { text: said }));
      const { cardId, memory } = await noticeIn(ann.teams.conversation);
      // Teams refuses every update of a message in her chat.
      await providers().fetch(botConnectorEditsUrl, {
        method: "POST",
        body: JSON.stringify({
          conversation: ann.teams.conversation,
          count: 100,
        }),
      });

      await post(undoFrom(ann.teams, cardId, memory));
      const afterFirst = await reached(ann.teams.conversation);
      await post(undoFrom(ann.teams, cardId, memory));
      const { sent } = await reached(ann.teams.conversation);
      const at = sent.findIndex(({ id }) => id === cardId);
      const after = sent
        .slice(at + 1)
        .filter(
          ({ activity }) =>
            !JSON.stringify(activity).includes("/connect-microsoft")
        );

      expect({
        kept: await keptFor(ann.userId, `Depot ${depot}`),
        edits: afterFirst.sent.filter(({ editOf }) => editOf === cardId),
        said: after.map(({ editOf, activity }) => ({
          edit: editOf !== undefined,
          undone: JSON.stringify(activity).includes(say("undone", "en")),
          answered: activity.text === say("alreadyAnswered", "en"),
        })),
      }).toStrictEqual({
        kept: [],
        edits: [],
        said: [
          { edit: false, undone: true, answered: false },
          { edit: false, undone: false, answered: true },
        ],
      });
    }
  );
});

describe("Undo pressed where the notice isn't", () => {
  it(
    "retires nothing from a group chat, where a press names the bot",
    slow,
    async () => {
      const depot = `d${unique()}`;
      const { said, statement, saves } = depotSaid(depot, marker());
      const ann = await member(idp, saves, checked(true), says("Noted."));
      const ben = await memberAnsweredBy(idp, ann.provider);
      await post(messageFrom(ann.teams, { text: said }));
      const { cardId, memory } = await noticeIn(ann.teams.conversation);
      const group = newGroup();
      await onGroupRoster(group, [
        { person: ann.teams },
        { person: ben.teams },
      ]);

      await post({
        ...mentionIn(ann.teams, group, ""),
        replyToId: cardId,
        value: { actionId: undoAction, value: memory },
      });

      expect({
        kept: await keptFor(ann.userId, `Depot ${depot}`),
        forgotten: await forgottenBy(ann.userId),
      }).toStrictEqual({ kept: [statement], forgotten: [] });
    }
  );
});

describe("a Teams reply that quotes a message", () => {
  it(
    "never passes the bot's quoted words off as the person's own in their direct message, however Teams spells the quote's mark",
    slow,
    async () => {
      /** What a reply quoting the bot, the quote marked `itemtype`, saved. */
      const repliedWith = async (itemtype: string) => {
        const depot = `d${unique()}`;
        const word = marker();
        const { statement } = depotSaid(depot, word);
        // The model quotes the middle of the bot's words, as theirs.
        const ann = await member(
          idp,
          toolStep("remember", {
            about: { kind: "customer", name: `Depot ${depot}` },
            type: "fact",
            statement,
            quote: `opens at ${word}`,
          }),
          checked(true),
          says("Noted.")
        );
        // Teams puts the quoted message into the reply's text, as HTML,
        // with its structure: a blockquote marked as a reply, naming its
        // author.
        const quoted = `<blockquote itemscope="" itemtype="${itemtype}" itemid="1729000000001"><strong itemprop="mri" itemid="28:stephen">Stephen</strong><span itemprop="time" itemid="1729000000001"></span><p itemprop="preview">${statement} from now on.</p></blockquote><p>Thanks!</p>`;
        await post(
          messageFrom(ann.teams, {
            text: quoted,
            textFormat: "xml",
            attachments: [
              { contentType: "text/html", content: `<div>${quoted}</div>` },
            ],
          })
        );
        const chatId = await directChatOf(ann.userId);
        const results = await toolResults(
          workspace(env, personalWorkspaceId(ann.userId)),
          chatId
        );
        return {
          outcomes: results.flatMap(({ tool, isError }) =>
            tool === "remember" ? [isError] : []
          ),
          checks: checksSent(ann.provider),
          kept: await keptFor(ann.userId, `Depot ${depot}`),
        };
      };

      const none = { outcomes: [true], checks: 0, kept: [] };
      expect({
        asTeamsWrites: await repliedWith("http://schema.skype.com/Reply"),
        otherwise: await repliedWith("HTTPS://Schema.Skype.com/reply"),
      }).toStrictEqual({ asTeamsWrites: none, otherwise: none });
    }
  );

  it(
    "hands the turn what a group-chat reply quotes, the only copy of it the agent gets there",
    slow,
    async () => {
      const ann = await member(idp, says("I made the task."));
      const ben = await memberAnsweredBy(idp, ann.provider);
      const group = newGroup();
      await onGroupRoster(group, [
        { person: ann.teams },
        { person: ben.teams },
      ]);
      const order = `Order ${unique()} ships Friday, invoice to follow`;
      const quote = `<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="1729000000002"><strong itemprop="mri" itemid="8:orgid:${ben.teams.aadObjectId}">Ben</strong><span itemprop="time" itemid="1729000000002"></span><p itemprop="preview">${order}</p></blockquote>`;
      const reply = mentionIn(ann.teams, group, "turn this into a task");

      await post({
        ...reply,
        text: `${quote}<p>${reply.text}</p>`,
        textFormat: "xml",
      });
      const sent = JSON.stringify(
        ann.provider.requests.map(({ body }) => body)
      );

      expect({
        quoted: sent.includes(order),
        asked: sent.includes("turn this into a task"),
      }).toStrictEqual({ quoted: true, asked: true });
    }
  );
});

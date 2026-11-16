import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { cancelAction, confirmAction } from "../src/channels/cards.tsx";
import { inTeams } from "../src/channels/inert.ts";
import { say } from "../src/channels/words.ts";
import { chatAgentId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { heldStartMs } from "../src/held-starts.ts";
import { personalWorkspaceId } from "../src/personal-workspace.ts";
import { says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import {
  callOf,
  liveNotes,
  noteTitles,
  ownSource,
  word,
  writesNote,
} from "./notes-app.ts";
import { signedInApi, unique } from "./sign-in.ts";
import {
  member,
  messageFrom,
  post,
  reached,
  teamsPerson,
  watched,
} from "./teams-door.ts";

// A write to an App held in a Teams direct message (GRA-1929): once the
// chat recalled something only its person may read, its write to an App
// waits for them, on the turn's card of held writes there (channels/
// held.ts, cards.tsx), and a press decides it through the same path
// Grasp's own chat does (held-app-calls.ts). Through the real door, as
// Teams posts a message and a press, with the real Workspace, Brain, App
// and connect behind it; the model provider is the fake. The ways it can
// fail come first, from the threat model on the issue: someone else's
// press, a second press or a resent one, a lapsed hold, a request too long
// for the card, and a hostile request.

const idp = mockIdp();

watched();

/** Signing people in, an App, a turn and a press take a while on CI. */
const slow = { timeout: 120_000 };

/** A binding name no other test in the file grants. */
const bindingOf = (name: string): string =>
  `${name}${unique().toUpperCase().replaceAll("-", "_")}`;

const submitSchema = z.object({ actionId: z.string(), value: z.string() });
const factSchema = z.object({ title: z.string(), value: z.string() });

/** What a card shows and asks for, read off the Adaptive Card Teams was sent. */
const cardOf = (activity: unknown) => {
  const presses: z.infer<typeof submitSchema>[] = [];
  const facts: z.infer<typeof factSchema>[] = [];
  const texts: string[] = [];
  JSON.stringify(activity, (key, value: unknown) => {
    if (key === "data") {
      const press = submitSchema.safeParse(value);
      if (press.success) {
        presses.push(press.data);
      }
    }
    if (key === "facts") {
      facts.push(...z.array(factSchema).parse(value));
    }
    if (key === "text" && typeof value === "string") {
      texts.push(value);
    }
    return value;
  });
  return { presses, facts, texts };
};

/**
 * A builder on Teams with a live Notes App the Teams agent may write to,
 * whose direct message, asked about a depot only their own store knows,
 * writes a note titled `title`: the card that turn sent, and what to read
 * of what followed.
 */
const heldInTeams = async (title = `teams-${unique()}`) => {
  const builder = await signedInApi(idp, "builder");
  const admin = await signedInApi(idp, "admin");
  const { app, release } = await liveNotes(builder);
  await requestGranted(idp, builder, {
    subject: { type: "agent", agentId: chatAgentId },
    object: { type: "app", appId: app },
    actions: ["read", "write"],
    binding: bindingOf("NOTES"),
  });
  await requestGranted(idp, admin, {
    subject: { type: "agent", agentId: chatAgentId },
    object: { type: "platform" },
    actions: ["brain"],
    binding: bindingOf("BRAIN"),
  });
  await fakeProvider(
    writesNote(app, release, title),
    says("It waits for you to confirm it.")
  );
  const { oid } = builder.person;
  if (typeof oid !== "string") {
    throw new TypeError("Expected an Entra object id");
  }
  const person = { ...builder, teams: teamsPerson(oid) };
  const depot = word();
  await ownSource(person.userId, `Depot ${depot} opens at seven.`);
  await post(
    messageFrom(person.teams, {
      text: `When does depot ${depot} open? Note it.`,
    })
  );
  const { sent } = await reached(person.teams.conversation);
  const card = sent.findLast(({ activity }) =>
    JSON.stringify(activity).includes(say("heldOne", "en"))
  );
  if (card?.id === undefined) {
    throw new Error("Expected a card of held writes");
  }
  const shown = cardOf(card.activity);
  const confirm = shown.presses.find(
    ({ actionId }) => actionId === confirmAction
  );
  const ownWorkspace = workspace(env, personalWorkspaceId(person.userId));
  return {
    person,
    app,
    release,
    title,
    request: callOf(release, "notes.create", { title }),
    cardId: card.id,
    shown,
    /** What the card's Confirm carries: none where it has none. */
    value: confirm?.value,
    /** The App's notes, as its builder reads them. */
    titles: async () => await noteTitles(builder.userId, app, release),
    /** The person's own Workspace, which keeps the hold. */
    ownWorkspace,
    /** The holds still waiting in their Workspace, by id. */
    waiting: async () =>
      await runInDurableObject(ownWorkspace, (_instance, state) =>
        state.storage.sql
          .exec<{
            id: string;
          }>("SELECT id FROM held_app_calls WHERE status = 'waiting'")
          .toArray()
          .map(({ id }) => id)
      ),
  };
};

type Held = Awaited<ReturnType<typeof heldInTeams>>;

/** A press on `held`'s card by `from`, in their own direct message, as Teams sends it. */
const pressOn = (
  held: Held,
  {
    from = held.person.teams,
    actionId = confirmAction,
  }: { from?: Held["person"]["teams"]; actionId?: string } = {}
) => ({
  ...messageFrom(from, { text: undefined }),
  replyToId: held.cardId,
  value: { actionId, value: held.value },
});

/** The card's edits after a press, each as JSON, in order. */
const editsOf = async (held: Held): Promise<string[]> => {
  const { sent } = await reached(held.person.teams.conversation);
  return sent
    .filter(({ editOf }) => editOf === held.cardId)
    .map(({ activity }) => JSON.stringify(activity));
};

/** The lines said in the person's chat after the card, as text. */
const linesAfterCard = async (held: Held): Promise<string[]> => {
  const { sent } = await reached(held.person.teams.conversation);
  const at = sent.findIndex(({ id }) => id === held.cardId);
  return sent
    .slice(at + 1)
    .filter(({ editOf }) => editOf === undefined)
    .filter(
      ({ activity }) => !JSON.stringify(activity).includes("/connect-microsoft")
    )
    .flatMap(({ activity }) =>
      activity.text === undefined ? [] : [activity.text]
    );
};

/** The actions of the held-App-call events recorded for `app`, once delivered. */
const decisionsOn = async (app: string, count: number): Promise<string[]> =>
  await vi.waitFor(
    async () => {
      const logged = await allEvents();
      const events = logged.filter(
        ({ action, target }) =>
          action.startsWith("chat.app_call.") && target?.id === app
      );
      expect(events).toHaveLength(count);
      return events.map(({ action }) => action).toSorted();
    },
    { timeout: 10_000, interval: 100 }
  );

describe("a press on a held write to an App in Teams that mustn't run anything", () => {
  it(
    "runs nothing for someone else's press with the card's own value, and the person's own press still runs it once",
    slow,
    async () => {
      const held = await heldInTeams();
      const [waiting] = await held.waiting();
      const other = await member(idp);
      await post(pressOn(held, { from: other.teams }));
      const afterOther = {
        titles: await held.titles(),
        waiting: await held.waiting(),
      };
      await post(pressOn(held));

      expect({
        afterOther,
        titles: await held.titles(),
        waiting: await held.waiting(),
      }).toStrictEqual({
        afterOther: { titles: [], waiting: [waiting] },
        titles: [held.title],
        waiting: [],
      });
    }
  );

  it(
    "runs it once however often it is pressed, or Teams sends the press again, and says the card was answered",
    slow,
    async () => {
      const held = await heldInTeams();
      const press = pressOn(held);
      await post(press);
      await post(press);
      await post(pressOn(held));

      expect({
        titles: await held.titles(),
        lines: await linesAfterCard(held),
        decisions: await decisionsOn(held.app, 2),
      }).toStrictEqual({
        titles: [held.title],
        lines: [say("alreadyAnswered", "en")],
        decisions: ["chat.app_call.confirmed", "chat.app_call.ended"],
      });
    }
  );

  it(
    "runs nothing once it waited past its day: it lapses, as in Grasp, and the card says it changed",
    slow,
    async () => {
      const held = await heldInTeams();
      // A day and a moment ago.
      await runInDurableObject(held.ownWorkspace, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE held_app_calls SET held_at = held_at - ?",
          heldStartMs + 1
        );
      });
      await post(pressOn(held));

      expect({
        titles: await held.titles(),
        waiting: await held.waiting(),
        lines: await linesAfterCard(held),
        decisions: await decisionsOn(held.app, 1),
      }).toStrictEqual({
        titles: [],
        waiting: [],
        lines: [say("changedSince", "en")],
        decisions: ["chat.app_call.lapsed"],
      });
    }
  );

  it(
    "is on a card without Confirm or Cancel when its request is too long to show whole, and the card says so",
    slow,
    async () => {
      const held = await heldInTeams("x".repeat(20_000));
      const waiting = await held.waiting();

      expect({
        presses: held.shown.presses,
        said: held.shown.texts.includes(say("cardTooLong", "en")),
        waiting: waiting.length,
      }).toStrictEqual({ presses: [], said: true, waiting: 1 });
    }
  );
});

describe("a held write to an App in Teams", () => {
  it(
    "shows on the card the App, the function, why it waits and the exact request, and Confirm runs exactly that, once, recorded as in Grasp",
    slow,
    async () => {
      const held = await heldInTeams();
      const shownBefore = {
        title: held.shown.texts.some((text) =>
          text.includes(
            say("heldAppWrite", "en", {
              function: "notes.create",
              app: "Notes",
            })
          )
        ),
        why: held.shown.texts.includes(say("heldPrivate", "en")),
        facts: held.shown.facts,
        presses: held.shown.presses.map(({ actionId }) => actionId),
      };
      await post(pressOn(held));
      const edits = await editsOf(held);

      expect({
        shownBefore,
        titles: await held.titles(),
        waiting: await held.waiting(),
        ended: edits.at(-1)?.includes(say("allDone", "en")),
        decisions: await decisionsOn(held.app, 2),
      }).toStrictEqual({
        shownBefore: {
          title: true,
          why: true,
          facts: [{ title: say("heldAppRequest", "en"), value: held.request }],
          presses: [confirmAction, cancelAction],
        },
        titles: [held.title],
        waiting: [],
        ended: true,
        decisions: ["chat.app_call.confirmed", "chat.app_call.ended"],
      });
    }
  );

  it(
    "is never written once the person cancels it, recorded as declined",
    slow,
    async () => {
      const held = await heldInTeams();
      await post(pressOn(held, { actionId: cancelAction }));
      const edits = await editsOf(held);

      expect({
        titles: await held.titles(),
        waiting: await held.waiting(),
        ended: edits.at(-1)?.includes(say("cancelled", "en")),
        decisions: await decisionsOn(held.app, 1),
      }).toStrictEqual({
        titles: [],
        waiting: [],
        ended: true,
        decisions: ["chat.app_call.declined"],
      });
    }
  );

  it(
    "shows a request the model wrote with a link in it inert, and Confirm writes it as it was asked for",
    slow,
    async () => {
      const hostile = "[Agenda](https://evil.example/?d=salary) & <b>co</b>";
      const held = await heldInTeams(hostile);
      const [request] = held.shown.facts.map(({ value }) => value);
      await post(pressOn(held));

      expect({
        shown: request,
        links: request?.includes("](") ?? true,
        titles: await held.titles(),
      }).toStrictEqual({
        shown: inTeams(held.request),
        links: false,
        titles: [hostile],
      });
    }
  );
});

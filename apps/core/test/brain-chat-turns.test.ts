import { brainOf, recallBudgetMax } from "@grasp-os/brain-next/contract";
import { chatIdSchema } from "@grasp-os/shared/ids";
import type { ChatId } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { drainAuditOutboxes } from "../src/audit-outbox.ts";
import { noteHandOvers } from "../src/brain-hand-overs.ts";
import { chatSource, chatTurnOf } from "../src/brain-next-origins.ts";
import {
  addSource,
  readSourceVersionAs,
  recallAs,
  workBrain,
} from "../src/brain-next.ts";
import type { Producers, SourceRef } from "../src/brain-next.ts";
import { producersOf, relayHandOvers } from "../src/brain-sources.ts";
import { chatAgentId, personalWorkspaceId } from "../src/chats-rpc.ts";
import { inJurisdiction, workspace } from "../src/durable-objects.ts";
import { codeStep, model, says } from "./agent-chat.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// A person's chat turns in the new Brain (GRA-1805), through the real
// path: a turn answered in their Workspace, noted from its audit event as
// the Workspace's outbox drains, relayed to the Brain's queue and handed
// over by a tick, as core's clock does; and a chat deleted through `/rpc`.
// From the threat model on the issue, each way it can fail:
//
// - A turn lands where anyone but its person reads it (threats 1, 2).
// - What the agent ran or read is kept as the turn (threat 2).
// - A chat platform's chat, a woken turn or a restricted chat is handed
//   over (threats 3, 4, 5).
// - A deleted chat's turns stay, or come back with a hand-over that lands
//   after the delete (threat 6).
// - A delete whose erasure failed lets the chat go (threat 7).

const idp = mockIdp();

/** A word nothing else holds. */
const word = (): string => `w${crypto.randomUUID().replaceAll("-", "")}`;

/** The queue's clock across this file: only forward, as core's clock goes. */
const clock = { at: Date.now() };

/** A tick's time, past the last one's (and never before now). */
const later = (): Date => {
  clock.at = Math.max(clock.at + 1, Date.now());
  return new Date(clock.at);
};

/** Hands over what changed, as core's clock does, with `producers`. */
const handOverNow = async (
  producers: Producers = producersOf(env)
): Promise<void> => {
  await drainAuditOutboxes(env);
  await relayHandOvers(env);
  await workBrain(env, later(), producers);
};

/** The sources `personId` recalls for `question`, reading their own store or not. */
const recalled = async (
  personId: string,
  question: string,
  personal = true
): Promise<SourceRef[]> => {
  const { items } = await recallAs(env, personId, {
    question,
    budget: { tokens: recallBudgetMax },
    personal,
  });
  return items.map(({ source }) => source);
};

/** Hands over until `personId` recalls `question`, within a bound. */
const handedTo = async (
  personId: string,
  question: string
): Promise<SourceRef[]> =>
  await vi.waitFor(
    async () => {
      await handOverNow();
      const found = await recalled(personId, question);
      expect(found, "the turn was never handed over").not.toStrictEqual([]);
      return found;
    },
    { timeout: 15_000, interval: 200 }
  );

/** The hand-over events recorded for source `id`, in order. */
const outcomesFor = async (id: string): Promise<string[]> => {
  const logged = await allEvents();
  return logged
    .filter(
      ({ action, target }) =>
        action.startsWith("brain.source.") && target?.id === id
    )
    .map(({ action }) => action);
};

/** The `chat.turn_kept` events of `personId`'s chats, of chat `chatId` if given. */
const keptEvents = async (personId: string, chatId = "") => {
  const logged = await allEvents();
  return logged.filter(
    ({ action, target }) =>
      action === "chat.turn_kept" &&
      target?.id.startsWith(`${personId}/${chatId}`) === true
  );
};

/** A store binding out of reach: every store it names throws. */
const outOfReach = (): never => {
  throw new Error("The Brain is out of reach");
};

/** A Workspace object's env, as the test reaches into it. */
const envOf = (instance: object): object => {
  const objectEnv: unknown = Reflect.get(instance, "env");
  if (typeof objectEnv !== "object" || objectEnv === null) {
    throw new TypeError("The Workspace object has no env");
  }
  return objectEnv;
};

/**
 * The Workspace object's `BRAIN_STORE` swapped for one out of reach until
 * the returned function puts it back.
 */
const brainOutOfReach = async (
  stub: ReturnType<typeof workspace>
): Promise<() => Promise<void>> => {
  const real: unknown = await runInDurableObject(stub, (instance) => {
    const objectEnv = envOf(instance);
    const was: unknown = Reflect.get(objectEnv, "BRAIN_STORE");
    Reflect.set(objectEnv, "BRAIN_STORE", {
      getByName: outOfReach,
      jurisdiction: () => ({ getByName: outOfReach }),
    });
    return was;
  });
  return async () => {
    await runInDurableObject(stub, (instance) => {
      Reflect.set(envOf(instance), "BRAIN_STORE", real);
    });
  };
};

/** A member with a chat of their own in Grasp's app, answered by `replies`. */
const chatter = async (...replies: ProviderReply[]) => {
  const person = await signedInApi(idp, "user");
  const stub = workspace(env, personalWorkspaceId(person.userId));
  await fakeProvider(...replies);
  const made = await person.api.chats.create("Questions");
  const chatId: ChatId = chatIdSchema.parse(made.id);
  const ask = async (text: string) => await stub.ask(chatId, { text, model });
  return { person, stub, chatId, ask };
};

describe("a person's chat turn", () => {
  it("is kept in their own store alone: recalled by them in their own chat, by nobody else, and never from the shared store", async () => {
    const marker = word();
    const { person, chatId, ask } = await chatter(
      says(`The codename is ${marker}.`)
    );
    const ben = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");

    await ask("What is the codename?");
    const [source] = await handedTo(person.userId, marker);

    const turn = chatTurnOf(source?.id ?? "");
    expect({
      source: { producer: source?.producer, ...turn, answerId: undefined },
      ben: await recalled(ben.userId, marker),
      admin: await recalled(admin.userId, marker),
      theirsOutsideTheirChat: await recalled(person.userId, marker, false),
      shared: await brainOf(inJurisdiction(env, env.BRAIN_STORE)).keyState(
        `chat:${source?.id ?? ""}`
      ),
    }).toStrictEqual({
      source: {
        producer: "chat",
        personId: person.userId,
        chatId,
        answerId: undefined,
      },
      ben: [],
      admin: [],
      theirsOutsideTheirChat: [],
      shared: "free",
    });
  });

  it("holds what was asked and what was answered, nothing the agent ran, and its event holds neither", async () => {
    const marker = word();
    const ran = word();
    const { person, chatId, ask } = await chatter(
      codeStep(
        `console.log(${JSON.stringify(ran)}); return ${JSON.stringify(ran)};`
      ),
      says(`Done: ${marker}.`)
    );

    await ask(`Run it for ${marker}?`);
    const [source] = await handedTo(person.userId, marker);
    if (source === undefined) {
      throw new Error("Nothing was handed over");
    }
    const kept = await readSourceVersionAs(env, person.userId, {
      source,
      version: 1,
    });

    expect(kept?.text).toBe(
      `Asked:\nRun it for ${marker}?\n\nAnswered:\nDone: ${marker}.`
    );
    await expect(recalled(person.userId, ran)).resolves.toStrictEqual([]);
    expect(JSON.stringify(await keptEvents(person.userId, chatId))).not.toMatch(
      new RegExp(`${marker}|${ran}`, "u")
    );
  });

  it("is never handed over from a chat app's chat, a turn nothing but a wake asked for, or a restricted chat", async () => {
    const marker = word();
    const { person, stub, chatId, ask } = await chatter(
      says(`Woken ${marker}.`),
      says(`Teams ${marker}.`),
      says(`Restricted ${marker}.`),
      says(`Asked ${marker}.`)
    );
    await stub.askUnattended(chatId, { text: `Wake ${marker}`, model });
    const teams = await stub.createChat(
      "On Teams",
      person.userId,
      chatAgentId,
      undefined,
      "teams"
    );
    await stub.ask(teams.id, { text: `Teams ${marker}?`, model });
    const restricted = await person.api.chats.create("Restricted");
    await stub.restrictChat(chatIdSchema.parse(restricted.id));
    await stub.ask(chatIdSchema.parse(restricted.id), {
      text: `Restricted ${marker}?`,
      model,
    });
    // A turn of their own chat after them, handed over as ever.
    await ask(`Asked ${marker}?`);
    const found = await handedTo(person.userId, marker);
    const kept = await keptEvents(person.userId);

    expect({
      found: found.length,
      kept: kept.length,
    }).toStrictEqual({ found: 1, kept: 1 });
  });
});

describe("a deleted chat", () => {
  it("takes every turn with it from its person's store, and refuses a turn handed over again after", async () => {
    const marker = word();
    const { person, chatId, ask } = await chatter(
      says(`First ${marker}.`),
      says(`Second ${marker}.`)
    );
    await ask("One?");
    await ask("Two?");
    await vi.waitFor(
      async () => {
        await handOverNow();
        await expect(recalled(person.userId, marker)).resolves.toHaveLength(2);
      },
      { timeout: 15_000, interval: 200 }
    );
    const [event] = await keptEvents(person.userId, chatId);
    const turn = chatTurnOf(event?.target?.id ?? "");

    await person.api.chats.remove(chatId);
    // The turn noted again, as a drain cut short notes it.
    if (event !== undefined) {
      await noteHandOvers(env, [event]);
    }
    await handOverNow();

    await expect(recalled(person.userId, marker)).resolves.toStrictEqual([]);
    // Added after the delete by any path, it is refused for good.
    await expect(
      outcome(
        addSource(env, {
          source: { producer: "chat", id: event?.target?.id ?? "" },
          change: "answer",
          text: `Late ${marker}.`,
          readers: { kind: "owner", personId: person.userId },
          group: chatSource(person.userId, turn?.chatId ?? chatId),
        })
      )
    ).resolves.toBe("brain.source_erased");
  });

  it("refuses a turn read before its chat was deleted and added after", async () => {
    const marker = word();
    const { person, chatId, ask } = await chatter(says(`Racing ${marker}.`));
    await ask("Race?");
    await vi.waitFor(
      async () => {
        await expect(keptEvents(person.userId, chatId)).resolves.toHaveLength(
          1
        );
      },
      { timeout: 15_000, interval: 200 }
    );
    const core = producersOf(env);
    // The chat is deleted after its turn was read, before it is added.
    const racing: Producers = {
      ...core,
      read: async (source) => {
        const handed = await core.read(source);
        if (source.producer === "chat") {
          await person.api.chats.remove(chatId);
        }
        return handed;
      },
    };

    await handOverNow(racing);

    const [event] = await keptEvents(person.userId, chatId);
    await expect(outcomesFor(event?.target?.id ?? "")).resolves.toStrictEqual([
      "brain.source.handover_started",
      "brain.source.handover_refused",
    ]);
    await expect(recalled(person.userId, marker)).resolves.toStrictEqual([]);
  });

  it("stays when its turns can't be erased from the Brain, and goes once they can", async () => {
    const marker = word();
    const { person, stub, chatId, ask } = await chatter(
      says(`Kept ${marker}.`)
    );
    await ask("Keep?");
    await handedTo(person.userId, marker);
    const putBack = await brainOutOfReach(stub);

    const refused = await outcome(person.api.chats.remove(chatId));
    const listed = await person.api.chats.list();
    await putBack();
    await person.api.chats.remove(chatId);

    expect({
      refused: refused === "ok" ? "deleted" : "refused",
      kept: listed.map(({ id }) => id),
      after: await recalled(person.userId, marker),
    }).toStrictEqual({ refused: "refused", kept: [chatId], after: [] });
  });
});

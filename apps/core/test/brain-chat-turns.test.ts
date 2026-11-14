import { brainOf, recallBudgetMax } from "@grasp-os/brain-next/contract";
import type { Brain, SourceErasure } from "@grasp-os/brain-next/contract";
import { chatIdSchema } from "@grasp-os/shared/ids";
import type { ChatId } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { and, eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import { drainAuditOutboxes } from "../src/audit-drains.ts";
import { organizationId } from "../src/auth/auth.ts";
import { noteHandOvers } from "../src/brain-hand-overs.ts";
import {
  chatSource,
  chatTurnOf,
  uploadSource,
} from "../src/brain-next-origins.ts";
import {
  addSource,
  eraseSource,
  readSourceVersionAs,
  recallAs,
  workBrain,
} from "../src/brain-next.ts";
import type { Producers, SourceRef } from "../src/brain-next.ts";
import {
  endHandOversOf,
  producersOf,
  relayHandOvers,
} from "../src/brain-sources.ts";
import { chatAgentId, personalWorkspaceId } from "../src/chats-rpc.ts";
import { brainHandOvers, teamMembers, teams } from "../src/db/core/schema.ts";
import { inJurisdiction, workspace } from "../src/durable-objects.ts";
import { codeStep, model, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
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
// - Anything but the person's own question is kept: what the agent ran or
//   read, or an answer, which can quote it (this turn's step, an earlier
//   turn's, the recall, whatever the prompt held) and would outlive it
//   being erased or the person losing it (threat 2; review rounds 1, 2).
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
const later = (aheadMs = 0): Date => {
  clock.at = Math.max(clock.at + 1, Date.now()) + aheadMs;
  return new Date(clock.at);
};

/** Past any backoff a failed hand-over waits out (the queue's, a few hours at most). */
const pastBackoffMs = 6 * 60 * 60 * 1000;

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

/** The text kept of the one turn `personId` recalls for `question`, once handed over. */
const keptTextOf = async (
  personId: string,
  question: string
): Promise<string | undefined> => {
  const [source] = await handedTo(personId, question);
  if (source === undefined) {
    throw new Error("Nothing was handed over");
  }
  const kept = await readSourceVersionAs(env, personId, { source, version: 1 });
  return kept?.text;
};

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

/** How the hand-over of source `id` ended in the log: each event, with its reason. */
const endingsFor = async (id: string): Promise<string[]> => {
  const logged = await allEvents();
  return logged
    .filter(
      ({ action, target }) =>
        action.startsWith("brain.source.") &&
        action !== "brain.source.handover_started" &&
        target?.id === id
    )
    .map(({ action, detail }) =>
      typeof detail?.reason === "string" ? `${action}:${detail.reason}` : action
    );
};

/** The `chat.turn_noted` events of `personId`'s chats, of chat `chatId` if given. */
const notedEvents = async (personId: string, chatId = "") => {
  const logged = await allEvents();
  return logged.filter(
    ({ action, target }) =>
      action === "chat.turn_noted" &&
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

/**
 * The Workspace object's audit log out of reach, so its outbox keeps what
 * it notes, until the returned function puts it back.
 */
const auditLogOutOfReach = async (
  stub: ReturnType<typeof workspace>
): Promise<() => Promise<void>> => {
  const real: unknown = await runInDurableObject(stub, (instance) => {
    const objectEnv = envOf(instance);
    const was: unknown = Reflect.get(objectEnv, "AUDIT_LOG");
    Reflect.set(objectEnv, "AUDIT_LOG", {
      getByName: outOfReach,
      jurisdiction: () => ({ getByName: outOfReach }),
    });
    return was;
  });
  return async () => {
    await runInDurableObject(stub, (instance) => {
      Reflect.set(envOf(instance), "AUDIT_LOG", real);
    });
  };
};

/** How many audit events the Workspace object's outbox still holds. */
const outboxLeft = async (stub: ReturnType<typeof workspace>) =>
  await runInDurableObject(stub, (_, state) => {
    const [row] = state.storage.sql
      .exec<{ count: number }>("SELECT count(*) AS count FROM audit_outbox")
      .toArray();
    return row?.count ?? 0;
  });

/** The hand-overs still open whose source names `personId`, by their ids. */
const openFor = async (personId: string): Promise<string[]> => {
  const rows = await drizzle(env.DB)
    .select({ sourceId: brainHandOvers.sourceId })
    .from(brainHandOvers)
    .where(
      and(
        eq(brainHandOvers.producer, "chat"),
        like(brainHandOvers.sourceId, `${personId}/%`)
      )
    );
  return rows.map(({ sourceId }) => sourceId);
};

/**
 * `count` questions of `personId`'s chat `chatId` noted, as their outbox's
 * drain notes them, none handed over yet: their sources' ids.
 */
const notedFor = async (
  personId: string,
  chatId: string,
  count: number
): Promise<string[]> => {
  const ids = Array.from(
    { length: count },
    (_, index) => `${personId}/${chatId}/${index + 1}`
  );
  await noteHandOvers(
    env,
    ids.map((id) => ({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      source: "core",
      actor: { type: "system" },
      action: "chat.turn_noted",
      target: { type: "chat_turn", id },
      provenance: [],
      detail: {},
    }))
  );
  return ids;
};

/** Each distinct list of hand-over events with reasons the sources `ids` have, as JSON. */
const endingsOfAll = async (ids: readonly string[]): Promise<string[]> => {
  const logged = await allEvents();
  const endings = new Set(
    ids.map((id) =>
      JSON.stringify(
        logged
          .filter(
            ({ action, target }) =>
              action.startsWith("brain.source.") && target?.id === id
          )
          .map(({ action, detail }) => `${action}:${String(detail?.reason)}`)
      )
    )
  );
  return [...endings];
};

/**
 * `real`, whose next batch writes its first `statements` and then fails,
 * as a database failing part-way through: each later batch as `real`.
 */
const failsAfter = (real: D1Database, statements: number): D1Database => {
  let failed = false;
  return {
    prepare: (query) => real.prepare(query),
    batch: async <T>(list: D1PreparedStatement[]) => {
      if (failed) {
        return await real.batch<T>(list);
      }
      failed = true;
      await real.batch(list.slice(0, statements));
      throw new Error("D1 failed part-way");
    },
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
};

/**
 * The Workspace object's Knowledge database (today's Brain, which a
 * delete erases its captures from after the new Brain's part) failing
 * every batch until the returned function puts it back.
 */
const knowledgeOutOfReach = async (
  stub: ReturnType<typeof workspace>
): Promise<() => Promise<void>> => {
  const real: unknown = await runInDurableObject(stub, (instance) => {
    const objectEnv = envOf(instance);
    const was: unknown = Reflect.get(objectEnv, "KNOWLEDGE");
    Reflect.set(objectEnv, "KNOWLEDGE", {
      prepare: outOfReach,
      batch: outOfReach,
      exec: outOfReach,
    });
    return was;
  });
  return async () => {
    await runInDurableObject(stub, (instance) => {
      Reflect.set(envOf(instance), "KNOWLEDGE", real);
    });
  };
};

/** Whether `value` is the Brain stores' namespace, as an object's env binds it. */
const isNamespace = (value: unknown): value is Env["BRAIN_STORE"] =>
  typeof value === "object" && value !== null && "getByName" in value;

/** Where a held erase keeps its gate, on the Workspace object. */
const gateKey = Symbol("brain erase gate");

/** A held erase's gate, made inside the object it holds. */
interface Gate {
  reached: boolean;
  end: PromiseWithResolvers<"fail" | "go">;
}

/** The gate `holdBrainErase` put on `instance`. */
const gateOf = (instance: object): Gate => {
  const gate: unknown = Reflect.get(instance, gateKey);
  if (typeof gate !== "object" || gate === null || !("end" in gate)) {
    throw new TypeError("No erase is held");
  }
  // SAFETY: only `holdBrainErase` sets it, as a `Gate`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return gate as Gate;
};

/**
 * The Workspace object's Brain stores with their `eraseSource` held until
 * `end` says whether it fails or goes ahead. The gate is made and opened
 * inside the object: what an object awaits must be its own.
 */
const holdBrainErase = async (stub: ReturnType<typeof workspace>) => {
  // The object's own env replaced, not changed: the test Worker's env,
  // which the clock's relay in the test uses, stays as it was.
  const before = await runInDurableObject(stub, (instance) => {
    const objectEnv = envOf(instance);
    const real: unknown = Reflect.get(objectEnv, "BRAIN_STORE");
    if (!isNamespace(real)) {
      throw new TypeError("The Workspace object has no Brain store");
    }
    const gate: Gate = {
      reached: false,
      end: Promise.withResolvers<"fail" | "go">(),
    };
    Reflect.set(instance, gateKey, gate);
    const held = (store: Brain) => ({
      eraseSource: async (request: SourceErasure) => {
        gate.reached = true;
        if ((await gate.end.promise) === "fail") {
          throw new Error("The Brain is out of reach");
        }
        await store.eraseSource(request);
      },
    });
    Reflect.set(instance, "env", {
      ...objectEnv,
      BRAIN_STORE: {
        getByName: (name: string) => held(real.getByName(name)),
        jurisdiction: (where: DurableObjectJurisdiction) => ({
          getByName: (name: string) =>
            held(real.jurisdiction(where).getByName(name)),
        }),
      },
    });
    return objectEnv;
  });
  return {
    reached: async () => {
      await vi.waitFor(
        async () => {
          await expect(
            runInDurableObject(stub, (instance) => gateOf(instance).reached)
          ).resolves.toBeTruthy();
        },
        { timeout: 10_000, interval: 20 }
      );
    },
    end: async (how: "fail" | "go") => {
      await runInDurableObject(stub, (instance) => {
        gateOf(instance).end.resolve(how);
      });
    },
    putBack: async () => {
      await runInDurableObject(stub, (instance) => {
        Reflect.set(instance, "env", before);
      });
    },
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
    const { person, chatId, ask } = await chatter(says("It is noted."));
    const ben = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");

    await ask(`Is the codename ${marker}?`);
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

  // An answer can quote anything its prompt held, so none is kept
  // (GRA-1855 brings answers back); nor is the event any of the words.
  it("holds what was asked, never what was answered, and its event holds neither", async () => {
    const marker = word();
    const answered = word();
    const { person, chatId, ask } = await chatter(says(`Plainly ${answered}.`));

    await ask(`Say it for ${marker}?`);

    await expect(keptTextOf(person.userId, marker)).resolves.toBe(
      `Say it for ${marker}?`
    );
    await expect(recalled(person.userId, answered)).resolves.toStrictEqual([]);
    expect(
      JSON.stringify(await notedEvents(person.userId, chatId))
    ).not.toMatch(new RegExp(marker, "u"));
  });

  // The reviewer's probe A1 (round 2): an earlier turn's step, quoted by
  // a later turn that ran none.
  it("keeps nothing of what an earlier turn's step read, when a later turn quotes it", async () => {
    const secret = word();
    const topic = word();
    const { person, ask } = await chatter(
      codeStep(
        `console.log(${JSON.stringify(secret)}); return ${JSON.stringify(secret)};`
      ),
      says("Done."),
      says(`As the step showed: ${secret}.`)
    );

    await ask(`Run it for ${topic}?`);
    await ask(`And ${topic} again?`);
    await vi.waitFor(
      async () => {
        await handOverNow();
        await expect(recalled(person.userId, topic)).resolves.toHaveLength(2);
      },
      { timeout: 15_000, interval: 200 }
    );

    await expect(recalled(person.userId, secret)).resolves.toStrictEqual([]);
  });

  // The reviewer's probe C (round 2): two questions before one answer,
  // a step between them.
  it("keeps only the last question before an answer, never the answer or a step between", async () => {
    const secret = word();
    const { person, stub, chatId } = await chatter();
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const by = { api: "x", provider: "x", model: "x", usage };
    const rows = [
      {
        role: "user",
        content: [{ type: "text", text: "First?" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "c1", name: "executeCode", arguments: {} },
        ],
        ...by,
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "executeCode",
        content: [{ type: "text", text: secret }],
        isError: false,
        timestamp: 3,
      },
      {
        role: "user",
        content: [{ type: "text", text: "Second?" }],
        timestamp: 4,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: `It said ${secret}.` }],
        ...by,
        stopReason: "stop",
        timestamp: 5,
      },
    ];

    const kept = await runInDurableObject(stub, (instance, state) => {
      let last = 0;
      for (const row of rows) {
        ({ id: last } = state.storage.sql
          .exec<{ id: number }>(
            "INSERT INTO chat_messages (chat_id, message, created_at) VALUES (?, ?, ?) RETURNING id",
            chatId,
            JSON.stringify(row),
            Date.now()
          )
          .one());
      }
      return instance.turnForBrain(chatId, person.userId, last);
    });

    expect(kept).toStrictEqual({ kind: "question", question: "Second?" });
  });

  // The reviewer's probe (round 1): what the recall before the question
  // found, quoted in the answer, never outlives its source's erasure or
  // the person leaving the team that could read it.
  it("keeps nothing of a team's source the recall found, once it is erased and the person left the team", async () => {
    const topic = word();
    const marker = word();
    const person = await signedInApi(idp, "user");
    const admin = await signedInApi(idp, "admin");
    const stub = workspace(env, personalWorkspaceId(person.userId));
    const agentId = crypto.randomUUID();
    const made = await stub.createChat("Questions", person.userId, agentId);
    await requestGranted(idp, admin, {
      subject: { type: "agent", agentId },
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    const teamId = crypto.randomUUID();
    const db = drizzle(env.DB);
    await db.insert(teams).values({
      id: teamId,
      name: `Team ${teamId}`,
      organizationId,
      createdAt: new Date(),
    });
    await db.insert(teamMembers).values({
      id: crypto.randomUUID(),
      teamId,
      userId: person.userId,
      createdAt: new Date(),
    });
    const upload = uploadSource(crypto.randomUUID());
    const readers = { kind: "team", teamId } as const;
    await addSource(env, {
      source: upload,
      change: "1",
      text: `Board minutes on ${topic}: the board decided ${marker}.`,
      readers,
    });
    await fakeProvider(says(`On ${topic} the board decided ${marker}.`));

    await stub.ask(made.id, { text: `What about ${topic}?`, model });
    await expect(keptTextOf(person.userId, topic)).resolves.toBe(
      `What about ${topic}?`
    );
    await eraseSource(env, { source: upload, readers, reason: "deleted" });
    await db
      .delete(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, person.userId)
        )
      );

    await expect(recalled(person.userId, marker)).resolves.toStrictEqual([]);
  });

  // The re-check as it is handed over (threat 5): the reviewer's probe.
  it("is not handed over once its chat was restricted after it was noted, and its note ends in why", async () => {
    const marker = word();
    const { person, stub, chatId, ask } = await chatter(says("Before."));
    await ask(`Before ${marker}?`);
    await vi.waitFor(
      async () => {
        await expect(notedEvents(person.userId, chatId)).resolves.toHaveLength(
          1
        );
      },
      { timeout: 15_000, interval: 200 }
    );

    await stub.restrictChat(chatId);
    await handOverNow();
    await handOverNow();

    const [noted] = await notedEvents(person.userId, chatId);
    await expect(recalled(person.userId, marker)).resolves.toStrictEqual([]);
    // Once: the item was done, so the second tick hands nothing over.
    await expect(endingsFor(noted?.target?.id ?? "")).resolves.toStrictEqual([
      "brain.source.handover_skipped:restricted",
    ]);
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
    const onTeams = await stub.createChat(
      "On Teams",
      person.userId,
      chatAgentId,
      undefined,
      "teams"
    );
    await stub.ask(onTeams.id, { text: `Teams ${marker}?`, model });
    const restricted = await person.api.chats.create("Restricted");
    await stub.restrictChat(chatIdSchema.parse(restricted.id));
    await stub.ask(chatIdSchema.parse(restricted.id), {
      text: `Restricted ${marker}?`,
      model,
    });
    // A turn of their own chat after them, handed over as ever.
    await ask(`Asked ${marker}?`);
    const found = await handedTo(person.userId, marker);
    const kept = await notedEvents(person.userId);

    expect({
      found: found.length,
      kept: kept.length,
    }).toStrictEqual({ found: 1, kept: 1 });
  });
});

describe("a deleted chat", () => {
  it("takes every turn with it from its person's store, and refuses a turn handed over again after", async () => {
    const marker = word();
    const { person, chatId, ask } = await chatter(says("One."), says("Two."));
    await ask(`One ${marker}?`);
    await ask(`Two ${marker}?`);
    await vi.waitFor(
      async () => {
        await handOverNow();
        await expect(recalled(person.userId, marker)).resolves.toHaveLength(2);
      },
      { timeout: 15_000, interval: 200 }
    );
    const [event] = await notedEvents(person.userId, chatId);
    const turn = chatTurnOf(event?.target?.id ?? "");

    await person.api.chats.remove(chatId);
    // The turn noted again, as a drain cut short notes it.
    if (event !== undefined) {
      await noteHandOvers(env, [event]);
    }
    await handOverNow();

    await expect(recalled(person.userId, marker)).resolves.toStrictEqual([]);
    // The note made again ends in why it is not kept.
    await expect(endingsFor(event?.target?.id ?? "")).resolves.toStrictEqual([
      "brain.source.handed_over",
      "brain.source.handover_skipped:deleted",
    ]);
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
    const { person, chatId, ask } = await chatter(says("Raced."));
    await ask(`Race ${marker}?`);
    await vi.waitFor(
      async () => {
        await expect(notedEvents(person.userId, chatId)).resolves.toHaveLength(
          1
        );
      },
      { timeout: 15_000, interval: 200 }
    );
    const core = producersOf(env);
    // The chat is deleted after its turn was read, before it is added.
    const racing: Producers = {
      attempt: async (source) => {
        const attempt = await core.attempt(source);
        if (source.producer === "chat") {
          await person.api.chats.remove(chatId);
        }
        return attempt;
      },
    };

    await handOverNow(racing);

    const [event] = await notedEvents(person.userId, chatId);
    await expect(outcomesFor(event?.target?.id ?? "")).resolves.toStrictEqual([
      "brain.source.handover_started",
      "brain.source.handover_refused",
    ]);
    await expect(recalled(person.userId, marker)).resolves.toStrictEqual([]);
  });

  it("stays when its turns can't be erased from the Brain, and goes once they can", async () => {
    const marker = word();
    const { person, stub, chatId, ask } = await chatter(
      says("Kept."),
      says("Still here.")
    );
    await ask(`Keep ${marker}?`);
    await handedTo(person.userId, marker);
    const putBack = await brainOutOfReach(stub);

    const refused = await outcome(person.api.chats.remove(chatId));
    const listed = await person.api.chats.list();
    // Nothing of it was touched: it answers, and keeps its questions.
    const again = await outcome(ask(`Again ${marker}?`));
    await putBack();
    await handedTo(person.userId, `Again ${marker}`);
    await person.api.chats.remove(chatId);

    expect({
      refused: refused === "ok" ? "deleted" : "refused",
      kept: listed.map(({ id }) => id),
      again,
      after: await recalled(person.userId, marker),
    }).toStrictEqual({
      refused: "refused",
      kept: [chatId],
      again: "ok",
      after: [],
    });
  });

  // Greptile, first paid review: a hand-over that meets the chat while its
  // deletion is under way is tried again, never recorded as deleted: it
  // ends as the deletion does, either way exactly once.
  it.each([
    {
      ending: "fail" as const,
      expected: {
        deleted: "internal.unexpected",
        ended: ["brain.source.handed_over"],
        found: 1,
      },
    },
    {
      ending: "go" as const,
      expected: {
        deleted: "ok",
        ended: ["brain.source.handover_skipped:deleted"],
        found: 0,
      },
    },
  ])(
    "hands a question over that met its chat being deleted as the deletion ends ($ending)",
    async ({ ending, expected }) => {
      const marker = word();
      const { person, stub, chatId, ask } = await chatter(says("Noted."));
      await ask(`Hold ${marker}?`);
      await vi.waitFor(
        async () => {
          await expect(
            notedEvents(person.userId, chatId)
          ).resolves.toHaveLength(1);
        },
        { timeout: 15_000, interval: 200 }
      );
      const held = await holdBrainErase(stub);
      const deleting = outcome(person.api.chats.remove(chatId));
      await held.reached();

      await handOverNow();
      await held.end(ending);
      const deleted = await deleting;
      await held.putBack();
      await drainAuditOutboxes(env);
      await workBrain(env, later(pastBackoffMs), producersOf(env));

      const [noted] = await notedEvents(person.userId, chatId);
      const found = await recalled(person.userId, marker);
      expect({
        deleted,
        ended: await endingsFor(noted?.target?.id ?? ""),
        found: found.length,
      }).toStrictEqual(expected);
    }
  );

  // The mirror (review round 3): the Brain's part done, a later step
  // failing. The chat stays and answers; its questions are no longer kept,
  // each ending refused as erased, never tried for ever; a second delete
  // completes.
  it("stays and answers when a step after the Brain's erasure fails, keeps none of its later questions, and goes when deleted again", async () => {
    const marker = word();
    const { person, stub, chatId, ask } = await chatter(
      says("Kept."),
      says("Still here.")
    );
    await ask(`Keep ${marker}?`);
    await handedTo(person.userId, marker);
    const putBack = await knowledgeOutOfReach(stub);

    const refused = await outcome(person.api.chats.remove(chatId));
    await putBack();
    const again = await outcome(ask(`Again ${marker}?`));
    await vi.waitFor(
      async () => {
        await handOverNow();
        await expect(notedEvents(person.userId, chatId)).resolves.toHaveLength(
          2
        );
      },
      { timeout: 15_000, interval: 200 }
    );
    await handOverNow();
    const [, laterNote] = await notedEvents(person.userId, chatId);
    const ended = await endingsFor(laterNote?.target?.id ?? "");
    await person.api.chats.remove(chatId);
    const left = await person.api.chats.list();

    expect({
      refused: refused === "ok" ? "deleted" : "refused",
      again,
      ended,
      found: await recalled(person.userId, marker),
      listed: left.map(({ id }) => id),
    }).toStrictEqual({
      refused: "refused",
      again: "ok",
      ended: ["brain.source.handover_refused:erased"],
      found: [],
      listed: [],
    });
  });

  it("notes every question of a chat whose outbox the log couldn't take for a while, however many at once", async () => {
    const marker = word();
    const asked = 27;
    const { person, stub, chatId, ask } = await chatter(
      ...Array.from({ length: asked }, () => says("Noted."))
    );
    const putBack = await auditLogOutOfReach(stub);
    for (let turn = 1; turn < asked; turn += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one turn after the other
      await ask(`Turn ${turn} ${marker}?`);
    }
    const held = await outboxLeft(stub);
    await putBack();
    // The next turn's drain takes them all at once.
    await ask(`Turn ${asked} ${marker}?`);
    await vi.waitFor(
      async () => {
        await expect(outboxLeft(stub)).resolves.toBe(0);
      },
      { timeout: 15_000, interval: 200 }
    );
    const noted = await notedEvents(person.userId, chatId);
    const open = await openFor(person.userId);

    expect({
      heldAtLeast: held >= asked - 1,
      noted: noted.length,
      open: open.length,
    }).toStrictEqual({ heldAtLeast: true, noted: asked, open: asked });
  });

  it("ends a question's hand-over the queue parked as erased when its person is erased, so no noting keeps their id", async () => {
    const marker = word();
    const { person, chatId, ask } = await chatter(says("Parked."));
    const admin = await signedInApi(idp, "admin");
    await ask(`Park ${marker}?`);
    await vi.waitFor(
      async () => {
        await expect(notedEvents(person.userId, chatId)).resolves.toHaveLength(
          1
        );
      },
      { timeout: 15_000, interval: 200 }
    );
    // The Brain's queue fails it until it parks it (5 attempts, its
    // backoff waited out each time).
    const failing: Producers = {
      attempt: async () => {
        await Promise.resolve();
        throw new Error("Core is out of reach");
      },
    };
    await handOverNow(failing);
    for (let attempt = 1; attempt < 5; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one tick after the other
      await workBrain(env, later(10 * 60_000), failing);
    }
    const [noted] = await notedEvents(person.userId, chatId);
    const key = `chat:${noted?.target?.id ?? ""}`;
    const { parked } = await brainOf(
      inJurisdiction(env, env.BRAIN_STORE)
    ).workOverview();
    const wasParked = parked.some(
      (item) => item.kind === "source.handover" && item.key === key
    );
    const openBefore = await openFor(person.userId);

    await admin.api.members.remove(person.userId);
    const erased = await admin.api.members.erase(
      person.userId,
      String(person.person.name)
    );
    await handOverNow();

    expect({
      wasParked,
      openBefore: openBefore.length,
      completed: typeof erased.completedAt,
      open: await openFor(person.userId),
      ended: await endingsFor(noted?.target?.id ?? ""),
    }).toStrictEqual({
      wasParked: true,
      openBefore: 1,
      completed: "string",
      open: [],
      ended: ["brain.source.handover_refused:erased"],
    });
  });

  it("ends every hand-over still open of a person with hundreds of them in one erasure step, each in exactly one outcome", async () => {
    const { person, chatId } = await chatter();
    const admin = await signedInApi(idp, "admin");
    const ids = await notedFor(person.userId, chatId, 300);
    const openBefore = await openFor(person.userId);

    await admin.api.members.remove(person.userId);
    const erased = await admin.api.members.erase(
      person.userId,
      String(person.person.name)
    );

    expect({
      openBefore: openBefore.length,
      completed: typeof erased.completedAt,
      open: await openFor(person.userId),
      endings: await endingsOfAll(ids),
    }).toStrictEqual({
      openBefore: ids.length,
      completed: "string",
      open: [],
      endings: [JSON.stringify(["brain.source.handover_refused:erased"])],
    });
  });

  it("ends each of a person's hand-overs once when ending them failed part-way and is tried again", async () => {
    const { person, chatId } = await chatter();
    const admin = await signedInApi(idp, "admin");
    const ids = await notedFor(person.userId, chatId, 300);
    // The first 100 ended (their outcome and end, pair by pair), then the
    // database fails the rest.
    await expect(
      endHandOversOf({ ...env, DB: failsAfter(env.DB, 2 * 100) }, person.userId)
    ).rejects.toThrow("D1 failed part-way");
    const left = await openFor(person.userId);

    // The erasure's own step, tried again, ends what is left.
    await admin.api.members.remove(person.userId);
    const erased = await admin.api.members.erase(
      person.userId,
      String(person.person.name)
    );

    expect({
      left: left.length,
      completed: typeof erased.completedAt,
      open: await openFor(person.userId),
      endings: await endingsOfAll(ids),
    }).toStrictEqual({
      left: 200,
      completed: "string",
      open: [],
      endings: [JSON.stringify(["brain.source.handover_refused:erased"])],
    });
  });
});

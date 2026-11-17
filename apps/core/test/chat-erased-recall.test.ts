import { brainOf, personalBrainOf } from "@grasp-os/brain-next/contract";
import type { ChatMessage } from "@grasp-os/shared/chat";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import { withheldResult } from "../src/agent.ts";
import { organizationId } from "../src/auth/auth.ts";
import {
  addSource,
  eraseSource,
  forgetAs,
  rememberAs,
  workBrain,
} from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { inJurisdiction, workspace } from "../src/durable-objects.ts";
import { codeStep, personalChatsOf, says, setObjectEnv } from "./agent-chat.ts";
import type { WorkspaceStub } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { finishedByTheClock } from "./brain-next-own-store.ts";
import {
  copyOfStore,
  killStore,
  restoreStore,
} from "./brain-next-store-copy.ts";
import { mockIdp } from "./idp.ts";
import { answeringProvider, fakeProvider } from "./model-provider.ts";
import type { FakeProvider, ProviderReply } from "./model-provider.ts";
import { noProducers } from "./no-producers.ts";
import { signedInApi, unique } from "./sign-in.ts";

// What a chat keeps showing of what it read from the Brain (GRA-1807),
// through a person's own chats as they ask and open them: the Workspace,
// its ChatSession, the gateway, connect and the Brain are real; the model
// provider is the fake behind connect. Once the content a recall or a
// code step handed over is erased for good, the chat's own copy of it
// goes too, replaced by the line the model gets, checked when the chat is
// opened; what is only no longer readable (a narrowed source, a forgotten
// memory) keeps showing, as the person saw it while they could, and never
// reaches the model again. From the ways it can fail: the chat shows the
// erased text, keeps it in its object for a later read, or sends it to the
// model; a narrowed source or a forgotten memory vanishes from the chat as
// if erased; a Brain that can't be asked lets the text show unchecked.

const idp = mockIdp();

/** Signing people in and whole turns take a while on CI. */
const slow = { timeout: 120_000 };

/** A word no other test's sources hold: letters only. */
const word = () =>
  `zq${crypto
    .randomUUID()
    .replaceAll(/[^a-f]/gu, "")
    .slice(0, 12)}`;

const owner = (personId: string): SourceReaders => ({
  kind: "owner",
  personId,
});

/** Adds `text` to the Brain as a new upload `readers` may read. */
const added = async (
  text: string,
  readers: SourceReaders
): Promise<SourceRef> => {
  const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
  await addSource(env, {
    source,
    change: crypto.randomUUID(),
    text,
    readers,
  });
  return source;
};

/** A new team with `people` in it. */
const teamOf = async (...people: string[]): Promise<string> => {
  const teamId = crypto.randomUUID();
  const db = drizzle(env.DB);
  await db.insert(teams).values({
    id: teamId,
    name: `Team ${unique()}`,
    organizationId,
    createdAt: new Date(),
  });
  await db.insert(teamMembers).values(
    people.map((userId) => ({
      id: crypto.randomUUID(),
      teamId,
      userId,
      createdAt: new Date(),
    }))
  );
  return teamId;
};

/**
 * A new member's own chats in Grasp's app, answered by `replies`, whose
 * agent holds the `brain` grant; `chat` is a new one of them.
 */
const recallingChats = async (...replies: ProviderReply[]) => {
  const admin = await signedInApi(idp, "admin");
  const person = await signedInApi(idp, "user");
  const chats = await personalChatsOf(person.userId, ...replies);
  await requestGranted(idp, admin, {
    subject: chats.agent,
    object: { type: "platform" },
    actions: ["brain"],
    binding: "BRAIN",
  });
  const { chat, ask } = await chats.newChat();
  /** Whether the next turn's requests to the model carry `text`. */
  const sendsNext = async (text: string): Promise<boolean> => {
    const before = chats.provider.requests.length;
    await ask("Thanks, and what else is new?");
    return JSON.stringify(
      chats.provider.requests.slice(before).map(({ body }) => body)
    ).includes(text);
  };
  return { ...chats, person, chat, ask, sendsNext };
};

/**
 * The chat's messages as its person's page gets them when they open it:
 * the first update of a new watch.
 */
const opened = async (
  person: Awaited<ReturnType<typeof signedInApi>>,
  chatId: string
): Promise<ChatMessage[]> => {
  const messages: ChatMessage[] = [];
  const subscription = await person.api.chats.watch(chatId, null, (update) => {
    messages.push(...update.messages);
  });
  try {
    return await vi.waitFor(
      () => {
        expect(messages.at(-1)?.role).toBe("assistant");
        return messages;
      },
      { timeout: 10_000 }
    );
  } finally {
    subscription[Symbol.dispose]();
  }
};

/** What each step's result of `messages` says, in order. */
const resultsOf = (messages: readonly ChatMessage[]): string[] =>
  messages.flatMap((message) =>
    message.role === "result" ? [message.text] : []
  );

/**
 * Whether anything the Workspace object keeps (every table it has, and
 * its key-value storage) holds `text`: the chat's own copy, its search
 * text, its records of what it read, anything.
 */
const objectHolds = async (
  stub: WorkspaceStub,
  text: string
): Promise<boolean> =>
  await runInDurableObject(stub, (_instance, state) => {
    const { sql } = state.storage;
    const tables = sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
      )
      .toArray()
      .filter(({ name }) => !name.startsWith("_cf_"));
    const rows = tables.map(({ name }) =>
      sql.exec(`SELECT * FROM "${name.replaceAll('"', '""')}"`).toArray()
    );
    return JSON.stringify([rows, [...state.storage.kv.list()]]).includes(text);
  });

/** An object's call refused: the Brain away. */
const refused = async (): Promise<never> => {
  await Promise.resolve();
  throw new Error("The Brain is away");
};

/**
 * `namespace` (the Brain's) with every object's `erasedOf` refused: the
 * Brain away as a chat is opened.
 */
const refusingErasedOf = (namespace: object): object =>
  new Proxy(namespace, {
    get: (target, name): unknown => {
      const value: unknown = Reflect.get(target, name);
      if (typeof value !== "function") {
        return value;
      }
      if (name === "jurisdiction") {
        return (...args: unknown[]): object =>
          // SAFETY: a namespace's `jurisdiction` answers a namespace.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          refusingErasedOf(Reflect.apply(value, target, args) as object);
      }
      if (name !== "getByName" && name !== "get") {
        return (...args: unknown[]): unknown =>
          Reflect.apply(value, target, args);
      }
      return (...args: unknown[]): object => {
        // SAFETY: a namespace's `getByName` and `get` answer an object's stub.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        const stub = Reflect.apply(value, target, args) as object;
        return new Proxy(stub, {
          get: (object, property): unknown => {
            const own: unknown = Reflect.get(object, property);
            if (property !== "erasedOf" || typeof own !== "function") {
              return own;
            }
            return refused;
          },
        });
      };
    },
  });

/**
 * A new member's Teams direct message whose first turn's code recalled a
 * marked company source: `ask` asks it again, `narrow` narrows the source
 * to a team they aren't in, `erase` erases it for good; `before` is
 * whether the Workspace object held the marker after the first turn.
 */
const teamsDirect = async () => {
  const admin = await signedInApi(idp, "admin");
  const person = await signedInApi(idp, "user");
  const agentId = crypto.randomUUID();
  await requestGranted(idp, admin, {
    subject: { type: "agent", agentId },
    object: { type: "platform" },
    actions: ["brain"],
    binding: "BRAIN",
  });
  const depot = word();
  const marker = word();
  const text = `${depot} ${marker}`;
  const source = await added(text, { kind: "everyone" });
  const asked = { question: depot, budget: { tokens: 800 } };
  await fakeProvider(
    codeStep(
      `export default async (self, env) => { const pack = await env.brain.recall(${JSON.stringify(asked)}); return pack.items.map(({ text }) => text).join(" | "); };`
    ),
    says("Noted."),
    says("Ok."),
    says("Ok.")
  );
  const stub = workspace(env, personalWorkspaceId(person.userId));
  const ask = async (question: string) =>
    await stub.askThrough(
      person.userId,
      agentId,
      "teams",
      question,
      undefined,
      { kind: "direct" }
    );
  await ask("Please look that up.");
  const narrow = async () => {
    await brainOf(inJurisdiction(env, env.BRAIN_STORE)).addSource({
      source: `upload:${source.id}`,
      change: crypto.randomUUID(),
      text,
      access: { kind: "audience", group: `team:${crypto.randomUUID()}` },
    });
  };
  const erase = async () => {
    await eraseSource(env, {
      source,
      readers: { kind: "everyone" },
      reason: "deleted",
    });
  };
  return {
    stub,
    marker,
    ask,
    narrow,
    erase,
    before: await objectHolds(stub, marker),
  };
};

/** A row of a table. */
type Row = Record<string, SqlStorageValue>;

/** Tables another table of the store makes itself (the word indexes' pages). */
const madeByAnother = /^(?:sqlite_|(?:chunk|memory)_(?:words|stems)_)/u;

/** Kills `stub`'s object, as a crash or a restore restarts it. */
const kill = async (stub: DurableObjectStub): Promise<void> => {
  try {
    await runInDurableObject(stub, (_instance, state) => {
      state.abort("Killed by the test");
    });
  } catch {
    // The kill ends the call it was made in.
  }
};

/**
 * `personId`'s own store's storage lost, its bucket and ledger kept, as
 * a lost Durable Object storage leaves it; `putBack` restores the copy
 * taken before, as a restore from a backup does.
 */
const ownStorageLost = async (personId: string) => {
  // A fresh stub for each call: one an object was killed through is broken.
  const stub = () =>
    inJurisdiction(env, env.BRAIN_STORE).getByName(`person:${personId}`);
  const copy = await runInDurableObject(stub(), async (_instance, state) => {
    const { sql } = state.storage;
    const tables = sql
      .exec<{ name: string; sql: string }>(
        `SELECT name, sql FROM sqlite_master WHERE type = 'table'
        AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'`
      )
      .toArray()
      .filter(({ name }) => !madeByAnother.test(name))
      .map(({ name, sql: created }) => ({
        name,
        created,
        rows: sql
          .exec<Row>(
            created.startsWith("CREATE VIRTUAL TABLE")
              ? `SELECT rowid AS rowid, * FROM "${name}"`
              : `SELECT * FROM "${name}"`
          )
          .toArray(),
      }));
    const others = sql
      .exec<{ sql: string | null }>(
        "SELECT sql FROM sqlite_master WHERE type IN ('index', 'trigger') ORDER BY type"
      )
      .toArray()
      .flatMap(({ sql: created }) => (created === null ? [] : [created]));
    await state.storage.deleteAll();
    return { tables, others };
  });
  await kill(stub());
  const putBack = async (): Promise<void> => {
    await runInDurableObject(stub(), async (_instance, state) => {
      await state.storage.deleteAll();
      const { sql } = state.storage;
      state.storage.transactionSync(() => {
        sql.exec("PRAGMA defer_foreign_keys = ON");
        for (const { created } of copy.tables) {
          sql.exec(created);
        }
        for (const { name, rows } of copy.tables) {
          for (const row of rows) {
            const columns = Object.keys(row);
            sql.exec(
              `INSERT INTO "${name}" (${columns.map((column) => `"${column}"`).join(", ")})
              VALUES (${columns.map(() => "?").join(", ")})`,
              ...Object.values(row)
            );
          }
        }
        for (const created of copy.others) {
          sql.exec(created);
        }
      });
    });
    await kill(stub());
  };
  return { putBack };
};

/** A memory's basis on the first version of upload `source`, quoting `quote`. */
const on = (source: SourceRef, quote: string) =>
  ({
    kind: "source",
    source: `upload:${source.id}`,
    version: 1,
    quote,
  }) as const;

/** In the word of the member `person`. */
const saidBy = (person: string) => ({ kind: "internal", person }) as const;

/** Code that returns the card `env.brain.getEntity` answers for `entity`. */
const cardCode = (entity: string) =>
  codeStep(
    `export default async (self, env) => await env.brain.getEntity({ entity: ${JSON.stringify(entity)} });`
  );

/** Code that returns each entity `env.brain.findEntities` finds by `address`: its id and name. */
const findCode = (address: string) =>
  codeStep(
    `export default async (self, env) => { const { entities } = await env.brain.findEntities({ identifier: { type: "email", value: ${JSON.stringify(address)} } }); return entities.map(({ id, name }) => id + " " + name); };`
  );

/** Code that returns each entity of kind `kind` `env.brain.findEntities` finds: its id and name. */
const kindCode = (kind: string) =>
  codeStep(
    `export default async (self, env) => { const { entities } = await env.brain.findEntities({ kind: ${JSON.stringify(kind)} }); return entities.map(({ id, name }) => id + " " + name); };`
  );

/** Code that pages through every entity named `name`, at most five pages: each one's id and name. */
const pagingCode = (name: string) =>
  codeStep(
    `export default async (self, env) => { const found = []; let after; for (let page = 0; page < 5; page += 1) { const { entities, next } = await env.brain.findEntities({ name: ${JSON.stringify(name)}, ...(after === undefined ? {} : { after }) }); found.push(...entities.map(({ id, name }) => id + " " + name)); if (next === null) { break; } after = next; } return found; };`
  );

/**
 * A new team of Ben's and Anna's, and Anna as a member Ben may read a
 * card of: her name and address, signed in.
 */
const benAndAnna = async (ben: string) => {
  const anna = await signedInApi(idp, "user");
  const teamId = await teamOf(ben, anna.userId);
  return {
    anna,
    teamId,
    team: { kind: "team", teamId } as const,
    group: `team:${teamId}`,
    name: String(anna.person.name),
    address: String(anna.person.email).toLowerCase(),
  };
};

/** The shared store of the Brain. */
const sharedStore = () =>
  inJurisdiction(env, env.BRAIN_STORE).getByName("brain");

/** How many memories people's erasures still hide in the shared store. */
const hiddenByErasures = async (): Promise<number> =>
  await runInDurableObject(
    sharedStore(),
    (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>(
          "SELECT count(*) AS count FROM person_erasure_memories"
        )
        .one().count
  );

/**
 * A restore of an export under way in the shared store, as its own run
 * records one, while `running`.
 */
const restoringShared = async (id: string, running: boolean) => {
  await runInDurableObject(sharedStore(), (_instance, state) => {
    state.storage.sql.exec(
      running
        ? `INSERT INTO restores (export, checked, part, restored, state, started_at)
          VALUES (?, 0, 0, 0, 'running', ?)`
        : "DELETE FROM restores WHERE export = ?",
      ...(running ? [id, Date.now()] : [id])
    );
  });
};

/** Erases the member `anna` as an admin does, the clock finishing it, and the tick deleting what it hid. */
const erasedByAdmin = async (
  admin: Awaited<ReturnType<typeof signedInApi>>,
  anna: Awaited<ReturnType<typeof signedInApi>>
): Promise<number> => {
  await admin.api.members.remove(anna.userId);
  await admin.api.members.erase(anna.userId, String(anna.person.name));
  await finishedByTheClock(anna.userId);
  for (let ticks = 0; ticks < 10; ticks += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    if ((await hiddenByErasures()) === 0) {
      break;
    }
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    await workBrain(env, new Date(), noProducers);
  }
  return await hiddenByErasures();
};

/** The memories `stub`'s person used, by id (`memory_uses`): what was handed to them. */
const usedIn = async (stub: WorkspaceStub): Promise<string[]> =>
  await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ memory: string }>("SELECT memory FROM memory_uses")
      .toArray()
      .map(({ memory }) => memory)
  );

/** A result as the chat shows it, without what tells one call or moment from another. */
const shapeOf = (message: ChatMessage | undefined) =>
  message?.role === "result"
    ? { ...message, id: 0, callId: "", at: "" }
    : message;

/** Whether the provider's requests so far carried `text`. */
const sentSoFar = (provider: FakeProvider, text: string): boolean =>
  JSON.stringify(provider.requests.map(({ body }) => body)).includes(text);

describe("what a chat shows of what it read from the Brain", () => {
  it(
    "replaces a recall's passage once its source is erased, as the chat is opened, keeps nothing of it in the chat's object and never sends it again",
    slow,
    async () => {
      const depot = word();
      const marker = word();
      const chats = await recallingChats(says("Noted."), says("Ok."));
      const source = await added(
        `Depot ${depot} keeps code ${marker} at the gate`,
        owner(chats.person.userId)
      );
      await chats.ask(`Where does depot ${depot} keep its code?`);
      const before = {
        sent: sentSoFar(chats.provider, marker),
        shown: resultsOf(await opened(chats.person, chats.chat.id)).some(
          (text) => text.includes(marker)
        ),
      };
      // An admin's hard delete of the upload: erased for good.
      await eraseSource(env, {
        source,
        readers: owner(chats.person.userId),
        reason: "deleted",
      });
      const shown = await opened(chats.person, chats.chat.id);
      const held = await objectHolds(chats.stub, marker);
      const sentAgain = await chats.sendsNext(marker);

      expect({
        before,
        results: resultsOf(shown),
        shown: JSON.stringify(shown).includes(marker),
        held,
        sentAgain,
      }).toStrictEqual({
        before: { sent: true, shown: true },
        results: [withheldResult],
        shown: false,
        held: false,
        sentAgain: false,
      });
    }
  );

  it(
    "replaces a code step's output once a source its code recalled is erased, as the chat is opened, and never sends it again",
    slow,
    async () => {
      const depot = word();
      const marker = word();
      const asked = { question: depot, budget: { tokens: 800 } };
      const chats = await recallingChats(
        codeStep(
          `export default async (self, env) => { const pack = await env.brain.recall(${JSON.stringify(asked)}); return pack.items.map(({ text }) => text).join(" | "); };`
        ),
        says("Noted."),
        says("Ok.")
      );
      const source = await added(`${depot} ${marker}`, { kind: "everyone" });
      // A question the recall before it finds nothing for: the code reads.
      await chats.ask("Please look that up.");
      const before = resultsOf(await opened(chats.person, chats.chat.id)).some(
        (text) => text.includes(marker)
      );
      await eraseSource(env, {
        source,
        readers: { kind: "everyone" },
        reason: "deleted",
      });
      const shown = await opened(chats.person, chats.chat.id);

      expect({
        before,
        // The recall before the question found nothing: the code's is last.
        codeResult: resultsOf(shown).at(-1),
        shown: JSON.stringify(shown).includes(marker),
        held: await objectHolds(chats.stub, marker),
        sentAgain: await chats.sendsNext(marker),
      }).toStrictEqual({
        before: true,
        codeResult: withheldResult,
        shown: false,
        held: false,
        sentAgain: false,
      });
    }
  );

  it(
    "replaces what a Teams direct message's code read of an erased source at its next turn, never opened in Grasp, also once it was withheld for being narrowed before, or the Brain couldn't be asked the turn before",
    slow,
    async () => {
      const erased = await teamsDirect();
      await erased.erase();
      await erased.ask("Thanks, and what else is new?");
      const erasedAfter = await objectHolds(erased.stub, erased.marker);

      // Withheld for being narrowed first, which keeps it; erased after.
      const narrowed = await teamsDirect();
      await narrowed.narrow();
      await narrowed.ask("Thanks, and what else is new?");
      const narrowedAfter = await objectHolds(narrowed.stub, narrowed.marker);
      await narrowed.erase();
      await narrowed.ask("And anything else?");
      const narrowedErasedAfter = await objectHolds(
        narrowed.stub,
        narrowed.marker
      );

      // The Brain can't be asked what was erased at the first turn after.
      const away = await teamsDirect();
      await away.erase();
      const restore = await setObjectEnv(away.stub, {
        BRAIN_STORE: refusingErasedOf(env.BRAIN_STORE),
      });
      try {
        await away.ask("Thanks, and what else is new?");
      } finally {
        await restore();
      }
      const awayAfter = await objectHolds(away.stub, away.marker);
      await away.ask("And anything else?");
      const backAfter = await objectHolds(away.stub, away.marker);

      expect({
        before: [erased.before, narrowed.before, away.before],
        erasedAfter,
        narrowedAfter,
        narrowedErasedAfter,
        awayAfter,
        backAfter,
      }).toStrictEqual({
        before: [true, true, true],
        erasedAfter: false,
        narrowedAfter: true,
        narrowedErasedAfter: false,
        awayAfter: true,
        backAfter: false,
      });
    }
  );

  it(
    "keeps showing what a source narrowed since handed over, as the person saw it, and never sends it again",
    slow,
    async () => {
      const depot = word();
      const marker = word();
      const chats = await recallingChats(says("Noted."), says("Ok."));
      const teamId = await teamOf(chats.person.userId);
      const text = `Depot ${depot} keeps code ${marker} at the gate`;
      const source = await added(text, { kind: "team", teamId });
      await chats.ask(`Where does depot ${depot} keep its code?`);
      // Narrowed to a team the person isn't in.
      await brainOf(inJurisdiction(env, env.BRAIN_STORE)).addSource({
        source: `upload:${source.id}`,
        change: crypto.randomUUID(),
        text,
        access: { kind: "audience", group: `team:${crypto.randomUUID()}` },
      });
      const shown = await opened(chats.person, chats.chat.id);

      expect({
        shown: resultsOf(shown).some((each) => each.includes(marker)),
        held: await objectHolds(chats.stub, marker),
        sentAgain: await chats.sendsNext(marker),
      }).toStrictEqual({ shown: true, held: true, sentAgain: false });
    }
  );

  it(
    "keeps showing a memory the person forgot, and replaces one an erasure of the source it rests on deleted",
    slow,
    async () => {
      const chats = await recallingChats(
        says("Noted."),
        says("Ok."),
        says("Noted."),
        says("Ok.")
      );
      const personId = chats.person.userId;
      // A memory of theirs, which they then forget.
      const forgottenDepot = word();
      const forgotten = `Depot ${forgottenDepot} is ${word()}`;
      const kept = await rememberAs(env, personId, {
        change: crypto.randomUUID(),
        about: { kind: "customer", names: [`Depot ${forgottenDepot}`] },
        attribute: "status",
        value: "open",
        type: "fact",
        statement: forgotten,
        quote: forgotten,
      });
      await chats.ask(`What is the status of depot ${forgottenDepot}?`);
      await forgetAs(env, personId, kept.memory);
      const forgottenShown = resultsOf(
        await opened(chats.person, chats.chat.id)
      ).some((text) => text.includes(forgotten));
      const forgottenSent = await chats.sendsNext(forgotten);

      // A memory drawn from a source of theirs, which they then erase.
      const drawnDepot = word();
      const drawn = `Depot ${drawnDepot} keeps its keys at the gate`;
      const own = await added(drawn, owner(personId));
      await personalBrainOf(
        inJurisdiction(env, env.BRAIN_STORE),
        personId
      ).addMemories({
        change: crypto.randomUUID(),
        access: { kind: "owner", person: personId },
        entities: [
          { key: "c", kind: "customer", names: [`Depot ${drawnDepot}`] },
        ],
        memories: [
          {
            about: "c",
            type: "fact",
            statement: drawn,
            speaker: { kind: "system" },
            basis: {
              kind: "source",
              source: `upload:${own.id}`,
              version: 1,
              quote: drawn,
            },
          },
        ],
      });
      const second = await chats.newChat();
      await second.ask(`Where does depot ${drawnDepot} keep its keys?`);
      const drawnBefore = resultsOf(
        await opened(chats.person, second.chat.id)
      ).some((text) => text.includes(drawn));
      await eraseSource(env, {
        source: own,
        readers: owner(personId),
        reason: "deleted",
      });
      const drawnShown = await opened(chats.person, second.chat.id);

      expect({
        forgotten: { shown: forgottenShown, sent: forgottenSent },
        drawn: {
          before: drawnBefore,
          results: resultsOf(drawnShown),
          held: await objectHolds(chats.stub, drawn),
        },
      }).toStrictEqual({
        forgotten: { shown: true, sent: false },
        drawn: { before: true, results: [withheldResult], held: false },
      });
    }
  );

  it(
    "rewrites nothing while the person's own store has lost its storage, as a turn and an open find what it recalled missing, and still shows it once the store is restored",
    slow,
    async () => {
      const chats = await recallingChats(says("Noted."), says("Ok."));
      const personId = chats.person.userId;
      const depot = word();
      const statement = `Depot ${depot} is ${word()}`;
      await rememberAs(env, personId, {
        change: crypto.randomUUID(),
        about: { kind: "customer", names: [`Depot ${depot}`] },
        attribute: "status",
        value: "open",
        type: "fact",
        statement,
        quote: statement,
      });
      await chats.ask(`What is the status of depot ${depot}?`);
      const shownBefore = resultsOf(
        await opened(chats.person, chats.chat.id)
      ).some((text) => text.includes(statement));
      const lost = await ownStorageLost(personId);
      // A turn finds it unreadable and withholds it; nothing was erased.
      const sentWhileLost = await chats.sendsNext(statement);
      const whileLost = {
        shown: resultsOf(await opened(chats.person, chats.chat.id)).some(
          (text) => text.includes(statement)
        ),
        held: await objectHolds(chats.stub, statement),
      };
      await lost.putBack();
      const restored = {
        shown: resultsOf(await opened(chats.person, chats.chat.id)).some(
          (text) => text.includes(statement)
        ),
        held: await objectHolds(chats.stub, statement),
      };

      expect({
        shownBefore,
        sentWhileLost,
        whileLost,
        restored,
      }).toStrictEqual({
        shownBefore: true,
        sentWhileLost: false,
        whileLost: { shown: true, held: true },
        restored: { shown: true, held: true },
      });
    }
  );

  it(
    "shows a recall withheld when the Brain can't be asked as the chat opens, rewriting nothing, and replaces it at the next open",
    slow,
    async () => {
      const depot = word();
      const marker = word();
      const chats = await recallingChats(says("Noted."));
      const source = await added(
        `Depot ${depot} keeps code ${marker} at the gate`,
        owner(chats.person.userId)
      );
      await chats.ask(`Where does depot ${depot} keep its code?`);
      await eraseSource(env, {
        source,
        readers: owner(chats.person.userId),
        reason: "deleted",
      });
      const restore = await setObjectEnv(chats.stub, {
        BRAIN_STORE: refusingErasedOf(env.BRAIN_STORE),
      });
      let away: { results: string[]; held: boolean };
      try {
        away = {
          results: resultsOf(await opened(chats.person, chats.chat.id)),
          held: await objectHolds(chats.stub, marker),
        };
      } finally {
        await restore();
      }
      const back = {
        results: resultsOf(await opened(chats.person, chats.chat.id)),
        held: await objectHolds(chats.stub, marker),
      };

      expect({ away, back }).toStrictEqual({
        away: { results: [withheldResult], held: true },
        back: { results: [withheldResult], held: false },
      });
    }
  );

  // GRA-1981: a colleague's chat that cited what a person's erasure took
  // (#2339: in her word, or about her card) replaces it, as for any other
  // erasure for good, decided by the ledger alone: also once the tick
  // deleted what it hid, an older copy of the shared store came back or
  // its storage was lost; shown withheld, rewriting nothing, while the
  // shared store restores an export. Her own chats went with her
  // workspace, erased whole: nothing of hers is left to open.
  it(
    "replaces what a colleague's chat recalled in an erased member's word or about her card, after the tick, an older copy or a lost storage, shows it withheld while the Brain restores, and keeps her document in his word and what she wrote in his",
    slow,
    async () => {
      const replies = Array.from({ length: 16 }, () => says("Noted."));
      const chats = await recallingChats(...replies);
      const admin = await signedInApi(idp, "admin");
      const anna = await signedInApi(idp, "user");
      const ben = chats.person.userId;
      const name = String(anna.person.name);
      const address = String(anna.person.email).toLowerCase();
      const teamId = await teamOf(ben, anna.userId);
      const team = { kind: "team", teamId } as const;
      const annasNote = await added("Depot ships in May.", team);
      const bensNote = await added(`${name} leads the depot.`, team);
      const goneNote = await added("Depot is closed on Fridays.", team);
      // What each memory says that a question never does (`mark`), and what
      // a question finds it by (`topic`).
      const mark = {
        word: word(),
        card: word(),
        relation: word(),
        kept: word(),
        written: word(),
        twin: word(),
        teams: word(),
      };
      const topic = {
        word: word(),
        card: word(),
        relation: word(),
        kept: word(),
        written: word(),
        twin: word(),
        teams: word(),
      };
      await brainOf(inJurisdiction(env, env.BRAIN_STORE)).addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group: `team:${teamId}` },
        entities: [
          {
            key: "anna",
            kind: "person",
            names: [name],
            identifiers: [{ type: "email", value: address }],
          },
          { key: "depot", kind: "project", names: [`Depot ${word()}`] },
          { key: "desk", kind: "team", names: [`Desk ${word()}`] },
        ],
        memories: [
          // In her word, from the note she wrote for the team.
          {
            about: "depot",
            type: "fact",
            statement: `Depot ${topic.word} ${mark.word} ships in May`,
            speaker: saidBy(anna.userId),
            basis: on(annasNote, "Depot ships in May"),
          },
          // About her card, in Ben's word.
          {
            about: "anna",
            type: "fact",
            statement: `${name} leads depot ${topic.card} ${mark.card}`,
            speaker: saidBy(ben),
            basis: on(bensNote, "leads the depot"),
          },
          // Relating to her card, about a team she leads, in Ben's word.
          {
            about: "desk",
            attribute: "lead",
            object: "anna",
            type: "fact",
            statement: `Desk ${topic.relation} ${mark.relation} is led by her`,
            speaker: saidBy(ben),
            basis: on(bensNote, "leads the depot"),
          },
          // Her note, in Ben's word: her document, not her word.
          {
            about: "depot",
            type: "fact",
            statement: `Depot ${topic.kept} ${mark.kept} needs a review`,
            speaker: saidBy(ben),
            basis: on(annasNote, "Depot ships in May"),
          },
          // Written by her, in Ben's word.
          {
            about: "depot",
            type: "fact",
            statement: `Depot ${topic.written} ${mark.written} opens at eight`,
            speaker: saidBy(ben),
            basis: { kind: "writer", writer: anna.userId },
          },
          // Resting on a note its source's erasure takes: the twin.
          {
            about: "depot",
            type: "fact",
            statement: `Depot ${topic.twin} ${mark.twin} is closed on Fridays`,
            speaker: saidBy(ben),
            basis: on(goneNote, "Depot is closed on Fridays"),
          },
          // In her word, recalled in Ben's Teams direct message.
          {
            about: "depot",
            type: "fact",
            statement: `Depot ${topic.teams} ${mark.teams} ships by boat`,
            speaker: saidBy(anna.userId),
            basis: on(annasNote, "Depot ships in May"),
          },
        ],
      });
      /** A new chat of Ben's that recalled the memory `of`, and whether it showed it. */
      const recalled = async (of: keyof typeof mark) => {
        const { chat, ask } = await chats.newChat();
        await ask(`What do we know about ${topic[of]}?`);
        const shown = resultsOf(await opened(chats.person, chat.id)).some(
          (text) => text.includes(mark[of])
        );
        return { chat, ask, shown };
      };
      const inHerWord = await recalled("word");
      const card = await recalled("card");
      const cardLost = await recalled("card");
      const relation = await recalled("relation");
      const restoring = await recalled("word");
      const kept = await recalled("kept");
      const written = await recalled("written");
      const twin = await recalled("twin");
      const teamsAsk = async (question: string) =>
        await chats.stub.askThrough(
          ben,
          chats.agent.agentId,
          "teams",
          question,
          undefined,
          { kind: "direct" }
        );
      await teamsAsk(`What do we know about ${topic.teams}?`);
      const teamsBefore = await objectHolds(chats.stub, mark.teams);
      const before = await copyOfStore();

      await admin.api.members.remove(anna.userId);
      await admin.api.members.erase(anna.userId, name);
      await finishedByTheClock(anna.userId);
      await eraseSource(env, {
        source: goneNote,
        readers: team,
        reason: "deleted",
      });
      // The tick deletes what her erasure hid: the answer outlives the rows.
      for (let ticks = 0; ticks < 10; ticks += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        if ((await hiddenByErasures()) === 0) {
          break;
        }
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        await workBrain(env, new Date(), noProducers);
      }
      const left = await hiddenByErasures();
      const openedAfter = async (chatId: string) =>
        resultsOf(await opened(chats.person, chatId));
      const afterTick = {
        word: await openedAfter(inHerWord.chat.id),
        relation: await openedAfter(relation.chat.id),
        kept: await openedAfter(kept.chat.id),
        written: await openedAfter(written.chat.id),
      };
      const twinShown = await opened(chats.person, twin.chat.id);
      const wordShown = await opened(chats.person, inHerWord.chat.id);
      // While the shared store restores an export: withheld, nothing rewritten.
      const restoreId = crypto.randomUUID();
      await restoringShared(restoreId, true);
      let whileRestoring: { results: string[]; held: boolean };
      try {
        whileRestoring = {
          results: await openedAfter(restoring.chat.id),
          held: await objectHolds(chats.stub, mark.word),
        };
      } finally {
        await restoringShared(restoreId, false);
      }
      const restored = await openedAfter(restoring.chat.id);
      // An older copy of the shared store, from before her erasure, comes
      // back: the ledger is replayed.
      const after = await copyOfStore();
      await restoreStore(before);
      const olderCopy = await openedAfter(card.chat.id);
      // Its storage lost, the ledger kept: replayed whole as it starts.
      await runInDurableObject(sharedStore(), async (_instance, state) => {
        await state.storage.deleteAll();
      });
      await killStore();
      const lost = await openedAfter(cardLost.chat.id);
      await restoreStore(after);
      // Ben's direct message on Teams, never opened in Grasp: at its next turn.
      await teamsAsk("Thanks, and what else is new?");
      /** Whether the next turn of the chat in her word sends it to the model. */
      const sentNext = async (): Promise<boolean> => {
        const sentBefore = chats.provider.requests.length;
        await inHerWord.ask("Thanks, and what else is new?");
        return JSON.stringify(
          chats.provider.requests.slice(sentBefore).map(({ body }) => body)
        ).includes(mark.word);
      };

      expect({
        before: [
          inHerWord,
          card,
          cardLost,
          relation,
          restoring,
          kept,
          written,
          twin,
        ].map(({ shown }) => shown),
        teamsBefore,
        left,
        afterTick,
        twin: twinShown.filter(({ role }) => role === "result").map(shapeOf),
        whileRestoring,
        restored,
        olderCopy,
        lost,
        held: await Promise.all(
          [mark.word, mark.card, mark.relation, mark.teams].map(
            async (marker) => await objectHolds(chats.stub, marker)
          )
        ),
        sentAgain: await sentNext(),
      }).toStrictEqual({
        before: [true, true, true, true, true, true, true, true],
        teamsBefore: true,
        left: 0,
        afterTick: {
          word: [withheldResult],
          relation: [withheldResult],
          kept: [expect.stringContaining(mark.kept)],
          written: [expect.stringContaining(mark.written)],
        },
        // Exactly as a chat shows what any other erasure for good took.
        twin: wordShown.filter(({ role }) => role === "result").map(shapeOf),
        whileRestoring: { results: [withheldResult], held: true },
        restored: [withheldResult],
        olderCopy: [withheldResult],
        lost: [withheldResult],
        held: [false, false, false, false],
        sentAgain: false,
      });
    }
  );
});

// GRA-1982: what a chat's code read of the Brain's entities (`env.brain`
// `getEntity`, `findEntities`) shows of what a person's erasure took (her
// card, what is about it or relates to it) is withheld from the model and
// replaced on screen, as any erasure for good: by a pin of every memory
// the answer rests on (what it hands over, what gave a name or made an
// entity seen), with what each rests on, answered from the ledger alone. A team or desk that only held her
// address keeps showing (#2339). An App's action keeps nothing of what it
// read in Grasp; a workflow's run is GRA-1985.
describe("what a chat's code read of an erased member's card", () => {
  it(
    "is never sent again and shows the withheld line, after the tick, an older copy or a lost storage, withheld while the Brain restores, as an erased source's would; a desk that only held her address keeps showing",
    slow,
    async () => {
      const chats = await recallingChats();
      const admin = await signedInApi(idp, "admin");
      const ben = chats.person.userId;
      const at = await benAndAnna(ben);
      const bensNote = await added(`${at.name} leads the depot.`, at.team);
      const goneNote = await added("Gone is closed on Fridays.", at.team);
      const mark = {
        card: word(),
        relation: word(),
        kept: word(),
        twin: word(),
      };
      const store = brainOf(inJurisdiction(env, env.BRAIN_STORE));
      const { entities } = await store.addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group: at.group },
        entities: [
          {
            key: "anna",
            kind: "person",
            names: [at.name],
            identifiers: [{ type: "email", value: at.address }],
          },
          { key: "desk", kind: "team", names: [`Desk ${word()}`] },
          { key: "gone", kind: "project", names: [`Gone ${word()}`] },
        ],
        memories: [
          {
            about: "anna",
            type: "fact",
            statement: `${at.name} leads depot ${mark.card}`,
            speaker: saidBy(ben),
            basis: on(bensNote, "leads the depot"),
          },
          {
            about: "desk",
            attribute: "lead",
            object: "anna",
            type: "fact",
            statement: `Desk ${mark.relation} is led by her`,
            speaker: saidBy(ben),
            basis: on(bensNote, "leads the depot"),
          },
          {
            about: "gone",
            type: "fact",
            statement: `Gone ${mark.twin} is closed on Fridays`,
            speaker: saidBy(ben),
            basis: on(goneNote, "Gone is closed on Fridays"),
          },
        ],
      });
      // A desk of another team of Ben's that only held her address.
      const otherTeam = await teamOf(ben);
      const desk = await store.addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group: `team:${otherTeam}` },
        entities: [
          {
            key: "desk",
            kind: "team",
            names: [`Shared desk ${word()}`],
            identifiers: [{ type: "email", value: at.address }],
          },
        ],
        memories: [
          {
            about: "desk",
            type: "fact",
            statement: `Shared desk ${mark.kept} opens at eight`,
            speaker: saidBy(ben),
            basis: { kind: "writer", writer: ben },
          },
        ],
      });
      const card = entities.anna ?? "";
      const replies: ProviderReply[] = [];
      const provider = await answeringProvider(() => replies.shift());
      /** A new chat of Ben's whose code ran `code`, and what its code's result showed. */
      const ran = async (code: ProviderReply) => {
        replies.push(code, says("Noted."));
        const { chat, ask } = await chats.newChat();
        await ask(word());
        const shown = resultsOf(await opened(chats.person, chat.id)).at(-1);
        return { chat, ask, shown };
      };
      const cardRead = await ran(cardCode(card));
      const found = await ran(findCode(at.address));
      const relation = await ran(cardCode(entities.desk ?? ""));
      const kept = await ran(cardCode(desk.entities.desk ?? ""));
      const twin = await ran(cardCode(entities.gone ?? ""));
      const restoring = await ran(cardCode(card));
      const olderCopy = await ran(cardCode(card));
      const lost = await ran(findCode(at.address));
      const before = await copyOfStore();

      const left = await erasedByAdmin(admin, at.anna);
      await eraseSource(env, {
        source: goneNote,
        readers: at.team,
        reason: "deleted",
      });
      const codeResultOf = async (chatId: string) =>
        resultsOf(await opened(chats.person, chatId)).at(-1);
      const keptShown = await codeResultOf(kept.chat.id);
      const afterTick = {
        card: await codeResultOf(cardRead.chat.id),
        found: await codeResultOf(found.chat.id),
        relation: await codeResultOf(relation.chat.id),
        kept: keptShown?.includes(mark.kept),
      };
      const cardShown = await opened(chats.person, cardRead.chat.id);
      const twinShown = await opened(chats.person, twin.chat.id);
      const restoreId = crypto.randomUUID();
      await restoringShared(restoreId, true);
      let whileRestoring: { result: string | undefined; held: boolean };
      try {
        whileRestoring = {
          result: await codeResultOf(restoring.chat.id),
          held: await objectHolds(chats.stub, mark.card),
        };
      } finally {
        await restoringShared(restoreId, false);
      }
      const restored = await codeResultOf(restoring.chat.id);
      const after = await copyOfStore();
      await restoreStore(before);
      const olderCopyShown = await codeResultOf(olderCopy.chat.id);
      await runInDurableObject(sharedStore(), async (_instance, state) => {
        await state.storage.deleteAll();
      });
      await killStore();
      const lostShown = await codeResultOf(lost.chat.id);
      await restoreStore(after);
      // What the next turn of the chat that read her card sends the model.
      replies.push(says("Ok."));
      const sentBefore = provider.requests.length;
      await cardRead.ask("Thanks, and what else is new?");
      const sentAgain = JSON.stringify(
        provider.requests.slice(sentBefore).map(({ body }) => body)
      );

      expect({
        before: [
          cardRead,
          found,
          relation,
          kept,
          restoring,
          olderCopy,
          lost,
        ].map(({ shown }) =>
          [at.name, mark.kept].some(
            (needle) => shown?.includes(needle) === true
          )
        ),
        left,
        afterTick,
        twin: shapeOf(twinShown.findLast(({ role }) => role === "result")),
        whileRestoring,
        restored,
        olderCopy: olderCopyShown,
        lost: lostShown,
        held: await Promise.all(
          // Her name stays in Bob's note, a document: what the cards said goes.
          [mark.card, mark.relation].map(
            async (needle) => await objectHolds(chats.stub, needle)
          )
        ),
        sentAgain: [mark.card, mark.relation].map((needle) =>
          sentAgain.includes(needle)
        ),
      }).toStrictEqual({
        before: [true, true, true, true, true, true, true],
        left: 0,
        afterTick: {
          card: withheldResult,
          found: withheldResult,
          relation: withheldResult,
          kept: true,
        },
        // Exactly as a chat shows what any other erasure for good took.
        twin: shapeOf(cardShown.findLast(({ role }) => role === "result")),
        whileRestoring: { result: withheldResult, held: true },
        restored: withheldResult,
        olderCopy: withheldResult,
        lost: withheldResult,
        held: [false, false],
        sentAgain: [false, false],
      });
    }
  );

  it(
    "withholds and replaces a paged find whose second page alone showed her card",
    slow,
    async () => {
      const chats = await recallingChats();
      const admin = await signedInApi(idp, "admin");
      const ben = chats.person.userId;
      const at = await benAndAnna(ben);
      const store = brainOf(inJurisdiction(env, env.BRAIN_STORE));
      // A page of the Brain's (100) of customers named as she is, first.
      await store.addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group: at.group },
        entities: Array.from({ length: 100 }, (_, place) => ({
          key: `c${place}`,
          kind: "customer" as const,
          names: [at.name],
        })),
        memories: Array.from({ length: 100 }, (_, place) => ({
          about: `c${place}`,
          type: "fact" as const,
          statement: `${at.name} is a customer`,
          speaker: { kind: "system" as const },
          basis: { kind: "writer" as const, writer: ben },
        })),
      });
      const { entities } = await store.addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group: at.group },
        entities: [
          {
            key: "anna",
            kind: "person",
            names: [at.name],
            identifiers: [{ type: "email", value: at.address }],
          },
        ],
        memories: [
          {
            about: "anna",
            type: "fact",
            statement: `${at.name} works from Utrecht`,
            speaker: saidBy(ben),
            basis: { kind: "writer", writer: ben },
          },
        ],
      });
      const card = entities.anna ?? "";
      const replies: ProviderReply[] = [
        pagingCode(at.name),
        says("Noted."),
        says("Ok."),
      ];
      const provider = await answeringProvider(() => replies.shift());
      const { chat, ask } = await chats.newChat();
      await ask(word());
      const shown = resultsOf(await opened(chats.person, chat.id)).at(-1);

      await erasedByAdmin(admin, at.anna);
      const after = resultsOf(await opened(chats.person, chat.id)).at(-1);
      const sentBefore = provider.requests.length;
      await ask("Thanks, and what else is new?");
      // One event for the check that withheld it, by kind and count alone.
      const withheld = await vi.waitFor(
        async () => {
          const all = await allEvents();
          const events = all.filter(
            ({ action, target }) =>
              action === "chat.history_withheld" && target?.id === chat.id
          );
          expect(events.length).toBeGreaterThan(0);
          return events;
        },
        { timeout: 10_000, interval: 50 }
      );

      expect({
        found: (shown?.match(/[0-9a-f-]{36} /gu) ?? []).length,
        onTheSecondPage: shown?.includes(card),
        after,
        audited: withheld.map(({ detail }) => detail),
        held: await objectHolds(chats.stub, `${card} `),
        sentAgain: JSON.stringify(
          provider.requests.slice(sentBefore).map(({ body }) => body)
        ).includes(card),
      }).toStrictEqual({
        found: 101,
        onTheSecondPage: true,
        after: withheldResult,
        // The memory that named and showed her card, counted, never which.
        audited: [{ workspace: chats.id, runs: 1, sources: 1, memories: 1 }],
        held: false,
        sentAgain: false,
      });
    }
  );

  it(
    "replaces a find whose names rest on what her erasure took, in her word or about her card, though the find handed over no memory",
    slow,
    async () => {
      const chats = await recallingChats();
      const admin = await signedInApi(idp, "admin");
      const ben = chats.person.userId;
      const at = await benAndAnna(ben);
      const transcript = await added(
        `${at.name}: Falcon starts Monday. Kite is mine.`,
        at.team
      );
      const mark = { falcon: word(), kite: word() };
      const named = await brainOf(
        inJurisdiction(env, env.BRAIN_STORE)
      ).addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group: at.group },
        entities: [
          {
            key: "anna",
            kind: "person",
            names: [at.name],
            identifiers: [{ type: "email", value: at.address }],
          },
          { key: "falcon", kind: "project", names: [`Falcon ${mark.falcon}`] },
          { key: "kite", kind: "project", names: [`Kite ${mark.kite}`] },
        ],
        memories: [
          // In her word, about a project: it alone names the project.
          {
            about: "falcon",
            type: "fact",
            statement: "Falcon starts Monday",
            speaker: saidBy(at.anna.userId),
            basis: on(transcript, "Falcon starts Monday"),
          },
          // About her card, relating to a project: it alone names that one.
          {
            about: "anna",
            attribute: "owns",
            object: "kite",
            type: "fact",
            statement: "She owns Kite",
            speaker: saidBy(ben),
            basis: on(transcript, "Kite is mine"),
          },
        ],
      });
      const replies: ProviderReply[] = [kindCode("project"), says("Noted.")];
      const provider = await answeringProvider(() => replies.shift());
      const { chat, ask } = await chats.newChat();
      await ask(word());
      const before = resultsOf(await opened(chats.person, chat.id)).at(-1);
      // Rested on, never handed over: no use of Ben's.
      const used = await usedIn(chats.stub);

      const left = await erasedByAdmin(admin, at.anna);
      const after = resultsOf(await opened(chats.person, chat.id)).at(-1);
      replies.push(says("Ok."));
      const sentBefore = provider.requests.length;
      await ask("Thanks, and what else is new?");
      const sent = JSON.stringify(
        provider.requests.slice(sentBefore).map(({ body }) => body)
      );

      expect({
        before: [mark.falcon, mark.kite].map(
          (needle) => before?.includes(needle) === true
        ),
        left,
        after,
        held: await Promise.all(
          [mark.falcon, mark.kite].map(
            async (needle) => await objectHolds(chats.stub, needle)
          )
        ),
        sent: [mark.falcon, mark.kite].map((needle) => sent.includes(needle)),
        used: named.memories.filter((memory) => used.includes(memory)),
      }).toStrictEqual({
        used: [],
        before: [true, true],
        left: 0,
        after: withheldResult,
        held: [false, false],
        sent: [false, false],
      });
    }
  );

  it(
    "replaces a colleague's card that holds a fact in her word, drawn from minutes that stay",
    slow,
    async () => {
      const chats = await recallingChats();
      const admin = await signedInApi(idp, "admin");
      const ben = chats.person.userId;
      const at = await benAndAnna(ben);
      const minutes = await added(
        `${at.name}: Bob ships on Tuesdays.`,
        at.team
      );
      const mark = word();
      const written = await brainOf(
        inJurisdiction(env, env.BRAIN_STORE)
      ).addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group: at.group },
        entities: [{ key: "bob", kind: "person", names: [`Bob ${word()}`] }],
        memories: [
          {
            about: "bob",
            type: "fact",
            statement: `Bob ships on Tuesdays ${mark}`,
            speaker: saidBy(at.anna.userId),
            basis: on(minutes, "Bob ships on Tuesdays"),
          },
        ],
      });
      const replies: ProviderReply[] = [
        cardCode(written.entities.bob ?? ""),
        says("Noted."),
        says("Ok."),
      ];
      const provider = await answeringProvider(() => replies.shift());
      const { chat, ask } = await chats.newChat();
      await ask(word());
      const before = resultsOf(await opened(chats.person, chat.id)).at(-1);
      // Handed over on the card: Ben's use of it.
      const used = await usedIn(chats.stub);

      const left = await erasedByAdmin(admin, at.anna);
      const after = resultsOf(await opened(chats.person, chat.id)).at(-1);
      const sentBefore = provider.requests.length;
      await ask("Thanks, and what else is new?");

      expect({
        used: written.memories.filter((memory) => used.includes(memory)),
        before: before?.includes(mark),
        left,
        after,
        held: await objectHolds(chats.stub, mark),
        sent: JSON.stringify(
          provider.requests.slice(sentBefore).map(({ body }) => body)
        ).includes(mark),
      }).toStrictEqual({
        used: written.memories,
        before: true,
        left: 0,
        after: withheldResult,
        held: false,
        sent: false,
      });
    }
  );

  it(
    "hands code nothing of a card whose pins can't be kept with the run first",
    slow,
    async () => {
      const chats = await recallingChats();
      const ben = chats.person.userId;
      const at = await benAndAnna(ben);
      const mark = word();
      const { entities } = await brainOf(
        inJurisdiction(env, env.BRAIN_STORE)
      ).addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group: at.group },
        entities: [{ key: "bob", kind: "person", names: [`Bob ${word()}`] }],
        memories: [
          {
            about: "bob",
            type: "fact",
            statement: `Bob ships on Tuesdays ${mark}`,
            speaker: saidBy(at.anna.userId),
            basis: { kind: "writer", writer: ben },
          },
        ],
      });
      // The chat's object refuses to keep a memory's pin with a run.
      await runInDurableObject(chats.stub, (_instance, state) => {
        state.storage.sql.exec(
          `CREATE TRIGGER test_refuse_pins BEFORE INSERT ON chat_run_sources
          WHEN NEW.source_id LIKE 'brain-%memory:%'
          BEGIN SELECT RAISE(ABORT, 'refused by the test'); END`
        );
      });
      const replies: ProviderReply[] = [
        cardCode(entities.bob ?? ""),
        says("Noted."),
      ];
      await answeringProvider(() => replies.shift());
      const { chat, ask } = await chats.newChat();
      await ask(word());
      const shown = await opened(chats.person, chat.id);

      const result = shown.findLast(({ role }) => role === "result");

      expect({
        failed: result?.role === "result" && result.failed,
        shown: result?.role === "result" && result.text.includes(mark),
        held: await objectHolds(chats.stub, mark),
      }).toStrictEqual({ failed: true, shown: false, held: false });
    }
  );
});

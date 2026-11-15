import { brainOf, personalBrainOf } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { withheldResult } from "../src/agent.ts";
import { organizationId } from "../src/auth/auth.ts";
import { addSource, eraseSource, rememberAs } from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { inJurisdiction, workspace } from "../src/durable-objects.ts";
import { chatOf, codeResults, codeStep, model, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { signedInApi, signedInWithRole, unique } from "./sign-in.ts";

// The Brain's entities for a chat's code (GRA-1894; the threat model is on
// the issue): `env.brain.findEntities` and `.getEntity`, the operations an
// App and a workflow read (brain-recall.ts `entitiesCallFor`), at the
// reach its recall reads at. How it can fail, and what each test holds it
// to:
// 1. What only one person may read reaches code, which can pass it on to
//    an App, a workflow or a connection where no pin follows it: code
//    never reads anyone's own store, in their own chat neither.
// 2. A team's memory reaches a thread others read: in a chat app's direct
//    message code reads only what the whole company may, and in a shared
//    thread nothing; in the person's own chat, their teams' too.
// 3. History sends what code read after it may no longer be read: every
//    version and every memory in a writer's own word an answer rests on
//    is pinned with the run, so a later turn withholds it once a source is
//    erased or narrowed, the memory retired, or the person leaves the team.
// 4. Code learns what exists that it may not see: an id it may not see
//    answers exactly as one nobody holds.
// 5. An answer not as code is handed one reaches code, or the audit log
//    says it was handed over: it fails the call, audited as refused.
// The leak harness (brain-next-leaks.test.ts) probes the same reads, as
// the company and as the person's teams, every way they answer.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 90_000 };

/** A word no other test's memories hold: letters only. */
const word = () =>
  `zq${crypto
    .randomUUID()
    .replaceAll(/[^a-f]/gu, "")
    .slice(0, 12)}`;

/** The shared store, as core reaches it. */
const shared = () => brainOf(inJurisdiction(env, env.BRAIN_STORE));

/** A new team, of `personId`'s when given: its id. */
const teamOf = async (personId?: string): Promise<string> => {
  const teamId = crypto.randomUUID();
  const db = drizzle(env.DB);
  await db.insert(teams).values({
    id: teamId,
    name: `Team ${unique()}`,
    organizationId,
    createdAt: new Date(),
  });
  if (personId !== undefined) {
    await db.insert(teamMembers).values({
      id: crypto.randomUUID(),
      teamId,
      userId: personId,
      createdAt: new Date(),
    });
  }
  return teamId;
};

/** The writer of the shared store's memories in a writer's own word here. */
const writer = "crm";

/**
 * A customer `name` with one memory `statement` that `group` may read, in
 * the shared store: in a writer's word, or drawn from version 1 of
 * `source`. The memory's id.
 */
const sharedCustomer = async (
  group: string,
  name: string,
  statement: string,
  source?: SourceRef
): Promise<string> => {
  const { memories } = await shared().addMemories({
    change: crypto.randomUUID(),
    access: { kind: "audience", group },
    entities: [{ key: "c", kind: "customer", names: [name] }],
    memories: [
      {
        about: "c",
        type: "fact",
        statement,
        speaker: { kind: "system" },
        basis:
          source === undefined
            ? { kind: "writer", writer }
            : {
                kind: "source",
                source: `${source.producer}:${source.id}`,
                version: 1,
                quote: statement,
              },
      },
    ],
  });
  return memories[0] ?? "";
};

/** A customer `name` the person asked to remember, `statement`, in their own store. */
const ownCustomer = async (
  personId: string,
  name: string,
  statement: string
): Promise<void> => {
  await rememberAs(env, personId, {
    change: crypto.randomUUID(),
    about: { kind: "customer", names: [name] },
    type: "fact",
    statement,
    quote: statement,
  });
};

/**
 * Code that finds each of `names` and reads each entity found: a line per
 * entity, `found <name>: <its statements>`, or why it failed.
 */
const readingCode = (names: readonly string[]) =>
  codeStep(
    `export default async (self, env) => { const lines = []; for (const name of ${JSON.stringify(names)}) { try { const { entities } = await env.brain.findEntities({ name }); for (const entity of entities) { const card = await env.brain.getEntity({ entity: entity.id }); lines.push("found " + entity.name + ": " + (card === null ? "no card" : [...card.attributes.flatMap(({ memories }) => memories), ...card.notes].map(({ statement }) => statement).join(" | "))); } } catch (error) { lines.push("failed " + (error.code ?? error.message)); } } return lines; };`
  );

/** Code that returns what `env.brain.getEntity` answers for each of `ids`. */
const cardsCode = (ids: readonly string[]) =>
  codeStep(
    `export default async (self, env) => { const cards = []; for (const entity of ${JSON.stringify(ids)}) { try { cards.push(await env.brain.getEntity({ entity })); } catch (error) { cards.push({ failed: error.code ?? error.message }); } } return cards; };`
  );

/**
 * Code that pages through every entity named `name`, at most five pages:
 * how many each page held, and how many different entities in all.
 */
const pagingCode = (name: string) =>
  codeStep(
    `export default async (self, env) => { const name = ${JSON.stringify(name)}; const pages = []; const ids = new Set(); let after; for (let page = 0; page < 5; page += 1) { const found = await env.brain.findEntities({ name, ...(after === undefined ? {} : { after }) }); pages.push(found.entities.length); for (const { id } of found.entities) { ids.add(id); } if (found.next === null) { break; } after = found.next; } return { pages, different: ids.size }; };`
  );

/** The model's answer to a code step, as JSON. */
const returnedSchema = z
  .string()
  .transform((text): unknown => JSON.parse(text.replace(/^Returned:\n/u, "")));

/** Code that returns the names `env.brain.findEntities` finds by the reference `ref`. */
const namesByRefCode = (ref: string) =>
  codeStep(
    `export default async (self, env) => { const { entities } = await env.brain.findEntities({ identifier: { type: "ref", value: ${JSON.stringify(ref)} } }); return entities.map(({ name }) => "named " + name); };`
  );

/** How many times `text` holds `part`. */
const timesIn = (text: string, part: string): number =>
  text.split(part).length - 1;

/** A chat of `personId`'s own in Grasp, whose agent holds the grant to read the Brain. */
const ownChatOf = async (
  admin: Awaited<ReturnType<typeof signedInApi>>,
  personId: string,
  ...replies: ProviderReply[]
) => {
  const chat = await chatOf(personId, ...replies);
  await requestGranted(idp, admin, {
    subject: chat.agent,
    object: { type: "platform" },
    actions: ["brain"],
    binding: "BRAIN",
  });
  return chat;
};

/**
 * `personId`'s direct message with a new agent of theirs on Teams, which
 * holds the grant to read the Brain, answered by `replies`: `ask` asks
 * in it, and answers the chat's id.
 */
const directMessageOf = async (
  admin: Awaited<ReturnType<typeof signedInApi>>,
  personId: string,
  ...replies: ProviderReply[]
) => {
  const agentId = crypto.randomUUID();
  await requestGranted(idp, admin, {
    subject: { type: "agent", agentId },
    object: { type: "platform" },
    actions: ["brain"],
    binding: "BRAIN",
  });
  const provider = await fakeProvider(...replies);
  const stub = workspace(env, personalWorkspaceId(personId));
  const ask = async (text: string) => {
    const { chatId } = await stub.askThrough(
      personId,
      agentId,
      "teams",
      text,
      undefined,
      { kind: "direct" }
    );
    return chatId;
  };
  return { provider, stub, ask };
};

/** The text a chat's code steps returned, joined. */
const returnedIn = async (
  stub: Parameters<typeof codeResults>[0],
  chatId: string
): Promise<string> => {
  const results = await codeResults(stub, chatId);
  return results.map(({ text }) => text).join("\n");
};

/** What a later turn sent of what code read earlier. */
interface Sent {
  sent: boolean;
  withheld: boolean;
}

const kept: Sent = { sent: true, withheld: false };
const gone: Sent = { sent: false, withheld: true };

/** A chat, as `sentAfter` asks in it: each turn asks, and what the model was sent. */
interface Asking {
  ask: () => Promise<void>;
  requests: () => unknown[];
}

/** What a change does to what a customer's card rests on. */
type Change = (held: {
  source: SourceRef;
  readers: SourceReaders;
  memory: string;
  group: string;
}) => Promise<void>;

/**
 * Whether a chat whose code read a customer that `readers` may read, its
 * memory in a writer's own word (`word`) or drawn from a source, still
 * sends what it read in its next turn, once `change` changed what the card
 * rests on. `asking` makes the chat, the person's own or a direct message:
 * its turns ask a word nothing answers, so the turn's own recall hands
 * nothing over and only what the code read is kept with the chat. One
 * chat at a time: the model's replies are the latest chat's.
 */
const sentAfter = async (
  asking: (...replies: ProviderReply[]) => Promise<Asking>,
  readers: SourceReaders,
  basis: "source" | "word",
  change: Change
): Promise<Sent> => {
  const name = `Customer ${word()}`;
  const statement = `Renews ${word()}`;
  const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
  const group = readers.kind === "team" ? `team:${readers.teamId}` : "company";
  if (basis === "source") {
    await addSource(env, {
      source,
      change: crypto.randomUUID(),
      text: statement,
      readers,
    });
  }
  const memory = await sharedCustomer(
    group,
    name,
    statement,
    basis === "source" ? source : undefined
  );
  const chat = await asking(
    readingCode([name]),
    says("Read it."),
    says("And now.")
  );
  await chat.ask();
  const before = chat.requests().length;
  const read = JSON.stringify(chat.requests().at(-1));
  if (!read.includes(`found ${name}: ${statement}`)) {
    throw new Error(`The code didn't read the customer: ${read}`);
  }
  await change({ source, readers, memory, group });
  await chat.ask();
  const body = JSON.stringify(chat.requests()[before]);
  return {
    sent: body.includes(statement),
    withheld: body.includes(withheldResult),
  };
};

/** Nothing changes. */
const unchanged: Change = async () => {
  await Promise.resolve();
};

/** The source erased. */
const erased: Change = async ({ source, readers }) => {
  await eraseSource(env, { source, readers, reason: "deleted" });
};

/** A new version of the source only a team nobody is in may read. */
const narrowed: Change = async ({ source }) => {
  await addSource(env, {
    source,
    change: crypto.randomUUID(),
    text: "Now for another team.",
    readers: { kind: "team", teamId: await teamOf() },
  });
};

/** A new version of the source, its text changed, that `readers` may read. */
const readBy =
  (readers: SourceReaders): Change =>
  async ({ source }) => {
    await addSource(env, {
      source,
      change: crypto.randomUUID(),
      text: "Changed.",
      readers,
    });
  };

/** The memory retired by its writer. */
const retired: Change = async ({ memory, group }) => {
  await shared().retireMemory({
    memory,
    reader: { person: writer, groups: [group] },
    writer,
    change: "retire",
  });
};

/**
 * The Brain's stores addressed while `run` runs, by name (the shared one,
 * `brain`; a person's own, `person:<id>`), and of those, the ones code's
 * entity reads addressed (`codeCardAs` and `codeEntitiesAs` on the stack).
 */
const storesAddressed = async (
  run: () => Promise<unknown>
): Promise<{ all: string[]; byCode: string[] }> => {
  const binding = env.BRAIN_STORE;
  const all = new Set<string>();
  const byCode = new Set<string>();
  const codeReads = /codeCardAs|codeEntitiesAs/u;
  const getByName = binding.getByName.bind(binding);
  const spy = vi
    .spyOn(binding, "getByName")
    .mockImplementation((name, ...rest) => {
      all.add(name);
      if (codeReads.test(new Error("addressed").stack ?? "")) {
        byCode.add(name);
      }
      return getByName(name, ...rest);
    });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return { all: [...all].toSorted(), byCode: [...byCode].toSorted() };
};

describe("a chat's code reading the Brain's entities", setUpTime, () => {
  it("reads its person's team's and the company's in their own chat, in Grasp or a chat app's direct message, but never their own, and none in a shared thread", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInWithRole(idp, "user");
    const team = await teamOf(person.userId);
    const marker = word();
    const names = {
      own: `Own ${marker}`,
      team: `Team ${marker}`,
      company: `Company ${marker}`,
    };
    const statements = {
      own: `Own note ${word()}`,
      team: `Team note ${word()}`,
      company: `Company note ${word()}`,
    };
    await ownCustomer(person.userId, names.own, statements.own);
    await sharedCustomer(`team:${team}`, names.team, statements.team);
    await sharedCustomer("company", names.company, statements.company);
    const allNames = [names.own, names.team, names.company];

    const own = await ownChatOf(
      admin,
      person.userId,
      readingCode(allNames),
      says("Read.")
    );
    await own.ask(word());
    const inOwnChat = await returnedIn(own.stub, own.chat.id);

    /** What code returned through Teams, in a direct message or a shared thread. */
    const through = async (sharedThread: boolean) => {
      const agentId = crypto.randomUUID();
      await requestGranted(idp, admin, {
        subject: { type: "agent", agentId },
        object: { type: "platform" },
        actions: ["brain"],
        binding: "BRAIN",
      });
      const provider = await fakeProvider(readingCode(allNames), says("Read."));
      const stub = workspace(env, personalWorkspaceId(person.userId));
      const { chatId } = await stub.askThrough(
        person.userId,
        agentId,
        "teams",
        word(),
        undefined,
        sharedThread
          ? {
              thread: `19:${unique()}@thread.v2`,
              kind: "group",
              audience: { members: [person.userId], outsiders: false },
            }
          : { kind: "direct" }
      );
      const returned = await returnedIn(stub, chatId);
      const sent = JSON.stringify(provider.requests.map(({ body }) => body));
      return {
        company: returned.includes(
          `found ${names.company}: ${statements.company}`
        ),
        // Neither found, nor the note anywhere the model was sent.
        own:
          returned.includes(`found ${names.own}`) ||
          sent.includes(statements.own),
        team:
          returned.includes(`found ${names.team}`) ||
          sent.includes(statements.team),
      };
    };

    expect({
      ownChat: {
        own:
          inOwnChat.includes(`found ${names.own}`) ||
          inOwnChat.includes(statements.own),
        team: inOwnChat.includes(`found ${names.team}: ${statements.team}`),
        company: inOwnChat.includes(
          `found ${names.company}: ${statements.company}`
        ),
      },
      direct: await through(false),
      thread: await through(true),
    }).toStrictEqual({
      // Their teams' and the company's, as its recall; never their own.
      ownChat: { own: false, team: true, company: true },
      // Their direct message is their own chat too (GRA-1821): the same.
      direct: { company: true, own: false, team: true },
      // A thread others share gets no Brain at all (agent-apis.ts).
      thread: { company: false, own: false, team: false },
    });
  });

  it("withholds what its code read in its person's own chat from a later turn once a source it rests on is erased or narrowed, its memory retired, or the person leaves the team", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInWithRole(idp, "user");
    const team = await teamOf(person.userId);
    const readers: SourceReaders = { kind: "team", teamId: team };
    const ownChat = async (...replies: ProviderReply[]): Promise<Asking> => {
      const chat = await ownChatOf(admin, person.userId, ...replies);
      return {
        ask: async () => {
          await chat.ask(word());
        },
        requests: () => chat.provider.requests.map(({ body }) => body),
      };
    };
    /** The person taken out of the team. */
    const leftTeam: Change = async () => {
      await drizzle(env.DB)
        .delete(teamMembers)
        .where(
          and(
            eq(teamMembers.teamId, team),
            eq(teamMembers.userId, person.userId)
          )
        );
    };

    expect({
      unchanged: await sentAfter(ownChat, readers, "source", unchanged),
      erased: await sentAfter(ownChat, readers, "source", erased),
      narrowed: await sentAfter(ownChat, readers, "source", narrowed),
      wordUnchanged: await sentAfter(ownChat, readers, "word", unchanged),
      // A memory in a writer's own word, which rests on no version.
      retired: await sentAfter(ownChat, readers, "word", retired),
      // Last: they are in the team no more.
      left: await sentAfter(ownChat, readers, "source", leftTeam),
    }).toStrictEqual({
      unchanged: kept,
      erased: gone,
      narrowed: gone,
      wordUnchanged: kept,
      retired: gone,
      left: gone,
    });
  });

  it("withholds what its code read in a chat app's direct message from a later turn once a source it rests on is erased or narrowed away from the company, or its memory retired", async () => {
    const admin = await signedInApi(idp, "admin");
    const readers: SourceReaders = { kind: "everyone" };
    // A person's direct message is one chat: each case its own person.
    const direct = async (...replies: ProviderReply[]): Promise<Asking> => {
      const person = await signedInWithRole(idp, "user");
      const dm = await directMessageOf(admin, person.userId, ...replies);
      return {
        ask: async () => {
          await dm.ask(word());
        },
        requests: () => dm.provider.requests.map(({ body }) => body),
      };
    };

    expect({
      unchanged: await sentAfter(direct, readers, "source", unchanged),
      erased: await sentAfter(direct, readers, "source", erased),
      // To a team nobody is in: the company may read it no more.
      narrowed: await sentAfter(direct, readers, "source", narrowed),
      wordUnchanged: await sentAfter(direct, readers, "word", unchanged),
      retired: await sentAfter(direct, readers, "word", retired),
    }).toStrictEqual({
      unchanged: kept,
      erased: gone,
      narrowed: gone,
      wordUnchanged: kept,
      retired: gone,
    });
  });

  it("answers an entity it may not see, its person's own among them, exactly as one nobody holds", async () => {
    const admin = await signedInApi(idp, "admin");
    const [person, other] = await Promise.all([
      signedInWithRole(idp, "user"),
      signedInWithRole(idp, "user"),
    ]);
    const marker = word();
    // The person's own customer, someone else's, and one of a team the
    // person isn't in.
    const names = [`Mine ${marker}`, `Theirs ${marker}`, `Hidden ${marker}`];
    await ownCustomer(person.userId, `Mine ${marker}`, `Mine ${word()}`);
    await ownCustomer(other.userId, `Theirs ${marker}`, `Theirs ${word()}`);
    const othersTeam = await teamOf(other.userId);
    await sharedCustomer(
      `team:${othersTeam}`,
      `Hidden ${marker}`,
      `Hidden ${word()}`
    );
    /** The id of `name`, as `reader` finds it in their own store, or the shared one. */
    const idOf = async (
      ownStore: boolean,
      reader: { person: string; groups: string[] },
      name: string
    ): Promise<string> => {
      const store = ownStore
        ? personalBrainOf(inJurisdiction(env, env.BRAIN_STORE), reader.person)
        : shared();
      const page = await store.findEntities({ reader, name });
      const [found] = page.entities;
      if (found === undefined) {
        throw new Error(`No ${name}`);
      }
      return found.id;
    };
    const hiddenIds = [
      await idOf(true, { person: person.userId, groups: [] }, `Mine ${marker}`),
      await idOf(
        true,
        { person: other.userId, groups: [] },
        `Theirs ${marker}`
      ),
      await idOf(
        false,
        { person: other.userId, groups: [`team:${othersTeam}`] },
        `Hidden ${marker}`
      ),
    ];
    const unknown = hiddenIds.map(() => crypto.randomUUID());
    const chat = await ownChatOf(
      admin,
      person.userId,
      cardsCode(hiddenIds),
      cardsCode(unknown),
      readingCode(names),
      says("None.")
    );
    await chat.ask(word());
    const [hidden, nobody, found] = await codeResults(chat.stub, chat.chat.id);
    expect({
      hidden: hidden?.text,
      found: returnedSchema.parse(found?.text),
    }).toStrictEqual({ hidden: nobody?.text, found: [] });
  });

  it("pages a find in its person's own chat past one page, each entity once", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInWithRole(idp, "user");
    const team = await teamOf(person.userId);
    // One word: customers so named are never linked by it.
    const name = `Paged${word()}`;
    // A page of the Brain's (100), and one more past it.
    for (const count of [100, 1]) {
      // oxlint-disable-next-line no-await-in-loop -- one add at a time
      await shared().addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group: `team:${team}` },
        entities: Array.from({ length: count }, (_, at) => ({
          key: `c${at}`,
          kind: "customer" as const,
          names: [name],
        })),
        memories: Array.from({ length: count }, (_, at) => ({
          about: `c${at}`,
          type: "fact" as const,
          statement: `${name} is a customer`,
          speaker: { kind: "system" as const },
          basis: { kind: "writer" as const, writer },
        })),
      });
    }
    const chat = await ownChatOf(
      admin,
      person.userId,
      pagingCode(name),
      says("Paged.")
    );
    await chat.ask(word());
    const [paged] = await codeResults(chat.stub, chat.chat.id);
    expect(returnedSchema.parse(paged?.text)).toStrictEqual({
      pages: [100, 1],
      different: 101,
    });
  });

  it("addresses only the shared store from its code's reads, in its person's own chat asked or woken and in their direct message", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInWithRole(idp, "user");
    const team = await teamOf(person.userId);
    const ownName = `Own ${word()}`;
    await ownCustomer(person.userId, ownName, `Own note ${word()}`);
    const teamName = `Team ${word()}`;
    const teamStatement = `Team note ${word()}`;
    await sharedCustomer(`team:${team}`, teamName, teamStatement);
    const code = () => readingCode([ownName, teamName]);
    const own = `person:${person.userId}`;

    const asked = await ownChatOf(admin, person.userId, code(), says("Done."));
    const inAsked = await storesAddressed(async () => {
      await asked.ask(word());
    });
    const woken = await ownChatOf(admin, person.userId, code(), says("Done."));
    const inWoken = await storesAddressed(async () => {
      await woken.stub.askUnattended(woken.chat.id, { text: word(), model });
    });
    const direct = await directMessageOf(
      admin,
      person.userId,
      code(),
      says("Done.")
    );
    let directChat = "";
    const inDirect = await storesAddressed(async () => {
      directChat = await direct.ask(word());
    });

    expect({
      asked: {
        // The turn's own recall reads their own store there: code never.
        own: inAsked.all.includes(own),
        byCode: inAsked.byCode,
        read: await returnedIn(asked.stub, asked.chat.id),
      },
      woken: {
        byCode: inWoken.byCode,
        read: await returnedIn(woken.stub, woken.chat.id),
      },
      direct: {
        own: inDirect.all.includes(own),
        byCode: inDirect.byCode,
        read: await returnedIn(direct.stub, directChat),
      },
    }).toStrictEqual({
      asked: {
        own: true,
        byCode: ["brain"],
        read: `Returned:\n${JSON.stringify([`found ${teamName}: ${teamStatement}`])}`,
      },
      // A turn nobody started reads as the company alone.
      woken: { byCode: ["brain"], read: "Returned:\n[]" },
      // Their direct message is their own chat (GRA-1821): as asked.
      direct: {
        own: true,
        byCode: ["brain"],
        read: `Returned:\n${JSON.stringify([`found ${teamName}: ${teamStatement}`])}`,
      },
    });
  });

  it("still sends what its code read in its person's own chat once its source is narrowed to another team of theirs, or widened to the company", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInWithRole(idp, "user");
    const [first, second] = [
      await teamOf(person.userId),
      await teamOf(person.userId),
    ];
    const ownChat = async (...replies: ProviderReply[]): Promise<Asking> => {
      const chat = await ownChatOf(admin, person.userId, ...replies);
      return {
        ask: async () => {
          await chat.ask(word());
        },
        requests: () => chat.provider.requests.map(({ body }) => body),
      };
    };
    const readers: SourceReaders = { kind: "team", teamId: first };

    expect({
      toTheirOtherTeam: await sentAfter(
        ownChat,
        readers,
        "source",
        readBy({ kind: "team", teamId: second })
      ),
      toTheCompany: await sentAfter(
        ownChat,
        readers,
        "source",
        readBy({ kind: "everyone" })
      ),
    }).toStrictEqual({ toTheirOtherTeam: kept, toTheCompany: kept });
  });

  it("refuses its code a card the Brain answers outside its contract, audited as refused, never as handed over", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInWithRole(idp, "user");
    const name = `Customer ${word()}`;
    await sharedCustomer("company", name, `Renews ${word()}`);
    const chat = await ownChatOf(
      admin,
      person.userId,
      readingCode([name]),
      says("Read.")
    );
    // The shared store answering a card of a kind no list has: as a
    // mapping of core's gone wrong would hand code.
    const binding = env.BRAIN_STORE;
    const getByName = binding.getByName.bind(binding);
    const spy = vi
      .spyOn(binding, "getByName")
      .mockImplementation((storeName, ...rest) => {
        const store = getByName(storeName, ...rest);
        return new Proxy(store, {
          get: (target, key): unknown =>
            key === "readCard"
              ? async (request: Parameters<typeof target.readCard>[0]) => {
                  const card = await target.readCard(request);
                  return card === null
                    ? null
                    : { ...card, entity: { ...card.entity, kind: "starship" } };
                }
              : Reflect.get(target, key, target),
        });
      });
    try {
      await chat.ask(word());
    } finally {
      spy.mockRestore();
    }

    const events = await vi.waitFor(
      async () => {
        const all = await allEvents();
        const reads = all.filter(
          ({ action, detail }) =>
            action === "brain.entities.get" &&
            detail?.onBehalfOf === person.userId
        );
        expect(reads.length).toBeGreaterThanOrEqual(1);
        return reads;
      },
      { timeout: 10_000, interval: 50 }
    );
    expect({
      read: await returnedIn(chat.stub, chat.chat.id),
      audited: events.map(({ detail }) => ({
        found: detail?.found,
        refused: detail?.refused,
      })),
    }).toStrictEqual({
      read: `Returned:\n${JSON.stringify([
        "failed An answer not as code is handed one reached the Brain's entities",
      ])}`,
      audited: [{ found: undefined, refused: "internal.unexpected" }],
    });
  });

  it("keeps what its code read once the memory that first named the entity is retired while another is current, and finds nothing of it once every one is", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInWithRole(idp, "user");
    /**
     * A company customer two writers named, each by a memory in their own
     * word, the first of them retired before its chat's code reads it
     * (`read`: its card, or a find by its reference); then the second
     * retired too, and the code reads it again.
     */
    const forgotten = async (read: "card" | "find") => {
      const name = `Customer ${word()}`;
      const ref = `crm:${word()}`;
      const statements = [`Renews ${word()}`, `Pays ${word()}`];
      const remembered = async (by: string, statement: string, id?: string) =>
        await shared().addMemories({
          change: crypto.randomUUID(),
          access: { kind: "audience", group: "company" },
          ...(id === undefined
            ? {}
            : { reader: { person: by, groups: ["company"] } }),
          entities: [
            {
              key: "c",
              kind: "customer",
              ...(id === undefined ? {} : { id }),
              names: [name],
              identifiers: [{ type: "ref", value: ref }],
            },
          ],
          memories: [
            {
              about: "c",
              type: "fact",
              statement,
              speaker: { kind: "system" },
              basis: { kind: "writer", writer: by },
            },
          ],
        });
      const [firstWriter, secondWriter] = [`w-${word()}`, `w-${word()}`];
      const first = await remembered(firstWriter, statements[0] ?? "");
      const entity = first.entities.c ?? "";
      const second = await remembered(
        secondWriter,
        statements[1] ?? "",
        entity
      );
      const retire = async (by: string, memory: string | undefined) => {
        await shared().retireMemory({
          memory: memory ?? "",
          reader: { person: by, groups: ["company"] },
          writer: by,
          change: "retire",
        });
      };
      await retire(firstWriter, first.memories[0]);
      const code = () =>
        read === "card" ? cardsCode([entity]) : namesByRefCode(ref);
      const chat = await ownChatOf(
        admin,
        person.userId,
        code(),
        says("Read."),
        says("Again."),
        code(),
        says("Read again."),
        says("Last.")
      );
      const shown = read === "card" ? (statements[1] ?? "") : `named ${name}`;
      await chat.ask(word());
      const [handed] = await codeResults(chat.stub, chat.chat.id);
      let at = chat.provider.requests.length;
      await chat.ask(word());
      const next = JSON.stringify(chat.provider.requests[at]?.body);
      await retire(secondWriter, second.memories[0]);
      // Every memory of it forgotten: a fresh read finds nothing of it,
      // and its turn goes on.
      const turn = await chat.ask(word()).then(() => "answered", String);
      const [, fresh] = await codeResults(chat.stub, chat.chat.id);
      at = chat.provider.requests.length;
      await chat.ask(word());
      // The next turn: the first read, which rested on the memory now
      // forgotten, withheld; the fresh one still sent.
      const later = JSON.stringify(chat.provider.requests[at]?.body);
      return {
        handed: handed?.text.includes(shown),
        next: {
          sent: next.includes(shown),
          withheld: timesIn(next, withheldResult),
        },
        fresh: returnedSchema.parse(fresh?.text),
        turn,
        later: {
          sent: later.includes(shown) || later.includes(name),
          withheld: timesIn(later, withheldResult),
        },
      };
    };

    expect({
      card: await forgotten("card"),
      find: await forgotten("find"),
    }).toStrictEqual({
      // Named and held by the current memory: handed over, and kept.
      card: {
        handed: true,
        next: { sent: true, withheld: 0 },
        // Not seen once only forgotten memories mention it.
        fresh: [null],
        turn: "answered",
        later: { sent: false, withheld: 1 },
      },
      find: {
        handed: true,
        next: { sent: true, withheld: 0 },
        fresh: [],
        turn: "answered",
        later: { sent: false, withheld: 1 },
      },
    });
  });

  it("keeps a fresh card confirmed over a rival its writer has since forgotten, and withholds the read that rested on that rival", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInWithRole(idp, "user");
    const [rightWriter, wrongWriter] = [`w-${word()}`, `w-${word()}`];
    const name = `Customer ${word()}`;
    const status = async (value: string, writerOf: string, id?: string) =>
      await shared().addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group: "company" },
        ...(id === undefined
          ? {}
          : { reader: { person: writerOf, groups: ["company"] } }),
        entities: [
          {
            key: "c",
            kind: "customer",
            ...(id === undefined ? {} : { id }),
            names: [name],
          },
        ],
        memories: [
          {
            about: "c",
            attribute: "status",
            value,
            type: "fact",
            statement: `${name} is ${value}`,
            speaker: { kind: "system" },
            basis: { kind: "writer", writer: writerOf },
          },
        ],
      });
    const right = await status("Active", rightWriter);
    const entity = right.entities.c ?? "";
    const wrong = await status("Paused", wrongWriter, entity);
    // Confirmed over the rival by someone who reads them both.
    await shared().confirmMemory({
      memory: right.memories[0] ?? "",
      reader: { person: `p-${word()}`, groups: ["company"] },
    });
    const chat = await ownChatOf(
      admin,
      person.userId,
      cardsCode([entity]),
      says("Read."),
      cardsCode([entity]),
      says("Read again."),
      says("Last.")
    );
    await chat.ask(word());
    await shared().retireMemory({
      memory: wrong.memories[0] ?? "",
      reader: { person: wrongWriter, groups: ["company"] },
      writer: wrongWriter,
      change: "retire",
    });
    const turn = await chat.ask(word()).then(() => "answered", String);
    const [first, fresh] = await codeResults(chat.stub, chat.chat.id);
    const at = chat.provider.requests.length;
    await chat.ask(word());
    const later = JSON.stringify(chat.provider.requests[at]?.body);
    const statusOf = (text: string | undefined) =>
      z
        .array(
          z.object({
            attributes: z.array(
              z.object({
                memories: z.array(
                  z.object({
                    value: z.string().nullable(),
                    confirmed: z.boolean(),
                    contested: z.boolean(),
                  })
                ),
              })
            ),
          })
        )
        .parse(returnedSchema.parse(text))
        .flatMap(({ attributes }) =>
          attributes.flatMap(({ memories }) => memories)
        );

    expect({
      first: statusOf(first?.text),
      turn,
      fresh: statusOf(fresh?.text),
      later: {
        withheld: timesIn(later, withheldResult),
        paused: later.includes(`${name} is Paused`),
      },
    }).toStrictEqual({
      // Both sides, the right one confirmed.
      first: [
        { value: "Active", confirmed: true, contested: true },
        { value: "Paused", confirmed: false, contested: true },
      ],
      // The rival forgotten: still confirmed, contested no more, and the
      // turn goes on.
      turn: "answered",
      fresh: [{ value: "Active", confirmed: true, contested: false }],
      // The first read rested on the forgotten rival: withheld; the fresh
      // one stays.
      later: { withheld: 1, paused: false },
    });
  });
});

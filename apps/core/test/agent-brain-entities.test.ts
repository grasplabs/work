import { brainOf, personalBrainOf } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { withheldResult } from "../src/agent.ts";
import { organizationId } from "../src/auth/auth.ts";
import { addSource, eraseSource, rememberAs } from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { inJurisdiction, workspace } from "../src/durable-objects.ts";
import { chatOf, codeResults, codeStep, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
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

/** The memory retired by its writer. */
const retired: Change = async ({ memory, group }) => {
  await shared().retireMemory({
    memory,
    reader: { person: writer, groups: [group] },
  });
};

describe("a chat's code reading the Brain's entities", setUpTime, () => {
  it("reads its person's team's and the company's in their own chat but never their own, only the company's in a chat app's direct message, and none in a shared thread", async () => {
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
      direct: { company: true, own: false, team: false },
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
});

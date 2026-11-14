import { brainOf, personalBrainOf } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { withheldResult } from "../src/agent.ts";
import { organizationId } from "../src/auth/auth.ts";
import {
  addSource,
  eraseSource,
  forgetAs,
  rememberAs,
} from "../src/brain-next.ts";
import type { SourceRef } from "../src/brain-next.ts";
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
// reach of the turn. How it can fail, and what each test holds it to:
// 1. A team's or a person's own memory reaches a thread others read: in a
//    chat app's direct message, code reads only what the whole company
//    may, and in a shared thread nothing; in the person's own chat in
//    Grasp, their own memories and their teams' too.
// 2. History sends what code read after it may no longer be read: every
//    version and every memory in a writer's own word an answer rests on
//    is pinned with the run, so a later turn withholds it once a source is
//    erased or narrowed, or the person forgets the memory.
// 3. Code learns what exists that it may not see: an id it may not see
//    answers exactly as one nobody holds.
// The leak harness (brain-next-leaks.test.ts) probes the same reads, as
// the company and as the person, every way they answer.

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

/** A new team of `personId`'s alone: its id. */
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

/**
 * A customer `name` with one memory `statement` that `group` may read, in
 * the shared store: in a writer's word, or drawn from version 1 of
 * `source`.
 */
const sharedCustomer = async (
  group: string,
  name: string,
  statement: string,
  source?: SourceRef
): Promise<void> => {
  await shared().addMemories({
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
            ? { kind: "writer", writer: "crm" }
            : {
                kind: "source",
                source: `${source.producer}:${source.id}`,
                version: 1,
                quote: statement,
              },
      },
    ],
  });
};

/** A customer `name` the person asked to remember, `statement`, in their own store: the memory's id. */
const ownCustomer = async (
  personId: string,
  name: string,
  statement: string
): Promise<string> => {
  const { memory } = await rememberAs(env, personId, {
    change: crypto.randomUUID(),
    about: { kind: "customer", names: [name] },
    type: "fact",
    statement,
    quote: statement,
  });
  return memory;
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

/** The text a chat's code steps returned, joined. */
const returnedIn = async (
  stub: Parameters<typeof codeResults>[0],
  chatId: string
): Promise<string> => {
  const results = await codeResults(stub, chatId);
  return results.map(({ text }) => text).join("\n");
};

describe("a chat's code reading the Brain's entities", setUpTime, () => {
  it("reads its person's own, their team's and the company's in their own chat, only the company's in a chat app's direct message, and none in a shared thread", async () => {
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
    await own.ask("Who do we know?");
    const inOwnChat = await returnedIn(own.stub, own.chat.id);

    /** What code returned through `platform`, in a direct message or a shared thread. */
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
        "Who do we know?",
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
        own: inOwnChat.includes(`found ${names.own}: ${statements.own}`),
        team: inOwnChat.includes(`found ${names.team}: ${statements.team}`),
        company: inOwnChat.includes(
          `found ${names.company}: ${statements.company}`
        ),
      },
      direct: await through(false),
      thread: await through(true),
    }).toStrictEqual({
      ownChat: { own: true, team: true, company: true },
      direct: { company: true, own: false, team: false },
      // A thread others share gets no Brain at all (agent-apis.ts).
      thread: { company: false, own: false, team: false },
    });
  });

  it("withholds what its code read from a later turn once a source it rests on is erased or narrowed, or its person forgets the memory", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInWithRole(idp, "user");
    const team = await teamOf(person.userId);
    /**
     * Whether a chat whose code read a customer still sends what it read
     * in its next turn, once `change` changed what the card rests on. One
     * chat at a time: the model's replies are the latest chat's.
     */
    const sentAfter = async (
      kept: "source" | "own",
      change: (held: { source: SourceRef; memory: string }) => Promise<void>
    ): Promise<{ sent: boolean; withheld: boolean }> => {
      const name = `Customer ${word()}`;
      const statement = `Renews ${word()}`;
      const source: SourceRef = { producer: "upload", id: crypto.randomUUID() };
      let memory = "";
      if (kept === "source") {
        await addSource(env, {
          source,
          change: crypto.randomUUID(),
          text: statement,
          readers: { kind: "team", teamId: team },
        });
        await sharedCustomer(`team:${team}`, name, statement, source);
      } else {
        memory = await ownCustomer(person.userId, name, statement);
      }
      const chat = await ownChatOf(
        admin,
        person.userId,
        readingCode([name]),
        says("Read it."),
        says("And now.")
      );
      // A question nothing answers: the turn's own recall before it hands
      // over nothing, so only what the code read is kept with the chat.
      await chat.ask(word());
      const read = await returnedIn(chat.stub, chat.chat.id);
      if (!read.includes(statement)) {
        throw new Error(`The code didn't read the customer: ${read}`);
      }
      await change({ source, memory });
      const before = chat.provider.requests.length;
      await chat.ask("And now?");
      const body = JSON.stringify(chat.provider.requests[before]?.body);
      return {
        sent: body.includes(statement),
        withheld: body.includes(withheldResult),
      };
    };
    const kept = { sent: true, withheld: false };
    const gone = { sent: false, withheld: true };

    expect({
      unchanged: await sentAfter("source", async () => {
        await Promise.resolve();
      }),
      erased: await sentAfter("source", async ({ source }) => {
        await eraseSource(env, {
          source,
          readers: { kind: "team", teamId: team },
          reason: "deleted",
        });
      }),
      // Narrowed to a team they aren't in.
      narrowed: await sentAfter("source", async ({ source }) => {
        await addSource(env, {
          source,
          change: crypto.randomUUID(),
          text: "Now for another team.",
          readers: { kind: "team", teamId: await teamOf() },
        });
      }),
      ownUnchanged: await sentAfter("own", async () => {
        await Promise.resolve();
      }),
      // A memory in their own word, which rests on no version.
      forgotten: await sentAfter("own", async ({ memory }) => {
        await forgetAs(env, person.userId, memory);
      }),
    }).toStrictEqual({
      unchanged: kept,
      erased: gone,
      narrowed: gone,
      ownUnchanged: kept,
      forgotten: gone,
    });
  });

  it("answers an entity it may not see exactly as one nobody holds", async () => {
    const admin = await signedInApi(idp, "admin");
    const [person, other] = await Promise.all([
      signedInWithRole(idp, "user"),
      signedInWithRole(idp, "user"),
    ]);
    const marker = word();
    // Someone else's own customer, and one of a team the person isn't in.
    await ownCustomer(other.userId, `Theirs ${marker}`, `Theirs ${word()}`);
    const othersTeam = await teamOf(other.userId);
    await sharedCustomer(
      `team:${othersTeam}`,
      `Hidden ${marker}`,
      `Hidden ${word()}`
    );
    const reader = { person: other.userId, groups: [`team:${othersTeam}`] };
    const hiddenIds = await Promise.all(
      [
        personalBrainOf(inJurisdiction(env, env.BRAIN_STORE), other.userId),
        shared(),
      ].map(async (store, at) => {
        const name = at === 0 ? `Theirs ${marker}` : `Hidden ${marker}`;
        const page = await store.findEntities({ reader, name });
        const [found] = page.entities;
        if (found === undefined) {
          throw new Error(`No ${name}`);
        }
        return found.id;
      })
    );
    const unknown = [crypto.randomUUID(), crypto.randomUUID()];
    const chat = await ownChatOf(
      admin,
      person.userId,
      cardsCode(hiddenIds),
      cardsCode(unknown),
      readingCode([`Theirs ${marker}`, `Hidden ${marker}`]),
      says("None.")
    );
    await chat.ask("What do you know?");
    const [hidden, nobody, found] = await codeResults(chat.stub, chat.chat.id);
    expect({
      hidden: hidden?.text,
      found: z
        .array(z.string())
        .parse(JSON.parse((found?.text ?? "").replace(/^Returned:\n/u, ""))),
    }).toStrictEqual({ hidden: nobody?.text, found: [] });
  });
});

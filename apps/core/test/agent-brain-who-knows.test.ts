import type { BrainUploadReaders } from "@grasp-os/shared/brain-sources";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { withheldResult } from "../src/agent.ts";
import { organizationId } from "../src/auth/auth.ts";
import { personalWorkspaceId } from "../src/chats-rpc.ts";
import {
  brainUploads,
  teamMembers,
  teams,
  users,
} from "../src/db/core/schema.ts";
import { workspace } from "../src/durable-objects.ts";
import { chatOf, codeResults, codeStep, model, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { signedInApi, unique } from "./sign-in.ts";

// Who knows about a topic, for a chat's code (GRA-1744; the design note
// and threat model are on the issue): `env.brain.whoKnows` names the
// people who uploaded the documents about it that the chat's person may
// read, each with the one version that says so best. How it can fail,
// and what each test holds it to:
// 1. A person is named on the strength of a document the asker may not
//    read: a team's they aren't in, one its uploader alone reads, or one
//    removed (its removal still owed by the Brain, too). None names
//    anyone.
// 2. What only one person may read becomes evidence: the asker's own
//    upload for themselves alone names nobody, them included.
// 3. An erased or removed person is named, or one named for a team's
//    document they may no longer read themselves: never.
// 4. Monitoring: one citation a person, never how much they uploaded,
//    and people in the order of their names, never ranked.
// 5. It reads wider than its recall: in Grasp and in a chat app's direct
//    message, their teams and the company; in a turn nobody started, the
//    company alone.
// 6. A named person outlives what it rests on in the chat's history: the
//    version cited and the person are pinned, so a later turn withholds
//    the answer once the document is gone, or the person removed or
//    erased; and the chat no longer shows it once either was erased.
// Team claims and drawings (the `members` reader set) name nobody: code's
// reach never reads that set, and only uploads name their uploader.
// 7. The audit log names who was named: each answer is audited by who
//    asked and counts alone. Without the brain permission a chat's code
//    has no `env.brain` at all; the harness probes the refusals.
// The leak harness (brain-next-leaks.test.ts) probes the same read with
// the markers and their twins, every way it answers.

const idp = mockIdp();

/** Signing people in, uploading and granting can be slow on CI. */
const setUpTime = { timeout: 120_000 };

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** A word no other test's uploads hold: letters only. */
const word = () =>
  `zq${crypto
    .randomUUID()
    .replaceAll(/[^a-f]/gu, "")
    .slice(0, 12)}`;

/** A new team of `people`: its id. */
const teamOf = async (...people: Person[]): Promise<string> => {
  const teamId = crypto.randomUUID();
  const db = drizzle(env.DB);
  await db.insert(teams).values({
    id: teamId,
    name: `Team ${unique()}`,
    organizationId,
    createdAt: new Date(),
  });
  for (const { userId } of people) {
    // oxlint-disable-next-line no-await-in-loop -- one member at a time
    await db.insert(teamMembers).values({
      id: crypto.randomUUID(),
      teamId,
      userId,
      createdAt: new Date(),
    });
  }
  return teamId;
};

/** `person` taken out of the team `teamId`, still a member of the organization. */
const leftTeam = async (teamId: string, { userId }: Person): Promise<void> => {
  await drizzle(env.DB)
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
};

/** `person` uploads a file saying `text` for `readers`: its upload's id. */
const uploaded = async (
  person: Person,
  text: string,
  readers: BrainUploadReaders
): Promise<string> => {
  const { source } = await person.api.brainSources.upload(
    {
      name: `Notes ${word()}.vtt`,
      bytes: new TextEncoder().encode(
        `WEBVTT\n\n00:00:00.000 --> 00:00:05.000\n${text}\n`
      ),
    },
    readers,
    crypto.randomUUID()
  );
  return source.id;
};

/** Code that returns what `env.brain.whoKnows` answers for `question`, or why it failed. */
const askingCode = (question: string) =>
  codeStep(
    `export default async (self, env) => { try { return await env.brain.whoKnows({ question: ${JSON.stringify(question)}, budget: { tokens: 4000 } }); } catch (error) { return { failed: error.code ?? error.message }; } };`
  );

const answerSchema = z.union([
  z.strictObject({
    people: z.array(
      z.strictObject({
        id: z.string(),
        name: z.string(),
        source: z.strictObject({
          producer: z.literal("upload"),
          id: z.string(),
        }),
        version: z.number(),
        found: z.enum(["exact", "words", "stop words", "meaning"]),
      })
    ),
    notFound: z.array(z.string()),
    truncated: z.boolean(),
  }),
  z.strictObject({ failed: z.string() }),
]);

type WhoKnowsAnswer = z.infer<typeof answerSchema>;

/** What the chat's code returned, each step's answer. */
const answersIn = async (
  stub: Parameters<typeof codeResults>[0],
  chatId: string
): Promise<WhoKnowsAnswer[]> => {
  const results = await codeResults(stub, chatId);
  return results.map(({ text }) =>
    answerSchema.parse(JSON.parse(text.replace(/^Returned:\n/u, "")))
  );
};

/** The people `answer` names, in its order: it must be one. */
const peopleIn = (answer: WhoKnowsAnswer | undefined) => {
  if (answer === undefined || "failed" in answer) {
    throw new Error(`No answer: ${JSON.stringify(answer)}`);
  }
  return answer.people;
};

/**
 * What `answer` says of each of `people`: the upload it cites for them,
 * or null when it doesn't name them. Read by the people a test made,
 * never as a whole list (recall may find more by meaning).
 */
const of = (
  answer: WhoKnowsAnswer | undefined,
  people: Readonly<Record<string, Person>>
) => {
  const cited = new Map(
    peopleIn(answer).map(({ id, source }) => [id, source.id])
  );
  return Object.fromEntries(
    Object.entries(people).map(([key, { userId }]) => [
      key,
      cited.get(userId) ?? null,
    ])
  );
};

/** A chat of `person`'s own in Grasp, whose agent holds the grant to read the Brain. */
const ownChatOf = async (
  admin: Person,
  person: Person,
  ...replies: ProviderReply[]
) => {
  const chat = await chatOf(person.userId, ...replies);
  await requestGranted(idp, admin, {
    subject: chat.agent,
    object: { type: "platform" },
    actions: ["brain"],
    binding: "BRAIN",
  });
  return chat;
};

/** What `person` asks in their own chat in Grasp: its code's answer. */
const askedInOwnChat = async (
  admin: Person,
  person: Person,
  question: string
): Promise<WhoKnowsAnswer | undefined> => {
  const chat = await ownChatOf(
    admin,
    person,
    askingCode(question),
    says("Asked.")
  );
  await chat.ask(word());
  const [answer] = await answersIn(chat.stub, chat.chat.id);
  return answer;
};

/** What `person` asks in their direct message with a new agent of theirs on Teams. */
const askedInDirectMessage = async (
  admin: Person,
  person: Person,
  question: string
): Promise<WhoKnowsAnswer | undefined> => {
  const agentId = crypto.randomUUID();
  await requestGranted(idp, admin, {
    subject: { type: "agent", agentId },
    object: { type: "platform" },
    actions: ["brain"],
    binding: "BRAIN",
  });
  await fakeProvider(askingCode(question), says("Asked."));
  const stub = workspace(env, personalWorkspaceId(person.userId));
  const { chatId } = await stub.askThrough(
    person.userId,
    agentId,
    "teams",
    word(),
    undefined,
    { kind: "direct" }
  );
  const [answer] = await answersIn(stub, chatId);
  return answer;
};

/** What a turn nobody started asks in `person`'s own chat: its code's answer. */
const askedInWokenTurn = async (
  admin: Person,
  person: Person,
  question: string
): Promise<WhoKnowsAnswer | undefined> => {
  const chat = await ownChatOf(
    admin,
    person,
    askingCode(question),
    says("Asked.")
  );
  await chat.stub.askUnattended(chat.chat.id, { text: word(), model });
  const [answer] = await answersIn(chat.stub, chat.chat.id);
  return answer;
};

/**
 * Whether a chat whose code named `named` for `topic` still sends that to
 * the model in its next turn, once `change` ran: whether it names them
 * again, and whether the result was withheld; and whether the chat still
 * shows its person the code's result naming them (`shown`).
 */
const sentAfter = async (
  admin: Person,
  asker: Person,
  topic: string,
  named: Person,
  change: () => Promise<unknown>
) => {
  const chat = await ownChatOf(
    admin,
    asker,
    askingCode(topic),
    says("Asked."),
    says("And now.")
  );
  await chat.ask(word());
  const [answer] = await answersIn(chat.stub, chat.chat.id);
  const first = peopleIn(answer).some(({ id }) => id === named.userId);
  const before = chat.provider.requests.length;
  await change();
  await chat.ask(word());
  const sent = JSON.stringify(chat.provider.requests[before]?.body);
  const results = await codeResults(chat.stub, chat.chat.id);
  return {
    first,
    named: sent.includes(named.userId),
    withheld: sent.includes(withheldResult),
    shown: results.some(({ text }) => text.includes(named.userId)),
  };
};

describe("a chat's code asking who knows about a topic", setUpTime, () => {
  it("names who uploaded the documents about it that its person may read, one citation each, and nobody on the strength of anything else", async () => {
    const admin = await signedInApi(idp, "admin");
    const [
      asker,
      mate,
      colleague,
      stranger,
      remover,
      owing,
      leaver,
      erased,
      moved,
    ] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const topic = word();
    const ownTeam = await teamOf(asker, mate, moved);
    const otherTeam = await teamOf(stranger);
    const everyone: BrainUploadReaders = { kind: "everyone" };
    const ofTeam = await uploaded(mate, `Pricing ${topic}`, {
      kind: "team",
      teamId: ownTeam,
    });
    const forEveryone = [
      await uploaded(colleague, `Pricing ${topic} for all`, everyone),
      await uploaded(colleague, `More on ${topic}`, everyone),
    ];
    // None of these may name anyone to the asker.
    await uploaded(stranger, `Pricing ${topic}`, {
      kind: "team",
      teamId: otherTeam,
    });
    await uploaded(stranger, `Pricing ${topic}, mine`, { kind: "me" });
    await uploaded(asker, `Pricing ${topic}, my own`, { kind: "me" });
    const removed = await uploaded(remover, `Pricing ${topic} old`, everyone);
    await remover.api.brainSources.deleteUpload(removed);
    // Removed by its uploader, the Brain's removal still owed: in use in
    // the Brain until the clock completes it.
    const owed = await uploaded(owing, `Pricing ${topic} owed`, everyone);
    await drizzle(env.DB)
      .update(brainUploads)
      .set({ removedAt: new Date(), removalOwed: true })
      .where(eq(brainUploads.id, owed));
    await uploaded(leaver, `Pricing ${topic} by a leaver`, everyone);
    await uploaded(erased, `Pricing ${topic} by the erased`, everyone);
    await admin.api.members.remove(leaver.userId);
    await admin.api.members.remove(erased.userId);
    await admin.api.members.erase(erased.userId, String(erased.person.name));
    // Shared with the team by someone who left it since, still a member.
    await uploaded(moved, `Pricing ${topic} by one who moved`, {
      kind: "team",
      teamId: ownTeam,
    });
    await leftTeam(ownTeam, moved);

    const answer = await askedInOwnChat(admin, asker, topic);
    const cited = of(answer, {
      mate,
      colleague,
      stranger,
      asker,
      remover,
      owing,
      leaver,
      erased,
      moved,
    });

    expect({
      ...cited,
      colleague: forEveryone.includes(String(cited.colleague)),
    }).toStrictEqual({
      mate: ofTeam,
      // One of theirs, never the list of all of them.
      colleague: true,
      stranger: null,
      asker: null,
      remover: null,
      owing: null,
      leaver: null,
      erased: null,
      moved: null,
    });
    expect(
      peopleIn(answer).find(({ id }) => id === mate.userId)?.name
    ).toStrictEqual(String(mate.person.name));
  });

  it("lists people in the order of their names, never by how well their documents answer", async () => {
    const admin = await signedInApi(idp, "admin");
    const [asker, first, last] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const topic = word();
    const db = drizzle(env.DB);
    const prefix = word();
    await db
      .update(users)
      .set({ name: `${prefix} Aaron` })
      .where(eq(users.id, first.userId));
    await db
      .update(users)
      .set({ name: `${prefix} Zoe` })
      .where(eq(users.id, last.userId));
    // Zoe's answers best (the topic alone), Aaron's least (once, in a
    // long text): ranked, Zoe would come first.
    await uploaded(last, `${topic} ${topic}`, { kind: "everyone" });
    await uploaded(
      first,
      `A long note on many things, the quarter, the office, the move, the plans for the spring and the summer, and once ${topic}, among the rest of what was said that day.`,
      { kind: "everyone" }
    );

    const people = peopleIn(await askedInOwnChat(admin, asker, topic));
    expect(
      people.flatMap(({ id }) =>
        id === first.userId || id === last.userId ? [id] : []
      )
    ).toStrictEqual([first.userId, last.userId]);
  });

  it("reads at its recall's reach: in a chat app's direct message its person's teams' documents too, in a turn nobody started the company's alone", async () => {
    const admin = await signedInApi(idp, "admin");
    const [asker, mate, colleague] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const topic = word();
    const team = await teamOf(asker, mate);
    const ofTeam = await uploaded(mate, `Roadmap ${topic}`, {
      kind: "team",
      teamId: team,
    });
    const forEveryone = await uploaded(colleague, `Roadmap ${topic}`, {
      kind: "everyone",
    });

    expect({
      direct: of(await askedInDirectMessage(admin, asker, topic), {
        mate,
        colleague,
      }),
      woken: of(await askedInWokenTurn(admin, asker, topic), {
        mate,
        colleague,
      }),
    }).toStrictEqual({
      direct: { mate: ofTeam, colleague: forEveryone },
      woken: { mate: null, colleague: forEveryone },
    });
  });

  it("withholds its answer from a later turn once the document it cites is erased, or the person it names removed or erased, and no longer shows it once erased", async () => {
    const admin = await signedInApi(idp, "admin");
    const [asker, uploader, removed, erased] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const everyone: BrainUploadReaders = { kind: "everyone" };
    const topics = { document: word(), removed: word(), erased: word() };
    const upload = await uploaded(
      uploader,
      `Budget ${topics.document}`,
      everyone
    );
    await uploaded(removed, `Budget ${topics.removed}`, everyone);
    await uploaded(erased, `Budget ${topics.erased}`, everyone);
    // Withheld from the model each time; replaced on screen too once an
    // erasure took it for good (the document, or the person), never when
    // the person was only removed: their asker saw it while they could.
    const withheld = { first: true, named: false, withheld: true };
    const gone = { ...withheld, shown: false };

    expect({
      document: await sentAfter(
        admin,
        asker,
        topics.document,
        uploader,
        async () => {
          // An admin's delete of a shared upload erases it for good.
          await admin.api.brainSources.deleteUpload(upload);
        }
      ),
      removed: await sentAfter(
        admin,
        asker,
        topics.removed,
        removed,
        async () => {
          await admin.api.members.remove(removed.userId);
        }
      ),
      erased: await sentAfter(admin, asker, topics.erased, erased, async () => {
        await admin.api.members.remove(erased.userId);
        await admin.api.members.erase(
          erased.userId,
          String(erased.person.name)
        );
      }),
    }).toStrictEqual({
      document: gone,
      removed: { ...withheld, shown: true },
      erased: gone,
    });
  });

  it("audits each answer by who asked and counts, never by who was named", async () => {
    const admin = await signedInApi(idp, "admin");
    const [asker, colleague] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const topic = word();
    const upload = await uploaded(colleague, `Hiring ${topic}`, {
      kind: "everyone",
    });
    const chat = await ownChatOf(
      admin,
      asker,
      askingCode(topic),
      says("Asked.")
    );
    await chat.ask(word());
    const [answered] = await answersIn(chat.stub, chat.chat.id);
    const logged = await allEvents();
    const events = logged.filter(
      ({ action, target }) =>
        action === "brain.who_knows" && target?.id === chat.chat.id
    );

    expect({
      answered: of(answered, { colleague }),
      events: events.map(({ detail }) => ({
        onBehalfOf: detail?.onBehalfOf,
        keys: Object.keys(detail ?? {}).toSorted(),
      })),
    }).toStrictEqual({
      answered: { colleague: upload },
      events: [
        {
          onBehalfOf: asker.userId,
          keys: ["onBehalfOf", "people", "truncated"],
        },
      ],
    });
    expect(JSON.stringify(events)).not.toContain(colleague.userId);
  });
});

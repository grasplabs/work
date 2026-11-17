import type { BrainUploadReaders } from "@grasp-os/shared/brain-sources";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { withheldResult } from "../src/agent.ts";
import { organizationId } from "../src/auth/auth.ts";
import {
  brainWorkOverview,
  recallPassagesAs,
  workBrain,
} from "../src/brain-next.ts";
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
import { noProducers } from "./no-producers.ts";
import { signedInApi, unique } from "./sign-in.ts";

// Who knows about a topic, for a chat's code (GRA-1744; the design note
// and threat model are on the issue): `env.brain.whoKnows` names the
// people whose uploads a recall for it finds for the chat's person, each
// with the one passage of theirs it found first, exactly as recall hands
// it over, for the chat's model to judge by. How it can fail, and what
// each test holds it to:
// 1. A person is named on the strength of a document the asker may not
//    read: a team's they aren't in, one its uploader alone reads, or one
//    removed (its removal still owed by the Brain, too). None names
//    anyone, and each passage handed over is one of recall's own items
//    for the asker, so a hidden better match changes nothing.
// 2. What only one person may read becomes evidence: the asker's own
//    upload for themselves alone names nobody, them included.
// 3. An erased or removed person is named, or one named for a team's
//    document they may no longer read themselves: never.
// 4. Monitoring: one passage a person, never how much they uploaded,
//    and people in the order of their names, never ranked.
// 4b. A person passes for knowing what their document doesn't say: never
//    without the passage that matched, labelled as recall found it
//    (common words alone included), for the model to judge; and within
//    the budget, as recall packs it.
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

/** The budget the tests' questions ask within, unless one says otherwise. */
const defaultTokens = 4000;

/** Code that returns what `env.brain.whoKnows` answers for `question`, or why it failed. */
const askingCode = (question: string, tokens = defaultTokens) =>
  codeStep(
    `export default async (self, env) => { try { return await env.brain.whoKnows({ question: ${JSON.stringify(question)}, budget: { tokens: ${tokens} } }); } catch (error) { return { failed: error.code ?? error.message }; } };`
  );

const answerSchema = z.union([
  z.strictObject({
    people: z.array(
      z.strictObject({
        id: z.string(),
        name: z.string(),
        passage: z.strictObject({
          source: z.strictObject({
            producer: z.literal("upload"),
            id: z.string(),
          }),
          version: z.number(),
          position: z.number(),
          text: z.string(),
          whole: z.boolean(),
          found: z.enum(["exact", "words", "stop words", "meaning"]),
        }),
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
    peopleIn(answer).map(({ id, passage }) => [id, passage.source.id])
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
  question: string,
  tokens = defaultTokens
): Promise<WhoKnowsAnswer | undefined> => {
  const chat = await ownChatOf(
    admin,
    person,
    askingCode(question, tokens),
    says("Asked.")
  );
  await chat.ask(word());
  const [answer] = await answersIn(chat.stub, chat.chat.id);
  return answer;
};

/**
 * What recall itself packs for `person` for `question`, as their own
 * chat's code reads (their teams and the company, never their own store),
 * and whether each person `answer` names comes with exactly one of its
 * items, and its `truncated`.
 */
const recallsAs = async (
  person: Person,
  question: string,
  answer: WhoKnowsAnswer | undefined,
  tokens = defaultTokens
) => {
  const pack = await recallPassagesAs(env, person.userId, {
    question,
    budget: { tokens },
    personal: false,
  });
  return {
    pack,
    eachRecalls: peopleIn(answer).every(({ passage }) =>
      pack.items.some(
        (item) => JSON.stringify(item) === JSON.stringify(passage)
      )
    ),
    truncated:
      answer !== undefined &&
      "truncated" in answer &&
      answer.truncated === pack.truncated,
  };
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

/**
 * Every passage embedded by the Brain's queue, as core's clock does it,
 * an hour a tick: a bounded wait, failing when it never gets there.
 */
const embedEverything = async (): Promise<void> => {
  let at = Date.now();
  for (let tick = 0; tick < 50; tick += 1) {
    at += 60 * 60 * 1000;
    // oxlint-disable-next-line no-await-in-loop -- one tick at a time, as core's clock
    await workBrain(env, new Date(at), noProducers);
    // oxlint-disable-next-line no-await-in-loop -- read after each tick
    const { embedding } = await brainWorkOverview(env);
    if (
      embedding.rebuilt &&
      embedding.embedded + embedding.unembeddable === embedding.chunks
    ) {
      return;
    }
  }
  throw new Error("Not every passage was embedded");
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

  it("hands each person over with the passage that matched, labelled as recall found it, common words alone included, embedded or not", async () => {
    const admin = await signedInApi(idp, "admin");
    const [asker, expert, bystander] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const topic = word();
    // The expert's upload holds the question's one telling word; the
    // bystander's, on something else, only its commonest words.
    const expertsUpload = await uploaded(
      expert,
      `Pricing for ${topic} in the north`,
      { kind: "everyone" }
    );
    const bystandersUpload = await uploaded(
      bystander,
      "The minutes of the meeting, and the plan for the office",
      { kind: "everyone" }
    );
    const question = `the ${topic} of the north`;
    /** What the answer hands over of each, and whether it is recall's own. */
    const handed = async () => {
      const answer = await askedInOwnChat(admin, asker, question);
      const passageOf = ({ userId }: Person) =>
        peopleIn(answer).find(({ id }) => id === userId)?.passage;
      const ofExpert = passageOf(expert);
      const ofBystander = passageOf(bystander);
      const { eachRecalls } = await recallsAs(asker, question, answer);
      return {
        expert: { source: ofExpert?.source.id, found: ofExpert?.found },
        // Never named without the passage that says why, for the model.
        bystander: {
          source: ofBystander?.source.id,
          text: ofBystander?.text.includes("minutes of the meeting"),
          found: ofBystander?.found,
        },
        eachRecalls,
      };
    };
    const unembedded = await handed();
    await embedEverything();
    await askedInOwnChat(admin, asker, "Warm-up.");
    const embedded = await handed();
    const expected = {
      expert: { source: expertsUpload, found: "words" },
      // Found by its common words first, so labelled so, as recall's
      // contract says of a passage several ways found: once embedded too.
      bystander: { source: bystandersUpload, text: true, found: "stop words" },
      eachRecalls: true,
    };

    expect({ unembedded, embedded }).toStrictEqual({
      unembedded: expected,
      embedded: expected,
    });
  });

  it("hands over only what recall packs within the budget: someone whose passage didn't fit isn't named", async () => {
    const admin = await signedInApi(idp, "admin");
    const [asker, first, second] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const topic = word();
    const long = (title: string) =>
      `${title} on ${topic}: ${Array.from({ length: 60 }, (_, at) => `point ${at} of the plan`).join(", ")}.`;
    const uploads = new Set([
      await uploaded(first, long("Notes"), { kind: "everyone" }),
      await uploaded(second, long("Minutes"), { kind: "everyone" }),
    ]);
    /** Of the two uploads, those recall's own pack holds within `budget`. */
    const packedAt = async (budget: number): Promise<string[]> => {
      const { items } = await recallPassagesAs(env, asker.userId, {
        question: topic,
        budget: { tokens: budget },
        personal: false,
      });
      return [...uploads].filter((id) =>
        items.some(
          ({ source }) => source.producer === "upload" && source.id === id
        )
      );
    };
    // The smallest budget, in steps of five, at which recall packs one of
    // them and not the other: what recall itself fits, never our guess.
    let tokens = 0;
    for (let budget = 5; budget <= defaultTokens; budget += 5) {
      // oxlint-disable-next-line no-await-in-loop -- one budget at a time
      const packed = await packedAt(budget);
      if (packed.length === 1) {
        tokens = budget;
        break;
      }
    }
    const answer = await askedInOwnChat(admin, asker, topic, tokens);
    const { pack, eachRecalls, truncated } = await recallsAs(
      asker,
      topic,
      answer,
      tokens
    );
    const named = peopleIn(answer).filter(
      ({ id }) => id === first.userId || id === second.userId
    );
    /** The uploads recall's pack holds a passage of. */
    const recalled = new Set(
      pack.items.flatMap(({ source }) =>
        source.producer === "upload" ? [source.id] : []
      )
    );

    expect({
      eachRecalls,
      truncated,
      cut: pack.truncated,
      // A budget holding one of them: that one named, never both.
      fits: tokens > 0,
      named: named.length,
      fromPack: named.every(({ passage }) => recalled.has(passage.source.id)),
    }).toStrictEqual({
      eachRecalls: true,
      truncated: true,
      cut: true,
      fits: true,
      named: 1,
      fromPack: true,
    });
  });

  it("names who uploaded a document found by its meaning alone, in another language, with its passage, and nothing hidden changes the answer", async () => {
    const admin = await signedInApi(idp, "admin");
    const [asker, colleague, stranger] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const otherTeam = await teamOf(stranger);
    // In English; the question is in Dutch and shares no word with it.
    const upload = await uploaded(
      colleague,
      "The supplier sends the invoice on the first day of every month. Payment is due thirty days later.",
      { kind: "everyone" }
    );
    const question = "Wanneer moeten wij de leverancier betalen?";
    await embedEverything();
    // The question's embedder loaded once, so no answer waits for it.
    await askedInOwnChat(admin, asker, "Warm-up.");
    const before = await askedInOwnChat(admin, asker, question);
    // A better match for a team the asker isn't in.
    await uploaded(
      stranger,
      "We pay the supplier thirty days after the invoice arrives each month.",
      { kind: "team", teamId: otherTeam }
    );
    await embedEverything();
    const after = await askedInOwnChat(admin, asker, question);
    // The same question sharing one common word with it ("is"): found by
    // that word and by its meaning, handed over all the same.
    const sharing = await askedInOwnChat(
      admin,
      asker,
      "Wanneer is de leverancier te betalen?"
    );
    /** How `answer` cites the colleague, if it names them. */
    const citedIn = (answer: WhoKnowsAnswer | undefined) => {
      const cited = peopleIn(answer).find(
        ({ id }) => id === colleague.userId
      )?.passage;
      return {
        source: cited?.source.id,
        text: cited?.text.includes("The supplier sends the invoice"),
        found: cited?.found,
      };
    };
    const recalled = await recallsAs(asker, question, before);

    expect({
      cited: citedIn(before),
      sharing: citedIn(sharing),
      after,
      recalled: recalled.eachRecalls,
    }).toStrictEqual({
      cited: { source: upload, text: true, found: "meaning" },
      // Its common word found it first: labelled so, as recall's pack says.
      sharing: { source: upload, text: true, found: "stop words" },
      after: before,
      recalled: true,
    });
  });

  it("answers alike whatever the asker may not read matches better, by words, common words or meaning", async () => {
    const admin = await signedInApi(idp, "admin");
    const [asker, colleague, other, stranger] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const otherTeam = await teamOf(stranger);
    const topic = word();
    await uploaded(
      colleague,
      `The supplier ${topic} is paid thirty days after the invoice.`,
      { kind: "everyone" }
    );
    await uploaded(
      other,
      "The minutes of the meeting, and the plan for the office",
      { kind: "everyone" }
    );
    const question = `When is the supplier ${topic} paid?`;
    await embedEverything();
    await askedInOwnChat(admin, asker, "Warm-up.");
    const before = await askedInOwnChat(admin, asker, question);
    const hidden: BrainUploadReaders = { kind: "team", teamId: otherTeam };
    // By its words, by its common words alone, and by its meaning.
    await uploaded(
      stranger,
      `When is the supplier ${topic} paid? The supplier ${topic} is paid when the supplier ${topic} invoice is paid.`,
      hidden
    );
    await uploaded(
      stranger,
      "When is it the time of the year when the is of the was",
      hidden
    );
    await uploaded(
      stranger,
      "Vendors receive payment one month after billing.",
      hidden
    );
    await embedEverything();
    const after = await askedInOwnChat(admin, asker, question);

    expect(after).toStrictEqual(before);
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

  it("no longer shows an answer naming someone erased, beside a document of another's that is only out of use", async () => {
    const admin = await signedInApi(idp, "admin");
    const [asker, erased, remover] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const topic = word();
    await uploaded(erased, `Budget ${topic}`, { kind: "everyone" });
    const removed = await uploaded(remover, `Budget ${topic} too`, {
      kind: "everyone",
    });

    const outcome = await sentAfter(admin, asker, topic, erased, async () => {
      // Out of use, its history kept: no longer readable, never erased.
      await remover.api.brainSources.deleteUpload(removed);
      await admin.api.members.remove(erased.userId);
      await admin.api.members.erase(erased.userId, String(erased.person.name));
    });
    expect(outcome).toStrictEqual({
      first: true,
      named: false,
      withheld: true,
      shown: false,
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
